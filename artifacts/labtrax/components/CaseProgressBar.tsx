import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Colors from "@/constants/colors";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

/**
 * Maps each canonical case status to a progress fraction [0, 1].
 *
 * Keys are the canonical lowercase CaseStatus values (lib/data.ts), which
 * match the server's `cases.status` column. A few extra canonical aliases the
 * server may emit (draft/remake/delivered/cancelled) are included so the bar
 * still renders sensibly for those edge states.
 */
const STATUS_PROGRESS: Record<string, number> = {
  received: 0.05,
  in_design: 0.18,
  scan: 0.27,
  in_milling: 0.36,
  post_mill: 0.45,
  sintering_furnace: 0.54,
  model_room: 0.63,
  in_porcelain: 0.72,
  qc: 0.85,
  shipped: 0.93,
  on_hold: 0.05,
  complete: 1.0,

  // ── Extra canonical aliases the server may emit ───────────────────────────
  draft: 0.05,
  remake: 0.08,
  delivered: 1.0,
  cancelled: 1.0,
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Returns a short due-date label and its color, or null when no label
 * should be shown (no due date, complete case, or plenty of time remaining).
 *
 * Rules:
 *  • Overdue by < 1 day  → "Due today"   red
 *  • Overdue by ≥ 1 day  → "Xd overdue"  red
 *  • Due within  0–24 h  → "Due today"   amber
 *  • Due within 24–48 h  → "Due tomorrow" amber
 *  • Otherwise           → null
 */
export function getDueDateLabel(
  refDateStr: string | null | undefined,
  isComplete: boolean,
): { text: string; color: string } | null {
  if (isComplete || !refDateStr) return null;

  const refMs = new Date(refDateStr).getTime();
  if (isNaN(refMs)) return null;

  const diffMs = refMs - Date.now();

  if (diffMs < 0) {
    // Past due
    const overdueDays = Math.floor(-diffMs / MS_PER_DAY);
    const text = overdueDays === 0 ? "Due today" : `${overdueDays}d overdue`;
    return { text, color: Colors.light.error };
  }

  if (diffMs < MS_PER_DAY) {
    return { text: "Due today", color: Colors.light.warning };
  }

  if (diffMs < 2 * MS_PER_DAY) {
    return { text: "Due tomorrow", color: Colors.light.warning };
  }

  return null;
}

type Props = {
  status: string;
  dueDate?: string | null;
  expectedDeliveryDate?: string | null;
};

/**
 * Returns whole-day difference between today and refDateStr (positive = future,
 * negative = past). Date-only strings (YYYY-MM-DD) are parsed as local time to
 * avoid timezone off-by-one errors. Returns null for unparseable strings.
 */
function getDayDelta(refDateStr: string): number | null {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  // Date-only strings are parsed as UTC by the JS engine; appending T00:00:00
  // forces local-time parsing to avoid off-by-one in negative-offset timezones.
  const normalised = /^\d{4}-\d{2}-\d{2}$/.test(refDateStr)
    ? refDateStr + "T00:00:00"
    : refDateStr;
  const ref = new Date(normalised);
  if (Number.isNaN(ref.getTime())) return null;
  ref.setHours(0, 0, 0, 0);
  return Math.round((ref.getTime() - now.getTime()) / MS_PER_DAY);
}

export function CaseProgressBar({ status, dueDate, expectedDeliveryDate }: Props) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  const rawProgress = STATUS_PROGRESS[status] ?? 0.05;
  const isComplete = status === "complete";

  const refDateStr = expectedDeliveryDate || dueDate || null;

  let dayDelta: number | null = null;
  let isOverdue = false;

  if (!isComplete && refDateStr) {
    dayDelta = getDayDelta(refDateStr);
    isOverdue = dayDelta !== null && dayDelta < 0;
  }

  const fillColor = isComplete
    ? colors.success
    : isOverdue
      ? colors.error
      : colors.tint;

  const fillPercent = Math.round(rawProgress * 100);

  let labelText: string | null = null;
  if (!isComplete && dayDelta !== null) {
    if (dayDelta < 0) {
      labelText = `${Math.abs(dayDelta)}d late`;
    } else if (dayDelta === 0) {
      labelText = "due today";
    } else {
      labelText = `${dayDelta}d left`;
    }
  }

  return (
    <View style={styles.row}>
      <View style={styles.track}>
        <View
          style={[styles.fill, { width: `${fillPercent}%` as any, backgroundColor: fillColor }]}
        />
      </View>
      {labelText !== null && (
        <Text style={[styles.label, isOverdue ? styles.labelOverdue : styles.labelOnTrack]}>
          {labelText}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 7,
    gap: 6,
  },
  track: {
    flex: 1,
    height: 3,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 2,
  },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    minWidth: 42,
    textAlign: "right",
  },
  labelOnTrack: {
    color: colors.textTertiary,
  },
  labelOverdue: {
    color: colors.error,
  },
});
