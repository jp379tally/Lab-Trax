import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CRC32C, type File, type FileMetadata, type SaveOptions } from "@google-cloud/storage";
import { mutateProductionMedia, type MediaWriter } from "./production-media-mutation";

export const MEDIA_HISTORY_DIRECTORY = ".labtrax-media-history";
const checksum = (bytes: Buffer) => createHash("md5").update(bytes).digest("base64");
const sameContent = (a: FileMetadata, b: FileMetadata) =>
  a.md5Hash ? a.md5Hash === b.md5Hash : !!a.crc32c && a.crc32c === b.crc32c;
const missing = (e: unknown) => (e as { code?: number })?.code === 404;

async function metadata(file: File): Promise<FileMetadata | null> {
  try { return (await file.getMetadata())[0]; }
  catch (e) { if (missing(e)) return null; throw e; }
}
export function mediaHistoryFile(file: File, generation: string): File {
  if (!/^\d+$/.test(generation)) throw new Error("Invalid immutable source generation.");
  // All callers address an existing private object prefix. Keep the copy beside
  // that object, never in another bucket/account or outside its namespace.
  const directory = file.name.slice(0, file.name.lastIndexOf("/") + 1);
  const identity = createHash("sha256").update(file.name).digest("hex");
  return file.bucket.file(`${directory}${MEDIA_HISTORY_DIRECTORY}/${identity}/${generation}`);
}
async function preserve(file: File, previous: FileMetadata): Promise<void> {
  if (!previous.generation || (!previous.md5Hash && !previous.crc32c)) {
    throw new Error("Cannot preserve an original without generation and content evidence.");
  }
  const generation = String(previous.generation);
  const history = mediaHistoryFile(file, generation);
  try {
    await file.bucket.file(file.name, { generation }).copy(history, {
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (e) {
    if ((e as { code?: number })?.code !== 412) throw e;
  }
  const saved = await metadata(history);
  if (!saved?.generation || !sameContent(previous, saved) ||
      Number(saved.size) !== Number(previous.size)) {
    throw new Error("Immutable previous-source copy did not verify.");
  }
}

/** Same-key replacement retains an independent copy before changing the key. */
export async function writeProductionObject(
  file: File, objectKey: string, writer: MediaWriter, data: Buffer, options: SaveOptions,
): Promise<void> {
  await mutateProductionMedia(objectKey, writer, "replace", async () => {
    const old = await metadata(file);
    if (old) await preserve(file, old);
    await file.save(data, {
      ...options, validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: old?.generation ?? 0 },
    });
    const final = await metadata(file);
    const crc = new CRC32C(); crc.update(data);
    if (!final?.generation || Number(final.size) !== data.length ||
        (final.md5Hash ? final.md5Hash !== checksum(data) : final.crc32c !== crc.toString())) {
      throw new Error("Production source upload did not finalize with matching bytes and generation.");
    }
    return { value: undefined, generation: String(final.generation), bytes: data.length };
  });
}

export async function deleteProductionObject(file: File, objectKey: string, writer: MediaWriter): Promise<void> {
  await mutateProductionMedia(objectKey, writer, "remove", async () => {
    const old = await metadata(file);
    if (old) {
      await preserve(file, old);
      await file.delete({ ifGenerationMatch: old.generation });
    }
    return { value: undefined, generation: old ? String(old.generation) : "absent", bytes: 0 };
  });
}

export async function writeProductionObjectStream(
  file: File, objectKey: string, writer: MediaWriter, input: Readable, options: SaveOptions,
): Promise<void> {
  await mutateProductionMedia(objectKey, writer, "replace", async () => {
    const old = await metadata(file);
    if (old) await preserve(file, old);
    let bytes = 0;
    const hash = createHash("md5");
    const crc = new CRC32C();
    await pipeline(input, new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length; hash.update(chunk); crc.update(chunk); done(null, chunk);
      },
    }), file.createWriteStream({
      ...options, validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: old?.generation ?? 0 },
    }));
    const final = await metadata(file);
    if (!final?.generation || Number(final.size) !== bytes ||
        (final.md5Hash ? final.md5Hash !== hash.digest("base64") : final.crc32c !== crc.toString())) {
      throw new Error("Production source stream did not finalize with matching bytes and generation.");
    }
    return { value: undefined, generation: String(final.generation), bytes };
  });
}

/**
 * A checkpoint pins a generation while holding the mutation boundary. If a
 * later same-key write retires that generation, use its independently retained
 * copy. Never restart a partially emitted stream (which would duplicate bytes).
 */
export function openPinnedProductionObject(file: File, generation: string, expected: FileMetadata): Readable {
  let active: Readable | undefined;
  let cancelled = false;
  const stream = Readable.from((async function* () {
    let emitted = false;
    try {
      active = file.bucket.file(file.name, { generation }).createReadStream({ validation: "crc32c" });
      for await (const bytes of active) {
        emitted = true; yield bytes;
      }
      return;
    } catch (e) {
      if (cancelled || emitted || !missing(e)) throw e;
    } finally {
      active = undefined;
    }
    const history = mediaHistoryFile(file, generation);
    const saved = await metadata(history);
    if (cancelled) return;
    if (!saved?.generation || !sameContent(expected, saved) ||
        Number(saved.size) !== Number(expected.size)) {
      throw new Error("Pinned source generation and its verified retained version are unavailable.");
    }
    active = history.createReadStream({ validation: "crc32c" });
    try {
      for await (const bytes of active) yield bytes;
    } finally {
      active = undefined;
    }
  })());
  // Readable.from waits for a pending iterator read before closing it. Wake
  // that read by cancelling the real provider stream first; otherwise a
  // stalled download can keep pipeline cancellation pending indefinitely.
  const destroy = stream.destroy.bind(stream);
  stream.destroy = (error?: Error) => {
    cancelled = true;
    active?.destroy(error);
    return destroy(error);
  };
  return stream;
}
