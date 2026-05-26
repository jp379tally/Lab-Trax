import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Colors from "@/constants/colors";

/**
 * Maps each case status string to a progress fraction [0, 1].
 *
 * Covers two status naming conventions that coexist in the mobile app:
 *   - Mobile legacy:  INTAKE DESIGN SCAN MILL POST_MILL SINTERING_FURNACE
 *                     MODEL_ROOM PORCELAIN QC SHIP HOLD COMPLETE REMAKE
 *   - Desktop bridge: status strings from DESKTOP_TO_MOBILE_STATUS in
 *                     labtrax-routes.ts (MILLING, QC_CHECK, DELIVERY, ON_HOLD)
 */
const STATUS_PROGRESS: Record<string, number> = {
  // ── Mobile legacy statuses (CaseStatus type in lib/data.ts) ────────────
  INTAKE: 0.05,
  DESIGN: 0.18,
  SCAN: 0.27,
  MILL: 0.36,
  POST_MILL: 0.45,
  SINTERING_FURNACE: 0.54,
  MODEL_ROOM: 0.63,
  PORCELAIN: 0.72,
  QC: 0.85,
  SHIP: 0.93,
  HOLD: 0.05,
  COMPLETE: 1.0,
  REMAKE: 0.08,

  // ── Desktop bridge aliases (DESKTOP_TO_MOBILE_STATUS in labtrax-routes.ts) ──
  MILLING: 0.36,
  QC_CHECK: 0.85,
  DELIVERY: 0.93,
  ON_HOLD: 0.05,
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
    return { text, color: "#EF4444" };
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

export function CaseProgressBar({ status, dueDate, expectedDeliveryDate }: Props) {
  const rawProgress = STATUS_PROGRESS[status] ?? 0.05;
  const isComplete = status === "COMPLETE";

  const refDateStr = expectedDeliveryDate || dueDate || null;
  const isOverdue =
    !isComplete &&
    refDateStr !== null &&
    new Date(refDateStr).getTime() < Date.now();

  const fillColor = isComplete
    ? Colors.light.success
    : isOverdue
      ? "#EF4444"
      : Colors.light.tint;

  const fillPercent = Math.round(rawProgress * 100);

  const dueDateLabel = getDueDateLabel(refDateStr, isComplete);

  return (
    <View>
      <View style={styles.track}>
        <View
          style={[styles.fill, { width: `${fillPercent}%` as any, backgroundColor: fillColor }]}
        />
      </View>
      {dueDateLabel && (
        <Text style={[styles.label, { color: dueDateLabel.color }]}>
          {dueDateLabel.text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 3,
    backgroundColor: "#E2E8F0",
    borderRadius: 2,
    marginTop: 7,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 2,
  },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    marginTop: 4,
  },
});
