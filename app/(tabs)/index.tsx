import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  ActivityIndicator,
  TextInput,
  Alert,
  Modal,
  Dimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as LocalAuthentication from "expo-local-authentication";
import { router } from "expo-router";
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
import Colors from "@/constants/colors";
import { CameraView, useCameraPermissions } from "expo-camera";
import { getStationInfo, Client, LabUser, Invoice, InvoiceLineItem, DEFAULT_TIER_ITEMS, InventoryItem, CaseStatus, Group } from "@/lib/data";
import { apiRequest } from "@/lib/query-client";

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
                <Text style={drawerStyles.brandName}>DriveSync Lab</Text>
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

function TechDashboard() {
  const { cases, activeCaseCount, rushCaseCount, setRole, shippingAccounts, addTrackingNumber, role, batchLocateCases, findCaseByBarcode, updateCaseStatus } = useApp();
  const { logout, profilePicUri, setProfilePicUri, currentUser, registeredUsers } = useAuth();
  const { colors: themeColors, isDark: isDarkMode } = useTheme();
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
  const lastBatchScanRef = useRef<string>("");
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
  const isLabAdmin = currentUserData?.role === "admin";
  const recentCases = cases
    .filter((c) => c.status !== "COMPLETE")
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

  function handleBatchBarcodeScan({ data }: { data: string }) {
    if (data === lastBatchScanRef.current) return;
    lastBatchScanRef.current = data;
    setTimeout(() => { lastBatchScanRef.current = ""; }, 2000);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const found = findCaseByBarcode(data) || cases.find(c => c.id === data || c.caseNumber === data);
    if (found && !batchScannedCases.find(bc => bc.id === found.id)) {
      setBatchScannedCases(prev => [...prev, { id: found.id, caseNumber: found.caseNumber, patientName: found.patientName }]);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  function handleBatchLocationSelect(station: CaseStatus) {
    batchLocateCases(batchScannedCases.map(c => c.id), station);
    setBatchLocateOpen(false);
    setBatchScannedCases([]);
    setBatchScanning(true);
    setBatchLocationSelect(false);
    Alert.alert("Cases Located", `${batchScannedCases.length} case(s) moved to ${getStationInfo(station).label}.`);
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

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Camera Permission", "Camera access is needed to take a profile photo.");
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
    <ScrollView
      style={[styles.container, { backgroundColor: themeColors.background }]}
      contentContainerStyle={{
        paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
        paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.topBar}>
        <Pressable
          onPress={() => setDrawerOpen(true)}
          style={({ pressed }) => [styles.hamburgerBtn, pressed && { opacity: 0.6 }]}
          testID="hamburger-menu"
        >
          <Ionicons name="menu" size={26} color={themeColors.text} />
        </Pressable>
        <ChatButton />
      </View>

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
        <Text style={[styles.avatarName, { color: themeColors.textSecondary }]}>{role === "admin" ? "Administrator" : "User"}</Text>
        <View style={styles.statusDot}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>Available</Text>
        </View>

        <View style={styles.headerQuickActions}>
          <Pressable
            style={({ pressed }) => [
              styles.headerQuickBtn,
              pressed && styles.quickBtnPressed,
            ]}
            onPress={() => router.push("/(tabs)/scan")}
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
            onPress={() => router.push("/(tabs)/cases")}
          >
            <View style={[styles.quickIcon, { backgroundColor: Colors.light.accentLight }]}>
              <Feather name="search" size={22} color={Colors.light.accent} />
            </View>
            <Text style={[styles.quickLabel, { color: themeColors.text }]}>Search Cases</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.headerQuickBtn,
              pressed && styles.quickBtnPressed,
            ]}
            onPress={() => setBatchLocateOpen(true)}
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
          <Pressable
            style={[styles.heroStat, activeFilter === "intake" && styles.heroStatActive]}
            onPress={() => setActiveFilter(activeFilter === "intake" ? null : "intake")}
          >
            <Text style={styles.heroStatNum}>{intakeCases.length}</Text>
            <Text style={styles.heroStatLabel}>Intake</Text>
          </Pressable>
          <View style={[styles.heroStatDivider]} />
          <Pressable
            style={[styles.heroStat, activeFilter === "progress" && styles.heroStatActive]}
            onPress={() => setActiveFilter(activeFilter === "progress" ? null : "progress")}
          >
            <Text style={styles.heroStatNum}>{inProgressCases.length}</Text>
            <Text style={styles.heroStatLabel}>In Progress</Text>
          </Pressable>
          <View style={[styles.heroStatDivider]} />
          <Pressable
            style={[styles.heroStat, activeFilter === "shipped" && styles.heroStatActive]}
            onPress={() => setActiveFilter(activeFilter === "shipped" ? null : "shipped")}
          >
            <Text style={styles.heroStatNum}>{shippedCases.length}</Text>
            <Text style={styles.heroStatLabel}>Shipped</Text>
          </Pressable>
        </View>
      </LinearGradient>

      {activeFilter !== null && (
        <View style={styles.filterSection}>
          <View style={styles.filterHeader}>
            <Text style={styles.filterTitle}>
              {activeFilter === "intake" ? "Intake Cases" : activeFilter === "progress" ? "In Progress Cases" : "Shipped Cases"}
            </Text>
            <Pressable onPress={() => setActiveFilter(null)}>
              <Ionicons name="close-circle" size={22} color={Colors.light.textTertiary} />
            </Pressable>
          </View>
          {(activeFilter === "intake" ? intakeCases : activeFilter === "progress" ? inProgressCases : shippedCases).length === 0 ? (
            <View style={styles.filterEmpty}>
              <Ionicons name="file-tray-outline" size={28} color={Colors.light.textTertiary} />
              <Text style={styles.filterEmptyText}>
                No {activeFilter === "intake" ? "intake" : activeFilter === "progress" ? "in progress" : "shipped"} cases
              </Text>
            </View>
          ) : (
            <View style={styles.caseList}>
              {(activeFilter === "intake" ? intakeCases : activeFilter === "progress" ? inProgressCases : shippedCases).map((c) => {
                const si = getStationInfo(c.status);
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
                  const stationInfo = getStationInfo(c.status);
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
          const stationInfo = getStationInfo(c.status);
          const userInit = currentUser ? currentUser.split(" ").map((w: string) => w.charAt(0).toUpperCase()).join("").slice(0, 2) : "??";
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
        style={({ pressed }) => [styles.aiChatCard, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
      >
        <View style={styles.aiChatIcon}>
          <Ionicons name="sparkles" size={22} color={Colors.light.tint} />
        </View>
        <View style={styles.aiChatInfo}>
          <Text style={styles.aiChatTitle}>AI Assistant</Text>
          <Text style={styles.aiChatSub}>Ask about cases, materials, or workflows</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={Colors.light.textTertiary} />
      </Pressable>
    </ScrollView>

    <Modal
      transparent
      visible={batchLocateOpen}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={() => { setBatchLocateOpen(false); setBatchScannedCases([]); setBatchScanning(true); setBatchLocationSelect(false); }}
    >
      <View style={{ flex: 1, backgroundColor: batchLocationSelect ? Colors.light.background : "#000" }}>
        <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: batchLocationSelect ? Colors.light.surface : "rgba(0,0,0,0.8)" }}>
          <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: batchLocationSelect ? Colors.light.text : "#FFF" }}>
            {batchLocationSelect ? "Select Location" : "Batch Scan"}
          </Text>
          <Pressable onPress={() => { setBatchLocateOpen(false); setBatchScannedCases([]); setBatchScanning(true); setBatchLocationSelect(false); setBatchManualInput(""); lastBatchScanRef.current = ""; }}>
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
            {(["DESIGN", "WAX", "INVEST", "CAST", "FINISH", "PORCELAIN", "GLAZE", "QC", "SHIP", "COMPLETE", "HOLD"] as CaseStatus[]).map(station => {
              const info = getStationInfo(station);
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
                  <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
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
            ) : (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a"] }}
                onBarcodeScanned={handleBatchBarcodeScan}
              >
                <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                  <View style={{ width: 260, height: 160, borderWidth: 2, borderColor: "rgba(255,255,255,0.5)", borderRadius: 16, borderStyle: "dashed" }} />
                </View>
              </CameraView>
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
  | "user-hub"
  | "add-user"
  | "edit-user"
  | "invoices"
  | "invoice-detail"
  | "statements"
  | "sales"
  | "shipping"
  | "inventory"
  | "create-group"
  | "lab-users";

function AdminDashboard() {
  const { cases, clients, addClient, updateClient, users, addUser, updateUser, removeUser, invoices, setRole, shippingAccounts, addShippingAccount, removeShippingAccount, pricingTiers, updateTierPricing, addPricingTier, groups, groupInvitations, addUserToGroup, removeUserFromGroup, sendGroupInvitation, respondToGroupInvitation, getUserGroups, inventory, addInventoryItem, updateInventoryItem, removeInventoryItem, createGroup } = useApp();
  const { currentUser, registeredUsers } = useAuth();
  const [removeConfirmVisible, setRemoveConfirmVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const [adminView, setAdminView] = useState<AdminView>("hub");

  const totalRevenue = cases.reduce((sum, c) => sum + c.price, 0);
  const openInvoiceCount = invoices.filter((i) => i.status === "open" || i.status === "overdue").length;

  const [newClientName, setNewClientName] = useState("");
  const [newClientDoctor, setNewClientDoctor] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientAddress, setNewClientAddress] = useState("");
  const [newClientTier, setNewClientTier] = useState<string>("Standard");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<"user" | "admin">("user");
  const [newUserStation, setNewUserStation] = useState("Design");

  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [editingUser, setEditingUser] = useState<LabUser | null>(null);
  const [newShipCompany, setNewShipCompany] = useState("");
  const [newShipAccount, setNewShipAccount] = useState("");

  const [statementPreview, setStatementPreview] = useState<{
    clientName: string;
    email: string;
    invoices: { invoiceNumber: string; amount: number; issuedAt: number; dueAt: number; patientName: string; lineItems: { item: string; description: string; amount: number }[] }[];
    totalDue: number;
  }[] | null>(null);

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
  const [groupInviteUsername, setGroupInviteUsername] = useState("");
  const [showGroupInviteConfirm, setShowGroupInviteConfirm] = useState(false);
  const [showRemoveFromGroupConfirm, setShowRemoveFromGroupConfirm] = useState(false);
  const [selectedGroupForAction, setSelectedGroupForAction] = useState<string>("");
  const [selectedMemberForRemoval, setSelectedMemberForRemoval] = useState<string>("");

  const [invCategory, setInvCategory] = useState("All");
  const [showAddInv, setShowAddInv] = useState(false);
  const [newInvName, setNewInvName] = useState("");
  const [newInvCategory, setNewInvCategory] = useState("Materials");
  const [newInvQty, setNewInvQty] = useState("");
  const [newInvMinQty, setNewInvMinQty] = useState("");
  const [newInvUnit, setNewInvUnit] = useState("pcs");
  const [editingInvItem, setEditingInvItem] = useState<InventoryItem | null>(null);
  const [editInvQty, setEditInvQty] = useState("");

  const [newGroupNameAdmin, setNewGroupNameAdmin] = useState("");
  const [newGroupAddressAdmin, setNewGroupAddressAdmin] = useState("");
  const [newGroupTypeAdmin, setNewGroupTypeAdmin] = useState<"provider" | "lab">("lab");
  const [selectedLabGroup, setSelectedLabGroup] = useState<Group | null>(null);
  const [labUserSearchQuery, setLabUserSearchQuery] = useState("");

  const labPortalUsers = registeredUsers.filter(u => (u.userType === "lab" || (!u.userType && u.username !== "JPPhillips")) && u.username !== "JPPhillips");

  function resetClientForm() {
    setNewClientName("");
    setNewClientDoctor("");
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

  async function sendStatementEmail(clientName: string, clientEmail: string, subject: string, body: string) {
    const adminEmail = getAdminEmail();
    try {
      await apiRequest("POST", "/api/send-statement-email", {
        clientName,
        clientEmail,
        adminEmail,
        subject,
        body,
      });
    } catch (err) {
      console.log("Email send error (non-blocking):", err);
    }
  }

  function handleAddClient() {
    if (!newClientName.trim() || !newClientDoctor.trim()) {
      Alert.alert("Required", "Practice name and lead doctor are required.");
      return;
    }
    addClient({
      practiceName: newClientName.trim(),
      leadDoctor: newClientDoctor.trim(),
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
    updateClient(editingClient.id, editingClient);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Saved", "Client record updated.");
    setEditingClient(null);
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
        <Pressable onPress={() => { setAdminView(backTo); setEditingClient(null); setEditingUser(null); }} style={adm.backBtn}>
          <Ionicons name="chevron-back" size={22} color={Colors.light.tint} />
        </Pressable>
        <Text style={adm.subHeaderTitle}>{title}</Text>
        <View style={{ width: 36 }} />
      </View>
    );
  }

  function renderHub() {
    const totalOpenBalance = clients.reduce((sum, c) => {
      const clientInvoices = invoices.filter((inv) => inv.clientName === c.practiceName && (inv.status === "open" || inv.status === "overdue"));
      return sum + clientInvoices.reduce((s, inv) => s + inv.amount, 0);
    }, 0);

    const menuItems: { icon: string; iconSet: "ion" | "mci" | "feather"; color: string; bg: string; title: string; sub: string; view: AdminView }[] = [
      { icon: "business", iconSet: "ion", color: "#0EA5E9", bg: "#E0F2FE", title: "Clients", sub: `${clients.length} practices · Add, Edit, Price List`, view: "client-hub" },
      { icon: "people", iconSet: "ion", color: "#8B5CF6", bg: "#EDE9FE", title: "Users", sub: `${users.length} staff · Add, Edit, Groups`, view: "user-hub" },
      { icon: "layers", iconSet: "ion", color: "#F59E0B", bg: "#FEF3C7", title: "Edit Tier Pricing", sub: `${pricingTiers.length} pricing tiers`, view: "edit-tier-pricing" as AdminView },
      { icon: "document-text", iconSet: "ion", color: Colors.light.warning, bg: Colors.light.warningLight, title: "Open Invoices", sub: `${openInvoiceCount} pending`, view: "invoices" },
      { icon: "receipt-outline", iconSet: "ion", color: "#06B6D4", bg: "#CFFAFE", title: "Generate Statements", sub: "Create billing statements", view: "statements" },
      { icon: "trending-up", iconSet: "ion", color: Colors.light.error, bg: Colors.light.errorLight, title: "Sales", sub: "Revenue & analytics", view: "sales" },
      { icon: "airplane", iconSet: "ion", color: "#6366F1", bg: "#E0E7FF", title: "Shipping Accounts", sub: "Manage carrier connections", view: "shipping" as AdminView },
      { icon: "cube", iconSet: "ion", color: "#10B981", bg: "#D1FAE5", title: "Inventory", sub: `${inventory.length} items tracked`, view: "inventory" as AdminView },
      { icon: "add-circle", iconSet: "ion", color: "#059669", bg: "#ECFDF5", title: "Create Group", sub: "Create a new user group", view: "create-group" as AdminView },
      { icon: "person-add", iconSet: "ion", color: "#7C3AED", bg: "#F3E8FF", title: "Add Users", sub: `${labPortalUsers.length} lab users · Assign to groups`, view: "lab-users" as AdminView },
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
          <Text style={[styles.heroLabel, { opacity: 0.5 }]}>TOTAL BILLABLES</Text>
          <Text style={styles.heroCount}>
            ${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}
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
      const clientInvoices = invoices.filter((inv) => inv.clientName === c.practiceName && (inv.status === "open" || inv.status === "overdue"));
      return sum + clientInvoices.reduce((s, inv) => s + inv.amount, 0);
    }, 0);
    const clientMenuItems: { icon: string; color: string; bg: string; title: string; sub: string; view: AdminView }[] = [
      { icon: "business", color: "#0EA5E9", bg: "#E0F2FE", title: "Clients", sub: `${clients.length} practices · $${totalOpenBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} open`, view: "clients" },
      { icon: "person-add", color: Colors.light.tint, bg: Colors.light.tintLight, title: "Add Client", sub: "Onboard a new practice", view: "add-client" },
      { icon: "people", color: Colors.light.accent, bg: Colors.light.accentLight, title: "Edit Client", sub: `${clients.length} registered practices`, view: "edit-client" },
      { icon: "pricetag", color: "#10B981", bg: "#D1FAE5", title: "Edit Client Price List", sub: "Update service pricing", view: "edit-price-list" },
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
        {renderBackHeader("Clients")}
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

        {groups.length > 0 && (
          <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.subText, marginBottom: 12 }}>Groups</Text>
            {groups.map((g) => (
              <View key={g.id} style={{ backgroundColor: "#fff", borderRadius: 14, marginBottom: 10, padding: 14, shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: g.type === "lab" ? "#EDE9FE" : "#E0F2FE", justifyContent: "center", alignItems: "center" }}>
                    <Ionicons name={g.type === "lab" ? "flask" : "business"} size={16} color={g.type === "lab" ? "#8B5CF6" : "#0EA5E9"} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{g.name}</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText }}>{g.members.length} member{g.members.length !== 1 ? "s" : ""} · {g.type}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
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
        {renderBackHeader("Add Client", "client-hub")}
        <View style={adm.formArea}>
          <Text style={adm.formDesc}>Onboard a new dental practice.</Text>

          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Practice Name</Text>
            <TextInput style={adm.input} value={newClientName} onChangeText={setNewClientName} placeholder="Elite Dental Group" placeholderTextColor={Colors.light.textTertiary} />
          </View>
          <View style={adm.field}>
            <Text style={adm.fieldLabel}>Lead Doctor</Text>
            <TextInput style={adm.input} value={newClientDoctor} onChangeText={setNewClientDoctor} placeholder="Dr. Smith" placeholderTextColor={Colors.light.textTertiary} />
          </View>
          <View style={adm.fieldRow}>
            <View style={[adm.field, { flex: 1 }]}>
              <Text style={adm.fieldLabel}>Phone</Text>
              <TextInput style={adm.input} value={newClientPhone} onChangeText={setNewClientPhone} placeholder="(555) 000-0000" placeholderTextColor={Colors.light.textTertiary} keyboardType="phone-pad" />
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
      return (
        <ScrollView
          style={styles.container}
          contentContainerStyle={{
            paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          {renderBackHeader("Edit Client", "client-hub")}
          <View style={adm.formArea}>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Practice Name</Text>
              <TextInput style={adm.input} value={editingClient.practiceName} onChangeText={(v) => setEditingClient({ ...editingClient, practiceName: v })} />
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Lead Doctor</Text>
              <TextInput style={adm.input} value={editingClient.leadDoctor} onChangeText={(v) => setEditingClient({ ...editingClient, leadDoctor: v })} />
            </View>
            <View style={adm.fieldRow}>
              <View style={[adm.field, { flex: 1 }]}>
                <Text style={adm.fieldLabel}>Phone</Text>
                <TextInput style={adm.input} value={editingClient.phone} onChangeText={(v) => setEditingClient({ ...editingClient, phone: v })} keyboardType="phone-pad" />
              </View>
              <View style={[adm.field, { flex: 1 }]}>
                <Text style={adm.fieldLabel}>Email</Text>
                <TextInput style={adm.input} value={editingClient.email} onChangeText={(v) => setEditingClient({ ...editingClient, email: v })} keyboardType="email-address" autoCapitalize="none" />
              </View>
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Address</Text>
              <TextInput style={adm.input} value={editingClient.address} onChangeText={(v) => setEditingClient({ ...editingClient, address: v })} placeholder="Address" placeholderTextColor={Colors.light.textTertiary} />
            </View>
            <View style={adm.field}>
              <Text style={adm.fieldLabel}>Client Tier</Text>
              <View style={adm.chipRow}>
                {pricingTiers.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => setEditingClient({ ...editingClient, tier: t.name })}
                    style={[adm.chip, editingClient.tier === t.name && adm.chipActive]}
                  >
                    <Text style={[adm.chipText, editingClient.tier === t.name && adm.chipTextActive]}>{t.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <Pressable style={({ pressed }) => [adm.submitBtn, pressed && { opacity: 0.85 }]} onPress={handleSaveEditClient}>
              <Ionicons name="checkmark" size={20} color="#FFF" />
              <Text style={adm.submitBtnText}>Save Changes</Text>
            </Pressable>
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
        {renderBackHeader("Edit Client", "client-hub")}
        <View style={adm.listArea}>
          <Text style={adm.formDesc}>Select a client to edit.</Text>
          {clients.map((c) => (
            <Pressable key={c.id} style={({ pressed }) => [adm.listItem, pressed && { opacity: 0.7 }]} onPress={() => setEditingClient({ ...c })}>
              <View style={adm.listItemLeft}>
                <View style={[adm.listAvatar, { backgroundColor: c.tier === "Elite" ? Colors.light.warningLight : c.tier === "Premium" ? Colors.light.accentLight : Colors.light.surfaceSecondary }]}>
                  <Text style={[adm.listAvatarText, { color: c.tier === "Elite" ? Colors.light.warning : c.tier === "Premium" ? Colors.light.accent : Colors.light.textSecondary }]}>
                    {c.practiceName.charAt(0)}
                  </Text>
                </View>
                <View>
                  <Text style={adm.listItemTitle}>{c.practiceName}</Text>
                  <Text style={adm.listItemSub}>{c.accountNumber} · {c.leadDoctor}</Text>
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

            <View style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: Colors.light.border, paddingTop: 20 }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginBottom: 12 }}>Group Management</Text>

              {(() => {
                const userGroups = groups.filter(g => g.members.some(m => m.username === editingUser.name || m.userId === editingUser.id));
                return userGroups.length > 0 ? (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginBottom: 8 }}>Current Groups</Text>
                    {userGroups.map(g => (
                      <View key={g.id} style={{ flexDirection: "row", alignItems: "center", backgroundColor: Colors.light.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 8 }}>
                        <Ionicons name={g.type === "lab" ? "flask" : "business"} size={18} color={g.type === "lab" ? "#8B5CF6" : "#0EA5E9"} style={{ marginRight: 10 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.light.text }}>{g.name}</Text>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText }}>{g.members.length} member{g.members.length !== 1 ? "s" : ""}</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            setSelectedGroupForAction(g.id);
                            setSelectedMemberForRemoval(editingUser.id);
                            setShowRemoveFromGroupConfirm(true);
                          }}
                          style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}
                        >
                          <Ionicons name="remove-circle-outline" size={22} color={Colors.light.error} />
                        </Pressable>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginBottom: 12 }}>Not a member of any group.</Text>
                );
              })()}

              <View style={{ marginBottom: 12 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginBottom: 8 }}>Add User to Group</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    style={[adm.input, { flex: 1 }]}
                    placeholder="Username to invite"
                    placeholderTextColor={Colors.light.textTertiary}
                    value={groupInviteUsername}
                    onChangeText={setGroupInviteUsername}
                    autoCapitalize="none"
                  />
                </View>
                {groups.length > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.subText, marginBottom: 6 }}>Select Group</Text>
                    <View style={adm.chipRow}>
                      {groups.map(g => (
                        <Pressable
                          key={g.id}
                          onPress={() => setSelectedGroupForAction(g.id)}
                          style={[adm.chip, selectedGroupForAction === g.id && adm.chipActive]}
                        >
                          <Text style={[adm.chipText, selectedGroupForAction === g.id && adm.chipTextActive]}>{g.name}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
                <Pressable
                  style={({ pressed }) => [adm.submitBtn, { marginTop: 12 }, pressed && { opacity: 0.85 }]}
                  onPress={() => {
                    if (!groupInviteUsername.trim()) {
                      Alert.alert("Required", "Please enter a username to invite.");
                      return;
                    }
                    if (!selectedGroupForAction) {
                      Alert.alert("Required", "Please select a group.");
                      return;
                    }
                    setShowGroupInviteConfirm(true);
                  }}
                >
                  <Ionicons name="person-add" size={18} color="#FFF" />
                  <Text style={adm.submitBtnText}>Add User to Group</Text>
                </Pressable>
              </View>
            </View>

            <Modal transparent visible={showGroupInviteConfirm} animationType="fade" onRequestClose={() => setShowGroupInviteConfirm(false)}>
              <View style={adm.confirmOverlay}>
                <View style={adm.confirmCard}>
                  <View style={[adm.confirmIconWrap, { backgroundColor: "#DBEAFE" }]}>
                    <Ionicons name="people" size={32} color="#2563EB" />
                  </View>
                  <Text style={adm.confirmTitle}>Are you sure you want to add this user to your group?</Text>
                  <Text style={adm.confirmDesc}>They will have access to confidential information.</Text>
                  <View style={adm.confirmBtns}>
                    <Pressable
                      style={({ pressed }) => [adm.confirmYesBtn, pressed && { opacity: 0.85 }]}
                      onPress={() => {
                        const group = groups.find(g => g.id === selectedGroupForAction);
                        if (group) {
                          sendGroupInvitation(selectedGroupForAction, groupInviteUsername.trim(), "admin");
                          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          Alert.alert("Invitation Sent", `An invitation has been sent to ${groupInviteUsername.trim()} to join ${group.name}. They must accept before they are added.`);
                        }
                        setShowGroupInviteConfirm(false);
                        setGroupInviteUsername("");
                      }}
                    >
                      <Text style={adm.confirmYesText}>Yes</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [adm.confirmNoBtn, pressed && { opacity: 0.85 }]}
                      onPress={() => setShowGroupInviteConfirm(false)}
                    >
                      <Text style={adm.confirmNoText}>No</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </Modal>

            <Modal transparent visible={showRemoveFromGroupConfirm} animationType="fade" onRequestClose={() => setShowRemoveFromGroupConfirm(false)}>
              <View style={adm.confirmOverlay}>
                <View style={adm.confirmCard}>
                  <View style={adm.confirmIconWrap}>
                    <Ionicons name="warning" size={32} color="#EF4444" />
                  </View>
                  <Text style={adm.confirmTitle}>Remove user from group?</Text>
                  <Text style={adm.confirmDesc}>This user will lose access to the group's information.</Text>
                  <View style={adm.confirmBtns}>
                    <Pressable
                      style={({ pressed }) => [adm.confirmYesBtn, pressed && { opacity: 0.85 }]}
                      onPress={() => {
                        removeUserFromGroup(selectedGroupForAction, selectedMemberForRemoval);
                        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        Alert.alert("Removed", "User has been removed from the group.");
                        setShowRemoveFromGroupConfirm(false);
                        setSelectedGroupForAction("");
                        setSelectedMemberForRemoval("");
                      }}
                    >
                      <Text style={adm.confirmYesText}>Yes</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [adm.confirmNoBtn, pressed && { opacity: 0.85 }]}
                      onPress={() => setShowRemoveFromGroupConfirm(false)}
                    >
                      <Text style={adm.confirmNoText}>No</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </Modal>

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
        {renderBackHeader("Open Invoices")}
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
                    <Text style={adm.invoiceNumber}>{inv.invoiceNumber}</Text>
                    <Text style={adm.invoiceClient}>{inv.clientName}</Text>
                  </View>
                  <Text style={adm.invoiceAmount}>${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
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
          <Pressable onPress={() => { setSelectedInvoice(null); setAdminView("invoices"); }} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color="#333" />
          </Pressable>
          <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#333" }}>Invoice Detail</Text>
        </View>

        <View style={{ marginHorizontal: 16, backgroundColor: "#fff", borderRadius: 4, borderWidth: 1, borderColor: "#333", overflow: "hidden" }}>
          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333" }}>
            <View style={{ flex: 1, padding: 16 }}>
              <View style={{ width: 50, height: 50, borderRadius: 8, backgroundColor: Colors.light.tint, justifyContent: "center", alignItems: "center", marginBottom: 10 }}>
                <Ionicons name="flask" size={28} color="#fff" />
              </View>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#333" }}>DriveSync Lab</Text>
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
                  <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#333" }}>{inv.invoiceNumber}</Text>
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
            <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#C0392B", letterSpacing: 1 }}>DUE DATE</Text>
            <View style={{ marginTop: 6, borderWidth: 2, borderColor: "#333", paddingVertical: 8, paddingHorizontal: 24, borderRadius: 2 }}>
              <Text style={{ fontSize: 28, fontFamily: "Inter_700Bold", color: "#333" }}>{dueDateStr}</Text>
            </View>
          </View>

          <View style={{ borderBottomWidth: 1, borderBottomColor: "#333" }}>
            <View style={{ flexDirection: "row", backgroundColor: "#f0f0ec", borderBottomWidth: 1, borderBottomColor: "#999" }}>
              <View style={{ width: 40, paddingVertical: 6, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: "#999", alignItems: "center" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Qty</Text>
              </View>
              <View style={{ width: 80, paddingVertical: 6, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Item</Text>
              </View>
              <View style={{ flex: 1, paddingVertical: 6, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#999" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Description</Text>
              </View>
              <View style={{ width: 60, paddingVertical: 6, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: "#999", alignItems: "flex-end" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Rate</Text>
              </View>
              <View style={{ width: 70, paddingVertical: 6, paddingHorizontal: 4, alignItems: "flex-end" }}>
                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#333" }}>Amount</Text>
              </View>
            </View>

            {inv.lineItems.map((li, idx) => (
              <View key={idx} style={{ flexDirection: "row", borderBottomWidth: idx < inv.lineItems.length - 1 ? 1 : 0, borderBottomColor: "#ddd" }}>
                <View style={{ width: 40, paddingVertical: 8, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: "#eee", alignItems: "center" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#333" }}>{li.qty}</Text>
                </View>
                <View style={{ width: 80, paddingVertical: 8, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#eee" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#333" }}>{li.item}</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: "#eee" }}>
                  <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: "#555" }}>{li.description}</Text>
                </View>
                <View style={{ width: 60, paddingVertical: 8, paddingHorizontal: 4, borderRightWidth: 1, borderRightColor: "#eee", alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#333" }}>${li.rate.toFixed(2)}</Text>
                </View>
                <View style={{ width: 70, paddingVertical: 8, paddingHorizontal: 4, alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#333" }}>${li.amount.toFixed(2)}</Text>
                </View>
              </View>
            ))}

            {inv.lineItems.length < 6 && Array.from({ length: 6 - inv.lineItems.length }).map((_, idx) => (
              <View key={`empty-${idx}`} style={{ flexDirection: "row", borderBottomWidth: idx < 5 - inv.lineItems.length ? 1 : 0, borderBottomColor: "#eee", height: 28 }}>
                <View style={{ width: 40, borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ width: 80, borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ flex: 1, borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ width: 60, borderRightWidth: 1, borderRightColor: "#eee" }} />
                <View style={{ width: 70 }} />
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
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#333", minWidth: 70, textAlign: "right" }}>${lineTotal.toFixed(2)}</Text>
              </View>
              <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#ccc", paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", width: 60 }}>Credits</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#333", minWidth: 70, textAlign: "right" }}>${inv.credits.toFixed(2)}</Text>
              </View>
              <View style={{ flexDirection: "row", paddingVertical: 6, paddingHorizontal: 10 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", width: 60 }}>Total</Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#333", minWidth: 70, textAlign: "right" }}>${finalTotal.toFixed(2)}</Text>
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

  function renderStatements() {
    if (statementPreview) {
      return (
        <ScrollView
          style={styles.container}
          contentContainerStyle={{
            paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
            paddingBottom: Platform.OS === "web" ? 84 + 16 : 100,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 16 }}>
            <Pressable onPress={() => setStatementPreview(null)} style={{ marginRight: 12 }}>
              <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
            </Pressable>
            <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Statement Preview</Text>
          </View>

          <View style={adm.listArea}>
            {statementPreview.map((clientStatement, idx) => (
              <View key={idx} style={{ backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: Colors.light.border }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{clientStatement.clientName}</Text>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.error }}>
                    ${clientStatement.totalDue.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </Text>
                </View>
                {clientStatement.email ? (
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginBottom: 12 }}>
                    Email: {clientStatement.email}
                  </Text>
                ) : null}

                {clientStatement.invoices.map((inv, invIdx) => (
                  <View key={invIdx} style={{ borderTopWidth: 1, borderTopColor: Colors.light.border, paddingTop: 10, marginTop: invIdx > 0 ? 10 : 0 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                      <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{inv.invoiceNumber}</Text>
                      <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                        ${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginBottom: 2 }}>
                      Patient: {inv.patientName}
                    </Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginBottom: 6 }}>
                      Issued: {new Date(inv.issuedAt).toLocaleDateString()} · Due: {new Date(inv.dueAt).toLocaleDateString()}
                    </Text>
                    {inv.lineItems.length > 0 && (
                      <View style={{ backgroundColor: Colors.light.background, borderRadius: 8, padding: 8 }}>
                        {inv.lineItems.map((li, liIdx) => (
                          <View key={liIdx} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 }}>
                            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.text, flex: 1 }}>{li.item}{li.description ? ` - ${li.description}` : ""}</Text>
                            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.text }}>${li.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            ))}

            <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
              <Pressable
                style={({ pressed }) => ({
                  flex: 1,
                  backgroundColor: "#16A34A",
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: 8,
                  opacity: pressed ? 0.85 : 1,
                })}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  statementPreview.forEach((cs) => {
                    const invoiceDetails = cs.invoices.map((inv) => {
                      const items = inv.lineItems.map(li => `    ${li.item}: $${li.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`).join("\n");
                      return `  ${inv.invoiceNumber} (Issued: ${new Date(inv.issuedAt).toLocaleDateString()})\n  Patient: ${inv.patientName}\n${items}\n  Subtotal: $${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
                    }).join("\n\n");
                    const emailBody = `Billing Statement for ${cs.clientName}\n\nOpen Invoices:\n${invoiceDetails}\n\nTotal Due: $${cs.totalDue.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n\nPlease remit payment at your earliest convenience.\n\nThank you,\nDriveSync Lab`;
                    sendStatementEmail(cs.clientName, cs.email, `Billing Statement - ${cs.clientName}`, emailBody);
                  });
                  const totalAll = statementPreview.reduce((s, cs) => s + cs.totalDue, 0);
                  Alert.alert(
                    "Statements Sent",
                    `Emailed statements to ${statementPreview.length} client${statementPreview.length > 1 ? "s" : ""}.\nTotal: $${totalAll.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
                  );
                  setStatementPreview(null);
                }}
              >
                <Ionicons name="send" size={18} color="#FFF" />
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Send Statements</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({
                  flex: 1,
                  backgroundColor: Colors.light.surface,
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: Colors.light.border,
                  opacity: pressed ? 0.85 : 1,
                })}
                onPress={() => setStatementPreview(null)}
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>Cancel</Text>
              </Pressable>
            </View>
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
        {renderBackHeader("Generate Statements")}
        <View style={adm.listArea}>
          {(() => {
            const allOpenInvoices = invoices.filter((inv) => inv.status === "open" || inv.status === "overdue");
            const totalOpenAmount = allOpenInvoices.reduce((s, inv) => s + inv.amount, 0);
            const clientsWithOpen = [...new Set(allOpenInvoices.map((inv) => inv.clientName))];
            return (
              <Pressable
                style={({ pressed }) => ({
                  backgroundColor: Colors.light.tint,
                  borderRadius: 14,
                  paddingVertical: 16,
                  paddingHorizontal: 20,
                  marginBottom: 20,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  opacity: pressed ? 0.85 : 1,
                  shadowColor: Colors.light.tint,
                  shadowOpacity: 0.3,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 4,
                })}
                onPress={() => {
                  if (allOpenInvoices.length === 0) {
                    Alert.alert("No Open Invoices", "There are no open invoices to generate statements for.");
                    return;
                  }
                  const preview = clientsWithOpen.map((name) => {
                    const client = clients.find((cl) => cl.practiceName === name);
                    const clientInvs = allOpenInvoices.filter((inv) => inv.clientName === name);
                    const clientTotal = clientInvs.reduce((s, inv) => s + inv.amount, 0);
                    return {
                      clientName: name,
                      email: client?.email || "",
                      invoices: clientInvs.map(inv => ({
                        invoiceNumber: inv.invoiceNumber,
                        amount: inv.amount,
                        issuedAt: inv.issuedAt,
                        dueAt: inv.dueAt,
                        patientName: inv.patientName,
                        lineItems: (inv.lineItems || []).map(li => ({
                          item: li.item,
                          description: li.description,
                          amount: li.amount,
                        })),
                      })),
                      totalDue: clientTotal,
                    };
                  });
                  setStatementPreview(preview);
                }}
                testID="generate-all-statements-btn"
              >
                <Ionicons name="documents" size={22} color="#fff" />
                <View>
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Preview All Open Statements</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)", marginTop: 2 }}>
                    {allOpenInvoices.length} open invoice{allOpenInvoices.length !== 1 ? "s" : ""} · ${totalOpenAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </Text>
                </View>
              </Pressable>
            );
          })()}
          <Text style={adm.formDesc}>Or select a client to preview their statement.</Text>
          {clients.map((c) => {
            const clientOpenInvs = invoices.filter((inv) => inv.clientName === c.practiceName && (inv.status === "open" || inv.status === "overdue"));
            const clientTotal = clientOpenInvs.reduce((s, inv) => s + inv.amount, 0);
            if (clientOpenInvs.length === 0) return null;
            return (
              <Pressable
                key={c.id}
                style={({ pressed }) => [adm.statementCard, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  const preview = [{
                    clientName: c.practiceName,
                    email: c.email,
                    invoices: clientOpenInvs.map(inv => ({
                      invoiceNumber: inv.invoiceNumber,
                      amount: inv.amount,
                      issuedAt: inv.issuedAt,
                      dueAt: inv.dueAt,
                      patientName: inv.patientName,
                      lineItems: (inv.lineItems || []).map(li => ({
                        item: li.item,
                        description: li.description,
                        amount: li.amount,
                      })),
                    })),
                    totalDue: clientTotal,
                  }];
                  setStatementPreview(preview);
                }}
              >
                <View style={adm.listItemLeft}>
                  <View style={[adm.listAvatar, { backgroundColor: Colors.light.tintLight }]}>
                    <Ionicons name="document-text-outline" size={18} color={Colors.light.tint} />
                  </View>
                  <View>
                    <Text style={adm.listItemTitle}>{c.practiceName}</Text>
                    <Text style={adm.listItemSub}>{c.accountNumber} · {clientOpenInvs.length} open invoice{clientOpenInvs.length !== 1 ? "s" : ""} · ${clientTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
                  </View>
                </View>
                <Ionicons name="eye-outline" size={20} color={Colors.light.tint} />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  function renderClients() {
    const clientsWithBalance = clients.map((c) => {
      const clientInvoices = invoices.filter((inv) => inv.clientName === c.practiceName && (inv.status === "open" || inv.status === "overdue"));
      const openBalance = clientInvoices.reduce((s, inv) => s + inv.amount, 0);
      const openCount = clientInvoices.length;
      return { ...c, openBalance, openCount };
    });
    const totalOpen = clientsWithBalance.reduce((s, c) => s + c.openBalance, 0);

    return (
      <ScrollView style={{ flex: 1, backgroundColor: Colors.light.background }} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Pressable onPress={() => setAdminView("client-hub")} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.text }}>Clients</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>
              {clients.length} practices · ${totalOpen.toLocaleString("en-US", { minimumFractionDigits: 2 })} total open
            </Text>
          </View>
        </View>

        {clientsWithBalance.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => { setSelectedClient(c); setAdminView("client-detail"); }}
            style={{ marginHorizontal: 16, marginBottom: 10, backgroundColor: "#fff", borderRadius: 14, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{c.practiceName}</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 3 }}>{c.accountNumber} · Dr. {c.leadDoctor}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: c.openBalance > 0 ? Colors.light.warning : Colors.light.success }}>
                  ${c.openBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
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

    const clientInvoices = invoices.filter((inv) => inv.clientName === selectedClient.practiceName);
    const openInvoices = clientInvoices.filter((inv) => inv.status === "open" || inv.status === "overdue");
    const paidInvoices = clientInvoices.filter((inv) => inv.status === "paid");
    const openBalance = openInvoices.reduce((s, inv) => s + inv.amount, 0);
    const paidTotal = paidInvoices.reduce((s, inv) => s + inv.amount, 0);
    const clientCases = cases.filter((c) => c.clientName === selectedClient.practiceName);

    return (
      <ScrollView style={{ flex: 1, backgroundColor: Colors.light.background }} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Pressable onPress={() => { setSelectedClient(null); setAdminView("clients"); }} style={{ marginRight: 12 }}>
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
            <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginLeft: 10 }}>Account: {selectedClient.accountNumber}</Text>
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
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: openBalance > 0 ? "#D97706" : "#059669", marginTop: 4 }}>${openBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#EFF6FF", borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#1E40AF" }}>Paid to Date</Text>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#2563EB", marginTop: 4 }}>${paidTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
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

        {openBalance > 0 && (
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              const invoiceDetails = openInvoices.map((inv) => `  ${inv.invoiceNumber}: $${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} (Due: ${new Date(inv.dueAt).toLocaleDateString()})`).join("\n");
              const emailBody = `Billing Statement for ${selectedClient.practiceName}\n\nOpen Invoices:\n${invoiceDetails}\n\nTotal Due: $${openBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n\nPlease remit payment at your earliest convenience.\n\nThank you,\nDriveSync Lab`;
              sendStatementEmail(selectedClient.practiceName, selectedClient.email, `Billing Statement - ${selectedClient.practiceName}`, emailBody);
              Alert.alert("Statement Generated & Emailed", `Statement for ${selectedClient.practiceName} with open balance of $${openBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} has been generated and emailed to ${selectedClient.email} and admin.`);
            }}
            style={{ marginHorizontal: 16, marginBottom: 16, backgroundColor: Colors.light.tint, borderRadius: 14, paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
          >
            <Ionicons name="document-text" size={20} color="#fff" />
            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" }}>Generate Statement</Text>
          </Pressable>
        )}

        {openInvoices.length > 0 && (
          <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
            <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 10 }}>Open Invoices</Text>
            {openInvoices.map((inv) => (
              <Pressable
                key={inv.id}
                style={({ pressed }) => ({ backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, borderLeftWidth: 3, borderLeftColor: inv.status === "overdue" ? Colors.light.error : Colors.light.warning, opacity: pressed ? 0.7 : 1 })}
                onPress={() => {
                  setSelectedInvoice(inv);
                  setAdminView("invoice-detail");
                }}
              >
                <View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{inv.invoiceNumber}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>Due {new Date(inv.dueAt).toLocaleDateString()}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: inv.status === "overdue" ? Colors.light.error : Colors.light.warning }}>${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: inv.status === "overdue" ? Colors.light.error : Colors.light.warning, textTransform: "uppercase", marginTop: 2 }}>{inv.status}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}

        {paidInvoices.length > 0 && (
          <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
            <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 10 }}>Paid Invoices</Text>
            {paidInvoices.map((inv) => (
              <Pressable
                key={inv.id}
                style={({ pressed }) => ({ backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, borderLeftWidth: 3, borderLeftColor: Colors.light.success, opacity: pressed ? 0.7 : 1 })}
                onPress={() => {
                  setSelectedInvoice(inv);
                  setAdminView("invoice-detail");
                }}
              >
                <View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{inv.invoiceNumber}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>Paid {new Date(inv.issuedAt).toLocaleDateString()}</Text>
                </View>
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.success }}>${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
              </Pressable>
            ))}
          </View>
        )}
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
                {selectedPriceClient ? `${selectedPriceClient.practiceName} (${selectedPriceClient.accountNumber})` : "Select Client..."}
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
                      setShowClientPicker(false);
                    }}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.light.border, opacity: pressed ? 0.7 : 1 })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{c.practiceName}</Text>
                      <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>{c.accountNumber} · {c.leadDoctor}</Text>
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
        {renderBackHeader("Sales")}
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
              <Text style={adm.salesCardValue}>${periodRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
            </View>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Collected</Text>
              <Text style={[adm.salesCardValue, { color: Colors.light.success }]}>${collectedAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
            </View>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Active Pipeline</Text>
              <Text style={[adm.salesCardValue, { color: Colors.light.tint }]}>${activeRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
            </View>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Shipped / Done</Text>
              <Text style={adm.salesCardValue}>${completedRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
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
                <Text style={adm.materialRevenue}>${data.revenue.toLocaleString("en-US", { minimumFractionDigits: 0 })}</Text>
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
                <Text style={adm.clientRevenueAmount}>${rev.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
              </View>
            );
          }).filter(Boolean)}
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
        {renderBackHeader("Inventory")}

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

  function renderCreateGroupAdmin() {
    function handleCreateGroup() {
      if (!newGroupNameAdmin.trim()) {
        Alert.alert("Required", "Group name is required.");
        return;
      }
      if (!newGroupAddressAdmin.trim()) {
        Alert.alert("Required", "Group address is required.");
        return;
      }
      createGroup(newGroupNameAdmin.trim(), newGroupTypeAdmin, newGroupAddressAdmin.trim(), currentUser || "", "admin");
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Success", `Group "${newGroupNameAdmin.trim()}" created.`);
      setNewGroupNameAdmin("");
      setNewGroupAddressAdmin("");
      setNewGroupTypeAdmin("lab");
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
        {renderBackHeader("Create Group")}

        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ backgroundColor: "#ECFDF5", borderRadius: 16, padding: 20, marginBottom: 20, alignItems: "center" }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#059669", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
              <Ionicons name="people" size={28} color="#fff" />
            </View>
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#065F46", textAlign: "center" }}>Create a New Group</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#047857", textAlign: "center", marginTop: 4 }}>Groups help organize users by practice or location</Text>
          </View>

          <Text style={adm.fieldLabel}>Group Name</Text>
          <TextInput
            style={adm.textInput}
            placeholder="e.g. Downtown Dental Lab"
            value={newGroupNameAdmin}
            onChangeText={setNewGroupNameAdmin}
            placeholderTextColor="#9CA3AF"
          />

          <Text style={[adm.fieldLabel, { marginTop: 16 }]}>Address</Text>
          <TextInput
            style={adm.textInput}
            placeholder="e.g. 123 Main St, City, ST 12345"
            value={newGroupAddressAdmin}
            onChangeText={setNewGroupAddressAdmin}
            placeholderTextColor="#9CA3AF"
          />

          <Text style={[adm.fieldLabel, { marginTop: 16 }]}>Group Type</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
            <Pressable
              onPress={() => setNewGroupTypeAdmin("lab")}
              style={[
                {
                  flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: "center",
                  borderWidth: 2, borderColor: newGroupTypeAdmin === "lab" ? Colors.light.tint : "#E5E7EB",
                  backgroundColor: newGroupTypeAdmin === "lab" ? Colors.light.tintLight : "#F9FAFB",
                },
              ]}
            >
              <Ionicons name="flask" size={22} color={newGroupTypeAdmin === "lab" ? Colors.light.tint : "#6B7280"} />
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: newGroupTypeAdmin === "lab" ? Colors.light.tint : "#6B7280", marginTop: 4 }}>Lab</Text>
            </Pressable>
            <Pressable
              onPress={() => setNewGroupTypeAdmin("provider")}
              style={[
                {
                  flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: "center",
                  borderWidth: 2, borderColor: newGroupTypeAdmin === "provider" ? "#7C3AED" : "#E5E7EB",
                  backgroundColor: newGroupTypeAdmin === "provider" ? "#F3E8FF" : "#F9FAFB",
                },
              ]}
            >
              <Ionicons name="medkit" size={22} color={newGroupTypeAdmin === "provider" ? "#7C3AED" : "#6B7280"} />
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: newGroupTypeAdmin === "provider" ? "#7C3AED" : "#6B7280", marginTop: 4 }}>Provider</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={handleCreateGroup}
            style={({ pressed }) => [
              {
                backgroundColor: "#059669", borderRadius: 14, paddingVertical: 16, alignItems: "center",
                marginTop: 28, opacity: pressed ? 0.9 : 1,
              },
            ]}
          >
            <Text style={{ color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 }}>Create Group</Text>
          </Pressable>

          {groups.length > 0 && (
            <View style={{ marginTop: 28 }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 12 }}>Existing Groups ({groups.length})</Text>
              {groups.map(g => (
                <View key={g.id} style={{ backgroundColor: "#F9FAFB", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 15, color: Colors.light.text }}>{g.name}</Text>
                      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.light.subText, marginTop: 2 }}>{g.address}</Text>
                    </View>
                    <View style={{ backgroundColor: g.type === "lab" ? Colors.light.tintLight : "#F3E8FF", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: g.type === "lab" ? Colors.light.tint : "#7C3AED" }}>{g.type.toUpperCase()}</Text>
                    </View>
                  </View>
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.light.subText, marginTop: 6 }}>{g.members.length} member{g.members.length !== 1 ? "s" : ""}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    );
  }

  function renderLabUsers() {
    const filteredLabUsers = labUserSearchQuery.trim()
      ? labPortalUsers.filter(u => u.username.toLowerCase().includes(labUserSearchQuery.toLowerCase()) || (u.email && u.email.toLowerCase().includes(labUserSearchQuery.toLowerCase())))
      : labPortalUsers;

    function handleAddUserToGroup(username: string, groupId: string) {
      const user = registeredUsers.find(u => u.username === username);
      const role = user?.role || "user";
      addUserToGroup(groupId, username, role as "admin" | "user");
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Added", `${username} has been added to the group.`);
      setSelectedLabGroup(null);
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
              const userGroups = getUserGroups(user.username);
              return (
                <View key={user.username} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB", shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#EDE9FE", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                      <Text style={{ fontFamily: "Inter_700Bold", fontSize: 16, color: "#7C3AED" }}>{user.username.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 15, color: Colors.light.text }}>{user.username}</Text>
                      {user.email ? <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.light.subText }}>{user.email}</Text> : null}
                    </View>
                    <View style={{ backgroundColor: user.role === "admin" ? "#FEF3C7" : "#F3F4F6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: user.role === "admin" ? "#92400E" : "#6B7280" }}>{(user.role || "user").toUpperCase()}</Text>
                    </View>
                  </View>

                  {userGroups.length > 0 && (
                    <View style={{ marginBottom: 10 }}>
                      <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, color: Colors.light.subText, marginBottom: 4 }}>Groups:</Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                        {userGroups.map(g => (
                          <View key={g.id} style={{ backgroundColor: g.type === "lab" ? Colors.light.tintLight : "#F3E8FF", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, color: g.type === "lab" ? Colors.light.tint : "#7C3AED" }}>{g.name}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}

                  <Pressable
                    onPress={() => {
                      if (groups.length === 0) {
                        Alert.alert("No Groups", "Create a group first before adding users.");
                        return;
                      }
                      setSelectedLabGroup(null);
                      Alert.alert(
                        "Add to Group",
                        `Select a group for ${user.username}:`,
                        [
                          ...groups.map(g => ({
                            text: `${g.name} (${g.type})`,
                            onPress: () => {
                              const alreadyMember = g.members.some(m => m.username === user.username);
                              if (alreadyMember) {
                                Alert.alert("Already a Member", `${user.username} is already in ${g.name}.`);
                              } else {
                                handleAddUserToGroup(user.username, g.id);
                              }
                            },
                          })),
                          { text: "Cancel", style: "cancel" },
                        ]
                      );
                    }}
                    style={({ pressed }) => [
                      {
                        backgroundColor: pressed ? "#EDE9FE" : "#F3E8FF",
                        borderRadius: 10, paddingVertical: 10, alignItems: "center",
                        flexDirection: "row", justifyContent: "center", gap: 6,
                      },
                    ]}
                  >
                    <Ionicons name="add-circle-outline" size={18} color="#7C3AED" />
                    <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, color: "#7C3AED" }}>Add to Group</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    );
  }

  switch (adminView) {
    case "client-hub": return renderClientHub();
    case "clients": return renderClients();
    case "client-detail": return renderClientDetail();
    case "add-client": return renderAddClient();
    case "edit-client": return renderEditClient();
    case "edit-price-list": return renderEditPriceList();
    case "edit-tier-pricing": return renderEditTierPricing();
    case "user-hub": return renderUserHub();
    case "add-user": return renderAddUser();
    case "edit-user": return renderEditUser();
    case "invoices": return renderInvoices();
    case "invoice-detail": return renderInvoiceDetail();
    case "statements": return renderStatements();
    case "sales": return renderSales();
    case "shipping": return renderShipping();
    case "inventory": return renderInventory();
    case "create-group": return renderCreateGroupAdmin();
    case "lab-users": return renderLabUsers();
    default: return renderHub();
  }
}

function ProviderDashboard() {
  const { cases, role, adminUnlocked, createGroup, addUserToGroup, removeUserFromGroup, users, addUser, updateUser, removeUser, getUserGroups, groups } = useApp();
  const { currentUser, registeredUsers, logout, profilePicUri, setProfilePicUri, changePassword } = useAuth();
  const insets = useSafeAreaInsets();

  const [showSettings, setShowSettings] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [showUsersAdmin, setShowUsersAdmin] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupAddress, setNewGroupAddress] = useState("");
  const [newGroupType, setNewGroupType] = useState<"provider" | "lab">("provider");

  const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
  const myDoctorName = currentUserData?.doctorName || currentUser || "";
  const myCases = cases.filter(c =>
    c.doctorName.toLowerCase() === myDoctorName.toLowerCase() ||
    c.doctorName.toLowerCase().includes((currentUser || "").toLowerCase())
  );
  const activeCases = myCases.filter(c => c.status !== "COMPLETE" && c.status !== "HOLD");
  const completedCases = myCases.filter(c => c.status === "COMPLETE");
  const inProgressCount = activeCases.length;
  const completedCount = completedCases.length;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.light.background }}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
          paddingBottom: Platform.OS === "web" ? 84 + 40 : 120,
        }}
        showsVerticalScrollIndicator={false}
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
            <ChatButton />
            <Pressable onPress={() => setShowSettings(true)}>
              <Ionicons name="settings-outline" size={24} color={Colors.light.text} />
            </Pressable>
          </View>
        </View>

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
                <View style={[provStyles.statusDot, { backgroundColor: getStationInfo(c.status).color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={provStyles.caseName}>{c.patientName}</Text>
                  <Text style={provStyles.caseSub}>{c.caseType} · {c.toothNumbers?.join(", ") || "N/A"}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[provStyles.caseStatus, { color: getStationInfo(c.status).color }]}>{getStationInfo(c.status).label}</Text>
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
                  <Text style={provStyles.caseSub}>{c.caseType} · {c.toothNumbers?.join(", ") || "N/A"}</Text>
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
            <Pressable
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.light.surface,
                borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border,
                opacity: pressed ? 0.7 : 1,
              })}
              onPress={() => { setShowSettings(false); setShowCreateGroup(true); }}
            >
              <MaterialCommunityIcons name="account-group-outline" size={20} color={Colors.light.text} />
              <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.light.text, flex: 1 }}>Create Group</Text>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>

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
                onPress={() => {
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
                  const result = changePassword(currentPasswordInput, newPassword);
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
                const userGroups = getUserGroups(u.name);
                return (
                  <View key={u.id} style={{ backgroundColor: Colors.light.surface, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.light.border }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.light.tint, justifyContent: "center", alignItems: "center" }}>
                        <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_700Bold" }}>{u.name.charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{u.name}</Text>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{u.role} · {u.email || "No email"}</Text>
                      </View>
                    </View>
                    {userGroups.length > 0 && (
                      <View style={{ marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                        {userGroups.map(g => (
                          <View key={g.id} style={{ backgroundColor: Colors.light.tintLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                            <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.tint }}>{g.name}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showCreateGroup}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowCreateGroup(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 24 }}>
          <View style={{ backgroundColor: "#FFF", borderRadius: 20, width: "100%", maxWidth: 400, padding: 24 }}>
            <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 20 }}>Create Group</Text>

            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 6 }}>Group Name</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", marginBottom: 16 }}
              value={newGroupName}
              onChangeText={setNewGroupName}
              placeholder="Practice / Lab Name"
            />

            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 6 }}>Address</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", marginBottom: 16 }}
              value={newGroupAddress}
              onChangeText={setNewGroupAddress}
              placeholder="123 Main St, City, State"
            />

            <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, marginBottom: 6 }}>Type</Text>
            <View style={{ flexDirection: "row", gap: 12, marginBottom: 20 }}>
              <Pressable
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: "center", backgroundColor: newGroupType === "provider" ? Colors.light.tint : Colors.light.surface, borderWidth: 1, borderColor: newGroupType === "provider" ? Colors.light.tint : Colors.light.border }}
                onPress={() => setNewGroupType("provider")}
              >
                <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: newGroupType === "provider" ? "#FFF" : Colors.light.text }}>Provider</Text>
              </Pressable>
              <Pressable
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: "center", backgroundColor: newGroupType === "lab" ? Colors.light.tint : Colors.light.surface, borderWidth: 1, borderColor: newGroupType === "lab" ? Colors.light.tint : Colors.light.border }}
                onPress={() => setNewGroupType("lab")}
              >
                <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: newGroupType === "lab" ? "#FFF" : Colors.light.text }}>Lab</Text>
              </Pressable>
            </View>

            <View style={{ flexDirection: "row", gap: 12 }}>
              <Pressable
                style={({ pressed }) => ({ flex: 1, alignItems: "center" as const, paddingVertical: 14, borderRadius: 12, backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.border, opacity: pressed ? 0.7 : 1 })}
                onPress={() => { setShowCreateGroup(false); setNewGroupName(""); setNewGroupAddress(""); }}
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => ({ flex: 1, alignItems: "center" as const, paddingVertical: 14, borderRadius: 12, backgroundColor: Colors.light.tint, opacity: pressed ? 0.7 : 1 })}
                onPress={() => {
                  if (!newGroupName.trim()) {
                    Alert.alert("Required", "Group name is required.");
                    return;
                  }
                  if (!newGroupAddress.trim()) {
                    Alert.alert("Required", "Address is required.");
                    return;
                  }
                  createGroup(newGroupName.trim(), newGroupType, newGroupAddress.trim(), currentUser || "", "admin");
                  Alert.alert("Group Created", `"${newGroupName.trim()}" has been created.`);
                  setShowCreateGroup(false);
                  setNewGroupName("");
                  setNewGroupAddress("");
                }}
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Create</Text>
              </Pressable>
            </View>
          </View>
        </View>
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

type MasterView = "hub" | "groups" | "group-detail" | "all-users" | "lab-portal" | "provider-portal" | "create-group";

function MasterAdminDashboard() {
  const { cases, clients, users, groups, invoices, createGroup, removeUserFromGroup, registeredUsers: appUsers } = useApp();
  const { currentUser, registeredUsers, logout } = useAuth();
  const insets = useSafeAreaInsets();

  const [masterView, setMasterView] = useState<MasterView>("hub");
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupAddress, setNewGroupAddress] = useState("");
  const [newGroupType, setNewGroupType] = useState<"provider" | "lab">("lab");

  const filteredGroups = groups.filter(g =>
    g.name.toLowerCase().includes(groupSearch.toLowerCase()) ||
    (g.address || "").toLowerCase().includes(groupSearch.toLowerCase())
  );

  const totalUsers = registeredUsers.length;
  const totalGroups = groups.length;
  const totalCases = cases.length;

  function renderBackHeader(title: string, backTo: MasterView = "hub") {
    return (
      <View style={{ paddingHorizontal: 20, flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
        <Pressable onPress={() => { setMasterView(backTo); if (backTo === "hub" || backTo === "groups") { setSelectedGroup(null); setGroupSearch(""); } }} style={{ marginRight: 12 }}>
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
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>Master Admin</Text>
            <Text style={styles.headerTitle}>Control Center</Text>
          </View>
          <Pressable onPress={logout} style={adm.exitBtn}>
            <Ionicons name="log-out-outline" size={20} color={Colors.light.textSecondary} />
          </Pressable>
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
              <Text style={[adm.heroBadgeText, { color: "#FFD700" }]}>{totalGroups} Groups</Text>
            </View>
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
            { icon: "search" as const, color: "#D97706", bg: "#FEF3C7", title: "Search Groups", sub: `${totalGroups} active groups`, view: "groups" as MasterView },
            { icon: "people" as const, color: "#8B5CF6", bg: "#EDE9FE", title: "All Users", sub: `${totalUsers} registered users`, view: "all-users" as MasterView },
            { icon: "add-circle" as const, color: "#10B981", bg: "#D1FAE5", title: "Create Group", sub: "Add new lab or provider group", view: "create-group" as MasterView },
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

  function renderGroups() {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false}>
        {renderBackHeader("Search Groups")}
        <View style={{ marginHorizontal: 20, marginBottom: 16, backgroundColor: Colors.light.surface, borderRadius: 12, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: Colors.light.border }}>
          <Ionicons name="search" size={18} color={Colors.light.textTertiary} />
          <TextInput
            style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 8, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text }}
            placeholder="Search groups..."
            placeholderTextColor={Colors.light.textTertiary}
            value={groupSearch}
            onChangeText={setGroupSearch}
          />
          {groupSearch.length > 0 && (
            <Pressable onPress={() => setGroupSearch("")}>
              <Ionicons name="close-circle" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          )}
        </View>
        {filteredGroups.length === 0 ? (
          <View style={{ alignItems: "center", padding: 40 }}>
            <Ionicons name="people-outline" size={48} color={Colors.light.textTertiary} />
            <Text style={{ color: Colors.light.textTertiary, fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12 }}>No groups found</Text>
          </View>
        ) : (
          filteredGroups.map((g) => (
            <Pressable
              key={g.id}
              onPress={() => { setSelectedGroup(g); setMasterView("group-detail"); }}
              style={({ pressed }) => [adm.menuItem, { marginHorizontal: 20 }, pressed && { opacity: 0.7 }]}
            >
              <View style={[adm.menuIcon, { backgroundColor: g.type === "lab" ? "#E0F2FE" : "#DBEAFE" }]}>
                <Ionicons name={g.type === "lab" ? "flask" : "medical"} size={20} color={g.type === "lab" ? "#0EA5E9" : "#3B82F6"} />
              </View>
              <View style={adm.menuInfo}>
                <Text style={adm.menuTitle}>{g.name}</Text>
                <Text style={adm.menuSub}>{g.type === "lab" ? "Lab" : "Provider"} · {g.members?.length || 0} members{g.address ? ` · ${g.address}` : ""}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          ))
        )}
      </ScrollView>
    );
  }

  function renderGroupDetail() {
    if (!selectedGroup) return renderGroups();
    const currentGroupData = groups.find(g => g.id === selectedGroup.id) || selectedGroup;
    const members = currentGroupData.members || [];
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
          <Pressable onPress={() => { setMasterView("groups"); setSelectedGroup(null); }} style={{ marginRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.light.text }}>{currentGroupData.name}</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{currentGroupData.type === "lab" ? "Lab Group" : "Provider Group"}{currentGroupData.address ? ` · ${currentGroupData.address}` : ""}</Text>
          </View>
        </View>

        <View style={{ marginHorizontal: 20, marginBottom: 16, backgroundColor: Colors.light.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 12 }}>MEMBERS ({members.length})</Text>
          {members.length === 0 ? (
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", padding: 20 }}>No members in this group</Text>
          ) : (
            members.map((m, idx) => (
              <View key={m.userId || idx.toString()} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: Colors.light.border }}>
                <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: m.role === "admin" ? Colors.light.tintLight : Colors.light.successLight, justifyContent: "center", alignItems: "center", marginRight: 12 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: m.role === "admin" ? Colors.light.tint : Colors.light.success }}>{(m.username || "?").charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{m.username}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>{m.role === "admin" ? "Admin" : "User"}</Text>
                </View>
                <Pressable
                  onPress={() => {
                    Alert.alert("Remove User", `Remove "${m.username}" from this group?`, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => {
                        removeUserFromGroup(currentGroupData.id, m.userId);
                      }},
                    ]);
                  }}
                  style={{ padding: 6 }}
                >
                  <Ionicons name="remove-circle-outline" size={20} color={Colors.light.error} />
                </Pressable>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    );
  }

  function renderAllUsers() {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false}>
        {renderBackHeader("All Users")}
        {registeredUsers.filter(u => u.username !== "JPPhillips").map((u, idx) => {
          const userGroups = groups.filter(g => g.members?.some(m => m.username.toLowerCase() === u.username.toLowerCase()));
          return (
            <View key={u.username + idx} style={[adm.menuItem, { marginHorizontal: 20 }]}>
              <View style={[adm.menuIcon, { backgroundColor: u.userType === "provider" ? "#DBEAFE" : u.userType === "master_admin" ? "#FEF3C7" : "#E0F2FE" }]}>
                <Ionicons name={u.userType === "provider" ? "medical" : u.userType === "master_admin" ? "shield-checkmark" : "person"} size={20} color={u.userType === "provider" ? "#3B82F6" : u.userType === "master_admin" ? "#D97706" : "#0EA5E9"} />
              </View>
              <View style={[adm.menuInfo, { flex: 1 }]}>
                <Text style={adm.menuTitle}>{u.username}{u.doctorName ? ` (Dr. ${u.doctorName})` : ""}</Text>
                <Text style={adm.menuSub}>
                  {u.userType === "provider" ? "Provider" : u.userType === "master_admin" ? "Master Admin" : "Lab"} · {u.role === "admin" ? "Admin" : "User"}
                  {u.accountNumber ? ` · ${u.accountNumber}` : ""}
                  {userGroups.length > 0 ? ` · ${userGroups.map(g => g.name).join(", ")}` : ""}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    );
  }

  function renderCreateGroup() {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false}>
        {renderBackHeader("Create Group")}
        <View style={{ marginHorizontal: 20 }}>
          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>GROUP NAME</Text>
          <TextInput
            style={{ backgroundColor: Colors.light.surface, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, borderWidth: 1, borderColor: Colors.light.border, marginBottom: 16 }}
            value={newGroupName}
            onChangeText={setNewGroupName}
            placeholder="Enter group name..."
            placeholderTextColor={Colors.light.textTertiary}
          />
          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>ADDRESS</Text>
          <TextInput
            style={{ backgroundColor: Colors.light.surface, borderRadius: 12, padding: 14, fontSize: 15, fontFamily: "Inter_400Regular", color: Colors.light.text, borderWidth: 1, borderColor: Colors.light.border, marginBottom: 16 }}
            value={newGroupAddress}
            onChangeText={setNewGroupAddress}
            placeholder="Enter address..."
            placeholderTextColor={Colors.light.textTertiary}
          />
          <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 6 }}>TYPE</Text>
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 24 }}>
            <Pressable
              onPress={() => setNewGroupType("lab")}
              style={{ flex: 1, padding: 14, borderRadius: 12, backgroundColor: newGroupType === "lab" ? Colors.light.tint : Colors.light.surface, borderWidth: 1, borderColor: newGroupType === "lab" ? Colors.light.tint : Colors.light.border, alignItems: "center" }}
            >
              <Ionicons name="flask" size={20} color={newGroupType === "lab" ? "#FFF" : Colors.light.textSecondary} />
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: newGroupType === "lab" ? "#FFF" : Colors.light.text, marginTop: 4 }}>Lab</Text>
            </Pressable>
            <Pressable
              onPress={() => setNewGroupType("provider")}
              style={{ flex: 1, padding: 14, borderRadius: 12, backgroundColor: newGroupType === "provider" ? "#3B82F6" : Colors.light.surface, borderWidth: 1, borderColor: newGroupType === "provider" ? "#3B82F6" : Colors.light.border, alignItems: "center" }}
            >
              <Ionicons name="medical" size={20} color={newGroupType === "provider" ? "#FFF" : Colors.light.textSecondary} />
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: newGroupType === "provider" ? "#FFF" : Colors.light.text, marginTop: 4 }}>Provider</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => {
              if (!newGroupName.trim()) { Alert.alert("Error", "Please enter a group name."); return; }
              createGroup(newGroupName.trim(), newGroupType, newGroupAddress.trim(), currentUser || "JPPhillips", "admin");
              setNewGroupName("");
              setNewGroupAddress("");
              setNewGroupType("lab");
              Alert.alert("Success", "Group created successfully.");
              setMasterView("groups");
            }}
            style={({ pressed }) => [{ backgroundColor: Colors.light.tint, borderRadius: 14, padding: 16, alignItems: "center" }, pressed && { opacity: 0.85 }]}
          >
            <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" }}>Create Group</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  function renderLabPortal() {
    const totalRevenue = cases.reduce((sum, c) => sum + c.price, 0);
    const labUsers = registeredUsers.filter(u => u.userType === "lab" || (!u.userType && u.username !== "JPPhillips"));
    const openInvoiceCount = invoices.filter(i => i.status === "open" || i.status === "overdue").length;
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false}>
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
            <Text style={{ fontSize: 24, fontFamily: "Inter_700Bold", color: Colors.light.text }}>${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
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
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16, paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 }} showsVerticalScrollIndicator={false}>
        {renderBackHeader("Provider Portal Overview")}
        <View style={{ marginHorizontal: 20, gap: 12 }}>
          <View style={{ backgroundColor: Colors.light.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.light.border }}>
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, marginBottom: 8 }}>PROVIDERS ({providers.length})</Text>
            {providers.length === 0 ? (
              <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, textAlign: "center", padding: 20 }}>No providers registered yet</Text>
            ) : (
              providers.map((p, i) => {
                const provCases = cases.filter(c => c.doctorName.toLowerCase().includes((p.doctorName || p.username || "").toLowerCase()));
                const provGroups = groups.filter(g => g.members?.some(m => m.username.toLowerCase() === p.username.toLowerCase()));
                return (
                  <View key={p.username + i} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: Colors.light.border }}>
                    <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: "#DBEAFE", justifyContent: "center", alignItems: "center", marginRight: 12 }}>
                      <Ionicons name="medical" size={18} color="#3B82F6" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{p.doctorName ? `Dr. ${p.doctorName}` : p.username}</Text>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>
                        {p.accountNumber || "N/A"} · {provCases.length} cases · {p.role === "admin" ? "Admin" : "User"}
                        {provGroups.length > 0 ? ` · ${provGroups[0].name}` : ""}
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
    case "groups": return renderGroups();
    case "group-detail": return renderGroupDetail();
    case "all-users": return renderAllUsers();
    case "create-group": return renderCreateGroup();
    case "lab-portal": return renderLabPortal();
    case "provider-portal": return renderProviderPortal();
    default: return renderMasterHub();
  }
}

export default function DashboardScreen() {
  const { role, adminUnlocked, isLoading } = useApp();
  const { userType } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.light.tint} />
      </View>
    );
  }

  if (userType === "master_admin") {
    return <MasterAdminDashboard />;
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
    width: 36,
    height: 36,
    borderRadius: 12,
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
});

