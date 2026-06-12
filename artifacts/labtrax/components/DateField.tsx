import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// Date-only ("YYYY-MM-DD") helpers kept in plain calendar space to avoid
// timezone drift, mirroring the case-detail picker logic.
function parseYMD(v: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map((n) => Number(n));
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function formatDateInput(value: string | null | undefined): string | null {
  const p = parseYMD(value);
  if (!p) return null;
  const d = new Date(p.y, p.m - 1, p.d);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function todayYMD(): { y: number; m: number; d: number } {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftMonth(view: { y: number; m: number }, delta: number): { y: number; m: number } {
  let m = view.m + delta;
  let y = view.y;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return { y, m };
}

export function DateField({
  value,
  onChange,
  placeholder = "Select a date",
  error,
  testID,
}: {
  /** Date-only string in "YYYY-MM-DD" form, or "" / null when unset. */
  value: string | null;
  onChange: (next: string) => void;
  placeholder?: string;
  error?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const p = parseYMD(value) ?? todayYMD();
    return { y: p.y, m: p.m };
  });

  useEffect(() => {
    if (open) {
      const p = parseYMD(value) ?? todayYMD();
      setView({ y: p.y, m: p.m });
    }
  }, [open, value]);

  const label = formatDateInput(value);
  const selected = parseYMD(value);
  const today = todayYMD();
  const daysInMonth = new Date(view.y, view.m, 0).getDate();
  const firstWeekday = new Date(view.y, view.m - 1, 1).getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

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
        <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>Due date</Text>
            <View style={styles.calHeader}>
              <Pressable
                style={styles.calNav}
                onPress={() => setView((v) => shiftMonth(v, -1))}
                hitSlop={8}
                testID="cal-prev"
              >
                <Ionicons name="chevron-back" size={20} color={colors.text} />
              </Pressable>
              <Text style={styles.calMonth}>
                {MONTH_NAMES[view.m - 1]} {view.y}
              </Text>
              <Pressable
                style={styles.calNav}
                onPress={() => setView((v) => shiftMonth(v, 1))}
                hitSlop={8}
                testID="cal-next"
              >
                <Ionicons name="chevron-forward" size={20} color={colors.text} />
              </Pressable>
            </View>
            <View style={styles.calWeekRow}>
              {WEEKDAYS.map((w) => (
                <Text key={w} style={styles.calWeekday}>
                  {w}
                </Text>
              ))}
            </View>
            <View style={styles.calGrid}>
              {cells.map((d, i) => {
                if (d === null) {
                  return <View key={`blank-${i}`} style={styles.calCell} />;
                }
                const isSel =
                  !!selected && selected.y === view.y && selected.m === view.m && selected.d === d;
                const isToday = today.y === view.y && today.m === view.m && today.d === d;
                return (
                  <Pressable
                    key={`d-${d}`}
                    style={[styles.calCell, isSel && styles.calCellSelected]}
                    onPress={() => {
                      onChange(ymd(view.y, view.m, d));
                      setOpen(false);
                    }}
                    testID={`cal-day-${d}`}
                  >
                    <Text
                      style={[
                        styles.calCellText,
                        isToday && styles.calCellTextToday,
                        isSel && styles.calCellTextSelected,
                      ]}
                    >
                      {d}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.calFooter}>
              <Pressable
                style={styles.footerBtn}
                onPress={() => {
                  onChange("");
                  setOpen(false);
                }}
                testID="cal-clear"
              >
                <Text style={styles.footerBtnText}>Clear</Text>
              </Pressable>
              <Pressable style={styles.footerBtn} onPress={() => setOpen(false)}>
                <Text style={styles.footerBtnText}>Cancel</Text>
              </Pressable>
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
    calHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    calNav: { padding: Spacing.xs },
    calMonth: { ...Typography.bodySemibold, color: c.text },
    calWeekRow: { flexDirection: "row" },
    calWeekday: {
      ...Typography.caption,
      color: c.textTertiary,
      width: `${100 / 7}%`,
      textAlign: "center",
    },
    calGrid: { flexDirection: "row", flexWrap: "wrap" },
    calCell: {
      width: `${100 / 7}%`,
      aspectRatio: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    calCellSelected: {},
    calCellText: {
      ...Typography.body,
      color: c.text,
      width: 34,
      height: 34,
      lineHeight: 34,
      textAlign: "center",
      borderRadius: Radius.full,
      overflow: "hidden",
    },
    calCellTextToday: { color: c.tint, fontWeight: "700" },
    calCellTextSelected: { backgroundColor: c.tint, color: c.textInverse },
    calFooter: {
      flexDirection: "row",
      justifyContent: "space-between",
    },
    footerBtn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
    footerBtnText: { ...Typography.bodySemibold, color: c.tint },
  });
}
