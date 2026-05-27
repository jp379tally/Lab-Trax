/**
 * Integration tests for the doctor merge endpoints (Task #382).
 *
 * Skipped when no DATABASE_URL is configured — same convention as
 * `cases-similarity.test.ts` and `cross-lab-doctor.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
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
      caseNumber: "M1",
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
        caseNumber: "MS1",
        doctorName: "Dr. Smith",
        practiceId: practiceAId,
      })
    );
    ids.push(
      await insertCase({
        caseNumber: "MS2",
        doctorName: "Dr Smith",
        practiceId: practiceAId,
      })
    );
    ids.push(
      await insertCase({
        caseNumber: "MS3",
        doctorName: "Dr. SMYTH",
        practiceId: practiceBId,
      })
    );
    const softId = await insertCase({
      caseNumber: "MS-soft",
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
      caseNumber: "SD-live",
      doctorName: "Dr. Jones",
      practiceId: practiceAId,
    });
    const soft = await insertCase({
      caseNumber: "SD-soft",
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
          caseNumber: `U${i}`,
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
  });

  it("respects DOCTOR_MERGE_UNDO_WINDOW_MINUTES override", async () => {
    const id = await insertCase({
      caseNumber: "W1",
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
          caseNumber: `PV${i}`,
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
      caseNumber: "OV1",
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
      caseNumber: "OV2",
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
});
