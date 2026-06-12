import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography, Radius } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";

type ViewMode = "open" | "all";

interface DoctorEntry {
  doctorName: string;
  practiceName?: string | null;
  totalCases?: number | null;
  openCases?: number | null;
  providerOrganizationId?: string | null;
}

export default function CustomersScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);
  const [viewMode, setViewMode] = useState<ViewMode>("open");

  const query = useQuery<DoctorEntry[]>({
    queryKey: ["doctors-search", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await getJson<{ entries: DoctorEntry[] }>(
        `/api/doctors/search?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      );
      return data.entries ?? [];
    },
  });

  const displayCount = (d: DoctorEntry) =>
    viewMode === "open" ? (d.openCases ?? 0) : (d.totalCases ?? 0);

  const count = query.data?.length ?? 0;

  const toggle = (
    <View style={styles.toggleRow}>
      <TouchableOpacity
        style={[styles.toggleBtn, viewMode === "open" && styles.toggleBtnActive]}
        onPress={() => setViewMode("open")}
      >
        <Text style={[styles.toggleText, viewMode === "open" && styles.toggleTextActive]}>
          Open only
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.toggleBtn, styles.toggleBtnRight, viewMode === "all" && styles.toggleBtnActive]}
        onPress={() => setViewMode("all")}
      >
        <Text style={[styles.toggleText, viewMode === "all" && styles.toggleTextActive]}>
          All cases
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ListScreen<DoctorEntry>
      title="Customer Center"
      subtitle={query.isLoading ? "Loading…" : `${count} customer${count === 1 ? "" : "s"}`}
      query={query}
      ListHeader={toggle}
      keyExtractor={(d, index) => `${d.providerOrganizationId ?? "x"}:${d.doctorName}:${index}`}
      emptyIcon="people-outline"
      emptyTitle="No customers"
      emptyBody="Doctors and practices you bill will appear here."
      errorTitle="Couldn't load customers"
      blocked={
        labOrgId
          ? null
          : {
              icon: "people-outline",
              title: "No lab selected",
              body: "Customers are scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(d) => {
        const caseCount = displayCount(d);
        return (
          <Card style={styles.row}>
            <View style={styles.main}>
              <Text style={styles.name} numberOfLines={1}>
                {d.doctorName || "Unknown doctor"}
              </Text>
              {d.practiceName ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {d.practiceName}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() =>
                router.push({
                  pathname: "/finance/doctor-cases",
                  params: {
                    doctorName: d.doctorName,
                    providerOrganizationId: d.providerOrganizationId ?? "",
                    practiceName: d.practiceName ?? "",
                    initialViewMode: viewMode,
                  },
                } as never)
              }
              style={[styles.badge, caseCount === 0 && styles.badgeEmpty]}
              hitSlop={8}
            >
              <Text style={[styles.badgeText, caseCount === 0 && styles.badgeTextEmpty]}>
                {caseCount}{viewMode === "open" ? " open" : ""} case{caseCount === 1 ? "" : "s"}
              </Text>
            </TouchableOpacity>
          </Card>
        );
      }}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    badge: {
      backgroundColor: c.tintLight,
      borderRadius: Radius.full,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 3,
    },
    badgeEmpty: {
      backgroundColor: c.surface,
    },
    badgeText: {
      ...Typography.captionSemibold,
      color: c.tint,
    },
    badgeTextEmpty: {
      color: c.textTertiary,
    },
    toggleRow: {
      flexDirection: "row",
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.sm,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
      alignSelf: "flex-start",
    },
    toggleBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      backgroundColor: c.surface,
    },
    toggleBtnRight: {
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: c.border,
    },
    toggleBtnActive: { backgroundColor: c.tint },
    toggleText: { ...Typography.captionSemibold, color: c.textSecondary },
    toggleTextActive: { color: "#fff" },
  });
}
