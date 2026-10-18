import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";

const objects = new Map<string, { body: Buffer; type: string }>();
const cardRetrieve = vi.hoisted(() => vi.fn());
const sendMailMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ sent: boolean; reason?: string }> => ({ sent: true })),
);
vi.mock("../lib/case-media-object-storage.js", () => ({
  writeCaseMediaToObjectStorage: vi.fn(async (key: string, body: Buffer, type: string) => {
    objects.set(key, { body, type }); return true;
  }),
  openCaseMediaObjectStream: vi.fn(async (key: string, type?: string) => {
    const item = objects.get(key); if (!item) return null;
    const { Readable } = require("node:stream");
    return { stream: Readable.from(item.body), contentType: type ?? item.type };
  }),
  deleteCaseMediaFromObjectStorage: vi.fn(async (key: string) => objects.delete(key)),
}));
vi.mock("../lib/stripeClient.js", () => ({
  getUncachableStripeClient: vi.fn(async () => ({
    customers: { retrieve: vi.fn(async () => ({
      id: "cus_autopay_test", deleted: false,
      invoice_settings: { default_payment_method: "pm_autopay_test" },
    })) },
    paymentMethods: { retrieve: cardRetrieve },
  })),
  logStripeAccountOwnership: vi.fn(async () => undefined),
}));
vi.mock("../lib/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mail.js")>()),
  sendMail: sendMailMock,
}));

const run = !!process.env.DATABASE_URL;
const suite = run ? describe : describe.skip;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const rid = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;

suite("provider auto-pay authorization HTTP integration", () => {
  let db: any, t: any, app: any, token: string, userId: string, labToken = "", labUserId = "";
  let providerA = "", providerB = "", labA = "", labB = "";
  const orgs: string[] = [], users: string[] = [];
  let terms: any;
  const authGet = (path: string) => request(app).get(path)
    .set("Authorization", `Bearer ${token}`)
    .set("x-provider-organization-id", providerA);
  const authPost = (path: string) => request(app).post(path)
    .set("Authorization", `Bearer ${token}`)
    .set("x-provider-organization-id", providerA);
  const labPost = (path: string) => request(app).post(path)
    .set("Authorization", `Bearer ${labToken}`)
    .set("x-provider-organization-id", providerA);
  const labGet = (path: string) => request(app).get(path)
    .set("Authorization", `Bearer ${labToken}`);
  const requestBody = (extra: any = {}) => ({
    providerOrganizationId: providerA, labOrganizationId: labA,
    subscriptionFees: true, labBills: false, ...extra,
  });
  const body = (extra: any = {}) => ({
    providerOrganizationId: providerA, agreementVersion: terms.agreementVersion,
    agreementSha256: terms.agreementSha256, subscriptionFees: true, labBills: false,
    labOrganizationIds: [], typedLegalName: "Ada Lovelace", consent: true,
    signatureData: `data:image/png;base64,${png}`, ...extra,
  });

  beforeAll(async () => {
    t = await import("@workspace/db"); db = t.db;
    process.env.JWT_SECRET ??= "autopay-integration-secret";
    app = (await import("../app.js")).default;
    await vi.waitFor(async () => {
      expect((await request(app).get("/api/__test_missing_route__")).status).toBe(404);
    }, { timeout: 15_000, interval: 25 });
    const username = rid("autopay").slice(0, 12);
    const registered = await request(app).post("/api/auth/register").send({
      username, password: "TestPass1!", email: `${username}@example.com`,
      userType: "provider", clientType: "mobile",
    });
    expect(registered.status).toBe(200);
    token = registered.body.accessToken; userId = registered.body.user.id; users.push(userId);
    // This suite exercises an existing authorized provider, not a new Free
    // onboarding account. Remove only its signup row before seeding the
    // established provider memberships below.
    await db.delete(t.subscriptions).where(eq(t.subscriptions.subjectId, userId));
    await db.update(t.users).set({ emailVerifiedAt: new Date() }).where(eq(t.users.id, userId));
    [labA, labB] = (await db.insert(t.organizations).values([
      { type: "lab", name: rid("LabA") }, { type: "lab", name: rid("LabB") },
    ]).returning({ id: t.organizations.id })).map((x: any) => x.id);
    [providerA, providerB] = (await db.insert(t.organizations).values([
      { type: "provider", name: rid("ProviderA"), parentLabOrganizationId: labA },
      { type: "provider", name: rid("ProviderB"), parentLabOrganizationId: labB },
    ]).returning({ id: t.organizations.id })).map((x: any) => x.id);
    orgs.push(labA, labB, providerA, providerB);
    await db.insert(t.organizationMemberships).values([
      { labId: providerA, userId, role: "billing", status: "active" },
      { labId: providerB, userId, role: "billing", status: "active" },
    ]);
    const labUsername = rid("labuser").slice(0, 12);
    const labRegistered = await request(app).post("/api/auth/register").send({
      username: labUsername, password: "TestPass1!", email: `${labUsername}@example.com`,
      userType: "lab", clientType: "mobile",
    });
    expect(labRegistered.status).toBe(200);
    labToken = labRegistered.body.accessToken; labUserId = labRegistered.body.user.id;
    users.push(labUserId);
    await db.update(t.users).set({ emailVerifiedAt: new Date() }).where(eq(t.users.id, labUserId));
    await db.insert(t.organizationMemberships).values([
      { labId: labA, userId: labUserId, role: "billing", status: "active" },
    ]);
    await db.insert(t.providerPaymentCustomers).values([
      { providerOrganizationId: providerA, stripeCustomerId: "cus_autopay_test" },
      { providerOrganizationId: providerB, stripeCustomerId: "cus_autopay_test_b" },
    ]);
    cardRetrieve.mockResolvedValue({ id: "pm_autopay_test", type: "card", customer: "cus_autopay_test",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } });
  });
  beforeEach(() => {
    objects.clear();
    sendMailMock.mockResolvedValue({ sent: true });
  });
  afterAll(async () => {
    if (!run) return;
    await db.transaction(async (tx: any) => {
      // Production rows are immutable. This transaction-local replication mode
      // bypass is used only to remove fixtures created by this test process.
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.delete(t.providerAutopayAuthorizationRequests).where(inArray(
        t.providerAutopayAuthorizationRequests.providerOrganizationId, [providerA, providerB]));
      await tx.delete(t.providerAutopayAuthorizationLabs).where(inArray(t.providerAutopayAuthorizationLabs.authorizationId,
        tx.select({ id: t.providerAutopayAuthorizations.id }).from(t.providerAutopayAuthorizations).where(inArray(t.providerAutopayAuthorizations.providerOrganizationId, [providerA, providerB]))));
      await tx.delete(t.providerAutopayAuthorizations).where(inArray(t.providerAutopayAuthorizations.providerOrganizationId, [providerA, providerB]));
    });
    await db.delete(t.providerPaymentCustomers).where(inArray(t.providerPaymentCustomers.providerOrganizationId, [providerA, providerB]));
    await db.delete(t.organizationMemberships).where(eq(t.organizationMemberships.userId, userId));
    await db.delete(t.organizationMemberships).where(eq(t.organizationMemberships.userId, labUserId));
    await db.delete(t.organizations).where(inArray(t.organizations.id, orgs));
    await db.delete(t.subscriptionEvents).where(inArray(t.subscriptionEvents.subjectId, [...users, ...orgs]));
    await db.delete(t.subscriptions).where(inArray(t.subscriptions.subjectId, [...users, ...orgs]));
    await db.delete(t.users).where(inArray(t.users.id, users));
  });

  it("prepare returns exact version, hash, due sentence, and scoped labs", async () => {
    const response = await authGet(`/api/provider/autopay-authorization/prepare?providerOrganizationId=${providerA}`);
    expect(response.status).toBe(200); terms = response.body.data;
    expect(terms.agreementText).toContain("Payments are due by the 10th of each month.");
    expect(terms.agreementSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(terms.labs.map((x: any) => x.labOrganizationId)).toEqual([labA]);
  });
  it("rejects stale agreement version and hash", async () => {
    if (!terms) terms = (await authGet(`/api/provider/autopay-authorization/prepare?providerOrganizationId=${providerA}`)).body.data;
    expect((await authPost("/api/provider/autopay-authorization").send(body({ agreementSha256: "0".repeat(64) }))).status).toBe(409);
    expect((await authPost("/api/provider/autopay-authorization").send(body({ agreementVersion: "old" }))).status).toBe(409);
  });
  it.each<any>([
    [{ subscriptionFees: false, labBills: false }, "category"],
    [{ labBills: true, labOrganizationIds: [labA], labChargeDay: 0 }, "day"],
    [{ consent: false }, "consent"],
    [{ typedLegalName: "" }, "name"],
    [{ labOrganizationIds: [labA, labA] }, "duplicate"],
    [{ signatureData: "data:image/png;base64,AAAA" }, "png"],
  ])("rejects invalid %s", async (input) => {
    expect((await authPost("/api/provider/autopay-authorization").send(body(input))).status).toBe(400);
  });
  it("rejects expired cards and cross-provider labs", async () => {
    cardRetrieve.mockResolvedValueOnce({ id: "pm_autopay_test", type: "card", customer: "cus_autopay_test",
      card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2020 } });
    expect((await authPost("/api/provider/autopay-authorization").send(body())).status).toBe(409);
    expect((await authPost("/api/provider/autopay-authorization").send(body({ labBills: true, labOrganizationIds: [labB], labChargeDay: 5 }))).status).toBe(403);
  });
  it("persists a redacted signed record and creation audit", async () => {
    const response = await authPost("/api/provider/autopay-authorization").send(body());
    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toMatch(/424242|cvc|pm_autopay_test|cus_autopay_test/i);
    const rows = await db.select().from(t.providerAutopayAuthorizations).where(eq(t.providerAutopayAuthorizations.providerOrganizationId, providerA));
    expect(rows[0].cardLast4).toBe("4242");
    expect(JSON.stringify(rows[0])).not.toMatch(/424242|cvc|pm_autopay_test|cus_autopay_test/i);
    const audits = await db.select().from(t.auditLogs).where(eq(t.auditLogs.entityId, rows[0].id));
    expect(audits.some((x: any) => x.action.includes("created"))).toBe(true);
  });
  it("second sign supersedes first and preserves history", async () => {
    const first = (await authPost("/api/provider/autopay-authorization").send(body())).body.data.id;
    const second = (await authPost("/api/provider/autopay-authorization").send(body({ subscriptionFees: false, labBills: true, labOrganizationIds: [labA], labChargeDay: 5 }))).body.data.id;
    expect(second).not.toBe(first);
    const history = await authGet(`/api/provider/autopay-authorization/history?providerOrganizationId=${providerA}`);
    expect(history.body.data.map((x: any) => x.id)).toEqual(expect.arrayContaining([first, second]));
    const audits = await db.select().from(t.auditLogs).where(eq(t.auditLogs.entityId, first));
    expect(audits.some((x: any) => x.action === "provider_autopay_authorization_superseded")).toBe(true);
  });
  it("rejects updates and deletes of signed records and selected labs", async () => {
    const signed = (await authPost("/api/provider/autopay-authorization").send(body({
      subscriptionFees: false, labBills: true, labOrganizationIds: [labA], labChargeDay: 5,
    }))).body.data;
    await expect(db.update(t.providerAutopayAuthorizations)
      .set({ typedLegalName: "Changed Name" })
      .where(eq(t.providerAutopayAuthorizations.id, signed.id))).rejects.toThrow();
    await expect(db.delete(t.providerAutopayAuthorizationLabs)
      .where(eq(t.providerAutopayAuthorizationLabs.authorizationId, signed.id))).rejects.toThrow();
    await expect(db.delete(t.providerAutopayAuthorizations)
      .where(eq(t.providerAutopayAuthorizations.id, signed.id))).rejects.toThrow();
    const [unchanged] = await db.select().from(t.providerAutopayAuthorizations)
      .where(eq(t.providerAutopayAuthorizations.id, signed.id));
    const selectedLabs = await db.select().from(t.providerAutopayAuthorizationLabs)
      .where(eq(t.providerAutopayAuthorizationLabs.authorizationId, signed.id));
    expect(unchanged.typedLegalName).toBe("Ada Lovelace");
    expect(selectedLabs).toHaveLength(1);
  });
  it("serves private PDF and signature only to the relationship user", async () => {
    const signed = (await authPost("/api/provider/autopay-authorization").send(body())).body.data;
    expect((await authGet(`/api/provider/autopay-authorization/${signed.id}/download`)).headers["content-type"]).toMatch(/pdf/);
    expect((await authGet(`/api/provider/autopay-authorization/${signed.id}/signature`)).headers["content-type"]).toMatch(/image\/png/);
  });
  it("denies another tenant and rejects non-billing direct membership", async () => {
    const signed = (await authPost("/api/provider/autopay-authorization").send(body())).body.data;
    const foreign = rid("foreign").slice(0, 12);
    const r = await request(app).post("/api/auth/register").send({ username: foreign, password: "TestPass1!", email: `${foreign}@example.com`, userType: "provider", clientType: "mobile" });
    users.push(r.body.user.id);
    await db.update(t.users).set({ emailVerifiedAt: new Date() }).where(eq(t.users.id, r.body.user.id));
    const foreignGet = (path: string) => request(app).get(path).set("Authorization", `Bearer ${r.body.accessToken}`);
    expect((await foreignGet(`/api/provider/autopay-authorization/history?providerOrganizationId=${providerA}`)).status).toBe(403);
    expect((await foreignGet(`/api/provider/autopay-authorization/${signed.id}/download`)).status).toBe(403);
    expect((await foreignGet(`/api/provider/autopay-authorization/${signed.id}/signature`)).status).toBe(403);
    const noRole = await db.insert(t.organizationMemberships).values({ labId: providerA, userId: r.body.user.id, role: "user", status: "active" }).returning();
    const nonBillingGet = (path: string) =>
      request(app)
        .get(path)
        .set("Authorization", `Bearer ${r.body.accessToken}`)
        .set("x-provider-organization-id", providerA);
    expect((await nonBillingGet(`/api/provider/autopay-authorization/prepare?providerOrganizationId=${providerA}`)).status).toBe(403);
    expect((await nonBillingGet(`/api/provider/autopay-authorization/current?providerOrganizationId=${providerA}`)).status).toBe(403);
    expect((await nonBillingGet(`/api/provider/autopay-authorization/history?providerOrganizationId=${providerA}`)).status).toBe(403);
    expect((await nonBillingGet(`/api/provider/autopay-authorization/${signed.id}/download`)).status).toBe(403);
    expect((await nonBillingGet(`/api/provider/autopay-authorization/${signed.id}/signature`)).status).toBe(403);
    const denied = await request(app)
      .post("/api/provider/autopay-authorization")
      .set("Authorization", `Bearer ${r.body.accessToken}`)
      .set("x-provider-organization-id", providerA)
      .send(body());
    expect(denied.status).toBe(403);
    await db.delete(t.organizationMemberships).where(eq(t.organizationMemberships.id, noRole[0].id));
  });

  it("creates an in-person request with a token and never sends email", async () => {
    const response = await labPost("/api/provider/autopay-authorization/requests")
      .send(requestBody({ deliveryMode: "in_person" }));
    expect(response.status).toBe(201);
    expect(response.body.data.deliveryMode).toBe("in_person");
    expect(response.body.data.mailSent).toBe(false);
    expect(response.body.data.requestToken).toMatch(/^[a-f0-9-]{40,}$/);
  });

  it("requires a recipient for explicit email delivery", async () => {
    const response = await labPost("/api/provider/autopay-authorization/requests")
      .send(requestBody({ deliveryMode: "email" }));
    expect(response.status).toBe(400);
  });

  it("cancels and clears a request when email delivery fails", async () => {
    sendMailMock.mockResolvedValueOnce({ sent: false, reason: "smtp unavailable" });
    const response = await labPost("/api/provider/autopay-authorization/requests")
      .send(requestBody({ deliveryMode: "email", recipientEmail: "provider@example.com" }));
    expect(response.status).toBe(503);
    const [failed] = await db.select().from(t.providerAutopayAuthorizationRequests)
      .where(eq(t.providerAutopayAuthorizationRequests.recipientEmail, "provider@example.com"))
      .orderBy(desc(t.providerAutopayAuthorizationRequests.createdAt)).limit(1);
    expect(failed.status).toBe("cancelled");
    expect(failed.tokenHash).toBeNull();
  });

  it("does not expose an emailed request token outside test mode", async () => {
    const previous = process.env.VITEST;
    process.env.VITEST = "";
    try {
      const response = await labPost("/api/provider/autopay-authorization/requests")
        .send(requestBody({ recipientEmail: "provider@example.com", deliveryMode: "email" }));
      expect(response.status).toBe(201);
      expect(response.body.data.mailSent).toBe(true);
      expect(response.body.data).not.toHaveProperty("requestToken");
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it("returns frozen terms, completes a request, and rejects token reuse", async () => {
    const created = (await labPost("/api/provider/autopay-authorization/requests")
      .send(requestBody({ deliveryMode: "in_person", labBills: true, labOrganizationIds: [labA], labChargeDay: 5 }))).body.data;
    const fetched = await authGet(`/api/provider/autopay-authorization/requests/${created.id}`);
    expect(fetched.body.data.agreementText).toBe(terms.agreementText);
    expect(fetched.body.data.agreementSha256).toBe(terms.agreementSha256);
    const labListing = await labGet(`/api/provider/autopay-authorization/requests?labOrganizationId=${labA}&providerOrganizationId=${providerA}`);
    expect(labListing.status).toBe(200);
    expect(labListing.body.data.some((item: any) => item.id === created.id)).toBe(true);
    expect(fetched.body.data.labOrganizationIds).toEqual([labA]);
    expect(fetched.body.data.labs).toEqual([{ labOrganizationId: labA, labName: expect.any(String) }]);
    expect(fetched.body.data.labChargeDay).toBe(5);
    const completed = await authPost("/api/provider/autopay-authorization").send(body({
      requestId: created.id, requestToken: created.requestToken, labBills: true,
      labOrganizationIds: [labA], labChargeDay: 5,
    }));
    expect(completed.status).toBe(201);
    const reused = await authPost("/api/provider/autopay-authorization").send(body({
      requestId: created.id, requestToken: created.requestToken, labBills: true,
      labOrganizationIds: [labA], labChargeDay: 5,
    }));
    expect(reused.status).toBe(404);
  });

  it("rejects completion of cancelled and expired requests, including expiry cancellation", async () => {
    const cancelled = (await labPost("/api/provider/autopay-authorization/requests")
      .send(requestBody({ deliveryMode: "in_person" }))).body.data;
    expect((await labPost(`/api/provider/autopay-authorization/requests/${cancelled.id}/cancel`)).status).toBe(200);
    expect((await authPost("/api/provider/autopay-authorization").send(body({
      requestId: cancelled.id, requestToken: cancelled.requestToken,
    }))).status).toBe(409);

    const expired = (await labPost("/api/provider/autopay-authorization/requests")
      .send(requestBody({ deliveryMode: "in_person" }))).body.data;
    await db.update(t.providerAutopayAuthorizationRequests).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(t.providerAutopayAuthorizationRequests.id, expired.id));
    expect((await authPost("/api/provider/autopay-authorization").send(body({
      requestId: expired.id, requestToken: expired.requestToken,
    }))).status).toBe(410);
    expect((await labPost(`/api/provider/autopay-authorization/requests/${expired.id}/cancel`)).status).toBe(410);
  });

  it("does not let a lab account sign even with provider billing membership", async () => {
    const membership = await db.insert(t.organizationMemberships).values({
      labId: providerA, userId: labUserId, role: "billing", status: "active",
    }).returning({ id: t.organizationMemberships.id });
    const response = await labPost("/api/provider/autopay-authorization").send(body());
    expect(response.status).toBe(403);
    await db.delete(t.organizationMemberships).where(eq(t.organizationMemberships.id, membership[0].id));
  });

  it("keeps every provider auto-pay resource inside the selected practice", async () => {
    const requestId = rid("breq");
    const requestToken = randomBytes(32).toString("hex");
    await db.insert(t.providerAutopayAuthorizationRequests).values({
      id: requestId, providerOrganizationId: providerB, labOrganizationId: labB,
      requestedByUserId: userId, agreementVersion: terms.agreementVersion,
      agreementText: terms.agreementText, agreementSha256: terms.agreementSha256,
      subscriptionFees: true, labBills: false, labOrganizationIds: [], tokenHash: createHash("sha256").update(requestToken).digest("hex"),
      expiresAt: new Date(Date.now() + 86400000), cardBrand: "visa", cardLast4: "4242",
      cardExpMonth: 12, cardExpYear: 2030, cardStatus: "active",
    });
    const authId = rid("bauth");
    const signatureKey = `provider-autopay/${authId}/signature`;
    const documentKey = `provider-autopay/${authId}/authorization.pdf`;
    objects.set(signatureKey, { body: Buffer.from(png, "base64"), type: "image/png" });
    objects.set(documentKey, { body: Buffer.from("pdf"), type: "application/pdf" });
    await db.insert(t.providerAutopayAuthorizations).values({
      id: authId, providerOrganizationId: providerB, agreementVersion: terms.agreementVersion,
      agreementText: terms.agreementText, agreementSha256: terms.agreementSha256,
      subscriptionFees: true, labBills: false, signerUserId: userId, typedLegalName: "Ada Lovelace",
      consent: true, signerIp: "127.0.0.1", signerUserAgent: "vitest", signedAt: new Date(),
      signatureObjectKey: signatureKey, signatureChecksum: "a".repeat(64),
      documentObjectKey: documentKey, documentChecksum: "b".repeat(64),
      cardBrand: "visa", cardLast4: "4242", cardExpMonth: 12, cardExpYear: 2030, cardStatus: "active",
    });

    expect((await authGet(`/api/provider/autopay-authorization/prepare?providerOrganizationId=${providerB}`)).status).toBe(403);
    expect((await authGet(`/api/provider/autopay-authorization/current?providerOrganizationId=${providerB}`)).status).toBe(403);
    expect((await authGet(`/api/provider/autopay-authorization/history?providerOrganizationId=${providerB}`)).status).toBe(403);
    expect((await authGet(`/api/provider/autopay-authorization/requests?providerOrganizationId=${providerB}`)).status).toBe(403);
    expect((await authGet(`/api/provider/autopay-authorization/requests/${requestId}`)).status).toBe(403);
    expect((await authPost("/api/provider/autopay-authorization").send(body({ providerOrganizationId: providerB }))).status).toBe(403);
    expect((await authGet(`/api/provider/autopay-authorization/${authId}/download`)).status).toBe(404);
    expect((await authGet(`/api/provider/autopay-authorization/${authId}/signature`)).status).toBe(404);
    expect((await labGet(`/api/provider/autopay-authorization/requests?labOrganizationId=${labB}&providerOrganizationId=${providerB}`)).status).toBe(403);

    const switchedGet = (path: string) => request(app).get(path)
      .set("Authorization", `Bearer ${token}`).set("x-provider-organization-id", providerB);
    expect((await switchedGet(`/api/provider/autopay-authorization/prepare?providerOrganizationId=${providerB}`)).status).toBe(200);
    expect((await switchedGet(`/api/provider/autopay-authorization/requests/${requestId}`)).status).toBe(200);
    expect((await switchedGet(`/api/provider/autopay-authorization/${authId}/download`)).status).toBe(200);
    expect((await switchedGet(`/api/provider/autopay-authorization/${authId}/signature`)).status).toBe(200);
  });
});