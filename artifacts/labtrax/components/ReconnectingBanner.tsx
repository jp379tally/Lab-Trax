import React from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useAuth } from "@/lib/auth-context";

export function ReconnectingBanner() {
  const { isReconnecting } = useAuth();
  if (!isReconnecting) return null;
  return (
    <View style={styles.pill} pointerEvents="none">
      <ActivityIndicator size="small" color="#fff" /* hex-allow: white spinner on fixed-dark reconnecting pill */ />
      <Text style={styles.label}>Reconnecting…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    top: 52,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(15, 23, 42, 0.82)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 24,
    zIndex: 9999,
  },
  label: {
    color: "#fff", // hex-allow: white label on fixed-dark reconnecting pill
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
