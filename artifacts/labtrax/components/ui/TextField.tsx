import React, { useMemo } from "react";
import { View, Text, TextInput, StyleSheet, type TextInputProps } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface TextFieldProps extends Omit<TextInputProps, "style"> {
  label?: string;
  required?: boolean;
  error?: boolean;
  hint?: string;
  multiline?: boolean;
}

/**
 * TextField — labeled text input matching the new-case form styling, used by the
 * editable management screens (Lists, Pricing). Keeps input styling in one place.
 */
export function TextField({
  label,
  required,
  error,
  hint,
  multiline,
  ...inputProps
}: TextFieldProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.field}>
      {label ? (
        <Text style={styles.label}>
          {label}
          {required ? <Text style={styles.required}> *</Text> : null}
        </Text>
      ) : null}
      <TextInput
        style={[styles.input, multiline && styles.textArea, error && styles.inputError]}
        placeholderTextColor={colors.textTertiary}
        multiline={multiline}
        {...inputProps}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    field: { gap: Spacing.xs },
    label: { ...Typography.captionSemibold, color: c.textSecondary },
    required: { color: c.error },
    input: {
      ...Typography.body,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    textArea: { minHeight: 80, textAlignVertical: "top" },
    inputError: { borderColor: c.error },
    hint: { ...Typography.caption, color: c.textTertiary },
  });
}
