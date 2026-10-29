import { useId } from "react";
import {
  ATLAS,
  CHART,
  ROLE_STYLE,
  SELECT_COLOR,
  atlasCell,
  atlasDrawSize,
  atlasFile,
  toothForm,
  type ToothRole,
} from "./tooth-geometry";

export interface ToothSilhouetteProps {
  toothId: string;
  x: number;
  y: number;
  /** Kept for API compatibility. Sprites keep the reference orientation. */
  size?: number;
  role: ToothRole;
  selected?: boolean;
  billed?: boolean;
  /** Kept for API compatibility; reference sprites are pre-oriented. */
  rotation?: number;
  /** Unit vector pointing away from the arch centre (badge placement). */
  nx?: number;
  ny?: number;
  onClick?: (modifiers?: ToothClickModifiers) => void;
  ariaLabel?: string;
}

export interface ToothClickModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const ATLAS_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/tooth-compare/`;

export function ToothSilhouette({
  toothId,
  x,
  y,
  role,
  selected = false,
  billed = false,
  rotation = 0,
  nx = 0,
  ny = -1,
  onClick,
  ariaLabel,
}: ToothSilhouetteProps) {
  const form = toothForm(toothId);
  const uid = useId().replace(/:/g, "");
  const interactive = typeof onClick === "function";
  const style = ROLE_STYLE[role];
  const label = ariaLabel ?? `Tooth ${toothId}, ${role}${selected ? ", selected" : ""}`;
  const half = CHART.toothHeight / 2;
  const bx = x + nx * (half + 1);
  const by = y + ny * (half + 1);
  const { col, row } = atlasCell(toothId);
  const S = atlasDrawSize(toothId);
  const tinted = role !== "unassigned";

  return (
    <g
      role={interactive ? "button" : "img"}
      aria-label={label}
      aria-pressed={interactive ? selected : undefined}
      data-tooth-id={toothId}
      data-tooth-x={x}
      data-tooth-y={y}
      data-tooth-rotation={rotation}
      data-tooth-form={form}
      data-tooth-role={role}
      data-tooth-selected={selected ? "true" : "false"}
      data-tooth-billed={billed ? "true" : "false"}
      tabIndex={interactive ? 0 : undefined}
      className={interactive ? "tooth-silhouette-target" : undefined}
      onClick={interactive ? (event) => onClick?.({
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      }) : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.({ ctrlKey: false, metaKey: false, shiftKey: false });
        }
      } : undefined}
      style={{ cursor: interactive ? "pointer" : undefined }}
    >
      <defs>
        <filter id={`ring-${uid}`} x="-15%" y="-15%" width="130%" height="130%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="2.4" result="grow" />
          <feFlood floodColor={SELECT_COLOR} result="c" />
          <feComposite in="c" in2="grow" operator="in" result="outline" />
          <feMerge><feMergeNode in="outline" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {/* Enlarged transparent hit area */}
      <circle cx={x} cy={y} r={half + 4} fill="transparent" />
      <ellipse className="tooth-focus-ring" cx={x} cy={y} rx={half + 6} ry={half + 4} fill="none"
        stroke="#2563EB" strokeWidth={2.5} opacity={0} pointerEvents="none" />
      {billed && (
        <circle data-billed-indicator="true" cx={x + 15} cy={y + 15} r={3}
          fill="#059669" stroke="#fff" strokeWidth={1} pointerEvents="none" />
      )}
      <g filter={selected ? `url(#ring-${uid})` : undefined} data-selection-ring={selected ? "true" : undefined}
        opacity={role === "missing" ? 0.7 : 1} pointerEvents="none">
        <svg x={x - S / 2} y={y - S / 2} width={S} height={S}
          viewBox={`${col * ATLAS.cell} ${row * ATLAS.cell} ${ATLAS.cell} ${ATLAS.cell}`}
          overflow="hidden" data-tooth-sprite="true">
          <image href={`${ATLAS_BASE}${atlasFile(role)}`} x={0} y={0} width={ATLAS.cols * ATLAS.cell} height={ATLAS.rows * ATLAS.cell} preserveAspectRatio="none" />
        </svg>
      </g>
      {role === "pontic" && (
        <ellipse cx={x} cy={y} rx={half + 1} ry={half - 1} fill="none" stroke={style.stroke}
          strokeWidth={1.6} strokeDasharray="3 2" pointerEvents="none" />
      )}
      {role === "missing" && (
        <path d={`M${x - 9} ${y - 20} L${x + 9} ${y - 8} M${x + 9} ${y - 20} L${x - 9} ${y - 8}`}
          stroke="#6B7280" strokeWidth={2} strokeLinecap="round" pointerEvents="none" />
      )}
      <text x={x} y={y + (role === "missing" ? 8 : 1)} textAnchor="middle" dominantBaseline="central"
        fill={tinted && role !== "missing" ? "#FFFFFF" : "#1F1A12"}
        stroke={tinted && role !== "missing" ? "rgba(20,10,40,.75)" : "rgba(255,255,255,.9)"}
        strokeWidth={2.6} paintOrder="stroke" strokeLinejoin="round"
        fontFamily="ui-monospace, 'SFMono-Regular', Consolas, monospace"
        fontSize={15} fontWeight="800" data-tooth-number="true"
        style={{ pointerEvents: "none", userSelect: "none" }}>
        {toothId}
      </text>
      {style.badge && (
        <g pointerEvents="none" data-tooth-badge={style.badge}>
          <circle cx={bx} cy={by} r={7.5} fill={style.stroke} stroke="#fff" strokeWidth={1.2} />
          <text x={bx} y={by + 0.5} textAnchor="middle" dominantBaseline="central" fill="#fff"
            fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize={9.5} fontWeight="800">
            {style.badge}
          </text>
        </g>
      )}
    </g>
  );
}
