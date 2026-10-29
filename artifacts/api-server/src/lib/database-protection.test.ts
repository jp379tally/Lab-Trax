import { describe, it, expect } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  protectDatabase, latestDatabasePoint, verifyDatabasePoint, databaseChunks,
  MAX_DATABASE_CHUNK_BYTES, type DatabaseObjectStore, type DatabaseCodec,
  planDatabaseRetentionSweep, DATABASE_PROTECTION_RETENTION_POLICY,
} from "./database-protection";
import { restoreDatabasePointIsolated } from "./database-protection-restore";

export function syntheticCodec(): DatabaseCodec {
  const key = randomBytes(32);
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    },
  };
}
export function syntheticStore() {
  const objects = new Map<string, Buffer>();
  const createdAt = new Map<string, string>();
  let failPut = false;
  const store: DatabaseObjectStore = {
    list: async () => [...objects.keys()].map(name => ({ name, createdAt: createdAt.get(name) ?? null })),
    get: async name => objects.has(name) ? Buffer.from(objects.get(name)!) : null,
    put: async (name, bytes) => {
      if (failPut) throw new Error("Synthetic interruption");
      if (objects.has(name)) throw new Error("Overwrite forbidden");
      objects.set(name, Buffer.from(bytes));
      createdAt.set(name, new Date().toISOString());
    },
    delete: async name => { objects.delete(name); createdAt.delete(name); },
  };
  return { store, objects, createdAt, fail: (value: boolean) => { failPut = value; } };
}
const source = "a".repeat(64);
function dump() { return Buffer.concat([Buffer.from("PGDMP"), randomBytes(4 * 1024 * 1024)]); }
async function reconstructForTest(
  store: DatabaseObjectStore, codec: DatabaseCodec, marker: string,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  await verifyDatabasePoint(store, codec, source, marker, async chunk => { parts.push(Buffer.from(chunk)); });
  return Buffer.concat(parts);
}
describe("database-only incremental storage", () => {
  it("stores a baseline, reuses chunks on changes, reconstructs exact bytes and survives restart", async () => {
    const { store, objects } = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    const first = await protectDatabase({ store, codec, source, capture: async () => bytes });
    const before = new Map(objects);
    const changed = Buffer.from(bytes);
    changed.write("synthetic update", 700_000);
    const second = await protectDatabase({ store, codec, source, capture: async () => changed,
      now: new Date(Date.parse(first.manifest.createdAt) + 900_000) });
    expect(second.manifest.previousPoint).toBe(first.manifest.point);
    expect(second.manifest.newChunks).toBeGreaterThan(0);
    expect(second.manifest.newChunks).toBeLessThan(second.manifest.chunks.length);
    expect(second.manifest.newBytes).toBeLessThan(bytes.length);
    expect((await reconstructForTest(store, codec, second.marker)).equals(changed)).toBe(true);
    for (const [name, contents] of before) expect(objects.get(name)?.equals(contents)).toBe(true);
    // New client instance, no in-memory baseline/cache.
    const latest = await latestDatabasePoint({ ...store }, codec, source);
    expect(latest && (await reconstructForTest(store, codec, latest.marker)).equals(changed)).toBe(true);
    expect((await reconstructForTest(store, codec, first.marker)).equals(bytes)).toBe(true);
  });
  it("unchanged exports upload no new data chunks", async () => {
    const { store } = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    await protectDatabase({ store, codec, source, capture: async () => bytes });
    const point = await protectDatabase({ store, codec, source, capture: async () => bytes });
    expect(point.manifest.newChunks).toBe(0);
    expect(point.manifest.newBytes).toBe(0);
  });
  it("resumes encrypted orphan chunks after a mid-transfer interruption", async () => {
    const fixture = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    let writes = 0;
    const interrupted = { ...fixture.store, put: async (name: string, content: Buffer) => {
      if (++writes === 3) throw new Error("Synthetic mid-upload interruption");
      await fixture.store.put(name, content);
    } };
    await expect(protectDatabase({ store: interrupted, codec, source, capture: async () => bytes })).rejects.toThrow();
    expect([...fixture.objects.keys()].some(name => name.startsWith("verified-"))).toBe(false);
    const saved = new Map(fixture.objects);
    const point = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    expect(point.manifest.newChunks).toBeLessThan(point.manifest.chunks.length);
    for (const [name, content] of saved) expect(fixture.objects.get(name)?.equals(content)).toBe(true);
    expect((await reconstructForTest(fixture.store, codec, point.marker)).equals(bytes)).toBe(true);
  });
  it("does not hide a damaged new commit marker behind an older successful point", async () => {
    const fixture = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    const first = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    const broken = { ...fixture.store, put: async (name: string, content: Buffer) => {
      await fixture.store.put(name, name.startsWith("verified-") ? Buffer.from("corrupt") : content);
    } };
    await expect(protectDatabase({ store: broken, codec, source, capture: async () => bytes })).rejects.toThrow();
    await expect(latestDatabasePoint(fixture.store, codec, source)).rejects.toThrow();
    expect((await reconstructForTest(fixture.store, codec, first.marker)).equals(bytes)).toBe(true);
  });
  it("handles inserts and removes with content-defined reuse", async () => {
    const { store } = syntheticStore(), codec = syntheticCodec();
    // Fixed synthetic bytes make boundary reuse reproducible. Random exports
    // can hit only maximum-size cuts after an insertion and legitimately reuse none.
    const fixture = createCipheriv("aes-256-ctr", Buffer.alloc(32, 0x5a), Buffer.alloc(16, 0xa5));
    const bytes = Buffer.concat([Buffer.from("PGDMP"), fixture.update(Buffer.alloc(4 * 1024 * 1024)), fixture.final()]);
    await protectDatabase({ store, codec, source, capture: async () => bytes });
    const edited = Buffer.concat([bytes.subarray(0, 300_000), Buffer.alloc(100, 0x53),
      bytes.subarray(300_020)]);
    const point = await protectDatabase({ store, codec, source, capture: async () => edited });
    expect((await reconstructForTest(store, codec, point.marker)).equals(edited)).toBe(true);
    expect(point.manifest.newChunks).toBeLessThan(point.manifest.chunks.length);
  });
  it("preserves the verified baseline after interrupted uploads and retries", async () => {
    const fixture = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    const first = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    fixture.fail(true);
    await expect(protectDatabase({ store: fixture.store, codec, source, capture: async () => dump() })).rejects.toThrow();
    expect((await latestDatabasePoint(fixture.store, codec, source))?.marker).toBe(first.marker);
    fixture.fail(false);
    const retried = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    expect((await reconstructForTest(fixture.store, codec, retried.marker)).equals(bytes)).toBe(true);
  });
  it.each(["missing chunk", "corrupt chunk", "corrupt manifest", "corrupt marker"])("refuses %s rather than reporting a healthy chain", async failure => {
    const { store, objects } = syntheticStore(), codec = syntheticCodec();
    const point = await protectDatabase({ store, codec, source, capture: async () => dump() });
    const key = failure.includes("chunk") ? [...objects.keys()].find(name => name.startsWith("chunk-"))!
      : failure.includes("manifest") ? [...objects.keys()].find(name => name.startsWith("point-"))! : point.marker;
    if (failure === "missing chunk") objects.delete(key);
    else objects.set(key, randomBytes(100));
    await expect(latestDatabasePoint(store, codec, source)).rejects.toThrow();
  });
  it("does not commit an export failure or an invalid database dump", async () => {
    const { store, objects } = syntheticStore(), codec = syntheticCodec();
    await expect(protectDatabase({ store, codec, source, capture: async () => { throw new Error("Synthetic export error"); } })).rejects.toThrow();
    await expect(protectDatabase({ store, codec, source, capture: async () => Buffer.from("not pg_dump") })).rejects.toThrow();
    expect(objects.size).toBe(0);
  });
  it("fails read-back verification without replacing the prior baseline", async () => {
    const fixture = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    const first = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    const broken: DatabaseObjectStore = { ...fixture.store,
      put: async (name, content) => fixture.store.put(name, Buffer.concat([content, Buffer.from("corrupt")])) };
    await expect(protectDatabase({ store: broken, codec, source, capture: async () => dump() })).rejects.toThrow(/integrity/);
    expect((await reconstructForTest(fixture.store, codec, first.marker)).equals(bytes)).toBe(true);
  });
  it("rejects cross-source recovery and live restore targets before touching them", async () => {
    const { store } = syntheticStore(), codec = syntheticCodec();
    const point = await protectDatabase({ store, codec, source, capture: async () => dump() });
    await expect(verifyDatabasePoint(store, codec, "b".repeat(64), point.marker)).rejects.toThrow(/source/);
    await expect(restoreDatabasePointIsolated({ store, codec, source, marker: point.marker,
      targetUrl: "postgresql://invalid.example/production", isolationAcknowledged: true })).rejects.toThrow(/disposable/);
  });
  it("bounds chunks and refuses non-database content", () => {
    expect(databaseChunks(dump()).every(chunk => chunk.length <= MAX_DATABASE_CHUNK_BYTES)).toBe(true);
    expect(() => databaseChunks(Buffer.alloc(0))).toThrow();
  });
  it("preserves deterministic manifest chunk boundaries across stream read sizes", async () => {
    const bytes = dump();
    const expected = databaseChunks(bytes).map(chunk => ({
      hash: createHash("sha256").update(chunk).digest("hex"),
      bytes: chunk.length,
    }));
    async function* fragmented(): AsyncGenerator<Buffer> {
      for (let offset = 0, size = 8191; offset < bytes.length; size = size % 65521 + 1) {
        yield bytes.subarray(offset, offset + size);
        offset += size;
      }
    }
    const { store } = syntheticStore();
    const point = await protectDatabase({ store, codec: syntheticCodec(), source, capture: fragmented });
    expect(point.manifest.chunks).toEqual(expected);
  });
  it("captures, stores, and verifies a synthetic export larger than 512 MiB with bounded chunks", async () => {
    const { store, objects } = syntheticStore();
    const codec = syntheticCodec();
    const dumpBytes = 513 * 1024 * 1024;
    const block = Buffer.alloc(64 * 1024);
    async function* largeDump(): AsyncGenerator<Buffer> {
      yield Buffer.from("PGDMP");
      let remaining = dumpBytes - 5;
      while (remaining > 0) {
        const length = Math.min(block.length, remaining);
        yield block.subarray(0, length);
        remaining -= length;
      }
    }
    const point = await protectDatabase({ store, codec, source, capture: largeDump });
    expect(point.manifest.dumpBytes).toBe(dumpBytes);
    expect(point.manifest.dumpBytes).toBeGreaterThan(512 * 1024 * 1024);
    expect(point.manifest.chunks.length).toBeLessThan(1024);
    expect(objects.size).toBeLessThan(10);
    let verifiedBytes = 0;
    let largestVerifiedChunk = 0;
    const verified = await verifyDatabasePoint(store, codec, source, point.marker, async chunk => {
      verifiedBytes += chunk.length;
      largestVerifiedChunk = Math.max(largestVerifiedChunk, chunk.length);
    });
    expect(verified.manifest.dumpBytes).toBe(dumpBytes);
    expect(verifiedBytes).toBe(dumpBytes);
    expect(largestVerifiedChunk).toBeLessThanOrEqual(MAX_DATABASE_CHUNK_BYTES);
  }, 120_000);
  it("marks retained point dependencies and leaves young orphan uploads untouched", async () => {
    const fixture = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    const first = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    const second = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes,
      now: new Date(Date.parse(first.manifest.createdAt) + 900_000) });
    const orphan = `chunk-${"f".repeat(64)}.enc`;
    fixture.objects.set(orphan, codec.encrypt(Buffer.from("orphan")));
    fixture.createdAt.set(orphan, new Date(Date.now() - 60 * 60_000).toISOString());
    const plan = await planDatabaseRetentionSweep({
      store: fixture.store, codec, source,
      policy: { ...DATABASE_PROTECTION_RETENTION_POLICY, safetyGraceHours: 48 },
    });
    expect(plan.retainedPoints).toContain(first.marker);
    expect(plan.retainedPoints).toContain(second.marker);
    expect(plan.retainedChunks).toEqual(expect.arrayContaining(first.manifest.chunks.map(c => `chunk-${c.hash}.enc`)));
    expect(plan.candidates).not.toContain(orphan);
    expect(plan.protectedByGrace).toBeGreaterThan(0);
  });
  it("plans no deletion until a verified recovery point exists", async () => {
    const fixture = syntheticStore();
    const orphan = `chunk-${"d".repeat(64)}.enc`;
    fixture.objects.set(orphan, Buffer.from("interrupted upload"));
    fixture.createdAt.set(orphan, new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString());
    const plan = await planDatabaseRetentionSweep({
      store: fixture.store, codec: syntheticCodec(), source,
      policy: { ...DATABASE_PROTECTION_RETENTION_POLICY, safetyGraceHours: 48 },
    });
    expect(plan.candidates).toEqual([]);
    expect(plan.protectedByGrace).toBe(1);
  });
  it("fails closed on damaged verified metadata or manifests", async () => {
    const fixture = syntheticStore(), codec = syntheticCodec(), bytes = dump();
    const point = await protectDatabase({ store: fixture.store, codec, source, capture: async () => bytes });
    const manifestName = `point-${Date.parse(point.manifest.createdAt)}-${point.manifest.point}.enc`;
    const manifest = fixture.objects.get(manifestName)!;
    fixture.objects.set(manifestName, Buffer.concat([manifest, Buffer.from("damaged")]));
    await expect(planDatabaseRetentionSweep({
      store: fixture.store, codec, source,
      policy: { ...DATABASE_PROTECTION_RETENTION_POLICY, safetyGraceHours: 48 },
    })).rejects.toThrow();
    fixture.objects.set(manifestName, manifest);
    fixture.objects.set(point.marker, Buffer.concat([fixture.objects.get(point.marker)!, Buffer.from("damaged")]));
    await expect(planDatabaseRetentionSweep({
      store: fixture.store, codec, source,
      policy: { ...DATABASE_PROTECTION_RETENTION_POLICY, safetyGraceHours: 48 },
    })).rejects.toThrow();
  });
});
