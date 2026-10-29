import { finalizedInvoiceSql } from "../lib/historical-invoice-hold";
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
import { caseLocations, caseRestorations, cases, invoices, labCases, labClosedDays } from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, BILLING_ROLES, OWNER_ROLES, requireAnyRole } from "../lib/rbac";
import { notDeleted } from "../lib/soft-delete";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import {
  CASE_CATEGORY_KEYS,
  CASE_CATEGORY_LABELS,
  CASE_TAXONOMY,
  classifyCase,
  classifyLegacyCase,
  deriveCaseHierarchy,
  type CaseCategory,
} from "../lib/case-category";
import { normalizeMaterialName } from "../lib/material-mapping";
import { usHolidaySet } from "../lib/us-holidays";
import { legacyUtcCalendarDate } from "../lib/legacy-case-list";
import {
  countBusinessDays,
  lastCompletedBusinessDay,
  listExcludedBusinessDays,
  nthBusinessDay,
  remakeReasonBucket,
} from "../lib/stats-utils";
export { remakeReasonBucket } from "../lib/stats-utils";

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

function calendarDateInTimezone(value: Date, timeZone: string): string {
  const { yr, mo, day } = localYmd(tzFormatter(timeZone), value);
  return `${yr}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function calendarDateRange(
  from: Date,
  to: Date,
  timeZone: string,
): { fromDate: string; toDate: string } {
  return {
    fromDate: calendarDateInTimezone(from, timeZone),
    toDate: calendarDateInTimezone(to, timeZone),
  };
}

function shiftCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function calendarDaySpan(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000) + 1;
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

function calendarBucketKey(
  value: string,
  groupBy: "day" | "week" | "month" | "year",
): { key: string; start: Date } {
  const [yr, month, day] = value.split("-").map(Number);
  const mo = month - 1;
  if (groupBy === "day") {
    return { key: value, start: new Date(Date.UTC(yr, mo, day)) };
  }
  if (groupBy === "month") {
    return {
      key: `${yr}-${String(month).padStart(2, "0")}`,
      start: new Date(Date.UTC(yr, mo, 1)),
    };
  }
  if (groupBy === "year") {
    return { key: String(yr), start: new Date(Date.UTC(yr, 0, 1)) };
  }
  const date = new Date(Date.UTC(yr, mo, day));
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(yr, mo, day - mondayOffset));
  return { key: start.toISOString().slice(0, 10), start };
}

function calendarWeekday(value: string): number {
  const [yr, month, day] = value.split("-").map(Number);
  return (
    (new Date(Date.UTC(yr, month - 1, day)).getUTCDay() + 6) %
    7
  );
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
  receivedDate: string;
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
  fromDate: string,
  toDate: string,
): Promise<CategorizedCase[]> {
  const canonical = (await db
    .select({ id: cases.id, receivedAt: cases.receivedAt })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, organizationId),
        notDeleted(cases),
        gte(cases.receivedAt, fromDate),
        lte(cases.receivedAt, toDate),
      ),
    )) as Array<{ id: string; receivedAt: string | null }>;

  const ids = canonical.map((c) => c.id);
  const restoRows = ids.length
    ? ((await db
        .select({
          caseId: caseRestorations.caseId,
          restorationType: caseRestorations.restorationType,
          material: caseRestorations.material,
          restorationSubtype: caseRestorations.restorationSubtype,
        })
        .from(caseRestorations)
        .where(inArray(caseRestorations.caseId, ids))) as Array<{
        caseId: string;
        restorationType: string | null;
        material: string | null;
        restorationSubtype: string | null;
      }>)
    : [];
  const byCase = new Map<
    string,
    Array<{ restorationType: string | null; material: string | null; restorationSubtype: string | null }>
  >();
  for (const r of restoRows) {
    const arr = byCase.get(r.caseId) ?? [];
    arr.push({ restorationType: r.restorationType, material: r.material, restorationSubtype: r.restorationSubtype });
    byCase.set(r.caseId, arr);
  }

  const out: CategorizedCase[] = [];
  for (const c of canonical) {
    if (!c.receivedAt) continue;
    const restos = byCase.get(c.id) ?? [];
    out.push({
      id: c.id,
      receivedDate: c.receivedAt,
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
      updatedAt: sql<string | null>`${labCases.updatedAt}::text`,
    })
    .from(labCases)
    .where(
      and(eq(labCases.organizationId, organizationId), isNull(labCases.deletedAt)),
    )) as Array<{ id: string; caseData: unknown; updatedAt: string | null }>;

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
    let receivedDate: string | null = null;
    if (typeof rawCreated === "string" || typeof rawCreated === "number") {
      const numericCreated =
        typeof rawCreated === "string" && /^\d+$/.test(rawCreated)
          ? Number(rawCreated)
          : rawCreated;
      const d = new Date(numericCreated);
      if (!Number.isNaN(d.getTime())) {
        receivedDate = d.toISOString().slice(0, 10);
      }
    }
    receivedDate ??= legacyUtcCalendarDate(row.updatedAt);
    if (!receivedDate) continue;
    if (receivedDate < fromDate || receivedDate > toDate) {
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
      receivedDate,
      category: classifyLegacyCase(parsed),
      source: "legacy",
      materials,
    });
  }

  return out;
}

/**
 * Blank / whitespace-only remake reasons collapse to "Unspecified" so the
 * reasons list always has a stable label (matching the materialKey
 * convention for blank materials).
 */
function remakeReasonLabel(raw: string | null | undefined): string {
  return (raw ?? "").trim() || "Unspecified";
}

/** Reporting label for a reason; custom text remains on individual records. */
interface RemakeRecord {
  id: string;
  caseNumber: string;
  originalCaseId: string | null;
  originalCaseNumber: string | null;
  receivedDate: string;
  /** Display label derived from remakeReason free-text (or "Unspecified"). */
  reason: string;
  /** Structured key from the 18-key questionnaire, null for legacy or unstructured. */
  reasonKey: string | null;
  recharged: boolean;
  returnedToLab: boolean;
  /** "crown_bridge" | "removable" | "implant" | null */
  category: string | null;
  source: "canonical" | "legacy";
  /** Doctor name from the case, null for legacy blobs that don't carry it. */
  doctorName: string | null;
}

/**
 * Load every remake record (canonical + legacy) for one lab in [from, to].
 *
 * A canonical case is a remake when `remakeOfCaseId` is set; it is scoped by
 * `receivedAt` and excludes soft-deletes. A legacy `lab_cases` blob is a remake
 * when its `isRemake` flag is true or it carries a `remakeOfCaseId`; scoped by
 * the blob's `createdAt` (falling back to the row's `updatedAt`). Canonical
 * and legacy ids live in separate spaces, so a case is never double-counted.
 */
async function loadRemakeRecords(
  organizationId: string,
  from: Date | null,
  to: Date | null,
  timeZone: string,
): Promise<RemakeRecord[]> {
  const out: RemakeRecord[] = [];
  const fromDate = from ? calendarDateInTimezone(from, timeZone) : null;
  const toDate = to ? calendarDateInTimezone(to, timeZone) : null;

  // Canonical remakes — select extended fields.
  const canonical = (await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      remakeOfCaseId: cases.remakeOfCaseId,
      receivedAt: cases.receivedAt,
      remakeReason: cases.remakeReason,
      remakeReasonKey: cases.remakeReasonKey,
      remakeCharged: cases.remakeCharged,
      remakeReturnedToLab: cases.remakeReturnedToLab,
      remakeCategory: cases.remakeCategory,
      doctorName: cases.doctorName,
    })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, organizationId),
        notDeleted(cases),
        ...(fromDate ? [gte(cases.receivedAt, fromDate)] : []),
        ...(toDate ? [lte(cases.receivedAt, toDate)] : []),
        sql`${cases.remakeOfCaseId} is not null`,
      ),
    )) as Array<{
    id: string;
    caseNumber: string | null;
    remakeOfCaseId: string | null;
    receivedAt: string | null;
    remakeReason: string | null;
    remakeReasonKey: string | null;
    remakeCharged: boolean | null;
    remakeReturnedToLab: boolean | null;
    remakeCategory: string | null;
    doctorName: string | null;
  }>;

  // Batch-lookup original case numbers for all canonical originals.
  const originalIds = [
    ...new Set(canonical.map((c) => c.remakeOfCaseId).filter((id): id is string => !!id)),
  ];
  const originalRows =
    originalIds.length > 0
      ? ((await db
          .select({ id: cases.id, caseNumber: cases.caseNumber })
          .from(cases)
          .where(inArray(cases.id, originalIds))) as Array<{
          id: string;
          caseNumber: string | null;
        }>)
      : [];
  const originalMap = new Map(originalRows.map((r) => [r.id, r.caseNumber ?? ""]));

  for (const c of canonical) {
    if (!c.receivedAt) continue;
    out.push({
      id: c.id,
      caseNumber: c.caseNumber ?? c.id,
      originalCaseId: c.remakeOfCaseId,
      originalCaseNumber: c.remakeOfCaseId ? (originalMap.get(c.remakeOfCaseId) ?? null) : null,
      receivedDate: c.receivedAt,
      reason: remakeReasonLabel(c.remakeReason),
      reasonKey: c.remakeReasonKey ?? null,
      recharged: c.remakeCharged === true,
      returnedToLab: c.remakeReturnedToLab === true,
      category: c.remakeCategory ?? null,
      source: "canonical",
      doctorName: c.doctorName ?? null,
    });
  }

  // Legacy remakes from lab_cases blobs.
  const legacyRows = (await db
    .select({
      id: labCases.id,
      caseData: labCases.caseData,
      updatedAt: sql<string | null>`${labCases.updatedAt}::text`,
    })
    .from(labCases)
    .where(
      and(eq(labCases.organizationId, organizationId), isNull(labCases.deletedAt)),
    )) as Array<{ id: string; caseData: unknown; updatedAt: string | null }>;

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
    if (!blob) continue;
    const isRemake =
      blob["isRemake"] === true ||
      (typeof blob["remakeOfCaseId"] === "string" && !!blob["remakeOfCaseId"]);
    if (!isRemake) continue;

    const rawCreated = blob["createdAt"];
    let receivedDate: string | null = null;
    if (typeof rawCreated === "string" || typeof rawCreated === "number") {
      const numericCreated =
        typeof rawCreated === "string" && /^\d+$/.test(rawCreated)
          ? Number(rawCreated)
          : rawCreated;
      const d = new Date(numericCreated);
      if (!Number.isNaN(d.getTime())) {
        receivedDate = d.toISOString().slice(0, 10);
      }
    }
    receivedDate ??= legacyUtcCalendarDate(row.updatedAt);
    if (!receivedDate) continue;
    if (fromDate && receivedDate < fromDate) continue;
    if (toDate && receivedDate > toDate) continue;
    const rawReason = blob["remakeReason"];
    out.push({
      id: row.id,
      caseNumber:
        typeof blob["caseNumber"] === "string" && blob["caseNumber"]
          ? blob["caseNumber"]
          : row.id,
      originalCaseId:
        typeof blob["remakeOfCaseId"] === "string" && blob["remakeOfCaseId"]
          ? blob["remakeOfCaseId"]
          : null,
      originalCaseNumber: null,
      receivedDate,
      reason: remakeReasonLabel(typeof rawReason === "string" ? rawReason : null),
      reasonKey: null,
      recharged: blob["remakeCharged"] === true,
      returnedToLab: false,
      category: null,
      source: "legacy",
      doctorName: typeof blob["doctorName"] === "string" && blob["doctorName"] ? blob["doctorName"] : null,
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
        finalizedInvoiceSql(),
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
    const callerMembership = await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const callerIsAdmin = ADMIN_ROLES.includes(callerMembership.role as (typeof ADMIN_ROLES)[number]);
    const { from, to } = parseWindow(q.dateFrom, q.dateTo);
    const tz = q.timeZone ?? "UTC";
    const fmt = tzFormatter(tz);

    // Time-aware formatter used to compute the UTC offset for end-of-day math.
    let offsetFmt: Intl.DateTimeFormat;
    try {
      offsetFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new HttpError(400, `Invalid timeZone: ${tz}`);
    }

    // ── Business-day cutoff ────────────────────────────────────────────────
    // Average daily sales uses completed Mon–Fri non-holiday business days only
    // so that weekends, public holidays, and today's partial data do not dilute
    // the denominator.
    const now = new Date();
    const periodStart = localYmd(fmt, from);
    const periodEnd = localYmd(fmt, to);

    // Build the holiday set covering the query window + a full prior period
    // year in either direction to handle the previous-period comparison.
    const holidayDetail = await buildHolidaysDetail(
      q.organizationId,
      Math.min(periodStart.yr, localYmd(fmt, new Date(from.getTime() - (to.getTime() - from.getTime()))).yr) - 1,
      periodEnd.yr + 1,
    );
    const holidays = holidayDetail.all;

    const rawCutoff = lastCompletedBusinessDay(now, fmt, holidays);
    // Cap to period end when the period is entirely in the past.
    const rawCutoffMs = Date.UTC(rawCutoff.yr, rawCutoff.mo, rawCutoff.day);
    const periodEndMs = Date.UTC(periodEnd.yr, periodEnd.mo, periodEnd.day);
    const effectiveCutoff = rawCutoffMs <= periodEndMs ? rawCutoff : periodEnd;
    // End-of-day UTC for the cutoff — inclusive upper bound for invoice queries.
    const cutoffEndUtc = new Date(
      zonedMidnightToUtc(
        offsetFmt,
        effectiveCutoff.yr,
        effectiveCutoff.mo,
        effectiveCutoff.day + 1, // JS Date handles month-end overflow
      ).getTime() - 1,
    );
    // The invoice window: never includes data after the last completed biz day.
    const invoiceTo = new Date(Math.min(cutoffEndUtc.getTime(), to.getTime()));

    const elapsedBusinessDays = Math.max(1, countBusinessDays(periodStart, effectiveCutoff, holidays));
    const totalBusinessDays = Math.max(1, countBusinessDays(periodStart, periodEnd, holidays));

    // Collect the individual Mon–Fri days excluded from the denominator.
    const excludedDaysList = listExcludedBusinessDays(
      periodStart,
      effectiveCutoff,
      holidayDetail.federal,
      holidayDetail.custom,
    );
    const excludedDays = {
      holidayCount: excludedDaysList.filter((d) => d.reason === "holiday").length,
      customClosedCount: excludedDaysList.filter((d) => d.reason === "custom").length,
      dates: excludedDaysList,
    };
    const salesCutoffDate =
      `${effectiveCutoff.yr}-` +
      `${String(effectiveCutoff.mo + 1).padStart(2, "0")}-` +
      `${String(effectiveCutoff.day).padStart(2, "0")}`;

    // Previous period: the window of equal length immediately before.
    const spanMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - spanMs);
    const currentCaseRange = calendarDateRange(from, to, tz);
    const previousCaseTo = shiftCalendarDate(currentCaseRange.fromDate, -1);
    const previousCaseFrom = shiftCalendarDate(
      previousCaseTo,
      -(calendarDaySpan(
        currentCaseRange.fromDate,
        currentCaseRange.toDate,
      ) - 1),
    );

    // The cutoff-bounded query is separate so that totalRevenue, invoiceCount,
    // averageCaseValue, and revenueChangePct always reflect the full period
    // window. Only averageDailyRevenue uses the cutoff-bounded slice.
    const needSeparateCutoffQuery = invoiceTo.getTime() < to.getTime();
    const [curCasesAll, prevCasesAll, curInvoicesAll, prevInvoicesAll, cutoffInvoicesAll] =
      await Promise.all([
        loadCategorizedCases(
          q.organizationId,
          currentCaseRange.fromDate,
          currentCaseRange.toDate,
        ),
        loadCategorizedCases(
          q.organizationId,
          previousCaseFrom,
          previousCaseTo,
        ),
        loadRevenueInvoices(q.organizationId, from, to),
        loadRevenueInvoices(q.organizationId, prevFrom, prevTo),
        needSeparateCutoffQuery
          ? loadRevenueInvoices(q.organizationId, from, invoiceTo)
          : Promise.resolve(null),
      ]);

    const curCases = applyCaseFilters(curCasesAll, q.category, q.material);
    const prevCases = applyCaseFilters(prevCasesAll, q.category, q.material);
    const curInvoices = await filterInvoices(curInvoicesAll, q.category, q.material);
    const prevInvoices = await filterInvoices(
      prevInvoicesAll,
      q.category,
      q.material,
    );
    // Cutoff-scoped invoices for avg daily calc: reuse curInvoices when the
    // cutoff window covers the full period (past periods, non-Monday queries).
    const cutoffInvoices = needSeparateCutoffQuery
      ? await filterInvoices(cutoffInvoicesAll!, q.category, q.material)
      : curInvoices;

    const curRevenue = curInvoices.reduce((a, r) => a + r.total, 0);
    const prevRevenue = prevInvoices.reduce((a, r) => a + r.total, 0);
    const cutoffRevenue = cutoffInvoices.reduce((a, r) => a + r.total, 0);

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
      weekdayCounts[calendarWeekday(c.receivedDate)] += 1;
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

    // Average turnaround: admin/owner only, canonical cases from the already-
    // filtered curCases set (honors category/material filters).
    // Start = earliest case_locations.movedAt where locationCode = 'received'.
    // End   = earliest case_locations.movedAt where locationCode = 'complete'.
    // Cases that lack either anchor are excluded. Negative diffs are skipped.
    let avgTurnaroundDays: number | null = null;
    let eligibleTurnaroundCaseCount: number | null = null;
    if (callerIsAdmin) {
      const canonicalIds = curCases
        .filter((c) => c.source === "canonical")
        .map((c) => c.id);
      if (canonicalIds.length > 0) {
        // Earliest 'received' timestamp per case.
        const receivedRows = (await db
          .select({
            caseId: caseLocations.caseId,
            firstAt: sql<string>`MIN(${caseLocations.movedAt})`,
          })
          .from(caseLocations)
          .where(
            and(
              inArray(caseLocations.caseId, canonicalIds),
              eq(caseLocations.locationCode, "received"),
            ),
          )
          .groupBy(caseLocations.caseId)) as Array<{ caseId: string; firstAt: string }>;

        // Earliest 'complete' timestamp per case.
        const completeRows = (await db
          .select({
            caseId: caseLocations.caseId,
            firstAt: sql<string>`MIN(${caseLocations.movedAt})`,
          })
          .from(caseLocations)
          .where(
            and(
              inArray(caseLocations.caseId, canonicalIds),
              eq(caseLocations.locationCode, "complete"),
            ),
          )
          .groupBy(caseLocations.caseId)) as Array<{ caseId: string; firstAt: string }>;

        const receivedMap = new Map<string, Date>(
          receivedRows.map((r) => [r.caseId, new Date(r.firstAt)]),
        );
        const completeMap = new Map<string, Date>(
          completeRows.map((r) => [r.caseId, new Date(r.firstAt)]),
        );

        // Fallback for labs that don't use station scanning: use cases.receivedAt
        // as start and cases.updatedAt (for status='complete') as end.
        const caseReceivedFallbackMap = new Map<string, Date>(
          curCases
            .filter((c) => c.source === "canonical" && c.receivedDate)
            .map((c) => [
              c.id,
              new Date(`${c.receivedDate}T12:00:00.000Z`),
            ]),
        );
        const completedCaseRows = (await db
          .select({ id: cases.id, updatedAt: cases.updatedAt })
          .from(cases)
          .where(
            and(
              inArray(cases.id, canonicalIds),
              eq(cases.status, "complete"),
            ),
          )) as Array<{ id: string; updatedAt: Date | string | null }>;
        const caseCompletedFallbackMap = new Map<string, Date>(
          completedCaseRows
            .filter((r) => r.updatedAt != null)
            .map((r) => [r.id, r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt as string)]),
        );

        let totalMs = 0;
        let count = 0;
        for (const id of canonicalIds) {
          const start = receivedMap.get(id) ?? caseReceivedFallbackMap.get(id);
          const end = completeMap.get(id) ?? caseCompletedFallbackMap.get(id);
          if (!start || !end) continue;
          const diff = end.getTime() - start.getTime();
          if (diff >= 0) {
            totalMs += diff;
            count++;
          }
        }
        if (count > 0) {
          avgTurnaroundDays = Number((totalMs / count / 86_400_000).toFixed(2));
          eligibleTurnaroundCaseCount = count;
        }
      }
    }

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
      salesCutoffDate,
      elapsedBusinessDays,
      totalBusinessDays,
      averageDailyRevenue: (cutoffRevenue / elapsedBusinessDays).toFixed(2),
      excludedDays,
      averageCaseValue: curBilledCases
        ? (curRevenue / curBilledCases).toFixed(2)
        : "0.00",
      topCategory,
      topCategoryLabel: topCategory ? CASE_CATEGORY_LABELS[topCategory] : null,
      topCategoryCount,
      busiestWeekday,
      busiestWeekdayLabel:
        busiestWeekday === null ? null : WEEKDAY_LABELS[busiestWeekday],
      avgTurnaroundDays,
      eligibleTurnaroundCaseCount,
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

    const caseRange = calendarDateRange(from, to, q.timeZone ?? "UTC");
    const unfiltered = await loadCategorizedCases(
      q.organizationId,
      caseRange.fromDate,
      caseRange.toDate,
    );
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

    // CaseType breakdown (canonical restorations only) — derived via
    // deriveCaseHierarchy which prefers the explicit restorationSubtype column
    // and falls back to free-text inference from restorationType.
    const caseTypeCounts = new Map<string, { label: string; count: number }>();
    // Subtype breakdown — one per case (level-2 hierarchy key).
    const caseSubtypeCounts = new Map<string, { label: string; caseTypeLabel: string; count: number }>();
    // Material-subtype breakdown — one entry per restoration row (level-3 hierarchy key).
    const materialSubtypeCounts = new Map<string, { label: string; count: number }>();
    if (canonicalIds.length) {
      const txRows = (await db
        .select({
          caseId: caseRestorations.caseId,
          restorationSubtype: caseRestorations.restorationSubtype,
          restorationType: caseRestorations.restorationType,
        })
        .from(caseRestorations)
        .where(inArray(caseRestorations.caseId, canonicalIds))) as Array<{
        caseId: string;
        restorationSubtype: string | null;
        restorationType: string | null;
      }>;
      // One caseType / caseSubtype entry per canonical case (first restoration wins).
      const caseTypeByCase = new Map<string, string>();
      const caseSubtypeByCase = new Map<string, string>();
      for (const r of txRows) {
        const hierarchy = deriveCaseHierarchy(r.restorationType, r.restorationSubtype, null);

        // Level-1 caseType — one per case
        if (!caseTypeByCase.has(r.caseId)) {
          let label: string;
          if (hierarchy.caseType === "restorative") label = CASE_TAXONOMY.restorative.label;
          else if (hierarchy.caseType === "removable") label = CASE_TAXONOMY.removable.label;
          else if (hierarchy.caseType === "ortho") label = CASE_TAXONOMY.ortho.label;
          else label = "Other";
          caseTypeByCase.set(r.caseId, label);
        }

        // Level-2 subtype — one per case
        if (!caseSubtypeByCase.has(r.caseId) && hierarchy.caseType && hierarchy.subtype) {
          const subtypeLabel =
            CASE_TAXONOMY[hierarchy.caseType]?.subtypes[hierarchy.subtype]?.label ?? hierarchy.subtype;
          const caseTypeLabel = CASE_TAXONOMY[hierarchy.caseType]?.label ?? hierarchy.caseType;
          const key = `${hierarchy.caseType}/${hierarchy.subtype}`;
          caseSubtypeByCase.set(r.caseId, key);
          const cur = caseSubtypeCounts.get(key) ?? { label: subtypeLabel, caseTypeLabel, count: 0 };
          cur.count += 1;
          caseSubtypeCounts.set(key, cur);
        }

        // Level-3 materialSubtype — one per restoration row (not deduplicated per case)
        if (hierarchy.caseType && hierarchy.subtype && hierarchy.materialSubtype) {
          const msLabel =
            CASE_TAXONOMY[hierarchy.caseType]?.subtypes[hierarchy.subtype]?.materialSubtypes[
              hierarchy.materialSubtype
            ]?.label ?? hierarchy.materialSubtype;
          const key = `${hierarchy.caseType}/${hierarchy.subtype}/${hierarchy.materialSubtype}`;
          const cur = materialSubtypeCounts.get(key) ?? { label: msLabel, count: 0 };
          cur.count += 1;
          materialSubtypeCounts.set(key, cur);
        }
      }
      for (const label of caseTypeByCase.values()) {
        const cur = caseTypeCounts.get(label) ?? { label, count: 0 };
        cur.count += 1;
        caseTypeCounts.set(label, cur);
      }
    }
    const caseTypes = Array.from(caseTypeCounts.values()).sort((a, b) => b.count - a.count);
    const caseSubtypes = Array.from(caseSubtypeCounts.entries())
      .map(([key, v]) => ({ key, caseTypeLabel: v.caseTypeLabel, label: v.label, count: v.count }))
      .sort((a, b) => b.count - a.count);
    const caseMaterialSubtypes = Array.from(materialSubtypeCounts.entries())
      .map(([key, v]) => ({ key, label: v.label, count: v.count }))
      .sort((a, b) => b.count - a.count);

    return ok(res, {
      from: from.toISOString(),
      to: to.toISOString(),
      category: q.category ?? null,
      material: q.material ?? null,
      totalCases: all.length,
      categories,
      materials,
      caseTypes,
      caseSubtypes,
      caseMaterialSubtypes,
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

    const caseRange = calendarDateRange(from, to, tz);
    const all = await loadCategorizedCases(
      q.organizationId,
      caseRange.fromDate,
      caseRange.toDate,
    );
    const filtered = applyCaseFilters(all, q.category, q.material);

    const perDay: Array<{ total: number; byCategory: Record<string, number> }> =
      Array.from({ length: 7 }, () => ({ total: 0, byCategory: {} }));
    for (const c of filtered) {
      const idx = calendarWeekday(c.receivedDate);
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

// ─────────────────────── GET /stats/sales-forecast ───────────────────────
//
// Admin+owner sales projection. Projects the current week, month, and year
// sales from the pace so far, counting only Monday–Friday business days.
//
// Week / month formula:
//   forecast = avgPerDay × totalBusinessDaysInPeriod
//
// Year formula (correct projection from today forward):
//   forecast = salesSoFar + (avgPerDay × remainingWorkdaysAfterCutoff)
//
// "Elapsed" business days are the Mon–Fri days from the period start through
// the last completed business day (inclusive) in the lab's timezone. All
// arithmetic lives here so the desktop and mobile clients only render the
// returned numbers.
const forecastQuerySchema = z.object({
  organizationId: z.string().min(1),
  timeZone: z.string().min(1).max(64).optional(),
});

/**
 * The UTC offset (ms, positive when ahead of UTC) that `tz` is at the given
 * instant. Derived from Intl parts so it honors DST without a tz database.
 */
function tzOffsetMs(fmt: Intl.DateTimeFormat, date: Date): number {
  const parts = fmt.formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") m[p.type] = Number(p.value);
  }
  let hour = m.hour ?? 0;
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(
    m.year!,
    (m.month ?? 1) - 1,
    m.day ?? 1,
    hour,
    m.minute ?? 0,
    m.second ?? 0,
  );
  return asIfUtc - date.getTime();
}

/** UTC instant of local midnight (00:00:00) of the given local calendar date. */
function zonedMidnightToUtc(
  offsetFmt: Intl.DateTimeFormat,
  yr: number,
  mo: number,
  day: number,
): Date {
  const naive = Date.UTC(yr, mo, day, 0, 0, 0);
  const offset = tzOffsetMs(offsetFmt, new Date(naive));
  return new Date(naive - offset);
}

/** Format a UTC Date as "YYYY-MM-DD". */
/**
 * Load the full holidays set for a lab: US federal holidays for every year in
 * [minYear, maxYear] plus any custom closed days stored in `lab_closed_days`.
 */
async function buildHolidaysSet(
  organizationId: string,
  minYear: number,
  maxYear: number,
): Promise<Set<string>> {
  const { all } = await buildHolidaysDetail(organizationId, minYear, maxYear);
  return all;
}

/**
 * Like buildHolidaysSet but returns US federal holidays and lab-specific custom
 * closed days as separate sets so callers can distinguish them.
 */
async function buildHolidaysDetail(
  organizationId: string,
  minYear: number,
  maxYear: number,
): Promise<{ all: Set<string>; federal: Set<string>; custom: Set<string> }> {
  const years: number[] = [];
  for (let yr = minYear; yr <= maxYear; yr++) years.push(yr);
  const federal = usHolidaySet(years);

  // Custom lab-specific closed days.
  const rows = (await db
    .select({ date: labClosedDays.date })
    .from(labClosedDays)
    .where(eq(labClosedDays.labOrganizationId, organizationId))) as Array<{
    date: string;
  }>;
  const custom = new Set<string>();
  for (const r of rows) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.date)) custom.add(r.date);
  }

  const all = new Set<string>([...federal, ...custom]);
  return { all, federal, custom };
}

router.get(
  "/sales-forecast",
  asyncHandler(async (req, res) => {
    const q = forecastQuerySchema.parse(req.query);
    // Admin+owner only (ADMIN_ROLES) — stricter than BILLING_ROLES.
    await requireAnyRole((req as any).auth.userId, q.organizationId, ADMIN_ROLES);

    const tz = q.timeZone ?? "UTC";
    const dateFmt = tzFormatter(tz);
    // Second formatter with time parts, used only to read the tz offset.
    let offsetFmt: Intl.DateTimeFormat;
    try {
      offsetFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new HttpError(400, `Invalid timeZone: ${tz}`);
    }

    const now = new Date();
    const today = localYmd(dateFmt, now);

    // Load holidays for this year + surrounding years (prior week can straddle
    // year boundaries; year forecast covers current + prior full year).
    const holidays = await buildHolidaysSet(q.organizationId, today.yr - 2, today.yr + 1);

    // Last completed Mon–Fri non-holiday business day — same cutoff logic as /stats/summary.
    const cutoff = lastCompletedBusinessDay(now, dateFmt, holidays);

    // Period start/end (inclusive) in local calendar dates.
    const dowMon0 = (new Date(Date.UTC(today.yr, today.mo, today.day)).getUTCDay() + 6) % 7;
    const weekStartMs = Date.UTC(today.yr, today.mo, today.day - dowMon0);
    const weekStart = new Date(weekStartMs);
    const weekEnd = new Date(weekStartMs + 6 * 86_400_000);
    const monthEndDay = new Date(Date.UTC(today.yr, today.mo + 1, 0)).getUTCDate();

    // Prior comparable period (the immediately preceding week/month/year),
    // used for the pace-trend indicator. The trend compares the current
    // per-business-day pace against the SAME number of elapsed business days
    // into this prior period (apples-to-apples), so seasonality within a
    // period (e.g. end-of-month billing surges) does not distort the signal.
    const priorWeekStart = new Date(weekStartMs - 7 * 86_400_000);
    const priorWeekEnd = new Date(weekStartMs - 86_400_000);
    const priorMonthYr = today.mo === 0 ? today.yr - 1 : today.yr;
    const priorMonthMo = today.mo === 0 ? 11 : today.mo - 1;
    const priorMonthEndDay = new Date(
      Date.UTC(priorMonthYr, priorMonthMo + 1, 0),
    ).getUTCDate();

    const periods: Array<{
      key: "week" | "month" | "year";
      start: { yr: number; mo: number; day: number };
      end: { yr: number; mo: number; day: number };
      priorStart: { yr: number; mo: number; day: number };
      priorEnd: { yr: number; mo: number; day: number };
    }> = [
      {
        key: "week",
        start: {
          yr: weekStart.getUTCFullYear(),
          mo: weekStart.getUTCMonth(),
          day: weekStart.getUTCDate(),
        },
        end: {
          yr: weekEnd.getUTCFullYear(),
          mo: weekEnd.getUTCMonth(),
          day: weekEnd.getUTCDate(),
        },
        priorStart: {
          yr: priorWeekStart.getUTCFullYear(),
          mo: priorWeekStart.getUTCMonth(),
          day: priorWeekStart.getUTCDate(),
        },
        priorEnd: {
          yr: priorWeekEnd.getUTCFullYear(),
          mo: priorWeekEnd.getUTCMonth(),
          day: priorWeekEnd.getUTCDate(),
        },
      },
      {
        key: "month",
        start: { yr: today.yr, mo: today.mo, day: 1 },
        end: { yr: today.yr, mo: today.mo, day: monthEndDay },
        priorStart: { yr: priorMonthYr, mo: priorMonthMo, day: 1 },
        priorEnd: { yr: priorMonthYr, mo: priorMonthMo, day: priorMonthEndDay },
      },
      {
        key: "year",
        start: { yr: today.yr, mo: 0, day: 1 },
        end: { yr: today.yr, mo: 11, day: 31 },
        priorStart: { yr: today.yr - 1, mo: 0, day: 1 },
        priorEnd: { yr: today.yr - 1, mo: 11, day: 31 },
      },
    ];

    const results = await Promise.all(
      periods.map(async (p) => {
        const from = zonedMidnightToUtc(offsetFmt, p.start.yr, p.start.mo, p.start.day);
        // Sales-to-date window ends at the last completed business day, not
        // "now". This excludes today's partial data, weekends, and Mondays
        // (which would include the current unfinished day), keeping the
        // denominator and numerator on the same completed-business-day basis.
        const periodCutoff: { yr: number; mo: number; day: number } =
          Date.UTC(cutoff.yr, cutoff.mo, cutoff.day) <=
          Date.UTC(p.end.yr, p.end.mo, p.end.day)
            ? cutoff
            : p.end;
        const cutoffEndUtc = new Date(
          zonedMidnightToUtc(
            offsetFmt,
            periodCutoff.yr,
            periodCutoff.mo,
            periodCutoff.day + 1,
          ).getTime() - 1,
        );
        const invoicesInWindow = await loadRevenueInvoices(
          q.organizationId,
          from,
          cutoffEndUtc,
        );
        const periodToDateSales = invoicesInWindow.reduce((a, r) => a + r.total, 0);

        const elapsedBusinessDays = countBusinessDays(p.start, periodCutoff, holidays);
        const totalBusinessDays = countBusinessDays(p.start, p.end, holidays);

        // Guard divide-by-zero: no elapsed business day yet (e.g. a period
        // that starts on a weekend), or no sales recorded so far.
        const insufficientData = elapsedBusinessDays === 0 || periodToDateSales <= 0;
        const averagePerBusinessDay =
          elapsedBusinessDays > 0 ? periodToDateSales / elapsedBusinessDays : 0;

        // Year forecast: salesSoFar + (avgPerDay × remainingWorkdaysAfterCutoff).
        // This correctly projects remaining revenue on top of what has already
        // been earned. Week/month use the full-period formula because those
        // periods may largely be in the future.
        let forecast: number;
        if (p.key === "year") {
          const dacMs =
            Date.UTC(periodCutoff.yr, periodCutoff.mo, periodCutoff.day) + 86_400_000;
          const dac = new Date(dacMs);
          const remainingBusinessDays = countBusinessDays(
            { yr: dac.getUTCFullYear(), mo: dac.getUTCMonth(), day: dac.getUTCDate() },
            p.end,
            holidays,
          );
          forecast = periodToDateSales + averagePerBusinessDay * remainingBusinessDays;
        } else {
          forecast = averagePerBusinessDay * totalBusinessDays;
        }

        // ── Pace trend vs the prior comparable period ──────────────────────
        // Compare the current per-business-day pace against the SAME number of
        // elapsed business days into the immediately-preceding period. When
        // the current period lacks data there is nothing to trend, and when
        // the prior comparable window had no sales the change is undefined
        // (null) rather than a misleading +∞.
        let previousPeriod: {
          periodStart: string;
          comparableSales: string;
          comparableBusinessDays: number;
          averagePerBusinessDay: string;
        } | null = null;
        let paceChangePct: number | null = null;

        if (!insufficientData) {
          // Nth business day into the prior period (same elapsed count as now),
          // capped to the prior period's end when it is shorter (e.g. a 20-day
          // prior month vs a 23-day current month).
          const priorCutoff =
            nthBusinessDay(p.priorStart, elapsedBusinessDays, p.priorEnd, holidays) ??
            p.priorEnd;
          const priorFrom = zonedMidnightToUtc(
            offsetFmt,
            p.priorStart.yr,
            p.priorStart.mo,
            p.priorStart.day,
          );
          // Inclusive through the end of the cutoff local day: local midnight
          // of the following day, minus 1ms.
          const nextMs =
            Date.UTC(priorCutoff.yr, priorCutoff.mo, priorCutoff.day) + 86_400_000;
          const nextDay = new Date(nextMs);
          const priorTo = new Date(
            zonedMidnightToUtc(
              offsetFmt,
              nextDay.getUTCFullYear(),
              nextDay.getUTCMonth(),
              nextDay.getUTCDate(),
            ).getTime() - 1,
          );
          const priorInvoices = await loadRevenueInvoices(
            q.organizationId,
            priorFrom,
            priorTo,
          );
          const priorSales = priorInvoices.reduce((a, r) => a + r.total, 0);
          const priorBusinessDays = countBusinessDays(p.priorStart, priorCutoff, holidays);
          const priorAveragePerBusinessDay =
            priorBusinessDays > 0 ? priorSales / priorBusinessDays : 0;
          previousPeriod = {
            periodStart: priorFrom.toISOString(),
            comparableSales: priorSales.toFixed(2),
            comparableBusinessDays: priorBusinessDays,
            averagePerBusinessDay: priorAveragePerBusinessDay.toFixed(2),
          };
          if (priorAveragePerBusinessDay > 0) {
            paceChangePct = Number(
              (
                ((averagePerBusinessDay - priorAveragePerBusinessDay) /
                  priorAveragePerBusinessDay) *
                100
              ).toFixed(1),
            );
          }
        }

        return {
          key: p.key,
          periodStart: from.toISOString(),
          periodToDateSales: periodToDateSales.toFixed(2),
          elapsedBusinessDays,
          totalBusinessDays,
          averagePerBusinessDay: averagePerBusinessDay.toFixed(2),
          forecast: forecast.toFixed(2),
          insufficientData,
          paceChangePct,
          previousPeriod,
        };
      }),
    );

    const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
    return ok(res, {
      organizationId: q.organizationId,
      timeZone: tz,
      asOf: now.toISOString(),
      week: byKey.week,
      month: byKey.month,
      year: byKey.year,
    });
  }),
);

// ───────────────────────── GET /stats/remakes ─────────────────────────
// Owner/admin ONLY (ADMIN_ROLES) — intentionally narrower than the other
// stats endpoints (which allow BILLING_ROLES). Billing members must not see
// remake stats.
//
// Optional filters: reasonKey, recharged (yes|no), returnedToLab (yes|no),
// remakeCategory (crown_bridge|removable), groupBy (week|month).
// All filter params apply to the records list, time series, AND summary counts.
router.get(
  "/remakes",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        organizationId: z.string().min(1),
        dateFrom: z.string().min(1).optional(),
        dateTo: z.string().min(1).optional(),
        timeZone: z.string().min(1).max(64).optional(),
        groupBy: z.enum(["week", "month"]).optional().default("week"),
        reasonKey: z.string().min(1).max(64).optional(),
        recharged: z.enum(["yes", "no"]).optional(),
        returnedToLab: z.enum(["yes", "no"]).optional(),
        remakeCategory: z.enum(["crown_bridge", "removable", "implant"]).optional(),
        doctorName: z.string().min(1).max(200).optional(),
      })
      .parse(req.query);

    await requireAnyRole((req as any).auth.userId, q.organizationId, ADMIN_ROLES);
    const window =
      q.dateFrom && q.dateTo ? parseWindow(q.dateFrom, q.dateTo) : null;
    const from = window?.from ?? null;
    const to = window?.to ?? null;
    const tz = q.timeZone ?? "UTC";

    // Load all records, then apply optional filters.
    let records = await loadRemakeRecords(
      q.organizationId,
      from,
      to,
      q.timeZone ?? "UTC",
    );

    if (q.reasonKey) {
      records = records.filter((r) => r.reasonKey === q.reasonKey);
    }
    if (q.recharged === "yes") {
      records = records.filter((r) => r.recharged);
    } else if (q.recharged === "no") {
      records = records.filter((r) => !r.recharged);
    }
    if (q.returnedToLab === "yes") {
      records = records.filter((r) => r.returnedToLab);
    } else if (q.returnedToLab === "no") {
      records = records.filter((r) => !r.returnedToLab);
    }
    if (q.remakeCategory) {
      records = records.filter((r) => r.category === q.remakeCategory);
    }
    if (q.doctorName) {
      records = records.filter(
        (r) => (r.doctorName?.trim() || "Unknown") === q.doctorName,
      );
    }

    // Summary stats.
    const rechargedRemakes = records.filter((r) => r.recharged).length;
    const nonRechargedRemakes = records.length - rechargedRemakes;

    // Structured custom reasons share one stable reporting bucket while the
    // individual record keeps its typed free-text `reason`.
    const reasonCounts = new Map<string, number>();
    for (const r of records) {
      const bucket = remakeReasonBucket(r.reason, r.reasonKey);
      reasonCounts.set(bucket, (reasonCounts.get(bucket) ?? 0) + 1);
    }
    const remakeReasons = Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

    // By-doctor breakdown.
    const doctorCounts = new Map<string, number>();
    for (const r of records) {
      const name = r.doctorName?.trim() || "Unknown";
      doctorCounts.set(name, (doctorCounts.get(name) ?? 0) + 1);
    }
    const byDoctor = Array.from(doctorCounts.entries())
      .map(([doctorName, count]) => ({ doctorName, count }))
      .sort((a, b) => b.count - a.count || a.doctorName.localeCompare(b.doctorName));

    // By-reason alias (same as remakeReasons, consistent naming).
    const byReason = remakeReasons.map((r) => ({ reason: r.reason, count: r.count }));

    // By-type breakdown — maps category to a display label.
    function categoryToType(category: string | null): string {
      if (category === "crown_bridge") return "Restorative";
      if (category === "removable") return "Removable";
      if (category === "implant") return "Implant";
      return "Other";
    }
    const typeCounts = new Map<string, number>();
    for (const r of records) {
      const t = categoryToType(r.category);
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const byType = Array.from(typeCounts.entries())
      .map(([typeName, count]) => ({ typeName, count }))
      .sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName));

    // Received dates are calendar days, so timezone offsets must not move them
    // into a neighboring bucket.
    const buckets = new Map<string, { periodStart: string; count: number }>();
    for (const r of records) {
      const { key, start } = calendarBucketKey(r.receivedDate, q.groupBy);
      if (!buckets.has(key)) {
        buckets.set(key, { periodStart: start.toISOString(), count: 0 });
      }
      buckets.get(key)!.count++;
    }
    const timeSeries = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, { periodStart, count }]) => ({ period, periodStart, count }));

    // Serialised records (newest first).
    const serialisedRecords = records
      .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate))
      .map((r) => ({
        id: r.id,
        caseNumber: r.caseNumber,
        originalCaseId: r.originalCaseId,
        originalCaseNumber: r.originalCaseNumber,
        receivedAt: r.receivedDate,
        reason: r.reason,
        reasonKey: r.reasonKey,
        recharged: r.recharged,
        returnedToLab: r.returnedToLab,
        category: r.category,
        source: r.source,
        doctorName: r.doctorName,
      }));

    return ok(res, {
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      timeZone: tz,
      totalRemakes: records.length,
      rechargedRemakes,
      nonRechargedRemakes,
      remakeReasons,
      byDoctor,
      byReason,
      byType,
      timeSeries,
      records: serialisedRecords,
    });
  }),
);

// ─────────────────── GET /stats/revenue-by-doctor ───────────────────
//
// Per-doctor revenue breakdown for a given period. Left-joins cases to
// pull doctorName; invoices with no linked case surface under
// "Unlinked / Manual". Requires billing/admin/owner role on the lab.
const revenuByDoctorSchema = z.object({
  organizationId: z.string().min(1),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  timeZone: z.string().min(1).max(64).optional(),
});

router.get(
  "/revenue-by-doctor",
  asyncHandler(async (req, res) => {
    const q = revenuByDoctorSchema.parse(req.query);
    await requireAnyRole((req as any).auth.userId, q.organizationId, BILLING_ROLES);
    const { from, to } = parseWindow(q.periodStart, q.periodEnd);

    const issued = sql<Date>`COALESCE(${invoices.issuedAt}, ${invoices.createdAt})`;
    const rows = (await db
      .select({
        caseId: invoices.caseId,
        issued,
        total: invoices.total,
        doctorName: cases.doctorName,
      })
      .from(invoices)
      .leftJoin(cases, eq(invoices.caseId, cases.id))
      .where(
        and(
          eq(invoices.labOrganizationId, q.organizationId),
          isNull(invoices.deletedAt),
          sql`${invoices.status} <> 'void'`,
          finalizedInvoiceSql(),
          gte(issued, from),
          lte(issued, to),
        ),
      )) as Array<{
      caseId: string | null;
      issued: string | Date;
      total: string;
      doctorName: string | null;
    }>;

    const UNLINKED_LABEL = "Unlinked / Manual";
    const doctorMap = new Map<string, { revenue: number; invoiceCount: number }>();

    for (const r of rows) {
      const d = new Date(r.issued as string);
      if (Number.isNaN(d.getTime())) continue;
      const doctor = (r.doctorName ?? "").trim() || UNLINKED_LABEL;
      const cur = doctorMap.get(doctor) ?? { revenue: 0, invoiceCount: 0 };
      cur.revenue += Number(r.total || 0);
      cur.invoiceCount += 1;
      doctorMap.set(doctor, cur);
    }

    // Sort by revenue descending; "Unlinked / Manual" always last.
    const doctors = Array.from(doctorMap.entries())
      .map(([doctorName, v]) => ({
        doctorName,
        revenue: v.revenue.toFixed(2),
        invoiceCount: v.invoiceCount,
      }))
      .sort((a, b) => {
        if (a.doctorName === UNLINKED_LABEL) return 1;
        if (b.doctorName === UNLINKED_LABEL) return -1;
        return Number(b.revenue) - Number(a.revenue);
      });

    return ok(res, {
      periodStart: from.toISOString(),
      periodEnd: to.toISOString(),
      doctors,
    });
  }),
);

export default router;
