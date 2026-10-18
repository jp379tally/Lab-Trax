import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { GetRegisterAnalytics200Response } from "@workspace/api-zod";

/** One SQL snapshot; numeric sums stay exact until rendered as decimal strings. */
export async function registerAnalytics(input: {
  organizationId: string;
  bankAccountId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const { organizationId, bankAccountId, dateFrom, dateTo } = input;
  const result = await db.execute(sql`
    WITH visible AS MATERIALIZED (
      SELECT *, (txn_date AT TIME ZONE 'UTC')::date AS day
      FROM bank_transactions t
      WHERE lab_organization_id = ${organizationId}
        AND bank_account_id = ${bankAccountId}
        AND deleted_at IS NULL
        AND txn_date >= ${dateFrom}::date AT TIME ZONE 'UTC'
        AND txn_date < (${dateTo}::date + 1) AT TIME ZONE 'UTC'
        AND status <> 'deposited_child'
        AND NOT EXISTS (
          SELECT 1 FROM bank_deposit_batch_members m
          WHERE m.child_bank_transaction_id = t.id AND m.released_at IS NULL
        )
    ), movement AS (
      SELECT * FROM visible
      WHERE status = 'posted' AND transfer_group_id IS NULL AND type <> 'transfer'
    ), days AS (
      SELECT generate_series(${dateFrom}::date, ${dateTo}::date, '1 day'::interval)::date AS day
    ), daily AS (
      SELECT d.day, COALESCE(SUM(m.debit_amount), 0)::numeric(30,2)::text AS payments,
        COALESCE(SUM(m.credit_amount), 0)::numeric(30,2)::text AS deposits
      FROM days d LEFT JOIN movement m ON m.day = d.day GROUP BY d.day
    ), payees AS (
      SELECT COALESCE(NULLIF(btrim(payee), ''), 'Unspecified payee') AS payee,
        SUM(debit_amount)::numeric(30,2)::text AS payments,
        SUM(credit_amount)::numeric(30,2)::text AS deposits,
        SUM(debit_amount + credit_amount)::numeric(30,2) AS volume
      FROM movement GROUP BY COALESCE(NULLIF(btrim(payee), ''), 'Unspecified payee')
      HAVING SUM(debit_amount + credit_amount) <> 0
      ORDER BY volume DESC, payee ASC LIMIT 5
    )
    SELECT
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('date', day::text,
        'payments', payments, 'deposits', deposits) ORDER BY day), '[]'::jsonb) FROM daily) AS daily,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('payee', payee,
        'payments', payments, 'deposits', deposits, 'volume', volume::text)
        ORDER BY volume DESC, payee ASC), '[]'::jsonb) FROM payees) AS payees,
      jsonb_build_object(
        'postedCleared', COUNT(*) FILTER (WHERE status = 'posted' AND (cleared OR reconciled)),
        'postedUncleared', COUNT(*) FILTER (WHERE status = 'posted' AND NOT (cleared OR reconciled)),
        'voided', COUNT(*) FILTER (WHERE status = 'void'),
        'pending', COUNT(*) FILTER (WHERE status NOT IN ('posted', 'void'))
      ) AS statuses, COUNT(*)::integer AS "totalEntries"
    FROM visible
  `);
  return GetRegisterAnalytics200Response.parse({
    ...result.rows[0], bankAccountId, dateFrom, dateTo,
  });
}
