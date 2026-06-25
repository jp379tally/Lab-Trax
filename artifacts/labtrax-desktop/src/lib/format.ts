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

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
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

/** Day-stable variant of {@link formatDate} for calendar-day values (e.g. due dates). */
export function formatDueDate(value: string | null | undefined): string {
  const d = parseCalendarDay(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Day-stable variant of {@link formatShortDate} for calendar-day values (e.g. due dates). */
export function formatShortDueDate(value: string | null | undefined): string {
  const d = parseCalendarDay(value);
  if (!d) return "—";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
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
  draft: "Draft",
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
    case "draft":
      return "neutral";
    default:
      return "info";
  }
}
