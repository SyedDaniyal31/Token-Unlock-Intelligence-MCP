-- Performance indexes for institutional hybrid intelligence (Step 9)
-- Ensures fast lookups for sellable supply and MCP response < 1.5s when cached.

CREATE INDEX IF NOT EXISTS idx_unlock_events_token_timestamp
  ON unlock_events (token_symbol, timestamp);

CREATE INDEX IF NOT EXISTS idx_unlock_flow_analysis_unlock_event_id
  ON unlock_flow_analysis (unlock_event_id);

CREATE INDEX IF NOT EXISTS idx_unlock_analysis_token_symbol
  ON unlock_analysis (token_symbol);
