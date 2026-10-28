import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createWriteStream, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { planBackupMedia, type BackupFileEvidence } from "./backup-media-producer";
import type { CaseMediaBackupObject } from "./case-media-object-storage";

const database = vi.hoisted(() => ({
  query: vi.fn(() => {
    throw new Error("Media producer unit tests must not access a database.");
  }),
}));
const phaseLogs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: database }));
vi.mock("./logger", () => ({ logger: phaseLogs }));

describe("bounded full-media archive producer", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "backup-producer-test-")); });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    expect(database.query).not.toHaveBeenCalled();
  });

  async function build(
    objects: CaseMediaBackupObject[],
    signal?: AbortSignal,
    maxConcurrentFiles?: number,
    onFile?: (file: BackupFileEvidence) => void,
  ) {
    const media = await planBackupMedia(path.join(root, "local"), objects, signal, { onFile });
    const archive = archiver("zip", { zlib: { level: 1 } });
    const output = path.join(root, "archive.zip");
    const sink = createWriteStream(output);
    const flushed = finished(sink);
    archive.on("error", (error) => sink.destroy(error));
    archive.pipe(sink);
    try {
      await media.append(archive, maxConcurrentFiles);
      await archive.finalize();
      await flushed;
      return { media, zip: new AdmZip(readFileSync(output)) };
    } catch (error) {
      archive.destroy();
      sink.destroy();
      await flushed.catch(() => undefined);
      throw error;
    }
  }

  it("streams pinned media into the archive without calling the local-copy path", async () => {
    const bytes = Buffer.from("original stream bytes");
    const copyTo = vi.fn(async () => { throw new Error("unexpected local copy"); });
    const { media, zip } = await build([{
      relativeName: "pinned.pdf", size: bytes.length, copyTo,
      openStream: () => Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
    }]);
    expect(media.fileCount).toBe(1);
    expect(copyTo).not.toHaveBeenCalled();
    expect(zip.getEntry("media/pinned.pdf")?.getData()).toEqual(bytes);
  });

  it("archives a 192 MiB media set without staging the whole tree; keeps all cloud/local/hidden bytes", async () => {
    await mkdir(path.join(root, "local", ".trash"), { recursive: true });
    await writeFile(path.join(root, "local", "source-0.bin"), "stale local cache");
    await writeFile(path.join(root, "local", ".trash", "recoverable.bin"), "local recovery");
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    let peakFilesOnDisk = 0;
    const paths: string[] = [];
    const objects: CaseMediaBackupObject[] = Array.from({ length: 24 }, (_, index) => ({
      relativeName: index === 23 ? ".trash/cloud-recovery.bin" : `source-${index}.bin`,
      size: bytes.length,
      async copyTo(target) {
        paths.push(target);
        await writeFile(target, bytes);
        peakFilesOnDisk = Math.max(peakFilesOnDisk, (await readdir(path.dirname(target))).length);
      },
    }));
    const { media, zip } = await build(objects);
    expect(media.fileCount).toBe(25);
    expect(media.totalBytes).toBe(24 * bytes.length + Buffer.byteLength("local recovery"));
    expect(peakFilesOnDisk).toBeLessThanOrEqual(12);
    expect(peakFilesOnDisk).toBeGreaterThan(0);
    for (const object of objects) expect(zip.getEntry(`media/${object.relativeName}`)?.getData().equals(bytes)).toBe(true);
    expect(zip.getEntry("media/.trash/recoverable.bin")?.getData().toString()).toBe("local recovery");
    await expect(readdir(path.dirname(paths[0]!))).rejects.toThrow();
  }, 90_000);

  it("preserves a production-sized object count without truncation or unbounded prefetch", async () => {
    const objects: CaseMediaBackupObject[] = Array.from({ length: 17_691 }, (_, index) => ({
      relativeName: `source-${index}.bin`, size: 1,
      copyTo: async (target) => { await writeFile(target, Buffer.from([index % 256])); },
    }));
    const { media, zip } = await build(objects);
    expect(media.fileCount).toBe(17_691);
    expect(zip.getEntries()).toHaveLength(17_691);
    expect(zip.getEntry("media/source-17690.bin")?.getData()[0]).toBe(17_690 % 256);
  }, 90_000);

  it("respects a capacity-planned lower prefetch limit while retaining every file", async () => {
    const bytes = Buffer.from("synthetic complete-backup payload");
    let active = 0;
    let peak = 0;
    const objects: CaseMediaBackupObject[] = Array.from({ length: 12 }, (_, index) => ({
      relativeName: `bounded-${index}.bin`,
      size: bytes.length,
      async copyTo(target) {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise(resolve => setTimeout(resolve, 5));
          await writeFile(target, bytes);
        } finally {
          active--;
        }
      },
    }));
    const { zip } = await build(objects, undefined, 3);
    expect(peak).toBe(3);
    expect(zip.getEntries()).toHaveLength(objects.length);
    for (const object of objects) {
      expect(zip.getEntry(`media/${object.relativeName}`)?.getData().equals(bytes)).toBe(true);
    }
  });

  it("measures synthetic slow media throughput at bounded concurrency and verifies every archived digest", async () => {
    const fileCount = 9;
    const bytesPerFile = 48 * 1024;
    const chunksPerFile = 6;
    const bytesByName = new Map<string, Buffer>();
    const results: Array<{
      concurrency: number;
      elapsedMs: number;
      endToEndBytesPerSecond: number;
      phaseThroughputBytesPerSecond: number;
      peak: number;
    }> = [];

    for (const concurrency of [1, 3, 6]) {
      let active = 0;
      let peak = 0;
      const objects: CaseMediaBackupObject[] = Array.from({ length: fileCount }, (_, index) => {
        const name = `slow-${index}.bin`;
        const bytes = Buffer.alloc(bytesPerFile, index + 1);
        bytesByName.set(name, bytes);
        return {
          relativeName: name,
          size: bytes.length,
          openStream() {
            return Readable.from((async function* () {
              active++;
              peak = Math.max(peak, active);
              try {
                for (let chunk = 0; chunk < chunksPerFile; chunk++) {
                  await new Promise(resolve => setTimeout(resolve, 5));
                  const start = Math.floor(bytes.length * chunk / chunksPerFile);
                  const end = Math.floor(bytes.length * (chunk + 1) / chunksPerFile);
                  yield bytes.subarray(start, end);
                }
              } finally {
                active--;
              }
            })());
          },
          async copyTo() { throw new Error("streamable synthetic objects must not use copyTo"); },
        };
      });
      const evidence: Array<{ archivePath: string; size: number; sha256: string }> = [];
      const previousLogCount = phaseLogs.info.mock.calls.length;
      const startedAt = Date.now();
      const { zip } = await build(objects, undefined, concurrency, file => evidence.push(file));
      const elapsedMs = Date.now() - startedAt;
      const totalBytes = fileCount * bytesPerFile;
      const completion = phaseLogs.info.mock.calls
        .slice(previousLogCount)
        .map(([record, message]) => ({ record, message }))
        .find(({ record, message }) => record.phase === "case-media transfer into archive" &&
          message === "[backup] phase completed");
      expect(completion?.record).toMatchObject({ fileCount, totalBytes, completedBytes: totalBytes });
      results.push({
        concurrency,
        elapsedMs,
        endToEndBytesPerSecond: Math.round(totalBytes / Math.max(1, elapsedMs / 1000)),
        phaseThroughputBytesPerSecond: completion!.record.throughputBytesPerSecond,
        peak,
      });

      expect(peak).toBeLessThanOrEqual(concurrency);
      expect(peak).toBe(concurrency);
      expect(zip.getEntries()).toHaveLength(fileCount);
      expect(evidence).toHaveLength(fileCount);
      for (const [name, bytes] of bytesByName) {
        const entry = zip.getEntry(`media/${name}`);
        expect(entry?.getData()).toEqual(bytes);
        expect(evidence).toContainEqual({
          archivePath: `media/${name}`,
          relativeName: name,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          generation: undefined,
          metadata: undefined,
        });
      }
    }

    expect(results.map(result => result.concurrency)).toEqual([1, 3, 6]);
    expect(results.every(result => result.elapsedMs > 0 && result.endToEndBytesPerSecond > 0 &&
      result.phaseThroughputBytesPerSecond > 0)).toBe(true);
    expect(results[1]!.elapsedMs).toBeLessThan(results[0]!.elapsedMs);
    expect(results[2]!.elapsedMs).toBeLessThan(results[1]!.elapsedMs);
    console.info("Synthetic case-media transfer phase measurements", results);
  }, 30_000);

  it("aborts a stalled/failed source, rejects the whole archive, and removes every temporary file", async () => {
    const controller = new AbortController();
    let stagedPath: string | undefined;
    const completedEvidence: unknown[] = [];
    const promise = build([{
      relativeName: "source.bin", size: 100,
      async copyTo(target, signal) {
        stagedPath = target;
        await writeFile(target, "partial");
        controller.abort();
        if (signal?.aborted) throw new Error("Source read aborted");
      },
    }], controller.signal, undefined, file => completedEvidence.push(file));
    await expect(promise).rejects.toThrow("case-media transfer into archive");
    expect(completedEvidence).toHaveLength(0);
    expect(stagedPath).toBeDefined();
    await expect(readdir(path.dirname(stagedPath!))).rejects.toThrow();
  });

  it("fails rather than silently skipping a local file that disappears after inventory", async () => {
    const local = path.join(root, "local");
    await mkdir(local);
    const file = path.join(local, "referenced.bin");
    await writeFile(file, "local bytes");
    const media = await planBackupMedia(local, []);
    await rm(file);
    const archive = archiver("zip");
    archive.resume();
    try {
      await expect(media.append(archive)).rejects.toThrow("case-media transfer into archive");
    } finally { archive.destroy(); }
  });
});
