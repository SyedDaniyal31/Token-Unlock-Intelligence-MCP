-- Improves lookup performance for market ID queries and analytics
CREATE INDEX IF NOT EXISTS idx_unlock_coingecko_id
ON unlock_schedules(coingecko_id);

CREATE INDEX IF NOT EXISTS idx_unlock_paprika_id
ON unlock_schedules(paprika_id);
