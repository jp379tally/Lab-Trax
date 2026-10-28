#!/usr/bin/env bash
# Rebuild the cases lost 2026-09-17 .. 2026-10-05 into production.
#
# This is the script that was executed against production on 2026-10-06. It is kept as the
# provenance record of that write. How the 248 cases were reconstructed, field by field and
# source by source, is documented in support/rebuild-lost-cases-2026-10-06/README.txt.
#
# Safety model (mirrors scripts/merge-oct06-into-production.sh):
#   1. INSERT-ONLY. The generated SQL is asserted to contain no UPDATE, DELETE, DROP,
#      TRUNCATE or ALTER, so no live row can be overwritten — including the cases the lab
#      entered by hand after the Sept 18 restore.
#   2. Foreign keys are NEVER dropped. PostgreSQL checks every inserted row at insert time.
#   3. Deterministic UUIDs + ON CONFLICT DO NOTHING: re-running is a no-op, not a duplicate.
#   4. The exact same transaction was rehearsed on a throwaway database restored from the
#      pre-rebuild production snapshot. Production is only touched if every gate passes.
#   5. The production load is ONE transaction. Any error rolls the whole thing back.
#
# Rollback: support/prod-pre-rebuild-2026-10-06/prod-pre-rebuild-2026-10-06.dump
set -uo pipefail

ROOT=/home/runner/workspace
SQL="$ROOT/support/rebuild-lost-cases-2026-10-06/rebuild.sql"
DUMP="$ROOT/support/prod-pre-rebuild-2026-10-06/prod-pre-rebuild-2026-10-06.dump"
TAG="recovery-2026-10-06"
LOG=/tmp/recovered/prod-rebuild.log

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
prod() { psql "$PROD_DATABASE_URL" -X "$@"; }

[ -n "${PROD_DATABASE_URL:-}" ] || { log "PROD_DATABASE_URL not set"; exit 1; }

# ---------------- 0. the rollback point must be intact ----------------
(cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256") \
  || { log "ROLLBACK SNAPSHOT CHECKSUM FAILED — refusing to write"; exit 1; }

# ---------------- 1. the load must be insert-only ----------------
MOD=$(grep -ciE '^[[:space:]]*(UPDATE|DELETE|DROP|TRUNCATE|ALTER|GRANT)' "$SQL")
[ "$MOD" = "0" ] || { log "GATE FAILED: $MOD row-modifying statement(s) in the load"; exit 1; }
log "gate: load is insert-only"

# ---------------- 2. no case number may collide with live production ----------------
# The lab is working in production right now and mints numbers as max+1, so this is
# re-checked against live data immediately before the write, not against the snapshot.
grep -oE "^  \('[0-9a-f-]{36}', '26-[0-9]{4}'" "$SQL" | grep -oE "26-[0-9]{4}" | sort -u > /tmp/recovered/load-casenums.txt
COUNT=$(wc -l < /tmp/recovered/load-casenums.txt)
[ "$COUNT" = "248" ] || { log "GATE FAILED: extracted $COUNT case numbers, expected 248"; exit 1; }

CLASH=$(prod -A -t -c "
  SELECT count(*) FROM cases
  WHERE deleted_at IS NULL
    AND case_number = ANY(string_to_array('$(paste -sd, /tmp/recovered/load-casenums.txt)', ','));" | tr -d '[:space:]')
[ "$CLASH" = "0" ] || { log "GATE FAILED: $CLASH case number(s) already live in production"; exit 1; }
log "gate: all 248 case numbers are free in production"

# ---------------- 3. apply ----------------
read -r B_C B_A B_O <<<"$(prod -A -t -F' ' -c \
  "SELECT (SELECT count(*) FROM cases),(SELECT count(*) FROM case_attachments),(SELECT count(*) FROM organizations);")"
log "PRODUCTION before: cases=$B_C attachments=$B_A orgs=$B_O"

log "PRODUCTION: executing single transaction (any error rolls back everything)"
START=$(date +%s)
if prod -q -1 -v ON_ERROR_STOP=1 -f "$SQL" > "$LOG" 2>&1; then
  log "PRODUCTION REBUILD: COMMITTED in $(( $(date +%s) - START ))s"
  tail -5 "$LOG"
else
  log "PRODUCTION REBUILD: FAILED and ROLLED BACK after $(( $(date +%s) - START ))s — production unchanged"
  grep -i ERROR "$LOG" | head; exit 1
fi

# ---------------- 4. verify ----------------
read -r A_C A_A A_O <<<"$(prod -A -t -F' ' -c \
  "SELECT (SELECT count(*) FROM cases),(SELECT count(*) FROM case_attachments),(SELECT count(*) FROM organizations);")"
log "PRODUCTION after:  cases=$A_C attachments=$A_A orgs=$A_O"
log "delta: cases=$((A_C-B_C)) attachments=$((A_A-B_A)) orgs=$((A_O-B_O))  (expect 248 / 589 / 1)"

prod -A -F' | ' -c "
SELECT (SELECT count(*) FROM cases WHERE ai_import_source = '$TAG')                      AS rebuilt_cases,
       (SELECT count(*) FROM case_attachments a JOIN cases c ON c.id = a.case_id
          WHERE c.ai_import_source = '$TAG')                                             AS rebuilt_attachments,
       (SELECT count(*) FROM cases WHERE ai_import_source IS DISTINCT FROM '$TAG')       AS pre_existing_cases,
       (SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated)       AS invalid_fks,
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D')        AS disabled_triggers,
       (SELECT count(*) FROM (SELECT case_number FROM cases WHERE deleted_at IS NULL
                              GROUP BY 1 HAVING count(*)>1) d)                           AS duplicate_case_numbers;"

[ "$((A_C-B_C))" = "248" ] && [ "$((A_A-B_A))" = "589" ] \
  && log "DONE — $B_C pre-existing cases preserved, 248 rebuilt cases added" \
  || { log "POST-CHECK MISMATCH — inspect before trusting this run"; exit 1; }
