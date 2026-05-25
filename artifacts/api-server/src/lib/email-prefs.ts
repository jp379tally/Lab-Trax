import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { logger } from "./logger";

export const EMAIL_PREF_KEYS = [
  "caseNoteNotifications",
  "orgInviteNotifications",
  "statementEmails",
  "billingReminders",
  "installerAlerts",
  "backupAlerts",
  "cleanupAlerts",
] as const;

export type EmailPrefKey = (typeof EMAIL_PREF_KEYS)[number];

export const DEFAULT_EMAIL_PREFS: Record<EmailPrefKey, boolean> = {
  caseNoteNotifications: true,
  orgInviteNotifications: true,
  statementEmails: true,
  billingReminders: true,
  installerAlerts: true,
  backupAlerts: true,
  cleanupAlerts: true,
};

/**
 * Merge stored JSONB preferences with all-true defaults so missing keys
 * always resolve to ON (preserves previous send behaviour for existing users).
 */
export function mergeEmailPrefs(stored: unknown): Record<EmailPrefKey, boolean> {
  const result = { ...DEFAULT_EMAIL_PREFS };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of EMAIL_PREF_KEYS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "boolean") result[key] = v;
    }
  }
  return result;
}

/**
 * Look up a user by their email address and return whether the given
 * preference key is enabled. Returns `true` (send the email) when no
 * user is found with that address — the default behaviour for unregistered
 * recipients and for keys that have never been explicitly set.
 */
export async function checkEmailPref(
  email: string | null | undefined,
  key: EmailPrefKey
): Promise<boolean> {
  if (!email) return true;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { emailPreferences: true },
    });
    if (!user) return true;
    return mergeEmailPrefs(user.emailPreferences)[key];
  } catch (err: any) {
    logger.warn(
      { err: err?.message, email, key },
      "[email-prefs] Failed to load preference — defaulting to send"
    );
    return true;
  }
}

/**
 * Same as checkEmailPref but looks up by user id directly (faster when
 * the id is already known — e.g. billing jobs that iterate subscriptions).
 */
export async function checkEmailPrefById(
  userId: string | null | undefined,
  key: EmailPrefKey
): Promise<boolean> {
  if (!userId) return true;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { emailPreferences: true },
    });
    if (!user) return true;
    return mergeEmailPrefs(user.emailPreferences)[key];
  } catch (err: any) {
    logger.warn(
      { err: err?.message, userId, key },
      "[email-prefs] Failed to load preference — defaulting to send"
    );
    return true;
  }
}

/**
 * Given a list of email addresses, returns only those whose owner has the
 * given preference enabled. Performs a single batch query.
 * Fails open: if the query throws, returns the original list unchanged so
 * alerts are never silently swallowed by a DB hiccup.
 */
export async function filterEmailsByPref(
  emails: string[],
  key: EmailPrefKey
): Promise<string[]> {
  if (emails.length === 0) return [];
  try {
    const rows = await db
      .select({ email: users.email, emailPreferences: users.emailPreferences })
      .from(users)
      .where(inArray(users.email, emails));
    const prefMap = new Map<string, boolean>();
    for (const row of rows) {
      if (row.email) {
        prefMap.set(row.email, mergeEmailPrefs(row.emailPreferences)[key]);
      }
    }
    // Emails not found in the DB are treated as opted-in (fail-open).
    return emails.filter((email) => prefMap.get(email) !== false);
  } catch (err: any) {
    logger.warn(
      { err: err?.message, key, count: emails.length },
      "[email-prefs] filterEmailsByPref failed — defaulting to send all"
    );
    return emails;
  }
}
