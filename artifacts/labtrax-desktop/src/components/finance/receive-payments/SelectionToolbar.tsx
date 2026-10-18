import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search } from "lucide-react";
import type { AgingBucketKey } from "@/lib/ap-types";
import {
  AGING_BUCKETS,
  NO_LOCATION,
  SORT_OPTIONS,
  STATUS_FILTERS,
  type SelectionFilters,
  type SortKey,
  type SortState,
  type StatusFilter,
} from "./model";
import { filterSelectClass } from "./ui";

export function SelectionToolbar({
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  locations,
  hasMissingLocation,
  agingLabel,
  canClear,
  onClear,
}: {
  filters: SelectionFilters;
  onFiltersChange: (next: SelectionFilters) => void;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  locations: string[];
  hasMissingLocation: boolean;
  /** Accessible name of the aging filter; it filters customers by their oldest invoice, or individual invoices. */
  agingLabel: string;
  canClear: boolean;
  onClear: () => void;
}) {
  const set = (change: Partial<SelectionFilters>) => onFiltersChange({ ...filters, ...change });
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
      <label className="relative flex min-w-[9rem] flex-1 basis-40 items-center @min-[44rem]:max-w-[15rem]">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search customers"
          placeholder="Search customer, account #, doctor or invoice #"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs"
        />
      </label>
      <select
        aria-label="Status"
        value={filters.status}
        onChange={(e) => set({ status: e.target.value as StatusFilter })}
        className={filterSelectClass}
      >
        <option value="">All Statuses</option>
        {STATUS_FILTERS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Location"
        value={filters.location}
        onChange={(e) => set({ location: e.target.value })}
        className={`${filterSelectClass} max-w-[10rem]`}
      >
        <option value="">All Locations</option>
        {locations.map((location) => (
          <option key={location} value={location}>
            {location}
          </option>
        ))}
        {hasMissingLocation && <option value={NO_LOCATION}>No city/state on file</option>}
      </select>
      <select
        aria-label={agingLabel}
        value={filters.aging}
        onChange={(e) => set({ aging: e.target.value as AgingBucketKey | "" })}
        className={filterSelectClass}
      >
        <option value="">Any Aging</option>
        {AGING_BUCKETS.map((bucket) => (
          <option key={bucket.key} value={bucket.key}>
            {bucket.filterLabel}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onClear}
        disabled={!canClear}
        className="h-8 px-1.5 text-xs font-medium text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
      >
        Clear
      </button>
      <div className="ml-auto flex items-center gap-1">
        <select
          aria-label="Sort by"
          value={sort.key}
          onChange={(e) => {
            const key = e.target.value as SortKey;
            const option = SORT_OPTIONS.find((row) => row.key === key);
            onSortChange({ key, direction: option?.defaultDirection ?? "asc" });
          }}
          className={filterSelectClass}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              Sort by: {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={`Sort direction: ${sort.direction === "asc" ? "ascending" : "descending"}`}
          title={sort.direction === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
          onClick={() => onSortChange({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:text-foreground"
        >
          {sort.direction === "asc" ? (
            <ArrowUpNarrowWide size={14} aria-hidden="true" />
          ) : (
            <ArrowDownWideNarrow size={14} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
