-- Multi-chain: chain_id on schedules, events, vesting_analysis, unlock_flow_analysis

-- unlock_schedules: add chain_id, update unique
ALTER TABLE unlock_schedules ADD COLUMN IF NOT EXISTS chain_id TEXT NOT NULL DEFAULT 'ethereum';
ALTER TABLE unlock_schedules DROP CONSTRAINT IF EXISTS unlock_schedules_token_symbol_contract_address_key;
ALTER TABLE unlock_schedules ADD CONSTRAINT unlock_schedules_token_contract_chain_key
  UNIQUE (token_symbol, contract_address, chain_id);
CREATE INDEX IF NOT EXISTS idx_unlock_schedules_chain ON unlock_schedules (chain_id);
COMMENT ON COLUMN unlock_schedules.chain_id IS 'Chain key: ethereum | arbitrum | bsc';

-- unlock_events: add chain_id for chain-scoped queries
ALTER TABLE unlock_events ADD COLUMN IF NOT EXISTS chain_id TEXT NOT NULL DEFAULT 'ethereum';
CREATE INDEX IF NOT EXISTS idx_unlock_events_chain ON unlock_events (chain_id);
CREATE INDEX IF NOT EXISTS idx_unlock_events_token_chain ON unlock_events (token_symbol, chain_id);

-- vesting_analysis: add chain_id, update unique
ALTER TABLE vesting_analysis ADD COLUMN IF NOT EXISTS chain_id TEXT NOT NULL DEFAULT 'ethereum';
ALTER TABLE vesting_analysis DROP CONSTRAINT IF EXISTS vesting_analysis_token_symbol_contract_address_key;
ALTER TABLE vesting_analysis ADD CONSTRAINT vesting_analysis_token_contract_chain_key
  UNIQUE (token_symbol, contract_address, chain_id);
CREATE INDEX IF NOT EXISTS idx_vesting_analysis_chain ON vesting_analysis (chain_id);

-- unlock_flow_analysis: add chain_id (no unique change; per event)
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS chain_id TEXT NOT NULL DEFAULT 'ethereum';
CREATE INDEX IF NOT EXISTS idx_unlock_flow_chain ON unlock_flow_analysis (chain_id);
CREATE INDEX IF NOT EXISTS idx_unlock_flow_token_chain ON unlock_flow_analysis (token_symbol, chain_id);

-- cluster_flow_aggregation: add chain_id to primary key
ALTER TABLE cluster_flow_aggregation ADD COLUMN IF NOT EXISTS chain_id TEXT NOT NULL DEFAULT 'ethereum';
ALTER TABLE cluster_flow_aggregation DROP CONSTRAINT IF EXISTS cluster_flow_aggregation_pkey;
ALTER TABLE cluster_flow_aggregation ADD PRIMARY KEY (cluster_tag, token_symbol, chain_id);
CREATE INDEX IF NOT EXISTS idx_cluster_flow_chain ON cluster_flow_aggregation (chain_id);
