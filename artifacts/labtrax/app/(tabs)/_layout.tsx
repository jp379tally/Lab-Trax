import React from "react";
import { Tabs, usePathname } from "expo-router";
import { Platform, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { useDuplicateDoctorClusters } from "@/lib/duplicate-doctors";
import { useMessengerUnreadCount } from "@/lib/messenger";
import { useInAppNotifications } from "@/lib/in-app-notifications";
import { useAuth } from "@/lib/auth-context";

// Land on Dashboard (not the Cases `index` route) when the authenticated tab
// group mounts — on first login and on authenticated relaunch.
export const unstable_settings = {
  initialRouteName: "dashboard",
};

export default function TabLayout() {
  const { colors } = useTheme();
  const pathname = usePathname();
  const { userType } = useAuth();
  const isDashboard = userType !== "provider" && pathname.endsWith("/dashboard");
  const isWeb = Platform.OS === "web";
  const { totalGroups } = useDuplicateDoctorClusters();
  const { total: unreadMessages } = useMessengerUnreadCount();
  const { unreadCount: unreadNotifications } = useInAppNotifications();
  const moreBadgeCount = totalGroups + unreadMessages + unreadNotifications;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.backgroundSolid,
        maxWidth: isWeb ? (isDashboard ? 1040 : 600) : undefined,
        alignSelf: isWeb ? ("center" as const) : undefined,
        width: isWeb ? "100%" : undefined,
      }}
    >
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: isDashboard ? "#1D5FD8" : colors.tint,
          tabBarInactiveTintColor: isDashboard ? "#BFD0F0" : colors.tabIconDefault,
          tabBarStyle: {
            backgroundColor: isDashboard ? "#0B1B3F" : colors.surface,
            borderTopWidth: 1,
            borderTopColor: isDashboard ? "#263A5C" : colors.border,
          },
          tabBarItemStyle: {
            flex: 1,
            minWidth: 0,
            borderRightWidth: 1,
            borderRightColor: isDashboard ? "#263A5C" : colors.border,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: "600",
            marginTop: 1,
          },
          tabBarLabelPosition: "below-icon",
        }}
      >
        <Tabs.Screen
          name="dashboard"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "grid" : "grid-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="index"
          options={{
            title: "Cases",
            tabBarActiveTintColor: colors.tint,
            tabBarIcon: ({ color, focused }) => (
              <View style={{
                minWidth: 38,
                height: 30,
                paddingHorizontal: 7,
                borderRadius: 11,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: focused ? colors.casesActiveTab : "transparent",
              }}>
                <Ionicons name={focused ? "file-tray-full" : "file-tray-full-outline"} size={22} color={color} />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="account"
          options={{
            title: "Account",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "person" : "person-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="financial"
          options={{
            title: "Financial",
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "card" : "card-outline"} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: "More",
            tabBarBadge: moreBadgeCount > 0 ? (moreBadgeCount > 99 ? "99+" : moreBadgeCount) : undefined,
            tabBarBadgeStyle: { backgroundColor: "#ef4444", color: "#ffffff" },
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "ellipsis-horizontal-circle" : "ellipsis-horizontal-circle-outline"} size={22} color={color} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}
