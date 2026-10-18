import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: "/tmp/labtrax-shared-provider-account-test",
  extractMediaFileName: () => null,
}));
vi.mock("../lib/stripeClient.js", () => ({
  getUncachableStripeClient: vi.fn().mockResolvedValue(null),
  constructStripeEvent: vi.fn(),
  isStripeConfigured: vi.fn().mockResolvedValue(false),
  logStripeAccountOwnership: vi.fn().mockResolvedValue(undefined),
}));

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
const rid = (prefix: string) =>
  `${prefix}_${randomBytes(7).toString("hex")}`;

maybe("shared provider account synchronization", () => {
  let app: Express;
  let tables: typeof import("@workspace/db");
  let auth: typeof import("../lib/auth.js");
  let labUserId: string;
  let providerUserId: string;
  let outsiderUserId: string;
  let labOrganizationId: string;
  let providerOrganizationId: string;
  let labToken: string;
  let providerToken: string;
  let outsiderToken: string;

  async function tokenFor(userId: string) {
    const sessionId = rid("sess");
    const refresh = auth.signRefreshToken(userId, sessionId);
    await tables.db.insert(tables.userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(refresh).digest("hex"),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return auth.signAccessToken(userId, sessionId);
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "shared-provider-account-test-secret";
    tables = await import("@workspace/db");
    auth = await import("../lib/auth.js");
    app = (await import("../app.js")).default;
    labUserId = rid("lab_user");
    providerUserId = rid("provider_user");
    outsiderUserId = rid("outsider");
    await tables.db.insert(tables.users).values([
      { id: labUserId, username: rid("lab"), password: "unused" },
      {
        id: providerUserId,
        username: rid("provider"),
        password: "unused",
        userType: "provider",
      },
      { id: outsiderUserId, username: rid("outside"), password: "unused" },
    ]);
    [labOrganizationId] = (
      await tables.db
        .insert(tables.organizations)
        .values({ type: "lab", name: rid("Lab") })
        .returning({ id: tables.organizations.id })
    ).map((row) => row.id);
    [providerOrganizationId] = (
      await tables.db
        .insert(tables.organizations)
        .values({
          type: "provider",
          name: "Shared Practice",
          billingEmail: "current@example.com",
          parentLabOrganizationId: labOrganizationId,
        })
        .returning({ id: tables.organizations.id })
    ).map((row) => row.id);
    await tables.db.insert(tables.organizationMemberships).values([
      {
        labId: labOrganizationId,
        userId: labUserId,
        role: "owner",
        status: "active",
      },
      {
        labId: providerOrganizationId,
        userId: providerUserId,
        role: "owner",
        status: "active",
      },
    ]);
    await tables.db.insert(tables.providerPaymentCustomers).values({
      providerOrganizationId,
      stripeCustomerId: rid("cus"),
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2032,
      cardStatus: "active",
      cardUpdatedAt: new Date(),
    });
    [labToken, providerToken, outsiderToken] = await Promise.all([
      tokenFor(labUserId),
      tokenFor(providerUserId),
      tokenFor(outsiderUserId),
    ]);
  });

  afterAll(async () => {
    if (!process.env.DATABASE_URL) return;
    const userIds = [labUserId, providerUserId, outsiderUserId];
    await tables.db
      .delete(tables.providerAccountChangeRequests)
      .where(
        eq(
          tables.providerAccountChangeRequests.providerOrganizationId,
          providerOrganizationId,
        ),
      );
    await tables.db
      .delete(tables.notifications)
      .where(inArray(tables.notifications.userId, userIds));
    await tables.db
      .delete(tables.auditLogs)
      .where(inArray(tables.auditLogs.userId, userIds));
    await tables.db
      .delete(tables.providerPaymentCustomers)
      .where(
        eq(
          tables.providerPaymentCustomers.providerOrganizationId,
          providerOrganizationId,
        ),
      );
    await tables.db
      .delete(tables.organizationMemberships)
      .where(
        inArray(tables.organizationMemberships.labId, [
          providerOrganizationId,
          labOrganizationId,
        ]),
      );
    await tables.db
      .delete(tables.organizations)
      .where(eq(tables.organizations.id, providerOrganizationId));
    await tables.db
      .delete(tables.organizations)
      .where(eq(tables.organizations.id, labOrganizationId));
    await tables.db
      .delete(tables.userSessions)
      .where(inArray(tables.userSessions.userId, userIds));
    await tables.db.delete(tables.users).where(inArray(tables.users.id, userIds));
  });

  const read = (token: string) =>
    request(app)
      .get("/api/organizations/shared-accounts")
      .set("Authorization", `Bearer ${token}`)
      .query({ labOrganizationId, providerOrganizationId });

  it("returns the same masked contact/card projection to both sides and isolates outsiders", async () => {
    const [lab, provider, outsider] = await Promise.all([
      read(labToken),
      read(providerToken),
      read(outsiderToken),
    ]);
    expect(lab.status).toBe(200);
    expect(provider.status).toBe(200);
    expect(provider.body.data.contact).toEqual(lab.body.data.contact);
    expect(lab.body.data.card).toMatchObject({
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2032,
      status: "active",
      source: "processor",
    });
    expect(JSON.stringify(lab.body)).not.toMatch(/stripe|payment.?method|cus_/i);
    expect(outsider.status).toBe(403);
  });

  it("keeps contact changes pending, idempotent, counterpart-approved, and rejects card input", async () => {
    const directPatch = await request(app)
      .patch(`/api/organizations/${providerOrganizationId}`)
      .set("Authorization", `Bearer ${labToken}`)
      .send({ billingEmail: "bypass@example.com" });
    expect(directPatch.status).toBe(409);

    const payload = {
      labOrganizationId,
      providerOrganizationId,
      clientRequestId: rid("idem"),
      changes: { billingEmail: "approved@example.com" },
    };
    const first = await request(app)
      .post("/api/organizations/shared-accounts/profile-change-requests")
      .set("Authorization", `Bearer ${labToken}`)
      .send(payload);
    const duplicate = await request(app)
      .post("/api/organizations/shared-accounts/profile-change-requests")
      .set("Authorization", `Bearer ${labToken}`)
      .send(payload);
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.id).toBe(first.body.data.id);

    const forbiddenCard = await request(app)
      .post("/api/organizations/shared-accounts/profile-change-requests")
      .set("Authorization", `Bearer ${labToken}`)
      .send({
        labOrganizationId,
        providerOrganizationId,
        changes: { cardNumber: "4242424242424242" },
      });
    expect(forbiddenCard.status).toBe(400);

    const approved = await request(app)
      .post(
        `/api/organizations/shared-accounts/profile-change-requests/${first.body.data.id}/approve`,
      )
      .set("Authorization", `Bearer ${providerToken}`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("approved");
    expect((await read(labToken)).body.data.contact.billingEmail).toBe(
      "approved@example.com",
    );
    expect(
      (
        await request(app)
          .post(
            `/api/organizations/shared-accounts/profile-change-requests/${first.body.data.id}/approve`,
          )
          .set("Authorization", `Bearer ${providerToken}`)
      ).status,
    ).toBe(200);
  });

  it("marks a decision stale instead of overwriting a newer contact value", async () => {
    const created = await request(app)
      .post("/api/organizations/shared-accounts/profile-change-requests")
      .set("Authorization", `Bearer ${labToken}`)
      .send({
        labOrganizationId,
        providerOrganizationId,
        changes: { phone: "555-0101" },
      });
    expect(created.status).toBe(201);
    await tables.db
      .update(tables.organizations)
      .set({ city: "Newer City", updatedAt: new Date() })
      .where(eq(tables.organizations.id, providerOrganizationId));
    const decision = await request(app)
      .post(
        `/api/organizations/shared-accounts/profile-change-requests/${created.body.data.id}/approve`,
      )
      .set("Authorization", `Bearer ${providerToken}`);
    expect(decision.status).toBe(409);
    const [row] = await tables.db
      .select()
      .from(tables.providerAccountChangeRequests)
      .where(eq(tables.providerAccountChangeRequests.id, created.body.data.id));
    expect(row.status).toBe("stale");
    const decisions = await tables.db
      .select()
      .from(tables.notifications)
      .where(eq(tables.notifications.userId, labUserId));
    expect(
      decisions.some(
        (notification) => {
          const dataJson = notification.dataJson;
          return (
            notification.type === "provider_account_change_decided" &&
            typeof dataJson === "object" &&
            dataJson !== null &&
            "requestId" in dataJson &&
            dataJson.requestId === created.body.data.id &&
            notification.title.includes("out of date")
          );
        },
      ),
    ).toBe(true);
  });

  it("does not let one dual-admin identity approve its own proposal", async () => {
    await tables.db.insert(tables.organizationMemberships).values({
      labId: labOrganizationId,
      userId: providerUserId,
      role: "admin",
      status: "active",
    });
    try {
      const created = await request(app)
        .post("/api/organizations/shared-accounts/profile-change-requests")
        .set("Authorization", `Bearer ${providerToken}`)
        .send({
          labOrganizationId,
          providerOrganizationId,
          changes: { phone: "555-0199" },
        });
      expect(created.status).toBe(201);
      const decision = await request(app)
        .post(
          `/api/organizations/shared-accounts/profile-change-requests/${created.body.data.id}/approve`,
        )
        .set("Authorization", `Bearer ${providerToken}`);
      expect(decision.status).toBe(403);
      expect((await read(providerToken)).body.data.contact.phone).not.toBe(
        "555-0199",
      );
    } finally {
      await tables.db
        .delete(tables.organizationMemberships)
        .where(
          and(
            eq(tables.organizationMemberships.labId, labOrganizationId),
            eq(tables.organizationMemberships.userId, providerUserId),
          ),
        );
    }
  });
});