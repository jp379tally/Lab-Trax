import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { parseDueTimeMinutes, formatDueTime } from "@/lib/format";

const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES_5 = Array.from({ length: 12 }, (_, i) => i * 5); // 0, 5, ..., 55

// Time-of-day ("HH:MM", 24h) helpers kept in plain wall-clock space — due
// times have no timezone of their own, so we never round-trip them through a
// Date object, mirroring the date-only helpers in DateField.tsx.
function to12Hour(h24: number): { h12: number; period: "AM" | "PM" } {
  const period: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { h12, period };
}

function to24Hour(h12: number, period: "AM" | "PM"): number {
  const base = h12 % 12;
  return period === "PM" ? base + 12 : base;
}

function hhmm(h24: number, m: number): string {
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function roundToNearest5(m: number): number {
  return Math.round(m / 5) * 5 % 60;
}

type Draft = { h12: number; m: number; period: "AM" | "PM" };

function draftFromValue(value: string | null | undefined): Draft {
  const mins = parseDueTimeMinutes(value);
  if (mins != null) {
    const { h12, period } = to12Hour(Math.floor(mins / 60));
    return { h12, m: roundToNearest5(mins % 60), period };
  }
  const now = new Date();
  const { h12, period } = to12Hour(now.getHours());
  return { h12, m: roundToNearest5(now.getMinutes()), period };
}

export function TimeField({
  value,
  onChange,
  placeholder = "Select a time",
  title = "Due time",
  error,
  testID,
}: {
  /** Time-of-day string in 24-hour "HH:MM" form, or "" / null when unset. */
  value: string | null;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Heading shown at the top of the time sheet. */
  title?: string;
  error?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFromValue(value));

  useEffect(() => {
    if (open) setDraft(draftFromValue(value));
  }, [open, value]);

  const idFor = (suffix: string) => (testID ? `${testID}-${suffix}` : `time-${suffix}`);

  const label = formatDueTime(value);

  return (
    <>
      <Pressable
        style={[styles.trigger, error && styles.triggerError]}
        onPress={() => setOpen(true)}
        testID={testID}
      >
        <Text style={[styles.triggerText, !label && styles.triggerPlaceholder]}>
          {label ?? placeholder}
        </Text>
        <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <View style={styles.timeColumns}>
              <ScrollView style={styles.timeColumn} showsVerticalScrollIndicator={false}>
                {HOURS_12.map((h) => {
                  const isSel = draft.h12 === h;
                  return (
                    <Pressable
                      key={`h-${h}`}
                      style={[styles.timeCell, isSel && styles.timeCellSelected]}
                      onPress={() => setDraft((d) => ({ ...d, h12: h }))}
                      testID={idFor(`hour-${h}`)}
                    >
                      <Text style={[styles.timeCellText, isSel && styles.timeCellTextSelected]}>
                        {h}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <ScrollView style={styles.timeColumn} showsVerticalScrollIndicator={false}>
                {MINUTES_5.map((m) => {
                  const isSel = draft.m === m;
                  return (
                    <Pressable
                      key={`m-${m}`}
                      style={[styles.timeCell, isSel && styles.timeCellSelected]}
                      onPress={() => setDraft((d) => ({ ...d, m }))}
                      testID={idFor(`minute-${m}`)}
                    >
                      <Text style={[styles.timeCellText, isSel && styles.timeCellTextSelected]}>
                        {String(m).padStart(2, "0")}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <View style={styles.periodColumn}>
                {(["AM", "PM"] as const).map((p) => {
                  const isSel = draft.period === p;
                  return (
                    <Pressable
                      key={p}
                      style={[styles.periodCell, isSel && styles.periodCellSelected]}
                      onPress={() => setDraft((d) => ({ ...d, period: p }))}
                      testID={idFor(`period-${p.toLowerCase()}`)}
                    >
                      <Text style={[styles.periodCellText, isSel && styles.periodCellTextSelected]}>
                        {p}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.calFooter}>
              <Pressable
                style={styles.footerBtn}
                onPress={() => {
                  onChange("");
                  setOpen(false);
                }}
                testID={idFor("clear")}
              >
                <Text style={styles.footerBtnText}>Clear</Text>
              </Pressable>
              <View style={styles.footerRightGroup}>
                <Pressable style={styles.footerBtn} onPress={() => setOpen(false)} testID={idFor("cancel")}>
                  <Text style={styles.footerBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.footerBtn}
                  onPress={() => {
                    onChange(hhmm(to24Hour(draft.h12, draft.period), draft.m));
                    setOpen(false);
                  }}
                  testID={idFor("set")}
                >
                  <Text style={[styles.footerBtnText, styles.footerBtnTextPrimary]}>Set</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    triggerError: { borderColor: c.error },
    triggerText: { ...Typography.body, color: c.text },
    triggerPlaceholder: { color: c.textTertiary },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      padding: Spacing.lg,
    },
    sheet: {
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.lg,
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    sheetTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    timeColumns: {
      flexDirection: "row",
      justifyContent: "center",
      gap: Spacing.sm,
      height: 180,
    },
    timeColumn: {
      width: 64,
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
    },
    timeCell: {
      paddingVertical: Spacing.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    timeCellSelected: { backgroundColor: c.tint, borderRadius: Radius.sm },
    timeCellText: { ...Typography.body, color: c.text },
    timeCellTextSelected: { color: c.textInverse, fontWeight: "700" },
    periodColumn: {
      width: 56,
      justifyContent: "center",
      gap: Spacing.sm,
    },
    periodCell: {
      paddingVertical: Spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
    },
    periodCellSelected: { backgroundColor: c.tint },
    periodCellText: { ...Typography.bodySemibold, color: c.text },
    periodCellTextSelected: { color: c.textInverse },
    calFooter: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    footerRightGroup: { flexDirection: "row", gap: Spacing.md },
    footerBtn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
    footerBtnText: { ...Typography.bodySemibold, color: c.tint },
    footerBtnTextPrimary: { color: c.tint },
  });
}
