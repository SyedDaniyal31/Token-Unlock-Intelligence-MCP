-- External unlock calendar: TokenUnlocks / CryptoRank / other third-party schedules.
-- Used by externalUnlockIngestion and unifiedUnlockResolver. Run after base schema.

CREATE TABLE IF NOT EXISTS unlock_events_external (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol     TEXT NOT NULL,
  token_address    TEXT,
  chain_id         TEXT NOT NULL DEFAULT 'ethereum',
  unlock_timestamp TIMESTAMPTZ NOT NULL,
  amount           NUMERIC NOT NULL DEFAULT 0,
  unlock_percent   NUMERIC NOT NULL DEFAULT 0,
  category         TEXT NOT NULL DEFAULT 'unknown',
  source           TEXT NOT NULL,
  confidence       NUMERIC NOT NULL DEFAULT 50,
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_symbol, unlock_timestamp, source)
);

CREATE INDEX IF NOT EXISTS idx_unlock_events_external_token_symbol ON unlock_events_external (token_symbol);
CREATE INDEX IF NOT EXISTS idx_unlock_events_external_chain_id ON unlock_events_external (chain_id);
CREATE INDEX IF NOT EXISTS idx_unlock_events_external_unlock_timestamp ON unlock_events_external (unlock_timestamp);
COMMENT ON TABLE unlock_events_external IS 'External calendar unlocks (TokenUnlocks / CryptoRank); ingested by externalUnlockIngestion.';
