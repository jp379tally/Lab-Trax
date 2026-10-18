BEGIN;

LOCK TABLE
  "lab_authorization_audit_events",
  "lab_authorizations",
  "lab_authorization_drafts"
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "practice_authorization_documents"
  ALTER COLUMN "byte_size" DROP NOT NULL;
ALTER TABLE "practice_authorization_documents"
  DROP CONSTRAINT "practice_auth_docs_size_check";
ALTER TABLE "practice_authorization_documents"
  ADD CONSTRAINT "practice_auth_docs_size_check"
  CHECK ("byte_size" IS NULL OR "byte_size" > 0);
ALTER TABLE "practice_authorization_documents"
  ADD COLUMN "legacy_authorization_id" varchar;
ALTER TABLE "practice_authorization_documents"
  ADD COLUMN "legacy_evidence" jsonb;
CREATE UNIQUE INDEX "practice_auth_docs_legacy_authorization_unique"
  ON "practice_authorization_documents" ("legacy_authorization_id");
CREATE OR REPLACE FUNCTION deny_practice_authorization_document_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'practice authorization documents are immutable';
END $$;
DROP TRIGGER IF EXISTS practice_authorization_documents_immutable
  ON "practice_authorization_documents";
CREATE TRIGGER practice_authorization_documents_immutable
  BEFORE UPDATE OR DELETE ON "practice_authorization_documents"
  FOR EACH ROW EXECUTE FUNCTION deny_practice_authorization_document_mutation();

INSERT INTO "practice_authorization_documents" (
  "id",
  "lab_organization_id",
  "practice_organization_id",
  "authorization_type",
  "original_filename",
  "byte_size",
  "checksum",
  "uploader_user_id",
  "object_key",
  "legacy_authorization_id",
  "legacy_evidence",
  "created_at"
)
SELECT
  'retired_' || legacy_authorization."id",
  legacy_authorization."lab_organization_id",
  legacy_authorization."practice_organization_id",
  legacy_authorization."template_type",
  'authorization-' || legacy_authorization."id" || '.pdf',
  NULL,
  legacy_authorization."document_hash",
  legacy_authorization."signer_user_id",
  legacy_authorization."document_object_key",
  legacy_authorization."id",
  jsonb_build_object(
    'draftId', legacy_authorization."draft_id",
    'templateVersion', legacy_authorization."template_version",
    'templateHash', legacy_authorization."template_hash",
    'fieldValues', legacy_authorization."field_values",
    'signatureObjectKey', legacy_authorization."signature_object_key",
    'signatureMethod', legacy_authorization."signature_method",
    'signatureHash', legacy_authorization."signature_hash",
    'signerLegalName', legacy_authorization."signer_legal_name",
    'signerUserId', legacy_authorization."signer_user_id",
    'signerIp', legacy_authorization."signer_ip",
    'signerUserAgent', legacy_authorization."signer_user_agent",
    'consent', legacy_authorization."consent",
    'signedAt', legacy_authorization."signed_at",
    'auditEvents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', event."id",
        'action', event."action",
        'actorUserId', event."actor_user_id",
        'metadata', event."metadata_json",
        'createdAt', event."created_at"
      ) ORDER BY event."created_at", event."id")
      FROM "lab_authorization_audit_events" event
      WHERE event."authorization_id" = legacy_authorization."id"
         OR event."draft_id" = legacy_authorization."draft_id"
    ), '[]'::jsonb)
  ),
  legacy_authorization."signed_at"
FROM "lab_authorizations" AS legacy_authorization;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM "practice_authorization_documents"
    WHERE "legacy_authorization_id" IS NOT NULL
  ) <> (SELECT count(*) FROM "lab_authorizations") THEN
    RAISE EXCEPTION 'Legacy authorization document migration count mismatch';
  END IF;
END $$;

DROP TABLE "lab_authorization_audit_events";
DROP TABLE "lab_authorizations";
DROP TABLE "lab_authorization_drafts";
DROP FUNCTION IF EXISTS deny_lab_authorization_audit_mutation();
DROP FUNCTION IF EXISTS deny_lab_authorization_mutation();

COMMIT;