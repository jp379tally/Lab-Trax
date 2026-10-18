/**
 * Preserve a not-yet-due backup deadline across a process restart.
 * Missing/overdue evidence keeps the normal interval: the separate startup
 * catch-up already handles those cases after the server's warm-up delay.
 */
export function offsiteFirstTickDelayMs(
  nowMs: number,
  lastVerifiedAt: string | null,
  intervalMinutes: number,
): number {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new RangeError("Off-site backup interval must be positive and finite.");
  }
  const intervalMs = intervalMinutes * 60_000;
  const verifiedMs = lastVerifiedAt === null ? NaN : Date.parse(lastVerifiedAt);
  if (!Number.isFinite(verifiedMs)) return intervalMs;
  const remainingMs = verifiedMs + intervalMs - nowMs;
  return remainingMs > 0 ? Math.min(remainingMs, intervalMs) : intervalMs;
}
