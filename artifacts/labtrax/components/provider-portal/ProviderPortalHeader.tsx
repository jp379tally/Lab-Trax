// Provider portal heads-up display.
//
// Mirrors the desktop ProviderPortalLayout header: who is signed in, which
// practice account they are looking at, a practice switcher when the account
// is linked to more than one, the notification bell with its unread dot, the
// settings entry, and sign out — plus the surface that reports a failed
// practice switch.
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useAuth } from "@/lib/auth-context";
import { useMe } from "@/lib/auth-me";
import {
  useInAppNotifications,
  useNotificationActions,
  type InAppNotification,
} from "@/lib/in-app-notifications";
import { useProviderPractice } from "@/lib/provider-practice";
import type { ProviderPortalSection } from "@/components/provider-portal/sections";

export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Where a notification takes the provider, mirroring the desktop portal:
 * payment notifications open the billing section, and a shared note or
 * attachment opens the Dashboard with that case's detail showing.
 */
export function notificationTarget(
  notification: Pick<InAppNotification, "type" | "dataJson">,
): { section: ProviderPortalSection; caseId?: string } | null {
  if (
    notification.type === "lab_payment_recorded" ||
    notification.type === "payment_reversed" ||
    notification.type === "provider_payment_received"
  ) {
    return { section: "billing" };
  }
  if (
    notification.type === "shared_note" ||
    notification.type === "shared_note_added" ||
    notification.type === "shared_attachment_added"
  ) {
    const caseId = notification.dataJson?.caseId;
    if (typeof caseId === "string" && caseId) {
      return { section: "dashboard", caseId };
    }
  }
  return null;
}

interface ProviderPortalHeaderProps {
  onOpenNavigation: () => void;
  onOpenSettings: () => void;
  onOpenNotification: (target: { section: ProviderPortalSection; caseId?: string }) => void;
}

export function ProviderPortalHeader({
  onOpenNavigation,
  onOpenSettings,
  onOpenNotification,
}: ProviderPortalHeaderProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { currentUser, logout } = useAuth();
  const me = useMe();
  const practice = useProviderPractice();
  const insets = useSafeAreaInsets();
  const notifications = useInAppNotifications();
  const notificationActions = useNotificationActions();
  const [bellOpen, setBellOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const user = (me.data?.user ?? null) as
    | { firstName?: string | null; username?: string | null; practiceAccountNumber?: string | null }
    | null;
  const displayName =
    user?.firstName?.trim() || user?.username?.trim() || currentUser || "Provider";
  // Prefer the selected practice's own account number so a switch updates the
  // heads-up display; /api/auth/me only ever carries the primary practice.
  const accountNumber =
    practice.selectedPractice?.accountNumber ?? user?.practiceAccountNumber ?? null;

  const closeBell = useCallback(async () => {
    setBellOpen(false);
    try {
      await notificationActions.markAllRead();
    } catch {
      // Best-effort, exactly as on desktop.
    }
  }, [notificationActions]);

  const openNotification = useCallback(
    (item: InAppNotification) => {
      setBellOpen(false);
      if (!item.readAt) {
        void notificationActions.markRead(item.id).catch(() => {});
      }
      const target = notificationTarget(item);
      if (target) onOpenNotification(target);
    },
    [notificationActions, onOpenNotification],
  );

  const items = notifications.items;
  const hasUnread = notifications.unreadCount > 0;

  return (
    <View testID="provider-portal-header">
      <View style={styles.header}>
        <Pressable
          onPress={onOpenNavigation}
          style={styles.menuButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open navigation menu"
          accessibilityHint="Shows provider portal sections"
          testID="provider-portal-menu"
        >
          <Ionicons name="menu" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.identity}>
          <Text style={styles.title} numberOfLines={1}>
            My Cases
          </Text>
          <Text
            style={styles.subtitle}
            numberOfLines={1}
            testID="provider-portal-identity"
          >
            {displayName}
            {accountNumber ? ` · ${accountNumber}` : ""}
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => setBellOpen(true)}
            style={styles.iconButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            testID="provider-portal-bell"
          >
            <Ionicons name="notifications-outline" size={19} color={colors.textSecondary} />
            {hasUnread ? (
              <View style={styles.unreadDot} testID="provider-portal-bell-unread" />
            ) : null}
          </Pressable>

          <Pressable
            onPress={onOpenSettings}
            style={styles.iconButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            testID="provider-portal-settings"
          >
            <Ionicons name="settings-outline" size={19} color={colors.textSecondary} />
          </Pressable>

          <Pressable
            onPress={() => logout()}
            style={styles.signOut}
            accessibilityRole="button"
            testID="provider-portal-sign-out"
          >
            <Text style={styles.signOutLabel}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      {practice.practices.length > 1 ? (
        <Pressable
          onPress={() => setSwitcherOpen(true)}
          style={styles.switcher}
          accessibilityRole="button"
          accessibilityLabel="Active practice"
          testID="provider-practice-switcher"
        >
          <Ionicons name="business-outline" size={15} color={colors.tint} />
          <Text style={styles.switcherLabel} numberOfLines={1}>
            {practice.selectedPractice?.name ?? "Select practice…"}
          </Text>
          <Ionicons name="chevron-down" size={14} color={colors.textTertiary} />
        </Pressable>
      ) : null}

      {practice.switchError ? (
        <View style={styles.errorBar} testID="provider-portal-switch-error">
          <Text style={styles.errorText}>{practice.switchError}</Text>
          <Pressable
            onPress={practice.clearSwitchError}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss practice switch error"
          >
            <Ionicons name="close" size={16} color={colors.error} />
          </Pressable>
        </View>
      ) : null}

      <Modal
        visible={switcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSwitcherOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setSwitcherOpen(false)}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.xxl) }]} testID="provider-practice-sheet">
            <Text style={styles.sheetTitle}>Active practice</Text>
            <ScrollView>
              {practice.practices.map((row) => (
                <Pressable
                  key={row.id}
                  onPress={() => {
                    setSwitcherOpen(false);
                    if (row.id !== practice.selectedPracticeId) {
                      practice.selectPractice(row.id);
                    }
                  }}
                  style={styles.sheetRow}
                  accessibilityRole="button"
                  testID={`provider-practice-option-${row.id}`}
                >
                  <View style={styles.sheetRowMain}>
                    <Text style={styles.sheetRowTitle} numberOfLines={1}>
                      {row.name}
                    </Text>
                    {row.accountNumber ? (
                      <Text style={styles.sheetRowMeta} numberOfLines={1}>
                        {row.accountNumber}
                      </Text>
                    ) : null}
                  </View>
                  {row.id === practice.selectedPracticeId ? (
                    <Ionicons name="checkmark" size={18} color={colors.tint} />
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={bellOpen}
        transparent
        animationType="fade"
        onRequestClose={() => void closeBell()}
      >
        <Pressable style={styles.backdrop} onPress={() => void closeBell()}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.xxl) }]} testID="provider-portal-notifications">
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Notifications</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close notifications" testID="provider-portal-notifications-close" onPress={() => void closeBell()}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
              {notifications.isLoading ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : null}
            </View>
            {notifications.isError ? (
              <Pressable onPress={() => void notifications.refetch()} accessibilityRole="button">
                <Text style={styles.empty}>Could not load notifications. Tap to try again.</Text>
              </Pressable>
            ) : items.length === 0 ? (
              <Text style={styles.empty}>No new alerts</Text>
            ) : (
              <ScrollView>
                {items.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => openNotification(item)}
                    style={styles.notifRow}
                    accessibilityRole="button"
                    testID={`provider-portal-notification-${item.id}`}
                  >
                    <View style={styles.sheetRowMain}>
                      <View style={styles.notifTitleRow}>
                        {!item.readAt ? <View style={styles.notifDot} /> : null}
                        <Text style={styles.notifTitle} numberOfLines={1}>
                          {item.title}
                        </Text>
                      </View>
                      <Text style={styles.notifBody} numberOfLines={2}>
                        {item.body}
                      </Text>
                    </View>
                    <Text style={styles.notifTime}>{relativeTime(item.createdAt)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    identity: { flex: 1, gap: 2 },
    menuButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { ...Typography.h3, color: colors.text },
    subtitle: { ...Typography.caption, color: colors.textSecondary },
    actions: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    iconButton: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.sm,
    },
    unreadDot: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.error,
    },
    signOut: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    signOutLabel: { ...Typography.captionMedium, color: colors.text },
    switcher: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    switcherLabel: { ...Typography.captionMedium, color: colors.text, flex: 1 },
    errorBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      backgroundColor: colors.errorSurface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.errorLight,
    },
    errorText: { ...Typography.caption, color: colors.errorText, flex: 1 },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.35)",
      justifyContent: "flex-end",
    },
    sheet: {
      maxHeight: "70%",
      backgroundColor: colors.surface,
      borderTopLeftRadius: Radius.lg,
      borderTopRightRadius: Radius.lg,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      paddingBottom: Spacing.xxl,
      gap: Spacing.sm,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sheetTitle: { ...Typography.h3, color: colors.text },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    sheetRowMain: { flex: 1, gap: 2 },
    sheetRowTitle: { ...Typography.bodyMedium, color: colors.text },
    sheetRowMeta: { ...Typography.caption, color: colors.textSecondary },
    empty: {
      ...Typography.caption,
      color: colors.textSecondary,
      textAlign: "center",
      paddingVertical: Spacing.xxl,
    },
    notifRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    notifTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    notifDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.tint,
    },
    notifTitle: { ...Typography.captionSemibold, color: colors.text, flex: 1 },
    notifBody: { ...Typography.caption, color: colors.textSecondary },
    notifTime: { ...Typography.tiny, color: colors.textTertiary },
  });
}
