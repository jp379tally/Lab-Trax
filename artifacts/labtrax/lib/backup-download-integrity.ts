/** Validate the complete-archive envelope before offering a browser download.
 * This is transport/completeness evidence, not a substitute for a restore rehearsal.
 */
export function verifyCompleteBackupDownload(buffer: ArrayBuffer, headers: Headers): void {
  const bytes = new Uint8Array(buffer);
  verifyCompleteBackupEnvelope(bytes.slice(0, 4), bytes.slice(-12), bytes.byteLength, headers);
}

export function verifyCompleteBackupEnvelope(
  prefix: Uint8Array, footer: Uint8Array, byteLength: number, headers: Headers,
): void {
  verifyCompleteBackupMetadata(headers);
  const matches = (bytes: Uint8Array, magic: number[]) =>
    magic.every((value, index) => bytes[index] === value);
  if (!Number.isSafeInteger(byteLength) || byteLength < 44 || !matches(prefix, [76, 84, 82, 50])) {
    throw new Error("The downloaded backup is truncated or has an invalid encryption header.");
  }
  const footerOffset = byteLength - 12;
  if (
    footer.byteLength !== 12 || !matches(footer, [76, 84, 70, 49]) ||
    new DataView(footer.buffer, footer.byteOffset, footer.byteLength).getBigUint64(4, false) !== BigInt(footerOffset)
  ) {
    throw new Error("The downloaded backup is incomplete or missing its integrity footer.");
  }
  const length = headers.get("content-length");
  if (length !== null &&
      (!/^\d+$/.test(length) || BigInt(length) !== BigInt(byteLength))) {
    throw new Error("The downloaded backup is incomplete: its received size does not match Content-Length.");
  }
}

export function verifyCompleteBackupMetadata(headers: Headers): void {
  const kind = headers.get("x-backup-archive-kind");
  const counts = [
    headers.get("x-backup-media-file-count"),
    headers.get("x-backup-attachment-row-count"),
  ];
  if (
    !["complete-production", "complete-non-production"].includes(kind ?? "") ||
    headers.get("x-backup-coverage-version") !== "1" ||
    counts.some((value) =>
      value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
  ) {
    throw new Error("The server did not confirm a complete backup. No complete recovery point was verified.");
  }

}
