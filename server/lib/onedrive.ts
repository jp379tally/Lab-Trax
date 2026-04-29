// Microsoft OneDrive integration via the Replit connector proxy.
// Uses the connected OneDrive account to upload files via Microsoft Graph API.

let cachedSettings: any = null;
let cacheExpiresAt = 0;

async function getOneDriveAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedSettings && cacheExpiresAt > now + 60_000) {
    return (
      cachedSettings.settings?.access_token ||
      cachedSettings.settings?.oauth?.credentials?.access_token
    );
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error("OneDrive connector not available in this environment.");
  }

  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;

  if (!xReplitToken) {
    throw new Error("Replit identity token not found.");
  }

  const response = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=onedrive`,
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Connector fetch failed: ${response.status}`);
  }

  const data = await response.json();
  cachedSettings = data.items?.[0];
  if (!cachedSettings) {
    throw new Error("OneDrive connection not found. Please reconnect.");
  }

  const expiresAt = cachedSettings.settings?.expires_at;
  cacheExpiresAt = expiresAt ? new Date(expiresAt).getTime() : now + 3_500_000;

  const token =
    cachedSettings.settings?.access_token ||
    cachedSettings.settings?.oauth?.credentials?.access_token;
  if (!token) {
    throw new Error("OneDrive access token not available.");
  }

  return token;
}

async function graphRequest(
  requestPath: string,
  options: RequestInit = {},
  token?: string,
): Promise<Response> {
  const accessToken = token || (await getOneDriveAccessToken());

  return fetch(`https://graph.microsoft.com/v1.0${requestPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
}

export async function ensureOneDriveFolder(folderName: string): Promise<string> {
  const token = await getOneDriveAccessToken();
  const checkResponse = await graphRequest(
    `/me/drive/root:/${encodeURIComponent(folderName)}`,
    { method: "GET" },
    token,
  );

  if (checkResponse.ok) {
    const item = await checkResponse.json();
    return item.id;
  }

  const createResponse = await graphRequest(
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
    token,
  );
  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Could not create OneDrive folder: ${errorText}`);
  }

  const folder = await createResponse.json();
  return folder.id;
}

export async function uploadToOneDrive(
  fileBuffer: Buffer,
  fileName: string,
  folderPath = "LabTrax Backups",
): Promise<{ webUrl: string; name: string; size: number }> {
  const token = await getOneDriveAccessToken();
  const uploadPath = `/${folderPath}/${fileName}`;
  const chunkSize = 5 * 1024 * 1024;

  if (fileBuffer.length <= 4 * 1024 * 1024) {
    const response = await graphRequest(
      `/me/drive/root:${encodeURIComponent(uploadPath).replace(/%2F/g, "/")}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: fileBuffer,
      },
      token,
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OneDrive upload failed: ${errorText}`);
    }

    const item = await response.json();
    return {
      webUrl: item.webUrl || "",
      name: item.name,
      size: item.size,
    };
  }

  const sessionResponse = await graphRequest(
    `/me/drive/root:${encodeURIComponent(uploadPath).replace(/%2F/g, "/")}:/createUploadSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "rename",
          name: fileName,
        },
      }),
    },
    token,
  );
  if (!sessionResponse.ok) {
    const errorText = await sessionResponse.text();
    throw new Error(`Could not create OneDrive upload session: ${errorText}`);
  }

  const session = await sessionResponse.json();
  const uploadUrl: string = session.uploadUrl;
  if (!uploadUrl) {
    throw new Error("No upload URL returned from OneDrive.");
  }

  let offset = 0;
  let lastResponse: any = null;

  while (offset < fileBuffer.length) {
    const chunk = fileBuffer.slice(offset, offset + chunkSize);
    const end = offset + chunk.length - 1;
    const chunkResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${offset}-${end}/${fileBuffer.length}`,
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    });

    if (!chunkResponse.ok && chunkResponse.status !== 202) {
      const errorText = await chunkResponse.text();
      throw new Error(
        `OneDrive chunk upload failed at offset ${offset}: ${errorText}`,
      );
    }

    lastResponse = await chunkResponse.json().catch(() => ({}));
    offset += chunk.length;
  }

  return {
    webUrl: lastResponse?.webUrl || "",
    name: lastResponse?.name || fileName,
    size: lastResponse?.size || fileBuffer.length,
  };
}
