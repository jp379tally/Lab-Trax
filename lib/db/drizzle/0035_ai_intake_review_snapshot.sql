ALTER TABLE "cases"
  ADD COLUMN IF NOT EXISTS "prescription_due_date" date,
  ADD COLUMN IF NOT EXISTS "scan_date" date,
  ADD COLUMN IF NOT EXISTS "provider_contact_snapshot" jsonb;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "billing_address_line_1" text,
  ADD COLUMN IF NOT EXISTS "billing_address_line_2" text,
  ADD COLUMN IF NOT EXISTS "billing_city" text,
  ADD COLUMN IF NOT EXISTS "billing_state" text,
  ADD COLUMN IF NOT EXISTS "billing_zip" text;

-- Schema-push installations may already contain these columns. Do not mask a
-- different pre-existing type merely because IF NOT EXISTS skips its creation.
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'cases' AND (
          (column_name IN ('prescription_due_date', 'scan_date') AND data_type = 'date')
          OR (column_name = 'provider_contact_snapshot' AND data_type = 'jsonb')))
        OR (table_name = 'organizations' AND data_type = 'text' AND column_name IN (
          'billing_address_line_1', 'billing_address_line_2', 'billing_city',
          'billing_state', 'billing_zip')))) <> 8 THEN
    RAISE EXCEPTION 'AI intake schema contains incompatible column types; migration stopped';
  END IF;
END $$;
