import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import { MEDIA_MUTATION_SCHEMA_SQL } from "./production-media-mutation";

/**
 * The journal records only storage identities and operations. It deliberately
 * does not copy row IDs, patient data, or business fields into the outbox.
 *
 * A counter row is locked until the writer transaction commits. Unlike a
 * PostgreSQL sequence, this makes committed positions agree with commit order
 * and makes a missing position detectable during recovery.
 */
export const PRODUCTION_MEDIA_JOURNAL_SCHEMA_SQL = MEDIA_MUTATION_SCHEMA_SQL + `
  CREATE TABLE IF NOT EXISTS labtrax_production_media_journal_counter (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
    high_water bigint NOT NULL DEFAULT 0 CHECK (high_water >= 0)
  );
  INSERT INTO labtrax_production_media_journal_counter(singleton, high_water)
    VALUES (true, 0) ON CONFLICT (singleton) DO NOTHING;

  CREATE TABLE IF NOT EXISTS labtrax_production_media_journal (
    position bigint PRIMARY KEY CHECK (position > 0),
    operation text NOT NULL CHECK (operation IN ('add', 'remove', 'replace')),
    object_key text NOT NULL CHECK (object_key <> ''),
    source_table text NOT NULL CHECK (source_table <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'labtrax_production_media_journal'::regclass
        AND conname = 'labtrax_production_media_journal_operation_check'
        AND pg_get_constraintdef(oid) LIKE '%replace%'
    ) THEN
      ALTER TABLE labtrax_production_media_journal
        DROP CONSTRAINT IF EXISTS labtrax_production_media_journal_operation_check;
      ALTER TABLE labtrax_production_media_journal
        ADD CONSTRAINT labtrax_production_media_journal_operation_check
          CHECK (operation IN ('add', 'remove', 'replace'));
    END IF;
  END
  $$;
  CREATE INDEX IF NOT EXISTS labtrax_production_media_journal_key_position_idx
    ON labtrax_production_media_journal(object_key, position);

  CREATE OR REPLACE FUNCTION labtrax_production_media_journal_append(
    p_operation text, p_object_key text, p_source_table text
  ) RETURNS void LANGUAGE plpgsql AS $$
  DECLARE next_position bigint;
  BEGIN
    IF p_operation NOT IN ('add', 'remove', 'replace') OR p_object_key IS NULL OR p_object_key = '' THEN
      RAISE EXCEPTION 'invalid production media journal event';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(1279349848, 1296385097);
    UPDATE labtrax_production_media_journal_counter
      SET high_water = high_water + 1
      WHERE singleton = true
      RETURNING high_water INTO next_position;
    IF next_position IS NULL THEN
      RAISE EXCEPTION 'production media journal counter is unavailable';
    END IF;
    INSERT INTO labtrax_production_media_journal(position, operation, object_key, source_table)
      VALUES (next_position, p_operation, p_object_key, p_source_table);
  END
  $$;

  CREATE OR REPLACE FUNCTION labtrax_production_media_journal_collect_refs(
    p_value jsonb, p_table text, p_column text DEFAULT NULL
  ) RETURNS SETOF text LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE child record; raw text; candidate text; matched text[];
  BEGIN
    IF p_value IS NULL THEN RETURN; END IF;
    IF jsonb_typeof(p_value) = 'object' THEN
      FOR child IN SELECT key, value FROM jsonb_each(p_value) LOOP
        IF jsonb_typeof(child.value) = 'string' THEN
          raw := child.value #>> '{}';
          candidate := NULL;
          IF child.key IN ('storageKey', 'storage_key', 'objectStorageKey',
              'object_storage_key', 'storagePath', 'storage_path', 'mediaKey',
              'media_key', 'pdfStorageKey', 'pdf_storage_key') THEN
            candidate := regexp_replace(raw, '^/?uploads/', '');
             IF candidate !~ '^(case-media|invoice-attachments|profile-photos|support-reports|lab-logos|invoice-template-images|case-print-template-images|legacy-case-data-backups|desktop-installer|recovery-archives)/' THEN
              candidate := 'case-media/' || regexp_replace(candidate, '^/+', '');
            END IF;
          ELSIF child.key IN ('file_name', 'fileName') AND p_table = 'legacy_case_media' THEN
            candidate := 'case-media/' || regexp_replace(raw, '^/+', '');
          ELSIF child.key = 'profile_photo_url' AND raw LIKE '%/profile-photos/%' THEN
            candidate := 'profile-photos/' || split_part(split_part(raw, '/profile-photos/', 2), '?', 1);
          ELSIF child.key = 'logo_url' AND p_table = 'organizations' AND raw LIKE '%/logo%' THEN
            candidate := 'lab-logos/' || COALESCE(p_value ->> 'id', '') || '.*';
          END IF;

           -- PostgreSQL text cannot contain NUL. Reject path separators that
           -- could escape the normalized object-key namespace without building
           -- an E-string containing an invalid NUL escape.
           IF candidate IS NOT NULL AND candidate !~ '(^|/)\.\.?(/|$)' AND
              position(chr(92) IN candidate) = 0 AND candidate !~ '(^/|//)' THEN
            RETURN NEXT candidate;
          END IF;

          -- Preserve references embedded in legacy JSON/text fields and
          -- absolute application URLs. Only known private storage namespaces
          -- are journaled; ordinary prose is ignored.
          FOR matched IN
            SELECT regexp_matches(raw,
              '((case-media|invoice-attachments|profile-photos|support-reports|lab-logos|invoice-template-images|case-print-template-images|legacy-case-data-backups|desktop-installer|recovery-archives)/[A-Za-z0-9._/-]+)',
              'g')
          LOOP
            candidate := matched[1];
            IF candidate !~ '(^|/)\.\.?(/|$)' THEN RETURN NEXT candidate; END IF;
          END LOOP;
          FOR matched IN
            SELECT regexp_matches(raw,
              '/(?:uploads/case-media|api/cases/attachment-file)/([^"''\\\\?#[:space:]\\)]+)',
              'g')
          LOOP
            candidate := 'case-media/' || regexp_replace(matched[1], '^.*/', '');
            IF candidate !~ '(^|/)\.\.?(/|$)' THEN RETURN NEXT candidate; END IF;
          END LOOP;
        ELSIF jsonb_typeof(child.value) IN ('object', 'array') THEN
          RETURN QUERY SELECT * FROM labtrax_production_media_journal_collect_refs(child.value, p_table, child.key);
        END IF;
      END LOOP;
    ELSIF jsonb_typeof(p_value) = 'array' THEN
      FOR child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
        IF jsonb_typeof(child.value) = 'string' THEN
          raw := child.value #>> '{}';
          FOR matched IN
            SELECT regexp_matches(raw,
              '((case-media|invoice-attachments|profile-photos|support-reports|lab-logos|invoice-template-images|case-print-template-images|legacy-case-data-backups|desktop-installer|recovery-archives)/[A-Za-z0-9._/-]+)',
              'g')
          LOOP
            candidate := matched[1];
            IF candidate !~ '(^|/)\.\.?(/|$)' THEN RETURN NEXT candidate; END IF;
          END LOOP;
        ELSIF jsonb_typeof(child.value) IN ('object', 'array') THEN
          RETURN QUERY SELECT * FROM labtrax_production_media_journal_collect_refs(child.value, p_table, p_column);
        END IF;
      END LOOP;
    ELSIF jsonb_typeof(p_value) = 'string' THEN
      raw := p_value #>> '{}';
      FOR matched IN
        SELECT regexp_matches(raw,
          '((case-media|invoice-attachments|profile-photos|support-reports|lab-logos|invoice-template-images|case-print-template-images|legacy-case-data-backups|desktop-installer|recovery-archives)/[A-Za-z0-9._/-]+)',
          'g')
      LOOP
        candidate := matched[1];
        IF candidate !~ '(^|/)\.\.?(/|$)' THEN RETURN NEXT candidate; END IF;
      END LOOP;
    END IF;
  END
  $$;

  CREATE OR REPLACE FUNCTION labtrax_production_media_journal_row_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_refs text[] := ARRAY[]::text[]; new_refs text[] := ARRAY[]::text[]; ref text;
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::text[]) INTO old_refs
        FROM labtrax_production_media_journal_collect_refs(to_jsonb(OLD), TG_TABLE_NAME) AS refs(value);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::text[]) INTO new_refs
        FROM labtrax_production_media_journal_collect_refs(to_jsonb(NEW), TG_TABLE_NAME) AS refs(value);
    END IF;
    FOR ref IN SELECT unnest(old_refs) EXCEPT SELECT unnest(new_refs) LOOP
      PERFORM labtrax_production_media_journal_append('remove', ref, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME);
    END LOOP;
    FOR ref IN SELECT unnest(new_refs) EXCEPT SELECT unnest(old_refs) LOOP
      PERFORM labtrax_production_media_journal_append('add', ref, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME);
    END LOOP;
    -- A row update cannot prove that bytes at an unchanged key were replaced:
    -- unrelated edits to a case row must not trigger a full media reread.
    -- Writers that overwrite an object in place must append an explicit
    -- "replace" event in the same transaction as the object-reference write.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END
  $$;

  CREATE OR REPLACE FUNCTION labtrax_production_media_journal_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'production media journal is append-only';
  END
  $$;
`;

const INSTALL_REFERENCE_TRIGGERS_SQL = `
  DO $$
  DECLARE target record;
  BEGIN
    FOR target IN
      SELECT DISTINCT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname NOT IN (
          'labtrax_production_media_journal',
          'labtrax_production_media_journal_counter'
        )
        AND (
          a.attname IN (
            'storage_key', 'storage_path', 'object_storage_key', 'media_key',
            'pdf_storage_key', 'profile_photo_url', 'logo_url', 'case_data',
            'case_data_json', 'data_json', 'value'
          )
          OR a.attname LIKE '%\\_json' ESCAPE '\\'
          OR c.relname = 'legacy_case_media'
        )
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tr
        WHERE tr.tgrelid = format('%I.%I', target.schema_name, target.table_name)::regclass
          AND tr.tgname = 'labtrax_production_media_journal_change'
          AND NOT tr.tgisinternal
      ) THEN
        EXECUTE format(
          'CREATE TRIGGER labtrax_production_media_journal_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION labtrax_production_media_journal_row_change()',
          target.schema_name, target.table_name
        );
      END IF;
    END LOOP;
  END
  $$;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.labtrax_production_media_journal'::regclass
        AND tgname = 'labtrax_production_media_journal_no_mutation'
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER labtrax_production_media_journal_no_mutation
        BEFORE UPDATE OR DELETE OR TRUNCATE ON public.labtrax_production_media_journal
        FOR EACH STATEMENT EXECUTE FUNCTION labtrax_production_media_journal_immutable();
    END IF;
  END
  $$;
`;

let schemaReady: Promise<void> | undefined;

export async function ensureProductionMediaJournalSchema(force = false): Promise<void> {
  if (force) schemaReady = undefined;
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await pool.connect();
      let transaction = false;
      try {
        await client.query("BEGIN");
        transaction = true;
        await client.query("SELECT pg_advisory_xact_lock(80451, 15002)");
        await client.query(PRODUCTION_MEDIA_JOURNAL_SCHEMA_SQL);
        await client.query(INSTALL_REFERENCE_TRIGGERS_SQL);
        await assertProductionMediaJournalCoverage(client);
        await client.query("COMMIT");
        transaction = false;
      } catch (error) {
        schemaReady = undefined;
        if (transaction) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })();
  }
  await schemaReady;
}

export async function assertProductionMediaJournalCoverage(client: Pick<PoolClient, "query">): Promise<void> {
  const result = await client.query<{ missing: string[] | null }>(`
    SELECT array_agg(format('%I.%I', n.nspname, c.relname) ORDER BY n.nspname, c.relname) AS missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname NOT IN (
        'labtrax_production_media_journal',
        'labtrax_production_media_journal_counter'
      )
      AND (
        a.attname IN (
          'storage_key', 'storage_path', 'object_storage_key', 'media_key',
          'pdf_storage_key', 'profile_photo_url', 'logo_url', 'case_data',
          'case_data_json', 'data_json', 'value'
        )
        OR a.attname LIKE '%\\_json' ESCAPE '\\'
        OR c.relname = 'legacy_case_media'
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tr
        WHERE tr.tgrelid = c.oid
          AND tr.tgname = 'labtrax_production_media_journal_change'
          AND NOT tr.tgisinternal AND tr.tgenabled <> 'D'
      )
  `);
  const missing = result.rows[0]?.missing ?? [];
  if (missing.length) {
    throw new Error("Production media journal is not installed on every reference-bearing table; change-only capture is disabled.");
  }
}

export interface ProductionMediaJournalEvent {
  position: string;
  operation: "add" | "remove" | "replace";
  objectKey: string;
  sourceTable: string;
  sourceGeneration?: string;
}

/**
 * Record an in-place durable-object overwrite in the caller's DB transaction.
 * Generic row triggers cannot infer byte changes from an unchanged key.
 */
export async function recordProductionMediaReplacement(
  client: Pick<PoolClient, "query">,
  objectKey: string,
  sourceTable: string,
): Promise<void> {
  if (!objectKey || objectKey.startsWith("/") || objectKey.includes("\\") ||
      objectKey.split("/").some(part => !part || part === "." || part === "..") ||
      !sourceTable || sourceTable.length > 256) {
    throw new Error("Invalid production media replacement journal entry.");
  }
  await client.query(
    "SELECT labtrax_production_media_journal_append('replace', $1, $2)",
    [objectKey, sourceTable],
  );
}

export async function readProductionMediaJournalRange(
  client: Pick<PoolClient, "query">,
  afterPosition: string | null,
): Promise<{ afterPosition: string; throughPosition: string; events: ProductionMediaJournalEvent[] }> {
  const high = await client.query<{ high_water: string }>(
    "SELECT high_water::text FROM labtrax_production_media_journal_counter WHERE singleton = true",
  );
  const throughPosition = high.rows[0]?.high_water ?? "0";
  // A first media baseline establishes a checkpoint at the current journal
  // position. Historical events predate the baseline and are not replayed.
  const fromPosition = afterPosition ?? throughPosition;
  const start = BigInt(fromPosition);
  if (start < 0n) throw new Error("Invalid production media journal position.");
  const end = BigInt(throughPosition);
  if (end < start) throw new Error("Production media journal position moved backwards.");
  const result = await client.query<{
    position: string; operation: "add" | "remove" | "replace"; object_key: string; source_table: string; source_generation: string | null;
  }>(`
    SELECT j.position::text, j.operation, j.object_key, j.source_table, i.generation AS source_generation
    FROM labtrax_production_media_journal j
    LEFT JOIN labtrax_production_media_write_intents i ON i.journal_position = j.position
    WHERE j.position > $1::bigint AND j.position <= $2::bigint
    ORDER BY j.position
  `, [fromPosition, throughPosition]);
  if (BigInt(result.rows.length) !== end - start ||
      result.rows.some((event, index) => BigInt(event.position) !== start + BigInt(index) + 1n)) {
    throw new Error("Production media journal contains a gap; no recovery point was committed.");
  }
  return {
    afterPosition: fromPosition,
    throughPosition,
    events: result.rows.map(event => ({
      position: event.position, operation: event.operation,
      objectKey: event.object_key, sourceTable: event.source_table,
      ...(event.source_generation ? { sourceGeneration: event.source_generation } : {}),
    })),
  };
}
