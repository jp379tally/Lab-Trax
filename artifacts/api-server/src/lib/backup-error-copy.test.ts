import { describe, expect, it } from "vitest";
import {
  backupErrorMessage,
  backupDownloadErrorMessage,
  backupStatusErrorMessage,
  partialBackupMessage,
} from "./backup-error-copy";

describe("backup user-facing error copy", () => {
  it("explains changed content-version evidence without exposing identity values", () => {
    const message = backupErrorMessage("OneDrive content-version continuity evidence is unavailable or inconsistent. synthetic-private-id");
    expect(message).toContain("same previously byte-verified object version");
    expect(message).not.toContain("synthetic-private-id");
  });
  it("identifies unavailable strong reuse evidence without exposing appended provider details", () => {
    const message = backupErrorMessage(new Error(
      "Strong metadata-only media reuse is unavailable: provider-calculated SHA-256 absent. https://synthetic.invalid/private?token=redacted-fixture",
    ));
    expect(message).toContain("strong SHA-256");
    expect(message).toContain("previous recovery point was preserved");
    expect(message).not.toMatch(/synthetic\.invalid|token=|redacted-fixture/);
  });
  it("distinguishes incompatible baselines and unreconciled journal checkpoints", () => {
    expect(backupErrorMessage("The previous media baseline has no compatible strong metadata-only integrity proof."))
      .toContain("not compatible");
    expect(backupErrorMessage("Production media journal checkpoint is inconsistent or contains a gap."))
      .toContain("change journal could not be reconciled");
  });
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
    expect(message).toContain("HTTP 401");
  });

  it("shows the innermost safe phase and provider status, not private response contents", () => {
    const message = backupErrorMessage(
      "Backup failed during recovery capture after 2s: Backup failed during OneDrive transfer after 1s: " +
      "Upload failed HTTP 507 https://private.invalid/signed?token=not-for-display private-original.pdf user@example.invalid",
    );
    expect(message).toContain("Stage: OneDrive transfer.");
    expect(message).toContain("HTTP 507");
    expect(message).not.toContain("private.invalid");
    expect(message).not.toContain("not-for-display");
    expect(message).not.toContain("private-original.pdf");
    expect(message).not.toContain("user@example.invalid");
  });

  it("distinguishes verification, local disk and timeout failures immediately", () => {
    expect(backupErrorMessage("Backup failed during Google Drive verification after 1s: size mismatch"))
      .toMatch(/Stage: Google Drive verification.*integrity verification failed/);
    expect(backupErrorMessage("Backup failed during local file verification after 1s: ENOSPC /private/location"))
      .toMatch(/Stage: local file verification.*ENOSPC/);
    expect(backupErrorMessage("Backup failed during OneDrive transfer after 1s: timed out"))
      .toMatch(/Stage: OneDrive transfer.*timed out/);
    expect(backupErrorMessage("Production recovery capture requires a signed Desktop release identity sidecar."))
      .toMatch(/Desktop release evidence is unavailable or invalid/);
  });

  it("distinguishes unreadable originals from a destination failure without exposing file identities", () => {
    const message = backupErrorMessage(
      "Complete backup aborted: 3 required file references have no readable recovery source. Missing classes: case-media. private-original.pdf",
    );
    expect(message).toContain("3 required stored-file references");
    expect(message).toContain("recover the exact original files");
    expect(message).toContain("Existing records and files were not changed");
    expect(message).toContain("No new complete recovery point was created");
    expect(message).not.toContain("private-original.pdf");
    expect(message).not.toMatch(/reconnect.*onedrive/i);
  });

  it("keeps temporary server capacity separate from destination capacity", () => {
    const temporary = backupErrorMessage(
      "Complete backup capacity failure: 500 bytes of temporary capacity are required, but only 100 are available.",
    );
    expect(temporary).toContain("backup server");
    expect(temporary).toContain("not proof that the cloud destination is full");
    expect(temporary).toContain("No new complete recovery point was created");
    const destination = backupErrorMessage(
      "Complete backup destination capacity failure: 500 bytes are required at the destination, but only 100 are available.",
    );
    expect(destination).toContain("selected backup destination");
    expect(destination).not.toContain("server staging");
  });

  it("gives a safe next step when an existing archive cannot be downloaded", () => {
    expect(backupDownloadErrorMessage()).toMatch(/cloud destination.*Check the connection and backup history/);
  });

  it("keeps restore failures distinct and does not expose technical causes", () => {
    const message = backupErrorMessage("pg_restore failed: SQLSTATE 23505", "restore");
    expect(message).toMatch(/restore did not complete/i);
    expect(message).not.toContain("SQLSTATE");
  });

  it("preserves the explicit incomplete-recovery warning for partial backups", () => {
    expect(partialBackupMessage()).toMatch(/not a complete recovery point/);
    expect(partialBackupMessage(526)).toMatch(/526 referenced file\(s\).*not a complete recovery point/);
  });

  it("explains that a destination listing failure leaves completeness unconfirmed", () => {
    expect(backupStatusErrorMessage()).toMatch(/complete recovery point could not be confirmed/);
  });
});
