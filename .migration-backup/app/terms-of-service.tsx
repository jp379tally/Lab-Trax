import React from "react";
import { StyleSheet, View, Text, ScrollView, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useTheme } from "@/lib/theme-context";

export default function TermsOfServiceScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12, backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Terms of Service</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: Platform.OS === "web" ? 84 + 40 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.lastUpdated, { color: colors.textSecondary }]}>Last Updated: March 29, 2026</Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>1. Acceptance of Terms</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          By downloading, installing, or using the LabTrax mobile application ("App") provided by Allied Dental Lab ("we," "our," or "us"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree, do not use the App.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>2. Description of Service</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          LabTrax is a dental laboratory case management platform that enables dental labs and dental providers to:{"\n\n"}
          • Track and manage dental cases through all production stages{"\n"}
          • Scan and digitize dental prescriptions using AI-assisted technology{"\n"}
          • Generate invoices, shipping labels, and case documentation{"\n"}
          • Communicate regarding case status, modifications, and delivery{"\n"}
          • Scan barcodes for case identification and tracking
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>3. Account Registration</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          You must create an account to use LabTrax. You agree to:{"\n\n"}
          • Provide accurate, current, and complete registration information{"\n"}
          • Maintain the security of your login credentials{"\n"}
          • Accept responsibility for all activity under your account{"\n"}
          • Notify us immediately of any unauthorized use{"\n\n"}
          You must be at least 18 years old and a licensed dental professional or authorized lab personnel to use this App.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>4. Acceptable Use</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          You agree to use LabTrax only for lawful dental laboratory management purposes. You shall not:{"\n\n"}
          • Use the App for any illegal or unauthorized purpose{"\n"}
          • Attempt to gain unauthorized access to other users' data{"\n"}
          • Upload malicious content or interfere with App functionality{"\n"}
          • Share login credentials with unauthorized individuals{"\n"}
          • Use the App in violation of HIPAA or other applicable regulations{"\n"}
          • Reverse-engineer, decompile, or disassemble the App
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>5. Protected Health Information (PHI)</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          LabTrax may process Protected Health Information as defined by HIPAA. You are responsible for ensuring your use of the App complies with all applicable privacy and security regulations. You agree not to input any PHI that is not necessary for legitimate dental case management purposes. A separate Business Associate Agreement (BAA) may be required for HIPAA-covered entities.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>6. Intellectual Property</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          The App, including its design, features, content, and underlying technology, is owned by Allied Dental Lab and protected by intellectual property laws. Your use of the App does not grant you any ownership rights. You retain ownership of the data and content you submit through the App.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>7. AI-Assisted Features</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          LabTrax includes AI-assisted features such as prescription scanning and smile preview. These features are provided as aids and should not be solely relied upon for clinical decisions. You are responsible for verifying all AI-generated outputs. Allied Dental Lab makes no warranties regarding the accuracy of AI-assisted features.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>8. Limitation of Liability</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          To the maximum extent permitted by law, Allied Dental Lab shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of data, revenue, or business opportunities, arising from your use of the App. Our total liability shall not exceed the amount paid by you for the App in the twelve months preceding the claim.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>9. Disclaimer of Warranties</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          The App is provided "as is" and "as available" without warranties of any kind, either express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the App will be uninterrupted, error-free, or completely secure.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>10. Termination</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We may suspend or terminate your access to the App at any time for violation of these Terms or for any other reason at our discretion. You may delete your account at any time through the App settings. Upon termination, your right to use the App ceases, and we may delete your data in accordance with our Privacy Policy.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>11. Modifications</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          We reserve the right to modify these Terms at any time. Material changes will be communicated through the App. Your continued use after changes are posted constitutes acceptance of the modified Terms.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>12. Governing Law</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          These Terms shall be governed by and construed in accordance with the laws of the State in which Allied Dental Lab operates, without regard to conflict of law provisions.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>13. Contact Us</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          For questions about these Terms, contact us at:{"\n\n"}
          Allied Dental Lab{"\n"}
          Email: legal@allieddl.com{"\n"}
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
