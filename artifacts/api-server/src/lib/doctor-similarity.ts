/**
 * Shared doctor-name fuzzy-matching helpers.
 *
 * Consolidates the bigram-similarity logic that previously lived in two
 * places — `normalizeForCompare`/`similarity` in the doctors route (which
 * powers the possible-duplicate clusters + merge tooling) and the
 * `_normalizeDoctorForSim`/`_bigramSimilarity` copy in the cases route (used
 * for AI-extracted "Did you mean?" suggestions). Both now import from here so
 * the pre-create duplicate-doctor check, the duplicate-clusters panel, and the
 * AI-suggestion path all use byte-for-byte identical matching and the same
 * per-lab threshold.
 *
 * The normalization mirrors the duplicate-clusters/merge behavior exactly
 * (`\bdr\.?\b` word-boundary strip), so consolidating does NOT change the
 * existing clustering/merge scores.
 */

export function normalizeDoctorForCompare(
  name: string | null | undefined
): string {
  return (name ?? "")
    .toString()
    .toLowerCase()
    .replace(/\bdr\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// bigram set — cheap and good enough for short doctor names.
export function doctorNameBigrams(s: string): Set<string> {
  const set = new Set<string>();
  const padded = ` ${s} `;
  for (let i = 0; i < padded.length - 1; i++) set.add(padded.slice(i, i + 2));
  return set;
}

// Bigram Jaccard over two already-normalized strings and their precomputed
// bigram sets. Splitting this out lets the O(n²) clustering loop normalize and
// gram each name once instead of re-deriving both on every pair — the result is
// byte-for-byte identical to calling `doctorNameSimilarity(a, b)`.
export function bigramJaccard(
  an: string,
  A: Set<string>,
  bn: string,
  B: Set<string>
): number {
  if (!an || !bn) return 0;
  if (an === bn) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function doctorNameSimilarity(a: string, b: string): number {
  const an = normalizeDoctorForCompare(a);
  const bn = normalizeDoctorForCompare(b);
  if (!an || !bn) return 0;
  if (an === bn) return 1;
  return bigramJaccard(an, doctorNameBigrams(an), bn, doctorNameBigrams(bn));
}

// Default per-lab similarity threshold for treating two doctor names as likely
// duplicates. A lab may override this via organizations.duplicateSuggestionThreshold.
export const DEFAULT_DUP_SIMILARITY_THRESHOLD = 0.7;

// Clamp + parse a per-lab override from organizations.duplicateSuggestionThreshold.
// Mirrors resolveLabDupThreshold on the desktop client (clamp 0.5–0.95).
export function resolveLabDupThreshold(
  raw: string | number | null | undefined
): number {
  if (raw === null || raw === undefined || raw === "")
    return DEFAULT_DUP_SIMILARITY_THRESHOLD;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return DEFAULT_DUP_SIMILARITY_THRESHOLD;
  return Math.min(0.95, Math.max(0.5, n));
}
