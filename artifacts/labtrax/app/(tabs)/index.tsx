import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import {
  useCases,
  type CanonicalCase,
} from "@workspace/api-client-react";
import { LocateCaseSheet } from "@/components/LocateCaseSheet";
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
import { CASE_STATIONS } from "@/lib/case-stations";
import { resilientFetch } from "@/lib/query-client";
import { extractLookupCase } from "@/lib/barcode-lookup";
import { pickBestBarcode, guideBoxFromLayout } from "@/lib/barcode-guide-box";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";

type DueFilter = "all" | "today" | "tomorrow" | "custom";

interface ScanMatch {
  barcode: string;
  patientName: string;
  caseNumber: string | null;
  caseId: string;
}

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

  // ── Auth / membership — used to resolve lab org ID for barcode scan
  const meQuery = useMe();

  // ── Barcode scan modal
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanStep, setScanStep] = useState<"scan" | "manual">("scan");
  const [manualBarcode, setManualBarcode] = useState("");
  const [scanSearching, setScanSearching] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanScanned, setScanScanned] = useState(false);
  const [scanMatch, setScanMatch] = useState<ScanMatch | null>(null);
  const [scanTarget, setScanTarget] = useState<BarcodeScanningResult | null>(null);
  const cameraViewSize = useRef<{ width: number; height: number } | null>(null);
  // Ref mirrors scanScanned so timer callbacks read the live value without stale closures.
  const scanLockedRef = useRef(false);
  // Accumulate all barcodes detected in a ~120ms frame window so pickBestBarcode
  // can choose the in-box barcode closest to center across the whole frame.
  const barcodeAccumRef = useRef<BarcodeScanningResult[]>([]);
  const barcodeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  function openScanModal() {
    setScanStep("scan");
    setManualBarcode("");
    setScanError(null);
    setScanScanned(false);
    scanLockedRef.current = false;
    setScanMatch(null);
    setScanTarget(null);
    barcodeAccumRef.current = [];
    if (barcodeDebounceRef.current) {
      clearTimeout(barcodeDebounceRef.current);
      barcodeDebounceRef.current = null;
    }
    setShowScanModal(true);
  }

  function closeScanModal() {
    setShowScanModal(false);
    setScanError(null);
    setScanScanned(false);
    scanLockedRef.current = false;
    setScanMatch(null);
    setScanTarget(null);
    setManualBarcode("");
    barcodeAccumRef.current = [];
    if (barcodeDebounceRef.current) {
      clearTimeout(barcodeDebounceRef.current);
      barcodeDebounceRef.current = null;
    }
  }

  async function lookupBarcode(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;

    // Resolve lab org ID from the authenticated session (primary source) so
    // the scan works regardless of whether the cases list has loaded any rows.
    // Fall back to the first loaded case's org as a safety net (e.g. multi-lab
    // users whose primary lab differs from the case they're browsing).
    let labOrganizationId =
      primaryLabOrgId(meQuery.data) ??
      (casesQuery.data ?? [])[0]?.labOrganizationId ??
      "";

    // If auth/me hasn't resolved yet (cold open, fast scan), fetch it on
    // demand rather than immediately surfacing "Lab not found."
    if (!labOrganizationId && (meQuery.isLoading || meQuery.isPending)) {
      try {
        const freshMe = await meQuery.refetch();
        labOrganizationId = primaryLabOrgId(freshMe.data) ?? "";
      } catch {
        // ignore — will fall through to the error below
      }
    }

    if (!labOrganizationId) {
      setScanError("Lab not found. Please sign out and sign back in, then try again.");
      setScanSearching(false);
      setScanScanned(false);
      scanLockedRef.current = false;
      return;
    }

    setScanSearching(true);
    setScanError(null);

    try {
      const qs = new URLSearchParams({
        labOrganizationId,
      });
      const res = await resilientFetch(
        `/api/cases/barcode/${encodeURIComponent(trimmed)}?${qs.toString()}`,
      );

      if (res.status === 404) {
        setScanError("No case found for that pan.");
        setScanScanned(false);
        scanLockedRef.current = false;
        setScanTarget(null);
        return;
      }

      if (!res.ok) {
        setScanError("Something went wrong. Please try again.");
        setScanScanned(false);
        scanLockedRef.current = false;
        setScanTarget(null);
        return;
      }

      const body = await res.json();
      const found = extractLookupCase(body);
      const caseId = found?.id;
      if (!caseId) {
        setScanError("No case found for that pan.");
        setScanScanned(false);
        scanLockedRef.current = false;
        setScanTarget(null);
        return;
      }

      const matchPatientName = [
        `${found.patientFirstName ?? ""}`,
        `${found.patientLastName ?? ""}`,
      ]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ") || "Unnamed patient";

      setScanMatch({
        barcode: trimmed,
        patientName: matchPatientName,
        caseNumber: found.caseNumber ?? null,
        caseId,
      });

      setTimeout(() => {
        closeScanModal();
        router.push(`/case/${caseId}` as never);
      }, 900);
    } catch {
      setScanError("Network error. Please try again.");
      setScanScanned(false);
      scanLockedRef.current = false;
      setScanTarget(null);
    } finally {
      setScanSearching(false);
    }
  }

  // Keep a stable ref so the debounce timer always calls the latest lookupBarcode
  // without needing it as a dependency (which would recreate the callback each render).
  const lookupBarcodeRef = useRef(lookupBarcode);
  lookupBarcodeRef.current = lookupBarcode;

  const handleCameraBarcode = useCallback(
    (event: BarcodeScanningResult) => {
      if (scanLockedRef.current || !event.data?.trim()) return;

      // Accumulate all barcodes arriving in this ~120ms scan cycle so
      // pickBestBarcode can compare all in-frame candidates at once.
      barcodeAccumRef.current.push(event);
      if (barcodeDebounceRef.current) clearTimeout(barcodeDebounceRef.current);

      barcodeDebounceRef.current = setTimeout(() => {
        barcodeDebounceRef.current = null;
        if (scanLockedRef.current) {
          barcodeAccumRef.current = [];
          return;
        }

        const candidates = barcodeAccumRef.current.splice(0);
        if (candidates.length === 0) return;

        // Strict gate: reject until the camera view has been laid out.
        const viewSize = cameraViewSize.current;
        if (!viewSize) return;

        const box = guideBoxFromLayout(viewSize.width, viewSize.height, 0.12, 0.28, 0.12, 0.44);
        const best = pickBestBarcode(candidates, box);
        if (!best || !best.data.trim()) return;

        scanLockedRef.current = true;
        setScanScanned(true);
        setScanTarget(best);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        lookupBarcodeRef.current(best.data.trim());
      }, 120);
    },
    [],
  );

  async function handleManualBarcode() {
    const code = manualBarcode.trim();
    if (!code) {
      setScanError("Enter a barcode value first.");
      return;
    }
    await lookupBarcode(code);
  }

  // ── Due-date filter
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [customFrom, setCustomFrom] = useState<Date | null>(null);
  const [customTo, setCustomTo] = useState<Date | null>(null);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [customError, setCustomError] = useState("");

  // ── Barcode quick-filter (exact pan-barcode match)
  const [barcodeFilter, setBarcodeFilter] = useState("");
  const [showBarcodeFilter, setShowBarcodeFilter] = useState(false);

  // ── Location filter (empty array = all locations)
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  const [showLocationModal, setShowLocationModal] = useState(false);
  // Draft selections while the modal is open
  const [locationDraft, setLocationDraft] = useState<string[]>([]);

  // ── Long-press locate (single) + multi-select mode
  // Guard: after a long-press fires, the subsequent pressOut→onPress (on that
  // same card) must not navigate or toggle. Store the ID of the long-pressed
  // item so we only absorb the onPress for that specific card, not others.
  const longPressActiveRef = useRef<string | null>(null);

  const [locatingCase, setLocatingCase] = useState<CanonicalCase | null>(null);
  const [locateSuccessId, setLocateSuccessId] = useState<string | null>(null);

  // Multi-select state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkLocateSheet, setShowBulkLocateSheet] = useState(false);
  const [bulkLocateSuccessIds, setBulkLocateSuccessIds] = useState<Set<string>>(new Set());

  function exitSelectionMode() {
    longPressActiveRef.current = null;
    setSelectionMode(false);
    setSelectedIds(new Set());
    setShowBulkLocateSheet(false);
  }

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      if (next.size === 0) {
        setSelectionMode(false);
      }
      return next;
    });
  }

  function dismissLocate() {
    longPressActiveRef.current = null;
    setLocatingCase(null);
  }

  function handleLocated(caseId: string) {
    setLocateSuccessId(caseId);
    setTimeout(() => setLocateSuccessId(null), 2500);
  }

  function handleBulkLocated(succeededIds: string[], failedIds: string[]) {
    setShowBulkLocateSheet(false);
    if (succeededIds.length > 0) {
      // At least one case moved — exit selection mode and flash badges.
      exitSelectionMode();
      const successSet = new Set(succeededIds);
      setBulkLocateSuccessIds(successSet);
      setTimeout(() => setBulkLocateSuccessIds(new Set()), 2500);
    } else if (failedIds.length > 0) {
      // All PATCHes failed — stay in selection mode so the user can retry
      // without having to re-select their cases.
    }
  }

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
        const haystack = [patientName(c), c.doctorName ?? "", c.caseNumber ?? "", c.casePanBarcode ?? ""]
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
    if (locationFilter.length > 0) {
      result = result.filter(
        (c) => locationFilter.includes((c.status ?? "").toLowerCase()),
      );
    }

    // Barcode quick-filter — exact pan-barcode match
    const bc = barcodeFilter.trim().toLowerCase();
    if (bc) {
      result = result.filter(
        (c) => (c.casePanBarcode ?? "").trim().toLowerCase() === bc,
      );
    }

    return result;
  }, [cases, query, dueFilter, customFrom, customTo, locationFilter, barcodeFilter]);

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
  const locationLabel = useMemo(() => {
    if (locationFilter.length === 0) return "Location";
    if (locationFilter.length === 1) {
      return CASE_STATIONS.find((s) => s.value === locationFilter[0])?.label ?? titleCase(locationFilter[0]);
    }
    return `${locationFilter.length} stations`;
  }, [locationFilter]);

  const activeFilters =
    dueFilter !== "all" || locationFilter.length > 0 || barcodeFilter.trim().length > 0;

  // Derived: the CanonicalCase objects for the currently selected IDs
  const selectedCases = useMemo(
    () => filtered.filter((c) => selectedIds.has(c.id)),
    [filtered, selectedIds]
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header — swaps to selection header when selectionMode is active */}
      {selectionMode ? (
        <View style={styles.header}>
          <Pressable onPress={exitSelectionMode} hitSlop={8} testID="selection-cancel-btn">
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
          <Text style={[styles.title, { flex: 1, marginLeft: Spacing.sm }]}>
            {selectedIds.size} selected
          </Text>
        </View>
      ) : (
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
      )}

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

      {/* Search + barcode scan row */}
      <View style={styles.searchRow}>
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
        <Pressable
          style={styles.scanBtn}
          onPress={openScanModal}
          hitSlop={4}
          testID="cases-scan-barcode"
        >
          <Ionicons name="barcode-outline" size={22} color={colors.tint} />
        </Pressable>
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
              locationFilter.length > 0 && { backgroundColor: colors.violet + "22", borderColor: colors.violet },
            ]}
            onPress={() => {
              setLocationDraft(locationFilter);
              setShowLocationModal(true);
            }}
          >
            <Ionicons
              name="location-outline"
              size={13}
              color={locationFilter.length > 0 ? colors.violet : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                locationFilter.length > 0 && { color: colors.violet },
              ]}
            >
              {locationLabel}
            </Text>
            <Ionicons
              name="chevron-down"
              size={12}
              color={locationFilter.length > 0 ? colors.violet : colors.textTertiary}
              style={{ marginLeft: 2 }}
            />
            {locationFilter.length > 0 && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); setLocationFilter([]); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.violet} />
              </Pressable>
            )}
          </Pressable>

          {/* Divider */}
          <View style={styles.chipDivider} />

          {/* Barcode quick-filter chip */}
          <Pressable
            style={[
              styles.chip,
              (showBarcodeFilter || barcodeFilter.trim().length > 0) && {
                backgroundColor: colors.tint + "22",
                borderColor: colors.tint,
              },
            ]}
            onPress={() => setShowBarcodeFilter((v) => !v)}
            testID="cases-barcode-filter-chip"
          >
            <Ionicons
              name="barcode-outline"
              size={14}
              color={showBarcodeFilter || barcodeFilter.trim().length > 0 ? colors.tint : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                (showBarcodeFilter || barcodeFilter.trim().length > 0) && { color: colors.tint },
              ]}
            >
              {barcodeFilter.trim().length > 0 ? "Barcode: " + barcodeFilter.trim() : "Barcode"}
            </Text>
            {barcodeFilter.trim().length > 0 && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); setBarcodeFilter(""); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.tint} />
              </Pressable>
            )}
          </Pressable>
        </ScrollView>
      </View>

      {/* Barcode search input (revealed by the Barcode chip) */}
      {showBarcodeFilter ? (
        <View style={styles.barcodeFilterRow}>
          <View style={styles.searchWrap}>
            <Ionicons name="barcode-outline" size={18} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by exact barcode"
              placeholderTextColor={colors.textTertiary}
              value={barcodeFilter}
              onChangeText={setBarcodeFilter}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="search"
              testID="cases-barcode-filter-input"
            />
            {barcodeFilter.length > 0 ? (
              <Pressable onPress={() => setBarcodeFilter("")} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

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
          renderItem={({ item }) => {
            const isSelected = selectedIds.has(item.id);
            const isLocateSuccess = locateSuccessId === item.id || bulkLocateSuccessIds.has(item.id);
            return (
              <Pressable
                onPress={() => {
                  // Guard must come first: long-press fires onLongPress then
                  // immediately fires onPress on finger-lift for the SAME card.
                  // Only absorb the follow-up press on the card that was
                  // long-pressed — pressing a different card must still toggle.
                  if (longPressActiveRef.current === item.id) {
                    longPressActiveRef.current = null;
                    return;
                  }
                  if (selectionMode) {
                    toggleSelection(item.id);
                    return;
                  }
                  router.push(`/case/${item.id}` as never);
                }}
                onLongPress={() => {
                  if (selectionMode) {
                    toggleSelection(item.id);
                    return;
                  }
                  longPressActiveRef.current = item.id;
                  setSelectionMode(true);
                  setSelectedIds(new Set([item.id]));
                }}
                delayLongPress={400}
                testID={`case-card-${item.id}`}
                style={({ pressed }) => [
                  isSelected && { backgroundColor: colors.tint + "10" },
                  pressed ? styles.rowPressed : undefined,
                ]}
              >
                <Card
                  style={[
                    styles.row,
                    isSelected && { borderWidth: 1.5, borderColor: colors.tint + "60" },
                  ]}
                >
                  {selectionMode ? (
                    <View style={[
                      styles.checkbox,
                      isSelected
                        ? { backgroundColor: colors.tint, borderColor: colors.tint }
                        : { borderColor: colors.border, backgroundColor: "transparent" },
                    ]}>
                      {isSelected && <Ionicons name="checkmark" size={13} color="#fff" />}
                    </View>
                  ) : null}
                  <View style={styles.rowMain}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {patientName(item)}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {item.caseNumber ? `#${item.caseNumber}` : "No case #"}
                      {item.doctorName ? `  ·  ${item.doctorName}` : ""}
                    </Text>
                    {item.casePanBarcode ? (
                      <View style={styles.panRow}>
                        <Ionicons name="barcode-outline" size={12} color={colors.textTertiary} />
                        <Text style={styles.panText} numberOfLines={1}>{item.casePanBarcode}</Text>
                      </View>
                    ) : null}
                    <Text style={styles.rowDue}>Due {formatDate(item.dueDate)}</Text>
                  </View>
                  <View style={styles.rowRight}>
                    <StatusBadge label={titleCase(item.status ?? "—")} variant={statusVariant(item.status)} />
                    {isLocateSuccess ? (
                      <View style={styles.locatedBadge}>
                        <Ionicons name="checkmark-circle" size={14} color={colors.tint} />
                        <Text style={[styles.locatedBadgeText, { color: colors.tint }]}>Located</Text>
                      </View>
                    ) : selectionMode ? null : (
                      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                    )}
                  </View>
                </Card>
              </Pressable>
            );
          }}
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
              {CASE_STATIONS.map((station) => {
                const checked = locationDraft.includes(station.value);
                return (
                  <Pressable
                    key={station.value}
                    style={styles.locationRow}
                    onPress={() => {
                      setLocationDraft((prev) =>
                        prev.includes(station.value)
                          ? prev.filter((v) => v !== station.value)
                          : [...prev, station.value],
                      );
                    }}
                  >
                    <View style={[
                      styles.locationCheckbox,
                      checked && { backgroundColor: colors.violet, borderColor: colors.violet },
                      !checked && { borderColor: colors.border },
                    ]}>
                      {checked && <Ionicons name="checkmark" size={13} color="#fff" />}
                    </View>
                    <Text style={[styles.locationLabel, { color: checked ? colors.violet : colors.text }]}>
                      {station.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.sheetActions}>
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  setLocationDraft([]);
                  setLocationFilter([]);
                  setShowLocationModal(false);
                }}
              >
                <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
              </Pressable>
              <Pressable
                style={[styles.applyBtn, { backgroundColor: colors.violet }]}
                onPress={() => {
                  setLocationFilter(locationDraft);
                  setShowLocationModal(false);
                }}
              >
                <Text style={[styles.applyBtnText, { color: "#fff" }]}>
                  {locationDraft.length === 0
                    ? "Show all"
                    : `Show ${locationDraft.length} station${locationDraft.length === 1 ? "" : "s"}`}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ Single long-press Locate Sheet ══════════════════════════════════ */}
      <LocateCaseSheet
        locatingCase={locatingCase}
        onDismiss={dismissLocate}
        onLocated={handleLocated}
      />

      {/* ══ Bulk Locate Sheet (multi-select) ════════════════════════════════ */}
      <LocateCaseSheet
        locatingCases={showBulkLocateSheet ? selectedCases : []}
        onDismiss={() => setShowBulkLocateSheet(false)}
        onBulkLocated={handleBulkLocated}
      />

      {/* ══ Multi-select action bar ══════════════════════════════════════════ */}
      {selectionMode ? (
        <View
          style={[
            styles.selectionBar,
            { paddingBottom: Math.max(insets.bottom, Spacing.md), backgroundColor: colors.surface },
          ]}
          testID="selection-action-bar"
        >
          <Pressable
            style={[styles.selectionCancelBtn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
            onPress={exitSelectionMode}
          >
            <Text style={[styles.selectionCancelBtnText, { color: colors.textSecondary }]}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[
              styles.selectionLocateBtn,
              { backgroundColor: selectedIds.size > 0 ? colors.tint : colors.border },
            ]}
            onPress={() => {
              if (selectedIds.size > 0) setShowBulkLocateSheet(true);
            }}
            disabled={selectedIds.size === 0}
            testID="bulk-locate-btn"
          >
            <Ionicons name="location-outline" size={17} color={colors.textInverse} />
            <Text style={[styles.selectionLocateBtnText, { color: colors.textInverse }]}>
              Locate{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* ══ Barcode Scan Modal ═══════════════════════════════════════════════ */}
      <Modal
        visible={showScanModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeScanModal}
      >
        <View style={[styles.scanScreen, { paddingTop: insets.top }]}>
          {/* Header */}
          <View style={styles.scanHeader}>
            <View>
              <Text style={styles.scanTitle}>Scan Barcode</Text>
              <Text style={styles.scanSubtitle}>Find a case by pan barcode</Text>
            </View>
            <Pressable style={styles.scanCloseBtn} onPress={closeScanModal} hitSlop={8} testID="scan-modal-close">
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          {/* Mode toggle */}
          <View style={styles.scanModeRow}>
            <Pressable
              style={[styles.scanModeTab, scanStep === "scan" && styles.scanModeTabActive]}
              onPress={() => { setScanStep("scan"); setScanError(null); setScanScanned(false); }}
            >
              <Ionicons
                name="barcode-outline"
                size={17}
                color={scanStep === "scan" ? "#fff" : colors.textSecondary}
              />
              <Text style={[styles.scanModeTabText, scanStep === "scan" && styles.scanModeTabTextActive]}>
                Camera
              </Text>
            </Pressable>
            <Pressable
              style={[styles.scanModeTab, scanStep === "manual" && styles.scanModeTabActive]}
              onPress={() => { setScanStep("manual"); setScanError(null); setScanScanned(false); }}
            >
              <Ionicons
                name="keypad-outline"
                size={17}
                color={scanStep === "manual" ? "#fff" : colors.textSecondary}
              />
              <Text style={[styles.scanModeTabText, scanStep === "manual" && styles.scanModeTabTextActive]}>
                Manual
              </Text>
            </Pressable>
          </View>

          {scanStep === "scan" ? (
            !cameraPermission?.granted ? (
              <View style={styles.scanPermView}>
                <Ionicons name="camera-outline" size={52} color={colors.textTertiary} />
                <Text style={styles.scanPermTitle}>Camera access needed</Text>
                <Text style={styles.scanPermBody}>
                  Allow camera access to scan a pan barcode, or switch to Manual entry.
                </Text>
                <Pressable style={[styles.scanActionBtn, { backgroundColor: colors.tint }]} onPress={requestCameraPermission}>
                  <Text style={[styles.scanActionBtnText, { color: "#fff" }]}>Allow Camera</Text>
                </Pressable>
              </View>
            ) : (
              <View
                style={styles.scanCameraWrap}
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  cameraViewSize.current = { width, height };
                }}
              >
                {!scanScanned && (
                  <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    onBarcodeScanned={scanSearching ? undefined : handleCameraBarcode}
                    barcodeScannerSettings={{
                      barcodeTypes: ["code128", "code39", "qr", "ean13", "ean8", "pdf417", "code93"],
                    }}
                  />
                )}
                {/* Reticle corners */}
                <View style={styles.scanReticle} pointerEvents="none">
                  <View style={styles.scanCornerTL} />
                  <View style={styles.scanCornerTR} />
                  <View style={styles.scanCornerBL} />
                  <View style={styles.scanCornerBR} />
                </View>
                {/* Targeted-barcode bounds highlight — visible while lookup is in flight */}
                {scanTarget?.bounds && !scanMatch ? (
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      left: scanTarget.bounds.origin.x,
                      top: scanTarget.bounds.origin.y,
                      width: scanTarget.bounds.size.width,
                      height: scanTarget.bounds.size.height,
                      borderWidth: 2,
                      borderColor: "#4ade80",
                      borderRadius: 4,
                    }}
                  />
                ) : null}
                {/* Match result overlay — shown briefly after a successful scan */}
                {scanMatch ? (
                  <View style={styles.scanMatchOverlay} pointerEvents="none">
                    <View style={styles.scanMatchCard}>
                      <Ionicons name="checkmark-circle" size={28} color="#4ade80" />
                      <Text style={styles.scanMatchPatient} numberOfLines={1}>
                        {scanMatch.patientName}
                      </Text>
                      {scanMatch.caseNumber ? (
                        <Text style={styles.scanMatchMeta}>#{scanMatch.caseNumber}</Text>
                      ) : null}
                      <Text style={styles.scanMatchBarcode}>{scanMatch.barcode}</Text>
                    </View>
                  </View>
                ) : scanSearching ? (
                  <View style={styles.scanSearchingOverlay}>
                    <ActivityIndicator color="#fff" size="large" />
                    <Text style={styles.scanSearchingText}>Looking up case…</Text>
                  </View>
                ) : null}
                {/* Hint */}
                <View style={styles.scanHintWrap} pointerEvents="none">
                  <Text style={styles.scanHintText}>Center the barcode in the box</Text>
                </View>
                {/* Error banner on top of camera */}
                {scanError ? (
                  <View style={styles.scanErrorBanner}>
                    <Ionicons name="alert-circle-outline" size={16} color="#fff" />
                    <Text style={styles.scanErrorBannerText}>{scanError}</Text>
                    <Pressable hitSlop={8} onPress={() => { setScanError(null); setScanScanned(false); }}>
                      <Ionicons name="close" size={16} color="#fff" />
                    </Pressable>
                  </View>
                ) : null}
              </View>
            )
          ) : (
            /* Manual entry */
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              style={styles.scanManualWrap}
            >
              <Text style={styles.scanManualLabel}>Enter barcode value</Text>
              <TextInput
                style={[styles.scanManualInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                value={manualBarcode}
                onChangeText={(t) => { setManualBarcode(t); setScanError(null); }}
                placeholder="Type or paste barcode…"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="search"
                onSubmitEditing={handleManualBarcode}
              />
              {scanError ? (
                <View style={styles.scanInlineError}>
                  <Ionicons name="alert-circle-outline" size={15} color={colors.error} />
                  <Text style={[styles.scanInlineErrorText, { color: colors.error }]}>{scanError}</Text>
                </View>
              ) : null}
              <Pressable
                style={[styles.scanActionBtn, { backgroundColor: scanSearching ? colors.border : colors.tint }]}
                onPress={handleManualBarcode}
                disabled={scanSearching}
                testID="scan-manual-submit"
              >
                {scanSearching ? (
                  <ActivityIndicator color={colors.textInverse} size="small" />
                ) : (
                  <Text style={[styles.scanActionBtnText, { color: "#fff" }]}>Find Case</Text>
                )}
              </Pressable>
            </KeyboardAvoidingView>
          )}
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
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
      marginBottom: Spacing.xs,
    },
    searchWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 0 },
    scanBtn: {
      width: 42,
      height: 42,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
    },

    // Barcode filter input row (revealed by the Barcode chip)
    barcodeFilterRow: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.xs,
    },

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
    panRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 2 },
    panText: { ...Typography.caption, color: c.textTertiary, fontVariant: ["tabular-nums"] as any },
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
    locationList: { maxHeight: 360 },
    locationRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.sm + 2,
    },
    locationCheckbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    locationLabel: { ...Typography.body, flex: 1 },
    locationDivider: { height: 1, marginBottom: Spacing.xs },

    // Long-press row feedback
    rowPressed: { opacity: 0.7 },

    // Selection mode checkbox
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 2,
      flexShrink: 0,
    },

    // Multi-select bottom action bar
    selectionBar: {
      flexDirection: "row",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    selectionCancelBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
    },
    selectionCancelBtnText: { ...Typography.bodySemibold },
    selectionLocateBtn: {
      flex: 2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
    },
    selectionLocateBtnText: { ...Typography.bodySemibold },

    // Locate success inline badge
    locatedBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    locatedBadgeText: { ...Typography.captionSemibold },

    // Locate modal subtitle
    locateSubtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },

    // ── Barcode scan modal ────────────────────────────────────────────────────
    scanScreen: { flex: 1, backgroundColor: c.backgroundSolid },
    scanHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    scanTitle: { ...Typography.h3, color: c.text },
    scanSubtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    scanCloseBtn: {
      padding: Spacing.xs,
    },
    scanModeRow: {
      flexDirection: "row",
      margin: Spacing.lg,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    scanModeTab: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.sm,
    },
    scanModeTabActive: { backgroundColor: c.tint },
    scanModeTabText: { ...Typography.bodySemibold, color: c.textSecondary },
    scanModeTabTextActive: { color: "#fff" },

    scanPermView: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.lg,
    },
    scanPermTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    scanPermBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },

    scanCameraWrap: { flex: 1, position: "relative", backgroundColor: "#000" },
    scanReticle: {
      position: "absolute",
      top: "28%",
      left: "12%",
      right: "12%",
      height: "44%",
    },
    scanCornerTL: {
      position: "absolute", top: 0, left: 0,
      width: 28, height: 28,
      borderTopWidth: 3, borderLeftWidth: 3,
      borderColor: "#fff", borderRadius: 4,
    },
    scanCornerTR: {
      position: "absolute", top: 0, right: 0,
      width: 28, height: 28,
      borderTopWidth: 3, borderRightWidth: 3,
      borderColor: "#fff", borderRadius: 4,
    },
    scanCornerBL: {
      position: "absolute", bottom: 0, left: 0,
      width: 28, height: 28,
      borderBottomWidth: 3, borderLeftWidth: 3,
      borderColor: "#fff", borderRadius: 4,
    },
    scanCornerBR: {
      position: "absolute", bottom: 0, right: 0,
      width: 28, height: 28,
      borderBottomWidth: 3, borderRightWidth: 3,
      borderColor: "#fff", borderRadius: 4,
    },
    scanSearchingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.65)",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    scanSearchingText: { ...Typography.bodySemibold, color: "#fff" },
    scanMatchOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
    },
    scanMatchCard: {
      alignItems: "center",
      gap: Spacing.sm,
      backgroundColor: "rgba(255,255,255,0.08)",
      borderRadius: Radius.xl,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.lg,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.18)",
      minWidth: 220,
    },
    scanMatchPatient: { ...Typography.h3, color: "#fff", textAlign: "center" },
    scanMatchMeta: { ...Typography.bodySemibold, color: "rgba(255,255,255,0.75)", textAlign: "center" },
    scanMatchBarcode: { ...Typography.captionMedium, color: "rgba(255,255,255,0.5)", fontVariant: ["tabular-nums"] as any },
    scanHintWrap: {
      position: "absolute",
      bottom: Spacing.xl,
      left: 0, right: 0,
      alignItems: "center",
    },
    scanHintText: {
      ...Typography.captionMedium,
      color: "#fff",
      textShadowColor: "#000",
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },
    scanErrorBanner: {
      position: "absolute",
      top: Spacing.md,
      left: Spacing.lg,
      right: Spacing.lg,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      backgroundColor: "rgba(180,30,30,0.88)",
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    scanErrorBannerText: { flex: 1, ...Typography.captionSemibold, color: "#fff" },

    scanManualWrap: { flex: 1, padding: Spacing.xl, gap: Spacing.lg },
    scanManualLabel: { ...Typography.bodySemibold, color: c.text },
    scanManualInput: {
      ...Typography.body,
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Platform.OS === "ios" ? Spacing.sm : Spacing.xs,
      fontSize: 18,
      letterSpacing: 1.5,
    },
    scanInlineError: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginTop: -Spacing.sm,
    },
    scanInlineErrorText: { ...Typography.caption },

    scanActionBtn: {
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
      alignItems: "center",
      justifyContent: "center",
    },
    scanActionBtnText: { ...Typography.bodySemibold },
  });
}
