import React from "react";
import { StyleSheet, View, Text, ScrollView, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useTheme } from "@/lib/theme-context";

export default function PrivacyPolicyScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12, backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Privacy Policy</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 24, paddingBottom: Platform.OS === "web" ? 84 + 40 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.iconContainer, { backgroundColor: colors.tintLight }]}>
          <Ionicons name="shield-checkmark" size={40} color={colors.tint} />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>Your Privacy Matters</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Last Updated: March 29, 2026</Text>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <View style={styles.cardRow}>
            <View style={[styles.bullet, { backgroundColor: "#DBEAFE" }]}>
              <Ionicons name="person" size={18} color="#2563EB" />
            </View>
            <View style={styles.cardContent}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Information We Collect</Text>
              <Text style={[styles.cardBody, { color: colors.textSecondary }]}>We collect user info to manage dental cases. This includes your name, email, and case-related data you enter into the app.</Text>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <View style={styles.cardRow}>
            <View style={[styles.bullet, { backgroundColor: "#FEE2E2" }]}>
              <Ionicons name="close-circle" size={18} color="#DC2626" />
            </View>
            <View style={styles.cardContent}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>We Do Not Sell Data</Text>
              <Text style={[styles.cardBody, { color: colors.textSecondary }]}>Your personal information and case data are never sold to third parties. Your data stays between you and your connected dental lab or provider.</Text>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <View style={styles.cardRow}>
            <View style={[styles.bullet, { backgroundColor: "#D1FAE5" }]}>
              <Ionicons name="checkmark-circle" size={18} color="#059669" />
            </View>
            <View style={styles.cardContent}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Data Used for App Functionality Only</Text>
              <Text style={[styles.cardBody, { color: colors.textSecondary }]}>All data collected is used solely to provide and improve the LabTrax case management experience. We use it for case tracking, communication, and invoicing.</Text>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <View style={styles.cardRow}>
            <View style={[styles.bullet, { backgroundColor: "#EDE9FE" }]}>
              <Ionicons name="lock-closed" size={18} color="#7C3AED" />
            </View>
            <View style={styles.cardContent}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Security</Text>
              <Text style={[styles.cardBody, { color: colors.textSecondary }]}>We use encryption, biometric authentication, and role-based access controls to keep your data safe and HIPAA-compliant.</Text>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <View style={styles.cardRow}>
            <View style={[styles.bullet, { backgroundColor: "#FEF3C7" }]}>
              <Ionicons name="trash" size={18} color="#D97706" />
            </View>
            <View style={styles.cardContent}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Account Deletion</Text>
              <Text style={[styles.cardBody, { color: colors.textSecondary }]}>You can delete your account and all associated data at any time from the Settings screen.</Text>
            </View>
          </View>
        </View>

        <Text style={[styles.contact, { color: colors.textTertiary }]}>
          Questions? Contact us at privacy@allieddl.com
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  iconContainer: {
    width: 72,
    height: 72,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginTop: 12,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginBottom: 28,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  bullet: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  cardBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  contact: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 20,
  },
});
