import React from "react";
import { View, StyleSheet } from "react-native";
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

  return (
    <View style={styles.track}>
      <View
        style={[styles.fill, { width: `${fillPercent}%` as any, backgroundColor: fillColor }]}
      />
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
});
