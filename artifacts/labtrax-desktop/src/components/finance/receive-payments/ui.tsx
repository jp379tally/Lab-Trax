import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { avatarColor, type SortKey, type SortState } from "./model";

/** A sortable column header: the first click sorts by the column, the next flips it. */
export function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={`px-1.5 py-2 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground ${active ? "text-foreground" : ""}`}
      >
        {label}
        {active ? (
          sort.direction === "asc" ? (
            <ArrowUp size={11} aria-hidden="true" />
          ) : (
            <ArrowDown size={11} aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown size={11} aria-hidden="true" className="opacity-50" />
        )}
      </button>
    </th>
  );
}

/** A small pill marking how a customer pays, or that an invoice is on their statement. */
export function Badge({
  tone = "primary",
  title,
  children,
}: {
  tone?: "primary" | "warning" | "muted";
  title?: string;
  children: ReactNode;
}) {
  const colors =
    tone === "warning"
      ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
      : tone === "muted"
        ? "bg-secondary text-muted-foreground"
        : "bg-primary/10 text-primary";
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium leading-4 ${colors}`}
    >
      {children}
    </span>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
      {children}
    </div>
  );
}

export function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={bold ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</dd>
    </div>
  );
}

/** A native checkbox that can also show the mixed (partly selected) state. */
export function Checkbox({
  indeterminate = false,
  className = "",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-checked={indeterminate ? "mixed" : undefined}
      className={`h-4 w-4 shrink-0 rounded border-input accent-primary align-middle ${className}`}
      {...props}
    />
  );
}

export function CustomerAvatar({ id, initials, className = "" }: { id: string; initials: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${avatarColor(id)} ${className}`}
    >
      {initials}
    </span>
  );
}

export const fieldClass =
  "w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm disabled:opacity-60";

export const filterSelectClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs";
