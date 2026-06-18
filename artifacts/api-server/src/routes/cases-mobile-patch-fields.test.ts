/**
 * Regression test: PATCH /api/cases/:id persists editable fields for
 * mobile-originated cases (lab_cases JSON blob).
 *
 * Before the fix, the mobile-case PATCH branch only handled `input.status`;
 * every other field — casePanBarcode, doctorName, patientFirstName,
 * patientLastName, priority, dueDate — was silently ignored even though the
 * server returned 200 OK.
 *
 * These tests insert a raw lab_cases row, PATCH it via the canonical
 * PATCH /api/cases/:id endpoint, then GET /api/cases/:id and assert the
 * projected field matches what was sent.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-mobile-patch"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("PATCH /api/cases/:id — mobile-origin (lab_cases) field persistence", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const seededCaseIds: string[] = [];
  let token = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return t;
  }

  async function seedMobileCase(extra: Record<string, unknown> = {}): Promise<string> {
    const { db, labCases } = dbMod as any;
    const caseId = `mobpatch_${randomBytes(8).toString("hex")}`;
    const caseData = JSON.stringify({
      patientName: "Jane Doe",
      doctorName: "Dr. Original",
      status: "INTAKE",
      isRush: false,
      dueDate: null,
      assignedBarcode: null,
      ...extra,
    });
    await db.insert(labCases).values({
      id: caseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData,
    });
    seededCaseIds.push(caseId);
    return caseId;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-mobile-patch";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `mobpatch_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("MobilePatchLab") },
    ]);

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: labOwnerId,
      role: "owner",
      status: "active",
      approvedByUserId: labOwnerId,
      joinedAt: new Date(),
    });

    token = await makeSession(labOwnerId);
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    token = await makeSession(labOwnerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, labCases, userSessions, organizationMemberships, organizations, users } =
      dbMod as any;

    if (seededCaseIds.length) {
      await db.delete(labCases).where(inArray(labCases.id, seededCaseIds));
    }
    await db.delete(userSessions).where(eq(userSessions.userId, labOwnerId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, labOwnerId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, labOwnerId));
  });

  it("persists casePanBarcode and returns it in the PATCH response", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ casePanBarcode: "BC-2026-001" });

    expect(patch.status).toBe(200);
    expect(patch.body?.data?.casePanBarcode).toBe("BC-2026-001");
  });

  it("GET /api/cases/:id reflects the persisted barcode after PATCH", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ casePanBarcode: "BC-2026-002" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.casePanBarcode).toBe("BC-2026-002");
    expect(get.body?.data?._source).toBe("mobile");
  });

  it("persists doctorName via PATCH", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ doctorName: "Dr. Updated" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.doctorName).toBe("Dr. Updated");
  });

  it("persists patientFirstName and patientLastName via PATCH", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ patientFirstName: "Alice", patientLastName: "Smith" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.patientFirstName).toBe("Alice");
    expect(get.body?.data?.patientLastName).toBe("Smith");
  });

  it("persists priority (rush) via PATCH", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "rush" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.priority).toBe("rush");
  });

  it("persists dueDate via PATCH", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ dueDate: "2026-12-31" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(get.status).toBe(200);
    // The detail projector converts the stored date string through Date.parse()
    // and returns a full ISO timestamp; assert the date portion is correct.
    expect(get.body?.data?.dueDate).toMatch(/^2026-12-31/);
  });

  it("clears barcode when status is set to complete", async () => {
    const caseId = await seedMobileCase({ assignedBarcode: "BC-CLEAR-ME" });

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "complete" });

    expect(patch.status).toBe(200);
    expect(patch.body?.data?.casePanBarcode).toBeNull();

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.casePanBarcode).toBeNull();
  });
});
