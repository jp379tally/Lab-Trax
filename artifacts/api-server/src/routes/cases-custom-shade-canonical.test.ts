/**
 * Integration tests for the Custom Shade gating invariant on canonical cases
 * (PATCH /api/cases/:id, Task #3631).
 *
 * Coverage:
 *  - Sub-field-only PATCH against a case whose isCustomShade is false (default)
 *    must clear sub-fields, not persist them.
 *  - Combined isCustomShade:true + sub-fields round-trips correctly.
 *  - Toggle-off PATCH clears all sub-fields.
 *  - Stale sequential update: after toggle-off, a racing sub-field-only PATCH
 *    (the "stale autosave" scenario) must not re-persist sub-fields.
 *  - Combined isCustomShade:false + sub-fields: invariant wins.
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-cshade"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("PATCH /api/cases/:id — canonical custom-shade gating invariant", () => {
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

  async function createCase(): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Shade",
        patientLastName: "Test",
        doctorName: "Dr. Synthetic062",
        status: "received",
      });
    if (r.status !== 201) {
      throw new Error(`createCase failed ${r.status}: ${JSON.stringify(r.body)}`);
    }
    const id: string = r.body.data.id;
    createdCaseIds.push(id);
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-cshade";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `cshade_owner_${labOwnerId}`,
      password: "x",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("CShadeLab") },
      { id: providerOrgId, type: "provider", name: rid("CShadeProvider"),
        parentLabOrganizationId: labOrgId },
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

  beforeEach(async () => {
    // Refresh session before every test to prevent mid-suite token expiry.
    token = await makeSession(labOwnerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, cases, invoices, userSessions, organizationMemberships, organizations, users } =
      dbMod as any;

    // Delete invoices first (FK references lab org); POST /api/cases
    // auto-creates a draft invoice which blocks org deletion otherwise.
    if (createdCaseIds.length) {
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds)).catch(() => {});
      await db.delete(cases).where(inArray(cases.id, createdCaseIds));
    }
    await db.delete(userSessions).where(eq(userSessions.userId, labOwnerId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, labOwnerId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(eq(users.id, labOwnerId));
  });

  it("isCustomShade=true + sub-fields round-trips correctly via GET", async () => {
    const caseId = await createCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        isCustomShade: true,
        customShadeTechnician: "Alice",
        customShadePicturesAvailable: true,
        customShadeVideoAvailable: false,
      });
    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body?.data?.isCustomShade).toBe(true);
    expect(get.body?.data?.customShadeTechnician).toBe("Alice");
    expect(get.body?.data?.customShadePicturesAvailable).toBe(true);
    expect(get.body?.data?.customShadeVideoAvailable).toBe(false);
  });

  it("toggle-off clears all sub-fields (canonical path)", async () => {
    const caseId = await createCase();

    // First set custom shade ON with sub-fields.
    await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isCustomShade: true, customShadeTechnician: "Bob",
              customShadePicturesAvailable: true, customShadeVideoAvailable: true });

    // Then toggle OFF.
    const off = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isCustomShade: false });
    expect(off.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body?.data?.isCustomShade).toBe(false);
    expect(get.body?.data?.customShadeTechnician).toBeNull();
    expect(get.body?.data?.customShadePicturesAvailable).toBe(false);
    expect(get.body?.data?.customShadeVideoAvailable).toBe(false);
  });

  it("sub-field-only PATCH against a default (isCustomShade=false) case does not persist sub-fields", async () => {
    // New case: isCustomShade defaults to false. Sending sub-fields without
    // enabling the flag must not persist them — the effective flag is false.
    const caseId = await createCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        customShadeTechnician: "Carol",
        customShadePicturesAvailable: true,
        // isCustomShade deliberately omitted.
      });
    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body?.data?.isCustomShade).toBe(false);
    expect(get.body?.data?.customShadeTechnician).toBeNull();
    expect(get.body?.data?.customShadePicturesAvailable).toBe(false);
  });

  it("stale sequential autosave: sub-field PATCH after toggle-off does not re-persist sub-fields", async () => {
    // Simulates a race: the technician TextInput's onBlur fires just after the
    // user unchecked the Custom Shade checkbox. The sub-field PATCH must lose
    // because the effective flag (read from the DB) is already false.
    const caseId = await createCase();

    // Enable custom shade.
    await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isCustomShade: true, customShadeTechnician: "Dan",
              customShadePicturesAvailable: true });

    // Toggle off.
    await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isCustomShade: false });

    // Stale technician autosave arrives after the toggle-off.
    const stale = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ customShadeTechnician: "Dan (stale)" });
    expect(stale.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    // The stale PATCH must not have re-persisted the technician name.
    expect(get.body?.data?.isCustomShade).toBe(false);
    expect(get.body?.data?.customShadeTechnician).toBeNull();
    expect(get.body?.data?.customShadePicturesAvailable).toBe(false);
  });

  it("combined isCustomShade:false + sub-fields: invariant wins, sub-fields are cleared", async () => {
    const caseId = await createCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        isCustomShade: false,
        customShadeTechnician: "Eve",
        customShadePicturesAvailable: true,
        customShadeVideoAvailable: true,
      });
    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body?.data?.isCustomShade).toBe(false);
    expect(get.body?.data?.customShadeTechnician).toBeNull();
    expect(get.body?.data?.customShadePicturesAvailable).toBe(false);
    expect(get.body?.data?.customShadeVideoAvailable).toBe(false);
  });

  it("combined isCustomShade:null + sub-fields: null treated as off, sub-fields cleared", async () => {
    const caseId = await createCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        isCustomShade: null,
        customShadeTechnician: "Frank",
        customShadePicturesAvailable: true,
      });
    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body?.data?.isCustomShade).toBe(false);
    expect(get.body?.data?.customShadeTechnician).toBeNull();
    expect(get.body?.data?.customShadePicturesAvailable).toBe(false);
  });
});
