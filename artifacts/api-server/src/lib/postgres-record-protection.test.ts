import { describe, expect, it } from "vitest";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { Readable } from "node:stream";
import {
  protectRecordDatabase,
  verifyRecordDatabasePoint,
  readRecordBodies,
  readRecordSchema,
  type RecordDatabaseCapture,
} from "./postgres-record-protection";
import {
  RECORD_DELTA_FORMAT,
  recordInventoryHash,
  validateRecordDelta,
  postgresSchemaHash,
  type RecordCapture,
  type RecordInventory,
} from "./postgres-record-delta";
import {
  protectProduction,
  verifyProductionPoint,
  readProductionFile,
} from "./production-content-protection";
import { verifyDatabasePoint } from "./database-protection";
import type { DatabaseObjectStore } from "./database-protection";

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const syntheticSchema = Buffer.from(
  "PGDMP synthetic schema-storage bytes; not an actual pg_dump fixture",
);
function fixtureStore() {
  const objects = new Map<string, Buffer>(),
    versions = new Map<string, number>();
  let bodyBytesRead = 0,
    uploaded = 0;
  const store = {
    list: async () => [...objects.keys()].map(name => ({ name, createdAt: null })),
    delete: async (name: string) => { objects.delete(name); versions.delete(name); },
    get: async (name: string) => {
      const bytes = objects.get(name);
      if (bytes && name.startsWith("records-body-"))
        bodyBytesRead += bytes.length;
      return bytes ? Buffer.from(bytes) : null;
    },
    getIntegrity: async (name: string) => {
      const bytes = objects.get(name);
      return bytes
        ? { bytes: bytes.length, sha1: null, sha256: sha(bytes) }
        : null;
    },
    getVersion: async (name: string) => {
      const bytes = objects.get(name);
      return bytes
        ? {
            provider: "onedrive-content-v1" as const,
            driveId: "synthetic-drive",
            itemId: name,
            contentTag: String(versions.get(name)),
            bytes: bytes.length,
          }
        : null;
    },
    put: async (name: string, bytes: Buffer) => {
      if (objects.has(name)) throw new Error("Synthetic overwrite forbidden");
      objects.set(name, Buffer.from(bytes));
      versions.set(name, 1);
      uploaded += bytes.length;
    },
  };
  return {
    store,
    objects,
    versions,
    bodyBytesRead: () => bodyBytesRead,
    resetReads: () => {
      bodyBytesRead = 0;
    },
    uploaded: () => uploaded,
  };
}
function fixtureCodec() {
  const key = randomBytes(32);
  return {
    encrypt: (bytes: Buffer) => {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(bytes), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decrypt: (bytes: Buffer) => {
      const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      c.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([c.update(bytes.subarray(28)), c.final()]);
    },
  };
}
function capture(
  rows: Array<{ id: number; value: string }>,
  previous?: RecordInventory,
  schemaHash = sha("synthetic schema"),
): RecordCapture {
  const table = {
    schema: "public",
    name: "fixture",
    primaryKey: ["id"],
    columns: ["id", "value"],
    allColumns: ["id", "value"],
  };
  const bodies = rows.map((row) => {
    const json = JSON.stringify(row);
    return {
      key: sha(JSON.stringify([row.id])),
      hash: sha(json),
      count: 1,
      json,
    };
  });
  const fingerprints = bodies
    .map(({ key, hash, count }) => ({ key, hash, count, references: [] }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const inventory: RecordInventory = {
    format: RECORD_DELTA_FORMAT,
    schemaHash,
    referenceProtocol: sha("synthetic-reference-protocol"),
    tables: [{ ...table, rows: fingerprints }],
    sequences: [],
  };
  const compatible = previous?.schemaHash === schemaHash,
    old = new Map(
      (compatible ? previous!.tables[0]!.rows : []).map((row) => [
        row.key,
        row,
      ]),
    );
  const inserts = bodies.filter((row) => old.get(row.key)?.hash !== row.hash),
    next = new Map(fingerprints.map((row) => [row.key, row]));
  const deletes = [...old.values()]
    .filter((row) => next.get(row.key)?.hash !== row.hash)
    .map(({ key, hash, count }) => ({ key, hash, count }));
  const changes = [
    { schema: table.schema, name: table.name, inserts, deletes },
  ];
  return {
    inventory,
    bodies: changes,
    delta: compatible
      ? {
          format: RECORD_DELTA_FORMAT,
          beforeHash: recordInventoryHash(previous!),
          afterHash: recordInventoryHash(inventory),
          tables: changes,
        }
      : null,
    reason: !previous
      ? "first-baseline"
      : compatible
        ? "changed-rows"
        : "schema-changed",
    metrics: {
      fingerprintRows: rows.length,
      fingerprintMetadataBytes: 0,
      schemaSqlBytes: 0,
      sourceRowBodyBytes: inserts.reduce(
        (sum, row) => sum + Buffer.byteLength(row.json),
        0,
      ),
      changedRows: inserts.length,
      deletedRows: deletes.length,
      durationMs: 1,
    },
  };
}
function recordCapture(records: RecordCapture): RecordDatabaseCapture {
  return {
    kind: RECORD_DELTA_FORMAT,
    records,
    schemaDump: records.delta ? null : syntheticSchema,
  };
}
function setup() {
  const fixture = fixtureStore(),
    codec = fixtureCodec();
  return {
    ...fixture,
    codec,
    options: { store: fixture.store, codec, source: "e".repeat(64) },
  };
}

describe("changed-record immutable storage (synthetic provider; no cloud calls)", () => {
  it("stores a baseline, transfers only changed row bodies, preserves deleted/prior versions and has no unchanged-body reads", async () => {
    const f = setup(),
      rows = [
        { id: 1, value: "before" },
        { id: 2, value: "delete" },
      ];
    const first = capture(rows),
      baseline = await protectRecordDatabase({
        ...f.options,
        capture: recordCapture(first),
      });
    const unchanged = capture(rows, first.inventory);
    f.resetReads();
    const idle = await protectRecordDatabase({
      ...f.options,
      previous: baseline,
      capture: recordCapture(unchanged),
    });
    expect(unchanged.metrics.sourceRowBodyBytes).toBe(0);
    expect(f.bodyBytesRead()).toBe(0);
    expect(idle.manifest.newChunks).toBe(0);
    const changed = capture(
      [
        { id: 1, value: "after" },
        { id: 3, value: "insert" },
      ],
      unchanged.inventory,
    );
    f.resetReads();
    const point = await protectRecordDatabase({
      ...f.options,
      previous: idle,
      capture: recordCapture(changed),
    });
    expect(point.manifest.capture).toBe("changed-postgresql-rows");
    expect(point.manifest.metrics.sourceRowBodyBytes).toBe(
      changed.metrics.sourceRowBodyBytes,
    );
    for (const [verified, expected] of [
      [baseline, rows],
      [
        point,
        [
          { id: 1, value: "after" },
          { id: 3, value: "insert" },
        ],
      ],
    ] as const) {
      const restored: unknown[] = [];
      await readRecordBodies(
        f.options,
        verified,
        async (_table, json, count) => {
          for (let i = 0; i < count; i++) restored.push(JSON.parse(json));
        },
      );
      expect(restored.sort((a: any, b: any) => a.id - b.id)).toEqual(expected);
    }
    expect(
      (
        await verifyDatabasePoint(
          f.store,
          f.codec,
          f.options.source,
          point.marker,
        )
      ).recordSnapshot?.records,
    ).toEqual(changed.inventory);
  });
  it("reassembles large UTF-8 row bodies across bounded chunks exactly", async () => {
    const f = setup(),
      value = "κ🙂".repeat(250_000),
      records = capture([{ id: 1, value }]);
    const point = await protectRecordDatabase({
      ...f.options,
      capture: recordCapture(records),
    });
    let restored = "";
    await readRecordBodies(f.options, point, async (_table, json) => {
      restored = JSON.parse(json).value;
    });
    expect(restored).toBe(value);
    expect(point.recordSnapshot.locations[0]!.parts.length).toBeGreaterThan(1);
  });
  it("releases authenticated row bodies as bounded chunks finish uploading", async () => {
    const f = setup(),
      records = capture([
        { id: 1, value: "a".repeat(650_000) },
        { id: 2, value: "b".repeat(650_000) },
      ]),
      inserts = records.bodies[0]!.inserts,
      put = f.store.put;
    let bodyUploads = 0;
    f.store.put = async (name, bytes) => {
      if (name.startsWith("records-body-")) {
        bodyUploads++;
        if (bodyUploads === 2) {
          expect(inserts.filter((row) => row.json === "")).toHaveLength(1);
          expect(inserts.filter((row) => row.json.length > 0)).toHaveLength(1);
        }
      }
      await put(name, bytes);
    };
    await protectRecordDatabase({
      ...f.options,
      capture: recordCapture(records),
    });
    expect(bodyUploads).toBe(2);
    expect(inserts.map((row) => row.json)).toEqual(["", ""]);
  });
  it("does not release a row body before its authenticated upload succeeds", async () => {
    const f = setup(),
      records = capture([{ id: 1, value: "retained on failure" }]),
      insert = records.bodies[0]!.inserts[0]!,
      original = insert.json,
      put = f.store.put;
    f.store.put = async (name, bytes) => {
      if (name.startsWith("records-body-"))
        throw new Error("Synthetic body upload failed");
      await put(name, bytes);
    };
    await expect(
      protectRecordDatabase({
        ...f.options,
        capture: recordCapture(records),
      }),
    ).rejects.toThrow("Synthetic body upload failed");
    expect(insert.json).toBe(original);
  });
  it("reuses prior record chunks after a durable failure and restart without accepting an orphan as the parent", async () => {
    const f = setup(),
      first = capture([{ id: 1, value: "before" }]),
      baseline = await protectRecordDatabase({
        ...f.options,
        capture: recordCapture(first),
      });
    const changed = capture([{ id: 1, value: "after" }], first.inventory),
      put = f.store.put;
    f.store.put = async (name, bytes) => {
      if (name.startsWith("records-verified-"))
        throw new Error("Synthetic interrupted commit");
      await put(name, bytes);
    };
    await expect(
      protectRecordDatabase({
        ...f.options,
        previous: baseline,
        capture: recordCapture(changed),
      }),
    ).rejects.toThrow("interrupted");
    await verifyRecordDatabasePoint(f.options, baseline.marker);
    f.store.put = put;
    const retry = await protectRecordDatabase({
      ...f.options,
      previous: baseline,
      capture: recordCapture(
        capture([{ id: 1, value: "after" }], first.inventory),
      ),
    });
    expect(retry.manifest.previousPoint).toBe(baseline.manifest.point);
    await verifyRecordDatabasePoint(f.options, retry.marker);
  });
  it.each(["missing", "changed-version", "corrupt"])(
    "fails safely for a %s reused body dependency",
    async (kind) => {
      const f = setup(),
        first = capture([{ id: 1, value: "retained" }]),
        baseline = await protectRecordDatabase({
          ...f.options,
          capture: recordCapture(first),
        });
      const name = [...f.objects.keys()].find((name) =>
          name.startsWith("records-body-"),
        )!,
        original = f.objects.get(name)!;
      if (kind === "missing") f.objects.delete(name);
      else {
        f.versions.set(name, 2);
        if (kind === "corrupt")
          f.objects.set(name, Buffer.from("corrupt synthetic bytes"));
      }
      const before = [...f.objects.keys()].filter((name) =>
        name.startsWith("records-verified-"),
      ).length;
      await expect(
        protectRecordDatabase({
          ...f.options,
          previous: baseline,
          capture: recordCapture(
            capture([{ id: 1, value: "retained" }], first.inventory),
          ),
        }),
      ).rejects.toThrow(/version/);
      expect(
        [...f.objects.keys()].filter((name) =>
          name.startsWith("records-verified-"),
        ).length,
      ).toBe(before);
      f.objects.set(name, original);
      f.versions.set(name, 1);
      await verifyRecordDatabasePoint(f.options, baseline.marker);
    },
  );
  it("authenticates actual bytes during restore even if a synthetic provider lies about unchanged identifiers", async () => {
    const f = setup(),
      baseline = await protectRecordDatabase({
        ...f.options,
        capture: recordCapture(capture([{ id: 1, value: "retained" }])),
      });
    const name = [...f.objects.keys()].find((name) =>
      name.startsWith("records-body-"),
    )!;
    const bytes = Buffer.from(f.objects.get(name)!);
    bytes[bytes.length - 1] ^= 1;
    f.objects.set(name, bytes);
    await expect(
      readRecordBodies(f.options, baseline, async () => undefined),
    ).rejects.toThrow(/ciphertext/);
  });
  it("does not certify size/SHA-1-only reuse when content versions/strong digest are unavailable", async () => {
    const f = setup(),
      weak = {
        ...f.store,
        getVersion: undefined,
        getIntegrity: async (name: string) => {
          const b = f.objects.get(name);
          return b
            ? {
                bytes: b.length,
                sha1: createHash("sha1").update(b).digest("hex"),
                sha256: null,
              }
            : null;
        },
      };
    await expect(
      protectRecordDatabase({
        ...f.options,
        store: weak,
        capture: recordCapture(capture([{ id: 1, value: "first" }])),
      }),
    ).rejects.toThrow(/strong integrity/);
    expect(
      [...f.objects.keys()].some((name) =>
        name.startsWith("records-verified-"),
      ),
    ).toBe(false);
  });
  it("fails before committing a point on upload/read-back mismatch", async () => {
    const f = setup(),
      put = f.store.put;
    f.store.put = async (name, bytes) => {
      await put(name, bytes);
      if (name.startsWith("records-body-"))
        f.objects.set(name, Buffer.from("synthetic mismatch"));
    };
    await expect(
      protectRecordDatabase({
        ...f.options,
        capture: recordCapture(capture([{ id: 1, value: "first" }])),
      }),
    ).rejects.toThrow();
    expect(
      [...f.objects.keys()].some((name) =>
        name.startsWith("records-verified-"),
      ),
    ).toBe(false);
  });
  it("rejects incomplete/duplicated/tampered change operations", () => {
    const first = capture([{ id: 1, value: "before" }]),
      changed = capture([{ id: 1, value: "after" }], first.inventory);
    for (const mutate of [
      (d: any) => d.tables[0].inserts.splice(0, 1),
      (d: any) => d.tables[0].inserts.push(d.tables[0].inserts[0]),
      (d: any) => {
        d.tables[0].inserts[0].json = "{}";
      },
      (d: any) => {
        d.beforeHash = "0".repeat(64);
      },
    ]) {
      const delta = structuredClone(changed.delta!);
      mutate(delta);
      expect(() =>
        validateRecordDelta(delta, first.inventory, changed.inventory),
      ).toThrow();
    }
  });
  it("retains the prior schema baseline and requires explicit new schema bytes on a schema transition", async () => {
    const f = setup(),
      first = capture([{ id: 1, value: "before" }]),
      baseline = await protectRecordDatabase({
        ...f.options,
        capture: recordCapture(first),
      });
    const next = capture(
      [{ id: 1, value: "before" }],
      first.inventory,
      sha("changed synthetic schema"),
    );
    await expect(
      protectRecordDatabase({
        ...f.options,
        previous: baseline,
        capture: { ...recordCapture(next), schemaDump: null },
      }),
    ).rejects.toThrow(/schema baseline/);
    const point = await protectRecordDatabase({
      ...f.options,
      previous: baseline,
      capture: recordCapture(next),
    });
    expect(point.manifest.capture).toBe("postgresql-record-baseline");
    const parts: Buffer[] = [];
    await readRecordSchema(f.options, baseline, async (bytes) => {
      parts.push(bytes);
    });
    expect(Buffer.concat(parts)).toEqual(syntheticSchema);
  });
  it("rejects missing/tampered ancestors and keeps the prior point readable", async () => {
    const f = setup(),
      first = capture([{ id: 1, value: "before" }]),
      baseline = await protectRecordDatabase({
        ...f.options,
        capture: recordCapture(first),
      });
    const point = await protectRecordDatabase({
      ...f.options,
      previous: baseline,
      capture: recordCapture(
        capture([{ id: 1, value: "after" }], first.inventory),
      ),
    });
    const saved = f.objects.get(baseline.marker)!;
    f.objects.delete(baseline.marker);
    await expect(
      verifyRecordDatabasePoint(f.options, point.marker),
    ).rejects.toThrow(/missing/);
    f.objects.set(baseline.marker, Buffer.from("tampered marker"));
    await expect(
      verifyRecordDatabasePoint(f.options, point.marker),
    ).rejects.toThrow();
    f.objects.set(baseline.marker, saved);
    await verifyRecordDatabasePoint(f.options, baseline.marker);
  });
  it("ignores per-invocation pg_dump restrict tokens but detects semantic schema changes", () => {
    const first =
      "\\restrict AAA\nCREATE TABLE fixture(id int);\n\\unrestrict AAA\n";
    expect(postgresSchemaHash(first)).toBe(
      postgresSchemaHash(first.replaceAll("AAA", "BBB")),
    );
    expect(postgresSchemaHash(first)).not.toBe(
      postgresSchemaHash(first.replace("id int", "id bigint")),
    );
  });
  it("does not erase stored-function contents while normalizing pg_dump's envelope", () => {
    const prefix = "-- PostgreSQL database dump\n\n\\restrict AAA\n";
    const body =
      "CREATE FUNCTION fixture() RETURNS text AS $$\n-- Started on literal text\n\\unrestrict LITERAL\n$$ LANGUAGE sql;\n";
    const first = prefix + body + "\\unrestrict AAA\n\n";
    expect(postgresSchemaHash(first)).toBe(
      postgresSchemaHash(first.replaceAll("AAA", "BBB")),
    );
    expect(postgresSchemaHash(first)).not.toBe(
      postgresSchemaHash(first.replace("LITERAL", "CHANGED")),
    );
  });
  it("coalesces identical chunks from concurrent media writers into one immutable upload", async () => {
    const f = setup(),
      media = fixtureStore();
    const records = capture([{ id: 1, value: "synthetic" }]);
    const bytes = Buffer.from("identical concurrent synthetic media");
    const paths = ["case-media/one.bin", "case-media/two.bin"];
    const result = await protectProduction({
      ...f.options,
      databaseStore: f.store,
      store: media.store,
      capture: async () => recordCapture(records),
      captureMedia: async (write, select) => {
        const sourceVersions = paths.map((archivePath) => ({
          archivePath,
          size: bytes.length,
          sourceVersion: "synthetic:1",
        }));
        const selected = select(sourceVersions);
        await Promise.all(
          paths
            .filter((p) => selected.has(p))
            .map((p) => write(p, Readable.from([bytes]), "synthetic:1")),
        );
        return {
          sourceVersions,
          missingReferences: [],
          evidence: {
            snapshotAt: new Date().toISOString(),
            databaseSha256: recordInventoryHash(records.inventory),
          },
        };
      },
    });
    const mediaChunk = `chunk-${sha(bytes)}.enc`;
    expect(
      [...media.objects.keys()].filter((n) => n === mediaChunk),
    ).toHaveLength(1);
    expect(result.inventory.files).toHaveLength(2);
    for (const file of result.inventory.files) {
      const received: Buffer[] = [];
      await readProductionFile(
        { ...f.options, store: media.store, databaseStore: f.store },
        file,
        async (b) => {
          received.push(b);
        },
      );
      expect(Buffer.concat(received)).toEqual(bytes);
    }
  });
  it("combines changed records with exact picture/PDF/video versions and preserves a coherent root across media interruption", async () => {
    const f = setup(),
      media = fixtureStore(),
      options = { ...f.options, databaseStore: f.store, store: media.store };
    const files = new Map([
      ["case-media/picture.png", Buffer.from("synthetic picture bytes")],
      ["case-media/document.pdf", Buffer.from("%PDF synthetic exact bytes")],
      ["case-media/video.mp4", Buffer.from("synthetic video bytes")],
    ]);
    const versions = new Map([...files.keys()].map((key) => [key, 1]));
    let records = capture([{ id: 1, value: "before" }]);
    const protect = () =>
      protectProduction({
        ...options,
        capture: async (_journal, previous) => {
          expect(previous ?? null).toEqual(
            records.delta ? initial.inventory : null,
          );
          return recordCapture(structuredClone(records));
        },
        captureMedia: async (write, select) => {
          const sourceVersions = [...files].map(([archivePath, b]) => ({
            archivePath,
            size: b.length,
            sourceVersion: `synthetic:${versions.get(archivePath)}`,
          }));
          const selected = select(sourceVersions);
          for (const [path, bytes] of files)
            if (selected.has(path))
              await write(
                path,
                Readable.from([bytes]),
                `synthetic:${versions.get(path)}`,
              );
          return {
            sourceVersions,
            missingReferences: [],
            evidence: {
              snapshotAt: new Date().toISOString(),
              databaseSha256: recordInventoryHash(records.inventory),
            },
          };
        },
      });
    const initial = records,
      baseline = await protect(),
      original = new Map(files);
    records = capture(
      [
        { id: 1, value: "after" },
        { id: 2, value: "insert" },
      ],
      initial.inventory,
    );
    files.set("case-media/picture.png", Buffer.from("replacement picture"));
    versions.set("case-media/picture.png", 2);
    files.delete("case-media/video.mp4");
    const put = media.store.put;
    media.store.put = async (name, bytes) => {
      if (name.startsWith("verified-"))
        throw new Error("Synthetic media root interruption");
      await put(name, bytes);
    };
    await expect(protect()).rejects.toThrow("interruption");
    await verifyProductionPoint(options, baseline.marker);
    media.store.put = put;
    const point = await protect();
    for (const [verified, expected] of [
      [baseline, original],
      [point, files],
    ] as const) {
      for (const file of verified.inventory.files) {
        const pieces: Buffer[] = [];
        await readProductionFile(options, file, async (bytes) => {
          pieces.push(bytes);
        });
        expect(Buffer.concat(pieces)).toEqual(expected.get(file.path));
      }
      await verifyProductionPoint(options, verified.marker);
    }
    expect(point.database.manifest.capture).toBe("changed-postgresql-rows");
    expect(baseline.inventory.files).toHaveLength(3);
    expect(point.inventory.files).toHaveLength(2);
  });
  it("verifies many unchanged media objects using one fresh metadata pass and no individual file-body version calls", async () => {
    const f = setup(),
      media = fixtureStore(),
      rawVersion = media.store.getVersion;
    const fileNames = new Set<string>();
    let individualFileChecks = 0,
      passes = 0;
    const store: DatabaseObjectStore = {
      ...media.store,
      getVersion: async (name) => {
        if (fileNames.has(name)) individualFileChecks++;
        return rawVersion(name);
      },
      getVersions: async (names) => {
        passes++;
        return new Map(
          await Promise.all(
            names.map(async (name) => [name, await rawVersion(name)] as const),
          ),
        );
      },
    };
    const files = Array.from({ length: 150 }, (_, id) => ({
      path: `case-media/synthetic-${id}.png`,
      bytes: Buffer.from(`synthetic bytes ${id}`),
    }));
    const records = capture([{ id: 1, value: "baseline" }]),
      options = { ...f.options, store, databaseStore: f.store };
    const point = await protectProduction({
      ...options,
      capture: () => recordCapture(records),
      captureMedia: async (write, select) => {
        const sources = files.map((file) => ({
            archivePath: file.path,
            size: file.bytes.length,
            sourceVersion: "synthetic:1",
          })),
          selected = select(sources);
        for (const file of files)
          if (selected.has(file.path))
            await write(file.path, Readable.from([file.bytes]), "synthetic:1");
        return {
          sourceVersions: sources,
          missingReferences: [],
          evidence: {
            snapshotAt: new Date().toISOString(),
            databaseSha256: recordInventoryHash(records.inventory),
          },
        };
      },
    });
    for (const file of point.inventory.files)
      for (const c of file.chunks) fileNames.add(`chunk-${c.hash}.enc`);
    passes = 0;
    individualFileChecks = 0;
    await verifyProductionPoint(options, point.marker, true);
    expect(passes).toBe(1);
    expect(individualFileChecks).toBe(0);
  });
  it("does not write a production commit marker when the final fresh metadata pass loses a reused dependency", async () => {
    const f = setup(),
      media = fixtureStore(),
      rawVersion = media.store.getVersion;
    let passes = 0,
      failFinal = false,
      bytes = Buffer.from("picture before"),
      version = 1;
    const store: DatabaseObjectStore = {
      ...media.store,
      getVersions: async (names) => {
        passes++;
        const map = new Map(
          await Promise.all(
            names.map(async (name) => [name, await rawVersion(name)] as const),
          ),
        );
        if (failFinal && passes === 3) map.set(`chunk-${sha(bytes)}.enc`, null);
        return map;
      },
    };
    let records = capture([{ id: 1, value: "before" }]);
    const first = records;
    const options = { ...f.options, store, databaseStore: f.store };
    const protect = () =>
      protectProduction({
        ...options,
        capture: () => recordCapture(records),
        captureMedia: async (write, select) => {
          const sources = [
            {
              archivePath: "case-media/picture.png",
              size: bytes.length,
              sourceVersion: `synthetic:${version}`,
            },
          ];
          if (select(sources).size)
            await write(
              sources[0]!.archivePath,
              Readable.from([bytes]),
              sources[0]!.sourceVersion,
            );
          return {
            sourceVersions: sources,
            missingReferences: [],
            evidence: {
              snapshotAt: new Date().toISOString(),
              databaseSha256: recordInventoryHash(records.inventory),
            },
          };
        },
      });
    const baseline = await protect(),
      before = [...media.objects.keys()].filter((name) =>
        name.startsWith("verified-"),
      ).length;
    records = capture([{ id: 1, value: "after" }], first.inventory);
    bytes = Buffer.from("picture after");
    version = 2;
    passes = 0;
    failFinal = true;
    await expect(protect()).rejects.toThrow(/continuity/);
    expect(
      [...media.objects.keys()].filter((name) => name.startsWith("verified-"))
        .length,
    ).toBe(before);
    failFinal = false;
    await verifyProductionPoint(options, baseline.marker, true);
  });
});
