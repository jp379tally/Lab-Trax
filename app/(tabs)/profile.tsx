import React, { useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";

type WorkStatus = "working" | "break" | "left";

export default function ProfileScreen() {
  const { role, setRole, adminUnlocked, setAdminUnlocked } = useApp();
  const { logout, currentUser, profilePicUri } = useAuth();
  const insets = useSafeAreaInsets();
  const [workStatus, setWorkStatus] = useState<WorkStatus>("working");

  function handleStatusChange(status: WorkStatus) {
    setWorkStatus(status);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }

  const statusConfig: { key: WorkStatus; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }[] = [
    { key: "working", label: "Working", icon: "flash", color: Colors.light.success, bg: Colors.light.successLight },
    { key: "break", label: "Taking a Break", icon: "cafe", color: Colors.light.warning, bg: Colors.light.warningLight },
    { key: "left", label: "Left for the Day", icon: "moon", color: Colors.light.textSecondary, bg: Colors.light.surfaceSecondary },
  ];

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
        <View style={styles.avatarContainer}>
          {profilePicUri ? (
            <Image source={{ uri: profilePicUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatar}>
              <Ionicons name="person" size={36} color={Colors.light.tint} />
            </View>
          )}
          <View style={[styles.statusDot, { backgroundColor: workStatus === "working" ? Colors.light.success : workStatus === "break" ? Colors.light.warning : Colors.light.textTertiary }]} />
        </View>
        <Text style={styles.profileName}>
          {currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : role === "tech" ? "Lab Technician" : "Lab Administrator"}
        </Text>
        <Text style={styles.profileRole}>{role === "tech" ? "Technician" : "Administrator"}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>STATUS</Text>
        <View style={styles.statusGroup}>
          {statusConfig.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => handleStatusChange(s.key)}
              style={[
                styles.statusBtn,
                workStatus === s.key && { backgroundColor: s.bg, borderColor: s.color },
              ]}
            >
              <View style={[styles.statusIconWrap, { backgroundColor: workStatus === s.key ? s.color : Colors.light.surfaceSecondary }]}>
                <Ionicons name={s.icon} size={18} color={workStatus === s.key ? "#FFF" : Colors.light.textSecondary} />
              </View>
              <Text style={[styles.statusBtnText, workStatus === s.key && { color: s.color, fontFamily: "Inter_700Bold" }]}>{s.label}</Text>
              {workStatus === s.key && (
                <Ionicons name="checkmark-circle" size={20} color={s.color} style={{ marginLeft: "auto" }} />
              )}
            </Pressable>
          ))}
        </View>
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

      <View style={styles.section}>
        <Pressable
          onPress={logout}
          style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }]}
          testID="logout-button"
        >
          <Ionicons name="log-out-outline" size={20} color={Colors.light.error} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </Pressable>
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
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  avatarContainer: {
    position: "relative" as const,
    marginBottom: 16,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarImage: {
    width: 96,
    height: 96,
    borderRadius: 48,
  },
  statusDot: {
    position: "absolute" as const,
    bottom: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: Colors.light.background,
  },
  profileName: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 4,
  },
  profileRole: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    marginBottom: 4,
  },
  statusGroup: {
    gap: 8,
  },
  statusBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: Colors.light.surface,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
  },
  statusIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    justifyContent: "center" as const,
    alignItems: "center" as const,
  },
  statusBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
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
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: Colors.light.errorLight,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.2)",
    paddingVertical: 16,
    borderRadius: 18,
  },
  logoutText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.error,
  },
});
