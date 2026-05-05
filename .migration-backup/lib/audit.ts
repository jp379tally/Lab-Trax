import { getApiUrl } from "./query-client";

export async function logAudit(action: string, user: string, resource?: string) {
  try {
    const apiUrl = getApiUrl();
    const { resilientFetch } = await import("./query-client");
    await resilientFetch("/api/audit-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user, resource: resource || "" }),
    });
  } catch {
    // Audit logging should not break app functionality
  }
}
