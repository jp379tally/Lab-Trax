import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  FlatList,
  Pressable,
  Platform,
  ActivityIndicator,
  TextInput,
  Alert,
  Modal,
  Dimensions,
  Linking,
  RefreshControl,
  PanResponder,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as LocalAuthentication from "expo-local-authentication";
import { router, useFocusEffect } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { useApp } from "@/lib/app-context";
import { ChatButton } from "@/components/ChatButton";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useDrawer } from "@/lib/drawer-context";
import Colors from "@/constants/colors";
import { CameraView, useCameraPermissions } from "expo-camera";
import { getStationInfo, STATIONS, Client, LabUser, Invoice, InvoiceLineItem, DEFAULT_TIER_ITEMS, InventoryItem, CaseStatus, formatAcctNum, formatInvNum, formatPhone, cleanDoctorDisplay, LabCase, ProviderContact } from "@/lib/data";
import { LabFileDropZone } from "@/components/LabFileDropZone";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { apiRequest, getApiUrl, getAccessToken } from "@/lib/query-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useColumnWidths } from "@/hooks/useColumnWidths";

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

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

const DRAWER_WIDTH = Dimensions.get("window").width * 0.78;

function SideDrawer({
  visible,
  onClose,
  onAdmin,
  onProfile,
  onSignOut,
  onShipping,
  showAdmin = true,
}: {
  visible: boolean;
  onClose: () => void;
  onAdmin: () => void;
  onProfile: () => void;
  onSignOut: () => void;
  onShipping: () => void;
  showAdmin?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const translateX = useSharedValue(-DRAWER_WIDTH);
  const overlayOpacity = useSharedValue(0);
  const [modalVisible, setModalVisible] = useState(false);

  const openDrawer = useCallback(() => {
    setModalVisible(true);
    translateX.value = -DRAWER_WIDTH;
    overlayOpacity.value = 0;
    requestAnimationFrame(() => {
      translateX.value = withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) });
      overlayOpacity.value = withTiming(1, { duration: 280 });
    });
  }, []);

  const closeDrawer = useCallback(() => {
    translateX.value = withTiming(-DRAWER_WIDTH, { duration: 240, easing: Easing.in(Easing.cubic) });
    overlayOpacity.value = withTiming(0, { duration: 240 }, () => {
      runOnJS(setModalVisible)(false);
      runOnJS(onClose)();
    });
  }, [onClose]);

  React.useEffect(() => {
    if (visible) {
      openDrawer();
    } else if (modalVisible) {
      closeDrawer();
    }
  }, [visible]);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const allMenuItems = [
    ...(showAdmin ? [{ key: "admin", icon: "shield-checkmark" as const, label: "Admin", color: Colors.light.tint, bg: Colors.light.tintLight, onPress: onAdmin }] : []),
    { key: "shipping", icon: "airplane" as const, label: "Shipping Label", color: "#6366F1", bg: "#E0E7FF", onPress: onShipping },
    { key: "settings", icon: "settings" as const, label: "Settings", color: "#8B5CF6", bg: "#EDE9FE", onPress: () => { closeDrawer(); setTimeout(() => router.push("/settings"), 300); } },
    { key: "profile", icon: "person" as const, label: "Profile", color: Colors.light.accent, bg: Colors.light.accentLight, onPress: () => { closeDrawer(); setTimeout(() => onProfile(), 300); } },
  ];
  const menuItems = allMenuItems;

  if (!modalVisible) return null;

  return (
    <Modal transparent visible={modalVisible} animationType="none" statusBarTranslucent>
      <View style={drawerStyles.wrapper}>
        <Animated.View style={[drawerStyles.overlay, overlayStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeDrawer} />
        </Animated.View>

        <Animated.View style={[drawerStyles.drawer, drawerStyle]}>
          <LinearGradient
            colors={["#0F172A", "#1E293B"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={[drawerStyles.drawerInner, { paddingTop: Platform.OS === "web" ? 67 + 24 : insets.top + 24 }]}
          >
            <View style={drawerStyles.brandRow}>
              <LinearGradient
                colors={[Colors.light.tint, "#3B82F6"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={drawerStyles.brandIcon}
              >
                <Ionicons name="flask" size={22} color="#FFF" />
              </LinearGradient>
              <View>
                <Text style={drawerStyles.brandName}>LabTrax</Text>
                <Text style={drawerStyles.brandSub}>Lab Management</Text>
              </View>
            </View>

            <View style={drawerStyles.divider} />

            <View style={drawerStyles.menuList}>
              {menuItems.map((item) => (
                <Pressable
                  key={item.key}
                  onPress={item.onPress}
                  style={({ pressed }) => [drawerStyles.menuItem, pressed && { opacity: 0.7, backgroundColor: "rgba(255,255,255,0.05)" }]}
                  testID={`drawer-${item.key}`}
                >
                  <View style={[drawerStyles.menuIcon, { backgroundColor: item.bg }]}>
                    <Ionicons name={item.icon} size={20} color={item.color} />
                  </View>
                  <Text style={drawerStyles.menuLabel}>{item.label}</Text>
                  <Feather name="chevron-right" size={16} color="rgba(255,255,255,0.25)" />
                </Pressable>
              ))}
            </View>

            <View style={{ flex: 1 }} />

            <View style={drawerStyles.divider} />

            <Pressable
              onPress={onSignOut}
              style={({ pressed }) => [drawerStyles.signOutBtn, pressed && { opacity: 0.7 }]}
              testID="drawer-signout"
            >
              <Ionicons name="log-out-outline" size={20} color="#EF4444" />
              <Text style={drawerStyles.signOutText}>Sign Out</Text>
            </Pressable>

            <View style={{ height: Platform.OS === "web" ? 34 : insets.bottom + 12 }} />
          </LinearGradient>
        </Animated.View>
      </View>
    </Modal>
  );
}

const drawerStyles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  drawer: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    shadowColor: "#000",
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 20,
  },
  drawerInner: {
    flex: 1,
    paddingHorizontal: 20,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 24,
  },
  brandIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  brandName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  brandSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.4)",
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginBottom: 16,
  },
  menuList: {
    gap: 4,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 14,
    gap: 14,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  menuLabel: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 14,
    marginBottom: 8,
  },
  signOutText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#EF4444",
  },
});

function TechDashboard({ onReopenMasterHub }: { onReopenMasterHub?: () => void } = {}) {
  const { cases, activeCaseCount, rushCaseCount, setRole, shippingAccounts, addTrackingNumber, role, batchLocateCases, findCaseByBarcode, updateCaseStatus, groupJoinRequests, respondToGroupJoinRequest, customStationLabels, userIsAffiliated, invoices, refreshCases, hardRefresh, clients, addCasePhoto } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const { logout, profilePicUri, setProfilePicUri, currentUser, registeredUsers } = useAuth();
  const { colors: themeColors, isDark: isDarkMode } = useTheme();
  const { openDrawer } = useDrawer();
  const insets = useSafeAreaInsets();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [picModalVisible, setPicModalVisible] = useState(false);
  const [pendingPicAction, setPendingPicAction] = useState<"take" | "pick" | null>(null);
  const [shippingModalVisible, setShippingModalVisible] = useState(false);
  const [shippingCaseId, setShippingCaseId] = useState("");
  const [shippingAddress, setShippingAddress] = useState("");
  const [activeFilter, setActiveFilter] = useState<"intake" | "progress" | "shipped" | null>(null);
  const [batchLocateOpen, setBatchLocateOpen] = useState(false);
  const [batchScannedCases, setBatchScannedCases] = useState<{id: string, caseNumber: string, patientName: string}[]>([]);
  const [batchScanning, setBatchScanning] = useState(true);
  const [batchLocationSelect, setBatchLocationSelect] = useState(false);
  const [batchManualInput, setBatchManualInput] = useState("");
  const [confirmJoinReq, setConfirmJoinReq] = useState<{ requestId: string; username: string; accept: boolean } | null>(null);
  const [isProcessingJoinReq, setIsProcessingJoinReq] = useState(false);
  const lastBatchScanRef = useRef<string>("");
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const dashboardFocused = useIsFocused();

  const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
  const currentUserInitials = deriveDisplayInitials({
    firstName: currentUserData?.firstName,
    lastName: currentUserData?.lastName,
    label: currentUserData?.username || currentUser,
  });
  const isLabAdmin = currentUserData?.role === "admin";
  const pendingJoinRequests = groupJoinRequests.filter(
    r => r.targetAdminUsername.toLowerCase() === (currentUser || "").toLowerCase() && r.status === "pending"
  );
  const recentCases = [...cases]
    .filter((c) => c.status !== "COMPLETE")
    .sort(
      (a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
    )
    .slice(0, 5);

  const intakeCases = cases.filter((c) => c.status === "INTAKE");
  const inProgressCases = cases.filter(
    (c) => c.status !== "INTAKE" && c.status !== "SHIP" && c.status !== "COMPLETE",
  );
  const shippedCases = cases.filter(
    (c) => c.status === "SHIP" || c.status === "COMPLETE",
  );

  function handleAdminFromDrawer() {
    setDrawerOpen(false);
    setTimeout(() => setRole("admin"), 300);
  }

  function handleProfileFromDrawer() {
    setDrawerOpen(false);
    setTimeout(() => router.push("/(tabs)/profile"), 300);
  }

  function handleShippingFromDrawer() {
    setDrawerOpen(false);
    setTimeout(() => setShippingModalVisible(true), 300);
  }

  const batchScannedIdsRef = useRef<Set<string>>(new Set());
  const batchCameraLayoutRef = useRef({ width: 0, height: 0 });
  const SCAN_GUIDE_W = 260;
  const SCAN_GUIDE_H = 160;

  function handleBatchBarcodeScan(result: { data: string; cornerPoints?: any; bounds?: any }) {
    const data = result.data;
    if (data === lastBatchScanRef.current) return;

    const camW = batchCameraLayoutRef.current.width;
    const camH = batchCameraLayoutRef.current.height;
    if (Platform.OS !== "web" && result.bounds && camW > 0 && camH > 0) {
      const bx = result.bounds.origin?.x ?? 0;
      const by = result.bounds.origin?.y ?? 0;
      const bw = result.bounds.size?.width ?? 0;
      const bh = result.bounds.size?.height ?? 0;
      const centerX = bx + bw / 2;
      const centerY = by + bh / 2;
      const guideLeft = (camW - SCAN_GUIDE_W) / 2;
      const guideTop = (camH - SCAN_GUIDE_H) / 2;
      const guideRight = guideLeft + SCAN_GUIDE_W;
      const guideBottom = guideTop + SCAN_GUIDE_H;
      const pad = 30;
      if (
        centerX < guideLeft - pad || centerX > guideRight + pad ||
        centerY < guideTop - pad || centerY > guideBottom + pad
      ) {
        return;
      }
    }

    lastBatchScanRef.current = data;
    setTimeout(() => { lastBatchScanRef.current = ""; }, 3000);

    const found = findCaseByBarcode(data) || cases.find(c => c.id === data || c.caseNumber === data);
    if (found && !batchScannedIdsRef.current.has(found.id)) {
      batchScannedIdsRef.current.add(found.id);
      setBatchScannedCases(prev => [...prev, { id: found.id, caseNumber: found.caseNumber, patientName: found.patientName }]);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }

  function handleBatchLocationSelect(station: CaseStatus) {
    batchLocateCases(batchScannedCases.map(c => c.id), station);
    setBatchLocateOpen(false);
    setBatchScannedCases([]);
    setBatchScanning(true);
    setBatchLocationSelect(false);
    batchScannedIdsRef.current.clear();
    Alert.alert("Cases Located", `${batchScannedCases.length} case(s) moved to ${getStationInfo(station, customStationLabels).label}.`);
  }

  function handleSignOut() {
    setDrawerOpen(false);
    setTimeout(() => logout(), 300);
  }

  useEffect(() => {
    if (pendingPicAction && !picModalVisible) {
      const timer = setTimeout(async () => {
        if (pendingPicAction === "take") {
          await launchProfileCamera();
        } else if (pendingPicAction === "pick") {
          await launchProfileGallery();
        }
        setPendingPicAction(null);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [pendingPicAction, picModalVisible]);

  async function launchProfileCamera() {
    if (Platform.OS === "web") {
      try {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "user";
        input.onchange = (e: any) => {
          const file = e.target?.files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (typeof reader.result === "string") {
                setProfilePicUri(reader.result);
              }
            };
            reader.readAsDataURL(file);
          }
        };
        input.click();
      } catch (e) {
        Alert.alert("Camera Error", "Unable to open camera. Please try again.");
      }
      return;
    }

    const permCheck = await ImagePicker.getCameraPermissionsAsync();
    if (!permCheck.granted) {
      Alert.alert(
        "Camera Access",
        "This feature uses your camera to capture dental case photos.",
        [{
          text: "Continue",
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Camera Permission", "Camera access is needed to take a profile photo.");
              return;
            }
            try {
              const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
              if (!r.canceled && r.assets[0]) { setProfilePicUri(r.assets[0].uri); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
            } catch { Alert.alert("Camera Error", "Unable to open camera. Please try again."); }
          },
        }]
      );
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setProfilePicUri(result.assets[0].uri);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e) {
      Alert.alert("Camera Error", "Unable to open camera. Please try again.");
    }
  }

  async function launchProfileGallery() {
    if (Platform.OS === "web") {
      try {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = (e: any) => {
          const file = e.target?.files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (typeof reader.result === "string") {
                setProfilePicUri(reader.result);
              }
            };
            reader.readAsDataURL(file);
          }
        };
        input.click();
      } catch (e) {
        Alert.alert("Gallery Error", "Unable to open photo library. Please try again.");
      }
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Gallery Permission", "Photo library access is needed to select a profile photo.");
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setProfilePicUri(result.assets[0].uri);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e) {
      Alert.alert("Gallery Error", "Unable to open photo library. Please try again.");
    }
  }

  function handleTakeProfilePhoto() {
    setPicModalVisible(false);
    setPendingPicAction("take");
  }

  function handlePickProfilePhoto() {
    setPicModalVisible(false);
    setPendingPicAction("pick");
  }

  return (
    <>
    <View style={[styles.container, { backgroundColor: themeColors.backgroundSolid }]}>
      <View style={[styles.topBar, { position: "absolute", top: Platform.OS === "web" ? 67 : insets.top, left: 0, right: 0, zIndex: 100, backgroundColor: "transparent" }]}>
        <Pressable
          onPress={() => openDrawer()}
          style={({ pressed }) => [styles.hamburgerBtn, pressed && { opacity: 0.6 }]}
          testID="hamburger-menu"
        >
          <Ionicons name="menu" size={26} color={themeColors.text} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {Platform.OS === "web" && (
            <Pressable
              onPress={async () => {
                setRefreshing(true);
                await hardRefresh();
                setRefreshing(false);
              }}
              style={({ pressed }) => [{ padding: 6, borderRadius: 8, backgroundColor: pressed ? "rgba(0,0,0,0.05)" : "transparent" }]}
            >
              {refreshing ? (
                <ActivityIndicator size={18} color={themeColors.text} />
              ) : (
                <Ionicons name="refresh" size={22} color={themeColors.text} />
              )}
            </Pressable>
          )}
          <ChatButton />
        </View>
      </View>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 56,
        paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        Platform.OS !== "web" ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await hardRefresh();
              setRefreshing(false);
            }}
          />
        ) : undefined
      }
    >
      <View style={styles.avatarSection}>
        <Pressable
          onPress={() => {
            setPicModalVisible(true);
            if (Platform.OS !== "web") {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
          }}
          testID="profile-pic-btn"
        >
          <LinearGradient
            colors={[Colors.light.tint, "#3B82F6"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.avatarRing}
          >
            {profilePicUri ? (
              <Image
                source={{ uri: profilePicUri }}
                style={styles.avatarImage}
                contentFit="cover"
              />
            ) : (
              <View style={styles.avatarInner}>
                <Ionicons name="person" size={32} color={Colors.light.tint} />
              </View>
            )}
          </LinearGradient>
          <View style={styles.avatarEditBadge}>
            <Ionicons name="camera" size={12} color="#FFF" />
          </View>
        </Pressable>
        {currentUser && (
          <Text style={[styles.employeeName, { color: themeColors.text }]}>{currentUser.split(" ")[0] || currentUser}</Text>
        )}
        <Text style={[styles.avatarName, { color: themeColors.textSecondary }]}>{(currentUserData?.role === "admin" || role === "admin") ? "Administrator" : "User"}</Text>
        {currentUserData?.practiceName ? (
          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 13, color: Colors.light.tint, marginTop: 2 }}>{currentUserData.practiceName}</Text>
        ) : null}
        <View style={styles.statusDot}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>Available</Text>
        </View>

        {!userIsAffiliated && (
          <View style={{ marginTop: 16, padding: 14, backgroundColor: isDarkMode ? "#1E293B" : "#FFF7ED", borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: isDarkMode ? "#334155" : "#FDE68A" }}>
            <Ionicons name="information-circle-outline" size={22} color={isDarkMode ? "#FBBF24" : "#D97706"} />
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, color: isDarkMode ? "#E2E8F0" : "#92400E", flex: 1, lineHeight: 18 }}>
              Join a lab to collaborate with your team and access shared features.
            </Text>
          </View>
        )}
        <View style={styles.headerQuickActions}>
          <Pressable
            style={({ pressed }) => [
              styles.headerQuickBtn,
              pressed && styles.quickBtnPressed,
            ]}
            onPress={() => router.push({ pathname: "/(tabs)/scan", params: { mode: "camera", n: String(Date.now()) } })}
          >
            <View style={[styles.quickIcon, { backgroundColor: Colors.light.tintLight }]}>
              <Ionicons name="add" size={24} color={Colors.light.tint} />
            </View>
            <Text style={styles.quickLabel}>New Case</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.headerQuickBtn,
              pressed && styles.quickBtnPressed,
            ]}
            onPress={async () => {
              if (Platform.OS === "web") {
                setBatchLocateOpen(true);
                return;
              }
              if (!camPermission?.granted) {
                Alert.alert(
                  "Camera Access",
                  "This feature uses your camera to scan barcodes for batch case location.",
                  [{
                    text: "Continue",
                    onPress: async () => {
                      const result = await requestCamPermission();
                      if (result.granted) {
                        setBatchLocateOpen(true);
                      }
                    },
                  }]
                );
                return;
              }
              setBatchLocateOpen(true);
            }}
          >
            <View style={[styles.quickIcon, { backgroundColor: "#FEF3C7" }]}>
              <MaterialCommunityIcons name="barcode-scan" size={22} color="#D97706" />
            </View>
            <Text style={[styles.quickLabel, { color: themeColors.text }]}>Batch Locate</Text>
          </Pressable>
        </View>
      </View>

      <Modal
        transparent
        visible={picModalVisible}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setPicModalVisible(false)}
      >
        <Pressable
          style={styles.picModalOverlay}
          onPress={() => setPicModalVisible(false)}
        >
          <View style={styles.picModalContent}>
            <View style={styles.picModalHandle} />
            <Text style={styles.picModalTitle}>Profile Photo</Text>

            <Pressable
              onPress={handleTakeProfilePhoto}
              style={({ pressed }) => [styles.picModalOption, pressed && { backgroundColor: "#F1F5F9" }]}
              testID="take-photo-btn"
            >
              <View style={[styles.picModalOptionIcon, { backgroundColor: "#EFF6FF" }]}>
                <Ionicons name="camera" size={22} color={Colors.light.tint} />
              </View>
              <Text style={styles.picModalOptionText}>Take Photo</Text>
              <Feather name="chevron-right" size={18} color="#94A3B8" />
            </Pressable>

            <Pressable
              onPress={handlePickProfilePhoto}
              style={({ pressed }) => [styles.picModalOption, pressed && { backgroundColor: "#F1F5F9" }]}
              testID="photo-library-btn"
            >
              <View style={[styles.picModalOptionIcon, { backgroundColor: "#F0FDF4" }]}>
                <Ionicons name="images" size={22} color="#22C55E" />
              </View>
              <Text style={styles.picModalOptionText}>Photo Library</Text>
              <Feather name="chevron-right" size={18} color="#94A3B8" />
            </Pressable>

            {profilePicUri && (
              <Pressable
                onPress={() => {
                  setProfilePicUri(null);
                  setPicModalVisible(false);
                }}
                style={({ pressed }) => [styles.picModalOption, pressed && { backgroundColor: "#FEF2F2" }]}
                testID="remove-photo-btn"
              >
                <View style={[styles.picModalOptionIcon, { backgroundColor: "#FEF2F2" }]}>
                  <Ionicons name="trash" size={22} color="#EF4444" />
                </View>
                <Text style={[styles.picModalOptionText, { color: "#EF4444" }]}>Remove Photo</Text>
                <Feather name="chevron-right" size={18} color="#94A3B8" />
              </Pressable>
            )}

            <Pressable
              onPress={() => setPicModalVisible(false)}
              style={styles.picModalCancel}
              testID="cancel-photo-btn"
            >
              <Text style={styles.picModalCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.greeting, { color: themeColors.textSecondary }]}>Lab Floor</Text>
          <Text style={[styles.headerTitle, { color: themeColors.text }]}>Production Dashboard</Text>
        </View>
        {onReopenMasterHub ? (
          <Pressable
            onPress={onReopenMasterHub}
            style={({ pressed }) => [{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 999,
              backgroundColor: pressed ? "#0f3460" : "#16213e",
            }]}
            accessibilityLabel="Open Master Hub"
          >
            <Ionicons name="shield-checkmark" size={16} color="#FFF" />
            <Text style={{ color: "#FFF", fontSize: 13, fontWeight: "600" }}>Master Hub</Text>
          </Pressable>
        ) : null}
      </View>

      <LabFileDropZone
        cases={cases}
        clients={clients}
        currentUser={currentUser}
        onAddToCase={(caseId, fileUri) => addCasePhoto(caseId, fileUri, currentUserInitials)}
        isAdmin={isLabAdmin}
        isFocused={dashboardFocused}
      />

      {isLabAdmin && pendingJoinRequests.length > 0 && (
        <View style={invStyles.joinRequestSection}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: themeColors.text }]}>Connection Requests</Text>
            <View style={[styles.dueTodayBadge, { backgroundColor: "#EF4444" }]}>
              <Text style={styles.dueTodayBadgeText}>{pendingJoinRequests.length}</Text>
            </View>
          </View>
          {pendingJoinRequests.map((req) => {
            const reqUser = registeredUsers.find(u => u.username.toLowerCase() === req.requestingUsername.toLowerCase());
            const isProvider = reqUser?.userType === "provider";
            const displayName = reqUser?.doctorName ? `Dr. ${reqUser.doctorName}` : req.requestingUsername;
            const practiceName = reqUser?.practiceName;
            return (
              <View key={req.id} style={invStyles.joinReqCard}>
                <View style={[invStyles.joinReqIconWrap, { backgroundColor: isProvider ? "#DBEAFE" : "#FEF3C7" }]}>
                  <Ionicons name={isProvider ? "medical" : "person-add"} size={22} color={isProvider ? "#2563EB" : "#D97706"} />
                </View>
                <View style={invStyles.joinReqContent}>
                  <Text style={invStyles.joinReqTitle}>{isProvider ? "Provider Connection Request" : "Join Request"}</Text>
                  <Text style={invStyles.joinReqName}>{displayName}</Text>
                  {practiceName ? <Text style={invStyles.joinReqPractice}>{practiceName}</Text> : null}
                  <Text style={invStyles.joinReqMsg}>{req.message}</Text>
                  <View style={invStyles.joinReqBtns}>
                    <Pressable
                      style={({ pressed }) => [invStyles.joinReqAcceptBtn, pressed && { opacity: 0.8 }]}
                      onPress={() => setConfirmJoinReq({ requestId: req.id, username: displayName, accept: true })}
                    >
                      <Ionicons name="checkmark" size={16} color="#FFF" />
                      <Text style={invStyles.joinReqAcceptText}>Accept</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [invStyles.joinReqDeclineBtn, pressed && { opacity: 0.8 }]}
                      onPress={() => setConfirmJoinReq({ requestId: req.id, username: displayName, accept: false })}
                    >
                      <Ionicons name="close" size={16} color="#EF4444" />
                      <Text style={invStyles.joinReqDeclineText}>Decline</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {activeFilter !== null && (
        <View style={styles.filterSection}>
          <View style={styles.filterHeader}>
            <Text style={styles.filterTitle}>
              {activeFilter === "intake" ? "Intake Cases" : activeFilter === "progress" ? "In Progress Cases" : "Completed Cases"}
            </Text>
            <Pressable onPress={() => setActiveFilter(null)}>
              <Ionicons name="close-circle" size={22} color={Colors.light.textTertiary} />
            </Pressable>
          </View>
          {(activeFilter === "intake" ? intakeCases : activeFilter === "progress" ? inProgressCases : shippedCases).length === 0 ? (
            <View style={styles.filterEmpty}>
              <Ionicons name="file-tray-outline" size={28} color={Colors.light.textTertiary} />
              <Text style={styles.filterEmptyText}>
                No {activeFilter === "intake" ? "intake" : activeFilter === "progress" ? "in progress" : "completed"} cases
              </Text>
            </View>
          ) : (
            <View style={styles.caseList}>
              {(activeFilter === "intake" ? intakeCases : activeFilter === "progress" ? inProgressCases : shippedCases).map((c) => {
                const si = getStationInfo(c.status, customStationLabels);
                return (
                  <Pressable
                    key={c.id}
                    style={({ pressed }) => [styles.caseCard, pressed && { opacity: 0.7 }]}
                    onPress={() => router.push({ pathname: "/case/[id]", params: { id: c.id } })}
                  >
                    <View style={styles.caseCardTop}>
                      <View style={styles.caseInfo}>
                        <Text style={styles.casePatient}>{c.patientName || c.patientInitials}</Text>
                        <Text style={styles.caseDoctor}>{c.doctorName}</Text>
                        {c.isRush && (
                          <View style={styles.rushBadge}>
                            <Ionicons name="flash" size={10} color="#EF4444" />
                            <Text style={styles.rushText}>RUSH</Text>
                          </View>
                        )}
                      </View>
                      <View style={[styles.statusBadge, { backgroundColor: si.color + "18" }]}>
                        <Text style={[styles.statusText, { color: si.color }]}>{si.label.toUpperCase()}</Text>
                      </View>
                    </View>
                    <View style={styles.caseCardBottom}>
                      <Text style={styles.caseMeta}>
                        {c.toothIndices} · {c.shade} · {c.material}
                      </Text>
                      {activeFilter === "shipped" && (c.trackingNumbers?.length ?? 0) > 0 ? (
                        <View style={styles.trackingRow}>
                          <Ionicons name="navigate" size={12} color="#6366F1" />
                          <Text style={styles.trackingText} numberOfLines={1}>
                            {c.trackingNumbers!.join(", ")}
                          </Text>
                        </View>
                      ) : (
                        <Feather name="chevron-right" size={16} color={Colors.light.textTertiary} />
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      )}

      {(() => {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const dueTodayCases = cases.filter(
          (c) => c.dueDate === todayStr && c.status !== "COMPLETE" && c.status !== "SHIP",
        );
        return (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: themeColors.text }]}>Due Today</Text>
              <View style={styles.dueTodayBadge}>
                <Text style={styles.dueTodayBadgeText}>{dueTodayCases.length}</Text>
              </View>
            </View>
            {dueTodayCases.length === 0 ? (
              <View style={styles.dueTodayEmpty}>
                <Ionicons name="checkmark-circle-outline" size={28} color={Colors.light.success} />
                <Text style={styles.dueTodayEmptyText}>No cases due today</Text>
              </View>
            ) : (
              <View style={styles.caseList}>
                {dueTodayCases.map((c) => {
                  const stationInfo = getStationInfo(c.status, customStationLabels);
                  return (
                    <Pressable
                      key={c.id}
                      style={({ pressed }) => [styles.caseCard, styles.dueTodayCard, pressed && { opacity: 0.7 }]}
                      onPress={() => router.push({ pathname: "/case/[id]", params: { id: c.id } })}
                    >
                      <View style={styles.caseCardTop}>
                        <View style={styles.caseInfo}>
                          <Text style={styles.casePatient}>{c.patientName || c.patientInitials}</Text>
                          <Text style={styles.caseDoctor}>{c.doctorName}</Text>
                          {c.isRush && (
                            <View style={styles.rushBadge}>
                              <Ionicons name="flash" size={10} color="#EF4444" />
                              <Text style={styles.rushText}>RUSH</Text>
                            </View>
                          )}
                        </View>
                        <View style={[styles.statusBadge, { backgroundColor: stationInfo.color + "18" }]}>
                          <Text style={[styles.statusText, { color: stationInfo.color }]}>
                            {stationInfo.label.toUpperCase()}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.caseCardBottom}>
                        <Text style={styles.caseMeta}>
                          {c.toothIndices} · {c.shade} · {c.material}
                        </Text>
                        <Feather name="chevron-right" size={16} color={Colors.light.textTertiary} />
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </>
        );
      })()}

      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: themeColors.text }]}>Recent Cases</Text>
        <Pressable onPress={() => router.push("/(tabs)/cases")}>
          <Text style={styles.seeAll}>See all</Text>
        </Pressable>
      </View>

      <View style={styles.caseList}>
        {recentCases.map((c) => {
          const stationInfo = getStationInfo(c.status, customStationLabels);
          const ownerUser = registeredUsers.find(u => u.id === c.ownerId);
          const userInit = ownerUser?.initials
            || (ownerUser?.username ? ownerUser.username.slice(0, 2).toUpperCase() : null)
            || (currentUser ? currentUser.slice(0, 2).toUpperCase() : "??");
          const caseInvoice = invoices.find(inv => inv.caseIds.includes(c.id));
          return (
            <Pressable
              key={c.id}
              style={({ pressed }) => [
                styles.caseCard,
                { backgroundColor: themeColors.surface, borderColor: themeColors.border },
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
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={[styles.casePatient, { color: themeColors.text }]}>{c.patientName || c.patientInitials}</Text>
                    <View style={styles.userInitialsBadge}>
                      <Text style={styles.userInitialsText}>{userInit}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 1 }}>
                    {c.caseNumber ? <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.tint }}>Pan {c.caseNumber}</Text> : null}
                    {caseInvoice ? <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>{formatInvNum(caseInvoice.invoiceNumber)}</Text> : null}
                  </View>
                  <Text style={[styles.caseDoctor, { color: themeColors.textSecondary }]}>{c.doctorName}</Text>
                  {c.isRush && (
                    <View style={styles.rushBadge}>
                      <Ionicons name="flash" size={10} color="#EF4444" />
                      <Text style={styles.rushText}>RUSH</Text>
                    </View>
                  )}
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

      <Pressable
        onPress={() => router.push("/chat")}
        style={({ pressed }) => [invStyles.aiChatCard, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
      >
        <View style={invStyles.aiChatIcon}>
          <Ionicons name="sparkles" size={22} color={Colors.light.tint} />
        </View>
        <View style={invStyles.aiChatInfo}>
          <Text style={invStyles.aiChatTitle}>AI Assistant</Text>
          <Text style={invStyles.aiChatSub}>Ask about cases, materials, or workflows</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={Colors.light.textTertiary} />
      </Pressable>
    </ScrollView>
    </View>

    <Modal
      transparent
      visible={batchLocateOpen}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={() => { setBatchLocateOpen(false); setBatchScannedCases([]); setBatchScanning(true); setBatchLocationSelect(false); batchScannedIdsRef.current.clear(); }}
    >
      <View style={{ flex: 1, backgroundColor: batchLocationSelect ? Colors.light.backgroundSolid : "#000" }}>
        <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: batchLocationSelect ? Colors.light.surface : "rgba(0,0,0,0.8)" }}>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: batchLocationSelect ? Colors.light.text : "#FFF" }}>
            {batchLocationSelect ? "Select Location" : "Batch Scan"}
          </Text>
          <Pressable onPress={() => { setBatchLocateOpen(false); setBatchScannedCases([]); setBatchScanning(true); setBatchLocationSelect(false); setBatchManualInput(""); lastBatchScanRef.current = ""; batchScannedIdsRef.current.clear(); }}>
            <Ionicons name="close" size={28} color={batchLocationSelect ? Colors.light.text : "#FFF"} />
          </Pressable>
        </View>

        {batchLocationSelect ? (
          <ScrollView style={{ flex: 1, padding: 20 }}>
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginBottom: 4 }}>
              Where would you like to locate these cases?
            </Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginBottom: 16 }}>
              {batchScannedCases.length} case(s) scanned
            </Text>
            {STATIONS.map(({ id: station }) => {
              const info = getStationInfo(station, customStationLabels);
              return (
                <Pressable
                  key={station}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    backgroundColor: Colors.light.surface,
                    borderRadius: 14,
                    padding: 16,
                    marginBottom: 8,
                    borderWidth: 1,
                    borderColor: Colors.light.border,
                    opacity: pressed ? 0.7 : 1,
                  })}
                  onPress={() => handleBatchLocationSelect(station)}
                >
                  <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: info.color }} />
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text, flex: 1 }}>{info.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <>
            {Platform.OS === "web" ? (
              <View style={{ flex: 1, padding: 20 }}>
                <View style={{ alignItems: "center", marginBottom: 24 }}>
                  <Ionicons name="barcode-outline" size={48} color="#FFF" />
                  <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold", textAlign: "center", marginTop: 12 }}>Enter Barcode Manually</Text>
                  <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 4 }}>Type a case barcode or case number to add it to the batch</Text>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    style={{ flex: 1, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12, color: "#FFF", fontSize: 16, fontFamily: "Inter_500Medium", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }}
                    placeholder="Enter barcode or case #..."
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    value={batchManualInput}
                    onChangeText={setBatchManualInput}
                    autoCapitalize="none"
                    onSubmitEditing={() => {
                      const val = batchManualInput.trim();
                      if (val) {
                        handleBatchBarcodeScan({ data: val });
                        setBatchManualInput("");
                      }
                    }}
                  />
                  <Pressable
                    onPress={() => {
                      const val = batchManualInput.trim();
                      if (val) {
                        handleBatchBarcodeScan({ data: val });
                        setBatchManualInput("");
                      }
                    }}
                    style={({ pressed }) => ({
                      backgroundColor: Colors.light.tint,
                      borderRadius: 10,
                      paddingHorizontal: 16,
                      justifyContent: "center",
                      alignItems: "center",
                      opacity: pressed ? 0.8 : 1,
                    })}
                  >
                    <Ionicons name="add" size={24} color="#FFF" />
                  </Pressable>
                </View>
              </View>
            ) : camPermission?.granted ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a"] }}
                onBarcodeScanned={handleBatchBarcodeScan}
                onLayout={(e) => {
                  batchCameraLayoutRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
                }}
              >
                <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                  <View style={{ width: SCAN_GUIDE_W, height: SCAN_GUIDE_H, borderWidth: 2, borderColor: "rgba(255,255,255,0.5)", borderRadius: 16, borderStyle: "dashed" }} />
                  <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 10 }}>
                    Align barcode within the box
                  </Text>
                </View>
              </CameraView>
            ) : (
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.4)" />
                <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12, textAlign: "center", paddingHorizontal: 40 }}>Camera permission is required to scan barcodes.</Text>
                <Pressable
                  onPress={async () => {
                    const result = await requestCamPermission();
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
            <View style={{ backgroundColor: "rgba(0,0,0,0.85)", paddingHorizontal: 20, paddingVertical: 16, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }}>
              <Text style={{ color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 8 }}>
                {batchScannedCases.length} case(s) scanned
              </Text>
              {batchScannedCases.map(c => (
                <View key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Ionicons name="checkmark-circle" size={16} color="#22C55E" />
                  <Text style={{ color: "#FFF", fontSize: 13, fontFamily: "Inter_400Regular" }}>{c.caseNumber} - {c.patientName}</Text>
                </View>
              ))}
              <Pressable
                style={({ pressed }) => ({
                  backgroundColor: batchScannedCases.length > 0 ? Colors.light.tint : "#555",
                  borderRadius: 12,
                  paddingVertical: 14,
                  alignItems: "center",
                  marginTop: 12,
                  opacity: pressed ? 0.8 : 1,
                })}
                onPress={() => {
                  if (batchScannedCases.length === 0) {
                    Alert.alert("No Cases", "Scan at least one barcode before finishing.");
                    return;
                  }
                  setBatchScanning(false);
                  setBatchLocationSelect(true);
                }}
                disabled={batchScannedCases.length === 0}
              >
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Finish Scanning</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>

    <SideDrawer
      visible={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      onAdmin={handleAdminFromDrawer}
      onProfile={handleProfileFromDrawer}
      onSignOut={handleSignOut}
      onShipping={handleShippingFromDrawer}
      showAdmin={isLabAdmin}
    />

    <Modal
      transparent
      visible={shippingModalVisible}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => setShippingModalVisible(false)}
    >
      <Pressable
        style={styles.picModalOverlay}
        onPress={() => setShippingModalVisible(false)}
      >
        <View style={styles.picModalContent} onStartShouldSetResponder={() => true}>
          <View style={styles.picModalHandle} />
          <Text style={styles.picModalTitle}>Generate Shipping Label</Text>

          {shippingAccounts.length > 0 ? (
            <View style={{ backgroundColor: "#E0E7FF", borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#6366F1", marginBottom: 4 }}>SHIPPING ACCOUNT</Text>
              <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{shippingAccounts[0].companyName}</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>
                ****{shippingAccounts[0].accountNumber.slice(-4)}
              </Text>
            </View>
          ) : (
            <View style={{ backgroundColor: "#FEF3C7", borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#92400E" }}>No shipping account connected. Ask admin to add one.</Text>
            </View>
          )}

          <View style={{ marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Case Number</Text>
            <TextInput
              style={{ backgroundColor: Colors.light.surfaceAlt, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text }}
              value={shippingCaseId}
              onChangeText={setShippingCaseId}
              placeholder="e.g. #4521"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>

          <View style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Shipping Address</Text>
            <TextInput
              style={{ backgroundColor: Colors.light.surfaceAlt, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, minHeight: 60, textAlignVertical: "top" as const }}
              value={shippingAddress}
              onChangeText={setShippingAddress}
              placeholder="1200 Park Ave, Suite 400, New York, NY"
              placeholderTextColor={Colors.light.textTertiary}
              multiline
            />
          </View>

          <Pressable
            onPress={() => {
              if (!shippingCaseId.trim() || !shippingAddress.trim()) {
                Alert.alert("Required", "Case number and shipping address are required.");
                return;
              }
              if (shippingAccounts.length === 0) {
                Alert.alert("No Account", "No shipping account connected. Ask admin to add one.");
                return;
              }
              const account = shippingAccounts[0];
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert(
                "Shipping Label Generated",
                `Label created for case ${shippingCaseId.trim()}\nCarrier: ${account.companyName}\nAccount: ****${account.accountNumber.slice(-4)}\nShip to: ${shippingAddress.trim()}`,
              );
              setShippingCaseId("");
              setShippingAddress("");
              setShippingModalVisible(false);
            }}
            style={({ pressed }) => ({
              backgroundColor: shippingAccounts.length > 0 ? "#6366F1" : "#94A3B8",
              borderRadius: 14,
              paddingVertical: 14,
              alignItems: "center" as const,
              marginBottom: 8,
              opacity: pressed ? 0.85 : 1,
            })}
            disabled={shippingAccounts.length === 0}
          >
            <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFF" }}>Generate Label</Text>
          </Pressable>

          <Pressable
            onPress={() => setShippingModalVisible(false)}
            style={styles.picModalCancel}
          >
            <Text style={styles.picModalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>

    <Modal transparent visible={!!confirmJoinReq} animationType="fade" onRequestClose={() => setConfirmJoinReq(null)}>
      <View style={invStyles.joinReqOverlay}>
        <View style={invStyles.joinReqConfirmCard}>
          <View style={[invStyles.joinReqConfirmIconWrap, { backgroundColor: confirmJoinReq?.accept ? "#DCFCE7" : "#FEE2E2" }]}>
            <Ionicons
              name={confirmJoinReq?.accept ? "person-add" : "close-circle"}
              size={32}
              color={confirmJoinReq?.accept ? "#16A34A" : "#EF4444"}
            />
          </View>
          <Text style={invStyles.joinReqConfirmTitle}>
            {confirmJoinReq?.accept ? "Accept Request" : "Decline Request?"}
          </Text>
          <Text style={invStyles.joinReqConfirmDesc}>
            {confirmJoinReq?.accept
              ? `Would you like ${confirmJoinReq?.username} to join as a User or Admin?`
              : `${confirmJoinReq?.username}'s request to join will be declined. They will be notified.`}
          </Text>
          {confirmJoinReq?.accept ? (
            <View style={invStyles.joinReqConfirmBtns}>
              <Pressable
                disabled={isProcessingJoinReq}
                style={({ pressed }) => [invStyles.joinReqConfirmYesBtn, (pressed || isProcessingJoinReq) && { opacity: 0.6 }]}
                onPress={async () => {
                  if (!confirmJoinReq || isProcessingJoinReq) return;
                  setIsProcessingJoinReq(true);
                  try {
                    const result = await respondToGroupJoinRequest(confirmJoinReq.requestId, true, "user");
                    if (!result.success) {
                      Alert.alert("Unable to Update", result.error || "Something went wrong.");
                      return;
                    }
                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    setConfirmJoinReq(null);
                  } finally {
                    setIsProcessingJoinReq(false);
                  }
                }}
              >
                <Text style={invStyles.joinReqConfirmYesText}>Accept as User</Text>
              </Pressable>
              <Pressable
                disabled={isProcessingJoinReq}
                style={({ pressed }) => [invStyles.joinReqConfirmYesBtn, { backgroundColor: "#7C3AED" }, (pressed || isProcessingJoinReq) && { opacity: 0.6 }]}
                onPress={async () => {
                  if (!confirmJoinReq || isProcessingJoinReq) return;
                  setIsProcessingJoinReq(true);
                  try {
                    const result = await respondToGroupJoinRequest(confirmJoinReq.requestId, true, "admin");
                    if (!result.success) {
                      Alert.alert("Unable to Update", result.error || "Something went wrong.");
                      return;
                    }
                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    setConfirmJoinReq(null);
                  } finally {
                    setIsProcessingJoinReq(false);
                  }
                }}
              >
                <Text style={invStyles.joinReqConfirmYesText}>Accept as Admin</Text>
              </Pressable>
              <Pressable
                disabled={isProcessingJoinReq}
                style={({ pressed }) => [invStyles.joinReqConfirmYesBtn, { backgroundColor: "#EF4444" }, (pressed || isProcessingJoinReq) && { opacity: 0.6 }]}
                onPress={async () => {
                  if (!confirmJoinReq || isProcessingJoinReq) return;
                  setIsProcessingJoinReq(true);
                  try {
                    const result = await respondToGroupJoinRequest(confirmJoinReq.requestId, false);
                    if (!result.success) {
                      Alert.alert("Unable to Update", result.error || "Something went wrong.");
                      return;
                    }
                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                    setConfirmJoinReq(null);
                  } finally {
                    setIsProcessingJoinReq(false);
                  }
                }}
              >
                <Text style={invStyles.joinReqConfirmYesText}>Decline</Text>
              </Pressable>
              <Pressable
                disabled={isProcessingJoinReq}
                style={({ pressed }) => [invStyles.joinReqConfirmNoBtn, pressed && { opacity: 0.85 }]}
                onPress={() => { if (!isProcessingJoinReq) setConfirmJoinReq(null); }}
              >
                <Text style={invStyles.joinReqConfirmNoText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={invStyles.joinReqConfirmBtns}>
              <Pressable
                disabled={isProcessingJoinReq}
                style={({ pressed }) => [invStyles.joinReqConfirmYesBtn, { backgroundColor: "#EF4444" }, (pressed || isProcessingJoinReq) && { opacity: 0.6 }]}
                onPress={async () => {
                  if (!confirmJoinReq || isProcessingJoinReq) return;
                  setIsProcessingJoinReq(true);
                  try {
                    const result = await respondToGroupJoinRequest(confirmJoinReq.requestId, false);
                    if (!result.success) {
                      Alert.alert("Unable to Update", result.error || "Something went wrong.");
                      return;
                    }
                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                    setConfirmJoinReq(null);
                  } finally {
                    setIsProcessingJoinReq(false);
                  }
                }}
              >
                <Text style={invStyles.joinReqConfirmYesText}>Decline</Text>
              </Pressable>
              <Pressable
                disabled={isProcessingJoinReq}
                style={({ pressed }) => [invStyles.joinReqConfirmNoBtn, pressed && { opacity: 0.85 }]}
                onPress={() => { if (!isProcessingJoinReq) setConfirmJoinReq(null); }}
              >
                <Text style={invStyles.joinReqConfirmNoText}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>

    </>
  );
}

function AdminLockScreen() {
  const { setAdminUnlocked } = useApp();
  const insets = useSafeAreaInsets();
  const [authStatus, setAuthStatus] = useState<string>("");
  const [biometricType, setBiometricType] = useState<string>("Face ID");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const mountedRef = React.useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const timer = setTimeout(() => {
      if (mountedRef.current) {
        attemptBiometricUnlock();
      }
    }, 600);
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, []);

  async function attemptBiometricUnlock() {
    try {
      if (Platform.OS === "web") {
        setAuthStatus("tap");
        return;
      }
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (hasHardware && isEnrolled) {
        setBiometricAvailable(true);
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType("Face ID");
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType("Touch ID");
        }

        if (!mountedRef.current) return;
        setAuthStatus("scanning");
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: "Authenticate to unlock Admin Vault",
          fallbackLabel: "Use passcode",
          disableDeviceFallback: false,
          cancelLabel: "Cancel",
        });

        if (!mountedRef.current) return;
        if (result.success) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setAdminUnlocked(true);
        } else {
          setAuthStatus("retry");
        }
      } else {
        setAuthStatus("tap");
      }
    } catch {
      if (mountedRef.current) {
        setAuthStatus("tap");
      }
    }
  }

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
          {authStatus === "scanning"
            ? `Verifying with ${biometricType}...`
            : authStatus === "retry"
            ? "Authentication was cancelled or failed."
            : `Accessing sensitive data requires ${biometricType} authentication.`}
        </Text>
        {(authStatus === "retry" || authStatus === "failed") && (
          <Pressable
            style={({ pressed }) => [
              styles.unlockBtn,
              pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
            ]}
            onPress={attemptBiometricUnlock}
          >
            <Ionicons
              name="scan"
              size={20}
              color="#FFF"
              style={{ marginRight: 8 }}
            />
            <Text style={styles.unlockBtnText}>Try {biometricType} Again</Text>
          </Pressable>
        )}
        {authStatus === "tap" && (
          <Pressable
            style={({ pressed }) => [
              styles.unlockBtn,
              pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
            ]}
            onPress={() => {
              if (Platform.OS !== "web" && biometricAvailable) {
                attemptBiometricUnlock();
              } else {
                setAdminUnlocked(true);
              }
            }}
          >
            <Ionicons
              name={biometricAvailable ? "scan" : "finger-print"}
              size={20}
              color="#FFF"
              style={{ marginRight: 8 }}
            />
            <Text style={styles.unlockBtnText}>
              {biometricAvailable ? `Unlock with ${biometricType}` : "Unlock Vault"}
            </Text>
          </Pressable>
        )}
        {(authStatus === "" || authStatus === "scanning") && (
          <View style={styles.scanningFaceWrap}>
            <Ionicons name="scan" size={40} color={Colors.light.tint} />
          </View>
        )}
      </View>
    </View>
  );
}

type AdminView =
  | "hub"
  | "client-hub"
  | "clients"
  | "client-detail"
  | "add-client"
  | "edit-client"
  | "edit-price-list"
  | "edit-tier-pricing"
  | "financial-hub"
  | "user-hub"
  | "add-user"
  | "edit-user"
  | "invoices"
  | "invoices-hub"
  | "invoice-detail"
  | "view-invoices"
  | "send-invoice"
  | "text-invoice"
  | "pick-invoice-to-send"
  | "sales"
  | "shipping"
  | "inventory"
  | "lab-users"
  | "payment-processing"
  | "edit-locations"
  | "integrations"
  | "client-stats"
  | "delete-cases"
  | "inactive-clients"
  | "deleted-invoices"
  | "edit-invoice"
  | "ar-aging"
  | "pl-report"
  | "sales-by-item"
  | "receive-payment"
  | "backup";

const INV_DETAIL_COL_DEFAULTS = [40, 80, 60, 70] as const;

function ColResizeHandle({ colIdx, widthRef, onWidthChange }: {
  colIdx: number;
  widthRef: React.MutableRefObject<number>;
  onWidthChange: (colIdx: number, w: number) => void;
}) {
  const startWidthRef = useRef(0);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startWidthRef.current = widthRef.current;
      },
      onPanResponderMove: (_, gs) => {
        onWidthChange(colIdx, startWidthRef.current + gs.dx);
      },
    }),
  ).current;

  return (
    <View
      {...panResponder.panHandlers}
      style={{ width: 10, alignSelf: "stretch", alignItems: "center", justifyContent: "center", zIndex: 10 }}
    >
      <View style={{ width: 3, height: 14, backgroundColor: "#bbb", borderRadius: 2 }} />
    </View>
  );
}

function AdminDashboard() {
  const { cases, clients, addClient, updateClient, addCase, users, addUser, updateUser, removeUser, invoices, updateInvoice, setRole, shippingAccounts, addShippingAccount, removeShippingAccount, pricingTiers, updateTierPricing, addPricingTier, inventory, addInventoryItem, updateInventoryItem, removeInventoryItem, addNotification, customStationLabels, updateStationLabel, removeCase, removeClient, deactivateClient, reactivateClient, deletedClientInvoices, inactiveClients, sendLabInvite, pendingInvoiceEditId, setPendingInvoiceEditId, allLabOrganizationIds } = useApp();
  const { currentUser, currentUserId, registeredUsers } = useAuth();
  const [removeConfirmVisible, setRemoveConfirmVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const [adminView, setAdminView] = useState<AdminView>("hub");

  useFocusEffect(
    React.useCallback(() => {
      if (!pendingInvoiceEditId) return;
      const inv = invoices.find(i => i.id === pendingInvoiceEditId);
      if (!inv) { setPendingInvoiceEditId(null); return; }
      setSelectedInvoice(inv);
      setEditInvLineItems(inv.lineItems.map(li => ({ ...li })));
      setEditInvPatientName(inv.patientName || "");
      setEditInvBillTo(inv.billTo || "");
      setEditInvCaseType(inv.caseType || "");
      setEditInvTeeth(inv.teeth || "");
      setEditInvShade(inv.shade || "");
      setEditInvCaseNotes(inv.caseNotes || "");
      setEditInvCreditsText(String(inv.credits || 0));
      setEditInvClientId(inv.clientId || "");
      setEditInvClientName(inv.clientName || "");
      setEditInvBillToSearch(inv.billTo || "");
      setEditInvShowProviderDrop(false);
      setEditInvNumber(inv.invoiceNumber || "");
      setEditInvIssuedAtStr(new Date(inv.issuedAt).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }));
      setEditInvDueAtStr(new Date(inv.dueAt).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }));
      setEditInvCreditNote(inv.creditNote || "");
      setAdminView("edit-invoice");
      setPendingInvoiceEditId(null);
    }, [pendingInvoiceEditId, invoices, setPendingInvoiceEditId])
  );

  const totalRevenue = cases.reduce((sum, c) => sum + c.price, 0);
  const openInvoiceCount = invoices.filter((i) => i.status === "open" || i.status === "overdue").length;

  const [newClientName, setNewClientName] = useState("");
  const [newClientDoctor, setNewClientDoctor] = useState("");
  const [newClientAdditionalProviders, setNewClientAdditionalProviders] = useState<string[]>(["", "", "", "", ""]);
  const [doctorDropdownOpen, setDoctorDropdownOpen] = useState(false);
  const [doctorSearch, setDoctorSearch] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientAddress, setNewClientAddress] = useState("");
  const [newClientTier, setNewClientTier] = useState<string>("Standard");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [editInvLineItems, setEditInvLineItems] = useState<InvoiceLineItem[]>([]);
  const [editInvPatientName, setEditInvPatientName] = useState("");
  const [editInvBillTo, setEditInvBillTo] = useState("");
  const [editInvCaseType, setEditInvCaseType] = useState("");
  const [editInvTeeth, setEditInvTeeth] = useState("");
  const [editInvShade, setEditInvShade] = useState("");
  const [editInvCaseNotes, setEditInvCaseNotes] = useState("");
  const [editInvCreditsText, setEditInvCreditsText] = useState("0");
  const [editInvClientId, setEditInvClientId] = useState("");
  const [editInvClientName, setEditInvClientName] = useState("");
  const [editInvBillToSearch, setEditInvBillToSearch] = useState("");
  const [editInvShowProviderDrop, setEditInvShowProviderDrop] = useState(false);
  const [editInvItemDropdownIdx, setEditInvItemDropdownIdx] = useState<number | null>(null);
  const [editInvNumber, setEditInvNumber] = useState("");
  const [editInvIssuedAtStr, setEditInvIssuedAtStr] = useState("");
  const [editInvDueAtStr, setEditInvDueAtStr] = useState("");
  const [editInvCreditNote, setEditInvCreditNote] = useState("");
  const [editInvCaseTypeOpen, setEditInvCaseTypeOpen] = useState(false);
  const [editInvSelectedPractice, setEditInvSelectedPractice] = useState<import("@/lib/data").Client | null>(null);
  const [editInvSubProvider, setEditInvSubProvider] = useState("");
  const [editInvSubProviderOpen, setEditInvSubProviderOpen] = useState(false);
  const [sendPhoneTo, setSendPhoneTo] = useState("");
  const [rpClientId, setRpClientId] = useState<string | null>(null);
  const [rpMethod, setRpMethod] = useState("Check");
  const [rpAmountText, setRpAmountText] = useState("");
  const [rpRef, setRpRef] = useState("");
  const [rpSelectedInvIds, setRpSelectedInvIds] = useState<string[]>([]);
  const [plPeriod, setPlPeriod] = useState<"mtd" | "qtd" | "ytd" | "custom">("ytd");
  const [plCustomStart, setPlCustomStart] = useState("");
  const [plCustomEnd, setPlCustomEnd] = useState("");

  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<"user" | "admin">("user");
  const [newUserStation, setNewUserStation] = useState("Design");
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"user" | "admin">("user");

  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [showEditClientPricing, setShowEditClientPricing] = useState(false);
  const [editingUser, setEditingUser] = useState<LabUser | null>(null);
  const [deleteCaseTarget, setDeleteCaseTarget] = useState<LabCase | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteClientModal, setShowDeleteClientModal] = useState(false);
  const [deleteClientTarget, setDeleteClientTarget] = useState<Client | null>(null);
  const [deleteClientHasOpenInvoices, setDeleteClientHasOpenInvoices] = useState(false);
  const [newShipCompany, setNewShipCompany] = useState("");
  const [newShipAccount, setNewShipAccount] = useState("");

  const [invoiceFilter, setInvoiceFilter] = useState<"open" | "pastdue" | "all">("open");
  const [expandedInvoiceProviders, setExpandedInvoiceProviders] = useState<Record<string, boolean>>({});
  const [sendEmailTo, setSendEmailTo] = useState("");
  const [sendEmailMessage, setSendEmailMessage] = useState("");
  const [sendEmailSubject, setSendEmailSubject] = useState("");
  const [sendInvoiceTarget, setSendInvoiceTarget] = useState<Invoice | null>(null);
  const [sendTextTo, setSendTextTo] = useState("");
  const [sendTextMessage, setSendTextMessage] = useState("");
  const [sendInvoiceMode, setSendInvoiceMode] = useState<"email" | "text">("email");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [clientSearchQuery, setClientSearchQuery] = useState("");
  const [clientDetailInvFilter, setClientDetailInvFilter] = useState<"open" | "all" | "mtd">("open");
  const [clientDetailInvDropdownOpen, setClientDetailInvDropdownOpen] = useState(false);
  const adminUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
  const labName = adminUserData?.practiceName || "My Lab";
  const labAddress = adminUserData?.practiceAddress || "";
  const labPhone = adminUserData?.practicePhone || adminUserData?.phone || "";

  const { widths: invColWidths, setWidth: setInvColWidth } = useColumnWidths(
    [...INV_DETAIL_COL_DEFAULTS],
    currentUserId,
  );
  const invColWidthRef0 = useRef(invColWidths[0]);
  const invColWidthRef1 = useRef(invColWidths[1]);
  const invColWidthRef2 = useRef(invColWidths[2]);
  const invColWidthRef3 = useRef(invColWidths[3]);
  invColWidthRef0.current = invColWidths[0];
  invColWidthRef1.current = invColWidths[1];
  invColWidthRef2.current = invColWidths[2];
  invColWidthRef3.current = invColWidths[3];
  const invColWidthRefs = [invColWidthRef0, invColWidthRef1, invColWidthRef2, invColWidthRef3];

  const [salesPeriod, setSalesPeriod] = useState<"daily" | "mtd" | "ytd" | "custom">("mtd");
  const [salesCustomStart, setSalesCustomStart] = useState("");
  const [salesCustomEnd, setSalesCustomEnd] = useState("");

  const PRICE_LIST_ITEMS = [
    { key: "zirconia_crown", label: "Zirconia Crown" },
    { key: "emax_crown", label: "Emax Crown" },
    { key: "pfm_crown", label: "PFM Crown" },
    { key: "pfz_crown", label: "PFZ Crown" },
    { key: "denture", label: "Denture" },
    { key: "partial", label: "Partial" },
    { key: "flipper", label: "Flipper" },
    { key: "implant", label: "Implant" },
    { key: "night_guard", label: "Night Guard" },
    { key: "temporary", label: "Temporary" },
    { key: "essix", label: "Essix" },
  ] as const;

  const [priceList, setPriceList] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    PRICE_LIST_ITEMS.forEach((item) => { initial[item.key] = ""; });
    return initial;
  });
  const [priceConfirmVisible, setPriceConfirmVisible] = useState(false);

  const [expandedTier, setExpandedTier] = useState<string | null>(null);
  const [tierPrices, setTierPrices] = useState<Record<string, Record<string, string>>>(() => {
    const initial: Record<string, Record<string, string>> = {};
    pricingTiers.forEach(t => {
      initial[t.id] = {};
      DEFAULT_TIER_ITEMS.forEach(item => {
        initial[t.id][item.key] = t.prices[item.key]?.toString() || "0";
      });
    });
    return initial;
  });
  const [showAddTier, setShowAddTier] = useState(false);
  const [newTierName, setNewTierName] = useState("");
  const [selectedPriceClient, setSelectedPriceClient] = useState<Client | null>(null);
  const [showClientPicker, setShowClientPicker] = useState(false);
  const [selectedTierForClient, setSelectedTierForClient] = useState<string>("");

  const [invCategory, setInvCategory] = useState("All");
  const [showAddInv, setShowAddInv] = useState(false);
  const [newInvName, setNewInvName] = useState("");
  const [newInvCategory, setNewInvCategory] = useState("Materials");
  const [newInvQty, setNewInvQty] = useState("");
  const [newInvMinQty, setNewInvMinQty] = useState("");
  const [newInvUnit, setNewInvUnit] = useState("pcs");
  const [editingInvItem, setEditingInvItem] = useState<InventoryItem | null>(null);
  const [editInvQty, setEditInvQty] = useState("");

  const [labUserSearchQuery, setLabUserSearchQuery] = useState("");
  const [selectedLabGroup, setSelectedLabGroup] = useState<string | null>(null);

  const [iteroEmail, setIteroEmail] = useState("");
  const [iteroPassword, setIteroPassword] = useState("");
  const [iteroConnected, setIteroConnected] = useState(false);
  const [iteroShowPassword, setIteroShowPassword] = useState(false);
  const [iteroSaving, setIteroSaving] = useState(false);
  const [iteroImporting, setIteroImporting] = useState(false);
  const [iteroImportResults, setIteroImportResults] = useState<{ doctor: string; teeth: string; shade: string; material: string; notes: string }[]>([]);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [isOneDriving, setIsOneDriving] = useState(false);
  const [oneDriveResult, setOneDriveResult] = useState<{ fileName: string; webUrl: string; size: number; folder: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const email = await SecureStore.getItemAsync("itero_email");
        const pass = await SecureStore.getItemAsync("itero_password");
        if (email && pass) {
          setIteroEmail(email);
          setIteroPassword(pass);
          setIteroConnected(true);
        }
      } catch {}
    })();
  }, []);

  const labPortalUsers = registeredUsers.filter(
    (u) => (u.userType === "lab" || !u.userType) && (u.userType as string) !== "master_admin",
  );

  function resetClientForm() {
    setNewClientName("");
    setNewClientDoctor("");
    setNewClientAdditionalProviders(["", "", "", "", ""]);
    setDoctorDropdownOpen(false);
    setDoctorSearch("");
    setNewClientPhone("");
    setNewClientEmail("");
    setNewClientAddress("");
    setNewClientTier("Standard");
  }

  function resetUserForm() {
    setNewUserName("");
    setNewUserEmail("");
    setNewUserRole("user");
    setNewUserStation("Design");
  }

  function getAdminEmail(): string {
    const adminUser = users.find((u) => u.role === "admin" && u.active);
    return adminUser?.email || "";
  }

  function handleAddClient() {
    if (!newClientName.trim() || !newClientDoctor.trim()) {
      Alert.alert("Required", "Practice name and main provider are required.");
      return;
    }
    const filteredProviders = newClientAdditionalProviders.map(p => p.trim()).filter(p => p.length > 0);
    addClient({
      practiceName: newClientName.trim(),
      leadDoctor: newClientDoctor.trim(),
      additionalProviders: filteredProviders.length > 0 ? filteredProviders : undefined,
      phone: newClientPhone.trim(),
      email: newClientEmail.trim(),
      address: newClientAddress.trim(),
      tier: newClientTier,
      discountRate: newClientTier === "Elite" ? 15 : newClientTier === "Premium" ? 10 : 0,
    });
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Client Added", `${newClientName.trim()} has been onboarded.`);
    resetClientForm();
    setAdminView("hub");
  }

  function handleAddUser() {
    if (!newUserName.trim() || !newUserEmail.trim()) {
      Alert.alert("Required", "Name and email are required.");
      return;
    }
    addUser({
      name: newUserName.trim(),
      email: newUserEmail.trim(),
      role: newUserRole,
      station: newUserStation,
      active: true,
    });
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("User Added", `${newUserName.trim()} has been created.`);
    resetUserForm();
    setAdminView("hub");
  }

  function handleSaveEditClient() {
    if (!editingClient) return;
    const originalClient = clients.find(c => c.id === editingClient.id);
    const oldName = originalClient?.practiceName || "";
    const newName = editingClient.practiceName || "";
    updateClient(editingClient.id, editingClient);
    if (showEditClientPricing) {
      const prices: Record<string, number> = {};
      PRICE_LIST_ITEMS.forEach(item => {
        prices[item.key] = parseFloat(priceList[item.key] || "0") || 0;
      });
      updateClient(editingClient.id, { customPricing: prices });
    }
    if (oldName && newName && oldName.toLowerCase().trim() !== newName.toLowerCase().trim()) {
      invoices.forEach(inv => {
        if (inv.clientName?.toLowerCase()?.trim() === oldName.toLowerCase().trim() || inv.clientId === editingClient.id) {
          updateInvoice(inv.id, { clientName: newName });
        }
      });
    }
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Saved", showEditClientPricing ? "Client record and pricing updated." : "Client record updated.");
    if (selectedClient && selectedClient.id === editingClient.id) {
      setSelectedClient(editingClient);
      setAdminView("client-detail");
    }
    setEditingClient(null);
    setShowEditClientPricing(false);
  }

  function handleSaveEditUser() {
    if (!editingUser) return;
    updateUser(editingUser.id, editingUser);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Saved", "User record updated.");
    setEditingUser(null);
  }

  function renderBackHeader(title: string, backTo: AdminView = "hub") {
    return (
      <View style={adm.subHeader}>
        <Pressable onPress={() => { setAdminView(backTo); setEditingClient(null); setEditingUser(null); setShowEditClientPricing(false); }} style={adm.backBtn}>
          <Ionicons name="chevron-back" size={24} color={Colors.light.tint} />
        </Pressable>
        <Text style={adm.subHeaderTitle}>{title}</Text>
        <View style={{ width: 44 }} />
      </View>
    );
  }

  function renderHub() {
    const totalOpenBalance = clients.reduce((sum, c) => {
      const clientInvoices = invoices.filter((inv) => (inv.clientId === c.id || (inv.clientName || "").trim().toLowerCase() === (c.practiceName || "").trim().toLowerCase()) && (inv.status === "open" || inv.status === "overdue"));
      return sum + clientInvoices.reduce((s, inv) => s + inv.amount, 0);
    }, 0);

    const menuItems: { icon: string; iconSet: "ion" | "mci" | "feather"; color: string; bg: string; title: string; sub: string; view: AdminView }[] = [
      { icon: "business", iconSet: "ion", color: "#0EA5E9", bg: "#E0F2FE", title: "Providers", sub: `${clients.length} practices · Add, Edit, Price List`, view: "client-hub" },
      { icon: "wallet", iconSet: "ion", color: "#10B981", bg: "#D1FAE5", title: "Financial", sub: "Invoices, Statements, Sales & more", view: "financial-hub" as AdminView },
      { icon: "layers", iconSet: "ion", color: "#F59E0B", bg: "#FEF3C7", title: "Edit Tier Pricing", sub: `${pricingTiers.length} pricing tiers`, view: "edit-tier-pricing" as AdminView },
      { icon: "airplane", iconSet: "ion", color: "#6366F1", bg: "#E0E7FF", title: "Shipping Accounts", sub: "Manage carrier connections", view: "shipping" as AdminView },
      { icon: "location", iconSet: "ion", color: "#0D9488", bg: "#CCFBF1", title: "Edit Locations", sub: `${STATIONS.length} workflow stations`, view: "edit-locations" as AdminView },
      { icon: "person-add", iconSet: "ion", color: "#7C3AED", bg: "#F3E8FF", title: "Lab Users", sub: `${labPortalUsers.length} lab members`, view: "lab-users" as AdminView },
      { icon: "cloud-upload", iconSet: "ion", color: "#2563EB", bg: "#DBEAFE", title: "Integrations", sub: "iTero · Scanner connections", view: "integrations" as AdminView },
      { icon: "trash", iconSet: "ion", color: "#EF4444", bg: "#FEE2E2", title: "Delete Case", sub: "Remove an active case", view: "delete-cases" as AdminView },
      { icon: "person-remove", iconSet: "ion", color: "#F59E0B", bg: "#FEF3C7", title: "Inactive Providers", sub: `${inactiveClients.length} inactive accounts`, view: "inactive-clients" as AdminView },
      { icon: "document-attach", iconSet: "ion", color: "#DC2626", bg: "#FEE2E2", title: "Deleted Client Invoices", sub: `${deletedClientInvoices.length} archived invoices`, view: "deleted-invoices" as AdminView },
      { icon: "cloud-download", iconSet: "ion", color: "#059669", bg: "#D1FAE5", title: "Backup Data", sub: "Export all data to ZIP archive", view: "backup" as AdminView },
    ];

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
            <Text style={styles.headerTitle}>Master Hub</Text>
          </View>
          <Pressable onPress={() => setRole("user")} style={adm.exitBtn}>
            <Ionicons name="close" size={20} color={Colors.light.textSecondary} />
          </Pressable>
        </View>

        <LinearGradient
          colors={["#0F172A", "#1E293B"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <Text style={[styles.heroLabel, { opacity: 0.5 }]}>OPEN INVOICES</Text>
          <Text style={styles.heroCount}>
            {formatCurrency(totalRevenue)}
          </Text>
          <View style={adm.heroBadgeRow}>
            <View style={adm.heroBadge}>
              <Text style={adm.heroBadgeText}>+12% vs LY</Text>
            </View>
            <View style={adm.heroBadge}>
              <Text style={adm.heroBadgeText}>{cases.length} Cases</Text>
            </View>
            <View style={adm.heroBadge}>
              <Text style={adm.heroBadgeText}>{clients.length} Clients</Text>
            </View>
          </View>
        </LinearGradient>

        <View style={adm.menuSection}>
          {menuItems.map((item) => (
            <Pressable
              key={item.view}
              style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => setAdminView(item.view)}
            >
              <View style={[adm.menuIcon, { backgroundColor: item.bg }]}>
                <Ionicons name={item.icon as any} size={20} color={item.color} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{item.title}</Text>
                <Text style={adm.menuSub}>{item.sub}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderClientHub() {
    const totalOpenBalance = clients.reduce((sum, c) => {
      const clientInvoices = invoices.filter((inv) => (inv.clientId === c.id || (inv.clientName || "").trim().toLowerCase() === (c.practiceName || "").trim().toLowerCase()) && (inv.status === "open" || inv.status === "overdue"));
      return sum + clientInvoices.reduce((s, inv) => s + inv.amount, 0);
    }, 0);
    const activeClientCount = clients.filter(c => c.status !== "inactive").length;
    const clientMenuItems: { icon: string; color: string; bg: string; title: string; sub: string; view: AdminView }[] = [
      { icon: "business", color: "#0EA5E9", bg: "#E0F2FE", title: "Providers", sub: `${activeClientCount} practices · ${formatCurrency(totalOpenBalance)} open`, view: "clients" },
      { icon: "person-add", color: Colors.light.tint, bg: Colors.light.tintLight, title: "Add Provider", sub: "Onboard a new provider", view: "add-client" },
    ];
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Providers")}
        <View style={adm.menuSection}>
          {clientMenuItems.map((item) => (
            <Pressable
              key={item.view}
              style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => setAdminView(item.view)}
            >
              <View style={[adm.menuIcon, { backgroundColor: item.bg }]}>
                <Ionicons name={item.icon as any} size={20} color={item.color} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{item.title}</Text>
                <Text style={adm.menuSub}>{item.sub}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderUserHub() {
    const userMenuItems: { icon: string; color: string; bg: string; title: string; sub: string; view: AdminView }[] = [
      { icon: "person-add-outline", color: Colors.light.success, bg: Colors.light.successLight, title: "Add User", sub: "Create lab staff account", view: "add-user" },
      { icon: "people-outline", color: "#8B5CF6", bg: "#EDE9FE", title: "Edit User", sub: `${users.length} lab staff members`, view: "edit-user" },
    ];
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Users")}
        <View style={adm.menuSection}>
          {userMenuItems.map((item) => (
            <Pressable
              key={item.view}
              style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => setAdminView(item.view)}
            >
              <View style={[adm.menuIcon, { backgroundColor: item.bg }]}>
                <Ionicons name={item.icon as any} size={20} color={item.color} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{item.title}</Text>
                <Text style={adm.menuSub}>{item.sub}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))}
        </View>

      </ScrollView>
    );
  }

  function renderAddClient() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Add Provider", "client-hub")}
        <View style={adm.formArea}>
          <Text style={adm.formDesc}>Onboard a new provider / dental practice.</Text>

          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Practice Name</Text>
            <TextInput style={adm.input} value={newClientName} onChangeText={setNewClientName} placeholder="Elite Dental Group" placeholderTextColor={Colors.light.textTertiary} />
          </View>
          <View style={[adm.field, { zIndex: 10 }]}>
            <Text style={adm.fieldLabel}>Main Provider</Text>
            <Pressable
              style={[adm.input, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}
              onPress={() => setDoctorDropdownOpen(!doctorDropdownOpen)}
            >
              <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: newClientDoctor ? Colors.light.text : Colors.light.textTertiary }}>
                {newClientDoctor || "Select a provider..."}
              </Text>
              <Ionicons name={doctorDropdownOpen ? "chevron-up" : "chevron-down"} size={18} color={Colors.light.textSecondary} />
            </Pressable>
            {doctorDropdownOpen && (
              <View style={{ backgroundColor: Colors.light.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.light.border, marginTop: 6, maxHeight: 220, overflow: "hidden" }}>
                <TextInput
                  style={[adm.input, { borderRadius: 0, borderWidth: 0, borderBottomWidth: 1, borderBottomColor: Colors.light.border }]}
                  value={doctorSearch}
                  onChangeText={setDoctorSearch}
                  placeholder="Search providers..."
                  placeholderTextColor={Colors.light.textTertiary}
                  autoFocus
                />
                <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {registeredUsers
                    .filter(u => u.userType === "provider")
                    .filter(u => {
                      if (!doctorSearch.trim()) return true;
                      const search = doctorSearch.toLowerCase();
                      return (u.doctorName || "").toLowerCase().includes(search) || (u.practiceAddress || "").toLowerCase().includes(search) || u.username.toLowerCase().includes(search);
                    })
                    .map(u => (
                      <Pressable
                        key={u.username}
                        onPress={() => {
                          setNewClientDoctor(u.doctorName || u.username);
                          if (u.practiceAddress && !newClientAddress) setNewClientAddress(u.practiceAddress);
                          setDoctorDropdownOpen(false);
                          setDoctorSearch("");
                        }}
                        style={({ pressed }) => ({ paddingVertical: 12, paddingHorizontal: 14, backgroundColor: pressed ? Colors.light.surfaceSecondary : "transparent", borderBottomWidth: 1, borderBottomColor: Colors.light.border })}
                      >
                        <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{u.doctorName || u.username}</Text>
                        {u.practiceAddress ? <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{u.practiceAddress}</Text> : null}
                      </Pressable>
                    ))}
                  {registeredUsers.filter(u => u.userType === "provider").filter(u => {
                    if (!doctorSearch.trim()) return true;
                    const search = doctorSearch.toLowerCase();
                    return (u.doctorName || "").toLowerCase().includes(search) || (u.practiceAddress || "").toLowerCase().includes(search) || u.username.toLowerCase().includes(search);
                  }).length === 0 && (
                    <View style={{ paddingVertical: 20, alignItems: "center" }}>
                      <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary }}>No providers found</Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            )}
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Additional Providers</Text>
            {newClientAdditionalProviders.map((prov, idx) => (
              <TextInput
                key={idx}
                style={[adm.input, { marginBottom: idx < 4 ? 8 : 0 }]}
                value={prov}
                onChangeText={(v) => {
                  const updated = [...newClientAdditionalProviders];
                  updated[idx] = v;
                  setNewClientAdditionalProviders(updated);
                }}
                placeholder={`Provider ${idx + 2}`}
                placeholderTextColor={Colors.light.textTertiary}
              />
            ))}
          </View>
          <View style={adm.fieldRow}>
            <View style={[adm.field, { flex: 1 }]}>
              <Text style={adm.fieldLabel}>Phone</Text>
              <TextInput style={adm.input} value={newClientPhone} onChangeText={(v) => setNewClientPhone(formatPhone(v))} placeholder="000-000-0000" placeholderTextColor={Colors.light.textTertiary} keyboardType="phone-pad" />
            </View>
            <View style={[adm.field, { flex: 1 }]}>
              <Text style={adm.fieldLabel}>Email</Text>
              <TextInput style={adm.input} value={newClientEmail} onChangeText={setNewClientEmail} placeholder="office@clinic.com" placeholderTextColor={Colors.light.textTertiary} keyboardType="email-address" autoCapitalize="none" />
            </View>
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Address</Text>
            <TextInput style={adm.input} value={newClientAddress} onChangeText={setNewClientAddress} placeholder="1200 Park Ave, Suite 400, New York, NY" placeholderTextColor={Colors.light.textTertiary} />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Client Tier</Text>
            <View style={adm.chipRow}>
              {pricingTiers.map((t) => (
                <Pressable key={t.id} onPress={() => setNewClientTier(t.name)} style={[adm.chip, newClientTier === t.name && adm.chipActive]}>
                  <Text style={[adm.chipText, newClientTier === t.name && adm.chipTextActive]}>{t.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <Pressable style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }]} onPress={handleAddClient}>
            <Ionicons name="checkmark" size={20} color="#FFF" />
            <Text style={adm.submitBtnText}>Create Client Record</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  function renderEditClient() {
    if (editingClient) {
      function handleUpdateClientPrice(key: string, value: string) {
        const cleaned = value.replace(/[^0-9.]/g, "");
        setPriceList((prev) => ({ ...prev, [key]: cleaned }));
      }

      function handleSelectTierInEdit(tierName: string) {
        setEditingClient({ ...editingClient, tier: tierName } as any);
        const tier = pricingTiers.find(t => t.name === tierName);
        if (tier) {
          const newPrices: Record<string, string> = {};
          PRICE_LIST_ITEMS.forEach(item => {
            newPrices[item.key] = tier.prices[item.key]?.toString() || "";
          });
          setPriceList(newPrices);
        }
      }

      function getAllPCFromEdit(ec: Client): ProviderContact[] {
        const paddedAdditional = ec.additionalProviders && ec.additionalProviders.length >= 5
          ? ec.additionalProviders
          : [...(ec.additionalProviders || []), ...Array(5 - (ec.additionalProviders?.length || 0)).fill("")];
        const allNames = [ec.leadDoctor, ...paddedAdditional];
        const existing = ec.providerContacts || [];
        return allNames.map((n, i) => ({
          name: existing[i]?.name || n || "",
          email: existing[i]?.email || "",
          phone: existing[i]?.phone || "",
          address: existing[i]?.address || "",
        }));
      }

      return (
        <ScrollView
          style={styles.container}
          contentContainerStyle={{
            paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {renderBackHeader("Edit Provider", selectedClient ? "client-detail" : "client-hub")}
          <View style={adm.formArea}>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Practice Name</Text>
              <TextInput style={adm.input} value={editingClient.practiceName} onChangeText={(v) => setEditingClient({ ...editingClient, practiceName: v })} />
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Account Number</Text>
              <TextInput style={adm.input} value={editingClient.accountNumber || ""} onChangeText={(v) => setEditingClient({ ...editingClient, accountNumber: v })} placeholder="e.g. DS-066707" placeholderTextColor={Colors.light.textTertiary} autoCapitalize="characters" />
            </View>
            <View style={adm.field}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <Text style={adm.fieldLabel}>Providers</Text>
                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Each gets their own statement</Text>
              </View>
              {[editingClient.leadDoctor, ...(editingClient.additionalProviders && editingClient.additionalProviders.length >= 5
                ? editingClient.additionalProviders
                : [...(editingClient.additionalProviders || []), ...Array(5 - (editingClient.additionalProviders?.length || 0)).fill("")])
              ].map((_, providerIdx) => {
                const isLead = providerIdx === 0;
                const paddedAdditional = editingClient.additionalProviders && editingClient.additionalProviders.length >= 5
                  ? editingClient.additionalProviders
                  : [...(editingClient.additionalProviders || []), ...Array(5 - (editingClient.additionalProviders?.length || 0)).fill("")];
                const provName = isLead ? editingClient.leadDoctor : (paddedAdditional[providerIdx - 1] || "");
                const pc = (editingClient.providerContacts || [])[providerIdx] || { name: provName };
                const isPopulated = isLead || provName.trim().length > 0;
                return (
                  <View key={providerIdx} style={{ backgroundColor: isLead ? "#F0F9FF" : "#F9FAFB", borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: isLead ? "#BAE6FD" : Colors.light.border }}>
                    <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: isLead ? "#0284C7" : Colors.light.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{isLead ? "Main Provider" : `Provider ${providerIdx + 1}`}</Text>
                    <TextInput
                      style={[adm.input, { marginBottom: isPopulated ? 8 : 0 }]}
                      value={provName}
                      onChangeText={(v) => {
                        if (isLead) {
                          const newContacts = getAllPCFromEdit(editingClient);
                          newContacts[0] = { ...newContacts[0], name: v };
                          setEditingClient({ ...editingClient, leadDoctor: v, providerContacts: newContacts });
                        } else {
                          const current = editingClient.additionalProviders && editingClient.additionalProviders.length >= 5
                            ? [...editingClient.additionalProviders]
                            : [...(editingClient.additionalProviders || []), ...Array(5 - (editingClient.additionalProviders?.length || 0)).fill("")];
                          current[providerIdx - 1] = v;
                          const updated = { ...editingClient, additionalProviders: current };
                          const newContacts = getAllPCFromEdit(updated);
                          newContacts[providerIdx] = { ...newContacts[providerIdx], name: v };
                          setEditingClient({ ...updated, providerContacts: newContacts });
                        }
                      }}
                      placeholder={isLead ? "Dr. Name" : `Provider ${providerIdx + 1} name`}
                      placeholderTextColor={Colors.light.textTertiary}
                    />
                    {isPopulated && (
                      <>
                        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                          <TextInput
                            style={[adm.input, { flex: 1 }]}
                            value={pc.email || ""}
                            onChangeText={(v) => {
                              const newContacts = getAllPCFromEdit(editingClient);
                              newContacts[providerIdx] = { ...newContacts[providerIdx], email: v };
                              setEditingClient({ ...editingClient, providerContacts: newContacts });
                            }}
                            placeholder="Email"
                            keyboardType="email-address"
                            autoCapitalize="none"
                            placeholderTextColor={Colors.light.textTertiary}
                          />
                          <TextInput
                            style={[adm.input, { flex: 1 }]}
                            value={pc.phone || ""}
                            onChangeText={(v) => {
                              const newContacts = getAllPCFromEdit(editingClient);
                              newContacts[providerIdx] = { ...newContacts[providerIdx], phone: formatPhone(v) };
                              setEditingClient({ ...editingClient, providerContacts: newContacts });
                            }}
                            placeholder="000-000-0000"
                            keyboardType="phone-pad"
                            placeholderTextColor={Colors.light.textTertiary}
                          />
                        </View>
                        <TextInput
                          style={adm.input}
                          value={pc.address || ""}
                          onChangeText={(v) => {
                            const newContacts = getAllPCFromEdit(editingClient);
                            newContacts[providerIdx] = { ...newContacts[providerIdx], address: v };
                            setEditingClient({ ...editingClient, providerContacts: newContacts });
                          }}
                          placeholder="Address (optional)"
                          placeholderTextColor={Colors.light.textTertiary}
                        />
                      </>
                    )}
                  </View>
                );
              })}
            </View>
            <View style={adm.fieldRow}>
              <View style={[adm.field, { flex: 1 }]}>
                <Text style={adm.fieldLabel}>Practice Phone</Text>
                <TextInput style={adm.input} value={editingClient.phone} onChangeText={(v) => setEditingClient({ ...editingClient, phone: formatPhone(v) })} placeholder="000-000-0000" keyboardType="phone-pad" />
              </View>
              <View style={[adm.field, { flex: 1 }]}>
                <Text style={adm.fieldLabel}>Practice Email</Text>
                <TextInput style={adm.input} value={editingClient.email} onChangeText={(v) => setEditingClient({ ...editingClient, email: v })} keyboardType="email-address" autoCapitalize="none" />
              </View>
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Practice Address</Text>
              <TextInput style={adm.input} value={editingClient.address} onChangeText={(v) => setEditingClient({ ...editingClient, address: v })} placeholder="Address" placeholderTextColor={Colors.light.textTertiary} />
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Client Tier</Text>
              <View style={adm.chipRow}>
                {pricingTiers.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => handleSelectTierInEdit(t.name)}
                    style={[adm.chip, editingClient.tier === t.name && adm.chipActive]}
                  >
                    <Text style={[adm.chipText, editingClient.tier === t.name && adm.chipTextActive]}>{t.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Pressable
              onPress={() => setShowEditClientPricing(!showEditClientPricing)}
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#fff", borderRadius: 12, padding: 14, marginTop: 8, marginBottom: 4, borderWidth: 1, borderColor: showEditClientPricing ? Colors.light.tint : Colors.light.border }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: "#D1FAE5", justifyContent: "center", alignItems: "center" }}>
                  <Ionicons name="pricetag" size={16} color="#10B981" />
                </View>
                <View>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>Edit Pricing</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText }}>Customize service prices for this provider</Text>
                </View>
              </View>
              <Ionicons name={showEditClientPricing ? "chevron-up" : "chevron-down"} size={18} color={Colors.light.subText} />
            </Pressable>

            {showEditClientPricing && (
              <View style={{ marginTop: 8 }}>
                {PRICE_LIST_ITEMS.map((item) => (
                  <View key={item.key} style={{ flexDirection: "row", alignItems: "center", marginBottom: 10, backgroundColor: "#fff", borderRadius: 12, padding: 12, shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
                    <View style={{ flex: 1, marginRight: 12 }}>
                      <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text }}>{item.label}</Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, minWidth: 100 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.subText, marginRight: 4 }}>$</Text>
                      <TextInput
                        style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text, flex: 1, padding: 0 }}
                        value={priceList[item.key]}
                        onChangeText={(v) => handleUpdateClientPrice(item.key, v)}
                        placeholder="0.00"
                        placeholderTextColor={Colors.light.textTertiary}
                        keyboardType="decimal-pad"
                      />
                    </View>
                  </View>
                ))}
              </View>
            )}

            <Pressable style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }]} onPress={handleSaveEditClient}>
              <Ionicons name="checkmark" size={20} color="#FFF" />
              <Text style={adm.submitBtnText}>Save Changes</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#FEE2E2", borderRadius: 14, padding: 16, marginTop: 16, borderWidth: 1, borderColor: "#FECACA" }, pressed && { opacity: 0.7 }]}
              onPress={() => {
                const clientPracticeName = editingClient.practiceName?.toLowerCase()?.trim();
                const clientOpenInvoices = invoices.filter(
                  inv => (inv.clientId === editingClient.id || (clientPracticeName && inv.clientName?.toLowerCase()?.trim() === clientPracticeName)) && (inv.status === "open" || inv.status === "overdue")
                );
                setDeleteClientTarget(editingClient);
                setDeleteClientHasOpenInvoices(clientOpenInvoices.length > 0);
                setShowDeleteClientModal(true);
              }}
            >
              <Ionicons name="trash" size={20} color="#EF4444" />
              <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#EF4444" }}>Delete Client</Text>
            </Pressable>
          </View>

          <Modal visible={showDeleteClientModal} transparent animationType="fade" onRequestClose={() => setShowDeleteClientModal(false)}>
            <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 24 }} onPress={() => setShowDeleteClientModal(false)}>
              <Pressable style={{ backgroundColor: "#fff", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }} onPress={() => {}}>
                <View style={{ alignItems: "center", marginBottom: 16 }}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#FEE2E2", justifyContent: "center", alignItems: "center", marginBottom: 12 }}>
                    <Ionicons name="warning" size={28} color="#EF4444" />
                  </View>
                  <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 8, textAlign: "center" }}>
                    {deleteClientHasOpenInvoices ? "Client Has Open Invoices" : "Delete Client"}
                  </Text>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.subText, textAlign: "center", lineHeight: 20 }}>
                    {deleteClientHasOpenInvoices
                      ? `${deleteClientTarget?.practiceName} has open invoices. Would you like to make this account inactive instead of deleting?`
                      : `Are you sure you want to delete ${deleteClientTarget?.practiceName}? This action cannot be undone.`}
                  </Text>
                </View>

                {deleteClientHasOpenInvoices ? (
                  <View style={{ gap: 10 }}>
                    <Pressable
                      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#F59E0B", borderRadius: 12, padding: 14 }, pressed && { opacity: 0.8 }]}
                      onPress={() => {
                        if (deleteClientTarget) {
                          deactivateClient(deleteClientTarget.id);
                          setShowDeleteClientModal(false);
                          setEditingClient(null);
                          setAdminView("client-hub");
                        }
                      }}
                    >
                      <Ionicons name="pause-circle" size={20} color="#fff" />
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Yes, Make Inactive</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#EF4444", borderRadius: 12, padding: 14 }, pressed && { opacity: 0.8 }]}
                      onPress={() => {
                        if (deleteClientTarget) {
                          removeClient(deleteClientTarget.id);
                          setShowDeleteClientModal(false);
                          setEditingClient(null);
                          setAdminView("client-hub");
                        }
                      }}
                    >
                      <Ionicons name="trash" size={20} color="#fff" />
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Delete Anyway</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [{ alignItems: "center", justifyContent: "center", padding: 14, borderRadius: 12, backgroundColor: Colors.light.surfaceSecondary }, pressed && { opacity: 0.7 }]}
                      onPress={() => setShowDeleteClientModal(false)}
                    >
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.subText }}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={{ gap: 10 }}>
                    <Pressable
                      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#EF4444", borderRadius: 12, padding: 14 }, pressed && { opacity: 0.8 }]}
                      onPress={() => {
                        if (deleteClientTarget) {
                          removeClient(deleteClientTarget.id);
                          setShowDeleteClientModal(false);
                          setEditingClient(null);
                          setAdminView("client-hub");
                        }
                      }}
                    >
                      <Ionicons name="trash" size={20} color="#fff" />
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Delete Client</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [{ alignItems: "center", justifyContent: "center", padding: 14, borderRadius: 12, backgroundColor: Colors.light.surfaceSecondary }, pressed && { opacity: 0.7 }]}
                      onPress={() => setShowDeleteClientModal(false)}
                    >
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.subText }}>Cancel</Text>
                    </Pressable>
                  </View>
                )}
              </Pressable>
            </Pressable>
          </Modal>
        </ScrollView>
      );
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Edit Provider", "client-hub")}
        <View style={adm.listArea}>
          <Text style={adm.formDesc}>Select a provider to edit.</Text>
          {clients.filter(c => c.status !== "inactive").map((c) => (
            <Pressable key={c.id} style={({ pressed }) => [adm.listItem, pressed && { opacity: 0.7 }]} onPress={() => {
              setEditingClient({ ...c });
              setShowEditClientPricing(false);
              const tier = pricingTiers.find(t => t.name === c.tier);
              if (tier) {
                const newPrices: Record<string, string> = {};
                PRICE_LIST_ITEMS.forEach(item => {
                  newPrices[item.key] = tier.prices[item.key]?.toString() || "";
                });
                setPriceList(newPrices);
              } else {
                const initial: Record<string, string> = {};
                PRICE_LIST_ITEMS.forEach(item => { initial[item.key] = ""; });
                setPriceList(initial);
              }
            }}>
              <View style={adm.listItemLeft}>
                <View style={[adm.listAvatar, { backgroundColor: c.tier === "Elite" ? Colors.light.warningLight : c.tier === "Premium" ? Colors.light.accentLight : Colors.light.surfaceSecondary }]}>
                  <Text style={[adm.listAvatarText, { color: c.tier === "Elite" ? Colors.light.warning : c.tier === "Premium" ? Colors.light.accent : Colors.light.textSecondary }]}>
                    {c.practiceName.charAt(0)}
                  </Text>
                </View>
                <View>
                  <Text style={adm.listItemTitle}>{c.practiceName}</Text>
                  <Text style={adm.listItemSub}>{formatAcctNum(c.accountNumber)} · {cleanDoctorDisplay(c.leadDoctor)}</Text>
                </View>
              </View>
              <View style={adm.tierBadge}>
                <Text style={[adm.tierBadgeText, { color: c.tier === "Elite" ? Colors.light.warning : c.tier === "Premium" ? Colors.light.accent : Colors.light.textSecondary }]}>{c.tier}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderAddUser() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Add User", "user-hub")}
        <View style={adm.formArea}>
          <Text style={adm.formDesc}>Create a new lab staff account.</Text>

          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Full Name</Text>
            <TextInput style={adm.input} value={newUserName} onChangeText={setNewUserName} placeholder="Jordan Lee" placeholderTextColor={Colors.light.textTertiary} />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Email</Text>
            <TextInput style={adm.input} value={newUserEmail} onChangeText={setNewUserEmail} placeholder="user@drivesynclab.com" placeholderTextColor={Colors.light.textTertiary} keyboardType="email-address" autoCapitalize="none" />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Role</Text>
            <View style={adm.chipRow}>
              {(["user", "admin"] as const).map((r) => (
                <Pressable key={r} onPress={() => setNewUserRole(r)} style={[adm.chip, newUserRole === r && adm.chipActive]}>
                  <Text style={[adm.chipText, newUserRole === r && adm.chipTextActive]}>{r === "user" ? "User" : "Admin"}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Station</Text>
            <View style={adm.chipRow}>
              {["Design", "Wax-Up", "Porcelain", "Finish", "QC", "All"].map((s) => (
                <Pressable key={s} onPress={() => setNewUserStation(s)} style={[adm.chip, newUserStation === s && adm.chipActive]}>
                  <Text style={[adm.chipText, newUserStation === s && adm.chipTextActive]}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <Pressable style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }]} onPress={handleAddUser}>
            <Ionicons name="checkmark" size={20} color="#FFF" />
            <Text style={adm.submitBtnText}>Create User Account</Text>
          </Pressable>
        </View>

        <View style={[adm.formArea, { marginTop: 24 }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Ionicons name="mail-outline" size={20} color={Colors.light.tint} />
            <Text style={[adm.formDesc, { marginBottom: 0, fontFamily: "Inter_600SemiBold", fontSize: 16 }]}>Invite Existing User</Text>
          </View>
          <Text style={adm.formDesc}>Send an invitation to an existing LabTrax user to join your lab.</Text>

          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Username</Text>
            <TextInput style={adm.input} value={inviteUsername} onChangeText={setInviteUsername} placeholder="Enter username" placeholderTextColor={Colors.light.textTertiary} autoCapitalize="none" />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Email</Text>
            <TextInput style={adm.input} value={inviteEmail} onChangeText={setInviteEmail} placeholder="user@example.com" placeholderTextColor={Colors.light.textTertiary} keyboardType="email-address" autoCapitalize="none" />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Role</Text>
            <View style={adm.chipRow}>
              {(["user", "admin"] as const).map((r) => (
                <Pressable key={r} onPress={() => setInviteRole(r)} style={[adm.chip, inviteRole === r && adm.chipActive]}>
                  <Text style={[adm.chipText, inviteRole === r && adm.chipTextActive]}>{r === "user" ? "User" : "Admin"}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [adm.submitBtn, { backgroundColor: "#7C3AED" }, pressed && { opacity: 0.85 }]}
            onPress={async () => {
              if (!inviteUsername.trim() || !inviteEmail.trim()) {
                Alert.alert("Required", "Username and email are required.");
                return;
              }
              const result = await sendLabInvite(inviteUsername.trim(), inviteEmail.trim(), inviteRole);
              if (result.success) {
                if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Alert.alert("Invitation Sent", `An invitation has been sent to ${inviteUsername.trim()}.`);
                setInviteUsername("");
                setInviteEmail("");
                setInviteRole("user");
              } else {
                Alert.alert("Unable to Send", result.error || "Something went wrong.");
              }
            }}
          >
            <Ionicons name="send" size={18} color="#FFF" />
            <Text style={adm.submitBtnText}>Send Invitation</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  function renderEditUser() {
    if (editingUser) {
      return (
        <ScrollView
          style={styles.container}
          contentContainerStyle={{
            paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {renderBackHeader("Edit User", "user-hub")}
          <View style={adm.formArea}>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Full Name</Text>
              <TextInput style={adm.input} value={editingUser.name} onChangeText={(v) => setEditingUser({ ...editingUser, name: v })} />
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Email</Text>
              <TextInput style={adm.input} value={editingUser.email} onChangeText={(v) => setEditingUser({ ...editingUser, email: v })} keyboardType="email-address" autoCapitalize="none" />
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Role</Text>
              <View style={adm.chipRow}>
                {(["user", "admin"] as const).map((r) => (
                  <Pressable key={r} onPress={() => setEditingUser({ ...editingUser, role: r })} style={[adm.chip, editingUser.role === r && adm.chipActive]}>
                    <Text style={[adm.chipText, editingUser.role === r && adm.chipTextActive]}>{r === "user" ? "User" : "Admin"}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Station</Text>
              <View style={adm.chipRow}>
                {["Design", "Wax-Up", "Porcelain", "Finish", "QC", "All"].map((s) => (
                  <Pressable key={s} onPress={() => setEditingUser({ ...editingUser, station: s })} style={[adm.chip, editingUser.station === s && adm.chipActive]}>
                    <Text style={[adm.chipText, editingUser.station === s && adm.chipTextActive]}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <Pressable
              style={({ pressed }) => [adm.toggleActiveBtn, !editingUser.active && adm.toggleActiveBtnInactive, pressed && { opacity: 0.85 }]}
              onPress={() => setEditingUser({ ...editingUser, active: !editingUser.active })}
            >
              <Ionicons name={editingUser.active ? "checkmark-circle" : "close-circle"} size={20} color={editingUser.active ? Colors.light.success : Colors.light.error} />
              <Text style={[adm.toggleActiveText, !editingUser.active && { color: Colors.light.error }]}>
                {editingUser.active ? "Active" : "Inactive"}
              </Text>
            </Pressable>
            <Pressable style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }]} onPress={handleSaveEditUser}>
              <Ionicons name="checkmark" size={20} color="#FFF" />
              <Text style={adm.submitBtnText}>Save Changes</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [adm.removeUserBtn, pressed && { opacity: 0.85 }]}
              onPress={() => setRemoveConfirmVisible(true)}
              testID="remove-user-btn"
            >
              <Ionicons name="trash-outline" size={20} color="#FFF" />
              <Text style={adm.removeUserBtnText}>Remove User</Text>
            </Pressable>

            <Modal
              transparent
              visible={removeConfirmVisible}
              animationType="fade"
              statusBarTranslucent
              onRequestClose={() => setRemoveConfirmVisible(false)}
            >
              <Pressable
                style={adm.confirmOverlay}
                onPress={() => setRemoveConfirmVisible(false)}
              >
                <View style={adm.confirmCard}>
                  <View style={adm.confirmIconWrap}>
                    <Ionicons name="warning" size={32} color="#EF4444" />
                  </View>
                  <Text style={adm.confirmTitle}>Are you sure you want to remove this user?</Text>
                  <Text style={adm.confirmDesc}>
                    This action cannot be undone. The user will lose access to the system.
                  </Text>
                  <View style={adm.confirmBtns}>
                    <Pressable
                      style={({ pressed }) => [adm.confirmYesBtn, pressed && { opacity: 0.85 }]}
                      onPress={() => {
                        if (editingUser) {
                          removeUser(editingUser.id);
                          setEditingUser(null);
                          setRemoveConfirmVisible(false);
                          if (Platform.OS !== "web") {
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          }
                        }
                      }}
                      testID="confirm-remove-yes"
                    >
                      <Text style={adm.confirmYesText}>Yes</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [adm.confirmNoBtn, pressed && { opacity: 0.85 }]}
                      onPress={() => setRemoveConfirmVisible(false)}
                      testID="confirm-remove-no"
                    >
                      <Text style={adm.confirmNoText}>No</Text>
                    </Pressable>
                  </View>
                </View>
              </Pressable>
            </Modal>
          </View>
        </ScrollView>
      );
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Edit User", "user-hub")}
        <View style={adm.listArea}>
          <Text style={adm.formDesc}>Select a user to edit.</Text>
          {users.map((u) => (
            <Pressable key={u.id} style={({ pressed }) => [adm.listItem, pressed && { opacity: 0.7 }]} onPress={() => setEditingUser({ ...u })}>
              <View style={adm.listItemLeft}>
                <View style={[adm.listAvatar, { backgroundColor: u.role === "admin" ? Colors.light.tintLight : Colors.light.successLight }]}>
                  <Text style={[adm.listAvatarText, { color: u.role === "admin" ? Colors.light.tint : Colors.light.success }]}>
                    {u.name.charAt(0)}
                  </Text>
                </View>
                <View>
                  <Text style={adm.listItemTitle}>{u.name}</Text>
                  <Text style={adm.listItemSub}>{u.role === "admin" ? "Admin" : "User"} · {u.station}</Text>
                </View>
              </View>
              <View style={[adm.statusDot, { backgroundColor: u.active ? Colors.light.success : Colors.light.textTertiary }]} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderInvoices() {
    const getStatusColor = (status: Invoice["status"]) => {
      switch (status) {
        case "open": return Colors.light.tint;
        case "sent": return Colors.light.warning;
        case "paid": return Colors.light.success;
        case "overdue": return Colors.light.error;
      }
    };

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Invoices", "invoices-hub")}
        <View style={adm.listArea}>
          <View style={adm.invoiceSummary}>
            <View style={adm.invoiceSummaryItem}>
              <Text style={adm.invoiceSummaryNum}>{invoices.filter((i) => i.status === "open").length}</Text>
              <Text style={adm.invoiceSummaryLabel}>Open</Text>
            </View>
            <View style={adm.invoiceSummaryDivider} />
            <View style={adm.invoiceSummaryItem}>
              <Text style={adm.invoiceSummaryNum}>{invoices.filter((i) => i.status === "overdue").length}</Text>
              <Text style={[adm.invoiceSummaryLabel, { color: Colors.light.error }]}>Overdue</Text>
            </View>
            <View style={adm.invoiceSummaryDivider} />
            <View style={adm.invoiceSummaryItem}>
              <Text style={adm.invoiceSummaryNum}>{invoices.filter((i) => i.status === "paid").length}</Text>
              <Text style={[adm.invoiceSummaryLabel, { color: Colors.light.success }]}>Paid</Text>
            </View>
          </View>

          {invoices.map((inv) => {
            const sc = getStatusColor(inv.status);
            return (
              <Pressable
                key={inv.id}
                style={({ pressed }) => [adm.invoiceCard, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedInvoice(inv);
                  setAdminView("invoice-detail");
                }}
              >
                <View style={adm.invoiceCardTop}>
                  <View>
                    <Text style={adm.invoiceNumber}>{formatInvNum(inv.invoiceNumber)}</Text>
                    <Text style={adm.invoiceClient}>{inv.clientName}</Text>
                  </View>
                  <Text style={adm.invoiceAmount}>{formatCurrency(inv.amount)}</Text>
                </View>
                <View style={adm.invoiceCardBottom}>
                  <Text style={adm.invoiceDate}>Due {new Date(inv.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</Text>
                  <View style={[adm.invoiceStatus, { backgroundColor: sc + "18" }]}>
                    <Text style={[adm.invoiceStatusText, { color: sc }]}>{inv.status.toUpperCase()}</Text>
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  function renderInvoiceDetail() {
    if (!selectedInvoice) return renderInvoices();
    const inv = selectedInvoice;
    const client = clients.find((c) => c.id === inv.clientId);
    const dateStr = new Date(inv.issuedAt).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
    const dueDateStr = new Date(inv.dueAt).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
    const lineTotal = inv.lineItems.reduce((s, li) => s + li.amount, 0);
    const finalTotal = lineTotal - inv.credits;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: "#f5f5f0" }}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 16 }}>
          <Pressable onPress={() => { setSelectedInvoice(null); setAdminView("invoices-hub"); }} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color="#333" />
          </Pressable>
          <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#333", flex: 1 }}>Invoice Detail</Text>
          <Pressable
            onPress={() => {
              setEditInvLineItems(inv.lineItems.map(li => ({ ...li })));
              setEditInvPatientName(inv.patientName || "");
              setEditInvBillTo(inv.billTo || "");
              setEditInvCaseType(inv.caseType || "");
              setEditInvTeeth(inv.teeth || "");
              setEditInvShade(inv.shade || "");
              setEditInvCaseNotes(inv.caseNotes || "");
              setEditInvCreditsText(String(inv.credits || 0));
              setEditInvClientId(inv.clientId || "");
              setEditInvClientName(inv.clientName || "");
              setEditInvBillToSearch(inv.billTo || "");
              setEditInvShowProviderDrop(false);
              setEditInvNumber(inv.invoiceNumber || "");
              setEditInvIssuedAtStr(new Date(inv.issuedAt).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }));
              setEditInvDueAtStr(new Date(inv.dueAt).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }));
              setEditInvCreditNote(inv.creditNote || "");
              setEditInvCaseTypeOpen(false);
              setEditInvSelectedPractice(null);
              setEditInvSubProvider("");
              setEditInvSubProviderOpen(false);
              setAdminView("edit-invoice");
            }}
            style={({ pressed }) => ({
              flexDirection: "row" as const,
              alignItems: "center" as const,
              backgroundColor: pressed ? "#1D4ED8" : "#2563EB",
              borderRadius: 8,
              paddingVertical: 8,
              paddingHorizontal: 14,
              gap: 6,
            })}
          >
            <Ionicons name="create-outline" size={16} color="#fff" />
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff" }}>Edit</Text>
          </Pressable>
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 4, borderWidth: 1, borderColor: "#333", overflow: "hidden" }}>
          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333" }}>
            <View style={{ flex: 1, padding: 16 }}>
              <View style={{ width: 50, height: 50, borderRadius: 8, backgroundColor: Colors.light.tint, justifyContent: "center", alignItems: "center", marginBottom: 10 }}>
                <Ionicons name="flask" size={28} color="#fff" />
              </View>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#333" }}>LabTrax</Text>
              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#555", marginTop: 2 }}>Dental Laboratory Services</Text>
              <View style={{ flexDirection: "row", marginTop: 12, backgroundColor: "#f8f8f5", borderWidth: 1, borderColor: "#ccc", borderRadius: 2, overflow: "hidden" }}>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: "#ccc" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Phone #</Text>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>(850) 201-4531</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 8 }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>E-mail</Text>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>info@drivesynclab.com</Text>
                </View>
              </View>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#333", marginTop: 14 }}>DriveSync Invoice</Text>
            </View>

            <View style={{ flex: 1, borderLeftWidth: 1, borderLeftColor: "#333" }}>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999", backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>CT</Text>
                </View>
                <View style={{ flex: 1.2, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999", backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Invoice #</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Date</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999" }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>{inv.caseType}</Text>
                </View>
                <View style={{ flex: 1.2, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999" }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#333" }}>{formatInvNum(inv.invoiceNumber)}</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6 }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>{dateStr}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999", backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Bill To</Text>
                </View>
                <View style={{ flex: 2.2, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Patient Name</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999" }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>{inv.billTo}</Text>
                </View>
                <View style={{ flex: 2.2, paddingVertical: 4, paddingHorizontal: 6 }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#333" }}>{inv.patientName}</Text>
                </View>
              </View>
              <View style={{ borderBottomWidth: 1, borderBottomColor: "#999", paddingVertical: 4, paddingHorizontal: 6, backgroundColor: "#f0f0ec" }}>
                <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Case Type</Text>
              </View>
              <View style={{ borderBottomWidth: 1, borderBottomColor: "#999", paddingVertical: 4, paddingHorizontal: 6 }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>{inv.caseType}</Text>
              </View>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <View style={{ flex: 1.5, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999", backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Teeth</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: "#f0f0ec" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Shade</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <View style={{ flex: 1.5, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999" }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>{inv.teeth}</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 4, paddingHorizontal: 6 }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#333" }}>{inv.shade}</Text>
                </View>
              </View>
              <View style={{ paddingVertical: 4, paddingHorizontal: 6, backgroundColor: "#f0f0ec", borderBottomWidth: 1, borderBottomColor: "#999" }}>
                <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#555" }}>Case Notes</Text>
              </View>
              <View style={{ paddingVertical: 4, paddingHorizontal: 6, minHeight: 24 }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#333" }}>{inv.caseNotes}</Text>
              </View>
            </View>
          </View>

          <View style={{ borderBottomWidth: 1, borderBottomColor: "#333", paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#C0392B", letterSpacing: 1 }}>CASE DUE BY</Text>
            <View style={{ marginTop: 6, borderWidth: 2, borderColor: "#333", paddingVertical: 8, paddingHorizontal: 24, borderRadius: 2 }}>
              <Text style={{ fontSize: 28, fontFamily: "Inter_700Bold", color: "#333" }}>{dueDateStr}</Text>
            </View>
          </View>

          <View style={{ borderBottomWidth: 1, borderBottomColor: "#333" }}>
            <View style={{ flexDirection: "row", backgroundColor: "#f0f0ec", borderBottomWidth: 1, borderBottomColor: "#999", alignItems: "center" }}>
              <View style={{ width: invColWidths[0], paddingVertical: 6, paddingHorizontal: 4, alignItems: "center" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Qty</Text>
              </View>
              <ColResizeHandle colIdx={0} widthRef={invColWidthRefs[0]} onWidthChange={setInvColWidth} />
              <View style={{ width: invColWidths[1], paddingVertical: 6, paddingHorizontal: 6 }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Item</Text>
              </View>
              <ColResizeHandle colIdx={1} widthRef={invColWidthRefs[1]} onWidthChange={setInvColWidth} />
              <View style={{ flex: 1, paddingVertical: 6, paddingHorizontal: 6 }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Description</Text>
              </View>
              <ColResizeHandle colIdx={2} widthRef={invColWidthRefs[2]} onWidthChange={setInvColWidth} />
              <View style={{ width: invColWidths[2], paddingVertical: 6, paddingHorizontal: 4, alignItems: "flex-end" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Rate</Text>
              </View>
              <ColResizeHandle colIdx={3} widthRef={invColWidthRefs[3]} onWidthChange={setInvColWidth} />
              <View style={{ width: invColWidths[3], paddingVertical: 6, paddingHorizontal: 4, alignItems: "flex-end" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Amount</Text>
              </View>
            </View>

            {inv.lineItems.map((li, idx) => (
              <View key={idx} style={{ flexDirection: "row", borderBottomWidth: idx < inv.lineItems.length - 1 ? 1 : 0, borderBottomColor: "#ddd" }}>
                <View style={{ width: invColWidths[0], paddingVertical: 8, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: "#eee", alignItems: "center" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#333" }}>{li.qty}</Text>
                </View>
                <View style={{ width: invColWidths[1], paddingVertical: 8, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#eee" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#333" }}>{li.item}</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#eee" }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#555" }}>{li.description}</Text>
                </View>
                <View style={{ width: invColWidths[2], paddingVertical: 8, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: "#eee", alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#333" }}>{formatCurrency(li.rate)}</Text>
                </View>
                <View style={{ width: invColWidths[3], paddingVertical: 8, paddingHorizontal: 4, alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#333" }}>{formatCurrency(li.amount)}</Text>
                </View>
              </View>
            ))}

            {inv.lineItems.length < 6 && Array.from({ length: 6 - inv.lineItems.length }).map((_, idx) => (
              <View key={`empty-${idx}`} style={{ flexDirection: "row", borderBottomWidth: idx < 5 - inv.lineItems.length ? 1 : 0, borderBottomColor: "#eee", height: 28 }}>
                <View style={{ width: invColWidths[0], borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ width: invColWidths[1], borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ flex: 1, borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ width: invColWidths[2], borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ width: invColWidths[3] }} />
              </View>
            ))}
          </View>

          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#999" }}>
            <View style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 10, justifyContent: "center" }}>
              <Text style={{ fontSize: 9, fontFamily: "Inter_700Bold", color: "#C0392B", textAlign: "center", textTransform: "uppercase" }}>DO NOT PAY INVOICE.{"\n"}MONTHLY STATEMENTS{"\n"}ARE GENERATED</Text>
            </View>
            <View style={{ borderLeftWidth: 1, borderLeftColor: "#999" }}>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#ccc", paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", width: 60 }}>Total</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#333", minWidth: 70, textAlign: "right" }}>{formatCurrency(lineTotal)}</Text>
              </View>
              <View style={{ borderBottomWidth: 1, borderBottomColor: "#ccc", paddingVertical: 6, paddingHorizontal: 10 }}>
                <View style={{ flexDirection: "row" }}>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", width: 60 }}>Credits</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#333", minWidth: 70, textAlign: "right" }}>{formatCurrency(inv.credits)}</Text>
                </View>
                {!!inv.creditNote && (
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#6B7280", marginTop: 2 }}>{inv.creditNote}</Text>
                )}
              </View>
              <View style={{ flexDirection: "row", paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", width: 60 }}>Total</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", minWidth: 70, textAlign: "right" }}>{formatCurrency(finalTotal)}</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: "row", marginHorizontal: 16, marginTop: 12, gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: inv.status === "overdue" ? "#FEE2E2" : inv.status === "paid" ? "#D1FAE5" : "#FEF3C7", borderRadius: 10, padding: 12, alignItems: "center" }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: inv.status === "overdue" ? "#991B1B" : inv.status === "paid" ? "#065F46" : "#92400E" }}>Status</Text>
            <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: inv.status === "overdue" ? "#DC2626" : inv.status === "paid" ? "#059669" : "#D97706", marginTop: 4, textTransform: "uppercase" }}>{inv.status}</Text>
          </View>
          {client && (
            <View style={{ flex: 1, backgroundColor: "#EFF6FF", borderRadius: 10, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#1E40AF" }}>Tier</Text>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#2563EB", marginTop: 4 }}>{client.tier}</Text>
            </View>
          )}
        </View>

      </ScrollView>
    );
  }

  function renderEditInvoice() {
    if (!selectedInvoice) return renderInvoiceDetail();
    const inv = selectedInvoice;
    const credits = parseFloat(editInvCreditsText) || 0;
    const lineTotal = editInvLineItems.reduce((s, li) => s + li.amount, 0);
    const balanceDue = lineTotal - credits;

    function updateLineItem(idx: number, field: keyof InvoiceLineItem, rawVal: string) {
      setEditInvLineItems(prev => {
        const next = prev.map((li, i) => {
          if (i !== idx) return li;
          const updated = { ...li };
          if (field === "qty" || field === "rate") {
            const num = parseFloat(rawVal) || 0;
            (updated as any)[field] = num;
            updated.amount = (field === "qty" ? num : updated.qty) * (field === "rate" ? num : updated.rate);
          } else {
            (updated as any)[field] = rawVal;
          }
          return updated;
        });
        return next;
      });
    }

    function addLineItem() {
      setEditInvLineItems(prev => [...prev, { qty: 1, item: "", description: "", rate: 0, amount: 0 }]);
    }

    function removeLineItem(idx: number) {
      setEditInvLineItems(prev => prev.filter((_, i) => i !== idx));
    }

    const allItemSuggestions: { item: string; description: string; rate: number }[] = (() => {
      const map = new Map<string, { description: string; rate: number }>();
      for (const inv of invoices) {
        for (const li of (inv.lineItems || [])) {
          const key = (li.item || "").trim();
          if (!key || map.has(key)) continue;
          map.set(key, { description: li.description || "", rate: li.rate || 0 });
        }
      }
      return Array.from(map.entries()).map(([item, vals]) => ({ item, ...vals }));
    })();

    function selectItemSuggestion(idx: number, suggestion: { item: string; description: string; rate: number }) {
      setEditInvLineItems(prev => prev.map((li, i) => {
        if (i !== idx) return li;
        const qty = li.qty || 1;
        return { ...li, item: suggestion.item, description: suggestion.description, rate: suggestion.rate, amount: qty * suggestion.rate };
      }));
      setEditInvItemDropdownIdx(null);
    }

    const providerSearchResults = editInvBillToSearch.trim().length > 0
      ? clients.filter(c => {
          const q = editInvBillToSearch.toLowerCase();
          return (c.practiceName || "").toLowerCase().includes(q)
            || (c.leadDoctor || "").toLowerCase().includes(q)
            || (c.additionalProviders || []).some(p => p.toLowerCase().includes(q));
        }).slice(0, 8)
      : [];

    function parseDateStr(s: string): number | null {
      const parts = s.trim().split("/");
      if (parts.length !== 3) return null;
      const [m, d, y] = parts.map(Number);
      if (!m || !d || !y || y < 1900 || y > 2100) return null;
      const dt = new Date(y, m - 1, d);
      return isNaN(dt.getTime()) ? null : dt.getTime();
    }

    function handleSave() {
      const newLineItems = editInvLineItems.filter(li => li.item.trim() || li.description.trim() || li.amount > 0);
      const newAmount = newLineItems.reduce((s, li) => s + li.amount, 0) - credits;
      const resolvedBillTo = editInvBillTo || editInvBillToSearch;
      const parsedIssuedAt = parseDateStr(editInvIssuedAtStr);
      const parsedDueAt = parseDateStr(editInvDueAtStr);
      const updates: Partial<Invoice> = {
        lineItems: newLineItems,
        amount: newAmount,
        patientName: editInvPatientName,
        billTo: resolvedBillTo,
        clientId: editInvClientId || inv.clientId,
        clientName: editInvClientName || inv.clientName,
        caseType: editInvCaseType,
        teeth: editInvTeeth,
        shade: editInvShade,
        caseNotes: editInvCaseNotes,
        credits,
        creditNote: editInvCreditNote,
        invoiceNumber: editInvNumber.trim() || inv.invoiceNumber,
        issuedAt: parsedIssuedAt ?? inv.issuedAt,
        dueAt: parsedDueAt ?? inv.dueAt,
      };
      updateInvoice(inv.id, updates);
      setSelectedInvoice({ ...inv, ...updates });
      setAdminView("invoice-detail");
    }

    const inputBase = {
      fontFamily: "Inter_400Regular" as const,
      fontSize: 12,
      color: "#111",
      borderWidth: 1,
      borderColor: "#93C5FD",
      borderRadius: 4,
      paddingVertical: 4,
      paddingHorizontal: 6,
      backgroundColor: "#EFF6FF",
    };

    return (
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1, backgroundColor: "#F0F4F8" }}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 24 : 200,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 16 }}>
          <Pressable onPress={() => setAdminView("invoice-detail")} style={{ marginRight: 12, padding: 4 }}>
            <Ionicons name="close" size={24} color="#374151" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#111827" }}>Edit Invoice</Text>
            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#6B7280", marginTop: 1 }}>#{formatInvNum(inv.invoiceNumber)}</Text>
          </View>
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
          <View style={{ backgroundColor: "#1E3A5F", paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5 }}>INVOICE INFO</Text>
          </View>

          <View style={{ padding: 14, gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Invoice #</Text>
                <TextInput
                  style={inputBase}
                  value={editInvNumber}
                  onChangeText={setEditInvNumber}
                  placeholder="e.g. INV-2026-001"
                  placeholderTextColor="#9CA3AF"
                  autoCapitalize="characters"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Invoice Date</Text>
                <TextInput
                  style={inputBase}
                  value={editInvIssuedAtStr}
                  onChangeText={setEditInvIssuedAtStr}
                  placeholder="MM/DD/YYYY"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Due Date</Text>
                <TextInput
                  style={inputBase}
                  value={editInvDueAtStr}
                  onChangeText={setEditInvDueAtStr}
                  placeholder="MM/DD/YYYY"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={{ flex: 1 }} />
            </View>

            <View>
              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Bill To / Group or Practice</Text>
              <View style={{ position: "relative" as const }}>
                <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: editInvShowProviderDrop ? "#2563EB" : "#93C5FD", borderRadius: 4, backgroundColor: "#EFF6FF", overflow: "hidden" }}>
                  <TextInput
                    style={[inputBase, { flex: 1, borderWidth: 0, borderRadius: 0, backgroundColor: "transparent", margin: 0 }]}
                    value={editInvBillToSearch}
                    onChangeText={(t) => {
                      setEditInvBillToSearch(t);
                      setEditInvBillTo(t);
                      setEditInvShowProviderDrop(true);
                      setEditInvSelectedPractice(null);
                      setEditInvSubProvider("");
                      setEditInvSubProviderOpen(false);
                      if (!t.trim()) { setEditInvClientId(""); setEditInvClientName(""); }
                    }}
                    onFocus={() => setEditInvShowProviderDrop(true)}
                    placeholder="Type to search group or practice..."
                    placeholderTextColor="#9CA3AF"
                    returnKeyType="done"
                    onSubmitEditing={() => setEditInvShowProviderDrop(false)}
                  />
                  {editInvClientId ? (
                    <Ionicons name="checkmark-circle" size={16} color="#059669" style={{ marginRight: 8 }} />
                  ) : (
                    <Ionicons name="search" size={14} color="#6B7280" style={{ marginRight: 8 }} />
                  )}
                </View>
                {editInvClientId && (
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#059669", marginTop: 2 }}>
                    Practice: {editInvClientName}
                  </Text>
                )}
                {editInvShowProviderDrop && (providerSearchResults.length > 0 || (editInvBillToSearch.trim().length > 0 && providerSearchResults.length === 0)) && (
                  <View style={{ position: "absolute" as const, top: "100%" as any, left: 0, right: 0, zIndex: 999, backgroundColor: "#fff", borderRadius: 8, borderWidth: 1, borderColor: "#E5E7EB", shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 8, elevation: 8, marginTop: 2 }}>
                    {providerSearchResults.map((c, i) => (
                      <Pressable
                        key={c.id}
                        onPress={() => {
                          const display = c.practiceName || c.leadDoctor;
                          setEditInvBillToSearch(display);
                          setEditInvClientId(c.id);
                          setEditInvClientName(display);
                          setEditInvShowProviderDrop(false);
                          setEditInvSelectedPractice(c);
                          setEditInvSubProvider("");
                          setEditInvSubProviderOpen(true);
                          const provList = [c.leadDoctor, ...(c.additionalProviders || [])].filter(Boolean);
                          if (provList.length === 1) {
                            setEditInvBillTo(provList[0]);
                            setEditInvSubProvider(provList[0]);
                            setEditInvSubProviderOpen(false);
                          } else {
                            setEditInvBillTo(display);
                          }
                        }}
                        style={({ pressed }) => ({ flexDirection: "row" as const, alignItems: "center" as const, padding: 10, borderBottomWidth: i < providerSearchResults.length - 1 ? 1 : 0, borderBottomColor: "#F3F4F6", backgroundColor: pressed ? "#EFF6FF" : "#fff", borderRadius: i === 0 ? 8 : 0 })}
                      >
                        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#1D4ED8" }}>{(c.practiceName || c.leadDoctor || "?")[0].toUpperCase()}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#111827" }}>{c.practiceName || c.leadDoctor}</Text>
                          {c.practiceName && c.leadDoctor && c.practiceName !== c.leadDoctor && (
                            <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#6B7280" }}>{c.leadDoctor}{(c.additionalProviders || []).length > 0 ? ` + ${(c.additionalProviders || []).length} more` : ""}</Text>
                          )}
                        </View>
                        <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
                      </Pressable>
                    ))}
                    {editInvBillToSearch.trim().length > 0 && providerSearchResults.length === 0 && (
                      <Pressable
                        onPress={() => {
                          const name = editInvBillToSearch.trim();
                          const newClient = addClient({ practiceName: name, leadDoctor: name, phone: "", email: "", address: "" } as any);
                          if (newClient) {
                            setEditInvBillTo(name);
                            setEditInvBillToSearch(name);
                            setEditInvClientId(newClient.id);
                            setEditInvClientName(name);
                            setEditInvSubProvider(name);
                          }
                          setEditInvShowProviderDrop(false);
                        }}
                        style={({ pressed }) => ({ flexDirection: "row" as const, alignItems: "center" as const, padding: 10, backgroundColor: pressed ? "#FEF9C3" : "#FFFBEB", borderRadius: 8, gap: 8 })}
                      >
                        <Ionicons name="person-add-outline" size={16} color="#D97706" />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#92400E" }}>Add "{editInvBillToSearch.trim()}" as new provider</Text>
                          <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#B45309", marginTop: 1 }}>Creates a new provider record</Text>
                        </View>
                        <Ionicons name="add-circle" size={18} color="#D97706" />
                      </Pressable>
                    )}
                  </View>
                )}
              </View>

              {editInvSelectedPractice && editInvSubProviderOpen && (() => {
                const provList = [editInvSelectedPractice.leadDoctor, ...(editInvSelectedPractice.additionalProviders || [])].filter(Boolean);
                return (
                  <View style={{ marginTop: 8 }}>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Select Specific Provider</Text>
                    <View style={{ backgroundColor: "#fff", borderRadius: 8, borderWidth: 1, borderColor: "#93C5FD", overflow: "hidden" }}>
                      {provList.map((prov, i) => (
                        <Pressable
                          key={i}
                          onPress={() => {
                            setEditInvBillTo(prov);
                            setEditInvSubProvider(prov);
                            setEditInvSubProviderOpen(false);
                          }}
                          style={({ pressed }) => ({ flexDirection: "row" as const, alignItems: "center" as const, padding: 10, borderBottomWidth: i < provList.length - 1 ? 1 : 0, borderBottomColor: "#EFF6FF", backgroundColor: editInvSubProvider === prov ? "#DBEAFE" : pressed ? "#EFF6FF" : "#fff" })}
                        >
                          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: editInvSubProvider === prov ? "#2563EB" : "#EFF6FF", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                            <Ionicons name="person" size={14} color={editInvSubProvider === prov ? "#fff" : "#2563EB"} />
                          </View>
                          <Text style={{ fontSize: 12, fontFamily: editInvSubProvider === prov ? "Inter_700Bold" : "Inter_500Medium", color: editInvSubProvider === prov ? "#1D4ED8" : "#111827", flex: 1 }}>{prov}</Text>
                          {editInvSubProvider === prov && <Ionicons name="checkmark-circle" size={16} color="#2563EB" />}
                        </Pressable>
                      ))}
                    </View>
                    <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#6B7280", marginTop: 3 }}>
                      Billing: {editInvBillTo || editInvBillToSearch}
                    </Text>
                  </View>
                );
              })()}
            </View>

            <View>
              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Patient Name</Text>
              <TextInput
                style={inputBase}
                value={editInvPatientName}
                onChangeText={setEditInvPatientName}
                placeholder="Patient name"
                placeholderTextColor="#9CA3AF"
              />
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 2, zIndex: 50 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Case Type</Text>
                <View style={{ position: "relative" as const }}>
                  <TextInput
                    style={[inputBase, { borderColor: editInvCaseTypeOpen ? "#2563EB" : "#93C5FD" }]}
                    value={editInvCaseType}
                    onChangeText={(t) => { setEditInvCaseType(t); setEditInvCaseTypeOpen(true); }}
                    onFocus={() => setEditInvCaseTypeOpen(true)}
                    onBlur={() => setTimeout(() => setEditInvCaseTypeOpen(false), 160)}
                    placeholder="Select or type..."
                    placeholderTextColor="#9CA3AF"
                    returnKeyType="done"
                  />
                  {editInvCaseTypeOpen && (
                    <View style={{ position: "absolute" as const, top: "100%" as any, left: 0, right: 0, zIndex: 999, backgroundColor: "#fff", borderRadius: 6, borderWidth: 1, borderColor: "#3B82F6", borderTopWidth: 0, shadowColor: "#000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 6, elevation: 8 }}>
                      {["Restorative", "Removable", "Appliance", "Temporary", "Other"]
                        .filter(ct => !editInvCaseType.trim() || ct.toLowerCase().includes(editInvCaseType.toLowerCase()))
                        .map((ct, i, arr) => (
                          <Pressable
                            key={ct}
                            onPress={() => { setEditInvCaseType(ct); setEditInvCaseTypeOpen(false); }}
                            style={({ pressed }) => ({ padding: 9, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: "#F3F4F6", backgroundColor: pressed ? "#EFF6FF" : "#fff", borderRadius: i === arr.length - 1 ? 6 : 0 })}
                          >
                            <Text style={{ fontSize: 12, fontFamily: editInvCaseType === ct ? "Inter_700Bold" : "Inter_500Medium", color: editInvCaseType === ct ? "#2563EB" : "#111827" }}>{ct}</Text>
                          </Pressable>
                        ))
                      }
                    </View>
                  )}
                </View>
              </View>
              <View style={{ flex: 1.5 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Teeth</Text>
                <TextInput
                  style={inputBase}
                  value={editInvTeeth}
                  onChangeText={setEditInvTeeth}
                  placeholder="#3, #14"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Shade</Text>
                <TextInput
                  style={inputBase}
                  value={editInvShade}
                  onChangeText={setEditInvShade}
                  placeholder="A2"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            <View>
              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Case Notes / Memo</Text>
              <TextInput
                style={[inputBase, { minHeight: 56, textAlignVertical: "top" }]}
                value={editInvCaseNotes}
                onChangeText={setEditInvCaseNotes}
                placeholder="Additional notes..."
                placeholderTextColor="#9CA3AF"
                multiline
              />
            </View>
          </View>
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
          <View style={{ backgroundColor: "#1E3A5F", paddingVertical: 10, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5, flex: 1 }}>LINE ITEMS</Text>
            <Pressable
              onPress={addLineItem}
              style={({ pressed }) => ({ backgroundColor: pressed ? "#60A5FA" : "#3B82F6", paddingVertical: 5, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4 })}
            >
              <Ionicons name="add" size={14} color="#fff" />
              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Add Item</Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", backgroundColor: "#F1F5F9", borderBottomWidth: 1, borderBottomColor: "#E2E8F0", paddingVertical: 8, paddingHorizontal: 10 }}>
            <Text style={{ width: 32, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569" }}>Qty</Text>
            <Text style={{ width: 80, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", paddingLeft: 4 }}>Item</Text>
            <Text style={{ flex: 1, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", paddingLeft: 4 }}>Description</Text>
            <Text style={{ width: 54, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", textAlign: "right" }}>Rate</Text>
            <Text style={{ width: 60, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", textAlign: "right" }}>Amount</Text>
            <View style={{ width: 24 }} />
          </View>

          {editInvLineItems.map((li, idx) => {
            const itemSearch = (li.item || "").toLowerCase().trim();
            const filteredSuggestions = editInvItemDropdownIdx === idx
              ? (itemSearch.length > 0
                  ? allItemSuggestions.filter(s => s.item.toLowerCase().includes(itemSearch) && s.item.toLowerCase() !== itemSearch)
                  : allItemSuggestions
                ).slice(0, 8)
              : [];
            return (
              <View key={idx}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 10, borderBottomWidth: filteredSuggestions.length > 0 ? 0 : 1, borderBottomColor: "#F1F5F9", backgroundColor: idx % 2 === 0 ? "#fff" : "#FAFBFC" }}>
                  <TextInput
                    style={[inputBase, { width: 32, textAlign: "center", paddingHorizontal: 2 }]}
                    value={String(li.qty)}
                    onChangeText={(v) => updateLineItem(idx, "qty", v)}
                    keyboardType="decimal-pad"
                    onFocus={() => setEditInvItemDropdownIdx(null)}
                  />
                  <TextInput
                    style={[inputBase, { width: 80, marginLeft: 4, borderColor: editInvItemDropdownIdx === idx ? "#3B82F6" : "#93C5FD" }]}
                    value={li.item}
                    onChangeText={(v) => { updateLineItem(idx, "item", v); setEditInvItemDropdownIdx(idx); }}
                    onFocus={() => setEditInvItemDropdownIdx(idx)}
                    onBlur={() => setTimeout(() => setEditInvItemDropdownIdx(null), 180)}
                    placeholder="Item"
                    placeholderTextColor="#9CA3AF"
                  />
                  <TextInput
                    style={[inputBase, { flex: 1, marginLeft: 4 }]}
                    value={li.description}
                    onChangeText={(v) => updateLineItem(idx, "description", v)}
                    placeholder="Description"
                    placeholderTextColor="#9CA3AF"
                    onFocus={() => setEditInvItemDropdownIdx(null)}
                  />
                  <TextInput
                    style={[inputBase, { width: 54, marginLeft: 4, textAlign: "right" }]}
                    value={String(li.rate)}
                    onChangeText={(v) => updateLineItem(idx, "rate", v)}
                    keyboardType="decimal-pad"
                    onFocus={() => setEditInvItemDropdownIdx(null)}
                  />
                  <View style={{ width: 60, marginLeft: 4, alignItems: "flex-end" }}>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#111827" }}>{formatCurrency(li.amount)}</Text>
                  </View>
                  <Pressable onPress={() => removeLineItem(idx)} style={{ width: 24, alignItems: "center" }}>
                    <Ionicons name="trash-outline" size={15} color="#EF4444" />
                  </Pressable>
                </View>
                {filteredSuggestions.length > 0 && (
                  <View style={{ marginHorizontal: 10, backgroundColor: "#fff", borderWidth: 1, borderColor: "#3B82F6", borderTopWidth: 0, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, zIndex: 100, elevation: 10 }}>
                    {filteredSuggestions.map((s, si) => (
                      <Pressable
                        key={si}
                        onPress={() => selectItemSuggestion(idx, s)}
                        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, paddingHorizontal: 10, backgroundColor: pressed ? "#EFF6FF" : si % 2 === 0 ? "#F8FAFF" : "#fff", borderTopWidth: si > 0 ? 1 : 0, borderTopColor: "#E5E7EB" })}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#1E3A5F" }}>{s.item}</Text>
                          {s.description ? <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#6B7280", marginTop: 1 }}>{s.description}</Text> : null}
                        </View>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#059669", marginLeft: 8 }}>{formatCurrency(s.rate)}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            );
          })}

          {editInvLineItems.length === 0 && (
            <View style={{ paddingVertical: 20, alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#9CA3AF" }}>No line items. Tap Add Item to begin.</Text>
            </View>
          )}
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 16 }}>
          <View style={{ backgroundColor: "#1E3A5F", paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5 }}>TOTALS</Text>
          </View>
          <View style={{ padding: 14, gap: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#374151" }}>Subtotal</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#111827" }}>{formatCurrency(lineTotal)}</Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#374151" }}>Credits / Payments Applied</Text>
              <TextInput
                style={[inputBase, { width: 80, textAlign: "right" }]}
                value={editInvCreditsText}
                onChangeText={setEditInvCreditsText}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor="#9CA3AF"
              />
            </View>
            <View>
              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Credit / Payment Note (reason)</Text>
              <TextInput
                style={[inputBase, { minHeight: 44, textAlignVertical: "top" }]}
                value={editInvCreditNote}
                onChangeText={setEditInvCreditNote}
                placeholder="e.g. Insurance payment received, courtesy adjustment..."
                placeholderTextColor="#9CA3AF"
                multiline
              />
            </View>
            <View style={{ height: 1, backgroundColor: "#E5E7EB" }} />
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#111827" }}>Balance Due</Text>
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: balanceDue > 0 ? "#DC2626" : "#059669" }}>{formatCurrency(balanceDue)}</Text>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: "row", marginHorizontal: 16, gap: 10, marginBottom: 24 }}>
          <Pressable
            onPress={() => setAdminView("invoice-detail")}
            style={({ pressed }) => ({ flex: 1, borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 12, paddingVertical: 14, alignItems: "center" as const, backgroundColor: pressed ? "#F9FAFB" : "#fff" })}
          >
            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#374151" }}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            style={({ pressed }) => ({ flex: 2, backgroundColor: pressed ? "#1D4ED8" : "#2563EB", borderRadius: 12, paddingVertical: 14, alignItems: "center" as const, flexDirection: "row" as const, justifyContent: "center" as const, gap: 8 })}
          >
            <Ionicons name="checkmark-circle" size={18} color="#fff" />
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#fff" }}>Save & Close</Text>
          </Pressable>
        </View>
      </KeyboardAwareScrollViewCompat>
    );
  }


  function renderFinancialHub() {
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    const openInvCount = invoices.filter(i => i.status === "open").length;
    const overdueInvCount = invoices.filter(i => i.status === "overdue").length;
    const totalOpenAmt = invoices
      .filter(i => i.status === "open" || i.status === "overdue")
      .reduce((s, inv) => s + inv.amount, 0);
    const collectedYTD = invoices
      .filter(i => i.status === "paid" && i.issuedAt >= yearStart)
      .reduce((s, inv) => s + inv.amount, 0);
    const overdueAmt = invoices
      .filter(i => i.status === "overdue")
      .reduce((s, inv) => s + inv.amount, 0);
    const lowStockCount = inventory.filter(i => i.quantity <= i.minQuantity).length;
    type FinancialItem = { icon: string; color: string; bg: string; title: string; sub: string; view?: AdminView; push?: string };
    const financialItems: FinancialItem[] = [
      { icon: "document-text", color: Colors.light.warning, bg: Colors.light.warningLight, title: "Invoices", sub: `${openInvCount} open · ${overdueInvCount} overdue`, view: "invoices-hub" as AdminView },
      { icon: "receipt-outline", color: "#06B6D4", bg: "#CFFAFE", title: "Statements", sub: "View & send billing statements", push: "/statements" },
      { icon: "cash-outline", color: "#059669", bg: "#D1FAE5", title: "Receive Payment", sub: "Record payments from clients", view: "receive-payment" as AdminView },
      { icon: "trending-up", color: Colors.light.error, bg: Colors.light.errorLight, title: "Sales Report", sub: "Revenue & analytics", view: "sales" as AdminView },
      { icon: "stats-chart", color: "#0EA5E9", bg: "#E0F2FE", title: "P&L Report", sub: "Profit & loss by period", view: "pl-report" as AdminView },
      { icon: "time-outline", color: "#F59E0B", bg: "#FEF3C7", title: "A/R Aging", sub: "Outstanding by age bucket", view: "ar-aging" as AdminView },
      { icon: "pricetag-outline", color: "#8B5CF6", bg: "#F3E8FF", title: "Sales by Item", sub: "Revenue by product/service", view: "sales-by-item" as AdminView },
      { icon: "cube", color: "#10B981", bg: "#D1FAE5", title: "Inventory", sub: `${inventory.length} items · ${lowStockCount} low stock`, view: "inventory" as AdminView },
    ];

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Financial")}

        <LinearGradient
          colors={["#1E3A5F", "#1D4ED8"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ marginHorizontal: 16, borderRadius: 16, padding: 20, marginBottom: 12 }}
        >
          <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.65)", letterSpacing: 1, marginBottom: 4 }}>ACCOUNTS RECEIVABLE</Text>
          <Text style={{ fontSize: 34, fontFamily: "Inter_700Bold", color: "#fff", marginBottom: 12 }}>{formatCurrency(totalOpenAmt)}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 10, padding: 10 }}>
              <Text style={{ fontSize: 10, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.65)" }}>Open</Text>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff", marginTop: 2 }}>{openInvCount}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "rgba(239,68,68,0.25)", borderRadius: 10, padding: 10 }}>
              <Text style={{ fontSize: 10, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.65)" }}>Overdue</Text>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FCA5A5", marginTop: 2 }}>{formatCurrency(overdueAmt)}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "rgba(16,185,129,0.25)", borderRadius: 10, padding: 10 }}>
              <Text style={{ fontSize: 10, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.65)" }}>Collected YTD</Text>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#6EE7B7", marginTop: 2 }}>{formatCurrency(collectedYTD)}</Text>
            </View>
          </View>
        </LinearGradient>

        <View style={adm.menuSection}>
          {financialItems.map((item) => (
            <Pressable
              key={item.title}
              style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => item.push ? router.push(item.push as any) : item.view && setAdminView(item.view)}
            >
              <View style={[adm.menuIcon, { backgroundColor: item.bg }]}>
                <Ionicons name={item.icon as any} size={20} color={item.color} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{item.title}</Text>
                <Text style={adm.menuSub}>{item.sub}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderInvoicesHub() {
    const openCount = invoices.filter(i => i.status === "open").length;
    const overdueCount = invoices.filter(i => i.status === "overdue").length;
    const allCount = invoices.length;
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Invoices", "financial-hub")}
        <View style={adm.listArea}>
          <View style={adm.invoiceSummary}>
            <View style={adm.invoiceSummaryItem}>
              <Text style={adm.invoiceSummaryNum}>{openCount}</Text>
              <Text style={adm.invoiceSummaryLabel}>Open</Text>
            </View>
            <View style={adm.invoiceSummaryDivider} />
            <View style={adm.invoiceSummaryItem}>
              <Text style={adm.invoiceSummaryNum}>{overdueCount}</Text>
              <Text style={[adm.invoiceSummaryLabel, { color: Colors.light.error }]}>Overdue</Text>
            </View>
            <View style={adm.invoiceSummaryDivider} />
            <View style={adm.invoiceSummaryItem}>
              <Text style={adm.invoiceSummaryNum}>{allCount}</Text>
              <Text style={[adm.invoiceSummaryLabel, { color: Colors.light.success }]}>Total</Text>
            </View>
          </View>

          <View style={{ backgroundColor: Colors.light.tint, borderRadius: 14, marginBottom: 12, overflow: "hidden" as const }}>
            <View style={{ paddingVertical: 14, paddingHorizontal: 20, flexDirection: "row" as const, alignItems: "center" as const, gap: 12 }}>
              <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center" as const, justifyContent: "center" as const }}>
                <Ionicons name="eye-outline" size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>View Invoices</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)" }}>Select a category below</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row" as const, gap: 1, backgroundColor: "rgba(255,255,255,0.15)" }}>
              <Pressable
                style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)", paddingVertical: 14, alignItems: "center" as const, justifyContent: "center" as const })}
                onPress={() => { setInvoiceFilter("open"); setAdminView("view-invoices"); }}
              >
                <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#fff" }}>{openCount}</Text>
                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.85)", marginTop: 2 }}>Open</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)", paddingVertical: 14, alignItems: "center" as const, justifyContent: "center" as const })}
                onPress={() => { setInvoiceFilter("pastdue"); setAdminView("view-invoices"); }}
              >
                <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#FCA5A5" }}>{overdueCount}</Text>
                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.85)", marginTop: 2 }}>Past Due</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)", paddingVertical: 14, alignItems: "center" as const, justifyContent: "center" as const })}
                onPress={() => { setInvoiceFilter("all"); setAdminView("view-invoices"); }}
              >
                <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#fff" }}>{allCount}</Text>
                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.85)", marginTop: 2 }}>All</Text>
              </Pressable>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => ({ backgroundColor: "#16A34A", borderRadius: 14, paddingVertical: 16, paddingHorizontal: 20, marginBottom: 12, flexDirection: "row" as const, alignItems: "center" as const, gap: 12, opacity: pressed ? 0.85 : 1 })}
            onPress={() => {
              const openInvs = invoices.filter(i => i.status === "open" || i.status === "overdue");
              if (openInvs.length === 0) {
                Alert.alert("No Open Invoices", "There are no open invoices to send.");
                return;
              }
              setAdminView("pick-invoice-to-send");
            }}
          >
            <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="send" size={20} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Send Invoices</Text>
              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)" }}>Email or text an invoice</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.6)" />
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  function renderViewInvoices() {
    const getStatusColor = (status: Invoice["status"]) => {
      switch (status) {
        case "open": return Colors.light.tint;
        case "sent": return Colors.light.warning;
        case "paid": return Colors.light.success;
        case "overdue": return Colors.light.error;
      }
    };
    const filterLabel = invoiceFilter === "open" ? "Open Invoices" : invoiceFilter === "pastdue" ? "Past Due Invoices" : "All Invoices";
    const filteredInvoices = invoiceFilter === "open"
      ? invoices.filter(i => i.status === "open" || i.status === "overdue")
      : invoiceFilter === "pastdue"
        ? invoices.filter(i => i.status === "overdue")
        : invoices;

    const providerNames = [...new Set(filteredInvoices.map(i => i.clientName || "Unknown"))].sort();
    const providerGroups = providerNames.map(name => ({
      name,
      invoices: filteredInvoices.filter(i => (i.clientName || "Unknown") === name).sort((a, b) => b.issuedAt - a.issuedAt),
    }));

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 16 }}>
          <Pressable onPress={() => setAdminView("invoices-hub")} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text, flex: 1 }}>{filterLabel}</Text>
          <View style={{ backgroundColor: Colors.light.tintLight, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>{providerGroups.length} providers</Text>
          </View>
        </View>

        <View style={adm.listArea}>
          {providerGroups.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 40 }}>
              <Ionicons name="document-text-outline" size={48} color={Colors.light.textTertiary} />
              <Text style={{ fontSize: 16, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginTop: 12 }}>No {filterLabel.toLowerCase()} found</Text>
            </View>
          ) : (
            providerGroups.map(({ name, invoices: groupInvs }) => {
              const isExpanded = !!expandedInvoiceProviders[name];
              const groupTotal = groupInvs.reduce((s, i) => s + i.amount, 0);
              const hasOverdue = groupInvs.some(i => i.status === "overdue");
              const headerColor = hasOverdue ? Colors.light.error : Colors.light.tint;
              return (
                <View key={name} style={{ marginBottom: 10, borderRadius: 14, borderWidth: 1, borderColor: isExpanded ? headerColor + "40" : Colors.light.border, overflow: "hidden", backgroundColor: "#fff" }}>
                  <Pressable
                    onPress={() => setExpandedInvoiceProviders(prev => ({ ...prev, [name]: !prev[name] }))}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 16, backgroundColor: pressed ? Colors.light.tintLight : "#fff", gap: 12 })}
                  >
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: headerColor + "18", alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="business-outline" size={18} color={headerColor} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.text }} numberOfLines={1}>{name}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 }}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                          {groupInvs.length} invoice{groupInvs.length !== 1 ? "s" : ""}
                        </Text>
                        {hasOverdue && (
                          <View style={{ backgroundColor: Colors.light.error + "18", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                            <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: Colors.light.error }}>OVERDUE</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: hasOverdue ? Colors.light.error : Colors.light.text, marginRight: 4 }}>
                      {formatCurrency(groupTotal)}
                    </Text>
                    <Ionicons
                      name={isExpanded ? "chevron-down" : "chevron-forward"}
                      size={20}
                      color={Colors.light.textTertiary}
                    />
                  </Pressable>

                  {isExpanded && (
                    <View style={{ borderTopWidth: 1, borderTopColor: Colors.light.border }}>
                      {groupInvs.map((inv, invIdx) => {
                        const sc = getStatusColor(inv.status);
                        const isOverdue = inv.status === "overdue" || (inv.dueAt < Date.now() && inv.status !== "paid");
                        return (
                          <Pressable
                            key={inv.id}
                            onPress={() => { setSelectedInvoice(inv); setAdminView("invoice-detail"); }}
                            style={({ pressed }) => ({
                              paddingVertical: 12,
                              paddingHorizontal: 16,
                              backgroundColor: pressed ? Colors.light.tintLight : invIdx % 2 === 0 ? "#FAFBFC" : "#fff",
                              borderBottomWidth: invIdx < groupInvs.length - 1 ? 1 : 0,
                              borderBottomColor: Colors.light.border,
                              flexDirection: "row",
                              alignItems: "flex-start",
                              gap: 10,
                            })}
                          >
                            <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: sc + "18", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
                              <Ionicons name="document-text-outline" size={16} color={sc} />
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                                <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                                <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: isOverdue ? Colors.light.error : Colors.light.text }}>{formatCurrency(inv.amount)}</Text>
                              </View>
                              {inv.patientName ? (
                                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 2 }}>
                                  Patient: {inv.patientName}
                                </Text>
                              ) : null}
                              {inv.caseType ? (
                                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginBottom: 2 }}>
                                  {inv.caseType}{inv.teeth ? ` · Teeth: ${inv.teeth}` : ""}{inv.shade ? ` · Shade: ${inv.shade}` : ""}
                                </Text>
                              ) : null}
                              {(inv.lineItems || []).length > 0 && (
                                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginBottom: 2 }}>
                                  {(inv.lineItems || []).map(li => `${li.item || li.description}${li.qty !== 1 ? ` ×${li.qty}` : ""}`).join(" · ")}
                                </Text>
                              )}
                              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary }}>
                                    Issued {new Date(inv.issuedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                  </Text>
                                  <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: isOverdue ? Colors.light.error : Colors.light.textTertiary }}>
                                    Due {new Date(inv.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                  </Text>
                                </View>
                                <View style={{ backgroundColor: sc + "18", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                                  <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: sc, textTransform: "uppercase" }}>{inv.status}</Text>
                                </View>
                              </View>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color={Colors.light.textTertiary} style={{ marginTop: 10 }} />
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    );
  }

  function renderSendInvoice() {
    const client = sendInvoiceTarget ? clients.find(c => (c.practiceName || "").trim().toLowerCase() === (sendInvoiceTarget.clientName || "").trim().toLowerCase()) : null;
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 16 }}>
          <Pressable onPress={() => setAdminView("invoices-hub")} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Send Invoice</Text>
        </View>
        <View style={adm.listArea}>
          {sendInvoiceTarget && (
            <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: Colors.light.border }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 4 }}>{formatInvNum(sendInvoiceTarget.invoiceNumber)}</Text>
              <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>{sendInvoiceTarget.clientName} · {formatCurrency(sendInvoiceTarget.amount)}</Text>
            </View>
          )}

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Email Address(es)</Text>
          <TextInput style={[adm.input, { marginBottom: 4 }]} value={sendEmailTo} onChangeText={setSendEmailTo} placeholder="Enter email address" keyboardType="email-address" autoCapitalize="none" />
          <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginBottom: 16 }}>Separate multiple addresses with a ; — invoice sent as PDF attachment</Text>

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Phone Number(s) — Text PDF</Text>
          <TextInput style={[adm.input, { marginBottom: 4 }]} value={sendPhoneTo} onChangeText={setSendPhoneTo} placeholder="Enter phone number" keyboardType="phone-pad" />
          <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginBottom: 16 }}>Separate multiple numbers with a ; — PDF shared via messaging app</Text>

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Subject</Text>
          <TextInput style={[adm.input, { marginBottom: 16 }]} value={sendEmailSubject} onChangeText={setSendEmailSubject} placeholder="Email subject" />

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Message</Text>
          <TextInput style={[adm.input, { height: 140, textAlignVertical: "top" }]} value={sendEmailMessage} onChangeText={setSendEmailMessage} placeholder="Message body" multiline numberOfLines={6} />

          <Pressable
            style={({ pressed }) => ({ backgroundColor: "#16A34A", borderRadius: 14, paddingVertical: 16, alignItems: "center" as const, flexDirection: "row" as const, justifyContent: "center" as const, gap: 8, opacity: pressed ? 0.85 : 1, marginTop: 16 })}
            onPress={async () => {
              if (!sendEmailTo.trim() && !sendPhoneTo.trim()) { Alert.alert("Required", "Please enter an email address or phone number."); return; }
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

              const emails = sendEmailTo.split(";").map(e => e.trim()).filter(e => e.length > 0);
              const phones = sendPhoneTo.split(";").map(p => p.trim()).filter(p => p.length > 0);

              if (emails.length > 0) {
                emails.forEach(email => {
                  apiRequest("POST", "/api/send-statement-email", {
                    clientName: sendInvoiceTarget?.clientName || "",
                    clientEmail: email,
                    adminEmail: getAdminEmail(),
                    subject: sendEmailSubject,
                    body: sendEmailMessage,
                  }).catch(() => {});
                });
                addNotification({ title: "Invoice Emailed", message: `Invoice ${sendInvoiceTarget ? formatInvNum(sendInvoiceTarget.invoiceNumber) : ""} sent to ${emails.join(", ")}`, type: "update" });
              }

              if (phones.length > 0) {
                const smsBody = encodeURIComponent(sendEmailMessage);
                const smsUrl = Platform.OS === "ios" ? `sms:${phones.join(",")}&body=${smsBody}` : `sms:${phones.join(",")}?body=${smsBody}`;
                Linking.openURL(smsUrl).catch(() => Alert.alert("Unable to Open", "Could not open the messaging app."));
                addNotification({ title: "Invoice Texted", message: `Invoice PDF shared to ${phones.join(", ")}`, type: "update" });
              }

              const onFileEmail = client?.email || "";
              const enteredEmails = emails.join("; ");
              const emailChanged = onFileEmail.toLowerCase().trim() !== enteredEmails.toLowerCase().trim() && enteredEmails.length > 0;
              const onFilePhone = client?.phone || "";
              const enteredPhones = phones.join("; ");
              const phoneChanged = onFilePhone.trim() !== enteredPhones.trim() && enteredPhones.length > 0;

              const updates: Record<string, string> = {};
              const savePrompts: string[] = [];
              if (emailChanged && client) { updates.email = enteredEmails; savePrompts.push(`email (${enteredEmails})`); }
              if (phoneChanged && client) { updates.phone = enteredPhones; savePrompts.push(`phone (${enteredPhones})`); }

              if (savePrompts.length > 0 && client) {
                Alert.alert(
                  "Save to Provider?",
                  `The ${savePrompts.join(" and ")} entered ${savePrompts.length > 1 ? "are" : "is"} not on file for ${client.practiceName}. Would you like to save ${savePrompts.length > 1 ? "them" : "it"} to the provider record?`,
                  [
                    { text: "Yes, Save", onPress: () => { updateClient(client.id, updates); setAdminView("invoices-hub"); } },
                    { text: "No, Just Send", onPress: () => setAdminView("invoices-hub") },
                  ]
                );
              } else {
                setAdminView("invoices-hub");
              }
            }}
          >
            <Ionicons name="send" size={18} color="#FFF" />
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Send Invoice</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  function renderPickInvoiceToSend() {
    const openInvs = invoices.filter(i => i.status === "open" || i.status === "overdue");
    const allSelected = openInvs.length > 0 && openInvs.every(inv => selectedInvoiceIds.includes(inv.id));
    const selectedCount = openInvs.filter(inv => selectedInvoiceIds.includes(inv.id)).length;

    function handleSendSelected() {
      const selected = openInvs.filter(inv => selectedInvoiceIds.includes(inv.id));
      if (selected.length === 0) { Alert.alert("No Invoices Selected", "Please select at least one invoice to send."); return; }
      if (selected.length === 1) {
        const inv = selected[0];
        setSendInvoiceTarget(inv);
        const client = clients.find(c => c.practiceName === inv.clientName);
        setSendEmailTo(client?.email || "");
        setSendPhoneTo(client?.phone || "");
        setSendEmailSubject(`Invoice ${formatInvNum(inv.invoiceNumber)} - ${inv.clientName}`);
        setSendEmailMessage(`Dear ${inv.clientName},\n\nPlease find attached invoice ${formatInvNum(inv.invoiceNumber)} for ${formatCurrency(inv.amount)}.\n\nDue Date: ${new Date(inv.dueAt).toLocaleDateString()}.`);
        setAdminView("send-invoice");
      } else {
        const totalAmt = selected.reduce((s, inv) => s + inv.amount, 0);
        const invSummary = selected.map(inv => `${formatInvNum(inv.invoiceNumber)} - ${inv.clientName}: ${formatCurrency(inv.amount)}`).join("\n");
        const clientNames = [...new Set(selected.map(inv => inv.clientName))];
        const firstClient = clients.find(c => c.practiceName === clientNames[0]);
        setSendInvoiceTarget(selected[0]);
        setSendEmailTo(firstClient?.email || "");
        setSendPhoneTo(firstClient?.phone || "");
        setSendEmailSubject(`Invoices - ${selected.length} invoices totaling ${formatCurrency(totalAmt)}`);
        setSendEmailMessage(`Dear Client,\n\nPlease find the following invoices attached:\n\n${invSummary}\n\nTotal: ${formatCurrency(totalAmt)}.`);
        setAdminView("send-invoice");
      }
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 16 }}>
          <Pressable onPress={() => { setAdminView("invoices-hub"); setSelectedInvoiceIds([]); }} style={{ marginRight: 12, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Send Invoice</Text>
        </View>
        <View style={adm.listArea}>
          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 12, padding: 12, marginBottom: 16, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: Colors.light.border }}>
            <Ionicons name="information-circle" size={18} color={Colors.light.tint} />
            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, flex: 1 }}>Email and text options are available on the next screen. Invoices are sent as PDF.</Text>
          </View>

          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary }}>Select invoices</Text>
            {openInvs.length > 0 && (
              <Pressable
                onPress={() => {
                  if (allSelected) {
                    setSelectedInvoiceIds([]);
                  } else {
                    setSelectedInvoiceIds(openInvs.map(inv => inv.id));
                  }
                }}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Ionicons name={allSelected ? "checkbox" : "square-outline"} size={20} color={Colors.light.tint} />
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.tint }}>Select All</Text>
              </Pressable>
            )}
          </View>
          {openInvs.length === 0 && (
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", paddingVertical: 20 }}>No open invoices to send.</Text>
          )}
          {openInvs.map(inv => {
            const isChecked = selectedInvoiceIds.includes(inv.id);
            return (
              <Pressable
                key={inv.id}
                style={({ pressed }) => ({ backgroundColor: isChecked ? Colors.light.tintLight : (pressed ? Colors.light.tintLight : Colors.light.surface), borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: isChecked ? Colors.light.tint : Colors.light.border, flexDirection: "row" as const, alignItems: "center" as const })}
                onPress={() => {
                  setSelectedInvoiceIds(prev =>
                    prev.includes(inv.id) ? prev.filter(id => id !== inv.id) : [...prev, inv.id]
                  );
                }}
              >
                <Ionicons
                  name={isChecked ? "checkbox" : "square-outline"}
                  size={22}
                  color={isChecked ? Colors.light.tint : Colors.light.textTertiary}
                  style={{ marginRight: 12 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{inv.clientName} · {formatCurrency(inv.amount)}</Text>
                </View>
                <View style={{ backgroundColor: inv.status === "overdue" ? Colors.light.error + "20" : Colors.light.tint + "20", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: inv.status === "overdue" ? Colors.light.error : Colors.light.tint, textTransform: "capitalize" }}>{inv.status}</Text>
                </View>
              </Pressable>
            );
          })}

          {selectedCount > 0 && (
            <Pressable
              style={({ pressed }) => ({ backgroundColor: sendInvoiceMode === "text" ? "#16A34A" : Colors.light.tint, borderRadius: 14, paddingVertical: 16, marginTop: 12, alignItems: "center" as const, flexDirection: "row" as const, justifyContent: "center" as const, gap: 8, opacity: pressed ? 0.85 : 1 })}
              onPress={handleSendSelected}
            >
              <Ionicons name={sendInvoiceMode === "text" ? "chatbubble-ellipses" : "send"} size={18} color="#FFF" />
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>
                {sendInvoiceMode === "text" ? "Text" : "Email"} {selectedCount} Invoice{selectedCount !== 1 ? "s" : ""}
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    );
  }

  function renderTextInvoice() {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 16 }}>
          <Pressable onPress={() => setAdminView("invoices-hub")} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Text Invoice</Text>
        </View>
        <View style={adm.listArea}>
          {sendInvoiceTarget && (
            <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: Colors.light.border }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 4 }}>{formatInvNum(sendInvoiceTarget.invoiceNumber)}</Text>
              <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>{sendInvoiceTarget.clientName} · {formatCurrency(sendInvoiceTarget.amount)}</Text>
            </View>
          )}
          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Phone Number</Text>
          <TextInput style={[adm.input, { marginBottom: 4 }]} value={sendTextTo} onChangeText={setSendTextTo} placeholder="Enter phone number" keyboardType="phone-pad" />
          <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginBottom: 16 }}>Please separate each phone number with a ;</Text>

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Message</Text>
          <TextInput style={[adm.input, { height: 160, textAlignVertical: "top" }]} value={sendTextMessage} onChangeText={setSendTextMessage} placeholder="Text message" multiline numberOfLines={8} />

          <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 4, marginBottom: 16 }}>The invoice will be attached as a PDF</Text>

          <Pressable
            style={({ pressed }) => ({ backgroundColor: "#16A34A", borderRadius: 14, paddingVertical: 16, alignItems: "center" as const, flexDirection: "row" as const, justifyContent: "center" as const, gap: 8, opacity: pressed ? 0.85 : 1 })}
            onPress={() => {
              if (!sendTextTo.trim()) { Alert.alert("Required", "Please enter a phone number."); return; }
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              const phones = sendTextTo.split(";").map(p => p.trim()).filter(p => p.length > 0);
              const smsBody = encodeURIComponent(sendTextMessage);
              const smsUrl = Platform.OS === "ios"
                ? `sms:${phones.join(",")}&body=${smsBody}`
                : `sms:${phones.join(",")}?body=${smsBody}`;
              Linking.openURL(smsUrl).catch(() => {
                Alert.alert("Unable to Open", "Could not open the messaging app.");
              });
              addNotification({ title: "Invoice Texted", message: `Invoice ${sendInvoiceTarget ? formatInvNum(sendInvoiceTarget.invoiceNumber) : ""} texted to ${phones.join(", ")}`, type: "update" });

              const client = sendInvoiceTarget ? clients.find(c => (c.practiceName || "").trim().toLowerCase() === (sendInvoiceTarget.clientName || "").trim().toLowerCase()) : null;
              const onFilePhone = client?.phone || "";
              const allEnteredPhones = phones.join("; ");
              const phoneChanged = onFilePhone.trim() !== allEnteredPhones.trim() && allEnteredPhones.length > 0;

              if (phoneChanged && client) {
                Alert.alert(
                  "Save Phone Number?",
                  `The phone number you entered (${allEnteredPhones}) is different from what's on file for ${client.practiceName}. Would you like to save this as the default phone number for future text messages?`,
                  [
                    {
                      text: "Yes, Save",
                      onPress: () => {
                        updateClient(client.id, { phone: allEnteredPhones });
                        setAdminView("invoices-hub");
                      },
                    },
                    {
                      text: "No",
                      onPress: () => {
                        setAdminView("invoices-hub");
                      },
                    },
                  ]
                );
              } else {
                setAdminView("invoices-hub");
              }
            }}
          >
            <Ionicons name="chatbubble-ellipses" size={18} color="#FFF" />
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Send Text</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }
  function renderClients() {
    const activeClients = clients.filter(c => c.status !== "inactive");
    const clientsWithBalance = activeClients.map((c) => {
      const clientInvoices = invoices.filter((inv) => (inv.clientId === c.id || (inv.clientName || "").trim().toLowerCase() === (c.practiceName || "").trim().toLowerCase()) && (inv.status === "open" || inv.status === "overdue"));
      const openBalance = clientInvoices.reduce((s, inv) => s + inv.amount, 0);
      const openCount = clientInvoices.length;
      return { ...c, openBalance, openCount };
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const totalOpen = clientsWithBalance.reduce((s, c) => s + c.openBalance, 0);
    const filteredClients = clientSearchQuery.trim()
      ? clientsWithBalance.filter(c =>
          c.practiceName.toLowerCase().includes(clientSearchQuery.toLowerCase()) ||
          (c.leadDoctor || "").toLowerCase().includes(clientSearchQuery.toLowerCase()) ||
          (c.accountNumber || "").toLowerCase().includes(clientSearchQuery.toLowerCase())
        )
      : clientsWithBalance;

    return (
      <ScrollView style={{ flex: 1, backgroundColor: Colors.light.background }} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Pressable onPress={() => { setAdminView("client-hub"); setClientSearchQuery(""); }} style={{ marginRight: 12, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Clients</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>
              {clients.length} practices · {formatCurrency(totalOpen)} total open
            </Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: Colors.light.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.light.border, paddingHorizontal: 12, height: 44 }}>
            <Ionicons name="search" size={18} color={Colors.light.textTertiary} style={{ marginRight: 8 }} />
            <TextInput
              style={{ flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text }}
              placeholder="Search clients..."
              placeholderTextColor={Colors.light.textTertiary}
              value={clientSearchQuery}
              onChangeText={setClientSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {clientSearchQuery.length > 0 && (
              <Pressable onPress={() => setClientSearchQuery("")} style={{ padding: 4 }}>
                <Ionicons name="close-circle" size={18} color={Colors.light.textTertiary} />
              </Pressable>
            )}
          </View>
        </View>

        {filteredClients.length === 0 && clientSearchQuery.trim().length > 0 && (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Ionicons name="search-outline" size={40} color={Colors.light.textTertiary} />
            <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textTertiary, marginTop: 10 }}>No clients found for "{clientSearchQuery}"</Text>
          </View>
        )}

        {filteredClients.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => { setSelectedClient(c); setAdminView("client-detail"); }}
            style={{ marginHorizontal: 16, marginBottom: 10, backgroundColor: "#fff", borderRadius: 14, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{c.practiceName}</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 3 }}>{formatAcctNum(c.accountNumber)} · {cleanDoctorDisplay(c.leadDoctor)}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: c.openBalance > 0 ? Colors.light.warning : Colors.light.success }}>
                  {formatCurrency(c.openBalance)}
                </Text>
                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>
                  {c.openCount > 0 ? `${c.openCount} open invoice${c.openCount > 1 ? "s" : ""}` : "Paid up"}
                </Text>
              </View>
            </View>

            <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: Colors.light.border, paddingTop: 10 }}>
              {c.address ? (
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
                  <Ionicons name="location-outline" size={14} color={Colors.light.subText} />
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginLeft: 6, flex: 1 }} numberOfLines={1}>{c.address}</Text>
                </View>
              ) : null}
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
                <Ionicons name="call-outline" size={14} color={Colors.light.subText} />
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginLeft: 6 }}>{c.phone || "No phone"}</Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Ionicons name="mail-outline" size={14} color={Colors.light.subText} />
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginLeft: 6 }}>{c.email || "No email"}</Text>
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
              <View style={{ backgroundColor: c.tier === "Elite" ? "#FEF3C7" : c.tier === "Premium" ? "#EDE9FE" : Colors.light.surfaceAlt, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: c.tier === "Elite" ? "#D97706" : c.tier === "Premium" ? "#7C3AED" : Colors.light.subText }}>{c.tier}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.light.subText} />
            </View>
          </Pressable>
        ))}
      </ScrollView>
    );
  }

  function renderClientDetail() {
    if (!selectedClient) return renderClients();

    const clientInvoices = invoices.filter((inv) => (inv.clientName || "").trim().toLowerCase() === (selectedClient.practiceName || "").trim().toLowerCase());
    const openInvoices = clientInvoices.filter((inv) => inv.status === "open" || inv.status === "overdue");
    const paidInvoices = clientInvoices.filter((inv) => inv.status === "paid");
    const openBalance = openInvoices.reduce((s, inv) => s + inv.amount, 0);
    const paidTotal = paidInvoices.reduce((s, inv) => s + inv.amount, 0);
    const clientCases = cases.filter((c) => (c as any).clientName === selectedClient.practiceName);

    return (
      <ScrollView style={{ flex: 1, backgroundColor: Colors.light.background }} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 12, paddingBottom: 8 }}>
          <Pressable onPress={() => { setSelectedClient(null); setAdminView("clients"); }} style={{ marginRight: 12, width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{selectedClient.practiceName}</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>Dr. {selectedClient.leadDoctor}</Text>
          </View>
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 12, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
          {selectedClient.address ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
              <Ionicons name="location" size={18} color={Colors.light.tint} />
              <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text, marginLeft: 10, flex: 1 }}>{selectedClient.address}</Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
            <Ionicons name="id-card" size={18} color={Colors.light.tint} />
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginLeft: 10 }}>{formatAcctNum(selectedClient.accountNumber)}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
            <Ionicons name="call" size={18} color={Colors.light.tint} />
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text, marginLeft: 10 }}>{selectedClient.phone || "No phone"}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
            <Ionicons name="mail" size={18} color={Colors.light.tint} />
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text, marginLeft: 10 }}>{selectedClient.email || "No email"}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="ribbon" size={18} color={selectedClient.tier === "Elite" ? "#D97706" : selectedClient.tier === "Premium" ? "#7C3AED" : Colors.light.subText} />
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginLeft: 10 }}>{selectedClient.tier} Tier</Text>
            {selectedClient.discountRate > 0 && (
              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginLeft: 8 }}>({selectedClient.discountRate}% discount)</Text>
            )}
          </View>
        </View>

        <View style={{ flexDirection: "row", marginHorizontal: 16, marginBottom: 12, gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: openBalance > 0 ? "#FEF3C7" : "#D1FAE5", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: openBalance > 0 ? "#92400E" : "#065F46" }}>Open Balance</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: openBalance > 0 ? "#D97706" : "#059669", marginTop: 4 }}>{formatCurrency(openBalance)}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#EFF6FF", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#1E40AF" }}>Paid to Date</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#2563EB", marginTop: 4 }}>{formatCurrency(paidTotal)}</Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", marginHorizontal: 16, marginBottom: 12, gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: Colors.light.surfaceAlt, borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>Active Cases</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text, marginTop: 4 }}>{clientCases.filter((c) => c.status !== "COMPLETE").length}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: Colors.light.surfaceAlt, borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>Total Cases</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text, marginTop: 4 }}>{clientCases.length}</Text>
          </View>
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 12, gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => {
                setEditingClient(selectedClient);
                const tier = pricingTiers.find(t => t.name === selectedClient.tier);
                const newPrices: Record<string, string> = {};
                PRICE_LIST_ITEMS.forEach(item => {
                  if (selectedClient.customPricing && selectedClient.customPricing[item.key] !== undefined) {
                    newPrices[item.key] = selectedClient.customPricing[item.key].toString();
                  } else if (tier) {
                    newPrices[item.key] = tier.prices[item.key]?.toString() || "";
                  } else {
                    newPrices[item.key] = "";
                  }
                });
                setPriceList(newPrices);
                setAdminView("edit-client");
              }}
              style={({ pressed }) => ({ flex: 1, backgroundColor: "#EDE9FE", borderRadius: 12, paddingVertical: 12, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.8 : 1 })}
            >
              <Ionicons name="create-outline" size={18} color="#7C3AED" />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#7C3AED" }}>Edit Client</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push("/statements")}
              style={({ pressed }) => ({ flex: 1, backgroundColor: Colors.light.tint, borderRadius: 12, paddingVertical: 12, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.8 : 1 })}
            >
              <Ionicons name="document-text" size={18} color="#fff" />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Statements</Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => {
                if (openInvoices.length === 0) {
                  Alert.alert("No Open Invoices", "There are no open invoices to send.");
                  return;
                }
                setSelectedInvoiceIds(openInvoices.map(inv => inv.id));
                setSendInvoiceMode("email");
                setAdminView("pick-invoice-to-send");
              }}
              style={({ pressed }) => ({ flex: 1, backgroundColor: "#DBEAFE", borderRadius: 12, paddingVertical: 12, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.8 : 1 })}
            >
              <Ionicons name="receipt-outline" size={18} color="#2563EB" />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#2563EB" }}>Send Invoices</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!selectedClient.phone) {
                  Alert.alert("No Phone Number", "This client doesn't have a phone number on file. Please add one in Edit Client.");
                  return;
                }
                const smsUrl = Platform.OS === "ios"
                  ? `sms:${selectedClient.phone}`
                  : `sms:${selectedClient.phone}`;
                Linking.openURL(smsUrl).catch(() => {
                  Alert.alert("Unable to Open", "Could not open the messaging app.");
                });
              }}
              style={({ pressed }) => ({ flex: 1, backgroundColor: "#D1FAE5", borderRadius: 12, paddingVertical: 12, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.8 : 1 })}
            >
              <Ionicons name="chatbubble-outline" size={18} color="#059669" />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#059669" }}>Text</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!selectedClient.phone) {
                  Alert.alert("No Phone Number", "This client doesn't have a phone number on file. Please add one in Edit Client.");
                  return;
                }
                Linking.openURL(`tel:${selectedClient.phone}`).catch(() => {
                  Alert.alert("Unable to Call", "Could not open the phone app.");
                });
              }}
              style={({ pressed }) => ({ flex: 1, backgroundColor: "#FEF3C7", borderRadius: 12, paddingVertical: 12, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.8 : 1 })}
            >
              <Ionicons name="call-outline" size={18} color="#D97706" />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#D97706" }}>Call</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => setAdminView("client-stats")}
            style={({ pressed }) => ({ backgroundColor: Colors.light.surfaceAlt, borderRadius: 12, paddingVertical: 12, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.8 : 1 })}
          >
            <Ionicons name="bar-chart" size={18} color={Colors.light.textSecondary} />
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary }}>Account Stats</Text>
          </Pressable>
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
          <View style={{ position: "relative", zIndex: 10 }}>
            <Pressable
              onPress={() => setClientDetailInvDropdownOpen(!clientDetailInvDropdownOpen)}
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#fff", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: Colors.light.border, marginBottom: clientDetailInvDropdownOpen ? 0 : 10 }}
            >
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text }}>
                {clientDetailInvFilter === "open" ? "Open Invoices" : clientDetailInvFilter === "all" ? "All Invoices" : "Month to Date"}
              </Text>
              <Ionicons name={clientDetailInvDropdownOpen ? "chevron-up" : "chevron-down"} size={20} color={Colors.light.textSecondary} />
            </Pressable>

            {clientDetailInvDropdownOpen && (
              <View style={{ backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: Colors.light.border, marginBottom: 10, overflow: "hidden" }}>
                {(["open", "all", "mtd"] as const).map(opt => {
                  const label = opt === "open" ? "Open Invoices" : opt === "all" ? "All Invoices" : "Month to Date";
                  const isActive = clientDetailInvFilter === opt;
                  return (
                    <Pressable
                      key={opt}
                      onPress={() => { setClientDetailInvFilter(opt); setClientDetailInvDropdownOpen(false); }}
                      style={({ pressed }) => ({ paddingVertical: 14, paddingHorizontal: 16, backgroundColor: isActive ? Colors.light.tintLight : (pressed ? Colors.light.surfaceAlt : "#fff"), borderBottomWidth: opt !== "mtd" ? 1 : 0, borderBottomColor: Colors.light.border, flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const })}
                    >
                      <Text style={{ fontSize: 14, fontFamily: isActive ? "Inter_600SemiBold" : "Inter_400Regular", color: isActive ? Colors.light.tint : Colors.light.text }}>{label}</Text>
                      {isActive && <Ionicons name="checkmark" size={18} color={Colors.light.tint} />}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          {(() => {
            const now = new Date();
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const displayInvoices = clientDetailInvFilter === "open"
              ? openInvoices
              : clientDetailInvFilter === "all"
                ? clientInvoices
                : clientInvoices.filter(inv => inv.issuedAt >= monthStart);
            const sortedDisplay = [...displayInvoices].sort((a, b) => b.issuedAt - a.issuedAt);

            if (sortedDisplay.length === 0) {
              return (
                <View style={{ alignItems: "center", paddingVertical: 30 }}>
                  <Ionicons name="document-text-outline" size={36} color={Colors.light.textTertiary} />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textTertiary, marginTop: 8 }}>
                    No {clientDetailInvFilter === "open" ? "open" : clientDetailInvFilter === "mtd" ? "month-to-date" : ""} invoices
                  </Text>
                </View>
              );
            }

            return sortedDisplay.map((inv) => {
              const statusColor = inv.status === "paid" ? Colors.light.success : inv.status === "overdue" ? Colors.light.error : Colors.light.warning;
              const borderColor = inv.status === "paid" ? Colors.light.success : inv.status === "overdue" ? Colors.light.error : Colors.light.warning;
              return (
                <Pressable
                  key={inv.id}
                  style={({ pressed }) => ({ backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, borderLeftWidth: 3, borderLeftColor: borderColor, opacity: pressed ? 0.7 : 1 })}
                  onPress={() => {
                    setSelectedInvoice(inv);
                    setAdminView("invoice-detail");
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>
                      {inv.status === "paid" ? "Paid" : "Due"} {new Date(inv.status === "paid" ? inv.issuedAt : inv.dueAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: statusColor }}>{formatCurrency(inv.amount)}</Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: statusColor, textTransform: "uppercase", marginTop: 2 }}>{inv.status}</Text>
                  </View>
                </Pressable>
              );
            });
          })()}
        </View>
      </ScrollView>
    );
  }

  function renderClientStats() {
    if (!selectedClient) return renderClients();

    const clientInvoices = invoices.filter((inv) => (inv.clientName || "").trim().toLowerCase() === (selectedClient.practiceName || "").trim().toLowerCase());
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentDay = now.getDate();
    const priorYear = currentYear - 1;

    const getInvoicesByYear = (year: number) => clientInvoices.filter((inv) => new Date(inv.issuedAt).getFullYear() === year);
    const currentYearInvoices = getInvoicesByYear(currentYear);
    const priorYearInvoices = getInvoicesByYear(priorYear);

    const todayStart = new Date(currentYear, currentMonth, currentDay).getTime();
    const todayEnd = todayStart + 86400000;
    const dailySales = clientInvoices.filter((inv) => inv.issuedAt >= todayStart && inv.issuedAt < todayEnd).reduce((s, inv) => s + inv.amount, 0);

    const monthStart = new Date(currentYear, currentMonth, 1).getTime();
    const mtdSales = currentYearInvoices.filter((inv) => inv.issuedAt >= monthStart).reduce((s, inv) => s + inv.amount, 0);

    const yearStart = new Date(currentYear, 0, 1).getTime();
    const ytdSales = currentYearInvoices.reduce((s, inv) => s + inv.amount, 0);

    const priorYtdCutoff = new Date(priorYear, currentMonth, currentDay).getTime();
    const priorYtdSales = priorYearInvoices.filter((inv) => inv.issuedAt <= priorYtdCutoff).reduce((s, inv) => s + inv.amount, 0);
    const priorFullYear = priorYearInvoices.reduce((s, inv) => s + inv.amount, 0);

    const priorMonthStart = new Date(priorYear, currentMonth, 1).getTime();
    const priorMonthEnd = new Date(priorYear, currentMonth, currentDay).getTime();
    const priorMtdSales = priorYearInvoices.filter((inv) => inv.issuedAt >= priorMonthStart && inv.issuedAt <= priorMonthEnd).reduce((s, inv) => s + inv.amount, 0);

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlyCurrentYear = Array.from({ length: 12 }, (_, i) => {
      const mStart = new Date(currentYear, i, 1).getTime();
      const mEnd = new Date(currentYear, i + 1, 1).getTime();
      return currentYearInvoices.filter((inv) => inv.issuedAt >= mStart && inv.issuedAt < mEnd).reduce((s, inv) => s + inv.amount, 0);
    });
    const monthlyPriorYear = Array.from({ length: 12 }, (_, i) => {
      const mStart = new Date(priorYear, i, 1).getTime();
      const mEnd = new Date(priorYear, i + 1, 1).getTime();
      return priorYearInvoices.filter((inv) => inv.issuedAt >= mStart && inv.issuedAt < mEnd).reduce((s, inv) => s + inv.amount, 0);
    });

    const allMonthlyValues = [...monthlyCurrentYear, ...monthlyPriorYear];
    const maxMonthly = Math.max(...allMonthlyValues, 1);
    const BAR_MAX_H = 120;

    const ytdChange = priorYtdSales > 0 ? ((ytdSales - priorYtdSales) / priorYtdSales * 100) : (ytdSales > 0 ? 100 : 0);

    return (
      <ScrollView style={{ flex: 1, backgroundColor: Colors.light.background }} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Pressable onPress={() => setAdminView("client-detail")} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Account Stats</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>{selectedClient.practiceName}</Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", marginHorizontal: 16, marginBottom: 12, gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: "#EDE9FE", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#6D28D9" }}>Today</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#7C3AED", marginTop: 4 }}>{formatCurrency(dailySales)}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#DBEAFE", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#1E40AF" }}>Month to Date</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#2563EB", marginTop: 4 }}>{formatCurrency(mtdSales)}</Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", marginHorizontal: 16, marginBottom: 12, gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: "#D1FAE5", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#065F46" }}>Year to Date ({currentYear})</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#059669", marginTop: 4 }}>{formatCurrency(ytdSales)}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#FEF3C7", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#92400E" }}>Prior YTD ({priorYear})</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#D97706", marginTop: 4 }}>{formatCurrency(priorYtdSales)}</Text>
          </View>
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16, backgroundColor: "#fff", borderRadius: 14, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 4 }}>YTD Comparison</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <Ionicons name={ytdChange >= 0 ? "trending-up" : "trending-down"} size={18} color={ytdChange >= 0 ? "#059669" : "#DC2626"} />
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: ytdChange >= 0 ? "#059669" : "#DC2626" }}>
              {ytdChange >= 0 ? "+" : ""}{ytdChange.toFixed(1)}% vs prior year
            </Text>
          </View>

          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: "#7C3AED" }} />
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>{currentYear}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: "#D4C5F9" }} />
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>{priorYear}</Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", height: BAR_MAX_H + 20 }}>
            {monthNames.map((name, i) => {
              const curH = maxMonthly > 0 ? (monthlyCurrentYear[i] / maxMonthly) * BAR_MAX_H : 0;
              const priH = maxMonthly > 0 ? (monthlyPriorYear[i] / maxMonthly) * BAR_MAX_H : 0;
              const isFuture = i > currentMonth;
              return (
                <View key={name} style={{ alignItems: "center", flex: 1, opacity: isFuture ? 0.3 : 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1, height: BAR_MAX_H }}>
                    <View style={{ width: 6, height: Math.max(curH, curH > 0 ? 3 : 0), backgroundColor: "#7C3AED", borderRadius: 2 }} />
                    <View style={{ width: 6, height: Math.max(priH, priH > 0 ? 3 : 0), backgroundColor: "#D4C5F9", borderRadius: 2 }} />
                  </View>
                  <Text style={{ fontSize: 8, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginTop: 4 }}>{name}</Text>
                </View>
              );
            })}
          </View>
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16, backgroundColor: "#fff", borderRadius: 14, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 12 }}>MTD Comparison</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>
              {monthNames[currentMonth]} {currentYear}: <Text style={{ fontFamily: "Inter_700Bold", color: "#2563EB" }}>{formatCurrency(mtdSales)}</Text>
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>
              {monthNames[currentMonth]} {priorYear}: <Text style={{ fontFamily: "Inter_700Bold", color: "#D97706" }}>{formatCurrency(priorMtdSales)}</Text>
            </Text>
          </View>
          {(() => {
            const mtdMax = Math.max(mtdSales, priorMtdSales, 1);
            return (
              <View style={{ gap: 8 }}>
                <View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText, width: 32 }}>{currentYear}</Text>
                    <View style={{ flex: 1, height: 24, backgroundColor: Colors.light.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                      <View style={{ height: 24, width: `${(mtdSales / mtdMax) * 100}%` as any, backgroundColor: "#2563EB", borderRadius: 6, minWidth: mtdSales > 0 ? 4 : 0 }} />
                    </View>
                  </View>
                </View>
                <View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText, width: 32 }}>{priorYear}</Text>
                    <View style={{ flex: 1, height: 24, backgroundColor: Colors.light.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                      <View style={{ height: 24, width: `${(priorMtdSales / mtdMax) * 100}%` as any, backgroundColor: "#D97706", borderRadius: 6, minWidth: priorMtdSales > 0 ? 4 : 0 }} />
                    </View>
                  </View>
                </View>
              </View>
            );
          })()}
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16, backgroundColor: "#fff", borderRadius: 14, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 12 }}>Full Year Totals</Text>
          {(() => {
            const fyMax = Math.max(ytdSales, priorFullYear, 1);
            return (
              <View style={{ gap: 8 }}>
                <View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>{currentYear} (YTD)</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#059669" }}>{formatCurrency(ytdSales)}</Text>
                  </View>
                  <View style={{ height: 28, backgroundColor: Colors.light.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                    <View style={{ height: 28, width: `${(ytdSales / fyMax) * 100}%` as any, backgroundColor: "#059669", borderRadius: 6, minWidth: ytdSales > 0 ? 4 : 0 }} />
                  </View>
                </View>
                <View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>{priorYear} (Full Year)</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#D97706" }}>{formatCurrency(priorFullYear)}</Text>
                  </View>
                  <View style={{ height: 28, backgroundColor: Colors.light.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                    <View style={{ height: 28, width: `${(priorFullYear / fyMax) * 100}%` as any, backgroundColor: "#D97706", borderRadius: 6, minWidth: priorFullYear > 0 ? 4 : 0 }} />
                  </View>
                </View>
              </View>
            );
          })()}
        </View>

        <View style={{ marginHorizontal: 16, marginBottom: 16, backgroundColor: "#fff", borderRadius: 14, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 12 }}>Invoice Count</Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1, backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{currentYearInvoices.length}</Text>
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginTop: 2 }}>{currentYear}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{priorYearInvoices.length}</Text>
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginTop: 2 }}>{priorYear}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{clientInvoices.length}</Text>
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginTop: 2 }}>All Time</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderEditTierPricing() {
    function handleSaveTier(tierId: string) {
      const prices: Record<string, number> = {};
      DEFAULT_TIER_ITEMS.forEach(item => {
        prices[item.key] = parseFloat(tierPrices[tierId]?.[item.key] || "0") || 0;
      });
      updateTierPricing(tierId, prices);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "Tier pricing has been updated.");
    }

    function handleAddNewTier() {
      if (!newTierName.trim()) {
        Alert.alert("Required", "Please enter a tier name.");
        return;
      }
      addPricingTier(newTierName.trim());
      setNewTierName("");
      setShowAddTier(false);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Tier Added", `${newTierName.trim()} pricing tier has been created.`);
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Edit Tier Pricing")}
        <View style={adm.formArea}>
          <Text style={adm.formDesc}>Manage pricing tiers and set item prices for each tier.</Text>

          {pricingTiers.map(tier => (
            <View key={tier.id} style={{ backgroundColor: "#fff", borderRadius: 14, marginBottom: 12, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2, overflow: "hidden" }}>
              <Pressable
                onPress={() => setExpandedTier(expandedTier === tier.id ? null : tier.id)}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, backgroundColor: expandedTier === tier.id ? "#F8FAFC" : "#fff" }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: "#FEF3C7", justifyContent: "center", alignItems: "center" }}>
                    <Ionicons name="layers" size={18} color="#F59E0B" />
                  </View>
                  <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{tier.name}</Text>
                </View>
                <Ionicons name={expandedTier === tier.id ? "chevron-up" : "chevron-down"} size={20} color={Colors.light.subText} />
              </Pressable>

              {expandedTier === tier.id && (
                <View style={{ padding: 16, paddingTop: 0 }}>
                  {DEFAULT_TIER_ITEMS.map(item => (
                    <View key={item.key} style={{ flexDirection: "row", alignItems: "center", marginBottom: 10, backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, padding: 12 }}>
                      <View style={{ flex: 1, marginRight: 12 }}>
                        <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text }}>{item.label}</Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 100, borderWidth: 1, borderColor: Colors.light.border }}>
                        <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.subText, marginRight: 4 }}>$</Text>
                        <TextInput
                          style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text, flex: 1, padding: 0 }}
                          value={tierPrices[tier.id]?.[item.key] || ""}
                          onChangeText={(v) => {
                            const cleaned = v.replace(/[^0-9.]/g, "");
                            setTierPrices(prev => ({ ...prev, [tier.id]: { ...prev[tier.id], [item.key]: cleaned } }));
                          }}
                          placeholder="0.00"
                          placeholderTextColor={Colors.light.textTertiary}
                          keyboardType="decimal-pad"
                        />
                      </View>
                    </View>
                  ))}
                  <Pressable
                    style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }, { marginTop: 4 }]}
                    onPress={() => handleSaveTier(tier.id)}
                  >
                    <Ionicons name="checkmark" size={20} color="#FFF" />
                    <Text style={adm.submitBtnText}>Save {tier.name} Prices</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ))}

          {showAddTier ? (
            <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginTop: 8, borderWidth: 1, borderColor: Colors.light.border, borderStyle: "dashed" }}>
              <TextInput
                style={adm.input}
                placeholder="New tier name"
                placeholderTextColor={Colors.light.textTertiary}
                value={newTierName}
                onChangeText={setNewTierName}
              />
              <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                <Pressable
                  style={({ pressed }) => [adm.submitBtn, { flex: 1 }, pressed && { opacity: 0.85 }]}
                  onPress={handleAddNewTier}
                >
                  <Ionicons name="add" size={20} color="#FFF" />
                  <Text style={adm.submitBtnText}>Add</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => ({ flex: 1, backgroundColor: Colors.light.surfaceAlt, borderRadius: 12, paddingVertical: 14, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6, opacity: pressed ? 0.85 : 1 })}
                  onPress={() => { setShowAddTier(false); setNewTierName(""); }}
                >
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 16, marginTop: 8, borderRadius: 14, borderWidth: 1.5, borderColor: Colors.light.border, borderStyle: "dashed", opacity: pressed ? 0.7 : 1 })}
              onPress={() => setShowAddTier(true)}
            >
              <Ionicons name="add-circle" size={22} color={Colors.light.subText} />
              <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>Add New Tier</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    );
  }

  function renderEditPriceList() {
    function handleUpdatePrice(key: string, value: string) {
      const cleaned = value.replace(/[^0-9.]/g, "");
      setPriceList((prev) => ({ ...prev, [key]: cleaned }));
    }

    function handleSelectTierForClient(tierName: string) {
      setSelectedTierForClient(tierName);
      const tier = pricingTiers.find(t => t.name === tierName);
      if (tier) {
        const newPrices: Record<string, string> = {};
        PRICE_LIST_ITEMS.forEach(item => {
          newPrices[item.key] = tier.prices[item.key]?.toString() || "";
        });
        setPriceList(newPrices);
      }
      if (selectedPriceClient) {
        updateClient(selectedPriceClient.id, { tier: tierName });
      }
    }

    function handleConfirmYes() {
      setPriceConfirmVisible(false);
      if (selectedPriceClient) {
        const prices: Record<string, number> = {};
        PRICE_LIST_ITEMS.forEach(item => {
          prices[item.key] = parseFloat(priceList[item.key] || "0") || 0;
        });
        updateClient(selectedPriceClient.id, { customPricing: prices });
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "Client price list has been updated.");
      setAdminView("hub");
    }

    function handleConfirmNo() {
      setPriceConfirmVisible(false);
      setAdminView("hub");
    }

    return (
      <View style={{ flex: 1 }}>
        <ScrollView
          style={styles.container}
          contentContainerStyle={{
            paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {renderBackHeader("Edit Client Price List", "client-hub")}
          <View style={adm.formArea}>
            <Text style={adm.formDesc}>Select a client and assign a pricing tier, then customize prices.</Text>

            <Pressable
              onPress={() => setShowClientPicker(true)}
              style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1, borderWidth: 1, borderColor: Colors.light.border }}
            >
              <Ionicons name="business-outline" size={20} color={Colors.light.tint} style={{ marginRight: 10 }} />
              <Text style={{ flex: 1, fontSize: 15, fontFamily: "Inter_500Medium", color: selectedPriceClient ? Colors.light.text : Colors.light.textTertiary }}>
                {selectedPriceClient ? `${selectedPriceClient.practiceName} ${formatAcctNum(selectedPriceClient.accountNumber)}` : "Select Client..."}
              </Text>
              <Ionicons name="chevron-down" size={18} color={Colors.light.subText} />
            </Pressable>

            {selectedPriceClient && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginBottom: 8 }}>Assign Tier</Text>
                <View style={adm.chipRow}>
                  {pricingTiers.map((t) => (
                    <Pressable
                      key={t.id}
                      onPress={() => handleSelectTierForClient(t.name)}
                      style={[adm.chip, selectedTierForClient === t.name && adm.chipActive]}
                    >
                      <Text style={[adm.chipText, selectedTierForClient === t.name && adm.chipTextActive]}>{t.name}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {PRICE_LIST_ITEMS.map((item) => (
              <View key={item.key} style={{ flexDirection: "row", alignItems: "center", marginBottom: 12, backgroundColor: "#fff", borderRadius: 12, padding: 14, shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text }}>{item.label}</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minWidth: 120 }}>
                  <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.subText, marginRight: 4 }}>$</Text>
                  <TextInput
                    style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text, flex: 1, padding: 0 }}
                    value={priceList[item.key]}
                    onChangeText={(v) => handleUpdatePrice(item.key, v)}
                    placeholder="0.00"
                    placeholderTextColor={Colors.light.textTertiary}
                    keyboardType="decimal-pad"
                    testID={`price-${item.key}`}
                  />
                </View>
              </View>
            ))}

            <Pressable
              style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }]}
              onPress={() => setPriceConfirmVisible(true)}
              testID="price-complete-btn"
            >
              <Ionicons name="checkmark-circle" size={20} color="#FFF" />
              <Text style={adm.submitBtnText}>Complete</Text>
            </Pressable>
          </View>
        </ScrollView>

        <Modal visible={showClientPicker} transparent animationType="fade" onRequestClose={() => setShowClientPicker(false)}>
          <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} onPress={() => setShowClientPicker(false)}>
            <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "60%", paddingTop: 16, paddingBottom: 34 }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text, textAlign: "center", marginBottom: 12 }}>Select Client</Text>
              <ScrollView>
                {clients.map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => {
                      setSelectedPriceClient(c);
                      setSelectedTierForClient(c.tier || "");
                      const tier = pricingTiers.find(t => t.name === c.tier);
                      const newPrices: Record<string, string> = {};
                      PRICE_LIST_ITEMS.forEach(item => {
                        if (c.customPricing && c.customPricing[item.key] !== undefined) {
                          newPrices[item.key] = c.customPricing[item.key].toString();
                        } else if (tier) {
                          newPrices[item.key] = tier.prices[item.key]?.toString() || "";
                        } else {
                          newPrices[item.key] = "";
                        }
                      });
                      setPriceList(newPrices);
                      setShowClientPicker(false);
                    }}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.light.border, opacity: pressed ? 0.7 : 1 })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{c.practiceName}</Text>
                      <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>{formatAcctNum(c.accountNumber)} · {cleanDoctorDisplay(c.leadDoctor)}</Text>
                    </View>
                    <View style={{ backgroundColor: "#F0F0F0", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                      <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.subText }}>{c.tier}</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>

        <Modal visible={priceConfirmVisible} transparent animationType="fade" onRequestClose={() => setPriceConfirmVisible(false)}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 24 }}>
            <View style={{ backgroundColor: "#fff", borderRadius: 20, padding: 24, width: "100%", maxWidth: 340, alignItems: "center" }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#FEF3C7", justifyContent: "center", alignItems: "center", marginBottom: 16 }}>
                <Ionicons name="help-circle" size={32} color="#D97706" />
              </View>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text, textAlign: "center", marginBottom: 8 }}>Save Price List</Text>
              <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.subText, textAlign: "center", marginBottom: 24 }}>Are you sure you want to save these prices?</Text>

              <Pressable
                onPress={handleConfirmYes}
                style={({ pressed }) => ({ backgroundColor: Colors.light.tint, borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center", marginBottom: 10, opacity: pressed ? 0.85 : 1 })}
                testID="price-confirm-yes"
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Yes</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmNo}
                style={({ pressed }) => ({ backgroundColor: Colors.light.error, borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center", marginBottom: 10, opacity: pressed ? 0.85 : 1 })}
                testID="price-confirm-no"
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" }}>No</Text>
              </Pressable>
              <Pressable
                onPress={() => setPriceConfirmVisible(false)}
                style={({ pressed }) => ({ backgroundColor: Colors.light.surfaceAlt, borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center", opacity: pressed ? 0.85 : 1 })}
                testID="price-confirm-continue"
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>Continue Editing</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  function renderSales() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

    let periodStart = monthStart;
    let periodEnd = Date.now();
    let periodLabel = "Month to Date";

    if (salesPeriod === "daily") {
      periodStart = todayStart;
      periodLabel = "Today";
    } else if (salesPeriod === "ytd") {
      periodStart = yearStart;
      periodLabel = "Year to Date";
    } else if (salesPeriod === "custom") {
      periodLabel = "Custom Range";
      if (salesCustomStart) {
        const parsed = new Date(salesCustomStart);
        if (!isNaN(parsed.getTime())) periodStart = parsed.getTime();
      }
      if (salesCustomEnd) {
        const parsed = new Date(salesCustomEnd);
        if (!isNaN(parsed.getTime())) periodEnd = parsed.getTime() + 86400000;
      }
    }

    const periodCases = cases.filter(c => c.createdAt >= periodStart && c.createdAt <= periodEnd);
    const periodInvoices = invoices.filter(i => i.issuedAt >= periodStart && i.issuedAt <= periodEnd);

    const completedCases = periodCases.filter((c) => c.status === "COMPLETE" || c.status === "SHIP");
    const activeCases = periodCases.filter((c) => c.status !== "COMPLETE" && c.status !== "SHIP");
    const completedRevenue = completedCases.reduce((s, c) => s + c.price, 0);
    const activeRevenue = activeCases.reduce((s, c) => s + c.price, 0);
    const periodRevenue = periodCases.reduce((s, c) => s + c.price, 0);
    const paidInvoices = periodInvoices.filter((i) => i.status === "paid");
    const collectedAmount = paidInvoices.reduce((s, i) => s + i.amount, 0);

    const materialBreakdown: { [key: string]: { count: number; revenue: number } } = {};
    periodCases.forEach((c) => {
      if (!materialBreakdown[c.material]) materialBreakdown[c.material] = { count: 0, revenue: 0 };
      materialBreakdown[c.material].count++;
      materialBreakdown[c.material].revenue += c.price;
    });

    const materialColors: { [key: string]: string } = {
      "Zirconia": Colors.light.tint,
      "E.max": "#8B5CF6",
      "PFM": Colors.light.warning,
      "Gold": "#F59E0B",
    };

    const periods: { key: typeof salesPeriod; label: string }[] = [
      { key: "daily", label: "Daily" },
      { key: "mtd", label: "MTD" },
      { key: "ytd", label: "YTD" },
      { key: "custom", label: "Custom" },
    ];

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Sales", "financial-hub")}
        <View style={adm.listArea}>
          <View style={{ flexDirection: "row", backgroundColor: Colors.light.surfaceSecondary, borderRadius: 12, padding: 3, marginBottom: 16 }}>
            {periods.map(p => (
              <Pressable
                key={p.key}
                onPress={() => setSalesPeriod(p.key)}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 10,
                  alignItems: "center",
                  backgroundColor: salesPeriod === p.key ? Colors.light.surface : "transparent",
                  shadowColor: salesPeriod === p.key ? "#000" : "transparent",
                  shadowOpacity: salesPeriod === p.key ? 0.06 : 0,
                  shadowRadius: 4,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: salesPeriod === p.key ? 2 : 0,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={{ fontSize: 13, fontFamily: salesPeriod === p.key ? "Inter_700Bold" : "Inter_500Medium", color: salesPeriod === p.key ? Colors.light.tint : Colors.light.textSecondary }}>{p.label}</Text>
              </Pressable>
            ))}
          </View>

          {salesPeriod === "custom" && (
            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 4 }}>Start Date</Text>
                <TextInput
                  style={{ backgroundColor: Colors.light.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text, borderWidth: 1, borderColor: Colors.light.border }}
                  placeholder="MM/DD/YYYY"
                  placeholderTextColor={Colors.light.textTertiary}
                  value={salesCustomStart}
                  onChangeText={setSalesCustomStart}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 4 }}>End Date</Text>
                <TextInput
                  style={{ backgroundColor: Colors.light.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text, borderWidth: 1, borderColor: Colors.light.border }}
                  placeholder="MM/DD/YYYY"
                  placeholderTextColor={Colors.light.textTertiary}
                  value={salesCustomEnd}
                  onChangeText={setSalesCustomEnd}
                />
              </View>
            </View>
          )}

          <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 12 }}>{periodLabel} · {periodCases.length} cases</Text>

          <View style={adm.salesGrid}>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Total Revenue</Text>
              <Text style={adm.salesCardValue}>{formatCurrency(periodRevenue)}</Text>
            </View>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Collected</Text>
              <Text style={[adm.salesCardValue, { color: Colors.light.success }]}>{formatCurrency(collectedAmount)}</Text>
            </View>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Open Invoices</Text>
              <Text style={[adm.salesCardValue, { color: Colors.light.tint }]}>{formatCurrency(activeRevenue)}</Text>
            </View>
          </View>

          <Text style={adm.salesSectionTitle}>Revenue by Material</Text>
          {Object.entries(materialBreakdown).length > 0 ? Object.entries(materialBreakdown).map(([mat, data]) => {
            const pct = periodRevenue > 0 ? (data.revenue / periodRevenue) * 100 : 0;
            const color = materialColors[mat] || Colors.light.textSecondary;
            return (
              <View key={mat} style={adm.materialRow}>
                <View style={adm.materialInfo}>
                  <View style={[adm.materialDot, { backgroundColor: color }]} />
                  <Text style={adm.materialName}>{mat}</Text>
                  <Text style={adm.materialCount}>{data.count} cases</Text>
                </View>
                <View style={adm.materialBarWrap}>
                  <View style={[adm.materialBar, { width: `${Math.max(pct, 4)}%`, backgroundColor: color }]} />
                </View>
                <Text style={adm.materialRevenue}>{formatCurrency(data.revenue)}</Text>
              </View>
            );
          }) : (
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", paddingVertical: 20 }}>No cases in this period</Text>
          )}

          <Text style={[adm.salesSectionTitle, { marginTop: 24 }]}>Top Clients by Revenue</Text>
          {clients.map((c) => {
            const clientCases = periodCases.filter((cs) => cs.doctorName === c.leadDoctor);
            const rev = clientCases.reduce((s, cs) => s + cs.price, 0);
            if (rev === 0) return null;
            return (
              <View key={c.id} style={adm.clientRevenueRow}>
                <View style={adm.listItemLeft}>
                  <View style={[adm.listAvatar, { backgroundColor: Colors.light.surfaceSecondary }]}>
                    <Text style={[adm.listAvatarText, { color: Colors.light.textSecondary }]}>{c.practiceName.charAt(0)}</Text>
                  </View>
                  <View>
                    <Text style={adm.listItemTitle}>{c.practiceName}</Text>
                    <Text style={adm.listItemSub}>ID: {c.clientNumber} · {clientCases.length} cases</Text>
                  </View>
                </View>
                <Text style={adm.clientRevenueAmount}>{formatCurrency(rev)}</Text>
              </View>
            );
          }).filter(Boolean)}

          {(() => {
            const openPeriodInvoices = periodInvoices.filter(i => i.status === "open" || i.status === "sent" || i.status === "overdue");
            return (
              <>
                <Text style={[adm.salesSectionTitle, { marginTop: 24 }]}>Open Invoices ({openPeriodInvoices.length})</Text>
                {openPeriodInvoices.length > 0 ? openPeriodInvoices.map((inv) => {
                  const isOverdue = inv.status === "overdue" || (inv.dueAt < Date.now() && inv.status !== "paid");
                  return (
                    <Pressable
                      key={inv.id}
                      onPress={() => {
                        setSelectedInvoice(inv);
                        setAdminView("invoices");
                      }}
                      style={({ pressed }) => ({
                        backgroundColor: Colors.light.surface,
                        borderRadius: 12,
                        padding: 14,
                        marginBottom: 8,
                        borderWidth: 1,
                        borderColor: isOverdue ? Colors.light.errorLight : Colors.light.border,
                        opacity: pressed ? 0.85 : 1,
                      })}
                    >
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                        <View style={{ flex: 1, marginRight: 12 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 }}>
                            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                            {isOverdue && (
                              <View style={{ backgroundColor: Colors.light.errorLight, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: Colors.light.error }}>OVERDUE</Text>
                              </View>
                            )}
                          </View>
                          <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }} numberOfLines={1}>{inv.clientName}</Text>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 2 }}>
                            {inv.patientName ? `Patient: ${inv.patientName} · ` : ""}Due: {new Date(inv.dueAt).toLocaleDateString()}
                          </Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: isOverdue ? Colors.light.error : Colors.light.tint }}>{formatCurrency(inv.amount)}</Text>
                          <Ionicons name="chevron-forward" size={16} color={Colors.light.textTertiary} style={{ marginTop: 4 }} />
                        </View>
                      </View>
                    </Pressable>
                  );
                }) : (
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", paddingVertical: 20 }}>No open invoices in this period</Text>
                )}
              </>
            );
          })()}
        </View>
      </ScrollView>
    );
  }

  function renderShipping() {
    function handleAddShipping() {
      if (!newShipCompany.trim() || !newShipAccount.trim()) {
        Alert.alert("Required", "Company name and account number are required.");
        return;
      }
      addShippingAccount(newShipCompany.trim(), newShipAccount.trim());
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Account Added", `${newShipCompany.trim()} shipping account has been added.`);
      setNewShipCompany("");
      setNewShipAccount("");
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Shipping Accounts")}
        <View style={adm.formArea}>
          <Text style={adm.formDesc}>Connect carrier accounts for shipping labels.</Text>

          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Shipping Company Name</Text>
            <TextInput
              style={adm.input}
              value={newShipCompany}
              onChangeText={setNewShipCompany}
              placeholder="UPS, FedEx, DHL"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Account Number</Text>
            <TextInput
              style={adm.input}
              value={newShipAccount}
              onChangeText={setNewShipAccount}
              placeholder="Enter account number"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>

          <Pressable
            style={({ pressed }) => [adm.submitBtn, { backgroundColor: "#6366F1" }, pressed && { opacity: 0.85 }]}
            onPress={handleAddShipping}
          >
            <Ionicons name="add" size={20} color="#FFF" />
            <Text style={adm.submitBtnText}>Add Account</Text>
          </Pressable>
        </View>

        {shippingAccounts.length > 0 && (
          <View style={adm.listArea}>
            <Text style={adm.formDesc}>{shippingAccounts.length} connected account{shippingAccounts.length !== 1 ? "s" : ""}</Text>
            {shippingAccounts.map((acc) => (
              <View key={acc.id} style={adm.listItem}>
                <View style={adm.listItemLeft}>
                  <View style={[adm.listAvatar, { backgroundColor: "#E0E7FF" }]}>
                    <Ionicons name="airplane" size={18} color="#6366F1" />
                  </View>
                  <View>
                    <Text style={adm.listItemTitle}>{acc.companyName}</Text>
                    <Text style={adm.listItemSub}>****{acc.accountNumber.slice(-4)}</Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => {
                    Alert.alert(
                      "Remove Account",
                      `Remove ${acc.companyName} shipping account?`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () => {
                            removeShippingAccount(acc.id);
                            if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          },
                        },
                      ],
                    );
                  }}
                  style={({ pressed }) => [{ padding: 8 }, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="trash-outline" size={20} color={Colors.light.error} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  function renderInventory() {
    const categories = [...new Set(inventory.map(i => i.category))];
    const filteredItems = invCategory === "All" ? inventory : inventory.filter(i => i.category === invCategory);
    const lowStockCount = inventory.filter(i => i.quantity <= i.minQuantity).length;

    function handleAddInvItem() {
      if (!newInvName.trim()) {
        Alert.alert("Required", "Item name is required.");
        return;
      }
      const qty = parseInt(newInvQty) || 0;
      const minQty = parseInt(newInvMinQty) || 0;
      addInventoryItem({
        name: newInvName.trim(),
        category: newInvCategory,
        quantity: qty,
        minQuantity: minQty,
        unit: newInvUnit.trim() || "pcs",
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setNewInvName("");
      setNewInvQty("");
      setNewInvMinQty("");
      setNewInvUnit("pcs");
      setNewInvCategory("Materials");
      setShowAddInv(false);
    }

    function getStockColor(item: InventoryItem) {
      if (item.quantity < item.minQuantity) return "#EF4444";
      if (item.quantity === item.minQuantity) return "#F59E0B";
      return "#10B981";
    }

    function getStockBg(item: InventoryItem) {
      if (item.quantity < item.minQuantity) return "#FEF2F2";
      if (item.quantity === item.minQuantity) return "#FFFBEB";
      return "#F0FDF4";
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Inventory", "financial-hub")}

        <View style={{ paddingHorizontal: 20, marginBottom: 16 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={[invStyles.summaryCard, { flex: 1, backgroundColor: "#F0FDF4" }]}>
              <Ionicons name="cube" size={22} color="#10B981" />
              <Text style={[invStyles.summaryNum, { color: "#10B981" }]}>{inventory.length}</Text>
              <Text style={invStyles.summaryLabel}>Total Items</Text>
            </View>
            <View style={[invStyles.summaryCard, { flex: 1, backgroundColor: lowStockCount > 0 ? "#FEF2F2" : "#F0FDF4" }]}>
              <Ionicons name="warning" size={22} color={lowStockCount > 0 ? "#EF4444" : "#10B981"} />
              <Text style={[invStyles.summaryNum, { color: lowStockCount > 0 ? "#EF4444" : "#10B981" }]}>{lowStockCount}</Text>
              <Text style={invStyles.summaryLabel}>Low Stock</Text>
            </View>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, marginBottom: 16 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {["All", ...categories].map(cat => (
              <Pressable
                key={cat}
                onPress={() => setInvCategory(cat)}
                style={[adm.chip, invCategory === cat && adm.chipActive]}
              >
                <Text style={[adm.chipText, invCategory === cat && adm.chipTextActive]}>{cat}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={adm.listArea}>
          {filteredItems.map(item => (
            <Pressable
              key={item.id}
              style={({ pressed }) => [adm.listItem, pressed && { opacity: 0.7 }]}
              onPress={() => {
                setEditingInvItem(item);
                setEditInvQty(item.quantity.toString());
              }}
            >
              <View style={adm.listItemLeft}>
                <View style={[adm.listAvatar, { backgroundColor: getStockBg(item) }]}>
                  <Ionicons name="cube-outline" size={20} color={getStockColor(item)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={adm.listItemTitle}>{item.name}</Text>
                  <Text style={adm.listItemSub}>{item.category} · Min: {item.minQuantity} {item.unit}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation?.();
                    if (item.quantity > 0) {
                      updateInventoryItem(item.id, { quantity: item.quantity - 1 });
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }
                  }}
                  style={invStyles.qtyBtn}
                >
                  <Ionicons name="remove" size={16} color={Colors.light.textSecondary} />
                </Pressable>
                <View style={[invStyles.qtyBadge, { backgroundColor: getStockBg(item) }]}>
                  <Text style={[invStyles.qtyText, { color: getStockColor(item) }]}>{item.quantity}</Text>
                </View>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation?.();
                    updateInventoryItem(item.id, { quantity: item.quantity + 1 });
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  style={invStyles.qtyBtn}
                >
                  <Ionicons name="add" size={16} color={Colors.light.textSecondary} />
                </Pressable>
              </View>
            </Pressable>
          ))}

          {filteredItems.length === 0 && (
            <View style={{ alignItems: "center", paddingVertical: 40 }}>
              <Ionicons name="cube-outline" size={36} color={Colors.light.textTertiary} />
              <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 8 }}>No items in this category</Text>
            </View>
          )}
        </View>

        <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
          <Pressable
            onPress={() => setShowAddInv(true)}
            style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="add" size={20} color="#FFF" />
            <Text style={adm.submitBtnText}>Add Item</Text>
          </Pressable>
        </View>

        <Modal
          transparent
          visible={showAddInv}
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setShowAddInv(false)}
        >
          <Pressable style={styles.picModalOverlay} onPress={() => setShowAddInv(false)}>
            <Pressable style={invStyles.modalContent} onPress={(e) => e.stopPropagation?.()}>
              <View style={styles.picModalHandle} />
              <Text style={[styles.picModalTitle, { marginBottom: 16 }]}>Add Inventory Item</Text>

              <View style={adm.field}>
                <Text style={adm.fieldLabel}>Name</Text>
                <TextInput
                  style={adm.input}
                  value={newInvName}
                  onChangeText={setNewInvName}
                  placeholder="Item name"
                  placeholderTextColor={Colors.light.textTertiary}
                />
              </View>

              <View style={adm.field}>
                <Text style={adm.fieldLabel}>Category</Text>
                <View style={adm.chipRow}>
                  {["Materials", "Supplies", "Tools"].map(cat => (
                    <Pressable
                      key={cat}
                      onPress={() => setNewInvCategory(cat)}
                      style={[adm.chip, newInvCategory === cat && adm.chipActive]}
                    >
                      <Text style={[adm.chipText, newInvCategory === cat && adm.chipTextActive]}>{cat}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={adm.fieldRow}>
                <View style={[adm.field, { flex: 1 }]}>
                  <Text style={adm.fieldLabel}>Quantity</Text>
                  <TextInput
                    style={adm.input}
                    value={newInvQty}
                    onChangeText={setNewInvQty}
                    placeholder="0"
                    placeholderTextColor={Colors.light.textTertiary}
                    keyboardType="numeric"
                  />
                </View>
                <View style={[adm.field, { flex: 1 }]}>
                  <Text style={adm.fieldLabel}>Min Qty</Text>
                  <TextInput
                    style={adm.input}
                    value={newInvMinQty}
                    onChangeText={setNewInvMinQty}
                    placeholder="0"
                    placeholderTextColor={Colors.light.textTertiary}
                    keyboardType="numeric"
                  />
                </View>
              </View>

              <View style={adm.field}>
                <Text style={adm.fieldLabel}>Unit</Text>
                <TextInput
                  style={adm.input}
                  value={newInvUnit}
                  onChangeText={setNewInvUnit}
                  placeholder="pcs"
                  placeholderTextColor={Colors.light.textTertiary}
                />
              </View>

              <Pressable
                onPress={handleAddInvItem}
                style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.8 }]}
              >
                <Ionicons name="checkmark" size={20} color="#FFF" />
                <Text style={adm.submitBtnText}>Add Item</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          transparent
          visible={editingInvItem !== null}
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setEditingInvItem(null)}
        >
          <Pressable style={styles.picModalOverlay} onPress={() => setEditingInvItem(null)}>
            <Pressable style={invStyles.modalContent} onPress={(e) => e.stopPropagation?.()}>
              <View style={styles.picModalHandle} />
              <Text style={[styles.picModalTitle, { marginBottom: 4 }]}>{editingInvItem?.name}</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginBottom: 16 }}>
                {editingInvItem?.category} · {editingInvItem?.unit}
              </Text>

              <View style={adm.field}>
                <Text style={adm.fieldLabel}>Quantity</Text>
                <TextInput
                  style={adm.input}
                  value={editInvQty}
                  onChangeText={setEditInvQty}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={Colors.light.textTertiary}
                />
              </View>

              <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
                <Pressable
                  onPress={() => {
                    if (editingInvItem) {
                      const newQty = parseInt(editInvQty) || 0;
                      updateInventoryItem(editingInvItem.id, { quantity: newQty });
                      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setEditingInvItem(null);
                    }
                  }}
                  style={({ pressed }) => [adm.submitBtn, { flex: 1 }, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="checkmark" size={20} color="#FFF" />
                  <Text style={adm.submitBtnText}>Update</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (editingInvItem) {
                      Alert.alert(
                        "Remove Item",
                        `Remove ${editingInvItem.name} from inventory?`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Remove",
                            style: "destructive",
                            onPress: () => {
                              removeInventoryItem(editingInvItem.id);
                              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                              setEditingInvItem(null);
                            },
                          },
                        ],
                      );
                    }
                  }}
                  style={({ pressed }) => [invStyles.deleteBtn, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="trash-outline" size={20} color="#EF4444" />
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </ScrollView>
    );
  }

  function renderEditLocations() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Edit Locations")}

        <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
          <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>
            Rename workflow stations to match your lab. Changes apply everywhere in the app.
          </Text>
        </View>

        {STATIONS.map((station) => {
          const currentLabel = customStationLabels[station.id] || station.label;
          return (
            <View key={station.id} style={{ paddingHorizontal: 20, marginBottom: 10 }}>
              <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 14 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: station.color }} />
                  <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {station.id.replace(/_/g, " ")}
                  </Text>
                </View>
                <TextInput
                  style={{
                    fontSize: 15,
                    fontFamily: "Inter_600SemiBold",
                    color: Colors.light.text,
                    backgroundColor: Colors.light.surfaceSecondary,
                    borderRadius: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderWidth: 1,
                    borderColor: Colors.light.border,
                  }}
                  value={currentLabel}
                  onChangeText={(text) => updateStationLabel(station.id, text)}
                  placeholder={station.label}
                  placeholderTextColor={Colors.light.textTertiary}
                />
              </View>
            </View>
          );
        })}
      </ScrollView>
    );
  }

  function renderPaymentProcessing() {
    const paymentCards = [
      { icon: "card-outline" as const, color: "#7C3AED", bg: "#F3E8FF", title: "Process Payment", sub: "Accept and process new payments" },
      { icon: "time-outline" as const, color: "#0EA5E9", bg: "#E0F2FE", title: "Payment History", sub: "View past transactions" },
      { icon: "return-down-back-outline" as const, color: "#EF4444", bg: "#FEF2F2", title: "Refunds", sub: "Issue and manage refunds" },
    ];

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Payment Processing", "financial-hub")}

        <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
          <LinearGradient
            colors={["#7C3AED", "#6D28D9"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: 16, padding: 20, alignItems: "center" }}
          >
            <Ionicons name="card" size={36} color="#FFF" style={{ marginBottom: 8 }} />
            <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold", marginBottom: 4 }}>Payment Processing</Text>
            <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" }}>Payment processing features coming soon</Text>
          </LinearGradient>
        </View>

        <View style={adm.menuSection}>
          {paymentCards.map((item) => (
            <Pressable
              key={item.title}
              style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => {
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                Alert.alert(item.title, "This feature is coming soon.");
              }}
            >
              <View style={[adm.menuIcon, { backgroundColor: item.bg }]}>
                <Ionicons name={item.icon} size={20} color={item.color} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{item.title}</Text>
                <Text style={adm.menuSub}>{item.sub}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderARAgingReport() {
    const today = Date.now();
    const MS_DAY = 86400000;
    const unpaid = invoices.filter(i => i.status === "open" || i.status === "overdue" || i.status === "sent");

    const clientMap: Record<string, { name: string; buckets: [number, number, number, number] }> = {};
    unpaid.forEach(inv => {
      const daysLate = Math.floor((today - inv.dueAt) / MS_DAY);
      if (!clientMap[inv.clientId]) clientMap[inv.clientId] = { name: inv.clientName || inv.billTo || "Unknown", buckets: [0, 0, 0, 0] };
      const b = clientMap[inv.clientId].buckets;
      if (daysLate <= 30) b[0] += inv.amount;
      else if (daysLate <= 60) b[1] += inv.amount;
      else if (daysLate <= 90) b[2] += inv.amount;
      else b[3] += inv.amount;
    });

    const rows = Object.values(clientMap).sort((a, b) => (b.buckets[3] + b.buckets[2]) - (a.buckets[3] + a.buckets[2]));
    const totals: [number, number, number, number] = [0, 0, 0, 0];
    rows.forEach(r => r.buckets.forEach((v, i) => (totals[i] += v)));
    const grandTotal = totals.reduce((s, v) => s + v, 0);
    const bucketHeaders = ["Current\n(0–30)", "31–60\nDays", "61–90\nDays", "90+\nDays"];
    const bucketColors = ["#059669", "#D97706", "#EF4444", "#7C2D12"];

    const colW = [0, 52, 52, 52, 52];

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 24 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("A/R Aging Summary", "financial-hub")}

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
          <LinearGradient colors={["#1E3A5F", "#1D4ED8"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 16 }}>
            <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.65)", letterSpacing: 1 }}>TOTAL OUTSTANDING</Text>
            <Text style={{ fontSize: 32, fontFamily: "Inter_700Bold", color: "#fff", marginTop: 4 }}>{formatCurrency(grandTotal)}</Text>
            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", marginTop: 4 }}>{rows.length} client{rows.length !== 1 ? "s" : ""} with open balances</Text>
          </LinearGradient>

          <View style={{ flexDirection: "row", paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F1F5F9", backgroundColor: "#F8FAFC" }}>
            <Text style={{ flex: 1, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569" }}>CLIENT</Text>
            {bucketHeaders.map((h, i) => (
              <Text key={i} style={{ width: colW[i + 1] as number, fontSize: 10, fontFamily: "Inter_700Bold", color: bucketColors[i], textAlign: "right" }}>{h}</Text>
            ))}
            <Text style={{ width: 60, fontSize: 10, fontFamily: "Inter_700Bold", color: "#1E293B", textAlign: "right" }}>TOTAL</Text>
          </View>

          {rows.length === 0 && (
            <View style={{ padding: 32, alignItems: "center" }}>
              <Ionicons name="checkmark-circle" size={40} color="#10B981" />
              <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#065F46", marginTop: 8 }}>All Caught Up!</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#6B7280", marginTop: 4 }}>No outstanding balances.</Text>
            </View>
          )}

          {rows.map((row, idx) => {
            const rowTotal = row.buckets.reduce((s, v) => s + v, 0);
            return (
              <View key={idx} style={{ flexDirection: "row", paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F1F5F9", backgroundColor: idx % 2 === 0 ? "#fff" : "#FAFBFC" }}>
                <Text style={{ flex: 1, fontSize: 12, fontFamily: "Inter_500Medium", color: "#111827" }} numberOfLines={1}>{row.name}</Text>
                {row.buckets.map((v, i) => (
                  <Text key={i} style={{ width: colW[i + 1] as number, fontSize: 11, fontFamily: v > 0 ? "Inter_600SemiBold" : "Inter_400Regular", color: v > 0 ? bucketColors[i] : "#D1D5DB", textAlign: "right" }}>{v > 0 ? formatCurrency(v) : "–"}</Text>
                ))}
                <Text style={{ width: 60, fontSize: 12, fontFamily: "Inter_700Bold", color: "#111827", textAlign: "right" }}>{formatCurrency(rowTotal)}</Text>
              </View>
            );
          })}

          <View style={{ flexDirection: "row", paddingHorizontal: 10, paddingVertical: 12, backgroundColor: "#1E3A5F" }}>
            <Text style={{ flex: 1, fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff" }}>TOTAL</Text>
            {totals.map((v, i) => (
              <Text key={i} style={{ width: colW[i + 1] as number, fontSize: 11, fontFamily: "Inter_700Bold", color: "#fff", textAlign: "right" }}>{v > 0 ? formatCurrency(v) : "–"}</Text>
            ))}
            <Text style={{ width: 60, fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff", textAlign: "right" }}>{formatCurrency(grandTotal)}</Text>
          </View>
        </View>

        <View style={{ marginHorizontal: 16, flexDirection: "row", gap: 8, marginBottom: 16 }}>
          {bucketHeaders.map((h, i) => (
            <View key={i} style={{ flex: 1, backgroundColor: "#fff", borderRadius: 10, padding: 10, borderWidth: 1, borderColor: "#E5E7EB", alignItems: "center" }}>
              <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: bucketColors[i], textAlign: "center" }}>{h.replace("\n", " ")}</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: totals[i] > 0 ? bucketColors[i] : "#9CA3AF", marginTop: 4 }}>{totals[i] > 0 ? formatCurrency(totals[i]) : "–"}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderPLReport() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const q = Math.floor(now.getMonth() / 3);
    const qtdStart = new Date(now.getFullYear(), q * 3, 1).getTime();
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

    let pStart = yearStart;
    let pEnd = Date.now();
    let pLabel = "Year to Date";
    if (plPeriod === "mtd") { pStart = monthStart; pLabel = "Month to Date"; }
    else if (plPeriod === "qtd") { pStart = qtdStart; pLabel = "Quarter to Date"; }
    else if (plPeriod === "custom") {
      pLabel = "Custom Range";
      if (plCustomStart) { const p = new Date(plCustomStart); if (!isNaN(p.getTime())) pStart = p.getTime(); }
      if (plCustomEnd) { const p = new Date(plCustomEnd); if (!isNaN(p.getTime())) pEnd = p.getTime() + 86400000; }
    }

    const periodInvoices = invoices.filter(i => i.issuedAt >= pStart && i.issuedAt <= pEnd);
    const totalBilled = periodInvoices.reduce((s, i) => s + i.amount, 0);
    const collected = periodInvoices.filter(i => i.status === "paid").reduce((s, i) => s + i.amount, 0);
    const outstanding = periodInvoices.filter(i => i.status !== "paid").reduce((s, i) => s + i.amount, 0);
    const creditsMemo = periodInvoices.reduce((s, i) => s + (i.credits || 0), 0);

    const monthlyMap: Record<string, { billed: number; collected: number }> = {};
    periodInvoices.forEach(inv => {
      const d = new Date(inv.issuedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = { billed: 0, collected: 0 };
      monthlyMap[key].billed += inv.amount;
      if (inv.status === "paid") monthlyMap[key].collected += inv.amount;
    });
    const months = Object.keys(monthlyMap).sort();
    const maxBilled = Math.max(...months.map(m => monthlyMap[m].billed), 1);

    const pills: { label: string; val: "mtd" | "qtd" | "ytd" | "custom" }[] = [
      { label: "MTD", val: "mtd" }, { label: "QTD", val: "qtd" }, { label: "YTD", val: "ytd" }, { label: "Custom", val: "custom" },
    ];

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 24 : 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {renderBackHeader("Profit & Loss", "financial-hub")}

        <View style={{ flexDirection: "row", marginHorizontal: 16, marginBottom: 12, gap: 6 }}>
          {pills.map(p => (
            <Pressable key={p.val} onPress={() => setPlPeriod(p.val)}
              style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: plPeriod === p.val ? "#1D4ED8" : "#fff", borderWidth: 1, borderColor: plPeriod === p.val ? "#1D4ED8" : "#E5E7EB", alignItems: "center" }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: plPeriod === p.val ? "#fff" : "#6B7280" }}>{p.label}</Text>
            </Pressable>
          ))}
        </View>

        {plPeriod === "custom" && (
          <View style={{ flexDirection: "row", marginHorizontal: 16, marginBottom: 12, gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#6B7280", marginBottom: 4 }}>Start Date</Text>
              <TextInput style={{ borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 8, padding: 8, fontSize: 13, fontFamily: "Inter_400Regular", backgroundColor: "#fff" }} value={plCustomStart} onChangeText={setPlCustomStart} placeholder="YYYY-MM-DD" placeholderTextColor="#9CA3AF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#6B7280", marginBottom: 4 }}>End Date</Text>
              <TextInput style={{ borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 8, padding: 8, fontSize: 13, fontFamily: "Inter_400Regular", backgroundColor: "#fff" }} value={plCustomEnd} onChangeText={setPlCustomEnd} placeholder="YYYY-MM-DD" placeholderTextColor="#9CA3AF" />
            </View>
          </View>
        )}

        <LinearGradient colors={["#1E3A5F", "#1D4ED8"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ marginHorizontal: 16, borderRadius: 14, padding: 18, marginBottom: 12 }}>
          <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.6)", letterSpacing: 1 }}>{pLabel.toUpperCase()}</Text>
          <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2, marginBottom: 10 }}>{periodInvoices.length} invoice{periodInvoices.length !== 1 ? "s" : ""}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 10, padding: 10 }}>
              <Text style={{ fontSize: 9, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.65)" }}>TOTAL BILLED</Text>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#fff", marginTop: 4 }}>{formatCurrency(totalBilled)}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "rgba(16,185,129,0.3)", borderRadius: 10, padding: 10 }}>
              <Text style={{ fontSize: 9, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.65)" }}>COLLECTED</Text>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#6EE7B7", marginTop: 4 }}>{formatCurrency(collected)}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "rgba(239,68,68,0.25)", borderRadius: 10, padding: 10 }}>
              <Text style={{ fontSize: 9, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.65)" }}>OUTSTANDING</Text>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FCA5A5", marginTop: 4 }}>{formatCurrency(outstanding)}</Text>
            </View>
          </View>
        </LinearGradient>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
          <View style={{ backgroundColor: "#F8FAFC", borderBottomWidth: 1, borderBottomColor: "#E2E8F0", padding: 14 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#1E293B" }}>INCOME</Text>
          </View>
          <View style={{ padding: 14, gap: 0 }}>
            {[
              { label: "Total Revenue (Billed)", val: totalBilled, color: "#111827" },
              { label: "Credits / Memos Applied", val: -creditsMemo, color: "#D97706" },
              { label: "Net Revenue", val: totalBilled - creditsMemo, color: "#059669", bold: true },
            ].map((row, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: i < 2 ? 1 : 0, borderBottomColor: "#F1F5F9" }}>
                <Text style={{ fontSize: 13, fontFamily: row.bold ? "Inter_700Bold" : "Inter_400Regular", color: "#374151" }}>{row.label}</Text>
                <Text style={{ fontSize: 13, fontFamily: row.bold ? "Inter_700Bold" : "Inter_500Medium", color: row.color }}>{formatCurrency(Math.abs(row.val))}{row.val < 0 ? " CR" : ""}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
          <View style={{ backgroundColor: "#F8FAFC", borderBottomWidth: 1, borderBottomColor: "#E2E8F0", padding: 14 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#1E293B" }}>COLLECTIONS</Text>
          </View>
          <View style={{ padding: 14, gap: 0 }}>
            {[
              { label: "Collected (Paid Invoices)", val: collected, color: "#059669" },
              { label: "Outstanding A/R", val: outstanding, color: "#DC2626" },
              { label: "Collection Rate", val: totalBilled > 0 ? ((collected / totalBilled) * 100).toFixed(1) + "%" : "0%", isText: true, color: "#1D4ED8" },
            ].map((row, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: i < 2 ? 1 : 0, borderBottomColor: "#F1F5F9" }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#374151" }}>{row.label}</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: row.color }}>{(row as any).isText ? (row.val as string) : formatCurrency(row.val as number)}</Text>
              </View>
            ))}
          </View>
        </View>

        {months.length > 0 && (
          <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 16 }}>
            <View style={{ backgroundColor: "#F8FAFC", borderBottomWidth: 1, borderBottomColor: "#E2E8F0", padding: 14 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#1E293B" }}>MONTHLY BREAKDOWN</Text>
            </View>
            {months.map((mo, i) => {
              const d = monthlyMap[mo];
              const barW = (d.billed / maxBilled) * 100;
              const colW2 = (d.collected / maxBilled) * 100;
              const [yr, mn] = mo.split("-");
              const label = new Date(Number(yr), Number(mn) - 1, 1).toLocaleString("default", { month: "short", year: "2-digit" });
              return (
                <View key={mo} style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: i < months.length - 1 ? 1 : 0, borderBottomColor: "#F1F5F9" }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#374151" }}>{label}</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#111827" }}>{formatCurrency(d.billed)}</Text>
                  </View>
                  <View style={{ height: 6, backgroundColor: "#F1F5F9", borderRadius: 3, marginBottom: 2 }}>
                    <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${barW}%` as any, backgroundColor: "#BFDBFE", borderRadius: 3 }} />
                    <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${colW2}%` as any, backgroundColor: "#1D4ED8", borderRadius: 3 }} />
                  </View>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#6B7280" }}>Collected: {formatCurrency(d.collected)}</Text>
                </View>
              );
            })}
          </View>
        )}

        <View style={{ marginHorizontal: 16, backgroundColor: "#FEF3C7", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#FDE68A", marginBottom: 16, flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Ionicons name="construct-outline" size={20} color="#D97706" />
          <Text style={{ flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: "#92400E" }}>Expense tracking is coming soon. Once available, your full P&amp;L with COGS and net profit will appear here.</Text>
        </View>
      </ScrollView>
    );
  }

  function renderSalesByItem() {
    const itemMap: Record<string, { count: number; total: number }> = {};
    invoices.forEach(inv => {
      inv.lineItems.forEach(li => {
        const key = li.item.trim() || li.description.trim() || "Unlabeled";
        if (!itemMap[key]) itemMap[key] = { count: 0, total: 0 };
        itemMap[key].count += li.qty;
        itemMap[key].total += li.amount;
      });
    });

    const rows = Object.entries(itemMap)
      .map(([item, data]) => ({ item, ...data }))
      .sort((a, b) => b.total - a.total);

    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    const grandCount = rows.reduce((s, r) => s + r.count, 0);

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 24 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Sales by Item", "financial-hub")}

        <LinearGradient colors={["#1E3A5F", "#1D4ED8"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ marginHorizontal: 16, borderRadius: 14, padding: 18, marginBottom: 12 }}>
          <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.6)", letterSpacing: 1 }}>ALL TIME</Text>
          <Text style={{ fontSize: 32, fontFamily: "Inter_700Bold", color: "#fff", marginTop: 4 }}>{formatCurrency(grandTotal)}</Text>
          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.55)", marginTop: 4 }}>{rows.length} product/service types · {grandCount} units</Text>
        </LinearGradient>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 16 }}>
          <View style={{ flexDirection: "row", backgroundColor: "#F8FAFC", borderBottomWidth: 1, borderBottomColor: "#E2E8F0", paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ flex: 1, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569" }}>ITEM / SERVICE</Text>
            <Text style={{ width: 50, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", textAlign: "center" }}>QTY</Text>
            <Text style={{ width: 80, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", textAlign: "right" }}>AMOUNT</Text>
            <Text style={{ width: 44, fontSize: 10, fontFamily: "Inter_700Bold", color: "#475569", textAlign: "right" }}>%</Text>
          </View>

          {rows.length === 0 && (
            <View style={{ padding: 32, alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#9CA3AF" }}>No invoice line items yet.</Text>
            </View>
          )}

          {rows.map((row, idx) => {
            const pct = grandTotal > 0 ? (row.total / grandTotal) * 100 : 0;
            return (
              <View key={idx} style={{ borderBottomWidth: idx < rows.length - 1 ? 1 : 0, borderBottomColor: "#F1F5F9" }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, backgroundColor: idx % 2 === 0 ? "#fff" : "#FAFBFC" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#111827" }} numberOfLines={1}>{row.item}</Text>
                  </View>
                  <Text style={{ width: 50, fontSize: 12, fontFamily: "Inter_500Medium", color: "#374151", textAlign: "center" }}>{row.count % 1 === 0 ? row.count : row.count.toFixed(1)}</Text>
                  <Text style={{ width: 80, fontSize: 13, fontFamily: "Inter_700Bold", color: "#111827", textAlign: "right" }}>{formatCurrency(row.total)}</Text>
                  <Text style={{ width: 44, fontSize: 11, fontFamily: "Inter_500Medium", color: "#6B7280", textAlign: "right" }}>{pct.toFixed(1)}%</Text>
                </View>
                <View style={{ marginHorizontal: 14, height: 3, backgroundColor: "#F1F5F9", borderRadius: 2, marginBottom: 2 }}>
                  <View style={{ width: `${pct}%` as any, height: "100%" as any, backgroundColor: "#1D4ED8", borderRadius: 2 }} />
                </View>
              </View>
            );
          })}

          <View style={{ flexDirection: "row", backgroundColor: "#1E3A5F", paddingHorizontal: 14, paddingVertical: 12 }}>
            <Text style={{ flex: 1, fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff" }}>TOTAL</Text>
            <Text style={{ width: 50, fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff", textAlign: "center" }}>{grandCount % 1 === 0 ? grandCount : grandCount.toFixed(1)}</Text>
            <Text style={{ width: 80, fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff", textAlign: "right" }}>{formatCurrency(grandTotal)}</Text>
            <Text style={{ width: 44, fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff", textAlign: "right" }}>100%</Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderReceivePayment() {
    const clientsWithOpen = clients.filter(c =>
      invoices.some(i => i.clientId === c.id && (i.status === "open" || i.status === "overdue" || i.status === "sent"))
    );
    const rpClient = rpClientId ? clients.find(c => c.id === rpClientId) : null;
    const openForClient = rpClientId
      ? invoices.filter(i => i.clientId === rpClientId && (i.status === "open" || i.status === "overdue" || i.status === "sent"))
      : [];
    const selectedTotal = openForClient
      .filter(i => rpSelectedInvIds.includes(i.id))
      .reduce((s, i) => s + i.amount, 0);
    const paymentAmt = parseFloat(rpAmountText) || 0;
    const methods = ["Check", "ACH", "Credit Card", "Cash", "Wire Transfer", "Zelle"];

    function toggleInv(id: string) {
      setRpSelectedInvIds(prev => {
        const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
        const newTotal = openForClient.filter(i => next.includes(i.id)).reduce((s, i) => s + i.amount, 0);
        setRpAmountText(newTotal.toFixed(2));
        return next;
      });
    }

    function handleSavePayment() {
      if (rpSelectedInvIds.length === 0) { Alert.alert("No Invoices", "Select at least one invoice to apply this payment to."); return; }
      if (paymentAmt <= 0) { Alert.alert("Invalid Amount", "Enter a valid payment amount."); return; }
      let remaining = paymentAmt;
      rpSelectedInvIds.forEach(id => {
        const inv = invoices.find(i => i.id === id);
        if (!inv) return;
        if (remaining <= 0) return;
        const applied = Math.min(remaining, inv.amount);
        remaining -= applied;
        const newStatus: "paid" | "open" = applied >= inv.amount ? "paid" : "open";
        updateInvoice(id, { status: newStatus, credits: (inv.credits || 0) + applied });
      });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Payment Recorded", `${formatCurrency(paymentAmt)} applied to ${rpSelectedInvIds.length} invoice(s).`);
      setRpClientId(null);
      setRpSelectedInvIds([]);
      setRpAmountText("");
      setRpRef("");
      setRpMethod("Check");
      setAdminView("financial-hub");
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 24 : 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {renderBackHeader("Receive Payment", "financial-hub")}

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
          <View style={{ backgroundColor: "#1E3A5F", padding: 14 }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5 }}>SELECT CLIENT</Text>
          </View>
          {clientsWithOpen.length === 0 && (
            <View style={{ padding: 24, alignItems: "center" }}>
              <Ionicons name="checkmark-circle" size={36} color="#10B981" />
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#065F46", marginTop: 8 }}>No outstanding balances</Text>
            </View>
          )}
          {clientsWithOpen.map((client, idx) => {
            const openAmt = invoices.filter(i => i.clientId === client.id && (i.status === "open" || i.status === "overdue" || i.status === "sent")).reduce((s, i) => s + i.amount, 0);
            const selected = rpClientId === client.id;
            return (
              <Pressable key={client.id} onPress={() => { setRpClientId(selected ? null : client.id); setRpSelectedInvIds([]); setRpAmountText(""); }}
                style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: idx < clientsWithOpen.length - 1 ? 1 : 0, borderBottomColor: "#F1F5F9", backgroundColor: selected ? "#EFF6FF" : idx % 2 === 0 ? "#fff" : "#FAFBFC" }}>
                <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: selected ? "#1D4ED8" : "#F1F5F9", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  {selected ? <Ionicons name="checkmark" size={18} color="#fff" /> : <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#6B7280" }}>{(client.practiceName || (client as any).doctorName || "?")[0].toUpperCase()}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: selected ? "#1D4ED8" : "#111827" }}>{client.practiceName || (client as any).doctorName}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#6B7280" }}>{invoices.filter(i => i.clientId === client.id && i.status !== "paid").length} open invoice(s)</Text>
                </View>
                <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: "#DC2626" }}>{formatCurrency(openAmt)}</Text>
              </Pressable>
            );
          })}
        </View>

        {rpClientId && openForClient.length > 0 && (
          <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
            <View style={{ backgroundColor: "#1E3A5F", padding: 14, flexDirection: "row", alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5, flex: 1 }}>OUTSTANDING INVOICES</Text>
              <Pressable onPress={() => {
                const allIds = openForClient.map(i => i.id);
                const allSelected = allIds.every(id => rpSelectedInvIds.includes(id));
                if (allSelected) { setRpSelectedInvIds([]); setRpAmountText("0.00"); }
                else { setRpSelectedInvIds(allIds); setRpAmountText(openForClient.reduce((s, i) => s + i.amount, 0).toFixed(2)); }
              }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#93C5FD" }}>
                  {openForClient.every(i => rpSelectedInvIds.includes(i.id)) ? "Deselect All" : "Select All"}
                </Text>
              </Pressable>
            </View>
            {openForClient.map((inv, idx) => {
              const checked = rpSelectedInvIds.includes(inv.id);
              const daysLate = Math.max(0, Math.floor((Date.now() - inv.dueAt) / 86400000));
              return (
                <Pressable key={inv.id} onPress={() => toggleInv(inv.id)}
                  style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: idx < openForClient.length - 1 ? 1 : 0, borderBottomColor: "#F1F5F9", backgroundColor: checked ? "#EFF6FF" : "transparent" }}>
                  <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: checked ? "#1D4ED8" : "#D1D5DB", backgroundColor: checked ? "#1D4ED8" : "#fff", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                    {checked && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#111827" }}>#{formatInvNum(inv.invoiceNumber)}</Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#6B7280" }}>{inv.patientName || "No patient"} · Due {new Date(inv.dueAt).toLocaleDateString()}</Text>
                    {daysLate > 0 && <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#DC2626" }}>{daysLate} day{daysLate !== 1 ? "s" : ""} overdue</Text>}
                  </View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: "#111827" }}>{formatCurrency(inv.amount)}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {rpClientId && (
          <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden", marginBottom: 12 }}>
            <View style={{ backgroundColor: "#1E3A5F", padding: 14 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5 }}>PAYMENT DETAILS</Text>
            </View>
            <View style={{ padding: 14, gap: 12 }}>
              <View>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 6 }}>Payment Method</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {methods.map(m => (
                    <Pressable key={m} onPress={() => setRpMethod(m)}
                      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: rpMethod === m ? "#1D4ED8" : "#D1D5DB", backgroundColor: rpMethod === m ? "#EFF6FF" : "#fff" }}>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: rpMethod === m ? "#1D4ED8" : "#6B7280" }}>{m}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Reference / Check #</Text>
                <TextInput style={{ borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 8, padding: 10, fontSize: 13, fontFamily: "Inter_400Regular", backgroundColor: "#F9FAFB" }} value={rpRef} onChangeText={setRpRef} placeholder="Optional" placeholderTextColor="#9CA3AF" />
              </View>
              <View>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#6B7280", marginBottom: 4 }}>Amount Received</Text>
                <TextInput style={{ borderWidth: 2, borderColor: "#1D4ED8", borderRadius: 8, padding: 10, fontSize: 18, fontFamily: "Inter_700Bold", color: "#111827", backgroundColor: "#EFF6FF" }} value={rpAmountText} onChangeText={setRpAmountText} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor="#9CA3AF" />
                {rpSelectedInvIds.length > 0 && Math.abs(paymentAmt - selectedTotal) > 0.01 && (
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#D97706", marginTop: 4 }}>Selected total: {formatCurrency(selectedTotal)}</Text>
                )}
              </View>
            </View>
          </View>
        )}

        {rpClientId && (
          <View style={{ flexDirection: "row", marginHorizontal: 16, gap: 10, marginBottom: 24 }}>
            <Pressable onPress={() => { setRpClientId(null); setRpSelectedInvIds([]); setRpAmountText(""); setRpRef(""); }}
              style={({ pressed }) => ({ flex: 1, borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 12, paddingVertical: 14, alignItems: "center" as const, backgroundColor: pressed ? "#F9FAFB" : "#fff" })}>
              <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#374151" }}>Clear</Text>
            </Pressable>
            <Pressable onPress={handleSavePayment}
              style={({ pressed }) => ({ flex: 2, backgroundColor: pressed ? "#1D4ED8" : "#2563EB", borderRadius: 12, paddingVertical: 14, alignItems: "center" as const, flexDirection: "row" as const, justifyContent: "center" as const, gap: 8 })}>
              <Ionicons name="checkmark-circle" size={18} color="#fff" />
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#fff" }}>Save Payment</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    );
  }

  function renderLabUsers() {
    const filteredLabUsers = labUserSearchQuery.trim()
      ? labPortalUsers.filter(u => u.username.toLowerCase().includes(labUserSearchQuery.toLowerCase()) || (u.email && u.email.toLowerCase().includes(labUserSearchQuery.toLowerCase())))
      : labPortalUsers;

    function handleAddUserToGroup(_username: string, _groupId: string) {
      Alert.alert("Not Available", "Group assignment from the mobile app is not yet supported.");
    }

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Lab Users")}

        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ backgroundColor: "#F3E8FF", borderRadius: 16, padding: 20, marginBottom: 20, alignItems: "center" }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#7C3AED", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
              <Ionicons name="people" size={28} color="#fff" />
            </View>
            <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: "#5B21B6" }}>{labPortalUsers.length}</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#7C3AED", marginTop: 2 }}>Lab Portal Users</Text>
          </View>

          <View style={{ marginBottom: 16 }}>
            <View style={[adm.textInput, { flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }]}>
              <Ionicons name="search" size={18} color="#9CA3AF" style={{ marginRight: 8 }} />
              <TextInput
                style={{ flex: 1, fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.light.text, paddingVertical: 0 }}
                placeholder="Search users..."
                value={labUserSearchQuery}
                onChangeText={setLabUserSearchQuery}
                placeholderTextColor="#9CA3AF"
              />
              {labUserSearchQuery.length > 0 && (
                <Pressable onPress={() => setLabUserSearchQuery("")}>
                  <Ionicons name="close-circle" size={18} color="#9CA3AF" />
                </Pressable>
              )}
            </View>
          </View>

          {filteredLabUsers.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 40 }}>
              <Ionicons name="person-outline" size={48} color="#D1D5DB" />
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 15, color: Colors.light.subText, marginTop: 12 }}>No lab users found</Text>
            </View>
          ) : (
            filteredLabUsers.map(user => {
              return (
                <View key={user.username} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB", shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#EDE9FE", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                      <Text style={{ fontFamily: "Inter_700Bold", fontSize: 16, color: "#7C3AED" }}>{user.username.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 15, color: Colors.light.text }}>{user.username}</Text>
                      {user.email ? <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.light.subText }}>{user.email}</Text> : null}
                      {user.practiceName ? <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.light.tint }}>{user.practiceName}</Text> : null}
                    </View>
                    <View style={{ backgroundColor: user.role === "admin" ? "#FEF3C7" : "#F3F4F6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: user.role === "admin" ? "#92400E" : "#6B7280" }}>{(user.role || "user").toUpperCase()}</Text>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    );
  }

  async function handleSaveIteroCredentials() {
    if (!iteroEmail.trim() || !iteroPassword.trim()) {
      Alert.alert("Required", "Email and password are required.");
      return;
    }
    setIteroSaving(true);
    try {
      await SecureStore.setItemAsync("itero_email", iteroEmail.trim());
      await SecureStore.setItemAsync("itero_password", iteroPassword.trim());
      setIteroConnected(true);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "iTero credentials stored securely on this device.");
    } catch (err) {
      Alert.alert("Error", "Failed to save credentials securely.");
    }
    setIteroSaving(false);
  }

  async function handleDisconnectItero() {
    Alert.alert("Disconnect iTero", "Remove stored credentials from this device?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          try {
            await SecureStore.deleteItemAsync("itero_email");
            await SecureStore.deleteItemAsync("itero_password");
          } catch {}
          setIteroEmail("");
          setIteroPassword("");
          setIteroConnected(false);
          setIteroImportResults([]);
          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        },
      },
    ]);
  }

  async function handleImportRxPhotos() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        mediaTypes: ["images"],
        quality: 0.9,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;

      setIteroImporting(true);
      const imported: typeof iteroImportResults = [];

      for (const asset of result.assets) {
        try {
          let base64Data = asset.base64;
          if (!base64Data && asset.uri) {
            const FileSystem = await import("expo-file-system");
            const fileData = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" as any });
            base64Data = fileData;
          }
          if (!base64Data) continue;

          const dataUri = `data:image/jpeg;base64,${base64Data}`;
          const resp = await apiRequest("POST", "/api/analyze-prescription", { imageBase64: dataUri });
          const data = await resp.json();

          if (data.success && data.data) {
            const rx = data.data;
            imported.push({
              doctor: rx.doctorName || "",
              teeth: rx.toothNumbers || "",
              shade: rx.shade || "",
              material: rx.material || "",
              notes: rx.notes || "",
            });
          }
        } catch (err) {
          console.log("RX import error for one image:", err);
        }
      }

      setIteroImportResults(imported);
      setIteroImporting(false);

      if (imported.length === 0) {
        Alert.alert("No Data Found", "Could not extract prescription data from the selected images.");
      } else {
        Alert.alert("Import Complete", `Extracted data from ${imported.length} prescription${imported.length > 1 ? "s" : ""}. Review below and create cases.`);
      }
    } catch (err) {
      setIteroImporting(false);
      Alert.alert("Error", "Failed to import prescriptions.");
    }
  }

  function handleCreateCaseFromImport(rx: typeof iteroImportResults[0], idx: number) {
    const currentYear = new Date().getFullYear();
    const yy = String(currentYear).slice(-2);
    const yearCases = cases.filter(c => c.caseNumber.startsWith(`${yy}-`));
    const maxN = yearCases.reduce((max, c) => {
      const parts = c.caseNumber.split("-");
      const n = parseInt(parts[1]) || 0;
      return n > max ? n : max;
    }, 0);
    const caseNumber = `${yy}-${maxN + 1}`;

    const patientName = "iTero Import";
    const initials = "IT";

    addCase({
      caseNumber,
      doctorName: rx.doctor || "Unknown Provider",
      patientName,
      patientInitials: initials,
      toothIndices: rx.teeth || "",
      shade: rx.shade || "",
      material: rx.material || "",
      status: "INTAKE",
      isRush: false,
      notes: rx.notes ? `[iTero Import] ${rx.notes}` : "[iTero Import]",
      price: 0,
      dueDate: "",
      photos: [],
      activityLog: [],
    });

    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const updated = [...iteroImportResults];
    updated.splice(idx, 1);
    setIteroImportResults(updated);

    Alert.alert("Case Created", `Case ${caseNumber} created for ${rx.doctor || "Unknown Provider"}.`);
  }

  function renderIntegrations() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Integrations")}

        <View style={{ marginHorizontal: 20, marginBottom: 16 }}>
          <LinearGradient
            colors={["#1E3A8A", "#2563EB"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: 16, padding: 20, marginBottom: 20 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.15)", justifyContent: "center", alignItems: "center" }}>
                <Ionicons name="cloud-upload" size={24} color="#FFF" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>iTero Scanner</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.7)", marginTop: 2 }}>Align Technology Integration</Text>
              </View>
              <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: iteroConnected ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.15)" }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: iteroConnected ? "#86EFAC" : "rgba(255,255,255,0.6)" }}>
                  {iteroConnected ? "LINKED" : "NOT LINKED"}
                </Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)", lineHeight: 18 }}>
              Link your iTero account to import prescriptions. Credentials are encrypted and stored securely on this device only.
            </Text>
          </LinearGradient>

          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 16, marginBottom: 16 }}>
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 14 }}>Account Credentials</Text>

            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Email</Text>
              <TextInput
                style={[adm.input, { backgroundColor: "#F8FAFC" }]}
                value={iteroEmail}
                onChangeText={setIteroEmail}
                placeholder="your-email@example.com"
                placeholderTextColor={Colors.light.textTertiary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Password</Text>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <TextInput
                  style={[adm.input, { flex: 1, backgroundColor: "#F8FAFC" }]}
                  value={iteroPassword}
                  onChangeText={setIteroPassword}
                  placeholder="Enter password"
                  placeholderTextColor={Colors.light.textTertiary}
                  secureTextEntry={!iteroShowPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable onPress={() => setIteroShowPassword(!iteroShowPassword)} style={{ position: "absolute", right: 12 }}>
                  <Ionicons name={iteroShowPassword ? "eye-off" : "eye"} size={20} color={Colors.light.textTertiary} />
                </Pressable>
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={handleSaveIteroCredentials}
                disabled={iteroSaving}
                style={({ pressed }) => ({
                  flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                  backgroundColor: Colors.light.tint, borderRadius: 12, paddingVertical: 13,
                  opacity: pressed || iteroSaving ? 0.7 : 1,
                })}
              >
                {iteroSaving ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Ionicons name="shield-checkmark" size={18} color="#FFF" />
                )}
                <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>
                  {iteroConnected ? "Update Credentials" : "Save & Link"}
                </Text>
              </Pressable>
              {iteroConnected && (
                <Pressable
                  onPress={handleDisconnectItero}
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
                    backgroundColor: Colors.light.errorLight, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons name="unlink" size={16} color={Colors.light.error} />
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.error }}>Unlink</Text>
                </Pressable>
              )}
            </View>
          </View>

          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 16, marginBottom: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: "#FEF3C7", justifyContent: "center", alignItems: "center" }}>
                <Ionicons name="document-text" size={16} color="#F59E0B" />
              </View>
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Import Prescriptions</Text>
            </View>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginBottom: 14, lineHeight: 18 }}>
              Upload prescription images exported from iTero. AI will extract provider name, tooth numbers, shade, material, and notes to create new cases.
            </Text>

            <Pressable
              onPress={handleImportRxPhotos}
              disabled={iteroImporting}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                backgroundColor: "#F59E0B", borderRadius: 12, paddingVertical: 13,
                opacity: pressed || iteroImporting ? 0.7 : 1,
              })}
            >
              {iteroImporting ? (
                <>
                  <ActivityIndicator size="small" color="#FFF" />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Analyzing Prescriptions...</Text>
                </>
              ) : (
                <>
                  <Ionicons name="images" size={18} color="#FFF" />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Select RX Images</Text>
                </>
              )}
            </Pressable>
          </View>

          {iteroImportResults.length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 12 }}>
                Extracted Prescriptions ({iteroImportResults.length})
              </Text>
              {iteroImportResults.map((rx, idx) => (
                <View key={idx} style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 14, marginBottom: 10 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.light.tintLight, justifyContent: "center", alignItems: "center" }}>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: Colors.light.tint }}>{idx + 1}</Text>
                    </View>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text, flex: 1 }}>{rx.doctor || "Unknown Provider"}</Text>
                  </View>
                  <View style={{ gap: 6 }}>
                    {rx.teeth ? (
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, width: 60 }}>Teeth</Text>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>{rx.teeth}</Text>
                      </View>
                    ) : null}
                    {rx.shade ? (
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, width: 60 }}>Shade</Text>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>{rx.shade}</Text>
                      </View>
                    ) : null}
                    {rx.material ? (
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, width: 60 }}>Material</Text>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>{rx.material}</Text>
                      </View>
                    ) : null}
                    {rx.notes ? (
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, width: 60 }}>Notes</Text>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.text, flex: 1 }}>{rx.notes}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => handleCreateCaseFromImport(rx, idx)}
                    style={({ pressed }) => ({
                      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
                      backgroundColor: Colors.light.success, borderRadius: 10, paddingVertical: 10, marginTop: 12,
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Ionicons name="add-circle" size={18} color="#FFF" />
                    <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Create Case</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <View style={{ backgroundColor: "#F0F9FF", borderRadius: 14, borderWidth: 1, borderColor: "#BAE6FD", padding: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Ionicons name="information-circle" size={20} color="#0EA5E9" />
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#0369A1" }}>API Integration</Text>
            </View>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#0369A1", lineHeight: 18 }}>
              Direct API sync with iTero requires official API access from Align Technology. Contact your Align representative to obtain API credentials for automatic prescription syncing.
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderDeleteCases() {
    const activeCases = cases.filter((c) => c.status !== "COMPLETE");

    return (
      <View style={{ flex: 1, backgroundColor: "#F8FAFC" }}>
        <ScrollView
          style={styles.container}
          contentContainerStyle={{
            paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {renderBackHeader("Delete Case")}
          {activeCases.length === 0 ? (
            <View style={{ alignItems: "center", paddingTop: 60 }}>
              <Ionicons name="checkmark-circle-outline" size={48} color={Colors.light.textTertiary} />
              <Text style={{ fontSize: 16, color: Colors.light.textSecondary, marginTop: 12 }}>No active cases</Text>
            </View>
          ) : (
            <View style={adm.menuSection}>
              {activeCases.map((c) => {
                const stationInfo = getStationInfo(c.status, customStationLabels);
                return (
                  <Pressable
                    key={c.id}
                    style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
                    onPress={() => { setDeleteCaseTarget(c); setShowDeleteConfirm(true); }}
                  >
                    <View style={[adm.menuIcon, { backgroundColor: "#FEE2E2" }]}>
                      <Ionicons name="document-text" size={20} color="#EF4444" />
                    </View>
                    <View style={adm.menuInfo}>
                      <Text style={adm.menuTitle}>Case #{c.caseNumber}</Text>
                      <Text style={adm.menuSub} numberOfLines={1}>
                        {c.patientName || "No patient"} · {c.doctorName || "No doctor"} · {stationInfo.label}
                      </Text>
                    </View>
                    <Ionicons name="trash-outline" size={18} color="#EF4444" />
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>

        {showDeleteConfirm && deleteCaseTarget && (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", zIndex: 999 }}>
            <View style={{ backgroundColor: "#fff", borderRadius: 16, padding: 24, marginHorizontal: 32, width: "90%", maxWidth: 400 }}>
              <Text style={{ fontSize: 18, fontWeight: "700" as const, color: "#0F172A", marginBottom: 8 }}>Delete Case</Text>
              <Text style={{ fontSize: 15, color: Colors.light.textSecondary, marginBottom: 20 }}>
                Are you sure you want to delete Case #{deleteCaseTarget.caseNumber}
                {deleteCaseTarget.patientName ? ` (${deleteCaseTarget.patientName})` : ""}? This action cannot be undone.
              </Text>
              <View style={{ flexDirection: "row", gap: 12 }}>
                <Pressable
                  onPress={() => { setShowDeleteConfirm(false); setDeleteCaseTarget(null); }}
                  style={({ pressed }) => ({
                    flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: "#F1F5F9", alignItems: "center" as const, opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ fontSize: 15, fontWeight: "600" as const, color: Colors.light.textSecondary }}>No</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    removeCase(deleteCaseTarget.id);
                    setShowDeleteConfirm(false);
                    setDeleteCaseTarget(null);
                  }}
                  style={({ pressed }) => ({
                    flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: "#EF4444", alignItems: "center" as const, opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ fontSize: 15, fontWeight: "600" as const, color: "#fff" }}>Yes</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </View>
    );
  }

  function renderInactiveClients() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Inactive Clients")}
        <View style={adm.listArea}>
          {inactiveClients.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Ionicons name="checkmark-circle" size={48} color={Colors.light.textTertiary} />
              <Text style={{ fontSize: 16, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginTop: 12 }}>No inactive clients</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 4 }}>All clients are currently active</Text>
            </View>
          ) : (
            inactiveClients.map((client) => {
              const clientOpenInvoices = invoices.filter(inv => inv.clientId === client.id && (inv.status === "open" || inv.status === "overdue"));
              const openBalance = clientOpenInvoices.reduce((s, inv) => s + inv.amount, 0);
              return (
                <View key={client.id} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: Colors.light.border }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{client.practiceName}</Text>
                      <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>{client.leadDoctor} · {client.accountNumber}</Text>
                    </View>
                    <View style={{ backgroundColor: "#FEF3C7", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#D97706" }}>Inactive</Text>
                    </View>
                  </View>
                  {openBalance > 0 && (
                    <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.warning, marginBottom: 8 }}>
                      Open Balance: {formatCurrency(openBalance)} ({clientOpenInvoices.length} invoices)
                    </Text>
                  )}
                  <Pressable
                    style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#D1FAE5", borderRadius: 10, padding: 12 }, pressed && { opacity: 0.7 }]}
                    onPress={() => {
                      reactivateClient(client.id);
                    }}
                  >
                    <Ionicons name="checkmark-circle" size={18} color="#10B981" />
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#10B981" }}>Reactivate Client</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    );
  }

  function renderDeletedInvoices() {
    const totalDeletedAmount = deletedClientInvoices.reduce((s, d) => s + d.invoice.amount, 0);
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Deleted Client Invoices")}
        <View style={adm.listArea}>
          {deletedClientInvoices.length > 0 && (
            <View style={{ backgroundColor: "#FEF2F2", borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "#FECACA" }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#DC2626", marginBottom: 4 }}>Archived Open Invoices</Text>
              <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: "#DC2626" }}>{formatCurrency(totalDeletedAmount)}</Text>
              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#EF4444", marginTop: 4 }}>These amounts are excluded from monthly sales and open invoice totals</Text>
            </View>
          )}
          {deletedClientInvoices.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Ionicons name="document-text" size={48} color={Colors.light.textTertiary} />
              <Text style={{ fontSize: 16, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginTop: 12 }}>No deleted client invoices</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 4 }}>Invoices from deleted clients will appear here</Text>
            </View>
          ) : (
            deletedClientInvoices.map((item, idx) => (
              <View key={`${item.invoice.id}-${idx}`} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: Colors.light.border }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{item.invoice.invoiceNumber}</Text>
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#DC2626" }}>{formatCurrency(item.invoice.amount)}</Text>
                </View>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText }}>Client: {item.clientName}</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>Patient: {item.invoice.patientName || "N/A"}</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>
                  Status: {item.invoice.status.charAt(0).toUpperCase() + item.invoice.status.slice(1)} · Deleted: {new Date(item.deletedAt).toLocaleDateString()}
                </Text>
                {item.invoice.lineItems && item.invoice.lineItems.length > 0 && (
                  <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: Colors.light.border, paddingTop: 8 }}>
                    {item.invoice.lineItems.map((li, liIdx) => (
                      <View key={liIdx} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 2 }}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText }}>{li.item} - {li.description}</Text>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatCurrency(li.amount)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    );
  }

  function renderBackup() {
    async function handleDownloadBackup() {
      if (isBackingUp) return;
      setIsBackingUp(true);
      try {
        const token = getAccessToken();
        const apiBase = getApiUrl();
        const backupUrl = new URL("/api/admin/backup", apiBase).toString();

        if (Platform.OS === "web") {
          const resp = await fetch(backupUrl, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!resp.ok) throw new Error(`Server error ${resp.status}`);
          const blob = await resp.blob();
          const dateStr = new Date().toISOString().split("T")[0];
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `labtrax-backup-${dateStr}.zip`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
          setLastBackupTime(new Date().toLocaleString());
        } else {
          const FileSystem = await import("expo-file-system");
          const dateStr = new Date().toISOString().split("T")[0];
          const destFile = new FileSystem.File(
            FileSystem.Paths.document,
            `labtrax-backup-${dateStr}.zip`,
          );
          try {
            if (destFile.exists) destFile.delete();
          } catch {
            // best-effort
          }

          const downloaded = await FileSystem.File.downloadFileAsync(backupUrl, destFile, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });

          const isAvail = await Sharing.isAvailableAsync();
          if (isAvail) {
            await Sharing.shareAsync(downloaded.uri, {
              mimeType: "application/zip",
              dialogTitle: "Save LabTrax Backup",
              UTI: "public.zip-archive",
            });
            setLastBackupTime(new Date().toLocaleString());
          } else {
            Alert.alert("Backup Saved", `Backup saved to:\n${downloaded.uri}`);
            setLastBackupTime(new Date().toLocaleString());
          }
        }
      } catch (e: any) {
        console.error("Backup error:", e?.message);
        Alert.alert("Backup Failed", e?.message || "Something went wrong. Please try again.");
      }
      setIsBackingUp(false);
    }

    async function handleOneDriveBackup() {
      if (isOneDriving || isBackingUp) return;
      setIsOneDriving(true);
      setOneDriveResult(null);
      try {
        const token = getAccessToken();
        const apiBase = getApiUrl();
        const url = new URL("/api/admin/backup/onedrive", apiBase).toString();
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || "Upload failed.");
        setOneDriveResult(data);
        Alert.alert(
          "Saved to OneDrive ✓",
          `"${data.fileName}" saved to your OneDrive folder "${data.folder}".\n\nSize: ${(data.size / 1024).toFixed(0)} KB`,
          [
            { text: "Open in OneDrive", onPress: () => data.webUrl && Linking.openURL(data.webUrl) },
            { text: "OK", style: "cancel" },
          ]
        );
      } catch (e: any) {
        console.error("OneDrive backup error:", e?.message);
        Alert.alert("OneDrive Upload Failed", e?.message || "Could not upload to OneDrive. Please try again.");
      }
      setIsOneDriving(false);
    }

    const included = [
      { icon: "people-outline", label: "All user accounts", sub: `${users.length} registered users` },
      { icon: "folder-open-outline", label: "All case records", sub: `${cases.length} cases with full data` },
      { icon: "images-outline", label: "Case photos & attachments", sub: "All uploaded media files" },
      { icon: "pricetag-outline", label: "Clients & pricing", sub: `${clients.length} providers with pricing` },
      { icon: "receipt-outline", label: "Invoices & payments", sub: `${invoices.length} financial records` },
    ];

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
      >
        {renderBackHeader("Backup Data")}

        <View style={{ paddingHorizontal: 20 }}>
          <LinearGradient
            colors={["#064E3B", "#065F46"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: 20, padding: 22, marginBottom: 20 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
                <Ionicons name="cloud-download" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#fff" }}>Data Backup</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.65)", marginTop: 2 }}>Export a complete ZIP archive to a local server or thumb drive</Text>
              </View>
            </View>
            {lastBackupTime && (
              <View style={{ backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginTop: 4 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)" }}>
                  Last backup: {lastBackupTime}
                </Text>
              </View>
            )}
          </LinearGradient>

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textTertiary, letterSpacing: 0.5, marginBottom: 10 }}>
            WHAT'S INCLUDED
          </Text>
          <View style={{ backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: Colors.light.border, marginBottom: 24, overflow: "hidden" }}>
            {included.map((item, idx) => (
              <View key={idx} style={{ flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: idx < included.length - 1 ? 1 : 0, borderBottomColor: Colors.light.borderLight }}>
                <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: "#D1FAE5", alignItems: "center", justifyContent: "center", marginRight: 14 }}>
                  <Ionicons name={item.icon as any} size={18} color="#059669" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{item.label}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 1 }}>{item.sub}</Text>
                </View>
                <Ionicons name="checkmark-circle" size={18} color="#059669" />
              </View>
            ))}
          </View>

          <View style={{ backgroundColor: "#FEF3C7", borderRadius: 14, padding: 14, marginBottom: 24, flexDirection: "row", alignItems: "flex-start", borderWidth: 1, borderColor: "#FDE68A" }}>
            <Ionicons name="information-circle-outline" size={18} color="#D97706" style={{ marginRight: 10, marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#92400E" }}>Security Note</Text>
              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#A16207", marginTop: 3, lineHeight: 18 }}>
                Passwords are never included in backups. Store your backup file securely — it contains patient and financial data subject to HIPAA regulations.
              </Text>
            </View>
          </View>

          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textTertiary, letterSpacing: 0.5, marginBottom: 10 }}>
            SAVE BACKUP TO
          </Text>

          <Pressable
            onPress={handleDownloadBackup}
            disabled={isBackingUp || isOneDriving}
            style={({ pressed }) => [{
              backgroundColor: (isBackingUp || isOneDriving) ? "#A7F3D0" : "#059669",
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 10,
              opacity: pressed ? 0.85 : 1,
              marginBottom: 12,
            }]}
          >
            {isBackingUp
              ? <ActivityIndicator color="#fff" size="small" />
              : <Ionicons name="download-outline" size={22} color="#fff" />}
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#fff" }}>
              {isBackingUp ? "Generating…" : "Local / Thumb Drive"}
            </Text>
          </Pressable>

          <Pressable
            onPress={handleOneDriveBackup}
            disabled={isOneDriving || isBackingUp}
            style={({ pressed }) => [{
              backgroundColor: (isOneDriving || isBackingUp) ? "#BFDBFE" : "#0078D4",
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 10,
              opacity: pressed ? 0.85 : 1,
              marginBottom: 8,
            }]}
          >
            {isOneDriving
              ? <ActivityIndicator color="#fff" size="small" />
              : <Ionicons name="cloud-upload-outline" size={22} color="#fff" />}
            <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#fff" }}>
              {isOneDriving ? "Uploading to OneDrive…" : "Save to OneDrive"}
            </Text>
          </Pressable>

          {oneDriveResult && (
            <Pressable
              onPress={() => oneDriveResult.webUrl && Linking.openURL(oneDriveResult.webUrl)}
              style={({ pressed }) => [{ backgroundColor: "#EFF6FF", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#BFDBFE", flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.8 : 1 }]}
            >
              <Ionicons name="checkmark-circle" size={20} color="#0078D4" />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#1D4ED8" }}>Saved to OneDrive</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#3B82F6", marginTop: 2 }}>{oneDriveResult.folder} / {oneDriveResult.fileName}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color="#3B82F6" />
            </Pressable>
          )}

          {Platform.OS !== "web" && (
            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", marginTop: 8 }}>
              Local backup opens the share sheet · OneDrive saves directly to your account
            </Text>
          )}
          {Platform.OS === "web" && (
            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", marginTop: 8 }}>
              Local downloads to your computer · OneDrive saves to your Microsoft account
            </Text>
          )}
        </View>
      </ScrollView>
    );
  }

  switch (adminView) {
    case "delete-cases": return renderDeleteCases();
    case "inactive-clients": return renderInactiveClients();
    case "deleted-invoices": return renderDeletedInvoices();
    case "backup": return renderBackup();
    case "financial-hub": return renderFinancialHub();
    case "client-hub": return renderClientHub();
    case "clients": return renderClients();
    case "client-detail": return renderClientDetail();
    case "client-stats": return renderClientStats();
    case "add-client": return renderAddClient();
    case "edit-client": return renderEditClient();
    case "edit-price-list": return renderEditPriceList();
    case "edit-tier-pricing": return renderEditTierPricing();
    case "user-hub": return renderUserHub();
    case "add-user": return renderAddUser();
    case "edit-user": return renderEditUser();
    case "invoices": return renderInvoices();
    case "invoices-hub": return renderInvoicesHub();
    case "view-invoices": return renderViewInvoices();
    case "send-invoice": return renderSendInvoice();
    case "text-invoice": return renderTextInvoice();
    case "pick-invoice-to-send": return renderPickInvoiceToSend();
    case "invoice-detail": return renderInvoiceDetail();
    case "edit-invoice": return renderEditInvoice();
    case "ar-aging": return renderARAgingReport();
    case "pl-report": return renderPLReport();
    case "sales-by-item": return renderSalesByItem();
    case "receive-payment": return renderReceivePayment();
    case "sales": return renderSales();
    case "shipping": return renderShipping();
    case "inventory": return renderInventory();
    case "payment-processing": return renderPaymentProcessing();
    case "edit-locations": return renderEditLocations();
    case "lab-users": return renderLabUsers();
    case "integrations": return renderIntegrations();
    default: return renderHub();
  }
}

function ProviderDashboard() {
  const { cases, role, adminUnlocked, users, addUser, updateUser, removeUser, customStationLabels, sendGroupJoinRequest, groupJoinRequests, invoices, updateInvoice, addNotification, userIsAffiliated, fetchLabDirectory, refreshCases, hardRefresh } = useApp();
  const { currentUser, registeredUsers, logout, profilePicUri, setProfilePicUri, changePassword } = useAuth();
  const insets = useSafeAreaInsets();
  type ProviderLabDirectoryEntry = {
    organizationId: string;
    practiceName: string;
    username: string;
    practiceAddress?: string;
  };

  const [showSettings, setShowSettings] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [showUsersAdmin, setShowUsersAdmin] = useState(false);
  const [showProviderInvoices, setShowProviderInvoices] = useState(false);
  const [providerInvoiceFilter, setProviderInvoiceFilter] = useState<"open" | "all">("open");
  const [showPayInvoices, setShowPayInvoices] = useState(false);
  const [payStep, setPayStep] = useState<"select" | "card" | "receipt">("select");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [cardNumber, setCardNumber] = useState("");
  const [cardExpiry, setCardExpiry] = useState("");
  const [cardCvc, setCardCvc] = useState("");
  const [cardName, setCardName] = useState("");
  const [cardZip, setCardZip] = useState("");
  const [saveCard, setSaveCard] = useState(false);
  const [payProcessing, setPayProcessing] = useState(false);
  const [paidInvoiceIds, setPaidInvoiceIds] = useState<string[]>([]);
  const [paymentReceiptEmail, setPaymentReceiptEmail] = useState("");
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [prefOcclusion, setPrefOcclusion] = useState("");
  const [prefPontic, setPrefPontic] = useState("");
  const [prefContact, setPrefContact] = useState("");
  const [prefOcclusionOpen, setPrefOcclusionOpen] = useState(false);
  const [prefPonticOpen, setPrefPonticOpen] = useState(false);
  const [prefContactOpen, setPrefContactOpen] = useState(false);
  const [showAddLab, setShowAddLab] = useState(false);
  const [labSearchQuery, setLabSearchQuery] = useState("");
  const [availableLabs, setAvailableLabs] = useState<ProviderLabDirectoryEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
  const myLabName = currentUserData?.practiceName || "Allied Dental Lab";
  const myDoctorName = currentUserData?.doctorName || currentUser || "";
  const myCases = [...cases]
    .filter(c =>
      c.doctorName.toLowerCase() === myDoctorName.toLowerCase() ||
      c.doctorName.toLowerCase().includes((currentUser || "").toLowerCase())
    )
    .sort(
      (a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
    );
  const activeCases = myCases.filter(c => c.status !== "COMPLETE" && c.status !== "HOLD");
  const completedCases = myCases.filter(c => c.status === "COMPLETE");
  const inProgressCount = activeCases.length;
  const completedCount = completedCases.length;

  const OCCLUSION_OPTIONS = ["Centric Occlusion", "Balanced Occlusion", "Group Function", "Canine Guidance", "Mutually Protected"];
  const PONTIC_OPTIONS = ["Ridge Lap", "Modified Ridge Lap", "Sanitary/Hygienic", "Ovate", "Conical"];
  const CONTACT_OPTIONS = ["Light Contact", "Normal Contact", "Heavy Contact"];

  const prefStorageKey = `@drivesync_provider_preferences_${(currentUser || "").toLowerCase()}`;

  useEffect(() => {
    if (!currentUser) return;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(prefStorageKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed.occlusionType) setPrefOcclusion(parsed.occlusionType);
          if (parsed.ponticType) setPrefPontic(parsed.ponticType);
          if (parsed.contactType) setPrefContact(parsed.contactType);
        }
      } catch {}
    })();
  }, [currentUser]);

  async function loadAvailableLabs(force = false) {
    if (!force && availableLabs.length > 0) {
      return availableLabs;
    }

    const groups = await fetchLabDirectory();
    const myUsername = (currentUser || "").toLowerCase().trim();
    const uniqueLabs = new Map<string, ProviderLabDirectoryEntry>();

    for (const group of groups) {
      if (
        !group.organizationId ||
        !group.practiceName?.trim() ||
        !group.username?.trim()
      ) {
        continue;
      }

      if (group.username.toLowerCase().trim() === myUsername) {
        continue;
      }

      uniqueLabs.set(group.organizationId, {
        organizationId: group.organizationId,
        practiceName: group.practiceName.trim(),
        username: group.username.trim(),
        practiceAddress: group.practiceAddress?.trim() || undefined,
      });
    }

    const nextLabs = Array.from(uniqueLabs.values());
    setAvailableLabs(nextLabs);
    return nextLabs;
  }

  useEffect(() => {
    if (!showAddLab) {
      return;
    }

    loadAvailableLabs(true).catch(() => setAvailableLabs([]));
  }, [showAddLab, currentUser]);

  const filteredAvailableLabs = useMemo(() => {
    const normalizedCurrentLab = (currentUserData?.practiceName || "").toLowerCase().trim();
    const baseLabs = availableLabs.filter(
      (lab) => lab.practiceName.toLowerCase().trim() !== normalizedCurrentLab
    );

    if (!labSearchQuery.trim()) {
      return baseLabs;
    }

    const normalizedQuery = labSearchQuery.trim().toLowerCase();
    return baseLabs.filter((lab) => {
      return (
        lab.practiceName.toLowerCase().includes(normalizedQuery) ||
        lab.username.toLowerCase().includes(normalizedQuery) ||
        (lab.practiceAddress || "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [availableLabs, currentUserData?.practiceName, labSearchQuery]);

  const saveProviderPreferences = useCallback(async (occlusion: string, pontic: string, contact: string) => {
    try {
      await AsyncStorage.setItem(prefStorageKey, JSON.stringify({ occlusionType: occlusion, ponticType: pontic, contactType: contact }));
    } catch {}
  }, [prefStorageKey]);

  return (
    <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 40 : 120,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await hardRefresh();
                setRefreshing(false);
              }}
            />
          ) : undefined
        }
      >
        <View style={styles.headerRow}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {profilePicUri ? (
              <Image source={{ uri: profilePicUri }} style={{ width: 48, height: 48, borderRadius: 24 }} />
            ) : (
              <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "#1E40AF", justifyContent: "center", alignItems: "center" }}>
                <Text style={{ color: "#FFF", fontSize: 20, fontFamily: "Inter_700Bold" }}>{(currentUser || "P").charAt(0).toUpperCase()}</Text>
              </View>
            )}
            <View>
              <Text style={styles.greeting}>Provider Portal</Text>
              <Text style={styles.headerTitle}>
                {currentUser ? `Dr. ${currentUser.charAt(0).toUpperCase() + currentUser.slice(1)}` : "Provider"}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            {Platform.OS === "web" && (
              <Pressable
                onPress={async () => {
                  setRefreshing(true);
                  await hardRefresh();
                  setRefreshing(false);
                }}
              >
                {refreshing ? (
                  <ActivityIndicator size={18} color={Colors.light.text} />
                ) : (
                  <Ionicons name="refresh" size={22} color={Colors.light.text} />
                )}
              </Pressable>
            )}
            <ChatButton />
            <Pressable onPress={() => setShowSettings(true)}>
              <Ionicons name="settings-outline" size={24} color={Colors.light.text} />
            </Pressable>
          </View>
        </View>

        {!userIsAffiliated && (
          <View style={{ marginHorizontal: 20, marginTop: 12, padding: 14, backgroundColor: "#FFF7ED", borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#FDE68A" }}>
            <Ionicons name="information-circle-outline" size={22} color="#D97706" />
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, color: "#92400E", flex: 1, lineHeight: 18 }}>
              Join a lab to collaborate with your team.
            </Text>
          </View>
        )}

        <LinearGradient
          colors={["#1E40AF", "#3B82F6"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <Text style={[styles.heroLabel, { opacity: 0.7 }]}>YOUR CASES</Text>
          <Text style={styles.heroCount}>{myCases.length}</Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
            <View style={{ backgroundColor: "rgba(255,255,255,0.15)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 }}>
              <Text style={{ color: "#FFF", fontSize: 12, fontFamily: "Inter_500Medium" }}>{inProgressCount} Active</Text>
            </View>
            <View style={{ backgroundColor: "rgba(255,255,255,0.15)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 }}>
              <Text style={{ color: "#FFF", fontSize: 12, fontFamily: "Inter_500Medium" }}>{completedCount} Completed</Text>
            </View>
          </View>
        </LinearGradient>

        <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
          <Pressable
            onPress={() => router.push("/smile-preview")}
            style={({ pressed }) => [
              {
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: "#7C3AED",
                borderRadius: 14,
                padding: 16,
                gap: 14,
              },
              pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
            ]}
          >
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="sparkles" size={22} color="#FFF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFF" }}>Smile Preview</Text>
              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.7)", marginTop: 2 }}>AR teeth whitening visualization</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.6)" />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { marginBottom: 12 }]}>Active Cases</Text>
          {activeCases.length === 0 ? (
            <View style={{ padding: 24, alignItems: "center" }}>
              <Ionicons name="document-text-outline" size={40} color={Colors.light.textTertiary} />
              <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginTop: 8 }}>No active cases</Text>
            </View>
          ) : (
            activeCases.slice(0, 10).map(c => (
              <Pressable
                key={c.id}
                style={({ pressed }) => [provStyles.caseCard, pressed && { opacity: 0.8 }]}
                onPress={() => router.push(`/case/${c.id}`)}
              >
                <View style={[provStyles.statusDot, { backgroundColor: getStationInfo(c.status, customStationLabels).color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={provStyles.caseName}>{c.patientName}</Text>
                  <Text style={provStyles.caseSub}>{c.caseType} · {(c as any).toothNumbers?.join(", ") || "N/A"}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.tint, marginTop: 2 }}>{myLabName}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[provStyles.caseStatus, { color: getStationInfo(c.status, customStationLabels).color }]}>{getStationInfo(c.status, customStationLabels).label}</Text>
                  {c.dueDate && <Text style={provStyles.caseDue}>Due: {c.dueDate}</Text>}
                </View>
              </Pressable>
            ))
          )}
        </View>

        {completedCases.length > 0 && (
          <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
            <Text style={[styles.sectionTitle, { marginBottom: 12 }]}>Recently Completed</Text>
            {completedCases.slice(0, 5).map(c => (
              <Pressable
                key={c.id}
                style={({ pressed }) => [provStyles.caseCard, pressed && { opacity: 0.8 }]}
                onPress={() => router.push(`/case/${c.id}`)}
              >
                <View style={[provStyles.statusDot, { backgroundColor: Colors.light.success }]} />
                <View style={{ flex: 1 }}>
                  <Text style={provStyles.caseName}>{c.patientName}</Text>
                  <Text style={provStyles.caseSub}>{c.caseType} · {(c as any).toothNumbers?.join(", ") || "N/A"}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.tint, marginTop: 2 }}>{myLabName}</Text>
                </View>
                <Ionicons name="checkmark-circle" size={20} color={Colors.light.success} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <Modal
        transparent
        visible={showSettings}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowSettings(false)}
      >
        <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: Colors.light.border }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Settings</Text>
            <Pressable onPress={() => setShowSettings(false)}>
              <Ionicons name="close" size={28} color={Colors.light.text} />
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1, padding: 20 }}>
            <View style={{ alignItems: "center", marginBottom: 24 }}>
              <Pressable onPress={async () => {
                const result = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: "images",
                  allowsEditing: true,
                  aspect: [1, 1],
                  quality: 0.8,
                });
                if (!result.canceled && result.assets[0]) {
                  setProfilePicUri(result.assets[0].uri);
                }
              }}>
                {profilePicUri ? (
                  <Image source={{ uri: profilePicUri }} style={{ width: 80, height: 80, borderRadius: 40 }} />
                ) : (
                  <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: "#1E40AF", justifyContent: "center", alignItems: "center" }}>
                    <Text style={{ color: "#FFF", fontSize: 28, fontFamily: "Inter_700Bold" }}>{(currentUser || "P").charAt(0).toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ position: "absolute", bottom: 0, right: 0, backgroundColor: Colors.light.tint, width: 28, height: 28, borderRadius: 14, justifyContent: "center", alignItems: "center", borderWidth: 2, borderColor: "#FFF" }}>
                  <Ionicons name="camera" size={14} color="#FFF" />
                </View>
              </Pressable>
              <Text style={{ marginTop: 8, fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{currentUser || "Provider"}</Text>
            </View>

            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 8, letterSpacing: 0.5 }}>ACCOUNT</Text>
            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.light.surface,
                borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border,
                opacity: pressed ? 0.7 : 1,
              })}
              onPress={() => { setShowChangePassword(true); setPasswordError(null); setPasswordSuccess(false); setCurrentPasswordInput(""); setNewPassword(""); setConfirmNewPassword(""); }}
            >
              <Ionicons name="lock-closed-outline" size={20} color={Colors.light.text} />
              <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>Change Password</Text>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>

            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginTop: 24, marginBottom: 8, letterSpacing: 0.5 }}>ACCOUNT PREFERENCES</Text>
            <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, marginBottom: 8, overflow: "hidden" }}>
              <Pressable
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, opacity: pressed ? 0.7 : 1 })}
                onPress={() => { setPrefOcclusionOpen(!prefOcclusionOpen); setPrefPonticOpen(false); setPrefContactOpen(false); }}
              >
                <Ionicons name="ellipse-outline" size={20} color="#6366F1" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text }}>Occlusion Type</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{prefOcclusion || "Not set"}</Text>
                </View>
                <Feather name={prefOcclusionOpen ? "chevron-up" : "chevron-down"} size={18} color={Colors.light.textTertiary} />
              </Pressable>
              {prefOcclusionOpen && (
                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                  {OCCLUSION_OPTIONS.map(opt => (
                    <Pressable
                      key={opt}
                      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: prefOcclusion === opt ? "#EEF2FF" : "transparent", opacity: pressed ? 0.7 : 1 })}
                      onPress={() => { setPrefOcclusion(opt); setPrefOcclusionOpen(false); saveProviderPreferences(opt, prefPontic, prefContact); if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: prefOcclusion === opt ? "#6366F1" : Colors.light.border, justifyContent: "center", alignItems: "center" }}>
                        {prefOcclusion === opt && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#6366F1" }} />}
                      </View>
                      <Text style={{ fontSize: 14, fontFamily: prefOcclusion === opt ? "Inter_600SemiBold" : "Inter_400Regular", color: prefOcclusion === opt ? "#6366F1" : Colors.light.text }}>{opt}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              <View style={{ height: 1, backgroundColor: Colors.light.borderLight, marginHorizontal: 16 }} />

              <Pressable
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, opacity: pressed ? 0.7 : 1 })}
                onPress={() => { setPrefPonticOpen(!prefPonticOpen); setPrefOcclusionOpen(false); setPrefContactOpen(false); }}
              >
                <MaterialCommunityIcons name="bridge" size={20} color="#8B5CF6" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text }}>Pontic Type</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{prefPontic || "Not set"}</Text>
                </View>
                <Feather name={prefPonticOpen ? "chevron-up" : "chevron-down"} size={18} color={Colors.light.textTertiary} />
              </Pressable>
              {prefPonticOpen && (
                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                  {PONTIC_OPTIONS.map(opt => (
                    <Pressable
                      key={opt}
                      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: prefPontic === opt ? "#F5F3FF" : "transparent", opacity: pressed ? 0.7 : 1 })}
                      onPress={() => { setPrefPontic(opt); setPrefPonticOpen(false); saveProviderPreferences(prefOcclusion, opt, prefContact); if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: prefPontic === opt ? "#8B5CF6" : Colors.light.border, justifyContent: "center", alignItems: "center" }}>
                        {prefPontic === opt && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#8B5CF6" }} />}
                      </View>
                      <Text style={{ fontSize: 14, fontFamily: prefPontic === opt ? "Inter_600SemiBold" : "Inter_400Regular", color: prefPontic === opt ? "#8B5CF6" : Colors.light.text }}>{opt}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              <View style={{ height: 1, backgroundColor: Colors.light.borderLight, marginHorizontal: 16 }} />

              <Pressable
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, opacity: pressed ? 0.7 : 1 })}
                onPress={() => { setPrefContactOpen(!prefContactOpen); setPrefOcclusionOpen(false); setPrefPonticOpen(false); }}
              >
                <Ionicons name="finger-print-outline" size={20} color="#0EA5E9" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text }}>Contact Type</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{prefContact || "Not set"}</Text>
                </View>
                <Feather name={prefContactOpen ? "chevron-up" : "chevron-down"} size={18} color={Colors.light.textTertiary} />
              </Pressable>
              {prefContactOpen && (
                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                  {CONTACT_OPTIONS.map(opt => (
                    <Pressable
                      key={opt}
                      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: prefContact === opt ? "#F0F9FF" : "transparent", opacity: pressed ? 0.7 : 1 })}
                      onPress={() => { setPrefContact(opt); setPrefContactOpen(false); saveProviderPreferences(prefOcclusion, prefPontic, opt); if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                    >
                      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: prefContact === opt ? "#0EA5E9" : Colors.light.border, justifyContent: "center", alignItems: "center" }}>
                        {prefContact === opt && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#0EA5E9" }} />}
                      </View>
                      <Text style={{ fontSize: 14, fontFamily: prefContact === opt ? "Inter_600SemiBold" : "Inter_400Regular", color: prefContact === opt ? "#0EA5E9" : Colors.light.text }}>{opt}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {currentUserData?.role === "admin" && (
              <>
                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginTop: 24, marginBottom: 8, letterSpacing: 0.5 }}>BILLING</Text>
                <Pressable
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.light.surface,
                    borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border,
                    opacity: pressed ? 0.7 : 1,
                  })}
                  onPress={() => { setShowSettings(false); setTimeout(() => { setProviderInvoiceFilter("open"); setShowProviderInvoices(true); }, 350); }}
                >
                  <Ionicons name="document-text-outline" size={20} color={Colors.light.tint} />
                  <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>View Invoices</Text>
                  <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
                </Pressable>
                <Pressable
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.light.surface,
                    borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border,
                    opacity: pressed ? 0.7 : 1,
                  })}
                  onPress={() => {
                    setShowSettings(false);
                    setTimeout(() => {
                      setPayStep("select");
                      setSelectedInvoiceIds([]);
                      setCardNumber(""); setCardExpiry(""); setCardCvc(""); setCardName(""); setCardZip("");
                      setSaveCard(false); setPaidInvoiceIds([]); setPaymentReceiptEmail("");
                      setShowPayInvoices(true);
                    }, 350);
                  }}
                >
                  <Ionicons name="card-outline" size={20} color={Colors.light.success} />
                  <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>Pay Invoices</Text>
                  <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
                </Pressable>
              </>
            )}

            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginTop: 24, marginBottom: 8, letterSpacing: 0.5 }}>ADMINISTRATION</Text>
            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.light.surface,
                borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border,
                opacity: pressed ? 0.7 : 1,
              })}
              onPress={() => { setShowSettings(false); setShowUsersAdmin(true); }}
            >
              <Ionicons name="people-outline" size={20} color={Colors.light.text} />
              <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>Users</Text>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 24, marginBottom: 8 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, letterSpacing: 0.5 }}>CONNECTED LABS</Text>
              <Pressable
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", gap: 4,
                  backgroundColor: pressed ? "#DBEAFE" : Colors.light.tintLight,
                  paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
                  opacity: pressed ? 0.85 : 1,
                })}
                onPress={() => {
                  setLabSearchQuery("");
                  setShowSettings(false);
                  setTimeout(() => {
                    setShowAddLab(true);
                    void loadAvailableLabs(true);
                  }, 350);
                }}
              >
                <Ionicons name="add" size={16} color={Colors.light.tint} />
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>Add a Lab</Text>
              </Pressable>
            </View>
            {!currentUserData?.practiceName ? (
              <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
                <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, textAlign: "center" }}>No connected labs yet</Text>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "#DBEAFE", justifyContent: "center", alignItems: "center" }}>
                  <Ionicons name="business" size={18} color="#2563EB" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{currentUserData.practiceName}</Text>
                  {currentUserData.practiceAddress ? <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{currentUserData.practiceAddress}</Text> : null}
                </View>
                <View style={{ backgroundColor: "#DBEAFE", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#2563EB" }}>Lab</Text>
                </View>
              </View>
            )}

            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                backgroundColor: "#FEE2E2", borderRadius: 14, padding: 16, marginTop: 24,
                opacity: pressed ? 0.7 : 1,
              })}
              onPress={() => {
                Alert.alert("Sign Out", "Are you sure you want to sign out?", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Sign Out", style: "destructive", onPress: () => { setShowSettings(false); logout(); } },
                ]);
              }}
            >
              <Ionicons name="log-out-outline" size={20} color="#DC2626" />
              <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#DC2626" }}>Sign Out</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showAddLab}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowAddLab(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-start" }}>
          <View style={{ backgroundColor: "#FFF", borderBottomLeftRadius: 24, borderBottomRightRadius: 24, maxHeight: "70%", paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingBottom: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Add a Lab</Text>
              <Pressable onPress={() => setShowAddLab(false)} hitSlop={12}>
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>
            <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: Colors.light.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.light.border, paddingHorizontal: 12 }}>
                <Ionicons name="search" size={18} color={Colors.light.textTertiary} />
                <TextInput
                  style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 8, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text }}
                  placeholder="Search lab name..."
                  placeholderTextColor={Colors.light.textTertiary}
                  value={labSearchQuery}
                  onChangeText={setLabSearchQuery}
                  autoFocus
                />
                {labSearchQuery.length > 0 && (
                  <Pressable onPress={() => setLabSearchQuery("")} hitSlop={8}>
                    <Ionicons name="close-circle" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                )}
              </View>
            </View>
            <FlatList
              data={filteredAvailableLabs}
              keyExtractor={item => item.organizationId || item.username}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: lab }) => {
                const alreadyRequested = groupJoinRequests.some(
                  r => r.targetAdminUsername.toLowerCase() === lab.username.toLowerCase()
                    && r.requestingUsername.toLowerCase() === (currentUser || "").toLowerCase()
                    && r.status === "pending"
                );
                return (
                  <Pressable
                    style={({ pressed }) => ({
                      flexDirection: "row", alignItems: "center", gap: 12,
                      backgroundColor: pressed ? Colors.light.tintLight : Colors.light.surface,
                      borderRadius: 14, padding: 14, marginBottom: 8,
                      borderWidth: 1, borderColor: Colors.light.border,
                    })}
                    onPress={() => {
                      if (alreadyRequested) {
                        Alert.alert("Already Requested", "You have already sent a join request to this lab.");
                        return;
                      }
                      Alert.alert(
                        "Join Lab",
                        `Send a join request to "${lab.practiceName}"?`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Send Request",
                            onPress: async () => {
                              const result = await sendGroupJoinRequest(lab.username, currentUser || "", `Provider ${currentUserData?.doctorName || currentUser} would like to join ${lab.practiceName}`);
                              if (result.success) {
                                if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                                Alert.alert("Request Sent", `Your join request has been sent to ${lab.practiceName}. You'll be notified when it's accepted.`);
                                setShowAddLab(false);
                              } else {
                                Alert.alert("Error", result.error || "Could not send request.");
                              }
                            },
                          },
                        ]
                      );
                    }}
                  >
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#DBEAFE", justifyContent: "center", alignItems: "center" }}>
                      <Ionicons name="business" size={20} color="#2563EB" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{lab.practiceName}</Text>
                      {lab.practiceAddress ? <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{lab.practiceAddress}</Text> : null}
                    </View>
                    {alreadyRequested ? (
                      <View style={{ backgroundColor: "#FEF3C7", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                        <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#D97706" }}>Pending</Text>
                      </View>
                    ) : (
                      <View style={{ backgroundColor: "#DCFCE7", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                        <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#16A34A" }}>Join</Text>
                      </View>
                    )}
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <View style={{ alignItems: "center", paddingVertical: 32 }}>
                  <Ionicons name="search-outline" size={36} color={Colors.light.textTertiary} />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginTop: 8, textAlign: "center" }}>
                    {labSearchQuery.trim() ? "No labs found matching your search" : "No available labs to join"}
                  </Text>
                </View>
              }
            />
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showChangePassword}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowChangePassword(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 24 }}>
          <View style={{ backgroundColor: "#FFF", borderRadius: 20, width: "100%", maxWidth: 400, padding: 24 }}>
            <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 20 }}>Change Password</Text>

            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 6 }}>Current Password</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", marginBottom: 16 }}
              secureTextEntry
              value={currentPasswordInput}
              onChangeText={setCurrentPasswordInput}
              placeholder="Enter current password"
            />

            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 6 }}>New Password</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", marginBottom: 16 }}
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="Enter new password"
            />

            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 6 }}>Confirm New Password</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", marginBottom: 16 }}
              secureTextEntry
              value={confirmNewPassword}
              onChangeText={setConfirmNewPassword}
              placeholder="Confirm new password"
            />

            {passwordError && <Text style={{ color: "#DC2626", fontSize: 13, fontFamily: "Inter_500Medium", marginBottom: 12 }}>{passwordError}</Text>}
            {passwordSuccess && <Text style={{ color: "#16A34A", fontSize: 13, fontFamily: "Inter_500Medium", marginBottom: 12 }}>Password changed successfully!</Text>}

            <View style={{ flexDirection: "row", gap: 12 }}>
              <Pressable
                style={({ pressed }) => ({ flex: 1, alignItems: "center" as const, paddingVertical: 14, borderRadius: 12, backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.border, opacity: pressed ? 0.7 : 1 })}
                onPress={() => setShowChangePassword(false)}
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({ flex: 1, alignItems: "center" as const, paddingVertical: 14, borderRadius: 12, backgroundColor: Colors.light.tint, opacity: pressed ? 0.7 : 1 })}
                onPress={async () => {
                  setPasswordError(null);
                  setPasswordSuccess(false);
                  if (!currentPasswordInput.trim()) {
                    setPasswordError("Please enter your current password.");
                    return;
                  }
                  if (newPassword.length < 8) {
                    setPasswordError("New password must be at least 8 characters.");
                    return;
                  }
                  if (!/[A-Z]/.test(newPassword)) {
                    setPasswordError("Must contain an uppercase letter.");
                    return;
                  }
                  if (!/[a-z]/.test(newPassword)) {
                    setPasswordError("Must contain a lowercase letter.");
                    return;
                  }
                  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(newPassword)) {
                    setPasswordError("Must contain a special character.");
                    return;
                  }
                  if (newPassword !== confirmNewPassword) {
                    setPasswordError("Passwords do not match.");
                    return;
                  }
                  const result = await changePassword(currentPasswordInput, newPassword);
                  if (result.success) {
                    setPasswordSuccess(true);
                    setCurrentPasswordInput("");
                    setNewPassword("");
                    setConfirmNewPassword("");
                    setTimeout(() => setShowChangePassword(false), 1500);
                  } else {
                    setPasswordError(result.error || "Failed to change password.");
                  }
                }}
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showUsersAdmin}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowUsersAdmin(false)}
      >
        <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: Colors.light.border }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Users</Text>
            <Pressable onPress={() => setShowUsersAdmin(false)}>
              <Ionicons name="close" size={28} color={Colors.light.text} />
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1, padding: 20 }}>
            {users.length === 0 ? (
              <View style={{ padding: 40, alignItems: "center" }}>
                <Ionicons name="people-outline" size={48} color={Colors.light.textTertiary} />
                <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginTop: 12 }}>No users found</Text>
              </View>
            ) : (
              users.map(u => {
                const regUser = registeredUsers.find(ru => ru.username.toLowerCase() === u.name.toLowerCase());
                return (
                  <View key={u.id} style={{ backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.light.tint, justifyContent: "center", alignItems: "center" }}>
                        <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_700Bold" }}>{u.name.charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{u.name}</Text>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{u.role} · {u.email || "No email"}{regUser?.practiceName ? ` · ${regUser.practiceName}` : ""}</Text>
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showProviderInvoices}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowProviderInvoices(false)}
      >
        <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: Colors.light.border }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Invoices</Text>
            <Pressable onPress={() => setShowProviderInvoices(false)}>
              <Ionicons name="close" size={28} color={Colors.light.text} />
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", margin: 16, backgroundColor: Colors.light.surfaceSecondary, borderRadius: 10, padding: 3 }}>
            <Pressable
              onPress={() => setProviderInvoiceFilter("open")}
              style={{
                flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center",
                backgroundColor: providerInvoiceFilter === "open" ? Colors.light.surface : "transparent",
              }}
            >
              <Text style={{ fontSize: 14, fontFamily: providerInvoiceFilter === "open" ? "Inter_600SemiBold" : "Inter_400Regular", color: providerInvoiceFilter === "open" ? Colors.light.tint : Colors.light.textSecondary }}>Open Invoices</Text>
            </Pressable>
            <Pressable
              onPress={() => setProviderInvoiceFilter("all")}
              style={{
                flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center",
                backgroundColor: providerInvoiceFilter === "all" ? Colors.light.surface : "transparent",
              }}
            >
              <Text style={{ fontSize: 14, fontFamily: providerInvoiceFilter === "all" ? "Inter_600SemiBold" : "Inter_400Regular", color: providerInvoiceFilter === "all" ? Colors.light.tint : Colors.light.textSecondary }}>All Invoices</Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: 16 }}>
            {(() => {
              const filtered = providerInvoiceFilter === "open"
                ? invoices.filter(i => i.status === "open" || i.status === "sent" || i.status === "overdue")
                : invoices;
              if (filtered.length === 0) {
                return (
                  <View style={{ padding: 40, alignItems: "center" }}>
                    <Ionicons name="document-text-outline" size={48} color={Colors.light.textTertiary} />
                    <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginTop: 12 }}>
                      {providerInvoiceFilter === "open" ? "No open invoices" : "No invoices found"}
                    </Text>
                  </View>
                );
              }
              return filtered.sort((a, b) => b.issuedAt - a.issuedAt).map((inv) => {
                const isOverdue = inv.status === "overdue" || (inv.dueAt < Date.now() && inv.status !== "paid");
                const isPaid = inv.status === "paid";
                return (
                  <Pressable key={inv.id} onPress={() => setViewingInvoice(inv)}
                    style={({ pressed }) => ({
                      backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 10,
                      borderWidth: 1, borderColor: isOverdue ? Colors.light.errorLight : Colors.light.border,
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                          <View style={{
                            paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6,
                            backgroundColor: isPaid ? Colors.light.successLight : isOverdue ? Colors.light.errorLight : Colors.light.warningLight,
                          }}>
                            <Text style={{
                              fontSize: 10, fontFamily: "Inter_700Bold", textTransform: "uppercase",
                              color: isPaid ? Colors.light.success : isOverdue ? Colors.light.error : Colors.light.warning,
                            }}>{isOverdue ? "Overdue" : inv.status}</Text>
                          </View>
                        </View>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{inv.patientName || "No patient"}</Text>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 2 }}>
                          Issued: {new Date(inv.issuedAt).toLocaleDateString()} · Due: {new Date(inv.dueAt).toLocaleDateString()}
                        </Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: isOverdue ? Colors.light.error : isPaid ? Colors.light.success : Colors.light.tint }}>
                          ${inv.amount.toFixed(2)}
                        </Text>
                        <Feather name="chevron-right" size={16} color={Colors.light.textTertiary} style={{ marginTop: 4 }} />
                      </View>
                    </View>
                    {inv.lineItems && inv.lineItems.length > 0 && (
                      <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.light.border }}>
                        {inv.lineItems.map((li, liIdx) => (
                          <View key={liIdx} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
                            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, flex: 1 }}>{li.item} - {li.description}</Text>
                            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>${li.amount.toFixed(2)}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </Pressable>
                );
              });
            })()}
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showPayInvoices}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowPayInvoices(false)}
      >
        <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: Colors.light.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {payStep !== "select" && payStep !== "receipt" && (
                <Pressable onPress={() => setPayStep("select")}>
                  <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
                </Pressable>
              )}
              <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>
                {payStep === "select" ? "Pay Invoices" : payStep === "card" ? "Payment" : "Receipt"}
              </Text>
            </View>
            <Pressable onPress={() => setShowPayInvoices(false)}>
              <Ionicons name="close" size={28} color={Colors.light.text} />
            </Pressable>
          </View>

          {payStep === "select" && (() => {
            const openInvs = invoices.filter(i => i.status === "open" || i.status === "sent" || i.status === "overdue");
            const selectedTotal = openInvs.filter(i => selectedInvoiceIds.includes(i.id)).reduce((sum, i) => sum + i.amount, 0);
            return (
              <View style={{ flex: 1 }}>
                <ScrollView style={{ flex: 1, paddingHorizontal: 16, paddingTop: 16 }}>
                  {openInvs.length === 0 ? (
                    <View style={{ padding: 40, alignItems: "center" }}>
                      <Ionicons name="checkmark-circle-outline" size={48} color={Colors.light.success} />
                      <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginTop: 12 }}>All Caught Up!</Text>
                      <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 4, textAlign: "center" }}>You have no open invoices to pay.</Text>
                    </View>
                  ) : (
                    <>
                      <Pressable
                        onPress={() => {
                          if (selectedInvoiceIds.length === openInvs.length) {
                            setSelectedInvoiceIds([]);
                          } else {
                            setSelectedInvoiceIds(openInvs.map(i => i.id));
                          }
                        }}
                        style={({ pressed }) => ({
                          flexDirection: "row", alignItems: "center", gap: 10,
                          backgroundColor: Colors.light.tintLight, borderRadius: 12, padding: 14, marginBottom: 12,
                          opacity: pressed ? 0.8 : 1,
                        })}
                      >
                        <Ionicons
                          name={selectedInvoiceIds.length === openInvs.length ? "checkbox" : "square-outline"}
                          size={22} color={Colors.light.tint}
                        />
                        <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.tint, flex: 1 }}>
                          {selectedInvoiceIds.length === openInvs.length ? "Deselect All" : "Pay All Open Invoices"}
                        </Text>
                        <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.tint }}>
                          ${openInvs.reduce((s, i) => s + i.amount, 0).toFixed(2)}
                        </Text>
                      </Pressable>

                      {openInvs.sort((a, b) => a.dueAt - b.dueAt).map((inv) => {
                        const selected = selectedInvoiceIds.includes(inv.id);
                        const isOverdue = inv.status === "overdue" || (inv.dueAt < Date.now() && inv.status !== "paid");
                        return (
                          <View key={inv.id} style={{
                            flexDirection: "row", alignItems: "center",
                            backgroundColor: selected ? "#EFF6FF" : Colors.light.surface,
                            borderRadius: 14, marginBottom: 8,
                            borderWidth: selected ? 2 : 1,
                            borderColor: selected ? Colors.light.tint : isOverdue ? Colors.light.errorLight : Colors.light.border,
                            overflow: "hidden",
                          }}>
                            <Pressable
                              onPress={() => {
                                setSelectedInvoiceIds(prev =>
                                  prev.includes(inv.id) ? prev.filter(id => id !== inv.id) : [...prev, inv.id]
                                );
                              }}
                              style={{ padding: 14, justifyContent: "center" }}
                            >
                              <Ionicons
                                name={selected ? "checkbox" : "square-outline"}
                                size={22} color={selected ? Colors.light.tint : Colors.light.textTertiary}
                              />
                            </Pressable>
                            <Pressable
                              onPress={() => setViewingInvoice(inv)}
                              style={({ pressed }) => ({
                                flex: 1, flexDirection: "row", alignItems: "center", paddingRight: 14, paddingVertical: 14,
                                opacity: pressed ? 0.7 : 1,
                              })}
                            >
                              <View style={{ flex: 1 }}>
                                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                                  {isOverdue && (
                                    <View style={{ backgroundColor: Colors.light.errorLight, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 }}>
                                      <Text style={{ fontSize: 9, fontFamily: "Inter_700Bold", color: Colors.light.error }}>OVERDUE</Text>
                                    </View>
                                  )}
                                </View>
                                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>
                                  {inv.patientName || inv.clientName} · Due {new Date(inv.dueAt).toLocaleDateString()}
                                </Text>
                              </View>
                              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: isOverdue ? Colors.light.error : Colors.light.text }}>
                                ${inv.amount.toFixed(2)}
                              </Text>
                            </Pressable>
                          </View>
                        );
                      })}
                    </>
                  )}

                  {(() => {
                    const paidInvs = invoices.filter(i => i.status === "paid");
                    if (paidInvs.length === 0) return null;
                    return (
                      <>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginTop: 20, marginBottom: 10, letterSpacing: 0.5 }}>PAID INVOICES</Text>
                        {paidInvs.sort((a, b) => b.issuedAt - a.issuedAt).map((inv) => (
                          <Pressable key={inv.id} onPress={() => setViewingInvoice(inv)}
                            style={({ pressed }) => ({
                              flexDirection: "row", alignItems: "center", gap: 12,
                              backgroundColor: Colors.light.surface, borderRadius: 14, padding: 14, marginBottom: 8,
                              borderWidth: 1, borderColor: Colors.light.border, opacity: pressed ? 0.85 : 1,
                            })}
                          >
                            <Ionicons name="checkmark-circle" size={22} color={Colors.light.success} />
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>
                                {inv.patientName || inv.clientName}
                              </Text>
                            </View>
                            <View style={{ alignItems: "flex-end" }}>
                              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.success }}>${inv.amount.toFixed(2)}</Text>
                              <Text style={{ fontSize: 10, fontFamily: "Inter_500Medium", color: Colors.light.success }}>Paid</Text>
                            </View>
                          </Pressable>
                        ))}
                      </>
                    );
                  })()}
                  <View style={{ height: 120 }} />
                </ScrollView>

                {selectedInvoiceIds.length > 0 && (
                  <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16, backgroundColor: Colors.light.backgroundSolid, borderTopWidth: 1, borderTopColor: Colors.light.border }}>
                    <Pressable
                      onPress={() => setPayStep("card")}
                      style={({ pressed }) => ({
                        backgroundColor: pressed ? "#1D4ED8" : Colors.light.tint, borderRadius: 14, paddingVertical: 16, alignItems: "center",
                      })}
                    >
                      <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFF" }}>
                        Continue to Payment · ${selectedTotal.toFixed(2)}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })()}

          {payStep === "card" && (() => {
            const selectedTotal = invoices.filter(i => selectedInvoiceIds.includes(i.id)).reduce((sum, i) => sum + i.amount, 0);

            function formatCardNumber(val: string) {
              const digits = val.replace(/\D/g, "").slice(0, 16);
              return digits.replace(/(.{4})/g, "$1 ").trim();
            }
            function formatExpiry(val: string) {
              const digits = val.replace(/\D/g, "").slice(0, 4);
              if (digits.length > 2) return digits.slice(0, 2) + "/" + digits.slice(2);
              return digits;
            }

            return (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
                <View style={{ backgroundColor: Colors.light.tintLight, borderRadius: 14, padding: 16, marginBottom: 20, alignItems: "center" }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>Total Amount</Text>
                  <Text style={{ fontSize: 32, fontFamily: "Inter_700Bold", color: Colors.light.tint, marginTop: 4 }}>${selectedTotal.toFixed(2)}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 4 }}>
                    {selectedInvoiceIds.length} invoice{selectedInvoiceIds.length !== 1 ? "s" : ""}
                  </Text>
                </View>

                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 10, letterSpacing: 0.5 }}>CARD INFORMATION</Text>
                <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, overflow: "hidden" }}>
                  <TextInput
                    placeholder="Name on card"
                    value={cardName}
                    onChangeText={setCardName}
                    style={{ padding: 16, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, borderBottomWidth: 1, borderBottomColor: Colors.light.border }}
                    placeholderTextColor={Colors.light.textTertiary}
                  />
                  <TextInput
                    placeholder="Card number"
                    value={cardNumber}
                    onChangeText={(t) => setCardNumber(formatCardNumber(t))}
                    keyboardType="number-pad"
                    maxLength={19}
                    style={{ padding: 16, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, borderBottomWidth: 1, borderBottomColor: Colors.light.border }}
                    placeholderTextColor={Colors.light.textTertiary}
                  />
                  <View style={{ flexDirection: "row" }}>
                    <TextInput
                      placeholder="MM/YY"
                      value={cardExpiry}
                      onChangeText={(t) => setCardExpiry(formatExpiry(t))}
                      keyboardType="number-pad"
                      maxLength={5}
                      style={{ flex: 1, padding: 16, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, borderRightWidth: 1, borderRightColor: Colors.light.border }}
                      placeholderTextColor={Colors.light.textTertiary}
                    />
                    <TextInput
                      placeholder="CVC"
                      value={cardCvc}
                      onChangeText={(t) => setCardCvc(t.replace(/\D/g, "").slice(0, 4))}
                      keyboardType="number-pad"
                      maxLength={4}
                      secureTextEntry
                      style={{ flex: 1, padding: 16, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text }}
                      placeholderTextColor={Colors.light.textTertiary}
                    />
                  </View>
                </View>

                <TextInput
                  placeholder="Billing ZIP code"
                  value={cardZip}
                  onChangeText={(t) => setCardZip(t.replace(/\D/g, "").slice(0, 5))}
                  keyboardType="number-pad"
                  maxLength={5}
                  style={{ marginTop: 12, padding: 16, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border }}
                  placeholderTextColor={Colors.light.textTertiary}
                />

                <Pressable
                  onPress={() => setSaveCard(!saveCard)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16, paddingVertical: 8 }}
                >
                  <Ionicons name={saveCard ? "checkbox" : "square-outline"} size={22} color={Colors.light.tint} />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text }}>Keep this card on file for future payments</Text>
                </Pressable>

                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginTop: 20, marginBottom: 10, letterSpacing: 0.5 }}>SEND RECEIPT TO</Text>
                <TextInput
                  placeholder="Email address"
                  value={paymentReceiptEmail}
                  onChangeText={setPaymentReceiptEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  style={{ padding: 16, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border }}
                  placeholderTextColor={Colors.light.textTertiary}
                />

                <Pressable
                  disabled={payProcessing || !cardNumber || !cardExpiry || !cardCvc || !cardName}
                  onPress={async () => {
                    setPayProcessing(true);
                    await new Promise(r => setTimeout(r, 2000));
                    const now = Date.now();
                    for (const invId of selectedInvoiceIds) {
                      updateInvoice(invId, { status: "paid" });
                    }
                    const paidInvs = invoices.filter(i => selectedInvoiceIds.includes(i.id));
                    const totalPaid = paidInvs.reduce((s, i) => s + i.amount, 0);
                    addNotification({
                      type: "alert",
                      title: "Payment Received",
                      message: `Payment received: $${totalPaid.toFixed(2)} for ${paidInvs.length} invoice${paidInvs.length !== 1 ? "s" : ""} from ${currentUser || "Provider"}`,
                      caseId: "",
                    });
                    setPaidInvoiceIds([...selectedInvoiceIds]);
                    setPayProcessing(false);
                    setPayStep("receipt");
                  }}
                  style={({ pressed }) => ({
                    marginTop: 24, backgroundColor: (!cardNumber || !cardExpiry || !cardCvc || !cardName) ? Colors.light.textTertiary : pressed ? "#1D4ED8" : Colors.light.tint,
                    borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 40,
                  })}
                >
                  {payProcessing ? (
                    <ActivityIndicator color="#FFF" />
                  ) : (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Ionicons name="lock-closed" size={18} color="#FFF" />
                      <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFF" }}>Pay ${selectedTotal.toFixed(2)}</Text>
                    </View>
                  )}
                </Pressable>

                <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, marginBottom: 30 }}>
                  <Ionicons name="shield-checkmark" size={14} color={Colors.light.textTertiary} />
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary }}>Secure payment processing</Text>
                </View>
              </ScrollView>
            );
          })()}

          {payStep === "receipt" && (() => {
            const paidInvs = invoices.filter(i => paidInvoiceIds.includes(i.id));
            const totalPaid = paidInvs.reduce((s, i) => s + i.amount, 0);
            return (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, alignItems: "center" }}>
                <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.light.successLight, justifyContent: "center", alignItems: "center", marginTop: 24 }}>
                  <Ionicons name="checkmark-circle" size={48} color={Colors.light.success} />
                </View>
                <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text, marginTop: 16 }}>Payment Successful</Text>
                <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 6, textAlign: "center" }}>
                  Your payment of ${totalPaid.toFixed(2)} has been processed.
                </Text>
                {paymentReceiptEmail ? (
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 4, textAlign: "center" }}>
                    A receipt has been sent to {paymentReceiptEmail}
                  </Text>
                ) : null}

                <View style={{ width: "100%", backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, marginTop: 24, padding: 16 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 12, letterSpacing: 0.5 }}>PAID INVOICES</Text>
                  {paidInvs.map((inv) => (
                    <View key={inv.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.light.border }}>
                      <View>
                        <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{formatInvNum(inv.invoiceNumber)}</Text>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{inv.patientName || inv.clientName}</Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.success }}>${inv.amount.toFixed(2)}</Text>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                          <Ionicons name="checkmark-circle" size={12} color={Colors.light.success} />
                          <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: Colors.light.success }}>Paid</Text>
                        </View>
                      </View>
                    </View>
                  ))}
                  <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 12, marginTop: 4 }}>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Total Paid</Text>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.success }}>${totalPaid.toFixed(2)}</Text>
                  </View>
                </View>

                <View style={{ width: "100%", backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, marginTop: 12, padding: 16 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Date</Text>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.text }}>{new Date().toLocaleDateString()}</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Card</Text>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.text }}>····{cardNumber.replace(/\s/g, "").slice(-4)}</Text>
                  </View>
                  {saveCard && (
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                      <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Card saved</Text>
                      <Ionicons name="checkmark-circle" size={16} color={Colors.light.success} />
                    </View>
                  )}
                </View>

                <Pressable
                  onPress={() => { setShowPayInvoices(false); setPayStep("select"); setSelectedInvoiceIds([]); }}
                  style={({ pressed }) => ({
                    width: "100%", marginTop: 24, backgroundColor: pressed ? "#1D4ED8" : Colors.light.tint,
                    borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 40,
                  })}
                >
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFF" }}>Done</Text>
                </Pressable>
              </ScrollView>
            );
          })()}
        </View>
      </Modal>

      <Modal
        transparent
        visible={!!viewingInvoice}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setViewingInvoice(null)}
      >
        {viewingInvoice && (
          <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
            <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: Colors.light.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Pressable onPress={() => setViewingInvoice(null)}>
                  <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
                </Pressable>
                <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Invoice</Text>
              </View>
              <Pressable onPress={() => setViewingInvoice(null)}>
                <Ionicons name="close" size={28} color={Colors.light.text} />
              </Pressable>
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
              <View style={{ alignItems: "center", marginBottom: 24 }}>
                <Text style={{ fontSize: 28, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{formatInvNum(viewingInvoice.invoiceNumber)}</Text>
                <View style={{
                  marginTop: 8, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8,
                  backgroundColor: viewingInvoice.status === "paid" ? Colors.light.successLight
                    : (viewingInvoice.status === "overdue" || viewingInvoice.dueAt < Date.now()) ? Colors.light.errorLight
                    : Colors.light.warningLight,
                }}>
                  <Text style={{
                    fontSize: 13, fontFamily: "Inter_700Bold", textTransform: "uppercase",
                    color: viewingInvoice.status === "paid" ? Colors.light.success
                      : (viewingInvoice.status === "overdue" || viewingInvoice.dueAt < Date.now()) ? Colors.light.error
                      : Colors.light.warning,
                  }}>
                    {viewingInvoice.status === "overdue" || viewingInvoice.dueAt < Date.now() ? "Overdue" : viewingInvoice.status}
                  </Text>
                </View>
              </View>

              <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 16, marginBottom: 16 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Bill To</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.text, textAlign: "right", maxWidth: "60%" }}>{viewingInvoice.billTo || viewingInvoice.clientName}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Patient</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{viewingInvoice.patientName || "—"}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Case Type</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{viewingInvoice.caseType || "—"}</Text>
                </View>
                {viewingInvoice.teeth ? (
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Teeth</Text>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>#{viewingInvoice.teeth}</Text>
                  </View>
                ) : null}
                {viewingInvoice.shade ? (
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Shade</Text>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{viewingInvoice.shade}</Text>
                  </View>
                ) : null}
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Issued</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{new Date(viewingInvoice.issuedAt).toLocaleDateString()}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>Due</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: (viewingInvoice.dueAt < Date.now() && viewingInvoice.status !== "paid") ? Colors.light.error : Colors.light.text }}>{new Date(viewingInvoice.dueAt).toLocaleDateString()}</Text>
                </View>
              </View>

              {viewingInvoice.caseNotes ? (
                <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 16, marginBottom: 16 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>Notes</Text>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text, lineHeight: 20 }}>{viewingInvoice.caseNotes}</Text>
                </View>
              ) : null}

              <View style={{ backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 16, marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 12 }}>LINE ITEMS</Text>
                {viewingInvoice.lineItems && viewingInvoice.lineItems.length > 0 ? viewingInvoice.lineItems.map((li, idx) => (
                  <View key={idx} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 8, borderBottomWidth: idx < viewingInvoice.lineItems.length - 1 ? 1 : 0, borderBottomColor: Colors.light.border }}>
                    <View style={{ flex: 1, marginRight: 12 }}>
                      <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text }}>{li.item}</Text>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 2 }}>{li.description}</Text>
                      {li.qty > 1 && <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 2 }}>Qty: {li.qty} × ${li.rate.toFixed(2)}</Text>}
                    </View>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text }}>${li.amount.toFixed(2)}</Text>
                  </View>
                )) : (
                  <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 }}>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text }}>Service</Text>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.light.text }}>${viewingInvoice.amount.toFixed(2)}</Text>
                  </View>
                )}
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTopWidth: 2, borderTopColor: Colors.light.text }}>
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Total</Text>
                  <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: viewingInvoice.status === "paid" ? Colors.light.success : Colors.light.tint }}>${viewingInvoice.amount.toFixed(2)}</Text>
                </View>
                {viewingInvoice.credits > 0 && (
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.success }}>Credits Applied</Text>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.light.success }}>-${viewingInvoice.credits.toFixed(2)}</Text>
                  </View>
                )}
              </View>

              <View style={{ height: 40 }} />
            </ScrollView>
          </View>
        )}
      </Modal>

    </View>
  );
}

const provStyles = StyleSheet.create({
  caseCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  caseName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  caseSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  caseStatus: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
  caseDue: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
});

type MasterView = "hub" | "all-users" | "lab-portal" | "provider-portal";

function MasterAdminDashboard({ onExitHub }: { onExitHub: () => void }) {
  const { cases, clients, users, invoices, hardRefresh } = useApp();
  const { currentUser, registeredUsers, logout } = useAuth();
  const insets = useSafeAreaInsets();

  const [masterView, setMasterView] = useState<MasterView>("hub");
  const [groupSearch, setGroupSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const totalUsers = registeredUsers.length;
  const totalCases = cases.length;

  async function handleRefresh() {
    setRefreshing(true);
    await hardRefresh();
    setRefreshing(false);
  }

  function renderBackHeader(title: string, backTo: MasterView = "hub") {
    return (
      <View style={{ paddingHorizontal: 20, flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
        <Pressable onPress={() => { setMasterView(backTo); setGroupSearch(""); }} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text, flex: 1 }}>{title}</Text>
      </View>
    );
  }

  function renderMasterHub() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          ) : undefined
        }
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>Master Admin</Text>
            <Text style={styles.headerTitle}>Control Center</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {Platform.OS === "web" && (
              <Pressable onPress={handleRefresh}>
                {refreshing ? (
                  <ActivityIndicator size={18} color={Colors.light.text} />
                ) : (
                  <Ionicons name="refresh" size={22} color={Colors.light.text} />
                )}
              </Pressable>
            )}
            <Pressable onPress={onExitHub} style={adm.exitBtn} accessibilityLabel="Close Master Hub">
              <Ionicons name="close" size={20} color={Colors.light.textSecondary} />
            </Pressable>
            <Pressable onPress={logout} style={adm.exitBtn} accessibilityLabel="Sign out">
              <Ionicons name="log-out-outline" size={20} color={Colors.light.textSecondary} />
            </Pressable>
          </View>
        </View>

        <LinearGradient
          colors={["#1a1a2e", "#16213e", "#0f3460"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <Ionicons name="shield-checkmark" size={24} color="#FFD700" style={{ marginRight: 8 }} />
            <Text style={[styles.heroLabel, { opacity: 0.7, color: "#FFD700" }]}>MASTER ADMIN</Text>
          </View>
          <Text style={[styles.heroCount, { fontSize: 22 }]}>JP Phillips</Text>
          <View style={adm.heroBadgeRow}>
            <View style={[adm.heroBadge, { backgroundColor: "rgba(255,215,0,0.2)" }]}>
              <Text style={[adm.heroBadgeText, { color: "#FFD700" }]}>{totalUsers} Users</Text>
            </View>
            <View style={[adm.heroBadge, { backgroundColor: "rgba(255,215,0,0.2)" }]}>
              <Text style={[adm.heroBadgeText, { color: "#FFD700" }]}>{totalCases} Cases</Text>
            </View>
          </View>
        </LinearGradient>

        <View style={adm.menuSection}>
          {[
            { icon: "people" as const, color: "#8B5CF6", bg: "#EDE9FE", title: "All Users", sub: `${totalUsers} registered users`, view: "all-users" as MasterView },
            { icon: "flask" as const, color: "#0EA5E9", bg: "#E0F2FE", title: "Lab Portal", sub: `${cases.length} cases · ${clients.length} clients`, view: "lab-portal" as MasterView },
            { icon: "medical" as const, color: "#3B82F6", bg: "#DBEAFE", title: "Provider Portal", sub: "View provider accounts", view: "provider-portal" as MasterView },
          ].map((item) => (
            <Pressable
              key={item.view}
              style={({ pressed }) => [adm.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => setMasterView(item.view)}
            >
              <View style={[adm.menuIcon, { backgroundColor: item.bg }]}>
                <Ionicons name={item.icon} size={20} color={item.color} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{item.title}</Text>
                <Text style={adm.menuSub}>{item.sub}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  function renderAllUsers() {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          ) : undefined
        }
      >
        {renderBackHeader("All Users")}
        {registeredUsers.filter((u) => (u.userType as string) !== "master_admin").map((u, idx) => (
            <View key={u.username + idx} style={[adm.menuItem, { marginHorizontal: 20 }]}>
              <View style={[adm.menuIcon, { backgroundColor: u.userType === "provider" ? "#DBEAFE" : u.userType === "master_admin" ? "#FEF3C7" : "#E0F2FE" }]}>
                <Ionicons name={u.userType === "provider" ? "medical" : u.userType === "master_admin" ? "shield-checkmark" : "person"} size={20} color={u.userType === "provider" ? "#3B82F6" : u.userType === "master_admin" ? "#D97706" : "#0EA5E9"} />
              </View>
              <View style={[adm.menuInfo, { flex: 1 }]}>
                <Text style={adm.menuTitle}>{u.username}{u.doctorName ? ` (Dr. ${u.doctorName})` : ""}</Text>
                <Text style={adm.menuSub}>
                  {u.userType === "provider" ? "Provider" : u.userType === "master_admin" ? "Master Admin" : "Lab"} · {u.role === "admin" ? "Admin" : "User"}
                  {u.accountNumber ? ` · ${formatAcctNum(u.accountNumber)}` : ""}
                  {u.practiceName ? ` · ${u.practiceName}` : ""}
                </Text>
              </View>
            </View>
          ))}
      </ScrollView>
    );
  }

  function renderLabPortal() {
    const totalRevenue = cases.reduce((sum, c) => sum + c.price, 0);
    const labUsers = registeredUsers.filter(
      (u) => (u.userType === "lab" || !u.userType) && (u.userType as string) !== "master_admin",
    );
    const openInvoiceCount = invoices.filter(i => i.status === "open" || i.status === "overdue").length;
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          ) : undefined
        }
      >
        {renderBackHeader("Lab Portal Overview")}
        <View style={{ marginHorizontal: 20, gap: 12 }}>
          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 8 }}>LAB STATS</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              {[
                { val: cases.length, label: "Cases" },
                { val: clients.length, label: "Clients" },
                { val: labUsers.length, label: "Users" },
                { val: openInvoiceCount, label: "Open Inv." },
              ].map((s) => (
                <View key={s.label} style={{ alignItems: "center" }}>
                  <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{s.val}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{s.label}</Text>
                </View>
              ))}
            </View>
          </View>
          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 8 }}>REVENUE</Text>
            <Text style={{ fontSize: 24, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{formatCurrency(totalRevenue)}</Text>
          </View>
          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 8 }}>LAB USERS</Text>
            {labUsers.map((u, i) => (
              <View key={u.username + i} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: Colors.light.border }}>
                <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: u.role === "admin" ? Colors.light.tintLight : Colors.light.successLight, justifyContent: "center", alignItems: "center", marginRight: 10 }}>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: u.role === "admin" ? Colors.light.tint : Colors.light.success }}>{u.username.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{u.username}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{u.role === "admin" ? "Admin" : "User"}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderProviderPortal() {
    const providers = registeredUsers.filter(u => u.userType === "provider");
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          ) : undefined
        }
      >
        {renderBackHeader("Provider Portal Overview")}
        <View style={{ marginHorizontal: 20, gap: 12 }}>
          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 8 }}>PROVIDERS ({providers.length})</Text>
            {providers.length === 0 ? (
              <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", padding: 20 }}>No providers registered yet</Text>
            ) : (
              providers.map((p, i) => {
                const provCases = cases.filter(c => c.doctorName.toLowerCase().includes((p.doctorName || p.username || "").toLowerCase()));
                return (
                  <View key={p.username + i} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: Colors.light.border }}>
                    <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: "#DBEAFE", justifyContent: "center", alignItems: "center", marginRight: 12 }}>
                      <Ionicons name="medical" size={18} color="#3B82F6" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{p.doctorName ? `Dr. ${p.doctorName}` : p.username}</Text>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>
                        {p.accountNumber ? formatAcctNum(p.accountNumber) : "N/A"} · {provCases.length} cases · {p.role === "admin" ? "Admin" : "User"}
                        {p.practiceName ? ` · ${p.practiceName}` : ""}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>
    );
  }

  switch (masterView) {
    case "all-users": return renderAllUsers();
    case "lab-portal": return renderLabPortal();
    case "provider-portal": return renderProviderPortal();
    default: return renderMasterHub();
  }
}

export default function DashboardScreen() {
  const { role, adminUnlocked, isLoading } = useApp();
  const { userType } = useAuth();
  const [masterHubExited, setMasterHubExited] = useState(false);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.light.tint} />
      </View>
    );
  }

  if (userType === "master_admin" && !masterHubExited) {
    return <MasterAdminDashboard onExitHub={() => setMasterHubExited(true)} />;
  }

  if (userType === "master_admin" && masterHubExited) {
    return <TechDashboard onReopenMasterHub={() => setMasterHubExited(false)} />;
  }

  if (userType === "provider") {
    return <ProviderDashboard />;
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
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  hamburgerBtn: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarSection: {
    alignItems: "center",
    marginBottom: 24,
    gap: 8,
  },
  avatarRing: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: "center",
    alignItems: "center",
    padding: 3,
  },
  avatarInner: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarImage: {
    width: 74,
    height: 74,
    borderRadius: 37,
  },
  avatarEditBadge: {
    position: "absolute" as const,
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.light.tint,
    justifyContent: "center" as const,
    alignItems: "center" as const,
    borderWidth: 2,
    borderColor: "#FFF",
  },
  picModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end" as const,
  },
  picModalContent: {
    backgroundColor: "#FFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingBottom: 40,
    paddingTop: 12,
  },
  picModalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D1D5DB",
    alignSelf: "center" as const,
    marginBottom: 16,
  },
  picModalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 16,
    textAlign: "center" as const,
  },
  picModalOption: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderRadius: 12,
    gap: 14,
  },
  picModalOptionIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center" as const,
    alignItems: "center" as const,
  },
  picModalOptionText: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  picModalCancel: {
    marginTop: 12,
    paddingVertical: 14,
    alignItems: "center" as const,
    backgroundColor: "#F1F5F9",
    borderRadius: 14,
  },
  picModalCancelText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
  },
  employeeName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginTop: 6,
  },
  avatarName: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  headerQuickActions: {
    flexDirection: "row" as const,
    gap: 12,
    marginTop: 14,
    width: "100%",
    paddingHorizontal: 16,
  },
  headerQuickBtn: {
    flex: 1,
    flexDirection: "column" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 6,
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  adminBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
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
    paddingVertical: 6,
    borderRadius: 8,
  },
  heroStatActive: {
    backgroundColor: "rgba(255,255,255,0.15)",
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
  filterSection: {
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  filterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  filterTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  filterEmpty: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 8,
  },
  filterEmptyText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
  },
  trackingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: 140,
  },
  trackingText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#6366F1",
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
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    textAlign: "center" as const,
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
  dueTodayBadge: {
    backgroundColor: "#FEF2F2",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  dueTodayBadgeText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: "#EF4444",
  },
  dueTodayEmpty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.light.successLight,
    borderRadius: 16,
    padding: 18,
    marginHorizontal: 20,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(34,197,94,0.15)",
  },
  dueTodayEmptyText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.success,
  },
  dueTodayCard: {
    borderLeftWidth: 3,
    borderLeftColor: "#F59E0B",
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
  casePatient: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
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
  userInitialsBadge: {
    backgroundColor: Colors.light.tint + "18",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  userInitialsText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
    letterSpacing: 0.3,
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
    borderRadius: 20,
  },
  unlockBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  scanningFaceWrap: {
    marginTop: 16,
    padding: 16,
    borderRadius: 20,
    backgroundColor: Colors.light.tintLight,
  },
  aiChatCard: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  aiChatIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center" as const,
    alignItems: "center" as const,
  },
  aiChatInfo: {
    flex: 1,
  },
  aiChatTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  aiChatSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
});

const adm = StyleSheet.create({
  exitBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: Colors.light.surfaceSecondary,
    justifyContent: "center",
    alignItems: "center",
  },
  heroBadgeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
    flexWrap: "wrap",
  },
  heroBadge: {
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  heroBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.7)",
  },
  menuSection: {
    paddingHorizontal: 20,
    gap: 8,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    gap: 14,
  },
  menuIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  menuInfo: {
    flex: 1,
  },
  menuTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  menuSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
  },
  subHeaderTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  formArea: {
    paddingHorizontal: 20,
  },
  formDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginBottom: 24,
  },
  field: {
    marginBottom: 18,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  fieldRow: {
    flexDirection: "row",
    gap: 12,
  },
  input: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    padding: 14,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.light.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  chipActive: {
    backgroundColor: Colors.light.tintLight,
    borderColor: Colors.light.tint,
  },
  chipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  chipTextActive: {
    color: Colors.light.tint,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    borderRadius: 18,
    marginTop: 8,
  },
  submitBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  listArea: {
    paddingHorizontal: 20,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginBottom: 8,
  },
  listItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  listAvatar: {
    width: 40,
    height: 40,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  listAvatarText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  listItemTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  listItemSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  tierBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: Colors.light.surfaceSecondary,
  },
  tierBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  toggleActiveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.light.successLight,
    borderWidth: 1,
    borderColor: Colors.light.success,
    borderRadius: 14,
    padding: 16,
    marginBottom: 18,
  },
  toggleActiveBtnInactive: {
    backgroundColor: Colors.light.errorLight,
    borderColor: Colors.light.error,
  },
  toggleActiveText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.success,
  },
  removeUserBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#EF4444",
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
  },
  removeUserBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  confirmCard: {
    backgroundColor: "#FFF",
    borderRadius: 24,
    padding: 28,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
  },
  confirmIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#FEF2F2",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 18,
  },
  confirmTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    textAlign: "center",
    marginBottom: 8,
  },
  confirmDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  confirmBtns: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  confirmYesBtn: {
    flex: 1,
    backgroundColor: "#EF4444",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  confirmYesText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  confirmNoBtn: {
    flex: 1,
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  confirmNoText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  invoiceSummary: {
    flexDirection: "row",
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginBottom: 16,
  },
  invoiceSummaryItem: {
    flex: 1,
    alignItems: "center",
  },
  invoiceSummaryNum: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  invoiceSummaryLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  invoiceSummaryDivider: {
    width: 1,
    height: 36,
    backgroundColor: Colors.light.border,
  },
  invoiceCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginBottom: 8,
  },
  invoiceCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  invoiceNumber: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  invoiceClient: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  invoiceAmount: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  invoiceCardBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  invoiceDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  invoiceStatus: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  invoiceStatusText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  statementCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginBottom: 8,
  },
  salesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 24,
  },
  salesCard: {
    width: "48%" as any,
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  salesCardLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  salesCardValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  salesSectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 12,
  },
  materialRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    gap: 10,
  },
  materialInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    width: 130,
  },
  materialDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  materialName: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  materialCount: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  materialBarWrap: {
    flex: 1,
    height: 8,
    backgroundColor: Colors.light.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  materialBar: {
    height: "100%",
    borderRadius: 4,
  },
  materialRevenue: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    width: 70,
    textAlign: "right" as const,
  },
  clientRevenueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: Colors.light.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.light.border,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    marginBottom: 8,
  },
  clientRevenueAmount: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
});

const invStyles = StyleSheet.create({
  summaryCard: {
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    gap: 4,
  },
  summaryNum: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
  },
  summaryLabel: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: Colors.light.surfaceSecondary,
    justifyContent: "center",
    alignItems: "center",
  },
  qtyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    minWidth: 40,
    alignItems: "center",
  },
  qtyText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
  },
  modalContent: {
    backgroundColor: "#FFF",
    borderRadius: 24,
    padding: 24,
    marginHorizontal: 20,
    maxHeight: "80%",
  },
  deleteBtn: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: "#FEF2F2",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  joinRequestSection: {
    paddingHorizontal: 20,
    marginTop: 16,
  },
  joinReqCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#EFF6FF",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#BFDBFE",
    gap: 14,
    marginBottom: 10,
  },
  joinReqIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  joinReqContent: {
    flex: 1,
  },
  joinReqTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  joinReqName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  joinReqPractice: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  joinReqMsg: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.subText,
    marginTop: 4,
    lineHeight: 18,
  },
  joinReqBtns: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  joinReqAcceptBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#16A34A",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  joinReqAcceptText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  joinReqDeclineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  joinReqDeclineText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#EF4444",
  },
  joinReqOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  joinReqConfirmCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
  },
  joinReqConfirmIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  joinReqConfirmTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    textAlign: "center",
    marginBottom: 8,
  },
  joinReqConfirmDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.subText,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  joinReqConfirmBtns: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  joinReqConfirmYesBtn: {
    flex: 1,
    backgroundColor: Colors.light.tint,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  joinReqConfirmYesText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  joinReqConfirmNoBtn: {
    flex: 1,
    backgroundColor: Colors.light.surfaceAlt,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  joinReqConfirmNoText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  aiChatCard: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  aiChatIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center" as const,
    alignItems: "center" as const,
  },
  aiChatInfo: {
    flex: 1,
  },
  aiChatTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  aiChatSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
});
