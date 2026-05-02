/**
 * lotteryService.js
 * 發票對獎服務
 *
 * 流程：
 *  1. 每期開獎後（雙月 25 日）自動執行
 *  2. 從資料庫取出該期所有用戶發票
 *  3. 呼叫財政部 API 取得中獎號碼
 *  4. 逐一比對，中獎者 Line 推播通知
 *
 * 中獎等級（統一發票）：
 *  - 特別獎：10,000,000（完整 8 碼相符）
 *  - 特獎：  2,000,000（完整 8 碼相符）
 *  - 頭獎：    200,000（完整 8 碼相符，多組）
 *  - 二獎：     40,000（後 7 碼相符）
 *  - 三獎：     10,000（後 6 碼相符）
 *  - 四獎：      4,000（後 5 碼相符）
 *  - 五獎：      1,000（後 4 碼相符）
 *  - 六獎：        200（後 3 碼相符）
 *  - 增開六獎：    200（後 3 碼，固定號碼）
 */

const { getWinningNumbers, getCurrentInvTerm } = require('./einvoice');
const db     = require('./database');
const client = require('./lineClient');

// ── 對獎核心邏輯 ─────────────────────────────────────────────

/**
 * 比對單張發票是否中獎
 *
 * @param {string} invNum      - 發票號碼（8碼數字部分，不含英文前綴）
 * @param {Object} winningNums - getWinningNumbers() 回傳的中獎號碼物件
 * @returns {{ prize: string, amount: number } | null}
 */
function checkSingleInvoice(invNum, winningNums) {
  // 發票號碼只取數字部分（去除前兩碼英文，例如 AB12345678 → 12345678）
  const num = invNum.replace(/^[A-Z]{2}/, '').trim();

  if (num.length !== 8) return null;

  const { superPrize, grandPrize, firstPrizeList = [], additionalSixth } = winningNums;

  // 特別獎（1000 萬）
  if (superPrize && num === superPrize) {
    return { prize: '特別獎', amount: 10_000_000 };
  }

  // 特獎（200 萬）
  if (grandPrize && num === grandPrize) {
    return { prize: '特獎', amount: 2_000_000 };
  }

  // 頭獎及各子獎（頭獎 20 萬，後幾碼相符遞減）
  for (const firstNum of firstPrizeList) {
    if (!firstNum) continue;

    const result = matchFirstPrizeTiers(num, firstNum);
    if (result) return result;
  }

  // 增開六獎（200 元，固定後 3 碼）
  if (additionalSixth && num.slice(-3) === additionalSixth.slice(-3)) {
    return { prize: '增開六獎', amount: 200 };
  }

  return null; // 未中獎
}

/**
 * 比對頭獎號碼的各層獎項（頭獎到六獎）
 */
function matchFirstPrizeTiers(invNum, firstPrizeNum) {
  const tiers = [
    { suffix: 8, prize: '頭獎', amount: 200_000 },
    { suffix: 7, prize: '二獎', amount:  40_000 },
    { suffix: 6, prize: '三獎', amount:  10_000 },
    { suffix: 5, prize: '四獎', amount:   4_000 },
    { suffix: 4, prize: '五獎', amount:   1_000 },
    { suffix: 3, prize: '六獎', amount:     200 },
  ];

  for (const tier of tiers) {
    if (invNum.slice(-tier.suffix) === firstPrizeNum.slice(-tier.suffix)) {
      return { prize: tier.prize, amount: tier.amount };
    }
  }

  return null;
}

// ── 主要對獎流程 ──────────────────────────────────────────────

/**
 * 執行本期全體對獎並推播通知
 * 由 syncService 的排程呼叫
 *
 * @param {string} invTerm - 發票期別（選填，預設取上一期）
 */
async function runLotteryCheck(invTerm) {
  const term = invTerm || getCurrentInvTerm();
  console.log(`[lottery] 開始對獎，期別：${term}`);

  // Step 1: 取得本期中獎號碼
  let winningNums;
  try {
    winningNums = await getWinningNumbers(term);
  } catch (err) {
    console.error(`[lottery] 取得中獎號碼失敗：${err.message}`);
    return;
  }

  if (!winningNums || !winningNums.superPrize) {
    console.log('[lottery] 本期尚未開獎，略過');
    return;
  }

  console.log(`[lottery] 特別獎：${winningNums.superPrize}，特獎：${winningNums.grandPrize}`);

  // Step 2: 取出所有本期有發票的用戶
  const users = await db.getAllCarrierUsers();
  let totalWinners = 0;

  for (const user of users) {
    try {
      const winners = await checkUserInvoices(user.line_user_id, term, winningNums);
      if (winners.length > 0) {
        totalWinners++;
        await sendWinningNotification(user.line_user_id, winners, term);
      } else {
        await sendNoWinningNotification(user.line_user_id, term);
      }
      // 避免推播過快
      await sleep(500);
    } catch (err) {
      console.error(`[lottery] 用戶 ${user.line_user_id} 對獎失敗：${err.message}`);
    }
  }

  console.log(`[lottery] 對獎完成，${totalWinners} 位用戶中獎，${users.length - totalWinners} 位未中獎`);
}

/**
 * 對單一用戶的所有本期發票進行比對
 *
 * @returns {Array} 中獎發票清單 [{ invNum, sellerName, prize, amount }]
 */
async function checkUserInvoices(lineUserId, invTerm, winningNums) {
  // 取出該期所有有發票號碼的記錄（去重，同一張發票只對一次）
  const records = await db.getInvoicesByTerm(lineUserId, invTerm);

  // 用 Set 去除同一張發票的重複品項
  const seen = new Set();
  const winners = [];

  for (const record of records) {
    if (!record.inv_num || seen.has(record.inv_num)) continue;
    seen.add(record.inv_num);

    const result = checkSingleInvoice(record.inv_num, winningNums);
    if (result) {
      winners.push({
        invNum:     record.inv_num,
        invDate:    record.inv_date,
        sellerName: record.seller_name || '',
        prize:      result.prize,
        amount:     result.amount,
      });
    }
  }

  return winners;
}

// ── 推播通知 ──────────────────────────────────────────────────

// 中獎隨機開場白（依獎項金額決定激動程度）
const WIN_OPENERS = {
  big: [  // 頭獎以上
    '我的天啊！！！你中大獎了！！！',
    '快打給媽媽！你他媽中頭獎了！！！',
    '不要懷疑，這不是詐騙，你真的中了！',
    '人生的轉折點就在今天，快去兌獎！！',
  ],
  small: [  // 二獎到六獎
    '哇！有中！雖然不多，但有中就是贏！',
    '小確幸來了！快去把錢換回來！',
    '這期你是幸運兒，記得去兌獎喔！',
    '天無絕人之路，你中獎啦！',
  ],
};

// 未中獎隨機嘲諷
const LOSE_TAUNTS = [
  '很遺憾，這期你的發票跟中獎號碼八竿子打不著。',
  '對獎結果：0 元。繼續消費，繼續夢想。',
  '號碼對了嗎？沒有。下次繼續努力。',
  '系統查詢完畢，您這期的貢獻是：白花花的消費，沒有任何回報。',
  '好消息：你的發票都有乖乖收進來。壞消息：一張都沒中。',
  '中獎這件事，跟你這期暫時無緣。',
  '你的錢包：空了。中獎號碼：跟你無關。加油！',
  '財神爺這期跳過你了，但別擔心，下期說不定也跳過。',
  '唉，差一點。（其實完全不差一點）',
  '本系統偵測到你這期的財運停留在「正常消費，正常沒中」的區間。',
];

// 中獎結尾鼓勵
const WIN_CLOSERS = [
  '快去把獎金換回來，你值得的！',
  '這筆錢去吃頓好的，犒賞自己！',
  '去兌獎！去兌獎！別放到過期！',
];

// 未中獎結尾嘲諷
const LOSE_CLOSERS = [
  '下期繼續，反正你也會繼續花錢。',
  '安慰獎：至少你記帳很勤勞。',
  '沒關係，下期特別獎是你的（可能）。',
  '繼續買東西，繼續做夢，這就是人生。',
  '統一發票的錢去哪了？去社福基金了。不客氣。',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 傳送中獎通知給用戶（開心版）
 */
async function sendWinningNotification(lineUserId, winners, invTerm) {
  const termLabel  = formatInvTerm(invTerm);
  const totalAmount = winners.reduce((sum, w) => sum + w.amount, 0);
  const isBig      = winners.some(w => w.amount >= 200_000);
  const opener     = pickRandom(isBig ? WIN_OPENERS.big : WIN_OPENERS.small);
  const closer     = pickRandom(WIN_CLOSERS);

  const lines = [
    `🎊🎊🎊 ${opener}`,
    `期別：${termLabel}`,
    '─────────────────',
  ];

  for (const w of winners) {
    const medal = w.amount >= 2_000_000 ? '👑' : w.amount >= 200_000 ? '🥇' : w.amount >= 1_000 ? '🥈' : '🥉';
    lines.push(`${medal}【${w.prize}】NT$ ${w.amount.toLocaleString()}`);
    lines.push(`　${w.invNum}　${w.sellerName || '（商店）'}`);
    lines.push(`　消費日期：${w.invDate}`);
  }

  lines.push('─────────────────');
  lines.push(`💰 合計中獎：NT$ ${totalAmount.toLocaleString()}`);
  lines.push('');
  lines.push(`👉 ${closer}`);
  lines.push('');
  lines.push('📍 兌獎方式');
  lines.push('・200 元 → 超商、郵局、銀行均可兌');
  lines.push('・1,000 元以上 → 憑身分證至銀行兌領');
  lines.push('・⚠️ 兌獎期限：開獎後 3 個月，過期廢止！');

  await client.pushMessage(lineUserId, [{ type: 'text', text: lines.join('\n') }]);
}

/**
 * 傳送未中獎通知給用戶（嘲諷版）
 */
async function sendNoWinningNotification(lineUserId, invTerm) {
  const termLabel = formatInvTerm(invTerm);
  const taunt     = pickRandom(LOSE_TAUNTS);
  const closer    = pickRandom(LOSE_CLOSERS);

  const text = [
    `📋 ${termLabel} 對獎結果`,
    '─────────────────',
    `😐 ${taunt}`,
    '',
    `💬 ${closer}`,
  ].join('\n');

  await client.pushMessage(lineUserId, [{ type: 'text', text }]);
}

// ── 工具函式 ──────────────────────────────────────────────────

/**
 * 格式化期別顯示，例如 11401 → 114年01-02月
 */
function formatInvTerm(invTerm) {
  if (!invTerm || invTerm.length < 5) return invTerm;
  const year  = invTerm.slice(0, 3);
  const bi    = parseInt(invTerm.slice(3), 10); // 雙月序號
  const start = String(bi * 2 - 1).padStart(2, '0');
  const end   = String(bi * 2).padStart(2, '0');
  return `${year}年${start}-${end}月`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  runLotteryCheck,
  checkSingleInvoice,
  formatInvTerm,
};
