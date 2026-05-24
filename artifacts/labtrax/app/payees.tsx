import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { getAccessToken, getApiUrl } from "@/lib/query-client";

type VendorType = "vendor" | "employee" | "item";

interface Vendor {
  id: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  vendorType: VendorType;
  isActive: boolean;
}

const TYPE_LABELS: Record<VendorType, string> = {
  vendor: "Vendors",
  employee: "Employees",
  item: "Items",
};

const TYPE_ICON: Record<VendorType, keyof typeof Ionicons.glyphMap> = {
  vendor: "business-outline",
  employee: "person-outline",
  item: "cube-outline",
};

const TYPE_COLOR: Record<VendorType, { icon: string; bg: string }> = {
  vendor: { icon: "#0284C7", bg: "#E0F2FE" },
  employee: { icon: "#7C3AED", bg: "#EDE9FE" },
  item: { icon: "#059669", bg: "#D1FAE5" },
};

async function apiFetch<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`/api${path}`, getApiUrl()).toString();
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

async function getLabOrgId(): Promise<string | null> {
  try {
    const data = await apiFetch<{ memberships?: Array<{ organizationId?: string; labId?: string; role: string; status: string; organization?: { userType?: string } | null }> }>("/auth/me");
    const memberships = data?.memberships || [];
    const labMembership = memberships.find(
      (m) =>
        m.status === "active" &&
        (m.organization?.userType === "lab" || !m.organization?.userType) &&
        (m.organizationId || m.labId)
    );
    return labMembership?.organizationId || labMembership?.labId || null;
  } catch {
    return null;
  }
}

function VendorCard({ vendor }: { vendor: Vendor }) {
  const colors = TYPE_COLOR[vendor.vendorType];
  return (
    <View style={styles.card}>
      <View style={[styles.cardIcon, { backgroundColor: colors.bg }]}>
        <Ionicons name={TYPE_ICON[vendor.vendorType]} size={20} color={colors.icon} />
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardName} numberOfLines={1}>{vendor.name}</Text>
        {vendor.phone ? (
          <View style={styles.cardRow}>
            <Ionicons name="call-outline" size={13} color={Colors.light.textSecondary} />
            <Text style={styles.cardMeta}>{vendor.phone}</Text>
          </View>
        ) : null}
        {vendor.address ? (
          <View style={styles.cardRow}>
            <Ionicons name="location-outline" size={13} color={Colors.light.textSecondary} />
            <Text style={styles.cardMeta} numberOfLines={2}>{vendor.address}</Text>
          </View>
        ) : null}
        {!vendor.phone && !vendor.address ? (
          <Text style={[styles.cardMeta, { color: Colors.light.textTertiary }]}>No contact info</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function PayeesScreen() {
  const insets = useSafeAreaInsets();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<VendorType | "all">("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const orgId = await getLabOrgId();
        if (!orgId) {
          if (!cancelled) {
            setError("No active lab membership found.");
            setLoading(false);
          }
          return;
        }
        const result = await apiFetch<{ ok: boolean; data: Vendor[] }>(
          `/finance/vendors?organizationId=${encodeURIComponent(orgId)}`
        );
        if (!cancelled) {
          setVendors(result?.data || []);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load payees.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors.filter((v) => {
      if (activeFilter !== "all" && v.vendorType !== activeFilter) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        (v.phone || "").toLowerCase().includes(q) ||
        (v.address || "").toLowerCase().includes(q)
      );
    });
  }, [vendors, search, activeFilter]);

  const sections = useMemo(() => {
    const order: VendorType[] = ["vendor", "employee", "item"];
    return order
      .map((type) => ({
        title: TYPE_LABELS[type],
        type,
        data: filtered.filter((v) => v.vendorType === type),
      }))
      .filter((s) => s.data.length > 0);
  }, [filtered]);

  const totalCount = filtered.length;

  return (
    <>
      <Stack.Screen
        options={{
          title: "Payees",
          headerBackTitle: "Back",
        }}
      />
      <View
        style={[
          styles.container,
          {
            paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : insets.bottom + 16,
          },
        ]}
      >
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={Colors.light.textSecondary} style={{ marginRight: 8 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name, phone, or address…"
              placeholderTextColor={Colors.light.textTertiary}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
            {search.length > 0 && Platform.OS !== "ios" ? (
              <Pressable onPress={() => setSearch("")} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={Colors.light.textSecondary} />
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.filterRow}>
          {(["all", "vendor", "employee", "item"] as const).map((f) => {
            const active = activeFilter === f;
            const label = f === "all" ? "All" : TYPE_LABELS[f];
            return (
              <Pressable
                key={f}
                onPress={() => setActiveFilter(f)}
                style={[styles.filterChip, active && styles.filterChipActive]}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.light.tint} size="large" />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Ionicons name="alert-circle-outline" size={40} color={Colors.light.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : sections.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="people-outline" size={48} color={Colors.light.textTertiary} />
            <Text style={styles.emptyTitle}>
              {search || activeFilter !== "all" ? "No matches found" : "No payees yet"}
            </Text>
            <Text style={styles.emptySubtitle}>
              {search || activeFilter !== "all"
                ? "Try a different search or filter"
                : "Payees are managed from the desktop app"}
            </Text>
          </View>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
            stickySectionHeadersEnabled={false}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              <Text style={styles.countLabel}>
                {totalCount} {totalCount === 1 ? "payee" : "payees"}
              </Text>
            }
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <View style={[styles.sectionIconWrap, { backgroundColor: TYPE_COLOR[section.type as VendorType].bg }]}>
                  <Ionicons
                    name={TYPE_ICON[section.type as VendorType]}
                    size={14}
                    color={TYPE_COLOR[section.type as VendorType].icon}
                  />
                </View>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionCount}>{section.data.length}</Text>
              </View>
            )}
            renderItem={({ item }) => <VendorCard vendor={item} />}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.backgroundSolid,
  },
  searchRow: {
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 12,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  filterChipActive: {
    backgroundColor: Colors.light.tint,
    borderColor: Colors.light.tint,
  },
  filterChipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  filterChipTextActive: {
    color: "#FFF",
  },
  countLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    marginTop: 4,
  },
  sectionIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
  },
  sectionTitle: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionCount: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: Colors.light.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
    padding: 14,
    marginBottom: 8,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    marginBottom: 2,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
  },
  cardMeta: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    lineHeight: 18,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.error,
    textAlign: "center",
  },
  emptyTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
  },
});
