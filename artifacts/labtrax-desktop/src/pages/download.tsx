import {
  AlertTriangle,
  Bell,
  Check,
  Download,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  Monitor,
  Package,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, getApiOrigin } from "@/lib/api";

/**
 * Turn a potentially relative download path (e.g. "/downloads/LabTrax-Windows-Portable.zip")
 * into an absolute URL so it works from any page origin:
 *   • Electron renderer: origin is app://labtrax — relative paths would resolve
 *     against the custom protocol handler instead of the API server.
 *   • Web browser:       window.location.origin is the correct API host.
 *   • https:// URLs already set by an admin stay unchanged.
 */
function toAbsoluteDownloadUrl(url: string): string {
  if (!url.startsWith("/")) return url; // already absolute (https://…)
  const origin = getApiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}${url}`;
}

interface DesktopInstallerPublicInfo {
  version: string;
  downloadUrl: string;
  fileName: string;
  releaseNotes: string | null;
  available?: boolean;
  installerObject?: { size: number; uploadedAt: string } | null;
}

const FALLBACK_VERSION = "1.0.0";
const FALLBACK_FILE_NAME = "LabTrax-Windows-Portable.zip";
const FALLBACK_DOWNLOAD_URL = "/downloads/" + FALLBACK_FILE_NAME;

export default function DownloadPage() {
  const query = useQuery({
    queryKey: ["desktop-installer", "public"],
    queryFn: () => apiFetch<DesktopInstallerPublicInfo>("/desktop-installer"),
  });

  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifyState, setNotifyState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [notifyError, setNotifyError] = useState<string | null>(null);

  async function handleNotifySubmit(e: React.FormEvent) {
    e.preventDefault();
    const email = notifyEmail.trim();
    if (!email) return;
    setNotifyState("submitting");
    setNotifyError(null);
    try {
      await apiFetch("/desktop-installer/notify-me", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setNotifyState("done");
    } catch (err: any) {
      setNotifyError(err?.message || "Something went wrong. Please try again.");
      setNotifyState("error");
    }
  }

  const info = query.data;
  const version = info?.version ?? FALLBACK_VERSION;
  const fileName = info?.fileName ?? FALLBACK_FILE_NAME;
  const downloadUrl = toAbsoluteDownloadUrl(info?.downloadUrl ?? FALLBACK_DOWNLOAD_URL);
  const releaseNotes = info?.releaseNotes ?? null;
  const isExe = downloadUrl.toLowerCase().endsWith(".exe");
  const isZip = downloadUrl.toLowerCase().endsWith(".zip");
  const isDmg = downloadUrl.toLowerCase().endsWith(".dmg");
  const unavailable = info?.available === false;
  const queryFailed = !info && query.isError;
  const queryError = query.error as Error | undefined;
  const is503 =
    queryFailed &&
    queryError &&
    "status" in queryError &&
    (queryError as { status?: number }).status === 503;
  const showDownloadButton = !!info && !unavailable;

  return (
    <div className="px-8 py-7 max-w-[760px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Download LabTrax Desktop</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isDmg
            ? "Install the native Mac desktop app for the best LabTrax experience."
            : "Install the native Windows desktop app for the best LabTrax experience."}
        </p>
      </div>

      {/* Install as Web App (PWA) */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start gap-5">
          <div className="shrink-0 h-16 w-16 rounded-xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center">
            <Globe size={32} className="text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h2 className="text-lg font-semibold">Install as Web App</h2>
              <span className="text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
                No download required
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Use Chrome or Edge to install LabTrax directly from your browser — it opens in its own window just like a native app, with no file download or admin rights needed.
            </p>

            <div className="mt-4 space-y-3">
              {[
                {
                  step: 1,
                  title: "Open in Chrome or Edge",
                  detail: "Make sure you're using Google Chrome or Microsoft Edge on your desktop.",
                },
                {
                  step: 2,
                  title: 'Look for the install icon in the address bar',
                  detail: 'A small computer or download icon (⊕) appears at the right end of the address bar when the page is installable.',
                },
                {
                  step: 3,
                  title: 'Click "Install LabTrax"',
                  detail: "Click the icon, then confirm in the prompt that appears. LabTrax will be added to your Start Menu, taskbar, and desktop.",
                },
              ].map(({ step, title, detail }) => (
                <div key={step} className="flex gap-3">
                  <span className="shrink-0 h-6 w-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">
                    {step}
                  </span>
                  <div>
                    <div className="text-sm font-medium">{title}</div>
                    <p className="text-sm text-muted-foreground mt-0.5">{detail}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              The installed web app stays in sync with the latest version automatically — no manual updates needed.
            </p>
          </div>
        </div>
      </div>

      {/* Electron native download */}
      <div className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start gap-5">
          <div className="shrink-0 h-16 w-16 rounded-xl bg-primary/10 flex items-center justify-center">
            <Monitor size={32} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h2 className="text-lg font-semibold">
                {isDmg ? "LabTrax Desktop for Mac" : "LabTrax Desktop for Windows"}
              </h2>
              <span className="text-xs font-medium bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">
                v{version}
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {isExe
                ? "One-click Windows installer. Works on Windows 10 and 11 (64-bit)."
                : isZip
                  ? "Portable ZIP — no installer required. Works on Windows 10 and 11 (64-bit)."
                  : isDmg
                    ? "macOS disk image. Works on macOS 11 Big Sur and later (Apple Silicon and Intel)."
                    : "Desktop download."}
            </p>

            {unavailable || queryFailed ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-950/30 px-4 py-3 flex items-start gap-2.5 text-sm">
                  <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1 text-amber-800 dark:text-amber-200">
                    <div className="font-semibold">Desktop installer coming soon</div>
                    <p className="text-xs mt-1 text-amber-700 dark:text-amber-300/90 leading-relaxed">
                      {queryFailed && !is503
                        ? "We couldn't reach the server to confirm the installer is available — it may still be loading. Check back soon, or use the web app in the meantime."
                        : is503
                          ? "The file storage service is temporarily unavailable. The installer should be available again shortly — check back soon."
                          : "The desktop installer is being prepared — check back soon. In the meantime, you can use LabTrax directly in your browser — no installation needed."}
                    </p>
                    <button
                      type="button"
                      onClick={() => query.refetch()}
                      disabled={query.isFetching}
                      className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 underline underline-offset-2 hover:no-underline disabled:opacity-50"
                    >
                      {query.isFetching ? (
                        <>
                          <Loader2 size={11} className="animate-spin" />
                          Checking…
                        </>
                      ) : (
                        <>
                          <RefreshCw size={11} />
                          Check again
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Notify-me form */}
                <div className="rounded-md border border-border bg-secondary/40 px-4 py-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Bell size={14} className="text-muted-foreground shrink-0" />
                    <div className="text-sm font-medium">Email me when it's ready</div>
                  </div>
                  {notifyState === "done" ? (
                    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                      <Check size={14} className="shrink-0" />
                      <span>You're on the list — we'll email you as soon as the installer is published.</span>
                    </div>
                  ) : (
                    <form onSubmit={handleNotifySubmit} className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="email"
                        placeholder="your@email.com"
                        value={notifyEmail}
                        onChange={(e) => {
                          setNotifyEmail(e.target.value);
                          if (notifyState === "error") setNotifyState("idle");
                        }}
                        disabled={notifyState === "submitting"}
                        className="flex-1 text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={notifyState === "submitting" || !notifyEmail.trim()}
                        className="inline-flex items-center justify-center gap-1.5 text-sm font-medium bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {notifyState === "submitting" ? (
                          <>
                            <Loader2 size={13} className="animate-spin" />
                            Saving…
                          </>
                        ) : (
                          "Notify me"
                        )}
                      </button>
                    </form>
                  )}
                  {notifyState === "error" && notifyError && (
                    <p className="text-xs text-destructive mt-1.5">{notifyError}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    One-time notification only — we won't add you to any mailing list.
                  </p>
                </div>

                <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 flex items-start gap-2.5">
                  <Globe size={15} className="text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <div className="text-sm font-medium">Use the web app instead</div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      LabTrax works in any modern browser — Chrome, Edge, Firefox, or Safari. Open it from the link your lab admin shared and bookmark it for quick access. No download required.
                    </p>
                  </div>
                </div>
              </div>
            ) : showDownloadButton ? (
              <a
                href={downloadUrl}
                download={fileName}
                className="mt-4 inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-5 py-2.5 rounded-md transition-colors"
              >
                <Download size={16} />
                Download {fileName}
              </a>
            ) : (
              <button
                type="button"
                disabled
                className="mt-4 inline-flex items-center gap-2 bg-primary/60 text-primary-foreground text-sm font-medium px-5 py-2.5 rounded-md cursor-not-allowed"
              >
                <Loader2 size={16} className="animate-spin" />
                Checking availability…
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg divide-y divide-border">
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold mb-3">Installation instructions</h3>
          {isDmg ? (
            <ol className="space-y-4">
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  1
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Download size={14} className="text-muted-foreground" />
                    Download the disk image
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Click the download button above to save{" "}
                    <strong>{fileName}</strong>.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  2
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Package size={14} className="text-muted-foreground" />
                    Open the DMG
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Double-click <strong>{fileName}</strong> to mount the disk
                    image, then drag the <strong>LabTrax</strong> icon into the
                    <strong> Applications</strong> folder in the window that opens.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  3
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Rocket size={14} className="text-muted-foreground" />
                    Launch LabTrax
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Open <strong>LabTrax</strong> from the Applications folder or
                    Spotlight. You can eject the mounted disk image afterwards.
                  </p>
                </div>
              </li>
            </ol>
          ) : isExe ? (
            <ol className="space-y-4">
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  1
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Download size={14} className="text-muted-foreground" />
                    Download the installer
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Click the download button above to save{" "}
                    <strong>{fileName}</strong>.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  2
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Rocket size={14} className="text-muted-foreground" />
                    Run the setup wizard
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Double-click <strong>{fileName}</strong> and follow the on-screen
                    steps (Next → Next → Finish).
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  3
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FolderOpen size={14} className="text-muted-foreground" />
                    Launch LabTrax
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Setup creates a Desktop shortcut and a Start Menu entry. Click
                    either one to start using LabTrax.
                  </p>
                </div>
              </li>
            </ol>
          ) : (
            <ol className="space-y-4">
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  1
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Download size={14} className="text-muted-foreground" />
                    Download the ZIP
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Click the download button above. The file is approximately 145 MB.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  2
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Package size={14} className="text-muted-foreground" />
                    Extract the ZIP
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Right-click the downloaded ZIP and choose <strong>Extract All…</strong> to unzip
                    it to a folder of your choice (e.g.{" "}
                    <code className="text-xs bg-secondary px-1 py-0.5 rounded">C:\LabTrax</code>).
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  3
                </span>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FolderOpen size={14} className="text-muted-foreground" />
                    Run LabTrax.exe
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Open the extracted folder and double-click <strong>LabTrax.exe</strong> to launch
                    the app. No installation or admin rights required.
                  </p>
                </div>
              </li>
            </ol>
          )}
        </div>
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold mb-1">Notes</h3>
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc list-inside">
            {isDmg ? (
              <li>
                If macOS Gatekeeper blocks the app on first launch, right-click{" "}
                <strong>LabTrax</strong> in Applications and choose{" "}
                <strong>Open</strong>, then confirm.
              </li>
            ) : (
              <li>
                Windows may show a SmartScreen warning on first launch — click{" "}
                <strong>More info</strong> then <strong>Run anyway</strong> to proceed.
              </li>
            )}
            <li>
              The app connects to your LabTrax server automatically — no extra configuration needed.
            </li>
            {isDmg ? (
              <li>
                To remove LabTrax later, drag <strong>LabTrax</strong> from the
                Applications folder to the Trash.
              </li>
            ) : isExe ? (
              <li>
                To remove LabTrax later, use <strong>Add or Remove Programs</strong> in
                Windows Settings.
              </li>
            ) : (
              <li>
                Keep the entire extracted folder together; <strong>LabTrax.exe</strong> requires the
                other files in that folder to run.
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-6 mt-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={16} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">What's new in v{version}</h3>
        </div>
        {query.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            Loading release notes…
          </div>
        ) : releaseNotes ? (
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {releaseNotes}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            Release notes for this version are coming soon.
          </p>
        )}
      </div>
    </div>
  );
}
