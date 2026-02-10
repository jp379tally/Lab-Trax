import React, { useState, useCallback, useEffect } from "react";
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
  FlatList,
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
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { getStationInfo, Client, LabUser, Invoice } from "@/lib/data";
import { apiRequest } from "@/lib/query-client";

const DRAWER_WIDTH = Dimensions.get("window").width * 0.78;

function SideDrawer({
  visible,
  onClose,
  onAdmin,
  onProfile,
  onSignOut,
}: {
  visible: boolean;
  onClose: () => void;
  onAdmin: () => void;
  onProfile: () => void;
  onSignOut: () => void;
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

  const menuItems = [
    { key: "admin", icon: "shield-checkmark" as const, label: "Admin", color: Colors.light.tint, bg: Colors.light.tintLight, onPress: onAdmin },
    { key: "settings", icon: "settings" as const, label: "Settings", color: "#8B5CF6", bg: "#EDE9FE", onPress: () => { closeDrawer(); router.push("/(tabs)/profile"); } },
    { key: "profile", icon: "person" as const, label: "Profile", color: Colors.light.accent, bg: Colors.light.accentLight, onPress: () => { closeDrawer(); router.push("/(tabs)/profile"); } },
  ];

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
  const { cases, activeCaseCount, rushCaseCount, setRole } = useApp();
  const { logout, profilePicUri, setProfilePicUri } = useAuth();
  const insets = useSafeAreaInsets();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [picModalVisible, setPicModalVisible] = useState(false);
  const [pendingPicAction, setPendingPicAction] = useState<"take" | "pick" | null>(null);
  const recentCases = cases
    .filter((c) => c.status !== "COMPLETE")
    .slice(0, 5);

  function handleAdminFromDrawer() {
    setDrawerOpen(false);
    setTimeout(() => setRole("admin"), 300);
  }

  function handleProfileFromDrawer() {
    setDrawerOpen(false);
    setTimeout(() => router.push("/(tabs)/profile"), 300);
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
      style={styles.container}
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
          <Ionicons name="menu" size={26} color={Colors.light.text} />
        </Pressable>
        <View style={{ width: 40 }} />
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
        <Text style={styles.avatarName}>Lab Technician</Text>
        <View style={styles.statusDot}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>ON SHIFT</Text>
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
          <Text style={styles.greeting}>Lab Floor</Text>
          <Text style={styles.headerTitle}>Production Dashboard</Text>
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

      {(() => {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const dueTodayCases = cases.filter(
          (c) => c.dueDate === todayStr && c.status !== "COMPLETE" && c.status !== "SHIP",
        );
        return (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Due Today</Text>
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
          <Text style={styles.quickLabel}>New Case</Text>
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
          <Text style={styles.quickLabel}>Search Cases</Text>
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
                  <Text style={styles.casePatient}>{c.patientName || c.patientInitials}</Text>
                  <Text style={styles.caseDoctor}>{c.doctorName}</Text>
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
    </ScrollView>

    <SideDrawer
      visible={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      onAdmin={handleAdminFromDrawer}
      onProfile={handleProfileFromDrawer}
      onSignOut={handleSignOut}
    />
    </>
  );
}

function AdminLockScreen() {
  const { setAdminUnlocked } = useApp();
  const insets = useSafeAreaInsets();
  const [authStatus, setAuthStatus] = useState<string>("");
  const [biometricType, setBiometricType] = useState<string>("Biometric");

  useEffect(() => {
    attemptBiometricUnlock();
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
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType("Face ID");
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType("Touch ID");
        }

        setAuthStatus("scanning");
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: "Authenticate to unlock Admin Vault",
          disableDeviceFallback: false,
          cancelLabel: "Cancel",
        });

        if (result.success) {
          if (Platform.OS !== "web") {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setAdminUnlocked(true);
        } else {
          setAuthStatus("failed");
        }
      } else {
        setAuthStatus("tap");
      }
    } catch {
      setAuthStatus("tap");
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
            : "Accessing sensitive financial data requires facial recognition."}
        </Text>
        {authStatus === "failed" && (
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
            <Text style={styles.unlockBtnText}>Try Again</Text>
          </Pressable>
        )}
        {authStatus === "tap" && (
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
        )}
        {authStatus === "scanning" && (
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
  | "clients"
  | "client-detail"
  | "add-client"
  | "edit-client"
  | "edit-price-list"
  | "add-user"
  | "edit-user"
  | "invoices"
  | "statements"
  | "sales";

function AdminDashboard() {
  const { cases, clients, addClient, updateClient, users, addUser, updateUser, removeUser, invoices, setRole } = useApp();
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
  const [newClientTier, setNewClientTier] = useState<"Standard" | "Premium" | "Elite">("Standard");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<"tech" | "admin">("tech");
  const [newUserStation, setNewUserStation] = useState("Design");

  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [editingUser, setEditingUser] = useState<LabUser | null>(null);

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
    setNewUserRole("tech");
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

  function renderBackHeader(title: string) {
    return (
      <View style={adm.subHeader}>
        <Pressable onPress={() => { setAdminView("hub"); setEditingClient(null); setEditingUser(null); }} style={adm.backBtn}>
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
      { icon: "business", iconSet: "ion", color: "#0EA5E9", bg: "#E0F2FE", title: "Clients", sub: `${clients.length} practices · $${totalOpenBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} open`, view: "clients" },
      { icon: "pricetag", iconSet: "ion", color: "#10B981", bg: "#D1FAE5", title: "Edit Client Price List", sub: "Update service pricing", view: "edit-price-list" },
      { icon: "person-add", iconSet: "ion", color: Colors.light.tint, bg: Colors.light.tintLight, title: "Add Client", sub: "Onboard a new practice", view: "add-client" },
      { icon: "people", iconSet: "ion", color: Colors.light.accent, bg: Colors.light.accentLight, title: "Edit Client", sub: `${clients.length} registered practices`, view: "edit-client" },
      { icon: "person-add-outline", iconSet: "ion", color: Colors.light.success, bg: Colors.light.successLight, title: "Add User", sub: "Create lab staff account", view: "add-user" },
      { icon: "people-outline", iconSet: "ion", color: "#8B5CF6", bg: "#EDE9FE", title: "Edit User", sub: `${users.length} lab staff members`, view: "edit-user" },
      { icon: "document-text", iconSet: "ion", color: Colors.light.warning, bg: Colors.light.warningLight, title: "Open Invoices", sub: `${openInvoiceCount} pending`, view: "invoices" },
      { icon: "receipt-outline", iconSet: "ion", color: "#06B6D4", bg: "#CFFAFE", title: "Generate Statements", sub: "Create billing statements", view: "statements" },
      { icon: "trending-up", iconSet: "ion", color: Colors.light.error, bg: Colors.light.errorLight, title: "Sales", sub: "Revenue & analytics", view: "sales" },
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
          <Pressable onPress={() => setRole("tech")} style={adm.exitBtn}>
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
        {renderBackHeader("Add Client")}
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
              {(["Standard", "Premium", "Elite"] as const).map((t) => (
                <Pressable key={t} onPress={() => setNewClientTier(t)} style={[adm.chip, newClientTier === t && adm.chipActive]}>
                  <Text style={[adm.chipText, newClientTier === t && adm.chipTextActive]}>{t}</Text>
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
          {renderBackHeader("Edit Client")}
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
                {(["Standard", "Premium", "Elite"] as const).map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => setEditingClient({ ...editingClient, tier: t, discountRate: t === "Elite" ? 15 : t === "Premium" ? 10 : 0 })}
                    style={[adm.chip, editingClient.tier === t && adm.chipActive]}
                  >
                    <Text style={[adm.chipText, editingClient.tier === t && adm.chipTextActive]}>{t}</Text>
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
        {renderBackHeader("Edit Client")}
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
                  <Text style={adm.listItemSub}>{c.leadDoctor}</Text>
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
        {renderBackHeader("Add User")}
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
              {(["tech", "admin"] as const).map((r) => (
                <Pressable key={r} onPress={() => setNewUserRole(r)} style={[adm.chip, newUserRole === r && adm.chipActive]}>
                  <Text style={[adm.chipText, newUserRole === r && adm.chipTextActive]}>{r === "tech" ? "Technician" : "Admin"}</Text>
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
          {renderBackHeader("Edit User")}
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
                {(["tech", "admin"] as const).map((r) => (
                  <Pressable key={r} onPress={() => setEditingUser({ ...editingUser, role: r })} style={[adm.chip, editingUser.role === r && adm.chipActive]}>
                    <Text style={[adm.chipText, editingUser.role === r && adm.chipTextActive]}>{r === "tech" ? "Technician" : "Admin"}</Text>
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
        {renderBackHeader("Edit User")}
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
                  <Text style={adm.listItemSub}>{u.role === "admin" ? "Admin" : "Technician"} · {u.station}</Text>
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
              <View key={inv.id} style={adm.invoiceCard}>
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
              </View>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  function renderStatements() {
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
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  const summary = clientsWithOpen.map((name) => {
                    const clientInvs = allOpenInvoices.filter((inv) => inv.clientName === name);
                    const clientTotal = clientInvs.reduce((s, inv) => s + inv.amount, 0);
                    return `${name}: ${clientInvs.length} invoice${clientInvs.length > 1 ? "s" : ""} · $${clientTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
                  }).join("\n");

                  clientsWithOpen.forEach((name) => {
                    const client = clients.find((cl) => cl.practiceName === name);
                    const clientInvs = allOpenInvoices.filter((inv) => inv.clientName === name);
                    const clientTotal = clientInvs.reduce((s, inv) => s + inv.amount, 0);
                    const invoiceDetails = clientInvs.map((inv) => `  ${inv.invoiceNumber}: $${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} (Due: ${new Date(inv.dueAt).toLocaleDateString()})`).join("\n");
                    const emailBody = `Billing Statement for ${name}\n\nOpen Invoices:\n${invoiceDetails}\n\nTotal Due: $${clientTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n\nPlease remit payment at your earliest convenience.\n\nThank you,\nDriveSync Lab`;
                    sendStatementEmail(name, client?.email || "", `Billing Statement - ${name}`, emailBody);
                  });

                  Alert.alert(
                    "Statements Generated & Emailed",
                    `Generated and emailed statements for all open invoices.\n\n${allOpenInvoices.length} invoices across ${clientsWithOpen.length} client${clientsWithOpen.length > 1 ? "s" : ""}\nTotal: $${totalOpenAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n\n${summary}`,
                  );
                }}
                testID="generate-all-statements-btn"
              >
                <Ionicons name="documents" size={22} color="#fff" />
                <View>
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Generate Statements for All Open Invoices</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)", marginTop: 2 }}>
                    {allOpenInvoices.length} open invoice{allOpenInvoices.length !== 1 ? "s" : ""} · ${totalOpenAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </Text>
                </View>
              </Pressable>
            );
          })()}
          <Text style={adm.formDesc}>Or select a client to generate an individual statement.</Text>
          {clients.map((c) => {
            const clientCases = cases.filter((cs) => cs.doctorName === c.leadDoctor);
            const clientTotal = clientCases.reduce((s, cs) => s + cs.price, 0);
            return (
              <Pressable
                key={c.id}
                style={({ pressed }) => [adm.statementCard, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  const netAmount = clientTotal * (1 - c.discountRate / 100);
                  const emailBody = `Billing Statement for ${c.practiceName}\n\n${clientCases.length} cases totaling $${clientTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}\nDiscount: ${c.discountRate}% (${c.tier})\nNet Amount Due: $${netAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n\nPlease remit payment at your earliest convenience.\n\nThank you,\nDriveSync Lab`;
                  sendStatementEmail(c.practiceName, c.email, `Billing Statement - ${c.practiceName}`, emailBody);
                  Alert.alert(
                    "Statement Generated & Emailed",
                    `Billing statement for ${c.practiceName}\n${clientCases.length} cases totaling $${clientTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}\nDiscount: ${c.discountRate}% (${c.tier})\nNet: $${netAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n\nEmailed to ${c.email} and admin.`,
                  );
                }}
              >
                <View style={adm.listItemLeft}>
                  <View style={[adm.listAvatar, { backgroundColor: Colors.light.tintLight }]}>
                    <Ionicons name="document-text-outline" size={18} color={Colors.light.tint} />
                  </View>
                  <View>
                    <Text style={adm.listItemTitle}>{c.practiceName}</Text>
                    <Text style={adm.listItemSub}>{clientCases.length} cases · ${clientTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
                  </View>
                </View>
                <Ionicons name="download-outline" size={20} color={Colors.light.tint} />
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
          <Pressable onPress={() => setAdminView("hub")} style={{ marginRight: 12 }}>
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
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 3 }}>Dr. {c.leadDoctor}</Text>
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
              <View key={inv.id} style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderLeftWidth: 3, borderLeftColor: inv.status === "overdue" ? Colors.light.error : Colors.light.warning }}>
                <View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{inv.invoiceNumber}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>Due {new Date(inv.dueAt).toLocaleDateString()}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: inv.status === "overdue" ? Colors.light.error : Colors.light.warning }}>${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: inv.status === "overdue" ? Colors.light.error : Colors.light.warning, textTransform: "uppercase", marginTop: 2 }}>{inv.status}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {paidInvoices.length > 0 && (
          <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
            <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: Colors.light.text, marginBottom: 10 }}>Paid Invoices</Text>
            {paidInvoices.map((inv) => (
              <View key={inv.id} style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderLeftWidth: 3, borderLeftColor: Colors.light.success }}>
                <View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.light.text }}>{inv.invoiceNumber}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.subText, marginTop: 2 }}>Paid {new Date(inv.issuedAt).toLocaleDateString()}</Text>
                </View>
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.light.success }}>${inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  function renderEditPriceList() {
    function handleUpdatePrice(key: string, value: string) {
      const cleaned = value.replace(/[^0-9.]/g, "");
      setPriceList((prev) => ({ ...prev, [key]: cleaned }));
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
          {renderBackHeader("Edit Client Price List")}
          <View style={adm.formArea}>
            <Text style={adm.formDesc}>Set the price for each service item.</Text>

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
    const completedCases = cases.filter((c) => c.status === "COMPLETE" || c.status === "SHIP");
    const activeCases = cases.filter((c) => c.status !== "COMPLETE" && c.status !== "SHIP");
    const completedRevenue = completedCases.reduce((s, c) => s + c.price, 0);
    const activeRevenue = activeCases.reduce((s, c) => s + c.price, 0);
    const paidInvoices = invoices.filter((i) => i.status === "paid");
    const collectedAmount = paidInvoices.reduce((s, i) => s + i.amount, 0);

    const materialBreakdown: { [key: string]: { count: number; revenue: number } } = {};
    cases.forEach((c) => {
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
          <View style={adm.salesGrid}>
            <View style={adm.salesCard}>
              <Text style={adm.salesCardLabel}>Total Revenue</Text>
              <Text style={adm.salesCardValue}>${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
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
          {Object.entries(materialBreakdown).map(([mat, data]) => {
            const pct = totalRevenue > 0 ? (data.revenue / totalRevenue) * 100 : 0;
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
          })}

          <Text style={[adm.salesSectionTitle, { marginTop: 24 }]}>Top Clients by Revenue</Text>
          {clients.map((c) => {
            const clientCases = cases.filter((cs) => cs.doctorName === c.leadDoctor);
            const rev = clientCases.reduce((s, cs) => s + cs.price, 0);
            return (
              <View key={c.id} style={adm.clientRevenueRow}>
                <View style={adm.listItemLeft}>
                  <View style={[adm.listAvatar, { backgroundColor: Colors.light.surfaceSecondary }]}>
                    <Text style={[adm.listAvatarText, { color: Colors.light.textSecondary }]}>{c.practiceName.charAt(0)}</Text>
                  </View>
                  <View>
                    <Text style={adm.listItemTitle}>{c.practiceName}</Text>
                    <Text style={adm.listItemSub}>{clientCases.length} cases</Text>
                  </View>
                </View>
                <Text style={adm.clientRevenueAmount}>${rev.toLocaleString("en-US", { minimumFractionDigits: 2 })}</Text>
              </View>
            );
          }).sort((a, b) => 0)}
        </View>
      </ScrollView>
    );
  }

  switch (adminView) {
    case "clients": return renderClients();
    case "client-detail": return renderClientDetail();
    case "add-client": return renderAddClient();
    case "edit-client": return renderEditClient();
    case "edit-price-list": return renderEditPriceList();
    case "add-user": return renderAddUser();
    case "edit-user": return renderEditUser();
    case "invoices": return renderInvoices();
    case "statements": return renderStatements();
    case "sales": return renderSales();
    default: return renderHub();
  }
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
  avatarName: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
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
