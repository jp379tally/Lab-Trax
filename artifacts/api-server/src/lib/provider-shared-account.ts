import { eq } from "drizzle-orm";
import { db, providerPaymentCustomers } from "@workspace/db";

export type SharedCardSummary = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  status: "active" | "expired";
  updatedAt: string | null;
  source: "processor";
  billingAddress: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
};

type ProviderPaymentCustomer =
  typeof providerPaymentCustomers.$inferSelect;

function statusForExpiration(expMonth: number, expYear: number): "active" | "expired" {
  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const currentYear = now.getUTCFullYear();
  return expYear < currentYear || (expYear === currentYear && expMonth < currentMonth)
    ? "expired"
    : "active";
}

export function cachedSharedCardSummary(
  customer: ProviderPaymentCustomer | null | undefined,
): SharedCardSummary | null {
  if (
    customer?.authorizedPaymentMethodId === "none" ||
    !customer?.cardBrand ||
    !customer.cardLast4 ||
    customer.cardExpMonth == null ||
    customer.cardExpYear == null
  ) {
    return null;
  }
  return {
    brand: customer.cardBrand,
    last4: customer.cardLast4,
    expMonth: customer.cardExpMonth,
    expYear: customer.cardExpYear,
    status:
      customer.cardStatus === "expired"
        ? "expired"
        : statusForExpiration(customer.cardExpMonth, customer.cardExpYear),
    updatedAt: customer.cardUpdatedAt?.toISOString() ?? null,
    source: "processor",
    billingAddress: customer.cardBillingAddressJson as SharedCardSummary["billingAddress"],
  };
}

export async function getCachedSharedCardSummary(
  providerOrganizationId: string,
): Promise<SharedCardSummary | null> {
  const [customer] = await db
    .select()
    .from(providerPaymentCustomers)
    .where(
      eq(
        providerPaymentCustomers.providerOrganizationId,
        providerOrganizationId,
      ),
    )
    .limit(1);
  return cachedSharedCardSummary(customer);
}

export async function refreshSharedCardSummary(
  providerOrganizationId: string,
  stripe: import("stripe").default,
): Promise<{
  card: SharedCardSummary | null;
  changed: boolean;
  previous: SharedCardSummary | null;
}> {
  const [customer] = await db
    .select()
    .from(providerPaymentCustomers)
    .where(
      eq(
        providerPaymentCustomers.providerOrganizationId,
        providerOrganizationId,
      ),
    )
    .limit(1);
  if (!customer) return { card: null, changed: false, previous: null };

  const previous = cachedSharedCardSummary(customer);
  const clearCard = async () => {
    const changed = previous !== null;
    if (changed) {
      await db
        .update(providerPaymentCustomers)
        .set({
          cardBrand: null,
          cardLast4: null,
          cardExpMonth: null,
          cardExpYear: null,
          cardStatus: null,
          cardBillingAddressJson: null,
          cardUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerPaymentCustomers.id, customer.id));
    }
    return { card: null, changed, previous };
  };
  const stripeCustomer = await stripe.customers.retrieve(customer.stripeCustomerId);
  if ("deleted" in stripeCustomer && stripeCustomer.deleted) {
    return clearCard();
  }

  const defaultPaymentMethod =
    customer.authorizedPaymentMethodId ?? (typeof stripeCustomer.invoice_settings.default_payment_method === "string"
      ? stripeCustomer.invoice_settings.default_payment_method
      : stripeCustomer.invoice_settings.default_payment_method?.id);
  if (!defaultPaymentMethod || defaultPaymentMethod === "none") {
    return clearCard();
  }

  const paymentMethod = await stripe.paymentMethods.retrieve(defaultPaymentMethod);
  const paymentMethodCustomer =
    typeof paymentMethod.customer === "string"
      ? paymentMethod.customer
      : paymentMethod.customer?.id ?? null;
  if (
    paymentMethod.type !== "card" ||
    !paymentMethod.card ||
    paymentMethodCustomer !== customer.stripeCustomerId
  ) {
    return clearCard();
  }

  const now = new Date();
  const next: SharedCardSummary = {
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
    status: statusForExpiration(
      paymentMethod.card.exp_month,
      paymentMethod.card.exp_year,
    ),
    updatedAt: now.toISOString(),
    source: "processor",
    billingAddress: paymentMethod.billing_details?.address
      ? {
          line1: paymentMethod.billing_details.address.line1 ?? null,
          line2: paymentMethod.billing_details.address.line2 ?? null,
          city: paymentMethod.billing_details.address.city ?? null,
          state: paymentMethod.billing_details.address.state ?? null,
          postalCode: paymentMethod.billing_details.address.postal_code ?? null,
          country: paymentMethod.billing_details.address.country ?? null,
        }
      : null,
  };
  let changed =
    !previous ||
    previous.brand !== next.brand ||
    previous.last4 !== next.last4 ||
    previous.expMonth !== next.expMonth ||
    previous.expYear !== next.expYear ||
    previous.status !== next.status;
  // Address is intentionally a field-level safe summary, not raw Stripe data.
  const addressChanged =
    JSON.stringify(previous?.billingAddress ?? null) !== JSON.stringify(next.billingAddress);
  if (addressChanged) {
    changed = true;
  }
  if (changed) {
    await db
      .update(providerPaymentCustomers)
      .set({
        cardBrand: next.brand,
        cardLast4: next.last4,
        cardExpMonth: next.expMonth,
        cardExpYear: next.expYear,
        cardStatus: next.status,
          cardBillingAddressJson: next.billingAddress,
        cardUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(providerPaymentCustomers.id, customer.id));
  }
  return {
    card: changed ? next : previous,
    changed,
    previous,
  };
}