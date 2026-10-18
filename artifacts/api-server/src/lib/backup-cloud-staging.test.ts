import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

const fake = vi.hoisted(() => ({
  objects: new Map<string, { bytes: Buffer; generation: string; metadata?: Record<string, string> }>(),
  calls: [] as Array<{ name: string; generation?: string | number; start?: number; end?: number }>,
  failDelete: false,
  badSize: false,
  overRead: false,
  shortRead: false,
  stallRead: false,
}));
const prefix = ".labtrax-backup-staging/synthetic/non-production";
vi.mock("./logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("./case-media-object-storage", () => ({
  MEDIA_TRANSFER_IDLE_MS: 60_000,
  getBackupStagingLocation: () => ({
    prefix,
    bucket: {
      async getFiles() {
        return [[...fake.objects].filter(([name]) => name.startsWith(`${prefix}/leases/`)).map(([name, object]) => ({
          name, metadata: { generation: object.generation, metadata: object.metadata },
          delete: async () => { fake.objects.delete(name); },
        }))];
      },
      file(name: string, options?: { generation?: string | number }) {
        return {
          name,
          async save(bytes: string, opts: { metadata: { metadata: Record<string, string> } }) {
            fake.objects.set(name, { bytes: Buffer.from(bytes), generation: "1", metadata: opts.metadata.metadata });
          },
          createWriteStream() {
            const chunks: Buffer[] = [];
            return new Writable({
              write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
              final(callback) {
                fake.objects.set(name, { bytes: Buffer.concat(chunks), generation: "2" });
                callback();
              },
            });
          },
          async getMetadata() {
            const object = fake.objects.get(name)!;
            return [{ size: object.bytes.length + (fake.badSize ? 1 : 0), generation: object.generation }];
          },
          createReadStream(range: { start: number; end: number }) {
            fake.calls.push({ name, generation: options?.generation, ...range });
            const object = fake.objects.get(name)!;
            if (options?.generation !== object.generation) throw new Error("Pinned generation no longer exists");
            if (fake.stallRead) return new Readable({ read() {} });
            return Readable.from([object.bytes.subarray(range.start,
              range.end + 1 + (fake.overRead ? 1 : 0) - (fake.shortRead ? 1 : 0))]);
          },
          async delete() {
            if (fake.failDelete) throw new Error("Synthetic cleanup failure");
            fake.objects.delete(name);
          },
        };
      },
    },
  }),
}));

import { createBackupCloudStage, MAX_BACKUP_RANGE_BYTES } from "./backup-cloud-staging";

beforeEach(() => {
  fake.objects.clear();
  fake.calls.length = 0;
  fake.failDelete = fake.badSize = fake.overRead = fake.shortRead = fake.stallRead = false;
});
afterEach(() => vi.useRealTimers());

async function sealedStage() {
  const before = fake.objects.size;
  const stage = await createBackupCloudStage("non-production", 60_000, new AbortController().signal);
  expect(fake.objects.size).toBe(before + 1);
  const writer = stage.open();
  writer.end(Buffer.from("exact encrypted fixture bytes"));
  await finished(writer);
  await stage.seal(29);
  return stage;
}

describe("private cloud backup staging", () => {
  it("registers cleanup before writing, pins reads and removes a sealed stage", async () => {
    const stage = await sealedStage();
    expect(await stage.readChunk(0, 5)).toEqual(Buffer.from("exact"));
    expect(fake.calls[0]).toMatchObject({ generation: "2", start: 0, end: 4 });
    await stage.cleanup();
    expect(fake.objects.size).toBe(0);
  });

  it("refuses unsealed and oversized reads", async () => {
    const stage = await createBackupCloudStage("non-production", 60_000, new AbortController().signal);
    await expect(stage.readChunk(0, 1)).rejects.toThrow(/not been sealed/);
    await stage.cleanup();
    const sealed = await sealedStage();
    await expect(sealed.readChunk(0, MAX_BACKUP_RANGE_BYTES + 1)).rejects.toThrow(/Invalid/);
    await expect(sealed.readChunk(-1, 2)).rejects.toThrow(/Invalid/);
    await sealed.cleanup();
  });

  it("rejects an unverified cloud object size and retains its cleanup lease", async () => {
    const stage = await createBackupCloudStage("non-production", 60_000, new AbortController().signal);
    const writer = stage.open();
    writer.end(Buffer.from("bytes"));
    await finished(writer);
    fake.badSize = true;
    await expect(stage.seal(5)).rejects.toThrow(/size or generation/);
    await stage.cleanup();
    expect([...fake.objects.keys()]).toEqual([expect.stringContaining("/leases/")]);
  });

  it("does not hide cleanup failures or lose the durable retry marker", async () => {
    const stage = await sealedStage();
    fake.failDelete = true;
    await expect(stage.cleanup()).resolves.toBeUndefined();
    expect(fake.objects.size).toBe(2);
    fake.failDelete = false;
    await stage.cleanup();
    expect(fake.objects.size).toBe(0);
  });

  it("reconciles only expired leases in its own namespace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const old = await sealedStage();
    const oldArchive = [...fake.objects.keys()].find(name => name.includes("/archives/"))!;
    const foreign = ".labtrax-backup-staging/synthetic/production/archives/foreign.zip.enc";
    fake.objects.set(foreign, { bytes: Buffer.from("untouched"), generation: "7" });
    const active = await createBackupCloudStage("non-production", 60_000, new AbortController().signal);
    expect(fake.objects.has(oldArchive)).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 60_001);
    const next = await createBackupCloudStage("non-production", 60_000, new AbortController().signal);
    expect(fake.objects.has(oldArchive)).toBe(false);
    expect(fake.objects.has(foreign)).toBe(true);
    await next.cleanup();
    await active.cleanup();
    await old.cleanup();
  });

  it("does not substitute a newer generation", async () => {
    const stage = await sealedStage();
    const name = [...fake.objects.keys()].find(key => key.includes("/archives/"))!;
    fake.objects.get(name)!.generation = "3";
    await expect(stage.readChunk(0, 5)).rejects.toThrow(/Pinned generation/);
    await stage.cleanup();
  });

  it("fails before allocating storage when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createBackupCloudStage("non-production", 60_000, controller.signal)).rejects.toThrow();
    expect(fake.objects.size).toBe(0);
  });

  it("fails if a range response exceeds its requested byte bound", async () => {
    const stage = await sealedStage();
    fake.overRead = true;
    await expect(stage.readChunk(0, 5)).rejects.toThrow(/bounded size/);
    await stage.cleanup();
  });

  it("refuses a truncated range", async () => {
    const stage = await sealedStage();
    fake.shortRead = true;
    await expect(stage.readChunk(0, 5)).rejects.toThrow(/truncated/);
    await stage.cleanup();
  });

  it("aborts a stalled range rather than holding the job indefinitely", async () => {
    const controller = new AbortController();
    const stage = await createBackupCloudStage("non-production", 60_000, controller.signal);
    const writer = stage.open();
    writer.end(Buffer.from("bytes"));
    await finished(writer);
    await stage.seal(5);
    fake.stallRead = true;
    const rejection = expect(stage.readChunk(0, 5)).rejects.toThrow(/aborted/);
    controller.abort();
    await rejection;
    await stage.cleanup();
  });

  it("bounds an idle cloud range independently of the whole job deadline", async () => {
    vi.useFakeTimers();
    const stage = await sealedStage();
    fake.stallRead = true;
    const rejection = expect(stage.readChunk(0, 5)).rejects.toThrow(/stalled/);
    await vi.advanceTimersByTimeAsync(60_001);
    await rejection;
    await stage.cleanup();
  });

  it("refuses a writer that closed before finishing and retains cleanup evidence", async () => {
    const stage = await createBackupCloudStage("non-production", 60_000, new AbortController().signal);
    const writer = stage.open();
    writer.destroy();
    await finished(writer).catch(() => undefined);
    await expect(stage.seal(10)).rejects.toThrow(/did not finish/);
    await stage.cleanup();
    expect([...fake.objects.keys()]).toEqual([expect.stringContaining("/leases/")]);
  });
});
