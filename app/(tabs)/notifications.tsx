import React from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";
import { Notification } from "@/lib/data";

function getNotifIcon(type: Notification["type"]) {
  switch (type) {
    case "rush":
      return { name: "flash" as const, color: Colors.light.error, bg: Colors.light.errorLight };
    case "update":
      return { name: "swap-horizontal" as const, color: Colors.light.tint, bg: Colors.light.tintLight };
    case "complete":
      return { name: "checkmark-circle" as const, color: Colors.light.success, bg: Colors.light.successLight };
    case "alert":
      return { name: "alert-circle" as const, color: Colors.light.warning, bg: Colors.light.warningLight };
  }
}

function formatTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationsScreen() {
  const { notifications, markNotificationRead } = useApp();
  const insets = useSafeAreaInsets();

  function renderNotification({ item }: { item: Notification }) {
    const icon = getNotifIcon(item.type);
    return (
      <Pressable
        style={({ pressed }) => [
          styles.notifCard,
          !item.read && styles.notifCardUnread,
          pressed && { opacity: 0.7 },
        ]}
        onPress={() => {
          markNotificationRead(item.id);
          if (item.caseId) {
            router.push({
              pathname: "/case/[id]",
              params: { id: item.caseId },
            });
          }
        }}
      >
        <View style={[styles.notifIcon, { backgroundColor: icon.bg }]}>
          <Ionicons name={icon.name} size={20} color={icon.color} />
        </View>
        <View style={styles.notifContent}>
          <View style={styles.notifHeader}>
            <Text style={styles.notifTitle}>{item.title}</Text>
            <Text style={styles.notifTime}>{formatTime(item.timestamp)}</Text>
          </View>
          <Text style={styles.notifMessage} numberOfLines={2}>
            {item.message}
          </Text>
        </View>
        {!item.read && <View style={styles.unreadDot} />}
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 },
        ]}
      >
        <Text style={styles.title}>Notifications</Text>
      </View>
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={renderNotification}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 },
        ]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name="notifications-off-outline"
              size={48}
              color={Colors.light.textTertiary}
            />
            <Text style={styles.emptyText}>No notifications yet</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  listContent: {
    padding: 20,
    gap: 10,
  },
  notifCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    gap: 14,
  },
  notifCardUnread: {
    borderColor: Colors.light.tint + "40",
    backgroundColor: Colors.light.tintLight + "30",
  },
  notifIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  notifContent: {
    flex: 1,
  },
  notifHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  notifTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  notifTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  notifMessage: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    lineHeight: 19,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.light.tint,
    marginTop: 4,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
  },
});
