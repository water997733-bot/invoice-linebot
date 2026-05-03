/**
 * lineHandler.js
 * Line Bot 
 *
 * 
 *  ・       → Claude Vision
 *  ・       → 
 *  ・       → 
 *  ・       →  API 
 *  ・       → 
 *  ・       → 
 *  ・       →  10 
 *  ・ XXXXX    → 
 *  ・ /     → 
 *  ・           → 
 */

const line = require('@line/bot-sdk');
const db   = require('./database');
const { handleBindStart, handleBindingInput, handleBindCancel, handleUnbind } = require('./carrierFlow');
const { manualSync } = require('./syncService');
const { summarizeByCategory } = require('./einvoice');
const { runLotteryCheck, formatInvTerm } = require('./lotteryService');
const { tryManualEntry, handlePendingFlow, handleEditCategoryStart } = require('./manualEntryFlow');
const { analyzeInvoiceImage, detectMimeType } = require('./claude');
const { formatAmount } = require('./currencyService');
const { parseInvoiceFromImage, formatInvoiceResult } = require('./invoiceQR');
const { categorize } = require('./einvoice');
// report.js placeholder
// const { generateReport } = require('./report');
// const { analyzeInvoiceImage } = require('./claude');

// ── Line Client  ────────────────────────────────────────
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// ──  ────────────────────────────────────────────

/**
 *  Line Webhook 
 *  index.js 
 */
async function handleEvent(event) {
  // Only handle user chat events
  if (event.source.type !== 'user') return;

  const lineUserId = event.source.userId;

  // Auto-create user record on first interaction
  await db.upsertUser(lineUserId).catch(() => {});

  try {
    if (event.type === 'message') {
      if (event.message.type === 'text') {
        return await handleTextMessage(lineUserId, event);
      }
      if (event.message.type === 'image') {
        return await handleImageMessage(lineUserId, event);
      }
    }

    if (event.type === 'follow') {
      return await handleFollow(lineUserId, event);
    }

  } catch (err) {
    console.error(`[lineHandler] 處理事件失敗：${err.message}`, err);
    await reply(event.replyToken, [{
      type: 'text',
      text: '⚠️ 系統發生錯誤，請稍後再試。',
    }]);
  }
}

// Text message handler

async function handleTextMessage(lineUserId, event) {
  const text  = event.message.text.trim();
  const token = event.replyToken;

  // Step 1: Check carrier binding flow
  const bindingReply = await handleBindingInput(lineUserId, text);
  if (bindingReply) {
    if (isBindSuccess(bindingReply)) {
      triggerFirstSync(lineUserId).catch(console.error);
    }
    return reply(token, bindingReply);
  }

  // Step 2: Check manual entry flow
  const pendingReply = await handlePendingFlow(lineUserId, text);
  if (pendingReply) {
    return reply(token, pendingReply);
  }

  // Step 3: Command matching
  const cmd = normalizeCommand(text);

  if (cmd === '綁定載具' || cmd === '綁定') {
    const msgs = await handleBindStart(lineUserId);
    return reply(token, msgs);
  }

  if (cmd === '解除綁定' || cmd === '解綁') {
    const msgs = await handleUnbind(lineUserId);
    return reply(token, msgs);
  }

  if (cmd === '取消') {
    const msgs = handleBindCancel(lineUserId);
    return reply(token, msgs);
  }

  if (cmd === '同步發票' || cmd === '同步') {
    await reply(token, [{ type: 'text', text: '⏳ 開始同步，請稍候...' }]);
    const resultMsg = await manualSync(lineUserId);
    return push(lineUserId, [{ type: 'text', text: resultMsg }]);
  }

  if (cmd === '本月報表' || cmd === '報表') {
    return handleReport(lineUserId, token, 0);
  }

  if (cmd === '上月報表') {
    return handleReport(lineUserId, token, -1);
  }

  if (cmd === '最近記錄' || cmd === '最近' || cmd === '記錄') {
    return handleRecentRecords(lineUserId, token);
  }

  if (cmd.startsWith('預算')) {
    return handleSetBudget(lineUserId, token, text);
  }

  if (cmd === '說明' || cmd === '幫助' || cmd === 'help') {
    return reply(token, [buildHelpMessage()]);
  }

  if (cmd === '對獎' || cmd === '對獎查詢') {
    return handleLotteryCheck(lineUserId, token);
  }

  if (cmd === '狀態' || cmd === '設定') {
    return handleStatus(lineUserId, token);
  }

  // ──  ──
  if (cmd === '修改分類' || cmd === '改分類' || cmd === '修改') {
    const msgs = await handleEditCategoryStart(lineUserId);
    return reply(token, msgs);
  }

  // ──  ──
  if (cmd === '刪除記錄' || cmd === '刪除') {
    return handleDeleteRecord(lineUserId, token);
  }

  if (cmd.startsWith('刪除')) {
    //  3
    const num = parseInt(cmd.replace('刪除', '').trim(), 10);
    if (!isNaN(num)) return handleDeleteByIndex(lineUserId, token, num);
  }

  // ──  ──
  // 
  const manualReply = await tryManualEntry(lineUserId, text);
  if (manualReply) {
    return reply(token, manualReply);
  }

  // ④ 
  return reply(token, [{
    type: 'text',
    text: [
      '不太懂您的意思 🤔',
      '',
      '💡 快速記帳直接輸入，例如：',
      '「午餐 150」「計程車 320 交通」',
      '',
      '輸入「說明」查看所有指令。',
    ].join('\n'),
  }]);
}

// Image message handler - DISABLED (coming soon)

async function handleImageMessage(lineUserId, event) {
  const token = event.replyToken;

  // 下載圖片
  let imageBuffer;
  try {
    const stream = await client.getMessageContent(event.message.id);
    imageBuffer = await streamToBuffer(stream);
  } catch (err) {
    return reply(token, [{ type: 'text', text: '❌ 圖片下載失敗，請重新傳送。' }]);
  }

  // 嘗試掃描 QR Code
  await reply(token, [{ type: 'text', text: '🔍 掃描發票 QR Code 中...' }]);

  const result = await parseInvoiceFromImage(imageBuffer);

  if (result.success) {
    const inv = result.invoice;
    const storeName = inv.sellerBAN ? `統編 ${inv.sellerBAN}` : '未知商家';
    const itemName  = inv.items.length > 0 ? inv.items[0].name : storeName;
    const category  = categorize(storeName, itemName);

    // 儲存到資料庫
    try {
      await db.insertRecord({
        lineUserId,
        source:     'qr',
        invNum:     inv.invNum,
        invDate:    inv.invDate,
        sellerName: storeName,
        itemName:   inv.items.length > 0 ? inv.items.map(i => i.name).join('、') : storeName,
        quantity:   1,
        unitPrice:  inv.totalAmount,
        amount:     inv.totalAmount,
        category,
      });
    } catch (dbErr) {
      console.error('[lineHandler] 儲存失敗：', dbErr.message);
    }

    const text = formatInvoiceResult(inv, category);
    return client.pushMessage(lineUserId, [{ type: 'text', text }]);
  }

  if (result.error === 'no_qr') {
    return client.pushMessage(lineUserId, [{
      type: 'text',
      text: [
        '📷 找不到 QR Code',
        '',
        '請確認：',
        '1. 照片包含發票左側的 QR Code',
        '2. 圖片清晰、光線充足',
        '3. QR Code 沒有被遮住',
        '',
        '或改用手動記帳：',
        '「午餐 150」「計程車 320 交通」',
      ].join('\n'),
    }]);
  }

  // QR Code 存在但不是發票格式
  return client.pushMessage(lineUserId, [{
    type: 'text',
    text: [
      '📷 偵測到 QR Code，但不是電子發票格式。',
      '',
      '請傳送含有電子發票 QR Code 的照片，',
      '或改用手動記帳：「午餐 150」',
    ].join('\n'),
  }]);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/*
async function handleImageMessage_disabled(lineUserId, event) {
  const token = event.replyToken;
  await reply(token, [{ type: 'text', text: '📷 收到發票照片，AI 辨識中...\n（約需 5-10 秒）' }]);
  try {
    const imageBuffer = await downloadImage(event.message.id);
    const mimeType    = detectMimeType(imageBuffer);
    const result = await analyzeInvoiceImage(imageBuffer, mimeType);
    for (const item of result.items) {
      await db.insertRecord({
        lineUserId, source: 'photo', invNum: result.invNum, invDate: result.invDate,
        sellerName: result.sellerName, itemName: item.name, quantity: item.quantity,
        unitPrice: item.unitPrice, amount: item.amount,
        origAmount: item.origAmount, origCurrency: item.origCurrency, exchangeRate: item.exchangeRate,
        category: item.category,
      });
    }
    await push(lineUserId, [buildInvoiceConfirmMessage(result)]);
  } catch (err) {
    console.error('[lineHandler] 發票辨識失敗：', err.message);
    await push(lineUserId, [{ type: 'text', text: `❌ 辨識失敗\n也可改用手動記帳：「午餐 150」` }]);
  }
}
*/

// Feature handlers

async function handleReport(lineUserId, token, monthOffset) {
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year  = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const label = `${year} 年 ${month} 月`;

  // Reply generating first
  await reply(token, [{
    type: 'text',
    text: `📊 正在生成「${label}」報表...`,
  }]);

  const records = await db.getMonthRecords(lineUserId, year, month);

  if (records.length === 0) {
    return push(lineUserId, [{
      type: 'text',
      text: `📭 ${label} 沒有任何記錄。\n\n透過以下方式新增帳目：\n・輸入「同步發票」同步載具\n・傳送發票照片`,
    }]);
  }

  const { categories, total } = summarizeByCategory(records);

  //  report.js 
  const lines = [
    `📊 ${label} 消費報表`,
    `總計：NT$ ${total.toLocaleString()}`,
    '─────────────────',
  ];

  // Sort by amount
  const sorted = Object.entries(categories).sort((a, b) => b[1].amount - a[1].amount);
  for (let i = 0; i < sorted.length; i++) {
    const [cat, { amount, percentage }] = sorted[i];
    const medals_r=['🥇','🥈','🥉'];const icon_r=medals_r[i]||'・';
    lines.push(`${icon_r} ${cat}　NT$ ${amount.toLocaleString()}（${percentage}%）`);
  }

  // Budget warning
  const budget = await db.getMonthlyBudget(lineUserId);
  if (budget) {
    const ratio = Math.round((total / budget) * 100);
    lines.push('─────────────────');
    lines.push(`月預算：NT$ ${budget.toLocaleString()}`);
    if (ratio >= 100) {
      lines.push(`⚠️ 已超出預算 ${ratio - 100}%！`);
    } else {
      lines.push(`剩餘預算：NT$ ${(budget - total).toLocaleString()}（已用 ${ratio}%）`);
    }
  }

  lines.push('─────────────────');
  lines.push('輸入「最近記錄」查看明細');

  // Build QuickChart pie chart
  const chartData = {
    type: 'pie',
    data: {
      labels: sorted.map(([cat, { percentage }]) => `${cat} ${percentage}%`),
      datasets: [{
        data: sorted.map(([, { amount }]) => amount),
        backgroundColor: ['#FF6384','#36A2EB','#FFCE56','#4BC0C0','#9966FF','#FF9F40','#C9CBCF','#7BC8A4','#E8C1A0','#F47560','#61CDBB'],
      }],
    },
    options: {
      plugins: {
        title: { display: true, text: `${label} 消費報表`, fontSize: 18 },
        legend: { position: 'bottom' },
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartData))}&w=600&h=500&backgroundColor=white`;

  return push(lineUserId, [
    { type: 'image', originalContentUrl: chartUrl, previewImageUrl: chartUrl },
    { type: 'text', text: lines.join('\n') },
  ]);
}

async function handleRecentRecords(lineUserId, token) {
  const records = await db.getRecentRecords(lineUserId, 10);

  if (records.length === 0) {
    return reply(token, [{
      type: 'text',
      text: '📭 目前沒有任何記錄，傳送發票照片或同步載具開始記帳！',
    }]);
  }

  const { formatAmount } = require('./currencyService');
const { parseInvoiceFromImage, formatInvoiceResult } = require('./invoiceQR');
const { categorize } = require('./einvoice');
  const lines = ['🧾 最近 10 筆記錄', '─────────────────'];
  for (const r of records) {
    const date = r.inv_date ? r.inv_date.substring(5) : '?'; // MM-DD
    const shop = r.seller_name ? `【${r.seller_name}】` : '';
    const src  = r.source === 'carrier' ? '📡' : r.source === 'photo' ? '📷' : '✏️';
    const amountStr = (r.orig_currency && r.orig_amount)
      ? formatAmount(parseFloat(r.orig_amount), r.orig_currency, r.amount)
      : `NT$ ${r.amount.toLocaleString()}`;

    lines.push(`${src} ${date} ${shop}${r.item_name}`);
    lines.push(`　　${r.category}　${amountStr}`);
  }

  return reply(token, [{ type: 'text', text: lines.join('\n') }]);
}

async function handleSetBudget(lineUserId, token, text) {
  // Parse budget command
  const match = text.replace(/[,$]/g, '').match(/\s*(\d+)/);
  if (!match) {
    return reply(token, [{
      type: 'text',
      text: '請輸入正確格式，例如：\n預算 30000',
    }]);
  }

  const amount = parseInt(match[1], 10);
  if (amount <= 0 || amount > 10000000) {
    return reply(token, [{
      type: 'text',
      text: '請輸入合理的預算金額（1 ~ 10,000,000）',
    }]);
  }

  await db.setMonthlyBudget(lineUserId, amount);

  return reply(token, [{
    type: 'text',
    text: `✅ 月預算已設定為 NT$ ${amount.toLocaleString()}\n\n每次查看報表時會顯示預算使用狀況。`,
  }]);
}

// Delete record handlers

async function handleDeleteRecord(lineUserId, token) {
  const records = await db.getRecentRecords(lineUserId, 10);

  if (records.length === 0) {
    return reply(token, [{ type: 'text', text: '目前沒有任何記錄可以刪除。' }]);
  }

  const lines = ['請選擇要刪除的記錄：', '─────────────────'];
  records.forEach((r, i) => {
    const date = r.inv_date ? r.inv_date.substring(5) : '?';
    const src  = r.source === 'carrier' ? '📡' : r.source === 'photo' ? '📷' : '✏️';
    lines.push(`${i + 1}. ${src} ${date} ${r.item_name}　NT$${r.amount}`);
  });

  return reply(token, [{
    type: 'text',
    text: lines.join('\n'),
    quickReply: {
      items: records.slice(0, 13).map((r, i) => ({
        type: 'action',
        action: { type: 'message', label: `${i + 1}. ${r.item_name.substring(0, 8)}`, text: `刪除 ${i + 1}` },
      })),
    },
  }]);
}

async function handleDeleteByIndex(lineUserId, token, index) {
  const records = await db.getRecentRecords(lineUserId, 10);

  if (index < 1 || index > records.length) {
    return reply(token, [{
      type: 'text',
      text: `編號錯誤，請輸入「刪除記錄」查看可刪除的清單。`,
    }]);
  }

  const record = records[index - 1];
  await db.deleteRecord(lineUserId, record.id);

  return reply(token, [{
    type: 'text',
    text: [
      `🗑 已刪除：`,
      `${record.item_name}　NT$ ${record.amount}　[${record.category}]`,
    ].join('\n'),
  }]);
}

async function handleLotteryCheck(lineUserId, token) {
  const user = await db.getUser(lineUserId);
  if (!user || !user.card_no) {
    return reply(token, [{
      type: 'text',
      text: '⚠️ 請先輸入「綁定載具」完成設定，才能使用對獎功能！',
    }]);
  }

  await reply(token, [{ type: 'text', text: '🎰 對獎查詢中，請稍候...' }]);

  try {
    // 
    await runLotteryCheck();
  } catch (err) {
    await push(lineUserId, [{
      type: 'text',
      text: `❌ 對獎失敗：${err.message}\n請稍後再試。`,
    }]);
  }
}

async function handleStatus(lineUserId, token) {
  const user = await db.getUser(lineUserId);

  const lines = ['⚙️ 目前設定狀態', '─────────────────'];

  if (user?.card_no) {
    lines.push(`✅ 載具綁定：${user.card_no}`);
    const lastSync = user.last_sync_at
      ? new Date(user.last_sync_at).toLocaleDateString('zh-TW')
      : '尚未同步';
    lines.push(`　最後同步：${lastSync}`);
  } else {
    lines.push('❌ 載具：尚未綁定');
  }

  if (user?.monthly_budget) {
    lines.push(`💰 月預算：NT$ ${user.monthly_budget.toLocaleString()}`);
  } else {
    lines.push('💰 月預算：未設定');
  }

  return reply(token, [{ type: 'text', text: lines.join('\n') }]);
}

// Follow event handler

async function handleFollow(lineUserId, event) {
  await db.upsertUser(lineUserId);

  return reply(event.replyToken, [
    {
      type: 'text',
      text: [
        '👋 嗨！我是記帳媽媽 💰',
        '',
        '我可以幫你輕鬆記帳、分帳、看報表！',
        '',
        '📝 個人記帳',
        '  直接輸入「午餐 150」就能記帳',
        '  支援外幣：「拉麵 JPY 1200」',
        '',
        '👥 群組分帳',
        '  /開始分帳 旅遊　─ 建立分帳',
        '  /加帳 晚餐 1200　─ 新增費用',
        '  /結算　　　　　　─ 查看誰欠誰',
        '',
        '📊 報表 & 預算',
        '  輸入「本月報表」查看消費統計',
        '  輸入「預算 30000」設定月預算',
        '',
        '輸入「說明」查看完整功能列表 👇',
      ].join('\n'),
    },
    buildHelpMessage(),
  ]);
}

// Message builders

function buildHelpMessage() {
  return {
    type: 'text',
    text: [
      '📖 完整功能說明',
      '─────────────────',
      '✏️ 手動記帳（直接輸入）',
      '  午餐 150',
      '  計程車 320 交通',
      '  咖啡 85 星巴克',
      '  拉麵 JPY 1200　← 外幣',
      '  星巴克 USD 6.5　← 外幣',
      '',
      '📋 記錄管理',
      '  最近記錄　─ 最新 10 筆明細',
      '  修改分類　─ 修正自動分類錯誤',
      '  刪除記錄　─ 刪除一筆記帳',
      '',
      '👥 群組分帳',
      '  /分帳說明　　　─ 分帳完整說明',
      '  /開始分帳 名稱 ─ 建立新分帳',
      '  /加帳 描述 金額 ─ 新增費用',
      '  /查看　　　　　─ 查看明細',
      '  /結算　　　　　─ 結算誰欠誰',
      '  /結束分帳　　　─ 結算並結束',
      '',
      '🎰 發票對獎',
      '  對獎　　　─ 手動查詢本期中獎',
      '',
      '📊 報表',
      '  本月報表　─ 本月消費分析',
      '  上月報表　─ 上個月分析',
      '',
      '⚙️ 設定',
      '  預算 30000　─ 設定月預算',
      '  狀態　　　　─ 查看目前設定',
      '',
      '─────────────────',
      '每天 8:00 自動同步，雙月 25 日自動對獎',
    ].join('\n'),
  };
}

function buildInvoiceConfirmMessage(result) {
  const lines = [
    `✅ 發票辨識完成！已自動記帳`,
    `商店：${result.sellerName || '（無法辨識）'}`,
    `日期：${result.invDate}`,
    result.invNum ? `發票號碼：${result.invNum}` : null,
    '─────────────────',
  ].filter(Boolean);

  for (const item of result.items) {
    const amountStr = item.origCurrency
      ? formatAmount(item.origAmount, item.origCurrency, item.amount)
      : `NT$ ${item.amount.toLocaleString()}`;
    lines.push(`・${item.name}　${amountStr}　[${item.category}]`);
  }

  lines.push('─────────────────');

  // 
  const totalStr = result.origTotal
    ? formatAmount(result.origTotal, result.currency, result.totalAmount)
    : `NT$ ${result.totalAmount.toLocaleString()}`;
  lines.push(`合計：${totalStr}`);

  if (result.currency !== 'TWD' && result.exchangeRate) {
    lines.push(`匯率：1 ${result.currency} = ${result.exchangeRate} TWD`);
  }

  lines.push('');
  lines.push('分類有誤？輸入「修改分類」可修正。');

  return { type: 'text', text: lines.join('\n') };
}

// Internal utilities

function normalizeCommand(text) {
  return text
    .replace(/\s+/g, '')   // Remove whitespace
    .replace(/[！!？?]/g, '') // Remove punctuation
    .toLowerCase()
    .replace('help', 'help'); // Keep English commands
}

function isBindSuccess(messages) {
  return messages.some(m => m.type === 'text' && m.text.includes('綁定成功'));
}

async function triggerFirstSync(lineUserId) {
  const { manualSync } = require('./syncService');
  const result = await manualSync(lineUserId);
  await push(lineUserId, [{ type: 'text', text: result }]);
}

async function downloadImage(messageId) {
  const stream = await client.getMessageContent(messageId);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function reply(replyToken, messages) {
  return client.replyMessage(replyToken, messages);
}

function push(lineUserId, messages) {
  return client.pushMessage(lineUserId, messages);
}

module.exports = {
  handleEvent,
  client,  // For syncService.js
};
