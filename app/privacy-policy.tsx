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
        contentContainerStyle={{ padding: 20, paddingBottom: Platform.OS === "web" ? 84 + 40 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.lastUpdated, { color: colors.textSecondary }]}>Last Updated: March 29, 2026</Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>1. Introduction</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Allied Dental Lab ("we," "our," or "us") operates the LabTrax mobile application (the "App"). This Privacy Policy describes how we collect, use, disclose, and protect your personal information when you use our App. We are committed to safeguarding your privacy and complying with all applicable laws, including the Health Insurance Portability and Accountability Act (HIPAA).
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>2. Information We Collect</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We collect the following categories of information:{"\n\n"}
          <Text style={{ fontFamily: "Inter_600SemiBold" }}>Account Information:</Text> Name, email address, phone number, practice or lab name, license number, and address when you create an account.{"\n\n"}
          <Text style={{ fontFamily: "Inter_600SemiBold" }}>Case Data:</Text> Dental case details including patient identifiers, prescriptions, photos, notes, status updates, tracking numbers, and barcode information.{"\n\n"}
          <Text style={{ fontFamily: "Inter_600SemiBold" }}>Device Information:</Text> Camera access for scanning prescriptions and documenting cases, photo library access for attaching images, location data for address auto-fill during setup, and biometric data (Face ID/Touch ID) for secure authentication.{"\n\n"}
          <Text style={{ fontFamily: "Inter_600SemiBold" }}>Usage Data:</Text> App interaction logs, feature usage patterns, and error reports to improve service quality.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>3. How We Use Your Information</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We use the information we collect to:{"\n\n"}
          • Provide and maintain the LabTrax case management service{"\n"}
          • Facilitate communication between dental labs and providers{"\n"}
          • Generate invoices, labels, and case documentation{"\n"}
          • Process prescription scans using AI-assisted technology{"\n"}
          • Authenticate your identity and secure access to the App{"\n"}
          • Improve our services and develop new features{"\n"}
          • Comply with legal and regulatory requirements
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>4. HIPAA Compliance</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          LabTrax is designed to support HIPAA technical safeguard requirements. We implement the following protections:{"\n\n"}
          • 256-bit TLS encryption for all data in transit{"\n"}
          • Role-based access control (RBAC) limiting data visibility{"\n"}
          • Automatic session lock with biometric re-authentication{"\n"}
          • Comprehensive audit trail for all PHI (Protected Health Information) access{"\n"}
          • Secure credential storage using device-level encryption{"\n\n"}
          Dental practices and labs using LabTrax should execute a Business Associate Agreement (BAA) with Allied Dental Lab if required by their HIPAA compliance program.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>5. Data Sharing and Disclosure</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We do not sell your personal information to third parties. We may share information:{"\n\n"}
          • With dental labs and providers you are connected to through the App for case management purposes{"\n"}
          • With service providers who assist in operating our services (e.g., cloud hosting, AI processing), bound by confidentiality agreements{"\n"}
          • When required by law, regulation, or legal process{"\n"}
          • To protect the rights, safety, or property of Allied Dental Lab, our users, or the public
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>6. Data Retention</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We retain your account and case data for as long as your account is active or as needed to provide services. You may request deletion of your account and associated data at any time through the Settings screen. Upon account deletion, we will remove your personal data within 30 days, except where retention is required by law or for legitimate business purposes.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>7. Your Rights</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          You have the right to:{"\n\n"}
          • Access the personal information we hold about you{"\n"}
          • Request correction of inaccurate information{"\n"}
          • Request deletion of your account and data{"\n"}
          • Export your case data{"\n"}
          • Withdraw consent for optional data processing{"\n\n"}
          To exercise these rights, contact us at privacy@allieddl.com or use the in-app settings.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>8. Security</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We implement industry-standard security measures to protect your information, including encryption, secure authentication, access controls, and regular security assessments. However, no method of electronic transmission or storage is 100% secure, and we cannot guarantee absolute security.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>9. Children's Privacy</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          LabTrax is not intended for use by individuals under the age of 18. We do not knowingly collect personal information from children.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>10. Changes to This Policy</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We may update this Privacy Policy from time to time. We will notify you of material changes through the App or via email. Your continued use of the App after changes are posted constitutes acceptance of the updated policy.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>11. Contact Us</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          If you have questions about this Privacy Policy or our data practices, contact us at:{"\n\n"}
          Allied Dental Lab{"\n"}
          Email: privacy@allieddl.com{"\n"}
          Website: www.AlliedDL.com
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
  lastUpdated: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    marginTop: 20,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
});
