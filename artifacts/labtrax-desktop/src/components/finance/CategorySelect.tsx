import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

export interface TransactionCategory {
  id: string;
  name: string;
  kind: string;
  color: string | null;
  description: string | null;
  isArchived: boolean;
}

const KIND_LABEL: Record<string, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

const KIND_ORDER = ["income", "expense", "transfer"];

const KIND_BADGE: Record<string, string> = {
  income: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  expense: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  transfer: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
};

interface Props {
  organizationId: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export function CategorySelect({
  organizationId,
  value,
  onChange,
  className = "",
  disabled = false,
  onKeyDown,
}: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const catsQuery = useQuery({
    queryKey: ["finance", "categories", organizationId],
    queryFn: () =>
      apiFetch<TransactionCategory[]>(
        `/finance/categories?organizationId=${organizationId}`
      ),
    enabled: !!organizationId,
  });

  const activeCategories = (catsQuery.data ?? []).filter((c) => !c.isArchived);
  const selected = activeCategories.find((c) => c.id === value);

  useEffect(() => {
    setInputVal(selected?.name ?? "");
  }, [selected?.name]);

  const trimmed = inputVal.trim();

  const filtered = trimmed
    ? activeCategories.filter((c) =>
        c.name.toLowerCase().includes(trimmed.toLowerCase()) ||
        c.kind.toLowerCase().includes(trimmed.toLowerCase())
      )
    : activeCategories;

  function select(id: string, name: string) {
    onChange(id);
    setInputVal(name);
    setOpen(false);
  }

  function clear() {
    onChange("");
    setInputVal("");
    inputRef.current?.focus();
  }

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    setInputVal(e.target.value);
    if (!e.target.value) onChange("");
    setOpen(true);
  }

  function handleBlur(e: React.FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && containerRef.current?.contains(next)) return;
    setOpen(false);
    if (!value) setInputVal("");
    else setInputVal(selected?.name ?? "");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
    onKeyDown?.(e);
  }

  function handleAdded(newId: string, newName: string) {
    qc.invalidateQueries({ queryKey: ["finance", "categories", organizationId] });
    onChange(newId);
    setInputVal(newName);
    setShowAdd(false);
    setOpen(false);
  }

  function renderGroup(kind: string, items: TransactionCategory[]) {
    if (!items.length) return null;
    return (
      <li key={kind}>
        <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold bg-secondary/40 border-t border-border first:border-t-0">
          {KIND_LABEL[kind] ?? kind}
        </div>
        <ul>
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                tabIndex={0}
                className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 min-w-0"
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(c.id, c.name);
                }}
              >
                {c.color && (
                  <span
                    className="shrink-0 inline-block h-2.5 w-2.5 rounded-full border border-border/50"
                    style={{ backgroundColor: c.color }}
                  />
                )}
                <span className="font-medium truncate">{c.name}</span>
                <span
                  className={`ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${KIND_BADGE[c.kind] ?? "bg-secondary text-muted-foreground"}`}
                >
                  {KIND_LABEL[c.kind] ?? c.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </li>
    );
  }

  const grouped = !trimmed;

  return (
    <>
      <div
        ref={containerRef}
        className={`relative ${className}`}
        onBlur={handleBlur}
      >
        <input
          ref={inputRef}
          type="text"
          value={open ? inputVal : (selected?.name ?? "")}
          onChange={handleInput}
          onFocus={() => {
            setInputVal(selected?.name ?? "");
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="— None —"
          disabled={disabled}
          className="w-full h-full bg-transparent text-sm focus:outline-none pr-7 pl-1"
          autoComplete="off"
        />
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {value && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                clear();
              }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear category"
            >
              <X size={11} />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen((v) => !v);
              inputRef.current?.focus();
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Show categories"
            disabled={disabled}
          >
            <ChevronDown size={13} />
          </button>
        </div>

        {open && (
          <ul className="absolute z-50 left-0 top-[calc(100%+2px)] min-w-[200px] w-full max-h-64 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1">
            {filtered.length === 0 && trimmed && (
              <li className="px-3 py-2 text-xs text-muted-foreground italic">
                No categories match "{trimmed}"
              </li>
            )}
            {filtered.length > 0 && (
              grouped
                ? KIND_ORDER.map((kind) =>
                    renderGroup(kind, filtered.filter((c) => c.kind === kind))
                  )
                : filtered.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        tabIndex={0}
                        className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 min-w-0"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          select(c.id, c.name);
                        }}
                      >
                        {c.color && (
                          <span
                            className="shrink-0 inline-block h-2.5 w-2.5 rounded-full border border-border/50"
                            style={{ backgroundColor: c.color }}
                          />
                        )}
                        <span className="font-medium truncate">{c.name}</span>
                        <span
                          className={`ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${KIND_BADGE[c.kind] ?? "bg-secondary text-muted-foreground"}`}
                        >
                          {KIND_LABEL[c.kind] ?? c.kind}
                        </span>
                      </button>
                    </li>
                  ))
            )}
            <li className="border-t border-border mt-1 pt-1">
              <button
                type="button"
                tabIndex={0}
                className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 text-primary font-medium"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  setShowAdd(true);
                }}
              >
                <Plus size={13} className="shrink-0" />
                Add category…
              </button>
            </li>
          </ul>
        )}
      </div>

      {showAdd && (
        <AddCategoryModal
          organizationId={organizationId}
          initialName={trimmed}
          onClose={() => setShowAdd(false)}
          onAdded={handleAdded}
        />
      )}
    </>
  );
}

function AddCategoryModal({
  organizationId,
  initialName,
  onClose,
  onAdded,
}: {
  organizationId: string;
  initialName: string;
  onClose: () => void;
  onAdded: (id: string, name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState<"expense" | "income" | "transfer">("expense");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string; name: string; kind: string }>("/finance/categories", {
        method: "POST",
        body: JSON.stringify({ organizationId, name: name.trim(), kind }),
      }),
    onSuccess: (row) => onAdded(row.id, row.name),
    onError: (e: Error) => setError(e.message || "Failed to add category."),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    add.mutate();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/30 p-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-xl shadow-xl">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Add category</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </header>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}
          <div>
            <label className="block text-xs font-medium mb-1">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Office supplies"
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Kind</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="transfer">Transfer</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || add.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              <Plus size={14} />
              {add.isPending ? "Adding…" : "Add category"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
