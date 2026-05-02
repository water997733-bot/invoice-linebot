// ================================================================
// report.js — 用 SVG 產生報表（不需要 canvas，Windows 完全相容）
// ================================================================
const { createClient } = require('@supabase/supabase-js');
const { getMonthlyReport } = require('./database');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CATEGORY_COLORS = {
  '餐飲': '#E74C3C',
  '交通': '#3498DB',
  '購物': '#F39C12',
  '醫療': '#2ECC71',
  '娛樂': '#9B59B6',
  '日用品': '#1ABC9C',
  '其他': '#95A5A6'
};

const CATEGORY_EMOJI = {
  '餐飲': '🍽', '交通': '🚗', '購物': '🛍',
  '醫療': '💊', '娛樂': '🎮', '日用品': '🧴', '其他': '📦'
};

// ── 產生 SVG 報表 ──────────────────────────────────────────────
function generateSVG(summary, total, date) {
  const entries = Object.entries(summary).sort((a, b) => b[1] - a[1]);
  const W = 800, H = 500;

  // 圓餅圖參數
  const cx = 220, cy = 280, r = 170;

  // 計算圓餅圖各切片
  let slices = '';
  let startAngle = -90;
  entries.forEach(([cat, amt]) => {
    const pct = amt / total;
    const angle = pct * 360;
    const endAngle = startAngle + angle;
    const large = angle > 180 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle * Math.PI / 180);
    const y1 = cy + r * Math.sin(startAngle * Math.PI / 180);
    const x2 = cx + r * Math.cos(endAngle * Math.PI / 180);
    const y2 = cy + r * Math.sin(endAngle * Math.PI / 180);
    const color = CATEGORY_COLORS[cat] || '#95A5A6';
    slices += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#1A1A2E" stroke-width="2"/>`;
    startAngle = endAngle;
  });

  // 中心圓（甜甜圈）
  slices += `<circle cx="${cx}" cy="${cy}" r="${r * 0.52}" fill="#1A1A2E"/>`;
  slices += `<text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="white" font-size="14" font-family="Arial">本月消費</text>`;
  slices += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#F1C40F" font-size="18" font-weight="bold" font-family="Arial">$${total.toLocaleString()}</text>`;

  // 圖例（右側）
  let legend = '';
  entries.forEach(([cat, amt], i) => {
    const pct = ((amt / total) * 100).toFixed(1);
    const y = 160 + i * 48;
    const color = CATEGORY_COLORS[cat] || '#95A5A6';
    const barW = Math.round((amt / total) * 240);
    legend += `
      <rect x="460" y="${y}" width="6" height="40" fill="${color}" rx="3"/>
      <text x="474" y="${y + 16}" fill="white" font-size="13" font-weight="bold" font-family="Arial">${cat}</text>
      <text x="474" y="${y + 32}" fill="${color}" font-size="12" font-family="Arial">$${amt.toLocaleString()}</text>
      <text x="740" y="${y + 24}" fill="#aaa" font-size="12" text-anchor="end" font-family="Arial">${pct}%</text>
      <rect x="474" y="${y + 36}" width="260" height="3" fill="rgba(255,255,255,0.1)" rx="1"/>
      <rect x="474" y="${y + 36}" width="${barW}" height="3" fill="${color}" rx="1"/>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1A1A2E"/>
      <stop offset="100%" stop-color="#16213E"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="20" y="15" width="${W - 40}" height="90" rx="12" fill="rgba(255,255,255,0.05)"/>
  <text x="44" y="58" fill="white" font-size="24" font-weight="bold" font-family="Arial">${date.getFullYear()} 年 ${date.getMonth() + 1} 月消費報表</text>
  <text x="44" y="90" fill="#F1C40F" font-size="20" font-weight="bold" font-family="Arial">總計：$${total.toLocaleString()}</text>
  ${slices}
  ${legend}
  <line x1="40" y1="${H - 55}" x2="${W - 40}" y2="${H - 55}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <text x="${W / 2}" y="${H - 28}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="12" font-family="Arial">發票記帳小幫手</text>
</svg>`;
}

// ── 上傳 SVG 到 Supabase Storage ───────────────────────────────
async function generateMonthlyReport(userId) {
  const now = new Date();
  const { summary, total, details } = await getMonthlyReport(
    userId, now.getFullYear(), now.getMonth() + 1
  );

  if (total === 0) throw new Error('本月尚無消費記錄');

  const svg = generateSVG(summary, total, now);
  const buffer = Buffer.from(svg, 'utf-8');
  const fileName = `reports/${userId}/${Date.now()}.svg`;

  const { error } = await supabase.storage
    .from('invoice-reports')
    .upload(fileName, buffer, {
      contentType: 'image/svg+xml',
      upsert: true
    });

  if (error) throw new Error(`圖片上傳失敗：${error.message}`);

  const { data } = supabase.storage
    .from('invoice-reports')
    .getPublicUrl(fileName);

  return { imageUrl: data.publicUrl, summary, total };
}

module.exports = { generateMonthlyReport };
