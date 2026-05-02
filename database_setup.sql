-- ================================================================
-- 發票記帳 Line Bot - Supabase 資料庫建置腳本
-- 請在 Supabase > SQL Editor 中執行此檔案
-- ================================================================

-- ── 用戶資料表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  line_user_id    VARCHAR(50)  UNIQUE NOT NULL,
  carrier_code    VARCHAR(20)  DEFAULT NULL,        -- 手機條碼 /XXXXXXX
  monthly_budget  INTEGER      DEFAULT 0,            -- 月預算（元）
  last_sync_at    TIMESTAMP    DEFAULT NULL,         -- 最後同步時間
  created_at      TIMESTAMP    DEFAULT NOW(),
  updated_at      TIMESTAMP    DEFAULT NOW()
);

-- ── 消費記錄資料表 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id            UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  line_user_id  VARCHAR(50)   NOT NULL,
  date          DATE          NOT NULL,
  store_name    VARCHAR(200)  DEFAULT NULL,
  item_name     VARCHAR(300)  NOT NULL,
  amount        INTEGER       NOT NULL DEFAULT 0,
  category      VARCHAR(20)   NOT NULL DEFAULT '其他',
  invoice_no    VARCHAR(20)   DEFAULT NULL,
  source        VARCHAR(10)   DEFAULT 'photo',      -- 'photo' | 'carrier' | 'manual'
  created_at    TIMESTAMP     DEFAULT NOW(),

  -- 防止同一張發票同一品項重複匯入
  UNIQUE (line_user_id, invoice_no, item_name)
);

-- ── 索引（加速查詢）─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_expenses_user_date
  ON expenses(line_user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_user_category
  ON expenses(line_user_id, category);

CREATE INDEX IF NOT EXISTS idx_expenses_invoice_no
  ON expenses(invoice_no);

-- ── RLS 安全策略（Row Level Security）──────────────────────
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- 允許 Service Role 完整存取（後端 API 使用）
CREATE POLICY "service_role_users"    ON users    FOR ALL USING (true);
CREATE POLICY "service_role_expenses" ON expenses FOR ALL USING (true);

-- ── Storage Bucket（存放報表圖片）──────────────────────────
-- 請在 Supabase Storage 中手動建立名為 "invoice-reports" 的 Bucket
-- 並設定為 Public（讓 Line 可以顯示圖片）

-- ── 測試資料（可選，測試完請刪除）────────────────────────
/*
INSERT INTO users (line_user_id, carrier_code, monthly_budget)
VALUES ('U_TEST_USER_123', '/ABC1234', 30000);

INSERT INTO expenses (line_user_id, date, store_name, item_name, amount, category, source)
VALUES
  ('U_TEST_USER_123', CURRENT_DATE, '全家便利商店', '御飯糰', 35, '餐飲', 'photo'),
  ('U_TEST_USER_123', CURRENT_DATE, '全家便利商店', '拿鐵咖啡', 55, '餐飲', 'photo'),
  ('U_TEST_USER_123', CURRENT_DATE, '台北捷運', '捷運票', 30, '交通', 'carrier'),
  ('U_TEST_USER_123', CURRENT_DATE - 2, 'UNIQLO', '短袖上衣', 590, '購物', 'carrier');
*/

-- ── 查詢範例 ─────────────────────────────────────────────
/*
-- 本月消費統計
SELECT category, SUM(amount) as total
FROM expenses
WHERE line_user_id = 'YOUR_LINE_USER_ID'
  AND date >= DATE_TRUNC('month', CURRENT_DATE)
GROUP BY category
ORDER BY total DESC;

-- 各日消費趨勢
SELECT date, SUM(amount) as daily_total
FROM expenses
WHERE line_user_id = 'YOUR_LINE_USER_ID'
  AND date >= DATE_TRUNC('month', CURRENT_DATE)
GROUP BY date
ORDER BY date;
*/
