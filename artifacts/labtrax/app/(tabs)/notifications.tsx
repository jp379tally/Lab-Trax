import React, { useState, useCallback, useRef, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  Platform,
  Alert,
  Modal,
  Animated as RNAnimated,
  PanResponder,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { useProviderFilteredNotifications } from "@/lib/useFilteredNotifications";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notification, GroupJoinRequest, LabInvitation } from "@/lib/data";
import { ChatButton } from "@/components/ChatButton";
import { AppHeader } from "@/components/ui/AppHeader";

function getNotifIcon(type: Notification["type"] | string | undefined, colors: ThemeColors) {
  switch (type) {
    case "rush":
      return { name: "flash" as const, color: colors.error, bg: colors.errorLight };
    case "update":
      return { name: "swap-horizontal" as const, color: colors.tint, bg: colors.tintLight };
    case "complete":
      return { name: "checkmark-circle" as const, color: colors.success, bg: colors.successLight };
    case "alert":
      return { name: "alert-circle" as const, color: colors.warning, bg: colors.warningLight };
    default:
      // Defensive fallback so an unknown / new notification type from the
      // server cannot crash the entire screen with a "Something went wrong"
      // ErrorBoundary fault.
      return {
        name: "notifications" as const,
        color: colors.tint,
        bg: colors.tintLight,
      };
  }
}

function formatTime(ts: number) {
  if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SwipeableNotifRow({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  const { colors } = useTheme();
  const translateX = useRef(new RNAnimated.Value(0)).current;
  const deleteThreshold = -80;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dx < 0) {
          translateX.setValue(Math.max(gestureState.dx, -120));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx < deleteThreshold) {
          RNAnimated.timing(translateX, { toValue: -120, duration: 150, useNativeDriver: true }).start();
        } else {
          RNAnimated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
        }
      },
    })
  ).current;

  const resetSwipe = () => {
    RNAnimated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
  };

  const handleDelete = () => {
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
    RNAnimated.timing(translateX, { toValue: -500, duration: 200, useNativeDriver: true }).start(() => onDelete());
  };

  return (
    <View style={{ overflow: "hidden" }}>
      <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 120, flexDirection: "row", justifyContent: "flex-end" }}>
        <Pressable
          onPress={handleDelete}
          style={{ width: 120, backgroundColor: colors.error, justifyContent: "center", alignItems: "center" }}
        >
          <Ionicons name="trash" size={22} color={colors.textInverse} />
          <Text style={{ color: colors.textInverse, fontSize: 12, fontWeight: "500" as const, marginTop: 4 }}>Delete</Text>
        </Pressable>
      </View>
      <RNAnimated.View style={{ transform: [{ translateX }], backgroundColor: colors.surface }} {...panResponder.panHandlers}>
        {children}
      </RNAnimated.View>
    </View>
  );
}

export default function NotificationsScreen() {
  const { markNotificationRead, markAllNotificationsRead, removeNotification, groupJoinRequests, respondToGroupJoinRequest, labInvitations, respondToLabInvite, hardRefresh } = useApp();
  const { currentUser, registeredUsers } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmJoinRequest, setConfirmJoinRequest] = useState<{ request: GroupJoinRequest; accept: boolean; role?: "admin" | "user" } | null>(null);
  const [confirmLabInvite, setConfirmLabInvite] = useState<{ invite: LabInvitation; accept: boolean } | null>(null);
  const filteredNotifications = useProviderFilteredNotifications();

  useFocusEffect(
    useCallback(() => {
      markAllNotificationsRead();
    }, [])
  );

  // Defensive: optional-chain every field access. Missing/malformed entries
  // must never crash this screen.
  const lowerUser = (currentUser || "").toLowerCase();
  const safeJoinRequests = Array.isArray(groupJoinRequests) ? groupJoinRequests : [];
  const safeLabInvites = Array.isArray(labInvitations) ? labInvitations : [];
  const pendingJoinRequests = safeJoinRequests.filter(
    r =>
      typeof r?.targetAdminUsername === "string" &&
      r.targetAdminUsername.toLowerCase() === lowerUser &&
      r?.status === "pending"
  );

  const pendingLabInvites = safeLabInvites.filter(
    i =>
      typeof i?.targetUsername === "string" &&
      i.targetUsername.toLowerCase() === lowerUser &&
      i?.status === "pending"
  );

  const currentUserProfile = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());

  function renderJoinRequestCard(request: GroupJoinRequest) {
    const reqUserData = registeredUsers.find(u => u.username.toLowerCase() === request.requestingUsername.toLowerCase());
    const currentUserData = registeredUsers.find(u => u.username.toLowerCase() === (currentUser || "").toLowerCase());
    const isProvider = reqUserData?.userType === "provider";
    const isSameType = reqUserData?.userType === currentUserData?.userType;
    const isInternalJoin = isSameType && !isProvider;

    return (
      <View key={request.id} style={styles.inviteCard}>
        <View style={[styles.notifIcon, { backgroundColor: isProvider ? colors.infoLight : isInternalJoin ? colors.warningLight : colors.warningLight }]}>
          <Ionicons name={isProvider ? "medical" : "person-add"} size={20} color={isProvider ? colors.info : colors.warningStrong} />
        </View>
        <View style={styles.notifContent}>
          <Text style={styles.notifTitle}>{isProvider ? "Provider Join Request" : isInternalJoin ? "User Join Request" : "Lab Join Request"}</Text>
          <Text style={styles.notifMessage}>
            <Text style={{ fontFamily: "Inter_600SemiBold" }}>{request.requestingUsername}</Text>
            {isProvider ? " (Provider) wants to join your lab" : isInternalJoin ? " wants to join your lab" : " wants to join your lab"}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textSecondary, marginTop: 4, marginBottom: 8 }}>
            {isInternalJoin ? "What role should this user have?" : isProvider ? "Accept this provider into your lab?" : "Accept this user into your lab?"}
          </Text>
          <View style={styles.inviteBtns}>
            {isInternalJoin ? (
              <>
                <Pressable
                  style={({ pressed }) => [styles.acceptBtn, pressed && { opacity: 0.8 }]}
                  onPress={() => setConfirmJoinRequest({ request, accept: true, role: "user" })}
                >
                  <Ionicons name="checkmark" size={16} color={colors.textInverse} />
                  <Text style={styles.acceptText}>As User</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.acceptBtn, { backgroundColor: colors.warning }, pressed && { opacity: 0.8 }]}
                  onPress={() => setConfirmJoinRequest({ request, accept: true, role: "admin" })}
                >
                  <Ionicons name="shield-checkmark" size={16} color={colors.textInverse} />
                  <Text style={styles.acceptText}>As Admin</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.8 }]}
                  onPress={() => setConfirmJoinRequest({ request, accept: false })}
                >
                  <Ionicons name="close" size={16} color={colors.error} />
                  <Text style={styles.declineText}>Reject</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  style={({ pressed }) => [styles.acceptBtn, pressed && { opacity: 0.8 }]}
                  onPress={() => setConfirmJoinRequest({ request, accept: true, role: "user" })}
                >
                  <Ionicons name="checkmark" size={16} color={colors.textInverse} />
                  <Text style={styles.acceptText}>Accept</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.8 }]}
                  onPress={() => setConfirmJoinRequest({ request, accept: false })}
                >
                  <Ionicons name="close" size={16} color={colors.error} />
                  <Text style={styles.declineText}>Reject</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    );
  }

  function renderNotification({ item }: { item: Notification }) {
    const icon = getNotifIcon(item.type, colors);
    return (
      <SwipeableNotifRow onDelete={() => removeNotification(item.id)}>
        <Pressable
          style={({ pressed }) => [
            styles.notifCard,
            !item.read && styles.notifCardUnread,
            pressed && { opacity: 0.7 },
          ]}
          onPress={() => {
            markNotificationRead(item.id);
            if (item.caseId) {
              router.push({
                pathname: "/case/[id]",
                params: { id: item.caseId },
              });
            }
          }}
        >
          <View style={[styles.notifIcon, { backgroundColor: icon.bg }]}>
            <Ionicons name={icon.name} size={20} color={icon.color} />
          </View>
          <View style={styles.notifContent}>
            <View style={styles.notifHeader}>
              <Text style={styles.notifTitle}>{item.title}</Text>
              <Text style={styles.notifTime}>{formatTime(item.timestamp)}</Text>
            </View>
            <Text style={styles.notifMessage} numberOfLines={2}>
              {item.message}
            </Text>
          </View>
          {!item.read && <View style={styles.unreadDot} />}
        </Pressable>
      </SwipeableNotifRow>
    );
  }

  return (
    <View style={styles.container}>
      <AppHeader title="Notifications" />
      <FlatList
        data={filteredNotifications}
        keyExtractor={(item) => item.id}
        renderItem={renderNotification}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 },
        ]}
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
        ListHeaderComponent={
          (pendingJoinRequests.length > 0 || pendingLabInvites.length > 0) ? (
            <View style={styles.inviteSection}>
              {pendingLabInvites.length > 0 && (
                <>
                  <Text style={styles.sectionLabel}>Lab Invitations</Text>
                  {pendingLabInvites.map(invite => {
                    const isAffiliated = !!currentUserProfile?.practiceName;
                    return (
                      <View key={invite.id} style={styles.inviteCard}>
                        <View style={[styles.notifIcon, { backgroundColor: colors.violetLight }]}>
                          <Ionicons name="mail-open" size={20} color={colors.violet} />
                        </View>
                        <View style={styles.notifContent}>
                          <Text style={styles.notifTitle}>Lab Invitation</Text>
                          <Text style={styles.notifMessage}>
                            <Text style={{ fontFamily: "Inter_600SemiBold" }}>{invite.adminUsername}</Text>
                            {" has invited you to join "}
                            <Text style={{ fontFamily: "Inter_600SemiBold" }}>{invite.adminLabName}</Text>
                            {` as ${invite.role === "admin" ? "an admin" : "a user"}.`}
                          </Text>
                          {isAffiliated && (
                            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.error, marginTop: 4 }}>
                              You are currently affiliated with {currentUserProfile?.practiceName}. You must leave your current lab before accepting.
                            </Text>
                          )}
                          <View style={[styles.inviteBtns, { marginTop: 8 }]}>
                            <Pressable
                              style={({ pressed }) => [styles.acceptBtn, { backgroundColor: colors.violet }, isAffiliated && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}
                              onPress={() => {
                                if (isAffiliated) {
                                  Alert.alert("Already Affiliated", `You are currently a member of ${currentUserProfile?.practiceName}. Please leave your current lab in Settings before accepting a new invitation.`);
                                  return;
                                }
                                setConfirmLabInvite({ invite, accept: true });
                              }}
                            >
                              <Ionicons name="checkmark" size={16} color={colors.textInverse} />
                              <Text style={styles.acceptText}>Accept</Text>
                            </Pressable>
                            <Pressable
                              style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.8 }]}
                              onPress={() => setConfirmLabInvite({ invite, accept: false })}
                            >
                              <Ionicons name="close" size={16} color={colors.error} />
                              <Text style={styles.declineText}>Decline</Text>
                            </Pressable>
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </>
              )}
              {pendingJoinRequests.length > 0 && (
                <>
                  <Text style={[styles.sectionLabel, pendingLabInvites.length > 0 && { marginTop: 16 }]}>Pending Requests</Text>
                  {pendingJoinRequests.map(req => renderJoinRequestCard(req))}
                </>
              )}
            </View>
          ) : null
        }
        ListEmptyComponent={
          (pendingJoinRequests.length === 0 && pendingLabInvites.length === 0) ? (
            <EmptyState
              icon="notifications-off-outline"
              title="No notifications yet"
              description="Join requests and lab invites will show up here."
            />
          ) : null
        }
      />

      <Modal visible={!!confirmJoinRequest} transparent animationType="fade" onRequestClose={() => setConfirmJoinRequest(null)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <View style={[styles.confirmIconWrap, { backgroundColor: confirmJoinRequest?.accept ? colors.successLight : colors.errorLight }]}>
              <Ionicons
                name={confirmJoinRequest?.accept ? "person-add" : "close-circle"}
                size={32}
                color={confirmJoinRequest?.accept ? colors.successStrong : colors.error}
              />
            </View>
            <Text style={styles.confirmTitle}>
              {confirmJoinRequest?.accept
                ? (() => {
                    const reqUser = registeredUsers.find(u => u.username.toLowerCase() === confirmJoinRequest?.request.requestingUsername.toLowerCase());
                    if (reqUser?.userType === "provider") return "Accept Provider?";
                    return `Accept as ${confirmJoinRequest?.role === "admin" ? "Admin" : "User"}?`;
                  })()
                : "Decline Request?"}
            </Text>
            <Text style={styles.confirmDesc}>
              {confirmJoinRequest?.accept
                ? (() => {
                    const reqUser = registeredUsers.find(u => u.username.toLowerCase() === confirmJoinRequest?.request.requestingUsername.toLowerCase());
                    if (reqUser?.userType === "provider") return `${confirmJoinRequest?.request.requestingUsername} will be added to your group as a provider.`;
                    return `${confirmJoinRequest?.request.requestingUsername} will be added to your group as ${confirmJoinRequest?.role === "admin" ? "an administrator" : "a standard user"}.`;
                  })()
                : `${confirmJoinRequest?.request.requestingUsername}'s request will be declined.`}
            </Text>
            <View style={styles.confirmBtns}>
              <Pressable
                style={({ pressed }) => [styles.confirmYesBtn, !confirmJoinRequest?.accept && { backgroundColor: colors.error }, pressed && { opacity: 0.85 }]}
                onPress={async () => {
                  if (!confirmJoinRequest) return;
                  const result = await respondToGroupJoinRequest(confirmJoinRequest.request.id, confirmJoinRequest.accept, confirmJoinRequest.role);
                  if (!result.success) {
                    Alert.alert("Unable to Update", result.error || "Something went wrong.");
                    return;
                  }
                  if (Platform.OS !== "web") {
                    Haptics.notificationAsync(confirmJoinRequest.accept ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
                  }
                  setConfirmJoinRequest(null);
                }}
              >
                <Text style={styles.confirmYesText}>
                  {confirmJoinRequest?.accept ? "Accept" : "Decline"}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.confirmNoBtn, pressed && { opacity: 0.85 }]}
                onPress={() => setConfirmJoinRequest(null)}
              >
                <Text style={styles.confirmNoText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!confirmLabInvite} transparent animationType="fade" onRequestClose={() => setConfirmLabInvite(null)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <View style={[styles.confirmIconWrap, { backgroundColor: confirmLabInvite?.accept ? colors.violetLight : colors.errorLight }]}>
              <Ionicons
                name={confirmLabInvite?.accept ? "mail-open" : "close-circle"}
                size={32}
                color={confirmLabInvite?.accept ? colors.violet : colors.error}
              />
            </View>
            <Text style={styles.confirmTitle}>
              {confirmLabInvite?.accept ? "Join Lab?" : "Decline Invitation?"}
            </Text>
            <Text style={styles.confirmDesc}>
              {confirmLabInvite?.accept
                ? `You will join ${confirmLabInvite?.invite.adminLabName} as ${confirmLabInvite?.invite.role === "admin" ? "an admin" : "a user"} and will be able to see all lab data.`
                : `You will decline the invitation from ${confirmLabInvite?.invite.adminUsername} to join ${confirmLabInvite?.invite.adminLabName}.`}
            </Text>
            <View style={styles.confirmBtns}>
              <Pressable
                style={({ pressed }) => [styles.confirmYesBtn, confirmLabInvite?.accept ? { backgroundColor: colors.violet } : { backgroundColor: colors.error }, pressed && { opacity: 0.85 }]}
                onPress={async () => {
                  if (!confirmLabInvite) return;
                  const result = await respondToLabInvite(confirmLabInvite.invite.id, confirmLabInvite.accept);
                  if (!result.success) {
                    Alert.alert("Unable to Update", result.error || "Something went wrong.");
                    return;
                  }
                  if (Platform.OS !== "web") {
                    Haptics.notificationAsync(confirmLabInvite.accept ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
                  }
                  setConfirmLabInvite(null);
                }}
              >
                <Text style={styles.confirmYesText}>
                  {confirmLabInvite?.accept ? "Join Lab" : "Decline"}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.confirmNoBtn, pressed && { opacity: 0.85 }]}
                onPress={() => setConfirmLabInvite(null)}
              >
                <Text style={styles.confirmNoText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  listContent: {
    padding: 20,
    gap: 10,
  },
  inviteSection: {
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.subText,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  inviteCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.infoSurface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.infoLight,
    gap: 14,
    marginBottom: 10,
  },
  inviteBtns: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },
  acceptBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.successStrong,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  acceptText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.textInverse,
  },
  declineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.errorLight,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  declineText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.error,
  },
  notifCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 14,
  },
  notifCardUnread: {
    borderColor: colors.tint + "40",
    backgroundColor: colors.tintLight + "30",
  },
  notifIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  notifContent: {
    flex: 1,
  },
  notifHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  notifTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  notifTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: colors.textTertiary,
  },
  notifMessage: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
    lineHeight: 19,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.tint,
    marginTop: 4,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.textTertiary,
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  confirmCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
  },
  confirmIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  confirmTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.text,
    textAlign: "center",
    marginBottom: 8,
  },
  confirmDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.subText,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  confirmBtns: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  confirmYesBtn: {
    flex: 1,
    backgroundColor: colors.tint,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmYesText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.textInverse,
  },
  confirmNoBtn: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmNoText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
  },
});
