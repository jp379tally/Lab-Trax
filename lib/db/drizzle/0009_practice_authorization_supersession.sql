ALTER TABLE "practice_authorization_documents"
  ADD COLUMN "supersedes_document_id" varchar
  REFERENCES "practice_authorization_documents"("id") ON DELETE restrict;

CREATE UNIQUE INDEX "practice_auth_docs_supersedes_unique"
  ON "practice_authorization_documents" ("supersedes_document_id");