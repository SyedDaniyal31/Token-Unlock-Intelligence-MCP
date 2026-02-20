-- Phase 3: Vesting Contract Intelligence
-- 1) vesting_type on unlock_schedules (ABI pattern detection result)
-- 2) vesting_analysis table for expected_vested, claimed, remaining_locked, next_unlock_estimate

ALTER TABLE unlock_schedules ADD COLUMN IF NOT EXISTS vesting_type TEXT;
COMMENT ON COLUMN unlock_schedules.vesting_type IS 'openzeppelin_token_vesting | linear_vesting | cliff_vesting | generic_vesting | unknown';

CREATE TABLE IF NOT EXISTS vesting_analysis (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_symbol          TEXT NOT NULL,
  contract_address      TEXT NOT NULL,
  vesting_type          TEXT,
  expected_vested       NUMERIC NOT NULL DEFAULT 0,
  claimed_amount        NUMERIC NOT NULL DEFAULT 0,
  remaining_locked      NUMERIC NOT NULL DEFAULT 0,
  next_unlock_estimate  NUMERIC,
  last_updated          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_symbol, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_vesting_analysis_token ON vesting_analysis (token_symbol);
CREATE INDEX IF NOT EXISTS idx_vesting_analysis_contract ON vesting_analysis (contract_address);

COMMENT ON TABLE vesting_analysis IS 'Vesting intelligence: expected vs claimed, remaining locked, next unlock estimate';
COMMENT ON COLUMN vesting_analysis.expected_vested IS 'Expected vested amount by current time (linear/cliff logic)';
COMMENT ON COLUMN vesting_analysis.claimed_amount IS 'Sum of released/claimed so far';
COMMENT ON COLUMN vesting_analysis.remaining_locked IS 'expected total - claimed (or from contract state)';
COMMENT ON COLUMN vesting_analysis.next_unlock_estimate IS 'Next unlock amount or next cliff/release amount';
