import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCreateCase,
  useSearchDoctors,
  getSearchDoctorsQueryKey,
  type CreateCaseInput,
  type CreateCaseInputRestorationsItem,
  type DoctorSearchEntry,
} from "@workspace/api-client-react";
import { resilientFetch } from "@/lib/query-client";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import { buildCaseCardHtml, generatePdf, type CaseCardRestoration } from "@/lib/case-pdf";
import { useMe, editableLabMemberships } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { DateField } from "@/components/DateField";
import {
  getAiReaderSession,
  setAiReaderSession,
  type ExtractedRx,
  type AiReaderRestoration,
} from "@/lib/ai-reader-store";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitName(full: string | null | undefined): { first: string; last: string } {
  if (!full?.trim()) return { first: "", last: "" };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function parseDueDateMDY(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return raw;
  const [, mo, dy, yr] = m;
  const fullYr = yr.length === 2 ? `20${yr}` : yr;
  return `${fullYr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}`;
}

function toothIndicesToRestorations(
  toothIndices: string | null | undefined,
  caseType: string | null | undefined,
  material: string | null | undefined,
  shade: string | null | undefined,
): AiReaderRestoration[] {
  if (!toothIndices?.trim()) return [];
  const rest = caseType?.trim() || "Crown & Bridge";
  const teeth = toothIndices.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  return teeth.slice(0, 12).map((tooth) => ({
    toothNumber: tooth,
    restorationType: rest,
    ...(material?.trim() ? { material: material.trim() } : {}),
    ...(shade?.trim() ? { shade: shade.trim() } : {}),
  }));
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong. Please try again.";
}

// ─── Similarity hit type ──────────────────────────────────────────────────────

interface SimilarityHit {
  id: string;
  source: string;
  caseNumber: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  doctorName: string | null;
  status: string | null;
  matchKind: "exact" | "nickname" | "fuzzy";
  createdAt: string | null;
  toothNumbers: string | null;
  restorationTypes: string | null;
}

type DuplicateDecision =
  | "create_new"    // not a duplicate — create a brand-new case
  | "remake"        // mark as remake of a selected case
  | "is_duplicate"; // truly is a duplicate — cancel

// ─── Component ───────────────────────────────────────────────────────────────

export default function AiReaderExtractedScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const session = getAiReaderSession();
  const extracted: ExtractedRx | null = session.extracted;

  useEffect(() => {
    if (!extracted) {
      router.replace("/ai-reader/capture?new=1" as never);
    }
  }, [extracted]);

  // ── Auth / lab ──
  const meQuery = useMe();
  const labs = useMemo(() => editableLabMemberships(meQuery.data), [meQuery.data]);
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedLabId && labs.length > 0) setSelectedLabId(labs[0].organizationId);
  }, [labs, selectedLabId]);

  // ── Patient fields ──
  const patientSplit = useMemo(() => splitName(extracted?.patientName), [extracted]);
  const [patientFirst, setPatientFirst] = useState(patientSplit.first);
  const [patientLast, setPatientLast] = useState(patientSplit.last);
  const [dueDate, setDueDate] = useState(parseDueDateMDY(extracted?.dueDate));
  const [priority, setPriority] = useState<"normal" | "rush">(extracted?.isRush ? "rush" : "normal");
  const [notes, setNotes] = useState(extracted?.notes ?? "");
  const [shade, setShade] = useState(extracted?.shade ?? "");
  const [material, setMaterial] = useState(extracted?.material ?? "");
  const [caseType, setCaseType] = useState(extracted?.caseType ?? "");
  const [toothIndices, setToothIndices] = useState(extracted?.toothIndices ?? "");

  // ── Provider / doctor ──
  const [doctorInput, setDoctorInput] = useState(extracted?.doctorName ?? "");
  const [debouncedDoctor, setDebouncedDoctor] = useState(extracted?.doctorName ?? "");
  const [doctorName, setDoctorName] = useState(extracted?.doctorName ?? "");
  const [providerOrgId, setProviderOrgId] = useState<string | null>(null);
  const [doctorFocused, setDoctorFocused] = useState(false);
  const [aliasResolved, setAliasResolved] = useState(false);
  // True when user explicitly opted to proceed without linking a provider
  const [skipProvider, setSkipProvider] = useState(false);

  // ── Inline provider create ──
  const [createPracticeVisible, setCreatePracticeVisible] = useState(false);
  const [newPracticeName, setNewPracticeName] = useState("");
  const [newDoctorName, setNewDoctorName] = useState("");
  const [newPracticePhone, setNewPracticePhone] = useState("");
  const [newPracticeAddress, setNewPracticeAddress] = useState("");
  const [creatingPractice, setCreatingPractice] = useState(false);

  // ── Duplicate detection ──
  const [similarHits, setSimilarHits] = useState<SimilarityHit[]>([]);
  const [duplicateModalVisible, setDuplicateModalVisible] = useState(false);
  const [remakeOfCaseId, setRemakeOfCaseId] = useState<string | null>(null);

  // ── Confidence tooltip ──
  const [confidenceTooltipVisible, setConfidenceTooltipVisible] = useState(false);

  // ── Submission ──
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // ── Case number ──
  const [caseNumber, setCaseNumber] = useState("");
  const [caseNumberEdited, setCaseNumberEdited] = useState(false);

  const createCase = useCreateCase();

  // Debounce doctor input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDoctor(doctorInput.trim()), 300);
    return () => clearTimeout(t);
  }, [doctorInput]);

  // Auto-fetch case number
  const nextNumberQuery = useQuery({
    queryKey: ["next-case-number", selectedLabId],
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/cases/next-case-number?labOrganizationId=${encodeURIComponent(selectedLabId ?? "")}`,
      );
      if (!res.ok) throw new Error(`Could not fetch case number (${res.status}).`);
      const body = (await res.json()) as { data?: { caseNumber?: string }; caseNumber?: string };
      return body?.data?.caseNumber ?? body?.caseNumber ?? "";
    },
    enabled: !!selectedLabId,
    staleTime: 0,
  });

  useEffect(() => {
    if (!caseNumberEdited && nextNumberQuery.data) setCaseNumber(nextNumberQuery.data);
  }, [nextNumberQuery.data, caseNumberEdited]);

  // Resolve practice alias on mount
  useEffect(() => {
    if (!selectedLabId || !extracted?.practiceName || aliasResolved) return;
    const rxName = extracted.practiceName.trim();
    if (!rxName) { setAliasResolved(true); return; }
    resilientFetch(
      `/api/rx-practice-aliases?labOrganizationId=${encodeURIComponent(selectedLabId)}&rxName=${encodeURIComponent(rxName)}`,
    )
      .then((r) => r.json())
      .then((body: any) => {
        const found = body?.data?.found ?? body?.found;
        const orgId = body?.data?.providerOrganizationId ?? body?.providerOrganizationId;
        if (found && orgId) setProviderOrgId(orgId);
      })
      .catch(() => {})
      .finally(() => setAliasResolved(true));
  }, [selectedLabId, extracted?.practiceName, aliasResolved]);

  // Doctor search
  const doctorSearchParams = { labOrganizationId: selectedLabId ?? "", q: debouncedDoctor };
  const doctorSearch = useSearchDoctors(doctorSearchParams, {
    query: {
      queryKey: getSearchDoctorsQueryKey(doctorSearchParams),
      enabled: !!selectedLabId && debouncedDoctor.length >= 2 && !providerOrgId && !skipProvider,
    },
  });
  const doctorResults: DoctorSearchEntry[] = useMemo(
    () => (doctorSearch.data?.data?.entries ?? []).filter((e) => !!e.providerOrganizationId),
    [doctorSearch.data],
  );

  function onChangeDoctor(text: string) {
    setDoctorInput(text);
    setDoctorName(text);
    if (providerOrgId) {
      setProviderOrgId(null);
      setSkipProvider(false);
    }
  }

  function selectDoctor(entry: DoctorSearchEntry) {
    setDoctorName(entry.doctorName ?? "");
    setProviderOrgId(entry.providerOrganizationId ?? null);
    setDoctorInput(entry.doctorName ?? "");
    setDoctorFocused(false);
    setSkipProvider(false);
    Keyboard.dismiss();
  }

  // ── Inline practice creation ──
  async function handleCreatePractice() {
    if (!newPracticeName.trim()) {
      Alert.alert("Practice name required", "Enter the practice or clinic name.");
      return;
    }
    if (!selectedLabId) {
      Alert.alert("No lab selected", "Select a lab before creating a practice.");
      return;
    }
    setCreatingPractice(true);
    try {
      const res = await resilientFetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "provider",
          name: newPracticeName.trim(),
          ...(newDoctorName.trim() ? { doctorName: newDoctorName.trim() } : {}),
          ...(newPracticePhone.trim() ? { phone: newPracticePhone.trim() } : {}),
          ...(newPracticeAddress.trim() ? { addressLine1: newPracticeAddress.trim() } : {}),
          parentLabOrganizationId: selectedLabId,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        Alert.alert("Could not create practice", `Server responded ${res.status}${text ? `: ${text}` : ""}.`);
        return;
      }
      const body = (await res.json()) as { data?: { id?: string; name?: string } };
      const orgId = body?.data?.id;
      if (!orgId) {
        Alert.alert("Could not create practice", "Practice was created but no ID was returned. Try again.");
        return;
      }
      const name = newDoctorName.trim() || newPracticeName.trim();
      setProviderOrgId(orgId);
      setDoctorName(name);
      setDoctorInput(name);
      setSkipProvider(false);
      setCreatePracticeVisible(false);
      // Clear inline form
      setNewPracticeName("");
      setNewDoctorName("");
      setNewPracticePhone("");
      setNewPracticeAddress("");
    } catch (e) {
      Alert.alert("Network error", e instanceof Error ? e.message : "Could not create practice.");
    } finally {
      setCreatingPractice(false);
    }
  }

  function confirmSkipProvider() {
    Alert.alert(
      "Continue without linking a doctor?",
      "The case will be created without a provider link. You can add the doctor from the case detail later.\n\nIf the practice is new, create it first in the Providers section.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue anyway",
          onPress: () => {
            setSkipProvider(true);
            setDoctorFocused(false);
            Keyboard.dismiss();
          },
        },
      ],
    );
  }

  // ── Patient similarity ──
  async function checkDuplicates(): Promise<SimilarityHit[]> {
    if (!selectedLabId || !patientFirst.trim() || !patientLast.trim()) return [];
    try {
      const params = new URLSearchParams({
        patientFirstName: patientFirst.trim(),
        patientLastName: patientLast.trim(),
        labOrganizationId: selectedLabId,
        ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
        ...(doctorName.trim() ? { doctorName: doctorName.trim() } : {}),
      });
      const res = await resilientFetch(`/api/cases/patient-similarity?${params}`);
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: { matches?: SimilarityHit[] } };
      return body?.data?.matches ?? [];
    } catch {
      return [];
    }
  }

  // ── Save alias after provider confirmed ──
  async function saveAlias(labId: string, orgId: string, rxName: string) {
    if (!rxName.trim()) return;
    try {
      await resilientFetch("/api/rx-practice-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labOrganizationId: labId, rxName, providerOrganizationId: orgId }),
      });
    } catch {
      // Non-critical — silent failure
    }
  }

  // ── PDF generation from captured pages using canonical template ──
  // Returns the upload result so callers can surface attachment failures.
  async function buildAndUploadPdf(
    caseId: string,
    caseNum: string,
  ): Promise<{ ok: true } | { ok: false; error: string } | null> {
    const pages = getAiReaderSession().pages;
    if (pages.length === 0) return null;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #fff; }
.page { width: 100%; min-height: 100vh; display: flex; align-items: center; justify-content: center; page-break-after: always; }
.page:last-child { page-break-after: auto; }
img { max-width: 100%; max-height: 100vh; object-fit: contain; }
</style></head><body>
${pages.map((p) => `<div class="page"><img src="${p.base64}" /></div>`).join("\n")}
</body></html>`;

    let pdfUri: string;
    try {
      const result = await generatePdf(html);
      pdfUri = result.uri;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "PDF generation failed." };
    }

    const uploadResult = await uploadCaseAttachment({
      caseId,
      fileUri: pdfUri,
      fileName: `rx-${caseNum}-${Date.now()}.pdf`,
      mimeType: "application/pdf",
      visibility: "internal_lab_only",
      onProgress: (f) => setUploadProgress(f * 0.5 + 0.5),
    });
    return uploadResult.ok ? { ok: true } : { ok: false, error: uploadResult.error };
  }

  // ── Submit ──
  async function handleSubmit(skipDupeCheck = false, forceSkipProvider = false) {
    if (!selectedLabId) {
      Alert.alert("No lab selected", "Select a lab to create the case in.");
      return;
    }
    if (!caseNumber.trim()) {
      Alert.alert("Case number required", "Enter a case number to continue.");
      return;
    }
    if (!patientFirst.trim() || !patientLast.trim()) {
      Alert.alert("Patient name required", "Enter the patient's first and last name.");
      return;
    }

    // If provider is not resolved and user hasn't confirmed skip, prompt.
    // Use `forceSkipProvider` as an explicit param to avoid the React async-state
    // race that occurs when setSkipProvider(true) is called immediately before
    // handleSubmit() — the state update hasn't committed yet in that same call.
    const effectiveSkipProvider = forceSkipProvider || skipProvider;
    if (!providerOrgId && !effectiveSkipProvider) {
      if (doctorInput.trim()) {
        // They typed something but didn't select — ask them to confirm unlinked
        confirmSkipProvider();
        return;
      } else {
        // No input at all
        Alert.alert(
          "Doctor not linked",
          "No doctor has been selected. Continue without linking a provider, or cancel and search for the doctor?",
          [
            { text: "Search for doctor", style: "cancel" },
            {
              text: "Continue without doctor",
              onPress: () => {
                setSkipProvider(true);
                handleSubmit(skipDupeCheck, true);
              },
            },
          ],
        );
        return;
      }
    }

    // Duplicate check (first pass only)
    if (!skipDupeCheck) {
      setSubmitting(true);
      setUploadProgress(0);
      try {
        const hits = await checkDuplicates();
        if (hits.length > 0) {
          setSimilarHits(hits);
          setDuplicateModalVisible(true);
          setSubmitting(false);
          return;
        }
      } catch {}
    }

    setSubmitting(true);
    setUploadProgress(0.05);

    const restorations = toothIndicesToRestorations(toothIndices, caseType, material, shade);
    const cleanRests: CreateCaseInputRestorationsItem[] = restorations
      .filter((r) => r.toothNumber && r.restorationType)
      .map((r) => ({
        toothNumber: r.toothNumber,
        restorationType: r.restorationType,
        ...(r.material ? { material: r.material } : {}),
        ...(r.shade ? { shade: r.shade } : {}),
      }));

    const labName = labs.find((m) => m.organizationId === selectedLabId)?.organization?.name ?? null;

    const payload: CreateCaseInput = {
      caseNumber: caseNumber.trim(),
      labOrganizationId: selectedLabId,
      ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
      patientFirstName: patientFirst.trim(),
      patientLastName: patientLast.trim(),
      ...(doctorName.trim() ? { doctorName: doctorName.trim() } : {}),
      priority,
      ...(dueDate.trim() ? { dueDate: dueDate.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(cleanRests.length ? { restorations: cleanRests } : {}),
      ...(remakeOfCaseId ? { remakeOfCaseId } : {}),
    };

    try {
      setUploadProgress(0.1);
      const result = await createCase.mutateAsync({ data: payload });
      const newId = result?.data?.id;

      if (!newId) {
        Alert.alert("Case created", "The case was created but could not be opened. Check your cases list.");
        router.replace("/(tabs)/dashboard" as never);
        return;
      }

      // Save alias for future practice auto-resolve
      if (extracted?.practiceName && providerOrgId) {
        await saveAlias(selectedLabId, providerOrgId, extracted.practiceName);
      }

      // Save submission data into the session for label printing
      setAiReaderSession({
        caseId: newId,
        caseNumber: caseNumber.trim(),
        restorations,
        labOrgId: selectedLabId,
        labName,
        doctorName: doctorName.trim() || null,
        patientName: `${patientFirst.trim()} ${patientLast.trim()}`.trim() || null,
        dueDate: dueDate.trim() || null,
      });
      setUploadProgress(0.3);

      // Build and upload Rx PDF — alert user if it fails so they know
      // the prescription scan is not yet attached (case still created).
      try {
        const pdfResult = await buildAndUploadPdf(newId, caseNumber.trim());
        if (pdfResult && !pdfResult.ok) {
          Alert.alert(
            "Rx PDF not attached",
            `Case ${caseNumber.trim()} was created, but the scanned Rx could not be saved as an attachment: ${pdfResult.error}\n\nYou can re-upload it from the case detail.`,
          );
        }
      } catch {
        Alert.alert(
          "Rx PDF not attached",
          `Case ${caseNumber.trim()} was created, but the scanned Rx could not be saved as an attachment due to a network error.\n\nYou can re-upload it from the case detail.`,
        );
      }

      qc.invalidateQueries({ queryKey: ["getCases"] });
      setUploadProgress(1);

      // Navigate to barcode screen
      router.push("/ai-reader/barcode" as never);
    } catch (e) {
      Alert.alert("Couldn't create case", errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/dashboard" as never);
  }

  // ── Duplicate modal decisions ──
  function onDuplicateDecision(decision: DuplicateDecision, hit?: SimilarityHit) {
    setDuplicateModalVisible(false);
    if (decision === "is_duplicate") {
      // Truly a duplicate — cancel
      Alert.alert(
        "Case cancelled",
        "The intake was cancelled because a matching case already exists. Open the existing case from your cases list.",
        [{ text: "OK", onPress: () => router.replace("/(tabs)" as never) }],
      );
      return;
    }
    if (decision === "remake" && hit) {
      setRemakeOfCaseId(hit.id);
    } else {
      setRemakeOfCaseId(null);
    }
    handleSubmit(true);
  }

  // ─── Loading state ─────────────────────────────────────────────────────────
  if (!extracted || meQuery.isLoading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  const confidence = extracted.confidence;
  const lowConfidence = confidence !== null && confidence < 0.6;
  const confidenceTier: "high" | "medium" | "low" | "none" =
    confidence === null ? "none"
    : confidence >= 0.85 ? "high"
    : confidence >= 0.6 ? "medium"
    : "low";
  const firstPageUri = session.pages[0]?.uri ?? null;
  const providerResolved = !!providerOrgId;
  const providerLabel = providerResolved
    ? doctorName
    : skipProvider
      ? `${doctorName.trim() || "No doctor"} (unlinked)`
      : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={goBack} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.headerTitle}>
          <Text style={styles.title}>Review Extraction</Text>
          <Text style={styles.subtitle}>Verify all fields before creating the case</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* Scan preview + confidence badge */}
        {(firstPageUri || confidenceTier !== "none") && (
          <View style={styles.scanPreviewRow}>
            {firstPageUri ? (
              <Image source={{ uri: firstPageUri }} style={styles.scanThumb} resizeMode="contain" />
            ) : (
              <View style={[styles.scanThumb, styles.scanThumbPlaceholder]}>
                <Ionicons name="document-outline" size={28} color={colors.textTertiary} />
              </View>
            )}
            <View style={styles.scanPreviewRight}>
              <Text style={styles.scanPreviewLabel}>Scanned Rx</Text>
              {confidenceTier !== "none" ? (
                <Pressable
                  onPress={() => setConfidenceTooltipVisible(true)}
                  style={[
                    styles.confidenceBadge,
                    confidenceTier === "high" && styles.confidenceBadgeHigh,
                    confidenceTier === "medium" && styles.confidenceBadgeMedium,
                    confidenceTier === "low" && styles.confidenceBadgeLow,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Scan confidence: ${confidenceTier === "high" ? "High" : confidenceTier === "medium" ? "Medium" : "Low"} — ${Math.round((confidence ?? 0) * 100)}%. Tap for details.`}
                  hitSlop={8}
                >
                  <View style={[
                    styles.confidenceDot,
                    confidenceTier === "high" && styles.confidenceDotHigh,
                    confidenceTier === "medium" && styles.confidenceDotMedium,
                    confidenceTier === "low" && styles.confidenceDotLow,
                  ]} />
                  <Text style={[
                    styles.confidenceBadgeText,
                    confidenceTier === "high" && styles.confidenceBadgeTextHigh,
                    confidenceTier === "medium" && styles.confidenceBadgeTextMedium,
                    confidenceTier === "low" && styles.confidenceBadgeTextLow,
                  ]}>
                    {confidenceTier === "high" ? "High" : confidenceTier === "medium" ? "Medium" : "Low"} Confidence
                  </Text>
                  <Text style={[
                    styles.confidencePct,
                    confidenceTier === "high" && styles.confidenceBadgeTextHigh,
                    confidenceTier === "medium" && styles.confidenceBadgeTextMedium,
                    confidenceTier === "low" && styles.confidenceBadgeTextLow,
                  ]}>
                    {Math.round((confidence ?? 0) * 100)}%
                  </Text>
                  <Ionicons
                    name="information-circle-outline"
                    size={14}
                    color={
                      confidenceTier === "high" ? "#15803d"
                      : confidenceTier === "medium" ? "#92400e"
                      : "#991b1b"
                    }
                  />
                </Pressable>
              ) : (
                <Text style={styles.scanPreviewNoConfidence}>No confidence score</Text>
              )}
              {confidenceTier === "low" && (
                <Text style={styles.scanPreviewLowHint}>Review all fields carefully</Text>
              )}
              {confidenceTier === "medium" && (
                <Text style={styles.scanPreviewMediumHint}>Some fields may need correction</Text>
              )}
            </View>
          </View>
        )}

        {/* Low confidence warning */}
        {lowConfidence && (
          <View style={styles.warnBanner}>
            <Ionicons name="warning-outline" size={16} color={colors.warningStrong} />
            <Text style={styles.warnText}>
              The AI had low confidence reading this prescription. Review all fields carefully.
            </Text>
          </View>
        )}

        {/* Lab selector */}
        {labs.length > 1 && (
          <Section label="Lab" styles={styles} colors={colors}>
            <View style={styles.chipRow}>
              {labs.map((m) => {
                const sel = m.organizationId === selectedLabId;
                return (
                  <Pressable
                    key={m.organizationId}
                    style={[styles.chip, sel && styles.chipSelected]}
                    onPress={() => setSelectedLabId(m.organizationId)}
                  >
                    <Text style={[styles.chipText, sel && styles.chipTextSelected]}>
                      {m.organization?.name ?? m.organizationId}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>
        )}

        {/* Case number */}
        <Section label="Case Number" styles={styles} colors={colors}>
          <TextInput
            style={styles.input}
            value={caseNumber}
            onChangeText={(t) => { setCaseNumber(t); setCaseNumberEdited(true); }}
            placeholder="e.g. 26-42"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
          />
        </Section>

        {/* Patient */}
        <Section label="Patient Name" styles={styles} colors={colors}>
          <View style={styles.row2Col}>
            <TextInput
              style={[styles.input, styles.halfInput]}
              value={patientFirst}
              onChangeText={setPatientFirst}
              placeholder="First"
              placeholderTextColor={colors.textTertiary}
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, styles.halfInput]}
              value={patientLast}
              onChangeText={setPatientLast}
              placeholder="Last"
              placeholderTextColor={colors.textTertiary}
              autoCorrect={false}
            />
          </View>
        </Section>

        {/* Doctor / practice */}
        <Section label="Doctor / Practice" styles={styles} colors={colors}>
          {(providerResolved || skipProvider) ? (
            <View style={[styles.resolvedRow, skipProvider && styles.resolvedRowWarn]}>
              <Ionicons
                name={providerResolved ? "checkmark-circle" : "alert-circle-outline"}
                size={18}
                color={providerResolved ? colors.success : colors.warningStrong}
              />
              <Text style={styles.resolvedName} numberOfLines={1}>{providerLabel}</Text>
              <Pressable onPress={() => { setProviderOrgId(null); setSkipProvider(false); }} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
              </Pressable>
            </View>
          ) : (
            <>
              <TextInput
                style={styles.input}
                value={doctorInput}
                onChangeText={onChangeDoctor}
                placeholder="Search doctor name…"
                placeholderTextColor={colors.textTertiary}
                autoCorrect={false}
                onFocus={() => setDoctorFocused(true)}
                onBlur={() => setTimeout(() => setDoctorFocused(false), 200)}
              />
              {doctorFocused && doctorResults.length > 0 && (
                <Card style={styles.dropdown}>
                  {doctorResults.slice(0, 6).map((e, i) => (
                    <Pressable
                      key={i}
                      style={styles.dropdownRow}
                      onPress={() => selectDoctor(e)}
                    >
                      <Text style={styles.dropdownName}>{e.doctorName}</Text>
                      {e.practiceName ? (
                        <Text style={styles.dropdownOrg} numberOfLines={1}>{e.practiceName}</Text>
                      ) : null}
                    </Pressable>
                  ))}
                </Card>
              )}
              {/* No results — offer inline create or skip */}
              {debouncedDoctor.length >= 2 && doctorResults.length === 0 && !doctorSearch.isLoading && !createPracticeVisible && (
                <View style={styles.noResults}>
                  <Text style={styles.noResultsText}>No matching doctors found.</Text>
                  <Pressable
                    style={styles.createPracticeBtn}
                    onPress={() => {
                      setNewPracticeName(doctorInput.trim());
                      setNewDoctorName(doctorInput.trim());
                      setCreatePracticeVisible(true);
                      Keyboard.dismiss();
                    }}
                  >
                    <Ionicons name="add-circle-outline" size={15} color={colors.tint} />
                    <Text style={styles.createPracticeBtnText}>Create new practice…</Text>
                  </Pressable>
                  <Pressable style={styles.skipProviderBtn} onPress={confirmSkipProvider}>
                    <Ionicons name="arrow-forward-circle-outline" size={15} color={colors.textTertiary} />
                    <Text style={styles.skipProviderBtnText}>Continue without linking a doctor</Text>
                  </Pressable>
                </View>
              )}

              {/* Inline new-practice form */}
              {createPracticeVisible && (
                <View style={styles.createPracticeForm}>
                  <View style={styles.createPracticeHeader}>
                    <Ionicons name="business-outline" size={16} color={colors.tint} />
                    <Text style={styles.createPracticeTitle}>New practice</Text>
                    <Pressable onPress={() => setCreatePracticeVisible(false)} hitSlop={8}>
                      <Ionicons name="close" size={18} color={colors.textTertiary} />
                    </Pressable>
                  </View>
                  <TextInput
                    style={styles.input}
                    value={newPracticeName}
                    onChangeText={setNewPracticeName}
                    placeholder="Practice / clinic name *"
                    placeholderTextColor={colors.textTertiary}
                    autoFocus
                  />
                  <TextInput
                    style={styles.input}
                    value={newDoctorName}
                    onChangeText={setNewDoctorName}
                    placeholder="Doctor name (optional)"
                    placeholderTextColor={colors.textTertiary}
                    autoCorrect={false}
                  />
                  <View style={styles.row2Col}>
                    <TextInput
                      style={[styles.input, styles.halfInput]}
                      value={newPracticePhone}
                      onChangeText={setNewPracticePhone}
                      placeholder="Phone (optional)"
                      placeholderTextColor={colors.textTertiary}
                      keyboardType="phone-pad"
                    />
                    <TextInput
                      style={[styles.input, styles.halfInput]}
                      value={newPracticeAddress}
                      onChangeText={setNewPracticeAddress}
                      placeholder="Address (optional)"
                      placeholderTextColor={colors.textTertiary}
                    />
                  </View>
                  <Pressable
                    style={[styles.createPracticeSubmitBtn, creatingPractice && { opacity: 0.55 }]}
                    onPress={handleCreatePractice}
                    disabled={creatingPractice}
                  >
                    {creatingPractice ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                        <Text style={styles.createPracticeSubmitText}>Create &amp; link practice</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              )}
            </>
          )}
        </Section>

        {/* Due date + priority */}
        <Section label="Due Date" styles={styles} colors={colors}>
          <DateField
            value={dueDate}
            onChange={setDueDate}
            placeholder="YYYY-MM-DD"
          />
        </Section>

        <Section label="Priority" styles={styles} colors={colors}>
          <View style={styles.chipRow}>
            {(["normal", "rush"] as const).map((p) => (
              <Pressable
                key={p}
                style={[styles.chip, priority === p && styles.chipSelected]}
                onPress={() => setPriority(p)}
              >
                <Text style={[styles.chipText, priority === p && styles.chipTextSelected]}>
                  {p === "rush" ? "🔴 Rush" : "Normal"}
                </Text>
              </Pressable>
            ))}
          </View>
        </Section>

        {/* Clinical details */}
        <Section label="Case Type" styles={styles} colors={colors}>
          <TextInput
            style={styles.input}
            value={caseType}
            onChangeText={setCaseType}
            placeholder="Crown & Bridge, Removable…"
            placeholderTextColor={colors.textTertiary}
          />
        </Section>

        <Section label="Tooth Numbers" styles={styles} colors={colors}>
          <TextInput
            style={styles.input}
            value={toothIndices}
            onChangeText={setToothIndices}
            placeholder="e.g. 3, 5, 14"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numbers-and-punctuation"
          />
        </Section>

        <View style={styles.row2Col}>
          <View style={styles.halfSection}>
            <Text style={styles.sectionLabel}>Material</Text>
            <TextInput
              style={styles.input}
              value={material}
              onChangeText={setMaterial}
              placeholder="Zirconia, E max…"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.halfSection}>
            <Text style={styles.sectionLabel}>Shade</Text>
            <TextInput
              style={styles.input}
              value={shade}
              onChangeText={setShade}
              placeholder="A2, B1…"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
        </View>

        <Section label="Notes" styles={styles} colors={colors}>
          <TextInput
            style={[styles.input, styles.notesInput]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Special instructions…"
            placeholderTextColor={colors.textTertiary}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </Section>
      </ScrollView>

      {/* Bottom bar */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.md }]}>
        {submitting && uploadProgress > 0 && uploadProgress < 1 && (
          <View style={styles.progressWrap}>
            <View style={[styles.progressBar, { width: `${Math.round(uploadProgress * 100)}%` }]} />
          </View>
        )}
        <Pressable
          style={[styles.createBtn, submitting && styles.createBtnDisabled]}
          onPress={() => handleSubmit(false)}
          disabled={submitting}
          testID="ai-reader-create-btn"
        >
          {submitting ? (
            <>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.createBtnText}>
                {uploadProgress < 0.15 ? "Creating case…" : uploadProgress < 0.8 ? "Uploading Rx…" : "Finishing…"}
              </Text>
            </>
          ) : (
            <>
              <Ionicons name="add-circle-outline" size={18} color="#fff" />
              <Text style={styles.createBtnText}>
                {caseNumber ? `Create Case ${caseNumber}` : "Create Case"}
              </Text>
            </>
          )}
        </Pressable>
      </View>

      {/* Confidence tooltip modal */}
      <Modal visible={confidenceTooltipVisible} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setConfidenceTooltipVisible(false)}>
          <View style={[styles.modalSheet, styles.tooltipSheet]}>
            <View style={styles.modalHandle} />
            <View style={styles.tooltipHeader}>
              <Ionicons name="sparkles" size={20} color={colors.tint} />
              <Text style={styles.modalTitle}>Scan Confidence</Text>
            </View>
            <Text style={styles.modalBody}>
              Confidence is a score (0–100%) reflecting how clearly the AI read this prescription.
            </Text>
            <View style={styles.tooltipTiers}>
              <View style={styles.tooltipTierRow}>
                <View style={[styles.confidenceDot, styles.confidenceDotHigh]} />
                <Text style={styles.tooltipTierLabel}>High (≥ 85%)</Text>
                <Text style={styles.tooltipTierDesc}>Fields are likely accurate.</Text>
              </View>
              <View style={styles.tooltipTierRow}>
                <View style={[styles.confidenceDot, styles.confidenceDotMedium]} />
                <Text style={styles.tooltipTierLabel}>Medium (60–84%)</Text>
                <Text style={styles.tooltipTierDesc}>A few fields may need correction.</Text>
              </View>
              <View style={styles.tooltipTierRow}>
                <View style={[styles.confidenceDot, styles.confidenceDotLow]} />
                <Text style={styles.tooltipTierLabel}>Low (&lt; 60%)</Text>
                <Text style={styles.tooltipTierDesc}>Poor scan or unusual format — verify all fields.</Text>
              </View>
            </View>
            <Pressable style={styles.newCaseBtn} onPress={() => setConfidenceTooltipVisible(false)}>
              <Text style={styles.newCaseBtnText}>Got it</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Duplicate detection modal */}
      <Modal visible={duplicateModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + Spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Similar patient found</Text>
            <Text style={styles.modalBody}>
              These existing cases may be a match. How would you like to proceed?
            </Text>

            <ScrollView style={{ maxHeight: 280 }}>
              {similarHits.slice(0, 5).map((hit, i) => (
                <Pressable
                  key={i}
                  style={styles.hitRow}
                  onPress={() => onDuplicateDecision("remake", hit)}
                >
                  <View style={styles.hitMain}>
                    <Text style={styles.hitName}>
                      {hit.patientFirstName} {hit.patientLastName}
                    </Text>
                    <Text style={styles.hitMeta}>
                      #{hit.caseNumber} · {hit.doctorName ?? "—"} · {hit.status ?? "—"}
                    </Text>
                    {hit.toothNumbers ? (
                      <Text style={styles.hitMeta}>Teeth: {hit.toothNumbers}</Text>
                    ) : null}
                  </View>
                  <View style={[styles.matchBadge, hit.matchKind === "exact" && { backgroundColor: colors.error + "20" }]}>
                    <Text style={[styles.matchBadgeText, hit.matchKind === "exact" && { color: colors.error }]}>
                      {hit.matchKind}
                    </Text>
                  </View>
                  <View style={styles.hitRemakeHint}>
                    <Text style={styles.hitRemakeHintText}>Mark as remake ›</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>

            {/* Three decision options */}
            <Pressable style={styles.newCaseBtn} onPress={() => onDuplicateDecision("create_new")}>
              <Text style={styles.newCaseBtnText}>Create as new case (not a remake)</Text>
            </Pressable>

            <Pressable
              style={styles.duplicateBtn}
              onPress={() => onDuplicateDecision("is_duplicate")}
            >
              <Ionicons name="ban-outline" size={16} color={colors.error} />
              <Text style={styles.duplicateBtnText}>Cancel — this IS a duplicate</Text>
            </Pressable>

            <Pressable style={styles.ghostBtn} onPress={() => setDuplicateModalVisible(false)}>
              <Text style={styles.ghostBtnText}>Go back and edit</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Sub-component ─────────────────────────────────────────────────────────────
function Section({
  label,
  children,
  styles,
  colors,
}: {
  label: string;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  return (
    <View>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    headerTitle: { flex: 1, alignItems: "center" },
    title: { ...Typography.h3, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary },

    content: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },

    warnBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      backgroundColor: c.warningStrong + "18",
      borderLeftWidth: 3,
      borderLeftColor: c.warningStrong,
      padding: Spacing.md,
      borderRadius: Radius.sm,
    },
    warnText: { ...Typography.caption, color: c.warningStrong, flex: 1 },

    sectionLabel: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
      marginBottom: Spacing.xs,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },

    input: {
      ...Typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Platform.OS === "ios" ? Spacing.sm : Spacing.xs,
      backgroundColor: c.surface,
    },
    notesInput: { minHeight: 72, paddingTop: Spacing.sm },

    row2Col: { flexDirection: "row", gap: Spacing.md },
    halfInput: { flex: 1 },
    halfSection: { flex: 1, gap: Spacing.xs },

    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    chip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    chipSelected: { backgroundColor: c.tint, borderColor: c.tint },
    chipText: { ...Typography.captionSemibold, color: c.textSecondary },
    chipTextSelected: { color: "#fff" },

    resolvedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      backgroundColor: c.success + "12",
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.success + "40",
    },
    resolvedRowWarn: {
      backgroundColor: c.warningStrong + "10",
      borderColor: c.warningStrong + "40",
    },
    resolvedName: { ...Typography.bodyMedium, color: c.text, flex: 1 },

    dropdown: {
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      marginTop: Spacing.xs,
      padding: 0,
      overflow: "hidden",
    },
    dropdownRow: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    dropdownName: { ...Typography.bodyMedium, color: c.text },
    dropdownOrg: { ...Typography.caption, color: c.textSecondary, marginTop: 1 },

    noResults: { paddingHorizontal: Spacing.xs, paddingTop: Spacing.xs, gap: Spacing.xs },
    noResultsText: { ...Typography.caption, color: c.textTertiary },
    createPracticeBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: 4,
    },
    createPracticeBtnText: { ...Typography.captionSemibold, color: c.tint },
    skipProviderBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: 2,
    },
    skipProviderBtnText: { ...Typography.captionSemibold, color: c.textTertiary },

    createPracticeForm: {
      marginTop: Spacing.sm,
      gap: Spacing.sm,
      padding: Spacing.md,
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.tint + "40",
    },
    createPracticeHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginBottom: Spacing.xs,
    },
    createPracticeTitle: { ...Typography.bodySemibold, color: c.tint, flex: 1 },
    createPracticeSubmitBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.sm,
      marginTop: Spacing.xs,
    },
    createPracticeSubmitText: { ...Typography.bodySemibold, color: "#fff" },

    bottomBar: {
      padding: Spacing.lg,
      paddingTop: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      gap: Spacing.sm,
    },
    progressWrap: {
      height: 4,
      backgroundColor: c.border,
      borderRadius: Radius.full,
      overflow: "hidden",
    },
    progressBar: {
      height: "100%",
      backgroundColor: c.tint,
      borderRadius: Radius.full,
    },
    createBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    createBtnDisabled: { opacity: 0.55 },
    createBtnText: { ...Typography.bodySemibold, color: "#fff" },

    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    modalSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      padding: Spacing.xl,
      gap: Spacing.md,
    },
    modalHandle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: "center",
      marginBottom: Spacing.sm,
    },
    modalTitle: { ...Typography.h2, color: c.text },
    modalBody: { ...Typography.body, color: c.textSecondary },

    hitRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      marginBottom: Spacing.sm,
      gap: Spacing.sm,
    },
    hitMain: { flex: 1, gap: 2 },
    hitName: { ...Typography.bodyMedium, color: c.text },
    hitMeta: { ...Typography.caption, color: c.textSecondary },
    matchBadge: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderRadius: Radius.full,
      backgroundColor: c.border,
    },
    matchBadgeText: { ...Typography.captionSemibold, color: c.textSecondary },
    hitRemakeHint: { alignItems: "flex-end" },
    hitRemakeHintText: { ...Typography.captionSemibold, color: c.tint },

    newCaseBtn: {
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
      alignItems: "center",
    },
    newCaseBtnText: { ...Typography.bodySemibold, color: "#fff" },

    duplicateBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      paddingVertical: Spacing.sm,
      borderWidth: 1,
      borderColor: c.error + "50",
      backgroundColor: c.error + "08",
    },
    duplicateBtnText: { ...Typography.bodySemibold, color: c.error },

    ghostBtn: { paddingVertical: Spacing.sm, alignItems: "center" },
    ghostBtnText: { ...Typography.body, color: c.textTertiary },

    // ── Scan preview + confidence badge ───────────────────────────────────────
    scanPreviewRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      padding: Spacing.md,
    },
    scanThumb: {
      width: 72,
      height: 96,
      borderRadius: Radius.sm,
      backgroundColor: c.backgroundSolid,
    },
    scanThumbPlaceholder: {
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    scanPreviewRight: {
      flex: 1,
      gap: Spacing.xs,
    },
    scanPreviewLabel: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    scanPreviewNoConfidence: {
      ...Typography.caption,
      color: c.textTertiary,
    },
    scanPreviewLowHint: {
      ...Typography.tiny,
      color: "#991b1b",
      marginTop: 2,
    },
    scanPreviewMediumHint: {
      ...Typography.tiny,
      color: "#92400e",
      marginTop: 2,
    },

    confidenceBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.sm,
      paddingVertical: 5,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    confidenceBadgeHigh: {
      backgroundColor: "#f0fdf4",
      borderColor: "#86efac",
    },
    confidenceBadgeMedium: {
      backgroundColor: "#fffbeb",
      borderColor: "#fcd34d",
    },
    confidenceBadgeLow: {
      backgroundColor: "#fef2f2",
      borderColor: "#fca5a5",
    },

    confidenceDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.textTertiary,
    },
    confidenceDotHigh: { backgroundColor: "#16a34a" },
    confidenceDotMedium: { backgroundColor: "#d97706" },
    confidenceDotLow: { backgroundColor: "#dc2626" },

    confidenceBadgeText: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
    },
    confidenceBadgeTextHigh: { color: "#15803d" },
    confidenceBadgeTextMedium: { color: "#92400e" },
    confidenceBadgeTextLow: { color: "#991b1b" },

    confidencePct: {
      ...Typography.captionSemibold,
      color: c.textTertiary,
    },

    // ── Confidence tooltip modal ──────────────────────────────────────────────
    tooltipSheet: {
      borderRadius: Radius.xl,
      marginHorizontal: Spacing.xl,
      marginBottom: 0,
      alignSelf: "center",
      width: "auto",
    },
    tooltipHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    tooltipTiers: {
      gap: Spacing.sm,
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.md,
      padding: Spacing.md,
    },
    tooltipTierRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    tooltipTierLabel: {
      ...Typography.captionSemibold,
      color: c.text,
      width: 100,
    },
    tooltipTierDesc: {
      ...Typography.caption,
      color: c.textSecondary,
      flex: 1,
    },
  });
}
