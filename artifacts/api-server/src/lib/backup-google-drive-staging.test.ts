import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import type { Archiver } from "archiver";
import type { GoogleDriveBackupSource } from "./google-drive";

const fake = vi.hoisted(() => ({
  select: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  unexpectedDbQuery: vi.fn(),
  capture: vi.fn(),
  stageSetup: vi.fn(),
  status: vi.fn(),
  uploadSource: vi.fn(),
  uploadFile: vi.fn(),
  verify: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: { select: fake.select },
  pool: { connect: fake.connect, query: fake.unexpectedDbQuery },
}));
vi.mock("./complete-backup", async (original) => ({
  ...await original<typeof import("./complete-backup")>(),
  captureCompleteBackup: fake.capture,
}));
vi.mock("./backup-cloud-staging", () => ({ createBackupCloudStage: fake.stageSetup }));
vi.mock("./google-drive", async (original) => ({
  ...await original<typeof import("./google-drive")>(),
  getGoogleDriveStatus: fake.status,
  uploadGoogleDriveBackupSource: fake.uploadSource,
  uploadGoogleDriveBackupFile: fake.uploadFile,
  verifyGoogleDriveBackup: fake.verify,
  listGoogleDriveBackupFiles: fake.list,
  deleteGoogleDriveBackupFile: fake.remove,
}));

import { createBackupDeadline, decryptBuffer, runGoogleDriveBackup } from "./backup";
import { BackupCancelledError } from "./backup-phase";
import { requireCompleteBackupCapacity } from "./complete-backup";

const availableTemp = 25_063_153_664;
const durableBytes = 34_000_000_000;
const boundedWorkingBytes = 1_100_000_000;
const dumpBytes = 70_000_000;
const fixtureDump = Buffer.from("synthetic database dump; no real records");
const fixtureMedia = Buffer.from("synthetic case photo; no real media");
const fixtureProfile = Buffer.from("synthetic profile photo; no real media");
let environment: "production" | "non-production";
let failure: string | null;
let claimed: boolean;
let deadline: ReturnType<typeof createBackupDeadline>;
let archivedBytes: Buffer;
let sealed: boolean;
let stage: {
  open: ReturnType<typeof vi.fn>;
  seal: ReturnType<typeof vi.fn>;
  readChunk: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Only the hermetic fixture uses a small size floor and a synthetic key.
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "synthetic-unit-test-backup-key");
  vi.stubEnv("BACKUP_MIN_PLAUSIBLE_BYTES", "128");
  vi.stubEnv("BACKUP_RUN_TIMEOUT_MINUTES", "10");
  failure = null;
  claimed = true;
  environment = "production";
  archivedBytes = Buffer.alloc(0);
  sealed = false;
  deadline = createBackupDeadline(30_000);
  const rows: unknown[] = [];
  const queryBuilder = {
    from: () => queryBuilder,
    where: () => queryBuilder,
    limit: async () => rows,
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  fake.select.mockReturnValue(queryBuilder);
  fake.unexpectedDbQuery.mockRejectedValue(new Error("Unexpected database access in hermetic staging test"));
  fake.connect.mockResolvedValue({ query: fake.query, release: fake.release });
  fake.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ claimed }] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [] };
    throw new Error("Unexpected query in hermetic staging test");
  });
  fake.status.mockResolvedValue({ connected: true });
  fake.list.mockResolvedValue([]);
  fake.verify.mockImplementation(async () => {
    if (failure === "verification") throw new Error("Remote size verification failed");
  });

  fake.capture.mockImplementation(async (
    _root: string, _dump: unknown, _signal: AbortSignal,
    options?: { archiveDestination?: "local" | "cloud" | "direct" },
  ) => {
    // These inventory numbers exceed local capacity without creating large
    // files. The real capacity guard catches a caller reverting to local.
    requireCompleteBackupCapacity(
      availableTemp, durableBytes, boundedWorkingBytes, dumpBytes, options?.archiveDestination,
    );
    if (failure === "missing") throw new Error("Required file references have no readable recovery source");
    return {
      pgDump: fixtureDump,
      counts: { userCount: 1, orgCount: 1, caseCount: 1, invoiceCount: 1, tableCount: 4, attachmentRowCount: 1 },
      uploadDirs: {
        caseMedia: { exists: true, fileCount: 1, totalBytes: durableBytes },
        profilePhotos: { exists: true, fileCount: 1, totalBytes: fixtureProfile.length },
      },
      profilePhotoFileCount: 1,
      manifest: { sourceEnvironment: environment, files: [{ size: durableBytes }] },
      async append(archive: Archiver) {
        if (failure === "assembly") throw new Error("Source media changed during archive assembly");
        archive.append(fixtureMedia, { name: "media/fixture.jpg" });
        archive.append(fixtureProfile, { name: "private-objects/profile-photos/fixture.jpg" });
        archive.append(Buffer.from('{"syntheticFixture":true}'), { name: "complete-recovery.json" });
      },
    };
  });

  const chunks: Buffer[] = [];
  stage = {
    open: vi.fn(() => new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) { archivedBytes = Buffer.concat(chunks); callback(); },
    })),
    seal: vi.fn(async (size: number) => {
      if (failure === "seal") throw new Error("Cloud stage size or generation mismatch");
      expect(size).toBe(archivedBytes.length);
      sealed = true;
    }),
    readChunk: vi.fn(async (offset: number, length: number) => {
      expect(sealed).toBe(true);
      expect(length).toBeLessThanOrEqual(5 * 1024 * 1024);
      return archivedBytes.subarray(offset, offset + length);
    }),
    cleanup: vi.fn(async () => undefined),
  };
  fake.stageSetup.mockResolvedValue(stage);
  fake.uploadSource.mockImplementation(async (
    source: GoogleDriveBackupSource, fileName: string, options: { signal: AbortSignal },
  ) => {
    expect(sealed).toBe(true);
    if (failure === "upload") throw new Error("Remote upload failed");
    if (failure === "abort") {
      // Expire the caller-owned deadline while the upload is in progress.
      vi.spyOn(options.signal, "aborted", "get").mockReturnValue(true);
      throw new Error("Upload aborted");
    }
    const transferred: Buffer[] = [];
    for (let offset = 0; offset < source.size; offset += 5 * 1024 * 1024) {
      transferred.push(await source.readChunk(offset, Math.min(5 * 1024 * 1024, source.size - offset)));
    }
    expect(Buffer.concat(transferred)).toEqual(archivedBytes);
    return {
      id: "synthetic-drive-item", name: fileName, size: source.size,
      folder: "synthetic-folder", folderId: "synthetic-folder-id", createdTime: null,
    };
  });
});

afterEach(() => {
  deadline.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(fake.unexpectedDbQuery).not.toHaveBeenCalled();
});

function expectCaptureLockReleased() {
  expect(fake.query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
  expect(fake.release).toHaveBeenCalledTimes(1);
}

describe("complete Google Drive cloud staging", () => {
  it("distinguishes user cancellation from timeout expiry", () => {
    const controller = new AbortController();
    const cancellable = createBackupDeadline(30_000, controller.signal);
    controller.abort();

    expect(cancellable.cancelled()).toBe(true);
    expect(cancellable.expired()).toBe(false);
    expect(() => cancellable.throwIfExpired("archive delivery")).toThrow(BackupCancelledError);
    cancellable.dispose();
  });

  it.each([{ source: "production" as const }, { source: "non-production" as const }])(
    "streams the full encrypted archive using its $source namespace, not local capacity", async ({ source }) => {
      environment = source;
      expect(() => requireCompleteBackupCapacity(
        availableTemp, durableBytes, boundedWorkingBytes, dumpBytes, "local",
      )).toThrow(/capacity failure/);
      const result = await runGoogleDriveBackup("synthetic-test", { deadline });
      expect(fake.capture.mock.calls[0]?.[3]).toEqual({
        archiveDestination: "cloud", allowMissingReferences: true, productionDataOnly: true,
      });
      expect(fake.stageSetup).toHaveBeenCalledWith(source, deadline.timeoutMs, deadline.signal);
      expect(fake.uploadFile).not.toHaveBeenCalled();
      expect(stage.seal).toHaveBeenCalledTimes(1);
      expect(archivedBytes.subarray(0, 4).toString()).toBe("LTR2");
      const zip = new AdmZip(decryptBuffer(archivedBytes));
      expect(zip.readFile("db/database.pgdump")).toEqual(fixtureDump);
      expect(zip.readFile("media/fixture.jpg")).toEqual(fixtureMedia);
      expect(zip.readFile("private-objects/profile-photos/fixture.jpg")).toEqual(fixtureProfile);
      const manifest = JSON.parse(zip.readAsText("manifest.json"));
      expect(manifest).toMatchObject({
        sourceEnvironment: source, coverageVersion: 2, includesMedia: true,
        archiveKind: source === "production" ? "complete-production" : "complete-non-production",
        profilePhotoFileCount: 1, attachmentRowCount: 1,
      });
      expect(result).toMatchObject({
        archiveKind: manifest.archiveKind, partialFailure: false, warnings: null,
        size: archivedBytes.length, mediaFileCount: 1, attachmentRowCount: 1,
        destination: "google-drive", remoteItemId: "synthetic-drive-item",
      });
      expect(fake.verify).toHaveBeenCalledWith(expect.objectContaining({ id: result.remoteItemId }), result.size, deadline.signal);
      expect(fake.list).toHaveBeenCalledTimes(1);
      expect(fake.verify.mock.invocationCallOrder[0]).toBeLessThan(fake.list.mock.invocationCallOrder[0]!);
      expect(stage.cleanup).toHaveBeenCalledTimes(1);
      expectCaptureLockReleased();
    },
  );

  it("refuses missing references before staging, uploading, or pruning, with no fallback", async () => {
    failure = "missing";
    await expect(runGoogleDriveBackup("synthetic-test", { deadline })).rejects.toThrow(/no readable recovery source/);
    expect(fake.stageSetup).not.toHaveBeenCalled();
    expect(fake.uploadSource).not.toHaveBeenCalled();
    expect(fake.uploadFile).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    expectCaptureLockReleased();
  });

  it.each([
    { step: "assembly", message: /Source media changed/ },
    { step: "seal", message: /size or generation/ },
    { step: "upload", message: /Remote upload failed/ },
    { step: "verification", message: /Remote size verification failed/ },
    { step: "abort", message: /aborted/ },
  ])("cleans staging and releases the lock after $step failure without pruning or fallback", async ({ step, message }) => {
    failure = step;
    await expect(runGoogleDriveBackup("synthetic-test", { deadline })).rejects.toThrow(message);
    expect(stage.cleanup).toHaveBeenCalledTimes(1);
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.uploadFile).not.toHaveBeenCalled();
    expectCaptureLockReleased();
  });

  it("keeps the plausibility floor before upload and cleans an undersized archive", async () => {
    vi.stubEnv("BACKUP_MIN_PLAUSIBLE_BYTES", String(1024 * 1024));
    await expect(runGoogleDriveBackup("synthetic-test", { deadline })).rejects.toThrow(/small|minimum|plausib/i);
    expect(fake.uploadSource).not.toHaveBeenCalled();
    expect(stage.cleanup).toHaveBeenCalledTimes(1);
    expectCaptureLockReleased();
  });

  it("does not capture or stage while another complete capture holds the lock", async () => {
    claimed = false;
    await expect(runGoogleDriveBackup("synthetic-test", { deadline })).rejects.toThrow(/already|progress|another/i);
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.stageSetup).not.toHaveBeenCalled();
    expect(fake.uploadFile).not.toHaveBeenCalled();
    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("creates and disposes a finite deadline when the caller does not supply one", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await runGoogleDriveBackup("synthetic-test");
    expect(fake.stageSetup).toHaveBeenCalledWith("production", 600_000, expect.any(AbortSignal));
    const timerIndex = timers.mock.calls.findIndex(([, milliseconds]) => milliseconds === 600_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    expect(clear).toHaveBeenCalledWith(timers.mock.results[timerIndex]?.value);
    expect(stage.cleanup).toHaveBeenCalledTimes(1);
    expectCaptureLockReleased();
  });
});
