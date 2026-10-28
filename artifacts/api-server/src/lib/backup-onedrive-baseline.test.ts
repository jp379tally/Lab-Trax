import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
const fake = vi.hoisted(() => ({ capture: vi.fn(), job: vi.fn(), stage: vi.fn(), upload: vi.fn(), remote: vi.fn(), query: vi.fn(), release: vi.fn() }));
vi.mock("@workspace/db", async () => ({ ...await import("@workspace/db/schema"),
  pool: { connect: async () => ({ query: fake.query, release: fake.release }) },
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) } }));
vi.mock("./complete-backup", async original => ({ ...await original<typeof import("./complete-backup")>(), captureCompleteBackup: fake.capture }));
vi.mock("./database-protection-job", async original => ({ ...await original<typeof import("./database-protection-job")>(), runDatabaseProtectionJob: fake.job }));
vi.mock("./backup-cloud-staging", () => ({ createBackupCloudStage: fake.stage }));
vi.mock("./onedrive", async original => ({ ...await original<typeof import("./onedrive")>(),
  isProductionDeployment: () => true, uploadBackupSourceToOneDrive: fake.upload,
  getOneDriveFileByName: fake.remote, pruneOneDriveBackups: async () => [],
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => {
    const child = new EventEmitter() as any;
    child.stdout = Readable.from([Buffer.from("PGDMPsynthetic-schema-only")]);
    child.stderr = Readable.from([]); child.kill = vi.fn();
    child.stdout.once("end", () => queueMicrotask(() => child.emit("close", 0)));
    return child;
  },
}));
vi.mock("./pg-tools", () => ({ resolvePostgresTool: () => "synthetic-pg-dump" }));
import { runOneDriveBackup, createBackupDeadline, decryptBuffer } from "./backup";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let encrypted: Buffer;
let storedBytes: number;
let commitFailure: boolean;
let uploadFailure: boolean;
const original = Buffer.from("synthetic production photo, no personal data");
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "synthetic-baseline-test-key");
  vi.stubEnv("BACKUP_MIN_PLAUSIBLE_BYTES", "128");
  encrypted = Buffer.alloc(0); storedBytes = 0; commitFailure = false; uploadFailure = false;
  fake.query.mockResolvedValue({ rows: [{ claimed: true }] });
  fake.capture.mockImplementation(async (_root, _dump, _signal, options) => {
    expect(options).toMatchObject({ snapshot: "synthetic-snapshot", recordsWithFullArchive: true, productionDataOnly: true });
    await options.onMediaPinned();
    const files: any[] = [];
    return {
      pgDump: Buffer.from("PGDMPsynthetic-full-database"), recordCapture: { delta: false, inventory: {
        format: "labtrax-postgresql-record-delta-v1", schemaHash: "a".repeat(64), referenceProtocol: "b".repeat(64), tables: [], sequences: [],
      } },
      counts: { attachmentRowCount: 1 }, uploadDirs: { caseMedia: { exists: true, fileCount: 1, totalBytes: original.length }, profilePhotos: { exists: false, fileCount: 0, totalBytes: 0 } },
      manifest: { sourceEnvironment: "production", files, missingReferences: [], productionMediaWriterCoverage: { protocol: 1 } },
      productionMediaSources: [{ archivePath: "case-media/photo.jpg", size: original.length, sourceVersion: "generation:1" }],
      async append(archive: any) {
        await new Promise<void>((resolve, reject) => {
          archive.once("entry", resolve); archive.once("error", reject);
          archive.append(Readable.from([original]), { name: "media/photo.jpg" });
        });
        files.push({ archivePath: "media/photo.jpg", size: original.length, sha256: digest(original) });
        archive.append("{}", { name: "complete-recovery.json" });
      },
    };
  });
  fake.stage.mockImplementation(async () => {
    const pieces: Buffer[] = [];
    return { open: () => new Writable({ write(bytes, _encoding, cb) { pieces.push(Buffer.from(bytes)); cb(); },
      final(cb) { encrypted = Buffer.concat(pieces); cb(); } }),
      seal: async (size: number) => expect(encrypted.length).toBe(size),
      readChunk: async (offset: number, length: number) => encrypted.subarray(offset, offset + length), cleanup: async () => {} };
  });
  fake.upload.mockImplementation(async (source, name) => {
    if (uploadFailure) throw new Error("synthetic upload failure");
    expect(await source.readChunk(0, source.size)).toEqual(encrypted);
    return { itemId: "synthetic-item", fileName: name };
  });
  fake.remote.mockImplementation(async (name, _folder, id) => ({ id, name, size: encrypted.length }));
  fake.job.mockImplementation(async options => {
    expect(options).toMatchObject({ trigger: "manual", destination: "onedrive" });
    const records = await options.capture("synthetic-snapshot", null, async () => {}, null);
    expect(records.schemaDump.toString()).toContain("synthetic-schema-only");
    const media = await options.captureMedia(async (path: string, stream: Readable, sourceVersion: string) => {
      const pieces: Buffer[] = [];
      for await (const part of stream) { pieces.push(Buffer.from(part)); storedBytes += part.length; }
      return { path, sourceVersion, bytes: storedBytes, hash: digest(Buffer.concat(pieces)), chunks: [] };
    }, (sources: any[]) => new Set(sources.map(source => source.archivePath)));
    expect(media.evidence.databaseSha256).toBe(digest(Buffer.from(JSON.stringify(records.records.inventory))));
    expect(media.evidence.databaseCapture).toBe("postgresql-record-state-v1");
    return commitFailure ? { state: "failed", error: "synthetic baseline verification failed" } : { state: "verified" };
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("manual OneDrive archive establishes the scheduled baseline", () => {
  it("keeps a standalone full archive and seeds reusable production media from the same read", async () => {
    const deadline = createBackupDeadline(30_000);
    try {
      const result = await runOneDriveBackup("synthetic-manual", { deadline });
      expect(result.destination).toBe("onedrive");
      expect(fake.capture).toHaveBeenCalledTimes(1); expect(fake.job).toHaveBeenCalledTimes(1);
      expect(storedBytes).toBe(original.length);
      const zip = new AdmZip(decryptBuffer(encrypted));
      expect(zip.readFile("media/photo.jpg")).toEqual(original);
      expect(zip.readFile("db/database.pgdump")?.toString()).toContain("synthetic-full-database");
    } finally { deadline.dispose(); }
  });
  it.each(["upload", "baseline"])("does not report success when %s verification fails", async failure => {
    uploadFailure = failure === "upload"; commitFailure = failure === "baseline";
    const deadline = createBackupDeadline(30_000);
    try { await expect(runOneDriveBackup("synthetic-manual", { deadline })).rejects.toThrow(/synthetic/); }
    finally { deadline.dispose(); }
  });
});
