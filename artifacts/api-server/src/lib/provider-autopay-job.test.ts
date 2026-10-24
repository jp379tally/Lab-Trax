import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

const {
  paymentIntentCreate,
  listPaymentMethods,
  invoicesList,
  invoicesPay,
  subscriptionsUpdate,
} = vi.hoisted(() => ({
  paymentIntentCreate: vi.fn(),
  listPaymentMethods: vi.fn(),
  invoicesList: vi.fn(),
  invoicesPay: vi.fn(),
  subscriptionsUpdate: vi.fn(),
}));

vi.mock("./stripeClient.js", () => ({
  getUncachableStripeClient: vi.fn().mockResolvedValue({
    customers: {
      retrieve: vi.fn().mockResolvedValue({
        id: "cus_shared",
        invoice_settings: { default_payment_method: "pm_shared" },
      }),
      /*
       * The default live Stripe card matches the cached card and signed
       * authorization. Individual tests replace this response to verify that
       * a changed Stripe default cannot be charged.
       */
      listPaymentMethods,
      update: vi.fn(),
    },
    invoices: {
      list: invoicesList,
      pay: invoicesPay,
      update: vi.fn().mockResolvedValue({
        id: "in_subscription",
      }),
    },
    prices: {
      retrieve: vi.fn().mockResolvedValue({ id: "price_provider", unit_amount: 2500 }),
    },
    subscriptions: {
      retrieve: vi.fn(),
      update: subscriptionsUpdate,
    },
    paymentIntents: {
      create: paymentIntentCreate,
      retrieve: vi.fn(),
    },
  }),
}));

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

maybe("provider auto-pay scheduler (db integration)", () => {
  type DbModule = typeof import("@workspace/db");
  let db: DbModule["db"];
  let tables: DbModule;
  let userId: string;
  let labOrganizationId: string;
  let providerOrganizationId: string;
  let invoiceId: string;
  let authorizationId: string;

  async function deleteAuthorizationFixture(id: string) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx
        .delete(tables.providerAutopayAuthorizationLabs)
        .where(eq(tables.providerAutopayAuthorizationLabs.authorizationId, id));
      await tx
        .delete(tables.providerAutopayAuthorizations)
        .where(eq(tables.providerAutopayAuthorizations.id, id));
    });
  }

  beforeEach(async () => {
    tables = await import("@workspace/db");
    db = tables.db;
    paymentIntentCreate.mockReset();
    invoicesPay.mockReset();
    invoicesPay.mockResolvedValue({ id: "in_subscription", status: "paid" });
    invoicesList.mockReset();
    subscriptionsUpdate.mockReset();
    subscriptionsUpdate.mockResolvedValue({ id: "sub_provider" });
    invoicesList.mockResolvedValue({
      data: [{
        id: "in_subscription",
        customer: "cus_shared",
        amount_remaining: 2500,
        status: "open",
      }],
    });
    listPaymentMethods.mockReset();
    listPaymentMethods.mockResolvedValue({
      data: [{
        id: "pm_shared",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
      }],
    });

    [userId] = (
      await db
        .insert(tables.users)
        .values({
          username: rid("autopay_user"),
          password: "not-used",
          email: `${rid("autopay")}@example.com`,
          userType: "provider",
        })
        .returning({ id: tables.users.id })
    ).map((row) => row.id);
    [labOrganizationId] = (
      await db
        .insert(tables.organizations)
        .values({ type: "lab", name: rid("AutoPay Lab") })
        .returning({ id: tables.organizations.id })
    ).map((row) => row.id);
    [providerOrganizationId] = (
      await db
        .insert(tables.organizations)
        .values({
          type: "provider",
          name: rid("AutoPay Provider"),
          parentLabOrganizationId: labOrganizationId,
        })
        .returning({ id: tables.organizations.id })
    ).map((row) => row.id);

    await db.insert(tables.organizationMemberships).values([
      {
        labId: providerOrganizationId,
        userId,
        role: "user",
        status: "active",
      },
      {
        labId: labOrganizationId,
        userId,
        role: "billing",
        status: "active",
      },
    ]);
    await db.insert(tables.providerPaymentCustomers).values({
      providerOrganizationId,
      stripeCustomerId: "cus_shared",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2030,
      cardStatus: "active",
      invoiceAutoPayEnabled: true,
      invoiceAutoPayChargeDay: 7,
    });
    authorizationId = rid("autopay_auth");
    await db.insert(tables.providerAutopayAuthorizations).values({
      id: authorizationId,
      providerOrganizationId,
      agreementVersion: "2025-01",
      agreementText: "Test authorization",
      agreementSha256: "a".repeat(64),
      subscriptionFees: true,
      labBills: true,
      labChargeDay: 7,
      signerUserId: userId,
      typedLegalName: "Test Provider",
      consent: true,
      signerIp: "127.0.0.1",
      signerUserAgent: "vitest",
      signedAt: new Date(),
      signatureObjectKey: `test/${authorizationId}/signature`,
      signatureChecksum: "b".repeat(64),
      documentObjectKey: `test/${authorizationId}/document`,
      documentChecksum: "c".repeat(64),
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2030,
      cardStatus: "active",
    });
    await db.insert(tables.providerAutopayAuthorizationLabs).values({
      authorizationId,
      labOrganizationId,
    });
    await db.insert(tables.subscriptions).values({
      subjectType: "provider_org",
      subjectId: providerOrganizationId,
      provider: "stripe",
      stripeCustomerId: "cus_subscription",
      stripeSubscriptionId: "sub_provider",
      stripePriceId: "price_provider",
      status: "active",
      autoPayEnabled: true,
      autoPayChargeDay: 7,
      paymentMethodOnFile: true,
    });
    [invoiceId] = (
      await db
        .insert(tables.invoices)
        .values({
          invoiceNumber: rid("AUTO"),
          labOrganizationId,
          providerOrganizationId,
          status: "open",
          subtotal: "40.00",
          total: "40.00",
          balanceDue: "40.00",
          createdByUserId: userId,
        })
        .returning({ id: tables.invoices.id })
    ).map((row) => row.id);
  });

  afterEach(async () => {
    await db
      .delete(tables.notifications)
      .where(eq(tables.notifications.userId, userId));
    await db
      .delete(tables.providerAutoPayAttempts)
      .where(
        eq(
          tables.providerAutoPayAttempts.providerOrganizationId,
          providerOrganizationId,
        ),
      );
    // Signed authorization rows are immutable in normal operation. Tests use
    // a transaction-local replication role only for their own fixture cleanup;
    // the trigger remains active for every other connection.
    await deleteAuthorizationFixture(authorizationId);
    await cleanupPaymentFixtures(
      {
        userIds: [userId],
        organizationIds: [labOrganizationId, providerOrganizationId],
        invoiceIds: [invoiceId],
      },
      db,
    );
    await db.delete(tables.invoices).where(eq(tables.invoices.id, invoiceId));
    await db
      .delete(tables.subscriptions)
      .where(eq(tables.subscriptions.subjectId, providerOrganizationId));
    await db
      .delete(tables.organizationMemberships)
      .where(
        inArray(tables.organizationMemberships.labId, [
          providerOrganizationId,
          labOrganizationId,
        ]),
      );
    await db
      .delete(tables.organizations)
      .where(
        inArray(tables.organizations.id, [
          providerOrganizationId,
          labOrganizationId,
        ]),
      );
    await db.delete(tables.users).where(eq(tables.users.id, userId));
  });

  it("dedupes three-day reminders and charges each due balance once", async () => {
    paymentIntentCreate.mockImplementation(async (input) => ({
      id:
        input.description === "LabTrax provider subscription auto-pay"
          ? "pi_subscription"
          : "pi_invoice",
      status: "succeeded",
      latest_charge:
        input.description === "LabTrax provider invoice auto-pay"
          ? "ch_invoice"
          : null,
    }));
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");

    const reminderDay = new Date("2026-09-04T12:00:00.000Z");
    await runProviderAutoPayJob(reminderDay);
    await runProviderAutoPayJob(reminderDay);
    expect(paymentIntentCreate).not.toHaveBeenCalled();

    const reminders = await db
      .select()
      .from(tables.notifications)
      .where(eq(tables.notifications.type, "provider_auto_pay_reminder"));
    expect(
      reminders.filter((row) => row.userId === userId),
    ).toHaveLength(2);

    const chargeDay = new Date("2026-09-07T12:00:00.000Z");
    await runProviderAutoPayJob(chargeDay);
    await runProviderAutoPayJob(chargeDay);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(paymentIntentCreate.mock.calls[0]?.[0].amount).toBe(4000);
    expect(
      paymentIntentCreate.mock.calls.every(([, options]) =>
        String(options.idempotencyKey).startsWith("provider-auto-pay-"),
      ),
    ).toBe(true);

    const payments = await db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoiceId));
    expect(payments).toHaveLength(1);
    const [invoice] = await db
      .select()
      .from(tables.invoices)
      .where(eq(tables.invoices.id, invoiceId));
    expect(invoice).toMatchObject({ status: "paid", balanceDue: "0.00" });

    const results = await db
      .select()
      .from(tables.notifications)
      .where(eq(tables.notifications.type, "provider_auto_pay_result"));
    expect(results.filter((row) => row.userId === userId)).toHaveLength(2);
    const attempts = await db
      .select()
      .from(tables.providerAutoPayAttempts)
      .where(
        eq(
          tables.providerAutoPayAttempts.providerOrganizationId,
          providerOrganizationId,
        ),
      );
    expect(attempts).toHaveLength(4);
    expect(attempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
  });

  it("records one failed result and never retries a declined schedule", async () => {
    paymentIntentCreate.mockRejectedValue(
      Object.assign(new Error("declined"), { code: "card_declined" }),
    );
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");
    const chargeDay = new Date("2026-09-07T12:00:00.000Z");

    await runProviderAutoPayJob(chargeDay);
    await runProviderAutoPayJob(chargeDay);

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    const attempts = await db
      .select()
      .from(tables.providerAutoPayAttempts)
      .where(
        eq(
          tables.providerAutoPayAttempts.providerOrganizationId,
          providerOrganizationId,
        ),
      );
    expect(attempts).toHaveLength(2);
    expect(attempts.find((attempt) => attempt.kind === "invoice")).toMatchObject({
      status: "failed",
      failureReason: "card_declined",
    });

    const resultNotifications = await db
      .select()
      .from(tables.notifications)
      .where(eq(tables.notifications.type, "provider_auto_pay_result"));
    expect(
      resultNotifications.filter((row) => row.userId === userId),
    ).toHaveLength(2);
    const payments = await db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoiceId));
    expect(payments).toHaveLength(0);
  });

  it("does not charge when the signed authorization is absent", async () => {
    await deleteAuthorizationFixture(authorizationId);
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");
    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    expect(paymentIntentCreate).not.toHaveBeenCalled();
    expect(await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId)))
      .toHaveLength(0);
  });

  it("does not charge with superseded consent or an unusable consent card", async () => {
    await db.update(tables.providerAutopayAuthorizations).set({
      status: "superseded",
      supersededAt: new Date(),
    }).where(eq(tables.providerAutopayAuthorizations.id, authorizationId));
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");
    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    expect(paymentIntentCreate).not.toHaveBeenCalled();
    expect(await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId)))
      .toHaveLength(0);
  });

  it("does not charge either schedule when Stripe's live default card changed", async () => {
    listPaymentMethods.mockResolvedValue({
      data: [{
        id: "pm_replacement",
        type: "card",
        card: { brand: "mastercard", last4: "4444", exp_month: 11, exp_year: 2031 },
      }],
    });
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");

    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));

    expect(paymentIntentCreate).not.toHaveBeenCalled();
    expect(invoicesPay).not.toHaveBeenCalled();
    const attempts = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId));
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === "failed")).toBe(true);
  });

  it("keeps the first post-trial renewal recoverable until Stripe creates an invoice", async () => {
    await db.update(tables.providerPaymentCustomers).set({
      invoiceAutoPayEnabled: false,
    }).where(eq(tables.providerPaymentCustomers.providerOrganizationId, providerOrganizationId));
    await db.update(tables.subscriptions).set({
      trialEndAt: new Date("2026-09-07T00:00:00.000Z"),
    }).where(eq(tables.subscriptions.subjectId, providerOrganizationId));
    invoicesList.mockResolvedValue({ data: [] });
    const { runProviderAutoPayJob, reconcileStaleProviderAutoPayAttempts } =
      await import("./billing-jobs.js");

    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    const [pending] = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId));
    expect(pending).toMatchObject({ kind: "subscription", status: "processing" });
    await db.update(tables.providerAutoPayAttempts).set({
      updatedAt: new Date("2026-09-07T12:00:00.000Z"),
    }).where(eq(tables.providerAutoPayAttempts.id, pending.id));

    await reconcileStaleProviderAutoPayAttempts(
      new Date("2026-09-07T12:20:00.000Z"),
      0,
    );
    const [stillPending] = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.id, pending.id));
    expect(stillPending).toMatchObject({
      status: "processing",
      failureReason: "awaiting_stripe_invoice",
    });
    expect(invoicesPay).not.toHaveBeenCalled();

    invoicesList.mockResolvedValue({
      data: [{
        id: "in_late_trial",
        customer: "cus_shared",
        amount_remaining: 2500,
        status: "open",
      }],
    });
    await reconcileStaleProviderAutoPayAttempts(
      new Date("2026-09-07T12:40:00.000Z"),
      0,
    );
    expect(invoicesPay).toHaveBeenCalledTimes(1);
    const [recovered] = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.id, pending.id));
    expect(recovered.status).toBe("succeeded");
  });

  it("repairs a processing attempt after checkout settlement already committed", async () => {
    await db.update(tables.providerPaymentCustomers).set({
      invoiceAutoPayEnabled: false,
    }).where(eq(tables.providerPaymentCustomers.providerOrganizationId, providerOrganizationId));
    const [checkout] = await db.insert(tables.providerPaymentCheckouts).values({
      providerOrganizationId,
      initiatedByUserId: userId,
      clientRequestId: rid("settled_checkout"),
      totalAmount: "40.00",
      currency: "usd",
      savePaymentMethod: false,
      status: "succeeded",
      stripePaymentIntentId: "pi_already_settled",
      settledAt: new Date("2026-09-07T11:00:00.000Z"),
    }).returning();
    const [attempt] = await db.insert(tables.providerAutoPayAttempts).values({
      providerOrganizationId,
      providerPaymentCheckoutId: checkout.id,
      kind: "invoice",
      scheduledFor: new Date("2026-09-06T00:00:00.000Z"),
      amount: "40.00",
      status: "processing",
      // Make this abandoned attempt deterministically older than the stale cutoff.
      updatedAt: new Date("2026-09-07T11:00:00.000Z"),
    }).returning();
    const { reconcileStaleProviderAutoPayAttempts } = await import("./billing-jobs.js");

    await reconcileStaleProviderAutoPayAttempts(new Date("2026-09-07T12:00:00.000Z"));

    const [recovered] = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.id, attempt.id));
    expect(recovered).toMatchObject({
      status: "succeeded",
      stripePaymentIntentId: "pi_already_settled",
    });
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it("charges the rebuilt allocation amount after a pre-checkout crash", async () => {
    paymentIntentCreate.mockResolvedValue({
      id: "pi_rebuilt_invoice",
      status: "succeeded",
      latest_charge: "ch_rebuilt_invoice",
    });
    const [attempt] = await db.insert(tables.providerAutoPayAttempts).values({
      providerOrganizationId,
      kind: "invoice",
      scheduledFor: new Date("2026-09-06T00:00:00.000Z"),
      amount: "100.00",
      status: "processing",
      updatedAt: new Date("2026-09-06T00:00:00.000Z"),
    }).returning();
    const { reconcileStaleProviderAutoPayAttempts } = await import("./billing-jobs.js");

    await reconcileStaleProviderAutoPayAttempts(
      new Date("2026-09-07T12:00:00.000Z"),
      0,
    );

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(paymentIntentCreate.mock.calls[0]?.[0]).toMatchObject({ amount: 4000 });
    const [recovered] = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.id, attempt.id));
    expect(recovered).toMatchObject({ status: "succeeded", amount: "40.00" });
    const allocations = await db.select().from(tables.providerPaymentAllocations)
      .where(eq(
        tables.providerPaymentAllocations.checkoutId,
        recovered.providerPaymentCheckoutId!,
      ));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ invoiceId, amount: "40.00" });
  });

  it("does not enter grace while a successful renewal webhook is delayed", async () => {
    await db.update(tables.providerPaymentCustomers).set({
      invoiceAutoPayEnabled: false,
    }).where(eq(tables.providerPaymentCustomers.providerOrganizationId, providerOrganizationId));
    await db.update(tables.subscriptions).set({
      status: "trialing",
      trialEndAt: new Date(Date.now() - 60_000),
    }).where(eq(tables.subscriptions.subjectId, providerOrganizationId));
    const { runBillingTransitions } = await import("./billing-jobs.js");

    await runBillingTransitions();

    const [subscription] = await db.select().from(tables.subscriptions)
      .where(eq(tables.subscriptions.subjectId, providerOrganizationId));
    expect(subscription.status).toBe("trialing");
  });

  it("does not charge when consent has the wrong category or card status", async () => {
    await db.update(tables.providerPaymentCustomers).set({
      invoiceAutoPayEnabled: false,
    }).where(eq(tables.providerPaymentCustomers.providerOrganizationId, providerOrganizationId));
    await db.update(tables.providerAutopayAuthorizations).set({
      status: "superseded",
      supersededAt: new Date(),
    }).where(eq(tables.providerAutopayAuthorizations.id, authorizationId));
    const replacementId = rid("autopay_auth_replacement");
    await db.insert(tables.providerAutopayAuthorizations).values({
      id: replacementId,
      providerOrganizationId,
      agreementVersion: "2025-01",
      agreementText: "Test authorization",
      agreementSha256: "a".repeat(64),
      subscriptionFees: false,
      labBills: true,
      labChargeDay: 7,
      signerUserId: userId,
      typedLegalName: "Test Provider",
      consent: true,
      signerIp: "127.0.0.1",
      signerUserAgent: "vitest",
      signedAt: new Date(),
      signatureObjectKey: `test/${replacementId}/signature`,
      signatureChecksum: "b".repeat(64),
      documentObjectKey: `test/${replacementId}/document`,
      documentChecksum: "c".repeat(64),
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2030,
      cardStatus: "expired",
    });
    await db.insert(tables.providerAutopayAuthorizationLabs).values({
      authorizationId: replacementId,
      labOrganizationId,
    });
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");
    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    expect(paymentIntentCreate).not.toHaveBeenCalled();
    await deleteAuthorizationFixture(replacementId);
  });

  it("charges a post-trial renewal once, then uses a strict 30-day cadence", async () => {
    paymentIntentCreate.mockResolvedValue({
      id: "pi_30day",
      status: "succeeded",
      latest_charge: "ch_30day",
    });
    await db.update(tables.subscriptions).set({
      trialEndAt: new Date("2026-09-07T00:00:00.000Z"),
    }).where(eq(tables.subscriptions.subjectId, providerOrganizationId));
    const { runProviderAutoPayJob } = await import("./billing-jobs.js");
    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    const firstAttempts = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId));
    expect(firstAttempts.filter((attempt) => attempt.kind === "subscription")).toHaveLength(1);
    await runProviderAutoPayJob(new Date("2026-10-06T12:00:00.000Z"));
    expect((await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId)))
      .filter((attempt) => attempt.kind === "subscription")).toHaveLength(1);
    await runProviderAutoPayJob(new Date("2026-10-07T12:00:00.000Z"));
    const attempts = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId));
    expect(attempts.filter((attempt) => attempt.kind === "subscription")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.kind === "subscription")
      .map((attempt) => attempt.scheduledFor.toISOString().slice(0, 10)))
      .toEqual(expect.arrayContaining(["2026-09-07", "2026-10-07"]));
  });

  it("recovers the renewal anchor after success persistence survives a crash", async () => {
    await db.update(tables.providerPaymentCustomers).set({
      invoiceAutoPayEnabled: false,
    }).where(eq(tables.providerPaymentCustomers.providerOrganizationId, providerOrganizationId));
    await db.update(tables.subscriptions).set({
      trialEndAt: new Date("2026-09-07T00:00:00.000Z"),
    }).where(eq(tables.subscriptions.subjectId, providerOrganizationId));
    subscriptionsUpdate.mockRejectedValueOnce(new Error("worker_crashed"));
    const { runProviderAutoPayJob, reconcileStaleProviderAutoPayAttempts } =
      await import("./billing-jobs.js");

    await runProviderAutoPayJob(new Date("2026-09-07T12:00:00.000Z"));
    const [pendingAnchor] = await db.select().from(tables.providerAutoPayAttempts)
      .where(and(
        eq(tables.providerAutoPayAttempts.providerOrganizationId, providerOrganizationId),
        eq(tables.providerAutoPayAttempts.kind, "subscription"),
      ));
    expect(pendingAnchor).toMatchObject({
      status: "succeeded",
      failureReason: "anchor_pending",
    });
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);

    await db.update(tables.providerAutoPayAttempts).set({
      updatedAt: new Date("2026-09-07T12:00:00.000Z"),
    }).where(eq(tables.providerAutoPayAttempts.id, pendingAnchor.id));
    await reconcileStaleProviderAutoPayAttempts(
      new Date("2026-09-07T12:20:00.000Z"),
      0,
    );

    expect(subscriptionsUpdate).toHaveBeenCalledTimes(2);
    const [recovered] = await db.select().from(tables.providerAutoPayAttempts)
      .where(eq(tables.providerAutoPayAttempts.id, pendingAnchor.id));
    expect(recovered.failureReason).toBeNull();
  });
});