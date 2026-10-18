import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import * as os from "node:os";
import * as path from "node:path";

const fakeStorage = vi.hoisted(() => ({
  objects: [] as Array<{ name: string; bytes: Buffer; fail?: boolean; size?: number; stall?: boolean; deny?: boolean }>,
  requests: [] as Array<{ bucketName: string; prefix: string }>,
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket(bucketName: string) {
      return {
        file: (name: string) => {
          const object = fakeStorage.objects.find((item) => item.name === name)!;
          return {
            getMetadata: async () => {
              if (!object) throw Object.assign(new Error("No such object"), { code: 404 });
              if (object.deny) throw Object.assign(new Error("test permission denied"), { code: 403 });
              return [{ size: String(object.size ?? object.bytes.length), generation: "1" }];
            },
            createReadStream: () => object.stall ? new Readable({ read() {} }) : object.fail
              ? Readable.from((async function* () { throw new Error("test object stream failure"); })())
              : Readable.from([object.bytes]),
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
