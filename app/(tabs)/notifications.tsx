import React, { useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  Platform,
  Alert,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { useProviderFilteredNotifications } from "@/lib/useFilteredNotifications";
import Colors from "@/constants/colors";
import { Notification, GroupInvitation, GroupJoinRequest } from "@/lib/data";
import { ChatButton } from "@/components/ChatButton";

function getNotifIcon(type: Notification["type"]) {
  switch (type) {
    case "rush":
      return { name: "flash" as const, color: Colors.light.error, bg: Colors.light.errorLight };
    case "update":
      return { name: "swap-horizontal" as const, color: Colors.light.tint, bg: Colors.light.tintLight };
    case "complete":
      return { name: "checkmark-circle" as const, color: Colors.light.success, bg: Colors.light.successLight };
    case "alert":
      return { name: "alert-circle" as const, color: Colors.light.warning, bg: Colors.light.warningLight };
  }
}

function formatTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationsScreen() {
  const { markNotificationRead, groupInvitations, respondToGroupInvitation, groupJoinRequests, respondToGroupJoinRequest } = useApp();
  const { currentUser, registeredUsers } = useAuth();
  const insets = useSafeAreaInsets();
  const [confirmInvite, setConfirmInvite] = useState<{ invitation: GroupInvitation; accept: boolean } | null>(null);
  const [confirmJoinRequest, setConfirmJoinRequest] = useState<{ request: GroupJoinRequest; accept: boolean; role?: "admin" | "user" } | null>(null);
  const filteredNotifications = useProviderFilteredNotifications();

  const pendingInvitations = groupInvitations.filter(
    inv => inv.invitedUsername.toLowerCase() === (currentUser || "").toLowerCase() && inv.status === "pending"
  );

  const pendingJoinRequests = groupJoinRequests.filter(
    r => r.targetAdminUsername.toLowerCase() === (currentUser || "").toLowerCase() && r.status === "pending"
  );

  function handleInvitationResponse(invitation: GroupInvitation, accept: boolean) {
    setConfirmInvite({ invitation, accept });
  }

  function confirmInvitationResponse() {
    if (!confirmInvite) return;
    const { invitation, accept } = confirmInvite;
    respondToGroupInvitation(invitation.id, accept);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(accept ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    }
    setConfirmInvite(null);
  }

  function renderInvitationCard(invitation: GroupInvitation) {
    return (
      <View key={invitation.id} style={styles.inviteCard}>
        <View style={[styles.notifIcon, { backgroundColor: "#DBEAFE" }]}>
          <Ionicons name="people" size={20} color="#2563EB" />
        </View>
        <View style={styles.notifContent}>
          <Text style={styles.notifTitle}>Group Invitation</Text>
          <Text style={styles.notifMessage}>
            {invitation.invitedBy} invited you to join "{invitation.groupName}"
          </Text>
          <View style={styles.inviteBtns}>
            <Pressable
              style={({ pressed }) => [styles.acceptBtn, pressed && { opacity: 0.8 }]}
              onPress={() => handleInvitationResponse(invitation, true)}
            >
              <Ionicons name="checkmark" size={16} color="#FFF" />
              <Text style={styles.acceptText}>Accept</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.8 }]}
              onPress={() => handleInvitationResponse(invitation, false)}
            >
              <Ionicons name="close" size={16} color={Colors.light.error} />
              <Text style={styles.declineText}>Decline</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  function renderJoinRequestCard(request: GroupJoinRequest) {
    const reqUserData = registeredUsers.find(u => u.username.toLowerCase() === request.requestingUsername.toLowerCase());
    const isProvider = reqUserData?.userType === "provider";

    return (
      <View key={request.id} style={styles.inviteCard}>
        <View style={[styles.notifIcon, { backgroundColor: isProvider ? "#DBEAFE" : "#FEF3C7" }]}>
          <Ionicons name={isProvider ? "medical" : "person-add"} size={20} color={isProvider ? "#2563EB" : "#D97706"} />
        </View>
        <View style={styles.notifContent}>
          <Text style={styles.notifTitle}>{isProvider ? "Provider Join Request" : "Group Join Request"}</Text>
          <Text style={styles.notifMessage}>
            <Text style={{ fontFamily: "Inter_600SemiBold" }}>{request.requestingUsername}</Text>
            {isProvider ? " (Provider) wants to join your group" : " wants to join your group"}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 4, marginBottom: 8 }}>
            {isProvider ? "Accept this provider into your group?" : "Accept this lab into your group?"}
          </Text>
          <View style={styles.inviteBtns}>
            <Pressable
              style={({ pressed }) => [styles.acceptBtn, pressed && { opacity: 0.8 }]}
              onPress={() => setConfirmJoinRequest({ request, accept: true, role: "user" })}
            >
              <Ionicons name="checkmark" size={16} color="#FFF" />
              <Text style={styles.acceptText}>Accept</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.8 }]}
              onPress={() => setConfirmJoinRequest({ request, accept: false })}
            >
              <Ionicons name="close" size={16} color={Colors.light.error} />
              <Text style={styles.declineText}>Reject</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  function renderNotification({ item }: { item: Notification }) {
    const icon = getNotifIcon(item.type);
    return (
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
    );
  }

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 },
        ]}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={styles.title}>Notifications</Text>
          <ChatButton />
        </View>
      </View>
      <FlatList
        data={filteredNotifications}
        keyExtractor={(item) => item.id}
        renderItem={renderNotification}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Platform.OS === "web" ? 84 + 16 : 100 },
        ]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          (pendingInvitations.length > 0 || pendingJoinRequests.length > 0) ? (
            <View style={styles.inviteSection}>
              <Text style={styles.sectionLabel}>Pending Invitations</Text>
              {pendingInvitations.map(inv => renderInvitationCard(inv))}
              {pendingJoinRequests.map(req => renderJoinRequestCard(req))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          pendingInvitations.length === 0 && pendingJoinRequests.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons
                name="notifications-off-outline"
                size={48}
                color={Colors.light.textTertiary}
              />
              <Text style={styles.emptyText}>No notifications yet</Text>
            </View>
          ) : null
        }
      />

      <Modal transparent visible={!!confirmInvite} animationType="fade" onRequestClose={() => setConfirmInvite(null)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <View style={[styles.confirmIconWrap, { backgroundColor: confirmInvite?.accept ? "#DCFCE7" : "#FEE2E2" }]}>
              <Ionicons
                name={confirmInvite?.accept ? "people" : "close-circle"}
                size={32}
                color={confirmInvite?.accept ? "#16A34A" : "#EF4444"}
              />
            </View>
            <Text style={styles.confirmTitle}>
              {confirmInvite?.accept ? "Accept Invitation?" : "Decline Invitation?"}
            </Text>
            <Text style={styles.confirmDesc}>
              {confirmInvite?.accept
                ? `You will join "${confirmInvite?.invitation.groupName}" and gain access to the group's information.`
                : `You will decline the invitation to "${confirmInvite?.invitation.groupName}".`}
            </Text>
            <View style={styles.confirmBtns}>
              <Pressable
                style={({ pressed }) => [styles.confirmYesBtn, pressed && { opacity: 0.85 }]}
                onPress={confirmInvitationResponse}
              >
                <Text style={styles.confirmYesText}>Yes</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.confirmNoBtn, pressed && { opacity: 0.85 }]}
                onPress={() => setConfirmInvite(null)}
              >
                <Text style={styles.confirmNoText}>No</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!confirmJoinRequest} transparent animationType="fade" onRequestClose={() => setConfirmJoinRequest(null)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <View style={[styles.confirmIconWrap, { backgroundColor: confirmJoinRequest?.accept ? "#DCFCE7" : "#FEE2E2" }]}>
              <Ionicons
                name={confirmJoinRequest?.accept ? "person-add" : "close-circle"}
                size={32}
                color={confirmJoinRequest?.accept ? "#16A34A" : "#EF4444"}
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
                style={({ pressed }) => [styles.confirmYesBtn, !confirmJoinRequest?.accept && { backgroundColor: "#EF4444" }, pressed && { opacity: 0.85 }]}
                onPress={() => {
                  if (!confirmJoinRequest) return;
                  respondToGroupJoinRequest(confirmJoinRequest.request.id, confirmJoinRequest.accept, confirmJoinRequest.role);
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
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
    color: Colors.light.subText,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  inviteCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#EFF6FF",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#BFDBFE",
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
    backgroundColor: "#16A34A",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  acceptText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  declineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  declineText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.error,
  },
  notifCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    gap: 14,
  },
  notifCardUnread: {
    borderColor: Colors.light.tint + "40",
    backgroundColor: Colors.light.tintLight + "30",
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
    color: Colors.light.text,
  },
  notifTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  notifMessage: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    lineHeight: 19,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.light.tint,
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
    color: Colors.light.textTertiary,
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  confirmCard: {
    backgroundColor: "#FFF",
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
    color: Colors.light.text,
    textAlign: "center",
    marginBottom: 8,
  },
  confirmDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.subText,
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
    backgroundColor: Colors.light.tint,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmYesText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  confirmNoBtn: {
    flex: 1,
    backgroundColor: Colors.light.surfaceAlt,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmNoText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
});
