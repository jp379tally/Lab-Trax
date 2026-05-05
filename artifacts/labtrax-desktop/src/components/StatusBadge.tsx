import { statusLabel, statusTone } from "@/lib/format";

interface Props {
  status?: string | null;
  size?: "sm" | "md";
}

const TONE_CLASS: Record<ReturnType<typeof statusTone>, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  info: "bg-primary/10 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/20 text-warning",
  danger: "bg-destructive/10 text-destructive",
};

export function StatusBadge({ status, size = "sm" }: Props) {
  const tone = statusTone(status);
  const sizing =
    size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center font-medium rounded-full uppercase tracking-wide ${sizing} ${TONE_CLASS[tone]}`}
    >
      {statusLabel(status)}
    </span>
  );
}
