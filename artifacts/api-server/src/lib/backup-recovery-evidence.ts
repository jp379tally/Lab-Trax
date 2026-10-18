/**
 * Read-only verification of supplied evidence, not the app's stale-alert job.
 * A successful history row alone cannot establish a production recovery point.
 * Archive provenance must come from its authenticated manifest and trusted
 * source metadata, not its filename or the DB in which history was found.
 */
export interface RecoveryEvidence {
  now: number;
  enabled: boolean;
  intervalMinutes: number | null;
  destination: string | null;
  listingComplete: boolean;
  archives: Array<{
    name: string;
    size: number;
    createdAt: string;
    itemId?: string;
    authenticatedManifest?: { exportedBy: string; sourceEnvironment?: string; coverageVersion?: number };
  }>;
  runs: Array<{
    status: string;
    destination: string;
    actor: string;
    fileName: string | null;
    size: number | null;
    completedAt: string;
    remoteItemId?: string;
    archiveKind?: string;
    partialFailure?: boolean;
  }>;
}

export function assessRecoveryEvidence(input: RecoveryEvidence) {
  const issues: string[] = [];
  if (!input.enabled || input.intervalMinutes !== 15 || input.destination !== "onedrive") {
    issues.push("The enabled schedule is not a 15-minute server-side OneDrive schedule.");
  }
  if (!input.listingComplete) issues.push("Cloud listing is incomplete; archive availability is unknown.");
  const newest = input.archives.reduce<number | null>((latest, file) => {
    const time = Date.parse(file.createdAt);
    return Number.isFinite(time) && file.size > 0 ? Math.max(latest ?? 0, time) : latest;
  }, null);
  // Explicit five-minute upload grace; not the legacy seven-day email threshold.
  const maxAgeMs = 20 * 60 * 1000;
  if (newest === null) issues.push("No non-empty cloud archive was found.");
  else if (newest > input.now || input.now - newest > maxAgeMs) {
    issues.push("The newest cloud archive is stale or has an invalid future timestamp.");
  }
  const candidates = input.runs.filter(run =>
    run.status === "success" && run.destination === "onedrive" &&
     ["scheduler:interval", "scheduler:offsite"].includes(run.actor) &&
     run.archiveKind === "complete-production" && run.partialFailure !== true && run.remoteItemId &&
     run.fileName && run.size && run.size > 0 &&
    Number.isFinite(Date.parse(run.completedAt)) &&
    Date.parse(run.completedAt) <= input.now &&
    input.now - Date.parse(run.completedAt) <= maxAgeMs,
  );
  let verifiedAt: number | null = null;
  for (const run of candidates) {
    const archive = input.archives.find(file => file.itemId === run.remoteItemId &&
      file.name === run.fileName && file.size === run.size);
    if (!archive) {
      issues.push(`A scheduled success has no matching retained cloud archive: ${run.fileName}`);
      continue;
    }
    if (archive.authenticatedManifest?.exportedBy !== run.actor ||
        archive.authenticatedManifest.sourceEnvironment !== "production" ||
        archive.authenticatedManifest.coverageVersion !== 1) continue;
    const time = Date.parse(run.completedAt);
    const cloudTime = Date.parse(archive.createdAt);
    if (Number.isFinite(time) && time <= input.now &&
        Number.isFinite(cloudTime) && cloudTime <= input.now &&
        Math.abs(cloudTime - time) <= maxAgeMs &&
        input.now - cloudTime <= maxAgeMs) {
      verifiedAt = Math.max(verifiedAt ?? 0, time);
    }
  }
  if (verifiedAt === null || input.now - verifiedAt > maxAgeMs) {
    issues.push("No recent retained archive has authenticated production/scheduler provenance.");
  }
  return { healthy: issues.length === 0, issues, newestCloudAt: newest, verifiedProductionAt: verifiedAt };
}
