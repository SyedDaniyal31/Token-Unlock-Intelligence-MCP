-- Predictive vesting: rate, acceleration, density, confidence (do not break existing)

ALTER TABLE vesting_analysis ADD COLUMN IF NOT EXISTS vesting_rate_per_second NUMERIC;
ALTER TABLE vesting_analysis ADD COLUMN IF NOT EXISTS accelerated_claim BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vesting_analysis ADD COLUMN IF NOT EXISTS unlock_density NUMERIC;
ALTER TABLE vesting_analysis ADD COLUMN IF NOT EXISTS vesting_confidence NUMERIC NOT NULL DEFAULT 0.3;

COMMENT ON COLUMN vesting_analysis.vesting_rate_per_second IS 'Linear: total_allocation / (end - start) per second';
COMMENT ON COLUMN vesting_analysis.accelerated_claim IS 'True when claimed > expected_vested * 1.05';
COMMENT ON COLUMN vesting_analysis.unlock_density IS 'claimed_amount / (end - start in days); higher = sell risk';
COMMENT ON COLUMN vesting_analysis.vesting_confidence IS '1.0 linear, 0.7 generic, 0.3 unknown';
