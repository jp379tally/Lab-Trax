import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";
import { objectVersionSchema, sameObjectVersion, type ObjectVersion } from "./object-version-proof";
import type { RecordInventory } from "./postgres-record-delta";
import { isRecordDatabaseCapture, latestRecordDatabasePoint, protectRecordDatabase, POSTGRES_RECORD_POINT_FORMAT,
  type RecordDatabaseCapture, type VerifiedRecordDatabasePoint } from "./postgres-record-protection";
import {
  protectDatabase, verifyDatabasePoint, DatabaseProtectionError, type DatabaseCodec, type DatabaseObjectStore,
  type DatabaseDumpSource,
} from "./database-protection";

// A separate namespace/format: a database-only point is NEVER a media baseline.
export const PRODUCTION_CONTENT_FORMAT = "labtrax-production-content-v1";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha1Digest = z.string().regex(/^[a-f0-9]{40}$/);
const chunk = z.object({
  hash: digest,
  bytes: z.number().int().min(1).max(1024 * 1024),
  // SHA-1 remains readable only for legacy archives. Body-free reuse requires
  // initial strong byte proof plus exact provider-version continuity, or a
  // fresh strong provider-calculated digest.
  remoteSha1: sha1Digest.optional(),
  remoteSha256: digest.optional(),
  // Authenticated inventory binds initially verified ciphertext SHA-256 to
  // this exact independent provider object/content version. No historical
  // version-retention policy is relied upon: objects are never overwritten.
  remoteVersion: objectVersionSchema.optional(),
  remoteBytes: z.number().int().positive().optional(),
}).strict();
const safePath = z.string().min(1).max(4096).refine(p =>
  !p.includes("\\") && !p.includes("\0") && !p.startsWith("/") &&
  p.split("/").every(part => part !== "" && part !== "." && part !== ".."));
const file = z.object({
  path: safePath, bytes: z.number().int().nonnegative(), hash: digest,
  chunks: z.array(chunk).max(1_000_000),
  // Optional only for migration from older points. Such entries are never
  // eligible for metadata-only reuse and are reread to establish a baseline.
  sourceVersion: z.string().min(1).max(512).nullable().optional(),
}).strict();
const inventory = z.object({
  files: z.array(file).max(250_000),
  missingReferences: z.array(safePath).max(250_000),
  coverageLimitations: z.array(z.string().min(1).max(1024)).max(32).default([]),
  // Private snapshot/row/reference evidence is inside authenticated encryption.
  evidence: z.record(z.string(), z.unknown()),
}).strict();
const rootSchema = z.object({
  format: z.literal(PRODUCTION_CONTENT_FORMAT), source: digest,
  point: z.string().uuid(), createdAt: z.string().datetime(),
  previousPoint: z.string().uuid().nullable(), databaseMarker: z.string(),
  coverage: z.enum(["complete", "partial"]), inventory: z.array(chunk).min(1).max(64),
  inventoryHash: digest, inventoryBytes: z.number().int().positive().max(64 * 1024 * 1024),
  newBytes: z.number().int().nonnegative(), newChunks: z.number().int().nonnegative(),
  reusedChunks: z.number().int().nonnegative(),
}).strict();
const markerSchema = z.object({ format: z.literal(PRODUCTION_CONTENT_FORMAT), source: digest,
  root: z.string().regex(/^point-\d{13}-[a-f0-9-]{36}\.enc$/), hash: digest }).strict();
export type ProductionFile = z.infer<typeof file>;
export type ProductionInventory = z.infer<typeof inventory>;
export interface ProductionStores { store: DatabaseObjectStore; databaseStore: DatabaseObjectStore }
export interface ProductionStores { store: DatabaseObjectStore; databaseStore: DatabaseObjectStore }
export interface ProductionStores { store: DatabaseObjectStore; databaseStore: DatabaseObjectStore }
export interface ProductionOptions extends ProductionStores {
  codec: DatabaseCodec; source: string;
}
export interface ProductionMediaSourceVersion {
  archivePath: string;
  size: number;
  sourceVersion: string | null;
}
const journalCheckpoint = z.object({
  afterPosition: z.string().regex(/^\d+$/),
  throughPosition: z.string().regex(/^\d+$/),
  events: z.array(z.object({
    position: z.string().regex(/^\d+$/),
    operation: z.enum(["add", "remove", "replace"]),
    objectKey: safePath,
    sourceTable: z.string().min(1).max(256),
    sourceGeneration: z.string().min(1).max(1024).optional(),
  }).strict()),
}).strict();
export type MediaJournalCheckpoint = z.infer<typeof journalCheckpoint>;
export function journalMatchesPath(path: string, key: string): boolean {
  const normalized = path.replace(/^media\//, "case-media/").replace(/^(private-objects|local-uploads)\//, "");
  key = key.replace(/^(private-objects|local-uploads)\//, "");
  return key.endsWith(".*")
    ? normalized.startsWith(key.slice(0, -1))
    : normalized === key;
}
export function mediaReceiptMatches(sourceVersion: string, sourceGeneration: string | undefined): boolean {
  return !!sourceGeneration && sourceVersion ===
    `${sourceVersion.startsWith("generation:") ? "generation" : "local"}:${sourceGeneration}`;
}
export interface ProductionCapture {
  capture: (previousJournalPosition: string | null, previousRecords?: RecordInventory | null) =>
    Promise<DatabaseDumpSource | RecordDatabaseCapture> | DatabaseDumpSource | RecordDatabaseCapture;
  captureMedia: (
    write: (path: string, stream: Readable, sourceVersion: string | null) => Promise<ProductionFile>,
    selectPaths: (sources: ProductionMediaSourceVersion[], journal?: MediaJournalCheckpoint) => ReadonlySet<string>,
  ) => Promise<{
    sourceVersions: ProductionMediaSourceVersion[];
    missingReferences: string[];
    coverageLimitations?: string[];
    evidence: Record<string, unknown>;
  }>;
  onPhase?: (stage: string) => Promise<void>;
  onMediaProgress?: (progress: { mediaFiles: number; mediaBytes: number; newBytes: number; reusedChunks: number; newChunks: number }) => Promise<void>;
}
async function plain(store: DatabaseObjectStore, codec: DatabaseCodec, name: string) {
  const encrypted = await store.get(name);
  if (!encrypted || encrypted.length > 8 * 1024 * 1024) throw new DatabaseProtectionError("Required production recovery object is missing or oversized.");
  try { return codec.decrypt(encrypted); }
  catch { throw new DatabaseProtectionError("Production recovery object failed authentication."); }
}
const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");
async function immutable(store: DatabaseObjectStore, name: string, bytes: Buffer) {
  const existing = store.getIntegrity ? await store.getIntegrity(name) : await store.get(name);
  if (existing) throw new DatabaseProtectionError("Production recovery object collision; existing bytes preserved.");
  await store.put(name, bytes);
  const before = store.getVersion ? await store.getVersion(name) : null;
  const received = await store.get(name);
  const after = store.getVersion ? await store.getVersion(name) : null;
  if ((store.getVersion && (!before || !sameObjectVersion(before, after))) ||
      !received || hash(received) !== hash(bytes)) {
    throw new DatabaseProtectionError("Production recovery upload byte read-back or content-version continuity failed.");
  }
  if (store.getIntegrity) {
    const metadata = await store.getIntegrity(name);
    if (!metadata || metadata.bytes !== received.length ||
        (metadata.sha256 && metadata.sha256 !== hash(received))) {
      throw new DatabaseProtectionError("Production recovery provider integrity read-back failed.");
    }
  }
  return { bytes: received, ...(after ? { remoteVersion: after } : {}) };
}
async function readChunkWithProviderHash(options: ProductionOptions, c: z.infer<typeof chunk>) {
  const name = `chunk-${c.hash}.enc`;
  const before = options.store.getVersion ? await options.store.getVersion(name) : null;
  const encrypted = await options.store.get(name);
  const after = options.store.getVersion ? await options.store.getVersion(name) : null;
  if (!encrypted || encrypted.length > 8 * 1024 * 1024) {
    throw new DatabaseProtectionError("Required production recovery object is missing or oversized.");
  }
  if (options.store.getVersion && (!before || !sameObjectVersion(before, after) ||
      (c.remoteVersion && !sameObjectVersion(c.remoteVersion, before)))) {
    throw new DatabaseProtectionError("Production content-version continuity changed during authenticated byte verification.");
  }
  let bytes: Buffer;
  try { bytes = options.codec.decrypt(encrypted); }
  catch { throw new DatabaseProtectionError("Production recovery object failed authentication."); }
  if (c.remoteSha256 && hash(encrypted) !== c.remoteSha256) {
    throw new DatabaseProtectionError("Production ciphertext differs from its authenticated SHA-256 receipt.");
  }
  if (bytes.length !== c.bytes || hash(bytes) !== c.hash) throw new DatabaseProtectionError("Required production content chunk is corrupt.");
  return { bytes, remoteSha1: sha1(encrypted), remoteSha256: hash(encrypted), remoteBytes: encrypted.length,
    ...(after ? { remoteVersion: after } : {}) };
}
async function readChunk(options: ProductionOptions, c: z.infer<typeof chunk>) {
  return (await readChunkWithProviderHash(options, c)).bytes;
}
async function verifyStoredChunk(options: ProductionOptions, c: z.infer<typeof chunk>, versions?:ReadonlyMap<string,ObjectVersion|null>) {
  if (c.remoteVersion && c.remoteSha256 && c.remoteBytes && options.store.getVersion) {
    const name=`chunk-${c.hash}.enc`;
    const current = versions?.has(name) ? versions.get(name)??null : await options.store.getVersion(name);
    if (!sameObjectVersion(c.remoteVersion, current) || current?.bytes !== c.remoteBytes) {
      throw new DatabaseProtectionError("Previously byte-verified production object content-version continuity failed; prior point preserved.");
    }
    return;
  }
  if (c.remoteSha256 && c.remoteBytes && options.store.getIntegrity) {
    const metadata = await options.store.getIntegrity(`chunk-${c.hash}.enc`);
    if (!metadata?.sha256) {
      throw new DatabaseProtectionError(
        "Strong metadata-only media reuse is unavailable: the destination does not provide a provider-calculated SHA-256. SHA-1, QuickXorHash, size and entity tags are not sufficient; the previous recovery point was preserved.",
      );
    }
    if (metadata.bytes !== c.remoteBytes || metadata.sha256 !== c.remoteSha256) {
      throw new DatabaseProtectionError(
        "Previously verified production content failed provider-calculated remote integrity.",
      );
    }
    return;
  }
  // Migration for older points, and a safe fallback for stores without
  // provider hashes. This is a one-time full read when creating a new baseline.
  await readChunkWithProviderHash(options, c);
}
async function readInventory(options: ProductionOptions, root: z.infer<typeof rootSchema>) {
  if (root.source !== options.source) throw new DatabaseProtectionError("Production recovery source identity differs.");
  const parts: Buffer[] = [];
  let size = 0;
  for (const c of root.inventory) {
    size += c.bytes;
    if (size > root.inventoryBytes) throw new DatabaseProtectionError("Production inventory exceeds its recorded bound.");
    parts.push(await readChunk(options, c));
  }
  const bytes = Buffer.concat(parts);
  if (size !== root.inventoryBytes || hash(bytes) !== root.inventoryHash) throw new DatabaseProtectionError("Production inventory integrity failed.");
  const entries = inventory.parse(JSON.parse(bytes.toString("utf8")));
  const journal = entries.evidence.productionMediaJournal;
  if (journal !== undefined) {
    const parsed = journalCheckpoint.parse(journal);
    const start = BigInt(parsed.afterPosition), end = BigInt(parsed.throughPosition);
    if (end < start || BigInt(parsed.events.length) !== end - start ||
        parsed.events.some((e, i) => BigInt(e.position) !== start + BigInt(i + 1))) {
      throw new DatabaseProtectionError("Production recovery journal checkpoint is inconsistent or out of order.");
    }
  }
  return entries;
}
async function verifyRoot(options: ProductionOptions, root: z.infer<typeof rootSchema>, requireMetadataReuse = false) {
  const entries = await readInventory(options, root);
  const versionNames=[...new Set(entries.files.flatMap(file=>file.chunks.filter(c=>c.remoteVersion).map(c=>`chunk-${c.hash}.enc`)))];
  const versions=options.store.getVersions&&versionNames.length
    ? await options.store.getVersions(versionNames) : undefined;
  const paths = new Set<string>();
  for (const entry of entries.files) {
    if (paths.has(entry.path)) throw new DatabaseProtectionError("Duplicate production recovery path.");
    paths.add(entry.path);
    const h = createHash("sha256"); let total = 0;
    const canVerifyMetadataOnly = entry.chunks.every(c => Boolean(c.remoteSha256 && c.remoteBytes &&
      ((c.remoteVersion && options.store.getVersion) || options.store.getIntegrity)));
    // Older authenticated points have no version-bound receipt. Establish it
    // by actual authenticated remote byte read-back once, then persist it in
    // the next retained point. Never manufacture it from metadata alone.
    const needsVersionBinding = Boolean(options.store.getVersion) &&
      entry.chunks.some(c => !c.remoteVersion);
    const metadataOnly = canVerifyMetadataOnly && requireMetadataReuse && !needsVersionBinding;
    if (requireMetadataReuse && !canVerifyMetadataOnly && !needsVersionBinding) {
      throw new DatabaseProtectionError(
        "The previous media baseline has no compatible strong metadata-only integrity proof. No whole-media reread or new recovery point was started.",
      );
    }
    const verifiedChunks: z.infer<typeof chunk>[] = [];
    for (const c of entry.chunks) {
      if (metadataOnly) {
        await verifyStoredChunk(options, c,versions);
        verifiedChunks.push(c);
        total += c.bytes;
      } else {
        const verified = await readChunkWithProviderHash(options, c);
        h.update(verified.bytes);
        total += verified.bytes.length;
        verifiedChunks.push({
          ...c, remoteSha1: verified.remoteSha1, remoteSha256: verified.remoteSha256, remoteBytes: verified.remoteBytes,
          ...(verified.remoteVersion ? { remoteVersion: verified.remoteVersion } : {}),
        });
      }
    }
    if (total !== entry.bytes || (!metadataOnly && h.digest("hex") !== entry.hash)) {
      throw new DatabaseProtectionError("Production recovery file integrity failed.");
    }
    entry.chunks = verifiedChunks;
  }
  if ((entries.missingReferences.length || entries.coverageLimitations.length ? "partial" : "complete") !== root.coverage) {
    throw new DatabaseProtectionError("Production coverage disagrees with its omission inventory.");
  }
  const database = await verifyDatabasePoint(options.databaseStore, options.codec, options.source, root.databaseMarker);
  if (entries.evidence.databaseSha256 !== database.manifest.dumpHash) {
    throw new DatabaseProtectionError("Production media inventory and database snapshot do not agree.");
  }
  if(database.recordSnapshot){
    const snapshotAt=entries.evidence.snapshotAt;
    if(typeof snapshotAt!=="string"||!Number.isFinite(Date.parse(snapshotAt))||
      Date.parse(snapshotAt)>Date.parse(root.createdAt))
      throw new DatabaseProtectionError("Production record snapshot timestamp is missing or inconsistent.");
  }
  return { root, inventory: entries, database };
}
async function loadPointRoot(options: ProductionOptions, marker: string) {
  if (!/^verified-\d{13}-[a-f0-9-]{36}\.enc$/.test(marker)) throw new DatabaseProtectionError("Invalid production recovery marker.");
  const m = markerSchema.parse(JSON.parse((await plain(options.store, options.codec, marker)).toString("utf8")));
  if (m.source !== options.source || m.root.replace(/^point-/, "verified-") !== marker) throw new DatabaseProtectionError("Production marker/source binding differs.");
  const encrypted = await options.store.get(m.root);
  if (!encrypted || encrypted.length > 8 * 1024 * 1024 || hash(encrypted) !== m.hash) throw new DatabaseProtectionError("Production point manifest is missing or corrupt.");
  const root = rootSchema.parse(JSON.parse(options.codec.decrypt(encrypted).toString("utf8")));
  if (`point-${Date.parse(root.createdAt)}-${root.point}.enc` !== m.root) throw new DatabaseProtectionError("Production point identity differs.");
  if (root.source !== options.source) throw new DatabaseProtectionError("Production ancestor source identity differs.");
  return root;
}
export async function verifyProductionPoint(options: ProductionOptions, marker: string, requireMetadataReuse = false) {
  const root = await loadPointRoot(options, marker);
  const byPoint = new Map<string, string>();
  for (const { name } of await options.store.list()) {
    const match = /^verified-\d{13}-([a-f0-9-]{36})\.enc$/.exec(name);
    if (!match) continue;
    if (byPoint.has(match[1]!)) throw new DatabaseProtectionError("Duplicate production ancestor identity.");
    byPoint.set(match[1]!, name);
  }
  const visited = new Set<string>();
  let child = root;
  let childInventory = await readInventory(options, root);
  while (child.previousPoint !== null) {
    if (visited.has(child.point) || visited.size >= 100_000) {
      throw new DatabaseProtectionError("Cyclic or oversized production recovery ancestry.");
    }
    visited.add(child.point);
    if (visited.has(child.previousPoint)) throw new DatabaseProtectionError("Cyclic production recovery ancestry.");
    const parentMarker = byPoint.get(child.previousPoint);
    if (!parentMarker) throw new DatabaseProtectionError("Required production recovery ancestor is missing.");
    const parent = await loadPointRoot(options, parentMarker);
    if (parent.point !== child.previousPoint || Date.parse(parent.createdAt) > Date.parse(child.createdAt)) {
      throw new DatabaseProtectionError("Production recovery ancestor identity or ordering is inconsistent.");
    }
    const parentInventory = await readInventory(options, parent);
    const childJournal = childInventory.evidence.productionMediaJournal;
    const parentJournal = parentInventory.evidence.productionMediaJournal;
    if (parentJournal !== undefined && (childJournal === undefined ||
        journalCheckpoint.parse(childJournal).afterPosition !== journalCheckpoint.parse(parentJournal).throughPosition)) {
      throw new DatabaseProtectionError("Production recovery ancestor journal checkpoints do not agree.");
    }
    child = parent;
    childInventory = parentInventory;
  }
  return { marker, ...await verifyRoot(options, root, requireMetadataReuse) };
}
export async function latestProductionPoint(options: ProductionOptions, requireMetadataReuse = false) {
  const markers = (await options.store.list()).map(object => object.name)
    .filter(n => /^verified-\d{13}-[a-f0-9-]{36}\.enc$/.test(n)).sort();
  return markers.length ? verifyProductionPoint(options, markers.at(-1)!, requireMetadataReuse) : null;
}
export async function protectProduction(options: ProductionOptions & ProductionCapture) {
  digest.parse(options.source);
  await options.onPhase?.("Verifying prior production database and media dependencies");
  const previous = await latestProductionPoint(options, true); // Broken or weakly evidenced newest point fails closed.
  // A failed initial media capture may already have committed its record point.
  // Authenticate that record-only seed before selecting changed rows. It is not
  // a media baseline: the first media inventory/journal still starts from null.
  const previousRecords = previous
    ? previous.database.manifest.format === POSTGRES_RECORD_POINT_FORMAT
      ? previous.database as VerifiedRecordDatabasePoint : null
    : await latestRecordDatabasePoint({ ...options, store: options.databaseStore });
  const previousJournalPosition =
    typeof previous?.inventory.evidence.productionMediaJournal === "object" &&
    previous.inventory.evidence.productionMediaJournal !== null &&
    typeof (previous.inventory.evidence.productionMediaJournal as Record<string, unknown>).throughPosition === "string"
      ? (previous.inventory.evidence.productionMediaJournal as Record<string, string>).throughPosition!
      : null;
  await options.onPhase?.("Capturing a consistent snapshot and changed production records");
  const capturedDatabase = await options.capture(previousJournalPosition, previousRecords?.recordSnapshot.records ?? null);
  if(isRecordDatabaseCapture(capturedDatabase))await options.onPhase?.("Storing changed records and verifying retained record dependencies");
  const database = isRecordDatabaseCapture(capturedDatabase)
    ? await protectRecordDatabase({ ...options, store: options.databaseStore, capture: capturedDatabase,
      previous: previousRecords })
    : await protectDatabase({ ...options, store: options.databaseStore, capture: () => capturedDatabase });
  let newBytes = 0, newChunks = 0, reusedChunks = 0;
  const changedFiles: ProductionFile[] = [];
  let completedMediaBytes = 0;
  let selectedSourcePaths = new Set<string>();
  let unchangedFiles = new Map<string, ProductionFile>();
  let plannedSourceVersions: ProductionMediaSourceVersion[] = [];
  let sourceSelectionMade = false;
  let selectedJournal: MediaJournalCheckpoint | undefined;
  const knownChunkProofs = new Map<string, z.infer<typeof chunk>>();
  for (const priorChunk of [
    ...(previous?.root.inventory ?? []),
    ...(previous?.inventory.files.flatMap(entry => entry.chunks) ?? []),
  ]) {
    const existing = knownChunkProofs.get(priorChunk.hash);
    if (existing && (existing.bytes !== priorChunk.bytes ||
        (existing.remoteSha256 && priorChunk.remoteSha256 && existing.remoteSha256 !== priorChunk.remoteSha256) ||
        (existing.remoteBytes && priorChunk.remoteBytes && existing.remoteBytes !== priorChunk.remoteBytes) ||
        (existing.remoteVersion && priorChunk.remoteVersion && !sameObjectVersion(existing.remoteVersion, priorChunk.remoteVersion)))) {
      throw new DatabaseProtectionError("A prior production point contains inconsistent immutable chunk proofs.");
    }
    knownChunkProofs.set(priorChunk.hash, existing?.remoteVersion && !priorChunk.remoteVersion ? existing : priorChunk);
  }
  // Concurrent media streams can contain the same new content. Share its one
  // immutable upload/read-back instead of racing two encrypted object writes.
  const chunkWrites = new Map<string, Promise<z.infer<typeof chunk>>>();
  async function putChunk(bytes: Buffer): Promise<z.infer<typeof chunk>> {
    const sha = hash(bytes);
    const pending = chunkWrites.get(sha);
    if (pending) { reusedChunks++; return pending; }
    const operation = putChunkOnce(bytes, sha);
    chunkWrites.set(sha, operation);
    return operation;
  }
  async function putChunkOnce(bytes: Buffer, sha: string): Promise<z.infer<typeof chunk>> {
    const c = { hash: sha, bytes: bytes.length };
    const name = `chunk-${c.hash}.enc`;
    const trusted = knownChunkProofs.get(c.hash);
    if (trusted?.remoteSha256 && trusted.remoteBytes &&
        ((trusted.remoteVersion && options.store.getVersion) ||
          (!options.store.getVersion && options.store.getIntegrity))) {
      await verifyStoredChunk(options, trusted);
      reusedChunks++;
      return { ...c, remoteSha256: trusted.remoteSha256, remoteBytes: trusted.remoteBytes,
        ...(trusted.remoteVersion ? { remoteVersion: trusted.remoteVersion } : {}) };
    }
    const existing = options.store.getIntegrity
      ? await options.store.getIntegrity(name)
      : await options.store.get(name);
    if (existing) {
      const verified = await readChunkWithProviderHash(options, trusted ?? c);
      reusedChunks++;
      return { ...c, remoteSha256: verified.remoteSha256, remoteBytes: verified.remoteBytes,
        ...(verified.remoteVersion ? { remoteVersion: verified.remoteVersion } : {}) };
    }
    const encrypted = options.codec.encrypt(bytes);
    const received = await immutable(options.store, name, encrypted);
    let decoded: Buffer;
    try { decoded = options.codec.decrypt(received.bytes); }
    catch { throw new DatabaseProtectionError("New production object byte read-back failed authentication."); }
    if (decoded.length !== c.bytes || hash(decoded) !== c.hash) {
      throw new DatabaseProtectionError("New production object byte read-back differs from its source.");
    }
    newBytes += encrypted.length; newChunks++;
    return { ...c, remoteSha256: hash(received.bytes), remoteBytes: received.bytes.length,
      ...(received.remoteVersion ? { remoteVersion: received.remoteVersion } : {}) };
  }
  await options.onPhase?.("Capturing production media; reusing authenticated content and uploading changed chunks");
  const untrackedChanges = new Set<string>();
  const capture = await options.captureMedia(async (path, stream, sourceVersion) => {
    safePath.parse(path);
    const chunks: z.infer<typeof chunk>[] = [];
    const h = createHash("sha256"); let bytes = 0;
    // Rechunk arbitrary stream buffers into bounded 1MiB objects; never spool an archive.
    let pending = Buffer.alloc(0);
    for await (const raw of stream) {
      const incoming = Buffer.from(raw); h.update(incoming); bytes += incoming.length;
      let offset = 0;
      while (offset < incoming.length) {
        const take = Math.min(1024 * 1024 - pending.length, incoming.length - offset);
        pending = Buffer.concat([pending, incoming.subarray(offset, offset + take)]); offset += take;
        if (pending.length === 1024 * 1024) { chunks.push(await putChunk(pending)); pending = Buffer.alloc(0); }
      }
    }
    if (pending.length) chunks.push(await putChunk(pending));
    const entry = file.parse({ path, bytes, hash: h.digest("hex"), chunks, sourceVersion });
    changedFiles.push(entry);
    completedMediaBytes += bytes;
    await options.onMediaProgress?.({
      mediaFiles: changedFiles.length, mediaBytes: completedMediaBytes,
      newBytes, reusedChunks, newChunks,
    });
    return entry;
  }, (sources, journal) => {
    if (sourceSelectionMade) {
      throw new DatabaseProtectionError("Production media source inventory was supplied more than once.");
    }
    sourceSelectionMade = true;
    if (previousJournalPosition !== null && !journal) {
      throw new DatabaseProtectionError("The prior journal checkpoint has no current continuation.");
    }
    if (journal) {
      selectedJournal = journalCheckpoint.parse(journal);
      const start = BigInt(selectedJournal.afterPosition);
      const end = BigInt(selectedJournal.throughPosition);
      if (selectedJournal.afterPosition !== (previousJournalPosition ?? selectedJournal.throughPosition) ||
          end < start || BigInt(selectedJournal.events.length) !== end - start ||
          selectedJournal.events.some((event, index) => BigInt(event.position) !== start + BigInt(index) + 1n)) {
        throw new DatabaseProtectionError("Production media journal checkpoint is inconsistent or contains a gap.");
      }
    }
    const previousFiles = new Map((previous?.inventory.files ?? []).map(entry => [entry.path, entry]));
    const seen = new Set<string>();
    plannedSourceVersions = sources.map(source => {
      safePath.parse(source.archivePath);
      if (!Number.isSafeInteger(source.size) || source.size < 0 || seen.has(source.archivePath)) {
        throw new DatabaseProtectionError("Production media source inventory is invalid or contains duplicate paths.");
      }
      seen.add(source.archivePath);
      if (!source.sourceVersion) {
        throw new DatabaseProtectionError(
          "A production media source has no stable version identity; change-only protection cannot be certified.",
        );
      }
      const prior = previousFiles.get(source.archivePath);
      const journalRequiresCapture = selectedJournal?.events.some(event =>
        (event.operation === "add" || event.operation === "replace") && journalMatchesPath(source.archivePath, event.objectKey));
      const receipt = selectedJournal?.events.filter(event =>
        event.sourceTable.startsWith("writer:") && journalMatchesPath(source.archivePath, event.objectKey)).at(-1);
      if ((receipt?.operation === "add" || receipt?.operation === "replace") &&
          !mediaReceiptMatches(source.sourceVersion, receipt.sourceGeneration)) {
        untrackedChanges.add(source.archivePath);
      }
      if (!journalRequiresCapture && prior && prior.bytes === source.size && prior.sourceVersion === source.sourceVersion) {
        unchangedFiles.set(source.archivePath, prior);
      } else {
        if (previousJournalPosition !== null && !journalRequiresCapture) untrackedChanges.add(source.archivePath);
        selectedSourcePaths.add(source.archivePath);
      }
      return { ...source };
    });
    if (previousJournalPosition !== null) for (const prior of previousFiles.keys()) {
      if (!seen.has(prior) && !selectedJournal?.events.some(event =>
        event.operation === "remove" && journalMatchesPath(prior, event.objectKey))) untrackedChanges.add(prior);
    }
    return selectedSourcePaths;
  });
  if (!sourceSelectionMade || capture.sourceVersions.length !== plannedSourceVersions.length ||
      capture.sourceVersions.some((source, index) =>
        source.archivePath !== plannedSourceVersions[index]?.archivePath ||
        source.size !== plannedSourceVersions[index]?.size ||
        source.sourceVersion !== plannedSourceVersions[index]?.sourceVersion)) {
    throw new DatabaseProtectionError("Production media source inventory was not selected for capture.");
  }
  if (selectedJournal) {
    if (JSON.stringify(journalCheckpoint.parse(capture.evidence.productionMediaJournal)) !== JSON.stringify(selectedJournal)) {
      throw new DatabaseProtectionError("Captured media and database journal checkpoints do not agree.");
    }
    for (const event of selectedJournal.events) {
      if (event.operation !== "remove" &&
          !event.objectKey.replace(/^private-objects\//, "").startsWith("desktop-installer/") &&
          !selectedJournal.events.some(later => later.operation === "remove" &&
            BigInt(later.position) > BigInt(event.position) && later.objectKey === event.objectKey) &&
          !plannedSourceVersions.some(source => journalMatchesPath(source.archivePath, event.objectKey)) &&
          !capture.missingReferences.some(path => journalMatchesPath(path, event.objectKey))) {
        throw new DatabaseProtectionError("A journaled media mutation has no captured source or explicit missing-file inventory.");
      }
    }
  }
  const plannedByPath = new Map(plannedSourceVersions.map(source => [source.archivePath, source]));
  for (const entry of changedFiles) {
    const source = plannedByPath.get(entry.path);
    if (!source || !selectedSourcePaths.has(entry.path) || source.size !== entry.bytes ||
        source.sourceVersion !== entry.sourceVersion) {
      throw new DatabaseProtectionError("Captured production media differs from the selected source-version inventory.");
    }
  }
  if (changedFiles.length !== selectedSourcePaths.size) {
    throw new DatabaseProtectionError("A selected production media source was not completely captured.");
  }
  const currentPaths = new Set(plannedSourceVersions.map(source => source.archivePath));
  for (const path of unchangedFiles.keys()) {
    if (!currentPaths.has(path)) throw new DatabaseProtectionError("Reused production media is absent from the current source inventory.");
  }
  const files = [...unchangedFiles.values(), ...changedFiles].sort((a, b) => a.path.localeCompare(b.path));
  const entries = inventory.parse({
    files, missingReferences: capture.missingReferences,
    coverageLimitations: [...(capture.coverageLimitations ?? []),
      ...(untrackedChanges.size ? [`${untrackedChanges.size} media source-version changes lack matching journal evidence; coverage is partial.`] : [])],
    evidence: capture.evidence,
  });
  const inventoryBytes = Buffer.from(JSON.stringify(entries));
  if (inventoryBytes.length > 64 * 1024 * 1024) throw new DatabaseProtectionError("Production inventory exceeds the supported manifest ceiling.");
  const inventoryChunks = [];
  for (let offset = 0; offset < inventoryBytes.length; offset += 1024 * 1024) {
    inventoryChunks.push(await putChunk(inventoryBytes.subarray(offset, offset + 1024 * 1024)));
  }
  const createdAt = new Date(Math.max(Date.now(), previous ? Date.parse(previous.root.createdAt) + 1 : 0)).toISOString();
  const root = rootSchema.parse({
    format: PRODUCTION_CONTENT_FORMAT, source: options.source, point: randomUUID(), createdAt,
    previousPoint: previous?.root.point ?? null, databaseMarker: database.marker,
    coverage: entries.missingReferences.length || entries.coverageLimitations.length ? "partial" : "complete",
    inventory: inventoryChunks, inventoryHash: hash(inventoryBytes), inventoryBytes: inventoryBytes.length,
    newBytes, newChunks, reusedChunks,
  });
  const name = `point-${Date.parse(createdAt)}-${root.point}.enc`;
  const encrypted = options.codec.encrypt(Buffer.from(JSON.stringify(root)));
  await immutable(options.store, name, encrypted);
  await options.onPhase?.("Verifying new bytes and retained record/media dependencies before committing the point");
  const result = await verifyRoot(options, root, Boolean(previous) || Boolean(options.store.getVersion));
  const marker = name.replace(/^point-/, "verified-");
  if (options.store.getVersion) {
    const chunks=[...root.inventory, ...result.inventory.files.flatMap(f => f.chunks)];
    const versions=options.store.getVersions
      ? await options.store.getVersions([...new Set(chunks.filter(c=>c.remoteVersion).map(c=>`chunk-${c.hash}.enc`))]) : undefined;
    for (const c of chunks) {
      await verifyStoredChunk(options, c,versions);
    }
  }
  // No verified marker may be written before the final dependency checks.
  await immutable(options.store, marker, options.codec.encrypt(Buffer.from(JSON.stringify({
    format: PRODUCTION_CONTENT_FORMAT, source: options.source, root: name, hash: hash(encrypted),
  }))));
  return { marker, ...result };
}

export async function readProductionFile(options: ProductionOptions, entry: ProductionFile,
  consume: (bytes: Buffer) => Promise<void>) {
  const h = createHash("sha256"); let size = 0;
  for (const c of entry.chunks) {
    const bytes = await readChunk(options, c); h.update(bytes); size += bytes.length; await consume(bytes);
  }
  if (size !== entry.bytes || h.digest("hex") !== entry.hash) throw new DatabaseProtectionError("Restored production file integrity failed.");
}
