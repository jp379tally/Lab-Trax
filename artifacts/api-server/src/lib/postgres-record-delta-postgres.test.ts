import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { pool } from "@workspace/db";
import { captureCompleteBackup } from "./complete-backup";
import {
  lockMediaCheckpoint,
  unlockMediaCheckpoint,
} from "./production-media-mutation";
import { spawn } from "node:child_process";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireIsolatedRestoreTest } from "./restore-test-isolation";
import { resolvePostgresTool } from "./pg-tools";
import {
  capturePostgresRecordChanges,
  recordInventoryHash,
  type RecordInventory,
} from "./postgres-record-delta";
import {
  protectRecordDatabase,
  readRecordBodies,
  type RecordDatabaseCapture,
} from "./postgres-record-protection";
import { restoreDatabasePointIsolated } from "./database-protection-restore";
import {
  protectProduction,
  verifyProductionPoint,
} from "./production-content-protection";
import { restoreProductionPointIsolated } from "./production-content-restore";
import type { DatabaseObjectStore } from "./database-protection";

requireIsolatedRestoreTest();
function syntheticPng(width: number, height: number, tint = 0): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const kind = Buffer.from(name),
      crcInput = Buffer.concat([kind, data]);
    let crc = 0xffffffff;
    for (const byte of crcInput) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length);
    kind.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * (width * 3 + 1) + 1 + x * 3;
      rows[p] = (x + tint) & 255;
      rows[p + 1] = (y + tint) & 255;
      rows[p + 2] = tint;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sourceIdentity = "b".repeat(64),
  key = randomBytes(32);
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const codec = {
  encrypt: (bytes: Buffer) => {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", key, iv),
      body = Buffer.concat([c.update(bytes), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  },
  decrypt: (bytes: Buffer) => {
    const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    c.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([c.update(bytes.subarray(28)), c.final()]);
  },
};
function memoryStore() {
  const objects = new Map<string, Buffer>();
  let bodyBytesRead = 0,
    uploadedBytes = 0;
  const store: DatabaseObjectStore = {
    list: async () => [...objects.keys()].map(name => ({ name, createdAt: null })),
    delete: async name => { objects.delete(name); },
    get: async (name) => {
      const bytes = objects.get(name);
      if (bytes && name.startsWith("records-body-"))
        bodyBytesRead += bytes.length;
      return bytes ? Buffer.from(bytes) : null;
    },
    getIntegrity: async (name) => {
      const bytes = objects.get(name);
      return bytes
        ? { bytes: bytes.length, sha1: null, sha256: hash(bytes) }
        : null;
    },
    getVersion: async (name) => {
      const bytes = objects.get(name);
      return bytes
        ? {
            provider: "onedrive-content-v1",
            driveId: "isolated-synthetic-store",
            itemId: name,
            contentTag: hash(bytes),
            bytes: bytes.length,
          }
        : null;
    },
    put: async (name, bytes) => {
      if (objects.has(name)) throw new Error("No synthetic overwrite");
      objects.set(name, Buffer.from(bytes));
      uploadedBytes += bytes.length;
    },
  };
  return {
    store,
    objects,
    reads: () => bodyBytesRead,
    reset: () => {
      bodyBytesRead = 0;
    },
    uploads: () => uploadedBytes,
  };
}
let admin: pg.Client;
const created: string[] = [],
  clients: pg.Client[] = [];
async function database() {
  const name = `labtrax_db_rehearsal_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  created.push(name);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}
async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  return client;
}
const ddl = `
CREATE TABLE parent(id bigint PRIMARY KEY,label text NOT NULL,amount numeric(30,10));
CREATE TABLE child(id int PRIMARY KEY,parent_id bigint REFERENCES parent(id),reference text);
CREATE TABLE bag(label text,payload bytea);
CREATE TABLE generated(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,value int,doubled int GENERATED ALWAYS AS(value*2) STORED);
CREATE TABLE audit(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,record_id bigint);
CREATE FUNCTION audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO audit(record_id) VALUES(NEW.id);RETURN NEW;END$$;
CREATE TRIGGER fixture_audit AFTER UPDATE ON parent FOR EACH ROW EXECUTE FUNCTION audit_fixture();
CREATE TABLE partitioned(id int,value text) PARTITION BY RANGE(id);
CREATE TABLE partition_a PARTITION OF partitioned FOR VALUES FROM(0) TO(100);
INSERT INTO parent VALUES(9007199254740993,'before',12345678901234567890.1234567890),(2,'removed',0);
INSERT INTO child VALUES(1,9007199254740993,'case-media/picture.png'),(2,2,'case-media/document.pdf');
INSERT INTO bag VALUES('duplicate','\\x000102ff'),('duplicate','\\x000102ff');
INSERT INTO generated(value) VALUES(7);INSERT INTO partitioned VALUES(1,'original partition row');`;
async function dump(url: string, snapshot: string, format: "plain" | "custom") {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(resolvePostgresTool("pg_dump"), [
      `--dbname=${url}`,
      `--snapshot=${snapshot}`,
      `--format=${format}`,
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--quote-all-identifiers",
    ]);
    const pieces: Buffer[] = [];
    let size = 0;
    child.stderr.resume();
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 64 * 1024 * 1024) child.kill("SIGTERM");
      else pieces.push(b);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(pieces))
        : reject(new Error("Isolated schema export failed")),
    );
  });
}
async function capture(
  client: pg.Client,
  url: string,
  previous?: RecordInventory | null,
  referenceContract?: {
    protocol: string;
    extract: (table: string, row: Record<string, unknown>) => string[];
  },
): Promise<RecordDatabaseCapture> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snapshot = (
      await client.query<{ snapshot: string }>(
        "SELECT pg_export_snapshot() AS snapshot",
      )
    ).rows[0]!.snapshot;
    const records = await capturePostgresRecordChanges(client, {
      previous,
      schemaSql: async () =>
        (await dump(url, snapshot, "plain")).toString("utf8"),
      references: referenceContract?.extract ?? ((_table, row) =>
        typeof row.reference === "string" ? [row.reference] : []),
      referenceProtocol: referenceContract?.protocol,
    });
    return {
      kind: "labtrax-postgresql-record-delta-v1",
      records,
      schemaDump: records.delta ? null : await dump(url, snapshot, "custom"),
    };
  } finally {
    await client.query("ROLLBACK");
  }
}
async function compare(source: pg.Client, target: pg.Client) {
  for (const table of [
    "parent",
    "child",
    "bag",
    "generated",
    "audit",
    "partitioned",
    "partition_a",
  ]) {
    const q = `SELECT to_jsonb(t)::text AS row FROM ONLY "${table}" t ORDER BY 1`;
    expect((await target.query(q)).rows).toEqual((await source.query(q)).rows);
  }
}

describe("real isolated PostgreSQL record incrementals and media recovery", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
  });
  afterAll(async () => {
    for (const client of clients) await client.end();
    for (const name of created.reverse())
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.end();
  });
  it("restores new/changed/deleted rows, exact numeric/binary/generated/partition data and picture/PDF/video versions", async () => {
    const url = await database(),
      client = await connect(url);
    await client.query(ddl);
    const db = memoryStore(),
      media = memoryStore(),
      options = {
        store: media.store,
        databaseStore: db.store,
        codec,
        source: sourceIdentity,
      };
    const picture = syntheticPng(1024, 512),
      pdf = Buffer.from(
        "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MTAyNjE4MDQzNC0wNScwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MTAyNjE4MDQzNC0wNScwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTI5Cj4+CnN0cmVhbQpHYXBRaDBFPUYsMFVcSDNUXHBOWVReUUtrP3RjPklQLDtXI1UxXjIzaWhQRU1fP0NXNEtJU2k8IVs3YCNPQl9zS2k2Jl1xTjc9JDdBOy1odGpRdDpyS3FkKVhyM0ZoSDhxalhyTU5aRF48KSYoLi87NFdlTzlsOCEhKV1hOG5jfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAwMDQwMiAwMDAwMCBuIAowMDAwMDAwNDcwIDAwMDAwIG4gCjAwMDAwMDA3MzEgMDAwMDAgbiAKMDAwMDAwMDc5MCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzxiZWYwNGZjZGZkZDdkMTk2OGNmY2E3ZTk2YWExOTNkZT48YmVmMDRmY2RmZGQ3ZDE5NjhjZmNhN2U5NmFhMTkzZGU+XQolIFJlcG9ydExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDUgMCBSCi9Sb290IDQgMCBSCi9TaXplIDgKPj4Kc3RhcnR4cmVmCjEwMDkKJSVFT0YK",
        "base64",
      ),
      video = Buffer.from(
        "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN1bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAp90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABwm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAHZIAAB2SAAAABhzdHRzAAAAAAAAAAEAAAAFAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAUAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAALFAAAADAAAAAwAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOlAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAAv1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiRsQr/+wAAAAAhBnkJ4hf/BgQAAAAgBnmF0Qr/EgAAAAAgBnmNqQr/EgQ==",
        "base64",
      );
    const files = new Map([
        ["case-media/picture.png", picture],
        ["case-media/document.pdf", pdf],
        ["private-objects/video.mp4", video],
      ]),
      versions = new Map([...files.keys()].map((name) => [name, 1]));
    let current: RecordDatabaseCapture;
    const protect = () =>
      protectProduction({
        ...options,
        capture: async (_journal, previous) => {
          current = await capture(client, url, previous);
          return current;
        },
        captureMedia: async (write, select) => {
          const sourceVersions = [...files].map(([archivePath, bytes]) => ({
            archivePath,
            size: bytes.length,
            sourceVersion: `synthetic:${versions.get(archivePath)}`,
          }));
          const selected = select(sourceVersions);
          for (const [name, bytes] of files)
            if (selected.has(name))
              await write(
                name,
                Readable.from([bytes]),
                `synthetic:${versions.get(name)}`,
              );
          return {
            sourceVersions,
            missingReferences: [],
            evidence: {
              snapshotAt: new Date().toISOString(),
              databaseSha256: recordInventoryHash(current.records.inventory),
            },
          };
        },
      });
    const started = Date.now(),
      baseline = await protect();
    const baselineTarget = await database(),
      baselineMedia = await mkdtemp(
        join(tmpdir(), "labtrax-content-rehearsal-"),
      );
    try {
      await restoreProductionPointIsolated({
        ...options,
        marker: baseline.marker,
        targetUrl: baselineTarget,
        mediaRoot: baselineMedia,
        isolationAcknowledged: true,
      });
      await compare(client, await connect(baselineTarget));
      expect(
        await readFile(join(baselineMedia, "case-media/picture.png")),
      ).toEqual(picture);
      expect(
        await readFile(join(baselineMedia, "case-media/document.pdf")),
      ).toEqual(pdf);
      expect(
        await readFile(join(baselineMedia, "private-objects/video.mp4")),
      ).toEqual(video);
    } finally {
      await rm(baselineMedia, { recursive: true, force: true });
    }
    await client.query(`BEGIN;DELETE FROM child WHERE id=2;DELETE FROM parent WHERE id=2;
UPDATE parent SET label='after',amount=99999999999999999999.9999999999 WHERE id=9007199254740993;
INSERT INTO parent VALUES(3,'insert',1);INSERT INTO child VALUES(3,3,'case-media/document.pdf');
DELETE FROM bag WHERE ctid IN(SELECT ctid FROM bag LIMIT 1);UPDATE generated SET value=9;
UPDATE partitioned SET value='changed partition row' WHERE id=1;COMMIT;`);
    const replacement = syntheticPng(1, 1, 127);
    files.set("case-media/picture.png", replacement);
    versions.set("case-media/picture.png", 2);
    files.delete("private-objects/video.mp4");
    const changed = await protect();
    expect(changed.database.manifest.capture).toBe("changed-postgresql-rows");
    const target = await database(),
      root = await mkdtemp(join(tmpdir(), "labtrax-content-rehearsal-"));
    try {
      await restoreProductionPointIsolated({
        ...options,
        marker: changed.marker,
        targetUrl: target,
        mediaRoot: root,
        isolationAcknowledged: true,
      });
      await compare(client, await connect(target));
      expect(await readFile(join(root, "case-media/picture.png"))).toEqual(
        replacement,
      );
      expect(await readFile(join(root, "case-media/document.pdf"))).toEqual(
        pdf,
      );
      await expect(
        readFile(join(root, "private-objects/video.mp4")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    db.reset();
    const unchanged = await protect();
    expect(unchanged.database.recordSnapshot).toBeTruthy();
    expect(db.reads()).toBe(0);
    if (
      unchanged.database.manifest.format ===
      "labtrax-postgresql-record-point-v1"
    )
      expect(unchanged.database.manifest.metrics.sourceRowBodyBytes).toBe(0);
    await verifyProductionPoint(options, baseline.marker);
    console.info(
      JSON.stringify({
        recordDeltaRehearsal: {
          durationMs: Date.now() - started,
          baseline: baseline.database.manifest,
          changed: changed.database.manifest,
          unchanged: unchanged.database.manifest,
          uploadedBytes: db.uploads(),
        },
      }),
    );
  }, 120_000);
  it("cannot miss late commits and captures raw-SQL changes after restart without a trigger watermark", async () => {
    const url = await database(),
      client = await connect(url),
      writer = await connect(url);
    await client.query(ddl);
    const first = await capture(client, url),
      store = memoryStore(),
      options = { store: store.store, codec, source: sourceIdentity };
    const baseline = await protectRecordDatabase({
      ...options,
      capture: first,
    });
    await writer.query("BEGIN;INSERT INTO parent VALUES(55,'late commit',5)");
    const during = await capture(client, url, first.records.inventory);
    expect(during.records.metrics.sourceRowBodyBytes).toBe(0);
    await writer.query("COMMIT");
    const restarted = await connect(url),
      after = await capture(restarted, url, during.records.inventory);
    expect(after.records.metrics.changedRows).toBe(1);
    const changed = await protectRecordDatabase({
        ...options,
        previous: baseline,
        capture: after,
      }),
      target = await database();
    await restoreDatabasePointIsolated({
      ...options,
      marker: changed.marker,
      targetUrl: target,
      isolationAcknowledged: true,
    });
    await compare(client, await connect(target));
  }, 120_000);
  it.each([false, true])("restores an explicit reference baseline while omitting only exact prior bodies (schema changed: %s)", async schemaChanged => {
    const url = await database(), client = await connect(url);
    await client.query(ddl);
    const store = memoryStore(), options = { store: store.store, codec, source: sourceIdentity };
    const first = await capture(client, url, null, {
      protocol: hash(Buffer.from("isolated-reference-extractor-v1")), extract: () => [],
    });
    const baseline = await protectRecordDatabase({ ...options, capture: first });
    if (schemaChanged) await client.query("ALTER TABLE parent ADD COLUMN added text DEFAULT 'new'");
    await client.query("UPDATE parent SET label='after reference transition' WHERE id=9007199254740993");
    const next = await capture(client, url, first.records.inventory, {
      protocol: hash(Buffer.from("isolated-reference-extractor-v2")),
      extract: (_table, row) => typeof row.reference === "string" ? [row.reference] : [],
    });
    expect(next.records.delta).toBeNull();
    expect(next.records.reason).toBe(schemaChanged ? "schema-changed" : "reference-protocol-changed");
    expect(next.schemaDump).not.toBeNull();
    const child = next.records.inventory.tables.find(table => table.name === "child")!;
    expect(child.rows.flatMap(row => row.references).sort())
      .toEqual(["case-media/document.pdf", "case-media/picture.png"]);
    expect(next.records.bodies.find(table => table.name === "child")!.inserts).toHaveLength(0);
    const retainedBytes = next.records.bodies.flatMap(table => table.inserts)
      .reduce((sum, row) => sum + Buffer.byteLength(row.json), 0);
    expect(next.records.metrics.sourceRowBodyBytes).toBeGreaterThan(retainedBytes);
    const point = await protectRecordDatabase({ ...options, previous: baseline, capture: next });
    expect(point.manifest.capture).toBe("postgresql-record-baseline");
    const target = await database();
    await restoreDatabasePointIsolated({
      ...options, marker: point.marker, targetUrl: target, isolationAcknowledged: true,
    });
    await compare(client, await connect(target));
    const originalParents: Array<{ label: string }> = [];
    await readRecordBodies(options, baseline, async (table, json) => {
      if (table.name === "parent") originalParents.push(JSON.parse(json));
    });
    expect(originalParents.some(row => row.label === "before")).toBe(true);
    expect(originalParents.every(row => row.label !== "after reference transition")).toBe(true);
  }, 120_000);
  it("makes schema changes explicit and restores a new compatible baseline without losing older points", async () => {
    const url = await database(),
      client = await connect(url);
    await client.query(ddl);
    const store = memoryStore(),
      options = { store: store.store, codec, source: sourceIdentity },
      first = await capture(client, url);
    const baseline = await protectRecordDatabase({
      ...options,
      capture: first,
    });
    await client.query(
      "ALTER TABLE parent ADD COLUMN added text DEFAULT 'new';CREATE TABLE extra(id int PRIMARY KEY,parent_id bigint REFERENCES parent(id));INSERT INTO extra VALUES(1,2)",
    );
    const next = await capture(client, url, first.records.inventory);
    expect(next.records.reason).toBe("schema-changed");
    expect(next.records.delta).toBeNull();
    const point = await protectRecordDatabase({
        ...options,
        previous: baseline,
        capture: next,
      }),
      target = await database();
    await restoreDatabasePointIsolated({
      ...options,
      marker: point.marker,
      targetUrl: target,
      isolationAcknowledged: true,
    });
    const restored = await connect(target);
    await compare(client, restored);
    expect(
      (await restored.query("SELECT added FROM parent WHERE id=2")).rows[0]
        ?.added,
    ).toBe("new");
    expect((await restored.query("SELECT * FROM extra")).rows).toEqual([
      { id: 1, parent_id: "2" },
    ]);
    const originals: unknown[] = [];
    await readRecordBodies(options, baseline, async (table, json) => {
      if (table.name === "parent") originals.push(JSON.parse(json));
    });
    expect(originals.every((row: any) => !("added" in row))).toBe(true);
    await expect(
      restoreDatabasePointIsolated({
        ...options,
        marker: baseline.marker,
        targetUrl: target,
        isolationAcknowledged: true,
      }),
    ).rejects.toThrow(/empty disposable/);
  }, 120_000);
  it("uses the actual combined capture with one shared snapshot, retained references and no data dump on an unchanged interval", async () => {
    const uploads = await mkdtemp(join(tmpdir(), "labtrax-record-capture-"));
    let schemaDumps = 0,
      pins = 0;
    async function complete(
      previous: RecordInventory | null,
      journalAfter: string | null = null,
    ) {
      const boundary = await pool.connect();
      let locked = false,
        transaction = false;
      try {
        await lockMediaCheckpoint(boundary);
        locked = true;
        await boundary.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transaction = true;
        const snapshot = (
          await boundary.query<{ snapshot: string }>(
            "SELECT pg_export_snapshot() AS snapshot",
          )
        ).rows[0]!.snapshot;
        return await captureCompleteBackup(
          uploads,
          async (token) => {
            schemaDumps++;
            return dump(process.env.DATABASE_URL!, token, "custom");
          },
          undefined,
          {
            snapshot,
            productionDataOnly: true,
            allowMissingReferences: true,
            archiveDestination: "direct",
            streamDatabaseDump: true,
            productionJournalAfterPosition: journalAfter,
            onMediaPinned: async () => {
              pins++;
              await unlockMediaCheckpoint(boundary);
              locked = false;
            },
            records: {
              previous,
              schemaSql: async (token) =>
                (
                  await dump(process.env.DATABASE_URL!, token, "plain")
                ).toString("utf8"),
            },
          },
        );
      } finally {
        if (transaction) await boundary.query("ROLLBACK");
        if (locked) await unlockMediaCheckpoint(boundary);
        boundary.release();
      }
    }
    try {
      const first = await complete(null);
      expect(first.recordCapture).toBeTruthy();
      try {
        expect(first.manifest.databaseCapture).toBe(
          "postgresql-record-state-v1",
        );
        expect(first.manifest.databaseSha256).toBe(
          recordInventoryHash(first.recordCapture!.inventory),
        );
        const baselinePieces: Buffer[] = [];
        for await (const b of first.pgDump) baselinePieces.push(Buffer.from(b));
        expect(Buffer.concat(baselinePieces).subarray(0, 5).toString()).toBe(
          "PGDMP",
        );
        const next = await complete(
          first.recordCapture!.inventory,
          first.manifest.productionMediaJournal!.throughPosition,
        );
        try {
          expect(next.recordCapture!.metrics.sourceRowBodyBytes).toBe(0);
          expect(next.manifest.requiredReferences).toEqual(
            first.manifest.requiredReferences,
          );
          const pieces: Buffer[] = [];
          for await (const b of next.pgDump) pieces.push(Buffer.from(b));
          expect(Buffer.concat(pieces)).toHaveLength(0);
          expect(schemaDumps).toBe(1);
          expect(pins).toBe(2);
        } finally {
          await next.dispose();
        }
      } finally {
        await first.dispose();
      }
    } finally {
      await rm(uploads, { recursive: true, force: true });
    }
  }, 180_000);
});
