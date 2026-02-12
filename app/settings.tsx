import React from "react";
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
import { useTheme } from "@/lib/theme-context";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { mode, setMode, colors, isDark } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12, backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 84 + 40 : 120 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>APPEARANCE</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: isDark ? "#334155" : "#1E293B" }]}>
                <Ionicons name="moon" size={18} color={isDark ? "#FBBF24" : "#FFF"} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Night Mode</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>
                  {isDark ? "Dark background enabled" : "Switch to dark background"}
                </Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={(val) => {
                  setMode(val ? "dark" : "light");
                }}
                trackColor={{ false: colors.border, true: colors.tint }}
                thumbColor="#FFF"
              />
            </View>

            <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => Alert.alert("Company Logo", "Upload your company logo to customize the app background and branding. This feature is coming soon.")}
            >
              <View style={[styles.menuIcon, { backgroundColor: colors.accentLight }]}>
                <MaterialCommunityIcons name="image-edit" size={18} color={colors.accent} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Company Logo</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Customize app branding</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>NOTIFICATIONS</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: colors.errorLight }]}>
                <Ionicons name="notifications" size={18} color={colors.error} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Push Notifications</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Receive case updates</Text>
              </View>
              <Switch
                value={true}
                onValueChange={() => {}}
                trackColor={{ false: colors.border, true: colors.tint }}
                thumbColor="#FFF"
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>DATA</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => Alert.alert("Export Data", "Your case data export will be prepared. This feature is coming soon.")}
            >
              <View style={[styles.menuIcon, { backgroundColor: colors.successLight }]}>
                <Ionicons name="download" size={18} color={colors.success} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Export Cases</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Download case data as CSV</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>

            <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: colors.tintLight }]}>
                <Ionicons name="shield-checkmark" size={18} color={colors.tint} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Security</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>HIPAA Compliant - AES-256</Text>
              </View>
            </View>

            <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

            <View style={styles.menuItem}>
              <View style={[styles.menuIcon, { backgroundColor: colors.surfaceSecondary }]}>
                <Ionicons name="information-circle" size={18} color={colors.textSecondary} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Version</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>v2.1 (2026 Ready)</Text>
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
  },
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
    fontFamily: "Inter_700Bold",
  },
  section: {
    paddingHorizontal: 20,
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  menuGroup: {
    borderRadius: 18,
    borderWidth: 1,
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
  },
  menuSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  menuDivider: {
    height: 1,
    marginLeft: 68,
  },
});
