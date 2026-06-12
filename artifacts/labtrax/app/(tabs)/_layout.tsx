import React from "react";
import { Tabs } from "expo-router";
import { Platform, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";

export default function TabLayout() {
  const { colors } = useTheme();
  const isWeb = Platform.OS === "web";

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.backgroundSolid,
        maxWidth: isWeb ? 600 : undefined,
        alignSelf: isWeb ? ("center" as const) : undefined,
        width: isWeb ? "100%" : undefined,
      }}
    >
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.tint,
          tabBarInactiveTintColor: colors.tabIconDefault,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
          },
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
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "file-tray-full" : "file-tray-full-outline"} size={22} color={color} />
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
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "ellipsis-horizontal-circle" : "ellipsis-horizontal-circle-outline"} size={22} color={color} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}
