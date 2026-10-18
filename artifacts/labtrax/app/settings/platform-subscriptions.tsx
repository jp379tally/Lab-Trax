import React, { useMemo, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView,
  StyleSheet, Switch, Text, TextInput, View,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { CreatorGate } from "@/components/creator/CreatorGate";
import { ScreenShell } from "@/components/settings/SettingsRow";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  ADMIN_SUBSCRIPTIONS_QUERY_KEY, SUBSCRIPTION_STATUSES, type AdminSubscription,
  correctAdminSubscriptionAccountNumber, endAdminSubscriptionWaiver,
  getAdminSubscriptionHistory, getAdminSubscriptions, saveAdminSubscriptionWaiver,
  parseFutureWaiverEnd, subscriptionAccessLabel, updateAdminSubscription,
} from "@/lib/admin-subscriptions";

const STATUS_COLORS: Record<string, string> = {
  active: "#10B981", trialing: "#3B82F6", past_due: "#F59E0B", grace: "#F97316",
  locked: "#EF4444", canceled: "#64748B", legacy_free: "#8B5CF6",
};

function date(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric",
  });
}

function dollars(value: number | null) {
  return value === null ? "No plan price" : `$${value.toFixed(2)}/month`;
}

function address(item: AdminSubscription) {
  if (item.formattedAddress?.trim()) return item.formattedAddress.trim();
  const org = item.organization;
  const legacyAddress = [org?.addressLine1, org?.addressLine2, org?.city, org?.state, org?.zip]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
  return legacyAddress || "No address on file";
}

function formatAccountNumber(item: AdminSubscription) {
  return item.canonicalAccountNumber?.trim() ||
    (item.status === "legacy_free" ? "Legacy account (no number)" : "No account number");
}

export default function PlatformSubscriptionsScreen() {
  return <CreatorGate><PlatformSubscriptionsBody /></CreatorGate>;
}

function PlatformSubscriptionsBody() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [selected, setSelected] = useState<AdminSubscription | null>(null);
  const [accountNumber, setAccountNumber] = useState("");
  const [waiverReason, setWaiverReason] = useState("");
  const [waiverEnd, setWaiverEnd] = useState("");
  const [indefinite, setIndefinite] = useState(false);
  const [notice, setNotice] = useState("");

  const directory = useQuery({
    queryKey: [...ADMIN_SUBSCRIPTIONS_QUERY_KEY, search, status, plan],
    queryFn: () => getAdminSubscriptions({ q: search.trim(), status, plan }),
    staleTime: 20_000,
  });
  const history = useQuery({
    queryKey: [...ADMIN_SUBSCRIPTIONS_QUERY_KEY, selected?.id, "history"],
    queryFn: () => getAdminSubscriptionHistory(selected!.id),
    enabled: Boolean(selected),
  });

  function open(item: AdminSubscription) {
    setSelected(item);
    setAccountNumber(item.canonicalAccountNumber ?? "");
    setWaiverReason(item.waiverReason ?? "");
    setWaiverEnd(item.waiverEndsAt?.slice(0, 10) ?? "");
    setIndefinite(Boolean(item.waiverReason && !item.waiverEndsAt));
    setNotice("");
  }

  const mutation = useMutation({
    mutationFn: async (work: () => Promise<unknown>) => work(),
    onSuccess: async () => {
      setNotice("Changes saved.");
      await qc.invalidateQueries({ queryKey: ADMIN_SUBSCRIPTIONS_QUERY_KEY });
      const refreshed = await directory.refetch();
      if (selected) {
        const replacement = refreshed.data?.items.find((item) => item.id === selected.id);
        if (replacement) {
          setSelected(replacement);
          setAccountNumber(replacement.canonicalAccountNumber ?? "");
          setWaiverReason(replacement.waiverReason ?? "");
          setWaiverEnd(replacement.waiverEndsAt?.slice(0, 10) ?? "");
          setIndefinite(Boolean(replacement.waiverReason && !replacement.waiverEndsAt));
        }
      }
    },
    onError: (error: Error) => Alert.alert("Could not save changes", error.message),
  });

  function confirmUpdate(label: string, work: () => Promise<unknown>) {
    Alert.alert(`Confirm ${label}`, "This changes platform-wide subscription access and will be recorded in audit history.", [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", onPress: () => mutation.mutate(work) },
    ]);
  }

  function saveWaiver() {
    if (!waiverReason.trim()) {
      Alert.alert("Reason required", "Enter why this fee waiver is being granted.");
      return;
    }
    let endsAt: string | null = null;
    if (!indefinite) {
      const parsed = parseFutureWaiverEnd(waiverEnd);
      if (!parsed) {
        Alert.alert("Valid end date required", "Use YYYY-MM-DD and choose a future date, or select Indefinite.");
        return;
      }
      endsAt = parsed;
    }
    confirmUpdate("fee waiver", () => saveAdminSubscriptionWaiver(selected!.id, {
      reason: waiverReason.trim(), endsAt,
    }));
  }

  const filterOptions = [
    { value: "", label: "All statuses" },
    ...SUBSCRIPTION_STATUSES.map((value) => ({ value, label: value.replaceAll("_", " ") })),
  ];

  return (
    <ScreenShell title="Subscription Console" subtitle="Creator administration" onBack={() => router.back()} insetTop={insets.top}>
      {directory.data?.summary && (
        <View testID="subscription-summary" style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, gap: 6 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
            {([["Accounts", directory.data.summary.totalAccounts], ["Paid", directory.data.summary.paidSubscribers], ["Trial", directory.data.summary.trial], ["Free", directory.data.summary.free], ["Waived", directory.data.summary.waived], ["Other", directory.data.summary.other]] as const).map(([l, v]) => (
              <View key={l}><Text style={{ color: colors.textSecondary, fontSize: 11 }}>{l}</Text><Text style={{ color: colors.text, fontSize: 18, fontWeight: "700" }}>{v}</Text></View>
            ))}
          </View>
          {(["byStatus", "byProvider"] as const).map((k) => (
            <Text key={k} testID={`subscription-${k}`} style={{ color: colors.textSecondary, fontSize: 12 }}>
              {k === "byStatus" ? "By status: " : "By provider: "}
              {Object.entries(directory.data!.summary![k]).map(([n, c]) => `${n} ${c}`).join(" · ") || "none"}
            </Text>
          ))}
        </View>
      )}
      <View style={[styles.search, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Ionicons name="search" size={17} color={colors.textSecondary} />
        <TextInput testID="subscription-search" value={search} onChangeText={setSearch}
          placeholder="Search name or account number…" placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text }]} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {filterOptions.map((option) => (
          <Pressable key={option.value || "all"} testID={`status-filter-${option.value || "all"}`}
            onPress={() => setStatus(option.value)}
            style={[styles.chip, { borderColor: colors.border }, status === option.value && { backgroundColor: colors.tint, borderColor: colors.tint }]}>
            <Text style={[styles.chipText, { color: status === option.value ? "#fff" : colors.textSecondary }]}>{option.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {(directory.data?.plans.length ?? 0) > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          <Pressable testID="plan-filter-all" onPress={() => setPlan("")}
            style={[styles.chip, { borderColor: colors.border }, !plan && { backgroundColor: colors.tint, borderColor: colors.tint }]}>
            <Text style={[styles.chipText, { color: !plan ? "#fff" : colors.textSecondary }]}>All plans</Text>
          </Pressable>
          {directory.data!.plans.map((item) => (
            <Pressable key={item.id} testID={`plan-filter-${item.id}`} onPress={() => setPlan(item.id)}
              style={[styles.chip, { borderColor: colors.border }, plan === item.id && { backgroundColor: colors.tint, borderColor: colors.tint }]}>
              <Text style={[styles.chipText, { color: plan === item.id ? "#fff" : colors.textSecondary }]}>{item.id}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {directory.isError && (
        <View style={styles.center}>
          <Ionicons name="shield-outline" size={28} color={colors.error} />
          <Text style={[styles.error, { color: colors.error }]}>{(directory.error as Error).message}</Text>
          <Pressable onPress={() => router.replace("/settings/platform-admin" as never)}><Text style={{ color: colors.tint }}>Open Platform Admin</Text></Pressable>
        </View>
      )}
      {directory.isLoading && <ActivityIndicator color={colors.tint} style={styles.center} />}
      <FlatList
        data={directory.data?.items ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={directory.isFetching} onRefresh={() => void directory.refetch()} tintColor={colors.tint} />}
        ListEmptyComponent={!directory.isLoading && !directory.isError ? <Text style={[styles.empty, { color: colors.textSecondary }]}>No subscriptions match these filters.</Text> : null}
        renderItem={({ item }) => {
          const tone = item.waiverActive ? "#8B5CF6" : STATUS_COLORS[item.status] ?? colors.textSecondary;
          return (
            <Pressable testID={`subscription-row-${item.id}`} onPress={() => open(item)}
              style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.rowTop}>
                <View style={styles.rowCopy}>
                  <Text style={[styles.name, { color: colors.text }]}>{item.accountHolderName}</Text>
                   <Text style={[styles.meta, { color: colors.textSecondary }]}>{item.accountType ?? "Account"} · {formatAccountNumber(item)}</Text>
                   <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={2}>{address(item)}</Text>
                </View>
                <View style={[styles.badge, { backgroundColor: tone + "20" }]}><Text style={[styles.badgeText, { color: tone }]}>{subscriptionAccessLabel(item)}</Text></View>
              </View>
              <Text style={[styles.meta, { color: colors.textSecondary }]}>
                {item.providerPlan ? `${item.providerPlan} · ${dollars(item.monthlyPriceUsd)}` : dollars(item.monthlyPriceUsd)}
              </Text>
              <Text style={[styles.meta, { color: colors.textSecondary }]}>
                {item.waiverActive ? `Waiver ${item.waiverEndsAt ? `ends ${date(item.waiverEndsAt)}` : "has no expiration"}` :
                  item.currentPeriodEnd ? `${item.cancelAtPeriodEnd ? "Expires" : "Renews"} ${date(item.currentPeriodEnd)}` :
                  item.trialEndAt ? `Trial ends ${date(item.trialEndAt)}` : "No renewal date"}
              </Text>
            </Pressable>
          );
        }}
      />
      <Modal visible={Boolean(selected)} animationType="slide" presentationStyle="formSheet" onRequestClose={() => setSelected(null)}>
        {selected && (
          <DismissKeyboardView
            style={[styles.sheet, { backgroundColor: colors.backgroundSolid }]}
            testID="subscription-detail-keyboard-dismiss"
          >
            <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
              <Pressable onPress={() => setSelected(null)}><Ionicons name="close" size={24} color={colors.text} /></Pressable>
              <Text style={[styles.sheetTitle, { color: colors.text }]} numberOfLines={1}>{selected.accountHolderName}</Text>
              <View style={{ width: 24 }} />
            </View>
            <ScrollView
              contentContainerStyle={styles.sheetBody}
              keyboardDismissMode={scrollKeyboardDismissMode}
              keyboardShouldPersistTaps="handled"
            >
              {notice ? <Text style={[styles.notice, { color: colors.success }]}>{notice}</Text> : null}
              <Info label="Access" value={subscriptionAccessLabel(selected)} colors={colors} styles={styles} />
              <Info label="Account type" value={selected.accountType ?? "—"} colors={colors} styles={styles} />
                <Info label="Customer Center #" value={formatAccountNumber(selected)} colors={colors} styles={styles} />
               <Info label="Provider address" value={address(selected)} colors={colors} styles={styles} />
              <Info label="Plan & price" value={`${selected.providerPlan ?? "None"} · ${dollars(selected.monthlyPriceUsd)}`} colors={colors} styles={styles} />
              <Info label="Renewal / expiration" value={date(selected.currentPeriodEnd ?? selected.trialEndAt ?? selected.canceledAt)} colors={colors} styles={styles} />

              {selected.canonicalSubjectType === "provider_org" && (
                <Section title="Correct account number" colors={colors}>
                  <TextInput testID="account-number-input" value={accountNumber} onChangeText={setAccountNumber}
                    style={[styles.input, { color: colors.text, borderColor: colors.border }]} placeholder="Customer Center account number" placeholderTextColor={colors.textTertiary} />
                  <Action label="Save account number" pending={mutation.isPending} colors={colors}
                    onPress={() => accountNumber.trim() ? confirmUpdate("account number", () => correctAdminSubscriptionAccountNumber(selected.id, accountNumber.trim())) : Alert.alert("Account number required")} />
                </Section>
              )}

              <Section title="Plan" colors={colors}>
                <View style={styles.wrap}>
                  {(directory.data?.plans ?? []).map((item) => (
                    <Pressable key={item.id} testID={`plan-${item.id}`} disabled={mutation.isPending}
                      onPress={() => confirmUpdate("plan", () => updateAdminSubscription(selected.id, { providerPlan: item.id }))}
                      style={[styles.chip, { borderColor: colors.border }, selected.providerPlan === item.id && { backgroundColor: colors.tint, borderColor: colors.tint }]}>
                      <Text style={[styles.chipText, { color: selected.providerPlan === item.id ? "#fff" : colors.text }]}>{item.id} · ${item.monthlyPriceUsd}</Text>
                    </Pressable>
                  ))}
                </View>
              </Section>

              <Section title="Status" colors={colors}>
                <View style={styles.wrap}>
                  {SUBSCRIPTION_STATUSES.map((item) => (
                    <Pressable key={item} testID={`status-${item}`} disabled={mutation.isPending}
                      onPress={() => confirmUpdate("status", () => updateAdminSubscription(selected.id, { status: item }))}
                      style={[styles.chip, { borderColor: colors.border }, selected.status === item && { backgroundColor: STATUS_COLORS[item], borderColor: STATUS_COLORS[item] }]}>
                      <Text style={[styles.chipText, { color: selected.status === item ? "#fff" : colors.text }]}>{item.replaceAll("_", " ")}</Text>
                    </Pressable>
                  ))}
                </View>
              </Section>

              <Section title="Fee waiver" colors={colors}>
                <TextInput testID="waiver-reason-input" value={waiverReason} onChangeText={setWaiverReason}
                  style={[styles.input, { color: colors.text, borderColor: colors.border }]} placeholder="Required reason" placeholderTextColor={colors.textTertiary} />
                <View style={styles.switchRow}><Text style={{ color: colors.text }}>Indefinite</Text><Switch testID="waiver-indefinite" value={indefinite} onValueChange={setIndefinite} /></View>
                {!indefinite && <TextInput testID="waiver-end-input" value={waiverEnd} onChangeText={setWaiverEnd}
                  style={[styles.input, { color: colors.text, borderColor: colors.border }]} placeholder="End date (YYYY-MM-DD)" placeholderTextColor={colors.textTertiary} />}
                <Action label={selected.waiverReason ? "Replace waiver" : "Grant waiver"} pending={mutation.isPending} colors={colors} onPress={saveWaiver} />
                {selected.waiverReason && <Pressable testID="end-waiver" onPress={() => confirmUpdate("waiver end", () => endAdminSubscriptionWaiver(selected.id))}>
                  <Text style={[styles.danger, { color: colors.error }]}>End current waiver</Text>
                </Pressable>}
              </Section>

              <Section title="Audit history" colors={colors}>
                {history.isLoading && <ActivityIndicator color={colors.tint} />}
                {history.isError && <Text style={{ color: colors.error }}>Could not load audit history.</Text>}
                {(history.data?.events ?? []).map((event) => (
                  <View key={event.id} style={[styles.historyRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.historyTitle, { color: colors.text }]}>{event.eventType.replaceAll("_", " ")}</Text>
                    <Text style={[styles.meta, { color: colors.textSecondary }]}>{date(event.createdAt)}{event.statusAfter ? ` · ${event.statusBefore ?? "—"} → ${event.statusAfter}` : ""}</Text>
                  </View>
                ))}
                {(history.data?.audits ?? []).map((audit) => (
                  <View key={`audit-${audit.id}`} style={[styles.historyRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.historyTitle, { color: colors.text }]}>{audit.action.replaceAll("_", " ")}</Text>
                    <Text style={[styles.meta, { color: colors.textSecondary }]}>Audit · {date(audit.createdAt)}</Text>
                  </View>
                ))}
                {!history.isLoading && (history.data?.events.length ?? 0) === 0 && (history.data?.audits.length ?? 0) === 0 && <Text style={{ color: colors.textSecondary }}>No subscription history yet.</Text>}
              </Section>
            </ScrollView>
          </DismissKeyboardView>
        )}
      </Modal>
    </ScreenShell>
  );
}

function Info({ label, value, colors, styles }: any) {
  return <View style={[styles.info, { borderBottomColor: colors.border }]}><Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{label}</Text><Text style={[styles.infoValue, { color: colors.text }]}>{value}</Text></View>;
}
function Section({ title, colors, children }: any) {
  return <View style={{ gap: Spacing.md }}><Text style={[Typography.captionMedium, { color: colors.textSecondary, textTransform: "uppercase" }]}>{title}</Text>{children}</View>;
}
function Action({ label, pending, colors, onPress }: any) {
  return <Pressable testID={`action-${label.toLowerCase().replaceAll(" ", "-")}`} disabled={pending} onPress={onPress} style={[{ backgroundColor: colors.tint }, stylesStatic.action]}>
    {pending && <ActivityIndicator size="small" color="#fff" />}<Text style={stylesStatic.actionText}>{pending ? "Saving…" : label}</Text>
  </Pressable>;
}
const stylesStatic = StyleSheet.create({
  action: { minHeight: 44, borderRadius: Radius.md, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: Spacing.sm },
  actionText: { ...Typography.bodySemibold, color: "#fff" },
});
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    search: { margin: Spacing.lg, marginBottom: Spacing.sm, flexDirection: "row", alignItems: "center", gap: Spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: Radius.md, paddingHorizontal: Spacing.md },
    searchInput: { flex: 1, ...Typography.body, paddingVertical: Spacing.md },
    filters: { paddingHorizontal: Spacing.lg, gap: Spacing.sm, paddingBottom: Spacing.md },
    chip: { borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
    chipText: { ...Typography.captionMedium, textTransform: "capitalize" },
    list: { padding: Spacing.lg, paddingTop: 0, gap: Spacing.sm, paddingBottom: Spacing.xxxl },
    row: { padding: Spacing.md, gap: Spacing.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: Radius.lg },
    rowTop: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
    rowCopy: { flex: 1 }, name: { ...Typography.bodySemibold }, meta: { ...Typography.caption },
    badge: { borderRadius: Radius.full, paddingHorizontal: Spacing.sm, paddingVertical: 4 },
    badgeText: { ...Typography.captionMedium },
    center: { alignItems: "center", justifyContent: "center", gap: Spacing.md, padding: Spacing.xxl },
    error: { ...Typography.body, textAlign: "center" }, empty: { ...Typography.body, textAlign: "center", marginTop: Spacing.xxl },
    sheet: { flex: 1 }, sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: Spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth },
    sheetTitle: { ...Typography.h3, flex: 1, textAlign: "center" }, sheetBody: { padding: Spacing.lg, gap: Spacing.xl, paddingBottom: Spacing.xxxl },
    notice: { ...Typography.bodyMedium, textAlign: "center" },
    info: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: Spacing.sm },
    infoLabel: { ...Typography.caption, flex: 1 }, infoValue: { ...Typography.bodyMedium, flex: 2, textAlign: "right" },
    input: { ...Typography.body, borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    danger: { ...Typography.bodySemibold, textAlign: "center", padding: Spacing.sm },
    historyRow: { gap: 3, paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
    historyTitle: { ...Typography.bodyMedium, textTransform: "capitalize" },
  });
}