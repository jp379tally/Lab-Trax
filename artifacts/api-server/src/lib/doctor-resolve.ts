/**
 * Shared strict doctor-name resolution used by the AI-intake "doctor not on
 * file" step.
 *
 * This is the single implementation behind BOTH:
 *   - GET /doctors/resolve-name (mobile AI reader + desktop drop zone probe)
 *   - the iTero import case-create path (server-side backstop gate)
 *
 * so the exact-match rule and the human-facing suggestion list never diverge.
 *
 * Two matching concepts, kept deliberately separate:
 *   - exactMatch: strict compare only (trim + collapse internal whitespace,
 *     case-insensitive, NO title/first/last-name stripping). Returns the stored
 *     canonical spelling so pricing/invoice lookups key off it. This is the
 *     ONLY thing that makes intake "safe to auto-assign".
 *   - similarMatches: fuzzy, human-facing suggestions via the shared
 *     doctor-similarity scorer at the low DOCTOR_RESOLVE_SUGGESTION_THRESHOLD so
 *     near-misses like "Dr. Cole" -> "Dr. Kenisha Cole" surface. Never
 *     auto-assigned; the user must explicitly pick one.
 *
 * Doctor names come from the same lab(+practice)-scoped directory the pickers
 * use: distinct canonical `cases.doctorName` unioned with names parsed from
 * legacy `lab_cases` JSON blobs (which are lab-scoped and carry no practice).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, cases, labCases, organizations } from "@workspace/db";
import { notDeleted } from "./soft-delete";
import {
  doctorNameSimilarity as similarity,
  DOCTOR_RESOLVE_SUGGESTION_THRESHOLD,
} from "./doctor-similarity.js";

export interface DoctorResolveMatch {
  doctorName: string;
  /**
   * The practice this doctor is actually associated with — the provider org
   * they have the most cases under, derived exactly like GET
   * /cases/doctor-directory does it (group by doctor+practice, highest case
   * count wins, ties broken on the provider org id so the pick is stable).
   *
   * This used to echo back the practice the CALLER asked about, which meant
   * the AI intake could never name a candidate doctor's real practice. Legacy
   * `lab_cases` blob names carry no practice at all and stay null.
   */
  providerOrganizationId: string | null;
  /** Practice display name (falls back to `organizations.name`). */
  practiceName: string | null;
  practiceAddressLine1: string | null;
  practiceCity: string | null;
  practiceState: string | null;
  similarity: number;
  totalCases: number;
}

export interface DoctorResolveResult {
  exactMatch: string | null;
  similarMatches: DoctorResolveMatch[];
  canAddNew: boolean;
}

// Strict normalization: trim + collapse internal whitespace + lowercase.
// No title/name stripping — "Dr. Cole" must NOT strict-match "Dr. Kenisha Cole".
function strictNormalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolve a scanned/parsed doctor name against the existing doctor directory
 * for a lab (+ optional practice).
 */
export async function resolveDoctorName(
  labOrganizationId: string,
  providerOrganizationId: string | null,
  rawDoctorName: string,
): Promise<DoctorResolveResult> {
  const scanned = String(rawDoctorName ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!scanned) {
    return { exactMatch: null, similarMatches: [], canAddNew: true };
  }

  // Canonical doctor-name groups (with counts) scoped to lab (+ practice).
  const canonicalConds = [
    eq(cases.labOrganizationId, labOrganizationId),
    notDeleted(cases),
    sql`${cases.doctorName} is not null and trim(${cases.doctorName}) <> ''`,
  ];
  if (providerOrganizationId) {
    canonicalConds.push(
      eq(cases.providerOrganizationId, providerOrganizationId),
    );
  }
  // Grouped by doctor AND practice so each candidate can report the practice
  // it is actually associated with (mirrors GET /cases/doctor-directory).
  const canonicalGroups = await db
    .select({
      doctorName: cases.doctorName,
      providerOrganizationId: cases.providerOrganizationId,
      totalCases: sql<number>`count(*)::int`,
    })
    .from(cases)
    .where(and(...canonicalConds))
    .groupBy(cases.doctorName, cases.providerOrganizationId);

  // Legacy mobile cases keep the doctor name in a TEXT JSON blob and carry no
  // practice, so they are only lab-scoped — mirrors the picker union.
  const legacyRows = await db
    .select({ caseData: labCases.caseData })
    .from(labCases)
    .where(
      and(
        isNull(labCases.deletedAt),
        eq(labCases.organizationId, labOrganizationId),
      ),
    );

  // Directory keyed by strict-normalized spelling → { stored spelling, count,
  // per-practice case counts }.
  interface DirectoryEntry {
    spelling: string;
    totalCases: number;
    practiceCounts: Map<string, number>;
  }
  const directory = new Map<string, DirectoryEntry>();
  const addName = (raw: string, count: number, practiceId: string | null) => {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) return;
    const key = name.toLowerCase();
    let entry = directory.get(key);
    if (!entry) {
      entry = { spelling: name, totalCases: 0, practiceCounts: new Map() };
      directory.set(key, entry);
    }
    entry.totalCases += count;
    if (practiceId) {
      entry.practiceCounts.set(
        practiceId,
        (entry.practiceCounts.get(practiceId) ?? 0) + count,
      );
    }
  };
  for (const g of canonicalGroups) {
    addName(
      String(g.doctorName ?? ""),
      Number(g.totalCases ?? 0),
      g.providerOrganizationId ? String(g.providerOrganizationId) : null,
    );
  }
  for (const r of legacyRows) {
    try {
      const parsed =
        typeof r.caseData === "string" ? JSON.parse(r.caseData) : r.caseData;
      const n = String(parsed?.doctorName ?? "").trim();
      // Legacy blobs are lab-scoped and carry no providerOrganizationId, so
      // they can never contribute a practice association.
      if (n) addName(n, 1, null);
    } catch {
      // skip malformed blobs
    }
  }

  // Highest case count wins; ties break on the provider org id so repeated
  // calls always name the same practice (same rule the doctor directory uses).
  const primaryPracticeId = (entry: DirectoryEntry): string | null => {
    let bestId: string | null = null;
    let bestCount = -1;
    for (const [orgId, count] of entry.practiceCounts) {
      if (count > bestCount || (count === bestCount && bestId !== null && orgId < bestId)) {
        bestId = orgId;
        bestCount = count;
      }
    }
    return bestId;
  };

  const scannedKey = strictNormalize(scanned);
  const exact = directory.get(scannedKey);
  if (exact) {
    return {
      exactMatch: exact.spelling,
      similarMatches: [],
      canAddNew: true,
    };
  }

  // No strict match → fuzzy suggestions at the low resolve threshold.
  const scored: Array<{
    spelling: string;
    totalCases: number;
    practiceId: string | null;
    similarity: number;
  }> = [];
  for (const entry of directory.values()) {
    const sim = similarity(scanned, entry.spelling);
    if (sim >= DOCTOR_RESOLVE_SUGGESTION_THRESHOLD) {
      scored.push({
        spelling: entry.spelling,
        totalCases: entry.totalCases,
        practiceId: primaryPracticeId(entry),
        similarity: sim,
      });
    }
  }
  scored.sort(
    (a, b) => b.similarity - a.similarity || b.totalCases - a.totalCases,
  );
  const top = scored.slice(0, 12);

  // One batched lookup for the practices actually referenced by the returned
  // candidates, so the intake can ask "Is this <doctor> at <practice> —
  // <street, city, state>?" without a second round trip per candidate.
  const practiceIds = Array.from(
    new Set(top.map((m) => m.practiceId).filter((id): id is string => !!id)),
  );
  const practiceById = new Map<
    string,
    {
      name: string | null;
      addressLine1: string | null;
      city: string | null;
      state: string | null;
    }
  >();
  if (practiceIds.length > 0) {
    const orgRows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        displayName: organizations.displayName,
        addressLine1: organizations.addressLine1,
        city: organizations.city,
        state: organizations.state,
      })
      .from(organizations)
      .where(inArray(organizations.id, practiceIds));
    for (const o of orgRows) {
      practiceById.set(o.id, {
        name: (o.displayName || o.name || "").trim() || null,
        addressLine1: (o.addressLine1 ?? "").trim() || null,
        city: (o.city ?? "").trim() || null,
        state: (o.state ?? "").trim() || null,
      });
    }
  }

  const similarMatches: DoctorResolveMatch[] = top.map((m) => {
    const practice = m.practiceId ? practiceById.get(m.practiceId) : undefined;
    return {
      doctorName: m.spelling,
      providerOrganizationId: m.practiceId,
      practiceName: practice?.name ?? null,
      practiceAddressLine1: practice?.addressLine1 ?? null,
      practiceCity: practice?.city ?? null,
      practiceState: practice?.state ?? null,
      similarity: m.similarity,
      totalCases: m.totalCases,
    };
  });

  return {
    exactMatch: null,
    similarMatches,
    canAddNew: true,
  };
}
