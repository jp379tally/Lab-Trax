import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  ActivityIndicator,
  Switch,
  Alert,
  Platform,
  FlatList,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import Colors from "@/constants/colors";
import { resilientFetch } from "@/lib/query-client";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

type InvoiceScope = "open" | "open_overdue_90" | "all";

interface PracticeRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  openBalance: number;
  overdueBalance: number;
}

interface StatementSchedule {
  id: string;
  enabled: boolean;
  dayOfMonth: number;
  emailSubject: string | null;
  emailBody: string | null;
  emailReplyTo: string | null;
  includedOrgIds: string[] | null;
  lastRunAt: string | null;
}

interface StatementRun {
  id: string;
  practiceOrganizationId: string | null;
  practiceName: string;
  practiceEmail: string | null;
  periodMonth: string;
  status: string;
  errorMessage: string | null;
  invoiceCount: number;
  totalBilled: string;
  openBalance: string;
  triggeredBy: string;
  attemptCount: number;
  createdAt: string;
}

interface BatchResultRow {
  practiceId: string;
  practiceName: string;
  emailStatus: "sent" | "failed" | "skipped" | null;
  emailError: string | null;
  smsStatus: "sent" | "failed" | "skipped" | null;
  smsError: string | null;
}

interface BatchSendResult {
  periodLabel?: string;
  results: BatchResultRow[];
}

const DEFAULT_SUBJECT = "Statement for {{practiceName}} — {{periodLabel}}";
const DEFAULT_BODY =
  "Hello,\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nTotal billed: {{totalBilled}}\nOpen balance: {{openBalance}}\n\nThank you,\n{{labName}}";

type WizardStep = 1 | 2 | 3 | 4 | 5;

export default function StatementsScreen() {
  const { allLabOrganizationIds } = useApp();
  const { currentUser } = useAuth();
  const { colors: themeColors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = allLabOrganizationIds[0] ?? null;

  const [practices, setPractices] = useState<PracticeRow[]>([]);
  const [schedule, setSchedule] = useState<StatementSchedule | null>(null);
  const [recentRuns, setRecentRuns] = useState<StatementRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showWizard, setShowWizard] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAutoSend, setShowAutoSend] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const [runningAutoSend, setRunningAutoSend] = useState(false);

  const loadData = useCallback(async () => {
    if (!orgId) return;
    try {
      const [orgsRes, schedRes, runsRes, invRes] = await Promise.all([
        resilientFetch("/api/organizations"),
        resilientFetch(`/api/lab-orgs/${encodeURIComponent(orgId)}/statement-schedule`),
        resilientFetch(`/api/lab-orgs/${encodeURIComponent(orgId)}/statement-runs?limit=20`),
        resilientFetch(`/api/invoices?organizationId=${encodeURIComponent(orgId)}`),
      ]);

      // Build a per-practice open/overdue balance map from invoices
      const balanceMap = new Map<string, { open: number; overdue: number }>();
      if (invRes.ok) {
        const invData = await invRes.json();
        const allInvoices: any[] = invData?.data ?? invData ?? [];
        for (const inv of allInvoices) {
          const pid = inv.providerOrganizationId ?? inv.clientOrganizationId ?? null;
          if (!pid) continue;
          const status = String(inv.status ?? "");
          const amount = Number(inv.amount ?? inv.totalAmount ?? 0);
          if (!balanceMap.has(pid)) balanceMap.set(pid, { open: 0, overdue: 0 });
          const entry = balanceMap.get(pid)!;
          if (status === "open") entry.open += amount;
          if (status === "overdue") { entry.open += amount; entry.overdue += amount; }
        }
      }

      if (orgsRes.ok) {
        const orgsData = await orgsRes.json();
        const allOrgs: any[] = orgsData?.data ?? orgsData ?? [];
        const providerOrgs = allOrgs.filter(
          (o: any) => o.parentLabOrganizationId === orgId
        );
        const rows: PracticeRow[] = providerOrgs.map((o: any) => {
          const bal = balanceMap.get(o.id) ?? { open: 0, overdue: 0 };
          return {
            id: o.id,
            name: o.displayName || o.name || "Unknown",
            email: o.billingEmail || o.email || null,
            phone: o.phone || null,
            openBalance: bal.open,
            overdueBalance: bal.overdue,
          };
        });
        setPractices(rows);
      }

      if (schedRes.ok) {
        const schedData = await schedRes.json();
        setSchedule(schedData?.data ?? schedData);
      }

      if (runsRes.ok) {
        const runsData = await runsRes.json();
        setRecentRuns(runsData?.data ?? runsData ?? []);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load data");
    }
  }, [orgId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadData().finally(() => setLoading(false));
    }, [loadData])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  const totalOpen = practices.reduce((s, p) => s + p.openBalance, 0);
  const practicesWithBalance = practices.filter((p) => p.openBalance > 0).length;

  const groupedRuns = useMemo(() => {
    const map = new Map<string, StatementRun[]>();
    for (const r of recentRuns) {
      const key = r.createdAt.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).slice(0, 10);
  }, [recentRuns]);

  async function handleRunAutoSendNow() {
    if (!orgId) return;
    Alert.alert(
      "Run Auto-Send Now",
      "This will send statements to practices with activity in the prior month. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send Now",
          style: "default",
          onPress: async () => {
            setRunningAutoSend(true);
            try {
              const res = await resilientFetch(
                `/api/lab-orgs/${encodeURIComponent(orgId)}/statement-schedule/run-now`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
              );
              const data = await res.json();
              if (res.ok) {
                const results = data?.data?.results ?? data?.results ?? [];
                const sent = results.filter((r: any) => r.status === "sent").length;
                const failed = results.filter((r: any) => r.status === "failed").length;
                const skipped = results.filter((r: any) => r.status !== "sent" && r.status !== "failed").length;
                if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                Alert.alert(
                  "Done",
                  `Sent: ${sent}${failed ? `, Failed: ${failed}` : ""}${skipped ? `, Skipped: ${skipped}` : ""}`
                );
                await loadData();
              } else {
                const msg = data?.error || data?.message || "Failed to run auto-send";
                Alert.alert("Error", msg);
              }
            } catch (e: any) {
              Alert.alert("Error", e?.message || "Failed to run auto-send");
            } finally {
              setRunningAutoSend(false);
            }
          },
        },
      ]
    );
  }

  const scheduleNextLabel = useMemo(() => {
    if (!schedule?.enabled) return "Disabled";
    const day = schedule.dayOfMonth === 0 ? "last day" : `day ${schedule.dayOfMonth}`;
    return `Sends on ${day} of each month`;
  }, [schedule]);

  const paddingTop = Platform.OS === "web" ? 67 + 16 : insets.top + 16;
  const paddingBottom = Platform.OS === "web" ? 84 + 24 : insets.bottom + 90;

  return (
    <View style={{ flex: 1, backgroundColor: themeColors.background }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop, paddingBottom }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, marginBottom: 20 }}>
          <Pressable
            onPress={() => router.back()}
            style={{ marginRight: 12, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="arrow-back" size={24} color={themeColors.text} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 24, fontFamily: "Inter_700Bold", color: themeColors.text }}>
              Statements
            </Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
              Billing statements for your practices
            </Text>
          </View>
          <Pressable
            onPress={handleRefresh}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="refresh" size={20} color={themeColors.textSecondary} />
          </Pressable>
        </View>

        {!orgId && (
          <View style={{ marginHorizontal: 20, padding: 20, backgroundColor: Colors.light.tintLight, borderRadius: 14, alignItems: "center" }}>
            <Ionicons name="business-outline" size={32} color={Colors.light.tint} />
            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: themeColors.text, marginTop: 12, textAlign: "center" }}>
              No lab organization found
            </Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 6, textAlign: "center" }}>
              Join or create a lab to access statements.
            </Text>
          </View>
        )}

        {orgId && loading && !refreshing && (
          <View style={{ alignItems: "center", paddingTop: 40 }}>
            <ActivityIndicator size="large" color={Colors.light.tint} />
          </View>
        )}

        {orgId && !loading && (
          <>
            {/* Summary Cards */}
            <View style={{ flexDirection: "row", paddingHorizontal: 20, gap: 10, marginBottom: 20 }}>
              <View style={{ flex: 1, backgroundColor: Colors.light.tintLight, borderRadius: 14, padding: 16, alignItems: "center" }}>
                <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.light.tint }}>
                  {practices.length}
                </Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: themeColors.textSecondary, marginTop: 2, textAlign: "center" }}>
                  Practices
                </Text>
              </View>
              <View style={{ flex: 1, backgroundColor: "#FEF3C7", borderRadius: 14, padding: 16, alignItems: "center" }}>
                <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: "#D97706" }}>
                  {practicesWithBalance}
                </Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#92400E", marginTop: 2, textAlign: "center" }}>
                  Open Balances
                </Text>
              </View>
              <View style={{ flex: 1, backgroundColor: "#FEE2E2", borderRadius: 14, padding: 16, alignItems: "center" }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#DC2626" }} numberOfLines={1} adjustsFontSizeToFit>
                  {formatCurrency(totalOpen)}
                </Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#991B1B", marginTop: 2, textAlign: "center" }}>
                  Total Due
                </Text>
              </View>
            </View>

            {/* Generate Button */}
            <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
              <Pressable
                onPress={() => setShowWizard(true)}
                style={({ pressed }) => ({
                  backgroundColor: Colors.light.tint,
                  borderRadius: 14,
                  paddingVertical: 16,
                  paddingHorizontal: 20,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  justifyContent: "center" as const,
                  gap: 10,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Ionicons name="send" size={20} color="#fff" />
                <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>
                  Generate Statements
                </Text>
              </Pressable>
            </View>

            {/* Action rows */}
            <View style={{ marginHorizontal: 20, marginBottom: 20, backgroundColor: themeColors.surface, borderRadius: 16, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
              {/* Auto-send */}
              <Pressable
                onPress={() => setShowAutoSend(true)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  gap: 12,
                  backgroundColor: pressed ? themeColors.backgroundSolid : "transparent",
                })}
              >
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: "#E0E7FF", alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="calendar-outline" size={20} color="#4F46E5" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>
                    Auto-send
                  </Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: schedule?.enabled ? Colors.light.tint : themeColors.textSecondary, marginTop: 2 }}>
                    {scheduleNextLabel}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={themeColors.textSecondary} />
              </Pressable>

              <View style={{ height: 1, backgroundColor: themeColors.border, marginLeft: 68 }} />

              {/* Statement Defaults */}
              <Pressable
                onPress={() => setShowDefaults(true)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  gap: 12,
                  backgroundColor: pressed ? themeColors.backgroundSolid : "transparent",
                })}
              >
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: "#D1FAE5", alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="mail-outline" size={20} color="#059669" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>
                    Statement Defaults
                  </Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                    Default email subject and body
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={themeColors.textSecondary} />
              </Pressable>

              <View style={{ height: 1, backgroundColor: themeColors.border, marginLeft: 68 }} />

              {/* Send History */}
              <Pressable
                onPress={() => setShowHistory(true)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  gap: 12,
                  backgroundColor: pressed ? themeColors.backgroundSolid : "transparent",
                })}
              >
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: "#CFFAFE", alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="time-outline" size={20} color="#0891B2" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>
                    Send History
                  </Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                    {recentRuns.length > 0 ? `${recentRuns.length} recent send${recentRuns.length === 1 ? "" : "s"}` : "No sends yet"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={themeColors.textSecondary} />
              </Pressable>
            </View>

            {/* Practices List */}
            {practices.length > 0 && (
              <View style={{ marginHorizontal: 20 }}>
                <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: themeColors.text, marginBottom: 10 }}>
                  Practices ({practices.length})
                </Text>
                <View style={{ backgroundColor: themeColors.surface, borderRadius: 16, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                  {practices.map((p, idx) => (
                    <View key={p.id}>
                      {idx > 0 && <View style={{ height: 1, backgroundColor: themeColors.border }} />}
                      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 }}>
                        <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: Colors.light.tintLight, alignItems: "center", justifyContent: "center" }}>
                          <Ionicons name="business-outline" size={18} color={Colors.light.tint} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }} numberOfLines={1}>
                            {p.name}
                          </Text>
                          <View style={{ flexDirection: "row", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                            {p.email ? (
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                                <Ionicons name="mail-outline" size={11} color={themeColors.textSecondary} />
                                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>Email</Text>
                              </View>
                            ) : (
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                                <Ionicons name="warning-outline" size={11} color="#F59E0B" />
                                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#F59E0B" }}>No email</Text>
                              </View>
                            )}
                            {p.phone && (
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                                <Ionicons name="call-outline" size={11} color={themeColors.textSecondary} />
                                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>SMS</Text>
                              </View>
                            )}
                          </View>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {practices.length === 0 && !loading && (
              <View style={{ marginHorizontal: 20, padding: 24, backgroundColor: themeColors.surface, borderRadius: 16, borderWidth: 1, borderColor: themeColors.border, alignItems: "center" }}>
                <Ionicons name="business-outline" size={36} color={themeColors.textSecondary} />
                <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: themeColors.textSecondary, marginTop: 12, textAlign: "center" }}>
                  No practices found. Practices are created when provider organizations are linked to your lab.
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Generate Wizard */}
      {showWizard && orgId && (
        <GenerateWizard
          orgId={orgId}
          practices={practices}
          schedule={schedule}
          onClose={() => { setShowWizard(false); loadData(); }}
        />
      )}

      {/* Send History Modal */}
      {showHistory && orgId && (
        <HistoryModal
          runs={recentRuns}
          groupedRuns={groupedRuns}
          loading={loading}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Auto-send Modal */}
      {showAutoSend && orgId && (
        <AutoSendModal
          orgId={orgId}
          schedule={schedule}
          practices={practices}
          onClose={() => { setShowAutoSend(false); loadData(); }}
          onRunNow={handleRunAutoSendNow}
          running={runningAutoSend}
        />
      )}

      {/* Statement Defaults Modal */}
      {showDefaults && orgId && (
        <DefaultsModal
          orgId={orgId}
          schedule={schedule}
          onClose={() => { setShowDefaults(false); loadData(); }}
        />
      )}
    </View>
  );
}

// ─── Generate Wizard ─────────────────────────────────────────────────────────

function GenerateWizard({
  orgId,
  practices,
  schedule,
  onClose,
}: {
  orgId: string;
  practices: PracticeRow[];
  schedule: StatementSchedule | null;
  onClose: () => void;
}) {
  const { colors: themeColors } = useTheme();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<WizardStep>(1);

  // Step 1
  const [search, setSearch] = useState("");
  // Only pre-select practices that have at least one delivery channel
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(practices.filter((p) => p.email || p.phone).map((p) => p.id))
  );

  // Step 2
  const [invoiceScope, setInvoiceScope] = useState<InvoiceScope>("open");
  const periodDefault = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
  const [periodLabel, setPeriodLabel] = useState(periodDefault);

  // Step 3
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [emailSubject, setEmailSubject] = useState(schedule?.emailSubject ?? "");
  const [emailBody, setEmailBody] = useState(schedule?.emailBody ?? "");

  // Step 4/5
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<BatchSendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [sendProgress, setSendProgress] = useState(0);
  const sendProgressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const filteredPractices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? practices.filter((p) => p.name.toLowerCase().includes(q)) : practices;
  }, [practices, search]);

  const selectedPractices = useMemo(
    () => practices.filter((p) => selectedIds.has(p.id)),
    [practices, selectedIds]
  );

  const practicesMissingEmail = useMemo(
    () => selectedPractices.filter((p) => !p.email),
    [selectedPractices]
  );

  const practicesMissingSms = useMemo(
    () => selectedPractices.filter((p) => !p.phone),
    [selectedPractices]
  );

  const practicesDisabled = useMemo(
    () => practices.filter((p) => !p.email && !p.phone),
    [practices]
  );

  function togglePractice(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    // Only select practices that have at least one delivery channel
    setSelectedIds(new Set(practices.filter((p) => p.email || p.phone).map((p) => p.id)));
  }

  function deselectAll() {
    setSelectedIds(new Set());
  }

  async function handleSend() {
    if (selectedIds.size === 0) {
      Alert.alert("No Practices", "Select at least one practice to send statements to.");
      return;
    }
    const channels: string[] = [];
    if (emailEnabled) channels.push("email");
    if (smsEnabled) channels.push("sms");
    if (channels.length === 0) {
      Alert.alert("No Channel", "Enable at least one delivery channel (Email or SMS).");
      return;
    }

    const totalToSend = selectedIds.size;
    setSending(true);
    setSendError(null);
    setSentCount(0);
    setSendProgress(0);
    setStep(5);

    // Simulate incremental progress while waiting for the batch response
    if (sendProgressRef.current) clearInterval(sendProgressRef.current);
    let simulated = 0;
    sendProgressRef.current = setInterval(() => {
      simulated = Math.min(simulated + 1, totalToSend - 1);
      setSendProgress(simulated);
    }, Math.max(200, 1500 / Math.max(totalToSend, 1)));

    try {
      const body: any = {
        practiceIds: Array.from(selectedIds),
        invoiceScope,
        channels,
        periodLabel: periodLabel.trim() || null,
        emailSubject: emailSubject.trim() || null,
        emailBody: emailBody.trim() || null,
      };

      const res = await resilientFetch(
        `/api/lab-orgs/${encodeURIComponent(orgId)}/statements/batch-send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      clearInterval(sendProgressRef.current!);
      setSendProgress(totalToSend);

      const data = await res.json();
      if (res.ok) {
        const result = data?.data ?? data;
        setSendResult(result);
        const sent = (result.results ?? []).filter((r: any) =>
          r.emailStatus === "sent" || r.smsStatus === "sent"
        ).length;
        setSentCount(sent);
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const msg = data?.error || data?.message || "Failed to send statements";
        setSendError(msg);
      }
    } catch (e: any) {
      clearInterval(sendProgressRef.current!);
      setSendError(e?.message || "Failed to send statements");
    } finally {
      setSending(false);
    }
  }

  async function retryFailed() {
    if (!sendResult) return;
    const failed = sendResult.results.filter(
      (r) => r.emailStatus === "failed" || r.smsStatus === "failed"
    );
    if (failed.length === 0) return;

    setSending(true);
    setSendError(null);

    const failedIds = new Set(failed.map((r) => r.practiceId));
    const channels: string[] = [];
    if (emailEnabled) channels.push("email");
    if (smsEnabled) channels.push("sms");
    if (channels.length === 0) channels.push("email");

    try {
      const res = await resilientFetch(
        `/api/lab-orgs/${encodeURIComponent(orgId)}/statements/batch-send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            practiceIds: Array.from(failedIds),
            invoiceScope,
            channels,
            periodLabel: periodLabel.trim() || null,
            emailSubject: emailSubject.trim() || null,
            emailBody: emailBody.trim() || null,
          }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        const result = data?.data ?? data;
        const prevSucceeded = sendResult.results.filter(
          (r) => r.emailStatus !== "failed" && r.smsStatus !== "failed"
        );
        const merged = [...prevSucceeded, ...(result.results ?? [])];
        setSendResult({ ...result, results: merged });
        const sent = merged.filter((r: any) =>
          r.emailStatus === "sent" || r.smsStatus === "sent"
        ).length;
        setSentCount(sent);
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const msg = data?.error || data?.message || "Retry failed";
        setSendError(msg);
      }
    } catch (e: any) {
      setSendError(e?.message || "Retry failed");
    } finally {
      setSending(false);
    }
  }

  const SCOPE_OPTIONS: { value: InvoiceScope; label: string; description: string }[] = [
    { value: "open", label: "Open invoices only", description: "Includes all unpaid invoices" },
    { value: "open_overdue_90", label: "Open (aging highlighted)", description: "Overdue balances are visually highlighted in the PDF" },
    { value: "all", label: "All invoices", description: "Includes paid, void, and open invoices" },
  ];

  const paddingBottom = Platform.OS === "web" ? 24 : insets.bottom + 24;

  const stepTitles: Record<WizardStep, string> = {
    1: "Select Practices",
    2: "Scope & Period",
    3: "Delivery Channels",
    4: "Review & Send",
    5: "Results",
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={step < 5 ? onClose : undefined}
    >
      <View style={{ flex: 1, backgroundColor: themeColors.background }}>
        {/* Wizard Header */}
        <View style={{
          paddingTop: Platform.OS === "web" ? 24 : insets.top + 8,
          paddingHorizontal: 20,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: themeColors.border,
          backgroundColor: themeColors.surface,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            {step > 1 && step < 5 && (
              <Pressable
                onPress={() => setStep((s) => (s - 1) as WizardStep)}
                style={{ marginRight: 10, width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="chevron-back" size={22} color={themeColors.text} />
              </Pressable>
            )}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: themeColors.text }}>
                {stepTitles[step]}
              </Text>
              {step < 5 && (
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                  Step {step} of 4
                </Text>
              )}
            </View>
            <Pressable onPress={onClose} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="close" size={22} color={themeColors.textSecondary} />
            </Pressable>
          </View>

          {/* Progress bar */}
          {step < 5 && (
            <View style={{ height: 4, backgroundColor: themeColors.border, borderRadius: 2 }}>
              <View
                style={{
                  height: 4,
                  width: `${(step / 4) * 100}%`,
                  backgroundColor: Colors.light.tint,
                  borderRadius: 2,
                }}
              />
            </View>
          )}
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom }}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Step 1: Practice Selection ── */}
          {step === 1 && (
            <View>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12, gap: 8 }}>
                <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: themeColors.surface, borderRadius: 10, borderWidth: 1, borderColor: themeColors.border, paddingHorizontal: 10, height: 40 }}>
                  <Ionicons name="search" size={16} color={themeColors.textSecondary} />
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search practices…"
                    placeholderTextColor={themeColors.textSecondary}
                    style={{ flex: 1, marginLeft: 8, fontSize: 14, fontFamily: "Inter_400Regular", color: themeColors.text }}
                  />
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
                <Pressable
                  onPress={selectAll}
                  style={({ pressed }) => ({
                    flex: 1,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: themeColors.surface,
                    borderWidth: 1,
                    borderColor: themeColors.border,
                    alignItems: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>Select All</Text>
                </Pressable>
                <Pressable
                  onPress={deselectAll}
                  style={({ pressed }) => ({
                    flex: 1,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: themeColors.surface,
                    borderWidth: 1,
                    borderColor: themeColors.border,
                    alignItems: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: themeColors.textSecondary }}>Deselect All</Text>
                </Pressable>
              </View>

              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: themeColors.textSecondary, marginBottom: 8 }}>
                {selectedIds.size} of {practices.length} selected
              </Text>

              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                {filteredPractices.length === 0 && (
                  <View style={{ padding: 20, alignItems: "center" }}>
                    <Text style={{ color: themeColors.textSecondary, fontFamily: "Inter_400Regular" }}>No practices found</Text>
                  </View>
                )}
                {filteredPractices.map((p, idx) => {
                  const disabled = !p.email && !p.phone;
                  const checked = selectedIds.has(p.id);
                  return (
                    <View key={p.id}>
                      {idx > 0 && <View style={{ height: 1, backgroundColor: themeColors.border }} />}
                      <Pressable
                        onPress={() => !disabled && togglePractice(p.id)}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          gap: 12,
                          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
                        })}
                      >
                        <View style={{
                          width: 22,
                          height: 22,
                          borderRadius: 6,
                          borderWidth: 2,
                          borderColor: checked && !disabled ? Colors.light.tint : themeColors.border,
                          backgroundColor: checked && !disabled ? Colors.light.tint : "transparent",
                          alignItems: "center",
                          justifyContent: "center",
                        }}>
                          {checked && !disabled && <Ionicons name="checkmark" size={13} color="#fff" />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }} numberOfLines={1}>
                            {p.name}
                          </Text>
                          <View style={{ flexDirection: "row", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                            {p.email && (
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                                <Ionicons name="mail-outline" size={11} color={themeColors.textSecondary} />
                                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>{p.email}</Text>
                              </View>
                            )}
                            {p.phone && (
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                                <Ionicons name="call-outline" size={11} color={themeColors.textSecondary} />
                                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>{p.phone}</Text>
                              </View>
                            )}
                            {disabled && (
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#FEF3C7", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                                <Ionicons name="warning-outline" size={11} color="#D97706" />
                                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#D97706" }}>No email or phone</Text>
                              </View>
                            )}
                          </View>
                          {(p.openBalance > 0 || p.overdueBalance > 0) && (
                            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                              {p.openBalance > 0 && (
                                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: themeColors.textSecondary }}>
                                  Open: <Text style={{ color: themeColors.text }}>{formatCurrency(p.openBalance)}</Text>
                                </Text>
                              )}
                              {p.overdueBalance > 0 && (
                                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#DC2626" }}>
                                  Overdue: {formatCurrency(p.overdueBalance)}
                                </Text>
                              )}
                            </View>
                          )}
                        </View>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* ── Step 2: Scope & Period ── */}
          {step === 2 && (
            <View style={{ gap: 20 }}>
              <View>
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: themeColors.text, marginBottom: 10 }}>
                  Invoice Scope
                </Text>
                <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                  {SCOPE_OPTIONS.map((opt, idx) => (
                    <View key={opt.value}>
                      {idx > 0 && <View style={{ height: 1, backgroundColor: themeColors.border }} />}
                      <Pressable
                        onPress={() => setInvoiceScope(opt.value)}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          paddingHorizontal: 14,
                          paddingVertical: 14,
                          gap: 12,
                          backgroundColor: pressed ? themeColors.backgroundSolid : "transparent",
                        })}
                      >
                        <View style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          borderWidth: 2,
                          borderColor: invoiceScope === opt.value ? Colors.light.tint : themeColors.border,
                          backgroundColor: invoiceScope === opt.value ? Colors.light.tint : "transparent",
                          alignItems: "center",
                          justifyContent: "center",
                        }}>
                          {invoiceScope === opt.value && (
                            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" }} />
                          )}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>
                            {opt.label}
                          </Text>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                            {opt.description}
                          </Text>
                        </View>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </View>

              <View>
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: themeColors.text, marginBottom: 6 }}>
                  Statement Period Label
                </Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginBottom: 10 }}>
                  This label appears on the statement PDF and in the email subject.
                </Text>
                <TextInput
                  value={periodLabel}
                  onChangeText={setPeriodLabel}
                  placeholder="e.g. May 2026"
                  placeholderTextColor={themeColors.textSecondary}
                  style={{
                    backgroundColor: themeColors.surface,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: themeColors.border,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    fontSize: 15,
                    fontFamily: "Inter_400Regular",
                    color: themeColors.text,
                  }}
                />
              </View>
            </View>
          )}

          {/* ── Step 3: Delivery Channels ── */}
          {step === 3 && (
            <View style={{ gap: 16 }}>
              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>Email (PDF attachment)</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                      Statement PDF sent to billing email
                    </Text>
                    {emailEnabled && practicesMissingEmail.length > 0 && (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
                        <Ionicons name="warning-outline" size={13} color="#F59E0B" />
                        <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#D97706" }}>
                          {practicesMissingEmail.length} practice{practicesMissingEmail.length === 1 ? "" : "s"} missing email
                        </Text>
                      </View>
                    )}
                  </View>
                  <Switch
                    value={emailEnabled}
                    onValueChange={setEmailEnabled}
                    trackColor={{ false: themeColors.border, true: Colors.light.tint }}
                    thumbColor="#fff"
                  />
                </View>

                {emailEnabled && (
                  <>
                    <View style={{ height: 1, backgroundColor: themeColors.border }} />
                    <Pressable
                      onPress={() => setShowTemplate(!showTemplate)}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        backgroundColor: pressed ? themeColors.backgroundSolid : "transparent",
                      })}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>
                          Customize email template for this batch
                        </Text>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 1 }}>
                          Override default subject and body
                        </Text>
                      </View>
                      <Ionicons
                        name={showTemplate ? "chevron-up" : "chevron-down"}
                        size={18}
                        color={Colors.light.tint}
                      />
                    </Pressable>
                    {showTemplate && (
                      <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
                        <View>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: themeColors.textSecondary, marginBottom: 6 }}>
                            SUBJECT
                          </Text>
                          <TextInput
                            value={emailSubject}
                            onChangeText={setEmailSubject}
                            placeholder={DEFAULT_SUBJECT}
                            placeholderTextColor={themeColors.textSecondary}
                            style={{
                              backgroundColor: themeColors.backgroundSolid,
                              borderRadius: 10,
                              borderWidth: 1,
                              borderColor: themeColors.border,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 13,
                              fontFamily: "Inter_400Regular",
                              color: themeColors.text,
                            }}
                          />
                        </View>
                        <View>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: themeColors.textSecondary, marginBottom: 6 }}>
                            BODY
                          </Text>
                          <TextInput
                            value={emailBody}
                            onChangeText={setEmailBody}
                            placeholder={DEFAULT_BODY}
                            placeholderTextColor={themeColors.textSecondary}
                            multiline
                            numberOfLines={6}
                            style={{
                              backgroundColor: themeColors.backgroundSolid,
                              borderRadius: 10,
                              borderWidth: 1,
                              borderColor: themeColors.border,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 13,
                              fontFamily: "Inter_400Regular",
                              color: themeColors.text,
                              minHeight: 120,
                              textAlignVertical: "top",
                            }}
                          />
                        </View>
                        <View style={{ backgroundColor: themeColors.backgroundSolid, borderRadius: 10, padding: 12 }}>
                          <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: themeColors.textSecondary, marginBottom: 6 }}>
                            AVAILABLE PLACEHOLDERS
                          </Text>
                          {["{{practiceName}}", "{{openBalance}}", "{{periodLabel}}", "{{labName}}", "{{totalBilled}}"].map((p) => (
                            <Text key={p} style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                              {p}
                            </Text>
                          ))}
                        </View>
                      </View>
                    )}
                  </>
                )}
              </View>

              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>SMS</Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                      Text notification to practice phone
                    </Text>
                    {smsEnabled && practicesMissingSms.length > 0 && (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
                        <Ionicons name="warning-outline" size={13} color="#F59E0B" />
                        <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#D97706" }}>
                          {practicesMissingSms.length} practice{practicesMissingSms.length === 1 ? "" : "s"} missing phone
                        </Text>
                      </View>
                    )}
                  </View>
                  <Switch
                    value={smsEnabled}
                    onValueChange={setSmsEnabled}
                    trackColor={{ false: themeColors.border, true: Colors.light.tint }}
                    thumbColor="#fff"
                  />
                </View>
              </View>
            </View>
          )}

          {/* ── Step 4: Review & Send ── */}
          {step === 4 && (
            <View style={{ gap: 16 }}>
              <View style={{ backgroundColor: Colors.light.tintLight, borderRadius: 14, padding: 16 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.light.tint, marginBottom: 8 }}>
                  SUMMARY
                </Text>
                <View style={{ gap: 6 }}>
                  <SummaryRow label="Practices" value={String(selectedIds.size)} />
                  <SummaryRow
                    label="Channels"
                    value={[emailEnabled && "Email", smsEnabled && "SMS"].filter(Boolean).join(", ") || "None"}
                  />
                  <SummaryRow label="Scope" value={SCOPE_OPTIONS.find((o) => o.value === invoiceScope)?.label ?? invoiceScope} />
                  <SummaryRow label="Period" value={periodLabel || "Not set"} />
                </View>
              </View>

              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: themeColors.text }}>
                Selected Practices ({selectedPractices.length})
              </Text>

              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                {selectedPractices.length === 0 && (
                  <View style={{ padding: 20, alignItems: "center" }}>
                    <Text style={{ color: themeColors.textSecondary, fontFamily: "Inter_400Regular" }}>No practices selected</Text>
                  </View>
                )}
                {selectedPractices.map((p, idx) => (
                  <View key={p.id}>
                    {idx > 0 && <View style={{ height: 1, backgroundColor: themeColors.border }} />}
                    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 12 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <View style={{ flexDirection: "row", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                          {emailEnabled && (
                            p.email
                              ? <StatusChip label="Email ✓" color="#059669" bg="#D1FAE5" />
                              : <StatusChip label="No email" color="#D97706" bg="#FEF3C7" />
                          )}
                          {smsEnabled && (
                            p.phone
                              ? <StatusChip label="SMS ✓" color="#0891B2" bg="#CFFAFE" />
                              : <StatusChip label="No phone" color="#D97706" bg="#FEF3C7" />
                          )}
                        </View>
                        {(p.openBalance > 0 || p.overdueBalance > 0) && (
                          <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                            {p.openBalance > 0 && (
                              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: themeColors.textSecondary }}>
                                Open: <Text style={{ color: themeColors.text, fontFamily: "Inter_600SemiBold" }}>{formatCurrency(p.openBalance)}</Text>
                              </Text>
                            )}
                            {p.overdueBalance > 0 && (
                              <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#DC2626" }}>
                                Overdue: {formatCurrency(p.overdueBalance)}
                              </Text>
                            )}
                          </View>
                        )}
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* ── Step 5: Results ── */}
          {step === 5 && (
            <View style={{ gap: 16 }}>
              {sending && (
                <View style={{ alignItems: "center", paddingVertical: 32 }}>
                  <ActivityIndicator size="large" color={Colors.light.tint} />
                  <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: themeColors.textSecondary, marginTop: 16 }}>
                    Sending {sendProgress} of {selectedIds.size}…
                  </Text>
                  <View style={{ width: 200, height: 4, backgroundColor: themeColors.border, borderRadius: 2, marginTop: 12, overflow: "hidden" }}>
                    <View style={{ height: 4, backgroundColor: Colors.light.tint, borderRadius: 2, width: selectedIds.size > 0 ? `${Math.round((sendProgress / selectedIds.size) * 100)}%` : "0%" }} />
                  </View>
                </View>
              )}

              {!sending && sendError && (
                <View style={{ backgroundColor: "#FEE2E2", borderRadius: 14, padding: 16 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <Ionicons name="alert-circle" size={20} color="#DC2626" />
                    <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#DC2626" }}>Send Failed</Text>
                  </View>
                  <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: "#991B1B" }}>{sendError}</Text>
                </View>
              )}

              {!sending && sendResult && (
                <>
                  {/* Counts */}
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <ResultCard
                      count={sendResult.results.filter((r) => r.emailStatus === "sent" || r.smsStatus === "sent").length}
                      label="Sent"
                      color="#059669"
                      bg="#D1FAE5"
                    />
                    <ResultCard
                      count={sendResult.results.filter((r) => r.emailStatus === "failed" || r.smsStatus === "failed").length}
                      label="Failed"
                      color="#DC2626"
                      bg="#FEE2E2"
                    />
                    <ResultCard
                      count={sendResult.results.filter((r) => r.emailStatus !== "sent" && r.smsStatus !== "sent" && r.emailStatus !== "failed" && r.smsStatus !== "failed").length}
                      label="Skipped"
                      color="#D97706"
                      bg="#FEF3C7"
                    />
                  </View>

                  {/* Per-practice breakdown */}
                  <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: themeColors.text }}>
                    Details
                  </Text>
                  <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                    {sendResult.results.map((r, idx) => {
                      const hasFail = r.emailStatus === "failed" || r.smsStatus === "failed";
                      const hasSent = r.emailStatus === "sent" || r.smsStatus === "sent";
                      const composite = hasFail ? "failed" : hasSent ? "sent" : "skipped";
                      return (
                        <View key={r.practiceId + idx}>
                          {idx > 0 && <View style={{ height: 1, backgroundColor: themeColors.border }} />}
                          <View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 6 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                              <View style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: statusBg(composite), alignItems: "center", justifyContent: "center" }}>
                                <Ionicons name={statusIcon(composite)} size={15} color={statusColor(composite)} />
                              </View>
                              <Text style={{ flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }} numberOfLines={1}>
                                {r.practiceName}
                              </Text>
                            </View>
                            <View style={{ flexDirection: "row", gap: 6, marginLeft: 38, flexWrap: "wrap" }}>
                              {r.emailStatus !== null && (
                                <StatusChip
                                  label={`Email: ${r.emailStatus}`}
                                  color={statusColor(r.emailStatus)}
                                  bg={statusBg(r.emailStatus)}
                                />
                              )}
                              {r.smsStatus !== null && (
                                <StatusChip
                                  label={`SMS: ${r.smsStatus}`}
                                  color={statusColor(r.smsStatus)}
                                  bg={statusBg(r.smsStatus)}
                                />
                              )}
                            </View>
                            {(r.emailError || r.smsError) && (
                              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#DC2626", marginLeft: 38 }}>
                                {[r.emailError, r.smsError].filter(Boolean).join(" · ")}
                              </Text>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </View>

                  {/* Retry failed */}
                  {sendResult.results.some((r) => r.emailStatus === "failed" || r.smsStatus === "failed") && (
                    <Pressable
                      onPress={retryFailed}
                      style={({ pressed }) => ({
                        backgroundColor: "#FEE2E2",
                        borderRadius: 14,
                        paddingVertical: 14,
                        alignItems: "center",
                        flexDirection: "row" as const,
                        justifyContent: "center" as const,
                        gap: 8,
                        opacity: pressed ? 0.85 : 1,
                      })}
                    >
                      <Ionicons name="refresh" size={18} color="#DC2626" />
                      <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#DC2626" }}>
                        Retry Failed ({sendResult.results.filter((r) => r.emailStatus === "failed" || r.smsStatus === "failed").length})
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
            </View>
          )}
        </ScrollView>

        {/* Bottom action buttons */}
        <View style={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Platform.OS === "web" ? 20 : insets.bottom + 12,
          borderTopWidth: 1,
          borderTopColor: themeColors.border,
          backgroundColor: themeColors.surface,
        }}>
          {step < 4 && (
            <Pressable
              onPress={() => {
                if (step === 1 && selectedIds.size === 0) {
                  Alert.alert("No Practices", "Select at least one practice.");
                  return;
                }
                if (step === 3 && !emailEnabled && !smsEnabled) {
                  Alert.alert("No Channel", "Enable at least one delivery channel.");
                  return;
                }
                setStep((s) => (s + 1) as WizardStep);
              }}
              style={({ pressed }) => ({
                backgroundColor: Colors.light.tint,
                borderRadius: 14,
                paddingVertical: 16,
                alignItems: "center" as const,
                flexDirection: "row" as const,
                justifyContent: "center" as const,
                gap: 8,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Continue</Text>
              <Ionicons name="chevron-forward" size={18} color="#fff" />
            </Pressable>
          )}
          {step === 4 && (
            <Pressable
              onPress={handleSend}
              disabled={sending}
              style={({ pressed }) => ({
                backgroundColor: Colors.light.tint,
                borderRadius: 14,
                paddingVertical: 16,
                alignItems: "center" as const,
                flexDirection: "row" as const,
                justifyContent: "center" as const,
                gap: 8,
                opacity: pressed || sending ? 0.85 : 1,
              })}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="send" size={18} color="#fff" />
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>
                    Send Statements ({selectedIds.size})
                  </Text>
                </>
              )}
            </Pressable>
          )}
          {step === 5 && (
            <Pressable
              onPress={onClose}
              style={({ pressed }) => ({
                backgroundColor: themeColors.surface,
                borderRadius: 14,
                paddingVertical: 16,
                alignItems: "center" as const,
                borderWidth: 1,
                borderColor: themeColors.border,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: themeColors.text }}>Done</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─── History Modal ────────────────────────────────────────────────────────────

function HistoryModal({
  runs,
  groupedRuns,
  loading,
  onClose,
}: {
  runs: StatementRun[];
  groupedRuns: [string, StatementRun[]][];
  loading: boolean;
  onClose: () => void;
}) {
  const { colors: themeColors } = useTheme();
  const insets = useSafeAreaInsets();
  // selectedBatch is a group (one batch send): [dateKey, runs[]]
  const [selectedBatch, setSelectedBatch] = useState<[string, StatementRun[]] | null>(null);

  const paddingTop = Platform.OS === "web" ? 24 : insets.top + 8;
  const paddingBottom = Platform.OS === "web" ? 24 : insets.bottom + 24;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: themeColors.background }}>
        <View style={{
          paddingTop,
          paddingHorizontal: 20,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: themeColors.border,
          backgroundColor: themeColors.surface,
          flexDirection: "row",
          alignItems: "center",
        }}>
          <Text style={{ flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", color: themeColors.text }}>
            Send History
          </Text>
          <Pressable onPress={onClose} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="close" size={22} color={themeColors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom }}>
          {loading && (
            <View style={{ alignItems: "center", paddingTop: 40 }}>
              <ActivityIndicator size="large" color={Colors.light.tint} />
            </View>
          )}
          {!loading && runs.length === 0 && (
            <View style={{ alignItems: "center", paddingTop: 40 }}>
              <Ionicons name="time-outline" size={40} color={themeColors.textSecondary} />
              <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: themeColors.textSecondary, marginTop: 12, textAlign: "center" }}>
                No statements have been sent yet.
              </Text>
            </View>
          )}
          {groupedRuns.map(([date, dayRuns]) => {
            const sent = dayRuns.filter((r) => r.status === "sent").length;
            const failed = dayRuns.filter((r) => r.status === "failed").length;
            const batchComposite = failed > 0 ? "failed" : sent > 0 ? "sent" : "skipped_no_email";
            return (
              <View key={date} style={{ marginBottom: 12 }}>
                {/* Batch-level row — tap to see per-practice breakdown */}
                <Pressable
                  onPress={() => setSelectedBatch([date, dayRuns])}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: pressed ? themeColors.backgroundSolid : themeColors.surface,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: themeColors.border,
                    paddingHorizontal: 14,
                    paddingVertical: 13,
                    gap: 12,
                  })}
                >
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: statusBg(batchComposite), alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name={statusIcon(batchComposite)} size={18} color={statusColor(batchComposite)} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }}>
                      {formatDate(date)}
                    </Text>
                    <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                      {dayRuns.length} practice{dayRuns.length !== 1 ? "s" : ""}
                      {sent > 0 ? ` · ${sent} sent` : ""}
                      {failed > 0 ? ` · ${failed} failed` : ""}
                      {" · "}{dayRuns[0]?.periodMonth ?? ""}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={themeColors.textSecondary} />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>

        {/* Batch detail modal — per-practice breakdown */}
        {selectedBatch && (
          <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedBatch(null)}>
            <View style={{ flex: 1, backgroundColor: themeColors.background }}>
              <View style={{
                paddingTop,
                paddingHorizontal: 20,
                paddingBottom: 16,
                borderBottomWidth: 1,
                borderBottomColor: themeColors.border,
                backgroundColor: themeColors.surface,
                flexDirection: "row",
                alignItems: "center",
              }}>
                <Pressable onPress={() => setSelectedBatch(null)} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", marginRight: 4 }}>
                  <Ionicons name="arrow-back" size={20} color={themeColors.textSecondary} />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color: themeColors.text }}>
                    {formatDate(selectedBatch[0])}
                  </Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>
                    {selectedBatch[1].length} practice{selectedBatch[1].length !== 1 ? "s" : ""} · {selectedBatch[1][0]?.triggeredBy ?? "manual"}
                  </Text>
                </View>
              </View>
              <ScrollView contentContainerStyle={{ padding: 20, paddingBottom }}>
                <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, overflow: "hidden" }}>
                  {selectedBatch[1].map((run, idx) => (
                    <View key={run.id}>
                      {idx > 0 && <View style={{ height: 1, backgroundColor: themeColors.border }} />}
                      <View style={{ paddingHorizontal: 14, paddingVertical: 13, gap: 6 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                          <View style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: statusBg(run.status), alignItems: "center", justifyContent: "center" }}>
                            <Ionicons name={statusIcon(run.status)} size={15} color={statusColor(run.status)} />
                          </View>
                          <Text style={{ flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", color: themeColors.text }} numberOfLines={1}>
                            {run.practiceName}
                          </Text>
                          <StatusChip label={statusLabel(run.status)} color={statusColor(run.status)} bg={statusBg(run.status)} />
                        </View>
                        {/* Channel + balance context */}
                        <View style={{ marginLeft: 38, gap: 3 }}>
                          {run.practiceEmail && (
                            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>
                              Email: {run.practiceEmail}
                            </Text>
                          )}
                          <View style={{ flexDirection: "row", gap: 12 }}>
                            {parseFloat(run.openBalance || "0") > 0 && (
                              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: themeColors.textSecondary }}>
                                Open: <Text style={{ color: themeColors.text }}>{formatCurrency(parseFloat(run.openBalance))}</Text>
                              </Text>
                            )}
                            {run.invoiceCount > 0 && (
                              <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary }}>
                                {run.invoiceCount} invoice{run.invoiceCount !== 1 ? "s" : ""}
                              </Text>
                            )}
                          </View>
                          {run.errorMessage && (
                            <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#DC2626" }}>
                              {run.errorMessage}
                            </Text>
                          )}
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          </Modal>
        )}
      </View>
    </Modal>
  );
}

// ─── Auto-send Modal ──────────────────────────────────────────────────────────

function AutoSendModal({
  orgId,
  schedule,
  practices,
  onClose,
  onRunNow,
  running,
}: {
  orgId: string;
  schedule: StatementSchedule | null;
  practices: PracticeRow[];
  onClose: () => void;
  onRunNow: () => void;
  running: boolean;
}) {
  const { colors: themeColors } = useTheme();
  const insets = useSafeAreaInsets();

  const paddingTop = Platform.OS === "web" ? 24 : insets.top + 8;
  const paddingBottom = Platform.OS === "web" ? 24 : insets.bottom + 24;

  const [toggling, setToggling] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(schedule?.enabled ?? false);

  useEffect(() => {
    setLocalEnabled(schedule?.enabled ?? false);
  }, [schedule?.enabled]);

  const scheduledPracticeCount = schedule?.includedOrgIds?.length ?? null;
  const dayLabel = !schedule
    ? "—"
    : schedule.dayOfMonth === 0
    ? "last day of month"
    : `day ${schedule.dayOfMonth} of month`;

  const practicesMissingEmail = useMemo(() => {
    const targeted = schedule?.includedOrgIds?.length
      ? practices.filter((p) => schedule.includedOrgIds!.includes(p.id))
      : practices;
    return targeted.filter((p) => !p.email).length;
  }, [practices, schedule]);

  async function handleToggleEnabled(val: boolean) {
    if (!schedule || toggling) return;
    setLocalEnabled(val);
    setToggling(true);
    try {
      await resilientFetch(
        `/api/lab-orgs/${encodeURIComponent(orgId)}/statement-schedule`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: val,
            dayOfMonth: schedule.dayOfMonth,
            emailSubject: schedule.emailSubject ?? null,
            emailBody: schedule.emailBody ?? null,
            emailReplyTo: schedule.emailReplyTo ?? null,
            includedOrgIds: schedule.includedOrgIds ?? null,
          }),
        }
      );
    } catch {
      setLocalEnabled(!val);
    } finally {
      setToggling(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: themeColors.background }}>
        <View style={{
          paddingTop,
          paddingHorizontal: 20,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: themeColors.border,
          backgroundColor: themeColors.surface,
          flexDirection: "row",
          alignItems: "center",
        }}>
          <Text style={{ flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", color: themeColors.text }}>
            Auto-Send Schedule
          </Text>
          <Pressable onPress={onClose} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="close" size={22} color={themeColors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom }}>
          {!schedule && (
            <View style={{ alignItems: "center", paddingTop: 40 }}>
              <ActivityIndicator size="large" color={Colors.light.tint} />
            </View>
          )}
          {schedule && (
            <>
              {/* Enable/disable toggle */}
              <View style={{
                backgroundColor: localEnabled ? Colors.light.tintLight : themeColors.surface,
                borderRadius: 16,
                padding: 16,
                marginBottom: 16,
                borderWidth: 1,
                borderColor: localEnabled ? Colors.light.tint + "40" : themeColors.border,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    backgroundColor: localEnabled ? Colors.light.tint : themeColors.border,
                    alignItems: "center",
                    justifyContent: "center",
                  }}>
                    <Ionicons name="calendar" size={20} color={localEnabled ? "#fff" : themeColors.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: themeColors.text }}>
                      {localEnabled ? "Auto-send enabled" : "Auto-send disabled"}
                    </Text>
                    {localEnabled && (
                      <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginTop: 2 }}>
                        Sends on {dayLabel} each month
                      </Text>
                    )}
                  </View>
                  {toggling
                    ? <ActivityIndicator size="small" color={Colors.light.tint} />
                    : <Switch
                        value={localEnabled}
                        onValueChange={handleToggleEnabled}
                        trackColor={{ false: themeColors.border, true: Colors.light.tint }}
                        thumbColor="#fff"
                      />
                  }
                </View>
              </View>

              {/* Details */}
              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, padding: 16, gap: 10, marginBottom: 20 }}>
                <SummaryRow label="Status" value={localEnabled ? "Enabled" : "Disabled"} />
                <SummaryRow label="Send on" value={dayLabel} />
                <SummaryRow
                  label="Practices"
                  value={scheduledPracticeCount !== null
                    ? `${scheduledPracticeCount} of ${practices.length} selected`
                    : `All (${practices.length})`
                  }
                />
                {practicesMissingEmail > 0 && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FEF3C7", borderRadius: 8, padding: 10 }}>
                    <Ionicons name="warning-outline" size={16} color="#D97706" />
                    <Text style={{ flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: "#D97706" }}>
                      {practicesMissingEmail} targeted practice{practicesMissingEmail !== 1 ? "s are" : " is"} missing a billing email
                    </Text>
                  </View>
                )}
                {schedule.lastRunAt && (
                  <SummaryRow label="Last run" value={formatDate(schedule.lastRunAt)} />
                )}
              </View>

              {/* Run Now */}
              {schedule.enabled && (
                <Pressable
                  onPress={onRunNow}
                  disabled={running}
                  style={({ pressed }) => ({
                    backgroundColor: Colors.light.tint,
                    borderRadius: 14,
                    paddingVertical: 16,
                    alignItems: "center" as const,
                    flexDirection: "row" as const,
                    justifyContent: "center" as const,
                    gap: 8,
                    opacity: pressed || running ? 0.85 : 1,
                    marginBottom: 12,
                  })}
                >
                  {running ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="play-circle" size={20} color="#fff" />
                      <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Run Now (Prior Month)</Text>
                    </>
                  )}
                </Pressable>
              )}

              {/* Edit on desktop note */}
              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, padding: 16, flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                <Ionicons name="information-circle-outline" size={18} color={Colors.light.tint} style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, lineHeight: 20 }}>
                  To edit the full auto-send schedule (day of month, targeted practices, email template), use the desktop app's Statements page.
                </Text>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Statement Defaults Modal ─────────────────────────────────────────────────

function DefaultsModal({
  orgId,
  schedule,
  onClose,
}: {
  orgId: string;
  schedule: StatementSchedule | null;
  onClose: () => void;
}) {
  const { colors: themeColors } = useTheme();
  const insets = useSafeAreaInsets();

  const [subject, setSubject] = useState(schedule?.emailSubject ?? "");
  const [body, setBody] = useState(schedule?.emailBody ?? "");
  const [saving, setSaving] = useState(false);

  const paddingTop = Platform.OS === "web" ? 24 : insets.top + 8;
  const paddingBottom = Platform.OS === "web" ? 24 : insets.bottom + 80;

  async function handleSave() {
    setSaving(true);
    try {
      const current = schedule ?? { enabled: false, dayOfMonth: 1, emailReplyTo: null, includedOrgIds: null };
      const res = await resilientFetch(
        `/api/lab-orgs/${encodeURIComponent(orgId)}/statement-schedule`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: (current as any).enabled ?? false,
            dayOfMonth: (current as any).dayOfMonth ?? 1,
            emailSubject: subject.trim() || null,
            emailBody: body.trim() || null,
            emailReplyTo: (current as any).emailReplyTo ?? null,
            includedOrgIds: (current as any).includedOrgIds ?? null,
          }),
        }
      );
      if (res.ok) {
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert("Saved", "Default email template updated.");
        onClose();
      } else {
        const data = await res.json();
        Alert.alert("Error", data?.error || data?.message || "Failed to save");
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: themeColors.background }}>
        <View style={{
          paddingTop,
          paddingHorizontal: 20,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: themeColors.border,
          backgroundColor: themeColors.surface,
          flexDirection: "row",
          alignItems: "center",
        }}>
          <Text style={{ flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", color: themeColors.text }}>
            Statement Defaults
          </Text>
          <Pressable onPress={onClose} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="close" size={22} color={themeColors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, marginBottom: 20, lineHeight: 20 }}>
            This template is used for auto-send and as the default when generating manual batches. You can override it per-batch in the wizard.
          </Text>

          <View style={{ gap: 16 }}>
            <View>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: themeColors.textSecondary, marginBottom: 8 }}>
                EMAIL SUBJECT
              </Text>
              <TextInput
                value={subject}
                onChangeText={setSubject}
                placeholder={DEFAULT_SUBJECT}
                placeholderTextColor={themeColors.textSecondary}
                style={{
                  backgroundColor: themeColors.surface,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: themeColors.border,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 14,
                  fontFamily: "Inter_400Regular",
                  color: themeColors.text,
                }}
              />
            </View>

            <View>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: themeColors.textSecondary, marginBottom: 8 }}>
                EMAIL BODY
              </Text>
              <TextInput
                value={body}
                onChangeText={setBody}
                placeholder={DEFAULT_BODY}
                placeholderTextColor={themeColors.textSecondary}
                multiline
                numberOfLines={8}
                style={{
                  backgroundColor: themeColors.surface,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: themeColors.border,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 14,
                  fontFamily: "Inter_400Regular",
                  color: themeColors.text,
                  minHeight: 180,
                  textAlignVertical: "top",
                }}
              />
            </View>

            <View style={{ backgroundColor: Colors.light.tintLight, borderRadius: 12, padding: 14 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.light.tint, marginBottom: 8 }}>
                AVAILABLE PLACEHOLDERS
              </Text>
              {[
                ["{{practiceName}}", "Name of the practice"],
                ["{{openBalance}}", "Current open balance"],
                ["{{periodLabel}}", "Statement period (e.g. May 2026)"],
                ["{{labName}}", "Your lab name"],
                ["{{totalBilled}}", "Total billed amount"],
              ].map(([placeholder, desc]) => (
                <View key={placeholder} style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.tint, minWidth: 160 }}>{placeholder}</Text>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: themeColors.textSecondary, flex: 1 }}>{desc}</Text>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>

        <View style={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Platform.OS === "web" ? 20 : insets.bottom + 12,
          borderTopWidth: 1,
          borderTopColor: themeColors.border,
          backgroundColor: themeColors.surface,
          gap: 10,
        }}>
          <Pressable
            onPress={handleSave}
            disabled={saving}
            style={({ pressed }) => ({
              backgroundColor: Colors.light.tint,
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: "center" as const,
              flexDirection: "row" as const,
              justifyContent: "center" as const,
              gap: 8,
              opacity: pressed || saving ? 0.85 : 1,
            })}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Save Defaults</Text>
              </>
            )}
          </Pressable>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => ({
              borderRadius: 14,
              paddingVertical: 14,
              alignItems: "center" as const,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontSize: 15, fontFamily: "Inter_500Medium", color: themeColors.textSecondary }}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ─── Helper components & utilities ───────────────────────────────────────────

function SummaryRow({ label, value }: { label: string; value: string }) {
  const { colors: themeColors } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: themeColors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: themeColors.text, maxWidth: "60%", textAlign: "right" }}>{value}</Text>
    </View>
  );
}

function StatusChip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color }}>{label}</Text>
    </View>
  );
}

function ResultCard({ count, label, color, bg }: { count: number; label: string; color: string; bg: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: 12, padding: 14, alignItems: "center" }}>
      <Text style={{ fontSize: 24, fontFamily: "Inter_700Bold", color }}>{count}</Text>
      <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "sent": return "Sent";
    case "failed": return "Failed";
    case "skipped_no_email": return "Skipped";
    case "skipped_opted_out": return "Opted out";
    default: return status;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "sent": return "#059669";
    case "failed": return "#DC2626";
    case "skipped_no_email":
    case "skipped_opted_out": return "#D97706";
    default: return "#6B7280";
  }
}

function statusBg(status: string): string {
  switch (status) {
    case "sent": return "#D1FAE5";
    case "failed": return "#FEE2E2";
    case "skipped_no_email":
    case "skipped_opted_out": return "#FEF3C7";
    default: return "#F3F4F6";
  }
}

function statusIcon(status: string): "checkmark-circle" | "alert-circle" | "remove-circle" | "ellipse-outline" {
  switch (status) {
    case "sent": return "checkmark-circle";
    case "failed": return "alert-circle";
    case "skipped_no_email":
    case "skipped_opted_out": return "remove-circle";
    default: return "ellipse-outline";
  }
}

const SCOPE_OPTIONS: { value: InvoiceScope; label: string; description: string }[] = [
  { value: "open", label: "Open invoices only", description: "Includes all unpaid invoices" },
  { value: "open_overdue_90", label: "Open (aging highlighted)", description: "Overdue balances are visually highlighted in the PDF" },
  { value: "all", label: "All invoices", description: "Includes paid, void, and open invoices" },
];
