import { useEffect, useState } from "react";

/**
 * Section-scoped date filter for the Stats page's Remake Records section.
 *
 * Deliberately independent from `@/components/reports/DateRangePicker` (used
 * by the Reports page and the page-wide Stats date range): the preset set
 * required here (Yesterday, Last year) differs from the shared control, and
 * editing the shared component would change behaviour on those other
 * surfaces, which is out of scope for filtering Remake Records.
 */

export type RemakeDateRangePresetKey =
  | "all"
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "year"
  | "lastYear"
  | "custom";

export interface RemakeDateRange {
  preset: RemakeDateRangePresetKey;
  from: string;
  to: string;
}

/** The preset applied on first load and restored by "Clear filters". */
export const DEFAULT_REMAKE_DATE_PRESET: RemakeDateRangePresetKey = "month";

const PRESETS: Array<{ key: RemakeDateRangePresetKey; label: string }> = [
  { key: "all", label: "All remakes" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "year", label: "This year" },
  { key: "lastYear", label: "Last year" },
  { key: "custom", label: "Custom" },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function remakeRangeFromPreset(preset: RemakeDateRangePresetKey): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  if (preset === "today") {
    return { from: startOfDay(now), to: endOfDay(now) };
  }
  if (preset === "yesterday") {
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y) };
  }
  if (preset === "week") {
    const day = (now.getDay() + 6) % 7; // Mon = 0
    const from = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day));
    return { from, to: endOfDay(now) };
  }
  if (preset === "month") {
    const from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    return { from, to: endOfDay(now) };
  }
  if (preset === "year") {
    const from = startOfDay(new Date(now.getFullYear(), 0, 1));
    return { from, to: endOfDay(now) };
  }
  if (preset === "lastYear") {
    // The full previous calendar year: Jan 1 through Dec 31, not a trailing
    // 365-day window — matches the "Last year" label.
    const from = startOfDay(new Date(now.getFullYear() - 1, 0, 1));
    const to = endOfDay(new Date(now.getFullYear() - 1, 11, 31));
    return { from, to };
  }
  // custom — fall back to current month so callers get a usable range.
  const from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  return { from, to: endOfDay(now) };
}

export function defaultRemakeDateRange(): RemakeDateRange {
  const { from, to } = remakeRangeFromPreset(DEFAULT_REMAKE_DATE_PRESET);
  return {
    preset: DEFAULT_REMAKE_DATE_PRESET,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function toInputDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${da}`;
}

interface Props {
  value: RemakeDateRange;
  onChange: (next: RemakeDateRange) => void;
}

export function RemakeDateRangeFilter({ value, onChange }: Props) {
  const [customFrom, setCustomFrom] = useState(toInputDate(value.from));
  const [customTo, setCustomTo] = useState(toInputDate(value.to));

  useEffect(() => {
    setCustomFrom(toInputDate(value.from));
    setCustomTo(toInputDate(value.to));
  }, [value.from, value.to]);

  function applyPreset(preset: RemakeDateRangePresetKey) {
    if (preset === "all") {
      onChange({ preset: "all", from: "", to: "" });
      return;
    }
    if (preset === "custom") {
      onChange({ ...value, preset: "custom" });
      return;
    }
    const { from, to } = remakeRangeFromPreset(preset);
    onChange({ preset, from: from.toISOString(), to: to.toISOString() });
  }

  function applyCustom() {
    if (!customFrom || !customTo) return;
    const from = startOfDay(new Date(customFrom + "T00:00:00"));
    const to = endOfDay(new Date(customTo + "T00:00:00"));
    if (from.getTime() > to.getTime()) return;
    onChange({ preset: "custom", from: from.toISOString(), to: to.toISOString() });
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <select
        className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
        value={value.preset}
        onChange={(e) => applyPreset(e.target.value as RemakeDateRangePresetKey)}
        aria-label="Date range"
        data-testid="stats-remakes-date-preset"
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      {value.preset === "custom" && (
        <>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            onBlur={applyCustom}
            aria-label="Start date"
            data-testid="stats-remakes-date-from"
            className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            onBlur={applyCustom}
            aria-label="End date"
            data-testid="stats-remakes-date-to"
            className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
          />
        </>
      )}
    </div>
  );
}
