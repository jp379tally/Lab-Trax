import multer, { type DiskStorageOptions, type StorageEngine } from "multer";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { copyProductionUpload, deleteProductionUpload } from "./production-media-local-write";
import type { MediaWriter } from "./production-media-mutation";

/**
 * A multipart body is scratch until finished. Promotion uses the same durable
 * version/journal boundary as buffered imports; truncated bodies never promote.
 */
export function productionMediaDiskStorage(options: DiskStorageOptions, writer: MediaWriter): StorageEngine {
  const destinations = new WeakMap<object, string>();
  const scratch = multer.diskStorage({
    ...options,
    destination(req, file, cb) {
      const accept = async (error: Error | null, directory?: string) => {
        if (error || !directory) return cb(error ?? new Error("Missing durable media destination."), "");
        try {
          const temporary = join(directory, ".upload-staging");
          await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
          destinations.set(file, directory);
          cb(null, temporary);
        } catch (e) { cb(e as Error, ""); }
      };
      if (typeof options.destination === "string") void accept(null, options.destination);
      else if (options.destination) options.destination(req, file, (e, directory) => { void accept(e, directory); });
      else void accept(new Error("Unregistered durable media multipart destination."));
    },
  });
  return {
    _handleFile(req, file, cb) {
      scratch._handleFile(req, file, (error, result) => {
        if (error || !result?.path || !result.filename) return cb(error ?? new Error("Multipart staging failed."));
        const temporary = result.path, name = result.filename;
        void (async () => {
          if ((file.stream as typeof file.stream & { truncated?: boolean }).truncated) {
            throw new Error("Interrupted or truncated media upload was not promoted.");
          }
          const directory = destinations.get(file);
          if (!directory) throw new Error("Multipart destination identity was lost.");
          if (basename(name) !== name || name.startsWith(".")) throw new Error("Unsafe multipart final filename.");
          const destination = join(directory, name);
          await copyProductionUpload(temporary, destination, writer);
          await fs.unlink(temporary).catch(() => undefined);
          cb(null, { ...result, destination: directory, path: destination });
        })().catch(async e => {
          // Only this operation's scratch body; never an original/version.
          await fs.unlink(temporary).catch(() => undefined);
          cb(e);
        });
      });
    },
    _removeFile(_req, file, cb) {
      void deleteProductionUpload(file.path, writer).then(() => cb(null), cb);
    },
  };
}
