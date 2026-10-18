import React, { useEffect, useRef, useState } from "react";
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
import { filterNamesByQuery } from "@workspace/item-name-match";
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

/**
 * How long the dropdown outlives a blur. Long enough that a tap landing on a
 * suggestion still finds it mounted — including when that same tap is what
 * closed the keyboard — and short enough that it disappears once focus really
 * has moved on.
 */
const DROPDOWN_LINGER_MS = 150;

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
  // filterText tracks what the user has typed since focusing.
  // It starts empty on every focus so a pre-filled (e.g. AI-supplied) value
  // never narrows the list before the user has had a chance to browse options.
  const [filterText, setFilterText] = useState("");
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearBlurTimer() {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }

  useEffect(() => clearBlurTimer, []);

  // Matching ignores case, punctuation and spacing (and ranks exact/prefix
  // hits first), so "ema" surfaces "E.max Crown" and "3 unit" finds
  // "3-Unit Bridge" — punctuation-insensitive matching comes from the shared
  // item-name-match workspace package.
  const trimmed = filterText.trim();
  const filtered = focused
    ? filterNamesByQuery(suggestions, trimmed).slice(0, maxSuggestions)
    : [];

  const showDropdown = focused && filtered.length > 0;

  function handleChangeText(text: string) {
    setFilterText(text);
    onChangeText(text);
  }

  function handleSelect(s: string) {
    // A suggestion tap arrives while the field is still blurring (and, with the
    // app-wide dismissal layer, possibly while that same tap closes the
    // keyboard). Drop the pending timer so the late blur can't re-open an empty
    // filter over the value we just applied.
    clearBlurTimer();
    onChangeText(s);
    setFilterText("");
    setFocused(false);
  }

  return (
    <View style={[{ zIndex: showDropdown ? 20 : 1 }, containerStyle]}>
      <TextInput
        value={value}
        onChangeText={handleChangeText}
        onFocus={() => {
          clearBlurTimer();
          setFilterText("");
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          clearBlurTimer();
          blurTimerRef.current = setTimeout(() => {
            blurTimerRef.current = null;
            setFilterText("");
            setFocused(false);
            onBlur?.();
          }, DROPDOWN_LINGER_MS);
        }}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        style={inputStyle}
        testID={testID}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        // Single line, so return/Done closes the keyboard rather than doing
        // nothing — matching TextField and the rest of the rollout.
        submitBehavior="blurAndSubmit"
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
