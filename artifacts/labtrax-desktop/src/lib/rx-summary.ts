import type { CaseRestoration } from "./types";
import { parseToothField, type ToothId } from "@/components/ToothChart";

export type RestorativeBucket =
  | "Crown & Bridge"
  | "Removable"
  | "Appliance"
  | "Other";

export type FullArch = "upper" | "lower" | "both" | null;

export interface RxSummary {
  restorativeType: RestorativeBucket | null;
  materials: string[];
  shades: string[];
  teeth: ToothId[];
  isFullArch: FullArch;
}

const CROWN_BRIDGE = new Set([
  "crown",
  "bridge",
  "veneer",
  "veneers",
  "implant crown",
  "inlay",
  "onlay",
  "crown & bridge",
  "crown and bridge",
  "c&b",
]);
const REMOVABLE = new Set([
  "removable",
  "denture",
  "full denture",
  "partial denture",
  "partial",
  "immediate denture",
  "overdenture",
  "flipper",
]);
const APPLIANCE = new Set([
  "appliance",
  "night guard",
  "nightguard",
  "occlusal guard",
  "retainer",
  "sports guard",
  "snore guard",
  "splint",
  "bleach tray",
  "mouthguard",
]);

export function bucketRestorativeType(
  raw: string | null | undefined,
): RestorativeBucket {
  if (!raw) return "Other";
  const v = raw.trim().toLowerCase();
  if (!v) return "Other";
  if (CROWN_BRIDGE.has(v)) return "Crown & Bridge";
  if (REMOVABLE.has(v)) return "Removable";
  if (APPLIANCE.has(v)) return "Appliance";
  // Substring fallbacks for free-text restoration types
  if (/(crown|bridge|veneer|inlay|onlay)/.test(v)) return "Crown & Bridge";
  if (/(denture|partial|removable|flipper)/.test(v)) return "Removable";
  if (/(guard|retainer|splint|appliance|tray)/.test(v)) return "Appliance";
  return "Other";
}

/**
 * Detect full-arch indicators on a restoration's tooth field.
 * Recognizes "Upper", "Lower", "U/D", "U/P", "L/D", "L/P", "D/", "P/",
 * or an empty tooth field on a removable restoration.
 */
function detectArch(
  toothField: string | null | undefined,
  bucket: RestorativeBucket,
): FullArch {
  const v = (toothField ?? "").trim().toLowerCase();
  if (!v) {
    return bucket === "Removable" ? "both" : null;
  }
  // Strip optional "arch" suffix and punctuation
  const norm = v.replace(/\barch\b/g, "").trim();
  if (/^(upper|max|maxillary|u\/?[dp]?|u-?[dp]?)\b/.test(norm)) return "upper";
  if (/^(lower|mand|mandibular|l\/?[dp]?|l-?[dp]?)\b/.test(norm)) return "lower";
  if (/^(both|full|f\/?[dp]?|fd|fp)\b/.test(norm)) return "both";
  // "D/" or "P/" alone on a removable → unknown arch; treat as both
  if (bucket === "Removable" && /^[dp]\//.test(norm)) return "both";
  return null;
}

function mergeArch(a: FullArch, b: FullArch): FullArch {
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  return "both";
}

export function deriveRxSummary(
  restorations: ReadonlyArray<CaseRestoration> | undefined | null,
): RxSummary {
  const empty: RxSummary = {
    restorativeType: null,
    materials: [],
    shades: [],
    teeth: [],
    isFullArch: null,
  };
  if (!restorations || restorations.length === 0) return empty;

  const buckets = new Set<RestorativeBucket>();
  const materials = new Set<string>();
  const shades = new Set<string>();
  const teethSet = new Set<ToothId>();
  let arch: FullArch = null;

  for (const r of restorations) {
    const bucket = bucketRestorativeType(r.restorationType);
    buckets.add(bucket);
    if (r.material && r.material.trim()) materials.add(r.material.trim());
    if (r.shade && r.shade.trim()) shades.add(r.shade.trim());
    const detected = detectArch(r.toothNumber, bucket);
    arch = mergeArch(arch, detected);
    if (!detected) {
      for (const id of parseToothField(r.toothNumber)) teethSet.add(id);
    }
  }

  // Pick the dominant bucket: prefer Crown & Bridge > Removable > Appliance >
  // Other. If multiple buckets show up, we report the most clinically
  // significant one (matches how labs talk about a mixed Rx).
  const order: RestorativeBucket[] = [
    "Crown & Bridge",
    "Removable",
    "Appliance",
    "Other",
  ];
  let restorativeType: RestorativeBucket | null = null;
  for (const b of order) {
    if (buckets.has(b)) {
      restorativeType = b;
      break;
    }
  }

  // Numeric teeth sorted ascending, then primary letters.
  const numeric: number[] = [];
  const letters: string[] = [];
  for (const id of teethSet) {
    if (/^[A-T]$/.test(id)) letters.push(id);
    else {
      const n = Number(id);
      if (Number.isInteger(n)) numeric.push(n);
    }
  }
  numeric.sort((a, b) => a - b);
  letters.sort();
  const teeth: ToothId[] = [
    ...numeric.map((n) => String(n)),
    ...letters,
  ];

  return {
    restorativeType,
    materials: Array.from(materials),
    shades: Array.from(shades),
    teeth,
    isFullArch: arch,
  };
}

/**
 * Human-readable label for the tooth-numbers field on the Rx summary.
 */
export function formatRxTeethLabel(summary: RxSummary): string {
  if (summary.isFullArch === "upper") return "Upper arch";
  if (summary.isFullArch === "lower") return "Lower arch";
  if (summary.isFullArch === "both") return "Full arch (upper & lower)";
  if (summary.teeth.length === 0) return "—";
  return summary.teeth.join(", ");
}

/**
 * Build a ToothChart `value` string that highlights every tooth covered by
 * the Rx summary — both individual teeth and any full arches.
 */
export function buildHighlightedToothValue(summary: RxSummary): string {
  const ids = new Set<ToothId>(summary.teeth);
  const addRange = (lo: number, hi: number) => {
    for (let n = lo; n <= hi; n++) ids.add(String(n));
  };
  if (summary.isFullArch === "upper" || summary.isFullArch === "both") {
    addRange(1, 16);
  }
  if (summary.isFullArch === "lower" || summary.isFullArch === "both") {
    addRange(17, 32);
  }
  return Array.from(ids).join(",");
}
