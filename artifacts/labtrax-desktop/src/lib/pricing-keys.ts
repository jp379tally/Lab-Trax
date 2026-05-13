/**
 * Single source of truth for the standard pricing-key labels and the
 * material → key mapping the desktop renderer uses for pricing UI.
 *
 * The server's authoritative copy lives at
 * `artifacts/api-server/src/lib/material-mapping.ts` (with unit tests).
 * Keep these two files aligned — the test suite there enforces that no
 * key the server emits is missing from `DEFAULT_TIER_KEYS`, but if the
 * desktop UI is ever asked to display labels for a key it doesn't know
 * about, `labelFor()` titlecases the key as a graceful fallback.
 */

export const PRICE_KEY_LABELS: Record<string, string> = {
  zirconia_crown: "Zirconia Crown",
  emax_crown: "E.max Crown",
  pfm_crown: "PFM Crown",
  denture: "Denture",
  partial: "Partial",
  implant: "Implant",
  night_guard_hard: "Night Guard - Hard",
  night_guard_soft: "Night Guard - Soft",
  night_guard_hard_soft: "Night Guard - Hard/Soft",
  retainer_hawley: "Retainer - Hawley",
  retainer_hard: "Retainer - Hard",
  retainer_lingual: "Retainer - Lingual",
  snore_guard: "Snore Guard",
  sports_guard: "Sports Guard",
};

export const DEFAULT_PRICE_KEYS = Object.keys(PRICE_KEY_LABELS);

const VALID_KEY_SET = new Set(DEFAULT_PRICE_KEYS);

export function labelFor(key: string): string {
  return (
    PRICE_KEY_LABELS[key] ||
    key.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase())
  );
}

// Alias kept so existing call sites in practices.tsx don't churn.
export const priceKeyLabel = labelFor;

/**
 * Mirror of the server's mapping so the desktop UI can flag billed
 * restorations whose material/type combo doesn't resolve to a known
 * pricing key. When this returns `null`, the price resolver on the
 * server will also return `null` — meaning that restoration will never
 * pick up a tier or override price automatically and is silently being
 * billed at whatever the user typed (or $0).
 */
export function materialToPriceKey(
  material?: string | null,
  restorationType?: string | null,
): string | null {
  const m = (material || "").toLowerCase().trim();
  const rt = (restorationType || "").toLowerCase().trim();
  if (m.includes("zirconia") || m.includes("pfz")) return "zirconia_crown";
  if (m.includes("emax") || m.includes("e.max") || m.includes("e max"))
    return "emax_crown";
  if (m.includes("pfm")) return "pfm_crown";
  if (
    m.includes("gold") ||
    m.includes("full cast") ||
    m.includes("semi precious") ||
    m.includes("cast metal")
  )
    return "pfm_crown";
  if (m === "acrylic" || rt.includes("denture")) return "denture";
  if (m.includes("flexible") || rt.includes("partial")) return "partial";
  if (rt.includes("implant")) return "implant";
  if (m.includes("night guard hard/soft") || rt.includes("hard/soft"))
    return "night_guard_hard_soft";
  if (m.includes("night guard soft") || rt.includes("night guard - soft"))
    return "night_guard_soft";
  if (m.includes("night guard") || rt.includes("night guard"))
    return "night_guard_hard";
  if (rt.includes("retainer hawley") || rt.includes("hawley"))
    return "retainer_hawley";
  if (rt.includes("retainer lingual") || rt.includes("lingual"))
    return "retainer_lingual";
  if (m.includes("retainer") || rt.includes("retainer")) return "retainer_hard";
  if (rt.includes("snore")) return "snore_guard";
  if (rt.includes("sports")) return "sports_guard";
  return null;
}

/**
 * Returns true when an override (or practice connection) references a
 * pricing-tier name that no longer exists on the lab. Comparison is
 * case-insensitive and trims whitespace, mirroring the server-side
 * cascade matcher in `routes/pricing.ts`.
 */
export function isTierMissing(
  assignedTierName: string | null | undefined,
  availableTiers: ReadonlyArray<{ name: string }>,
): boolean {
  const t = (assignedTierName ?? "").trim().toLowerCase();
  if (!t) return false;
  if (availableTiers.length === 0) return false;
  return !availableTiers.some(
    (tier) => tier.name.trim().toLowerCase() === t,
  );
}

export function isKnownPriceKey(key: string | null | undefined): boolean {
  return !!key && VALID_KEY_SET.has(key);
}
