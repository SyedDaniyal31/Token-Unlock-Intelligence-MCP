-- Allow unlock_amount to be NULL for manual registry (missing amounts in CSV).
-- Only alters when column is currently NOT NULL (safe for new installs where CREATE already has NULL).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unlock_events_external'
      AND column_name = 'unlock_amount' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE unlock_events_external ALTER COLUMN unlock_amount DROP NOT NULL;
  END IF;
END $$;
