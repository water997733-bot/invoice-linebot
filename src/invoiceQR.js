/**
 * invoiceQR.js
 * 台灣電子發票 QR Code 解析模組
 *
 * 台灣電子發票左側 QR Code 格式（財政部標準）：
 * 欄位以 : 分隔，共 19 個欄位：
 *   [0]  發票號碼     AB12345678
 *   [1]  發票日期     1130115 (民國年月日)
 *   [2]  隨機碼       4碼
 *   [3]  銷售額(未稅) 16進位
 *   [4]  總計(含稅)   16進位
 *   [5]  買方統編     00000000 (個人為 0)
 *   [6]  賣方統編     8碼
 *   [7]  加密驗證碼
 *   [8]  保留欄位
 *   [9]  保留欄位
 *   [10] 保留欄位
 *   [11] 商品數量     數字
 *   [12] 編碼方式     1=Big5, 2=UTF8
 *   [13...] 品項 (格式: 品名:數量:單價)
 *
 * 右側 QR Code 只有加密的明細，需搭配左側解密，一般只解析左側即可取得主要資訊。
 */

const Jimp = require('jimp');
const jsQR = require('jsqr');

// ── QR Code 掃描 ──────────────────────────────────────────────

/**
 * 從圖片 Buffer 解析所有 QR Code（支援左右兩個）
 * @param {Buffer} imageBuffer
 * @returns {string[]} QR Code 文字陣列
 */
async function scanQRCodes(imageBuffer) {
  const image = await Jimp.read(imageBuffer);
  const { width, height } = image.bitmap;
  const results = [];

  // 掃描整張圖
  const codes = scanImage(image);
  results.push(...codes);

  // 若整張只掃到一個，嘗試裁切左半部再掃（抓左側發票 QR Code）
  if (results.length <= 1) {
    const left = image.clone().crop(0, 0, Math.floor(width / 2), height);
    const leftCodes = scanImage(left);
    for (const c of leftCodes) {
      if (!results.includes(c)) results.push(c);
    }
  }

  // 也掃右半部（取得商品明細備用）
  if (results.length <= 1) {
    const right = image.clone().crop(Math.floor(width / 2), 0, Math.ceil(width / 2), height);
    const rightCodes = scanImage(right);
    for (const c of rightCodes) {
      if (!results.includes(c)) results.push(c);
    }
  }

  return results;
}

function scanImage(image) {
  const { data, width, height } = image.bitmap;
  const uint8 = new Uint8ClampedArray(data);
  const results = [];
  const code = jsQR(uint8, width, height, { inversionAttempts: 'dontInvert' });
  if (code) results.push(code.data);
  else {
    const inv = jsQR(uint8, width, height, { inversionAttempts: 'onlyInvert' });
    if (inv) results.push(inv.data);
  }
  return results;
}

// ── 台灣電子發票格式解析 ──────────────────────────────────────

/**
 * 判斷是否為台灣電子發票 QR Code
 */
function isTaiwanInvoiceQR(text) {
  // 左側 QR Code: 開頭為發票號碼 (2英文+8數字)，後面接 : 分隔欄位
  // 支援 ZJ52426050: 或 ZJ-52426050: 兩種格式
  return /^[A-Z]{2}-?\d{8}:/.test(text);
}

/**
 * 解析台灣電子發票左側 QR Code
 * @param {string} qrText
 * @returns {object|null} 解析結果
 */
function parseInvoiceQR(qrText) {
  if (!isTaiwanInvoiceQR(qrText)) return null;

  const parts = qrText.split(':');
  if (parts.length < 12) return null;

  try {
    // 基本資訊
    const invNum   = parts[0].replace('-', '');       // 發票號碼（去除連字號）
    const dateRaw  = parts[1];                        // 民國日期 YYYMMDD
    const totalHex = parts[4];                        // 總計(含稅) 16進位

    // 民國年轉西元
    const rocYear  = parseInt(dateRaw.substring(0, 3));
    const month    = dateRaw.substring(3, 5);
    const day      = dateRaw.substring(5, 7);
    const invDate  = `${rocYear + 1911}-${month}-${day}`;

    // 總計金額（16進位轉10進位）
    const totalAmount = parseInt(totalHex, 16);

    // 賣方統編
    const sellerBAN = parts[6];

    // 品項數量
    const itemCount = parseInt(parts[11]) || 0;

    // 編碼方式
    const encoding = parts[12] === '2' ? 'utf8' : 'big5';

    // 解析品項（從第 13 個欄位開始，每 3 個一組：品名:數量:單價）
    const items = [];
    for (let i = 13; i + 2 < parts.length && items.length < itemCount; i += 3) {
      const name     = decodeItemName(parts[i], encoding);
      const quantity = parseFloat(parts[i + 1]) || 1;
      const price    = parseFloat(parts[i + 2]) || 0;
      if (name) {
        items.push({
          name,
          quantity,
          unitPrice: price,
          amount: Math.round(quantity * price),
        });
      }
    }

    return {
      invNum,
      invDate,
      totalAmount: isNaN(totalAmount) ? null : totalAmount,
      sellerBAN,
      items,
      itemCount,
      raw: qrText,
    };

  } catch (err) {
    console.error('[invoiceQR] 解析失敗：', err.message);
    return null;
  }
}

/**
 * 品項名稱解碼（處理特殊字元）
 */
function decodeItemName(raw, encoding) {
  if (!raw) return '';
  // QR Code 裡中文通常已是 UTF-8 字串，直接回傳
  // 若有 %XX 編碼則解碼
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

// ── 主要入口 ─────────────────────────────────────────────────

/**
 * 從圖片 Buffer 嘗試解析台灣電子發票
 * @param {Buffer} imageBuffer
 * @returns {{ success: boolean, invoice?: object, error?: string }}
 */
async function parseInvoiceFromImage(imageBuffer) {
  try {
    const codes = await scanQRCodes(imageBuffer);

    if (codes.length === 0) {
      return { success: false, error: 'no_qr' };
    }

    for (const code of codes) {
      console.log('[invoiceQR] 掃到 QR Code 內容（前80字）:', code.substring(0, 80));
      console.log('[invoiceQR] isTaiwanInvoice:', isTaiwanInvoiceQR(code));
      const invoice = parseInvoiceQR(code);
      if (invoice) {
        return { success: true, invoice };
      }
    }

    return { success: false, error: 'not_invoice_qr', rawCodes: codes };

  } catch (err) {
    console.error('[invoiceQR] 圖片處理失敗：', err.message);
    return { success: false, error: 'image_error', message: err.message };
  }
}

/**
 * 格式化發票資訊為顯示文字
 */
function formatInvoiceResult(invoice, category) {
  const lines = [
    `✅ 發票辨識成功！`,
    `📋 發票號碼：${invoice.invNum}`,
    `📅 日期：${invoice.invDate}`,
    `💰 總計：NT$ ${invoice.totalAmount?.toLocaleString() ?? '未知'}`,
  ];

  if (invoice.items.length > 0) {
    lines.push('', '📦 品項明細：');
    invoice.items.slice(0, 5).forEach(item => {
      const amt = item.amount ? `NT$ ${item.amount.toLocaleString()}` : '';
      lines.push(`  • ${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ''} ${amt}`);
    });
    if (invoice.itemCount > 5) {
      lines.push(`  ...等共 ${invoice.itemCount} 項`);
    }
  }

  if (category) {
    lines.push('', `🏷️ 分類：${category}`);
  }

  return lines.join('\n');
}

module.exports = {
  parseInvoiceFromImage,
  parseInvoiceQR,
  isTaiwanInvoiceQR,
  formatInvoiceResult,
};
