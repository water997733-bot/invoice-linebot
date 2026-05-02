/**
 * carrierFlow.js
 * Line Bot 中的載具綁定對話流程
 * 
 * 流程：
 *   1. 用戶輸入「綁定載具」
 *   2. Bot 說明並請用戶輸入手機條碼
 *   3. 用戶輸入 /XXXXXXX
 *   4. Bot 驗證格式 → 請用戶輸入驗證碼
 *   5. 用戶輸入驗證碼
 *   6. Bot 呼叫財政部 API 驗證 → 成功儲存、失敗重試
 */

const { validateCardBarcode, getCarrierInvoices, EInvoiceError } = require('./einvoice');
const db = require('./database');
const crypto = require('crypto');

// 暫存綁定進度（用 Map 取代 Redis，簡單版；正式版可換 Redis）
// key: lineUserId, value: { step, cardNo, expireAt }
const pendingBindings = new Map();

const STEP = {
  WAIT_BARCODE: 'WAIT_BARCODE',
  WAIT_ENCRYPT: 'WAIT_ENCRYPT',
};

/**
 * 處理「綁定載具」指令
 */
async function handleBindStart(lineUserId) {
  // 設定進度
  pendingBindings.set(lineUserId, {
    step: STEP.WAIT_BARCODE,
    expireAt: Date.now() + 5 * 60 * 1000, // 5 分鐘逾時
  });

  return [
    {
      type: 'text',
      text: [
        '📱 開始綁定手機條碼載具',
        '',
        '請輸入您的手機條碼（格式：/ 開頭 + 7位英數字）',
        '例如：/ABC1234',
        '',
        '在哪裡找到手機條碼？',
        '打開「電子發票」App → 條碼載具 → 複製條碼',
      ].join('\n'),
    },
    {
      type: 'text',
      text: '⏱ 請在 5 分鐘內輸入，逾時需重新開始綁定流程。',
    },
  ];
}

/**
 * 處理用戶輸入（判斷是否在綁定流程中）
 * 回傳 null 代表不是綁定流程中的輸入
 */
async function handleBindingInput(lineUserId, text) {
  const state = pendingBindings.get(lineUserId);
  if (!state) return null;

  // 逾時判斷
  if (Date.now() > state.expireAt) {
    pendingBindings.delete(lineUserId);
    return [{ type: 'text', text: '⏱ 綁定逾時，請重新輸入「綁定載具」開始。' }];
  }

  if (state.step === STEP.WAIT_BARCODE) {
    return await handleBarcodeInput(lineUserId, text.trim(), state);
  }

  if (state.step === STEP.WAIT_ENCRYPT) {
    return await handleEncryptInput(lineUserId, text.trim(), state);
  }

  return null;
}

async function handleBarcodeInput(lineUserId, barcode, state) {
  if (!validateCardBarcode(barcode)) {
    return [{
      type: 'text',
      text: [
        '❌ 格式不正確！',
        '手機條碼必須是 / 開頭接 7 位大寫英數字',
        '例如：/ABC1234',
        '',
        '請重新輸入：',
      ].join('\n'),
    }];
  }

  // 更新進度到下一步
  state.step = STEP.WAIT_ENCRYPT;
  state.cardNo = barcode;
  pendingBindings.set(lineUserId, state);

  return [{
    type: 'text',
    text: [
      `✅ 條碼確認：${barcode}`,
      '',
      '請輸入您的手機條碼**驗證碼**',
      '（這是您在電子發票 App 設定的 4 位數密碼，',
      '用於查詢發票明細，不是 Line 密碼）',
      '',
      '⚠️ 驗證碼不會明文儲存，我們只保存加密版本。',
    ].join('\n'),
  }];
}

async function handleEncryptInput(lineUserId, encryptInput, state) {
  // 將驗證碼做 SHA256 後儲存（不儲存明文）
  const cardEncrypt = crypto
    .createHash('sha256')
    .update(encryptInput)
    .digest('hex');

  try {
    // 用財政部 API 實際驗證是否能查詢
    const testResult = await getCarrierInvoices(
      state.cardNo,
      cardEncrypt,
      subtractDays(new Date(), 7), // 只測查 7 天
      new Date()
    );

    // 驗證成功 → 儲存
    await db.saveCarrierBinding(lineUserId, state.cardNo, cardEncrypt);
    pendingBindings.delete(lineUserId);

    const invCount = testResult.length;
    return [{
      type: 'text',
      text: [
        '🎉 載具綁定成功！',
        `條碼：${state.cardNo}`,
        '',
        `近 7 天找到 ${invCount} 張發票，開始為您同步...`,
        '同步完成後會通知您！',
        '',
        '之後可用的指令：',
        '・「同步發票」— 手動更新',
        '・「本月報表」— 查看消費分析',
        '・「解除綁定」— 移除載具',
      ].join('\n'),
    }];

  } catch (err) {
    if (err instanceof EInvoiceError) {
      // 驗證碼錯誤
      return [{
        type: 'text',
        text: [
          '❌ 驗證失敗！',
          '可能原因：',
          '1. 驗證碼輸入錯誤',
          '2. 手機條碼未在財政部完成驗證',
          '',
          '請重新輸入驗證碼，或輸入「取消」結束綁定：',
        ].join('\n'),
      }];
    }
    throw err;
  }
}

/**
 * 取消綁定流程
 */
function handleBindCancel(lineUserId) {
  pendingBindings.delete(lineUserId);
  return [{ type: 'text', text: '已取消載具綁定。如需重新設定，輸入「綁定載具」開始。' }];
}

/**
 * 解除已綁定的載具
 */
async function handleUnbind(lineUserId) {
  const user = await db.getUser(lineUserId);
  if (!user || !user.card_no) {
    return [{ type: 'text', text: '您目前沒有綁定任何載具。' }];
  }

  await db.removeCarrierBinding(lineUserId);
  return [{
    type: 'text',
    text: [
      '✅ 已解除載具綁定',
      `條碼：${user.card_no}`,
      '',
      '已儲存的發票記錄不受影響。',
      '如需重新綁定，輸入「綁定載具」。',
    ].join('\n'),
  }];
}

// ── 工具 ──────────────────────────────────────────────────────
function subtractDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d;
}

module.exports = {
  handleBindStart,
  handleBindingInput,
  handleBindCancel,
  handleUnbind,
};
