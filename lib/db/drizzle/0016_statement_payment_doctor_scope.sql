ALTER TABLE "statement_payment_sessions"
  ADD COLUMN IF NOT EXISTS "doctor_identity" text,
  ADD COLUMN IF NOT EXISTS "doctor_display_name" text;

CREATE INDEX IF NOT EXISTS "statement_payment_sessions_doctor_idx"
  ON "statement_payment_sessions" ("lab_organization_id", "provider_organization_id", "doctor_identity");