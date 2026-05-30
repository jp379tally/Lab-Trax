/**
 * Provider-portal "Link Labs" screen (Task #320).
 *
 * Lets a doctor view their cross-lab linked-account graph, accept/decline
 * pending SMS invites, and manually link by entering another platform-wide
 * account number (e.g. one their lab gave them on paper).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { getAccessToken, getApiUrl } from "@/lib/query-client";

interface UserCard {
  userId: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  platformAccountNumber: string | null;
  labs: string[];
}

interface InviteSent {
  inviteId: string;
  toUser: UserCard | null;
  sentAt: string | null;
  status: string;
}

interface InviteReceived {
  inviteId: string;
  fromUser: UserCard | null;
  sentAt: string | null;
  status: string;
}

interface AccountLinksResponse {
  linked: UserCard[];
  pendingInvitesSent: InviteSent[];
  pendingInvitesReceived: InviteReceived[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`/api${path}`, getApiUrl()).toString();
  const resp = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    let msg = `Request failed (${resp.status}).`;
    try {
      const body = await resp.json();
      if (body?.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

export default function LinkLabsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [data, setData] = useState<AccountLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [otherAcct, setOtherAcct] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api<{ data: AccountLinksResponse }>("/account-links");
      setData(resp.data);
    } catch (err: any) {
      Alert.alert("Couldn't load links", err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const respond = async (inviteId: string, accept: boolean) => {
    setBusy(true);
    try {
      await api("/account-links/respond", {
        method: "POST",
        body: JSON.stringify({ inviteId, accept }),
      });
      await reload();
    } catch (err: any) {
      Alert.alert("Couldn't update invite", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const linkManual = async () => {
    const trimmed = otherAcct.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const resp = await api<{ data: { alreadyLinked: boolean } }>(
        "/account-links/manual",
        {
          method: "POST",
          body: JSON.stringify({ otherPlatformAccountNumber: trimmed }),
        }
      );
      setOtherAcct("");
      await reload();
      Alert.alert(
        resp.data.alreadyLinked ? "Already linked" : "Linked",
        resp.data.alreadyLinked
          ? "Those two accounts were already linked."
          : "Your accounts are now linked. Cases and invoices from both labs will appear together."
      );
    } catch (err: any) {
      Alert.alert("Couldn't link", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (otherUserId: string) => {
    setBusy(true);
    try {
      await api(`/account-links/${otherUserId}`, { method: "DELETE" });
      await reload();
    } catch (err: any) {
      Alert.alert("Couldn't unlink", err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Link Labs",
          headerLeft: () => (
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <Ionicons name="chevron-back" size={24} color={colors.tint} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro}>
          Working with more than one lab? Link your LabTrax accounts so all
          your cases and invoices show up in one place.
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Linked accounts</Text>
          {loading ? (
            <Text style={styles.muted}>Loading…</Text>
          ) : data?.linked.length ? (
            data.linked.map((u) => (
              <View key={u.userId} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {u.firstName || u.lastName
                      ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()
                      : u.username}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {u.platformAccountNumber ?? u.username}
                  </Text>
                  {u.labs.length > 0 && (
                    <Text style={styles.cardMeta}>{u.labs.join(", ")}</Text>
                  )}
                </View>
                <Pressable
                  disabled={busy}
                  onPress={() => unlink(u.userId)}
                  style={({ pressed }) => [
                    styles.smallBtn,
                    { backgroundColor: colors.errorLight },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.smallBtnText, { color: colors.errorText }]}>
                    Unlink
                  </Text>
                </Pressable>
              </View>
            ))
          ) : (
            <Text style={styles.muted}>No linked accounts yet.</Text>
          )}
        </View>

        {data && data.pendingInvitesReceived.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Invites for you</Text>
            {data.pendingInvitesReceived.map((inv) => (
              <View key={inv.inviteId} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {inv.fromUser?.platformAccountNumber ??
                      inv.fromUser?.username ??
                      "Another lab"}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {inv.fromUser?.labs?.join(", ") ?? "Wants to link to your account."}
                  </Text>
                </View>
                <Pressable
                  disabled={busy}
                  onPress={() => respond(inv.inviteId, true)}
                  style={({ pressed }) => [
                    styles.smallBtn,
                    { backgroundColor: colors.tintLight },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text
                    style={[styles.smallBtnText, { color: colors.tint }]}
                  >
                    Link
                  </Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => respond(inv.inviteId, false)}
                  style={({ pressed }) => [
                    styles.smallBtn,
                    { backgroundColor: colors.surfaceAlt, marginLeft: 6 },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.smallBtnText, { color: colors.textSecondary }]}>
                    Dismiss
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {data && data.pendingInvitesSent.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Sent invites (waiting)</Text>
            {data.pendingInvitesSent.map((inv) => (
              <View key={inv.inviteId} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {inv.toUser?.platformAccountNumber ??
                      inv.toUser?.username ??
                      "Pending"}
                  </Text>
                  <Text style={styles.cardMeta}>
                    Waiting for the other lab to confirm.
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Link by account number</Text>
          <Text style={styles.muted}>
            Enter the platform account number of your other LabTrax doctor
            account (e.g. 2926JW).
          </Text>
          <TextInput
            value={otherAcct}
            onChangeText={setOtherAcct}
            placeholder="2926JW"
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.input}
            editable={!busy}
          />
          <Pressable
            disabled={busy || !otherAcct.trim()}
            onPress={linkManual}
            style={({ pressed }) => [
              styles.primaryBtn,
              (busy || !otherAcct.trim()) && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.primaryBtnText}>Link account</Text>
          </Pressable>
        </View>
      </ScrollView>
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { padding: 16, paddingBottom: 64 },
  intro: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 16,
    lineHeight: 20,
  },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  muted: { color: colors.textSecondary, fontSize: 14, marginBottom: 8 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cardTitle: { fontWeight: "600", color: colors.text, fontSize: 15 },
  cardMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  smallBtnText: { fontWeight: "600", fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: colors.surface,
    color: colors.text,
    marginTop: 8,
    marginBottom: 12,
  },
  primaryBtn: {
    backgroundColor: colors.tint,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryBtnText: { color: colors.textInverse, fontWeight: "600", fontSize: 15 },
});
