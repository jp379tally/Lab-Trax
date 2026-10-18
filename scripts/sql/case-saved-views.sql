-- Additive reconciliation for the declared lab-shared Cases views.
-- Unrelated legacy ownership findings must not prevent this empty table
-- from being installed. Never repair or remove historical records here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('labtrax:case-saved-views-schema'));

CREATE TABLE IF NOT EXISTS public.case_saved_views (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_organization_id varchar NOT NULL,
  name text NOT NULL,
  filters jsonb NOT NULL,
  created_by_user_id varchar,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_saved_views_lab_organization_id_organizations_id_fk
    FOREIGN KEY (lab_organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT case_saved_views_created_by_user_id_users_id_fk
    FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS case_saved_views_lab_name_unique
  ON public.case_saved_views (lab_organization_id, lower(name));
CREATE INDEX IF NOT EXISTS case_saved_views_lab_idx
  ON public.case_saved_views (lab_organization_id);
COMMIT;
