import { useCallback, useMemo, useState } from "react";
import { ToothSilhouette, type ToothClickModifiers } from "./ToothSilhouette";
import {
  CHART,
  CONNECTOR_HIT_RADIUS,
  CONNECTOR_RADIUS,
  adjacentPairs,
  adultToothGeometry,
  connectorGeometry,
  type ToothRole,
} from "@/lib/tooth-geometry";
import {
  parseConnectorState,
  archSelectionTeeth,
  toothAssignmentSummary,
  type ToothArch,
} from "@workspace/case-taxonomy";

/**
 * Interactive ADA Universal Numbering tooth chart — anatomical arch layout.
 *
 * Adult permanent teeth: 1–32 (1 = upper-right 3rd molar, 16 = upper-left
 * 3rd molar, 17 = lower-left 3rd molar, 32 = lower-right 3rd molar).
 *
 * Primary (deciduous) teeth: A–T (A = upper-right 2nd molar, J = upper-left,
 * K = lower-left 2nd molar, T = lower-right 2nd molar).
 *
 * Arch layout (patient perspective = same as ADA standard):
 *   Upper:  1 (viewer-left, patient-right) .. 16 (viewer-right, patient-left)
 *   Lower: 32 (viewer-left, patient-right) .. 17 (viewer-right, patient-left)
 *
 * Tooth-type colors (used by the Restorations tab):
 *   crown   → blue  (bg-blue-500)
 *   pontic  → purple (bg-purple-500)
 *   missing → muted + ✕ glyph
 */

export type ToothId = string; // "1".."32" or "A".."T"

/**
 * Parse a free-text tooth field like "3, 5, 7-10, A-C" into a Set of IDs.
 * Returns an empty set on bad input rather than throwing.
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
 * ranges (e.g. {1,2,3,5,A,B,C} → "1-3, 5, A-C").
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
 * Normalise a connector pair key: always "<lower>-<higher>".
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
  return parseConnectorState(value).active;
}

/**
 * Serialise a Set of connector pair keys back to a comma-separated string.
 */
export function formatBridgeConnectors(pairs: Set<string>): string {
  return Array.from(pairs).sort().join(",");
}

// ── Arch Geometry ────────────────────────────────────────────────────────────
// Adult tooth layout lives in @/lib/tooth-geometry (shared with native). Only the
// optional primary (A–T) inner ring is laid out here.

const PRIMARY_RX = 84, PRIMARY_RY = 124;

const UPPER_PRIMARY = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const LOWER_PRIMARY_VIEWER = ["T", "S", "R", "Q", "P", "O", "N", "M", "L", "K"];

function primaryPt(cy: number, angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: CHART.cx + PRIMARY_RX * Math.cos(a), y: cy + PRIMARY_RY * Math.sin(a) };
}
function upperPrimaryPos(idx: number) {
  return primaryPt(CHART.upperCy, 190 + idx * (160 / 9));
}
function lowerPrimaryPos(viewerIdx: number) {
  return primaryPt(CHART.lowerCy, 170 - viewerIdx * (160 / 9));
}

// ── SVG sub-components ───────────────────────────────────────────────────────

interface BadgeProps {
  id: ToothId;
  x: number;
  y: number;
  r: number;
  selected: boolean;
  billed: boolean;
  billedTitle?: string;
  readOnly?: boolean;
  toothType?: "crown" | "pontic" | "missing";
  onToggle: (id: ToothId, modifiers?: ToothClickModifiers) => void;
}

function SvgBadge({ id, x, y, r, selected, billed, billedTitle, readOnly, toothType, onToggle }: BadgeProps) {
  const fontSize = r <= 11 ? 7.5 : r <= 13 ? 8.5 : 9.5;
  const strokeW = 1.5;

  let fill: string, stroke: string, textFill: string;
  const label = toothType === "missing" && selected ? "✕" : id;

  if (selected && toothType === "crown") {
    fill = "#3B82F6";
    stroke = "#3B82F6";
    textFill = "#ffffff";
  } else if (selected && toothType === "pontic") {
    fill = "#A855F7";
    stroke = "#A855F7";
    textFill = "#ffffff";
  } else if (selected && toothType === "missing") {
    fill = "hsl(var(--muted))";
    stroke = "rgba(107,114,128,0.4)";
    textFill = "hsl(var(--muted-foreground))";
  } else if (selected) {
    fill = "hsl(var(--primary))";
    stroke = "hsl(var(--primary))";
    textFill = "hsl(var(--primary-foreground))";
  } else if (billed) {
    fill = "rgba(16,185,129,0.15)";
    stroke = "rgba(16,185,129,0.45)";
    textFill = "rgb(6,95,70)";
  } else {
    fill = "hsl(var(--secondary))";
    stroke = "hsl(var(--border))";
    textFill = "hsl(var(--foreground))";
  }

  const isPontic = selected && toothType === "pontic";
  const isMissing = selected && toothType === "missing";

  const typeTitleSuffix =
    isMissing ? " — missing"
    : isPontic ? " — pontic (bridge unit)"
    : toothType === "crown" && selected ? " — crown"
    : "";
  const title = billed
    ? (billedTitle ?? `Tooth ${id} — billed`)
    : `Tooth ${id}${typeTitleSuffix}`;
  const ariaLabel = `Tooth ${id}${
    isMissing ? " (missing)" : isPontic ? " (pontic)" : selected ? " (highlighted)" : ""
  }`;

  const inner = (
    <>
      <title>{title}</title>
      {!readOnly && (
        <circle cx={x} cy={y} r={r + 4} fill="transparent" />
      )}
      {/* Pontic: dashed "bridge-link" halo ring around the badge */}
      {isPontic && (
        <circle
          cx={x}
          cy={y}
          r={r + 3}
          fill="none"
          stroke="#A855F7"
          strokeWidth={1.25}
          strokeDasharray="2.5 2"
        />
      )}
      <circle
        cx={x}
        cy={y}
        r={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeW}
        strokeDasharray={isMissing ? "2.5 2" : undefined}
      />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight="700"
        fill={textFill}
        fontFamily="ui-monospace, 'Courier New', monospace"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {label}
      </text>
    </>
  );

  if (readOnly) {
    return (
      <g aria-label={ariaLabel}>
        {inner}
      </g>
    );
  }

  return (
    <g
      onClick={(event) => onToggle(id, {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      })}
      style={{ cursor: "pointer" }}
      role="button"
      aria-pressed={selected}
      aria-label={ariaLabel}
      className="hover:opacity-80 transition-opacity"
    >
      {inner}
    </g>
  );
}

interface DotProps {
  x: number;
  y: number;
  pairKey: string;
  active: boolean;
  disabled?: boolean;
  blocked?: boolean;
  suggested?: boolean;
  readOnly?: boolean;
  onToggle: (key: string) => void;
}

function SvgConnectorDot({ x, y, pairKey, active, disabled, blocked, suggested, readOnly, onToggle }: DotProps) {
  const color = blocked ? "#DC2626" : active ? "#22C55E" : "#15803D";
  const words = pairKey.replace("-", " and ");
  const label = blocked
    ? `Connector between teeth ${words} is blocked by incompatible catalog products or materials`
    : disabled
      ? `Connector between teeth ${words} unavailable; assign both teeth first`
      : active
        ? `${suggested ? "Suggested" : "Explicit"} connector between teeth ${words}; activate to disconnect`
        : `Connect teeth ${words}`;
  const dot = (
    <>
      <circle cx={x} cy={y} r={CONNECTOR_RADIUS + 1.5} fill="#fff" />
      <circle cx={x} cy={y} r={CONNECTOR_RADIUS} fill={active ? color : "#fff"} stroke={color} strokeWidth={1.5} />
      {!active && <path d={`M${x - 2} ${y} L${x + 2} ${y} M${x} ${y - 2} L${x} ${y + 2}`} stroke={color} strokeWidth={1.2} strokeLinecap="round" />}
    </>
  );
  if (readOnly) {
    return (
      <g role="img" aria-label={label} data-connector={pairKey}>
        {active && <title>Bridge connector</title>}
        {dot}
      </g>
    );
  }
  return (
    <g
      onClick={() => !disabled && onToggle(pairKey)}
      style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}
      role="button"
      aria-pressed={active}
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      data-connector={pairKey}
      className="tooth-connector"
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onToggle(pairKey);
        }
      }}
    >
      <title>{label}</title>
      <circle cx={x} cy={y} r={CONNECTOR_HIT_RADIUS} fill="transparent" data-connector-hit="true" />
      <circle className="tooth-connector-ring" cx={x} cy={y} r={CONNECTOR_RADIUS + 6} fill="none" stroke="#2563EB" strokeWidth={2.5} opacity={0} />
      {dot}
    </g>
  );
}

// ── Main component props ─────────────────────────────────────────────────────

export interface ToothChartProps {
  /** Free-text tooth field value (e.g. "3, 5-8, A-C"). */
  value: string;
  onChange: (next: string) => void;
  /** Tooth IDs that already have restoration lines on this case. */
  billedTeeth?: Iterable<ToothId>;
  /**
   * Optional: per-tooth restoration descriptions used in the hover
   * tooltip for billed teeth (e.g. "Crown", "Bridge").
   */
  billedTeethTypes?: Map<ToothId, string[]>;
  /**
   * Whether to show the primary-dentition (A–T) inner ring. When
   * unspecified the chart starts collapsed and offers an inline toggle.
   */
  showPrimary?: boolean;
  /**
   * When true, the chart renders as a non-interactive view.
   */
  readOnly?: boolean;
  /**
   * When provided, clicking a tooth calls this instead of the default
   * toggle. Used by the Restorations tab to open a guided dialog.
   */
  onToothClick?: (toothId: ToothId, modifiers?: ToothClickModifiers) => void;
  /**
   * Set of normalised connector pair keys (e.g. "13-14") for bridge spans.
   */
  connectedPairs?: Set<string>;
  /** Active connectors that are suggestions rather than user-confirmed edges. */
  connectorSuggestions?: Set<string>;
  /** Adjacent assigned pairs that cannot connect because their catalog products differ. */
  blockedConnectorPairs?: Set<string>;
  /** Visible warning for unresolved or incompatible connector edges. */
  connectorIssue?: string | null;
  summaryText?: string;
  /**
   * Called when the user toggles a connector dot.
   */
  onConnectedPairsChange?: (pairs: Set<string>) => void;
  /** Teeth with a crown/restoration — rendered blue. */
  crownTeeth?: Set<ToothId>;
  /** Teeth marked as pontic — rendered purple. */
  ponticTeeth?: Set<ToothId>;
  /** Teeth marked as missing — rendered with ✕ glyph instead of number. */
  missingTeeth?: Set<ToothId>;
  /** Teeth with a veneer — rendered teal with a V badge. */
  veneerTeeth?: Set<ToothId>;
  /** Actual case assignments, shown as per-assignment cards between the arches. */
  assignments?: ChartAssignment[];
  /** Upper/Lower buttons between the arches call this with the 16 teeth of that arch. */
  onArchSelect?: (arch: ToothArch, teeth: string[]) => void;
}

export interface ChartAssignment {
  toothNumber: string;
  restorationType: string;
  material?: string | null;
  shade?: string | null;
  arch?: string | null;
  quantity?: number | null;
}

const ROLE_SWATCH: Record<string, string> = { crown: "#9628BE", pontic: "#70162E", veneer: "#1E8CA0", missing: "#9CA3AF" };
function swatchFor(type: string) {
  if (/pontic/i.test(type)) return ROLE_SWATCH.pontic;
  if (/veneer/i.test(type)) return ROLE_SWATCH.veneer;
  if (/missing/i.test(type)) return ROLE_SWATCH.missing;
  return ROLE_SWATCH.crown;
}

// ── ToothChart ───────────────────────────────────────────────────────────────

export function ToothChart({
  value,
  onChange,
  billedTeeth,
  billedTeethTypes,
  showPrimary: showPrimaryProp,
  readOnly,
  onToothClick,
  connectedPairs,
  connectorSuggestions,
  blockedConnectorPairs,
  connectorIssue,
  summaryText,
  onConnectedPairsChange,
  crownTeeth,
  ponticTeeth,
  missingTeeth,
  veneerTeeth,
  assignments,
  onArchSelect,
}: ToothChartProps) {
  const [showPrimaryState, setShowPrimaryState] = useState(showPrimaryProp ?? false);
  const showPrimary = showPrimaryProp !== undefined ? showPrimaryProp : showPrimaryState;
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

  function toothTypeFor(id: string): "crown" | "pontic" | "veneer" | "missing" | undefined {
    if (missingTeeth?.has(id)) return "missing";
    if (ponticTeeth?.has(id)) return "pontic";
    if (crownTeeth?.has(id)) return "crown";
    if (veneerTeeth?.has(id)) return "veneer";
    return undefined;
  }

  const hasCrownTeeth = (crownTeeth?.size ?? 0) > 0;
  const hasPonticTeeth = (ponticTeeth?.size ?? 0) > 0;
  const hasMissingTeeth = (missingTeeth?.size ?? 0) > 0;
  const hasTypedTeeth = hasCrownTeeth || hasPonticTeeth || hasMissingTeeth || (veneerTeeth?.size ?? 0) > 0;

  function toggle(id: ToothId, modifiers?: ToothClickModifiers) {
    if (onToothClick) {
      onToothClick(id, modifiers);
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

  const PRIMARY_BADGE_R = 11;
  const bridgeGroups = useMemo(() => {
    const neighbors = new Map<string, Set<string>>();
    for (const [a, b] of adjacentPairs()) {
      const left = String(a), right = String(b);
      if (!connectedPairs?.has(`${a}-${b}`) ||
          !(crownTeeth?.has(left) || ponticTeeth?.has(left)) ||
          !(crownTeeth?.has(right) || ponticTeeth?.has(right))) continue;
      if (!neighbors.has(left)) neighbors.set(left, new Set());
      if (!neighbors.has(right)) neighbors.set(right, new Set());
      neighbors.get(left)!.add(right);
      neighbors.get(right)!.add(left);
    }
    const groups: string[][] = [];
    const visited = new Set<string>();
    for (const start of neighbors.keys()) {
      if (visited.has(start)) continue;
      const members: string[] = [];
      const queue = [start];
      while (queue.length) {
        const tooth = queue.pop()!;
        if (visited.has(tooth)) continue;
        visited.add(tooth);
        members.push(tooth);
        for (const next of neighbors.get(tooth) ?? []) queue.push(next);
      }
      groups.push(members.sort((a, b) => Number(a) - Number(b)));
    }
    return groups.sort((a, b) => Number(a[0]) - Number(b[0]));
  }, [connectedPairs, crownTeeth, ponticTeeth]);
  const bridgeCount = bridgeGroups.length;
  const assignmentTotals = assignments ? toothAssignmentSummary(assignments) : null;
  const hudCards = useMemo(() => {
    if (assignments?.length) {
      const cards = assignments.map((a, i) => ({ key: `a${i}-${a.toothNumber}-${a.restorationType}`, ref: a.toothNumber, type: a.restorationType, material: a.material, shade: a.shade, arch: a.arch, qty: a.quantity }));
      // Missing statuses are not billed assignments, so add any the caller's list omitted.
      for (const id of Array.from(missingTeeth ?? []).sort((x, y) => Number(x) - Number(y))) {
        if (!cards.some((c) => /missing/i.test(c.type) && c.ref.split(/[,\s]+/).includes(id))) cards.push({ key: `Missing-${id}`, ref: id, type: "Missing", material: null, shade: null, arch: null, qty: null });
      }
      return cards;
    }
    const out: Array<{ key: string; ref: string; type: string; material?: string | null; shade?: string | null; arch?: string | null; qty?: number | null }> = [];
    for (const [set, type] of [[crownTeeth, "Crown"], [ponticTeeth, "Pontic"], [veneerTeeth, "Veneer"], [missingTeeth, "Missing"]] as const) {
      for (const id of Array.from(set ?? []).sort((a, b) => Number(a) - Number(b))) out.push({ key: `${type}-${id}`, ref: id, type });
    }
    return out;
  }, [assignments, missingTeeth, crownTeeth, ponticTeeth, veneerTeeth, missingTeeth]);
  const archAllSelected = (arch: ToothArch) => archSelectionTeeth(arch).every((t) => selected.has(t));

  return (
    <div className="tooth-chart-shell space-y-1.5 rounded-xl border border-slate-200 bg-white p-1 shadow-sm sm:p-2">
      {/* Header row */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-slate-800">Tooth chart</h3>
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">Universal numbering</span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[10px] text-slate-600">
          {!readOnly && showPrimaryProp === undefined && (
            <button
              type="button"
              onClick={() => setShowPrimaryState((v) => !v)}
              className="text-muted-foreground underline hover:text-foreground"
              aria-pressed={showPrimaryState}
              title="Toggle primary (deciduous A–T) teeth ring"
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

      {/* SVG arch chart */}
      <svg
        viewBox="0 -14 400 514"
        className="tooth-chart-svg mx-auto block w-full"
        role="group"
        aria-label="Dental tooth chart, Universal tooth numbering"
        style={{ maxWidth: 430, maxHeight: "min(60vh, 520px)" }}
      >
        <style>{`
          .tooth-silhouette-target:focus { outline: none; }
          .tooth-silhouette-target:focus-visible .tooth-focus-ring { opacity: 1; }
          .tooth-silhouette-target:hover .tooth-focus-ring { opacity: .35; }
          .tooth-connector:focus { outline: none; }
          .tooth-connector:focus-visible .tooth-connector-ring { opacity: 1; }
        `}</style>
        <rect x="2" y="-12" width="396" height="510" rx="22" fill="#ffffff" />
        <text x="8" y="16" textAnchor="start" fontSize={10} fontWeight="700" fill="#6B6556">PATIENT RIGHT</text>
        <text x="392" y="16" textAnchor="end" fontSize={10} fontWeight="700" fill="#6B6556">PATIENT LEFT</text>

        {/* Primary teeth (inner ring) */}
        {showPrimary && (
          <>
            {UPPER_PRIMARY.map((id, i) => {
              const { x, y } = upperPrimaryPos(i);
              return (
                <SvgBadge key={id} id={id} x={x} y={y} r={PRIMARY_BADGE_R}
                  selected={selected.has(id)} billed={billed.has(id)} billedTitle={billedTitleFor(id)}
                  readOnly={readOnly} toothType={toothTypeFor(id) as "crown" | "pontic" | "missing" | undefined}
                  onToggle={toggle} />
              );
            })}
            {LOWER_PRIMARY_VIEWER.map((id, viewerIdx) => {
              const { x, y } = lowerPrimaryPos(viewerIdx);
              return (
                <SvgBadge key={id} id={id} x={x} y={y} r={PRIMARY_BADGE_R}
                  selected={selected.has(id)} billed={billed.has(id)} billedTitle={billedTitleFor(id)}
                  readOnly={readOnly} toothType={toothTypeFor(id) as "crown" | "pontic" | "missing" | undefined}
                  onToggle={toggle} />
              );
            })}
          </>
        )}

        {/* Adult teeth */}
        {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
          const g = adultToothGeometry(n);
          const id = String(n);
          const toothType = toothTypeFor(id);
          const role: ToothRole = toothType ?? "unassigned";
          return (
            <ToothSilhouette
              key={n}
              toothId={id}
              x={g.x}
              y={g.y}
              role={role}
              selected={selected.has(id)}
              billed={billed.has(id)}
              rotation={g.rotation}
              nx={g.nx}
              ny={g.ny}
              onClick={readOnly ? undefined : (modifiers) => toggle(id, modifiers)}
              ariaLabel={`${billedTitleFor(id) ?? `Tooth ${id}`}${toothType ? `, ${toothType}` : ""}${selected.has(id) ? ", selected" : ""}`}
            />
          );
        })}

        {/* Live legend / HUD between the arches, inside the chart */}
        <foreignObject x={112} y={96} width={176} height={310} data-chart-hud="true">
          <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4, fontFamily: "inherit", color: "#1F2937" }}>
            {onArchSelect && !readOnly ? (
              <button type="button" aria-label="Select upper arch" aria-pressed={archAllSelected("upper")}
                onClick={() => onArchSelect("upper", archSelectionTeeth("upper"))}
                style={{ minHeight: 24, borderRadius: 6, border: "1.5px solid " + (archAllSelected("upper") ? "#0B1F3A" : "#94A3B8"), background: archAllSelected("upper") ? "#0B1F3A" : "#F8FAFC", color: archAllSelected("upper") ? "#fff" : "#334155", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
                UPPER
              </button>
            ) : <div style={{ textAlign: "center", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "#6B6556" }}>UPPER</div>}
            {hasTypedTeeth || hudCards.length > 0 ? (
              <div aria-label="Restoration totals" className="grid grid-cols-2 gap-[3px] sm:grid-cols-4">
                {([["Units", assignmentTotals?.units ?? (crownTeeth?.size ?? 0) + (ponticTeeth?.size ?? 0) + (veneerTeeth?.size ?? 0), "#E0F2FE"], ["Crowns", assignmentTotals?.crowns ?? crownTeeth?.size ?? 0, "#F3E8FF"], ["Pontics", assignmentTotals?.pontics ?? ponticTeeth?.size ?? 0, "#F5DDE4"], ["Bridges", bridgeCount, "#DCFCE7"]] as const).map(([label, v, bg]) => (
                  <div key={label} style={{ background: bg, borderRadius: 4, textAlign: "center", lineHeight: 1, padding: "3px 0" }}>
                    <span className="block text-[18px] font-bold sm:text-[12px]">{v}</span>
                    <span className="text-[15px] font-semibold sm:text-[7.5px]">{label}</span>
                  </div>
                ))}
              </div>
            ) : <div style={{ textAlign: "center", fontSize: 9, color: "#64748B" }}>No teeth assigned</div>}
            {bridgeGroups.length > 0 && (
              <div style={{ fontSize: 8.5, lineHeight: 1.25, color: "#166534", fontWeight: 600 }}>
                {bridgeGroups.map((g, i) => <div key={g.join("-")}>Bridge {i + 1}: {g.map((t) => "#" + t).join(" ")}</div>)}
              </div>
            )}
            <div role="list" aria-label="Assignments" tabIndex={0} style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
              {hudCards.map((card) => (
                <div role="listitem" key={card.key} data-hud-card={card.ref} className="text-[18px] sm:text-[8.5px]" style={{ border: "1px solid #CBD5E1", borderRadius: 5, background: "#fff", padding: "2px 5px", lineHeight: 1.25 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 700 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: swatchFor(card.type), display: "inline-block" }} />
                    {card.arch && !card.ref
                      ? `${card.arch === "upper" ? "Upper" : card.arch === "lower" ? "Lower" : card.arch} arch`
                      : /^\d+$/.test(card.ref) || /^[A-T]$/.test(card.ref) ? "#" + card.ref : card.ref}
                    {card.qty && card.qty > 1 ? " x" + card.qty : ""}
                  </div>
                  <div>Type: {card.type}</div>
                  {card.material ? <div>Material: {card.material}</div> : null}
                  {card.shade ? <div>Shade: {card.shade}</div> : null}
                </div>
              ))}
            </div>
            {onArchSelect && !readOnly ? (
              <button type="button" aria-label="Select lower arch" aria-pressed={archAllSelected("lower")}
                onClick={() => onArchSelect("lower", archSelectionTeeth("lower"))}
                style={{ minHeight: 24, borderRadius: 6, border: "1.5px solid " + (archAllSelected("lower") ? "#0B1F3A" : "#94A3B8"), background: archAllSelected("lower") ? "#0B1F3A" : "#F8FAFC", color: archAllSelected("lower") ? "#fff" : "#334155", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
                LOWER
              </button>
            ) : <div style={{ textAlign: "center", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "#6B6556" }}>LOWER</div>}
          </div>
        </foreignObject>

        {/* Bridge spans: over the teeth, linking contact markers */}
        {adjacentPairs().map(([a, b]) => {
          const pKey = connectorPairKey(String(a), String(b));
          if (!connectedPairs?.has(pKey)) return null;
          const c = connectorGeometry(a, b);
          const nextKey = connectorPairKey(String(b), String(b + 1));
          if (b === 16 || b === 32 || !connectedPairs.has(nextKey)) return null;
          const next = connectorGeometry(b, b + 1);
          return (
            <path
              key={`bridge-${pKey}`}
              d={`M ${c.x} ${c.y} L ${next.x} ${next.y}`}
              fill="none"
              stroke="#16A34A"
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={0.95}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {/* Connectors: at tooth contacts, drawn last so their 30px targets win */}
        {adjacentPairs().map(([a, b]) => {
          const pKey = connectorPairKey(String(a), String(b));
          const isActive = connectedPairs?.has(pKey) ?? false;
          const leftId = String(a);
          const rightId = String(b);
          const isAssigned =
            (crownTeeth?.has(leftId) || ponticTeeth?.has(leftId)) &&
            (crownTeeth?.has(rightId) || ponticTeeth?.has(rightId));
          if (!isActive && !(showConnectors && isAssigned)) return null;
          const isBlocked = blockedConnectorPairs?.has(pKey) ?? false;
          const c = connectorGeometry(a, b);
          return (
            <SvgConnectorDot
              key={`dot-${pKey}`}
              x={c.x}
              y={c.y}
              pairKey={pKey}
              active={isActive}
              suggested={connectorSuggestions?.has(pKey)}
              disabled={(!isAssigned && !isActive) || (isBlocked && !isActive)}
              blocked={isBlocked}
              readOnly={!showConnectors}
              onToggle={toggleConnector}
            />
          );
        })}
      </svg>

      {/* Footer hint text */}
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
          {connectorSuggestions && connectorSuggestions.size > 0 && (
            <> Dashed green connectors are automatic suggestions; click one to disconnect.</>
          )}
          {showConnectors && (
            <>{" "}Click a <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 align-middle mx-0.5" /> dot between teeth to mark a bridge connector.</>
          )}
        </div>
      )}
      {summaryText && <p className="text-xs text-muted-foreground" role="status">{summaryText}</p>}
      {!readOnly && onToothClick && <details className="text-xs">
        <summary className="min-h-11 flex items-center cursor-pointer">Large tooth and connector controls</summary>
        <div className="flex flex-wrap gap-1.5">
          {[...Array.from({ length: 16 }, (_, index) => index + 1), ...Array.from({ length: 16 }, (_, index) => 32 - index)].map((tooth) => (
            <button key={tooth} type="button" className="min-w-11 min-h-11 border rounded-lg"
              aria-label={`Edit tooth ${tooth}, ${tooth <= 16 ? "upper" : "lower"}`} onClick={() => onToothClick(String(tooth))}>#{tooth}</button>
          ))}
          {showConnectors && Array.from({ length: 31 }, (_, index) => index + 1).filter((tooth) => tooth !== 16).map((tooth) => {
            const pair = `${tooth}-${tooth + 1}`;
            const assigned = (crownTeeth?.has(String(tooth)) || ponticTeeth?.has(String(tooth))) && (crownTeeth?.has(String(tooth + 1)) || ponticTeeth?.has(String(tooth + 1)));
            if (!assigned && !connectedPairs?.has(pair)) return null;
            return <button key={pair} type="button" className="min-h-11 px-3 border rounded-lg" aria-pressed={!!connectedPairs?.has(pair)}
              onClick={() => { const next = new Set(connectedPairs ?? []); if (next.has(pair)) next.delete(pair); else next.add(pair); onConnectedPairsChange?.(next); }}>
              {connectedPairs?.has(pair) ? "Disconnect" : "Connect"} #{tooth}–#{tooth + 1}
            </button>;
          })}
        </div>
      </details>}
      {connectorIssue && (
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5" role="alert">
          {connectorIssue}
          {showConnectors && <button type="button" className="min-h-11 block underline"
            onClick={() => onConnectedPairsChange?.(new Set())}>Clear connections for review</button>}
        </div>
      )}
    </div>
  );
}
