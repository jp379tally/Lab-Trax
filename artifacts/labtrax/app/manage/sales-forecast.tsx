// Sales Forecaster — owner-only sales pace projection.
//
// Stricter than the other manage screens: the server gates
// GET /stats/sales-forecast on OWNER_ROLES (owner only), so this screen is
// gated with canOwnAnyLab and scoped to the labs the user owns. All the math
// (business-day pace, forecast, insufficient-data guards) lives on the server —
// this screen only renders the returned numbers. The generated hook returns the
// `{ ok, data }` envelope, so every read is `query.data?.data?.X`.
import React, { useMemo, useState } from "react";
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
import {
  useGetStatsSalesForecast,
  getGetStatsSalesForecastQueryKey,
  type StatsSalesForecastPeriod,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { useMe, canOwnAnyLab, ownerLabMemberships } from "@/lib/auth-me";
import { formatMoney } from "@/lib/format";

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function SalesForecastScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meQuery = useMe();
  const me = meQuery.data;

  // Labs the user OWNS — mirrors the server's OWNER_ROLES gate exactly, so the
  // screen never loads data the server would refuse.
  const ownerLabs = useMemo(() => {
    const seen = new Set<string>();
    return ownerLabMemberships(me)
      .filter((m) => {
        if (seen.has(m.organizationId)) return false;
        seen.add(m.organizationId);
        return true;
      })
      .map((m) => ({
        id: m.organizationId,
        name:
          (typeof m.organization?.name === "string" && m.organization.name) ||
          "Lab",
      }));
  }, [me]);
  const canView = canOwnAnyLab(me);

  const [orgIdOverride, setOrgIdOverride] = useState<string | null>(null);
  const orgId =
    orgIdOverride && ownerLabs.some((l) => l.id === orgIdOverride)
      ? orgIdOverride
      : (ownerLabs[0]?.id ?? null);

  const timeZone = useMemo(() => localTimeZone(), []);
  const params = { organizationId: orgId ?? "", timeZone };
  const enabled = canView && !!orgId;

  const forecastQuery = useGetStatsSalesForecast(params, {
    query: { queryKey: getGetStatsSalesForecastQueryKey(params), enabled },
  });
  const forecast = forecastQuery.data?.data;

  const blocked = !meQuery.isLoading && !canView;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          testID="forecast-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            Sales Forecaster
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Projected sales from your current pace
          </Text>
        </View>
      </View>

      {meQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : blocked ? (
        <View style={styles.center} testID="forecast-blocked">
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>
            The Sales Forecaster is available to lab owners only.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={forecastQuery.isFetching}
              onRefresh={() => void forecastQuery.refetch()}
              tintColor={colors.tint}
            />
          }
        >
          {ownerLabs.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {ownerLabs.map((l) => {
                const active = l.id === orgId;
                return (
                  <Pressable
                    key={l.id}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setOrgIdOverride(l.id)}
                    testID={`forecast-org-${l.id}`}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {l.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          <Text style={styles.explainer}>
            Projected from your current sales pace using Monday–Friday business
            days only. Forecast = sales so far ÷ business days elapsed × total
            business days in the period.
          </Text>

          {forecastQuery.isError ? (
            <Card style={styles.stateCard}>
              <Text style={styles.stateText} testID="forecast-error">
                Couldn’t load the forecast. Pull to refresh.
              </Text>
            </Card>
          ) : (
            <View style={styles.cards} testID="forecast-cards">
              <ForecastCard
                styles={styles}
                colors={colors}
                title="This week"
                period={forecast?.week}
                loading={forecastQuery.isLoading}
              />
              <ForecastCard
                styles={styles}
                colors={colors}
                title="This month"
                period={forecast?.month}
                loading={forecastQuery.isLoading}
              />
              <ForecastCard
                styles={styles}
                colors={colors}
                title="This year"
                period={forecast?.year}
                loading={forecastQuery.isLoading}
              />
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function ForecastCard({
  styles,
  colors,
  title,
  period,
  loading,
}: {
  styles: Styles;
  colors: ThemeColors;
  title: string;
  period: StatsSalesForecastPeriod | undefined;
  loading?: boolean;
}) {
  return (
    <Card style={styles.forecastCard}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Ionicons name="trending-up-outline" size={16} color={colors.textSecondary} />
      </View>
      <Text style={styles.cardValue} numberOfLines={1}>
        {loading
          ? "…"
          : !period || period.insufficientData
            ? "—"
            : formatMoney(period.forecast)}
      </Text>
      <Text style={styles.cardCaption}>Projected {title.toLowerCase()} sales</Text>

      {!loading && period && !period.insufficientData ? (
        <PaceTrend
          styles={styles}
          colors={colors}
          pct={period.paceChangePct}
          priorLabel={title.toLowerCase().replace(/^this\b/, "last")}
        />
      ) : null}

      {!loading && period && !period.insufficientData ? (
        <View style={styles.detailList}>
          <DetailRow
            styles={styles}
            label="Sales so far"
            value={formatMoney(period.periodToDateSales)}
          />
          <DetailRow
            styles={styles}
            label="Avg / business day"
            value={formatMoney(period.averagePerBusinessDay)}
          />
          <DetailRow
            styles={styles}
            label="Business days"
            value={`${period.elapsedBusinessDays} of ${period.totalBusinessDays}`}
          />
        </View>
      ) : !loading ? (
        <Text style={styles.insufficient}>
          Not enough data yet to project this period.
        </Text>
      ) : null}
    </Card>
  );
}

function DetailRow({
  styles,
  label,
  value,
}: {
  styles: Styles;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

// Pace-trend chip: current per-business-day pace vs the prior comparable
// period (server-computed). Null pct = no comparable prior sales to trend.
function PaceTrend({
  styles,
  colors,
  pct,
  priorLabel,
}: {
  styles: Styles;
  colors: ThemeColors;
  pct: number | null;
  priorLabel: string;
}) {
  if (pct === null) {
    return (
      <View style={styles.paceRow}>
        <Ionicons name="remove-outline" size={14} color={colors.textTertiary} />
        <Text style={[styles.paceText, { color: colors.textTertiary }]}>
          No comparison for {priorLabel}
        </Text>
      </View>
    );
  }
  const up = pct > 0;
  const flat = pct === 0;
  const color = flat ? colors.textSecondary : up ? colors.success : colors.error;
  const icon = flat
    ? "remove-outline"
    : up
      ? "trending-up-outline"
      : "trending-down-outline";
  const word = flat ? "flat" : up ? "up" : "down";
  const label = flat
    ? `Pace flat vs ${priorLabel}`
    : `Pace ${word} ${Math.abs(pct).toFixed(1)}% vs ${priorLabel}`;
  return (
    <View style={styles.paceRow}>
      <Ionicons name={icon} size={14} color={color} />
      <Text style={[styles.paceText, { color }]}>{label}</Text>
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
    headerText: { flex: 1 },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
    },
    emptyTitle: { ...Typography.h3, color: c.text, marginTop: Spacing.sm },
    emptyBody: {
      ...Typography.body,
      color: c.textSecondary,
      textAlign: "center",
      maxWidth: 280,
    },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
    chipRow: { gap: Spacing.xs, paddingRight: Spacing.lg },
    chip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipActive: { backgroundColor: c.tint, borderColor: c.tint },
    chipText: { ...Typography.captionSemibold, color: c.textSecondary },
    chipTextActive: { color: c.textInverse },
    explainer: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    cards: { gap: Spacing.md },
    forecastCard: { gap: 2 },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.xs,
    },
    cardTitle: { ...Typography.bodyLgMedium, color: c.text },
    cardValue: { ...Typography.h1, color: c.text },
    cardCaption: { ...Typography.caption, color: c.textSecondary },
    paceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginTop: Spacing.xs,
    },
    paceText: { ...Typography.captionSemibold },
    detailList: { marginTop: Spacing.md, gap: Spacing.xs },
    detailRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    detailLabel: { ...Typography.body, color: c.textSecondary },
    detailValue: { ...Typography.bodyMedium, color: c.text },
    insufficient: {
      ...Typography.body,
      color: c.textSecondary,
      marginTop: Spacing.md,
    },
    stateCard: { alignItems: "center", paddingVertical: Spacing.xl },
    stateText: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
  });
}
