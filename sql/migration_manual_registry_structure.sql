-- Manual registry table structure: unlock_events_external.
-- Additive only: create if missing, add missing columns, create indexes.
-- Do NOT drop table or delete data.

-- 1) Create table if not exists with canonical columns
CREATE TABLE IF NOT EXISTS unlock_events_external (
  token_symbol     TEXT NOT NULL,
  unlock_timestamp BIGINT NOT NULL,
  unlock_amount    NUMERIC NOT NULL,
  unlock_percent   NUMERIC NULL,
  source           TEXT NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2) Add any missing columns when table already existed (e.g. from older migration)
ALTER TABLE unlock_events_external ADD COLUMN IF NOT EXISTS unlock_amount NUMERIC NULL;
ALTER TABLE unlock_events_external ADD COLUMN IF NOT EXISTS unlock_percent NUMERIC NULL;
ALTER TABLE unlock_events_external ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE unlock_events_external ADD COLUMN IF NOT EXISTS token_symbol TEXT;
ALTER TABLE unlock_events_external ADD COLUMN IF NOT EXISTS unlock_timestamp BIGINT;
ALTER TABLE unlock_events_external ADD COLUMN IF NOT EXISTS source TEXT;

-- 3) Composite unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_unlock_unique
ON unlock_events_external (token_symbol, unlock_timestamp);

-- 4) Performance index
CREATE INDEX IF NOT EXISTS idx_unlock_symbol
ON unlock_events_external (token_symbol);

COMMENT ON TABLE unlock_events_external IS 'Manual/curated unlock events; consumed by ManualRegistry provider.';
