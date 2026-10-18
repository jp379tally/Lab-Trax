export type Evidence = {
  provider: "stripe" | "revenuecat";
  externalId: string;
  kind: "receipt" | "refund";
  parentExternalId?: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: Date | null;
  coverageStartsAt?: Date | null;
  coverageEndsAt?: Date | null;
  unavailableReason: string | null;
};
function instant(seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}
export function stripeSubscriptionId(invoice: any): string | null {
  const value = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
  return typeof value === "string" ? value : value?.id ?? null;
}
export function normalizeStripeReceipt(invoice: any): Evidence | null {
  if (invoice.livemode !== true || invoice.status !== "paid" || invoice.paid_out_of_band === true || !invoice.id) return null;
  if (invoice.amount_paid === 0) return null;
  const amount = Number.isSafeInteger(invoice.amount_paid) && invoice.amount_paid > 0 ? invoice.amount_paid : null;
  const currency = typeof invoice.currency === "string" && /^[a-z]{3}$/i.test(invoice.currency) ? invoice.currency.toUpperCase() : null;
  const occurredAt = instant(invoice.status_transitions?.paid_at);
  const period = invoice.lines?.data?.find((line: any) => line.type === "subscription" || line.parent?.type === "subscription_item_details")?.period
    ?? invoice.lines?.data?.[0]?.period;
  return {
    provider: "stripe", externalId: invoice.id, kind: "receipt", amountMinor: amount, currency, occurredAt,
    coverageStartsAt: instant(period?.start), coverageEndsAt: instant(period?.end),
    unavailableReason: amount === null || !currency || !occurredAt ? "Original payment amount, currency or payment timestamp unavailable." : null,
  };
}
export function normalizeStripeRefund(refund: any, invoiceId: string): Evidence | null {
  if (refund.status !== "succeeded" || !refund.id || !Number.isSafeInteger(refund.amount) || refund.amount <= 0) return null;
  const currency = typeof refund.currency === "string" ? refund.currency.toUpperCase() : null;
  const occurredAt = instant(refund.created);
  return { provider: "stripe", externalId: refund.id, parentExternalId: invoiceId, kind: "refund", amountMinor: refund.amount, currency, occurredAt,
    unavailableReason: !currency || !occurredAt ? "Refund currency or timestamp unavailable." : null };
}
// RevenueCat price_in_purchased_currency is gross paid, NOT price (USD), takehome
// percentage or commission. Never silently convert currencies.
export function normalizeRevenueCatReceipt(event: any): Evidence | null {
  if (event.environment !== "PRODUCTION") return null;
  const refund = event.type === "CANCELLATION" && event.cancel_reason === "CUSTOMER_SUPPORT";
  if (!refund && !["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"].includes(event.type)) return null;
  if (event.period_type === "TRIAL" || event.price_in_purchased_currency === 0) return null;
  const transactionId = event.transaction_id;
  if (typeof transactionId !== "string" || !transactionId) return null;
  const currency = typeof event.currency === "string" && /^[A-Z]{3}$/.test(event.currency) ? event.currency : null;
  let amount: number | null = null;
  if (currency && typeof event.price_in_purchased_currency === "number" && event.price_in_purchased_currency > 0) {
    try {
      const exponent = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
      const minor = Math.round(event.price_in_purchased_currency * 10 ** exponent);
      if (Number.isSafeInteger(minor) && minor > 0) amount = minor;
    } catch { /* invalid currency is unavailable, not USD */ }
  }
  const occurredAt = instant((refund ? event.event_timestamp_ms : event.purchased_at_ms) / 1000);
  return { provider: "revenuecat", externalId: transactionId, kind: refund ? "refund" : "receipt",
    parentExternalId: refund ? transactionId : null, amountMinor: amount, currency, occurredAt,
    coverageStartsAt: instant(event.purchased_at_ms / 1000), coverageEndsAt: instant(event.expiration_at_ms / 1000),
    unavailableReason: amount === null || !currency || !occurredAt ? "Original purchased-currency amount or timestamp unavailable." : null };
}
