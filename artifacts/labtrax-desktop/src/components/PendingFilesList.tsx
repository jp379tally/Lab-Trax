import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  Box,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Film,
  Grid3x3,
  History,
  Image as ImageIcon,
  Inbox,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
import {
  arrayBufferToBase64,
  buildViewerHtml,
  SCAN_DISPLAY_MODES,
  type ScanDisplayMode,
  type ScanFormat,
} from "@workspace/scan-viewer";
import ScanThumbnail from "@/components/ScanThumbnail";
import { apiFetch, ApiError, authedMediaFetch, getAccessToken } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDate, relativeTime } from "@/lib/format";
import type { LabCase } from "@/lib/types";

const SCAN_EXT_TO_FORMAT: Record<string, ScanFormat> = {
  ".ply": "ply",
  ".stl": "stl",
  ".obj": "obj",
};

function detectScanFormat(file: PendingFile): ScanFormat | null {
  const lower = file.fileName.toLowerCase();
  for (const [ext, fmt] of Object.entries(SCAN_EXT_TO_FORMAT)) {
    if (lower.endsWith(ext)) return fmt;
  }
  const mt = (file.mimeType ?? "").toLowerCase();
  if (mt === "model/ply") return "ply";
  if (mt === "model/stl" || mt === "application/sla") return "stl";
  if (mt === "model/obj") return "obj";
  return null;
}

const SCAN_MODE_LABELS: Record<ScanDisplayMode, string> = {
  solid: "Solid",
  wireframe: "Wireframe",
  shaded: "Shaded",
};

function ScanModeIcon({ mode, size = 14 }: { mode: ScanDisplayMode; size?: number }) {
  if (mode === "wireframe") return <Grid3x3 size={size} />;
  if (mode === "shaded") return <Palette size={size} />;
  return <Box size={size} />;
}

function ScanPreview({
  fileUrl,
  fileName,
  format,
}: {
  fileUrl: string;
  fileName: string;
  format: ScanFormat;
}) {
  const [loadState, setLoadState] = useState<
    "downloading" | "rendering" | "error"
  >("downloading");
  const [htmlSource, setHtmlSource] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [displayMode, setDisplayMode] = useState<ScanDisplayMode>("solid");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hasFailed = useRef(false);

  const srcDoc = useMemo(() => htmlSource ?? "", [htmlSource]);

  useEffect(() => {
    hasFailed.current = false;
    setLoadState("downloading");
    setHtmlSource(null);
    setErrorMsg("");
    setDisplayMode("solid");

    const controller = new AbortController();
    (async () => {
      try {
        const res = await authedMediaFetch(fileUrl, {
          signal: controller.signal,
        });
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
  }, [fileUrl, format]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only react to messages from this component's own iframe — otherwise a
      // sibling viewer (e.g. ScanViewerModal on the case-detail page) emitting
      // a parse-error could flip this preview into the error state too.
      const ownWindow = iframeRef.current?.contentWindow;
      if (!ownWindow || e.source !== ownWindow) return;
      if (!e.data || typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data) as { type?: string; message?: string };
        if (msg.type === "error" && !hasFailed.current) {
          hasFailed.current = true;
          setLoadState("error");
          setErrorMsg(
            msg.message === "parse_failed"
              ? "Could not parse this scan file."
              : msg.message || "Could not render the scan file.",
          );
        }
      } catch {
        // ignore non-JSON messages
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function cycleDisplayMode() {
    const i = SCAN_DISPLAY_MODES.indexOf(displayMode);
    const next = SCAN_DISPLAY_MODES[(i + 1) % SCAN_DISPLAY_MODES.length]!;
    setDisplayMode(next);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "setDisplayMode", mode: next },
      "*",
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-3 py-16 px-6 bg-secondary/30 min-h-[20rem]">
        <FileTypeIcon
          mimeType="model/ply"
          className="text-muted-foreground"
        />
        <div>
          <p className="text-sm font-medium">Couldn't render 3D scan</p>
          <p className="text-xs text-muted-foreground mt-1">
            {errorMsg || "An unknown error occurred."}
          </p>
        </div>
        <a
          href={fileUrl}
          download={fileName}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
        >
          <Download size={13} />
          Download file
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-zinc-900 min-h-[20rem]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <button
          type="button"
          onClick={cycleDisplayMode}
          disabled={loadState !== "rendering"}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/15 disabled:opacity-50 text-zinc-100 text-xs font-medium"
          title="Cycle display mode"
          aria-label={`Display mode: ${SCAN_MODE_LABELS[displayMode]}. Click to cycle.`}
        >
          <ScanModeIcon mode={displayMode} />
          {SCAN_MODE_LABELS[displayMode]}
        </button>
        <span className="text-[11px] text-zinc-500 hidden sm:inline">
          Drag to rotate · Shift+drag to pan · Scroll to zoom
        </span>
      </div>
      <div className="relative h-[60vh] max-h-[70vh] bg-zinc-900">
        {loadState === "downloading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 size={28} className="animate-spin" />
            <div className="text-sm">Loading 3D scan…</div>
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
    </div>
  );
}

export interface PendingFile {
  id: string;
  organizationId: string;
  uploaderUserId: string | null;
  uploaderName: string | null;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  notes: string;
  notesUpdatedAt: string | null;
  notesEditedByUserId: string | null;
  notesEditedByName: string | null;
  createdAt: string;
}

function FileTypeIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  if (mimeType === "application/pdf")
    return <FileText size={18} className={className} />;
  if (mimeType.startsWith("video/"))
    return <Film size={18} className={className} />;
  return <ImageIcon size={18} className={className} />;
}

interface AttachDialogProps {
  file: PendingFile;
  onClose: () => void;
  onAttached: () => void;
}

function AttachDialog({ file, onClose, onAttached }: AttachDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  const eligibleCases = useMemo(() => {
    const all = casesQuery.data ?? [];
    return all.filter((c) => c.labOrganizationId === file.organizationId);
  }, [casesQuery.data, file.organizationId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...eligibleCases].sort((a, b) =>
      (b.createdAt || "").localeCompare(a.createdAt || ""),
    );
    if (!q) return sorted.slice(0, 50);
    return sorted
      .filter((c) => {
        const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.toLowerCase();
        return (
          name.includes(q) ||
          (c.caseNumber || "").toLowerCase().includes(q) ||
          (c.doctorName || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [eligibleCases, search]);

  const attachMutation = useMutation({
    mutationFn: async (caseId: string) => {
      await apiFetch(`/lab-pending-files/${file.id}/attach`, {
        method: "POST",
        body: JSON.stringify({ caseId }),
      });
    },
    onSuccess: () => {
      onAttached();
      onClose();
    },
    onError: (e: unknown) => {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not attach this file. Please try again.";
      setError(msg);
    },
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div className="bg-card border border-border rounded-xl shadow-lg w-full max-w-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Attach to a case</h3>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {file.fileName}
          </p>
        </div>
        <div className="p-5 space-y-3">
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by patient, case number, or doctor"
            className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="border border-border rounded-md max-h-72 overflow-y-auto scrollbar-thin">
            {casesQuery.isLoading && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading cases…
              </div>
            )}
            {!casesQuery.isLoading && filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching cases in this lab.
              </div>
            )}
            <ul className="divide-y divide-border">
              {filtered.map((c) => {
                const active = selectedCaseId === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedCaseId(c.id)}
                      className={`w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-secondary/60 ${
                        active ? "bg-primary/10" : ""
                      }`}
                    >
                      <div className="font-mono text-xs text-muted-foreground mt-0.5 shrink-0 w-20 truncate">
                        {c.caseNumber}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {c.patientFirstName} {c.patientLastName}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {c.doctorName}
                          {c.dueDate ? ` · due ${formatDate(c.dueDate)}` : ""}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {error && (
            <div className="text-xs text-destructive flex items-start gap-1.5">
              <XCircle size={13} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md hover:bg-secondary"
            disabled={attachMutation.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => selectedCaseId && attachMutation.mutate(selectedCaseId)}
            disabled={!selectedCaseId || attachMutation.isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {attachMutation.isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Attaching…
              </>
            ) : (
              <>
                <CheckCircle size={13} />
                Attach
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PreviewDialogProps {
  file: PendingFile;
  onClose: () => void;
  onAttachClick: () => void;
  onDelete: () => void;
  onShowHistory: () => void;
  isDeleting: boolean;
  onSaveNotes: (notes: string) => Promise<unknown>;
}

const MIN_IMAGE_SCALE = 1;
const MAX_IMAGE_SCALE = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ImagePreview({ fileUrl, fileName }: { fileUrl: string; fileName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<
    | {
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
      }
    | null
  >(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      setScale((prev) => {
        const next = clamp(prev * factor, MIN_IMAGE_SCALE, MAX_IMAGE_SCALE);
        if (next === prev) return prev;
        if (next === 1) {
          setOffset({ x: 0, y: 0 });
          return next;
        }
        if (anchor) {
          setOffset((o) => ({
            x: anchor.x - ((anchor.x - o.x) * next) / prev,
            y: anchor.y - ((anchor.y - o.y) * next) / prev,
          }));
        }
        return next;
      });
    },
    [],
  );

  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Bind a non-passive wheel listener so we can preventDefault for zoom
  // gestures. Pinch-to-zoom on trackpads arrives as wheel events with
  // ctrlKey=true; holding Cmd/Ctrl with a mouse wheel does the same. Plain
  // two-finger scrolling pans the zoomed image instead of zooming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el) return;
      const isZoomGesture = e.ctrlKey || e.metaKey;
      if (isZoomGesture) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const anchor = {
          x: e.clientX - rect.left - rect.width / 2,
          y: e.clientY - rect.top - rect.height / 2,
        };
        const factor = Math.exp(-e.deltaY * 0.015);
        zoomBy(factor, anchor);
        return;
      }
      // Pan with the wheel/trackpad when zoomed in.
      if (scaleRef.current > 1) {
        e.preventDefault();
        setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  function handleDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (scale > 1) {
      reset();
      return;
    }
    const el = containerRef.current;
    if (!el) {
      setScale(2);
      return;
    }
    const rect = el.getBoundingClientRect();
    const anchor = {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    };
    zoomBy(2, anchor);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (scale <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setIsDragging(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOffset({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — pointer may already be released
    }
    dragRef.current = null;
    setIsDragging(false);
  }

  return (
    <div className="relative bg-black/5 dark:bg-black/30 h-[70vh]">
      <div
        ref={containerRef}
        onDoubleClick={handleDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="w-full h-full overflow-hidden flex items-center justify-center select-none"
        style={{ cursor: scale > 1 ? (isDragging ? "grabbing" : "grab") : "zoom-in", touchAction: "none" }}
      >
        <img
          src={fileUrl}
          alt={fileName}
          draggable={false}
          className="max-w-full max-h-[70vh] object-contain pointer-events-none"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: isDragging ? "none" : "transform 120ms ease-out",
          }}
        />
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-card/95 border border-border rounded-md shadow-sm px-1 py-1 text-xs">
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.5)}
          disabled={scale <= MIN_IMAGE_SCALE}
          className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center disabled:opacity-40"
          aria-label="Zoom out"
        >
          <Minus size={13} />
        </button>
        <span className="tabular-nums w-12 text-center text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(1.5)}
          disabled={scale >= MAX_IMAGE_SCALE}
          className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center disabled:opacity-40"
          aria-label="Zoom in"
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={scale === 1 && offset.x === 0 && offset.y === 0}
          className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center disabled:opacity-40"
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  );
}

function PdfPreview({ fileUrl, fileName }: { fileUrl: string; fileName: string }) {
  const fileProp = useMemo(() => ({ url: fileUrl }), [fileUrl]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setPageInput(String(pageNumber));
  }, [pageNumber]);

  // Reset paging state when the source file changes so we don't briefly
  // show "page 7 of 3" while the new document loads.
  useEffect(() => {
    setNumPages(0);
    setPageNumber(1);
    setPageInput("1");
    setError(null);
  }, [fileUrl]);

  function commitPageInput() {
    const next = parseInt(pageInput, 10);
    if (Number.isFinite(next) && numPages > 0) {
      setPageNumber(clamp(next, 1, numPages));
    } else {
      setPageInput(String(pageNumber));
    }
  }

  const pageWidth = clamp(width - 32, 320, 1100);

  return (
    <div className="flex flex-col h-[70vh] bg-black/5 dark:bg-black/30">
      <div
        ref={containerRef}
        className="flex-1 overflow-auto flex items-start justify-center py-4 px-4"
      >
        {error ? (
          <div className="text-sm text-destructive flex items-start gap-1.5 mt-8">
            <XCircle size={14} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : (
          <Document
            file={fileProp}
            onLoadSuccess={({ numPages: n }) => {
              setNumPages(n);
              setError(null);
              setPageNumber((p) => clamp(p, 1, n));
            }}
            onLoadError={(e) => {
              setError(
                e?.message
                  ? `Could not load PDF: ${e.message}`
                  : "Could not load this PDF.",
              );
            }}
            loading={
              <div className="text-sm text-muted-foreground mt-8 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Loading PDF…
              </div>
            }
            error={
              <div className="text-sm text-destructive mt-8 flex items-start gap-1.5">
                <XCircle size={14} className="mt-0.5 shrink-0" />
                Could not load this PDF.
              </div>
            }
          >
            <Page
              key={`page-${pageNumber}`}
              pageNumber={pageNumber}
              width={pageWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="shadow-md bg-white"
            />
          </Document>
        )}
      </div>
      {numPages > 0 && !error && (
        <div className="border-t border-border bg-card/80 px-3 py-2 flex items-center justify-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
            disabled={pageNumber <= 1}
            className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-muted-foreground">Page</span>
          <input
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commitPageInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageInput();
              }
            }}
            className="h-7 w-12 text-center rounded border border-border bg-background tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
            aria-label={`Page number, ${pageNumber} of ${numPages}`}
          />
          <span className="text-muted-foreground">of {numPages}</span>
          <button
            type="button"
            onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
            disabled={pageNumber >= numPages}
            className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </button>
          <span className="mx-1 text-muted-foreground/50">·</span>
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="h-7 px-2 rounded hover:bg-secondary flex items-center gap-1 text-muted-foreground"
            title={`Open ${fileName} in a new tab`}
          >
            <ExternalLink size={12} />
            Open
          </a>
        </div>
      )}
    </div>
  );
}

function PreviewBody({ file }: { file: PendingFile }) {
  const { mimeType, fileUrl, fileName } = file;

  const scanFormat = detectScanFormat(file);
  if (scanFormat) {
    return (
      <ScanPreview fileUrl={fileUrl} fileName={fileName} format={scanFormat} />
    );
  }

  if (mimeType.startsWith("image/")) {
    return <ImagePreview fileUrl={fileUrl} fileName={fileName} />;
  }

  if (mimeType === "application/pdf") {
    return <PdfPreview fileUrl={fileUrl} fileName={fileName} />;
  }

  if (mimeType.startsWith("video/")) {
    return (
      <div className="flex items-center justify-center bg-black min-h-[20rem] max-h-[70vh]">
        <video
          src={fileUrl}
          controls
          className="max-w-full max-h-[70vh]"
        >
          <track kind="captions" />
        </video>
      </div>
    );
  }

  if (mimeType.startsWith("audio/")) {
    return (
      <div className="flex items-center justify-center bg-secondary/40 py-12 px-6">
        <audio src={fileUrl} controls className="w-full max-w-md" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-16 px-6 bg-secondary/30">
      <FileTypeIcon
        mimeType={mimeType}
        className="text-muted-foreground"
      />
      <div>
        <p className="text-sm font-medium">No inline preview available</p>
        <p className="text-xs text-muted-foreground mt-1">
          This file type ({mimeType || "unknown"}) can't be previewed here.
        </p>
      </div>
      <a
        href={fileUrl}
        download={fileName}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
      >
        <Download size={13} />
        Download file
      </a>
    </div>
  );
}

function PreviewDialog({
  file,
  onClose,
  onAttachClick,
  onDelete,
  onShowHistory,
  isDeleting,
  onSaveNotes,
}: PreviewDialogProps) {
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(file.notes ?? "");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  useEffect(() => {
    if (!isEditingNotes) {
      setNotesValue(file.notes ?? "");
    }
  }, [file.notes, isEditingNotes]);

  function startEditingNotes() {
    setNotesValue(file.notes ?? "");
    setNotesError(null);
    setIsEditingNotes(true);
  }

  function cancelEditingNotes() {
    setIsEditingNotes(false);
    setNotesValue(file.notes ?? "");
    setNotesError(null);
  }

  async function saveNotes() {
    const trimmed = notesValue.trim();
    if (trimmed === (file.notes ?? "").trim()) {
      setIsEditingNotes(false);
      return;
    }
    setIsSavingNotes(true);
    setNotesError(null);
    try {
      await onSaveNotes(trimmed);
      setIsEditingNotes(false);
    } catch (e: unknown) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not save the note. Please try again.";
      setNotesError(msg);
    } finally {
      setIsSavingNotes(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isEditingNotes) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isEditingNotes]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3.5 border-b border-border flex items-start gap-3">
          {(() => {
            const fmt = detectScanFormat(file);
            if (fmt) {
              return (
                <ScanThumbnail
                  cacheKey={`inbox:${file.id}`}
                  fileUrl={file.fileUrl}
                  format={fmt}
                  authToken={getAccessToken()}
                  size={28}
                />
              );
            }
            return (
              <div className="mt-0.5 shrink-0 text-muted-foreground">
                <FileTypeIcon mimeType={file.mimeType} />
              </div>
            );
          })()}
          <div className="min-w-0 flex-1">
            <h3
              className="text-sm font-semibold truncate"
              title={file.fileName}
            >
              {file.fileName}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {file.uploaderName || "Unknown uploader"} ·{" "}
              {relativeTime(file.createdAt)} ·{" "}
              <span className="uppercase tracking-wide">
                {file.mimeType.split("/")[1] || file.mimeType}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground shrink-0"
            aria-label="Close preview"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          <div className="flex-1 min-w-0 overflow-auto">
            <PreviewBody file={file} />
          </div>
          <aside className="w-full md:w-72 md:border-l border-t md:border-t-0 border-border bg-card flex flex-col">
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Notes
                </h4>
                {!isEditingNotes && (
                  <button
                    type="button"
                    onClick={startEditingNotes}
                    className="h-7 px-2 rounded-md text-xs font-medium hover:bg-secondary inline-flex items-center gap-1 text-foreground"
                    title={file.notes ? "Edit note" : "Add note"}
                  >
                    <Pencil size={12} />
                    {file.notes ? "Edit" : "Add"}
                  </button>
                )}
              </div>
              {isEditingNotes ? (
                <div className="mt-1.5 space-y-1.5">
                  <textarea
                    autoFocus
                    value={notesValue}
                    onChange={(e) => setNotesValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditingNotes();
                      } else if (
                        e.key === "Enter" &&
                        (e.metaKey || e.ctrlKey)
                      ) {
                        e.preventDefault();
                        void saveNotes();
                      }
                    }}
                    rows={5}
                    placeholder="Add a note for your team…"
                    className="w-full px-2.5 py-1.5 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                    disabled={isSavingNotes}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void saveNotes()}
                      disabled={
                        isSavingNotes ||
                        notesValue.trim() === (file.notes ?? "").trim()
                      }
                      className="h-7 px-2.5 rounded-md text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {isSavingNotes ? (
                        <>
                          <Loader2 size={12} className="animate-spin" />
                          Saving…
                        </>
                      ) : (
                        "Save"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditingNotes}
                      disabled={isSavingNotes}
                      className="h-7 px-2.5 rounded-md text-xs hover:bg-secondary"
                    >
                      Cancel
                    </button>
                  </div>
                  {notesError && (
                    <div className="text-xs text-destructive inline-flex items-start gap-1">
                      <XCircle size={12} className="mt-0.5 shrink-0" />
                      {notesError}
                    </div>
                  )}
                </div>
              ) : file.notes ? (
                <p className="text-sm text-foreground/90 mt-1.5 whitespace-pre-wrap break-words">
                  {file.notes}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-1.5 italic">
                  No notes added.
                </p>
              )}
              {file.notesUpdatedAt && (
                <button
                  type="button"
                  onClick={onShowHistory}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  <History size={11} />
                  View edit history
                </button>
              )}
            </div>
            <div className="px-4 py-3 flex-1">
              <a
                href={file.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink size={12} />
                Open in new tab
              </a>
            </div>
          </aside>
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            className="px-3 py-1.5 text-sm rounded-md text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md hover:bg-secondary"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onAttachClick}
              className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center gap-1.5"
            >
              <Link2 size={13} />
              Attach to case
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

interface NoteEdit {
  id: string;
  editorUserId: string;
  editorName: string | null;
  oldNotes: string;
  newNotes: string;
  createdAt: string;
}

interface NoteHistoryDialogProps {
  file: PendingFile;
  onClose: () => void;
}

function NoteHistoryDialog({ file, onClose }: NoteHistoryDialogProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const historyQuery = useQuery({
    queryKey: ["lab-pending-files", file.id, "note-history"],
    queryFn: async () => {
      const res = await apiFetch<{ edits: NoteEdit[] }>(
        `/lab-pending-files/${file.id}/note-history`,
      );
      return res?.edits ?? [];
    },
  });

  const edits = historyQuery.data ?? [];

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3.5 border-b border-border flex items-start gap-3">
          <History size={16} className="text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Note edit history</h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {file.fileName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground shrink-0"
            aria-label="Close history"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {historyQuery.isLoading && (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              Loading history…
            </div>
          )}
          {historyQuery.isError && !historyQuery.isLoading && (
            <div className="px-5 py-10 text-center text-sm text-destructive">
              Could not load edit history.
            </div>
          )}
          {!historyQuery.isLoading &&
            !historyQuery.isError &&
            edits.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                No edits yet.
              </div>
            )}
          {edits.length > 0 && (
            <ol className="divide-y divide-border">
              {edits.map((edit) => (
                <li key={edit.id} className="px-5 py-3.5 space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">
                      {edit.editorName || "Unknown editor"}
                    </span>
                    <span
                      className="text-[11px] text-muted-foreground shrink-0"
                      title={new Date(edit.createdAt).toLocaleString()}
                    >
                      {relativeTime(edit.createdAt)}
                    </span>
                  </div>
                  <div className="grid gap-2 text-xs">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5">
                        Before
                      </div>
                      <div className="rounded-md bg-secondary/40 px-2.5 py-1.5 whitespace-pre-wrap break-words text-foreground/80">
                        {edit.oldNotes ? (
                          edit.oldNotes
                        ) : (
                          <span className="italic text-muted-foreground">
                            (empty)
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5">
                        After
                      </div>
                      <div className="rounded-md bg-primary/5 px-2.5 py-1.5 whitespace-pre-wrap break-words text-foreground/90">
                        {edit.newNotes ? (
                          edit.newNotes
                        ) : (
                          <span className="italic text-muted-foreground">
                            (empty)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export function PendingFilesList() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [attachTarget, setAttachTarget] = useState<PendingFile | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PendingFile | null>(null);
  const [historyTarget, setHistoryTarget] = useState<PendingFile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startEdit(file: PendingFile) {
    setEditingId(file.id);
    setEditValue(file.notes ?? "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
    setEditError(null);
  }

  function flashError(msg: string) {
    setActionError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setActionError(null), 4000);
  }

  useEffect(
    () => () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    },
    [],
  );

  const filesQuery = useQuery({
    queryKey: ["lab-pending-files"],
    queryFn: async () => {
      const res = await apiFetch<{ files: PendingFile[] }>(
        "/lab-pending-files",
      );
      return res?.files ?? [];
    },
    enabled: !!user,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const updateNotesMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      const res = await apiFetch<{
        success: boolean;
        notesUpdatedAt: string | null;
        notesEditedByUserId: string | null;
        notesEditedByName: string | null;
      }>(`/lab-pending-files/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      });
      return { notes, meta: res };
    },
    onMutate: async ({ id, notes }) => {
      await queryClient.cancelQueries({ queryKey: ["lab-pending-files"] });
      const previous = queryClient.getQueryData<PendingFile[]>([
        "lab-pending-files",
      ]);
      queryClient.setQueryData<PendingFile[]>(
        ["lab-pending-files"],
        (prev) =>
          prev?.map((f) => (f.id === id ? { ...f, notes } : f)) ?? prev,
      );
      setPreviewTarget((prev) =>
        prev && prev.id === id ? { ...prev, notes } : prev,
      );
      return { previous };
    },
    onSuccess: ({ notes, meta }, { id }) => {
      queryClient.setQueryData<PendingFile[]>(
        ["lab-pending-files"],
        (prev) =>
          prev?.map((f) =>
            f.id === id
              ? {
                  ...f,
                  notes,
                  notesUpdatedAt: meta?.notesUpdatedAt ?? f.notesUpdatedAt,
                  notesEditedByUserId:
                    meta?.notesEditedByUserId ?? f.notesEditedByUserId,
                  notesEditedByName:
                    meta?.notesEditedByName ?? f.notesEditedByName,
                }
              : f,
          ) ?? prev,
      );
      setPreviewTarget((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              notes,
              notesUpdatedAt: meta?.notesUpdatedAt ?? prev.notesUpdatedAt,
              notesEditedByUserId:
                meta?.notesEditedByUserId ?? prev.notesEditedByUserId,
              notesEditedByName:
                meta?.notesEditedByName ?? prev.notesEditedByName,
            }
          : prev,
      );
      queryClient.invalidateQueries({ queryKey: ["lab-pending-files"] });
      queryClient.invalidateQueries({
        queryKey: ["lab-pending-files", id, "note-history"],
      });
      cancelEdit();
    },
    onError: (e: unknown, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(["lab-pending-files"], ctx.previous);
        const restored = ctx.previous.find(
          (f) => f.id === (previewTarget?.id ?? ""),
        );
        if (restored) setPreviewTarget(restored);
      }
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not save the note. Please try again.";
      setEditError(msg);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["lab-pending-files"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/lab-pending-files/${id}`, { method: "DELETE" });
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["lab-pending-files"] });
      const previous = queryClient.getQueryData<PendingFile[]>([
        "lab-pending-files",
      ]);
      queryClient.setQueryData<PendingFile[]>(
        ["lab-pending-files"],
        (prev) => prev?.filter((f) => f.id !== id) ?? [],
      );
      return { previous };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(["lab-pending-files"], ctx.previous);
      }
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not delete the file.";
      flashError(msg);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["lab-pending-files"] });
    },
  });

  const files = filesQuery.data ?? [];
  const isLoading = filesQuery.isLoading;
  const isFetching = filesQuery.isFetching && !isLoading;

  // Keep the preview target in sync when the underlying list refreshes
  // (e.g. after attaching, the file disappears and we should close the modal).
  useEffect(() => {
    if (!previewTarget) return;
    const stillExists = files.some((f) => f.id === previewTarget.id);
    if (!stillExists) setPreviewTarget(null);
  }, [files, previewTarget]);

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Inbox size={14} className="text-muted-foreground" />
            Shared file inbox
            <span className="text-xs font-normal text-muted-foreground">
              ({files.length})
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Files uploaded by your team that haven't been attached to a case yet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => filesQuery.refetch()}
          className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
          aria-label="Refresh inbox"
          disabled={isFetching}
        >
          <RefreshCw
            size={14}
            className={isFetching ? "animate-spin" : ""}
          />
        </button>
      </header>

      {actionError && (
        <div className="px-5 py-2 bg-destructive/10 text-destructive text-xs flex items-start gap-2 border-b border-border">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          {actionError}
        </div>
      )}

      <div>
        {isLoading && (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            Loading inbox…
          </div>
        )}
        {!isLoading && files.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            No pending files. Drop something above to share it with your team.
          </div>
        )}
        {!isLoading && files.length > 0 && (
          <ul className="divide-y divide-border">
            {files.map((f) => (
              <li key={f.id} className="px-5 py-3.5 flex items-start gap-3 hover:bg-secondary/30">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setPreviewTarget(f)}
                    className="flex items-start gap-3 w-full text-left"
                    title={`Preview ${f.fileName}`}
                  >
                    {(() => {
                      const fmt = detectScanFormat(f);
                      if (fmt) {
                        return (
                          <ScanThumbnail
                            cacheKey={`inbox:${f.id}`}
                            fileUrl={f.fileUrl}
                            format={fmt}
                            authToken={getAccessToken()}
                            size={28}
                          />
                        );
                      }
                      return (
                        <span className="mt-0.5 shrink-0 text-muted-foreground">
                          <FileTypeIcon mimeType={f.mimeType} />
                        </span>
                      );
                    })()}
                    <span className="min-w-0 flex-1 block">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          className="text-sm font-medium truncate hover:underline"
                          title={f.fileName}
                        >
                          {f.fileName}
                        </span>
                        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
                          {f.mimeType.split("/")[1] || f.mimeType}
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {f.uploaderName || "Unknown uploader"} ·{" "}
                        {relativeTime(f.createdAt)}
                      </span>
                    </span>
                  </button>
                  {editingId === f.id ? (
                    <div className="mt-1.5 ml-[30px] space-y-1.5">
                      <textarea
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          } else if (
                            e.key === "Enter" &&
                            (e.metaKey || e.ctrlKey)
                          ) {
                            e.preventDefault();
                            updateNotesMutation.mutate({
                              id: f.id,
                              notes: editValue.trim(),
                            });
                          }
                        }}
                        rows={3}
                        placeholder="Add a note for your team…"
                        className="w-full px-2.5 py-1.5 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                        disabled={updateNotesMutation.isPending}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            updateNotesMutation.mutate({
                              id: f.id,
                              notes: editValue.trim(),
                            })
                          }
                          disabled={
                            updateNotesMutation.isPending ||
                            editValue.trim() === (f.notes ?? "").trim()
                          }
                          className="h-7 px-2.5 rounded-md text-xs font-medium bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-1.5"
                        >
                          {updateNotesMutation.isPending ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              Saving…
                            </>
                          ) : (
                            "Save"
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={updateNotesMutation.isPending}
                          className="h-7 px-2.5 rounded-md text-xs hover:bg-secondary"
                        >
                          Cancel
                        </button>
                        {editError && (
                          <span className="text-xs text-destructive inline-flex items-start gap-1">
                            <XCircle size={12} className="mt-0.5 shrink-0" />
                            {editError}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : f.notes ? (
                    <div className="ml-[30px]">
                      <div className="text-xs text-foreground/80 mt-1 whitespace-pre-wrap break-words">
                        {f.notes}
                      </div>
                      {f.notesUpdatedAt && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 italic flex items-center gap-1.5 flex-wrap">
                          <span>
                            edited by {f.notesEditedByName || "someone"} ·{" "}
                            {relativeTime(f.notesUpdatedAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() => setHistoryTarget(f)}
                            className="inline-flex items-center gap-1 not-italic hover:text-foreground hover:underline"
                            title="View full edit history"
                          >
                            <History size={11} />
                            View history
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  {editingId !== f.id && (
                    <button
                      type="button"
                      onClick={() => startEdit(f)}
                      className="h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary inline-flex items-center gap-1.5 text-foreground"
                      title={f.notes ? "Edit note" : "Add note"}
                    >
                      <Pencil size={13} />
                      {f.notes ? "Edit note" : "Add note"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAttachTarget(f)}
                    className="h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary inline-flex items-center gap-1.5 text-foreground"
                    title="Attach to a case"
                  >
                    <Link2 size={13} />
                    Attach
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${f.fileName}" from the inbox? This cannot be undone.`,
                        )
                      ) {
                        deleteMutation.mutate(f.id);
                      }
                    }}
                    className="h-8 w-8 rounded-md hover:bg-destructive/10 hover:text-destructive flex items-center justify-center text-muted-foreground"
                    aria-label={`Delete ${f.fileName}`}
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {previewTarget && (
        <PreviewDialog
          file={previewTarget}
          onClose={() => setPreviewTarget(null)}
          onAttachClick={() => setAttachTarget(previewTarget)}
          onShowHistory={() => setHistoryTarget(previewTarget)}
          onDelete={() => {
            if (
              window.confirm(
                `Delete "${previewTarget.fileName}" from the inbox? This cannot be undone.`,
              )
            ) {
              deleteMutation.mutate(previewTarget.id, {
                onSuccess: () => setPreviewTarget(null),
              });
            }
          }}
          isDeleting={
            deleteMutation.isPending &&
            deleteMutation.variables === previewTarget.id
          }
          onSaveNotes={(notes) =>
            updateNotesMutation.mutateAsync({
              id: previewTarget.id,
              notes,
            })
          }
        />
      )}

      {attachTarget && (
        <AttachDialog
          file={attachTarget}
          onClose={() => setAttachTarget(null)}
          onAttached={() => {
            queryClient.invalidateQueries({
              queryKey: ["lab-pending-files"],
            });
          }}
        />
      )}

      {historyTarget && (
        <NoteHistoryDialog
          file={historyTarget}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </section>
  );
}
