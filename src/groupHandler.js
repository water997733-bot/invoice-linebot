/**
 * groupHandler.js
 * Line Group split-bill handler
 *
 * Commands (in group chat):
 *   /開始分帳 名稱   - Start a split session
 *   /加帳 描述 金額  - Add an expense
 *   /編輯 編號       - Edit an expense
 *   /刪帳 編號       - Delete an expense
 *   /查看            - List all expenses
 *   /結算            - Show settlement without closing
 *   /結束分帳        - Settle and close session
 *   /狀態            - Show current session status
 *   /分帳說明        - Show help
 *   (send image)     - Auto-recognize invoice and add expense
 */

const {
  createSplitSession, addSplitExpense, getSplitExpenses,
  deleteSplitExpense, updateSplitExpense, getSplitExpenseById,
  closeSplitSession, getSplitMembers, upsertSplitMember,
  getGroupActiveSession, getAllOpenSessions,
} = require('./database');

const { calculateSettlement, formatSettlementText, formatExpenseList } = require('./splitBill');
const { analyzeInvoiceImage, detectMimeType } = require('./claude');
const { convertToTWD } = require('./currencyService');

// 常用幣別（Quick Reply 最多 13 個）
const CURRENCY_OPTIONS = [
  { code: 'TWD', label: '🇹🇼 台幣 TWD' },
  { code: 'JPY', label: '🇯🇵 日圓 JPY' },
  { code: 'USD', label: '🇺🇸 美元 USD' },
  { code: 'EUR', label: '🇪🇺 歐元 EUR' },
  { code: 'KRW', label: '🇰🇷 韓元 KRW' },
  { code: 'HKD', label: '🇭🇰 港幣 HKD' },
  { code: 'THB', label: '🇹🇭 泰銖 THB' },
  { code: 'SGD', label: '🇸🇬 星幣 SGD' },
  { code: 'MYR', label: '🇲🇾 馬幣 MYR' },
  { code: 'AUD', label: '🇦🇺 澳幣 AUD' },
  { code: 'GBP', label: '🇬🇧 英鎊 GBP' },
  { code: 'VND', label: '🇻🇳 越盾 VND' },
  { code: 'CNY', label: '🇨🇳 人民幣 CNY' },
];

// Pending expense state (in-memory)
const pendingExpenses = {};

// ── Main Group Event Handler ──────────────────────────────

async function handleGroupEvent(event, client) {
  const groupId = event.source.groupId || event.source.roomId;
  const userId  = event.source.userId;
  if (!userId || !groupId) return;

  let displayName = '成員';
  try {
    const profile = await client.getGroupMemberProfile(groupId, userId);
    displayName = profile.displayName || '成員';
  } catch {}
  try { await upsertSplitMember(groupId, userId, displayName); } catch {}

  // image recognition disabled
  if (event.type === 'message' && event.message.type === 'image') {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: 'Photo recognition coming soon. Use: /add description amount'
    });
  }
  if (event.type === 'message' && event.message.type === 'text')
    return handleGroupText(event, client, groupId, userId, displayName);
  if (event.type === 'postback')
    return handleGroupPostback(event, client, groupId, userId, displayName);
}

// ── Image Handler ─────────────────────────────────────────

async function handleGroupImage(event, client, groupId, userId, displayName) {
  const session = await getGroupActiveSession(groupId);
  if (!session) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '⚠️ 請先輸入「/開始分帳 活動名稱」。'
    });
  }
  await client.replyMessage(event.replyToken, {
    type: 'text', text: `📸 ${displayName} 上傳發票，辨識中...`
  });
  try {
    const stream = await client.getMessageContent(event.message.id);
    const buf      = await streamToBuffer(stream);
    const mimeType = detectMimeType(buf);
    const result   = await analyzeInvoiceImage(buf, mimeType);
    const members  = await getSplitMembers(groupId);
    const pendingId = `${groupId}_${Date.now()}`;
    pendingExpenses[pendingId] = {
      description: result.sellerName ? `${result.sellerName}（發票）` : '發票消費',
      amount: result.totalAmount, invoiceData: result,
      sessionId: session.id, groupId,
      payerId: null, payerName: null, splitWith: [], mode: 'add',
    };
    await client.pushMessage(groupId, [
      { type: 'text', text: `✅ 辨識完成！\n🏪 ${result.sellerName || '未知商家'}\n💰 NT$ ${result.totalAmount.toLocaleString()}\n\n【第1步】選擇付款人 👇` },
      buildPayerQuickReply(pendingId, members),
    ]);
  } catch (err) {
    await client.pushMessage(groupId, {
      type: 'text', text: `❌ 辨識失敗：${err.message}\n請改用：/加帳 描述 金額`
    });
  }
}

// ── Text Command Handler ──────────────────────────────────

async function handleGroupText(event, client, groupId, userId, displayName) {
  const text = event.message.text.trim();

  if (text.startsWith('/開始分帳') || text.startsWith('/新增分帳')) {
    const name = text.replace(/^\/(開始|新增)分帳\s*/, '').trim() || '分帳活動';
    return handleStartSession(event, client, groupId, userId, name);
  }
  if (text.startsWith('/加帳'))   return handleAddExpense(event, client, groupId, text);
  if (text.startsWith('/刪帳'))   return handleDeleteExpense(event, client, groupId, text);
  if (text.startsWith('/編輯'))   return handleEditExpense(event, client, groupId, text);
  if (text.startsWith('/確認')) {
    const pendingId = text.replace('/確認', '').trim();
    return confirmExpense(pendingId, client, groupId, event.replyToken);
  }
  if (text === '/查看' || text === '/消費明細') return handleListExpenses(event, client, groupId);
  if (text === '/結算' || text === '/分帳結果') return handleSettlement(event, client, groupId, false);
  if (text === '/結束分帳')  return handleSettlement(event, client, groupId, true);
  if (text === '/狀態')      return handleStatus(event, client, groupId);
  if (text === '/help' || text === '/分帳說明') {
    return client.replyMessage(event.replyToken, { type: 'text', text: buildHelpText() });
  }
}

// ── Postback Handler ──────────────────────────────────────

async function handleGroupPostback(event, client, groupId, userId, displayName) {
  const data = event.postback.data;

  // 【幣別選擇】
  if (data.startsWith('currency|')) {
    const [, pendingId, currency] = data.split('|');
    const pending = pendingExpenses[pendingId];
    if (!pending) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 已過期，請重新輸入。' });
    pending.currency = currency;
    // 換算台幣
    if (currency !== 'TWD') {
      try {
        const { twd, rate } = await convertToTWD(pending.origAmount, currency);
        pending.amount = twd;
        pending.exchangeRate = rate;
      } catch {
        pending.amount = pending.origAmount; // 查匯率失敗，保留原值
      }
    } else {
      pending.amount = pending.origAmount;
    }
    const members = await getSplitMembers(groupId);
    const amtDisplay = currency !== 'TWD'
      ? `${currency} ${pending.origAmount.toLocaleString()}（≈ NT$ ${pending.amount.toLocaleString()}）`
      : `NT$ ${pending.amount.toLocaleString()}`;
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: `💱 幣別：${currency} ✅\n💰 ${amtDisplay}\n\n【第2步】選擇付款人 👇` },
      buildPayerQuickReply(pendingId, members),
    ]);
  }

  if (data.startsWith('payer|')) {
    const [, pendingId, payerId, ...nameParts] = data.split('|');
    const payerName = nameParts.join('|');
    const pending   = pendingExpenses[pendingId];
    if (!pending) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 已過期，請重新輸入。' });
    pending.payerId   = payerId;
    pending.payerName = payerName;
    pending.splitWith = [];
    const members = await getSplitMembers(groupId);
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: `👤 付款人：${payerName} ✅\n\n【第2步】選擇分帳人（可多選）\n選完後點「✅ 確認送出」` },
      buildSplitQuickReply(pendingId, members, []),
    ]);
  }

  if (data.startsWith('toggle|')) {
    const [, pendingId, memberId] = data.split('|');
    const pending = pendingExpenses[pendingId];
    if (!pending) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 已過期。' });
    const idx = pending.splitWith.indexOf(memberId);
    if (idx === -1) pending.splitWith.push(memberId);
    else pending.splitWith.splice(idx, 1);
    const members = await getSplitMembers(groupId);
    const selectedNames = members
      .filter(m => pending.splitWith.includes(m.user_id))
      .map(m => m.display_name).join('、') || '（尚未選擇）';
    const perPerson = pending.splitWith.length > 0
      ? Math.round(pending.amount / pending.splitWith.length) : '－';
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ 已選：${selectedNames}\n每人 NT$ ${perPerson}\n\n繼續選人，或點「✅ 確認送出」` },
      buildSplitQuickReply(pendingId, members, pending.splitWith),
    ]);
  }

  if (data.startsWith('splitall|')) {
    const [, pendingId] = data.split('|');
    const pending = pendingExpenses[pendingId];
    if (!pending) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 已過期。' });
    const members = await getSplitMembers(groupId);
    pending.splitWith = members.map(m => m.user_id);
    return confirmExpense(pendingId, client, groupId, event.replyToken);
  }

  if (data.startsWith('confirm|')) {
    const [, pendingId] = data.split('|');
    return confirmExpense(pendingId, client, groupId, event.replyToken);
  }

  if (data.startsWith('editpayer|')) {
    const [, pendingId, payerId, ...nameParts] = data.split('|');
    const payerName = nameParts.join('|');
    const pending   = pendingExpenses[pendingId];
    if (!pending) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 已過期。' });
    pending.payerId   = payerId;
    pending.payerName = payerName;
    pending.splitWith = [];
    const members = await getSplitMembers(groupId);
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: `👤 新付款人：${payerName} ✅\n\n選擇分帳人（可多選）` },
      buildSplitQuickReply(pendingId, members, []),
    ]);
  }
}

// ── Confirm & Save ────────────────────────────────────────

async function confirmExpense(pendingId, client, groupId, replyToken) {
  const pending = pendingExpenses[pendingId];
  if (!pending) return client.replyMessage(replyToken, { type: 'text', text: '⚠️ 找不到此筆消費，請重新輸入。' });
  if (!pending.payerId) return client.replyMessage(replyToken, { type: 'text', text: '⚠️ 請先選擇付款人。' });
  if (pending.splitWith.length === 0) return client.replyMessage(replyToken, { type: 'text', text: '⚠️ 請至少選擇一位分帳人。' });

  const members    = await getSplitMembers(groupId);
  const perPerson  = Math.round(pending.amount / pending.splitWith.length);
  const splitNames = members.filter(m => pending.splitWith.includes(m.user_id)).map(m => m.display_name).join('、');

  if (pending.mode === 'edit' && pending.editExpenseId) {
    await updateSplitExpense(pending.editExpenseId, {
      payerId: pending.payerId, splitWith: pending.splitWith,
      amount: pending.amount, description: pending.description,
    });
    delete pendingExpenses[pendingId];
    return client.replyMessage(replyToken, {
      type: 'text',
      text: `✏️ 已更新！\n📝 ${pending.description}\n💰 NT$ ${pending.amount.toLocaleString()}\n👤 付款：${pending.payerName}\n👥 分帳：${splitNames}`
    });
  } else {
    await addSplitExpense(pending.sessionId, {
      payerId: pending.payerId, description: pending.description,
      amount: pending.amount, splitWith: pending.splitWith,
      splitType: 'equal', invoiceData: pending.invoiceData || null,
      origAmount: pending.origAmount || null,
      currency: pending.currency || 'TWD',
      exchangeRate: pending.exchangeRate || null,
    });
    delete pendingExpenses[pendingId];
    const amtLine = (pending.currency && pending.currency !== 'TWD')
      ? `💰 ${pending.currency} ${pending.origAmount?.toLocaleString()}（≈ NT$ ${pending.amount.toLocaleString()}）`
      : `💰 NT$ ${pending.amount.toLocaleString()}`;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已記錄！\n📝 ${pending.description}\n${amtLine}\n👤 付款：${pending.payerName}\n👥 分帳：${splitNames}`
    });
  }
}

// ── Session Handlers ──────────────────────────────────────

async function handleStartSession(event, client, groupId, userId, sessionName) {
  const existing = await getGroupActiveSession(groupId);
  if (existing) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: `⚠️ 已有分帳：「${existing.name}」\n請先「/結束分帳」再開新的。`
    });
  }
  await createSplitSession(groupId, userId, sessionName);
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `💰「${sessionName}」分帳開始！\n${'─'.repeat(18)}\n➕ /加帳 描述 金額\n📸 傳發票照片自動辨識\n✏️ /編輯 編號\n🗑️ /刪帳 編號\n📋 /查看　📊 /結算\n🏁 /結束分帳`
  });
}

async function handleAddExpense(event, client, groupId, text) {
  const session = await getGroupActiveSession(groupId);
  if (!session) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '⚠️ 沒有進行中的分帳。\n請先「/開始分帳 名稱」。'
    });
  }
  const parts = text.replace('/加帳', '').trim().split(/\s+/);
  if (parts.length < 2) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '格式：/加帳 描述 金額\n範例：/加帳 晚餐 1200'
    });
  }
  const description = parts[0];
  const amount = parseFloat(parts[1].replace(/[,$，]/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '❌ 金額格式錯誤。\n範例：/加帳 晚餐 850'
    });
  }
  const pendingId = `${groupId}_${Date.now()}`;
  pendingExpenses[pendingId] = {
    description, origAmount: amount, currency: 'TWD', amount,
    sessionId: session.id, groupId,
    payerId: null, payerName: null, splitWith: [], mode: 'add',
  };
  return client.replyMessage(event.replyToken, [
    { type: 'text', text: `📝 ${description}　💰 ${amount.toLocaleString()}\n\n【第1步】選擇幣別 👇` },
    buildCurrencyQuickReply(pendingId),
  ]);
}

async function handleEditExpense(event, client, groupId, text) {
  const session = await getGroupActiveSession(groupId);
  if (!session) return;
  const index = parseInt(text.replace('/編輯', '').trim()) - 1;
  if (isNaN(index) || index < 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '格式：/編輯 編號\n先用「/查看」取得編號。\n\n範例：/編輯 2'
    });
  }
  const expenses = await getSplitExpenses(session.id);
  if (index >= expenses.length) {
    return client.replyMessage(event.replyToken, { type: 'text', text: `❌ 找不到第 ${index + 1} 筆。` });
  }
  const exp     = expenses[index];
  const members = await getSplitMembers(groupId);
  const currentPayer      = members.find(m => m.user_id === exp.payer_id);
  const currentSplitNames = members.filter(m => exp.split_with.includes(m.user_id)).map(m => m.display_name).join('、');
  const perPerson = Math.round(exp.amount / (exp.split_with.length || 1));
  const pendingId = `${groupId}_edit_${Date.now()}`;
  pendingExpenses[pendingId] = {
    description: exp.description, amount: exp.amount,
    sessionId: session.id, groupId,
    payerId: exp.payer_id, payerName: currentPayer?.display_name || '未知',
    splitWith: [...exp.split_with], mode: 'edit', editExpenseId: exp.id,
  };
  return client.replyMessage(event.replyToken, [
    {
      type: 'text',
      text: `✏️ 編輯第 ${index + 1} 筆\n${'─'.repeat(18)}\n📝 ${exp.description}\n💰 NT$ ${exp.amount.toLocaleString()}\n👤 付款：${currentPayer?.display_name || '未知'}\n👥 分帳：${currentSplitNames}\n💵 每人：NT$ ${perPerson}\n${'─'.repeat(18)}\n請選擇新的付款人 👇`
    },
    buildEditPayerQuickReply(pendingId, members),
  ]);
}

async function handleDeleteExpense(event, client, groupId, text) {
  const session = await getGroupActiveSession(groupId);
  if (!session) return;
  const index = parseInt(text.replace('/刪帳', '').trim()) - 1;
  if (isNaN(index) || index < 0) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '格式：/刪帳 編號' });
  }
  const expenses = await getSplitExpenses(session.id);
  if (index >= expenses.length) {
    return client.replyMessage(event.replyToken, { type: 'text', text: `❌ 找不到第 ${index + 1} 筆。` });
  }
  await deleteSplitExpense(expenses[index].id);
  return client.replyMessage(event.replyToken, {
    type: 'text', text: `🗑️ 已刪除：${expenses[index].description}（NT$ ${expenses[index].amount}）`
  });
}

async function handleListExpenses(event, client, groupId) {
  const session = await getGroupActiveSession(groupId);
  if (!session) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 沒有進行中的分帳。' });
  const [expenses, members] = await Promise.all([getSplitExpenses(session.id), getSplitMembers(groupId)]);
  if (expenses.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: `📋「${session.name}」\n尚無消費記錄。\n\n📸 傳發票 或 /加帳 描述 金額`
    });
  }
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  let msg = `📋「${session.name}」\n共 ${expenses.length} 筆　合計 NT$ ${total.toLocaleString()}\n${'─'.repeat(20)}\n`;
  msg += formatExpenseList(expenses, members);
  msg += `\n${'─'.repeat(20)}\n✏️ /編輯 編號　🗑️ /刪帳 編號\n📊 /結算 查看分帳結果`;
  return client.replyMessage(event.replyToken, { type: 'text', text: msg });
}

async function handleSettlement(event, client, groupId, closeSession) {
  const session = await getGroupActiveSession(groupId);
  if (!session) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 沒有進行中的分帳。' });
  const [expenses, members] = await Promise.all([getSplitExpenses(session.id), getSplitMembers(groupId)]);
  if (expenses.length === 0) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 尚無消費記錄。' });
  const settlement = calculateSettlement(members, expenses);
  const summaryText = formatSettlementText(session.name, members, expenses, settlement);
  if (closeSession) {
    await closeSplitSession(session.id);
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: summaryText },
      { type: 'text', text: '✅ 分帳結束！\n輸入「/開始分帳 名稱」開新的分帳。' }
    ]);
  }
  return client.replyMessage(event.replyToken, { type: 'text', text: summaryText });
}

async function handleStatus(event, client, groupId) {
  const session = await getGroupActiveSession(groupId);
  if (!session) return client.replyMessage(event.replyToken, { type: 'text', text: '沒有進行中的分帳。' });
  const [expenses, members] = await Promise.all([getSplitExpenses(session.id), getSplitMembers(groupId)]);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `📊「${session.name}」\n👥 ${members.length} 人　📝 ${expenses.length} 筆　💰 NT$ ${total.toLocaleString()}`
  });
}

// ── Quick Reply Builders ──────────────────────────────────

function buildCurrencyQuickReply(pendingId) {
  return {
    type: 'text',
    text: '👇 選擇幣別',
    quickReply: {
      items: CURRENCY_OPTIONS.map(c => ({
        type: 'action',
        action: {
          type: 'postback',
          label: c.label.slice(0, 20),
          data: `currency|${pendingId}|${c.code}`,
          displayText: `幣別：${c.label}`,
        }
      }))
    }
  };
}

function buildPayerQuickReply(pendingId, members) {
  return {
    type: 'text', text: '👇 選擇付款人',
    quickReply: {
      items: members.slice(0, 13).map(m => ({
        type: 'action',
        action: {
          type: 'postback',
          label: m.display_name.slice(0, 20),
          data: `payer|${pendingId}|${m.user_id}|${m.display_name}`,
          displayText: `付款人：${m.display_name}`
        }
      }))
    }
  };
}

function buildEditPayerQuickReply(pendingId, members) {
  return {
    type: 'text', text: '👇 選擇新付款人',
    quickReply: {
      items: members.slice(0, 13).map(m => ({
        type: 'action',
        action: {
          type: 'postback',
          label: m.display_name.slice(0, 20),
          data: `editpayer|${pendingId}|${m.user_id}|${m.display_name}`,
          displayText: `付款人改為：${m.display_name}`
        }
      }))
    }
  };
}

function buildSplitQuickReply(pendingId, members, selected) {
  const items = members.slice(0, 11).map(m => ({
    type: 'action',
    action: {
      type: 'postback',
      label: `${selected.includes(m.user_id) ? '✅' : '⬜'} ${m.display_name.slice(0, 17)}`,
      data: `toggle|${pendingId}|${m.user_id}|${m.display_name}`,
      displayText: `${selected.includes(m.user_id) ? '取消' : '選擇'}：${m.display_name}`
    }
  }));
  items.push({
    type: 'action',
    action: { type: 'postback', label: '✅ 全部均分', data: `splitall|${pendingId}`, displayText: '全部均分' }
  });
  items.push({
    type: 'action',
    action: { type: 'postback', label: '💾 確認送出', data: `confirm|${pendingId}`, displayText: '確認分帳' }
  });
  return {
    type: 'text',
    text: `👇 選擇分帳人（可多選）`,
    quickReply: { items }
  };
}

function buildHelpText() {
  return [
    '💰 分帳指令',
    '─'.repeat(18),
    '/開始分帳 名稱  ─ 開始新分帳',
    '/加帳 描述 金額 ─ 手動加入消費',
    '📸 傳發票照片   ─ 自動辨識加帳',
    '/編輯 編號      ─ 編輯記錄',
    '/刪帳 編號      ─ 刪除記錄',
    '/查看           ─ 查看所有消費',
    '/結算           ─ 查看分帳結果',
    '/結束分帳       ─ 結算並結束',
    '/狀態           ─ 目前分帳狀態',
  ].join('\n');
}

// ── Utils ─────────────────────────────────────────────────

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ── Settlement Reminder Scheduler ────────────────────────

/**
 * 每天早上 9:00 檢查所有未結算的分帳，
 * 如果超過 3 天沒有新增消費，發提醒給群組
 */
async function sendSettlementReminders(client) {
  try {
    const sessions = await getAllOpenSessions();
    const now = Date.now();
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

    for (const session of sessions) {
      try {
        const expenses = await getSplitExpenses(session.id);
        if (expenses.length === 0) continue;

        const lastExpense = expenses[expenses.length - 1];
        const lastTime    = new Date(lastExpense.created_at).getTime();

        if (now - lastTime > THREE_DAYS) {
          const total = expenses.reduce((s, e) => s + e.amount, 0);
          await client.pushMessage(session.group_id, {
            type: 'text',
            text: `💬 分帳提醒：「${session.name}」\n已有 ${expenses.length} 筆消費，合計 NT$ ${total.toLocaleString()}\n\n還沒結算嗎？輸入「/結算」查看結果，\n或「/結束分帳」完成本次分帳。`,
          });
        }
      } catch {}
    }
  } catch (err) {
    console.error('[groupHandler] 結算提醒失敗：', err.message);
  }
}

module.exports = { handleGroupEvent, sendSettlementReminders };
