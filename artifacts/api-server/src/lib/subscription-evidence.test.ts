import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  receipts: new Map<string, any>(), cursor: "", found: true, updated: [] as any[],
}));
vi.mock("@workspace/db", async original => {
  const actual: any = await original();
  return { ...actual, db: {
    select: () => ({ from: (table: any) => ({ where: async () => table === actual.systemSettings ? state.cursor ? [{ value: state.cursor }] : [] : state.found ? [{ id: "account" }] : [] }) }),
    insert: (table: any) => ({ values: (values: any) => ({
      onConflictDoNothing: async () => {
        const key = `${values.provider}:${values.externalId}:${values.kind}`;
        if (!state.receipts.has(key)) state.receipts.set(key, values);
      },
      onConflictDoUpdate: async () => { if (table === actual.systemSettings) state.cursor = values.value; },
    }) }),
    update: () => ({ set: (value: any) => ({ where: async (condition: any) => { state.updated.push({ value, condition }); } }) }),
  } };
});
import { ingestStripeInvoice, ingestStripeRefunds, ingestRevenueCat } from "./subscription-evidence";
const invoice = { id: "in_1", subscription: "sub_1", livemode: true, status: "paid", amount_paid: 5000, currency: "usd", status_transitions: { paid_at: 1780272000 } };
describe("Idempotent evidence ingestion and exclusions", () => {
  beforeEach(() => { state.receipts.clear(); state.cursor = ""; state.found = true; state.updated = []; });
  it("deduplicates delivery/reconciliation and multiple refund adjustments by durable payment identity", async () => {
    const refunds = [{ id: "re_1", status: "succeeded", amount: 500, currency: "usd", created: 1780358400 },
      { id: "re_2", status: "succeeded", amount: 250, currency: "usd", created: 1780444800 }];
    const stripe = { invoices: { retrieve: vi.fn(async () => invoice) }, refunds: { list: vi.fn(async () => ({ data: refunds, has_more: false })) } };
    await ingestStripeInvoice(invoice); await ingestStripeInvoice(invoice, "account");
    await ingestStripeRefunds(stripe, { id: "ch_1", livemode: true, invoice: "in_1" });
    await ingestStripeRefunds(stripe, { id: "ch_1", livemode: true, invoice: "in_1" });
    expect(state.receipts.size).toBe(3);
    expect([...state.receipts.values()].filter(r => r.kind === "refund").reduce((n, r) => n + r.amountMinor, 0)).toBe(750);
  });
  it("never counts dental-case charges or unlinked provider accounts", async () => {
    const stripe = { invoices: { retrieve: vi.fn(async () => ({ ...invoice, subscription: null })) }, refunds: { list: vi.fn() } };
    await ingestStripeRefunds(stripe, { id: "ch_case", livemode: true, invoice: "in_case" });
    expect(stripe.refunds.list).not.toHaveBeenCalled();
    state.found = false; await ingestStripeInvoice(invoice);
    expect(state.receipts.size).toBe(0);
  });
  it("resumes bounded refund pages after interruption with duplicate-safe evidence", async () => {
    const first = { id: "re_1", status: "succeeded", amount: 500, currency: "usd", created: 1780358400 };
    const list = vi.fn().mockResolvedValueOnce({ data: [first], has_more: true })
      .mockResolvedValueOnce({ data: [{ ...first, id: "re_2" }], has_more: false });
    const stripe = { invoices: { retrieve: vi.fn(async () => invoice) }, refunds: { list } };
    await expect(ingestStripeRefunds(stripe, { id: "ch_1", livemode: true, invoice: "in_1" })).rejects.toThrow("bounded page");
    expect(state.cursor).toBe("re_1");
    await ingestStripeRefunds(stripe, { id: "ch_1", livemode: true, invoice: "in_1" });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ starting_after: "re_1", limit: 100 });
    expect(state.receipts.size).toBe(3);
    expect(state.cursor).toBe("");
  });
  it("deduplicates RevenueCat renewal and refund identity without mixing event deliveries", async () => {
    const event = { environment: "PRODUCTION", type: "RENEWAL", transaction_id: "txn_1", currency: "EUR", price_in_purchased_currency: 30, purchased_at_ms: 1780272000000 };
    await ingestRevenueCat("account", event); await ingestRevenueCat("account", { ...event, id: "redelivery" });
    await ingestRevenueCat("account", { ...event, type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", event_timestamp_ms: 1780358400000 });
    expect(state.receipts.size).toBe(2);
    expect(state.receipts.get("revenuecat:txn_1:refund").amountMinor).toBe(3000);
  });
});
