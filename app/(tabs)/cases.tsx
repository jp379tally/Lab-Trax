import React, { useState, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus, LabCase } from "@/lib/data";

export default function CasesScreen() {
  const { cases, role, adminUnlocked } = useApp();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<CaseStatus | "ALL">("ALL");

  const filteredCases = useMemo(() => {
    let result = cases;
    if (filterStatus !== "ALL") {
      result = result.filter((c) => c.status === filterStatus);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.caseNumber.toLowerCase().includes(q) ||
          c.doctorName.toLowerCase().includes(q) ||
          c.patientName.toLowerCase().includes(q) ||
          c.material.toLowerCase().includes(q) ||
          c.shade.toLowerCase().includes(q),
      );
    }
    return result;
  }, [cases, filterStatus, search]);

  const showPrice = role === "admin" && adminUnlocked;

  function renderCaseItem({ item }: { item: LabCase }) {
    const stationInfo = getStationInfo(item.status);
    return (
      <Pressable
        style={({ pressed }) => [
          styles.caseCard,
          pressed && { opacity: 0.7 },
        ]}
        onPress={() =>
          router.push({
            pathname: "/case/[id]",
            params: { id: item.id },
          })
        }
      >
        <View style={styles.caseTop}>
          <View style={styles.caseLeft}>
            <View style={styles.caseHeader}>
              <Text style={styles.caseNumber}>{item.caseNumber}</Text>
              {item.isRush && (
                <View style={styles.rushBadge}>
                  <Ionicons name="flash" size={10} color="#EF4444" />
                  <Text style={styles.rushText}>RUSH</Text>
                </View>
              )}
            </View>
            <Text style={styles.caseDoctor}>{item.doctorName}</Text>
            <Text style={styles.caseMeta}>
              {item.toothIndices} · {item.shade} · {item.material}
            </Text>
          </View>
          <View style={styles.caseRight}>
            <View
              style={[
                styles.statusBadge,
                { backgroundColor: stationInfo.color + "18" },
              ]}
            >
              <Text style={[styles.statusText, { color: stationInfo.color }]}>
                {stationInfo.label.toUpperCase()}
              </Text>
            </View>
            {showPrice && (
              <Text style={styles.casePrice}>${item.price.toFixed(2)}</Text>
            )}
          </View>
        </View>
        <View style={styles.caseBottom}>
          <Text style={styles.caseDue}>Due: {item.dueDate}</Text>
          <Feather
            name="chevron-right"
            size={16}
            color={Colors.light.textTertiary}
          />
        </View>
      </Pressable>
    );
  }

  const filters: { id: CaseStatus | "ALL"; label: string }[] = [
    { id: "ALL", label: "All" },
    ...STATIONS.map((s) => ({
      id: s.id,
      label: s.label,
    })),
  ];

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.header,
          {
            paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12,
          },
        ]}
      >
        <Text style={styles.title}>Cases</Text>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Feather
              name="search"
              size={18}
              color={Colors.light.textTertiary}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search cases..."
              placeholderTextColor={Colors.light.textTertiary}
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch("")}>
                <Ionicons
                  name="close-circle"
                  size={18}
                  color={Colors.light.textTertiary}
                />
              </Pressable>
            )}
          </View>
        </View>
        <FlatList
          horizontal
          data={filters}
          keyExtractor={(item) => item.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setFilterStatus(item.id)}
              style={[
                styles.filterChip,
                filterStatus === item.id && styles.filterChipActive,
              ]}
            >
              <Text
                style={[
                  styles.filterText,
                  filterStatus === item.id && styles.filterTextActive,
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          )}
        />
      </View>

      <FlatList
        data={filteredCases}
        keyExtractor={(item) => item.id}
        renderItem={renderCaseItem}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 },
        ]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Feather
              name="inbox"
              size={48}
              color={Colors.light.textTertiary}
            />
            <Text style={styles.emptyText}>No cases found</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 14,
  },
  searchRow: {
    marginBottom: 12,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.surfaceSecondary,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    padding: 0,
  },
  filterList: {
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.light.surfaceSecondary,
  },
  filterChipActive: {
    backgroundColor: Colors.light.tint,
  },
  filterText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  filterTextActive: {
    color: "#FFF",
  },
  listContent: {
    padding: 20,
    gap: 10,
  },
  caseCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  caseTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  caseLeft: {
    flex: 1,
  },
  caseHeader: {
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
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  caseMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    marginTop: 4,
  },
  caseRight: {
    alignItems: "flex-end",
    gap: 6,
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
  casePrice: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  caseBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  caseDue: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
  },
});
