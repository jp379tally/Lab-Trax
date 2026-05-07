export function getNextCleanupTime(hourUtc: number): Date {
  const now = new Date();
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (candidate <= now) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

export function formatNextCleanupTime(hourUtc: number): string {
  const next = getNextCleanupTime(hourUtc);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const timeStr = next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (next.toLocaleDateString() === now.toLocaleDateString()) return `today at ${timeStr}`;
  if (next.toLocaleDateString() === tomorrow.toLocaleDateString()) return `tomorrow at ${timeStr}`;
  return next.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
