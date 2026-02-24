-- External unlock calendar: third-party schedules (TokenUnlocks / CryptoRank etc.).
-- Consumed by unifiedUnlockResolver and externalUnlockIngestion.

CREATE TABLE IF NOT EXISTS unlock_events_external (
    id SERIAL PRIMARY KEY,
    token_symbol TEXT NOT NULL,
    chain TEXT NOT NULL,
    unlock_timestamp BIGINT NOT NULL,
    unlock_amount NUMERIC,
    unlock_percent NUMERIC,
    category TEXT,
    source TEXT NOT NULL,
    confidence INTEGER,
    inserted_at BIGINT NOT NULL,
    UNIQUE (token_symbol, unlock_timestamp, source)
);

CREATE INDEX IF NOT EXISTS idx_unlock_external_lookup
ON unlock_events_external (token_symbol, chain, unlock_timestamp);
