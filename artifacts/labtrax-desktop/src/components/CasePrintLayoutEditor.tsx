// Advanced case-print-label layout editor.
//
// Modal opened from the basic PrintLayoutEditor's "Advanced layout…" button.
// Provides drag/resize boxes (header, case details, RX summary, tooth chart,
// notes, barcode) plus uploaded extra images (logos, signatures, stamps).
//
// State flow:
//   - Loads the per-lab template from GET /organizations/:orgId/case-print-template
//   - Edits happen in a local `draft` (dirty flag tracks changes)
//   - "Save & Close" PUTs the draft; "Discard" reverts; closing while dirty
//     prompts the user to keep the changes for future case labels.
//   - Uploaded images are persisted immediately on POST so a discarded
//     session may leave orphan App Storage objects — that's fine, it's
//     bounded by 8 images per template and a 5MB/file limit.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  EyeOff,
  Grid2X2,
  ImageIcon,
  Loader2,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fetchTemplateImageAsDataUrl } from "@/lib/print";
import { useAuth } from "@/lib/auth-context";
import {
  CASE_DETAIL_FIELDS,
  CASE_DETAIL_FIELD_LABELS,
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  FIELD_SIZE_VALUES,
  isSameTemplate,
  PAGE_H,
  PAGE_W,
  RX_SUMMARY_FIELDS,
  RX_SUMMARY_FIELD_LABELS,
  SECTION_LABELS,
  SECTION_ORDER,
  type CaseDetailField,
  type CasePrintExtraImage,
  type CasePrintFieldSizes,
  type CasePrintTemplate,
  type CaseTemplateBox,
  type CaseTemplateSectionKey,
  type FieldSize,
  type RxSummaryField,
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

const SECTION_COLORS: Record<CaseTemplateSectionKey, string> = {
  header: "rgba(59,130,246,0.18)",
  caseDetails: "rgba(16,185,129,0.18)",
  rxSummary: "rgba(168,85,247,0.18)",
  toothChart: "rgba(234,179,8,0.18)",
  notes: "rgba(244,63,94,0.18)",
  barcode: "rgba(20,184,166,0.18)",
};

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface DragState {
  kind: "section" | "image";
  key: string;
  handle: Handle;
  startX: number;
  startY: number;
  startBox: { x: number; y: number; w: number; h: number };
  scaleX: number;
  scaleY: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Snap helpers ──────────────────────────────────────────────────────

const SNAP_THRESHOLD = 7; // page-coordinate pixels within which alignment snap fires

/** Round a single value to the nearest grid multiple. */
function snapToGrid(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

/** Snap box edges to the grid based on which handle is being dragged. */
function applyGridSnap(
  box: { x: number; y: number; w: number; h: number },
  handle: Handle,
  grid: number,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = box;
  if (handle === "move") {
    x = snapToGrid(x, grid);
    y = snapToGrid(y, grid);
  } else {
    if (handle.includes("w")) {
      const newX = snapToGrid(x, grid);
      w = Math.max(40, x + w - newX);
      x = newX;
    }
    if (handle.includes("e")) {
      w = Math.max(40, snapToGrid(x + w, grid) - x);
    }
    if (handle.includes("n")) {
      const newY = snapToGrid(y, grid);
      h = Math.max(20, y + h - newY);
      y = newY;
    }
    if (handle.includes("s")) {
      h = Math.max(20, snapToGrid(y + h, grid) - y);
    }
  }
  return { x, y, w, h };
}

/** Collect all x and y reference positions from other boxes for alignment. */
function buildAlignRefs(
  draft: { boxes: Record<string, { x: number; y: number; w: number; h: number; visible: boolean }>; extraImages: Array<{ id: string; x: number; y: number; w: number; h: number }> },
  excludeKey: string,
): { x: number[]; y: number[] } {
  const xs = new Set<number>([0, PAGE_W / 2, PAGE_W]);
  const ys = new Set<number>([0, PAGE_H / 2, PAGE_H]);

  for (const key of SECTION_ORDER) {
    if (key === excludeKey) continue;
    const b = draft.boxes[key];
    if (!b?.visible) continue;
    xs.add(b.x); xs.add(b.x + b.w); xs.add(b.x + b.w / 2);
    ys.add(b.y); ys.add(b.y + b.h); ys.add(b.y + b.h / 2);
  }
  for (const img of draft.extraImages) {
    if (img.id === excludeKey) continue;
    xs.add(img.x); xs.add(img.x + img.w); xs.add(img.x + img.w / 2);
    ys.add(img.y); ys.add(img.y + img.h); ys.add(img.y + img.h / 2);
  }

  return { x: [...xs], y: [...ys] };
}

/** Find the closest reference edge within threshold and return the snapped value + guide position. */
function snapEdge(edge: number, refs: number[], threshold: number): { snapped: number; guide: number | null } {
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

/**
 * For "move", check left/center/right (or top/center/bottom) edges and pick the
 * closest snap. Returns the adjusted position and any guide lines to show.
 */
function snapMoveAxis(pos: number, size: number, refs: number[], threshold: number): { pos: number; guides: number[] } {
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
  box: { x: number; y: number; w: number; h: number };
  guides: { x: number[]; y: number[] };
}

/** Apply alignment snapping and collect guide lines to render. */
function applyAlignmentSnap(
  box: { x: number; y: number; w: number; h: number },
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
      w = Math.max(40, x + w - snapped);
      x = snapped;
      if (guide !== null) xGuides.push(guide);
    }
    if (handle.includes("e")) {
      const { snapped, guide } = snapEdge(x + w, refs.x, threshold);
      w = Math.max(40, snapped - x);
      if (guide !== null) xGuides.push(guide);
    }
    if (handle.includes("n")) {
      const { snapped, guide } = snapEdge(y, refs.y, threshold);
      h = Math.max(20, y + h - snapped);
      y = snapped;
      if (guide !== null) yGuides.push(guide);
    }
    if (handle.includes("s")) {
      const { snapped, guide } = snapEdge(y + h, refs.y, threshold);
      h = Math.max(20, snapped - y);
      if (guide !== null) yGuides.push(guide);
    }
  }

  return {
    box: { x, y, w, h },
    guides: {
      x: [...new Set(xGuides)],
      y: [...new Set(yGuides)],
    },
  };
}

function applyDrag(
  start: { x: number; y: number; w: number; h: number },
  h: Handle,
  dx: number,
  dy: number,
): { x: number; y: number; w: number; h: number } {
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
  w = Math.max(40, w);
  bh = Math.max(20, bh);
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
   * Called with the active template after save so the parent renderer
   * can immediately use it for the next print. Null = template was
   * reset to defaults (no custom layout).
   */
  onTemplateSaved?: (template: CasePrintTemplate | null) => void;
}

export function CasePrintLayoutEditor({
  onClose,
  onTemplateSaved,
}: CasePrintLayoutEditorProps) {
  const { user } = useAuth() as {
    user: { practiceOrganizationId?: string | null; role?: string | null } | null;
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
      return (((res as unknown) as { data?: TemplateApi }).data ??
        (res as TemplateApi));
    },
  });

  const [draft, setDraft] = useState<CasePrintTemplate>(
    DEFAULT_CASE_PRINT_TEMPLATE,
  );
  // Undo / redo history (bounded at 50 steps each).
  // Cleared when the layout is saved or discarded.
  const MAX_UNDO = 50;
  const [undoStack, setUndoStack] = useState<CasePrintTemplate[]>([]);
  const [redoStack, setRedoStack] = useState<CasePrintTemplate[]>([]);
  // Tracks the last-saved (or initially-loaded) template so "dirty" is
  // accurate after undo brings the draft back to the clean state.
  const cleanTemplateRef = useRef<CasePrintTemplate>(DEFAULT_CASE_PRINT_TEMPLATE);
  const dirty = !isSameTemplate(draft, cleanTemplateRef.current);

  const [selected, setSelected] = useState<
    { kind: "section"; key: CaseTemplateSectionKey } | { kind: "image"; key: string } | null
  >(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [askKeep, setAskKeep] = useState(false);

  // ── Snap / grid state ─────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSize, setGridSize] = useState<8 | 16>(8);
  const [guideLines, setGuideLines] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  // Refs that stay in sync so drag handlers (closures) can read current values.
  const snapEnabledRef = useRef(snapEnabled);
  const gridSizeRef = useRef(gridSize);
  const draftRef = useRef(draft);

  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { gridSizeRef.current = gridSize; }, [gridSize]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const seededRef = useRef(false);

  // Track the canvas rendered width so preview font sizes scale correctly.
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

  // Clean up any lingering window drag listeners on unmount.
  useEffect(() => {
    return () => { dragCleanupRef.current?.(); };
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

  // Resolved per-image data: URLs. Plain `<img src="/api/...">` can't
  // attach the bearer token desktop uses for auth, so we prefetch each
  // template image via apiFetchArrayBuffer and inline it as base64.
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    if (!orgId) return;
    const known = imageDataUrls;
    const missing = draft.extraImages.filter((img) => !known[img.id]);
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
  }, [orgId, draft.extraImages]);

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
      // Update the clean baseline so dirty=false, then clear history.
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
      return (((res as unknown) as { data?: UploadedImage }).data ??
        (res as UploadedImage));
    },
    onSuccess: (img) => {
      setUploadError(null);
      setDraft((d) => ({
        ...d,
        extraImages: [
          ...d.extraImages,
          {
            id: img.id,
            storageKey: img.storageKey,
            url: img.url,
            x: 60,
            y: 60,
            w: 160,
            h: 80,
            opacity: 1,
          },
        ],
      }));
      setSelected({ kind: "image", key: img.id });
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

  // Mirror current values in refs so the keyboard handler is never stale.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;
  const redoStackRef = useRef(redoStack);
  redoStackRef.current = redoStack;

  /** Push the given snapshot onto the undo stack and clear redo. */
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

  // Keep refs up to date so the static keydown listener calls the latest fn.
  const undoFnRef = useRef(undo);
  undoFnRef.current = undo;
  const redoFnRef = useRef(redo);
  redoFnRef.current = redo;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
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
    kind: DragState["kind"],
    key: string,
    handle: Handle,
    box: { x: number; y: number; w: number; h: number },
  ) {
    e.stopPropagation();
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = PAGE_W / rect.width;
    const scaleY = PAGE_H / rect.height;
    // Snapshot before the drag begins so Ctrl+Z restores the pre-drag state.
    pushUndo(draftRef.current);
    dragRef.current = {
      kind,
      key,
      handle,
      startX: e.clientX * scaleX,
      startY: e.clientY * scaleY,
      startBox: { ...box },
      scaleX,
      scaleY,
    };
    if (kind === "section") {
      setSelected({ kind: "section", key: key as CaseTemplateSectionKey });
    } else {
      setSelected({ kind: "image", key });
    }

    function handleMove(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX * d.scaleX - d.startX;
      const dy = ev.clientY * d.scaleY - d.startY;
      let next = applyDrag(d.startBox, d.handle, dx, dy);

      if (snapEnabledRef.current) {
        // 1. Grid snap
        next = applyGridSnap(next, d.handle, gridSizeRef.current);
        // Re-clamp after grid snap
        next = {
          ...next,
          x: clamp(next.x, 0, PAGE_W - next.w),
          y: clamp(next.y, 0, PAGE_H - next.h),
        };

        // 2. Alignment snap (may override grid snap when an edge aligns closely)
        const refs = buildAlignRefs(draftRef.current, d.key);
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

      setDraft((cur) => {
        if (d.kind === "section") {
          const k = d.key as CaseTemplateSectionKey;
          return {
            ...cur,
            boxes: { ...cur.boxes, [k]: { ...cur.boxes[k], ...next } },
          };
        }
        return {
          ...cur,
          extraImages: cur.extraImages.map((img) =>
            img.id === d.key ? { ...img, ...next } : img,
          ),
        };
      });
    }

    function handleUp() {
      dragRef.current = null;
      setGuideLines({ x: [], y: [] });
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      dragCleanupRef.current = null;
    }

    // Clean up any previous drag that wasn't properly ended.
    dragCleanupRef.current?.();
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    dragCleanupRef.current = handleUp;
  }

  // ── Sidebar mutators ──────────────────────────────────────────────────
  function patchFieldSize(
    section: "caseDetails" | "rxSummary",
    field: CaseDetailField | RxSummaryField,
    size: FieldSize,
  ) {
    pushUndo(draftRef.current);
    setDraft((cur) => ({
      ...cur,
      fieldSizes: {
        ...cur.fieldSizes,
        [section]: {
          ...cur.fieldSizes?.[section],
          [field]: size === "normal" ? undefined : size,
        },
      },
    }));
  }

  function patchBox(key: CaseTemplateSectionKey, patch: Partial<CaseTemplateBox>) {
    pushUndo(draftRef.current);
    setDraft((cur) => ({
      ...cur,
      boxes: { ...cur.boxes, [key]: { ...cur.boxes[key], ...patch } },
    }));
  }

  function patchImage(id: string, patch: Partial<CasePrintExtraImage>) {
    pushUndo(draftRef.current);
    setDraft((cur) => ({
      ...cur,
      extraImages: cur.extraImages.map((img) =>
        img.id === id ? { ...img, ...patch } : img,
      ),
    }));
  }

  function deleteImage(id: string) {
    // Image deletion is NOT undoable — the file is removed from storage.
    setDraft((cur) => ({
      ...cur,
      extraImages: cur.extraImages.filter((img) => img.id !== id),
    }));
    if (selected?.kind === "image" && selected.key === id) setSelected(null);
    // Fire-and-forget storage cleanup
    deleteImageMutation.mutate(id);
  }

  function resetToDefaults() {
    pushUndo(draftRef.current);
    setDraft(DEFAULT_CASE_PRINT_TEMPLATE);
    setSelected(null);
  }

  function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (draft.extraImages.length >= 8) {
      setUploadError("Maximum of 8 images per layout.");
      return;
    }
    uploadMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── Close flow ────────────────────────────────────────────────────────
  function attemptClose() {
    if (dirty) {
      setAskKeep(true);
    } else {
      onClose();
    }
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
  const selectedSection =
    selected?.kind === "section" ? draft.boxes[selected.key] : null;
  const selectedImage =
    selected?.kind === "image"
      ? draft.extraImages.find((i) => i.id === selected.key) ?? null
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
              Drag and resize the boxes. Add logos or signatures. Your lab
              shares one layout.
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
              title="Reset all boxes to default positions"
            >
              <RotateCcw size={13} />
              Reset
            </button>
            <button
              type="button"
              onClick={() =>
                isAdmin ? saveMutation.mutate(draft) : setSaveError("Only lab admins can save.")
              }
              disabled={!dirty || saveMutation.isPending}
              className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              title={isAdmin ? "Save as the lab default" : "Admin only"}
            >
              {saveMutation.isPending && <Loader2 size={11} className="animate-spin" />}
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
          {/* Left rail — sections / images / selected props */}
          <aside className="w-72 border-r border-border bg-secondary/20 overflow-y-auto p-3 space-y-4 shrink-0">
            {/* Sections */}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                Sections
              </h3>
              <div className="space-y-1">
                {SECTION_ORDER.map((key) => {
                  const box = draft.boxes[key];
                  const isSelected =
                    selected?.kind === "section" && selected.key === key;
                  return (
                    <div
                      key={key}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-primary/10 border-primary/40"
                          : "bg-card border-border hover:bg-secondary/40"
                      } ${!box.visible ? "opacity-60" : ""}`}
                      onClick={() => setSelected({ kind: "section", key })}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ background: SECTION_COLORS[key] }}
                      />
                      <span className="flex-1 truncate font-medium">
                        {SECTION_LABELS[key]}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          patchBox(key, { visible: !box.visible });
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        title={box.visible ? "Hide" : "Show"}
                      >
                        {box.visible ? <Eye size={12} /> : <EyeOff size={12} />}
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
                  {draft.extraImages.length}/8
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
                  uploadMutation.isPending || draft.extraImages.length >= 8 || !isAdmin
                }
                className="w-full h-8 rounded-md border border-dashed border-border bg-card hover:bg-secondary/40 inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={isAdmin ? "Upload PNG/JPG/SVG/WebP/GIF — max 5 MB" : "Admin only"}
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
                {draft.extraImages.map((img) => {
                  const isSelected =
                    selected?.kind === "image" && selected.key === img.id;
                  return (
                    <div
                      key={img.id}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-primary/10 border-primary/40"
                          : "bg-card border-border hover:bg-secondary/40"
                      }`}
                      onClick={() => setSelected({ kind: "image", key: img.id })}
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
                {draft.extraImages.length === 0 && (
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
                    <span className="text-[10px] text-muted-foreground">Grid size</span>
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
                    Edges also snap to other boxes and the page center while dragging.
                  </p>
                )}
              </div>
            </section>

            {/* Selected props */}
            {selectedSection && selected?.kind === "section" && (
              <section className="p-3 rounded-md border border-primary/30 bg-primary/5 space-y-2">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-primary">
                  {SECTION_LABELS[selected.key]}
                </h3>
                <BoxNumericInputs
                  box={selectedSection}
                  onChange={(patch) => patchBox(selected.key, patch)}
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="accent-primary w-3 h-3"
                    checked={selectedSection.visible}
                    onChange={(e) =>
                      patchBox(selected.key, { visible: e.target.checked })
                    }
                  />
                  <span>Visible on printout</span>
                </label>

                {selected.key === "caseDetails" && (
                  <div className="pt-1 space-y-1.5">
                    <p className="text-[10px] font-semibold text-primary/80 uppercase tracking-wider">
                      Field text sizes
                    </p>
                    {CASE_DETAIL_FIELDS.map((field) => (
                      <FieldSizeRow
                        key={field}
                        label={CASE_DETAIL_FIELD_LABELS[field]}
                        value={draft.fieldSizes?.caseDetails?.[field] ?? "normal"}
                        onChange={(sz) => patchFieldSize("caseDetails", field, sz)}
                      />
                    ))}
                  </div>
                )}

                {selected.key === "rxSummary" && (
                  <div className="pt-1 space-y-1.5">
                    <p className="text-[10px] font-semibold text-primary/80 uppercase tracking-wider">
                      Field text sizes
                    </p>
                    {RX_SUMMARY_FIELDS.map((field) => (
                      <FieldSizeRow
                        key={field}
                        label={RX_SUMMARY_FIELD_LABELS[field]}
                        value={draft.fieldSizes?.rxSummary?.[field] ?? "normal"}
                        onChange={(sz) => patchFieldSize("rxSummary", field as RxSummaryField, sz)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {selectedImage && (
              <section className="p-3 rounded-md border border-indigo-300/50 bg-indigo-50/40 dark:bg-indigo-950/20 space-y-2">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                  <ImageIcon size={11} />
                  Image
                </h3>
                <BoxNumericInputs
                  box={selectedImage}
                  onChange={(patch) => patchImage(selectedImage.id, patch)}
                  minW={10}
                  minH={10}
                />
                <label className="text-xs space-y-1 block">
                  <span className="flex justify-between">
                    <span>Opacity</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {Math.round(selectedImage.opacity * 100)}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selectedImage.opacity}
                    onChange={(e) =>
                      patchImage(selectedImage.id, {
                        opacity: Number(e.target.value),
                      })
                    }
                    className="w-full accent-primary"
                  />
                </label>
              </section>
            )}

            {!selectedSection && !selectedImage && (
              <p className="text-[11px] text-muted-foreground italic px-1">
                Click a section or image to edit its position, size, and
                visibility.
              </p>
            )}

            {saveError && (
              <div className="text-[10px] text-destructive border border-destructive/30 bg-destructive/5 rounded-md p-2">
                {saveError}
              </div>
            )}
            {!isAdmin && (
              <div className="text-[10px] text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/5 rounded-md p-2">
                Only lab admins can save the shared layout. You can still
                drag boxes around to preview.
              </div>
            )}
          </aside>

          {/* Canvas */}
          <main className="flex-1 overflow-auto bg-secondary/30 p-6 flex items-start justify-center">
            <div
              ref={canvasRef}
              onClick={() => setSelected(null)}
              className="relative bg-white border border-border rounded shadow-sm select-none"
              style={{
                aspectRatio: `${PAGE_W} / ${PAGE_H}`,
                width: "100%",
                maxWidth: PAGE_W,
              }}
            >
              {/* Section boxes */}
              {SECTION_ORDER.map((key) => {
                const box = draft.boxes[key];
                if (!box.visible) return null;
                const isSelected =
                  selected?.kind === "section" && selected.key === key;
                return (
                  <DraggableBox
                    key={key}
                    box={box}
                    color={SECTION_COLORS[key]}
                    label={SECTION_LABELS[key]}
                    selected={isSelected}
                    preview={
                      <SectionPreview
                        sectionKey={key}
                        fieldSizes={draft.fieldSizes}
                        scale={canvasScale}
                      />
                    }
                    onStart={(e, h) => startDrag(e, "section", key, h, box)}
                  />
                );
              })}

              {/* Extra images */}
              {draft.extraImages.map((img) => {
                const isSelected =
                  selected?.kind === "image" && selected.key === img.id;
                return (
                  <DraggableBox
                    key={img.id}
                    box={img}
                    color="rgba(99,102,241,0.10)"
                    label=""
                    selected={isSelected}
                    imageUrl={imageDataUrls[img.id]}
                    opacity={img.opacity}
                    onStart={(e, h) => startDrag(e, "image", img.id, h, img)}
                    onDelete={() => deleteImage(img.id)}
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
                You've made changes to the print layout. Save them as your
                lab's default for next time, or discard.
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

// ── DraggableBox helper ────────────────────────────────────────────────

interface DraggableBoxProps {
  box: { x: number; y: number; w: number; h: number };
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

  const style: React.CSSProperties = {
    position: "absolute",
    left: `${(box.x / PAGE_W) * 100}%`,
    top: `${(box.y / PAGE_H) * 100}%`,
    width: `${(box.w / PAGE_W) * 100}%`,
    height: `${(box.h / PAGE_H) * 100}%`,
    background: imageUrl ? "transparent" : color,
    border: selected
      ? "1.5px solid #2563eb"
      : "1px dashed rgba(0,0,0,0.35)",
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
      {imageUrl && (
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

      {!imageUrl && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          {/* Section label badge — always visible on top */}
          {label && (
            <span
              style={{
                position: "absolute",
                top: 3,
                left: 5,
                zIndex: 2,
                fontSize: 9,
                fontWeight: 700,
                color: "rgba(0,0,0,0.5)",
                background: "rgba(255,255,255,0.72)",
                borderRadius: 2,
                padding: "0 3px",
                lineHeight: "14px",
                whiteSpace: "nowrap",
                letterSpacing: "0.01em",
              }}
            >
              {label}
            </span>
          )}

          {/* Content preview — slightly blurred/faded to signal it's approximate */}
          {preview && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                filter: "blur(0.3px)",
                opacity: 0.78,
              }}
            >
              {preview}
            </div>
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

// ── Field size row ──────────────────────────────────────────────────────

const FIELD_SIZE_LABELS: Record<FieldSize, string> = {
  normal: "Normal",
  large: "Large",
  xl: "XL",
};

function FieldSizeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FieldSize;
  onChange: (size: FieldSize) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground flex-1 truncate">{label}</span>
      <div className="flex gap-0.5">
        {FIELD_SIZE_VALUES.map((sz) => (
          <button
            key={sz}
            type="button"
            onClick={() => onChange(sz)}
            className={`h-5 px-1.5 rounded text-[9px] font-medium border transition-colors ${
              value === sz
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:bg-secondary/60"
            }`}
          >
            {FIELD_SIZE_LABELS[sz]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Numeric inputs for selected box ────────────────────────────────────

interface BoxNumericInputsProps {
  box: { x: number; y: number; w: number; h: number };
  onChange: (patch: { x?: number; y?: number; w?: number; h?: number }) => void;
  minW?: number;
  minH?: number;
}

function BoxNumericInputs({
  box,
  onChange,
  minW = 40,
  minH = 20,
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

// ── Section content preview ─────────────────────────────────────────────
//
// Renders placeholder content inside each section box on the canvas so
// admins can see the effect of Normal/Large/XL field-size changes before
// printing. Font sizes are scaled to the canvas's actual render width.

interface SectionPreviewProps {
  sectionKey: CaseTemplateSectionKey;
  fieldSizes?: CasePrintFieldSizes;
  scale: number;
}

function scaledPx(base: number, scale: number): number {
  return Math.max(5, Math.round(base * scale));
}

function fieldFontSize(
  size: FieldSize | undefined,
  base: number,
  scale: number,
): number {
  const mult = size === "xl" ? 1.55 : size === "large" ? 1.28 : 1;
  return scaledPx(base * mult, scale);
}

// Tiny row: "Label  Value" used in caseDetails / rxSummary previews.
function PreviewRow({
  label,
  value,
  labelSize,
  valueSize,
}: {
  label: string;
  value: string;
  labelSize: number;
  valueSize: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: scaledPx(5, 1),
        lineHeight: 1.35,
        marginBottom: Math.max(2, Math.round(valueSize * 0.18)),
      }}
    >
      <span
        style={{
          fontSize: labelSize,
          color: "rgba(0,0,0,0.45)",
          whiteSpace: "nowrap",
          flexShrink: 0,
          minWidth: "28%",
        }}
      >
        {label}:
      </span>
      <span
        style={{
          fontSize: valueSize,
          fontWeight: 600,
          color: "rgba(0,0,0,0.82)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function SectionPreview({ sectionKey, fieldSizes, scale }: SectionPreviewProps) {
  const pad = scaledPx(8, scale);
  // base "normal" value font size at scale=1
  const BASE_VALUE = 9;
  const BASE_LABEL = 7;
  const labelSz = scaledPx(BASE_LABEL, scale);

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    padding: `${scaledPx(18, scale)}px ${pad}px ${pad}px`,
    overflow: "hidden",
    boxSizing: "border-box",
    fontFamily: "system-ui, sans-serif",
  };

  // ── Header ──────────────────────────────────────────────────────────
  if (sectionKey === "header") {
    return (
      <div style={containerStyle}>
        <div
          style={{
            fontSize: scaledPx(13, scale),
            fontWeight: 700,
            color: "rgba(0,0,0,0.8)",
            letterSpacing: "0.01em",
          }}
        >
          Case #LAB-2024-001
        </div>
        <div
          style={{
            marginTop: scaledPx(3, scale),
            display: "inline-flex",
            alignItems: "center",
            gap: scaledPx(4, scale),
            fontSize: scaledPx(8, scale),
            fontWeight: 600,
            color: "#16a34a",
            background: "rgba(22,163,74,0.1)",
            borderRadius: scaledPx(3, scale),
            padding: `${scaledPx(2, scale)}px ${scaledPx(6, scale)}px`,
          }}
        >
          <span
            style={{
              width: scaledPx(5, scale),
              height: scaledPx(5, scale),
              borderRadius: "50%",
              background: "#16a34a",
              display: "inline-block",
            }}
          />
          Active
        </div>
      </div>
    );
  }

  // ── Case Details ─────────────────────────────────────────────────────
  if (sectionKey === "caseDetails") {
    const cd = fieldSizes?.caseDetails;
    const rows: Array<{ field: CaseDetailField; label: string; value: string }> = [
      { field: "patient", label: CASE_DETAIL_FIELD_LABELS.patient, value: "Smith, John" },
      { field: "doctor", label: CASE_DETAIL_FIELD_LABELS.doctor, value: "Dr. Patel" },
      { field: "status", label: CASE_DETAIL_FIELD_LABELS.status, value: "Active" },
      { field: "priority", label: CASE_DETAIL_FIELD_LABELS.priority, value: "Standard" },
      { field: "dueDate", label: CASE_DETAIL_FIELD_LABELS.dueDate, value: "06/12/2024" },
      { field: "created", label: CASE_DETAIL_FIELD_LABELS.created, value: "06/01/2024" },
    ];
    return (
      <div style={containerStyle}>
        {rows.map(({ field, label, value }) => (
          <PreviewRow
            key={field}
            label={label}
            value={value}
            labelSize={labelSz}
            valueSize={fieldFontSize(cd?.[field], BASE_VALUE, scale)}
          />
        ))}
      </div>
    );
  }

  // ── RX Summary ───────────────────────────────────────────────────────
  if (sectionKey === "rxSummary") {
    const rx = fieldSizes?.rxSummary;
    const rows: Array<{ field: RxSummaryField; label: string; value: string }> = [
      { field: "restorativeType", label: RX_SUMMARY_FIELD_LABELS.restorativeType, value: "PFM Crown" },
      { field: "teeth", label: RX_SUMMARY_FIELD_LABELS.teeth, value: "#14, #15" },
      { field: "material", label: RX_SUMMARY_FIELD_LABELS.material, value: "Zirconia" },
      { field: "shade", label: RX_SUMMARY_FIELD_LABELS.shade, value: "A2" },
    ];
    return (
      <div style={containerStyle}>
        {rows.map(({ field, label, value }) => (
          <PreviewRow
            key={field}
            label={label}
            value={value}
            labelSize={labelSz}
            valueSize={fieldFontSize(rx?.[field], BASE_VALUE, scale)}
          />
        ))}
      </div>
    );
  }

  // ── Tooth Chart ──────────────────────────────────────────────────────
  if (sectionKey === "toothChart") {
    const cellSize = scaledPx(10, scale);
    const gap = scaledPx(2, scale);
    const topTeeth = Array.from({ length: 16 }, (_, i) => i + 1);
    const botTeeth = Array.from({ length: 16 }, (_, i) => i + 17);
    return (
      <div
        style={{
          ...containerStyle,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: scaledPx(4, scale),
        }}
      >
        {[topTeeth, botTeeth].map((row, ri) => (
          <div key={ri} style={{ display: "flex", gap }}>
            {row.map((n) => (
              <div
                key={n}
                style={{
                  width: cellSize,
                  height: cellSize,
                  borderRadius: scaledPx(2, scale),
                  background: "rgba(234,179,8,0.35)",
                  border: "1px solid rgba(234,179,8,0.6)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: Math.max(4, scaledPx(5, scale)),
                  color: "rgba(0,0,0,0.5)",
                  fontWeight: 600,
                }}
              >
                {n}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  // ── Notes ────────────────────────────────────────────────────────────
  if (sectionKey === "notes") {
    return (
      <div style={{ ...containerStyle, paddingTop: scaledPx(18, scale) }}>
        <div
          style={{
            fontSize: scaledPx(8, scale),
            color: "rgba(0,0,0,0.55)",
            lineHeight: 1.5,
          }}
        >
          Please call before delivery. Patient has sensitivity to metal alloys.
          Verify shade with photo on file. Rush order — needed by end of week.
        </div>
      </div>
    );
  }

  // ── Barcode ──────────────────────────────────────────────────────────
  if (sectionKey === "barcode") {
    const barH = "60%";
    const pattern = [2, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 3, 2, 1, 1, 2,
                     3, 1, 2, 1, 1, 3, 2, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 3];
    return (
      <div
        style={{
          ...containerStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
          padding: `${scaledPx(6, scale)}px ${scaledPx(12, scale)}px`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: "100%",
            gap: scaledPx(1, scale),
          }}
        >
          {pattern.map((w, i) =>
            i % 2 === 0 ? (
              <div
                key={i}
                style={{
                  width: w * scaledPx(1, scale),
                  height: barH,
                  background: "rgba(0,0,0,0.8)",
                  borderRadius: 0.5,
                  flexShrink: 0,
                }}
              />
            ) : (
              <div
                key={i}
                style={{ width: w * scaledPx(1, scale), flexShrink: 0 }}
              />
            ),
          )}
        </div>
      </div>
    );
  }

  return null;
}
