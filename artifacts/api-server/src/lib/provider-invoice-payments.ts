import { assertHistoricalInvoiceNotHeld } from "./historical-invoice-hold";
import { and, eq, inArray, isNull, sum, sql } from "drizzle-orm";
import {
  caseEvents,
  customerCreditApplications,
  db,
  invoices,
  notifications,
  organizationMemberships,
  organizations,
  payments,
  providerAutoPayAttempts,
  providerPaymentAllocations,
  providerPaymentCheckouts,
  providerPaymentCustomers,
} from "@workspace/db";
import { HttpError } from "./http";
import { getUncachableStripeClient } from "./stripeClient";
import { deliverProviderCheckoutPaymentNotifications } from "./payment-notifications";

const PAYABLE_INVOICE_STATUSES = new Set(["open", "partially_paid", "overdue"]);
const MONEY_EPSILON = 0.005;

export type ProviderPaymentAllocation = {
  invoiceId: string;
  amount: string;
};

export type ProviderPaymentCheckoutStatus =
  | "pending"
  | "succeeded"
  | "cancelled"
  | "expired"
  | "failed";

export type ProviderPaymentTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

function money(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

function amountString(value: number): string {
  return (cents(value) / 100).toFixed(2);
}

/**
 * Resolve the card that the provider explicitly confirmed for off-session
 * charges. The default must be a card on the provider payment customer; a
 * random saved card is not sufficient consent for auto-pay.
 */
export async function getProviderDefaultCard(
  providerOrganizationId: string,
  stripe: import("stripe").default,
): Promise<{
  stripeCustomerId: string;
  paymentMethodId: string;
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: number;
  cardExpYear: number;
} | null> {
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
  if (!customer) return null;

  const stripeCustomer = await stripe.customers.retrieve(customer.stripeCustomerId);
  if ("deleted" in stripeCustomer && stripeCustomer.deleted) return null;
  const defaultPaymentMethod =
    customer.authorizedPaymentMethodId ?? (typeof stripeCustomer.invoice_settings?.default_payment_method === "string"
      ? stripeCustomer.invoice_settings.default_payment_method
      : stripeCustomer.invoice_settings?.default_payment_method?.id ?? null);
  if (!defaultPaymentMethod || defaultPaymentMethod === "none") return null;

  const methods = await stripe.customers.listPaymentMethods(
    customer.stripeCustomerId,
    { type: "card" },
  );
  const method = methods.data.find((item) => item.id === defaultPaymentMethod);
  if (!method || method.type !== "card" || !method.card) return null;
  return {
    stripeCustomerId: customer.stripeCustomerId,
    paymentMethodId: method.id,
    cardBrand: method.card.brand,
    cardLast4: method.card.last4,
    cardExpMonth: method.card.exp_month,
    cardExpYear: method.card.exp_year,
  };
}

export async function createProviderAutoPayIntent(
  stripe: import("stripe").default,
  input: {
    providerOrganizationId: string;
    attemptId: string;
    providerPaymentCheckoutId?: string;
    stripeCustomerId: string;
    paymentMethodId: string;
    amountCents: number;
    description: string;
  },
): Promise<import("stripe").default.PaymentIntent> {
  return stripe.paymentIntents.create(
    {
      amount: input.amountCents,
      currency: "usd",
      customer: input.stripeCustomerId,
      payment_method: input.paymentMethodId,
      confirm: true,
      off_session: true,
      description: input.description,
      metadata: {
        providerAutoPayAttemptId: input.attemptId,
        providerOrganizationId: input.providerOrganizationId,
        ...(input.providerPaymentCheckoutId
          ? { providerPaymentCheckoutId: input.providerPaymentCheckoutId }
          : {}),
      },
    },
    { idempotencyKey: `provider-auto-pay-${input.attemptId}` },
  );
}

export async function completeProviderAutoPayAttempt(input: {
  attemptId: string;
  status: "succeeded" | "failed" | "skipped";
  amount?: number;
  stripePaymentIntentId?: string | null;
  failureReason?: string | null;
}) {
  const recoverableStatuses = input.status === "succeeded"
    ? ["processing", "failed", "skipped"] as const
    : ["processing", "failed"] as const;
  await db.transaction(async (tx) => {
    const [attempt] = await tx
      .update(providerAutoPayAttempts)
      .set({
        ...(input.amount === undefined
          ? {}
          : { amount: amountString(input.amount) }),
        status: input.status,
        stripePaymentIntentId: input.stripePaymentIntentId ?? undefined,
        failureReason: input.failureReason ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerAutoPayAttempts.id, input.attemptId),
          // A success callback is authoritative even if a worker marked an
          // ambiguous outcome failed or skipped before confirmation arrived.
          inArray(providerAutoPayAttempts.status, recoverableStatuses),
        ),
      )
      .returning();
    if (!attempt) return;

    const [organization] = await tx
      .select({
        name: organizations.name,
        displayName: organizations.displayName,
      })
      .from(organizations)
      .where(eq(organizations.id, attempt.providerOrganizationId))
      .limit(1);
    const recipients = await tx
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(
            organizationMemberships.labId,
            attempt.providerOrganizationId,
          ),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
        ),
      );
    if (recipients.length === 0) return;

    const providerName =
      organization?.displayName ??
      organization?.name ??
      "Your provider account";
    const kind = attempt.kind === "subscription" ? "subscription" : "invoice";
    const subject =
      kind === "subscription" ? "Subscription auto-pay" : "Invoice auto-pay";
    const amount = money(attempt.amount);
    const body =
      input.status === "succeeded"
        ? `${subject} charged $${amount.toFixed(2)} on ${providerName}.`
        : input.status === "skipped"
          ? `${subject} skipped because there was no balance due on ${providerName}.`
          : `${subject} could not charge the shared card for ${providerName}. No automatic retry will be made.`;
    await tx.insert(notifications).values(
      recipients.map(({ userId }) => ({
        userId,
        type: "provider_auto_pay_result",
        title: `${subject} ${input.status === "succeeded" ? "succeeded" : input.status === "skipped" ? "skipped" : "failed"}`,
        body,
        dataJson: {
          providerOrganizationId: attempt.providerOrganizationId,
          kind,
          scheduledFor: attempt.scheduledFor.toISOString(),
          amount: amount.toFixed(2),
          status: input.status,
          autoPayAttemptId: attempt.id,
          failureReason: input.failureReason ?? null,
        },
      })),
    );
  });
}

export async function markProviderPaymentCheckoutFailed(
  checkoutId: string,
  status: Extract<ProviderPaymentCheckoutStatus, "cancelled" | "expired" | "failed">,
  reason: string,
  processorPaymentIntentId?: string | null,
) {
  await db
    .update(providerPaymentCheckouts)
    .set({
      status,
      failureReason: reason,
      stripePaymentIntentId: processorPaymentIntentId ?? undefined,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerPaymentCheckouts.id, checkoutId),
        eq(providerPaymentCheckouts.status, "pending"),
      ),
    );
}

/**
 * Apply one confirmed Stripe payment exactly once. The checkout attempt row is
 * locked before any invoice or payment rows are written, making duplicate
 * webhook deliveries and return-link retries harmless.
 */
export async function settleProviderPaymentCheckoutInTransaction(
  tx: ProviderPaymentTransaction,
  checkoutId: string,
  processorPaymentIntentId: string | null,
  processorChargeId: string | null = null,
): Promise<{ status: ProviderPaymentCheckoutStatus; alreadySettled?: boolean }> {
    const [checkout] = await tx
      .select()
      .from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, checkoutId))
      .for("update");

    if (!checkout) throw new HttpError(404, "Payment checkout not found.");
    if (checkout.status === "succeeded") {
      return { status: "succeeded", alreadySettled: true };
    }
    if (checkout.status !== "pending") {
      return { status: checkout.status as ProviderPaymentCheckoutStatus };
    }
    if (!processorPaymentIntentId) {
      throw new HttpError(400, "Stripe did not provide a payment intent.");
    }

    const allocations = await tx
      .select()
      .from(providerPaymentAllocations)
      .where(eq(providerPaymentAllocations.checkoutId, checkoutId));
    if (allocations.length === 0) {
      throw new HttpError(400, "Payment checkout has no invoice allocations.");
    }

    const invoiceRows: Array<typeof invoices.$inferSelect> = [];
    for (const allocation of allocations) {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, allocation.invoiceId),
            eq(invoices.providerOrganizationId, checkout.providerOrganizationId),
            isNull(invoices.deletedAt),
          ),
        )
        .for("update");
      if (!invoice) {
        throw new HttpError(409, "An allocated invoice is no longer available.");
      }
      assertHistoricalInvoiceNotHeld(invoice);
      if (!PAYABLE_INVOICE_STATUSES.has(invoice.status)) {
        throw new HttpError(409, "An allocated invoice can no longer accept payment.");
      }
      if (money(allocation.amount) > money(invoice.balanceDue) + MONEY_EPSILON) {
        throw new HttpError(409, "An allocated invoice balance changed before settlement.");
      }
      invoiceRows.push(invoice);
    }

    for (let index = 0; index < allocations.length; index += 1) {
      const allocation = allocations[index]!;
      const invoice = invoiceRows[index]!;
      const appliedAmount = money(allocation.amount);

      const [payment] = await tx
        .insert(payments)
        .values({
          invoiceId: invoice.id,
          amount: amountString(appliedAmount),
          paymentMethod: "card",
          referenceNumber: processorPaymentIntentId,
          stripePaymentIntentId: processorPaymentIntentId,
          providerPaymentCheckoutId: checkout.id,
          recordedByUserId: checkout.initiatedByUserId,
        })
        .returning();

      const paidRows = await tx
        .select({ value: sum(payments.amount) })
        .from(payments)
        .where(eq(payments.invoiceId, invoice.id));
      const totalPaid = money(paidRows[0]?.value);
      const creditRows = await tx
        .select({ amount: customerCreditApplications.amount })
        .from(customerCreditApplications)
        .where(eq(customerCreditApplications.invoiceId, invoice.id));
      const totalCredits = creditRows.reduce(
        (total, row) => total + Number(row.amount),
        0,
      );
      const balanceDue = Math.max(
        0,
        money(Number(invoice.total) - Number(totalPaid) - totalCredits),
      );
      const status = balanceDue < MONEY_EPSILON ? "paid" : "partially_paid";

      await tx
        .update(invoices)
        .set({
          balanceDue: balanceDue.toFixed(2),
          status,
          updatedByUserId: checkout.initiatedByUserId,
        })
        .where(eq(invoices.id, invoice.id));

      if (invoice.caseId) {
        await tx.insert(caseEvents).values({
          caseId: invoice.caseId,
          eventType: "payment_received",
          actorUserId: checkout.initiatedByUserId,
          actorOrganizationId: invoice.labOrganizationId,
          actorInitials: "PRV",
          metadataJson: {
            invoiceId: invoice.id,
            paymentId: payment.id,
            amount: payment.amount,
            provider: true,
            processor: "stripe",
            checkoutId: checkout.id,
          },
        });
      }

    }

    await tx
      .update(providerPaymentCheckouts)
      .set({
        status: "succeeded",
        stripePaymentIntentId: processorPaymentIntentId,
        stripeChargeId: processorChargeId,
        failureReason: null,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(providerPaymentCheckouts.id, checkout.id));

    return { status: "succeeded" };
}

/**
 * Hold invoice row locks from the last balance validation until both Stripe
 * confirmation and local settlement complete. This prevents a concurrent
 * manual payment from changing the balance after the card has been charged.
 * The checkout metadata also lets the Stripe webhook finish settlement if the
 * scheduler process dies after Stripe accepts the charge.
 */
export async function chargeProviderAutoPayCheckout(
  stripe: import("stripe").default,
  input: {
    checkoutId: string;
    providerOrganizationId: string;
    attemptId: string;
    stripeCustomerId: string;
    paymentMethodId: string;
    amountCents: number;
  },
): Promise<import("stripe").default.PaymentIntent> {
  const paymentIntent = await db.transaction(async (tx) => {
    const [checkout] = await tx
      .select()
      .from(providerPaymentCheckouts)
      .where(eq(providerPaymentCheckouts.id, input.checkoutId))
      .for("update");
    if (
      !checkout ||
      checkout.status !== "pending" ||
      checkout.providerOrganizationId !== input.providerOrganizationId
    ) {
      throw new HttpError(409, "Payment checkout is no longer chargeable.");
    }
    const allocations = await tx
      .select()
      .from(providerPaymentAllocations)
      .where(eq(providerPaymentAllocations.checkoutId, input.checkoutId));
    if (allocations.length === 0) {
      throw new HttpError(409, "Payment checkout has no invoice allocations.");
    }
    const allocationCents = allocations.reduce(
      (total, allocation) => total + Math.round(money(allocation.amount) * 100),
      0,
    );
    const checkoutCents = Math.round(money(checkout.totalAmount) * 100);
    if (input.amountCents !== allocationCents || checkoutCents !== allocationCents) {
      throw new HttpError(409, "Payment amount no longer matches invoice allocations.");
    }
    for (const allocation of allocations) {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, allocation.invoiceId),
            eq(invoices.providerOrganizationId, input.providerOrganizationId),
            isNull(invoices.deletedAt),
          ),
        )
        .for("update");
      if (
        !invoice ||
        !PAYABLE_INVOICE_STATUSES.has(invoice.status) ||
        money(allocation.amount) > money(invoice.balanceDue) + MONEY_EPSILON
      ) {
        throw new HttpError(
          409,
          "An allocated invoice balance changed before the card charge.",
        );
      }
      assertHistoricalInvoiceNotHeld(invoice);
    }

    const paymentIntent = await createProviderAutoPayIntent(stripe, {
      providerOrganizationId: input.providerOrganizationId,
      attemptId: input.attemptId,
      providerPaymentCheckoutId: input.checkoutId,
      stripeCustomerId: input.stripeCustomerId,
      paymentMethodId: input.paymentMethodId,
      amountCents: input.amountCents,
      description: "LabTrax provider invoice auto-pay",
    });
    if (paymentIntent.status !== "succeeded") {
      throw new Error(`stripe_${paymentIntent.status}`);
    }
    await settleProviderPaymentCheckoutInTransaction(
      tx,
      input.checkoutId,
      paymentIntent.id,
      typeof paymentIntent.latest_charge === "string"
        ? paymentIntent.latest_charge
        : paymentIntent.latest_charge?.id ?? null,
    );
    return paymentIntent;
  });
  await deliverProviderCheckoutPaymentNotifications(input.checkoutId);
  return paymentIntent;
}

export async function settleProviderPaymentCheckout(
  checkoutId: string,
  processorPaymentIntentId: string | null,
  processorChargeId: string | null = null,
  lockAlreadyHeld = false,
): Promise<{ status: ProviderPaymentCheckoutStatus; alreadySettled?: boolean }> {
  let labOrganizationId: string | undefined;
  if (!lockAlreadyHeld) {
    const [scope] = await db
      .select({ labId: invoices.labOrganizationId })
      .from(providerPaymentCheckouts)
      .innerJoin(providerPaymentAllocations, eq(providerPaymentAllocations.checkoutId, providerPaymentCheckouts.id))
      .innerJoin(invoices, eq(invoices.id, providerPaymentAllocations.invoiceId))
      .where(eq(providerPaymentCheckouts.id, checkoutId))
      .limit(1);
    if (!scope) throw new HttpError(404, "Provider payment checkout not found.");
    labOrganizationId = scope.labId;
  }
  const result = await db.transaction((tx) =>
    (async () => {
      if (!lockAlreadyHeld) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(
          hashtext(${labOrganizationId}), hashtext((
            SELECT provider_organization_id FROM provider_payment_checkouts WHERE id = ${checkoutId}
          ))
        )`);
      }
      return settleProviderPaymentCheckoutInTransaction(
        tx,
        checkoutId,
        processorPaymentIntentId,
        processorChargeId,
      );
    })(),
  );
  if (result.status === "succeeded") {
    await deliverProviderCheckoutPaymentNotifications(checkoutId);
  }
  if (result.status === "succeeded" && processorPaymentIntentId) {
    try {
      const [checkout] = await db
        .select()
        .from(providerPaymentCheckouts)
        .where(eq(providerPaymentCheckouts.id, checkoutId))
        .limit(1);
      if (checkout?.savePaymentMethod) {
        const [customer] = await db
          .select()
          .from(providerPaymentCustomers)
          .where(
            eq(
              providerPaymentCustomers.providerOrganizationId,
              checkout.providerOrganizationId,
            ),
          )
          .limit(1);
        const stripe = await getUncachableStripeClient();
        if (customer && stripe) {
          const paymentIntent =
            await stripe.paymentIntents.retrieve(processorPaymentIntentId);
          const paymentMethodId =
            typeof paymentIntent.payment_method === "string"
              ? paymentIntent.payment_method
              : paymentIntent.payment_method?.id;
          if (paymentMethodId) {
            await stripe.customers.update(customer.stripeCustomerId, {
              invoice_settings: { default_payment_method: paymentMethodId },
            });
            await db.update(providerPaymentCustomers).set({ authorizedPaymentMethodId: paymentMethodId })
              .where(eq(providerPaymentCustomers.providerOrganizationId, checkout.providerOrganizationId));
          }
        }
      }
    } catch {
      // Settlement is authoritative and must never be rolled back by a
      // secondary card-preference update. A later setup flow can replace it.
    }
  }
  return result;
}