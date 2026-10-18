import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet, Keyboard } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { TypedCaseDateEntry } from "@/components/TypedCaseDateEntry";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
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
  return `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${p.y}`;
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
  title = "Due date",
  error,
  minDate,
  maxDate,
  allowTyping = false,
  testID,
}: {
  /** Date-only string in "YYYY-MM-DD" form, or "" / null when unset. */
  value: string | null;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Heading shown at the top of the calendar sheet. */
  title?: string;
  error?: boolean;
  /**
   * Inclusive bounds as "YYYY-MM-DD". Days outside them are shown but cannot
   * be picked — the equivalent of a web date input's min/max, which is how a
   * from/to pair keeps itself from inverting.
   */
  minDate?: string | null;
  maxDate?: string | null;
  /** Offer strict MM/DD/YYYY entry in addition to the calendar. */
  allowTyping?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
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

  const idFor = (suffix: string) => (testID ? `${testID}-${suffix}` : `cal-${suffix}`);

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
        onPress={() => { setTyping(false); setOpen(true); }}
        testID={testID}
      >
        <Text style={[styles.triggerText, !label && styles.triggerPlaceholder]}>
          {label ?? placeholder}
        </Text>
        <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => { Keyboard.dismiss(); setOpen(false); }}>
        <KeyboardAvoidingView style={styles.keyboardContainer} behavior="padding">
        <Pressable style={styles.backdrop} onPress={() => { Keyboard.dismiss(); setOpen(false); }}>
          <DismissKeyboardView style={styles.sheet}>
            <Text style={styles.sheetTitle}>{title}</Text>
            {typing ? (
              <TypedCaseDateEntry
                value={value}
                minDate={minDate}
                maxDate={maxDate}
                testID={testID ?? "cal"}
                onBack={() => setTyping(false)}
                onCancel={() => setOpen(false)}
                onConfirm={(iso) => { onChange(iso); setOpen(false); }}
              />
            ) : (
            <>
            <View style={styles.calHeader}>
              <Pressable
                style={styles.calNav}
                onPress={() => setView((v) => shiftMonth(v, -1))}
                hitSlop={8}
                testID={idFor("prev")}
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
                testID={idFor("next")}
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
                const iso = ymd(view.y, view.m, d);
                const dayTestID = testID ? `${testID}-day-${d}` : `cal-day-${d}`;
                // Out of range: shown for context but not a target at all, so
                // no press path exists that could produce an invalid value.
                if ((!!minDate && iso < minDate) || (!!maxDate && iso > maxDate)) {
                  return (
                    <View
                      key={`d-${d}`}
                      style={styles.calCell}
                      accessibilityState={{ disabled: true }}
                      testID={dayTestID}
                    >
                      <Text style={[styles.calCellText, styles.calCellTextDisabled]}>
                        {d}
                      </Text>
                    </View>
                  );
                }
                return (
                  <Pressable
                    key={`d-${d}`}
                    style={[styles.calCell, isSel && styles.calCellSelected]}
                    onPress={() => {
                      onChange(iso);
                      setOpen(false);
                    }}
                    testID={dayTestID}
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
            {allowTyping && <Pressable
              style={styles.typeButton}
              onPress={() => setTyping(true)}
              accessibilityRole="button"
              accessibilityLabel="Type date in MM/DD/YYYY format"
              testID={idFor("type")}
            >
              <Ionicons name="create-outline" size={18} color={colors.tint} />
              <Text style={styles.footerBtnText}>Type date (MM/DD/YYYY)</Text>
            </Pressable>}
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
              <Pressable style={styles.footerBtn} onPress={() => setOpen(false)}>
                <Text style={styles.footerBtnText}>Cancel</Text>
              </Pressable>
            </View>
            </>
            )}
          </DismissKeyboardView>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    keyboardContainer: { flex: 1 },
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
    calCellTextDisabled: { color: c.textTertiary, opacity: 0.4 },
    calFooter: {
      flexDirection: "row",
      justifyContent: "space-between",
    },
    typeButton: { flexDirection: "row", gap: Spacing.sm, alignItems: "center", alignSelf: "center", padding: Spacing.sm },
    footerBtn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
    footerBtnText: { ...Typography.bodySemibold, color: c.tint },
  });
}
