-- Cluster-level exchange intelligence: aggregation table + flow columns

-- New table: cluster-level flow aggregation (upsert per run)
CREATE TABLE IF NOT EXISTS cluster_flow_aggregation (
  cluster_tag         TEXT NOT NULL,
  token_symbol        TEXT NOT NULL,
  total_inflow        NUMERIC NOT NULL DEFAULT 0,
  total_outflow       NUMERIC NOT NULL DEFAULT 0,
  first_seen_block    BIGINT,
  last_seen_block     BIGINT,
  last_updated        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_tag, token_symbol)
);

CREATE INDEX IF NOT EXISTS idx_cluster_flow_cluster ON cluster_flow_aggregation (cluster_tag);
CREATE INDEX IF NOT EXISTS idx_cluster_flow_token ON cluster_flow_aggregation (token_symbol);

COMMENT ON TABLE cluster_flow_aggregation IS 'Cluster-level flow: total_inflow/outflow per cluster_tag and token_symbol';

-- Extend unlock_flow_analysis (do not break existing schema)
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS cluster_tag TEXT;
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS velocity_score NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS cluster_concentration_ratio NUMERIC;
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS routed_to_exchange BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN unlock_flow_analysis.cluster_tag IS 'Recipient exchange cluster tag';
COMMENT ON COLUMN unlock_flow_analysis.velocity_score IS '0-1; high when 2+ transfers to exchange in 6 blocks or 10 min';
COMMENT ON COLUMN unlock_flow_analysis.cluster_concentration_ratio IS 'unlock_flow_to_cluster / total_claimed; >0.6 = high concentration';
COMMENT ON COLUMN unlock_flow_analysis.routed_to_exchange IS 'Unlock → intermediate → exchange cluster within 24h';
