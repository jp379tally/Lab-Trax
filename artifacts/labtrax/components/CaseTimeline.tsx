import React from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

export type TimelineEntry = {
  status: string;
  label?: string;
  occurredAt: string;
};

type Props = {
  statusHistory: TimelineEntry[];
  currentStatus: string;
  expectedDeliveryDate: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  received: "Received",
  in_design: "Design",
  scan: "Scan",
  in_milling: "Milling",
  post_mill: "Post Mill",
  sintering_furnace: "Sintering",
  model_room: "Model Room",
  in_porcelain: "Porcelain",
  qc: "QC",
  complete: "Complete",
  shipped: "Shipped",
  delivered: "Delivered",
  on_hold: "On Hold",
  remake: "Remake",
  cancelled: "Cancelled",
};

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function CaseTimeline({ statusHistory, currentStatus, expectedDeliveryDate }: Props) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  const PRIMARY = colors.tint;
  const DUE_COLOR = colors.cyan;

  // Overall progress across the full received→expected window (0–1, capped).
  const progressFill = React.useMemo(() => {
    if (!expectedDeliveryDate || statusHistory.length === 0) return 0;
    const firstEntry = statusHistory[0];
    if (!firstEntry) return 0;
    const startMs = new Date(firstEntry.occurredAt).getTime();
    const endMs = new Date(expectedDeliveryDate).getTime();
    const nowMs = Date.now();
    if (endMs <= startMs) return 1;
    return Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));
  }, [statusHistory, expectedDeliveryDate]);

  const isOverdue = progressFill >= 1;

  // Total number of connectors = statusHistory nodes + (optional) expected-date node - 1
  const totalConnectors = expectedDeliveryDate ? statusHistory.length : statusHistory.length - 1;

  // Given connector index i (0-based) within totalConnectors segments, return
  // the fill fraction [0, 1] so that the filled portion is continuous across
  // the whole bar proportional to progressFill.
  function connectorFill(i: number): number {
    if (totalConnectors <= 0) return progressFill;
    const segPos = progressFill * totalConnectors;
    return Math.min(1, Math.max(0, segPos - i));
  }

  const lastHistoryIdx = statusHistory.length - 1;

  return (
    <View style={styles.outer}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.track}>
          {statusHistory.map((entry, idx) => {
            const isLast = idx === lastHistoryIdx;
            const isCurrent = entry.status === currentStatus && idx === lastHistoryIdx;
            const label = entry.label ?? STATUS_LABELS[entry.status] ?? entry.status;
            const fill = connectorFill(idx); // connector after node idx
            return (
              <React.Fragment key={`${entry.status}-${idx}`}>
                <View style={styles.nodeWrap}>
                  <Text style={styles.nodeLabel} numberOfLines={2}>
                    {label}
                  </Text>
                  <View
                    style={[
                      styles.dot,
                      isCurrent
                        ? {
                            backgroundColor: PRIMARY,
                            width: 14,
                            height: 14,
                            borderRadius: 7,
                            borderWidth: 2,
                            borderColor: colors.textInverse,
                            shadowColor: PRIMARY,
                            shadowOpacity: 0.5,
                            shadowRadius: 4,
                            elevation: 3,
                          }
                        : { backgroundColor: PRIMARY, opacity: 0.7 },
                    ]}
                  />
                  <Text style={styles.nodeDate}>{fmtDate(entry.occurredAt)}</Text>
                </View>

                {/* Connector: proportional fill based on overall progress */}
                {!isLast && (
                  <View style={styles.connectorTrack}>
                    {fill > 0 && (
                      <View
                        style={[
                          styles.connectorFill,
                          { width: `${Math.round(fill * 100)}%`, backgroundColor: PRIMARY, opacity: 0.7 },
                        ]}
                      />
                    )}
                  </View>
                )}

                {/* Last connector → expected date node */}
                {isLast && expectedDeliveryDate && (
                  <View style={styles.connectorTrack}>
                    {fill > 0 && (
                      <View
                        style={[
                          styles.connectorFill,
                          {
                            width: `${Math.round(fill * 100)}%`,
                            backgroundColor: isOverdue ? colors.error : PRIMARY,
                            opacity: 0.7,
                          },
                        ]}
                      />
                    )}
                  </View>
                )}
              </React.Fragment>
            );
          })}

          {expectedDeliveryDate && (
            <View style={styles.nodeWrap}>
              <Text
                style={[styles.nodeLabel, { color: isOverdue ? colors.error : DUE_COLOR, fontWeight: "600" }]}
                numberOfLines={2}
              >
                Expected
              </Text>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: "transparent",
                    borderWidth: 2,
                    borderColor: isOverdue ? colors.error : DUE_COLOR,
                    borderStyle: "dashed",
                  },
                ]}
              />
              <Text style={[styles.nodeDate, { color: isOverdue ? colors.error : DUE_COLOR }]}>
                {fmtDate(expectedDeliveryDate)}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Progress summary text */}
      {expectedDeliveryDate && !isOverdue && (
        <Text style={styles.progressHint}>
          {Math.round(progressFill * 100)}% of expected window elapsed
        </Text>
      )}
      {expectedDeliveryDate && isOverdue && (
        <Text style={[styles.progressHint, { color: colors.error }]}>
          Past expected delivery date
        </Text>
      )}
    </View>
  );
}

const CONNECTOR_W = 36;

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  outer: {
    marginHorizontal: -16,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  scrollContent: {
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  track: {
    flexDirection: "row",
    alignItems: "center",
  },
  nodeWrap: {
    alignItems: "center",
    width: 68,
  },
  nodeLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: 6,
    lineHeight: 13,
    height: 26,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.tint,
  },
  nodeDate: {
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    color: colors.textTertiary,
    marginTop: 6,
    textAlign: "center",
  },
  connectorTrack: {
    height: 2,
    width: CONNECTOR_W,
    marginBottom: 8,
    backgroundColor: colors.border,
    borderRadius: 1,
    overflow: "hidden",
  },
  connectorFill: {
    height: "100%",
    borderRadius: 1,
  },
  progressHint: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: colors.textTertiary,
    marginTop: 4,
    textAlign: "center",
  },
});
