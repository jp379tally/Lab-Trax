import React, { useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/lib/app-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { getStationInfo, formatInvNum } from "@/lib/data";

export default function ChartHistoryScreen() {
  const { patient } = useLocalSearchParams<{ patient: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { cases, invoices, role, adminUnlocked, customStationLabels } = useApp();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const isAdmin = role === "admin" && adminUnlocked;

  const patientCases = useMemo(() => {
    if (!patient) return [];
    return cases
      .filter(
        (c) =>
          (c.patientName || "").toLowerCase() === patient.toLowerCase()
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [cases, patient]);

  const patientInitials = patient
    ? patient
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase())
        .join("")
        .slice(0, 2)
    : "??";

  return (
    <View style={[styles.container, { paddingTop: Platform.OS === "web" ? 67 : insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Entire Chart History</Text>
          <Text style={styles.headerSubtitle}>{patient}</Text>
        </View>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>{patientInitials}</Text>
        </View>
      </View>

      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryNum}>{patientCases.length}</Text>
          <Text style={styles.summaryLabel}>Total Cases</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryNum}>
            {patientCases.filter((c) => c.isRemake).length}
          </Text>
          <Text style={styles.summaryLabel}>Remakes</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryNum}>
            {patientCases.filter((c) => c.status === "COMPLETE").length}
          </Text>
          <Text style={styles.summaryLabel}>Completed</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }}
        showsVerticalScrollIndicator={false}
      >
        {patientCases.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={48} color={colors.textTertiary} />
            <Text style={styles.emptyText}>No cases found for this patient.</Text>
          </View>
        ) : (
          patientCases.map((c, idx) => {
            const stationInfo = getStationInfo(c.status, customStationLabels);
            const linkedInvoice = c.invoiceId
              ? invoices.find((inv) => inv.id === c.invoiceId)
              : invoices.find((inv) => inv.caseIds?.includes(c.id));
            const dateStr = new Date(c.createdAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            });

            return (
              <Pressable
                key={c.id}
                onPress={() => router.push(`/case/${c.id}`)}
                style={({ pressed }) => [
                  styles.caseCard,
                  pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                ]}
              >
                <View style={styles.caseCardHeader}>
                  <View style={styles.caseNumberRow}>
                    <Text style={styles.caseNumber}>{c.caseNumber}</Text>
                    {c.isRemake && (
                      <View style={styles.remakeBadge}>
                        <Ionicons name="refresh" size={10} color={colors.textInverse} />
                        <Text style={styles.remakeBadgeText}>REMAKE</Text>
                      </View>
                    )}
                    {c.isRush && (
                      <View style={styles.rushBadge}>
                        <Ionicons name="flash" size={10} color={colors.error} />
                      </View>
                    )}
                  </View>
                  <View style={[styles.statusChip, { backgroundColor: stationInfo.color + "20" }]}>
                    <View style={[styles.statusDot, { backgroundColor: stationInfo.color }]} />
                    <Text style={[styles.statusText, { color: stationInfo.color }]}>
                      {stationInfo.label}
                    </Text>
                  </View>
                </View>

                <View style={styles.caseDetails}>
                  <View style={styles.detailRow}>
                    <Ionicons name="medkit-outline" size={14} color={colors.textTertiary} />
                    <Text style={styles.detailText}>{c.caseType || "General"}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Ionicons name="grid-outline" size={14} color={colors.textTertiary} />
                    <Text style={styles.detailText}>{c.toothIndices || "N/A"}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Ionicons name="color-palette-outline" size={14} color={colors.textTertiary} />
                    <Text style={styles.detailText}>{c.shade || "N/A"} / {c.material || "N/A"}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Ionicons name="person-outline" size={14} color={colors.textTertiary} />
                    <Text style={styles.detailText}>{c.doctorName}</Text>
                  </View>
                </View>

                <View style={styles.caseFooter}>
                  <Text style={styles.dateText}>{dateStr}</Text>
                  {isAdmin && (
                    <Text style={styles.priceText}>
                      {c.isRemake ? "No Charge" : `$${(c.price || 0).toFixed(2)}`}
                    </Text>
                  )}
                  {linkedInvoice && (
                    <View style={styles.invoiceBadge}>
                      <Ionicons name="receipt-outline" size={12} color={colors.info} />
                      <Text style={styles.invoiceBadgeText}>{formatInvNum(linkedInvoice.invoiceNumber)}</Text>
                    </View>
                  )}
                </View>

                {c.notes ? (
                  <Text style={styles.notesPreview} numberOfLines={2}>
                    {c.notes}
                  </Text>
                ) : null}

                <View style={styles.timelinePreview}>
                  {(c.routeHistory ?? []).slice(0, 5).map((rh, ri) => {
                    const si = getStationInfo(rh.station, customStationLabels);
                    return (
                      <View key={ri} style={styles.miniTimelineItem}>
                        <View style={[styles.miniDot, { backgroundColor: si.color }]} />
                        {ri < Math.min((c.routeHistory ?? []).length - 1, 4) && (
                          <View style={styles.miniLine} />
                        )}
                      </View>
                    );
                  })}
                  {(c.routeHistory ?? []).length > 5 && (
                    <Text style={styles.moreStations}>+{(c.routeHistory ?? []).length - 5}</Text>
                  )}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
    marginTop: 2,
  },
  avatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.tint,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.textInverse,
  },
  summaryRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  summaryNum: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  summaryLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: colors.textSecondary,
    marginTop: 2,
  },
  scrollArea: {
    flex: 1,
    paddingHorizontal: 16,
  },
  emptyState: {
    alignItems: "center",
    paddingTop: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.textTertiary,
  },
  caseCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  caseCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  caseNumberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  caseNumber: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  remakeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.error,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  remakeBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: colors.textInverse,
  },
  rushBadge: {
    backgroundColor: colors.errorSurface,
    borderRadius: 6,
    padding: 3,
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  caseDetails: {
    gap: 6,
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  detailText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
  },
  caseFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  dateText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.textTertiary,
  },
  priceText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
  },
  invoiceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.infoSurface,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: "auto",
  },
  invoiceBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: colors.info,
  },
  notesPreview: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.textTertiary,
    marginTop: 8,
    fontStyle: "italic",
  },
  timelinePreview: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    gap: 0,
  },
  miniTimelineItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  miniDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  miniLine: {
    width: 16,
    height: 2,
    backgroundColor: colors.border,
  },
  moreStations: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: colors.textTertiary,
    marginLeft: 4,
  },
});
