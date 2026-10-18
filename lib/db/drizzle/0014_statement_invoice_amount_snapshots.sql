ALTER TABLE "practice_statements"
  ADD COLUMN IF NOT EXISTS "invoice_amounts_json" jsonb;

ALTER TABLE "statement_payment_applications"
  ADD COLUMN IF NOT EXISTS "statement_invoice_amount" numeric(12, 2);