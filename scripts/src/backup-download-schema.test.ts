import { expect, it, vi } from "vitest";
import { installBackupDownloadSchema } from "./backup-download-schema";
import { REQUIRED_MIGRATION_SCHEMA_OBJECTS } from "./schema-object-drift";

it("reconciles only the already-declared nullable download identity and index", async () => {
  const query = vi.fn().mockResolvedValue({});
  await installBackupDownloadSchema(query);
  const statements = query.mock.calls.map(([sql]) => sql);
  expect([statements[0], statements[2]]).toEqual([
    "ALTER TABLE public.backup_runs ADD COLUMN IF NOT EXISTS download_run_id text",
    "CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_download_run_id_key ON public.backup_runs (download_run_id)",
  ]);
  expect(statements[1]).toContain("ALTER COLUMN size_bytes TYPE bigint");
  expect(statements.join("\n")).not.toMatch(/DELETE|TRUNCATE|DROP/);
  expect(REQUIRED_MIGRATION_SCHEMA_OBJECTS).toContainEqual({
    kind: "index", schema: "public", name: "backup_runs_download_run_id_key",
  });
});

it("does not conceal an installation failure", async () => {
  const error = new Error("lock timeout");
  await expect(installBackupDownloadSchema(vi.fn().mockRejectedValue(error))).rejects.toBe(error);
});
