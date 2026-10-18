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

  async function insertDoctorMemory(opts: {
    doctorKey: string;
    practiceId: string;
    labId?: string;
  }) {
    const { db, rxDoctorPracticeMemory } = dbMod as any;
    const id = rid("dpm");
    await db.insert(rxDoctorPracticeMemory).values({
      id,
      labOrganizationId: opts.labId ?? labOrgId,
      doctorName: opts.doctorKey,
      providerOrganizationId: opts.practiceId,
      createdByUserId: adminUserId,
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
        // Address parts so resolve-name candidates can be asserted to carry a
        // real street/city/state (the intake names them in its "is this
        // <doctor> at <practice> — <address>?" question).
        addressLine1: "100 Example Road",
        city: "Sampletown",
        state: "FL",
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
      rxDoctorPracticeMemory,
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
    await db
      .delete(rxDoctorPracticeMemory)
      .where(
        inArray(rxDoctorPracticeMemory.labOrganizationId, [
          labOrgId,
          otherLabOrgId,
        ])
      );
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
      doctorName: "Dr. Synthetic063",
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
          { doctorName: "Dr. Synthetic063", providerOrganizationId: practiceAId },
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
        targetDoctorName: "Dr. Synthetic063",
        targetProviderOrganizationId: practiceAId, // belongs to labOrgId
        sources: [{ doctorName: "Dr. SYNTHETIC072", providerOrganizationId: null }],
      });
    expect(r.status).toBe(400);
  });

  it("allows capitalization-only canonicalization merge (Dr. Provider054 synthetic054 → Dr. Provider054 Synthetic054)", async () => {
    const c1 = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Provider054 synthetic054",
      practiceId: practiceAId,
    });

    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Provider054 Synthetic054",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Provider054 synthetic054", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.casesMoved).toBe(1);

    const { db, cases } = dbMod as any;
    const [row] = await db.select().from(cases).where(eq(cases.id, c1));
    expect(row.doctorName).toBe("Dr. Provider054 Synthetic054");
    await db.delete(cases).where(eq(cases.id, c1));
  });

  it("still rejects exact same source/target", async () => {
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Same",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Same", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/same \u2014 nothing to merge/i);
  });

  it("dedupes redundant capitalization variants in a multi-source payload (no double-count)", async () => {
    const c1 = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Synthetic063",
      practiceId: practiceAId,
    });

    // Sending two capitalization variants of the SAME name + practice must
    // dedupe to a single source, so only one case moves and only one audit
    // entry is written.
    const r = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Smythe",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Synthetic063", providerOrganizationId: practiceAId },
          { doctorName: "dr. synthetic063", providerOrganizationId: practiceAId },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.data.casesMoved).toBe(1);
    expect(r.body.data.entries).toHaveLength(1);

    const { db, cases } = dbMod as any;
    const [row] = await db.select().from(cases).where(eq(cases.id, c1));
    expect(row.doctorName).toBe("Dr. Smythe");
    await db.delete(cases).where(eq(cases.id, c1));
  });

  it("merges multi-source: cases + pricing overrides, with collapse", async () => {
    const ids: string[] = [];
    ids.push(
      await insertCase({
        caseNumber: rid("CN"),
        doctorName: "Dr. Synthetic063",
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
      doctorName: "Dr. Synthetic063",
      practiceId: practiceAId,
      deletedAt: new Date(),
    });

    // Two source overrides + an existing target override → one source
    // should collapse, the other should be remapped.
    const ovSrc1 = await insertOverride({
      doctorName: "Dr. Synthetic063",
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
          { doctorName: "Dr. Synthetic063", providerOrganizationId: practiceAId },
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
    expect(entryNames).toContain("Dr. Synthetic063");
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
    expect(softRow.doctorName).toBe("Dr. Synthetic063");

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

  it("keeps remembered practice after merge so the next scan auto-selects it", async () => {
    const suffix = randomBytes(8).toString("hex");
    const sourceName = `Dr. Synthetic029 Provider028 ${suffix}`;
    const targetName = `Dr. Synthetic029 Provider029 ${suffix}`;
    const sourceKey = `synthetic029 provider028 ${suffix}`;
    const targetKey = `synthetic029 provider029 ${suffix}`;
    const sourceCaseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: sourceName,
      practiceId: practiceBId,
    });
    const targetCaseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: targetName,
      practiceId: practiceAId,
    });
    await insertDoctorMemory({
      doctorKey: sourceKey,
      practiceId: practiceBId,
    });

    const merge = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: targetName,
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: sourceName, providerOrganizationId: practiceBId },
        ],
      });
    expect(merge.status).toBe(200);
    expect(merge.body.data.doctorMemoriesMoved).toBe(1);
    expect(merge.body.data.doctorMemoriesDropped).toBe(0);

    // This is the lookup the prescription intake performs before showing any
    // practice prompt. A hit means the next scan silently auto-selects it.
    const nextScan = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent(targetName)}`
      )
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(nextScan.status).toBe(200);
    expect(nextScan.body.data).toEqual({
      found: true,
      providerOrganizationId: practiceBId,
    });

    const oldNameLookup = await request(appMod.default)
      .get(
        `/api/rx-doctor-practice-memory?labOrganizationId=${labOrgId}&doctorName=${encodeURIComponent(sourceName)}`
      )
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(oldNameLookup.body.data.found).toBe(false);

    // Running the same merge again is a no-op for memory and must not erase the
    // surviving target mapping.
    const repeated = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: targetName,
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: sourceName, providerOrganizationId: practiceBId },
        ],
      });
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.doctorMemoriesMoved).toBe(0);
    expect(repeated.body.data.doctorMemoriesDropped).toBe(0);

    const { db, cases, rxDoctorPracticeMemory } = dbMod as any;
    const memories = await db
      .select()
      .from(rxDoctorPracticeMemory)
      .where(
        and(
          eq(rxDoctorPracticeMemory.labOrganizationId, labOrgId),
          inArray(rxDoctorPracticeMemory.doctorName, [sourceKey, targetKey])
        )
      );
    expect(memories).toHaveLength(1);
    expect(memories[0].doctorName).toBe(targetKey);
    expect(memories[0].providerOrganizationId).toBe(practiceBId);

    await db
      .delete(rxDoctorPracticeMemory)
      .where(eq(rxDoctorPracticeMemory.id, memories[0].id));
    await db
      .delete(cases)
      .where(inArray(cases.id, [sourceCaseId, targetCaseId]));
  });

  it("keeps the survivor's remembered practice when both doctors disagree", async () => {
    const suffix = randomBytes(8).toString("hex");
    const sourceName = `Dr. Dan Conflict ${suffix}`;
    const targetName = `Dr. Daniel Conflict ${suffix}`;
    const sourceKey = `dan conflict ${suffix}`;
    const targetKey = `daniel conflict ${suffix}`;
    const sourceCaseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: sourceName,
      practiceId: practiceBId,
    });
    const targetCaseId = await insertCase({
      caseNumber: rid("CN"),
      doctorName: targetName,
      practiceId: practiceAId,
    });
    await insertDoctorMemory({
      doctorKey: sourceKey,
      practiceId: practiceBId,
    });
    await insertDoctorMemory({
      doctorKey: targetKey,
      practiceId: practiceAId,
    });

    const merge = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: targetName,
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: sourceName, providerOrganizationId: practiceBId },
        ],
      });
    expect(merge.status).toBe(200);
    expect(merge.body.data.doctorMemoriesMoved).toBe(0);
    expect(merge.body.data.doctorMemoriesDropped).toBe(1);

    const { db, cases, rxDoctorPracticeMemory } = dbMod as any;
    const memories = await db
      .select()
      .from(rxDoctorPracticeMemory)
      .where(
        and(
          eq(rxDoctorPracticeMemory.labOrganizationId, labOrgId),
          inArray(rxDoctorPracticeMemory.doctorName, [sourceKey, targetKey])
        )
      );
    expect(memories).toHaveLength(1);
    expect(memories[0].doctorName).toBe(targetKey);
    expect(memories[0].providerOrganizationId).toBe(practiceAId);

    await db
      .delete(rxDoctorPracticeMemory)
      .where(eq(rxDoctorPracticeMemory.id, memories[0].id));
    await db
      .delete(cases)
      .where(inArray(cases.id, [sourceCaseId, targetCaseId]));
  });

  it("chooses the same remembered practice regardless of multi-source payload order", async () => {
    async function runScenario(reverseSources: boolean) {
      const suffix = randomBytes(8).toString("hex");
      const firstName = `Dr. Amy Stable ${suffix}`;
      const secondName = `Dr. Zoe Stable ${suffix}`;
      const targetName = `Dr. Stable Survivor ${suffix}`;
      const firstKey = `amy stable ${suffix}`;
      const secondKey = `zoe stable ${suffix}`;
      const targetKey = `stable survivor ${suffix}`;
      const caseIds = [
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: firstName,
          practiceId: practiceAId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: secondName,
          practiceId: practiceBId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: targetName,
          practiceId: practiceAId,
        }),
      ];
      await insertDoctorMemory({
        doctorKey: firstKey,
        practiceId: practiceAId,
      });
      await insertDoctorMemory({
        doctorKey: secondKey,
        practiceId: practiceBId,
      });

      const sources = [
        { doctorName: firstName, providerOrganizationId: practiceAId },
        { doctorName: secondName, providerOrganizationId: practiceBId },
      ];
      const merge = await request(appMod.default)
        .post("/api/doctors/merge")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({
          labOrganizationId: labOrgId,
          targetDoctorName: targetName,
          targetProviderOrganizationId: practiceAId,
          sources: reverseSources ? [...sources].reverse() : sources,
        });
      expect(merge.status).toBe(200);
      expect(merge.body.data.doctorMemoriesMoved).toBe(1);
      expect(merge.body.data.doctorMemoriesDropped).toBe(1);

      const { db, cases, rxDoctorPracticeMemory } = dbMod as any;
      const memories = await db
        .select()
        .from(rxDoctorPracticeMemory)
        .where(
          and(
            eq(rxDoctorPracticeMemory.labOrganizationId, labOrgId),
            inArray(rxDoctorPracticeMemory.doctorName, [
              firstKey,
              secondKey,
              targetKey,
            ])
          )
        );
      expect(memories).toHaveLength(1);
      expect(memories[0].doctorName).toBe(targetKey);

      await db
        .delete(rxDoctorPracticeMemory)
        .where(eq(rxDoctorPracticeMemory.id, memories[0].id));
      await db.delete(cases).where(inArray(cases.id, caseIds));
      return memories[0].providerOrganizationId;
    }

    expect(await runScenario(false)).toBe(practiceAId);
    expect(await runScenario(true)).toBe(practiceAId);
  }, 30000);

  it("undo refuses to clobber a same-practice target re-confirmation", async () => {
    const suffix = randomBytes(8).toString("hex");
    const sourceName = `Dr. Undo Source ${suffix}`;
    const targetName = `Dr. Undo Target ${suffix}`;
    const sourceKey = `undo source ${suffix}`;
    const targetKey = `undo target ${suffix}`;
    const caseIds = [
      await insertCase({
        caseNumber: rid("CN"),
        doctorName: sourceName,
        practiceId: practiceAId,
      }),
      await insertCase({
        caseNumber: rid("CN"),
        doctorName: targetName,
        practiceId: practiceAId,
      }),
    ];
    await insertDoctorMemory({
      doctorKey: sourceKey,
      practiceId: practiceAId,
    });

    const merge = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: targetName,
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: sourceName, providerOrganizationId: practiceAId },
        ],
      });
    expect(merge.status).toBe(200);
    const auditLogId = merge.body.data.entries[0].auditLogId;

    // Re-saving the same provider still represents a newer user confirmation;
    // its updatedAt must prevent undo from renaming that target row away.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resave = await request(appMod.default)
      .post("/api/rx-doctor-practice-memory")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        doctorName: targetName,
        providerOrganizationId: practiceAId,
      });
    expect(resave.status).toBe(200);

    const undo = await request(appMod.default)
      .post(`/api/doctors/merge/${auditLogId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(undo.status).toBe(409);

    const { db, cases, rxDoctorPracticeMemory } = dbMod as any;
    const memories = await db
      .select()
      .from(rxDoctorPracticeMemory)
      .where(
        and(
          eq(rxDoctorPracticeMemory.labOrganizationId, labOrgId),
          inArray(rxDoctorPracticeMemory.doctorName, [sourceKey, targetKey])
        )
      );
    expect(memories).toHaveLength(1);
    expect(memories[0].doctorName).toBe(targetKey);
    expect(memories[0].providerOrganizationId).toBe(practiceAId);

    await db
      .delete(rxDoctorPracticeMemory)
      .where(eq(rxDoctorPracticeMemory.id, memories[0].id));
    await db.delete(cases).where(inArray(cases.id, caseIds));
  });

  it("includeSoftDeleted=true also moves soft-deleted cases", async () => {
    const live = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Synthetic047",
      practiceId: practiceAId,
    });
    const soft = await insertCase({
      caseNumber: rid("CN"),
      doctorName: "Dr. Synthetic047",
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
          { doctorName: "Dr. Synthetic047", providerOrganizationId: practiceAId },
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
          doctorName: "Dr. Synthetic057",
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
          { doctorName: "Dr. Synthetic057", providerOrganizationId: practiceAId },
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
    for (const row of rows) expect(row.doctorName).toBe("Dr. Synthetic057");

    // Re-merge to a different name then tamper one row → undo refused.
    const r2 = await request(appMod.default)
      .post("/api/doctors/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        labOrganizationId: labOrgId,
        targetDoctorName: "Dr. Renamed2",
        targetProviderOrganizationId: practiceAId,
        sources: [
          { doctorName: "Dr. Synthetic057", providerOrganizationId: practiceAId },
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

  // -------------------------------------------------------------------------
  // GET /cases/legacy-doctor-directory — the Customer Center "Unassigned /
  // legacy doctor names" bucket source (Task #2694). Surfaces names that live
  // only in legacy lab_cases blobs or providerless canonical cases so they can
  // be merged into a real doctor.
  // -------------------------------------------------------------------------
  describe("GET /cases/legacy-doctor-directory", () => {
    it("lists legacy/providerless names with counts, scoped per lab", async () => {
      const { db, labCases, cases } = dbMod as any;
      // Legacy lab_cases blobs carry no providerOrganizationId, so their doctor
      // names never surface in Customer Center's provider-attached rows.
      const legName = `Dr. Lauren Petral ${rid("x")}`;
      const leg1 = await insertLegacyCase({ caseData: { doctorName: legName } });
      const leg2 = await insertLegacyCase({ caseData: { doctorName: legName } });
      const soloName = `Dr. Orphan Solo ${rid("x")}`;
      const leg3 = await insertLegacyCase({ caseData: { doctorName: soloName } });
      // A provider-attached canonical case must NOT appear in the legacy bucket.
      const attachedName = `Dr. Attached ${rid("x")}`;
      const canonAttached = await insertCase({
        caseNumber: rid("CN"),
        doctorName: attachedName,
        practiceId: practiceAId,
      });

      const r = await request(appMod.default)
        .get("/api/cases/legacy-doctor-directory")
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const entries = r.body.data as Array<{
        doctorName: string;
        labOrganizationId: string;
        totalCases: number;
      }>;

      const leg = entries.find((e) => e.doctorName === legName);
      expect(leg).toBeTruthy();
      expect(leg!.labOrganizationId).toBe(labOrgId);
      expect(leg!.totalCases).toBe(2);

      const solo = entries.find((e) => e.doctorName === soloName);
      expect(solo?.totalCases).toBe(1);

      // Provider-attached canonical names are NOT part of the legacy bucket.
      expect(entries.find((e) => e.doctorName === attachedName)).toBeUndefined();

      // A different lab's admin must not see this lab's providerless names.
      const other = await request(appMod.default)
        .get("/api/cases/legacy-doctor-directory")
        .set("Authorization", `Bearer ${tokens.otherLabAdmin}`);
      expect(other.status).toBe(200);
      expect(
        (other.body.data as Array<{ doctorName: string }>).find(
          (e) => e.doctorName === legName
        )
      ).toBeUndefined();

      await db.delete(labCases).where(inArray(labCases.id, [leg1, leg2, leg3]));
      await db.delete(cases).where(eq(cases.id, canonAttached));
    }, 30000);

    it("drops a legacy name from the directory after it is merged away", async () => {
      const { db, labCases, cases } = dbMod as any;
      const legName = `Dr. Petral ${rid("x")}`;
      const targetName = `Dr. Pettis ${rid("x")}`;
      const leg = await insertLegacyCase({ caseData: { doctorName: legName } });
      const canonTarget = await insertCase({
        caseNumber: rid("CN"),
        doctorName: targetName,
        practiceId: practiceAId,
      });

      const before = await request(appMod.default)
        .get("/api/cases/legacy-doctor-directory")
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(
        (before.body.data as Array<{ doctorName: string }>).some(
          (e) => e.doctorName === legName
        )
      ).toBe(true);

      const m = await request(appMod.default)
        .post("/api/doctors/merge")
        .set("Authorization", `Bearer ${tokens.admin}`)
        .send({
          labOrganizationId: labOrgId,
          targetDoctorName: targetName,
          targetProviderOrganizationId: practiceAId,
          sources: [{ doctorName: legName, providerOrganizationId: null }],
        });
      expect(m.status).toBe(200);
      expect(m.body.data.legacyCasesMoved).toBe(1);

      const after = await request(appMod.default)
        .get("/api/cases/legacy-doctor-directory")
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(
        (after.body.data as Array<{ doctorName: string }>).some(
          (e) => e.doctorName === legName
        )
      ).toBe(false);

      await db.delete(labCases).where(eq(labCases.id, leg));
      await db.delete(cases).where(eq(cases.id, canonTarget));
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // GET /doctors/resolve-name — strict doctor-name resolution for AI intake.
  // -------------------------------------------------------------------------
  describe("GET /doctors/resolve-name", () => {
    type ResolveBody = {
      exactMatch: string | null;
      similarMatches: Array<{
        doctorName: string;
        providerOrganizationId: string | null;
        practiceName: string | null;
        practiceAddressLine1: string | null;
        practiceCity: string | null;
        practiceState: string | null;
        similarity: number;
        totalCases: number;
      }>;
      canAddNew: boolean;
    };

    it("strict-matches ignoring case + surrounding/internal whitespace only", async () => {
      const { db, cases } = dbMod as any;
      const stored = `Dr. Meredith Vaughn ${rid("x")}`;
      const c = await insertCase({
        caseNumber: rid("CN"),
        doctorName: stored,
        practiceId: practiceAId,
      });

      // Scanned name differs only by case + collapsible whitespace → exact.
      const scanned = `  ${stored.toUpperCase().replace(" ", "   ")}  `;
      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          providerOrganizationId: practiceAId,
          doctorName: scanned,
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      // Returns the stored spelling verbatim so the case adopts it.
      expect(body.exactMatch).toBe(stored);
      expect(body.similarMatches).toEqual([]);

      await db.delete(cases).where(eq(cases.id, c));
    }, 30000);

    it("does NOT strict-match on title/name stripping (partial names stay unresolved)", async () => {
      const { db, cases } = dbMod as any;
      const stored = `Dr. Kenisha Cole ${rid("x")}`;
      const c = await insertCase({
        caseNumber: rid("CN"),
        doctorName: stored,
        practiceId: practiceAId,
      });

      // "Dr. Cole <rid>" shares surname but is NOT a strict match — must NOT
      // auto-assign; instead surfaces as a fuzzy suggestion.
      const partial = `Dr. Cole ${stored.split(" ").pop()}`;
      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          providerOrganizationId: practiceAId,
          doctorName: partial,
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      expect(body.exactMatch).toBeNull();
      expect(
        body.similarMatches.some((m) => m.doctorName === stored)
      ).toBe(true);
      expect(body.canAddNew).toBe(true);

      await db.delete(cases).where(eq(cases.id, c));
    }, 30000);

    it("returns no exact + no suggestions for a wholly-unknown doctor", async () => {
      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          providerOrganizationId: practiceAId,
          doctorName: `Dr. Zznobody Qxwv ${rid("x")}`,
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      expect(body.exactMatch).toBeNull();
      expect(body.similarMatches).toEqual([]);
      expect(body.canAddNew).toBe(true);
    }, 30000);

    it("includes lab-scoped legacy blob names in the directory", async () => {
      const { db, labCases } = dbMod as any;
      const legName = `Dr. Legacy Resolve ${rid("x")}`;
      const leg = await insertLegacyCase({ caseData: { doctorName: legName } });

      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          doctorName: legName.toLowerCase(),
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      expect(body.exactMatch).toBe(legName);

      await db.delete(labCases).where(eq(labCases.id, leg));
    }, 30000);

    it("scopes the directory to the lab (other lab's names never resolve)", async () => {
      const { db, cases } = dbMod as any;
      const stored = `Dr. Crosslab Isolation ${rid("x")}`;
      const c = await insertCase({
        caseNumber: rid("CN"),
        doctorName: stored,
        practiceId: practiceAId,
      });

      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: otherLabOrgId,
          doctorName: stored,
        })
        .set("Authorization", `Bearer ${tokens.otherLabAdmin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      expect(body.exactMatch).toBeNull();
      expect(body.similarMatches).toEqual([]);

      await db.delete(cases).where(eq(cases.id, c));
    }, 30000);

    it("rejects a non-member of the requested lab", async () => {
      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          doctorName: "Dr. Anyone",
        })
        .set("Authorization", `Bearer ${tokens.otherLabAdmin}`);
      expect(r.status).toBe(403);
    }, 30000);

    // The AI intake asks "Is this <doctor> at <practice> — <address>?" before
    // it asks anything about the practice, so each candidate has to carry the
    // practice it is REALLY associated with — not an echo of whatever practice
    // the caller happened to ask about.
    it("returns each candidate's own practice with name and address", async () => {
      const { db, cases } = dbMod as any;
      const suffix = rid("x");
      const stored = `Dr. Synthetic029 Provider029 ${suffix}`;
      const c = await insertCase({
        caseNumber: rid("CN"),
        doctorName: stored,
        practiceId: practiceAId,
      });

      // Lab-wide lookup (no providerOrganizationId) — this is how the intake
      // calls it, because the practice is exactly what it does not know yet.
      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          doctorName: `Dr. Synthetic029 Provider028 ${suffix}`,
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      expect(body.exactMatch).toBeNull();
      const match = body.similarMatches.find((m) => m.doctorName === stored);
      expect(match).toBeTruthy();
      expect(match!.providerOrganizationId).toBe(practiceAId);
      expect(match!.practiceName).toBe("Practice A");
      expect(match!.practiceAddressLine1).toBe("100 Example Road");
      expect(match!.practiceCity).toBe("Sampletown");
      expect(match!.practiceState).toBe("FL");

      await db.delete(cases).where(eq(cases.id, c));
    }, 30000);

    it("names the practice a doctor has the most cases under, not the caller's", async () => {
      const { db, cases } = dbMod as any;
      const suffix = rid("x");
      const stored = `Dr. Primary Practice ${suffix}`;
      const ids = [
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: stored,
          practiceId: practiceBId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: stored,
          practiceId: practiceBId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: stored,
          practiceId: practiceAId,
        }),
      ];

      // Ask while scoped to Practice A — the candidate must still report
      // Practice B, where the doctor actually has the most cases.
      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          doctorName: `Dr. Primry Practice ${suffix}`,
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      const match = body.similarMatches.find((m) => m.doctorName === stored);
      expect(match).toBeTruthy();
      expect(match!.providerOrganizationId).toBe(practiceBId);
      expect(match!.practiceName).toBe("Practice B");
      expect(match!.totalCases).toBe(3);

      for (const id of ids) await db.delete(cases).where(eq(cases.id, id));
    }, 30000);

    it("leaves the practice null for legacy blob names, which carry none", async () => {
      const { db, labCases } = dbMod as any;
      const suffix = rid("x");
      const legName = `Dr. Legacy Nopractice ${suffix}`;
      const leg = await insertLegacyCase({ caseData: { doctorName: legName } });

      const r = await request(appMod.default)
        .get("/api/doctors/resolve-name")
        .query({
          labOrganizationId: labOrgId,
          doctorName: `Dr. Legcy Nopractice ${suffix}`,
        })
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(r.status).toBe(200);
      const body = r.body.data as ResolveBody;
      const match = body.similarMatches.find((m) => m.doctorName === legName);
      expect(match).toBeTruthy();
      expect(match!.providerOrganizationId).toBeNull();
      expect(match!.practiceName).toBeNull();

      await db.delete(labCases).where(eq(labCases.id, leg));
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // GET /doctors/duplicate-clusters — the nav duplicate-count badge source.
  // -------------------------------------------------------------------------
  describe("GET /doctors/duplicate-clusters", () => {
    it("clusters near-duplicate doctor names and reports the badge count", async () => {
      const ids = [
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Clusterson",
          practiceId: practiceAId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr Clusterson",
          practiceId: practiceAId,
        }),
        // A distinct name that should not join the cluster.
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Zticklebrook",
          practiceId: practiceBId,
        }),
      ];

      const r = await request(appMod.default)
        .get("/api/doctors/duplicate-clusters")
        .set("Authorization", `Bearer ${tokens.admin}`);

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      const cluster = r.body.data.clusters.find((c: any) =>
        c.doctors.some((d: any) => d.doctorName === "Dr. Clusterson")
      );
      expect(cluster).toBeDefined();
      const names = cluster.doctors.map((d: any) => d.doctorName).sort();
      expect(names).toEqual(["Dr Clusterson", "Dr. Clusterson"]);
      expect(cluster.topScore).toBeGreaterThan(0.7);
      expect(r.body.data.totalGroups).toBeGreaterThanOrEqual(1);

      const { db, cases } = dbMod as any;
      await db.delete(cases).where(inArray(cases.id, ids));
    });

    it("names the provider account each doctor already has", async () => {
      // Task #4397: the merge UI says "keeps account #…", so every cluster node
      // must carry the account the doctor already owns — and when a row has
      // several duplicate accounts, the one consolidation keeps (oldest
      // account number wins, so seq 10 beats seq 90 in the same year).
      const { db, users, organizationMemberships, cases } = dbMod as any;
      const initials = Array.from({ length: 6 }, () =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ".charAt(Math.floor(Math.random() * 26))
      ).join("");
      const olderAccount = `1026${initials}`;
      const newerAccount = `9026${initials}`;
      const keeperUserId = rid("udoc");
      const extraUserId = rid("udoc");
      const membershipIds = [rid("m"), rid("m")];
      const caseIds: string[] = [];

      try {
        await db.insert(users).values([
          {
            id: keeperUserId,
            username: `doc_${keeperUserId}`,
            password: "x",
            userType: "provider",
            doctorName: "Dr. Keepsaccount",
            platformAccountNumber: olderAccount,
          },
          {
            id: extraUserId,
            username: `doc_${extraUserId}`,
            password: "x",
            userType: "provider",
            doctorName: "Dr. Keepsaccount",
            platformAccountNumber: newerAccount,
          },
        ]);
        await db.insert(organizationMemberships).values([
          {
            id: membershipIds[0],
            labId: practiceAId,
            userId: keeperUserId,
            role: "member",
            status: "active",
          },
          {
            id: membershipIds[1],
            labId: practiceAId,
            userId: extraUserId,
            role: "member",
            status: "active",
          },
        ]);
        caseIds.push(
          await insertCase({
            caseNumber: rid("CN"),
            doctorName: "Dr. Keepsaccount",
            practiceId: practiceAId,
          }),
          await insertCase({
            caseNumber: rid("CN"),
            doctorName: "Dr Keepsaccount",
            practiceId: practiceAId,
          })
        );

        const r = await request(appMod.default)
          .get("/api/doctors/duplicate-clusters")
          .set("Authorization", `Bearer ${tokens.admin}`);

        expect(r.status).toBe(200);
        const cluster = r.body.data.clusters.find((c: any) =>
          c.doctors.some((d: any) => d.doctorName === "Dr. Keepsaccount")
        );
        expect(cluster).toBeDefined();

        const keeper = cluster.doctors.find(
          (d: any) => d.doctorName === "Dr. Keepsaccount"
        );
        expect(keeper.accountCount).toBe(2);
        expect(keeper.platformAccountNumber).toBe(olderAccount);

        // The spelling variant is a name on cases only — no account to keep.
        const nameOnly = cluster.doctors.find(
          (d: any) => d.doctorName === "Dr Keepsaccount"
        );
        expect(nameOnly.platformAccountNumber).toBeNull();
        // Merging names retires no account, so the name cluster names no
        // cluster-wide survivor.
        expect(cluster.kind).toBe("name");
        expect(cluster.survivingAccountNumber).toBeNull();
      } finally {
        if (caseIds.length) {
          await db.delete(cases).where(inArray(cases.id, caseIds));
        }
        await db
          .delete(organizationMemberships)
          .where(inArray(organizationMemberships.id, membershipIds));
        await db
          .delete(users)
          .where(inArray(users.id, [keeperUserId, extraUserId]));
      }
    });

    it("names the one account a consolidation keeps for the whole cluster", async () => {
      // Task #4397: an account cluster collapses onto the OLDEST account in the
      // cluster and retires the rest. Per-row numbers are not enough to say
      // which one survives — two near-name rows each owning one account would
      // otherwise both claim to be kept next to the Consolidate action.
      const { db, users, organizationMemberships } = dbMod as any;
      const initials = Array.from({ length: 6 }, () =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ".charAt(Math.floor(Math.random() * 26))
      ).join("");
      const olderAccount = `1026${initials}`;
      const newerAccount = `9026${initials}`;
      const olderUserId = rid("udoc");
      const newerUserId = rid("udoc");
      const membershipIds = [rid("m"), rid("m")];

      try {
        await db.insert(users).values([
          {
            id: newerUserId,
            username: `doc_${newerUserId}`,
            password: "x",
            userType: "provider",
            doctorName: "Dr. Brittney Craigson",
            platformAccountNumber: newerAccount,
          },
          {
            id: olderUserId,
            username: `doc_${olderUserId}`,
            password: "x",
            userType: "provider",
            doctorName: "Brittney Craigson",
            platformAccountNumber: olderAccount,
          },
        ]);
        await db.insert(organizationMemberships).values([
          {
            id: membershipIds[0],
            labId: practiceAId,
            userId: newerUserId,
            role: "member",
            status: "active",
          },
          {
            id: membershipIds[1],
            labId: practiceAId,
            userId: olderUserId,
            role: "member",
            status: "active",
          },
        ]);

        const r = await request(appMod.default)
          .get("/api/doctors/duplicate-clusters")
          .set("Authorization", `Bearer ${tokens.admin}`);

        expect(r.status).toBe(200);
        const cluster = r.body.data.clusters.find(
          (c: any) =>
            c.kind === "account" &&
            c.doctors.some(
              (d: any) => d.doctorName === "Dr. Brittney Craigson"
            )
        );
        expect(cluster).toBeDefined();

        // The survivor is the oldest number in the cluster — which lives on the
        // OTHER row, not on every row.
        expect(cluster.survivingAccountNumber).toBe(olderAccount);
        const byName = new Map<string, any>(
          cluster.doctors.map((d: any) => [d.doctorName, d])
        );
        expect(byName.get("Dr. Brittney Craigson").platformAccountNumber).toBe(
          newerAccount
        );
        expect(byName.get("Brittney Craigson").platformAccountNumber).toBe(
          olderAccount
        );
      } finally {
        await db
          .delete(organizationMemberships)
          .where(inArray(organizationMemberships.id, membershipIds));
        await db
          .delete(users)
          .where(inArray(users.id, [olderUserId, newerUserId]));
      }
    });

    it("excludes soft-deleted cases from clustering", async () => {
      const live = await insertCase({
        caseNumber: rid("CN"),
        doctorName: "Dr. Softclust",
        practiceId: practiceAId,
      });
      const soft = await insertCase({
        caseNumber: rid("CN"),
        doctorName: "Dr Softclust",
        practiceId: practiceAId,
        deletedAt: new Date(),
      });

      const r = await request(appMod.default)
        .get("/api/doctors/duplicate-clusters")
        .set("Authorization", `Bearer ${tokens.admin}`);

      expect(r.status).toBe(200);
      const cluster = r.body.data.clusters.find((c: any) =>
        c.doctors.some((d: any) => d.doctorName === "Dr. Softclust")
      );
      // Only the live row remains → no second member → no cluster.
      expect(cluster).toBeUndefined();

      const { db, cases } = dbMod as any;
      await db.delete(cases).where(inArray(cases.id, [live, soft]));
    });

    it("returns an empty result for a non-admin member", async () => {
      const ids = [
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Memberclust",
          practiceId: practiceAId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr Memberclust",
          practiceId: practiceAId,
        }),
      ];

      const r = await request(appMod.default)
        .get("/api/doctors/duplicate-clusters")
        .set("Authorization", `Bearer ${tokens.member}`);

      expect(r.status).toBe(200);
      expect(r.body.data.totalGroups).toBe(0);
      expect(r.body.data.clusters).toEqual([]);

      const { db, cases } = dbMod as any;
      await db.delete(cases).where(inArray(cases.id, ids));
    });

    it("serves a short-TTL cached badge and recomputes after the TTL", async () => {
      // The endpoint disables its cache under VITEST so the other tests in this
      // file stay deterministic; opt this one test back in with a tiny TTL so we
      // can observe a cache hit (stale data still served) and TTL expiry
      // (recompute from fresh data) without hanging the suite.
      process.env["DOCTOR_DUP_CLUSTER_CACHE_FORCE"] = "1";
      process.env["DOCTOR_DUP_CLUSTER_CACHE_TTL_MS"] = "300";
      const { db, cases } = dbMod as any;
      const ids = [
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Cacheford",
          practiceId: practiceAId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr Cacheford",
          practiceId: practiceAId,
        }),
      ];

      try {
        const findCluster = (body: any) =>
          body.data.clusters.find((c: any) =>
            c.doctors.some((d: any) => d.doctorName === "Dr. Cacheford")
          );

        // First poll computes + caches the cluster.
        const r1 = await request(appMod.default)
          .get("/api/doctors/duplicate-clusters")
          .set("Authorization", `Bearer ${tokens.admin}`);
        expect(r1.status).toBe(200);
        expect(findCluster(r1.body)).toBeDefined();

        // Remove the underlying rows directly (bypassing the route's
        // invalidation). A second poll within the TTL must still serve the
        // cached cluster — proving the poll didn't recompute from scratch.
        await db.delete(cases).where(inArray(cases.id, ids));
        const r2 = await request(appMod.default)
          .get("/api/doctors/duplicate-clusters")
          .set("Authorization", `Bearer ${tokens.admin}`);
        expect(r2.status).toBe(200);
        expect(findCluster(r2.body)).toBeDefined();

        // After the TTL lapses the next poll recomputes from the now-empty data.
        await new Promise((resolve) => setTimeout(resolve, 350));
        const r3 = await request(appMod.default)
          .get("/api/doctors/duplicate-clusters")
          .set("Authorization", `Bearer ${tokens.admin}`);
        expect(r3.status).toBe(200);
        expect(findCluster(r3.body)).toBeUndefined();
      } finally {
        delete process.env["DOCTOR_DUP_CLUSTER_CACHE_FORCE"];
        delete process.env["DOCTOR_DUP_CLUSTER_CACHE_TTL_MS"];
        await db.delete(cases).where(inArray(cases.id, ids));
      }
    });

    it("does not leak clusters from a lab the caller does not administer", async () => {
      // Cases live in labOrgId (admin's lab); the other-lab admin must not see them.
      const ids = [
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr. Crossclust",
          practiceId: practiceAId,
        }),
        await insertCase({
          caseNumber: rid("CN"),
          doctorName: "Dr Crossclust",
          practiceId: practiceAId,
        }),
      ];

      const r = await request(appMod.default)
        .get("/api/doctors/duplicate-clusters")
        .set("Authorization", `Bearer ${tokens.otherLabAdmin}`);

      expect(r.status).toBe(200);
      const leaked = r.body.data.clusters.find((c: any) =>
        c.doctors.some((d: any) => d.doctorName === "Dr. Crossclust")
      );
      expect(leaked).toBeUndefined();

      const { db, cases } = dbMod as any;
      await db.delete(cases).where(inArray(cases.id, ids));
    });
  });
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
    // Name-only holding entries carry no user id, so clear this lab's by lab.
    await db
      .delete(labUnassignedDoctors)
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, labOrgId),
          isNull(labUnassignedDoctors.userId)
        )
      );
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

  it("removes a virtual (name-only) doctor without creating an account", async () => {
    const caseId = await addCase({
      doctorName: "Dr. Virtual Only",
      practiceId: practiceAId,
    });

    const { db, labUnassignedDoctors, users } = dbMod as any;
    const before = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userType, "provider"));

    const r = await request(appMod.default)
      .post(`/api/organizations/${practiceAId}/doctors/remove`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ doctorName: "Dr. Virtual Only" });

    expect(r.status).toBe(200);
    // Removing a doctor must never create an account or an account number.
    expect(r.body.data.promotedFromVirtual).toBe(false);
    expect(r.body.data.userId).toBeNull();
    expect(r.body.data.platformAccountNumber).toBeNull();

    const after = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userType, "provider"));
    expect(after.length).toBe(before.length);

    // The removal is recorded by name in the lab's holding area instead.
    const holding = await db
      .select()
      .from(labUnassignedDoctors)
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, labOrgId),
          isNull(labUnassignedDoctors.userId)
        )
      );
    expect(holding.length).toBe(1);
    expect(holding[0].doctorName).toBe("Dr. Virtual Only");
    void caseId;
  });
});
