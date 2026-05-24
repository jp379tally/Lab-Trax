import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Eye,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  coerceInvoiceTemplate,
  DEFAULT_INVOICE_TEMPLATE,
  type InvoiceTemplate,
  type InvoiceTemplateBox as TemplateBox,
  type InvoiceTemplateTextBlock,
  type TextAlign,
} from "@/lib/invoice-template";
import { previewInvoicePdf } from "@/lib/export";

type SectionKey = keyof InvoiceTemplate["boxes"];

/**
 * Splits text into the individual wrapped lines that jsPDF will produce for a
 * custom text block. Mirrors the `fontSize * 1.3` line-height and word-wrap
 * logic used in `buildInvoiceDoc` inside export.ts.
 *
 * @param text     Raw text content (may contain newlines)
 * @param fontSize Point size used for the block (same unit as jsPDF)
 * @param boxW     Box width in PDF points
 */
function splitTextToPreviewLines(text: string, fontSize: number, boxW: number): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const result: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) {
      result.push("");
      continue;
    }
    if (ctx) {
      // 1 PDF point ≈ 1 px for relative measurement; Helvetica is the PDF font.
      ctx.font = `${fontSize}px Helvetica, Arial, sans-serif`;
      const words = rawLine.split(" ");
      let current = "";
      let curW = 0;
      for (const word of words) {
        const space = current ? " " : "";
        const ww = ctx.measureText(space + word).width;
        if (current && curW + ww > boxW) {
          result.push(current);
          current = word;
          curW = ctx.measureText(word).width;
        } else {
          current += space + word;
          curW += ww;
        }
      }
      if (current) result.push(current);
    } else {
      // Fallback: assume ~0.55 pt per char (Helvetica average)
      const charsPerLine = Math.max(1, Math.floor(boxW / (fontSize * 0.55)));
      for (let i = 0; i < rawLine.length; i += charsPerLine) {
        result.push(rawLine.slice(i, i + charsPerLine));
      }
    }
  }
  return result;
}

/**
 * Estimates the number of wrapped lines jsPDF will produce — thin wrapper
 * over splitTextToPreviewLines kept for the sidebar line-count display.
 */
function estimateTextLines(text: string, fontSize: number, boxW: number): number {
  return splitTextToPreviewLines(text, fontSize, boxW).length;
}

const SECTION_LABELS: Record<SectionKey, string> = {
  header: "Header (Invoice + #)",
  billTo: "Bill-to / Patient",
  meta: "Issued / Due / Status",
  items: "Line items",
  totals: "Totals",
};

const SECTION_COLORS: Record<SectionKey, string> = {
  header: "rgba(59,130,246,0.18)",
  billTo: "rgba(16,185,129,0.18)",
  meta: "rgba(234,179,8,0.18)",
  items: "rgba(168,85,247,0.18)",
  totals: "rgba(244,63,94,0.18)",
};

const FONT_SIZES = [8, 10, 12, 14, 18] as const;

interface TemplateApi {
  template: InvoiceTemplate;
  isCustom: boolean;
  defaultTemplate: InvoiceTemplate;
}

interface UploadedImage {
  id: string;
  url: string;
  contentType: string;
  size: number;
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface DragState {
  kind: "section" | "logo" | "extra" | "text";
  key: string;
  handle: Handle;
  startX: number;
  startY: number;
  startBox: TemplateBox;
}

const PAGE_W = 612;
const PAGE_H = 792;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function applyDrag(start: TemplateBox, h: Handle, dx: number, dy: number): TemplateBox {
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
  bh = Math.max(20, bh);
  x = clamp(x, 0, PAGE_W - w);
  y = clamp(y, 0, PAGE_H - bh);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(bh) };
}

function newTextBlock(): InvoiceTemplateTextBlock {
  return {
    id: crypto.randomUUID(),
    x: 40,
    y: 680,
    w: 240,
    h: 40,
    text: "",
    fontSize: 10,
    align: "left",
    bold: false,
  };
}

export function InvoiceLayoutPanel() {
  const { user, refresh } = useAuth() as {
    user: { practiceOrganizationId?: string | null; practiceLogoUrl?: string | null } | null;
    refresh?: () => Promise<void>;
  };
  const orgId = user?.practiceOrganizationId ?? null;
  const qc = useQueryClient();

  const query = useQuery<TemplateApi>({
    enabled: !!orgId,
    queryKey: ["invoiceTemplate", orgId],
    queryFn: async () => {
      const res = await apiFetch<{ data: TemplateApi } | TemplateApi>(
        `/organizations/${orgId}/invoice-template`,
      );
      return (res as any).data ?? (res as any);
    },
  });

  const [draft, setDraft] = useState<InvoiceTemplate>(DEFAULT_INVOICE_TEMPLATE);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<{ kind: "section" | "logo" | "extra" | "text"; key: string } | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setDraft(coerceInvoiceTemplate(query.data.template));
    setDirty(false);
  }, [query.data]);

  // Deselect when clicking outside selection.
  useEffect(() => {
    if (!selected) return;
    const kind = selected.kind;
    const key = selected.key;
    if (kind === "text") {
      const exists = draft.customTexts.some((t) => t.id === key);
      if (!exists) setSelected(null);
    } else if (kind === "extra") {
      const idx = Number(key);
      if (!draft.extraImages[idx]) setSelected(null);
    }
  }, [draft, selected]);

  const saveMutation = useMutation({
    mutationFn: async (template: InvoiceTemplate | null) => {
      await apiFetch(`/organizations/${orgId}/invoice-template`, {
        method: "PUT",
        body: JSON.stringify({ template }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["invoiceTemplate", orgId] });
      void refresh?.();
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<{ data: UploadedImage } | UploadedImage>(
        `/organizations/${orgId}/invoice-template/images`,
        { method: "POST", body: form },
      );
      return ((res as any).data ?? res) as UploadedImage;
    },
    onSuccess: (img) => {
      setDraft((d) => ({
        ...d,
        extraImages: [
          ...d.extraImages,
          {
            id: img.id,
            storageKey: (img as { storageKey?: string }).storageKey ?? "",
            url: img.url,
            x: 80,
            y: 600,
            w: 160,
            h: 80,
            opacity: 1,
          },
        ],
      }));
      setDirty(true);
    },
  });

  // ── Pointer / drag handlers ─────────────────────────────────────────
  function startDrag(
    e: React.PointerEvent,
    kind: DragState["kind"],
    key: string,
    handle: Handle,
    box: TemplateBox,
  ) {
    e.stopPropagation();
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = PAGE_W / rect.width;
    dragRef.current = {
      kind,
      key,
      handle,
      startX: e.clientX * scale,
      startY: e.clientY * scale,
      startBox: { ...box },
    };
    setSelected({ kind, key });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = PAGE_W / rect.width;
    const dx = e.clientX * scale - d.startX;
    const dy = e.clientY * scale - d.startY;
    const next = applyDrag(d.startBox, d.handle, dx, dy);
    setDraft((cur) => {
      if (d.kind === "section") {
        return { ...cur, boxes: { ...cur.boxes, [d.key]: next } };
      }
      if (d.kind === "logo") {
        return { ...cur, logo: { ...cur.logo, ...next } };
      }
      if (d.kind === "extra") {
        const idx = Number(d.key);
        const extras = cur.extraImages.slice();
        extras[idx] = { ...extras[idx], ...next };
        return { ...cur, extraImages: extras };
      }
      if (d.kind === "text") {
        return {
          ...cur,
          customTexts: cur.customTexts.map((t) =>
            t.id === d.key ? { ...t, ...next } : t
          ),
        };
      }
      return cur;
    });
    setDirty(true);
  }

  function endDrag() {
    dragRef.current = null;
  }

  // ── Selected extra image / text block props ─────────────────────────
  const selectedExtraIdx =
    selected?.kind === "extra" ? Number(selected.key) : -1;
  const selectedExtra =
    selectedExtraIdx >= 0 ? draft.extraImages[selectedExtraIdx] : null;
  const selectedText =
    selected?.kind === "text"
      ? draft.customTexts.find((t) => t.id === selected.key) ?? null
      : null;

  function updateSelectedText(patch: Partial<InvoiceTemplateTextBlock>) {
    if (!selected || selected.kind !== "text") return;
    const id = selected.key;
    setDraft((d) => ({
      ...d,
      customTexts: d.customTexts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
    setDirty(true);
  }

  function deleteExtraImage(idx: number) {
    const img = draft.extraImages[idx];
    setDraft((d) => ({
      ...d,
      extraImages: d.extraImages.filter((_, j) => j !== idx),
    }));
    setDirty(true);
    if (selected?.kind === "extra" && Number(selected.key) === idx) {
      setSelected(null);
    }
    if (img) {
      apiFetch(
        `/organizations/${orgId}/invoice-template/images/${img.id}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
  }

  function deleteTextBlock(id: string) {
    setDraft((d) => ({
      ...d,
      customTexts: d.customTexts.filter((t) => t.id !== id),
    }));
    setDirty(true);
    if (selected?.kind === "text" && selected.key === id) {
      setSelected(null);
    }
  }

  async function handlePreview() {
    setIsPreviewing(true);
    setPreviewError(null);
    try {
      const extraImageDataUrls: Record<string, string> = {};
      await Promise.all(
        draft.extraImages.map(async (img) => {
          if (!img.url) return;
          try {
            const res = await fetch(img.url);
            const blob = await res.blob();
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            extraImageDataUrls[img.url] = dataUrl;
          } catch {
            /* skip image that fails to load */
          }
        }),
      );
      const opened = previewInvoicePdf({
        invoiceNumber: "PREVIEW-001",
        labName: "Sample Dental Lab",
        practiceName: "Riverside Dental",
        patientName: "Jane Doe",
        billTo: "Riverside Dental",
        teeth: "3, 14, 30",
        shade: "A2",
        issuedAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        status: "Open",
        items: [
          { description: "PFM Crown", quantity: 1, unitPrice: 250, lineTotal: 250 },
          { description: "Porcelain Pontic", quantity: 2, unitPrice: 175, lineTotal: 350 },
          { description: "Custom Shade", quantity: 1, unitPrice: 45, lineTotal: 45 },
        ],
        subtotal: 645,
        total: 645,
        balanceDue: 645,
        notes: "Thank you for choosing our lab.",
        generatedAt: new Date(),
        logoUrl: user?.practiceLogoUrl ?? null,
        template: draft,
        extraImageDataUrls,
      });
      if (!opened) {
        setPreviewError("Preview was blocked. Please allow pop-ups for this site.");
      }
    } catch (err) {
      setPreviewError((err as Error)?.message ?? "Preview failed.");
    } finally {
      setIsPreviewing(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (!orgId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select a lab organization to edit its invoice layout.
      </div>
    );
  }
  if (query.isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading template…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="p-6 text-sm text-destructive">
        Failed to load invoice template. {(query.error as Error)?.message}
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Invoice layout</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Drag and resize sections, images, and text blocks to design the invoice PDF.
            Changes apply to every invoice this lab generates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handlePreview()}
            disabled={isPreviewing}
            title="Render a sample invoice PDF using the current unsaved layout"
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-50 flex items-center gap-1"
          >
            {isPreviewing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Eye size={12} />
            )}
            Preview PDF
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(coerceInvoiceTemplate(query.data?.template));
              setDirty(false);
              setSelected(null);
            }}
            disabled={!dirty || saveMutation.isPending}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirm("Reset to the built-in default layout?")) return;
              setSelected(null);
              saveMutation.mutate(null);
            }}
            disabled={saveMutation.isPending}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-50 flex items-center gap-1"
          >
            <RotateCcw size={12} /> Reset to default
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate(draft)}
            disabled={!dirty || saveMutation.isPending}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
          >
            {saveMutation.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            Save layout
          </button>
        </div>
      </div>

      {previewError ? (
        <div className="mb-3 text-xs text-destructive">
          {previewError}
        </div>
      ) : null}
      {saveMutation.isError ? (
        <div className="mb-3 text-xs text-destructive">
          Save failed: {(saveMutation.error as Error)?.message}
        </div>
      ) : null}

      <div className="grid grid-cols-[1fr_280px] gap-6">
        {/* Canvas */}
        <div
          ref={canvasRef}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onClick={() => setSelected(null)}
          className="relative bg-white border border-border rounded shadow-sm select-none"
          style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}`, width: "100%", maxWidth: 612 }}
        >
          {/* Watermark logo preview */}
          {draft.logo.mode === "watermark" && user?.practiceLogoUrl ? (
            <img
              src={user.practiceLogoUrl}
              alt=""
              style={{
                position: "absolute",
                left: `${(draft.logo.x / PAGE_W) * 100}%`,
                top: `${(draft.logo.y / PAGE_H) * 100}%`,
                width: `${(draft.logo.w / PAGE_W) * 100}%`,
                height: `${(draft.logo.h / PAGE_H) * 100}%`,
                opacity: draft.logo.opacity,
                pointerEvents: "none",
                objectFit: "contain",
              }}
            />
          ) : null}

          {/* Extra images */}
          {draft.extraImages.map((img, i) => (
            <DraggableBox
              key={img.id}
              box={img}
              color="rgba(99,102,241,0.18)"
              label={`Image ${i + 1}`}
              selected={selected?.kind === "extra" && selected?.key === String(i)}
              imageUrl={img.url}
              opacity={img.opacity}
              onStart={(e, h) => startDrag(e, "extra", String(i), h, img)}
              onDelete={() => deleteExtraImage(i)}
            />
          ))}

          {/* Custom text blocks */}
          {draft.customTexts.map((tb) => (
            <DraggableBox
              key={tb.id}
              box={tb}
              color="rgba(251,146,60,0.18)"
              label={tb.text || "Text"}
              selected={selected?.kind === "text" && selected?.key === tb.id}
              textBlock={tb}
              onStart={(e, h) => startDrag(e, "text", tb.id, h, tb)}
              onDelete={() => deleteTextBlock(tb.id)}
            />
          ))}

          {/* Logo (header mode) */}
          {draft.logo.mode === "header" ? (
            <DraggableBox
              box={draft.logo}
              color="rgba(14,165,233,0.22)"
              label="Logo"
              selected={selected?.kind === "logo"}
              imageUrl={user?.practiceLogoUrl ?? undefined}
              onStart={(e, h) => startDrag(e, "logo", "logo", h, draft.logo)}
            />
          ) : null}

          {/* Section boxes */}
          {(Object.keys(draft.boxes) as SectionKey[]).map((k) => (
            <DraggableBox
              key={k}
              box={draft.boxes[k]}
              color={SECTION_COLORS[k]}
              label={SECTION_LABELS[k]}
              selected={selected?.kind === "section" && selected?.key === k}
              onStart={(e, h) => startDrag(e, "section", k, h, draft.boxes[k])}
            />
          ))}
        </div>

        {/* Right rail: controls */}
        <div className="space-y-5 text-sm">

          {/* ── Selected text block editor ─────────────────────────── */}
          {selectedText ? (
            <section className="p-3 rounded border border-orange-200 bg-orange-50 dark:bg-orange-950/20 dark:border-orange-800 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400 mb-2">
                Edit text block
              </h3>
              <textarea
                className="w-full text-xs p-2 rounded border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
                placeholder="Enter text…"
                value={selectedText.text}
                onChange={(e) => updateSelectedText({ text: e.target.value })}
              />
              {/* Live line-count and overflow warning */}
              {(() => {
                const lineH = selectedText.fontSize * 1.3;
                const maxLines = Math.max(1, Math.floor(selectedText.h / lineH));
                const text = selectedText.text;
                const estimatedLines = text.trim()
                  ? estimateTextLines(text, selectedText.fontSize, selectedText.w)
                  : 0;
                const willClip = estimatedLines > maxLines;
                return (
                  <div className="space-y-1">
                    <p className={`text-xs ${willClip ? "text-amber-700 dark:text-amber-400 font-medium" : "text-muted-foreground"}`}>
                      {estimatedLines > 0
                        ? `~${estimatedLines} line${estimatedLines !== 1 ? "s" : ""} / ${maxLines} max`
                        : `${maxLines} line${maxLines !== 1 ? "s" : ""} max`}
                    </p>
                    {willClip && (
                      <div className="flex items-start gap-1.5 rounded px-2 py-1.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs">
                        <span className="shrink-0 mt-px">⚠</span>
                        <span>Text will be clipped — resize the box or reduce content</span>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">Size</span>
                <select
                  value={selectedText.fontSize}
                  onChange={(e) => updateSelectedText({ fontSize: Number(e.target.value) })}
                  className="text-xs px-1.5 py-1 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary flex-1"
                >
                  {FONT_SIZES.map((s) => (
                    <option key={s} value={s}>{s} pt</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => updateSelectedText({ align: "left" })}
                  title="Align left"
                  className={`p-1.5 rounded ${selectedText.align === "left" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
                >
                  <AlignLeft size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => updateSelectedText({ align: "center" })}
                  title="Align center"
                  className={`p-1.5 rounded ${selectedText.align === "center" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
                >
                  <AlignCenter size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => updateSelectedText({ align: "right" })}
                  title="Align right"
                  className={`p-1.5 rounded ${selectedText.align === "right" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
                >
                  <AlignRight size={12} />
                </button>
                <div className="w-px h-4 bg-border mx-0.5" />
                <button
                  type="button"
                  onClick={() => updateSelectedText({ bold: !selectedText.bold })}
                  title="Bold"
                  className={`p-1.5 rounded ${selectedText.bold ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
                >
                  <Bold size={12} />
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => deleteTextBlock(selectedText.id)}
                  title="Delete text block"
                  className="p-1.5 rounded text-destructive hover:bg-destructive/10"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </section>
          ) : null}

          {/* ── Selected extra image controls ──────────────────────── */}
          {selectedExtra ? (
            <section className="p-3 rounded border border-indigo-200 bg-indigo-50 dark:bg-indigo-950/20 dark:border-indigo-800 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 mb-2">
                Image {selectedExtraIdx + 1}
              </h3>
              <label className="block">
                <span className="text-xs text-muted-foreground">
                  Opacity {(selectedExtra.opacity * 100).toFixed(0)}%
                </span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={selectedExtra.opacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setDraft((d) => {
                      const next = d.extraImages.slice();
                      next[selectedExtraIdx] = { ...next[selectedExtraIdx], opacity: v };
                      return { ...d, extraImages: next };
                    });
                    setDirty(true);
                  }}
                  className="w-full mt-1"
                />
              </label>
              <button
                type="button"
                onClick={() => deleteExtraImage(selectedExtraIdx)}
                className="text-xs text-destructive hover:bg-destructive/10 px-2 py-1 rounded flex items-center gap-1"
              >
                <Trash2 size={11} /> Remove image
              </button>
            </section>
          ) : null}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Lab logo
            </h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="logoMode"
                  checked={draft.logo.mode === "header"}
                  onChange={() => {
                    setDraft((d) => ({ ...d, logo: { ...d.logo, mode: "header" } }));
                    setDirty(true);
                  }}
                />
                Header (top-right)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="logoMode"
                  checked={draft.logo.mode === "watermark"}
                  onChange={() => {
                    setDraft((d) => ({ ...d, logo: { ...d.logo, mode: "watermark" } }));
                    setDirty(true);
                  }}
                />
                Watermark (full page)
              </label>
              {draft.logo.mode === "watermark" ? (
                <label className="block">
                  <span className="text-xs text-muted-foreground">
                    Opacity {(draft.logo.opacity * 100).toFixed(0)}%
                  </span>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={draft.logo.opacity}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setDraft((d) => ({ ...d, logo: { ...d.logo, opacity: v } }));
                      setDirty(true);
                    }}
                    className="w-full"
                  />
                </label>
              ) : null}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Custom text
            </h3>
            <button
              type="button"
              onClick={() => {
                const tb = newTextBlock();
                setDraft((d) => ({ ...d, customTexts: [...d.customTexts, tb] }));
                setDirty(true);
                setSelected({ kind: "text", key: tb.id });
              }}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary flex items-center gap-1"
            >
              <Plus size={12} /> Add text block
            </button>
            {draft.customTexts.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {draft.customTexts.map((tb, i) => (
                  <li
                    key={tb.id}
                    className={`flex items-center gap-2 text-xs p-2 rounded border cursor-pointer ${
                      selected?.kind === "text" && selected.key === tb.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-secondary"
                    }`}
                    onClick={() => setSelected({ kind: "text", key: tb.id })}
                  >
                    <span className="truncate flex-1 text-muted-foreground">
                      {tb.text || `Text ${i + 1}`}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTextBlock(tb.id);
                      }}
                      className="text-destructive hover:bg-destructive/10 p-0.5 rounded"
                      aria-label="Remove text block"
                    >
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No custom text blocks.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Extra images
            </h3>
            <label className="block">
              <span className="sr-only">Upload image</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) uploadMutation.mutate(f);
                  e.currentTarget.value = "";
                }}
                className="hidden"
                id="invoice-extra-upload"
              />
              <button
                type="button"
                onClick={() =>
                  document.getElementById("invoice-extra-upload")?.click()
                }
                disabled={uploadMutation.isPending}
                className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary flex items-center gap-1 disabled:opacity-50"
              >
                {uploadMutation.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Upload size={12} />
                )}
                Upload image (≤ 5 MB)
              </button>
            </label>
            {uploadMutation.isError ? (
              <div className="mt-2 text-xs text-destructive">
                Upload failed: {(uploadMutation.error as Error)?.message}
              </div>
            ) : null}
            <ul className="mt-3 space-y-2">
              {draft.extraImages.map((img, i) => (
                <li
                  key={img.id}
                  className={`flex items-center gap-2 text-xs p-2 rounded border cursor-pointer ${
                    selected?.kind === "extra" && selected.key === String(i)
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-secondary"
                  }`}
                  onClick={() => setSelected({ kind: "extra", key: String(i) })}
                >
                  <span className="truncate flex-1">Image {i + 1}</span>
                  <span className="text-muted-foreground shrink-0">
                    {(img.opacity * 100).toFixed(0)}%
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteExtraImage(i);
                    }}
                    className="text-destructive hover:bg-destructive/10 p-1 rounded"
                    aria-label="Remove image"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
              {draft.extraImages.length === 0 ? (
                <li className="text-xs text-muted-foreground">
                  No extra images.
                </li>
              ) : null}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Sections
            </h3>
            <ul className="space-y-1 text-xs">
              {(Object.keys(SECTION_LABELS) as SectionKey[]).map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 rounded-sm border border-border"
                    style={{ background: SECTION_COLORS[k] }}
                  />
                  {SECTION_LABELS[k]}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground mt-2">
              {query.data?.isCustom
                ? "This lab is using a custom layout."
                : "This lab is using the built-in default layout."}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

interface DraggableBoxProps {
  box: TemplateBox;
  color: string;
  label: string;
  selected?: boolean;
  imageUrl?: string;
  opacity?: number;
  textBlock?: InvoiceTemplateTextBlock;
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
  textBlock,
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
    background: color,
    border: selected ? "1.5px solid #2563eb" : "1px dashed rgba(0,0,0,0.35)",
    cursor: "move",
    boxSizing: "border-box",
  };

  const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const showDelete = onDelete && (selected || hovered);

  return (
    <div
      style={style}
      onPointerDown={(e) => onStart(e, "move")}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            pointerEvents: "none",
            opacity: opacity !== undefined ? opacity : 0.7,
          }}
        />
      ) : null}

      {textBlock ? (() => {
        const lineH = textBlock.fontSize * 1.3;
        const maxLines = Math.max(1, Math.floor(textBlock.h / lineH));
        const hasText = !!textBlock.text?.trim();
        const lines = hasText
          ? splitTextToPreviewLines(textBlock.text, textBlock.fontSize, textBlock.w)
          : [];
        const visibleLines = lines.slice(0, maxLines);
        const clippedLines = lines.slice(maxLines);

        return (
          <div
            style={{
              position: "absolute",
              inset: 2,
              fontSize: `${(textBlock.fontSize / PAGE_H) * 100}cqh`,
              fontWeight: textBlock.bold ? "bold" : "normal",
              textAlign: textBlock.align as TextAlign,
              color: "#111",
              lineHeight: 1.3,
              pointerEvents: "none",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              padding: "2px 4px",
              overflow: "visible",
            }}
          >
            {!hasText ? (
              <span style={{ opacity: 0.4, fontStyle: "italic", fontWeight: "normal", width: "100%" }}>
                Text
              </span>
            ) : (
              <>
                {visibleLines.map((line, i) => (
                  <span
                    key={i}
                    style={{ width: "100%", display: "block", whiteSpace: "pre-wrap" }}
                  >
                    {line || "\u00A0"}
                  </span>
                ))}
                {clippedLines.map((line, i) => (
                  <span
                    key={`clipped-${i}`}
                    style={{
                      width: "100%",
                      display: "block",
                      whiteSpace: "pre-wrap",
                      opacity: 0.3,
                      textDecoration: "line-through",
                      textDecorationColor: "#ef4444",
                      color: "#ef4444",
                    }}
                  >
                    {line || "\u00A0"}
                  </span>
                ))}
              </>
            )}
          </div>
        );
      })() : null}

      {!textBlock ? (
        <span
          style={{
            position: "absolute",
            left: 4,
            top: 2,
            fontSize: 9,
            fontFamily: "ui-sans-serif, system-ui",
            color: "#111",
            background: "rgba(255,255,255,0.7)",
            padding: "0 4px",
            borderRadius: 2,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      ) : null}

      {/* Delete button */}
      {showDelete ? (
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete?.();
          }}
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#ef4444",
            color: "white",
            border: "1.5px solid white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            zIndex: 10,
            padding: 0,
          }}
          aria-label="Delete"
        >
          <X size={9} strokeWidth={3} />
        </button>
      ) : null}

      {handles.map((h) => (
        <span
          key={h}
          onPointerDown={(e) => {
            e.stopPropagation();
            onStart(e, h);
          }}
          style={{
            position: "absolute",
            width: 8,
            height: 8,
            background: "#2563eb",
            border: "1px solid white",
            ...handlePos(h),
            cursor: handleCursor(h),
          }}
        />
      ))}
    </div>
  );
}

function handlePos(h: Handle): React.CSSProperties {
  const edge = -4;
  const mid = "calc(50% - 4px)";
  switch (h) {
    case "nw": return { left: edge, top: edge };
    case "n":  return { left: mid, top: edge };
    case "ne": return { right: edge, top: edge };
    case "e":  return { right: edge, top: mid };
    case "se": return { right: edge, bottom: edge };
    case "s":  return { left: mid, bottom: edge };
    case "sw": return { left: edge, bottom: edge };
    case "w":  return { left: edge, top: mid };
    default:   return {};
  }
}

function handleCursor(h: Handle): string {
  switch (h) {
    case "n":
    case "s":  return "ns-resize";
    case "e":
    case "w":  return "ew-resize";
    case "ne":
    case "sw": return "nesw-resize";
    case "nw":
    case "se": return "nwse-resize";
    default:   return "move";
  }
}
