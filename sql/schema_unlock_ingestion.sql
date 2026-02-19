-- ---------------------------------------------------------------------------
-- Layer 1: Unlock Metadata Registry
-- Canonical unlock schedule metadata per contract.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unlock_schedules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol        TEXT NOT NULL,
  contract_address    TEXT NOT NULL,
  beneficiary_label   TEXT NOT NULL,
  total_allocation    NUMERIC NOT NULL,
  vesting_start       TIMESTAMPTZ,
  vesting_cliff       TIMESTAMPTZ,
  vesting_end         TIMESTAMPTZ,
  release_frequency   TEXT,
  last_verified_block BIGINT DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_symbol, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_unlock_schedules_token_symbol ON unlock_schedules (token_symbol);
CREATE INDEX IF NOT EXISTS idx_unlock_schedules_contract ON unlock_schedules (contract_address);

-- ---------------------------------------------------------------------------
-- Layer 2: On-Chain Verification (claim / transfer / vest events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unlock_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol      TEXT NOT NULL,
  contract_address  TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  amount            NUMERIC NOT NULL,
  block_number      BIGINT NOT NULL,
  tx_hash           TEXT,
  recipient_address TEXT,
  timestamp         TIMESTAMPTZ,
  processed         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unlock_events_token_symbol ON unlock_events (token_symbol);
CREATE INDEX IF NOT EXISTS idx_unlock_events_contract_block ON unlock_events (contract_address, block_number);
CREATE INDEX IF NOT EXISTS idx_unlock_events_processed ON unlock_events (processed);
CREATE INDEX IF NOT EXISTS idx_unlock_events_timestamp ON unlock_events (timestamp);

-- ---------------------------------------------------------------------------
-- Layer 3: Sellable Supply Detection (exchange flow, retention)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unlock_flow_analysis (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol            TEXT NOT NULL,
  unlock_event_id         UUID NOT NULL REFERENCES unlock_events (id) ON DELETE CASCADE,
  transferred_to_exchange BOOLEAN NOT NULL DEFAULT FALSE,
  exchange_label          TEXT,
  retained_in_wallet      BOOLEAN NOT NULL DEFAULT FALSE,
  moved_to_new_wallet     BOOLEAN NOT NULL DEFAULT FALSE,
  risk_flag               TEXT NOT NULL DEFAULT 'none',
  analyzed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unlock_flow_token_symbol ON unlock_flow_analysis (token_symbol);
CREATE INDEX IF NOT EXISTS idx_unlock_flow_event_id ON unlock_flow_analysis (unlock_event_id);
CREATE INDEX IF NOT EXISTS idx_unlock_flow_risk ON unlock_flow_analysis (risk_flag);

COMMENT ON COLUMN unlock_events.event_type IS 'claim | transfer | vest';
COMMENT ON COLUMN unlock_events.recipient_address IS 'Transfer destination for flow analysis; optional';
COMMENT ON COLUMN unlock_flow_analysis.risk_flag IS 'none | moderate | high';
