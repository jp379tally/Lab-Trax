import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  Monitor,
  Package,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

interface DesktopInstallerPublicInfo {
  version: string;
  downloadUrl: string;
  fileName: string;
  releaseNotes: string | null;
  available?: boolean;
}

const FALLBACK_VERSION = "1.0.0";
const FALLBACK_FILE_NAME = "LabTrax-Windows-Portable.zip";
const FALLBACK_DOWNLOAD_URL = "/downloads/" + FALLBACK_FILE_NAME;

type DownloadState =
  | { status: "idle" }
  | { status: "downloading"; received: number; total: number | null }
  | { status: "stalled"; received: number; total: number | null; error: string }
  | { status: "done" };

const STALL_TIMEOUT_MS = 15_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ProgressBar({ received, total }: { received: number; total: number | null }) {
  const pct = total && total > 0 ? Math.min(100, (received / total) * 100) : null;
  return (
    <div className="mt-4 space-y-1.5">
      <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
        {pct != null ? (
          <div
            className="h-full bg-primary rounded-full transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full bg-primary/60 rounded-full animate-pulse w-full" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {total
          ? `${formatBytes(received)} of ${formatBytes(total)} (${pct!.toFixed(0)}%)`
          : `${formatBytes(received)} downloaded…`}
      </p>
    </div>
  );
}

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
  const showDownloadButton = !!info && !unavailable;

  const [dlState, setDlState] = useState<DownloadState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chunksRef = useRef<Uint8Array[]>([]);
  const receivedRef = useRef(0);

  const clearStallTimer = () => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  };

  const resetStallTimer = (received: number, total: number | null) => {
    clearStallTimer();
    stallTimerRef.current = setTimeout(() => {
      abortRef.current?.abort();
      setDlState({
        status: "stalled",
        received,
        total,
        error: "The download stalled. Click \"Resume download\" to pick up where it left off.",
      });
    }, STALL_TIMEOUT_MS);
  };

  const startDownload = useCallback(
    async (resumeFrom = 0) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      chunksRef.current = chunksRef.current.slice(0, resumeFrom > 0 ? undefined : 0);
      receivedRef.current = resumeFrom;

      setDlState({ status: "downloading", received: resumeFrom, total: null });

      const headers: Record<string, string> = {};
      if (resumeFrom > 0) {
        headers["Range"] = `bytes=${resumeFrom}-`;
      }

      let total: number | null = null;

      try {
        const res = await fetch(downloadUrl, { headers, signal: ctrl.signal });

        if (!res.ok && res.status !== 206) {
          throw new Error(`Server returned ${res.status} ${res.statusText}`);
        }

        if (resumeFrom > 0 && res.status === 200) {
          chunksRef.current = [];
          receivedRef.current = 0;
        }

        const effectiveOffset = resumeFrom > 0 && res.status === 206 ? resumeFrom : 0;

        const contentLength = res.headers.get("Content-Length");
        if (contentLength) {
          const partial = parseInt(contentLength, 10);
          total = effectiveOffset + partial;
        }

        const contentRange = res.headers.get("Content-Range");
        if (contentRange) {
          const m = contentRange.match(/\/(\d+)$/);
          if (m) total = parseInt(m[1], 10);
        }

        receivedRef.current = effectiveOffset;
        setDlState({ status: "downloading", received: effectiveOffset, total });
        resetStallTimer(effectiveOffset, total);

        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunksRef.current.push(value);
          receivedRef.current += value.byteLength;
          const r = receivedRef.current;
          setDlState({ status: "downloading", received: r, total });
          resetStallTimer(r, total);
        }

        clearStallTimer();

        const allChunks = new Uint8Array(receivedRef.current);
        let offset = 0;
        for (const chunk of chunksRef.current) {
          allChunks.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const blob = new Blob([allChunks]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);

        setDlState({ status: "done" });
        chunksRef.current = [];
        receivedRef.current = 0;
      } catch (err) {
        clearStallTimer();
        if ((err as Error).name === "AbortError") return;
        const received = receivedRef.current;
        setDlState({
          status: "stalled",
          received,
          total,
          error:
            (err as Error).message ||
            "The download failed. Click \"Resume download\" to try again.",
        });
      }
    },
    [downloadUrl, fileName],
  );

  useEffect(() => {
    return () => {
      clearStallTimer();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (dlState.status !== "done") return;
    const t = setTimeout(() => setDlState({ status: "idle" }), 4000);
    return () => clearTimeout(t);
  }, [dlState.status]);

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
                  <div className="font-semibold">Download temporarily unavailable</div>
                  <p className="text-xs mt-1 text-amber-700 dark:text-amber-300/90">
                    The LabTrax Desktop installer is being refreshed. Please check back in a little while, or contact your lab admin.
                  </p>
                </div>
              </div>
            ) : queryFailed ? (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-start gap-2.5 text-sm">
                <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
                <div className="text-destructive flex-1">
                  <div className="font-semibold">Couldn't check for the latest installer</div>
                  <p className="text-xs mt-1 text-destructive/90">
                    {(query.error as Error | undefined)?.message ||
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
              <>
                {dlState.status === "idle" && (
                  <button
                    type="button"
                    onClick={() => startDownload(0)}
                    className="mt-4 inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-5 py-2.5 rounded-md transition-colors"
                  >
                    <Download size={16} />
                    Download {fileName}
                  </button>
                )}

                {dlState.status === "downloading" && (
                  <div className="mt-4">
                    <div className="inline-flex items-center gap-2 text-sm font-medium text-primary">
                      <Loader2 size={15} className="animate-spin" />
                      Downloading {fileName}…
                    </div>
                    <ProgressBar received={dlState.received} total={dlState.total} />
                  </div>
                )}

                {dlState.status === "stalled" && (
                  <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-start gap-2.5 text-sm">
                    <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
                    <div className="text-destructive flex-1">
                      <div className="font-semibold">Download interrupted</div>
                      <p className="text-xs mt-1 text-destructive/90">{dlState.error}</p>
                      {dlState.total && (
                        <p className="text-xs mt-0.5 text-destructive/70">
                          {formatBytes(dlState.received)} of {formatBytes(dlState.total)} received
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => startDownload(dlState.received)}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold underline"
                        >
                          <RefreshCw size={11} />
                          Resume download
                        </button>
                        <button
                          type="button"
                          onClick={() => startDownload(0)}
                          className="inline-flex items-center gap-1.5 text-xs font-medium underline opacity-70"
                        >
                          Start over
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {dlState.status === "done" && (
                  <div className="mt-4 rounded-md border border-green-300 bg-green-50 dark:border-green-800/40 dark:bg-green-950/30 px-4 py-3 flex items-center gap-2.5 text-sm">
                    <CheckCircle2 size={16} className="text-green-600 dark:text-green-400 shrink-0" />
                    <div className="text-green-800 dark:text-green-200">
                      <span className="font-semibold">Downloaded!</span>
                      <span className="text-xs ml-2 text-green-700 dark:text-green-300/90">
                        Check your Downloads folder for {fileName}.
                      </span>
                    </div>
                  </div>
                )}
              </>
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
