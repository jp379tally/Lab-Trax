import { formatTriggeredBy } from "@/lib/cleanup";

interface TriggeredByBadgeProps {
  triggeredBy: string;
  run?: { status?: string; errorMessage?: string | null };
}

export function TriggeredByBadge({ triggeredBy, run }: TriggeredByBadgeProps) {
  const { label, isManual, isAutomatic } = formatTriggeredBy(triggeredBy, run);
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
        isAutomatic
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
          : isManual
            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
            : "bg-secondary text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}
