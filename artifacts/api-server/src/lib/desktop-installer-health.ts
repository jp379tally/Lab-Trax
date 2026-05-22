/**
 * End-to-end health check for the desktop installer publish pipeline.
 *
 * Runs three probes in parallel and returns a single JSON report:
 *
 *   1. settings   — the configured download URL / version / activeKind
 *   2. storage    — whether the configured installer object exists in App Storage
 *   3. download   — HEAD against the live /downloads/... URL (catches misconfigured
 *                   reverse proxies and stale CDN copies)
 *   4. githubRelease — fetches the latest release manifest from GitHub Releases so
 *                       admins know if the auto-updater feed is in sync with the
 *                       live download page.
 *
 * See docs/desktop-publish-pipeline.md for the wider pipeline context.
 */
import { db, systemSettings } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  getDesktopInstallerHandle,
  installerKindFromUrl,
  type DesktopInstallerKind,
} from "./desktop-installer-storage.js";

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
  githubRelease: {
    ok: boolean;
    configured: boolean;
    tagName: string | null;
    publishedAt: string | null;
    manifestUrl: string | null;
    hasManifest: boolean;
    issue: string | null;
  };
  issues: string[];
}

const SETTING_URL = "desktop_installer_url";
const SETTING_VERSION = "desktop_installer_version";

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
  const envUrl = process.env.DESKTOP_INSTALLER_URL ?? "/downloads/LabTrax-Windows-Portable.zip";
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

  const ok =
    settingsError === null &&
    storageOk &&
    downloadOk &&
    etagMatchesStorage !== false &&
    (!releaseConfigured || releaseOk);

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
    githubRelease: {
      ok: releaseOk,
      configured: releaseConfigured,
      tagName: releaseTag,
      publishedAt: releasePublishedAt,
      manifestUrl,
      hasManifest,
      issue: releaseIssue,
    },
    issues,
  };
}
