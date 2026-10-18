ALTER TABLE "practice_statements"
  ADD COLUMN IF NOT EXISTS "invoice_details_json" jsonb;