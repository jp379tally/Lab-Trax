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
  ImageIcon,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  isSameTemplate,
  PAGE_H,
  PAGE_W,
  SECTION_LABELS,
  SECTION_ORDER,
  type CasePrintExtraImage,
  type CasePrintTemplate,
  type CaseTemplateBox,
  type CaseTemplateSectionKey,
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
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<
    { kind: "section"; key: CaseTemplateSectionKey } | { kind: "image"; key: string } | null
  >(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [askKeep, setAskKeep] = useState(false);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const seededRef = useRef(false);

  // Seed local draft once the query loads.
  useEffect(() => {
    if (!seededRef.current && query.data) {
      setDraft(coerceCasePrintTemplate(query.data.template));
      seededRef.current = true;
    }
  }, [query.data]);

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
      setDirty(false);
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
      setDirty(true);
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
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX * d.scaleX - d.startX;
    const dy = e.clientY * d.scaleY - d.startY;
    const next = applyDrag(d.startBox, d.handle, dx, dy);
    setDraft((cur) => {
      if (d.kind === "section") {
        const k = d.key as CaseTemplateSectionKey;
        return {
          ...cur,
          boxes: {
            ...cur.boxes,
            [k]: { ...cur.boxes[k], ...next },
          },
        };
      }
      return {
        ...cur,
        extraImages: cur.extraImages.map((img) =>
          img.id === d.key ? { ...img, ...next } : img,
        ),
      };
    });
    setDirty(true);
  }

  function endDrag() {
    dragRef.current = null;
  }

  // ── Sidebar mutators ──────────────────────────────────────────────────
  function patchBox(key: CaseTemplateSectionKey, patch: Partial<CaseTemplateBox>) {
    setDraft((cur) => ({
      ...cur,
      boxes: { ...cur.boxes, [key]: { ...cur.boxes[key], ...patch } },
    }));
    setDirty(true);
  }

  function patchImage(id: string, patch: Partial<CasePrintExtraImage>) {
    setDraft((cur) => ({
      ...cur,
      extraImages: cur.extraImages.map((img) =>
        img.id === id ? { ...img, ...patch } : img,
      ),
    }));
    setDirty(true);
  }

  function deleteImage(id: string) {
    setDraft((cur) => ({
      ...cur,
      extraImages: cur.extraImages.filter((img) => img.id !== id),
    }));
    setDirty(true);
    if (selected?.kind === "image" && selected.key === id) setSelected(null);
    // Fire-and-forget storage cleanup
    deleteImageMutation.mutate(id);
  }

  function resetToDefaults() {
    setDraft(DEFAULT_CASE_PRINT_TEMPLATE);
    setDirty(true);
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
                        src={img.url}
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
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
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
                    imageUrl={img.url}
                    opacity={img.opacity}
                    onStart={(e, h) => startDrag(e, "image", img.id, h, img)}
                    onDelete={() => deleteImage(img.id)}
                  />
                );
              })}
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

      {!imageUrl && label && (
        <span
          style={{
            position: "absolute",
            top: 4,
            left: 6,
            fontSize: 10,
            fontWeight: 600,
            color: "rgba(0,0,0,0.55)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
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
