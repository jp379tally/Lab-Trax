import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from "react-native-vision-camera";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateCase,
  type UpdateCaseInput,
  type UpdateCaseInputStatus,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch } from "@/lib/query-client";
import { extractLookupCase } from "@/lib/barcode-lookup";
import {
  filterBarcodesInBox,
  guideBoxFromFractions,
  type BarcodeCandidate,
} from "@/lib/barcode-guide-box";
import { codesToBarcodeCandidates, SCAN_CODE_TYPES } from "@/lib/vision-camera-codes";
import { TorchToggleButton } from "@/components/ui/TorchToggleButton";
import { useMe, primaryLabOrgId, editableLabMemberships } from "@/lib/auth-me";
import { useLabLocations } from "@/lib/lab-locations";
import {
  OutgoingPhotosModal,
  type OutgoingPhotoCase,
} from "@/components/OutgoingPhotosModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = "scanning" | "selecting" | "confirming" | "moving" | "result";

export interface ScannedCase {
  barcode: string;
  caseId: string;
  patientName: string;
  caseNumber: string | null;
  currentLocation: string | null;
  /** Lab that owns this case — scopes the destination list to the right lab. */
  labOrganizationId: string | null;
}

interface BatchResult {
  succeededIds: string[];
  failedIds: string[];
  targetName: string;
}

type ScanNotice = {
  kind: "duplicate" | "not_found" | "lab_unavailable";
  barcode: string;
  id: number;
} | null;
type BarcodeScanState = "queued" | "looking_up" | "succeeded" | "failed";

const SCAN_WINDOW_MS = 120;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function isDuplicateScan(seen: Set<string>, barcode: string): boolean {
  return seen.has(barcode);
}

export function prependScannedCase(
  list: ScannedCase[],
  item: ScannedCase,
): ScannedCase[] {
  return [item, ...list];
}

export function removeScannedCase(
  list: ScannedCase[],
  caseId: string,
): ScannedCase[] {
  return list.filter((item) => item.caseId !== caseId);
}

export function updateScannedLocations(
  list: ScannedCase[],
  succeededIds: ReadonlyArray<string>,
  locationName: string,
): ScannedCase[] {
  const succeeded = new Set(succeededIds);
  return list.map((item) =>
    succeeded.has(item.caseId)
      ? { ...item, currentLocation: locationName }
      : item,
  );
}

export function splitBatchResults(
  results: PromiseSettledResult<unknown>[],
  caseIds: string[],
): { succeededIds: string[]; failedIds: string[] } {
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  results.forEach((r, i) => {
    const id = caseIds[i];
    if (id === undefined) return;
    if (r.status === "fulfilled") {
      succeededIds.push(id);
    } else {
      failedIds.push(id);
    }
  });
  return { succeededIds, failedIds };
}

/**
 * Run a batch of per-case updates, invoking mutateFn once per case.
 * Progress is reported via onProgress after each case settles (success or failure),
 * so the counter always reaches total regardless of partial failures.
 */
export async function runBatchMove(
  cases: ScannedCase[],
  stationValue: string,
  mutateFn: (args: { caseId: string; data: { status: string; labLocationId?: string } }) => Promise<unknown>,
  onProgress: () => void,
  labLocationId?: string,
): Promise<{ succeededIds: string[]; failedIds: string[] }> {
  const results = await Promise.allSettled(
    cases.map(async (c) => {
      try {
        return await mutateFn({
          caseId: c.caseId,
          data: {
            status: stationValue,
            ...(labLocationId ? { labLocationId } : {}),
          },
        });
      } finally {
        onProgress();
      }
    }),
  );
  return splitBatchResults(results, cases.map((c) => c.caseId));
}

/**
 * Cases eligible for the outgoing-photo flow after a batch move to the
 * "Complete" station, in scan order (scannedCases is stored newest-first via
 * prepend, so reverse it) and restricted to cases the move actually updated.
 * The photo flow carries this list itself — the server clears casePanBarcode
 * on completion, so barcodes can NOT be re-looked-up afterwards.
 */
export function outgoingPhotoCasesForBatch(
  scannedNewestFirst: ScannedCase[],
  succeededIds: string[],
  stationValue: string,
): OutgoingPhotoCase[] {
  if (stationValue !== "complete") return [];
  const succeeded = new Set(succeededIds);
  return [...scannedNewestFirst]
    .reverse()
    .filter((c) => succeeded.has(c.caseId))
    .map((c) => ({
      caseId: c.caseId,
      patientName: c.patientName,
      caseNumber: c.caseNumber,
    }));
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function BatchLocateScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { hasPermission: permissionGranted, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice("back");
  const [torchOn, setTorchOn] = useState(false);
  const [step, setStep] = useState<Step>("scanning");

  // Scanning state
  const barcodeStatesRef = useRef<Map<string, BarcodeScanState>>(new Map());
  const cameraViewSize = useRef<{ width: number; height: number } | null>(null);
  const mountedRef = useRef(true);
  const batchIdRef = useRef(0);
  const activeLookupsRef = useRef(0);
  // Accumulate every candidate during one fixed scan window. The timer starts
  // on the first native callback and is not restarted by later callbacks.
  const barcodeAccumRef = useRef<BarcodeCandidate[]>([]);
  const barcodeWindowRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scannedCases, setScannedCases] = useState<ScannedCase[]>([]);
  const [scanNotice, setScanNotice] = useState<ScanNotice>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeIdRef = useRef(0);
  const [lookingUp, setLookingUp] = useState(false);

  // Station selection state
  const [selectedStation, setSelectedStation] = useState<{ id: string; value: string; label: string } | null>(null);

  // Moving state
  const [moveProgress, setMoveProgress] = useState(0);
  const [moveTotal, setMoveTotal] = useState(0);

  // Result state
  const [result, setResult] = useState<BatchResult | null>(null);
  const [failedCases, setFailedCases] = useState<ScannedCase[]>([]);
  // Outgoing-photo prompt shown over the result screen after a successful
  // batch move to "Complete". Empty = hidden.
  const [outgoingPhotoCases, setOutgoingPhotoCases] = useState<OutgoingPhotoCase[]>([]);

  const updateCase = useUpdateCase();
  const queryClient = useQueryClient();
  const meQuery = useMe();

  // Scope the destination list to the lab the *scanned* cases actually belong
  // to — the barcode lookup returns each case's lab. A membership-derived guess
  // can point at a different lab for multi-lab accounts, which is how mobile
  // ended up offering a different station list than desktop. The membership is
  // only a fallback for cases whose lookup carried no lab.
  const scannedLabOrgId =
    scannedCases.find((sc) => sc.labOrganizationId)?.labOrganizationId ?? null;
  const orgId =
    scannedLabOrgId ?? editableLabMemberships(meQuery.data)[0]?.organizationId ?? null;

  const {
    locations: apiLocations,
    status: locationsStatus,
    retry: retryLocations,
  } = useLabLocations(orgId, step === "selecting");

  // Only a genuinely loaded list is selectable — loading and error render their
  // own states rather than standing in the built-in station list.
  const stations: { id: string; value: string; label: string }[] = useMemo(
    () =>
      locationsStatus === "loaded"
        ? // `value` is the mapped workflow stage (a valid case-status), NOT the
          // free-form code — sending the code broke custom stations.
          // `id` is the unique location row id — used for selection/key so that
          // two locations sharing the same status don't both appear selected.
          apiLocations.map((loc) => ({ id: loc.id, value: loc.status, label: loc.name }))
        : [],
    [apiLocations, locationsStatus],
  );

  // Clean up notice timer on unmount
  useEffect(() => {
    // React Strict Mode runs setup → cleanup → setup on initial mount.
    // Restore the guard here so the second setup remains able to accept results.
    mountedRef.current = true;
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      if (barcodeWindowRef.current) clearTimeout(barcodeWindowRef.current);
      barcodeWindowRef.current = null;
      barcodeAccumRef.current = [];
      barcodeStatesRef.current.clear();
      activeLookupsRef.current = 0;
      batchIdRef.current += 1;
      mountedRef.current = false;
    };
  }, []);

  function showNotice(
    kind: "duplicate" | "not_found" | "lab_unavailable",
    barcode: string,
  ) {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    const id = ++noticeIdRef.current;
    setScanNotice({ kind, barcode, id });
    noticeTimerRef.current = setTimeout(() => {
      setScanNotice((cur) => (cur?.id === id ? null : cur));
    }, 2000);
  }

  const handleBarcodeScanned = useCallback(
    (codes: BarcodeCandidate[]) => {
      if (codes.length === 0) return;

      // Collect every native callback in one bounded window. In particular,
      // don't reset this timer on each frame: sustained scanning should flush
      // a complete group instead of perpetually postponing the lookup.
      barcodeAccumRef.current.push(...codes);
      if (barcodeWindowRef.current) return;

      barcodeWindowRef.current = setTimeout(() => {
        barcodeWindowRef.current = null;
        const candidates = barcodeAccumRef.current.splice(0);
        if (candidates.length === 0) return;

        const viewSize = cameraViewSize.current;
        const box = guideBoxFromFractions(0.2, 0.2, 0.2, 0.6);
        const filteredCandidates = filterBarcodesInBox(candidates, box, viewSize);
        const inBoxCandidates =
          filteredCandidates.length > 0 ? filteredCandidates : candidates;
        const labOrganizationId = primaryLabOrgId(meQuery.data) ?? "";
        if (!labOrganizationId) {
          showNotice("lab_unavailable", inBoxCandidates[0]?.data ?? "");
          return;
        }

        const batchId = batchIdRef.current;
        for (const candidate of inBoxCandidates) {
          const trimmed = candidate.data.trim();
          if (!trimmed) continue;

          if (barcodeStatesRef.current.has(trimmed)) {
            showNotice("duplicate", trimmed);
            continue;
          }

          // Reserve before starting the request. This closes the duplicate
          // race between rapid native callbacks and slow network responses.
          barcodeStatesRef.current.set(trimmed, "queued");
          activeLookupsRef.current += 1;
          setLookingUp(true);
          barcodeStatesRef.current.set(trimmed, "looking_up");

          const qs = new URLSearchParams({ labOrganizationId });
          resilientFetch(`/api/cases/barcode/${encodeURIComponent(trimmed)}?${qs.toString()}`)
            .then(async (res) => {
              if (!res.ok) throw new Error("barcode lookup failed");
              const body = await res.json();
              const c = extractLookupCase(body);
              if (!c?.id) throw new Error("barcode lookup returned no case");
              if (batchId !== batchIdRef.current || !mountedRef.current) return;

              barcodeStatesRef.current.set(trimmed, "succeeded");
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              const patientName =
                [`${c.patientFirstName ?? ""}`, `${c.patientLastName ?? ""}`]
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .join(" ") || "Unnamed patient";
              setScannedCases((prev) =>
                prependScannedCase(prev, {
                  barcode: trimmed,
                  caseId: c.id!,
                  patientName,
                  caseNumber: c.caseNumber ?? null,
                  currentLocation: c.labLocationName ?? c.status ?? null,
                  labOrganizationId: c.labOrganizationId ?? null,
                }),
              );
            })
            .catch(() => {
              if (batchId !== batchIdRef.current || !mountedRef.current) return;
              barcodeStatesRef.current.set(trimmed, "failed");
              showNotice("not_found", trimmed);
            })
            .finally(() => {
              if (batchId !== batchIdRef.current || !mountedRef.current) return;
              activeLookupsRef.current = Math.max(0, activeLookupsRef.current - 1);
              setLookingUp(activeLookupsRef.current > 0);
            });
        }
      }, SCAN_WINDOW_MS);
    },
    [meQuery.data],
  );

  const codeScanner = useCodeScanner({
    codeTypes: SCAN_CODE_TYPES,
    onCodeScanned: (codes, frame) =>
      handleBarcodeScanned(codesToBarcodeCandidates(codes, frame)),
  });

  async function executeBatchMove(
    cases: ScannedCase[],
    station: { id: string; value: string; label: string },
  ) {
    const total = cases.length;
    setMoveTotal(total);
    setMoveProgress(0);
    setStep("moving");

    const { succeededIds, failedIds } = await runBatchMove(
      cases,
      station.value,
      ({ caseId, data }) =>
        updateCase.mutateAsync({
          caseId,
          data: {
            status: data.status as UpdateCaseInputStatus,
            labLocationId: data.labLocationId,
          } as UpdateCaseInput & { labLocationId: string },
        }),
      () => setMoveProgress((p) => p + 1),
      station.id,
    );

    if (__DEV__) {
      console.log("[BatchLocate] Move complete", {
        station: station.value,
        succeededIds,
        failedIds,
      });
    }

    // The ["cases"] prefix includes list, dashboard, and every case-detail
    // query, including details that are currently mounted elsewhere.
    await queryClient.invalidateQueries({ queryKey: ["cases"] });
    setScannedCases((current) =>
      updateScannedLocations(current, succeededIds, station.label),
    );
    if (__DEV__) {
      console.log("[BatchLocate] Invalidated 'cases' queries");
    }

    setResult({ succeededIds, failedIds, targetName: station.label });
    setFailedCases(cases.filter((c) => failedIds.includes(c.caseId)));
    // Moving to "Complete"? Offer the optional guided photo flow on top of
    // the result screen. Declining/skipping never blocks — the moves are done.
    setOutgoingPhotoCases(
      outgoingPhotoCasesForBatch(scannedCases, succeededIds, station.value),
    );
    setStep("result");
  }

  async function handleRetry() {
    if (!selectedStation || failedCases.length === 0) return;
    const casesToRetry = [...failedCases];
    const total = casesToRetry.length;
    setMoveTotal(total);
    setMoveProgress(0);
    setStep("moving");

    const { succeededIds: retrySucceeded, failedIds: retryFailed } = await runBatchMove(
      casesToRetry,
      selectedStation.value,
      ({ caseId, data }) =>
        updateCase.mutateAsync({
          caseId,
          data: {
            status: data.status as UpdateCaseInputStatus,
            labLocationId: data.labLocationId,
          } as UpdateCaseInput & { labLocationId: string },
        }),
      () => setMoveProgress((p) => p + 1),
      selectedStation.id,
    );

    if (__DEV__) {
      console.log("[BatchLocate] Retry complete", {
        station: selectedStation.value,
        retrySucceeded,
        retryFailed,
      });
    }

    await queryClient.invalidateQueries({ queryKey: ["cases"] });
    setScannedCases((current) =>
      updateScannedLocations(current, retrySucceeded, selectedStation.label),
    );

    setResult((prev) => ({
      succeededIds: [...(prev?.succeededIds ?? []), ...retrySucceeded],
      failedIds: retryFailed,
      targetName: selectedStation.label,
    }));
    setFailedCases(casesToRetry.filter((c) => retryFailed.includes(c.caseId)));
    setStep("result");
  }

  function handleDone() {
    router.back();
  }

  function handleRemoveCase(item: ScannedCase) {
    barcodeStatesRef.current.delete(item.barcode);
    setScannedCases((current) => {
      const remaining = removeScannedCase(current, item.caseId);
      if (step === "confirming" && remaining.length === 0) {
        setStep("scanning");
      }
      return remaining;
    });
  }

  function freezeScanSession() {
    if (barcodeWindowRef.current) clearTimeout(barcodeWindowRef.current);
    barcodeWindowRef.current = null;
    barcodeAccumRef.current = [];
    activeLookupsRef.current = 0;
    batchIdRef.current += 1;
    for (const [barcode, state] of barcodeStatesRef.current) {
      if (state === "queued" || state === "looking_up") {
        barcodeStatesRef.current.delete(barcode);
      }
    }
    setLookingUp(false);
  }

  function handleScanMore() {
    freezeScanSession();
    barcodeStatesRef.current.clear();
    setScannedCases([]);
    setSelectedStation(null);
    setResult(null);
    setFailedCases([]);
    setOutgoingPhotoCases([]);
    setStep("scanning");
  }

  // ── Step: Scanning ─────────────────────────────────────────────────────────
  if (step === "scanning") {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Batch Locate</Text>
            <Text style={styles.headerSubtitle}>
              {scannedCases.length === 0
                ? "Scan case pans to build your batch"
                : `Scanned: ${scannedCases.length} Case${scannedCases.length === 1 ? "" : "s"}`}
            </Text>
          </View>
          <View style={{ width: 36 }} />
        </View>

        {!permissionGranted ? (
          <View style={styles.permView}>
            <Ionicons name="barcode-outline" size={48} color={colors.textTertiary} />
            <Text style={styles.permTitle}>Camera needed to scan</Text>
            <Text style={styles.permBody}>
              Grant camera access to scan case-pan barcodes.
            </Text>
            <Pressable style={[styles.btn, { backgroundColor: colors.tint }]} onPress={requestPermission}>
              <Text style={styles.btnText}>Grant access</Text>
            </Pressable>
          </View>
        ) : (
          <View
            style={styles.scannerArea}
            testID="batch-locate-scanner-area"
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              cameraViewSize.current = { width, height };
            }}
          >
            {cameraDevice && (
              <Camera
                style={StyleSheet.absoluteFill}
                device={cameraDevice}
                isActive
                codeScanner={codeScanner}
                torch={torchOn ? "on" : "off"}
              />
            )}
            {cameraDevice?.hasTorch ? (
              <View style={styles.torchBtnWrap}>
                <TorchToggleButton
                  torchOn={torchOn}
                  onToggle={() => setTorchOn((v) => !v)}
                  testID="batch-locate-torch-toggle"
                />
              </View>
            ) : null}
            <View style={styles.reticle} pointerEvents="none">
              <View style={styles.reticleTL} />
              <View style={styles.reticleTR} />
              <View style={styles.reticleBL} />
              <View style={styles.reticleBR} />
            </View>

            {scanNotice ? (
              <View style={styles.noticeOverlay} pointerEvents="none">
                <View
                  style={[
                    styles.noticePill,
                    {
                      backgroundColor:
                        scanNotice.kind === "duplicate"
                          ? colors.warningStrong + "EE"
                          : colors.error + "EE",
                    },
                  ]}
                >
                  <Ionicons
                    name={
                      scanNotice.kind === "duplicate" ||
                      scanNotice.kind === "lab_unavailable"
                        ? "alert-circle-outline"
                        : "close-circle-outline"
                    }
                    size={16}
                    color="#fff"
                  />
                  <Text style={styles.noticeText}>
                    {scanNotice.kind === "duplicate"
                      ? "Already scanned"
                      : scanNotice.kind === "lab_unavailable"
                        ? "Waiting for lab account"
                        : "Barcode not found"}
                  </Text>
                </View>
              </View>
            ) : lookingUp ? (
              <View style={styles.noticeOverlay} pointerEvents="none">
                <View style={[styles.noticePill, { backgroundColor: "rgba(0,0,0,0.7)" }]}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.noticeText}>Looking up…</Text>
                </View>
              </View>
            ) : null}

            <View style={styles.scanHint} pointerEvents="none">
              <Text style={styles.scanHintText}>
                {scannedCases.length === 0
                  ? "Center the barcode in the box"
                  : `${scannedCases.length} scanned — center next barcode`}
              </Text>
            </View>
          </View>
        )}

        <View style={[styles.listArea, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
          {scannedCases.length === 0 ? (
            <View style={styles.listEmpty}>
              <Ionicons name="cube-outline" size={24} color={colors.textTertiary} />
              <Text style={[styles.listEmptyText, { color: colors.textTertiary }]}>
                No cases scanned yet
              </Text>
            </View>
          ) : (
            <FlatList
              data={scannedCases}
              keyExtractor={(item) => item.barcode}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <View style={[styles.caseRow, { borderBottomColor: colors.border }]}>
                  <View style={styles.caseRowLeft}>
                    <Text style={[styles.caseRowName, { color: colors.text }]} numberOfLines={1}>
                      {item.patientName}
                    </Text>
                    <Text style={[styles.caseRowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                      {item.caseNumber ? `#${item.caseNumber}` : "No case #"}
                      {" · "}
                      <Text style={{ color: colors.textTertiary }}>{item.barcode}</Text>
                    </Text>
                  </View>
                  {item.currentLocation ? (
                    <Text style={[styles.caseRowLoc, { color: colors.textTertiary }]} numberOfLines={1}>
                      {item.currentLocation
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (m) => m.toUpperCase())}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.patientName} from batch`}
                    hitSlop={8}
                    onPress={() => handleRemoveCase(item)}
                    style={({ pressed }) => [
                      styles.removeCaseBtn,
                      { backgroundColor: pressed ? colors.surfaceAlt : "transparent" },
                    ]}
                    testID={`batch-locate-remove-${item.barcode}`}
                  >
                    <Ionicons name="close" size={18} color={colors.textSecondary} />
                  </Pressable>
                </View>
              )}
            />
          )}

          <Pressable
            style={[
              styles.continueBtn,
              { backgroundColor: scannedCases.length > 0 ? colors.tint : colors.border },
            ]}
            onPress={() => {
              if (scannedCases.length === 0) return;
              freezeScanSession();
              setStep("selecting");
            }}
            disabled={scannedCases.length === 0}
            testID="batch-locate-continue"
          >
            <Text style={styles.continueBtnText}>
              {scannedCases.length > 0
                ? `Continue  (${scannedCases.length} case${scannedCases.length === 1 ? "" : "s"})`
                : "Scan at least one case"}
            </Text>
            {scannedCases.length > 0 && (
              <Ionicons name="arrow-forward" size={16} color="#fff" />
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Step: Selecting station ────────────────────────────────────────────────
  if (step === "selecting") {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => { setSelectedStation(null); setStep("scanning"); }}
            hitSlop={8}
            style={styles.backBtn}
          >
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Choose Destination</Text>
            <Text style={styles.headerSubtitle}>
              Moving {scannedCases.length} case{scannedCases.length === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={{ width: 36 }} />
        </View>

        {locationsStatus === "error" ? (
          <View style={styles.fetchErrorArea} testID="batch-locate-locations-error">
            <Ionicons name="cloud-offline-outline" size={36} color={colors.textTertiary} />
            <Text style={[styles.fetchErrorTitle, { color: colors.text }]}>
              Couldn't load locations
            </Text>
            <Text style={[styles.fetchErrorBody, { color: colors.textSecondary }]}>
              Check your connection and try again.
            </Text>
            <Pressable
              style={[styles.btn, { backgroundColor: colors.tint, marginTop: Spacing.xs }]}
              onPress={retryLocations}
              testID="batch-locate-locations-retry"
            >
              <Text style={styles.btnText}>Retry</Text>
            </Pressable>
          </View>
        ) : locationsStatus === "loading" ? (
          <View style={styles.fetchErrorArea} testID="batch-locate-locations-loading">
            <ActivityIndicator size="large" color={colors.tint} />
            <Text style={[styles.fetchErrorBody, { color: colors.textSecondary }]}>
              Loading locations…
            </Text>
          </View>
        ) : stations.length === 0 ? (
          <View style={styles.fetchErrorArea} testID="batch-locate-locations-empty">
            <Ionicons name="location-outline" size={36} color={colors.textTertiary} />
            <Text style={[styles.fetchErrorTitle, { color: colors.text }]}>
              No active locations
            </Text>
            <Text style={[styles.fetchErrorBody, { color: colors.textSecondary }]}>
              This lab has no active locations to move cases to. A lab admin can add
              them under Manage → Locations.
            </Text>
          </View>
        ) : (
        <ScrollView
          style={{ flex: 1, backgroundColor: colors.backgroundSolid }}
          contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.xs }}
          showsVerticalScrollIndicator={false}
        >
          {stations.map((station, index) => {
            const active = selectedStation?.id === station.id;
            const isLast = index === stations.length - 1;
            return (
              <React.Fragment key={station.id}>
                <Pressable
                  style={({ pressed }) => [
                    styles.stationRow,
                    {
                      backgroundColor: active
                        ? colors.tint + "14"
                        : pressed
                        ? colors.surfaceAlt
                        : colors.surface,
                    },
                  ]}
                  onPress={() => setSelectedStation(station)}
                  android_ripple={{ color: colors.tint + "28" }}
                  // Keyed by the location row id (not its mapped status) so two
                  // custom locations sharing a status stay independently selectable.
                  testID={`batch-locate-station-${station.id}`}
                >
                  <Text style={[styles.stationLabel, { color: active ? colors.tint : colors.text }]}>
                    {station.label}
                  </Text>
                  {active ? (
                    <Ionicons name="checkmark-circle" size={20} color={colors.tint} />
                  ) : (
                    <View style={[styles.radio, { borderColor: colors.border }]} />
                  )}
                </Pressable>
                {!isLast && (
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                )}
              </React.Fragment>
            );
          })}
        </ScrollView>
        )}

        <View
          style={[
            styles.bottomBar,
            {
              paddingBottom: Math.max(insets.bottom, Spacing.lg),
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
            },
          ]}
        >
          <Pressable
            style={[styles.btn, { backgroundColor: selectedStation ? colors.tint : colors.border }]}
            onPress={() => {
              if (!selectedStation) return;
              setStep("confirming");
            }}
            disabled={!selectedStation}
            testID="batch-locate-next"
          >
            <Text style={styles.btnText}>
              {selectedStation ? `Next` : "Select a destination"}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Step: Confirming ───────────────────────────────────────────────────────
  if (step === "confirming") {
    return (
      <View style={[styles.screen, styles.centeredScreen, { paddingTop: insets.top }]}>
        <View style={[styles.confirmCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="location-outline" size={36} color={colors.tint} style={{ alignSelf: "center" }} />

          <Text style={[styles.confirmTitle, { color: colors.text }]}>
            Move {scannedCases.length} case{scannedCases.length === 1 ? "" : "s"} to {selectedStation?.label}?
          </Text>

          <Text style={[styles.confirmBody, { color: colors.textSecondary }]}>
            Each case will be updated and its location history will reflect this move.
          </Text>

          <ScrollView
            style={styles.confirmList}
            contentContainerStyle={styles.confirmListContent}
            showsVerticalScrollIndicator={false}
          >
            {scannedCases.map((item, index) => (
              <View
                key={item.caseId}
                style={[
                  styles.confirmCaseRow,
                  {
                    borderBottomColor: colors.border,
                    borderBottomWidth:
                      index < scannedCases.length - 1 ? StyleSheet.hairlineWidth : 0,
                  },
                ]}
              >
                <View style={styles.caseRowLeft}>
                  <Text style={[styles.caseRowName, { color: colors.text }]} numberOfLines={1}>
                    {item.patientName}
                  </Text>
                  <Text style={[styles.caseRowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                    {item.caseNumber ? `#${item.caseNumber}` : "No case #"}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.patientName} from batch`}
                  hitSlop={8}
                  onPress={() => handleRemoveCase(item)}
                  style={({ pressed }) => [
                    styles.removeCaseBtn,
                    { backgroundColor: pressed ? colors.surfaceAlt : "transparent" },
                  ]}
                  testID={`batch-locate-confirm-remove-${item.barcode}`}
                >
                  <Ionicons name="close" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
          </ScrollView>

          <View style={styles.confirmActions}>
            <Pressable
              style={[styles.cancelBtn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
              onPress={() => setStep("selecting")}
              testID="batch-locate-cancel"
            >
              <Text style={[styles.cancelBtnText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>

            <Pressable
              style={[styles.confirmBtn, { backgroundColor: colors.tint }]}
              onPress={() => {
                 if (!selectedStation || scannedCases.length === 0) return;
                executeBatchMove(scannedCases, selectedStation);
              }}
              testID="batch-locate-confirm"
            >
              <Text style={styles.confirmBtnText}>Confirm</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // ── Step: Moving ───────────────────────────────────────────────────────────
  if (step === "moving") {
    return (
      <View style={[styles.screen, styles.centeredScreen, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={[styles.movingTitle, { color: colors.text }]}>
          Updating {Math.min(moveProgress + 1, moveTotal)} of {moveTotal}…
        </Text>
        <Text style={[styles.movingSubtitle, { color: colors.textSecondary }]}>
          Moving to {selectedStation?.label ?? "destination"}
        </Text>
        <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: colors.tint,
                width: moveTotal > 0 ? `${(moveProgress / moveTotal) * 100}%` : "0%",
              },
            ]}
          />
        </View>
      </View>
    );
  }

  // ── Step: Result ───────────────────────────────────────────────────────────
  const succeeded = result?.succeededIds.length ?? 0;
  const failed = result?.failedIds.length ?? 0;
  const allSucceeded = failed === 0;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <OutgoingPhotosModal
        cases={outgoingPhotoCases}
        onDone={() => setOutgoingPhotoCases([])}
      />
      <View style={styles.header}>
        <View style={{ width: 36 }} />
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>
            {allSucceeded ? "All Done!" : "Partial Success"}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.resultContent,
          { paddingBottom: Math.max(insets.bottom, Spacing.xl) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.resultIconWrap}>
          <Ionicons
            name={allSucceeded ? "checkmark-circle" : "warning"}
            size={56}
            color={allSucceeded ? colors.success : colors.warningStrong}
          />
        </View>

        <Text style={[styles.resultHeading, { color: colors.text }]}>
          {allSucceeded
            ? `${succeeded} case${succeeded === 1 ? "" : "s"} moved to ${result?.targetName}`
            : `${succeeded} updated, ${failed} failed`}
        </Text>

        {!allSucceeded && (
          <Text style={[styles.resultSubheading, { color: colors.textSecondary }]}>
            {succeeded > 0
              ? `Successfully moved ${succeeded} case${succeeded === 1 ? "" : "s"} to ${result?.targetName}.\n`
              : ""}
            The following case{failed === 1 ? "" : "s"} could not be updated:
          </Text>
        )}

        {!allSucceeded && failedCases.length > 0 && (
          <View style={[styles.failedList, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {failedCases.map((c, i) => (
              <View
                key={c.caseId}
                style={[
                  styles.failedRow,
                  i < failedCases.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                  },
                ]}
              >
                <Text style={[styles.failedRowName, { color: colors.text }]} numberOfLines={1}>
                  {c.patientName}
                </Text>
                <Text style={[styles.failedRowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                  {c.caseNumber ? `#${c.caseNumber}` : c.barcode}
                </Text>
              </View>
            ))}
          </View>
        )}

        {!allSucceeded && (
          <Pressable
            style={[styles.btn, { backgroundColor: colors.tint }]}
            onPress={handleRetry}
            testID="batch-locate-retry"
          >
            <Text style={styles.btnText}>
              Retry {failed} failed case{failed === 1 ? "" : "s"}
            </Text>
          </Pressable>
        )}

        <Pressable
          style={[
            styles.btn,
            {
              backgroundColor: allSucceeded ? colors.tint : colors.surfaceAlt,
              borderWidth: allSucceeded ? 0 : 1,
              borderColor: colors.border,
            },
          ]}
          onPress={handleDone}
          testID="batch-locate-done"
        >
          <Text style={[styles.btnText, { color: allSucceeded ? "#fff" : colors.textSecondary }]}>
            Done
          </Text>
        </Pressable>

        <Pressable style={styles.secondaryBtn} onPress={handleScanMore} testID="batch-locate-scan-more">
          <Ionicons name="barcode-outline" size={16} color={colors.tint} />
          <Text style={[styles.secondaryBtnText, { color: colors.tint }]}>Start a new batch</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    centeredScreen: {
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
      padding: Spacing.xl,
    },

    // Header
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    backBtn: {
      width: 36, height: 36,
      alignItems: "center", justifyContent: "center",
    },
    headerCenter: { flex: 1, alignItems: "center" },
    headerTitle: { ...Typography.h3, color: c.text },
    headerSubtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },

    // Camera
    scannerArea: { height: 200, position: "relative", backgroundColor: "#000" },
    torchBtnWrap: { position: "absolute", top: 10, right: 10, zIndex: 10 },
    reticle: {
      position: "absolute",
      top: "20%", left: "20%", right: "20%", height: "60%",
    },
    reticleTL: {
      position: "absolute", top: 0, left: 0, width: 24, height: 24,
      borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#fff", borderRadius: 4,
    },
    reticleTR: {
      position: "absolute", top: 0, right: 0, width: 24, height: 24,
      borderTopWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderRadius: 4,
    },
    reticleBL: {
      position: "absolute", bottom: 0, left: 0, width: 24, height: 24,
      borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#fff", borderRadius: 4,
    },
    reticleBR: {
      position: "absolute", bottom: 0, right: 0, width: 24, height: 24,
      borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderRadius: 4,
    },
    noticeOverlay: {
      position: "absolute", top: 0, left: 0, right: 0,
      alignItems: "center", paddingTop: Spacing.sm,
    },
    noticePill: {
      flexDirection: "row", alignItems: "center", gap: Spacing.xs,
      paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
      borderRadius: Radius.full ?? 99,
    },
    noticeText: { ...Typography.captionSemibold, color: "#fff" },
    scanHint: {
      position: "absolute", bottom: Spacing.sm, left: 0, right: 0, alignItems: "center",
    },
    scanHintText: {
      ...Typography.captionMedium, color: "#fff",
      textShadowColor: "#000",
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },

    // List area
    listArea: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm },
    list: { flex: 1 },
    listContent: { gap: 0 },
    listEmpty: {
      flex: 1, alignItems: "center", justifyContent: "center",
      gap: Spacing.xs, opacity: 0.5,
    },
    listEmptyText: { ...Typography.body },
    caseRow: {
      flexDirection: "row", alignItems: "center",
      paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth,
    },
    caseRowLeft: { flex: 1, gap: 2 },
    caseRowName: { ...Typography.bodySemibold },
    caseRowMeta: { ...Typography.caption },
    caseRowLoc: { ...Typography.caption, marginLeft: Spacing.sm, flexShrink: 0 },
    removeCaseBtn: {
      width: 36, height: 36, borderRadius: Radius.full ?? 18,
      alignItems: "center", justifyContent: "center", marginLeft: Spacing.xs,
    },
    continueBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center",
      gap: Spacing.xs, borderRadius: Radius.md, paddingVertical: Spacing.md, marginTop: Spacing.xs,
    },
    continueBtnText: { ...Typography.bodySemibold, color: "#fff" },

    // Permissions
    permView: {
      flex: 1, alignItems: "center", justifyContent: "center",
      padding: Spacing.xl, gap: Spacing.lg,
    },
    permTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    permBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },

    // Station selection
    stationRow: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      paddingVertical: Spacing.md, paddingHorizontal: Spacing.md, borderRadius: Radius.sm,
    },
    stationLabel: { ...Typography.bodySemibold, flex: 1 },
    radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5 },
    divider: { height: StyleSheet.hairlineWidth, marginHorizontal: Spacing.xs },

    // Bottom bar
    bottomBar: {
      paddingHorizontal: Spacing.lg, paddingTop: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth, gap: Spacing.sm,
    },

    // Confirm step
    confirmCard: {
      width: "100%", borderWidth: 1, borderRadius: Radius.xl,
      padding: Spacing.xl, gap: Spacing.md,
    },
    confirmTitle: { ...Typography.h2, textAlign: "center" },
    confirmBody: { ...Typography.body, textAlign: "center", lineHeight: 22 },
    confirmList: { maxHeight: 220 },
    confirmListContent: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    confirmCaseRow: {
      flexDirection: "row", alignItems: "center", paddingVertical: Spacing.xs,
    },
    confirmActions: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.xs },
    cancelBtn: {
      flex: 1, alignItems: "center", paddingVertical: Spacing.md,
      borderRadius: Radius.md, borderWidth: 1,
    },
    cancelBtnText: { ...Typography.bodySemibold },
    confirmBtn: {
      flex: 2, alignItems: "center", paddingVertical: Spacing.md, borderRadius: Radius.md,
    },
    confirmBtnText: { ...Typography.bodySemibold, color: "#fff" },

    // Shared button
    btn: {
      borderRadius: Radius.md, paddingVertical: Spacing.md,
      alignItems: "center", justifyContent: "center",
    },
    btnText: { ...Typography.bodySemibold, color: "#fff" },

    // Moving
    movingTitle: { ...Typography.h2, textAlign: "center", marginTop: Spacing.md },
    movingSubtitle: { ...Typography.body, textAlign: "center" },
    progressBar: { width: "80%", height: 6, borderRadius: 3, overflow: "hidden", marginTop: Spacing.sm },
    progressFill: { height: "100%", borderRadius: 3 },

    // Result
    resultContent: { padding: Spacing.lg, gap: Spacing.md },
    resultIconWrap: { alignItems: "center", marginBottom: Spacing.xs },
    resultHeading: { ...Typography.h2, textAlign: "center" },
    resultSubheading: { ...Typography.body, textAlign: "center", lineHeight: 22 },
    failedList: { borderWidth: 1, borderRadius: Radius.md, overflow: "hidden" },
    failedRow: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: 2 },
    failedRowName: { ...Typography.bodySemibold },
    failedRowMeta: { ...Typography.caption },
    secondaryBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center",
      gap: Spacing.xs, paddingVertical: Spacing.sm,
    },
    secondaryBtnText: { ...Typography.bodySemibold },

    // Fetch error (selecting step)
    fetchErrorArea: {
      flex: 1, alignItems: "center", justifyContent: "center",
      gap: Spacing.sm, padding: Spacing.xl,
    },
    fetchErrorTitle: { ...Typography.h3, textAlign: "center" },
    fetchErrorBody: { ...Typography.body, textAlign: "center", lineHeight: 22 },
  });
}
