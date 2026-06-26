import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";

export interface PracticeOption {
  id: string;
  label: string;
}

interface PracticePickerProps {
  /** Selected provider-org id; "" means nothing selected. */
  value: string;
  onChange: (id: string) => void;
  options: PracticeOption[];
  placeholder?: string;
  /** Render the trigger with the required-field error ring. */
  error?: boolean;
  /** Invoked when the user picks the "add new practice" action row. */
  onAddNew: () => void;
  /** Label for the add-new row, e.g. `Add new practice ("Smith Dental")`. */
  addNewLabel: string;
  /** "sm" renders an h-8 trigger to match compact input rows; default is h-9. */
  size?: "sm" | "default";
}

/**
 * PracticePicker — searchable, type-to-filter picker for selecting a provider
 * practice (organization) by id. Mirrors the look and keyboard behavior of the
 * adjacent DoctorNamePicker, but resolves the selection back to an org id and
 * exposes an explicit "add new practice" action that opens the create form.
 */
export function PracticePicker({
  value,
  onChange,
  options,
  placeholder = "Select a practice…",
  error = false,
  onAddNew,
  addNewLabel,
  size = "default",
}: PracticePickerProps) {
  const triggerH = size === "sm" ? "h-8" : "h-9";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selected = useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const sorted = options
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label));
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid="practice-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        className={`w-full ${triggerH} px-2.5 rounded-md bg-secondary text-sm border text-left flex items-center justify-between gap-2 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary ${
          error
            ? "border-destructive ring-1 ring-destructive"
            : "border-transparent"
        }`}
      >
        <span className={selected ? "truncate" : "text-muted-foreground truncate"}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={14} className="text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border">
            <input
              autoFocus
              type="search"
              placeholder="Search practices…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                No practices found.
              </li>
            )}
            {filtered.map((o) => {
              const isSel = o.id === value;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(o.id);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/60 flex items-center gap-2 ${
                      isSel ? "bg-primary/10" : ""
                    }`}
                  >
                    {isSel && (
                      <Check size={13} className="text-primary shrink-0" />
                    )}
                    <span className="truncate">{o.label}</span>
                  </button>
                </li>
              );
            })}
            <li className="border-t border-border mt-1 pt-1">
              <button
                type="button"
                data-testid="practice-picker-add-new"
                onClick={() => {
                  onAddNew();
                  setOpen(false);
                  setSearch("");
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/60 flex items-center gap-2 text-primary"
              >
                <Plus size={13} className="shrink-0" />
                <span className="truncate">{addNewLabel}</span>
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
