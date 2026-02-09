import React from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";

export default function ProfileScreen() {
  const { role, setRole, adminUnlocked, setAdminUnlocked } = useApp();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
        paddingBottom: Platform.OS === "web" ? 84 + 40 : 120,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={32} color={Colors.light.tint} />
        </View>
        <Text style={styles.profileName}>
          {role === "tech" ? "Lab Technician" : "Lab Administrator"}
        </Text>
        <Text style={styles.profileEmail}>DriveSync Lab</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ACTIVE ROLE</Text>
        <View style={styles.roleToggle}>
          <Pressable
            onPress={() => setRole("tech")}
            style={[
              styles.roleBtn,
              role === "tech" && styles.roleBtnActive,
            ]}
          >
            <Ionicons
              name="construct"
              size={18}
              color={role === "tech" ? "#FFF" : Colors.light.textSecondary}
            />
            <Text
              style={[
                styles.roleBtnText,
                role === "tech" && styles.roleBtnTextActive,
              ]}
            >
              Technician
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setRole("admin")}
            style={[
              styles.roleBtn,
              role === "admin" && styles.roleBtnActive,
            ]}
          >
            <Ionicons
              name="shield"
              size={18}
              color={role === "admin" ? "#FFF" : Colors.light.textSecondary}
            />
            <Text
              style={[
                styles.roleBtnText,
                role === "admin" && styles.roleBtnTextActive,
              ]}
            >
              Admin
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>SYSTEM</Text>
        <View style={styles.menuGroup}>
          <View style={styles.menuItem}>
            <View
              style={[
                styles.menuIcon,
                { backgroundColor: Colors.light.tintLight },
              ]}
            >
              <Ionicons
                name="shield-checkmark"
                size={18}
                color={Colors.light.tint}
              />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Security</Text>
              <Text style={styles.menuSub}>HIPAA Compliant - AES-256</Text>
            </View>
          </View>

          <View style={styles.menuDivider} />

          <View style={styles.menuItem}>
            <View
              style={[
                styles.menuIcon,
                { backgroundColor: Colors.light.successLight },
              ]}
            >
              <Ionicons
                name="cloud-done"
                size={18}
                color={Colors.light.success}
              />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Cloud Sync</Text>
              <Text style={styles.menuSub}>OneDrive Connected</Text>
            </View>
          </View>

          <View style={styles.menuDivider} />

          <View style={styles.menuItem}>
            <View
              style={[
                styles.menuIcon,
                { backgroundColor: Colors.light.accentLight },
              ]}
            >
              <MaterialCommunityIcons
                name="database-check"
                size={18}
                color={Colors.light.accent}
              />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Local Cache</Text>
              <Text style={styles.menuSub}>
                Offline mode ready - syncs when online
              </Text>
            </View>
          </View>

          <View style={styles.menuDivider} />

          <View style={styles.menuItem}>
            <View
              style={[
                styles.menuIcon,
                { backgroundColor: Colors.light.warningLight },
              ]}
            >
              <Ionicons
                name="finger-print"
                size={18}
                color={Colors.light.warning}
              />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Biometric Auth</Text>
              <Text style={styles.menuSub}>
                FaceID / TouchID for admin access
              </Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ABOUT</Text>
        <View style={styles.menuGroup}>
          <View style={styles.menuItem}>
            <View
              style={[
                styles.menuIcon,
                { backgroundColor: Colors.light.surfaceSecondary },
              ]}
            >
              <Ionicons
                name="information-circle"
                size={18}
                color={Colors.light.textSecondary}
              />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Version</Text>
              <Text style={styles.menuSub}>v2.1 (2026 Ready)</Text>
            </View>
          </View>

          <View style={styles.menuDivider} />

          <View style={styles.menuItem}>
            <View
              style={[
                styles.menuIcon,
                { backgroundColor: Colors.light.surfaceSecondary },
              ]}
            >
              <Ionicons
                name="code-slash"
                size={18}
                color={Colors.light.textSecondary}
              />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Audit Trail</Text>
              <Text style={styles.menuSub}>
                Immutable cryptographic timestamps
              </Text>
            </View>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  profileCard: {
    alignItems: "center",
    paddingVertical: 24,
    paddingHorizontal: 20,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 28,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  profileName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 4,
  },
  profileEmail: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  section: {
    paddingHorizontal: 20,
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textTertiary,
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  roleToggle: {
    flexDirection: "row",
    backgroundColor: Colors.light.surfaceSecondary,
    borderRadius: 16,
    padding: 4,
  },
  roleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 13,
  },
  roleBtnActive: {
    backgroundColor: Colors.light.tint,
  },
  roleBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  roleBtnTextActive: {
    color: "#FFF",
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
