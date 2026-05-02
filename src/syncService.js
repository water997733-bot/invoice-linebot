/**
 * syncService.js
 * 定時批次同步所有用戶的載具發票
 * 
 * 使用 node-cron 設定排程，每天早上 8:00 自動執行
 * 執行時會：
 *   1. 從資料庫取出所有已綁定載具的用戶
 *   2. 逐一拉取財政部 API 新發票
 *   3. 寫入資料庫（去重）
 *   4. 用 Line 通知用戶同步結果
 */

const cron = require('node-cron');
const { syncUserCarrier, summarizeByCategory } = require('./einvoice');
const { runLotteryCheck } = require('./lotteryService');
const db = require('./database');
const line = require('./lineClient'); // Line 推播用

// 防止同時有兩個同步任務在跑
let isSyncing = false;

/**
 * 同步單一使用者的載具發票
 *
 * @param {Object} user - 資料庫的 user 記錄（含 line_user_id, card_no, card_encrypt, last_sync_at）
 * @returns {{ added: number, skipped: number }}
 */
async function syncSingleUser(user) {
  const since = user.last_sync_at ? new Date(user.last_sync_at) : subtractMonths(new Date(), 3);

  let addedCount = 0;
  let skippedCount = 0;

  try {
    // 從財政部 API 拉發票
    const records = await syncUserCarrier(
      { cardNo: user.card_no, cardEncrypt: user.card_encrypt },
      since,
      (current, total) => {
        // 可選：進度 log
        if (current % 10 === 0 || current === total) {
          console.log(`[sync] ${user.line_user_id} 進度 ${current}/${total}`);
        }
      }
    );

    // 逐筆寫入資料庫，遇到重複（同一張發票號碼）就跳過
    for (const record of records) {
      const isDuplicate = await db.invoiceExists(user.line_user_id, record.invNum, record.itemName);
      if (isDuplicate) {
        skippedCount++;
        continue;
      }

      await db.insertRecord({
        lineUserId: user.line_user_id,
        source: 'carrier',
        invNum: record.invNum,
        invDate: record.invDate,
        sellerName: record.sellerName,
        itemName: record.itemName,
        quantity: record.quantity,
        unitPrice: record.unitPrice,
        amount: record.amount,
        category: record.category,
      });
      addedCount++;
    }

    // 更新最後同步時間
    await db.updateLastSyncAt(user.line_user_id, new Date());

  } catch (err) {
    console.error(`[sync] 用戶 ${user.line_user_id} 同步失敗：${err.message}`);
    throw err;
  }

  return { added: addedCount, skipped: skippedCount };
}

/**
 * 批次同步所有用戶（主要函式）
 * 
 * @param {boolean} notifyUser - 是否 Line 推播通知用戶
 */
async function syncAllUsers(notifyUser = true) {
  if (isSyncing) {
    console.log('[sync] 已有同步任務進行中，略過');
    return;
  }

  isSyncing = true;
  console.log(`[sync] 開始批次同步 ${new Date().toISOString()}`);

  try {
    const allUsers = await db.getAllCarrierUsers();
    const users = allUsers.filter(u => u.card_no); // 只同步已綁定載具的用戶
    console.log(`[sync] 共 ${users.length} 位用戶`);

    for (const user of users) {
      try {
        const { added, skipped } = await syncSingleUser(user);

        console.log(`[sync] ${user.line_user_id} 完成：新增 ${added} 筆，跳過 ${skipped} 筆`);

        // 有新發票才通知
        if (notifyUser && added > 0) {
          await sendSyncNotification(user.line_user_id, added);
        }

      } catch (err) {
        // 單一用戶失敗不影響其他用戶
        console.error(`[sync] 用戶 ${user.line_user_id} 失敗，繼續下一位`);
      }

      // 每位用戶之間等 1 秒，降低 API 壓力
      await sleep(1000);
    }

  } finally {
    isSyncing = false;
    console.log(`[sync] 批次同步完成 ${new Date().toISOString()}`);
  }
}

/**
 * 手動觸發單一用戶同步（Line 指令「同步發票」觸發）
 *
 * @param {string} lineUserId
 * @returns {string} 回傳給用戶的訊息
 */
async function manualSync(lineUserId) {
  const user = await db.getUser(lineUserId);

  if (!user || !user.card_no) {
    return '⚠️ 您尚未綁定手機條碼載具，請先輸入「綁定載具」完成設定！';
  }

  try {
    const { added, skipped } = await syncSingleUser(user);

    if (added === 0) {
      return '✅ 同步完成！目前沒有新發票。';
    }

    // 順便統計本月消費
    const thisMonthRecords = await db.getMonthRecords(lineUserId);
    const { total } = summarizeByCategory(thisMonthRecords);

    return [
      `✅ 同步完成！新增 ${added} 筆發票記錄`,
      `本月目前消費總額：NT$ ${total.toLocaleString()}`,
      '',
      '輸入「本月報表」查看消費分析 📊',
    ].join('\n');

  } catch (err) {
    if (err.code === 'INVALID_BARCODE') {
      return '❌ 手機條碼格式有誤，請重新綁定。';
    }
    return `❌ 同步失敗：${err.message}\n請稍後再試或聯絡客服。`;
  }
}

// ── 通知函式 ──────────────────────────────────────────────────

async function sendSyncNotification(lineUserId, addedCount) {
  try {
    const msg = [
      `🧾 已為您自動同步 ${addedCount} 筆新發票！`,
      '輸入「本月報表」查看消費分析 📊',
    ].join('\n');

    await line.pushMessage(lineUserId, [{ type: 'text', text: msg }]);
  } catch (err) {
    console.error(`[sync] 推播通知失敗：${err.message}`);
  }
}

// ── 排程設定 ──────────────────────────────────────────────────

/**
 * 啟動所有定時任務（台灣時區 UTC+8）
 *
 * 排程：
 *  - 每天 08:00 → 自動同步所有用戶的載具發票
 *  - 每雙月 25 日 10:00 → 自動對獎並推播通知
 *    （統一發票每雙月 25 日公布中獎號碼）
 */
function startScheduler() {
  // ① 每天 08:00 同步發票
  cron.schedule('0 0 8 * * *', () => {
    console.log('[scheduler] 觸發每日發票同步');
    syncAllUsers(true).catch(console.error);
  }, { timezone: 'Asia/Taipei' });

  // ② 每雙月（1,3,5,7,9,11 月）25 日 10:00 執行對獎
  //    cron 月份欄位：1,3,5,7,9,11 代表奇數月（台灣發票期別是雙月，25日公布上期）
  cron.schedule('0 0 10 25 1,3,5,7,9,11 *', () => {
    console.log('[scheduler] 觸發發票對獎');
    runLotteryCheck().catch(console.error);
  }, { timezone: 'Asia/Taipei' });

  console.log('[scheduler] 已啟動：每日同步 08:00、雙月對獎 25日 10:00');
}

// ── 工具 ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function subtractMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  return d;
}

module.exports = {
  startScheduler,
  syncAllUsers,
  manualSync,
  syncSingleUser,
};
