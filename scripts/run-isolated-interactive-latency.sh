#!/usr/bin/env bash
# Repository schema only. Never connects to a shared or production database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT=0
if [ "${1:-}" = "--report" ]; then REPORT=1; shift; fi
if [ "$REPORT" -eq 1 ] && [ "$#" -gt 0 ]; then
  echo "--report takes no test arguments" >&2; exit 1
fi
TMP="$(mktemp -d /tmp/labtrax-latency.XXXXXXXX)"
STARTED=0
cleanup() {
  if [ "$STARTED" -eq 1 ]; then pg_ctl -D "$TMP/db" -m immediate stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
initdb -D "$TMP/db" -A trust --no-instructions >"$TMP/init.log" 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$TMP/db/server.key" -out "$TMP/db/server.crt" >"$TMP/tls.log" 2>&1
chmod 600 "$TMP/db/server.key"
printf "\nssl=on\nssl_cert_file='server.crt'\nssl_key_file='server.key'\n" >>"$TMP/db/postgresql.conf"
PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
mkdir "$TMP/socket"
pg_ctl -D "$TMP/db" -o "-k $TMP/socket -p $PORT -h 127.0.0.1" -l "$TMP/pg.log" start >/dev/null
STARTED=1
createdb -U "$(id -un)" -h "$TMP/socket" -p "$PORT" latency_probe
export DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/latency_probe?sslmode=verify-full&sslrootcert=$TMP/db/server.crt"
export LABTRAX_ISOLATED_LATENCY=1
export NODE_EXTRA_CA_CERTS="$TMP/db/server.crt"
export CASE_MEDIA_ROOT="$TMP/uploads"
export LABTRAX_LATENCY_ROOT="$TMP"
export LABTRAX_ENABLE_DEMO_SEEDS=false
# Children receive only a synthetic encryption secret. No host connector,
# mail, object-storage or processor credentials enter the benchmark process.
while IFS= read -r key; do
  case "$key" in
    *SECRET*|*TOKEN*|*PASSWORD*|*API_KEY*|ONEDRIVE_*|SMTP_*|VONAGE_*|STRIPE_*|PG*|PROD_*|*OBJECT_STORAGE*|PRIVATE_OBJECT_DIR|PUBLIC_OBJECT_SEARCH_PATHS)
      unset "$key" ;;
  esac
done < <(compgen -e)
export JWT_SECRET=synthetic-latency-only-not-a-real-secret
export BACKUP_ENCRYPTION_KEY=synthetic-latency-only-not-a-real-key
export LABTRAX_LATENCY_POSTGRES_MAJOR="$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
pnpm --dir "$ROOT" --filter @workspace/api-server exec node test-support/prepare-ci-database.mjs
pnpm --dir "$ROOT" --filter @workspace/db run push-force >"$TMP/schema.log" 2>&1 || { tail -20 "$TMP/schema.log"; exit 1; }
pnpm --dir "$ROOT" --filter @workspace/scripts exec tsx ../artifacts/api-server/test-support/install-ci-db-constraints.ts
ROWS=2500
if [ "$REPORT" -eq 1 ]; then
  export LABTRAX_LATENCY_REPORT_DIR="${LABTRAX_LATENCY_REPORT_DIR:-$ROOT/generated-artifacts/interactive-latency}"
  # Bounds, immutable profile metadata, capacity preflight and synthetic media.
  node "$ROOT/scripts/latency-report.mjs" prepare
  ROWS="$(node -e 'console.log(require(process.env.LABTRAX_LATENCY_REPORT_DIR+"/profile.json").dumpRows)')"
fi
if [ "$REPORT" -eq 1 ]; then
  # Independent synthetic blocks avoid a nominally large workload compressing
  # into a tiny archive and ending before the measured warm request window.
  psql -X -v ON_ERROR_STOP=1 -U "$(id -un)" -h "$TMP/socket" -p "$PORT" -d latency_probe \
    -c "CREATE TABLE latency_dump_pad AS SELECT i, (SELECT string_agg(md5(i::text || ':' || j::text),'') FROM generate_series(1,2048) j) AS payload FROM generate_series(1,$ROWS) i" >/dev/null
else
  psql -X -v ON_ERROR_STOP=1 -U "$(id -un)" -h "$TMP/socket" -p "$PORT" -d latency_probe \
    -c "CREATE TABLE latency_dump_pad AS SELECT i, repeat(md5(i::text),2048) AS payload FROM generate_series(1,$ROWS) i" >/dev/null
fi
cd "$ROOT/artifacts/api-server"
echo "Running isolated interactive benchmark; no shared database connection."
if [ "$REPORT" -eq 1 ]; then
  SAMPLES="$(node -e 'console.log(require(process.env.LABTRAX_LATENCY_REPORT_DIR+"/profile.json").samples)')"
  for ((sample=1; sample<=SAMPLES; sample++)); do
    for mode in idle dump archive; do
      for mix in notifications worklist mixed; do
        export LABTRAX_LATENCY_SAMPLE="$sample" LABTRAX_LATENCY_MODE="$mode" LABTRAX_LATENCY_MIX="$mix"
        pnpm exec vitest run src/routes/interactive-latency.test.ts --testTimeout=600000 --hookTimeout=180000
        psql -X -v ON_ERROR_STOP=1 -U "$(id -un)" -h "$TMP/socket" -p "$PORT" -d latency_probe \
          -c "VACUUM ANALYZE" >/dev/null
      done
    done
  done
  node "$ROOT/scripts/latency-report.mjs" collect
elif [ "$#" -gt 0 ]; then
  pnpm exec vitest run "$@"
else
  pnpm exec vitest run src/routes/interactive-latency.test.ts
fi
