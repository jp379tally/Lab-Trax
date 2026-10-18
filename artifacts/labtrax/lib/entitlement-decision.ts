import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * This acknowledgement is intentionally scoped to both the authenticated user
 * and the server entitlement subject. A different account (or a newly-created
 * subscription) must never inherit a previous user's decision.
 */
export const ENTITLEMENT_DECISION_PREFIX = "@labtrax/entitlement-decision/v1";

export function entitlementDecisionKey(userId: string, subject: string): string {
  return `${ENTITLEMENT_DECISION_PREFIX}/${encodeURIComponent(userId)}/${encodeURIComponent(subject)}`;
}

export async function hasDeclinedReadOnly(
  userId: string,
  subject: string,
): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(entitlementDecisionKey(userId, subject))) === "declined";
  } catch {
    return false;
  }
}

export async function declineToReadOnly(userId: string, subject: string): Promise<void> {
  await AsyncStorage.setItem(entitlementDecisionKey(userId, subject), "declined");
}