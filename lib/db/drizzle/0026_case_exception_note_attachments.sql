ALTER TABLE "case_attachments"
  ADD COLUMN IF NOT EXISTS "case_exception_note_id" varchar;

CREATE INDEX IF NOT EXISTS "case_attachments_exception_note_idx"
  ON "case_attachments" ("case_exception_note_id");