/**
 * Off-site round trip — the gate that proves OneDrive protection is real.
 *
 * A "success" row in backup_runs proved nothing: the lab's history was full of
 * them while the newest usable archive in OneDrive was eighteen days old and
 * the recent entries were 12,345-byte placeholders. This test refuses to take
 * the database's word for anything. It builds a real archive, uploads it to
 * OneDrive, reads the stored item back through Microsoft Graph, downloads the
 * bytes again, and restores them into the disposable database this gate runs
 * against.
 *
 * Runs inside scripts/run-isolated-backup-restore.sh, which points
 * DATABASE_URL at a throwaway schema-only PostgreSQL instance — the restore is
 * DB-wide and destructive, so it must never see the shared development
 * database.
 *
 * Uploads go to a verification subfolder under the non-production folder and
 * are deleted afterwards, so this never adds to (or prunes) the lab's real
 * backups.
 *
 * Live tests are visibly skipped when OneDrive is unavailable; hermetic
 * archive and restore tests remain runnable offline.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import { Storage } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, users } from "@workspace/db";
import { getBackupStagingLocation } from "../lib/case-media-object-storage.js";
import {
  deleteCaseMediaFromObjectStorage,
  listCaseMediaBackupObjects,
  listPrivateBackupObjects,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage.js";
import { createBackupCloudStage, MAX_BACKUP_RANGE_BYTES } from "../lib/backup-cloud-staging.js";
import {
  ONEDRIVE_NON_PRODUCTION_FOLDER,
  deleteOneDriveBackupFile,
  downloadFileFromOneDrive,
  getOneDriveFileByName,
  getOneDriveStatus,
  isOneDriveConnectorAvailable,
  listOneDriveBackupFiles,
} from "../lib/onedrive.js";
import {
  decryptBuffer,
  executeRestore,
  runOneDriveBackup,
} from "../lib/backup.js";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation.js";

/** Each run owns a unique folder beneath the non-production backups area. */
const VERIFICATION_FOLDER_ROOT = `${ONEDRIVE_NON_PRODUCTION_FOLDER}/gate-verification`;

const liveProbe = vi.hoisted(() => ({
  verificationFolder: null as string | null,
  cloudReadChunks: [] as Array<{ offset: number; bytes: Buffer }>,
}));

// Keep real GCS and Graph operations, but make the destination explicitly a
// per-run non-production folder and prevent retention listing or pruning. The
// observer records actual GCS range bytes for digest comparison.
vi.mock("../lib/onedrive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/onedrive.js")>();
  return {
    ...actual,
    getOneDriveBackupFolder: () =>
      liveProbe.verificationFolder ?? actual.getOneDriveBackupFolder(),
    uploadBackupSourceToOneDrive: (
      source: Parameters<typeof actual.uploadBackupSourceToOneDrive>[0],
      fileName: string,
      options: Parameters<typeof actual.uploadBackupSourceToOneDrive>[2] = {},
    ) => actual.uploadBackupSourceToOneDrive(source, fileName, {
      ...options,
      folder: liveProbe.verificationFolder ?? actual.getOneDriveBackupFolder(),
    }),
    pruneOneDriveBackups: vi.fn(async () => []),
  };
});

vi.mock("../lib/backup-cloud-staging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backup-cloud-staging.js")>();
  return {
    ...actual,
    createBackupCloudStage: async (...args: Parameters<typeof actual.createBackupCloudStage>) => {
      const stage = await actual.createBackupCloudStage(...args);
      const readChunk = stage.readChunk.bind(stage);
      return {
        ...stage,
        async readChunk(offset: number, length: number) {
          const bytes = await readChunk(offset, length);
          liveProbe.cloudReadChunks.push({ offset, bytes: Buffer.from(bytes) });
          return bytes;
        },
      };
    },
  };
});

let skipReason = "";
let verificationFolder: string | null = null;
let uploadedFileName: string | null = null;
let verifiedRemoteItemId: string | null = null;
// Cleanup is limited to exact item IDs returned by this run's test upload; the
// regular backup folders are never listed, pruned, or deleted.
const uploadedFileIds: string[] = [];
let restoreObjectDir: string | null = null;
let sourceObjectDir: string | null = null;
let sourceMediaName: string | null = null;
let sourceMediaBytes: Buffer | null = null;
const sourceMediaNames = new Set<string>();
const restoredMediaNames = new Set<string>();
const sourcePrivateObjectNames = new Set<string>();
const restoredPrivateObjectNames = new Set<string>();
let initialPrivateObjectDir: string | undefined;
let stagingBucket: ReturnType<typeof getBackupStagingLocation>["bucket"] | null = null;
let stagingPrefix: string | null = null;
let initialStagingNames = new Set<string>();

const sidecarCredentials: ExternalAccountClientOptions = {
  audience: "replit",
  subject_token_type: "access_token",
  token_url: "http://127.0.0.1:1106/token",
  type: "external_account",
  credential_source: {
    url: "http://127.0.0.1:1106/credential",
    format: { type: "json", subject_token_field_name: "access_token" },
  },
  universe_domain: "googleapis.com",
};
const testObjectStorage = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? new Storage()
  : new Storage({ credentials: sidecarCredentials, projectId: "" });

function privateObjectFile(privateObjectDir: string, relativeName: string) {
  const root = privateObjectDir.trim().replace(/^\/+|\/+$/g, "");
  const slash = root.indexOf("/");
  if (slash < 1 || slash === root.length - 1 ||
      !relativeName || relativeName.includes("\\") || relativeName.includes("\0") ||
      path.posix.isAbsolute(relativeName) ||
      relativeName.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Synthetic private object path is invalid.");
  }
  const bucketName = root.slice(0, slash);
  const objectRoot = root.slice(slash + 1);
  return testObjectStorage.bucket(bucketName).file(`${objectRoot}/${relativeName}`);
}

async function writeSyntheticPrivateObject(
  privateObjectDir: string,
  relativeName: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  sourcePrivateObjectNames.add(relativeName);
  await privateObjectFile(privateObjectDir, relativeName).save(bytes, {
    resumable: false,
    contentType,
  });
}

async function deleteExactPrivateObject(privateObjectDir: string, relativeName: string): Promise<void> {
  await privateObjectFile(privateObjectDir, relativeName).delete({ ignoreNotFound: true });
}

function siblingPrivateObjectDir(base: string, label: string): string {
  const normalized = base.replace(/^\/+|\/+$/g, "");
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error("The isolated restore object directory must include a private bucket prefix.");
  }
  const bucket = normalized.slice(0, slash);
  const objectRoot = normalized.slice(slash + 1);
  const parent = path.posix.dirname(objectRoot);
  const name = `${path.posix.basename(objectRoot)}-${label}-${randomUUID()}`;
  return `/${bucket}/${path.posix.join(parent, name)}`;
}

function skipIfUnavailable(skip: (reason?: string) => never): void {
  if (!skipReason) return;
  console.warn(`[offsite-gate] OneDrive round trip SKIPPED — ${skipReason}`);
  skip(skipReason);
}

async function getStagingNames(): Promise<Set<string>> {
  if (!stagingBucket || !stagingPrefix) throw new Error("The isolated GCS staging namespace is not ready.");
  const [files] = await stagingBucket.getFiles({ prefix: `${stagingPrefix}/` });
  return new Set(files.map((file) => file.name));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The archive builder refuses to run when the database has attachment rows but
 * the media folder is empty, and the restore refuses to finish with no users.
 * Give the disposable database the minimum that makes a real archive real.
 */
async function seedRestorableState(): Promise<Record<string, { size: number; sha256: string }>> {
  const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const expectedFiles: Record<string, { size: number; sha256: string }> = {};
  const probe = Buffer.from("offsite gate media probe\n");
  fs.writeFileSync(path.join(mediaDir, "offsite-gate-probe.txt"), probe);
  expectedFiles["offsite-gate-probe.txt"] = {
    size: probe.length,
    sha256: createHash("sha256").update(probe).digest("hex"),
  };
  // Exercise large-media restore with synthetic bytes, then use an additional
  // incompressible fixture below to force multi-range cloud transfer.
  const chunk = randomBytes(1024 * 1024);
  const largeMediaHash = createHash("sha256");
  const target = fs.openSync(path.join(mediaDir, "offsite-gate-large-media.bin"), "w");
  try {
    for (let index = 0; index < 96; index++) {
      fs.writeSync(target, chunk);
      largeMediaHash.update(chunk);
    }
  } finally { fs.closeSync(target); }
  expectedFiles["offsite-gate-large-media.bin"] = {
    size: 96 * chunk.length,
    sha256: largeMediaHash.digest("hex"),
  };
  // Unlike the repeated 96 MiB fixture above, these bytes are incompressible.
  // They force multiple real GCS and Graph upload ranges in the live test.
  const incompressibleMedia = randomBytes(12 * 1024 * 1024);
  fs.writeFileSync(
    path.join(mediaDir, "offsite-gate-incompressible-media.bin"),
    incompressibleMedia,
  );
  expectedFiles["offsite-gate-incompressible-media.bin"] = {
    size: incompressibleMedia.length,
    sha256: createHash("sha256").update(incompressibleMedia).digest("hex"),
  };

  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length === 0) {
    const suffix = Date.now().toString(36);
    await db.insert(users).values({
      username: `offsite_gate_${suffix}`,
      password: "x",
      email: `offsite_gate_${suffix}@example.test`,
      role: "admin",
      userType: "lab",
    });
  }
  return expectedFiles;
}

describe("off-site backup round trip (OneDrive → restore)", () => {
  beforeAll(async () => {
    // Before anything touches the database or the uploads directory: this
    // suite restores DB-wide and writes media, so outside the isolated runner
    // it would replace the shared development database. Throwing here is the
    // point — a skip would let the damage happen silently on the next edit.
    requireIsolatedRestoreTest();
    initialPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
    if (!process.env["DATABASE_URL"]) {
      skipReason = "DATABASE_URL is not set";
      return;
    }
    if (process.env["REPLIT_DEPLOYMENT"] === "1") {
      throw new Error("The live cloud staging test refuses to run in a production deployment.");
    }
    if (!process.env.PRIVATE_OBJECT_DIR || !process.env.LABTRAX_RESTORE_OBJECT_DIR) {
      skipReason = "an explicit isolated private object destination is not configured";
      return;
    }
    if (!isOneDriveConnectorAvailable()) {
      skipReason = "the OneDrive connector is not available in this environment";
      return;
    }
    const status = await getOneDriveStatus();
    if (!status.connected) {
      skipReason = status.error ?? "OneDrive is not connected";
      return;
    }

    restoreObjectDir = process.env.LABTRAX_RESTORE_OBJECT_DIR;
    verificationFolder = `${VERIFICATION_FOLDER_ROOT}/${randomUUID()}`;
    liveProbe.verificationFolder = verificationFolder;
    sourceObjectDir = siblingPrivateObjectDir(restoreObjectDir, "task5171-source");
    if (sourceObjectDir === restoreObjectDir ||
        sourceObjectDir.startsWith(`${restoreObjectDir.replace(/\/+$/, "")}/`) ||
        restoreObjectDir.startsWith(`${sourceObjectDir.replace(/\/+$/, "")}/`)) {
      throw new Error("The synthetic GCS source and restore namespaces must not overlap.");
    }
    process.env.PRIVATE_OBJECT_DIR = sourceObjectDir;
    const location = getBackupStagingLocation("non-production");
    stagingBucket = location.bucket;
    stagingPrefix = location.prefix;
    initialStagingNames = await getStagingNames();
  }, 60_000);

  afterAll(async () => {
    const deletionFailures: string[] = [];
    for (const id of uploadedFileIds) {
      try {
        await deleteOneDriveBackupFile(id);
      } catch {
        deletionFailures.push(id);
      }
    }
    if (sourceObjectDir) {
      process.env.PRIVATE_OBJECT_DIR = sourceObjectDir;
      for (const name of sourceMediaNames) {
        try {
          await deleteCaseMediaFromObjectStorage(name);
        } catch {
          deletionFailures.push("synthetic GCS source media");
        }
      }
    }
    if (sourceObjectDir) {
      for (const name of sourcePrivateObjectNames) {
        try {
          await deleteExactPrivateObject(sourceObjectDir, name);
        } catch {
          deletionFailures.push(`synthetic GCS source object ${name}`);
        }
      }
    }
    if (restoreObjectDir) {
      for (const name of restoredMediaNames) {
        process.env.PRIVATE_OBJECT_DIR = restoreObjectDir;
        try {
          await deleteCaseMediaFromObjectStorage(name);
        } catch {
          deletionFailures.push("synthetic GCS restored media");
        }
      }
      for (const name of restoredPrivateObjectNames) {
        try {
          await deleteExactPrivateObject(restoreObjectDir, name);
        } catch {
          deletionFailures.push(`synthetic GCS restored object ${name}`);
        }
      }
    }
    if (initialPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = initialPrivateObjectDir;
    if (skipReason) {
      // Keep a clear gate-level message in addition to Vitest's skipped status.
      console.warn(`[offsite-gate] OneDrive round trip SKIPPED — ${skipReason}`);
    }
    if (deletionFailures.length > 0) {
      throw new Error(
        `Could not remove ${deletionFailures.length} temporary OneDrive verification file(s): ` +
        deletionFailures.join(", "),
      );
    }
  }, 120_000);

  it(
    "stages a synthetic encrypted archive through real GCS and OneDrive, then restores it",
    { timeout: 900_000 },
    async ({ skip }) => {
      skipIfUnavailable(skip);
      const expectedRestoredFiles = await seedRestorableState();

      if (!restoreObjectDir || !sourceObjectDir || !stagingBucket || !stagingPrefix || !verificationFolder) {
        throw new Error("The isolated GCS and restore namespaces were not initialized.");
      }

      sourceMediaName = `task5171-${randomUUID()}.bin`;
      sourceMediaNames.add(sourceMediaName);
      sourceMediaBytes = randomBytes(128 * 1024);
      await writeCaseMediaToObjectStorage(sourceMediaName, sourceMediaBytes, "application/octet-stream");

      const profilePhotoName = `task5200-${randomUUID()}.jpg`;
      const profilePhotoRelativeName = `profile-photos/${profilePhotoName}`;
      const profilePhotoBytes = randomBytes(48 * 1024);
      const supportAttachmentName = `task5200-${randomUUID()}.bin`;
      const supportAttachmentRelativeName = `support-reports/${supportAttachmentName}`;
      const supportAttachmentBytes = randomBytes(72 * 1024);
      await writeSyntheticPrivateObject(
        sourceObjectDir,
        profilePhotoRelativeName,
        profilePhotoBytes,
        "image/jpeg",
      );
      await writeSyntheticPrivateObject(
        sourceObjectDir,
        supportAttachmentRelativeName,
        supportAttachmentBytes,
        "application/octet-stream",
      );

      // Exercise the real GCS inventory and generation-pinned media reader
      // against the one synthetic object in this fresh source namespace.
      const mediaInventory = await listCaseMediaBackupObjects();
      expect(mediaInventory).toHaveLength(1);
      expect(mediaInventory[0]!.relativeName).toBe(sourceMediaName);
      expect(mediaInventory[0]!.generation).toBeTruthy();
      const copiedMediaPath = path.join(os.tmpdir(), `task5171-source-${randomUUID()}.bin`);
      try {
        await mediaInventory[0]!.copyTo(copiedMediaPath);
        expect(fs.readFileSync(copiedMediaPath).equals(sourceMediaBytes)).toBe(true);
      } finally {
        fs.rmSync(copiedMediaPath, { force: true });
      }

      // runOneDriveBackup exercises the real complete-backup capture, GCS
      // resumable CRC-checked stage, bounded pinned reads, Graph upload
      // session, and independent metadata verification. Retention is the
      // only mocked action and is deliberately disabled for this proof.
      liveProbe.cloudReadChunks = [];
      const backup = await runOneDriveBackup("gate:cloud-staged-roundtrip");
      expect(backup.destination).toBe("onedrive");
      expect(backup.archiveKind).not.toBe("database-only");
      expect(backup.remoteItemId).toBeTruthy();
      expect(backup.size).toBeGreaterThan(8 * 1024 * 1024);
      const remoteItemId = backup.remoteItemId;
      if (!remoteItemId) throw new Error("OneDrive did not return the synthetic item's identity.");
      uploadedFileIds.push(remoteItemId);
      uploadedFileName = backup.fileName;
      verifiedRemoteItemId = remoteItemId;

      const orderedCloudChunks = [...liveProbe.cloudReadChunks].sort((a, b) => a.offset - b.offset);
      expect(orderedCloudChunks.length).toBeGreaterThan(1);
      let nextOffset = 0;
      const stagedDigest = createHash("sha256");
      for (const { offset, bytes } of orderedCloudChunks) {
        expect(offset).toBe(nextOffset);
        expect(bytes.length).toBeLessThanOrEqual(MAX_BACKUP_RANGE_BYTES);
        stagedDigest.update(bytes);
        nextOffset += bytes.length;
      }
      expect(nextOffset).toBe(backup.size);
      const stagedArchiveSha256 = stagedDigest.digest("hex");

      // Re-fetch the exact item through Graph, then download and compare the
      // encrypted bytes with the GCS ranges sent to the upload session.
      const stored = await getOneDriveFileByName(
        backup.fileName,
        verificationFolder,
        remoteItemId,
      );
      expect(stored).not.toBeNull();
      expect(stored!.id).toBe(remoteItemId);
      expect(stored!.name).toBe(backup.fileName);
      expect(stored!.size).toBe(backup.size);
      const downloadStream = await downloadFileFromOneDrive(
        backup.fileName,
        backup.size,
        verificationFolder,
        remoteItemId,
      );
      const downloadChunks: Buffer[] = [];
      for await (const chunk of downloadStream) downloadChunks.push(Buffer.from(chunk));
      const downloaded = Buffer.concat(downloadChunks);
      expect(downloaded.length).toBe(backup.size);
      expect(createHash("sha256").update(downloaded).digest("hex")).toBe(stagedArchiveSha256);

      // Inspect the exact bytes downloaded back from Graph. Each private-object
      // category must retain its archive identity, declared size and payload.
      const downloadedArchive = new AdmZip(decryptBuffer(downloaded));
      const completeManifest = JSON.parse(
        downloadedArchive.readAsText("complete-recovery.json"),
      ) as {
        files: Array<{ archivePath: string; relativeName: string; size: number; sha256: string }>;
      };
      const privateFixtures = [
        {
          relativeName: profilePhotoRelativeName,
          bytes: profilePhotoBytes,
        },
        {
          relativeName: supportAttachmentRelativeName,
          bytes: supportAttachmentBytes,
        },
      ];
      for (const fixture of privateFixtures) {
        const archivePath = `private-objects/${fixture.relativeName}`;
        const evidence = completeManifest.files.find(file => file.archivePath === archivePath);
        expect(evidence, `${archivePath} archive evidence`).toMatchObject({
          archivePath,
          relativeName: fixture.relativeName,
          size: fixture.bytes.length,
          sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
        });
        const entry = downloadedArchive.getEntry(archivePath);
        expect(entry, `${archivePath} archive entry`).not.toBeNull();
        expect(entry!.header.size, `${archivePath} archive size`).toBe(fixture.bytes.length);
        expect(entry!.getData(), `${archivePath} archive bytes`).toEqual(fixture.bytes);
      }

      // The complete archive contains the synthetic GCS source objects.
      // Restore the downloaded Graph bytes only into the runner's local
      // disposable database and a different fresh private-object namespace.
      restoredPrivateObjectNames.add(profilePhotoRelativeName);
      restoredPrivateObjectNames.add(supportAttachmentRelativeName);
      restoredMediaNames.add(sourceMediaName);
      process.env.PRIVATE_OBJECT_DIR = restoreObjectDir;
      const restored = await executeRestore(downloaded, "gate:cloud-staged-roundtrip");
      expect(restored.manifest.appName).toBe("LabTrax");
      expect(restored.manifest.sourceEnvironment).not.toBe("production");
      for (const [fileName, expected] of Object.entries(expectedRestoredFiles)) {
        const restoredFilePath = path.resolve(process.cwd(), "uploads", "case-media", fileName);
        expect(fs.statSync(restoredFilePath).size, `${fileName} restored size`).toBe(expected.size);
        expect(await sha256File(restoredFilePath), `${fileName} restored contents`).toBe(expected.sha256);
      }
      const restoredMedia = await listCaseMediaBackupObjects();
      const restoredFixture = restoredMedia.find((file) => file.relativeName === sourceMediaName);
      expect(restoredFixture?.generation).toBeTruthy();
      const restoredPath = path.join(os.tmpdir(), `task5171-restored-${randomUUID()}.bin`);
      try {
        await restoredFixture!.copyTo(restoredPath);
        expect(fs.readFileSync(restoredPath).equals(sourceMediaBytes)).toBe(true);
      } finally {
        fs.rmSync(restoredPath, { force: true });
      }
      const restoredPrivateObjects = await listPrivateBackupObjects();
      for (const fixture of privateFixtures) {
        const restoredObject = restoredPrivateObjects.find(
          object => object.relativeName === fixture.relativeName,
        );
        expect(restoredObject, `${fixture.relativeName} restored object`).toBeTruthy();
        expect(restoredObject!.size, `${fixture.relativeName} restored size`).toBe(fixture.bytes.length);
        const restoredPath = path.join(os.tmpdir(), `task5200-restored-${randomUUID()}.bin`);
        try {
          await restoredObject!.copyTo(restoredPath);
          expect(fs.readFileSync(restoredPath), `${fixture.relativeName} restored bytes`).toEqual(fixture.bytes);
        } finally {
          fs.rmSync(restoredPath, { force: true });
        }
      }
      process.env.PRIVATE_OBJECT_DIR = sourceObjectDir;

      // The successful stage must remove its archive and lease from this
      // unique GCS namespace.
      expect([...await getStagingNames()].filter((name) => !initialStagingNames.has(name))).toEqual([]);
    },
  );

  it(
    "keeps an inventoried GCS media read bound to its original generation",
    { timeout: 120_000 },
    async ({ skip }) => {
      skipIfUnavailable(skip);
      const fileName = `task5171-generation-${randomUUID()}.bin`;
      const original = randomBytes(64 * 1024);
      const replacement = randomBytes(64 * 1024);
      sourceMediaName = fileName;
      sourceMediaNames.add(fileName);
      sourceMediaBytes = original;
      process.env.PRIVATE_OBJECT_DIR = sourceObjectDir!;
      try {
        await writeCaseMediaToObjectStorage(fileName, original, "application/octet-stream");
        const inventoried = (await listCaseMediaBackupObjects())
          .find((file) => file.relativeName === fileName)!;
        expect(inventoried).toBeDefined();
        expect(inventoried.relativeName).toBe(fileName);
        expect(inventoried.generation).toBeTruthy();

        await writeCaseMediaToObjectStorage(fileName, replacement, "application/octet-stream");
        const stalePath = path.join(os.tmpdir(), `task5171-stale-generation-${randomUUID()}.bin`);
        try {
          try {
            await inventoried.copyTo(stalePath);
            expect(fs.readFileSync(stalePath).equals(original)).toBe(true);
            expect(fs.readFileSync(stalePath).equals(replacement)).toBe(false);
          } catch (error) {
            // Buckets without object versioning may have already discarded the
            // old generation. A missing pinned generation is safe; substituting
            // the newer bytes is not.
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain("(404)");
          }
        } finally {
          fs.rmSync(stalePath, { force: true });
        }

        const current = (await listCaseMediaBackupObjects())
          .find((file) => file.relativeName === fileName)!;
        expect(current).toBeDefined();
        expect(current.generation).not.toBe(inventoried.generation);
        const currentPath = path.join(os.tmpdir(), `task5171-current-generation-${randomUUID()}.bin`);
        try {
          await current.copyTo(currentPath);
          expect(fs.readFileSync(currentPath).equals(replacement)).toBe(true);
        } finally {
          fs.rmSync(currentPath, { force: true });
        }
      } finally {
        await deleteCaseMediaFromObjectStorage(fileName);
        sourceMediaNames.delete(fileName);
        sourceMediaName = null;
        sourceMediaBytes = null;
        process.env.PRIVATE_OBJECT_DIR = initialPrivateObjectDir;
      }
    },
  );

  it(
    "retains a cancelled GCS stage lease and sweeps it after its deadline",
    { timeout: 180_000 },
    async ({ skip }) => {
      skipIfUnavailable(skip);
      if (!stagingBucket || !stagingPrefix) {
        throw new Error("The isolated GCS staging namespace was not initialized.");
      }
      const previousPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
      // The preceding restore changes this env to the restore namespace. The
      // lease writer and the assertions must use the same test-owned source.
      process.env.PRIVATE_OBJECT_DIR = sourceObjectDir!;
      try {
        const controller = new AbortController();
        const stage = await createBackupCloudStage("non-production", 60_000, controller.signal);
        const writer = stage.open();
        writer.write(Buffer.alloc(8 * 1024 * 1024 + 1, 0x71));
        controller.abort();
        await stage.cleanup();

        const leasePrefix = `${stagingPrefix}/leases/`;
        const [leasesAfterCancel] = await stagingBucket.getFiles({ prefix: leasePrefix });
        const ownLease = leasesAfterCancel.find((file) => !initialStagingNames.has(file.name));
        expect(ownLease, "a cancelled, unsealed upload must retain its durable lease").toBeTruthy();
        const id = ownLease!.name.slice(leasePrefix.length).replace(/\.json$/, "");
        const [archiveExists] = await stagingBucket.file(`${stagingPrefix}/archives/${id}.zip.enc`).exists();
        expect(archiveExists).toBe(false);

        // Expire only this test's lease, then let the real next-stage sweep
        // remove it. No other GCS prefix is listed or modified.
        await ownLease!.setMetadata({ metadata: { expiresAt: "1" } });
        const retryStage = await createBackupCloudStage(
          "non-production",
          60_000,
          new AbortController().signal,
        );
        const [leasesAfterSweep] = await stagingBucket.getFiles({ prefix: leasePrefix });
        expect(leasesAfterSweep.some((file) => file.name === ownLease!.name)).toBe(false);
        const retryWriter = retryStage.open();
        await pipeline(Readable.from([Buffer.from("synthetic cleanup verification")]), retryWriter);
        await retryStage.seal(Buffer.byteLength("synthetic cleanup verification"));
        await retryStage.cleanup();
        expect([...await getStagingNames()].filter((name) => !initialStagingNames.has(name))).toEqual([]);
      } finally {
        if (previousPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
        else process.env.PRIVATE_OBJECT_DIR = previousPrivateObjectDir;
      }
    },
  );

  it(
    "sees real archives in the lab's off-site folder, not placeholders",
    { timeout: 300_000 },
    async ({ skip }) => {
      skipIfUnavailable(skip);
      if (!verificationFolder || !uploadedFileName || !verifiedRemoteItemId) {
        throw new Error("The isolated OneDrive verification folder was not initialized.");
      }

      const files = await listOneDriveBackupFiles(verificationFolder);
      // List only this run's unique non-production folder; never inspect or
      // list the production backup folder from this verification suite.
      expect(files.length, "the non-production verification folder is empty").toBeGreaterThan(0);
      const uploadedArchive = files.find((file) =>
        file.id === verifiedRemoteItemId && file.name === uploadedFileName,
      );
      expect(
        uploadedArchive?.size,
        `The verification folder holds ${files.length} file(s) but not this run's uploaded archive`,
      ).toBeGreaterThan(8 * 1024 * 1024);
    },
  );
});
