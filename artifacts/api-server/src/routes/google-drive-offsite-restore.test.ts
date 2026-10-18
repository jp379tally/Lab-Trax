/**
 * Google Drive read-back and restore rehearsal.
 *
 * Runs only under scripts/run-isolated-backup-restore.sh. It uploads a real
 * complete encrypted archive to a unique verification folder, downloads that
 * exact Drive item by ID, compares it with the bytes sent from the sealed
 * cloud stage, and restores it into the disposable database/object namespace.
 * It never enumerates, prunes, or deletes pre-existing backup files.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const liveProbe = vi.hoisted(() => ({
  cloudReadChunks: [] as Array<{ offset: number; bytes: Buffer }>,
}));

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

import { db, users } from "@workspace/db";
import { getBackupStagingLocation } from "../lib/case-media-object-storage.js";
import {
  deleteCaseMediaFromObjectStorage,
  listCaseMediaBackupObjects,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage.js";
import { MAX_BACKUP_RANGE_BYTES } from "../lib/backup-cloud-staging.js";
import {
  executeRestore,
  runGoogleDriveBackup,
} from "../lib/backup.js";
import {
  deleteGoogleDriveBackupFile,
  downloadGoogleDriveBackupFile,
  getGoogleDriveFileById,
  getGoogleDriveFolderIdForPath,
  getGoogleDriveStatus,
  isGoogleDriveConnectorAvailable,
  GOOGLE_DRIVE_NON_PRODUCTION_FOLDER,
} from "../lib/google-drive.js";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation.js";

const live = { skipReason: "", folderPath: "", folderId: "" };
let restoreObjectDir: string | null = null;
let sourceObjectDir: string | null = null;
let originalPrivateObjectDir: string | undefined;
let uploadedItemId: string | null = null;
let sourceMediaName: string | null = null;
let sourceMediaBytes: Buffer | null = null;
let stagingBucket: ReturnType<typeof getBackupStagingLocation>["bucket"] | null = null;
let stagingPrefix: string | null = null;
let initialStagingNames = new Set<string>();

function siblingPrivateObjectDir(base: string, label: string): string {
  const normalized = base.replace(/^\/+|\/+$/g, "");
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error("The isolated restore object directory must include a private bucket prefix.");
  }
  const bucket = normalized.slice(0, slash);
  const objectRoot = normalized.slice(slash + 1);
  const name = `${path.posix.basename(objectRoot)}-${label}-${randomUUID()}`;
  return `/${bucket}/${path.posix.join(path.posix.dirname(objectRoot), name)}`;
}

function skipIfUnavailable(skip: (reason?: string) => never): void {
  if (live.skipReason) {
    console.warn(`[offsite-gate] Google Drive round trip SKIPPED — ${live.skipReason}`);
    skip(live.skipReason);
  }
}

async function getStagingNames(): Promise<Set<string>> {
  if (!stagingBucket || !stagingPrefix) {
    throw new Error("The isolated Google Drive cloud staging namespace is not ready.");
  }
  const [files] = await stagingBucket.getFiles({ prefix: `${stagingPrefix}/` });
  return new Set(files.map((file) => file.name));
}

async function seedRestorableState(): Promise<Record<string, { size: number; sha256: string }>> {
  const mediaDir = path.resolve(process.cwd(), "uploads", "case-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const media = randomBytes(12 * 1024 * 1024);
  const mediaName = "google-drive-offsite-gate-media.bin";
  fs.writeFileSync(path.join(mediaDir, mediaName), media);
  const expected = {
    [mediaName]: {
      size: media.length,
      sha256: createHash("sha256").update(media).digest("hex"),
    },
  };
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length === 0) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
    await db.insert(users).values({
      username: `google_drive_gate_${suffix}`,
      password: "x",
      email: `google_drive_gate_${suffix}@example.test`,
      role: "admin",
      userType: "lab",
    });
  }
  return expected;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

describe("off-site backup round trip (Google Drive → restore)", () => {
  beforeAll(async () => {
    requireIsolatedRestoreTest();
    originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
    if (!process.env.DATABASE_URL) {
      live.skipReason = "DATABASE_URL is not set";
      return;
    }
    if (process.env.REPLIT_DEPLOYMENT === "1") {
      throw new Error("The live Google Drive staging test refuses to run in a production deployment.");
    }
    if (!process.env.PRIVATE_OBJECT_DIR || !process.env.LABTRAX_RESTORE_OBJECT_DIR) {
      live.skipReason = "an explicit isolated private object destination is not configured";
      return;
    }
    if (!isGoogleDriveConnectorAvailable()) {
      live.skipReason = "the Google Drive connector is not available in this environment";
      return;
    }
    const status = await getGoogleDriveStatus();
    if (!status.connected) {
      live.skipReason = status.error ?? "Google Drive is not connected";
      return;
    }

    restoreObjectDir = process.env.LABTRAX_RESTORE_OBJECT_DIR;
    sourceObjectDir = siblingPrivateObjectDir(restoreObjectDir, "google-drive-source");
    if (sourceObjectDir === restoreObjectDir ||
        sourceObjectDir.startsWith(`${restoreObjectDir.replace(/\/+$/, "")}/`) ||
        restoreObjectDir.startsWith(`${sourceObjectDir.replace(/\/+$/, "")}/`)) {
      throw new Error("The Google Drive source and restore object namespaces must not overlap.");
    }
    process.env.PRIVATE_OBJECT_DIR = sourceObjectDir;

    // The folder is unique per run. Folder resolution only examines folders;
    // no backup files are listed or touched.
    live.folderPath = `${GOOGLE_DRIVE_NON_PRODUCTION_FOLDER}/gate-verification/${randomUUID()}`;
    live.folderId = await getGoogleDriveFolderIdForPath(live.folderPath);
    stagingBucket = getBackupStagingLocation("non-production").bucket;
    stagingPrefix = getBackupStagingLocation("non-production").prefix;
    initialStagingNames = await getStagingNames();
  }, 60_000);

  afterAll(async () => {
    const cleanupFailures: string[] = [];
    if (uploadedItemId) {
      try {
        // Delete only the exact item created by this test run, by its ID.
        await deleteGoogleDriveBackupFile(uploadedItemId);
      } catch {
        cleanupFailures.push("this run's synthetic Google Drive archive");
      }
    }
    if (sourceObjectDir && sourceMediaName) {
      process.env.PRIVATE_OBJECT_DIR = sourceObjectDir;
      try {
        await deleteCaseMediaFromObjectStorage(sourceMediaName);
      } catch {
        cleanupFailures.push("synthetic source media");
      }
    }
    if (restoreObjectDir && sourceMediaName) {
      process.env.PRIVATE_OBJECT_DIR = restoreObjectDir;
      try {
        await deleteCaseMediaFromObjectStorage(sourceMediaName);
      } catch {
        cleanupFailures.push("synthetic restored media");
      }
    }
    if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
    if (live.skipReason) {
      console.warn(`[offsite-gate] Google Drive round trip SKIPPED — ${live.skipReason}`);
    }
    if (cleanupFailures.length) {
      throw new Error(`Could not clean up ${cleanupFailures.join(" and ")}.`);
    }
  }, 120_000);

  it(
    "uploads, reads back, byte-compares, and restores a complete archive from its unique folder",
    { timeout: 900_000 },
    async ({ skip }) => {
      skipIfUnavailable(skip);
      if (!restoreObjectDir || !sourceObjectDir || !stagingBucket || !stagingPrefix ||
          !live.folderPath || !live.folderId) {
        throw new Error("The isolated Google Drive and restore namespaces were not initialized.");
      }
      const expectedRestoredFiles = await seedRestorableState();
      sourceMediaName = `google-drive-gate-${randomUUID()}.bin`;
      sourceMediaBytes = randomBytes(128 * 1024);
      await writeCaseMediaToObjectStorage(sourceMediaName, sourceMediaBytes, "application/octet-stream");
      const inventory = await listCaseMediaBackupObjects();
      expect(inventory).toHaveLength(1);
      expect(inventory[0]!.relativeName).toBe(sourceMediaName);
      expect(inventory[0]!.generation).toBeTruthy();

      liveProbe.cloudReadChunks = [];
      const backup = await runGoogleDriveBackup("gate:google-drive-roundtrip", {
        folderOverride: { id: live.folderId, path: live.folderPath },
      });
      expect(backup.destination).toBe("google-drive");
      expect(backup.archiveKind).not.toBe("database-only");
      expect(backup.remoteItemId).toBeTruthy();
      expect(backup.size).toBeGreaterThan(8 * 1024 * 1024);
      if (!backup.remoteItemId) throw new Error("Google Drive did not return the synthetic item's identity.");
      uploadedItemId = backup.remoteItemId;

      const orderedChunks = [...liveProbe.cloudReadChunks].sort((a, b) => a.offset - b.offset);
      expect(orderedChunks.length).toBeGreaterThan(1);
      let nextOffset = 0;
      const stagedHash = createHash("sha256");
      for (const { offset, bytes } of orderedChunks) {
        expect(offset).toBe(nextOffset);
        expect(bytes.length).toBeLessThanOrEqual(MAX_BACKUP_RANGE_BYTES);
        stagedHash.update(bytes);
        nextOffset += bytes.length;
      }
      expect(nextOffset).toBe(backup.size);
      const stagedArchiveBytes = Buffer.concat(orderedChunks.map(({ bytes }) => bytes), nextOffset);

      const remote = await getGoogleDriveFileById(backup.remoteItemId);
      expect(remote).not.toBeNull();
      expect(remote!.id).toBe(backup.remoteItemId);
      expect(remote!.name).toBe(backup.fileName);
      expect(remote!.size).toBe(backup.size);
      expect(remote!.parentIds).toContain(live.folderId);
      const downloaded = await downloadGoogleDriveBackupFile(remote!.id, backup.size);
      expect(downloaded.length).toBe(backup.size);
      expect(downloaded.equals(stagedArchiveBytes), "Google Drive read-back must match every uploaded byte")
        .toBe(true);
      expect(createHash("sha256").update(downloaded).digest("hex")).toBe(stagedHash.digest("hex"));

      process.env.PRIVATE_OBJECT_DIR = restoreObjectDir;
      const restored = await executeRestore(downloaded, "gate:google-drive-roundtrip");
      expect(restored.manifest.appName).toBe("LabTrax");
      expect(restored.manifest.sourceEnvironment).not.toBe("production");
      for (const [fileName, expected] of Object.entries(expectedRestoredFiles)) {
        const restoredPath = path.resolve(process.cwd(), "uploads", "case-media", fileName);
        expect(fs.statSync(restoredPath).size, `${fileName} restored size`).toBe(expected.size);
        expect(await sha256File(restoredPath), `${fileName} restored contents`).toBe(expected.sha256);
      }
      const restoredMedia = await listCaseMediaBackupObjects();
      const restoredFixture = restoredMedia.find((file) => file.relativeName === sourceMediaName);
      expect(restoredFixture?.generation).toBeTruthy();
      const restoredPath = path.join(os.tmpdir(), `google-drive-restored-${randomUUID()}.bin`);
      try {
        await restoredFixture!.copyTo(restoredPath);
        expect(fs.readFileSync(restoredPath).equals(sourceMediaBytes)).toBe(true);
      } finally {
        fs.rmSync(restoredPath, { force: true });
      }
      process.env.PRIVATE_OBJECT_DIR = sourceObjectDir;
      expect([...await getStagingNames()].filter((name) => !initialStagingNames.has(name))).toEqual([]);
    },
  );
});
