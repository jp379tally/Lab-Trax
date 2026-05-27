import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Eye,
  EyeOff,
  GripVertical,
  RotateCcw,
  X,
} from "lucide-react";
import {
  DEFAULT_PRINT_LAYOUT_CONFIG,
  type FontSize,
  type PrintLayoutConfig,
  type PrintLayoutField,
  savePrintLayoutConfig,
} from "@/lib/print-layout";

interface SortableFieldTileProps {
  field: PrintLayoutField;
  onToggleVisible: (id: string) => void;
  onSetFontSize: (id: string, size: FontSize) => void;
  onToggleFullWidth: (id: string) => void;
}

function SortableFieldTile({
  field,
  onToggleVisible,
  onSetFontSize,
  onToggleFullWidth,
}: SortableFieldTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
        field.visible
          ? "bg-card border-border"
          : "bg-secondary/40 border-border/50 opacity-60"
      }`}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>

      <span className="flex-1 text-xs font-medium truncate">{field.label}</span>

      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground mr-1">Size</span>
        {(["sm", "md", "lg"] as FontSize[]).map((sz) => (
          <button
            key={sz}
            type="button"
            onClick={() => onSetFontSize(field.id, sz)}
            disabled={!field.visible}
            className={`w-7 h-6 rounded text-[10px] font-semibold transition-colors ${
              field.fontSize === sz && field.visible
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-secondary/80 disabled:opacity-40"
            }`}
            aria-label={`Set ${field.label} size to ${sz === "sm" ? "small" : sz === "md" ? "medium" : "large"}`}
          >
            {sz === "sm" ? "S" : sz === "md" ? "M" : "L"}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onToggleFullWidth(field.id)}
        disabled={!field.visible}
        title={field.fullWidth ? "Full width (click to use 2-column)" : "Half width (click for full width)"}
        className={`text-[10px] px-1.5 h-6 rounded font-medium transition-colors disabled:opacity-40 ${
          field.fullWidth
            ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30"
            : "bg-secondary text-muted-foreground hover:bg-secondary/80"
        }`}
      >
        {field.fullWidth ? "Full" : "½"}
      </button>

      <button
        type="button"
        onClick={() => onToggleVisible(field.id)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        aria-label={field.visible ? "Hide field" : "Show field"}
        title={field.visible ? "Hide from printout" : "Show on printout"}
      >
        {field.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </div>
  );
}

interface PrintLayoutEditorProps {
  onClose: () => void;
  config: PrintLayoutConfig;
  onChange: (config: PrintLayoutConfig) => void;
}

export function PrintLayoutEditor({ onClose, config, onChange }: PrintLayoutEditorProps) {
  const [local, setLocal] = useState<PrintLayoutConfig>(config);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfigRef = useRef<PrintLayoutConfig | null>(null);

  const persist = useCallback((next: PrintLayoutConfig) => {
    pendingConfigRef.current = next;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      savePrintLayoutConfig(next);
      onChange(next);
      pendingConfigRef.current = null;
    }, 300);
  }, [onChange]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        // Flush any pending save so a quick edit+close doesn't lose data.
        if (pendingConfigRef.current) {
          savePrintLayoutConfig(pendingConfigRef.current);
          onChange(pendingConfigRef.current);
        }
      }
    };
  }, [onChange]);

  function update(next: PrintLayoutConfig) {
    setLocal(next);
    persist(next);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent, section: "details" | "rx") {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const sectionFields = local.fields.filter((f) => f.section === section);
    const otherFields = local.fields.filter((f) => f.section !== section);
    const oldIdx = sectionFields.findIndex((f) => f.id === active.id);
    const newIdx = sectionFields.findIndex((f) => f.id === over.id);
    const reordered = arrayMove(sectionFields, oldIdx, newIdx);
    const next: PrintLayoutConfig = {
      ...local,
      fields: section === "details"
        ? [...reordered, ...otherFields]
        : [...otherFields, ...reordered],
    };
    update(next);
  }

  function toggleVisible(id: string) {
    update({ ...local, fields: local.fields.map((f) => f.id === id ? { ...f, visible: !f.visible } : f) });
  }

  function setFontSize(id: string, size: FontSize) {
    update({ ...local, fields: local.fields.map((f) => f.id === id ? { ...f, fontSize: size } : f) });
  }

  function toggleFullWidth(id: string) {
    update({ ...local, fields: local.fields.map((f) => f.id === id ? { ...f, fullWidth: !f.fullWidth } : f) });
  }

  function resetToDefaults() {
    update(DEFAULT_PRINT_LAYOUT_CONFIG);
  }

  const detailFields = local.fields.filter((f) => f.section === "details");
  const rxFields = local.fields.filter((f) => f.section === "rx");

  const previewFields = local.fields.filter((f) => f.visible);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Print Layout Editor"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold">Customize Print Layout</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Case Details section */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Case Details
            </p>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(e, "details")}
            >
              <SortableContext items={detailFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {detailFields.map((field) => (
                    <SortableFieldTile
                      key={field.id}
                      field={field}
                      onToggleVisible={toggleVisible}
                      onSetFontSize={setFontSize}
                      onToggleFullWidth={toggleFullWidth}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          {/* Rx Summary section */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Rx Summary
            </p>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(e, "rx")}
            >
              <SortableContext items={rxFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {rxFields.map((field) => (
                    <SortableFieldTile
                      key={field.id}
                      field={field}
                      onToggleVisible={toggleVisible}
                      onSetFontSize={setFontSize}
                      onToggleFullWidth={toggleFullWidth}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          {/* Section toggles */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Sections
            </p>
            <div className="space-y-1.5">
              {(
                [
                  { key: "showNotes", label: "Notes" },
                  { key: "showToothChart", label: "Tooth Chart" },
                ] as const
              ).map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-card cursor-pointer hover:bg-secondary/40 transition-colors"
                >
                  <input
                    type="checkbox"
                    className="accent-primary w-3.5 h-3.5"
                    checked={local[key]}
                    onChange={() => update({ ...local, [key]: !local[key] })}
                  />
                  <span className="text-xs font-medium flex-1">{label}</span>
                  {local[key] ? (
                    <Eye size={13} className="text-muted-foreground" />
                  ) : (
                    <EyeOff size={13} className="text-muted-foreground" />
                  )}
                </label>
              ))}
            </div>
          </div>

          {/* Live preview */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Preview
            </p>
            <div className="border border-border rounded-lg bg-secondary/20 px-4 py-3 font-mono text-[11px] space-y-0.5 max-h-40 overflow-y-auto">
              {previewFields.length === 0 && (
                <span className="text-muted-foreground italic">No fields visible</span>
              )}
              {previewFields.map((f) => {
                const sizeLabel = f.fontSize === "lg" ? " ●●●" : f.fontSize === "md" ? " ●●" : "";
                const widthLabel = f.fullWidth ? " [full]" : "";
                return (
                  <div key={f.id} className="text-foreground/70 leading-snug">
                    <span className="text-muted-foreground">{f.label}:</span>{" "}
                    <span className="text-foreground">___</span>
                    <span className="text-primary/60 text-[9px]">{sizeLabel}{widthLabel}</span>
                  </div>
                );
              })}
              {local.showNotes && (
                <div className="text-muted-foreground mt-1">— Notes —</div>
              )}
              {local.showToothChart && (
                <div className="text-muted-foreground">— Tooth Chart —</div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border bg-secondary/20 shrink-0">
          <button
            type="button"
            onClick={resetToDefaults}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
          >
            <RotateCcw size={12} />
            Reset to defaults
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
