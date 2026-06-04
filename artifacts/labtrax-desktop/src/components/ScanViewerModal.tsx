import { useEffect, useMemo, useRef, useState } from "react";
import { X, Loader2, AlertCircle, ExternalLink, Box, Grid3x3, Palette, Locate } from "lucide-react";
import {
  arrayBufferToBase64,
  buildViewerHtml,
  SCAN_DISPLAY_MODES,
  type ScanDisplayMode,
  type ScanFormat,
} from "@workspace/scan-viewer";
import { authedMediaFetch } from "@/lib/api";

interface ScanViewerModalProps {
  open: boolean;
  fileUrl: string;
  fileName: string;
  format: ScanFormat;
  authToken?: string | null;
  onClose: () => void;
  onFallback: () => void;
}

type LoadState = "downloading" | "rendering" | "error";

const MODE_LABELS: Record<ScanDisplayMode, string> = {
  solid: "Solid",
  wireframe: "Wireframe",
  shaded: "Shaded",
};

function ModeIcon({ mode, size = 16 }: { mode: ScanDisplayMode; size?: number }) {
  if (mode === "wireframe") return <Grid3x3 size={size} />;
  if (mode === "shaded") return <Palette size={size} />;
  return <Box size={size} />;
}

export default function ScanViewerModal({
  open,
  fileUrl,
  fileName,
  format,
  authToken,
  onClose,
  onFallback,
}: ScanViewerModalProps) {
  const [loadState, setLoadState] = useState<LoadState>("downloading");
  const [htmlSource, setHtmlSource] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [displayMode, setDisplayMode] = useState<ScanDisplayMode>("solid");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hasFallenBack = useRef(false);

  // Stable srcDoc reference so the iframe doesn't re-mount on parent re-renders.
  const srcDoc = useMemo(() => htmlSource ?? "", [htmlSource]);

  useEffect(() => {
    if (!open) return;
    hasFallenBack.current = false;
    setLoadState("downloading");
    setHtmlSource(null);
    setErrorMsg("");
    setDisplayMode("solid");

    const controller = new AbortController();
    (async () => {
      try {
        void authToken; // auth (incl. 401 refresh) handled by authedMediaFetch
        const res = await authedMediaFetch(fileUrl, { signal: controller.signal });
        if (!res.ok) {
          setLoadState("error");
          setErrorMsg(`Download failed (status ${res.status}).`);
          return;
        }
        const buffer = await res.arrayBuffer();
        if (controller.signal.aborted) return;
        const base64 = arrayBufferToBase64(buffer);
        setHtmlSource(buildViewerHtml(base64, format));
        setLoadState("rendering");
      } catch (err) {
        if (controller.signal.aborted) return;
        setLoadState("error");
        setErrorMsg(
          err instanceof Error ? err.message : "Could not load the scan file.",
        );
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, fileUrl, format, authToken]);

  // Listen for parse-error messages from the iframe
  useEffect(() => {
    if (!open) return;
    function onMessage(e: MessageEvent) {
      if (!e.data || typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data) as { type?: string };
        if (msg.type === "error" && !hasFallenBack.current) {
          hasFallenBack.current = true;
          onClose();
          onFallback();
        }
      } catch {
        // ignore non-JSON messages
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, onClose, onFallback]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function cycleDisplayMode() {
    const i = SCAN_DISPLAY_MODES.indexOf(displayMode);
    const next = SCAN_DISPLAY_MODES[(i + 1) % SCAN_DISPLAY_MODES.length]!;
    setDisplayMode(next);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "setDisplayMode", mode: next },
      "*",
    );
  }

  function handleResetView() {
    iframeRef.current?.contentWindow?.postMessage({ type: "resetView" }, "*");
  }

  function handleFallback() {
    if (!hasFallenBack.current) {
      hasFallenBack.current = true;
      onClose();
      onFallback();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-zinc-900"
      role="dialog"
      aria-modal="true"
      aria-label={`3D viewer for ${fileName}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <div className="flex-1 min-w-0 text-sm font-semibold text-zinc-100 truncate" title={fileName}>
          {fileName}
        </div>
        {loadState === "rendering" && (
          <button
            type="button"
            onClick={handleResetView}
            className="h-8 w-8 rounded-full bg-white/10 hover:bg-white/15 text-zinc-100 flex items-center justify-center"
            title="Reset view"
            aria-label="Reset view"
          >
            <Locate size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 rounded-full bg-white/10 hover:bg-white/15 text-zinc-100 flex items-center justify-center"
          title="Close (Esc)"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 relative bg-zinc-900">
        {loadState === "downloading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 size={28} className="animate-spin" />
            <div className="text-sm">Loading scan…</div>
          </div>
        )}

        {loadState === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
            <AlertCircle size={40} className="text-red-400" />
            <div className="text-sm text-red-300">{errorMsg || "Could not load the scan file."}</div>
            <button
              type="button"
              onClick={handleFallback}
              className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-md"
            >
              <ExternalLink size={14} />
              Open externally
            </button>
          </div>
        )}

        {loadState === "rendering" && htmlSource && (
          <iframe
            ref={iframeRef}
            title={`3D viewer: ${fileName}`}
            srcDoc={srcDoc}
            sandbox="allow-scripts"
            className="absolute inset-0 w-full h-full border-0 bg-zinc-900"
          />
        )}
      </div>

      {/* Footer */}
      {loadState === "rendering" && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-white/10">
          <button
            type="button"
            onClick={cycleDisplayMode}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-zinc-100 text-xs font-medium"
            title="Cycle display mode"
            aria-label={`Display mode: ${MODE_LABELS[displayMode]}. Click to cycle.`}
          >
            <ModeIcon mode={displayMode} />
            {MODE_LABELS[displayMode]}
          </button>
          <div className="text-[11px] text-zinc-500 ml-1 hidden sm:block">
            Drag to rotate · Shift+drag or right-click to pan · Scroll to zoom
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleFallback}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            title="Open with default app"
          >
            <ExternalLink size={13} />
            Open externally
          </button>
        </div>
      )}
    </div>
  );
}
