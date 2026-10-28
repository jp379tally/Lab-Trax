import { describe, expect, it, vi } from "vitest";
import { executeLocalBackup, verifyRequestedBackupHeaders, verifyCompleteBackupHeaders } from "../local-backup-execution";

function databaseHeaders() {
  return new Headers({
    "x-backup-archive-kind": "database-only", "x-backup-coverage-version": "0",
    "x-backup-media-file-count": "0", "x-backup-attachment-row-count": "1",
    "x-backup-filename": "synthetic.zip.enc", "x-backup-run-id": "synthetic-download",
  });
}
describe("explicit backup archive kind", () => {
  it.each(["1", "2"])("accepts supported coverage version %s while rejecting unknown versions and false complete claims", coverageVersion => {
    const headers = new Headers({
      "x-backup-archive-kind": "complete-production", "x-backup-coverage-version": coverageVersion,
      "x-backup-media-file-count": "0", "x-backup-attachment-row-count": "0",
    });
    expect(() => verifyCompleteBackupHeaders(headers)).not.toThrow();
    headers.set("x-backup-archive-kind", "partial-production");
    headers.set("x-backup-missing-file-count", "1");
    expect(() => verifyRequestedBackupHeaders(headers, "full")).not.toThrow();
    expect(() => verifyCompleteBackupHeaders(headers)).toThrow();
    headers.set("x-backup-coverage-version", "99");
    expect(() => verifyRequestedBackupHeaders(headers, "full")).toThrow();
  });
  it("accepts explicit partial evidence for readable-files backup but never as complete recovery", () => {
    const headers = new Headers({
      "x-backup-archive-kind": "partial-production", "x-backup-coverage-version": "1",
      "x-backup-media-file-count": "2", "x-backup-attachment-row-count": "3", "x-backup-missing-file-count": "1",
    });
    expect(() => verifyRequestedBackupHeaders(headers, "full")).not.toThrow();
    expect(() => verifyCompleteBackupHeaders(headers)).toThrow();
    headers.delete("x-backup-missing-file-count");
    expect(() => verifyRequestedBackupHeaders(headers, "full")).toThrow(/missing-file/);
  });
  it("never accepts a database-only archive for a complete request", () => {
    expect(() => verifyRequestedBackupHeaders(databaseHeaders(), "full")).toThrow(/complete/);
  });
  it("accepts the explicit database-only proof, without pretending it proves complete recovery", () => {
    expect(() => verifyRequestedBackupHeaders(databaseHeaders(), "database-only")).not.toThrow();
  });
  it.each(["x-backup-archive-kind", "x-backup-coverage-version", "x-backup-media-file-count"])(
    "rejects missing database-only evidence %s", (key) => {
      const headers = databaseHeaders(); headers.delete(key);
      expect(() => verifyRequestedBackupHeaders(headers, "database-only")).toThrow(/did not confirm/);
    },
  );
  it("streams an explicit database-only archive through the Desktop-owned local bridge", async () => {
    const runId = "d9ed5635-29de-4dc6-9b74-295f2ed30bc9";
    const apiFetchArrayBuffer = vi.fn();
    const native = vi.fn(async () => ({
      fileName: "synthetic.zip.enc",
      path: "/synthetic-usb/synthetic.zip.enc",
      sizeBytes: 64,
      downloadRunId: runId,
      archiveKind: "database-only",
    }));
    const save = vi.fn(async () => ({ ok: true, path: "/synthetic-usb/synthetic.zip.enc" }));
    const report = vi.fn(async () => ({ ok: true }));
    await executeLocalBackup({
      apiFetchArrayBuffer, apiFetch: report as any, downloadBackupToFolder: native,
      saveBackupToFolder: save, sourceHeaders: { "X-LabTrax-Backup-Source": "development" },
      runId,
    }, "/synthetic-usb", "manual", "database-only");
    expect(native).toHaveBeenCalledWith(
      "/synthetic-usb", "manual", { "X-LabTrax-Backup-Source": "development" }, runId, "database-only",
    );
    expect(apiFetchArrayBuffer).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("/admin/backup/desktop-run-report",
      expect.objectContaining({ method: "POST", body: expect.stringContaining(runId) }));
  });
});
