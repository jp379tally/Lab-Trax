import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { router, usePathname } from "expo-router";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useDrawer } from "@/lib/drawer-context";
import { useAuth } from "@/lib/auth-context";
import { useApp } from "@/lib/app-context";

const DRAWER_WIDTH = Math.min(Dimensions.get("window").width * 0.82, 340);

interface NavItemDef {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  path?: string;
  onPress?: () => void;
  adminOnly?: boolean;
  labOnly?: boolean;
  providerOnly?: boolean;
}

interface NavGroupDef {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: NavItemDef[];
}

type NavEntry = NavItemDef | NavGroupDef;

function isGroup(e: NavEntry): e is NavGroupDef {
  return "children" in e;
}

const WORKSPACE_NAV: NavEntry[] = [
  { key: "dashboard", label: "Dashboard",      icon: "home-outline",           path: "/(tabs)" },
  { key: "cases",     label: "Cases",           icon: "file-tray-full-outline", path: "/(tabs)/cases" },
  { key: "accounts",  label: "Accounts",        icon: "business-outline",       path: "/customers" },
  {
    key: "financial",
    label: "Financial",
    icon: "wallet-outline",
    children: [
      { key: "invoices",          label: "Invoices",         icon: "receipt-outline",       path: "/invoices",          labOnly: true },
      { key: "statements",        label: "Statements",       icon: "document-text-outline", path: "/statements",        labOnly: true },
      { key: "customer-center",   label: "Customer Center",  icon: "people-outline",        path: "/customers",         labOnly: true },
      { key: "bank-register",     label: "Bank Register",    icon: "bar-chart-outline",     path: "/bank-register",     labOnly: true },
      { key: "recv-payments",     label: "Receive Payments", icon: "cash-outline",          path: "/receive-payments",  labOnly: true },
    ],
  },
  { key: "scan",     label: "Scan / New Case",  icon: "scan-outline",           path: "/(tabs)/scan",    labOnly: true },
  { key: "pricing",  label: "Pricing",          icon: "pricetag-outline",       path: "/pricing",        labOnly: true, adminOnly: true },
  { key: "reports",  label: "Reports",          icon: "stats-chart-outline",    path: "/reports",        labOnly: true },
  { key: "lists",    label: "Lists",            icon: "list-outline",           path: "/lists",          labOnly: true },
];

const SYSTEM_NAV: NavItemDef[] = [
  { key: "subscription",  label: "Subscription",  icon: "flash-outline",     path: "/subscription" },
  { key: "settings",      label: "Settings",      icon: "settings-outline",  path: "/settings" },
  { key: "maintenance",   label: "Maintenance",   icon: "construct-outline", path: "/settings",    adminOnly: true },
  { key: "download",      label: "Download App",  icon: "download-outline",  path: "/download" },
];

function NavItemRow({
  item,
  active,
  indent,
  onPress,
}: {
  item: NavItemDef;
  active: boolean;
  indent?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.navItem,
        indent && styles.navItemIndent,
        active && styles.navItemActive,
        pressed && !active && styles.navItemPressed,
      ]}
    >
      <Ionicons
        name={item.icon}
        size={18}
        color={active ? colors.textInverse : "rgba(255,255,255,0.7)"}
      />
      <Text
        style={[
          styles.navLabel,
          active && styles.navLabelActive,
          indent && styles.navLabelIndent,
        ]}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

export function AppDrawer() {
  const { isOpen, closeDrawer } = useDrawer();
  const { isDark, colors } = useTheme();
  const { logout, userType, currentUser } = useAuth();
  const { role, setRole, setAdminUnlocked } = useApp();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const translateX = useSharedValue(-DRAWER_WIDTH);
  const overlayOpacity = useSharedValue(0);
  const [modalVisible, setModalVisible] = useState(false);
  const [financialOpen, setFinancialOpen] = useState(false);

  const openAnim = useCallback(() => {
    setModalVisible(true);
    translateX.value = -DRAWER_WIDTH;
    overlayOpacity.value = 0;
    requestAnimationFrame(() => {
      translateX.value = withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) });
      overlayOpacity.value = withTiming(0.5, { duration: 260 });
    });
  }, []);

  const closeAnim = useCallback(() => {
    translateX.value = withTiming(-DRAWER_WIDTH, { duration: 220, easing: Easing.in(Easing.cubic) });
    overlayOpacity.value = withTiming(0, { duration: 220 }, () => {
      runOnJS(setModalVisible)(false);
      runOnJS(closeDrawer)();
    });
  }, [closeDrawer]);

  useEffect(() => {
    if (isOpen) {
      openAnim();
    } else if (modalVisible) {
      closeAnim();
    }
  }, [isOpen]);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  function navigate(path: string) {
    closeDrawer();
    setTimeout(() => {
      router.push(path as any);
    }, 240);
  }

  function handleSignOut() {
    closeDrawer();
    setTimeout(() => logout(), 280);
  }

  function isActive(item: NavItemDef): boolean {
    if (!item.path) return false;
    if (item.path === "/(tabs)" || item.path === "/") {
      return pathname === "/" || pathname === "/(tabs)" || pathname === "/(tabs)/index";
    }
    return pathname.startsWith(item.path);
  }

  const isProvider = userType === "provider";
  const isAdminUser = role === "admin";

  function shouldShow(item: NavItemDef): boolean {
    if (item.adminOnly && !isAdminUser) return false;
    if (item.labOnly && isProvider) return false;
    if (item.providerOnly && !isProvider) return false;
    return true;
  }

  if (!modalVisible) return null;

  return (
    <Modal
      transparent
      visible={modalVisible}
      animationType="none"
      statusBarTranslucent
      onRequestClose={closeAnim}
    >
      <View style={styles.wrapper}>
        <Animated.View style={[styles.overlay, overlayStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeAnim} />
        </Animated.View>

        <Animated.View style={[styles.drawer, drawerStyle, { width: DRAWER_WIDTH }]}>
          <LinearGradient
            colors={["#0F172A", "#162032"] /* hex-allow: fixed dark drawer gradient (always-dark nav rail) */}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={[
              styles.drawerInner,
              { paddingTop: Platform.OS === "web" ? 67 + 20 : insets.top + 20 },
            ]}
          >
            {/* Brand */}
            <View style={styles.brand}>
              <LinearGradient
                colors={[colors.tint, colors.info]}
                style={styles.brandIcon}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
                <Ionicons name="flask" size={20} color={colors.textInverse} />
              </LinearGradient>
              <View>
                <Text style={styles.brandName}>LabTrax</Text>
                <Text style={styles.brandSub}>
                  {currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : "Lab Management"}
                </Text>
              </View>
            </View>

            <View style={styles.divider} />

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 16 }}
              style={{ flex: 1 }}
            >
              {/* Workspace section */}
              <Text style={styles.sectionLabel}>WORKSPACE</Text>

              {WORKSPACE_NAV.map((entry) => {
                if (isGroup(entry)) {
                  const visibleChildren = entry.children.filter(shouldShow);
                  if (visibleChildren.length === 0) return null;
                  return (
                    <View key={entry.key}>
                      <Pressable
                        onPress={() => setFinancialOpen((v) => !v)}
                        style={({ pressed }) => [
                          styles.navItem,
                          pressed && styles.navItemPressed,
                        ]}
                      >
                        <Ionicons name={entry.icon} size={18} color="rgba(255,255,255,0.7)" />
                        <Text style={styles.navLabel}>{entry.label}</Text>
                        <Ionicons
                          name={financialOpen ? "chevron-down" : "chevron-forward"}
                          size={14}
                          color="rgba(255,255,255,0.3)"
                        />
                      </Pressable>
                      {financialOpen && visibleChildren.map((child) => (
                        <NavItemRow
                          key={child.key}
                          item={child}
                          active={isActive(child)}
                          indent
                          onPress={() => navigate(child.path!)}
                        />
                      ))}
                    </View>
                  );
                }

                if (!shouldShow(entry as NavItemDef)) return null;
                const item = entry as NavItemDef;
                return (
                  <NavItemRow
                    key={item.key}
                    item={item}
                    active={isActive(item)}
                    onPress={() => item.path ? navigate(item.path) : item.onPress?.()}
                  />
                );
              })}

              <View style={[styles.divider, { marginTop: 12 }]} />

              {/* System section */}
              <Text style={styles.sectionLabel}>SYSTEM</Text>

              {SYSTEM_NAV.filter(shouldShow).map((item) => (
                <NavItemRow
                  key={item.key}
                  item={item}
                  active={isActive(item)}
                  onPress={() => navigate(item.path!)}
                />
              ))}

              {/* Admin Mode Toggle */}
              {isAdminUser && (
                <>
                  <View style={[styles.divider, { marginTop: 12 }]} />
                  <Text style={styles.sectionLabel}>QUICK ACTIONS</Text>
                  <Pressable
                    onPress={() => {
                      closeDrawer();
                      setTimeout(() => {
                        setRole("user");
                        setAdminUnlocked(false);
                      }, 280);
                    }}
                    style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed]}
                  >
                    <Ionicons name="shield-outline" size={18} color={colors.warning} />
                    <Text style={[styles.navLabel, { color: colors.warning }]}>Exit Admin Mode</Text>
                  </Pressable>
                </>
              )}
            </ScrollView>

            {/* Sign Out */}
            <View style={styles.divider} />
            <Pressable
              onPress={handleSignOut}
              style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.7 }]}
              testID="drawer-signout"
            >
              <Ionicons name="log-out-outline" size={18} color={colors.error} />
              <Text style={styles.signOutText}>Sign Out</Text>
            </Pressable>
            <View style={{ height: Platform.OS === "web" ? 24 : insets.bottom + 8 }} />
          </LinearGradient>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  wrapper: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
  },
  drawer: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    shadowColor: "#000",
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 24,
  },
  drawerInner: {
    flex: 1,
    paddingHorizontal: 16,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
  },
  brandIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  brandName: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.textInverse,
  },
  brandSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.45)",
    marginTop: 1,
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
    color: "rgba(255,255,255,0.3)",
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 8,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 2,
  },
  navItemIndent: {
    paddingLeft: 20,
    paddingVertical: 9,
  },
  navItemActive: {
    backgroundColor: colors.tint,
  },
  navItemPressed: {
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  navLabel: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.8)",
  },
  navLabelActive: {
    fontFamily: "Inter_600SemiBold",
    color: colors.textInverse,
  },
  navLabelIndent: {
    fontSize: 13,
  },
  signOut: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginTop: 4,
  },
  signOutText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.error,
  },
});
