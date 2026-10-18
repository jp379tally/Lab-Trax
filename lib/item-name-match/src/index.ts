/**
 * Punctuation-insensitive matching + ranking for item and vocabulary
 * typeaheads.
 *
 * Catalog item names carry punctuation users do not reproduce when they type:
 * "E.max Crown" is reached for as "ema"/"emax", "3-Unit Bridge" as "3 unit".
 * A plain substring match on the raw name misses all of those, so the query and
 * the option name are both reduced to bare alphanumerics before comparing.
 *
 * Matches are then ranked so a short query still puts the obvious answer on
 * top: exact name, then names starting with the query, then names with a word
 * starting with the query, then anything merely containing it. Ordering inside
 * a rank preserves the caller's option order (catalog before custom).
 */

/** Lowercase and strip everything that is not a letter or a digit. */
export function normalizeItemName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Word-ish pieces of a name, each normalized ("E.max Crown" → e, max, crown). */
function nameTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export const ITEM_MATCH_RANK = {
  exact: 0,
  prefix: 1,
  wordPrefix: 2,
  contains: 3,
  none: -1,
} as const;

/**
 * Rank a single option name against an already-normalized query.
 * Returns `ITEM_MATCH_RANK.none` (-1) when the name does not match at all.
 */
function rankItemName(name: string, normQuery: string): number {
  const normName = normalizeItemName(name);
  if (!normName.includes(normQuery)) return ITEM_MATCH_RANK.none;
  if (normName === normQuery) return ITEM_MATCH_RANK.exact;
  if (normName.startsWith(normQuery)) return ITEM_MATCH_RANK.prefix;
  if (nameTokens(name).some((t) => t.startsWith(normQuery)))
    return ITEM_MATCH_RANK.wordPrefix;
  return ITEM_MATCH_RANK.contains;
}

/**
 * Filter + rank options by name. An empty (or punctuation-only) query returns
 * the options untouched, in the caller's order.
 */
export function filterItemsByName<T extends { name: string }>(
  options: T[],
  query: string,
): T[] {
  const normQuery = normalizeItemName(query);
  if (!normQuery) return options;
  return options
    .map((option, index) => ({
      option,
      index,
      rank: rankItemName(option.name, normQuery),
    }))
    .filter((entry) => entry.rank !== ITEM_MATCH_RANK.none)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.option);
}

/**
 * True when an option names the same thing the user typed, ignoring case,
 * punctuation and spacing — so typing "emax crown" does not offer to create
 * a second billable item alongside the existing "E.max Crown".
 */
export function hasExactItemNameMatch(
  options: { name: string }[],
  query: string,
): boolean {
  const normQuery = normalizeItemName(query);
  if (!normQuery) return false;
  return options.some((o) => normalizeItemName(o.name) === normQuery);
}

/**
 * Plain-string variant of {@link filterItemsByName} for free-text vocabulary
 * fields (material, shade, restoration type) whose suggestions are strings.
 */
export function filterNamesByQuery(names: string[], query: string): string[] {
  return filterItemsByName(
    names.map((name) => ({ name })),
    query,
  ).map((entry) => entry.name);
}

/**
 * The suggestion that names the same thing the user typed, ignoring case,
 * punctuation and spacing — `undefined` when the typed value is genuinely new.
 * Callers pick the returned (canonical) spelling rather than the typed one.
 */
export function findExactNameMatch(
  names: string[],
  query: string,
): string | undefined {
  const normQuery = normalizeItemName(query);
  if (!normQuery) return undefined;
  return names.find((name) => normalizeItemName(name) === normQuery);
}