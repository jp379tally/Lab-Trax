import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { cleanupPaymentFixtures } from "../test-utils/payment-cleanup.js";

const {
  checkoutCreate, checkoutRetrieve, checkoutExpire, constructEvent,
  customerRetrieve, paymentMethodRetrieve, paymentMethodList, paymentIntentCreate,
  refundCreate,
} = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  checkoutRetrieve: vi.fn(),
  checkoutExpire: vi.fn(),
  constructEvent: vi.fn(),
  customerRetrieve: vi.fn(),
  paymentMethodRetrieve: vi.fn(),
  paymentMethodList: vi.fn(),
  paymentIntentCreate: vi.fn(),
  refundCreate: vi.fn(),
}));

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: "/tmp/labtrax-test-media-provider-payment",
  extractMediaFileName: () => null,
}));
vi.mock("../lib/stripeClient.js", () => ({
  getUncachableStripeClient: vi.fn().mockResolvedValue({
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_provider_test" }),
      retrieve: customerRetrieve,
    },
    paymentMethods: {
      retrieve: paymentMethodRetrieve,
      list: paymentMethodList,
      detach: vi.fn().mockResolvedValue(undefined),
    },
    paymentIntents: { create: paymentIntentCreate },
    refunds: { create: refundCreate },
    checkout: {
      sessions: {
        create: checkoutCreate,
        retrieve: checkoutRetrieve,
        expire: checkoutExpire,
      },
    },
  }),
  constructStripeEvent: constructEvent,
  isStripeConfigured: vi.fn().mockResolvedValue(true),
  logStripeAccountOwnership: vi.fn().mockResolvedValue(undefined),
}));

const SHOULD_RUN = !!process.env.DATABASE_URL;
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

maybe("provider Stripe invoice checkout (db integration)", () => {
  type DbMod = typeof import("@workspace/db");
  let db: DbMod["db"];
  let tables: DbMod;
  let app: Express;
  let providerToken: string;
  let providerUserId: string;
  let labOrgId: string;
  let providerOrgId: string;
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  beforeAll(async () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET ?? "labtrax-test-secret-provider-payment";
    tables = await import("@workspace/db");
    db = tables.db;
    app = (await import("../app.js")).default;
    await (await import("./index.js")).labtraxRoutesReady;

    const username = rid("prov").slice(0, 12);
    const registration = await request(app)
      .post("/api/auth/register")
      .send({
        username,
        password: "TestPass1!",
        email: `${username}@example.com`,
        userType: "provider",
        clientType: "mobile",
      });
    expect(registration.status).toBe(200);
    providerUserId = registration.body.user.id;
    providerToken = registration.body.accessToken;
    createdUserIds.push(providerUserId);
    // This fixture models an existing licensed practice. A newly registered
    // provider defaults to permanent Free and must not gain billing access.
    await db.delete(tables.subscriptions).where(eq(tables.subscriptions.subjectId, providerUserId));
    await db
      .update(tables.users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(tables.users.id, providerUserId));

    [labOrgId] = (
      await db
        .insert(tables.organizations)
        .values({ type: "lab", name: rid("TestLab") })
        .returning({ id: tables.organizations.id })
    ).map((row) => row.id);
    [providerOrgId] = (
      await db
        .insert(tables.organizations)
        .values({
          type: "provider",
          name: rid("TestPractice"),
          parentLabOrganizationId: labOrgId,
        })
        .returning({ id: tables.organizations.id })
    ).map((row) => row.id);
    createdOrgIds.push(providerOrgId, labOrgId);
    await db.insert(tables.organizationMemberships).values([
      {
        labId: providerOrgId,
        userId: providerUserId,
        role: "member",
        status: "active",
      },
      {
        labId: labOrgId,
        userId: providerUserId,
        role: "admin",
        status: "active",
      },
    ]);
  });

  beforeEach(() => {
    checkoutCreate.mockReset();
    checkoutRetrieve.mockReset();
    checkoutExpire.mockReset();
    constructEvent.mockReset();
    customerRetrieve.mockReset();
    paymentMethodRetrieve.mockReset();
    paymentMethodList.mockReset();
    paymentIntentCreate.mockReset();
    refundCreate.mockReset();
    constructEvent.mockResolvedValue(null);
    checkoutCreate.mockImplementation(async () => ({
      id: rid("cs"),
      url: "https://checkout.stripe.test/session",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }));
    checkoutExpire.mockResolvedValue({
      status: "expired",
      payment_status: "unpaid",
    });
    customerRetrieve.mockResolvedValue({
      id: "cus_provider_test",
      deleted: false,
      invoice_settings: { default_payment_method: "pm_shared_card" },
    });
    paymentMethodRetrieve.mockResolvedValue({
      id: "pm_shared_card",
      type: "card",
      customer: "cus_provider_test",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    });
    paymentMethodList.mockResolvedValue({ data: [] });
    refundCreate.mockResolvedValue({ id: "re_test" });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    if (createdInvoiceIds.length > 0) {
      await cleanupPaymentFixtures(
        { invoiceIds: createdInvoiceIds, organizationIds: [providerOrgId] },
        db,
      );
      await db
        .delete(tables.invoices)
        .where(inArray(tables.invoices.id, createdInvoiceIds));
    }
    await db
      .delete(tables.providerPaymentCustomers)
      .where(eq(tables.providerPaymentCustomers.providerOrganizationId, providerOrgId));
    await db
      .delete(tables.notifications)
      .where(inArray(tables.notifications.userId, createdUserIds));
    await db
      .delete(tables.organizationMemberships)
      .where(inArray(tables.organizationMemberships.labId, createdOrgIds));
    await db
      .delete(tables.organizations)
      .where(
        and(
          inArray(tables.organizations.id, createdOrgIds),
          ne(tables.organizations.id, labOrgId),
        ),
      );
    await db
      .delete(tables.organizations)
      .where(eq(tables.organizations.id, labOrgId));
    await db
      .delete(tables.auditLogs)
      .where(inArray(tables.auditLogs.userId, createdUserIds));
    await db
      .delete(tables.userSessions)
      .where(inArray(tables.userSessions.userId, createdUserIds));
    await db
      .delete(tables.users)
      .where(inArray(tables.users.id, createdUserIds));
  });

  async function insertInvoice(
    opts: { providerId?: string; total?: string; status?: string } = {},
  ) {
    const total = opts.total ?? "100.00";
    const [invoice] = await db
      .insert(tables.invoices)
      .values({
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: opts.providerId ?? providerOrgId,
        status: opts.status ?? "open",
        subtotal: total,
        total,
        balanceDue: total,
        createdByUserId: providerUserId,
      })
      .returning();
    createdInvoiceIds.push(invoice.id);
    return invoice;
  }

  async function createCheckout(
    allocations: Array<{ invoiceId: string; amount: number }>,
    extras: Record<string, unknown> = {},
  ) {
    return request(app)
      .post("/api/provider/payment-checkout")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({ allocations, ...extras });
  }

  async function ensureSharedCardCustomer() {
    await db
      .insert(tables.providerPaymentCustomers)
      .values({
        providerOrganizationId: providerOrgId,
        stripeCustomerId: "cus_provider_test",
      })
      .onConflictDoNothing();
  }

  async function waitForInvoiceLockWaiters(
    blockerPid: number,
    expectedCount: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await tables.pool.query(
        `WITH RECURSIVE blocked(pid) AS (
           SELECT pid
             FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
           UNION
           SELECT activity.pid
             FROM pg_stat_activity activity
             JOIN blocked blocker
               ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
         )
         SELECT pid FROM blocked`,
        [blockerPid],
      );
      if (result.rows.length >= expectedCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${expectedCount} invoice row lock waiters`,
    );
  }

  function labCardCharge(allocations: Array<{ invoiceId: string; amount: number }>, idempotencyKey = rid("labcard")) {
    return request(app)
      .post("/api/provider/lab-card/charge")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        allocations,
        idempotencyKey,
      });
  }

  it("requires owner/admin access and the provider's parent-lab relationship for shared cards", async () => {
    await db
      .update(tables.organizationMemberships)
      .set({ role: "billing" })
      .where(and(
        eq(tables.organizationMemberships.labId, labOrgId),
        eq(tables.organizationMemberships.userId, providerUserId),
      ));
    const billingOnly = await request(app)
      .get("/api/provider/lab-card")
      .set("Authorization", `Bearer ${providerToken}`)
      .query({ labOrganizationId: labOrgId, providerOrganizationId: providerOrgId });
    expect(billingOnly.status).toBe(403);
    await db
      .update(tables.organizationMemberships)
      .set({ role: "admin" })
      .where(and(
        eq(tables.organizationMemberships.labId, labOrgId),
        eq(tables.organizationMemberships.userId, providerUserId),
      ));
    const [otherLab] = await db.insert(tables.organizations)
      .values({ type: "lab", name: rid("OtherLab") })
      .returning();
    const [otherProvider] = await db.insert(tables.organizations)
      .values({
        type: "provider",
        name: rid("OtherPractice"),
        parentLabOrganizationId: otherLab.id,
      })
      .returning();
    try {
      const response = await request(app)
        .get("/api/provider/lab-card")
        .set("Authorization", `Bearer ${providerToken}`)
        .query({ labOrganizationId: labOrgId, providerOrganizationId: otherProvider.id });
      expect(response.status).toBe(404);
      expect(customerRetrieve).not.toHaveBeenCalled();
    } finally {
      await db.delete(tables.organizations).where(eq(tables.organizations.id, otherProvider.id));
      await db.delete(tables.organizations).where(eq(tables.organizations.id, otherLab.id));
    }
  });

  it("returns shared card metadata only in masked form", async () => {
    await ensureSharedCardCustomer();
    const response = await request(app)
      .get("/api/provider/lab-card")
      .set("Authorization", `Bearer ${providerToken}`)
      .query({ labOrganizationId: labOrgId, providerOrganizationId: providerOrgId });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      hasCard: true,
      cardPresent: true,
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
      autoPay: {
        enabled: false,
        dayOfMonth: 10,
        context: "provider_invoice_autopay",
      },
    });
    expect(JSON.stringify(response.body.data)).not.toContain("pm_shared_card");
  });

  it("projects the provider's invoice auto-pay preference read-only to the lab", async () => {
    await ensureSharedCardCustomer();
    await db
      .update(tables.providerPaymentCustomers)
      .set({ invoiceAutoPayEnabled: true, invoiceAutoPayChargeDay: 7 })
      .where(
        eq(
          tables.providerPaymentCustomers.providerOrganizationId,
          providerOrgId,
        ),
      );
    const response = await request(app)
      .get("/api/provider/lab-card")
      .set("Authorization", `Bearer ${providerToken}`)
      .query({ labOrganizationId: labOrgId, providerOrganizationId: providerOrgId });
    expect(response.status).toBe(200);
    expect(response.body.data.autoPay).toEqual({
      enabled: true,
      dayOfMonth: 7,
      context: "provider_invoice_autopay",
    });
  });

  it("rejects foreign, stale, and excess shared-card allocations before Stripe", async () => {
    const [otherProvider] = await db.insert(tables.organizations)
      .values({ type: "provider", name: rid("ForeignPractice") })
      .returning();
    createdOrgIds.unshift(otherProvider.id);
    const foreign = await insertInvoice({ providerId: otherProvider.id });
    const stale = await insertInvoice({ status: "paid" });
    const excess = await insertInvoice({ total: "10.00" });
    await ensureSharedCardCustomer();
    expect((await labCardCharge([{ invoiceId: foreign.id, amount: 1 }])).status).toBe(403);
    expect((await labCardCharge([{ invoiceId: stale.id, amount: 1 }])).status).toBe(400);
    expect((await labCardCharge([{ invoiceId: excess.id, amount: 11 }])).status).toBe(400);
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it("settles a successful multi-invoice shared-card charge exactly once", async () => {
    const first = await insertInvoice({ total: "100.00" });
    const second = await insertInvoice({ total: "75.00" });
    await ensureSharedCardCustomer();
    paymentIntentCreate.mockResolvedValue({
      id: "pi_lab_card_success",
      status: "succeeded",
      latest_charge: "ch_lab_card_success",
    });
    const key = rid("shared-success");
    const body = [{ invoiceId: first.id, amount: 100 }, { invoiceId: second.id, amount: 25 }];
    const firstResponse = await labCardCharge(body, key);
    const repeatResponse = await labCardCharge(body, key);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body.data).toMatchObject({
      checkoutId: firstResponse.body.data.checkoutId,
      status: "succeeded",
      totalAmount: "125.00",
      failureReason: null,
    });
    expect(repeatResponse.body.data).toEqual(firstResponse.body.data);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    const paymentRows = await db.select().from(tables.payments)
      .where(eq(tables.payments.providerPaymentCheckoutId, firstResponse.body.data.checkoutId));
    expect(paymentRows).toHaveLength(2);
    const rows = await db.select({ id: tables.invoices.id, balanceDue: tables.invoices.balanceDue })
      .from(tables.invoices).where(inArray(tables.invoices.id, [first.id, second.id]));
    expect(rows.find((row) => row.id === first.id)?.balanceDue).toBe("0.00");
    expect(rows.find((row) => row.id === second.id)?.balanceDue).toBe("50.00");
  });

  it("reserves an invoice while Stripe confirmation is pending so a distinct key cannot charge it", async () => {
    const invoice = await insertInvoice({ total: "30.00" });
    await ensureSharedCardCustomer();
    let resolveIntent!: (value: any) => void;
    paymentIntentCreate.mockImplementationOnce(() => new Promise((resolve) => {
      resolveIntent = resolve;
    }));
    const first = labCardCharge(
      [{ invoiceId: invoice.id, amount: 30 }],
      rid("reservation-one"),
    ).then((response) => response);
    await vi.waitFor(() => expect(paymentIntentCreate).toHaveBeenCalledTimes(1));
    const second = await labCardCharge([{ invoiceId: invoice.id, amount: 30 }], rid("reservation-two"));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      message: "A prior card attempt has an uncertain processor outcome. Support review is required before this invoice can be charged; do not submit another charge.",
      details: {
        code: "CARD_PAYMENT_ATTEMPT_BLOCKED",
        nextStep: "support_review",
        safeToRetry: false,
      },
    });
    // The blocked attempt is reconciled with the original checkout-derived
    // Stripe idempotency key; Stripe therefore cannot create a second charge.
    expect(paymentIntentCreate).toHaveBeenCalledTimes(2);
    expect(paymentIntentCreate.mock.calls[0][1]).toEqual(paymentIntentCreate.mock.calls[1][1]);
    resolveIntent({
      id: "pi_reserved_invoice",
      status: "succeeded",
      latest_charge: "ch_reserved_invoice",
    });
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    // The now-paid invoice remains non-payable under a new key even after its
    // pending reservation has been settled.
    const afterSuccess = await labCardCharge(
      [{ invoiceId: invoice.id, amount: 30 }],
      rid("reservation-three"),
    );
    expect(afterSuccess.status).toBe(400);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(2);
  });

  it("explains when a fenced invoice will be handled by automatic reconciliation", async () => {
    const invoice = await insertInvoice({ total: "31.00" });
    const key = rid("processing-reservation");
    const [checkout] = await db.insert(tables.providerPaymentCheckouts).values({
      providerOrganizationId: providerOrgId,
      initiatedByUserId: providerUserId,
      clientRequestId: key,
      stripePaymentIntentId: "pi_processing_reservation",
      totalAmount: "31.00",
      currency: "usd",
      savePaymentMethod: false,
      status: "pending",
    }).returning();
    await db.insert(tables.providerPaymentAllocations).values({
      checkoutId: checkout.id,
      invoiceId: invoice.id,
      amount: "31.00",
    });

    const response = await labCardCharge(
      [{ invoiceId: invoice.id, amount: 31 }],
      rid("processing-reservation-competing"),
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      message: "Stripe is still confirming a prior card attempt. The invoice remains reserved while automatic reconciliation runs; do not submit another charge.",
      details: {
        code: "CARD_PAYMENT_ATTEMPT_BLOCKED",
        nextStep: "automatic_reconciliation",
        safeToRetry: false,
      },
    });
  });

  it("replays the checkout Stripe idempotency key after an ambiguous timeout and settles the accepted charge", async () => {
    const invoice = await insertInvoice({ total: "42.00" });
    await ensureSharedCardCustomer();
    paymentIntentCreate
      .mockRejectedValueOnce(Object.assign(new Error("connection lost"), { type: "StripeConnectionError" }))
      .mockResolvedValueOnce({
        id: "pi_timeout_recovered",
        status: "succeeded",
        latest_charge: "ch_timeout_recovered",
      });
    const response = await labCardCharge([{ invoiceId: invoice.id, amount: 42 }]);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("succeeded");
    expect(paymentIntentCreate).toHaveBeenCalledTimes(2);
    expect(paymentIntentCreate.mock.calls[0][1]).toEqual(paymentIntentCreate.mock.calls[1][1]);
    const paymentRows = await db.select().from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoice.id));
    expect(paymentRows).toHaveLength(1);
  });

  it("recovers an abandoned pending reservation when its same key is retried", async () => {
    const invoice = await insertInvoice({ total: "22.00" });
    await ensureSharedCardCustomer();
    const key = rid("abandoned");
    const [checkout] = await db.insert(tables.providerPaymentCheckouts).values({
      providerOrganizationId: providerOrgId,
      initiatedByUserId: providerUserId,
      clientRequestId: key,
      totalAmount: "22.00",
      currency: "usd",
      savePaymentMethod: false,
      status: "pending",
    }).returning();
    await db.insert(tables.providerPaymentAllocations).values({
      checkoutId: checkout.id,
      invoiceId: invoice.id,
      amount: "22.00",
    });
    paymentIntentCreate.mockResolvedValue({
      id: "pi_abandoned_recovered",
      status: "succeeded",
      latest_charge: "ch_abandoned_recovered",
    });
    const response = await labCardCharge([{ invoiceId: invoice.id, amount: 22 }], key);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ checkoutId: checkout.id, status: "succeeded" });
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  it("releases a reservation when the shared card was removed before confirmation", async () => {
    const invoice = await insertInvoice({ total: "18.00" });
    await ensureSharedCardCustomer();
    paymentMethodRetrieve.mockResolvedValue({ id: "pm_removed", type: "card", card: null });
    paymentMethodList.mockResolvedValue({ data: [] });
    const firstKey = rid("removed-card");
    const first = await labCardCharge([{ invoiceId: invoice.id, amount: 18 }], firstKey);
    expect(first.status).toBe(400);
    expect(paymentIntentCreate).not.toHaveBeenCalled();
    const [failed] = await db.select().from(tables.providerPaymentCheckouts).where(and(
      eq(tables.providerPaymentCheckouts.providerOrganizationId, providerOrgId),
      eq(tables.providerPaymentCheckouts.clientRequestId, firstKey),
    ));
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("shared_card_not_on_file");
    const second = await labCardCharge([{ invoiceId: invoice.id, amount: 18 }], rid("removed-card-retry"));
    expect(second.status).toBe(400);
    const rows = await db.select().from(tables.providerPaymentCheckouts).where(eq(
      tables.providerPaymentCheckouts.providerOrganizationId, providerOrgId,
    ));
    expect(rows.filter((row) => row.clientRequestId?.startsWith("removed-card"))).toHaveLength(2);
  });

  it("refunds a confirmed charge when settlement finds a stale invoice and terminally releases it", async () => {
    const invoice = await insertInvoice({ total: "50.00" });
    await ensureSharedCardCustomer();
    paymentIntentCreate.mockImplementationOnce(async () => {
      await db.update(tables.invoices)
        .set({ balanceDue: "1.00" })
        .where(eq(tables.invoices.id, invoice.id));
      return {
        id: "pi_settlement_conflict",
        status: "succeeded",
        latest_charge: "ch_settlement_conflict",
      };
    });
    const key = rid("settlement-conflict");
    const response = await labCardCharge([{ invoiceId: invoice.id, amount: 50 }], key);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      failureReason: "settlement_conflict_refunded",
    });
    expect(refundCreate).toHaveBeenCalledTimes(1);
    expect(refundCreate.mock.calls[0][0]).toEqual({ charge: "ch_settlement_conflict" });
    const [current] = await db.select().from(tables.invoices)
      .where(eq(tables.invoices.id, invoice.id));
    const payments = await db.select().from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoice.id));
    expect(current.balanceDue).toBe("1.00");
    expect(current.status).toBe("open");
    expect(payments).toHaveLength(0);
    const [checkout] = await db.select().from(tables.providerPaymentCheckouts).where(and(
      eq(tables.providerPaymentCheckouts.providerOrganizationId, providerOrgId),
      eq(tables.providerPaymentCheckouts.clientRequestId, key),
    ));
    expect(checkout).toMatchObject({
      status: "failed",
      failureReason: "settlement_conflict_refunded",
    });
  });

  it("keeps an ambiguous compensating refund blocking until same-key replay confirms it", async () => {
    const invoice = await insertInvoice({ total: "60.00" });
    await ensureSharedCardCustomer();
    paymentIntentCreate.mockImplementationOnce(async () => {
      await db.update(tables.invoices)
        .set({ balanceDue: "2.00" })
        .where(eq(tables.invoices.id, invoice.id));
      return {
        id: "pi_refund_ambiguous",
        status: "succeeded",
        latest_charge: "ch_refund_ambiguous",
      };
    });
    refundCreate.mockRejectedValueOnce(
      Object.assign(new Error("refund response timed out"), { type: "StripeConnectionError" }),
    );
    const key = rid("refund-ambiguous");
    const first = await labCardCharge([{ invoiceId: invoice.id, amount: 60 }], key);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      status: "pending",
      failureReason: "settlement_conflict_refund_review_required",
    });
    const distinct = await labCardCharge(
      [{ invoiceId: invoice.id, amount: 2 }],
      rid("refund-distinct"),
    );
    expect(distinct.status).toBe(409);
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);

    refundCreate.mockResolvedValueOnce({ id: "re_refund_recovered" });
    const replay = await labCardCharge([{ invoiceId: invoice.id, amount: 60 }], key);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      status: "failed",
      failureReason: "settlement_conflict_refunded",
    });
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(refundCreate).toHaveBeenCalledTimes(2);
    expect(refundCreate.mock.calls[0][1]).toEqual(refundCreate.mock.calls[1][1]);
    const [checkout] = await db.select().from(tables.providerPaymentCheckouts).where(and(
      eq(tables.providerPaymentCheckouts.providerOrganizationId, providerOrgId),
      eq(tables.providerPaymentCheckouts.clientRequestId, key),
    ));
    expect(checkout).toMatchObject({
      status: "failed",
      failureReason: "settlement_conflict_refunded",
    });
  });

  it("marks a declined shared-card PaymentIntent failed without changing invoices", async () => {
    const invoice = await insertInvoice({ total: "55.00" });
    await ensureSharedCardCustomer();
    paymentIntentCreate.mockResolvedValue({ id: "pi_lab_card_failed", status: "requires_payment_method" });
    const response = await labCardCharge([{ invoiceId: invoice.id, amount: 55 }]);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      checkoutId: response.body.data.checkoutId,
      status: "failed",
      totalAmount: "55.00",
      failureReason: "stripe_payment_intent_requires_payment_method",
    });
    expect(JSON.stringify(response.body.data)).not.toContain("pi_lab_card_failed");
    const [current] = await db.select().from(tables.invoices)
      .where(eq(tables.invoices.id, invoice.id));
    const paymentRows = await db.select().from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoice.id));
    expect(current.balanceDue).toBe("55.00");
    expect(current.status).toBe("open");
    expect(paymentRows).toHaveLength(0);
  });

  it("creates one card checkout for multiple allocations and honors save-card choice", async () => {
    const first = await insertInvoice({ total: "80.00" });
    const second = await insertInvoice({ total: "45.00" });
    const response = await createCheckout(
      [
        { invoiceId: first.id, amount: 30 },
        { invoiceId: second.id, amount: 20 },
      ],
      { savePaymentMethod: true },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.totalAmount).toBe("50.00");
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    const stripeParams = checkoutCreate.mock.calls[0][0];
    expect(stripeParams.mode).toBe("payment");
    expect(stripeParams.payment_method_types).toEqual(["card"]);
    expect(stripeParams.line_items[0].price_data.unit_amount).toBe(5000);
    expect(stripeParams.payment_intent_data.setup_future_usage).toBe("off_session");
    expect(stripeParams.saved_payment_method_options.payment_method_save).toBe("enabled");
  });

  it("calculates full balance from every currently payable provider invoice", async () => {
    const existing = await db
      .select({ status: tables.invoices.status, balanceDue: tables.invoices.balanceDue })
      .from(tables.invoices)
      .where(
        and(
          eq(tables.invoices.providerOrganizationId, providerOrgId),
          isNull(tables.invoices.deletedAt),
        ),
      );
    const existingPayable = existing.reduce(
      (sum, row) =>
        ["open", "partially_paid", "overdue"].includes(row.status)
          ? sum + Number(row.balanceDue)
          : sum,
      0,
    );
    const first = await insertInvoice({ total: "80.00" });
    const second = await insertInvoice({ total: "45.00" });
    await insertInvoice({ total: "90.00", status: "paid" });

    const response = await request(app)
      .post("/api/provider/payment-checkout")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({ mode: "full", idempotencyKey: rid("full") });

    expect(response.status).toBe(201);
    expect(response.body.data.totalAmount).toBe((existingPayable + 125).toFixed(2));
    expect(checkoutCreate.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(
      Math.round((existingPayable + 125) * 100),
    );

    const allocations = await db
      .select()
      .from(tables.providerPaymentAllocations)
      .where(eq(tables.providerPaymentAllocations.checkoutId, response.body.data.checkoutId));
    expect(allocations.map((row) => row.invoiceId)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });

  it("scopes full checkout to one authorized provider organization", async () => {
    const [secondProvider] = await db
      .insert(tables.organizations)
      .values({
        type: "provider",
        name: rid("SecondPractice"),
        parentLabOrganizationId: labOrgId,
      })
      .returning({ id: tables.organizations.id });
    createdOrgIds.push(secondProvider.id);
    await db.insert(tables.organizationMemberships).values({
      labId: secondProvider.id,
      userId: providerUserId,
      role: "member",
      status: "active",
    });
    const firstInvoice = await insertInvoice({ total: "31.00" });
    const secondInvoice = await insertInvoice({
      providerId: secondProvider.id,
      total: "47.00",
    });

    const response = await request(app)
      .post("/api/provider/payment-checkout")
      .set("Authorization", `Bearer ${providerToken}`)
      .set("x-provider-organization-id", providerOrgId)
      .send({
        mode: "full",
        providerOrganizationId: providerOrgId,
        idempotencyKey: rid("scoped-full"),
      });

    expect(response.status).toBe(201);
    const allocations = await db
      .select()
      .from(tables.providerPaymentAllocations)
      .where(
        eq(
          tables.providerPaymentAllocations.checkoutId,
          response.body.data.checkoutId,
        ),
      );
    expect(allocations.some((row) => row.invoiceId === firstInvoice.id)).toBe(true);
    expect(allocations.some((row) => row.invoiceId === secondInvoice.id)).toBe(false);
    await db
      .delete(tables.organizationMemberships)
      .where(
        and(
          eq(tables.organizationMemberships.userId, providerUserId),
          eq(tables.organizationMemberships.labId, secondProvider.id),
        ),
      );
  });

  it("reports auto-pay scheduling available and rejects unauthorized activation", async () => {
    const preferences = await request(app)
      .get("/api/provider/billing-preferences")
      .set("Authorization", `Bearer ${providerToken}`);
    expect(preferences.status).toBe(200);
    expect(preferences.body.data.capabilities.autoPayScheduling).toBe(true);

    const subscriptionWrite = await request(app)
      .patch("/api/provider/subscription-autopay")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({ enabled: true, chargeDay: 5 });
    expect(subscriptionWrite.status).toBe(409);

    const labWrite = await request(app)
      .patch(`/api/provider/labs/${providerOrgId}/invoice-autopay`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({ enabled: true, chargeDay: 7 });
    expect(labWrite.status).toBe(409);
  });

  it("returns from HTTPS checkout into the registered mobile scheme without exposing payment state", async () => {
    const response = await request(app)
      .get("/api/provider/mobile-payment-return?cancelled=1");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("labtrax://provider-billing?returned=1&amp;cancelled=1");
    expect(response.text).not.toContain("succeeded");
    expect(response.text).not.toContain("checkoutId");
  });

  it("returns the same checkout for a repeated idempotency key", async () => {
    const invoice = await insertInvoice();
    const key = rid("request");
    const first = await createCheckout(
      [{ invoiceId: invoice.id, amount: 25 }],
      { idempotencyKey: key },
    );
    const second = await createCheckout(
      [{ invoiceId: invoice.id, amount: 25 }],
      { idempotencyKey: key },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.checkoutId).toBe(first.body.data.checkoutId);
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("recovers terminal mobile checkout shapes by durable key before live-balance validation", async () => {
    const { settleProviderPaymentCheckout } = await import(
      "../lib/provider-invoice-payments.js"
    );
    const shapes: Array<{
      label: string;
      makeBody: (invoiceId: string, key: string) => Record<string, unknown>;
    }> = [
      {
        label: "partial",
        makeBody: (_invoiceId, key) => ({
          amount: 20,
          providerOrganizationId: providerOrgId,
          idempotencyKey: key,
        }),
      },
      {
        label: "selected",
        makeBody: (invoiceId, key) => ({
          invoiceIds: [invoiceId],
          providerOrganizationId: providerOrgId,
          idempotencyKey: key,
        }),
      },
      {
        label: "case-invoice",
        makeBody: (invoiceId, key) => ({
          invoiceIds: [invoiceId],
          providerOrganizationId: providerOrgId,
          idempotencyKey: key,
        }),
      },
    ];

    for (const shape of shapes) {
      const invoice = await insertInvoice({ total: "40.00" });
      const key = rid(shape.label);
      const body = shape.makeBody(invoice.id, key);
      const first = await request(app)
        .post("/api/provider/payment-checkout")
        .set("Authorization", `Bearer ${providerToken}`)
        .send(body);
      expect(first.status, shape.label).toBe(201);
      await settleProviderPaymentCheckout(
        first.body.data.checkoutId,
        rid("pi"),
        rid("ch"),
      );
      const retry = await request(app)
        .post("/api/provider/payment-checkout")
        .set("Authorization", `Bearer ${providerToken}`)
        .send(body);
      expect(retry.status, shape.label).toBe(200);
      expect(retry.body.data.checkoutId, shape.label).toBe(first.body.data.checkoutId);
      expect(retry.body.data.status, shape.label).toBe("succeeded");
    }

    await insertInvoice({ total: "35.00" });
    const fullKey = rid("full-terminal");
    const fullBody = {
      mode: "full",
      providerOrganizationId: providerOrgId,
      idempotencyKey: fullKey,
    };
    const full = await request(app)
      .post("/api/provider/payment-checkout")
      .set("Authorization", `Bearer ${providerToken}`)
      .send(fullBody);
    expect(full.status).toBe(201);
    await settleProviderPaymentCheckout(full.body.data.checkoutId, rid("pi"), rid("ch"));
    const fullRetry = await request(app)
      .post("/api/provider/payment-checkout")
      .set("Authorization", `Bearer ${providerToken}`)
      .send(fullBody);
    expect(fullRetry.status).toBe(200);
    expect(fullRetry.body.data.checkoutId).toBe(full.body.data.checkoutId);
    expect(fullRetry.body.data.status).toBe("succeeded");
  });

  it("recovers an ambiguous Stripe create failure with the same idempotency key", async () => {
    const invoice = await insertInvoice();
    const key = rid("ambiguous");
    checkoutCreate
      .mockRejectedValueOnce(new Error("Stripe response timed out"))
      .mockResolvedValueOnce({
        id: "cs_recovered",
        url: "https://checkout.stripe.test/recovered",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

    const first = await createCheckout(
      [{ invoiceId: invoice.id, amount: 35 }],
      { idempotencyKey: key },
    );
    const retry = await createCheckout(
      [{ invoiceId: invoice.id, amount: 35 }],
      { idempotencyKey: key },
    );
    expect(first.status).toBe(500);
    expect(retry.status).toBe(201);
    expect(retry.body.data.sessionId).toBe("cs_recovered");
    expect(checkoutCreate).toHaveBeenCalledTimes(2);
    expect(checkoutCreate.mock.calls[0][1]).toEqual(
      checkoutCreate.mock.calls[1][1],
    );
  });

  it("rejects cross-tenant and over-balance allocations before Stripe", async () => {
    const [otherProvider] = await db
      .insert(tables.organizations)
      .values({ type: "provider", name: rid("OtherPractice") })
      .returning();
    createdOrgIds.unshift(otherProvider.id);
    const foreignInvoice = await insertInvoice({
      providerId: otherProvider.id,
      total: "40.00",
    });
    const ownInvoice = await insertInvoice({ total: "40.00" });

    const foreign = await createCheckout([
      { invoiceId: foreignInvoice.id, amount: 10 },
    ]);
    const over = await createCheckout([
      { invoiceId: ownInvoice.id, amount: 41 },
    ]);
    expect(foreign.status).toBe(403);
    expect(over.status).toBe(400);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("rejects fractional cents and untrusted return origins before Stripe", async () => {
    const invoice = await insertInvoice();
    const fractional = await createCheckout([
      { invoiceId: invoice.id, amount: 0.005 },
    ]);
    const externalReturn = await createCheckout(
      [{ invoiceId: invoice.id, amount: 10 }],
      { successUrl: "https://attacker.example/payment-complete" },
    );
    expect(fractional.status).toBe(400);
    expect(externalReturn.status).toBe(400);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("settles multiple invoices once after Stripe success", async () => {
    const first = await insertInvoice({ total: "100.00" });
    const second = await insertInvoice({ total: "75.00" });
    const checkoutResponse = await createCheckout([
      { invoiceId: first.id, amount: 100 },
      { invoiceId: second.id, amount: 25 },
    ]);
    const checkoutId = checkoutResponse.body.data.checkoutId;
    const { settleProviderPaymentCheckout } = await import(
      "../lib/provider-invoice-payments.js"
    );
    await settleProviderPaymentCheckout(checkoutId, "pi_confirmed", "ch_confirmed");
    await settleProviderPaymentCheckout(checkoutId, "pi_confirmed", "ch_confirmed");

    const paymentRows = await db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.providerPaymentCheckoutId, checkoutId));
    expect(paymentRows).toHaveLength(2);
    const invoiceRows = await db
      .select({ id: tables.invoices.id, status: tables.invoices.status, balance: tables.invoices.balanceDue })
      .from(tables.invoices)
      .where(inArray(tables.invoices.id, [first.id, second.id]));
    expect(invoiceRows.find((row) => row.id === first.id)).toMatchObject({
      status: "paid",
      balance: "0.00",
    });
    expect(invoiceRows.find((row) => row.id === second.id)).toMatchObject({
      status: "partially_paid",
      balance: "50.00",
    });
    const labNotifications = await db
      .select()
      .from(tables.notifications)
      .where(
        and(
          eq(tables.notifications.userId, providerUserId),
          eq(tables.notifications.type, "provider_payment_received"),
        ),
      );
    expect(labNotifications.filter(
      (row) => (row.dataJson as { checkoutId?: string } | null)?.checkoutId === checkoutId,
    )).toHaveLength(1);
  });

  it("serializes provider checkout settlement and restoration sync in both lock orders", async () => {
    const { settleProviderPaymentCheckout } = await import(
      "../lib/provider-invoice-payments.js"
    );
    const { syncInvoiceFromRestorations } = await import(
      "../lib/invoice-sync.js"
    );

    for (const firstOperation of ["sync", "settle"] as const) {
      const caseId = rid(`checkout_race_${firstOperation}`);
      const restorationId = rid(`checkout_restoration_${firstOperation}`);
      const invoiceId = rid(`checkout_invoice_${firstOperation}`);
      const lineItemId = rid(`checkout_line_${firstOperation}`);
      createdInvoiceIds.push(invoiceId);
      let checkoutId: string | null = null;
      const holder = await tables.pool.connect();
      const started: Promise<unknown>[] = [];

      try {
        await db.insert(tables.cases).values({
          id: caseId,
          caseNumber: rid("CHECKOUT_RACE"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Checkout",
          patientLastName: "Race",
          doctorName: "Dr. Lock",
          status: "received",
          createdByUserId: providerUserId,
        });
        await db.insert(tables.caseRestorations).values({
          id: restorationId,
          caseId,
          toothNumber: "14",
          restorationType: "Crown",
          material: "Zirconia",
          quantity: 1,
          unitPrice: "80.00",
        });
        await db.insert(tables.invoices).values({
          id: invoiceId,
          invoiceNumber: rid("CHECKOUT_RACE_INV"),
          caseId,
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          status: "open",
          subtotal: "80.00",
          total: "80.00",
          balanceDue: "80.00",
          createdByUserId: providerUserId,
        });
        await db.insert(tables.invoiceLineItems).values({
          id: lineItemId,
          invoiceId,
          caseRestorationId: restorationId,
          sourceType: "restoration",
          sourceKey: `restoration:${restorationId}`,
          sourceRestorationIdsJson: [restorationId],
          toothNumber: 14,
          toothLabel: "#14",
          description: "Zirconia Crown",
          quantity: 1,
          unitPrice: "80.00",
          lineTotal: "80.00",
        });
        const checkoutResponse = await createCheckout([
          { invoiceId, amount: 80 },
        ]);
        expect(checkoutResponse.status).toBe(201);
        checkoutId = checkoutResponse.body.data.checkoutId;
        const settledCheckoutId = checkoutId!;
        await db
          .update(tables.caseRestorations)
          .set({ unitPrice: "90.00" })
          .where(eq(tables.caseRestorations.id, restorationId));

        await holder.query("BEGIN");
        await holder.query(
          "SELECT id FROM invoices WHERE id = $1 FOR UPDATE",
          [invoiceId],
        );
        const blockerPid = Number(
          (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        const sync = () =>
          syncInvoiceFromRestorations({
            caseId,
            actorUserId: providerUserId,
          });
        const settle = () =>
          settleProviderPaymentCheckout(
            settledCheckoutId,
            `pi_${firstOperation}`,
            `ch_${firstOperation}`,
          );
        const first = firstOperation === "sync" ? sync() : settle();
        started.push(first);
        await waitForInvoiceLockWaiters(blockerPid, 1);
        const second = firstOperation === "sync" ? settle() : sync();
        started.push(second);
        await waitForInvoiceLockWaiters(blockerPid, 2);
        await holder.query("COMMIT");
        await Promise.all([first, second]);

        const [checkout] = await db
          .select()
          .from(tables.providerPaymentCheckouts)
          .where(eq(tables.providerPaymentCheckouts.id, settledCheckoutId));
        const paymentRows = await db
          .select()
          .from(tables.payments)
          .where(eq(tables.payments.providerPaymentCheckoutId, settledCheckoutId));
        const [invoice] = await db
          .select()
          .from(tables.invoices)
          .where(eq(tables.invoices.id, invoiceId));

        expect(checkout).toMatchObject({
          status: "succeeded",
          stripePaymentIntentId: `pi_${firstOperation}`,
          stripeChargeId: `ch_${firstOperation}`,
        });
        expect(paymentRows).toHaveLength(1);
        expect(paymentRows[0]).toMatchObject({
          invoiceId,
          amount: "80.00",
          stripePaymentIntentId: `pi_${firstOperation}`,
          providerPaymentCheckoutId: settledCheckoutId,
        });
        expect(invoice).toMatchObject(
          firstOperation === "sync"
            ? {
                subtotal: "90.00",
                total: "90.00",
                status: "partially_paid",
                balanceDue: "10.00",
              }
            : {
                subtotal: "80.00",
                total: "80.00",
                status: "paid",
                balanceDue: "0.00",
              },
        );
      } finally {
        try {
          await holder.query("ROLLBACK");
        } catch {}
        await Promise.allSettled(started);
        holder.release();
        await cleanupPaymentFixtures(
          { invoiceIds: [invoiceId], checkoutIds: checkoutId ? [checkoutId] : [] },
          db,
        );
        await db
          .delete(tables.invoiceLineItems)
          .where(eq(tables.invoiceLineItems.invoiceId, invoiceId));
        await db.delete(tables.invoices).where(eq(tables.invoices.id, invoiceId));
        await db
          .delete(tables.caseRestorations)
          .where(eq(tables.caseRestorations.caseId, caseId));
        await db.delete(tables.cases).where(eq(tables.cases.id, caseId));
      }
    }
  });

  it("serializes auto-pay confirmation and restoration sync in both lock orders", async () => {
    const { chargeProviderAutoPayCheckout } = await import(
      "../lib/provider-invoice-payments.js"
    );
    const { syncInvoiceFromRestorations } = await import(
      "../lib/invoice-sync.js"
    );

    for (const firstOperation of ["sync", "charge"] as const) {
      const caseId = rid(`autopay_race_${firstOperation}`);
      const restorationId = rid(`autopay_restoration_${firstOperation}`);
      const invoiceId = rid(`autopay_invoice_${firstOperation}`);
      const lineItemId = rid(`autopay_line_${firstOperation}`);
      createdInvoiceIds.push(invoiceId);
      let checkoutId: string | null = null;
      const holder = await tables.pool.connect();
      const started: Promise<unknown>[] = [];
      let resolveIntent!: (intent: {
        id: string;
        status: string;
        latest_charge: string;
      }) => void;

      try {
        await db.insert(tables.cases).values({
          id: caseId,
          caseNumber: rid("AUTOPAY_RACE"),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "AutoPay",
          patientLastName: "Race",
          doctorName: "Dr. Lock",
          status: "received",
          createdByUserId: providerUserId,
        });
        await db.insert(tables.caseRestorations).values({
          id: restorationId,
          caseId,
          toothNumber: "14",
          restorationType: "Crown",
          material: "Zirconia",
          quantity: 1,
          unitPrice: "80.00",
        });
        await db.insert(tables.invoices).values({
          id: invoiceId,
          invoiceNumber: rid("AUTOPAY_RACE_INV"),
          caseId,
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          status: "open",
          subtotal: "80.00",
          total: "80.00",
          balanceDue: "80.00",
          createdByUserId: providerUserId,
        });
        await db.insert(tables.invoiceLineItems).values({
          id: lineItemId,
          invoiceId,
          caseRestorationId: restorationId,
          sourceType: "restoration",
          sourceKey: `restoration:${restorationId}`,
          sourceRestorationIdsJson: [restorationId],
          toothNumber: 14,
          toothLabel: "#14",
          description: "Zirconia Crown",
          quantity: 1,
          unitPrice: "80.00",
          lineTotal: "80.00",
        });
        const checkoutResponse = await createCheckout([
          { invoiceId, amount: 80 },
        ]);
        expect(checkoutResponse.status).toBe(201);
        checkoutId = checkoutResponse.body.data.checkoutId;
        const chargedCheckoutId = checkoutId!;
        await db
          .update(tables.caseRestorations)
          .set({ unitPrice: "90.00" })
          .where(eq(tables.caseRestorations.id, restorationId));

        paymentIntentCreate.mockReset();
        paymentIntentCreate.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveIntent = resolve;
            }),
        );
        const sync = () =>
          syncInvoiceFromRestorations({
            caseId,
            actorUserId: providerUserId,
          });
        const charge = () =>
          chargeProviderAutoPayCheckout(
            { paymentIntents: { create: paymentIntentCreate } } as never,
            {
              checkoutId: chargedCheckoutId,
              providerOrganizationId: providerOrgId,
              attemptId: rid(`autopay_attempt_${firstOperation}`),
              stripeCustomerId: "cus_provider_test",
              paymentMethodId: "pm_shared_card",
              amountCents: 8_000,
            },
          );

        let syncPromise: Promise<unknown>;
        let chargePromise: Promise<unknown>;
        if (firstOperation === "sync") {
          await holder.query("BEGIN");
          await holder.query(
            "SELECT id FROM invoices WHERE id = $1 FOR UPDATE",
            [invoiceId],
          );
          const blockerPid = Number(
            (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          );
          syncPromise = sync();
          started.push(syncPromise);
          await waitForInvoiceLockWaiters(blockerPid, 1);
          chargePromise = charge();
          started.push(chargePromise);
          await waitForInvoiceLockWaiters(blockerPid, 2);
          await holder.query("COMMIT");
          await syncPromise;
          await vi.waitFor(() =>
            expect(paymentIntentCreate).toHaveBeenCalledTimes(1),
          );
        } else {
          chargePromise = charge();
          started.push(chargePromise);
          await vi.waitFor(() =>
            expect(paymentIntentCreate).toHaveBeenCalledTimes(1),
          );
          syncPromise = sync();
          started.push(syncPromise);
        }

        resolveIntent({
          id: `pi_autopay_${firstOperation}`,
          status: "succeeded",
          latest_charge: `ch_autopay_${firstOperation}`,
        });
        await Promise.all([chargePromise, syncPromise]);

        const [checkout] = await db
          .select()
          .from(tables.providerPaymentCheckouts)
          .where(eq(tables.providerPaymentCheckouts.id, chargedCheckoutId));
        const paymentRows = await db
          .select()
          .from(tables.payments)
          .where(eq(tables.payments.providerPaymentCheckoutId, chargedCheckoutId));
        const [invoice] = await db
          .select()
          .from(tables.invoices)
          .where(eq(tables.invoices.id, invoiceId));

        expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
        expect(checkout).toMatchObject({
          status: "succeeded",
          stripePaymentIntentId: `pi_autopay_${firstOperation}`,
          stripeChargeId: `ch_autopay_${firstOperation}`,
        });
        expect(paymentRows).toHaveLength(1);
        expect(paymentRows[0]).toMatchObject({
          invoiceId,
          amount: "80.00",
          stripePaymentIntentId: `pi_autopay_${firstOperation}`,
          providerPaymentCheckoutId: chargedCheckoutId,
        });
        expect(invoice).toMatchObject(
          firstOperation === "sync"
            ? {
                subtotal: "90.00",
                total: "90.00",
                status: "partially_paid",
                balanceDue: "10.00",
              }
            : {
                subtotal: "80.00",
                total: "80.00",
                status: "paid",
                balanceDue: "0.00",
              },
        );
      } finally {
        try {
          await holder.query("ROLLBACK");
        } catch {}
        await Promise.allSettled(started);
        holder.release();
        await cleanupPaymentFixtures(
          { invoiceIds: [invoiceId], checkoutIds: checkoutId ? [checkoutId] : [] },
          db,
        );
        await db
          .delete(tables.invoiceLineItems)
          .where(eq(tables.invoiceLineItems.invoiceId, invoiceId));
        await db.delete(tables.invoices).where(eq(tables.invoices.id, invoiceId));
        await db
          .delete(tables.caseRestorations)
          .where(eq(tables.caseRestorations.caseId, caseId));
        await db.delete(tables.cases).where(eq(tables.cases.id, caseId));
      }
    }
  });

  it("keeps a declined Checkout retryable and settles a later success", async () => {
    const invoice = await insertInvoice({ total: "55.00" });
    const checkoutResponse = await createCheckout([
      { invoiceId: invoice.id, amount: 55 },
    ]);
    const checkoutId = checkoutResponse.body.data.checkoutId;

    constructEvent.mockResolvedValueOnce({
      id: "evt_declined",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_declined",
          metadata: { providerPaymentCheckoutId: checkoutId },
          last_payment_error: { code: "card_declined" },
        },
      },
    });
    const declined = await request(app)
      .post("/api/billing/webhook/stripe")
      .set("stripe-signature", "valid-test-signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.payment_failed" }));
    expect(declined.status).toBe(200);

    const [afterDecline] = await db
      .select()
      .from(tables.providerPaymentCheckouts)
      .where(eq(tables.providerPaymentCheckouts.id, checkoutId));
    expect(afterDecline.status).toBe("pending");

    constructEvent.mockResolvedValueOnce({
      id: "evt_succeeded",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_succeeded",
          metadata: { providerPaymentCheckoutId: checkoutId },
          latest_charge: "ch_succeeded",
        },
      },
    });
    const succeeded = await request(app)
      .post("/api/billing/webhook/stripe")
      .set("stripe-signature", "valid-test-signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));
    expect(succeeded.status).toBe(200);

    const [afterSuccess] = await db
      .select()
      .from(tables.providerPaymentCheckouts)
      .where(eq(tables.providerPaymentCheckouts.id, checkoutId));
    expect(afterSuccess.status).toBe("succeeded");
    const paymentRows = await db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.providerPaymentCheckoutId, checkoutId));
    expect(paymentRows).toHaveLength(1);
  });

  it("cancellation and the retired self-reported route never change the invoice", async () => {
    const invoice = await insertInvoice();
    const checkoutResponse = await createCheckout([
      { invoiceId: invoice.id, amount: 40 },
    ]);
    const checkoutId = checkoutResponse.body.data.checkoutId;
    const cancelled = await request(app)
      .post(`/api/provider/payment-checkout/${checkoutId}/cancel`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});
    const legacy = await request(app)
      .post("/api/provider/pay")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({ invoiceId: invoice.id, amount: 40, paymentMethod: "cash" });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(legacy.status).toBe(410);
    const [current] = await db
      .select()
      .from(tables.invoices)
      .where(eq(tables.invoices.id, invoice.id));
    expect(current.balanceDue).toBe("100.00");
    expect(current.status).toBe("open");
    const paymentRows = await db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoice.id));
    expect(paymentRows).toHaveLength(0);
  });

  it("rejects unsigned Stripe events without settling", async () => {
    const invoice = await insertInvoice();
    const response = await request(app)
      .post("/api/billing/webhook/stripe")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));
    expect(response.status).toBe(400);
    const paymentRows = await db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.invoiceId, invoice.id));
    expect(paymentRows).toHaveLength(0);
  });
});