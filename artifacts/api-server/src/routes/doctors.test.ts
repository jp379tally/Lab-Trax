/**
 * Integration tests for the doctor merge endpoints (Task #382).
 *
 * Skipped when no DATABASE_URL is configured — same convention as
 * `cases-similarity.test.ts` and `cross-lab-doctor.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Task #382 doctor merge route (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");
  const adminUserId = rid("uadmin");
  const memberUserId = rid("umember");
  const otherLabAdminId = rid("uother");

  const tokens = {
    admin: "",
    member: "",
    otherLabAdmin: "",
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
    deletedAt?: Date | null;
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
      deletedAt: opts.deletedAt ?? null,
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
      practiceName: "Practice",
      pricingTierId: null,
    });
    return id;
  }

  // Legacy mobile cases keep the doctor name inside a TEXT JSON blob.
  async function insertLegacyCase(opts: {
    id?: string;
    caseData: unknown;
    labId?: string;
    deletedAt?: Date | null;
  }) {
    const { db, labCases } = dbMod as any;
    const id = opts.id ?? rid("lc");
    await db.insert(labCases).values({
      id,
      ownerId: adminUserId,
      organizationId: opts.labId ?? labOrgId,
      caseData:
        typeof opts.caseData === "string"
          ? opts.caseData
          : JSON.stringify(opts.caseData),
      deletedAt: opts.deletedAt ?? null,
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-doctors-merge";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
      {
        id: otherLabAdminId,
        username: `oth_${otherLabAdminId}`,
        password: "x",
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Test Lab" },
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
        role: "member",
        status: "active",
      },
      {
        id: rid("m"),
        labId: otherLabOrgId,
        userId: otherLabAdminId,
        role: "admin",
        status: "active",
      },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.member = await makeSession(memberUserId);
    tokens.otherLabAdmin = await makeSession(otherLabAdminId);
  });

  // Refresh session tokens before every test so a concurrent backup-restore
  // TRUNCATE of user_sessions (which happens during backup-restore.test.ts)
  // does not leave stale / invalidated tokens causing spurious 401s.
  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.member = await makeSession(memberUserId);
    tokens.otherLabAdmin = await makeSession(otherLabAdminId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      pricingOverrides,
      organizationMemberships,
      userSessions,
      auditLogs,
      labCases,
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(labCases)
      .where(inArray(labCases.organizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(pricingOverrides)
      .where(eq(pricingOverrides.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(
        inArray(organizationMemberships.userId, [
          adminUserId,
          memberUserId,
          otherLabAdminId,
        ])
      );
    await db
      .delete(userSessions)
      .where(
        inArray(userSessions.userId, [
          adminUserId,
          memberUserId,
          otherLabAdminId,
        ])
      );
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId,
          otherLabOrgId,
          practiceAId,
          practiceBId,
        ])
      );
    await db
      .delete(users)
      .where(
        inArray(users.id, [adminUserId, memberUserId, otherLabAdminId])
      );
  });

  it("rejects non-admin members", async () => {
    const c1 = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Smith",
      practiceId: practiceAId,
    });
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Smithe",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Smith", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const { db, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, c1));
  });

  it("rejects when practice belongs to a different lab", async () => {
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.otherLabAdmin}`)
      .send({
        labOrganizationId: otherLabOrgId,
        targetDoctorName: "Dr. Smith",
        targetProviderOrganizationId: practiceAId, // belongs to labOrgId
        sources: [{ doctorName: "Dr. X", providerOrganizationId: null }],
      });
    expect(r.status).toBe(400);
  });

  it("merges multi-source: cases + pricing overrides, with collapse", async () => {
    const ids: string[] = [];
    ids.push(
      await insertCase({
        caseNumber: rid("CN"),
        doctorName: "Dr. Smith",
        practiceId: practiceAId,
      })
    );
    ids.push(
      await insertCase({
        caseNumber: rid("CN"),
        doctorName: "Dr Smith",
        practiceId: practiceAId,
      })
    );
    ids.push(
      await insertCase({
        caseNumber: rid("CN"),
        doctorName: "Dr. SMYTH",
        practiceId: practiceBId,
      })
    );
    const softId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Smith",
      practiceId: practiceAId,
      deletedAt: new Date(),
    });

    // Two source overrides + an existing target override → one source
    // should collapse, the other should be remapped.
    const ovSrc1 = await insertOverride({
      doctorName: "Dr. Smith",
      practiceId: practiceAId,
    });
    const ovTarget = await insertOverride({
      doctorName: "Dr. Smyth",
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Smyth",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Smith", providerOrganizationId: practiceAId },
          { doctorName: "Dr Smith", providerOrganizationId: practiceAId },
          { doctorName: "Dr. SMYTH", providerOrganizationId: practiceBId },
        ],
      });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.casesMoved).toBe(3); // soft-deleted not included
    expect(r.body.data.entries).toHaveLength(3);
    const entryNames = r.body.data.entries.map(
      (e: any) => e.sourceDoctorName
    );
    expect(entryNames).toContain("Dr. Smith");
    expect(entryNames).toContain("Dr. SMYTH");

    const { db, cases, pricingOverrides } = dbMod as any;
    const moved = await db
      .select()
      .from(cases)
      .where(inArray(cases.id, ids));
    for (const row of moved) {
      expect(row.doctorName).toBe("Dr. Smyth");
      expect(row.providerOrganizationId).toBe(practiceAId);
    }
    // Soft-deleted case stays where it was (default opt-out).
    const [softRow] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, softId));
    expect(softRow.doctorName).toBe("Dr. Smith");

    const ov1 = await db
      .select()
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovSrc1));
    expect(ov1[0].deletedAt).not.toBeNull(); // collapsed onto target
    const ovT = await db
      .select()
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovTarget));
    expect(ovT[0].deletedAt).toBeNull();

    // Cleanup
    await db.delete(cases).where(inArray(cases.id, [...ids, softId]));
    await db
      .delete(pricingOverrides)
      .where(inArray(pricingOverrides.id, [ovSrc1, ovTarget]));
  });

  it("includeSoftDeleted=true also moves soft-deleted cases", async () => {
    const live = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Jones",
      practiceId: practiceAId,
    });
    const soft = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Jones",
      practiceId: practiceAId,
      deletedAt: new Date(),
    });

    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Jonez",
        targetProviderOrganizationId: practiceAId,
        includeSoftDeleted: true,
        sources: [
          { doctorName: "Dr. Jones", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.data.casesMoved).toBe(2);

    const { db, cases } = dbMod as any;
    const rows = await db
      .select()
      .from(cases)
      .where(inArray(cases.id, [live, soft]));
    for (const row of rows) expect(row.doctorName).toBe("Dr. Jonez");
    await db.delete(cases).where(inArray(cases.id, [live, soft]));
  });

  it("undo within window restores; tampered state refuses", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      ids.push(
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Original",
          practiceId: practiceAId,
        })
      );
    }
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Renamed",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Original", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(200);
    const auditLogId = r.body.data.entries[0].auditLogId;

    // Undo brings the rows back.
    const u = await request(appMod.default)
      .post(`/api/doctors/merge/${auditLogId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(u.status).toBe(200);
    expect(u.body.data.casesReverted).toBe(2);

    const { db, cases, auditLogs } = dbMod as any;
    const rows = await db
      .select()
      .from(cases)
      .where(inArray(cases.id, ids));
    for (const row of rows) expect(row.doctorName).toBe("Dr. Original");

    // Re-merge to a different name then tamper one row → undo refused.
    const r2 = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Renamed2",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Original", providerOrganizationId: practiceAId },
        ],
      });
    const audit2 = r2.body.data.entries[0].auditLogId;
    await db
      .update(cases)
      .set({ doctorName: "Dr. EditedAfter" })
      .where(eq(cases.id, ids[0]));
    const blocked = await request(appMod.default)
      .post(`/api/doctors/merge/${audit2}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(blocked.status).toBe(409);

    // Past-window undo: backdate the audit row to 11 minutes ago.
    await db
      .update(auditLogs)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(auditLogs.id, audit2));
    // Restore the tampered row first so the time check is what fails.
    await db
      .update(cases)
      .set({ doctorName: "Dr. Renamed2" })
      .where(eq(cases.id, ids[0]));
    const expired = await request(appMod.default)
      .post(`/api/doctors/merge/${audit2}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(expired.status).toBe(409);

    await db.delete(cases).where(inArray(cases.id, ids));
  }, 30000);

  it("respects DOCTOR_MERGE_UNDO_WINDOW_MINUTES override", async () => {
    const id = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Window",
      practiceId: practiceAId,
    });
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Window2",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Window", providerOrganizationId: practiceAId },
        ],
      });
    const auditId = r.body.data.entries[0].auditLogId;
    const { db, auditLogs, cases } = dbMod as any;

    // Backdate 3 minutes; default 10-min window should still allow undo.
    await db
      .update(auditLogs)
      .set({ createdAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(auditLogs.id, auditId));

    process.env["DOCTOR_MERGE_UNDO_WINDOW_MINUTES"] = "1";
    try {
      const blocked = await request(appMod.default)
        .post(`/api/doctors/merge/${auditId}/undo`)
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({});
      expect(blocked.status).toBe(409);
      expect(String(blocked.body.message)).toMatch(/1-minute/);
    } finally {
      delete process.env["DOCTOR_MERGE_UNDO_WINDOW_MINUTES"];
    }

    // Default window allows the undo.
    const ok2 = await request(appMod.default)
      .post(`/api/doctors/merge/${auditId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(ok2.status).toBe(200);

    await db.delete(cases).where(eq(cases.id, id));
  });

  it("preview returns exact case totals (no cap)", async () => {
    // Insert 12 cases so we exercise count + recent-list independence.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Counted",
          practiceId: practiceAId,
        })
      );
    }
    const r = await request(appMod.default)
      .post("/api/doctors/merge/preview")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. CountedTarget",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Counted", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.data.totalCases).toBe(12);
    expect(r.body.data.sources[0].totalCases).toBe(12);
    expect(r.body.data.sources[0].recentCaseNumbers.length).toBe(5);

    const { db, cases } = dbMod as any;
    await db.delete(cases).where(inArray(cases.id, ids));
  });

  it("undo refused when a moved pricing override was edited after the merge", async () => {
    const cId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. OvEdit",
      practiceId: practiceAId,
    });
    const ovId = await insertOverride({
      doctorName: "Dr. OvEdit",
      practiceId: practiceAId,
    });
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. OvEdit2",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. OvEdit", providerOrganizationId: practiceAId },
        ],
      });
    const auditId = r.body.data.entries[0].auditLogId;

    const { db, pricingOverrides, cases } = dbMod as any;
    await db
      .update(pricingOverrides)
      .set({ doctorName: "Dr. OvEditedAfter" })
      .where(eq(pricingOverrides.id, ovId));

    const blocked = await request(appMod.default)
      .post(`/api/doctors/merge/${auditId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(blocked.status).toBe(409);

    await db.delete(cases).where(eq(cases.id, cId));
    await db
      .delete(pricingOverrides)
      .where(eq(pricingOverrides.id, ovId));
  });

  it("undo refused when a new active override exists at source name (would clobber unique index)", async () => {
    const cId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. OvCollide",
      practiceId: practiceAId,
    });
    const ovId = await insertOverride({
      doctorName: "Dr. OvCollide",
      practiceId: practiceAId,
    });
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. OvCollideTarget",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. OvCollide", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(200);
    const auditId = r.body.data.entries[0].auditLogId;

    // Simulate a user creating a fresh active override at the source
    // doctor name after the merge — this would collide with the
    // partial unique index on (labOrganizationId, doctorName) when undo
    // tries to revert the moved row back. The endpoint must refuse with
    // 409 instead of leaking a raw DB error.
    const newOvId = await insertOverride({
      doctorName: "Dr. OvCollide",
      practiceId: practiceAId,
    });

    const blocked = await request(appMod.default)
      .post(`/api/doctors/merge/${auditId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(blocked.status).toBe(409);

    const { db, pricingOverrides, cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, cId));
    await db
      .delete(pricingOverrides)
      .where(inArray(pricingOverrides.id, [ovId, newOvId]));
  });

  // -------------------------------------------------------------------------
  // Legacy `lab_cases` blob rewriting (the variant-spelling picker fix).
  // The role-agnostic doctor-name picker unions canonical `cases.doctorName`
  // with names parsed out of legacy mobile blobs, so a merge that only
  // rewrites canonical rows leaves merged-away spellings resurfacing. These
  // tests pin the blob rewrite + its undo.
  // -------------------------------------------------------------------------
  it("merge rewrites legacy lab_cases blobs, preserving other keys and skipping malformed", async () => {
    const { db, labCases, cases } = dbMod as any;

    const canonId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Cory CouchA",
      practiceId: practiceAId,
    });

    const legA = await insertLegacyCase({
      caseData: {
        doctorName: "Dr. CouchA",
        patientName: "Jane Roe",
        status: "in_progress",
        nested: { keep: true },
      },
    });
    // Trimmed + different case → still an exact match.
    const legB = await insertLegacyCase({
      caseData: { doctorName: "  dr. couchA  ", note: "keepme" },
    });
    // Malformed (not JSON) → must be left untouched and uncounted.
    const malformed = await insertLegacyCase({ caseData: "{not valid json" });
    // Unrelated doctor → untouched.
    const other = await insertLegacyCase({
      caseData: { doctorName: "Dr. Unrelated" },
    });

    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Cory CouchA",
        targetProviderOrganizationId: practiceAId,
        sources: [{ doctorName: "Dr. CouchA", providerOrganizationId: null }],
      });

    expect(r.status).toBe(200);
    expect(r.body.data.legacyCasesMoved).toBe(2);
    expect(r.body.data.entries[0].legacyCasesMoved).toBe(2);

    const rows = await db
      .select()
      .from(labCases)
      .where(inArray(labCases.id, [legA, legB, malformed, other]));
    const byId = new Map<string, any>(rows.map((x: any) => [x.id, x]));
    const a = JSON.parse(byId.get(legA).caseData);
    expect(a.doctorName).toBe("Dr. Cory CouchA");
    expect(a.patientName).toBe("Jane Roe");
    expect(a.status).toBe("in_progress");
    expect(a.nested).toEqual({ keep: true });
    const b = JSON.parse(byId.get(legB).caseData);
    expect(b.doctorName).toBe("Dr. Cory CouchA");
    expect(b.note).toBe("keepme");
    expect(byId.get(malformed).caseData).toBe("{not valid json");
    expect(JSON.parse(byId.get(other).caseData).doctorName).toBe(
      "Dr. Unrelated"
    );

    await db
      .delete(labCases)
      .where(inArray(labCases.id, [legA, legB, malformed, other]));
    await db.delete(cases).where(eq(cases.id, canonId));
  }, 30000);

  it("merge honors includeSoftDeleted for legacy lab_cases blobs", async () => {
    const { db, labCases } = dbMod as any;
    const live = await insertLegacyCase({
      caseData: { doctorName: "Dr. LegSoft" },
    });
    const soft = await insertLegacyCase({
      caseData: { doctorName: "Dr. LegSoft" },
      deletedAt: new Date(),
    });

    // Default: the soft-deleted legacy blob is left alone.
    const r1 = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. LegSoftTarget",
        targetProviderOrganizationId: practiceAId,
        sources: [{ doctorName: "Dr. LegSoft", providerOrganizationId: null }],
      });
    expect(r1.status).toBe(200);
    expect(r1.body.data.legacyCasesMoved).toBe(1);
    const softAfter1 = (
      await db.select().from(labCases).where(eq(labCases.id, soft))
    )[0];
    expect(JSON.parse(softAfter1.caseData).doctorName).toBe("Dr. LegSoft");

    // includeSoftDeleted:true also rewrites the soft-deleted blob.
    const r2 = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. LegSoftTarget",
        targetProviderOrganizationId: practiceAId,
        includeSoftDeleted: true,
        sources: [{ doctorName: "Dr. LegSoft", providerOrganizationId: null }],
      });
    expect(r2.status).toBe(200);
    expect(r2.body.data.legacyCasesMoved).toBe(1);
    const softAfter2 = (
      await db.select().from(labCases).where(eq(labCases.id, soft))
    )[0];
    expect(JSON.parse(softAfter2.caseData).doctorName).toBe("Dr. LegSoftTarget");

    await db.delete(labCases).where(inArray(labCases.id, [live, soft]));
  }, 30000);

  it("undo restores legacy blob doctorName (preserving other keys) and refuses if renamed after merge", async () => {
    const { db, labCases } = dbMod as any;
    const leg = await insertLegacyCase({
      caseData: { doctorName: "Dr. LegUndo", patientName: "Sam Poe", x: 1 },
    });

    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. LegUndoTarget",
        targetProviderOrganizationId: practiceAId,
        sources: [{ doctorName: "Dr. LegUndo", providerOrganizationId: null }],
      });
    expect(r.status).toBe(200);
    expect(r.body.data.legacyCasesMoved).toBe(1);
    const auditId = r.body.data.entries[0].auditLogId;
    const movedRow = (
      await db.select().from(labCases).where(eq(labCases.id, leg))
    )[0];
    expect(JSON.parse(movedRow.caseData).doctorName).toBe("Dr. LegUndoTarget");

    const u = await request(appMod.default)
      .post(`/api/doctors/merge/${auditId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(u.status).toBe(200);
    expect(u.body.data.legacyReverted).toBe(1);
    const restored = JSON.parse(
      (await db.select().from(labCases).where(eq(labCases.id, leg)))[0].caseData
    );
    expect(restored.doctorName).toBe("Dr. LegUndo");
    expect(restored.patientName).toBe("Sam Poe");
    expect(restored.x).toBe(1);

    // Re-merge, then tamper the blob's doctorName → undo must refuse (409).
    const r2 = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. LegUndoTarget2",
        targetProviderOrganizationId: practiceAId,
        sources: [{ doctorName: "Dr. LegUndo", providerOrganizationId: null }],
      });
    const audit2 = r2.body.data.entries[0].auditLogId;
    await db
      .update(labCases)
      .set({ caseData: JSON.stringify({ doctorName: "Dr. LegUndoEdited", x: 1 }) })
      .where(eq(labCases.id, leg));
    const blocked = await request(appMod.default)
      .post(`/api/doctors/merge/${audit2}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(blocked.status).toBe(409);

    await db.delete(labCases).where(eq(labCases.id, leg));
  }, 30000);

  it("doctor-names stops listing a legacy variant after it is merged away", async () => {
    const { db, labCases, cases } = dbMod as any;
    const canonId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Cory CouchE2E",
      practiceId: practiceAId,
    });
    const leg = await insertLegacyCase({
      caseData: { doctorName: "Dr. CouchE2E" },
    });

    const before = await request(appMod.default)
      .get("/api/cases/doctor-names")
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(before.status).toBe(200);
    expect(before.body.data).toContain("Dr. CouchE2E");
    expect(before.body.data).toContain("Dr. Cory CouchE2E");

    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Cory CouchE2E",
        targetProviderOrganizationId: practiceAId,
        sources: [{ doctorName: "Dr. CouchE2E", providerOrganizationId: null }],
      });
    expect(r.status).toBe(200);
    expect(r.body.data.legacyCasesMoved).toBe(1);

    const after = await request(appMod.default)
      .get("/api/cases/doctor-names")
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(after.status).toBe(200);
    expect(after.body.data).not.toContain("Dr. CouchE2E");
    expect(after.body.data).toContain("Dr. Cory CouchE2E");

    await db.delete(labCases).where(eq(labCases.id, leg));
    await db.delete(cases).where(eq(cases.id, canonId));
  }, 30000);
});

/**
 * Task #2375 — Fix removing a non-provider doctor from a practice.
 *
 * The Doctors list on a practice shows every active member, but the
 * remove-doctor endpoint previously hard-failed with
 * `400 "Only provider users can be removed."` for members whose underlying
 * account type is not `provider`. These tests reproduce that case and assert
 * that removing → Unassigned and reassigning → sibling practice both succeed,
 * while preserving the existing provider-doctor and virtual-doctor behaviour.
 */
maybe("Task #2375 remove non-provider doctor (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const practiceAId = rid("provA");
  const practiceBId = rid("provB");
  const adminUserId = rid("uadmin");

  let adminToken = "";

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

  // Per-test bookkeeping so each scenario cleans up only its own rows.
  const trackUsers: string[] = [];
  const trackCases: string[] = [];
  const trackInvoices: string[] = [];

  async function addNonProviderMember(name: {
    first: string;
    last: string;
  }): Promise<string> {
    const { db, users, organizationMemberships } = dbMod as any;
    const userId = rid("unp");
    await db.insert(users).values({
      id: userId,
      username: `np_${userId}`,
      password: "x",
      firstName: name.first,
      lastName: name.last,
      // Default userType is "lab" — explicitly a non-provider account.
      userType: "lab",
    });
    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: practiceAId,
      userId,
      role: "user",
      status: "active",
      joinedAt: new Date(),
    });
    trackUsers.push(userId);
    return userId;
  }

  async function addCase(opts: {
    doctorName: string;
    practiceId: string;
  }): Promise<string> {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: opts.practiceId,
      doctorName: opts.doctorName,
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    trackCases.push(id);
    return id;
  }

  async function addInvoice(opts: {
    caseId: string;
    practiceId: string;
  }): Promise<string> {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: rid("IN"),
      caseId: opts.caseId,
      labOrganizationId: labOrgId,
      providerOrganizationId: opts.practiceId,
      status: "draft",
      createdByUserId: adminUserId,
    });
    trackInvoices.push(id);
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-remove-doctor";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Remove Doctor Lab" },
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
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
    ]);
    adminToken = await makeSession(adminUserId);
  });

  beforeEach(async () => {
    adminToken = await makeSession(adminUserId);
  });

  afterEach(async () => {
    const {
      db,
      cases,
      invoices,
      organizationMemberships,
      labUnassignedDoctors,
      userSessions,
      users,
    } = dbMod as any;
    if (trackInvoices.length) {
      await db.delete(invoices).where(inArray(invoices.id, trackInvoices));
    }
    if (trackCases.length) {
      await db.delete(cases).where(inArray(cases.id, trackCases));
    }
    if (trackUsers.length) {
      await db
        .delete(labUnassignedDoctors)
        .where(inArray(labUnassignedDoctors.userId, trackUsers));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, trackUsers));
      await db
        .delete(userSessions)
        .where(inArray(userSessions.userId, trackUsers));
      await db.delete(users).where(inArray(users.id, trackUsers));
    }
    trackInvoices.length = 0;
    trackCases.length = 0;
    trackUsers.length = 0;
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      organizations,
      users,
      organizationMemberships,
      userSessions,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, practiceAId, practiceBId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("removes a non-provider member to Unassigned (no holding-area record)", async () => {
    const userId = await addNonProviderMember({ first: "John", last: "Phillips" });

    const r = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId, doctorName: "John Phillips" });

    expect(r.status).toBe(200);
    expect(r.body.data.unassigned).toBe(true);
    expect(r.body.data.userId).toBe(userId);

    const { db, organizationMemberships, labUnassignedDoctors } = dbMod as any;
    // Active membership at the practice is dropped (soft-removed).
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, practiceAId),
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.deletedAt)
      ),
    });
    expect(membership).toBeUndefined();

    // No confusing holding-area entry is created for a non-provider user.
    const holding = await db
      .select()
      .from(labUnassignedDoctors)
      .where(eq(labUnassignedDoctors.userId, userId));
    expect(holding.length).toBe(0);
  });

  it("reassigns a non-provider member to a sibling practice and moves cases", async () => {
    const userId = await addNonProviderMember({ first: "Jane", last: "Doe" });
    const caseId = await addCase({
      doctorName: "Jane Doe",
      practiceId: practiceAId,
    });
    const invoiceId = await addInvoice({ caseId, practiceId: practiceAId });

    const r = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId,
        doctorName: "Jane Doe",
        destinationOrganizationId: practiceBId,
        existingCases: "move",
      });

    expect(r.status).toBe(200);
    expect(r.body.data.unassigned).toBe(false);
    expect(r.body.data.destinationPracticeId).toBe(practiceBId);
    expect(r.body.data.casesMoved).toBe(1);
    expect(r.body.data.invoicesMoved).toBe(1);

    const { db, cases, invoices, organizationMemberships } = dbMod as any;
    // Case followed the doctor to the destination practice.
    const [movedCase] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(movedCase.providerOrganizationId).toBe(practiceBId);

    // The case's invoice followed it to the destination practice.
    const [movedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(movedInvoice.providerOrganizationId).toBe(practiceBId);

    // Active membership now exists at the destination practice.
    const destMembership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, practiceBId),
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.deletedAt)
      ),
    });
    expect(destMembership).toBeDefined();
    // Source membership was dropped.
    const srcMembership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, practiceAId),
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.deletedAt)
      ),
    });
    expect(srcMembership).toBeUndefined();
  });

  it("404s for a non-provider user who is not a member of the practice", async () => {
    const { db, users } = dbMod as any;
    const strangerId = rid("ustr");
    await db.insert(users).values({
      id: strangerId,
      username: `str_${strangerId}`,
      password: "x",
      userType: "lab",
    });
    trackUsers.push(strangerId);

    const r = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: strangerId, doctorName: "Some Stranger" });

    expect(r.status).toBe(404);
  });

  it("still removes a virtual (name-only) doctor with no userId", async () => {
    const caseId = await addCase({
      doctorName: "Dr. Virtual Only",
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorName: "Dr. Virtual Only" });

    expect(r.status).toBe(200);
    expect(r.body.data.promotedFromVirtual).toBe(true);
    // Track the promoted provider user for cleanup.
    if (r.body.data.userId) trackUsers.push(r.body.data.userId);
    // Promoted virtual doctors are a provider concept → they DO get a
    // holding-area record.
    const { db, labUnassignedDoctors } = dbMod as any;
    const holding = await db
      .select()
      .from(labUnassignedDoctors)
      .where(eq(labUnassignedDoctors.userId, r.body.data.userId));
    expect(holding.length).toBe(1);
    void caseId;
  });
});
