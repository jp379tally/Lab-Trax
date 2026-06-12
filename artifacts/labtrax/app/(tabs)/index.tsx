import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useCases, type CanonicalCase } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  peekSharedFiles,
  popSharedFiles,
  subscribeSharedFileInbox,
  type InboxEntry,
} from "@/lib/shared-file-inbox";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";

// ── Station labels (mirrors STATUS_OPTIONS in case/[id].tsx) ────────────────
const CASE_STATIONS: { value: string; label: string }[] = [
  { value: "received", label: "Received" },
  { value: "in_design", label: "In Design" },
  { value: "scan", label: "Scan" },
  { value: "in_milling", label: "In Milling" },
  { value: "post_mill", label: "Post Mill" },
  { value: "sintering_furnace", label: "Sintering Furnace" },
  { value: "model_room", label: "Model Room" },
  { value: "in_porcelain", label: "Porcelain" },
  { value: "qc", label: "Quality Check" },
  { value: "complete", label: "Complete" },
  { value: "shipped", label: "Shipping" },
  { value: "on_hold", label: "On Hold" },
  { value: "delivered", label: "Delivered" },
  { value: "remake", label: "Remake" },
];

type DueFilter = "all" | "today" | "tomorrow" | "custom";

// ── Helpers ─────────────────────────────────────────────────────────────────
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

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Parse "M/D/YYYY", "MM/DD/YYYY", or "YYYY-MM-DD". Returns null on failure. */
function parseInputDate(text: string): Date | null {
  const t = text.trim();
  if (!t) return null;
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const d = new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function statusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending"))
    return "intake";
  return "progress";
}

// ── Main screen ──────────────────────────────────────────────────────────────
export default function CasesListScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ── Search
  const [query, setQuery] = useState("");

  // ── Due-date filter
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [customFrom, setCustomFrom] = useState<Date | null>(null);
  const [customTo, setCustomTo] = useState<Date | null>(null);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [customError, setCustomError] = useState("");

  // ── Location filter
  const [locationFilter, setLocationFilter] = useState<string>("all");
  const [showLocationModal, setShowLocationModal] = useState(false);

  // ── Share-intent inbox
  const [pendingShared, setPendingShared] = useState<InboxEntry[]>([]);

  const casesQuery = useCases();
  const cases = casesQuery.data ?? [];

  const refreshShared = useCallback(() => {
    peekSharedFiles()
      .then(setPendingShared)
      .catch(() => setPendingShared([]));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshShared();
    }, [refreshShared]),
  );

  useEffect(() => {
    const unsubscribe = subscribeSharedFileInbox(refreshShared);
    return unsubscribe;
  }, [refreshShared]);

  async function dismissShared() {
    try {
      await popSharedFiles();
    } catch {
      // ignore — clearing the local inbox is best-effort
    }
    setPendingShared([]);
  }

  // ── Filtering ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = cases;

    // Text search
    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter((c) => {
        const haystack = [patientName(c), c.doctorName ?? "", c.caseNumber ?? ""]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    // Due-date filter
    if (dueFilter !== "all") {
      const today = new Date();
      const todayStart = startOfDay(today);
      const todayEnd = endOfDay(today);
      const tomorrowStart = startOfDay(addDays(today, 1));
      const tomorrowEnd = endOfDay(addDays(today, 1));

      result = result.filter((c) => {
        if (!c.dueDate) return false;
        const d = new Date(c.dueDate);
        if (Number.isNaN(d.getTime())) return false;
        if (dueFilter === "today") return d >= todayStart && d <= todayEnd;
        if (dueFilter === "tomorrow") return d >= tomorrowStart && d <= tomorrowEnd;
        if (dueFilter === "custom") {
          if (customFrom && d < startOfDay(customFrom)) return false;
          if (customTo && d > endOfDay(customTo)) return false;
          return true;
        }
        return true;
      });
    }

    // Location filter
    if (locationFilter !== "all") {
      result = result.filter(
        (c) => (c.status ?? "").toLowerCase() === locationFilter,
      );
    }

    return result;
  }, [cases, query, dueFilter, customFrom, customTo, locationFilter]);

  // ── Custom date modal actions ─────────────────────────────────────────────
  function openCustomModal() {
    setDraftFrom(customFrom ? customFrom.toLocaleDateString("en-US") : "");
    setDraftTo(customTo ? customTo.toLocaleDateString("en-US") : "");
    setCustomError("");
    setShowCustomModal(true);
  }

  function applyCustom() {
    const from = parseInputDate(draftFrom);
    const to = parseInputDate(draftTo);

    if (draftFrom && !from) {
      setCustomError('Invalid "From" date \u2014 use M/D/YYYY format.');
      return;
    }
    if (draftTo && !to) {
      setCustomError('Invalid "To" date \u2014 use M/D/YYYY format.');
      return;
    }
    if (from && to && from > to) {
      setCustomError('"From" must be on or before "To".');
      return;
    }

    setCustomFrom(from);
    setCustomTo(to);
    setDueFilter("custom");
    setCustomError("");
    setShowCustomModal(false);
  }

  function clearCustom() {
    setCustomFrom(null);
    setCustomTo(null);
    setDueFilter("all");
    setDraftFrom("");
    setDraftTo("");
    setCustomError("");
    setShowCustomModal(false);
  }

  // ── Due-chip label for "Custom" ──────────────────────────────────────────
  function customChipLabel(): string {
    if (dueFilter !== "custom" || (!customFrom && !customTo)) return "Custom…";
    const parts: string[] = [];
    if (customFrom) parts.push(formatShort(customFrom));
    if (customTo) parts.push(formatShort(customTo));
    return parts.join(" – ");
  }

  // ── Location chip label ──────────────────────────────────────────────────
  const locationLabel =
    locationFilter === "all"
      ? "Location"
      : (CASE_STATIONS.find((s) => s.value === locationFilter)?.label ?? titleCase(locationFilter));

  const activeFilters =
    dueFilter !== "all" || locationFilter !== "all";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Cases</Text>
          <Text style={styles.subtitle}>
            {casesQuery.isLoading
              ? "Loading…"
              : `${filtered.length} case${filtered.length === 1 ? "" : "s"}${activeFilters ? " (filtered)" : ""}`}
          </Text>
        </View>
        <Pressable
          style={styles.newBtn}
          onPress={() => router.push("/new-case" as never)}
          testID="new-case-button"
        >
          <Ionicons name="add" size={18} color={colors.textInverse} />
          <Text style={styles.newBtnText}>New</Text>
        </Pressable>
      </View>

      {/* Share-intent banner */}
      {pendingShared.length > 0 ? (
        <Pressable style={styles.shareBanner} onPress={dismissShared} testID="share-banner">
          <Ionicons name="cloud-upload-outline" size={18} color={colors.tint} />
          <Text style={styles.shareBannerText}>
            {pendingShared.length} file{pendingShared.length === 1 ? "" : "s"} ready — open a case to attach.
          </Text>
          <Ionicons name="close" size={16} color={colors.textTertiary} />
        </Pressable>
      ) : null}

      {/* Search bar */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search patient, doctor, or case #"
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="cases-search"
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {/* ── Filter row ── */}
      <View style={styles.filterRow}>
        {/* Due-date chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipScroll}
        >
          {(["all", "today", "tomorrow"] as const).map((f) => {
            const active = dueFilter === f;
            const label = f === "all" ? "All dates" : f === "today" ? "Today" : "Tomorrow";
            return (
              <Pressable
                key={f}
                style={[styles.chip, active && { backgroundColor: colors.tint, borderColor: colors.tint }]}
                onPress={() => setDueFilter(f)}
              >
                <Text style={[styles.chipText, active && { color: colors.textInverse }]}>{label}</Text>
              </Pressable>
            );
          })}

          {/* Custom chip */}
          <Pressable
            style={[
              styles.chip,
              dueFilter === "custom" && { backgroundColor: colors.tint, borderColor: colors.tint },
            ]}
            onPress={openCustomModal}
          >
            {dueFilter !== "custom" && (
              <Ionicons name="calendar-outline" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
            )}
            <Text
              style={[
                styles.chipText,
                dueFilter === "custom" && { color: colors.textInverse },
              ]}
            >
              {customChipLabel()}
            </Text>
            {dueFilter === "custom" && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); clearCustom(); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.textInverse} />
              </Pressable>
            )}
          </Pressable>

          {/* Divider */}
          <View style={styles.chipDivider} />

          {/* Location chip */}
          <Pressable
            style={[
              styles.chip,
              locationFilter !== "all" && { backgroundColor: colors.violet + "22", borderColor: colors.violet },
            ]}
            onPress={() => setShowLocationModal(true)}
          >
            <Ionicons
              name="location-outline"
              size={13}
              color={locationFilter !== "all" ? colors.violet : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                locationFilter !== "all" && { color: colors.violet },
              ]}
            >
              {locationLabel}
            </Text>
            <Ionicons
              name="chevron-down"
              size={12}
              color={locationFilter !== "all" ? colors.violet : colors.textTertiary}
              style={{ marginLeft: 2 }}
            />
            {locationFilter !== "all" && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); setLocationFilter("all"); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.violet} />
              </Pressable>
            )}
          </Pressable>
        </ScrollView>
      </View>

      {/* Case list */}
      {casesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : casesQuery.isError ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Couldn't load cases</Text>
          <Pressable style={styles.retryBtn} onPress={() => casesQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/case/${item.id}` as never)}
              testID={`case-row-${item.id}`}
            >
              <Card style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {patientName(item)}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {item.caseNumber ? `#${item.caseNumber}` : "No case #"}
                    {item.doctorName ? `  ·  ${item.doctorName}` : ""}
                  </Text>
                  <Text style={styles.rowDue}>Due {formatDate(item.dueDate)}</Text>
                </View>
                <View style={styles.rowRight}>
                  <StatusBadge label={titleCase(item.status ?? "—")} variant={statusVariant(item.status)} />
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                </View>
              </Card>
            </Pressable>
          )}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={casesQuery.isFetching}
              onRefresh={() => casesQuery.refetch()}
              tintColor={colors.tint}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="file-tray-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>
                {query || activeFilters ? "No matching cases" : "No cases yet"}
              </Text>
              <Text style={styles.emptyBody}>
                {query || activeFilters
                  ? "Try adjusting your search or filters."
                  : "Cases will appear here once created."}
              </Text>
            </View>
          }
        />
      )}

      {/* ══ Custom Date Range Modal ══════════════════════════════════════════ */}
      <Modal
        visible={showCustomModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCustomModal(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowCustomModal(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "position" : "height"}
          style={styles.modalSheet}
        >
          <View style={[styles.sheetInner, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Custom date range</Text>
            <Text style={styles.sheetHint}>Enter dates in M/D/YYYY format</Text>

            {/* From */}
            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>From</Text>
              <TextInput
                style={[styles.dateInput, { color: colors.text, borderColor: colors.border }]}
                placeholder="M/D/YYYY"
                placeholderTextColor={colors.textTertiary}
                value={draftFrom}
                onChangeText={(t) => { setDraftFrom(t); setCustomError(""); }}
                keyboardType="numbers-and-punctuation"
                returnKeyType="next"
                autoCorrect={false}
              />
            </View>

            {/* To */}
            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>To</Text>
              <TextInput
                style={[styles.dateInput, { color: colors.text, borderColor: colors.border }]}
                placeholder="M/D/YYYY  (leave blank for open end)"
                placeholderTextColor={colors.textTertiary}
                value={draftTo}
                onChangeText={(t) => { setDraftTo(t); setCustomError(""); }}
                keyboardType="numbers-and-punctuation"
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
                autoCorrect={false}
              />
            </View>

            {customError ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{customError}</Text>
            ) : null}

            <View style={styles.sheetActions}>
              <Pressable style={styles.clearBtn} onPress={clearCustom}>
                <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
              </Pressable>
              <Pressable style={[styles.applyBtn, { backgroundColor: colors.tint }]} onPress={applyCustom}>
                <Text style={[styles.applyBtnText, { color: colors.textInverse }]}>Apply</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ══ Location Picker Modal ════════════════════════════════════════════ */}
      <Modal
        visible={showLocationModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLocationModal(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowLocationModal(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>

        <View style={[styles.modalSheet, styles.locationSheet]}>
          <View style={[styles.sheetInner, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Filter by location</Text>

            <ScrollView style={styles.locationList} bounces={false}>
              {/* All locations */}
              <Pressable
                style={styles.locationRow}
                onPress={() => { setLocationFilter("all"); setShowLocationModal(false); }}
              >
                <Text
                  style={[
                    styles.locationLabel,
                    { color: locationFilter === "all" ? colors.tint : colors.text },
                  ]}
                >
                  All locations
                </Text>
                {locationFilter === "all" && (
                  <Ionicons name="checkmark" size={18} color={colors.tint} />
                )}
              </Pressable>

              <View style={[styles.locationDivider, { backgroundColor: colors.border }]} />

              {CASE_STATIONS.map((station) => {
                const active = locationFilter === station.value;
                return (
                  <Pressable
                    key={station.value}
                    style={styles.locationRow}
                    onPress={() => { setLocationFilter(station.value); setShowLocationModal(false); }}
                  >
                    <Text style={[styles.locationLabel, { color: active ? colors.tint : colors.text }]}>
                      {station.label}
                    </Text>
                    {active && <Ionicons name="checkmark" size={18} color={colors.tint} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
      gap: Spacing.md,
    },
    headerText: { flex: 1 },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    newBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    newBtnText: { ...Typography.bodySemibold, color: c.textInverse },
    shareBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    shareBannerText: { flex: 1, ...Typography.caption, color: c.textSecondary },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
      marginBottom: Spacing.xs,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 0 },

    // Filter row
    filterRow: { marginBottom: Spacing.xs },
    chipScroll: {
      paddingHorizontal: Spacing.lg,
      gap: Spacing.xs,
      alignItems: "center",
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: 6,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    chipText: { ...Typography.captionSemibold, color: c.textSecondary },
    chipDivider: {
      width: 1,
      height: 20,
      backgroundColor: c.border,
      marginHorizontal: Spacing.xs,
    },

    // List
    listContent: { padding: Spacing.lg, paddingTop: Spacing.xs, gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowDue: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    rowRight: { alignItems: "flex-end", gap: Spacing.xs },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
      minHeight: 280,
    },
    emptyTitle: { ...Typography.h3, color: c.text },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: c.textInverse },

    // Modals (shared)
    modalBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    modalSheet: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
    },
    locationSheet: {
      maxHeight: "75%",
    },
    sheetInner: {
      backgroundColor: c.background,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      gap: Spacing.md,
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: "center",
      marginBottom: Spacing.xs,
    },
    sheetTitle: { ...Typography.h2, color: c.text },
    sheetHint: { ...Typography.caption, color: c.textSecondary, marginTop: -Spacing.sm },

    // Custom date modal
    dateRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    dateLabel: { ...Typography.bodySemibold, color: c.text, width: 44 },
    dateInput: {
      flex: 1,
      ...Typography.body,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      backgroundColor: c.surfaceAlt,
    },
    errorText: { ...Typography.caption, marginTop: -Spacing.xs },
    sheetActions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    clearBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    clearBtnText: { ...Typography.bodySemibold },
    applyBtn: {
      flex: 2,
      alignItems: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
    },
    applyBtnText: { ...Typography.bodySemibold },

    // Location modal
    locationList: { maxHeight: 380 },
    locationRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.md,
    },
    locationLabel: { ...Typography.body },
    locationDivider: { height: 1, marginBottom: Spacing.xs },
  });
}
