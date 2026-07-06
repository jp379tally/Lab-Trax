// Small shared formatters for the read-only parity screens.

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

export function toNumber(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoney(v: string | number | null | undefined): string {
  return `$${toNumber(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function getLocalDayDiff(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - today.getTime()) / msPerDay);
}

export function formatRelativeCreated(iso: string | null | undefined): string {
  const diff = getLocalDayDiff(iso);
  if (diff == null) return "";
  const ago = -diff;
  if (ago <= 0) return "Created today";
  if (ago === 1) return "Created yesterday";
  return `Created ${ago} days ago`;
}

export function formatRelativeDue(iso: string | null | undefined): string {
  const diff = getLocalDayDiff(iso);
  if (diff == null) return "";
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff > 0) return `Due in ${diff} days`;
  const overdue = -diff;
  return `Overdue by ${overdue} ${overdue === 1 ? "day" : "days"}`;
}
