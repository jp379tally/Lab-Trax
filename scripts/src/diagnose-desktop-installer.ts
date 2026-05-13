/**
 * Diagnoses the live desktop "Failed to fetch" failure modes from
 * outside the application, by exercising production HTTP endpoints the
 * desktop renderer relies on. This is the script form of the manual
 * diagnosis that produced task #408 — anyone can re-run it in seconds
 * to verify whether the production environment is healthy before
 * sending another "please reinstall" message to a user.
 *
 * Checks:
 *   1. CORS preflight on /api/auth/login from Origin: app://labtrax
 *      — confirms the deployed API allows the desktop's custom
 *      protocol origin (server-side fix from task #317).
 *   2. HEAD on each of the three installer slots
 *      (/downloads/LabTrax-Setup.exe,
 *       /downloads/LabTrax-Windows-Portable.zip,
 *       /downloads/LabTrax.dmg)
 *      — flags suspiciously small (<1 MB) or stale (>60 days old)
 *      artifacts. The May 2026 incident was a 64-byte stub at the EXE
 *      slot that this check would have caught immediately.
 *
 * Usage:
 *   PUBLISH_API_BASE_URL=https://your-app.replit.app \
 *     pnpm --filter @workspace/scripts run diagnose-desktop-installer
 *
 * Exit codes:
 *   0 — all checks healthy
 *   1 — invalid usage / missing env
 *   2 — at least one check produced a warning or error verdict
 */

const SUSPICIOUS_MIN_BYTES = 1024 * 1024; // 1 MB — anything smaller is almost certainly a stub
const STALE_AFTER_DAYS = 60;
const INSTALLER_PATHS = [
  "/downloads/LabTrax-Setup.exe",
  "/downloads/LabTrax-Windows-Portable.zip",
  "/downloads/LabTrax.dmg",
];

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ageDays(lastModified: string | null): number | null {
  if (!lastModified) return null;
  const ms = Date.parse(lastModified);
  if (!Number.isFinite(ms)) return null;
  return Math.round((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

let exitCode = 0;
function note(msg: string) {
  console.log(`  ${msg}`);
}
function ok(msg: string) {
  console.log(`  \u2713 ${msg}`);
}
function warn(msg: string) {
  console.log(`  ! ${msg}`);
  if (exitCode < 2) exitCode = 2;
}
function fail(msg: string) {
  console.log(`  X ${msg}`);
  exitCode = 2;
}

async function checkCorsPreflight(baseUrl: string) {
  const url = `${baseUrl}/api/auth/login`;
  console.log(`\n[1/2] CORS preflight from Origin: app://labtrax`);
  console.log(`      ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "app://labtrax",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    });
  } catch (err) {
    fail(`Preflight request failed at the network layer: ${(err as Error).message}`);
    return;
  }
  const allowOrigin = res.headers.get("access-control-allow-origin");
  const allowCreds = res.headers.get("access-control-allow-credentials");
  note(`HTTP ${res.status}`);
  note(`access-control-allow-origin: ${allowOrigin ?? "(missing)"}`);
  note(`access-control-allow-credentials: ${allowCreds ?? "(missing)"}`);
  const okStatus = res.status >= 200 && res.status < 300;
  const okOrigin = allowOrigin === "app://labtrax";
  // Desktop client sends credentials: "include" on the login POST; the
  // browser will reject the response unless the preflight echoes
  // Access-Control-Allow-Credentials: true. Treat anything else as a
  // real failure, not a warning.
  const okCreds = (allowCreds ?? "").toLowerCase() === "true";
  if (okStatus && okOrigin && okCreds) {
    ok("CORS allows app://labtrax with credentials — desktop can reach this API.");
  } else {
    if (!okStatus) {
      fail(`Preflight returned HTTP ${res.status} (expected 2xx).`);
    }
    if (!okOrigin) {
      fail(
        `CORS does NOT echo Origin app://labtrax (got ${allowOrigin ?? "missing"}). The deployed server is likely running an older build — redeploy the API server.`,
      );
    }
    if (!okCreds) {
      fail(
        `CORS preflight is missing Access-Control-Allow-Credentials: true (got ${allowCreds ?? "missing"}). The desktop login POST sends credentials and will be rejected by the browser without it.`,
      );
    }
  }
}

async function checkInstallerSlot(baseUrl: string, path: string) {
  const url = `${baseUrl}${path}`;
  console.log(`\n      HEAD ${url}`);
  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD", redirect: "follow" });
  } catch (err) {
    fail(`HEAD request failed at the network layer: ${(err as Error).message}`);
    return;
  }
  if (res.status === 404) {
    warn(
      `404 — slot is empty. An admin needs to upload via Settings -> Desktop App, or re-run the GitHub Actions release job.`,
    );
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    fail(`Unexpected HTTP ${res.status}.`);
    return;
  }
  const sizeHeader = res.headers.get("content-length");
  const lastModified = res.headers.get("last-modified");
  const size = sizeHeader ? Number.parseInt(sizeHeader, 10) : NaN;
  const days = ageDays(lastModified);
  note(`size: ${Number.isFinite(size) ? fmtSize(size) : "(unknown)"}`);
  note(`last-modified: ${lastModified ?? "(unknown)"} (${days === null ? "?" : `${days}d ago`})`);
  if (Number.isFinite(size) && size < SUSPICIOUS_MIN_BYTES) {
    fail(
      `Artifact is only ${fmtSize(size)} — almost certainly a stub. Delete it from App Storage and republish a real build.`,
    );
    return;
  }
  if (days !== null && days > STALE_AFTER_DAYS) {
    warn(`Artifact is ${days} days old (>${STALE_AFTER_DAYS}). Consider republishing.`);
    return;
  }
  ok("Looks healthy.");
}

async function main() {
  const baseRaw = process.env.PUBLISH_API_BASE_URL;
  if (!baseRaw) {
    console.error(
      "ERROR: PUBLISH_API_BASE_URL is not set. Example:\n" +
        "  PUBLISH_API_BASE_URL=https://your-app.replit.app \\\n" +
        "    pnpm --filter @workspace/scripts run diagnose-desktop-installer",
    );
    process.exit(1);
  }
  const base = baseRaw.replace(/\/$/, "");
  console.log(`Diagnosing LabTrax Desktop against ${base}`);

  await checkCorsPreflight(base);

  console.log(`\n[2/2] Installer slots`);
  for (const p of INSTALLER_PATHS) {
    await checkInstallerSlot(base, p);
  }

  console.log("");
  if (exitCode === 0) {
    console.log("All checks healthy.");
  } else {
    console.log("One or more checks reported a warning or failure (see above).");
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[diagnose-desktop-installer] Unexpected error:", err);
  process.exit(2);
});

export {};
