import { Tabs } from "expo-router";
import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useProviderFilteredNotifications } from "@/lib/useFilteredNotifications";

function ClassicTabLayout() {
  const { isDark, colors } = useTheme();
  const isWeb = Platform.OS === "web";
  const isIOS = Platform.OS === "ios";
  const { role, setRole, setAdminUnlocked } = useApp();
  const { userType } = useAuth();
  const isProvider = userType === "provider";
  const filteredNotifs = useProviderFilteredNotifications();
  const unreadCount = filteredNotifs.filter(n => !n.read).length;

  return (
    <View style={{ flex: 1, maxWidth: isWeb ? 600 : undefined, alignSelf: isWeb ? "center" as const : undefined, width: isWeb ? "100%" : undefined }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          headerShown: false,
          tabBarStyle: {
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
            ) : isWeb ? (
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
