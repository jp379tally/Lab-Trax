import {
  legacyCleanupConfiguration,
  legacyCleanupConfigurationAvailable,
  legacyCleanupUnavailableMessage,
} from "./sdr1-legacy-cleanup-config";

/** Runtime-only values are loaded from the private cleanup configuration. */
export const SDR1_ORG_ID = legacyCleanupConfiguration.labOrganizationId;
export const SDR1_CLEANUP_CONFIRM = legacyCleanupConfiguration.confirmationPhrase;
export const SDR1_ERA_START_MS = legacyCleanupConfiguration.eraStartMs;
export const SDR1_ERA_END_MS = legacyCleanupConfiguration.eraEndMs;
export const SDR1_TARGET_PATIENTS = legacyCleanupConfiguration.targetPatients;
export const SDR1_CLEANUP_AVAILABLE = legacyCleanupConfigurationAvailable;
export const SDR1_CLEANUP_UNAVAILABLE_MESSAGE = legacyCleanupUnavailableMessage;

export function assertSdr1CleanupDataAvailable(): void {
  if (!SDR1_CLEANUP_AVAILABLE) throw new Error(SDR1_CLEANUP_UNAVAILABLE_MESSAGE);
}

export type Sdr1CleanupConfiguration = {
  eraStartMs: number;
  eraEndMs: number;
  targetPatients: readonly string[];
};

/**
 * Normalize a patient name into sorted tokens. Punctuation and whitespace are
 * separators; matching remains exact on all target tokens.
 */
export function normalizeNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[\/,()\-_.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

/**
 * Match a target only when every target token is present and there is at most
 * one additional token. This avoids treating a shared surname as identity.
 */
export function namesMatch(blobName: string, targetName: string): boolean {
  const blob = normalizeNameTokens(blobName);
  const target = normalizeNameTokens(targetName);
  if (target.length === 0 || blob.length === 0) return false;
  if (blob.length - target.length > 1) return false;
  const blobSet = new Set(blob);
  return target.every((token) => blobSet.has(token));
}

/** Find a configured target, or null when the name is not a safe match. */
export function findMatchingTarget(
  blobName: string | null | undefined,
  targetPatients: readonly string[] = SDR1_TARGET_PATIENTS,
): string | null {
  if (!blobName || typeof blobName !== "string" || !blobName.trim()) return null;
  for (const target of targetPatients) {
    if (namesMatch(blobName, target)) return target;
  }
  return null;
}

/** Parse a legacy blob timestamp (epoch-ms number, numeric string, or ISO). */
export function parseLegacyTimestampMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Epoch-milliseconds; reject implausibly small values instead of guessing.
    return raw > 10_000_000_000 ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d{12,}$/.test(trimmed)) return Number(trimmed);
    const timestamp = Date.parse(trimmed);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  return null;
}

export type LegacyRowInput = {
  id: string;
  organizationId: string | null;
  caseData: unknown;
};

export type ClassifiedLegacyRow = {
  id: string;
  patientName: string | null;
  caseNumber: string | null;
  invoiceRef: string | null;
  createdAtMs: number | null;
  matchedTarget: string | null;
  reason: string;
};

export type Sdr1Classification = {
  matched: ClassifiedLegacyRow[];
  ambiguous: ClassifiedLegacyRow[];
  nonTarget: ClassifiedLegacyRow[];
  unmatchedTargets: string[];
};

/**
 * Pure classification over already organization-scoped rows. Production
 * callers must first assert that the private identity configuration loaded.
 */
export function classifySdr1LegacyRows(
  rows: LegacyRowInput[],
  configuration: Sdr1CleanupConfiguration = legacyCleanupConfiguration,
): Sdr1Classification {
  const matched: ClassifiedLegacyRow[] = [];
  const ambiguous: ClassifiedLegacyRow[] = [];
  const nonTarget: ClassifiedLegacyRow[] = [];
  const seenTargets = new Set<string>();

  for (const row of rows) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const data =
        typeof row.caseData === "string" ? JSON.parse(row.caseData) : row.caseData;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        parsed = data as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }

    if (!parsed) {
      ambiguous.push({
        id: row.id,
        patientName: null,
        caseNumber: null,
        invoiceRef: null,
        createdAtMs: null,
        matchedTarget: null,
        reason: "unparseable_blob",
      });
      continue;
    }

    const patientName =
      typeof parsed.patientName === "string" && parsed.patientName.trim()
        ? parsed.patientName.trim()
        : null;
    const caseNumber = parsed.caseNumber != null ? String(parsed.caseNumber) : null;
    const invoiceRef =
      typeof parsed.invoiceId === "string" && parsed.invoiceId.trim()
        ? parsed.invoiceId.trim()
        : null;
    const createdAtMs = parseLegacyTimestampMs(parsed.createdAt);
    const matchedTarget = findMatchingTarget(patientName, configuration.targetPatients);
    const base = { id: row.id, patientName, caseNumber, invoiceRef, createdAtMs };

    if (!matchedTarget) {
      nonTarget.push({ ...base, matchedTarget: null, reason: "name_not_on_target_list" });
      continue;
    }
    seenTargets.add(matchedTarget);

    if (createdAtMs == null) {
      ambiguous.push({ ...base, matchedTarget, reason: "missing_or_unparseable_created_at" });
      continue;
    }
    if (createdAtMs < configuration.eraStartMs || createdAtMs >= configuration.eraEndMs) {
      ambiguous.push({ ...base, matchedTarget, reason: "created_at_outside_legacy_era" });
      continue;
    }

    matched.push({ ...base, matchedTarget, reason: "target_name_in_legacy_era" });
  }

  const unmatchedTargets = configuration.targetPatients.filter((target) => !seenTargets.has(target));
  return { matched, ambiguous, nonTarget, unmatchedTargets };
}
