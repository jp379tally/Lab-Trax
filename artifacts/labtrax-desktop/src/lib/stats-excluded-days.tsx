/**
 * Helper functions for the excluded-days display on the Stats page.
 *
 * Extracted so they can be unit-tested independently of the full page render
 * (which requires Radix UI portals and Recharts layout).
 */
import React from "react";
import { Link } from "wouter";
import { usHolidayNameMap } from "@/lib/us-holidays";

/**
 * Format a "YYYY-MM-DD" date string using UTC so the displayed month/day
 * never shifts due to the local timezone offset.
 * Returns zero-padded "MM/DD" (no year).
 */
export function formatExcludedDate(ymd: string): string {
  const [, mo, dy] = ymd.split("-").map(Number);
  return `${String(mo).padStart(2, "0")}/${String(dy).padStart(2, "0")}`;
}

export type ExcludedDaysData = {
  holidayCount: number;
  customClosedCount: number;
  dates: Array<{ date: string; reason: string }>;
};

/**
 * Build the JSX tooltip content for the "Avg daily sales" metric card.
 * Returns undefined when there are no excluded days (tooltip is hidden).
 */
export function buildExcludedDaysTooltip(
  excludedDays: ExcludedDaysData | undefined | null,
  isAdmin?: boolean,
): React.ReactNode | undefined {
  if (!excludedDays) return undefined;
  const { holidayCount, customClosedCount, dates } = excludedDays;
  const total = holidayCount + customClosedCount;
  if (total === 0) return undefined;

  const parts: string[] = [];
  if (holidayCount > 0)
    parts.push(
      `${holidayCount} US federal holiday${holidayCount !== 1 ? "s" : ""}`,
    );
  if (customClosedCount > 0)
    parts.push(
      `${customClosedCount} custom closed day${customClosedCount !== 1 ? "s" : ""}`,
    );

  const years = [
    ...new Set(dates.map((d) => parseInt(d.date.slice(0, 4), 10))),
  ];
  const nameMap = usHolidayNameMap(years);
  const sorted = [...dates].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="space-y-2">
      <p className="leading-snug">
        Denominator excludes {parts.join(" + ")} from the business-day count.
      </p>
      <div className="max-h-44 overflow-y-auto space-y-0.5 border-t border-border/40 pt-2">
        {sorted.map(({ date, reason }) => {
          const label = formatExcludedDate(date);
          const name =
            reason === "holiday"
              ? (nameMap.get(date) ?? "US holiday")
              : "Closed day";
          return (
            <div
              key={date}
              className="flex items-baseline gap-1 text-xs leading-snug"
            >
              <span className="shrink-0 tabular-nums">{label}</span>
              <span className="text-muted-foreground truncate">— {name}</span>
            </div>
          );
        })}
      </div>
      {isAdmin && (
        <Link
          to="/settings?tab=closed-days"
          className="mt-1.5 block text-xs text-primary hover:underline"
        >
          Manage closed days →
        </Link>
      )}
    </div>
  );
}
