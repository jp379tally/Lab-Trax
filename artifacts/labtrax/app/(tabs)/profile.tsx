import React, { useState, useEffect } from "react";
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
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { ChatButton } from "@/components/ChatButton";
import { useEntitlement, type SubscriptionStatus } from "@/lib/useEntitlement";

type WorkStatus = "available" | "break" | "out_of_office";

function entitlementConfig(status: SubscriptionStatus): {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bg: string;
  borderColor: string;
} {
  switch (status) {
    case "trialing":
      return { label: "Trial", icon: "time-outline", color: "#7C3AED", bg: "#EDE9FE", borderColor: "#C4B5FD" };
    case "active":
      return { label: "Active", icon: "checkmark-circle", color: Colors.light.success, bg: Colors.light.successLight, borderColor: "#6EE7B7" };
    case "past_due":
      return { label: "Payment Issue", icon: "warning", color: Colors.light.warning, bg: Colors.light.warningLight, borderColor: "#FCD34D" };
    case "grace":
      return { label: "Grace Period", icon: "alert-circle", color: "#EA580C", bg: "#FFF7ED", borderColor: "#FDBA74" };
    case "locked":
      return { label: "Locked", icon: "lock-closed", color: Colors.light.error, bg: Colors.light.errorLight, borderColor: "#FCA5A5" };
    case "canceled":
      return { label: "Canceled", icon: "close-circle", color: Colors.light.error, bg: Colors.light.errorLight, borderColor: "#FCA5A5" };
    case "legacy_free":
      return { label: "Legacy Free", icon: "star", color: Colors.light.tint, bg: Colors.light.tintLight, borderColor: "#93C5FD" };
    default:
      return { label: status, icon: "ellipse-outline", color: Colors.light.textSecondary, bg: Colors.light.surfaceSecondary, borderColor: Colors.light.border };
  }
}

export default function ProfileScreen() {
  const router = useRouter();
  const { role, setRole, adminUnlocked, setAdminUnlocked, updateWorkStatus, hardRefresh } = useApp();
  const { logout, currentUser, profilePicUri, changePassword, registeredUsers, isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
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
          organization?: { userType?: string } | null;
        }> = j?.memberships || j?.user?.memberships || [];
        const ok = memberships.some((m) => {
          if (m.status !== "active") return false;
          if (!["owner", "admin", "billing"].includes(m.role)) return false;
          const orgType = m.organization?.userType;
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
    { key: "available", label: "Available", icon: "checkmark-circle", color: Colors.light.success, bg: Colors.light.successLight },
    { key: "break", label: "Taking a Break", icon: "cafe", color: Colors.light.warning, bg: Colors.light.warningLight },
    { key: "out_of_office", label: "Out of Office", icon: "airplane", color: Colors.light.textSecondary, bg: Colors.light.surfaceSecondary },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: Platform.OS === "web" ? 67 + 16 : insets.top + 16,
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
      <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 20, marginBottom: 4 }}>
        <ChatButton />
      </View>
      <View style={styles.profileCard}>
        <View style={styles.avatarContainer}>
          {profilePicUri ? (
            <Image source={{ uri: profilePicUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatar}>
              <Ionicons name="person" size={36} color={Colors.light.tint} />
            </View>
          )}
          <View style={[styles.statusDot, { backgroundColor: workStatus === "available" ? Colors.light.success : workStatus === "break" ? Colors.light.warning : Colors.light.textSecondary }]} />
        </View>
        <Text style={styles.profileName}>
          {currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : role === "user" ? "User" : "Administrator"}
        </Text>
        <Text style={styles.profileRole}>{role === "user" ? "User" : "Administrator"}</Text>
      </View>

      {entitlement && (() => {
        const cfg = entitlementConfig(entitlement.status);
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
        <Text style={styles.sectionTitle}>CREDENTIALS</Text>
        <View style={styles.menuGroup}>
          <View style={styles.menuItem}>
            <View style={[styles.menuIcon, { backgroundColor: Colors.light.tintLight }]}>
              <Ionicons name="person-circle" size={18} color={Colors.light.tint} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Username</Text>
              <Text style={styles.menuSub}>{currentUser || "Not set"}</Text>
            </View>
          </View>
          <View style={styles.menuDivider} />
          <View style={styles.menuItem}>
            <View style={[styles.menuIcon, { backgroundColor: Colors.light.successLight }]}>
              <Ionicons name="shield-checkmark" size={18} color={Colors.light.success} />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Role</Text>
              <Text style={styles.menuSub}>{role === "user" ? "User" : "Administrator"}</Text>
            </View>
          </View>
          <View style={styles.menuDivider} />
          <View style={styles.menuItem}>
            <View style={[styles.menuIcon, { backgroundColor: Colors.light.warningLight }]}>
              <Ionicons name="finger-print" size={18} color={Colors.light.warning} />
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
                  <View style={[styles.menuIcon, { backgroundColor: "#DCFCE7" }]}>
                    <Ionicons name="cash" size={18} color="#16A34A" />
                  </View>
                  <View style={styles.menuInfo}>
                    <Text style={styles.menuTitle}>Receive Payments</Text>
                    <Text style={styles.menuSub}>
                      Apply payments across open invoices
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
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
            <View style={[styles.menuIcon, { backgroundColor: "#F0FDF4" }]}>
              <Ionicons name="people-outline" size={18} color="#16A34A" />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Customers</Text>
              <Text style={styles.menuSub}>
                View practices and open balances
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/payees" as any)}
            testID="payees-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: "#E0F2FE" }]}>
              <Ionicons name="receipt-outline" size={18} color="#0284C7" />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Payees</Text>
              <Text style={styles.menuSub}>Browse vendors, employees, and items</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/link-labs" as any)}
            testID="link-labs-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: "#E0F2FE" }]}>
              <Ionicons name="link" size={18} color="#0284C7" />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Link Labs</Text>
              <Text style={styles.menuSub}>
                Combine cases & invoices across multiple labs
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/subscription" as any)}
            testID="subscription-button"
          >
            <View style={[styles.menuIcon, { backgroundColor: "#EDE9FE" }]}>
              <Ionicons name="flash" size={18} color="#7C3AED" />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Subscription</Text>
              <Text style={styles.menuSub}>Manage your plan and billing</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
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
            <View style={[styles.menuIcon, { backgroundColor: "#FEF3C7" }]}>
              <Ionicons name="key" size={18} color="#D97706" />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Change Password</Text>
              <Text style={styles.menuSub}>Update your account password</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
            onPress={() => router.push("/two-factor" as any)}
          >
            <View style={[styles.menuIcon, { backgroundColor: "#EDE9FE" }]}>
              <Ionicons name="shield-checkmark" size={18} color="#7C3AED" />
            </View>
            <View style={styles.menuInfo}>
              <Text style={styles.menuTitle}>Two-Factor Authentication</Text>
              <Text style={styles.menuSub}>Add an extra layer of security</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textSecondary} />
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
                  <View style={[styles.menuIcon, { backgroundColor: "#E0E7FF" }]}>
                    <Ionicons name="business" size={18} color="#4F46E5" />
                  </View>
                  <View style={[styles.menuInfo, { flex: 1 }]}>
                    <Text style={styles.menuTitle}>Lab</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#10B981" }} />
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
          <Ionicons name="log-out-outline" size={20} color={Colors.light.error} />
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
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>

            {passwordSuccess ? (
              <View style={{ alignItems: "center", paddingVertical: 32 }}>
                <Ionicons name="checkmark-circle" size={56} color={Colors.light.success} />
                <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold" as const, color: Colors.light.success, marginTop: 12 }}>
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
                  placeholderTextColor={Colors.light.textTertiary}
                  autoCapitalize="none"
                />

                <Text style={styles.modalInputLabel}>New Password</Text>
                <TextInput
                  style={styles.modalInput}
                  secureTextEntry
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder="Enter new password"
                  placeholderTextColor={Colors.light.textTertiary}
                  autoCapitalize="none"
                />

                <Text style={styles.modalInputLabel}>Confirm New Password</Text>
                <TextInput
                  style={styles.modalInput}
                  secureTextEntry
                  value={confirmNewPassword}
                  onChangeText={setConfirmNewPassword}
                  placeholder="Confirm new password"
                  placeholderTextColor={Colors.light.textTertiary}
                  autoCapitalize="none"
                />

                {passwordError && (
                  <View style={styles.modalError}>
                    <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
                    <Text style={styles.modalErrorText}>{passwordError}</Text>
                  </View>
                )}

                <Pressable
                  style={({ pressed }) => [styles.modalButton, pressed && { opacity: 0.8 }]}
                  onPress={handleChangePassword}
                >
                  <Ionicons name="lock-closed" size={18} color="#FFF" />
                  <Text style={styles.modalButtonText}>Update Password</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
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
  subscriptionCard: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: Colors.light.surface,
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
    color: Colors.light.textSecondary,
  },
  subscriptionManageBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  subscriptionManageText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: Colors.light.surface,
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
    color: Colors.light.text,
  },
  modalInputLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    marginBottom: 6,
    marginTop: 12,
  },
  modalInput: {
    backgroundColor: Colors.light.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  modalError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    backgroundColor: Colors.light.errorLight,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  modalErrorText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.error,
    flex: 1,
  },
  modalButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 20,
  },
  modalButtonText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
});
