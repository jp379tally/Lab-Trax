CREATE TABLE "provider_autopay_authorizations" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "agreement_version" text NOT NULL,
  "agreement_text" text NOT NULL,
  "subscription_fees" boolean NOT NULL,
  "lab_bills" boolean NOT NULL,
  "lab_charge_day" integer,
  "signer_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "typed_legal_name" text NOT NULL,
  "consent" boolean NOT NULL,
  "signer_ip" text NOT NULL,
  "signer_user_agent" text NOT NULL,
  "signed_at" timestamptz NOT NULL,
  "signature_object_key" text NOT NULL,
  "signature_checksum" text NOT NULL,
  "document_object_key" text NOT NULL,
  "document_checksum" text NOT NULL,
  "card_brand" text NOT NULL,
  "card_last4" text NOT NULL,
  "card_exp_month" integer NOT NULL,
  "card_exp_year" integer NOT NULL,
  "card_status" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "superseded_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "provider_autopay_auth_provider_status_idx"
  ON "provider_autopay_authorizations" ("provider_organization_id", "status");
CREATE UNIQUE INDEX "provider_autopay_auth_current_unique"
  ON "provider_autopay_authorizations" ("provider_organization_id")
  WHERE status = 'active';
ALTER TABLE "provider_autopay_authorizations"
  ADD CONSTRAINT "provider_autopay_auth_category_check" CHECK (subscription_fees OR lab_bills),
  ADD CONSTRAINT "provider_autopay_auth_lab_day_check" CHECK ((lab_bills AND lab_charge_day BETWEEN 1 AND 10) OR (NOT lab_bills AND lab_charge_day IS NULL)),
  ADD CONSTRAINT "provider_autopay_auth_consent_check" CHECK (consent = true),
  ADD CONSTRAINT "provider_autopay_auth_last4_check" CHECK (card_last4 ~ '^[0-9]{4}$'),
  ADD CONSTRAINT "provider_autopay_auth_expiry_check" CHECK (card_exp_month BETWEEN 1 AND 12 AND card_exp_year BETWEEN 2000 AND 2200),
  ADD CONSTRAINT "provider_autopay_auth_status_check" CHECK (status IN ('active', 'superseded')),
  ADD CONSTRAINT "provider_autopay_auth_superseded_check" CHECK ((status = 'active' AND superseded_at IS NULL) OR (status = 'superseded' AND superseded_at IS NOT NULL));
CREATE TABLE "provider_autopay_authorization_labs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "authorization_id" varchar NOT NULL REFERENCES "provider_autopay_authorizations"("id") ON DELETE restrict,
  "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "provider_autopay_auth_lab_unique"
  ON "provider_autopay_authorization_labs" ("authorization_id", "lab_organization_id");
CREATE INDEX "provider_autopay_auth_labs_auth_idx"
  ON "provider_autopay_authorization_labs" ("authorization_id");
-- Signed records are immutable. Supersession is performed by the service in
-- one transaction and is the only permitted state transition.
CREATE OR REPLACE FUNCTION prevent_provider_autopay_authorization_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'superseded' AND OLD.status = 'active'
     AND NEW.superseded_at IS NOT NULL
     AND NEW.id = OLD.id
     AND NEW.provider_organization_id IS NOT DISTINCT FROM OLD.provider_organization_id
     AND NEW.agreement_version IS NOT DISTINCT FROM OLD.agreement_version
     AND NEW.agreement_text IS NOT DISTINCT FROM OLD.agreement_text
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
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'provider auto-pay authorizations are immutable';
END $$;
CREATE TRIGGER provider_autopay_authorizations_immutable
  BEFORE UPDATE ON "provider_autopay_authorizations"
  FOR EACH ROW EXECUTE FUNCTION prevent_provider_autopay_authorization_update();
CREATE OR REPLACE FUNCTION deny_provider_autopay_authorization_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider auto-pay authorizations cannot be deleted'; END $$;
CREATE TRIGGER provider_autopay_authorizations_no_delete
  BEFORE DELETE ON "provider_autopay_authorizations"
  FOR EACH ROW EXECUTE FUNCTION deny_provider_autopay_authorization_delete();
CREATE OR REPLACE FUNCTION deny_provider_autopay_authorization_lab_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider auto-pay authorization lab relationships are immutable'; END $$;
CREATE TRIGGER provider_autopay_authorization_labs_immutable
  BEFORE UPDATE OR DELETE ON "provider_autopay_authorization_labs"
  FOR EACH ROW EXECUTE FUNCTION deny_provider_autopay_authorization_lab_mutation();