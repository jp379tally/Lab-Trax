import { describe, expect, it } from "vitest";
import { assessRecoveryEvidence, type RecoveryEvidence } from "./backup-recovery-evidence";

const now = Date.parse("2026-10-06T14:00:00Z");
function evidence(): RecoveryEvidence {
  return {
    now, enabled: true, intervalMinutes: 15, destination: "onedrive", listingComplete: true,
    archives: [{
      name: "backup.zip.enc", size: 100, itemId: "cloud-item", createdAt: new Date(now - 60_000).toISOString(),
      authenticatedManifest: {
        exportedBy: "scheduler:interval", sourceEnvironment: "production", coverageVersion: 2,
        coverageStatus: "complete", missingFileCount: 0,
      },
    }],
    runs: [{
      actor: "scheduler:interval", status: "success", destination: "onedrive",
      fileName: "backup.zip.enc", size: 100, completedAt: new Date(now - 60_000).toISOString(),
      remoteItemId: "cloud-item", archiveKind: "complete-production",
    }],
  };
}
describe("Production-to-OneDrive recovery evidence", () => {
  it("accepts only a fresh retained, size-matched production scheduler archive", () => {
    expect(assessRecoveryEvidence(evidence()).healthy).toBe(true);
  });
  it("does not confuse CI downloads or desktop reports with scheduled production cloud backups", () => {
    const input = evidence();
    input.runs[0].actor = "scheduler:desktop:ci:platform-admin-secret";
    input.runs[0].destination = "local";
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
  });
  it("detects a missing cloud archive despite a fresh success row", () => {
    const input = evidence();
    input.archives = [];
    expect(assessRecoveryEvidence(input).issues.join(" ")).toMatch(/no matching retained/);
  });
  it("detects wrong-sized archives, incomplete listings, wrong cadence, and a disabled schedule", () => {
    const input = evidence();
    input.archives[0].size = 99;
    input.listingComplete = false;
    input.enabled = false;
    input.intervalMinutes = 1440;
    expect(assessRecoveryEvidence(input).issues).toHaveLength(4);
  });
  it("detects stale cloud contents even if history was recently imported or written by CI", () => {
    const input = evidence();
    input.archives[0].createdAt = "2026-09-18T22:56:24Z";
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
    expect(assessRecoveryEvidence(input).issues.join(" ")).toMatch(/stale/);
  });
  it("keeps unknown or development archive provenance unverified, regardless of filename", () => {
    const input = evidence();
    delete input.archives[0].authenticatedManifest!.sourceEnvironment;
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
    input.archives[0].authenticatedManifest!.sourceEnvironment = "development";
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
  });
  it("does not treat old archives removed by retention as failures of a current verified run", () => {
    const input = evidence();
    input.runs.push({ ...input.runs[0], fileName: "pruned.zip.enc", completedAt: "2026-09-01T00:00:00Z" });
    expect(assessRecoveryEvidence(input).healthy).toBe(true);
  });
  it("does not bless mismatched manifest actors or future-dated archives", () => {
    const input = evidence();
    input.archives[0].authenticatedManifest!.exportedBy = "ci";
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
    input.archives[0].authenticatedManifest!.exportedBy = "scheduler:interval";
    input.archives[0].createdAt = new Date(now + 60_000).toISOString();
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
  });
  it("does not count old full, database-only, omitted-profile or identity-mismatched copies", () => {
    for (const kind of ["full", "database-only", "complete-non-production"]) {
      const input = evidence();
      input.runs[0].archiveKind = kind;
      expect(assessRecoveryEvidence(input).healthy).toBe(false);
    }
    const partial = evidence();
    partial.runs[0].partialFailure = true;
    expect(assessRecoveryEvidence(partial).healthy).toBe(false);
    const different = evidence();
    different.archives[0].itemId = "different-item";
    expect(assessRecoveryEvidence(different).healthy).toBe(false);
    const old = evidence();
    delete old.archives[0].authenticatedManifest!.coverageVersion;
    expect(assessRecoveryEvidence(old).healthy).toBe(false);
  });
  it("does not treat a warning archive as a complete production recovery point", () => {
    const input = evidence();
    input.archives[0].authenticatedManifest!.coverageStatus = "completed-with-warnings";
    input.archives[0].authenticatedManifest!.missingFileCount = 526;
    input.runs[0].partialFailure = true;
    expect(assessRecoveryEvidence(input).healthy).toBe(false);
  });
});
