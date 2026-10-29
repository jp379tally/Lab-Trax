ALTER TABLE backup_live_status
  DROP CONSTRAINT IF EXISTS backup_live_status_state_check;

ALTER TABLE backup_live_status
  ADD CONSTRAINT backup_live_status_state_check
  CHECK (state IN (
    'running', 'awaiting_verification', 'finalizing',
    'completed', 'failed', 'cancelled', 'stale'
  ));

ALTER TABLE backup_live_status
  ADD COLUMN IF NOT EXISTS requested_by_user_id text;

ALTER TABLE backup_live_status
  ADD COLUMN IF NOT EXISTS requested_by_session_hash text;

ALTER TABLE backup_live_status
  ADD COLUMN IF NOT EXISTS delivery jsonb;
