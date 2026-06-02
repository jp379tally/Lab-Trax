import React, { useMemo } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useApp } from "@/lib/app-context";

export function PendingSyncBanner() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { pendingSyncCount } = useApp();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (pendingSyncCount <= 0) {
    return null;
  }

  const label =
    pendingSyncCount === 1
      ? "1 offline change waiting to sync\u2026"
      : `${pendingSyncCount} offline changes waiting to sync\u2026`;

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top > 0 ? insets.top : Platform.OS === "android" ? 8 : 8,
        },
      ]}
    >
      <Ionicons
        name="cloud-upload-outline"
        size={15}
        color={colors.info}
        style={styles.icon}
      />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.infoLight,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.info,
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
      fontFamily: "Inter_500Medium",
      color: colors.info,
    },
  });
