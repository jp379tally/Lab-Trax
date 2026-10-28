export interface ToothSilhouetteProps {
  toothId: string;
  x: number;
  y: number;
  size: number;
  role: "unassigned" | "crown" | "pontic" | "missing";
  selected?: boolean;
  billed?: boolean;
  /** Rotates the tooth body radially while keeping its number upright. */
  rotation?: number;
  onClick?: (modifiers?: ToothClickModifiers) => void;
  ariaLabel?: string;
}

export interface ToothClickModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

type ToothForm = "incisor" | "canine" | "premolar" | "molar";

function getToothForm(toothId: string): ToothForm {
  const id = toothId.toUpperCase();
  const number = Number(id);

  if (/^[A-T]$/.test(id)) {
    if (id === "C" || id === "H" || id === "M" || id === "R") return "canine";
    if (["D", "E", "F", "G", "N", "O", "P", "Q"].includes(id)) return "incisor";
    return "molar";
  }
  if (!Number.isInteger(number) || number < 1 || number > 32) return "molar";
  const position = ((number - 1) % 16) + 1;
  if (position === 6 || position === 11) return "canine";
  if (position === 4 || position === 5 || position === 12 || position === 13) return "premolar";
  if (position >= 7 && position <= 10) return "incisor";
  return "molar";
}

const toothPaths: Record<ToothForm, string> = {
  incisor:
    "M9 8 C12 4 18 3 24 4 C30 3 36 5 39 9 C41 12 39 19 37 26 L35 42 C34 49 30 53 25 54 C23 51 22 48 21 44 C20 49 19 52 17 54 C12 52 10 48 11 42 L10 26 C8 19 7 12 9 8 Z",
  canine:
    "M8 10 C12 5 18 5 23 8 L24 4 L26 8 C32 5 37 6 40 11 C42 16 37 25 34 35 L29 48 C27 53 25 56 23 56 C21 53 19 49 17 44 L11 30 C8 22 5 15 8 10 Z",
  premolar:
    "M7 11 C10 7 15 6 19 8 C21 9 22 12 24 14 C26 11 27 8 30 7 C35 5 40 8 42 13 C43 18 39 23 36 28 C34 34 35 43 31 49 C28 53 25 52 23 49 C21 52 17 53 14 50 C9 46 11 37 9 30 C7 23 4 16 7 11 Z",
  molar:
    "M6 13 C8 7 15 5 20 8 C22 9 23 12 24 14 C26 11 28 8 32 7 C38 6 42 10 42 16 C42 20 39 23 37 27 C35 31 37 35 37 40 C37 47 33 52 28 51 C26 50 25 47 23 45 C21 48 19 52 15 52 C9 52 6 47 7 41 C8 36 10 32 8 27 C6 22 4 18 6 13 Z",
};

const cuspDetails: Record<ToothForm, string> = {
  incisor: "M12 10 C16 7 20 8 24 9 C28 8 32 7 36 10 M14 17 C18 20 20 21 24 21 C28 21 31 19 34 17 M17 24 C19 28 19 31 18 35 M31 24 C29 28 29 31 30 35",
  canine: "M12 12 C16 8 20 9 24 12 C28 9 32 8 36 12 M15 20 C19 18 21 18 24 21 C27 18 30 18 33 20 M18 26 C20 31 21 35 23 39",
  premolar: "M11 13 C15 10 19 10 22 15 L24 18 L27 13 C30 10 35 10 38 14 M13 20 C17 18 20 20 23 23 C26 20 30 18 35 20 M17 26 C19 31 19 34 18 37 M31 26 C29 31 29 34 30 37",
  molar: "M10 14 C14 10 19 11 22 16 L24 19 L27 15 C30 11 35 10 39 14 M11 22 C16 19 20 20 23 24 C26 20 31 19 36 22 M16 28 C19 25 21 26 24 29 C27 26 30 25 33 28 M17 35 C19 38 20 41 20 44 M31 35 C29 38 28 41 28 44",
};

export function ToothSilhouette({
  toothId,
  x,
  y,
  size,
  role,
  selected = false,
  billed = false,
  rotation = 0,
  onClick,
  ariaLabel,
}: ToothSilhouetteProps) {
  const form = getToothForm(toothId);
  const interactive = typeof onClick === "function";
  const roleLabel = role === "unassigned" ? "unassigned" : role;
  const label = ariaLabel ?? `Tooth ${toothId}, ${roleLabel}${selected ? ", selected" : ""}`;
  const fill =
    role === "crown"
      ? "#e7e9ff"
      : role === "pontic"
        ? "#fde8f4"
        : role === "missing"
          ? "#e7ecef"
          : "#f7f2e8";
  const accent =
    role === "crown"
      ? "#5145b7"
      : role === "pontic"
        ? "#c02678"
        : role === "missing"
          ? "#87939a"
          : "#b7aa91";
  const width = size * (form === "incisor" || form === "canine" ? 0.82 : 0.9);
  const height = size;

  return (
    <svg
      x={x - width / 2}
      y={y - height / 2}
      width={width}
      height={height}
      viewBox="0 0 48 58"
      overflow="visible"
      role={interactive ? "button" : "img"}
      aria-label={label}
      aria-pressed={interactive ? selected : undefined}
      data-tooth-id={toothId}
      data-tooth-x={x}
      data-tooth-y={y}
      data-tooth-rotation={rotation}
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
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.({ ctrlKey: false, metaKey: false, shiftKey: false });
              }
            }
          : undefined
      }
      style={{ cursor: interactive ? "pointer" : undefined, overflow: "visible" }}
    >
      <style>{`
        .tooth-silhouette-target:focus-visible .tooth-focus-ring {
          opacity: 1;
        }
      `}</style>
      <rect
        className="tooth-focus-ring"
        x="1"
        y="1"
        width="46"
        height="56"
        rx="12"
        fill="none"
        stroke="#0f766e"
        strokeWidth="2"
        opacity={selected ? 1 : 0}
        pointerEvents="none"
      />
      {billed && (
        <path
          d={toothPaths[form]}
          transform={`rotate(${rotation} 24 29) translate(24 29) scale(1.19) translate(-24 -29)`}
          fill="none"
          stroke="#059669"
          strokeWidth="1.8"
          strokeDasharray="2.5 2"
          pointerEvents="none"
        />
      )}
      <g transform={`rotate(${rotation} 24 29)`}>
        {selected && (
          <path
            d={toothPaths[form]}
            transform="translate(24 29) scale(1.16) translate(-24 -29)"
            fill="none"
            stroke="#0f766e"
            strokeWidth="2.6"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}
        {role === "pontic" && (
          <path
            d={toothPaths[form]}
            transform="translate(24 29) scale(1.11) translate(-24 -29)"
            fill="none"
            stroke={accent}
            strokeWidth="1.7"
            strokeDasharray="3 2"
          />
        )}
        <path
          d={toothPaths[form]}
          fill={fill}
          stroke={role === "unassigned" ? "#a99b81" : accent}
          strokeWidth={selected ? 1.5 : 1.15}
          strokeDasharray={role === "missing" ? "3 2" : undefined}
          strokeLinejoin="round"
        />
        {role !== "missing" && (
          <path
            d="M13 12 C15 9 19 9 22 11 M11 15 C10 20 13 24 14 27"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.72"
            pointerEvents="none"
          />
        )}
        {role !== "missing" && (
          <path
            d={cuspDetails[form]}
            fill="none"
            stroke={role === "unassigned" ? "#a99b81" : accent}
            strokeWidth="0.8"
            strokeLinecap="round"
            opacity="0.58"
            pointerEvents="none"
          />
        )}
        {role === "missing" && (
          <path
            d="M18 22 L30 34 M30 22 L18 34"
            fill="none"
            stroke="#6f7c82"
            strokeWidth="1.7"
            strokeLinecap="round"
            pointerEvents="none"
          />
        )}
      </g>
      <text
        x="24"
        y={role === "missing" ? "47" : "30"}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#35434a"
        fontFamily="ui-monospace, 'SFMono-Regular', Consolas, monospace"
        fontSize={toothId.length > 1 ? "9" : "10"}
        fontWeight="700"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {toothId}
      </text>
      {(role === "crown" || role === "pontic") && (
        <g pointerEvents="none">
            <circle cx="38" cy="9" r="6.5" fill={accent} stroke="#fff" strokeWidth=".8" />
          <text
            x="38"
            y="9"
            textAnchor="middle"
            dominantBaseline="central"
            fill="#ffffff"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize="7"
            fontWeight="800"
          >
            {role === "crown" ? "C" : "P"}
          </text>
        </g>
      )}
    </svg>
  );
}
