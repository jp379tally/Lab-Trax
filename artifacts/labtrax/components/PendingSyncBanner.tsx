import React, { useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useApp } from "@/lib/app-context";

export function PendingSyncBanner() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { pendingSyncCount, stuckSyncItems, retrySync, discardSync } = useApp();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const stuckCount = stuckSyncItems.length;
  const paddingTop = insets.top > 0 ? insets.top : Platform.OS === "android" ? 8 : 8;

  // Some offline changes have repeatedly failed to sync — warn the user and
  // offer a way to retry or discard them so a wedged item stops blocking the
  // rest of the queue.
  if (stuckCount > 0) {
    const label =
      stuckCount === 1
        ? "1 change couldn't sync"
        : `${stuckCount} changes couldn't sync`;

    const confirmDiscard = () => {
      const single = stuckCount === 1;
      Alert.alert(
        single ? "Discard this change?" : "Discard these changes?",
        single
          ? "This offline change will be permanently removed and won't be saved to the server."
          : `These ${stuckCount} offline changes will be permanently removed and won't be saved to the server.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              for (const item of stuckSyncItems) {
                discardSync(item.id);
              }
            },
          },
        ]
      );
    };

    return (
      <View style={[styles.errorContainer, { paddingTop }]}>
        <Ionicons
          name="alert-circle-outline"
          size={16}
          color={colors.errorText}
          style={styles.icon}
        />
        <Text style={styles.errorText} numberOfLines={1}>
          {label}
        </Text>
        <Pressable
          onPress={() => retrySync()}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          accessibilityRole="button"
          accessibilityLabel="Retry syncing offline changes"
        >
          <Text style={styles.actionText}>Retry</Text>
        </Pressable>
        <Pressable
          onPress={confirmDiscard}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          accessibilityRole="button"
          accessibilityLabel="Discard offline changes that couldn't sync"
        >
          <Text style={styles.discardText}>Discard</Text>
        </Pressable>
      </View>
    );
  }

  if (pendingSyncCount <= 0) {
    return null;
  }

  const label =
    pendingSyncCount === 1
      ? "1 offline change waiting to sync\u2026"
      : `${pendingSyncCount} offline changes waiting to sync\u2026`;

  return (
    <View style={[styles.container, { paddingTop }]}>
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
    errorContainer: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.errorLight,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.error,
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
    errorText: {
      flex: 1,
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorText,
    },
    action: {
      flexShrink: 0,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
    },
    actionPressed: {
      opacity: 0.6,
    },
    actionText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorText,
    },
    discardText: {
      fontSize: 12,
      fontFamily: "Inter_500Medium",
      color: colors.textSecondary,
    },
  });
