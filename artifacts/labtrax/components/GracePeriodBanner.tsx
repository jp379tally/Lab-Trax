import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

interface Props {
  graceDaysRemaining: number | null;
  onSubscribe: () => void;
  onDismiss: () => void;
}

export function GracePeriodBanner({ graceDaysRemaining, onSubscribe, onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const daysLabel =
    graceDaysRemaining === null
      ? "Your grace period is ending soon."
      : graceDaysRemaining <= 0
        ? "Your grace period has ended."
        : graceDaysRemaining === 1
          ? "1 day left in your grace period."
          : `${graceDaysRemaining} days left in your grace period.`;

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top > 0 ? insets.top : Platform.OS === "android" ? 8 : 8,
        },
      ]}
    >
      <Ionicons name="time-outline" size={15} color={colors.warningText} style={styles.icon} />
      <Text style={styles.text} numberOfLines={1}>
        {daysLabel}
      </Text>
      <Pressable
        onPress={onSubscribe}
        hitSlop={8}
        style={({ pressed }) => [styles.subscribeBtn, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.subscribeBtnText}>Subscribe</Text>
      </Pressable>
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}
      >
        <Ionicons name="close" size={15} color={colors.warningText} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.warningLight,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.warning,
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 6,
  },
  icon: {
    flexShrink: 0,
  },
  text: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.warningText,
  },
  subscribeBtn: {
    flexShrink: 0,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.warningStrong,
  },
  subscribeBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: colors.textInverse,
  },
  closeBtn: {
    flexShrink: 0,
    padding: 2,
  },
});
