// Provider portal shell.
//
// The desktop portal is a left sidebar over a content pane; a phone gets the
// same five sections in an overlay drawer. Section state lives here (not in the
// router) for the same reason it does on desktop: switching sections must not
// unwind the portal, and a notification deep-link has to be able to land on a
// section AND hand it a case in one step.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { useProviderPractice } from "@/lib/provider-practice";
import { useMessengerUnreadCount } from "@/lib/messenger";
import {
  hasProviderCardSetupReturn,
  subscribeProviderCardSetupReturn,
} from "@/lib/provider-card-setup-return";
import {
  latestProviderCheckoutReturn,
  subscribeToProviderCheckoutReturn,
  type ProviderCheckoutReturnSignal,
} from "@/lib/provider-checkout-return";
import { ProviderPortalHeader } from "./ProviderPortalHeader";
import { ProviderContentBoundary } from "./ProviderContentBoundary";
import { ProviderPracticePicker } from "./ProviderPracticePicker";
import {
  PROVIDER_PORTAL_NAV,
  ProviderAccountSection,
  ProviderBillingSection,
  ProviderDashboardSection,
  ProviderMessagesSection,
  ProviderSettingsSection,
  ProviderStatsSection,
  type ProviderPortalSection,
} from "./sections";

export function ProviderPortalShell() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const practice = useProviderPractice();
  // A return from Stripe that arrived before the portal mounted (cold launch)
  // is waiting here, so the provider lands on Billing rather than the
  // dashboard and sees the outcome of the payment they just made.
  const [checkoutReturn, setCheckoutReturn] = useState<ProviderCheckoutReturnSignal | null>(
    () => latestProviderCheckoutReturn(),
  );
  const [activeSection, setActiveSection] = useState<ProviderPortalSection>(
    checkoutReturn ? "billing" : "dashboard",
  );
  const [dashboardCaseId, setDashboardCaseId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(
    () =>
      subscribeToProviderCheckoutReturn((signal) => {
        setCheckoutReturn(signal);
        setDashboardCaseId(null);
        setActiveSection("billing");
      }),
    [],
  );

  // Unread messenger count on the Messages tab. Held locally — and zeroed the
  // moment the section is entered — because that is what desktop does: the
  // server watermark only moves once the conversation renders and marks the
  // newest message read, so the badge would otherwise linger after the
  // provider is already looking at the thread.
  // Held until a practice is selected: provider messenger endpoints are
  // tenant-scoped, so asking before the portal knows which practice it is
  // showing would be rejected for a provider linked to several practices.
  const { total: messengerUnread, query: unreadQuery } = useMessengerUnreadCount(
    !!practice.selectedPracticeId,
  );
  const [unreadBadge, setUnreadBadge] = useState(0);
  // The count keeps being polled behind the open section, so clearing on entry
  // is not enough on its own: a poll landing while the provider is reading
  // would put the badge straight back. Every count fetched up to the moment
  // they leave is something they were looking at, so it is recorded as read
  // through and cannot raise the badge again — only a count fetched after they
  // leave can.
  const readThroughRef = useRef(0);
  const unreadFetchedAt = unreadQuery.dataUpdatedAt;
  const messagesOpen = activeSection === "messages";
  useEffect(() => {
    if (messagesOpen) {
      readThroughRef.current = unreadFetchedAt;
      setUnreadBadge(0);
      return;
    }
    if (unreadFetchedAt <= readThroughRef.current) return;
    setUnreadBadge(messengerUnread);
  }, [messagesOpen, messengerUnread, unreadFetchedAt]);

  const enterSection = useCallback((key: ProviderPortalSection) => {
    setActiveSection(key);
    // Cleared in the same commit as the section change so the badge cannot
    // survive a frame into the conversation; the effect above then holds it
    // down for as long as the provider stays.
    if (key === "messages") setUnreadBadge(0);
  }, []);

  const openNotification = useCallback(
    (target: { section: ProviderPortalSection; caseId?: string }) => {
      setDashboardCaseId(target.caseId ?? null);
      enterSection(target.section);
    },
    [enterSection],
  );

  const selectSection = useCallback(
    (key: ProviderPortalSection) => {
      setDrawerOpen(false);
      enterSection(key);
      if (key !== "dashboard") setDashboardCaseId(null);
    },
    [enterSection],
  );

  // Card setup is started from My Account, so a Stripe return lands there —
  // whichever section happened to be open when the provider came back. My
  // Account consumes the pending return itself and refreshes the card state.
  useEffect(() => {
    const show = () => {
      setDashboardCaseId(null);
      setActiveSection("account");
    };
    if (hasProviderCardSetupReturn()) show();
    return subscribeProviderCardSetupReturn(show);
  }, []);

  function renderSection() {
    // These preferences belong to the signed-in user, not to a practice.
    if (activeSection === "settings") return <ProviderSettingsSection />;
    if (activeSection === "account") return <ProviderAccountSection />;
    if (practice.isLoading) {
      return (
        <View style={styles.centered} testID="provider-portal-loading">
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={styles.errorBody}>Loading your practices…</Text>
        </View>
      );
    }
    if (practice.practices.length === 0) {
      return (
        <View style={styles.centered} testID="provider-portal-no-practice">
          <Text style={styles.errorTitle}>{PROVIDER_PORTAL_NAV.find((item) => item.key === activeSection)?.label}</Text>
          <Text style={styles.errorTitle}>No active practice yet</Text>
          <Text style={styles.errorBody}>
            Practice access requests require approval from the practice administrator.
            If you requested access, ask them to approve it. Refresh after approval,
            or sign out to use another account. Optional lab partnership approvals are
            separate from practice membership.
          </Text>
          <Pressable onPress={practice.reload} style={styles.retry} accessibilityRole="button" testID="provider-portal-access-refresh">
            <Text style={styles.retryLabel}>Refresh practice access</Text>
          </Pressable>
        </View>
      );
    }
    if (practice.loadError) {
      return (
        <View style={styles.centered} testID="provider-portal-load-error">
          <Text style={styles.errorTitle}>Could not load your practices</Text>
          <Text style={styles.errorBody}>{practice.loadError}</Text>
          <Pressable
            onPress={practice.reload}
            style={styles.retry}
            accessibilityRole="button"
            testID="provider-portal-load-retry"
          >
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    // No active practice: the portal cannot scope a single request, so the
    // picker replaces the sections rather than letting them error out.
    if (practice.needsSelection) return <ProviderPracticePicker />;
    if (!practice.selectedPracticeId) {
      return (
        <View style={styles.centered} testID="provider-portal-switching">
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={styles.errorBody}>Opening your practice…</Text>
        </View>
      );
    }

    switch (activeSection) {
      case "billing":
        return <ProviderBillingSection checkoutReturn={checkoutReturn} />;
      case "messages":
        return <ProviderMessagesSection />;
      case "stats":
        return <ProviderStatsSection />;
      case "dashboard":
      default:
        return (
          <ProviderDashboardSection
            caseId={dashboardCaseId}
            onClearCaseId={() => setDashboardCaseId(null)}
          />
        );
    }
  }

  return (
    <View
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="provider-portal"
    >
      <ProviderPortalHeader
        onOpenNavigation={() => setDrawerOpen(true)}
        onOpenSettings={() => selectSection("settings")}
        onOpenNotification={openNotification}
      />
      {/* Remount on practice change so no section can carry a previous
          practice's local state across the tenant boundary. */}
      <View style={styles.body} key={practice.selectedPracticeId ?? "none"}>
        <ProviderContentBoundary key={activeSection}>{renderSection()}</ProviderContentBoundary>
      </View>
      <Modal
        visible={drawerOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setDrawerOpen(false)}
        testID="provider-portal-drawer-modal"
      >
        <View style={styles.drawerOverlay} testID="provider-portal-drawer">
          <View
            style={[
              styles.drawer,
              {
                paddingTop: Math.max(insets.top, Spacing.md),
                paddingBottom: Math.max(insets.bottom, Spacing.lg),
              },
            ]}
            accessibilityRole="menu"
            accessibilityLabel="Provider navigation"
          >
            <View style={styles.drawerHeader}>
              <Text style={styles.drawerTitle}>Navigation</Text>
              <Pressable
                onPress={() => setDrawerOpen(false)}
                style={styles.drawerClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close navigation menu"
                testID="provider-portal-drawer-close"
              >
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.drawerItems}
              showsVerticalScrollIndicator={false}
            >
              {PROVIDER_PORTAL_NAV.map((item) => {
                const active = activeSection === item.key;
                const badge = item.key === "messages" ? unreadBadge : 0;
                return (
                  <Pressable
                    key={item.key}
                    onPress={() => selectSection(item.key)}
                    style={[styles.drawerItem, active && styles.drawerItemActive]}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={
                      badge > 0 ? `${item.label}, ${badge} unread` : item.label
                    }
                    testID={`provider-portal-drawer-${item.key}`}
                  >
                    <Ionicons
                      name={active ? item.activeIcon : item.icon}
                      size={21}
                      color={active ? colors.tint : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.drawerItemLabel,
                        active && styles.drawerItemLabelActive,
                      ]}
                    >
                      {item.label}
                    </Text>
                    {badge > 0 ? (
                      <View
                        style={styles.badge}
                        testID={`provider-portal-drawer-${item.key}-badge`}
                      >
                        <Text style={styles.badgeLabel}>
                          {badge > 99 ? "99+" : badge}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
          <Pressable
            style={styles.drawerBackdrop}
            onPress={() => setDrawerOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close navigation menu"
            testID="provider-portal-drawer-backdrop"
          />
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.backgroundSolid },
    body: { flex: 1 },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      padding: Spacing.xxl,
    },
    errorTitle: { ...Typography.h3, color: colors.text, textAlign: "center" },
    errorBody: {
      ...Typography.caption,
      color: colors.textSecondary,
      textAlign: "center",
    },
    retry: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: 8,
      backgroundColor: colors.tint,
    },
    retryLabel: { ...Typography.captionSemibold, color: colors.textInverse },
    drawerOverlay: {
      flex: 1,
      flexDirection: "row",
    },
    drawer: {
      width: "82%",
      maxWidth: 340,
      backgroundColor: colors.surface,
      paddingHorizontal: Spacing.md,
    },
    drawerBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.42)",
    },
    drawerHeader: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.sm,
      marginBottom: Spacing.sm,
    },
    drawerTitle: { ...Typography.h3, color: colors.text },
    drawerClose: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    drawerItems: {
      gap: Spacing.xs,
      paddingBottom: Spacing.lg,
    },
    drawerItem: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: 8,
    },
    drawerItemActive: {
      backgroundColor: colors.tintLight,
    },
    drawerItemLabel: {
      ...Typography.bodyMedium,
      color: colors.text,
      flex: 1,
      flexShrink: 1,
    },
    drawerItemLabelActive: {
      color: colors.tint,
    },
    badge: {
      minWidth: 22,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.error,
    },
    badgeLabel: { ...Typography.tiny, color: colors.textInverse },
  });
}
