CREATE UNIQUE INDEX IF NOT EXISTS "scan_inputs_job_file_unique"
ON "scan_inputs" ("job_id","file_name");