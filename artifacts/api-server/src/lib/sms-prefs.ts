import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { logger } from "./logger";

export const SMS_PREF_KEYS = [
  "accountLinkInvites",
  "caseNoteNotifications",
  "billingReminders",
] as const;

export type SmsPrefKey = (typeof SMS_PREF_KEYS)[number];

export const DEFAULT_SMS_PREFS: Record<SmsPrefKey, boolean> = {
  accountLinkInvites: true,
  caseNoteNotifications: true,
  billingReminders: true,
};

/**
 * Merge stored JSONB preferences with all-true defaults so missing keys
 * always resolve to ON (preserves previous send behaviour for existing users).
 */
export function mergeSmsPrefs(stored: unknown): Record<SmsPrefKey, boolean> {
  const result = { ...DEFAULT_SMS_PREFS };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of SMS_PREF_KEYS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "boolean") result[key] = v;
    }
  }
  return result;
}

/**
 * Look up a user by their id and return whether the given SMS preference
 * key is enabled. Returns `true` (send the SMS) when no user is found —
 * the default behaviour for unregistered recipients and keys never explicitly set.
 */
export async function checkSmsPrefById(
  userId: string | null | undefined,
  key: SmsPrefKey
): Promise<boolean> {
  if (!userId) return true;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { smsPreferences: true },
    });
    if (!user) return true;
    return mergeSmsPrefs(user.smsPreferences)[key];
  } catch (err: any) {
    logger.warn(
      { err: err?.message, userId, key },
      "[sms-prefs] Failed to load preference — defaulting to send"
    );
    return true;
  }
}

/**
 * Look up a user by their phone number and return whether the given SMS
 * preference key is enabled. Returns `true` when no matching user is found.
 */
export async function checkSmsPrefByPhone(
  phone: string | null | undefined,
  key: SmsPrefKey
): Promise<boolean> {
  if (!phone) return true;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.phone, phone),
      columns: { smsPreferences: true },
    });
    if (!user) return true;
    return mergeSmsPrefs(user.smsPreferences)[key];
  } catch (err: any) {
    logger.warn(
      { err: err?.message, key },
      "[sms-prefs] Failed to load preference by phone — defaulting to send"
    );
    return true;
  }
}

/**
 * Given a list of phone numbers, returns only those whose owner has the
 * given preference enabled. Performs a single batch query.
 * Fails open: if the query throws, returns the original list unchanged so
 * alerts are never silently swallowed by a DB hiccup.
 */
export async function filterPhonesByPref(
  phones: string[],
  key: SmsPrefKey
): Promise<string[]> {
  if (phones.length === 0) return [];
  try {
    const rows = await db
      .select({ phone: users.phone, smsPreferences: users.smsPreferences })
      .from(users)
      .where(inArray(users.phone, phones));
    const prefMap = new Map<string, boolean>();
    for (const row of rows) {
      if (row.phone) {
        prefMap.set(row.phone, mergeSmsPrefs(row.smsPreferences)[key]);
      }
    }
    // Phones not found in the DB are treated as opted-in (fail-open).
    return phones.filter((phone) => prefMap.get(phone) !== false);
  } catch (err: any) {
    logger.warn(
      { err: err?.message, key, count: phones.length },
      "[sms-prefs] filterPhonesByPref failed — defaulting to send all"
    );
    return phones;
  }
}
