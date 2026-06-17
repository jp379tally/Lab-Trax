/**
 * FieldCombobox — type-ahead string combobox for vocabulary-backed fields
 * (material, shade, restoration type). Mirrors the portal-rendering pattern
 * of ItemCombobox so dropdowns escape clipping containers.
 *
 * Keyboard navigation:
 *   ArrowDown / ArrowUp — move cursor through list + "Add new" row
 *   Enter               — confirm highlighted item (or the only match)
 *   Escape              — close without change
 *
 * Usage:
 *   <FieldCombobox
 *     value={material}
 *     suggestions={materialSuggestions}
 *     onChange={setMaterial}
 *     onCreate={handleAddMaterial}   // optional: persist to DB and return value
 *     placeholder="Select material…"
 *     addNewLabel="Add new material"
 *   />
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Plus } from "lucide-react";

interface Props {
  value: string;
  suggestions: string[];
  onChange: (value: string) => void;
  /** Async callback to persist a new vocabulary value; receives the raw typed
   *  string and should resolve to the canonical string (may differ in casing). */
  onCreate?: (value: string) => Promise<string | null>;
  placeholder?: string;
  /** Text shown in the "Add new" action row; defaults to "Add new item". */
  addNewLabel?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Additional className applied to the underlying input element. */
  inputClassName?: string;
}

export function FieldCombobox({
  value,
  suggestions,
  onChange,
  onCreate,
  placeholder = "Select…",
  addNewLabel = "Add new item",
  size = "md",
  disabled = false,
  inputClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const [creating, setCreating] = useState(false);
  /** Index into the virtual list: 0…filtered.length-1 are suggestion rows;
   *  filtered.length is the "Add new" row (if visible). -1 means none. */
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
  const lower = trimmed.toLowerCase();
  const filtered = trimmed
    ? suggestions.filter((s) => s.toLowerCase().includes(lower))
    : suggestions;
  const hasExactMatch = suggestions.some((s) => s.toLowerCase() === lower);
  const showAddOption = !!onCreate && trimmed.length > 0 && !hasExactMatch;
  const dropdownVisible =
    open && !disabled && (filtered.length > 0 || showAddOption);
  /** Total navigable rows (suggestions + optional "Add new" row). */
  const rowCount = filtered.length + (showAddOption ? 1 : 0);

  // Reset cursor when list contents change.
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

  function pick(val: string) {
    setInputVal(val);
    onChange(val);
    setOpen(false);
    setCursor(-1);
  }

  const create = useCallback(async () => {
    if (!onCreate || !trimmed || creating) return;
    setCreating(true);
    try {
      const canonical = await onCreate(trimmed);
      if (canonical != null) {
        setInputVal(canonical);
        onChange(canonical);
        setOpen(false);
        setCursor(-1);
      }
    } finally {
      setCreating(false);
    }
  }, [onCreate, trimmed, creating, onChange]);

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
      setCursor((c) => (c + 1) % Math.max(rowCount, 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return;
      setCursor((c) => (c <= 0 ? rowCount - 1 : c - 1));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (dropdownVisible && cursor >= 0) {
        if (cursor < filtered.length) {
          pick(filtered[cursor]);
        } else if (showAddOption) {
          void create();
        }
        return;
      }
      // No cursor — fall back to single-match / exact-match / add-new.
      if (filtered.length === 1) {
        pick(filtered[0]);
      } else if (hasExactMatch) {
        pick(trimmed);
      } else if (showAddOption) {
        void create();
      }
    }
  }

  const baseInputCls =
    size === "sm"
      ? "w-full h-7 pl-2 pr-7 rounded bg-secondary text-xs border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
      : "w-full h-8 pl-2 pr-7 rounded bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary";

  const inputCls = inputClassName
    ? `${baseInputCls} ${inputClassName}`
    : baseInputCls;

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputVal}
        onChange={(e) => {
          setInputVal(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={inputCls}
        aria-autocomplete="list"
        aria-expanded={dropdownVisible}
        role="combobox"
      />
      {suggestions.length > 0 && !disabled && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Show options"
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
              width: Math.max(coords.width, 200),
              zIndex: 1000,
            }}
            className="max-h-60 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1"
          >
            {filtered.map((s, i) => (
              <button
                key={s}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={cursor === i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setCursor(i)}
                className={`w-full text-left px-3 py-1.5 truncate ${
                  cursor === i ? "bg-accent text-accent-foreground" : "hover:bg-secondary"
                }`}
              >
                {s}
              </button>
            ))}
            {showAddOption && (
              <button
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={cursor === filtered.length}
                disabled={creating}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void create();
                }}
                onMouseEnter={() => setCursor(filtered.length)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-primary font-medium border-t border-border mt-1 pt-1.5 disabled:opacity-60 ${
                  cursor === filtered.length ? "bg-accent text-accent-foreground" : "hover:bg-secondary"
                }`}
              >
                {creating ? (
                  <Loader2 size={13} className="animate-spin shrink-0" />
                ) : (
                  <Plus size={13} className="shrink-0" />
                )}
                <span className="truncate">
                  {addNewLabel}: &ldquo;{trimmed}&rdquo;
                </span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
