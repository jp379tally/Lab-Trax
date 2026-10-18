import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import type { Response } from "express";
import { pool } from "@workspace/db";
import { extractMediaFileName, extractMediaFilenamesFromText } from "./case-media";
import { openCaseMediaObjectStream } from "./case-media-object-storage";
import { resolvePostgresTool } from "./pg-tools";
import {
  collectPrivateLabMedia,
  stagePrivateLabMedia,
  STATEMENT_PDF_PREFIX,
  type LabScanOwnership,
} from "./lab-scoped-backup-media";
import {
  assertLabBackupCoverage,
  LAB_BACKUP_MEDIA_RULES,
  LAB_BACKUP_TABLE_RULES,
  type MediaRule,
} from "./lab-scoped-backup-contract";

const LAB_SCOPED_MAGIC = "LTR2";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PAGE_SIZE = 50;
type ForeignKeyRow = {
  constraint_id?: string;
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
};
export type DatabaseShape = {
  columnsByTable: Map<string, Set<string>>;
  generatedColumnsByTable: Map<string, Set<string>>;
  sequenceColumnsByTable: Map<string, Set<string>>;
  identityColumnsByTable: Map<string, Set<string>>;
  foreignKeysByTable: Map<string, ForeignKeyRow[]>;
};

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (!value || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      !/(?:_at|_date|_timestamp)$/i.test(key) &&
      /(?:password|pass_hash|secret|token|api.?key|private.?key|credential|(?:^|_)pin$)/i.test(key)
    ) {
      safe[key] = typeof fieldValue === "string"
        ? key.toLowerCase().includes("password")
          ? "!lab-backup-password-reset-required!"
          : "[REDACTED IN LAB BACKUP]"
        : null;
    } else {
      safe[key] = redactSensitiveValues(fieldValue);
    }
  }
  return safe;
}

function tableSql(table: string, alias?: string): string {
  return `public.${quoteIdent(table)}${alias ? ` ${quoteIdent(alias)}` : ""}`;
}

function backupKey(): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "Backup encryption is not configured. Set BACKUP_ENCRYPTION_KEY or JWT_SECRET and try again.",
    );
  }
  return createHash("sha256").update(secret).digest();
}

async function createSchemaDump(destination: string): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot create a lab backup.");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(resolvePostgresTool("pg_dump"), [
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      `--dbname=${dbUrl}`,
    ]);
    const output = fs.createWriteStream(destination, { mode: 0o600 });
    let stderr = "";
    let exitCode: number | null = null;
    let outputFinished = false;
    const finishWhenReady = () => {
      if (exitCode === null || !outputFinished) return;
      if (exitCode !== 0) {
        reject(new Error(
          `Could not export the database schema${stderr ? `: ${stderr.slice(0, 400)}` : "."}`,
        ));
        return;
      }
      fs.promises.appendFile(destination, `

-- Make foreign keys deferrable only in this isolated recovery copy so
-- cyclic tenant relationships can be restored and validated at commit.
DO $lab_backup_defer_foreign_keys$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conrelid::regclass AS table_name, conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND connamespace = 'public'::regnamespace
       AND conparentid = 0
  LOOP
    EXECUTE format(
      'ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
      constraint_row.table_name,
      constraint_row.conname
    );
  END LOOP;
END
$lab_backup_defer_foreign_keys$;
`).then(resolve, reject);
    };
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 400) stderr += chunk.toString("utf8").slice(0, 400 - stderr.length);
    });
    output.on("error", (error) => {
      proc.kill("SIGTERM");
      reject(error);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      exitCode = code;
      finishWhenReady();
    });
    output.on("finish", () => {
      outputFinished = true;
      finishWhenReady();
    });
    proc.stdout.pipe(output);
  });
}

async function readDatabaseShape(client: any): Promise<DatabaseShape> {
  const columnResult = await client.query(
    `SELECT table_name, column_name, data_type, is_generated, is_identity, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          SELECT table_name
            FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        )
      ORDER BY table_name, ordinal_position`,
  );
  // Check types as well as names: a new JSON payload can contain attachments
  // without advertising that fact in its column name.
  const coverageTables = new Map<string, Array<{ name: string; dataType: string }>>();
  for (const row of columnResult.rows) {
    const columns = coverageTables.get(row.table_name) ?? [];
    columns.push({
      name: row.column_name,
      dataType: ["json", "jsonb"].includes(row.data_type) ? "json" : row.data_type,
    });
    coverageTables.set(row.table_name, columns);
  }
  const columnsByTable = new Map<string, Set<string>>();
  const generatedColumnsByTable = new Map<string, Set<string>>();
  const sequenceColumnsByTable = new Map<string, Set<string>>();
  const identityColumnsByTable = new Map<string, Set<string>>();
  for (const {
    table_name,
    column_name,
    is_generated,
    is_identity,
    column_default,
  } of columnResult.rows) {
    const columns = columnsByTable.get(table_name) ?? new Set<string>();
    columns.add(column_name);
    columnsByTable.set(table_name, columns);
    if (is_generated === "ALWAYS") {
      const generated = generatedColumnsByTable.get(table_name) ?? new Set<string>();
      generated.add(column_name);
      generatedColumnsByTable.set(table_name, generated);
    }
    if (is_identity === "YES" || String(column_default ?? "").startsWith("nextval(")) {
      const sequenceColumns = sequenceColumnsByTable.get(table_name) ?? new Set<string>();
      sequenceColumns.add(column_name);
      sequenceColumnsByTable.set(table_name, sequenceColumns);
    }
    if (is_identity === "YES") {
      const identityColumns = identityColumnsByTable.get(table_name) ?? new Set<string>();
      identityColumns.add(column_name);
      identityColumnsByTable.set(table_name, identityColumns);
    }
  }

  const fkResult = await client.query(
    `SELECT constraint_row.oid::text AS constraint_id,
            child.relname AS table_name,
            child_attr.attname AS column_name,
            parent.relname AS foreign_table_name,
            parent_attr.attname AS foreign_column_name
       FROM pg_constraint constraint_row
       JOIN pg_class child ON child.oid = constraint_row.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = constraint_row.confrelid
       JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY child_key(attnum, ord) ON true
       JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY parent_key(attnum, ord)
         ON parent_key.ord = child_key.ord
       JOIN pg_attribute child_attr ON child_attr.attrelid = child.oid AND child_attr.attnum = child_key.attnum
       JOIN pg_attribute parent_attr ON parent_attr.attrelid = parent.oid AND parent_attr.attnum = parent_key.attnum
      WHERE constraint_row.contype = 'f'
        AND child_ns.nspname = 'public'
      ORDER BY child.relname, parent.relname`,
  );
  const foreignKeysByTable = new Map<string, ForeignKeyRow[]>();
  for (const row of fkResult.rows) {
    const keys = foreignKeysByTable.get(row.table_name) ?? [];
    keys.push(row);
    foreignKeysByTable.set(row.table_name, keys);
  }
  const shape = {
    columnsByTable,
    generatedColumnsByTable,
    sequenceColumnsByTable,
    identityColumnsByTable,
    foreignKeysByTable,
  };
  const runtimeTables = runtimeCoverageTables(shape);
  assertLabBackupCoverage([...coverageTables]
    .filter(([name]) => runtimeTables.has(name))
    .map(([name, columns]) => ({ name, columns })));
  return shape;
}

/** Unmanaged platform tables need not block exports, but new tenant descendants do. */
function runtimeCoverageTables(shape: DatabaseShape): Set<string> {
  const covered = new Set(Object.keys(LAB_BACKUP_TABLE_RULES));
  const owned = new Set(Object.entries(LAB_BACKUP_TABLE_RULES)
    .filter(([, rule]) => rule.include).map(([table]) => table));
  for (const [table, columns] of shape.columnsByTable) {
    if (directScopePredicate(table, columns)) {
      covered.add(table);
      owned.add(table);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [table, keys] of shape.foreignKeysByTable) {
      if (owned.has(table)) continue;
      if (keys.some((key) => key.foreign_table_name !== "users" && owned.has(key.foreign_table_name))) {
        covered.add(table);
        owned.add(table);
        changed = true;
      }
    }
  }
  return covered;
}

function isSensitiveOrGlobalTable(table: string): boolean {
  // Authentication sessions and bearer tokens have explicit exclusion rules.
  // Accounting receipt tables happen to use "session" in their name, but
  // excluding those parents makes their retained payment ledgers unrestorable.
  return LAB_BACKUP_TABLE_RULES[table]?.include !== true;
}

function directScopePredicate(
  table: string,
  columns: Set<string>,
  rowAlias = "scoped_row",
): string | null {
  const alias = quoteIdent(rowAlias);
  const predicates: string[] = [];
  const hasLabOwner = ["lab_id", "lab_organization_id", "parent_lab_organization_id"]
    .some((column) => columns.has(column));
  if (table === "organizations") {
    predicates.push(`(${alias}."id" = $1 OR ${alias}."parent_lab_organization_id" = $1)`);
  }

  // A lab membership's lab_id may refer to a provider practice underneath the
  // lab. The scoped-org list is server-built from the lab and its child practices.
  for (const column of columns) {
    if (table === "organizations" && column === "parent_lab_organization_id") continue;
    if (column === "lab_id" && table === "lab_memberships") {
      predicates.push(`${alias}.${quoteIdent(column)} = ANY($2::text[])`);
    } else if (
      column === "lab_id" ||
      column === "lab_organization_id" ||
      (column === "parent_lab_organization_id" && table !== "organizations")
    ) {
      predicates.push(`${alias}.${quoteIdent(column)} = $1`);
    } else if (
      column === "organization_id" ||
      column.endsWith("_organization_id")
    ) {
      const scopedOrganization = `${alias}.${quoteIdent(column)} = ANY($2::text[])`;
      // Lab-owned invoices/credits may legitimately have no assigned practice.
      // A nullable secondary organization cannot erase their authoritative lab
      // ownership, but a populated reference must still remain in this lab.
      predicates.push(hasLabOwner
        ? `(${alias}.${quoteIdent(column)} IS NULL OR ${scopedOrganization})`
        : scopedOrganization);
    }
  }

  if (predicates.length === 0) return null;
  return predicates.join(" AND ");
}

export function buildTablePredicate(
  table: string,
  shape: DatabaseShape,
  seen = new Set<string>(),
  depth = 0,
  rowAlias = "scoped_row",
): string | null {
  if (isSensitiveOrGlobalTable(table)) return null;
  if (table === "users") {
    const userId = `${quoteIdent(rowAlias)}."id"`;
    const scopedReferences: string[] = [];
    for (const [referencingTable, columns] of shape.columnsByTable) {
      if (referencingTable === "users" || isSensitiveOrGlobalTable(referencingTable)) continue;
      const userColumns = [...columns].filter((column) =>
        column === "user_id" || column.endsWith("_user_id"),
      );
      if (userColumns.length === 0) continue;
      const predicate = buildTablePredicate(
        referencingTable,
        shape,
        new Set(["users"]),
        0,
        "user_ref_row",
      );
      if (!predicate) continue;
      for (const column of userColumns) {
        scopedReferences.push(
          `EXISTS (SELECT 1 FROM ${tableSql(referencingTable, "user_ref_row")} ` +
          `WHERE "user_ref_row".${quoteIdent(column)} = ${userId} AND (${predicate}))`,
        );
      }
    }
    return `(${userId} IN (
      SELECT member."user_id"
        FROM public."lab_memberships" member
       WHERE member."lab_id" = ANY($2::text[])
    )${scopedReferences.length ? ` OR ${scopedReferences.join(" OR ")}` : ""})`;
  }

  const columns = shape.columnsByTable.get(table);
  if (!columns) return null;
  // A note/event's actor or an attachment's uploader is not its owner.
  const parentOwned = new Set([
    "case_events", "case_notes", "case_submission_queue", "case_attachments",
  ]);
  const direct = parentOwned.has(table) ? null : directScopePredicate(table, columns, rowAlias);
  if (direct) return direct;
  if (depth >= 4 || seen.has(table)) return null;

  const nextSeen = new Set(seen);
  nextSeen.add(table);
  const related: string[] = [];
  const fkGroups = new Map<string, ForeignKeyRow[]>();
  const softParents: Record<string, ForeignKeyRow[]> = {
    lab_pending_file_note_edits: [{
      table_name: table, column_name: "pending_file_id",
      foreign_table_name: "lab_pending_files", foreign_column_name: "id",
    }],
    legacy_case_media: [{
      table_name: table, column_name: "lab_case_id",
      foreign_table_name: "lab_cases", foreign_column_name: "id",
    }],
  };
  for (const fk of [
    ...(shape.foreignKeysByTable.get(table) ?? []),
    ...(softParents[table] ?? []),
  ]) {
    // A lab member can have unrelated records outside this lab. Do not make
    // a user FK alone sufficient to pull one of those records into the dump.
    if (fk.foreign_table_name === "users") continue;
    if (parentOwned.has(table) && !["cases", "lab_cases"].includes(fk.foreign_table_name)) continue;
    const groupKey = fk.constraint_id ?? `${fk.foreign_table_name}:${fk.column_name}`;
    const group = fkGroups.get(groupKey) ?? [];
    group.push(fk);
    fkGroups.set(groupKey, group);
  }
  for (const group of fkGroups.values()) {
    const first = group[0]!;
    // A nested parent must not shadow its outer parent: otherwise deeper FK
    // comparisons become self-comparisons (or reference nonexistent columns).
    const parentAlias = `scope_parent_${depth}`;
    const parentPredicate = buildTablePredicate(
      first.foreign_table_name,
      shape,
      nextSeen,
      depth + 1,
      parentAlias,
    );
    if (!parentPredicate) continue;
    related.push(
      `EXISTS (SELECT 1 FROM ${tableSql(first.foreign_table_name, parentAlias)} ` +
      `WHERE ${group.map((fk) =>
        `${quoteIdent(rowAlias)}.${quoteIdent(fk.column_name)} = ` +
        `${quoteIdent(parentAlias)}.${quoteIdent(fk.foreign_column_name)}`,
      ).join(" AND ")} AND (${parentPredicate}))`,
    );
  }
  return related.length ? `(${related.join(" OR ")})` : null;
}

function stableTableOrder(
  tables: string[],
  foreignKeysByTable: Map<string, ForeignKeyRow[]>,
): string[] {
  const included = new Set(tables);
  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((table) =>
      (foreignKeysByTable.get(table) ?? []).every(
        (fk) => !included.has(fk.foreign_table_name) ||
          !remaining.has(fk.foreign_table_name) ||
          fk.foreign_table_name === table,
      ),
    );
    if (ready.length === 0) {
      // The recovery schema makes foreign keys deferrable; PostgreSQL validates
      // residual cycles when the restore transaction commits.
      ordered.push(...remaining);
      break;
    }
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

/**
 * Scan files are flat case-media objects named after their scan job, and a
 * row's own job reference does not prove the job is this lab's: saved scan
 * documents are selected by their own lab column, and a foreign key only
 * proves that the job exists. Read the scan jobs and inputs that this export
 * selects for the lab, in the export snapshot, so every scan reader can
 * require the job its key names to be one of them.
 */
export async function readLabScanOwnership(
  client: { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> },
  labId: string,
  organizations: string[],
  shape: DatabaseShape,
): Promise<LabScanOwnership> {
  const select = async (table: string, columns: string[], projection: string) => {
    const predicate = buildTablePredicate(table, shape);
    const available = shape.columnsByTable.get(table);
    if (!predicate || !columns.every((column) => available?.has(column))) return [];
    const result = await client.query(
      `SELECT ${projection} FROM ${tableSql(table, "scoped_row")}
        WHERE (${predicate}) AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL`,
      [labId, organizations],
    );
    return result.rows as Array<{ scan_job_id: string; scan_input_id?: string }>;
  };
  const jobs = await select("scan_jobs", ["id"], `"scoped_row"."id"::text AS scan_job_id`);
  const inputs = await select("scan_inputs", ["id", "job_id"],
    `"scoped_row"."id"::text AS scan_input_id, "scoped_row"."job_id"::text AS scan_job_id`);
  return {
    jobs: new Set(jobs.map((row) => row.scan_job_id)),
    inputJobs: new Map(inputs.map((row) => [String(row.scan_input_id), row.scan_job_id])),
  };
}

async function writeLabDataSql(
  client: any,
  destination: string,
  labId: string,
  scopedOrganizationIds: string[],
  shape: DatabaseShape,
): Promise<{
  tableCount: number;
  rowCount: number;
  mediaFiles: Set<string>;
  mediaOrigins: Map<string, string>;
}> {
  const coverageTables = runtimeCoverageTables(shape);
  assertLabBackupCoverage([...shape.columnsByTable]
    .filter(([name]) => coverageTables.has(name)).map(([name, columns]) => ({
    name, columns: [...columns].map((column) => ({ name: column })),
  })));
  for (const table of shape.columnsByTable.keys()) {
    if (LAB_BACKUP_TABLE_RULES[table]?.include && !buildTablePredicate(table, shape)) {
      throw new Error(`Lab backup has no ownership predicate for included table "${table}".`);
    }
  }
  const candidates = [...shape.columnsByTable.keys()]
    .filter((table) => buildTablePredicate(table, shape) !== null)
    .sort();
  const tables = stableTableOrder(candidates, shape.foreignKeysByTable);
  // Same snapshot as the rows below; table order cannot be relied on for this.
  const scans = await readLabScanOwnership(client, labId, scopedOrganizationIds, shape);
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  const mediaFiles = new Set<string>();
  const mediaOrigins = new Map<string, string>();
  let rowCount = 0;

  const write = async (text: string) => {
    if (!output.write(text)) await once(output, "drain");
  };

  try {
    await write("-- Lab-scoped data. Restore only into a newly created, isolated database.\n");
    await write("-- User password hashes have been replaced; users must set new passwords.\n\n");
    await write("BEGIN;\nSET CONSTRAINTS ALL DEFERRED;\n\n");
    for (const table of tables) {
      await write(`ALTER TABLE ${tableSql(table)} DISABLE TRIGGER USER;\n`);
    }
    await write("\n");
    for (const table of tables) {
      const predicate = buildTablePredicate(table, shape);
      if (!predicate) continue;
      const generatedColumns = shape.generatedColumnsByTable.get(table) ?? new Set<string>();
      const insertColumns = [...(shape.columnsByTable.get(table) ?? [])]
        .filter((column) => !generatedColumns.has(column));
      if (insertColumns.length === 0) continue;
      const columnList = insertColumns.map(quoteIdent).join(", ");
      const identityOverride = (shape.identityColumnsByTable.get(table)?.size ?? 0) > 0
        ? " OVERRIDING SYSTEM VALUE"
        : "";
      let lastCtid = "(0,0)";
      while (true) {
        const result = await client.query(
          // Some ownership predicates use only $1 or only $2. Type both
          // bindings explicitly so PostgreSQL can parse unused parameters in
          // this shared four-parameter query, even for an empty table.
          `WITH backup_scope AS (SELECT $1::text AS lab_id, $2::text[] AS organization_ids)
           SELECT ctid::text AS row_tid, to_jsonb(${quoteIdent("scoped_row")})::text AS row_json
             FROM ${tableSql(table, "scoped_row")}
            WHERE (${predicate}) AND ctid > $3::tid
            ORDER BY ctid
            LIMIT $4`,
          [labId, scopedOrganizationIds, lastCtid, PAGE_SIZE],
        );
        if (result.rows.length === 0) break;
        for (const row of result.rows as Array<{ row_tid: string; row_json: string }>) {
          lastCtid = row.row_tid;
          const parsed = redactSensitiveValues(JSON.parse(row.row_json)) as Record<string, unknown>;
          collectLabBackupMedia(table, parsed, mediaFiles, mediaOrigins, scans);
          const json = JSON.stringify(parsed);
          const statement =
            `INSERT INTO public.${quoteIdent(table)} (${columnList})${identityOverride} ` +
            `SELECT ${columnList} FROM jsonb_populate_record(NULL::public.${quoteIdent(table)}, ` +
            `${sqlLiteral(json)}::jsonb);\n`;
          await write(statement);
          rowCount += 1;
        }
      }
      for (const column of shape.sequenceColumnsByTable.get(table) ?? []) {
        const relationName = `public.${quoteIdent(table)}`;
        const quotedColumn = quoteIdent(column);
        await write(
          `SELECT setval(pg_get_serial_sequence(${sqlLiteral(relationName)}, ` +
          `${sqlLiteral(column)}), COALESCE(MAX(${quotedColumn}), 1), ` +
          `MAX(${quotedColumn}) IS NOT NULL) FROM ${tableSql(table)};\n`,
        );
      }
    }
    await write("SET CONSTRAINTS ALL IMMEDIATE;\n");
    for (const table of [...tables].reverse()) {
      await write(`ALTER TABLE ${tableSql(table)} ENABLE TRIGGER USER;\n`);
    }
    await write("COMMIT;\n");
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.once("error", reject);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
  return { tableCount: tables.length, rowCount, mediaFiles, mediaOrigins };
}

/**
 * Statement PDFs are the only private files named by an opaque generated
 * filename instead of the owning row's identity, so a scoped row alone does not
 * prove the file is this lab's. Inside the export snapshot, refuse any statement
 * file that a row outside this lab's scope also references. Every other private
 * reader binds its key to the owning row's identity (scan keys to one of this
 * lab's scan jobs, see readLabScanOwnership), and support attachment keys are
 * unique per attachment row.
 */
const OPAQUE_MEDIA_CLAIMS: { prefix: string; kinds: MediaRule["kind"][] }[] = [
  { prefix: STATEMENT_PDF_PREFIX, kinds: ["statement-pdf", "statement-bundle"] },
];
const CLAIM_BATCH_SIZE = 1000;

export async function assertExclusiveOpaqueMedia(
  client: { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> },
  mediaFiles: Iterable<string>,
  labId: string,
  organizations: string[],
  shape: DatabaseShape,
): Promise<void> {
  const references = [...mediaFiles];
  for (const group of OPAQUE_MEDIA_CLAIMS) {
    const keys = references
      .filter((reference) => reference.startsWith(group.prefix))
      .map((reference) => reference.slice(group.prefix.length));
    if (keys.length === 0) continue;
    for (const [claimTable, rules] of Object.entries(LAB_BACKUP_MEDIA_RULES)) {
      const columns = shape.columnsByTable.get(claimTable);
      if (!columns) continue;
      const claims = Object.entries(rules)
        .filter(([column, rule]) => columns.has(column) && group.kinds.includes(rule.kind))
        .map(([column, rule]) => {
          const field = `"scoped_row".${quoteIdent(column)}`;
          if (rule.kind !== "statement-bundle") return `${field} = ANY($3::text[])`;
          // Malformed manifests are ignored by the app and must not fail the query.
          const attachments = `${field}::jsonb -> 'attachments'`;
          return `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${attachments}) = 'array' ` +
            `THEN ${attachments} ELSE '[]'::jsonb END) attachment ` +
            `WHERE attachment ->> 'storageKey' = ANY($3::text[]))`;
        });
      if (claims.length === 0) continue;
      // Rows of an unscoped or excluded table are all outside this lab.
      const predicate = buildTablePredicate(claimTable, shape);
      const outside = predicate ? `(${predicate}) IS NOT TRUE` : "TRUE";
      for (let start = 0; start < keys.length; start += CLAIM_BATCH_SIZE) {
        const conflict = await client.query(
          `SELECT 1 FROM ${tableSql(claimTable, "scoped_row")}
            WHERE (${claims.join(" OR ")}) AND ${outside}
              AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL
            LIMIT 1`,
          [labId, organizations, keys.slice(start, start + CLAIM_BATCH_SIZE)],
        );
        if (conflict.rows.length) {
          throw new Error(
            `Lab backup stopped: a statement PDF referenced by this lab is also claimed outside this lab ` +
            `(by ${claimTable}), so it cannot be exported as this lab's file.`,
          );
        }
      }
    }
  }
}

/** Opaque JSON whose serialized text may still embed case-media links. */
const EMBEDDED_CASE_MEDIA_KINDS = new Set<MediaRule["kind"]>([
  "embedded", "legacy-evidence", "statement-bundle",
]);

function describeRow(row: Record<string, unknown>): string {
  for (const key of ["id", "file_name"]) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") return `row ${value}`;
  }
  return "an unidentified row";
}

export function collectLabBackupMedia(
  table: string,
  row: Record<string, unknown>,
  mediaFiles: Set<string>,
  origins?: Map<string, string>,
  scans?: LabScanOwnership,
): void {
  for (const [column, rule] of Object.entries(LAB_BACKUP_MEDIA_RULES[table] ?? {})) {
    const value = row[column];
    if (value === null || value === undefined || value === "") continue;
    if (rule.kind === "metadata") continue;
    const origin = `${table}.${column} (${describeRow(row)})`;
    const found = new Set<string>();
    try {
      collectColumnMedia(rule, row, value, found, scans);
    } catch (error) {
      throw new Error(`Lab backup stopped at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const reference of found) {
      mediaFiles.add(reference);
      if (origins && !origins.has(reference)) origins.set(reference, origin);
    }
  }
}

function collectColumnMedia(
  rule: MediaRule,
  row: Record<string, unknown>,
  value: unknown,
  found: Set<string>,
  scans: LabScanOwnership | undefined,
): void {
  if (EMBEDDED_CASE_MEDIA_KINDS.has(rule.kind)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    // Private template images and objects are not in the case-media namespace.
    if (/(?:\/objects\/|invoice-template-images\/|case-print-template-images\/)/.test(text)) {
      throw new Error(
        "Lab backup cannot include private media embedded in this value; template images and " +
        "/objects/ paths are outside the case-media namespace.",
      );
    }
    for (const fileName of extractMediaFilenamesFromText(text)) found.add(path.basename(fileName));
    if (rule.kind === "embedded") return;
  }
  if (collectPrivateLabMedia(rule.kind, row, value, found, scans)) return;
  if (rule.kind === "unsupported") throw new Error(rule.reason);
  if (typeof value !== "string") throw new Error("Invalid media reference.");
  if (rule.kind === "invoice-media") {
    const prefix = "/uploads/invoice-attachments/";
    if (!value.startsWith(prefix)) throw new Error("Unsupported media namespace.");
    const fileName = value.slice(prefix.length);
    if (!fileName || path.basename(fileName) !== fileName) throw new Error("Invalid media filename.");
    found.add(`invoice-attachments/${fileName}`);
    return;
  }
  if (rule.kind === "case-media" && value.includes("/") &&
      !value.includes("/uploads/case-media/") && !value.includes("/api/cases/attachment-file/")) {
    throw new Error("Unsupported media namespace.");
  }
  const fileName = rule.kind === "filename" ? value : extractMediaFileName(value);
  if (!fileName || path.basename(fileName) !== fileName) throw new Error("Invalid media filename.");
  found.add(fileName);
}

async function stageReferencedMedia(
  files: Set<string>,
  destination: string,
  origins: ReadonlyMap<string, string>,
): Promise<number> {
  await fs.promises.mkdir(destination, { recursive: true });
  const handled = await stagePrivateLabMedia(files, destination, origins);
  const localDir = path.resolve(process.cwd(), "uploads", "case-media");
  for (const reference of files) {
    if (handled.has(reference)) continue;
    const invoiceMedia = reference.startsWith("invoice-attachments/");
    const fileName = invoiceMedia ? reference.slice("invoice-attachments/".length) : reference;
    if (!fileName || path.basename(fileName) !== fileName) {
      throw new Error("Lab backup stopped because a media reference has an invalid file name.");
    }
    const localPath = path.join(
      invoiceMedia ? path.resolve(process.cwd(), "uploads", "invoice-attachments") : localDir,
      fileName,
    );
    const outputPath = path.join(destination, reference);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    try {
      const stat = await fs.promises.lstat(localPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Referenced media "${fileName}" is not a regular file.`);
      }
      await fs.promises.copyFile(localPath, outputPath);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Invoice attachments are currently local-only. Never fall back to a
    // same-named case object belonging to a different storage namespace.
    const object = invoiceMedia ? null : await openCaseMediaObjectStream(fileName);
    if (!object) {
      const origin = origins.get(reference);
      throw new Error(
        `Lab backup stopped because referenced media "${fileName}" is missing from storage` +
        `${origin ? ` (referenced by ${origin})` : ""}.`,
      );
    }
    await pipeline(
      object.stream as NodeJS.ReadableStream,
      fs.createWriteStream(outputPath, { mode: 0o600 }),
    );
  }
  return files.size;
}

function recoveryInstructions(labName: string): string {
  return `# Recovering this LabTrax lab backup

This encrypted archive contains a schema-only database export, rows for one lab, and only that lab's referenced media. It is not a full-system backup and must never be sent to LabTrax's platform-wide restore endpoint.

1. Decrypt this file using the same BACKUP_ENCRYPTION_KEY (or JWT_SECRET) configured when it was created. The outer encrypted stream uses the LabTrax LTR2 AES-256-GCM format.
2. Create a new, empty PostgreSQL database. Do not point these steps at a live LabTrax database.
3. Extract the inner ZIP, then run \`psql -v ON_ERROR_STOP=1 -d <new-empty-database> -f db/schema.sql\`.
4. Run \`psql -v ON_ERROR_STOP=1 -d <new-empty-database> -f db/lab-data.sql\`.
5. The files directly in \`media/\` are the lab's referenced case files. Copy those files to the isolated recovery environment's uploads/case-media directory. If present, copy \`media/invoice-attachments/\` separately to uploads/invoice-attachments.
6. Copy each folder in \`media/local-uploads/\` to the folder of the same name in the isolated environment's uploads directory, keeping every filename. practice-statements holds statement PDFs, including every doctor PDF in a statement bundle. profile-photos holds the photos of users that this lab's rows reference. The restored rows find these files by name.
7. Restore \`media/private-objects/\` beneath a NEW isolated PRIVATE_OBJECT_DIR, preserving each complete relative object key. case-media/ holds uploaded signed authorization forms (practice-authorizations), retired in-app signatures and forms (lab-authorizations), autopay signature images and signed PDFs (provider-autopay) and scan files (scan-...). lab-logos/ holds organization logos and support-reports/ holds support report attachments. Keep these namespaces separate: do not flatten names or merge them into case-media. Never restore into the live private bucket prefix.
8. Keep background workers, outbound email and SMS, and payment processing disabled during recovery. Verify the restored bytes and ownership before using the isolated application.

Every stored file that this lab's rows reference is in this archive; a missing, unsafe, foreign or ambiguous reference stops the export instead. By design, some references have no separately stored file: external profile-photo links, inline data URIs (their bytes are in the restored row), scan outputs that never finished, and support attachments already redacted by retention. Cleanup and trash objects that no row references are not included.

The schema file creates objects but contains no other lab's rows. The data script runs in one transaction, temporarily disables user-defined triggers, defers and then validates foreign keys, and resets sequences for inserted rows. It only inserts this lab's rows; it does not drop, truncate, or update existing records. Lab membership password hashes are intentionally replaced; recovered users must set new passwords.

Lab: ${labName}
`;
}

export async function streamLabScopedBackupDownload(options: {
  labId: string;
  labName: string;
  userId: string;
  response: Response;
}): Promise<void> {
  const key = backupKey();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set — cannot create a lab backup.");
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "labtrax-lab-backup-"));
  const schemaPath = path.join(tempDir, "schema.sql");
  const dataPath = path.join(tempDir, "lab-data.sql");
  const mediaPath = path.join(tempDir, "media");
  const client = await pool.connect();

  try {
    await createSchemaDump(schemaPath);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const orgResult = await client.query<{ id: string }>(
      `SELECT id FROM public.organizations
        WHERE id = $1 OR parent_lab_organization_id = $1
        ORDER BY id`,
      [options.labId],
    );
    const scopedOrganizationIds = [...new Set([
      options.labId,
      ...orgResult.rows.map((row) => row.id),
    ])];
    const shape = await readDatabaseShape(client);
    const exported = await writeLabDataSql(
      client,
      dataPath,
      options.labId,
      scopedOrganizationIds,
      shape,
    );
    // Still inside the snapshot, so the claim check sees the rows just exported.
    await assertExclusiveOpaqueMedia(
      client,
      exported.mediaFiles,
      options.labId,
      scopedOrganizationIds,
      shape,
    );
    await client.query("COMMIT");
    const mediaFileCount = await stageReferencedMedia(
      exported.mediaFiles,
      mediaPath,
      exported.mediaOrigins,
    );

    const fileName = `labtrax-${options.labId}-backup-${new Date()
      .toISOString().replace(/[:.]/g, "-")}.zip.enc`;
    const manifest = {
      version: "1.0",
      schemaVersion: "2",
      appName: "LabTrax",
      archiveKind: "lab-scoped",
      labId: options.labId,
      labName: options.labName,
      exportedAt: new Date().toISOString(),
      exportedByUserId: options.userId,
      rowCount: exported.rowCount,
      tableCount: exported.tableCount,
      mediaFileCount,
      databaseNote: "Schema-only SQL plus lab-scoped insert statements; no other lab's rows.",
      sensitiveValuesRedacted: true,
      excludedTables: Object.entries(LAB_BACKUP_TABLE_RULES)
        .filter(([table, rule]) => shape.columnsByTable.has(table) && !rule.include)
        .map(([table, rule]) => ({ table, reason: rule.reason })),
      restoreNote: "Recover only into a newly-created isolated PostgreSQL database; never use the platform-wide restore route.",
      mediaLayout: {
        "media/<file>": "uploads/case-media/<file>",
        "media/invoice-attachments/<file>": "uploads/invoice-attachments/<file>",
        "media/local-uploads/<namespace>/<file>": "uploads/<namespace>/<file>",
        "media/private-objects/<namespace>/<key>": "<new isolated PRIVATE_OBJECT_DIR>/<namespace>/<key>",
      },
    };

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(recoveryInstructions(options.labName), { name: "RECOVERY.md" });
    archive.file(schemaPath, { name: "db/schema.sql" });
    archive.file(dataPath, { name: "db/lab-data.sql" });
    archive.directory(mediaPath, "media");

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const { response } = options;
    response.status(200);
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.write(Buffer.concat([Buffer.from(LAB_SCOPED_MAGIC), iv]));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        archive.destroy();
        cipher.destroy();
        reject(error);
      };
      archive.on("error", fail);
      cipher.on("error", fail);
      response.on("close", () => {
        if (!response.writableEnded) fail(new Error("The browser closed the lab backup download."));
      });
      response.on("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      cipher.on("end", () => {
        if (!settled) response.end(cipher.getAuthTag());
      });
      archive.pipe(cipher);
      cipher.pipe(response, { end: false });
      void archive.finalize().catch(fail);
    });
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* transaction may be committed */ }
    client.release();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
