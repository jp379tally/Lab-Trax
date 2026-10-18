import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { getJson } from "@/lib/read-api";
import { useMe, canAdminAnyLab, primaryLabOrgId } from "@/lib/auth-me";

interface SelfPermission {
  id: string;
  name: string;
  description?: string | null;
  capabilityKey: string;
}

interface SelfPermissionsResponse {
  membershipId: string;
  permissions: SelfPermission[];
}

/**
 * Read-only "My permissions" card for the mobile profile/account screen.
 *
 * Mirrors the desktop Profile tab's self-permissions card and the self view
 * inside Manage > Permission Outline (both call the same
 * GET /organizations/:orgId/members/self/permissions endpoint), so lab
 * members can see their granted capabilities without needing to find the
 * Manage menu entry. Hidden for owners/admins, who always have full access
 * and have nothing custom to show here.
 */
export function MyPermissionsCard() {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  const me = useMe();
  const isAdminOrOwner = canAdminAnyLab(me.data);
  const labOrgId = primaryLabOrgId(me.data);
  const enabled = !isAdminOrOwner && !!labOrgId;

  const selfQuery = useQuery<SelfPermissionsResponse>({
    queryKey: ["self-permissions", labOrgId],
    queryFn: () =>
      getJson<SelfPermissionsResponse>(`/organizations/${labOrgId}/members/self/permissions`),
    enabled,
    staleTime: 60_000,
  });

  if (!enabled) return null;

  const permissions = selfQuery.data?.permissions ?? [];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>MY PERMISSIONS</Text>
      <View style={styles.card}>
        <Text style={styles.subtitle}>
          Custom capabilities your lab owner has granted to your account.
        </Text>

        {selfQuery.isLoading && (
          <ActivityIndicator size="small" color={colors.tint} style={{ marginTop: 10 }} />
        )}
        {selfQuery.isError && (
          <Text style={styles.errorText}>Could not load your permissions.</Text>
        )}
        {selfQuery.isSuccess && permissions.length === 0 && (
          <Text style={styles.emptyText}>
            No custom permissions have been granted to your account yet.
          </Text>
        )}
        {permissions.map((perm) => (
          <View key={perm.id} style={styles.permRow}>
            <Ionicons
              name="shield-checkmark-outline"
              size={16}
              color={colors.tint}
              style={{ marginTop: 1, marginRight: 8 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.permName}>{perm.name}</Text>
              {!!perm.description && <Text style={styles.permDesc}>{perm.description}</Text>}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    section: { gap: 6 },
    sectionTitle: {
      ...Typography.label,
      color: colors.textSecondary,
      paddingHorizontal: Spacing.lg,
      paddingBottom: 4,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
    },
    subtitle: { ...Typography.caption, color: colors.textSecondary },
    errorText: { ...Typography.caption, color: colors.error, marginTop: 8 },
    emptyText: {
      ...Typography.caption,
      color: colors.textTertiary,
      fontStyle: "italic",
      marginTop: 8,
    },
    permRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingTop: 10,
      marginTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    permName: { ...Typography.bodyMedium, color: colors.text },
    permDesc: { ...Typography.caption, color: colors.textTertiary, marginTop: 2 },
  });
}
