import { useCallback, useMemo, useState } from "react";
import { ToothSilhouette } from "./ToothSilhouette";
import {
  parseConnectorState,
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
//
// Both arches share one center so the teeth form a complete oval. The upper
// arch runs from viewer-left (tooth 1) over the top to viewer-right (tooth 16);
// the lower arch runs from viewer-right (tooth 17) under the bottom to viewer-left
// (tooth 32), matching ADA Universal numbering from the patient's perspective.

const DEG = Math.PI / 180;
const CHART_CX = 260, CHART_CY = 260;
const UPPER_CX = CHART_CX, UPPER_CY = CHART_CY;
const LOWER_CX = CHART_CX, LOWER_CY = CHART_CY;
const ADULT_RX = 188, ADULT_RY = 208;
const PRIMARY_RX = 138, PRIMARY_RY = 154;
const FILL_RX = 158, FILL_RY = 176;

function upperAngleDeg(n: number): number {
  return 170 + (n - 1) * (200 / 15);
}
function lowerAngleDeg(n: number): number {
  return 350 + (n - 17) * (200 / 15);
}

function pt(cx: number, cy: number, rx: number, ry: number, angleDeg: number) {
  const a = angleDeg * DEG;
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
}

function adultPos(n: number, rx = ADULT_RX, ry = ADULT_RY) {
  if (n <= 16) return pt(UPPER_CX, UPPER_CY, rx, ry, upperAngleDeg(n));
  return pt(LOWER_CX, LOWER_CY, rx, ry, lowerAngleDeg(n));
}

// Primary upper: A–J, viewer-left to viewer-right over the upper inner arch.
const UPPER_PRIMARY = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
// Primary lower viewer order (left→right): T,S,R,Q,P,O,N,M,L,K
//   T (patient-right) sits on viewer-left; K (patient-left) sits viewer-right.
const LOWER_PRIMARY_VIEWER = ["T", "S", "R", "Q", "P", "O", "N", "M", "L", "K"];

function upperPrimaryPos(idx: number) {
  const a = 170 + idx * (200 / 9);
  return pt(UPPER_CX, UPPER_CY, PRIMARY_RX, PRIMARY_RY, a);
}
function lowerPrimaryPos(viewerIdx: number) {
  const a = 190 - viewerIdx * (200 / 9);
  return pt(LOWER_CX, LOWER_CY, PRIMARY_RX, PRIMARY_RY, a);
}

function toothRotationDeg(n: number): number {
  const angle = n <= 16 ? upperAngleDeg(n) : lowerAngleDeg(n);
  return ((angle - 90) % 360 + 360) % 360;
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
  onToggle: (id: ToothId) => void;
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
      onClick={() => onToggle(id)}
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
  suggested?: boolean;
  readOnly?: boolean;
  onToggle: (key: string) => void;
}

function SvgConnectorDot({ x, y, pairKey, active, disabled, suggested, readOnly, onToggle }: DotProps) {
  const fill = active ? "rgb(16,185,129)" : "transparent";
  const stroke = active ? (suggested ? "rgb(217,119,6)" : "rgb(16,185,129)") : "rgba(107,114,128,0.35)";
  const label = disabled
    ? `Connector between teeth ${pairKey.replace("-", " and ")} unavailable; assign both teeth first`
    : active
      ? `${suggested ? "Suggested" : "Explicit"} connector between teeth ${pairKey.replace("-", " and ")}; activate to disconnect`
      : `Connect teeth ${pairKey.replace("-", " and ")}`;

  if (readOnly) {
    return (
      <g role="img" aria-label={label}>
        {active && <title>Bridge connector</title>}
        <circle cx={x} cy={y} r={3.5} fill={fill} stroke={stroke} strokeWidth={1} />
      </g>
    );
  }

  return (
    <g
      onClick={() => !disabled && onToggle(pairKey)}
      style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.35 : 1 }}
      role="button"
      aria-pressed={active}
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onToggle(pairKey);
        }
      }}
      className="hover:opacity-80 transition-opacity"
    >
      <title>{label}</title>
      <circle cx={x} cy={y} r={8} fill="transparent" />
      <circle cx={x} cy={y} r={3.5} fill={fill} stroke={stroke} strokeWidth={1} />
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
  onToothClick?: (toothId: ToothId) => void;
  /**
   * Set of normalised connector pair keys (e.g. "13-14") for bridge spans.
   */
  connectedPairs?: Set<string>;
  /** Active connectors that are suggestions rather than user-confirmed edges. */
  connectorSuggestions?: Set<string>;
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
  connectorIssue,
  summaryText,
  onConnectedPairsChange,
  crownTeeth,
  ponticTeeth,
  missingTeeth,
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

  function toothTypeFor(id: string): "crown" | "pontic" | "missing" | undefined {
    if (missingTeeth?.has(id)) return "missing";
    if (ponticTeeth?.has(id)) return "pontic";
    if (crownTeeth?.has(id)) return "crown";
    return undefined;
  }

  const hasCrownTeeth = (crownTeeth?.size ?? 0) > 0;
  const hasPonticTeeth = (ponticTeeth?.size ?? 0) > 0;
  const hasMissingTeeth = (missingTeeth?.size ?? 0) > 0;
  const hasTypedTeeth = hasCrownTeeth || hasPonticTeeth || hasMissingTeeth;

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

  // Pre-compute positions for adult teeth (1–32)
  const adultPositions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    for (let n = 1; n <= 32; n++) map.set(n, adultPos(n));
    return map;
  }, []);

  // Groups of adult teeth for connector-dot adjacency (no midline connector)
  const adultGroups: number[][] = [
    Array.from({ length: 16 }, (_, i) => i + 1),
    Array.from({ length: 16 }, (_, i) => i + 17),
  ];

  // Arch background path: M start A rx ry 0 largeArc sweep end
  // Upper: tooth 1 → tooth 16, through top (270°) → clockwise, small arc (150° < 180°)
  const pos1 = adultPos(1, FILL_RX, FILL_RY);
  const pos16 = adultPos(16, FILL_RX, FILL_RY);
  const upperFillPath = `M ${pos1.x.toFixed(1)} ${pos1.y.toFixed(1)} A ${FILL_RX} ${FILL_RY} 0 1 1 ${pos16.x.toFixed(1)} ${pos16.y.toFixed(1)}`;

  // Lower: tooth 32 → tooth 17, through bottom (90°) → counter-clockwise, small arc (150° < 180°)
  const pos17 = adultPos(17, FILL_RX, FILL_RY);
  const pos32 = adultPos(32, FILL_RX, FILL_RY);
  const lowerFillPath = `M ${pos17.x.toFixed(1)} ${pos17.y.toFixed(1)} A ${FILL_RX} ${FILL_RY} 0 1 1 ${pos32.x.toFixed(1)} ${pos32.y.toFixed(1)}`;

  // Arc along the adult-arch ellipse linking tooth n to tooth n+1, used to
  // draw a continuous bridge span. Upper arch sweeps clockwise (flag 1),
  // lower arch counter-clockwise (flag 0), matching the arch fill paths.
  function bridgeArcPath(n: number): string {
    const a = adultPositions.get(n)!;
    const b = adultPositions.get(n + 1)!;
    const sweep = 1;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${ADULT_RX} ${ADULT_RY} 0 0 ${sweep} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  }

  const BADGE_R = 14;
  const PRIMARY_BADGE_R = 11;
  const hasBridgeState = !!onConnectedPairsChange || (connectedPairs?.size ?? 0) > 0;

  return (
    <div className="border border-border rounded-md p-3 space-y-2 bg-secondary/20">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Tooth chart
        </div>
        <div className="flex items-center justify-end gap-x-2.5 gap-y-1 text-[10px] text-muted-foreground flex-wrap">
          <span className="inline-flex items-center gap-1" aria-label="Selected tooth">
            <span className="h-3 w-3 rounded-[4px] border-2 border-primary inline-block" />
            Selected
          </span>
          <span className="inline-flex items-center gap-1" aria-label="Crown tooth">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500 inline-block" />
            Crown
          </span>
          <span className="inline-flex items-center gap-1" aria-label="Pontic tooth">
            <span className="h-3 w-3 rounded-full bg-purple-500 border border-dashed border-purple-400 inline-block" />
            Pontic
          </span>
          <span className="inline-flex items-center gap-1" aria-label="Missing tooth">
            <span className="h-3 w-3 rounded-full bg-muted border border-dashed border-muted-foreground/50 inline-flex items-center justify-center text-[8px] text-muted-foreground font-mono">✕</span>
            Missing
          </span>
          <span className="inline-flex items-center gap-1" aria-label="Billed tooth">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/15 border border-dashed border-emerald-600 inline-block" />
            Billed
          </span>
          {hasBridgeState && (
            <span className="inline-flex items-center gap-1" aria-label="Bridge connector">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
              Bridge
            </span>
          )}
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
        viewBox="0 0 520 520"
        className="mx-auto block w-full"
        role="group"
        aria-label="Dental tooth chart, Universal tooth numbering"
        style={{ maxWidth: 460, maxHeight: 460 }}
      >
        {/* ── Arch background strokes ── */}
        <path
          d={upperFillPath}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={32}
          strokeLinecap="round"
          opacity={0.45}
        />
        <path
          d={lowerFillPath}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={32}
          strokeLinecap="round"
          opacity={0.45}
        />

        {/* ── Arch labels ── */}
        <text
          x={UPPER_CX}
          y={UPPER_CY - 9}
          textAnchor="middle"
          fontSize={9}
          fill="hsl(var(--muted-foreground))"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          opacity={0.6}
        >
          UPPER
        </text>
        <text
          x={LOWER_CX}
          y={LOWER_CY + 14}
          textAnchor="middle"
          fontSize={9}
          fill="hsl(var(--muted-foreground))"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          opacity={0.6}
        >
          LOWER
        </text>
        <text x="12" y="264" textAnchor="start" fontSize={8} fill="hsl(var(--muted-foreground))">
          PATIENT RIGHT
        </text>
        <text x="508" y="264" textAnchor="end" fontSize={8} fill="hsl(var(--muted-foreground))">
          PATIENT LEFT
        </text>

        {/* ── Bridge span lines (behind badges, both modes) ── */}
        {connectedPairs && connectedPairs.size > 0 &&
          adultGroups.flatMap((group) =>
            group.slice(0, -1).map((n) => {
              const pKey = connectorPairKey(String(n), String(n + 1));
              if (!connectedPairs.has(pKey)) return null;
              return (
                <path
                  key={`bridge-${pKey}`}
                  d={bridgeArcPath(n)}
                  fill="none"
                  stroke={connectorSuggestions?.has(pKey) ? "rgb(217,119,6)" : "rgb(16,185,129)"}
                  strokeWidth={3}
                  strokeLinecap="round"
                  opacity={0.7}
                  style={{ pointerEvents: "none" }}
                />
              );
            }),
          )}

        {/* ── Connector dots for adult teeth ── */}
        {showConnectors &&
          adultGroups.map((group) =>
            group.slice(0, -1).map((n) => {
              const a = adultPositions.get(n)!;
              const b = adultPositions.get(n + 1)!;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              const pKey = connectorPairKey(String(n), String(n + 1));
              const isActive = (connectedPairs ?? new Set()).has(pKey);
              const leftId = String(n);
              const rightId = String(n + 1);
              const isAssigned =
                (crownTeeth?.has(leftId) || ponticTeeth?.has(leftId)) &&
                (crownTeeth?.has(rightId) || ponticTeeth?.has(rightId));
              return (
                <SvgConnectorDot
                  key={`dot-${pKey}`}
                  x={mx}
                  y={my}
                  pairKey={pKey}
                  active={isActive}
                  suggested={connectorSuggestions?.has(pKey)}
                  disabled={!isAssigned && !isActive}
                  readOnly={readOnly}
                  onToggle={toggleConnector}
                />
              );
            }),
          )}

        {/* Read-only connector dots (active pairs only) */}
        {readOnly && connectedPairs && connectedPairs.size > 0 &&
          adultGroups.map((group) =>
            group.slice(0, -1).map((n) => {
              const pKey = connectorPairKey(String(n), String(n + 1));
              const isActive = connectedPairs.has(pKey);
              if (!isActive) return null;
              const a = adultPositions.get(n)!;
              const b = adultPositions.get(n + 1)!;
              return (
                <SvgConnectorDot
                  key={`dot-ro-${pKey}`}
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2}
                  pairKey={pKey}
                  active
                  readOnly
                  onToggle={toggleConnector}
                />
              );
            }),
          )}

        {/* ── Primary teeth (inner ring) ── */}
        {showPrimary && (
          <>
            {UPPER_PRIMARY.map((id, i) => {
              const { x, y } = upperPrimaryPos(i);
              return (
                <SvgBadge
                  key={id}
                  id={id}
                  x={x}
                  y={y}
                  r={PRIMARY_BADGE_R}
                  selected={selected.has(id)}
                  billed={billed.has(id)}
                  billedTitle={billedTitleFor(id)}
                  readOnly={readOnly}
                  toothType={toothTypeFor(id)}
                  onToggle={toggle}
                />
              );
            })}
            {LOWER_PRIMARY_VIEWER.map((id, viewerIdx) => {
              const { x, y } = lowerPrimaryPos(viewerIdx);
              return (
                <SvgBadge
                  key={id}
                  id={id}
                  x={x}
                  y={y}
                  r={PRIMARY_BADGE_R}
                  selected={selected.has(id)}
                  billed={billed.has(id)}
                  billedTitle={billedTitleFor(id)}
                  readOnly={readOnly}
                  toothType={toothTypeFor(id)}
                  onToggle={toggle}
                />
              );
            })}
          </>
        )}

        {/* ── Adult teeth (outer ring) ── */}
        {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
          const { x, y } = adultPositions.get(n)!;
          const id = String(n);
          const toothType = toothTypeFor(id);
          return (
            <ToothSilhouette
              key={n}
              toothId={id}
              x={x}
              y={y}
              size={38}
              role={toothType ?? "unassigned"}
              selected={selected.has(id)}
              billed={billed.has(id)}
              rotation={toothRotationDeg(n)}
              onClick={readOnly ? undefined : () => toggle(id)}
              ariaLabel={`${billedTitleFor(id) ?? `Tooth ${id}`}${toothType ? `, ${toothType}` : ""}${selected.has(id) ? ", selected" : ""}`}
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
            <> Amber connectors are suggestions; click one to confirm or disconnect.</>
          )}
          {showConnectors && (
            <>{" "}Click a <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 align-middle mx-0.5" /> dot between teeth to mark a bridge connector.</>
          )}
        </div>
      )}
      {hasTypedTeeth && (
        <div className="text-[11px] text-muted-foreground border-t border-border pt-2" aria-live="polite">
          {crownTeeth?.size ?? 0} prepared crowns · {ponticTeeth?.size ?? 0} pontics ·{" "}
          {(crownTeeth?.size ?? 0) + (ponticTeeth?.size ?? 0)} units ·{" "}
          {connectedPairs?.size ?? 0} connector{connectedPairs?.size === 1 ? "" : "s"}
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
