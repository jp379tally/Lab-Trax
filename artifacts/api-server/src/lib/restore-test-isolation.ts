import * as path from "node:path";

/** Fail before importing the DB or writing fixtures outside the isolated runner. */
export function requireIsolatedRestoreTest(): void {
  const root = process.env.LABTRAX_ISOLATED_RESTORE_ROOT;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (
    !root ||
    path.resolve(process.cwd()) !== path.join(path.resolve(root), "workspace/artifacts/api-server") ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/labtrax_restore_test"
  ) {
    throw new Error(
      "Destructive restore tests require scripts/run-isolated-backup-restore.sh; refusing this database/uploads directory.",
    );
  }
}
