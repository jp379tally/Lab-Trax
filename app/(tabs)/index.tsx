import React from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";
import { getStationInfo } from "@/lib/data";

function TechDashboard() {
  const { cases, activeCaseCount, rushCaseCount } = useApp();
  const insets = useSafeAreaInsets();
  const recentCases = cases
    .filter((c) => c.status !== "COMPLETE")
    .slice(0, 5);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
        paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Lab Floor</Text>
          <Text style={styles.headerTitle}>Production Dashboard</Text>
        </View>
        <View style={styles.statusDot}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
      </View>

      <LinearGradient
        colors={["#2563EB", "#1D4ED8"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.heroCard}
      >
        <Text style={styles.heroLabel}>LAB STATUS</Text>
        <Text style={styles.heroCount}>{activeCaseCount} Active Cases</Text>
        <Text style={styles.heroSub}>
          {rushCaseCount} Rush{rushCaseCount !== 1 ? "es" : ""} Pending
        </Text>
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatNum}>
              {cases.filter((c) => c.status === "INTAKE").length}
            </Text>
            <Text style={styles.heroStatLabel}>Intake</Text>
          </View>
          <View style={[styles.heroStatDivider]} />
          <View style={styles.heroStat}>
            <Text style={styles.heroStatNum}>
              {
                cases.filter(
                  (c) =>
                    c.status !== "INTAKE" &&
                    c.status !== "SHIP" &&
                    c.status !== "COMPLETE",
                ).length
              }
            </Text>
            <Text style={styles.heroStatLabel}>In Progress</Text>
          </View>
          <View style={[styles.heroStatDivider]} />
          <View style={styles.heroStat}>
            <Text style={styles.heroStatNum}>
              {
                cases.filter(
                  (c) => c.status === "SHIP" || c.status === "COMPLETE",
                ).length
              }
            </Text>
            <Text style={styles.heroStatLabel}>Shipped</Text>
          </View>
        </View>
      </LinearGradient>

      <View style={styles.quickActions}>
        <Pressable
          style={({ pressed }) => [
            styles.quickBtn,
            pressed && styles.quickBtnPressed,
          ]}
          onPress={() => router.push("/(tabs)/scan")}
        >
          <View
            style={[styles.quickIcon, { backgroundColor: Colors.light.tintLight }]}
          >
            <Ionicons name="add" size={24} color={Colors.light.tint} />
          </View>
          <Text style={styles.quickLabel}>New Intake</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.quickBtn,
            pressed && styles.quickBtnPressed,
          ]}
          onPress={() => router.push("/(tabs)/cases")}
        >
          <View
            style={[
              styles.quickIcon,
              { backgroundColor: Colors.light.accentLight },
            ]}
          >
            <Feather name="search" size={22} color={Colors.light.accent} />
          </View>
          <Text style={styles.quickLabel}>Search</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.quickBtn,
            pressed && styles.quickBtnPressed,
          ]}
          onPress={() => router.push("/(tabs)/notifications")}
        >
          <View
            style={[
              styles.quickIcon,
              { backgroundColor: Colors.light.warningLight },
            ]}
          >
            <Ionicons
              name="alert-circle-outline"
              size={22}
              color={Colors.light.warning}
            />
          </View>
          <Text style={styles.quickLabel}>Alerts</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recent Cases</Text>
        <Pressable onPress={() => router.push("/(tabs)/cases")}>
          <Text style={styles.seeAll}>See all</Text>
        </Pressable>
      </View>

      <View style={styles.caseList}>
        {recentCases.map((c) => {
          const stationInfo = getStationInfo(c.status);
          return (
            <Pressable
              key={c.id}
              style={({ pressed }) => [
                styles.caseCard,
                pressed && { opacity: 0.7 },
              ]}
              onPress={() =>
                router.push({
                  pathname: "/case/[id]",
                  params: { id: c.id },
                })
              }
            >
              <View style={styles.caseCardTop}>
                <View style={styles.caseInfo}>
                  <View style={styles.caseNumberRow}>
                    <Text style={styles.caseNumber}>{c.caseNumber}</Text>
                    {c.isRush && (
                      <View style={styles.rushBadge}>
                        <Ionicons
                          name="flash"
                          size={10}
                          color="#EF4444"
                        />
                        <Text style={styles.rushText}>RUSH</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.caseDoctor}>{c.doctorName}</Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: stationInfo.color + "18" },
                  ]}
                >
                  <Text
                    style={[styles.statusText, { color: stationInfo.color }]}
                  >
                    {stationInfo.label.toUpperCase()}
                  </Text>
                </View>
              </View>
              <View style={styles.caseCardBottom}>
                <Text style={styles.caseMeta}>
                  {c.toothIndices} · {c.shade} · {c.material}
                </Text>
                <Feather
                  name="chevron-right"
                  size={16}
                  color={Colors.light.textTertiary}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function AdminLockScreen() {
  const { setAdminUnlocked } = useApp();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.lockContainer,
        {
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
        },
      ]}
    >
      <View style={styles.lockContent}>
        <View style={styles.lockIconWrap}>
          <Ionicons name="shield-checkmark" size={48} color={Colors.light.tint} />
        </View>
        <Text style={styles.lockTitle}>Admin Vault</Text>
        <Text style={styles.lockDesc}>
          Accessing sensitive financial data requires re-authentication.
        </Text>
        <Pressable
          style={({ pressed }) => [
            styles.unlockBtn,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          onPress={() => setAdminUnlocked(true)}
        >
          <Ionicons
            name="finger-print"
            size={20}
            color="#FFF"
            style={{ marginRight: 8 }}
          />
          <Text style={styles.unlockBtnText}>Unlock Vault</Text>
        </Pressable>
      </View>
    </View>
  );
}

function AdminDashboard() {
  const { cases } = useApp();
  const insets = useSafeAreaInsets();
  const totalRevenue = cases.reduce((sum, c) => sum + c.price, 0);
  const pendingInvoices = cases.filter(
    (c) => c.status === "SHIP" || c.status === "COMPLETE",
  ).length;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
        paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Admin</Text>
          <Text style={styles.headerTitle}>Financial Vault</Text>
        </View>
        <View style={styles.lockIndicator}>
          <Ionicons name="lock-open" size={14} color={Colors.light.success} />
        </View>
      </View>

      <LinearGradient
        colors={["#0F172A", "#1E293B"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.heroCard}
      >
        <Text style={[styles.heroLabel, { opacity: 0.5 }]}>MONTH TO DATE</Text>
        <Text style={styles.heroCount}>
          ${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </Text>
        <View style={styles.adminBadges}>
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>+12% vs LY</Text>
          </View>
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>{cases.length} Cases</Text>
          </View>
        </View>
      </LinearGradient>

      <View style={styles.adminMenu}>
        <Pressable
          style={({ pressed }) => [
            styles.adminMenuItem,
            pressed && { opacity: 0.7 },
          ]}
        >
          <View
            style={[
              styles.adminMenuIcon,
              { backgroundColor: Colors.light.accentLight },
            ]}
          >
            <Ionicons
              name="document-text"
              size={20}
              color={Colors.light.accent}
            />
          </View>
          <View style={styles.adminMenuInfo}>
            <Text style={styles.adminMenuTitle}>Invoicing</Text>
            <Text style={styles.adminMenuSub}>
              {pendingInvoices} Pending Statements
            </Text>
          </View>
          <Feather
            name="chevron-right"
            size={18}
            color={Colors.light.textTertiary}
          />
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.adminMenuItem,
            pressed && { opacity: 0.7 },
          ]}
        >
          <View
            style={[
              styles.adminMenuIcon,
              { backgroundColor: Colors.light.successLight },
            ]}
          >
            <Ionicons
              name="people"
              size={20}
              color={Colors.light.success}
            />
          </View>
          <View style={styles.adminMenuInfo}>
            <Text style={styles.adminMenuTitle}>Client Tiers</Text>
            <Text style={styles.adminMenuSub}>Adjust Discount Rates</Text>
          </View>
          <Feather
            name="chevron-right"
            size={18}
            color={Colors.light.textTertiary}
          />
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.adminMenuItem,
            pressed && { opacity: 0.7 },
          ]}
        >
          <View
            style={[
              styles.adminMenuIcon,
              { backgroundColor: Colors.light.warningLight },
            ]}
          >
            <MaterialCommunityIcons
              name="chart-line"
              size={20}
              color={Colors.light.warning}
            />
          </View>
          <View style={styles.adminMenuInfo}>
            <Text style={styles.adminMenuTitle}>Revenue Feed</Text>
            <Text style={styles.adminMenuSub}>Real-time Projections</Text>
          </View>
          <Feather
            name="chevron-right"
            size={18}
            color={Colors.light.textTertiary}
          />
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.adminMenuItem,
            pressed && { opacity: 0.7 },
          ]}
        >
          <View
            style={[
              styles.adminMenuIcon,
              { backgroundColor: Colors.light.errorLight },
            ]}
          >
            <Ionicons
              name="pricetag"
              size={20}
              color={Colors.light.error}
            />
          </View>
          <View style={styles.adminMenuInfo}>
            <Text style={styles.adminMenuTitle}>Price Editor</Text>
            <Text style={styles.adminMenuSub}>Global Tiers & Overrides</Text>
          </View>
          <Feather
            name="chevron-right"
            size={18}
            color={Colors.light.textTertiary}
          />
        </Pressable>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Case Revenue</Text>
      </View>
      <View style={styles.caseList}>
        {cases.slice(0, 5).map((c) => {
          const stationInfo = getStationInfo(c.status);
          return (
            <Pressable
              key={c.id}
              style={({ pressed }) => [
                styles.caseCard,
                pressed && { opacity: 0.7 },
              ]}
              onPress={() =>
                router.push({
                  pathname: "/case/[id]",
                  params: { id: c.id },
                })
              }
            >
              <View style={styles.caseCardTop}>
                <View style={styles.caseInfo}>
                  <Text style={styles.caseNumber}>
                    {c.caseNumber} - {c.doctorName}
                  </Text>
                  <Text style={styles.caseMeta}>
                    {c.material} · {c.toothIndices}
                  </Text>
                </View>
                <Text style={styles.casePrice}>
                  ${c.price.toFixed(2)}
                </Text>
              </View>
              <View style={styles.caseCardBottom}>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: stationInfo.color + "18" },
                  ]}
                >
                  <Text
                    style={[styles.statusText, { color: stationInfo.color }]}
                  >
                    {stationInfo.label.toUpperCase()}
                  </Text>
                </View>
                <Feather
                  name="chevron-right"
                  size={16}
                  color={Colors.light.textTertiary}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

export default function DashboardScreen() {
  const { role, adminUnlocked, isLoading } = useApp();

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.light.tint} />
      </View>
    );
  }

  if (role === "admin" && !adminUnlocked) {
    return <AdminLockScreen />;
  }

  if (role === "admin") {
    return <AdminDashboard />;
  }

  return <TechDashboard />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.light.background,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  greeting: {
    fontSize: 13,
    color: Colors.light.textSecondary,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase" as const,
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  headerTitle: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  statusDot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.light.successLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.light.success,
  },
  liveText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.success,
    letterSpacing: 1,
  },
  heroCard: {
    marginHorizontal: 20,
    padding: 24,
    borderRadius: 24,
    marginBottom: 24,
  },
  heroLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.7)",
    letterSpacing: 2,
    textTransform: "uppercase" as const,
    marginBottom: 6,
  },
  heroCount: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    marginBottom: 4,
  },
  heroSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.6)",
    marginBottom: 20,
  },
  heroStats: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 16,
    padding: 14,
  },
  heroStat: {
    flex: 1,
    alignItems: "center",
  },
  heroStatNum: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  heroStatLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
  },
  heroStatDivider: {
    width: 1,
    height: 30,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  quickActions: {
    flexDirection: "row",
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 28,
  },
  quickBtn: {
    flex: 1,
    backgroundColor: Colors.light.surface,
    borderRadius: 20,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  quickBtnPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.97 }],
  },
  quickIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  quickLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  seeAll: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  caseList: {
    paddingHorizontal: 20,
    gap: 10,
  },
  caseCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  caseCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  caseInfo: {
    flex: 1,
  },
  caseNumberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  caseNumber: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  rushBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: Colors.light.errorLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  rushText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: Colors.light.error,
    letterSpacing: 0.5,
  },
  caseDoctor: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  caseCardBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  caseMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  casePrice: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  lockContainer: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  lockContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  lockIconWrap: {
    width: 96,
    height: 96,
    borderRadius: 32,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
  },
  lockTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 12,
  },
  lockDesc: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 40,
  },
  unlockBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 16,
    width: "100%",
  },
  unlockBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  lockIndicator: {
    backgroundColor: Colors.light.successLight,
    padding: 8,
    borderRadius: 12,
  },
  adminBadges: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
  },
  adminBadge: {
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  adminBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.8)",
  },
  adminMenu: {
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 28,
  },
  adminMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.surface,
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  adminMenuIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  adminMenuInfo: {
    flex: 1,
  },
  adminMenuTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  adminMenuSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
});
