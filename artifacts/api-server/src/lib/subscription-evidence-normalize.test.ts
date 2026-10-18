import { describe, expect, it } from "vitest";
import { normalizeRevenueCatReceipt, normalizeStripeReceipt, normalizeStripeRefund, stripeSubscriptionId } from "./subscription-evidence-normalize";
import { canonicalDirectory, subscriptionSummary } from "./subscription-summary";

const paidInvoice = { id: "in_annual", livemode: true, status: "paid", amount_paid: 120000, currency: "usd",
  status_transitions: { paid_at: 1780272000 }, lines: { data: [{ period: { start: 1780272000, end: 1811808000 } }] } };
describe("Actual subscription payment evidence", () => {
  it("records the full annual receipt on the payment date, not fictional monthly revenue", () => {
    const receipt = normalizeStripeReceipt(paidInvoice)!;
    expect(receipt.amountMinor).toBe(120000);
    expect(receipt.currency).toBe("USD");
    expect(receipt.occurredAt?.getTime()).toBe(1780272000 * 1000);
  });
  it.each([{ livemode: false }, { status: "open" }, { status: "uncollectible" }, { paid_out_of_band: true }, { amount_paid: 0 }])("excludes test, pending, failed, waived/free and out-of-band invoices %j", change => {
    expect(normalizeStripeReceipt({ ...paidInvoice, ...change })).toBeNull();
  });
  it("keeps missing amounts unavailable, never a complete zero", () => {
    expect(normalizeStripeReceipt({ ...paidInvoice, amount_paid: undefined })?.unavailableReason).toBeTruthy();
    expect(normalizeStripeReceipt({ ...paidInvoice, status_transitions: {} })?.occurredAt).toBeNull();
  });
  it("uses durable invoice and transaction IDs, not delivery event IDs", () => {
    expect(normalizeStripeReceipt(paidInvoice)?.externalId).toBe("in_annual");
    expect(stripeSubscriptionId({ parent: { subscription_details: { subscription: "sub_modern" } } })).toBe("sub_modern");
    const base = { type: "RENEWAL", transaction_id: "txn", environment: "PRODUCTION", currency: "EUR", price_in_purchased_currency: 12.34, purchased_at_ms: 1780272000000 };
    expect(normalizeRevenueCatReceipt({ ...base, id: "delivery-1" })?.externalId).toBe(normalizeRevenueCatReceipt({ ...base, id: "delivery-2" })?.externalId);
    expect(normalizeRevenueCatReceipt(base)?.amountMinor).toBe(1234);
  });
  it("does not convert RevenueCat's USD estimate or infer fees from commission", () => {
    const event = { type: "RENEWAL", transaction_id: "txn", environment: "PRODUCTION", currency: "JPY", price_in_purchased_currency: 1500, price: 10, takehome_percentage: 0.7, purchased_at_ms: 1780272000000 };
    expect(normalizeRevenueCatReceipt(event)?.amountMinor).toBe(1500);
    expect(normalizeRevenueCatReceipt({ ...event, price_in_purchased_currency: undefined })?.amountMinor).toBeNull();
    expect(normalizeRevenueCatReceipt({ ...event, environment: "SANDBOX" })).toBeNull();
  });
  it("records only confirmed refunds dated at the adjustment, with currency and parent identity", () => {
    const refund = { id: "re_1", status: "succeeded", amount: 2500, currency: "eur", created: 1780358400 };
    expect(normalizeStripeRefund(refund, "in_1")).toMatchObject({ externalId: "re_1", parentExternalId: "in_1", amountMinor: 2500, kind: "refund", currency: "EUR" });
    expect(normalizeStripeRefund({ ...refund, status: "pending" }, "in_1")).toBeNull();
  });
});
describe("Full-set canonical subscription summaries", () => {
  it("prefers canonical rows, excludes status-only active rows from paid, and counts beyond a page", () => {
    const rows = Array.from({ length: 151 }, (_, n) => ({ id: `s${n}`, subjectType: "provider_org", canonicalSubjectType: "provider_org", canonicalSubjectId: `p${n}`, status: "active", provider: "stripe", waiverActive: false }));
    rows.unshift({ ...rows[0]!, id: "legacy", subjectType: "provider_user", status: "trialing" });
    const directory = canonicalDirectory(rows);
    expect(directory).toHaveLength(151);
    expect(directory[0]?.id).toBe("s0");
    expect(subscriptionSummary(directory, new Set(["s0", "s150"]))).toMatchObject({ totalAccounts: 151, paidSubscribers: 2, other: 149, byStatus: { active: 151 } });
  });
  it("waiver/trial/free categories are distinct from confirmed positive current coverage", () => {
    const rows = ["active", "trialing", "legacy_free", "deactivated"].map((status, n) => ({ id: `s${n}`, subjectType: "lab_org", canonicalSubjectType: "lab_org", canonicalSubjectId: `l${n}`, provider: "none", status, waiverActive: n === 0 }));
    expect(subscriptionSummary(rows, new Set(["s0"]))).toMatchObject({ paidSubscribers: 0, trial: 1, free: 1, waived: 1, other: 1 });
  });
});
