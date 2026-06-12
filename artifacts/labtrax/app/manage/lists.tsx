import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId, canEditAnyLab } from "@/lib/auth-me";
import { titleCase } from "@/lib/format";

interface Vendor {
  id: string;
  name: string;
  vendorTypeName?: string | null;
}
interface Category {
  id: string;
  name: string;
  kind?: string | null;
  color?: string | null;
}

export default function ListsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe().data;
  const labOrgId = primaryLabOrgId(me);
  const canEdit = canEditAnyLab(me);
  const enabled = !!labOrgId && canEdit;

  const vendorsQ = useQuery<Vendor[]>({
    queryKey: ["vendors", labOrgId ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: () => getJson<Vendor[]>(`/api/finance/vendors?organizationId=${encodeURIComponent(labOrgId!)}`),
  });
  const categoriesQ = useQuery<Category[]>({
    queryKey: ["categories", labOrgId ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: () => getJson<Category[]>(`/api/finance/categories?organizationId=${encodeURIComponent(labOrgId!)}`),
  });
  const labelsQ = useQuery<Record<string, string>>({
    queryKey: ["item-labels", labOrgId ?? ""],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await getJson<{ labels: Record<string, string> }>(
        `/api/pricing/item-labels?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
      return data.labels ?? {};
    },
  });

  const loading = enabled && (vendorsQ.isLoading || categoriesQ.isLoading || labelsQ.isLoading);
  const refreshing = vendorsQ.isFetching || categoriesQ.isFetching || labelsQ.isFetching;
  const labelEntries = Object.entries(labelsQ.data ?? {}).filter(([, v]) => v && String(v).trim() !== "");

  function refetchAll() {
    vendorsQ.refetch();
    categoriesQ.refetch();
    labelsQ.refetch();
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} testID="lists-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Lists</Text>
      </View>

      {!canEdit ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>Lists are available to lab owners, admins, and billing users.</Text>
        </View>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} tintColor={colors.tint} />}
        >
          <Section title="Vendors" count={vendorsQ.data?.length ?? 0} error={vendorsQ.isError} styles={styles} colors={colors}>
            {(vendorsQ.data ?? []).map((v) => (
              <Card key={v.id} style={styles.row}>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {v.name}
                  </Text>
                  {v.vendorTypeName ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {v.vendorTypeName}
                    </Text>
                  ) : null}
                </View>
              </Card>
            ))}
          </Section>

          <Section title="Categories" count={categoriesQ.data?.length ?? 0} error={categoriesQ.isError} styles={styles} colors={colors}>
            {(categoriesQ.data ?? []).map((cat) => (
              <Card key={cat.id} style={styles.row}>
                <View style={[styles.dot, { backgroundColor: cat.color || colors.textTertiary }]} />
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {cat.name}
                  </Text>
                  {cat.kind ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {titleCase(cat.kind)}
                    </Text>
                  ) : null}
                </View>
              </Card>
            ))}
          </Section>

          <Section title="Item Labels" count={labelEntries.length} error={labelsQ.isError} styles={styles} colors={colors}>
            {labelEntries.map(([key, value]) => (
              <Card key={key} style={styles.row}>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {value}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {key}
                  </Text>
                </View>
              </Card>
            ))}
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

function Section({
  title,
  count,
  error,
  children,
  styles,
  colors,
}: {
  title: string;
  count: number;
  error: boolean;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {error ? (
        <Text style={styles.sectionEmpty}>Couldn’t load.</Text>
      ) : count === 0 ? (
        <Text style={styles.sectionEmpty}>Nothing here yet.</Text>
      ) : (
        <View style={styles.list}>{children}</View>
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
      gap: Spacing.xs,
    },
    backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    title: { ...Typography.h1, color: c.text },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.sm, minHeight: 280 },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xl },
    section: { gap: Spacing.sm },
    sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sectionTitle: { ...Typography.h2, color: c.text },
    sectionCount: { ...Typography.captionSemibold, color: c.textTertiary },
    sectionEmpty: { ...Typography.caption, color: c.textTertiary },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    dot: { width: 12, height: 12, borderRadius: Radius.full },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
  });
}
