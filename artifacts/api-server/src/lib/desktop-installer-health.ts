/**
 * End-to-end health check for the desktop installer publish pipeline.
 *
 * Runs three probes in parallel and returns a single JSON report:
 *
 *   1. settings       — the configured download URL / version / activeKind
 *   2. storage        — whether the configured installer object exists in App Storage
 *   3. download       — HEAD against the live /downloads/... URL (catches misconfigured
 *                       reverse proxies and stale CDN copies)
 *   4. downloadSpeed  — GETs the first 1 MB of the live download URL, measures
 *                       throughput, and estimates total transfer time; warns if the
 *                       estimate exceeds DOWNLOAD_SPEED_WARN_SECONDS (default 300 s)
 *                       so admins know the connection may time out through the proxy.
 *   5. githubRelease  — fetches the latest release manifest from GitHub Releases so
 *                       admins know if the auto-updater feed is in sync with the
 *                       live download page.
 *   6. updateFeeds    — checks the API's Windows and macOS manifests and verifies
 *                       their referenced payloads are still available.
 *
 * See docs/desktop-publish-pipeline.md for the wider pipeline context.
 */
import { db, systemSettings } from "@workspace/db";
import { formatNumericDateTime } from "./date-format";
import { inArray } from "drizzle-orm";
import { getDownloadInterruptionStats, type DownloadInterruptionStats } from "./download-interruptions.js";
import {
  getDesktopInstallerHandle,
  getDesktopInstallerMetadata,
  getDesktopUpdatePayloadHandle,
  installerKindFromUrl,
  readUpdateManifest,
  type DesktopInstallerKind,
} from "./desktop-installer-storage.js";
import { validateDesktopUpdateFeed } from "./desktop-update-feed.js";

const ALL_INSTALLER_KINDS: DesktopInstallerKind[] = ["zip", "exe", "dmg"];

export interface InstallerSlotStatus {
  ok: boolean;
  size: number | null;
  uploadedAt: string | null;
  error: string | null;
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  settings: {
    version: string | null;
    downloadUrl: string | null;
    activeKind: DesktopInstallerKind | null;
    error: string | null;
  };
  storage: {
    ok: boolean;
    size: number | null;
    uploadedAt: string | null;
    etag: string | null;
    error: string | null;
  };
  /** Per-slot availability for all three installer kinds. */
  storageSlots: Record<DesktopInstallerKind, InstallerSlotStatus>;
  download: {
    ok: boolean;
    checked: boolean;
    url: string | null;
    status: number | null;
    contentLength: number | null;
    etag: string | null;
    etagMatchesStorage: boolean | null;
    error: string | null;
  };
  /**
   * Speed probe: GETs the first 1 MB of the live download URL, measures
   * throughput, and estimates total transfer time. Only present when the
   * download URL is reachable.
   */
  downloadSpeed: {
    /** Whether the speed probe ran at all. */
    checked: boolean;
    /** Measured throughput in bytes per second (null when probe did not run or failed). */
    bytesPerSecond: number | null;
    /** Estimated total download time in seconds based on Content-Length (null when unknown). */
    estimatedSeconds: number | null;
    /** True when estimated time exceeds the warning threshold. */
    slow: boolean;
    /** Error message if the probe failed. */
    error: string | null;
  };
  githubRelease: {
    ok: boolean;
    configured: boolean;
    tagName: string | null;
    publishedAt: string | null;
    manifestUrl: string | null;
    hasManifest: boolean;
    issue: string | null;
  };
  /** API-hosted electron-updater manifests and their stored payloads. */
  updateFeeds: {
    ok: boolean;
    windows: UpdateFeedStatus;
    mac: UpdateFeedStatus;
  };
  /**
   * Interrupted-download telemetry from the past 24 h.
   * Populated from system_settings; never throws — failures yield zero counts.
   */
  downloadInterruptions: DownloadInterruptionStats;
  issues: string[];
}

export interface UpdateFeedStatus {
  path: "/downloads/latest.yml" | "/downloads/latest-mac.yml";
  checked: boolean;
  ok: boolean;
  version: string | null;
  payloadFiles: string[];
  issues: string[];
}

const SETTING_URL = "desktop_installer_url";
const SETTING_VERSION = "desktop_installer_version";

/** Number of bytes to fetch for the speed probe (1 MB). */
const SPEED_PROBE_BYTES = 1_048_576;
/** Warning threshold in seconds — downloads estimated to take longer than this are flagged. */
const DOWNLOAD_SPEED_WARN_SECONDS = 300; // 5 minutes
/** Timeout for the speed probe fetch in milliseconds. */
const SPEED_PROBE_TIMEOUT_MS = 30_000;

function parseUpdateFeedFiles(content: string): Array<{ fileName: string; size: number | null }> {
  const starts = [...content.matchAll(/^\s*-\s+url:\s*["']?([^"'\s]+)["']?\s*$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = starts[index + 1]?.index ?? content.length;
    const block = content.slice(start, nextStart);
    const rawSize = block.match(/^\s+size:\s*(\d+)\s*$/m)?.[1];
    return {
      fileName: match[1] ?? "",
      size: rawSize === undefined ? null : Number(rawSize),
    };
  });
}

export async function checkUpdateFeed(
  platform: "windows" | "mac",
  expectedVersion: string,
): Promise<UpdateFeedStatus> {
  const path = platform === "windows" ? "/downloads/latest.yml" : "/downloads/latest-mac.yml";
  const status: UpdateFeedStatus = {
    path,
    checked: true,
    ok: false,
    version: null,
    payloadFiles: [],
    issues: [],
  };

  let manifest: Buffer | null;
  try {
    manifest = await readUpdateManifest(platform);
  } catch (err) {
    status.issues.push(
      `Could not read ${path} from API storage: ${(err as Error)?.message ?? String(err)}.`,
    );
    return status;
  }
  if (!manifest) {
    status.issues.push(
      `${path} is missing from API storage. Rerun Publish Draft Release for v${expectedVersion} after the update payloads are available.`,
    );
    return status;
  }

  const content = manifest.toString("utf8");
  status.version = content.match(/^version:\s*["']?([^\s"']+)["']?\s*$/m)?.[1] ?? null;
  if (!status.version) {
    status.issues.push(`${path} does not contain a release version. Republish the update feed.`);
  } else if (status.version !== expectedVersion) {
    status.issues.push(
      `${path} reports version ${status.version}, but the configured release is ${expectedVersion}. Rerun Publish Draft Release for v${expectedVersion}.`,
    );
  }

  let validation: ReturnType<typeof validateDesktopUpdateFeed>;
  try {
    validation = validateDesktopUpdateFeed(
      content,
      platform,
      status.version ?? expectedVersion,
    );
  } catch (err) {
    validation = { ok: false, error: (err as Error)?.message ?? String(err) };
  }
  const files = parseUpdateFeedFiles(content);
  status.payloadFiles = files.map((file) => file.fileName).filter(Boolean);
  if (!validation.ok) {
    status.issues.push(`${path} is invalid: ${validation.error} Republish the update feed.`);
  }

  if (validation.ok) {
    if (platform === "windows") {
      let installer: Awaited<ReturnType<typeof getDesktopInstallerMetadata>> = null;
      let storageCheckFailed = false;
      try {
        installer = await getDesktopInstallerMetadata("exe");
      } catch (err) {
        storageCheckFailed = true;
        status.issues.push(
          `Could not check the Windows update payload in API storage: ${(err as Error)?.message ?? String(err)}.`,
        );
      }
      if (!installer) {
        if (!storageCheckFailed) {
          status.issues.push(
            `Windows update payload LabTrax-Setup.exe referenced by ${path} is missing from API storage. Upload the signed installer, then rerun Publish Draft Release.`,
          );
        }
      } else {
        const expectedSize = files.find((file) => file.fileName === "LabTrax-Setup.exe")?.size;
        if (expectedSize !== null && expectedSize !== undefined && expectedSize !== installer.size) {
          status.issues.push(
            `${path} expects LabTrax-Setup.exe to be ${expectedSize} bytes, but API storage has ${installer.size} bytes. Republish the installer and update feed together.`,
          );
        }
      }
    } else {
      for (const file of files) {
        if (!file.fileName) continue;
        try {
          const payload = await getDesktopUpdatePayloadHandle(file.fileName);
          if (!payload) {
            status.issues.push(
              `macOS update payload ${file.fileName} referenced by ${path} is missing from API storage. Upload the signed ZIP, then rerun Publish Draft Release.`,
            );
          } else if (file.size !== null && file.size !== payload.size) {
            status.issues.push(
              `${path} expects ${file.fileName} to be ${file.size} bytes, but API storage has ${payload.size} bytes. Republish the payload and update feed together.`,
            );
          }
        } catch (err) {
          status.issues.push(
            `Could not check macOS update payload ${file.fileName} in API storage: ${(err as Error)?.message ?? String(err)}.`,
          );
        }
      }
    }
  }

  status.ok = status.issues.length === 0;
  return status;
}

interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

const fetchFn: FetchLike = ((globalThis as unknown as { fetch?: FetchLike }).fetch as FetchLike) ?? (async () => {
  throw new Error("global fetch is not available in this Node runtime");
});

/**
 * Parse the configured download URL into an absolute URL we can HEAD.
 * Returns null when the URL is missing or the base cannot be determined.
 */
function resolveDownloadUrl(configuredUrl: string | null, baseUrl: string | null): string | null {
  if (!configuredUrl) return null;
  if (/^https?:\/\//i.test(configuredUrl)) return configuredUrl;
  if (!baseUrl) return null;
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = configuredUrl.startsWith("/") ? configuredUrl : `/${configuredUrl}`;
  return `${cleanBase}${cleanPath}`;
}

function parseGithubRepoUrl(input: string | null | undefined): { owner: string; repo: string } | null {
  if (!input) return null;
  const m = input.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/?$)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}
interface GithubReleaseBody {
  tag_name?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubReleaseAsset[];
}

async function fetchLatestGithubRelease(
  owner: string,
  repo: string,
): Promise<GithubReleaseBody | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub requires a UA on REST calls.
    "User-Agent": "labtrax-installer-health-check",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  // Latest non-draft, non-prerelease release first.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
      { method: "GET", headers, signal: ctrl.signal },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      // Distinguish public-repo rate limit from a real error; the caller
      // will fold this into `githubRelease.issue`.
      throw new Error(`GitHub releases/latest returned HTTP ${res.status}`);
    }
    return (await res.json()) as GithubReleaseBody;
  } finally {
    clearTimeout(timer);
  }
}

async function headDownloadUrl(url: string): Promise<{
  status: number;
  contentLength: number | null;
  etag: string | null;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(url, { method: "HEAD", signal: ctrl.signal });
    const cl = res.headers.get("content-length");
    const et = res.headers.get("etag");
    return {
      status: res.status,
      contentLength: cl ? Number.parseInt(cl, 10) : null,
      etag: et,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the first SPEED_PROBE_BYTES bytes of the given URL, measure elapsed
 * time, and return throughput + an estimated total download time.
 *
 * Uses a Range request so the server can satisfy it from a partial read.
 * Falls back gracefully: if the server does not support Range (returns 200
 * instead of 206) we still measure the time taken to receive the partial body.
 *
 * @param url - Absolute URL to probe.
 * @param totalBytes - Total file size in bytes (from Content-Length on a HEAD),
 *                     used to estimate full transfer time. May be null.
 */
async function measureDownloadSpeed(
  url: string,
  totalBytes: number | null,
): Promise<{
  bytesPerSecond: number | null;
  estimatedSeconds: number | null;
  error: string | null;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SPEED_PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Range: `bytes=0-${SPEED_PROBE_BYTES - 1}` },
      signal: ctrl.signal,
    });
    if (!res.ok && res.status !== 206) {
      return {
        bytesPerSecond: null,
        estimatedSeconds: null,
        error: `Speed probe GET returned HTTP ${res.status}`,
      };
    }
    // Consume the body so we measure actual transfer, not just TTFB.
    await res.text();
    const elapsedMs = Date.now() - start;
    const elapsedSec = elapsedMs / 1000;

    // Determine how many bytes we actually received from the Content-Range
    // or Content-Length response header, falling back to SPEED_PROBE_BYTES.
    let receivedBytes = SPEED_PROBE_BYTES;
    const contentRange = res.headers.get("content-range"); // e.g. "bytes 0-1048575/157286400"
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)$/);
      if (m) {
        // Total file size from Content-Range is more reliable than a prior HEAD.
        totalBytes = Number.parseInt(m[1]!, 10);
      }
    }
    const rangeContentLength = res.headers.get("content-length");
    if (rangeContentLength) {
      receivedBytes = Number.parseInt(rangeContentLength, 10);
    }

    const bytesPerSecond = elapsedSec > 0 ? receivedBytes / elapsedSec : null;
    const estimatedSeconds =
      bytesPerSecond !== null && totalBytes !== null && totalBytes > 0
        ? totalBytes / bytesPerSecond
        : null;

    return { bytesPerSecond, estimatedSeconds, error: null };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return {
      bytesPerSecond: null,
      estimatedSeconds: null,
      error: msg.includes("abort") ? "Speed probe timed out" : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RunHealthCheckOptions {
  /**
   * Base URL the health check should use to HEAD the live /downloads/... URL.
   * Pass `req.protocol + '://' + req.get('host')` from a route handler, or set
   * the `INSTALLER_HEALTH_BASE_URL` env var for the scheduled job.
   */
  baseUrl?: string | null;
}

/**
 * Run the full health check and return a single report. Never throws — all
 * probe failures are folded into the report so callers can render them and
 * the deduped alert can fire on `report.ok === false`.
 */
export async function runDesktopInstallerHealthCheck(
  opts: RunHealthCheckOptions = {},
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const issues: string[] = [];

  // ── Settings ───────────────────────────────────────────────────────────────
  let dbUrl: string | null = null;
  let dbVersion: string | null = null;
  let settingsError: string | null = null;
  try {
    const rows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, [SETTING_URL, SETTING_VERSION]));
    for (const r of rows) {
      if (r.key === SETTING_URL) dbUrl = r.value;
      if (r.key === SETTING_VERSION) dbVersion = r.value;
    }
  } catch (err) {
    settingsError = (err as Error)?.message ?? String(err);
  }
  const envUrl = process.env.DESKTOP_INSTALLER_URL ?? "/downloads/LabTrax-Setup.exe";
  const envVersion = process.env.DESKTOP_INSTALLER_VERSION ?? "1.0.0";
  const configuredUrl = dbUrl ?? envUrl;
  const configuredVersion = dbVersion ?? envVersion;
  const activeKind: DesktopInstallerKind | null = configuredUrl
    ? installerKindFromUrl(configuredUrl)
    : null;
  if (settingsError) issues.push(`settings: ${settingsError}`);

  // ── Storage ────────────────────────────────────────────────────────────────
  let storageOk = false;
  let storageSize: number | null = null;
  let storageUploadedAt: string | null = null;
  let storageEtag: string | null = null;
  let storageError: string | null = null;
  if (activeKind && configuredUrl?.startsWith("/downloads/")) {
    try {
      const handle = await getDesktopInstallerHandle(activeKind);
      if (handle) {
        storageOk = true;
        storageSize = handle.size;
        storageUploadedAt = handle.uploadedAt;
        storageEtag = handle.etag;
      } else {
        storageError = `No ${activeKind} installer is uploaded in App Storage.`;
        issues.push(`storage: ${storageError}`);
      }
    } catch (err) {
      storageError = (err as Error)?.message ?? String(err);
      issues.push(`storage: ${storageError}`);
    }
  } else if (!activeKind) {
    storageError = `Configured download URL (${configuredUrl ?? "<unset>"}) does not point to a known installer kind.`;
    issues.push(`storage: ${storageError}`);
  }

  // ── Download ───────────────────────────────────────────────────────────────
  const downloadUrl = resolveDownloadUrl(configuredUrl, opts.baseUrl ?? process.env.INSTALLER_HEALTH_BASE_URL ?? null);
  let downloadChecked = false;
  let downloadOk = false;
  let downloadStatus: number | null = null;
  let downloadLength: number | null = null;
  let downloadEtag: string | null = null;
  let downloadError: string | null = null;
  let etagMatchesStorage: boolean | null = null;
  if (downloadUrl) {
    downloadChecked = true;
    try {
      const head = await headDownloadUrl(downloadUrl);
      downloadStatus = head.status;
      downloadLength = head.contentLength;
      downloadEtag = head.etag;
      if (head.status >= 200 && head.status < 300) {
        downloadOk = true;
        if (storageEtag && head.etag) {
          // serveInstaller emits the storage etag verbatim. A mismatch
          // indicates a stale proxy/CDN copy or a publish that hasn't
          // propagated.
          etagMatchesStorage = head.etag.replace(/^W\//, "") === storageEtag.replace(/^W\//, "");
          if (!etagMatchesStorage) {
            issues.push(
              `download: served ETag (${head.etag}) does not match storage ETag (${storageEtag}); a stale copy may be cached.`,
            );
          }
        }
      } else {
        downloadError = `HEAD ${downloadUrl} returned HTTP ${head.status}`;
        issues.push(`download: ${downloadError}`);
      }
    } catch (err) {
      downloadError = (err as Error)?.message ?? String(err);
      issues.push(`download: ${downloadError}`);
    }
  }

  // ── Download Speed ─────────────────────────────────────────────────────────
  // Only probe speed when the HEAD check succeeded (download URL is reachable).
  let speedChecked = false;
  let speedBytesPerSecond: number | null = null;
  let speedEstimatedSeconds: number | null = null;
  let speedSlow = false;
  let speedError: string | null = null;
  if (downloadUrl && downloadOk) {
    speedChecked = true;
    try {
      const probe = await measureDownloadSpeed(downloadUrl, downloadLength);
      speedBytesPerSecond = probe.bytesPerSecond;
      speedEstimatedSeconds = probe.estimatedSeconds;
      speedError = probe.error;
      if (speedEstimatedSeconds !== null && speedEstimatedSeconds > DOWNLOAD_SPEED_WARN_SECONDS) {
        speedSlow = true;
        const mins = Math.round(speedEstimatedSeconds / 60);
        issues.push(
          `downloadSpeed: estimated transfer time is ~${mins} min — the download may time out through the Replit proxy on this connection. ` +
            `Consider setting DESKTOP_INSTALLER_URL to a GitHub Release asset URL for large-file downloads.`,
        );
      }
    } catch (err) {
      speedError = (err as Error)?.message ?? String(err);
    }
  }

  // ── GitHub Release ─────────────────────────────────────────────────────────
  const repo = parseGithubRepoUrl(process.env.GITHUB_REPO_URL);
  let releaseConfigured = repo !== null;
  let releaseTag: string | null = null;
  let releasePublishedAt: string | null = null;
  let manifestUrl: string | null = null;
  let hasManifest = false;
  let releaseIssue: string | null = null;
  let releaseOk = false;
  if (repo) {
    try {
      const rel = await fetchLatestGithubRelease(repo.owner, repo.repo);
      if (!rel) {
        releaseIssue = "No published GitHub Release found for the configured repo.";
      } else if (rel.draft) {
        releaseIssue = `Latest GitHub Release (${rel.tag_name}) is still a draft — auto-updater will not pick it up.`;
        releaseTag = rel.tag_name ?? null;
        releasePublishedAt = rel.published_at ?? null;
      } else {
        releaseTag = rel.tag_name ?? null;
        releasePublishedAt = rel.published_at ?? null;
        const assets = rel.assets ?? [];
        // Need at least one of latest.yml (Windows) or latest-mac.yml (macOS)
        // for the auto-updater to function on the corresponding platform.
        const yml = assets.find((a) => a.name === "latest.yml" || a.name === "latest-mac.yml");
        hasManifest = !!yml;
        manifestUrl = yml?.browser_download_url ?? null;
        if (!hasManifest) {
          releaseIssue = `GitHub Release ${releaseTag} has no latest.yml or latest-mac.yml asset — electron-updater cannot read it.`;
        } else {
          // Compare version: tag should be v<configuredVersion> for a clean
          // pipeline. Strip leading "v" for the comparison.
          const tagBare = (releaseTag ?? "").replace(/^v/i, "");
          if (configuredVersion && tagBare && tagBare !== configuredVersion) {
            releaseIssue = `GitHub Release tag (${releaseTag}) is out of sync with live download (v${configuredVersion}) — existing installs may not auto-update.`;
          } else {
            releaseOk = true;
          }
        }
      }
      if (releaseIssue) issues.push(`githubRelease: ${releaseIssue}`);
    } catch (err) {
      releaseIssue = (err as Error)?.message ?? String(err);
      issues.push(`githubRelease: ${releaseIssue}`);
    }
  }

  // ── API update feeds ───────────────────────────────────────────────────────
  // Read the stored API manifests and referenced payload metadata only. This
  // check never writes or republishes update-feed objects.
  const [windowsFeed, macFeed] = await Promise.all([
    checkUpdateFeed("windows", configuredVersion),
    checkUpdateFeed("mac", configuredVersion),
  ]);
  const updateFeeds = {
    ok: windowsFeed.ok && macFeed.ok,
    windows: windowsFeed,
    mac: macFeed,
  };
  for (const feed of [windowsFeed, macFeed]) {
    for (const issue of feed.issues) {
      issues.push(`updateFeeds: ${issue}`);
    }
  }

  // ── Per-slot storage availability ─────────────────────────────────────────
  // Check all three installer kinds in parallel so the health report can flag
  // every missing slot, not just the currently-active one.
  const slotResults = await Promise.all(
    ALL_INSTALLER_KINDS.map(async (k) => {
      try {
        const meta = await getDesktopInstallerMetadata(k);
        return {
          kind: k,
          ok: meta !== null,
          size: meta?.size ?? null,
          uploadedAt: meta?.uploadedAt ?? null,
          error: meta === null ? `No ${k} installer has been uploaded.` : null,
        };
      } catch (err) {
        return {
          kind: k,
          ok: false,
          size: null,
          uploadedAt: null,
          error: (err as Error)?.message ?? String(err),
        };
      }
    }),
  );
  const storageSlots = Object.fromEntries(
    slotResults.map((r) => [
      r.kind,
      { ok: r.ok, size: r.size, uploadedAt: r.uploadedAt, error: r.error },
    ]),
  ) as Record<DesktopInstallerKind, InstallerSlotStatus>;

  // ── Download interruption telemetry ───────────────────────────────────────
  const downloadInterruptions = await getDownloadInterruptionStats();
  if (downloadInterruptions.retryFailCount24h > 0) {
    issues.push(
      `downloadInterruptions: ${downloadInterruptions.retryFailCount24h} retry failure${downloadInterruptions.retryFailCount24h !== 1 ? "s" : ""} in the past 24 h` +
        (downloadInterruptions.lastOccurredAt
          ? ` (last: ${formatNumericDateTime(downloadInterruptions.lastOccurredAt)})`
          : ""),
    );
  }

  const ok =
    settingsError === null &&
    storageOk &&
    downloadOk &&
    etagMatchesStorage !== false &&
    (!releaseConfigured || releaseOk) &&
    updateFeeds.ok;

  return {
    ok,
    checkedAt,
    settings: {
      version: configuredVersion,
      downloadUrl: configuredUrl,
      activeKind,
      error: settingsError,
    },
    storage: {
      ok: storageOk,
      size: storageSize,
      uploadedAt: storageUploadedAt,
      etag: storageEtag,
      error: storageError,
    },
    storageSlots,
    download: {
      ok: downloadOk,
      checked: downloadChecked,
      url: downloadUrl,
      status: downloadStatus,
      contentLength: downloadLength,
      etag: downloadEtag,
      etagMatchesStorage,
      error: downloadError,
    },
    downloadSpeed: {
      checked: speedChecked,
      bytesPerSecond: speedBytesPerSecond,
      estimatedSeconds: speedEstimatedSeconds,
      slow: speedSlow,
      error: speedError,
    },
    githubRelease: {
      ok: releaseOk,
      configured: releaseConfigured,
      tagName: releaseTag,
      publishedAt: releasePublishedAt,
      manifestUrl,
      hasManifest,
      issue: releaseIssue,
    },
    updateFeeds,
    downloadInterruptions,
    issues,
  };
}
