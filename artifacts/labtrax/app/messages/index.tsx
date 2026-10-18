// Messenger inbox — lists every provider↔lab conversation the signed-in user
// participates in, and (for providers) lets them start a new conversation
// with any lab they have cases with. Mirrors the desktop Inbox / "Message My
// Lab" tab, backed by the same GET /provider-messenger/threads endpoint.
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { useMe, primaryProviderOrgId } from "@/lib/auth-me";
import {
  useMessengerThreads,
  useProviderLinkedLabs,
  getOrCreateProviderThread,
  type MessengerThreadSummary,
} from "@/lib/messenger";

function threadOtherPartyName(t: MessengerThreadSummary, myProviderOrgId: string | null): string {
  if (myProviderOrgId && t.providerOrganizationId === myProviderOrgId) {
    return t.labOrganizationName || "Lab";
  }
  return t.providerOrganizationName || "Provider";
}

function formatRelativeTime(isoStr: string | null): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const now = new Date();
  const diffMins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  return parts.length > 1
    ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
    : trimmed.slice(0, 2).toUpperCase();
}

export default function MessagesInboxScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const meQuery = useMe();
  const providerOrgId = primaryProviderOrgId(meQuery.data);
  const isProvider = !!providerOrgId;

  const threadsQuery = useMessengerThreads();
  const { labs, isLoading: labsLoading } = useProviderLinkedLabs(isProvider);
  const [connectingLabId, setConnectingLabId] = useState<string | null>(null);

  const threads = threadsQuery.data ?? [];
  const isRefreshing = threadsQuery.isFetching && !threadsQuery.isLoading;

  const existingLabIds = useMemo(
    () => new Set(threads.map((t) => t.labOrganizationId)),
    [threads],
  );
  const newLabs = isProvider ? labs.filter((l) => !existingLabIds.has(l.id)) : [];

  async function openThread(threadId: string, name: string) {
    router.push({ pathname: "/messages/[threadId]", params: { threadId, name } } as never);
  }

  async function startConversation(labId: string, labName: string) {
    setConnectingLabId(labId);
    try {
      const thread = await getOrCreateProviderThread(labId);
      await threadsQuery.refetch();
      await openThread(thread.id, labName);
    } catch (err: any) {
      Alert.alert("Could not start conversation", err?.message ?? "Please try again.");
    } finally {
      setConnectingLabId(null);
    }
  }

  const isInitialLoading = threadsQuery.isLoading || (isProvider && labsLoading && threads.length === 0);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} testID="messages-back">
          <Ionicons name="chevron-back" size={20} color={colors.tint} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Messages</Text>
          <Text style={styles.subtitle}>
            {isProvider ? "Chat with your lab" : "Conversations with providers"}
          </Text>
        </View>
      </View>

      {isInitialLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.tint} />
        </View>
      ) : threadsQuery.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Could not load your messages.</Text>
          <Pressable style={styles.retryBtn} onPress={() => threadsQuery.refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={() => threadsQuery.refetch()} tintColor={colors.tint} />
          }
        >
          {threads.length === 0 && newLabs.length === 0 && (
            <View style={styles.emptyContainer}>
              <Ionicons name="chatbubbles-outline" size={48} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>
                {isProvider ? "No lab linked yet" : "No messages yet"}
              </Text>
              <Text style={styles.emptySubtitle}>
                {isProvider
                  ? "Contact your lab to get connected."
                  : "Conversations from your linked providers will appear here."}
              </Text>
            </View>
          )}

          {threads.length > 0 && (
            <View style={styles.section}>
              {threads.map((t) => {
                const name = threadOtherPartyName(t, providerOrgId);
                const preview = t.latestMessagePreview?.body || "No messages yet";
                return (
                  <Card
                    key={t.id}
                    style={styles.row}
                    onPress={() => openThread(t.id, name)}
                    testID={`thread-row-${t.id}`}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{initialsFor(name)}</Text>
                    </View>
                    <View style={styles.rowMain}>
                      <View style={styles.rowTopLine}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{name}</Text>
                        <Text style={styles.rowTime}>{formatRelativeTime(t.lastMessageAt)}</Text>
                      </View>
                      <Text
                        style={[styles.rowPreview, t.unreadCount > 0 && styles.rowPreviewUnread]}
                        numberOfLines={1}
                      >
                        {preview}
                      </Text>
                    </View>
                    {t.unreadCount > 0 && (
                      <View style={styles.badge} testID={`thread-unread-${t.id}`}>
                        <Text style={styles.badgeText}>{t.unreadCount > 99 ? "99+" : t.unreadCount}</Text>
                      </View>
                    )}
                  </Card>
                );
              })}
            </View>
          )}

          {newLabs.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Start a conversation</Text>
              {newLabs.map((lab) => (
                <Card
                  key={lab.id}
                  style={styles.row}
                  onPress={() => startConversation(lab.id, lab.name)}
                  testID={`start-thread-${lab.id}`}
                >
                  <View style={[styles.avatar, styles.avatarMuted]}>
                    <Ionicons name="add" size={20} color={colors.tint} />
                  </View>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{lab.name}</Text>
                    <Text style={styles.rowPreview}>Send your first message</Text>
                  </View>
                  {connectingLabId === lab.id && <ActivityIndicator size="small" color={colors.tint} />}
                </Card>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.sm, gap: Spacing.sm },
    backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    headerText: { flex: 1 },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.md },
    errorText: { ...Typography.body, color: c.textSecondary },
    retryBtn: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, backgroundColor: c.tint, borderRadius: Radius.md },
    retryText: { ...Typography.bodyMedium, color: c.textInverse },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xl, flexGrow: 1 },
    section: { gap: Spacing.sm },
    sectionLabel: { ...Typography.label, color: c.textSecondary, textTransform: "uppercase", marginBottom: 2 },
    emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: Spacing.huge, gap: Spacing.sm },
    emptyTitle: { ...Typography.h3, color: c.text, marginTop: Spacing.sm },
    emptySubtitle: { ...Typography.body, color: c.textSecondary, textAlign: "center", paddingHorizontal: Spacing.xl },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    avatar: { width: 44, height: 44, borderRadius: Radius.full, backgroundColor: c.tint, alignItems: "center", justifyContent: "center" },
    avatarMuted: { backgroundColor: c.tint + "1A" },
    avatarText: { ...Typography.bodySemibold, color: c.textInverse },
    rowMain: { flex: 1, gap: 2, minWidth: 0 },
    rowTopLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    rowTitle: { ...Typography.bodyLgMedium, color: c.text, flexShrink: 1 },
    rowTime: { ...Typography.caption, color: c.textTertiary },
    rowPreview: { ...Typography.caption, color: c.textSecondary },
    rowPreviewUnread: { color: c.text, fontFamily: "Inter_600SemiBold" },
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: Radius.full,
      paddingHorizontal: 7,
      backgroundColor: "#ef4444",
      alignItems: "center",
      justifyContent: "center",
    },
    badgeText: { ...Typography.captionSemibold, color: "#ffffff" },
  });
}
