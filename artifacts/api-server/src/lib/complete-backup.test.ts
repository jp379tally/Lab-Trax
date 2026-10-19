import { describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  includedBackupStagingObjectSizes, planCompleteBackupStaging, recoveryReferences, requireCompleteBackupCapacity,
  requireCompleteDestinationCapacity, restoreCompleteFiles,
  validateCompleteRecovery, type CompleteRecoveryManifest,
} from "./complete-backup";

vi.mock("@workspace/db", () => ({ pool: {} }));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify({ coverageVersion: 1 })));
  const dump = Buffer.from("synthetic PostgreSQL custom dump");
  zip.addFile("db/database.pgdump", dump);
  const manifest: CompleteRecoveryManifest = {
    coverageVersion: 1, sourceEnvironment: "production", sourceDatabase: "synthetic",
    sourceIdentitySha256: sha(Buffer.from("database identity")), storageNamespaceSha256: sha(Buffer.from("private namespace")),
    provenance: { productionLineageVerified: true, fingerprintSha256: sha(Buffer.from("committed fingerprint")) },
    snapshotAt: "2026-10-13T12:00:00Z", snapshot: "0001-0002-1", databaseSha256: sha(dump),
    tables: [{ schema: "public", name: "case_notes", rows: 1 }], files: [], requiredReferences: [], exclusions: [],
  };
  for (const [namespace, name] of [
    ["media", "video.mov"], ["media", "note-document.pdf"], ["local-uploads", "profile-photos/photo.jpg"],
    ["local-uploads", "legacy-case-data-backups/run/case.json"],
    ["private-objects", "support-reports/file"], ["private-objects", "lab-logos/lab.png"],
    ["private-objects", "invoice-template-images/lab/stamp.png"],
    ["private-objects", "case-print-template-images/lab/signature.svg"],
    ["private-objects", "legacy-case-data-backups/run/case.json"],
    ["private-objects", "case-media/.retained-evidence/private.json"],
    ["local-state", "legacy-chat.json"],
  ]) {
    const bytes = Buffer.from(`exact synthetic bytes for ${namespace}/${name}`);
    const archivePath = `${namespace}/${name}`;
    zip.addFile(archivePath, bytes);
    manifest.files.push({ archivePath, relativeName: name!, size: bytes.length, sha256: sha(bytes) });
    manifest.requiredReferences.push(namespace === "media" ? `case-media/${name}` : name!);
  }
  const save = () => zip.addFile("complete-recovery.json", Buffer.from(JSON.stringify(manifest)));
  save();
  return { zip, manifest, save };
}

describe("all-content recovery contract", () => {
  it("sizes only cloud objects included by the archive appenders", () => {
    const objects = [
      { relativeName: "case-media/case-file.bin", size: 1_200_000_000 },
      { relativeName: "case-media/backups/retained-case-file.bin", size: 100_000_000 },
      { relativeName: "profile-photos/synthetic.png", size: 400_000_000 },
      { relativeName: "backups/old-archive.zip", size: 40_000_000_000 },
      { relativeName: "backup-downloads/old-export.zip", size: 30_000_000_000 },
      { relativeName: ".labtrax-backup-staging/synthetic/production/archives/previous.zip.enc", size: 50_000_000_000 },
      { relativeName: ".sessions/expired-session.json", size: 20_000_000_000 },
      { relativeName: ".restore-snapshots/old-snapshot", size: 10_000_000_000 },
    ];
    expect(() => planCompleteBackupStaging(
      2_300_000_000, 1_700_000_000, objects.map(object => object.size), 70_000_000, "cloud",
    )).toThrow(/capacity failure.*no files were omitted/);
    const sizes = includedBackupStagingObjectSizes(objects);
    expect(sizes).toEqual([1_200_000_000, 100_000_000, 400_000_000]);
    const plan = planCompleteBackupStaging(2_300_000_000, 1_700_000_000, sizes, 70_000_000, "cloud");
    expect(plan.maxConcurrentFiles).toBe(2);
    expect(plan.stagedBytes).toBe(1_600_000_000);
    expect(plan.requiredBytes).toBeLessThanOrEqual(2_300_000_000);
  });

  it("reduces concurrent cloud staging to the available budget without reducing file coverage", () => {
    const plan = planCompleteBackupStaging(
      24_857_124_864,
      33_940_679_558,
      Array.from({ length: 12 }, () => 3_000_000_000),
      73_236_630,
      "cloud",
    );
    expect(plan.maxConcurrentFiles).toBe(8);
    expect(plan.stagedBytes).toBe(24_000_000_000);
    expect(plan.requiredBytes).toBeLessThanOrEqual(24_857_124_864);
  });

  it("fails closed when even the largest single required object cannot be staged", () => {
    expect(() => planCompleteBackupStaging(
      1_000_000_000, 1_200_000_000, [1_100_000_000], 73_000_000, "cloud",
    )).toThrow(/capacity failure.*no files were omitted/);
  });

  it("requires only bounded local working space for a complete cloud archive", () => {
    expect(() => requireCompleteBackupCapacity(24_975_241_216, 33_462_939_621, 1_100_000_000, 70_000_000, "cloud")).not.toThrow();
    expect(() => requireCompleteBackupCapacity(24_975_241_216, 33_462_939_621, 1_100_000_000, 70_000_000)).toThrow(/capacity failure/);
    expect(() => requireCompleteBackupCapacity(1_000_000_000, 33_462_939_621, 1_100_000_000, 70_000_000, "cloud")).toThrow(/no files were omitted/);
  });

  it("reserves a whole archive only where the archive itself is written", () => {
    // Streamed destinations need temporary space for staging and the dump only.
    expect(() => requireCompleteBackupCapacity(24_975_241_216, 33_462_939_621, 1_100_000_000, 70_000_000, "direct")).not.toThrow();
    // A destination on its own filesystem must hold the finished archive.
    expect(() => requireCompleteDestinationCapacity(24_975_241_216, 33_462_939_621, 70_000_000))
      .toThrow(/destination capacity failure.*no files were omitted/);
    expect(() => requireCompleteDestinationCapacity(40_000_000_000, 33_462_939_621, 70_000_000)).not.toThrow();
  });

  it("fails closed on invalid capacity evidence", () => {
    expect(() => requireCompleteBackupCapacity(NaN, 1, 1, 1, "cloud")).toThrow(/invalid/);
    expect(() => requireCompleteBackupCapacity(10_000, 1, -1, 1, "cloud")).toThrow(/invalid/);
  });

  it("refuses insufficient capacity without reducing required capture scope", () => {
    expect(() => requireCompleteBackupCapacity(1, 33_400_000_000, 100_000_000, 70_000_000)).toThrow(/capacity failure.*no files were omitted/);
    expect(() => requireCompleteBackupCapacity(100_000_000_000, 33_400_000_000, 100_000_000, 70_000_000)).not.toThrow();
  });
  it("verifies all durable class mappings and exact bytes without broadening legacy full coverage", () => {
    const { zip, manifest } = fixture();
    expect(validateCompleteRecovery(zip)).toEqual(manifest);
    zip.deleteFile("complete-recovery.json");
    expect(() => validateCompleteRecovery(zip)).toThrow(/evidence is missing/);
    zip.addFile("manifest.json", Buffer.from("{}"));
    expect(validateCompleteRecovery(zip)).toBeNull();
  });
  it("fails closed for missing profile images, evidence, documents and videos", () => {
    for (const file of fixture().manifest.files) {
      const { zip } = fixture();
      zip.deleteFile(file.archivePath);
      expect(() => validateCompleteRecovery(zip)).toThrow(/integrity/);
    }
  });
  it("restores representative case media byte-for-byte after validating the complete recovery archive", async () => {
    const source = fixture();
    const fileEvidence = source.manifest.files.find((file) => file.archivePath === "media/video.mov")!;
    const bytes = source.zip.getEntry(fileEvidence.archivePath)!.getData();
    const zip = new AdmZip();
    zip.addFile("manifest.json", source.zip.getEntry("manifest.json")!.getData());
    zip.addFile("db/database.pgdump", source.zip.getEntry("db/database.pgdump")!.getData());
    zip.addFile(fileEvidence.archivePath, bytes);
    const manifest: CompleteRecoveryManifest = {
      ...source.manifest,
      files: [fileEvidence],
      requiredReferences: ["case-media/video.mov"],
    };
    zip.addFile("complete-recovery.json", Buffer.from(JSON.stringify(manifest)));
    expect(validateCompleteRecovery(zip)).toEqual(manifest);

    const root = await mkdtemp(path.join(tmpdir(), "complete-backup-restore-"));
    try {
      await restoreCompleteFiles(zip, manifest, root);
      await expect(readFile(path.join(root, "case-media", "video.mov"))).resolves.toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects wrong bytes, corrupt database dumps, extra unaccounted files and uncovered references", () => {
    const badFile = fixture();
    badFile.zip.addFile("media/video.mov", Buffer.from("changed"));
    expect(() => validateCompleteRecovery(badFile.zip)).toThrow(/integrity/);
    const badDump = fixture();
    badDump.zip.addFile("db/database.pgdump", Buffer.from("truncated"));
    expect(() => validateCompleteRecovery(badDump.zip)).toThrow(/Database dump integrity/);
    const extra = fixture();
    extra.zip.addFile("private-objects/unrecorded", Buffer.from("x"));
    expect(() => validateCompleteRecovery(extra.zip)).toThrow(/coverage/);
    const missing = fixture();
    missing.manifest.requiredReferences.push("case-media/missing.pdf");
    missing.save();
    expect(() => validateCompleteRecovery(missing.zip)).toThrow(/coverage/);
  });
  it("rejects unsafe restore mappings and unverified table coverage", () => {
    const unsafe = fixture();
    unsafe.manifest.files[0]!.relativeName = "../outside";
    unsafe.save();
    expect(() => validateCompleteRecovery(unsafe.zip)).toThrow(/Unsafe/);
    const tables = fixture();
    tables.manifest.tables.push(tables.manifest.tables[0]!);
    tables.save();
    expect(() => validateCompleteRecovery(tables.zip)).toThrow(/manifest/);
  });
  it("resolves notes, inbox, statements, historical originals, logos and profile references", () => {
    expect([...recoveryReferences("invoice_attachments", { storage_key: "document.pdf" })]).toContain("case-media/document.pdf");
    expect([...recoveryReferences("lab_inbox_files", { storage_path: "video.mov" })]).toContain("case-media/video.mov");
    expect([...recoveryReferences("case_notes", { body: "/uploads/case-media/note.png" })]).toContain("case-media/note.png");
    expect([...recoveryReferences("practice_statements", {
      bundle_manifest_json: [{ storageKey: "issued.pdf" }],
    })]).toContain("case-media/issued.pdf");
    expect([...recoveryReferences("organizations", { id: "lab", logo_url: "/api/organizations/lab/logo" })]).toContain("lab-logos/lab.*");
    expect([...recoveryReferences("users", { profile_photo_url: "/uploads/profile-photos/p.jpg" })]).toContain("profile-photos/p.jpg");
    expect([...recoveryReferences("system_settings", {
      value: JSON.stringify({ backup: "legacy-case-data-backups/run/case.json" }),
    })]).toContain("legacy-case-data-backups/run/case.json");
  });
});
