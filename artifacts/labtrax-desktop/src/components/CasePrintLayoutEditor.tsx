// Advanced case-print-label layout editor (v2, element-based).
//
// Modal opened from the basic PrintLayoutEditor's "Advanced layout…" button.
// Every case info field (case number, patient, doctor, due date, priority,
// restorative type, teeth, material, shade, prescription notes, tooth chart,
// barcode) is its own independently positionable / resizable element with
// Word-style typography (font family, numeric font size, bold, italic,
// alignment). Uploaded images (logos, signatures, stamps) are elements too.
//
// State flow:
//   - Loads the per-lab template from GET /organizations/:orgId/case-print-template
//   - Edits happen in a local `draft` (dirty flag tracks changes)
//   - "Save" PUTs the draft; closing while dirty prompts to keep changes.
//   - Uploaded images are persisted immediately on POST so a discarded
//     session may leave orphan App Storage objects — bounded by 8 images.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Eye,
  EyeOff,
  Grid2X2,
  ImageIcon,
  Italic,
  Loader2,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  buildAnatomicalToothChartSvg,
  fetchTemplateImageAsDataUrl,
} from "@/lib/print";
import { useAuth } from "@/lib/auth-context";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  DEFAULT_FONT_FAMILY,
  ELEMENT_COLORS,
  ELEMENT_LABELS,
  FONT_FAMILIES,
  isSameTemplate,
  isTextKind,
  makeImageElement,
  PAGE_H,
  PAGE_W,
  type CasePrintElement,
  type CasePrintTemplate,
  type ElementAlign,
} from "@/lib/case-print-template";

interface TemplateApi {
  template: CasePrintTemplate;
  isCustom: boolean;
  defaultTemplate: CasePrintTemplate;
}

interface UploadedImage {
  id: string;
  url: string;
  storageKey: string;
  contentType: string;
  size: number;
}

type Box = { x: number; y: number; w: number; h: number };
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface DragState {
  id: string;
  handle: Handle;
  startX: number;
  startY: number;
  startBox: Box;
  scaleX: number;
  scaleY: number;
}

const MAX_IMAGES = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Snap helpers ──────────────────────────────────────────────────────

const SNAP_THRESHOLD = 7; // page-coordinate pixels within which alignment snap fires

function snapToGrid(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

function applyGridSnap(box: Box, handle: Handle, grid: number): Box {
  let { x, y, w, h } = box;
  if (handle === "move") {
    x = snapToGrid(x, grid);
    y = snapToGrid(y, grid);
  } else {
    if (handle.includes("w")) {
      const newX = snapToGrid(x, grid);
      w = Math.max(20, x + w - newX);
      x = newX;
    }
    if (handle.includes("e")) {
      w = Math.max(20, snapToGrid(x + w, grid) - x);
    }
    if (handle.includes("n")) {
      const newY = snapToGrid(y, grid);
      h = Math.max(14, y + h - newY);
      y = newY;
    }
    if (handle.includes("s")) {
      h = Math.max(14, snapToGrid(y + h, grid) - y);
    }
  }
  return { x, y, w, h };
}

/** Collect x/y reference positions from other elements for alignment. */
function buildAlignRefs(
  elements: CasePrintElement[],
  excludeId: string,
): { x: number[]; y: number[] } {
  const xs = new Set<number>([0, PAGE_W / 2, PAGE_W]);
  const ys = new Set<number>([0, PAGE_H / 2, PAGE_H]);
  for (const el of elements) {
    if (el.id === excludeId || !el.visible) continue;
    xs.add(el.x);
    xs.add(el.x + el.w);
    xs.add(el.x + el.w / 2);
    ys.add(el.y);
    ys.add(el.y + el.h);
    ys.add(el.y + el.h / 2);
  }
  return { x: [...xs], y: [...ys] };
}

function snapEdge(
  edge: number,
  refs: number[],
  threshold: number,
): { snapped: number; guide: number | null } {
  let bestD = threshold + 1;
  let result = edge;
  let guide: number | null = null;
  for (const ref of refs) {
    const d = Math.abs(edge - ref);
    if (d < bestD) {
      bestD = d;
      result = ref;
      guide = ref;
    }
  }
  return { snapped: result, guide };
}

function snapMoveAxis(
  pos: number,
  size: number,
  refs: number[],
  threshold: number,
): { pos: number; guides: number[] } {
  const candidates: Array<{ edge: number; anchor: number }> = [
    { edge: pos, anchor: 0 },
    { edge: pos + size / 2, anchor: size / 2 },
    { edge: pos + size, anchor: size },
  ];
  let bestD = threshold + 1;
  let result = pos;
  const guides: number[] = [];
  for (const { edge, anchor } of candidates) {
    const { snapped, guide } = snapEdge(edge, refs, threshold);
    if (guide !== null) {
      const d = Math.abs(edge - snapped);
      if (d < bestD - 0.01) {
        bestD = d;
        result = snapped - anchor;
        guides.length = 0;
        guides.push(guide);
      } else if (d < bestD + 0.01) {
        guides.push(guide);
      }
    }
  }
  return { pos: result, guides };
}

interface AlignSnapResult {
  box: Box;
  guides: { x: number[]; y: number[] };
}

function applyAlignmentSnap(
  box: Box,
  handle: Handle,
  refs: { x: number[]; y: number[] },
  threshold: number,
): AlignSnapResult {
  let { x, y, w, h } = box;
  const xGuides: number[] = [];
  const yGuides: number[] = [];

  if (handle === "move") {
    const xResult = snapMoveAxis(x, w, refs.x, threshold);
    const yResult = snapMoveAxis(y, h, refs.y, threshold);
    x = xResult.pos;
    y = yResult.pos;
    xGuides.push(...xResult.guides);
    yGuides.push(...yResult.guides);
  } else {
    if (handle.includes("w")) {
      const { snapped, guide } = snapEdge(x, refs.x, threshold);
      w = Math.max(20, x + w - snapped);
      x = snapped;
      if (guide !== null) xGuides.push(guide);
    }
    if (handle.includes("e")) {
      const { snapped, guide } = snapEdge(x + w, refs.x, threshold);
      w = Math.max(20, snapped - x);
      if (guide !== null) xGuides.push(guide);
    }
    if (handle.includes("n")) {
      const { snapped, guide } = snapEdge(y, refs.y, threshold);
      h = Math.max(14, y + h - snapped);
      y = snapped;
      if (guide !== null) yGuides.push(guide);
    }
    if (handle.includes("s")) {
      const { snapped, guide } = snapEdge(y + h, refs.y, threshold);
      h = Math.max(14, snapped - y);
      if (guide !== null) yGuides.push(guide);
    }
  }

  return {
    box: { x, y, w, h },
    guides: { x: [...new Set(xGuides)], y: [...new Set(yGuides)] },
  };
}

function applyDrag(start: Box, h: Handle, dx: number, dy: number): Box {
  let { x, y, w, h: bh } = start;
  if (h === "move") {
    x += dx;
    y += dy;
  } else {
    if (h.includes("n")) {
      y += dy;
      bh -= dy;
    }
    if (h.includes("s")) {
      bh += dy;
    }
    if (h.includes("w")) {
      x += dx;
      w -= dx;
    }
    if (h.includes("e")) {
      w += dx;
    }
  }
  w = Math.max(20, w);
  bh = Math.max(14, bh);
  x = clamp(x, 0, PAGE_W - w);
  y = clamp(y, 0, PAGE_H - bh);
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(bh),
  };
}

interface CasePrintLayoutEditorProps {
  onClose: () => void;
  /**
   * Called with the active template after save so the parent renderer can
   * immediately use it for the next print. Null = reset to defaults.
   */
  onTemplateSaved?: (template: CasePrintTemplate | null) => void;
}

export function CasePrintLayoutEditor({
  onClose,
  onTemplateSaved,
}: CasePrintLayoutEditorProps) {
  const { user } = useAuth() as {
    user: {
      practiceOrganizationId?: string | null;
      role?: string | null;
    } | null;
  };
  const orgId = user?.practiceOrganizationId ?? null;
  const isAdmin = user?.role === "admin";
  const qc = useQueryClient();

  const query = useQuery<TemplateApi>({
    enabled: !!orgId,
    queryKey: ["casePrintTemplate", orgId],
    queryFn: async () => {
      const res = await apiFetch<{ data: TemplateApi } | TemplateApi>(
        `/organizations/${orgId}/case-print-template`,
      );
      return (
        (res as unknown as { data?: TemplateApi }).data ?? (res as TemplateApi)
      );
    },
  });

  const [draft, setDraft] = useState<CasePrintTemplate>(
    DEFAULT_CASE_PRINT_TEMPLATE,
  );

  const MAX_UNDO = 50;
  const [undoStack, setUndoStack] = useState<CasePrintTemplate[]>([]);
  const [redoStack, setRedoStack] = useState<CasePrintTemplate[]>([]);
  const cleanTemplateRef = useRef<CasePrintTemplate>(DEFAULT_CASE_PRINT_TEMPLATE);
  const dirty = !isSameTemplate(draft, cleanTemplateRef.current);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [askKeep, setAskKeep] = useState(false);

  // ── Snap / grid state ─────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSize, setGridSize] = useState<8 | 16>(8);
  const [guideLines, setGuideLines] = useState<{ x: number[]; y: number[] }>({
    x: [],
    y: [],
  });

  const snapEnabledRef = useRef(snapEnabled);
  const gridSizeRef = useRef(gridSize);
  const draftRef = useRef(draft);

  useEffect(() => {
    snapEnabledRef.current = snapEnabled;
  }, [snapEnabled]);
  useEffect(() => {
    gridSizeRef.current = gridSize;
  }, [gridSize]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const seededRef = useRef(false);

  const [canvasScale, setCanvasScale] = useState(1);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setCanvasScale(w / PAGE_W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Seed local draft once the query loads.
  useEffect(() => {
    if (!seededRef.current && query.data) {
      const t = coerceCasePrintTemplate(query.data.template);
      setDraft(t);
      cleanTemplateRef.current = t;
      seededRef.current = true;
    }
  }, [query.data]);

  const imageElements = draft.elements.filter((el) => el.kind === "image");

  // Resolved per-image data: URLs (bearer auth can't ride a plain <img src>).
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!orgId) return;
    const known = imageDataUrls;
    const missing = imageElements.filter((img) => !known[img.id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (img) => {
          const url = await fetchTemplateImageAsDataUrl(orgId, img.id);
          return [img.id, url] as const;
        }),
      );
      if (cancelled) return;
      setImageDataUrls((prev) => {
        const next = { ...prev };
        for (const [id, url] of entries) if (url) next[id] = url;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, draft.elements]);

  const saveMutation = useMutation({
    mutationFn: async (template: CasePrintTemplate | null) => {
      await apiFetch(`/organizations/${orgId}/case-print-template`, {
        method: "PUT",
        body: JSON.stringify({ template }),
      });
      return template;
    },
    onSuccess: async (template) => {
      await qc.invalidateQueries({ queryKey: ["casePrintTemplate", orgId] });
      cleanTemplateRef.current = template ?? DEFAULT_CASE_PRINT_TEMPLATE;
      setUndoStack([]);
      setRedoStack([]);
      setSaveError(null);
      onTemplateSaved?.(template);
    },
    onError: (e) => {
      setSaveError(e instanceof Error ? e.message : "Failed to save layout.");
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<{ data: UploadedImage } | UploadedImage>(
        `/organizations/${orgId}/case-print-template/images`,
        { method: "POST", body: form },
      );
      return (
        (res as unknown as { data?: UploadedImage }).data ??
        (res as UploadedImage)
      );
    },
    onSuccess: (img) => {
      setUploadError(null);
      const el = makeImageElement(img.id, img.storageKey, img.url, {
        x: 60,
        y: 60,
        w: 160,
        h: 80,
      });
      pushUndo(draftRef.current);
      setDraft((d) => ({ ...d, elements: [...d.elements, el] }));
      setSelectedId(el.id);
    },
    onError: (e) => {
      setUploadError(e instanceof Error ? e.message : "Upload failed.");
    },
  });

  const deleteImageMutation = useMutation({
    mutationFn: async (imageId: string) => {
      await apiFetch(
        `/organizations/${orgId}/case-print-template/images/${imageId}`,
        { method: "DELETE" },
      );
      return imageId;
    },
  });

  // ── Undo / redo ───────────────────────────────────────────────────────
  draftRef.current = draft;
  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;
  const redoStackRef = useRef(redoStack);
  redoStackRef.current = redoStack;

  function pushUndo(snapshot: CasePrintTemplate) {
    setUndoStack((prev) => [...prev.slice(-(MAX_UNDO - 1)), snapshot]);
    setRedoStack([]);
  }

  function undo() {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const snapshot = stack[stack.length - 1];
    setUndoStack(stack.slice(0, -1));
    setRedoStack((r) => [...r.slice(-(MAX_UNDO - 1)), draftRef.current]);
    setDraft(snapshot);
  }

  function redo() {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const snapshot = stack[stack.length - 1];
    setRedoStack(stack.slice(0, -1));
    setUndoStack((u) => [...u.slice(-(MAX_UNDO - 1)), draftRef.current]);
    setDraft(snapshot);
  }

  const undoFnRef = useRef(undo);
  undoFnRef.current = undo;
  const redoFnRef = useRef(redo);
  redoFnRef.current = redo;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoFnRef.current();
      } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        redoFnRef.current();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Pointer / drag handlers ───────────────────────────────────────────
  function startDrag(
    e: React.PointerEvent,
    id: string,
    handle: Handle,
    box: Box,
  ) {
    e.stopPropagation();
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = PAGE_W / rect.width;
    const scaleY = PAGE_H / rect.height;
    pushUndo(draftRef.current);
    dragRef.current = {
      id,
      handle,
      startX: e.clientX * scaleX,
      startY: e.clientY * scaleY,
      startBox: { ...box },
      scaleX,
      scaleY,
    };
    setSelectedId(id);

    function handleMove(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX * d.scaleX - d.startX;
      const dy = ev.clientY * d.scaleY - d.startY;
      let next = applyDrag(d.startBox, d.handle, dx, dy);

      if (snapEnabledRef.current) {
        next = applyGridSnap(next, d.handle, gridSizeRef.current);
        next = {
          ...next,
          x: clamp(next.x, 0, PAGE_W - next.w),
          y: clamp(next.y, 0, PAGE_H - next.h),
        };
        const refs = buildAlignRefs(draftRef.current.elements, d.id);
        const aligned = applyAlignmentSnap(next, d.handle, refs, SNAP_THRESHOLD);
        next = {
          ...aligned.box,
          x: clamp(aligned.box.x, 0, PAGE_W - aligned.box.w),
          y: clamp(aligned.box.y, 0, PAGE_H - aligned.box.h),
        };
        setGuideLines(aligned.guides);
      } else {
        setGuideLines({ x: [], y: [] });
      }

      setDraft((cur) => ({
        ...cur,
        elements: cur.elements.map((el) =>
          el.id === d.id ? { ...el, ...next } : el,
        ),
      }));
    }

    function handleUp() {
      dragRef.current = null;
      setGuideLines({ x: [], y: [] });
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      dragCleanupRef.current = null;
    }

    dragCleanupRef.current?.();
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    dragCleanupRef.current = handleUp;
  }

  // ── Sidebar mutators ──────────────────────────────────────────────────
  function patchElement(id: string, patch: Partial<CasePrintElement>) {
    pushUndo(draftRef.current);
    setDraft((cur) => ({
      ...cur,
      elements: cur.elements.map((el) =>
        el.id === id ? { ...el, ...patch } : el,
      ),
    }));
  }

  function deleteImage(id: string) {
    // Image deletion is NOT undoable — the file is removed from storage.
    setDraft((cur) => ({
      ...cur,
      elements: cur.elements.filter((el) => el.id !== id),
    }));
    if (selectedId === id) setSelectedId(null);
    deleteImageMutation.mutate(id);
  }

  function resetToDefaults() {
    pushUndo(draftRef.current);
    setDraft(DEFAULT_CASE_PRINT_TEMPLATE);
    setSelectedId(null);
  }

  function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (imageElements.length >= MAX_IMAGES) {
      setUploadError(`Maximum of ${MAX_IMAGES} images per layout.`);
      return;
    }
    uploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── Close flow ────────────────────────────────────────────────────────
  function attemptClose() {
    if (dirty) setAskKeep(true);
    else onClose();
  }

  async function keepAndClose() {
    if (!isAdmin) {
      setSaveError("Only lab admins can save the shared layout.");
      return;
    }
    try {
      await saveMutation.mutateAsync(draft);
      onClose();
    } catch {
      /* error surface stays in modal */
    }
  }

  function discardAndClose() {
    setUndoStack([]);
    setRedoStack([]);
    onClose();
  }

  // ── Render ────────────────────────────────────────────────────────────
  const selectedEl = selectedId
    ? draft.elements.find((el) => el.id === selectedId) ?? null
    : null;
  const isDefault = isSameTemplate(draft, DEFAULT_CASE_PRINT_TEMPLATE);

  if (!orgId) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
        <div className="bg-card rounded-xl border border-border p-6 max-w-sm text-sm">
          <p className="text-foreground mb-3">
            You need an active lab to edit the print layout.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-4 rounded-md bg-secondary text-xs"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Advanced print layout editor"
    >
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-6xl mx-4 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold">Advanced Print Layout</h2>
            <p className="text-[11px] text-muted-foreground">
              Drag, resize, and style each field. Your lab shares one layout.
              {dirty && (
                <span className="ml-2 text-amber-600 dark:text-amber-400 font-medium">
                  · Unsaved changes
                </span>
              )}
              {query.data && !query.data.isCustom && !dirty && (
                <span className="ml-2 text-muted-foreground">
                  · Using default layout
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={undo}
              disabled={undoStack.length === 0}
              className="h-8 w-8 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground inline-flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Undo (Ctrl+Z)${undoStack.length > 0 ? ` — ${undoStack.length} step${undoStack.length > 1 ? "s" : ""}` : ""}`}
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={redoStack.length === 0}
              className="h-8 w-8 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground inline-flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Redo (Ctrl+Y)${redoStack.length > 0 ? ` — ${redoStack.length} step${redoStack.length > 1 ? "s" : ""}` : ""}`}
            >
              <Redo2 size={14} />
            </button>
            <div className="w-px h-4 bg-border mx-0.5" />
            <button
              type="button"
              onClick={resetToDefaults}
              disabled={isDefault && !dirty}
              className="h-8 px-2.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              title="Reset all elements to default positions"
            >
              <RotateCcw size={13} />
              Reset
            </button>
            <button
              type="button"
              onClick={() =>
                isAdmin
                  ? saveMutation.mutate(draft)
                  : setSaveError("Only lab admins can save.")
              }
              disabled={!dirty || saveMutation.isPending}
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              title={isAdmin ? "Save as the lab default" : "Admin only"}
            >
              {saveMutation.isPending && (
                <Loader2 size={11} className="animate-spin" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={attemptClose}
              className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label="Close editor"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left rail */}
          <aside className="w-72 border-r border-border bg-secondary/20 overflow-y-auto p-3 space-y-4 shrink-0">
            {/* Fields */}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                Fields
              </h3>
              <div className="space-y-1">
                {draft.elements
                  .filter((el) => el.kind !== "image")
                  .map((el) => {
                    const isSelected = selectedId === el.id;
                    return (
                      <div
                        key={el.id}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                          isSelected
                            ? "bg-primary/10 border-primary/40"
                            : "bg-card border-border hover:bg-secondary/40"
                        } ${!el.visible ? "opacity-60" : ""}`}
                        onClick={() => setSelectedId(el.id)}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ background: ELEMENT_COLORS[el.kind] }}
                        />
                        <span className="flex-1 truncate font-medium">
                          {ELEMENT_LABELS[el.kind]}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            patchElement(el.id, { visible: !el.visible });
                          }}
                          className="text-muted-foreground hover:text-foreground"
                          title={el.visible ? "Hide" : "Show"}
                        >
                          {el.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </section>

            {/* Images */}
            <section>
              <div className="flex items-center justify-between mb-2 px-1">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Logos &amp; Images
                </h3>
                <span className="text-[9px] text-muted-foreground">
                  {imageElements.length}/{MAX_IMAGES}
                </span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                onChange={(e) => handleFile(e.target.files?.[0])}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  uploadMutation.isPending ||
                  imageElements.length >= MAX_IMAGES ||
                  !isAdmin
                }
                className="w-full h-8 rounded-md border border-dashed border-border bg-card hover:bg-secondary/40 inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={
                  isAdmin
                    ? "Upload PNG/JPG/SVG/WebP/GIF — max 5 MB"
                    : "Admin only"
                }
              >
                {uploadMutation.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Upload size={12} />
                )}
                Upload image
              </button>
              {uploadError && (
                <p className="text-[10px] text-destructive mt-1.5 px-1">
                  {uploadError}
                </p>
              )}
              <div className="space-y-1 mt-2">
                {imageElements.map((img) => {
                  const isSelected = selectedId === img.id;
                  return (
                    <div
                      key={img.id}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-primary/10 border-primary/40"
                          : "bg-card border-border hover:bg-secondary/40"
                      }`}
                      onClick={() => setSelectedId(img.id)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imageDataUrls[img.id] ?? ""}
                        alt=""
                        className="w-6 h-6 object-contain bg-white rounded border border-border shrink-0"
                      />
                      <span className="flex-1 truncate text-[10px] font-mono text-muted-foreground">
                        {img.id}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteImage(img.id);
                        }}
                        className="text-muted-foreground hover:text-destructive"
                        title="Remove image"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  );
                })}
                {imageElements.length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic px-1 py-1">
                    No images uploaded.
                  </p>
                )}
              </div>
            </section>

            {/* Grid / Snap controls */}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 px-1 flex items-center gap-1.5">
                <Grid2X2 size={10} />
                Grid &amp; Snap
              </h3>
              <div className="space-y-2 px-1">
                <label className="flex items-center justify-between gap-2 text-xs cursor-pointer select-none">
                  <span>Snap to grid</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={snapEnabled}
                    onClick={() => setSnapEnabled((v) => !v)}
                    className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors focus-visible:outline-none ${
                      snapEnabled ? "bg-primary" : "bg-input"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm ring-0 transition-transform mt-0.5 ${
                        snapEnabled ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </label>
                {snapEnabled && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">
                      Grid size
                    </span>
                    <div className="flex gap-0.5 ml-auto">
                      {([8, 16] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setGridSize(sz)}
                          className={`h-5 px-1.5 rounded text-[9px] font-medium border transition-colors ${
                            gridSize === sz
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-card text-muted-foreground border-border hover:bg-secondary/60"
                          }`}
                        >
                          {sz}px
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {snapEnabled && (
                  <p className="text-[9px] text-muted-foreground leading-snug">
                    Edges also snap to other elements and the page center while
                    dragging.
                  </p>
                )}
              </div>
            </section>

            {/* Selected element props */}
            {selectedEl && (
              <section className="p-3 rounded-md border border-primary/30 bg-primary/5 space-y-2.5">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-primary flex items-center gap-1.5">
                  {selectedEl.kind === "image" && <ImageIcon size={11} />}
                  {ELEMENT_LABELS[selectedEl.kind]}
                </h3>
                <BoxNumericInputs
                  box={selectedEl}
                  onChange={(patch) => patchElement(selectedEl.id, patch)}
                  minW={selectedEl.kind === "image" ? 10 : 20}
                  minH={selectedEl.kind === "image" ? 10 : 14}
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="accent-primary w-3 h-3"
                    checked={selectedEl.visible}
                    onChange={(e) =>
                      patchElement(selectedEl.id, { visible: e.target.checked })
                    }
                  />
                  <span>Visible on printout</span>
                </label>

                {isTextKind(selectedEl.kind) && (
                  <TypographyControls
                    el={selectedEl}
                    onChange={(patch) => patchElement(selectedEl.id, patch)}
                  />
                )}

                {selectedEl.kind === "image" && (
                  <label className="text-xs space-y-1 block">
                    <span className="flex justify-between">
                      <span>Opacity</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {Math.round((selectedEl.opacity ?? 1) * 100)}%
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedEl.opacity ?? 1}
                      onChange={(e) =>
                        patchElement(selectedEl.id, {
                          opacity: Number(e.target.value),
                        })
                      }
                      className="w-full accent-primary"
                    />
                  </label>
                )}
              </section>
            )}

            {!selectedEl && (
              <p className="text-[11px] text-muted-foreground italic px-1">
                Click a field or image to edit its position, size, typography,
                and visibility.
              </p>
            )}

            {saveError && (
              <div className="text-[10px] text-destructive border border-destructive/30 bg-destructive/5 rounded-md p-2">
                {saveError}
              </div>
            )}
            {!isAdmin && (
              <div className="text-[10px] text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/5 rounded-md p-2">
                Only lab admins can save the shared layout. You can still drag
                elements around to preview.
              </div>
            )}
          </aside>

          {/* Canvas */}
          <main className="flex-1 overflow-auto bg-secondary/30 p-6 flex items-start justify-center">
            <div
              ref={canvasRef}
              onClick={() => setSelectedId(null)}
              className="relative bg-white border border-border rounded shadow-sm select-none"
              style={{
                aspectRatio: `${PAGE_W} / ${PAGE_H}`,
                width: "100%",
                maxWidth: PAGE_W,
              }}
            >
              {draft.elements.map((el) => {
                if (!el.visible) return null;
                const isSelected = selectedId === el.id;
                const isImage = el.kind === "image";
                return (
                  <DraggableBox
                    key={el.id}
                    box={el}
                    color={
                      isImage
                        ? "rgba(99,102,241,0.10)"
                        : ELEMENT_COLORS[el.kind]
                    }
                    label={isImage ? "" : ELEMENT_LABELS[el.kind]}
                    selected={isSelected}
                    imageUrl={isImage ? imageDataUrls[el.id] : undefined}
                    opacity={isImage ? el.opacity ?? 1 : undefined}
                    preview={
                      isImage ? undefined : (
                        <ElementPreview el={el} scale={canvasScale} />
                      )
                    }
                    onStart={(e, h) => startDrag(e, el.id, h, el)}
                    onDelete={isImage ? () => deleteImage(el.id) : undefined}
                  />
                );
              })}

              {/* Alignment guide lines — shown only during drag */}
              {guideLines.x.map((gx) => (
                <div
                  key={`gx-${gx}`}
                  style={{
                    position: "absolute",
                    left: `${(gx / PAGE_W) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: "#2563eb",
                    opacity: 0.75,
                    pointerEvents: "none",
                    zIndex: 20,
                  }}
                />
              ))}
              {guideLines.y.map((gy) => (
                <div
                  key={`gy-${gy}`}
                  style={{
                    position: "absolute",
                    top: `${(gy / PAGE_H) * 100}%`,
                    left: 0,
                    right: 0,
                    height: 1,
                    background: "#2563eb",
                    opacity: 0.75,
                    pointerEvents: "none",
                    zIndex: 20,
                  }}
                />
              ))}
            </div>
          </main>
        </div>

        {/* "Keep changes" prompt */}
        {askKeep && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
            <div className="bg-card border border-border rounded-xl shadow-xl p-5 max-w-sm w-full mx-4">
              <h3 className="text-sm font-semibold mb-1">Keep these changes?</h3>
              <p className="text-xs text-muted-foreground mb-4">
                You've made changes to the print layout. Save them as your lab's
                default for next time, or discard.
              </p>
              {saveError && (
                <p className="text-[11px] text-destructive mb-2">{saveError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAskKeep(false)}
                  className="h-8 px-3 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={discardAndClose}
                  className="h-8 px-3 rounded-md bg-secondary text-xs hover:bg-secondary/80"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={keepAndClose}
                  disabled={saveMutation.isPending || !isAdmin}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                  title={isAdmin ? "Save and close" : "Admin only"}
                >
                  {saveMutation.isPending && (
                    <Loader2 size={11} className="animate-spin" />
                  )}
                  Save for future
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Typography controls ────────────────────────────────────────────────

function TypographyControls({
  el,
  onChange,
}: {
  el: CasePrintElement;
  onChange: (patch: Partial<CasePrintElement>) => void;
}) {
  const aligns: Array<{ value: ElementAlign; icon: React.ReactNode }> = [
    { value: "left", icon: <AlignLeft size={13} /> },
    { value: "center", icon: <AlignCenter size={13} /> },
    { value: "right", icon: <AlignRight size={13} /> },
  ];
  return (
    <div className="space-y-2 pt-1 border-t border-primary/20">
      <p className="text-[10px] font-semibold text-primary/80 uppercase tracking-wider">
        Typography
      </p>
      <label className="text-[10px] block">
        <span className="text-muted-foreground">Font</span>
        <select
          value={el.fontFamily ?? DEFAULT_FONT_FAMILY}
          onChange={(e) => onChange({ fontFamily: e.target.value })}
          className="w-full mt-0.5 h-7 px-1.5 rounded border border-border bg-background text-xs"
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <label className="text-[10px] flex-1">
          <span className="text-muted-foreground">Size (pt)</span>
          <input
            type="number"
            min={5}
            max={200}
            value={el.fontSize ?? 13}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v)) onChange({ fontSize: clamp(v, 5, 200) });
            }}
            className="w-full mt-0.5 h-7 px-2 rounded border border-border bg-background text-xs font-mono"
          />
        </label>
        <div className="flex gap-0.5 mt-3.5">
          <button
            type="button"
            onClick={() => onChange({ bold: !el.bold })}
            className={`h-7 w-7 rounded border inline-flex items-center justify-center transition-colors ${
              el.bold
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:bg-secondary/60"
            }`}
            title="Bold"
          >
            <Bold size={13} />
          </button>
          <button
            type="button"
            onClick={() => onChange({ italic: !el.italic })}
            className={`h-7 w-7 rounded border inline-flex items-center justify-center transition-colors ${
              el.italic
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:bg-secondary/60"
            }`}
            title="Italic"
          >
            <Italic size={13} />
          </button>
        </div>
      </div>
      <div>
        <span className="text-[10px] text-muted-foreground">Alignment</span>
        <div className="flex gap-0.5 mt-0.5">
          {aligns.map((a) => (
            <button
              key={a.value}
              type="button"
              onClick={() => onChange({ align: a.value })}
              className={`h-7 flex-1 rounded border inline-flex items-center justify-center transition-colors ${
                (el.align ?? "left") === a.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:bg-secondary/60"
              }`}
              title={`Align ${a.value}`}
            >
              {a.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── DraggableBox helper ────────────────────────────────────────────────

interface DraggableBoxProps {
  box: Box;
  color: string;
  label: string;
  selected?: boolean;
  imageUrl?: string;
  opacity?: number;
  preview?: React.ReactNode;
  onStart: (e: React.PointerEvent, handle: Handle) => void;
  onDelete?: () => void;
}

function DraggableBox({
  box,
  color,
  label,
  selected,
  imageUrl,
  opacity,
  preview,
  onStart,
  onDelete,
}: DraggableBoxProps) {
  const [hovered, setHovered] = useState(false);
  const isImage = !!onDelete;

  const style: React.CSSProperties = {
    position: "absolute",
    left: `${(box.x / PAGE_W) * 100}%`,
    top: `${(box.y / PAGE_H) * 100}%`,
    width: `${(box.w / PAGE_W) * 100}%`,
    height: `${(box.h / PAGE_H) * 100}%`,
    background: imageUrl ? "transparent" : color,
    border: selected ? "1.5px solid #2563eb" : "1px dashed rgba(0,0,0,0.35)",
    cursor: "move",
    boxSizing: "border-box",
  };

  const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const showDelete = !!onDelete && (selected || hovered);

  return (
    <div
      style={style}
      onPointerDown={(e) => onStart(e, "move")}
      onClick={(e) => e.stopPropagation()}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {isImage && imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            pointerEvents: "none",
            opacity: opacity ?? 1,
          }}
        />
      )}

      {!isImage && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          {preview && <div style={{ position: "absolute", inset: 0 }}>{preview}</div>}
          {label && (
            <span
              style={{
                position: "absolute",
                top: 2,
                left: 3,
                zIndex: 2,
                fontSize: 8,
                fontWeight: 700,
                color: "rgba(0,0,0,0.55)",
                background: "rgba(255,255,255,0.82)",
                borderRadius: 2,
                padding: "0 3px",
                lineHeight: "12px",
                whiteSpace: "nowrap",
                letterSpacing: "0.01em",
              }}
            >
              {label}
            </span>
          )}
        </div>
      )}

      {showDelete && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete?.();
          }}
          style={{
            position: "absolute",
            top: -10,
            right: -10,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#ef4444",
            color: "white",
            border: "1.5px solid white",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 5,
          }}
          aria-label="Delete"
        >
          <X size={11} />
        </button>
      )}

      {selected &&
        handles.map((h) => {
          const positions: Record<Handle, React.CSSProperties> = {
            move: {},
            n: { top: -5, left: "50%", marginLeft: -5, cursor: "ns-resize" },
            s: { bottom: -5, left: "50%", marginLeft: -5, cursor: "ns-resize" },
            e: { right: -5, top: "50%", marginTop: -5, cursor: "ew-resize" },
            w: { left: -5, top: "50%", marginTop: -5, cursor: "ew-resize" },
            ne: { top: -5, right: -5, cursor: "nesw-resize" },
            nw: { top: -5, left: -5, cursor: "nwse-resize" },
            se: { bottom: -5, right: -5, cursor: "nwse-resize" },
            sw: { bottom: -5, left: -5, cursor: "nesw-resize" },
          };
          return (
            <div
              key={h}
              onPointerDown={(e) => onStart(e, h)}
              style={{
                position: "absolute",
                width: 10,
                height: 10,
                background: "#2563eb",
                border: "1.5px solid white",
                borderRadius: 2,
                ...positions[h],
              }}
            />
          );
        })}
    </div>
  );
}

// ── Numeric inputs for selected box ────────────────────────────────────

interface BoxNumericInputsProps {
  box: Box;
  onChange: (patch: { x?: number; y?: number; w?: number; h?: number }) => void;
  minW?: number;
  minH?: number;
}

function BoxNumericInputs({
  box,
  onChange,
  minW = 20,
  minH = 14,
}: BoxNumericInputsProps) {
  function field(
    label: string,
    value: number,
    onCommit: (v: number) => void,
    min: number,
    max: number,
  ) {
    return (
      <label className="text-[10px] block">
        <span className="text-muted-foreground">{label}</span>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onCommit(clamp(v, min, max));
          }}
          className="w-full mt-0.5 h-7 px-2 rounded border border-border bg-background text-xs font-mono"
        />
      </label>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {field("X", box.x, (v) => onChange({ x: v }), 0, PAGE_W - box.w)}
      {field("Y", box.y, (v) => onChange({ y: v }), 0, PAGE_H - box.h)}
      {field("Width", box.w, (v) => onChange({ w: v }), minW, PAGE_W - box.x)}
      {field("Height", box.h, (v) => onChange({ h: v }), minH, PAGE_H - box.y)}
    </div>
  );
}

// ── Element content preview ─────────────────────────────────────────────
//
// Renders sample content with the element's real typography so admins can
// see the effect of their styling before printing. Font sizes scale to the
// canvas's actual render width.

const SAMPLE_VALUES: Record<string, string> = {
  caseNumber: "Case LAB-2024-001",
  patient: "Smith, John",
  doctor: "Dr. Patel",
  dueDate: "06/12/2024",
  priority: "Rush",
  restorativeType: "PFM Crown",
  teeth: "#14, #15",
  material: "Zirconia",
  shade: "A2",
  rxNotes:
    "Please verify shade with photo on file. Light occlusal contacts. Deliver by Friday.",
};

const SAMPLE_TEETH = new Set(["14", "15"]);

function ElementPreview({
  el,
  scale,
}: {
  el: CasePrintElement;
  scale: number;
}) {
  if (el.kind === "toothChart") {
    return (
      <div
        style={{ position: "absolute", inset: 0, padding: 2 }}
        dangerouslySetInnerHTML={{
          __html: buildAnatomicalToothChartSvg(SAMPLE_TEETH),
        }}
      />
    );
  }

  if (el.kind === "barcode") {
    const pattern = [
      2, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1,
      3, 2, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 3,
    ];
    const unit = Math.max(1, scale);
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 4,
          gap: 2,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: "55%",
            gap: 0,
            width: "92%",
            justifyContent: "center",
          }}
        >
          {pattern.map((w, i) =>
            i % 2 === 0 ? (
              <div
                key={i}
                style={{
                  width: w * unit,
                  height: "100%",
                  background: "rgba(0,0,0,0.82)",
                  flexShrink: 0,
                }}
              />
            ) : (
              <div key={i} style={{ width: w * unit, flexShrink: 0 }} />
            ),
          )}
        </div>
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: Math.max(6, Math.round(11 * scale)),
            fontWeight: 700,
            letterSpacing: "0.3em",
            color: "rgba(0,0,0,0.8)",
          }}
        >
          LAB-2024-001
        </div>
      </div>
    );
  }

  // text element
  const fontPx = Math.max(5, Math.round((el.fontSize ?? 13) * scale));
  const capPx = Math.max(5, Math.round(8 * scale));
  const showCap = el.kind !== "caseNumber";
  const value = SAMPLE_VALUES[el.kind] ?? "";
  const isNotes = el.kind === "rxNotes";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: `${Math.round(3 * scale)}px ${Math.round(4 * scale)}px`,
        fontFamily: el.fontFamily || DEFAULT_FONT_FAMILY,
        fontWeight: el.bold ? 700 : 400,
        fontStyle: el.italic ? "italic" : "normal",
        textAlign: el.align ?? "left",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      {showCap && (
        <div
          style={{
            fontSize: capPx,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "rgba(0,0,0,0.45)",
            marginBottom: 2,
            lineHeight: 1.1,
          }}
        >
          {ELEMENT_LABELS[el.kind]}
        </div>
      )}
      <div
        style={{
          fontSize: fontPx,
          color: "rgba(0,0,0,0.82)",
          lineHeight: isNotes ? 1.4 : 1.25,
          whiteSpace: isNotes ? "pre-wrap" : "nowrap",
          overflow: "hidden",
          textOverflow: isNotes ? "clip" : "ellipsis",
        }}
      >
        {value}
      </div>
    </div>
  );
}
