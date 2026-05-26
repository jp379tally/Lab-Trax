import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

export type VendorType = "vendor" | "employee" | "item";

export interface Vendor {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  vendorType: VendorType;
  isActive: boolean;
}

export const TYPE_LABEL: Record<VendorType, string> = {
  vendor: "Vendor",
  employee: "Employee",
  item: "Item",
};

export const TYPE_BADGE_CLASS: Record<VendorType, string> = {
  vendor: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  employee: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  item: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

const GROUP_ORDER: VendorType[] = ["vendor", "employee", "item"];

export function useVendors(organizationId: string) {
  return useQuery({
    queryKey: ["finance", "vendors", organizationId],
    queryFn: () =>
      apiFetch<Vendor[]>(`/finance/vendors?organizationId=${organizationId}`),
    enabled: !!organizationId,
  });
}

interface Props {
  organizationId: string;
  value: string;
  onChange: (value: string) => void;
  onChangeId?: (id: string | null) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function VendorCombobox({
  organizationId,
  value,
  onChange,
  onChangeId,
  className = "",
  placeholder = "Payee",
  disabled = false,
}: Props) {
  const vendorsQuery = useVendors(organizationId);
  const activeVendors = (vendorsQuery.data ?? []).filter((v) => v.isActive);

  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInputVal(value);
  }, [value]);

  const trimmed = inputVal.trim();

  const filtered = trimmed
    ? activeVendors.filter((v) =>
        v.name.toLowerCase().includes(trimmed.toLowerCase())
      )
    : activeVendors;

  const isGrouped = !trimmed;
  const hasExactMatch = activeVendors.some(
    (v) => v.name.toLowerCase() === trimmed.toLowerCase()
  );
  const showAddOption = trimmed.length > 0 && !hasExactMatch;

  function select(vendor: Vendor) {
    setInputVal(vendor.name);
    onChange(vendor.name);
    onChangeId?.(vendor.id);
    setOpen(false);
  }

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    setInputVal(e.target.value);
    onChange(e.target.value);
    onChangeId?.(null);
    setOpen(true);
  }

  function handleBlur(e: React.FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && containerRef.current?.contains(next)) return;
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  function handleQuickAddSaved(vendor: Vendor) {
    setInputVal(vendor.name);
    onChange(vendor.name);
    onChangeId?.(vendor.id);
    setShowQuickAdd(false);
    setOpen(false);
  }

  function renderItems(items: Vendor[]) {
    return items.map((v) => (
      <li key={v.id}>
        <button
          type="button"
          tabIndex={0}
          className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 min-w-0"
          onMouseDown={(e) => {
            e.preventDefault();
            select(v);
          }}
        >
          <span
            className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_BADGE_CLASS[v.vendorType]}`}
          >
            {TYPE_LABEL[v.vendorType]}
          </span>
          <span className="font-medium truncate">{v.name}</span>
          {(v.city || v.address) && (
            <span className="ml-1 text-xs text-muted-foreground truncate hidden sm:block">
              {v.city || v.address}
            </span>
          )}
        </button>
      </li>
    ));
  }

  function renderGrouped() {
    const groups = GROUP_ORDER.map((type) => ({
      type,
      items: filtered.filter((v) => v.vendorType === type),
    })).filter((g) => g.items.length > 0);

    return groups.map((g) => (
      <li key={g.type}>
        <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold bg-secondary/40 border-t border-border first:border-t-0">
          {TYPE_LABEL[g.type]}s
        </div>
        <ul>{renderItems(g.items)}</ul>
      </li>
    ));
  }

  const dropdownVisible = open && (filtered.length > 0 || showAddOption);

  return (
    <>
      <div ref={containerRef} className="relative" onBlur={handleBlur}>
        <input
          ref={inputRef}
          type="text"
          value={inputVal}
          onChange={handleInput}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={className}
          autoComplete="off"
        />
        {activeVendors.length > 0 && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen((v) => !v);
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Show vendors"
          >
            <ChevronDown size={13} />
          </button>
        )}
        {dropdownVisible && (
          <ul className="absolute z-50 left-0 top-[calc(100%+2px)] w-full max-h-64 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1">
            {filtered.length > 0 && (isGrouped ? renderGrouped() : renderItems(filtered))}
            {showAddOption && (
              <li className="border-t border-border mt-1 pt-1">
                <button
                  type="button"
                  tabIndex={0}
                  className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 text-primary font-medium"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    setShowQuickAdd(true);
                  }}
                >
                  <Plus size={13} className="shrink-0" />
                  Add "{trimmed}" to list…
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      {showQuickAdd && (
        <QuickAddVendorModal
          organizationId={organizationId}
          initialName={trimmed}
          onClose={() => setShowQuickAdd(false)}
          onSaved={handleQuickAddSaved}
        />
      )}
    </>
  );
}

function QuickAddVendorModal({
  organizationId,
  initialName,
  onClose,
  onSaved,
}: {
  organizationId: string;
  initialName: string;
  onClose: () => void;
  onSaved: (vendor: Vendor) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initialName);
  const [vendorType, setVendorType] = useState<VendorType>("vendor");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch<Vendor>("/finance/vendors", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          name: name.trim(),
          vendorType,
          phone: phone.trim() || null,
          email: email.trim() || null,
        }),
      }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] });
      onSaved(row);
    },
    onError: (e: Error) => setError(e.message || "Failed to create."),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    createMut.mutate();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/30 p-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-xl shadow-xl">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Add to list</h2>
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
              placeholder="Full name"
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">List type</label>
            <select
              value={vendorType}
              onChange={(e) => setVendorType(e.target.value as VendorType)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              <option value="vendor">Vendor</option>
              <option value="employee">Employee</option>
              <option value="item">Item</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Phone (optional)</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 555-5555"
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Email (optional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
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
              disabled={!name.trim() || createMut.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {createMut.isPending && <Loader2 size={13} className="animate-spin" />}
              <Plus size={14} />
              Add to list
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
