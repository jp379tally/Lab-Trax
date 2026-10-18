/**
 * Integration tests verifying that a provider upload via
 * POST /lab-inbox/provider-upload inserts `provider_message` notifications
 * for owner/admin members of the receiving lab, but NOT manager or plain staff.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
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

maybe("POST /lab-inbox/provider-upload — lab admin notifications (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let tmpFile: string;
  let providerToken = "";

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const providerUserId = rid("provuser");
  const adminUserId = rid("admin");
  const managerUserId = rid("mgr");
  const staffUserId = rid("staff");

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-inbox-notify";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, organizationMemberships, users } = dbMod as any;

    await db.insert(users).values([
      {
        id: providerUserId,
        username: `prov_${providerUserId}`,
        password: "x",
        userType: "provider",
        emailVerifiedAt: new Date(),
      },
      { id: adminUserId, username: `admin_${adminUserId}`, password: "x", userType: "lab", role: "admin" },
      { id: managerUserId, username: `mgr_${managerUserId}`, password: "x", userType: "lab", role: "user" },
      { id: staffUserId, username: `staff_${staffUserId}`, password: "x", userType: "lab", role: "user" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Inbox Notify Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Inbox Notify Provider",
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      { labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
      { labId: labOrgId, userId: managerUserId, role: "manager", status: "active" },
      { labId: labOrgId, userId: staffUserId, role: "user", status: "active" },
      { labId: providerOrgId, userId: providerUserId, role: "admin", status: "active" },
    ]);

    tmpFile = path.join(os.tmpdir(), `inbox-notify-${randomBytes(4).toString("hex")}.pdf`);
    fs.writeFileSync(tmpFile, "%PDF-1.4\nTest file content for notification test");
  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    providerToken = await makeSession(providerUserId);
  });

  afterAll(async () => {
    const { db, notifications, systemSettings, labInboxFiles, organizationMemberships, organizations, users, userSessions } = dbMod as any;
    await db.delete(notifications).where(
      and(
        eq(notifications.type, "provider_message"),
        inArray(notifications.userId, [adminUserId, managerUserId, staffUserId]),
      )
    ).catch(() => {});
    await db.delete(systemSettings).where(eq(systemSettings.key, `notif_prefs:${adminUserId}`)).catch(() => {});
    await db.delete(labInboxFiles).where(eq(labInboxFiles.labOrganizationId, labOrgId)).catch(() => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.labId, labOrgId)).catch(() => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.labId, providerOrgId)).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, providerOrgId)).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, labOrgId)).catch(() => {});
    await db.delete(users).where(
      inArray(users.id, [providerUserId, adminUserId, managerUserId, staffUserId])
    ).catch(() => {});
    await db.delete(userSessions).where(eq(userSessions.userId, providerUserId)).catch(() => {});
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("inserts provider_message notifications for owners/admins but not manager or staff after a provider upload", async () => {
    const { db, notifications } = dbMod as any;

    const res = await request(appMod.default)
      .post(`/api/lab-inbox/provider-upload?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .attach("file", tmpFile)
      .field("note", "Please review these scans.");

    expect(res.status).toBe(201);

    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, "provider_message"));

    const adminNotif = notifs.find((n: any) => n.userId === adminUserId);
    const managerNotif = notifs.find((n: any) => n.userId === managerUserId);
    const staffNotif = notifs.find((n: any) => n.userId === staffUserId);

    expect(adminNotif).toBeTruthy();
    expect(managerNotif).toBeUndefined();
    expect(staffNotif).toBeUndefined();
    expect(adminNotif?.title).toBe("Provider sent a message");
    expect(adminNotif?.body).toContain("Please review these scans");
  });

  it("does not create a provider-upload bell notification when the admin disables doctor/practice alerts", async () => {
    const { db, notifications, systemSettings } = dbMod as any;
    await db.insert(systemSettings).values({
      key: `notif_prefs:${adminUserId}`,
      value: JSON.stringify({ inAppDoctorPracticeMessage: false }),
    }).onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: JSON.stringify({ inAppDoctorPracticeMessage: false }) },
    });
    const before = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, "provider_message"), eq(notifications.userId, adminUserId)));

    const res = await request(appMod.default)
      .post(`/api/lab-inbox/provider-upload?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .attach("file", tmpFile)
      .field("note", "This alert is disabled.");

    expect(res.status).toBe(201);
    const after = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, "provider_message"), eq(notifications.userId, adminUserId)));
    expect(after).toHaveLength(before.length);
  });
});
