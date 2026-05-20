// Microsoft OneDrive integration via Replit connector proxy
// Uses the connected OneDrive account to upload files via Microsoft Graph API

let cachedSettings: any = null;
let cacheExpiresAt = 0;

async function getOneDriveAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedSettings && cacheExpiresAt > now + 60_000) {
    return cachedSettings.settings?.access_token || cachedSettings.settings?.oauth?.credentials?.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) throw new Error("OneDrive connector not available in this environment.");

  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) throw new Error("Replit identity token not found.");

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=onedrive`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
  );
  if (!resp.ok) throw new Error(`Connector fetch failed: ${resp.status}`);
  const data = await resp.json() as any;
  cachedSettings = data.items?.[0];

  if (!cachedSettings) throw new Error("OneDrive connection not found. Please reconnect.");

  const expiresAt = cachedSettings.settings?.expires_at;
  cacheExpiresAt = expiresAt ? new Date(expiresAt).getTime() : now + 3500_000;

  const token =
    cachedSettings.settings?.access_token ||
    cachedSettings.settings?.oauth?.credentials?.access_token;
  if (!token) throw new Error("OneDrive access token not available.");
  return token;
}

async function graphRequest(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<Response> {
  const accessToken = token || (await getOneDriveAccessToken());
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
}

export async function ensureOneDriveFolder(folderName: string): Promise<string> {
  const token = await getOneDriveAccessToken();
  const checkResp = await graphRequest(
    `/me/drive/root:/${encodeURIComponent(folderName)}`,
    { method: "GET" },
    token
  );
  if (checkResp.ok) {
    const item = await checkResp.json() as any;
    return item.id;
  }

  const createResp = await graphRequest(
    "/me/drive/root/children",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      }),
    },
    token
  );
  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`Could not create OneDrive folder: ${err}`);
  }
  const folder = await createResp.json() as any;
  return folder.id;
}

// Best-effort deletion of a file previously mirrored to OneDrive.
// Returns:
//   "deleted"   – the file existed and was removed
//   "missing"   – OneDrive responded 404 (already gone, treated as success)
//   "disabled"  – OneDrive is not configured in this environment
// Throws on any other error (network failure, auth failure, 5xx, etc.)
// so callers can decide whether to log and continue.
export async function deleteFromOneDrive(
  fileName: string,
  folderPath = "LabTrax Case Media"
): Promise<"deleted" | "missing" | "disabled"> {
  if (!process.env.REPLIT_CONNECTORS_HOSTNAME) return "disabled";
  const token = await getOneDriveAccessToken();
  const itemPath = `/${folderPath}/${fileName}`;
  const resp = await graphRequest(
    `/me/drive/root:${encodeURIComponent(itemPath).replace(/%2F/g, "/")}`,
    { method: "DELETE" },
    token
  );
  if (resp.status === 204 || resp.status === 200) return "deleted";
  if (resp.status === 404) return "missing";
  const err = await resp.text().catch(() => "");
  throw new Error(`OneDrive delete failed (${resp.status}): ${err}`);
}

/**
 * Upload a buffer to OneDrive using the Microsoft Graph API.
 *
 * @param fileBuffer   Data to upload.
 * @param fileName     Destination filename within the folder.
 * @param folderPath   Folder path relative to drive root (default: "LabTrax Backups").
 * @param conflictBehavior
 *   - "rename"  (default) – create a new file with a disambiguated name if one exists.
 *   - "replace" – silently overwrite the existing file; used for the rolling backup so
 *                 only one labtrax-rolling-backup.zip.enc ever exists on OneDrive.
 *   - "fail"    – return an error if a file with the same name already exists.
 */
/**
 * Cheap pre-flight check: validates the OneDrive access token is usable by
 * making a single lightweight GET /me/drive call (returns ~200 B of JSON).
 * Call this BEFORE building a large zip buffer so we don't waste memory and
 * CPU on a zip that will never be uploaded due to broken auth.
 * Throws with a descriptive message if the token is missing, malformed, or
 * rejected by Microsoft Graph.
 */
export async function checkOneDriveToken(): Promise<void> {
  const token = await getOneDriveAccessToken();
  const resp = await graphRequest("/me/drive", { method: "GET" }, token);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `OneDrive token validation failed (HTTP ${resp.status}): ${body.slice(0, 300)}`,
    );
  }
}

/**
 * Drop the in-memory connector-settings cache so the next OneDrive call
 * refetches credentials from the Replit connector proxy. Used after the
 * admin reconnects the OneDrive integration.
 */
export function clearOneDriveTokenCache(): void {
  cachedSettings = null;
  cacheExpiresAt = 0;
  cachedStatus = null;
  cachedStatusAt = 0;
}

export interface OneDriveStatus {
  connected: boolean;
  accountName?: string;
  accountEmail?: string;
  lastCheckedAt: string;
  error?: string;
}

let cachedStatus: OneDriveStatus | null = null;
let cachedStatusAt = 0;
const STATUS_CACHE_MS = 30_000;

/**
 * Returns the current OneDrive connection status. Caches results for ~30 s
 * to avoid hammering Microsoft Graph on every Backup-panel poll.
 *
 * Combines `checkOneDriveToken()` (validates the token via /me/drive) with a
 * lightweight `/me` Graph call to surface the signed-in account name/email.
 */
export async function getOneDriveStatus(
  options: { forceRefresh?: boolean } = {},
): Promise<OneDriveStatus> {
  const now = Date.now();
  if (!options.forceRefresh && cachedStatus && now - cachedStatusAt < STATUS_CACHE_MS) {
    return cachedStatus;
  }
  const lastCheckedAt = new Date().toISOString();
  try {
    if (!process.env.REPLIT_CONNECTORS_HOSTNAME) {
      const result: OneDriveStatus = {
        connected: false,
        lastCheckedAt,
        error: "OneDrive connector not available in this environment.",
      };
      cachedStatus = result;
      cachedStatusAt = now;
      return result;
    }
    const token = await getOneDriveAccessToken();
    const [driveResp, meResp] = await Promise.all([
      graphRequest("/me/drive", { method: "GET" }, token),
      graphRequest("/me", { method: "GET" }, token),
    ]);
    if (!driveResp.ok) {
      const body = await driveResp.text().catch(() => "");
      const result: OneDriveStatus = {
        connected: false,
        lastCheckedAt,
        error: `OneDrive token validation failed (HTTP ${driveResp.status}): ${body.slice(0, 200)}`,
      };
      cachedStatus = result;
      cachedStatusAt = now;
      return result;
    }
    let accountName: string | undefined;
    let accountEmail: string | undefined;
    if (meResp.ok) {
      const me = (await meResp.json().catch(() => ({}))) as any;
      accountName = me.displayName || undefined;
      accountEmail = me.mail || me.userPrincipalName || undefined;
    }
    const result: OneDriveStatus = {
      connected: true,
      accountName,
      accountEmail,
      lastCheckedAt,
    };
    cachedStatus = result;
    cachedStatusAt = now;
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const result: OneDriveStatus = {
      connected: false,
      lastCheckedAt,
      error: msg,
    };
    cachedStatus = result;
    cachedStatusAt = now;
    return result;
  }
}

export async function uploadToOneDrive(
  fileBuffer: Buffer,
  fileName: string,
  folderPath = "LabTrax Backups",
  conflictBehavior: "replace" | "rename" | "fail" = "rename"
): Promise<{ webUrl: string; name: string; size: number }> {
  const token = await getOneDriveAccessToken();
  const uploadPath = `/${folderPath}/${fileName}`;
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks

  if (fileBuffer.length <= 4 * 1024 * 1024) {
    // Simple upload for files ≤ 4 MB.
    // The Graph API PUT to /:path:/content always replaces an existing file by
    // default, so both conflict behaviours resolve to the same call here.
    const resp = await graphRequest(
      `/me/drive/root:${encodeURIComponent(uploadPath).replace(/%2F/g, "/")}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: fileBuffer,
      },
      token
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OneDrive upload failed: ${err}`);
    }
    const item = await resp.json() as any;
    return { webUrl: item.webUrl || "", name: item.name, size: item.size };
  }

  // Large file upload session — pass the desired conflict behaviour so
  // "replace" causes OneDrive to overwrite the previous rolling backup.
  const sessionResp = await graphRequest(
    `/me/drive/root:${encodeURIComponent(uploadPath).replace(/%2F/g, "/")}:/createUploadSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": conflictBehavior,
          name: fileName,
        },
      }),
    },
    token
  );
  if (!sessionResp.ok) {
    const err = await sessionResp.text();
    throw new Error(`Could not create OneDrive upload session: ${err}`);
  }
  const session = await sessionResp.json() as any;
  const uploadUrl: string = session.uploadUrl;
  if (!uploadUrl) throw new Error("No upload URL returned from OneDrive.");

  let offset = 0;
  let lastResponse: any = null;
  while (offset < fileBuffer.length) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
    const end = offset + chunk.length - 1;
    const chunkResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${offset}-${end}/${fileBuffer.length}`,
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    });
    if (!chunkResp.ok && chunkResp.status !== 202) {
      const err = await chunkResp.text();
      throw new Error(`OneDrive chunk upload failed at offset ${offset}: ${err}`);
    }
    lastResponse = await chunkResp.json().catch(() => ({}));
    offset += chunk.length;
  }

  return {
    webUrl: lastResponse?.webUrl || "",
    name: lastResponse?.name || fileName,
    size: lastResponse?.size || fileBuffer.length,
  };
}
