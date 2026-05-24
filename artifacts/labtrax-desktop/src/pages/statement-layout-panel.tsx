import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
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
  coerceStatementTemplate,
  DEFAULT_STATEMENT_TEMPLATE,
  stmtDefaultTextBlockPosition,
  STATEMENT_SECTION_COLORS,
  STATEMENT_SECTION_LABELS,
  type StatementDefaultTextBlock,
  type StatementTemplate,
  type StatementTemplateBox as TemplateBox,
  type StatementTemplateTextBlock,
  type TextAlign,
} from "@/lib/statement-template";
import { previewStatementLayoutPdf } from "@/lib/export";

const PAGE_W = 612;
const PAGE_H = 792;
const FONT_SIZES = [8, 10, 12, 14, 18] as const;

type SectionKey = keyof StatementTemplate["boxes"];

interface TemplateApi {
  template: StatementTemplate;
  isCustom: boolean;
  defaultTemplate: StatementTemplate;
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function boxesOverlap(a: TemplateBox, b: TemplateBox): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function boxEdgesOutOfBounds(b: TemplateBox): string[] {
  const edges: string[] = [];
  if (b.x < 0) edges.push("left");
  if (b.y < 0) edges.push("top");
  if (b.x + b.w > PAGE_W) edges.push("right");
  if (b.y + b.h > PAGE_H) edges.push("bottom");
  return edges;
}

function applyDrag(start: TemplateBox, h: Handle, dx: number, dy: number): TemplateBox {
  let { x, y, w, h: bh } = start;
  if (h === "move") {
    x += dx;
    y += dy;
  } else {
    if (h.includes("n")) { y += dy; bh -= dy; }
    if (h.includes("s")) { bh += dy; }
    if (h.includes("w")) { x += dx; w -= dx; }
    if (h.includes("e")) { w += dx; }
  }
  w = Math.max(20, w);
  bh = Math.max(20, bh);
  x = clamp(x, 0, PAGE_W - w);
  y = clamp(y, 0, PAGE_H - bh);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(bh) };
}

function newTextBlock(): StatementTemplateTextBlock {
  return {
    id: crypto.randomUUID(),
    x: 40, y: 680, w: 240, h: 40,
    text: "", fontSize: 10, align: "left", bold: false,
  };
}

function isDefaultEnabled(draft: StatementTemplate, defId: string): boolean {
  return draft.customTexts.some((ct) => ct.sourceId === defId);
}

function enableDefault(draft: StatementTemplate, def: StatementDefaultTextBlock): StatementTemplate {
  if (isDefaultEnabled(draft, def.id)) return draft;
  const idx = draft.defaultTextBlocks.findIndex((d) => d.id === def.id);
  const pos = stmtDefaultTextBlockPosition(idx >= 0 ? idx : draft.defaultTextBlocks.length);
  const newBlock: StatementTemplateTextBlock = {
    id: crypto.randomUUID(), sourceId: def.id,
    x: pos.x, y: pos.y, w: pos.w, h: pos.h,
    text: def.text, fontSize: def.fontSize, align: def.align, bold: def.bold,
  };
  return { ...draft, customTexts: [...draft.customTexts, newBlock] };
}

function disableDefault(draft: StatementTemplate, defId: string): StatementTemplate {
  return { ...draft, customTexts: draft.customTexts.filter((ct) => ct.sourceId !== defId) };
}

function syncDefaultToCanvas(
  draft: StatementTemplate,
  patch: Partial<StatementDefaultTextBlock> & { id: string },
): StatementTemplate {
  return {
    ...draft,
    customTexts: draft.customTexts.map((ct) =>
      ct.sourceId === patch.id
        ? { ...ct, text: patch.text ?? ct.text, fontSize: patch.fontSize ?? ct.fontSize, align: patch.align ?? ct.align, bold: patch.bold ?? ct.bold }
        : ct,
    ),
  };
}

export function StatementLayoutPanel() {
  const { user, refresh } = useAuth() as {
    user: { practiceOrganizationId?: string | null; practiceLogoUrl?: string | null } | null;
    refresh?: () => Promise<void>;
  };
  const orgId = user?.practiceOrganizationId ?? null;
  const qc = useQueryClient();

  const query = useQuery<TemplateApi>({
    enabled: !!orgId,
    queryKey: ["statementTemplate", orgId],
    queryFn: async () => {
      const res = await apiFetch<{ data: TemplateApi } | TemplateApi>(
        `/organizations/${orgId}/statement-template`,
      );
      return (res as any).data ?? (res as any);
    },
  });

  const [draft, setDraft] = useState<StatementTemplate>(DEFAULT_STATEMENT_TEMPLATE);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<{ kind: "section" | "logo" | "extra" | "text"; key: string } | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [editingDefaultId, setEditingDefaultId] = useState<string | null>(null);
  const [hoveredDefaultId, setHoveredDefaultId] = useState<string | null>(null);
  const [pinnedPreviewId, setPinnedPreviewId] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setDraft(coerceStatementTemplate(query.data.template));
    setDirty(false);
  }, [query.data]);

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "text" && !draft.customTexts.some((t) => t.id === selected.key)) setSelected(null);
    if (selected.kind === "extra" && !draft.extraImages[Number(selected.key)]) setSelected(null);
  }, [draft, selected]);

  const saveMutation = useMutation({
    mutationFn: async (template: StatementTemplate | null) => {
      await apiFetch(`/organizations/${orgId}/statement-template`, {
        method: "PUT",
        body: JSON.stringify({ template }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["statementTemplate", orgId] });
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
          { id: img.id, storageKey: (img as any).storageKey ?? "", url: img.url, x: 80, y: 600, w: 160, h: 80, opacity: 1 },
        ],
      }));
      setDirty(true);
    },
  });

  function startDrag(e: React.PointerEvent, kind: DragState["kind"], key: string, handle: Handle, box: TemplateBox) {
    e.stopPropagation();
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = PAGE_W / rect.width;
    dragRef.current = { kind, key, handle, startX: e.clientX * scale, startY: e.clientY * scale, startBox: { ...box } };
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
      if (d.kind === "section") return { ...cur, boxes: { ...cur.boxes, [d.key]: next } };
      if (d.kind === "logo") return { ...cur, logo: { ...cur.logo, ...next } };
      if (d.kind === "extra") {
        const idx = Number(d.key);
        const extras = cur.extraImages.slice();
        extras[idx] = { ...extras[idx], ...next };
        return { ...cur, extraImages: extras };
      }
      if (d.kind === "text") {
        return { ...cur, customTexts: cur.customTexts.map((t) => t.id === d.key ? { ...t, ...next } : t) };
      }
      return cur;
    });
    setDirty(true);
  }

  function endDrag() { dragRef.current = null; }

  const overlappingPairs: [SectionKey, SectionKey][] = [];
  {
    const keys = Object.keys(draft.boxes) as SectionKey[];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (boxesOverlap(draft.boxes[keys[i]], draft.boxes[keys[j]])) overlappingPairs.push([keys[i], keys[j]]);
      }
    }
  }
  const overlappingSections = new Set<SectionKey>(overlappingPairs.flat());
  const outOfBoundsSections = (Object.keys(draft.boxes) as SectionKey[])
    .map((k) => ({ key: k, edges: boxEdgesOutOfBounds(draft.boxes[k]) }))
    .filter((e) => e.edges.length > 0);

  const selectedExtraIdx = selected?.kind === "extra" ? Number(selected.key) : -1;
  const selectedExtra = selectedExtraIdx >= 0 ? draft.extraImages[selectedExtraIdx] : null;
  const selectedText = selected?.kind === "text" ? draft.customTexts.find((t) => t.id === selected.key) ?? null : null;

  function updateSelectedText(patch: Partial<StatementTemplateTextBlock>) {
    if (!selected || selected.kind !== "text") return;
    const id = selected.key;
    setDraft((d) => ({ ...d, customTexts: d.customTexts.map((t) => t.id === id ? { ...t, ...patch } : t) }));
    setDirty(true);
  }

  function deleteExtraImage(idx: number) {
    const img = draft.extraImages[idx];
    setDraft((d) => ({ ...d, extraImages: d.extraImages.filter((_, j) => j !== idx) }));
    setDirty(true);
    if (selected?.kind === "extra" && Number(selected.key) === idx) setSelected(null);
    if (img) apiFetch(`/organizations/${orgId}/invoice-template/images/${img.id}`, { method: "DELETE" }).catch(() => undefined);
  }

  function deleteTextBlock(id: string) {
    setDraft((d) => ({ ...d, customTexts: d.customTexts.filter((t) => t.id !== id) }));
    setDirty(true);
    if (selected?.kind === "text" && selected.key === id) setSelected(null);
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
          } catch { /* skip */ }
        }),
      );
      const opened = previewStatementLayoutPdf({
        practiceName: "Riverside Dental",
        generatedAt: new Date(),
        labName: "Sample Dental Lab",
        totals: { billed: 3200, paid: 1800, open: 1400, overdue: 600 },
        invoices: [
          { invoiceNumber: "INV-001", issuedAt: "2026-04-01", dueAt: "2026-05-01", status: "Open", total: "800", balanceDue: "800", patientName: "Jane Doe" },
          { invoiceNumber: "INV-002", issuedAt: "2026-03-15", dueAt: "2026-04-15", status: "Overdue", total: "600", balanceDue: "600", patientName: "John Smith" },
          { invoiceNumber: "INV-003", issuedAt: "2026-04-10", dueAt: "2026-05-10", status: "Paid", total: "1800", balanceDue: "0", patientName: "Alice Brown" },
        ],
        logoUrl: user?.practiceLogoUrl ?? null,
        template: draft,
        extraImageDataUrls,
      });
      if (!opened) setPreviewError("Preview was blocked. Please allow pop-ups for this site.");
    } catch (err) {
      setPreviewError((err as Error)?.message ?? "Preview failed.");
    } finally {
      setIsPreviewing(false);
    }
  }

  function addDefaultBlock() {
    const newDef: StatementDefaultTextBlock = { id: crypto.randomUUID(), text: "", fontSize: 10, align: "left", bold: false };
    setDraft((d) => {
      const withDef = { ...d, defaultTextBlocks: [...d.defaultTextBlocks, newDef] };
      return enableDefault(withDef, newDef);
    });
    setEditingDefaultId(newDef.id);
    setDirty(true);
  }

  function updateDefaultBlock(id: string, patch: Partial<StatementDefaultTextBlock>) {
    setDraft((d) => {
      const updated = d.defaultTextBlocks.map((b) => b.id === id ? { ...b, ...patch } : b);
      return syncDefaultToCanvas({ ...d, defaultTextBlocks: updated }, { id, ...patch });
    });
    setDirty(true);
  }

  function deleteDefaultBlock(id: string) {
    setDraft((d) => ({
      ...d,
      defaultTextBlocks: d.defaultTextBlocks.filter((b) => b.id !== id),
      customTexts: d.customTexts.filter((ct) => ct.sourceId !== id),
    }));
    setDirty(true);
    if (editingDefaultId === id) setEditingDefaultId(null);
  }

  function toggleDefault(def: StatementDefaultTextBlock) {
    const enabled = isDefaultEnabled(draft, def.id);
    setDraft((d) => (enabled ? disableDefault(d, def.id) : enableDefault(d, def)));
    setDirty(true);
  }

  function moveDefaultBlock(id: string, dir: "up" | "down") {
    setDraft((d) => {
      const blocks = d.defaultTextBlocks.slice();
      const idx = blocks.findIndex((b) => b.id === id);
      if (idx < 0) return d;
      const swapIdx = dir === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= blocks.length) return d;
      [blocks[idx], blocks[swapIdx]] = [blocks[swapIdx], blocks[idx]];
      const customTexts = d.customTexts.map((ct) => {
        if (!ct.sourceId) return ct;
        const newIdx = blocks.findIndex((b) => b.id === ct.sourceId);
        if (newIdx < 0) return ct;
        const pos = stmtDefaultTextBlockPosition(newIdx);
        return { ...ct, x: pos.x, y: pos.y, w: pos.w, h: pos.h };
      });
      return { ...d, defaultTextBlocks: blocks, customTexts };
    });
    setDirty(true);
  }

  if (!orgId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a lab organization to edit its statement layout.</div>;
  }
  if (query.isLoading) {
    return <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading template…</div>;
  }
  if (query.isError) {
    return <div className="p-6 text-sm text-destructive">Failed to load statement template. {(query.error as Error)?.message}</div>;
  }

  const editingDefault = draft.defaultTextBlocks.find((b) => b.id === editingDefaultId) ?? null;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Statement layout</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Drag and resize sections, images, and text blocks to design the statement PDF.
            Changes apply to every statement this lab generates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void handlePreview()} disabled={isPreviewing}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-50 flex items-center gap-1">
            {isPreviewing ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />} Preview PDF
          </button>
          <button type="button"
            onClick={() => { setDraft(coerceStatementTemplate(query.data?.template)); setDirty(false); setSelected(null); setEditingDefaultId(null); }}
            disabled={!dirty || saveMutation.isPending}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-50">
            Discard
          </button>
          <button type="button"
            onClick={() => {
              if (!confirm("Reset the layout to the built-in defaults? Your saved default text blocks will be preserved.")) return;
              setSelected(null); setEditingDefaultId(null);
              const preserved = draft.defaultTextBlocks;
              const freshTexts: StatementTemplateTextBlock[] = preserved.map((def, i) => ({
                id: crypto.randomUUID(), sourceId: def.id, ...stmtDefaultTextBlockPosition(i),
                text: def.text, fontSize: def.fontSize, align: def.align, bold: def.bold,
              }));
              saveMutation.mutate({ ...DEFAULT_STATEMENT_TEMPLATE, defaultTextBlocks: preserved, customTexts: freshTexts });
            }}
            disabled={saveMutation.isPending}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-50 flex items-center gap-1">
            <RotateCcw size={12} /> Reset to default
          </button>
          <button type="button" onClick={() => saveMutation.mutate(draft)} disabled={!dirty || saveMutation.isPending}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
            {saveMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save layout
          </button>
        </div>
      </div>

      {previewError ? <div className="mb-3 text-xs text-destructive">{previewError}</div> : null}
      {saveMutation.isError ? <div className="mb-3 text-xs text-destructive">Save failed: {(saveMutation.error as Error)?.message}</div> : null}

      <div className="grid grid-cols-[1fr_280px] gap-6">
        {/* Canvas */}
        <div
          ref={canvasRef}
          onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag}
          onClick={() => setSelected(null)}
          className="relative bg-white border border-border rounded shadow-sm select-none"
          style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}`, width: "100%", maxWidth: 612 }}
        >
          {draft.logo.mode === "watermark" && user?.practiceLogoUrl ? (
            <img src={user.practiceLogoUrl} alt="" style={{ position: "absolute", left: `${(draft.logo.x / PAGE_W) * 100}%`, top: `${(draft.logo.y / PAGE_H) * 100}%`, width: `${(draft.logo.w / PAGE_W) * 100}%`, height: `${(draft.logo.h / PAGE_H) * 100}%`, opacity: draft.logo.opacity, pointerEvents: "none", objectFit: "contain" }} />
          ) : null}

          {draft.extraImages.map((img, i) => (
            <DraggableBox key={img.id} box={img} color="rgba(99,102,241,0.18)" label={`Image ${i + 1}`}
              selected={selected?.kind === "extra" && selected?.key === String(i)}
              imageUrl={img.url} opacity={img.opacity}
              onStart={(e, h) => startDrag(e, "extra", String(i), h, img)}
              onDelete={() => deleteExtraImage(i)} />
          ))}

          {draft.customTexts.map((tb) => (
            <DraggableBox key={tb.id} box={tb}
              color={tb.sourceId ? "rgba(34,197,94,0.18)" : "rgba(251,146,60,0.18)"}
              label={tb.text || (tb.sourceId ? "Default text" : "Text")}
              selected={selected?.kind === "text" && selected?.key === tb.id}
              textBlock={tb}
              onStart={(e, h) => startDrag(e, "text", tb.id, h, tb)}
              onDelete={() => deleteTextBlock(tb.id)} />
          ))}

          {draft.logo.mode === "header" ? (
            <DraggableBox box={draft.logo} color="rgba(14,165,233,0.22)" label="Logo"
              selected={selected?.kind === "logo"}
              imageUrl={user?.practiceLogoUrl ?? undefined}
              onStart={(e, h) => startDrag(e, "logo", "logo", h, draft.logo)} />
          ) : null}

          {(Object.keys(draft.boxes) as SectionKey[]).map((k) => (
            <DraggableBox key={k} box={draft.boxes[k]} color={STATEMENT_SECTION_COLORS[k]}
              label={STATEMENT_SECTION_LABELS[k]}
              selected={selected?.kind === "section" && selected?.key === k}
              overlapping={overlappingSections.has(k)}
              onStart={(e, h) => startDrag(e, "section", k, h, draft.boxes[k])} />
          ))}
        </div>

        {/* Right rail */}
        <div className="space-y-5 text-sm">
          {selectedText ? (
            <section className="p-3 rounded border border-orange-200 bg-orange-50 dark:bg-orange-950/20 dark:border-orange-800 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400 mb-2">
                {selectedText.sourceId ? "Default text block (canvas)" : "Edit text block"}
              </h3>
              {selectedText.sourceId ? (
                <p className="text-xs text-muted-foreground">This block is linked to a default snippet. Edit its content in "Default text blocks" below.</p>
              ) : (
                <textarea className="w-full text-xs p-2 rounded border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  rows={3} placeholder="Enter text…" value={selectedText.text}
                  onChange={(e) => updateSelectedText({ text: e.target.value })} />
              )}
              {!selectedText.sourceId ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Size</span>
                    <select value={selectedText.fontSize} onChange={(e) => updateSelectedText({ fontSize: Number(e.target.value) })}
                      className="text-xs px-1.5 py-1 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary flex-1">
                      {FONT_SIZES.map((s) => <option key={s} value={s}>{s} pt</option>)}
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    {(["left", "center", "right"] as TextAlign[]).map((a) => (
                      <button key={a} type="button" onClick={() => updateSelectedText({ align: a })}
                        className={`p-1.5 rounded ${selectedText.align === a ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                        {a === "left" ? <AlignLeft size={12} /> : a === "center" ? <AlignCenter size={12} /> : <AlignRight size={12} />}
                      </button>
                    ))}
                    <div className="w-px h-4 bg-border mx-0.5" />
                    <button type="button" onClick={() => updateSelectedText({ bold: !selectedText.bold })}
                      className={`p-1.5 rounded ${selectedText.bold ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                      <Bold size={12} />
                    </button>
                    <div className="flex-1" />
                    <button type="button" onClick={() => deleteTextBlock(selectedText.id)}
                      className="p-1.5 rounded text-destructive hover:bg-destructive/10"><Trash2 size={12} /></button>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          {selectedExtra ? (
            <section className="p-3 rounded border border-indigo-200 bg-indigo-50 dark:bg-indigo-950/20 dark:border-indigo-800 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 mb-2">Image {selectedExtraIdx + 1}</h3>
              <label className="block">
                <span className="text-xs text-muted-foreground">Opacity {(selectedExtra.opacity * 100).toFixed(0)}%</span>
                <input type="range" min={0.05} max={1} step={0.05} value={selectedExtra.opacity}
                  onChange={(e) => { const v = Number(e.target.value); setDraft((d) => { const next = d.extraImages.slice(); next[selectedExtraIdx] = { ...next[selectedExtraIdx], opacity: v }; return { ...d, extraImages: next }; }); setDirty(true); }}
                  className="w-full mt-1" />
              </label>
              <button type="button" onClick={() => deleteExtraImage(selectedExtraIdx)}
                className="text-xs text-destructive hover:bg-destructive/10 px-2 py-1 rounded flex items-center gap-1"><Trash2 size={11} /> Remove image</button>
            </section>
          ) : null}

          {/* Default text blocks */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Default text blocks</h3>
              <button type="button" onClick={addDefaultBlock} disabled={draft.defaultTextBlocks.length >= 20}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-secondary flex items-center gap-1 disabled:opacity-50">
                <Plus size={11} /> Add
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Saved snippets automatically included on every statement.</p>
            {draft.defaultTextBlocks.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No default text blocks yet.</p>
            ) : (
              <ul className="space-y-2">
                {draft.defaultTextBlocks.map((def, defIdx) => {
                  const enabled = isDefaultEnabled(draft, def.id);
                  const isEditing = editingDefaultId === def.id;
                  const isFirst = defIdx === 0;
                  const isLast = defIdx === draft.defaultTextBlocks.length - 1;
                  return (
                    <li key={def.id} className="rounded border border-border bg-background overflow-hidden"
                      onMouseEnter={() => setHoveredDefaultId(def.id)}
                      onMouseLeave={() => setHoveredDefaultId(null)}>
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <button type="button" title={enabled ? "Disable" : "Enable"} onClick={() => toggleDefault(def)}
                          className={`p-1 rounded shrink-0 ${enabled ? "text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30" : "text-muted-foreground hover:bg-secondary"}`}>
                          {enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                        <span className="flex-1 text-xs truncate text-muted-foreground min-w-0">
                          {def.text || <span className="italic">Empty snippet</span>}
                        </span>
                        <button type="button" title="Move up" disabled={isFirst} onClick={() => moveDefaultBlock(def.id, "up")}
                          className="p-1 rounded shrink-0 text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-default"><ChevronUp size={13} /></button>
                        <button type="button" title="Move down" disabled={isLast} onClick={() => moveDefaultBlock(def.id, "down")}
                          className="p-1 rounded shrink-0 text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-default"><ChevronDown size={13} /></button>
                        <button type="button" title={pinnedPreviewId === def.id ? "Collapse preview" : "Preview"}
                          onClick={() => setPinnedPreviewId(pinnedPreviewId === def.id ? null : def.id)}
                          className={`p-1 rounded shrink-0 ${pinnedPreviewId === def.id ? "bg-primary/10 text-primary" : "hover:bg-secondary text-muted-foreground"}`}>
                          <ChevronRight size={13} style={{ transform: pinnedPreviewId === def.id ? "rotate(90deg)" : undefined, transition: "transform 150ms" }} />
                        </button>
                        <button type="button" title={isEditing ? "Collapse" : "Edit"}
                          onClick={() => { const opening = editingDefaultId !== def.id; setEditingDefaultId(opening ? def.id : null); if (opening) setPinnedPreviewId(null); }}
                          className={`p-1 rounded shrink-0 ${isEditing ? "bg-primary/10 text-primary" : "hover:bg-secondary text-muted-foreground"}`}>
                          {isEditing ? <ChevronDown size={13} /> : <Pencil size={13} />}
                        </button>
                        <button type="button" title="Delete" onClick={() => { if (!confirm("Delete this default text block?")) return; deleteDefaultBlock(def.id); }}
                          className="p-1 rounded shrink-0 text-destructive hover:bg-destructive/10"><Trash2 size={13} /></button>
                      </div>
                      {!isEditing && (hoveredDefaultId === def.id || pinnedPreviewId === def.id) ? (
                        <div className="border-t border-border px-3 py-2 bg-muted/30">
                          {def.text.trim() ? (
                            <div style={{ fontSize: def.fontSize, fontWeight: def.bold ? "bold" : "normal", textAlign: def.align as TextAlign, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--foreground)", userSelect: "none" }}>
                              {def.text}
                            </div>
                          ) : <p className="text-xs text-muted-foreground italic">No text yet.</p>}
                          <p className="mt-1.5 text-[10px] text-muted-foreground/60 leading-none">{def.fontSize} pt · {def.align}{def.bold ? " · bold" : ""}</p>
                        </div>
                      ) : null}
                      {isEditing && editingDefault ? (
                        <div className="px-2 pb-2 space-y-2 border-t border-border pt-2">
                          <textarea className="w-full text-xs p-2 rounded border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                            rows={4} placeholder="Enter text…" value={editingDefault.text}
                            onChange={(e) => updateDefaultBlock(editingDefault.id, { text: e.target.value })} />
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground shrink-0">Size</span>
                            <select value={editingDefault.fontSize} onChange={(e) => updateDefaultBlock(editingDefault.id, { fontSize: Number(e.target.value) })}
                              className="text-xs px-1.5 py-1 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary flex-1">
                              {FONT_SIZES.map((s) => <option key={s} value={s}>{s} pt</option>)}
                            </select>
                          </div>
                          <div className="flex items-center gap-1">
                            {(["left", "center", "right"] as TextAlign[]).map((a) => (
                              <button key={a} type="button" onClick={() => updateDefaultBlock(editingDefault.id, { align: a })}
                                className={`p-1.5 rounded ${editingDefault.align === a ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                                {a === "left" ? <AlignLeft size={12} /> : a === "center" ? <AlignCenter size={12} /> : <AlignRight size={12} />}
                              </button>
                            ))}
                            <div className="w-px h-4 bg-border mx-0.5" />
                            <button type="button" onClick={() => updateDefaultBlock(editingDefault.id, { bold: !editingDefault.bold })}
                              className={`p-1.5 rounded ${editingDefault.bold ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                              <Bold size={12} />
                            </button>
                            <div className="flex-1" />
                            <button type="button" onClick={() => setEditingDefaultId(null)}
                              className="text-xs px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1">
                              <Check size={11} /> Done
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Logo mode */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Lab logo</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                <input type="radio" name="stmtLogoMode" checked={draft.logo.mode === "header"}
                  onChange={() => { setDraft((d) => ({ ...d, logo: { ...d.logo, mode: "header" } })); setDirty(true); }} />
                Header (top-right)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="stmtLogoMode" checked={draft.logo.mode === "watermark"}
                  onChange={() => { setDraft((d) => ({ ...d, logo: { ...d.logo, mode: "watermark" } })); setDirty(true); }} />
                Watermark (full page)
              </label>
              {draft.logo.mode === "watermark" ? (
                <label className="block">
                  <span className="text-xs text-muted-foreground">Opacity {(draft.logo.opacity * 100).toFixed(0)}%</span>
                  <input type="range" min={0.05} max={1} step={0.05} value={draft.logo.opacity}
                    onChange={(e) => { const v = Number(e.target.value); setDraft((d) => ({ ...d, logo: { ...d.logo, opacity: v } })); setDirty(true); }}
                    className="w-full" />
                </label>
              ) : null}
            </div>
          </section>

          {/* Custom text */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Custom text</h3>
            <button type="button" onClick={() => { const tb = newTextBlock(); setDraft((d) => ({ ...d, customTexts: [...d.customTexts, tb] })); setDirty(true); setSelected({ kind: "text", key: tb.id }); }}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary flex items-center gap-1">
              <Plus size={12} /> Add text block
            </button>
            {draft.customTexts.filter((ct) => !ct.sourceId).length > 0 ? (
              <ul className="mt-3 space-y-1">
                {draft.customTexts.filter((ct) => !ct.sourceId).map((tb, i) => (
                  <li key={tb.id}
                    className={`flex items-center gap-2 text-xs p-2 rounded border cursor-pointer ${selected?.kind === "text" && selected.key === tb.id ? "border-primary bg-primary/5" : "border-border hover:bg-secondary"}`}
                    onClick={() => setSelected({ kind: "text", key: tb.id })}>
                    <span className="truncate flex-1 text-muted-foreground">{tb.text || `Text ${i + 1}`}</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); deleteTextBlock(tb.id); }}
                      className="text-destructive hover:bg-destructive/10 p-0.5 rounded"><X size={11} /></button>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-xs text-muted-foreground">No custom text blocks.</p>}
          </section>

          {/* Extra images */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Extra images</h3>
            <label className="block">
              <span className="sr-only">Upload image</span>
              <input type="file" accept="image/*" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) uploadMutation.mutate(f); e.currentTarget.value = ""; }} className="hidden" id="stmt-extra-upload" />
              <button type="button" onClick={() => document.getElementById("stmt-extra-upload")?.click()}
                disabled={uploadMutation.isPending}
                className="text-xs px-3 py-1.5 rounded border border-border hover:bg-secondary flex items-center gap-1 disabled:opacity-50">
                {uploadMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Upload image (≤ 5 MB)
              </button>
            </label>
            {uploadMutation.isError ? <div className="mt-2 text-xs text-destructive">Upload failed: {(uploadMutation.error as Error)?.message}</div> : null}
            <ul className="mt-3 space-y-2">
              {draft.extraImages.map((img, i) => (
                <li key={img.id}
                  className={`flex items-center gap-2 text-xs p-2 rounded border cursor-pointer ${selected?.kind === "extra" && selected.key === String(i) ? "border-primary bg-primary/5" : "border-border hover:bg-secondary"}`}
                  onClick={() => setSelected({ kind: "extra", key: String(i) })}>
                  <span className="truncate flex-1">Image {i + 1}</span>
                  <span className="text-muted-foreground shrink-0">{(img.opacity * 100).toFixed(0)}%</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); deleteExtraImage(i); }} className="text-destructive hover:bg-destructive/10 p-1 rounded"><Trash2 size={12} /></button>
                </li>
              ))}
              {draft.extraImages.length === 0 ? <li className="text-xs text-muted-foreground">No extra images.</li> : null}
            </ul>
          </section>

          {/* Sections legend */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Sections</h3>
            <ul className="space-y-1 text-xs">
              {(Object.keys(STATEMENT_SECTION_LABELS) as SectionKey[]).map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-sm border border-border" style={{ background: STATEMENT_SECTION_COLORS[k] }} />
                  {STATEMENT_SECTION_LABELS[k]}
                </li>
              ))}
              <li className="flex items-center gap-2"><span className="inline-block w-3 h-3 rounded-sm border border-border" style={{ background: "rgba(34,197,94,0.18)" }} />Default text block</li>
              <li className="flex items-center gap-2"><span className="inline-block w-3 h-3 rounded-sm border border-border" style={{ background: "rgba(251,146,60,0.18)" }} />Custom text block</li>
            </ul>
            {overlappingPairs.length > 0 ? (
              <div className="flex items-start gap-1.5 rounded px-2 py-1.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs mt-3">
                <span className="shrink-0 mt-px">⚠</span>
                <div>
                  <p className="font-medium mb-0.5">Overlapping sections</p>
                  <ul className="space-y-0.5">{overlappingPairs.map(([a, b]) => <li key={`${a}-${b}`}>{STATEMENT_SECTION_LABELS[a]} overlaps {STATEMENT_SECTION_LABELS[b]}</li>)}</ul>
                </div>
              </div>
            ) : null}
            {outOfBoundsSections.length > 0 ? (
              <div className="flex items-start gap-1.5 rounded px-2 py-1.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs mt-3">
                <span className="shrink-0 mt-px">⚠</span>
                <div>
                  <p className="font-medium mb-0.5">Sections outside the page</p>
                  <ul className="space-y-0.5">{outOfBoundsSections.map(({ key, edges }) => <li key={key}>{STATEMENT_SECTION_LABELS[key]} extends past the {edges.join(" and ")} of the page</li>)}</ul>
                </div>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground mt-2">{query.data?.isCustom ? "This lab is using a custom layout." : "This lab is using the built-in default layout."}</p>
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
  overlapping?: boolean;
  imageUrl?: string;
  opacity?: number;
  textBlock?: StatementTemplateTextBlock;
  onStart: (e: React.PointerEvent, handle: Handle) => void;
  onDelete?: () => void;
}

function DraggableBox({ box, color, label, selected, overlapping, imageUrl, opacity, textBlock, onStart, onDelete }: DraggableBoxProps) {
  const [hovered, setHovered] = useState(false);
  const border = overlapping ? "2px dashed #ef4444" : selected ? "1.5px solid #2563eb" : "1px dashed rgba(0,0,0,0.35)";
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${(box.x / PAGE_W) * 100}%`, top: `${(box.y / PAGE_H) * 100}%`,
    width: `${(box.w / PAGE_W) * 100}%`, height: `${(box.h / PAGE_H) * 100}%`,
    background: color, border, outline: overlapping && selected ? "1.5px solid #2563eb" : undefined,
    outlineOffset: overlapping && selected ? "2px" : undefined, cursor: "move", boxSizing: "border-box",
  };
  const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const showDelete = onDelete && (selected || hovered);
  const resizeCursors: Record<string, string> = { n: "n-resize", s: "s-resize", e: "e-resize", w: "w-resize", ne: "ne-resize", nw: "nw-resize", se: "se-resize", sw: "sw-resize" };
  const handlePositions: Record<string, { top?: string; bottom?: string; left?: string; right?: string; transform?: string }> = {
    n: { top: "-4px", left: "50%", transform: "translateX(-50%)" }, s: { bottom: "-4px", left: "50%", transform: "translateX(-50%)" },
    e: { right: "-4px", top: "50%", transform: "translateY(-50%)" }, w: { left: "-4px", top: "50%", transform: "translateY(-50%)" },
    ne: { top: "-4px", right: "-4px" }, nw: { top: "-4px", left: "-4px" }, se: { bottom: "-4px", right: "-4px" }, sw: { bottom: "-4px", left: "-4px" },
  };
  return (
    <div style={style} onPointerDown={(e) => onStart(e, "move")} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      {imageUrl ? <img src={imageUrl} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none", opacity: opacity !== undefined ? opacity : 0.7 }} /> : null}
      {textBlock ? (
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", padding: "2px", display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
          {textBlock.text?.trim() ? (
            <span style={{ fontSize: `${textBlock.fontSize * 0.35}px`, fontWeight: textBlock.bold ? "bold" : "normal", textAlign: textBlock.align, color: "#0f172a", lineHeight: 1.3, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {textBlock.text}
            </span>
          ) : (
            <span style={{ fontSize: "7px", color: "rgba(0,0,0,0.35)", fontStyle: "italic" }}>Text block</span>
          )}
        </div>
      ) : null}
      {!imageUrl && !textBlock ? (
        <span style={{ position: "absolute", top: 2, left: 4, fontSize: "clamp(6px, 1.1%, 9px)", color: "rgba(0,0,0,0.55)", fontFamily: "sans-serif", pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", maxWidth: "calc(100% - 8px)" }}>
          {label}
        </span>
      ) : null}
      {(selected || hovered) ? handles.map((h) => (
        <div key={h} onPointerDown={(e) => onStart(e, h as Handle)}
          style={{ position: "absolute", width: 8, height: 8, background: "#2563eb", border: "1px solid #fff", borderRadius: 2, cursor: resizeCursors[h], ...handlePositions[h], zIndex: 10 }} />
      )) : null}
      {showDelete ? (
        <button type="button" onPointerDown={(e) => { e.stopPropagation(); onDelete?.(); }}
          style={{ position: "absolute", top: -6, right: -6, width: 14, height: 14, background: "#ef4444", color: "#fff", border: "none", borderRadius: "50%", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, fontSize: 9, lineHeight: 1 }}>
          ×
        </button>
      ) : null}
    </div>
  );
}
