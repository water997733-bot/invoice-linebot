/**
 * claude.js（Gemini Vision 版）
 * 使用 Google Gemini 2.5 Flash-Lite 辨識發票圖片
 *
 * 免費方案限制（Gemini 2.5 Flash-Lite）：
 *   每分鐘：15 次
 *   每天：1,000 次
 *   完全免費，無需信用卡
 *
 * API Key 申請：https://aistudio.google.com/app/apikey
 */

const { categorize } = require('./einvoice');
const { convertToTWD } = require('./currencyService');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const VISION_MODEL   = 'gemini-2.0-flash';

const INVOICE_PROMPT = `你是台灣發票辨識專家。請仔細分析這張發票或收據圖片。

只回傳純 JSON，不要加任何說明文字或 markdown backtick：

{
  "sellerName": "商家名稱（無法辨識填空字串）",
  "invDate": "發票日期，格式 YYYY-MM-DD（無法辨識填今天）",
  "invNum": "發票號碼，例如 AB12345678（無則填 null）",
  "currency": "幣別代碼：台幣填 TWD，日圓填 JPY，美元填 USD，歐元填 EUR，韓元填 KRW，以此類推",
  "totalAmount": 總金額數字（不含符號和逗號）,
  "items": [
    {
      "name": "品項名稱",
      "quantity": 數量（預設 1）,
      "unitPrice": 單價數字,
      "amount": 小計金額數字
    }
  ]
}

注意事項：
- 若有多個品項請全部列出
- 若只看到合計看不到明細，items 填一筆，name 填商家名稱
- 民國年請自動換算成西元（民國 114 年 = 西元 2025 年）
- 國外收據請填正確幣別代碼
- 金額填數字，不含貨幣符號或逗號
- items 至少要有一筆，無法辨識也要填
- 只回傳 JSON，不要其他任何文字`;

async function callGemini(parts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('未設定 GEMINI_API_KEY，請在 .env 加入');

  const url = `${GEMINI_API_URL}/${VISION_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429) {
      throw new Error('Gemini 免費額度暫時用完，請稍後再試（每分鐘最多 15 次）');
    }
    throw new Error(`Gemini API 錯誤 ${res.status}：${err?.error?.message || '未知錯誤'}`);
  }

  const data     = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('Gemini 沒有回傳結果，請重試');
  if (candidate.finishReason === 'SAFETY') throw new Error('圖片被安全過濾器擋住，請確認是真實發票照片');

  return candidate.content?.parts?.[0]?.text || '';
}

async function analyzeInvoiceImage(imageBuffer, mimeType = 'image/jpeg') {
  const base64Image = imageBuffer.toString('base64');
  const rawText = await callGemini([
    { inline_data: { mime_type: mimeType, data: base64Image } },
    { text: INVOICE_PROMPT },
  ]);
  return parseGeminiResponse(rawText);
}

async function parseGeminiResponse(rawText) {
  const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('無法解析辨識結果，請重試或改用手動記帳');
  }

  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('無法辨識發票品項，請確認圖片清晰且完整');
  }

  const currency = data.currency || 'TWD';
  const today    = new Date().toISOString().split('T')[0];
  let exchangeRate = null;
  let twdTotal     = parseFloat(data.totalAmount) || 0;

  if (currency !== 'TWD' && data.totalAmount) {
    try {
      const result = await convertToTWD(parseFloat(data.totalAmount), currency);
      twdTotal     = result.twd;
      exchangeRate = result.rate;
    } catch { /* 匯率失敗保留原值 */ }
  }

  const items = data.items.map(item => {
    const origAmt = parseFloat(item.amount) || 0;
    const itemTWD = currency !== 'TWD' && exchangeRate
      ? Math.round(origAmt * exchangeRate)
      : Math.round(origAmt);
    return {
      name:         item.name || '消費',
      quantity:     parseFloat(item.quantity) || 1,
      unitPrice:    currency !== 'TWD' && exchangeRate
        ? Math.round((parseFloat(item.unitPrice) || origAmt) * exchangeRate)
        : Math.round(parseFloat(item.unitPrice) || origAmt),
      amount:       itemTWD,
      origAmount:   currency !== 'TWD' ? origAmt   : null,
      origCurrency: currency !== 'TWD' ? currency  : null,
      exchangeRate: currency !== 'TWD' ? exchangeRate : null,
      category:     categorize(data.sellerName || '', item.name || ''),
    };
  });

  return {
    sellerName:  data.sellerName || '',
    invDate:     data.invDate    || today,
    invNum:      data.invNum     || null,
    currency,
    totalAmount: Math.round(twdTotal),
    origTotal:   currency !== 'TWD' ? parseFloat(data.totalAmount) : null,
    exchangeRate,
    items,
  };
}

function detectMimeType(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

module.exports = { analyzeInvoiceImage, detectMimeType };
