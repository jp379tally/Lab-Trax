/**
 * Read-only lab-scoped analytics endpoints for the desktop Stats dashboard
 * (Task: Admin stats & analytics).
 *
 * Data-source rules (keep these consistent — they are asserted by
 * stats.test.ts):
 *
 *  - Case counts include BOTH canonical `cases` rows (scoped by
 *    `cases.receivedAt`, soft-deletes excluded via `notDeleted`) and legacy
 *    mobile `lab_cases` rows (scoped by the blob's `createdAt`, falling
 *    back to the row's `updatedAt`; soft-deletes excluded via
 *    `deletedAt IS NULL`). Legacy cases that can't be categorized from the
 *    blob land in the explicit "uncategorized" bucket — never dropped.
 *
 *  - Revenue comes from the `invoices` table ONLY (`invoices.total`),
 *    excluding voided (`status = 'void'`) and soft-deleted rows, keyed on
 *    `COALESCE(issuedAt, createdAt)` — the same convention as
 *    /invoices/reports/sales-series. Draft invoices are included (same as
 *    sales-series) and frozen invoices are included (they preserve the
 *    financial record of deleted cases). Restoration `unitPrice` estimates
 *    are NEVER mixed into revenue.
 *
 *  - Legacy mobile invoices synthesized from `lab_cases` blobs (blob
 *    `invoiceTotal` with no `invoices` row) are EXCLUDED from revenue:
 *    blob totals are unaudited client-written values and cannot be
 *    distinguished from stale copies of canonical invoices (a blob
 *    `invoiceId` may point at a real `invoices` row that is already
 *    counted). Legacy cases still count toward case counts.
 *
 *  - Category/material filtering of revenue works via the invoice's
 *    `caseId` → that case's category/materials. Invoices with no linked
 *    case (manual invoices) are only included when NO category or
 *    material filter is applied.
 *
 *  - The `material` filter matches the normalized material display name
 *    (same normalization as the case-categories `materials` breakdown —
 *    e.g. "BruxZir" and "Zr" both match "Zirconia"; blank materials match
 *    "Unspecified"). Canonical cases match via their restoration rows;
 *    legacy cases match via the blob's free-form `material` string when
 *    present (legacy blobs without a material never match a material
 *    filter).
 *
 *  - Timezone: all day/week/month/year bucketing and weekday attribution
 *    honor the optional `timeZone` IANA query param (default UTC), using
 *    the same Intl en-CA formatting convention as
 *    /invoices/reports/sales-series. Weeks anchor to Monday.
 */
import { Router } from "express";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { caseRestorations, cases, invoices, labCases } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { BILLING_ROLES, requireAnyRole } from "../lib/rbac";
import { notDeleted } from "../lib/soft-delete";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import {
  CASE_CATEGORY_KEYS,
  CASE_CATEGORY_LABELS,
  classifyCase,
  classifyLegacyCase,
  type CaseCategory,
} from "../lib/case-category";
import { normalizeMaterialName } from "../lib/material-mapping";

const router = Router();
router.use(requireAuth);

const categoryEnum = z.enum(CASE_CATEGORY_KEYS);

const baseQuerySchema = z.object({
  organizationId: z.string().min(1),
  dateFrom: z.string().min(1),
  dateTo: z.string().min(1),
  timeZone: z.string().min(1).max(64).optional(),
  category: categoryEnum.optional(),
  material: z.string().min(1).max(120).optional(),
});

/**
 * Normalized material display name — the SAME key used for the
 * case-categories `materials` breakdown, so the desktop dropdown values
 * round-trip exactly. Blank / unrecognized-blank materials become
 * "Unspecified".
 */
function materialKey(raw: string | null | undefined): string {
  return (normalizeMaterialName(raw ?? "") ?? "").trim() || "Unspecified";
}

function parseWindow(dateFrom: string, dateTo: string): { from: Date; to: Date } {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, "Invalid dateFrom/dateTo.");
  }
  if (from.getTime() > to.getTime()) {
    throw new HttpError(400, "dateFrom must be before dateTo.");
  }
  return { from, to };
}

function tzFormatter(tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new HttpError(400, `Invalid timeZone: ${tz}`);
  }
}

/** Local calendar date (Y/M/D) of an instant in the requested timezone. */
function localYmd(fmt: Intl.DateTimeFormat, d: Date): {
  yr: number;
  mo: number;
  day: number;
} {
  const parts = fmt.format(d).split("-"); // en-CA → "YYYY-MM-DD"
  return { yr: Number(parts[0]), mo: Number(parts[1]) - 1, day: Number(parts[2]) };
}

type GroupBy = "day" | "week" | "month" | "year";

function bucketKey(
  fmt: Intl.DateTimeFormat,
  groupBy: GroupBy,
  d: Date,
): { key: string; start: Date } {
  const { yr, mo, day } = localYmd(fmt, d);
  if (groupBy === "day") {
    const start = new Date(Date.UTC(yr, mo, day));
    return { key: start.toISOString().slice(0, 10), start };
  }
  if (groupBy === "month") {
    const start = new Date(Date.UTC(yr, mo, 1));
    return { key: `${yr}-${String(mo + 1).padStart(2, "0")}`, start };
  }
  if (groupBy === "year") {
    const start = new Date(Date.UTC(yr, 0, 1));
    return { key: String(yr), start };
  }
  // Week — anchor to local Monday (same convention as sales-series).
  const local = new Date(Date.UTC(yr, mo, day));
  const dow = (local.getUTCDay() + 6) % 7; // Mon = 0
  const start = new Date(Date.UTC(yr, mo, day - dow));
  return { key: start.toISOString().slice(0, 10), start };
}

/** Weekday index in the requested timezone. 0 = Monday … 6 = Sunday. */
function localWeekday(fmt: Intl.DateTimeFormat, d: Date): number {
  const { yr, mo, day } = localYmd(fmt, d);
  return (new Date(Date.UTC(yr, mo, day)).getUTCDay() + 6) % 7;
}

const WEEKDAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

interface CategorizedCase {
  id: string;
  receivedAt: Date;
  category: CaseCategory;
  source: "canonical" | "legacy";
  /** Normalized material names present on the case (see materialKey). */
  materials: string[];
}

/** Apply the optional category + material filters to a case list. */
function applyCaseFilters(
  list: CategorizedCase[],
  category: CaseCategory | undefined,
  material: string | undefined,
): CategorizedCase[] {
  let out = list;
  if (category) out = out.filter((c) => c.category === category);
  if (material) out = out.filter((c) => c.materials.includes(material));
  return out;
}

/**
 * Load every case (canonical + legacy) for one lab in [from, to] with its
 * analytics category. Aggregation stays server-side; only aggregates leave
 * this module.
 */
async function loadCategorizedCases(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<CategorizedCase[]> {
  const canonical = (await db
    .select({ id: cases.id, receivedAt: cases.receivedAt })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, organizationId),
        notDeleted(cases),
        gte(cases.receivedAt, from),
        lte(cases.receivedAt, to),
      ),
    )) as Array<{ id: string; receivedAt: Date | string | null }>;

  const ids = canonical.map((c) => c.id);
  const restoRows = ids.length
    ? ((await db
        .select({
          caseId: caseRestorations.caseId,
          restorationType: caseRestorations.restorationType,
          material: caseRestorations.material,
        })
        .from(caseRestorations)
        .where(inArray(caseRestorations.caseId, ids))) as Array<{
        caseId: string;
        restorationType: string | null;
        material: string | null;
      }>)
    : [];
  const byCase = new Map<
    string,
    Array<{ restorationType: string | null; material: string | null }>
  >();
  for (const r of restoRows) {
    const arr = byCase.get(r.caseId) ?? [];
    arr.push({ restorationType: r.restorationType, material: r.material });
    byCase.set(r.caseId, arr);
  }

  const out: CategorizedCase[] = [];
  for (const c of canonical) {
    const receivedAt = c.receivedAt ? new Date(c.receivedAt) : null;
    if (!receivedAt || Number.isNaN(receivedAt.getTime())) continue;
    const restos = byCase.get(c.id) ?? [];
    out.push({
      id: c.id,
      receivedAt,
      category: classifyCase(restos),
      source: "canonical",
      materials: Array.from(new Set(restos.map((r) => materialKey(r.material)))),
    });
  }

  // Legacy mobile cases: the blob's createdAt is the closest analogue of
  // receivedAt; fall back to the row's updatedAt when the blob lacks one.
  const legacyRows = (await db
    .select({
      id: labCases.id,
      caseData: labCases.caseData,
      updatedAt: labCases.updatedAt,
    })
    .from(labCases)
    .where(
      and(eq(labCases.organizationId, organizationId), isNull(labCases.deletedAt)),
    )) as Array<{ id: string; caseData: unknown; updatedAt: Date | null }>;

  for (const row of legacyRows) {
    let parsed: unknown = null;
    try {
      parsed =
        typeof row.caseData === "string" ? JSON.parse(row.caseData) : row.caseData;
    } catch {
      parsed = null;
    }
    const blob =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const rawCreated = blob?.["createdAt"];
    let receivedAt: Date | null = null;
    if (typeof rawCreated === "string" || typeof rawCreated === "number") {
      const d = new Date(rawCreated);
      if (!Number.isNaN(d.getTime())) receivedAt = d;
    }
    if (!receivedAt && row.updatedAt) receivedAt = new Date(row.updatedAt);
    if (!receivedAt || Number.isNaN(receivedAt.getTime())) continue;
    if (receivedAt.getTime() < from.getTime() || receivedAt.getTime() > to.getTime()) {
      continue;
    }
    // Legacy material: the blob's free-form `material` string when present.
    // Blobs without a material get NO material key (they never match a
    // material filter) — unlike a blank canonical restoration row, there
    // is no restoration here to call "Unspecified".
    const rawMaterial = blob?.["material"];
    const materials =
      typeof rawMaterial === "string" && rawMaterial.trim()
        ? [materialKey(rawMaterial)]
        : [];
    out.push({
      id: row.id,
      receivedAt,
      category: classifyLegacyCase(parsed),
      source: "legacy",
      materials,
    });
  }

  return out;
}

interface RevenueInvoice {
  caseId: string | null;
  issued: Date;
  total: number;
}

/**
 * Load non-void, non-deleted invoices for one lab keyed on
 * COALESCE(issuedAt, createdAt) within [from, to].
 */
async function loadRevenueInvoices(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<RevenueInvoice[]> {
  const issued = sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`;
  const rows = (await db
    .select({ caseId: invoices.caseId, issued, total: invoices.total })
    .from(invoices)
    .where(
      and(
        eq(invoices.labOrganizationId, organizationId),
        isNull(invoices.deletedAt),
        sql`${invoices.status} <> 'void'`,
        gte(issued, from),
        lte(issued, to),
      ),
    )) as Array<{ caseId: string | null; issued: string | Date; total: string }>;
  const out: RevenueInvoice[] = [];
  for (const r of rows) {
    const d = new Date(r.issued as string);
    if (Number.isNaN(d.getTime())) continue;
    out.push({ caseId: r.caseId, issued: d, total: Number(r.total || 0) });
  }
  return out;
}

/**
 * Map caseId → {category, materials} for the given case ids (used to
 * category/material-filter revenue; independent of the case's receivedAt
 * window because an invoice can be issued outside the window its case was
 * received in).
 */
async function describeCaseIds(
  caseIds: string[],
): Promise<Map<string, { category: CaseCategory; materials: string[] }>> {
  const map = new Map<string, { category: CaseCategory; materials: string[] }>();
  if (caseIds.length === 0) return map;
  const restoRows = (await db
    .select({
      caseId: caseRestorations.caseId,
      restorationType: caseRestorations.restorationType,
      material: caseRestorations.material,
    })
    .from(caseRestorations)
    .where(inArray(caseRestorations.caseId, caseIds))) as Array<{
    caseId: string;
    restorationType: string | null;
    material: string | null;
  }>;
  const byCase = new Map<
    string,
    Array<{ restorationType: string | null; material: string | null }>
  >();
  for (const r of restoRows) {
    const arr = byCase.get(r.caseId) ?? [];
    arr.push({ restorationType: r.restorationType, material: r.material });
    byCase.set(r.caseId, arr);
  }
  for (const id of caseIds) {
    const restos = byCase.get(id) ?? [];
    map.set(id, {
      category: classifyCase(restos),
      materials: Array.from(new Set(restos.map((r) => materialKey(r.material)))),
    });
  }
  return map;
}

async function filterInvoices(
  rows: RevenueInvoice[],
  category: CaseCategory | undefined,
  material: string | undefined,
): Promise<RevenueInvoice[]> {
  if (!category && !material) return rows;
  const ids = Array.from(
    new Set(rows.map((r) => r.caseId).filter((v): v is string => !!v)),
  );
  const descriptions = await describeCaseIds(ids);
  // With a category or material filter, caseless (manual) invoices are
  // excluded — we cannot attribute them to any category/material.
  return rows.filter((r) => {
    if (r.caseId === null) return false;
    const d = descriptions.get(r.caseId);
    if (!d) return false;
    if (category && d.category !== category) return false;
    if (material && !d.materials.includes(material)) return false;
    return true;
  });
}

// ───────────────────────── GET /stats/summary ─────────────────────────
router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const q = baseQuerySchema.parse(req.query);
    await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const { from, to } = parseWindow(q.dateFrom, q.dateTo);
    const tz = q.timeZone ?? "UTC";
    const fmt = tzFormatter(tz);

    // Previous period: the window of equal length immediately before.
    const spanMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - spanMs);

    const [curCasesAll, prevCasesAll, curInvoicesAll, prevInvoicesAll] =
      await Promise.all([
        loadCategorizedCases(q.organizationId, from, to),
        loadCategorizedCases(q.organizationId, prevFrom, prevTo),
        loadRevenueInvoices(q.organizationId, from, to),
        loadRevenueInvoices(q.organizationId, prevFrom, prevTo),
      ]);

    const curCases = applyCaseFilters(curCasesAll, q.category, q.material);
    const prevCases = applyCaseFilters(prevCasesAll, q.category, q.material);
    const curInvoices = await filterInvoices(curInvoicesAll, q.category, q.material);
    const prevInvoices = await filterInvoices(
      prevInvoicesAll,
      q.category,
      q.material,
    );

    const curRevenue = curInvoices.reduce((a, r) => a + r.total, 0);
    const prevRevenue = prevInvoices.reduce((a, r) => a + r.total, 0);

    // Most common category of the FILTERED current window, so every card
    // follows the active filters. (Under a category filter this is
    // trivially that category — expected and consistent.)
    const catCounts = new Map<CaseCategory, number>();
    for (const c of curCases) {
      catCounts.set(c.category, (catCounts.get(c.category) ?? 0) + 1);
    }
    let topCategory: CaseCategory | null = null;
    let topCategoryCount = 0;
    for (const key of CASE_CATEGORY_KEYS) {
      const n = catCounts.get(key) ?? 0;
      if (n > topCategoryCount) {
        topCategory = key;
        topCategoryCount = n;
      }
    }

    // Busiest weekday by case receipt (current filtered set).
    const weekdayCounts = new Array<number>(7).fill(0);
    for (const c of curCases) {
      weekdayCounts[localWeekday(fmt, c.receivedAt)] += 1;
    }
    let busiestWeekday: number | null = null;
    for (let i = 0; i < 7; i++) {
      if (
        weekdayCounts[i]! > 0 &&
        (busiestWeekday === null || weekdayCounts[i]! > weekdayCounts[busiestWeekday]!)
      ) {
        busiestWeekday = i;
      }
    }

    function pctChange(cur: number, prev: number): number | null {
      if (prev === 0) return null;
      return Number((((cur - prev) / prev) * 100).toFixed(1));
    }

    // Average case value = revenue / distinct cases billed in the window
    // (each caseless manual invoice counts as its own "case" — it is
    // revenue not attributable to any tracked case). This is per-CASE, not
    // per-invoice: a case with two invoices in the window counts once.
    function invoicedCaseCount(rows: RevenueInvoice[]): number {
      const distinct = new Set<string>();
      let caseless = 0;
      for (const r of rows) {
        if (r.caseId === null) caseless += 1;
        else distinct.add(r.caseId);
      }
      return distinct.size + caseless;
    }
    const curBilledCases = invoicedCaseCount(curInvoices);
    const prevBilledCases = invoicedCaseCount(prevInvoices);

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: tz,
      category: q.category ?? null,
      material: q.material ?? null,
      totalCases: curCases.length,
      legacyCases: curCases.filter((c) => c.source === "legacy").length,
      totalRevenue: curRevenue.toFixed(2),
      invoiceCount: curInvoices.length,
      averageCaseValue: curBilledCases
        ? (curRevenue / curBilledCases).toFixed(2)
        : "0.00",
      topCategory,
      topCategoryLabel: topCategory ? CASE_CATEGORY_LABELS[topCategory] : null,
      topCategoryCount,
      busiestWeekday,
      busiestWeekdayLabel:
        busiestWeekday === null ? null : WEEKDAY_LABELS[busiestWeekday],
      previousPeriod: {
        from: prevFrom.toISOString(),
        to: prevTo.toISOString(),
        totalCases: prevCases.length,
        totalRevenue: prevRevenue.toFixed(2),
        invoiceCount: prevInvoices.length,
        averageCaseValue: prevBilledCases
          ? (prevRevenue / prevBilledCases).toFixed(2)
          : "0.00",
        casesChangePct: pctChange(curCases.length, prevCases.length),
        revenueChangePct: pctChange(curRevenue, prevRevenue),
      },
    });
  }),
);

// ─────────────────── GET /stats/case-categories ───────────────────
router.get(
  "/case-categories",
  asyncHandler(async (req, res) => {
    const q = baseQuerySchema.parse(req.query);
    await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const { from, to } = parseWindow(q.dateFrom, q.dateTo);

    const unfiltered = await loadCategorizedCases(q.organizationId, from, to);
    const all = applyCaseFilters(unfiltered, q.category, q.material);
    const counts = new Map<CaseCategory, { count: number; legacy: number }>();
    for (const c of all) {
      const cur = counts.get(c.category) ?? { count: 0, legacy: 0 };
      cur.count += 1;
      if (c.source === "legacy") cur.legacy += 1;
      counts.set(c.category, cur);
    }
    const categories = CASE_CATEGORY_KEYS.map((key) => ({
      category: key,
      label: CASE_CATEGORY_LABELS[key],
      count: counts.get(key)?.count ?? 0,
      legacyCount: counts.get(key)?.legacy ?? 0,
    }));

    // Material breakdown (canonical restorations only — legacy blobs have
    // no per-restoration rows). Normalized display names so BruxZir / Zr /
    // PFZ etc. all roll up under "Zirconia".
    const canonicalIds = all
      .filter((c) => c.source === "canonical")
      .map((c) => c.id);
    const materialCounts = new Map<string, { units: number; restorations: number }>();
    if (canonicalIds.length) {
      const rows = (await db
        .select({
          material: caseRestorations.material,
          quantity: caseRestorations.quantity,
        })
        .from(caseRestorations)
        .where(inArray(caseRestorations.caseId, canonicalIds))) as Array<{
        material: string | null;
        quantity: number | null;
      }>;
      for (const r of rows) {
        const name = materialKey(r.material);
        // Under a material filter only the matching material's rows count,
        // so the breakdown follows the active filters like every other card.
        if (q.material && name !== q.material) continue;
        const cur = materialCounts.get(name) ?? { units: 0, restorations: 0 };
        cur.units += Number(r.quantity || 0) || 1;
        cur.restorations += 1;
        materialCounts.set(name, cur);
      }
    }
    const materials = Array.from(materialCounts.entries())
      .map(([material, v]) => ({
        material,
        restorations: v.restorations,
        units: v.units,
      }))
      .sort((a, b) => b.units - a.units);

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      category: q.category ?? null,
      material: q.material ?? null,
      totalCases: all.length,
      categories,
      materials,
    });
  }),
);

// ─────────────────── GET /stats/revenue-series ───────────────────
router.get(
  "/revenue-series",
  asyncHandler(async (req, res) => {
    const q = baseQuerySchema
      .extend({ groupBy: z.enum(["day", "week", "month", "year"]).default("month") })
      .parse(req.query);
    await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const { from, to } = parseWindow(q.dateFrom, q.dateTo);
    const tz = q.timeZone ?? "UTC";
    const fmt = tzFormatter(tz);

    const rows = await filterInvoices(
      await loadRevenueInvoices(q.organizationId, from, to),
      q.category,
      q.material,
    );

    const buckets = new Map<string, { periodStart: string; revenue: number; count: number }>();
    let totalRevenue = 0;
    for (const r of rows) {
      const { key, start } = bucketKey(fmt, q.groupBy, r.issued);
      const cur = buckets.get(key) ?? {
        periodStart: start.toISOString(),
        revenue: 0,
        count: 0,
      };
      cur.revenue += r.total;
      cur.count += 1;
      buckets.set(key, cur);
      totalRevenue += r.total;
    }
    const series = Array.from(buckets.entries())
      .sort((a, b) => a[1].periodStart.localeCompare(b[1].periodStart))
      .map(([key, b]) => ({
        period: key,
        periodStart: b.periodStart,
        revenue: b.revenue.toFixed(2),
        invoiceCount: b.count,
      }));

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy: q.groupBy,
      timeZone: tz,
      category: q.category ?? null,
      material: q.material ?? null,
      series,
      totals: {
        revenue: totalRevenue.toFixed(2),
        invoiceCount: rows.length,
        averageInvoice: rows.length
          ? (totalRevenue / rows.length).toFixed(2)
          : "0.00",
      },
    });
  }),
);

// ─────────────────── GET /stats/weekday-volume ───────────────────
router.get(
  "/weekday-volume",
  asyncHandler(async (req, res) => {
    const q = baseQuerySchema.parse(req.query);
    await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const { from, to } = parseWindow(q.dateFrom, q.dateTo);
    const tz = q.timeZone ?? "UTC";
    const fmt = tzFormatter(tz);

    const all = await loadCategorizedCases(q.organizationId, from, to);
    const filtered = applyCaseFilters(all, q.category, q.material);

    const perDay: Array<{ total: number; byCategory: Record<string, number> }> =
      Array.from({ length: 7 }, () => ({ total: 0, byCategory: {} }));
    for (const c of filtered) {
      const idx = localWeekday(fmt, c.receivedAt);
      const slot = perDay[idx]!;
      slot.total += 1;
      slot.byCategory[c.category] = (slot.byCategory[c.category] ?? 0) + 1;
    }

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: tz,
      category: q.category ?? null,
      material: q.material ?? null,
      weekdays: perDay.map((d, i) => ({
        weekday: i,
        label: WEEKDAY_LABELS[i]!,
        total: d.total,
        byCategory: d.byCategory,
      })),
      totalCases: filtered.length,
    });
  }),
);

export default router;
