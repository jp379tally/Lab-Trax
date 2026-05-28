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
