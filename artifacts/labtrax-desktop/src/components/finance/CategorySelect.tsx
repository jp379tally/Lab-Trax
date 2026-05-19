import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Category {
  id: string;
  name: string;
  kind: string;
}

interface Props {
  organizationId: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLSelectElement>) => void;
}

const SENTINEL = "__add__";

export function CategorySelect({
  organizationId,
  value,
  onChange,
  className = "",
  disabled = false,
  onKeyDown,
}: Props) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const catsQuery = useQuery({
    queryKey: ["finance", "categories", organizationId],
    queryFn: () =>
      apiFetch<Category[]>(
        `/finance/categories?organizationId=${organizationId}`
      ),
    enabled: !!organizationId,
  });

  const categories = catsQuery.data ?? [];

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (e.target.value === SENTINEL) {
      setShowAdd(true);
      return;
    }
    onChange(e.target.value);
  }

  function handleAdded(newId: string) {
    qc.invalidateQueries({ queryKey: ["finance", "categories", organizationId] });
    onChange(newId);
    setShowAdd(false);
  }

  return (
    <>
      <select
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
        className={className}
      >
        <option value="">— None —</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value={SENTINEL}>＋ Add category…</option>
      </select>

      {showAdd && (
        <AddCategoryModal
          organizationId={organizationId}
          onClose={() => setShowAdd(false)}
          onAdded={handleAdded}
        />
      )}
    </>
  );
}

function AddCategoryModal({
  organizationId,
  onClose,
  onAdded,
}: {
  organizationId: string;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"expense" | "income" | "transfer">("expense");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string; name: string; kind: string }>("/finance/categories", {
        method: "POST",
        body: JSON.stringify({ organizationId, name: name.trim(), kind }),
      }),
    onSuccess: (row) => onAdded(row.id),
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
            <label className="block text-xs font-medium mb-1">Type</label>
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
