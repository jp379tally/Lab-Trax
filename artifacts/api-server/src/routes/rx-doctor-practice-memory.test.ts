/**
 * Regression tests for GET/POST /api/rx-doctor-practice-memory — the per-doctor
 * practice memory that backs the AI intake.
 *
 * Skipped when no DATABASE_URL is configured (matches the convention used by
 * the sibling rx-practice-aliases suite).
 *
 * Coverage:
 *  - POST saves a doctor → practice mapping; GET returns it for the same lab.
 *  - Cross-lab isolation: one lab's remembered doctors never surface in another
 *    lab's intake.
 *  - Normalization: casing, extra internal whitespace, and "Dr."/"Dr" title
 *    variants all collapse to one key.
 *  - Upsert: saving the same doctor again OVERWRITES the practice rather than
 *    erroring or leaving a stale row.
 *  - Required-parameter 400s and non-member 403s.
 *  - Tenant safety: the practice must be one this lab owns, so a lab member
 *    cannot point their lab's memory at another tenant's provider org.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-doctor-memory"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET/POST /api/rx-doctor-practice-memory (db integration)", () => {
  let appMod: { default: import("express").Express };
  let dbMod: typeof import("@workspace/db");
  let auth: typeof import("../lib/auth.js");
  let token: string;
  let outsiderToken: string;
  let memberToken: string;
  let otherAdminToken: string;

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerOrgId = rid("prov");
  const providerOrgId2 = rid("prov2");
  const foreignProviderOrgId = rid("provx");
  const userId = rid("u");
  const memberUserId = rid("umember");
  const otherAdminUserId = rid("uotheradmin");
  // A user with NO membership in either lab, to prove the membership gate.
  const outsiderUserId = rid("uout");
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-doctor-memory";
    appMod = await import("../app.js");
    dbMod = await import("@workspace/db");
    auth = await import("../lib/auth.js");
    const { db, organizations, organizationMemberships, users } = dbMod as any;

    await db.insert(users).values([
      { id: userId, username: `docmemtest_${userId}`, password: "x" },
      { id: memberUserId, username: `docmemmember_${memberUserId}`, password: "x" },
      { id: otherAdminUserId, username: `docmemotheradmin_${otherAdminUserId}`, password: "x" },
      { id: outsiderUserId, username: `docmemout_${outsiderUserId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Doctor Memory Lab" },
      { id: otherLabOrgId, type: "lab", name: "Doctor Memory Other Lab" },
      // Practices are owned by a lab. The upsert refuses a provider org that
      // is not this lab's, so the ownership column matters here.
      {
        id: providerOrgId,
        type: "provider",
        name: "Sample Dental Associates",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: providerOrgId2,
        type: "provider",
        name: "Second Care Dental",
        parentLabOrganizationId: labOrgId,
      },
      // Belongs to the OTHER lab — used to prove one lab cannot point its own
      // memory at another tenant's practice.
      {
        id: foreignProviderOrgId,
        type: "provider",
        name: "Foreign Lab Dental",
        parentLabOrganizationId: otherLabOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), userId, labId: labOrgId, role: "admin", status: "active" },
      { id: rid("mmember"), userId: memberUserId, labId: labOrgId, role: "user", status: "active" },
      { id: rid("motheradmin"), userId: otherAdminUserId, labId: otherLabOrgId, role: "admin", status: "active" },
      // Member of the other lab too, so cross-lab isolation is an authorized
      // found:false rather than a 403.
      { id: rid("m2"), userId, labId: otherLabOrgId, role: "admin", status: "active" },
    ]);

  });

  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    token = await makeSession(userId);
    memberToken = await makeSession(memberUserId);
    otherAdminToken = await makeSession(otherAdminUserId);
    outsiderToken = await makeSession(outsiderUserId);
  });

  // requireAuth validates the session row behind the token, so a bare
  // jwt.sign() is rejected as 401 — mint a real session.
  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const t = auth.signAccessToken(uid, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId: uid,
      tokenHash: createHash("sha256").update(t).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    sessionIds.push(sessionId);
    return t;
  }

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      organizationMemberships,
      users,
      rxDoctorPracticeMemory,
      userSessions,
    } = dbMod as any;
    const { eq, inArray } = await import("drizzle-orm");
    if (sessionIds.length) {
      await db
        .delete(userSessions)
        .where(inArray(userSessions.id, sessionIds));
    }
    await db
      .delete(rxDoctorPracticeMemory)
      .where(
        inArray(rxDoctorPracticeMemory.labOrganizationId, [
          labOrgId,
          otherLabOrgId,
        ]),
      );
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [userId, memberUserId, otherAdminUserId]));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId,
          otherLabOrgId,
          providerOrgId,
          providerOrgId2,
          foreignProviderOrgId,
        ]),
      );
    await db.delete(users).where(inArray(users.id, [userId, memberUserId, otherAdminUserId, outsiderUserId]));
  });

  it("POST saves a doctor → practice mapping; GET returns it for the same lab", async () => {
    const postResp = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: "Dr. Synthetic029 Provider029",
        providerOrganizationId: providerOrgId,
      });
    expect(postResp.status).toBe(200);
    expect(postResp.body.ok).toBe(true);
    expect(postResp.body.data.providerOrganizationId).toBe(providerOrgId);

    const getResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Synthetic029 Provider029")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(true);
    expect(getResp.body.data.providerOrganizationId).toBe(providerOrgId);
  });

  it("collapses casing, extra whitespace, and 'Dr.' title variants to one key", async () => {
    // All of these are the same doctor saved in the previous test.
    const variants = [
      "synthetic029 provider029",
      "Synthetic029  Provider029",
      "Dr Synthetic029 Provider029",
      "DR. SYNTHETIC029 PROVIDER029",
      "  Dr.   Synthetic029   Provider029  ",
    ];
    for (const variant of variants) {
      const getResp = await request(appMod.default)
        .get(
          `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent(variant)}`,
        )
        .set("Authorization", `Bearer ${token}`);
      expect(getResp.status).toBe(200);
      expect(
        `${variant} → found=${getResp.body.data.found}`,
      ).toBe(`${variant} → found=true`);
      expect(getResp.body.data.providerOrganizationId).toBe(providerOrgId);
    }
  });

  it("one lab's remembered doctors never leak into another lab", async () => {
    const getResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${otherLabOrgId}&doctorName=${encodeURIComponent("Dr. Synthetic029 Provider029")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(false);
    expect(getResp.body.data.providerOrganizationId).toBeNull();
  });

  it("upserts: re-saving the same doctor overwrites the remembered practice", async () => {
    // A different spelling of the SAME normalized doctor must update the
    // existing row rather than insert a competing one.
    const postResp = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: "synthetic029  provider029",
        providerOrganizationId: providerOrgId2,
      });
    expect(postResp.status).toBe(200);

    const getResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Synthetic029 Provider029")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.body.data.found).toBe(true);
    expect(getResp.body.data.providerOrganizationId).toBe(providerOrgId2);

    // Exactly one row survives for this lab + doctor.
    const { db, rxDoctorPracticeMemory } = dbMod as any;
    const { and, eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(rxDoctorPracticeMemory)
      .where(
        and(
          eq(rxDoctorPracticeMemory.labOrganizationId, labOrgId),
          eq(rxDoctorPracticeMemory.doctorName, "synthetic029 provider029"),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it("GET returns found:false for a doctor that was never confirmed", async () => {
    const getResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Nobody Atall")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(false);
  });

  it("GET without doctorName returns the admin management list", async () => {
    const r = await request(appMod.default)
      .get(`/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.mappings)).toBe(true);
  });

  it("POST returns 400 when providerOrganizationId is missing", async () => {
    const r = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({ labOrganizationId: labOrgId, doctorName: "Dr. Someone" });
    expect(r.status).toBe(400);
  });

  it("rejects a caller who is not an active member of the lab", async () => {
    const getResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Synthetic029 Provider029")}`,
      )
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(getResp.status).toBe(403);

    const postResp = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: "Dr. Interloper",
        providerOrganizationId: providerOrgId,
      });
    expect(postResp.status).toBe(403);
  });

  it("refuses a practice that belongs to a different lab", async () => {
    // The caller is a legitimate active member of BOTH labs, so membership
    // alone would let this through — the practice's own ownership is what has
    // to be checked, or a member could point their lab's memory at another
    // tenant's provider organization.
    const postResp = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: "Dr. Cross Tenant",
        providerOrganizationId: foreignProviderOrgId,
      });
    expect(postResp.status).toBe(403);

    // Nothing was stored.
    const getResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Cross Tenant")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(false);
  });

  it("refuses an organization id that is not a practice at all", async () => {
    // A lab org id is a perfectly real organization the caller belongs to —
    // it is still not a practice, and must never end up in the memory.
    const postResp = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: "Dr. Not A Practice",
        providerOrganizationId: labOrgId,
      });
    expect(postResp.status).toBe(403);
  });

  it("lets admins list only their lab's mappings and remove one", async () => {
    const otherLabPost = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: otherLabOrgId,
        doctorName: "Dr. Other Lab Only",
        providerOrganizationId: foreignProviderOrgId,
      });
    expect(otherLabPost.status).toBe(200);

    const listResp = await request(appMod.default)
      .get(`/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(listResp.status).toBe(200);
    expect(Array.isArray(listResp.body.data.mappings)).toBe(true);
    expect(
      listResp.body.data.mappings.some(
        (mapping: { doctorName: string }) =>
          mapping.doctorName === "other lab only",
      ),
    ).toBe(false);

    const mapping = listResp.body.data.mappings.find(
      (item: { doctorName: string }) =>
        item.doctorName === "synthetic029 provider029",
    );
    expect(mapping).toMatchObject({
      doctorName: "synthetic029 provider029",
      providerOrganizationId: providerOrgId2,
      practiceName: "Second Care Dental",
    });
    expect(mapping.updatedAt).toBeTruthy();

    const memberListResp = await request(appMod.default)
      .get(`/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(memberListResp.status).toBe(403);

    const memberDeleteResp = await request(appMod.default)
      .delete(`/api/rx-doctor-practice-memory/${mapping.id}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(memberDeleteResp.status).toBe(403);

    const otherLabAdminDeleteResp = await request(appMod.default)
      .delete(`/api/rx-doctor-practice-memory/${mapping.id}`)
      .set("Authorization", `Bearer ${otherAdminToken}`);
    expect(otherLabAdminDeleteResp.status).toBe(403);

    const deleteResp = await request(appMod.default)
      .delete(`/api/rx-doctor-practice-memory/${mapping.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleteResp.status).toBe(200);
    expect(deleteResp.body.data.deleted).toBe(true);

    const lookupResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Synthetic029 Provider029")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(lookupResp.status).toBe(200);
    expect(lookupResp.body.data.found).toBe(false);
  });

  it("falls back for an unavailable practice while keeping the mapping removable", async () => {
    const postResp = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: "Dr. Archived Practice",
        providerOrganizationId: providerOrgId2,
      });
    expect(postResp.status).toBe(200);

    const { db, organizations } = dbMod as any;
    const { eq } = await import("drizzle-orm");
    await db
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, providerOrgId2));

    const lookupResp = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent("Dr. Archived Practice")}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(lookupResp.status).toBe(200);
    expect(lookupResp.body.data.found).toBe(false);

    const listResp = await request(appMod.default)
      .get(`/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(listResp.status).toBe(200);
    const staleMapping = listResp.body.data.mappings.find(
      (item: { doctorName: string }) =>
        item.doctorName === "archived practice",
    );
    expect(staleMapping).toMatchObject({
      providerOrganizationId: providerOrgId2,
      practiceName: "Unavailable practice",
      practiceAvailable: false,
    });

    const deleteResp = await request(appMod.default)
      .delete(`/api/rx-doctor-practice-memory/${staleMapping.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleteResp.status).toBe(200);
  });
});
