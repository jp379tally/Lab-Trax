#!/usr/bin/env bash
# Restore ONLY into a disposable private local cluster, then use the canonical
# operator pipeline. This script never connects to production for a write.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -ne 4 ]; then
  echo "Usage: bash scripts/rehearse-recovery-billing.sh PRIVATE_BACKUP.dump PLAN.json LAB_ADMIN_ID REPORT.json" >&2
  exit 2
fi
BACKUP="$(realpath "$1")"
PLAN="$(realpath "$2")"
ACTOR="$3"
REPORT="$(realpath -m "$4")"
for tool in initdb postgres pg_isready pg_restore createdb openssl node pnpm; do
  command -v "$tool" >/dev/null || { echo "Missing rehearsal tool: $tool" >&2; exit 1; }
done
[ -s "$BACKUP" ] || { echo "Rollback dump missing or empty" >&2; exit 1; }
pg_restore --list "$BACKUP" >/dev/null
TMP="$(mktemp -d /tmp/labtrax-billing-rehearsal.XXXXXXXX)"
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
initdb -D "$TMP/pgdata" -A trust --no-instructions >"$TMP/initdb.log" 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$TMP/pgdata/server.key" -out "$TMP/pgdata/server.crt" >"$TMP/cert.log" 2>&1
chmod 600 "$TMP/pgdata/server.key"
cat >>"$TMP/pgdata/postgresql.conf" <<'EOF'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
EOF
PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
mkdir "$TMP/socket"
postgres -D "$TMP/pgdata" -k "$TMP/socket" -p "$PORT" -h 127.0.0.1 >"$TMP/postgres.log" 2>&1 &
PID="$!"
for _ in $(seq 1 100); do
  if pg_isready -h "$TMP/socket" -p "$PORT" >/dev/null 2>&1; then break; fi
  kill -0 "$PID" 2>/dev/null || { echo "Isolated PostgreSQL failed to start" >&2; exit 1; }
  sleep 0.1
done
USER="$(id -un)"
DB="labtrax_recovery_billing_rehearsal"
createdb -U "$USER" -h "$TMP/socket" -p "$PORT" "$DB"
if ! pg_restore --exit-on-error --no-owner --no-privileges -U "$USER" -h "$TMP/socket" \
  -p "$PORT" -d "$DB" "$BACKUP" >"$TMP/restore.log" 2>&1; then
  echo "Full isolated restore failed; no rehearsal approval produced. Preserve the fresh source and fix restore compatibility." >&2
  exit 1
fi
cd "$ROOT"
DATABASE_URL="postgresql://${USER}@127.0.0.1:${PORT}/${DB}?sslmode=verify-full" \
NODE_EXTRA_CA_CERTS="$TMP/pgdata/server.crt" \
  pnpm --filter @workspace/scripts exec tsx src/recovery-billing.ts rehearse \
  --plan "$PLAN" --backup "$BACKUP" --actor "$ACTOR" --output "$REPORT"
