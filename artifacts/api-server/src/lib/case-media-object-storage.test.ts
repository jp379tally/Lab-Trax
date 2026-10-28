import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as os from "node:os";
import * as path from "node:path";
import archiver from "archiver";
import { planBackupMedia } from "./backup-media-producer";

interface FakePinnedFile {
  name: string;
  bucket: { file(name: string, options?: { generation?: string }): FakePinnedFile };
  getMetadata(): Promise<Array<{ size: string; generation: string }>>;
  createReadStream(options?: { validation?: string }): Readable;
}

const fakeStorage = vi.hoisted(() => ({
  objects: [] as Array<{ name: string; bytes: Buffer; fail?: boolean; size?: number; stall?: boolean; stallAfterData?: boolean; deny?: boolean }>,
  requests: [] as Array<{ bucketName: string; prefix: string }>,
  reads: [] as Array<{ name: string; generation?: string; validation?: string }>,
  readStarted: undefined as (() => void) | undefined,
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket(bucketName: string) {
      const bucket = {
        file: (name: string, fileOptions?: { generation?: string }): FakePinnedFile => {
          const object = fakeStorage.objects.find((item) => item.name === name)!;
          return {
            name,
            bucket,
            getMetadata: async () => {
              if (!object) throw Object.assign(new Error("No such object"), { code: 404 });
              if (object.deny) throw Object.assign(new Error("test permission denied"), { code: 403 });
              return [{ size: String(object.size ?? object.bytes.length), generation: "1" }];
            },
            createReadStream: (streamOptions?: { validation?: string }) => {
              fakeStorage.reads.push({
                name,
                generation: fileOptions?.generation,
                validation: streamOptions?.validation,
              });
              fakeStorage.readStarted?.();
              if (object.stall) return new Readable({ read() {} });
              if (object.stallAfterData) {
                let sent = false;
                return new Readable({ read() {
                  if (!sent) { sent = true; this.push(object.bytes); }
                } });
              }
              if (object.fail) {
                const stream = new Readable({ read() {} });
                queueMicrotask(() => stream.destroy(new Error("test object stream failure")));
                return stream;
              }
              return Readable.from([object.bytes]);
            },
          };
        },
        getFiles: async ({ prefix }: { prefix: string }) => {
          fakeStorage.requests.push({ bucketName, prefix });
          return [
            fakeStorage.objects
              .filter((object) => object.name.startsWith(prefix))
              .map((object) => ({
                name: object.name,
                metadata: { size: String(object.size ?? object.bytes.length), generation: "1" },
                createReadStream: () => {
                  if (object.fail) {
                    return Readable.from(
                      (async function* () {
                        throw new Error("test object stream failure");
                      })(),
                    );
                  }
                  return Readable.from([object.bytes]);
                },
              })),
          ];
        },
      };
      return bucket;
    }
  },
}));

describe("copyCaseMediaObjectsToDirectory", () => {
  let destinationDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/test-bucket/private-data");
    fakeStorage.objects = [];
    fakeStorage.requests = [];
    fakeStorage.reads = [];
    fakeStorage.readStarted = undefined;
    destinationDir = await mkdtemp(path.join(os.tmpdir(), "case-media-object-copy-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(destinationDir, { recursive: true, force: true });
  });

  it("copies the complete App Storage prefix, including hidden recovery data", async () => {
    fakeStorage.objects = [
      {
        name: "private-data/case-media/durable.jpg",
        bytes: Buffer.from("durable"),
      },
      {
        name: "private-data/case-media/nested/kept.jpg",
        bytes: Buffer.from("nested"),
      },
      {
        name: "private-data/case-media/.trash/deleted.jpg",
        bytes: Buffer.from("deleted"),
      },
    ];

    const storage = await import("./case-media-object-storage.js");
    await storage.copyCaseMediaObjectsToDirectory(destinationDir);

    expect(fakeStorage.requests).toEqual([
      { bucketName: "test-bucket", prefix: "private-data/case-media/" },
    ]);
    expect(await readFile(path.join(destinationDir, "durable.jpg"), "utf8")).toBe("durable");
    expect(await readFile(path.join(destinationDir, "nested", "kept.jpg"), "utf8")).toBe("nested");
    expect(await readFile(path.join(destinationDir, ".trash", "deleted.jpg"), "utf8")).toBe("deleted");
  });

  it("fails when an object stream fails instead of leaving a partial file", async () => {
    fakeStorage.objects = [
      {
        name: "private-data/case-media/broken.jpg",
        bytes: Buffer.from("partial"),
        fail: true,
      },
    ];

    const storage = await import("./case-media-object-storage.js");
    await expect(
      storage.copyCaseMediaObjectsToDirectory(destinationDir),
    ).rejects.toThrow("App Storage transfer failed");
    await expect(readFile(path.join(destinationDir, "broken.jpg"))).rejects.toThrow();
  });

  it("validates actual transferred bytes against the pinned object's size", async () => {
    fakeStorage.objects = [{ name: "private-data/case-media/short.bin", bytes: Buffer.from("short"), size: 100 }];
    const storage = await import("./case-media-object-storage.js");
    await expect(storage.copyCaseMediaObjectsToDirectory(destinationDir)).rejects.toThrow("size did not match the pinned object");
    await expect(readFile(path.join(destinationDir, "short.bin"))).rejects.toThrow();
  });

  it("stops a non-progressing object read and reports the stalled media phase", async () => {
    fakeStorage.objects = [{ name: "private-data/case-media/stall.bin", bytes: Buffer.from("unread"), stall: true }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    vi.useFakeTimers();
    const pending = object!.copyTo(path.join(destinationDir, "stall.bin"));
    const checked = expect(pending).rejects.toThrow("stalled for 60 seconds");
    await vi.advanceTimersByTimeAsync(61_000);
    await checked;
  });

  it("times out a stalled pinned stream used by the direct-to-archive producer", async () => {
    fakeStorage.objects = [{ name: "private-data/case-media/stalled-stream.bin", bytes: Buffer.from("unread"), stall: true }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    vi.useFakeTimers();
    const consumed = (async () => {
      for await (const _chunk of object!.openStream!()) {
        // Consume until the idle guard rejects the non-progressing source.
      }
    })();
    const checked = expect(consumed).rejects.toThrow("stalled for 60 seconds");
    await vi.advanceTimersByTimeAsync(61_000);
    await checked;
    expect(fakeStorage.reads).toContainEqual({
      name: "private-data/case-media/stalled-stream.bin",
      generation: "1",
      validation: "crc32c",
    });
  });

  it("does not count downstream backpressure as a stalled pinned download", async () => {
    const bytes = Buffer.alloc(256 * 1024, "p");
    fakeStorage.objects = [{ name: "private-data/case-media/queued.bin", bytes }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    vi.useFakeTimers();
    const stream = object!.openStream!();
    const errors: Error[] = [];
    stream.on("error", error => errors.push(error));
    // A later archive entry is allowed to wait for the current entry/output.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(errors).toEqual([]);
    expect(stream.destroyed).toBe(false);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it("still times out a stalled source after downstream demand resumes", async () => {
    fakeStorage.objects = [{
      name: "private-data/case-media/stall-after-pause.bin",
      bytes: Buffer.alloc(256 * 1024, "p"), stallAfterData: true,
    }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    vi.useFakeTimers();
    const stream = object!.openStream!();
    stream.on("error", () => undefined);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(stream.destroyed).toBe(false);
    const consumed = (async () => { for await (const _chunk of stream) { /* drain */ } })();
    const checked = expect(consumed).rejects.toThrow("stalled for 60 seconds");
    await vi.advanceTimersByTimeAsync(61_000);
    await checked;
  });

  it("honors cancellation while a pinned download is backpressured", async () => {
    fakeStorage.objects = [{
      name: "private-data/case-media/cancel-paused.bin", bytes: Buffer.alloc(256 * 1024, "p"),
    }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    vi.useFakeTimers();
    const controller = new AbortController();
    const stream = object!.openStream!(controller.signal);
    stream.on("error", () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    const consumed = (async () => { for await (const _chunk of stream) { /* drain */ } })();
    await expect(consumed).rejects.toThrow("aborted");
  });

  it("refuses to write complete-recovery evidence when a pinned media stream times out", async () => {
    fakeStorage.objects = [{ name: "private-data/case-media/recovery-stall.bin", bytes: Buffer.from("unread"), stall: true }];
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
    fakeStorage.readStarted = markReadStarted;
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    const media = await planBackupMedia(path.join(destinationDir, "local"), [object!]);
    const archive = archiver("zip");
    archive.on("error", () => undefined);
    archive.pipe(new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    vi.useFakeTimers();
    let completeRecoveryEvidenceWritten = false;
    const append = media.append(archive).then(() => {
      // Complete-backup appends its recovery manifest only after every media
      // source has been read and appended successfully.
      completeRecoveryEvidenceWritten = true;
    });
    await readStarted;
    expect(fakeStorage.reads).toHaveLength(1);
    const checked = expect(append).rejects.toThrow(/case-media transfer into archive/i);
    await vi.advanceTimersByTimeAsync(61_000);
    await checked;
    expect(completeRecoveryEvidenceWritten).toBe(false);
  });

  it("streams the pinned generation with explicit CRC32C validation", async () => {
    const bytes = Buffer.from("verified pinned object");
    fakeStorage.objects = [{ name: "private-data/case-media/pinned.bin", bytes }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    const chunks: Buffer[] = [];
    for await (const chunk of object!.openStream!()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(fakeStorage.reads).toEqual([{
      name: "private-data/case-media/pinned.bin",
      generation: "1",
      validation: "crc32c",
    }]);
  });

  it("rejects an unreadable pinned object stream instead of treating it as covered", async () => {
    fakeStorage.objects = [{
      name: "private-data/case-media/unreadable.bin",
      bytes: Buffer.from("unreadable"),
      fail: true,
    }];
    const storage = await import("./case-media-object-storage.js");
    const [object] = await storage.listCaseMediaBackupObjects();
    const readAll = async () => {
      for await (const _chunk of object!.openStream!()) {
        // Consume the full stream so late CRC or transport errors are observed.
      }
    };
    await expect(readAll()).rejects.toThrow("test object stream failure");
  });

  it("rejects unsafe paths and an already cancelled inventory without downloading anything", async () => {
    const storage = await import("./case-media-object-storage.js");
    const controller = new AbortController();
    controller.abort();
    await expect(storage.listCaseMediaBackupObjects(controller.signal)).rejects.toThrow("inventory was aborted");
    expect(fakeStorage.requests).toHaveLength(0);
    fakeStorage.objects = [{ name: "private-data/case-media/../escape.bin", bytes: Buffer.from("unsafe") }];
    await expect(storage.listCaseMediaBackupObjects()).rejects.toThrow("unsafe case-media object path");
  });
});

describe("openPrivateBackupObject", () => {
  let destinationDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/test-bucket/private-data");
    fakeStorage.objects = [];
    fakeStorage.requests = [];
    destinationDir = await mkdtemp(path.join(os.tmpdir(), "private-object-open-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(destinationDir, { recursive: true, force: true });
  });

  it("copies one exact object without listing its namespace", async () => {
    fakeStorage.objects = [
      { name: "private-data/support-reports/report-a", bytes: Buffer.from("support-a") },
      { name: "private-data/support-reports/report-a-other", bytes: Buffer.from("other") },
    ];
    const storage = await import("./case-media-object-storage.js");
    const object = await storage.openPrivateBackupObject("support-reports/report-a");
    expect(object).toMatchObject({ relativeName: "support-reports/report-a", size: 9 });
    await object!.copyTo(path.join(destinationDir, "report-a"));
    expect(await readFile(path.join(destinationDir, "report-a"), "utf8")).toBe("support-a");
    expect(fakeStorage.requests).toEqual([]);
  });

  it("returns null only when the object does not exist", async () => {
    fakeStorage.objects = [{ name: "private-data/lab-logos/lab-a.png", bytes: Buffer.from("logo"), deny: true }];
    const storage = await import("./case-media-object-storage.js");
    await expect(storage.openPrivateBackupObject("lab-logos/lab-b.png")).resolves.toBeNull();
    await expect(storage.openPrivateBackupObject("lab-logos/lab-a.png")).rejects.toThrow("test permission denied");
  });

  it("refuses unsafe names and an unconfigured bucket", async () => {
    const storage = await import("./case-media-object-storage.js");
    for (const name of ["", "../escape", "a//b", "/absolute", "a\\b", "folder/", "a/./b"]) {
      await expect(storage.openPrivateBackupObject(name), name).rejects.toThrow("Unsafe private backup object identity");
    }
    vi.stubEnv("PRIVATE_OBJECT_DIR", "");
    await expect(storage.openPrivateBackupObject("support-reports/a")).rejects.toThrow("App Storage is not configured");
  });
});
