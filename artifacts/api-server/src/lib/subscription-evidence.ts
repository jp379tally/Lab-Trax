import { and, eq, isNotNull } from "drizzle-orm";
import { db, subscriptionReceipts, subscriptions, systemSettings } from "@workspace/db";
import { normalizeStripeReceipt, normalizeStripeRefund, normalizeRevenueCatReceipt, stripeSubscriptionId, type Evidence } from "./subscription-evidence-normalize";

export async function persistSubscriptionEvidence(subscriptionId: string, evidence: Evidence | null) {
  if (!evidence) return;
  // Original evidence is immutable; a bounded backfill can fill a formerly
  // unavailable record, but cannot overwrite a previously verified payment.
  await db.insert(subscriptionReceipts).values({ subscriptionId, ...evidence }).onConflictDoNothing();
  if (!evidence.unavailableReason) {
    await db.update(subscriptionReceipts).set({ ...evidence, subscriptionId }).where(and(
      eq(subscriptionReceipts.provider, evidence.provider), eq(subscriptionReceipts.externalId, evidence.externalId),
      eq(subscriptionReceipts.kind, evidence.kind), isNotNull(subscriptionReceipts.unavailableReason),
    ));
  }
}
export async function ingestStripeInvoice(invoice: any, knownSubscriptionId?: string) {
  let id = knownSubscriptionId;
  if (!id) {
    const externalId = stripeSubscriptionId(invoice);
    if (!externalId) return;
    const [row] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, externalId));
    id = row?.id;
  }
  if (id) await persistSubscriptionEvidence(id, normalizeStripeReceipt(invoice));
}
export async function ingestRevenueCat(subscriptionId: string, event: any) {
  await persistSubscriptionEvidence(subscriptionId, normalizeRevenueCatReceipt(event));
}
export async function ingestStripeRefunds(stripe: any, charge: any) {
  if (charge.livemode !== true) return;
  let invoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
  if (!invoiceId && charge.payment_intent && stripe.invoicePayments?.list) {
    const payments = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id }, limit: 1 });
    invoiceId = payments.data[0]?.invoice;
    if (typeof invoiceId !== "string") invoiceId = invoiceId?.id;
  }
  if (!invoiceId) return; // Dental-case payment intents have no subscription invoice.
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const externalId = stripeSubscriptionId(invoice);
  if (!externalId) return;
  const [row] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, externalId));
  if (!row) return;
  await ingestStripeInvoice(invoice, row.id);
  const key = `subscription_refund_cursor:${charge.id}`;
  const [saved] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  const cursor: string | undefined = saved?.value || undefined;
  // Refund pages have their own durable IDs. Retry replays safely after an
  // interrupted webhook. Fail instead of silently truncating a large set.
  {
    const page = await stripe.refunds.list({ charge: charge.id, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    for (const refund of page.data) await persistSubscriptionEvidence(row.id, normalizeStripeRefund(refund, invoiceId));
    const nextCursor = page.has_more ? page.data.at(-1)?.id : "";
    if (page.has_more && (!nextCursor || nextCursor === cursor)) throw new Error("Stripe refund paging did not advance.");
    await db.insert(systemSettings).values({ key, value: nextCursor })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: nextCursor } });
    if (page.has_more) throw new Error("Subscription refund history has another bounded page; retry to resume.");
  }
}
