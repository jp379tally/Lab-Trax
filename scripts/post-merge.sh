#!/bin/bash
set -euo pipefail

# Post-merge reconciliation.
#
# Runs automatically after a task is merged to bring the workspace into a
# runnable state. Keep this FAST, idempotent, and NON-INTERACTIVE — stdin is
# closed (/dev/null), so any command that prompts will get EOF and fail.
#
# NOTE: Desktop installer builds/publishes are intentionally NOT performed here.
# That pipeline needs Wine (for the NSIS installer) and a running, reachable
# server (for the post-publish download check), neither of which exists in the
# merge sandbox. Desktop releases are handled by GitHub Actions
# (auto-tag-desktop-release.yml -> release.yml). Doing it here only produced a
# guaranteed failure (Wine missing + HTTP 502 on the reachability probe).

# 1. Install dependencies for every workspace package, exactly per the lockfile.
pnpm install --frozen-lockfile

# 1.5. Remove orphaned rows BEFORE applying the schema so that drizzle-kit
# push can attach FK constraints cleanly.

# 1.5a. Orphaned user_sessions (sessions whose user no longer exists).
# The schema declares a cascade FK user_sessions.user_id -> users.id that the
# live DB historically lacked, so every `drizzle-kit push` tried to CREATE that
# FK and failed (Postgres 23503) on leftover rows — the recurring
# "user_sessions_user_id_users_id_fk" noise.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "DELETE FROM user_sessions s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id);" \
    || echo "post-merge: orphan user_sessions cleanup skipped (psql unavailable or table not created yet)"
else
  echo "post-merge: DATABASE_URL unset — skipping orphan user_sessions cleanup"
fi

# 1.5b. Orphaned organization_connections rows (lab_organization_id no longer
# in organizations). These cause the same class of FK 23503 error on push,
# blocking ALL schema changes — not just the FK on organization_connections.
# Orphans arise when a lab org is hard-deleted without cascade (legacy data /
# test cleanup). Deleting them is safe: a connection whose lab org is gone
# can never resolve. Idempotent; skips silently if the table doesn't exist yet.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "DELETE FROM organization_connections oc WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = oc.lab_organization_id);" \
    || echo "post-merge: orphan organization_connections cleanup skipped (psql unavailable or table not created yet)"
else
  echo "post-merge: DATABASE_URL unset — skipping orphan organization_connections cleanup"
fi

# Additive Creator reporting schema; credentials are provisioned separately.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/creator-subscription-dashboard.sql
fi

# 1.6. Idempotently create the doctor_profiles family of tables (Task #3632).
# These tables are declared in the Drizzle schema so push-force manages them on
# a fresh database. On databases where push-force was previously blocked by
# unrelated FK violations the tables were never created, causing every
# GET /api/cases/:id to 500. Running an explicit CREATE TABLE IF NOT EXISTS here
# ensures all database states converge before push-force runs.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' \
    || echo "post-merge: doctor_profiles migration skipped (psql unavailable)"
CREATE TABLE IF NOT EXISTS doctor_profiles (
  id                      VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_organization_id     VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doctor_name             TEXT    NOT NULL,
  provider_organization_id VARCHAR REFERENCES organizations(id) ON DELETE SET NULL,
  display_name            TEXT,
  preferences             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS doctor_profiles_lab_doctor_provider_unique
  ON doctor_profiles (lab_organization_id, doctor_name, provider_organization_id)
  WHERE provider_organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS doctor_profiles_lab_doctor_null_provider_unique
  ON doctor_profiles (lab_organization_id, doctor_name)
  WHERE provider_organization_id IS NULL;
CREATE INDEX IF NOT EXISTS doctor_profiles_lab_idx
  ON doctor_profiles (lab_organization_id);

CREATE TABLE IF NOT EXISTS doctor_phone_entries (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_profile_id  VARCHAR NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  phone_number       TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doctor_phone_entries_profile_idx
  ON doctor_phone_entries (doctor_profile_id);

CREATE TABLE IF NOT EXISTS doctor_email_entries (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_profile_id  VARCHAR NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  email              TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doctor_email_entries_profile_idx
  ON doctor_email_entries (doctor_profile_id);
SQL
else
  echo "post-merge: DATABASE_URL unset — skipping doctor_profiles migration"
fi

# 1.7. Idempotently add the four custom-shade columns (Task #3631).
# These columns are part of the Drizzle schema so push-force will manage them
# on a fresh database. On existing databases where push-force is blocked by an
# unrelated pre-existing FK violation (e.g. organization_connections orphans),
# the columns would never be created and canonical cases reads/writes would
# fail. Running an explicit idempotent ALTER TABLE ensures every database state
# gets the columns regardless of whether push-force succeeds fully.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' \
    || echo "post-merge: custom-shade column migration skipped (psql unavailable or cases table not created yet)"
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS is_custom_shade                 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_shade_technician         VARCHAR,
  ADD COLUMN IF NOT EXISTS custom_shade_pictures_available BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_shade_video_available    BOOLEAN NOT NULL DEFAULT FALSE;
SQL
else
  echo "post-merge: DATABASE_URL unset — skipping custom-shade column migration"
fi

# Provider billing consent fields are deliberately stored independently from
# Stripe processor state. Apply them explicitly so older databases converge
# even if a later broad drizzle push is blocked by unrelated legacy data.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' \
    || echo "post-merge: provider billing preference migration skipped (psql unavailable)"
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS auto_pay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_pay_charge_day INTEGER NOT NULL DEFAULT 10;
ALTER TABLE provider_payment_customers
  ADD COLUMN IF NOT EXISTS invoice_auto_pay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS invoice_auto_pay_charge_day INTEGER NOT NULL DEFAULT 10;
SQL
fi

# 1.8. Drop the per-lab unique index on accountNumber (Task #3643).
# The uniqueness constraint is now enforced per-segment in application code via
# an advisory lock (assertCustomAccountNumberAvailable). The DB index covered
# the full raw value and blocked multi-segment entries.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' \
    || echo "post-merge: account-number index drop skipped (psql unavailable)"
DROP INDEX IF EXISTS organizations_parent_lab_account_number_unique;
SQL
else
  echo "post-merge: DATABASE_URL unset — skipping account-number index drop"
fi

# 1.9. Idempotently create the AI-intake practice memory tables (Task #3978).
# Same reasoning as 1.6: both tables are declared in the Drizzle schema, so
# push-force manages them on a fresh database — but on a database where
# push-force is blocked by an unrelated pre-existing FK violation, they would
# never be created and the intake's practice memory would be dead on arrival
# (the routes now surface a loud 500 naming the missing table rather than
# silently forgetting, so the failure would be very visible).
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' \
    || echo "post-merge: rx practice-memory migration skipped (psql unavailable)"
CREATE TABLE IF NOT EXISTS rx_practice_name_aliases (
  id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_organization_id      VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rx_name                  TEXT    NOT NULL,
  provider_organization_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id       VARCHAR REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rx_practice_name_aliases_lab_rx_name_unique
  ON rx_practice_name_aliases (lab_organization_id, rx_name);
CREATE INDEX IF NOT EXISTS rx_practice_name_aliases_lab_idx
  ON rx_practice_name_aliases (lab_organization_id);

CREATE TABLE IF NOT EXISTS rx_doctor_practice_memory (
  id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_organization_id      VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doctor_name              TEXT    NOT NULL,
  provider_organization_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id       VARCHAR REFERENCES users(id) ON DELETE SET NULL
);
-- The lab + normalized-doctor-name key the upsert depends on. Without this
-- index ON CONFLICT has nothing to match and every save would insert a
-- competing row instead of overwriting.
CREATE UNIQUE INDEX IF NOT EXISTS rx_doctor_practice_memory_lab_doctor_name_unique
  ON rx_doctor_practice_memory (lab_organization_id, doctor_name);
CREATE INDEX IF NOT EXISTS rx_doctor_practice_memory_lab_idx
  ON rx_doctor_practice_memory (lab_organization_id);
SQL
else
  echo "post-merge: DATABASE_URL unset — skipping rx practice-memory migration"
fi

# Install this additive table independently: a whole-schema push can stop on
# unrelated preserved ownership findings while still returning exit status zero.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/case-saved-views.sql
fi

# 2. Apply any Drizzle schema changes brought in by the merge (non-interactive).
# With orphans cleared, the declared user_sessions.user_id -> users.id cascade
# FK now applies cleanly.
pnpm --filter @workspace/db run push-force

# These runtime-owned guards are deliberately invisible to the Drizzle diff.
# Install them before the drift gate: workflow reconciliation (and therefore
# API boot) happens only AFTER this script succeeds. Do not run the full API
# startup here, since it also runs jobs and accounting-history backfills.
pnpm --filter @workspace/scripts run install-owning-organization-guards
pnpm --filter @workspace/scripts exec tsx src/ensure-attachment-submission-indexes.ts
pnpm --filter @workspace/scripts exec tsx src/ensure-backup-download-schema.ts

# Drizzle push can occasionally exit successfully after an individual DDL
# statement was blocked by unrelated legacy data. Never let that leave the
# development database behind the schema that the next publish will query.
# This is read-only: it reports missing columns and required schema objects.
pnpm --filter @workspace/scripts run check-schema-columns
