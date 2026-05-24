import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { apiFetch } from "@/lib/api";

export type VendorType = "vendor" | "employee" | "item";

export interface Vendor {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
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
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function VendorCombobox({
  organizationId,
  value,
  onChange,
  className = "",
  placeholder = "Payee",
  disabled = false,
}: Props) {
  const vendorsQuery = useVendors(organizationId);
  const activeVendors = (vendorsQuery.data ?? []).filter((v) => v.isActive);

  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
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

  function select(name: string) {
    setInputVal(name);
    onChange(name);
    setOpen(false);
  }

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    setInputVal(e.target.value);
    onChange(e.target.value);
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

  function renderItems(items: Vendor[]) {
    return items.map((v) => (
      <li key={v.id}>
        <button
          type="button"
          tabIndex={0}
          className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2 min-w-0"
          onMouseDown={(e) => {
            e.preventDefault();
            select(v.name);
          }}
        >
          <span
            className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_BADGE_CLASS[v.vendorType]}`}
          >
            {TYPE_LABEL[v.vendorType]}
          </span>
          <span className="font-medium truncate">{v.name}</span>
          {v.address && (
            <span className="ml-1 text-xs text-muted-foreground truncate hidden sm:block">
              {v.address}
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

  return (
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
      {open && filtered.length > 0 && (
        <ul className="absolute z-50 left-0 top-[calc(100%+2px)] w-full max-h-64 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1">
          {isGrouped ? renderGrouped() : renderItems(filtered)}
        </ul>
      )}
    </div>
  );
}
