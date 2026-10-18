-- Synthetic data only. Loaded into a newly created disposable fixture DB.
-- The test changes received_at to timestamptz before loading these rows,
-- then verifies the UTC calendar-day upgrade through the real restore path.
BEGIN;

INSERT INTO users (id, username, password, user_type, role)
VALUES ('legacy-received-user', 'synthetic_received_fixture_user',
        'synthetic-fixture-not-a-login-secret', 'lab', 'admin');

INSERT INTO organizations (id, type, name, parent_lab_organization_id)
VALUES ('legacy-received-lab', 'lab', 'Synthetic Calendar Lab', NULL),
       ('legacy-received-provider', 'provider', 'Synthetic Calendar Practice',
        'legacy-received-lab');

INSERT INTO lab_memberships (id, lab_id, user_id, role, status)
VALUES ('legacy-received-membership', 'legacy-received-lab',
        'legacy-received-user', 'admin', 'active');

INSERT INTO cases
  (id, case_number, lab_organization_id, provider_organization_id,
   created_by_user_id, patient_first_name, patient_last_name, doctor_name,
   status, priority, received_at)
VALUES
  ('legacy-received-minus12', 'LEGACY-UTC-MINUS-12',
   'legacy-received-lab', 'legacy-received-provider', 'legacy-received-user',
   'SyntheticMinus12', 'CalendarFixture', 'Dr. Synthetic Calendar',
   'received', 'normal', TIMESTAMPTZ '2026-01-02 00:30:00+00'),
  ('legacy-received-plus14', 'LEGACY-UTC-PLUS-14',
   'legacy-received-lab', 'legacy-received-provider', 'legacy-received-user',
   'SyntheticPlus14', 'CalendarFixture', 'Dr. Synthetic Calendar',
   'received', 'normal', TIMESTAMPTZ '2026-01-02 23:30:00+00');

COMMIT;
