import type { LabCase } from "./data";

/**
 * Reconcile a local cache of cases with an authoritative server response.
 *
 * The server (GET /api/legacy/cases) decides visibility purely from the
 * authenticated user's lab memberships. Whatever it returns is exactly
 * what the user is allowed to see. The client must therefore:
 *
 *   1. Adopt the server's payload verbatim for every case the server
 *      returned (the GET handler normalizes affiliationKey/affiliationName
 *      from the organization_id column on every read, so the server's
 *      copy is always the canonical one).
 *   2. Drop any locally-cached lab-tagged case the server did NOT return —
 *      the user no longer has access (membership revoked, never had it,
 *      or the case was deleted on another device). Keeping it would put
 *      the UI out of sync with the server's visibility decision.
 *   3. Preserve any locally-cached case without a lab tag (private case)
 *      that the server did not return. It might be an offline scan that
 *      hasn't been pushed yet; the next sync will reconcile it once it
 *      appears in the server response.
 *
 * Pure function — no setState, no AsyncStorage. Easy to unit-test.
 */
export function reconcileCases(
  prev: LabCase[],
  serverCases: LabCase[]
): { next: LabCase[]; changed: boolean } {
  const serverById = new Map(serverCases.map((c) => [c.id, c]));
  const next: LabCase[] = [];
  let changed = false;

  for (const local of prev) {
    const server = serverById.get(local.id);
    if (server) {
      next.push(server);
      if (server !== local) changed = true;
      continue;
    }
    const localKey =
      typeof local.affiliationKey === "string"
        ? local.affiliationKey.trim()
        : "";
    if (localKey.startsWith("org:")) {
      changed = true;
      continue;
    }
    next.push(local);
  }

  for (const sc of serverCases) {
    if (!prev.some((c) => c.id === sc.id)) {
      next.push(sc);
      changed = true;
    }
  }

  return { next, changed };
}
