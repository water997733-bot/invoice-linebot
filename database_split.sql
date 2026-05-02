-- ============================================================
-- 分帳功能 Migration SQL
-- 在 Supabase SQL Editor 執行此檔案
-- ============================================================

-- 分帳 Session 表
CREATE TABLE IF NOT EXISTS split_sessions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id   TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  status     TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_split_sessions_group ON split_sessions (group_id, status);

-- 群組成員表
CREATE TABLE IF NOT EXISTS split_members (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_split_members_group ON split_members (group_id);

-- 消費記錄表
CREATE TABLE IF NOT EXISTS split_expenses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    UUID NOT NULL REFERENCES split_sessions(id) ON DELETE CASCADE,
  payer_id      TEXT NOT NULL,
  description   TEXT NOT NULL,
  amount        NUMERIC(10, 0) NOT NULL,
  split_with    TEXT[] NOT NULL DEFAULT '{}',
  split_type    TEXT DEFAULT 'equal' CHECK (split_type IN ('equal', 'custom')),
  custom_splits JSONB,
  invoice_data  JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_split_expenses_session ON split_expenses (session_id, created_at);

-- RLS
ALTER TABLE split_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE split_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE split_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_split_sessions" ON split_sessions FOR ALL USING (true);
CREATE POLICY "service_split_members"  ON split_members  FOR ALL USING (true);
CREATE POLICY "service_split_expenses" ON split_expenses FOR ALL USING (true);
