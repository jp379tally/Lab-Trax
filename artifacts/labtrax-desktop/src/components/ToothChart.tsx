import { useCallback, useMemo, useState } from "react";

/**
 * Interactive ADA Universal Numbering tooth chart.
 *
 * Adult permanent teeth: 1–32 (1 = upper-right 3rd molar, 16 = upper-left
 * 3rd molar, 17 = lower-left 3rd molar, 32 = lower-right 3rd molar).
 *
 * Primary (deciduous) teeth: A–T (A = upper-right 2nd molar, J = upper-left,
 * K = lower-left 2nd molar, T = lower-right 2nd molar).
 *
 * Layout (looking at the patient):
 *   Upper:  1 .. 8 | 9 .. 16          (adult)
 *           A .. E | F .. J           (primary, inside the adult row)
 *   Lower: 32 ..25 |24 ..17           (adult, mirrored so each adult sits
 *                                       directly under its same-side counterpart)
 *           T .. P | O .. K           (primary)
 */

export type ToothId = string; // "1".."32" or "A".."T"

const ADULT_UPPER_RIGHT: ToothId[] = ["1", "2", "3", "4", "5", "6", "7", "8"];
const ADULT_UPPER_LEFT: ToothId[] = [
  "9", "10", "11", "12", "13", "14", "15", "16",
];
const ADULT_LOWER_LEFT: ToothId[] = [
  "17", "18", "19", "20", "21", "22", "23", "24",
];
const ADULT_LOWER_RIGHT: ToothId[] = [
  "25", "26", "27", "28", "29", "30", "31", "32",
];

const PRIMARY_UPPER_RIGHT: ToothId[] = ["A", "B", "C", "D", "E"];
const PRIMARY_UPPER_LEFT: ToothId[] = ["F", "G", "H", "I", "J"];
const PRIMARY_LOWER_LEFT: ToothId[] = ["K", "L", "M", "N", "O"];
const PRIMARY_LOWER_RIGHT: ToothId[] = ["P", "Q", "R", "S", "T"];

/**
 * Parse a free-text tooth field like "3, 5, 7-10, A-C" into a Set of IDs.
 * Returns an empty set on bad input rather than throwing — the field is
 * user-editable text and we should be tolerant.
 */
export function parseToothField(value: string | null | undefined): Set<ToothId> {
  const out = new Set<ToothId>();
  if (!value) return out;
  for (const rawPart of value.split(/[,\s]+/)) {
    const part = rawPart.trim().toUpperCase();
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((s) => s.trim());
      if (!a || !b) continue;
      const numA = Number(a);
      const numB = Number(b);
      if (Number.isInteger(numA) && Number.isInteger(numB)) {
        const lo = Math.min(numA, numB);
        const hi = Math.max(numA, numB);
        for (let n = lo; n <= hi; n++) {
          if (n >= 1 && n <= 32) out.add(String(n));
        }
        continue;
      }
      // Letter range, e.g. A-C
      if (/^[A-T]$/.test(a) && /^[A-T]$/.test(b)) {
        const lo = Math.min(a.charCodeAt(0), b.charCodeAt(0));
        const hi = Math.max(a.charCodeAt(0), b.charCodeAt(0));
        for (let c = lo; c <= hi; c++) out.add(String.fromCharCode(c));
        continue;
      }
      continue;
    }
    if (/^([1-9]|[12][0-9]|3[0-2])$/.test(part)) {
      out.add(part);
    } else if (/^[A-T]$/.test(part)) {
      out.add(part);
    }
  }
  return out;
}

/**
 * Collapse a Set of tooth IDs into a compact, comma-separated string with
 * ranges (e.g. {1,2,3,5,A,B,C} → "1-3, 5, A-C"). Adult numbers come first,
 * then primary letters; ordering inside each group is numeric / alphabetic.
 */
export function formatToothSet(ids: Set<ToothId>): string {
  const numeric: number[] = [];
  const letters: string[] = [];
  for (const id of ids) {
    if (/^[A-T]$/.test(id)) letters.push(id);
    else {
      const n = Number(id);
      if (Number.isInteger(n) && n >= 1 && n <= 32) numeric.push(n);
    }
  }
  numeric.sort((a, b) => a - b);
  letters.sort();

  function compact<T extends number | string>(
    items: T[],
    next: (v: T) => T,
    eq: (a: T, b: T) => boolean,
  ): string[] {
    const ranges: string[] = [];
    let i = 0;
    while (i < items.length) {
      let j = i;
      while (j + 1 < items.length && eq(items[j + 1], next(items[j]))) j++;
      ranges.push(
        i === j ? String(items[i]) : `${items[i]}-${items[j]}`,
      );
      i = j + 1;
    }
    return ranges;
  }

  const numRanges = compact<number>(
    numeric,
    (v) => v + 1,
    (a, b) => a === b,
  );
  const letterRanges = compact<string>(
    letters,
    (v) => String.fromCharCode(v.charCodeAt(0) + 1),
    (a, b) => a === b,
  );
  return [...numRanges, ...letterRanges].join(", ");
}

interface ToothButtonProps {
  id: ToothId;
  selected: boolean;
  billed: boolean;
  billedTitle?: string;
  primary?: boolean;
  onToggle: (id: ToothId) => void;
}

function ToothButton({
  id,
  selected,
  billed,
  billedTitle,
  primary,
  onToggle,
}: ToothButtonProps) {
  const base =
    "h-7 w-7 text-[11px] rounded-md border font-mono tabular-nums transition-colors flex items-center justify-center select-none";
  const cls = selected
    ? "bg-primary text-primary-foreground border-primary"
    : billed
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25"
      : "bg-secondary text-foreground border-transparent hover:bg-secondary/80";
  const sizeOverride = primary ? "h-6 w-6 text-[10px]" : "";
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      className={`${base} ${sizeOverride} ${cls}`}
      title={billed ? billedTitle ?? `Tooth ${id} — billed` : `Tooth ${id}`}
      aria-pressed={selected}
    >
      {id}
    </button>
  );
}

export interface ToothChartProps {
  /** Free-text tooth field value (e.g. "3, 5-8, A-C"). */
  value: string;
  onChange: (next: string) => void;
  /** Tooth IDs that already have restoration lines on this case. */
  billedTeeth?: Iterable<ToothId>;
  /**
   * Optional: per-tooth restoration descriptions used in the hover
   * tooltip for billed teeth (e.g. "Crown", "Bridge"). When provided,
   * the tooltip lists the existing restoration types so the user knows
   * exactly what is already on the invoice.
   */
  billedTeethTypes?: Map<ToothId, string[]>;
  /**
   * Whether to show the primary-dentition (A–T) row. When unspecified
   * the chart starts collapsed (adult teeth only) and offers an
   * inline toggle so single-arch / pediatric workflows can opt in.
   */
  showPrimary?: boolean;
}

export function ToothChart({
  value,
  onChange,
  billedTeeth,
  billedTeethTypes,
  showPrimary: showPrimaryProp,
}: ToothChartProps) {
  const [showPrimaryState, setShowPrimaryState] = useState(
    showPrimaryProp ?? false,
  );
  const showPrimary =
    showPrimaryProp !== undefined ? showPrimaryProp : showPrimaryState;
  const selected = useMemo(() => parseToothField(value), [value]);
  const billed = useMemo(
    () => new Set<ToothId>(billedTeeth ? Array.from(billedTeeth) : []),
    [billedTeeth],
  );
  const billedTitleFor = useCallback(
    (id: ToothId) => {
      if (!billed.has(id)) return undefined;
      const types = billedTeethTypes?.get(id) ?? [];
      return types.length > 0
        ? `Tooth ${id} — already billed: ${types.join(", ")}`
        : `Tooth ${id} — already on a restoration line for this case`;
    },
    [billed, billedTeethTypes],
  );

  function toggle(id: ToothId) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(formatToothSet(next));
  }

  function clear() {
    onChange("");
  }

  function ToothRow({
    leftIds,
    rightIds,
    primary,
  }: {
    leftIds: ToothId[];
    rightIds: ToothId[];
    primary?: boolean;
  }) {
    return (
      <div className="flex items-center justify-center gap-1">
        <div className="flex gap-0.5">
          {leftIds.map((id) => (
            <ToothButton
              key={id}
              id={String(id)}
              selected={selected.has(String(id))}
              billed={billed.has(String(id))}
              billedTitle={billedTitleFor(String(id))}
              primary={primary}
              onToggle={toggle}
            />
          ))}
        </div>
        <div className="w-3 border-l border-border h-6 mx-1" aria-hidden />
        <div className="flex gap-0.5">
          {rightIds.map((id) => (
            <ToothButton
              key={id}
              id={String(id)}
              selected={selected.has(String(id))}
              billed={billed.has(String(id))}
              billedTitle={billedTitleFor(String(id))}
              primary={primary}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-md p-3 space-y-2 bg-secondary/20">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Tooth chart
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-primary inline-block" />
            Selected
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/40 border border-emerald-500/50 inline-block" />
            Billed
          </span>
          {showPrimaryProp === undefined && (
            <button
              type="button"
              onClick={() => setShowPrimaryState((v) => !v)}
              className="text-muted-foreground underline hover:text-foreground"
              aria-pressed={showPrimaryState}
              title="Toggle primary (deciduous A–T) teeth row"
            >
              {showPrimaryState ? "Hide primary (A–T)" : "Show primary (A–T)"}
            </button>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={clear}
              className="text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Patient's right (1-8) | left (9-16) */}
      <div className="space-y-1">
        <ToothRow leftIds={ADULT_UPPER_RIGHT} rightIds={ADULT_UPPER_LEFT} />
        {showPrimary && (
          <ToothRow
            leftIds={PRIMARY_UPPER_RIGHT}
            rightIds={PRIMARY_UPPER_LEFT}
            primary
          />
        )}
      </div>
      <div className="border-t border-dashed border-border my-1" />
      <div className="space-y-1">
        {showPrimary && (
          <ToothRow
            leftIds={PRIMARY_LOWER_RIGHT.slice().reverse()}
            rightIds={PRIMARY_LOWER_LEFT.slice().reverse()}
            primary
          />
        )}
        {/* Lower row mirrored so the rightmost tooth (32 / T) stays on
            the patient's right, directly under tooth 1. */}
        <ToothRow
          leftIds={ADULT_LOWER_RIGHT.slice().reverse()}
          rightIds={ADULT_LOWER_LEFT.slice().reverse()}
        />
      </div>

      <div className="text-[11px] text-muted-foreground pt-1">
        Click teeth to toggle. Selection is mirrored to the Tooth # field
        above (e.g.{" "}
        <span className="font-mono">{selected.size > 0 ? formatToothSet(selected) : "1-3, 14"}</span>
        ).
      </div>
    </div>
  );
}
