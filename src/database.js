const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Users ─────────────────────────────────────────────────

async function getUser(lineUserId) {
  const { data, error } = await supabase
    .from('users').select('*').eq('line_user_id', lineUserId).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function upsertUser(lineUserId, fields = {}) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ line_user_id: lineUserId, ...fields }, { onConflict: 'line_user_id' })
    .select().single();
  if (error) throw error;
  return data;
}

async function saveCarrierBinding(lineUserId, cardNo, cardEncrypt) {
  return upsertUser(lineUserId, {
    card_no: cardNo, card_encrypt: cardEncrypt,
    carrier_bound_at: new Date().toISOString(), last_sync_at: null,
  });
}

async function removeCarrierBinding(lineUserId) {
  const { error } = await supabase.from('users')
    .update({ card_no: null, card_encrypt: null, carrier_bound_at: null })
    .eq('line_user_id', lineUserId);
  if (error) throw error;
}

async function updateLastSyncAt(lineUserId, date) {
  const { error } = await supabase.from('users')
    .update({ last_sync_at: date.toISOString() }).eq('line_user_id', lineUserId);
  if (error) throw error;
}

async function getAllCarrierUsers() {
  const { data, error } = await supabase.from('users')
    .select('line_user_id, card_no, card_encrypt, last_sync_at')
    .not('card_no', 'is', null);
  if (error) throw error;
  return data || [];
}

// ── Records ───────────────────────────────────────────────

async function insertRecord(record) {
  const { data, error } = await supabase.from('records').insert({
    line_user_id: record.lineUserId,
    source:        record.source,
    inv_num:       record.invNum,
    inv_date:      record.invDate,
    seller_name:   record.sellerName,
    item_name:     record.itemName,
    quantity:      record.quantity,
    unit_price:    record.unitPrice,
    amount:        record.amount,
    orig_amount:   record.origAmount   || null,
    orig_currency: record.origCurrency || null,
    exchange_rate: record.exchangeRate || null,
    category:      record.category,
    created_at:    new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

async function invoiceExists(lineUserId, invNum, itemName) {
  const { data, error } = await supabase.from('records')
    .select('id').eq('line_user_id', lineUserId)
    .eq('inv_num', invNum).eq('item_name', itemName).limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

async function getMonthRecords(lineUserId, year, month) {
  const now = new Date();
  const y = year  || now.getFullYear();
  const m = month || now.getMonth() + 1;
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate   = new Date(y, m, 0).toISOString().split('T')[0];
  const { data, error } = await supabase.from('records')
    .select('*').eq('line_user_id', lineUserId)
    .gte('inv_date', startDate).lte('inv_date', endDate)
    .order('inv_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getRecentRecords(lineUserId, limit = 10) {
  const { data, error } = await supabase.from('records')
    .select('*').eq('line_user_id', lineUserId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

async function deleteRecord(lineUserId, recordId) {
  const { error } = await supabase.from('records')
    .delete().eq('id', recordId).eq('line_user_id', lineUserId);
  if (error) throw error;
}

async function updateRecordCategory(recordId, lineUserId, newCategory) {
  const { error } = await supabase.from('records')
    .update({ category: newCategory }).eq('id', recordId).eq('line_user_id', lineUserId);
  if (error) throw error;
}

async function getInvoicesByTerm(lineUserId, invTerm) {
  const year  = parseInt(invTerm.slice(0, 3), 10) + 1911;
  const bi    = parseInt(invTerm.slice(3), 10);
  const start = `${year}-${String(bi * 2 - 1).padStart(2, '0')}-01`;
  const endMonth = bi * 2;
  const end   = new Date(year, endMonth, 0).toISOString().split('T')[0];
  const { data, error } = await supabase.from('records')
    .select('inv_num, inv_date, seller_name')
    .eq('line_user_id', lineUserId).not('inv_num', 'is', null)
    .gte('inv_date', start).lte('inv_date', end);
  if (error) throw error;
  return data || [];
}

// ── Budget ────────────────────────────────────────────────

async function setMonthlyBudget(lineUserId, amount) {
  return upsertUser(lineUserId, { monthly_budget: amount });
}

async function getMonthlyBudget(lineUserId) {
  const user = await getUser(lineUserId);
  return user?.monthly_budget || null;
}

// ── Split Sessions ────────────────────────────────────────

async function createSplitSession(groupId, creatorId, name) {
  const { data, error } = await supabase.from('split_sessions').insert({
    group_id:   groupId,
    creator_id: creatorId,
    name:       name,
    status:     'open',
    created_at: new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

async function getSplitSession(sessionId) {
  const { data, error } = await supabase.from('split_sessions')
    .select('*').eq('id', sessionId).single();
  if (error) throw error;
  return data;
}

async function getGroupActiveSession(groupId) {
  const { data, error } = await supabase.from('split_sessions')
    .select('*').eq('group_id', groupId).eq('status', 'open')
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function closeSplitSession(sessionId) {
  const { error } = await supabase.from('split_sessions')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) throw error;
}

// ── Split Members ─────────────────────────────────────────

async function getSplitMembers(groupId) {
  const { data, error } = await supabase.from('split_members')
    .select('*').eq('group_id', groupId).order('joined_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function upsertSplitMember(groupId, userId, displayName) {
  const { error } = await supabase.from('split_members')
    .upsert({ group_id: groupId, user_id: userId, display_name: displayName, joined_at: new Date().toISOString() },
      { onConflict: 'group_id,user_id' });
  if (error) throw error;
}

async function addSplitMember(groupId, userId, displayName) {
  return upsertSplitMember(groupId, userId, displayName);
}

// ── Split Expenses ────────────────────────────────────────

async function addSplitExpense(sessionId, expense) {
  const { data, error } = await supabase.from('split_expenses').insert({
    session_id:    sessionId,
    payer_id:      expense.payerId,
    description:   expense.description,
    amount:        expense.amount,
    split_with:    expense.splitWith,
    split_type:    expense.splitType || 'equal',
    custom_splits: expense.customSplits || null,
    invoice_data:  expense.invoiceData || null,
    created_at:    new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

async function getSplitExpenses(sessionId) {
  const { data, error } = await supabase.from('split_expenses')
    .select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getSplitExpenseById(expenseId) {
  const { data, error } = await supabase.from('split_expenses')
    .select('*').eq('id', expenseId).single();
  if (error) throw error;
  return data;
}

async function updateSplitExpense(expenseId, fields) {
  const { error } = await supabase.from('split_expenses')
    .update({
      payer_id:    fields.payerId,
      split_with:  fields.splitWith,
      amount:      fields.amount,
      description: fields.description,
    }).eq('id', expenseId);
  if (error) throw error;
}

async function deleteSplitExpense(expenseId) {
  const { error } = await supabase.from('split_expenses').delete().eq('id', expenseId);
  if (error) throw error;
}

async function getAllOpenSessions() {
  const { data, error } = await supabase.from('split_sessions')
    .select('*').eq('status', 'open');
  if (error) throw error;
  return data || [];
}

module.exports = {
  getUser, upsertUser, saveCarrierBinding, removeCarrierBinding,
  updateLastSyncAt, getAllCarrierUsers,
  insertRecord, invoiceExists, getMonthRecords, getRecentRecords,
  deleteRecord, updateRecordCategory, getInvoicesByTerm,
  setMonthlyBudget, getMonthlyBudget,
  createSplitSession, getSplitSession, getGroupActiveSession, closeSplitSession,
  getSplitMembers, upsertSplitMember, addSplitMember,
  addSplitExpense, getSplitExpenses, getSplitExpenseById,
  updateSplitExpense, deleteSplitExpense, getAllOpenSessions,
};
