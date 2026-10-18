CREATE TABLE "lab_authorization_drafts" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "practice_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "template_version" text NOT NULL, "template_type" text DEFAULT 'card_on_file' NOT NULL, "field_values" jsonb DEFAULT '{}' NOT NULL,
 "signature_data" text, "signature_method" text, "signer_legal_name" text,
 "consent" boolean DEFAULT false NOT NULL,
 "created_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "updated_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "lab_auth_drafts_scope_idx" ON "lab_authorization_drafts" ("lab_organization_id","practice_organization_id");
CREATE TABLE "lab_authorizations" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "draft_id" varchar NOT NULL UNIQUE REFERENCES "lab_authorization_drafts"("id") ON DELETE restrict,
 "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "practice_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "template_version" text NOT NULL, "template_type" text NOT NULL, "template_hash" text NOT NULL, "field_values" jsonb NOT NULL,
 "signature_object_key" text NOT NULL, "signature_method" text NOT NULL, "signature_hash" text NOT NULL, "signer_legal_name" text NOT NULL,
 "signer_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "signer_ip" text NOT NULL, "signer_user_agent" text NOT NULL, "consent" boolean NOT NULL,
 "signed_at" timestamptz NOT NULL, "document_object_key" text NOT NULL, "document_hash" text NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "lab_authorizations_scope_idx" ON "lab_authorizations" ("lab_organization_id","practice_organization_id");
CREATE TABLE "lab_authorization_audit_events" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "authorization_id" varchar REFERENCES "lab_authorizations"("id") ON DELETE restrict,
 "draft_id" varchar REFERENCES "lab_authorization_drafts"("id") ON DELETE restrict,
 "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "action" text NOT NULL, "actor_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "metadata_json" jsonb DEFAULT '{}' NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "lab_auth_audit_scope_idx" ON "lab_authorization_audit_events" ("lab_organization_id","created_at");
CREATE OR REPLACE FUNCTION deny_lab_authorization_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'completed lab authorizations are immutable'; END $$;
CREATE TRIGGER lab_authorizations_immutable BEFORE UPDATE OR DELETE ON "lab_authorizations"
 FOR EACH ROW EXECUTE FUNCTION deny_lab_authorization_mutation();
CREATE OR REPLACE FUNCTION deny_lab_authorization_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'authorization audit events are append-only'; END $$;
CREATE TRIGGER lab_authorization_audit_append_only BEFORE UPDATE OR DELETE ON "lab_authorization_audit_events"
 FOR EACH ROW EXECUTE FUNCTION deny_lab_authorization_audit_mutation();