import React, { useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Switch,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import Colors from "@/constants/colors";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [darkMode, setDarkMode] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [hapticFeedback, setHapticFeedback] = useState(true);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 84 + 40 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>APPEARANCE</Text>
          <View style={styles.menuGroup}>
            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: "#1E293B" }]}>
                <Ionicons name="moon" size={18} color="#FFF" />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Dark Mode</Text>
                <Text style={styles.menuSub}>Switch to dark theme</Text>
              </View>
              <Switch
                value={darkMode}
                onValueChange={(val) => {
                  setDarkMode(val);
                  Alert.alert("Coming Soon", "Dark mode will be available in the next update.");
                  setDarkMode(false);
                }}
                trackColor={{ false: Colors.light.border, true: Colors.light.tint }}
                thumbColor="#FFF"
              />
            </View>

            <View style={styles.menuDivider} />

            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => Alert.alert("Company Logo", "Upload your company logo to customize the app background and branding. This feature is coming soon.")}
            >
              <View style={[styles.menuIcon, { backgroundColor: Colors.light.accentLight }]}>
                <MaterialCommunityIcons name="image-edit" size={18} color={Colors.light.accent} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Company Logo</Text>
                <Text style={styles.menuSub}>Customize app branding</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
          <View style={styles.menuGroup}>
            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: Colors.light.errorLight }]}>
                <Ionicons name="notifications" size={18} color={Colors.light.error} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Push Notifications</Text>
                <Text style={styles.menuSub}>Receive case updates</Text>
              </View>
              <Switch
                value={notifications}
                onValueChange={setNotifications}
                trackColor={{ false: Colors.light.border, true: Colors.light.tint }}
                thumbColor="#FFF"
              />
            </View>

            <View style={styles.menuDivider} />

            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: Colors.light.warningLight }]}>
                <Ionicons name="phone-portrait" size={18} color={Colors.light.warning} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Haptic Feedback</Text>
                <Text style={styles.menuSub}>Vibration on interactions</Text>
              </View>
              <Switch
                value={hapticFeedback}
                onValueChange={setHapticFeedback}
                trackColor={{ false: Colors.light.border, true: Colors.light.tint }}
                thumbColor="#FFF"
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>DATA</Text>
          <View style={styles.menuGroup}>
            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => Alert.alert("Export Data", "Your case data export will be prepared. This feature is coming soon.")}
            >
              <View style={[styles.menuIcon, { backgroundColor: Colors.light.successLight }]}>
                <Ionicons name="download" size={18} color={Colors.light.success} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Export Cases</Text>
                <Text style={styles.menuSub}>Download case data as CSV</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
            </Pressable>

            <View style={styles.menuDivider} />

            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: Colors.light.tintLight }]}>
                <Ionicons name="shield-checkmark" size={18} color={Colors.light.tint} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Security</Text>
                <Text style={styles.menuSub}>HIPAA Compliant - AES-256</Text>
              </View>
            </View>

            <View style={styles.menuDivider} />

            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: Colors.light.surfaceSecondary }]}>
                <Ionicons name="information-circle" size={18} color={Colors.light.textSecondary} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={styles.menuTitle}>Version</Text>
                <Text style={styles.menuSub}>v2.1 (2026 Ready)</Text>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    backgroundColor: Colors.light.surface,
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  section: {
    paddingHorizontal: 20,
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textTertiary,
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  menuGroup: {
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.light.border,
    overflow: "hidden",
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 14,
  },
  menuIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  menuInfo: {
    flex: 1,
  },
  menuTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  menuSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  menuDivider: {
    height: 1,
    backgroundColor: Colors.light.borderLight,
    marginLeft: 68,
  },
});
