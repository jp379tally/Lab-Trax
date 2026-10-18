import React, { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  type InAppNotification,
  useInAppNotifications,
  useNotificationActions,
} from "@/lib/in-app-notifications";

function destination(item: InAppNotification): string | null {
  if (
    item.type === "provider_account_change_requested" ||
    item.type === "provider_account_change_decided"
  ) {
    const labOrganizationId = item.dataJson?.labOrganizationId;
    const providerOrganizationId = item.dataJson?.providerOrganizationId;
    const requestId = item.dataJson?.requestId;
    if (
      typeof labOrganizationId === "string" &&
      typeof providerOrganizationId === "string"
    ) {
      const query = new URLSearchParams({
        labOrganizationId,
        providerOrganizationId,
      });
      if (typeof requestId === "string") query.set("requestId", requestId);
      return `/settings/shared-account?${query.toString()}`;
    }
    return null;
  }
  if (item.type === "lab_payment_recorded") return "/settings/provider-billing";
  if (item.type === "payment_reversed") {
    return item.dataJson?.billingDestination === "provider_billing"
      ? "/settings/provider-billing"
      : "/financial";
  }
  if (item.type === "provider_payment_received") return "/financial";
  const caseId = item.dataJson?.caseId;
  return typeof caseId === "string" ? `/case/${caseId}` : null;
}

export default function NotificationInboxScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const query = useInAppNotifications();
  const actions = useNotificationActions();
  useFocusEffect(useCallback(() => {
    void query.refetch();
  }, [query.refetch]));

  const open = async (item: InAppNotification) => {
    if (!item.readAt) await actions.markRead(item.id);
    const target = destination(item);
    if (target) router.push(target as never);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Notifications</Text>
        <Pressable onPress={() => void actions.markAllRead()} disabled={!query.unreadCount}>
          <Text style={[styles.action, !query.unreadCount && styles.disabled]}>Read all</Text>
        </Pressable>
      </View>
      {query.isLoading ? (
        <ActivityIndicator style={styles.loading} color={colors.tint} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {query.items.length === 0 ? (
            <Text style={styles.empty}>No notifications yet.</Text>
          ) : query.items.map((item) => (
            <Pressable key={item.id} style={[styles.item, !item.readAt && styles.unread]} onPress={() => void open(item)}>
              <View style={styles.itemTop}>
                {!item.readAt ? <View style={styles.dot} /> : null}
                <Text style={styles.itemTitle}>{item.title}</Text>
              </View>
              <Text style={styles.body}>{item.body}</Text>
              <Text style={styles.date}>{new Date(item.createdAt).toLocaleString()}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: { height: 56, paddingHorizontal: Spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: c.border },
    title: { ...Typography.h3, color: c.text },
    action: { ...Typography.bodyMedium, color: c.tint },
    disabled: { opacity: 0.4 },
    loading: { marginTop: 40 },
    content: { padding: Spacing.md, gap: Spacing.sm },
    empty: { ...Typography.body, color: c.textSecondary, textAlign: "center", marginTop: 40 },
    item: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, padding: Spacing.md, backgroundColor: c.surface, gap: 6 },
    unread: { borderColor: c.tint, backgroundColor: `${c.tint}0D` },
    itemTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.tint },
    itemTitle: { ...Typography.bodyLgMedium, color: c.text, flex: 1 },
    body: { ...Typography.body, color: c.textSecondary },
    date: { ...Typography.caption, color: c.textTertiary },
  });
}