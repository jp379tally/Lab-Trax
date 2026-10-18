import React, { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { CreatorGate } from "@/components/creator/CreatorGate";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing } from "@/constants/tokens";
import type { CreatorRevenue, CreatorFeedbackItem, CreatorFeedbackList } from "@workspace/api-client-react";
import { openAttachment } from "@/lib/open-attachment";
import { useMe, canOwnAnyLab } from "@/lib/auth-me";
import {
  CREATOR_ACCESS_KEY, CREATOR_PIN_LENGTH, creatorErrorMessage, formatMinor, creatorJson, isoDate,
} from "@/lib/creator";

type RevenueResp = CreatorRevenue;
type FeedbackItem = CreatorFeedbackItem;
type FeedbackResp = CreatorFeedbackList;

const money = formatMinor;
const FB_PAGE = 25;
type Group = "daily" | "monthly" | "yearly";

export default function CreatorScreen() {
  return <CreatorGate><CreatorBody /></CreatorGate>;
}

function CreatorBody() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const now = new Date();
  const [start, setStart] = useState(isoDate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [end, setEnd] = useState(isoDate(now));
  const [group, setGroup] = useState<Group>("daily");
  const [status, setStatus] = useState<"new" | "reviewed">("new");
  const [page, setPage] = useState(0);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;

  const revenue = useQuery<RevenueResp>({
    queryKey: ["creator", "revenue", start, end, group, tz],
    queryFn: () => creatorJson<RevenueResp>("GET", `/creator/revenue?start=${start}&end=${end}&timezone=${encodeURIComponent(tz)}&group=${group}`),
    enabled: validRange,
  });
  const feedback = useQuery<FeedbackResp>({
    queryKey: ["creator", "feedback", status, page],
    queryFn: () => creatorJson<FeedbackResp>("GET", `/creator/feedback?status=${status}&offset=${page * FB_PAGE}&limit=${FB_PAGE}`),
  });
  const review = useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) => creatorJson("PATCH", `/creator/feedback/${id}`, { reviewed }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["creator", "feedback"] }),
  });
  const lock = useMutation({
    mutationFn: () => creatorJson("POST", "/creator/lock", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY }),
  });
  const me = useMe();
  const ownsLab = canOwnAnyLab(me.data);
  const reconcile = useMutation({
    mutationFn: () => creatorJson("POST", "/creator/revenue/reconcile", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["creator", "revenue"] }),
  });
  const [pin, setPin] = useState({ currentPin: "", newPin: "", confirmPin: "" });
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pinOk = pin.currentPin.length === CREATOR_PIN_LENGTH && pin.newPin.length === CREATOR_PIN_LENGTH && pin.newPin === pin.confirmPin;
  const rotate = useMutation({
    mutationFn: () => creatorJson("POST", "/creator/pin", pin),
    onSuccess: () => {
      setPin({ currentPin: "", newPin: "", confirmPin: "" });
      setPinMsg({ ok: true, text: "PIN changed. Every unlocked session was locked." });
      // Rotation revokes all unlocks, including this one.
      qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
    },
    onError: (e) => setPinMsg({ ok: false, text: creatorErrorMessage(e) }),
  });
  async function download(reportId: string, a: FeedbackItem["attachments"][number]) {
    const r = await openAttachment({
      url: `/api/creator/feedback/${reportId}/attachments/${a.id}`,
      fileName: a.filename, fileType: a.contentType,
    });
    if (r !== "opened") Alert.alert("Attachment", r === "unavailable" ? "Sharing is not available on this device." : "Could not download the attachment.");
  }
  const refreshing = revenue.isRefetching || feedback.isRefetching;

  return (
    <ScreenShell title="Creator" subtitle="Private platform console" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView testID="creator-dashboard" contentContainerStyle={{ padding: Spacing.lg, paddingBottom: insets.bottom + 40, gap: Spacing.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void revenue.refetch(); void feedback.refetch(); }} />}>
        <View style={styles.row}>
          <Pressable style={styles.chipBtn} onPress={() => router.push("/settings/platform-subscriptions" as never)} testID="creator-open-subscriptions">
            <Text style={styles.chipText}>Subscriptions</Text>
          </Pressable>
          <Pressable disabled={lock.isPending} style={[styles.chipBtn, { opacity: lock.isPending ? 0.5 : 1 }]} onPress={() => lock.mutate()} testID="creator-lock"><Text style={styles.chipText}>{lock.isPending ? "Locking" : "Lock"}</Text></Pressable>
          {lock.isError && <Text style={styles.err} testID="creator-lock-error">{creatorErrorMessage(lock.error)}</Text>}
        </View>

        <Text style={styles.h}>Revenue</Text>
        <View style={styles.row}>
          <TextInput style={styles.input} value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textTertiary} autoCapitalize="none" testID="creator-start" />
          <TextInput style={styles.input} value={end} onChangeText={setEnd} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textTertiary} autoCapitalize="none" testID="creator-end" />
        </View>
        <View style={styles.row}>
          {([["This month", "month"], ["Last month", "last"], ["This year", "year"]] as const).map(([l, k]) => (
            <Pressable key={k} testID={`creator-preset-${k}`} style={styles.chipBtn} onPress={() => {
              const y = now.getFullYear(), m = now.getMonth();
              if (k === "month") { setStart(isoDate(new Date(y, m, 1))); setEnd(isoDate(now)); }
              if (k === "last") { setStart(isoDate(new Date(y, m - 1, 1))); setEnd(isoDate(new Date(y, m, 0))); }
              if (k === "year") { setStart(isoDate(new Date(y, 0, 1))); setEnd(isoDate(now)); }
            }}><Text style={styles.chipText}>{l}</Text></Pressable>
          ))}
        </View>
        <Text style={styles.muted} testID="creator-revenue-tz">Timezone {tz} · custom dates inclusive · each currency in its own units</Text>
        <View style={styles.row}>
          {(["daily", "monthly", "yearly"] as const).map((g) => (
            <Pressable key={g} testID={`creator-group-${g}`} onPress={() => setGroup(g)} style={[styles.chipBtn, group === g && styles.chipOn]}>
              <Text style={[styles.chipText, group === g && { color: "#fff" }]}>{g}</Text>
            </Pressable>
          ))}
        </View>
        {!validRange && <Text style={styles.err}>Enter valid dates, start on or before end.</Text>}
        {revenue.isLoading && <ActivityIndicator color={colors.tint} />}
        {revenue.isError && (
          <View><Text style={styles.err}>{creatorErrorMessage(revenue.error)}</Text>
            <Pressable onPress={() => void revenue.refetch()} style={styles.chipBtn}><Text style={styles.chipText}>Retry</Text></Pressable></View>
        )}
        {revenue.data && revenue.data.unavailableAmounts > 0 && (
          <Text style={styles.warn}>{revenue.data.unavailableAmounts} payment amount(s) unavailable and excluded.</Text>
        )}
        {revenue.data?.currencies.length === 0 && <Text style={styles.muted}>No verified receipts in this range. Provider coverage may be incomplete, so this is not a confirmed zero.</Text>}
        {revenue.data?.currencies.map((c) => (
          <View key={c.currency} style={styles.card}>
            <Text style={styles.muted}>{c.currency} · net = collected fees less refunds</Text>
            <Text style={styles.big}>{money(c.netMinor, c.currency)}</Text>
            <Text style={styles.muted}>Collected fees {money(c.collectedMinor, c.currency)} · Refunds {money(c.refundsMinor, c.currency)}</Text>
            {c.buckets.map((b) => (
              <View key={b.period} style={styles.bucket}><Text style={styles.text}>{b.period}</Text><Text style={styles.text}>{money(b.netMinor, c.currency)}</Text></View>
            ))}
          </View>
        ))}
        {reconcile.isError && <Text style={styles.err} testID="creator-reconcile-error">{creatorErrorMessage(reconcile.error)}</Text>}
        <Pressable style={[styles.chipBtn, { alignSelf: "flex-start", opacity: reconcile.isPending ? 0.5 : 1 }]} onPress={() => reconcile.mutate()} disabled={reconcile.isPending} testID="creator-reconcile">
          <Text style={styles.chipText}>{reconcile.isPending ? "Resuming" : "Resume ingestion"}</Text>
        </Pressable>
        {revenue.data?.coverage.map((c) => (
          <Text key={c.provider} style={styles.muted}>{c.provider}: {c.status}. {c.detail}</Text>
        ))}

        <Text style={styles.h}>Feedback inbox{feedback.data ? ` (${feedback.data.newCount} new)` : ""}</Text>
        <View style={styles.row}>
          {(["new", "reviewed"] as const).map((s) => (
            <Pressable key={s} onPress={() => { setStatus(s); setPage(0); }} style={[styles.chipBtn, status === s && styles.chipOn]} testID={`creator-filter-${s}`}>
              <Text style={[styles.chipText, status === s && { color: "#fff" }]}>{s}</Text>
            </Pressable>
          ))}
        </View>
        {feedback.isLoading && <ActivityIndicator color={colors.tint} />}
        {feedback.isError && (
          <View><Text style={styles.err}>{creatorErrorMessage(feedback.error)}</Text>
            <Pressable onPress={() => void feedback.refetch()} style={styles.chipBtn}><Text style={styles.chipText}>Retry</Text></Pressable></View>
        )}
        {review.isError && <Text style={styles.err} testID="creator-review-error">{creatorErrorMessage(review.error)}</Text>}
        {feedback.data?.items.length === 0 && <Text style={styles.muted}>No {status} feedback.</Text>}
        {feedback.data?.items.map((r) => (
          <View key={r.id} style={styles.card} testID={`creator-feedback-${r.id}`}>
            <Text style={styles.text}>{[r.reporter?.firstName, r.reporter?.lastName].filter(Boolean).join(" ") || r.reporter?.username}</Text>
            <Text style={styles.muted}>{r.reporter?.email} · {r.organization?.name} · {r.portal} · {new Date(r.createdAt).toLocaleString()}</Text>
            <Text style={[styles.text, { marginTop: 6 }]}>{r.description}</Text>
            {r.attachments.map((a) => (
              <Pressable key={a.id} testID={`creator-attachment-${a.id}`} onPress={() => void download(r.id, a)}>
                <Text style={styles.link}>{a.filename}</Text>
              </Pressable>
            ))}
            <Pressable disabled={review.isPending} style={[styles.chipBtn, { alignSelf: "flex-start", marginTop: 8, opacity: review.isPending ? 0.5 : 1 }]} onPress={() => review.mutate({ id: r.id, reviewed: !r.reviewedAt })} testID={`creator-review-${r.id}`}>
              <Text style={styles.chipText}>{r.reviewedAt ? "Mark as new" : "Mark reviewed"}</Text>
            </Pressable>
          </View>
        ))}

        {!!feedback.data && feedback.data.total > FB_PAGE && (
          <View style={styles.row} testID="creator-feedback-paging">
            <Pressable disabled={page === 0} onPress={() => setPage(page - 1)} style={[styles.chipBtn, { opacity: page === 0 ? 0.4 : 1 }]} testID="creator-feedback-prev"><Text style={styles.chipText}>Previous</Text></Pressable>
            <Text style={styles.muted}>Page {page + 1} of {Math.ceil(feedback.data.total / FB_PAGE)} · {feedback.data.total} total</Text>
            <Pressable disabled={(page + 1) * FB_PAGE >= feedback.data.total} onPress={() => setPage(page + 1)} style={[styles.chipBtn, { opacity: (page + 1) * FB_PAGE >= feedback.data.total ? 0.4 : 1 }]} testID="creator-feedback-next"><Text style={styles.chipText}>Next</Text></Pressable>
          </View>
        )}

        {ownsLab && (
          <>
            <Text style={styles.h}>Lab owner</Text>
            {([["Lab Profile", "/settings/owner/lab-profile"], ["Team & Roles", "/settings/owner/team"], ["Lab Revenue Reports", "/settings/owner/revenue-reports"], ["Subscription", "/settings/subscriptions"], ["Danger Zone", "/settings/owner/danger-zone"]] as const).map(([label, href]) => (
              <Pressable key={href} style={styles.card} onPress={() => router.push(href as never)} testID={`creator-owner-${href.split("/").pop()}`}>
                <Text style={styles.text}>{label}</Text>
              </Pressable>
            ))}
          </>
        )}

        <Text style={styles.h}>Security</Text>
        <View style={styles.card}>
          {(["currentPin", "newPin", "confirmPin"] as const).map((k) => (
            <TextInput key={k} testID={`creator-${k}`} style={[styles.input, { marginTop: 6 }]} secureTextEntry keyboardType="number-pad"
              maxLength={CREATOR_PIN_LENGTH} value={pin[k]} placeholderTextColor={colors.textTertiary}
              placeholder={k === "currentPin" ? "Current PIN" : k === "newPin" ? "New 7-digit PIN" : "Confirm new PIN"}
              onChangeText={(v) => setPin({ ...pin, [k]: v.replace(/\D/g, "") })} />
          ))}
          {pinMsg && <Text style={pinMsg.ok ? styles.warn : styles.err} testID="creator-pin-msg">{pinMsg.text}</Text>}
          <Pressable style={[styles.chipBtn, { alignSelf: "flex-start", marginTop: 8, opacity: pinOk && !rotate.isPending ? 1 : 0.5 }]}
            disabled={!pinOk || rotate.isPending} onPress={() => rotate.mutate()} testID="creator-save-pin">
            <Text style={styles.chipText}>Change PIN</Text>
          </Pressable>
        </View>
      </ScrollView>
    </ScreenShell>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  h: { color: c.text, fontSize: 18, fontFamily: "Inter_700Bold" },
  input: { flex: 1, minWidth: 120, height: 42, borderRadius: Radius.md, borderWidth: 1, borderColor: c.border, color: c.text, paddingHorizontal: 12 },
  chipBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.md, borderWidth: 1, borderColor: c.border },
  chipOn: { backgroundColor: c.tint, borderColor: c.tint },
  chipText: { color: c.text, fontWeight: "600", textTransform: "capitalize" },
  card: { padding: Spacing.md, borderRadius: Radius.md, borderWidth: 1, borderColor: c.border, gap: 2 },
  big: { color: c.text, fontSize: 28, fontFamily: "Inter_700Bold" },
  bucket: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  text: { color: c.text },
  muted: { color: c.textSecondary, fontSize: 13 },
  err: { color: "#EF4444" },
  warn: { color: "#B45309" },
  link: { color: c.tint, marginTop: 6 },
});
