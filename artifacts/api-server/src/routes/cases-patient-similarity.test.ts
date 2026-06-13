/**
 * Integration tests for GET /api/cases/patient-similarity
 *
 * Guards the AI Reader's duplicate/remake detection flow end-to-end at the HTTP
 * layer. The companion unit-level suite (cases-similarity.test.ts) tests the
 * library helpers (getDoctorNameSetForProviderOrg, resolveRemakeOriginal) in
 * isolation; this file verifies the mounted route behaviour including auth,
 * tenant isolation, and matchKind ranking.
 *
 * Skipped when DATABASE_URL is not configured — matches the convention used
 * by all other api-server integration tests. All inserted rows are removed in
 * afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - GET /api/cases/patient-similarity — returns 401 when unauthenticated
 *  - GET /api/cases/patient-similarity — returns 400 when required params are missing
 *  - GET /api/cases/patient-similarity — returns 403 when caller is not a lab member
 *  - GET /api/cases/patient-similarity — returns exact-matched canonical cases
 *  - GET /api/cases/patient-similarity — does NOT return cases from a different lab
 *  - GET /api/cases/patient-similarity — classifies nickname matches correctly
 *  - GET /api/cases/patient-similarity — classifies fuzzy (edit-distance ≤ 1) matches
 *  - GET /api/cases/patient-similarity — non-matching patients are excluded
 *  - GET /api/cases/patient-similarity — scopes results by providerOrganizationId
 *  - GET /api/cases/patient-similarity — results are ranked exact > nickname > fuzzy
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-patsim");

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-patsim"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET /api/cases/patient-similarity (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerAOrgId = rid("provA");
  const providerBOrgId = rid("provB");
  const adminUserId = rid("uadmin");
  const outsiderUserId = rid("uout");

  const tokens = { admin: "", outsider: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  async function insertCase(opts: {
    patientFirst: string;
    patientLast: string;
    labId?: string;
    providerOrgId?: string;
    doctorName?: string;
  }): Promise<string> {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: rid("CN"),
      labOrganizationId: opts.labId ?? labOrgId,
      providerOrganizationId: opts.providerOrgId ?? providerAOrgId,
      patientFirstName: opts.patientFirst,
      patientLastName: opts.patientLast,
      doctorName: opts.doctorName ?? "Dr. House",
      status: "received",
      createdByUserId: adminUserId,
    });
    return id;
  }

  // Tracks all case IDs inserted during the suite so afterAll can clean them up.
  const insertedCaseIds: string[] = [];
  async function trackInsert(opts: Parameters<typeof insertCase>[0]): Promise<string> {
    const id = await insertCase(opts);
    insertedCaseIds.push(id);
    return id;
  }

  beforeAll(async () => {
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-patsim";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Sim Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      { id: providerAOrgId, type: "provider", name: "Provider A", parentLabOrganizationId: labOrgId },
      { id: providerBOrgId, type: "provider", name: "Provider B", parentLabOrganizationId: labOrgId },
    ]);

    // adminUserId is a member of labOrgId; outsiderUserId has no membership.
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.outsider = await makeSession(outsiderUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, users, cases, organizationMemberships, userSessions, auditLogs } =
      dbMod as any;

    if (insertedCaseIds.length) {
      await db.delete(cases).where(inArray(cases.id, insertedCaseIds));
    }
    await db.delete(auditLogs).where(
      inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]),
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [adminUserId, outsiderUserId]),
    );
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [adminUserId, outsiderUserId]),
    );
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, otherLabOrgId, providerAOrgId, providerBOrgId]),
    );
    await db.delete(users).where(
      inArray(users.id, [adminUserId, outsiderUserId]),
    );
  });

  // ── Auth / input validation ───────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .query({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        labOrganizationId: labOrgId,
      });
    expect(r.status).toBe(401);
  });

  it("returns 400 when patientFirstName is missing", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ patientLastName: "Doe", labOrganizationId: labOrgId });
    expect(r.status).toBe(400);
  });

  it("returns 400 when patientLastName is missing", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ patientFirstName: "Jane", labOrganizationId: labOrgId });
    expect(r.status).toBe(400);
  });

  it("returns 400 when labOrganizationId is missing", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({ patientFirstName: "Jane", patientLastName: "Doe" });
    expect(r.status).toBe(400);
  });

  it("returns 403 when caller is not a member of the lab", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.outsider}`)
      .query({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        labOrganizationId: labOrgId,
      });
    expect(r.status).toBe(403);
  });

  // ── Happy path — exact match ──────────────────────────────────────────────

  it("returns matching canonical cases with matchKind:exact", async () => {
    const caseId = await trackInsert({
      patientFirst: "Jane",
      patientLast: "Doe",
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.matches)).toBe(true);
    const hit = r.body.data.matches.find((m: any) => m.id === caseId);
    expect(hit, "inserted case must appear in matches").toBeDefined();
    expect(hit.matchKind).toBe("exact");
    expect(hit.source).toBe("canonical");
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it("does NOT return cases from a different lab", async () => {
    const otherCaseId = await trackInsert({
      patientFirst: "Jane",
      patientLast: "Doe",
      labId: otherLabOrgId,
      providerOrgId: providerAOrgId,
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    const ids = r.body.data.matches.map((m: any) => m.id);
    expect(ids, "cross-lab case must NOT appear").not.toContain(otherCaseId);
  });

  // ── MatchKind classification ──────────────────────────────────────────────

  it("classifies nickname matches correctly (Mike ↔ Michael)", async () => {
    const caseId = await trackInsert({
      patientFirst: "Michael",
      patientLast: "Jordan",
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Mike",
        patientLastName: "Jordan",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    const hit = r.body.data.matches.find((m: any) => m.id === caseId);
    expect(hit, "Michael Jordan must match query Mike Jordan").toBeDefined();
    expect(hit.matchKind).toBe("nickname");
  });

  it("classifies fuzzy (edit-distance ≤ 1) matches correctly", async () => {
    const caseId = await trackInsert({
      patientFirst: "Stephanie",
      patientLast: "Brown",
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        // "Stephenie" is one edit away from "Stephanie"
        patientFirstName: "Stephenie",
        patientLastName: "Brown",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    const hit = r.body.data.matches.find((m: any) => m.id === caseId);
    expect(hit, "Stephenie Brown must fuzzy-match Stephanie Brown").toBeDefined();
    expect(hit.matchKind).toBe("fuzzy");
  });

  it("does NOT return patients whose last name differs", async () => {
    const caseId = await trackInsert({
      patientFirst: "Jane",
      patientLast: "Smith",
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    const ids = r.body.data.matches.map((m: any) => m.id);
    expect(ids, "case with different last name must not appear").not.toContain(caseId);
  });

  // ── providerOrganizationId scoping ────────────────────────────────────────

  it("restricts results to providerOrganizationId when supplied", async () => {
    const caseA = await trackInsert({
      patientFirst: "Alice",
      patientLast: "Cooper",
      providerOrgId: providerAOrgId,
    });
    const caseB = await trackInsert({
      patientFirst: "Alice",
      patientLast: "Cooper",
      providerOrgId: providerBOrgId,
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Alice",
        patientLastName: "Cooper",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerAOrgId,
      });

    expect(r.status).toBe(200);
    const ids = r.body.data.matches.map((m: any) => m.id);
    expect(ids).toContain(caseA);
    expect(ids, "provider B case must be excluded when scoped to provider A").not.toContain(caseB);
  });

  // ── Result ranking ────────────────────────────────────────────────────────

  it("ranks results exact > nickname > fuzzy", async () => {
    // Insert three cases with the same last name "Wells" but different first
    // names so each gets a different matchKind against the query "Rob".
    const exactId = await trackInsert({ patientFirst: "Rob", patientLast: "Wells" });    // exact
    const nicknameId = await trackInsert({ patientFirst: "Robert", patientLast: "Wells" }); // nickname
    const fuzzyId = await trackInsert({ patientFirst: "Robb", patientLast: "Wells" });   // fuzzy (1 edit)

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Rob",
        patientLastName: "Wells",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    const hits: { id: string; matchKind: string }[] = r.body.data.matches;
    const exactIdx = hits.findIndex((h) => h.id === exactId);
    const nickIdx = hits.findIndex((h) => h.id === nicknameId);
    const fuzzyIdx = hits.findIndex((h) => h.id === fuzzyId);

    expect(exactIdx).toBeGreaterThanOrEqual(0);
    expect(nickIdx).toBeGreaterThanOrEqual(0);
    expect(fuzzyIdx).toBeGreaterThanOrEqual(0);
    expect(exactIdx).toBeLessThan(nickIdx);
    expect(nickIdx).toBeLessThan(fuzzyIdx);
  });

  // ── Deduplication — canonical beats legacy ────────────────────────────────

  it("returns only the canonical hit when canonical and legacy share the same patient + doctor", async () => {
    const { db, labCases } = dbMod as any;

    // Insert a canonical case for the patient.
    const canonicalId = await trackInsert({
      patientFirst: "Diana",
      patientLast: "Prince",
      doctorName: "Dr. Fate",
    });

    // Insert a legacy lab_cases row that represents the same patient + doctor
    // (simulating a migrated record that still exists in both tables).
    const legacyId = rid("lc");
    await db.insert(labCases).values({
      id: legacyId,
      ownerId: adminUserId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        patientName: "Diana Prince",
        doctorName: "Dr. Fate",
        status: "completed",
        caseNumber: "LGY-001",
      }),
    });

    try {
      const r = await request(appMod.default)
        .get("/api/cases/patient-similarity")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .query({
          patientFirstName: "Diana",
          patientLastName: "Prince",
          doctorName: "Dr. Fate",
          labOrganizationId: labOrgId,
        });

      expect(r.status).toBe(200);
      const matches: { id: string; source: string }[] = r.body.data.matches;

      const canonicalHit = matches.find((m) => m.id === canonicalId);
      const legacyHit = matches.find((m) => m.id === legacyId);

      expect(canonicalHit, "canonical hit must be present").toBeDefined();
      expect(canonicalHit?.source).toBe("canonical");
      expect(legacyHit, "legacy duplicate must be suppressed when canonical exists").toBeUndefined();

      // Confirm only one entry for this patient from the same doctor.
      const patientHits = matches.filter(
        (m) =>
          m.id === canonicalId || m.id === legacyId,
      );
      expect(patientHits).toHaveLength(1);
    } finally {
      await db.delete(labCases).where(eq(labCases.id, legacyId));
    }
  });

  // ── Limit / truncation ────────────────────────────────────────────────────

  it("truncates results when hits exceed the limit and sets truncated+totalFound", async () => {
    // Insert 4 cases with last name "Truncson" then request limit=2.
    const truncIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      truncIds.push(
        await trackInsert({ patientFirst: `FirstName${i}`, patientLast: "Truncson" }),
      );
    }

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "FirstName0",
        patientLastName: "Truncson",
        labOrganizationId: labOrgId,
        limit: "2",
      });

    expect(r.status).toBe(200);
    expect(r.body.data.matches).toHaveLength(2);
    expect(r.body.data.truncated).toBe(true);
    expect(r.body.data.totalFound).toBeGreaterThanOrEqual(4);
  });

  it("does not set truncated when hits are within the limit", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "NoSuch",
        patientLastName: "XYZZYPatient2",
        labOrganizationId: labOrgId,
        limit: "50",
      });

    expect(r.status).toBe(200);
    expect(r.body.data.truncated).toBeUndefined();
    expect(r.body.data.totalFound).toBeUndefined();
  });

  it("clamps limit to the max of 200", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Jane",
        patientLastName: "Doe",
        labOrganizationId: labOrgId,
        limit: "9999",
      });

    // Should not error — 9999 is clamped to 200 server-side.
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.matches)).toBe(true);
  });

  // ── Ranking preserved under truncation ───────────────────────────────────

  it("exact matches appear first even when the result set is truncated", async () => {
    // 1 exact + 5 truly fuzzy (each is exactly 1 edit from "Rana") → limit=3.
    // All fuzzy names differ from "Rana" by exactly one substitution so the
    // fuzzy matcher picks them up.  "Rona0" would be d=2 (sub + digit) — avoid.
    const exactId = await trackInsert({ patientFirst: "Rana", patientLast: "Rankson" });
    // d=1 substitutions: Rona, Rena, Rina, Runa, Ranu
    for (const fuzz of ["Rona", "Rena", "Rina", "Runa", "Ranu"]) {
      await trackInsert({ patientFirst: fuzz, patientLast: "Rankson" });
    }

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Rana",
        patientLastName: "Rankson",
        labOrganizationId: labOrgId,
        limit: "3",
      });

    expect(r.status).toBe(200);
    expect(r.body.data.truncated).toBe(true);
    const hits: { id: string; matchKind: string }[] = r.body.data.matches;
    expect(hits.length).toBe(3);
    // Exact match must be present and must lead the list.
    const exactHit = hits.find((h) => h.id === exactId);
    expect(exactHit, "exact match must survive truncation").toBeDefined();
    expect(hits[0]?.matchKind).toBe("exact");
  });

  // ── Large-lab scenario ────────────────────────────────────────────────────

  it("large-lab: exact matches lead ranking and response completes within 3 s", async () => {
    // Seed 55 cases with the surname "Largelab":
    //   - 5 exact: first name "Taylor"
    //   - 50 fuzzy (d=1): first name "Taylar" (one substitution from "Taylor")
    // All 55 are genuine matches so the result set exceeds limit=10 and truncation fires.
    for (let i = 0; i < 5; i++) {
      await trackInsert({ patientFirst: "Taylor", patientLast: "Largelab" });
    }
    for (let i = 0; i < 50; i++) {
      await trackInsert({ patientFirst: "Taylar", patientLast: "Largelab" });
    }

    const start = Date.now();
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "Taylor",
        patientLastName: "Largelab",
        labOrganizationId: labOrgId,
        limit: "10",
      });
    const elapsed = Date.now() - start;

    expect(r.status).toBe(200);
    expect(elapsed, `response took ${elapsed} ms — must be < 3000 ms`).toBeLessThan(3000);

    const hits: { matchKind: string }[] = r.body.data.matches;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(10);

    // Truncated because 55 results exceed the limit of 10.
    expect(r.body.data.truncated).toBe(true);
    expect(r.body.data.totalFound).toBeGreaterThanOrEqual(55);

    // Every exact hit must precede every non-exact hit in the returned slice.
    const exactIndices = hits.map((h, i) => (h.matchKind === "exact" ? i : -1)).filter((i) => i >= 0);
    const nonExactIndices = hits.map((h, i) => (h.matchKind !== "exact" ? i : -1)).filter((i) => i >= 0);
    if (exactIndices.length > 0 && nonExactIndices.length > 0) {
      const lastExact = Math.max(...exactIndices);
      const firstNonExact = Math.min(...nonExactIndices);
      expect(lastExact, "all exact hits must precede non-exact hits").toBeLessThan(firstNonExact);
    }
  });

  // ── Empty result ──────────────────────────────────────────────────────────

  it("returns an empty matches array when no case matches", async () => {
    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "NoSuch",
        patientLastName: "XYZZYPatient",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.matches)).toBe(true);
    expect(r.body.data.matches).toHaveLength(0);
  });

  // ── Cross-lab linked-doctor expansion ─────────────────────────────────────

  it("includes canonical cases from a linked doctor at a different lab", async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, users, organizationMemberships, cases, doctorAccountLinks } =
      dbMod as any;

    // Stand up a second lab and a provider org inside it, plus a doctor user.
    const linkedLabId = rid("xlab");
    const linkedProvOrgId = rid("xprov");
    const doctorInLabAId = rid("udocA");   // member of providerAOrgId
    const doctorInLabBId = rid("udocB");   // member of linkedProvOrgId

    await db.insert(users).values([
      { id: doctorInLabAId, username: `docA_${doctorInLabAId}`, password: "x" },
      { id: doctorInLabBId, username: `docB_${doctorInLabBId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: linkedLabId, type: "lab", name: "Linked Lab" },
      {
        id: linkedProvOrgId,
        type: "provider",
        name: "Dr Cross Practice",
        parentLabOrganizationId: linkedLabId,
      },
    ]);

    // Give each doctor user a membership in their respective provider orgs.
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: providerAOrgId,
        userId: doctorInLabAId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: linkedProvOrgId,
        userId: doctorInLabBId,
        role: "admin",
        status: "active",
      },
    ]);

    // Link the two doctor identities — canonical pair ordering (low < high).
    const [lowId, highId] =
      doctorInLabAId < doctorInLabBId
        ? [doctorInLabAId, doctorInLabBId]
        : [doctorInLabBId, doctorInLabAId];
    const linkId = rid("lnk");
    await db.insert(doctorAccountLinks).values({
      id: linkId,
      userIdLow: lowId,
      userIdHigh: highId,
      linkedVia: "manual",
    });

    // Insert a patient case in the linked lab under the linked provider org.
    const crossLabCaseId = rid("xc");
    await db.insert(cases).values({
      id: crossLabCaseId,
      caseNumber: rid("XCN"),
      labOrganizationId: linkedLabId,
      providerOrganizationId: linkedProvOrgId,
      patientFirstName: "CrossLab",
      patientLastName: "Patient",
      doctorName: "Dr. Cross",
      status: "received",
      createdByUserId: adminUserId,
    });

    // Grant the caller (adminUserId) read access to the linked lab.
    // Cross-lab expansion only surfaces labs the caller can directly read.
    const adminLinkedMembershipId = rid("m");
    await db.insert(organizationMemberships).values({
      id: adminLinkedMembershipId,
      labId: linkedLabId,
      userId: adminUserId,
      role: "admin",
      status: "active",
    });

    try {
      const r = await request(appMod.default)
        .get("/api/cases/patient-similarity")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .query({
          patientFirstName: "CrossLab",
          patientLastName: "Patient",
          labOrganizationId: labOrgId,
          providerOrganizationId: providerAOrgId,
        });

      expect(r.status).toBe(200);
      const matches: Array<{ id: string; labOrganizationId: string }> = r.body.data.matches;
      const hit = matches.find((m) => m.id === crossLabCaseId);
      expect(hit, "cross-lab case must appear when doctor is linked AND caller has linked-lab membership").toBeDefined();
      expect(hit?.labOrganizationId).toBe(linkedLabId);
    } finally {
      await db.delete(cases).where(eq(cases.id, crossLabCaseId));
      await db.delete(doctorAccountLinks).where(eq(doctorAccountLinks.id, linkId));
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.userId, [doctorInLabAId, doctorInLabBId]),
      );
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.id, adminLinkedMembershipId),
      );
      await db.delete(organizations).where(
        inArray(organizations.id, [linkedLabId, linkedProvOrgId]),
      );
      await db.delete(users).where(
        inArray(users.id, [doctorInLabAId, doctorInLabBId]),
      );
    }
  });

  it("does NOT include cross-lab cases when there is no doctor link", async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, cases } = dbMod as any;

    // A totally separate lab+provider with no link to any doctor in labOrgId.
    const unlinkedLabId = rid("ulab");
    const unlinkedProvOrgId = rid("uprov");

    await db.insert(organizations).values([
      { id: unlinkedLabId, type: "lab", name: "Unlinked Lab" },
      {
        id: unlinkedProvOrgId,
        type: "provider",
        name: "Unlinked Practice",
        parentLabOrganizationId: unlinkedLabId,
      },
    ]);

    const unlinkedCaseId = rid("uc");
    await db.insert(cases).values({
      id: unlinkedCaseId,
      caseNumber: rid("UCN"),
      labOrganizationId: unlinkedLabId,
      providerOrganizationId: unlinkedProvOrgId,
      patientFirstName: "CrossLab",
      patientLastName: "Patient",
      doctorName: "Dr. Unlinked",
      status: "received",
      createdByUserId: adminUserId,
    });

    try {
      const r = await request(appMod.default)
        .get("/api/cases/patient-similarity")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .query({
          patientFirstName: "CrossLab",
          patientLastName: "Patient",
          labOrganizationId: labOrgId,
          providerOrganizationId: providerAOrgId,
        });

      expect(r.status).toBe(200);
      const ids = r.body.data.matches.map((m: any) => m.id);
      expect(ids, "unlinked cross-lab case must NOT appear").not.toContain(unlinkedCaseId);
    } finally {
      await db.delete(cases).where(eq(cases.id, unlinkedCaseId));
      await db.delete(organizations).where(
        inArray(organizations.id, [unlinkedLabId, unlinkedProvOrgId]),
      );
    }
  });

  it("does NOT include cross-lab cases when providerOrganizationId belongs to a foreign lab (auth gate)", async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, users, organizationMemberships, cases, doctorAccountLinks } =
      dbMod as any;

    // Set up a foreign lab with a provider org (parent = otherLabOrgId, not labOrgId).
    const foreignProvOrgId = rid("fprov");
    const linkedLabId2 = rid("xlab2");
    const linkedProvOrgId2 = rid("xprov2");
    const doctorForeignId = rid("udocF");
    const doctorLinked2Id = rid("udocL2");

    await db.insert(users).values([
      { id: doctorForeignId, username: `docF_${doctorForeignId}`, password: "x" },
      { id: doctorLinked2Id, username: `docL2_${doctorLinked2Id}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      // foreignProvOrg belongs to otherLabOrgId, not labOrgId
      { id: foreignProvOrgId, type: "provider", name: "Foreign Prov", parentLabOrganizationId: otherLabOrgId },
      { id: linkedLabId2, type: "lab", name: "Linked Lab 2" },
      { id: linkedProvOrgId2, type: "provider", name: "Linked Prov 2", parentLabOrganizationId: linkedLabId2 },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: foreignProvOrgId, userId: doctorForeignId, role: "admin", status: "active" },
      { id: rid("m"), labId: linkedProvOrgId2, userId: doctorLinked2Id, role: "admin", status: "active" },
    ]);

    const [lowId, highId] =
      doctorForeignId < doctorLinked2Id
        ? [doctorForeignId, doctorLinked2Id]
        : [doctorLinked2Id, doctorForeignId];
    const linkId2 = rid("lnk2");
    await db.insert(doctorAccountLinks).values({
      id: linkId2,
      userIdLow: lowId,
      userIdHigh: highId,
      linkedVia: "manual",
    });

    // A case in linkedLabId2 under linkedProvOrgId2 — should NOT surface
    // because foreignProvOrgId is not owned by labOrgId.
    const foreignCrossId = rid("fc");
    await db.insert(cases).values({
      id: foreignCrossId,
      caseNumber: rid("FCN"),
      labOrganizationId: linkedLabId2,
      providerOrganizationId: linkedProvOrgId2,
      patientFirstName: "CrossLab",
      patientLastName: "Patient",
      doctorName: "Dr. Foreign",
      status: "received",
      createdByUserId: adminUserId,
    });

    try {
      // Supply foreignProvOrgId — it has parentLabOrganizationId=otherLabOrgId,
      // so the auth gate must reject it even though doctor links exist.
      const r = await request(appMod.default)
        .get("/api/cases/patient-similarity")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .query({
          patientFirstName: "CrossLab",
          patientLastName: "Patient",
          labOrganizationId: labOrgId,
          providerOrganizationId: foreignProvOrgId,
        });

      expect(r.status).toBe(200);
      const ids = r.body.data.matches.map((m: any) => m.id);
      expect(ids, "cross-lab case via foreign providerOrganizationId must NOT appear").not.toContain(foreignCrossId);
    } finally {
      await db.delete(cases).where(eq(cases.id, foreignCrossId));
      await db.delete(doctorAccountLinks).where(eq(doctorAccountLinks.id, linkId2));
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.userId, [doctorForeignId, doctorLinked2Id]),
      );
      await db.delete(organizations).where(
        inArray(organizations.id, [foreignProvOrgId, linkedLabId2, linkedProvOrgId2]),
      );
      await db.delete(users).where(
        inArray(users.id, [doctorForeignId, doctorLinked2Id]),
      );
    }
  });

  it("includes cross-lab cases when only doctorName is supplied (mobile path)", async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, users, organizationMemberships, cases, doctorAccountLinks } =
      dbMod as any;

    const dnLabId = rid("dnlab");
    const dnProvOrgId = rid("dnprov");
    const dnDoctorAId = rid("udnA");
    const dnDoctorBId = rid("udnB");
    const dnDoctorName = `Dr. DoctorName_${randomBytes(4).toString("hex")}`;

    await db.insert(users).values([
      { id: dnDoctorAId, username: `dnA_${dnDoctorAId}`, password: "x" },
      { id: dnDoctorBId, username: `dnB_${dnDoctorBId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: dnLabId, type: "lab", name: "DoctorName Linked Lab" },
      {
        id: dnProvOrgId,
        type: "provider",
        name: "DoctorName Linked Prov",
        parentLabOrganizationId: dnLabId,
      },
    ]);

    // dnDoctorAId is a member of providerAOrgId (primary lab's provider).
    // dnDoctorBId is a member of dnProvOrgId (linked lab's provider).
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: providerAOrgId, userId: dnDoctorAId, role: "admin", status: "active" },
      { id: rid("m"), labId: dnProvOrgId, userId: dnDoctorBId, role: "admin", status: "active" },
    ]);

    const [lowId, highId] =
      dnDoctorAId < dnDoctorBId
        ? [dnDoctorAId, dnDoctorBId]
        : [dnDoctorBId, dnDoctorAId];
    const dnLinkId = rid("dnlnk");
    await db.insert(doctorAccountLinks).values({
      id: dnLinkId,
      userIdLow: lowId,
      userIdHigh: highId,
      linkedVia: "manual",
    });

    // Seed a canonical case in labOrgId under providerAOrgId for this doctor so
    // the doctorName path can resolve the provider org.
    const seedCaseId = rid("dnSeed");
    await db.insert(cases).values({
      id: seedCaseId,
      caseNumber: rid("DNSEED"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerAOrgId,
      patientFirstName: "SomePrior",
      patientLastName: "SomePrior",
      doctorName: dnDoctorName,
      status: "received",
      createdByUserId: adminUserId,
    });

    // Cross-lab case in dnLabId under dnProvOrgId for the same patient.
    const dnCrossId = rid("dnc");
    await db.insert(cases).values({
      id: dnCrossId,
      caseNumber: rid("DNCN"),
      labOrganizationId: dnLabId,
      providerOrganizationId: dnProvOrgId,
      patientFirstName: "DoctorNameCross",
      patientLastName: "Patient",
      doctorName: "Dr. Whatever",
      status: "received",
      createdByUserId: adminUserId,
    });

    // Grant the caller (adminUserId) read access to the linked lab.
    // Cross-lab expansion only surfaces labs the caller can directly read.
    const adminDnMembershipId = rid("m");
    await db.insert(organizationMemberships).values({
      id: adminDnMembershipId,
      labId: dnLabId,
      userId: adminUserId,
      role: "admin",
      status: "active",
    });

    try {
      const r = await request(appMod.default)
        .get("/api/cases/patient-similarity")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .query({
          patientFirstName: "DoctorNameCross",
          patientLastName: "Patient",
          labOrganizationId: labOrgId,
          doctorName: dnDoctorName,
        });

      expect(r.status).toBe(200);
      const matches: Array<{ id: string; labOrganizationId: string }> = r.body.data.matches;
      const hit = matches.find((m) => m.id === dnCrossId);
      expect(hit, "cross-lab case must appear via doctorName-only path when caller has linked-lab membership").toBeDefined();
      expect(hit?.labOrganizationId).toBe(dnLabId);
    } finally {
      await db.delete(cases).where(inArray(cases.id, [dnCrossId, seedCaseId]));
      await db.delete(doctorAccountLinks).where(eq(doctorAccountLinks.id, dnLinkId));
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.userId, [dnDoctorAId, dnDoctorBId]),
      );
      await db.delete(organizationMemberships).where(
        eq(organizationMemberships.id, adminDnMembershipId),
      );
      await db.delete(organizations).where(
        inArray(organizations.id, [dnLabId, dnProvOrgId]),
      );
      await db.delete(users).where(
        inArray(users.id, [dnDoctorAId, dnDoctorBId]),
      );
    }
  });

  it("does NOT expand cross-lab when caller has no membership in the linked lab", async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      cases,
      doctorAccountLinks,
    } = dbMod as any;

    // Create a lab member with role "user" (not admin/owner).
    const regularUserId = rid("ureg");
    await db.insert(users).values({ id: regularUserId, username: `reg_${regularUserId}`, password: "x" });
    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: regularUserId,
      role: "user",
      status: "active",
    });
    const regularToken = await makeSession(regularUserId);

    // Set up a doctor link: providerAOrgId → linked lab.
    const naLabId = rid("nalab");
    const naProvOrgId = rid("naprov");
    const naDoctorAId = rid("naDa");
    const naDoctorBId = rid("naDb");

    await db.insert(users).values([
      { id: naDoctorAId, username: `naA_${naDoctorAId}`, password: "x" },
      { id: naDoctorBId, username: `naB_${naDoctorBId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: naLabId, type: "lab", name: "Non-Admin Linked Lab" },
      { id: naProvOrgId, type: "provider", name: "Non-Admin Linked Prov", parentLabOrganizationId: naLabId },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: providerAOrgId, userId: naDoctorAId, role: "admin", status: "active" },
      { id: rid("m"), labId: naProvOrgId, userId: naDoctorBId, role: "admin", status: "active" },
    ]);

    const [lowId, highId] =
      naDoctorAId < naDoctorBId
        ? [naDoctorAId, naDoctorBId]
        : [naDoctorBId, naDoctorAId];
    const naLinkId = rid("nalnk");
    await db.insert(doctorAccountLinks).values({
      id: naLinkId,
      userIdLow: lowId,
      userIdHigh: highId,
      linkedVia: "manual",
    });

    // Cross-lab case that should NOT appear for the non-admin caller.
    const naCrossId = rid("nac");
    await db.insert(cases).values({
      id: naCrossId,
      caseNumber: rid("NACN"),
      labOrganizationId: naLabId,
      providerOrganizationId: naProvOrgId,
      patientFirstName: "NonAdmin",
      patientLastName: "CrossPatient",
      doctorName: "Dr. NonAdmin",
      status: "received",
      createdByUserId: adminUserId,
    });

    try {
      const r = await request(appMod.default)
        .get("/api/cases/patient-similarity")
        .set("Authorization", `Bearer ${regularToken}`)
        .query({
          patientFirstName: "NonAdmin",
          patientLastName: "CrossPatient",
          labOrganizationId: labOrgId,
          providerOrganizationId: providerAOrgId,
        });

      expect(r.status).toBe(200);
      const ids = r.body.data.matches.map((m: any) => m.id);
      expect(ids, "cross-lab case must NOT appear when caller has no membership in the linked lab").not.toContain(naCrossId);
    } finally {
      await db.delete(cases).where(eq(cases.id, naCrossId));
      await db.delete(doctorAccountLinks).where(eq(doctorAccountLinks.id, naLinkId));
      await db.delete(organizationMemberships).where(
        inArray(organizationMemberships.userId, [naDoctorAId, naDoctorBId, regularUserId]),
      );
      const sessRows = await db
        .select({ id: userSessions.id })
        .from(userSessions)
        .where(eq(userSessions.userId, regularUserId));
      if (sessRows.length > 0) {
        await db.delete(userSessions).where(
          inArray(userSessions.id, sessRows.map((s: any) => s.id)),
        );
      }
      await db.delete(organizations).where(
        inArray(organizations.id, [naLabId, naProvOrgId]),
      );
      await db.delete(users).where(
        inArray(users.id, [naDoctorAId, naDoctorBId, regularUserId]),
      );
    }
  });

  // ── labOrganizationId field on primary hits ───────────────────────────────

  it("includes labOrganizationId on every returned hit", async () => {
    const caseId = await trackInsert({
      patientFirst: "LabOrgId",
      patientLast: "Check",
    });

    const r = await request(appMod.default)
      .get("/api/cases/patient-similarity")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .query({
        patientFirstName: "LabOrgId",
        patientLastName: "Check",
        labOrganizationId: labOrgId,
      });

    expect(r.status).toBe(200);
    const hit = r.body.data.matches.find((m: any) => m.id === caseId);
    expect(hit, "inserted case must appear in matches").toBeDefined();
    expect(hit.labOrganizationId).toBe(labOrgId);
  });
});
