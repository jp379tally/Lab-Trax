import archiver from "archiver";
import AdmZip from "adm-zip";
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { captureProductionMedia } from "./production-content-capture";
import { planBackupMedia, type BackupFileEvidence } from "./backup-media-producer";
import type { captureCompleteBackup } from "./complete-backup";
import type { ProductionFile } from "./production-content-protection";

describe("production streaming capture uses the real pinned media producer", () => {
  it("streams/hash-checks readable files without building an archive, preserving missing-reference evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "labtrax-content-producer-"));
    try {
      const bytes = Buffer.from("synthetic production picture");
      await writeFile(join(root, "photo.png"), bytes);
      const files: BackupFileEvidence[] = [];
      const planned = await planBackupMedia(root, [], undefined, { onFile: f => files.push(f) });
      const append: typeof planned.append = (archive, maxConcurrentFiles, includeArchivePaths) =>
        planned.append(archive, maxConcurrentFiles, includeArchivePaths
          ? new Set([...includeArchivePaths].map(name =>
            name.startsWith("case-media/") ? `media/${name.slice("case-media/".length)}` : name))
          : undefined);
      const captured = {
        append, durableBytes: bytes.length,
        productionMediaSources: planned.sourceVersions.map(source => ({
          ...source, archivePath: `case-media/${source.relativeName}`,
        })),
        manifest: { files, missingReferences: ["case-media/synthetic-missing.pdf"], databaseSha256: "a".repeat(64) },
      } as unknown as Awaited<ReturnType<typeof captureCompleteBackup>>;
      const stored: ProductionFile[] = [];
      const result = await captureProductionMedia(captured, async (path, stream, sourceVersion) => {
        const parts: Buffer[] = [];
        for await (const b of stream) parts.push(Buffer.from(b));
        const received = Buffer.concat(parts);
        expect(received.equals(bytes)).toBe(true);
        const f = {
          path, bytes: received.length, hash: createHash("sha256").update(received).digest("hex"),
          chunks: [], sourceVersion,
        };
        stored.push(f); return f;
      }, sources => new Set(sources.map(source => source.archivePath)));
      expect(stored[0]?.path).toBe("case-media/photo.png");
      expect(result.missingReferences).toHaveLength(1);
      expect(result.coverageLimitations).toEqual([expect.stringMatching(/writer journal coverage is not complete/)]);
      expect(files).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("writes a standalone ZIP while seeding only selected incremental files (unchanged=%s)", async unchanged => {
    const root = await mkdtemp(join(tmpdir(), "labtrax-shared-baseline-"));
    try {
      const original = Buffer.alloc(512 * 1024 + 17, 37);
      await writeFile(join(root, "photo.png"), original);
      const files: BackupFileEvidence[] = [];
      const planned = await planBackupMedia(root, [], undefined, { onFile: file => files.push(file) });
      const captured = {
        append: planned.append,
        productionMediaSources: planned.sourceVersions.map(source => ({ ...source,
          archivePath: 'case-media/' + source.relativeName })),
        manifest: { files, missingReferences: [], productionMediaWriterCoverage: { protocol: 1 } },
      } as unknown as Awaited<ReturnType<typeof captureCompleteBackup>>;
      const zip = archiver("zip");
      const chunks: Buffer[] = [];
      zip.on("data", bytes => chunks.push(Buffer.from(bytes)));
      const finished = new Promise<void>((resolve, reject) => { zip.once("end", resolve); zip.once("error", reject); });
      let capturedBytes = 0;
      const result = await captureProductionMedia(captured, async (path, stream, sourceVersion) => {
        const parts: Buffer[] = [];
        for await (const part of stream) { parts.push(Buffer.from(part)); capturedBytes += part.length; }
        const received = Buffer.concat(parts);
        expect(received.equals(original)).toBe(true);
        return { path, sourceVersion, bytes: received.length,
          hash: createHash("sha256").update(received).digest("hex"), chunks: [] };
      }, sources => new Set(unchanged ? [] : sources.map(source => source.archivePath)), zip);
      await zip.finalize(); await finished;
      expect(new AdmZip(Buffer.concat(chunks)).readFile("media/photo.png")?.equals(original)).toBe(true);
      expect(capturedBytes).toBe(unchanged ? 0 : original.length);
      expect(files).toHaveLength(1);
      expect(result.sourceVersions).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects sources changed after inventory instead of committing a mixed point", async () => {
    const root = await mkdtemp(join(tmpdir(), "labtrax-content-producer-"));
    try {
      await writeFile(join(root, "photo.png"), "before");
      const files: BackupFileEvidence[] = [];
      const planned = await planBackupMedia(root, [], undefined, { onFile: f => files.push(f) });
      await writeFile(join(root, "photo.png"), "different-after-inventory");
      const append: typeof planned.append = (archive, maxConcurrentFiles, includeArchivePaths) =>
        planned.append(archive, maxConcurrentFiles, includeArchivePaths
          ? new Set([...includeArchivePaths].map(name =>
            name.startsWith("case-media/") ? `media/${name.slice("case-media/".length)}` : name))
          : undefined);
      const captured = {
        append, durableBytes: 6,
        productionMediaSources: planned.sourceVersions.map(source => ({
          ...source, archivePath: `case-media/${source.relativeName}`,
        })),
        manifest: { files, missingReferences: [] },
      } as unknown as Awaited<ReturnType<typeof captureCompleteBackup>>;
      await expect(captureProductionMedia(
        captured, async () => { throw new Error("Should not open changed file"); },
        sources => new Set(sources.map(source => source.archivePath)),
      )).rejects.toThrow(/changed/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// These filesystem/stream tests must not initialize a database connection.
vi.mock("@workspace/db", () => ({ pool: {
  query: () => { throw new Error("Unexpected database access in stream unit test"); },
  connect: () => { throw new Error("Unexpected database access in stream unit test"); },
} }));
