-- Allow unlock_amount to be NULL for manual registry (missing amounts in CSV).
-- Single line so migration runner (splits on ;\n) does not break the DO block.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'unlock_events_external' AND column_name = 'unlock_amount' AND is_nullable = 'NO') THEN ALTER TABLE unlock_events_external ALTER COLUMN unlock_amount DROP NOT NULL; END IF; END $$;

