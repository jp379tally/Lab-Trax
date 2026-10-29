CREATE TABLE IF NOT EXISTS backup_live_status (
  run_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN (
    'running', 'awaiting_verification', 'completed', 'failed', 'stale'
  )),
  phase text NOT NULL,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE backup_live_status
  ADD COLUMN IF NOT EXISTS archive_evidence jsonb;

ALTER TABLE backup_live_status
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE INDEX IF NOT EXISTS backup_live_status_created_at_idx
  ON backup_live_status (created_at);
