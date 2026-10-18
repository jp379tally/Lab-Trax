ALTER TABLE "provider_payment_checkouts"
  ADD COLUMN IF NOT EXISTS "inline_draft_json" jsonb,
  ADD COLUMN IF NOT EXISTS "inline_draft_fingerprint" text;