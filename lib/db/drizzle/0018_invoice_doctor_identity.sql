ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "doctor_identity" varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_doctor_identity_doctor_profiles_id_fk'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_doctor_identity_doctor_profiles_id_fk"
      FOREIGN KEY ("doctor_identity") REFERENCES "doctor_profiles"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "invoices_doctor_identity_idx"
  ON "invoices" ("lab_organization_id", "provider_organization_id", "doctor_identity");