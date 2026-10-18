-- Backup runs record what the destination actually stored.
--
-- remote_item_id: OneDrive Graph item id of the uploaded archive. The uploaded
-- name is not a reliable key because Graph renames on conflict, so history
-- downloads resolve by id first and fall back to the recorded name.
--
-- archive_kind: "full" (database + media) or "database-only". Database-only
-- archives are taken on the fast schedule and must never be used as a restore
-- source. Existing rows predate database-only archives, so they are full.
ALTER TABLE "backup_runs"
  ADD COLUMN IF NOT EXISTS "remote_item_id" text;

ALTER TABLE "backup_runs"
  ADD COLUMN IF NOT EXISTS "archive_kind" text NOT NULL DEFAULT 'full';
