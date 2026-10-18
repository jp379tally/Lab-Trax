import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setMaxListeners } from "node:events";
import type { Archiver } from "archiver";
import pLimit from "p-limit";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import type { CaseMediaBackupObject } from "./case-media-object-storage";
import { measureBackupPhase, setBackupLiveProgress } from "./backup-phase";

export const DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY = 12;
export type BackupMediaAppender = (archive: Archiver, maxConcurrentFiles?: number) => Promise<void>;

interface MediaSource {
  relativeName: string;
  size: number;
  localPath?: string;
  copyTo?: CaseMediaBackupObject["copyTo"];
  generation?: string;
  metadata?: Record<string, unknown>;
  localIdentity?: string;
}

export interface BackupFileEvidence {
  archivePath: string;
  relativeName: string;
  size: number;
  sha256: string;
  generation?: string;
  metadata?: Record<string, unknown>;
}

const identity = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

/** Preserve the entire local/cloud union, including nested/hidden recovery data. */
export async function planBackupMedia(
  localDir: string,
  objects: CaseMediaBackupObject[],
  signal?: AbortSignal,
  options: { archivePrefix?: string; onFile?: (file: BackupFileEvidence) => void; exclude?: (name: string) => boolean } = {},
): Promise<{ names: Set<string>; fileCount: number; totalBytes: number; append: BackupMediaAppender }> {
  const sources = new Map<string, MediaSource>();
  async function walk(directory: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !relative) return;
      throw new Error("Case-media local inventory failed; check disk access before retrying.");
    }
    for (const entry of entries) {
      if (signal?.aborted) throw new Error("Case-media local inventory was aborted.");
      const fullPath = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (options.exclude?.(name)) continue;
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error("Backup aborted: case-media contains a symbolic link or non-regular file.");
      }
      if (stat.isDirectory()) await walk(fullPath, name);
      else sources.set(name, { relativeName: name, size: stat.size, localPath: fullPath, localIdentity: identity(stat) });
    }
  }
  try {
    await walk(localDir, "");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw new Error(`Case-media inventory inspection failed (${String(error.code)}).`);
    }
    throw error;
  }
  // Durable bytes are authoritative over a stale same-name local cache.
  for (const object of objects) sources.set(object.relativeName, object);
  const media = [...sources.values()];
  const totalBytes = media.reduce((sum, source) => sum + source.size, 0);
  const append: BackupMediaAppender = async (
    archive,
    maxConcurrentFiles = DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY,
  ) => {
    if (!Number.isSafeInteger(maxConcurrentFiles) ||
        maxConcurrentFiles < 1 ||
        maxConcurrentFiles > DEFAULT_BACKUP_MEDIA_PREFETCH_CONCURRENCY) {
      throw new Error("Backup media prefetch concurrency is invalid.");
    }
    const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "labtrax-backup-prefetch-"));
    const controller = new AbortController();
    setMaxListeners(32, controller.signal);
    archive.setMaxListeners(Math.max(32, archive.getMaxListeners()));
    const abort = () => controller.abort(new Error("Case-media archive transfer was aborted."));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    archive.once("error", abort);
    archive.once("close", abort);
    archive.once("warning", abort);
    const limit = pLimit(maxConcurrentFiles);
    let completedFiles = 0;
    let completedBytes = 0;
    let activeStagedBytes = 0;
    let peakStagedBytes = 0;
    try {
      await measureBackupPhase("case-media transfer into archive", async () => {
        const results = await Promise.allSettled(media.map((source, index) => limit(async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          let tempPath: string | undefined;
          let staged = false;
          try {
            let filePath = source.localPath;
            if (source.copyTo) {
              tempPath = path.join(stagingRoot, String(index));
              await source.copyTo(tempPath, controller.signal);
              filePath = tempPath;
              activeStagedBytes += source.size;
              staged = true;
              peakStagedBytes = Math.max(peakStagedBytes, activeStagedBytes);
            }
            if (!filePath) throw new Error("Case-media source has no readable file.");
            if (source.localPath && identity(await fs.lstat(source.localPath)) !== source.localIdentity) {
              throw new Error("A local recovery file changed after inventory; retry the complete backup.");
            }
            const name = `${options.archivePrefix ?? "media"}/${source.relativeName}`;
            const hash = createHash("sha256");
            let bytes = 0;
            const reader = createReadStream(filePath);
            const hashing = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                hash.update(chunk);
                bytes += chunk.length;
                callback(null, chunk);
              },
            });
            reader.on("error", error => hashing.destroy(error));
            hashing.on("error", error => archive.destroy(error));
            await new Promise<void>((resolve, reject) => {
              const settle = (error?: Error) => {
                archive.removeListener("entry", onEntry);
                controller.signal.removeEventListener("abort", onAbort);
                if (error) reject(error); else resolve();
              };
              const onEntry = (entry: { name: string }) => {
                if (entry.name === name) settle();
              };
              const onAbort = () => settle(new Error("Case-media archiving was aborted."));
              if (controller.signal.aborted) return onAbort();
              archive.on("entry", onEntry);
              controller.signal.addEventListener("abort", onAbort, { once: true });
              archive.append(reader.pipe(hashing), { name });
            });
            if (bytes !== source.size ||
                (source.localPath && identity(await fs.lstat(source.localPath)) !== source.localIdentity)) {
              throw new Error("Recovery file changed or was truncated during capture; no complete archive was kept.");
            }
            options.onFile?.({
              archivePath: name, relativeName: source.relativeName, size: bytes,
              sha256: hash.digest("hex"), generation: source.generation, metadata: source.metadata,
            });
            completedFiles++;
            completedBytes += source.size;
            setBackupLiveProgress({
              completedFiles,
              completedBytes,
              totalBytes,
              fileCount: media.length,
              archiveBytes: archive.pointer(),
            });
          } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
            throw error;
          } finally {
            if (tempPath) {
              await fs.rm(tempPath, { force: true }).catch(() => undefined);
              if (staged) activeStagedBytes -= source.size;
            }
          }
        })));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw controller.signal.reason ?? failure.reason;
      }, () => ({ fileCount: media.length, totalBytes, completedFiles, completedBytes, peakStagedBytes, archiveBytes: archive.pointer() }));
    } finally {
      signal?.removeEventListener("abort", abort);
      archive.removeListener("error", abort);
      archive.removeListener("close", abort);
      archive.removeListener("warning", abort);
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  };
  return { names: new Set(sources.keys()), fileCount: media.length, totalBytes, append };
}
