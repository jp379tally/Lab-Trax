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
import { eq, inArray } from "drizzle-orm";
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
});
