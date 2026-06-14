import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Plus } from "lucide-react";

export interface ItemComboboxOption {
  key: string;
  name: string;
  unitPrice: number | null;
  group: "catalog" | "custom";
}

interface Props {
  value: string;
  options: ItemComboboxOption[];
  /** Called when an existing option is chosen (auto-fills name/description/price). */
  onPick: (opt: { name: string; unitPrice: number | null }) => void;
  /** Called on every keystroke so a free-typed (custom) name is preserved. */
  onText: (text: string) => void;
  /**
   * Creates a new billable item from the typed name. Resolve with the created
   * item to select it, or null to keep the typed text as a custom entry.
   */
  onCreate?: (
    name: string,
  ) => Promise<{ name: string; unitPrice: number | null } | null>;
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}

const GROUP_LABEL: Record<ItemComboboxOption["group"], string> = {
  catalog: "Catalog",
  custom: "Billable items",
};

export function ItemCombobox({
  value,
  options,
  onPick,
  onText,
  onCreate,
  placeholder = "Item",
  size = "md",
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const [creating, setCreating] = useState(false);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputVal(value);
  }, [value]);

  const trimmed = inputVal.trim();
  const lower = trimmed.toLowerCase();
  const filtered = trimmed
    ? options.filter((o) => o.name.toLowerCase().includes(lower))
    : options;
  const hasExactMatch = options.some((o) => o.name.toLowerCase() === lower);
  const showAddOption = !!onCreate && trimmed.length > 0 && !hasExactMatch;
  const dropdownVisible =
    open && !disabled && (filtered.length > 0 || showAddOption);

  const updateCoords = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ left: r.left, top: r.bottom + 2, width: r.width });
  }, []);

  useLayoutEffect(() => {
    if (!dropdownVisible) return;
    updateCoords();
    const handler = () => updateCoords();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [dropdownVisible, updateCoords]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(o: { name: string; unitPrice: number | null }) {
    setInputVal(o.name);
    onPick(o);
    setOpen(false);
  }

  const create = useCallback(async () => {
    if (!onCreate || !trimmed || creating) return;
    setCreating(true);
    try {
      const created = await onCreate(trimmed);
      if (created) {
        setInputVal(created.name);
        onPick(created);
        setOpen(false);
      }
    } finally {
      setCreating(false);
    }
  }, [onCreate, trimmed, creating, onPick]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter") {
      if (filtered.length === 1) {
        e.preventDefault();
        pick({ name: filtered[0].name, unitPrice: filtered[0].unitPrice });
      } else if (showAddOption) {
        e.preventDefault();
        void create();
      }
    }
  }

  const inputCls =
    size === "sm"
      ? "w-full h-7 pl-2 pr-7 rounded bg-background border border-input text-xs"
      : "w-full h-8 pl-2 pr-7 rounded bg-background border border-input text-sm";

  function optionRow(o: ItemComboboxOption) {
    return (
      <button
        key={o.key}
        type="button"
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault();
          pick({ name: o.name, unitPrice: o.unitPrice });
        }}
        className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2"
      >
        <span className="flex-1 min-w-0 truncate">{o.name}</span>
        {o.unitPrice != null && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            ${o.unitPrice.toFixed(2)}
          </span>
        )}
      </button>
    );
  }

  function renderOptions() {
    if (filtered.length === 0) return null;
    if (trimmed) return filtered.map(optionRow);
    // No search text: group catalog items and custom billable items.
    const groups: ItemComboboxOption["group"][] = ["catalog", "custom"];
    return groups
      .map((g) => ({ g, items: filtered.filter((o) => o.group === g) }))
      .filter((x) => x.items.length > 0)
      .map(({ g, items }) => (
        <div key={g}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold bg-secondary/40 border-t border-border first:border-t-0">
            {GROUP_LABEL[g]}
          </div>
          {items.map(optionRow)}
        </div>
      ));
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputVal}
        onChange={(e) => {
          setInputVal(e.target.value);
          onText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={inputCls}
      />
      {options.length > 0 && !disabled && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Show items"
        >
          <ChevronDown size={13} />
        </button>
      )}
      {dropdownVisible &&
        coords &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              left: coords.left,
              top: coords.top,
              width: Math.max(coords.width, 224),
              zIndex: 1000,
            }}
            className="max-h-64 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1"
          >
            {renderOptions()}
            {showAddOption && (
              <button
                type="button"
                tabIndex={0}
                disabled={creating}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void create();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 text-primary font-medium border-t border-border mt-1 pt-1.5 disabled:opacity-60"
              >
                {creating ? (
                  <Loader2 size={13} className="animate-spin shrink-0" />
                ) : (
                  <Plus size={13} className="shrink-0" />
                )}
                <span className="truncate">
                  Add &ldquo;{trimmed}&rdquo; as new billable item
                </span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
