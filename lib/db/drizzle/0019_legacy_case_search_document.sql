-- Replace the multi-megabyte legacy blob trigram index with a compact,
-- trigger-maintained identity search document.
ALTER TABLE "lab_cases"
  ADD COLUMN IF NOT EXISTS "projected_search_document" text;

CREATE OR REPLACE FUNCTION lab_cases_project_search_document() RETURNS trigger
LANGUAGE plpgsql AS $lab_cases_project_search_document$
DECLARE
  src text;
  patient_name text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.case_data IS NOT DISTINCT FROM OLD.case_data
    AND NEW.projected_search_document IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  src := coalesce(NEW.case_data, '');
  patient_name := coalesce(substring(src from '"patientName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '');
  NEW.projected_search_document := lower(
    coalesce(substring(src from '"caseNumber"[[:space:]]*:[[:space:]]*"([^"]*)"'), '') || ' ' ||
    split_part(patient_name, ' ', 1) || ' ' ||
    regexp_replace(patient_name, '^[^ ]+[ ]*', '') || ' ' ||
    coalesce(substring(src from '"doctorName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '') || ' ' ||
    coalesce(substring(src from '"assignedBarcode"[[:space:]]*:[[:space:]]*"([^"]*)"'), '')
  );
  RETURN NEW;
END;
$lab_cases_project_search_document$;

DROP TRIGGER IF EXISTS lab_cases_project_search_document_trg ON lab_cases;
CREATE TRIGGER lab_cases_project_search_document_trg
  BEFORE INSERT OR UPDATE ON lab_cases
  FOR EACH ROW EXECUTE FUNCTION lab_cases_project_search_document();

DROP INDEX IF EXISTS "lab_cases_search_trgm_idx";
DROP INDEX IF EXISTS "lab_cases_projected_search_trgm_idx";

DROP INDEX IF EXISTS "lab_cases_projection_version_idx";
CREATE INDEX IF NOT EXISTS "lab_cases_projection_stale_v2_idx"
  ON "lab_cases" ("projection_version")
  WHERE "projection_version" IS DISTINCT FROM 2;
