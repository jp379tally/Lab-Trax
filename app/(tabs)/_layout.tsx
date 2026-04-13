import { Tabs } from "expo-router";
import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View, Text, Pressable, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useProviderFilteredNotifications } from "@/lib/useFilteredNotifications";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";

const SIDEBAR_WIDTH = 220;

function DesktopSidebar({ state, descriptors, navigation }: any) {
  const { isDark, colors } = useTheme();
  const filteredNotifs = useProviderFilteredNotifications();
  const unreadCount = filteredNotifs.filter((n: any) => !n.read).length;

  return (
    <View style={{
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: SIDEBAR_WIDTH,
      zIndex: 100,
      backgroundColor: isDark ? "#0B1120" : "#F1F5FB",
      borderRightWidth: 1,
      borderRightColor: isDark ? "#1E293B" : "#D6E4F0",
      paddingTop: 24,
    }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 28, paddingTop: 8 }}>
        <LinearGradient
          colors={[Colors.light.tint, "#3B82F6"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center", marginBottom: 10 }}
        >
          <Ionicons name="flask" size={18} color="#FFF" />
        </LinearGradient>
        <Text style={{ fontFamily: "Inter_700Bold", fontSize: 17, color: isDark ? "#F1F5F9" : Colors.light.text }}>LabTrax</Text>
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: isDark ? "#64748B" : Colors.light.textSecondary, marginTop: 2 }}>Lab Management</Text>
      </View>

      {state.routes.map((route: any, index: number) => {
        const { options } = descriptors[route.key];
        if (options.href === null) return null;

        const isFocused = state.index === index;
        const label = options.title || route.name;

        const onPress = () => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        let iconName: any = "home-outline";
        let iconFocused: any = "home";
        if (route.name === "index") { iconName = "home-outline"; iconFocused = "home"; }
        else if (route.name === "cases") { iconName = "file-tray-full-outline"; iconFocused = "file-tray-full"; }
        else if (route.name === "scan") { iconName = "cloud-upload-outline"; iconFocused = "cloud-upload"; }
        else if (route.name === "notifications") { iconName = "notifications-outline"; iconFocused = "notifications"; }
        else if (route.name === "profile") { iconName = "person-outline"; iconFocused = "person"; }

        const displayLabel = route.name === "scan" ? "Rx Upload" : label;

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingLeft: 20,
              paddingVertical: 11,
              marginHorizontal: 10,
              marginVertical: 2,
              borderRadius: 10,
              backgroundColor: isFocused
                ? (isDark ? "rgba(37,99,235,0.15)" : "rgba(37,99,235,0.1)")
                : pressed
                  ? (isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)")
                  : "transparent",
            })}
          >
            <Ionicons
              name={isFocused ? iconFocused : iconName}
              size={20}
              color={isFocused ? colors.tint : (isDark ? "#94A3B8" : colors.tabIconDefault)}
            />
            <Text style={{
              fontFamily: isFocused ? "Inter_600SemiBold" : "Inter_500Medium",
              fontSize: 14,
              color: isFocused ? colors.tint : (isDark ? "#CBD5E1" : colors.tabIconDefault),
              flex: 1,
            }}>
              {displayLabel}
            </Text>
            {route.name === "notifications" && unreadCount > 0 && (
              <View style={{
                backgroundColor: "#EF4444",
                borderRadius: 10,
                minWidth: 20,
                height: 20,
                justifyContent: "center",
                alignItems: "center",
                paddingHorizontal: 6,
                marginRight: 8,
              }}>
                <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>{unreadCount}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
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
  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = isWeb && windowWidth >= 768;

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        sceneContainerStyle={{
          backgroundColor: colors.backgroundSolid,
          ...(isDesktop ? { marginLeft: SIDEBAR_WIDTH } : {}),
        }}
        tabBar={isDesktop ? (props) => <DesktopSidebar {...props} /> : undefined}
        screenOptions={{
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          headerShown: false,
          tabBarStyle: isDesktop ? { display: "none" } : {
            position: "absolute" as const,
            backgroundColor: isIOS ? "transparent" : isDark ? "#000" : "rgba(224,237,251,0.95)",
            borderTopWidth: isWeb ? 1 : 0,
            borderTopColor: isDark ? "#333" : "#E2E8F0",
            elevation: 0,
            ...(isWeb ? { height: 84 } : {}),
          },
          tabBarBackground: () =>
            isDesktop ? null :
            isIOS ? (
              <BlurView
                intensity={100}
                tint={isDark ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
            ) : isWeb ? (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: isDark ? "#000" : "rgba(224,237,251,0.95)" },
                ]}
              />
            ) : null,
          tabBarLabelStyle: {
            fontFamily: "Inter_500Medium",
            fontSize: 10,
          },
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
  return <ClassicTabLayout />;
}
