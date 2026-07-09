/**
 * SDR1 legacy open-invoice cleanup — matching logic.
 *
 * Background: the SDR1 lab's open-invoices list showed ~66 bad records
 * (INV-26-1…51 era, Apr–Jun 2026) that are synthesized at read time from
 * still-active legacy `lab_cases` blobs carrying an embedded `invoiceId`.
 * The canonical INV-26-1…51 invoices were already voided + soft-deleted;
 * the lab's legitimate invoices are INV-26-101+ (July 2026 onward).
 *
 * This module holds the structured target list (patient names supplied by
 * the lab owner) and the pure classification logic so it can be unit-tested
 * without a database. Matching is by patient name + the legacy era date
 * window — NEVER by invoice/case number alone, because the legacy numbers
 * (26-1…26-51) were re-used by legitimate canonical cases with different
 * patients.
 *
 * Fail-closed rules:
 *  - A row whose patient name is not on the target list is never matched.
 *  - A target-named row whose blob date is missing, unparseable, or outside
 *    the legacy era window is classified `ambiguous` and never deleted.
 */

/** SDR1 production lab organization id. */
export const SDR1_ORG_ID = "fe67257e-5cc5-4489-afc9-62afb5b9829c";

/** Confirm phrase required for a live (non-dry-run) cleanup. */
export const SDR1_CLEANUP_CONFIRM = "DELETE_SDR1_LEGACY_OPEN_INVOICES";

/**
 * Legacy era window (UTC). The bad records were created Apr 4 – Jun 2 2026;
 * the window is padded to whole months but ends before July 2026, when the
 * lab's legitimate canonical invoices (INV-26-101+) begin.
 */
export const SDR1_ERA_START_MS = Date.parse("2026-03-01T00:00:00.000Z");
export const SDR1_ERA_END_MS = Date.parse("2026-07-01T00:00:00.000Z");

/**
 * Target patient list as supplied by the lab owner (attached build brief).
 * Names appear in mixed formats ("First Last", "Last/First"); comparison is
 * order-insensitive token matching, so "Fisher/Fred" also matches blob rows
 * stored as "Fisher, Fred" or "Fred Fisher".
 */
export const SDR1_TARGET_PATIENTS: readonly string[] = [
  "Donald Wayne",
  "Debra Hudson",
  "Mike Smith",
  "John David Doe",
  "Lynn Lanier",
  "Erica Luggery",
  "Sherri Minns",
  "Patrick Simmons",
  "Lisa Belcher",
  "Derrius Thomas",
  "Lajuan Williany",
  "Hiram Dodd",
  "James Wacksman",
  "William McMillan",
  "Greg Salyer",
  "Tara Manning",
  "Joel Dotel",
  "Shamari Feaster",
  "Pam Mcgoff",
  "Marlene Watson",
  "Emilia Sangalang",
  "Stephanie Sunderman-Barnes",
  "Susan Reyna",
  "Karrington Simmons",
  "Angela Worrell",
  "Corinne Strickland",
  "Melinda Jeudi",
  "Mary Barkley Myers",
  "Elizabeth Peters",
  "Fisher/Fred",
  "Slayton/Cathy",
  "Patricia Kirton",
  "Glenn Hosken",
  "Mcneil/Norma",
  "Cooper/Boysie",
  "Ramsden/Christopher",
  "Jane Doe",
  "Phipps/Angelina",
  "Kidder/Daniel",
  "Ohhh Crumbs",
  "Zurko/Cindee",
  "William Harrell",
  "Greg Beaumont",
  "Zapata/Yilder",
  "Adkinson/Lori",
  "Kessling/MaryAnn",
  "Kevin Smith",
  "James Alford",
  "Jihad Brown",
  "Bradley Lewis",
  "Sally Test",
  "Shellie Camp",
  "Liane York",
  "Robyn Blevins",
  "John Toe",
  "Jack McLeod",
  "George Braswell",
];

/**
 * Normalize a patient name into a sorted token list: lowercase, separators
 * (comma, slash, hyphen, parens, whitespace) collapsed, empty tokens dropped.
 * "Zapata, Yilder (Mark)" → ["mark","yilder","zapata"].
 */
export function normalizeNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[\/,()\-_.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

/**
 * True when a blob patient name matches a target-list name.
 * All target tokens must be present in the blob name, and the blob may carry
 * at most ONE extra token (covers nicknames/annotations such as
 * "Zapata, Yilder (Mark)" vs target "Zapata/Yilder") — anything looser risks
 * matching a different patient who merely shares a surname.
 */
export function namesMatch(blobName: string, targetName: string): boolean {
  const blob = normalizeNameTokens(blobName);
  const target = normalizeNameTokens(targetName);
  if (target.length === 0 || blob.length === 0) return false;
  if (blob.length - target.length > 1) return false;
  const blobSet = new Set(blob);
  return target.every((t) => blobSet.has(t));
}

/** Find the target-list entry a blob name matches, or null. */
export function findMatchingTarget(blobName: string | null | undefined): string | null {
  if (!blobName || typeof blobName !== "string" || !blobName.trim()) return null;
  for (const target of SDR1_TARGET_PATIENTS) {
    if (namesMatch(blobName, target)) return target;
  }
  return null;
}

/** Parse a legacy blob timestamp (epoch-ms number, numeric string, or ISO). */
export function parseLegacyTimestampMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Epoch-milliseconds; reject implausibly small values (epoch-seconds or
    // garbage) instead of guessing.
    return raw > 10_000_000_000 ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d{12,}$/.test(trimmed)) return Number(trimmed);
    const t = Date.parse(trimmed);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export type LegacyRowInput = {
  id: string;
  organizationId: string | null;
  caseData: unknown;
};

export type ClassifiedLegacyRow = {
  id: string;
  patientName: string | null;
  caseNumber: string | null;
  invoiceRef: string | null;
  createdAtMs: number | null;
  matchedTarget: string | null;
  reason: string;
};

export type Sdr1Classification = {
  /** Target-named rows inside the legacy era window — safe to soft-delete. */
  matched: ClassifiedLegacyRow[];
  /**
   * Target-named rows that FAILED a safety check (unparseable blob, missing/
   * unparseable date, or date outside the era window). Never deleted.
   */
  ambiguous: ClassifiedLegacyRow[];
  /** Active rows whose patient name is not on the target list. Never deleted. */
  nonTarget: ClassifiedLegacyRow[];
  /** Target names with zero active rows (already cleaned or never present). */
  unmatchedTargets: string[];
};

/**
 * Classify active legacy rows against the SDR1 target list.
 * Pure function — callers pass the already-org-scoped active rows.
 */
export function classifySdr1LegacyRows(rows: LegacyRowInput[]): Sdr1Classification {
  const matched: ClassifiedLegacyRow[] = [];
  const ambiguous: ClassifiedLegacyRow[] = [];
  const nonTarget: ClassifiedLegacyRow[] = [];
  const seenTargets = new Set<string>();

  for (const row of rows) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const data =
        typeof row.caseData === "string" ? JSON.parse(row.caseData) : row.caseData;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        parsed = data as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }

    if (!parsed) {
      // Malformed blob → never deleted; surfaced as ambiguous for review.
      ambiguous.push({
        id: row.id,
        patientName: null,
        caseNumber: null,
        invoiceRef: null,
        createdAtMs: null,
        matchedTarget: null,
        reason: "unparseable_blob",
      });
      continue;
    }

    const patientName =
      typeof parsed.patientName === "string" && parsed.patientName.trim()
        ? parsed.patientName.trim()
        : null;
    const caseNumber = parsed.caseNumber != null ? String(parsed.caseNumber) : null;
    const invoiceRef =
      typeof parsed.invoiceId === "string" && parsed.invoiceId.trim()
        ? parsed.invoiceId.trim()
        : null;
    const createdAtMs = parseLegacyTimestampMs(parsed.createdAt);

    const matchedTarget = findMatchingTarget(patientName);
    const base = { id: row.id, patientName, caseNumber, invoiceRef, createdAtMs };

    if (!matchedTarget) {
      nonTarget.push({ ...base, matchedTarget: null, reason: "name_not_on_target_list" });
      continue;
    }
    seenTargets.add(matchedTarget);

    if (createdAtMs == null) {
      ambiguous.push({ ...base, matchedTarget, reason: "missing_or_unparseable_created_at" });
      continue;
    }
    if (createdAtMs < SDR1_ERA_START_MS || createdAtMs >= SDR1_ERA_END_MS) {
      ambiguous.push({ ...base, matchedTarget, reason: "created_at_outside_legacy_era" });
      continue;
    }

    matched.push({ ...base, matchedTarget, reason: "target_name_in_legacy_era" });
  }

  const unmatchedTargets = SDR1_TARGET_PATIENTS.filter((t) => !seenTargets.has(t));
  return { matched, ambiguous, nonTarget, unmatchedTargets };
}
