import { describe, it, expect } from "vitest";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  protectProduction, latestProductionPoint, verifyProductionPoint, readProductionFile,
  type ProductionInventory, type MediaJournalCheckpoint,
} from "./production-content-protection";
import type { DatabaseObjectStore } from "./database-protection";
import type { ObjectVersion } from "./object-version-proof";
function setup(sourceVersionPrefix = "synthetic") {
  const key = randomBytes(32);
  const codec = {
    encrypt(b: Buffer) { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(b), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decrypt(b: Buffer) { const c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([c.update(b.subarray(28)), c.final()]); },
  };
  const objects = new Map<string, Buffer>(), dbObjects = new Map<string, Buffer>();
  const mediaChunkNames = new Set<string>();
  let remoteMediaBytesRead = 0;
  let remoteBytesRead = 0, versionMetadataReads = 0;
  const make = (map: Map<string, Buffer>): DatabaseObjectStore => ({
    list: async () => [...map.keys()].map(name => ({ name, createdAt: null })),
    get: async n => {
      const bytes = map.get(n) ?? null;
      if (map === objects && bytes) remoteBytesRead += bytes.length;
      if (map === objects && bytes && mediaChunkNames.has(n)) remoteMediaBytesRead += bytes.length;
      return bytes;
    },
    getIntegrity: async n => {
      const bytes = map.get(n);
      return bytes
        ? { bytes: bytes.length, sha1: createHash("sha1").update(bytes).digest("hex"),
          sha256: createHash("sha256").update(bytes).digest("hex") }
        : null;
    },
    put: async (n, b) => { if (map.has(n)) throw new Error("No overwrite"); map.set(n, Buffer.from(b)); },
    delete: async name => { map.delete(name); },
  });
  const options = { source: "a".repeat(64), codec, store: make(objects), databaseStore: make(dbObjects) };
  const remoteVersions = new Map<string, ObjectVersion>();
  const versionFor = (name: string) => {
    const bytes = objects.get(name);
    if (!bytes) return null;
    if (!remoteVersions.has(name)) remoteVersions.set(name, {
      provider: "onedrive-content-v1", driveId: "synthetic-drive",
      itemId: `synthetic-${name}`, contentTag: "version-1", bytes: bytes.length,
    });
    return { ...remoteVersions.get(name)!, bytes: bytes.length };
  };
  let dump: Buffer = Buffer.from("PGDMPsynthetic-baseline");
  const files = new Map<string, Buffer>();
  const versions = new Map<string, number>();
  let sourceBytesRead = 0;
  const setFile = (path: string, bytes: Buffer) => {
    files.set(path, Buffer.from(bytes));
    versions.set(path, (versions.get(path) ?? 0) + 1);
  };
  const removeFile = (path: string) => { files.delete(path); versions.delete(path); };
  const setUnversioned = (path: string) => { files.set(path, Buffer.from(files.get(path)!)); versions.set(path, -1); };
  setFile("case-media/photo.png", randomBytes(2 * 1024 * 1024 + 29));
  setFile("private-objects/clip.mp4", randomBytes(512));
  const missing: string[] = [];
  let journal: MediaJournalCheckpoint | undefined;
  let limitations: string[] = [];
  const protect = () => protectProduction({ ...options, capture: async () => dump,
    captureMedia: async (write, selectPaths) => {
      const sourceVersions = [...files].map(([archivePath, bytes]) => ({
        archivePath, size: bytes.length,
        sourceVersion: versions.get(archivePath) === -1 ? null : `${sourceVersionPrefix}:${versions.get(archivePath)}`,
      }));
      const selected = selectPaths(sourceVersions, journal);
      for (const [path, bytes] of files) {
        if (!selected.has(path)) continue;
        sourceBytesRead += bytes.length;
        await write(path, Readable.from([bytes]), `${sourceVersionPrefix}:${versions.get(path)}`);
      }
      return {
        sourceVersions,
        missingReferences: [...missing],
        coverageLimitations: limitations,
        evidence: { databaseSha256: createHash("sha256").update(dump).digest("hex"),
          ...(journal ? { productionMediaJournal: journal } : {}) },
      };
    } });
  const rewritePoint = (markerName: string, edit: (root: Record<string, any>) => void) => {
    const marker = JSON.parse(codec.decrypt(objects.get(markerName)!).toString());
    const root = JSON.parse(codec.decrypt(objects.get(marker.root)!).toString());
    edit(root);
    const encrypted = codec.encrypt(Buffer.from(JSON.stringify(root)));
    objects.set(marker.root, encrypted);
    marker.hash = createHash("sha256").update(encrypted).digest("hex");
    objects.set(markerName, codec.encrypt(Buffer.from(JSON.stringify(marker))));
  };
  return {
    options, objects, dbObjects, files, missing, protect, setFile, removeFile, setUnversioned,
    rewritePoint,
    rewriteInventory(markerName: string, edit: (entries: Record<string, any>) => void) {
      rewritePoint(markerName, root => {
        const bytes = Buffer.concat(root.inventory.map((c: { hash: string }) => codec.decrypt(objects.get(`chunk-${c.hash}.enc`)!)));
        const entries = JSON.parse(bytes.toString()); edit(entries);
        const replacement = Buffer.from(JSON.stringify(entries));
        expect(replacement.length).toBeLessThan(1024 * 1024);
        const encrypted = codec.encrypt(replacement);
        const hash = createHash("sha256").update(replacement).digest("hex");
        objects.set(`chunk-${hash}.enc`, encrypted);
        root.inventory = [{ hash, bytes: replacement.length,
          remoteSha256: createHash("sha256").update(encrypted).digest("hex"), remoteBytes: encrypted.length }];
        root.inventoryHash = hash; root.inventoryBytes = replacement.length;
      });
    },
    enableVersionContinuity() {
      options.store.getVersion = async name => { versionMetadataReads++; return versionFor(name); };
      options.store.getIntegrity = async name => {
        const bytes = objects.get(name);
        return bytes ? { bytes: bytes.length, sha1: null, sha256: null } : null;
      };
    },
    changeVersion(name: string, changes: Partial<ObjectVersion>) {
      const current = versionFor(name);
      if (!current) throw new Error("Synthetic object absent");
      remoteVersions.set(name, { ...current, ...changes });
    },
    get sourceBytesRead() { return sourceBytesRead; },
    get remoteMediaBytesRead() { return remoteMediaBytesRead; },
    get remoteBytesRead() { return remoteBytesRead; },
    get versionMetadataReads() { return versionMetadataReads; },
    resetRemoteMediaBytesRead() { remoteMediaBytesRead = 0; },
    trackMediaEntries(entries: ProductionInventory["files"]) {
      for (const entry of entries) {
        for (const c of entry.chunks) mediaChunkNames.add(`chunk-${c.hash}.enc`);
      }
    },
    setDump: (b: Buffer) => { dump = b; },
    setJournal: (value: typeof journal) => { journal = value; },
    setLimitations: (value: string[]) => { limitations = value; },
  };
}
describe("production records plus media incremental storage", () => {
  it.each(["matching", "mismatched", "missing"] as const)("classifies journaled additions with %s writer evidence", async evidence => {
    const f = setup("generation");
    f.setJournal({ afterPosition: "0", throughPosition: "0", events: [] });
    const baseline = await f.protect();
    const bytes = Buffer.from("synthetic new attachment");
    f.setFile("case-media/new.pdf", bytes);
    f.setJournal({ afterPosition: "0", throughPosition: evidence === "missing" ? "0" : "1", events: evidence === "missing" ? [] : [
      { position: "1", operation: "add", objectKey: "case-media/new.pdf", sourceTable: "writer:synthetic",
        sourceGeneration: evidence === "matching" ? "1" : "wrong-generation" },
    ] });
    const before = f.sourceBytesRead;
    const point = await f.protect();
    expect(point.root.coverage).toBe(evidence === "matching" ? "complete" : "partial");
    expect(point.inventory.coverageLimitations).toHaveLength(evidence === "matching" ? 0 : 1);
    expect(f.sourceBytesRead - before).toBe(bytes.length);
    const restored: Buffer[] = [];
    await readProductionFile(f.options, point.inventory.files.find(file => file.path === "case-media/new.pdf")!,
      async part => { restored.push(part); });
    expect(Buffer.concat(restored).equals(bytes)).toBe(true);
    expect((await verifyProductionPoint(f.options, baseline.marker)).root.point).toBe(baseline.root.point);
  });

  it("rebinds legacy inventory objects even when there are no readable media files", async () => {
    const f = setup(); f.files.clear();
    await f.protect();
    f.enableVersionContinuity();
    const rebound = await f.protect();
    expect(rebound.root.inventory.every(c => Boolean(c.remoteVersion))).toBe(true);
    await f.protect();
  });
  it("rebinds a legacy verified baseline once, persists receipts and avoids repeated old-media read-back", async () => {
    const f = setup();
    const legacy = await f.protect();
    f.trackMediaEntries(legacy.inventory.files);
    const initialSourceBytes = f.sourceBytesRead;
    f.enableVersionContinuity();
    f.resetRemoteMediaBytesRead();
    const rebound = await f.protect();
    expect(f.remoteMediaBytesRead).toBeGreaterThan(0);
    expect(f.sourceBytesRead).toBe(initialSourceBytes);
    expect(rebound.inventory.files.every(entry => entry.chunks.every(c => Boolean(c.remoteVersion && c.remoteSha256)))).toBe(true);
    f.resetRemoteMediaBytesRead();
    await f.protect();
    expect(f.remoteMediaBytesRead).toBe(0);
    expect(f.sourceBytesRead).toBe(initialSourceBytes);
  });
  it("binds initial SHA256/authenticated bytes to versions and reuses them without old media reads", async () => {
    const f = setup(); f.enableVersionContinuity();
    const baselineStarted = Date.now();
    const baseline = await f.protect();
    const baselineMs = Date.now() - baselineStarted;
    const baselineRemoteBytes = f.remoteBytesRead;
    for (const entry of baseline.inventory.files) {
      for (const c of entry.chunks) {
        expect(c.remoteVersion?.provider).toBe("onedrive-content-v1");
        expect(c.remoteSha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    f.trackMediaEntries(baseline.inventory.files);
    const initialRead = f.sourceBytesRead;
    const baselineMetadataReads = f.versionMetadataReads;
    f.resetRemoteMediaBytesRead();
    const unchangedStarted = Date.now();
    const unchanged = await f.protect();
    const unchangedMs = Date.now() - unchangedStarted;
    const unchangedRemoteBytes = f.remoteBytesRead - baselineRemoteBytes;
    const unchangedMetadataReads = f.versionMetadataReads - baselineMetadataReads;
    expect(f.sourceBytesRead).toBe(initialRead);
    expect(f.remoteMediaBytesRead).toBe(0);
    f.setFile("case-media/photo.png", Buffer.from("new synthetic photo"));
    const changedStarted = Date.now();
    const changed = await f.protect();
    const changedMs = Date.now() - changedStarted;
    expect(f.sourceBytesRead - initialRead).toBe(Buffer.byteLength("new synthetic photo"));
    for (const point of [baseline, unchanged, changed]) {
      await verifyProductionPoint(f.options, point.marker);
    }
    console.log("[synthetic version-bound reuse]", JSON.stringify({
      baselineSourceBytes: initialRead, unchangedSourceBytes: 0,
      unchangedRemoteMediaBytes: 0, changedSourceBytes: f.sourceBytesRead - initialRead,
      baselineRemoteBytes, unchangedRemoteBytes, unchangedMetadataReads,
      baselineMs, unchangedMs, changedMs,
      oldPointRetained: f.objects.has(baseline.marker),
    }));
  });
  it.each(["contentTag", "itemId", "driveId"] as const)("rejects changed %s even for same-size bytes", async field => {
    const f = setup(); f.enableVersionContinuity();
    const baseline = await f.protect();
    const c = baseline.inventory.files[0]!.chunks[0]!;
    f.changeVersion(`chunk-${c.hash}.enc`, { [field]: "synthetic-changed" });
    const before = f.sourceBytesRead;
    await expect(f.protect()).rejects.toThrow(/continuity/);
    expect(f.sourceBytesRead).toBe(before);
    expect(f.objects.has(baseline.marker)).toBe(true);
  });
  it("rejects a race during initial byte verification without committing a point", async () => {
    const f = setup(); f.enableVersionContinuity();
    const get = f.options.store.get;
    let replaced = false;
    f.options.store.get = async name => {
      const bytes = await get(name);
      if (!replaced && name.startsWith("chunk-") && bytes) {
        replaced = true;
        f.changeVersion(name, { contentTag: "concurrent-replacement" });
      }
      return bytes;
    };
    await expect(f.protect()).rejects.toThrow(/continuity|read-back/);
    expect([...f.objects.keys()].some(n => n.startsWith("verified-"))).toBe(false);
  });
  it("rechecks versions before commit and rejects concurrent reuse replacement", async () => {
    const f = setup(); f.enableVersionContinuity();
    const baseline = await f.protect();
    const name = `chunk-${baseline.inventory.files[0]!.chunks[0]!.hash}.enc`;
    const getVersion = f.options.store.getVersion!;
    let reads = 0;
    f.options.store.getVersion = async n => {
      if (n === name && ++reads === 2) f.changeVersion(name, { contentTag: "concurrent-reuse-change" });
      return getVersion(n);
    };
    await expect(f.protect()).rejects.toThrow(/continuity/);
    expect([...f.objects.keys()].filter(n => n.startsWith("verified-"))).toHaveLength(1);
  });
  it("refuses missing version evidence and same-size physical corruption at full read-back", async () => {
    const f = setup(); f.enableVersionContinuity();
    const baseline = await f.protect();
    const name = `chunk-${baseline.inventory.files[0]!.chunks[0]!.hash}.enc`;
    const getVersion = f.options.store.getVersion!;
    f.options.store.getVersion = async n => n === name ? null : getVersion(n);
    await expect(f.protect()).rejects.toThrow(/continuity/);
    f.options.store.getVersion = getVersion;
    const corrupt = Buffer.from(f.objects.get(name)!); corrupt[corrupt.length - 1]! ^= 1;
    f.objects.set(name, corrupt);
    // Metadata continuity is not represented as a new physical-byte scrub.
    await expect(verifyProductionPoint(f.options, baseline.marker)).rejects.toThrow(/authentication|SHA-256/);
  });
  it("rejects a missing ancestor and authenticated cyclic or out-of-order ancestry", async () => {
    const f = setup();
    const baseline = await f.protect();
    const changed = await f.protect();
    const markerCipher = Buffer.from(f.objects.get(changed.marker)!);
    const marker = JSON.parse(f.options.codec.decrypt(markerCipher).toString());
    const rootCipher = Buffer.from(f.objects.get(marker.root)!);
    const rewrite = (previousPoint: string) => {
      const root = JSON.parse(f.options.codec.decrypt(rootCipher).toString());
      root.previousPoint = previousPoint;
      const encrypted = f.options.codec.encrypt(Buffer.from(JSON.stringify(root)));
      f.objects.set(marker.root, encrypted);
      f.objects.set(changed.marker, f.options.codec.encrypt(Buffer.from(JSON.stringify({
        ...marker, hash: createHash("sha256").update(encrypted).digest("hex"),
      }))));
    };
    rewrite(changed.root.point);
    await expect(verifyProductionPoint(f.options, changed.marker)).rejects.toThrow(/Cyclic/);
    rewrite("00000000-0000-4000-8000-000000000001");
    await expect(verifyProductionPoint(f.options, changed.marker)).rejects.toThrow(/ancestor is missing/);
    f.objects.set(marker.root, rootCipher); f.objects.set(changed.marker, markerCipher);
    const removed = f.objects.get(baseline.marker)!;
    f.objects.delete(baseline.marker);
    await expect(verifyProductionPoint(f.options, changed.marker)).rejects.toThrow(/ancestor is missing/);
    f.objects.set(baseline.marker, removed);
    await verifyProductionPoint(f.options, changed.marker);
    await new Promise(resolve => setTimeout(resolve, 2));
    const future = await f.protect();
    f.rewritePoint(changed.marker, root => { root.previousPoint = future.root.point; });
    await expect(verifyProductionPoint(f.options, changed.marker)).rejects.toThrow(/ordering|Cyclic/);
  });
  it("rejects authenticated but inconsistent ancestor journal checkpoints", async () => {
    const f = setup();
    f.setJournal({ afterPosition: "0", throughPosition: "0", events: [] });
    const baseline = await f.protect();
    const changed = await f.protect();
    f.rewriteInventory(baseline.marker, entries => {
      entries.evidence.productionMediaJournal = {
        afterPosition: "0", throughPosition: "1",
        events: [{ position: "1", operation: "replace", objectKey: "case-media/photo.png", sourceTable: "synthetic" }],
      };
    });
    await expect(verifyProductionPoint(f.options, changed.marker)).rejects.toThrow(/ancestor journal checkpoints/);
  });
  it("rejects tampered encrypted proof inventories and deleted immutable dependencies", async () => {
    const f = setup(); f.enableVersionContinuity();
    const baseline = await f.protect();
    const name = `chunk-${baseline.root.inventory[0]!.hash}.enc`;
    const original = Buffer.from(f.objects.get(name)!);
    const tampered = Buffer.from(original); tampered[tampered.length - 1]! ^= 1;
    f.objects.set(name, tampered);
    await expect(verifyProductionPoint(f.options, baseline.marker)).rejects.toThrow(/authentication|SHA-256/);
    f.objects.set(name, original);
    f.objects.delete(`chunk-${baseline.inventory.files[0]!.chunks[0]!.hash}.enc`);
    await expect(f.protect()).rejects.toThrow(/continuity/);
  });
  it("reuses content and preserves old file versions/deletions with coherent database points after restart", async () => {
    const f = setup(); const original = Buffer.from(f.files.get("case-media/photo.png")!);
    const originalVideo = Buffer.from(f.files.get("private-objects/clip.mp4")!);
    const baselineStartedAt = Date.now();
    const baseline = await f.protect();
    const baselineDurationMs = Date.now() - baselineStartedAt;
    f.trackMediaEntries(baseline.inventory.files);
    const baselineChunkHashes = new Set(
      baseline.inventory.files.flatMap(entry => entry.chunks.map(c => c.hash)),
    );
    const baselineBytesRead = f.sourceBytesRead;
    const changedPhoto = Buffer.from("synthetic changed photo");
    const newPdf = Buffer.from("synthetic PDF attachment");
    f.setFile("case-media/photo.png", changedPhoto);
    f.removeFile("private-objects/clip.mp4");
    f.setFile("private-objects/new.pdf", newPdf);
    f.setDump(Buffer.from("PGDMPupdated-deleted-records"));
    const deltaStartedAt = Date.now();
    f.resetRemoteMediaBytesRead();
    const changed = await f.protect();
    const deltaDurationMs = Date.now() - deltaStartedAt;
    expect(f.sourceBytesRead - baselineBytesRead).toBe(changedPhoto.length + newPdf.length);
    expect(f.remoteMediaBytesRead).toBe(0);
    const changedChunkNames = new Set(
      changed.inventory.files.flatMap(entry => entry.chunks.map(c => `chunk-${c.hash}.enc`)),
    );
    const uploadedMediaBytes = [...changedChunkNames]
      .filter(name => !baselineChunkHashes.has(name.slice("chunk-".length, -".enc".length)))
      .reduce((sum, name) => sum + (f.objects.get(name)?.length ?? 0), 0);
    expect(uploadedMediaBytes).toBeGreaterThan(0);
    expect(changed.root.previousPoint).toBe(baseline.root.point);
    expect(changed.inventory.files.map(entry => entry.path)).toEqual([
      "case-media/photo.png", "private-objects/new.pdf",
    ]);
    const currentPhoto: Buffer[] = [];
    await readProductionFile(f.options, changed.inventory.files[0]!, async b => { currentPhoto.push(b); });
    expect(Buffer.concat(currentPhoto).equals(changedPhoto)).toBe(true);
    const restoredPdf: Buffer[] = [];
    await readProductionFile(f.options, changed.inventory.files[1]!, async b => { restoredPdf.push(b); });
    expect(Buffer.concat(restoredPdf).equals(newPdf)).toBe(true);
    const prior = await verifyProductionPoint(f.options, baseline.marker);
    const parts: Buffer[] = [];
    await readProductionFile(f.options, prior.inventory.files[0]!, async b => { parts.push(b); });
    expect(Buffer.concat(parts).equals(original)).toBe(true);
    const priorVideo: Buffer[] = [];
    const originalVideoEntry = prior.inventory.files.find(entry => entry.path === "private-objects/clip.mp4")!;
    await readProductionFile(f.options, originalVideoEntry, async b => { priorVideo.push(b); });
    expect(Buffer.concat(priorVideo).equals(originalVideo)).toBe(true);
    const restart = await latestProductionPoint(f.options);
    expect(restart?.root.point).toBe(changed.root.point);
    f.trackMediaEntries(changed.inventory.files);
    const beforeUnchangedCapture = f.sourceBytesRead;
    const unchangedStartedAt = Date.now();
    f.resetRemoteMediaBytesRead();
    const third = await f.protect();
    const unchangedDurationMs = Date.now() - unchangedStartedAt;
    expect(third.root.reusedChunks).toBeGreaterThan(0);
    expect(f.sourceBytesRead - beforeUnchangedCapture).toBe(0);
    expect(f.remoteMediaBytesRead).toBe(0);
    expect(third.inventory.files.map(entry => entry.path)).toEqual([
      "case-media/photo.png", "private-objects/new.pdf",
    ]);
    console.info("[synthetic production-media delta metrics]", JSON.stringify({
      baselineSourceBytesRead: baselineBytesRead,
      baselineDurationMs,
      changedSourceBytesRead: changedPhoto.length + newPdf.length,
      changedRemoteMediaBodyBytesRead: 0,
      changedEncryptedMediaBytesUploaded: uploadedMediaBytes,
      changedDurationMs: deltaDurationMs,
      unchangedSourceBytesRead: 0,
      unchangedRemoteMediaBodyBytesRead: 0,
      unchangedMediaBytesReused: changedPhoto.length + newPdf.length,
      unchangedDurationMs,
    }));
  });
  it("fails closed when a source lacks stable version metadata instead of silently rereading the full source", async () => {
    const f = setup();
    const p = await f.protect();
    f.setUnversioned("case-media/photo.png");
    await expect(f.protect()).rejects.toThrow(/no stable version identity/);
    expect([...f.objects.keys()].filter(k => k.startsWith("verified-"))).toEqual([p.marker]);
  });
  it("persists explicit missing references as partial, without fabricating originals", async () => {
    const f = setup(); f.missing.push("case-media/synthetic-unavailable.pdf");
    const p = await f.protect();
    expect(p.root.coverage).toBe("partial");
    expect(p.inventory.missingReferences).toEqual(f.missing);
    expect(p.inventory.files.some(file => file.path.includes("unavailable"))).toBe(false);
  });
  it("does not label unknown writer coverage complete or mix sourceVersions into the strict recovery inventory", async () => {
    const f = setup();
    f.setLimitations(["Synthetic untracked writer"]);
    const p = await f.protect();
    expect(p.root.coverage).toBe("partial");
    expect(p.inventory.coverageLimitations).toEqual(["Synthetic untracked writer"]);
    expect(p.inventory).not.toHaveProperty("sourceVersions");
    expect((await verifyProductionPoint(f.options, p.marker)).root.coverage).toBe("partial");
  });
  it("uses explicit journal replacements despite an unchanged source version and preserves the prior bytes", async () => {
    const f = setup();
    f.setJournal({ afterPosition: "0", throughPosition: "0", events: [] });
    const baseline = await f.protect();
    const prior = Buffer.from(f.files.get("private-objects/clip.mp4")!);
    const changed = randomBytes(prior.length);
    f.files.set("private-objects/clip.mp4", changed); // Deliberately unchanged version identity.
    f.setJournal({ afterPosition: "0", throughPosition: "1", events: [
      { position: "1", operation: "replace", objectKey: "clip.mp4", sourceTable: "synthetic_writer" },
    ] });
    const before = f.sourceBytesRead;
    const point = await f.protect();
    expect(f.sourceBytesRead - before).toBe(changed.length);
    const restored: Buffer[] = [];
    await readProductionFile(f.options, point.inventory.files.find(file => file.path === "private-objects/clip.mp4")!,
      async bytes => { restored.push(bytes); });
    expect(Buffer.concat(restored).equals(changed)).toBe(true);
    const old: Buffer[] = [];
    await readProductionFile(f.options, baseline.inventory.files.find(file => file.path === "private-objects/clip.mp4")!,
      async bytes => { old.push(bytes); });
    expect(Buffer.concat(old).equals(prior)).toBe(true);
  });
  it.each(["gap", "unresolved"])("rejects a %s journal continuation before committing a point", async mode => {
    const f = setup();
    f.setJournal({ afterPosition: "0", throughPosition: "0", events: [] });
    const baseline = await f.protect();
    f.setJournal({ afterPosition: "0", throughPosition: mode === "gap" ? "2" : "1", events: [
      { position: "1", operation: "replace", objectKey: "case-media/untracked.bin", sourceTable: "synthetic_writer" },
    ] });
    await expect(f.protect()).rejects.toThrow(mode === "gap" ? /gap/ : /no captured source/);
    expect([...f.objects.keys()].filter(name => name.startsWith("verified-"))).toEqual([baseline.marker]);
  });
  it("refuses SHA-1-only metadata reuse without downloading the unchanged collection, while restore remains possible", async () => {
    const f = setup();
    const baseline = await f.protect();
    f.trackMediaEntries(baseline.inventory.files);
    f.resetRemoteMediaBytesRead();
    const integrity = f.options.store.getIntegrity!;
    f.options.store.getIntegrity = async name => {
      const metadata = await integrity(name);
      return metadata ? { ...metadata, sha256: null } : null;
    };
    const before = f.sourceBytesRead;
    await expect(f.protect()).rejects.toThrow(/provider-calculated SHA-256/);
    expect(f.sourceBytesRead).toBe(before);
    expect(f.remoteMediaBytesRead).toBe(0);
    expect([...f.objects.keys()].filter(name => name.startsWith("verified-"))).toEqual([baseline.marker]);
    expect((await verifyProductionPoint(f.options, baseline.marker)).root.point).toBe(baseline.root.point);
    expect(f.remoteMediaBytesRead).toBeGreaterThan(0);
  });
  it.each(["missing", "corrupt"])("refuses %s media dependencies without advancing the last point", async mode => {
    const f = setup(); const p = await f.protect();
    const name = `chunk-${p.inventory.files[0]!.chunks[0]!.hash}.enc`;
    if (mode === "missing") f.objects.delete(name); else f.objects.set(name, randomBytes(80));
    await expect(f.protect()).rejects.toThrow();
    expect([...f.objects.keys()].filter(k => k.startsWith("verified-"))).toEqual([p.marker]);
  });
  it("retains baseline through interruption and retries immutable orphan chunks", async () => {
    const f = setup(); const p = await f.protect();
    f.setFile("case-media/new.pdf", Buffer.from("new synthetic file"));
    const put = f.options.store.put;
    f.options.store.put = async (name, b) => {
      if (name.startsWith("verified-")) throw new Error("Synthetic interruption");
      await put(name, b);
    };
    await expect(f.protect()).rejects.toThrow("interruption");
    expect((await verifyProductionPoint(f.options, p.marker)).root.point).toBe(p.root.point);
    f.options.store.put = put;
    expect((await f.protect()).inventory.files).toHaveLength(3);
  });
  it("does not commit a destination read-back failure or replace prior stored bytes", async () => {
    const f = setup(); const p = await f.protect();
    f.setFile("case-media/new.pdf", Buffer.from("new"));
    const getIntegrity = f.options.store.getIntegrity!; let uploads = 0;
    const put = f.options.store.put;
    f.options.store.put = async (n, b) => { await put(n, b); uploads++; };
    f.options.store.getIntegrity = async n => uploads
      ? { bytes: 1, sha1: null, sha256: "0".repeat(64) } : getIntegrity(n);
    await expect(f.protect()).rejects.toThrow(/provider integrity read-back/);
    f.options.store.getIntegrity = getIntegrity;
    expect((await verifyProductionPoint(f.options, p.marker)).root.point).toBe(p.root.point);
  });
  it("rejects unsafe restore paths and corrupt database dependencies", async () => {
    const f = setup(); f.files.set("../escape", Buffer.from("unsafe"));
    await expect(f.protect()).rejects.toThrow();
    f.files.delete("../escape"); const p = await f.protect();
    const key = [...f.dbObjects.keys()].find(k => k.startsWith("chunk-"))!;
    f.dbObjects.delete(key);
    await expect(verifyProductionPoint(f.options, p.marker)).rejects.toThrow(/missing/);
  });
});
