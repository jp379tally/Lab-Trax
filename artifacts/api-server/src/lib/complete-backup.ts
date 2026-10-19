import { pool } from "@workspace/db";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { listPrivateBackupObjects, restorePrivateBackupObject, restorePrivateBackupObjectStream } from "./case-media-object-storage";
import { writeRecoveryEntry, type RecoveryZip } from "./recovery-zip";
import {
  DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY,
  planBackupMedia,
  type BackupFileEvidence,
  type BackupMediaAppender,
} from "./backup-media-producer";
import { extractMediaFilenamesFromText } from "./case-media";
import { isProductionDeployment } from "./onedrive";
import { promises as fs } from "node:fs";
import { verifyProductionBackupSource } from "./backup-production-source";
import { measureBackupPhase, setBackupLiveProgress } from "./backup-phase";

export const COMPLETE_BACKUP_VERSION = 1;
export const COMPLETE_PRODUCTION_KIND = "complete-production";
export const COMPLETE_DEVELOPMENT_KIND = "complete-non-production";
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
export function requireCompleteBackupCapacity(
  availableBytes: number, durableBytes: number, stagedBytes: number, dumpBytes: number,
  archiveDestination: CompleteArchiveDestination = "local",
): void {
  if (![availableBytes, durableBytes, stagedBytes, dumpBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Complete backup capacity inventory is invalid; no files were omitted.");
  }
  const archiveBytes = archiveDestination === "local" ? Math.ceil(durableBytes * 1.03) : 0;
  const requiredBytes = archiveBytes + stagedBytes + dumpBytes + COMPLETE_BACKUP_TEMP_HEADROOM_BYTES;
  if (requiredBytes > availableBytes) {
    throw new Error(`Complete backup capacity failure: ${requiredBytes} bytes of temporary capacity are required, ` +
      `${availableBytes} bytes are available. Provide capacity for the full recovery inventory; no files were omitted.`);
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
  const maxCandidates = Math.min(
    DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY,
    Math.max(1, sizes.length),
  );
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
  const requiredBytes = Math.ceil(durableBytes * 1.03) + dumpBytes + 512 * 1024 * 1024;
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
}

/**
 * Capacity planning must match the objects that the archive appenders include.
 * Root-level backup/history directories are deliberately excluded from the
 * private-objects archive and must not force unrelated temp-space reservations.
 * Case media is handled by its own complete inventory, including nested paths.
 */
export function includedBackupStagingObjectSizes(objects: readonly BackupStagingObject[]): number[] {
  return objects
    .filter(object => object.relativeName.startsWith("case-media/") || !excluded(object.relativeName))
    .map(object => object.size);
}

export interface CompleteRecoveryManifest {
  coverageVersion: number;
  sourceEnvironment: "production" | "non-production";
  sourceDatabase: string;
  sourceIdentitySha256: string;
  storageNamespaceSha256: string | null;
  provenance: { productionLineageVerified: boolean; fingerprintSha256: string | null };
  snapshotAt: string;
  snapshot: string;
  databaseSha256: string;
  tables: Array<{ schema: string; name: string; rows: number }>;
  files: BackupFileEvidence[];
  requiredReferences: string[];
  exclusions: string[];
}

/** Resolve only server-owned storage identities, never arbitrary remote URLs. */
export function recoveryReferences(table: string, row: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  if (row.deleted_at || ["scan_output_garbage", "support_report_attachment_garbage"].includes(table)) return refs;
  const add = (prefix: string, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    if (/^(data:|https?:)/.test(value) && !value.includes("/uploads/")) return;
    const name = value.replace(/^.*\/uploads\//, "").replace(/^\/+/, "");
    refs.add(/^(case-media|profile-photos|support-reports|lab-logos|invoice-template-images|case-print-template-images|legacy-case-data-backups|desktop-installer|recovery-archives)\//.test(name)
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
    if (table === "provider_messenger_messages" && column === "media_key") add("case-media", value);
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
    for (const match of raw.matchAll(/(?:invoice-template-images|case-print-template-images|legacy-case-data-backups|lab-logos|desktop-installer|recovery-archives)\/[A-Za-z0-9._/-]+/g)) {
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
export async function captureCompleteBackup(
  uploadsRoot: string,
  dump: (snapshot: string) => Promise<Buffer>,
  signal?: AbortSignal,
  options: { archiveDestination?: CompleteArchiveDestination } = {},
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const boundary = (await client.query<{ snapshot: string; at: string; database: string }>(
      "SELECT pg_export_snapshot() AS snapshot, transaction_timestamp()::text AS at, current_database() AS database",
    )).rows[0]!;
    let fingerprintSha256: string | null = null;
    if (isProductionDeployment()) {
      fingerprintSha256 = await verifyProductionBackupSource(client);
    }
    let tablesCompleted = 0;
    let tableCount = 0;
    let rowsScanned = 0;
    const { tables, references } = await measureBackupPhase(
      "case-media inventory and reference validation",
      async () => {
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
              // Ten-row FETCHes required one database round trip per ten rows.
              // Sixty-four rows amortize that latency without allowing a
              // large page of variable-size case JSON to dominate memory.
              const batch = await client.query<{ row: Record<string, unknown> }>("FETCH 64 FROM recovery_rows");
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
        return { tables: scannedTables, references: foundReferences };
      },
      () => ({ tablesCompleted, tableCount, rowsScanned }),
    );
    const activeCounts = (await client.query<{ users: string; organizations: string; cases: string }>(`
      SELECT (SELECT count(*) FROM public.users WHERE deleted_at IS NULL)::text AS users,
        (SELECT count(*) FROM public.organizations WHERE deleted_at IS NULL)::text AS organizations,
        (SELECT count(*) FROM public.cases WHERE deleted_at IS NULL)::text AS cases
    `)).rows[0]!;
    const pgDump = await dump(boundary.snapshot);
    const objects = process.env.PRIVATE_OBJECT_DIR
      ? await listPrivateBackupObjects("", signal)
      : [];
    const files: BackupFileEvidence[] = [];
    const onFile = (file: BackupFileEvidence) => files.push(file);
    // Sizing, capacity, reference and snapshot-time checks fail against a
    // named phase, so history records where a refused capture stopped.
    const { media, local, privateFiles, legacyState, durableBytes, stagedBytes, maxConcurrentFiles } = await measureBackupPhase(
      "case-media inventory and reference validation",
      async () => {
        if (isProductionDeployment() && !process.env.PRIVATE_OBJECT_DIR) {
          throw new Error("Complete production backup requires access to private App Storage.");
        }
        const media = await planBackupMedia(path.join(uploadsRoot, "case-media"),
          objects.filter(object => object.relativeName.startsWith("case-media/")).map(object => ({
            ...object, relativeName: object.relativeName.slice("case-media/".length),
          })), signal, { onFile });
        const local = await planBackupMedia(uploadsRoot, [], signal, {
          archivePrefix: "local-uploads", onFile,
          exclude: name => excluded(name) || name === "case-media" || name.startsWith("case-media/"),
        });
        const privateFiles = await planBackupMedia(path.join(uploadsRoot, ".absent-private-inventory"), objects.filter(object =>
          !object.relativeName.startsWith("case-media/") && !excluded(object.relativeName)), signal, {
          archivePrefix: "private-objects", onFile,
        });
        const legacyState = await planBackupMedia(path.resolve(process.cwd(), "server", ".data"), [], signal, {
          archivePrefix: "local-state", onFile, exclude: name => name !== "legacy-chat.json",
        });
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
          pgDump.length,
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
        if (missing.length) throw new Error(
          `Complete backup aborted: ${missing.length} required file references have no readable recovery source. ` +
          `Missing classes: ${[...new Set(missing.map(name => name.split("/")[0]))].join(", ")}. Check storage access and recover the missing originals.`,
        );
        const snapshotMs = Date.parse(boundary.at);
        const objectByName = new Map(objects.map(item => [item.relativeName, item]));
        for (const reference of references) {
          const object = objectByName.get(reference);
          if (object) {
            if (!object.modifiedAt || !Number.isFinite(Date.parse(object.modifiedAt)) ||
                Date.parse(object.modifiedAt) > snapshotMs) {
              throw new Error("A referenced private object was replaced after the database snapshot, or its modification time is unverified. Retry a complete backup.");
            }
          } else {
            const stat = await fs.lstat(path.resolve(uploadsRoot, reference));
            if (stat.mtimeMs > snapshotMs || stat.ctimeMs > snapshotMs) {
              throw new Error("A referenced local file changed after the database snapshot. Retry a complete backup.");
            }
          }
        }
        return { media, local, privateFiles, legacyState, durableBytes, stagedBytes, maxConcurrentFiles };
      },
    );
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    const manifest: CompleteRecoveryManifest = {
      coverageVersion: COMPLETE_BACKUP_VERSION,
      sourceEnvironment: isProductionDeployment() ? "production" : "non-production",
      sourceDatabase: boundary.database,
      sourceIdentitySha256: createHash("sha256").update(`${databaseUrl.hostname}:${databaseUrl.port}/${boundary.database}`).digest("hex"),
      storageNamespaceSha256: process.env.PRIVATE_OBJECT_DIR
        ? createHash("sha256").update(process.env.PRIVATE_OBJECT_DIR.trim().replace(/^\/+|\/+$/g, "")).digest("hex") : null,
      provenance: { productionLineageVerified: isProductionDeployment(), fingerprintSha256 },
      snapshotAt: new Date(boundary.at).toISOString(),
      snapshot: boundary.snapshot,
      databaseSha256: createHash("sha256").update(pgDump).digest("hex"),
      tables, files,
      requiredReferences: [...references].sort(),
      exclusions: ["generated backup directories", "upload sessions", "internal restore snapshots", "transient caches", "source code and secrets"],
    };
    // No database write after this boundary can change this archive's rows.
    await client.query("COMMIT");
    const append: BackupMediaAppender = async archive => {
      await media.append(archive, maxConcurrentFiles);
      await local.append(archive, maxConcurrentFiles);
      await privateFiles.append(archive, maxConcurrentFiles);
      await legacyState.append(archive, maxConcurrentFiles);
      manifest.files.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
      archive.append(JSON.stringify(manifest), { name: "complete-recovery.json" });
    };
    const count = (name: string) => tables.find(table => table.schema === "public" && table.name === name)?.rows ?? 0;
    return {
      pgDump, append, manifest,
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
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
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
    if (main.coverageVersion) throw new Error("Complete backup evidence is missing.");
    return null;
  }
  const manifest = JSON.parse(entry.getData().toString("utf8")) as CompleteRecoveryManifest;
  if (manifest.coverageVersion !== COMPLETE_BACKUP_VERSION || main.coverageVersion !== COMPLETE_BACKUP_VERSION ||
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
  const entries = zip.getEntries().filter(item => !item.isDirectory);
  if (new Set(entries.map(item => item.entryName)).size !== entries.length) throw new Error("Duplicate archive entries.");
  const dump = zip.getEntry("db/database.pgdump");
  if (!dump || (dump.sha256 ?? createHash("sha256").update(dump.getData()).digest("hex")) !== manifest.databaseSha256) {
    throw new Error("Database dump integrity check failed.");
  }
  const expected = new Set(["manifest.json", "complete-recovery.json", "db/database.pgdump"]);
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
      manifest.requiredReferences.some(name => !references.has(name))) throw new Error("Incomplete recovery file coverage.");
  return manifest;
}

export async function restoreCompleteFiles(
  zip: RecoveryZip, manifest: CompleteRecoveryManifest, uploadsRoot: string,
) {
  for (const file of manifest.files) {
    const entry = zip.getEntry(file.archivePath)!;
    const namespace = file.archivePath.split("/")[0];
    if (namespace === "private-objects" || (namespace === "media" && file.generation)) {
      const key = namespace === "media" ? `case-media/${file.relativeName}` : file.relativeName;
      if (entry.stream) await restorePrivateBackupObjectStream(key, entry.stream(), file.metadata ?? {});
      else await restorePrivateBackupObject(key, entry.getData(), file.metadata ?? {});
    } else {
      const root = namespace === "local-state" ? path.resolve(process.cwd(), "server", ".data") : uploadsRoot;
      const relative = namespace === "media" ? `case-media/${file.relativeName}` : file.relativeName;
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
      await writeRecoveryEntry(entry, target);
    }
  }
}
