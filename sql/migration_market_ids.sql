-- Market data provider IDs per token (no hardcoded symbols in app).
ALTER TABLE unlock_schedules ADD COLUMN IF NOT EXISTS coingecko_id TEXT;
ALTER TABLE unlock_schedules ADD COLUMN IF NOT EXISTS paprika_id TEXT;
COMMENT ON COLUMN unlock_schedules.coingecko_id IS 'CoinGecko coin id (e.g. arbitrum, ethereum)';
COMMENT ON COLUMN unlock_schedules.paprika_id IS 'CoinPaprika ticker id (e.g. arb-arbitrum, eth-ethereum)';
