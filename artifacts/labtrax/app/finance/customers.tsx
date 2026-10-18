import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, Linking, TextInput, Keyboard } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useDoctorDirectory, type DoctorDirectoryEntry } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography, Radius } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { ListScreen } from "@/components/ui/ListScreen";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";

type ViewMode = "open" | "all";

export default function CustomersScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const labOrgId = primaryLabOrgId(useMe().data);
  const [viewMode, setViewMode] = useState<ViewMode>("open");
  const [search, setSearch] = useState("");

  const query = useDoctorDirectory(labOrgId, { search, openOnly: viewMode === "open" });

  const displayCount = (d: DoctorDirectoryEntry) =>
    viewMode === "open" ? (d.openCases ?? 0) : (d.totalCases ?? 0);

  const count = query.total;

  const toggle = (
    <>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={17} color={colors.textTertiary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search customers"
          placeholderTextColor={colors.textTertiary}
          style={styles.searchInput}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => Keyboard.dismiss()}
          testID="customer-search"
        />
      </View>
      <View style={styles.toggleRow}>
        <Pressable style={[styles.toggleBtn, viewMode === "open" && styles.toggleBtnActive]} onPress={() => setViewMode("open")}>
          <Text style={[styles.toggleText, viewMode === "open" && styles.toggleTextActive]}>Open only</Text>
        </Pressable>
        <Pressable style={[styles.toggleBtn, styles.toggleBtnRight, viewMode === "all" && styles.toggleBtnActive]} onPress={() => setViewMode("all")}>
          <Text style={[styles.toggleText, viewMode === "all" && styles.toggleTextActive]}>All cases</Text>
        </Pressable>
      </View>
    </>
  );

  return (
    <ListScreen<DoctorDirectoryEntry>
      title="Customer Center"
      subtitle={query.isLoading ? "Loading…" : `${count} customer${count === 1 ? "" : "s"}`}
      query={query}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={query.fetchNextPage}
      onRefresh={query.refresh}
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
        const displayPhone = d.practicePhone || d.doctorPhone || null;
        return (
          <Card
            style={styles.row}
            onPress={() =>
              router.push({
                pathname: "/finance/doctor-cases",
                params: {
                  doctorName: d.doctorName,
                  providerOrganizationId: d.providerOrganizationId ?? "",
                  labOrganizationId: labOrgId ?? "",
                  practiceName: d.practiceName ?? "",
                  initialViewMode: viewMode,
                  phone: displayPhone ?? "",
                },
              } as never)
            }
          >
            <View style={styles.main}>
              <Text style={styles.name} numberOfLines={1}>
                {d.doctorName || "Unknown doctor"}
                {d.practiceAccountNumber ? <Text style={styles.accountBadge}>{" "}#{d.practiceAccountNumber}</Text> : null}
              </Text>
              {d.practiceName ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {d.practiceName}
                </Text>
              ) : null}
              {displayPhone ? (
                <Pressable
                  style={styles.phoneRow}
                  onPress={(e) => {
                    e.stopPropagation();
                    Linking.openURL(`tel:${displayPhone}`);
                  }}
                  hitSlop={4}
                >
                  <Ionicons name="call-outline" size={11} color={colors.tint} style={styles.phoneIcon} />
                  <Text style={styles.phoneText} numberOfLines={1}>
                    {displayPhone}
                  </Text>
                </Pressable>
              ) : null}
              {d.providerOrganizationId ? (
                <Pressable
                  testID={`provider-authorization-${d.providerOrganizationId}`}
                  onPress={(e) => { e.stopPropagation(); router.push({ pathname: "/finance/provider-authorizations", params: { providerOrganizationId: d.providerOrganizationId } } as never); }}
                >
                  <Text style={styles.phoneText}>Manage auto-pay authorization</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={[styles.badge, caseCount === 0 && styles.badgeEmpty]}>
              <Text style={[styles.badgeText, caseCount === 0 && styles.badgeTextEmpty]}>
                {caseCount}{viewMode === "open" ? " open" : ""} case{caseCount === 1 ? "" : "s"}
              </Text>
            </View>
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
    accountBadge: { ...Typography.caption, color: c.textTertiary },
    phoneRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 3,
      marginTop: 1,
    },
    phoneIcon: {
      marginTop: 0,
    },
    phoneText: {
      ...Typography.caption,
      color: c.tint,
    },
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
    searchWrap: {
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.sm,
      minHeight: 42,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    searchInput: { ...Typography.body, color: c.text, flex: 1, paddingVertical: Spacing.sm },
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
    authorizationButton: { marginHorizontal: Spacing.lg, marginBottom: Spacing.lg, minHeight: 44, borderRadius: Radius.md, backgroundColor: c.tint, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm },
    authorizationButtonText: { ...Typography.bodySemibold, color: "#fff" },
  });
}
