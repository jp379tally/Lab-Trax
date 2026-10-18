-- Worklist tenant/date and legacy candidate indexes.
-- Keep this migration limited to the indexes introduced for the worklist.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "cases_lab_received_idx"
  ON "cases" USING btree ("lab_organization_id", "deleted_at", "received_at");
CREATE INDEX IF NOT EXISTS "cases_provider_received_idx"
  ON "cases" USING btree ("provider_organization_id", "deleted_at", "received_at");
CREATE INDEX IF NOT EXISTS "cases_lab_status_priority_idx"
  ON "cases" USING btree ("lab_organization_id", "deleted_at", "status", "priority");
CREATE INDEX IF NOT EXISTS "lab_cases_organization_updated_idx"
  ON "lab_cases" USING btree ("organization_id", "updated_at");
CREATE INDEX IF NOT EXISTS "lab_cases_organization_deleted_idx"
  ON "lab_cases" USING btree ("organization_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "cases_search_trgm_idx"
  ON "cases" USING gin (
    lower(coalesce("case_number", '') || ' ' || coalesce("patient_first_name", '') || ' ' || coalesce("patient_last_name", '') || ' ' || coalesce("doctor_name", '') || ' ' || coalesce("case_pan_barcode", '')) gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS "lab_cases_search_trgm_idx"
  ON "lab_cases" USING gin (lower("case_data") gin_trgm_ops);