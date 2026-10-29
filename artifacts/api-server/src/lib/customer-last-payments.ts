import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type CustomerLastPayment = {
  /** The payment date the user recorded (not the row's insert time). */
  paidAt: string;
  /** Money received in that payment, as a two-decimal string. */
  amount: string;
};

export type CustomerDoctorLastPayment = CustomerLastPayment & {
  doctorIdentity: string;
};

/**
 * The most recent payment a lab received from each customer, across every
 * way a payment can be recorded:
 *
 * - A payment session (Receive Payments, saved-card and inline-card receipts,
 *   and the older Receive Payments batches, which also write a session). It
 *   is one payment however many invoices it settled, worth the money
 *   received, including any overpayment kept as customer credit.
 * - A payment row that no session owns: a payment recorded directly against
 *   an invoice, or a provider-hosted card checkout (one checkout is one
 *   payment, however many invoices it settled).
 *
 * A session owns payment rows through the same three links the account
 * ledger uses: the row's payment session id, its provider checkout, or the
 * older batch's deposit transaction. Owned rows are represented by their
 * session so the payment is never counted twice.
 *
 * Reversed payments never count: a cancelled session, a session with a
 * reversal that has not failed (the customer-credit listing reserves those
 * too), and deleted payment rows. Credit-only applications receive no money
 * and are skipped.
 */
export async function loadCustomerLastPayments(
  labOrganizationId: string,
  providerOrganizationIds: string[],
): Promise<Map<string, CustomerLastPayment>> {
  const ids = Array.from(new Set(providerOrganizationIds.filter(Boolean)));
  const result = new Map<string, CustomerLastPayment>();
  if (!ids.length) return result;
  const providerList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

  const rows = await db.execute(sql`
    WITH session_events AS (
      SELECT
        s.provider_organization_id AS provider_id,
        s.payment_date AS paid_at,
        s.received_amount::numeric AS amount,
        s.created_at AS recorded_at,
        s.id::text AS event_key
      FROM statement_payment_sessions s
      WHERE s.lab_organization_id = ${labOrganizationId}
        AND s.provider_organization_id IN (${providerList})
        AND s.cancelled_at IS NULL
        AND s.status <> 'cancelled'
        AND s.received_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM statement_payment_reversals r
          WHERE r.payment_session_id = s.id
            AND r.status <> 'failed'
        )
    ),
    standalone_events AS (
      SELECT
        i.provider_organization_id AS provider_id,
        MAX(p.paid_at) AS paid_at,
        SUM(p.amount)::numeric AS amount,
        MAX(p.created_at) AS recorded_at,
        COALESCE(p.provider_payment_checkout_id, p.id)::text AS event_key
      FROM payments p
      INNER JOIN invoices i ON i.id = p.invoice_id
      WHERE i.lab_organization_id = ${labOrganizationId}
        AND i.provider_organization_id IN (${providerList})
        AND i.deleted_at IS NULL
        AND i.status <> 'void'
        AND p.payment_session_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM statement_payment_sessions owner
          WHERE owner.lab_organization_id = i.lab_organization_id
            AND (
              (p.provider_payment_checkout_id IS NOT NULL
                AND owner.provider_payment_checkout_id = p.provider_payment_checkout_id)
              OR (p.bank_transaction_id IS NOT NULL
                AND owner.bank_transaction_id = p.bank_transaction_id)
            )
        )
      GROUP BY
        i.provider_organization_id,
        COALESCE(p.provider_payment_checkout_id, p.id)
    ),
    events AS (
      SELECT * FROM session_events
      UNION ALL
      SELECT * FROM standalone_events
    )
    SELECT DISTINCT ON (provider_id)
      provider_id,
      paid_at,
      amount::text AS amount
    FROM events
    WHERE amount > 0
    ORDER BY provider_id, paid_at DESC, recorded_at DESC, event_key DESC
  `);

  for (const row of rows.rows as Array<{
    provider_id: string;
    paid_at: Date | string;
    amount: string;
  }>) {
    const paidAt = new Date(row.paid_at);
    if (Number.isNaN(paidAt.getTime())) continue;
    result.set(row.provider_id, {
      paidAt: paidAt.toISOString(),
      amount: Number(row.amount).toFixed(2),
    });
  }
  return result;
}

/**
 * The most recent non-reversed payment session attributed to each doctor at
 * each customer. Sessions without a doctor identity are deliberately omitted:
 * a practice-wide or legacy payment cannot be assigned to a doctor here.
 */
export async function loadCustomerDoctorLastPayments(
  labOrganizationId: string,
  providerOrganizationIds: string[],
): Promise<Map<string, CustomerDoctorLastPayment[]>> {
  const ids = Array.from(new Set(providerOrganizationIds.filter(Boolean)));
  const result = new Map<string, CustomerDoctorLastPayment[]>();
  if (!ids.length) return result;
  const providerList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (s.provider_organization_id, s.doctor_identity)
      s.provider_organization_id AS provider_id,
      s.doctor_identity,
      s.payment_date AS paid_at,
      s.received_amount::numeric AS amount
    FROM statement_payment_sessions s
    WHERE s.lab_organization_id = ${labOrganizationId}
      AND s.provider_organization_id IN (${providerList})
      AND s.doctor_identity IS NOT NULL
      AND btrim(s.doctor_identity) <> ''
      AND s.cancelled_at IS NULL
      AND s.status <> 'cancelled'
      AND s.received_amount > 0
      AND NOT EXISTS (
        SELECT 1 FROM statement_payment_reversals r
        WHERE r.payment_session_id = s.id
          AND r.status <> 'failed'
      )
    ORDER BY
      s.provider_organization_id,
      s.doctor_identity,
      s.payment_date DESC,
      s.created_at DESC,
      s.id DESC
  `);

  for (const row of rows.rows as Array<{
    provider_id: string;
    doctor_identity: string;
    paid_at: Date | string;
    amount: string;
  }>) {
    const paidAt = new Date(row.paid_at);
    if (Number.isNaN(paidAt.getTime())) continue;
    const doctorPayments = result.get(row.provider_id) ?? [];
    doctorPayments.push({
      doctorIdentity: row.doctor_identity,
      paidAt: paidAt.toISOString(),
      amount: Number(row.amount).toFixed(2),
    });
    result.set(row.provider_id, doctorPayments);
  }
  return result;
}
