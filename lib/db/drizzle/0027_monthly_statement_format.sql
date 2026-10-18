ALTER TABLE "statement_schedules"
  ADD COLUMN IF NOT EXISTS "statement_format" text NOT NULL DEFAULT 'per_doctor';