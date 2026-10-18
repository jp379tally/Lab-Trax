import { pool } from "@workspace/db";

/** Additive compatibility for old dumps; no history is removed or reset. */
export async function ensureBackupHistorySchema(): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.backup_runs') IS NULL THEN RETURN; END IF;
      ALTER TABLE public.backup_runs ADD COLUMN IF NOT EXISTS download_run_id text;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'backup_runs'
          AND column_name = 'size_bytes' AND data_type = 'integer'
      ) THEN
        ALTER TABLE public.backup_runs ALTER COLUMN size_bytes TYPE bigint;
      END IF;
      CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_download_run_id_key
        ON public.backup_runs(download_run_id);
    END $$;
  `);
}
