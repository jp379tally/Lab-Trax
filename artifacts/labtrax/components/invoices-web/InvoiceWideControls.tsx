import React, { useMemo } from "react";
import { View, Text, Pressable, TextInput, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

export type SelectOption = { value: string; label: string; disabled?: boolean };

/** Native DOM select, rendered on web only (this component is web-wide only). */
export function WebSelect({ value, options, onChange, label, testID, width = 128 }: {
  value: string; options: SelectOption[]; onChange: (v: string) => void; label: string; testID: string; width?: number;
}) {
  const { colors } = useTheme();
  return React.createElement(
    "select",
    {
      value, "aria-label": label, "data-testid": testID,
      onChange: (e: { target: { value: string } }) => onChange(e.target.value),
      style: {
        height: 34, width, padding: "0 8px", borderRadius: 10, border: `1px solid ${colors.border}`,
        background: colors.surface, color: colors.text, fontSize: 13, fontFamily: "inherit", cursor: "pointer",
      },
    },
    options.map((o) => React.createElement("option", { key: o.value, value: o.value, label: o.label, disabled: o.disabled })),
  );
}

export function InvoiceWideToolbar(props: {
  search: string; onSearch: (v: string) => void;
  statusKey: string; statusOptions: SelectOption[]; onStatus: (v: string) => void;
  dateValue: string; dateOptions: SelectOption[]; onDate: (v: string) => void;
  ageValue: string; ageOptions: SelectOption[]; onAge: (v: string) => void;
  doctorValue: string; doctorOptions: SelectOption[]; onDoctor: (v: string) => void;
  aiOnly: boolean; onAiOnly: () => void;
  activeCount: number; onOpenFilters: () => void;
  showClear: boolean; onClear: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => StyleSheet.create({
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
    search: { flexGrow: 1, flexBasis: 220, maxWidth: 340, minHeight: 34, flexDirection: "row", alignItems: "center", gap: Spacing.xs, paddingHorizontal: Spacing.sm, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    input: { ...Typography.caption, color: colors.text, flex: 1, paddingVertical: 4 },
    btn: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: Spacing.sm, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    btnActive: { borderColor: colors.tint, backgroundColor: colors.tintLight },
    text: { ...Typography.captionSemibold, color: colors.textSecondary },
    textActive: { color: colors.tint },
    clear: { minHeight: 34, justifyContent: "center", paddingHorizontal: Spacing.sm },
    clearText: { ...Typography.captionSemibold, color: colors.error },
  }), [colors]);
  return (
    <View style={s.bar} testID="invoice-wide-toolbar">
      <View style={s.search}>
        <Ionicons name="search" size={15} color={colors.textTertiary} />
        <TextInput value={props.search} onChangeText={props.onSearch} placeholder="Search invoices" placeholderTextColor={colors.textTertiary}
          style={s.input} autoCapitalize="none" testID="invoice-search" accessibilityLabel="Search invoices" />
        {props.search ? <Pressable onPress={() => props.onSearch("")} hitSlop={8} testID="search-clear" accessibilityLabel="Clear search">
          <Ionicons name="close-circle" size={16} color={colors.textTertiary} /></Pressable> : null}
      </View>
      <WebSelect label="Status" testID="invoice-select-status" value={props.statusKey} options={props.statusOptions} onChange={props.onStatus} />
      <WebSelect label="Date range" testID="invoice-select-date" value={props.dateValue} options={props.dateOptions} onChange={props.onDate} />
      <WebSelect label="Age" testID="invoice-select-age" value={props.ageValue} options={props.ageOptions} onChange={props.onAge} />
      <WebSelect label="Doctor" testID="invoice-select-doctor" value={props.doctorValue} options={props.doctorOptions} onChange={props.onDoctor} width={140} />
      <Pressable onPress={props.onAiOnly} style={[s.btn, props.aiOnly && s.btnActive]} accessibilityRole="checkbox" accessibilityState={{ checked: props.aiOnly }} testID="invoice-ai-only">
        <Text style={[s.text, props.aiOnly && s.textActive]}>AI only</Text>
      </Pressable>
      <Pressable onPress={props.onOpenFilters} style={[s.btn, props.activeCount > 0 && s.btnActive]} testID="filters-open"
        accessibilityLabel={`Filters${props.activeCount ? `, ${props.activeCount} active` : ""}`}>
        <Ionicons name="options-outline" size={15} color={props.activeCount ? colors.tint : colors.textSecondary} />
        <Text style={[s.text, props.activeCount > 0 && s.textActive]}>Filters{props.activeCount ? ` (${props.activeCount})` : ""}</Text>
      </Pressable>
      {props.showClear ? <Pressable onPress={props.onClear} style={s.clear} testID="clear-all"><Text style={s.clearText}>Clear</Text></Pressable> : null}
    </View>
  );
}
