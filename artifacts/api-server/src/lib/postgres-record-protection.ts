import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import type {
  DatabaseCodec,
  DatabaseDumpSource,
  DatabaseObjectStore,
} from "./database-protection";
import {
  objectVersionSchema,
  sameObjectVersion,
  type ObjectVersion,
} from "./object-version-proof";
import {
  RECORD_DELTA_FORMAT,
  RecordRecoveryError,
  MAX_RECORD_METADATA_BYTES,
  recordInventoryHash,
  validateRecordInventory,
  validateRecordDelta,
  type RecordCapture,
  type RecordInventory,
} from "./postgres-record-delta";

export const POSTGRES_RECORD_POINT_FORMAT =
  "labtrax-postgresql-record-point-v1";
const CHUNK_BYTES = 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 16_384;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const markerName = z
  .string()
  .regex(/^records-verified-\d{13}-[a-f0-9-]{36}\.enc$/);
const proof = z
  .object({
    hash: digest,
    bytes: z.number().int().positive().max(CHUNK_BYTES),
    cipherHash: digest,
    cipherBytes: z
      .number()
      .int()
      .positive()
      .max(8 * CHUNK_BYTES),
    version: objectVersionSchema.optional(),
  })
  .strict();
type Proof = z.infer<typeof proof>;
const part = z
  .object({
    hash: digest,
    offset: z.number().int().nonnegative().max(CHUNK_BYTES),
    bytes: z.number().int().positive().max(CHUNK_BYTES),
  })
  .strict();
const location = z
  .object({
    table: z.number().int().nonnegative(),
    key: digest,
    parts: z.array(part).min(1).max(256),
  })
  .strict();
type Location = z.infer<typeof location>;
const metadataSchema = z
  .object({
    format: z.literal(POSTGRES_RECORD_POINT_FORMAT),
    records: z.unknown(),
    schema: z
      .object({
        hash: digest,
        bytes: z.number().int().positive().max(MAX_SCHEMA_BYTES),
        chunks: z.array(proof).min(1).max(64),
      })
      .strict(),
    chunks: z.array(proof).max(MAX_CHUNKS),
    locations: z.array(location).max(2_000_000),
  })
  .strict();
export type RecordPointInventory = Omit<
  z.infer<typeof metadataSchema>,
  "records"
> & { records: RecordInventory };
const manifestSchema = z
  .object({
    format: z.literal(POSTGRES_RECORD_POINT_FORMAT),
    source: digest,
    protection: z.literal("database-only"),
    capture: z.enum(["postgresql-record-baseline", "changed-postgresql-rows"]),
    point: z.string().uuid(),
    createdAt: z.string().datetime(),
    previousPoint: z.string().uuid().nullable(),
    parent: z
      .object({ marker: markerName, cipherHash: digest })
      .strict()
      .nullable(),
    inventory: z.array(proof).min(1).max(256),
    inventoryHash: digest,
    inventoryBytes: z.number().int().positive().max(MAX_RECORD_METADATA_BYTES),
    dumpHash: digest,
    dumpBytes: z.number().int().nonnegative(),
    chunks: z.array(proof).max(MAX_CHUNKS),
    newBytes: z.number().int().nonnegative(),
    newChunks: z.number().int().nonnegative(),
    metrics: z
      .object({
        fingerprintRows: z.number().int().nonnegative(),
        sourceRowBodyBytes: z.number().int().nonnegative(),
        fingerprintMetadataBytes: z.number().int().nonnegative(),
        schemaSqlBytes: z.number().int().nonnegative(),
        changedRows: z.number().int().nonnegative(),
        deletedRows: z.number().int().nonnegative(),
        durationMs: z.number().nonnegative(),
        schemaSourceBytes: z.number().int().nonnegative(),
        remoteBodyBytesRead: z.number().int().nonnegative(),
        remoteMetadataBytesRead: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type RecordDatabasePoint = z.infer<typeof manifestSchema>;
const markerSchema = z
  .object({
    format: z.literal(POSTGRES_RECORD_POINT_FORMAT),
    source: digest,
    manifest: z.string().regex(/^records-point-\d{13}-[a-f0-9-]{36}\.enc$/),
    cipherHash: digest,
  })
  .strict();
export interface RecordDatabaseCapture {
  kind: typeof RECORD_DELTA_FORMAT;
  records: RecordCapture;
  /** Schema-only custom-format pg_dump, never a data export. Null when reused. */
  schemaDump: DatabaseDumpSource | null;
}
export function isRecordDatabaseCapture(
  value: unknown,
): value is RecordDatabaseCapture {
  return (
    !!value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === RECORD_DELTA_FORMAT
  );
}
export interface VerifiedRecordDatabasePoint {
  marker: string;
  manifest: RecordDatabasePoint;
  recordSnapshot: RecordPointInventory;
  manifestCipherHash: string;
}
interface Options {
  store: DatabaseObjectStore;
  codec: DatabaseCodec;
  source: string;
}
interface Io extends Options {
  bodyBytes: number;
  metadataBytes: number;
  newBytes: number;
  newChunks: number;
  versions?: ReadonlyMap<string, ObjectVersion | null>;
}
function fail(message: string): never {
  throw new RecordRecoveryError(`Record recovery: ${message}`);
}
function objectName(namespace: "body" | "schema" | "inventory", sha: string) {
  return `records-${namespace}-${sha}.enc`;
}
async function encrypted(io: Io, name: string, max = 8 * CHUNK_BYTES) {
  const value = await io.store.get(name);
  if (!value || value.length > max)
    fail("required object is missing or oversized");
  if (name.startsWith("records-body-")) io.bodyBytes += value.length;
  else io.metadataBytes += value.length;
  return value;
}
async function continuity(io: Io, name: string, p: Proof) {
  if (p.version && io.store.getVersion) {
    const current = io.versions?.has(name)
      ? (io.versions.get(name) ?? null)
      : await io.store.getVersion(name);
    if (
      !sameObjectVersion(p.version, current) ||
      current?.bytes !== p.cipherBytes
    )
      fail("byte-verified dependency content version changed or is missing");
    return;
  }
  const integrity = io.store.getIntegrity
    ? await io.store.getIntegrity(name)
    : null;
  if (
    !integrity?.sha256 ||
    integrity.bytes !== p.cipherBytes ||
    integrity.sha256 !== p.cipherHash
  ) {
    fail(
      "unchanged record dependency lacks fresh strong integrity/version continuity evidence",
    );
  }
}
async function readProof(
  io: Io,
  namespace: "body" | "schema" | "inventory",
  p: Proof,
) {
  proof.parse(p);
  const name = objectName(namespace, p.hash);
  const before = io.store.getVersion ? await io.store.getVersion(name) : null;
  const received = await encrypted(io, name);
  const after = io.store.getVersion ? await io.store.getVersion(name) : null;
  if (
    io.store.getVersion &&
    (!before ||
      !sameObjectVersion(before, after) ||
      (p.version && !sameObjectVersion(p.version, before)))
  )
    fail("content version changed during byte verification");
  if (received.length !== p.cipherBytes || hash(received) !== p.cipherHash)
    fail("ciphertext differs from authenticated byte proof");
  let plain: Buffer;
  try {
    plain = io.codec.decrypt(received);
  } catch {
    fail("object authentication/decryption failed");
  }
  if (plain!.length !== p.bytes || hash(plain!) !== p.hash)
    fail("plaintext byte integrity differs");
  return plain!;
}
async function putProof(
  io: Io,
  namespace: "body" | "schema" | "inventory",
  bytes: Buffer,
  known?: Proof,
): Promise<Proof> {
  const sha = hash(bytes),
    name = objectName(namespace, sha);
  if (!bytes.length || bytes.length > CHUNK_BYTES)
    fail("invalid object chunk size");
  if (known) {
    if (known.hash !== sha || known.bytes !== bytes.length)
      fail("inconsistent reused object proof");
    await continuity(io, name, known);
    return known;
  }
  // Orphans from interrupted uploads can be adopted only after byte proof.
  const existing = io.store.getIntegrity
    ? await io.store.getIntegrity(name)
    : await io.store.get(name);
  if (!existing) {
    const output = io.codec.encrypt(bytes);
    await io.store.put(name, output);
    io.newBytes += output.length;
    io.newChunks++;
  }
  const before = io.store.getVersion ? await io.store.getVersion(name) : null;
  const received = await encrypted(io, name);
  const after = io.store.getVersion ? await io.store.getVersion(name) : null;
  if (io.store.getVersion && (!before || !sameObjectVersion(before, after)))
    fail("upload/read-back content version race");
  let plain: Buffer;
  try {
    plain = io.codec.decrypt(received);
  } catch {
    fail("uploaded object authentication failed");
  }
  if (plain!.length !== bytes.length || hash(plain!) !== sha)
    fail("uploaded/read-back bytes differ");
  return {
    hash: sha,
    bytes: bytes.length,
    cipherHash: hash(received),
    cipherBytes: received.length,
    ...(after ? { version: after } : {}),
  };
}
function ioFor(options: Options): Io {
  return {
    ...options,
    bodyBytes: 0,
    metadataBytes: 0,
    newBytes: 0,
    newChunks: 0,
  };
}
async function writeSmall(io: Io, name: string, bytes: Buffer) {
  if (await io.store.get(name))
    fail("immutable point identity collision; existing point preserved");
  await io.store.put(name, bytes);
  io.newBytes += bytes.length;
  const received = await encrypted(io, name);
  if (received.length !== bytes.length || hash(received) !== hash(bytes))
    fail("point write/read-back mismatch");
}
async function schemaProofs(io: Io, source: DatabaseDumpSource) {
  const input = Buffer.isBuffer(source)
    ? (async function* () {
        yield source;
      })()
    : source;
  const result: Proof[] = [];
  const digest = createHash("sha256");
  let pending = Buffer.alloc(0),
    total = 0,
    header = Buffer.alloc(0);
  for await (const piece of input) {
    const bytes = Buffer.from(piece);
    total += bytes.length;
    digest.update(bytes);
    if (total > MAX_SCHEMA_BYTES) fail("schema baseline exceeds capacity");
    if (header.length < 5)
      header = Buffer.concat([header, bytes.subarray(0, 5 - header.length)]);
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(
        CHUNK_BYTES - pending.length,
        bytes.length - offset,
      );
      pending = Buffer.concat([pending, bytes.subarray(offset, offset + take)]);
      offset += take;
      if (pending.length === CHUNK_BYTES) {
        result.push(await putProof(io, "schema", pending));
        pending = Buffer.alloc(0);
      }
    }
  }
  if (pending.length) result.push(await putProof(io, "schema", pending));
  if (header.toString("ascii") !== "PGDMP")
    fail("schema baseline is not a PostgreSQL custom-format export");
  return { hash: digest.digest("hex"), bytes: total, chunks: result };
}
function validateMetadata(value: unknown): RecordPointInventory {
  const parsed = metadataSchema.parse(value);
  const records = validateRecordInventory(parsed.records as RecordInventory);
  const chunks = new Map(parsed.chunks.map((p) => [p.hash, p]));
  if (chunks.size !== parsed.chunks.length)
    fail("duplicate record chunk identities");
  const expectedLocations = new Set(
    records.tables.flatMap((table, index) =>
      table.rows.map((row) => `${index}:${row.key}`),
    ),
  );
  const locations = new Map<string, Location>();
  const used = new Set<string>();
  for (const item of parsed.locations) {
    const key = `${item.table}:${item.key}`;
    if (locations.has(key) || !expectedLocations.has(key))
      fail("duplicate/unbound record body location");
    let length = 0;
    for (const p of item.parts) {
      const c = chunks.get(p.hash);
      if (!c || p.offset + p.bytes > c.bytes)
        fail("record body has an inconsistent/missing chunk dependency");
      length += p.bytes;
      used.add(p.hash);
    }
    if (!length || length > 256 * CHUNK_BYTES)
      fail("record body exceeds capacity");
    locations.set(key, item);
  }
  if (
    used.size !== chunks.size ||
    parsed.locations.length !==
      records.tables.reduce((sum, t) => sum + t.rows.length, 0)
  )
    fail("record body coverage differs from inventory");
  return { ...parsed, records };
}
async function loadManifest(io: Io, marker: string) {
  markerName.parse(marker);
  const committed = markerSchema.parse(
    JSON.parse(io.codec.decrypt(await encrypted(io, marker)).toString("utf8")),
  );
  if (
    committed.source !== io.source ||
    committed.manifest.replace("records-point-", "records-verified-") !== marker
  )
    fail("point marker/source binding differs");
  const cipher = await encrypted(io, committed.manifest);
  if (hash(cipher) !== committed.cipherHash)
    fail("point manifest integrity differs");
  const manifest = manifestSchema.parse(
    JSON.parse(io.codec.decrypt(cipher).toString("utf8")),
  );
  if (
    manifest.source !== io.source ||
    `records-point-${Date.parse(manifest.createdAt)}-${manifest.point}.enc` !==
      committed.manifest ||
    !!manifest.parent !== !!manifest.previousPoint
  )
    fail("point/source/parent binding differs");
  return { manifest, cipherHash: committed.cipherHash };
}
async function loadInventory(io: Io, manifest: RecordDatabasePoint) {
  const pieces: Buffer[] = [];
  let total = 0;
  for (const p of manifest.inventory) {
    const bytes = await readProof(io, "inventory", p);
    total += bytes.length;
    if (total > MAX_RECORD_METADATA_BYTES)
      fail("compressed record inventory exceeds capacity");
    pieces.push(bytes);
  }
  const data = gunzipSync(Buffer.concat(pieces, total), {
    maxOutputLength: MAX_RECORD_METADATA_BYTES,
  });
  if (
    data.length !== manifest.inventoryBytes ||
    hash(data) !== manifest.inventoryHash
  )
    fail("record inventory byte binding differs");
  const inventory = validateMetadata(JSON.parse(data.toString("utf8")));
  if (
    recordInventoryHash(inventory.records) !== manifest.dumpHash ||
    JSON.stringify(inventory.chunks) !== JSON.stringify(manifest.chunks)
  )
    fail("record checkpoint and object inventory disagree");
  return inventory;
}
export async function verifyRecordDatabasePoint(
  options: Options,
  marker: string,
): Promise<VerifiedRecordDatabasePoint> {
  const io = ioFor(options);
  const loaded = await loadManifest(io, marker);
  let child = loaded.manifest;
  const visited = new Set([child.point]);
  while (child.parent) {
    if (visited.size > 100_000) fail("record point ancestry exceeds capacity");
    const parent = await loadManifest(io, child.parent.marker);
    if (
      child.parent.cipherHash !== parent.cipherHash ||
      child.previousPoint !== parent.manifest.point ||
      visited.has(parent.manifest.point) ||
      Date.parse(parent.manifest.createdAt) >= Date.parse(child.createdAt)
    )
      fail("cyclic/inconsistent record point ancestry");
    visited.add(parent.manifest.point);
    child = parent.manifest;
  }
  const recordSnapshot = await loadInventory(io, loaded.manifest);
  if (io.store.getVersions)
    io.versions = await io.store.getVersions([
      ...recordSnapshot.chunks.map((p) => objectName("body", p.hash)),
      ...recordSnapshot.schema.chunks.map((p) => objectName("schema", p.hash)),
    ]);
  // Self-contained inventories reference every retained row/schema byte. No
  // ancestor data scan or full-body read is needed for interval continuity.
  for (const p of recordSnapshot.chunks)
    await continuity(io, objectName("body", p.hash), p);
  for (const p of recordSnapshot.schema.chunks)
    await continuity(io, objectName("schema", p.hash), p);
  return {
    marker,
    manifest: loaded.manifest,
    recordSnapshot,
    manifestCipherHash: loaded.cipherHash,
  };
}

export async function protectRecordDatabase(
  options: Options & {
    capture: RecordDatabaseCapture;
    previous?: VerifiedRecordDatabasePoint | null;
    now?: Date;
  },
): Promise<VerifiedRecordDatabasePoint> {
  digest.parse(options.source);
  const io = ioFor(options);
  const { records } = options.capture;
  const beforeIo = options.store.readStats?.();
  validateRecordInventory(records.inventory);
  const previous = options.previous
    ? await verifyRecordDatabasePoint(options, options.previous.marker)
    : null;
  if (records.delta) {
    if (!previous) fail("record changes have no compatible verified baseline");
    validateRecordDelta(
      records.delta,
      previous.recordSnapshot.records,
      records.inventory,
    );
  } else if (previous && records.reason === "first-baseline")
    fail(
      "existing baseline was discarded without an explicit schema transition",
    );
  if (
    !options.capture.schemaDump &&
    previous?.recordSnapshot.records.schemaHash !== records.inventory.schemaHash
  )
    fail("new/schema baseline has no schema-only PostgreSQL export");
  if (
    !records.delta &&
    records.reason === "schema-changed" &&
    previous?.recordSnapshot.records.schemaHash === records.inventory.schemaHash
  )
    fail("schema baseline transition has no schema change");
  if (
    previous &&
    records.reason === "reference-protocol-changed" &&
    previous.recordSnapshot.records.referenceProtocol ===
      records.inventory.referenceProtocol
  )
    fail("reference baseline transition has no protocol change");
  const oldLocations = new Map<string, Location>();
  const oldBodies = new Map<string, Location>();
  const known = new Map<string, Proof>();
  if (previous) {
    for (const p of previous.recordSnapshot.chunks) known.set(p.hash, p);
    const rowsByTable = previous.recordSnapshot.records.tables.map(
      (table) => new Map(table.rows.map((row) => [row.key, row])),
    );
    for (const loc of previous.recordSnapshot.locations) {
      const table = previous.recordSnapshot.records.tables[loc.table]!;
      const row = rowsByTable[loc.table]!.get(loc.key)!;
      oldLocations.set(
        JSON.stringify([table.schema, table.name, loc.key]),
        loc,
      );
      oldBodies.set(row.hash, loc);
    }
  }
  const selected = new Map<
    string,
    { json: string; hash: string; count: number }
  >();
  for (const table of records.bodies)
    for (const row of table.inserts) {
      const key = JSON.stringify([table.schema, table.name, row.key]);
      if (selected.has(key) || hash(Buffer.from(row.json)) !== row.hash)
        fail("selected row body is duplicate or corrupt");
      selected.set(key, row);
    }
  const locations: Location[] = [],
    chunkProofs = new Map<string, Proof>(),
    newLocations = new Set<string>();
  let pending = Buffer.alloc(0);
  let pendingParts: Array<z.infer<typeof part>> = [];
  let pendingBodies: Array<{ key: string; body: { json: string } }> = [];
  const selectedCount = selected.size;
  function releaseBody(key: string, body: { json: string }) {
    body.json = "";
    selected.delete(key);
  }
  async function flush() {
    if (!pending.length) return;
    const p = await putProof(io, "body", pending, known.get(hash(pending)));
    chunkProofs.set(p.hash, p);
    for (const item of pendingParts) item.hash = p.hash;
    for (const item of pendingBodies) releaseBody(item.key, item.body);
    pending = Buffer.alloc(0);
    pendingParts = [];
    pendingBodies = [];
  }
  let selectedUsed = 0;
  for (const [tableIndex, table] of records.inventory.tables.entries())
    for (const row of table.rows) {
      const key = JSON.stringify([table.schema, table.name, row.key]);
      const body = selected.get(key);
      const prior = oldBodies.get(row.hash);
      const priorAtKey = oldLocations.get(key);
      if (body) {
        if (body.hash !== row.hash || body.count !== row.count)
          fail("selected body/checkpoint count differs");
        selectedUsed++;
      } else if (!priorAtKey || !prior) fail("changed row body was omitted");
      const loc: Location = { table: tableIndex, key: row.key, parts: [] };
      if (prior) {
        loc.parts = prior.parts.map((p) => ({ ...p }));
        for (const p of loc.parts) {
          const proof = known.get(p.hash);
          if (!proof) fail("prior body proof is missing");
          chunkProofs.set(p.hash, proof);
        }
        if (body) releaseBody(key, body);
      } else {
        newLocations.add(`${tableIndex}:${row.key}`);
        if (!body) fail("new row body is absent");
        const bytes = Buffer.from(body.json);
        if (bytes.length > CHUNK_BYTES) {
          await flush();
          for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
            const piece = bytes.subarray(offset, offset + CHUNK_BYTES),
              p = await putProof(io, "body", piece, known.get(hash(piece)));
            chunkProofs.set(p.hash, p);
            loc.parts.push({ hash: p.hash, offset: 0, bytes: piece.length });
          }
          releaseBody(key, body);
        } else {
          if (pending.length + bytes.length > CHUNK_BYTES) await flush();
          const item = {
            hash: "",
            offset: pending.length,
            bytes: bytes.length,
          };
          pendingParts.push(item);
          pendingBodies.push({ key, body });
          loc.parts.push(item);
          pending = Buffer.concat([pending, bytes]);
        }
      }
      locations.push(loc);
    }
  await flush();
  if (selectedUsed !== selectedCount || selected.size)
    fail("selected row bodies exceed snapshot coverage");
  const schema = options.capture.schemaDump
    ? await schemaProofs(io, options.capture.schemaDump)
    : previous?.recordSnapshot.records.schemaHash ===
        records.inventory.schemaHash
      ? previous.recordSnapshot.schema
      : null;
  if (!schema) fail("new/schema baseline has no schema-only PostgreSQL export");
  const inventory = validateMetadata({
    format: POSTGRES_RECORD_POINT_FORMAT,
    records: records.inventory,
    schema,
    chunks: [...chunkProofs.values()].sort((a, b) =>
      a.hash < b.hash ? -1 : 1,
    ),
    locations,
  });
  await readBodiesFromSnapshot(
    io,
    inventory,
    async () => undefined,
    newLocations,
  );
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  if (inventoryBytes.length > MAX_RECORD_METADATA_BYTES)
    fail("record inventory exceeds capacity");
  const compressed = gzipSync(inventoryBytes),
    inventoryProofs: Proof[] = [];
  for (let offset = 0; offset < compressed.length; offset += CHUNK_BYTES)
    inventoryProofs.push(
      await putProof(
        io,
        "inventory",
        compressed.subarray(offset, offset + CHUNK_BYTES),
      ),
    );
  const createdAt = new Date(
    Math.max(
      (options.now ?? new Date()).getTime(),
      previous ? Date.parse(previous.manifest.createdAt) + 1 : 0,
    ),
  ).toISOString();
  const currentIo = options.store.readStats?.();
  const bodyBytes =
    currentIo && beforeIo
      ? currentIo.recordBodyBytesRead - beforeIo.recordBodyBytesRead
      : io.bodyBytes;
  const metadataBytes =
    currentIo && beforeIo
      ? currentIo.bytesRead - beforeIo.bytesRead - bodyBytes
      : io.metadataBytes;
  const manifest: RecordDatabasePoint = {
    format: POSTGRES_RECORD_POINT_FORMAT,
    protection: "database-only",
    source: options.source,
    capture: records.delta
      ? "changed-postgresql-rows"
      : "postgresql-record-baseline",
    point: randomUUID(),
    createdAt,
    previousPoint: previous?.manifest.point ?? null,
    parent: previous
      ? { marker: previous.marker, cipherHash: previous.manifestCipherHash }
      : null,
    inventory: inventoryProofs,
    inventoryHash: hash(inventoryBytes),
    inventoryBytes: inventoryBytes.length,
    dumpHash: recordInventoryHash(records.inventory),
    dumpBytes: records.metrics.sourceRowBodyBytes,
    chunks: inventory.chunks,
    newBytes: io.newBytes,
    newChunks: io.newChunks,
    metrics: {
      ...records.metrics,
      schemaSourceBytes: options.capture.schemaDump ? schema.bytes : 0,
      remoteBodyBytesRead: bodyBytes,
      remoteMetadataBytesRead: metadataBytes,
    },
  };
  manifestSchema.parse(manifest);
  const manifestName = `records-point-${Date.parse(createdAt)}-${manifest.point}.enc`;
  const cipher = io.codec.encrypt(Buffer.from(JSON.stringify(manifest)));
  await writeSmall(io, manifestName, cipher);
  // Verify every referenced dependency BEFORE committing a point. The marker
  // write is the only commit; interruption leaves immutable orphan objects.
  await loadInventory(io, manifest);
  if (io.store.getVersions)
    io.versions = await io.store.getVersions([
      ...inventory.chunks.map((p) => objectName("body", p.hash)),
      ...schema.chunks.map((p) => objectName("schema", p.hash)),
    ]);
  for (const p of inventory.chunks)
    await continuity(io, objectName("body", p.hash), p);
  for (const p of schema.chunks)
    await continuity(io, objectName("schema", p.hash), p);
  const marker = manifestName.replace("records-point-", "records-verified-");
  await writeSmall(
    io,
    marker,
    io.codec.encrypt(
      Buffer.from(
        JSON.stringify({
          format: POSTGRES_RECORD_POINT_FORMAT,
          source: options.source,
          manifest: manifestName,
          cipherHash: hash(cipher),
        }),
      ),
    ),
  );
  return verifyRecordDatabasePoint(options, marker);
}

export async function readRecordSchema(
  options: Options,
  verified: VerifiedRecordDatabasePoint,
  consume: (bytes: Buffer) => Promise<void>,
) {
  const io = ioFor(options),
    h = createHash("sha256");
  let total = 0;
  for (const p of verified.recordSnapshot.schema.chunks) {
    const bytes = await readProof(io, "schema", p);
    h.update(bytes);
    total += bytes.length;
    await consume(bytes);
  }
  if (
    total !== verified.recordSnapshot.schema.bytes ||
    h.digest("hex") !== verified.recordSnapshot.schema.hash
  )
    fail("schema export byte integrity differs");
}
export async function readRecordBodies(
  options: Options,
  verified: VerifiedRecordDatabasePoint,
  consume: (
    table: RecordInventory["tables"][number],
    json: string,
    count: number,
  ) => Promise<void>,
) {
  return readBodiesFromSnapshot(
    ioFor(options),
    verified.recordSnapshot,
    consume,
  );
}
async function readBodiesFromSnapshot(
  io: Io,
  snapshot: RecordPointInventory,
  consume: (
    table: RecordInventory["tables"][number],
    json: string,
    count: number,
  ) => Promise<void>,
  selected?: ReadonlySet<string>,
) {
  const proofs = new Map(snapshot.chunks.map((p) => [p.hash, p]));
  const rowsByTable = snapshot.records.tables.map(
    (table) => new Map(table.rows.map((row) => [row.key, row])),
  );
  // One bounded chunk cache; reading a large restore does not retain all data.
  let cachedHash = "";
  let cached: Buffer = Buffer.alloc(0);
  for (const loc of snapshot.locations) {
    if (selected && !selected.has(`${loc.table}:${loc.key}`)) continue;
    const table = snapshot.records.tables[loc.table]!,
      row = rowsByTable[loc.table]!.get(loc.key)!;
    const pieces: Buffer[] = [];
    for (const part of loc.parts) {
      if (cachedHash !== part.hash) {
        cached = await readProof(io, "body", proofs.get(part.hash)!);
        cachedHash = part.hash;
      }
      pieces.push(cached.subarray(part.offset, part.offset + part.bytes));
    }
    const bytes = Buffer.concat(pieces);
    if (hash(bytes) !== row.hash)
      fail("restored record bytes differ from authenticated row fingerprint");
    const json = bytes.toString("utf8"),
      value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("restored row is not an object");
    await consume(table, json, row.count);
  }
}
