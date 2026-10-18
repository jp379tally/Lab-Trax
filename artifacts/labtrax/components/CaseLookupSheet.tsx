import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from "react-native-vision-camera";
import * as Haptics from "expo-haptics";
import { useCases, type CanonicalCase } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { TypeBadge } from "@/components/ui/TypeBadge";
import { TorchToggleButton } from "@/components/ui/TorchToggleButton";
import { stationLabelFor, canonicalCaseStatus } from "@/lib/case-stations";
import { getCompactWorkDetails } from "@/lib/case-category";
import { formatDate } from "@/lib/format";
import { resilientFetch } from "@/lib/query-client";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { fetchCaseByBarcode } from "@/lib/barcode-lookup";
import {
  guideBoxFromFractions,
  pickBestBarcode,
  type BarcodeCandidate,
} from "@/lib/barcode-guide-box";
import {
  codesToBarcodeCandidates,
  SCAN_CODE_TYPES,
} from "@/lib/vision-camera-codes";
import { CaseQuickActionSheet } from "@/components/CaseQuickActionSheet";
import { useLongPressGuard } from "@/lib/use-long-press-guard";
import { isActiveCaseRecord } from "@/lib/case-quick-actions";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";

/**
 * Shortest term that reaches the server. Below this the sheet shows a hint
 * instead of searching, so opening it never pulls the lab's unfiltered case
 * list (the server returns the 500 newest rows for an empty search).
 */
export const MIN_SEARCH_CHARS = 2;

/** Upper bound on rendered rows — the sheet is a picker, not a case list. */
export const MAX_RESULTS = 25;

const SEARCH_DEBOUNCE_MS = 300;

type SheetMode = "search" | "scan";
type ScanStep = "scan" | "manual";

interface Props {
  visible: boolean;
  onDismiss: () => void;
  onSelectCase?: (caseId: string) => void;
}

function patientDisplayName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

/** Letters the shared type badge renders; anything else is plain text. */
const TYPE_BADGE_LETTERS = new Set(["C", "D", "O"]);

interface ResultRowDetails {
  /** "C" / "D" / "O" when the case classifies, else null. */
  badgeLetter: "C" | "D" | "O" | null;
  /** Comma-free meta chips: plain restoration type, material, step, teeth. */
  metaParts: string[];
  /** "MM/DD/YYYY" — received timestamp, falling back to created. */
  entered: string | null;
  /** "MM/DD/YYYY" — only for complete cases. */
  completed: string | null;
}

/**
 * Everything the result row shows beyond patient / case # / doctor / status.
 *
 * Classification and date formatting both come from the app's shared helpers
 * (`getCompactWorkDetails`, `formatDate`) so the letter and the dates here can
 * never disagree with the Cases list or the Dashboard cards.
 */
function resultRowDetails(c: CanonicalCase): ResultRowDetails {
  const work = getCompactWorkDetails(c);
  const badgeLetter =
    work.typeLabel && TYPE_BADGE_LETTERS.has(work.typeLabel)
      ? (work.typeLabel as "C" | "D" | "O")
      : null;

  const teeth = c.teeth?.trim() ? `Teeth ${c.teeth.trim()}` : null;
  const metaParts: string[] = [];
  for (const part of [badgeLetter ? null : work.typeLabel, work.material, work.detail, teeth]) {
    const value = part?.trim();
    // `work.detail` is already the teeth text for restorative cases — dedupe
    // so a crown case doesn't print "Teeth 8, 9" twice.
    if (value && !metaParts.includes(value)) metaParts.push(value);
  }

  const entered = c.receivedAt
    ? formatDate(c.receivedAt)
    : c.createdAt
      ? formatDate(c.createdAt)
      : "—";
  // No completed_at column exists — the Cases list and Dashboard cards read
  // `updatedAt` for complete cases, so this row does too.
  const isComplete = canonicalCaseStatus(c.status) === "complete";
  const completed = isComplete && c.updatedAt ? formatDate(c.updatedAt) : null;

  return {
    badgeLetter,
    metaParts,
    entered: entered === "—" ? null : entered,
    completed: completed === "—" ? null : completed,
  };
}

/**
 * Mirrors the Cases-list status→badge mapping so a case looks the same here
 * as it does in the list it links into.
 */
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

/**
 * CaseLookupSheet — the dashboard's "Look Up Case" pop-up.
 *
 * Two modes share one bottom sheet:
 *   • search — debounced patient / doctor / case-number search driven by the
 *     same `useCases({ search })` hook (and therefore the same server matching
 *     rules) the Cases list uses.
 *   • scan   — the barcode scanner, reusing the app's vision-camera scanning
 *     primitives, guide-box picking, torch toggle and manual-entry fallback.
 *
 * The sheet lives in a RN `<Modal>`, which renders in its own native
 * hierarchy — screen-level keyboard avoidance never reaches it — so it carries
 * its own `KeyboardAvoidingView`.
 */
export function CaseLookupSheet({ visible, onDismiss, onSelectCase }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [mode, setMode] = useState<SheetMode>("search");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // ── Scan state (mirrors the Cases-list scan modal)
  const [scanStep, setScanStep] = useState<ScanStep>("scan");
  const [manualBarcode, setManualBarcode] = useState("");
  const [scanSearching, setScanSearching] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanScanned, setScanScanned] = useState(false);
  const [scanTorchOn, setScanTorchOn] = useState(false);
  const cameraViewSize = useRef<{ width: number; height: number } | null>(null);
  const scanLockedRef = useRef(false);
  const barcodeAccumRef = useRef<BarcodeCandidate[]>([]);
  const barcodeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { hasPermission: cameraHasPermission, requestPermission: requestCameraPermission } =
    useCameraPermission();
  const cameraDevice = useCameraDevice("back");
  const meQuery = useMe();
  const { markLongPress, consumeLongPress, resetLongPress } = useLongPressGuard<string>();
  const [quickActionCase, setQuickActionCase] = useState<CanonicalCase | null>(null);
  const searchInputRef = useRef<TextInput>(null);
  const restoreSearchFocusRef = useRef(false);


  // Debounce the term that reaches the server so typing doesn't fire a
  // request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const searchTerm = debounced.length >= MIN_SEARCH_CHARS ? debounced : "";
  const casesQuery = useCases(
    searchTerm ? { search: searchTerm } : undefined,
    { enabled: visible && mode === "search" && searchTerm.length > 0 },
  );

  const results = useMemo(
    () => (searchTerm ? (casesQuery.data ?? []).slice(0, MAX_RESULTS) : []),
    [casesQuery.data, searchTerm],
  );

  const resetScanState = useCallback(() => {
    setScanStep("scan");
    setManualBarcode("");
    setScanError(null);
    setScanScanned(false);
    setScanSearching(false);
    setScanTorchOn(false);
    scanLockedRef.current = false;
    barcodeAccumRef.current = [];
    if (barcodeDebounceRef.current) {
      clearTimeout(barcodeDebounceRef.current);
      barcodeDebounceRef.current = null;
    }
  }, []);

  // Reopening the sheet must never show a previous session's term, results or
  // scan error.
  useEffect(() => {
    if (!visible) {
      setQuickActionCase(null);
      resetLongPress();
      setMode("search");
      setQuery("");
      setDebounced("");
      resetScanState();
    }
  }, [visible, resetLongPress, resetScanState]);

  function dismiss() {
    setQuickActionCase(null);
    resetLongPress();
    onDismiss();
  }

  function dismissQuickActions() {
    restoreSearchFocusRef.current = mode === "search";
    setQuickActionCase(null);
    resetLongPress();
  }

  function handleLookupShown() {
    if (!restoreSearchFocusRef.current) return;
    restoreSearchFocusRef.current = false;
    searchInputRef.current?.focus();
  }

  function openCase(caseId: string) {
    onDismiss();
    router.push(`/case/${caseId}` as never);
  }

  function selectCase(caseId: string) {
    if (onSelectCase) {
      onSelectCase(caseId);
      onDismiss();
    } else {
      openCase(caseId);
    }
  }

  async function lookupBarcode(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;

    let labOrganizationId = primaryLabOrgId(meQuery.data) ?? "";
    // Cold open + fast scan: /auth/me may still be in flight. Fetch it on
    // demand rather than immediately claiming the lab is missing.
    if (!labOrganizationId && (meQuery.isLoading || meQuery.isPending)) {
      try {
        const freshMe = await meQuery.refetch();
        labOrganizationId = primaryLabOrgId(freshMe.data) ?? "";
      } catch {
        // fall through to the error below
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
      const outcome = await fetchCaseByBarcode(trimmed, labOrganizationId, resilientFetch);
      if (outcome.status === "found") {
        selectCase(outcome.caseId);
        return;
      }
      // Not found / error: keep the scanner live so the user can try again or
      // go back to search.
      setScanError(outcome.message);
      setScanScanned(false);
      scanLockedRef.current = false;
    } finally {
      setScanSearching(false);
    }
  }

  const lookupBarcodeRef = useRef(lookupBarcode);
  lookupBarcodeRef.current = lookupBarcode;

  const handleCameraBarcode = useCallback((codes: BarcodeCandidate[]) => {
    if (scanLockedRef.current || codes.length === 0) return;

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
  }, []);

  const codeScanner = useCodeScanner({
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

  function enterScanMode() {
    resetScanState();
    setMode("scan");
  }

  function backToSearch() {
    resetScanState();
    setMode("search");
  }

  // Clean up the in-flight scan debounce on unmount.
  useEffect(
    () => () => {
      if (barcodeDebounceRef.current) clearTimeout(barcodeDebounceRef.current);
    },
    [],
  );

  return (
    <>
      <Modal
        visible={visible && quickActionCase === null}
        transparent
        animationType="slide"
        onRequestClose={dismiss}
        onShow={handleLookupShown}
      >
      {/* The test harness's Modal stub renders children regardless of
          `visible`; guard the body so a hidden sheet never duplicates testIDs. */}
      {!visible ? null : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <TouchableWithoutFeedback onPress={dismiss}>
            <View style={styles.backdrop} />
          </TouchableWithoutFeedback>

          <DismissKeyboardView
            style={[
              styles.sheet,
              { paddingBottom: Math.max(insets.bottom, Spacing.lg) },
            ]}
            testID="case-lookup-sheet"
          >
            <View style={styles.handle} />

            <View style={styles.headerRow}>
              <View style={styles.headerText}>
                <Text style={styles.title}>
                  {mode === "search" ? "Look Up Case" : "Scan Barcode"}
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {mode === "search"
                    ? "Search by patient, doctor, or case #"
                    : "Find a case by pan barcode"}
                </Text>
              </View>
              <Pressable
                style={styles.closeBtn}
                onPress={dismiss}
                hitSlop={8}
                testID="case-lookup-close"
                accessibilityRole="button"
                accessibilityLabel="Close case lookup"
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>

            {mode === "search" ? (
              <>
                <Pressable
                  style={styles.scanBtn}
                  onPress={enterScanMode}
                  testID="case-lookup-scan-btn"
                  accessibilityRole="button"
                >
                  <Ionicons name="barcode-outline" size={18} color={colors.tint} />
                  <Text style={styles.scanBtnText}>Scan Barcode</Text>
                </Pressable>

                <View style={styles.searchWrap}>
                  <Ionicons name="search" size={18} color={colors.textTertiary} />
                  <TextInput
                    ref={searchInputRef}
                    style={styles.searchInput}
                    placeholder="Search patient, doctor, or case #"
                    placeholderTextColor={colors.textTertiary}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    returnKeyType="search"
                    testID="case-lookup-search"
                  />
                  {query.length > 0 ? (
                    <Pressable
                      onPress={() => setQuery("")}
                      hitSlop={8}
                      testID="case-lookup-search-clear"
                      accessibilityRole="button"
                      accessibilityLabel="Clear search"
                    >
                      <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                    </Pressable>
                  ) : null}
                </View>

                <ScrollView
                  style={styles.results}
                  contentContainerStyle={styles.resultsContent}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={scrollKeyboardDismissMode}
                >
                  {!searchTerm ? (
                    <View style={styles.stateBlock} testID="case-lookup-hint">
                      <Ionicons name="search-outline" size={26} color={colors.textTertiary} />
                      <Text style={styles.stateText}>
                        Type at least {MIN_SEARCH_CHARS} characters to search.
                      </Text>
                    </View>
                  ) : casesQuery.isError ? (
                    <View style={styles.stateBlock} testID="case-lookup-error">
                      <Ionicons name="cloud-offline-outline" size={26} color={colors.textTertiary} />
                      <Text style={styles.stateText}>Couldn't search cases.</Text>
                      <Pressable
                        style={styles.retryBtn}
                        onPress={() => casesQuery.refetch()}
                        testID="case-lookup-retry"
                      >
                        <Text style={styles.retryBtnText}>Retry</Text>
                      </Pressable>
                    </View>
                  ) : casesQuery.isLoading ? (
                    <View style={styles.stateBlock} testID="case-lookup-loading">
                      <ActivityIndicator size="small" color={colors.tint} />
                      <Text style={styles.stateText}>Searching…</Text>
                    </View>
                  ) : results.length === 0 ? (
                    <View style={styles.stateBlock} testID="case-lookup-empty">
                      <Ionicons name="file-tray-outline" size={26} color={colors.textTertiary} />
                      <Text style={styles.stateText}>No cases match “{searchTerm}”.</Text>
                    </View>
                  ) : (
                    results.map((c) => {
                      const details = resultRowDetails(c);
                      return (
                        <Pressable
                          key={c.id}
                          style={styles.resultRow}
                          onPress={() => {
                            if (consumeLongPress(c.id)) return;
                            selectCase(c.id);
                          }}
                          onLongPress={() => {
                            if (!isActiveCaseRecord(c)) return;
                            markLongPress(c.id);
                            Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});
                            setQuickActionCase(c);
                          }}
                          delayLongPress={400}
                          testID={`case-lookup-result-${c.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${patientDisplayName(c)}${c.caseNumber ? `, case ${c.caseNumber}` : ""}`}
                          accessibilityHint={
                            isActiveCaseRecord(c)
                              ? "Tap to open case details. Long press for quick actions."
                              : "Tap to open case details."
                          }
                        >
                          <View style={styles.resultMain}>
                            <Text style={styles.resultName} numberOfLines={1}>
                              {patientDisplayName(c)}
                            </Text>
                            <Text style={styles.resultMeta} numberOfLines={1}>
                              {c.caseNumber ? `#${c.caseNumber}` : "No case #"}
                              {c.doctorName ? `  ·  ${c.doctorName}` : ""}
                            </Text>
                            {details.metaParts.length > 0 ? (
                              <View
                                style={styles.resultWorkRow}
                                testID={`case-lookup-work-${c.id}`}
                              >
                                {details.metaParts.map((part) => (
                                  <Text
                                    key={part}
                                    style={styles.resultWorkText}
                                    numberOfLines={1}
                                  >
                                    {part}
                                  </Text>
                                ))}
                              </View>
                            ) : null}
                            {details.entered || details.completed ? (
                              <View
                                style={styles.resultWorkRow}
                                testID={`case-lookup-dates-${c.id}`}
                              >
                                {details.entered ? (
                                  <Text style={styles.resultDateText} numberOfLines={1}>
                                    Entered {details.entered}
                                  </Text>
                                ) : null}
                                {details.completed ? (
                                  <Text style={styles.resultDateText} numberOfLines={1}>
                                    Completed {details.completed}
                                  </Text>
                                ) : null}
                              </View>
                            ) : null}
                          </View>
                          <View style={styles.resultRight}>
                            {details.badgeLetter ? (
                              <TypeBadge letter={details.badgeLetter} />
                            ) : null}
                            <StatusBadge
                              label={stationLabelFor(canonicalCaseStatus(c.status))}
                              variant={statusVariant(c.status)}
                              size="sm"
                            />
                          </View>
                        </Pressable>
                      );
                    })
                  )}
                </ScrollView>
              </>
            ) : (
              <View style={styles.scanBody}>
                <View style={styles.scanModeRow}>
                  <Pressable
                    style={[styles.scanModeTab, scanStep === "scan" && styles.scanModeTabActive]}
                    onPress={() => {
                      setScanStep("scan");
                      setScanError(null);
                      setScanScanned(false);
                      scanLockedRef.current = false;
                    }}
                    testID="case-lookup-scan-tab-camera"
                  >
                    <Ionicons
                      name="barcode-outline"
                      size={17}
                      color={scanStep === "scan" ? "#fff" : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.scanModeTabText,
                        scanStep === "scan" && styles.scanModeTabTextActive,
                      ]}
                    >
                      Camera
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.scanModeTab, scanStep === "manual" && styles.scanModeTabActive]}
                    onPress={() => {
                      setScanStep("manual");
                      setScanError(null);
                      setScanScanned(false);
                      scanLockedRef.current = false;
                    }}
                    testID="case-lookup-scan-tab-manual"
                  >
                    <Ionicons
                      name="keypad-outline"
                      size={17}
                      color={scanStep === "manual" ? "#fff" : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.scanModeTabText,
                        scanStep === "manual" && styles.scanModeTabTextActive,
                      ]}
                    >
                      Manual
                    </Text>
                  </Pressable>
                </View>

                {scanStep === "scan" ? (
                  !cameraHasPermission ? (
                    <View style={styles.scanPermView} testID="case-lookup-scan-permission">
                      <Ionicons name="camera-outline" size={44} color={colors.textTertiary} />
                      <Text style={styles.scanPermTitle}>Camera access needed</Text>
                      <Text style={styles.scanPermBody}>
                        Allow camera access to scan a pan barcode, or switch to Manual entry.
                      </Text>
                      <Pressable
                        style={styles.primaryBtn}
                        onPress={requestCameraPermission}
                        testID="case-lookup-scan-permission-allow"
                      >
                        <Text style={styles.primaryBtnText}>Allow Camera</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View
                      style={styles.scanCameraWrap}
                      testID="case-lookup-camera-wrap"
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
                          codeScanner={scanSearching ? undefined : codeScanner}
                          torch={scanTorchOn ? "on" : "off"}
                          testID="case-lookup-scanner"
                        />
                      )}
                      {!scanScanned && cameraDevice?.hasTorch ? (
                        <View style={styles.scanTorchBtnWrap}>
                          <TorchToggleButton
                            torchOn={scanTorchOn}
                            onToggle={() => setScanTorchOn((v) => !v)}
                            testID="case-lookup-torch-toggle"
                          />
                        </View>
                      ) : null}
                      {/* Guide box — matches guideBoxFromFractions(0.12, 0.28, 0.12, 0.44) */}
                      <View style={styles.scanReticle} pointerEvents="none">
                        <View style={styles.scanCornerTL} />
                        <View style={styles.scanCornerTR} />
                        <View style={styles.scanCornerBL} />
                        <View style={styles.scanCornerBR} />
                      </View>
                      {scanSearching ? (
                        <View style={styles.scanSearchingOverlay}>
                          <ActivityIndicator color="#fff" size="large" />
                          <Text style={styles.scanSearchingText}>Looking up case…</Text>
                        </View>
                      ) : (
                        <View style={styles.scanHintWrap} pointerEvents="none">
                          <Text style={styles.scanHintText}>Center the barcode in the box</Text>
                        </View>
                      )}
                    </View>
                  )
                ) : (
                  <View style={styles.scanManualWrap}>
                    <Text style={styles.scanManualLabel}>Enter barcode value</Text>
                    <TextInput
                      style={styles.scanManualInput}
                      value={manualBarcode}
                      onChangeText={(t) => {
                        setManualBarcode(t);
                        setScanError(null);
                      }}
                      placeholder="Type or paste barcode…"
                      placeholderTextColor={colors.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoFocus
                      returnKeyType="search"
                      onSubmitEditing={handleManualBarcode}
                      testID="case-lookup-manual-input"
                    />
                    <Pressable
                      style={[styles.primaryBtn, scanSearching && styles.primaryBtnDisabled]}
                      onPress={handleManualBarcode}
                      disabled={scanSearching}
                      testID="case-lookup-manual-submit"
                    >
                      {scanSearching ? (
                        <ActivityIndicator color={colors.textInverse} size="small" />
                      ) : (
                        <Text style={styles.primaryBtnText}>Find Case</Text>
                      )}
                    </Pressable>
                  </View>
                )}

                {scanError ? (
                  <View style={styles.scanInlineError} testID="case-lookup-scan-error">
                    <Ionicons name="alert-circle-outline" size={15} color={colors.error} />
                    <Text style={styles.scanInlineErrorText}>{scanError}</Text>
                  </View>
                ) : null}

                <Pressable
                  style={styles.backBtn}
                  onPress={backToSearch}
                  testID="case-lookup-back-to-search"
                  accessibilityRole="button"
                >
                  <Ionicons name="arrow-back" size={16} color={colors.tint} />
                  <Text style={styles.backBtnText}>Back to search</Text>
                </Pressable>
              </View>
            )}
          </DismissKeyboardView>
        </KeyboardAvoidingView>
      )}
      </Modal>
      <CaseQuickActionSheet
        visible={quickActionCase !== null}
        caseItem={quickActionCase}
        onDismiss={dismissQuickActions}
      />
    </>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
    sheet: {
      marginTop: "auto",
      backgroundColor: c.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      maxHeight: "88%",
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: Radius.full,
      backgroundColor: c.border,
      marginBottom: Spacing.sm,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: Spacing.md,
      marginBottom: Spacing.md,
    },
    headerText: { flex: 1 },
    title: { ...Typography.h2, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    closeBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
    },
    scanBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      minHeight: 44,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.tint,
      backgroundColor: c.tintLight,
      marginBottom: Spacing.md,
    },
    scanBtnText: { ...Typography.bodySemibold, color: c.tint },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      minHeight: 44,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 10 },
    results: { marginTop: Spacing.md, flexGrow: 0 },
    resultsContent: { paddingBottom: Spacing.md },
    stateBlock: {
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.xl,
    },
    stateText: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    retryBtn: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.tint,
    },
    retryBtnText: { ...Typography.bodySemibold, color: c.tint },
    resultRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    resultMain: { flex: 1, minWidth: 0 },
    resultName: { ...Typography.bodyLgMedium, color: c.text },
    resultMeta: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    // Mirrors the Cases-list card's wrapping work row so longer meta (type,
    // material, teeth, dates) stays inside the sheet instead of overflowing.
    resultWorkRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: Spacing.xs,
      marginTop: 2,
    },
    resultWorkText: { ...Typography.caption, color: c.textSecondary },
    resultDateText: { ...Typography.caption, color: c.textTertiary },
    resultRight: { alignItems: "flex-end", gap: Spacing.xs },

    // ── Scan mode
    scanBody: { gap: Spacing.md },
    scanModeRow: { flexDirection: "row", gap: Spacing.sm },
    scanModeTab: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      minHeight: 40,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    scanModeTabActive: { backgroundColor: c.tint },
    scanModeTabText: { ...Typography.bodySemibold, color: c.textSecondary },
    scanModeTabTextActive: { color: "#fff" },
    scanPermView: {
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.xl,
    },
    scanPermTitle: { ...Typography.h3, color: c.text },
    scanPermBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    scanCameraWrap: {
      height: 280,
      borderRadius: Radius.lg,
      overflow: "hidden",
      backgroundColor: "#000",
    },
    scanTorchBtnWrap: { position: "absolute", top: Spacing.md, right: Spacing.md },
    scanReticle: {
      position: "absolute",
      left: "12%",
      right: "12%",
      top: "28%",
      height: "44%",
    },
    scanCornerTL: {
      position: "absolute", top: 0, left: 0, width: 26, height: 26,
      borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#fff", borderTopLeftRadius: Radius.sm,
    },
    scanCornerTR: {
      position: "absolute", top: 0, right: 0, width: 26, height: 26,
      borderTopWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderTopRightRadius: Radius.sm,
    },
    scanCornerBL: {
      position: "absolute", bottom: 0, left: 0, width: 26, height: 26,
      borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#fff", borderBottomLeftRadius: Radius.sm,
    },
    scanCornerBR: {
      position: "absolute", bottom: 0, right: 0, width: 26, height: 26,
      borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderBottomRightRadius: Radius.sm,
    },
    scanSearchingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    scanSearchingText: { ...Typography.bodySemibold, color: "#fff" },
    scanHintWrap: { position: "absolute", left: 0, right: 0, bottom: Spacing.md, alignItems: "center" },
    scanHintText: { ...Typography.caption, color: "#fff" },
    scanManualWrap: { gap: Spacing.sm },
    scanManualLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    scanManualInput: {
      ...Typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: 10,
      minHeight: 44,
    },
    primaryBtn: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      borderRadius: Radius.md,
      backgroundColor: c.tint,
      paddingHorizontal: Spacing.lg,
    },
    primaryBtnDisabled: { backgroundColor: c.border },
    primaryBtnText: { ...Typography.bodySemibold, color: "#fff" },
    scanInlineError: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    scanInlineErrorText: { ...Typography.caption, color: c.error, flex: 1 },
    backBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      minHeight: 44,
    },
    backBtnText: { ...Typography.bodySemibold, color: c.tint },
  });
}
