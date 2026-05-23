/**
 * Mobile port of the desktop Rx-summary helpers
 * (`artifacts/labtrax-desktop/src/lib/rx-summary.ts`). The bucketing rules
 * and full-arch detection here are kept in sync with the desktop so the
 * same case renders identically on both platforms.
 *
 * Mobile cases don't carry a structured `restorations[]` array — they
 * have a single `caseType`, `material`, and free-text `toothIndices`
 * field on the LabCase. `caseToRxSummary` adapts that shape into the
 * RxSummary the desktop helpers produce.
 */

import type { LabCase } from "./data";

export type RestorativeBucket =
  | "Crown & Bridge"
  | "Removable"
  | "Appliance"
  | "Other";

export type FullArch = "upper" | "lower" | "both" | null;

export type ToothId = string; // "1".."32" or "A".."T"

export interface RxSummary {
  restorativeType: RestorativeBucket | null;
  materials: string[];
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
  if (/(crown|bridge|veneer|inlay|onlay)/.test(v)) return "Crown & Bridge";
  if (/(denture|partial|removable|flipper)/.test(v)) return "Removable";
  if (/(guard|retainer|splint|appliance|tray)/.test(v)) return "Appliance";
  return "Other";
}

/**
 * Parse a free-text tooth field like "#3, 5, 7-10, A-C" into a Set of IDs.
 * Tolerant of leading "#" and odd whitespace — mobile stores its tooth
 * field as `"#8, #9, #10"`-style strings.
 */
export function parseToothField(
  value: string | null | undefined,
): Set<ToothId> {
  const out = new Set<ToothId>();
  if (!value) return out;
  for (const rawPart of value.split(/[,\s]+/)) {
    const part = rawPart.trim().replace(/^#+/, "").toUpperCase();
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((s) => s.trim().replace(/^#+/, ""));
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

function detectArch(
  toothField: string | null | undefined,
  bucket: RestorativeBucket,
): FullArch {
  const v = (toothField ?? "").trim().toLowerCase();
  if (!v) {
    return bucket === "Removable" ? "both" : null;
  }
  const norm = v.replace(/\barch\b/g, "").trim();
  if (/^(upper|max|maxillary|u\/?[dp]?|u-?[dp]?)\b/.test(norm)) return "upper";
  if (/^(lower|mand|mandibular|l\/?[dp]?|l-?[dp]?)\b/.test(norm)) return "lower";
  if (/^(both|full|f\/?[dp]?|fd|fp)\b/.test(norm)) return "both";
  if (bucket === "Removable" && /^[dp]\//.test(norm)) return "both";
  return null;
}

function mergeArch(a: FullArch, b: FullArch): FullArch {
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  return "both";
}

export interface RestorationLike {
  restorationType: string | null | undefined;
  material?: string | null;
  toothNumber?: string | null;
}

export function deriveRxSummary(
  restorations: ReadonlyArray<RestorationLike> | undefined | null,
): RxSummary {
  const empty: RxSummary = {
    restorativeType: null,
    materials: [],
    teeth: [],
    isFullArch: null,
  };
  if (!restorations || restorations.length === 0) return empty;

  const buckets = new Set<RestorativeBucket>();
  const materials = new Set<string>();
  const teethSet = new Set<ToothId>();
  let arch: FullArch = null;

  for (const r of restorations) {
    const bucket = bucketRestorativeType(r.restorationType);
    buckets.add(bucket);
    if (r.material && r.material.trim()) materials.add(r.material.trim());
    const detected = detectArch(r.toothNumber, bucket);
    arch = mergeArch(arch, detected);
    if (!detected) {
      for (const id of parseToothField(r.toothNumber)) teethSet.add(id);
    }
  }

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
    teeth,
    isFullArch: arch,
  };
}

export function formatRxTeethLabel(summary: RxSummary): string {
  if (summary.isFullArch === "upper") return "Upper arch";
  if (summary.isFullArch === "lower") return "Lower arch";
  if (summary.isFullArch === "both") return "Full arch (upper & lower)";
  if (summary.teeth.length === 0) return "—";
  return summary.teeth.join(", ");
}

/**
 * Build the highlighted-tooth Set used by the read-only mobile ToothChart.
 * Includes individual teeth plus every tooth in any covered full arch.
 */
export function buildHighlightedToothSet(summary: RxSummary): Set<ToothId> {
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
  return ids;
}

/**
 * Mobile cases don't carry a structured restorations array. Adapt the
 * single-restoration shape stored on the LabCase into the
 * RestorationLike[] the bucketing helpers expect.
 *
 * Mobile `caseType` values are pre-bucketed labels — we map them to
 * canonical strings the bucketer recognizes so the desktop's regex
 * fallbacks stay applicable for any free-text variations.
 */
function caseTypeToRestorationLabel(
  caseType: LabCase["caseType"] | null | undefined,
): string {
  switch ((caseType || "").toLowerCase()) {
    case "restorative":
      return "crown";
    case "removable":
      return "denture";
    case "appliance":
      return "appliance";
    case "temporary":
      return "crown";
    default:
      return "";
  }
}

export function caseToRxSummary(c: Pick<
  LabCase,
  "caseType" | "material" | "toothIndices" | "restorations"
>): RxSummary {
  // Prefer the real restorations array when the server provided one
  // (desktop / iTero-imported cases). Fall back to deriving from the
  // single-restoration LabCase fields for legacy mobile cases.
  if (c.restorations && c.restorations.length > 0) {
    return deriveRxSummary(
      c.restorations.map((r) => ({
        restorationType: r.restorationType ?? null,
        material: r.material ?? null,
        toothNumber: r.toothNumber ?? null,
      })),
    );
  }
  const restorationType = caseTypeToRestorationLabel(c.caseType);
  if (!restorationType && !c.material && !c.toothIndices) {
    return deriveRxSummary([]);
  }
  return deriveRxSummary([
    {
      restorationType,
      material: c.material || null,
      toothNumber: c.toothIndices || null,
    },
  ]);
}
