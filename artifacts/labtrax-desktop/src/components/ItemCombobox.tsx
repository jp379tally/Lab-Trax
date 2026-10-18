import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import {
  filterItemsByName,
  hasExactItemNameMatch,
} from "@workspace/item-name-match";

export interface ItemComboboxOption {
  key: string;
  name: string;
  unitPrice: number | null;
  group: "catalog" | "custom";
  isDiscount?: boolean;
}

interface Props {
  value: string;
  options: ItemComboboxOption[];
  /** Called when an existing option is chosen (auto-fills name/description/price). */
  onPick: (opt: {
    name: string;
    unitPrice: number | null;
    isDiscount?: boolean;
  }) => void;
  /** Called on every keystroke so a free-typed (custom) name is preserved. */
  onText: (text: string) => void;
  /**
   * Creates a new billable item from the typed name. Resolve with the created
   * item to select it, or null to keep the typed text as a custom entry.
   */
  onCreate?: (
    name: string,
  ) => Promise<{ name: string; unitPrice: number | null } | null>;
  /**
   * When provided, renders a persistent "Add New Billable Item" footer in the
   * dropdown. Called with the current typed text when clicked.
   */
  onAddNew?: (typedName: string) => void;
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
  onAddNew,
  placeholder = "Item",
  size = "md",
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const [creating, setCreating] = useState(false);
  /**
   * Index into the visible row list: 0…orderedOptions.length-1 are item rows,
   * orderedOptions.length is the "add as new billable item" row (when shown).
   * -1 means nothing is highlighted yet.
   */
  const [cursor, setCursor] = useState(-1);
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
  // Punctuation/spacing-insensitive match so "ema" finds "E.max Crown", with
  // exact and prefix hits ranked above incidental substring hits.
  const filtered = trimmed ? filterItemsByName(options, trimmed) : options;
  const hasExactMatch = hasExactItemNameMatch(options, trimmed);
  const showAddOption = !!onCreate && trimmed.length > 0 && !hasExactMatch;
  // Show the dropdown when open and there is at least one thing to display:
  // matching options, a create shortcut, OR the "Add New Billable Item" footer.
  const dropdownVisible =
    open && !disabled && (filtered.length > 0 || showAddOption || !!onAddNew);
  const groupOrder: ItemComboboxOption["group"][] = ["catalog", "custom"];
  /**
   * Options in the order they are actually rendered, so the keyboard cursor
   * lines up with what the user sees. With search text that is the ranked
   * filter order; without it the rows are grouped catalog-then-custom.
   */
  const orderedOptions = trimmed
    ? filtered
    : groupOrder.flatMap((g) => filtered.filter((o) => o.group === g));
  /** Navigable rows: the options plus the optional "add as new" row. */
  const rowCount = orderedOptions.length + (showAddOption ? 1 : 0);

  // Reset the highlight whenever the list contents or open state change.
  useEffect(() => {
    setCursor(-1);
  }, [inputVal, open]);

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

  function pick(o: {
    name: string;
    unitPrice: number | null;
    isDiscount?: boolean;
  }) {
    setInputVal(o.name);
    onPick(o);
    setOpen(false);
    setCursor(-1);
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
        setCursor(-1);
      }
    } finally {
      setCreating(false);
    }
  }, [onCreate, trimmed, creating, onPick]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setCursor(-1);
      inputRef.current?.blur();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (rowCount === 0) return;
      setCursor((c) => (c + 1) % rowCount);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open || rowCount === 0) return;
      setCursor((c) => (c <= 0 ? rowCount - 1 : c - 1));
      return;
    }

    if (e.key === "Enter") {
      // An explicit highlight always wins.
      if (dropdownVisible && cursor >= 0) {
        e.preventDefault();
        const highlighted = orderedOptions[cursor];
        if (highlighted) {
          pick({ name: highlighted.name, unitPrice: highlighted.unitPrice });
        } else if (showAddOption) {
          void create();
        }
        return;
      }
      // Nothing highlighted: accept the top-ranked match for the typed text,
      // otherwise fall through to creating a new billable item.
      if (trimmed && orderedOptions.length > 0) {
        e.preventDefault();
        pick({
          name: orderedOptions[0].name,
          unitPrice: orderedOptions[0].unitPrice,
          isDiscount: orderedOptions[0].isDiscount,
        });
      } else if (showAddOption) {
        e.preventDefault();
        void create();
      }
    }
  }

  const inputCls =
    size === "sm"
      ? "w-full h-7 pl-2 pr-7 rounded bg-background border border-input text-xs"
      : "w-full h-9 pl-2 pr-7 rounded bg-background border border-input text-sm";

  function optionRow(o: ItemComboboxOption) {
    const i = orderedOptions.indexOf(o);
    const active = i >= 0 && i === cursor;
    return (
      <button
        key={o.key}
        type="button"
        tabIndex={0}
        role="option"
        aria-selected={active}
        onMouseDown={(e) => {
          e.preventDefault();
          pick({
            name: o.name,
            unitPrice: o.unitPrice,
            isDiscount: o.isDiscount,
          });
        }}
        onMouseEnter={() => setCursor(i)}
        className={`w-full min-h-9 text-left px-3 py-2 flex items-center gap-2 ${
          active ? "bg-accent text-accent-foreground" : "hover:bg-secondary"
        }`}
      >
        <span className="flex-1 min-w-0 whitespace-normal break-words leading-5">
          {o.name}
          {o.isDiscount && (
            <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Discount
            </span>
          )}
        </span>
        {o.unitPrice != null && (
          <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
            {o.isDiscount ? "−" : ""}${Math.abs(o.unitPrice).toFixed(2)}
          </span>
        )}
      </button>
    );
  }

  function renderOptions() {
    if (filtered.length === 0) return null;
    if (trimmed) return filtered.map(optionRow);
    // No search text: group catalog items and custom billable items.
    return groupOrder
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
        title={inputVal || undefined}
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
            role="listbox"
            style={{
              position: "fixed",
              left: coords.left,
              top: coords.top,
              width: Math.max(coords.width, 224),
              zIndex: 1000,
            }}
            className="max-h-72 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1"
          >
            {renderOptions()}
            {showAddOption && (
              <button
                type="button"
                tabIndex={0}
                role="option"
                aria-selected={cursor === orderedOptions.length}
                disabled={creating}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void create();
                }}
                onMouseEnter={() => setCursor(orderedOptions.length)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-primary font-medium border-t border-border mt-1 pt-1.5 disabled:opacity-60 ${
                  cursor === orderedOptions.length
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-secondary"
                }`}
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
            {onAddNew && (
              <button
                type="button"
                tabIndex={0}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  onAddNew(trimmed);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 text-primary font-medium border-t border-border mt-1 pt-1.5"
              >
                <Plus size={13} className="shrink-0" />
                <span className="truncate">Add New Billable Item</span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
