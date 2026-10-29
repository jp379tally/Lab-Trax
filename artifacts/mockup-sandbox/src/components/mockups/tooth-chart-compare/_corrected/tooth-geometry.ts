/**
 * Shared tooth-chart artwork + layout (pure; no React). Kept byte-identical in
 * labtrax-desktop/src/lib and labtrax/lib so web and native draw the same chart.
 *
 * Portrait oval, ~400x500 canvas. Upper arch is a half ellipse centred on
 * UPPER_CY, lower arch on LOWER_CY, so the arches form one ring with a small
 * occlusal gap. Universal 1-16 runs viewer-left -> viewer-right across the top
 * (1 = patient right), 17-32 runs viewer-right -> viewer-left across the bottom.
 */
export type ToothForm = "incisor" | "canine" | "premolar" | "molar";

export const CHART = {
  width: 400,
  height: 500,
  cx: 200,
  rx: 130,
  ry: 180,
  upperCy: 230,
  lowerCy: 264,
  toothHeight: 44,
} as const;

/** Tangent width of each tooth form (px in the 400-wide canvas). */
export const TOOTH_WIDTH: Record<ToothForm, number> = {
  incisor: 23,
  canine: 26,
  premolar: 29,
  molar: 36,
};

/** Per-position widths (position 1 = third molar .. 8 = central incisor), mirrored across the midline. */
const POSITION_WIDTH = [31, 36, 38, 28, 27, 26, 21, 25];
export function toothWidth(id: string): number {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || n > 32) return TOOTH_WIDTH.molar;
  const p = ((n - 1) % 16) + 1;
  const position = n <= 16 ? p : 17 - p;
  return POSITION_WIDTH[(position <= 8 ? position : 17 - position) - 1];
}

export function toothForm(id: string): ToothForm {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || n > 32) return "molar";
  const p = ((n - 1) % 16) + 1;
  const position = n <= 16 ? p : 17 - p; // mirror lower so 17 -> 16 and 32 -> 1
  if (position === 6 || position === 11) return "canine";
  if ([4, 5, 12, 13].includes(position)) return "premolar";
  if (position >= 7 && position <= 10) return "incisor";
  return "molar";
}

// Unit outlines in a -50..50 box (x = across the arch, y = toward the lingual).
const OUTLINE: Record<ToothForm, string> = {
  incisor: "M-42 -30 C-30 -46 30 -46 42 -30 C48 -10 46 28 36 42 C20 50 -20 50 -36 42 C-46 28 -48 -10 -42 -30 Z",
  canine: "M0 -50 C22 -40 44 -18 44 6 C44 34 24 50 0 50 C-24 50 -44 34 -44 6 C-44 -18 -22 -40 0 -50 Z",
  premolar: "M-44 -14 C-40 -42 -14 -48 0 -38 C14 -48 40 -42 44 -14 C50 14 40 44 0 48 C-40 44 -50 14 -44 -14 Z",
  molar: "M-46 -22 C-46 -44 -20 -50 -4 -42 C10 -50 46 -46 46 -22 C50 4 46 30 36 44 C16 52 -16 52 -36 44 C-48 30 -50 4 -46 -22 Z",
};
const GROOVES: Record<ToothForm, string> = {
  incisor: "M-30 -18 C-10 -26 10 -26 30 -18 M-14 10 C-4 16 4 16 14 10",
  canine: "M0 -36 L0 32 M-24 -2 C-10 8 10 8 24 -2",
  premolar: "M0 -32 C-4 -8 -4 12 0 36 M-28 -2 C-14 4 14 4 28 -2",
  molar: "M-6 -42 C0 -10 0 10 -6 44 M-44 -2 C-14 4 14 4 44 -2 M-28 -26 C-22 -16 -22 -10 -28 -2 M28 -26 C22 -16 22 -10 28 -2",
};

function scalePath(d: string, sx: number, sy: number): string {
  let i = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (num) => {
    const v = Number(num) * (i++ % 2 === 0 ? sx : sy);
    return v.toFixed(2);
  });
}

const pathCache = new Map<string, string>();
/** Pixel-space outline / grooves for a form, optionally enlarged for halos. */
export function toothPath(form: ToothForm, kind: "outline" | "grooves", grow = 1): string {
  const key = `${form}:${kind}:${grow}`;
  let path = pathCache.get(key);
  if (!path) {
    path = scalePath(
      kind === "outline" ? OUTLINE[form] : GROOVES[form],
      (TOOTH_WIDTH[form] / 100) * grow,
      (CHART.toothHeight / 100) * grow,
    );
    pathCache.set(key, path);
  }
  return path;
}

export interface ToothGeometry {
  id: string;
  x: number;
  y: number;
  /** Degrees; body only. Labels and badges are never rotated. */
  rotation: number;
  width: number;
  height: number;
  form: ToothForm;
  /** Unit vector pointing away from the arch centre. */
  nx: number;
  ny: number;
}

function layoutArch(upper: boolean): ToothGeometry[] {
  const cy = upper ? CHART.upperCy : CHART.lowerCy;
  const dir = upper ? 1 : -1;
  const N = 720;
  const thetas: number[] = [];
  const lengths: number[] = [0];
  let px = 0;
  let py = 0;
  for (let k = 0; k <= N; k++) {
    const t = Math.PI + (dir * Math.PI * k) / N;
    const x = CHART.cx + CHART.rx * Math.cos(t);
    const y = cy + CHART.ry * Math.sin(t);
    thetas.push(t);
    if (k > 0) lengths.push(lengths[k - 1] + Math.hypot(x - px, y - py));
    px = x;
    py = y;
  }
  const total = lengths[N];
  const forms = Array.from({ length: 16 }, (_, j) => toothForm(String(upper ? j + 1 : 32 - j)));
  const widths = forms.map((_, j) => toothWidth(String(upper ? j + 1 : 32 - j)));
  const gap = (total - widths.reduce((a, b) => a + b, 0)) / 15;
  let cursor = 0;
  return forms.map((form, j) => {
    const s = cursor + widths[j] / 2;
    cursor += widths[j] + gap;
    let k = 1;
    while (k < N && lengths[k] < s) k++;
    const f = (s - lengths[k - 1]) / Math.max(lengths[k] - lengths[k - 1], 1e-6);
    const t = thetas[k - 1] + (thetas[k] - thetas[k - 1]) * f;
    const x = CHART.cx + CHART.rx * Math.cos(t);
    const y = cy + CHART.ry * Math.sin(t);
    let rot = (Math.atan2(CHART.ry * Math.cos(t) * dir, -CHART.rx * Math.sin(t) * dir) * 180) / Math.PI;
    rot = ((rot % 180) + 180) % 180;
    if (rot > 90) rot -= 180;
    const gx = (x - CHART.cx) / CHART.rx ** 2;
    const gy = (y - cy) / CHART.ry ** 2;
    const gl = Math.hypot(gx, gy) || 1;
    return {
      id: String(upper ? j + 1 : 32 - j),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      rotation: Math.round(rot * 10) / 10,
      width: widths[j],
      height: CHART.toothHeight,
      form,
      nx: gx / gl,
      ny: gy / gl,
    };
  });
}

/**
 * Reference-derived layout: centres are measured from the approved anatomical
 * reference (attached_assets/image_1791902531434.png) and mapped into the 400x500
 * canvas. Sprites keep the reference orientation, so rotation is always 0.
 * Lower arch has 16 points resampled evenly along the reference's 18 lower teeth.
 */
const REF_POS: Record<string, [number, number]> = {"1":[61,236.2],"2":[67.9,198.9],"3":[76.8,158.9],"4":[83.7,122.4],"5":[99.6,89.9],"6":[116.9,62.3],"7":[143.1,40.9],"8":[176.9,30.6],"9":[219.7,30.6],"10":[256.9,40.2],"11":[282.5,62.3],"12":[300.4,89.2],"13":[314.9,121],"14":[324.5,158.2],"15":[334.2,199.6],"16":[339,236.9],"17":[338.3,287.3],"18":[328.5,318.6],"19":[319.6,350.3],"20":[308,381],"21":[289.4,407.8],"22":[272.4,435.9],"23":[247.2,456.6],"24":[216.4,466.7],"25":[183.6,466.9],"26":[152.2,458.6],"27":[126.5,438.4],"28":[110.7,409.5],"29":[94.8,380.8],"30":[83.3,350],"31":[73.3,318.7],"32":[63.7,287.3]};
/** Reference-sized upper teeth; the shorter lower arch uses slightly smaller crops at the same contact spacing. */
export const ATLAS = { cols: 8, rows: 4, cell: 104, size: 62, prefix: "tooth-atlas" } as const;
export function atlasDrawSize(id: string | number) {
  return ATLAS.size * (Number(id) > 16 ? 0.9 : 1);
}
/** Static per-role atlas file name (neutral, crown, pontic, veneer, missing). */
export function atlasFile(role: string) {
  const r = ["crown", "pontic", "veneer", "missing"].includes(role) ? role : "unassigned";
  return `${ATLAS.prefix}-${r}.png`;
}
export function atlasCell(id: string | number) {
  const i = Number(id) - 1;
  return { col: i % ATLAS.cols, row: Math.floor(i / ATLAS.cols) };
}

let table: Map<string, ToothGeometry> | null = null;
export function adultToothGeometry(n: number | string): ToothGeometry {
  if (!table) {
    table = new Map();
    for (let i = 1; i <= 32; i++) {
      const [x, y] = REF_POS[String(i)];
      const dx = x - CHART.cx;
      const dy = y - 262;
      const l = Math.hypot(dx, dy) || 1;
      table.set(String(i), {
        id: String(i), x, y, rotation: 0, width: toothWidth(String(i)) * atlasDrawSize(i) / (52 * ATLAS.size / 54), height: CHART.toothHeight,
        form: toothForm(String(i)), nx: dx / l, ny: dy / l,
      });
    }
  }
  return table.get(String(n))!;
}

/** Adjacent teeth within one arch (16 and 17 are never joined). */
export function adjacentPairs(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let n = 1; n < 32; n++) if (n !== 16) out.push([n, n + 1]);
  return out;
}

export const CONNECTOR_HIT_RADIUS = 15; // 30px target
export const CONNECTOR_RADIUS = 4;

/** Marker sits on the contact point between two neighbours, nudged to the lingual side like the reference. */
export function connectorGeometry(a: number, b: number) {
  const ga = adultToothGeometry(a);
  const gb = adultToothGeometry(b);
  let nx = ga.nx + gb.nx;
  let ny = ga.ny + gb.ny;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l;
  ny /= l;
  const off = -23; // negative = outward, just outside the arch in the gap between neighbours
  return {
    x: (ga.x + gb.x) / 2 - nx * off,
    y: (ga.y + gb.y) / 2 - ny * off,
    ax: ga.x - ga.nx * off,
    ay: ga.y - ga.ny * off,
    bx: gb.x - gb.nx * off,
    by: gb.y - gb.ny * off,
  };
}

export type ToothRole = "unassigned" | "crown" | "pontic" | "veneer" | "missing";
export const ROLE_STYLE: Record<ToothRole, { fill: string; stroke: string; text: string; badge: string | null }> = {
  unassigned: { fill: "#F3E6C9", stroke: "#8F7B52", text: "#2B2417", badge: null },
  crown: { fill: "#9628BE", stroke: "#5B1573", text: "#FFFFFF", badge: "C" },
  pontic: { fill: "#70162E", stroke: "#4A0E1F", text: "#FFFFFF", badge: "P" },
  veneer: { fill: "#0E8FA3", stroke: "#0A5C69", text: "#FFFFFF", badge: "V" },
  missing: { fill: "#E5E7EB", stroke: "#6B7280", text: "#374151", badge: null },
};
export const SELECT_COLOR = "#0B1F3A";
