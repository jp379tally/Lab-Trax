/**
 * Integration tests for the POST /:caseId/notes/:noteId/notify endpoint,
 * specifically verifying the `labtrax_only` method inserts in-app notifications
 * for all provider org members, and that non-shared notes are still rejected.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /:caseId/notes/:noteId/notify — labtrax_only (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const labUserId = rid("labuser");
  const providerUserId1 = rid("prov1");
  const providerUserId2 = rid("prov2");
  const caseId = rid("case");
  const noteId = rid("note");
  let labToken = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-note-notify";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const {
      db,
      organizations,
      organizationMemberships,
      cases,
      caseNotes,
      users,
    } = dbMod as any;

    await db.insert(users).values([
      {
        id: labUserId,
        username: `labuser_${labUserId}`,
        password: "x",
        userType: "lab",
        role: "admin",
        emailVerifiedAt: new Date(),
      },
      { id: providerUserId1, username: `prov1_${providerUserId1}`, password: "x", userType: "provider" },
      { id: providerUserId2, username: `prov2_${providerUserId2}`, password: "x", userType: "provider" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Notify Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Notify Test Provider",
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      { labId: labOrgId, userId: labUserId, role: "admin", status: "active" },
      { labId: providerOrgId, userId: providerUserId1, role: "admin", status: "active" },
      { labId: providerOrgId, userId: providerUserId2, role: "user", status: "active" },
    ]);
    await db.insert(cases).values({
      id: caseId,
      caseNumber: `NTF-${caseId.slice(-6)}`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      doctorName: "Dr. Notify",
      patientFirstName: "Alice",
      patientLastName: "Smith",
      status: "draft",
      createdByUserId: labUserId,
    });
    await db.insert(caseNotes).values({
      id: noteId,
      caseId,
      noteText: "Please check the shade on the crown.",
      visibility: "shared_with_provider",
      authorUserId: labUserId,
      authorOrganizationId: labOrgId,
    });

  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    labToken = await makeSession(labUserId);
  });

  afterAll(async () => {
    const { db, notifications, caseNotes, cases, organizationMemberships, organizations, users, userSessions } = dbMod as any;
    await db.delete(notifications).where(
      and(
        eq(notifications.type, "shared_note"),
        inArray(notifications.userId, [providerUserId1, providerUserId2]),
      )
    ).catch(() => {});
    await db.delete(caseNotes).where(eq(caseNotes.caseId, caseId)).catch(() => {});
    await db.delete(cases).where(eq(cases.id, caseId)).catch(() => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.labId, labOrgId)).catch(() => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.labId, providerOrgId)).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, providerOrgId)).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, labOrgId)).catch(() => {});
    await db.delete(users).where(inArray(users.id, [labUserId, providerUserId1, providerUserId2])).catch(() => {});
    await db.delete(userSessions).where(eq(userSessions.userId, labUserId)).catch(() => {});
  });

  it("returns 400 for an unknown method", async () => {
    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/notes/${noteId}/notify`)
      .set("Authorization", `Bearer ${labToken}`)
      .send({ method: "pigeon" });
    expect(res.status).toBe(400);
  });

  it("returns {ok:true} and inserts notifications for all provider members", async () => {
    const { db, notifications } = dbMod as any;

    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/notes/${noteId}/notify`)
      .set("Authorization", `Bearer ${labToken}`)
      .send({ method: "labtrax_only" });

    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toMatchObject({ ok: true });

    const notifs = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, "shared_note")));

    const forProv1 = notifs.find((n: any) => n.userId === providerUserId1);
    const forProv2 = notifs.find((n: any) => n.userId === providerUserId2);
    expect(forProv1).toBeTruthy();
    expect(forProv2).toBeTruthy();
    expect(forProv1?.title).toContain("Alice Smith");
    expect(forProv1?.body).toContain("Please check the shade");
    expect((forProv1?.dataJson as any)?.caseId).toBe(caseId);
    expect((forProv1?.dataJson as any)?.noteId).toBe(noteId);
  });

  it("skips a provider member who opted out of in-app case-note notifications", async () => {
    const { db, users, notifications, caseNotes } = dbMod as any;

    await db
      .update(users)
      .set({ inAppPreferences: { caseNoteNotifications: false } })
      .where(eq(users.id, providerUserId2));

    const optOutNoteId = rid("note2");
    await db.insert(caseNotes).values({
      id: optOutNoteId,
      caseId,
      noteText: "Second note for opt-out coverage.",
      visibility: "shared_with_provider",
      authorUserId: labUserId,
      authorOrganizationId: labOrgId,
    });

    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/notes/${optOutNoteId}/notify`)
      .set("Authorization", `Bearer ${labToken}`)
      .send({ method: "labtrax_only" });

    expect(res.status).toBe(200);

    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.type, "shared_note"),
          inArray(notifications.userId, [providerUserId1, providerUserId2]),
        ),
      );
    const forOptOutNote = notifs.filter(
      (n: any) => (n.dataJson as any)?.noteId === optOutNoteId,
    );
    expect(forOptOutNote.find((n: any) => n.userId === providerUserId1)).toBeTruthy();
    expect(forOptOutNote.find((n: any) => n.userId === providerUserId2)).toBeFalsy();

    await db
      .update(users)
      .set({ inAppPreferences: null })
      .where(eq(users.id, providerUserId2));
    await db.delete(caseNotes).where(eq(caseNotes.id, optOutNoteId)).catch(() => {});
  });

  it("returns 422 when the note is internal_lab_only", async () => {
    const { db, caseNotes } = dbMod as any;
    const internalNoteId = rid("intnote");
    await db.insert(caseNotes).values({
      id: internalNoteId,
      caseId,
      noteText: "Lab-only note.",
      visibility: "internal_lab_only",
      authorUserId: labUserId,
      authorOrganizationId: labOrgId,
    });

    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/notes/${internalNoteId}/notify`)
      .set("Authorization", `Bearer ${labToken}`)
      .send({ method: "labtrax_only" });

    expect(res.status).toBe(422);
    await db.delete(caseNotes).where(eq(caseNotes.id, internalNoteId)).catch(() => {});
  });
});
