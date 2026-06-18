import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface SuggestionInputProps {
  value: string;
  onChangeText: (text: string) => void;
  suggestions: string[];
  placeholder?: string;
  placeholderTextColor?: string;
  inputStyle?: StyleProp<TextStyle>;
  containerStyle?: ViewStyle;
  testID?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
  maxSuggestions?: number;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function SuggestionInput({
  value,
  onChangeText,
  suggestions,
  placeholder,
  placeholderTextColor,
  inputStyle,
  containerStyle,
  testID,
  autoCapitalize,
  autoCorrect,
  maxSuggestions = 6,
  onFocus,
  onBlur,
}: SuggestionInputProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);

  const trimmed = value.trim().toLowerCase();
  const filtered =
    trimmed.length > 0
      ? suggestions
          .filter((s) => s.toLowerCase().includes(trimmed))
          .slice(0, maxSuggestions)
      : [];

  const showDropdown = focused && filtered.length > 0;

  function handleSelect(s: string) {
    onChangeText(s);
    setFocused(false);
  }

  return (
    <View style={[{ zIndex: showDropdown ? 20 : 1 }, containerStyle]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          setTimeout(() => {
            setFocused(false);
            onBlur?.();
          }, 150);
        }}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        style={inputStyle}
        testID={testID}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
      />
      {showDropdown ? (
        <View
          style={[
            styles.dropdown,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          {filtered.map((s) => (
            <Pressable
              key={s}
              onPress={() => handleSelect(s)}
              style={({ pressed }) => [
                styles.item,
                pressed && { backgroundColor: colors.backgroundSolid },
              ]}
              testID={`suggestion-${s}`}
            >
              <Text
                style={[styles.itemText, { color: colors.text }]}
                numberOfLines={1}
              >
                {s}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dropdown: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: "hidden",
    zIndex: 20,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  item: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  itemText: {
    ...Typography.body,
  },
});
