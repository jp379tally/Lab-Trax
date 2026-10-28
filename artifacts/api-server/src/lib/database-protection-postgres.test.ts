import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireIsolatedRestoreTest } from "./restore-test-isolation";
import { resolvePostgresTool } from "./pg-tools";
import { protectDatabase, verifyDatabasePoint, type DatabaseObjectStore } from "./database-protection";
import { restoreDatabasePointIsolated } from "./database-protection-restore";
import { encryptBuffer, decryptBuffer } from "./backup";
import { protectProduction, verifyProductionPoint } from "./production-content-protection";
import { restoreProductionPointIsolated } from "./production-content-restore";

requireIsolatedRestoreTest();
const codec = { encrypt: encryptBuffer, decrypt: decryptBuffer };
const source = "c".repeat(64);
const objects = new Map<string, Buffer>();
const createdAt = new Map<string, string>();
const store: DatabaseObjectStore = {
  list: async () => [...objects.keys()].map(name => ({ name, createdAt: createdAt.get(name) ?? null })),
  get: async name => objects.get(name) ?? null,
  put: async (name, bytes) => {
    if (objects.has(name)) throw new Error("Synthetic overwrite forbidden");
    objects.set(name, Buffer.from(bytes));
    createdAt.set(name, new Date().toISOString());
  },
  delete: async name => { objects.delete(name); createdAt.delete(name); },
};
let admin: pg.Client, sourceClient: pg.Client, sourceUrl: string, scratch: string;
const created: string[] = [];
async function newDatabase(): Promise<string> {
  const name = `labtrax_db_rehearsal_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  created.push(name);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}
async function capture(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePostgresTool("pg_dump"), ["--format=custom", `--dbname=${sourceUrl}`]);
    const parts: Buffer[] = [];
    child.stdout.on("data", part => parts.push(Buffer.from(part)));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error("Synthetic dump failed")));
  });
}
describe("real PostgreSQL database-only incremental recovery", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    sourceUrl = await newDatabase();
    sourceClient = new pg.Client({ connectionString: sourceUrl });
    await sourceClient.connect();
    await sourceClient.query(`
      CREATE TABLE parent (id integer PRIMARY KEY, label text NOT NULL);
      CREATE TABLE child (id integer PRIMARY KEY, parent_id integer REFERENCES parent(id), value text);
      CREATE TABLE unchanged (id integer PRIMARY KEY, payload bytea);
      CREATE TABLE retired_table (id integer PRIMARY KEY);
      INSERT INTO parent VALUES (1, 'synthetic original'), (2, 'synthetic removed');
      INSERT INTO child VALUES (1, 1, 'synthetic child'), (2, 2, 'synthetic removed');
    `);
    await sourceClient.query("INSERT INTO unchanged VALUES (1, $1)", [randomBytes(5 * 1024 * 1024)]);
    scratch = await mkdtemp(join(tmpdir(), "labtrax-database-media-sentinel-"));
    await writeFile(join(scratch, "synthetic-media"), "preserve existing media");
  }, 60_000);
  afterAll(async () => {
    await sourceClient?.end();
    for (const name of created.reverse()) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin?.end();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });
  it("restores coherent production records and exact media versions, preserving prior points through interruption/retry", async () => {
    const mediaObjects = new Map<string, Buffer>(), databaseObjects = new Map<string, Buffer>();
    const objectStore = (map: Map<string, Buffer>): DatabaseObjectStore => ({
      list: async () => [...map.keys()].map(name => ({ name, createdAt: null })), get: async name => map.get(name) ?? null,
      getIntegrity: async name => {
        const bytes = map.get(name);
        return bytes ? { bytes: bytes.length, sha1: null, sha256: null } : null;
      },
      getVersion: async name => {
        const bytes = map.get(name);
        return bytes ? {
          provider: "onedrive-content-v1", driveId: "synthetic-drive",
          itemId: `immutable-${name}`, contentTag: "synthetic-immutable-version", bytes: bytes.length,
        } : null;
      },
      put: async (name, b) => { if (map.has(name)) throw new Error("No overwrite"); map.set(name, Buffer.from(b)); },
      delete: async name => { map.delete(name); },
    });
    const options = { source, codec, store: objectStore(mediaObjects), databaseStore: objectStore(databaseObjects) };
    await sourceClient.query("CREATE TABLE content_version(id int PRIMARY KEY, label text); INSERT INTO content_version VALUES(1,'synthetic baseline'),(2,'synthetic removed')");
    const original = randomBytes(1024 * 1024 + 7);
    const originalVideo = randomBytes(1500);
    const originalAttachment = Buffer.from("%PDF-1.4\nSynthetic attachment recovery fixture\n%%EOF\n");
    const files = new Map([["case-media/synthetic-photo.png", original],
      ["private-objects/synthetic-video.mp4", originalVideo],
      ["case-media/synthetic-attachment.pdf", originalAttachment]]);
    const mediaVersions = new Map([...files.keys()].map(path => [path, 1]));
    let dump: Buffer;
    const protect = () => protectProduction({ ...options,
      capture: async () => { dump = await capture(); return dump; },
      captureMedia: async (write, selectPaths) => {
        const sourceVersions = [...files].map(([archivePath, bytes]) => ({
          archivePath, size: bytes.length, sourceVersion: `synthetic:${mediaVersions.get(archivePath)}`,
        }));
        const selected = selectPaths(sourceVersions);
        for (const [path, bytes] of files) {
          if (selected.has(path)) await write(path, Readable.from([bytes]), `synthetic:${mediaVersions.get(path)}`);
        }
        return { sourceVersions, missingReferences: ["case-media/synthetic-historical-missing.pdf"],
          evidence: { databaseSha256: createHash("sha256").update(dump).digest("hex") } };
      } });
    const baseline = await protect();
    await sourceClient.query("UPDATE content_version SET label='synthetic changed' WHERE id=1; DELETE FROM content_version WHERE id=2; INSERT INTO content_version VALUES(3,'synthetic new'); ALTER TABLE content_version ADD COLUMN new_field int DEFAULT 7");
    const replacement = randomBytes(1024 + 9);
    files.set("case-media/synthetic-photo.png", replacement);
    mediaVersions.set("case-media/synthetic-photo.png", 2);
    files.delete("private-objects/synthetic-video.mp4");
    mediaVersions.delete("private-objects/synthetic-video.mp4");
    const put = options.store.put;
    options.store.put = async (name, b) => {
      if (name.startsWith("verified-")) throw new Error("Synthetic interrupted commit");
      await put(name, b);
    };
    await expect(protect()).rejects.toThrow("interrupted");
    expect((await verifyProductionPoint(options, baseline.marker)).root.point).toBe(baseline.root.point);
    options.store.put = put;
    const changed = await protect();
    for (const point of [baseline, changed]) {
      const mediaRoot = await mkdtemp(join(tmpdir(), "labtrax-content-rehearsal-"));
      const targetUrl = await newDatabase();
      try {
        const result = await restoreProductionPointIsolated({ ...options, marker: point.marker,
          targetUrl, mediaRoot, isolationAcknowledged: true });
        expect(result.coverage).toBe("partial");
        expect(result.missingFiles).toBe(1);
        const restored = new pg.Client({ connectionString: targetUrl });
        await restored.connect();
        try {
          const rows = await restored.query("SELECT * FROM content_version ORDER BY id");
          expect(rows.rows.map(r => r.id)).toEqual(point === baseline ? [1, 2] : [1, 3]);
          if (point === changed) { expect(rows.rows[0].new_field).toBe(7); expect(rows.rows[0].label).toBe("synthetic changed"); }
        } finally { await restored.end(); }
        expect((await readFile(join(mediaRoot, "case-media/synthetic-attachment.pdf"))).equals(originalAttachment)).toBe(true);
        expect((await readFile(join(mediaRoot, "case-media/synthetic-photo.png"))).equals(point === baseline ? original : replacement)).toBe(true);
        if (point === changed) await expect(readFile(join(mediaRoot, "private-objects/synthetic-video.mp4"))).rejects.toThrow();
        else expect((await readFile(join(mediaRoot, "private-objects/synthetic-video.mp4"))).equals(originalVideo)).toBe(true);
      } finally { await rm(mediaRoot, { recursive: true, force: true }); }
    }
    const dependency = `chunk-${changed.inventory.files[0]!.chunks[0]!.hash}.enc`;
    mediaObjects.delete(dependency);
    await expect(verifyProductionPoint(options, changed.marker)).rejects.toThrow(/missing/);
  }, 120_000);
  it("restores baseline and changes, including inserts/updates/deletes/FKs/schema removal, without media writes", async () => {
    const baseline = await protectDatabase({ store, codec, source, capture });
    await sourceClient.query(`
      BEGIN;
      UPDATE parent SET label = 'synthetic updated' WHERE id = 1;
      DELETE FROM child WHERE id = 2;
      DELETE FROM parent WHERE id = 2;
      ALTER TABLE child ADD COLUMN quantity integer NOT NULL DEFAULT 1;
      INSERT INTO parent VALUES (3, 'synthetic inserted');
      INSERT INTO child VALUES (3, 3, 'synthetic inserted', 7);
      DROP TABLE retired_table;
      CREATE INDEX child_parent_idx ON child(parent_id);
      COMMIT;
    `);
    const changed = await protectDatabase({ store, codec, source, capture });
    expect(changed.manifest.newChunks).toBeLessThan(changed.manifest.chunks.length);
    expect(changed.manifest.newBytes).toBeLessThan(changed.manifest.dumpBytes);
    expect(changed.manifest.previousPoint).toBe(baseline.manifest.point);
    for (const point of [baseline, changed]) {
      const targetUrl = await newDatabase();
      const result = await restoreDatabasePointIsolated({ store, codec, source,
        marker: point.marker, targetUrl, isolationAcknowledged: true });
      expect(result.mediaChanged).toBe(false);
      const restored = new pg.Client({ connectionString: targetUrl });
      await restored.connect();
      try {
        const rows = await restored.query("SELECT id FROM parent ORDER BY id");
        expect(rows.rows.map(row => row.id)).toEqual(point === baseline ? [1, 2] : [1, 3]);
        const orphanCount = await restored.query("SELECT count(*)::int AS n FROM child c LEFT JOIN parent p ON p.id=c.parent_id WHERE p.id IS NULL");
        expect(orphanCount.rows[0].n).toBe(0);
        if (point === changed) {
          expect((await restored.query("SELECT quantity FROM child WHERE id=3")).rows[0].quantity).toBe(7);
          expect((await restored.query("SELECT label FROM parent WHERE id=1")).rows[0].label).toBe("synthetic updated");
          expect((await restored.query("SELECT to_regclass('retired_table') AS relation")).rows[0].relation).toBe(null);
        }
      } finally { await restored.end(); }
    }
    expect(await readFile(join(scratch, "synthetic-media"), "utf8")).toBe("preserve existing media");
    // Required baseline chunks are still needed by later points and retained.
    for (const chunk of baseline.manifest.chunks) expect(objects.has(`chunk-${chunk.hash}.enc`)).toBe(true);
  }, 120_000);
  it("refuses a missing dependency before creating restored tables", async () => {
    const point = await protectDatabase({ store, codec, source, capture });
    const key = `chunk-${point.manifest.chunks[0]!.hash}.enc`;
    const bytes = objects.get(key)!;
    objects.delete(key);
    try {
      const targetUrl = await newDatabase();
      await expect(restoreDatabasePointIsolated({ store, codec, source, marker: point.marker,
        targetUrl, isolationAcknowledged: true })).rejects.toThrow(/missing/);
      const target = new pg.Client({ connectionString: targetUrl });
      await target.connect();
      try { expect((await target.query("SELECT to_regclass('parent') AS relation")).rows[0].relation).toBe(null); }
      finally { await target.end(); }
    } finally { objects.set(key, bytes); }
    expect((await verifyDatabasePoint(store, codec, source, point.marker)).manifest.point).toBe(point.manifest.point);
  }, 60_000);
  it("refuses an occupied disposable target instead of overwriting its records", async () => {
    const point = await protectDatabase({ store, codec, source, capture });
    const targetUrl = await newDatabase();
    const target = new pg.Client({ connectionString: targetUrl });
    await target.connect();
    try {
      await target.query("CREATE TABLE keep_me (id integer PRIMARY KEY); INSERT INTO keep_me VALUES (1)");
      await expect(restoreDatabasePointIsolated({ store, codec, source, marker: point.marker,
        targetUrl, isolationAcknowledged: true })).rejects.toThrow(/empty disposable/);
      expect((await target.query("SELECT count(*)::int AS n FROM keep_me")).rows[0].n).toBe(1);
    } finally { await target.end(); }
  }, 60_000);
});
