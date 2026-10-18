/**
 * Duplicate provider-account consolidation (Task #4373).
 *
 * Practices accumulated several provider *user accounts* for the same person —
 * four "Synthetic Provider Alpha" rows, two "Synthetic009 Provider009" rows — each with its own
 * account number. These cover the three behaviours the task calls for:
 *
 *   - a four-way duplicate collapses to one account keeping the OLDEST account
 *     number, with zero references left pointing at a retired account;
 *   - a cluster whose identity signals conflict is left completely untouched
 *     and shows up in the duplicate-suspects panel instead;
 *   - re-running the sweep changes nothing.
 *
 * DB-backed cases are skipped when no DATABASE_URL is configured — same
 * convention as `doctors.test.ts`.
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
import { eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";

import {
  compareAccountSeniority,
  parseAccountNumberSeniority,
  triageAccountCluster,
  type ProviderAccountNode,
} from "./doctor-account-consolidation.js";

vi.mock("./backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("./statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("./case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function node(over: Partial<ProviderAccountNode>): ProviderAccountNode {
  return {
    userId: over.userId ?? rid("u"),
    labOrganizationId: over.labOrganizationId ?? "lab",
    providerOrganizationId: over.providerOrganizationId ?? null,
    displayName: over.displayName ?? "Synthetic Provider Alpha",
    platformAccountNumber: over.platformAccountNumber ?? null,
    email: over.email ?? null,
    phone: over.phone ?? null,
    emailVerifiedAt: over.emailVerifiedAt ?? null,
    phoneVerifiedAt: over.phoneVerifiedAt ?? null,
    doctorName: over.doctorName ?? null,
    firstName: over.firstName ?? null,
    lastName: over.lastName ?? null,
    isActive: over.isActive ?? true,
    createdAt: over.createdAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

describe("Task #4373 account-number seniority", () => {
  it("parses legacy <seq><YY><initials> numbers", () => {
    expect(parseAccountNumberSeniority("1526BK")).toEqual({
      year: 2026,
      seq: 15,
    });
    expect(parseAccountNumberSeniority("1226BG")).toEqual({
      year: 2026,
      seq: 12,
    });
    // Multi-digit sequences keep the final two digits as the year.
    expect(parseAccountNumberSeniority("12325AB")).toEqual({
      year: 2025,
      seq: 123,
    });
  });

  it("parses v2 <L|P>-<year>-<seq>[-<phone>] numbers", () => {
    expect(parseAccountNumberSeniority("P-2026-3")).toEqual({
      year: 2026,
      seq: 3,
    });
    expect(parseAccountNumberSeniority("P-2025-41-5551234567")).toEqual({
      year: 2025,
      seq: 41,
    });
  });

  it("returns null for numbers it cannot parse", () => {
    expect(parseAccountNumberSeniority(null)).toBeNull();
    expect(parseAccountNumberSeniority("")).toBeNull();
    expect(parseAccountNumberSeniority("  ")).toBeNull();
    expect(parseAccountNumberSeniority("not-a-number")).toBeNull();
  });

  it("puts the oldest account number first", () => {
    const sorted = [
      node({ userId: "d", platformAccountNumber: "1926BK" }),
      node({ userId: "b", platformAccountNumber: "1526BK" }),
      node({ userId: "c", platformAccountNumber: "1726BK" }),
      node({ userId: "a", platformAccountNumber: "0925BK" }),
    ].sort(compareAccountSeniority);
    expect(sorted.map((n) => n.platformAccountNumber)).toEqual([
      "0925BK",
      "1526BK",
      "1726BK",
      "1926BK",
    ]);
  });

  it("sorts accounts with no usable number last, then by creation", () => {
    const sorted = [
      node({
        userId: "no-number-new",
        platformAccountNumber: null,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      }),
      node({
        userId: "no-number-old",
        platformAccountNumber: "garbage",
        createdAt: new Date("2026-02-01T00:00:00Z"),
      }),
      node({ userId: "numbered", platformAccountNumber: "9926BK" }),
    ].sort(compareAccountSeniority);
    expect(sorted.map((n) => n.userId)).toEqual([
      "numbered",
      "no-number-old",
      "no-number-new",
    ]);
  });
});

describe("Task #4373 cluster triage", () => {
  it("treats one email + one phone as unambiguous", () => {
    const t = triageAccountCluster([
      node({ email: "b.craig@example.com", phone: "(555) 123-4567" }),
      node({ email: "B.Craig@Example.com ", phone: "+1 555 123 4567" }),
      node({}),
    ]);
    expect(t.classification).toBe("unambiguous");
    expect(t.conflictReason).toBeNull();
  });

  it("routes two different emails to the suspects panel", () => {
    const t = triageAccountCluster([
      node({ email: "b.craig@example.com" }),
      node({ email: "brittney@other.com" }),
    ]);
    expect(t.classification).toBe("conflicting");
    expect(t.conflictReason).toContain("2 different email addresses");
  });

  it("routes two different phones to the suspects panel", () => {
    const t = triageAccountCluster([
      node({ phone: "5551234567" }),
      node({ phone: "5559999999" }),
    ]);
    expect(t.classification).toBe("conflicting");
    expect(t.conflictReason).toContain("2 different phone numbers");
  });
});

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("Task #4373 consolidate duplicate provider accounts (db)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("./auth.js");
  let lib: typeof import("./doctor-account-consolidation.js");

  const labOrgId = rid("lab4373");
  const practiceId = rid("prov4373");
  const adminUserId = rid("adm4373");

  // Four "Synthetic Provider Alpha" accounts; the oldest number must
  // be the one that survives even though it is not the first row created.
  const craig = {
    newest: { id: rid("craig"), number: "" },
    middle: { id: rid("craig"), number: "" },
    oldest: { id: rid("craig"), number: "" },
    noNumber: { id: rid("craig"), number: null as string | null },
  };

  // Two "Synthetic009 Provider009" accounts with different emails — must NOT be
  // consolidated automatically.
  const blake = {
    a: { id: rid("blake"), number: "", email: "blake@one.example" },
    b: { id: rid("blake"), number: "", email: "bgarfinkel@two.example" },
  };

  const createdCaseIds: string[] = [];

  let adminToken = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const token = auth.signAccessToken(userId, sessionId);
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return token;
  }

  async function insertProvider(opts: {
    id: string;
    number: string | null;
    name: string;
    email?: string | null;
    phone?: string | null;
    createdAt?: Date;
  }) {
    const { db, users, organizationMemberships } = dbMod as any;
    await db.insert(users).values({
      id: opts.id,
      username: `u_${opts.id}`,
      password: "x",
      userType: "provider",
      doctorName: opts.name,
      email: opts.email ?? null,
      phone: opts.phone ?? null,
      platformAccountNumber: opts.number,
      isActive: true,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: practiceId,
      userId: opts.id,
      role: "member",
      status: "active",
    });
  }

  async function reserveSyntheticLegacyNumbers(count: number): Promise<string[]> {
    const { db, users, organizations } = dbMod as any;
    const year = String(new Date().getUTCFullYear()).slice(-2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const firstSequence = randomBytes(4).readUInt32BE(0) + attempt * count;
      const candidates = Array.from(
        { length: count },
        (_, index) => `${firstSequence + index}${year}ST`,
      );
      const [existingUsers, existingOrganizations] = await Promise.all([
        db.select({ id: users.id })
          .from(users)
          .where(inArray(users.platformAccountNumber, candidates)),
        db.select({ id: organizations.id })
          .from(organizations)
          .where(inArray(organizations.platformAccountNumber, candidates)),
      ]);
      if (existingUsers.length === 0 && existingOrganizations.length === 0) return candidates;
    }
    throw new Error("Could not reserve unused synthetic legacy account numbers for this test.");
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-4373";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("./auth.js");
    lib = await import("./doctor-account-consolidation.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;
    const [oldestNumber, middleNumber, newestNumber, conflictNumberA, conflictNumberB] =
      await reserveSyntheticLegacyNumbers(5);
    craig.oldest.number = oldestNumber!;
    craig.middle.number = middleNumber!;
    craig.newest.number = newestNumber!;
    blake.a.number = conflictNumberA!;
    blake.b.number = conflictNumberB!;

    await db.insert(users).values({
      id: adminUserId,
      username: `adm_${adminUserId}`,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Consolidation Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Craig Dental",
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: adminUserId,
      role: "admin",
      status: "active",
    });

    // Created newest-first on purpose so survivor selection cannot accidentally
    // pass by picking "the first row".
    await insertProvider({
      id: craig.newest.id,
      number: craig.newest.number,
      name: "Synthetic Provider Alpha",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      phone: "(202) 555-0107",
    });
    await insertProvider({
      id: craig.middle.id,
      number: craig.middle.number,
      name: "Synthetic Provider Alpha",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      email: "synthetic-provider@example.test",
    });
    await insertProvider({
      id: craig.oldest.id,
      number: craig.oldest.number,
      name: "Synthetic Provider Alpha",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });
    await insertProvider({
      id: craig.noNumber.id,
      number: craig.noNumber.number,
      // Case and spacing variant of the same synthetic identity; this makes
      // the case-name move observable without using a real provider name.
      name: " synthetic   provider alpha ",
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });

    await insertProvider({
      id: blake.a.id,
      number: blake.a.number,
      name: "Synthetic009 Provider009",
      email: blake.a.email,
    });
    await insertProvider({
      id: blake.b.id,
      number: blake.b.number,
      name: "Synthetic009 Provider009",
      email: blake.b.email,
    });
  });

  beforeEach(async () => {
    adminToken = await makeSession(adminUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      cases,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      auditLogs,
      labUnassignedDoctors,
      doctorDupDismissals,
    } = dbMod as any;
    const providerIds = [
      craig.newest.id,
      craig.middle.id,
      craig.oldest.id,
      craig.noNumber.id,
      blake.a.id,
      blake.b.id,
    ];
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(doctorDupDismissals)
      .where(eq(doctorDupDismissals.labOrganizationId, labOrgId));
    await db
      .delete(labUnassignedDoctors)
      .where(eq(labUnassignedDoctors.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(
        inArray(organizationMemberships.userId, [...providerIds, adminUserId])
      );
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId]));
    if (createdCaseIds.length) {
      await db.delete(cases).where(inArray(cases.id, createdCaseIds));
    }
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, practiceId]));
    await db
      .delete(users)
      .where(inArray(users.id, [...providerIds, adminUserId]));
  });

  it("detects the caseless account clusters and classifies them", async () => {
    const clusters = await lib.detectProviderAccountClusters([labOrgId]);

    const craigCluster = clusters.find((c) =>
      c.members.some((m) => m.userId === craig.oldest.id)
    );
    expect(craigCluster).toBeTruthy();
    expect(craigCluster!.members).toHaveLength(4);
    expect(craigCluster!.classification).toBe("unambiguous");
    expect(craigCluster!.survivor.userId).toBe(craig.oldest.id);

    const blakeCluster = clusters.find((c) =>
      c.members.some((m) => m.userId === blake.a.id)
    );
    expect(blakeCluster).toBeTruthy();
    expect(blakeCluster!.classification).toBe("conflicting");
    expect(blakeCluster!.conflictReason).toContain("email");
  });

  it("surfaces caseless account duplicates in the suspects panel", async () => {
    const res = await request(appMod.default)
      .get("/api/doctors/duplicate-clusters")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const clusters = res.body.data.clusters as any[];
    const accountClusters = clusters.filter(
      (c) => c.labOrganizationId === labOrgId && c.kind === "account"
    );
    // Neither doctor has a single case, so the case-derived scan finds nothing;
    // both must still be visible.
    expect(accountClusters.length).toBeGreaterThanOrEqual(2);

    const craigRow = accountClusters
      .flatMap((c) => c.doctors as any[])
      .find((d) => d.doctorName === "Synthetic Provider Alpha");
    expect(craigRow).toBeTruthy();
    expect(craigRow.totalCases).toBe(0);
    // Three accounts share the exact name; the fourth is the spelling variant.
    expect(craigRow.accountCount).toBe(3);

    const blakeCluster = accountClusters.find((c) =>
      (c.doctors as any[]).some((d) => d.doctorName === "Synthetic009 Provider009")
    );
    expect(blakeCluster.conflictReason).toContain("email");
    // The badge counts it, which is the point of the task.
    expect(res.body.data.totalGroups).toBeGreaterThanOrEqual(2);
  });

  it("consolidates the four-way duplicate onto the oldest account number", async () => {
    const { db, users, organizationMemberships, auditLogs, cases } =
      dbMod as any;

    // A case filed under the retired account's name variant, so the
    // case-reference move is observable.
    const caseId = rid("c");
    createdCaseIds.push(caseId);
    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: " synthetic   provider alpha ",
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });

    const report = await lib.sweepDuplicateProviderAccounts({
      labIds: [labOrgId],
      dryRun: false,
      actorUserId: adminUserId,
      trigger: "test",
    });

    expect(report.clustersConsolidated).toBe(1);
    expect(report.accountsRetired).toBe(3);
    // The conflicting Blake cluster is reported but untouched.
    expect(report.clustersSkippedConflicting).toBe(1);

    const rows = await db
      .select({
        id: users.id,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        platformAccountNumber: users.platformAccountNumber,
      })
      .from(users)
      .where(
        inArray(users.id, [
          craig.oldest.id,
          craig.middle.id,
          craig.newest.id,
          craig.noNumber.id,
        ])
      );
    const byId = new Map<string, any>(
      (rows as any[]).map((r) => [r.id, r] as const)
    );

    // Survivor keeps the oldest number and stays live.
    expect(byId.get(craig.oldest.id).deletedAt).toBeNull();
    expect(byId.get(craig.oldest.id).isActive).toBe(true);
    expect(byId.get(craig.oldest.id).platformAccountNumber).toBe(craig.oldest.number);

    for (const retired of [craig.middle.id, craig.newest.id, craig.noNumber.id]) {
      expect(byId.get(retired).deletedAt).not.toBeNull();
      expect(byId.get(retired).isActive).toBe(false);
    }
    // Retired numbers stay reserved so they can never be reissued.
    expect(byId.get(craig.middle.id).platformAccountNumber).toBe(craig.middle.number);
    expect(byId.get(craig.newest.id).platformAccountNumber).toBe(craig.newest.number);

    // Nothing points at a retired account any more.
    const orphanMemberships = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        sql`${organizationMemberships.userId} in (${craig.middle.id}, ${craig.newest.id}, ${craig.noNumber.id})
            and ${organizationMemberships.deletedAt} is null`
      );
    expect(orphanMemberships).toHaveLength(0);

    const movedCase = await db
      .select({ doctorName: cases.doctorName })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(movedCase[0].doctorName).toBe("Synthetic Provider Alpha");

    // Verified/unique contact details are folded onto the survivor, never lost.
    const [survivor] = await db
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, craig.oldest.id));
    expect(survivor.email).toBe("synthetic-provider@example.test");
    expect(survivor.phone).toBe("(202) 555-0107");

    // The survivor holds exactly one live membership at the practice.
    const memberships = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        sql`${organizationMemberships.userId} = ${craig.oldest.id}
            and ${organizationMemberships.labId} = ${practiceId}
            and ${organizationMemberships.deletedAt} is null`
      );
    expect(memberships).toHaveLength(1);

    // One reviewable audit record per consolidation.
    const audits = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityId: auditLogs.entityId,
      })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, labOrgId));
    const consolidationAudits = audits.filter(
      (a: any) => a.action === lib.CONSOLIDATION_AUDIT_ACTION
    );
    expect(consolidationAudits).toHaveLength(1);
    expect(consolidationAudits[0].entityId).toBe(craig.oldest.id);

    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("is idempotent — re-running the sweep changes nothing", async () => {
    const report = await lib.sweepDuplicateProviderAccounts({
      labIds: [labOrgId],
      dryRun: false,
      actorUserId: adminUserId,
      trigger: "test-rerun",
    });
    // Only the conflicting Blake cluster is left, and it is still skipped.
    expect(report.clustersConsolidated).toBe(0);
    expect(report.accountsRetired).toBe(0);
    expect(report.clustersSkippedConflicting).toBe(1);

    const { db, auditLogs } = dbMod as any;
    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        sql`${auditLogs.organizationId} = ${labOrgId}
            and ${auditLogs.action} = ${lib.CONSOLIDATION_AUDIT_ACTION}`
      );
    expect(audits).toHaveLength(1);
  });

  it("leaves the conflicting cluster fully intact", async () => {
    const { db, users } = dbMod as any;
    const rows = await db
      .select({
        id: users.id,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        email: users.email,
      })
      .from(users)
      .where(inArray(users.id, [blake.a.id, blake.b.id]));
    expect(rows).toHaveLength(2);
    for (const r of rows as any[]) {
      expect(r.deletedAt).toBeNull();
      expect(r.isActive).toBe(true);
    }
    expect(new Set(rows.map((r: any) => r.email))).toEqual(
      new Set([blake.a.email, blake.b.email])
    );
  });

  it("consolidates a conflicting cluster only when an admin forces it, and can undo it", async () => {
    const { db, users, auditLogs } = dbMod as any;

    // Without force the endpoint refuses and explains why.
    const refused = await request(appMod.default)
      .post("/api/doctors/account-consolidations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        labOrganizationId: labOrgId,
        doctors: [
          { doctorName: "Synthetic009 Provider009", providerOrganizationId: practiceId },
        ],
      });
    expect(refused.status).toBe(409);

    const forced = await request(appMod.default)
      .post("/api/doctors/account-consolidations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        labOrganizationId: labOrgId,
        doctors: [
          { doctorName: "Synthetic009 Provider009", providerOrganizationId: practiceId },
        ],
        force: true,
      });
    expect(forced.status).toBe(200);
    const entry = forced.body.data.consolidations[0];
    // The first synthetic legacy sequence is older than the second.
    expect(entry.survivorUserId).toBe(blake.a.id);
    expect(entry.survivorAccountNumber).toBe(blake.a.number);
    expect(entry.retiredUserIds).toEqual([blake.b.id]);

    const [retired] = await db
      .select({ deletedAt: users.deletedAt, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, blake.b.id));
    expect(retired.deletedAt).not.toBeNull();
    expect(retired.isActive).toBe(false);

    // ...and it is reversible inside the undo window.
    const undone = await request(appMod.default)
      .post(`/api/doctors/account-consolidations/${entry.auditLogId}/undo`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(undone.status).toBe(200);

    const [restored] = await db
      .select({ deletedAt: users.deletedAt, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, blake.b.id));
    expect(restored.deletedAt).toBeNull();
    expect(restored.isActive).toBe(true);

    // Undo is single-shot.
    const again = await request(appMod.default)
      .post(`/api/doctors/account-consolidations/${entry.auditLogId}/undo`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(again.status).toBe(409);

    await db
      .delete(auditLogs)
      .where(
        sql`${auditLogs.organizationId} = ${labOrgId}
            and ${auditLogs.action} in (${lib.CONSOLIDATION_AUDIT_ACTION}, ${lib.CONSOLIDATION_UNDO_AUDIT_ACTION})
            and ${auditLogs.entityId} = ${blake.a.id}`
      );
  });
});
