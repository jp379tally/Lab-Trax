/**
 * Regression suite: GET /api/cases must expose `receivedAt` on every row.
 *
 * The desktop Cases date-range filter (Today / 30 / 60 / 90 / Custom) matches
 * on the case's received date, falling back to the created date. If the list
 * endpoint ever stops returning `receivedAt`, the filter silently collapses
 * back to created-date behavior and the "Custom today→today shows no cases for
 * legacy/mobile cases" glitch returns. This suite pins that the field is
 * present on BOTH row shapes the endpoint emits:
 *   (1) canonical cases (the `cases` table, which has a real received_at column)
 *   (2) legacy/mobile-projected cases (bridged from `lab_cases`, where the
 *       received timestamp is synthesized from the row's updatedAt).
 *
 * Response envelope: all API routes return { ok: true, data: T } via ok().
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 * Self-contained: all inserted rows are removed in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-received-at"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("GET /api/cases — receivedAt presence on all row shapes", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const practiceId = rid("prov");
  const userId = rid("urcv");
  const canonicalCaseId = rid("canon");
  const legacyCaseId = rid("legacy");
  let token = "";

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return t;
  }

  async function fetchList(): Promise<any[]> {
    const res = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.data ?? []) as any[];
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-received-at"), {
      recursive: true,
    });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-received-at";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      labCases,
    } = dbMod as any;

    await db.insert(users).values([
      { id: userId, username: `rcv_${userId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Received-At Test Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Received-At Test Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId,
        role: "admin",
        status: "active",
      },
    ]);

    // (1) Canonical case: received today, created weeks earlier. The cases
    // table has a real received_at column (NOT NULL, defaults to now()), so we
    // set it explicitly to prove the value flows through unchanged.
    await db.insert(cases).values({
      id: canonicalCaseId,
      caseNumber: "26-RCV-CANON",
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Canon",
      patientFirstName: "Pat",
      patientLastName: "Canon",
      status: "received",
      createdByUserId: userId,
      receivedAt: new Date("2026-06-29T09:00:00.000Z"),
      createdAt: new Date("2026-06-01T09:00:00.000Z"),
    });

    // (2) Legacy/mobile case: bridged from lab_cases. No real received_at
    // column — the list endpoint synthesizes receivedAt from the row's
    // updatedAt, falling back to createdAt.
    const caseBlob = {
      id: legacyCaseId,
      caseNumber: "26-RCV-LEGACY",
      patientName: "Pat Legacy",
      doctorName: "Dr. Legacy",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
      createdAt: Date.parse("2026-06-01T09:00:00.000Z"),
      updatedAt: Date.parse("2026-06-29T11:00:00.000Z"),
    };
    await db.insert(labCases).values({
      id: legacyCaseId,
      ownerId: userId,
      organizationId: labOrgId,
      caseData: JSON.stringify(caseBlob),
      updatedAt: new Date("2026-06-29T11:00:00.000Z"),
    });

    token = await makeSession(userId);
  }, 60_000);

  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      labCases,
      invoices,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, practiceId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns receivedAt on the canonical case row", async () => {
    const list = await fetchList();
    const found = list.find((c) => c.id === canonicalCaseId);
    expect(found, "canonical case must appear in GET /api/cases").toBeTruthy();
    expect(found.receivedAt, "canonical row must expose receivedAt").toBeTruthy();
    // The explicit received_at we set is preserved (not overwritten by createdAt).
    expect(new Date(found.receivedAt).toISOString()).toBe(
      "2026-06-29T09:00:00.000Z",
    );
    // Sanity: received date differs from the (earlier) created date — the exact
    // shape the date-range filter relies on.
    expect(new Date(found.receivedAt).getTime()).toBeGreaterThan(
      new Date(found.createdAt).getTime(),
    );
  });

  it("returns a synthesized receivedAt on the legacy/mobile-projected row", async () => {
    const list = await fetchList();
    const found = list.find((c) => c.id === legacyCaseId);
    expect(found, "legacy case must appear in GET /api/cases").toBeTruthy();
    expect(found._source).toBe("mobile");
    expect(found.receivedAt, "legacy row must expose receivedAt").toBeTruthy();
    // Synthesized from the lab_cases row's updatedAt.
    expect(new Date(found.receivedAt).toISOString()).toBe(
      "2026-06-29T11:00:00.000Z",
    );
  });

  it("exposes receivedAt on every row the endpoint returns", async () => {
    const list = await fetchList();
    const ours = list.filter(
      (c) => c.id === canonicalCaseId || c.id === legacyCaseId,
    );
    expect(ours.length).toBe(2);
    for (const c of ours) {
      expect(c.receivedAt, `row ${c.id} missing receivedAt`).toBeTruthy();
      expect(Number.isNaN(new Date(c.receivedAt).getTime())).toBe(false);
    }
  });
});
