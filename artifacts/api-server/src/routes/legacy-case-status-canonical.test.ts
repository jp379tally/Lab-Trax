/**
 * Regression test: mobile and server agree on canonical case statuses.
 *
 * The legacy mobile case endpoints bridge desktop/structured cases (the
 * `cases` table) into the mobile feed. They now return the canonical
 * lowercase status directly — the server no longer re-translates statuses to
 * the old UPPERCASE station tokens on the way out.
 *
 * These tests create a desktop/structured case via the canonical
 * POST /api/cases route, move it through a status change with PATCH, and then
 * assert that:
 *   - GET /api/legacy/cases returns the canonical lowercase status (e.g. `qc`,
 *     `shipped`) rather than an uppercased token.
 *   - GET /api/legacy/cases/:id returns the same canonical lowercase status.
 *   - The synthesized detail activityLog contains a status-change entry whose
 *     `station` field is the canonical lowercase status and whose description
 *     is human-readable ("Case moved to Quality Check").
 *
 * This locks in the simplification and prevents a future regression from
 * silently reintroducing the round-trip UPPERCASE translation.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-status"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Legacy case endpoints return canonical lowercase statuses", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const createdCaseIds: string[] = [];
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

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-status-canonical";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `statusowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("StatusTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("StatusTestPractice"),
        parentLabOrganizationId: labOrgId,
      },
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

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      caseEvents,
      caseNotes,
      invoices,
      cases: casesTable,
      auditLogs,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
    }
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(eq(userSessions.userId, labOwnerId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, labOwnerId));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  async function createCase(status: string): Promise<string> {
    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        caseNumber: rid("SC"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Status",
        patientLastName: "Test",
        doctorName: "Dr. Status",
        status,
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id as string;
    createdCaseIds.push(caseId);
    return caseId;
  }

  it("GET /api/legacy/cases returns the canonical lowercase status (no UPPERCASE round-trip)", async () => {
    // Create cases directly in a couple of canonical statuses and assert the
    // legacy bridge surfaces each one unchanged — lowercase, not uppercased.
    const qcCaseId = await createCase("qc");
    const shippedCaseId = await createCase("shipped");

    const list = await request(appMod.default)
      .get("/api/legacy/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);

    const byId = new Map<string, any>(
      (list.body.cases as any[]).map((c) => [c.id, c])
    );

    const qc = byId.get(qcCaseId);
    expect(qc).toBeDefined();
    expect(qc.status).toBe("qc");

    const shipped = byId.get(shippedCaseId);
    expect(shipped).toBeDefined();
    expect(shipped.status).toBe("shipped");
  });

  it("GET /api/legacy/cases/:id returns canonical lowercase status + a humanized status-change entry", async () => {
    // Create a case and move it to QC via PATCH so a status_changed event is
    // recorded, then verify the bridged detail uses canonical vocabulary.
    const caseId = await createCase("received");

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "qc" });
    expect(patch.status).toBe(200);

    const detail = await request(appMod.default)
      .get(`/api/legacy/cases/${encodeURIComponent(caseId)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);

    const fetched = detail.body.case;
    // Canonical lowercase status passes through unchanged.
    expect(fetched.status).toBe("qc");

    // The status change surfaces as an activity-log entry with a canonical
    // lowercase `station` and a human-readable description.
    const statusEntry = (fetched.activityLog as any[]).find(
      (e) => typeof e.station === "string"
    );
    expect(statusEntry).toBeDefined();
    expect(statusEntry.station).toBe("qc");
    expect(statusEntry.description).toBe("Case moved to Quality Check");
  });
});
