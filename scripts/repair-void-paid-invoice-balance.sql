-- repair-void-paid-invoice-balance.sql
--
-- Fixes invoices whose status is 'void' or 'paid' but whose balance_due was
-- not zeroed at transition time (a bug that has since been corrected in the
-- application code).
--
-- Usage:
--   1. Run the DRY-RUN SELECT below against your production database to
--      confirm which rows will be affected before making any changes.
--   2. Once you are satisfied, run the LIVE UPDATE immediately below it.
--
-- Both statements are intentionally separated so you must actively copy and
-- execute the UPDATE — no accidental changes from running the whole file.

-- ── DRY-RUN (read-only) ──────────────────────────────────────────────────────
-- Shows every invoice that will be corrected: its id, current status,
-- current balance_due, and the linked case (if any).

SELECT
    i.id,
    i.status,
    i.balance_due,
    i.case_id,
    i.lab_organization_id,
    i.voided_at,
    i.deleted_at
FROM invoices i
WHERE i.status IN ('void', 'paid')
  AND i.balance_due != '0.00'
  AND i.deleted_at IS NULL
ORDER BY i.lab_organization_id, i.status, i.id;

-- ── LIVE UPDATE ──────────────────────────────────────────────────────────────
-- Execute this only after reviewing the dry-run output above.
-- UPDATE invoices
--    SET balance_due = '0.00'
--  WHERE status IN ('void', 'paid')
--    AND balance_due != '0.00'
--    AND deleted_at IS NULL;
