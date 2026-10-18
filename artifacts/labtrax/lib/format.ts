// Small shared formatters for the read-only parity screens.

import { formatCalendarDate as formatSharedCalendarDate } from "@workspace/calendar-date";

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
  const amount = toNumber(v);
  const magnitude = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount < 0 ? "−" : ""}$${magnitude}`;
}

// Two-digit month / two-digit day / four-digit year (e.g. "07/29/2026") — the
// numeric calendar-date format the rest of the business standardizes on.
// Built manually (not toLocaleDateString) so the component ORDER stays fixed
// regardless of the viewer's device locale — a locale-aware call would render
// DD/MM/YYYY for many non-US devices even with 2-digit options.
function formatNumericDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatNumericDate(d);
}

export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return "—";
  return formatSharedCalendarDate(value) ?? "—";
}

// The local day a case note was entered, as zero-padded "MM/DD" — the dated
// prefix the case overview (the mobile lab slip) puts to the left of the note
// text. Null for a blank or unparseable timestamp so callers fall back to the
// plain note text instead of printing a placeholder. Built from local date
// parts for the same reason as formatNumericDate above: the order must stay
// month-then-day on every device locale. The year is deliberately omitted.
export function formatNoteDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

// Prefixes a note's text with the day it was entered ("09/15 Confirmed …"), or
// returns the text unchanged when the timestamp is missing/unreadable.
export function formatDatedNote(
  text: string,
  iso: string | null | undefined,
): string {
  const day = formatNoteDay(iso);
  return day ? `${day} ${text}` : text;
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

// Due dates (and the case-detail screen's `dueDate`-derived comparisons) are
// transmitted as a UTC-midnight-anchored calendar day — a pure date with no
// real time-of-day, encoded that way because `new Date("YYYY-MM-DD")` parses
// as UTC midnight per spec. Recovering the day the user actually picked means
// reading UTC components, not local ones: local getters shift the day back by
// one for any viewer whose device timezone sits behind UTC (most of the
// Americas), even though the bug is invisible in a UTC CI environment.
// This is deliberately a *separate* function from getLocalDayDiff, which
// stays local-getter-based because it is also used for genuine timestamps
// (createdAt) where local extraction is the correct behaviour.
export function getDueDayDiff(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const target = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - today.getTime()) / msPerDay);
}

// Due times are stored as a literal "HH:MM" (24h) wall-clock string with no
// timezone of their own (organizations have no timezone column). Never
// round-trip these through a Date object — always parse/format/compare them
// as plain text, relative to the viewer's own local clock.
const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseDueTimeMinutes(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = DUE_TIME_PATTERN.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatDueTime(time: string | null | undefined): string | null {
  const mins = parseDueTimeMinutes(time);
  if (mins == null) return null;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// True once a same-day due time has passed on the viewer's own wall clock.
// Only meaningful when the day-diff is exactly 0 — callers must not use this
// to decide overdue-ness for a different day (a whole past day is overdue
// regardless of time; a future day never is).
export function isDueTimePast(dueTime: string | null | undefined): boolean {
  const mins = parseDueTimeMinutes(dueTime);
  if (mins == null) return false;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= mins;
}

export function formatRelativeCreated(iso: string | null | undefined): string {
  const diff = getLocalDayDiff(iso);
  if (diff == null) return "";
  const ago = -diff;
  if (ago <= 0) return "Created today";
  if (ago === 1) return "Created yesterday";
  return `Created ${ago} days ago`;
}

export function formatRelativeDue(iso: string | null | undefined, dueTime?: string | null): string {
  const diff = getDueDayDiff(iso);
  if (diff == null) return "";
  const timeLabel = formatDueTime(dueTime);
  const suffix = timeLabel ? ` at ${timeLabel}` : "";
  if (diff === 0) {
    return isDueTimePast(dueTime) ? `Overdue today${suffix}` : `Due today${suffix}`;
  }
  if (diff === 1) return `Due tomorrow${suffix}`;
  if (diff > 0) return `Due in ${diff} days${suffix}`;
  const overdue = -diff;
  return `Overdue by ${overdue} ${overdue === 1 ? "day" : "days"}${suffix}`;
}

// Absolute "<date>[ at <time>]" label for detail views where a fixed date
// reads better than a relative one (e.g. "Jul 29, 2026 at 3:30 PM"). Reads
// the due date's UTC components for the same reason getDueDayDiff does.
export function formatDueDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return formatNumericDate(local);
}

export function formatDueDate(iso: string | null | undefined, dueTime?: string | null): string {
  const date = formatDueDateOnly(iso);
  if (date === "—") return "—";
  const timeLabel = formatDueTime(dueTime);
  return timeLabel ? `${date} at ${timeLabel}` : date;
}

export function formatCompletedAt(iso: string | null | undefined): string {
  if (!iso) return "Completed";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Completed";
  const date = formatNumericDate(d);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Completed ${date} ${time}`;
}
