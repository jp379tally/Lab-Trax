#!/usr/bin/env bash
# One-shot recovery: load the verified 2026-09-18 LabTrax backup into production.
# Safety model:
#   1. A full production export was taken first (support/prod-export-2026-10-06/).
#   2. The exact same transaction is rehearsed on a scratch DB built from the
#      CURRENT production schema. Production is only touched if that passes.
#   3. The production load is ONE transaction. Any error rolls the whole thing
#      back and leaves production exactly as it was.
set -uo pipefail

SOCK=/tmp/labtrax-staged-recovery-PETBoC/socket
SCHEMA=/home/runner/workspace/support/prod-export-2026-10-06/prod-2026-10-06.schema.sql
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
lpsql() { PGOPTIONS="-c default_transaction_read_only=off" psql -h "$SOCK" -U runner "$@"; }

# ---------- extra steps beyond the proven rehearsal ----------
cat > /tmp/seq-resync.sql <<'SQL'
DO $resync$
DECLARE r record; mx bigint;
BEGIN
  FOR r IN
    SELECT seq.oid::regclass AS seqname, tab.oid::regclass AS tabname, att.attname AS colname
    FROM pg_class seq
    JOIN pg_depend d ON d.objid = seq.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a'
    JOIN pg_class tab ON tab.oid = d.refobjid
    JOIN pg_attribute att ON att.attrelid = tab.oid AND att.attnum = d.refobjsubid
    WHERE seq.relkind = 'S'
  LOOP
    EXECUTE format('SELECT COALESCE(max(%I),0) FROM %s', r.colname, r.tabname) INTO mx;
    EXECUTE format('SELECT setval(%L, %s, %s)', r.seqname::text, GREATEST(mx, 1),
                   CASE WHEN mx > 0 THEN 'true' ELSE 'false' END);
  END LOOP;
END
$resync$;
SQL

# repopulate the prod-only legacy search projection via its own trigger
echo "UPDATE public.lab_cases SET id = id;" > /tmp/projection-backfill.sql

{
  echo "SET statement_timeout = 0;"
  echo "SET lock_timeout = 0;"
  echo "SET search_path = public;"
  cat /tmp/trig-off.sql          # disable user triggers (immutability guards, projections)
  cat /tmp/fk-drop.sql           # 207 FK constraints
  cat /tmp/truncate.sql          # 116 shared tables
  cat /tmp/sep18-data.sql        # Sept 18 data
  echo "SELECT pg_catalog.set_config('search_path', 'public', false);"
  cat /tmp/fk-add.sql            # re-add + validate all 207 FKs
  cat /tmp/trig-on.sql           # re-enable triggers
  cat /tmp/seq-resync.sql
  cat /tmp/projection-backfill.sql
} > /tmp/restore-final.sql
log "script built: $(ls -lh /tmp/restore-final.sql | awk '{print $5}')"

VERIFY="SELECT (SELECT count(*) FROM cases) cases,
       (SELECT count(*) FROM invoices) invoices,
       (SELECT count(*) FROM doctor_profiles) doctors,
       (SELECT count(*) FROM users) users,
       (SELECT count(*) FROM organizations) orgs,
       (SELECT count(*) FROM case_attachments) attachments,
       (SELECT count(*) FROM lab_cases) legacy_cases,
       (SELECT count(projected_search_document) FROM lab_cases) legacy_projected,
       (SELECT count(*) FROM pg_constraint WHERE contype='f') fks,
       (SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated) invalid_fks,
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D') disabled_triggers;"

# ---------------- REHEARSAL ----------------
log "rehearsal: rebuilding scratch database from CURRENT production schema"
lpsql -d postgres -X -q -c "DROP DATABASE IF EXISTS labtrax_rehearsal;" >/dev/null 2>&1
lpsql -d postgres -X -q -c "CREATE DATABASE labtrax_rehearsal;" >/dev/null 2>&1
lpsql -d labtrax_rehearsal -X -q -f "$SCHEMA" >/dev/null 2>&1

log "rehearsal: running the transaction"
if ! lpsql -d labtrax_rehearsal -X -q -1 -v ON_ERROR_STOP=1 -f /tmp/restore-final.sql > /tmp/rehearsal-final.log 2>&1; then
  log "REHEARSAL FAILED — aborting. Production untouched."
  grep -i 'ERROR' /tmp/rehearsal-final.log | head -10
  exit 1
fi
log "rehearsal result:"
lpsql -d labtrax_rehearsal -X -A -F'|' -c "$VERIFY"

CASES=$(lpsql -d labtrax_rehearsal -X -A -t -c "SELECT count(*) FROM cases;" | tr -d '[:space:]')
BADFK=$(lpsql -d labtrax_rehearsal -X -A -t -c "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;" | tr -d '[:space:]')
DISTRG=$(lpsql -d labtrax_rehearsal -X -A -t -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D';" | tr -d '[:space:]')
if [ "$CASES" != "1345" ] || [ "$BADFK" != "0" ] || [ "$DISTRG" != "0" ]; then
  log "GATE FAILED (cases=$CASES invalid_fks=$BADFK disabled_triggers=$DISTRG) — production untouched."
  exit 1
fi
log "gate passed: 1345 cases, all FKs valid, no triggers left disabled"

# ---------------- PRODUCTION ----------------
log "PRODUCTION pre-restore state:"
psql "$PROD_DATABASE_URL" -X -A -F'|' -c "$VERIFY"

log "PRODUCTION: executing single transaction (any error rolls back everything)"
START=$(date +%s)
if psql "$PROD_DATABASE_URL" -X -q -1 -v ON_ERROR_STOP=1 -f /tmp/restore-final.sql > /tmp/prod-restore.log 2>&1; then
  log "PRODUCTION RESTORE: COMMITTED in $(( $(date +%s) - START ))s"
else
  log "PRODUCTION RESTORE: FAILED and ROLLED BACK after $(( $(date +%s) - START ))s — production unchanged"
  grep -i 'ERROR' /tmp/prod-restore.log | head -10
  exit 1
fi

log "PRODUCTION post-restore state:"
psql "$PROD_DATABASE_URL" -X -A -F'|' -c "$VERIFY"
log "DONE"
