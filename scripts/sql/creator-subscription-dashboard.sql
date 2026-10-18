BEGIN;
ALTER TABLE support_reports ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'issue';
ALTER TABLE support_reports ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE TABLE IF NOT EXISTS subscription_receipts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id varchar,
  provider text NOT NULL,
  external_id text NOT NULL,
  kind text NOT NULL,
  parent_external_id text,
  amount_minor bigint,
  currency text,
  occurred_at timestamptz,
  coverage_starts_at timestamptz,
  coverage_ends_at timestamptz,
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Keep original source identity even if retired or absent from an older
-- restored directory. Payment facts must not block legacy schema restores.
ALTER TABLE subscription_receipts DROP CONSTRAINT IF EXISTS subscription_receipts_subscription_id_fkey;
ALTER TABLE subscription_receipts DROP CONSTRAINT IF EXISTS subscription_receipts_subscription_id_subscriptions_id_fk;
CREATE UNIQUE INDEX IF NOT EXISTS subscription_receipts_evidence_unique ON subscription_receipts(provider, external_id, kind);
CREATE INDEX IF NOT EXISTS subscription_receipts_date_idx ON subscription_receipts(occurred_at);
CREATE INDEX IF NOT EXISTS subscription_receipts_subscription_idx ON subscription_receipts(subscription_id);
COMMIT;
