/**
 * Regression suite: Lab station ("location") management + moving cases to a
 * CUSTOM station.
 *
 * Protected workflow: "Locate case" (desktop/mobile station tracking).
 *
 * Root cause this guards: a custom station must map to a valid case-status
 * (`status`) enum value so that locating a case at it writes a status the case
 * PATCH / bulk-status handlers accept. The original bug let a custom station
 * carry a free-form `code` that was sent as the status, which the server
 * rejected — the move failed silently. The fix requires `status` (validated
 * against the enum) on create/patch and the clients send the mapped `status`,
 * never the free-form `code`.
 *
 * Coverage:
 *   (1) POST /api/locations creates a custom station with a mapped stage and
 *       returns a valid case-status `status`.
 *   (2) POST /api/locations rejects an invalid (non-enum) status (the bug guard).
 *   (3) GET /api/locations?activeOnly=true returns the custom station.
 *   (4) Moving a case to the custom station's mapped stage via
 *       POST /api/cases/bulk-status succeeds with an accurate updatedCount.
 *   (5) Auth guard — unauthenticated client cannot create a station.
 *
 * Response envelope: all routes return { ok: true, data: T } via ok().
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-locations"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("Lab locations — custom-station move regression", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const userId = rid("ulocstn");
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

  /** Simulate a mobile-originated case so we have one to move. */
  async function syncCase(caseId: string, status: string) {
    const caseBlob = {
      id: caseId,
      caseNumber: `26-STN-${caseId.slice(-4)}`,
      patientName: "Test Patient",
      doctorName: "Dr. Test",
      toothIndices: "#8",
      material: "Zirconia",
      status,
      affiliationKey: `org:${labOrgId}`,
    };
    return request(appMod.default)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: caseId, ownerId: userId, caseData: JSON.stringify(caseBlob) });
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-locations"), {
      recursive: true,
    });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-locations";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;
    await db.insert(users).values([
      { id: userId, username: `locstn_${userId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Custom Station Test Lab" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId, role: "admin", status: "active" },
    ]);
    token = await makeSession(userId);
  });

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
      labCases,
      labLocations,
      invoices,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(labLocations)
      .where(eq(labLocations.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  // ── (1) Create a custom station mapped to a built-in stage ────────────────
  it("(1) POST /api/locations creates a custom station with a valid mapped status", async () => {
    const res = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: "Glaze Bench", status: "qc" });

    expect(res.status).toBe(201);
    expect(res.body.data?.name).toBe("Glaze Bench");
    // The mapped stage is a valid case-status enum value, not the free-form code.
    expect(res.body.data?.status).toBe("qc");
    expect(typeof res.body.data?.id).toBe("string");
    expect((res.body.data?.id as string).length).toBeGreaterThan(0);
  });

  // ── (2) Invalid status is rejected (the original silent-failure bug) ──────
  it("(2) POST /api/locations rejects a non-enum status", async () => {
    const res = await request(appMod.default)
      .post("/api/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: labOrgId, name: "Bad Station", status: "glaze" });

    expect(res.status).toBe(400);
  });

  // ── (3) GET returns the custom station ────────────────────────────────────
  it("(3) GET /api/locations returns the created custom station", async () => {
    const res = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}&activeOnly=true`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const rows: any[] = res.body.data ?? [];
    const custom = rows.find((r) => r.name === "Glaze Bench");
    expect(custom, "custom station must be listed").toBeTruthy();
    expect(custom.status).toBe("qc");
  });

  // ── (4) Moving a case to the custom station's stage succeeds ──────────────
  it("(4) POST /api/cases/bulk-status moves a case to the custom station's stage", async () => {
    const caseId = rid("cstn");
    expect((await syncCase(caseId, "INTAKE")).status).toBe(200);

    // Read the custom station's mapped status from the API (what the client sends).
    const list = await request(appMod.default)
      .get(`/api/locations?organizationId=${labOrgId}&activeOnly=true`)
      .set("Authorization", `Bearer ${token}`);
    const custom = (list.body.data as any[]).find((r) => r.name === "Glaze Bench");
    expect(custom).toBeTruthy();

    const move = await request(appMod.default)
      .post("/api/cases/bulk-status")
      .set("Authorization", `Bearer ${token}`)
      .send({ caseIds: [caseId], status: custom.status });

    expect(move.status).toBe(200);
    // Accurate result count: exactly one case moved, none silently missed.
    expect(move.body.data?.updatedCount).toBe(1);
    expect(move.body.data?.updatedIds).toContain(caseId);
  });

  // ── (5) Auth guard ────────────────────────────────────────────────────────
  it("(5) POST /api/locations requires authentication", async () => {
    const res = await request(appMod.default)
      .post("/api/locations")
      .send({ organizationId: labOrgId, name: "No Auth", status: "qc" });
    expect(res.status).toBe(401);
  });
});
