#!/usr/bin/env bash
# Run destructive backup/restore integration tests against a disposable local DB.
# The shared development DB is read only for its current schema; no data is copied.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DATABASE_URL:?DATABASE_URL is required to clone the schema for the restore gate}"

for tool in initdb pg_ctl pg_dump psql createdb openssl node; do
  command -v "$tool" >/dev/null || { echo "Missing restore-gate tool: $tool" >&2; exit 1; }
done

RESTORE_ARCHIVE_PATH=""
if [ -n "${LABTRAX_BACKUP_ARCHIVE_PATH:-}" ]; then
  if [ ! -f "$LABTRAX_BACKUP_ARCHIVE_PATH" ]; then
    echo "LABTRAX_BACKUP_ARCHIVE_PATH must point to an existing encrypted archive." >&2
    exit 1
  fi
  RESTORE_ARCHIVE_PATH="$(node -e \
    'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' \
    "$LABTRAX_BACKUP_ARCHIVE_PATH")"
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

# A schema-only clone gives the test its real current tables/triggers without
# cloning customer records (or restoring over the shared DB).
pg_dump --dbname="$DATABASE_URL" --schema-only --no-owner --no-privileges \
  --file="$TMP_DIR/schema.sql"
initdb -D "$TMP_DIR/pgdata" -A trust --no-instructions >"$TMP_DIR/initdb.log" 2>&1
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
LOCAL_USER="$(id -un)"
LOCAL_DB="labtrax_restore_test"
createdb -U "$LOCAL_USER" -h "$TMP_DIR/socket" -p "$PORT" "$LOCAL_DB"
psql -X -v ON_ERROR_STOP=1 -U "$LOCAL_USER" \
  -h "$TMP_DIR/socket" -p "$PORT" -d "$LOCAL_DB" \
  -f "$TMP_DIR/schema.sql" >"$TMP_DIR/schema-import.log" 2>&1 || {
    tail -40 "$TMP_DIR/schema-import.log" >&2
    exit 1
  }
# The checked-in pre-migration archive names this role as an object owner.
psql -X -v ON_ERROR_STOP=1 -U "$LOCAL_USER" \
  -h "$TMP_DIR/socket" -p "$PORT" -d "$LOCAL_DB" \
  -c 'CREATE ROLE postgres' >/dev/null

# Ensure the disposable restore DB has the Rx-history schema even when the
# schema-only source snapshot predates migration 0030. The migration is
# idempotent, so applying it after a current schema clone is also safe.
psql -X -v ON_ERROR_STOP=1 -U "$LOCAL_USER" \
  -h "$TMP_DIR/socket" -p "$PORT" -d "$LOCAL_DB" \
  -f "$REPO_ROOT/lib/db/drizzle/0030_case_rx_note_history.sql" \
  >"$TMP_DIR/rx-history-migration.log" 2>&1 || {
    tail -40 "$TMP_DIR/rx-history-migration.log" >&2
    exit 1
  }

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

export DATABASE_URL="postgresql://${LOCAL_USER}@127.0.0.1:${PORT}/${LOCAL_DB}?sslmode=verify-full&sslrootcert=${TMP_DIR}/pgdata/server.crt"
export LABTRAX_ISOLATED_RESTORE_ROOT="$TMP_DIR"
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
echo "Running backup/restore gate against a disposable schema-only database."
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
  --config vitest.restore.config.ts --reporter=verbose "$@"

# Optionally restore a real encrypted full archive into the same disposable
# schema-only database after the round-trip suite. This is used to verify a
# production recovery point without ever pointing pg_restore at a shared DB.
if [ -n "${LABTRAX_BACKUP_ARCHIVE_PATH:-}" ]; then
  echo "Restoring the supplied full archive into the disposable database."
  export LABTRAX_BACKUP_ARCHIVE_PATH="$RESTORE_ARCHIVE_PATH"
  "$REPO_ROOT/artifacts/api-server/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/src/restore-isolated-backup-archive.ts"
fi