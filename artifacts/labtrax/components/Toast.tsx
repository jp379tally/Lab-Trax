import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useApp } from "@/lib/app-context";

// Lightweight transient toast rendered once at the authed root. Reads the
// current toast from app-context, slides in from the bottom, and auto-dismisses
// (the timer lives in app-context). Used to surface background failures — e.g.
// a photo upload that exhausted its chunk retries — instead of failing silently.
export function Toast() {
  const { toast, dismissToast } = useApp();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (toast) {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      translateY.setValue(80);
      opacity.setValue(0);
    }
  }, [toast, translateY, opacity]);

  if (!toast) return null;

  const isError = toast.variant === "error";
  const iconName = isError ? "alert-circle" : "information-circle";
  const accent = isError ? colors.errorStrong : colors.infoStrong;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          bottom: insets.bottom > 0 ? insets.bottom + 12 : 24,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      <Pressable
        onPress={dismissToast}
        accessibilityRole="alert"
        accessibilityLabel={toast.message}
        style={[styles.card, { borderLeftColor: accent }]}
      >
        <Ionicons name={iconName} size={20} color={accent} style={styles.icon} />
        <Text style={styles.text} numberOfLines={3}>
          {toast.message}
        </Text>
        <View style={styles.closeHit}>
          <Ionicons name="close" size={16} color={colors.textSecondary} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      position: "absolute",
      left: 16,
      right: 16,
      alignItems: "center",
      zIndex: 9999,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      maxWidth: 520,
      width: "100%",
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderLeftWidth: 4,
      paddingVertical: 12,
      paddingHorizontal: 14,
      ...Platform.select({
        ios: {
          shadowColor: "#0F172A",
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.18,
          shadowRadius: 12,
        },
        android: { elevation: 6 },
        default: {},
      }),
    },
    icon: {
      flexShrink: 0,
    },
    text: {
      flex: 1,
      fontSize: 13,
      lineHeight: 18,
      fontFamily: "Inter_500Medium",
      color: colors.text,
    },
    closeHit: {
      flexShrink: 0,
      padding: 2,
    },
  });
