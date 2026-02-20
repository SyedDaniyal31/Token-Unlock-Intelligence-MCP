-- Exchange intelligence: high_velocity and suspected_hot_wallet for flow analysis
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS high_velocity BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE unlock_flow_analysis ADD COLUMN IF NOT EXISTS suspected_hot_wallet BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN unlock_flow_analysis.high_velocity IS 'Transfer ends at exchange; high_velocity_exchange_inflow';
COMMENT ON COLUMN unlock_flow_analysis.suspected_hot_wallet IS 'Recipient in suspected_exchange_hot_wallet cluster; moderate risk';
