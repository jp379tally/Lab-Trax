import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const fixture = vi.hoisted(() => ({
  customer: {} as Record<string, unknown>,
}));
vi.mock("@workspace/db", () => ({
  providerPaymentCustomers: { id: "id", providerOrganizationId: "providerOrganizationId" },
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [fixture.customer] }) }) }),
    update: () => ({ set: (value: object) => ({ where: async () => { Object.assign(fixture.customer, value); } }) }),
  },
}));
import { cachedSharedCardSummary, refreshSharedCardSummary } from "./provider-shared-account";

function processor(owner = "cus_provider") {
  const mock = {
    customers: { retrieve: vi.fn(async () => ({ id: "cus_provider", invoice_settings: { default_payment_method: "pm_subscription_only" } })) },
    paymentMethods: { retrieve: vi.fn(async (id: string) => ({
      id, customer: owner, type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2040 },
      billing_details: {},
    })) },
  };
  return { mock, stripe: mock as unknown as Stripe };
}
beforeEach(() => {
  fixture.customer = {
    id: "mapping", providerOrganizationId: "practice", stripeCustomerId: "cus_provider",
    authorizedPaymentMethodId: "none", cardBrand: "visa", cardLast4: "9999",
    cardExpMonth: 12, cardExpYear: 2040, cardUpdatedAt: null,
  };
});
describe("authorized shared-card projection", () => {
  it("never exposes a subscription-only customer default without reuse consent", async () => {
    const { mock, stripe } = processor();
    expect(cachedSharedCardSummary(fixture.customer as unknown as Parameters<typeof cachedSharedCardSummary>[0])).toBeNull();
    expect((await refreshSharedCardSummary("practice", stripe)).card).toBeNull();
    expect(mock.paymentMethods.retrieve).not.toHaveBeenCalled();
  });
  it("preserves the explicitly authorized card when Checkout changes the customer default", async () => {
    fixture.customer.authorizedPaymentMethodId = "pm_authorized_lab";
    const { mock, stripe } = processor();
    expect((await refreshSharedCardSummary("practice", stripe)).card).toMatchObject({ brand: "visa", last4: "4242" });
    expect(mock.paymentMethods.retrieve).toHaveBeenCalledWith("pm_authorized_lab");
    expect(mock.paymentMethods.retrieve).not.toHaveBeenCalledWith("pm_subscription_only");
  });
  it("refuses an authorized method belonging to another Stripe customer", async () => {
    fixture.customer.authorizedPaymentMethodId = "pm_foreign";
    const { stripe } = processor("cus_foreign");
    expect((await refreshSharedCardSummary("practice", stripe)).card).toBeNull();
  });
  it("preserves pre-existing legacy customer-default authorization", async () => {
    fixture.customer.authorizedPaymentMethodId = null;
    const { mock, stripe } = processor();
    expect((await refreshSharedCardSummary("practice", stripe)).card?.last4).toBe("4242");
    expect(mock.paymentMethods.retrieve).toHaveBeenCalledWith("pm_subscription_only");
  });
});
