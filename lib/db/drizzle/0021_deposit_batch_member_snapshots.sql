ALTER TABLE "bank_deposit_batch_members"
  ADD COLUMN "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "bank_deposit_batch_members"
  ADD COLUMN "release_outcome" text;

-- Freeze legacy memberships at the first deploy of immutable history. The
-- snapshot intentionally uses only durable linked data available in the old
-- schema; later edits/redeposits cannot rewrite these values.
UPDATE "bank_deposit_batch_members" m
SET "snapshot" = jsonb_build_object(
  'amount', COALESCE(child."net_amount", '0.00'),
  'payee', child."payee",
  'memo', child."memo",
  'checkNumber', COALESCE(session."check_number", child."check_number"),
  'paymentMethod', session."payment_method",
  'receiptNumber', session."receipt_number",
  'paymentSessionId', session."id",
  'invoiceLinks', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'invoiceId', l."invoice_id",
      'invoiceNumber', i."invoice_number"
    ))
    FROM "bank_transaction_invoices" l
    JOIN "invoices" i ON i."id" = l."invoice_id"
    WHERE l."bank_transaction_id" = child."id"
  ), '[]'::jsonb),
  'legacyUnverified', true
)
FROM "bank_transactions" child
LEFT JOIN "statement_payment_sessions" session
  ON session."bank_transaction_id" = child."id"
WHERE child."id" = m."child_bank_transaction_id"
  AND m."snapshot" = '{}'::jsonb;
