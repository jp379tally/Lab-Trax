ALTER TABLE backup_live_status
  ADD COLUMN IF NOT EXISTS request_fingerprint text;
