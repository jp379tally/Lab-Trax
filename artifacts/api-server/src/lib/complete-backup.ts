import { pool } from "@workspace/db";
import { capturePostgresRecordChanges, recordInventoryHash, recordInventoryReferences,
  type RecordCapture, type RecordInventory } from "./postgres-record-delta";
import { lockMediaCheckpoint, unlockMediaCheckpoint, unresolvedMediaWrites } from "./production-media-mutation";
import { copyProductionUpload } from "./production-media-local-write";
import { collectMediaMutationReceipts } from "./production-media-mutation";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { listPrivateBackupObjects, openPrivateBackupObject, restorePrivateBackupObject, restorePrivateBackupObjectStream } from "./case-media-object-storage";
import { writeRecoveryEntry, type RecoveryZip } from "./recovery-zip";
import {
  DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY,
  planBackupMedia,
  type BackupFileEvidence,
  type BackupMediaAppender,
  type BackupMediaSourceVersion,
} from "./backup-media-producer";
import { extractMediaFilenamesFromText } from "./case-media";
import { isProductionDeployment } from "./onedrive";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyProductionBackupSource } from "./backup-production-source";
import { measureBackupPhase, setBackupLiveProgress } from "./backup-phase";
import { MAX_DATABASE_DUMP_BYTES, type DatabaseDumpSource } from "./database-protection";
import {
  assertProductionMediaJournalCoverage,
  readProductionMediaJournalRange,
} from "./production-media-journal";

export const COMPLETE_BACKUP_VERSION = 2;
export const COMPLETE_PRODUCTION_KIND = "complete-production";
export const COMPLETE_DEVELOPMENT_KIND = "complete-non-production";
const DESKTOP_RELEASE_IDENTITY_PATH = "desktop-installer/release-identity.json";
const MAX_DESKTOP_RELEASE_IDENTITY_BYTES = 64 * 1024;

export interface DesktopReleaseIdentity {
  schemaVersion: 1;
  version: string;
  sourceRevision: string;
  signatureVerification: "verified-installer" | "verified-contained-executable";
  artifact: {
    fileName: "LabTrax-Setup.exe" | "LabTrax-Windows-Portable.zip" | "LabTrax.dmg";
    size: number;
    sha256: string;
  };
}

export function assertIsolatedCompleteRecovery(
  manifest: CompleteRecoveryManifest,
): void {
  const root = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
  const databaseUrl = process.env.DATABASE_URL;
  const host = databaseUrl ? new URL(databaseUrl).hostname : null;
  if (!root || !path.resolve(process.cwd()).startsWith(`${path.resolve(root)}${path.sep}`) ||
      !host || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Complete archives require an isolated workspace and disposable local database; live/UI restoration is refused.");
  }
  const destination = process.env.PRIVATE_OBJECT_DIR?.trim().replace(/^\/+|\/+$/g, "");
  if (manifest.storageNamespaceSha256 && destination &&
      createHash("sha256").update(destination).digest("hex") === manifest.storageNamespaceSha256) {
    throw new Error("Isolated recovery cannot write back into the source private object namespace.");
  }
}
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
/**
 * Where the encrypted archive is written: spooled to temporary storage
 * ("local"), staged in private App Storage ("cloud"), or streamed straight to
 * its final destination ("direct"). Only a spooled archive needs temporary
 * capacity for a whole archive copy.
 */
export type CompleteArchiveDestination = "local" | "cloud" | "direct";
const COMPLETE_BACKUP_TEMP_HEADROOM_BYTES = 512 * 1024 * 1024;
/** Keep the JSON row page bounded while cutting the inventory round trips in half. */
export const COMPLETE_BACKUP_REFERENCE_FETCH_SIZE = 128;
export function requireCompleteBackupCapacity(
  availableBytes: number, durableBytes: number, stagedBytes: number, dumpBytes: number,
  archiveDestination: CompleteArchiveDestination = "local",
): void {
  if (![availableBytes, durableBytes, stagedBytes, dumpBytes].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !["local", "cloud", "direct"].includes(archiveDestination)) {
    throw new Error("Complete backup capacity inventory is invalid; no files were omitted.");
  }
  const archiveBytes = archiveDestination === "local" ? Math.ceil(durableBytes * 1.03) : 0;
  const requiredBytes = archiveBytes + stagedBytes + dumpBytes + COMPLETE_BACKUP_TEMP_HEADROOM_BYTES;
  if (!Number.isSafeInteger(requiredBytes)) {
    throw new Error("Complete backup capacity inventory is invalid; no files were omitted.");
  }
  if (requiredBytes > availableBytes) {
    throw new Error(`Complete backup capacity failure: ${requiredBytes} bytes of temporary capacity are required, ` +
      `${availableBytes} bytes are available (${(requiredBytes / 1024 ** 3).toFixed(2)} GiB required; ` +
      `${(availableBytes / 1024 ** 3).toFixed(2)} GiB available). ` +
      `Staging mode: ${archiveDestination}. Use an existing runtime-accessible temporary filesystem with sufficient free space ` +
      `through TMPDIR and restart that runtime, or use a configured cloud-staging destination to avoid a whole local archive copy. ` +
      `Do not delete originals or recovery copies; no files were omitted.`);
  }
}

export interface CompleteBackupStagingPlan {
  maxConcurrentFiles: number;
  stagedBytes: number;
  requiredBytes: number;
}

/**
 * Bound temporary media copies by the available filesystem rather than
 * assuming the twelve largest objects can all be staged at once. Every object
 * remains in the archive; if even one object cannot be staged, fail closed.
 */
export function planCompleteBackupStaging(
  availableBytes: number,
  durableBytes: number,
  objectSizes: number[],
  dumpBytes: number,
  archiveDestination: CompleteArchiveDestination = "local",
): CompleteBackupStagingPlan {
  if (![availableBytes, durableBytes, dumpBytes].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !["local", "cloud", "direct"].includes(archiveDestination) ||
      objectSizes.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Complete backup capacity inventory is invalid; no files were omitted.");
  }

  const sizes = [...objectSizes].sort((a, b) => b - a);
  const archiveBytes = archiveDestination === "local" ? Math.ceil(durableBytes * 1.03) : 0;
  if (!Number.isSafeInteger(archiveBytes)) {
    throw new Error("Complete backup capacity inventory is invalid; no files were omitted.");
  }
  const maxCandidates = sizes.length
    ? Math.min(DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY, sizes.length)
    : DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY;
  let stagedBytes = sizes.slice(0, maxCandidates).reduce((sum, size) => sum + size, 0);
  for (let count = maxCandidates; count >= 1; count--) {
    const requiredBytes = archiveBytes + stagedBytes + dumpBytes + COMPLETE_BACKUP_TEMP_HEADROOM_BYTES;
    if (!Number.isSafeInteger(requiredBytes)) {
      throw new Error("Complete backup capacity inventory is invalid; no files were omitted.");
    }
    if (requiredBytes <= availableBytes) return { maxConcurrentFiles: count, stagedBytes, requiredBytes };
    stagedBytes -= sizes[count - 1] ?? 0;
  }

  // Preserve the existing fail-closed capacity diagnostic, using the minimum
  // viable staging count instead of reporting an avoidable twelve-file peak.
  requireCompleteBackupCapacity(
    availableBytes, durableBytes, sizes[0] ?? 0, dumpBytes, archiveDestination,
  );
  throw new Error("Complete backup staging plan is unavailable; no files were omitted.");
}
/**
 * A destination on its own filesystem must hold the finished archive. The
 * bound is the same as the temporary-storage archive reservation: the
 * uncompressed inventory plus container overhead, the dump and headroom.
 */
export function requireCompleteDestinationCapacity(
  availableBytes: number,
  durableBytes: number,
  dumpBytes: number,
): void {
  if (![availableBytes, durableBytes, dumpBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Complete backup destination capacity inventory is invalid; no files were omitted.");
  }
  const requiredBytes = Math.ceil(durableBytes * 1.03) + dumpBytes + 512 * 1024 * 1024;
  if (!Number.isSafeInteger(requiredBytes)) {
    throw new Error("Complete backup destination capacity inventory is invalid; no files were omitted.");
  }
  if (requiredBytes > availableBytes) {
    throw new Error(`Complete backup destination capacity failure: ${requiredBytes} bytes are required at the destination, ` +
      `${availableBytes} bytes are available. Free destination space for the full recovery archive; no files were omitted.`);
  }
}
const excluded = (name: string) =>
  name.split("/").some(part => [
    ".sessions", ".restore-snapshots", ".labtrax-backup-staging", "backups", "backup-downloads",
  ].includes(part));

interface BackupStagingObject {
  relativeName: string;
  size: number;
  openStream?: unknown;
}

/**
 * Capacity planning must match the objects that the archive appenders include.
 * Root-level backup/history directories are deliberately excluded from the
 * private-objects archive and must not force unrelated temp-space reservations.
 * Case media is handled by its own complete inventory, including nested paths.
 */
export function includedBackupStagingObjectSizes(objects: readonly BackupStagingObject[]): number[] {
  return objects
    .filter(object => !object.openStream &&
      (object.relativeName.startsWith("case-media/") || !excluded(object.relativeName)))
    .map(object => object.size);
}

export interface CompleteRecoveryManifest {
  coverageVersion: number;
  sourceEnvironment: "production" | "non-production";
  sourceRevision?: string | null;
  releaseIdentity?: DesktopReleaseIdentity;
  sourceDatabase: string;
  sourceIdentitySha256: string;
  storageNamespaceSha256: string | null;
  provenance: { productionLineageVerified: boolean; fingerprintSha256: string | null };
  snapshotAt: string;
  snapshot: string;
  databaseSha256: string;
  databaseCapture?: "postgresql-record-state-v1";
  tables: Array<{ schema: string; name: string; rows: number }>;
  files: BackupFileEvidence[];
  requiredReferences: string[];
  /** Explicitly missing originals; never evidence of complete protection. */
  missingReferences?: string[];
  /** Opaque storage-reference outbox range captured in the same DB snapshot. */
  productionMediaWriterCoverage?: { protocol: 1; unresolvedWrites: number; metadataScanMs: number };
  productionMediaJournal?: {
    afterPosition: string;
    throughPosition: string;
    events: Array<{
      position: string;
      operation: "add" | "remove" | "replace";
      objectKey: string;
      sourceTable: string;
    }>;
  };
  recoveryCoverage?: "complete" | "partial";
  exclusions: string[];
}

export interface CompleteBackupCaptureMetadata {
  recordCapture?: RecordCapture;
  append: BackupMediaAppender;
  manifest: CompleteRecoveryManifest;
  /** Metadata-only source identities used by protected-point delta capture. */
  productionMediaSources: BackupMediaSourceVersion[];
  durableBytes: number;
  stagedBytes: number;
  profilePhotoFileCount: number;
  counts: {
    userCount: number; orgCount: number; caseCount: number; invoiceCount: number;
    tableCount: number; attachmentRowCount: number;
  };
  uploadDirs: {
    caseMedia: { exists: boolean; fileCount: number; totalBytes: number };
    profilePhotos: { exists: boolean; fileCount: number; totalBytes: number };
  };
}
export type CompleteBackupCaptured<Stream extends boolean = false> = CompleteBackupCaptureMetadata & {
  pgDump: Stream extends true ? AsyncIterable<Uint8Array> : Buffer;
  dispose: Stream extends true ? () => Promise<void> : undefined;
};

function parseDesktopReleaseIdentity(raw: Buffer | string): DesktopReleaseIdentity {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    throw new Error("Desktop release identity sidecar is not valid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Desktop release identity sidecar is invalid.");
  }
  const identity = value as Partial<DesktopReleaseIdentity>;
  const artifact = identity.artifact;
  if (identity.schemaVersion !== 1 ||
      typeof identity.version !== "string" || !identity.version.trim() || identity.version.length > 64 ||
      typeof identity.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(identity.sourceRevision) ||
      (identity.signatureVerification !== "verified-installer" &&
       identity.signatureVerification !== "verified-contained-executable") ||
      !artifact || !["LabTrax-Setup.exe", "LabTrax-Windows-Portable.zip", "LabTrax.dmg"].includes(artifact.fileName) ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      (artifact.fileName !== "LabTrax-Windows-Portable.zip" && identity.signatureVerification !== "verified-installer") ||
      (artifact.fileName === "LabTrax-Windows-Portable.zip" && identity.signatureVerification !== "verified-contained-executable")) {
    throw new Error("Desktop release identity is unsigned or contains invalid artifact metadata.");
  }
  return {
    schemaVersion: 1,
    version: identity.version,
    sourceRevision: identity.sourceRevision,
    signatureVerification: identity.signatureVerification,
    artifact: {
      fileName: artifact.fileName as DesktopReleaseIdentity["artifact"]["fileName"],
      size: artifact.size,
      sha256: artifact.sha256,
    },
  };
}

function assertDesktopReleaseIdentityMatchesFiles(
  identity: DesktopReleaseIdentity,
  sourceRevision: string,
  files: BackupFileEvidence[],
  sidecarBytes: Buffer,
  missingReferences: string[] = [],
): void {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || identity.sourceRevision !== sourceRevision) {
    throw new Error("Desktop release source revision does not match the running backup code.");
  }
  const sidecarFile = files.find(file =>
    file.archivePath === `private-objects/${DESKTOP_RELEASE_IDENTITY_PATH}`);
  if (!sidecarFile || sidecarFile.size !== sidecarBytes.length ||
      sidecarFile.sha256 !== createHash("sha256").update(sidecarBytes).digest("hex")) {
    throw new Error("Desktop release identity sidecar in the recovery archive does not match the inspected sidecar.");
  }
  const installer = files.find(file =>
    file.archivePath === `private-objects/desktop-installer/${identity.artifact.fileName}`);
  const declaredMissingInstaller = !installer &&
    missingReferences.includes(`desktop-installer/${identity.artifact.fileName}`);
  if (!declaredMissingInstaller && (!installer || installer.size !== identity.artifact.size ||
      installer.sha256 !== identity.artifact.sha256)) {
    throw new Error("Desktop release identity does not match the exact archived installer size and SHA-256.");
  }
  const archivedIdentity = parseDesktopReleaseIdentity(sidecarBytes);
  if (JSON.stringify(archivedIdentity) !== JSON.stringify(identity)) {
    throw new Error("Desktop release identity in the recovery archive differs from the validated sidecar.");
  }
}

async function readRunningSourceRevision(): Promise<string> {
  const identityPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "build-identity.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(identityPath, "utf8"));
  } catch {
    throw new Error("Production recovery capture requires the deployed API build identity.");
  }
  const sourceRevision = parsed && typeof parsed === "object"
    ? (parsed as { sourceRevision?: unknown }).sourceRevision
    : null;
  if (typeof sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error("Deployed API build identity does not contain a full source revision.");
  }
  return sourceRevision;
}

async function readReleaseIdentityObject(
  object: BackupStagingObject & { openStream?: (signal?: AbortSignal) => NodeJS.ReadableStream },
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!object.openStream || object.size <= 0 || object.size > MAX_DESKTOP_RELEASE_IDENTITY_BYTES) {
    throw new Error("Desktop release identity sidecar is missing or exceeds the allowed size.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of object.openStream(signal) as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_DESKTOP_RELEASE_IDENTITY_BYTES) {
      throw new Error("Desktop release identity sidecar exceeds the allowed size.");
    }
    chunks.push(buffer);
  }
  if (totalBytes !== object.size) {
    throw new Error("Desktop release identity sidecar size changed during inspection.");
  }
  return Buffer.concat(chunks, totalBytes);
}

/** Resolve only server-owned storage identities, never arbitrary remote URLs. */
export function recoveryReferences(table: string, row: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  if (table.startsWith("labtrax_production_media_")) return refs;
  if (row.deleted_at || ["scan_output_garbage", "support_report_attachment_garbage"].includes(table)) return refs;
  const add = (prefix: string, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    if (/^(data:|https?:)/.test(value) && !value.includes("/uploads/")) return;
    const name = value.replace(/^.*\/uploads\//, "").replace(/^\/+/, "");
    refs.add(/^(case-media|profile-photos|messenger-media|invoice-attachments|support-reports|lab-logos|invoice-template-images|case-print-template-images|legacy-case-data-backups|desktop-installer|recovery-archives)\//.test(name)
      ? name : `${prefix}/${name}`);
  };
  if (table === "organizations" && typeof row.logo_url === "string" && row.logo_url.includes("/logo") && typeof row.id === "string") {
    refs.add(`lab-logos/${row.id}.*`);
  }
  for (const [column, value] of Object.entries(row)) {
    if (value === null) continue;
    if (["case_attachments", "invoice_attachments", "case_exception_attachments", "lab_documents", "scan_outputs", "scan_inputs", "scan_input_chunks"].includes(table) &&
        column === "storage_key") add("case-media", value);
    if (table === "legacy_case_media" && column === "file_name") add("case-media", value);
    if (table === "lab_inbox_files" && ["storage_path", "object_storage_key"].includes(column)) add("case-media", value);
    if (table === "provider_messenger_messages" && column === "media_key") add("messenger-media", value);
    if (table === "support_report_attachments" && column === "storage_key") add("support-reports", value);
    if (column === "pdf_storage_key") add("case-media", value);
    if (column === "profile_photo_url" && typeof value === "string" && value.includes("/profile-photos/")) {
      refs.add(`profile-photos/${value.split("/profile-photos/")[1]!.split("?")[0]}`);
    }
    const raw = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : "";
    if (column.endsWith("_json") || column === "case_data" || column === "value") {
      // Immutable bundle/evidence manifests can contain bare storageKey values.
      try {
        const walk = (item: unknown): void => {
          if (!item || typeof item !== "object") return;
          for (const [key, nested] of Object.entries(item)) {
            if (["storageKey", "objectStorageKey", "mediaKey"].includes(key)) add("case-media", nested);
            else if (typeof nested === "object") walk(nested);
          }
        };
        walk(typeof value === "object" ? value : JSON.parse(raw));
      } catch {
        // Non-JSON text is scanned for explicit media URLs below.
      }
    }
    for (const file of extractMediaFilenamesFromText(raw)) refs.add(`case-media/${file}`);
    for (const match of raw.matchAll(/(?:messenger-media|invoice-attachments|invoice-template-images|case-print-template-images|legacy-case-data-backups|lab-logos|desktop-installer|recovery-archives)\/[A-Za-z0-9._/-]+/g)) {
      refs.add(match[0]);
    }
    // Logo settings store the extension separately from the organization id.
    if ((column === "value" || column.endsWith("_json")) && raw.includes('"ext"') && table === "system_settings" &&
        typeof row.key === "string" && row.key.startsWith("lab_logo:")) {
      const logo = JSON.parse(raw);
      if (typeof logo.ext === "string") refs.add(`lab-logos/${row.key.slice("lab_logo:".length)}.${logo.ext}`);
    }
  }
  return refs;
}

/**
 * One exported PostgreSQL snapshot owns the dump, counts and file references.
 * Generations are pinned; replacement/deletion during transfer fails closed.
 * Local sources are checked for inode/size/mtime/ctime changes by the producer.
 */
export async function captureCompleteBackup<Stream extends boolean = false>(
  uploadsRoot: string,
  dump: (snapshot: string) => Promise<DatabaseDumpSource> | DatabaseDumpSource,
  signal?: AbortSignal,
  options: {
    archiveDestination?: CompleteArchiveDestination;
    allowMissingReferences?: boolean;
    productionDataOnly?: boolean;
    productionJournalAfterPosition?: string | null;
    /** Import the same exported snapshot used by the scheduled pg_dump. */
    snapshot?: string;
    onMediaPinned?: () => Promise<void>;
    streamDatabaseDump?: Stream;
    /** Scheduled record points only; legacy/manual complete archives keep full dumps. */
    records?: { previous: RecordInventory | null; schemaSql: (snapshot: string) => Promise<string> };
  } = {} as { streamDatabaseDump?: Stream },
): Promise<CompleteBackupCaptured<Stream>> {
  const client = await pool.connect();
  let dumpScratch: string | undefined;
  let ownMediaLock = false;
  try {
    if (options.records && (!options.productionDataOnly || !options.snapshot || !options.streamDatabaseDump)) {
      throw new Error("Record-change capture requires the scheduled production snapshot path.");
    }
    if (!options.snapshot) { await lockMediaCheckpoint(client); ownMediaLock = true; }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (options.snapshot) {
      // The identifier is returned by PostgreSQL for this backup operation;
      // quote it as a literal because SET TRANSACTION SNAPSHOT is not a bindable
      // expression. It is never accepted from a request or user input.
      await client.query(`SET TRANSACTION SNAPSHOT '${options.snapshot.replace(/'/g, "''")}'`);
    }
    await client.query("SET LOCAL statement_timeout = '60s'");
    const boundary = (await client.query<{ snapshot: string | null; at: string; database: string }>(
      options.snapshot
        ? "SELECT $1::text AS snapshot, transaction_timestamp()::text AS at, current_database() AS database"
        : "SELECT pg_export_snapshot() AS snapshot, transaction_timestamp()::text AS at, current_database() AS database",
      options.snapshot ? [options.snapshot] : [],
    )).rows[0]!;
    const snapshotToken = options.snapshot ?? boundary.snapshot;
    if (!snapshotToken) throw new Error("PostgreSQL did not provide a consistent backup snapshot.");
    let fingerprintSha256: string | null = null;
    if (isProductionDeployment()) {
      fingerprintSha256 = await verifyProductionBackupSource(client);
    }
    let productionMediaJournal: CompleteRecoveryManifest["productionMediaJournal"];
    if (options.productionJournalAfterPosition !== undefined) {
      await assertProductionMediaJournalCoverage(client);
      productionMediaJournal = await readProductionMediaJournalRange(
        client,
        options.productionJournalAfterPosition,
      );
    }
    // Pin storage identities under the same boundary as the exported records,
    // then release writers before the slow row inventory/dump/body transfers.
    await measureBackupPhase("case-media inventory and reference validation", async () => {
      if (signal?.aborted) throw signal.reason ?? new Error("Recovery source catalog capture was interrupted.");
    });
    const mediaCatalogStarted = Date.now();
    const allObjects = process.env.PRIVATE_OBJECT_DIR ? await listPrivateBackupObjects("", signal) : [];
    const objects = options.productionDataOnly
      ? allObjects.filter(object => !object.relativeName.startsWith("desktop-installer/"))
      : allObjects;
    const files: BackupFileEvidence[] = [];
    const onFile = (file: BackupFileEvidence) => files.push(file);
    const pinnedMedia = await planBackupMedia(path.join(uploadsRoot, "case-media"),
      objects.filter(object => object.relativeName.startsWith("case-media/")).map(object => ({
        ...object, relativeName: object.relativeName.slice("case-media/".length),
      })), signal, { onFile });
    const pinnedLocal = await planBackupMedia(uploadsRoot, [], signal, {
      archivePrefix: "local-uploads", onFile,
      exclude: name => excluded(name) || name === "case-media" || name.startsWith("case-media/") ||
        (options.productionDataOnly === true && (name === "desktop-installer" || name.startsWith("desktop-installer/"))),
    });
    const pinnedPrivate = await planBackupMedia(path.join(uploadsRoot, ".absent-private-inventory"),
      objects.filter(object => !object.relativeName.startsWith("case-media/") && !excluded(object.relativeName)),
      signal, { archivePrefix: "private-objects", onFile });
    const pinnedLegacy = await planBackupMedia(path.resolve(process.cwd(), "server", ".data"), [], signal, {
      archivePrefix: "local-state", onFile, exclude: name => name !== "legacy-chat.json",
    });
    const pendingMediaWrites = await unresolvedMediaWrites(client);
    const mediaMetadataMs = Date.now() - mediaCatalogStarted;
    if (ownMediaLock) { await unlockMediaCheckpoint(client); ownMediaLock = false; }
    await options.onMediaPinned?.();
    let tablesCompleted = 0;
    let tableCount = 0;
    let rowsScanned = 0;
    const inventoryStartedAt = Date.now();
    const { tables, references, recordCapture } = await measureBackupPhase(
      "case-media inventory and reference validation",
      async () => {
        if (options.records) {
          const recordCapture = await capturePostgresRecordChanges(client, {
            previous: options.records.previous, schemaSql: ()=>options.records!.schemaSql(snapshotToken), signal,
            references: (table, row) => [...recoveryReferences(table, row)],
            // Reconcile historical references when the deployed extractor changes.
            referenceProtocol:createHash("sha256").update(`record-references-v1:${isProductionDeployment()
              ? await readRunningSourceRevision() : "isolated-record-capture-v1"}`).digest("hex"),
          });
          const tables = recordCapture.inventory.tables.map(table => ({schema:table.schema,name:table.name,
            rows:table.rows.reduce((sum,row)=>sum+row.count,0)}));
          tableCount = tables.length; tablesCompleted = tables.length;
          rowsScanned = recordCapture.metrics.fingerprintRows;
          return {tables,references:new Set(recordInventoryReferences(recordCapture.inventory)),recordCapture};
        }
        const tableRows = (await client.query<{ schema: string; name: string }>(`
          SELECT n.nspname AS schema, c.relname AS name FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
            AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
            ORDER BY n.nspname, c.relname
        `)).rows;
        tableCount = tableRows.length;
        const scannedTables: CompleteRecoveryManifest["tables"] = [];
        const foundReferences = new Set<string>();
        for (const table of tableRows) {
          if (signal?.aborted) throw new Error("Complete database inventory aborted.");
          let rows = 0;
          await client.query(`DECLARE recovery_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS row FROM ${quote(table.schema)}.${quote(table.name)} t`);
          try {
            for (;;) {
              if (signal?.aborted) throw new Error("Complete database inventory aborted.");
              // Production phase timings show reference inventory taking 91s
              // for ~193k rows. A 128-row cursor page halves database round
              // trips while keeping variable-size JSON pages bounded.
              const batch = await client.query<{ row: Record<string, unknown> }>(
                `FETCH ${COMPLETE_BACKUP_REFERENCE_FETCH_SIZE} FROM recovery_rows`,
              );
              if (!batch.rows.length) break;
              rows += batch.rows.length;
              rowsScanned += batch.rows.length;
              for (const item of batch.rows) {
                for (const reference of recoveryReferences(table.name, item.row)) foundReferences.add(reference);
              }
              setBackupLiveProgress({ tablesCompleted, tableCount, rowsScanned });
            }
          } finally {
            await client.query("CLOSE recovery_rows").catch(() => undefined);
          }
          scannedTables.push({ ...table, rows });
          tablesCompleted++;
          setBackupLiveProgress({ tablesCompleted, tableCount, rowsScanned });
        }
        return { tables: scannedTables, references: foundReferences, recordCapture:undefined };
      },
      () => ({
        tablesCompleted, tableCount, rowsScanned,
        rowsPerSecond: Math.round(rowsScanned / Math.max(1, (Date.now() - inventoryStartedAt) / 1000)),
      }),
    );
    const activeCounts = (await client.query<{ users: string; organizations: string; cases: string }>(`
      SELECT (SELECT count(*) FROM public.users WHERE deleted_at IS NULL)::text AS users,
        (SELECT count(*) FROM public.organizations WHERE deleted_at IS NULL)::text AS organizations,
        (SELECT count(*) FROM public.cases WHERE deleted_at IS NULL)::text AS cases
    `)).rows[0]!;
    // Only a new/schema baseline exports schema definitions. No data pg_dump
    // runs for record points, and unchanged intervals export no row bodies.
    const dumpSource = recordCapture?.delta ? Buffer.alloc(0) : await dump(snapshotToken);
    let pgDump: Buffer | AsyncIterable<Uint8Array>;
    let pgDumpBytes: number;
    let databaseSha256: string;
    let dispose: (() => Promise<void>) | undefined;
    if (recordCapture?.delta) {
      // No unused fs.ReadStream/file descriptor or scratch dump for an interval
      // whose schema is retained. Only selected row bodies were captured.
      pgDump = (async function* () {})(); pgDumpBytes=0;databaseSha256=recordInventoryHash(recordCapture.inventory);
      dispose=async()=>undefined;
    } else if (options.streamDatabaseDump) {
      dumpScratch = await fs.mkdtemp(path.join(tmpdir(), "labtrax-db-capture-"));
      const stagedDumpPath = path.join(dumpScratch, "database.pgdump");
      const output = await fs.open(stagedDumpPath, "wx", 0o600);
      const digest = createHash("sha256");
      const header = Buffer.alloc(5);
      let headerBytes = 0, position = 0;
      const source: AsyncIterable<Uint8Array> = Buffer.isBuffer(dumpSource)
        ? (async function* () { yield dumpSource; })()
        : dumpSource;
      try {
        for await (const value of source) {
          signal?.throwIfAborted();
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          if (position + chunk.length > MAX_DATABASE_DUMP_BYTES) {
            throw new Error("Streamed PostgreSQL export exceeds the recovery manifest capacity.");
          }
          if (headerBytes < header.length) {
            const count = Math.min(header.length - headerBytes, chunk.length);
            chunk.copy(header, headerBytes, 0, count);
            headerBytes += count;
          }
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await output.write(chunk, offset, chunk.length - offset, position);
            if (written.bytesWritten <= 0) throw new Error("Could not stage the streamed PostgreSQL export.");
            offset += written.bytesWritten;
            position += written.bytesWritten;
          }
        }
        if (position < 5 || header.toString("ascii") !== "PGDMP") {
          throw new Error("Streamed PostgreSQL export is empty or not a supported custom-format dump.");
        }
        await output.sync();
      } catch (error) {
        await output.close().catch(() => undefined);
        throw error;
      }
      await output.close();
      pgDumpBytes = position;
      databaseSha256 = digest.digest("hex");
      pgDump = createReadStream(stagedDumpPath);
      const ownedScratch = dumpScratch;
      dispose = async () => {
        await fs.rm(ownedScratch, { recursive: true, force: true });
        if (dumpScratch === ownedScratch) dumpScratch = undefined;
      };
    } else {
      if (!Buffer.isBuffer(dumpSource)) {
        throw new Error("A streamed database source requires streaming capture mode.");
      }
      pgDump = dumpSource;
      pgDumpBytes = dumpSource.length;
      databaseSha256 = createHash("sha256").update(dumpSource).digest("hex");
    }
    if (recordCapture) databaseSha256 = recordInventoryHash(recordCapture.inventory);
    let sourceRevision: string | null = null;
    let releaseIdentity: DesktopReleaseIdentity | undefined;
    let releaseIdentityBytes: Buffer | undefined;
    if (isProductionDeployment() && options.productionDataOnly) sourceRevision = await readRunningSourceRevision();
    if (isProductionDeployment() && !options.productionDataOnly) {
      sourceRevision = await readRunningSourceRevision();
      const sidecar = objects.find(object => object.relativeName === DESKTOP_RELEASE_IDENTITY_PATH);
      if (!sidecar && !options.allowMissingReferences) {
        throw new Error("Production recovery capture requires a signed Desktop release identity sidecar.");
      }
      // Missing software-release evidence must not discard an otherwise usable
      // data backup. Inventory it as missing; never invent a release identity.
      references.add(DESKTOP_RELEASE_IDENTITY_PATH);
      if (sidecar) {
        releaseIdentityBytes = await readReleaseIdentityObject(sidecar, signal);
        releaseIdentity = parseDesktopReleaseIdentity(releaseIdentityBytes);
        if (releaseIdentity.sourceRevision !== sourceRevision) {
          throw new Error("Desktop release identity does not match the deployed backup source revision.");
        }
        references.add(`desktop-installer/${releaseIdentity.artifact.fileName}`);
      }
    }
    // Sizing, capacity, reference and snapshot-time checks fail against a
    // named phase, so history records where a refused capture stopped.
    const {
      media, local, privateFiles, legacyState, durableBytes, stagedBytes, maxConcurrentFiles, missing,
    } = await measureBackupPhase(
      "case-media inventory and reference validation",
      async () => {
        if (isProductionDeployment() && !process.env.PRIVATE_OBJECT_DIR) {
          throw new Error("Complete production backup requires access to private App Storage.");
        }
        const media = pinnedMedia, local = pinnedLocal, privateFiles = pinnedPrivate, legacyState = pinnedLegacy;
        // Bounded cloud prefetch, the dump and application headroom always draw
        // on temporary storage. A full encrypted archive is reserved there only
        // when the caller spools the archive onto that filesystem; streamed and
        // cloud-staged destinations hold no archive copy here. Compression cannot
        // establish adequate capacity, so the archive bound is the uncompressed
        // inventory.
        const durableBytes = media.totalBytes + local.totalBytes + privateFiles.totalBytes + legacyState.totalBytes;
        const disk = await fs.statfs(tmpdir());
        const availableBytes = disk.bavail * disk.bsize;
        const stagingPlan = planCompleteBackupStaging(
          availableBytes,
          durableBytes,
          includedBackupStagingObjectSizes(objects),
          pgDumpBytes,
          options.archiveDestination,
        );
        const { stagedBytes, maxConcurrentFiles } = stagingPlan;
        const names = new Set([
          ...[...media.names].map(name => `case-media/${name}`),
          ...local.names, ...privateFiles.names,
        ]);
        // Resolve extension-independent logo URLs to the actual stored identity.
        for (const reference of [...references]) {
          if (!reference.endsWith(".*")) continue;
          const matches = [...names].filter(name => name.startsWith(reference.slice(0, -1)));
          if (matches.length !== 1) continue;
          references.delete(reference);
          references.add(matches[0]!);
        }
        const missing = [...references].filter(name => !names.has(name));
        if (!options.allowMissingReferences && releaseIdentity && missing.some(name =>
          name === DESKTOP_RELEASE_IDENTITY_PATH ||
          name === `desktop-installer/${releaseIdentity!.artifact.fileName}`)) {
          throw new Error("Production recovery capture cannot match the Desktop release because its exact installer bytes are missing.");
        }
        if (missing.length && !options.allowMissingReferences) throw new Error(
          `Complete backup aborted: ${missing.length} required file references have no readable recovery source. ` +
          `Missing classes: ${[...new Set(missing.map(name => name.split("/")[0]))].join(", ")}. Check storage access and recover the missing originals.`,
        );
        const snapshotMs = Date.parse(boundary.at);
        const objectByName = new Map(objects.map(item => [item.relativeName, item]));
        const pinnedLocalVersions = new Map([...media.sourceVersions, ...local.sourceVersions].map(item => [
          item.archivePath.replace(/^media\//, "case-media/").replace(/^local-uploads\//, ""), item.sourceVersion,
        ]));
        for (const reference of references) {
          if (missing.includes(reference)) continue;
          const object = objectByName.get(reference);
          if (object) {
            if (!object.modifiedAt || !Number.isFinite(Date.parse(object.modifiedAt)) ||
                Date.parse(object.modifiedAt) > snapshotMs) {
              throw new Error("A referenced private object was replaced after the database snapshot, or its modification time is unverified. Retry a complete backup.");
            }
          } else {
            const identity = pinnedLocalVersions.get(reference)?.replace(/^local:/, "").split(":");
            if (!identity || Number(identity[3]) > snapshotMs || Number(identity[4]) > snapshotMs) {
              throw new Error("A referenced local file changed after the database snapshot. Retry a complete backup.");
            }
          }
        }
        return { media, local, privateFiles, legacyState, durableBytes, stagedBytes, maxConcurrentFiles, missing };
      },
    );
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    const manifest: CompleteRecoveryManifest = {
      coverageVersion: COMPLETE_BACKUP_VERSION,
      sourceEnvironment: isProductionDeployment() ? "production" : "non-production",
      sourceRevision,
      ...(releaseIdentity ? { releaseIdentity } : {}),
      sourceDatabase: boundary.database,
      sourceIdentitySha256: createHash("sha256").update(`${databaseUrl.hostname}:${databaseUrl.port}/${boundary.database}`).digest("hex"),
      storageNamespaceSha256: process.env.PRIVATE_OBJECT_DIR
        ? createHash("sha256").update(process.env.PRIVATE_OBJECT_DIR.trim().replace(/^\/+|\/+$/g, "")).digest("hex") : null,
      provenance: { productionLineageVerified: isProductionDeployment(), fingerprintSha256 },
      snapshotAt: new Date(boundary.at).toISOString(),
      snapshot: snapshotToken,
      databaseSha256,
      tables, files,
      requiredReferences: [...references].sort(),
      ...(productionMediaJournal ? { productionMediaJournal } : {}),
      productionMediaWriterCoverage: { protocol: 1, unresolvedWrites: pendingMediaWrites, metadataScanMs: mediaMetadataMs },
      missingReferences: missing.sort(),
      recoveryCoverage: missing.length ? "partial" : "complete",
      exclusions: ["generated backup directories", "upload sessions", "internal restore snapshots", "transient caches", "source code and secrets"],
    };
    // No database write after this boundary can change this archive's rows.
    await client.query("COMMIT");
    const append: BackupMediaAppender = async (archive, _maxConcurrentFiles, includeArchivePaths) => {
      const selected = (prefix: string, remap?: (path: string) => string) => includeArchivePaths
        ? new Set([...includeArchivePaths]
          .filter(name => name.startsWith(`${prefix}/`))
          .map(name => remap ? remap(name) : name))
        : undefined;
      await media.append(archive, maxConcurrentFiles, selected("case-media", name => `media/${name.slice("case-media/".length)}`));
      await local.append(archive, maxConcurrentFiles, selected("local-uploads"));
      await privateFiles.append(archive, maxConcurrentFiles, selected("private-objects"));
      await legacyState.append(archive, maxConcurrentFiles, selected("local-state"));
      if (releaseIdentity && releaseIdentityBytes && sourceRevision) {
        assertDesktopReleaseIdentityMatchesFiles(
          releaseIdentity, sourceRevision, files, releaseIdentityBytes, missing,
        );
      }
      manifest.files.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
      archive.append(JSON.stringify(manifest), { name: "complete-recovery.json" });
      if (missing.length) archive.append(JSON.stringify({
        version: 1, missingFileCount: missing.length, missingReferences: missing,
        limitation: "Database records and references are preserved. These originals are not in this archive; this is not a complete recovery point.",
      }), { name: "missing-files.json" });
    };
    const count = (name: string) => tables.find(table => table.schema === "public" && table.name === name)?.rows ?? 0;
    return {
      pgDump, dispose, append,
      manifest: recordCapture ? {...manifest,databaseCapture:"postgresql-record-state-v1" as const} : manifest,
      ...(recordCapture ? {recordCapture} : {}),
      productionMediaSources: [
        ...media.sourceVersions.map(source => ({
          ...source,
          archivePath: `case-media/${source.relativeName}`,
        })),
        ...local.sourceVersions,
        ...privateFiles.sourceVersions,
        ...legacyState.sourceVersions,
      ].sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
      durableBytes, stagedBytes,
      profilePhotoFileCount: [...local.names, ...privateFiles.names].filter(name => name.startsWith("profile-photos/")).length,
      counts: {
        userCount: Number(activeCounts.users), orgCount: Number(activeCounts.organizations), caseCount: Number(activeCounts.cases),
        invoiceCount: count("invoices"), tableCount: tables.length,
        attachmentRowCount: count("case_attachments") + count("legacy_case_media"),
      },
      uploadDirs: {
        caseMedia: { exists: media.fileCount > 0, fileCount: media.fileCount, totalBytes: media.totalBytes },
        // Profiles are captured via local-uploads/private-objects, not an unverified directory append.
        profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 },
      },
    } as CompleteBackupCaptured<Stream>;
  } catch (error) {
    if (dumpScratch) await fs.rm(dumpScratch, { recursive: true, force: true });
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (ownMediaLock) await unlockMediaCheckpoint(client).catch(() => undefined);
    client.release();
  }
}

function safeRelative(name: string): boolean {
  return !!name && !name.includes("\\") && !name.includes("\0") && !path.posix.isAbsolute(name) &&
    name.split("/").every(part => part && part !== "." && part !== "..");
}

/** Validate every byte and mapping before any restore mutation is permitted. */
export function validateCompleteRecovery(zip: RecoveryZip): CompleteRecoveryManifest | null {
  const entry = zip.getEntry("complete-recovery.json");
  const main = JSON.parse(zip.getEntry("manifest.json")!.getData().toString("utf8"));
  if (!entry) {
    if (main.coverageVersion || main.recoveryCoverage === "partial" ||
        String(main.archiveKind).startsWith("partial-")) throw new Error("Complete backup evidence is missing.");
    return null;
  }
  const manifest = JSON.parse(entry.getData().toString("utf8")) as CompleteRecoveryManifest;
  if (manifest.databaseCapture) throw new Error("Record recovery points require the record-aware restore path; this is not a complete pg_dump archive.");
  if (![1, COMPLETE_BACKUP_VERSION].includes(manifest.coverageVersion) ||
      main.coverageVersion !== manifest.coverageVersion ||
      !["production", "non-production"].includes(manifest.sourceEnvironment) || !manifest.tables?.length ||
      !Array.isArray(manifest.files) || !Array.isArray(manifest.requiredReferences) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceIdentitySha256) ||
      (manifest.sourceEnvironment === "production" && (!manifest.provenance?.productionLineageVerified ||
        !/^[a-f0-9]{64}$/.test(manifest.provenance.fingerprintSha256 ?? ""))) ||
      !Number.isFinite(Date.parse(manifest.snapshotAt)) ||
      manifest.tables.some(table => typeof table.schema !== "string" || typeof table.name !== "string" ||
        !Number.isSafeInteger(table.rows) || table.rows < 0) ||
      new Set(manifest.tables.map(table => `${table.schema}.${table.name}`)).size !== manifest.tables.length) {
    throw new Error("Invalid all-content recovery manifest.");
  }
  const missing = manifest.missingReferences ?? [];
  const partial = Array.isArray(missing) && missing.length > 0;
  if (manifest.coverageVersion === COMPLETE_BACKUP_VERSION &&
      manifest.sourceEnvironment === "production" &&
      (!/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "") ||
       (!manifest.releaseIdentity && !(partial && missing.includes(DESKTOP_RELEASE_IDENTITY_PATH))))) {
    throw new Error("Production recovery manifest is missing its matched Desktop release identity.");
  }
  if (manifest.sourceRevision !== undefined && manifest.sourceRevision !== null &&
      !/^[a-f0-9]{40}$/.test(manifest.sourceRevision)) {
    throw new Error("Invalid recovery source revision.");
  }
  const entries = zip.getEntries().filter(item => !item.isDirectory);
  if (new Set(entries.map(item => item.entryName)).size !== entries.length) throw new Error("Duplicate archive entries.");
  const dump = zip.getEntry("db/database.pgdump");
  if (!dump || (dump.sha256 ?? createHash("sha256").update(dump.getData()).digest("hex")) !== manifest.databaseSha256) {
    throw new Error("Database dump integrity check failed.");
  }
  const expected = new Set(["manifest.json", "complete-recovery.json", "db/database.pgdump"]);
  if (!Array.isArray(missing) || new Set(missing).size !== missing.length ||
      missing.some(name => typeof name !== "string" || !safeRelative(name) || !manifest.requiredReferences.includes(name)) ||
      (partial && (manifest.recoveryCoverage !== "partial" || main.recoveryCoverage !== "partial" ||
        main.missingFileCount !== missing.length ||
        main.archiveKind !== `partial-${manifest.sourceEnvironment}`)) ||
      (!partial && (manifest.recoveryCoverage === "partial" || main.recoveryCoverage === "partial" ||
        String(main.archiveKind).startsWith("partial-")))) {
    throw new Error("Invalid partial recovery coverage declaration.");
  }
  if (partial) {
    const inventory = zip.getEntry("missing-files.json");
    if (!inventory) throw new Error("Partial backup missing-file inventory is absent.");
    const declared = JSON.parse(inventory.getData().toString("utf8"));
    if (declared.version !== 1 || declared.missingFileCount !== missing.length ||
        JSON.stringify(declared.missingReferences) !== JSON.stringify(missing)) {
      throw new Error("Partial backup missing-file inventory disagrees with recovery evidence.");
    }
    expected.add("missing-files.json");
  }
  const references = new Set<string>();
  for (const file of manifest.files) {
    if (!safeRelative(file.relativeName) || !safeRelative(file.archivePath) ||
        !["media", "private-objects", "local-uploads", "local-state"].includes(file.archivePath.split("/")[0]!) ||
        file.archivePath.slice(file.archivePath.indexOf("/") + 1) !== file.relativeName ||
        expected.has(file.archivePath)) throw new Error("Unsafe or duplicate recovery file mapping.");
    expected.add(file.archivePath);
    const source = zip.getEntry(file.archivePath);
    if (!source || source.header.size !== file.size ||
        (source.sha256 ?? createHash("sha256").update(source.getData()).digest("hex")) !== file.sha256) {
      throw new Error(`Recovery file integrity check failed in ${file.archivePath.split("/")[0]}.`);
    }
    references.add(file.archivePath.startsWith("media/") ? `case-media/${file.relativeName}` : file.relativeName);
  }
  if (entries.some(item => !expected.has(item.entryName)) ||
      missing.some(name => references.has(name)) ||
      manifest.requiredReferences.some(name => !references.has(name) && !missing.includes(name))) throw new Error("Incomplete recovery file coverage.");
  if (manifest.releaseIdentity) {
    const identity = parseDesktopReleaseIdentity(JSON.stringify(manifest.releaseIdentity));
    if (!manifest.sourceRevision) {
      throw new Error("Recovery manifest has a release identity without its source revision.");
    }
    const sidecar = zip.getEntry(`private-objects/${DESKTOP_RELEASE_IDENTITY_PATH}`);
    if (!sidecar) throw new Error("Recovery archive is missing the Desktop release identity sidecar.");
    assertDesktopReleaseIdentityMatchesFiles(
      identity, manifest.sourceRevision, manifest.files, sidecar.getData(), missing,
    );
  }
  return manifest;
}

export async function restoreLocalRecoveryEntry(
  entry: Parameters<typeof writeRecoveryEntry>[0], target: string, canonicalKey: string,
): Promise<void> {
  if (canonicalKey.includes("\\") || canonicalKey.includes("\0") ||
      canonicalKey.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Unsafe recovery media key.");
  }
  let parent = path.dirname(path.resolve(target));
  for (;;) {
    const stat = await fs.lstat(parent).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error("Recovery destination contains a symbolic link.");
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const scratch = path.join(path.dirname(target), `.labtrax-media-write-${randomUUID()}`);
  try {
    await writeRecoveryEntry(entry, scratch);
    await copyProductionUpload(scratch, target, "private-recovery", canonicalKey);
  } finally { await fs.unlink(scratch).catch(() => undefined); }
}

export async function restoreCompleteFiles(
  zip: RecoveryZip, manifest: CompleteRecoveryManifest, uploadsRoot: string,
  layout: { caseMediaRoot?: string } = {},
) {
  const caseMediaRoot = path.resolve(layout.caseMediaRoot ?? path.join(uploadsRoot, "case-media"));
  const restored = await collectMediaMutationReceipts(async () => {
  let preservedExistingFiles = 0;
  for (const file of manifest.files) {
    const entry = zip.getEntry(file.archivePath)!;
    const namespace = file.archivePath.split("/")[0];
    if (namespace === "private-objects" || (namespace === "media" && file.generation)) {
      const key = namespace === "media" ? `case-media/${file.relativeName}` : file.relativeName;
      if (manifest.recoveryCoverage === "partial" && await openPrivateBackupObject(key)) {
        preservedExistingFiles++;
        continue;
      }
      if (namespace === "media") {
        // Keep the established local case-media mirror, but write it through
        // the same receipt/version boundary rather than the legacy raw loop.
        const target = path.resolve(caseMediaRoot, file.relativeName);
        const local = await fs.lstat(target).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (local && manifest.recoveryCoverage === "partial") {
          preservedExistingFiles++;
          continue;
        }
        // Cloud is finalized last: its generation is authoritative when both
        // storage planes provide the same logical case-media key.
        await restoreLocalRecoveryEntry(entry, target, key);
      }
      if (entry.stream) await restorePrivateBackupObjectStream(key, entry.stream(), file.metadata ?? {});
      else await restorePrivateBackupObject(key, entry.getData(), file.metadata ?? {});
    } else {
      const root = namespace === "local-state" ? path.resolve(process.cwd(), "server", ".data")
        : namespace === "media" ? caseMediaRoot : uploadsRoot;
      const relative = file.relativeName;
      const target = path.resolve(root, relative);
      // Refuse symlink ancestors, even though archive paths have been checked.
      let parent = path.dirname(target);
      while (parent.startsWith(path.resolve(root))) {
        const stat = await fs.lstat(parent).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error("Recovery destination contains a symbolic link.");
        if (parent === path.resolve(root)) break;
        parent = path.dirname(parent);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stat = await fs.lstat(target).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error("Recovery destination is a symbolic link.");
      if (stat && manifest.recoveryCoverage === "partial") {
        preservedExistingFiles++;
        continue;
      }
      const canonicalKey = namespace === "media" ? `case-media/${file.relativeName}`
        : namespace === "local-state" ? `local-state/${file.relativeName}` : `local-uploads/${file.relativeName}`;
      await restoreLocalRecoveryEntry(entry, target, canonicalKey);
    }
  }
  return { preservedExistingFiles };
  });
  return { ...restored.value, mediaWriteReceiptIds: restored.ids };
}
