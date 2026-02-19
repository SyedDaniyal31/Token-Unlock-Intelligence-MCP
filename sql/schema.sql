-- Unlock analysis table for token unlock intelligence
-- PostgreSQL

CREATE TABLE unlock_analysis (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol            TEXT NOT NULL,
  next_unlock_date        TIMESTAMPTZ,
  unlock_amount           NUMERIC,
  unlock_percent_supply   NUMERIC,
  avg_30d_volume_usd      NUMERIC,
  unlock_vs_volume_ratio  NUMERIC,
  cohort_type             TEXT,  -- team, vc, foundation, ecosystem
  historical_avg_7d_return NUMERIC,
  impact_score            TEXT,  -- low, medium, high
  risk_summary            TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_unlock_analysis_token_symbol ON unlock_analysis (token_symbol);

COMMENT ON COLUMN unlock_analysis.cohort_type IS 'team, vc, foundation, ecosystem';
COMMENT ON COLUMN unlock_analysis.impact_score IS 'low, medium, high';
