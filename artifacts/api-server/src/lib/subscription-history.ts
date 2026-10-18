import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db, pool, subscriptions, subscriptionEvents, systemSettings } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import { ingestStripeInvoice, ingestStripeRefunds, ingestRevenueCat } from "./subscription-evidence";

const KEY = "subscription_revenue_history";
type Progress = { subscriptionCursor?: string; invoiceCursor?: string; rcCursor?: string; stripeStatus?: string; rcStatus?: string; stripeCheckedAt?: string; updatedAt?: string; error?: string };
async function load(): Promise<Progress> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY));
  return row ? JSON.parse(row.value ?? "{}") : {};
}
async function save(value: Progress) {
  await db.insert(systemSettings).values({ key: KEY, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: JSON.stringify(value) } });
}
export async function subscriptionCoverage() {
  const progress = await load();
  return [
    { provider: "stripe", status: progress.stripeStatus ?? "not_ingested",
      detail: progress.stripeStatus === "checked"
        ? "Available invoices for known subscription accounts checked through the last scan; unlinked accounts and deleted provider records are not included. Later refunds rely on webhooks or the next scan."
        : "Historical Stripe invoices and refunds are not fully ingested. A zero or partial total is not a complete revenue result.",
      updatedAt: progress.updatedAt ?? null },
    { provider: "revenuecat", status: "partial",
      detail: "Verified production webhook evidence and recoverable stored event payloads only. Earlier renewals without original purchased-currency amounts cannot be recovered from lifecycle status; RevenueCat history is incomplete.",
      updatedAt: progress.updatedAt ?? null },
    { provider: "provider_renewals", status: progress.stripeStatus ?? "not_ingested",
      detail: "Stripe-paid subscription invoices only. Dental invoice auto-pay, waived and zero-dollar renewals are excluded. Local successful-attempt amounts are not inferred as receipts.",
      updatedAt: progress.updatedAt ?? null },
  ];
}

/** One bounded, restart-safe batch. No payment creation or refund operations. */
export async function reconcileSubscriptionHistory() {
  const client = await pool.connect();
  let locked = false;
  let progress: Progress = {};
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(74450321) AS locked");
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { ok: false, busy: true };
    progress = await load();
    const stripe: any = await getUncachableStripeClient();
    if (stripe) {
      const rescanDue = !progress.stripeCheckedAt || Date.now() - Date.parse(progress.stripeCheckedAt) >= 86400000;
      if (progress.stripeStatus === "checked" && rescanDue) {
        progress.subscriptionCursor = undefined;
        progress.invoiceCursor = undefined;
        progress.stripeStatus = "ingesting";
      }
      if (progress.stripeStatus !== "checked") {
      progress.stripeStatus = "ingesting";
      // Resolve one subscription and one invoice page per batch. Cursors are
      // committed after evidence, so a crash only replays idempotent inserts.
      const [sub] = await db.select().from(subscriptions).where(and(
        isNotNull(subscriptions.stripeSubscriptionId),
        progress.subscriptionCursor ? progress.invoiceCursor ? sql`${subscriptions.id} >= ${progress.subscriptionCursor}` : gt(subscriptions.id, progress.subscriptionCursor) : undefined,
      )).orderBy(asc(subscriptions.id)).limit(1);
      if (!sub) {
        progress.stripeStatus = "checked";
        progress.stripeCheckedAt = new Date().toISOString();
      }
      else {
        const page = await stripe.invoices.list({ subscription: sub.stripeSubscriptionId, limit: 25, ...(progress.invoiceCursor ? { starting_after: progress.invoiceCursor } : {}) });
        for (const invoice of page.data) {
          await ingestStripeInvoice(invoice, sub.id);
          if (invoice.livemode === true && invoice.status === "paid") {
            let charge: any = invoice.charge;
            if (!charge && invoice.payment_intent) {
              const intent = typeof invoice.payment_intent === "string" ? await stripe.paymentIntents.retrieve(invoice.payment_intent) : invoice.payment_intent;
              charge = intent.latest_charge;
            }
            if (!charge && stripe.invoicePayments?.list) {
              const payments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 100 });
              for (const payment of payments.data) {
                const intentId = payment.payment?.payment_intent;
                if (!intentId) continue;
                const intent = typeof intentId === "string" ? await stripe.paymentIntents.retrieve(intentId) : intentId;
                if (intent.latest_charge) await ingestStripeRefunds(stripe, typeof intent.latest_charge === "string" ? await stripe.charges.retrieve(intent.latest_charge) : intent.latest_charge);
              }
              if (payments.has_more) throw new Error("Invoice payment history requires additional paging; coverage remains incomplete.");
            }
            if (charge) await ingestStripeRefunds(stripe, typeof charge === "string" ? await stripe.charges.retrieve(charge) : charge);
          }
        }
        progress.subscriptionCursor = sub.id;
        progress.invoiceCursor = page.has_more ? page.data.at(-1)?.id : undefined;
        if (page.has_more && !progress.invoiceCursor) throw new Error("Invoice history cursor did not advance.");
      }
      }
    } else progress.stripeStatus = "unavailable";
    const events = await db.select().from(subscriptionEvents).where(and(
      eq(subscriptionEvents.provider, "revenuecat"),
      progress.rcCursor ? gt(subscriptionEvents.id, progress.rcCursor) : undefined,
    )).orderBy(asc(subscriptionEvents.id)).limit(100);
    for (const event of events) {
      if (event.subscriptionId && event.rawPayloadJson) await ingestRevenueCat(event.subscriptionId, event.rawPayloadJson);
      progress.rcCursor = event.id;
    }
    progress.rcStatus = "partial";
    progress.updatedAt = new Date().toISOString();
    delete progress.error;
    if (locked) await save(progress);
    return { ok: true, coverage: await subscriptionCoverage(), hasMore: progress.stripeStatus === "ingesting" || events.length === 100 };
  } catch (error) {
    progress.stripeStatus = "incomplete";
    progress.error = "Provider history read failed; resume the bounded scan.";
    // Do not advance failed page cursors; verified inserts can safely replay.
    if (locked) await save(progress);
    throw error;
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(74450321)");
    } finally { client.release(); }
  }
}

export function startSubscriptionEvidenceJob() {
  const tick = () => reconcileSubscriptionHistory().catch(() => {
    // Failure is durable and disclosed by coverage; the next tick resumes.
  });
  void tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
}
