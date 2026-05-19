import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { apiFetch } from "@/lib/api";

export interface Vendor {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
}

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
  const vendors = vendorsQuery.data ?? [];

  const [open, setOpen] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInputVal(value);
  }, [value]);

  const filtered = inputVal.trim()
    ? vendors.filter((v) =>
        v.name.toLowerCase().includes(inputVal.toLowerCase())
      )
    : vendors;

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
      {vendors.length > 0 && !disabled && (
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
        <ul className="absolute z-50 left-0 top-[calc(100%+2px)] w-full max-h-52 overflow-y-auto bg-card border border-border rounded-md shadow-lg text-sm py-1">
          {filtered.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                tabIndex={0}
                className="w-full text-left px-3 py-1.5 hover:bg-secondary"
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(v.name);
                }}
              >
                <span className="font-medium">{v.name}</span>
                {v.address && (
                  <span className="ml-2 text-xs text-muted-foreground truncate">
                    {v.address}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
