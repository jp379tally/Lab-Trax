import {
  AlertTriangle,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  Monitor,
  Package,
  Rocket,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

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

  const info = query.data;
  const version = info?.version ?? FALLBACK_VERSION;
  const fileName = info?.fileName ?? FALLBACK_FILE_NAME;
  const downloadUrl = info?.downloadUrl ?? FALLBACK_DOWNLOAD_URL;
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

            {unavailable ? (
              <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-950/30 px-4 py-3 flex items-start gap-2.5 text-sm">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="text-amber-800 dark:text-amber-200">
                  <div className="font-semibold">Installer not yet uploaded</div>
                  <p className="text-xs mt-1 text-amber-700 dark:text-amber-300/90">
                    The LabTrax Desktop installer hasn't been uploaded yet. Contact your lab admin to upload it via Settings → Desktop App.
                  </p>
                </div>
              </div>
            ) : queryFailed ? (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-start gap-2.5 text-sm">
                <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
                <div className="text-destructive flex-1">
                  <div className="font-semibold">
                    {is503 ? "Storage temporarily unavailable" : "Couldn't check for the latest installer"}
                  </div>
                  <p className="text-xs mt-1 text-destructive/90">
                    {is503
                      ? "The file storage service is temporarily unavailable. Please try again in a moment."
                      : queryError?.message ||
                        "We couldn't reach the LabTrax server to confirm the installer is available."}
                  </p>
                  <button
                    type="button"
                    onClick={() => query.refetch()}
                    disabled={query.isFetching}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium underline disabled:opacity-50"
                  >
                    {query.isFetching ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Retrying…
                      </>
                    ) : (
                      "Try again"
                    )}
                  </button>
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

      <div className="bg-card border border-border rounded-lg p-6 mb-6">
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
            No release notes are available for this version yet.
          </p>
        )}
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
    </div>
  );
}
