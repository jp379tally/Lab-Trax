import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";

interface DoctorEntry {
  doctorName: string;
  practiceName?: string | null;
  totalCases?: number | null;
  providerOrganizationId?: string | null;
}

export default function CustomersScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);

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

  const count = query.data?.length ?? 0;

  return (
    <ListScreen<DoctorEntry>
      title="Customer Center"
      subtitle={query.isLoading ? "Loading…" : `${count} customer${count === 1 ? "" : "s"}`}
      query={query}
      keyExtractor={(d, index) => `${d.providerOrganizationId ?? "x"}:${d.doctorName}:${index}`}
      emptyIcon="people-outline"
      emptyTitle="No customers"
      emptyBody="Doctors and practices you bill will appear here."
      errorTitle="Couldn’t load customers"
      blocked={
        labOrgId
          ? null
          : {
              icon: "people-outline",
              title: "No lab selected",
              body: "Customers are scoped to a lab. This view is available to lab members.",
            }
      }
      renderItem={(d) => (
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
          <Text style={styles.count}>
            {d.totalCases ?? 0} case{(d.totalCases ?? 0) === 1 ? "" : "s"}
          </Text>
        </Card>
      )}
    />
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    meta: { ...Typography.caption, color: c.textSecondary },
    count: { ...Typography.caption, color: c.textTertiary },
  });
}
