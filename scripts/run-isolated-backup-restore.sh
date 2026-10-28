#!/usr/bin/env bash
# Run destructive backup/restore integration tests against a disposable local DB.
# Build its empty schema from source. Never connect to a configured shared DB.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
if [[ -z "${LABTRAX_TEST_SCRATCH_ROOT:-}" ]]; then
  exec bash "$REPO_ROOT/scripts/with-workspace-test-scratch.sh" -- bash "$0" "$@"
fi
OWNER_MARKER="$LABTRAX_TEST_SCRATCH_ROOT/.labtrax-test-scratch-owner"
[[ -f "$OWNER_MARKER" && "$(<"$OWNER_MARKER")" == "labtrax-workspace-test-scratch-v1" ]] || {
  echo "The restore gate requires owned workspace test scratch." >&2
  exit 1
}

for tool in initdb pg_ctl pg_dump psql createdb openssl node; do
  command -v "$tool" >/dev/null || { echo "Missing restore-gate tool: $tool" >&2; exit 1; }
done

RESTORE_ARCHIVE_PATH=""
RESTORE_ARCHIVE_KEY=""
if [ -n "${LABTRAX_BACKUP_ARCHIVE_PATH:-}" ]; then
  if [ ! -f "$LABTRAX_BACKUP_ARCHIVE_PATH" ]; then
    echo "LABTRAX_BACKUP_ARCHIVE_PATH must point to an existing encrypted archive." >&2
    exit 1
  fi
  RESTORE_ARCHIVE_PATH="$(node -e \
    'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' \
    "$LABTRAX_BACKUP_ARCHIVE_PATH")"
  # Preserve the operator-supplied key only for the explicitly requested archive
  # rehearsal after synthetic tests. Never use it to encrypt test fixtures.
  RESTORE_ARCHIVE_KEY="${BACKUP_ENCRYPTION_KEY:-${JWT_SECRET:-}}"
  [[ -n "$RESTORE_ARCHIVE_KEY" ]] || {
    echo "The explicitly supplied archive requires its existing out-of-band decryption key." >&2
    exit 1
  }
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/labtrax-restore-gate.XXXXXXXX")"
SERVER_STARTED=0
cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    pg_ctl -D "$TMP_DIR/pgdata" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Do not inherit database bindings or live signing/encryption keys. The restore
# test database and archives use distinct disposable credentials for this run.
unset DATABASE_URL PROD_DATABASE_URL PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD PGSSLMODE PGSSLROOTCERT
export NODE_ENV=test LABTRAX_ENABLE_DEMO_SEEDS=false
export JWT_SECRET="$(openssl rand -hex 32)"
export BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export SESSION_SECRET="$(openssl rand -hex 32)"
[[ "$JWT_SECRET" != "$BACKUP_ENCRYPTION_KEY" ]] || {
  echo "Could not generate distinct ephemeral signing and backup keys." >&2
  exit 1
}
LOCAL_USER="labtrax_restore_test"
LOCAL_PASSWORD="$(openssl rand -hex 32)"
[[ "$LOCAL_PASSWORD" =~ ^[[:xdigit:]]{64}$ ]] || {
  echo "Could not generate an ephemeral local restore-test password." >&2
  exit 1
}
ISOLATED_TEST_CONFIG="${LABTRAX_ISOLATED_TEST_CONFIG:-vitest.restore.config.ts}"
case "$ISOLATED_TEST_CONFIG" in
  vitest.restore.config.ts|vitest.config.ts) ;;
  *)
    echo "Only the repository's restore or API test config is allowed in the isolated runner." >&2
    exit 1
    ;;
esac
umask 077
printf '%s' "$LOCAL_PASSWORD" >"$TMP_DIR/bootstrap-password"
initdb -D "$TMP_DIR/pgdata" --username="$LOCAL_USER" \
  --pwfile="$TMP_DIR/bootstrap-password" --auth-local=trust \
  --auth-host=scram-sha-256 --no-instructions >"$TMP_DIR/initdb.log" 2>&1
rm -f -- "$TMP_DIR/bootstrap-password"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$TMP_DIR/pgdata/server.key" -out "$TMP_DIR/pgdata/server.crt" \
  >"$TMP_DIR/openssl.log" 2>&1
chmod 600 "$TMP_DIR/pgdata/server.key"
cat >>"$TMP_DIR/pgdata/postgresql.conf" <<'EOF'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
EOF

# Node's production pool requires verified TLS, even for the local test DB.
PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
mkdir -p "$TMP_DIR/socket"
pg_ctl -D "$TMP_DIR/pgdata" \
  -o "-k $TMP_DIR/socket -p $PORT -h 127.0.0.1" \
  -l "$TMP_DIR/postgres.log" start >/dev/null
SERVER_STARTED=1
LOCAL_DB="labtrax_restore_test"
createdb -U "$LOCAL_USER" -h "$TMP_DIR/socket" -p "$PORT" "$LOCAL_DB"
export DATABASE_URL="postgresql://${LOCAL_USER}:${LOCAL_PASSWORD}@127.0.0.1:${PORT}/${LOCAL_DB}?sslmode=verify-full&sslrootcert=${TMP_DIR}/pgdata/server.crt"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -Atqc 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' | grep -qx t
# Current source declarations create the empty schema; application startup in
# the tests still installs its real integrity guards. No customer schema/data
# dump or ignored binary fixture is required for a clean-checkout restore gate.
pnpm --filter @workspace/api-server exec node test-support/prepare-ci-database.mjs \
  >"$TMP_DIR/extensions.log" 2>&1 || {
    tail -20 "$TMP_DIR/extensions.log" >&2
    exit 1
  }
pnpm --filter @workspace/db exec drizzle-kit export \
  --config ./drizzle.config.ts >"$TMP_DIR/schema.sql" 2>"$TMP_DIR/schema-export.log" || {
    tail -40 "$TMP_DIR/schema-export.log" >&2
    exit 1
  }
# Non-interactive push can leave tables present while omitting an index.
# Apply the complete declared DDL atomically and fail on the first SQL error.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
  -f "$TMP_DIR/schema.sql" >"$TMP_DIR/schema-import.log" 2>&1 || {
    tail -40 "$TMP_DIR/schema-import.log" >&2
    exit 1
  }
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
  "SELECT to_regclass('provider_auto_pay_attempts_schedule_unique') IS NOT NULL" | grep -qx t
# The checked-in pre-migration archive names this role as an object owner.
psql -X -v ON_ERROR_STOP=1 -U "$LOCAL_USER" \
  -h "$TMP_DIR/socket" -p "$PORT" -d "$LOCAL_DB" \
  -c 'CREATE ROLE postgres' >/dev/null

# Exercise the idempotent Rx-history migration against the source-built schema.
psql -X -v ON_ERROR_STOP=1 -U "$LOCAL_USER" \
  -h "$TMP_DIR/socket" -p "$PORT" -d "$LOCAL_DB" \
  -f "$REPO_ROOT/lib/db/drizzle/0030_case_rx_note_history.sql" \
  >"$TMP_DIR/rx-history-migration.log" 2>&1 || {
    tail -40 "$TMP_DIR/rx-history-migration.log" >&2
    exit 1
  }

# The merged intake migration must also tolerate schemas already updated by
# the supported source-schema push path. Rehearse twice in this empty clone.
for pass in 1 2; do
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
    -f "$REPO_ROOT/lib/db/drizzle/0035_ai_intake_review_snapshot.sql" \
    >"$TMP_DIR/intake-migration-$pass.log" 2>&1 || {
      echo "The AI intake migration failed its isolated repeat-application rehearsal." >&2
      exit 1
    }
done
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
  "SELECT count(*)=8 FROM information_schema.columns WHERE table_schema='public' AND ((table_name='cases' AND ((column_name IN ('prescription_due_date','scan_date') AND data_type='date') OR (column_name='provider_contact_snapshot' AND data_type='jsonb'))) OR (table_name='organizations' AND column_name IN ('billing_address_line_1','billing_address_line_2','billing_city','billing_state','billing_zip') AND data_type='text'))" | grep -qx t

# Keep process.cwd()-based uploads, snapshots and restore trash out of the
# project's real uploads directory. Mirror the workspace path layout so pnpm's
# relative @workspace and .pnpm symlinks still resolve to the actual packages.
TEST_ROOT="$TMP_DIR/workspace"
# The route registry may import recovery billing during startup. Point its
# optional loader at an intentionally absent synthetic location so this backup
# gate never reads or copies private recovery records.
export LABTRAX_RECOVERY_DATA_DIR="$TMP_DIR/no-private-recovery-data"
TEST_PACKAGE="$TEST_ROOT/artifacts/api-server"
mkdir -p "$TEST_PACKAGE"
cp -a "$REPO_ROOT/artifacts/api-server/src" \
  "$REPO_ROOT/artifacts/api-server/vitest.restore.config.ts" \
  "$REPO_ROOT/artifacts/api-server/vitest.config.ts" \
  "$REPO_ROOT/artifacts/api-server/tsconfig.json" \
  "$REPO_ROOT/artifacts/api-server/package.json" "$TEST_PACKAGE/"
cp -a "$REPO_ROOT/artifacts/api-server/node_modules" "$TEST_PACKAGE/node_modules"
ln -s "$REPO_ROOT/node_modules" "$TEST_ROOT/node_modules"
ln -s "$REPO_ROOT/lib" "$TEST_ROOT/lib"
ln -s "$REPO_ROOT/scripts" "$TEST_ROOT/scripts"
ln -s "$REPO_ROOT/tsconfig.base.json" "$TEST_ROOT/tsconfig.base.json"

# Exercise the packaged-binary path, not just PATH resolution.
#
# The published server starts with a minimal PATH that has no Nix toolchain, so
# a bare spawn("pg_dump") fails there with ENOENT while the dev workspace keeps
# working — which is how production ran for weeks taking no backups. The image
# build stages launchers under <root>/.production-runtime/bin; staging the same
# layout here makes the gate resolve the tools exactly the way production does
# instead of silently falling back to PATH.
PACKAGED_BIN="$TEST_ROOT/.production-runtime/bin"
mkdir -p "$PACKAGED_BIN"
for pg_tool in pg_dump pg_restore; do
  pg_tool_path="$(command -v "$pg_tool")"
  cat >"$PACKAGED_BIN/$pg_tool" <<EOF
#!/bin/sh
# Stand-in for the launcher scripts/prepare-production-image.sh writes.
exec "$pg_tool_path" "\$@"
EOF
  chmod 0755 "$PACKAGED_BIN/$pg_tool"
done

export LABTRAX_ISOLATED_RESTORE_ROOT="$TMP_DIR"
# Exercise the append-only media-reference journal only inside this script's
# owned local PostgreSQL cluster. The harness also requires its current working
# directory to remain beneath that owned scratch root; run it from the isolated
# workspace (not the repository checkout) while retaining the source script path.
(
  cd "$TEST_ROOT"
  node --import tsx "$REPO_ROOT/scripts/test-production-media-journal.mjs"
)
# Never let a downloaded complete archive write into the production bucket
# inherited by this workspace. Cloud recovery requires an explicit disposable
# namespace; tests otherwise use their synthetic in-memory object store.
if [ -n "${LABTRAX_RESTORE_OBJECT_DIR:-}" ]; then
  RESTORE_OBJECT_DIR="$(node --input-type=module -e '
    const normalize = value => (value ?? "").trim().replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    const destination = normalize(process.env.LABTRAX_RESTORE_OBJECT_DIR);
    const source = normalize(process.env.PRIVATE_OBJECT_DIR);
    const isWithin = (candidate, root) => candidate === root || candidate.startsWith(`${root}/`);
    const parts = destination.split("/");

    if (parts.length < 2 || parts.some(part => !part || part === "." || part === ".." || /\s/.test(part))) {
      console.error("LABTRAX_RESTORE_OBJECT_DIR must be a private bucket/prefix path.");
      process.exit(1);
    }
    if (source && (isWithin(destination, source) || isWithin(source, destination))) {
      console.error("Restore namespace must not overlap the source private object namespace.");
      process.exit(1);
    }
    const publicPrefixes = (process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "")
      .split(",")
      .map(normalize)
      .filter(Boolean);
    if (publicPrefixes.some(prefix => isWithin(destination, prefix) || isWithin(prefix, destination))) {
      console.error("Restore namespace must not overlap a publicly served object prefix.");
      process.exit(1);
    }
    process.stdout.write(destination);
  ')"
  export PRIVATE_OBJECT_DIR="$RESTORE_OBJECT_DIR"
else
  unset PRIVATE_OBJECT_DIR
fi
echo "Running backup/restore gate against a source-built, disposable synthetic TLS database."
# Includes off-site OneDrive and Google Drive round trips. Each provider suite
# skips itself, loudly, unless its connector and the isolated private-object
# destination are available, so the rest of the gate still runs offline.
if [ -z "${REPLIT_CONNECTORS_HOSTNAME:-}" ]; then
  echo "NOTE: no cloud connector is available in this environment — off-site round trips will skip." >&2
fi
if [ -z "${LABTRAX_RESTORE_OBJECT_DIR:-}" ]; then
  echo "NOTE: LABTRAX_RESTORE_OBJECT_DIR is not configured — off-site round trips will skip." >&2
fi
cd "$TEST_PACKAGE"
if [[ "$ISOLATED_TEST_CONFIG" == "vitest.config.ts" ]]; then
  # Source DDL does not contain startup-installed constraint triggers. Install
  # the same guards as the API server, only in this owned disposable database.
  node --import tsx -e '(async () => {
    const { ensureDbConstraints } = await import("./src/lib/db-constraints.ts");
    const { pool } = await import("@workspace/db");
    try { await ensureDbConstraints(); } finally { await pool.end(); }
  })().catch(error => { console.error(error); process.exitCode = 1; })'
  # Keep the ordinary API gate's schema precondition, but check only this
  # freshly created, owned TLS database rather than the configured shared DB.
  node --import tsx "$REPO_ROOT/scripts/src/check-practice-authorization-schema.ts"
fi
node --import tsx --input-type=module -e '
  const { ensureBackupHistorySchema } = await import("./src/lib/backup-history-schema.ts");
  const { pool } = await import("@workspace/db");
  try { await ensureBackupHistorySchema(); } finally { await pool.end(); }
'

# The resolver must find the packaged copies from the process cwd before any
# test runs; otherwise the gate would prove nothing about production.
node --input-type=module -e '
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
const binDir = path.resolve(process.cwd(), "../../.production-runtime/bin");
for (const tool of ["pg_dump", "pg_restore"]) {
  const candidate = path.join(binDir, tool);
  fs.accessSync(candidate, fs.constants.X_OK);
}
console.log("Packaged PostgreSQL client tools staged at " + binDir);
'

"$REPO_ROOT/artifacts/api-server/node_modules/.bin/vitest" run \
  --config "$ISOLATED_TEST_CONFIG" --reporter=verbose "$@"

# Optionally restore a real encrypted full archive into the same disposable
# schema-only database after the round-trip suite. This is used to verify a
# production recovery point without ever pointing pg_restore at a shared DB.
if [ -n "${LABTRAX_BACKUP_ARCHIVE_PATH:-}" ]; then
  echo "Restoring the supplied full archive into the disposable database."
  export LABTRAX_BACKUP_ARCHIVE_PATH="$RESTORE_ARCHIVE_PATH"
  export BACKUP_ENCRYPTION_KEY="$RESTORE_ARCHIVE_KEY"
  "$REPO_ROOT/artifacts/api-server/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/src/restore-isolated-backup-archive.ts"
fi
