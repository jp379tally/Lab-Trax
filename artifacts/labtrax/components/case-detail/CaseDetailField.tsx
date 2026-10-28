import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useTheme } from "@/lib/theme-context";

/** Local to case Overview: do not change the typography of other case surfaces. */
export const caseDetailFieldStyles = StyleSheet.create({
  field: { width: "100%", minWidth: 0, gap: Spacing.sm },
  heading: { ...Typography.h3, fontFamily: "Inter_700Bold", fontWeight: "700" },
  control: {
    width: "100%", minWidth: 0, minHeight: 48,
    borderWidth: 1, borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
  },
  value: { ...Typography.body, minWidth: 0, flexShrink: 1, flexGrow: 1 },
  input: {
    ...Typography.body, width: "100%", minWidth: 0, minHeight: 48,
    borderWidth: 1, borderRadius: Radius.sm, padding: Spacing.md,
  },
  options: { width: "100%", minWidth: 0, borderWidth: 1, borderRadius: Radius.sm },
  option: {
    minHeight: 48, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
  },
});

export function CaseDetailField({ label, children, testID, labelTestID }: {
  label: string;
  children: React.ReactNode;
  testID?: string;
  labelTestID?: string;
}) {
  const { colors } = useTheme();
  return <View style={caseDetailFieldStyles.field} testID={testID}>
    <Text testID={labelTestID} style={[caseDetailFieldStyles.heading, { color: colors.text }]}>{label}</Text>
    {children}
  </View>;
}

export function CaseDetailSelect({
  label, valueLabel, testID, valueTestID, labelTestID, onPress,
  expanded = false, disabled = false, busy = false, invalid = false, accessibilityLabel,
}: {
  label: string;
  valueLabel: string;
  testID?: string;
  valueTestID?: string;
  labelTestID?: string;
  onPress?: () => void;
  expanded?: boolean;
  disabled?: boolean;
  busy?: boolean;
  invalid?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const text = <Text testID={valueTestID}
    style={[caseDetailFieldStyles.value, { color: colors.text }]}>{valueLabel}</Text>;
  return <CaseDetailField label={label} labelTestID={labelTestID ?? (testID ? `${testID}-label` : undefined)}>
    {onPress ? <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel ?? label}: ${valueLabel}`}
      accessibilityHint={expanded ? "Activate to close options without changing the value." : "Activate to choose an option."}
      accessibilityState={{ expanded, disabled: disabled || busy, busy }}
      aria-expanded={expanded}
      aria-disabled={disabled || busy}
      aria-busy={busy}
      disabled={disabled || busy}
      onPress={onPress}
      style={[caseDetailFieldStyles.control, {
        borderColor: invalid ? colors.error : colors.border,
        backgroundColor: colors.surfaceSecondary,
        opacity: disabled || busy ? 0.65 : 1,
      }]}
    >
      {text}
      {busy ? <ActivityIndicator size="small" color={colors.tint} /> :
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />}
    </Pressable> : text}
  </CaseDetailField>;
}

export interface CaseDetailOption {
  key: string;
  label: string;
}

export function CaseDetailOptions({ label, options, selected, onSelect, optionTestID, disabled = false }: {
  label: string;
  options: ReadonlyArray<CaseDetailOption>;
  selected: string | null;
  onSelect: (key: string) => void;
  optionTestID: (key: string) => string;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return <View style={[caseDetailFieldStyles.options, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    {options.map((option) => <Pressable
      key={option.key}
      testID={optionTestID(option.key)}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${option.label}`}
      accessibilityState={{ selected: selected === option.key, disabled }}
      aria-pressed={selected === option.key}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => { if (!disabled) onSelect(option.key); }}
      style={caseDetailFieldStyles.option}
    >
      <Text style={[caseDetailFieldStyles.value, { color: selected === option.key ? colors.tint : colors.text }]}>{option.label}</Text>
      {selected === option.key ? <Ionicons name="checkmark" size={18} color={colors.tint} /> : null}
    </Pressable>)}
  </View>;
}
