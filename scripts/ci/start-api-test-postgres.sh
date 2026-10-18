#!/usr/bin/env bash
set -euo pipefail

: "${LABTRAX_TEST_SCRATCH_ROOT:?Prepare workspace test scratch before starting PostgreSQL}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

ROOT="$LABTRAX_TEST_SCRATCH_ROOT/labtrax-api-test-postgres"
PGDATA="$ROOT/data"
PORT=54321
DB_NAME=labtrax_ci
DB_USER=labtrax_ci
OWNER_MARKER="$LABTRAX_TEST_SCRATCH_ROOT/.labtrax-test-scratch-owner"

[[ -f "$OWNER_MARKER" && "$(<"$OWNER_MARKER")" == "labtrax-workspace-test-scratch-v1" ]] || {
  echo "The API database requires scratch created by with-workspace-test-scratch.sh." >&2
  exit 1
}
if [[ -e "$ROOT" ]]; then
  echo "The isolated API test PostgreSQL path already exists; refusing to reuse it." >&2
  exit 1
fi

mkdir -m 700 -p "$ROOT"
if command -v initdb >/dev/null 2>&1; then
  BINDIR="$(dirname "$(command -v initdb)")"
elif command -v pg_config >/dev/null 2>&1; then
  BINDIR="$(pg_config --bindir)"
else
  echo "PostgreSQL 16 test tools are not on PATH and pg_config is unavailable." >&2
  exit 1
fi
for tool in initdb pg_ctl pg_isready createdb psql; do
  [[ -x "$BINDIR/$tool" ]] || {
    echo "Missing PostgreSQL 16 test tool: $BINDIR/$tool" >&2
    exit 1
  }
done

if "$BINDIR/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is already in use; refusing to connect to an existing database." >&2
  exit 1
fi

PASSWORD="$(openssl rand -hex 32)"
JWT_SECRET="$(openssl rand -hex 32)"
BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)"
[[ "$JWT_SECRET" != "$BACKUP_ENCRYPTION_KEY" ]] || {
  echo "Could not generate distinct ephemeral API and backup test keys." >&2
  exit 1
}
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::$PASSWORD"
  echo "::add-mask::$JWT_SECRET"
  echo "::add-mask::$BACKUP_ENCRYPTION_KEY"
fi
umask 077
printf '%s' "$PASSWORD" >"$ROOT/bootstrap-password"

"$BINDIR/initdb" \
  --username="$DB_USER" \
  --pwfile="$ROOT/bootstrap-password" \
  --auth-local=trust \
  --auth-host=scram-sha-256 \
  --no-instructions \
  --pgdata="$PGDATA" >"$ROOT/initdb.log" 2>&1
rm -f -- "$ROOT/bootstrap-password"
printf "unix_socket_directories = ''\n" >>"$PGDATA/postgresql.conf"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$PGDATA/server.key" \
  -out "$PGDATA/server.crt" >"$ROOT/openssl.log" 2>&1
chmod 600 "$PGDATA/server.key"
chmod 644 "$PGDATA/server.crt"

"$BINDIR/pg_ctl" -D "$PGDATA" \
  -o "-h 127.0.0.1 -p $PORT -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c ssl_cert_file=server.crt -c ssl_key_file=server.key" \
  -l "$ROOT/postgres.log" start >/dev/null

for _ in {1..30}; do
  if "$BINDIR/pg_isready" -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export PGHOST=127.0.0.1
export PGPORT="$PORT"
export PGUSER="$DB_USER"
export PGPASSWORD="$PASSWORD"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$PGDATA/server.crt"

"$BINDIR/psql" -X -v ON_ERROR_STOP=1 -d postgres \
  -Atqc 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' |
  grep -qx t || {
    echo "The isolated API test database did not establish a verified TLS connection." >&2
    exit 1
  }

"$BINDIR/createdb" -h 127.0.0.1 -p "$PORT" -U "$DB_USER" "$DB_NAME"

# The test runner uses the same verified-TLS URL format as the production
# database client. Random database, login, and backup keys exist only in this
# job's private workspace scratch and GitHub's masked per-job environment.
printf 'DATABASE_URL=postgresql://%s:%s@127.0.0.1:%s/%s?sslmode=verify-full&sslrootcert=%s\n' \
  "$DB_USER" "$PASSWORD" "$PORT" "$DB_NAME" "$PGDATA/server.crt" >>"$GITHUB_ENV"
printf 'JWT_SECRET=%s\nBACKUP_ENCRYPTION_KEY=%s\nLABTRAX_ENABLE_DEMO_SEEDS=false\n' \
  "$JWT_SECRET" "$BACKUP_ENCRYPTION_KEY" >>"$GITHUB_ENV"
printf 'LABTRAX_CI_PGDATA=%s\n' "$PGDATA" >>"$GITHUB_ENV"
printf '%s\n' "$BINDIR" >>"$GITHUB_PATH"
