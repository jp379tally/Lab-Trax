import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  notifications,
  organizationMemberships,
  organizations,
  systemSettings,
} from "@workspace/db";
import { db } from "@workspace/db";

export const IN_APP_NOTIFICATION_PREFERENCE_KEYS = [
  "inAppNewCase",
  "inAppTeammateMessage",
  "inAppDoctorPracticeMessage",
  "inAppExceptionCase",
  "inAppRushCase",
] as const;

export type InAppNotificationPreferenceKey =
  (typeof IN_APP_NOTIFICATION_PREFERENCE_KEYS)[number];

export type InAppNotificationCategory =
  | "new_case"
  | "teammate_message"
  | "doctor_practice_message"
  | "exception_case"
  | "rush_case";

const preferenceKeyForCategory: Record<
  InAppNotificationCategory,
  InAppNotificationPreferenceKey
> = {
  new_case: "inAppNewCase",
  teammate_message: "inAppTeammateMessage",
  doctor_practice_message: "inAppDoctorPracticeMessage",
  exception_case: "inAppExceptionCase",
  rush_case: "inAppRushCase",
};

export const DEFAULT_IN_APP_NOTIFICATION_PREFERENCES: Record<
  InAppNotificationPreferenceKey,
  boolean
> = {
  inAppNewCase: true,
  inAppTeammateMessage: true,
  inAppDoctorPracticeMessage: true,
  inAppExceptionCase: true,
  inAppRushCase: true,
};

export function isInAppNotificationPreferenceKey(
  key: string,
): key is InAppNotificationPreferenceKey {
  return (IN_APP_NOTIFICATION_PREFERENCE_KEYS as readonly string[]).includes(key);
}

export function parseNotificationPreferenceValue(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function mergeInAppNotificationPreferences(
  raw: Record<string, unknown>,
): Record<InAppNotificationPreferenceKey, boolean> {
  const merged = { ...DEFAULT_IN_APP_NOTIFICATION_PREFERENCES };
  for (const key of IN_APP_NOTIFICATION_PREFERENCE_KEYS) {
    if (typeof raw[key] === "boolean") merged[key] = raw[key] as boolean;
  }
  return merged;
}

export function isInAppNotificationEnabled(
  raw: Record<string, unknown>,
  category: InAppNotificationCategory,
): boolean {
  const preferenceKey = preferenceKeyForCategory[category];
  // Missing, malformed, or old records preserve the historical behavior:
  // operational bell alerts are delivered unless explicitly disabled.
  return raw[preferenceKey] !== false;
}

export function selectInAppNotificationRecipientIds(
  eligibleRecipients: readonly { userId: string }[],
  preferenceRows: readonly { key: string; value: string | null }[],
  category: InAppNotificationCategory,
): string[] {
  const preferencesByUserId = new Map(
    preferenceRows.map((row) => [
      row.key.replace(/^notif_prefs:/, ""),
      parseNotificationPreferenceValue(row.value),
    ]),
  );

  return [...new Set(eligibleRecipients.map((recipient) => recipient.userId))].filter(
    (userId) =>
      isInAppNotificationEnabled(
        preferencesByUserId.get(userId) ?? {},
        category,
      ),
  );
}

export async function hasActiveOwnerOrAdminLabMembership(
  userId: string,
): Promise<boolean> {
  const membership = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMemberships.labId),
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
        inArray(organizationMemberships.role, ["owner", "admin"]),
        inArray(organizations.type, ["lab", "dental_lab"]),
      ),
    )
    .limit(1);
  return membership.length > 0;
}

export interface DeliverInAppNotificationInput {
  labOrganizationId: string;
  recipientUserIds?: readonly string[];
  category: InAppNotificationCategory;
  type: string;
  title: string;
  body: string;
  dataJson?: Record<string, unknown>;
  /** Stable event identity; the recipient id is appended before insertion. */
  dedupeKey?: string;
}

/**
 * Delivers an operational bell notification only to active owner/admin members
 * of the owning lab who have not opted out of its category. This must never
 * throw into the case, message, upload, or exception operation that triggered it.
 */
export async function deliverInAppNotification(
  input: DeliverInAppNotificationInput,
  options: {
    executor?: Pick<typeof db, "select" | "insert">;
    /** Outbox workers must roll back and retry lookup/insert failures. */
    retryable?: boolean;
  } = {},
): Promise<void> {
  const executor = options.executor ?? db;
  let eligibleRecipients: Array<{ userId: string }>;
  try {
    const candidateIds = [
      ...new Set((input.recipientUserIds ?? []).filter(Boolean)),
    ];
    if (input.recipientUserIds && candidateIds.length === 0) return;

    const membershipFilters = [
      eq(organizationMemberships.labId, input.labOrganizationId),
      eq(organizationMemberships.status, "active"),
      isNull(organizationMemberships.deletedAt),
      inArray(organizationMemberships.role, ["owner", "admin"]),
    ];
    if (candidateIds.length > 0) {
      membershipFilters.push(inArray(organizationMemberships.userId, candidateIds));
    }

    eligibleRecipients = await executor
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(and(...membershipFilters));
    if (eligibleRecipients.length === 0) return;

  } catch (err) {
    if (options.retryable) throw err;
    // If the membership lookup is unavailable, we cannot safely determine the
    // owning lab's eligible recipients. Never fail the business operation.
    return;
  }

  let preferenceRows: Array<{ key: string; value: string | null }> = [];
  try {
    preferenceRows = await executor
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(
        inArray(
          systemSettings.key,
          eligibleRecipients.map((recipient) => `notif_prefs:${recipient.userId}`),
        ),
      );
  } catch (err) {
    if (options.retryable) throw err;
    // Preference read outages fail open: every authorized recipient retains
    // the historical default of receiving the operational alert.
    preferenceRows = [];
  }

  try {
    const recipientIds = selectInAppNotificationRecipientIds(
      eligibleRecipients,
      preferenceRows,
      input.category,
    );
    if (recipientIds.length === 0) return;

    const insert = executor.insert(notifications).values(
      recipientIds.map((userId) => ({
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${userId}` : null,
        dataJson: {
          ...input.dataJson,
          inAppCategory: input.category,
          labOrganizationId: input.labOrganizationId,
        },
      })),
    );
    if (input.dedupeKey) {
      await insert.onConflictDoNothing({ target: notifications.dedupeKey });
    } else {
      await insert;
    }
  } catch (err) {
    if (options.retryable) throw err;
    // Insert failures are deliberately best-effort and never fail the
    // case, message, upload, or exception operation that triggered them.
  }
}