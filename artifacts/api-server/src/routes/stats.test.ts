/**
 * Integration tests for the read-only Stats analytics routes.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - RBAC: 401 unauthenticated, 403 non-billing member, 200 owner
 *  - /stats/summary — case counts include canonical + legacy, revenue from
 *    invoices only (void + soft-deleted excluded, legacy blob invoices
 *    excluded), previous-period comparison, averageCaseValue is per-CASE
 *    (distinct billed cases, not per-invoice), topCategory follows filters
 *  - /stats/case-categories — category buckets incl. uncategorized legacy,
 *    legacyCount, normalized material breakdown, material filter
 *  - /stats/revenue-series — month bucketing, category/material filters
 *    exclude caseless invoices, groupBy validation
 *  - /stats/weekday-volume — weekday attribution (0 = Monday), material filter
 *  - material filter matches canonical restorations (normalized) and legacy
 *    blob material strings
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-stats"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Stats analytics routes (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const ownerId = rid("u");
  const memberId = rid("m");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  // Fixed, deterministic window (UTC).
  const FROM = "2026-03-01T00:00:00.000Z";
  const TO = "2026-03-31T23:59:59.999Z";

  // Case ids (created in beforeAll).
  const zirCaseId = rid("c_zir");
  const implantCaseId = rid("c_imp");
  const blankCaseId = rid("c_blank");
  const legacyCatId = rid("lc_denture");
  const legacyUncatId = rid("lc_blank");

  const invoiceIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  function baseQs(extra: Record<string, string> = {}) {
    return new URLSearchParams({
      organizationId: labOrgId,
      dateFrom: FROM,
      dateTo: TO,
      timeZone: "UTC",
      ...extra,
    }).toString();
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-stats";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      caseRestorations,
      labCases,
      invoices,
    } = dbMod as any;

    await db.insert(users).values([
      { id: ownerId, username: `statsowner_${ownerId}`, password: "x" },
      { id: memberId, username: `statsmem_${memberId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("StatsTestLab") },
      { id: providerOrgId, type: "provider", name: rid("StatsTestProv") },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: labOrgId,
        userId: memberId,
        role: "user",
        status: "active",
        approvedByUserId: ownerId,
        joinedAt: new Date(),
      },
    ]);

    // Canonical cases inside the window. 2026-03-02 is a Monday.
    const caseDefaults = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Stat",
      patientLastName: "Patient",
      doctorName: "Dr Stats",
      createdByUserId: ownerId,
    };
    await db.insert(cases).values([
      {
        ...caseDefaults,
        id: zirCaseId,
        caseNumber: rid("SC-Z"),
        receivedAt: new Date("2026-03-02T10:00:00.000Z"), // Monday
      },
      {
        ...caseDefaults,
        id: implantCaseId,
        caseNumber: rid("SC-I"),
        receivedAt: new Date("2026-03-03T10:00:00.000Z"), // Tuesday
      },
      {
        ...caseDefaults,
        id: blankCaseId,
        caseNumber: rid("SC-B"),
        receivedAt: new Date("2026-03-02T12:00:00.000Z"), // Monday
      },
    ]);
    await db.insert(caseRestorations).values([
      {
        id: rid("r1"),
        caseId: zirCaseId,
        toothNumber: "8",
        restorationType: "Crown",
        material: "BruxZir", // normalizes to Zirconia
        quantity: 2,
      },
      {
        id: rid("r2"),
        caseId: implantCaseId,
        toothNumber: "19",
        restorationType: "Implant Crown",
        material: "Zirconia", // implants outranks zirconia at case level
        quantity: 1,
      },
      // blankCaseId has no restoration rows → uncategorized
    ]);

    // Legacy lab_cases: one categorizable (denture → removable), one blank.
    // Legacy blob invoiceTotal must NOT count toward revenue.
    await db.insert(labCases).values([
      {
        id: legacyCatId,
        ownerId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          patientName: "Legacy One",
          caseType: "Full Denture",
          material: "Acrylic", // legacy blob material (passes through unchanged)
          createdAt: "2026-03-04T09:00:00.000Z", // Wednesday
          invoiceTotal: "9999.00",
          invoices: [{ id: "blob-inv", total: "9999.00" }],
        }),
      },
      {
        id: legacyUncatId,
        ownerId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          patientName: "Legacy Two",
          createdAt: "2026-03-05T09:00:00.000Z", // Thursday
        }),
      },
    ]);

    // Invoices: three counted (two on the zirconia case — proves the
    // per-CASE average — one on the implant case), one void (excluded),
    // one soft-deleted (excluded), one caseless manual invoice (excluded
    // under a category/material filter), one in the previous period (Feb).
    const invDefaults = {
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      createdByUserId: ownerId,
    };
    const mkInv = (over: Record<string, unknown>) => {
      const id = rid("inv");
      invoiceIds.push(id);
      return { ...invDefaults, id, invoiceNumber: rid("SINV"), ...over };
    };
    await db.insert(invoices).values([
      mkInv({
        caseId: zirCaseId,
        total: "100.00",
        status: "sent",
        issuedAt: new Date("2026-03-10T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId, // second invoice on the SAME case
        total: "60.00",
        status: "sent",
        issuedAt: new Date("2026-03-18T00:00:00.000Z"),
      }),
      mkInv({
        caseId: implantCaseId,
        total: "250.00",
        status: "sent",
        issuedAt: new Date("2026-03-20T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId,
        total: "5000.00",
        status: "void",
        issuedAt: new Date("2026-03-11T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId,
        total: "7000.00",
        status: "sent",
        issuedAt: new Date("2026-03-12T00:00:00.000Z"),
        deletedAt: new Date(),
      }),
      mkInv({
        caseId: null,
        total: "40.00",
        status: "sent",
        issuedAt: new Date("2026-03-15T00:00:00.000Z"),
      }),
      mkInv({
        caseId: zirCaseId,
        total: "80.00",
        status: "sent",
        issuedAt: new Date("2026-02-10T00:00:00.000Z"), // previous period
      }),
    ]);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      invoices,
      caseRestorations,
      cases,
      labCases,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (invoiceIds.length) {
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    }
    await db
      .delete(caseRestorations)
      .where(inArray(caseRestorations.caseId, [zirCaseId, implantCaseId, blankCaseId]));
    await db
      .delete(cases)
      .where(inArray(cases.id, [zirCaseId, implantCaseId, blankCaseId]));
    await db.delete(labCases).where(inArray(labCases.id, [legacyCatId, legacyUncatId]));
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerId, memberId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [ownerId, memberId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(inArray(users.id, [ownerId, memberId]));
  });

  // ── RBAC ──────────────────────────────────────────────────────────────

  it("returns 401 without a token", async () => {
    const r = await request(appMod.default).get(`/api/stats/summary?${baseQs()}`);
    expect(r.status).toBe(401);
  });

  it("returns 403 for a non-billing member on all four endpoints", async () => {
    const { access } = await makeSession(memberId);
    for (const ep of [
      "summary",
      "case-categories",
      "revenue-series",
      "weekday-volume",
    ]) {
      const r = await request(appMod.default)
        .get(`/api/stats/${ep}?${baseQs()}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status, ep).toBe(403);
    }
  });

  // ── /stats/summary ────────────────────────────────────────────────────

  it("summary counts canonical + legacy cases and invoice-only revenue", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;

    // 3 canonical + 2 legacy; legacy blob invoiceTotal (9999) NOT in revenue,
    // void (5000) and soft-deleted (7000) invoices excluded.
    expect(d.totalCases).toBe(5);
    expect(d.legacyCases).toBe(2);
    expect(d.totalRevenue).toBe("450.00"); // 100 + 60 + 250 + 40 (caseless counts unfiltered)
    expect(d.invoiceCount).toBe(4);
    // Per-CASE average: 450 / 3 billed cases (zir counted ONCE despite two
    // invoices, implant, caseless-as-one). Per-invoice would be 112.50.
    expect(d.averageCaseValue).toBe("150.00");
    expect(d.topCategoryCount).toBeGreaterThan(0);

    // Monday (2 cases) is the busiest weekday.
    expect(d.busiestWeekday).toBe(0);
    expect(d.busiestWeekdayLabel).toBe("Monday");

    // Previous period picked up the Feb invoice.
    expect(d.previousPeriod.invoiceCount).toBe(1);
    expect(d.previousPeriod.totalRevenue).toBe("80.00");
    expect(d.previousPeriod.revenueChangePct).not.toBeNull();
  });

  it("summary with category filter narrows cases, revenue, and topCategory", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs({ category: "zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1); // only the zirconia case
    // Only the zirconia case's non-void invoices; caseless invoice excluded.
    expect(d.totalRevenue).toBe("160.00");
    expect(d.invoiceCount).toBe(2);
    // Per-CASE average: 160 / 1 case (per-invoice would be 80.00).
    expect(d.averageCaseValue).toBe("160.00");
    // topCategory follows the active filter.
    expect(d.topCategory).toBe("zirconia");
    expect(d.topCategoryCount).toBe(1);
  });

  it("summary with material filter matches canonical restorations", async () => {
    const { access } = await makeSession(ownerId);
    // BruxZir (zir case) and Zirconia (implant case) both normalize to
    // "Zirconia", so the material filter matches BOTH cases.
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs({ material: "Zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totalCases).toBe(2);
    expect(d.totalRevenue).toBe("410.00"); // 100 + 60 + 250; caseless excluded
    expect(d.invoiceCount).toBe(3);
    expect(d.averageCaseValue).toBe("205.00"); // 410 / 2 distinct cases
  });

  it("summary combines category and material filters", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/summary?${baseQs({ category: "implants", material: "Zirconia" })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1); // only the implant case
    expect(d.totalRevenue).toBe("250.00");
    expect(d.topCategory).toBe("implants");
  });

  it("summary material filter matches legacy blob material strings", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/summary?${baseQs({ material: "Acrylic" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1); // the legacy denture blob
    expect(d.legacyCases).toBe(1);
    expect(d.totalRevenue).toBe("0.00"); // legacy blob invoices never count
    expect(d.invoiceCount).toBe(0);
    expect(d.topCategory).toBe("removable");
  });

  // ── /stats/case-categories ────────────────────────────────────────────

  it("case-categories buckets canonical + legacy with legacyCount and materials", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/case-categories?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(5);

    const byKey = Object.fromEntries(
      d.categories.map((c: any) => [c.category, c]),
    );
    expect(byKey["implants"].count).toBe(1);
    expect(byKey["zirconia"].count).toBe(1);
    expect(byKey["removable"].count).toBe(1); // legacy denture
    expect(byKey["removable"].legacyCount).toBe(1);
    // blank canonical case + blank legacy case
    expect(byKey["uncategorized"].count).toBe(2);
    expect(byKey["uncategorized"].legacyCount).toBe(1);
    expect(byKey["uncategorized"].label).toBe("Uncategorized / Legacy");

    // Materials: BruxZir + Zirconia normalize to one "Zirconia" row,
    // units = 2 + 1.
    const zir = d.materials.find((m: any) => m.material === "Zirconia");
    expect(zir).toBeDefined();
    expect(zir.restorations).toBe(2);
    expect(zir.units).toBe(3);
  });

  it("case-categories honors the material filter on buckets and materials", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/case-categories?${baseQs({ material: "Zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totalCases).toBe(2); // zirconia + implant cases only

    const byKey = Object.fromEntries(
      d.categories.map((c: any) => [c.category, c]),
    );
    expect(byKey["zirconia"].count).toBe(1);
    expect(byKey["implants"].count).toBe(1);
    expect(byKey["removable"]?.count ?? 0).toBe(0);
    expect(byKey["uncategorized"]?.count ?? 0).toBe(0);

    // Material breakdown restricted to the filtered material.
    expect(d.materials).toHaveLength(1);
    expect(d.materials[0].material).toBe("Zirconia");
    expect(d.materials[0].units).toBe(3);
  });

  // ── /stats/revenue-series ─────────────────────────────────────────────

  it("revenue-series buckets by month and matches totals", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/revenue-series?${baseQs({ groupBy: "month" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.groupBy).toBe("month");
    expect(d.series).toHaveLength(1);
    expect(d.series[0].period).toBe("2026-03");
    expect(d.series[0].revenue).toBe("450.00");
    expect(d.series[0].invoiceCount).toBe(4);
    expect(d.totals.revenue).toBe("450.00");
    expect(d.totals.invoiceCount).toBe(4);
  });

  it("revenue-series material filter excludes caseless + non-matching invoices", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/revenue-series?${baseQs({ groupBy: "month", material: "Zirconia" })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totals.revenue).toBe("410.00"); // 100 + 60 + 250
    expect(d.totals.invoiceCount).toBe(3);
  });

  it("revenue-series category filter excludes caseless invoices", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(
        `/api/stats/revenue-series?${baseQs({ groupBy: "day", category: "implants" })}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totals.revenue).toBe("250.00");
    expect(d.totals.invoiceCount).toBe(1);
    expect(d.series).toHaveLength(1);
    expect(d.series[0].period).toBe("2026-03-20");
  });

  it("revenue-series rejects a bad groupBy", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/revenue-series?${baseQs({ groupBy: "decade" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(400);
  });

  // ── /stats/weekday-volume ─────────────────────────────────────────────

  it("weekday-volume attributes cases to Monday-indexed weekdays", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/weekday-volume?${baseQs()}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.weekdays).toHaveLength(7);
    expect(d.totalCases).toBe(5);

    const monday = d.weekdays[0];
    expect(monday.label).toBe("Monday");
    expect(monday.total).toBe(2); // zirconia + blank canonical
    expect(monday.byCategory["zirconia"]).toBe(1);
    expect(monday.byCategory["uncategorized"]).toBe(1);

    expect(d.weekdays[1].total).toBe(1); // Tuesday: implant case
    expect(d.weekdays[2].total).toBe(1); // Wednesday: legacy denture
    expect(d.weekdays[2].byCategory["removable"]).toBe(1);
    expect(d.weekdays[3].total).toBe(1); // Thursday: legacy blank
  });

  it("weekday-volume honors the category filter", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/weekday-volume?${baseQs({ category: "removable" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totalCases).toBe(1);
    expect(d.weekdays[2].total).toBe(1); // Wednesday legacy denture
    expect(d.weekdays[0].total).toBe(0);
  });

  it("weekday-volume honors the material filter", async () => {
    const { access } = await makeSession(ownerId);
    const r = await request(appMod.default)
      .get(`/api/stats/weekday-volume?${baseQs({ material: "Zirconia" })}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.material).toBe("Zirconia");
    expect(d.totalCases).toBe(2);
    expect(d.weekdays[0].total).toBe(1); // Monday: zirconia case
    expect(d.weekdays[1].total).toBe(1); // Tuesday: implant case
    expect(d.weekdays[2].total).toBe(0); // Wednesday legacy denture excluded
  });
});
