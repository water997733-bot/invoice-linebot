# 🧾 發票記帳 Line Bot

透過 AI 辨識發票、串接電子載具，自動記錄並分析您的每月消費。

## ✨ 功能特色

| 功能 | 說明 |
|------|------|
| 📸 拍照辨識 | 拍攝實體發票，Claude Vision AI 自動辨識品項與金額 |
| 🔗 載具串接 | 綁定手機條碼，自動同步電子發票 |
| 🤖 智慧分類 | AI 自動將消費分類（餐飲、交通、購物…） |
| 📊 月度報表 | 彩色圓餅圖呈現消費比例 |
| 💰 預算提醒 | 設定月預算，超標時主動通知 |
| 🔄 定時同步 | 每天早上 8 點自動同步所有用戶載具發票 |

---

## 🚀 快速開始

### 步驟一：申請必要服務

1. **Line Developers**（https://developers.line.biz/）
   - 建立 Messaging API Channel
   - 記下 `Channel Secret` 與 `Channel Access Token`

2. **Anthropic API**（https://console.anthropic.com/）
   - 建立 API Key

3. **財政部電子發票 API**（https://www.einvoice.nat.gov.tw/）
   - 廠商專區 > 申請 API 金鑰
   - 記下 `appID` 與 `apiKey`

4. **Supabase**（https://supabase.com/）
   - 建立新專案
   - 記下 Project URL 與 anon key

### 步驟二：設定環境變數

```bash
cp .env.example .env
# 編輯 .env 填入所有金鑰
```

### 步驟三：建立資料庫

登入 Supabase > SQL Editor，貼上並執行 `database_setup.sql` 的內容。

然後到 Storage 建立名為 `invoice-reports` 的公開 Bucket。

### 步驟四：安裝與啟動

```bash
npm install
npm run dev
```

### 步驟五：設定 Webhook

```bash
# 另開終端機
npx ngrok http 3000
```

將 ngrok 提供的網址填入 Line Developers > Webhook URL：
```
https://xxxx.ngrok.io/webhook
```

---

## 📁 專案結構

```
invoice-linebot/
├── src/
│   ├── index.js          # 主程式（Express + 定時任務）
│   ├── lineHandler.js    # Line 事件處理（訊息、圖片、Postback）
│   ├── claude.js         # Claude Vision 發票辨識 & 分類
│   ├── einvoice.js       # 財政部電子發票 API
│   ├── database.js       # Supabase 資料庫操作
│   ├── report.js         # Canvas 報表圖片生成
│   └── syncService.js    # 載具定時同步服務
├── database_setup.sql    # 資料庫建置 SQL
├── .env.example          # 環境變數範本
└── package.json
```

---

## 💬 Line Bot 指令

| 指令 | 功能 |
|------|------|
| 傳送圖片 | 拍照辨識發票 |
| `綁定載具` | 開始綁定手機條碼流程 |
| `/XXXXXXX` | 直接輸入手機條碼完成綁定 |
| `同步發票` | 手動觸發載具發票同步 |
| `本月報表` | 查看本月消費圓餅圖 |
| `預算 30000` | 設定月預算為 30,000 元 |
| `說明` | 查看使用說明 |

---

## ☁️ 部署到 Railway

1. 將專案推上 GitHub
2. 到 [Railway](https://railway.app/) 建立新專案
3. 選擇「Deploy from GitHub repo」
4. 在 Variables 頁面填入所有環境變數
5. 部署完成後取得網址，更新 Line Webhook URL

---

## 🔧 技術棧

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Line SDK**: @line/bot-sdk
- **AI**: Claude Vision API (claude-opus-4-5)
- **AI 分類**: Claude Haiku (claude-haiku-4-5-20251001)
- **資料庫**: Supabase (PostgreSQL)
- **圖表**: node-canvas
- **定時任務**: node-cron
- **外部 API**: 財政部電子發票整合服務平台

---

## ⚠️ 注意事項

- 手機條碼屬於個人敏感資訊，請確保 Supabase RLS 設定正確
- 財政部 API 有呼叫頻率限制，同步時已加入延遲機制
- 報表圖片上傳至 Supabase Storage，請確認 Bucket 設為 Public
