import { useEffect, useMemo, useState } from "react";

export type DateRangePresetKey =
  | "today"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "custom";

export interface DateRange {
  preset: DateRangePresetKey;
  from: string;
  to: string;
}

const PRESETS: Array<{ key: DateRangePresetKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
  { key: "year", label: "This year" },
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

export function rangeFromPreset(preset: DateRangePresetKey): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  if (preset === "today") {
    return { from: startOfDay(now), to: endOfDay(now) };
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
  if (preset === "quarter") {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    const from = startOfDay(new Date(now.getFullYear(), qStartMonth, 1));
    return { from, to: endOfDay(now) };
  }
  if (preset === "year") {
    const from = startOfDay(new Date(now.getFullYear(), 0, 1));
    return { from, to: endOfDay(now) };
  }
  // custom — fall back to current month so callers get a usable range.
  const from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  return { from, to: endOfDay(now) };
}

export function defaultRange(): DateRange {
  const { from, to } = rangeFromPreset("month");
  return {
    preset: "month",
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

export function rangeLabel(range: DateRange): string {
  const presetLabel =
    PRESETS.find((p) => p.key === range.preset)?.label ?? "Custom";
  const fromS = toInputDate(range.from);
  const toS = toInputDate(range.to);
  return `${presetLabel} (${fromS} → ${toS})`;
}

interface Props {
  value: DateRange;
  onChange: (next: DateRange) => void;
}

export function DateRangePicker({ value, onChange }: Props) {
  const [customFrom, setCustomFrom] = useState(toInputDate(value.from));
  const [customTo, setCustomTo] = useState(toInputDate(value.to));

  useEffect(() => {
    setCustomFrom(toInputDate(value.from));
    setCustomTo(toInputDate(value.to));
  }, [value.from, value.to]);

  function applyPreset(preset: DateRangePresetKey) {
    if (preset === "custom") {
      onChange({ ...value, preset: "custom" });
      return;
    }
    const { from, to } = rangeFromPreset(preset);
    onChange({ preset, from: from.toISOString(), to: to.toISOString() });
  }

  function applyCustom() {
    if (!customFrom || !customTo) return;
    const from = startOfDay(new Date(customFrom + "T00:00:00"));
    const to = endOfDay(new Date(customTo + "T00:00:00"));
    if (from.getTime() > to.getTime()) return;
    onChange({
      preset: "custom",
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={value.preset}
        onChange={(e) => applyPreset(e.target.value as DateRangePresetKey)}
        className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
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
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            onBlur={applyCustom}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          />
        </>
      )}
    </div>
  );
}

export function useDateRangeState(initial?: DateRange) {
  const [range, setRange] = useState<DateRange>(initial ?? defaultRange());
  const params = useMemo(
    () => ({ dateFrom: range.from, dateTo: range.to }),
    [range.from, range.to],
  );
  return { range, setRange, params };
}
