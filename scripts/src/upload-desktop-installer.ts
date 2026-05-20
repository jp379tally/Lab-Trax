/**
 * Uploads a local LabTrax-Windows-Portable.zip to App Storage so the API
 * server can serve it at GET /downloads/LabTrax-Windows-Portable.zip in
 * production. Use this once after each new electron build, or as a fallback
 * for the admin UI upload endpoint.
 *
 * Required environment variables (auto-set after running setupObjectStorage):
 *   DEFAULT_OBJECT_STORAGE_BUCKET_ID
 *   PRIVATE_OBJECT_DIR
 *
 * Optional (needed to also push version + release notes to the download page):
 *   PUBLISH_API_BASE_URL  — e.g. https://your-app.replit.app
 *   PLATFORM_ADMIN_SECRET — must match the server's PLATFORM_ADMIN_SECRET
 *   DESKTOP_INSTALLER_VERSION — overrides the version from package.json
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run upload-desktop-installer
 *   pnpm --filter @workspace/scripts run upload-desktop-installer -- /path/to/zip
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";
import { parseReleaseNotes } from "./lib/parse-release-notes.js";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const OBJECT_KEY_SUFFIX = "desktop-installer/LabTrax-Windows-Portable.zip";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCAL_PATH = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/electron-dist/LabTrax-Windows-Portable.zip",
);
const RELEASE_NOTES_PATH = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/RELEASE_NOTES.md",
);
const DESKTOP_PKG_PATH = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/package.json",
);

async function main() {
  const privateDirRaw = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDirRaw) {
    console.error(
      "ERROR: PRIVATE_OBJECT_DIR is not set. Provision App Storage first.",
    );
    process.exit(1);
  }
  const privateDir = privateDirRaw.endsWith("/")
    ? privateDirRaw.slice(0, -1)
    : privateDirRaw;

  const localPath = resolve(process.argv[2] || DEFAULT_LOCAL_PATH);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(localPath);
  } catch {
    console.error(`ERROR: file not found: ${localPath}`);
    process.exit(1);
  }
  if (!st.isFile()) {
    console.error(`ERROR: not a regular file: ${localPath}`);
    process.exit(1);
  }
  const sizeMb = (st.size / 1024 / 1024).toFixed(1);
  console.log(`[upload-installer] Reading ${localPath} (${sizeMb} MB)`);
  const buffer = await readFile(localPath);

  const fullPath = `${privateDir}/${OBJECT_KEY_SUFFIX}`;
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = trimmed.indexOf("/");
  const bucketName = trimmed.slice(0, slash);
  const objectName = trimmed.slice(slash + 1);

  const credentials: ExternalAccountClientOptions = {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  };
  const storage = new Storage({ credentials, projectId: "" });

  console.log(`[upload-installer] Uploading to gs://${bucketName}/${objectName}`);
  const file = storage.bucket(bucketName).file(objectName);
  await file.save(buffer, {
    contentType: "application/zip",
    resumable: false,
    metadata: {
      contentDisposition: 'attachment; filename="LabTrax-Windows-Portable.zip"',
    },
  });
  const [meta] = await file.getMetadata();
  console.log(
    `[upload-installer] ✓ Uploaded. Size=${meta.size}B updated=${meta.updated}`,
  );

  await pushInstallerMetadata();
}

async function pushInstallerMetadata(): Promise<void> {
  const apiBaseUrl = process.env.PUBLISH_API_BASE_URL?.replace(/\/$/, "");
  const adminSecret = process.env.PLATFORM_ADMIN_SECRET;

  if (!apiBaseUrl || !adminSecret) {
    console.log(
      "[upload-installer] Skipping metadata push — PUBLISH_API_BASE_URL or PLATFORM_ADMIN_SECRET not set.",
    );
    return;
  }

  const version = await resolveVersion();
  const releaseNotes = await parseReleaseNotes(RELEASE_NOTES_PATH, version);

  if (releaseNotes) {
    console.log(
      `[upload-installer] Found release notes for v${version} in RELEASE_NOTES.md`,
    );
  } else {
    console.log(
      `[upload-installer] No release notes found for v${version} in RELEASE_NOTES.md — sending without notes.`,
    );
  }

  const payload: Record<string, string | null> = {
    downloadUrl: "/downloads/LabTrax-Windows-Portable.zip",
    version,
    releaseNotes: releaseNotes ?? null,
  };

  console.log(
    `[upload-installer] PUT ${apiBaseUrl}/api/admin/settings/desktop-installer (version=${version})`,
  );

  const res = await fetch(`${apiBaseUrl}/api/admin/settings/desktop-installer`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Platform-Admin-Secret": adminSecret,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(
      `[upload-installer] ✗ Metadata push failed (HTTP ${res.status}): ${body}`,
    );
    return;
  }

  console.log(
    `[upload-installer] ✓ Metadata pushed — v${version}${releaseNotes ? " with release notes" : ""}.`,
  );
}

async function resolveVersion(): Promise<string> {
  const envVersion = process.env.DESKTOP_INSTALLER_VERSION?.trim();
  if (envVersion) return envVersion;
  try {
    const raw = await readFile(DESKTOP_PKG_PATH, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }
  return "1.0.0";
}

main().catch((err) => {
  console.error("[upload-installer] Failed:", err);
  process.exit(2);
});
