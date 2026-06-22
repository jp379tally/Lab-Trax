import { useRef, useState, useEffect } from "react";
import { Settings2, GripVertical, Eye, EyeOff, ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";

export interface ColumnOption {
  id: string;
  label: string;
  menuLabel?: string;
  visible: boolean;
  index: number;
}

export interface ColumnSettingsPopoverProps {
  columns: ColumnOption[];
  onToggle: (id: string) => void;
  onMove: (id: string, direction: "left" | "right") => void;
  onReset: () => void;
}

export function ColumnSettingsPopover({
  columns,
  onToggle,
  onMove,
  onReset,
}: ColumnSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const visibleCount = columns.filter((c) => c.visible).length;

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Customize columns"
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-secondary text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors border border-border"
      >
        <Settings2 size={12} />
        <span className="hidden sm:inline">Columns</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-card border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Customize columns</span>
            <button
              type="button"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
              title="Reset all columns"
            >
              <RotateCcw size={10} />
              Reset
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {columns.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No columns available.
              </div>
            )}
            {columns.map((col) => {
              const isFirst = col.visible && col.index === 0;
              const isLast = col.visible && col.index === visibleCount - 1;
              return (
                <div
                  key={col.id}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/40 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => onToggle(col.id)}
                    disabled={col.visible && visibleCount <= 1}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={col.visible ? (visibleCount <= 1 ? "Cannot hide the last visible column" : "Hide column") : "Show column"}
                  >
                    {col.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <span
                    className={`flex-1 text-xs truncate ${col.visible ? "text-foreground" : "text-muted-foreground"}`}
                    title={col.menuLabel ?? col.label}
                  >
                    {col.menuLabel ?? col.label}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={!col.visible || isFirst}
                      onClick={() => onMove(col.id, "left")}
                      className="p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move left"
                    >
                      <ArrowLeft size={11} />
                    </button>
                    <button
                      type="button"
                      disabled={!col.visible || isLast}
                      onClick={() => onMove(col.id, "right")}
                      className="p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move right"
                    >
                      <ArrowRight size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground">
            {visibleCount} of {columns.length} visible
          </div>
        </div>
      )}
    </div>
  );
}
