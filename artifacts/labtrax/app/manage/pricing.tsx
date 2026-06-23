import React, { useEffect, useMemo, useState } from "react";
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
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { FormSheet } from "@/components/ui/FormSheet";
import { TextField } from "@/components/ui/TextField";
import { getJson, sendJson, isForbiddenError, ApiError } from "@/lib/read-api";
import { useMe, primaryAdminLabOrgId, canAdminAnyLab } from "@/lib/auth-me";
import { titleCase } from "@/lib/format";

type Prices = Record<string, string | number | null>;

interface PricingTier {
  id: string;
  name: string;
  prices?: Prices | null;
}
interface TiersResponse {
  keys: string[];
  tiers: PricingTier[];
}

function pricedCount(prices: Prices | null | undefined): number {
  if (!prices) return 0;
  return Object.values(prices).filter((v) => v != null && String(v).trim() !== "").length;
}

function friendlyError(e: unknown, fallback: string): string {
  if (isForbiddenError(e)) {
    return "Your current role can’t make this change. Pricing is managed by lab owners and admins.";
  }
  if (e instanceof ApiError) return e.message;
  return fallback;
}

export default function PricingScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe().data;
  // Pricing tiers/overrides are admin-only on the server (resolveLabId →
  // owner/admin); billing-role users can neither read nor write them. Gate the
  // whole screen on admin so we never load data the server will 403, and never
  // show edit affordances that would fail.
  const labOrgId = primaryAdminLabOrgId(me);
  const canEdit = canAdminAnyLab(me);

  const tiersQ = useQuery<TiersResponse>({
    queryKey: ["pricing-tiers-full", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () =>
      getJson<TiersResponse>(`/api/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrgId!)}`),
  });
  const labelsQ = useQuery<Record<string, string>>({
    queryKey: ["item-labels", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await getJson<{ labels: Record<string, string> }>(
        `/api/pricing/item-labels?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
      return data.labels ?? {};
    },
  });

  const keys = tiersQ.data?.keys ?? [];
  const labels = labelsQ.data ?? {};
  const labelFor = (k: string) => labels[k]?.trim() || titleCase(k.replace(/_/g, " "));

  const loading = !!labOrgId && tiersQ.isLoading;
  const refreshing = tiersQ.isFetching || labelsQ.isFetching;

  function refetchAll() {
    tiersQ.refetch();
    labelsQ.refetch();
  }

  const [tierEditor, setTierEditor] = useState<PricingTier | "new" | null>(null);

  const invalidateTiers = () => qc.invalidateQueries({ queryKey: ["pricing-tiers-full", labOrgId ?? ""] });

  if (!canEdit) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header onBack={() => router.back()} colors={colors} styles={styles} />
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>Pricing is managed by lab owners and admins.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Header onBack={() => router.back()} colors={colors} styles={styles} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} tintColor={colors.tint} />}
        >
          <Section
            title="Tiers"
            count={tiersQ.data?.tiers.length ?? 0}
            error={tiersQ.isError}
            styles={styles}
            colors={colors}
            onAdd={() => setTierEditor("new")}
          >
            {(tiersQ.data?.tiers ?? []).map((t) => (
              <Card
                key={t.id}
                style={styles.row}
                onPress={() => setTierEditor(t)}
                testID={`tier-${t.id}`}
              >
                <View style={[styles.icon, { backgroundColor: colors.tint + "1A" }]}>
                  <Text style={[styles.iconText, { color: colors.tint }]}>{(t.name || "?").charAt(0).toUpperCase()}</Text>
                </View>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {t.name}
                  </Text>
                  <Text style={styles.meta}>
                    {pricedCount(t.prices)} priced item{pricedCount(t.prices) === 1 ? "" : "s"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Card>
            ))}
          </Section>
        </ScrollView>
      )}

      {tierEditor ? (
        <TierEditor
          labOrgId={labOrgId!}
          tier={tierEditor === "new" ? null : tierEditor}
          keys={keys}
          labelFor={labelFor}
          onClose={() => setTierEditor(null)}
          onSaved={() => {
            setTierEditor(null);
            invalidateTiers();
          }}
        />
      ) : null}
    </View>
  );
}

function pricesToStrings(prices: Prices | null | undefined, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = prices?.[k];
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

function stringsToPrices(input: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const trimmed = v.trim();
    if (trimmed === "") continue;
    const num = Number(trimmed);
    if (!Number.isNaN(num)) out[k] = num;
  }
  return out;
}

// --- Tier editor ----------------------------------------------------------
function TierEditor({
  labOrgId,
  tier,
  keys,
  labelFor,
  onClose,
  onSaved,
}: {
  labOrgId: string;
  tier: PricingTier | null;
  keys: string[];
  labelFor: (k: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tier?.name ?? "");
  const [prices, setPrices] = useState<Record<string, string>>(() => pricesToStrings(tier?.prices, keys));

  // Re-seed from the latest props whenever a different tier is opened, so a
  // reopened sheet always reflects the current server values rather than a
  // stale snapshot captured when the editor first mounted.
  useEffect(() => {
    setName(tier?.name ?? "");
    setPrices(pricesToStrings(tier?.prices, keys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier?.id]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), prices: stringsToPrices(prices) };
      if (tier) return sendJson("PATCH", `/api/pricing/tiers/${tier.id}`, body);
      return sendJson("POST", "/api/pricing/tiers", { ...body, labOrganizationId: labOrgId });
    },
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t save", friendlyError(e, "Please try again.")),
  });
  const remove = useMutation({
    mutationFn: () => sendJson("DELETE", `/api/pricing/tiers/${tier!.id}`),
    onSuccess: onSaved,
    onError: (e) => Alert.alert("Couldn’t delete", friendlyError(e, "Please try again.")),
  });

  function confirmDelete() {
    Alert.alert("Delete tier", `Remove “${tier!.name}”?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove.mutate() },
    ]);
  }

  return (
    <FormSheet
      visible
      title={tier ? "Edit tier" : "New tier"}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitting={save.isPending || remove.isPending}
      submitDisabled={name.trim().length === 0}
      onDelete={tier ? confirmDelete : undefined}
    >
      <TextField label="Tier name" required value={name} onChangeText={setName} placeholder="e.g. Standard" autoFocus />
      <PriceGrid keys={keys} labelFor={labelFor} values={prices} onChange={setPrices} />
    </FormSheet>
  );
}

// --- Shared price grid ----------------------------------------------------
function PriceGrid({
  keys,
  labelFor,
  values,
  onChange,
}: {
  keys: string[];
  labelFor: (k: string) => string;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Prices</Text>
      <View style={styles.priceList}>
        {keys.map((k) => (
          <View key={k} style={styles.priceRow}>
            <Text style={styles.priceLabel} numberOfLines={1}>
              {labelFor(k)}
            </Text>
            <View style={styles.priceInputWrap}>
              <Text style={styles.priceCurrency}>$</Text>
              <TextField
                value={values[k] ?? ""}
                onChangeText={(t) => onChange({ ...values, [k]: t })}
                keyboardType="decimal-pad"
                placeholder="0"
                testID={`price-${k}`}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function Header({
  onBack,
  colors,
  styles,
}: {
  onBack: () => void;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.header}>
      <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8} testID="pricing-back">
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </Pressable>
      <Text style={styles.title}>Pricing</Text>
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
  onAdd,
}: {
  title: string;
  count: number;
  error: boolean;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  onAdd?: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.sectionHeaderRight}>
          <Text style={styles.sectionCount}>{count}</Text>
          {onAdd ? (
            <Pressable style={styles.addBtn} onPress={onAdd} hitSlop={8} testID={`add-${title.toLowerCase().replace(/\s+/g, "-")}`}>
              <Ionicons name="add" size={20} color={colors.tint} />
            </Pressable>
          ) : null}
        </View>
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
    sectionHeaderRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    sectionTitle: { ...Typography.h2, color: c.text },
    sectionCount: { ...Typography.captionSemibold, color: c.textTertiary },
    addBtn: {
      width: 32,
      height: 32,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.tint + "1A",
    },
    sectionEmpty: { ...Typography.caption, color: c.textTertiary },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    iconText: { ...Typography.bodySemibold },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodyLgMedium, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    field: { gap: Spacing.xs },
    fieldLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    priceList: { gap: Spacing.sm },
    priceRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    priceLabel: { ...Typography.body, color: c.text, flex: 1 },
    priceInputWrap: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, width: 130 },
    priceCurrency: { ...Typography.body, color: c.textSecondary },
  });
}
