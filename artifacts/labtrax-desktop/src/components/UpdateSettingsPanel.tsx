import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CircleDot, Download, Loader2, RefreshCw } from "lucide-react";

type UpdateSnapshot = {
  currentVersion?: string | null;
  latestVersion?: string | null;
  status?: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | string;
  lastCheckedAt?: string | null;
  error?: string | null;
  downloadProgress?: number | null;
  autoUpdaterEnabled?: boolean;
  isWindowsStore?: boolean;
  isDevelopment?: boolean;
  skipAutoUpdater?: boolean;
  updateChannel?: string | null;
  manualInstallerUrl?: string | null;
  installerPlatform?: "windows" | "macos" | null;
};

type BuildMetadata = {
  version?: string | null;
  buildNumber?: number | null;
  updateChannel?: string | null;
};

type ElectronUpdateAPI = {
  getAppVersion?: () => Promise<string>;
  getBuildMetadata?: () => Promise<BuildMetadata>;
  getUpdateState?: () => Promise<UpdateSnapshot>;
  onUpdateState?: (callback: (state: UpdateSnapshot) => void) => (() => void) | void;
  checkForUpdates?: () => Promise<UpdateSnapshot | void>;
  installUpdate?: () => Promise<void>;
  openExternal?: (url: string) => Promise<boolean>;
};

function updateAPI(): ElectronUpdateAPI | null {
  if (typeof window === "undefined") return null;
  const api = (window as Window & { electronAPI?: ElectronUpdateAPI }).electronAPI;
  return api?.getAppVersion && api.getUpdateState && api.checkForUpdates && api.installUpdate && api.onUpdateState
    ? api
    : null;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "Ready to check",
  checking: "Checking for updates",
  available: "Update available",
  "not-available": "Up to date",
  downloading: "Downloading update",
  downloaded: "Update ready to install",
  error: "Update check failed",
};

function readableDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function UpdateSettingsPanel() {
  const api = updateAPI();
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [buildMetadata, setBuildMetadata] = useState<BuildMetadata | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const applySnapshot = useCallback((next: UpdateSnapshot) => {
    setSnapshot(next);
    if (next.status !== "checking") setChecking(false);
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    let receivedEvent = false;
    let unsubscribe: (() => void) | void;
    try {
      unsubscribe = api.onUpdateState?.((next) => {
        receivedEvent = true;
        if (alive) applySnapshot(next);
      });
    } catch {
      // Initial state recovery below remains useful even if event wiring fails.
    }
    const metadataRequest = api.getBuildMetadata
      ? api.getBuildMetadata()
      : api.getAppVersion!().then((version) => ({ version, buildNumber: null, updateChannel: null }));
    Promise.allSettled([metadataRequest, api.getUpdateState!()]).then(([metadataResult, stateResult]) => {
      if (!alive) return;
      if (metadataResult.status === "fulfilled") setBuildMetadata(metadataResult.value);
      if (stateResult.status === "fulfilled") {
        if (!receivedEvent) applySnapshot(stateResult.value);
      } else if (!receivedEvent) {
        setActionError("Could not load update status. Try again.");
      }
      setLoading(false);
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [api, applySnapshot]);

  if (!api) return null;

  const status = snapshot?.status ?? "idle";
  const updaterEnabled = snapshot?.autoUpdaterEnabled === true;
  const busy = loading || checking || status === "checking";
  const isError = status === "error" || Boolean(actionError);
  const isReady = status === "downloaded";
  const lastChecked = readableDate(snapshot?.lastCheckedAt);
  const showTransitionGuide =
    (!updaterEnabled || status === "error") &&
    !snapshot?.isWindowsStore &&
    !snapshot?.isDevelopment &&
    !snapshot?.skipAutoUpdater;
  const statusLabel = snapshot?.isWindowsStore
    ? "Updates managed by Microsoft Store"
    : showTransitionGuide
      ? "Installer update required"
      : STATUS_LABELS[status] || "Update status unavailable";

  async function openManualInstaller() {
    const url = snapshot?.manualInstallerUrl;
    if (!url) return;
    try {
      const opened = await api?.openExternal?.(url);
      if (opened === false) setActionError("Could not open the installer download. Copy this link into your browser: " + url);
    } catch {
      setActionError("Could not open the installer download. Copy this link into your browser: " + url);
    }
  }

  async function checkForUpdates() {
    if (!api) return;
    setChecking(true);
    setActionError(null);
    try {
      const next = await api.checkForUpdates!();
      if (next) applySnapshot(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not check for updates.");
      setChecking(false);
    }
  }

  async function restartAndUpdate() {
    if (!api) return;
    setInstalling(true);
    setActionError(null);
    try {
      await api.installUpdate!();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not restart to install the update.");
      setInstalling(false);
    }
  }

  const StatusIcon = isError ? AlertCircle : isReady ? CheckCircle2 : status === "downloading" ? Download : CircleDot;
  const availableVersion =
    status === "available" && snapshot?.latestVersion
      ? `Version v${snapshot.latestVersion} is available and will download automatically.`
      : null;
  const installedVersion =
    typeof buildMetadata?.version === "string" && buildMetadata.version.trim()
      ? `v${buildMetadata.version}`
      : "Unavailable";
  const buildNumber =
    Number.isSafeInteger(buildMetadata?.buildNumber) && (buildMetadata?.buildNumber ?? 0) > 0
      ? buildMetadata?.buildNumber
      : "Unavailable";
  const updateChannel =
    buildMetadata?.updateChannel === "installer" ||
    buildMetadata?.updateChannel === "manual" ||
    buildMetadata?.updateChannel === "portable"
      ? buildMetadata.updateChannel
      : "Unavailable";
  return (
    <section aria-labelledby="updates-heading" className="p-6 sm:p-7">
      <header className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Desktop</p>
        <h2 id="updates-heading" className="mt-1 text-lg font-semibold tracking-tight">Software updates</h2>
        <p className="mt-1 text-sm text-muted-foreground">Keep this workstation current with the latest LabTrax release.</p>
      </header>

      <div className="overflow-hidden rounded-xl border border-border bg-background">
        <div className="flex flex-col gap-5 border-b border-border/70 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/8 text-primary">
              <RefreshCw size={16} aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold">Installed version</p>
              <p data-testid="desktop-installed-version" className="mt-1 font-mono text-sm tabular-nums text-foreground/75">
                {loading ? <span className="inline-block h-4 w-20 animate-pulse rounded bg-muted align-middle" aria-label="Loading version" /> : installedVersion}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
                <p>
                  Build number{" "}
                  <span data-testid="desktop-build-number" className="font-mono tabular-nums text-foreground/75">
                    {loading ? "…" : buildNumber}
                  </span>
                </p>
                <p>
                  Update channel{" "}
                  <span data-testid="desktop-update-channel" className="font-mono text-foreground/75">
                      {loading ? "…" : updateChannel}
                  </span>
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={checkForUpdates}
              disabled={!updaterEnabled || busy || installing}
              data-testid="desktop-check-updates"
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border bg-card px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {busy ? "Checking…" : "Check for updates"}
            </button>
            {isReady && (
              <button
                type="button"
                onClick={restartAndUpdate}
                disabled={installing}
                data-testid="desktop-install-update"
                className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RefreshCw size={14} className={installing ? "animate-spin" : ""} />
                {installing ? "Restarting…" : "Restart & Update"}
              </button>
            )}
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="flex items-start gap-2.5">
            <StatusIcon
              size={15}
              aria-hidden="true"
              className={`mt-0.5 shrink-0 ${isError ? "text-destructive" : isReady ? "text-emerald-600" : status === "downloading" ? "text-primary" : "text-muted-foreground"}`}
            />
            <div className="min-w-0 flex-1">
              <p role="status" className={`text-sm font-medium ${isError ? "text-destructive" : ""}`}>
                {loading ? "Loading update status" : actionError || snapshot?.error || statusLabel}
              </p>
              {!updaterEnabled && !loading && snapshot?.isWindowsStore && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Updates for this Microsoft Store installation are delivered through the Microsoft Store.
                </p>
              )}
              {showTransitionGuide && !loading && (
                <div className="mt-1 space-y-2">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {updaterEnabled && status === "error"
                      ? "The update feed could not be reached. If this keeps happening, download and install the signed desktop app."
                      : snapshot?.updateChannel === "portable"
                        ? "This portable copy cannot update itself. Install the signed desktop app to move to the supported update feed. Do not use the portable ZIP for this transition."
                        : "This installation cannot update itself. Install the signed desktop app to move to the supported update feed."}
                  </p>
                  {snapshot?.manualInstallerUrl && (
                    <button
                      type="button"
                      onClick={openManualInstaller}
                      data-testid="desktop-open-signed-installer"
                      className="text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      Download signed {snapshot.installerPlatform === "windows" ? "Windows installer" : "macOS installer"}
                    </button>
                  )}
                </div>
              )}
              {availableVersion && <p className="mt-1 text-xs text-muted-foreground">{availableVersion}</p>}
              {isReady && snapshot?.latestVersion && (
                <p className="mt-1 text-xs text-muted-foreground">Version v{snapshot.latestVersion} has been downloaded and is ready to install.</p>
              )}
              {status === "downloading" && typeof snapshot?.downloadProgress === "number" && (
                <div className="mt-3 max-w-sm">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Downloading update</span>
                    <span className="font-mono tabular-nums">{Math.round(snapshot.downloadProgress)}%</span>
                  </div>
                  <div role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={snapshot.downloadProgress} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, snapshot.downloadProgress))}%` }} />
                  </div>
                </div>
              )}
              {lastChecked && <p className="mt-2 text-xs text-muted-foreground">Last checked {lastChecked}</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
