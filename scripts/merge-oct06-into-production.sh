#!/usr/bin/env bash
# Task #4840 — merge the preserved Oct 6 database into production (the Sept 18 restore).
#
# This is the script that was executed against production on 2026-10-06. It is kept as the
# provenance record of that write. Findings, the identity map and the verified results are in
# support/recovery-comparison-2026-10-06/oct06-merge-provenance-decision.md.
#
# Safety model (mirrors scripts/restore-sep18-to-production.sh):
#   1. INSERT-ONLY. No UPDATE and no DELETE is ever issued against a live row, so nothing
#      from the Sept 18 restore can be overwritten or reactivated.
#   2. Foreign keys are NEVER dropped. PostgreSQL checks every inserted row at insert time.
#   3. The exact same transaction is rehearsed on a throwaway database restored from the
#      pre-merge production snapshot. Production is only touched if the rehearsal gate passes.
#   4. The production load is ONE transaction. Any error rolls the whole thing back.
#
# Rollback: support/prod-restored-2026-10-06/prod-restored-2026-10-06.dump
set -uo pipefail

ROOT=/home/runner/workspace
WORK=${WORK:-/tmp/labtrax-merge-4840}
SOCK="$WORK/socket"
OCT6_DUMP="$ROOT/support/prod-export-2026-10-06/prod-2026-10-06.dump"
LIVE_DUMP="$ROOT/support/prod-restored-2026-10-06/prod-restored-2026-10-06.dump"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
lpsql() { PGOPTIONS="-c default_transaction_read_only=off" psql -h "$SOCK" -U runner "$@"; }

# ---------------- 0. authenticate both archives ----------------
for d in "$OCT6_DUMP" "$LIVE_DUMP"; do
  (cd "$(dirname "$d")" && sha256sum -c "$(basename "$d").sha256") || { log "CHECKSUM FAILED: $d"; exit 1; }
done

# ---------------- 1. isolated local cluster ----------------
# TCP disabled; reachable only over the Unix socket in $WORK.
if ! pg_isready -h "$SOCK" -q 2>/dev/null; then
  mkdir -p "$WORK/data" "$WORK/log"
  initdb -D "$WORK/data" -U runner --auth=trust >/dev/null
  pg_ctl -D "$WORK/data" -l "$WORK/log/pg.log" \
    -o "-c listen_addresses='' -c unix_socket_directories=$WORK" -w start
fi

log "restoring both dumps into the isolated cluster"
lpsql -d postgres -X -q -c "DROP DATABASE IF EXISTS oct06;"    -c "CREATE DATABASE oct06;"
lpsql -d postgres -X -q -c "DROP DATABASE IF EXISTS rehearsal;" -c "CREATE DATABASE rehearsal;"
pg_restore -h "$SOCK" -U runner -d oct06     --no-owner --no-privileges -j 4 "$OCT6_DUMP"
pg_restore -h "$SOCK" -U runner -d rehearsal --no-owner --no-privileges -j 4 "$LIVE_DUMP"

# ---------------- 2. stage the Oct 6 data beside the live replica ----------------
# stg.* are bare copies (no constraints, no triggers) so conflicts can be resolved as data.
log "staging Oct 6 data into schema stg"
lpsql -d rehearsal -X -q -c "DROP SCHEMA IF EXISTS stg CASCADE; CREATE SCHEMA stg;"
TABLES=$(lpsql -d oct06 -X -A -t -c "
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.reltuples <> 0 ORDER BY 1;")
for t in $TABLES; do
  n=$(lpsql -d oct06 -X -A -t -c "SELECT count(*) FROM public.$t")
  [ "$n" -gt 0 ] || continue
  lpsql -d rehearsal -X -q -c "CREATE TABLE stg.$t (LIKE public.$t);"
  lpsql -d oct06 -X -q -c "COPY public.$t TO STDOUT" \
    | lpsql -d rehearsal -X -q -c "COPY stg.$t FROM STDIN" || { log "COPY FAILED: $t"; exit 1; }
done

# ---------------- 3. resolve identity and every natural-key collision ----------------
# Decisions are documented in oct06-merge-provenance-decision.md §4-§7. Live always wins.
log "resolving identity map and natural-key collisions"
lpsql -d rehearsal -X -v ON_ERROR_STOP=1 <<'SQL' || exit 1
-- §4 identity map: same username => same person. Keep the live ID, repoint Oct 6 references.
DROP TABLE IF EXISTS public._user_remap;
CREATE TABLE public._user_remap AS
SELECT s.id AS old_id, p.id AS new_id, p.username
FROM stg.users s JOIN public.users p ON lower(trim(s.username)) = lower(trim(p.username))
WHERE s.id <> p.id;

DO $$
DECLARE r record; n bigint; tot bigint := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT c.table_name tn, c.column_name cn
    FROM information_schema.columns c
    WHERE c.table_schema='stg'
      AND ( c.column_name ~ 'user_id|_by$|owner_id'
            OR EXISTS (SELECT 1 FROM pg_constraint con
                       JOIN unnest(con.conkey) k(attnum) ON true
                       JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum
                       WHERE con.contype='f' AND con.confrelid='public.users'::regclass
                         AND con.conrelid::regclass::text=c.table_name AND a.attname=c.column_name) )
  LOOP
    EXECUTE format('UPDATE stg.%I t SET %I = m.new_id FROM public._user_remap m WHERE t.%I = m.old_id',
                   r.tn, r.cn, r.cn);
    GET DIAGNOSTICS n = ROW_COUNT; tot := tot + n;
  END LOOP;
  RAISE NOTICE 'remapped % reference(s)', tot;
END $$;
DELETE FROM stg.users s USING public._user_remap m WHERE s.id = m.old_id;

-- §5-§7 every other PK / UNIQUE collision: keep the live row, drop the Oct 6 one.
DELETE FROM stg.lab_cases          s USING public.lab_cases          p WHERE s.id=p.id;
DELETE FROM stg.legacy_case_media  s USING public.legacy_case_media  p WHERE s.file_name=p.file_name;
DELETE FROM stg.system_settings    s USING public.system_settings    p WHERE s.key=p.key;
DELETE FROM stg.platform_account_sequences s USING public.platform_account_sequences p
  WHERE s.year=p.year AND s.entity_type=p.entity_type;
DELETE FROM stg.lab_case_projection_installation s USING public.lab_case_projection_installation p
  WHERE s.singleton=p.singleton;
DELETE FROM stg.notifications s USING public.notifications p
  WHERE s.dedupe_key IS NOT NULL AND p.dedupe_key IS NOT NULL AND s.dedupe_key=p.dedupe_key;
DELETE FROM stg.cases s USING public.cases p WHERE s.case_number=p.case_number;

-- Repair ONLY what those skips orphaned: NULL an optional parent link, drop a mandatory one.
DO $$
DECLARE r record; n bigint; pass int := 0; changed boolean := true;
        joincond text; nullcond text; setnull text;
BEGIN
  WHILE changed AND pass < 10 LOOP
    changed := false; pass := pass + 1;
    FOR r IN
      SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(an,ord)
                JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.an) AS ccols,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(an,ord)
                JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.an) AS pcols,
             (SELECT bool_and(NOT a.attnotnull) FROM unnest(con.conkey) k(an)
                JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.an) AS nullable
      FROM pg_constraint con
      WHERE con.contype='f'
        AND con.conrelid::regclass::text  IN (SELECT tablename FROM pg_tables WHERE schemaname='stg')
        AND con.confrelid::regclass::text IN (SELECT tablename FROM pg_tables WHERE schemaname='stg')
    LOOP
      SELECT string_agg(format('c.%I = p.%I', r.ccols[i], r.pcols[i]), ' AND '),
             string_agg(format('c.%I IS NOT NULL', r.ccols[i]), ' AND '),
             string_agg(format('%I = NULL', r.ccols[i]), ', ')
        INTO joincond, nullcond, setnull FROM generate_subscripts(r.ccols,1) i;
      EXECUTE format($q$CREATE TEMP TABLE _orph AS SELECT c.ctid AS rid FROM stg.%I c
          WHERE %s AND NOT EXISTS (SELECT 1 FROM stg.%I p WHERE %s)
                   AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE %s)$q$,
        r.child, nullcond, r.parent, joincond, r.parent, joincond);
      EXECUTE 'SELECT count(*) FROM _orph' INTO n;
      IF n > 0 THEN
        changed := true;
        IF r.nullable THEN
          EXECUTE format('UPDATE stg.%I SET %s WHERE ctid IN (SELECT rid FROM _orph)', r.child, setnull);
          RAISE NOTICE 'pruned (NULL) %.% : % row(s)', r.child, array_to_string(r.ccols,','), n;
        ELSE
          EXECUTE format('DELETE FROM stg.%I WHERE ctid IN (SELECT rid FROM _orph)', r.child);
          RAISE NOTICE 'pruned (delete) % : % row(s)', r.child, n;
        END IF;
      END IF;
      EXECUTE 'DROP TABLE _orph';
    END LOOP;
  END LOOP;
END $$;

-- Gate: every FK reference out of stg must resolve in (stg UNION live) before we build the load.
DO $$
DECLARE r record; n bigint; bad int := 0; joincond text; nullcond text; stgexists boolean; sql text;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
           (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(an,ord)
              JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.an) AS ccols,
           (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(an,ord)
              JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.an) AS pcols
    FROM pg_constraint con
    WHERE con.contype='f' AND con.conrelid::regclass::text IN (SELECT tablename FROM pg_tables WHERE schemaname='stg')
  LOOP
    SELECT string_agg(format('c.%I = p.%I', r.ccols[i], r.pcols[i]), ' AND '),
           string_agg(format('c.%I IS NOT NULL', r.ccols[i]), ' AND ')
      INTO joincond, nullcond FROM generate_subscripts(r.ccols,1) i;
    SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='stg' AND tablename=r.parent) INTO stgexists;
    sql := format('SELECT count(*) FROM stg.%I c WHERE %s AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE %s)',
                  r.child, nullcond, r.parent, joincond);
    IF stgexists THEN sql := sql || format(' AND NOT EXISTS (SELECT 1 FROM stg.%I p WHERE %s)', r.parent, joincond); END IF;
    EXECUTE sql INTO n;
    IF n > 0 THEN bad := bad+1; RAISE NOTICE 'UNSATISFIED %.% -> % : %', r.child, array_to_string(r.ccols,','), r.parent, n; END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION '% unsatisfied FK group(s) — refusing to build the load', bad; END IF;
  RAISE NOTICE 'all FK references from stg resolve';
END $$;
SQL

# ---------------- 4. build the single-transaction load ----------------
log "building the merge transaction"
# Parents before children. invoice_line_items self-reference is safe: FK triggers fire at
# end of statement, and each table lands in one INSERT.
lpsql -d rehearsal -X -A -t -c "
WITH RECURSIVE edges AS (
  SELECT DISTINCT con.conrelid::regclass::text child, con.confrelid::regclass::text parent
  FROM pg_constraint con
  WHERE con.contype='f'
    AND con.conrelid::regclass::text  IN (SELECT tablename FROM pg_tables WHERE schemaname='stg')
    AND con.confrelid::regclass::text IN (SELECT tablename FROM pg_tables WHERE schemaname='stg')
    AND con.conrelid <> con.confrelid),
t(name) AS (SELECT tablename FROM pg_tables WHERE schemaname='stg'),
lvl(name, depth, path) AS (
  SELECT t.name, 0, ARRAY[t.name] FROM t
  UNION ALL
  SELECT e.child, l.depth+1, l.path||e.child FROM lvl l JOIN edges e ON e.parent=l.name
  WHERE NOT e.child = ANY(l.path) AND l.depth < 25)
SELECT name FROM (SELECT name, max(depth) d FROM lvl GROUP BY name) z ORDER BY d, name;" > "$WORK/topo.txt"

pg_dump -h "$SOCK" -U runner -d rehearsal -n stg --no-owner --no-privileges -f "$WORK/stg-resolved.sql"

{
  echo "SET statement_timeout = 0;"
  echo "SET lock_timeout = 0;"
  echo "SET search_path = public;"
  echo "DROP SCHEMA IF EXISTS stg CASCADE;"
  cat "$WORK/stg-resolved.sql"
  # Preserve the ORIGINAL accounting events instead of letting the trigger synthesise new ones.
  echo "ALTER TABLE public.invoices DISABLE TRIGGER invoices_record_accounting_event;"
  cat <<SQLEOF
CREATE TEMP TABLE _merge_report(ord int, tbl text, candidates bigint, inserted bigint) ON COMMIT DROP;
DO \$merge\$
DECLARE t text; i int := 0; cand bigint; ins bigint; collist text;
  tables text[] := ARRAY[$(awk '{printf "%s'\''%s'\''", (NR>1?",":""), $0}' "$WORK/topo.txt")];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    i := i + 1;
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO collist
      FROM pg_attribute WHERE attrelid = ('stg.'||quote_ident(t))::regclass AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('SELECT count(*) FROM stg.%I', t) INTO cand;
    -- ON CONFLICT DO NOTHING is the backstop: a live row is never overwritten.
    EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM stg.%I ON CONFLICT DO NOTHING', t, collist, collist, t);
    GET DIAGNOSTICS ins = ROW_COUNT;
    INSERT INTO _merge_report VALUES (i, t, cand, ins);
  END LOOP;
END
\$merge\$;
SQLEOF
  echo "ALTER TABLE public.invoices ENABLE TRIGGER invoices_record_accounting_event;"
  echo "DROP SCHEMA stg CASCADE;"
  cat <<'SQLEOF'
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
    EXECUTE format('SELECT setval(%L, %s, %s)', r.seqname::text, GREATEST(mx,1), CASE WHEN mx>0 THEN 'true' ELSE 'false' END);
  END LOOP;
END
$resync$;
SELECT ord, tbl, candidates, inserted FROM _merge_report WHERE candidates > 0 ORDER BY ord;
SQLEOF
} > "$WORK/merge-4840.sql"
log "load built: $(ls -lh "$WORK/merge-4840.sql" | awk '{print $5}')"

VERIFY="SELECT (SELECT count(*) FROM cases) cases,(SELECT count(*) FROM invoices) invoices,
 (SELECT count(*) FROM doctor_profiles) doctors,(SELECT count(*) FROM users) users,
 (SELECT count(*) FROM organizations) orgs,(SELECT count(*) FROM case_attachments) att,
 (SELECT count(*) FROM lab_cases) legacy,(SELECT count(projected_search_document) FROM lab_cases) projected,
 (SELECT count(*) FROM payments) pay,(SELECT count(*) FROM invoice_accounting_events) acct,
 (SELECT count(*) FROM pg_constraint WHERE contype='f') fks,
 (SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated) invalid_fks,
 (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D') disabled_trg;"

# ---------------- 5. REHEARSAL on a fresh replica of live ----------------
log "rehearsal: rebuilding a throwaway replica of production"
lpsql -d postgres -X -q -c "DROP DATABASE IF EXISTS rehearsal2;" -c "CREATE DATABASE rehearsal2;"
pg_restore -h "$SOCK" -U runner -d rehearsal2 --no-owner --no-privileges -j 4 "$LIVE_DUMP"

log "rehearsal: running the transaction"
if ! lpsql -d rehearsal2 -X -q -1 -v ON_ERROR_STOP=1 -f "$WORK/merge-4840.sql" > "$WORK/log/rehearsal.log" 2>&1; then
  log "REHEARSAL FAILED — production untouched."; grep -i ERROR "$WORK/log/rehearsal.log" | head; exit 1
fi
lpsql -d rehearsal2 -X -A -F'|' -c "$VERIFY"

BADFK=$(lpsql -d rehearsal2 -X -A -t -c "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;" | tr -d '[:space:]')
DISTRG=$(lpsql -d rehearsal2 -X -A -t -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='D';" | tr -d '[:space:]')
CASES=$(lpsql -d rehearsal2 -X -A -t -c "SELECT count(*) FROM cases;" | tr -d '[:space:]')
if [ "$CASES" != "1643" ] || [ "$BADFK" != "0" ] || [ "$DISTRG" != "0" ]; then
  log "GATE FAILED (cases=$CASES invalid_fks=$BADFK disabled_triggers=$DISTRG) — production untouched."; exit 1
fi
log "gate passed: 1643 cases, all FKs valid, no triggers left disabled"

# ---------------- 6. PRODUCTION ----------------
[ -n "${PROD_DATABASE_URL:-}" ] || { log "PROD_DATABASE_URL not set"; exit 1; }
log "PRODUCTION before:"; psql "$PROD_DATABASE_URL" -X -A -F'|' -c "$VERIFY"
PRE=$(psql "$PROD_DATABASE_URL" -X -A -t -c "SELECT (SELECT count(*) FROM cases)||'/'||(SELECT count(*) FROM users)||'/'||(SELECT count(*) FROM invoices);" | tr -d '[:space:]')
if [ "$PRE" != "1345/42/1345" ]; then log "GATE FAILED: production drifted ($PRE) — not applying."; exit 1; fi

log "PRODUCTION: executing single transaction (any error rolls back everything)"
START=$(date +%s)
if psql "$PROD_DATABASE_URL" -X -q -1 -v ON_ERROR_STOP=1 -f "$WORK/merge-4840.sql" > "$WORK/log/prod-merge.log" 2>&1; then
  log "PRODUCTION MERGE: COMMITTED in $(( $(date +%s) - START ))s"
  tail -48 "$WORK/log/prod-merge.log"
else
  log "PRODUCTION MERGE: FAILED and ROLLED BACK after $(( $(date +%s) - START ))s — production unchanged"
  grep -i ERROR "$WORK/log/prod-merge.log" | head; exit 1
fi
log "PRODUCTION after:"; psql "$PROD_DATABASE_URL" -X -A -F'|' -c "$VERIFY"
log "DONE — verify with the EXCEPT ALL proof described in oct06-merge-provenance-decision.md §9"
