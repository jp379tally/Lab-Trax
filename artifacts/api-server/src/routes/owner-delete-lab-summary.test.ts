/**
 * Integration tests for GET /api/owner/delete-lab-summary
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - 401 when no auth token is provided
 *  - 403 when the caller is not an owner (admin role is not enough)
 *  - activeMembers counts only status="active" + not soft-deleted memberships
 *  - memberNames contains the correct member full names (falls back to username)
 *  - memberNames is capped at 5 and memberNamesOverflow reflects the remainder
 *  - openCases excludes status="complete" and status="cancelled" and
 *    soft-deleted case rows
 *  - unpaidInvoices excludes status="paid" and status="void" and
 *    soft-deleted invoice rows
 *  - unpaidInvoicesTotal sums balanceDue only for non-paid/non-void/non-deleted rows
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Tenant summaries are exercised after Creator authorization; exclusive
// account/PIN/session denials live in creator-auth.test.ts.
vi.mock("../lib/creator-auth", () => ({ requireCreator: [(_req: any, _res: any, next: any) => next()] }));
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-owner-summary"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET /api/owner/delete-lab-summary (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("u");
  const adminId = rid("u");
  const deletedMemberId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  let ownerToken = "";
  let adminToken = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(userId, sessionId);
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-owner-summary-test-secret";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
    authLib = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      invoices,
    } = dbMod as any;

    // ── Users ─────────────────────────────────────────────────────────────
    // firstName + lastName are set so memberNames returns "First Last" strings
    // rather than the username fallback — makes assertions deterministic.
    await db.insert(users).values([
      {
        id: ownerId,
        username: `ownsumm_own_${ownerId}`,
        password: "x",
        firstName: "Alice",
        lastName: "Owner",
      },
      {
        id: adminId,
        username: `ownsumm_adm_${adminId}`,
        password: "x",
        firstName: "Bob",
        lastName: "Admin",
      },
      { id: deletedMemberId, username: `ownsumm_del_${deletedMemberId}`, password: "x" },
    ]);

    // ── Orgs ──────────────────────────────────────────────────────────────
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("SummaryTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("SummaryTestPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    // ── Memberships ───────────────────────────────────────────────────────
    // Two active members (owner + admin) → activeMembers should equal 2.
    // One soft-deleted member → excluded from the count.
    const deletedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: deletedMemberId,
        role: "user",
        status: "active",
        deletedAt,
        deletedByUserId: ownerId,
      },
    ]);

    // ── Cases ─────────────────────────────────────────────────────────────
    // Open (counted):  draft, in_progress
    // Excluded:        complete, cancelled, soft-deleted draft
    // Expected openCases = 2
    const caseBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      doctorName: "Dr. Summary Test",
      patientFirstName: "Pat",
      patientLastName: "Summary",
      createdByUserId: ownerId,
    };
    const softDeletedCaseId = rid("c");
    await db.insert(cases).values([
      { id: rid("c"), caseNumber: rid("CN"), ...caseBase, status: "draft" },
      { id: rid("c"), caseNumber: rid("CN"), ...caseBase, status: "in_progress" },
      { id: rid("c"), caseNumber: rid("CN"), ...caseBase, status: "complete" },
      { id: rid("c"), caseNumber: rid("CN"), ...caseBase, status: "cancelled" },
      {
        id: softDeletedCaseId,
        caseNumber: rid("CN"),
        ...caseBase,
        status: "draft",
        deletedAt,
        deletedByUserId: ownerId,
      },
    ]);

    // ── Invoices ──────────────────────────────────────────────────────────
    // Unpaid (counted):  draft ($50.00), open ($75.00)
    // Excluded:          paid ($100.00), void ($25.00), soft-deleted open ($200.00)
    // Expected unpaidInvoices      = 2
    // Expected unpaidInvoicesTotal = "125.00"  (50 + 75)
    const invoiceBase = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      createdByUserId: ownerId,
    };
    const softDeletedInvoiceId = rid("inv");
    await db.insert(invoices).values([
      {
        id: rid("inv"),
        invoiceNumber: rid("INV"),
        ...invoiceBase,
        status: "draft",
        balanceDue: "50.00",
      },
      {
        id: rid("inv"),
        invoiceNumber: rid("INV"),
        ...invoiceBase,
        status: "open",
        balanceDue: "75.00",
      },
      {
        id: rid("inv"),
        invoiceNumber: rid("INV"),
        ...invoiceBase,
        status: "paid",
        balanceDue: "100.00",
      },
      {
        id: rid("inv"),
        invoiceNumber: rid("INV"),
        ...invoiceBase,
        status: "void",
        balanceDue: "25.00",
      },
      {
        id: softDeletedInvoiceId,
        invoiceNumber: rid("INV"),
        ...invoiceBase,
        status: "open",
        balanceDue: "200.00",
        deletedAt,
        deletedByUserId: ownerId,
      },
    ]);
  }, 60_000);

  beforeEach(async () => {
    ownerToken = await makeSession(ownerId);
    adminToken = await makeSession(adminId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      invoices,
      auditLogs,
      userSessions,
    } = dbMod as any;

    const allUserIds = [ownerId, adminId, deletedMemberId];
    const allOrgIds = [labOrgId, providerOrgId];

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, allOrgIds));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, allUserIds));
    await db.delete(userSessions).where(inArray(userSessions.userId, allUserIds));
    await db.delete(organizations).where(inArray(organizations.id, allOrgIds));
    await db.delete(users).where(inArray(users.id, allUserIds));
  });

  it("returns 401 when no auth token is provided", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(401);
  });

  it("returns 403 when the caller is an admin (not owner)", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(403);
  });

  it("returns correct activeMembers count (active + not soft-deleted only)", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // owner + admin = 2; soft-deleted member is excluded
    expect(r.body.data.activeMembers).toBe(2);
  });

  it("returns correct openCases count (excludes complete and cancelled)", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(200);
    // draft + in_progress = 2; complete, cancelled, and soft-deleted draft are excluded
    expect(r.body.data.openCases).toBe(2);
  });

  it("returns correct unpaidInvoices count (excludes paid and void)", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(200);
    // draft + open = 2; paid, void, and soft-deleted open are excluded
    expect(r.body.data.unpaidInvoices).toBe(2);
  });

  it("unpaidInvoicesTotal sums balanceDue of non-paid/non-void rows only", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(200);
    // draft ($50.00) + open ($75.00) = $125.00
    // paid ($100.00), void ($25.00), and soft-deleted open ($200.00) are excluded
    expect(r.body.data.unpaidInvoicesTotal).toBe("125.00");
  });

  it("memberNames contains the correct full names for all active members", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: labOrgId });
    expect(r.status).toBe(200);
    const { memberNames, memberNamesOverflow } = r.body.data;
    // Two active members: Alice Owner and Bob Admin.
    // Soft-deleted member is excluded.
    expect(Array.isArray(memberNames)).toBe(true);
    expect(memberNames).toContain("Alice Owner");
    expect(memberNames).toContain("Bob Admin");
    // Only 2 active members total; no overflow.
    expect(memberNamesOverflow).toBe(0);
  });

  it("returns 403 for an organizationId where the caller has no membership", async () => {
    const r = await request(appMod.default)
      .get("/api/owner/delete-lab-summary")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: rid("ghost") });
    // requireOwner fires before the org existence check, so a non-member org
    // (including a nonexistent one) always yields 403 rather than 404.
    expect(r.status).toBe(403);
  });

  // ── memberNamesOverflow: >5 members ────────────────────────────────────────
  // A separate fixture is used so this test is independent of the main fixture's
  // member count.  We seed one owner + 6 non-owner members (7 total), which
  // exceeds the server-side MEMBER_NAME_LIMIT of 5 by 2.

  describe("memberNamesOverflow when active members exceed the 5-name cap", () => {
    const overflowOwnerId = rid("oflown");
    const overflowMemberIds = Array.from({ length: 6 }, (_, i) => rid(`oflm${i}`));
    const overflowOrgId = rid("oflorg");

    let overflowOwnerToken = "";

    beforeAll(async () => {
      const { db, users, organizations, organizationMemberships } = dbMod as any;

      // Owner
      await db.insert(users).values({
        id: overflowOwnerId,
        username: `ofl_own_${overflowOwnerId}`,
        password: "x",
        firstName: "Overflow",
        lastName: "Owner",
      });

      // 6 regular members
      await db.insert(users).values(
        overflowMemberIds.map((id, i) => ({
          id,
          username: `ofl_mem${i}_${id}`,
          password: "x",
          firstName: `Member${i}`,
          lastName: "Overflow",
        }))
      );

      await db.insert(organizations).values({
        id: overflowOrgId,
        type: "lab",
        name: rid("OverflowLab"),
      });

      // Owner membership
      await db.insert(organizationMemberships).values({
        id: rid("om"),
        labId: overflowOrgId,
        userId: overflowOwnerId,
        role: "owner",
        status: "active",
      });

      // 6 active regular memberships
      await db.insert(organizationMemberships).values(
        overflowMemberIds.map((userId) => ({
          id: rid("om"),
          labId: overflowOrgId,
          userId,
          role: "user",
          status: "active",
        }))
      );
    }, 60_000);

    beforeEach(async () => {
      overflowOwnerToken = await makeSession(overflowOwnerId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const { db, users, organizations, organizationMemberships, userSessions, auditLogs } =
        dbMod as any;
      const allIds = [overflowOwnerId, ...overflowMemberIds];
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, overflowOrgId));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, allIds));
      await db.delete(userSessions).where(inArray(userSessions.userId, allIds));
      await db.delete(organizations).where(eq(organizations.id, overflowOrgId));
      await db.delete(users).where(inArray(users.id, allIds));
    });

    it("caps memberNames at 5 and sets memberNamesOverflow to the remainder", async () => {
      const r = await request(appMod.default)
        .get("/api/owner/delete-lab-summary")
        .set("Authorization", `Bearer ${overflowOwnerToken}`)
        .query({ organizationId: overflowOrgId });
      expect(r.status).toBe(200);
      const { activeMembers, memberNames, memberNamesOverflow } = r.body.data;
      // 1 owner + 6 members = 7 active total
      expect(activeMembers).toBe(7);
      // Server caps the name list at MEMBER_NAME_LIMIT (5)
      expect(memberNames).toHaveLength(5);
      // Remaining 2 are reported as overflow
      expect(memberNamesOverflow).toBe(2);
    });
  });
});
