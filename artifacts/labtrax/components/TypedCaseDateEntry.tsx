import React, { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Keyboard } from "react-native";
import { formatCalendarDate } from "@workspace/calendar-date";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { parseTypedCaseDate } from "@/lib/typed-case-date";

export function TypedCaseDateEntry({
  value,
  onConfirm,
  onBack,
  onCancel,
  minDate,
  maxDate,
  testID = "cal",
}: {
  value: string | null;
  onConfirm: (iso: string) => void;
  onBack: () => void;
  onCancel: () => void;
  minDate?: string | null;
  maxDate?: string | null;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [draft, setDraft] = useState(() => formatCalendarDate(value ?? "") ?? "");
  const [error, setError] = useState("");

  function confirm() {
    const iso = parseTypedCaseDate(draft);
    if (!iso) {
      setError("Enter a real date in MM/DD/YYYY format.");
    } else if ((minDate && iso < minDate) || (maxDate && iso > maxDate)) {
      setError(`Choose a date${minDate ? ` on or after ${formatCalendarDate(minDate)}` : ""}${maxDate ? ` on or before ${formatCalendarDate(maxDate)}` : ""}.`);
    } else {
      Keyboard.dismiss();
      onConfirm(iso);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Type a date (MM/DD/YYYY)</Text>
      <TextInput
        value={draft}
        onChangeText={(text) => { setDraft(text); setError(""); }}
        placeholder="MM/DD/YYYY"
        placeholderTextColor={colors.textTertiary}
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={10}
        accessibilityLabel="Date in MM/DD/YYYY format"
        accessibilityHint="Enter a two-digit month, two-digit day, and four-digit year"
        style={[styles.input, !!error && styles.inputError]}
        testID={`${testID}-typed-input`}
      />
      {!!error && <Text style={styles.error} accessibilityRole="alert" testID={`${testID}-typed-error`}>{error}</Text>}
      <View style={styles.actions}>
        <Pressable onPress={() => { Keyboard.dismiss(); onBack(); }} style={styles.back} testID={`${testID}-typed-back`}>
          <Text style={styles.backText}>Calendar</Text>
        </Pressable>
        <Pressable onPress={() => { Keyboard.dismiss(); onCancel(); }} style={styles.back} testID={`${testID}-typed-cancel`}>
          <Text style={styles.backText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={confirm} style={styles.confirm} testID={`${testID}-typed-confirm`}>
          <Text style={styles.confirmText}>Use date</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: { gap: Spacing.md },
    label: { ...Typography.bodySemibold, color: c.text },
    input: {
      ...Typography.body,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      padding: Spacing.md,
    },
    inputError: { borderColor: c.error },
    error: { ...Typography.caption, color: c.error },
    actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    back: { paddingVertical: Spacing.md },
    backText: { ...Typography.bodySemibold, color: c.tint },
    confirm: { padding: Spacing.md, backgroundColor: c.tint, borderRadius: Radius.md },
    confirmText: { ...Typography.bodySemibold, color: c.textInverse },
  });
}