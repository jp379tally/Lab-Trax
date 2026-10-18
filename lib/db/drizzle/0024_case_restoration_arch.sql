ALTER TABLE "case_restorations"
  ADD COLUMN IF NOT EXISTS "arch" text;

DO $$ BEGIN
  ALTER TABLE "case_restorations"
    ADD CONSTRAINT "case_restorations_arch_check"
    CHECK ("arch" IS NULL OR "arch" IN ('upper', 'lower', 'upper_lower'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;