import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Switch,
  Alert,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useTheme } from "@/lib/theme-context";
import Colors from "@/constants/colors";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { resilientFetch } from "@/lib/query-client";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";

type LabDirectoryEntry = {
  organizationId: string;
  practiceName: string;
  username: string;
  practiceAddress?: string;
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { mode, setMode, colors, isDark } = useTheme();
  const { sendGroupJoinRequest, leaveLab, deleteLab, isLabCreator, sendLabInvite, fetchLabDirectory } = useApp();
  const { currentUser, userType, registeredUsers, deleteAccount, updateUserProfile, changePassword, refreshUsers } = useAuth();
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showEditLab, setShowEditLab] = useState(false);
  const [editLabName, setEditLabName] = useState("");
  const [editLabAddress, setEditLabAddress] = useState("");
  const [editLabPhone, setEditLabPhone] = useState("");
  const [editLabEmail, setEditLabEmail] = useState("");
  const [editLabSaving, setEditLabSaving] = useState(false);
  const [showEditEmail, setShowEditEmail] = useState(false);
  const [editEmailSaving, setEditEmailSaving] = useState(false);
  const [adminUsername, setAdminUsername] = useState("");
  const [showAddLabModal, setShowAddLabModal] = useState(false);
  const [labSearchName, setLabSearchName] = useState("");
  const [matchedLabs, setMatchedLabs] = useState<LabDirectoryEntry[]>([]);
  const [labDirectoryCache, setLabDirectoryCache] = useState<LabDirectoryEntry[]>([]);
  const [labSearchDone, setLabSearchDone] = useState(false);
  const [addLabSending, setAddLabSending] = useState(false);
  const [companyLogoUri, setCompanyLogoUri] = useState<string | null>(null);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [addUserSearch, setAddUserSearch] = useState("");
  const [addUserSelected, setAddUserSelected] = useState<{ username: string; email: string } | null>(null);
  const [addUserRole, setAddUserRole] = useState<"user" | "admin">("user");

  type UserStatus = "active" | "inactive" | "on_lunch" | "out_of_office" | "on_break";
  const [userStatus, setUserStatus] = useState<UserStatus>("active");
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem("@drivesync_company_logo").then((uri) => {
      if (uri) setCompanyLogoUri(uri);
    });
    AsyncStorage.getItem(`@labtrax_status_${currentUser}`).then((s) => {
      if (s) setUserStatus(s as UserStatus);
    });
  }, [currentUser]);

  function handleStatusChange(status: UserStatus) {
    setUserStatus(status);
    AsyncStorage.setItem(`@labtrax_status_${currentUser}`, status);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
    setTimeout(() => {
      setShowChangePassword(false);
      setCurrentPasswordInput("");
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordError(null);
      setPasswordSuccess(false);
    }, 1500);
  }

  const statusConfig: { key: UserStatus; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }[] = [
    { key: "active", label: "Active", icon: "checkmark-circle", color: "#16A34A", bg: "#DCFCE7" },
    { key: "inactive", label: "Inactive", icon: "close-circle", color: "#9CA3AF", bg: "#F3F4F6" },
    { key: "on_lunch", label: "On Lunch", icon: "restaurant", color: "#F59E0B", bg: "#FEF3C7" },
    { key: "out_of_office", label: "Out of Office", icon: "airplane", color: "#6366F1", bg: "#EEF2FF" },
    { key: "on_break", label: "On Break", icon: "cafe", color: "#D97706", bg: "#FEF9C3" },
  ];

  const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
  const isProviderAdmin = userType === "provider" && currentUserData?.role === "admin";
  const isLabAdmin = userType === "lab" && currentUserData?.role === "admin";

  async function loadLabDirectory(force = false): Promise<LabDirectoryEntry[]> {
    if (!force && labDirectoryCache.length > 0) {
      return labDirectoryCache;
    }

    const groups = await fetchLabDirectory();
    const myUsername = (currentUser || "").toLowerCase().trim();
    const uniqueLabs = new Map<string, LabDirectoryEntry>();

    for (const group of groups) {
      if (
        !group.organizationId ||
        !group.practiceName?.trim() ||
        !group.username?.trim()
      ) {
        continue;
      }

      const normalizedUsername = group.username.toLowerCase().trim();
      if (normalizedUsername === myUsername) {
        continue;
      }

      uniqueLabs.set(group.organizationId, {
        organizationId: group.organizationId,
        practiceName: group.practiceName.trim(),
        username: group.username.trim(),
        practiceAddress: group.practiceAddress?.trim() || undefined,
      });
    }

    const nextDirectory = Array.from(uniqueLabs.values());
    setLabDirectoryCache(nextDirectory);
    return nextDirectory;
  }

  function filterLabDirectory(query: string, directory: LabDirectoryEntry[]) {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) {
      setMatchedLabs([]);
      setLabSearchDone(false);
      return;
    }

    const normalizedCurrentLab = (currentUserData?.practiceName || "").toLowerCase().trim();
    const nextMatches = directory.filter((lab) => {
      const normalizedPracticeName = lab.practiceName.toLowerCase();
      const normalizedUsername = lab.username.toLowerCase();
      const normalizedAddress = (lab.practiceAddress || "").toLowerCase();
      const isCurrentLab = normalizedCurrentLab.length > 0 &&
        normalizedPracticeName.trim() === normalizedCurrentLab;

      if (isCurrentLab) {
        return false;
      }

      return (
        normalizedPracticeName.includes(normalizedQuery) ||
        normalizedUsername.includes(normalizedQuery) ||
        normalizedAddress.includes(normalizedQuery)
      );
    });

    setMatchedLabs(nextMatches);
    setLabSearchDone(true);
  }

  function openAddLabModal() {
    setShowAddLabModal(true);
    setLabSearchName("");
    setMatchedLabs([]);
    setLabSearchDone(false);
    void loadLabDirectory(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }

  function openLabEditor() {
    setEditLabName(currentUserData?.practiceName || "");
    setEditLabAddress(currentUserData?.practiceAddress || "");
    setEditLabPhone(currentUserData?.practicePhone || currentUserData?.phone || "");
    setEditLabEmail(currentUserData?.email || "");
    setShowEditLab(true);
  }

  async function fetchCurrentLabMembership() {
    const response = await resilientFetch("/api/auth/me");
    if (!response.ok) {
      throw new Error("Could not load your current lab setup.");
    }

    const payload = await response.json();
    const memberships = Array.isArray(payload?.memberships) ? payload.memberships : [];
    return (
      memberships.find(
        (membership: any) =>
          membership?.status === "active" &&
          membership?.organization?.type === "lab"
      ) || null
    );
  }

  async function handleSaveLab() {
    const labName = editLabName.trim();
    if (!labName) {
      Alert.alert("Lab Name Required", "Please enter a lab name before saving.");
      return;
    }

    setEditLabSaving(true);

    try {
      const existingMembership = await fetchCurrentLabMembership();
      const payload = {
        name: labName,
        displayName: labName,
        billingEmail: editLabEmail.trim() || undefined,
        phone: editLabPhone.trim() || undefined,
        addressLine1: editLabAddress.trim() || undefined,
      };

      const response = await resilientFetch(
        existingMembership?.organizationId
          ? `/api/organizations/${existingMembership.organizationId}`
          : "/api/organizations",
        {
          method: existingMembership?.organizationId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            existingMembership?.organizationId
              ? payload
              : { ...payload, type: "lab" }
          ),
        }
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.message || data?.error || "Could not save your lab.");
      }

      await refreshUsers();
      setLabDirectoryCache([]);
      setShowEditLab(false);

      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      Alert.alert(
        existingMembership?.organizationId ? "Lab Updated" : "Lab Created",
        existingMembership?.organizationId
          ? `${labName} has been updated.`
          : `${labName} is now live and can be found by other users.`
      );
    } catch (error: any) {
      Alert.alert("Unable to Save", error?.message || "Could not save your lab.");
    } finally {
      setEditLabSaving(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSolid || colors.surface }]}>
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
              onPress={async () => {
                const result = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: "images",
                  allowsEditing: true,
                  aspect: [1, 1] as [number, number],
                  quality: 0.8,
                });
                if (!result.canceled && result.assets[0]) {
                  await AsyncStorage.setItem("@drivesync_company_logo", result.assets[0].uri);
                  Alert.alert("Logo Updated", "Your company logo has been saved successfully.");
                }
              }}
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
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>STATUS</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border, padding: 12, gap: 8 }]}>
            {statusConfig.map((s) => (
              <Pressable
                key={s.key}
                onPress={() => handleStatusChange(s.key)}
                style={[
                  {
                    flexDirection: "row", alignItems: "center", gap: 12,
                    paddingVertical: 10, paddingHorizontal: 12,
                    borderRadius: 12, borderWidth: 1,
                    borderColor: userStatus === s.key ? s.color : "transparent",
                    backgroundColor: userStatus === s.key ? s.bg : "transparent",
                  },
                ]}
              >
                <View style={{ width: 32, height: 32, borderRadius: 10, justifyContent: "center", alignItems: "center", backgroundColor: userStatus === s.key ? s.color : colors.surfaceSecondary }}>
                  <Ionicons name={s.icon} size={18} color={userStatus === s.key ? "#FFF" : colors.textSecondary} />
                </View>
                <Text style={{ flex: 1, fontSize: 15, fontFamily: userStatus === s.key ? "Inter_700Bold" : "Inter_500Medium", color: userStatus === s.key ? s.color : colors.text }}>{s.label}</Text>
                {userStatus === s.key && (
                  <Ionicons name="checkmark-circle" size={20} color={s.color} />
                )}
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>ACCOUNT</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => {
                setEditLabEmail(currentUserData?.email || "");
                setShowEditEmail(true);
              }}
            >
              <View style={[styles.menuIcon, { backgroundColor: "#DBEAFE" }]}>
                <Ionicons name="mail" size={18} color="#3B82F6" />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Email</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>{currentUserData?.email || "Not set"}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>

            <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

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
              <View style={[styles.menuIcon, { backgroundColor: colors.tintLight }]}>
                <Ionicons name="lock-closed" size={18} color={colors.tint} />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Change Password</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Update your account password</Text>
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

        {isProviderAdmin && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>ADMIN</Text>
            <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Pressable
                style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push("/(tabs)");
                }}
              >
                <View style={[styles.menuIcon, { backgroundColor: "#FEF3C7" }]}>
                  <Ionicons name="key" size={18} color="#D97706" />
                </View>
                <View style={styles.menuInfo}>
                  <Text style={[styles.menuTitle, { color: colors.text }]}>Admin Vault</Text>
                  <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Manage users, labs, and settings</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Pressable>
            </View>
          </View>
        )}

        {userType === "provider" && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>LAB CONNECTION</Text>
            <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Pressable
                style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                onPress={openAddLabModal}
                testID="add-lab-btn"
              >
                <View style={[styles.menuIcon, { backgroundColor: "#EDE9FE" }]}>
                  <Ionicons name="flask" size={18} color="#7C3AED" />
                </View>
                <View style={styles.menuInfo}>
                  <Text style={[styles.menuTitle, { color: colors.text }]}>Add Lab</Text>
                  <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Connect to a dental lab to view cases</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Pressable>
            </View>
          </View>
        )}

        {userType === "lab" ? (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>MY LAB</Text>
            {currentUserData?.practiceName ? (
              <>
                <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, isLabAdmin && pressed && { opacity: 0.7 }]}
                    onPress={() => {
                      if (!isLabAdmin) return;
                      openLabEditor();
                    }}
                  >
                    {companyLogoUri ? (
                      <Image
                        source={{ uri: companyLogoUri }}
                        style={{ width: 44, height: 44, borderRadius: 10, marginRight: 12 }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[styles.menuIcon, { backgroundColor: "#EDE9FE", width: 44, height: 44, borderRadius: 10, marginRight: 12 }]}>
                        <Ionicons name="flask" size={22} color="#7C3AED" />
                      </View>
                    )}
                    <View style={[styles.menuInfo, { flex: 1 }]}>
                      <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: colors.text }}>{currentUserData.practiceName}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 }}>
                        <Ionicons name="location-outline" size={12} color={colors.textSecondary} />
                        <Text style={[styles.menuSub, { color: colors.textSecondary }]}>{currentUserData?.practiceAddress || "Address not set"}</Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
                        <Ionicons name="call-outline" size={12} color={colors.textSecondary} />
                        <Text style={[styles.menuSub, { color: colors.textSecondary }]}>{currentUserData?.practicePhone || currentUserData?.phone || "Phone not set"}</Text>
                      </View>
                    </View>
                    {isLabAdmin && <Ionicons name="create-outline" size={20} color={colors.textTertiary} />}
                  </Pressable>
                </View>

                <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: 10 }]}>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                    onPress={() => {
                      Alert.alert(
                        "Leave Lab",
                        `Are you sure you want to leave ${currentUserData.practiceName}? You will no longer have access to cases affiliated with this lab.`,
                        [
                          { text: "No", style: "cancel" },
                          {
                            text: "Yes, Leave Lab",
                            style: "destructive",
                            onPress: async () => {
                              const result = await leaveLab();
                              if (result.success) {
                                if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                                Alert.alert("Left Lab", `You have successfully left ${currentUserData.practiceName}.`);
                              } else {
                                Alert.alert("Error", result.error || "Failed to leave lab.");
                              }
                            },
                          },
                        ]
                      );
                    }}
                  >
                    <View style={[styles.menuIcon, { backgroundColor: "#FEE2E2" }]}>
                      <Ionicons name="log-out-outline" size={18} color="#DC2626" />
                    </View>
                    <View style={styles.menuInfo}>
                      <Text style={[styles.menuTitle, { color: "#DC2626" }]}>Leave Lab</Text>
                      <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Remove yourself from this lab</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                  </Pressable>

                  {isLabAdmin && (
                    <>
                      <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />
                      <Pressable
                        style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                        onPress={() => {
                          setShowAddUserModal(true);
                          setAddUserSearch("");
                          setAddUserSelected(null);
                          setAddUserRole("user");
                        }}
                      >
                        <View style={[styles.menuIcon, { backgroundColor: "#DBEAFE" }]}>
                          <Ionicons name="person-add" size={18} color="#2563EB" />
                        </View>
                        <View style={styles.menuInfo}>
                          <Text style={[styles.menuTitle, { color: colors.text }]}>Add User to Lab</Text>
                          <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Invite a user to join your lab</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                      </Pressable>
                    </>
                  )}

                  <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                    onPress={openAddLabModal}
                  >
                    <View style={[styles.menuIcon, { backgroundColor: "#DBEAFE" }]}>
                      <Ionicons name="add-circle" size={18} color="#2563EB" />
                    </View>
                    <View style={styles.menuInfo}>
                      <Text style={[styles.menuTitle, { color: colors.text }]}>Join a Lab</Text>
                      <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Search and request to join another lab</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                  </Pressable>

                  {isLabCreator && (
                    <>
                      <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />
                      <Pressable
                        style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                        onPress={() => {
                          Alert.alert(
                            "Delete Lab",
                            "Are you sure you want to delete the lab? All users will be removed from the lab and the lab will be deleted.",
                            [
                              { text: "No", style: "cancel" },
                              {
                                text: "Yes, Delete Lab",
                                style: "destructive",
                                onPress: async () => {
                                  const result = await deleteLab();
                                  if (result.success) {
                                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                                    Alert.alert("Lab Deleted", "The lab has been deleted and all users have been removed from it.");
                                  } else {
                                    Alert.alert("Error", result.error || "Failed to delete lab.");
                                  }
                                },
                              },
                            ]
                          );
                        }}
                      >
                        <View style={[styles.menuIcon, { backgroundColor: "#FEE2E2" }]}>
                          <Ionicons name="trash" size={18} color="#DC2626" />
                        </View>
                        <View style={styles.menuInfo}>
                          <Text style={[styles.menuTitle, { color: "#DC2626" }]}>Delete Lab</Text>
                          <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Remove all users and delete this lab</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                      </Pressable>
                    </>
                  )}
                </View>
              </>
            ) : (
              <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Pressable
                  style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                  onPress={() => {
                    setEditLabName(currentUserData?.practiceName || "");
                    setEditLabAddress(currentUserData?.practiceAddress || "");
                    setEditLabPhone(currentUserData?.practicePhone || currentUserData?.phone || "");
                    setEditLabEmail(currentUserData?.email || "");
                    setShowEditLab(true);
                  }}
                >
                  <View style={[styles.menuIcon, { backgroundColor: "#DCFCE7" }]}>
                    <Ionicons name="business" size={18} color="#16A34A" />
                  </View>
                  <View style={styles.menuInfo}>
                    <Text style={[styles.menuTitle, { color: colors.text }]}>Create My Lab</Text>
                    <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Set up your lab so other devices can find it</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                </Pressable>

                <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

                <Pressable
                  style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                  onPress={openAddLabModal}
                >
                  <View style={[styles.menuIcon, { backgroundColor: "#DBEAFE" }]}>
                    <Ionicons name="add-circle" size={18} color="#2563EB" />
                  </View>
                  <View style={styles.menuInfo}>
                    <Text style={[styles.menuTitle, { color: colors.text }]}>Join a Lab</Text>
                    <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Search and request to join a lab</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                </Pressable>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>LAB</Text>
            <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Pressable
                style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
                onPress={() => setShowJoinModal(true)}
              >
                <View style={[styles.menuIcon, { backgroundColor: "#DBEAFE" }]}>
                  <Ionicons name="people-circle" size={18} color="#2563EB" />
                </View>
                <View style={styles.menuInfo}>
                  <Text style={[styles.menuTitle, { color: colors.text }]}>Connect with a Lab</Text>
                  <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Send request to join a lab</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>DATA</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => Alert.alert("Export Data", "Your case data export will be prepared and available for download shortly.")}
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

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>LEGAL</Text>
          <View style={[styles.menuGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => router.push("/privacy-policy")}
            >
              <View style={[styles.menuIcon, { backgroundColor: "#EDE9FE" }]}>
                <Ionicons name="document-text" size={18} color="#7C3AED" />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Privacy Policy</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>How we handle your data</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>

            <View style={[styles.menuDivider, { backgroundColor: colors.borderLight }]} />

            <Pressable
              style={({ pressed }) => [styles.menuItem, pressed && { opacity: 0.7 }]}
              onPress={() => router.push("/terms-of-service")}
            >
              <View style={[styles.menuIcon, { backgroundColor: "#DBEAFE" }]}>
                <Ionicons name="reader" size={18} color="#2563EB" />
              </View>
              <View style={styles.menuInfo}>
                <Text style={[styles.menuTitle, { color: colors.text }]}>Terms of Service</Text>
                <Text style={[styles.menuSub, { color: colors.textSecondary }]}>Usage terms and conditions</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          </View>
        </View>

        <View style={{ marginTop: 12, marginBottom: 40 }}>
          <Pressable
            onPress={() => {
              Alert.alert(
                "Delete Account",
                "Are you sure you want to permanently delete your account? This action cannot be undone and all your data will be removed from LabTrax.",
                [
                  { text: "No", style: "cancel" },
                  {
                    text: "Yes, Delete",
                    style: "destructive",
                    onPress: async () => {
                      const result = await deleteAccount();
                      if (result.success) {
                        Alert.alert("Account Deleted", "Your account has been permanently removed.");
                      } else {
                        Alert.alert("Error", result.error || "Failed to delete account. Please try again.");
                      }
                    },
                  },
                ]
              );
            }}
            style={({ pressed }) => [{
              backgroundColor: "rgba(239,68,68,0.08)",
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "rgba(239,68,68,0.2)",
              paddingVertical: 14,
              paddingHorizontal: 20,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="trash-outline" size={18} color="#EF4444" />
            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#EF4444" }}>Delete Account</Text>
          </Pressable>
        </View>
      </ScrollView>

      <Modal
        visible={showChangePassword}
        animationType="slide"
        transparent
        onRequestClose={() => setShowChangePassword(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          <Pressable style={{ flex: 1 }} onPress={() => setShowChangePassword(false)} />
          <View style={[joinStyles.sheet, { backgroundColor: colors.surface, paddingTop: 0 }]}>
            <View style={joinStyles.handle} />
            <View style={joinStyles.header}>
              <Pressable onPress={() => setShowChangePassword(false)}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
              <Text style={[joinStyles.title, { color: colors.text }]}>Change Password</Text>
              <View style={{ width: 24 }} />
            </View>

            {passwordSuccess ? (
              <View style={{ alignItems: "center", paddingVertical: 32 }}>
                <Ionicons name="checkmark-circle" size={48} color="#16A34A" />
                <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.text, marginTop: 12 }}>Password Changed</Text>
              </View>
            ) : (
              <>
                {passwordError && (
                  <View style={{ backgroundColor: colors.errorLight, borderRadius: 12, padding: 12, marginBottom: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Ionicons name="alert-circle" size={16} color={colors.error} />
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.error, flex: 1 }}>{passwordError}</Text>
                  </View>
                )}
                <TextInput
                  style={[joinStyles.input, { backgroundColor: colors.surfaceSecondary, color: colors.text, borderColor: colors.border }]}
                  placeholder="Current password"
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  value={currentPasswordInput}
                  onChangeText={setCurrentPasswordInput}
                  testID="current-password-input"
                />
                <TextInput
                  style={[joinStyles.input, { backgroundColor: colors.surfaceSecondary, color: colors.text, borderColor: colors.border }]}
                  placeholder="New password"
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  value={newPassword}
                  onChangeText={setNewPassword}
                  testID="new-password-input"
                />
                <TextInput
                  style={[joinStyles.input, { backgroundColor: colors.surfaceSecondary, color: colors.text, borderColor: colors.border }]}
                  placeholder="Confirm new password"
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  value={confirmNewPassword}
                  onChangeText={setConfirmNewPassword}
                  testID="confirm-password-input"
                />
                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.textSecondary, marginBottom: 16 }}>
                  Must be 8+ characters with uppercase, lowercase, and special character
                </Text>
                <Pressable
                  onPress={handleChangePassword}
                  style={({ pressed }) => [joinStyles.sendBtn, pressed && { opacity: 0.85 }]}
                  testID="change-password-btn"
                >
                  <Ionicons name="lock-closed" size={18} color="#FFF" />
                  <Text style={joinStyles.sendBtnText}>Update Password</Text>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showJoinModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowJoinModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <View style={[joinStyles.sheet, { backgroundColor: colors.surface }]}>
            <View style={joinStyles.handle} />
            <View style={joinStyles.header}>
              <Pressable onPress={() => { setShowJoinModal(false); setAdminUsername(""); }}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
              <Text style={[joinStyles.title, { color: colors.text }]}>Join a Lab</Text>
              <View style={{ width: 24 }} />
            </View>
            <Text style={[joinStyles.desc, { color: colors.textSecondary }]}>
              Enter the admin's username to send a request to join their lab. The admin will receive a notification to approve your request.
            </Text>
            <TextInput
              style={[joinStyles.input, { backgroundColor: colors.surfaceSecondary, color: colors.text, borderColor: colors.border }]}
              placeholder="Admin's username"
              placeholderTextColor={colors.textTertiary}
              value={adminUsername}
              onChangeText={setAdminUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={({ pressed }) => [
                joinStyles.sendBtn,
                !adminUsername.trim() && { opacity: 0.5 },
                pressed && { opacity: 0.85 },
              ]}
              disabled={!adminUsername.trim()}
              onPress={async () => {
                if (!currentUser) return;
                const result = await sendGroupJoinRequest(adminUsername.trim(), currentUser);
                if (result.success) {
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  Alert.alert("Request Sent", `Your request to join has been sent to ${adminUsername.trim()}. You'll be notified when they respond.`);
                  setShowJoinModal(false);
                  setAdminUsername("");
                } else {
                  Alert.alert("Unable to Send", result.error || "Something went wrong.");
                }
              }}
            >
              <Ionicons name="send" size={18} color="#FFF" />
              <Text style={joinStyles.sendBtnText}>Send Request</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showAddLabModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowAddLabModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <View style={[joinStyles.sheet, { backgroundColor: colors.surface }]}>
            <View style={joinStyles.handle} />
            <View style={joinStyles.header}>
              <Pressable onPress={() => { setShowAddLabModal(false); setLabSearchName(""); setMatchedLabs([]); setLabSearchDone(false); }}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
              <Text style={[joinStyles.title, { color: colors.text }]}>Add Lab</Text>
              <View style={{ width: 24 }} />
            </View>
            <Text style={[joinStyles.desc, { color: colors.textSecondary }]}>
              Enter the lab name to search for it. If found, a join request will be sent to the lab's administrator for approval.
            </Text>
            <TextInput
              style={[joinStyles.input, { backgroundColor: colors.surfaceSecondary, color: colors.text, borderColor: colors.border }]}
              placeholder="Lab name"
              placeholderTextColor={colors.textTertiary}
              value={labSearchName}
              onChangeText={async (t) => {
                setLabSearchName(t);
                if (!t.trim()) {
                  setMatchedLabs([]);
                  setLabSearchDone(false);
                  return;
                }

                const directory = await loadLabDirectory();
                filterLabDirectory(t, directory);
              }}
              autoCapitalize="words"
              autoCorrect={false}
              testID="add-lab-search-input"
            />

            {labSearchDone && matchedLabs.length === 0 ? (
              <View style={{ alignItems: "center", paddingVertical: 16, gap: 8 }}>
                <Ionicons name="alert-circle-outline" size={36} color={colors.textTertiary} />
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text }}>No labs found</Text>
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: colors.textSecondary, textAlign: "center" }}>
                  No lab matching "{labSearchName}" was found. Please check the name and try again.
                </Text>
                <Pressable
                  onPress={() => { setLabSearchDone(false); }}
                  style={({ pressed }) => [{ paddingVertical: 10, paddingHorizontal: 20 }, pressed && { opacity: 0.7 }]}
                >
                  <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.tint }}>Try Again</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ gap: 10, maxHeight: 280 }}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {matchedLabs.map((lab) => {
                    const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
                    const alreadyMember = currentUserData?.practiceName?.toLowerCase().trim() === lab.practiceName.toLowerCase().trim();
                    return (
                      <View key={lab.username} style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, marginBottom: 8, gap: 12 }}>
                        <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: "#EDE9FE", justifyContent: "center", alignItems: "center" }}>
                          <Ionicons name="flask" size={20} color="#7C3AED" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text }}>{lab.practiceName}</Text>
                          {lab.practiceAddress && <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textSecondary, marginTop: 2 }}>{lab.practiceAddress}</Text>}
                        </View>
                        {alreadyMember ? (
                          <View style={{ backgroundColor: "#D1FAE5", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}>
                            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#059669" }}>Connected</Text>
                          </View>
                        ) : (
                          <Pressable
                            style={({ pressed }) => [
                              { backgroundColor: "#7C3AED", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
                              addLabSending && { opacity: 0.5 },
                              pressed && { opacity: 0.85 },
                            ]}
                            disabled={addLabSending}
                            onPress={() => {
                              if (!currentUser) return;
                              Alert.alert(
                                "Join Lab",
                                `Are you sure you want to join ${lab.practiceName}?`,
                                [
                                  { text: "No", style: "cancel" },
                                  {
                                    text: "Yes, Join Lab",
                                    onPress: async () => {
                                      setAddLabSending(true);
                                      const result = await sendGroupJoinRequest(lab.username, currentUser, `${currentUser} would like to join ${lab.practiceName}.`);
                                      setAddLabSending(false);
                                      if (result.success) {
                                        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                                        Alert.alert("Request Sent", `A request to join this lab has been sent to the lab admin. You will be notified if accepted.`);
                                        setShowAddLabModal(false);
                                        setLabSearchName("");
                                        setMatchedLabs([]);
                                        setLabSearchDone(false);
                                      } else {
                                        Alert.alert("Unable to Send", result.error || "Something went wrong.");
                                      }
                                    },
                                  },
                                ]
                              );
                            }}
                            testID={`join-lab-${lab.organizationId}`}
                          >
                            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Join</Text>
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={showEditLab} animationType="slide" onRequestClose={() => setShowEditLab(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
            <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: insets.bottom + 24 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: colors.text }}>{currentUserData?.practiceName ? "Edit My Lab" : "Create My Lab"}</Text>
                <Pressable onPress={() => setShowEditLab(false)}>
                  <Ionicons name="close" size={24} color={colors.textSecondary} />
                </Pressable>
              </View>

              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Lab Name</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                value={editLabName}
                onChangeText={setEditLabName}
                placeholder="Enter lab name"
                placeholderTextColor={colors.textTertiary}
              />

              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Address</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                value={editLabAddress}
                onChangeText={setEditLabAddress}
                placeholder="Enter address"
                placeholderTextColor={colors.textTertiary}
              />

              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Phone</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                value={editLabPhone}
                onChangeText={setEditLabPhone}
                placeholder="Enter phone number"
                placeholderTextColor={colors.textTertiary}
                keyboardType="phone-pad"
              />

              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Email</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                value={editLabEmail}
                onChangeText={setEditLabEmail}
                placeholder="Enter email address"
                placeholderTextColor={colors.textTertiary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Pressable
                style={({ pressed }) => [styles.sendBtn, editLabSaving && { opacity: 0.6 }, pressed && { opacity: 0.8 }]}
                disabled={editLabSaving}
                onPress={handleSaveLab}
              >
                <Text style={styles.sendBtnText}>{editLabSaving ? "Saving..." : currentUserData?.practiceName ? "Save Changes" : "Create Lab"}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={showEditEmail} animationType="slide" onRequestClose={() => setShowEditEmail(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
            <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: insets.bottom + 24 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: colors.text }}>Edit Email</Text>
                <Pressable onPress={() => setShowEditEmail(false)}>
                  <Ionicons name="close" size={24} color={colors.textSecondary} />
                </Pressable>
              </View>

              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: colors.textSecondary, marginBottom: 6 }}>Email Address</Text>
              <TextInput
                style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                value={editLabEmail}
                onChangeText={setEditLabEmail}
                placeholder="Enter email address"
                placeholderTextColor={colors.textTertiary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Pressable
                style={({ pressed }) => [styles.sendBtn, editEmailSaving && { opacity: 0.6 }, pressed && { opacity: 0.8 }]}
                disabled={editEmailSaving}
                onPress={async () => {
                  setEditEmailSaving(true);
                  const result = await updateUserProfile({ email: editLabEmail });
                  setEditEmailSaving(false);
                  if (result.success) {
                    if (Platform.OS !== "web") {
                      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    }
                    setShowEditEmail(false);
                  } else {
                    Alert.alert("Error", result.error || "Failed to save email");
                  }
                }}
              >
                <Text style={styles.sendBtnText}>{editEmailSaving ? "Saving..." : "Save Email"}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showAddUserModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowAddUserModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <View style={[joinStyles.sheet, { backgroundColor: colors.surface }]}>
            <View style={joinStyles.handle} />
            <View style={joinStyles.header}>
              <Pressable onPress={() => { setShowAddUserModal(false); setAddUserSearch(""); setAddUserSelected(null); }}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
              <Text style={[joinStyles.title, { color: colors.text }]}>Add User to Lab</Text>
              <View style={{ width: 24 }} />
            </View>

            {!addUserSelected ? (
              <>
                <Text style={[joinStyles.desc, { color: colors.textSecondary }]}>
                  Search for a user by username to invite them to your lab.
                </Text>
                <TextInput
                  style={[joinStyles.input, { backgroundColor: colors.surfaceSecondary, color: colors.text, borderColor: colors.border }]}
                  placeholder="Type username to search..."
                  placeholderTextColor={colors.textTertiary}
                  value={addUserSearch}
                  onChangeText={setAddUserSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {addUserSearch.trim().length > 0 && (
                  <View style={{ maxHeight: 240, marginTop: 4 }}>
                    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                      {registeredUsers
                        .filter(u => {
                          const q = addUserSearch.toLowerCase().trim();
                          const isSelf = u.username.toLowerCase() === (currentUser || "").toLowerCase();
                          const uLab = (u.practiceName ?? "").toLowerCase().trim();
                          const myLab = (currentUserData?.practiceName ?? "").toLowerCase().trim();
                          const alreadyInLab = myLab.length > 0 && uLab === myLab;
                          return !isSelf && !alreadyInLab && u.username.toLowerCase().includes(q);
                        })
                        .slice(0, 10)
                        .map(u => (
                          <Pressable
                            key={u.username}
                            style={({ pressed }) => [{
                              flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 14,
                              borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
                              marginBottom: 8, gap: 12,
                            }, pressed && { opacity: 0.7 }]}
                            onPress={() => {
                              setAddUserSelected({ username: u.username, email: u.email || "" });
                              setAddUserRole("user");
                            }}
                          >
                            <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: "#DBEAFE", justifyContent: "center", alignItems: "center" }}>
                              <Ionicons name="person" size={20} color="#2563EB" />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text }}>{u.username}</Text>
                              {u.email && <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textSecondary, marginTop: 2 }}>{u.email}</Text>}
                              {u.practiceName && <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.textTertiary, marginTop: 2 }}>Lab: {u.practiceName}</Text>}
                            </View>
                            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                          </Pressable>
                        ))}
                      {registeredUsers.filter(u => {
                        const q = addUserSearch.toLowerCase().trim();
                        const isSelf = u.username.toLowerCase() === (currentUser || "").toLowerCase();
                        const uLab = (u.practiceName ?? "").toLowerCase().trim();
                        const myLab = (currentUserData?.practiceName ?? "").toLowerCase().trim();
                        const alreadyInLab = myLab.length > 0 && uLab === myLab;
                        return !isSelf && !alreadyInLab && u.username.toLowerCase().includes(q);
                      }).length === 0 && (
                        <View style={{ alignItems: "center", paddingVertical: 16, gap: 8 }}>
                          <Ionicons name="alert-circle-outline" size={36} color={colors.textTertiary} />
                          <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text }}>No users found</Text>
                          <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: colors.textSecondary, textAlign: "center" }}>
                            No user matching "{addUserSearch}" was found.
                          </Text>
                        </View>
                      )}
                    </ScrollView>
                  </View>
                )}
              </>
            ) : (
              <View style={{ gap: 16 }}>
                <View style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, gap: 12 }}>
                  <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: "#DBEAFE", justifyContent: "center", alignItems: "center" }}>
                    <Ionicons name="person" size={20} color="#2563EB" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.text }}>{addUserSelected.username}</Text>
                    {addUserSelected.email ? <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textSecondary, marginTop: 2 }}>{addUserSelected.email}</Text> : null}
                  </View>
                  <Pressable onPress={() => { setAddUserSelected(null); setAddUserSearch(""); }}>
                    <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
                  </Pressable>
                </View>

                <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.text }}>Assign Role</Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Pressable
                    style={({ pressed }) => [{
                      flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 2, alignItems: "center", gap: 4,
                      borderColor: addUserRole === "user" ? "#2563EB" : colors.border,
                      backgroundColor: addUserRole === "user" ? "#EFF6FF" : colors.surfaceSecondary,
                    }, pressed && { opacity: 0.7 }]}
                    onPress={() => setAddUserRole("user")}
                  >
                    <Ionicons name="person-outline" size={22} color={addUserRole === "user" ? "#2563EB" : colors.textSecondary} />
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: addUserRole === "user" ? "#2563EB" : colors.text }}>User</Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.textSecondary, textAlign: "center" }}>Standard access</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [{
                      flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 2, alignItems: "center", gap: 4,
                      borderColor: addUserRole === "admin" ? "#F59E0B" : colors.border,
                      backgroundColor: addUserRole === "admin" ? "#FFFBEB" : colors.surfaceSecondary,
                    }, pressed && { opacity: 0.7 }]}
                    onPress={() => setAddUserRole("admin")}
                  >
                    <Ionicons name="shield-outline" size={22} color={addUserRole === "admin" ? "#F59E0B" : colors.textSecondary} />
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: addUserRole === "admin" ? "#F59E0B" : colors.text }}>Admin</Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.textSecondary, textAlign: "center" }}>Full access</Text>
                  </Pressable>
                </View>

                <Pressable
                  style={({ pressed }) => [joinStyles.sendBtn, pressed && { opacity: 0.85 }]}
                  onPress={() => {
                    Alert.alert(
                      "Confirm Invitation",
                      `Are you sure you want to add ${addUserSelected.username} to your lab as ${addUserRole === "admin" ? "an Admin" : "a User"}?`,
                      [
                        { text: "No", style: "cancel" },
                        {
                          text: "Yes, Send Invite",
                          onPress: async () => {
                            const result = await sendLabInvite(addUserSelected!.username, addUserSelected!.email, addUserRole);
                            if (result.success) {
                              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                              Alert.alert("Invitation Sent", `An invitation has been sent to ${addUserSelected!.username}. They will need to accept it in their notifications.`);
                              setShowAddUserModal(false);
                              setAddUserSearch("");
                              setAddUserSelected(null);
                            } else {
                              Alert.alert("Unable to Send", result.error || "Something went wrong.");
                            }
                          },
                        },
                      ]
                    );
                  }}
                >
                  <Ionicons name="send" size={18} color="#FFF" />
                  <Text style={joinStyles.sendBtnText}>Send Invitation</Text>
                </Pressable>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  input: {
    backgroundColor: Colors.light.surfaceSecondary,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    color: Colors.light.text,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    marginBottom: 10,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 6,
  },
  sendBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: "#FFF",
  },
});

const joinStyles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#CBD5E1",
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
  },
  desc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginBottom: 20,
  },
  input: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    marginBottom: 16,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#2563EB",
    borderRadius: 14,
    height: 50,
  },
  sendBtnText: {
    color: "#FFF",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
});
