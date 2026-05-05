import React, { useState, useMemo, useEffect, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus, LabCase, cleanDoctorDisplay, MATERIAL_PRICES, Invoice } from "@/lib/data";
import { resolvePriceForCase } from "@/lib/pricing";
import { ChatButton } from "@/components/ChatButton";
import InvoicePDFViewer from "@/components/InvoicePDFViewer";

function deriveDisplayInitials(input?: {
  firstName?: string | null;
  lastName?: string | null;
  label?: string | null;
}) {
  const firstInitial = input?.firstName?.trim()?.[0];
  const lastInitial = input?.lastName?.trim()?.[0];
  if (firstInitial && lastInitial) {
    return `${firstInitial}${lastInitial}`.toUpperCase();
  }

  const normalizedLabel = input?.label?.trim() || "";
  if (!normalizedLabel) {
    return "??";
  }

  const parts = normalizedLabel
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  return normalizedLabel.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "??";
}

export default function CasesScreen() {
  const { cases, role, adminUnlocked, findCaseByBarcode, updateCaseStatus, customStationLabels, invoices, updateInvoice, addInvoice, updateCase, addCaseNote, clients, pricingTiers, refreshCases, fullRefreshCases, setPendingInvoiceEditId } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const { userType, currentUser, registeredUsers } = useAuth();
  const insets = useSafeAreaInsets();
  const [companyLogo, setCompanyLogo] = useState<string | null>(null);
  useEffect(() => {
    AsyncStorage.getItem("@drivesync_company_logo").then((uri) => {
      if (uri) setCompanyLogo(uri);
    });
  }, []);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<CaseStatus | "ALL">("ALL");
  const [showBarcodeLocate, setShowBarcodeLocate] = useState(false);
  const [barcodeLocateScanned, setBarcodeLocateScanned] = useState(false);
  const barcodeLocateProcessingRef = useRef(false);
  const [locateCaseId, setLocateCaseId] = useState<string | null>(null);
  const locateCase = locateCaseId ? cases.find(c => c.id === locateCaseId) : null;
  const [permission, requestPermission] = useCameraPermissions();
  const [invoiceCase, setInvoiceCase] = useState<LabCase | null>(null);
  const isAdmin = role === "admin";
  const currentRegisteredUser = registeredUsers.find(
    (user) => user.username?.toLowerCase() === (currentUser || "").toLowerCase()
  );
  const userInitials = deriveDisplayInitials({
    firstName: currentRegisteredUser?.firstName,
    lastName: currentRegisteredUser?.lastName,
    label: currentRegisteredUser?.username || currentUser,
  });

  function getCaseInvoice(caseItem: LabCase): Invoice {
    if (caseItem.invoiceId) {
      const found = invoices.find((inv) => inv.id === caseItem.invoiceId);
      if (found) return found;
    }
    const matchedInv = invoices.find(
      (inv) => inv.caseIds.includes(caseItem.id) ||
        (inv.patientName.toLowerCase() === (caseItem.patientName || "").toLowerCase() && inv.clientName.toLowerCase().includes(caseItem.doctorName.split(" ").pop()?.toLowerCase() || ""))
    );
    if (matchedInv) return matchedInv;
    const toothCount = caseItem.toothMap?.length || caseItem.toothIndices.split(",").filter(Boolean).length || 1;
    const rate = resolvePriceForCase(caseItem.material, caseItem.caseType, caseItem.doctorName, clients, pricingTiers);
    const lineItems = [
      { qty: toothCount, item: `${caseItem.material} ${caseItem.caseType || "Restoration"}`, description: `${caseItem.material} restoration - teeth ${caseItem.toothIndices}`, rate, amount: toothCount * rate },
    ];
    if (caseItem.isRush) {
      lineItems.push({ qty: 1, item: "Rush Fee", description: "Expedited turnaround", rate: 500, amount: 500 });
    }
    const total = lineItems.reduce((s, li) => s + li.amount, 0);
    const invNum = `INV-${new Date(caseItem.createdAt).getFullYear()}-${caseItem.caseNumber.replace(/[^0-9]/g, "").padStart(3, "0")}`;
    return {
      id: caseItem.id + "-inv",
      invoiceNumber: invNum,
      clientId: "",
      clientName: caseItem.doctorName,
      caseIds: [caseItem.id],
      amount: total,
      credits: caseItem.isRemake && caseItem.price === 0 ? total : 0,
      status: caseItem.status === "COMPLETE" ? "paid" as const : "open" as const,
      issuedAt: caseItem.createdAt,
      dueAt: caseItem.dueDate ? new Date(caseItem.dueDate + "T00:00:00").getTime() : caseItem.createdAt + 30 * 86400000,
      billTo: caseItem.doctorName,
      patientName: caseItem.patientName || caseItem.patientInitials,
      caseType: caseItem.caseType || "Restoration",
      teeth: caseItem.toothIndices,
      shade: caseItem.shade,
      caseNotes: caseItem.notes || "",
      lineItems,
    };
  }

  function handleBarcodeLocateScanned({ data }: { data: string }) {
    if (barcodeLocateScanned || barcodeLocateProcessingRef.current) return;
    barcodeLocateProcessingRef.current = true;
    setBarcodeLocateScanned(true);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const found = findCaseByBarcode(data);
    if (found) {
      setShowBarcodeLocate(false);
      setBarcodeLocateScanned(false);
      barcodeLocateProcessingRef.current = false;
      router.push({ pathname: "/case/[id]", params: { id: found.id } });
    } else {
      const foundDirect = cases.find(c => c.id === data || c.caseNumber === data);
      if (foundDirect) {
        setShowBarcodeLocate(false);
        setBarcodeLocateScanned(false);
        barcodeLocateProcessingRef.current = false;
        router.push({ pathname: "/case/[id]", params: { id: foundDirect.id } });
      } else {
        Alert.alert("Case Not Found", `No case found with barcode: ${data}`, [
          { text: "Scan Again", onPress: () => { setBarcodeLocateScanned(false); barcodeLocateProcessingRef.current = false; } },
          { text: "Close", onPress: () => { setShowBarcodeLocate(false); setBarcodeLocateScanned(false); barcodeLocateProcessingRef.current = false; } },
        ]);
      }
    }
  }

  const baseCases = useMemo(() => {
    let result = cases;
    if (userType === "provider") {
      const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
      const myDoctorName = currentUserData?.doctorName || currentUser || "";
      result = result.filter(c =>
        c.doctorName.toLowerCase() === myDoctorName.toLowerCase() ||
        c.doctorName.toLowerCase().includes((currentUser || "").toLowerCase())
      );
    }
    return result;
  }, [cases, userType, currentUser, registeredUsers]);

  const stationCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: baseCases.length };
    for (const c of baseCases) {
      counts[c.status] = (counts[c.status] || 0) + 1;
    }
    return counts;
  }, [baseCases]);

  const filteredCases = useMemo(() => {
    let result = baseCases;

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
  }, [baseCases, filterStatus, search]);

  const showPrice = role === "admin" && adminUnlocked;

  function renderCaseItem({ item }: { item: LabCase }) {
    const stationInfo = getStationInfo(item.status, customStationLabels);
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
        onLongPress={() => {
          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          Alert.alert(
            "Locate Case",
            "Would you like to locate this case?",
            [
              { text: "No", style: "cancel" },
              { text: "Yes", onPress: () => setLocateCaseId(item.id) },
            ]
          );
        }}
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
            <Text style={styles.caseDoctor}>{cleanDoctorDisplay(item.doctorName)}</Text>
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
          {isAdmin && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                let invId = item.invoiceId;
                if (!invId) {
                  const matched = invoices.find(inv => inv.caseIds.includes(item.id));
                  if (matched) invId = matched.id;
                }
                if (!invId) {
                  const virtual = getCaseInvoice(item);
                  const matchedClient = clients.find(c => {
                    const stripDr = (n: string) => (n || "").trim().toLowerCase().replace(/^dr\.?\s*/i, "");
                    const drName = stripDr(item.doctorName || "");
                    return stripDr(c.leadDoctor) === drName || (c.additionalProviders || []).some(p => stripDr(p) === drName);
                  });
                  const createdId = addInvoice({
                    invoiceNumber: virtual.invoiceNumber,
                    clientId: matchedClient?.id || "",
                    clientName: matchedClient?.practiceName || virtual.clientName,
                    caseIds: [item.id],
                    amount: virtual.amount,
                    credits: virtual.credits,
                    status: virtual.status,
                    issuedAt: virtual.issuedAt,
                    dueAt: virtual.dueAt,
                    lineItems: virtual.lineItems,
                    patientName: item.patientName || "",
                    billTo: matchedClient?.practiceName || "",
                    caseType: item.caseType || "",
                    teeth: item.toothIndices || "",
                    shade: item.shade || "",
                    caseNotes: "",
                  } as any);
                  invId = createdId;
                  updateCase(item.id, { invoiceId: createdId } as any);
                }
                setPendingInvoiceEditId(invId);
                router.navigate("/(tabs)");
              }}
              style={({ pressed }) => [
                {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  backgroundColor: "#2563EB",
                  marginRight: 6,
                },
                pressed && { opacity: 0.8 },
              ]}
              hitSlop={8}
              testID={`edit-invoice-${item.id}`}
            >
              <Ionicons name="document-text" size={14} color="#FFF" />
              <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>
                Invoice
              </Text>
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
      label: customStationLabels[s.id] || s.label,
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
          {Platform.OS === "web" && (
            <Pressable
              style={({ pressed }) => [styles.barcodeLocateBtn, pressed && { opacity: 0.7 }]}
              onPress={async () => {
                setRefreshing(true);
                await fullRefreshCases();
                setRefreshing(false);
              }}
            >
              {refreshing ? (
                <ActivityIndicator size={16} color={Colors.light.tint} />
              ) : (
                <Ionicons name="refresh" size={18} color={Colors.light.tint} />
              )}
              <Text style={styles.barcodeLocateBtnText}>Sync Cases</Text>
            </Pressable>
          )}
          {userType !== "provider" && (
            <Pressable
              style={({ pressed }) => [styles.barcodeLocateBtn, pressed && { opacity: 0.7 }]}
              onPress={async () => {
                if (Platform.OS === "web") {
                  setShowBarcodeLocate(true);
                  setBarcodeLocateScanned(false);
                  return;
                }
                if (!permission?.granted) {
                  Alert.alert(
                    "Camera Access",
                    "This feature uses your camera to capture dental case photos.",
                    [{
                      text: "Continue",
                      onPress: async () => {
                        const result = await requestPermission();
                        if (result.granted) {
                          setShowBarcodeLocate(true);
                          setBarcodeLocateScanned(false);
                        }
                      },
                    }]
                  );
                  return;
                }
                setShowBarcodeLocate(true);
                setBarcodeLocateScanned(false);
                barcodeLocateProcessingRef.current = false;
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
                {" "}
                <Text style={[
                  styles.filterCountText,
                  filterStatus === item.id && styles.filterTextActive,
                ]}>
                  {stationCounts[item.id] || 0}
                </Text>
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
        refreshing={refreshing}
        onRefresh={async () => {
          setRefreshing(true);
          await fullRefreshCases();
          setRefreshing(false);
        }}
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
          ) : permission?.granted ? (
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
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.4)" />
              <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12, textAlign: "center", paddingHorizontal: 40 }}>Camera permission is required to scan barcodes.</Text>
              <Pressable
                onPress={async () => {
                  const result = await requestPermission();
                  if (!result.granted) {
                    Alert.alert("Permission Denied", "Please enable camera access in your device settings.");
                  }
                }}
                style={({ pressed }) => ({ marginTop: 16, backgroundColor: Colors.light.tint, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}
              >
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Grant Camera Access</Text>
              </Pressable>
            </View>
          )}
        </View>
      </Modal>

      <Modal visible={!!locateCaseId} animationType="fade" transparent>
        <View style={locStyles.overlay}>
          <View style={locStyles.card}>
            <Text style={locStyles.title}>Locate Case</Text>
            {locateCase && (
              <Text style={locStyles.subtitle}>
                {locateCase.patientName} ({locateCase.caseNumber})
              </Text>
            )}
            <Text style={locStyles.prompt}>Select a station:</Text>
            <View style={locStyles.stationGrid}>
              {STATIONS.map((station) => {
                const isCurrent = locateCase?.status === station.id;
                return (
                  <Pressable
                    key={station.id}
                    onPress={() => {
                      if (!isCurrent && locateCaseId) {
                        updateCaseStatus(locateCaseId, station.id, userInitials);
                        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        setLocateCaseId(null);
                      }
                    }}
                    disabled={isCurrent}
                    style={[
                      locStyles.stationChip,
                      isCurrent && { borderColor: station.color, backgroundColor: station.color + "15" },
                    ]}
                  >
                    <View style={[locStyles.stationDot, { backgroundColor: station.color }]} />
                    <Text style={[locStyles.stationLabel, isCurrent && { color: station.color, fontFamily: "Inter_700Bold" }]}>
                      {station.label}
                    </Text>
                    {isCurrent && <Ionicons name="checkmark" size={14} color={station.color} />}
                  </Pressable>
                );
              })}
            </View>
            <Pressable onPress={() => setLocateCaseId(null)} style={locStyles.cancelBtn}>
              <Text style={locStyles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {invoiceCase && (
        <InvoicePDFViewer
          visible={!!invoiceCase}
          onClose={() => setInvoiceCase(null)}
          invoice={getCaseInvoice(invoiceCase)}
          editable={isAdmin}
          companyLogo={companyLogo}
          doctorPricing={(() => {
            const stripDr = (n: string) => n.trim().toLowerCase().replace(/^dr\.?\s*/i, "");
            const drName = stripDr(invoiceCase.doctorName || "");
            const matchedClient = clients.find(c =>
              stripDr(c.leadDoctor) === drName ||
              (c.additionalProviders || []).some(p => stripDr(p) === drName)
            );
            return matchedClient?.customPricing || undefined;
          })()}
          onSave={(updatedInv) => {
            if (invoiceCase.invoiceId) {
              updateInvoice(invoiceCase.invoiceId, {
                lineItems: updatedInv.lineItems,
                amount: updatedInv.amount,
                credits: updatedInv.credits,
                billTo: updatedInv.billTo,
                caseNotes: updatedInv.caseNotes,
              });
            } else {
              const { id: _id, ...invWithoutId } = updatedInv;
              const createdId = addInvoice(invWithoutId);
              updateCase(invoiceCase.id, { invoiceId: createdId } as any);
            }
            const newTotal = updatedInv.lineItems.reduce((s, li) => s + li.amount, 0) - (updatedInv.credits || 0);
            const caseUpdates: Record<string, any> = { price: newTotal };
            if (updatedInv.caseNotes !== undefined) caseUpdates.notes = updatedInv.caseNotes;
            if (updatedInv.billTo && updatedInv.billTo !== invoiceCase.doctorName) caseUpdates.doctorName = updatedInv.billTo;
            updateCase(invoiceCase.id, caseUpdates);
            addCaseNote(invoiceCase.id, `Invoice updated — new total: $${newTotal.toFixed(2)}`, userInitials);
          }}
        />
      )}
    </View>
  );
}

const locStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 380,
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 8,
  },
  prompt: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    marginBottom: 12,
    marginTop: 8,
  },
  stationGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  stationChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.surfaceSecondary,
  },
  stationDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stationLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  cancelBtn: {
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Colors.light.surfaceSecondary,
  },
  cancelText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
});

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
  filterCountText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
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
