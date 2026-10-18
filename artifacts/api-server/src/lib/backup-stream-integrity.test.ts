import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBuffer } from "./backup.js";

const FOOTER_BYTES = 12;

function encryptStreamed(plaintext: Buffer, withFooter = true): Buffer {
  const secret = process.env["BACKUP_ENCRYPTION_KEY"] || process.env["JWT_SECRET"];
  if (!secret) throw new Error("Backup encryption test needs a configured test secret.");
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const archive = Buffer.concat([
    Buffer.from("LTR2"),
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ]);
  if (!withFooter) return archive;
  const footer = Buffer.alloc(FOOTER_BYTES);
  footer.write("LTF1", 0, "ascii");
  footer.writeBigUInt64BE(BigInt(archive.length), 4);
  return Buffer.concat([archive, footer]);
}

describe("streamed backup integrity footer", () => {
  it("decrypts a complete streamed archive with a byte-count footer", () => {
    const plaintext = Buffer.from("valid backup payload");
    expect(decryptBuffer(encryptStreamed(plaintext))).toEqual(plaintext);
  });

  it("continues to decrypt historical footerless LTR2 archives", () => {
    const plaintext = Buffer.from("older backup payload");
    expect(decryptBuffer(encryptStreamed(plaintext, false))).toEqual(plaintext);
  });

  it("rejects a footer whose declared count is not the received archive size", () => {
    const complete = encryptStreamed(Buffer.from("valid backup payload"));
    const corrupted = Buffer.from(complete);
    corrupted.writeBigUInt64BE(BigInt(complete.length - FOOTER_BYTES - 1), complete.length - 8);
    expect(() => decryptBuffer(corrupted)).toThrow("footer is invalid or incomplete");
  });
});
