/**
 * Projected list columns for legacy (mobile) cases — Task #4371.
 *
 * Legacy cases live in `lab_cases` as one JSON text blob per row. The case
 * lists only ever need a dozen short values out of that blob (case number,
 * patient, doctor, status, priority, barcode, due date, price, category,
 * taxonomy) plus a handful of display extras, but they used to re-extract
 * them with ~15 regex passes over EVERY blob in the caller's labs before
 * pagination. Several of those passes call `lower(case_data)`, which copies
 * the whole blob. With embedded base64 photos (tens of megabytes per lab)
 * a 10-row page cost seconds.
 *
 * This module owns the write-side half of the fix:
 *
 *   • idempotent DDL that adds the projected columns and the indexes the
 *     lists need (startup DDL rather than schema push: this database is
 *     missing several indexes the Drizzle schema already declares, so push
 *     alone is not a reliable delivery mechanism here);
 *   • a BEFORE INSERT OR UPDATE trigger that recomputes the projection
 *     whenever `case_data` changes. A trigger — not a call at each call site
 *     — because roughly fifteen code paths write legacy case data (case
 *     routes, invoices, locations, case exceptions, the LabTrax routes,
 *     storage), and a trigger covers all of them plus any future one;
 *   • a one-time, batched, resumable backfill for rows written before the
 *     trigger existed.
 *
 * The extraction rules below are a mechanical translation of what the list
 * queries did inline, and must stay that way: the same guarded regex
 * extraction with NO JSON casting (historical rows can be malformed), the
 * same legacy→canonical status mapping, isRush→priority, the no-charge rule
 * for uncharged remakes, and the same category/taxonomy classification.
 *
 * Correctness never depends on this module having run. A row whose
 * `projection_version` is missing or older than {@link LAB_CASE_PROJECTION_VERSION}
 * is read the old way by the lists (see `lib/legacy-case-list.ts`), so a
 * partially backfilled — or completely unprojected — table produces
 * identical results, just more slowly.
 */

import { eq, sql } from "drizzle-orm";
import { db, pool, systemSettings } from "@workspace/db";
import { logger } from "./logger";

/**
 * Revision of the extraction rules below. Bump it whenever the rules change:
 * every row projected by an older revision is then treated as unprojected
 * (read the old way, recomputed on its next write) and the backfill re-runs
 * under a version-specific completion flag.
 */
export const LAB_CASE_PROJECTION_VERSION = 2;

const BACKFILL_SETTING_KEY = `lab_case_projection_backfill_done_v${LAB_CASE_PROJECTION_VERSION}`;

/**
 * Blobs reach ten megabytes. Keep each backfill transaction to a few rows so
 * a batch cannot hold locks (or a snapshot) for long.
 */
const BACKFILL_BATCH_SIZE = 5;
const BACKFILL_MAX_BATCHES = 20_000;
const BACKFILL_BATCH_PAUSE_MS = 25;
const BACKFILL_RETRY_PAUSE_MS = 5_000;

/**
 * Keys of the blob the list rows actually display. Everything else — notably
 * `photos`, which is what makes these rows huge — is left in `case_data`.
 */
const SUMMARY_KEYS = [
  "caseNumber",
  "patientName",
  "doctorName",
  "status",
  "isRush",
  "dueDate",
  "price",
  "caseType",
  "material",
  "toothIndices",
  "restorationSubtype",
  "step",
  "assignedBarcode",
  "labLocationId",
  "remakeOfCaseId",
  "remakeCharged",
  "createdAt",
  "updatedAt",
];

const SUMMARY_RESTORATION_KEYS = [
  "restorationType",
  "material",
  "restorationSubtype",
  "toothNumber",
];

const sqlStringList = (values: string[]) =>
  values.map((value) => `'${value}'`).join(", ");

/**
 * One implicit transaction: either the whole projection (columns, function,
 * trigger, indexes) lands or none of it does.
 */
const PROJECTION_SETUP_SQL = `
ALTER TABLE lab_cases
  ADD COLUMN IF NOT EXISTS projection_version integer,
  ADD COLUMN IF NOT EXISTS projected_case_number text,
  ADD COLUMN IF NOT EXISTS projected_patient_first_name text,
  ADD COLUMN IF NOT EXISTS projected_patient_last_name text,
  ADD COLUMN IF NOT EXISTS projected_doctor_name text,
  ADD COLUMN IF NOT EXISTS projected_search_document text,
  ADD COLUMN IF NOT EXISTS projected_status text,
  ADD COLUMN IF NOT EXISTS projected_priority text,
  ADD COLUMN IF NOT EXISTS projected_barcode text,
  ADD COLUMN IF NOT EXISTS projected_due_date timestamptz,
  ADD COLUMN IF NOT EXISTS projected_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS projected_total_price numeric,
  ADD COLUMN IF NOT EXISTS projected_category text,
  ADD COLUMN IF NOT EXISTS projected_taxonomy_type text,
  ADD COLUMN IF NOT EXISTS projected_summary jsonb;

CREATE OR REPLACE FUNCTION lab_cases_project_search_document() RETURNS trigger
LANGUAGE plpgsql AS $lab_cases_project_search_document$
DECLARE
  src text;
  patient_name text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.case_data IS NOT DISTINCT FROM OLD.case_data
    AND NEW.projected_search_document IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  src := coalesce(NEW.case_data, '');
  patient_name := coalesce(substring(src from '"patientName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '');
  NEW.projected_search_document := lower(
    coalesce(substring(src from '"caseNumber"[[:space:]]*:[[:space:]]*"([^"]*)"'), '') || ' ' ||
    split_part(patient_name, ' ', 1) || ' ' ||
    regexp_replace(patient_name, '^[^ ]+[ ]*', '') || ' ' ||
    coalesce(substring(src from '"doctorName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '') || ' ' ||
    coalesce(substring(src from '"assignedBarcode"[[:space:]]*:[[:space:]]*"([^"]*)"'), '')
  );
  RETURN NEW;
END;
$lab_cases_project_search_document$;

CREATE OR REPLACE FUNCTION lab_cases_project_list_fields() RETURNS trigger
LANGUAGE plpgsql AS $lab_cases_project_list_fields$
DECLARE
  src text;
  lowered text;
  patient_name text;
  case_type text;
  created_ms text;
  due_raw text;
  doc jsonb;
  summary jsonb;
BEGIN
  -- Nothing to redo when the blob is untouched and the row is already
  -- projected by the current rules. Any other update to a stale row
  -- refreshes it, so the table self-heals as rows are written.
  IF TG_OP = 'UPDATE'
    AND NEW.case_data IS NOT DISTINCT FROM OLD.case_data
    AND NEW.projection_version IS NOT DISTINCT FROM ${LAB_CASE_PROJECTION_VERSION}
  THEN
    RETURN NEW;
  END IF;

  src := coalesce(NEW.case_data, '');
  -- Lowercased once; the classification rules below match against the whole
  -- blob exactly as the list queries did with lower(case_data).
  lowered := lower(src);
  patient_name := coalesce(substring(src from '"patientName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '');
  case_type := substring(src from '"caseType"[[:space:]]*:[[:space:]]*"([^"]*)"');
  created_ms := substring(src from '"createdAt"[[:space:]]*:[[:space:]]*([0-9]+)');
  due_raw := substring(src from '"dueDate"[[:space:]]*:[[:space:]]*"([^"]*)"');

  NEW.projected_case_number := coalesce(substring(src from '"caseNumber"[[:space:]]*:[[:space:]]*"([^"]*)"'), '');
  NEW.projected_patient_first_name := split_part(patient_name, ' ', 1);
  NEW.projected_patient_last_name := regexp_replace(patient_name, '^[^ ]+[ ]*', '');
  NEW.projected_doctor_name := coalesce(substring(src from '"doctorName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '');

  NEW.projected_status := case upper(coalesce(substring(src from '"status"[[:space:]]*:[[:space:]]*"([^"]*)"'), ''))
    when 'INTAKE' then 'received' when 'DESIGN' then 'in_design' when 'MILLING' then 'in_milling'
    when 'PORCELAIN' then 'in_porcelain' when 'QC_CHECK' then 'qc' when 'QC' then 'qc'
    when 'COMPLETE' then 'complete' when 'DELIVERY' then 'shipped' when 'SHIP' then 'shipped'
    when 'DELIVERED' then 'delivered'
    when 'ON_HOLD' then 'on_hold' when 'HOLD' then 'on_hold' when 'REMAKE' then 'remake'
    when 'CANCELLED' then 'cancelled' when 'SCAN' then 'scan' when 'POST_MILL' then 'post_mill'
    when 'SINTERING_FURNACE' then 'sintering_furnace' when 'MODEL_ROOM' then 'model_room'
    else 'received' end;

  NEW.projected_priority := case
    when lower(coalesce(substring(src from '"isRush"[[:space:]]*:[[:space:]]*(true|false)'), 'false')) = 'true'
    then 'rush' else 'normal' end;

  NEW.projected_barcode := substring(src from '"assignedBarcode"[[:space:]]*:[[:space:]]*"([^"]*)"');

  -- Only the blob-derived half of the list's created/received timestamps is
  -- stored. Their fallback to the live updated_at column stays in the query,
  -- so touching updated_at can never leave a stale projection behind.
  NEW.projected_created_at := case
    when created_ms ~ '^[0-9]{10,13}$'
    then to_timestamp(created_ms::double precision / 1000.0) end;

  NEW.projected_due_date := case
    when pg_input_is_valid(due_raw, 'timestamp with time zone')
    then due_raw::timestamptz end;

  -- A remake that was never charged shows as no-charge, exactly as the list
  -- computed inline.
  NEW.projected_total_price := case
    when src ~ '"remakeOfCaseId"[[:space:]]*:[[:space:]]*"[^"]+"'
      and lower(coalesce(substring(src from '"remakeCharged"[[:space:]]*:[[:space:]]*(true|false)'), '')) = 'false'
    then 0
    else coalesce(nullif(substring(src from '"price"[[:space:]]*:[[:space:]]*"?([0-9]+(?:[.][0-9]+)?)"?'), '')::numeric, 0)
  end;

  NEW.projected_category := case
    when lowered ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]*(implant|abutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x))' then 'implants'
    when lowered ~ '"material"[[:space:]]*:[[:space:]]*"[^"]*(zirconia|bruxzir|brux|zirc|pfz)' then 'zirconia'
    when lowered ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]*(crown|bridge|veneer|inlay|onlay|maryland|pontic|coping|lithium disilicate|pfm|gold|full cast|cast metal|semi precious)' then 'crown_bridge'
    when lowered ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]*(denture|partial|flipper|flexible|valplast|removable)' then 'removable'
    when lowered ~ '"(casetype|restorationtype|material)"[[:space:]]*:[[:space:]]*"[^"]+"' then 'other'
    else 'uncategorized' end;

  NEW.projected_taxonomy_type := case
    when lower(coalesce(case_type, '')) in ('restorative', 'removable', 'ortho') then lower(case_type)
    when lowered ~ '(denture|partial|flipper|flexible|valplast|removable)' then 'removable'
    when lowered ~ '(night.?guard|retainer|splint|bleach.?tray|hawley|space.?maintainer|ortho|appliance)' then 'ortho'
    when lowered ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]+"' then 'restorative'
    else null end;

  -- Display extras. These are the values the list rows built from
  -- JSON.parse(case_data) in Node, so they are taken from a real JSON parse
  -- rather than by regex. A blob PostgreSQL cannot parse leaves the summary
  -- null and the list falls back to parsing that row itself.
  BEGIN
    doc := src::jsonb;
  EXCEPTION WHEN others THEN
    doc := NULL;
  END;

  IF doc IS NULL THEN
    NEW.projected_summary := NULL;
  ELSE
    IF jsonb_typeof(doc) = 'object' THEN
      summary := coalesce((
        select jsonb_object_agg(entry.key, entry.value)
        from jsonb_each(doc) entry
        where entry.key in (${sqlStringList(SUMMARY_KEYS)})
      ), '{}'::jsonb);
      IF jsonb_typeof(doc -> 'restorations') = 'array' THEN
        summary := summary || jsonb_build_object('restorations', coalesce((
          select jsonb_agg(
            case when jsonb_typeof(item.value) = 'object' then coalesce((
              select jsonb_object_agg(field.key, field.value)
              from jsonb_each(item.value) field
              where field.key in (${sqlStringList(SUMMARY_RESTORATION_KEYS)})
            ), '{}'::jsonb) else item.value end
            order by item.ordinality)
          from jsonb_array_elements(doc -> 'restorations') with ordinality item(value, ordinality)
        ), '[]'::jsonb));
      END IF;
    ELSE
      -- Not an object: the lists read no keys off it, but they do behave
      -- differently for a JSON null, an array and a bare scalar, so the
      -- parsed type is recorded and the reader decides.
      summary := '{}'::jsonb;
    END IF;
    NEW.projected_summary := jsonb_build_object('t', jsonb_typeof(doc), 'd', summary);
  END IF;

  NEW.projection_version := ${LAB_CASE_PROJECTION_VERSION};
  RETURN NEW;
END;
$lab_cases_project_list_fields$;

DROP TRIGGER IF EXISTS lab_cases_project_list_fields_trg ON lab_cases;
CREATE TRIGGER lab_cases_project_list_fields_trg
  BEFORE INSERT OR UPDATE ON lab_cases
  FOR EACH ROW EXECUTE FUNCTION lab_cases_project_list_fields();

DROP TRIGGER IF EXISTS lab_cases_project_search_document_trg ON lab_cases;
CREATE TRIGGER lab_cases_project_search_document_trg
  BEFORE INSERT OR UPDATE ON lab_cases
  FOR EACH ROW EXECUTE FUNCTION lab_cases_project_search_document();

-- Indexes the case lists need. Declared in the Drizzle schema too, but this
-- database is missing several declared indexes, so they are created here.
-- There is deliberately no trigram index over lower(case_data): the
-- projection is what replaced searching the blob.
CREATE INDEX IF NOT EXISTS lab_cases_organization_updated_idx ON lab_cases (organization_id, updated_at);
CREATE INDEX IF NOT EXISTS lab_cases_organization_deleted_idx ON lab_cases (organization_id, deleted_at);
-- Only stale rows belong in the backfill/probe index. A full projection-version
-- index is nonselective for current rows and can distract the planner from the
-- search-document trigram index.
DROP INDEX IF EXISTS lab_cases_projection_version_idx;
CREATE INDEX IF NOT EXISTS lab_cases_projection_stale_v2_idx ON lab_cases (projection_version)
  WHERE projection_version IS DISTINCT FROM ${LAB_CASE_PROJECTION_VERSION};
-- Replit Publish does not migrate pg_trgm to production. Remove both legacy
-- extension-backed indexes so startup cannot leave development with schema
-- objects that Publish cannot reproduce.
DROP INDEX IF EXISTS lab_cases_search_trgm_idx;
DROP INDEX IF EXISTS lab_cases_projected_search_trgm_idx;
CREATE INDEX IF NOT EXISTS invoices_case_id_idx ON invoices (case_id);
CREATE INDEX IF NOT EXISTS case_restorations_case_id_idx ON case_restorations (case_id);
`;

/**
 * Test seam for simulating a rolling deployment. Production callers always use
 * the defaults; tests can present the rules from a different server version.
 */
export interface LabCaseProjectionInstallation {
  version?: number;
  setupSql?: string;
}

const PROJECTION_INSTALLATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS lab_case_projection_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  version integer NOT NULL
);
INSERT INTO lab_case_projection_installation (singleton, version)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;
`;

interface ProjectionInstallationClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

async function installProjectionIfNewer(
  client: ProjectionInstallationClient,
  version: number,
  setupSql: string,
): Promise<boolean> {
  await client.query("BEGIN");
  try {
    // The table does not exist before the first fenced rollout. Serialize its
    // creation too, rather than relying on concurrent CREATE TABLE IF NOT EXISTS.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('lab-case-projection-installation', 0))",
    );
    await client.query(PROJECTION_INSTALLATION_TABLE_SQL);
    const installed = await client.query<{ version: number }>(
      `SELECT version
       FROM lab_case_projection_installation
       WHERE singleton = true
       FOR UPDATE`,
    );
    const installedVersion = Number(installed.rows[0]?.version ?? 0);
    if (installedVersion >= version) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(setupSql);
    await client.query(
      `UPDATE lab_case_projection_installation
       SET version = $1
       WHERE singleton = true`,
      [version],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Install the projected columns, projection triggers and list indexes only
 * when this process carries newer extraction rules than the database. The
 * locked version row serializes rolling-deployment starts, so an older process
 * can never restore older CREATE OR REPLACE FUNCTION definitions.
 */
export async function ensureLabCaseProjection(
  installation: LabCaseProjectionInstallation = {},
): Promise<boolean> {
  const version = installation.version ?? LAB_CASE_PROJECTION_VERSION;
  const setupSql = installation.setupSql ?? PROJECTION_SETUP_SQL;
  const client = await pool.connect();
  try {
    return await installProjectionIfNewer(client, version, setupSql);
  } finally {
    client.release();
  }
}

/** Rows still carrying no projection, or one from an older revision. */
async function countUnprojectedRows(): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as pending
    from lab_cases
    where projection_version is distinct from ${LAB_CASE_PROJECTION_VERSION}
  `);
  const rows = ((result as unknown as { rows?: { pending?: number }[] }).rows ??
    (result as unknown as { pending?: number }[])) as { pending?: number }[];
  return Number(rows[0]?.pending ?? 0);
}

/**
 * Touch stale rows in small batches so the trigger recomputes them. The
 * update deliberately writes `updated_at` back to its own value: the lists
 * read that column directly, and the projection must not disturb it.
 */
async function runBackfill(): Promise<number> {
  let processed = 0;
  for (let batch = 0; batch < BACKFILL_MAX_BATCHES; batch += 1) {
    const result = await db.execute(sql`
      with stale as (
        select id from lab_cases
        where projection_version is distinct from ${LAB_CASE_PROJECTION_VERSION}
        order by id
        limit ${BACKFILL_BATCH_SIZE}
        for update skip locked
      )
      update lab_cases target
      set updated_at = target.updated_at
      from stale
      where target.id = stale.id
      returning target.id
    `);
    const updated = Number(
      (result as unknown as { rowCount?: number }).rowCount ??
        ((result as unknown as { rows?: unknown[] }).rows ?? []).length,
    );
    processed += updated;
    // Either everything is projected, or the remainder is locked by a
    // concurrent writer — whose own write projects it. Either way, stop.
    if (updated === 0) break;
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_BATCH_PAUSE_MS));
  }
  return processed;
}

/**
 * One-time backfill of rows written before the trigger existed. Runs in the
 * background after the listener is up and never blocks it; completion is
 * recorded in system_settings under a version-specific key so it is skipped
 * on later boots.
 */
export function scheduleLabCaseProjectionBackfillIfNeeded(): void {
  setImmediate(() => {
    void (async () => {
      try {
        const existing = await db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, BACKFILL_SETTING_KEY));
        if (existing.length > 0 && existing[0]?.value === "true") {
          logger.debug("lab-case projection backfill: already done, skipping");
          return;
        }

        let processed = 0;
        let pending = await countUnprojectedRows();
        while (pending > 0) {
          processed += await runBackfill();
          pending = await countUnprojectedRows();
          if (pending === 0) break;
          logger.warn(
            { processed, pending },
            "lab-case projection backfill: incomplete, retrying in this process",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, BACKFILL_RETRY_PAUSE_MS),
          );
        }

        await db
          .insert(systemSettings)
          .values({ key: BACKFILL_SETTING_KEY, value: "true" })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: "true", updatedAt: new Date() },
          });
        logger.info(
          { processed },
          "lab-case projection backfill: complete — flag set, will not run again",
        );
      } catch (err) {
        logger.error({ err }, "lab-case projection backfill: failed");
      }
    })();
  });
}
