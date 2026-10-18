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
  Alert,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from "react-native-vision-camera";
import * as Haptics from "expo-haptics";
import {
  useCasesPage,
  useCasesOverview,
  getListLabInboxFilesQueryKey,
  type CanonicalCase,
} from "@workspace/api-client-react";
import type { CaseSavedView, CaseSavedViewFilters } from "@workspace/api-client-react";
import { CASE_STATUS_GROUPS } from "@workspace/case-taxonomy";
import { CaseRangeWindow } from "@/components/CaseRangeWindow";
import { CasesSummary } from "@/components/CasesSummary";
import { parseRangeDate } from "@workspace/calendar-date";
import { CaseQuickActionSheet } from "@/components/CaseQuickActionSheet";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  peekSharedFiles,
  popSharedFiles,
  removeSharedFiles,
  subscribeSharedFileInbox,
  saveSharedFilesToUnassignedDocuments,
  type InboxEntry,
} from "@/lib/shared-file-inbox";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { CASE_STATIONS, canonicalCaseStatus } from "@/lib/case-stations";
import { resilientFetch } from "@/lib/query-client";
import {
  formatRelativeCreated,
  formatRelativeDue,
  formatCompletedAt,
  getDueDayDiff,
  isDueTimePast,
} from "@/lib/format";
import { useDayChange } from "@/hooks/useDayChange";
import { fetchCaseByBarcode } from "@/lib/barcode-lookup";
import { pickBestBarcode, guideBoxFromFractions, type BarcodeCandidate } from "@/lib/barcode-guide-box";
import { codesToBarcodeCandidates, SCAN_CODE_TYPES } from "@/lib/vision-camera-codes";
import { TorchToggleButton } from "@/components/ui/TorchToggleButton";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import {
  classifyCaseCategory,
  CASE_CATEGORY_KEYS,
  CASE_TYPES,
  deriveCaseHierarchy,
  getCaseTypeLabel,
  getCompactWorkDetails,
  type CaseCategory,
  type CaseType,
} from "@/lib/case-category";
import { TypeBadge } from "@/components/ui/TypeBadge";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { caseLocationLabel } from "@/lib/case-location-label";
import { useLongPressGuard } from "@/lib/use-long-press-guard";
import { isActiveCaseRecord } from "@/lib/case-quick-actions";

type DateFilterPreset = "all" | "today" | "yesterday" | "thisWeek" | "thisMonth" | "custom";
async function savedCaseViewRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await resilientFetch(`/api${path}`, options);
  let body: any = null;
  if (response.status !== 204) {
    try { body = await response.json(); } catch { body = null; }
  }
  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (null as T) : body?.data as T;
}

// Labels for the category chip seeded by the Stats screen — mirrors the
// Stats screen's CATEGORY_OPTIONS labels.
// "Type" filter options — the top-level Case Type taxonomy (restorative /
// removable / ortho), mirroring the same categorisation the desktop cases
// list exposes. Derived per-case from the first restoration via
// `deriveCaseHierarchy`, so a case with no recognisable restoration type
// simply won't match any specific option (it still shows under "All types").
const TYPE_FILTER_OPTIONS: { value: CaseType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  ...CASE_TYPES.map((ct) => ({ value: ct, label: getCaseTypeLabel(ct) })),
];

const CATEGORY_FILTER_LABELS: Record<CaseCategory, string> = {
  implants: "Implants",
  zirconia: "Zirconia",
  crown_bridge: "Crown & Bridge",
  removable: "Removable",
  other: "Other",
  uncategorized: "Uncategorized",
};

const DATE_PRESET_OPTIONS: { value: DateFilterPreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "custom", label: "Custom range" },
];

const CASE_STATUS_QUICK_FILTERS = [
  { id: "all", label: "All Cases", statuses: [] as readonly string[] },
  { id: "processing", label: "Processing", statuses: CASE_STATUS_GROUPS.processing },
  { id: "received", label: "Received", statuses: CASE_STATUS_GROUPS.received },
  { id: "inDesign", label: "In Design", statuses: CASE_STATUS_GROUPS.inDesign },
  { id: "modelRoom", label: "Model Room", statuses: CASE_STATUS_GROUPS.modelRoom },
  { id: "scan", label: "Scan", statuses: CASE_STATUS_GROUPS.scan },
  { id: "milling", label: "In Milling", statuses: CASE_STATUS_GROUPS.milling },
  { id: "postMill", label: "Post Mill", statuses: CASE_STATUS_GROUPS.postMill },
  { id: "sinteringFurnace", label: "Sintering Furnace", statuses: CASE_STATUS_GROUPS.sinteringFurnace },
  { id: "porcelain", label: "Porcelain", statuses: CASE_STATUS_GROUPS.porcelain },
  { id: "qualityCheck", label: "Quality Check", statuses: CASE_STATUS_GROUPS.qualityCheck },
  { id: "onHold", label: "On Hold", statuses: CASE_STATUS_GROUPS.onHold },
  { id: "remake", label: "Remake", statuses: CASE_STATUS_GROUPS.remake },
  { id: "shipped", label: "Shipped", statuses: CASE_STATUS_GROUPS.shipped },
  { id: "overdue", label: "Overdue", statuses: [] as readonly string[] },
];

interface ScanMatch {
  barcode: string;
  patientName: string;
  caseNumber: string | null;
  caseId: string;
}

// ── MobileTrialBanner ────────────────────────────────────────────────────────
interface TrialEntitlement {
  status: string;
  trialDaysRemaining: number | null;
}

function MobileTrialBanner() {
  const { data } = useQuery<{ ok: boolean; entitlement: TrialEntitlement }>({
    queryKey: ["billing", "subscription"],
    queryFn: async () => {
      const res = await resilientFetch("/api/billing/subscription");
      return res.json() as Promise<{ ok: boolean; entitlement: TrialEntitlement }>;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const entitlement = data?.entitlement;
  if (!entitlement) return null;

  const { status, trialDaysRemaining } = entitlement;
  if (status === "active" || status === "legacy_free") return null;

  if (status === "locked" || status === "deactivated" || status === "read_only" || status === "canceled" || status === "grace") {
    return (
      <Pressable
        onPress={() => router.push("/settings/subscriptions" as never)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.sm,
          paddingHorizontal: Spacing.md,
          paddingVertical: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: "rgba(220,38,38,0.4)",
          backgroundColor: "rgba(220,38,38,0.08)",
        }}
      >
        <Ionicons name="alert-circle" size={16} color="#EF4444" />
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "500", color: "#EF4444" }}>
          {status === "grace"
            ? "Trial expired — add billing to continue"
            : status === "deactivated" || status === "read_only"
              ? "Read-only access — renew to restore full access"
              : "Subscription Required"}
        </Text>
        <Text style={{ fontSize: 12, fontWeight: "600", color: "#EF4444" }}>Upgrade →</Text>
      </Pressable>
    );
  }

  if (status === "trialing" && trialDaysRemaining !== null) {
    if (trialDaysRemaining <= 0) {
      return (
        <Pressable
          onPress={() => router.push("/settings/subscriptions" as never)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginHorizontal: Spacing.md,
            marginBottom: Spacing.sm,
            paddingHorizontal: Spacing.md,
            paddingVertical: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: "rgba(220,38,38,0.4)",
            backgroundColor: "rgba(220,38,38,0.08)",
          }}
        >
          <Ionicons name="alert-circle" size={16} color="#EF4444" />
          <Text style={{ flex: 1, fontSize: 13, fontWeight: "500", color: "#EF4444" }}>
            Subscription Required
          </Text>
          <Text style={{ fontSize: 12, fontWeight: "600", color: "#EF4444" }}>Upgrade →</Text>
        </Pressable>
      );
    }

    if (trialDaysRemaining <= 3) {
      return (
        <Pressable
          onPress={() => router.push("/settings/subscriptions" as never)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginHorizontal: Spacing.md,
            marginBottom: Spacing.sm,
            paddingHorizontal: Spacing.md,
            paddingVertical: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: "rgba(245,158,11,0.4)",
            backgroundColor: "rgba(245,158,11,0.08)",
          }}
        >
          <Ionicons name="alert-circle-outline" size={16} color="#F59E0B" />
          <Text style={{ flex: 1, fontSize: 13, color: "#92400E" }}>
            Trial expires in{" "}
            <Text style={{ fontWeight: "700" }}>
              {trialDaysRemaining} day{trialDaysRemaining !== 1 ? "s" : ""}
            </Text>
            . Add billing to avoid interruption.
          </Text>
          <Text style={{ fontSize: 12, fontWeight: "600", color: "#D97706" }}>Add →</Text>
        </Pressable>
      );
    }

    if (trialDaysRemaining <= 7) {
      return (
        <Pressable
          onPress={() => router.push("/settings/subscriptions" as never)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginHorizontal: Spacing.md,
            marginBottom: Spacing.sm,
            paddingHorizontal: Spacing.md,
            paddingVertical: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: "rgba(59,130,246,0.3)",
            backgroundColor: "rgba(59,130,246,0.06)",
          }}
        >
          <Ionicons name="time-outline" size={16} color="#3B82F6" />
          <Text style={{ flex: 1, fontSize: 13, color: "#1D4ED8" }}>
            Free trial expires in{" "}
            <Text style={{ fontWeight: "700" }}>
              {trialDaysRemaining} day{trialDaysRemaining !== 1 ? "s" : ""}
            </Text>
            .
          </Text>
          <Text style={{ fontSize: 12, fontWeight: "600", color: "#3B82F6" }}>View →</Text>
        </Pressable>
      );
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function patientName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function firstListValue(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}


function formatShort(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
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

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() - day);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() + (6 - day));
  r.setHours(23, 59, 59, 999);
  return r;
}

function startOfMonth(d: Date): Date {
  const r = new Date(d);
  r.setDate(1);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfMonth(d: Date): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + 1, 0);
  r.setHours(23, 59, 59, 999);
  return r;
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

// Set to true right before navigating into an in-Cases-workflow screen
// (case detail or new-case). The list's focus-effect cleanup reads this on blur
// to decide whether to preserve filters (in-workflow) or reset them (left the
// Cases section entirely). Module-level so it survives the blur that unmounts
// nothing but re-runs the focus effect.
let leavingIntoCasesWorkflow = false;

// ── Main screen ──────────────────────────────────────────────────────────────
export default function CasesListScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ── Search
  const [query, setQuery] = useState("");
  // Debounced copy of the search term that is sent to the SERVER. Typing only
  // updates `query` (instant local filtering); this trails it by 300ms so we
  // don't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [casePage, setCasePage] = useState(1);
  const [loadedCases, setLoadedCases] = useState<CanonicalCase[]>([]);

  // ── Auth / membership — used to resolve lab org ID for barcode scan
  const meQuery = useMe();
  const qc = useQueryClient();
  const savedViewsLabOrgId = primaryLabOrgId(meQuery.data);
  const [showSavedViewsModal, setShowSavedViewsModal] = useState(false);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState("");
  const [savedViewNameDraft, setSavedViewNameDraft] = useState("");
  const savedViewsQuery = useQuery({
    queryKey: ["cases", "saved-views", savedViewsLabOrgId],
    enabled: !!savedViewsLabOrgId,
    queryFn: () => savedCaseViewRequest<CaseSavedView[]>(
      `/cases/saved-views?labOrganizationId=${encodeURIComponent(savedViewsLabOrgId!)}`,
    ),
  });

  // ── Barcode scan modal
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanStep, setScanStep] = useState<"scan" | "manual">("scan");
  const [manualBarcode, setManualBarcode] = useState("");
  const [scanSearching, setScanSearching] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanScanned, setScanScanned] = useState(false);
  const [scanMatch, setScanMatch] = useState<ScanMatch | null>(null);
  const cameraViewSize = useRef<{ width: number; height: number } | null>(null);
  // Ref mirrors scanScanned so timer callbacks read the live value without stale closures.
  const scanLockedRef = useRef(false);
  // Accumulate all barcodes detected in a ~120ms frame window so pickBestBarcode
  // can choose the in-box barcode closest to center across the whole frame.
  const barcodeAccumRef = useRef<BarcodeCandidate[]>([]);
  const barcodeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { hasPermission: cameraHasPermission, requestPermission: requestCameraPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice("back");
  const [scanTorchOn, setScanTorchOn] = useState(false);

  function openScanModal() {
    setScanStep("scan");
    setManualBarcode("");
    setScanError(null);
    setScanScanned(false);
    scanLockedRef.current = false;
    setScanMatch(null);
    setScanTorchOn(false);
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
    setScanTorchOn(false);
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
      casesQuery.data?.rows[0]?.labOrganizationId ??
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
      // Shared with the dashboard's Look Up Case pop-up so both surfaces agree
      // on the request shape, envelope parsing, and the user-facing wording.
      const outcome = await fetchCaseByBarcode(trimmed, labOrganizationId, resilientFetch);

      if (outcome.status !== "found") {
        setScanError(outcome.message);
        setScanScanned(false);
        scanLockedRef.current = false;
        return;
      }

      setScanMatch({
        barcode: trimmed,
        patientName: outcome.patientName,
        caseNumber: outcome.caseNumber,
        caseId: outcome.caseId,
      });

      setTimeout(() => {
        closeScanModal();
        leavingIntoCasesWorkflow = true;
        router.push(`/case/${outcome.caseId}` as never);
      }, 900);
    } finally {
      setScanSearching(false);
    }
  }

  // Keep a stable ref so the debounce timer always calls the latest lookupBarcode
  // without needing it as a dependency (which would recreate the callback each render).
  const lookupBarcodeRef = useRef(lookupBarcode);
  lookupBarcodeRef.current = lookupBarcode;

  const handleCameraBarcode = useCallback(
    (codes: BarcodeCandidate[]) => {
      if (scanLockedRef.current || codes.length === 0) return;

      // Accumulate all barcodes arriving in this ~120ms scan cycle so
      // pickBestBarcode can compare all in-frame candidates at once.
      barcodeAccumRef.current.push(...codes);
      if (barcodeDebounceRef.current) clearTimeout(barcodeDebounceRef.current);

      barcodeDebounceRef.current = setTimeout(() => {
        barcodeDebounceRef.current = null;
        if (scanLockedRef.current) {
          barcodeAccumRef.current = [];
          return;
        }

        const candidates = barcodeAccumRef.current.splice(0);
        if (candidates.length === 0) return;

        const viewSize = cameraViewSize.current;
        const box = guideBoxFromFractions(0.12, 0.28, 0.12, 0.44);
        const best = pickBestBarcode(candidates, box, viewSize) ?? candidates[0];
        if (!best || !best.data.trim()) return;

        scanLockedRef.current = true;
        setScanScanned(true);
        Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});
        lookupBarcodeRef.current(best.data.trim());
      }, 120);
    },
    [],
  );

  const scanCodeScanner = useCodeScanner({
    codeTypes: SCAN_CODE_TYPES,
    onCodeScanned: (codes, frame) =>
      handleCameraBarcode(codesToBarcodeCandidates(codes, frame)),
  });

  async function handleManualBarcode() {
    const code = manualBarcode.trim();
    if (!code) {
      setScanError("Enter a barcode value first.");
      return;
    }
    await lookupBarcode(code);
  }

  // ── Date filters
  const [createdFilter, setCreatedFilter] = useState<DateFilterPreset>("all");
  const [dueFilter, setDueFilter] = useState<DateFilterPreset>("all");

  // Per-target custom date range state
  const [createdCustomFrom, setCreatedCustomFrom] = useState<Date | null>(null);
  const [createdCustomTo, setCreatedCustomTo] = useState<Date | null>(null);
  const [dueCustomFrom, setDueCustomFrom] = useState<Date | null>(null);
  const [dueCustomTo, setDueCustomTo] = useState<Date | null>(null);
  const [customTarget, setCustomTarget] = useState<"created" | "due">("due");
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  // Date picker sheet (for Today/Yesterday/This week/This month/Custom)
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [datePickerTarget, setDatePickerTarget] = useState<"created" | "due">("due");

  // ── Barcode quick-filter (exact pan-barcode match)
  const [barcodeFilter, setBarcodeFilter] = useState("");
  const [showBarcodeFilter, setShowBarcodeFilter] = useState(false);

  // ── Conflict filter (show only cases with duplicate active barcodes)
  const [conflictFilter, setConflictFilter] = useState(false);

  // ── Category filter (seeded by tapping a Stats "Cases by category" bar).
  // Not user-selectable from a picker on this screen — it appears as a
  // dismissible chip only when active.
  const [categoryFilter, setCategoryFilter] = useState<CaseCategory | "">("");

  // ── Case Type filter (Restorative / Removable / Ortho / Appliances) —
  // user-selectable via the "Type" chip below. Filters to cases whose first
  // restoration maps to that top-level case type via `deriveCaseHierarchy`.
  const [typeFilter, setTypeFilter] = useState<CaseType | "all">("all");
  const [showTypeModal, setShowTypeModal] = useState(false);

  // ── Status filter — multi-select, union semantics: a case is kept when its
  // status matches ANY checked value. An empty array means "All" (no
  // filtering), mirroring the desktop cases list's MultiSelectFilter contract.
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  // Draft selections while the modal is open
  const [statusDraft, setStatusDraft] = useState<string[]>([]);

  // Reset every record-hiding Cases filter to its default. Sort/display prefs
  // are untouched. Stable identity (only stable setters referenced) so the
  // reset-on-leave focus effect below never re-fires mid-session.
  const resetFilters = useCallback(() => {
    setQuery("");
    setCreatedFilter("all");
    setDueFilter("all");
    setCreatedCustomFrom(null);
    setCreatedCustomTo(null);
    setDueCustomFrom(null);
    setDueCustomTo(null);
    setDraftFrom("");
    setDraftTo("");
    setStatusFilter([]);
    setOverdueOnly(false);
    setStatusDraft([]);
    setBarcodeFilter("");
    setShowBarcodeFilter(false);
    setConflictFilter(false);
    setCategoryFilter("");
    setTypeFilter("all");
  }, []);

  const applySavedCaseView = useCallback((view: CaseSavedView) => {
    setQuery(view.filters.search);
    setDebouncedSearch(view.filters.search.trim());
    setStatusFilter([...view.filters.statusFilters]);
    setStatusDraft([]);
    setOverdueOnly(false);
    setBarcodeFilter("");
    setShowBarcodeFilter(false);
    setConflictFilter(false);
    setCategoryFilter("");
    setTypeFilter("all");
    setCreatedFilter((view.filters.mobile?.createdFilter ?? "all") as DateFilterPreset);
    setCreatedCustomFrom(calendarDateFromString(view.filters.mobile?.createdCustomFrom ?? ""));
    setCreatedCustomTo(calendarDateFromString(view.filters.mobile?.createdCustomTo ?? ""));
    setDueFilter((view.filters.mobile?.dueFilter ?? "all") as DateFilterPreset);
    setDueCustomFrom(calendarDateFromString(view.filters.mobile?.dueCustomFrom ?? ""));
    setDueCustomTo(calendarDateFromString(view.filters.mobile?.dueCustomTo ?? ""));
    setShowDatePicker(false);
    setShowCustomModal(false);
    setCasePage(1);
    setLoadedCases([]);
    setSelectedSavedViewId(view.id);
    if (!view.filters.mobile && view.filters.desktop) {
      Alert.alert(
        "Date filter not applied",
        "This view was saved on desktop. Search and status were applied; mobile created and due dates were cleared because desktop uses a different date field.",
      );
    }
  }, []);

  const createSavedViewMutation = useMutation({
    mutationFn: (name: string) => {
      if (!savedViewsLabOrgId) throw new Error("No lab is available for saved views.");
      const filters: CaseSavedViewFilters = {
        search: query.trim(),
        statusFilters: [...statusFilter],
        mobile: {
          createdFilter,
          createdCustomFrom: calendarDateString(createdCustomFrom),
          createdCustomTo: calendarDateString(createdCustomTo),
          dueFilter,
          dueCustomFrom: calendarDateString(dueCustomFrom),
          dueCustomTo: calendarDateString(dueCustomTo),
        },
      };
      return savedCaseViewRequest<CaseSavedView>("/cases/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labOrganizationId: savedViewsLabOrgId, name, filters }),
      });
    },
    onSuccess: (view) => {
      setSelectedSavedViewId(view.id);
      setSavedViewNameDraft("");
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", savedViewsLabOrgId] });
      Alert.alert("Saved view", `“${view.name}” is now shared with your lab team.`);
    },
    onError: (error) => Alert.alert("Could not save view", error instanceof Error ? error.message : "Please try again."),
  });
  const updateSavedViewFiltersMutation = useMutation({
    mutationFn: ({ id, filters }: { id: string; filters: CaseSavedViewFilters }) => {
      if (!savedViewsLabOrgId) throw new Error("No lab is available for saved views.");
      return savedCaseViewRequest<CaseSavedView>(`/cases/saved-views/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labOrganizationId: savedViewsLabOrgId, filters }),
      });
    },
    onSuccess: (view) => {
      setSelectedSavedViewId(view.id);
      setSavedViewNameDraft(view.name);
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", savedViewsLabOrgId] });
      Alert.alert("Saved view updated", `“${view.name}” is now updated for everyone in your lab.`);
    },
    onError: (error) => Alert.alert("Could not update view", error instanceof Error ? error.message : "Please try again."),
  });
  const renameSavedViewMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => {
      if (!savedViewsLabOrgId) throw new Error("No lab is available for saved views.");
      return savedCaseViewRequest<CaseSavedView>(`/cases/saved-views/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labOrganizationId: savedViewsLabOrgId, name }),
      });
    },
    onSuccess: (view) => {
      setSavedViewNameDraft(view.name);
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", savedViewsLabOrgId] });
    },
    onError: (error) => Alert.alert("Could not rename view", error instanceof Error ? error.message : "Please try again."),
  });
  const deleteSavedViewMutation = useMutation({
    mutationFn: (id: string) => {
      if (!savedViewsLabOrgId) throw new Error("No lab is available for saved views.");
      return savedCaseViewRequest<null>(
        `/cases/saved-views/${encodeURIComponent(id)}?labOrganizationId=${encodeURIComponent(savedViewsLabOrgId)}`,
        { method: "DELETE" },
      );
    },
    onSuccess: (_result, id) => {
      if (selectedSavedViewId === id) {
        setSelectedSavedViewId("");
        setSavedViewNameDraft("");
      }
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", savedViewsLabOrgId] });
    },
    onError: (error) => Alert.alert("Could not remove view", error instanceof Error ? error.message : "Please try again."),
  });

  // Reset Cases filters when leaving the Cases section entirely, but preserve
  // them when the exit was into an in-Cases workflow (case detail / new-case),
  // so returning from a case keeps the user's place. The flag is set right
  // before those in-workflow navigations and consumed here on blur.
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (leavingIntoCasesWorkflow) {
          leavingIntoCasesWorkflow = false;
        } else {
          resetFilters();
        }
      };
    }, [resetFilters]),
  );

  // ── Deep-link filters from the Stats screen ────────────────────────────────
  // Tapping a "Cases by category" bar (or a "Sales over time" period bar) on
  // the Stats screen navigates here with a category and/or created-date window.
  // Seed the matching filters once, then strip the params so a later refocus
  // (e.g. returning from a case) doesn't re-apply a filter the user cleared.
  const params = useLocalSearchParams<{
    category?: string;
    createdFrom?: string;
    createdTo?: string;
  }>();
  useEffect(() => {
    const { category, createdFrom, createdTo } = params;
    if (!category && !createdFrom && !createdTo) return;

    if (typeof category === "string" && (CASE_CATEGORY_KEYS as readonly string[]).includes(category)) {
      setCategoryFilter(category as CaseCategory);
    }

    const from = typeof createdFrom === "string" ? new Date(createdFrom) : null;
    const to = typeof createdTo === "string" ? new Date(createdTo) : null;
    const fromValid = from && !Number.isNaN(from.getTime());
    const toValid = to && !Number.isNaN(to.getTime());
    if (fromValid || toValid) {
      setCreatedCustomFrom(fromValid ? from : null);
      setCreatedCustomTo(toValid ? to : null);
      setCreatedFilter("custom");
    }

    // Consume the params so they don't linger and re-seed on the next focus.
    router.setParams({ category: undefined, createdFrom: undefined, createdTo: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.category, params.createdFrom, params.createdTo]);

  // Long press is the one consistent action for active cases. The guard
  // absorbs RN's release onPress after onLongPress without affecting other rows.
  const { markLongPress, consumeLongPress } = useLongPressGuard<string>();
  const [quickActionCase, setQuickActionCase] = useState<CanonicalCase | null>(null);


  // ── Share-intent inbox
  const [pendingShared, setPendingShared] = useState<InboxEntry[]>([]);

  // Without a search term the server returns only the 500 most-recent cases
  // (a deliberate cap to bound query time). With one, it runs the match in SQL
  // across EVERY case in the lab. Labs routinely hold thousands of cases, so
  // filtering purely on the client made anything outside that 500-case window
  // permanently unfindable. Send the term to the server instead.
  //
  // The barcode quick-filter feeds the same param (the server's search covers
  // casePanBarcode); a free-text query wins when both are set, because the
  // barcode filter is then applied client-side as an additional narrowing.
  //
  // Only schedule the debounce when the term actually changed. Scheduling it
  // unconditionally meant every mount wiped the loaded page 300ms later — a
  // state update with no user action behind it, which also lands outside
  // act() in screen tests and aborts the run as an unhandled error.
  const appliedSearchRef = useRef("");
  useEffect(() => {
    const term = query.trim() || barcodeFilter.trim();
    if (term === appliedSearchRef.current) return;
    const t = setTimeout(() => {
      appliedSearchRef.current = term;
      setDebouncedSearch(term);
      setCasePage(1);
      setLoadedCases([]);
    }, 300);
    return () => clearTimeout(t);
  }, [query, barcodeFilter]);

  function dateRangeParams(
    preset: DateFilterPreset,
    from: Date | null,
    to: Date | null,
  ): { start?: string; end?: string } {
    if (preset === "all") return {};
    const today = new Date();
    let start: Date | null = null;
    let end: Date | null = null;
    if (preset === "today") start = end = today;
    else if (preset === "yesterday") start = end = addDays(today, -1);
    else if (preset === "thisWeek") {
      start = startOfWeek(today);
      end = endOfWeek(today);
    } else if (preset === "thisMonth") {
      start = startOfMonth(today);
      end = endOfMonth(today);
    } else {
      start = from ?? new Date(1970, 0, 1);
      end = to ?? new Date(2999, 11, 31);
    }
    const format = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { start: format(start), end: format(end) };
  }

  const dayKey = useDayChange();
  const localNow = new Date();
  const localDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
  const createdRange = dateRangeParams(createdFilter, createdCustomFrom, createdCustomTo);
  const dueRange = dateRangeParams(dueFilter, dueCustomFrom, dueCustomTo);
  const casesRequest = {
    ...(query.trim() && debouncedSearch ? { search: debouncedSearch } : {}),
    ...(!query.trim() && debouncedSearch ? { barcode: debouncedSearch } : {}),
    ...(statusFilter.length ? { status: statusFilter } : {}),
    ...(overdueOnly ? { overdueOnly: true, localDate } : {}),
    ...(categoryFilter ? { category: categoryFilter } : {}),
    ...(typeFilter !== "all" ? { taxonomyType: typeFilter } : {}),
    ...(conflictFilter ? { conflictsOnly: true } : {}),
    ...(createdRange.start ? { createdStart: createdRange.start, createdEnd: createdRange.end } : {}),
    ...(dueRange.start ? { dueStart: dueRange.start, dueEnd: dueRange.end } : {}),
  };
  const casesRequestKey = JSON.stringify(casesRequest);

  useEffect(() => {
    setCasePage(1);
    setLoadedCases([]);
  }, [
    statusFilter,
    overdueOnly,
    categoryFilter,
    typeFilter,
    conflictFilter,
    createdFilter,
    createdCustomFrom,
    createdCustomTo,
    dueFilter,
    dueCustomFrom,
    dueCustomTo,
  ]);
  useEffect(() => {
    if (!overdueOnly) return;
    setCasePage(1);
    setLoadedCases([]);
  }, [dayKey, overdueOnly]);

  const casesQuery = useCasesPage(
    { ...casesRequest, page: casePage, pageSize: 10 },
    // Keep the previous results on screen while a new search resolves so the
    // list doesn't flash empty on every debounce tick.
    { placeholderData: (prev) => prev },
  );
  const overviewQuery = useCasesOverview();
  const cases = loadedCases;
  const matchingTotal =
    casesQuery.data?.requestKey === casesRequestKey ? casesQuery.data.total : null;
  useEffect(() => {
    if (
      !casesQuery.data ||
      casesQuery.data.requestKey !== casesRequestKey ||
      casesQuery.data.page !== casePage
    ) return;
    setLoadedCases((previous) => casesQuery.data!.page === 1
      ? casesQuery.data!.rows
      : [...previous.filter((row) => !casesQuery.data!.rows.some((next) => next.id === row.id)), ...casesQuery.data!.rows]);
  }, [
    casePage,
    casesQuery.data?.page,
    casesQuery.data?.rows,
    casesQuery.data?.requestKey,
    casesRequestKey,
  ]);

  // Recompute relative date labels and date-preset filters ("Today",
  // "Yesterday", "Due today", "Overdue", ...) whenever the local calendar day
  // rolls over or the app resumes on a later day.
  // ── Conflict detection ────────────────────────────────────────────────────
  // A case is "conflicting" when two or more active (non-terminal) cases in the
  // same lab share the same casePanBarcode — mirrors the desktop Conflict badge
  // and the DB partial-unique-index predicate (status <> 'complete').
  const conflictIds = useMemo(() => {
    const counts = new Map<string, string[]>(); // key → [caseId, ...]
    for (const c of cases) {
      const barcode = c.casePanBarcode?.trim();
      if (!barcode) continue;
      const s = (c.status ?? "").toLowerCase();
      // Skip terminal statuses — matches partial-index predicate
      if (
        s.includes("complete") ||
        s.includes("deliver") ||
        s.includes("done") ||
        s.includes("cancel") ||
        s.includes("void")
      ) continue;
      const key = `${c.labOrganizationId ?? ""}::${barcode.toLowerCase()}`;
      const list = counts.get(key);
      if (list) list.push(c.id);
      else counts.set(key, [c.id]);
    }
    const result = new Set<string>();
    for (const c of cases) {
      if (c.hasBarcodeConflict) result.add(c.id);
    }
    for (const ids of counts.values()) {
      if (ids.length >= 2) {
        for (const id of ids) result.add(id);
      }
    }
    return result;
  }, [cases]);

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

  const [savingSharedToInbox, setSavingSharedToInbox] = useState<{ completed: number; total: number } | null>(null);

  async function resolveLabOrgIdForShared(): Promise<string> {
    let labOrganizationId = primaryLabOrgId(meQuery.data) ?? "";
    if (!labOrganizationId && (meQuery.isLoading || meQuery.isPending)) {
      try {
        const freshMe = await meQuery.refetch();
        labOrganizationId = primaryLabOrgId(freshMe.data) ?? "";
      } catch {
        // ignore — falls through to the "no lab" alert below
      }
    }
    return labOrganizationId;
  }

  async function saveSharedToUnassigned() {
    // Non-destructive peek — we only remove entries once we know they
    // actually saved, so a failure (no lab resolved, upload error, etc.)
    // never silently loses the file.
    const entries = await peekSharedFiles();
    if (entries.length === 0) return;
    const labOrganizationId = await resolveLabOrgIdForShared();
    if (!labOrganizationId) {
      Alert.alert(
        "Could not save files",
        "No lab organization found. Please sign out and back in, then try again.",
      );
      return;
    }
    setSavingSharedToInbox({ completed: 0, total: entries.length });
    const summary = await saveSharedFilesToUnassignedDocuments(
      entries,
      labOrganizationId,
      (completed, total) => setSavingSharedToInbox({ completed, total }),
    );
    setSavingSharedToInbox(null);
    if (summary.succeeded.length > 0) {
      await removeSharedFiles(summary.succeeded);
      void qc.invalidateQueries({
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
      });
    }
    if (summary.failures.length === 0) {
      Alert.alert(
        "Saved",
        `${summary.savedCount} file${summary.savedCount === 1 ? "" : "s"} saved to Unassigned Documents.`,
      );
    } else if (summary.savedCount === 0) {
      Alert.alert(
        "Could not save files",
        `${summary.failures.map((f) => `${f.name}: ${f.error}`).join("\n")}\n\nThe file${
          summary.failures.length === 1 ? "" : "s"
        } will remain available to try again.`,
      );
    } else {
      Alert.alert(
        "Some files could not be saved",
        `Saved ${summary.savedCount} of ${entries.length}. Failed (still pending, try again): ${summary.failures
          .map((f) => f.name)
          .join(", ")}`,
      );
    }
  }

  function handleSharedBannerPress() {
    if (pendingShared.length === 0 || savingSharedToInbox) return;
    Alert.alert(
      "Shared files",
      `${pendingShared.length} file${pendingShared.length === 1 ? "" : "s"} ready. Save ${
        pendingShared.length === 1 ? "it" : "them"
      } to Unassigned Documents, or discard?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => void dismissShared() },
        { text: "Save to Unassigned Documents", onPress: () => void saveSharedToUnassigned() },
      ],
    );
  }

  // ── Filtering ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = cases;

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, dayKey]);

  // ── Date preset matching helper ─────────────────────────────────────────
  function dateMatchesPreset(
    d: Date,
    today: Date,
    preset: DateFilterPreset,
    from: Date | null,
    to: Date | null,
  ): boolean {
    const todayStart = startOfDay(today);
    const todayEnd = endOfDay(today);
    const yesterdayStart = startOfDay(addDays(today, -1));
    const yesterdayEnd = endOfDay(addDays(today, -1));
    const weekStart = startOfWeek(today);
    const weekEnd = endOfWeek(today);
    const monthStart = startOfMonth(today);
    const monthEnd = endOfMonth(today);

    if (preset === "today") return d >= todayStart && d <= todayEnd;
    if (preset === "yesterday") return d >= yesterdayStart && d <= yesterdayEnd;
    if (preset === "thisWeek") return d >= weekStart && d <= weekEnd;
    if (preset === "thisMonth") return d >= monthStart && d <= monthEnd;
    if (preset === "custom") {
      if (from && d < startOfDay(from)) return false;
      if (to && d > endOfDay(to)) return false;
      return true;
    }
    return true;
  }

  // ── Custom date modal actions ─────────────────────────────────────────────
  function openCustomModal(target: "created" | "due") {
    setCustomTarget(target);
    const from = target === "created" ? createdCustomFrom : dueCustomFrom;
    const to = target === "created" ? createdCustomTo : dueCustomTo;
    const toMDY = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
    setDraftFrom(from ? toMDY(from) : "");
    setDraftTo(to ? toMDY(to) : "");
    setShowCustomModal(true);
  }

  function clearCustom(target?: "created" | "due") {
    if (!target || target === "created") {
      setCreatedCustomFrom(null);
      setCreatedCustomTo(null);
      setCreatedFilter("all");
    }
    if (!target || target === "due") {
      setDueCustomFrom(null);
      setDueCustomTo(null);
      setDueFilter("all");
    }
    setDraftFrom("");
    setDraftTo("");
    setShowCustomModal(false);
  }

  // ── Chip labels ──────────────────────────────────────────────────────────
  function dateChipLabel(target: "created" | "due"): string {
    const filter = target === "created" ? createdFilter : dueFilter;
    if (filter === "today") return "Today";
    if (filter === "yesterday") return "Yesterday";
    if (filter === "thisWeek") return "This week";
    if (filter === "thisMonth") return "This month";
    if (filter === "custom") {
      const from = target === "created" ? createdCustomFrom : dueCustomFrom;
      const to = target === "created" ? createdCustomTo : dueCustomTo;
      if (!from && !to) return "Custom…";
      const parts: string[] = [];
      if (from) parts.push(`${formatShort(from)}/${String(from.getFullYear()).padStart(4, "0")}`);
      if (to) parts.push(`${formatShort(to)}/${String(to.getFullYear()).padStart(4, "0")}`);
      return parts.join(" \u2013 ");
    }
    return target === "created" ? "Date" : "Date due";
  }

  function clearAllDates() {
    setCreatedFilter("all");
    setDueFilter("all");
    setCreatedCustomFrom(null);
    setCreatedCustomTo(null);
    setDueCustomFrom(null);
    setDueCustomTo(null);
    setDraftFrom("");
    setDraftTo("");
  }

  // ── Status chip label ────────────────────────────────────────────────────
  // Mirrors the desktop MultiSelectFilter summary: the bare noun when nothing
  // is checked, the single option's label when exactly one is, and a count
  // otherwise, so the number of selected statuses is always visible.
  const statusFilterLabel = useMemo(() => {
    if (statusFilter.length === 0) return "Location";
    if (statusFilter.length === 1) {
      return CASE_STATIONS.find((s) => s.value === statusFilter[0])?.label ?? titleCase(statusFilter[0]);
    }
    return `${statusFilter.length} selected`;
  }, [statusFilter]);

  // ── Type chip label ──────────────────────────────────────────────────────
  const typeFilterLabel = useMemo(() => {
    if (typeFilter === "all") return "Type";
    return TYPE_FILTER_OPTIONS.find((o) => o.value === typeFilter)?.label ?? "Type";
  }, [typeFilter]);

  const activeFilters =
    createdFilter !== "all" || dueFilter !== "all" || statusFilter.length > 0 || overdueOnly || barcodeFilter.trim().length > 0 || conflictFilter || categoryFilter !== "" || typeFilter !== "all";

  // Includes the text search too — drives the visible Reset filters control.
  const anyFilterActive = activeFilters || query.trim().length > 0;
  const isQuickFilterActive = (id: string, statuses: readonly string[]) => {
    if (id === "overdue") return overdueOnly;
    if (overdueOnly) return false;
    return statuses.length === statusFilter.length &&
      statuses.every((status) => statusFilter.includes(status));
  };
  const applyQuickFilter = (id: string, statuses: readonly string[]) => {
    if (id === "overdue") {
      setStatusFilter([]);
      setOverdueOnly((active) => !active);
      return;
    }
    const selected = isQuickFilterActive(id, statuses);
    setStatusFilter(selected ? [] : [...statuses]);
    setOverdueOnly(false);
  };
  const quickFilterCount = (id: string) => {
    const counts = overviewQuery.isLoading || overviewQuery.isError ? undefined : overviewQuery.data;
    if (id === "processing") return counts?.processingCases;
    if (id === "received") return counts?.receivedCases;
    if (id === "inDesign") return counts?.inDesignCases;
    if (id === "modelRoom") return counts?.modelRoomCases;
    if (id === "scan") return counts?.scanCases;
    if (id === "milling") return counts?.millingCases;
    if (id === "postMill") return counts?.postMillCases;
    if (id === "sinteringFurnace") return counts?.sinteringFurnaceCases;
    if (id === "porcelain") return counts?.porcelainCases;
    if (id === "qualityCheck") return counts?.qualityCheckCases;
    if (id === "onHold") return counts?.onHoldCases;
    if (id === "remake") return counts?.remakeCases;
    if (id === "shipped") return counts?.shippedCases;
    if (id === "overdue") return counts?.overdueCases;
    return counts?.totalCases;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    // The whole screen is a keyboard-dismissal surface: tapping the title, the
    // case count, the search row's padding, the chip row background, or empty
    // space behind the results closes the keyboard without touching the search
    // text or any active filter. Rows, chips and buttons keep their own taps.
    <DismissKeyboardView
      style={styles.screen}
      testID="cases-keyboard-dismiss"
    >
      <View style={[styles.hero, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Cases</Text>
            <Text style={styles.subtitle}>
              {casesQuery.isLoading || matchingTotal === null
                ? "Loading…"
                : `${matchingTotal.toLocaleString()} case${matchingTotal === 1 ? "" : "s"}${activeFilters || query.trim() ? " (filtered)" : ""}`}
            </Text>
          </View>
          <Pressable
            style={styles.newBtn}
            onPress={() => {
              leavingIntoCasesWorkflow = true;
              router.push("/new-case" as never);
            }}
            testID="new-case-button"
          >
            <Ionicons name="add" size={18} color={colors.textInverse} />
            <Text style={styles.newBtnText}>New Case</Text>
          </Pressable>
        </View>

        <View style={styles.searchRow}>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={19} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search patient, doctor, or case #"
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
              testID="cases-search"
            />
            {query.length > 0 ? (
              <Pressable onPress={() => setQuery("")} hitSlop={8} accessibilityLabel="Clear case search">
                <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
              </Pressable>
            ) : null}
            <View style={styles.searchDivider} />
            <Pressable
              style={styles.scanBtn}
              onPress={openScanModal}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel="Scan or enter a case barcode"
              testID="cases-scan-barcode"
            >
              <Ionicons name="barcode-outline" size={23} color={colors.tint} />
            </Pressable>
          </View>
        </View>
      </View>

      <CasesSummary
        data={overviewQuery.data}
        isLoading={overviewQuery.isLoading}
        isError={overviewQuery.isError}
        onRetry={() => void overviewQuery.refetch()}
      />

      <View style={styles.quickFiltersRow} testID="cases-status-quick-filters">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.quickFiltersContent}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            style={styles.quickFilter}
            onPress={() => setShowSavedViewsModal(true)}
            accessibilityRole="button"
            testID="cases-saved-views-open"
          >
            <Ionicons name="bookmark-outline" size={13} color={colors.tint} />
            <Text style={[styles.quickFilterText, { color: colors.tint }]}>Saved views</Text>
          </Pressable>
          {CASE_STATUS_QUICK_FILTERS.map(({ id, label, statuses }) => {
            const active = isQuickFilterActive(id, statuses);
            const count = quickFilterCount(id);
            return (
              <Pressable
                key={id}
                style={[styles.quickFilter, active && { backgroundColor: colors.tint, borderColor: colors.tint }]}
                onPress={() => applyQuickFilter(id, statuses)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                testID={`cases-quick-filter-${id}`}
              >
                <Text style={[styles.quickFilterText, active && { color: colors.textInverse }]}>
                  {label}{count !== undefined ? ` (${count.toLocaleString()})` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <Modal
        visible={showSavedViewsModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSavedViewsModal(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowSavedViewsModal(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>
        <View style={[styles.modalSheet, { top: 0, justifyContent: "center", padding: Spacing.lg }]}>
          <DismissKeyboardView
            style={[styles.sheetInner, { maxHeight: "84%", paddingBottom: Math.max(insets.bottom, Spacing.lg), borderRadius: Radius.xl }]}
            testID="cases-saved-view-keyboard-dismiss"
          >
            <View style={styles.sheetHandle} />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={styles.sheetTitle}>Saved Cases views</Text>
              <Pressable onPress={() => setShowSavedViewsModal(false)} hitSlop={10} accessibilityLabel="Close saved views">
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.sheetHint}>
              Shared with your lab team. Mobile created and due dates stay separate.
            </Text>
            {savedViewsQuery.isError ? (
              <Text style={{ color: colors.error }}>Saved views could not be loaded. Close and reopen to retry.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 250 }} keyboardShouldPersistTaps="handled">
                {(savedViewsQuery.data ?? []).map((view) => {
                  const selected = selectedSavedViewId === view.id;
                  return (
                    <View
                      key={view.id}
                      style={{
                        minHeight: 48,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.border,
                        paddingVertical: Spacing.sm,
                        paddingHorizontal: Spacing.xs,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        backgroundColor: selected ? colors.tint + "12" : "transparent",
                      }}
                    >
                      <Pressable
                        onPress={() => {
                          setSelectedSavedViewId(view.id);
                          setSavedViewNameDraft(view.name);
                        }}
                        style={{ flex: 1, paddingVertical: Spacing.sm }}
                        testID={`cases-saved-view-row-${view.id}`}
                      >
                        <Text style={{ color: selected ? colors.tint : colors.text, fontWeight: selected ? "600" : "400" }}>
                          {view.name}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          applySavedCaseView(view);
                          setShowSavedViewsModal(false);
                        }}
                        style={[styles.applyBtn, { backgroundColor: colors.tint }]}
                        testID={`cases-saved-view-apply-${view.id}`}
                      >
                        <Text style={[styles.applyBtnText, { color: colors.textInverse }]}>Apply</Text>
                      </Pressable>
                    </View>
                  );
                })}
                {!savedViewsQuery.isLoading && !savedViewsQuery.data?.length && (
                  <Text style={{ color: colors.textSecondary, paddingVertical: Spacing.md }}>No shared views yet.</Text>
                )}
              </ScrollView>
            )}
            {savedViewsLabOrgId ? (
              <>
                <TextInput
                  value={savedViewNameDraft}
                  onChangeText={setSavedViewNameDraft}
                  placeholder="Name this view"
                  placeholderTextColor={colors.textTertiary}
                  maxLength={60}
                  accessibilityLabel="Saved view name"
                  testID="cases-saved-view-name"
                  style={{
                    minHeight: 44,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: Radius.md,
                    paddingHorizontal: Spacing.md,
                    color: colors.text,
                    backgroundColor: colors.surface,
                  }}
                />
                <View style={styles.sheetActions}>
                  <Pressable
                    style={[styles.clearBtn, { borderColor: colors.border, minWidth: "46%" }]}
                    disabled={!savedViewNameDraft.trim() || createSavedViewMutation.isPending}
                    onPress={() => createSavedViewMutation.mutate(savedViewNameDraft.trim())}
                    testID="cases-saved-view-save"
                  >
                    <Text style={[styles.clearBtnText, { color: colors.tint }]}>Save current filters</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.applyBtn, { backgroundColor: colors.tint, minWidth: "46%" }]}
                    disabled={!selectedSavedViewId || updateSavedViewFiltersMutation.isPending}
                    onPress={() => {
                      const view = savedViewsQuery.data?.find((item) => item.id === selectedSavedViewId);
                      if (!view) return;
                      Alert.alert(
                        "Update shared view?",
                        `“${view.name}” will be updated for everyone in your lab with the current search, status, and mobile created/due date filters.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Update filters",
                            onPress: () => {
                              const filters: CaseSavedViewFilters = {
                                search: query.trim(),
                                statusFilters: [...statusFilter],
                                mobile: {
                                  createdFilter,
                                  createdCustomFrom: calendarDateString(createdCustomFrom),
                                  createdCustomTo: calendarDateString(createdCustomTo),
                                  dueFilter,
                                  dueCustomFrom: calendarDateString(dueCustomFrom),
                                  dueCustomTo: calendarDateString(dueCustomTo),
                                },
                                ...(view.filters.desktop ? { desktop: view.filters.desktop } : {}),
                              };
                              updateSavedViewFiltersMutation.mutate({ id: view.id, filters });
                            },
                          },
                        ],
                      );
                    }}
                    testID="cases-saved-view-update"
                  >
                    <Text style={[styles.applyBtnText, { color: colors.textInverse }]}>Update filters</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.applyBtn, { backgroundColor: colors.tint, minWidth: "46%" }]}
                    disabled={!selectedSavedViewId || !savedViewNameDraft.trim() || renameSavedViewMutation.isPending}
                    onPress={() => renameSavedViewMutation.mutate({ id: selectedSavedViewId, name: savedViewNameDraft.trim() })}
                    testID="cases-saved-view-rename"
                  >
                    <Text style={[styles.applyBtnText, { color: colors.textInverse }]}>Rename</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.clearBtn, { borderColor: colors.error, minWidth: "46%" }]}
                    disabled={!selectedSavedViewId || deleteSavedViewMutation.isPending}
                    onPress={() => {
                      const view = savedViewsQuery.data?.find((item) => item.id === selectedSavedViewId);
                      if (!view) return;
                      Alert.alert("Remove shared view?", `“${view.name}” will be removed for everyone in this lab.`, [
                        { text: "Cancel", style: "cancel" },
                        { text: "Remove", style: "destructive", onPress: () => deleteSavedViewMutation.mutate(view.id) },
                      ]);
                    }}
                    testID="cases-saved-view-delete"
                  >
                    <Text style={[styles.clearBtnText, { color: colors.error }]}>Remove</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <Text style={{ color: colors.textSecondary }}>Your lab is still loading.</Text>
            )}
          </DismissKeyboardView>
        </View>
      </Modal>

      {/* Trial status banner */}
      <MobileTrialBanner />

      {/* Share-intent banner */}
      {pendingShared.length > 0 ? (
        <Pressable style={styles.shareBanner} onPress={handleSharedBannerPress} testID="share-banner">
          {savingSharedToInbox ? (
            <ActivityIndicator size="small" color={colors.tint} />
          ) : (
            <Ionicons name="cloud-upload-outline" size={18} color={colors.tint} />
          )}
          <Text style={styles.shareBannerText}>
            {savingSharedToInbox
              ? `Saving to Unassigned Documents… (${savingSharedToInbox.completed}/${savingSharedToInbox.total})`
              : `${pendingShared.length} file${pendingShared.length === 1 ? "" : "s"} ready — tap to save or discard.`}
          </Text>
          {!savingSharedToInbox && <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />}
        </Pressable>
      ) : null}

      {/* ── Detailed filters ── */}
      <View style={styles.filterRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipScroll}
          // Without this the row would swallow the first chip tap while the
          // keyboard is up (RN's default is to spend that tap on dismissal).
          keyboardShouldPersistTaps="handled"
        >
          {/* All — clears both date filters */}
          <Pressable
            style={[
              styles.chip,
              createdFilter === "all" && dueFilter === "all" && { backgroundColor: colors.tint, borderColor: colors.tint },
            ]}
            onPress={clearAllDates}
          >
            <Text
              style={[
                styles.chipText,
                createdFilter === "all" && dueFilter === "all" && { color: colors.textInverse },
              ]}
            >
              All
            </Text>
          </Pressable>

          {/* Date created chip */}
          <Pressable
            testID="cases-date-filter-chip"
            accessibilityLabel={`Date, created: ${dateChipLabel("created")}`}
            style={[
              styles.chip,
              createdFilter !== "all" && { backgroundColor: colors.tint, borderColor: colors.tint },
            ]}
            onPress={() => {
              setDatePickerTarget("created");
              setShowDatePicker(true);
            }}
          >
            <Ionicons
              name="time-outline"
              size={13}
              color={createdFilter !== "all" ? colors.textInverse : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                createdFilter !== "all" && { color: colors.textInverse },
              ]}
            >
              {createdFilter === "all" ? "Date" : `Date: ${dateChipLabel("created")}`}
            </Text>
            {createdFilter !== "all" && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); clearCustom("created"); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.textInverse} />
              </Pressable>
            )}
          </Pressable>

          {/* Date due chip */}
          <Pressable
            testID="cases-due-date-filter-chip"
            accessibilityLabel={`Date due: ${dateChipLabel("due")}`}
            style={[
              styles.chip,
              dueFilter !== "all" && { backgroundColor: colors.tint, borderColor: colors.tint },
            ]}
            onPress={() => {
              setDatePickerTarget("due");
              setShowDatePicker(true);
            }}
          >
            <Ionicons
              name="calendar-outline"
              size={13}
              color={dueFilter !== "all" ? colors.textInverse : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                dueFilter !== "all" && { color: colors.textInverse },
              ]}
            >
              {dueFilter === "all" ? "Date due" : `Date due: ${dateChipLabel("due")}`}
            </Text>
            {dueFilter !== "all" && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); clearCustom("due"); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.textInverse} />
              </Pressable>
            )}
          </Pressable>

          {/* Divider */}
          <View style={styles.chipDivider} />

          {/* Status chip — multi-select */}
          <Pressable
            style={[
              styles.chip,
              statusFilter.length > 0 && { backgroundColor: colors.violet + "22", borderColor: colors.violet },
            ]}
            onPress={() => {
              setStatusDraft(statusFilter);
              setShowStatusModal(true);
            }}
            testID="cases-status-filter-chip"
          >
            <Ionicons
              name="flag-outline"
              size={13}
              color={statusFilter.length > 0 ? colors.violet : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                statusFilter.length > 0 && { color: colors.violet },
              ]}
            >
              {statusFilterLabel}
            </Text>
            <Ionicons
              name="chevron-down"
              size={12}
              color={statusFilter.length > 0 ? colors.violet : colors.textTertiary}
              style={{ marginLeft: 2 }}
            />
            {statusFilter.length > 0 && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e?.stopPropagation?.(); setStatusFilter([]); setOverdueOnly(false); }}
                style={{ marginLeft: 4 }}
                testID="cases-status-filter-chip-clear"
              >
                <Ionicons name="close-circle" size={14} color={colors.violet} />
              </Pressable>
            )}
          </Pressable>

          {/* Case Type chip */}
          <Pressable
            style={[
              styles.chip,
              typeFilter !== "all" && { backgroundColor: colors.violet + "22", borderColor: colors.violet },
            ]}
            onPress={() => {
              setShowTypeModal(true);
            }}
            testID="cases-type-filter-chip"
          >
            <Ionicons
              name="pricetag-outline"
              size={13}
              color={typeFilter !== "all" ? colors.violet : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                typeFilter !== "all" && { color: colors.violet },
              ]}
            >
              {typeFilterLabel}
            </Text>
            <Ionicons
              name="chevron-down"
              size={12}
              color={typeFilter !== "all" ? colors.violet : colors.textTertiary}
              style={{ marginLeft: 2 }}
            />
            {typeFilter !== "all" && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); setTypeFilter("all"); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color={colors.violet} />
              </Pressable>
            )}
          </Pressable>

          {/* Category chip — only shown when seeded from the Stats screen */}
          {categoryFilter !== "" && (
            <Pressable
              style={[
                styles.chip,
                { backgroundColor: colors.tint + "22", borderColor: colors.tint },
              ]}
              onPress={() => setCategoryFilter("")}
              testID="cases-category-filter-chip"
            >
              <Ionicons
                name="bar-chart-outline"
                size={13}
                color={colors.tint}
                style={{ marginRight: 4 }}
              />
              <Text style={[styles.chipText, { color: colors.tint }]}>
                {CATEGORY_FILTER_LABELS[categoryFilter]}
              </Text>
              <Ionicons name="close-circle" size={14} color={colors.tint} style={{ marginLeft: 4 }} />
            </Pressable>
          )}

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

          {/* Divider */}
          <View style={styles.chipDivider} />

          {/* Conflicts chip — narrows list to cases with duplicate active barcodes */}
          <Pressable
            style={[
              styles.chip,
              conflictFilter && { backgroundColor: "#F59E0B22", borderColor: "#F59E0B" },
            ]}
            onPress={() => setConflictFilter((v) => !v)}
            testID="cases-conflict-filter-chip"
          >
            <Ionicons
              name="alert-circle-outline"
              size={14}
              color={conflictFilter ? "#D97706" : colors.textSecondary}
              style={{ marginRight: 4 }}
            />
            <Text
              style={[
                styles.chipText,
                conflictFilter && { color: "#D97706" },
              ]}
            >
              Conflicts
            </Text>
            {conflictFilter && (
              <Pressable
                hitSlop={8}
                onPress={(e) => { e.stopPropagation(); setConflictFilter(false); }}
                style={{ marginLeft: 4 }}
              >
                <Ionicons name="close-circle" size={14} color="#D97706" />
              </Pressable>
            )}
          </Pressable>

          {/* Reset filters — clears every record-hiding filter at once */}
          {anyFilterActive && (
            <>
              <View style={styles.chipDivider} />
              <Pressable
                style={[styles.chip, { borderColor: colors.error }]}
                onPress={resetFilters}
                testID="cases-reset-filters-chip"
              >
                <Ionicons
                  name="close-circle-outline"
                  size={14}
                  color={colors.error}
                  style={{ marginRight: 4 }}
                />
                <Text style={[styles.chipText, { color: colors.error }]}>
                  Reset filters
                </Text>
              </Pressable>
            </>
          )}
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
              onSubmitEditing={() => Keyboard.dismiss()}
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
            const work = getCompactWorkDetails(item);
            const materials = Array.from(new Set(
              (item.restorationMaterials ?? "")
                .split(",")
                .map((material) => material.trim())
                .filter(Boolean),
            ));
            const workMaterial = materials.length > 1 ? materials.join(", ") : (materials[0] ?? work.material);
            const detailLabel = work.detail;
            const hasConflict = Boolean(item.hasBarcodeConflict) || conflictIds.has(item.id);
            const status = canonicalCaseStatus(item.status);
            const isComplete = status === "complete" || status === "delivered";
            const dueDayDiff = getDueDayDiff(item.dueDate);
            const isOverdue = dueDayDiff !== null &&
              (dueDayDiff < 0 || (dueDayDiff === 0 && isDueTimePast(item.dueTime)));
            const duePanelLabel = isComplete
              ? "COMPLETED"
              : dueDayDiff === null
                ? "NO DUE DATE"
                : isOverdue
                  ? "OVERDUE"
                  : dueDayDiff === 0
                    ? "DUE TODAY"
                    : "DUE IN";
            const duePanelValue = isComplete
              ? "✓"
              : dueDayDiff === null
                ? "—"
                : isOverdue
                  ? dueDayDiff === 0 ? "TODAY" : String(Math.abs(dueDayDiff))
                  : dueDayDiff === 0 ? "TODAY" : String(dueDayDiff);
            const duePanelFoot = isComplete
              ? formatCompletedAt(item.updatedAt).replace(/^Completed\s*/, "")
              : dueDayDiff === null
                ? "Add a due date"
                : isOverdue
                  ? dueDayDiff === 0 ? "Due time passed" : `DAY${Math.abs(dueDayDiff) === 1 ? "" : "S"} AGO`
                  : dueDayDiff === 0 ? "" : `DAY${dueDayDiff === 1 ? "" : "S"}`;
            return (
              <Pressable
                onPress={() => {
                  if (consumeLongPress(item.id)) return;
                  leavingIntoCasesWorkflow = true;
                  router.push(`/case/${item.id}` as never);
                }}
                onLongPress={() => {
                  if (!isActiveCaseRecord(item)) return;
                  markLongPress(item.id);
                  Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});
                  setQuickActionCase(item);
                }}
                delayLongPress={400}
                testID={`case-card-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${patientName(item)}${item.caseNumber ? `, case ${item.caseNumber}` : ""}`}
                accessibilityHint={
                  isActiveCaseRecord(item)
                    ? "Tap to open case details. Long press for quick actions."
                    : "Tap to open case details."
                }
                style={({ pressed }) => [
                  pressed ? styles.rowPressed : undefined,
                ]}
              >
                <Card
                  padding="none"
                  style={[
                    styles.caseCard,
                    item.priority === "rush" && { borderLeftColor: colors.error, borderLeftWidth: 4 },
                  ]}
                >
                  <View style={styles.caseCardInner}>
                    <View style={styles.caseCardTop}>
                      <View style={styles.caseCopy}>
                        <Text style={styles.casePatient} numberOfLines={2}>{patientName(item)}</Text>
                        {item.doctorName ? (
                          <Text style={styles.caseDoctor} numberOfLines={1}>{item.doctorName}</Text>
                        ) : null}
                        {workMaterial || detailLabel || item.priority === "rush" || hasConflict ? (
                          <View style={styles.caseWorkRow} testID={`compact-case-details-${item.id}`}>
                            {workMaterial ? <Text style={styles.caseMaterial}>{workMaterial}</Text> : null}
                            {detailLabel ? (
                              <View style={styles.caseDetailChip}>
                                <Text style={styles.caseDetailText}>{detailLabel}</Text>
                              </View>
                            ) : null}
                            {item.priority === "rush" ? (
                              <View style={styles.rushBadge} testID={`rush-badge-${item.id}`}>
                                <Text style={styles.rushBadgeText}>Rush</Text>
                              </View>
                            ) : null}
                            {hasConflict ? (
                              <View style={styles.conflictBadge} testID={`conflict-badge-${item.id}`}>
                                <Ionicons name="alert-circle" size={12} color={colors.warningStrong} />
                                <Text style={styles.conflictBadgeText}>Conflict</Text>
                              </View>
                            ) : null}
                          </View>
                        ) : null}
                      </View>
                      <View
                        style={[
                          styles.duePanel,
                          isOverdue && !isComplete && styles.duePanelOverdue,
                          isComplete && styles.duePanelComplete,
                        ]}
                        accessibilityLabel={
                          isComplete ? formatCompletedAt(item.updatedAt) :
                            dueDayDiff === null ? "No due date" : formatRelativeDue(item.dueDate, item.dueTime)
                        }
                        testID={`case-due-panel-${item.id}`}
                      >
                        <Text style={[styles.duePanelLabel, isOverdue && !isComplete && { color: colors.error }]}>
                          {duePanelLabel}
                        </Text>
                        <Text style={[styles.duePanelValue, isOverdue && !isComplete && { color: colors.error }, isComplete && { color: colors.successStrong }]}>
                          {duePanelValue}
                        </Text>
                        <Text style={[styles.duePanelFoot, isComplete && styles.completedDate]} numberOfLines={2}>
                          {duePanelFoot}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={19} color={colors.textSecondary} />
                    </View>
                    <View style={styles.caseFooter}>
                      <View style={styles.caseFooterBadges}>
                        <StatusBadge label={caseLocationLabel(item)} variant={statusVariant(item.status)} />
                        {work.typeLabel === "C" || work.typeLabel === "D" || work.typeLabel === "O" ? (
                          <TypeBadge letter={work.typeLabel} />
                        ) : work.typeLabel ? (
                          <View style={styles.caseTypeTextBadge}>
                            <Text style={styles.caseTypeText}>{work.typeLabel}</Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.createdLabel}>
                        <Ionicons name="calendar-outline" size={15} color={colors.textSecondary} />
                        <Text style={styles.createdDate} numberOfLines={1}>
                          {formatRelativeCreated(item.createdAt) || "Created date unavailable"}
                        </Text>
                      </View>
                    </View>
                  </View>
                </Card>
              </Pressable>
            );
          }}
          testID="cases-list"
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          // Dragging the results closes the keyboard (interactively on iOS).
          keyboardDismissMode={scrollKeyboardDismissMode}
          refreshControl={
            <RefreshControl
              refreshing={casesQuery.isFetching}
              onRefresh={() => {
                void qc.invalidateQueries({ queryKey: ["cases", "paged"] });
              void overviewQuery.refetch();
                if (casePage === 1) {
                  void casesQuery.refetch();
                } else {
                  setLoadedCases([]);
                  setCasePage(1);
                }
              }}
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
          ListFooterComponent={
            casesQuery.data?.hasMore ? (
              <Pressable
                testID="cases-load-more"
                style={styles.retryBtn}
                disabled={casesQuery.isFetching}
                onPress={() => setCasePage((current) => current + 1)}
              >
                <Text style={styles.retryText}>
                  {casesQuery.isFetching ? "Loading…" : `Load more (${loadedCases.length} of ${casesQuery.data.total})`}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}

      {/* ══ Date Picker Sheet Modal ═════════════════════════════════════════════════════ */}
      <Modal
        visible={showDatePicker}
        transparent
        animationType='slide'
        onRequestClose={() => setShowDatePicker(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowDatePicker(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>

        <View style={styles.modalSheet}>
          <View style={[styles.sheetInner, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {datePickerTarget === 'created' ? 'Date created' : 'Date due'}
            </Text>

            <ScrollView style={styles.locationList} bounces={false}>
              {DATE_PRESET_OPTIONS.map((opt) => {
                const isActive =
                  (datePickerTarget === 'created' ? createdFilter : dueFilter) === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    style={styles.locationRow}
                    onPress={() => {
                      if (opt.value === 'custom') {
                        setShowDatePicker(false);
                        openCustomModal(datePickerTarget);
                        return;
                      }
                      if (datePickerTarget === 'created') {
                        setCreatedFilter(opt.value);
                      } else {
                        setDueFilter(opt.value);
                      }
                      setShowDatePicker(false);
                    }}
                  >
                    <View style={[
                      styles.locationCheckbox,
                      isActive && { backgroundColor: colors.tint, borderColor: colors.tint },
                      !isActive && { borderColor: colors.border },
                    ]}>
                      {isActive && <Ionicons name='checkmark' size={13} color='#fff' />}
                    </View>
                    <Text style={[styles.locationLabel, { color: isActive ? colors.tint : colors.text }]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.sheetActions}>
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  if (datePickerTarget === 'created') {
                    setCreatedFilter('all');
                  } else {
                    setDueFilter('all');
                  }
                  if (datePickerTarget === 'created') {
                    setCreatedCustomFrom(null);
                    setCreatedCustomTo(null);
                  } else {
                    setDueCustomFrom(null);
                    setDueCustomTo(null);
                  }
                  setShowDatePicker(false);
                }}
              >
                <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
              </Pressable>
              <Pressable
                style={[styles.applyBtn, { backgroundColor: colors.tint }]}
                onPress={() => setShowDatePicker(false)}
              >
                <Text style={[styles.applyBtnText, { color: colors.textInverse }]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ Custom Date Range Modal ══════════════════════════════════════════ */}
      {showCustomModal && <CaseRangeWindow
        context={customTarget}
        start={parseRangeDate(draftFrom) ?? ""}
        end={parseRangeDate(draftTo) ?? ""}
        onCancel={() => setShowCustomModal(false)}
        onApply={(start, end) => {
          const localDate = (s: string) => {
            const [y, m, d] = s.split("-").map(Number);
            const date = new Date(0);
            date.setHours(0, 0, 0, 0); date.setFullYear(y, m - 1, d);
            return date;
          };
          if (customTarget === "created") {
            setCreatedCustomFrom(localDate(start)); setCreatedCustomTo(localDate(end)); setCreatedFilter("custom");
          } else {
            setDueCustomFrom(localDate(start)); setDueCustomTo(localDate(end)); setDueFilter("custom");
          }
          setShowCustomModal(false);
        }}
      />}

      {/* ══ Status Picker Modal (multi-select) ═══════════════════════════════ */}
      <Modal
        visible={showStatusModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowStatusModal(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowStatusModal(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>

        <View style={[styles.modalSheet, styles.locationSheet]}>
          <View
            testID="cases-status-sheet-panel"
            style={[styles.sheetInner, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}
          >
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Filter by location</Text>
            <Text style={styles.sheetHint} testID="cases-status-filter-summary">
              {statusDraft.length === 0
                ? "All locations"
                : `${statusDraft.length} selected`}
            </Text>

            <ScrollView style={styles.locationList} bounces={false}>
              {CASE_STATIONS.map((station) => {
                const checked = statusDraft.includes(station.value);
                return (
                  <Pressable
                    key={station.value}
                    style={styles.locationRow}
                    testID={`cases-status-option-${station.value}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    onPress={() => {
                      setStatusDraft((prev) =>
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
                testID="cases-status-clear"
                onPress={() => {
                  setStatusDraft([]);
                  setStatusFilter([]);
                  setOverdueOnly(false);
                  setShowStatusModal(false);
                }}
              >
                <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
              </Pressable>
              <Pressable
                style={[styles.applyBtn, { backgroundColor: colors.violet }]}
                testID="cases-status-apply"
                onPress={() => {
                  setStatusFilter(statusDraft);
                  setOverdueOnly(false);
                  setShowStatusModal(false);
                }}
              >
                <Text style={[styles.applyBtnText, { color: "#fff" }]}>
                  {statusDraft.length === 0
                    ? "Show all"
                    : `Show ${statusDraft.length} status${statusDraft.length === 1 ? "" : "es"}`}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ Case Type Picker Modal ═══════════════════════════════════════════ */}
      <Modal
        visible={showTypeModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTypeModal(false)}
      >
        <TouchableWithoutFeedback onPress={() => setShowTypeModal(false)}>
          <View style={styles.modalBackdrop} />
        </TouchableWithoutFeedback>

        <View style={styles.modalSheet}>
          <View style={[styles.sheetInner, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Filter by case type</Text>

            <ScrollView style={styles.locationList} bounces={false}>
              {TYPE_FILTER_OPTIONS.map((opt) => {
                const isActive = typeFilter === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    style={styles.locationRow}
                    testID={`cases-type-option-${opt.value}`}
                    onPress={() => {
                      setTypeFilter(opt.value);
                      setShowTypeModal(false);
                    }}
                  >
                    <View style={[
                      styles.locationCheckbox,
                      isActive && { backgroundColor: colors.violet, borderColor: colors.violet },
                      !isActive && { borderColor: colors.border },
                    ]}>
                      {isActive && <Ionicons name="checkmark" size={13} color="#fff" />}
                    </View>
                    <Text style={[styles.locationLabel, { color: isActive ? colors.violet : colors.text }]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.sheetActions}>
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  setTypeFilter("all");
                  setShowTypeModal(false);
                }}
              >
                <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
              </Pressable>
              <Pressable
                style={[styles.applyBtn, { backgroundColor: colors.violet }]}
                onPress={() => setShowTypeModal(false)}
              >
                <Text style={[styles.applyBtnText, { color: "#fff" }]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <CaseQuickActionSheet
        visible={quickActionCase !== null}
        caseItem={quickActionCase}
        onDismiss={() => setQuickActionCase(null)}
        returnedWizardHandoff
      />

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
            !cameraHasPermission ? (
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
                testID="scan-camera-wrap"
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  cameraViewSize.current = { width, height };
                }}
              >
                {!scanScanned && cameraDevice && (
                  <Camera
                    style={StyleSheet.absoluteFill}
                    device={cameraDevice}
                    isActive
                    codeScanner={scanSearching ? undefined : scanCodeScanner}
                    torch={scanTorchOn ? "on" : "off"}
                  />
                )}
                {!scanScanned && cameraDevice?.hasTorch ? (
                  <View style={styles.scanTorchBtnWrap}>
                    <TorchToggleButton
                      torchOn={scanTorchOn}
                      onToggle={() => setScanTorchOn((v) => !v)}
                      testID="scan-torch-toggle"
                    />
                  </View>
                ) : null}
                {/* Reticle corners */}
                <View style={styles.scanReticle} pointerEvents="none">
                  <View style={styles.scanCornerTL} />
                  <View style={styles.scanCornerTR} />
                  <View style={styles.scanCornerBL} />
                  <View style={styles.scanCornerBR} />
                </View>
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
              {/* Tapping anywhere in the manual pane that isn't the field or a
                  button closes the keyboard; the dialog stays open. */}
              <DismissKeyboardView
                style={styles.scanManualInner}
                testID="cases-manual-barcode-keyboard-dismiss"
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
              </DismissKeyboardView>
            </KeyboardAvoidingView>
          )}
        </View>
      </Modal>
    </DismissKeyboardView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.surfaceAlt },
    hero: {
      backgroundColor: c.casesHeader,
      paddingBottom: Spacing.md,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.sm,
      gap: Spacing.md,
    },
    headerText: { flex: 1 },
    title: { fontSize: 36, lineHeight: 42, fontFamily: "Inter_700Bold", color: c.casesHeaderText },
    subtitle: { ...Typography.body, color: c.casesHeaderMuted, marginTop: 1 },
    newBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: Spacing.md,
      minHeight: 44,
      borderRadius: Radius.md,
      backgroundColor: c.info,
    },
    newBtnText: { ...Typography.bodySemibold, color: c.casesHeaderText },
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
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
    },
    searchWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      minHeight: 46,
      paddingLeft: Spacing.md,
      paddingRight: Spacing.xs,
      borderRadius: 14,
      backgroundColor: c.surface,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 5, minWidth: 0 },
    searchDivider: { height: 26, width: StyleSheet.hairlineWidth, backgroundColor: c.border },
    scanBtn: {
      width: 42,
      minHeight: 42,
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
    quickFiltersRow: { marginBottom: Spacing.xs },
    quickFiltersContent: { paddingHorizontal: Spacing.xs, gap: Spacing.xs, alignItems: "center" },
    quickFilter: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: 6,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    quickFilterText: { ...Typography.captionSemibold, color: c.textSecondary },
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

    // Reference-aligned case cards
    listContent: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.xs, paddingBottom: Spacing.xxl, gap: Spacing.md },
    caseCard: {
      borderRadius: 14,
      borderColor: c.borderLight,
      backgroundColor: c.surface,
      overflow: "hidden",
    },
    caseCardInner: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm },
    caseCardTop: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    caseCopy: { flex: 1, minWidth: 0, justifyContent: "center" },
    casePatient: { ...Typography.h2, fontSize: 20, lineHeight: 25, color: c.text },
    caseDoctor: { ...Typography.body, color: c.textSecondary, marginTop: 1 },
    caseWorkRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      columnGap: Spacing.sm,
      rowGap: Spacing.xs,
      marginTop: 4,
    },
    caseMaterial: { ...Typography.body, color: c.textSecondary, flexShrink: 1 },
    caseDetailChip: {
      maxWidth: "100%",
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 7,
      backgroundColor: c.infoSurface,
    },
    caseDetailText: { ...Typography.captionMedium, color: c.infoStrong, flexShrink: 1 },
    duePanel: {
      width: 70,
      minHeight: 78,
      paddingHorizontal: 4,
      paddingVertical: 6,
      borderRadius: 10,
      backgroundColor: c.infoSurface,
      alignItems: "center",
      justifyContent: "center",
    },
    duePanelOverdue: { backgroundColor: c.errorSurface },
    duePanelComplete: { backgroundColor: c.successSurface },
    duePanelLabel: {
      fontSize: 9,
      lineHeight: 12,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.35,
      color: c.textSecondary,
      textAlign: "center",
    },
    duePanelValue: {
      fontSize: 24,
      lineHeight: 28,
      fontFamily: "Inter_700Bold",
      color: c.infoStrong,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
    duePanelFoot: { fontSize: 9, lineHeight: 12, fontFamily: "Inter_500Medium", color: c.textSecondary, textAlign: "center" },
    completedDate: { fontSize: 8, lineHeight: 10 },
    caseFooter: {
      minHeight: 34,
      marginTop: Spacing.sm,
      paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderLight,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.xs,
    },
    caseFooterBadges: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: Spacing.xs },
    createdLabel: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "58%" },
    createdDate: { ...Typography.caption, color: c.textSecondary, flexShrink: 1, textAlign: "right" },
    caseTypeTextBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: c.tintLight },
    caseTypeText: { ...Typography.tiny, color: c.tintDark },
    rushBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: c.errorLight },
    rushBadgeText: { ...Typography.tiny, color: c.errorStrong },
    conflictBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      marginLeft: 2,
      paddingHorizontal: 5,
      paddingVertical: 3,
      borderRadius: Radius.xs,
      backgroundColor: c.warningLight,
      borderWidth: 1,
      borderColor: c.warning,
    },
    conflictBadgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: c.warningText },
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
      // Must be an opaque surface: these sheets live inside a `transparent`
      // Modal, and the light theme's `background` token is literally
      // "transparent" (it exists so full-screen views sit on the app gradient),
      // which made the panel see-through over the case list.
      backgroundColor: c.backgroundSolid,
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
      flexWrap: "wrap",
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
    scanTorchBtnWrap: { position: "absolute", top: 16, right: 16, zIndex: 10 },
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

    scanManualWrap: { flex: 1, padding: Spacing.xl },
    // Inner layer so the dismissal wrapper fills the pane and owns the gaps.
    scanManualInner: { flex: 1, gap: Spacing.lg },
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

function calendarDateFromString(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

function calendarDateString(date: Date | null): string {
  return date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : "";
}
