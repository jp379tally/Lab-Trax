ALTER TABLE "bank_deposit_batch_members" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;
DROP INDEX IF EXISTS "bank_deposit_batch_members_child_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "bank_deposit_batch_members_child_unique"
  ON "bank_deposit_batch_members" ("child_bank_transaction_id")
  WHERE released_at IS NULL;
CREATE OR REPLACE FUNCTION validate_bank_deposit_batch_member()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row bank_transactions%ROWTYPE;
  child_row bank_transactions%ROWTYPE;
BEGIN
  SELECT * INTO parent_row FROM bank_transactions WHERE id = NEW.aggregate_bank_transaction_id FOR UPDATE;
  SELECT * INTO child_row FROM bank_transactions WHERE id = NEW.child_bank_transaction_id FOR UPDATE;
  IF parent_row.id IS NULL OR child_row.id IS NULL
     OR parent_row.id = child_row.id
     OR parent_row.lab_organization_id <> child_row.lab_organization_id
     OR parent_row.source <> 'deposit_batch'
      OR child_row.status <> 'posted' THEN
    RAISE EXCEPTION 'Invalid deposit batch member';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bank_deposit_batch_members_validate ON bank_deposit_batch_members;
DROP TRIGGER IF EXISTS bank_deposit_batch_member_validate ON bank_deposit_batch_members;
CREATE TRIGGER bank_deposit_batch_members_validate
  BEFORE INSERT ON bank_deposit_batch_members
  FOR EACH ROW EXECUTE FUNCTION validate_bank_deposit_batch_member();