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
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  const dateStr = `${mm}/${dd}/${next.getFullYear()}`;
  return `${dateStr} at ${timeStr}`;
}
