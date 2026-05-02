// ================================================================
// splitBill.js — 群組分帳核心邏輯
// ================================================================

const {
  createSplitSession,
  getSplitSession,
  addSplitExpense,
  getSplitExpenses,
  updateSplitExpense,
  closeSplitSession,
  getSplitMembers,
  addSplitMember,
  getAllOpenSessions,
} = require('./database');

// ── 計算最終分帳結果 ────────────────────────────────────────
// 輸入：每個人的「已付金額」與「應付金額」
// 輸出：最精簡的轉帳清單（最小化交易次數）
function calculateSettlement(members, expenses) {
  // Step 1：計算每人總付出 & 總應付
  const paid = {};    // 實際付了多少
  const owed = {};    // 應該付多少

  members.forEach(m => {
    paid[m.user_id] = 0;
    owed[m.user_id] = 0;
  });

  expenses.forEach(exp => {
    const { payer_id, amount, split_with, split_type, custom_splits } = exp;

    // 付款人累計付出金額
    if (paid[payer_id] !== undefined) {
      paid[payer_id] += amount;
    }

    // 計算每人應付金額
    const participants = split_with; // 陣列，包含付款人自己
    const count = participants.length;

    if (split_type === 'equal') {
      // 均分
      const share = amount / count;
      participants.forEach(uid => {
        if (owed[uid] !== undefined) owed[uid] += share;
      });

    } else if (split_type === 'custom' && custom_splits) {
      // 自訂金額
      Object.entries(custom_splits).forEach(([uid, share]) => {
        if (owed[uid] !== undefined) owed[uid] += parseFloat(share);
      });

    } else if (split_type === 'percentage' && custom_splits) {
      // 比例分攤
      Object.entries(custom_splits).forEach(([uid, pct]) => {
        if (owed[uid] !== undefined) owed[uid] += amount * (parseFloat(pct) / 100);
      });
    }
  });

  // Step 2：計算每人淨差額（正 = 別人欠他，負 = 他欠別人）
  const balance = {};
  members.forEach(m => {
    balance[m.user_id] = Math.round((paid[m.user_id] - owed[m.user_id]) * 10) / 10;
  });

  // Step 3：最小化交易次數（貪心算法）
  const creditors = []; // 別人欠他（正餘額）
  const debtors = [];   // 他欠別人（負餘額）

  Object.entries(balance).forEach(([uid, bal]) => {
    const name = members.find(m => m.user_id === uid)?.display_name || uid;
    if (bal > 0.5) creditors.push({ uid, name, amount: bal });
    else if (bal < -0.5) debtors.push({ uid, name, amount: -bal });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transfers = [];

  while (creditors.length > 0 && debtors.length > 0) {
    const creditor = creditors[0];
    const debtor = debtors[0];
    const amount = Math.min(creditor.amount, debtor.amount);
    const roundedAmount = Math.round(amount);

    if (roundedAmount > 0) {
      transfers.push({
        from: debtor.uid,
        fromName: debtor.name,
        to: creditor.uid,
        toName: creditor.name,
        amount: roundedAmount
      });
    }

    creditor.amount -= amount;
    debtor.amount -= amount;

    if (creditor.amount < 0.5) creditors.shift();
    if (debtor.amount < 0.5) debtors.shift();
  }

  return { balance, transfers, paid, owed };
}

// ── 格式化分帳摘要文字 ──────────────────────────────────────
function formatSettlementText(sessionName, members, expenses, settlement) {
  const { balance, transfers, paid, owed } = settlement;
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  let msg = `💰 【${sessionName}】分帳結算\n`;
  msg += `${'═'.repeat(22)}\n`;
  msg += `📋 共 ${expenses.length} 筆消費，總計 $${total.toLocaleString()}\n\n`;

  // 每人付出 vs 應付
  msg += `👥 各成員明細\n`;
  msg += `${'─'.repeat(22)}\n`;
  members.forEach(m => {
    const p = Math.round(paid[m.user_id] || 0);
    const o = Math.round(owed[m.user_id] || 0);
    const bal = Math.round(balance[m.user_id] || 0);
    const status = bal > 0 ? `💚 應收 $${bal}` : bal < 0 ? `🔴 應付 $${Math.abs(bal)}` : `✅ 已結清`;
    msg += `${m.display_name}\n  付出 $${p} | 應付 $${o} | ${status}\n`;
  });

  // 轉帳清單
  msg += `\n💸 轉帳清單\n`;
  msg += `${'─'.repeat(22)}\n`;
  if (transfers.length === 0) {
    msg += `✅ 所有人已結清，無需轉帳！\n`;
  } else {
    transfers.forEach((t, i) => {
      msg += `${i + 1}. ${t.fromName} → ${t.toName}\n   轉帳 $${t.amount.toLocaleString()}\n`;
    });
  }

  return msg;
}

// ── 格式化消費列表文字 ──────────────────────────────────────
function formatExpenseList(expenses, members) {
  if (expenses.length === 0) return '目前尚無消費記錄。';

  let msg = '';
  expenses.forEach((exp, i) => {
    const payer = members.find(m => m.user_id === exp.payer_id)?.display_name || '未知';
    const splitNames = exp.split_with
      .map(uid => members.find(m => m.user_id === uid)?.display_name || '未知')
      .join('、');
    msg += `${i + 1}. ${exp.description}\n`;
    msg += `   💳 付款：${payer}  $${exp.amount.toLocaleString()}\n`;
    msg += `   👥 分擔：${splitNames}\n`;
  });

  return msg.trim();
}

module.exports = {
  calculateSettlement,
  formatSettlementText,
  formatExpenseList,
};
