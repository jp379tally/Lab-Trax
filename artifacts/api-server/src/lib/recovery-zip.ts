import fs from "node:fs";
import path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Open } from "unzipper";

export interface RecoveryEntry {
  entryName: string;
  isDirectory: boolean;
  header: { size: number };
  sha256?: string;
  getData(): Buffer;
  stream?: () => Readable;
}
export interface RecoveryZip {
  encryptedSize?: number;
  getEntry(name: string): RecoveryEntry | null;
  getEntries(): RecoveryEntry[];
}
export async function writeRecoveryEntry(entry: RecoveryEntry, destination: string): Promise<void> {
  if (entry.stream) await pipeline(entry.stream(), fs.createWriteStream(destination));
  else await fs.promises.writeFile(destination, entry.getData());
}

function requireDisk(bytes: number, directory: string): void {
  const disk = fs.statfsSync(directory);
  if (!Number.isSafeInteger(bytes) || bytes > disk.bavail * disk.bsize) {
    throw new Error(`Isolated recovery needs ${bytes} bytes of free temporary storage. Provide capacity; no database was changed.`);
  }
}

/**
 * Authenticated decryption and ZIP64 staging without ever buffering the whole
 * archive or a media object. Files are quarantined under numeric names, not
 * attacker-selected ZIP paths, and are not used until GCM authentication and
 * streaming byte hashes have completed.
 */
export async function prepareRecoveryZipFile(
  encryptedPath: string, key: Buffer, stagingRoot: string,
): Promise<RecoveryZip> {
  const size = fs.statSync(encryptedPath).size;
  if (size <= 32) throw new Error("File is too short to be a valid LabTrax backup.");
  requireDisk(size + 512 * 1024 * 1024, stagingRoot);
  const handle = await fs.promises.open(encryptedPath, "r");
  const header = Buffer.alloc(32);
  let tag: Buffer;
  let start: number;
  let end: number;
  try {
    await handle.read(header, 0, 32, 0);
    const magic = header.subarray(0, 4).toString("ascii");
    if (magic === "LTRX") {
      tag = header.subarray(16, 32); start = 32; end = size - 1;
    } else if (magic === "LTR2") {
      tag = Buffer.alloc(16);
      const footer = Buffer.alloc(12);
      const footerRead = await handle.read(footer, 0, footer.length, size - footer.length);
      const footerOffset = size - footer.length;
      if (footerRead.bytesRead === footer.length && footer.subarray(0, 4).toString("ascii") === "LTF1") {
        if (footer.readBigUInt64BE(4) !== BigInt(footerOffset) || footerOffset < 32) {
          throw new Error("The streamed backup completion footer is invalid or incomplete.");
        }
        const tagOffset = footerOffset - 16;
        const tagRead = await handle.read(tag, 0, tag.length, tagOffset);
        if (tagRead.bytesRead !== tag.length) {
          throw new Error("The streamed backup completion footer is invalid or incomplete.");
        }
        start = 16;
        end = tagOffset - 1;
      } else {
        // Historical LTR2 archives have a tag at EOF and no completion footer.
        const tagRead = await handle.read(tag, 0, 16, size - 16);
        if (tagRead.bytesRead !== 16) throw new Error("File is too short to be a valid LabTrax backup.");
        start = 16; end = size - 17;
      }
    } else throw new Error("Invalid LabTrax encrypted backup format.");
  } finally { await handle.close(); }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(4, 16));
  decipher.setAuthTag(tag);
  const zipPath = path.join(stagingRoot, "authenticated.zip");
  try {
    await pipeline(fs.createReadStream(encryptedPath, { start, end }), decipher,
      fs.createWriteStream(zipPath, { mode: 0o600 }));
  } catch {
    throw new Error("Backup decryption failed — the file is corrupt or the encryption key does not match.");
  }
  const directory = await Open.file(zipPath);
  // Room for staged bytes plus their restored local copy and application
  // headroom. Cloud writes stream; neither the archive nor files enter RAM.
  const expanded = directory.files.reduce((sum, file) => sum + file.uncompressedSize, 0);
  requireDisk(Math.ceil(expanded * 2.03) + 512 * 1024 * 1024, stagingRoot);
  const entries: RecoveryEntry[] = [];
  const names = new Set<string>();
  for (const file of directory.files) {
    const name = file.path;
    const parts = name.replace(/\/$/, "").split("/");
    if (!name || name.includes("\\") || name.startsWith("/") ||
        parts.some(part => !part || part === "." || part === "..") || names.has(name)) {
      throw new Error("Unsafe or duplicate ZIP recovery entry.");
    }
    names.add(name);
    const isDirectory = file.type === "Directory";
    if (isDirectory) {
      entries.push({ entryName: name, isDirectory, header: { size: 0 }, getData: () => Buffer.alloc(0) });
      continue;
    }
    const staged = path.join(stagingRoot, String(entries.length));
    const hash = createHash("sha256");
    let bytes = 0;
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > file.uncompressedSize) return callback(new Error("Recovery entry exceeds its declared size."));
        hash.update(chunk); callback(null, chunk);
      },
    });
    await pipeline(file.stream(), hashing, fs.createWriteStream(staged, { mode: 0o600 }));
    if (bytes !== file.uncompressedSize) throw new Error("Recovery entry was truncated.");
    entries.push({
      entryName: name, isDirectory, header: { size: bytes }, sha256: hash.digest("hex"),
      stream: () => fs.createReadStream(staged),
      getData: () => {
        if (bytes > 64 * 1024 * 1024) throw new Error("Recovery metadata exceeds the bounded memory limit.");
        return fs.readFileSync(staged);
      },
    });
  }
  await fs.promises.unlink(zipPath);
  const byName = new Map(entries.map(entry => [entry.entryName, entry]));
  return { encryptedSize: size, getEntry: name => byName.get(name) ?? null, getEntries: () => entries };
}
