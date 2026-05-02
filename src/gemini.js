require('dotenv').config();

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models';
const VISION_MODEL = 'gemini-1.5-flash-001';
const TEXT_MODEL = 'gemini-1.5-flash-001';
const VALID_CATEGORIES = ['餐飲', '交通', '購物', '醫療', '娛樂', '日用品', '其他'];

const INVOICE_PROMPT = `你是台灣發票辨識專家。請分析這張發票圖片。

回傳純 JSON（不加任何說明或 markdown）：
{
  "date": "YYYY-MM-DD",
  "storeName": "商家名稱",
  "invoiceNo": "發票號碼",
  "total": 總金額數字,
  "items": [
    { "name": "品項", "amount": 金額數字, "category": "分類" }
  ]
}

分類只能用：餐飲、交通、購物、醫療、娛樂、日用品、其他
若某欄位無法辨識請填 null，items 至少要有一筆。
只回傳 JSON，不要其他任何文字。`;

async function callGemini(model, parts) {
  // 每次呼叫時重新讀取環境變數
  require('dotenv').config({ override: true });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('未設定 GEMINI_API_KEY');

  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Gemini API 錯誤 ${response.status}：${err?.error?.message || '未知錯誤'}`);
  }

  const data = await response.json();

  // 檢查是否被 safety filter 擋掉
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('Gemini 無回應');
  if (candidate.finishReason === 'SAFETY') throw new Error('圖片被安全過濾器擋住');

  const text = candidate.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 回傳空內容');
  return text.trim();
}

function cleanJson(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function detectMimeType(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  // HEIC
  if (buffer[4] === 0x66 && buffer[5] === 0x74) return 'image/heic';
  return 'image/jpeg';
}

// ── 發票辨識 ───────────────────────────────────────────────
async function analyzeInvoiceImage(imageBuffer) {
  const mimeType = detectMimeType(imageBuffer);
  const base64Image = imageBuffer.toString('base64');

  console.log(`辨識發票圖片，大小：${imageBuffer.length} bytes，類型：${mimeType}`);

  let text;
  try {
    text = await callGemini(VISION_MODEL, [
      { inline_data: { mime_type: mimeType, data: base64Image } },
      { text: INVOICE_PROMPT }
    ]);
  } catch (err) {
    console.error('Gemini 呼叫失敗：', err.message);
    throw new Error(`AI 辨識服務錯誤：${err.message}`);
  }

  console.log('Gemini 回應：', text.substring(0, 200));

  let result;
  try {
    result = JSON.parse(cleanJson(text));
  } catch {
    console.error('JSON 解析失敗，原始回應：', text);
    throw new Error('AI 無法解析發票內容，請確認照片清晰且為發票正面');
  }

  // 確保有 items
  if (!result.items || result.items.length === 0) {
    // 若沒有品項但有總金額，建立一筆總計記錄
    if (result.total && result.total > 0) {
      result.items = [{
        name: result.storeName || '消費',
        amount: result.total,
        category: '其他'
      }];
    } else {
      throw new Error('無法辨識發票品項，請確認照片清晰度');
    }
  }

  // 補總金額
  if (!result.total || result.total === 0) {
    result.total = result.items.reduce((s, i) => s + (i.amount || 0), 0);
  }

  // 確保分類合法
  result.items = result.items.map(item => ({
    ...item,
    amount: parseInt(item.amount) || 0,
    category: VALID_CATEGORIES.includes(item.category) ? item.category : '其他'
  }));

  return result;
}

// ── 單一品項分類 ───────────────────────────────────────────
async function categorizeItem(itemName) {
  try {
    const text = await callGemini(TEXT_MODEL, [{
      text: `將「${itemName}」分類到：餐飲、交通、購物、醫療、娛樂、日用品、其他。只回傳分類名稱。`
    }]);
    const category = text.trim();
    return VALID_CATEGORIES.includes(category) ? category : '其他';
  } catch {
    return '其他';
  }
}

// ── 批次分類 ───────────────────────────────────────────────
async function categorizeItemsBatch(itemNames) {
  if (itemNames.length === 0) return [];
  try {
    const text = await callGemini(TEXT_MODEL, [{
      text: `將以下品項各別分類到：餐飲、交通、購物、醫療、娛樂、日用品、其他。
回傳純 JSON 陣列，例如：["餐飲","交通"]
品項：${JSON.stringify(itemNames)}`
    }]);
    const categories = JSON.parse(cleanJson(text));
    return categories.map(c => VALID_CATEGORIES.includes(c) ? c : '其他');
  } catch {
    return itemNames.map(() => '其他');
  }
}

module.exports = { analyzeInvoiceImage, categorizeItem, categorizeItemsBatch };
