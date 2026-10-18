CREATE TABLE IF NOT EXISTS case_saved_views (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL,
  created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS case_saved_views_lab_name_unique
  ON case_saved_views (lab_organization_id, lower(name));
CREATE INDEX IF NOT EXISTS case_saved_views_lab_idx
  ON case_saved_views (lab_organization_id);
