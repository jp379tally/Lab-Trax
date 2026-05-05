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
  in_milling: "In Milling",
  in_porcelain: "Porcelain",
  qc: "QC",
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
