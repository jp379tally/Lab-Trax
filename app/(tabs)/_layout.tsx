import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, Icon, Label, Badge } from "expo-router/unstable-native-tabs";
import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View, Text, Pressable, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useProviderFilteredNotifications } from "@/lib/useFilteredNotifications";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

const DESKTOP_BREAKPOINT = 768;

function NativeTabLayout() {
  const { unreadCount } = useApp();
  const { userType } = useAuth();
  const isProvider = userType === "provider";
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>Dashboard</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="cases">
        <Icon sf={{ default: "tray.full", selected: "tray.full.fill" }} />
        <Label>Cases</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="scan" href={isProvider ? null : undefined}>
        <Icon sf={{ default: "location", selected: "location.fill" }} />
        <Label>Locate</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="notifications">
        <Icon sf={{ default: "bell", selected: "bell.fill" }} />
        <Label>Alerts</Label>
        {unreadCount > 0 && <Badge>{unreadCount}</Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile" href={isProvider ? undefined : null}>
        <Icon sf={{ default: "person", selected: "person.fill" }} />
        <Label>Profile</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

type TabItem = {
  key: string;
  label: string;
  icon: string;
  iconFocused: string;
};

const TAB_ITEMS: TabItem[] = [
  { key: "index", label: "Dashboard", icon: "home-outline", iconFocused: "home" },
  { key: "cases", label: "Cases", icon: "file-tray-full-outline", iconFocused: "file-tray-full" },
  { key: "scan", label: "Locate", icon: "location-outline", iconFocused: "location" },
  { key: "notifications", label: "Alerts", icon: "notifications-outline", iconFocused: "notifications" },
];

function DesktopSidebar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { isDark, colors } = useTheme();
  const { userType } = useAuth();
  const isProvider = userType === "provider";
  const filteredNotifs = useProviderFilteredNotifications();
  const unreadCount = filteredNotifs.filter(n => !n.read).length;

  return (
    <View style={[desktopStyles.sidebar, { backgroundColor: isDark ? "#0F172A" : "#FFFFFF", borderRightColor: isDark ? "#1E293B" : "#E2E8F0" }]}>
      <View style={desktopStyles.sidebarLogo}>
        <View style={desktopStyles.logoIcon}>
          <Text style={desktopStyles.logoIconText}>L</Text>
        </View>
        <Text style={[desktopStyles.logoText, { color: colors.text }]}>LabTrax</Text>
        <Text style={[desktopStyles.logoSub, { color: colors.textTertiary }]}>Allied Dental Lab</Text>
      </View>

      <View style={desktopStyles.navItems}>
        {state.routes.map((route, index) => {
          const tabItem = TAB_ITEMS.find(t => t.key === route.name);
          if (!tabItem) return null;
          if (isProvider && tabItem.key === "scan") return null;

          const isFocused = state.index === index;
          const { options } = descriptors[route.key];

          return (
            <Pressable
              key={route.key}
              onPress={() => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!isFocused && !event.defaultPrevented) {
                  navigation.navigate(route.name);
                }
              }}
              style={({ pressed }) => [
                desktopStyles.navItem,
                isFocused && { backgroundColor: isDark ? "rgba(59,130,246,0.12)" : "rgba(37,99,235,0.08)" },
                pressed && { opacity: 0.8 },
              ]}
            >
              <View style={desktopStyles.navIconWrap}>
                <Ionicons
                  name={(isFocused ? tabItem.iconFocused : tabItem.icon) as any}
                  size={20}
                  color={isFocused ? colors.tint : colors.textTertiary}
                />
                {tabItem.key === "notifications" && unreadCount > 0 && (
                  <View style={desktopStyles.navBadge}>
                    <Text style={desktopStyles.navBadgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
                  </View>
                )}
              </View>
              <Text style={[
                desktopStyles.navLabel,
                { color: isFocused ? colors.tint : colors.textSecondary },
                isFocused && { fontFamily: "Inter_600SemiBold" },
              ]}>
                {tabItem.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[desktopStyles.sidebarFooter, { borderTopColor: isDark ? "#1E293B" : "#E2E8F0" }]}>
        <Text style={[desktopStyles.footerText, { color: colors.textTertiary }]}>www.AlliedDL.com</Text>
        <View style={desktopStyles.hipaaRow}>
          <Ionicons name="shield-checkmark" size={12} color="#22C55E" />
          <Text style={[desktopStyles.hipaaText, { color: "#22C55E" }]}>HIPAA Compliant</Text>
        </View>
      </View>
    </View>
  );
}

function ClassicTabLayout() {
  const { isDark, colors } = useTheme();
  const isWeb = Platform.OS === "web";
  const isIOS = Platform.OS === "ios";
  const { role, setRole, setAdminUnlocked } = useApp();
  const { userType } = useAuth();
  const isProvider = userType === "provider";
  const filteredNotifs = useProviderFilteredNotifications();
  const unreadCount = filteredNotifs.filter(n => !n.read).length;
  const { width } = useWindowDimensions();
  const isDesktop = isWeb && width >= DESKTOP_BREAKPOINT;

  return (
    <View style={{ flex: 1, flexDirection: isDesktop ? "row" : "column" }}>
      <Tabs
        tabBar={isDesktop ? (props) => <DesktopSidebar {...props} /> : undefined}
        screenOptions={{
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          headerShown: false,
          tabBarStyle: isDesktop ? { display: "none" as any } : {
            position: "absolute" as const,
            backgroundColor: isIOS ? "transparent" : isDark ? "#000" : "#fff",
            borderTopWidth: isWeb ? 1 : 0,
            borderTopColor: isDark ? "#333" : "#E2E8F0",
            elevation: 0,
            ...(isWeb ? { height: 84 } : {}),
          },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView
                intensity={100}
                tint={isDark ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
            ) : isWeb && !isDesktop ? (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: isDark ? "#000" : "#fff" },
                ]}
              />
            ) : null,
          tabBarLabelStyle: {
            fontFamily: "Inter_500Medium",
            fontSize: 10,
          },
          sceneStyle: isDesktop ? { maxWidth: 1200 } : undefined,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons
                name={focused ? "home" : "home-outline"}
                size={22}
                color={color}
              />
            ),
          }}
          listeners={{
            tabPress: () => {
              if (role === "admin") {
                setRole("user");
                setAdminUnlocked(false);
              }
            },
          }}
        />
        <Tabs.Screen
          name="cases"
          options={{
            title: "Cases",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons
                name={focused ? "file-tray-full" : "file-tray-full-outline"}
                size={22}
                color={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="scan"
          options={{
            title: "Locate",
            href: isProvider ? null : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons
                name={focused ? "location" : "location-outline"}
                size={22}
                color={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="notifications"
          options={{
            title: "Alerts",
            tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons
                name={focused ? "notifications" : "notifications-outline"}
                size={22}
                color={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            href: isProvider ? undefined : null,
            tabBarIcon: ({ color, focused }) => (
              <Ionicons
                name={focused ? "person" : "person-outline"}
                size={22}
                color={color}
              />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}

const desktopStyles = StyleSheet.create({
  sidebar: {
    width: 240,
    borderRightWidth: 1,
    paddingTop: 24,
    justifyContent: "space-between",
  },
  sidebarLogo: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    alignItems: "center",
  },
  logoIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#2563EB",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 10,
  },
  logoIconText: {
    fontSize: 20,
    fontWeight: "700" as const,
    color: "#FFF",
  },
  logoText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  logoSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  navItems: {
    flex: 1,
    paddingHorizontal: 12,
    gap: 4,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    gap: 12,
  },
  navIconWrap: {
    position: "relative",
    width: 24,
    alignItems: "center",
  },
  navBadge: {
    position: "absolute",
    top: -6,
    right: -8,
    backgroundColor: "#EF4444",
    borderRadius: 7,
    minWidth: 14,
    height: 14,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 3,
  },
  navBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  navLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  sidebarFooter: {
    borderTopWidth: 1,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: "center",
    gap: 6,
  },
  footerText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  hipaaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  hipaaText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
  },
});
