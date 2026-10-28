import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { File } from "@google-cloud/storage";
import { writeProductionObject, writeProductionObjectStream, deleteProductionObject, openPinnedProductionObject } from "./production-media-object-write";
import { productionMediaDiskStorage } from "./production-media-multipart";
import { requireIsolatedRestoreTest } from "./restore-test-isolation";
import { PRODUCTION_MEDIA_JOURNAL_SCHEMA_SQL, readProductionMediaJournalRange } from "./production-media-journal";
import { journalMatchesPath, mediaReceiptMatches } from "./production-content-protection";
import { planBackupMedia } from "./backup-media-producer";
import { MEDIA_WRITERS, lockMediaCheckpoint, unlockMediaCheckpoint, mutateProductionMedia, unresolvedMediaWrites,
  collectMediaMutationReceipts, validateRecoveryMediaReceipts } from "./production-media-mutation";
import { writeProductionUpload, deleteProductionUpload, openPinnedLocalMedia, localMediaIdentity } from "./production-media-local-write";

requireIsolatedRestoreTest();
let root: string;
const read = async (input: AsyncIterable<Uint8Array>) => {
  const chunks: Buffer[] = [];
  for await (const bytes of input) chunks.push(Buffer.from(bytes));
  return Buffer.concat(chunks);
};
describe("durable source media mutation boundary (owned isolated PostgreSQL)", () => {
  beforeAll(async () => {
    await pool.query(PRODUCTION_MEDIA_JOURNAL_SCHEMA_SQL);
    root = await fs.mkdtemp(join(tmpdir(), "labtrax-synthetic-media-writers-"));
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("retains byte-identical picture/PDF/video generations across same-key replacement and removal", async () => {
    const bodies = [Buffer.from("\x89PNG\r\nsynthetic-picture"), Buffer.from("%PDF-1.7\nsynthetic-pdf"),
      Buffer.concat([Buffer.from("synthetic-ftypmp42"), Buffer.alloc(256 * 1024, 0x13)])];
    for (const [index, original] of bodies.entries()) {
      const file = join(root, "case-media", `synthetic-${index}.bin`);
      await writeProductionUpload(file, original, "case-upload");
      const version = localMediaIdentity(await fs.lstat(file));
      const changed = Buffer.from(original).fill(0x24);
      await writeProductionUpload(file, changed, "case-import");
      const replacement = localMediaIdentity(await fs.lstat(file));
      expect(await read(openPinnedLocalMedia(file, version))).toEqual(original);
      expect(await read(openPinnedLocalMedia(file, replacement))).toEqual(changed);
      await deleteProductionUpload(file, "case-upload");
      expect(await read(openPinnedLocalMedia(file, version))).toEqual(original);
      expect(await read(openPinnedLocalMedia(file, replacement))).toEqual(changed);
      expect(await fs.lstat(file).catch(() => null)).toBeNull();
    }
    expect(await unresolvedMediaWrites(pool)).toBe(0);
  });

  it("records failed/interrupted intents durably, appends no success, and resolves a successful retry without deleting evidence", async () => {
    const key = "case-media/synthetic-interrupted.bin";
    const before = (await pool.query("SELECT count(*)::int AS n FROM labtrax_production_media_journal WHERE object_key=$1", [key])).rows[0].n;
    await expect(mutateProductionMedia(key, "case-upload", "replace", async () => {
      throw new Error("synthetic interrupted body");
    })).rejects.toThrow("synthetic interrupted body");
    expect(await unresolvedMediaWrites(pool)).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM labtrax_production_media_journal WHERE object_key=$1", [key])).rows[0].n).toBe(before);
    await mutateProductionMedia(key, "case-upload", "replace", async () =>
      ({ value: undefined, generation: "synthetic-finalized", bytes: 10 }));
    expect(await unresolvedMediaWrites(pool)).toBe(0);
    const states = (await pool.query("SELECT state FROM labtrax_production_media_write_intents WHERE object_key=$1 ORDER BY created_at", [key])).rows.map(r => r.state);
    expect(states).toEqual(["superseded", "complete"]);
  });

  it("blocks source mutation during checkpoint pinning and serializes two writers at the same key", async () => {
    const checkpoint = await pool.connect();
    let release!: () => void;
    const bodyGate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
      await lockMediaCheckpoint(checkpoint);
      first = mutateProductionMedia("case-media/synthetic-concurrent.bin", "case-upload", "replace", async () => {
        entered("first"); await bodyGate;
        return { value: undefined, generation: "first", bytes: 1 };
      });
      await vi.waitFor(async () => expect((await checkpoint.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n).toBeGreaterThan(0));
      expect(entered).not.toHaveBeenCalled();
      await unlockMediaCheckpoint(checkpoint);
      await vi.waitFor(() => expect(entered).toHaveBeenCalledWith("first"));
      second = mutateProductionMedia("case-media/synthetic-concurrent.bin", "case-upload", "replace", async () => {
        entered("second"); return { value: undefined, generation: "second", bytes: 1 };
      });
      await vi.waitFor(async () => expect((await checkpoint.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n).toBeGreaterThan(0));
      expect(entered.mock.calls).toEqual([["first"]]);
      release(); await Promise.all([first, second]);
      expect(entered.mock.calls).toEqual([["first"], ["second"]]);
    } finally {
      release();
      await unlockMediaCheckpoint(checkpoint);
      await Promise.allSettled([first, second].filter(Boolean));
      checkpoint.release();
    }
  });

  it("retries an interrupted preservation copy without poisoning the canonical version or changing the original", async () => {
    const file = join(root, "case-media", "synthetic-copy-interruption.pdf");
    const original = Buffer.from("%PDF-original");
    await writeProductionUpload(file, original, "case-upload");
    const version = localMediaIdentity(await fs.lstat(file));
    const spy = vi.spyOn(fs, "copyFile").mockImplementationOnce(async (_source, destination) => {
      await fs.writeFile(destination, "partial-copy");
      throw new Error("synthetic preservation interruption");
    });
    try {
      await expect(writeProductionUpload(file, Buffer.from("%PDF-new"), "case-import")).rejects.toThrow("synthetic preservation");
      expect(await fs.readFile(file)).toEqual(original);
    } finally { spy.mockRestore(); }
    await writeProductionUpload(file, Buffer.from("%PDF-new"), "case-import");
    expect(await read(openPinnedLocalMedia(file, version))).toEqual(original);
    expect(await unresolvedMediaWrites(pool)).toBe(0);
  });

  it("finalizes inside a record transaction without counter deadlock, then publishes exactly once after restart", async () => {
    const checkpoint = await pool.connect();
    await lockMediaCheckpoint(checkpoint);
    await unlockMediaCheckpoint(checkpoint);
    const before = (await checkpoint.query("SELECT high_water::text FROM labtrax_production_media_journal_counter WHERE singleton")).rows[0].high_water as string;
    checkpoint.release();
    const record = await pool.connect();
    const key = "case-media/synthetic-counter-transaction.png";
    const file = join(root, key);
    let write: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await record.query("BEGIN");
      await record.query("SELECT labtrax_production_media_journal_append('add', $1, 'synthetic-record')", [key]);
      write = writeProductionUpload(file, Buffer.from("synthetic record transaction media"), "case-upload");
      await Promise.race([write, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("writer waited on its calling record counter")), 3000);
      })]);
      expect(await fs.readFile(file, "utf8")).toBe("synthetic record transaction media");
    } finally {
      if (timeout) clearTimeout(timeout);
      await record.query("ROLLBACK");
      await write?.catch(() => undefined);
      record.release();
    }
    const restarted = await pool.connect();
    try {
      await lockMediaCheckpoint(restarted);
      const journal = await readProductionMediaJournalRange(restarted, before);
      expect(journal.events).toHaveLength(1);
      const receipt = journal.events[0]!;
      expect(receipt.objectKey).toBe(key);
      const planned = await planBackupMedia(join(root, "case-media"), []);
      const source = planned.sourceVersions.find(source => source.relativeName === "synthetic-counter-transaction.png")!;
      expect(journalMatchesPath(source.archivePath, receipt.objectKey)).toBe(true);
      expect(mediaReceiptMatches(source.sourceVersion!, receipt.sourceGeneration)).toBe(true);
      expect(mediaReceiptMatches(source.sourceVersion!, undefined)).toBe(false);
      expect(journalMatchesPath("private-objects/lab-logos/synthetic.png", "private-objects/lab-logos/synthetic.png")).toBe(true);
      expect(journalMatchesPath("local-uploads/profile-photos/synthetic.jpg", "local-uploads/profile-photos/synthetic.jpg")).toBe(true);
      await unlockMediaCheckpoint(restarted);
      await lockMediaCheckpoint(restarted);
      expect((await readProductionMediaJournalRange(restarted, journal.throughPosition)).events).toHaveLength(0);
      await unlockMediaCheckpoint(restarted);
      await fs.writeFile(file, "untracked replacement of different bytes");
      expect(mediaReceiptMatches(`local:${localMediaIdentity(await fs.lstat(file))}`, receipt.sourceGeneration)).toBe(false);
    } finally {
      await unlockMediaCheckpoint(restarted).catch(() => undefined);
      restarted.release();
    }
  });

  it("promotes completed multipart content through the real boundary and refuses truncated bodies", async () => {
    const directory = join(root, "case-media");
    const storage = productionMediaDiskStorage({
      destination: directory, filename: (_req, file, cb) => cb(null, file.originalname),
    }, "case-upload");
    const handle = (name: string, truncated: boolean) => new Promise<Partial<Express.Multer.File>>((resolve, reject) => {
      const stream = Object.assign(Readable.from([Buffer.from("synthetic-multipart")]), { truncated });
      storage._handleFile({} as Parameters<typeof storage._handleFile>[0],
        { fieldname: "file", originalname: name, encoding: "7bit", mimetype: "application/octet-stream",
          size: 0, destination: "", filename: name, path: "", buffer: Buffer.alloc(0), stream },
        (error, info) => error ? reject(error) : resolve(info!));
    });
    const completed = await handle("synthetic-multipart.png", false);
    expect(await fs.readFile(completed.path!, "utf8")).toBe("synthetic-multipart");
    await expect(handle("synthetic-truncated.png", true)).rejects.toThrow("truncated");
    expect(await fs.lstat(join(directory, "synthetic-truncated.png")).catch(() => null)).toBeNull();
    expect(await unresolvedMediaWrites(pool)).toBe(0);
  });

  it("reconciles exact recovery receipts without accepting duplicates or unrelated writer rows", async () => {
    const recovered = await collectMediaMutationReceipts(async () => {
      await writeProductionUpload(join(root, "case-media", "recovery-receipt.png"), Buffer.from("synthetic restored image"), "private-recovery");
    });
    expect(recovered.ids).toHaveLength(1);
    await expect(validateRecoveryMediaReceipts(recovered.ids)).resolves.toBeUndefined();
    await expect(validateRecoveryMediaReceipts([...recovered.ids, ...recovered.ids])).rejects.toThrow("Duplicate");
    const unrelated = await collectMediaMutationReceipts(async () => {
      await writeProductionUpload(join(root, "case-media", "unrelated-receipt.png"), Buffer.from("synthetic ordinary image"), "case-upload");
    });
    await expect(validateRecoveryMediaReceipts(unrelated.ids)).rejects.toThrow("verification failed");
    await expect(validateRecoveryMediaReceipts(["00000000-0000-0000-0000-000000000000"])).rejects.toThrow("verification failed");
    await expect(writeProductionUpload(join(root, "unregistered.png"), Buffer.from("synthetic"), "case-upload"))
      .rejects.toThrow("Unregistered durable local upload namespace");
  });

  it("accepts every registered durable writer family through the same executed version boundary", async () => {
    for (const writer of MEDIA_WRITERS) {
      const file = join(root, "case-media", `synthetic-family-${writer}.bin`);
      const original = Buffer.from(`synthetic first version: ${writer}`);
      await writeProductionUpload(file, original, writer);
      const version = localMediaIdentity(await fs.lstat(file));
      await writeProductionUpload(file, Buffer.from(`synthetic replacement: ${writer}`), writer);
      expect(await read(openPinnedLocalMedia(file, version))).toEqual(original);
    }
    expect(await unresolvedMediaWrites(pool)).toBe(0);
  });

  it("preserves generation-pinned private object bytes through buffer/stream replacements and removal", async () => {
    const objects = new Map<string, { data: Buffer; generation: string }>();
    let next = 0;
    const error = (code: number) => Object.assign(new Error("synthetic object condition"), { code });
    const bucket = { file: (name: string, options?: { generation?: string | number }): unknown => {
      const current = () => {
        const value = objects.get(name);
        if (!value || (options?.generation && String(options.generation) !== value.generation)) throw error(404);
        return value;
      };
      const set = (data: Buffer, match: string | number) => {
        if (String(match) !== (objects.get(name)?.generation ?? "0")) throw error(412);
        objects.set(name, { data: Buffer.from(data), generation: String(++next) });
      };
      return {
        name, bucket,
        async getMetadata() {
          const value = current();
          return [{ size: String(value.data.length), generation: value.generation,
            md5Hash: createHash("md5").update(value.data).digest("base64") }];
        },
        async save(data: Buffer, opts: { preconditionOpts: { ifGenerationMatch: string | number } }) {
          set(data, opts.preconditionOpts.ifGenerationMatch);
        },
        async copy(destination: { name: string }) {
          const value = current();
          if (objects.has(destination.name)) throw error(412);
          objects.set(destination.name, { data: Buffer.from(value.data), generation: String(++next) });
        },
        async delete(opts: { ifGenerationMatch: string | number }) {
          if (String(opts.ifGenerationMatch) !== current().generation) throw error(412);
          objects.delete(name);
        },
        createReadStream() { return Readable.from((async function* () { yield current().data; })()); },
        createWriteStream(opts: { preconditionOpts: { ifGenerationMatch: string | number } }) {
          const chunks: Buffer[] = [];
          return new Writable({
            write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
            final(done) {
              try { set(Buffer.concat(chunks), opts.preconditionOpts.ifGenerationMatch); done(); }
              catch (e) { done(e as Error); }
            },
          });
        },
      };
    }};
    const file = bucket.file("synthetic-private/case-media/synthetic-video.mp4") as File;
    const original = Buffer.from("synthetic-picture-pdf-video-original");
    await writeProductionObject(file, "case-media/synthetic-video.mp4", "case-media", original, {});
    const [before] = await file.getMetadata();
    const changed = Buffer.from(original).fill(0x33);
    await writeProductionObjectStream(file, "case-media/synthetic-video.mp4", "private-recovery", Readable.from([changed]), {});
    expect(await read(openPinnedProductionObject(file, String(before.generation), before))).toEqual(original);
    const [replacement] = await file.getMetadata();
    const interrupted = Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("synthetic stream interruption"); })());
    await expect(writeProductionObjectStream(file, "case-media/synthetic-video.mp4", "private-recovery", interrupted, {})).rejects.toThrow("interruption");
    expect(await read(openPinnedProductionObject(file, String(replacement.generation), replacement))).toEqual(changed);
    await writeProductionObject(file, "case-media/synthetic-video.mp4", "case-media", changed, {});
    await deleteProductionObject(file, "case-media/synthetic-video.mp4", "case-media");
    expect(await read(openPinnedProductionObject(file, String(before.generation), before))).toEqual(original);
    expect(await read(openPinnedProductionObject(file, String(replacement.generation), replacement))).toEqual(changed);
    expect(await unresolvedMediaWrites(pool)).toBe(0);
  });
});
