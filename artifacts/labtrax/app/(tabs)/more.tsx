import React, { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  useGetAiMemoryCandidates,
  getGetAiMemoryCandidatesQueryKey,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  useMe,
  canEditAnyLab,
  canAdminAnyLab,
  primaryLabOrgId,
  adminLabMemberships,
} from "@/lib/auth-me";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

interface MenuItem {
  title: string;
  subtitle: string;
  icon: IconName;
  route: string;
  // billing-or-better (owner/admin/billing) — vendors/categories
  requiresEdit?: boolean;
  // owner/admin only — pricing, billed report, item-label writes
  requiresAdmin?: boolean;
  // any active lab member — reads open to all members, writes gated in-screen
  requiresLabMember?: boolean;
  // show the pending AI-suggestion count badge (admin-only) on this row
  showAiCandidateBadge?: boolean;
}

const ITEMS: MenuItem[] = [
  {
    title: "AI Assistant",
    subtitle: "Ask questions and draft messages",
    icon: "chatbubble-ellipses-outline",
    route: "/ai-assistant",
  },
  {
    title: "Accounts",
    subtitle: "Bank and cash account balances",
    icon: "wallet-outline",
    route: "/manage/accounts",
  },
  {
    title: "Pricing",
    subtitle: "Tiers and per-item prices",
    icon: "pricetags-outline",
    route: "/manage/pricing",
    requiresAdmin: true,
  },
  {
    title: "Locations",
    subtitle: "Lab stations and case tracking spots",
    icon: "location-outline",
    route: "/manage/locations",
    requiresAdmin: true,
  },
  {
    title: "Lists",
    subtitle: "Vendors, categories, and item labels",
    icon: "list-outline",
    route: "/manage/lists",
    requiresEdit: true,
  },
  {
    title: "Reports",
    subtitle: "Billed revenue by restoration",
    icon: "bar-chart-outline",
    route: "/manage/reports",
    requiresAdmin: true,
  },
  {
    title: "Deleted Cases",
    subtitle: "View and restore soft-deleted cases",
    icon: "trash-outline",
    route: "/manage/deleted-cases",
    requiresAdmin: true,
  },
  {
    title: "AI Knowledge",
    subtitle: "Glossary, preferences, and facts for the AI",
    icon: "sparkles-outline",
    route: "/manage/ai-knowledge",
    requiresLabMember: true,
    showAiCandidateBadge: true,
  },
];

export default function MoreMenuScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meQuery = useMe();
  const canEdit = canEditAnyLab(meQuery.data);
  const canAdmin = canAdminAnyLab(meQuery.data);
  const labOrgId = primaryLabOrgId(meQuery.data);
  const hasLab = !!labOrgId;

  // Pending AI suggestions awaiting admin review. The GET endpoint is
  // lab-admin-only, so mirror the ai-knowledge screen: scope to the primary lab
  // and only run for owners/admins of that lab. Sharing the query key means the
  // badge clears automatically once the admin approves/dismisses on that screen.
  const canManageLab = useMemo(
    () => adminLabMemberships(meQuery.data).some((m) => m.organizationId === labOrgId),
    [meQuery.data, labOrgId],
  );
  const candidatesQ = useGetAiMemoryCandidates(
    { labOrganizationId: labOrgId ?? "" },
    {
      query: {
        queryKey: getGetAiMemoryCandidatesQueryKey({ labOrganizationId: labOrgId ?? "" }),
        enabled: !!labOrgId && canManageLab,
        staleTime: 30_000,
      },
    },
  );
  const candidateCount = canManageLab ? (candidatesQ.data?.data?.length ?? 0) : 0;

  const visible = ITEMS.filter(
    (item) =>
      (!item.requiresEdit || canEdit) &&
      (!item.requiresAdmin || canAdmin) &&
      (!item.requiresLabMember || hasLab),
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>More</Text>
        <Text style={styles.subtitle}>Operations and lookups</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {visible.map((item) => (
          <Card key={item.route} style={styles.row} onPress={() => router.push(item.route as never)} testID={`menu-${item.route}`}>
            <View style={[styles.rowIcon, { backgroundColor: colors.tint + "1A" }]}>
              <Ionicons name={item.icon} size={20} color={colors.tint} />
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {item.subtitle}
              </Text>
            </View>
            {item.showAiCandidateBadge && candidateCount > 0 ? (
              <View style={styles.badge} testID="ai-candidate-badge">
                <Text style={styles.badgeText}>{candidateCount > 99 ? "99+" : candidateCount}</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.xs },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...Typography.bodyLgMedium, color: c.text },
    rowSubtitle: { ...Typography.caption, color: c.textSecondary },
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: Radius.full,
      paddingHorizontal: 7,
      backgroundColor: c.tint,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeText: { ...Typography.captionSemibold, color: c.textInverse },
  });
}
