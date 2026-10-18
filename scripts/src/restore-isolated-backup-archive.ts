import path from "node:path";

import { pool } from "@workspace/db";

const archivePath = process.env.LABTRAX_BACKUP_ARCHIVE_PATH;
const databaseUrl = process.env.DATABASE_URL;
const isolatedRoot = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;

if (!archivePath || !databaseUrl || !isolatedRoot) {
  throw new Error(
    "An archive path, isolated database URL, and isolated restore root are required.",
  );
}

const resolvedRoot = path.resolve(isolatedRoot);
const resolvedWorkingDirectory = path.resolve(process.cwd());
const databaseHost = new URL(databaseUrl).hostname;
if (
  !resolvedWorkingDirectory.startsWith(`${resolvedRoot}${path.sep}`) ||
  (databaseHost !== "127.0.0.1" && databaseHost !== "localhost" && databaseHost !== "::1")
) {
  throw new Error("Refusing to restore unless both the workspace and database are isolated locally.");
}

try {
  const backupModulePath = path.resolve(process.cwd(), "src/lib/backup.ts");
  const { executeRestoreFile, inspectUploadDirs } = await import(backupModulePath);
  const { manifest, compatibilityUpgrades } = await executeRestoreFile(
    path.resolve(archivePath),
    "isolated-archive-verification",
  );
  if (manifest.archiveKind !== "full") {
    throw new Error("The supplied archive is not a full backup.");
  }

  const expectedMediaFiles =
    typeof manifest.mediaFileCount === "number" ? manifest.mediaFileCount : null;
  const restoredMediaFiles = inspectUploadDirs().caseMedia.fileCount;
  if (expectedMediaFiles !== null && restoredMediaFiles !== expectedMediaFiles) {
    throw new Error(
      `Restored case-media count ${restoredMediaFiles} does not match manifest count ${expectedMediaFiles}.`,
    );
  }

  console.log(
    JSON.stringify({
      result: "restored",
      archiveKind: manifest.archiveKind,
      caseCount: manifest.caseCount ?? null,
      invoiceCount: manifest.invoiceCount ?? null,
      mediaFileCount: restoredMediaFiles,
      compatibilityUpgrades,
    }),
  );
} finally {
  await pool.end();
}
