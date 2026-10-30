import { createHash } from "node:crypto";

/**
 * Snapshot comparison, not a trigger journal. Every table is fingerprinted in
 * PostgreSQL, but only new/changed row bodies cross the database connection.
 * This deliberately does not depend on every caller using an application ORM,
 * nor on an owner being unable to disable a trigger.
 */
export const RECORD_DELTA_FORMAT = "labtrax-postgresql-record-delta-v1";
export const MAX_RECORD_METADATA_BYTES = 256 * 1024 * 1024;
export const MAX_CHANGED_RECORD_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 2_000_000;
export class RecordRecoveryError extends Error {}
const digestPattern = /^[a-f0-9]{64}$/;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const relation = (table: { schema: string; name: string }) =>
  `${identifier(table.schema)}.${identifier(table.name)}`;

export interface RecordSqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface RecordFingerprint {
  key: string;
  hash: string;
  count: number;
  references: string[];
}
export interface RecordTable {
  schema: string;
  name: string;
  primaryKey: string[];
  columns: string[];
  allColumns: string[];
  rows: RecordFingerprint[];
}
export interface RecordInventory {
  format: typeof RECORD_DELTA_FORMAT;
  schemaHash: string;
  referenceProtocol: string;
  tables: RecordTable[];
  sequences: Array<{
    schema: string;
    name: string;
    value: string;
    called: boolean;
  }>;
}
export interface ChangedRecord {
  key: string;
  hash: string;
  count: number;
  /** PostgreSQL's original JSON text; never round-trip numbers through JS. */
  json: string;
}
export interface RecordTableChanges {
  schema: string;
  name: string;
  deletes: Array<{ key: string; hash: string; count: number }>;
  inserts: ChangedRecord[];
}
export interface RecordDelta {
  format: typeof RECORD_DELTA_FORMAT;
  beforeHash: string;
  afterHash: string;
  tables: RecordTableChanges[];
}
export interface RecordCapture {
  inventory: RecordInventory;
  /** New row bodies; an explicit schema/reference baseline may reuse exact prior bodies. */
  bodies: RecordTableChanges[];
  /** Null requires an explicitly identified record/schema baseline. */
  delta: RecordDelta | null;
  reason:
    | "first-baseline"
    | "schema-changed"
    | "reference-protocol-changed"
    | "changed-rows";
  metrics: {
    fingerprintRows: number;
    fingerprintMetadataBytes: number;
    schemaSqlBytes: number;
    sourceRowBodyBytes: number;
    changedRows: number;
    deletedRows: number;
    durationMs: number;
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RecordRecoveryError(`Record recovery: ${message}`);
}
function safeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 63 &&
    !value.includes("\0")
  );
}
function safeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function tableIdentity(table: { schema: string; name: string }) {
  return JSON.stringify([table.schema, table.name]);
}
function assertSortedUnique(values: string[], label: string) {
  check(
    values.every((value, index) => index === 0 || values[index - 1]! < value),
    `${label} has duplicate or unordered identities`,
  );
}
export function validateRecordInventory(
  value: RecordInventory,
): RecordInventory {
  check(
    value?.format === RECORD_DELTA_FORMAT &&
      digestPattern.test(value.schemaHash) &&
      digestPattern.test(value.referenceProtocol),
    "invalid inventory format/schema binding",
  );
  check(
    Array.isArray(value.tables) && Array.isArray(value.sequences),
    "missing table/sequence inventory",
  );
  assertSortedUnique(value.tables.map(tableIdentity), "table inventory");
  let records = 0;
  for (const table of value.tables) {
    check(
      safeName(table.schema) && safeName(table.name),
      "invalid table identity",
    );
    check(
      Array.isArray(table.columns) &&
        table.columns.every(safeName) &&
        new Set(table.columns).size === table.columns.length,
      "invalid writable columns",
    );
    check(
      Array.isArray(table.allColumns) &&
        table.allColumns.every(safeName) &&
        new Set(table.allColumns).size === table.allColumns.length &&
        table.columns.every((column) => table.allColumns.includes(column)),
      "invalid complete column inventory",
    );
    check(
      Array.isArray(table.primaryKey) &&
        table.primaryKey.every((column) => table.allColumns.includes(column)) &&
        new Set(table.primaryKey).size === table.primaryKey.length,
      "invalid primary key",
    );
    check(Array.isArray(table.rows), "missing row fingerprints");
    assertSortedUnique(
      table.rows.map((row) => row.key),
      "row inventory",
    );
    for (const row of table.rows) {
      check(
        digestPattern.test(row.key) &&
          digestPattern.test(row.hash) &&
          Number.isSafeInteger(row.count) &&
          row.count > 0,
        "invalid row fingerprint/count",
      );
      check(
        !table.primaryKey.length || row.count === 1,
        "duplicate primary key",
      );
      check(
        Array.isArray(row.references) && row.references.every(safeReference),
        "invalid media reference inventory",
      );
      assertSortedUnique(row.references, "media reference inventory");
      records += row.count;
      check(
        records <= MAX_RECORDS,
        "record inventory exceeds the supported capacity",
      );
    }
  }
  assertSortedUnique(value.sequences.map(tableIdentity), "sequence inventory");
  for (const sequence of value.sequences)
    check(
      safeName(sequence.schema) &&
        safeName(sequence.name) &&
        /^-?\d+$/.test(sequence.value) &&
        typeof sequence.called === "boolean",
      "invalid sequence state",
    );
  check(
    Buffer.byteLength(JSON.stringify(value)) <= MAX_RECORD_METADATA_BYTES,
    "record metadata exceeds capacity",
  );
  return value;
}
export function recordInventoryHash(value: RecordInventory): string {
  validateRecordInventory(value);
  return digest(JSON.stringify(value));
}
export function recordInventoryReferences(value: RecordInventory): string[] {
  validateRecordInventory(value);
  return [
    ...new Set(
      value.tables.flatMap((table) =>
        table.rows.flatMap((row) => row.references),
      ),
    ),
  ].sort();
}

/** Remove pg_dump's non-semantic, per-invocation header/footer tokens only. */
export function postgresSchemaHash(schemaSql: string): string {
  check(
    typeof schemaSql === "string" &&
      schemaSql.length > 0 &&
      Buffer.byteLength(schemaSql) <= MAX_RECORD_METADATA_BYTES,
    "schema export is absent or oversized",
  );
  // Normalize only psql's generated envelope. Matching throughout the body
  // could erase meaningful text inside a dollar-quoted stored function.
  const normalized = schemaSql
    .replace(/^((?:[ \t]*--[^\n]*\r?\n|[ \t]*\r?\n)*)\\restrict \S+\r?\n/, "$1")
    .replace(/(^|\r?\n)\\unrestrict \S+[ \t]*(?:\r?\n[ \t]*)*$/, "$1");
  return digest(normalized);
}
function fingerprintSql(table: Pick<RecordTable, "primaryKey">) {
  const body = "to_jsonb(t)::text";
  const keyBody = table.primaryKey.length
    ? `jsonb_build_array(${table.primaryKey.map((column) => `to_jsonb(t)->${"'" + column.replace(/'/g, "''") + "'"}`).join(",")})::text`
    : body;
  return {
    body,
    key: `encode(sha256(convert_to(${keyBody}, 'UTF8')), 'hex')`,
    hash: `encode(sha256(convert_to(${body}, 'UTF8')), 'hex')`,
  };
}
async function assertSnapshot(client: RecordSqlClient, readOnly: boolean) {
  const settings = await client.query<{ isolation: string; readonly: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly",
  );
  check(
    ["repeatable read", "serializable"].includes(
      settings.rows[0]?.isolation ?? "",
    ) && settings.rows[0]?.readonly === (readOnly ? "on" : "off"),
    "requires an explicit consistent transaction",
  );
  // A role that cannot read all rows must fail, rather than certify an RLS subset.
  await client.query("SET LOCAL row_security = off");
  await client.query("SET LOCAL timezone = 'UTC'");
  await client.query("SET LOCAL datestyle = 'ISO, YMD'");
  await client.query("SET LOCAL extra_float_digits = 3");
  await client.query("SET LOCAL bytea_output = 'hex'");
}
export async function preparePostgresRecordRestore(
  client: RecordSqlClient,
): Promise<void> {
  await assertSnapshot(client, false);
}
async function tableCatalog(
  client: RecordSqlClient,
): Promise<Array<Omit<RecordTable, "rows">>> {
  const unsupported = await client.query<{ kind: string }>(`
    SELECT c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('f','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname !~ '^pg_(toast|temp)' LIMIT 1`);
  check(
    !unsupported.rows.length,
    "foreign/materialized table storage requires a supported baseline strategy",
  );
  const largeObjects = await client.query(
    "SELECT 1 FROM pg_largeobject_metadata LIMIT 1",
  );
  check(
    !largeObjects.rows.length,
    "PostgreSQL large objects require a supported baseline strategy",
  );
  const result = await client.query<{
    schema: string;
    name: string;
    columns: string[];
    allColumns: string[];
    primaryKey: string[];
  }>(`
    SELECT n.nspname AS schema, c.relname AS name,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
        AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum) AS columns,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
        AND NOT a.attisdropped ORDER BY a.attnum) AS "allColumns",
      ARRAY(SELECT a.attname::text FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
        WHERE i.indrelid=c.oid AND i.indisprimary AND k.ord<=i.indnkeyatts ORDER BY k.ord) AS "primaryKey"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname !~ '^pg_(toast|temp)' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`);
  // JSON tuple ordering is the persisted protocol order, independently of the DB collation.
  return result.rows.sort((a, b) =>
    tableIdentity(a) < tableIdentity(b)
      ? -1
      : tableIdentity(a) > tableIdentity(b)
        ? 1
        : 0,
  );
}
async function sequenceInventory(
  client: RecordSqlClient,
): Promise<RecordInventory["sequences"]> {
  const names = await client.query<{ schema: string; name: string }>(`
    SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'`);
  const sequences: RecordInventory["sequences"] = [];
  for (const name of names.rows) {
    const state = (
      await client.query<{ value: string; called: boolean }>(
        `SELECT last_value::text AS value,is_called AS called FROM ${relation(name)}`,
      )
    ).rows[0];
    check(state, "sequence state is unreadable");
    sequences.push({ ...name, ...state });
  }
  return sequences.sort((a, b) =>
    tableIdentity(a) < tableIdentity(b)
      ? -1
      : tableIdentity(a) > tableIdentity(b)
        ? 1
        : 0,
  );
}

/** Plan one SQL body page without exceeding the remaining capture buffer. */
export function recordBodyPageEnd(
  lengths: readonly number[], start: number, retainedBytes: number,
): number {
  check(Number.isSafeInteger(start) && start >= 0 && start < lengths.length &&
    Number.isSafeInteger(retainedBytes) && retainedBytes >= 0 && retainedBytes <= MAX_CHANGED_RECORD_BYTES,
    "invalid record body page budget");
  let end = start, selectedBytes = 0;
  while (end < lengths.length && end - start < 128) {
    const size = lengths[end]!;
    check(Number.isSafeInteger(size) && size > 0 && size <= MAX_CHANGED_RECORD_BYTES,
      "invalid record byte length");
    if (end > start && (selectedBytes + size > 8 * 1024 * 1024 ||
      retainedBytes + selectedBytes + size > MAX_CHANGED_RECORD_BYTES)) break;
    check(retainedBytes + selectedBytes + size <= MAX_CHANGED_RECORD_BYTES,
      "row-body page exceeds remaining capture capacity; no checkpoint was committed");
    selectedBytes += size; end++;
  }
  return end;
}

export async function capturePostgresRecordChanges(
  client: RecordSqlClient,
  options: {
    schemaSql: string | (() => Promise<string>);
    previous?: RecordInventory | null;
    signal?: AbortSignal;
    references?: (table: string, row: Record<string, unknown>) => string[];
    referenceProtocol?: string;
  },
): Promise<RecordCapture> {
  const started = Date.now();
  await assertSnapshot(client, true);
  const catalog = await tableCatalog(client);
  // Locks prevent truncate/rewrite/DDL while fingerprints and selected row bodies
  // are read; they do not block ordinary inserts/updates/deletes.
  for (const table of catalog)
    await client.query(
      `LOCK TABLE ONLY ${relation(table)} IN ACCESS SHARE MODE`,
    );
  const schemaSql =
    typeof options.schemaSql === "string"
      ? options.schemaSql
      : await options.schemaSql();
  const schemaHash = postgresSchemaHash(schemaSql);
  const previous = options.previous
    ? validateRecordInventory(options.previous)
    : null;
  const referenceProtocol =
    options.referenceProtocol ??
    digest(options.references?.toString() ?? "no-media-references-v1");
  check(
    digestPattern.test(referenceProtocol),
    "invalid media-reference protocol identity",
  );
  const compatible =
    previous?.schemaHash === schemaHash &&
    previous.referenceProtocol === referenceProtocol;
  const tables: RecordTable[] = [];
  const changes: RecordTableChanges[] = [];
  let fingerprintRows = 0,
    fingerprintMetadataBytes = 0,
    sourceRowBodyBytes = 0,
    retainedRowBodyBytes = 0,
    changedRows = 0,
    deletedRows = 0;
  for (const table of catalog) {
    options.signal?.throwIfAborted();
    const expressions = fingerprintSql(table);
    const priorTable = previous?.tables.find(
      (item) => tableIdentity(item) === tableIdentity(table),
    );
    const sameCatalog = priorTable &&
      JSON.stringify(priorTable.columns) === JSON.stringify(table.columns) &&
      JSON.stringify(priorTable.allColumns) === JSON.stringify(table.allColumns) &&
      JSON.stringify(priorTable.primaryKey) === JSON.stringify(table.primaryKey);
    const old = compatible ? priorTable : undefined;
    check(
      !compatible ||
        sameCatalog,
      "catalog changed without a matching schema baseline",
    );
    const oldRows = new Map((old?.rows ?? []).map((row) => [row.key, row]));
    // A schema/reference transition still reads every row and rebuilds every
    // reference. Exact prior bytes need not remain buffered while doing so;
    // protectRecordDatabase reauthenticates their stored proofs before reuse.
    const reusableBodies = new Map((!compatible && sameCatalog ? priorTable!.rows : [])
      .map((row) => [row.key, row]));
    const canReuseBody = (row: RecordFingerprint) => {
      const prior = reusableBodies.get(row.key);
      return prior?.hash === row.hash && prior.count === row.count;
    };
    const currentRows = new Map<string, RecordFingerprint>();
    const bodySizes = new Map<string, number>();
    const deletes: RecordTableChanges["deletes"] = [];
    const inserts: ChangedRecord[] = [];
    // Cursor pages keep transfer/memory bounded even for an unexpectedly large table.
    await client.query(`DECLARE labtrax_record_fingerprints NO SCROLL CURSOR FOR
      SELECT ${expressions.key} AS key,${expressions.hash} AS hash,count(*)::text AS count,
        octet_length(${expressions.body})::text AS bytes
      FROM ONLY ${relation(table)} t GROUP BY 1,2,4 ORDER BY 1`);
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const page = await client.query<{
          key: string;
          hash: string;
          count: string;
          bytes: string;
        }>("FETCH 512 FROM labtrax_record_fingerprints");
        if (!page.rows.length) break;
        for (const row of page.rows) {
          // Decoded SQL field payload bytes; protocol/TLS overhead is excluded.
          fingerprintMetadataBytes +=
            Buffer.byteLength(row.key) +
            Buffer.byteLength(row.hash) +
            Buffer.byteLength(row.count) +
            Buffer.byteLength(row.bytes);
          const bodyBytes = Number(row.bytes);
          check(
            Number.isSafeInteger(bodyBytes) && bodyBytes > 0 && bodyBytes <= MAX_CHANGED_RECORD_BYTES,
            "invalid record byte length",
          );
          bodySizes.set(row.key, bodyBytes);
          const count = Number(row.count);
          check(
            Number.isSafeInteger(count) &&
              count > 0 &&
              !currentRows.has(row.key),
            "duplicate key or fingerprint collision",
          );
          check(
            !table.primaryKey.length || count === 1,
            "primary key is not unique",
          );
          fingerprintRows += count;
          check(
            fingerprintRows <= MAX_RECORDS,
            "record inventory exceeds the supported capacity",
          );
          const prior = oldRows.get(row.key);
          currentRows.set(row.key, {
            key: row.key,
            hash: row.hash,
            count,
            references:
              prior?.hash === row.hash && prior.count === count
                ? prior.references
                : [],
          });
        }
      }
    } finally {
      await client.query("CLOSE labtrax_record_fingerprints");
    }
    const changed = [...currentRows.values()].filter((row) => {
      const prior = oldRows.get(row.key);
      return !prior || prior.hash !== row.hash || prior.count !== row.count;
    });
    check(
      retainedRowBodyBytes +
        changed.reduce((sum, row) => sum + (canReuseBody(row) ? 0 : bodySizes.get(row.key)!), 0) <=
        MAX_CHANGED_RECORD_BYTES,
      "changed record bodies exceed capacity; no checkpoint was committed",
    );
    for (const prior of oldRows.values()) {
      const row = currentRows.get(prior.key);
      if (!row || row.hash !== prior.hash || row.count !== prior.count) {
        deletes.push({ key: prior.key, hash: prior.hash, count: prior.count });
        deletedRows += prior.count;
      }
    }
    const changedBodySizes = changed.map(row => bodySizes.get(row.key)!);
    for (let start = 0; start < changed.length; ) {
      options.signal?.throwIfAborted();
      const end = recordBodyPageEnd(changedBodySizes, start, retainedRowBodyBytes);
      const selected = changed.slice(start, end);
      const bodies = await client.query<{
        key: string;
        hash: string;
        json: string;
        count: string;
      }>(
        `
        SELECT ${expressions.key} AS key,${expressions.hash} AS hash,${expressions.body} AS json,count(*)::text AS count
        FROM ONLY ${relation(table)} t WHERE ${expressions.key}=ANY($1::text[]) GROUP BY 1,2,3`,
        [selected.map((row) => row.key)],
      );
      const returned = new Set<string>();
      for (const body of bodies.rows) {
        const expected = currentRows.get(body.key);
        check(
          expected &&
            selected.some((row) => row.key === body.key) &&
            !returned.has(body.key) &&
            body.hash === expected.hash &&
            Number(body.count) === expected.count &&
            digest(body.json) === body.hash && Buffer.byteLength(body.json) === bodySizes.get(body.key),
          "row body does not match its snapshot fingerprint",
        );
        returned.add(body.key);
        sourceRowBodyBytes += Buffer.byteLength(body.json);
        const value = JSON.parse(body.json);
        check(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            JSON.stringify(Object.keys(value).sort()) ===
              JSON.stringify([...table.allColumns].sort()),
          "row/catalog columns changed during snapshot capture",
        );
        const refs = options.references?.(table.name, value) ?? [];
        expected.references = [...new Set(refs)].sort();
        check(
          expected.references.every(safeReference),
          "invalid referenced media path",
        );
        if (!canReuseBody(expected)) {
          retainedRowBodyBytes += Buffer.byteLength(body.json);
          check(
            retainedRowBodyBytes <= MAX_CHANGED_RECORD_BYTES,
            "changed row bodies exceed capacity; no checkpoint was committed",
          );
          inserts.push({
            key: body.key,
            hash: body.hash,
            count: expected.count,
            json: body.json,
          });
        }
        changedRows += expected.count;
      }
      check(
        returned.size === selected.length,
        "selected record bodies are missing",
      );
      start = end;
    }
    tables.push({
      ...table,
      rows: [...currentRows.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    });
    changes.push({ schema: table.schema, name: table.name, deletes, inserts });
  }
  if (compatible)
    check(
      previous!.tables.length === tables.length,
      "table catalog changed without a new schema baseline",
    );
  const inventory: RecordInventory = {
    format: RECORD_DELTA_FORMAT,
    schemaHash,
    referenceProtocol,
    tables,
    sequences: await sequenceInventory(client),
  };
  validateRecordInventory(inventory);
  return {
    inventory,
    bodies: changes,
    delta: compatible
      ? {
          format: RECORD_DELTA_FORMAT,
          beforeHash: recordInventoryHash(previous!),
          afterHash: recordInventoryHash(inventory),
          tables: changes,
        }
      : null,
    reason: !previous
      ? "first-baseline"
      : previous.schemaHash !== schemaHash
        ? "schema-changed"
        : previous.referenceProtocol !== referenceProtocol
          ? "reference-protocol-changed"
          : "changed-rows",
    metrics: {
      fingerprintRows,
      fingerprintMetadataBytes,
      schemaSqlBytes: Buffer.byteLength(schemaSql),
      sourceRowBodyBytes,
      changedRows,
      deletedRows,
      durationMs: Date.now() - started,
    },
  };
}

export function validateRecordDelta(
  delta: RecordDelta,
  before: RecordInventory,
  after: RecordInventory,
): void {
  check(
    delta?.format === RECORD_DELTA_FORMAT &&
      delta.beforeHash === recordInventoryHash(before) &&
      delta.afterHash === recordInventoryHash(after) &&
      before.schemaHash === after.schemaHash &&
      before.referenceProtocol === after.referenceProtocol,
    "delta checkpoint/schema binding differs",
  );
  check(
    Array.isArray(delta.tables) && delta.tables.length === after.tables.length,
    "delta table coverage differs",
  );
  assertSortedUnique(delta.tables.map(tableIdentity), "delta table inventory");
  for (const [index, table] of after.tables.entries()) {
    const change = delta.tables[index]!;
    const prior = before.tables[index]!;
    check(
      tableIdentity(table) === tableIdentity(change) &&
        tableIdentity(prior) === tableIdentity(table) &&
        JSON.stringify(table.columns) === JSON.stringify(prior.columns) &&
        JSON.stringify(table.allColumns) === JSON.stringify(prior.allColumns) &&
        JSON.stringify(table.primaryKey) === JSON.stringify(prior.primaryKey),
      "delta relation binding differs",
    );
    const old = new Map(prior.rows.map((row) => [row.key, row]));
    const next = new Map(table.rows.map((row) => [row.key, row]));
    const expectedDeletes = prior.rows.filter((row) => {
      const found = next.get(row.key);
      return !found || found.hash !== row.hash || found.count !== row.count;
    });
    const expectedInserts = table.rows.filter((row) => {
      const found = old.get(row.key);
      return !found || found.hash !== row.hash || found.count !== row.count;
    });
    const deletesByKey = new Map(expectedDeletes.map((row) => [row.key, row]));
    const insertsByKey = new Map(expectedInserts.map((row) => [row.key, row]));
    check(
      Array.isArray(change.deletes) &&
        Array.isArray(change.inserts) &&
        change.deletes.length === expectedDeletes.length &&
        change.inserts.length === expectedInserts.length,
      "delta omits or adds record operations",
    );
    const deleted = new Set<string>(),
      inserted = new Set<string>();
    for (const row of change.deletes) {
      const expected = deletesByKey.get(row.key);
      check(
        expected &&
          !deleted.has(row.key) &&
          row.hash === expected.hash &&
          row.count === expected.count,
        "invalid/duplicate deletion",
      );
      deleted.add(row.key);
    }
    for (const row of change.inserts) {
      const expected = insertsByKey.get(row.key);
      check(
        expected &&
          !inserted.has(row.key) &&
          row.hash === expected.hash &&
          row.count === expected.count &&
          typeof row.json === "string" &&
          digest(row.json) === row.hash,
        "invalid/duplicate inserted row body",
      );
      const parsed = JSON.parse(row.json);
      check(
        parsed && typeof parsed === "object" && !Array.isArray(parsed),
        "record body is not an object",
      );
      inserted.add(row.key);
    }
  }
  check(
    Buffer.byteLength(JSON.stringify(delta)) <=
      MAX_CHANGED_RECORD_BYTES + MAX_RECORD_METADATA_BYTES,
    "delta exceeds capacity",
  );
}

/** Compare stored rows, not just a restore receipt, before/after replay. */
export async function verifyPostgresRecordInventory(
  client: RecordSqlClient,
  expected: RecordInventory,
  verifySequences = true,
): Promise<void> {
  validateRecordInventory(expected);
  const catalog = await tableCatalog(client);
  check(
    catalog.length === expected.tables.length,
    "restore table inventory differs",
  );
  for (const [index, table] of expected.tables.entries()) {
    const actual = catalog[index]!;
    check(
      tableIdentity(actual) === tableIdentity(table) &&
        JSON.stringify(actual.columns) === JSON.stringify(table.columns) &&
        JSON.stringify(actual.allColumns) ===
          JSON.stringify(table.allColumns) &&
        JSON.stringify(actual.primaryKey) === JSON.stringify(table.primaryKey),
      "restore table schema differs",
    );
    const expressions = fingerprintSql(table);
    const rows = await client.query<{
      key: string;
      hash: string;
      count: string;
    }>(`
      SELECT ${expressions.key} AS key,${expressions.hash} AS hash,count(*)::text AS count
      FROM ONLY ${relation(table)} t GROUP BY 1,2 ORDER BY 1`);
    const values = rows.rows
      .map((row) => ({
        key: row.key,
        hash: row.hash,
        count: Number(row.count),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    check(
      JSON.stringify(values) ===
        JSON.stringify(
          table.rows.map(({ key, hash, count }) => ({ key, hash, count })),
        ),
      "restore row bytes/counts differ from the authenticated inventory",
    );
  }
  if (verifySequences)
    check(
      JSON.stringify(await sequenceInventory(client)) ===
        JSON.stringify(expected.sequences),
      "restore sequence state differs from the authenticated inventory",
    );
}

/** Insert into a schema restored with pg_restore --section=pre-data. */
export async function insertPostgresRecordBody(
  client: RecordSqlClient,
  table: RecordTable,
  json: string,
  count: number,
): Promise<void> {
  check(
    Number.isSafeInteger(count) && count > 0 && count <= MAX_RECORDS,
    "invalid restored row multiplicity",
  );
  const columns = table.columns.map(identifier).join(",");
  if (!columns) {
    for (let index = 0; index < count; index++)
      await client.query(`INSERT INTO ${relation(table)} DEFAULT VALUES`);
  } else {
    const result = await client.query(
      `INSERT INTO ${relation(table)} (${columns}) OVERRIDING SYSTEM VALUE
      SELECT ${table.columns.map((column) => `r.${identifier(column)}`).join(",")} FROM
      jsonb_populate_record(NULL::${relation(table)},$1::jsonb) r CROSS JOIN generate_series(1,$2::int)`,
      [json, count],
    );
    check(result.rowCount === count, "restored row count differs");
  }
}

/**
 * Caller must own a disposable, isolated target and a repeatable-read write
 * transaction. No live-restore entry point is exposed here. The public restore
 * wrapper retains its loopback/name/empty-target acknowledgement guards.
 */
export async function replayPostgresRecordDelta(
  client: RecordSqlClient,
  delta: RecordDelta,
  before: RecordInventory,
  after: RecordInventory,
): Promise<void> {
  validateRecordDelta(delta, before, after);
  await assertSnapshot(client, false);
  await verifyPostgresRecordInventory(client, before);
  // FK constraints are restored and validated before this transaction can
  // commit; USER triggers are restored as originally enabled/disabled. This
  // avoids firing application side effects while reconstructing stored rows.
  const foreignKeys = await client.query<{
    schema: string;
    name: string;
    constraint: string;
    definition: string;
    validated: boolean;
  }>(`
    SELECT n.nspname AS schema,c.relname AS name,k.conname AS constraint,
      pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE k.contype='f' AND k.conparentid=0 AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname !~ '^pg_(toast|temp)' ORDER BY k.oid`);
  const triggers = await client.query<{
    schema: string;
    name: string;
    trigger: string;
    enabled: string;
  }>(`
    SELECT n.nspname AS schema,c.relname AS name,t.tgname AS trigger,t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'`);
  for (const fk of foreignKeys.rows)
    await client.query(
      `ALTER TABLE ${relation(fk)} DROP CONSTRAINT ${identifier(fk.constraint)}`,
    );
  for (const trigger of triggers.rows)
    await client.query(
      `ALTER TABLE ${relation(trigger)} DISABLE TRIGGER ${identifier(trigger.trigger)}`,
    );
  for (const change of delta.tables) {
    const table = before.tables.find(
      (item) => tableIdentity(item) === tableIdentity(change),
    )!;
    const expressions = fingerprintSql(table);
    for (const row of change.deletes) {
      const result = await client.query(
        `DELETE FROM ONLY ${relation(table)} t WHERE ${expressions.key}=$1 AND ${expressions.hash}=$2`,
        [row.key, row.hash],
      );
      check(
        result.rowCount === row.count,
        "restore base row differs; transaction must roll back",
      );
    }
  }
  for (const change of delta.tables) {
    const table = after.tables.find(
      (item) => tableIdentity(item) === tableIdentity(change),
    )!;
    for (const row of change.inserts) {
      await insertPostgresRecordBody(client, table, row.json, row.count);
    }
  }
  for (const fk of foreignKeys.rows) {
    // pg_get_constraintdef includes NOT VALID when originally unvalidated.
    await client.query(
      `ALTER TABLE ${relation(fk)} ADD CONSTRAINT ${identifier(fk.constraint)} ${fk.definition}`,
    );
  }
  for (const trigger of triggers.rows) {
    const mode =
      trigger.enabled === "D"
        ? "DISABLE"
        : trigger.enabled === "A"
          ? "ENABLE ALWAYS"
          : trigger.enabled === "R"
            ? "ENABLE REPLICA"
            : "ENABLE";
    await client.query(
      `ALTER TABLE ${relation(trigger)} ${mode} TRIGGER ${identifier(trigger.trigger)}`,
    );
  }
  await verifyPostgresRecordInventory(client, after, false);
  // setval is non-transactional in PostgreSQL. It is intentionally last, after
  // every constraint/row validation, in a target that is disposable on failure.
  for (const sequence of after.sequences)
    await client.query("SELECT setval($1::regclass,$2::bigint,$3::boolean)", [
      relation(sequence),
      sequence.value,
      sequence.called,
    ]);
  await verifyPostgresRecordInventory(client, after);
}
