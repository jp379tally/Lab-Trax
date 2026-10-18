/**
 * Integration tests for the doctor profile endpoints (Task #3632).
 *
 *   GET  /api/organizations/:orgId/doctors/profile
 *   PUT  /api/organizations/:orgId/doctors/profile
 *   PATCH /api/organizations/:orgId/doctors/rename
 *
 * Also covers GET /api/cases/:id including doctorPreferences.
 *
 * Skipped when no DATABASE_URL is configured — same convention as
 * `doctors.test.ts` and `cases-similarity.test.ts`.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
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

maybe("Task #3632 doctor profile route (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");
  const practiceNoActiveProviderId = rid("provNone");
  const adminUserId = rid("uadmin");
  const memberUserId = rid("umember");
  const otherLabUserId = rid("uother");
  const providerAUserId = rid("uproviderA");
  const providerAColleagueUserId = rid("uproviderAColleague");
  const providerBUserId = rid("uproviderB");
  const inactiveProviderUserId = rid("uinactiveProvider");
  const pendingProviderUserId = rid("upendingProvider");
  const otherLabOrgId = rid("lab2");

  const tokens = {
    admin: "",
    member: "",
    otherLab: "",
  };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  async function insertCase(opts: {
    id?: string;
    caseNumber: string;
    doctorName: string;
    practiceId: string | null;
    labId?: string;
  }) {
    const { db, cases } = dbMod as any;
    const id = opts.id ?? rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: opts.caseNumber,
      labOrganizationId: opts.labId ?? labOrgId,
      providerOrganizationId: opts.practiceId,
      doctorName: opts.doctorName,
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  async function insertOverride(opts: {
    doctorName: string;
    practiceId: string | null;
    labId?: string;
  }) {
    const { db, pricingOverrides } = dbMod as any;
    const id = rid("po");
    await db.insert(pricingOverrides).values({
      id,
      labOrganizationId: opts.labId ?? labOrgId,
      doctorName: opts.doctorName,
      providerOrganizationId: opts.practiceId,
      practiceName: "Practice A",
      pricingTierId: null,
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-dp";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
      { id: otherLabUserId, username: `oth_${otherLabUserId}`, password: "x" },
      {
        id: providerAUserId,
        username: `prova_${providerAUserId}`,
        password: "x",
        userType: "provider",
        doctorName: "Dr. A",
      },
      {
        id: providerAColleagueUserId,
        username: `prova2_${providerAColleagueUserId}`,
        password: "x",
        userType: "provider",
        doctorName: "Dr. A Colleague",
      },
      {
        id: providerBUserId,
        username: `provb_${providerBUserId}`,
        password: "x",
        userType: "provider",
        doctorName: "Dr. B",
      },
      {
        id: inactiveProviderUserId,
        username: `provi_${inactiveProviderUserId}`,
        password: "x",
        userType: "provider",
        isActive: false,
        doctorName: "Dr. Unavailable",
      },
      {
        id: pendingProviderUserId,
        username: `provp_${pendingProviderUserId}`,
        password: "x",
        userType: "provider",
        doctorName: "Dr. Unavailable",
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Profile Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: practiceAId,
        type: "provider",
        name: "Practice A",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: practiceBId,
        type: "provider",
        name: "Practice B",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: practiceNoActiveProviderId,
        type: "provider",
        name: "Practice without active provider",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: memberUserId,
        role: "user",
        status: "active",
      },
      {
        id: rid("m"),
        labId: otherLabOrgId,
        userId: otherLabUserId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: practiceAId,
        userId: providerAUserId,
        role: "user",
        status: "active",
      },
      {
        id: rid("m"),
        labId: practiceAId,
        userId: providerAColleagueUserId,
        role: "user",
        status: "active",
      },
      {
        id: rid("m"),
        labId: practiceBId,
        userId: providerBUserId,
        role: "user",
        status: "active",
      },
      {
        id: rid("m"),
        labId: practiceNoActiveProviderId,
        userId: inactiveProviderUserId,
        role: "user",
        status: "active",
      },
      {
        id: rid("m"),
        labId: practiceNoActiveProviderId,
        userId: pendingProviderUserId,
        role: "user",
        status: "pending",
      },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.member = await makeSession(memberUserId);
    tokens.otherLab = await makeSession(otherLabUserId);
  });

  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.member = await makeSession(memberUserId);
    tokens.otherLab = await makeSession(otherLabUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      pricingOverrides,
      doctorProfiles,
      organizationMemberships,
      userSessions,
    } = dbMod as any;

    // doctorProfiles cascade-deletes phone/email entries.
    await db
      .delete(doctorProfiles)
      .where(eq(doctorProfiles.labOrganizationId, labOrgId));
    await db.delete(pricingOverrides).where(
      eq(pricingOverrides.labOrganizationId, labOrgId)
    );
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [
        adminUserId,
        memberUserId,
        otherLabUserId,
        providerAUserId,
        providerAColleagueUserId,
        providerBUserId,
        inactiveProviderUserId,
        pendingProviderUserId,
      ])
    );
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [adminUserId, memberUserId, otherLabUserId])
    );
    await db.delete(organizations).where(
      inArray(organizations.id, [
        labOrgId,
        otherLabOrgId,
        practiceAId,
        practiceBId,
        practiceNoActiveProviderId,
      ])
    );
    await db.delete(users).where(
      inArray(users.id, [
        adminUserId,
        memberUserId,
        otherLabUserId,
        providerAUserId,
        providerAColleagueUserId,
        providerBUserId,
        inactiveProviderUserId,
        pendingProviderUserId,
      ])
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET profile — empty shape
  // ─────────────────────────────────────────────────────────────────────────

  it("GET profile returns empty shape for unknown doctor", async () => {
    const r = await request(appMod.default)
      .get(
        `/api/organizations/${labOrgId}/doctors/profile?doctorName=Dr.+Unknown&providerOrgId=${practiceAId}`
      )
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const d = r.body.data;
    expect(d.id).toBeNull();
    expect(d.doctorName).toBe("Dr. Unknown");
    expect(d.phones).toEqual([]);
    expect(d.emails).toEqual([]);
    expect(d.preferences).toBeNull();
  });

  it("GET profile requires membership", async () => {
    const r = await request(appMod.default)
      .get(
        `/api/organizations/${labOrgId}/doctors/profile?doctorName=Dr.+Test`
      )
      .set("Authorization", `Bearer ${tokens.otherLab}`);
    expect(r.status).toBe(403);
  });

  it("GET profile requires doctorName query param", async () => {
    const r = await request(appMod.default)
      .get(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT profile — round-trip
  // ─────────────────────────────────────────────────────────────────────────

  it("PUT creates a new profile and GET retrieves it", async () => {
    const doctorName = `Dr. ${rid("put")}`;

    const putR = await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName,
        providerOrgId: practiceAId,
        displayName: "Dr. Display",
        preferences: "Prefers morning appointments.",
        phones: [
          { phoneNumber: "555-1234", label: "main", isPrimary: true },
          { phoneNumber: "555-5678", label: "mobile", isPrimary: false },
        ],
        emails: [
          { email: "drtest@example.com", label: "general", isPrimary: true },
        ],
      });
    expect(putR.status).toBe(200);
    const d = putR.body.data;
    expect(d.id).toBeTruthy();
    expect(d.displayName).toBe("Dr. Display");
    expect(d.preferences).toBe("Prefers morning appointments.");
    expect(d.phones).toHaveLength(2);
    expect(d.emails).toHaveLength(1);
    expect(d.emails[0].email).toBe("drtest@example.com");

    // GET should also return the profile.
    const getR = await request(appMod.default)
      .get(
        `/api/organizations/${labOrgId}/doctors/profile?doctorName=${encodeURIComponent(doctorName)}&providerOrgId=${practiceAId}`
      )
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(getR.status).toBe(200);
    const gd = getR.body.data;
    expect(gd.displayName).toBe("Dr. Display");
    expect(gd.phones).toHaveLength(2);
    expect(gd.emails).toHaveLength(1);

    // Cleanup.
    const { db, doctorProfiles } = dbMod as any;
    await db
      .delete(doctorProfiles)
      .where(eq(doctorProfiles.labOrganizationId, labOrgId));
  });

  it("PUT replaces child phones and emails on re-save", async () => {
    const doctorName = `Dr. ${rid("replace")}`;

    // Create initial profile.
    await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName,
        providerOrgId: practiceAId,
        phones: [{ phoneNumber: "555-0000", label: "main", isPrimary: true }],
        emails: [],
      });

    // Overwrite with different phones.
    const putR = await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName,
        providerOrgId: practiceAId,
        phones: [
          { phoneNumber: "555-1111", label: "mobile", isPrimary: true },
          { phoneNumber: "555-2222", label: "other", isPrimary: false },
        ],
        emails: [{ email: "new@example.com", label: "invoicing", isPrimary: true }],
      });
    expect(putR.status).toBe(200);
    const d = putR.body.data;
    expect(d.phones).toHaveLength(2);
    expect(d.phones.some((p: any) => p.phoneNumber === "555-0000")).toBe(false);
    expect(d.emails).toHaveLength(1);
    expect(d.emails[0].email).toBe("new@example.com");

    // Cleanup.
    const { db, doctorProfiles } = dbMod as any;
    await db
      .delete(doctorProfiles)
      .where(eq(doctorProfiles.labOrganizationId, labOrgId));
  });

  it("PUT rejects invalid phone label", async () => {
    const r = await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName: `Dr. ${rid("label")}`,
        providerOrgId: practiceAId,
        phones: [{ phoneNumber: "555-0000", label: "fax", isPrimary: true }],
        emails: [],
      });
    expect(r.status).toBe(400);
  });

  it("PUT rejects invalid email label", async () => {
    const r = await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName: `Dr. ${rid("label")}`,
        providerOrgId: practiceAId,
        phones: [],
        emails: [{ email: "x@x.com", label: "billing", isPrimary: true }],
      });
    expect(r.status).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH rename
  // ─────────────────────────────────────────────────────────────────────────

  it("PATCH rename cascades cases, pricing_overrides, and doctor_profiles", async () => {
    const oldName = `Dr. Old ${rid("rn")}`;
    const newName = `Dr. New ${rid("rn")}`;

    // Seed cases, overrides, and a profile.
    const c1 = await insertCase({
      caseNumber: rid("CN"),
      doctorName: oldName,
      practiceId: practiceAId,
    });
    const c2 = await insertCase({
      caseNumber: rid("CN"),
      doctorName: oldName,
      practiceId: practiceAId,
    });
    const ovId = await insertOverride({
      doctorName: oldName,
      practiceId: practiceAId,
    });

    // Create a doctor profile.
    await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName: oldName,
        providerOrgId: practiceAId,
        preferences: "Some prefs",
        phones: [],
        emails: [],
      });

    const r = await request(appMod.default)
      .patch(`/api/organizations/${labOrgId}/doctors/rename`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName: oldName,
        providerOrgId: practiceAId,
        newName,
      });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.casesUpdated).toBe(2);
    expect(d.pricingUpdated).toBe(1);
    expect(d.profilesUpdated).toBe(1);
    expect(d.oldName).toBe(oldName);
    expect(d.newName).toBe(newName);

    // Verify DB state.
    const { db, cases, pricingOverrides, doctorProfiles } = dbMod as any;
    const caseRows = await db
      .select({ doctorName: cases.doctorName })
      .from(cases)
      .where(inArray(cases.id, [c1, c2]));
    expect(caseRows.every((c: any) => c.doctorName === newName)).toBe(true);

    const ovRow = await db
      .select({ doctorName: pricingOverrides.doctorName })
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovId));
    expect(ovRow[0]?.doctorName).toBe(newName);

    const profileRows = await db
      .select({ doctorName: doctorProfiles.doctorName })
      .from(doctorProfiles)
      .where(eq(doctorProfiles.labOrganizationId, labOrgId));
    expect(profileRows.some((p: any) => p.doctorName === newName)).toBe(true);

    // Cleanup.
    await db
      .delete(doctorProfiles)
      .where(eq(doctorProfiles.labOrganizationId, labOrgId));
    await db.delete(pricingOverrides).where(eq(pricingOverrides.id, ovId));
    await db.delete(cases).where(inArray(cases.id, [c1, c2]));
  });

  it("PATCH rename returns 403 for non-admin members", async () => {
    const r = await request(appMod.default)
      .patch(`/api/organizations/${labOrgId}/doctors/rename`)
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({
        doctorName: "Dr. Someone",
        providerOrgId: practiceAId,
        newName: "Dr. Else",
      });
    expect(r.status).toBe(403);
  });

  it("PATCH rename returns 400 when old and new names are the same", async () => {
    const r = await request(appMod.default)
      .patch(`/api/organizations/${labOrgId}/doctors/rename`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName: "Dr. Same",
        providerOrgId: null,
        newName: "Dr. Same",
      });
    expect(r.status).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /cases/:id includes doctorPreferences
  // ─────────────────────────────────────────────────────────────────────────

  it("GET /cases/:id includes doctorPreferences when a profile exists", async () => {
    const doctorName = `Dr. ${rid("prefs")}`;
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName,
      practiceId: practiceAId,
    });

    // Create a profile with preferences.
    await request(appMod.default)
      .put(`/api/organizations/${labOrgId}/doctors/profile`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        doctorName,
        providerOrgId: practiceAId,
        preferences: "Rush cases only on Tuesdays.",
        phones: [],
        emails: [],
      });

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.doctorPreferences).toBe("Rush cases only on Tuesdays.");

    // Cleanup.
    const { db, doctorProfiles, cases } = dbMod as any;
    await db
      .delete(doctorProfiles)
      .where(eq(doctorProfiles.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("GET /cases/:id returns doctorPreferences as null when no profile exists", async () => {
    const doctorName = `Dr. ${rid("noprefs")}`;
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName,
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.doctorPreferences).toBeNull();

    // Cleanup.
    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /cases/:id provider-authored preferences (Task #4033)
  // ─────────────────────────────────────────────────────────────────────────

  it("isolates provider-authored preferences to the case provider organization", async () => {
    const { db, users, cases } = dbMod as any;
    await db
      .update(users)
      .set({ doctorPreferences: { occlusionAmount: 0.2, occlusionUnit: "mm" } })
      .where(eq(users.id, providerAUserId));
    await db
      .update(users)
      .set({
        doctorPreferences: {
          occlusionAmount: 50,
          occlusionUnit: "microns",
        },
      })
      .where(eq(users.id, providerBUserId));
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. A",
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.providerDoctorPreferences).toMatchObject({
      occlusionAmount: 0.2,
      occlusionUnit: "mm",
    });
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("selects the matching doctor within a multi-doctor provider organization", async () => {
    const { db, users, cases } = dbMod as any;
    await db
      .update(users)
      .set({ doctorPreferences: { occlusionAmount: 0.15, occlusionUnit: "mm" } })
      .where(eq(users.id, providerAUserId));
    await db
      .update(users)
      .set({
        doctorPreferences: {
          occlusionAmount: 80,
          occlusionUnit: "microns",
        },
      })
      .where(eq(users.id, providerAColleagueUserId));
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      // The shared normalization accepts harmless case-entry formatting
      // differences, while still selecting only the matching doctor.
      doctorName: " dr a ",
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.providerDoctorPreferences).toMatchObject({
      occlusionAmount: 0.15,
      occlusionUnit: "mm",
    });
    expect(r.body.data.providerDoctorPreferences.occlusionAmount).not.toBe(80);
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("returns formatted empty provider preferences when the active provider has none", async () => {
    const { db, users, cases } = dbMod as any;
    await db
      .update(users)
      .set({ doctorPreferences: null })
      .where(eq(users.id, providerAUserId));
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. A",
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.providerDoctorPreferences).toEqual({
      occlusionAmount: null,
      occlusionUnit: null,
      proximalContactAmount: null,
      proximalContactUnit: null,
      anatomyPreference: null,
      anatomyOther: null,
      caseQuestionContactMethod: null,
      caseQuestionContactValue: null,
    });
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("excludes inactive users and pending provider memberships", async () => {
    const { db, users, cases } = dbMod as any;
    await db
      .update(users)
      .set({ doctorPreferences: { anatomyPreference: "primary_only" } })
      .where(eq(users.id, inactiveProviderUserId));
    await db
      .update(users)
      .set({ doctorPreferences: { anatomyPreference: "other", anatomyOther: "Pending" } })
      .where(eq(users.id, pendingProviderUserId));
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Unavailable",
      practiceId: practiceNoActiveProviderId,
    });

    const r = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(r.status).toBe(200);
    expect(r.body.data.providerDoctorPreferences).toBeNull();
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("uses the current provider preference value on every case-detail reprint and exposes the lab setting", async () => {
    const { db, users, organizations, cases } = dbMod as any;
    const caseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. A",
      practiceId: practiceAId,
    });
    await db
      .update(users)
      .set({ doctorPreferences: { proximalContactAmount: 20, proximalContactUnit: "microns" } })
      .where(eq(users.id, providerAUserId));

    const first = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(first.status).toBe(200);
    expect(first.body.data.providerDoctorPreferences.proximalContactAmount).toBe(20);
    expect(first.body.data.printProviderPreferencesOnLabSlips).toBe(false);

    await db
      .update(users)
      .set({ doctorPreferences: { proximalContactAmount: 35, proximalContactUnit: "microns" } })
      .where(eq(users.id, providerAUserId));
    await db
      .update(organizations)
      .set({ printProviderPreferencesOnLabSlips: true })
      .where(eq(organizations.id, labOrgId));

    const reprint = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(reprint.status).toBe(200);
    expect(reprint.body.data.providerDoctorPreferences.proximalContactAmount).toBe(35);
    expect(reprint.body.data.printProviderPreferencesOnLabSlips).toBe(true);

    await db
      .update(organizations)
      .set({ printProviderPreferencesOnLabSlips: false })
      .where(eq(organizations.id, labOrgId));
    await db.delete(cases).where(eq(cases.id, caseId));
  });
});
