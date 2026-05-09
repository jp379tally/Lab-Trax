/**
 * Integration test for the CI publish-failure alert path.
 *
 * Simulates a failed GitHub Actions auto-publish run by POSTing a sample
 * payload to /api/admin/desktop-installer/publish-failure with the same
 * X-Platform-Admin-Secret header CI uses. The endpoint loads the platform
 * admin recipient list and dispatches the alert email; on success it
 * responds with `{ success: true, recipients: <count> }`.
 *
 * Usage:
 *   PLATFORM_ADMIN_SECRET=... PUBLISH_API_BASE_URL=https://your.replit.app \
 *     pnpm --filter @workspace/scripts run test-publish-failure-alert
 *
 * Optional overrides:
 *   STAGE=upload|settings|unknown   (default: settings)
 *   HTTP_STATUS=503                  (omitted by default)
 *   VERSION=9.9.9-test               (default: 0.0.0-test)
 */

async function main() {
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  const baseRaw = process.env.PUBLISH_API_BASE_URL;
  if (!secret || !baseRaw) {
    console.error(
      "ERROR: PLATFORM_ADMIN_SECRET and PUBLISH_API_BASE_URL must both be set.",
    );
    process.exit(1);
  }
  const baseUrl = baseRaw.replace(/\/+$/, "");
  const stage = (process.env.STAGE || "settings").toLowerCase();
  const httpStatusRaw = process.env.HTTP_STATUS;
  const httpStatus = httpStatusRaw ? Number(httpStatusRaw) : undefined;
  const version = process.env.VERSION || "0.0.0-test";

  const payload: Record<string, unknown> = {
    workflowName: "Test: simulated CI publish-failure",
    runUrl:
      "https://github.com/example/repo/actions/runs/0000000000",
    runId: "0000000000",
    commitSha: "0000000000000000000000000000000000000000",
    ref: "test-ref",
    version,
    stage,
    errorMessage:
      "Simulated failure injected by scripts/src/test-publish-failure-alert.ts. " +
      "If you received this email, the CI alert path works end-to-end.",
  };
  if (httpStatus !== undefined && Number.isFinite(httpStatus)) {
    payload.httpStatus = httpStatus;
  }

  const url = `${baseUrl}/api/admin/desktop-installer/publish-failure`;
  console.log(`[test-publish-failure-alert] POST ${url}`);
  console.log(`[test-publish-failure-alert] payload:`, JSON.stringify(payload));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platform-Admin-Secret": secret,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`[test-publish-failure-alert] HTTP ${res.status}`);
  console.log(text);
  if (!res.ok) {
    process.exit(2);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // ignore
  }
  if (!parsed?.success) {
    console.error("[test-publish-failure-alert] Response did not include success:true");
    process.exit(3);
  }
  console.log(
    `[test-publish-failure-alert] OK — alert dispatched to ${parsed.recipients ?? "?"} recipient(s).`,
  );
}

main().catch((err) => {
  console.error("[test-publish-failure-alert] Failed:", err);
  process.exit(2);
});
