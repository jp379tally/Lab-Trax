/**
 * One-shot runner for POST /api/admin/cleanup/pre-cutoff-cases.
 *
 * Reads the platform-admin secret from the environment (never printed) and
 * calls the cleanup endpoint on the target server.
 *
 * Env:
 *   CLEANUP_TARGET_URL — base URL (default: http://localhost:80)
 *   CLEANUP_MODE       — "dry" (default) or "live"
 *   CLEANUP_ORG_ID     — optional lab organization id scope
 */
export {};

const baseUrl = (process.env.CLEANUP_TARGET_URL || "http://localhost:80").replace(/\/+$/, "");
const mode = process.env.CLEANUP_MODE === "live" ? "live" : "dry";
const orgId = process.env.CLEANUP_ORG_ID?.trim() || null;

async function main() {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (!secret) {
    console.error("[cleanup] PLATFORM_ADMIN_SECRET is not set in this environment.");
    process.exit(2);
  }

  const body: Record<string, unknown> = {};
  if (orgId) body.organizationId = orgId;
  if (mode === "live") {
    body.dryRun = false;
    body.confirm = "DELETE_PRE_JUNE_2026";
  }

  const url = `${baseUrl}/api/admin/cleanup/pre-cutoff-cases`;
  console.log(`[cleanup] mode=${mode} target=${url} orgScope=${orgId ?? "(none)"}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platform-Admin-Secret": secret,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log(`[cleanup] HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 2000));
  }
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[cleanup] request failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
