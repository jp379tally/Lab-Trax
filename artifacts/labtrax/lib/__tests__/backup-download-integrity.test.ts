import { describe, expect, it } from "vitest";
import { verifyCompleteBackupDownload } from "../backup-download-integrity";

function fixture() {
  const bytes = new Uint8Array(44);
  bytes.set([76, 84, 82, 50]);
  bytes.set([76, 84, 70, 49], 32);
  new DataView(bytes.buffer).setBigUint64(36, 32n, false);
  const headers = new Headers({
    "x-backup-archive-kind": "complete-non-production",
    "x-backup-coverage-version": "1",
    "x-backup-media-file-count": "2",
    "x-backup-attachment-row-count": "1",
    "content-length": "44",
  });
  return { bytes, headers };
}

describe("complete browser backup download validation", () => {
  it("accepts a complete synthetic envelope without claiming decryption or restore proof", () => {
    const { bytes, headers } = fixture();
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).not.toThrow();
    headers.set("x-backup-archive-kind", "complete-production");
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).not.toThrow();
  });

  it.each([
    ["x-backup-archive-kind", "db-only"],
    ["x-backup-archive-kind", "full"],
    ["x-backup-coverage-version", "0"],
    ["x-backup-media-file-count", "-1"],
    ["x-backup-attachment-row-count", "invalid"],
    ["x-backup-media-file-count", "9007199254740992"],
  ])("refuses unconfirmed coverage: %s=%s", (key, value) => {
    const { bytes, headers } = fixture();
    headers.set(key, value);
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).toThrow(/did not confirm/);
  });

  it("does not interpret missing coverage counts as zero", () => {
    const { bytes, headers } = fixture();
    headers.delete("x-backup-media-file-count");
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).toThrow(/did not confirm/);
  });

  it("rejects invalid encryption headers and truncated responses", () => {
    const { bytes, headers } = fixture();
    bytes[0] = 0;
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).toThrow(/encryption header/);
    expect(() => verifyCompleteBackupDownload(bytes.buffer.slice(0, 30), headers)).toThrow(/truncated/);
  });

  it("rejects a missing footer or a footer with the wrong declared size", () => {
    const { bytes, headers } = fixture();
    new DataView(bytes.buffer).setBigUint64(36, 31n, false);
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).toThrow(/integrity footer/);
    bytes[32] = 0;
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).toThrow(/integrity footer/);
  });

  it.each(["43", "45", "invalid"])("rejects a mismatched response length: %s", (length) => {
    const { bytes, headers } = fixture();
    headers.set("content-length", length);
    expect(() => verifyCompleteBackupDownload(bytes.buffer, headers)).toThrow(/Content-Length/);
  });
});
