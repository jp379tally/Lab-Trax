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

/**
 * Normalise a connector pair key: always "<lower>-<higher>" for numeric
 * teeth so storage and lookup are consistent regardless of rendering order.
 */
export function connectorPairKey(a: ToothId, b: ToothId): string {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na < nb ? `${na}-${nb}` : `${nb}-${na}`;
  }
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Parse a comma-separated bridge connector string (e.g. "13-14,14-15") into
 * a Set of normalised pair keys.
 */
export function parseBridgeConnectors(value: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [a, b] = trimmed.split("-").map((s) => s.trim());
    if (a && b) {
      out.add(connectorPairKey(a, b));
    }
  }
  return out;
}

/**
 * Serialise a Set of connector pair keys back to a comma-separated string.
 */
export function formatBridgeConnectors(pairs: Set<string>): string {
  return Array.from(pairs).sort().join(",");
}

interface ToothButtonProps {
  id: ToothId;
  selected: boolean;
  billed: boolean;
  billedTitle?: string;
  primary?: boolean;
  readOnly?: boolean;
  onToggle: (id: ToothId) => void;
}

function ToothButton({
  id,
  selected,
  billed,
  billedTitle,
  primary,
  readOnly,
  onToggle,
}: ToothButtonProps) {
  const base =
    "h-7 w-7 text-[11px] rounded-md border font-mono tabular-nums transition-colors flex items-center justify-center select-none";
  const interactive = !readOnly;
  const cls = selected
    ? "bg-primary text-primary-foreground border-primary"
    : billed
      ? `bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 ${interactive ? "hover:bg-emerald-500/25" : ""}`
      : `bg-secondary text-foreground border-transparent ${interactive ? "hover:bg-secondary/80" : ""}`;
  const sizeOverride = primary ? "h-6 w-6 text-[10px]" : "";
  if (readOnly) {
    return (
      <span
        className={`${base} ${sizeOverride} ${cls} cursor-default`}
        title={billed ? billedTitle ?? `Tooth ${id} — billed` : `Tooth ${id}`}
        aria-label={`Tooth ${id}${selected ? " (highlighted)" : ""}`}
      >
        {id}
      </span>
    );
  }
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

/** Small toggleable connector dot between two adjacent adult teeth. */
function ConnectorDot({
  pairKey,
  active,
  readOnly,
  onToggle,
}: {
  pairKey: string;
  active: boolean;
  readOnly?: boolean;
  onToggle: (key: string) => void;
}) {
  if (readOnly) {
    return (
      <span
        className={`flex-shrink-0 w-2 h-2 rounded-full border ${
          active
            ? "bg-emerald-500 border-emerald-500"
            : "bg-transparent border-muted-foreground/20"
        }`}
        title={active ? "Bridge connector" : undefined}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => onToggle(pairKey)}
      className={`flex-shrink-0 w-2 h-2 rounded-full border transition-colors ${
        active
          ? "bg-emerald-500 border-emerald-500 hover:bg-emerald-600"
          : "bg-transparent border-muted-foreground/30 hover:border-emerald-400 hover:bg-emerald-400/20"
      }`}
      title={active ? "Bridge connector (click to remove)" : "Add bridge connector"}
      aria-pressed={active}
    />
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
  /**
   * When true, the chart renders as a non-interactive view: teeth can be
   * highlighted via `value` but cannot be clicked or cleared. Used by
   * the case Overview tab to preview an Rx without exposing edit
   * controls (editing still happens in the Restorations tab).
   */
  readOnly?: boolean;
  /**
   * When provided, clicking a tooth calls this callback instead of the
   * default toggle behaviour. Used by the Restorations tab to open a
   * guided dialog rather than just toggling a text field.
   */
  onToothClick?: (toothId: ToothId) => void;
  /**
   * Set of normalised connector pair keys (e.g. "13-14") indicating which
   * adjacent tooth pairs are connected as a bridge span. Adult teeth only
   * (1–32). Controlled from the parent form.
   */
  connectedPairs?: Set<string>;
  /**
   * Called when the user toggles a connector dot. Passes the updated set.
   * Only called when `readOnly` is false.
   */
  onConnectedPairsChange?: (pairs: Set<string>) => void;
}

export function ToothChart({
  value,
  onChange,
  billedTeeth,
  billedTeethTypes,
  showPrimary: showPrimaryProp,
  readOnly,
  onToothClick,
  connectedPairs,
  onConnectedPairsChange,
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

  const showConnectors = !readOnly && !!onConnectedPairsChange;

  function toggle(id: ToothId) {
    if (onToothClick) {
      onToothClick(id);
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(formatToothSet(next));
  }

  function toggleConnector(key: string) {
    if (!onConnectedPairsChange) return;
    const next = new Set(connectedPairs ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onConnectedPairsChange(next);
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
    const showDots = showConnectors && !primary;

    function renderTeethWithDots(ids: ToothId[]) {
      if (!showDots || ids.length === 0) {
        return (
          <div className="flex gap-0.5">
            {ids.map((id) => (
              <ToothButton
                key={id}
                id={String(id)}
                selected={selected.has(String(id))}
                billed={billed.has(String(id))}
                billedTitle={billedTitleFor(String(id))}
                primary={primary}
                readOnly={readOnly}
                onToggle={toggle}
              />
            ))}
          </div>
        );
      }
      const elements: React.ReactNode[] = [];
      ids.forEach((id, idx) => {
        elements.push(
          <ToothButton
            key={id}
            id={String(id)}
            selected={selected.has(String(id))}
            billed={billed.has(String(id))}
            billedTitle={billedTitleFor(String(id))}
            primary={primary}
            readOnly={readOnly}
            onToggle={toggle}
          />,
        );
        if (idx < ids.length - 1) {
          const nextId = ids[idx + 1]!;
          const pKey = connectorPairKey(id, nextId);
          const isActive = (connectedPairs ?? new Set()).has(pKey);
          elements.push(
            <ConnectorDot
              key={`dot-${pKey}`}
              pairKey={pKey}
              active={isActive}
              readOnly={readOnly}
              onToggle={toggleConnector}
            />,
          );
        }
      });
      return <div className="flex items-center gap-0.5">{elements}</div>;
    }

    return (
      <div className="flex items-center justify-center gap-1">
        {renderTeethWithDots(leftIds)}
        <div className="w-3 border-l border-border h-6 mx-1" aria-hidden />
        {renderTeethWithDots(rightIds)}
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
          {showConnectors && (
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
              Bridge
            </span>
          )}
          {!readOnly && showPrimaryProp === undefined && (
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
          {!readOnly && selected.size > 0 && !onToothClick && (
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

      {!readOnly && !onToothClick && (
        <div className="text-[11px] text-muted-foreground pt-1">
          Click teeth to toggle. Selection is mirrored to the Tooth # field
          above (e.g.{" "}
          <span className="font-mono">{selected.size > 0 ? formatToothSet(selected) : "1-3, 14"}</span>
          ).
        </div>
      )}
      {!readOnly && onToothClick && (
        <div className="text-[11px] text-muted-foreground pt-1">
          Click a tooth to add, replace, or mark it.
          {showConnectors && (
            <> Click a <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 align-middle mx-0.5" /> dot between teeth to mark a bridge connector.</>
          )}
        </div>
      )}
    </div>
  );
}
