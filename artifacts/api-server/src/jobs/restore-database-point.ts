/**
 * Offline, isolated-only database recovery option. The owner first retrieves
 * the encrypted database-protection objects using their authorized OneDrive
 * access. This command never contacts a cloud destination or opens media.
 */
import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { encryptBuffer, decryptBuffer } from "../lib/backup";
import { restoreDatabasePointIsolated } from "../lib/database-protection-restore";
import { restoreProductionPointIsolated } from "../lib/production-content-restore";
import type { DatabaseObjectStore } from "../lib/database-protection";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";

async function main() {
  const directory = process.env.LABTRAX_DATABASE_RESTORE_OBJECTS_DIR;
  const marker = process.env.LABTRAX_DATABASE_RESTORE_MARKER;
  const source = process.env.LABTRAX_DATABASE_RESTORE_SOURCE_SHA256;
  const targetUrl = process.env.LABTRAX_DATABASE_RESTORE_TARGET_URL;
  if (!directory || !marker || !source || !/^[a-f0-9]{64}$/.test(source) || !targetUrl ||
      process.env.LABTRAX_DATABASE_RESTORE_ISOLATED !== "1") {
    throw new Error("Provide private encrypted objects, the verified marker/source identity, and an acknowledged empty disposable target.");
  }
  const root = resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Recovery object directory must be an ordinary private directory.");
  const offlineStore = (base: string): DatabaseObjectStore => ({
    async list() {
      const entries = await readdir(base, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const info = await lstat(join(base, entry.name));
        result.push({ name: entry.name, createdAt: info.mtime.toISOString() });
      }
      return result;
    },
    async get(name) {
      if (!/^(?:chunk-[a-f0-9]{64}|(?:point|verified)-[0-9]{13}-[a-f0-9-]{36})\.enc$/.test(name)) {
        throw new Error("Invalid database recovery object identity.");
      }
      try {
        const file = join(base, name);
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) {
          throw new Error("Recovery object is not a bounded ordinary file.");
        }
        return readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async put() { throw new Error("Offline database restore cannot write recovery objects."); },
    async delete() { throw new Error("Offline database restore cannot delete recovery objects."); },
  });
  const store = offlineStore(root);
  const mediaRoot = process.env.LABTRAX_PRODUCTION_RESTORE_MEDIA_ROOT;
  if (mediaRoot) {
    const databaseRoot = join(root, "database");
    const info = await lstat(databaseRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Offline production database objects must be an ordinary directory.");
    const result = await restoreProductionPointIsolated({
      store, databaseStore: offlineStore(databaseRoot),
      codec: { encrypt: encryptBuffer, decrypt: decryptBuffer }, source, marker, targetUrl,
      mediaRoot, isolationAcknowledged: true,
    });
    logger.info({ coverage: result.coverage, restoredFiles: result.restoredFiles, missingFiles: result.missingFiles },
      "Isolated production point restored; missing originals were reported, not fabricated.");
    return;
  }
  const result = await restoreDatabasePointIsolated({
    store, codec: { encrypt: encryptBuffer, decrypt: decryptBuffer },
    source, marker, targetUrl, isolationAcknowledged: true,
  });
  logger.info({ dumpBytes: result.dumpBytes, mediaChanged: result.mediaChanged },
    "Isolated database point restored transactionally; media was not accessed.");
}
main().catch(() => {
  // No SQL, connection strings, private object names or provider payloads.
  logger.error("Isolated database recovery did not complete. Check target isolation, object integrity and the existing encryption-key lineage.");
  process.exitCode = 1;
}).finally(() => pool.end());
