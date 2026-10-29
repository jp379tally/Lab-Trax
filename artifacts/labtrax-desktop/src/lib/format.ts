import { formatCalendarDate as formatSharedCalendarDate } from "@workspace/calendar-date";

/**
 * Formats a raw phone string as the user types.
 *
 * Behavior:
 * - Empty in → empty out.
 * - Strips non-digits.
 * - A leading "1" with more digits after it is treated as a US/Canada
 *   country code and rendered as "+1 (XXX) XXX-XXXX".
 * - 10-digit numbers (no leading 1) render as "(XXX) XXX-XXXX".
 * - Partial inputs format progressively (e.g. "+1 (850) 363-33").
 * - An optional extension is captured after `x`, `ext`, `ext.`, `#`, or
 *   when more digits are entered than the main number can hold, and is
 *   appended as " ext. NNNN".
 */
export function formatPhone(raw: string): string {
  if (!raw) return "";

  const extMatch = raw.match(/ext\.?|[xX#]/i);
  let mainPart = raw;
  let extPart = "";
  if (extMatch && typeof extMatch.index === "number") {
    mainPart = raw.slice(0, extMatch.index);
    extPart = raw.slice(extMatch.index + extMatch[0].length).replace(/\D/g, "");
  }

  let digits = mainPart.replace(/\D/g, "");

  let countryCode = false;
  if (digits.startsWith("1") && digits.length > 1) {
    countryCode = true;
    digits = digits.slice(1);
  }

  if (digits.length > 10) {
    if (!extPart) extPart = digits.slice(10);
    digits = digits.slice(0, 10);
  }

  let formatted = "";
  if (digits.length === 0) {
    formatted = "";
  } else if (digits.length <= 3) {
    formatted = digits;
  } else if (digits.length <= 6) {
    formatted = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  } else {
    formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  if (countryCode) {
    formatted = formatted ? `+1 ${formatted}` : "+1";
  }

  if (extPart) {
    formatted = formatted ? `${formatted} ext. ${extPart}` : `ext. ${extPart}`;
  }

  return formatted;
}

export function formatMoney(value: string | number | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  if (Number.isNaN(n as number)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n as number);
}

/** Formats a signed invoice line amount with the minus sign before its currency symbol. */
export function formatInvoiceLineMoney(
  value: string | number | null | undefined,
): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  if (Number.isNaN(n as number)) return "$0.00";
  return (n as number) < 0
    ? `−${formatMoney(Math.abs(n as number))}`
    : formatMoney(n as number);
}

/** Renders a Date's local calendar date as zero-padded "MM/DD/YYYY". */
function formatNumericDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Renders a Date's UTC calendar date as zero-padded "MM/DD/YYYY". Used for
 * day-stable calendar-day values (see {@link parseCalendarDay}).
 */
function formatNumericUTCDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatNumericDate(d);
}

export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return "—";
  return formatSharedCalendarDate(value) ?? "—";
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${formatNumericDate(d)}, ${formatTimeOnlyDate(d)}`;
}

function formatTimeOnlyDate(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Renders a case-history event's exact local time without repeating its date. */
export function formatHistoryTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : formatTimeOnlyDate(d);
}

/** Renders the prominent local calendar-day heading used by case history. */
export function formatHistoryDay(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("en-US", { weekday: "long" })}, ${formatNumericDate(d)}`;
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatNumericDate(d);
}

/**
 * Renders the local day a case note was entered as zero-padded "MM/DD" — the
 * dated prefix the lab slip puts to the left of each note's text. Returns null
 * for a blank or unparseable timestamp so callers fall back to plain text
 * rather than printing a placeholder.
 *
 * Built from local date parts rather than toLocaleDateString for the same
 * reason as {@link formatNumericDate}: a locale-aware call renders DD/MM on
 * many non-US devices, and the lab slip must always read month-then-day. The
 * year is deliberately omitted — the slip is read at the bench, where only the
 * day matters.
 */
export function formatNoteDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/**
 * Prefixes a note's text with the day it was entered ("09/15 Confirmed …"),
 * or returns the text unchanged when the timestamp is missing/unreadable.
 */
export function formatDatedNote(
  text: string,
  createdAt: string | null | undefined,
): string {
  const day = formatNoteDay(createdAt);
  return day ? `${day} ${text}` : text;
}

/**
 * Parse a calendar-day value into a Date anchored at UTC midnight.
 *
 * Due dates carry no time-of-day: a picked "YYYY-MM-DD" is sent to the API and
 * stored as a UTC-midnight timestamp. Formatting those with the locale-aware
 * helpers above renders them in the viewer's local timezone, which shifts the
 * day backwards for anyone west of UTC (e.g. a date picked as Jun 25 shows as
 * Jun 24). Anchoring on UTC and formatting in UTC keeps the displayed day equal
 * to the day the user picked, regardless of timezone.
 */
function parseCalendarDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Returns true if the value can be parsed as a usable calendar day.
 * Use this to detect cases that have a non-empty but unparseable date string
 * (they would silently miss Past Due / Due Today / Due Soon otherwise).
 */
export function hasUsableDueDate(value: string | null | undefined): boolean {
  return parseCalendarDay(value) !== null;
}

/**
 * Parse a "HH:MM" (24-hour) due-time string into minutes-since-midnight.
 *
 * Due times are stored and transmitted as plain wall-clock strings with no
 * timezone/date component at all — never a Date/ISO timestamp. Keeping the
 * parse purely string/number based (no `Date` object, no UTC/local
 * conversion) means there is nothing for a timezone to shift; the value
 * means the same "HH:MM" everywhere it's read.
 */
function parseDueTimeMinutes(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Formats a "HH:MM" (24-hour) due-time string as "h:mm AM/PM", or null if absent/invalid. */
function formatTimeOfDay(time: string | null | undefined): string | null {
  const minutes = parseDueTimeMinutes(time);
  if (minutes === null) return null;
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(mins).padStart(2, "0")} ${period}`;
}

/**
 * Day-stable variant of {@link formatDate} for calendar-day values (e.g. due
 * dates). When `time` is a valid "HH:MM" due time, it's appended as
 * "at h:mm AM/PM" (e.g. "07/29/2026 at 3:30 PM"); a date-only value (no
 * time, or an empty/invalid one) renders exactly as before.
 */
export function formatDueDate(
  value: string | null | undefined,
  time?: string | null,
): string {
  const d = parseCalendarDay(value);
  if (!d) return "—";
  const dateStr = formatNumericUTCDate(d);
  const timeStr = formatTimeOfDay(time);
  return timeStr ? `${dateStr} at ${timeStr}` : dateStr;
}

/**
 * Day-stable variant of {@link formatShortDate} for calendar-day values (e.g.
 * due dates). When `time` is a valid "HH:MM" due time, it's appended as
 * "at h:mm AM/PM"; a date-only value renders exactly as before.
 */
export function formatShortDueDate(
  value: string | null | undefined,
  time?: string | null,
): string {
  const d = parseCalendarDay(value);
  if (!d) return "—";
  const dateStr = formatNumericUTCDate(d);
  const timeStr = formatTimeOfDay(time);
  return timeStr ? `${dateStr} at ${timeStr}` : dateStr;
}

/**
 * Day-stable "is this due date today?" check for calendar-day values.
 *
 * Compares the due date's calendar day (UTC-anchored, matching what
 * {@link formatDueDate} renders) against the viewer's local current calendar
 * day. Using local-time parsing here (as a plain `new Date(d)` comparison does)
 * shifts UTC-midnight due dates back a day west of UTC, mis-classifying "due
 * today" relative to the date actually shown on screen. Intended for calendar
 * dates only — do NOT use for real timestamps like createdAt.
 */
export function isDueToday(value: string | null | undefined): boolean {
  const d = parseCalendarDay(value);
  if (!d) return false;
  const dueKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  return dueKey === todayKey;
}

/**
 * Day-stable "is this due date strictly before today, or today with a due
 * time that has already passed?" check for calendar-day values. Uses the
 * same UTC-key vs local-key strategy as {@link isDueToday} for the date
 * comparison.
 *
 * `time`, when a valid "HH:MM" due time, only changes the outcome for a due
 * date that falls exactly on today: it's compared against the viewer's
 * current wall-clock time (also read via local getters, matching the
 * "today" comparison) so a still-upcoming time is not overdue while a
 * passed one is. A date-only due date (no time, or an invalid one) keeps
 * the original end-of-day behavior — never overdue until the day itself
 * has passed.
 */
export function isPastDue(
  value: string | null | undefined,
  time?: string | null,
): boolean {
  const d = parseCalendarDay(value);
  if (!d) return false;
  const dueNum =
    d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const now = new Date();
  const todayNum =
    now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  if (dueNum !== todayNum) return dueNum < todayNum;
  const dueMinutes = parseDueTimeMinutes(time);
  if (dueMinutes === null) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return dueMinutes < nowMinutes;
}

/**
 * Ascending comparator for sorting by due date + optional due time.
 *
 * Due dates already sort correctly as plain strings (both "YYYY-MM-DD" and
 * the UTC-midnight ISO form are lexicographically == chronologically
 * ordered), so the date component is compared as-is with no Date parsing.
 * When two cases share the same due date, the "HH:MM" due time — also
 * zero-padded 24-hour, so it too sorts correctly as a plain string — breaks
 * the tie. A missing/invalid time is treated as end-of-day, so a date-only
 * case sorts after any timed case due the same day, matching the end-of-day
 * treatment used elsewhere for date-only due dates.
 */
export function compareDueDateTime(
  aDate: string | null | undefined,
  aTime: string | null | undefined,
  bDate: string | null | undefined,
  bTime: string | null | undefined,
): number {
  const dateCmp = (aDate ?? "").localeCompare(bDate ?? "");
  if (dateCmp !== 0) return dateCmp;
  const aMin = parseDueTimeMinutes(aTime);
  const bMin = parseDueTimeMinutes(bTime);
  if (aMin === null && bMin === null) return 0;
  if (aMin === null) return 1;
  if (bMin === null) return -1;
  return aMin - bMin;
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(value);
}

const STATUS_LABEL: Record<string, string> = {
  recovery_draft: "Historical hold (not collectible)",
  received: "Received",
  in_design: "In Design",
  scan: "Scan",
  in_milling: "In Milling",
  post_mill: "Post Mill",
  sintering_furnace: "Sintering Furnace",
  model_room: "Model Room",
  in_porcelain: "Porcelain",
  qc: "Quality Check",
  complete: "Complete",
  shipped: "Shipped",
  delivered: "Delivered",
  on_hold: "On Hold",
  remake: "Remake",
  cancelled: "Cancelled",
  open: "Open",
  partially_paid: "Partial",
  paid: "Paid",
  void: "Void",
  overdue: "Overdue",
};

export function statusLabel(s: string | null | undefined): string {
  if (!s) return "—";
  return STATUS_LABEL[s] || s;
}

/**
 * Returns UTC ISO timestamps spanning the full local calendar day of `date`
 * (defaults to now). Passing these as `dateFrom`/`dateTo` to the
 * /invoices/reports/sales endpoint ensures the server's inclusive `gte`/`lte`
 * comparison covers every invoice issued during the local day, regardless of
 * the server's UTC offset.
 *
 *   dateFrom = midnight local → UTC ISO  (e.g. "2026-08-10T04:00:00.000Z" for UTC-4)
 *   dateTo   = 23:59:59.999 local → UTC ISO
 */
export function getLocalDayRange(date?: Date): { dateFrom: string; dateTo: string } {
  const d = date ?? new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

export function statusTone(
  s: string | null | undefined,
): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (s) {
    case "delivered":
    case "shipped":
    case "paid":
      return "success";
    case "on_hold":
    case "overdue":
    case "partially_paid":
      return "warning";
    case "remake":
    case "cancelled":
    case "void":
      return "danger";
    case "received":
      return "neutral";
    default:
      return "info";
  }
}
