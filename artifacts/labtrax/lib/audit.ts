import { resilientFetch, getAccessToken } from "./query-client";

export async function logAudit(action: string, user: string, resource?: string) {
  // Capture the in-memory token synchronously at the very start, before any
  // async gap. This closes the race where clearTokens() fires (during logout)
  // between the original dynamic import() and the actual resilientFetch call,
  // which caused /api/audit-log to be sent with no bearer token.
  // If there is no token at this point, skip silently — the event will not
  // have meaningful auth context anyway.
  const token = getAccessToken();
  if (!token) return;

  try {
    await resilientFetch("/api/audit-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user, resource: resource || "" }),
    });
  } catch {
    // Audit logging should not break app functionality
  }
}
