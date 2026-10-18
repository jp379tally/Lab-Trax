import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { getBackupStagingLocation, MEDIA_TRANSFER_IDLE_MS } from "./case-media-object-storage";
import { logger } from "./logger";
import { abortableBackupOperation } from "./backup-phase";

const GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKUP_RANGE_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

/**
 * A lease is committed before the archive write. It survives process death and
 * is discoverable without any patient-data or backup-history schema changes.
 * Only our source/environment namespace is ever considered for deletion.
 */
export async function createBackupCloudStage(
  environment: "production" | "non-production",
  timeoutMs: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(Date.now() + timeoutMs + GRACE_MS)) {
    throw new Error("Cloud backup staging requires a finite job deadline.");
  }
  const { bucket, prefix } = getBackupStagingLocation(environment);
  const [leases] = await abortableBackupOperation(bucket.getFiles({
    prefix: `${prefix}/leases/`, autoPaginate: false, maxResults: 100,
  }), signal);
  for (const lease of leases) {
    signal.throwIfAborted();
    if (!lease.name.startsWith(`${prefix}/leases/`)) continue;
    const id = lease.name.slice(`${prefix}/leases/`.length);
    const expiry = Number(lease.metadata.metadata?.expiresAt);
    const generation = lease.metadata.generation;
    if (!UUID.test(id) || !Number.isSafeInteger(expiry) || expiry <= 0 ||
        expiry >= Date.now() || !generation) continue;
    try {
      await abortableBackupOperation(bucket.file(`${prefix}/archives/${id.slice(0, -5)}.zip.enc`).delete({ ignoreNotFound: true }), signal);
      await abortableBackupOperation(lease.delete({ ignoreNotFound: true, ifGenerationMatch: generation }), signal);
    } catch {
      // Keep the durable lease for a subsequent retry, without logging keys.
      logger.warn("[backup] Expired cloud staging cleanup will be retried");
    }
  }
  signal.throwIfAborted();
  const id = randomUUID();
  const lease = bucket.file(`${prefix}/leases/${id}.json`);
  const file = bucket.file(`${prefix}/archives/${id}.zip.enc`);
  await abortableBackupOperation(lease.save(JSON.stringify({ purpose: "temporary encrypted backup" }), {
    resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: "application/json",
      metadata: { expiresAt: String(Date.now() + timeoutMs + GRACE_MS) },
    },
  }), signal);
  let writer: ReturnType<typeof file.createWriteStream> | undefined;
  let pinned: ReturnType<typeof bucket.file> | undefined;
  let size = 0;
  let sealed = false;
  return {
    open() {
      signal.throwIfAborted();
      if (writer) throw new Error("Cloud backup stage cannot be overwritten.");
      writer = file.createWriteStream({
        resumable: true, chunkSize: 8 * 1024 * 1024, validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
      });
      return writer;
    },
    async seal(expectedSize: number) {
      signal.throwIfAborted();
      if (!writer?.writableFinished) throw new Error("Cloud backup archive did not finish writing.");
      const [metadata] = await abortableBackupOperation(file.getMetadata(), signal);
      if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
          Number(metadata.size) !== expectedSize || !metadata.generation) {
        throw new Error("Cloud backup archive size or generation could not be verified.");
      }
      size = expectedSize;
      pinned = bucket.file(file.name, { generation: metadata.generation });
      sealed = true;
    },
    async readChunk(offset: number, length: number): Promise<Buffer> {
      signal.throwIfAborted();
      if (!sealed || !pinned) throw new Error("Cloud backup archive has not been sealed.");
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
          length <= 0 || length > MAX_BACKUP_RANGE_BYTES || offset + length > size) {
        throw new Error("Invalid cloud backup range.");
      }
      // GCS does not support whole-object CRC validation on a range. The write
      // was CRC-validated, reads are generation-pinned and the archive has GCM.
      const stream = pinned.createReadStream({ start: offset, end: offset + length - 1, validation: false });
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stream.destroy(new Error("Cloud backup range read stalled.")), MEDIA_TRANSFER_IDLE_MS);
        timer.unref?.();
      };
      const abort = () => stream.destroy(new Error("Cloud backup range read aborted."));
      signal.addEventListener("abort", abort, { once: true });
      arm();
      try {
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const data of stream) {
          arm();
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          received += chunk.length;
          if (received > length) throw new Error("Cloud backup range exceeded its bounded size.");
          chunks.push(chunk);
        }
        if (received !== length) throw new Error("Cloud backup range was truncated.");
        return Buffer.concat(chunks, received);
      } finally {
        clearTimeout(timer!);
        signal.removeEventListener("abort", abort);
        stream.destroy();
      }
    },
    async cleanup() {
      // Do not let a failed cleanup overwrite a confirmed upload or its error.
      try {
        const cleanupSignal = AbortSignal.timeout(10_000);
        if (writer && !writer.writableFinished) {
          writer.destroy();
          await finished(writer, { cleanup: true, signal: cleanupSignal }).catch(() => undefined);
        }
        cleanupSignal.throwIfAborted();
        await abortableBackupOperation(file.delete({ ignoreNotFound: true }), cleanupSignal);
        // An interrupted resumable write could finish late. Retain its lease
        // for a second cleanup after the hard deadline and grace period.
        if (sealed) await abortableBackupOperation(lease.delete({ ignoreNotFound: true }), cleanupSignal);
      } catch {
        logger.warn("[backup] Cloud staging cleanup will be retried from its durable lease");
      }
    },
  };
}
