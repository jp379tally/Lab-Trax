import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export interface MultiSelectFilterOption {
  value: string;
  label: string;
}

export interface MultiSelectFilterProps {
  /** Short noun shown on the closed trigger, e.g. "Status". */
  label: string;
  options: MultiSelectFilterOption[];
  /** Currently checked values. An empty array means "all" (no filtering). */
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * Toolbar-sized multi-select filter: a compact trigger that summarizes the
 * current selection plus a checkbox dropdown so several values can be picked
 * at once (the caller treats the empty array as "all").
 *
 * Implemented as a plain button + panel rather than the Radix dropdown menu:
 * the panel must stay open while options are toggled, and the desktop test
 * suite drives everything through `fireEvent` (no user-event / PointerEvent
 * support in jsdom), which Radix's pointer-driven triggers don't respond to.
 * Roles, `aria-checked` and arrow-key/Escape handling are wired up here so the
 * control is still operable by keyboard and screen readers.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  className,
  "data-testid": testId,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const close = useCallback((refocusTrigger = true) => {
    setOpen(false);
    if (refocusTrigger) triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(
    (value: string) => {
      onChange(
        selected.includes(value)
          ? selected.filter((v) => v !== value)
          : [...selected, value],
      );
    },
    [onChange, selected],
  );

  const focusItem = (index: number) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    if (items.length === 0) return;
    const wrapped = (index + items.length) % items.length;
    items[wrapped]?.focus();
  };

  // "Status: All" / "Status: In Design" / "Status: 3 selected" — keeps the
  // closed control readable no matter how many values are checked.
  const summary =
    selected.length === 0
      ? "All"
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className={`relative inline-block ${className ?? ""}`} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusItem(0));
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Filter by ${label.toLowerCase()}`}
        data-testid={testId}
        className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent hover:bg-secondary/80 focus:bg-card focus:border-border focus:outline-none transition-colors"
      >
        <span className="whitespace-nowrap">
          {label}: {summary}
        </span>
        <ChevronDown size={13} className="text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`${label} filter options`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          className="absolute left-0 mt-2 w-56 bg-card border border-border rounded-lg shadow-xl z-50 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Clear ${label.toLowerCase()} filter`}
            >
              <X size={10} />
              Clear
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {options.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No options available.
              </div>
            )}
            {options.map((opt, index) => {
              const checked = selected.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  onClick={() => toggle(opt.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      focusItem(index + 1);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      focusItem(index - 1);
                    } else if (e.key === "Home") {
                      e.preventDefault();
                      focusItem(0);
                    } else if (e.key === "End") {
                      e.preventDefault();
                      focusItem(options.length - 1);
                    }
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary/40 focus:bg-secondary/60 focus:outline-none transition-colors"
                >
                  <span
                    aria-hidden="true"
                    data-state={checked ? "checked" : "unchecked"}
                    className="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary shadow data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                  >
                    {checked && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="flex-1 truncate text-foreground">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
