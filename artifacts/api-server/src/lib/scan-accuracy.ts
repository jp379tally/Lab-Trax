export type ScanCaptureMode = "camera" | "depth";
export type ScanObjectCondition = "simple-matte" | "dental-complex" | "reflective-or-translucent";

export type ScanRepeatabilityMm = { x: number; y: number; z: number; max: number };
export type ScanAccuracyProfile = {
  id: string;
  captureMode: ScanCaptureMode | "unknown";
  deviceClass: string;
  objectCondition?: ScanObjectCondition;
  evidence: "physical-benchmark" | "fallback";
  expectedErrorMm: { min: number; max: number } | null;
  expectedErrorMicrons: { min: number; max: number } | null;
  expectedPercent: { min: number; max: number } | null;
  p95ErrorMm: number | null;
  p95ErrorMicrons: number | null;
  p95Percent: number | null;
  repeatabilityMm: ScanRepeatabilityMm | null;
  completeness: number | null;
  failureRate: number | null;
  physicalTrialCount: number;
  successfulTrialCount: number;
  conditions: string[];
  warning: string;
  benchmarkVersion: string;
};

export type ScanBenchmarkObservation = {
  deviceClass: string;
  captureMode: ScanCaptureMode;
  objectCondition: ScanObjectCondition;
  evidence: "physical" | "synthetic-replay";
  reviewed?: boolean;
  success: boolean;
  absoluteErrorMm?: number;
  percentageError?: number;
  measuredDimensionsMm?: { x: number; y: number; z: number };
  repeatabilityMm?: ScanRepeatabilityMm;
  complete: boolean;
};

export const SCAN_BENCHMARK_VERSION = "2026-09-11";
export const MIN_PHYSICAL_SUCCESSES_PER_PROFILE = 5;
export const MAX_RELEASE_FAILURE_RATE = 0.2;

const UNKNOWN_PROFILE: ScanAccuracyProfile = {
  id: "unknown-device",
  captureMode: "unknown",
  deviceClass: "Unbenchmarked device",
  evidence: "fallback",
  expectedErrorMm: null,
  expectedErrorMicrons: null,
  expectedPercent: null,
  p95ErrorMm: null,
  p95ErrorMicrons: null,
  p95Percent: null,
  repeatabilityMm: null,
  completeness: null,
  failureRate: null,
  physicalTrialCount: 0,
  successfulTrialCount: 0,
  conditions: [],
  warning: "No measured accuracy range is available for this device and capture mode. Treat dimensions as approximate and recapture if fit is critical.",
  benchmarkVersion: SCAN_BENCHMARK_VERSION,
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function repeatability(rows: ScanBenchmarkObservation[]): ScanRepeatabilityMm {
  const measured = rows
    .map(row => row.measuredDimensionsMm)
    .filter((dimensions): dimensions is NonNullable<ScanBenchmarkObservation["measuredDimensionsMm"]> => {
      return dimensions !== undefined && Object.values(dimensions).every(Number.isFinite);
    });
  if (measured.length >= 2) {
    const rounded = (value: number) => Number(value.toFixed(6));
    const spread = (axis: "x" | "y" | "z") => {
      const values = measured.map(dimensions => dimensions[axis]);
      return rounded(Math.max(...values) - Math.min(...values));
    };
    const x = spread("x");
    const y = spread("y");
    const z = spread("z");
    return { x, y, z, max: Math.max(x, y, z) };
  }

  const supplied = rows.map(row => row.repeatabilityMm).filter(Boolean) as ScanRepeatabilityMm[];
  if (!supplied.length) return { x: 0, y: 0, z: 0, max: 0 };
  const x = Math.max(...supplied.map(value => value.x));
  const y = Math.max(...supplied.map(value => value.y));
  const z = Math.max(...supplied.map(value => value.z));
  return { x, y, z, max: Math.max(x, y, z) };
}
export function buildAccuracyProfiles(observations: ScanBenchmarkObservation[]): ScanAccuracyProfile[] {
  const groups = new Map<string, ScanBenchmarkObservation[]>();
  for (const observation of observations) {
    const key = `${observation.deviceClass}\u0000${observation.captureMode}\u0000${observation.objectCondition}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const profiles: ScanAccuracyProfile[] = [];
  for (const rows of groups.values()) {
    // A physical export is not release evidence until a reviewer has checked
    // the complete trial set and its comparator report.
    const physical = rows.filter(row => row.evidence === "physical" && row.reviewed === true);
    const successful = physical.filter(row =>
      row.success && Number.isFinite(row.absoluteErrorMm) && Number.isFinite(row.percentageError),
    );
    const failureRate = physical.length ? (physical.length - successful.length) / physical.length : 1;
    const completeSuccessful = successful.filter(row => row.complete);
    const completeness = successful.length ? completeSuccessful.length / successful.length : 0;
    const hasRepeatabilityEvidence = successful.every(row =>
      (row.measuredDimensionsMm && Object.values(row.measuredDimensionsMm).every(Number.isFinite)) ||
      (row.repeatabilityMm && Object.values(row.repeatabilityMm).every(Number.isFinite)),
    );
    if (
      successful.length < MIN_PHYSICAL_SUCCESSES_PER_PROFILE ||
      failureRate > MAX_RELEASE_FAILURE_RATE ||
      completeness < 1 ||
      !hasRepeatabilityEvidence
    ) continue;
    const errors = successful.map(row => row.absoluteErrorMm!);
    const percentages = successful.map(row => row.percentageError!);
    const maxMm = Number(percentile(errors, 0.95).toFixed(3));
    const maxPercent = Number(percentile(percentages, 0.95).toFixed(2));
    const maxMicrons = Math.round(maxMm * 1000);
    profiles.push({
      id: `${successful[0].captureMode}-${successful[0].deviceClass.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${successful[0].objectCondition}`,
      captureMode: successful[0].captureMode,
      deviceClass: successful[0].deviceClass,
      objectCondition: successful[0].objectCondition,
      evidence: "physical-benchmark",
      expectedErrorMm: { min: 0, max: maxMm },
      expectedErrorMicrons: { min: 0, max: maxMicrons },
      expectedPercent: { min: 0, max: maxPercent },
      p95ErrorMm: maxMm,
      p95ErrorMicrons: maxMicrons,
      p95Percent: maxPercent,
      repeatabilityMm: repeatability(successful),
      completeness,
      failureRate,
      physicalTrialCount: physical.length,
      successfulTrialCount: successful.length,
      conditions: [successful[0].objectCondition],
      warning: "Observed 95th-percentile upper bound under documented benchmark conditions; this is not a metrology guarantee.",
      benchmarkVersion: SCAN_BENCHMARK_VERSION,
    });
  }
  return profiles;
}

export function resolveAccuracyProfile(
  profiles: ScanAccuracyProfile[],
  captureMode: ScanCaptureMode,
  device?: string,
  objectCondition?: ScanObjectCondition,
): ScanAccuracyProfile {
  const normalized = device?.trim().toLowerCase().replace(/\s+/g, " ");
  // Reflective and translucent surfaces are not eligible for a better range
  // until a separately measured profile exists. Never let a claimed condition
  // fall through to an opaque-material benchmark.
  if (!normalized || !objectCondition || objectCondition === "reflective-or-translucent") return UNKNOWN_PROFILE;
  return profiles.find(profile =>
    profile.captureMode === captureMode &&
    profile.objectCondition === objectCondition &&
    normalized === profile.deviceClass.trim().toLowerCase().replace(/\s+/g, " "),
  ) ?? UNKNOWN_PROFILE;
}

// Physical trial observations are intentionally empty until signed benchmark
// exports are committed. CI replay fixtures must never unlock an accuracy label.
export const RELEASED_SCAN_ACCURACY_PROFILES = buildAccuracyProfiles([]);
