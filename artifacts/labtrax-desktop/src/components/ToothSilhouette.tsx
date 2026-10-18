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
  onClick?: () => void;
  ariaLabel?: string;
}

type ToothForm = "incisor" | "canine" | "premolar" | "molar";

function getToothForm(toothId: string): ToothForm {
  const id = toothId.toUpperCase();
  const number = Number(id);

  if (/^[A-T]$/.test(id)) {
    if (id === "C" || id === "H" || id === "M" || id === "R") return "canine";
    if (["D", "E", "F", "G", "I"].includes(id)) return "incisor";
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
    "M9 8 C12 4 18 3 24 4 C30 3 36 5 39 9 C41 12 40 20 38 27 L36 43 C35 49 31 52 24 53 C17 52 13 49 12 43 L10 27 C8 19 7 12 9 8 Z",
  canine:
    "M9 9 C12 5 18 4 24 5 C30 4 36 5 39 10 C42 15 38 25 35 34 C32 43 29 49 24 54 C19 49 16 43 13 34 C10 25 6 15 9 9 Z",
  premolar:
    "M8 10 C12 5 18 5 22 7 C26 5 33 5 38 10 C42 15 39 21 36 27 C34 34 34 45 29 50 C26 53 22 52 19 50 C14 47 14 37 11 29 C8 22 5 15 8 10 Z",
  molar:
    "M7 12 C10 6 16 5 21 7 C25 4 31 5 35 8 C41 8 43 14 41 20 C40 26 37 30 37 37 C37 47 33 52 28 51 C25 51 24 48 21 48 C18 48 16 52 12 50 C6 48 7 40 8 34 C8 28 5 22 6 17 C6 15 6 13 7 12 Z",
};

const cuspDetails: Record<ToothForm, string> = {
  incisor: "M13 9 C17 7 20 7 24 8 C28 7 32 8 35 10 M16 17 C18 22 18 27 17 32 M32 17 C30 22 30 27 31 32",
  canine: "M14 10 C18 8 21 9 24 11 C27 9 30 8 34 10 M18 19 C20 25 21 30 24 35 C27 30 28 25 30 19",
  premolar: "M12 12 C16 10 19 11 22 14 C24 11 29 10 34 12 M22 14 C22 20 23 24 24 28 M16 20 C18 24 19 29 19 33 M32 20 C30 24 29 29 29 33",
  molar: "M12 13 C16 10 20 12 22 16 C24 12 29 10 34 13 M22 16 C22 22 23 26 24 30 M14 22 C17 25 18 29 18 33 M34 22 C31 25 30 29 30 33",
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
      ? "#dbeafe"
      : role === "pontic"
        ? "#f3e8ff"
        : role === "missing"
          ? "hsl(var(--muted, 210 20% 92%))"
          : "hsl(var(--secondary, 210 25% 96%))";
  const accent =
    role === "crown"
      ? "#3b82f6"
      : role === "pontic"
        ? "#a855f7"
        : "hsl(var(--border, 214 20% 82%))";
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
      onClick={interactive ? onClick : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
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
        stroke="hsl(var(--ring, 215 80% 55%))"
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
          stroke={role === "missing" ? "hsl(var(--muted-foreground, 215 12% 48%))" : accent}
          strokeWidth={selected ? 1.8 : 1.2}
          strokeDasharray={role === "missing" ? "3 2" : undefined}
          strokeLinejoin="round"
        />
        {role !== "missing" && (
          <path
            d={cuspDetails[form]}
            fill="none"
            stroke={role === "unassigned" ? "hsl(var(--muted-foreground, 215 12% 55%))" : accent}
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
            stroke="hsl(var(--muted-foreground, 215 12% 48%))"
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
        fill="hsl(var(--foreground, 215 25% 18%))"
        fontFamily="ui-monospace, 'SFMono-Regular', Consolas, monospace"
        fontSize={toothId.length > 1 ? "9" : "10"}
        fontWeight="700"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {toothId}
      </text>
      {(role === "crown" || role === "pontic") && (
        <g pointerEvents="none">
          <circle cx="38" cy="9" r="6.5" fill={accent} />
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
