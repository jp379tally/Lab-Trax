/**
 * Patient-name similarity helpers used by the duplicate / remake detection
 * flow. We deliberately keep this dead-simple and dependency-free so it can
 * run inline in request handlers without latency or cost.
 *
 * Match rules (most → least confident):
 *   - exact normalized match (case-insensitive, punctuation/whitespace
 *     stripped)
 *   - last-name normalized match + first-name nickname-equivalent
 *     (e.g. "Deb" ↔ "Debra", "Mike" ↔ "Michael")
 *   - last-name normalized match + first-name Levenshtein distance ≤ 1
 *     (catches single typos / extra letters)
 */

const NICKNAME_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["alex", "alexander", "alexandra", "alexis"],
  ["bart", "bartholomew"],
  ["beth", "elizabeth", "liz", "lizzy", "betty", "eliza"],
  ["bill", "william", "will", "willy", "billy"],
  ["bob", "robert", "rob", "robby", "bobby"],
  ["cathy", "catherine", "cath", "kate", "katherine", "kathy", "katie"],
  ["chris", "christopher", "christian", "christine", "christina"],
  ["dan", "daniel", "danny"],
  ["dave", "david"],
  ["deb", "debra", "deborah", "debbie", "debby"],
  ["don", "donald", "donny"],
  ["ed", "edward", "eddie", "ted", "teddy"],
  ["fred", "frederick", "freddie"],
  ["greg", "gregory"],
  ["jen", "jennifer", "jenny", "jenn"],
  ["jim", "james", "jimmy", "jamie"],
  ["joe", "joseph", "joey"],
  ["john", "johnny", "jon", "jonathan"],
  ["josh", "joshua"],
  ["kate", "katherine", "katie", "kathy", "kathleen"],
  ["ken", "kenneth", "kenny"],
  ["larry", "lawrence", "laurence"],
  ["matt", "matthew", "matty"],
  ["meg", "megan", "meghan", "maggie", "margaret"],
  ["mike", "michael", "mick", "mickey"],
  ["nick", "nicholas", "nicky"],
  ["pam", "pamela"],
  ["pat", "patrick", "patricia", "patty", "trish"],
  ["pete", "peter"],
  ["rick", "richard", "ricky", "dick"],
  ["ron", "ronald", "ronny"],
  ["sam", "samuel", "samantha", "sammy"],
  ["steve", "steven", "stephen", "stevie"],
  ["sue", "susan", "suzanne", "suzy"],
  ["tom", "thomas", "tommy"],
  ["tony", "anthony", "antonio"],
  ["vic", "victor", "vicky", "victoria"],
  ["zach", "zachary", "zack"],
];

const NICKNAME_MAP: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of NICKNAME_GROUPS) {
    const set = new Set(group);
    for (const name of group) {
      const existing = map.get(name);
      if (existing) {
        for (const n of set) existing.add(n);
      } else {
        map.set(name, new Set(set));
      }
    }
  }
  return map;
})();

export function normalizeName(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function namesShareNickname(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const aliases = NICKNAME_MAP.get(na);
  return !!aliases && aliases.has(nb);
}

/** Iterative O(n*m) Levenshtein, capped to short names. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export type SimilarityMatchKind = "exact" | "nickname" | "fuzzy";

export interface SimilarityCandidate {
  firstName: string;
  lastName: string;
}

/**
 * Returns the strongest match kind between (queryFirst, queryLast) and the
 * candidate, or null if no match. Last names must always match (normalized);
 * first names may match exactly, via nickname, or via Levenshtein ≤ 1.
 */
export function classifyMatch(
  queryFirst: string,
  queryLast: string,
  candidate: SimilarityCandidate
): SimilarityMatchKind | null {
  const qFirst = normalizeName(queryFirst);
  const qLast = normalizeName(queryLast);
  const cFirst = normalizeName(candidate.firstName);
  const cLast = normalizeName(candidate.lastName);
  if (!qLast || !cLast || qLast !== cLast) return null;
  if (!qFirst || !cFirst) return null;
  if (qFirst === cFirst) return "exact";
  if (namesShareNickname(qFirst, cFirst)) return "nickname";
  // Only run the (capped) edit-distance check on short names to bound cost.
  if (qFirst.length <= 16 && cFirst.length <= 16) {
    if (levenshtein(qFirst, cFirst) <= 1) return "fuzzy";
  }
  return null;
}

/**
 * Split a free-form patient display name (mobile legacy) into (first, last).
 * "Debra Hudson" → { first: "Debra", last: "Hudson" }
 * "Hudson"       → { first: "", last: "Hudson" }
 */
export function splitDisplayName(displayName: string | null | undefined): {
  first: string;
  last: string;
} {
  const s = String(displayName ?? "").trim();
  if (!s) return { first: "", last: "" };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: "", last: parts[0] };
  return {
    first: parts.slice(0, -1).join(" "),
    last: parts[parts.length - 1],
  };
}
