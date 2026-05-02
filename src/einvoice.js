/**
 * 財政部電子發票整合服務平台 API 模組
 * 
 * 官方文件：https://www.einvoice.nat.gov.tw/
 * API 版本：v0.6
 * 
 * 功能：
 *  - 查詢手機條碼載具發票清單
 *  - 查詢單張發票明細（品項、金額）
 *  - 對獎查詢
 *  - 載具歸戶查詢
 *  - 自動分頁（一次拉取所有發票）
 */

const axios = require('axios');
const crypto = require('crypto');

// ── 常數設定 ────────────────────────────────────────────────
const EINVOICE_BASE_URL = 'https://api.einvoice.nat.gov.tw';
const APP_ID   = process.env.EINVOICE_APP_ID;
const API_KEY  = process.env.EINVOICE_API_KEY;

// 消費分類關鍵字對應表
const CATEGORY_RULES = [
  { category: '餐飲', keywords: ['餐', '食', '飯', '麵', '咖啡', '飲', '茶', '便當', '小吃', '早餐', '午餐', '晚餐', '麥當勞', '肯德基', '摩斯', '星巴克', '路易莎', '全聯熟食'] },
  { category: '超市購物', keywords: ['全聯', '家樂福', '大潤發', '好市多', 'COSTCO', '愛買', '頂好', '全家', '7-ELEVEN', '萊爾富', 'OK', '統一超'] },
  { category: '交通', keywords: ['加油', '停車', '高鐵', '台鐵', '捷運', 'Uber', '計程車', '悠遊', '油資', '過路費', 'ETC'] },
  { category: '醫療', keywords: ['藥局', '診所', '醫院', '藥妝', '康是美', '屈臣氏', '大樹', '藥品', '健保'] },
  { category: '娛樂', keywords: ['電影', 'KTV', '遊樂', '健身', '電玩', '漫畫', '書局', 'Netflix', 'Spotify'] },
  { category: '服飾', keywords: ['服飾', '衣', '褲', '鞋', 'ZARA', 'H&M', 'UNIQLO', '優衣庫', '成衣'] },
  { category: '3C電子', keywords: ['電器', '手機', '電腦', '3C', '燦坤', '全國電子', 'Apple', '配件'] },
  { category: '教育', keywords: ['書店', '文具', '誠品', '補習', '課程', '教材', '博客來'] },
  { category: '美容', keywords: ['美容', '美甲', '美髮', '理髮', '保養', '化妝', '沙龍'] },
  { category: '居家', keywords: ['IKEA', '特力屋', '修繕', '家具', '水電', '清潔', '五金'] },
];

// ── 工具函式 ─────────────────────────────────────────────────

/**
 * 產生財政部 API 簽章
 * 簽章規則：HMAC-SHA1(appID=xxx&UUID=xxx&Timestamp=xxx&CardType=xxx&CardNo=xxx, apiKey)
 */
function generateSignature(params) {
  const sortedStr = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');

  return crypto
    .createHmac('sha1', API_KEY)
    .update(sortedStr)
    .digest('base64');
}

/**
 * 取得目前 Unix Timestamp（秒）
 */
function getTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * 產生 UUID
 */
function generateUUID() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 20).toUpperCase();
}

/**
 * 日期格式化（財政部格式）：YYYY/MM/DD
 */
function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

/**
 * 取得民國年格式：YYYMMDD（財政部部分 API 用）
 */
function toROCDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const rocYear = d.getFullYear() - 1911;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${rocYear}${m}${day}`;
}

/**
 * 根據商店名稱＋品項名稱判斷消費分類
 */
function categorize(sellerName = '', itemName = '') {
  const text = `${sellerName}${itemName}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some(kw => text.includes(kw))) {
      return rule.category;
    }
  }
  return '其他';
}

/**
 * 統一的 API 請求包裝
 */
async function apiRequest(endpoint, params, method = 'GET') {
  const url = `${EINVOICE_BASE_URL}${endpoint}`;
  try {
    const config = {
      method,
      url,
      timeout: 10000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    };

    if (method === 'GET') {
      config.params = params;
    } else {
      config.data = new URLSearchParams(params).toString();
    }

    const res = await axios(config);

    if (res.data.code !== '200') {
      throw new EInvoiceError(res.data.msg || '財政部 API 回傳錯誤', res.data.code);
    }

    return res.data;
  } catch (err) {
    if (err instanceof EInvoiceError) throw err;
    throw new EInvoiceError(`API 請求失敗：${err.message}`, 'NETWORK_ERROR');
  }
}

class EInvoiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EInvoiceError';
    this.code = code;
  }
}

// ── 核心功能 ─────────────────────────────────────────────────

/**
 * 驗證手機條碼格式是否正確
 * 格式：/ 開頭，後接 7 位英數字（大寫）
 */
function validateCardBarcode(barcode) {
  return /^\/[A-Z0-9+.]{7}$/.test(barcode);
}

/**
 * 查詢手機條碼載具的發票清單（自動分頁，一次拉全部）
 *
 * @param {string} cardNo     - 手機條碼，例如 /ABC1234
 * @param {string} cardEncrypt - 手機條碼驗證碼（使用者設定的密碼 HASH）
 * @param {Date}   startDate  - 查詢起始日期（預設三個月前）
 * @param {Date}   endDate    - 查詢結束日期（預設今天）
 * @returns {Array} 發票清單
 */
async function getCarrierInvoices(cardNo, cardEncrypt, startDate, endDate) {
  if (!validateCardBarcode(cardNo)) {
    throw new EInvoiceError('手機條碼格式錯誤，應為 / 開頭後接 7 位英數字', 'INVALID_BARCODE');
  }

  const now = new Date();
  const start = startDate || new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const end   = endDate   || now;

  let allInvoices = [];
  let onlyWinningInv = 'N'; // 只查中獎發票？N = 全部
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const timestamp = getTimestamp();
    const uuid = generateUUID();

    const params = {
      version: '0.5',
      cardType: '3J0002',   // 手機條碼
      cardNo,
      expTimeStamp: 'MC30',
      action: 'qryCarrierInv',
      timeStamp: timestamp,
      startDate: formatDate(start),
      endDate: formatDate(end),
      onlyWinningInv,
      appID: APP_ID,
      uuid,
    };

    // 加入驗證碼（使用者的手機條碼驗證碼）
    if (cardEncrypt) {
      params.cardEncrypt = cardEncrypt;
    }

    params.signature = generateSignature(params);

    const data = await apiRequest('/PB2CAPIVAN/invapp/InvApp', params);

    const invoices = data.details || [];
    allInvoices = allInvoices.concat(invoices);

    // 判斷是否還有更多頁（財政部 API 每頁最多 100 筆）
    hasMore = invoices.length === 100;
    page++;

    if (hasMore) {
      // 防止過快請求
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return allInvoices;
}

/**
 * 查詢單張發票明細（品項、金額）
 *
 * @param {string} invNum   - 發票號碼，例如 AB12345678
 * @param {string} invDate  - 發票日期，YYYY/MM/DD 格式
 * @param {string} invTerm  - 發票期別，例如 11401（114年01-02月）
 * @param {string} cardNo   - 手機條碼
 * @param {string} cardEncrypt - 驗證碼
 * @returns {Object} 發票明細，包含品項陣列
 */
async function getInvoiceDetail(invNum, invDate, invTerm, cardNo, cardEncrypt) {
  const timestamp = getTimestamp();
  const uuid = generateUUID();

  const params = {
    version: '0.5',
    type: 'Barcode',
    invNum,
    action: 'qryInvDetail',
    generation: 'V2',
    invTerm,
    invDate,
    encrypt: cardEncrypt || '',
    cardNo,
    cardType: '3J0002',
    timeStamp: timestamp,
    appID: APP_ID,
    uuid,
  };

  params.signature = generateSignature(params);

  const data = await apiRequest('/PB2CAPIVAN/invapp/InvApp', params);

  // 整理品項資料
  const items = (data.details || []).map(item => ({
    name: item.description,
    quantity: parseFloat(item.quantity) || 1,
    unitPrice: parseFloat(item.unitPrice) || 0,
    amount: parseFloat(item.amount) || 0,
    category: categorize('', item.description),
  }));

  return {
    invNum,
    invDate,
    sellerName: data.sellerName || '',
    sellerBan: data.sellerBan || '',
    currency: data.currency || 'TWD',
    totalAmount: parseFloat(data.amount) || 0,
    items,
  };
}

/**
 * 批次查詢多張發票明細（帶速率限制）
 *
 * @param {Array}  invoiceList - getCarrierInvoices 回傳的清單
 * @param {string} cardNo
 * @param {string} cardEncrypt
 * @param {Function} onProgress - 進度回呼 (current, total)
 * @returns {Array} 有完整品項的發票陣列
 */
async function batchGetInvoiceDetails(invoiceList, cardNo, cardEncrypt, onProgress) {
  const results = [];
  const total = invoiceList.length;

  for (let i = 0; i < total; i++) {
    const inv = invoiceList[i];
    try {
      const detail = await getInvoiceDetail(
        inv.invNum,
        inv.invDate,
        inv.invPeriod,
        cardNo,
        cardEncrypt
      );

      // 若明細沒有品項（某些商家不提供），用發票層級的資料補充
      if (detail.items.length === 0) {
        detail.items = [{
          name: detail.sellerName || '消費明細',
          quantity: 1,
          unitPrice: detail.totalAmount,
          amount: detail.totalAmount,
          category: categorize(detail.sellerName, ''),
        }];
      }

      results.push(detail);
    } catch (err) {
      // 單筆失敗不中斷整體流程，記錄錯誤後繼續
      console.warn(`[einvoice] 發票 ${inv.invNum} 明細查詢失敗：${err.message}`);
      results.push({
        invNum: inv.invNum,
        invDate: inv.invDate,
        sellerName: inv.sellerName || '',
        totalAmount: parseFloat(inv.amount) || 0,
        items: [{
          name: inv.sellerName || '消費',
          quantity: 1,
          unitPrice: parseFloat(inv.amount) || 0,
          amount: parseFloat(inv.amount) || 0,
          category: categorize(inv.sellerName || '', ''),
        }],
        error: err.message,
      });
    }

    if (onProgress) onProgress(i + 1, total);

    // 每筆之間等 300ms，避免觸發財政部頻率限制
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

/**
 * 查詢發票對獎結果
 * 
 * @param {string} invNum  - 發票號碼
 * @param {string} invTerm - 發票期別（如 11401）
 * @returns {Object} 對獎結果
 */
async function checkWinning(invNum, invTerm) {
  const timestamp = getTimestamp();
  const uuid = generateUUID();

  const params = {
    version: '0.2',
    action: 'qryInvWinning',
    invTerm,
    invNum,
    timeStamp: timestamp,
    appID: APP_ID,
    uuid,
  };

  params.signature = generateSignature(params);

  const data = await apiRequest('/PB2CAPIVAN/invapp/InvApp', params);

  return {
    invNum,
    invTerm,
    prize: data.prize || '未中獎',
    amount: parseInt(data.prizeAmount || 0, 10),
    won: (data.prize || '') !== '' && (data.prize || '') !== '未中獎',
  };
}

/**
 * 取得目前最新的中獎號碼（用於對獎通知）
 *
 * @returns {Object} 中獎號碼清單
 */
async function getWinningNumbers() {
  const timestamp = getTimestamp();
  const uuid = generateUUID();

  const params = {
    version: '0.2',
    action: 'qryWinningList',
    invTerm: getCurrentInvTerm(),
    timeStamp: timestamp,
    appID: APP_ID,
    uuid,
  };

  params.signature = generateSignature(params);

  const data = await apiRequest('/PB2CAPIVAN/invapp/InvApp', params);

  return {
    invTerm: data.invTerm,
    superPrize: data.superPrize,        // 特別獎 1000萬
    grandPrize: data.grandPrize,        // 特獎 200萬
    firstPrize: data.firstPrizeList,    // 頭獎 20萬（多組）
    additionalSixth: data.additionalSixth, // 增開六獎 200元
  };
}

/**
 * 取得目前發票期別（例如目前是 2025年3月 → 11501 代表114年01-02月）
 * 財政部發票每雙月為一期
 */
function getCurrentInvTerm() {
  const now = new Date();
  const year = now.getFullYear() - 1911; // 民國年
  // 01-02月 → 01, 03-04月 → 02, 以此類推
  const term = Math.ceil((now.getMonth() + 1) / 2);
  // 取上一期（本期尚未開獎）
  let termStr, rocYear;
  if (term === 1) {
    rocYear = year - 1;
    termStr = '06';
  } else {
    rocYear = year;
    termStr = String(term - 1).padStart(2, '0');
  }
  return `${rocYear}${termStr}`;
}

// ── 高階整合函式 ──────────────────────────────────────────────

/**
 * 完整的使用者載具同步流程
 * 拉取發票清單 → 查詢明細 → 整理成統一格式
 *
 * @param {Object} user - { cardNo, cardEncrypt }
 * @param {Date}   since - 只抓此日期之後的發票
 * @param {Function} onProgress
 * @returns {Array} 整理好的帳目陣列
 */
async function syncUserCarrier(user, since, onProgress) {
  const { cardNo, cardEncrypt } = user;

  // Step 1: 取得發票清單
  const invoiceList = await getCarrierInvoices(cardNo, cardEncrypt, since);

  if (invoiceList.length === 0) {
    return [];
  }

  // Step 2: 批次取得明細
  const details = await batchGetInvoiceDetails(invoiceList, cardNo, cardEncrypt, onProgress);

  // Step 3: 整理成帳目格式（每個品項一筆）
  const records = [];
  for (const inv of details) {
    for (const item of inv.items) {
      records.push({
        source: 'carrier',           // 來源：載具自動同步
        invNum: inv.invNum,
        invDate: inv.invDate,
        sellerName: inv.sellerName,
        itemName: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        category: item.category,
        totalInvAmount: inv.totalAmount,
      });
    }
  }

  return records;
}

/**
 * 統計發票清單的消費分類總計
 *
 * @param {Array} records - syncUserCarrier 回傳的帳目陣列
 * @returns {Object} { 餐飲: 1500, 超市購物: 800, ... }
 */
function summarizeByCategory(records) {
  const summary = {};
  let total = 0;

  for (const r of records) {
    const cat = r.category || '其他';
    summary[cat] = (summary[cat] || 0) + r.amount;
    total += r.amount;
  }

  // 加上百分比
  const result = {};
  for (const [cat, amount] of Object.entries(summary)) {
    result[cat] = {
      amount,
      percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
    };
  }

  return { categories: result, total };
}

// ── 匯出 ──────────────────────────────────────────────────────
module.exports = {
  // 核心 API
  getCarrierInvoices,
  getInvoiceDetail,
  batchGetInvoiceDetails,
  checkWinning,
  getWinningNumbers,

  // 整合流程
  syncUserCarrier,
  summarizeByCategory,

  // 工具
  validateCardBarcode,
  categorize,
  getCurrentInvTerm,
  formatDate,

  // 錯誤類別
  EInvoiceError,
};
