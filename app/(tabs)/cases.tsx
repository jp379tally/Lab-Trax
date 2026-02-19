import React, { useState, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  Platform,
  Modal,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus, LabCase } from "@/lib/data";
import { ChatButton } from "@/components/ChatButton";

export default function CasesScreen() {
  const { cases, role, adminUnlocked, findCaseByBarcode, getUserGroups } = useApp();
  const { userType, currentUser, registeredUsers } = useAuth();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<CaseStatus | "ALL">("ALL");
  const [showBarcodeLocate, setShowBarcodeLocate] = useState(false);
  const [barcodeLocateScanned, setBarcodeLocateScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  function handleBarcodeLocateScanned({ data }: { data: string }) {
    if (barcodeLocateScanned) return;
    setBarcodeLocateScanned(true);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const found = findCaseByBarcode(data);
    if (found) {
      setShowBarcodeLocate(false);
      setBarcodeLocateScanned(false);
      router.push({ pathname: "/case/[id]", params: { id: found.id } });
    } else {
      const foundDirect = cases.find(c => c.id === data || c.caseNumber === data);
      if (foundDirect) {
        setShowBarcodeLocate(false);
        setBarcodeLocateScanned(false);
        router.push({ pathname: "/case/[id]", params: { id: foundDirect.id } });
      } else {
        Alert.alert("Case Not Found", `No case found with barcode: ${data}`, [
          { text: "Scan Again", onPress: () => setBarcodeLocateScanned(false) },
          { text: "Close", onPress: () => { setShowBarcodeLocate(false); setBarcodeLocateScanned(false); } },
        ]);
      }
    }
  }

  const filteredCases = useMemo(() => {
    let result = cases;

    if (userType === "provider") {
      const myGroups = getUserGroups(currentUser || "");
      if (myGroups.length === 0) {
        return [];
      }
      const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
      const myDoctorName = currentUserData?.doctorName || currentUser || "";
      result = result.filter(c =>
        c.doctorName.toLowerCase() === myDoctorName.toLowerCase() ||
        c.doctorName.toLowerCase().includes((currentUser || "").toLowerCase())
      );
    }

    if (filterStatus !== "ALL") {
      result = result.filter((c) => c.status === filterStatus);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          (c.caseNumber || "").toLowerCase().includes(q) ||
          (c.doctorName || "").toLowerCase().includes(q) ||
          (c.patientName || "").toLowerCase().includes(q) ||
          (c.material || "").toLowerCase().includes(q) ||
          (c.shade || "").toLowerCase().includes(q),
      );
    }
    return result;
  }, [cases, filterStatus, search, userType, currentUser, registeredUsers]);

  const showPrice = role === "admin" && adminUnlocked;

  function renderCaseItem({ item }: { item: LabCase }) {
    const stationInfo = getStationInfo(item.status);
    const patientCaseCount = cases.filter(
      (c) => (c.patientName || "").toLowerCase() === (item.patientName || "").toLowerCase()
    ).length;
    const showChartBtn = patientCaseCount > 1 || item.isRemake;
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
              <Text style={styles.casePatient}>{item.patientName}</Text>
              {item.isRemake && (
                <View style={styles.remakeBadge}>
                  <Ionicons name="refresh" size={8} color="#FFF" />
                </View>
              )}
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
          <Text style={styles.caseDue}>{item.caseNumber} · Due: {item.dueDate}</Text>
          {showChartBtn && (
            <Pressable
              onPress={() => {
                router.push(`/chart-history?patient=${encodeURIComponent(item.patientName)}`);
              }}
              style={styles.chartHistoryChip}
              testID={`chart-history-${item.id}`}
            >
              <Ionicons name="play-circle" size={16} color="#3B82F6" />
              <Text style={styles.chartHistoryChipText}>{patientCaseCount}</Text>
            </Pressable>
          )}
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
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={styles.title}>Cases</Text>
          <ChatButton />
        </View>
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
          {userType !== "provider" && (
            <Pressable
              style={({ pressed }) => [styles.barcodeLocateBtn, pressed && { opacity: 0.7 }]}
              onPress={async () => {
                if (Platform.OS !== "web" && !permission?.granted) {
                  const result = await requestPermission();
                  if (!result.granted) {
                    Alert.alert("Camera Permission", "Camera access is needed to scan barcodes.");
                    return;
                  }
                }
                setShowBarcodeLocate(true);
                setBarcodeLocateScanned(false);
              }}
            >
              <Ionicons name="barcode-outline" size={18} color={Colors.light.tint} />
              <Text style={styles.barcodeLocateBtnText}>Use Barcode to Locate Case</Text>
            </Pressable>
          )}
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

      <Modal
        transparent
        visible={showBarcodeLocate}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => { setShowBarcodeLocate(false); setBarcodeLocateScanned(false); }}
      >
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(0,0,0,0.8)" }}>
            <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Scan to Locate Case</Text>
            <Pressable onPress={() => { setShowBarcodeLocate(false); setBarcodeLocateScanned(false); }}>
              <Ionicons name="close" size={28} color="#FFF" />
            </Pressable>
          </View>
          {Platform.OS === "web" ? (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
              <Ionicons name="barcode-outline" size={60} color="#FFF" />
              <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 16 }}>Barcode scanning requires a device camera.</Text>
              <Pressable onPress={() => { setShowBarcodeLocate(false); setBarcodeLocateScanned(false); }} style={{ marginTop: 20, backgroundColor: Colors.light.tint, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 }}>
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Close</Text>
              </Pressable>
            </View>
          ) : (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a"] }}
              onBarcodeScanned={handleBarcodeLocateScanned}
            >
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <View style={{ width: 260, height: 160, borderWidth: 2, borderColor: "rgba(255,255,255,0.5)", borderRadius: 16, borderStyle: "dashed" }} />
                <Text style={{ color: "#FFF", fontSize: 14, fontFamily: "Inter_500Medium", marginTop: 16 }}>Point camera at barcode</Text>
              </View>
            </CameraView>
          )}
        </View>
      </Modal>
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
  casePatient: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  caseNumber: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
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
  remakeBadge: {
    backgroundColor: "#EF4444",
    borderRadius: 8,
    width: 16,
    height: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  chartHistoryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#EFF6FF",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: "auto",
    marginRight: 6,
  },
  chartHistoryChipText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: "#3B82F6",
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
  barcodeLocateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tintLight,
    borderRadius: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  barcodeLocateBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
});
