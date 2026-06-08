import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "expo-router";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Image,
  Modal,
  TextInput,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppHeader } from "@/components/ui/AppHeader";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { ChatButton } from "@/components/ChatButton";
import { useEntitlement, type SubscriptionStatus } from "@/lib/useEntitlement";

type WorkStatus = "available" | "break" | "out_of_office";

function entitlementConfig(status: SubscriptionStatus, colors: ThemeColors): {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bg: string;
  borderColor: string;
} {
  switch (status) {
    case "trialing":
      return { label: "Trial", icon: "time-outline", color: colors.violet, bg: colors.violetLight, borderColor: colors.violetLight };
    case "active":
      return { label: "Active", icon: "checkmark-circle", color: colors.success, bg: colors.successLight, borderColor: colors.success };
    case "past_due":
      return { label: "Payment Issue", icon: "warning", color: colors.warning, bg: colors.warningLight, borderColor: colors.warning };
    case "grace":
      return { label: "Grace Period", icon: "alert-circle", color: colors.orange, bg: colors.orangeLight, borderColor: colors.orange };
    case "locked":
      return { label: "Locked", icon: "lock-closed", color: colors.error, bg: colors.errorLight, borderColor: colors.errorLight };
    case "canceled":
      return { label: "Canceled", icon: "close-circle", color: colors.error, bg: colors.errorLight, borderColor: colors.errorLight };
    case "legacy_free":
      return { label: "Legacy Free", icon: "star", color: colors.tint, bg: colors.tintLight, borderColor: colors.infoLight };
    default:
      return { label: status, icon: "ellipse-outline", color: colors.textSecondary, bg: colors.surfaceSecondary, borderColor: colors.border };
  }
}

export default function ProfileScreen() {
  const router = useRouter();
  const { role, setRole, adminUnlocked, setAdminUnlocked, updateWorkStatus, hardRefresh } = useApp();
  const { logout, currentUser, profilePicUri, changePassword, registeredUsers, isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { entitlement } = useEntitlement(isAuthenticated);
  const [refreshing, setRefreshing] = useState(false);
  const [workStatus, setWorkStatus] = useState<WorkStatus>("available");
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [canReceivePayments, setCanReceivePayments] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { resilientFetch } = await import("@/lib/query-client");
        const r = await resilientFetch("/api/auth/me");
        const j = await r.json().catch(() => ({}));
        const memberships: Array<{
          organizationId?: string;
          labId?: string;
          role: string;
          status: string;
          organization?: { type?: string } | null;
        }> = j?.memberships || j?.user?.memberships || [];
        const ok = memberships.some((m) => {
          if (m.status !== "active") return false;
          if (!["owner", "admin", "billing"].includes(m.role)) return false;
          const orgType = m.organization?.type;
          if (orgType && orgType !== "lab") return false;
          return true;
        });
        if (!cancelled) setCanReceivePayments(ok);
      } catch {
        if (!cancelled) setCanReceivePayments(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  useEffect(() => {
    const me = registeredUsers.find((u) => u.username === currentUser);
    if (me && (me as any).workStatus) {
      setWorkStatus((me as any).workStatus as WorkStatus);
    }
  }, [registeredUsers, currentUser]);

  async function handleStatusChange(status: WorkStatus) {
    setWorkStatus(status);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    await updateWorkStatus(status);
  }

  async function handleChangePassword() {
    setPasswordError(null);
    if (!currentPasswordInput.trim()) {
      setPasswordError("Please enter your current password.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }
    if (!/[A-Z]/.test(newPassword)) {
      setPasswordError("New password must contain an uppercase letter.");
      return;
    }
    if (!/[a-z]/.test(newPassword)) {
      setPasswordError("New password must contain a lowercase letter.");
      return;
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(newPassword)) {
      setPasswordError("New password must contain a special character.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }
    const result = await changePassword(currentPasswordInput, newPassword);
    if (!result.success) {
      setPasswordError(result.error || "Failed to change password.");
      return;
    }
    setPasswordSuccess(true);
    setTimeout(() => setShowChangePassword(false), 1500);
  }

  const statusConfig: { key: WorkStatus; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }[] = [
    { key: "available", label: "Available", icon: "checkmark-circle", color: colors.success, bg: colors.successLight },
    { key: "break", label: "Taking a Break", icon: "cafe", color: colors.warning, bg: colors.warningLight },
    { key: "out_of_office", label: "Out of Office", icon: "airplane", color: colors.textSecondary, bg: colors.surfaceSecondary },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
      <AppHeader title="Profile" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={{
          paddingBottom: Platform.OS === "web" ? 84 + 40 : 120,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await hardRefresh();
                setRefreshing(false);
              }}
            />
          ) : undefined
        }
      >
      <View style={styles.profileCard}>
        <View style={styles.avatarContainer}>
          {profilePicUri ? (
            <Image source={{ uri: profilePicUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatar}>
              <Ionicons name="person" size={36} color={colors.tint} />
            </View>
          )}
          <View style={[styles.statusDot, { backgroundColor: workStatus === "available" ? colors.success : workStatus === "break" ? colors.warning : colors.textSecondary }]} />
        </View>
        <Text style={styles.profileName}>
          {currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : role === "user" ? "User" : "Administrator"}
        </Text>
        <Text style={styles.profileRole}>{role === "user" ? "User" : "Administrator"}</Text>
      </View>

      {entitlement && (() => {
        const cfg = entitlementConfig(entitlement.status, colors);
        const daysLabel =
          entitlement.status === "trialing" && entitlement.trialDaysRemaining !== null
            ? `${entitlement.trialDaysRemaining} day${entitlement.trialDaysRemaining === 1 ? "" : "s"} left in trial`
            : entitlement.status === "grace" && entitlement.graceDaysRemaining !== null
            ? `${entitlement.graceDaysRemaining} day${entitlement.graceDaysRemaining === 1 ? "" : "s"} remaining`
            : entitlement.status === "past_due"
            ? "Update payment to keep access"
            : entitlement.status === "locked" || entitlement.status === "canceled"
            ? "Subscribe to restore access"
            : null;

        return (
          <View style={[styles.subscriptionCard, { borderColor: cfg.borderColor }]}>
            <View style={[styles.subscriptionBadge, { backgroundColor: cfg.bg }]}>
              <Ionicons name={cfg.icon} size={14} color={cfg.color} />
              <Text style={[styles.subscriptionBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
            </View>
            <View style={styles.subscriptionBody}>
              {daysLabel ? (
                <Text style={styles.subscriptionDays}>{daysLabel}</Text>
              ) : null}
            </View>
            <Pressable
              onPress={() => router.push("/subscription")}
              style={({ pressed }) => [styles.subscriptionManageBtn, pressed && { opacity: 0.7 }]}
              testID="subscription-manage-shortcut"
            >
              <Text style={styles.subscriptionManageText}>Manage subscription</Text>
              <Ionicons name="chevron-forward" size={14} color={cfg.color} />
            </Pressable>
          </View>
        );
      })()}

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
              <View style={[styles.statusIconWrap, { backgroundColor: workStatus === s.key ? s.color : colors.surfaceSecondary }]}>
                <Ionicons name={s.icon} size={18} color={workStatus === s.key ? colors.textInverse : colors.textSecondary} />
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
        <Text style={styles.sectionTitle}>CREDENTIALS</Text>
        <View style={styles.menuGroup}>
          <View style={styles.menuItem}>
            <View style={[styles.menuIcon, { backgroundColor: colors.tintLight }]}>
              <Ionicons name="person-circle" size={18} color={colors.tint} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Username</Text>
              <Text style={styles.menuSub}>{currentUser || "Not set"}</Text>
            </View>
          </View>
          <View style={styles.menuDivider} />
          <View style={styles.menuItem}>
            <View style={[styles.menuIcon, { backgroundColor: colors.successLight }]}>
              <Ionicons name="shield-checkmark" size={18} color={colors.success} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Role</Text>
              <Text style={styles.menuSub}>{role === "user" ? "User" : "Administrator"}</Text>
            </View>
          </View>
          <View style={styles.menuDivider} />
          <View style={styles.menuItem}>
            <View style={[styles.menuIcon, { backgroundColor: colors.warningLight }]}>
              <Ionicons name="finger-print" size={18} color={colors.warning} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Biometric Auth</Text>
              <Text style={styles.menuSub}>Face ID Enabled</Text>
            </View>
          </View>
          <View style={styles.menuDivider} />
          {(() => {
            if (!canReceivePayments) return null;
            return (
              <>
                <Pressable
                  style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                  onPress={() => router.push("/receive-payments" as any)}
                  testID="receive-payments-button"
                >
                  <View style={[styles.menuIcon, { backgroundColor: colors.successLight }]}>
                    <Ionicons name="cash" size={18} color={colors.successStrong} />
                  </View>
                  <View style={styles.menuInfo}>
                    <Text style={styles.menuTitle}>Receive Payments</Text>
                    <Text style={styles.menuSub}>
                      Apply payments across open invoices
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </Pressable>
                <View style={styles.menuDivider} />
              </>
            );
          })()}
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/customers" as any)}
            testID="customers-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: colors.successSurface }]}>
              <Ionicons name="people-outline" size={18} color={colors.successStrong} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Customers</Text>
              <Text style={styles.menuSub}>
                View practices and open balances
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/payees" as any)}
            testID="payees-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: colors.cyanLight }]}>
              <Ionicons name="receipt-outline" size={18} color={colors.cyan} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Payees</Text>
              <Text style={styles.menuSub}>Browse vendors, employees, and items</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/link-labs" as any)}
            testID="link-labs-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: colors.cyanLight }]}>
              <Ionicons name="link" size={18} color={colors.cyan} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Link Labs</Text>
              <Text style={styles.menuSub}>
                Combine cases & invoices across multiple labs
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/subscription" as any)}
            testID="subscription-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: colors.violetLight }]}>
              <Ionicons name="flash" size={18} color={colors.violet} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Subscription</Text>
              <Text style={styles.menuSub}>Manage your plan and billing</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => {
              setShowChangePassword(true);
              setCurrentPasswordInput("");
              setNewPassword("");
              setConfirmNewPassword("");
              setPasswordError(null);
              setPasswordSuccess(false);
            }}
          >
            <View style={[styles.menuIcon, { backgroundColor: colors.warningLight }]}>
              <Ionicons name="key" size={18} color={colors.warningStrong} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Change Password</Text>
              <Text style={styles.menuSub}>Update your account password</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/two-factor" as any)}
          >
            <View style={[styles.menuIcon, { backgroundColor: colors.violetLight }]}>
              <Ionicons name="shield-checkmark" size={18} color={colors.violet} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Two-Factor Authentication</Text>
              <Text style={styles.menuSub}>Add an extra layer of security</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
          {currentUser && (() => {
            const userData = registeredUsers.find(u => u.username.toLowerCase() === currentUser.toLowerCase());
            if (!userData?.practiceName) return null;
            const acctNum =
              userData.practiceAccountNumber || userData.accountNumber || null;
            return (
              <>
                <View style={styles.menuDivider} />
                <View style={styles.menuItem}>
                  <View style={[styles.menuIcon, { backgroundColor: colors.indigoLight }]}>
                    <Ionicons name="business" size={18} color={colors.indigo} />
                  </View>
                  <View style={[styles.menuInfo, { flex: 1 }]}>
                    <Text style={styles.menuTitle}>Lab</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success }} />
                      <Text style={[styles.menuSub, { marginTop: 0 }]}>{userData.practiceName}</Text>
                    </View>
                    {acctNum ? (
                      <Text
                        style={[
                          styles.menuSub,
                          { marginTop: 4, fontFamily: "Inter_400Regular" },
                        ]}
                      >
                        Account #{acctNum}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </>
            );
          })()}
        </View>
      </View>

      <View style={styles.section}>
        <Pressable
          onPress={logout}
          style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }]}
          testID="logout-button"
        >
          <Ionicons name="log-out-outline" size={20} color={colors.error} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </Pressable>
      </View>
      <Modal
        visible={showChangePassword}
        transparent
        animationType="fade"
        onRequestClose={() => setShowChangePassword(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Change Password</Text>
              <Pressable onPress={() => setShowChangePassword(false)} hitSlop={12}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>

            {passwordSuccess ? (
              <View style={{ alignItems: "center", paddingVertical: 32 }}>
                <Ionicons name="checkmark-circle" size={56} color={colors.success} />
                <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold" as const, color: colors.success, marginTop: 12 }}>
                  Password updated successfully!
                </Text>
              </View>
            ) : (
              <>
                <Text style={styles.modalInputLabel}>Current Password</Text>
                <TextInput
                  style={styles.modalInput}
                  secureTextEntry
                  value={currentPasswordInput}
                  onChangeText={setCurrentPasswordInput}
                  placeholder="Enter current password"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                />

                <Text style={styles.modalInputLabel}>New Password</Text>
                <TextInput
                  style={styles.modalInput}
                  secureTextEntry
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder="Enter new password"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                />

                <Text style={styles.modalInputLabel}>Confirm New Password</Text>
                <TextInput
                  style={styles.modalInput}
                  secureTextEntry
                  value={confirmNewPassword}
                  onChangeText={setConfirmNewPassword}
                  placeholder="Confirm new password"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                />

                {passwordError && (
                  <View style={styles.modalError}>
                    <Ionicons name="alert-circle" size={16} color={colors.error} />
                    <Text style={styles.modalErrorText}>{passwordError}</Text>
                  </View>
                )}

                <Pressable
                  style={({ pressed }) => [styles.modalButton, pressed && { opacity: 0.8 }]}
                  onPress={handleChangePassword}
                >
                  <Ionicons name="lock-closed" size={18} color={colors.textInverse} />
                  <Text style={styles.modalButtonText}>Update Password</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
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
    backgroundColor: colors.tintLight,
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
    borderColor: colors.background,
  },
  profileName: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: colors.text,
    marginBottom: 4,
  },
  profileRole: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.textSecondary,
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
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
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
    color: colors.text,
  },
  section: {
    paddingHorizontal: 20,
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: colors.textTertiary,
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  menuGroup: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
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
    color: colors.text,
  },
  menuSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
    marginTop: 2,
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.borderLight,
    marginLeft: 68,
  },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.errorLight,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.2)",
    paddingVertical: 16,
    borderRadius: 18,
  },
  logoutText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.error,
  },
  subscriptionCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1.5,
    gap: 10,
  },
  subscriptionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  subscriptionBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
  subscriptionBody: {
    flex: 1,
  },
  subscriptionDays: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.textSecondary,
  },
  subscriptionManageBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  subscriptionManageText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.tint,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 400,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  modalInputLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.textSecondary,
    marginBottom: 6,
    marginTop: 12,
  },
  modalInput: {
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.text,
  },
  modalError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    backgroundColor: colors.errorLight,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  modalErrorText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.error,
    flex: 1,
  },
  modalButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.tint,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 20,
  },
  modalButtonText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.textInverse,
  },
});
