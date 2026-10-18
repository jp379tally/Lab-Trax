/** Reconcile declared nullable metadata only; never rewrite backup history. */
export async function installBackupDownloadSchema(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query("ALTER TABLE public.backup_runs ADD COLUMN IF NOT EXISTS download_run_id text");
  await query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='backup_runs' AND column_name='size_bytes' AND data_type IN ('integer', 'smallint')) THEN
      ALTER TABLE public.backup_runs ALTER COLUMN size_bytes TYPE bigint;
    END IF;
  END $$`);
  await query("CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_download_run_id_key ON public.backup_runs (download_run_id)");
}
