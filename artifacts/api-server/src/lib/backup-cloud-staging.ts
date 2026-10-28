import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { getBackupStagingLocation, MEDIA_TRANSFER_IDLE_MS } from "./case-media-object-storage";
import { logger } from "./logger";
import { abortableBackupOperation } from "./backup-phase";
import { isBackupRunActive } from "./backup-live-status-store";

const GRACE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_BACKUP_RANGE_BYTES = 5 * 1024 * 1024;

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    ("code" in error && ((error as { code?: unknown }).code === 404 ||
      (error as { code?: unknown }).code === "404") ||
     "statusCode" in error && (error as { statusCode?: unknown }).statusCode === 404));
}

/**
 * Remove expired objects in exactly one environment namespace. Leases are
 * retained whenever activity cannot be ruled out or any storage operation
 * fails, so the next sweep can retry without touching an active upload.
 */
export async function cleanupExpiredBackupCloudStages(
  environment: "production" | "non-production",
  now = Date.now(),
): Promise<void> {
  const { bucket, prefix } = getBackupStagingLocation(environment);
  const [leases] = await bucket.getFiles({
    prefix: `${prefix}/leases/`, autoPaginate: true,
  });
  for (const lease of leases) {
    if (!lease.name.startsWith(`${prefix}/leases/`)) continue;
    const id = lease.name.slice(`${prefix}/leases/`.length).replace(/\.json$/, "");
    const expiry = Number(lease.metadata.metadata?.expiresAt);
    const leaseGeneration = lease.metadata.generation;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
        !Number.isSafeInteger(expiry) || expiry <= 0 || expiry >= now ||
        (typeof leaseGeneration !== "string" && typeof leaseGeneration !== "number")) continue;

    try {
      if (await isBackupRunActive(id)) continue;

      const archive = bucket.file(`${prefix}/archives/${id}.zip.enc`);
      const recordedGeneration = lease.metadata.metadata?.archiveGeneration;
      let archiveGeneration: string | number | undefined =
        typeof recordedGeneration === "string" && /^\d+$/.test(recordedGeneration)
          ? recordedGeneration
          : undefined;
      if (archiveGeneration === undefined) {
        try {
          const [metadata] = await archive.getMetadata();
          if (typeof metadata.generation === "string" || typeof metadata.generation === "number") {
            archiveGeneration = metadata.generation;
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      if (archiveGeneration) {
        await abortableBackupOperation(archive.delete({
          ignoreNotFound: true,
          ifGenerationMatch: archiveGeneration,
        }), AbortSignal.timeout(10_000));
      }
      await abortableBackupOperation(lease.delete({
        ignoreNotFound: true,
        ifGenerationMatch: leaseGeneration,
      }), AbortSignal.timeout(10_000));
    } catch {
      // Keep the durable lease for a subsequent retry, without logging keys.
      logger.warn("[backup] Expired cloud staging cleanup will be retried");
    }
  }
}

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

/** Run at startup and periodically, even when no new backup is created. */
export function startBackupCloudStageCleanup(): void {
  if (cleanupTimer) return;
  const sweep = () => {
    for (const environment of ["production", "non-production"] as const) {
      void cleanupExpiredBackupCloudStages(environment).catch(() => {
        logger.warn("[backup] Expired cloud staging cleanup will be retried");
      });
    }
  };
  sweep();
  cleanupTimer = setInterval(sweep, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

/**
 * A lease is committed before the archive write. It survives process death and
 * is discoverable without any patient-data or backup-history schema changes.
 * Only our source/environment namespace is ever considered for deletion.
 */
export async function createBackupCloudStage(
  environment: "production" | "non-production",
  timeoutMs: number,
  signal: AbortSignal,
  requestedId?: string,
) {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(Date.now() + timeoutMs + GRACE_MS)) {
    throw new Error("Cloud backup staging requires a finite job deadline.");
  }
  const { bucket, prefix } = getBackupStagingLocation(environment);
  await abortableBackupOperation(cleanupExpiredBackupCloudStages(environment), signal);
  signal.throwIfAborted();
  const id = requestedId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Backup staging requires a valid run identity.");
  }
  const lease = bucket.file(`${prefix}/leases/${id}.json`);
  const file = bucket.file(`${prefix}/archives/${id}.zip.enc`);
  const expiresAt = Date.now() + timeoutMs + GRACE_MS;
  await abortableBackupOperation(lease.save(JSON.stringify({ purpose: "temporary encrypted backup" }), {
    resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: "application/json",
      metadata: { expiresAt: String(expiresAt) },
    },
  }), signal);
  let writer: ReturnType<typeof file.createWriteStream> | undefined;
  let pinned: ReturnType<typeof bucket.file> | undefined;
  let archiveGeneration: string | number | undefined;
  let size = 0;
  let sealed = false;
  return {
    expiresAt,
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
      archiveGeneration = metadata.generation;
      pinned = bucket.file(file.name, { generation: metadata.generation });
      await abortableBackupOperation(lease.setMetadata({
        metadata: { expiresAt: String(expiresAt), archiveGeneration: String(metadata.generation) },
      }), signal);
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
        if (sealed && pinned) {
          await abortableBackupOperation(pinned.delete({
            ignoreNotFound: true, ifGenerationMatch: archiveGeneration,
          }), cleanupSignal);
        } else {
          const [metadata] = await abortableBackupOperation(file.getMetadata(), cleanupSignal);
          if (metadata.generation) {
            await abortableBackupOperation(bucket.file(file.name, { generation: metadata.generation }).delete({
              ignoreNotFound: true, ifGenerationMatch: metadata.generation,
            }), cleanupSignal);
          }
        }
        // An interrupted resumable write could finish late. Retain its lease
        // for a second cleanup after the hard deadline and grace period.
        if (sealed) {
          const [metadata] = await abortableBackupOperation(lease.getMetadata(), cleanupSignal);
          if (metadata.generation) {
            await abortableBackupOperation(lease.delete({
              ignoreNotFound: true, ifGenerationMatch: metadata.generation,
            }), cleanupSignal);
          }
        }
      } catch {
        logger.warn("[backup] Cloud staging cleanup will be retried from its durable lease");
      }
    },
  };
}

/** Reopen a sealed stage by its run identity after a browser reconnect. */
export async function openBackupCloudStage(
  environment: "production" | "non-production",
  id: string,
  signal: AbortSignal,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Backup staging requires a valid run identity.");
  }
  signal.throwIfAborted();
  const { bucket, prefix } = getBackupStagingLocation(environment);
  const lease = bucket.file(`${prefix}/leases/${id}.json`);
  const file = bucket.file(`${prefix}/archives/${id}.zip.enc`);
  const [leaseMetadata] = await abortableBackupOperation(lease.getMetadata(), signal);
  const expiry = Number(leaseMetadata.metadata?.expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry <= Date.now()) {
    throw new Error("The browser backup is no longer available for delivery.");
  }
  const [metadata] = await abortableBackupOperation(file.getMetadata(), signal);
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= 0 || !metadata.generation) {
    throw new Error("The staged backup archive could not be verified.");
  }
  const pinned = bucket.file(file.name, { generation: metadata.generation });
  return {
    size,
    expiresAt: expiry,
    async readChunk(offset: number, length: number): Promise<Buffer> {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
          length <= 0 || length > MAX_BACKUP_RANGE_BYTES || offset + length > size) {
        throw new Error("Invalid cloud backup range.");
      }
      const stream = pinned.createReadStream({ start: offset, end: offset + length - 1, validation: false });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (timer) clearTimeout(timer);
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
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        stream.destroy();
      }
    },
    async cleanup(): Promise<void> {
      const cleanupSignal = AbortSignal.timeout(10_000);
      await abortableBackupOperation(pinned.delete({
        ignoreNotFound: true, ifGenerationMatch: metadata.generation,
      }), cleanupSignal);
      if (typeof leaseMetadata.generation === "string" || typeof leaseMetadata.generation === "number") {
        await abortableBackupOperation(lease.delete({
          ignoreNotFound: true, ifGenerationMatch: leaseMetadata.generation,
        }), cleanupSignal);
      }
    },
  };
}
