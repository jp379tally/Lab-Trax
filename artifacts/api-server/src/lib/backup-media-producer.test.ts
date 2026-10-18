import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createWriteStream, readFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { planBackupMedia } from "./backup-media-producer";
import type { CaseMediaBackupObject } from "./case-media-object-storage";

describe("bounded full-media archive producer", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "backup-producer-test-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function build(objects: CaseMediaBackupObject[], signal?: AbortSignal, maxConcurrentFiles?: number) {
    const media = await planBackupMedia(path.join(root, "local"), objects, signal);
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

  it("aborts a stalled/failed source, rejects the whole archive, and removes every temporary file", async () => {
    const controller = new AbortController();
    let stagedPath: string | undefined;
    const promise = build([{
      relativeName: "source.bin", size: 100,
      async copyTo(target, signal) {
        stagedPath = target;
        await writeFile(target, "partial");
        controller.abort();
        if (signal?.aborted) throw new Error("Source read aborted");
      },
    }], controller.signal);
    await expect(promise).rejects.toThrow("case-media transfer into archive");
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
