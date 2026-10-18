ALTER TABLE "case_attachments"
  ADD COLUMN IF NOT EXISTS "texture_attachment_id" varchar;

ALTER TABLE "case_attachments"
  DROP CONSTRAINT IF EXISTS "case_attachments_texture_attachment_id_fkey";

ALTER TABLE "case_attachments"
  ADD CONSTRAINT "case_attachments_texture_attachment_id_fkey"
  FOREIGN KEY ("texture_attachment_id") REFERENCES "case_attachments"("id")
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "case_attachments_texture_attachment_idx"
  ON "case_attachments" ("texture_attachment_id");