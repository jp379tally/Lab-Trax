import { useRef, useState } from "react";
import { formatCalendarDate, parseRangeDate, rangeDateError, rangeMonthDays, rangeCalendarMonth } from "@workspace/calendar-date";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export function CaseRangeWindow({ start, end, onApply, onCancel }: {
  start: string; end: string; onApply: (start: string, end: string) => void; onCancel: () => void;
}) {
  const [from, setFrom] = useState(formatCalendarDate(start) ?? "");
  const [to, setTo] = useState(formatCalendarDate(end) ?? "");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return start ? rangeCalendarMonth(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1) : rangeCalendarMonth(now.getFullYear(), now.getMonth());
  });
  const [choosingEnd, setChoosingEnd] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const startInput = useRef<HTMLInputElement>(null);
  const a = parseRangeDate(from), b = parseRangeDate(to);
  const error = rangeDateError(a, b);
  function normalize(value: string, setter: (s: string) => void) {
    const iso = parseRangeDate(value);
    if (iso) {
      setter(formatCalendarDate(iso)!);
      setMonth(rangeCalendarMonth(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1));
    }
    setAttempted(true);
  }
  function choose(day: string) {
    if (!choosingEnd) {
      setFrom(formatCalendarDate(day)!); setTo(""); setChoosingEnd(true); setAttempted(false);
    } else {
      setTo(formatCalendarDate(day)!); setChoosingEnd(false); setAttempted(true);
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent className="w-[384px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-y-auto gap-2 p-4" onOpenAutoFocus={(e) => { e.preventDefault(); startInput.current?.focus(); }}>
      <DialogTitle className="text-base">Custom date range</DialogTitle>
      <DialogDescription className="text-xs">Pick Start then End, or type M/D or M/D/YYYY.</DialogDescription>
      <div className="flex items-center justify-between">
        <button type="button" className="h-8 w-8 rounded hover:bg-secondary" aria-label="Previous month" onClick={() => setMonth(rangeCalendarMonth(month.getFullYear(), month.getMonth() - 1))}>‹</button>
        <span aria-live="polite">{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <button type="button" className="h-8 w-8 rounded hover:bg-secondary" aria-label="Next month" onClick={() => setMonth(rangeCalendarMonth(month.getFullYear(), month.getMonth() + 1))}>›</button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs" role="group" aria-label="Calendar">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(d => <span key={d} className="text-muted-foreground">{d}</span>)}
        {rangeMonthDays(month.getFullYear(), month.getMonth()).map((day, i) => day ? <button key={day} type="button"
          aria-label={formatCalendarDate(day)!} aria-pressed={!!a && day >= a && day <= (b && b >= a ? b : a)}
          className={`h-6 rounded focus-visible:ring-2 focus-visible:ring-primary ${day === a || day === b ? "bg-primary text-primary-foreground" : a && b && day > a && day < b ? "bg-primary/15" : "hover:bg-secondary"}`}
          onClick={() => choose(day)}
          onKeyDown={e => {
            const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
            if (offset !== undefined) {
              e.preventDefault();
              const buttons = e.currentTarget.parentElement?.querySelectorAll("button");
              const index = buttons ? Array.from(buttons).indexOf(e.currentTarget) : -1;
              if (buttons) buttons[index + offset]?.focus();
            }
          }}>{Number(day.slice(8))}</button> : <span key={i} />)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">Start date<input ref={startInput} value={from} placeholder="M/D/YYYY" aria-invalid={attempted && !a} aria-describedby="case-range-error"
          className="w-full h-8 px-2 mt-1 rounded border bg-background" onChange={e => { setFrom(e.target.value); setChoosingEnd(false); }} onBlur={() => normalize(from, setFrom)} /></label>
        <label className="text-xs">End date<input value={to} placeholder="M/D/YYYY" aria-invalid={attempted && !!error} aria-describedby="case-range-error"
          className="w-full h-8 px-2 mt-1 rounded border bg-background" onChange={e => { setTo(e.target.value); setChoosingEnd(false); }} onBlur={() => normalize(to, setTo)} /></label>
      </div>
      <p className="text-xs" aria-live="polite">{a && b ? `${formatCalendarDate(a)} – ${formatCalendarDate(b)}` : a ? `${formatCalendarDate(a)} – Select End date` : "Select a range"}</p>
      {attempted && error && <p id="case-range-error" role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="text-sm">Cancel</button>
        <button disabled={!!error} className="rounded bg-primary text-primary-foreground px-3 py-1 text-sm disabled:opacity-50" onClick={() => { if (a && b && !error) onApply(a, b); }}>Apply</button>
      </div>
    </DialogContent>
  </Dialog>;
}
