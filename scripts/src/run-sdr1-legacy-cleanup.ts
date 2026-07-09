/**
 * One-shot runner for POST /api/admin/cleanup/sdr1-legacy-open-invoices.
 *
 * Reads the platform-admin secret from the environment (never printed) and
 * calls the cleanup endpoint on the target server. Defaults to a dry run;
 * a live run requires CLEANUP_MODE=live, which sends the confirm phrase.
 *
 * Env:
 *   CLEANUP_TARGET_URL — base URL (default: http://localhost:80)
 *   CLEANUP_MODE       — "dry" (default) or "live"
 *   CLEANUP_ORG_ID     — REQUIRED lab organization id (SDR1 in production)
 */
export {};

const baseUrl = (process.env.CLEANUP_TARGET_URL || "http://localhost:80").replace(/\/+$/, "");
const mode = process.env.CLEANUP_MODE === "live" ? "live" : "dry";
const orgId = process.env.CLEANUP_ORG_ID?.trim() || null;

async function main() {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (!secret) {
    console.error("[sdr1-cleanup] PLATFORM_ADMIN_SECRET is not set in this environment.");
    process.exit(2);
  }
  if (!orgId) {
    console.error("[sdr1-cleanup] CLEANUP_ORG_ID is required (SDR1 lab organization id).");
    process.exit(2);
  }

  const body: Record<string, unknown> = { organizationId: orgId };
  if (mode === "live") {
    body.dryRun = false;
    body.confirm = "DELETE_SDR1_LEGACY_OPEN_INVOICES";
  }

  const url = `${baseUrl}/api/admin/cleanup/sdr1-legacy-open-invoices`;
  console.log(`[sdr1-cleanup] mode=${mode} target=${url} org=${orgId}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platform-Admin-Secret": secret,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log(`[sdr1-cleanup] HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 4000));
  }
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[sdr1-cleanup] request failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
