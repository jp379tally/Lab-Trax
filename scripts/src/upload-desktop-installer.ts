/**
 * Uploads a LabTrax desktop installer to App Storage so the API server can
 * serve it at the matching /downloads/ path.
 *
 * Supported installers:
 *   LabTrax-Setup.exe            → GET /downloads/LabTrax-Setup.exe  (NSIS, preferred)
 *   LabTrax-Windows-Portable.zip → GET /downloads/LabTrax-Windows-Portable.zip  (fallback)
 *   LabTrax.dmg                  → GET /downloads/LabTrax.dmg
 *
 * The installer kind is inferred from the file name. When no path is given,
 * the script looks for LabTrax-Setup.exe first; if not found it falls back to
 * LabTrax-Windows-Portable.zip (the legacy Replit-only build output).
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
 *   pnpm --filter @workspace/scripts run upload-desktop-installer -- /path/to/LabTrax-Setup.exe
 *   pnpm --filter @workspace/scripts run upload-desktop-installer -- /path/to/LabTrax-Windows-Portable.zip
 */

import { readFile, stat, access } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";
import { parseReleaseNotes } from "./lib/parse-release-notes.js";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const LATEST_YML_KEY_SUFFIX = "desktop-installer/latest.yml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIST = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/electron-dist",
);
const DEFAULT_EXE_PATH = resolve(ELECTRON_DIST, "LabTrax-Setup.exe");
const DEFAULT_ZIP_PATH = resolve(ELECTRON_DIST, "LabTrax-Windows-Portable.zip");
const DEFAULT_LATEST_YML_PATH = resolve(ELECTRON_DIST, "latest.yml");
const RELEASE_NOTES_PATH = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/RELEASE_NOTES.md",
);
const DESKTOP_PKG_PATH = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/package.json",
);

type InstallerKind = "exe" | "zip" | "dmg";

interface KindConfig {
  objectKeySuffix: string;
  contentType: string;
  downloadUrl: string;
  contentDisposition: string;
}

const KIND_CONFIG: Record<InstallerKind, KindConfig> = {
  exe: {
    objectKeySuffix: "desktop-installer/LabTrax-Setup.exe",
    contentType: "application/vnd.microsoft.portable-executable",
    downloadUrl: "/downloads/LabTrax-Setup.exe",
    contentDisposition: 'attachment; filename="LabTrax-Setup.exe"',
  },
  zip: {
    objectKeySuffix: "desktop-installer/LabTrax-Windows-Portable.zip",
    contentType: "application/zip",
    downloadUrl: "/downloads/LabTrax-Windows-Portable.zip",
    contentDisposition: 'attachment; filename="LabTrax-Windows-Portable.zip"',
  },
  dmg: {
    objectKeySuffix: "desktop-installer/LabTrax.dmg",
    contentType: "application/x-apple-diskimage",
    downloadUrl: "/downloads/LabTrax.dmg",
    contentDisposition: 'attachment; filename="LabTrax.dmg"',
  },
};

function kindFromFilename(name: string): InstallerKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".exe")) return "exe";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".dmg")) return "dmg";
  return null;
}

async function resolveLocalPath(): Promise<string> {
  // Ignore a bare "--" separator that pnpm may forward into argv
  // (e.g. `pnpm run upload-desktop-installer -- /path/to/file.zip`).
  const arg = process.argv.slice(2).find((a) => a !== "--");
  if (arg) return resolve(arg);

  // Auto-detect: prefer exe (NSIS installer), fall back to zip (portable).
  for (const p of [DEFAULT_EXE_PATH, DEFAULT_ZIP_PATH]) {
    try {
      await access(p);
      return p;
    } catch {
      /* not found — try next */
    }
  }
  console.error(
    "ERROR: No installer found.\n" +
    "  Expected one of:\n" +
    `    ${DEFAULT_EXE_PATH}\n` +
    `    ${DEFAULT_ZIP_PATH}\n` +
    "  Run the electron build first, or pass the path as an argument.",
  );
  process.exit(1);
}

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

  const localPath = await resolveLocalPath();
  const fileName = basename(localPath);
  const kind = kindFromFilename(fileName);
  if (!kind) {
    console.error(
      `ERROR: Cannot infer installer kind from filename "${fileName}".\n` +
      "  Expected LabTrax-Setup.exe, LabTrax-Windows-Portable.zip, or LabTrax.dmg.",
    );
    process.exit(1);
  }
  const cfg = KIND_CONFIG[kind];

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
  console.log(
    `[upload-installer] Reading ${localPath} (${sizeMb} MB) — kind: ${kind}`,
  );
  const buffer = await readFile(localPath);

  const fullPath = `${privateDir}/${cfg.objectKeySuffix}`;
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

  console.log(
    `[upload-installer] Uploading to gs://${bucketName}/${objectName}`,
  );
  const file = storage.bucket(bucketName).file(objectName);
  await file.save(buffer, {
    contentType: cfg.contentType,
    resumable: false,
    metadata: { contentDisposition: cfg.contentDisposition },
  });
  const [meta] = await file.getMetadata();
  console.log(
    `[upload-installer] ✓ Uploaded. Size=${meta.size}B updated=${meta.updated}`,
  );

  await uploadLatestYml(storage, privateDir);
  await pushInstallerMetadata(cfg.downloadUrl);
}

async function uploadLatestYml(
  storage: Storage,
  privateDir: string,
): Promise<void> {
  let ymlBuffer: Buffer;
  try {
    await access(DEFAULT_LATEST_YML_PATH);
    ymlBuffer = await readFile(DEFAULT_LATEST_YML_PATH);
  } catch {
    console.log(
      "[upload-installer] No latest.yml found at electron-dist/latest.yml — skipping auto-update manifest upload.",
    );
    return;
  }

  const fullPath = `${privateDir}/${LATEST_YML_KEY_SUFFIX}`;
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = trimmed.indexOf("/");
  const bucketName = trimmed.slice(0, slash);
  const objectName = trimmed.slice(slash + 1);

  console.log(
    `[upload-installer] Uploading latest.yml to gs://${bucketName}/${objectName}`,
  );
  const file = storage.bucket(bucketName).file(objectName);
  await file.save(ymlBuffer, {
    contentType: "application/yaml",
    resumable: false,
  });
  console.log(
    "[upload-installer] ✓ latest.yml uploaded (auto-update manifest).",
  );
}

async function pushInstallerMetadata(downloadUrl: string): Promise<void> {
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
    downloadUrl,
    version,
    releaseNotes: releaseNotes ?? null,
  };

  console.log(
    `[upload-installer] PUT ${apiBaseUrl}/api/admin/settings/desktop-installer` +
    ` (version=${version}, downloadUrl=${downloadUrl})`,
  );

  const res = await fetch(
    `${apiBaseUrl}/api/admin/settings/desktop-installer`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Platform-Admin-Secret": adminSecret,
      },
      body: JSON.stringify(payload),
    },
  );

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
