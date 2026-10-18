CREATE TABLE IF NOT EXISTS "bank_deposit_batch_members" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "aggregate_bank_transaction_id" varchar NOT NULL REFERENCES "bank_transactions"("id") ON DELETE CASCADE,
  "child_bank_transaction_id" varchar NOT NULL REFERENCES "bank_transactions"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "bank_deposit_batch_members_child_unique"
  ON "bank_deposit_batch_members" ("child_bank_transaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "bank_deposit_batch_members_aggregate_child_unique"
  ON "bank_deposit_batch_members" ("aggregate_bank_transaction_id", "child_bank_transaction_id");
CREATE INDEX IF NOT EXISTS "bank_deposit_batch_members_aggregate_idx"
  ON "bank_deposit_batch_members" ("aggregate_bank_transaction_id");
CREATE INDEX IF NOT EXISTS "bank_deposit_batch_members_child_idx"
  ON "bank_deposit_batch_members" ("child_bank_transaction_id");