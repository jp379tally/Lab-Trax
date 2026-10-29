import { promises as fs, createReadStream, constants, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mutateProductionMedia, type MediaWriter } from "./production-media-mutation";
import { MEDIA_HISTORY_DIRECTORY } from "./production-media-object-write";

export const localMediaIdentity = (s: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const historyPath = (file: string, identity: string) =>
  join(dirname(file), MEDIA_HISTORY_DIRECTORY, digest(resolve(file)), digest(identity));
async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function optionalStat(file: string) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Durable media must be a regular, non-symlink file.");
    return stat;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function preserveLocal(file: string, stat: Stats) {
  const identity = localMediaIdentity(stat);
  const destination = historyPath(file, identity);
  await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const expectedHash = await hashFile(file);
  // An interrupted copy must never occupy the canonical receipt/body name and
  // permanently poison retries. Uncommitted candidates remain excluded scratch.
  const candidate = `${destination}.candidate-${randomUUID()}`;
  await fs.copyFile(file, candidate, constants.COPYFILE_EXCL);
  const current = await optionalStat(file);
  if (!current || localMediaIdentity(current) !== identity || await hashFile(candidate) !== expectedHash) {
    throw new Error("Original local media changed during immutable version preservation.");
  }
  const body = await fs.open(candidate, "r");
  try { await body.sync(); } finally { await body.close(); }
  const proof = JSON.stringify({ identity, bytes: stat.size, sha256: expectedHash, objectName: basename(candidate) });
  const receiptCandidate = `${destination}.receipt-${randomUUID()}`;
  const receipt = await fs.open(receiptCandidate, "wx", 0o600);
  try { await receipt.writeFile(proof); await receipt.sync(); }
  finally { await receipt.close(); }
  try {
    await fs.link(receiptCandidate, `${destination}.json`);
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const existing = JSON.parse(await fs.readFile(`${destination}.json`, "utf8"));
    const path = retainedBody(destination, existing.objectName);
    if (existing.identity !== identity || existing.sha256 !== expectedHash ||
        existing.bytes !== stat.size || await hashFile(path) !== expectedHash) {
      throw new Error("An existing retained source proof is inconsistent; original was not replaced.");
    }
  }
}
function retainedBody(destination: string, objectName?: string): string {
  if (objectName === undefined) return destination;
  if (!/^[a-f0-9]{64}\.candidate-[a-f0-9-]{36}$/.test(objectName)) throw new Error("Unsafe retained source object.");
  return join(dirname(destination), objectName);
}
async function replaceFinal(temporary: string, file: string, old: Stats | null) {
  const current = await optionalStat(file);
  if (old ? !current || localMediaIdentity(current) !== localMediaIdentity(old) : !!current) {
    throw new Error("An untracked source replacement occurred during finalization; newer original was preserved.");
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Atomic replacement; a failed new write cannot truncate an existing original. */
export async function writeProductionLocalMedia(
  file: string, data: Buffer | string, objectKey: string, writer: MediaWriter,
): Promise<void> {
  await mutateProductionMedia(objectKey, writer, "replace", async () => {
    await fs.mkdir(dirname(file), { recursive: true });
    if (await fs.realpath(dirname(file)) !== resolve(dirname(file))) {
      throw new Error("Production local media parent must not be a symlink.");
    }
    const old = await optionalStat(file);
    if (old) await preserveLocal(file, old);
    const temporary = join(dirname(file), `.labtrax-media-write-${randomUUID()}`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await replaceFinal(temporary, file, old);
    const final = (await optionalStat(file))!;
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    if (final.size !== bytes) throw new Error("Local media finalization size mismatch.");
    return { value: undefined, generation: localMediaIdentity(final), bytes };
  });
}

/** Open inode, not a mutable pathname. Retained copies cover later replacements. */
export async function assertPinnedLocalMediaAvailable(file: string, identity: string): Promise<void> {
  const current = await optionalStat(file);
  if (current && localMediaIdentity(current) === identity) return;
  try {
    const retained = historyPath(file, identity);
    const proof = JSON.parse(await fs.readFile(`${retained}.json`, "utf8"));
    const stat = await optionalStat(retainedBody(retained, proof.objectName));
    if (proof.identity !== identity || !/^[a-f0-9]{64}$/.test(proof.sha256) ||
        !stat || stat.size !== proof.bytes) throw new Error("Invalid retained version.");
  } catch {
    throw new Error("A local recovery source changed after inventory and has no valid retained version.");
  }
}

export function openPinnedLocalMedia(file: string, identity: string): Readable {
  return Readable.from((async function* () {
    let selected = file, proof: { identity: string; bytes: number; sha256: string; objectName?: string } | undefined;
    const current = await optionalStat(file);
    if (!current || localMediaIdentity(current) !== identity) {
      selected = historyPath(file, identity);
      proof = JSON.parse(await fs.readFile(`${selected}.json`, "utf8"));
      if (!proof || proof.identity !== identity || !/^[a-f0-9]{64}$/.test(proof.sha256)) {
        throw new Error("Pinned local source version has no valid retained proof.");
      }
      selected = retainedBody(selected, proof.objectName);
    }
    const handle = await fs.open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat().catch(async error => { await handle.close(); throw error; });
    const expectedIdentity = proof ? localMediaIdentity(before) : identity;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      if (localMediaIdentity(before) !== expectedIdentity) throw new Error("Pinned local source changed before opening.");
      const buffer = Buffer.alloc(256 * 1024);
      for (;;) {
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
        bytes += chunk.length; hash.update(chunk); yield chunk;
      }
      if (localMediaIdentity(await handle.stat()) !== expectedIdentity ||
          (proof && (bytes !== proof.bytes || hash.digest("hex") !== proof.sha256))) {
        throw new Error("Pinned local source changed or retained content failed byte verification.");
      }
    } finally { await handle.close(); }
  })());
}

/** Only known durable upload namespaces; never application source/scratch. */
function uploadKey(file: string): string {
  const parts = resolve(file).split("/");
  const namespaces = ["case-media", "profile-photos", "invoice-attachments", "messenger-media", "support-reports",
    "lab-logos", "invoice-template-images", "case-print-template-images", "legacy-case-data-backups"];
  let index = parts.length - 1;
  while (index >= 0 && !namespaces.includes(parts[index]!)) index--;
  if (index >= 0 && index < parts.length - 1) {
    const relative = parts.slice(index).join("/");
    return parts[index] === "case-media" ? relative : `local-uploads/${relative}`;
  }
  if (parts.at(-1) === "legacy-chat.json" && parts.at(-2) === ".data") return "local-state/legacy-chat.json";
  throw new Error("Unregistered durable local upload namespace.");
}
export async function writeProductionUpload(file: string, data: Buffer | string, writer: MediaWriter) {
  return writeProductionLocalMedia(file, data, uploadKey(file), writer);
}
export async function copyProductionUpload(source: string, destination: string, writer: MediaWriter, canonicalKey = uploadKey(destination)) {
  return mutateProductionMedia(canonicalKey, writer, "replace", async () => {
    await fs.mkdir(dirname(destination), { recursive: true });
    if (await fs.realpath(dirname(destination)) !== resolve(dirname(destination))) throw new Error("Unsafe media copy parent.");
    const old = await optionalStat(destination);
    if (old) await preserveLocal(destination, old);
    const temporary = join(dirname(destination), `.labtrax-media-write-${randomUUID()}`);
    const handle = await fs.open(temporary, "wx", 0o600);
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      const sourceStat = await optionalStat(source);
      if (!sourceStat) throw new Error("Local upload copy source is unavailable.");
      for await (const chunk of openPinnedLocalMedia(source, localMediaIdentity(sourceStat))) {
        hash.update(chunk); bytes += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const written = (await handle.write(chunk, offset)).bytesWritten;
          if (!written) throw new Error("Local media copy stopped making write progress.");
          offset += written;
        }
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (await hashFile(temporary) !== hash.digest("hex")) throw new Error("Local media copy failed content verification.");
    await replaceFinal(temporary, destination, old);
    const final = (await optionalStat(destination))!;
    return { value: undefined, generation: localMediaIdentity(final), bytes };
  });
}

export async function deleteProductionUpload(file: string, writer: MediaWriter): Promise<void> {
  await mutateProductionMedia(uploadKey(file), writer, "remove", async () => {
    const old = await optionalStat(file);
    if (old) { await preserveLocal(file, old); await fs.unlink(file); }
    return { value: undefined, generation: old ? localMediaIdentity(old) : "absent", bytes: 0 };
  });
}
export async function moveProductionUpload(source: string, destination: string, writer: MediaWriter): Promise<void> {
  await copyProductionUpload(source, destination, writer);
  await deleteProductionUpload(source, writer);
}
