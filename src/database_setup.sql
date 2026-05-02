-- ============================================================
-- 發票記帳機器人 - Supabase 資料庫建置 SQL
-- 在 Supabase > SQL Editor 執行此檔案即可
-- ============================================================

-- 啟用 UUID 擴充
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 用戶表 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_user_id    TEXT UNIQUE NOT NULL,          -- Line 用戶 ID
  display_name    TEXT,                           -- Line 顯示名稱（可選）

  -- 載具綁定
  card_no         TEXT,                           -- 手機條碼，例如 /ABC1234
  card_encrypt    TEXT,                           -- 手機條碼驗證碼（HASH 後儲存）
  carrier_bound_at TIMESTAMPTZ,                  -- 綁定時間
  last_sync_at    TIMESTAMPTZ,                   -- 最後同步時間

  -- 設定
  monthly_budget  NUMERIC(10, 0) DEFAULT NULL,   -- 月預算（NT$）
  notify_enabled  BOOLEAN DEFAULT TRUE,           -- 是否接收同步通知

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 帳目記錄表 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_user_id    TEXT NOT NULL REFERENCES users(line_user_id) ON DELETE CASCADE,

  -- 來源
  source          TEXT NOT NULL CHECK (source IN ('carrier', 'photo', 'manual')),

  -- 發票資訊
  inv_num         TEXT,                           -- 發票號碼
  inv_date        DATE,                           -- 發票日期
  seller_name     TEXT,                           -- 商店名稱

  -- 品項
  item_name       TEXT NOT NULL,                  -- 品項名稱
  quantity        NUMERIC(10, 3) DEFAULT 1,
  unit_price      NUMERIC(10, 0) DEFAULT 0,
  amount          NUMERIC(10, 0) NOT NULL,        -- 換算後台幣金額（統計用）

  -- 外幣
  orig_amount     NUMERIC(14, 4) DEFAULT NULL,    -- 原始外幣金額（NULL = 台幣）
  orig_currency   TEXT DEFAULT NULL,              -- 幣別代碼，如 JPY / USD（NULL = TWD）
  exchange_rate   NUMERIC(12, 6) DEFAULT NULL,    -- 當時匯率（1 外幣 = ? TWD）

  -- 分類
  category        TEXT DEFAULT '其他',

  -- 備註
  note            TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 索引 ──────────────────────────────────────────────────────
-- 查詢特定用戶 + 日期範圍（月報表常用）
CREATE INDEX IF NOT EXISTS idx_records_user_date
  ON records (line_user_id, inv_date DESC);

-- 去重查詢用
CREATE INDEX IF NOT EXISTS idx_records_invnum
  ON records (line_user_id, inv_num, item_name);

-- ── 自動更新 updated_at ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Row Level Security (RLS) ──────────────────────────────────
-- 開啟 RLS，確保用戶只能存取自己的資料

ALTER TABLE users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;

-- 注意：我們的 Bot 使用 Service Role Key（有完整權限），
-- 以下 Policy 是為了防止意外使用 anon key 存取他人資料

CREATE POLICY "service_role_all_users"   ON users   FOR ALL USING (true);
CREATE POLICY "service_role_all_records" ON records FOR ALL USING (true);

-- ============================================================
-- 執行完後請在 Supabase Storage 建立名為 invoice-reports 的
-- Public Bucket（用於儲存月報表圖片）
-- ============================================================

-- ============================================================
-- ⚠️  若已有舊資料庫，只需執行以下 Migration SQL
--     （新建資料庫請忽略這段，上面已包含）
-- ============================================================
-- ALTER TABLE records
--   ADD COLUMN IF NOT EXISTS orig_amount   NUMERIC(14, 4) DEFAULT NULL,
--   ADD COLUMN IF NOT EXISTS orig_currency TEXT DEFAULT NULL,
--   ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12, 6) DEFAULT NULL;
