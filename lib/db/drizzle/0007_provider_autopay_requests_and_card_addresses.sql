ALTER TABLE "provider_payment_customers"
  ADD COLUMN IF NOT EXISTS "card_billing_address_json" jsonb;
ALTER TABLE "provider_autopay_authorizations"
  ADD COLUMN IF NOT EXISTS "card_billing_address_json" jsonb;
ALTER TABLE "provider_autopay_authorizations"
  ADD COLUMN IF NOT EXISTS "agreement_sha256" text;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- The migration-0003 trigger rejects every update except supersession. Remove
-- it while backfilling the newly added immutable hash, then recreate the
-- expanded trigger below before the migration commits.
DROP TRIGGER IF EXISTS provider_autopay_authorizations_immutable
  ON "provider_autopay_authorizations";
UPDATE "provider_autopay_authorizations"
   SET "agreement_sha256" = encode(digest("agreement_text", 'sha256'), 'hex')
 WHERE "agreement_sha256" IS NULL;
ALTER TABLE "provider_autopay_authorizations"
  ALTER COLUMN "agreement_sha256" SET NOT NULL;
CREATE TABLE "provider_autopay_authorization_requests" (
  "id" varchar PRIMARY KEY NOT NULL,
  "provider_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "requested_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "agreement_version" text NOT NULL,
  "agreement_text" text NOT NULL,
  "agreement_sha256" text NOT NULL,
  "subscription_fees" boolean NOT NULL,
  "lab_bills" boolean NOT NULL,
  "lab_organization_ids" jsonb NOT NULL,
  "lab_charge_day" integer,
  "card_brand" text, "card_last4" text, "card_exp_month" integer,
  "card_exp_year" integer, "card_status" text, "card_billing_address_json" jsonb,
  "status" text DEFAULT 'prepared' NOT NULL,
  "recipient_email" text, "token_hash" text,
  "expires_at" timestamptz, "sent_at" timestamptz, "completed_at" timestamptz,
  "completed_authorization_id" varchar REFERENCES "provider_autopay_authorizations"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "provider_autopay_requests_status_check"
    CHECK ("status" IN ('prepared','sent','completed','expired','cancelled')),
  CONSTRAINT "provider_autopay_requests_category_check" CHECK ("subscription_fees" OR "lab_bills"),
  CONSTRAINT "provider_autopay_requests_lab_day_check" CHECK (("lab_bills" AND "lab_charge_day" BETWEEN 1 AND 10) OR (NOT "lab_bills" AND "lab_charge_day" IS NULL)),
  CONSTRAINT "provider_autopay_requests_last4_check" CHECK ("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$'),
  CONSTRAINT "provider_autopay_requests_card_status_check" CHECK ("card_status" IS NULL OR "card_status" IN ('active','expired'))
);
CREATE INDEX "provider_autopay_requests_provider_idx"
  ON "provider_autopay_authorization_requests" ("provider_organization_id","status");
CREATE INDEX "provider_autopay_requests_lab_idx"
  ON "provider_autopay_authorization_requests" ("lab_organization_id","status");

-- Recreate the append-only trigger after adding the signed agreement hash and
-- billing address. Supersession is the sole permitted update.
CREATE OR REPLACE FUNCTION prevent_provider_autopay_authorization_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'superseded' AND OLD.status = 'active'
     AND NEW.superseded_at IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.provider_organization_id IS NOT DISTINCT FROM OLD.provider_organization_id
     AND NEW.agreement_version IS NOT DISTINCT FROM OLD.agreement_version
     AND NEW.agreement_text IS NOT DISTINCT FROM OLD.agreement_text
     AND NEW.agreement_sha256 IS NOT DISTINCT FROM OLD.agreement_sha256
     AND NEW.subscription_fees IS NOT DISTINCT FROM OLD.subscription_fees
     AND NEW.lab_bills IS NOT DISTINCT FROM OLD.lab_bills
     AND NEW.lab_charge_day IS NOT DISTINCT FROM OLD.lab_charge_day
     AND NEW.signer_user_id IS NOT DISTINCT FROM OLD.signer_user_id
     AND NEW.typed_legal_name IS NOT DISTINCT FROM OLD.typed_legal_name
     AND NEW.consent IS NOT DISTINCT FROM OLD.consent
     AND NEW.signer_ip IS NOT DISTINCT FROM OLD.signer_ip
     AND NEW.signer_user_agent IS NOT DISTINCT FROM OLD.signer_user_agent
     AND NEW.signed_at IS NOT DISTINCT FROM OLD.signed_at
     AND NEW.signature_object_key IS NOT DISTINCT FROM OLD.signature_object_key
     AND NEW.signature_checksum IS NOT DISTINCT FROM OLD.signature_checksum
     AND NEW.document_object_key IS NOT DISTINCT FROM OLD.document_object_key
     AND NEW.document_checksum IS NOT DISTINCT FROM OLD.document_checksum
     AND NEW.card_brand IS NOT DISTINCT FROM OLD.card_brand
     AND NEW.card_last4 IS NOT DISTINCT FROM OLD.card_last4
     AND NEW.card_exp_month IS NOT DISTINCT FROM OLD.card_exp_month
     AND NEW.card_exp_year IS NOT DISTINCT FROM OLD.card_exp_year
     AND NEW.card_status IS NOT DISTINCT FROM OLD.card_status
     AND NEW.card_billing_address_json IS NOT DISTINCT FROM OLD.card_billing_address_json
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'provider auto-pay authorizations are immutable';
END $$;
CREATE TRIGGER provider_autopay_authorizations_immutable
  BEFORE UPDATE ON "provider_autopay_authorizations"
  FOR EACH ROW EXECUTE FUNCTION prevent_provider_autopay_authorization_update();