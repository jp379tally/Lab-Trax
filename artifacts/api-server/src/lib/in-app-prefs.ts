import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { logger } from "./logger";

/**
 * Per-user preferences for LabTrax's in-app (bell) notifications. This is the
 * in-app counterpart to email-prefs.ts / sms-prefs.ts — same JSONB-on-users
 * pattern, checked before inserting a `notifications` row rather than before
 * sending an email or SMS.
 */
export const IN_APP_PREF_KEYS = ["caseNoteNotifications"] as const;

export type InAppPrefKey = (typeof IN_APP_PREF_KEYS)[number];

export const DEFAULT_IN_APP_PREFS: Record<InAppPrefKey, boolean> = {
  caseNoteNotifications: true,
};

/**
 * Merge stored JSONB preferences with all-true defaults so missing keys
 * always resolve to ON (preserves previous send behaviour for existing users).
 */
export function mergeInAppPrefs(stored: unknown): Record<InAppPrefKey, boolean> {
  const result = { ...DEFAULT_IN_APP_PREFS };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of IN_APP_PREF_KEYS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "boolean") result[key] = v;
    }
  }
  return result;
}

/**
 * Look up a user by their id and return whether the given in-app preference
 * key is enabled. Returns `true` (deliver the notification) when no user is
 * found — the default behaviour for keys that have never been explicitly set.
 */
export async function checkInAppPrefById(
  userId: string | null | undefined,
  key: InAppPrefKey
): Promise<boolean> {
  if (!userId) return true;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { inAppPreferences: true },
    });
    if (!user) return true;
    return mergeInAppPrefs(user.inAppPreferences)[key];
  } catch (err: any) {
    logger.warn(
      { err: err?.message, userId, key },
      "[in-app-prefs] Failed to load preference — defaulting to send"
    );
    return true;
  }
}

/**
 * Given a list of user ids, returns only those whose owner has the given
 * in-app preference enabled. Performs a single batch query.
 * Fails open: if the query throws, returns the original list unchanged so
 * bell notifications are never silently swallowed by a DB hiccup.
 */
export async function filterUserIdsByInAppPref(
  userIds: string[],
  key: InAppPrefKey
): Promise<string[]> {
  if (userIds.length === 0) return [];
  try {
    const rows = await db
      .select({ id: users.id, inAppPreferences: users.inAppPreferences })
      .from(users)
      .where(inArray(users.id, userIds));
    const prefMap = new Map<string, boolean>();
    for (const row of rows) {
      prefMap.set(row.id, mergeInAppPrefs(row.inAppPreferences)[key]);
    }
    // Ids not found in the DB are treated as opted-in (fail-open).
    return userIds.filter((id) => prefMap.get(id) !== false);
  } catch (err: any) {
    logger.warn(
      { err: err?.message, key, count: userIds.length },
      "[in-app-prefs] filterUserIdsByInAppPref failed — defaulting to send all"
    );
    return userIds;
  }
}
