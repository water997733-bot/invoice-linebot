/**
 * currencyService.js
 * 即時匯率查詢與換算服務
 *
 * 使用 exchangerate-api.com 免費方案
 * 免費額度：1,500 次/月（足夠使用）
 * API Key 存在 .env 的 EXCHANGE_RATE_API_KEY
 *
 * 支援幣別（常見出國地點）：
 *   TWD, USD, JPY, EUR, KRW, HKD, GBP,
 *   AUD, SGD, THB, MYR, VND, CNY, CAD
 */

const axios = require('axios');

// ── 常數 ──────────────────────────────────────────────────────

const SUPPORTED_CURRENCIES = {
  TWD: { name: '台幣',   symbol: 'NT$' },
  USD: { name: '美元',   symbol: '$'   },
  JPY: { name: '日圓',   symbol: '¥'   },
  EUR: { name: '歐元',   symbol: '€'   },
  KRW: { name: '韓元',   symbol: '₩'   },
  HKD: { name: '港幣',   symbol: 'HK$' },
  GBP: { name: '英鎊',   symbol: '£'   },
  AUD: { name: '澳幣',   symbol: 'A$'  },
  SGD: { name: '新加坡幣', symbol: 'S$' },
  THB: { name: '泰銖',   symbol: '฿'   },
  MYR: { name: '馬來幣', symbol: 'RM'  },
  VND: { name: '越南盾', symbol: '₫'   },
  CNY: { name: '人民幣', symbol: '¥'   },
  CAD: { name: '加幣',   symbol: 'C$'  },
};

// 匯率快取（避免每筆記帳都打 API）
const rateCache = {
  rates: null,       // { USD: 32.5, JPY: 0.21, ... } （對 TWD）
  fetchedAt: null,   // 上次更新時間
  TTL: 60 * 60 * 1000, // 快取 1 小時
};

// ── 匯率查詢 ──────────────────────────────────────────────────

/**
 * 取得目前匯率（以 TWD 為基準，其他幣別換算成 TWD）
 * 有快取機制，1 小時內不重複打 API
 */
async function getRates() {
  const now = Date.now();

  // 快取有效
  if (rateCache.rates && rateCache.fetchedAt && (now - rateCache.fetchedAt) < rateCache.TTL) {
    return rateCache.rates;
  }

  try {
    const apiKey = process.env.EXCHANGE_RATE_API_KEY;

    // 若沒有 API Key，使用內建備用匯率（固定值，僅作兜底）
    if (!apiKey) {
      console.warn('[currency] 未設定 EXCHANGE_RATE_API_KEY，使用備用匯率');
      return getFallbackRates();
    }

    // 以 TWD 為基準，查詢所有幣別匯率
    const res = await axios.get(
      `https://v6.exchangerate-api.com/v6/${apiKey}/latest/TWD`,
      { timeout: 5000 }
    );

    if (res.data.result !== 'success') {
      throw new Error('API 回傳錯誤');
    }

    // 轉換成「1 外幣 = ? TWD」格式，方便換算
    const rawRates = res.data.conversion_rates; // 1 TWD = ? 各幣別
    const rates = {};
    for (const [currency] of Object.entries(SUPPORTED_CURRENCIES)) {
      if (currency === 'TWD') {
        rates['TWD'] = 1;
      } else if (rawRates[currency]) {
        // 1 TWD = rawRates[currency] 外幣
        // → 1 外幣 = 1 / rawRates[currency] TWD
        rates[currency] = parseFloat((1 / rawRates[currency]).toFixed(4));
      }
    }

    rateCache.rates = rates;
    rateCache.fetchedAt = now;
    console.log(`[currency] 匯率已更新：1 USD = ${rates['USD']} TWD`);
    return rates;

  } catch (err) {
    console.error(`[currency] 匯率查詢失敗：${err.message}，使用備用匯率`);
    return getFallbackRates();
  }
}

/**
 * 將外幣金額換算成台幣
 *
 * @param {number} amount   - 外幣金額
 * @param {string} currency - 幣別代碼，如 'JPY'
 * @returns {{ twd: number, rate: number }}
 */
async function convertToTWD(amount, currency) {
  if (currency === 'TWD') return { twd: amount, rate: 1 };

  const rates = await getRates();
  const rate  = rates[currency];

  if (!rate) throw new Error(`不支援的幣別：${currency}`);

  const twd = Math.round(amount * rate);
  return { twd, rate };
}

/**
 * 備用匯率（API 無法連線時使用，定期手動更新）
 */
function getFallbackRates() {
  return {
    TWD: 1,
    USD: 32.5,
    JPY: 0.21,
    EUR: 35.2,
    KRW: 0.024,
    HKD: 4.16,
    GBP: 41.0,
    AUD: 21.0,
    SGD: 24.0,
    THB: 0.90,
    MYR: 7.20,
    VND: 0.0013,
    CNY: 4.50,
    CAD: 23.5,
  };
}

// ── 輸入解析 ──────────────────────────────────────────────────

/**
 * 從輸入字串中解析幣別代碼
 * 支援：
 *   「午餐 JPY 1200」
 *   「午餐 1200 JPY」
 *   「午餐 ¥1200」
 *   「午餐 $50 USD」
 *
 * @returns {{ currency: string, cleanedText: string } | null}
 */
function parseCurrency(text) {
  // 符號對應表
  const symbolMap = {
    '¥': 'JPY',   // 注意：¥ 也可能是 CNY，優先 JPY（日本較常見）
    '€': 'EUR',
    '£': 'GBP',
    '₩': 'KRW',
    '฿': 'THB',
    '₫': 'VND',
  };

  // 先試符號（例如 ¥1200）
  for (const [symbol, currency] of Object.entries(symbolMap)) {
    if (text.includes(symbol)) {
      const cleaned = text.replace(symbol, '').trim();
      return { currency, cleanedText: cleaned };
    }
  }

  // 再試三碼幣別代碼（不分大小寫）
  const upperText = text.toUpperCase();
  for (const currency of Object.keys(SUPPORTED_CURRENCIES)) {
    if (currency === 'TWD') continue; // TWD 是預設，不需特別標記
    // 獨立的幣別代碼（前後是空白或字串頭尾）
    const regex = new RegExp(`(?:^|\\s)${currency}(?:\\s|$)`);
    if (regex.test(upperText)) {
      const cleaned = text.replace(new RegExp(currency, 'gi'), '').trim();
      return { currency, cleanedText: cleaned };
    }
  }

  return null; // 沒有外幣標記，視為台幣
}

// ── 顯示工具 ──────────────────────────────────────────────────

/**
 * 格式化金額顯示
 * 例如：「¥ 1,200（約 NT$ 252）」
 */
function formatAmount(origAmount, origCurrency, twdAmount) {
  const info = SUPPORTED_CURRENCIES[origCurrency];
  if (!info || origCurrency === 'TWD') {
    return `NT$ ${twdAmount.toLocaleString()}`;
  }

  const symbol = info.symbol;
  const origFormatted = Number.isInteger(origAmount)
    ? origAmount.toLocaleString()
    : origAmount.toFixed(2);

  return `${symbol} ${origFormatted}（≈ NT$ ${twdAmount.toLocaleString()}）`;
}

/**
 * 取得幣別名稱，例如 JPY → 「日圓」
 */
function getCurrencyName(code) {
  return SUPPORTED_CURRENCIES[code]?.name || code;
}

/**
 * 列出支援的幣別（給說明訊息用）
 */
function getSupportedCurrencyList() {
  return Object.entries(SUPPORTED_CURRENCIES)
    .filter(([code]) => code !== 'TWD')
    .map(([code, info]) => `${code}（${info.name}）`)
    .join('、');
}

module.exports = {
  getRates,
  convertToTWD,
  parseCurrency,
  formatAmount,
  getCurrencyName,
  getSupportedCurrencyList,
  SUPPORTED_CURRENCIES,
};
