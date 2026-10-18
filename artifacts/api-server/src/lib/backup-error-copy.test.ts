import { describe, expect, it } from "vitest";
import {
  backupErrorMessage,
  backupDownloadErrorMessage,
  backupStatusErrorMessage,
  partialBackupMessage,
} from "./backup-error-copy";

describe("backup user-facing error copy", () => {
  it("says a skipped overlap did not create a new complete recovery point", () => {
    expect(backupErrorMessage(
      "Missed complete recovery point: the previous scheduled backup is still running.",
    )).toMatch(/skipped.*No new complete recovery point was created/);
  });

  it("gives a useful next step when the server cannot reach a local folder", () => {
    expect(backupErrorMessage("The configured destination is unreachable from the server."))
      .toMatch(/Use LabTrax Desktop/);
  });

  it("suggests reconnecting OneDrive without exposing provider response details", () => {
    const message = backupErrorMessage("Microsoft rejected the OneDrive credentials (HTTP 401).");
    expect(message).toMatch(/Reconnect the OneDrive account/);
    expect(message).not.toContain("HTTP 401");
  });

  it("gives a safe next step when an existing archive cannot be downloaded", () => {
    expect(backupDownloadErrorMessage()).toMatch(/Check the OneDrive connection and backup history/);
  });

  it("keeps restore failures distinct and does not expose technical causes", () => {
    const message = backupErrorMessage("pg_restore failed: SQLSTATE 23505", "restore");
    expect(message).toMatch(/restore did not complete/i);
    expect(message).not.toContain("SQLSTATE");
  });

  it("preserves the explicit incomplete-recovery warning for partial backups", () => {
    expect(partialBackupMessage()).toMatch(/not a complete recovery point/);
  });

  it("explains that a destination listing failure leaves completeness unconfirmed", () => {
    expect(backupStatusErrorMessage()).toMatch(/complete recovery point could not be confirmed/);
  });
});
