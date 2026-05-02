/**
 * manualEntryFlow.js
 * 手動快速記帳 + 分類修正對話流程
 *
 * ── 手動記帳支援的輸入格式 ──────────────────────────────────
 *   「午餐 150」         → 品項：午餐，金額：150，分類：自動判斷
 *   「計程車 320 交通」  → 品項：計程車，金額：320，分類：交通（手動指定）
 *   「咖啡 85 星巴克」   → 品項：咖啡，金額：85，商店：星巴克
 *   「停車費120」        → 有無空格都能解析
 *
 * ── 分類修正流程 ────────────────────────────────────────────
 *   用戶輸入「修改分類」→ Bot 列出最近 10 筆 → 用戶選號碼
 *   → Bot 列出分類選項 → 用戶選新分類 → 完成
 */

const db = require('./database');
const { categorize } = require('./einvoice');
const { parseCurrency, convertToTWD, formatAmount, getCurrencyName, getSupportedCurrencyList } = require('./currencyService');

// 所有可選分類（統一在這裡定義，einvoice.js 也會 export 同一份）
const CATEGORIES = [
  '餐飲', '超市購物', '交通', '醫療',
  '娛樂', '服飾', '3C電子', '教育',
  '美容', '居家', '其他',
];

// 暫存進行中的流程
// key: lineUserId, value: { type: 'edit_category' | 'confirm_entry', step, data, expireAt }
const pendingFlows = new Map();

const EXPIRE_MS = 5 * 60 * 1000; // 5 分鐘逾時

// ── 工具 ──────────────────────────────────────────────────────

function setFlow(lineUserId, type, data = {}) {
  pendingFlows.set(lineUserId, {
    type,
    data,
    expireAt: Date.now() + EXPIRE_MS,
  });
}

function getFlow(lineUserId) {
  const flow = pendingFlows.get(lineUserId);
  if (!flow) return null;
  if (Date.now() > flow.expireAt) {
    pendingFlows.delete(lineUserId);
    return null;
  }
  return flow;
}

function clearFlow(lineUserId) {
  pendingFlows.delete(lineUserId);
}

// ── 手動記帳解析 ──────────────────────────────────────────────

/**
 * 嘗試將用戶輸入解析成一筆帳目
 * 回傳 null 代表無法解析（不是記帳格式）
 *
 * 支援格式：
 *  「品項 金額」
 *  「品項 金額 分類」
 *  「品項 金額 商店名稱」
 */
function parseManualEntry(text) {
  // 前置清理：去掉錢號、逗號、全形空格
  const cleaned = text
    .replace(/[$＄,，]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 嘗試匹配：「任意文字 數字 (可選文字)」
  // 數字可以是整數或小數，允許在品項和數字之間無空格
  const match = cleaned.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*(.*)$/);
  if (!match) return null;

  const itemName = match[1].trim();
  const amount   = parseFloat(match[2]);
  const extra    = match[3].trim(); // 可能是分類或商店名

  // 金額合理性：1 ~ 999999
  if (amount < 1 || amount > 999999) return null;
  // 品項不能太短（避免把「1 50」這種誤判為「品項1，金額50」）
  if (itemName.length < 1) return null;
  // 純數字品項不接受（避免「100 50」這種輸入）
  if (/^\d+$/.test(itemName)) return null;

  // 判斷 extra 是分類還是商店名稱
  let category   = null;
  let sellerName = null;

  if (extra) {
    // 先看是否完全符合已知分類
    const matchedCat = CATEGORIES.find(c => extra.includes(c));
    if (matchedCat) {
      category = matchedCat;
    } else {
      // 當成商店名稱
      sellerName = extra;
      category = categorize(sellerName, itemName);
    }
  }

  if (!category) {
    category = categorize('', itemName);
  }

  return {
    itemName,
    amount: Math.round(amount), // 取整數元
    sellerName: sellerName || '',
    category,
    invDate: new Date().toISOString().split('T')[0],
  };
}

// ── 手動記帳入口 ──────────────────────────────────────────────

/**
 * 嘗試解析文字訊息為手動記帳
 * 由 lineHandler.js 在「無法識別指令」之前呼叫
 * 回傳 null 代表這不是手動記帳格式
 */
async function tryManualEntry(lineUserId, text) {
  // 先試著解析外幣標記
  const currencyResult = parseCurrency(text);
  const textForParsing = currencyResult ? currencyResult.cleanedText : text;

  const parsed = parseManualEntry(textForParsing);
  if (!parsed) return null;

  // 如果已有外幣標記，直接處理
  if (currencyResult) {
    return processEntryWithCurrency(lineUserId, parsed, currencyResult.currency);
  }

  // 沒有外幣標記 → 問用戶是否為外幣
  // 先暫存，等用戶選擇幣別
  setFlow(lineUserId, 'pick_currency', { parsed });

  return [{
    type: 'text',
    text: [
      `📝 ${parsed.itemName}　NT$ ${parsed.amount.toLocaleString()}`,
      '',
      '幣別：',
    ].join('\n'),
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '台幣 TWD', text: '幣別 TWD' } },
        { type: 'action', action: { type: 'message', label: '日圓 JPY', text: '幣別 JPY' } },
        { type: 'action', action: { type: 'message', label: '美元 USD', text: '幣別 USD' } },
        { type: 'action', action: { type: 'message', label: '韓元 KRW', text: '幣別 KRW' } },
        { type: 'action', action: { type: 'message', label: '港幣 HKD', text: '幣別 HKD' } },
        { type: 'action', action: { type: 'message', label: '歐元 EUR', text: '幣別 EUR' } },
        { type: 'action', action: { type: 'message', label: '英鎊 GBP', text: '幣別 GBP' } },
        { type: 'action', action: { type: 'message', label: 'SGD 坡幣', text: '幣別 SGD' } },
        { type: 'action', action: { type: 'message', label: '泰銖 THB', text: '幣別 THB' } },
        { type: 'action', action: { type: 'message', label: '人民幣 CNY', text: '幣別 CNY' } },
        { type: 'action', action: { type: 'message', label: '澳幣 AUD', text: '幣別 AUD' } },
        { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
      ],
    },
  }];
}

async function processEntryWithCurrency(lineUserId, parsed, currency) {
  let twdAmount    = parsed.amount;
  let exchangeRate = null;

  if (currency !== 'TWD') {
    try {
      const result = await convertToTWD(parsed.amount, currency);
      twdAmount    = result.twd;
      exchangeRate = result.rate;
    } catch (err) {
      return [{
        type: 'text',
        text: `❌ 無法查詢 ${currency} 匯率：${err.message}\n請稍後再試，或改用台幣記帳。`,
      }];
    }
  }

  setFlow(lineUserId, 'confirm_entry', {
    parsed: {
      ...parsed,
      origAmount:   currency !== 'TWD' ? parsed.amount : null,
      origCurrency: currency !== 'TWD' ? currency : null,
      exchangeRate,
      amount: twdAmount,
    },
    currency,
  });

  const amountDisplay = currency !== 'TWD'
    ? formatAmount(parsed.amount, currency, twdAmount)
    : `NT$ ${twdAmount.toLocaleString()}`;

  return [{
    type: 'text',
    text: [
      '📝 確認這筆記帳？',
      `品項：${parsed.itemName}`,
      parsed.sellerName ? `商店：${parsed.sellerName}` : null,
      `金額：${amountDisplay}`,
      currency !== 'TWD' ? `匯率：1 ${currency} = ${exchangeRate} TWD` : null,
      `分類：${parsed.category}`,
      '',
      '分類有誤可輸入新分類（如：交通）',
    ].filter(Boolean).join('\n'),
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '✅ 確認', text: '確認' } },
        { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
        ...CATEGORIES.slice(0, 9).map(cat => ({
          type: 'action',
          action: { type: 'message', label: cat, text: cat },
        })),
      ],
    },
  }];
}

/**
 * 在確認流程中處理用戶回覆
 */
async function handleConfirmEntry(lineUserId, text, flow) {
  const { parsed } = flow.data;
  const cmd = text.trim();

  // 取消
  if (cmd === '取消' || cmd === '不對') {
    clearFlow(lineUserId);
    return [{ type: 'text', text: '已取消，這筆記帳沒有存入。' }];
  }

  // 確認
  if (cmd === '確認' || cmd === 'ok' || cmd === 'OK') {
    return await saveManualEntry(lineUserId, parsed);
  }

  // 改分類
  const matchedCat = CATEGORIES.find(c => cmd.includes(c));
  if (matchedCat) {
    parsed.category = matchedCat;
    flow.data.parsed = parsed;
    return [
      {
        type: 'text',
        text: [
          `分類已改為「${matchedCat}」`,
          `品項：${parsed.itemName}　NT$ ${parsed.amount.toLocaleString()}`,
        ].join('\n'),
        quickReply: {
          items: [
            {
              type: 'action',
              action: { type: 'message', label: '✅ 確認', text: '確認' },
            },
            {
              type: 'action',
              action: { type: 'message', label: '❌ 取消', text: '取消' },
            },
          ],
        },
      },
    ];
  }

  return [{
    type: 'text',
    text: '請按下方按鈕確認，或直接輸入分類名稱（如：交通）。',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '✅ 確認', text: '確認' } },
        { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
      ],
    },
  }];
}

async function handlePickCurrency(lineUserId, text, flow) {
  // 取消
  if (text.trim() === '取消') {
    clearFlow(lineUserId);
    return [{ type: 'text', text: '已取消記帳。' }];
  }

  // 解析幣別選擇，格式「幣別 JPY」
  const match = text.trim().match(/^幣別\s*([A-Z]{3})$/i);
  if (!match) {
    return [{ type: 'text', text: '請點選上方的幣別按鈕。' }];
  }

  const currency = match[1].toUpperCase();
  clearFlow(lineUserId);
  return processEntryWithCurrency(lineUserId, flow.data.parsed, currency);
}

async function saveManualEntry(lineUserId, parsed) {
  clearFlow(lineUserId);

  await db.insertRecord({
    lineUserId,
    source:       'manual',
    invNum:       null,
    invDate:      parsed.invDate,
    sellerName:   parsed.sellerName,
    itemName:     parsed.itemName,
    quantity:     1,
    unitPrice:    parsed.amount,
    amount:       parsed.amount,        // 台幣金額
    origAmount:   parsed.origAmount,    // 原始外幣金額（若有）
    origCurrency: parsed.origCurrency,  // 幣別代碼（若有）
    exchangeRate: parsed.exchangeRate,  // 當時匯率（若有）
    category:     parsed.category,
  });

  const amountDisplay = parsed.origCurrency
    ? formatAmount(parsed.origAmount, parsed.origCurrency, parsed.amount)
    : `NT$ ${parsed.amount.toLocaleString()}`;

  return [
    {
      type: 'text',
      text: [
        `✅ 已記帳！`,
        `${parsed.itemName}　${amountDisplay}　[${parsed.category}]`,
        '',
        '輸入「最近記錄」查看明細，「本月報表」查看統計。',
      ].join('\n'),
    },
  ];
}

// ── 分類修正流程 ──────────────────────────────────────────────

/**
 * 開始分類修正流程
 * 列出最近 10 筆記錄，請用戶選擇要修改哪一筆
 */
async function handleEditCategoryStart(lineUserId) {
  const records = await db.getRecentRecords(lineUserId, 10);

  if (records.length === 0) {
    return [{ type: 'text', text: '目前沒有任何記錄可以修改。' }];
  }

  setFlow(lineUserId, 'edit_pick_record', { records });

  const lines = ['請輸入要修改分類的編號：', '─────────────────'];
  records.forEach((r, i) => {
    const date = r.inv_date ? r.inv_date.substring(5) : '?';
    lines.push(`${i + 1}. ${date} ${r.item_name}　NT$${r.amount}　[${r.category}]`);
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * 用戶選了要修改的記錄編號
 */
async function handlePickRecord(lineUserId, text, flow) {
  const num = parseInt(text.trim(), 10);
  const { records } = flow.data;

  if (isNaN(num) || num < 1 || num > records.length) {
    return [{ type: 'text', text: `請輸入 1 到 ${records.length} 之間的數字。` }];
  }

  const record = records[num - 1];
  setFlow(lineUserId, 'edit_pick_category', { record });

  return [
    {
      type: 'text',
      text: `選擇「${record.item_name}」的新分類：`,
      quickReply: {
        items: CATEGORIES.map(cat => ({
          type: 'action',
          action: { type: 'message', label: cat, text: cat },
        })),
      },
    },
  ];
}

/**
 * 用戶選了新分類
 */
async function handlePickCategory(lineUserId, text, flow) {
  const { record } = flow.data;
  const cmd = text.trim();

  // 支援輸入數字（對應分類編號）或直接輸入分類名稱
  let newCategory = null;
  const numInput = parseInt(cmd, 10);

  if (!isNaN(numInput) && numInput >= 1 && numInput <= CATEGORIES.length) {
    newCategory = CATEGORIES[numInput - 1];
  } else {
    newCategory = CATEGORIES.find(c => cmd.includes(c));
  }

  if (!newCategory) {
    return [{
      type: 'text',
      text: `請輸入數字（1-${CATEGORIES.length}）或直接輸入分類名稱。`,
    }];
  }

  // 寫入資料庫
  await db.updateRecordCategory(record.id, lineUserId, newCategory);
  clearFlow(lineUserId);

  return [{
    type: 'text',
    text: [
      `✅ 分類已更新！`,
      `${record.item_name}`,
      `${record.category}　→　${newCategory}`,
    ].join('\n'),
  }];
}

// ── 統一的流程入口（由 lineHandler 呼叫）─────────────────────

/**
 * 判斷是否有進行中的手動記帳/分類修正流程，並處理
 * 回傳 null 代表目前沒有進行中的流程
 */
async function handlePendingFlow(lineUserId, text) {
  const flow = getFlow(lineUserId);
  if (!flow) return null;

  if (flow.type === 'pick_currency') {
    return await handlePickCurrency(lineUserId, text, flow);
  }

  if (flow.type === 'confirm_entry') {
    return await handleConfirmEntry(lineUserId, text, flow);
  }

  if (flow.type === 'edit_pick_record') {
    return await handlePickRecord(lineUserId, text, flow);
  }

  if (flow.type === 'edit_pick_category') {
    return await handlePickCategory(lineUserId, text, flow);
  }

  return null;
}

// ── 工具 ──────────────────────────────────────────────────────

/**
 * 建立分類選項按鈕文字（因 Line 免費方案按鈕有限制，用數字清單代替）
 */
function buildCategoryButtons(highlight = null) {
  return CATEGORIES
    .map((c, i) => `${i + 1}. ${c}${c === highlight ? ' ◀' : ''}`)
    .join('\n');
}

module.exports = {
  tryManualEntry,
  handlePendingFlow,
  handleEditCategoryStart,
  CATEGORIES,
  parseManualEntry, // 供測試用
};
