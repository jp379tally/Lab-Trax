import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from "react-native-vision-camera";
import * as Haptics from "expo-haptics";
import * as Print from "expo-print";
import { shouldIncludeProviderPreferencesOnLabSlip, type CaseCardRestoration } from "@/lib/case-pdf";
import { buildSharedCaseSlipHtml } from "@/lib/shared-case-slip";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch } from "@/lib/query-client";
import { getAiReaderSession, clearAiReaderSession } from "@/lib/ai-reader-store";
import { pickBestBarcode, guideBoxFromFractions, type BarcodeCandidate } from "@/lib/barcode-guide-box";
import { codesToBarcodeCandidates, SCAN_CODE_TYPES } from "@/lib/vision-camera-codes";
import { TorchToggleButton } from "@/components/ui/TorchToggleButton";

type Step = "scan" | "manual" | "done";

// Shape returned by GET /api/organizations/:id/case-print-template
interface OrgPrintTemplate {
  template: Record<string, unknown> | null;
  isCustom: boolean;
  defaultTemplate: Record<string, unknown>;
}

interface AuthoritativePrintableCase {
  id?: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  dueDate?: string | null;
  priority?: string | null;
  status?: string | null;
  caseNotes?: string | null;
  casePanBarcode?: string | null;
  gingivialShade?: string | null;
  labOrganizationId?: string | null;
  organizationId?: string | null;
  providerDoctorPreferences?: Record<string, unknown> | null;
  printProviderPreferencesOnLabSlips?: boolean | null;
  step?: string | null;
  stepShade?: string | null;
  dueTime?: string | null;
  doctorPreferences?: string | null;
  providerOrganizationContact?: Record<string, unknown> | null;
  restorations?: Array<CaseCardRestoration & {
    toothNumber?: string | null;
    restorationType?: string | null;
    material?: string | null;
    shade?: string | null;
    quantity?: number | null;
  }> | null;
}

export default function AiReaderBarcodeScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { hasPermission: permissionGranted, requestPermission } = useCameraPermission();
  const cameraDevice = useCameraDevice("back");
  const [torchOn, setTorchOn] = useState(false);
  const [step, setStep] = useState<Step>("scan");
  const [manualInput, setManualInput] = useState("");
  const [scanned, setScanned] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignedBarcode, setAssignedBarcode] = useState<string | null>(null);
  const [printModalVisible, setPrintModalVisible] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);

  // Guide-box scanning: measure the camera view and accumulate barcodes over a
  // ~120ms frame window so pickBestBarcode can choose the best in-box candidate.
  const cameraViewSize = useRef<{ width: number; height: number } | null>(null);
  const assigningRef = useRef(false);
  const barcodeAccumRef = useRef<BarcodeCandidate[]>([]);
  const barcodeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const session = getAiReaderSession();
  const caseId = session.caseId;
  const caseNumber = session.caseNumber;

  function goToCase() {
    clearAiReaderSession();
    if (caseId) {
      router.replace(`/case/${caseId}` as never);
    } else {
      router.replace("/(tabs)/dashboard" as never);
    }
  }

  // ── Barcode scan handler (guide-box filtering) ──
  const handleBarcodeScanned = useCallback(
    (codes: BarcodeCandidate[]) => {
      if (assigningRef.current || codes.length === 0) return;

      // Accumulate barcodes over a ~120ms window so pickBestBarcode can select
      // the in-box candidate closest to center across the full frame.
      barcodeAccumRef.current.push(...codes);
      if (barcodeDebounceRef.current) clearTimeout(barcodeDebounceRef.current);

      barcodeDebounceRef.current = setTimeout(() => {
        barcodeDebounceRef.current = null;
        if (assigningRef.current) {
          barcodeAccumRef.current = [];
          return;
        }

        const candidates = barcodeAccumRef.current.splice(0);
        if (candidates.length === 0) return;

        const viewSize = cameraViewSize.current;
        // Reticle fractions: top 30%, left/right 15%, height 40%
        const box = guideBoxFromFractions(0.15, 0.30, 0.15, 0.40);
        const best = pickBestBarcode(candidates, box, viewSize) ?? candidates[0];
        if (!best || !best.data.trim()) return;

        assigningRef.current = true;
        setScanned(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        assignBarcode(best.data.trim());
      }, 120);
    },
    [],
  );

  const codeScanner = useCodeScanner({
    codeTypes: SCAN_CODE_TYPES,
    onCodeScanned: (codes, frame) =>
      handleBarcodeScanned(codesToBarcodeCandidates(codes, frame)),
  });

  async function assignBarcode(code: string) {
    if (!caseId || !code.trim()) return;
    assigningRef.current = true;
    setAssigning(true);
    try {
      const res = await resilientFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          casePanBarcode: code.trim(),
        }),
      });
      if (!res.ok) {
        let errMsg = "";
        try {
          const json = await res.json();
          errMsg = json?.error ?? json?.message ?? "";
        } catch {
          errMsg = await res.text().catch(() => "");
        }
        // 409 = barcode already in use on another active case. Barcodes are
        // strictly unique per lab for active cases, so there's no override —
        // the case holding it must be completed (which frees its barcode) or a
        // different barcode used.
        if (res.status === 409) {
          assigningRef.current = false;
          setScanned(false);
          setAssigning(false);
          Alert.alert(
            "Barcode conflict",
            errMsg || "This barcode is already assigned to another active case. Use a different barcode.",
          );
          return;
        }
        Alert.alert(
          "Barcode not saved",
          errMsg || `Server responded with ${res.status}. Assign it later from the case detail.`,
        );
        assigningRef.current = false;
        setScanned(false);
        setAssigning(false);
        return;
      }
      setAssignedBarcode(code.trim());
      setStep("done");
      setPrintModalVisible(true);
    } catch (e) {
      Alert.alert(
        "Network error",
        e instanceof Error ? e.message : "Could not assign barcode. Try again from the case detail.",
      );
      assigningRef.current = false;
      setScanned(false);
    } finally {
      assigningRef.current = false;
      setAssigning(false);
    }
  }

  async function handleManualAssign() {
    const code = manualInput.trim();
    if (!code) {
      Alert.alert("Enter a barcode", "Type the barcode value before assigning.");
      return;
    }
    await assignBarcode(code);
  }

  // ── Label print: fetch org template → build canonical HTML → system print dialog ──
  async function printLabel() {
    setPrintLoading(true);
    try {
      // Always read the case immediately before printing. The AI-reader session
      // is only a navigation aid and may be stale or omit print-only fields.
      if (!caseId) throw new Error("This case is no longer available.");
      const caseRes = await resilientFetch(`/api/cases/${encodeURIComponent(caseId)}`);
      if (!caseRes.ok) throw new Error(`Could not load the latest case details (${caseRes.status}).`);
      const caseBody = (await caseRes.json()) as {
        data?: AuthoritativePrintableCase;
      } & AuthoritativePrintableCase;
      const currentCase = caseBody.data ?? caseBody;
      if (!currentCase || typeof currentCase !== "object") {
        throw new Error("Could not load the latest case details.");
      }

      // 1. Fetch the lab's org-level print template (may be null = use default)
      let orgTemplate: OrgPrintTemplate | null = null;
      const labOrgId = currentCase.labOrganizationId ?? currentCase.organizationId ?? session.labOrgId;
      if (labOrgId) {
        try {
          const tmplRes = await resilientFetch(
            `/api/organizations/${encodeURIComponent(labOrgId)}/case-print-template?caseId=${encodeURIComponent(caseId)}`,
          );
          if (!tmplRes.ok) throw new Error(`Could not load the shared lab-slip template (${tmplRes.status}).`);
          if (tmplRes.ok) {
            const body = (await tmplRes.json()) as { data?: OrgPrintTemplate };
            orgTemplate = body?.data ?? null;
          }
        } catch (error) {
          throw new Error("Could not load the shared lab-slip template. Check your connection and try again.", { cause: error });
        }
      }

      // System printing and PDF sharing honor the same shared desktop template.
      const restorations = (currentCase.restorations ?? []).map((r) => ({
        ...r,
        toothNumber: r.toothNumber,
        restorationType: r.restorationType,
        material: r.material,
        shade: r.shade,
      }));

      const html = await buildSharedCaseSlipHtml({
        caseNumber: currentCase.caseNumber ?? undefined,
        patientName: [currentCase.patientFirstName, currentCase.patientLastName].filter(Boolean).join(" ") || undefined,
        doctorName: currentCase.doctorName ?? undefined,
        dueDate: currentCase.dueDate ?? undefined,
        priority: currentCase.priority ?? undefined,
        status: currentCase.status ?? "received",
        rxNotes: currentCase.caseNotes ?? undefined,
        restorations,
        labName: orgTemplate?.template
          ? (orgTemplate.template as Record<string, unknown>)?.labName as string | undefined
               ?? session.labName ?? undefined
           : session.labName ?? undefined,
        casePanBarcode: currentCase.casePanBarcode ?? assignedBarcode ?? undefined,
        gingivialShade: currentCase.gingivialShade ?? null,
        providerDoctorPreferences: currentCase.providerDoctorPreferences ?? null,
        printProviderPreferencesOnLabSlips: shouldIncludeProviderPreferencesOnLabSlip(
          currentCase.printProviderPreferencesOnLabSlips,
          orgTemplate,
        ),
      }, orgTemplate, { caseId: currentCase.id ?? caseId, labOrganizationId: labOrgId, step: currentCase.step, stepShade: currentCase.stepShade, dueTime: currentCase.dueTime, doctorPreferences: currentCase.doctorPreferences, providerOrganizationContact: currentCase.providerOrganizationContact });

      // 3. Open the system print dialog — no intermediate PDF share sheet
      await Print.printAsync({ html });
    } catch (e) {
      Alert.alert(
        "Print error",
        e instanceof Error ? e.message : "Could not open the print dialog.",
      );
    } finally {
      setPrintLoading(false);
      setPrintModalVisible(false);
      goToCase();
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: insets.top }]}
      testID="barcode-keyboard-dismiss"
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <Text style={styles.title}>Assign Barcode</Text>
          {caseNumber ? (
            <Text style={styles.subtitle}>Case #{caseNumber}</Text>
          ) : null}
        </View>
        <Pressable style={styles.skipBtn} onPress={goToCase} hitSlop={8}>
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      </View>

      {step !== "done" && (
        <>
          {/* Mode toggle */}
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeTab, step === "scan" && styles.modeTabSelected]}
              onPress={() => setStep("scan")}
            >
              <Ionicons
                name="barcode-outline"
                size={18}
                color={step === "scan" ? "#fff" : colors.textSecondary}
              />
              <Text style={[styles.modeTabText, step === "scan" && styles.modeTabTextSelected]}>
                Scan
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modeTab, step === "manual" && styles.modeTabSelected]}
              onPress={() => setStep("manual")}
            >
              <Ionicons
                name="keypad-outline"
                size={18}
                color={step === "manual" ? "#fff" : colors.textSecondary}
              />
              <Text style={[styles.modeTabText, step === "manual" && styles.modeTabTextSelected]}>
                Manual
              </Text>
            </Pressable>
          </View>

          {step === "scan" ? (
            !permissionGranted ? (
              <View style={styles.permView}>
                <Ionicons name="barcode-outline" size={48} color={colors.textTertiary} />
                <Text style={styles.permTitle}>Camera needed to scan</Text>
                <Pressable style={styles.btn} onPress={requestPermission}>
                  <Text style={styles.btnText}>Grant access</Text>
                </Pressable>
              </View>
            ) : (
              <View
                style={styles.scannerWrap}
                testID="ai-reader-scanner-wrap"
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  cameraViewSize.current = { width, height };
                }}
              >
                {!scanned && cameraDevice && (
                  <Camera
                    style={StyleSheet.absoluteFill}
                    device={cameraDevice}
                    isActive
                    codeScanner={assigning ? undefined : codeScanner}
                    torch={torchOn ? "on" : "off"}
                  />
                )}
                {!scanned && cameraDevice?.hasTorch ? (
                  <View style={styles.torchBtnWrap}>
                    <TorchToggleButton
                      torchOn={torchOn}
                      onToggle={() => setTorchOn((v) => !v)}
                      testID="ai-reader-torch-toggle"
                    />
                  </View>
                ) : null}
                {/* Scan reticle */}
                <View style={styles.reticle} pointerEvents="none">
                  <View style={styles.reticleTL} />
                  <View style={styles.reticleTR} />
                  <View style={styles.reticleBL} />
                  <View style={styles.reticleBR} />
                </View>
                {assigning && (
                  <View style={styles.assigningOverlay}>
                    <ActivityIndicator color="#fff" size="large" />
                    <Text style={styles.assigningText}>Assigning barcode…</Text>
                  </View>
                )}
                <View style={styles.scanHint} pointerEvents="none">
                  <Text style={styles.scanHintText}>Center the barcode in the box</Text>
                </View>
              </View>
            )
          ) : (
            <View style={styles.manualView}>
              <Text style={styles.manualLabel}>Enter barcode value</Text>
              <TextInput
                style={styles.manualInput}
                value={manualInput}
                onChangeText={setManualInput}
                placeholder="Type or paste barcode…"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
              />
              <Pressable
                style={[styles.btn, assigning && { opacity: 0.5 }]}
                onPress={handleManualAssign}
                disabled={assigning}
              >
                {assigning ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.btnText}>Assign Barcode</Text>
                )}
              </Pressable>
            </View>
          )}
        </>
      )}

      {/* Print label bottom sheet */}
      {printModalVisible && (
        <View style={styles.printOverlay}>
          <View style={[styles.printSheet, { paddingBottom: insets.bottom + Spacing.lg }]}>
            <View style={styles.sheetHandle} />
            <Ionicons
              name="checkmark-circle"
              size={40}
              color={colors.success}
              style={{ alignSelf: "center" }}
            />
            <Text style={styles.sheetTitle}>Barcode assigned!</Text>
            <Text style={styles.sheetBody}>
              Print a work-order label for case #{caseNumber}?{"\n"}
              This uses your lab's print template and shows the system print dialog.
            </Text>

            <Pressable style={styles.printBtn} onPress={printLabel} disabled={printLoading}>
              {printLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="print-outline" size={18} color="#fff" />
                  <Text style={styles.printBtnText}>Print label</Text>
                </>
              )}
            </Pressable>

            <Pressable
              style={styles.skipSheetBtn}
              onPress={() => {
                setPrintModalVisible(false);
                goToCase();
              }}
            >
              <Text style={styles.skipSheetText}>Skip — open case</Text>
            </Pressable>
          </View>
        </View>
      )}
    </DismissKeyboardView>
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
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    headerTitle: { flex: 1 },
    title: { ...Typography.h3, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary },
    skipBtn: { paddingVertical: Spacing.xs, paddingHorizontal: Spacing.sm },
    skipText: { ...Typography.bodyMedium, color: c.tint },

    modeRow: {
      flexDirection: "row",
      margin: Spacing.lg,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    modeTab: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.sm,
    },
    modeTabSelected: { backgroundColor: c.tint },
    modeTabText: { ...Typography.bodySemibold, color: c.textSecondary },
    modeTabTextSelected: { color: "#fff" },

    scannerWrap: { flex: 1, position: "relative", backgroundColor: "#000" },
    torchBtnWrap: { position: "absolute", top: 16, right: 16, zIndex: 10 },
    reticle: {
      position: "absolute",
      top: "30%",
      left: "15%",
      right: "15%",
      height: "40%",
    },
    reticleTL: {
      position: "absolute",
      top: 0,
      left: 0,
      width: 28,
      height: 28,
      borderTopWidth: 3,
      borderLeftWidth: 3,
      borderColor: "#fff",
      borderRadius: 4,
    },
    reticleTR: {
      position: "absolute",
      top: 0,
      right: 0,
      width: 28,
      height: 28,
      borderTopWidth: 3,
      borderRightWidth: 3,
      borderColor: "#fff",
      borderRadius: 4,
    },
    reticleBL: {
      position: "absolute",
      bottom: 0,
      left: 0,
      width: 28,
      height: 28,
      borderBottomWidth: 3,
      borderLeftWidth: 3,
      borderColor: "#fff",
      borderRadius: 4,
    },
    reticleBR: {
      position: "absolute",
      bottom: 0,
      right: 0,
      width: 28,
      height: 28,
      borderBottomWidth: 3,
      borderRightWidth: 3,
      borderColor: "#fff",
      borderRadius: 4,
    },
    assigningOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.7)",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    assigningText: { ...Typography.bodySemibold, color: "#fff" },
    scanHint: {
      position: "absolute",
      bottom: Spacing.xl,
      left: 0,
      right: 0,
      alignItems: "center",
    },
    scanHintText: {
      ...Typography.captionMedium,
      color: "#fff",
      textShadowColor: "#000",
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },

    permView: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.lg,
    },
    permTitle: { ...Typography.h3, color: c.text, textAlign: "center" },

    manualView: { flex: 1, padding: Spacing.xl, gap: Spacing.lg },
    manualLabel: { ...Typography.bodySemibold, color: c.text },
    manualInput: {
      ...Typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Platform.OS === "ios" ? Spacing.sm : Spacing.xs,
      backgroundColor: c.surface,
      fontSize: 18,
      letterSpacing: 1.5,
    },

    btn: {
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
      alignItems: "center",
      justifyContent: "center",
    },
    btnText: { ...Typography.bodySemibold, color: "#fff" },

    printOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    printSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      padding: Spacing.xl,
      gap: Spacing.md,
    },
    sheetHandle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: "center",
      marginBottom: Spacing.sm,
    },
    sheetTitle: { ...Typography.h2, color: c.text, textAlign: "center" },
    sheetBody: {
      ...Typography.body,
      color: c.textSecondary,
      textAlign: "center",
    },
    printBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    printBtnText: { ...Typography.bodySemibold, color: "#fff" },
    skipSheetBtn: { paddingVertical: Spacing.sm, alignItems: "center" },
    skipSheetText: { ...Typography.body, color: c.textTertiary },
  });
}
