CREATE TABLE "lab_authorization_templates" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "template_type" text NOT NULL,
 "content" text NOT NULL,
 "version" integer DEFAULT 1 NOT NULL,
 "updated_by_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "created_at" timestamptz DEFAULT now() NOT NULL,
 "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "lab_authorization_templates_lab_type_unique" ON "lab_authorization_templates" ("lab_organization_id","template_type");
CREATE INDEX "lab_authorization_templates_lab_idx" ON "lab_authorization_templates" ("lab_organization_id");
ALTER TABLE "lab_authorization_templates" ADD CONSTRAINT "lab_authorization_templates_type_check" CHECK ("template_type" IN ('card_on_file','autopay'));

CREATE TABLE "practice_authorization_documents" (
 "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "lab_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "practice_organization_id" varchar NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
 "authorization_type" text NOT NULL,
 "original_filename" text NOT NULL,
 "byte_size" integer NOT NULL,
 "checksum" text NOT NULL,
 "uploader_user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE restrict,
 "object_key" text NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "practice_auth_docs_scope_idx" ON "practice_authorization_documents" ("lab_organization_id","practice_organization_id");
ALTER TABLE "practice_authorization_documents" ADD CONSTRAINT "practice_auth_docs_type_check" CHECK ("authorization_type" IN ('card_on_file','autopay'));
ALTER TABLE "practice_authorization_documents" ADD CONSTRAINT "practice_auth_docs_size_check" CHECK ("byte_size" > 0);
CREATE OR REPLACE FUNCTION deny_practice_authorization_document_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'practice authorization documents are immutable'; END $$;
CREATE TRIGGER practice_authorization_documents_immutable
 BEFORE UPDATE OR DELETE ON "practice_authorization_documents"
 FOR EACH ROW EXECUTE FUNCTION deny_practice_authorization_document_mutation();