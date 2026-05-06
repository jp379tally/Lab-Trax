/**
 * Calls the API server's orphaned case-media cleanup endpoint to remove files
 * under `uploads/case-media/` that are no longer referenced by any
 * `case_attachments.storageKey` row.
 *
 * Intended to be wired up as a scheduled deployment (e.g. nightly). Required
 * environment variables:
 *   MEDIA_CLEANUP_JOB_TOKEN   shared secret matching the API server's value
 *   MEDIA_CLEANUP_API_URL     base URL of the API (e.g. https://your.replit.app/api)
 *
 * Optional:
 *   MEDIA_CLEANUP_DRY_RUN     set to "true" to report orphans without deleting
 *                             (default: false — actually delete)
 *   MEDIA_CLEANUP_INCLUDE_ALL set to "true" to return the full orphan filename
 *                             list in the response (default: just a sample)
 */

export {};

const url = process.env.MEDIA_CLEANUP_API_URL || "http://localhost:80/api";
const token = process.env.MEDIA_CLEANUP_JOB_TOKEN;
const dryRun =
  (process.env.MEDIA_CLEANUP_DRY_RUN || "").toLowerCase() === "true";
const includeAll =
  (process.env.MEDIA_CLEANUP_INCLUDE_ALL || "").toLowerCase() === "true";

if (!token) {
  console.error("MEDIA_CLEANUP_JOB_TOKEN is required.");
  process.exit(1);
}

const endpoint = `${url.replace(/\/$/, "")}/admin/cleanup/orphaned-media?dryRun=${dryRun}&includeAll=${includeAll}`;

(async () => {
  const started = Date.now();
  console.log(`[media-cleanup] POST ${endpoint}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-media-cleanup-job-token": token,
    },
    body: "{}",
  });
  const text = await res.text();
  console.log(
    `[media-cleanup] HTTP ${res.status} in ${Date.now() - started}ms`,
  );
  console.log(text);
  if (!res.ok) process.exit(2);
})();
