/**
 * Integration suite: GET /api/cases/recent
 *
 * Covers:
 *   (a) sort order reflects updatedAt, not createdAt
 *   (b) summary string is correct for the major event types
 *   (c) cases with no caseEvents rows return latestEvent: null
 *   (d) completed cases (delivered / cancelled / complete) are excluded
 *
 * Response envelope: { ok: true, data: T[] } via ok().
 * Skipped when DATABASE_URL is not configured.
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-recent-cases"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("GET /api/cases/recent", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const practiceId = rid("prov");
  const userId = rid("urc");

  // Cases inserted by this suite
  const olderCaseId = rid("older");
  const newerUpdatedCaseId = rid("newer");
  const noEventsCaseId = rid("noevt");
  const completedCaseId = rid("done");

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

  async function fetchRecent(): Promise<any[]> {
    const res = await request(appMod.default)
      .get("/api/cases/recent")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.data ?? []) as any[];
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-recent-cases"), {
      recursive: true,
    });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-recent";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships, cases, caseEvents } =
      dbMod as any;

    await db.insert(users).values([
      { id: userId, username: `rcnt_${userId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Recent Cases Test Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Recent Cases Test Practice",
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

    // Case A: older createdAt, older updatedAt — should sort BELOW Case B.
    await db.insert(cases).values({
      id: olderCaseId,
      caseNumber: "26-RCT-OLD",
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Old",
      patientFirstName: "Pat",
      patientLastName: "Old",
      status: "received",
      createdByUserId: userId,
      createdAt: new Date("2026-01-01T08:00:00.000Z"),
      updatedAt: new Date("2026-01-02T08:00:00.000Z"),
    });

    // Case B: older createdAt but NEWER updatedAt — should sort ABOVE Case A.
    await db.insert(cases).values({
      id: newerUpdatedCaseId,
      caseNumber: "26-RCT-NEW",
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. New",
      patientFirstName: "Pat",
      patientLastName: "New",
      status: "in_design",
      createdByUserId: userId,
      createdAt: new Date("2026-01-01T07:00:00.000Z"),
      updatedAt: new Date("2026-06-15T12:00:00.000Z"),
    });

    // Case C: active case with no caseEvents rows.
    await db.insert(cases).values({
      id: noEventsCaseId,
      caseNumber: "26-RCT-NOEV",
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. NoEvent",
      patientFirstName: "Pat",
      patientLastName: "NoEvent",
      status: "received",
      createdByUserId: userId,
      createdAt: new Date("2026-03-01T08:00:00.000Z"),
      updatedAt: new Date("2026-03-01T08:00:00.000Z"),
    });

    // Case D: completed — must NOT appear in /recent.
    await db.insert(cases).values({
      id: completedCaseId,
      caseNumber: "26-RCT-DONE",
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Done",
      patientFirstName: "Pat",
      patientLastName: "Done",
      status: "delivered",
      createdByUserId: userId,
      createdAt: new Date("2026-06-20T08:00:00.000Z"),
      updatedAt: new Date("2026-06-20T09:00:00.000Z"),
    });

    // Event for Case A: a status_changed event.
    await db.insert(caseEvents).values({
      id: rid("ev"),
      caseId: olderCaseId,
      eventType: "status_changed",
      actorUserId: userId,
      actorOrganizationId: labOrgId,
      actorInitials: "Dr",
      metadataJson: { from: "received", to: "in_design" },
      occurredAt: new Date("2026-01-02T09:00:00.000Z"),
    });

    // Event for Case B: a location_changed event (most recent for sorting).
    await db.insert(caseEvents).values({
      id: rid("ev"),
      caseId: newerUpdatedCaseId,
      eventType: "location_changed",
      actorUserId: userId,
      actorOrganizationId: labOrgId,
      actorInitials: "Dr",
      metadataJson: { locationName: "Scanning" },
      occurredAt: new Date("2026-06-15T12:00:00.000Z"),
    });

    // Older event for Case B: should NOT appear (only latest).
    await db.insert(caseEvents).values({
      id: rid("ev"),
      caseId: newerUpdatedCaseId,
      eventType: "case_created",
      actorUserId: userId,
      actorOrganizationId: labOrgId,
      actorInitials: "Dr",
      metadataJson: {},
      occurredAt: new Date("2026-01-01T07:00:00.000Z"),
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
      caseEvents,
      invoices,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(caseEvents).where(
      inArray(caseEvents.caseId, [olderCaseId, newerUpdatedCaseId, noEventsCaseId, completedCaseId]),
    );
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, practiceId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns only non-completed cases", async () => {
    const list = await fetchRecent();
    const ids = list.map((c: any) => c.id);
    expect(ids).not.toContain(completedCaseId);
    expect(ids).toContain(olderCaseId);
    expect(ids).toContain(newerUpdatedCaseId);
    expect(ids).toContain(noEventsCaseId);
  });

  it("sorts by updatedAt DESC, not createdAt", async () => {
    const list = await fetchRecent();
    const ours = list.filter((c: any) =>
      [olderCaseId, newerUpdatedCaseId].includes(c.id),
    );
    expect(ours.length).toBe(2);
    const newerIdx = ours.findIndex((c: any) => c.id === newerUpdatedCaseId);
    const olderIdx = ours.findIndex((c: any) => c.id === olderCaseId);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("returns correct summary for status_changed event", async () => {
    const list = await fetchRecent();
    const found = list.find((c: any) => c.id === olderCaseId);
    expect(found, "older case must appear").toBeTruthy();
    expect(found.latestEvent).not.toBeNull();
    expect(found.latestEvent.eventType).toBe("status_changed");
    expect(found.latestEvent.summary).toBe("Status → in_design");
  });

  it("returns correct summary for location_changed event", async () => {
    const list = await fetchRecent();
    const found = list.find((c: any) => c.id === newerUpdatedCaseId);
    expect(found, "newer case must appear").toBeTruthy();
    expect(found.latestEvent).not.toBeNull();
    expect(found.latestEvent.eventType).toBe("location_changed");
    expect(found.latestEvent.summary).toBe("Moved to Scanning");
  });

  it("returns latestEvent: null for cases with no caseEvents rows", async () => {
    const list = await fetchRecent();
    const found = list.find((c: any) => c.id === noEventsCaseId);
    expect(found, "no-events case must appear").toBeTruthy();
    expect(found.latestEvent).toBeNull();
  });

  it("picks the most recent event, not the oldest, for cases with multiple events", async () => {
    const list = await fetchRecent();
    const found = list.find((c: any) => c.id === newerUpdatedCaseId);
    // Case B has two events: location_changed (newer) and case_created (older).
    // The endpoint must return the location_changed event, not case_created.
    expect(found.latestEvent.eventType).toBe("location_changed");
    expect(found.latestEvent.summary).toBe("Moved to Scanning");
  });
});
