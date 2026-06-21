import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  LayoutAnimation,
  Platform,
  UIManager,
  Image,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useCases, type CanonicalCase } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { LocateCaseSheet } from "@/components/LocateCaseSheet";
import { useAuth } from "@/lib/auth-context";
import { useMe } from "@/lib/auth-me";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const PREFS_KEY = "labtrax_dashboard_prefs_v1";
type SectionId = "due-soon" | "recent";
type SectionOrder = [SectionId, SectionId];

interface DashboardPrefs {
  dueSoonOpen: boolean;
  recentOpen: boolean;
  sectionOrder: SectionOrder;
}

const DEFAULT_PREFS: DashboardPrefs = {
  dueSoonOpen: true,
  recentOpen: true,
  sectionOrder: ["due-soon", "recent"],
};

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function patientName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function getGreeting(firstName?: string): string {
  const hour = new Date().getHours();
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const name = firstName?.trim();
  return name ? `Good ${period}, ${name}` : "Welcome";
}

function isClosedCase(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return (
    s.includes("complete") ||
    s.includes("delivered") ||
    s.includes("done") ||
    s.includes("cancel") ||
    s.includes("void")
  );
}

function caseStatusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending")) return "intake";
  return "progress";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ── Profile data ─────────────────────────────────────────────────────────
  const { profilePicUri } = useAuth();
  const me = useMe();
  const meUser = me.data?.user as any;
  const memberships = me.data?.memberships ?? [];

  const fullName = [meUser?.firstName, meUser?.lastName].filter(Boolean).join(" ");
  const displayName = fullName || meUser?.username || "";
  const avatarLetter = (displayName || "?").charAt(0).toUpperCase();
  const displayRole = meUser?.role ?? "";

  const WORK_STATUS_COLORS: Record<string, string> = {
    available: "#10B981",
    break: "#F59E0B",
    lunch: "#F97316",
    out_of_office: "#94A3B8",
  };
  const workStatusColor = meUser?.workStatus ? (WORK_STATUS_COLORS[meUser.workStatus] ?? null) : null;
  const labMembership = memberships.find(
    (m: any) => m.status === "active" && (m.organization?.type ?? "").toLowerCase() === "lab",
  );
  const labName: string = labMembership?.organization?.name ?? meUser?.practiceName ?? "";

  // ── Prefs (persisted) ────────────────────────────────────────────────────
  const prefsLoadedRef = useRef(false);
  const [dueSoonOpen, setDueSoonOpen] = useState(DEFAULT_PREFS.dueSoonOpen);
  const [recentOpen, setRecentOpen] = useState(DEFAULT_PREFS.recentOpen);
  const [sectionOrder, setSectionOrder] = useState<SectionOrder>(DEFAULT_PREFS.sectionOrder);

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY)
      .then((raw) => {
        if (raw) {
          try {
            const saved: Partial<DashboardPrefs> = JSON.parse(raw);
            if (typeof saved.dueSoonOpen === "boolean") setDueSoonOpen(saved.dueSoonOpen);
            if (typeof saved.recentOpen === "boolean") setRecentOpen(saved.recentOpen);
            if (Array.isArray(saved.sectionOrder) && saved.sectionOrder.length === 2) {
              setSectionOrder(saved.sectionOrder as SectionOrder);
            }
          } catch {}
        }
      })
      .catch(() => {})
      .finally(() => {
        prefsLoadedRef.current = true;
      });
  }, []);

  function savePrefs(updates: Partial<DashboardPrefs>) {
    if (!prefsLoadedRef.current) return;
    const next: DashboardPrefs = {
      dueSoonOpen,
      recentOpen,
      sectionOrder,
      ...updates,
    };
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
  }

  function toggleDueSoon() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDueSoonOpen((v) => {
      savePrefs({ dueSoonOpen: !v });
      return !v;
    });
  }

  function toggleRecent() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRecentOpen((v) => {
      savePrefs({ recentOpen: !v });
      return !v;
    });
  }

  function swapSections() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSectionOrder((current) => {
      const next: SectionOrder =
        current[0] === "due-soon"
          ? ["recent", "due-soon"]
          : ["due-soon", "recent"];
      savePrefs({ sectionOrder: next });
      return next;
    });
  }

  // ── Cases data ───────────────────────────────────────────────────────────
  const casesQuery = useCases();
  const cases = casesQuery.data ?? [];

  const dueSoon = useMemo(() => {
    return cases
      .filter((c) => {
        if (isClosedCase(c.status)) return false;
        const d = daysUntil(c.dueDate);
        return d != null && d <= 7;
      })
      .sort((a, b) => {
        const da = daysUntil(a.dueDate) ?? 9999;
        const dbv = daysUntil(b.dueDate) ?? 9999;
        return da - dbv;
      });
  }, [cases]);

  const recentCases = useMemo(() => {
    return [...cases]
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 6);
  }, [cases]);

  // ── Long-press locate ────────────────────────────────────────────────────
  const longPressActiveRef = useRef(false);
  const [locatingCase, setLocatingCase] = useState<CanonicalCase | null>(null);
  const [locateSuccessId, setLocateSuccessId] = useState<string | null>(null);

  function handleLongPress(c: CanonicalCase) {
    longPressActiveRef.current = true;
    setLocatingCase(c);
  }

  function dismissLocate() {
    longPressActiveRef.current = false;
    setLocatingCase(null);
  }

  function handleLocated(caseId: string) {
    setLocateSuccessId(caseId);
    setTimeout(() => setLocateSuccessId(null), 2500);
  }

  // ── Case row renderer ────────────────────────────────────────────────────
  function renderCaseRow(c: CanonicalCase, showDue = false) {
    const d = daysUntil(c.dueDate);
    const overdue = d != null && d < 0;
    const locatedSuccess = locateSuccessId === c.id;
    return (
      <Card
        key={c.id}
        style={styles.row}
        onPress={() => {
          if (longPressActiveRef.current) {
            longPressActiveRef.current = false;
            return;
          }
          router.push(`/case/${c.id}` as never);
        }}
        onLongPress={() => handleLongPress(c)}
        delayLongPress={400}
      >
        <View style={styles.rowMain}>
          <Text style={styles.rowName} numberOfLines={1}>
            {patientName(c)}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {c.caseNumber ? `#${c.caseNumber}` : "No case #"}
            {c.doctorName ? `  ·  ${c.doctorName}` : ""}
          </Text>
          {showDue && c.dueDate ? (
            <Text style={[styles.rowDue, overdue && { color: colors.error }]}>
              Due {formatDate(c.dueDate)}
              {d != null
                ? `  ·  ${overdue ? `${Math.abs(d)}d overdue` : d === 0 ? "today" : `in ${d}d`}`
                : ""}
            </Text>
          ) : (
            <Text style={styles.rowDue}>
              {c.createdAt ? `Added ${formatDate(c.createdAt)}` : ""}
            </Text>
          )}
        </View>
        <View style={styles.rowRight}>
          <StatusBadge
            label={titleCase(c.status ?? "—")}
            variant={caseStatusVariant(c.status)}
            size="sm"
          />
          {locatedSuccess ? (
            <View style={styles.locatedBadge}>
              <Ionicons name="checkmark-circle" size={14} color={colors.tint} />
              <Text style={[styles.locatedBadgeText, { color: colors.tint }]}>Located</Text>
            </View>
          ) : null}
        </View>
      </Card>
    );
  }

  // ── Section renderers ────────────────────────────────────────────────────
  function renderDueSoon() {
    return (
      <View key="due-soon" style={styles.section}>
        <Pressable style={styles.sectionHeader} onPress={toggleDueSoon} hitSlop={8}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>Due soon</Text>
            {dueSoon.length > 0 && (
              <View style={[styles.countBadge, { backgroundColor: colors.warningStrong + "1A" }]}>
                <Text style={[styles.countBadgeText, { color: colors.warningStrong }]}>
                  {dueSoon.length}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.sectionActions}>
            <Pressable onPress={() => router.push("/(tabs)" as never)} hitSlop={8}>
              <Text style={styles.sectionLink}>All cases</Text>
            </Pressable>
            <Ionicons
              name={dueSoonOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>

        {dueSoonOpen && (
          dueSoon.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Ionicons name="checkmark-circle-outline" size={28} color={colors.success} />
              <Text style={styles.emptyText}>Nothing due in the next 7 days.</Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {dueSoon.slice(0, 6).map((c) => renderCaseRow(c, true))}
            </View>
          )
        )}
      </View>
    );
  }

  function renderRecentCases() {
    return (
      <View key="recent" style={styles.section}>
        <Pressable style={styles.sectionHeader} onPress={toggleRecent} hitSlop={8}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>Recent cases</Text>
            {recentCases.length > 0 && (
              <View style={[styles.countBadge, { backgroundColor: colors.tint + "1A" }]}>
                <Text style={[styles.countBadgeText, { color: colors.tint }]}>
                  {recentCases.length}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.sectionActions}>
            <Pressable onPress={() => router.push("/(tabs)" as never)} hitSlop={8}>
              <Text style={styles.sectionLink}>All cases</Text>
            </Pressable>
            <Ionicons
              name={recentOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>

        {recentOpen && (
          recentCases.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Ionicons name="folder-open-outline" size={28} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No cases yet.</Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {recentCases.map((c) => renderCaseRow(c, false))}
            </View>
          )
        )}
      </View>
    );
  }

  const sectionRenderers: Record<SectionId, () => React.ReactNode> = {
    "due-soon": renderDueSoon,
    "recent": renderRecentCases,
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* ── Profile header ─────────────────────────────────────────────── */}
      <Pressable
        style={styles.profileHeader}
        onPress={() => router.push("/settings/profile" as never)}
        testID="dashboard-profile-header"
      >
        <View style={styles.profileAvatarContainer}>
          {profilePicUri ? (
            <Image source={{ uri: profilePicUri }} style={styles.profileAvatar} />
          ) : (
            <View style={[styles.profileAvatarFallback, { backgroundColor: colors.tint + "20" }]}>
              <Text style={[styles.profileAvatarLetter, { color: colors.tint }]}>{avatarLetter}</Text>
            </View>
          )}
          {workStatusColor ? (
            <View style={[styles.profileStatusDot, { backgroundColor: workStatusColor }]} />
          ) : null}
        </View>
        {displayName ? (
          <Text style={[styles.profileName, { color: colors.text }]} numberOfLines={1}>
            {displayName}
          </Text>
        ) : null}
        {labName ? (
          <Text style={[styles.profileLab, { color: colors.textSecondary }]} numberOfLines={1}>
            {labName}
          </Text>
        ) : null}
        {displayRole ? (
          <Text style={[styles.profileRole, { color: colors.textTertiary }]} numberOfLines={1}>
            <Text style={{ textTransform: "capitalize" }}>{displayRole}</Text>
          </Text>
        ) : null}
      </Pressable>

      <View style={styles.greetingRow}>
        <Text style={styles.title}>{getGreeting(meUser?.firstName)}</Text>
        <Text style={styles.subtitle}>Your lab at a glance</Text>
      </View>

      <View style={styles.header}>
        <Pressable
          style={styles.maynardBtn}
          onPress={() => router.push("/ai-assistant" as never)}
          testID="dashboard-ai-assistant-btn"
        >
          <Ionicons name="sparkles" size={18} color="#fff" />
          <Text style={styles.actionBtnText}>Maynard</Text>
        </Pressable>
        <View style={styles.headerActions}>
          <Pressable style={styles.arrangeBtn} onPress={swapSections} hitSlop={8}>
            <Ionicons name="swap-vertical-outline" size={18} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.arrangeBtn}
            onPress={() => router.push("/batch-locate" as never)}
            testID="dashboard-batch-locate-btn"
            hitSlop={8}
          >
            <Ionicons name="layers-outline" size={18} color={colors.tint} />
          </Pressable>
        </View>
        <Pressable
          style={styles.scanRxBtn}
          onPress={() => router.push("/ai-reader/capture?new=1" as never)}
          testID="dashboard-ai-reader-btn"
        >
          <Ionicons name="sparkles" size={18} color="#fff" />
          <Text style={styles.actionBtnText}>Scan Rx</Text>
        </Pressable>
      </View>

      {casesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={casesQuery.isFetching}
              onRefresh={() => casesQuery.refetch()}
              tintColor={colors.tint}
            />
          }
        >
          {sectionOrder.map((id) => sectionRenderers[id]())}
        </ScrollView>
      )}

      <LocateCaseSheet
        locatingCase={locatingCase}
        onDismiss={dismissLocate}
        onLocated={handleLocated}
      />
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    profileHeader: {
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
      paddingBottom: Spacing.sm,
      gap: 4,
    },
    profileAvatarContainer: {
      position: "relative",
      width: 60,
      height: 60,
      marginBottom: Spacing.xs,
    },
    profileAvatar: {
      width: 60,
      height: 60,
      borderRadius: 30,
    },
    profileAvatarFallback: {
      width: 60,
      height: 60,
      borderRadius: 30,
      alignItems: "center",
      justifyContent: "center",
    },
    profileStatusDot: {
      position: "absolute",
      bottom: 1,
      right: 1,
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: c.backgroundSolid,
    },
    profileAvatarLetter: { ...Typography.h2 },
    profileName: { ...Typography.h3, textAlign: "center" },
    profileLab: { ...Typography.body, textAlign: "center" },
    profileRole: { ...Typography.caption, textAlign: "center" },
    greetingRow: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xs,
      paddingBottom: 2,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xs,
      paddingBottom: Spacing.xs,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    maynardBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      backgroundColor: c.tint,
      paddingHorizontal: Spacing.md,
      paddingVertical: 10,
      borderRadius: Radius.md,
      minHeight: 44,
    },
    scanRxBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      backgroundColor: c.tint,
      paddingHorizontal: Spacing.md,
      paddingVertical: 10,
      borderRadius: Radius.md,
      minHeight: 44,
    },
    actionBtnText: { ...Typography.bodySemibold, color: "#fff" },
    arrangeBtn: {
      width: 36,
      height: 36,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, minHeight: 280 },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.lg },
    section: { gap: Spacing.md },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sectionTitle: { ...Typography.h2, color: c.text },
    countBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: Radius.full ?? 99,
    },
    countBadgeText: { ...Typography.captionSemibold },
    sectionActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sectionLink: { ...Typography.captionSemibold, color: c.tint },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowDue: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    rowRight: { alignItems: "flex-end", gap: Spacing.xs },
    emptyCard: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    emptyText: { ...Typography.body, color: c.textSecondary, flex: 1 },
    locatedBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    locatedBadgeText: { ...Typography.captionSemibold },
  });
}
