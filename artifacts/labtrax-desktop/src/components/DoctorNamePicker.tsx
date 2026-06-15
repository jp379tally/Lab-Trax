import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";

interface DoctorNamePickerProps {
  value: string;
  onChange: (name: string) => void;
  doctorNames?: string[];
  placeholder?: string;
}

export function DoctorNamePicker({
  value,
  onChange,
  doctorNames,
  placeholder = "Select doctor…",
}: DoctorNamePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isCustom, setIsCustom] = useState(false);
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

  const names = doctorNames ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return names;
    return names.filter((n) => n.toLowerCase().includes(q));
  }, [names, search]);

  const searchExactMatch =
    search.trim() &&
    names.some((n) => n.toLowerCase() === search.trim().toLowerCase());

  return (
    <div ref={containerRef} className="relative">
      {isCustom ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter doctor name…"
            className="flex-1 h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
          <button
            type="button"
            onClick={() => {
              setIsCustom(false);
              setOpen(false);
            }}
            className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
            title="Back to list"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-left flex items-center justify-between gap-2"
          >
            <span className={value ? "" : "text-muted-foreground"}>
              {value || placeholder}
            </span>
            <ChevronDown size={14} className="text-muted-foreground shrink-0" />
          </button>

          {open && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
              <div className="p-2 border-b border-border">
                <input
                  autoFocus
                  type="search"
                  placeholder="Search doctors…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
              <ul className="max-h-56 overflow-y-auto py-1">
                {filtered.length === 0 && !search.trim() && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">
                    No doctors found.
                  </li>
                )}
                {filtered.map((n) => {
                  const isSel = n === value;
                  return (
                    <li key={n}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(n);
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
                        <span className="truncate">{n}</span>
                      </button>
                    </li>
                  );
                })}
                {!searchExactMatch && (
                  <li className="border-t border-border mt-1 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustom(true);
                        if (search.trim()) onChange(search.trim());
                        setOpen(false);
                        setSearch("");
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/60 flex items-center gap-2 text-primary"
                    >
                      <Plus size={13} className="shrink-0" />
                      <span>
                        {search.trim()
                          ? `Add "${search.trim()}"`
                          : "Add new doctor…"}
                      </span>
                    </button>
                  </li>
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
