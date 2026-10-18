import { Search, X } from "lucide-react";

interface MessengerSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Search input shown at the top of a messenger conversation panel. Filtering
 * behavior lives in the parent (client-side over loaded messages, plus a
 * server-side search for older history); this component only owns the input UI.
 */
export function MessengerSearchBar({
  value,
  onChange,
  placeholder = "Search messages…",
}: MessengerSearchBarProps) {
  return (
    <div className="shrink-0 px-4 py-2 border-b border-border bg-card/50">
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label="Search messages"
          className="w-full rounded-md border border-input bg-background pl-8 pr-8 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
