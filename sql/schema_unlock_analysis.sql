-- Unlock analysis table (idempotent). Used by broker precompute and MCP.
CREATE TABLE IF NOT EXISTS unlock_analysis (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol            TEXT NOT NULL,
  next_unlock_date        TIMESTAMPTZ,
  unlock_amount           NUMERIC,
  unlock_percent_supply   NUMERIC,
  avg_30d_volume_usd      NUMERIC,
  unlock_vs_volume_ratio  NUMERIC,
  cohort_type             TEXT,
  historical_avg_7d_return NUMERIC,
  impact_score            TEXT,
  risk_summary            TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS unlock_analysis_token_symbol_key ON unlock_analysis (token_symbol);
