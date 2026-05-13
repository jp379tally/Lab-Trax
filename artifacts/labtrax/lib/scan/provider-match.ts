// Provider name normalisation, levenshtein distance and scoring extracted
// from the AI-import branch of `app/(tabs)/scan.tsx` so the matching
// heuristic can be unit-tested without running the camera flow.

export function normalizeProviderName(n: string): string {
  return (n || "")
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s*/i, "")
    .replace(/,?\s*(dds|dmd|ms|bds|bchd|phd|dmd\/phd)\b.*$/i, "")
    .replace(/[,.']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function scoreProviderMatch(input: {
  providerName: string;
  practiceName?: string;
  scannedName: string;
  scannedPracticeName?: string;
}): number {
  const a = normalizeProviderName(input.providerName);
  const b = normalizeProviderName(input.scannedName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const partsA = a.split(" ").filter((w) => w.length > 1);
  const partsB = b.split(" ").filter((w) => w.length > 1);
  const shared = partsA.filter((w) => partsB.includes(w));
  let score = shared.length * 25;
  const lastA = partsA[partsA.length - 1] || "";
  const lastB = partsB[partsB.length - 1] || "";
  if (lastA && lastB) {
    if (lastA === lastB) score += 45;
    else if (lastA.length >= 4 && lastB.length >= 4) {
      const dist = levenshtein(lastA, lastB);
      const maxLen = Math.max(lastA.length, lastB.length);
      if (dist <= 1) score += 35;
      else if (dist === 2 && maxLen >= 6) score += 18;
    }
  }
  if (input.practiceName && input.scannedPracticeName) {
    const pa = normalizeProviderName(input.practiceName);
    const pb = normalizeProviderName(input.scannedPracticeName);
    if (pa && pb && (pa === pb || pa.includes(pb) || pb.includes(pa))) {
      score += 15;
    }
  }
  return score;
}

export interface ProviderCandidate {
  providerName: string;
  practiceName: string;
  clientId: string;
}

export interface RankedProviderCandidate extends ProviderCandidate {
  score: number;
}

export type ProviderMatchResult =
  | { kind: "exact"; entry: RankedProviderCandidate; ranked: RankedProviderCandidate[] }
  | { kind: "similar"; entry: RankedProviderCandidate; ranked: RankedProviderCandidate[] }
  | { kind: "none"; ranked: RankedProviderCandidate[] };

export function pickProviderMatch(
  candidates: ProviderCandidate[],
  scanned: { name: string; practiceName?: string },
  minScore = 35,
): ProviderMatchResult {
  const ranked: RankedProviderCandidate[] = candidates
    .map((c) => ({
      ...c,
      score: scoreProviderMatch({
        providerName: c.providerName,
        practiceName: c.practiceName,
        scannedName: scanned.name,
        scannedPracticeName: scanned.practiceName,
      }),
    }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const exact = ranked.find((c) => c.score >= 100);
  if (exact) return { kind: "exact", entry: exact, ranked };
  const best = ranked[0];
  if (best) return { kind: "similar", entry: best, ranked };
  return { kind: "none", ranked };
}

export function ensureDrPrefix(name: string): string {
  const trimmed = name.trim();
  return /^dr\.?\s/i.test(trimmed) ? trimmed : `Dr. ${trimmed}`;
}
