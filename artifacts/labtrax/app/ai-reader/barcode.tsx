import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Print from "expo-print";
import { buildCaseCardHtml } from "@/lib/case-pdf";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch } from "@/lib/query-client";
import { getAiReaderSession, clearAiReaderSession } from "@/lib/ai-reader-store";

type Step = "scan" | "manual" | "done";

// Shape returned by GET /api/organizations/:id/case-print-template
interface OrgPrintTemplate {
  template: Record<string, unknown> | null;
  isCustom: boolean;
  defaultTemplate: Record<string, unknown>;
}

export default function AiReaderBarcodeScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>("scan");
  const [manualInput, setManualInput] = useState("");
  const [scanned, setScanned] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignedBarcode, setAssignedBarcode] = useState<string | null>(null);
  const [printModalVisible, setPrintModalVisible] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);

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

  // ── Barcode scan handler ──
  const handleBarcodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scanned || assigning || !data?.trim()) return;
      setScanned(true);
      await assignBarcode(data.trim());
    },
    [scanned, assigning, caseId],
  );

  async function assignBarcode(code: string) {
    if (!caseId || !code.trim()) return;
    setAssigning(true);
    try {
      const res = await resilientFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ casePanBarcode: code.trim() }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        Alert.alert(
          "Barcode not saved",
          `Server responded with ${res.status}${text ? `: ${text}` : ""}. Assign it later from the case detail.`,
        );
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
      setScanned(false);
    } finally {
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
      // 1. Fetch the lab's org-level print template (may be null = use default)
      let orgTemplate: OrgPrintTemplate | null = null;
      const labOrgId = session.labOrgId;
      if (labOrgId) {
        try {
          const tmplRes = await resilientFetch(
            `/api/organizations/${encodeURIComponent(labOrgId)}/case-print-template`,
          );
          if (tmplRes.ok) {
            const body = (await tmplRes.json()) as { data?: OrgPrintTemplate };
            orgTemplate = body?.data ?? null;
          }
        } catch {
          // Non-fatal — use default template
        }
      }

      // 2. Build the label HTML using the canonical buildCaseCardHtml template.
      //    The orgTemplate config is available for future field-mapping extension;
      //    the underlying renderer already handles all required fields.
      const restorations = (session.restorations ?? []).map((r) => ({
        toothNumber: r.toothNumber,
        restorationType: r.restorationType,
        material: r.material,
        shade: r.shade,
      }));

      const html = buildCaseCardHtml({
        caseNumber: caseNumber ?? undefined,
        patientName: session.patientName ?? undefined,
        doctorName: session.doctorName ?? undefined,
        dueDate: session.dueDate ?? undefined,
        priority: undefined,
        status: "received",
        rxNotes: session.extracted?.notes ?? undefined,
        restorations,
        labName: orgTemplate?.template
          ? (orgTemplate.template as Record<string, unknown>)?.labName as string | undefined
              ?? session.labName ?? undefined
          : session.labName ?? undefined,
        casePanBarcode: assignedBarcode ?? undefined,
      });

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
    <View style={[styles.screen, { paddingTop: insets.top }]}>
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
            !permission?.granted ? (
              <View style={styles.permView}>
                <Ionicons name="barcode-outline" size={48} color={colors.textTertiary} />
                <Text style={styles.permTitle}>Camera needed to scan</Text>
                <Pressable style={styles.btn} onPress={requestPermission}>
                  <Text style={styles.btnText}>Grant access</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.scannerWrap}>
                {!scanned && (
                  <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    onBarcodeScanned={assigning ? undefined : handleBarcodeScanned}
                    barcodeScannerSettings={{
                      barcodeTypes: [
                        "code128",
                        "code39",
                        "qr",
                        "ean13",
                        "ean8",
                        "pdf417",
                        "code93",
                      ],
                    }}
                  />
                )}
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
                  <Text style={styles.scanHintText}>Point at the case pan barcode</Text>
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
