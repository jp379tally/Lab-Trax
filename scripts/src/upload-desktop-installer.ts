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
 * Usage:
 *   pnpm --filter @workspace/scripts run upload-desktop-installer
 *   pnpm --filter @workspace/scripts run upload-desktop-installer -- /path/to/zip
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";
import type { ExternalAccountClientOptions } from "google-auth-library";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const OBJECT_KEY_SUFFIX = "desktop-installer/LabTrax-Windows-Portable.zip";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCAL_PATH = resolve(
  __dirname,
  "../../artifacts/labtrax-desktop/electron-dist/LabTrax-Windows-Portable.zip",
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
}

main().catch((err) => {
  console.error("[upload-installer] Failed:", err);
  process.exit(2);
});
