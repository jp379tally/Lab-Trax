import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  coerceInvoiceTemplate,
  DEFAULT_INVOICE_TEMPLATE,
  type InvoiceTemplate,
  type InvoiceTemplateBox as TemplateBox,
} from "@/lib/invoice-template";

type SectionKey = keyof InvoiceTemplate["boxes"];

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
  kind: "section" | "logo" | "extra";
  key: string; // section name or extra index as string
  handle: Handle;
  startX: number;
  startY: number;
  startBox: TemplateBox;
}

const PAGE_W = 612;
const PAGE_H = 792;
const CANVAS_W = 612; // 1pt = 1px at this scale; clamp via CSS

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
      // apiFetch may unwrap or not; handle both.
      return (res as any).data ?? (res as any);
    },
  });

  const [draft, setDraft] = useState<InvoiceTemplate>(DEFAULT_INVOICE_TEMPLATE);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<{ kind: "section" | "logo" | "extra"; key: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Sync draft when server template loads.
  useEffect(() => {
    if (!query.data) return;
    setDraft(coerceInvoiceTemplate(query.data.template));
    setDirty(false);
  }, [query.data]);

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
      const idx = Number(d.key);
      const extras = cur.extraImages.slice();
      extras[idx] = { ...extras[idx], ...next };
      return { ...cur, extraImages: extras };
    });
    setDirty(true);
  }

  function endDrag() {
    dragRef.current = null;
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
            Drag and resize the labelled sections to design the invoice PDF.
            Changes apply to every invoice this lab generates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(coerceInvoiceTemplate(query.data?.template));
              setDirty(false);
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
              onStart={(e, h) => startDrag(e, "extra", String(i), h, img)}
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
                  className="flex items-center gap-2 text-xs p-2 rounded border border-border"
                >
                  <span className="truncate flex-1">Image {i + 1}</span>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={img.opacity}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setDraft((d) => {
                        const next = d.extraImages.slice();
                        next[i] = { ...next[i], opacity: v };
                        return { ...d, extraImages: next };
                      });
                      setDirty(true);
                    }}
                    className="w-20"
                    title={`Opacity ${(img.opacity * 100).toFixed(0)}%`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((d) => ({
                        ...d,
                        extraImages: d.extraImages.filter((_, j) => j !== i),
                      }));
                      setDirty(true);
                      // best-effort server-side delete; ignore failure
                      apiFetch(
                        `/organizations/${orgId}/invoice-template/images/${img.id}`,
                        { method: "DELETE" },
                      ).catch(() => undefined);
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
  onStart: (e: React.PointerEvent, handle: Handle) => void;
}

function DraggableBox({
  box,
  color,
  label,
  selected,
  imageUrl,
  onStart,
}: DraggableBoxProps) {
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
  return (
    <div style={style} onPointerDown={(e) => onStart(e, "move")}>
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
            opacity: 0.7,
          }}
        />
      ) : null}
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
