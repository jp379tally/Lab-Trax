import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { captureCompleteBackup, validateCompleteRecovery } from "./complete-backup";

const fake = vi.hoisted(() => {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("pg_export_snapshot")
      ? [{ snapshot: "synthetic-snapshot", at: "2026-10-25T00:00:00Z", database: "synthetic-only" }]
      : sql.includes("FROM pg_class") ? [{ schema: "public", name: "synthetic_table" }]
      : sql.includes("AS users") ? [{ users: "0", organizations: "0", cases: "0" }]
      : sql.includes("count(*)::text AS count FROM labtrax_production_media_write_intents") ? [{ count: "0" }] : [],
  }));
  return { query, release: vi.fn() };
});
vi.mock("@workspace/db", () => ({ pool: { connect: async () => fake } }));
vi.mock("./onedrive", () => ({ isProductionDeployment: () => true }));
vi.mock("./backup-production-source", () => ({
  verifyProductionBackupSource: async () => "f".repeat(64),
}));
vi.mock("./case-media-object-storage", () => ({
  caseMediaObjectStorageAvailable: () => false,
  listCaseMediaBackupObjects: async () => [],
  listPrivateBackupObjects: async () => [],
  openPrivateBackupObject: async () => null,
  restorePrivateBackupObject: vi.fn(),
  restorePrivateBackupObjectStream: vi.fn(),
}));
vi.mock("./backup-phase", () => ({
  measureBackupPhase: async (_phase: string, work: () => Promise<unknown>) => work(),
  setBackupLiveProgress: vi.fn(),
}));

describe("production capture without unavailable software-release evidence (synthetic only)", () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function setup() {
    root = await fs.mkdtemp(path.join(tmpdir(), "synthetic-release-capture-"));
    const uploads = path.join(root, "uploads");
    await fs.mkdir(path.join(uploads, "case-media"), { recursive: true });
    await fs.writeFile(path.join(uploads, "case-media", "readable.pdf"), "synthetic readable attachment");
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith("build-identity.json")) {
        return JSON.stringify({ sourceRevision: "a".repeat(40) });
      }
      return read(...args);
    }) as typeof fs.readFile);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "synthetic-isolated-namespace");
    return uploads;
  }

  it("captures database and readable files, declares the missing sidecar and opens the resulting partial archive", async () => {
    const uploads = await setup();
    const captured = await captureCompleteBackup(
      uploads, async () => Buffer.from("synthetic database dump"), undefined,
      { archiveDestination: "direct", allowMissingReferences: true },
    );
    expect(captured.manifest.sourceRevision).toBe("a".repeat(40));
    expect(captured.manifest.releaseIdentity).toBeUndefined();
    expect(captured.manifest.missingReferences).toContain("desktop-installer/release-identity.json");
    expect(captured.manifest.recoveryCoverage).toBe("partial");
    const archive = archiver("zip");
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.once("end", resolve);
      archive.once("error", reject);
    });
    archive.append(JSON.stringify({
      coverageVersion: 2, archiveKind: "partial-production", recoveryCoverage: "partial",
      missingFileCount: captured.manifest.missingReferences!.length,
    }), { name: "manifest.json" });
    archive.append(captured.pgDump, { name: "db/database.pgdump" });
    await captured.append(archive);
    await archive.finalize();
    await done;
    const zip = new AdmZip(Buffer.concat(chunks));
    expect(validateCompleteRecovery(zip)?.recoveryCoverage).toBe("partial");
    expect(zip.readAsText("media/readable.pdf")).toBe("synthetic readable attachment");
    expect(zip.readAsText("missing-files.json")).toContain("desktop-installer/release-identity.json");
  });

  it("retains strict complete-capture rejection when partial coverage was not allowed", async () => {
    const uploads = await setup();
    await expect(captureCompleteBackup(uploads, async () => Buffer.from("synthetic dump")))
      .rejects.toThrow("requires a signed Desktop release identity sidecar");
    await expect(fs.readFile(path.join(uploads, "case-media", "readable.pdf"), "utf8"))
      .resolves.toBe("synthetic readable attachment");
  });

  it("stages streamed database bytes on disk and exposes them again without a dump-sized buffer", async () => {
    const uploads = await setup();
    const bytes = Buffer.from("PGDMPsynthetic streamed database dump");
    async function* source(): AsyncGenerator<Buffer> {
      yield bytes.subarray(0, 7);
      yield bytes.subarray(7, 21);
      yield bytes.subarray(21);
    }
    const captured = await captureCompleteBackup(
      uploads, async () => source(), undefined,
      { archiveDestination: "direct", allowMissingReferences: true, streamDatabaseDump: true },
    );
    try {
      const parts: Buffer[] = [];
      for await (const chunk of captured.pgDump) parts.push(Buffer.from(chunk));
      expect(Buffer.concat(parts)).toEqual(bytes);
      expect(captured.manifest.databaseSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally {
      await captured.dispose();
    }
  });
});
