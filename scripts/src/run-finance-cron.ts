/**
 * Calls the internal finance cron endpoint to generate projected entries
 * from active recurring rules across all lab organizations.
 *
 * Intended to be wired up as a Replit Scheduled Deployment running on the
 * 1st of each month. Required environment variables:
 *   FINANCE_JOB_TOKEN   shared secret matching the API server's value
 *   FINANCE_API_URL     base URL of the API (e.g. https://your.replit.app/api)
 */

const url = process.env.FINANCE_API_URL || "http://localhost:80/api";
const token = process.env.FINANCE_JOB_TOKEN;

if (!token) {
  console.error("FINANCE_JOB_TOKEN is required.");
  process.exit(1);
}

const endpoint = `${url.replace(/\/$/, "")}/finance/jobs/run-all`;

(async () => {
  const started = Date.now();
  console.log(`[finance-cron] POST ${endpoint}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-finance-job-token": token,
    },
    body: "{}",
  });
  const text = await res.text();
  console.log(`[finance-cron] HTTP ${res.status} in ${Date.now() - started}ms`);
  console.log(text);
  if (!res.ok) process.exit(2);
})();
