import React from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useTheme } from "@/lib/theme-context";
import { useDrawer } from "@/lib/drawer-context";
import { useProviderFilteredNotifications } from "@/lib/useFilteredNotifications";

interface AppHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  rightActions?: React.ReactNode;
  showSearch?: boolean;
  onSearch?: () => void;
  transparent?: boolean;
}

export function AppHeader({
  title,
  showBack = false,
  onBack,
  rightActions,
  showSearch = true,
  onSearch,
  transparent = false,
}: AppHeaderProps) {
  const { colors, isDark } = useTheme();
  const { openDrawer } = useDrawer();
  const insets = useSafeAreaInsets();
  const notifications = useProviderFilteredNotifications();
  const unreadCount = notifications.filter((n) => !n.read).length;

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: topPad + 8,
          backgroundColor: transparent
            ? "transparent"
            : isDark
            ? colors.surface
            : colors.surface,
          borderBottomColor: transparent ? "transparent" : colors.border,
          borderBottomWidth: transparent ? 0 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      <View style={styles.inner}>
        {showBack ? (
          <Pressable
            onPress={onBack ?? (() => router.back())}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={24} color={colors.tint} />
          </Pressable>
        ) : (
          <Pressable
            onPress={openDrawer}
            style={styles.iconBtn}
            hitSlop={8}
            testID="app-header-menu"
          >
            <Ionicons name="menu" size={24} color={colors.text} />
          </Pressable>
        )}

        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>

        <View style={styles.actions}>
          {showSearch && (
            <Pressable
              onPress={onSearch}
              style={styles.iconBtn}
              hitSlop={8}
            >
              <Ionicons name="search" size={22} color={colors.text} />
            </Pressable>
          )}
          {rightActions}
          <Pressable
            onPress={() => router.push("/(tabs)/notifications" as any)}
            style={styles.iconBtn}
            hitSlop={8}
          >
            <Ionicons name="notifications-outline" size={22} color={colors.text} />
            {unreadCount > 0 && (
              <View style={[styles.badge, { backgroundColor: colors.error }]}>
                <Text style={styles.badgeText}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingBottom: 10,
    paddingHorizontal: 4,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 8,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    position: "relative",
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  badge: {
    position: "absolute",
    top: 6,
    right: 6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  badgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
});
