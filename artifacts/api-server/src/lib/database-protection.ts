import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ObjectVersion } from "./object-version-proof";
import { verifyRecordDatabasePoint, type RecordDatabasePoint, type RecordPointInventory } from "./postgres-record-protection";

// Incremental storage keeps the existing manifest protocol, while capture and
// verification operate on one bounded chunk at a time.
export const DATABASE_PROTECTION_FORMAT = "labtrax-database-chunks-v1";
export const MAX_DATABASE_CHUNK_BYTES = 1024 * 1024;
export const MAX_DATABASE_CHUNKS = 16_384;
export const MAX_DATABASE_DUMP_BYTES = MAX_DATABASE_CHUNK_BYTES * MAX_DATABASE_CHUNKS;
export const DATABASE_PROTECTION_RETENTION_GRACE_HOURS = 48;
export const DATABASE_PROTECTION_RETENTION_POLICY = {
  keepAllWithinHours: 24,
  keepHourlyWithinDays: 7,
  keepDailyWithinDays: 30,
  minimumNewestPoints: 2,
} as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const chunkSchema = z.object({
  hash: digest, bytes: z.number().int().positive().max(MAX_DATABASE_CHUNK_BYTES),
}).strict();
const manifestSchema = z.object({
  format: z.literal(DATABASE_PROTECTION_FORMAT),
  protection: z.literal("database-only"),
  capture: z.literal("fresh-consistent-pg-dump"),
  source: digest,
  point: z.string().uuid(),
  createdAt: z.string().datetime(),
  previousPoint: z.string().uuid().nullable(),
  dumpHash: digest,
  dumpBytes: z.number().int().positive().max(MAX_DATABASE_DUMP_BYTES),
  chunks: z.array(chunkSchema).min(1).max(MAX_DATABASE_CHUNKS),
  newChunks: z.number().int().nonnegative(),
  newBytes: z.number().int().nonnegative(),
}).strict();
const markerSchema = z.object({
  format: z.literal(DATABASE_PROTECTION_FORMAT), source: digest,
  manifest: z.string().regex(/^point-[0-9]{13}-[a-f0-9-]{36}\.enc$/),
  manifestHash: digest,
}).strict();
type LegacyDatabasePoint = z.infer<typeof manifestSchema>;
export type DatabasePoint = LegacyDatabasePoint | RecordDatabasePoint;
export interface DatabaseObjectStore {
  /** Completed encrypted payload bytes, excluding transport framing/retries. */
  readStats?(): { bytesRead:number; bytesWritten:number; recordBodyBytesRead:number };
  /** Fresh, uncached content identity. Only usable after authenticated byte proof. */
  getVersion?(name: string): Promise<ObjectVersion | null>;
  /** A fresh complete metadata pass; never a cached integrity/size listing. */
  getVersions?(names: string[]): Promise<ReadonlyMap<string, ObjectVersion | null>>;
  list(): Promise<DatabaseObjectMetadata[]>;
  get(name: string): Promise<Buffer | null>;
  /** Provider-calculated content digest, when available, without downloading the object. */
  getIntegrity?(name: string): Promise<{ bytes: number; sha1: string | null; sha256?: string | null } | null>;
  // Immutable uploads only. Never overwrites an existing recovery object.
  put(name: string, bytes: Buffer): Promise<void>;
  // Used only by the explicitly approved, dependency-aware retention sweep.
  delete(name: string): Promise<void>;
}
export interface DatabaseObjectMetadata {
  name: string;
  /** Missing/invalid provider timestamps are never eligible for deletion. */
  createdAt: string | null;
}
export type DatabaseDumpSource = Buffer | AsyncIterable<Uint8Array>;
export interface DatabaseCodec {
  encrypt(bytes: Buffer): Buffer;
  decrypt(bytes: Buffer): Buffer;
}
export interface VerifiedDatabasePoint {
  marker: string;
  manifest: DatabasePoint;
  recordSnapshot?: RecordPointInventory;
  manifestCipherHash?: string;
}
export class DatabaseProtectionError extends Error {}

function requireDumpHeader(header: Buffer, bytes: number): void {
  if (bytes < 5 || header.subarray(0, 5).toString("ascii") !== "PGDMP") {
    throw new DatabaseProtectionError("Database export is empty or is not a supported PostgreSQL custom-format dump.");
  }
}

// Content-defined boundaries avoid shifting every subsequent chunk after an
// insertion. Fixed deterministic gear table; minimum 256KiB, maximum 1MiB.
const gear = Array.from({ length: 256 }, (_, i) => {
  let x = (i + 1) * 2654435761;
  x ^= x >>> 16; x = Math.imul(x, 2246822519); x ^= x >>> 13;
  return x >>> 0;
});
async function* databaseChunksFrom(source: DatabaseDumpSource): AsyncGenerator<Buffer> {
  const input: AsyncIterable<Uint8Array> = Buffer.isBuffer(source)
    ? (async function* () { yield source; })()
    : source;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let rolling = 0;
  for await (const value of input) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      rolling = ((rolling << 1) + gear[bytes[i]!]!) >>> 0;
      const length = partBytes + i - start + 1;
      if (length >= MAX_DATABASE_CHUNK_BYTES ||
          (length >= 256 * 1024 && (rolling & 0x7ffff) === 0)) {
        parts.push(bytes.subarray(start, i + 1));
        partBytes += i - start + 1;
        yield Buffer.concat(parts, partBytes);
        parts = [];
        partBytes = 0;
        rolling = 0;
        start = i + 1;
      }
    }
    if (start < bytes.length) {
      const tail = bytes.subarray(start);
      parts.push(tail);
      partBytes += tail.length;
    }
  }
  if (partBytes > 0) yield Buffer.concat(parts, partBytes);
}

export function databaseChunks(dump: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0, rolling = 0;
  for (let i = 0; i < dump.length; i++) {
    rolling = ((rolling << 1) + gear[dump[i]!]!) >>> 0;
    const length = i - start + 1;
    if (length >= MAX_DATABASE_CHUNK_BYTES || (length >= 256 * 1024 && (rolling & 0x7ffff) === 0)) {
      chunks.push(dump.subarray(start, i + 1)); start = i + 1; rolling = 0;
    }
  }
  if (start < dump.length) chunks.push(dump.subarray(start));
  requireDumpHeader(dump.subarray(0, 5), dump.length);
  if (chunks.length > MAX_DATABASE_CHUNKS || dump.length > MAX_DATABASE_DUMP_BYTES) {
    throw new DatabaseProtectionError("Database export exceeds the recovery manifest capacity.");
  }
  return chunks;
}

async function readEncrypted(store: DatabaseObjectStore, codec: DatabaseCodec, name: string): Promise<Buffer> {
  const bytes = await store.get(name);
  if (!bytes || bytes.length > 8 * 1024 * 1024) {
    throw new DatabaseProtectionError("Required database recovery object is missing or oversized.");
  }
  try { return codec.decrypt(bytes); }
  catch { throw new DatabaseProtectionError("Database recovery object failed authentication/decryption."); }
}

export async function verifyDatabasePoint(
  store: DatabaseObjectStore, codec: DatabaseCodec, source: string, marker: string,
  onChunk?: (chunk: Buffer) => Promise<void>,
): Promise<VerifiedDatabasePoint> {
  if (marker.startsWith("records-verified-")) {
    if (onChunk) throw new DatabaseProtectionError("A record recovery point requires the record-aware restore path.");
    return verifyRecordDatabasePoint({store,codec,source}, marker);
  }
  if (!/^verified-[0-9]{13}-[a-f0-9-]{36}\.enc$/.test(marker)) {
    throw new DatabaseProtectionError("Invalid database recovery point identity.");
  }
  const committed = markerSchema.parse(JSON.parse((await readEncrypted(store, codec, marker)).toString("utf8")));
  if (committed.source !== source) throw new DatabaseProtectionError("Database recovery source identity does not match.");
  const encryptedManifest = await store.get(committed.manifest);
  if (!encryptedManifest || encryptedManifest.length > 8 * 1024 * 1024 ||
      hash(encryptedManifest) !== committed.manifestHash) {
    throw new DatabaseProtectionError("Database recovery manifest is missing or corrupt.");
  }
  const manifest = manifestSchema.parse(JSON.parse(codec.decrypt(encryptedManifest).toString("utf8")));
  if (manifest.source !== source ||
      `point-${Date.parse(manifest.createdAt)}-${manifest.point}.enc` !== committed.manifest ||
      marker !== committed.manifest.replace(/^point-/, "verified-")) {
    throw new DatabaseProtectionError("Database recovery point/source binding is invalid.");
  }
  const dumpHash = createHash("sha256");
  const header = Buffer.alloc(5);
  let headerBytes = 0;
  let total = 0;
  for (const chunk of manifest.chunks) {
    const plain = await readEncrypted(store, codec, `chunk-${chunk.hash}.enc`);
    if (plain.length !== chunk.bytes || hash(plain) !== chunk.hash) {
      throw new DatabaseProtectionError("Required database recovery chunk is corrupt.");
    }
    total += plain.length;
    if (total > manifest.dumpBytes) throw new DatabaseProtectionError("Database recovery size exceeds its manifest.");
    if (headerBytes < header.length) {
      const count = Math.min(header.length - headerBytes, plain.length);
      plain.copy(header, headerBytes, 0, count);
      headerBytes += count;
    }
    dumpHash.update(plain);
    await onChunk?.(plain);
  }
  requireDumpHeader(header, total);
  if (total !== manifest.dumpBytes || dumpHash.digest("hex") !== manifest.dumpHash) {
    throw new DatabaseProtectionError("Streamed database export failed integrity verification.");
  }
  return { marker, manifest };
}

export async function latestDatabasePoint(
  store: DatabaseObjectStore, codec: DatabaseCodec, source: string,
): Promise<VerifiedDatabasePoint | null> {
  const markers = (await store.list()).map(object => object.name)
    .filter(name => /^verified-[0-9]{13}-[a-f0-9-]{36}\.enc$/.test(name)).sort();
  const newest = markers.at(-1);
  // A broken newest chain must be reported, never silently reported as healthy
  // by falling back to an older point.
  return newest ? verifyDatabasePoint(store, codec, source, newest) : null;
}

export interface DatabaseRetentionPolicy {
  keepAllWithinHours: number;
  keepHourlyWithinDays: number;
  keepDailyWithinDays: number;
  safetyGraceHours: number;
}

export interface DatabaseRetentionSweepPlan {
  candidates: string[];
  retainedPoints: string[];
  retainedChunks: string[];
  protectedByGrace: number;
}

const databaseObjectName = /^(?:chunk-[a-f0-9]{64}|(?:point|verified)-[0-9]{13}-[a-f0-9-]{36})\.enc$/;
const verifiedMarkerName = /^verified-[0-9]{13}-[a-f0-9-]{36}\.enc$/;

function validateDatabaseRetentionPolicy(policy: DatabaseRetentionPolicy): void {
  if (!Number.isInteger(policy.keepAllWithinHours) || policy.keepAllWithinHours < 1 || policy.keepAllWithinHours > 24 * 90 ||
      !Number.isInteger(policy.keepHourlyWithinDays) || policy.keepHourlyWithinDays < 1 || policy.keepHourlyWithinDays > 365 ||
      !Number.isInteger(policy.keepDailyWithinDays) || policy.keepDailyWithinDays < 1 || policy.keepDailyWithinDays > 3650 ||
      !Number.isInteger(policy.safetyGraceHours) || policy.safetyGraceHours < DATABASE_PROTECTION_RETENTION_GRACE_HOURS ||
      policy.safetyGraceHours > 24 * 30) {
    throw new DatabaseProtectionError("Database retention policy is outside its safe bounds.");
  }
}

/**
 * Mark verified recovery points and their direct chunk dependencies before
 * producing a deletion plan. Any malformed/corrupt verified metadata aborts
 * the entire sweep; unverified objects are only eligible after the grace
 * period, which also protects interrupted uploads.
 */
export async function planDatabaseRetentionSweep(options: {
  store: DatabaseObjectStore;
  codec: DatabaseCodec;
  source: string;
  policy: DatabaseRetentionPolicy;
  now?: Date;
}): Promise<DatabaseRetentionSweepPlan> {
  const { store, codec, source, policy } = options;
  validateDatabaseRetentionPolicy(policy);
  digest.parse(source);
  const nowMs = (options.now ?? new Date()).getTime();
  const objects = await store.list();
  const byName = new Map<string, DatabaseObjectMetadata>();
  for (const object of objects) {
    if (!databaseObjectName.test(object.name) || byName.has(object.name)) {
      throw new DatabaseProtectionError("Database object listing contains an invalid or duplicate identity.");
    }
    byName.set(object.name, object);
  }

  const points: Array<{ marker: string; createdAt: number; point: DatabasePoint }> = [];
  for (const marker of [...byName.keys()].filter(name => verifiedMarkerName.test(name)).sort()) {
    const committed = markerSchema.parse(JSON.parse((await readEncrypted(store, codec, marker)).toString("utf8")));
    if (committed.source !== source || marker !== committed.manifest.replace(/^point-/, "verified-")) {
      throw new DatabaseProtectionError("Database retention found a verified marker with invalid source binding.");
    }
    const encryptedManifest = await store.get(committed.manifest);
    if (!encryptedManifest || encryptedManifest.length > 8 * 1024 * 1024 ||
        hash(encryptedManifest) !== committed.manifestHash) {
      throw new DatabaseProtectionError("Database retention found a missing or corrupt verified manifest.");
    }
    const point = manifestSchema.parse(JSON.parse(codec.decrypt(encryptedManifest).toString("utf8")));
    const createdAt = Date.parse(point.createdAt);
    if (point.source !== source || marker !== `verified-${createdAt}-${point.point}.enc` ||
        committed.manifest !== `point-${createdAt}-${point.point}.enc` ||
        !Number.isFinite(createdAt) || !byName.has(committed.manifest)) {
      throw new DatabaseProtectionError("Database retention found a verified point with invalid identity.");
    }
    points.push({ marker, createdAt, point });
  }
  points.sort((a, b) => b.createdAt - a.createdAt || a.marker.localeCompare(b.marker));
  // Without a verified baseline there is no recovery point to preserve. Keep
  // every object until the first complete point has been committed.
  if (!points.length) {
    return { candidates: [], retainedPoints: [], retainedChunks: [], protectedByGrace: objects.length };
  }

  const keep = new Set(points.slice(0, DATABASE_PROTECTION_RETENTION_POLICY.minimumNewestPoints).map(entry => entry.marker));
  const keepAllCutoff = nowMs - policy.keepAllWithinHours * 60 * 60_000;
  const hourlyCutoff = nowMs - policy.keepHourlyWithinDays * 24 * 60 * 60_000;
  const dailyCutoff = nowMs - policy.keepDailyWithinDays * 24 * 60 * 60_000;
  const seenHours = new Set<string>();
  const seenDays = new Set<string>();
  for (const entry of points) {
    if (entry.createdAt >= keepAllCutoff) {
      keep.add(entry.marker);
    } else if (entry.createdAt >= hourlyCutoff) {
      const hour = new Date(entry.createdAt).toISOString().slice(0, 13);
      if (!seenHours.has(hour)) { keep.add(entry.marker); seenHours.add(hour); }
    } else if (entry.createdAt >= dailyCutoff) {
      const day = new Date(entry.createdAt).toISOString().slice(0, 10);
      if (!seenDays.has(day)) { keep.add(entry.marker); seenDays.add(day); }
    }
  }

  const retainedPoints = points.filter(entry => keep.has(entry.marker));
  const marked = new Set<string>();
  const retainedChunks = new Set<string>();
  for (const { marker, point } of retainedPoints) {
    marked.add(marker);
    const manifestName = marker.replace(/^verified-/, "point-");
    marked.add(manifestName);
    for (const chunk of point.chunks) {
      const name = `chunk-${chunk.hash}.enc`;
      if (!byName.has(name)) throw new DatabaseProtectionError("A retained database point is missing a required chunk.");
      retainedChunks.add(name);
      marked.add(name);
    }
  }

  const graceCutoff = nowMs - policy.safetyGraceHours * 60 * 60_000;
  let protectedByGrace = 0;
  const candidates: Array<{ name: string; createdAt: number }> = [];
  for (const object of objects) {
    const createdAt = object.createdAt ? Date.parse(object.createdAt) : NaN;
    if (marked.has(object.name)) continue;
    if (!Number.isFinite(createdAt) || createdAt > graceCutoff) {
      protectedByGrace++;
      continue;
    }
    candidates.push({ name: object.name, createdAt });
  }
  const deletionRank = (name: string) => name.startsWith("verified-") ? 0 : name.startsWith("point-") ? 1 : 2;
  candidates.sort((a, b) => deletionRank(a.name) - deletionRank(b.name) ||
    a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  return {
    candidates: candidates.map(candidate => candidate.name),
    retainedPoints: retainedPoints.map(entry => entry.marker),
    retainedChunks: [...retainedChunks].sort(),
    protectedByGrace,
  };
}

async function immutableWrite(store: DatabaseObjectStore, name: string, bytes: Buffer): Promise<void> {
  if (await store.get(name)) throw new DatabaseProtectionError("Database recovery object already exists; nothing was overwritten.");
  await store.put(name, bytes);
  const received = await store.get(name);
  if (!received || hash(received) !== hash(bytes)) {
    throw new DatabaseProtectionError("OneDrive database object read-back integrity verification failed.");
  }
}

export async function protectDatabase(options: {
  store: DatabaseObjectStore; codec: DatabaseCodec; source: string;
  capture: () => Promise<DatabaseDumpSource> | DatabaseDumpSource; now?: Date;
  onPhase?: (phase: string) => Promise<void>;
}): Promise<VerifiedDatabasePoint> {
  const { store, codec, source } = options;
  digest.parse(source);
  await options.onPhase?.("Verifying previous OneDrive database dependencies");
  const previous = await latestDatabasePoint(store, codec, source);
  // All referenced previous bytes were authenticated above, not just listed.
  await options.onPhase?.("Exporting a consistent production database snapshot");
  const createdAt = new Date(Math.max(
    (options.now ?? new Date()).getTime(),
    previous ? Date.parse(previous.manifest.createdAt) + 1 : 0,
  )).toISOString();
  const dump = await options.capture();
  const dumpHash = createHash("sha256");
  const firstBytes = Buffer.alloc(5);
  let firstByteCount = 0;
  let dumpBytes = 0;
  let newChunks = 0, newBytes = 0;
  const chunks: LegacyDatabasePoint["chunks"] = [];
  const seen = new Set<string>();
  await options.onPhase?.("Uploading new encrypted chunks and verifying reused data");
  for await (const piece of databaseChunksFrom(dump)) {
    if (dumpBytes + piece.length > MAX_DATABASE_DUMP_BYTES || chunks.length >= MAX_DATABASE_CHUNKS) {
      throw new DatabaseProtectionError("Database export exceeds the recovery manifest capacity.");
    }
    if (firstByteCount < firstBytes.length) {
      const count = Math.min(firstBytes.length - firstByteCount, piece.length);
      piece.copy(firstBytes, firstByteCount, 0, count);
      firstByteCount += count;
    }
    dumpBytes += piece.length;
    dumpHash.update(piece);
    if (chunks.length === 0) requireDumpHeader(firstBytes, dumpBytes);
    const sha = hash(piece);
    const name = `chunk-${sha}.enc`;
    if (!seen.has(sha)) {
      const existing = await store.get(name);
      if (existing) {
        let plain: Buffer;
        try { plain = codec.decrypt(existing); }
        catch { throw new DatabaseProtectionError("Existing database recovery chunk failed authentication."); }
        if (hash(plain) !== sha || plain.length !== piece.length) {
          throw new DatabaseProtectionError("Existing database recovery chunk is corrupt; nothing was overwritten.");
        }
      } else {
        const encrypted = codec.encrypt(piece);
        await immutableWrite(store, name, encrypted);
        newChunks++; newBytes += encrypted.length;
      }
      seen.add(sha);
    }
    chunks.push({ hash: sha, bytes: piece.length });
  }
  requireDumpHeader(firstBytes, dumpBytes);
  const point = randomUUID();
  const manifest: DatabasePoint = {
    format: DATABASE_PROTECTION_FORMAT, protection: "database-only",
    capture: "fresh-consistent-pg-dump", source, point, createdAt,
    previousPoint: previous?.manifest.point ?? null,
    dumpHash: dumpHash.digest("hex"), dumpBytes, chunks, newChunks, newBytes,
  };
  const name = `point-${Date.parse(createdAt)}-${point}.enc`;
  const encrypted = codec.encrypt(Buffer.from(JSON.stringify(manifest)));
  await options.onPhase?.("Writing and verifying the database recovery manifest");
  await immutableWrite(store, name, encrypted);
  const marker = name.replace(/^point-/, "verified-");
  // The commit marker is last. A crash leaves reusable orphan chunks but cannot
  // advance the last verified point. Previous points and all dependencies stay.
  await immutableWrite(store, marker, codec.encrypt(Buffer.from(JSON.stringify({
    format: DATABASE_PROTECTION_FORMAT, source, manifest: name, manifestHash: hash(encrypted),
  }))));
  await options.onPhase?.("Reading back and verifying every database recovery chunk");
  return verifyDatabasePoint(store, codec, source, marker);
}
