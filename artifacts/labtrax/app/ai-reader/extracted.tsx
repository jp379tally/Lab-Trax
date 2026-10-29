import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  readExplicitAiToothAssignments, withPonticConnectorSuggestions, serializeConnectorState,
  updateConnectorChoices, validateToothConnectors, toothAssignmentSummary, applyToothAssignmentDefaults, type ToothAssignmentValues,
  expandToothAssignmentIdentifiers,
} from "@workspace/case-taxonomy";
import { ToothActionSheet, type ToothActionPayload } from "@/components/ToothActionSheet";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
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
  useListLabProviders,
  getListLabProvidersQueryKey,
  useGetPreCreateInvoiceItems,
  getGetPreCreateInvoiceItemsQueryKey,
  type CreateCaseInput,
  type CreateCaseInputRestorationsItem,
  type DoctorMatchCandidate,
  type LabProvider,
  type PreviewDraftInvoiceInput,
  type PreviewDraftInvoiceResultData,
} from "@workspace/api-client-react";
import {
  addCalendarDays,
  getLocalCalendarDateParts,
  resolveAiIntakePrescriptionDueDate,
} from "@workspace/calendar-date";
import { resilientFetch } from "@/lib/query-client";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import { buildCaseCardHtml, generatePdf, type CaseCardRestoration } from "@/lib/case-pdf";
import { useMe, editableLabMemberships, adminLabMemberships } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { DateField } from "@/components/DateField";
import { FormSheet } from "@/components/ui/FormSheet";
import { BillableItemPicker, type BillableItem } from "@/components/BillableItemPicker";
import { ToothChart } from "@/components/ToothChart";
import {
  getAiReaderSession,
  setAiReaderSession,
  type ExtractedRx,
  type AiReaderRestoration,
  type AiReaderUserOverrides,
} from "@/lib/ai-reader-store";
import {
  normalizeCaseHierarchy,
  REMAKE_REASONS,
  remakeReasonUsesField,
} from "@workspace/case-taxonomy";
import { ARCH_OPTIONS, type ArchSelection, isArchRequired } from "@/lib/arch";
import { refreshCaseFinanceQueries } from "@/lib/refresh-case-finance";

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

function todayCalendarDate(): string {
  const parts = getLocalCalendarDateParts(new Date());
  if (!parts) return "";
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function expandToothIdentifiers(raw: string | null | undefined): string[] {
  return expandToothAssignmentIdentifiers(raw);
}

function toothIndicesToRestorations(
  toothIndices: string | null | undefined,
  caseType: string | null | undefined,
  material: string | null | undefined,
  shade: string | null | undefined,
): AiReaderRestoration[] {
  const rest = caseType?.trim() || "Crown & Bridge";
  if (!toothIndices?.trim()) {
    // No tooth numbers extracted — but if shade/material/caseType carries
    // meaningful information, preserve it as a single fallback restoration so
    // the values aren't silently dropped from the case overview.
    if (shade?.trim() || material?.trim() || caseType?.trim()) {
      return [{
        toothNumber: "N/A",
        restorationType: rest,
        ...(material?.trim() ? { material: material.trim() } : {}),
        ...(shade?.trim() ? { shade: shade.trim() } : {}),
      }];
    }
    return [];
  }
  const teeth = expandToothIdentifiers(toothIndices);
  return teeth.map((tooth) => ({
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

function normalizeDoctorMemoryKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\bdr\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type PracticeLookupPayload = {
  found?: boolean;
  providerOrganizationId?: string | null;
};

function lookedUpOrgId(
  body: { data?: PracticeLookupPayload } | null | undefined,
): string | null {
  const payload = body?.data;
  return payload?.found && payload.providerOrganizationId
    ? payload.providerOrganizationId
    : null;
}

function formatCandidatePracticeAddress(candidate: DoctorMatchCandidate): string {
  return [
    candidate.practiceAddressLine1,
    candidate.practiceCity,
    candidate.practiceState,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

const PRACTICE_MEMORY_TIMEOUT_MS = 5_000;

async function practiceMemoryFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resilientFetch(url, init),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Practice resolution timed out")),
          PRACTICE_MEMORY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForPracticeMemoryMutation(
  mutation: Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mutation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Saving doctor practice timed out")),
          PRACTICE_MEMORY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function formatSimilarityDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}
const MOBILE_REMAKE_REASONS = REMAKE_REASONS.filter((reason) => reason.category !== null);
const MOBILE_SHADE_KEYS = new Set<string>(
  REMAKE_REASONS.filter((reason) => remakeReasonUsesField(reason.key, "shade")).map((reason) => reason.key),
);
const MOBILE_MATERIAL_KEYS = new Set<string>(
  REMAKE_REASONS.filter((reason) => remakeReasonUsesField(reason.key, "material")).map((reason) => reason.key),
);
const DIAGNOSTIC_WAX_UP_LABEL = "Diagnostic Wax Up";
const DIAGNOSTIC_WAX_UP_SUBTYPE = "restorative/diagnostic_wax_up";

function isDiagnosticWaxUp(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLocaleLowerCase() ===
    DIAGNOSTIC_WAX_UP_LABEL.toLocaleLowerCase();
}

interface MobileRemakeAnswers {
  remakeOfCaseId: string;
  remakeReasonKey: string;
  remakeReason: string;
  remakeCharged: boolean;
  remakeShadeLightness?: "light" | "dark";
  remakeShadePrescribed?: string;
  remakeShadeProvided?: string;
  remakeMaterialPrescribed?: string;
  remakeMaterialProvided?: string;
  remakeReturnedToLab?: boolean;
  remakeCategory?: "crown_bridge" | "removable";
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
  // Fields the user explicitly edited on a prior visit to this screen.
  // They take precedence over whatever the AI returns on a re-scan.
  const userOverrides: AiReaderUserOverrides = session.userOverrides ?? {};

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
  // Each field initializes from userOverrides when the user already edited it
  // on a prior visit (e.g. added more pages and re-ran analysis), so a re-scan
  // never silently overwrites an intentional edit.
  const initialCaseType = userOverrides.caseType !== undefined
    ? userOverrides.caseType
    : (extracted?.caseType ?? "");
  const initialDiagnosticWaxUp = isDiagnosticWaxUp(initialCaseType);
  const initialMaterial = userOverrides.material !== undefined
    ? userOverrides.material
    : initialDiagnosticWaxUp
      ? DIAGNOSTIC_WAX_UP_LABEL
      : (extracted?.material ?? "");
  const initialShade = userOverrides.shade !== undefined
    ? userOverrides.shade
    : initialDiagnosticWaxUp
      ? DIAGNOSTIC_WAX_UP_LABEL
      : (extracted?.shade ?? "");
  const extractedAssignmentValues = Object.fromEntries(
    readExplicitAiToothAssignments(extracted?.toothAssignments).map((unit) => [
      unit.toothNumber,
      initialDiagnosticWaxUp
        ? {
            material: initialMaterial,
            shade: initialShade,
            restorationSubtype: DIAGNOSTIC_WAX_UP_SUBTYPE,
          }
        : { material: unit.material ?? undefined, shade: unit.shade ?? undefined },
    ]),
  );
  const patientSplit = useMemo(() => splitName(extracted?.patientName), [extracted]);
  const [patientFirst, setPatientFirst] = useState(
    userOverrides.patientFirst !== undefined ? userOverrides.patientFirst : patientSplit.first,
  );
  const [patientLast, setPatientLast] = useState(
    userOverrides.patientLast !== undefined ? userOverrides.patientLast : patientSplit.last,
  );
  const [receivedAt, setReceivedAt] = useState(
    userOverrides.receivedAt !== undefined ? userOverrides.receivedAt : todayCalendarDate(),
  );
  const [labDueDate, setLabDueDate] = useState(
    userOverrides.labDueDate !== undefined
      ? userOverrides.labDueDate
      : userOverrides.dueDate !== undefined ? userOverrides.dueDate : "",
  );
  const [labDueDateEdited, setLabDueDateEdited] = useState(
    userOverrides.labDueDateEdited ??
      (userOverrides.labDueDate !== undefined || userOverrides.dueDate !== undefined),
  );
  const [rxDueDate, setRxDueDate] = useState(
    userOverrides.rxDueDate !== undefined
      ? userOverrides.rxDueDate
      : parseDueDateMDY(extracted?.dueDate),
  );
  const selectedLab = labs.find((membership) => membership.organizationId === selectedLabId)?.organization;
  const configuredTurnaroundDays = selectedLab?.defaultCaseDueDays as number | null | undefined;
  const turnaroundDays =
    configuredTurnaroundDays != null &&
    Number.isInteger(configuredTurnaroundDays) &&
    configuredTurnaroundDays > 0
      ? configuredTurnaroundDays
      : null;
  const automaticLabDueDate = !labDueDateEdited && receivedAt && turnaroundDays != null
    ? addCalendarDays(receivedAt, turnaroundDays) ?? ""
    : "";
  const reviewedLabDueDate = labDueDateEdited ? labDueDate : automaticLabDueDate;
  const eligibleRxDueDate =
    resolveAiIntakePrescriptionDueDate(rxDueDate, receivedAt, turnaroundDays) ?? "";
  const showRxDueDateField =
    turnaroundDays == null || !rxDueDate || !!eligibleRxDueDate;
  const [priority, setPriority] = useState<"normal" | "rush">(
    userOverrides.priority !== undefined ? userOverrides.priority : (extracted?.isRush ? "rush" : "normal"),
  );
  const [notes, setNotes] = useState(
    userOverrides.notes !== undefined ? userOverrides.notes : (extracted?.notes ?? ""),
  );
  const [shade, setShade] = useState(initialShade);
  const [gingivialShade, setGingivialShade] = useState(
    userOverrides.gingivialShade !== undefined ? userOverrides.gingivialShade : (extracted?.gingivialShade ?? ""),
  );
  const [material, setMaterial] = useState(initialMaterial);
  const [caseType, setCaseType] = useState(initialCaseType);
  const [arch, setArch] = useState<ArchSelection | null>(
    userOverrides.arch !== undefined ? userOverrides.arch : (extracted?.arch ?? null),
  );
  const [toothIndices, setToothIndices] = useState(
    userOverrides.toothIndices !== undefined ? userOverrides.toothIndices : (extracted?.toothIndices ?? ""),
  );
  const [assignmentRoles, setAssignmentRoles] = useState<Record<string, "Crown" | "Pontic" | "Veneer">>(
    userOverrides.assignmentRoles ?? Object.fromEntries(readExplicitAiToothAssignments(extracted?.toothAssignments).map((unit) => [unit.toothNumber, unit.restorationType as "Crown" | "Pontic"])),
  );
  const [assignmentValues, setAssignmentValues] = useState<Record<string, ToothAssignmentValues>>({
    ...(userOverrides.assignmentValues ?? extractedAssignmentValues),
  });
  const [draftConnectors, setDraftConnectors] = useState(userOverrides.bridgeConnectors ?? "");
  useEffect(() => {
    const current = getAiReaderSession().userOverrides;
    if (current.assignmentRoles === undefined) {
      setAiReaderSession({ userOverrides: { ...current, assignmentRoles, assignmentValues, toothIndices } });
    }
  }, []);
  const [activeAssignmentTooth, setActiveAssignmentTooth] = useState<string | null>(null);
  const [assignmentUndo, setAssignmentUndo] = useState<{
    roles: typeof assignmentRoles; values: typeof assignmentValues;
    teeth: typeof toothIndices; connectors: string; material: string; shade: string;
  } | null>(null);
  function captureAssignmentUndo() {
    setAssignmentUndo({ roles: assignmentRoles, values: assignmentValues, teeth: toothIndices, connectors: draftConnectors, material, shade });
  }
  function changeCaseType(value: string) {
    const currentOverrides = getAiReaderSession().userOverrides;
    const wasDiagnosticWaxUp = isDiagnosticWaxUp(caseType);
    setCaseType(value);

    if (isDiagnosticWaxUp(value)) {
      if (wasDiagnosticWaxUp) {
        saveOverride("caseType", value);
        return;
      }
      const nextValues = { ...assignmentValues };
      for (const [tooth, role] of Object.entries(assignmentRoles)) {
        if (!/^(Crown|Pontic|Veneer)$/.test(role)) continue;
        nextValues[tooth] = {
          ...nextValues[tooth],
          material: DIAGNOSTIC_WAX_UP_LABEL,
          shade: DIAGNOSTIC_WAX_UP_LABEL,
          restorationSubtype: DIAGNOSTIC_WAX_UP_SUBTYPE,
        };
      }
      setMaterial(DIAGNOSTIC_WAX_UP_LABEL);
      setShade(DIAGNOSTIC_WAX_UP_LABEL);
      setAssignmentValues(nextValues);
      setAiReaderSession({
        userOverrides: {
          ...currentOverrides,
          caseType: value,
          material: DIAGNOSTIC_WAX_UP_LABEL,
          shade: DIAGNOSTIC_WAX_UP_LABEL,
          assignmentValues: nextValues,
          assignmentOverridesManual: true,
        },
      });
      return;
    }

    if (wasDiagnosticWaxUp) {
      const nextValues = { ...assignmentValues };
      let assignmentsChanged = false;
      for (const [tooth, assignment] of Object.entries(nextValues)) {
        if (assignment?.restorationSubtype !== DIAGNOSTIC_WAX_UP_SUBTYPE) continue;
        nextValues[tooth] = { ...assignment, restorationSubtype: undefined };
        assignmentsChanged = true;
      }
      if (assignmentsChanged) setAssignmentValues(nextValues);
      setAiReaderSession({
        userOverrides: {
          ...currentOverrides,
          caseType: value,
          ...(assignmentsChanged
            ? { assignmentValues: nextValues, assignmentOverridesManual: true }
            : {}),
        },
      });
      return;
    }

    saveOverride("caseType", value);
  }
  const toothIds = useMemo(() => expandToothIdentifiers(toothIndices), [toothIndices]);
  const requiresExplicitToothRoles =
    normalizeCaseHierarchy({ caseType, material }).hierarchy.caseType === "restorative";
  function setToothRole(toothId: string, role: "Crown" | "Pontic" | "Veneer") {
    captureAssignmentUndo();
    const next = { ...assignmentRoles, [toothId]: role };
    setAssignmentRoles(next);
    saveOverride("assignmentRoles", next);
  }
  // Fabrication step — inferred by AI for removable cases
  const [step, setStep] = useState<"custom_tray" | "rims_and_plates" | "wax_setup" | "process" | null>(
    userOverrides.step !== undefined ? userOverrides.step : (extracted?.step ?? null),
  );

  // ── Provider / doctor ──
  // Doctor name is free text per-Rx — provider orgs carry no doctor name.
  const [doctorName, setDoctorName] = useState(
    userOverrides.doctorName !== undefined ? userOverrides.doctorName : (extracted?.doctorName ?? ""),
  );
  const [providerOrgId, setProviderOrgId] = useState<string | null>(null);
  // Display fallback for the linked practice before the list query resolves
  // (e.g. right after inline create or alias auto-resolve).
  const [pickedPracticeName, setPickedPracticeName] = useState<string | null>(null);
  const practiceResolutionKeyRef = useRef("");
  const practiceResolutionRequestRef = useRef(0);
  const doctorMemoryWriteQueueRef = useRef(Promise.resolve());
  const doctorMemoryWriteVersionRef = useRef(0);
  const [practiceResolutionPending, setPracticeResolutionPending] = useState(true);
  const [doctorMemoryOrgId, setDoctorMemoryOrgId] = useState<string | null>(null);
  const [doctorMemoryKey, setDoctorMemoryKey] = useState("");
  const [doctorMemoryError, setDoctorMemoryError] = useState<string | null>(null);
  const [savingDoctorMemory, setSavingDoctorMemory] = useState(false);
  const [doctorIdentify, setDoctorIdentify] = useState<{
    candidates: DoctorMatchCandidate[];
    typedName: string;
  } | null>(null);
  const [confirmedDoctorName, setConfirmedDoctorName] = useState<string | null>(null);
  // ── Practice picker modal ──
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");

  // ── Inline provider create ──
  const [createPracticeVisible, setCreatePracticeVisible] = useState(false);
  const [newPracticeName, setNewPracticeName] = useState("");
  const [newDoctorName, setNewDoctorName] = useState("");
  const [newPracticePhone, setNewPracticePhone] = useState("");
  const [newPracticeAddress, setNewPracticeAddress] = useState("");
  const [creatingPractice, setCreatingPractice] = useState(false);

  // ── Duplicate detection ──
  const [similarHits, setSimilarHits] = useState<SimilarityHit[]>([]);
  const [earlyDuplicate, setEarlyDuplicate] = useState<{
    inputKey: string;
    hit: SimilarityHit;
  } | null>(null);
  const earlyDuplicateSequenceRef = useRef(0);
  const earlyDuplicateInputKeyRef = useRef("");
  const [duplicateModalVisible, setDuplicateModalVisible] = useState(false);
  const [remakeOfCaseId, setRemakeOfCaseId] = useState<string | null>(null);
  const [duplicateTruncated, setDuplicateTruncated] = useState(false);
  const [duplicateTotalFound, setDuplicateTotalFound] = useState(0);

  // ── Remake questionnaire state ──
  const [remakeQuestionnaireVisible, setRemakeQuestionnaireVisible] = useState(false);
  const [remakePendingHit, setRemakePendingHit] = useState<SimilarityHit | null>(null);
  const [remakeReasonKey, setRemakeReasonKey] = useState<string>("");
  const [remakeShadeLightness, setRemakeShadeLightness] = useState<"light" | "dark" | null>(null);
  const [remakeShadePrescribed, setRemakeShadePrescribed] = useState("");
  const [remakeShadeProvided, setRemakeShadeProvided] = useState("");
  const [remakeMaterialPrescribed, setRemakeMaterialPrescribed] = useState("");
  const [remakeMaterialProvided, setRemakeMaterialProvided] = useState("");
  const [remakeReturnedToLab, setRemakeReturnedToLab] = useState<boolean | null>(null);
  const [remakeCharged, setRemakeCharged] = useState<boolean | null>(null);

  // ── Scroll ref (keyboard avoidance) ──
  const scrollViewRef = useRef<ScrollView>(null);


  // ── Confidence tooltip ──
  const [confidenceTooltipVisible, setConfidenceTooltipVisible] = useState(false);

  // ── Submission ──
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // Doctor-confirmation sheet — populated when the server returns
  // 409 DOCTOR_CONFIRMATION_REQUIRED because the typed name closely matches an
  // existing doctor in this practice. Mirrors the New Case screen's flow.
  const [doctorConfirm, setDoctorConfirm] = useState<{
    candidates: DoctorMatchCandidate[];
    typedName: string;
  } | null>(null);
  // Required "doctor not on file" step — populated in handleSubmit when the
  // scanned name does NOT strictly match an existing doctor in the selected
  // lab+practice. Blocks case creation until the user either picks a suggested
  // existing doctor (adopting its stored spelling) or confirms a brand-new one.
  const [doctorResolve, setDoctorResolve] = useState<{
    candidates: DoctorMatchCandidate[];
    typedName: string;
  } | null>(null);

  // ── Case number ──
  const [caseNumber, setCaseNumber] = useState("");
  const [caseNumberEdited, setCaseNumberEdited] = useState(false);

  const createCase = useCreateCase();

  // ── Draft-invoice preview + inline price edits ────────────────────────────
  // Mirrors the desktop drop-zone: shows the line items + total that WOULD be
  // generated when the case is created (POST /invoices/preview-draft), and lets
  // the user override each line's unit price or mark it no-charge before
  // creating. Overrides are keyed by the line's restoration indices (joined) so
  // they survive re-renders and map 1:1 back to the source restorations the
  // server collapsed into that line.
  type LinePriceOverride = { unitPrice: string; noCharge: boolean };
  const [invoicePreview, setInvoicePreview] =
    useState<PreviewDraftInvoiceResultData | null>(null);
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false);
  const [invoicePreviewError, setInvoicePreviewError] = useState(false);
  const [invoicePreviewRetryVersion, setInvoicePreviewRetryVersion] = useState(0);
  const [retryPreservedLineCount, setRetryPreservedLineCount] = useState(0);
  const previewRetryRequestedRef = useRef(false);
  const preserveManualLinesAfterPreviewRetryRef = useRef(false);
  const [priceOverrides, setPriceOverrides] = useState<
    Record<string, LinePriceOverride>
  >({});

  // The restorations array sent to BOTH the preview endpoint and POST /cases.
  // Building it once here keeps the positional index mapping that the override
  // logic relies on identical between preview and create.
  const previewRestorations = useMemo<CreateCaseInputRestorationsItem[]>(() => {
    // Compute restorationSubtype from the current caseType + material so it is
    // written on every restoration row and doesn't need to be re-derived later.
    const { restorationSubtype } = normalizeCaseHierarchy({
      caseType: caseType ?? null,
      material: material ?? null,
    });
    const base = toothIndicesToRestorations(toothIndices, caseType, material, shade)
      .filter((r) => r.toothNumber && r.restorationType)
      .map((r) => {
        const role = assignmentRoles[r.toothNumber];
        const assignedMaterial = assignmentValues[r.toothNumber]?.material ?? material ?? r.material;
        const hasValidAssignment =
          requiresExplicitToothRoles &&
          /^(Crown|Pontic|Veneer)$/.test(role ?? "") &&
          !!assignedMaterial?.trim();
        const rowMaterial = hasValidAssignment ? assignedMaterial : r.material;
        const rowShade = hasValidAssignment
          ? assignmentValues[r.toothNumber]?.shade ?? shade ?? r.shade
          : r.shade;
        const rowSubtype = hasValidAssignment
          ? assignmentValues[r.toothNumber]?.restorationSubtype ??
            normalizeCaseHierarchy({ caseType, material: rowMaterial }).restorationSubtype ??
            restorationSubtype
          : restorationSubtype;
        return {
          toothNumber: r.toothNumber,
          // Unassigned teeth keep the extracted Rx row instead of becoming an
          // empty restoration that hides invoice preview and case details.
          restorationType: hasValidAssignment ? role! : r.restorationType,
          ...(rowMaterial ? { material: rowMaterial } : {}),
          ...(rowShade ? { shade: rowShade } : {}),
          ...(rowSubtype ? { restorationSubtype: rowSubtype } : {}),
        };
      })
      .filter((r) => !!r.restorationType);
    if (isArchRequired(normalizeCaseHierarchy({ caseType, material }).hierarchy.caseType)) {
      return base.flatMap((r) =>
        arch === "both"
          ? [{ ...r, arch: "upper" }, { ...r, arch: "lower" }]
          : arch
            ? [{ ...r, arch }]
            : [r],
      ) as CreateCaseInputRestorationsItem[];
    }
    return base;
  }, [toothIndices, caseType, material, shade, arch, assignmentRoles, assignmentValues, requiresExplicitToothRoles]);
  const draftConnectorState = withPonticConnectorSuggestions(draftConnectors, previewRestorations);
  function currentAssignmentDefaults() {
    const values = { ...assignmentValues };
    for (const unit of previewRestorations) values[unit.toothNumber] = {
      ...values[unit.toothNumber],
      restorationSubtype: values[unit.toothNumber]?.restorationSubtype ?? unit.restorationSubtype ?? undefined,
      material: values[unit.toothNumber]?.material ?? unit.material ?? undefined,
      shade: values[unit.toothNumber]?.shade ?? unit.shade ?? undefined,
    };
    return values;
  }
  function applyClinicalAssignmentDefaults(patch: { material?: string; shade?: string }) {
    const values = applyToothAssignmentDefaults(currentAssignmentDefaults(), patch);
    if (isDiagnosticWaxUp(caseType)) {
      for (const [tooth, role] of Object.entries(assignmentRoles)) {
        if (!/^(Crown|Pontic|Veneer)$/.test(role)) continue;
        values[tooth] = {
          ...values[tooth],
          restorationSubtype: DIAGNOSTIC_WAX_UP_SUBTYPE,
        };
      }
    }
    return values;
  }
  const draftConnectorText = serializeConnectorState(draftConnectorState);
  const draftConnectorValidation = validateToothConnectors(draftConnectorText, previewRestorations);
  const draftAssignmentSummary = toothAssignmentSummary(previewRestorations, draftConnectorText);
  const draftConnectorsReady =
    draftConnectorValidation.valid && draftAssignmentSummary.unresolvedPontics.length === 0;
  const aiAssignmentProposal = readExplicitAiToothAssignments(extracted?.toothAssignments);
  const aiAssignmentDiffers = Object.entries(userOverrides.assignmentRoles ?? {}).some(([tooth, role]) =>
    aiAssignmentProposal.find((unit) => unit.toothNumber === tooth)?.restorationType !== role) ||
    Object.entries(userOverrides.assignmentValues ?? {}).some(([tooth, values]) => {
      const proposed = aiAssignmentProposal.find((unit) => unit.toothNumber === tooth);
      return (values.material !== undefined && values.material !== proposed?.material) ||
        (values.shade !== undefined && values.shade !== proposed?.shade);
    });
  function applyAssignmentDraft(payload: ToothActionPayload) {
    if (submitting) return;
    captureAssignmentUndo();
    const roles = { ...assignmentRoles };
    const values = { ...assignmentValues };
    const teeth = new Set(toothIds);
    if (payload.kind === "add_crown" || payload.kind === "add_pontic") {
      roles[payload.toothId] = payload.kind === "add_pontic" ? "Pontic" : payload.restorationType === "Veneer" ? "Veneer" : "Crown";
      values[payload.toothId] = { material: payload.material, shade: payload.shade ?? "", restorationSubtype: payload.restorationSubtype };
      teeth.add(payload.toothId);
    } else if (payload.kind === "change_role") roles[payload.toothId] = payload.role;
    else if (payload.kind === "change_restoration") {
      values[payload.toothId] = { material: payload.material, shade: payload.shade ?? "", restorationSubtype: payload.restorationSubtype };
    } else if (payload.kind === "copy_assignment") {
      for (const tooth of payload.toothNumbers) {
        roles[tooth] = payload.role;
        values[tooth] = { material: payload.material, shade: payload.shade ?? "", restorationSubtype: payload.restorationSubtype };
        teeth.add(tooth);
      }
    } else if (payload.kind === "remove_restoration" || payload.kind === "mark_missing") {
      delete roles[payload.toothId]; delete values[payload.toothId]; teeth.delete(payload.toothId);
    }
    const nextTeeth = [...teeth].join(", ");
    setAssignmentRoles(roles); setAssignmentValues(values); setToothIndices(nextTeeth);
    setAiReaderSession({ userOverrides: {
      ...getAiReaderSession().userOverrides, assignmentRoles: roles, assignmentValues: values, toothIndices: nextTeeth, assignmentOverridesManual: true,
    } });
    setActiveAssignmentTooth(null);
  }

  // The grouping (and therefore the line→index mapping) only changes when the
  // teeth, case type, material, or shade change. Reset overrides then so a
  // stale edit can't reattach to a different line.
  useEffect(() => {
    setPriceOverrides({});
    setAlloyAcknowledged(false);
  }, [toothIndices, caseType, material, shade, assignmentRoles, assignmentValues, draftConnectors]);

  // Alloy pre-create warning: when the preview includes PFM/FCM alloy sub-items
  // at $0 (priced:false + description starts with "Alloy"), the user must
  // acknowledge before the Create Case button becomes enabled.
  const [alloyAcknowledged, setAlloyAcknowledged] = useState(false);
  const alloyUnpricedSubItems = (invoicePreview?.lineItems ?? [])
    .flatMap((l) => ((l as any).subItems ?? []) as Array<{ description?: string; priced?: boolean }>)
    .filter((s) => s.priced === false && (s.description ?? "").startsWith("Alloy"));
  const hasUnpricedAlloy = alloyUnpricedSubItems.length > 0;

  // Full-line edit state for admin/owner users: description, qty, unit price,
  // add/remove. Sent as invoiceOverrideLines on submit.
  type EditedLine = {
    key: string;
    description: string;
    qty: string;
    unitPrice: string;
    isCustom: boolean;
    catalogItemKey: string | null;
  };
  const [editedLines, setEditedLines] = useState<EditedLine[] | null>(null);
  const [pickerOpenForKey, setPickerOpenForKey] = useState<string | null>(null);

  const isAdminForSelectedLab = useMemo(
    () => adminLabMemberships(meQuery.data).some((m) => m.organizationId === selectedLabId),
    [meQuery.data, selectedLabId],
  );

  const preCreateItemsParams = {
    labOrganizationId: selectedLabId ?? "",
    ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
    ...(doctorName.trim() ? { doctorName: doctorName.trim() } : {}),
  };
  const billableItemsQuery = useGetPreCreateInvoiceItems(preCreateItemsParams, {
    query: {
      queryKey: getGetPreCreateInvoiceItemsQueryKey(preCreateItemsParams),
      enabled: isAdminForSelectedLab && !!selectedLabId,
      staleTime: 60_000,
    },
  });
  const billableItems: BillableItem[] = useMemo(() => {
    const data = billableItemsQuery.data?.data;
    const seen = new Set<string>();
    const options: BillableItem[] = [];
    // Catalog prices include standard/material items even when the lab has no
    // matching custom billable row. Prefer that pricing key for duplicate names.
    for (const item of data?.catalogItems ?? []) {
      const name = item.label.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      options.push({
        id: `catalog:${item.key}`,
        priceKey: item.key,
        name,
        unitPrice: item.unitPrice,
      });
    }
    for (const item of data?.items ?? []) {
      const name = item.name.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      options.push({
        id: `billable:${item.id}`,
        priceKey: item.priceKey,
        name,
        unitPrice: item.unitPrice,
      });
    }
    return options;
  }, [billableItemsQuery.data]);

  // Whenever the invoice preview updates (new pricing data), reset editedLines
  // so the admin table reflects the freshest auto-pricing. A failed preview
  // still needs an empty admin editor for manually reviewed invoice lines.
  // After an explicit retry, append the refreshed preview to existing edits
  // rather than silently replacing the lines the user reviewed while offline.
  useEffect(() => {
    if (!isAdminForSelectedLab) {
      preserveManualLinesAfterPreviewRetryRef.current = false;
      setRetryPreservedLineCount(0);
      setEditedLines(null);
      return;
    }

    if (preserveManualLinesAfterPreviewRetryRef.current) {
      if (!invoicePreview) {
        // Keep the manual editor intact while the retry is running or failed.
        return;
      }
      const previewLines = (invoicePreview.lineItems ?? []).map((li, idx) => ({
        key: `${idx}-${li.description ?? ""}`,
        description: [li.toothLabel, li.description].filter(Boolean).join(" "),
        qty: String(li.quantity ?? 1),
        unitPrice: li.priced === false ? "" : li.unitPrice ?? "0.00",
        isCustom: false,
        catalogItemKey: null,
      }));
      const preservedCount = editedLines?.length ?? 0;
      setEditedLines((previous) => [...previewLines, ...(previous ?? [])]);
      setRetryPreservedLineCount(preservedCount);
      preserveManualLinesAfterPreviewRetryRef.current = false;
      return;
    }

    setRetryPreservedLineCount(0);
    setEditedLines(
      invoicePreview
        ? (invoicePreview.lineItems ?? []).map((li, idx) => ({
            key: `${idx}-${li.description ?? ""}`,
            description: [li.toothLabel, li.description].filter(Boolean).join(" "),
            qty: String(li.quantity ?? 1),
            unitPrice: li.priced === false ? "" : li.unitPrice ?? "0.00",
            isCustom: false,
            catalogItemKey: null,
          }))
        : invoicePreviewError ? [] : null,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoicePreview, invoicePreviewError, isAdminForSelectedLab]);

  function setLineOverride(key: string, patch: Partial<LinePriceOverride>) {
    setPriceOverrides((prev) => ({
      ...prev,
      [key]: {
        unitPrice: prev[key]?.unitPrice ?? "",
        noCharge: prev[key]?.noCharge ?? false,
        ...patch,
      },
    }));
  }

  // Apply the inline overrides to a freshly-built restorations array (indices
  // align: both preview and create build restorations from the same teeth list
  // in the same order). A no-charge edit sends unitPrice 0 with priceOverridden
  // so the server treats it as a deliberate $0 line instead of auto-pricing it.
  function applyPriceOverrides(
    restos: CreateCaseInputRestorationsItem[],
  ): CreateCaseInputRestorationsItem[] {
    if (Object.keys(priceOverrides).length === 0) return restos;
    const byIndex: Record<number, LinePriceOverride> = {};
    for (const li of invoicePreview?.lineItems ?? []) {
      const indices = li.restorationIndices ?? [];
      if (indices.length === 0) continue;
      const ov = priceOverrides[indices.join("-")];
      if (!ov) continue;
      for (const idx of indices) byIndex[idx] = ov;
    }
    return restos.map((resto, i) => {
      const ov = byIndex[i];
      if (!ov) return resto;
      if (ov.noCharge) return { ...resto, unitPrice: 0, priceOverridden: true };
      const num = Number(ov.unitPrice);
      if (ov.unitPrice.trim() === "" || !Number.isFinite(num) || num < 0) {
        return resto;
      }
      return { ...resto, unitPrice: num, priceOverridden: true };
    });
  }

  // Debounced draft-invoice preview. Rebuilds from the editable fields exactly
  // as the create flow does, then POSTs to the non-persisting preview endpoint.
  // Cancels in-flight requests when inputs change.
  const previewRestKey = useMemo(
    () => JSON.stringify(previewRestorations),
    [previewRestorations],
  );
  const trimmedDoctorName = doctorName.trim().replace(/\s+/g, " ");
  useEffect(() => {
    // Never show suggestions or edited prices from a previous pricing context.
    const isRetry = previewRetryRequestedRef.current;
    previewRetryRequestedRef.current = false;
    preserveManualLinesAfterPreviewRetryRef.current = isRetry;
    setPickerOpenForKey(null);
    if (!isRetry) {
      setEditedLines(null);
      setRetryPreservedLineCount(0);
    }
    setInvoicePreview(null);
    setInvoicePreviewError(false);
    if (!selectedLabId) {
      setInvoicePreviewLoading(false);
      return;
    }
    let cancelled = false;
    setInvoicePreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const body: PreviewDraftInvoiceInput = {
          labOrganizationId: selectedLabId,
          ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
          ...(trimmedDoctorName ? { doctorName: trimmedDoctorName } : {}),
          ...(draftConnectorsReady ? { bridgeConnectors: draftConnectorText } : {}),
          restorations: previewRestorations.map((r) => ({
            ...(r.toothNumber ? { toothNumber: r.toothNumber } : {}),
            restorationType: r.restorationType,
            ...(r.material ? { material: r.material } : {}),
            ...(r.shade ? { shade: r.shade } : {}),
            ...(r.restorationSubtype ? { restorationSubtype: r.restorationSubtype } : {}),
            quantity: 1,
          })),
        };
        const res = await resilientFetch("/api/invoices/preview-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Preview failed (${res.status}).`);
        const json = (await res.json()) as {
          data?: PreviewDraftInvoiceResultData;
        };
        if (!json?.data) throw new Error("Preview response was empty.");
        if (!cancelled) {
          setInvoicePreview(json?.data ?? null);
          setInvoicePreviewError(false);
        }
      } catch {
        if (!cancelled) {
          setInvoicePreview(null);
          setInvoicePreviewError(true);
        }
      } finally {
        if (!cancelled) setInvoicePreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    selectedLabId,
    providerOrgId,
    trimmedDoctorName,
    previewRestKey,
    previewRestorations,
    draftConnectorsReady,
    draftConnectorText,
    invoicePreviewRetryVersion,
  ]);

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

  // ── User override persistence ─────────────────────────────────────────────
  // Saves a field the user explicitly edited so that a re-scan cannot silently
  // overwrite it when extracted.tsx remounts with a new AI result.
  function saveOverride<K extends keyof AiReaderUserOverrides>(key: K, value: AiReaderUserOverrides[K]) {
    setAiReaderSession({ userOverrides: { ...getAiReaderSession().userOverrides, [key]: value,
      ...((key === "assignmentRoles" || key === "assignmentValues") ? { assignmentOverridesManual: true } : {}),
    } });
  }

  // Provider practices for the lab — member-level, browse-on-open (no
  // search-character minimum, includes practices created inline with no
  // cases yet).
  const providersQuery = useListLabProviders(selectedLabId ?? "", {
    query: {
      queryKey: getListLabProvidersQueryKey(selectedLabId ?? ""),
      enabled: !!selectedLabId,
    },
  });
  const providers: LabProvider[] = useMemo(
    () => providersQuery.data?.data?.providers ?? [],
    [providersQuery.data],
  );
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerOrgId) ?? null,
    [providers, providerOrgId],
  );

  // Resolve the practice in the same priority order as desktop:
  // doctor memory, Rx-name alias, then fuzzy practice-name matching. The
  // mobile fetch helper returns the raw HTTP body, so both lookup envelopes are
  // explicitly unwrapped here.
  useEffect(() => {
    if (!selectedLabId || providersQuery.isLoading) return;
    const rxPracticeName = extracted?.practiceName?.trim() ?? "";
    const resolutionKey = [
      selectedLabId,
      normalizeDoctorMemoryKey(trimmedDoctorName),
      rxPracticeName.toLowerCase(),
    ].join("::");
    if (practiceResolutionKeyRef.current === resolutionKey) return;
    practiceResolutionKeyRef.current = resolutionKey;

    const requestId = ++practiceResolutionRequestRef.current;
    let cancelled = false;
    setPracticeResolutionPending(true);
    void (async () => {
      setDoctorMemoryOrgId(null);
      setDoctorMemoryKey("");
      setDoctorMemoryError(null);
      setDoctorIdentify(null);
      setConfirmedDoctorName(null);

      let resolvedOrgId: string | null = null;
      let rememberedOrgId: string | null = null;

      if (trimmedDoctorName) {
        try {
          const response = await practiceMemoryFetch(
            `/api/rx-doctor-practice-memory?labOrganizationId=${encodeURIComponent(selectedLabId)}&doctorName=${encodeURIComponent(trimmedDoctorName)}`,
          );
          if (response.ok) {
            const body = (await response.json()) as {
              data?: PracticeLookupPayload;
            };
            rememberedOrgId = lookedUpOrgId(body);
            resolvedOrgId = rememberedOrgId;
          }
        } catch {
          // Memory lookup is non-blocking; continue to alias/fuzzy resolution.
        }
      }

      if (!resolvedOrgId && rxPracticeName) {
        try {
          const response = await practiceMemoryFetch(
            `/api/rx-practice-aliases?labOrganizationId=${encodeURIComponent(selectedLabId)}&rxName=${encodeURIComponent(rxPracticeName)}`,
          );
          if (response.ok) {
            const body = (await response.json()) as {
              data?: PracticeLookupPayload;
            };
            resolvedOrgId = lookedUpOrgId(body);
          }
        } catch {
          // Alias lookup is non-blocking; continue to fuzzy resolution.
        }
      }

      if (!resolvedOrgId && rxPracticeName) {
        const needle = rxPracticeName.toLowerCase();
        resolvedOrgId =
          providers.find((provider) =>
            (provider.displayName || provider.name || "")
              .toLowerCase()
              .includes(needle),
          )?.id ?? null;
      }

      if (cancelled || requestId !== practiceResolutionRequestRef.current) return;
      setProviderOrgId(resolvedOrgId);
      setPickedPracticeName(null);
      if (rememberedOrgId && trimmedDoctorName) {
        setDoctorMemoryOrgId(rememberedOrgId);
        setDoctorMemoryKey(normalizeDoctorMemoryKey(trimmedDoctorName));
      }

      // Lab-wide doctor identification deliberately has no practice filter: it
      // must run before asking the user to choose a practice.
      if (trimmedDoctorName) {
        try {
          const params = new URLSearchParams({
            labOrganizationId: selectedLabId,
            doctorName: trimmedDoctorName,
          });
          const response = await practiceMemoryFetch(
            `/api/doctors/resolve-name?${params.toString()}`,
          );
          if (response.ok) {
            const body = (await response.json()) as {
              data?: {
                exactMatch?: string | null;
                similarMatches?: DoctorMatchCandidate[];
              };
            };
            const candidates = body?.data?.similarMatches ?? [];
            if (
              !body?.data?.exactMatch &&
              candidates.length > 0 &&
              !cancelled &&
              requestId === practiceResolutionRequestRef.current
            ) {
              setDoctorIdentify({ typedName: trimmedDoctorName, candidates });
            }
          }
        } catch {
          // The practice-specific create gate remains the authoritative backstop.
        }
      }
    })()
      .catch(() => {
        // Resolution is best-effort; the manual picker remains the fallback.
      })
      .finally(() => {
        if (!cancelled && requestId === practiceResolutionRequestRef.current) {
          setPracticeResolutionPending(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    extracted?.practiceName,
    providers,
    providersQuery.isLoading,
    selectedLabId,
    trimmedDoctorName,
  ]);

  async function rememberDoctorPractice(
    doctorNames: string[],
    practiceId: string,
    labId: string,
  ): Promise<void> {
    const uniqueNames = new Map<string, string>();
    for (const rawName of doctorNames) {
      const name = rawName.trim();
      const key = normalizeDoctorMemoryKey(name);
      if (name && key && !uniqueNames.has(key)) uniqueNames.set(key, name);
    }
    for (const name of uniqueNames.values()) {
      // Writes remain strictly serialized and intentionally are not timed out:
      // allowing the queue to advance while an older POST may still reach the
      // server can let that stale write overwrite the user's newest choice.
      // Callers never await this queue on navigation-critical paths.
      const response = await resilientFetch("/api/rx-doctor-practice-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labOrganizationId: labId,
          doctorName: name,
          providerOrganizationId: practiceId,
        }),
      });
      if (!response.ok) throw new Error(`doctor memory ${response.status}`);
    }
  }

  function queueDoctorPracticeMemory(
    doctorNames: string[],
    practiceId: string,
    labId: string,
  ): { promise: Promise<void>; version: number } {
    const version = ++doctorMemoryWriteVersionRef.current;
    const write = doctorMemoryWriteQueueRef.current.then(() =>
      rememberDoctorPractice(doctorNames, practiceId, labId),
    );
    doctorMemoryWriteQueueRef.current = write.catch(() => undefined);
    return { promise: write, version };
  }

  async function rememberPracticeForCurrentDoctor(
    practiceId: string,
    doctorNameOverride?: string,
  ): Promise<void> {
    const name = (doctorNameOverride ?? doctorName).trim();
    const key = normalizeDoctorMemoryKey(name);
    if (!selectedLabId || !practiceId || !key) return;
    const mutation = queueDoctorPracticeMemory(
      [name],
      practiceId,
      selectedLabId,
    );
    try {
      await mutation.promise;
      // A slower earlier selection must not put stale state back into the UI
      // after a newer selection has already been queued.
      if (mutation.version === doctorMemoryWriteVersionRef.current) {
        setDoctorMemoryOrgId(practiceId);
        setDoctorMemoryKey(key);
        setDoctorMemoryError(null);
      }
    } catch {
      if (mutation.version === doctorMemoryWriteVersionRef.current) {
        setDoctorMemoryError(
          "Couldn't remember this practice for this doctor — you may be asked again next time. Choose the practice again to retry.",
        );
      }
    }
  }
  // `trimmedDoctorName` (declared above, trim + collapse internal whitespace) is
  // the strict-normalized scanned doctor name. Keyed on the lowercased form so
  // re-querying only happens on a meaningful change, not on casing/whitespace
  // edits the server also ignores.
  //
  // Resolve the scanned doctor name against the selected lab+practice directory.
  // `exactMatch` (strict, no title stripping) is the ONLY thing that makes the
  // case safe to create without an explicit confirmation; otherwise the user
  // must resolve the doctor before submitting (see handleSubmit). Replaces the
  // old dismissible "isn't on file" banner.
  const doctorResolveQuery = useQuery({
    queryKey: [
      "doctor-resolve",
      selectedLabId,
      providerOrgId,
      trimmedDoctorName.toLowerCase(),
    ],
    queryFn: async () => {
      const url =
        `/api/doctors/resolve-name?labOrganizationId=${encodeURIComponent(selectedLabId ?? "")}` +
        `&providerOrganizationId=${encodeURIComponent(providerOrgId ?? "")}` +
        `&doctorName=${encodeURIComponent(trimmedDoctorName)}`;
      const res = await resilientFetch(url);
      if (!res.ok) throw new Error(`resolve-name ${res.status}`);
      const body = (await res.json()) as {
        data?: {
          exactMatch?: string | null;
          similarMatches?: DoctorMatchCandidate[];
          canAddNew?: boolean;
        };
      };
      return {
        exactMatch: body?.data?.exactMatch ?? null,
        similarMatches: body?.data?.similarMatches ?? [],
        canAddNew: body?.data?.canAddNew ?? true,
      };
    },
    enabled: !!selectedLabId && !!providerOrgId && !!trimmedDoctorName,
    staleTime: 60 * 1000,
  });


  const filteredProviders = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase();
    if (!q) return providers;
    const compactQuery = q.replace(/ /g, "");
    return providers.filter((p) => {
      const platformAccountNumber = p.platformAccountNumber?.toLowerCase() ?? "";
      const hay = [
        p.displayName,
        p.name,
        p.city,
        p.state,
        p.accountNumber,
        platformAccountNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      // Account-number searches are intentionally partial: users can paste
      // either the raw digits or the grouped 4-4-4 display form without
      // triggering complete-number/checksum validation.
      return (
        hay.includes(q) ||
        platformAccountNumber.replace(/ /g, "").includes(compactQuery)
      );
    });
  }, [providers, pickerFilter]);

  function openPicker() {
    setPickerFilter("");
    setCreatePracticeVisible(false);
    setPickerVisible(true);
  }

  function selectProvider(p: LabProvider) {
    practiceResolutionRequestRef.current += 1;
    setProviderOrgId(p.id);
    setPickedPracticeName(p.displayName || p.name);
    void rememberPracticeForCurrentDoctor(p.id);
    setPickerVisible(false);
    setCreatePracticeVisible(false);
    Keyboard.dismiss();
  }

  function clearProvider() {
    practiceResolutionRequestRef.current += 1;
    setProviderOrgId(null);
    setPickedPracticeName(null);
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
        // Surface the server's human-readable rejection instead of a raw status
        // dump. The API error envelope is { ok:false, message, details }; the
        // 409 duplicate also carries details.conflictingOrg so we can name the
        // existing practice the user should pick instead.
        let msg = `Could not create practice (server responded ${res.status}).`;
        try {
          const body = (await res.json()) as {
            message?: string;
            details?: { conflictingOrg?: { name?: string; displayName?: string } };
          };
          const conflict = body?.details?.conflictingOrg;
          if (res.status === 409 && conflict) {
            const label = conflict.displayName || conflict.name || "an existing practice";
            msg = `A practice named "${label}" already exists in this lab. Pick it from the list instead of creating a new one.`;
          } else if (body?.message) {
            msg = body.message;
          }
        } catch {
          // Non-JSON body — keep the default status message.
        }
        Alert.alert("Could not create practice", msg);
        return;
      }
      const body = (await res.json()) as { data?: { id?: string; name?: string } };
      const orgId = body?.data?.id;
      if (!orgId) {
        Alert.alert("Could not create practice", "Practice was created but no ID was returned. Try again.");
        return;
      }
      setProviderOrgId(orgId);
      setPickedPracticeName(newPracticeName.trim());
      // Seed the per-Rx doctor name from the create form only when the
      // field is still empty, so we never clobber an extracted/edited name.
      if (newDoctorName.trim() && !doctorName.trim()) {
        setDoctorName(newDoctorName.trim());
      }
      void rememberPracticeForCurrentDoctor(
        orgId,
        newDoctorName.trim() || doctorName,
      );
      setCreatePracticeVisible(false);
      setPickerVisible(false);
      setPickerFilter("");
      // Refresh the practice list so the new practice shows up next open.
      qc.invalidateQueries({ queryKey: getListLabProvidersQueryKey(selectedLabId) });
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

  // ── Patient similarity ──
  async function checkDuplicates(): Promise<{
    hits: SimilarityHit[];
    truncated?: boolean;
    totalFound?: number;
  }> {
    if (!selectedLabId || !patientFirst.trim() || !patientLast.trim()) return { hits: [] };
    try {
      const params = new URLSearchParams({
        patientFirstName: patientFirst.trim(),
        patientLastName: patientLast.trim(),
        labOrganizationId: selectedLabId,
        ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
        ...(doctorName.trim() ? { doctorName: doctorName.trim() } : {}),
      });
      const res = await resilientFetch(`/api/cases/patient-similarity?${params}`);
      if (!res.ok) return { hits: [] };
      const body = (await res.json()) as {
        data?: { matches?: SimilarityHit[]; truncated?: boolean; totalFound?: number };
      };
      return {
        hits: body?.data?.matches ?? [],
        truncated: body?.data?.truncated,
        totalFound: body?.data?.totalFound,
      };
    } catch {
      return { hits: [] };
    }
  }

  // Early, best-effort warning while reviewing the extracted patient and
  // organization details. The submit-time check above remains independent and
  // authoritative for the duplicate/remake decision.
  const earlyDuplicateInputKey = JSON.stringify([
    patientFirst.trim(),
    patientLast.trim(),
    selectedLabId,
    providerOrgId,
    doctorName.trim(),
  ]);
  earlyDuplicateInputKeyRef.current = earlyDuplicateInputKey;

  useEffect(() => {
    const sequence = ++earlyDuplicateSequenceRef.current;
    const firstName = patientFirst.trim();
    const lastName = patientLast.trim();
    const labId = selectedLabId;
    const practiceId = providerOrgId;
    const currentDoctorName = doctorName.trim();
    const inputKey = JSON.stringify([
      firstName,
      lastName,
      labId,
      practiceId,
      currentDoctorName,
    ]);

    setEarlyDuplicate(null);
    if (!firstName || !lastName || !labId || !practiceId) return;

    const timer = setTimeout(async () => {
      const params = new URLSearchParams({
        patientFirstName: firstName,
        patientLastName: lastName,
        labOrganizationId: labId,
        providerOrganizationId: practiceId,
        ...(currentDoctorName ? { doctorName: currentDoctorName } : {}),
      });
      try {
        const response = await resilientFetch(
          `/api/cases/patient-similarity?${params}`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as {
          data?: { matches?: SimilarityHit[] };
        };
        if (
          sequence !== earlyDuplicateSequenceRef.current ||
          inputKey !== earlyDuplicateInputKeyRef.current
        ) {
          return;
        }
        const matches = Array.isArray(body?.data?.matches)
          ? body.data.matches
          : [];
        const hit = newestSimilarityHit(matches);
        setEarlyDuplicate(hit ? { inputKey, hit } : null);
      } catch {
        // The review-time lookup is informational only; network errors must
        // never prevent the user from proceeding to the final submit check.
        if (
          sequence === earlyDuplicateSequenceRef.current &&
          inputKey === earlyDuplicateInputKeyRef.current
        ) {
          setEarlyDuplicate(null);
        }
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      if (sequence === earlyDuplicateSequenceRef.current) {
        earlyDuplicateSequenceRef.current++;
      }
    };
  }, [patientFirst, patientLast, selectedLabId, providerOrgId, doctorName]);

  // ── Save alias after provider confirmed ──
  // Returns true on success, false on failure.
  async function saveAlias(labId: string, orgId: string, rxName: string): Promise<boolean> {
    if (!rxName.trim()) return true;
    try {
      const res = await resilientFetch("/api/rx-practice-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labOrganizationId: labId, rxName, providerOrganizationId: orgId }),
      });
      if (!res.ok) {
        Alert.alert("Couldn't save mapping", "The practice mapping couldn't be saved. Try again on the next Rx.");
        return false;
      }
      return true;
    } catch {
      Alert.alert("Couldn't save mapping", "The practice mapping couldn't be saved. Try again on the next Rx.");
      return false;
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
${pages.map((p) => `<div class="page"><img src="data:image/jpeg;base64,${p.base64}" /></div>`).join("\n")}
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
  async function handleSubmit(opts?: {
    skipDupeCheck?: boolean;
    confirmNewDoctor?: boolean;
    confirmedEmptyInvoice?: boolean;
    doctorNameOverride?: string;
    providerOrgIdOverride?: string;
    remakeAnswers?: MobileRemakeAnswers;
  }) {
    const skipDupeCheck = opts?.skipDupeCheck ?? false;
    const confirmNewDoctor = opts?.confirmNewDoctor ?? false;
    let effectiveDoctorName = (opts?.doctorNameOverride ?? doctorName).trim();
    const effectiveProviderOrgId = opts?.providerOrgIdOverride ?? providerOrgId;
    const applicableArch = isArchRequired(
      normalizeCaseHierarchy({ caseType, material }).hierarchy.caseType,
    );
    if (applicableArch && !arch) {
      Alert.alert("Arch required", "Select Upper, Lower, or Upper + Lower before creating this case.");
      return;
    }
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

    // A practice (provider organization) is mandatory — every case must be
    // linked to one (DB-enforced). Prompt the user to pick or add a practice
    // instead of letting the create fail server-side.
    if (!effectiveProviderOrgId) {
      Alert.alert(
        "Practice required",
        "Link this case to a practice before creating it. Select an existing practice or add a new one.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Select practice", onPress: openPicker },
        ],
      );
      return;
    }

    // The server requires a non-empty doctor name (doctorName.min(1)). Guard here
    // so an empty field surfaces a clear prompt instead of a server-side 400.
    if (!effectiveDoctorName) {
      Alert.alert(
        "Doctor name required",
        "Enter the doctor's name on this Rx before creating the case.",
      );
      return;
    }

    // Duplicate check (first pass only)
    if (!skipDupeCheck) {
      setSubmitting(true);
      setUploadProgress(0);
      try {
        const { hits, truncated, totalFound } = await checkDuplicates();
        if (hits.length > 0) {
          setSimilarHits(hits);
          setDuplicateTruncated(truncated ?? false);
          setDuplicateTotalFound(totalFound ?? hits.length);
          setDuplicateModalVisible(true);
          setSubmitting(false);
          return;
        }
      } catch {}
    }

    // Required doctor-resolution gate. Unless this submit was already resolved
    // (confirmNewDoctor set by the resolution step / the 409 flow), the scanned
    // name must STRICTLY match an existing doctor in this lab+practice. On an
    // exact match we adopt the stored spelling; otherwise we open the required
    // "doctor not on file" step and block creation until it is resolved. The
    // POST /cases 409 gate remains the authoritative backstop.
    const alreadyIdentified =
      !!confirmedDoctorName &&
      confirmedDoctorName.trim().replace(/\s+/g, " ").toLowerCase() ===
        effectiveDoctorName.replace(/\s+/g, " ").toLowerCase();
    if (!confirmNewDoctor && !alreadyIdentified) {
      const resolution = doctorResolveQuery.data;
      if (doctorResolveQuery.isSuccess && resolution) {
        if (resolution.exactMatch) {
          effectiveDoctorName = resolution.exactMatch;
        } else {
          setDoctorResolve({
            typedName: effectiveDoctorName,
            candidates: resolution.similarMatches ?? [],
          });
          setSubmitting(false);
          return;
        }
      }
    }

    if (isAdminForSelectedLab && invoicePreviewError &&
        !editedLines?.some((line) => line.description.trim().length > 0) &&
        !opts?.confirmedEmptyInvoice) {
      setSubmitting(false);
      Alert.alert(
        "Create without reviewed invoice lines?",
        "The invoice preview failed and no reviewed lines will be included. Creating now will make an invoice with no charges. Go back to add lines, or create anyway.",
        [
          { text: "Go back", style: "cancel" },
          { text: "Create anyway", onPress: () => void handleSubmit({ ...opts, skipDupeCheck: true, confirmedEmptyInvoice: true }) },
        ],
        { cancelable: true },
      );
      return;
    }

    setSubmitting(true);
    setUploadProgress(0.05);

    // Reuse the same restorations array driving the invoice preview and apply
    // any inline price edits / no-charge toggles before submitting.
    const cleanRests: CreateCaseInputRestorationsItem[] =
      applyPriceOverrides(previewRestorations);

    const labName = labs.find((m) => m.organizationId === selectedLabId)?.organization?.name ?? null;

    if (alreadyIdentified) {
      effectiveDoctorName = confirmedDoctorName;
    }

    setAssignmentUndo(null);
    const payload: CreateCaseInput = {
      caseNumber: caseNumber.trim(),
      labOrganizationId: selectedLabId,
      providerOrganizationId: effectiveProviderOrgId,
      patientFirstName: patientFirst.trim(),
      patientLastName: patientLast.trim(),
      doctorName: effectiveDoctorName,
      priority,
      ...(receivedAt ? { receivedAt } : {}),
      ...(reviewedLabDueDate ? { dueDate: reviewedLabDueDate } : {}),
      ...(eligibleRxDueDate ? { prescriptionDueDate: eligibleRxDueDate } : {}),
      aiIntakeReviewedDates: true,
      ...(notes.trim() ? { rxNotes: notes } : {}),
      ...(shade?.trim() ? { shade: shade.trim() } : {}),
      ...(gingivialShade?.trim() ? { gingivialShade: gingivialShade.trim() } : {}),
      ...(step ? { step } : {}),
       ...(cleanRests.length ? { restorations: cleanRests.map((row) => {
         const ai = aiAssignmentProposal.find((unit) => unit.toothNumber === row.toothNumber &&
           unit.restorationType === row.restorationType && unit.material === row.material && unit.shade === row.shade);
         return { ...row, assignmentProvenance: ai?.assignmentProvenance
            ? { ...ai.assignmentProvenance, manualFields: userOverrides.assignmentOverridesManual ? ["role", "product", "shade"] : ai.assignmentProvenance.manualFields }
           : { origin: "manual", manualFields: ["role", "product", "shade"] } };
       }) } : {}),
      ...(draftConnectorsReady ? { bridgeConnectors: draftConnectorText } : {}),
      ...(opts?.remakeAnswers ? {
        remakeOfCaseId: opts.remakeAnswers.remakeOfCaseId,
        remakeReason: opts.remakeAnswers.remakeReason,
        remakeCharged: opts.remakeAnswers.remakeCharged,
        remakeReasonKey: opts.remakeAnswers.remakeReasonKey,
        ...(opts.remakeAnswers.remakeShadeLightness ? { remakeShadeLightness: opts.remakeAnswers.remakeShadeLightness } : {}),
        ...(opts.remakeAnswers.remakeShadePrescribed ? { remakeShadePrescribed: opts.remakeAnswers.remakeShadePrescribed } : {}),
        ...(opts.remakeAnswers.remakeShadeProvided ? { remakeShadeProvided: opts.remakeAnswers.remakeShadeProvided } : {}),
        ...(opts.remakeAnswers.remakeMaterialPrescribed ? { remakeMaterialPrescribed: opts.remakeAnswers.remakeMaterialPrescribed } : {}),
        ...(opts.remakeAnswers.remakeMaterialProvided ? { remakeMaterialProvided: opts.remakeAnswers.remakeMaterialProvided } : {}),
        ...(opts.remakeAnswers.remakeReturnedToLab !== undefined ? { remakeReturnedToLab: opts.remakeAnswers.remakeReturnedToLab } : {}),
        ...(opts.remakeAnswers.remakeCategory ? { remakeCategory: opts.remakeAnswers.remakeCategory } : {}),
      } : remakeOfCaseId ? { remakeOfCaseId } : {}),
      ...(confirmNewDoctor || alreadyIdentified ? { confirmNewDoctor: true } : {}),
      ...(isAdminForSelectedLab && editedLines !== null
        ? {
            invoiceOverrideLines: editedLines
              .filter((l) => l.description.trim().length > 0)
              .map((l) => ({
                description: l.description.trim(),
                quantity: Math.max(1, Math.round(Number(l.qty)) || 1),
                unitPrice: Math.max(0, Number(l.unitPrice) || 0),
                ...(l.catalogItemKey ? { catalogItemKey: l.catalogItemKey } : {}),
              })),
          }
        : {}),
    };

    try {
      setUploadProgress(0.1);
      const result = await createCase.mutateAsync({ data: payload });
      const newId = result?.data?.id;

      // Case created — close the doctor-confirmation sheet if it was open.
      setDoctorConfirm(null);

      if (!newId) {
        Alert.alert("Case created", "The case was created but could not be opened. Check your cases list.");
        router.replace("/(tabs)/dashboard" as never);
        return;
      }

      // Accepting any auto-filled or manually selected practice confirms the
      // doctor mapping. Best-effort so a memory outage never loses the case.
      void rememberPracticeForCurrentDoctor(
        effectiveProviderOrgId,
        effectiveDoctorName,
      );

      // Save alias for future practice auto-resolve
      if (extracted?.practiceName && effectiveProviderOrgId) {
        await saveAlias(selectedLabId, effectiveProviderOrgId, extracted.practiceName);
      }

      // Save submission data into the session for label printing
      setAiReaderSession({
        caseId: newId,
        caseNumber: caseNumber.trim(),
        restorations: cleanRests.map((row) => ({
          toothNumber: row.toothNumber,
          restorationType: row.restorationType,
          ...(row.material ? { material: row.material } : {}),
          ...(row.shade ? { shade: row.shade } : {}),
        })),
        labOrgId: selectedLabId,
        labName,
        doctorName: effectiveDoctorName || null,
        patientName: `${patientFirst.trim()} ${patientLast.trim()}`.trim() || null,
        dueDate: reviewedLabDueDate || null,
        gingivialShade: gingivialShade.trim() || null,
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

      // Case creation also creates the linked invoice. Refresh every mounted
      // surface that can show either record, including prefix-keyed report and
      // generated stats queries. Broad prefixes are intentional here: the
      // newly-created case can affect today's totals, worklists, and a
      // doctor's scoped finance view at the same time.
      await refreshCaseFinanceQueries(qc);
      setUploadProgress(1);

      // Navigate to barcode screen
      router.push("/ai-reader/barcode" as never);
    } catch (e) {
      // The typed doctor name closely matches an existing doctor in this
      // practice — surface the confirmation sheet instead of a dead-end alert so
      // the user can pick the existing doctor or confirm the new one.
      const err = e as { status?: number; data?: { details?: unknown } };
      const details = err?.data?.details as
        | { code?: string; candidates?: DoctorMatchCandidate[] }
        | undefined;
      if (err?.status === 409 && details?.code === "DOCTOR_CONFIRMATION_REQUIRED") {
        setDoctorConfirm({
          candidates: Array.isArray(details.candidates) ? details.candidates : [],
          typedName: effectiveDoctorName,
        });
        return;
      }
      Alert.alert("Couldn't create case", errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleUseExistingDoctor(candidate: DoctorMatchCandidate) {
    // Adopt the existing doctor's exact spelling (and their practice, if the
    // candidate carries one) and re-submit with confirmation. Pass overrides
    // directly so we don't race the async state updates.
    setDoctorConfirm(null);
    setDoctorResolve(null);
    setDoctorName(candidate.doctorName);
    if (candidate.providerOrganizationId) {
      setProviderOrgId(candidate.providerOrganizationId);
    }
    void handleSubmit({
      skipDupeCheck: true,
      confirmNewDoctor: true,
      doctorNameOverride: candidate.doctorName,
      ...(candidate.providerOrganizationId
        ? { providerOrgIdOverride: candidate.providerOrganizationId }
        : {}),
    });
  }

  async function handleIdentifyDoctor(candidate: DoctorMatchCandidate) {
    const typedName = doctorIdentify?.typedName ?? "";
    const practiceId = candidate.providerOrganizationId;
    if (!selectedLabId || !practiceId) return;
    setSavingDoctorMemory(true);
    setDoctorMemoryError(null);
    const mutation = queueDoctorPracticeMemory(
      [candidate.doctorName, typedName],
      practiceId,
      selectedLabId,
    );
    try {
      await waitForPracticeMemoryMutation(mutation.promise);
      if (mutation.version !== doctorMemoryWriteVersionRef.current) return;
      setDoctorName(candidate.doctorName);
      saveOverride("doctorName", candidate.doctorName);
      setProviderOrgId(practiceId);
      setPickedPracticeName(candidate.practiceName ?? null);
      setDoctorMemoryOrgId(practiceId);
      setDoctorMemoryKey(normalizeDoctorMemoryKey(candidate.doctorName));
      setConfirmedDoctorName(candidate.doctorName);
      setDoctorIdentify(null);
    } catch {
      setDoctorMemoryError(
        "Couldn't remember this doctor's practice — try again.",
      );
    } finally {
      setSavingDoctorMemory(false);
    }
  }

  function handleKeepNewDoctor() {
    setDoctorConfirm(null);
    setDoctorResolve(null);
    void handleSubmit({ skipDupeCheck: true, confirmNewDoctor: true });
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/dashboard" as never);
  }

  // ── Duplicate modal decisions ──
  function onDuplicateDecision(decision: DuplicateDecision, hit?: SimilarityHit) {
    setDuplicateModalVisible(false);
    if (decision === "is_duplicate") {
      Alert.alert(
        "Case cancelled",
        "The intake was cancelled because a matching case already exists. Open the existing case from your cases list.",
        [{ text: "OK", onPress: () => router.replace("/(tabs)" as never) }],
      );
      return;
    }
    if (decision === "remake" && hit) {
      // Show the structured questionnaire before submitting so we can
      // collect the reason key, conditional shade/material fields, and charge.
      setRemakeOfCaseId(hit.id);
      setRemakePendingHit(hit);
      setRemakeReasonKey("");
      setRemakeShadeLightness(null);
      setRemakeShadePrescribed("");
      setRemakeShadeProvided("");
      setRemakeMaterialPrescribed("");
      setRemakeMaterialProvided("");
      setRemakeReturnedToLab(null);
      setRemakeCharged(null);
      setRemakeQuestionnaireVisible(true);
    } else {
      setRemakeOfCaseId(null);
      void handleSubmit({ skipDupeCheck: true });
    }
  }

  function handleRemakeQuestionnaireSubmit() {
    if (!remakePendingHit) return;
    if (!remakeReasonKey) {
      Alert.alert("Required", "Please select a remake reason.");
      return;
    }
    if (remakeCharged === null) {
      Alert.alert("Required", "Please choose whether to charge for this remake.");
      return;
    }
    const remakeReason =
      MOBILE_REMAKE_REASONS.find((r) => r.key === remakeReasonKey)?.label ?? remakeReasonKey;
    const remakeCategory =
      MOBILE_REMAKE_REASONS.find((r) => r.key === remakeReasonKey)?.category;
    setRemakeQuestionnaireVisible(false);
    void handleSubmit({
      skipDupeCheck: true,
      remakeAnswers: {
        remakeOfCaseId: remakePendingHit.id,
        remakeReasonKey,
        remakeReason,
        remakeCharged,
        ...(remakeShadeLightness ? { remakeShadeLightness } : {}),
        ...(remakeShadePrescribed.trim() ? { remakeShadePrescribed: remakeShadePrescribed.trim() } : {}),
        ...(remakeShadeProvided.trim() ? { remakeShadeProvided: remakeShadeProvided.trim() } : {}),
        ...(remakeMaterialPrescribed.trim() ? { remakeMaterialPrescribed: remakeMaterialPrescribed.trim() } : {}),
        ...(remakeMaterialProvided.trim() ? { remakeMaterialProvided: remakeMaterialProvided.trim() } : {}),
        ...(remakeReturnedToLab !== null ? { remakeReturnedToLab } : {}),
        ...(remakeCategory ? { remakeCategory } : {}),
      },
    });
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
  const doctorMemoryApplies =
    !!doctorMemoryOrgId &&
    !!doctorMemoryKey &&
    normalizeDoctorMemoryKey(doctorName) === doctorMemoryKey;

  // Inform the user (non-dismissibly) when the scanned doctor has no STRICT
  // match in this practice. The actual gate is enforced in handleSubmit; this is
  // purely a heads-up. Only shown once the resolve query has a definitive
  // no-exact-match answer for a selected practice + non-empty name.
  const doctorNotOnFile =
    !!providerOrgId &&
    !!trimmedDoctorName &&
    doctorResolveQuery.isSuccess &&
    !doctorResolveQuery.data?.exactMatch;

  const practiceLabel =
    selectedProvider?.displayName ||
    selectedProvider?.name ||
    pickedPracticeName ||
    "Linked practice";
  const currentEarlyDuplicate =
    earlyDuplicate?.inputKey === earlyDuplicateInputKey
      ? earlyDuplicate.hit
      : null;
  const currentEarlyDuplicateDate = formatSimilarityDate(
    currentEarlyDuplicate?.createdAt,
  );

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Header */}
      <DismissKeyboardView style={styles.header} testID="extracted-keyboard-dismiss">
        <Pressable onPress={goBack} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.headerTitle}>
          <Text style={styles.title}>Review Extraction</Text>
          <Text style={styles.subtitle}>Verify all fields before creating the case</Text>
        </View>
        <View style={{ width: 40 }} />
      </DismissKeyboardView>

      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        automaticallyAdjustKeyboardInsets
        testID="extracted-body"
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
                    onPress={() => {
                      if (m.organizationId === selectedLabId) return;
                      setProviderOrgId(null);
                      setPickedPracticeName(null);
                      setSelectedLabId(m.organizationId);
                    }}
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
              onChangeText={(v) => { setPatientFirst(v); saveOverride("patientFirst", v); }}
              placeholder="First"
              placeholderTextColor={colors.textTertiary}
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, styles.halfInput]}
              value={patientLast}
              onChangeText={(v) => { setPatientLast(v); saveOverride("patientLast", v); }}
              placeholder="Last"
              placeholderTextColor={colors.textTertiary}
              autoCorrect={false}
            />
          </View>
        </Section>

        {currentEarlyDuplicate ? (
          <View
            style={[styles.warnBanner, { marginTop: -Spacing.md }]}
            accessibilityRole="alert"
            testID="early-duplicate-warning"
          >
            <Ionicons
              name="warning-outline"
              size={16}
              color={colors.warningStrong}
            />
            <Text style={styles.warnText} accessibilityLiveRegion="polite">
              {currentEarlyDuplicateDate
                ? `Possible duplicate case from ${currentEarlyDuplicateDate}.`
                : "Possible duplicate case found."}
            </Text>
          </View>
        ) : null}

        {/* Doctor / practice */}
        <Section label="Doctor / Practice" styles={styles} colors={colors}>
          {doctorIdentify ? (
            <View style={styles.identifyPendingRow} testID="doctor-identify-pending">
              <Ionicons name="person-circle-outline" size={18} color={colors.tint} />
              <Text style={styles.identifyPendingText}>
                Confirm which doctor this is before choosing a practice.
              </Text>
            </View>
          ) : practiceResolutionPending ? (
            <View style={styles.identifyPendingRow} testID="practice-resolution-pending">
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={styles.identifyPendingText}>
                Resolving the doctor and practice…
              </Text>
            </View>
          ) : providerResolved ? (
            <View style={styles.resolvedRow}>
              <Ionicons name="business" size={18} color={colors.success} />
              <Text style={styles.resolvedName} numberOfLines={1}>{practiceLabel}</Text>
              <Pressable onPress={openPicker} hitSlop={8} accessibilityLabel="Change practice">
                <Ionicons name="swap-horizontal" size={18} color={colors.tint} />
              </Pressable>
              <Pressable onPress={clearProvider} hitSlop={8} accessibilityLabel="Clear practice">
                <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
              </Pressable>
            </View>
          ) : (
            <Pressable style={styles.pickerTrigger} onPress={openPicker} accessibilityRole="button">
              <Ionicons name="business-outline" size={18} color={colors.textTertiary} />
              <Text style={styles.pickerTriggerText}>Select a practice…</Text>
              <Ionicons name="chevron-down" size={18} color={colors.textTertiary} />
            </Pressable>
          )}
          {doctorMemoryApplies && providerOrgId === doctorMemoryOrgId ? (
            <Text style={styles.memoryHint} testID="practice-remembered-badge">
              Auto-filled from what you confirmed for this doctor before. Change
              it and the new practice will be remembered instead.
            </Text>
          ) : null}
          {doctorMemoryError && !doctorIdentify ? (
            <Text style={styles.memoryError} testID="doctor-memory-error">
              {doctorMemoryError}
            </Text>
          ) : null}

          {/* Editable per-Rx doctor name (independent of the linked practice) */}
          <Text style={[styles.sectionLabel, styles.subLabel]}>Doctor name on this Rx</Text>
          <TextInput
            style={styles.input}
            value={doctorName}
            onChangeText={(v) => { setDoctorName(v); saveOverride("doctorName", v); }}
            placeholder="e.g. Dr. Jane Smith"
            placeholderTextColor={colors.textTertiary}
            autoCorrect={false}
          />

          {/* Doctor-not-on-file notice. Non-dismissible: the required
              resolution step is enforced in handleSubmit, so this only informs
              the user that they'll confirm the doctor before the case is made. */}
          {doctorNotOnFile && (
            <View style={[styles.warnBanner, { marginTop: Spacing.sm }]}>
              <Ionicons name="person-add-outline" size={16} color={colors.warningStrong} />
              <Text style={styles.warnText}>
                "{trimmedDoctorName}" isn't on file for this practice — you'll
                confirm the doctor before creating the case.
              </Text>
            </View>
          )}
        </Section>

        {/* Reviewed dates */}
        <Section label="Intake dates" styles={styles} colors={colors}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textSecondary }}>
            Received date
          </Text>
          <DateField
            value={receivedAt}
            allowTyping
            title="Received date"
            testID="ai-reader-received-date"
            onChange={(value) => {
              setReceivedAt(value);
              saveOverride("receivedAt", value);
            }}
            placeholder="YYYY-MM-DD"
          />
          <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginTop: Spacing.sm }}>
            Lab due date
          </Text>
          <DateField
            value={reviewedLabDueDate}
            allowTyping
            title="Lab due date"
            testID="ai-reader-lab-due-date"
            onChange={(value) => {
              setLabDueDate(value);
              setLabDueDateEdited(true);
              saveOverride("labDueDate", value);
              saveOverride("labDueDateEdited", true);
            }}
            placeholder="YYYY-MM-DD"
          />
          {turnaroundDays == null ? (
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
              No lab turnaround is configured. Enter the Lab due date manually.
            </Text>
          ) : null}
          {showRxDueDateField ? (
            <>
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginTop: Spacing.sm }}>
                Rx due date
              </Text>
              <DateField
                value={eligibleRxDueDate || rxDueDate}
                allowTyping
                title="Rx due date"
                testID="ai-reader-rx-due-date"
                onChange={(value) => {
                  setRxDueDate(value);
                  saveOverride("rxDueDate", value);
                }}
                placeholder="YYYY-MM-DD"
              />
            </>
          ) : null}
          {turnaroundDays != null && eligibleRxDueDate ? (
            <View style={[styles.warnBanner, { marginTop: Spacing.sm }]}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.warningStrong} />
              <Text style={styles.warnText}>
                The requested Rx date is within the lab’s {turnaroundDays}-day turnaround.
                The Lab due date remains the lab schedule.
              </Text>
            </View>
          ) : null}
        </Section>

        <Section label="Priority" styles={styles} colors={colors}>
          <View style={styles.chipRow}>
            {(["normal", "rush"] as const).map((p) => (
              <Pressable
                key={p}
                style={[styles.chip, priority === p && styles.chipSelected]}
                onPress={() => { setPriority(p); saveOverride("priority", p); }}
              >
                <Text style={[styles.chipText, priority === p && styles.chipTextSelected]}>
                  {p === "rush" ? "🔴 Rush" : "Normal"}
                </Text>
              </Pressable>
            ))}
          </View>
        </Section>

        {/* Clinical details */}
        <View>
          <Text style={styles.clinicalFieldLabel}>Case Type</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel="Case Type"
            value={caseType}
            onChangeText={changeCaseType}
            placeholder="Crown & Bridge, Removable…"
            placeholderTextColor={colors.textTertiary}
          />
          {isArchRequired(normalizeCaseHierarchy({ caseType, material }).hierarchy.caseType) ? (
            <View style={{ marginTop: Spacing.sm }}>
              <Text style={styles.sectionLabel}>Arch *</Text>
              <View style={styles.chipRow}>
                {ARCH_OPTIONS.map((option) => (
                  <Pressable
                    key={option.value}
                    testID={`ai-arch-${option.value}`}
                    style={[styles.chip, arch === option.value && styles.chipSelected]}
                    onPress={() => {
                      setArch(option.value);
                      saveOverride("arch", option.value);
                    }}
                  >
                    <Text style={[styles.chipText, arch === option.value && styles.chipTextSelected]}>
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {!arch ? <Text style={styles.warnText}>Select an arch before previewing or creating this case.</Text> : null}
            </View>
          ) : null}
        </View>

        <Section label="Tooth Numbers" styles={styles} colors={colors}>
          <TextInput
            style={styles.input}
            value={toothIndices}
            onChangeText={(v) => { setToothIndices(v); saveOverride("toothIndices", v); }}
            placeholder="e.g. 3, 5, 14"
            placeholderTextColor={colors.textTertiary}
            keyboardType="numbers-and-punctuation"
            onFocus={() => setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 150)}
          />
          {requiresExplicitToothRoles && toothIds.length > 0 ? (
            <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
              {aiAssignmentDiffers && <View accessibilityRole="summary">
                <Text style={styles.warnText}>AI results differ from your current draft. Review before replacing it.</Text>
                <Text style={styles.chipText}>{aiAssignmentProposal.map((unit) => `#${unit.toothNumber} ${unit.restorationType} · ${unit.material} · ${unit.shade}`).join("\n") || "AI did not identify complete, explicit per-tooth assignments."}</Text>
                <Pressable accessibilityRole="button" onPress={() => {
                  captureAssignmentUndo();
                  const roles = Object.fromEntries(aiAssignmentProposal.map((unit) => [unit.toothNumber, unit.restorationType as "Crown" | "Pontic"]));
                  const values = Object.fromEntries(aiAssignmentProposal.map((unit) => [unit.toothNumber, { material: unit.material ?? undefined, shade: unit.shade ?? undefined }]));
                  setAssignmentRoles(roles); setAssignmentValues(values);
                  const nextTeeth = extracted?.toothIndices ?? aiAssignmentProposal.map((unit) => unit.toothNumber).join(", ");
                  setToothIndices(nextTeeth);
                  const overrides = { ...getAiReaderSession().userOverrides };
                  overrides.assignmentRoles = roles; overrides.assignmentValues = values;
                  overrides.toothIndices = nextTeeth; overrides.assignmentOverridesManual = false;
                  setAiReaderSession({ userOverrides: overrides });
                }}><Text style={styles.chipText}>Accept AI replacement values and review</Text></Pressable>
              </View>}
              <Text style={styles.warnText}>
                Optional: review extracted tooth roles and products here. Incomplete chart edits do not prevent case creation.
              </Text>
              <ToothChart
                readOnly={false}
                selected={activeAssignmentTooth ? new Set([activeAssignmentTooth]) : undefined}
                crownTeeth={new Set(toothIds.filter((tooth) => assignmentRoles[tooth] === "Crown"))}
                ponticTeeth={new Set(toothIds.filter((tooth) => assignmentRoles[tooth] === "Pontic"))}
                veneerTeeth={new Set(toothIds.filter((tooth) => assignmentRoles[tooth] === "Veneer"))}
                connectedPairs={draftConnectorState.active}
                connectorSuggestions={draftConnectorState.suggested}
                connectorIssue={!draftConnectorValidation.valid ? draftConnectorValidation.errors.join(" ") : draftAssignmentSummary.unresolvedPontics.length ? `Review pontics ${draftAssignmentSummary.unresolvedPontics.join(", ")}` : null}
                summaryText={`${draftAssignmentSummary.units} units · ${draftAssignmentSummary.crowns} prepared crowns · ${draftAssignmentSummary.pontics} pontics · ${draftAssignmentSummary.groups.length} connected groups · Unsaved draft`}
                onConnectedPairsChange={(pairs) => {
                  captureAssignmentUndo();
                  const text = updateConnectorChoices(draftConnectorState, pairs);
                  setDraftConnectors(text); saveOverride("bridgeConnectors", text);
                }}
                onToothClick={setActiveAssignmentTooth}
              />
              {assignmentUndo && (
                <Pressable accessibilityRole="button" onPress={() => {
                  setAssignmentRoles(assignmentUndo.roles); setAssignmentValues(assignmentUndo.values);
                  setToothIndices(assignmentUndo.teeth); setDraftConnectors(assignmentUndo.connectors);
                  setMaterial(assignmentUndo.material); setShade(assignmentUndo.shade);
                  setAiReaderSession({ userOverrides: { ...getAiReaderSession().userOverrides,
                    assignmentRoles: assignmentUndo.roles, assignmentValues: assignmentUndo.values,
                    toothIndices: assignmentUndo.teeth, bridgeConnectors: assignmentUndo.connectors,
                    material: assignmentUndo.material, shade: assignmentUndo.shade, assignmentOverridesManual: true } });
                  setAssignmentUndo(null);
                }}><Text style={styles.chipText}>Undo last unsaved assignment change</Text></Pressable>
              )}
              <ToothActionSheet allowMarkMissing={false}
                toothId={activeAssignmentTooth as any}
                labOrganizationId={selectedLabId || undefined}
                existingRestorationId={activeAssignmentTooth && assignmentRoles[activeAssignmentTooth] ? activeAssignmentTooth : undefined}
                existingLabel={activeAssignmentTooth ? assignmentRoles[activeAssignmentTooth] : undefined}
                existingAssignment={activeAssignmentTooth ? previewRestorations.find((unit) => unit.toothNumber === activeAssignmentTooth) : undefined}
                groupLabel={activeAssignmentTooth ? draftAssignmentSummary.groups.find((group) => group.includes(activeAssignmentTooth))?.map((tooth) => `#${tooth}`).join(", ") : undefined}
                onClose={() => setActiveAssignmentTooth(null)}
                onConfirm={applyAssignmentDraft}
              />
              {toothIds.map((tooth) => (
                <View key={tooth} style={styles.confirmRow} testID={`ai-tooth-role-${tooth}`}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Edit material and shade for tooth ${tooth}`} onPress={() => setActiveAssignmentTooth(tooth)}>
                    <Text style={[styles.confirmRowName, { minWidth: 42 }]}>#{tooth} · {assignmentValues[tooth]?.material ?? material ?? "Review material"} · {assignmentValues[tooth]?.shade ?? shade ?? "Review shade"}</Text>
                  </Pressable>
                  <View style={[styles.chipRow, { flex: 1 }]}>
                    {([
                      ["Crown", "Prepared crown"],
                      ["Pontic", "Pontic"],
                    ] as const).map(([role, label]) => (
                      <Pressable
                        key={role}
                        testID={`ai-role-${tooth}-${role.toLowerCase()}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: assignmentRoles[tooth] === role }}
                        onPress={() => setToothRole(tooth, role)}
                        style={[styles.chip, assignmentRoles[tooth] === role && styles.chipSelected]}
                      >
                        <Text style={[styles.chipText, assignmentRoles[tooth] === role && styles.chipTextSelected]}>
                          {label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  {!assignmentRoles[tooth] ? (
                    <Text style={styles.warnText}>Review</Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </Section>

        <View style={styles.row2Col}>
          <View style={styles.halfSection}>
            <Text style={styles.clinicalFieldLabel}>Case Material</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Case Material"
              value={material}
              onFocus={captureAssignmentUndo}
              onChangeText={(v) => { setMaterial(v);
                const values = applyClinicalAssignmentDefaults({ material: v });
                setAssignmentValues(values); setAiReaderSession({ userOverrides: { ...getAiReaderSession().userOverrides,
                  material: v, assignmentValues: values, assignmentOverridesManual: true } }); }}
              placeholder="Zirconia, E max…"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <View style={styles.halfSection}>
            <Text style={styles.clinicalFieldLabel}>Shade</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Shade"
              value={shade}
              onFocus={captureAssignmentUndo}
              onChangeText={(v) => { setShade(v);
                const values = applyClinicalAssignmentDefaults({ shade: v });
                setAssignmentValues(values); setAiReaderSession({ userOverrides: { ...getAiReaderSession().userOverrides,
                  shade: v, assignmentValues: values, assignmentOverridesManual: true } }); }}
              placeholder="A2, B1…"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
        </View>

        {/* Gingival shade — only relevant for Removable cases */}
        {(caseType?.toLowerCase().includes("removable") || gingivialShade.trim().length > 0) && (
          <Section label="Gingival Shade" styles={styles} colors={colors}>
            <TextInput
              style={styles.input}
              value={gingivialShade}
              onChangeText={(v) => { setGingivialShade(v); saveOverride("gingivialShade", v); }}
              placeholder="Light Pink, Medium Pink…"
              placeholderTextColor={colors.textTertiary}
              onFocus={() => setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 150)}
            />
          </Section>
        )}

        {/* Fabrication step — only shown when the AI extracted one, or as an
            optional picker for all cases so the user can set it manually */}
        {(step !== null || extracted?.step !== null) && (
          <Section label="Fabrication Step" styles={styles} colors={colors}>
            <View style={styles.chipRow}>
              {(
                [
                  { value: "custom_tray",    label: "Custom Tray" },
                  { value: "rims_and_plates", label: "Rims & Plates" },
                  { value: "wax_setup",       label: "Wax Setup" },
                  { value: "process",         label: "Process" },
                ] as const
              ).map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[styles.chip, step === opt.value && styles.chipSelected]}
                  onPress={() => {
                    const next = step === opt.value ? null : opt.value;
                    setStep(next);
                    saveOverride("step", next);
                  }}
                >
                  <Text style={[styles.chipText, step === opt.value && styles.chipTextSelected]}>
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Section>
        )}

        <Section label="Notes" styles={styles} colors={colors}>
          <TextInput
            style={[styles.input, styles.notesInput]}
            value={notes}
            onChangeText={(v) => { setNotes(v); saveOverride("notes", v); }}
            placeholder="Special instructions…"
            placeholderTextColor={colors.textTertiary}
            multiline
            numberOfLines={3}
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            textAlignVertical="top"
          />
        </Section>

        {/* Invoice preview with editable line prices */}
        {(invoicePreviewLoading ||
          invoicePreviewError ||
          invoicePreview !== null) && (
          <View style={styles.invoiceCard}>
            <View style={styles.invoiceHeaderRow}>
              <Ionicons name="document-text-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.invoiceHeaderText}>Invoice preview</Text>
              <Text style={styles.invoiceHeaderHint}>(estimated — created with the case)</Text>
            </View>
            {invoicePreviewError && (
              <Text style={styles.invoiceMuted}>
                {isAdminForSelectedLab
                  ? "Couldn't load the invoice preview. Add reviewed lines below before creating the case."
                  : "Couldn't load the invoice preview. The draft invoice will still be generated when you create the case."}
              </Text>
            )}
            {invoicePreviewError && (
              <Pressable
                onPress={() => {
                  previewRetryRequestedRef.current = true;
                  setInvoicePreviewLoading(true);
                  setInvoicePreviewRetryVersion((version) => version + 1);
                }}
                accessibilityRole="button"
                accessibilityLabel="Retry invoice preview"
                accessibilityState={{ disabled: invoicePreviewLoading }}
                disabled={invoicePreviewLoading}
                testID="ai-reader-invoice-preview-retry"
                style={{
                  alignSelf: "flex-start",
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.border,
                  borderRadius: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, color: colors.text, fontWeight: "600" }}>
                  {invoicePreviewLoading ? "Retrying…" : "Retry preview"}
                </Text>
              </Pressable>
            )}
            {retryPreservedLineCount > 0 && invoicePreview && !invoicePreviewError && (
              <Text style={styles.invoiceMuted}>
                Kept {retryPreservedLineCount} manually reviewed {retryPreservedLineCount === 1 ? "line" : "lines"} and added the new preview lines.
              </Text>
            )}
            {invoicePreviewLoading && !invoicePreview && !invoicePreviewError ? (
              <Text style={styles.invoiceMuted}>Calculating…</Text>
            ) : (invoicePreview?.lineItems?.length ?? 0) === 0 && !(isAdminForSelectedLab && editedLines !== null) ? (
              invoicePreviewError ? null : <Text style={styles.invoiceMuted}>No billable line items were found in the prescription.</Text>
            ) : (
              <View style={[invoicePreviewLoading && { opacity: 0.6 }]}>
                {isAdminForSelectedLab && editedLines !== null ? (
                  /* Admin: full-line editable table */
                  <>
                    {!invoicePreviewLoading && !invoicePreviewError && editedLines.length === 0 &&
                      (invoicePreview?.lineItems?.length ?? 0) === 0 && (
                        <Text style={styles.invoiceMuted}>No billable line items were found in the prescription.</Text>
                      )}
                    {editedLines.map((line) => {
                      const lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
                      return (
                        <React.Fragment key={line.key}>
                        <View style={[styles.invoiceLineRow, { alignItems: "center" }]}>
                          <Pressable
                            style={{
                              flex: 1,
                              backgroundColor: colors.surface,
                              borderWidth: StyleSheet.hairlineWidth,
                              borderColor: colors.border,
                              borderRadius: 4,
                              paddingHorizontal: 6,
                              paddingVertical: 4,
                              minHeight: 28,
                            }}
                            onPress={() => { Keyboard.dismiss(); setPickerOpenForKey(line.key); }}
                            accessibilityRole="button"
                            accessibilityLabel={`Select item for ${line.description || "new line"}`}
                            testID={`ai-reader-invoice-line-picker-${line.key}`}
                          >
                            <Text numberOfLines={1} style={{ fontSize: 12, color: colors.text }}>
                              {line.description.trim() || "Select item…"}
                            </Text>
                          </Pressable>
                          <TextInput
                            style={{
                              width: 36,
                              fontSize: 12,
                              color: colors.text,
                              backgroundColor: colors.surface,
                              borderWidth: StyleSheet.hairlineWidth,
                              borderColor: colors.border,
                              borderRadius: 4,
                              paddingHorizontal: 4,
                              paddingVertical: 4,
                              textAlign: "center",
                              minHeight: 28,
                              marginLeft: 4,
                            }}
                            value={line.qty}
                            onChangeText={(t) =>
                              setEditedLines((prev) =>
                                prev?.map((l) => l.key === line.key ? { ...l, qty: t } : l) ?? prev
                              )
                            }
                            keyboardType="number-pad"
                            placeholder="1"
                            placeholderTextColor={colors.textTertiary}
                            testID={`ai-reader-invoice-line-qty-${line.key}`}
                          />
                          <View style={[styles.invoicePriceInputWrap, { marginLeft: 4 }]}>
                            <Text style={styles.invoicePriceDollar}>$</Text>
                            <TextInput
                              style={styles.invoicePriceInput}
                              value={line.unitPrice}
                              onChangeText={(t) =>
                                setEditedLines((prev) =>
                                  prev?.map((l) => l.key === line.key ? { ...l, unitPrice: t } : l) ?? prev
                                )
                              }
                              keyboardType="decimal-pad"
                              placeholder="0.00"
                              placeholderTextColor={colors.textTertiary}
                              testID={`ai-reader-invoice-line-price-${line.key}`}
                            />
                          </View>
                          <Text style={[styles.invoiceLineTotal, { marginLeft: 4 }]}>
                            ${lineTotal.toFixed(2)}
                          </Text>
                          <Pressable
                            onPress={() =>
                              setEditedLines((prev) => prev?.filter((l) => l.key !== line.key) ?? prev)
                            }
                            hitSlop={8}
                            style={{ marginLeft: 2 }}
                            testID={`ai-reader-invoice-line-remove-${line.key}`}
                          >
                            <Text style={{ fontSize: 16, color: colors.textTertiary, paddingHorizontal: 2 }}>
                              ×
                            </Text>
                          </Pressable>
                        </View>
                        {line.isCustom && (
                          <TextInput
                            style={{
                              color: colors.text,
                              backgroundColor: colors.surface,
                              borderColor: colors.border,
                              borderWidth: StyleSheet.hairlineWidth,
                              borderRadius: 4,
                              paddingHorizontal: 6,
                              paddingVertical: 4,
                              fontSize: 12,
                            }}
                            value={line.description}
                            onChangeText={(description) =>
                              setEditedLines((prev) =>
                                prev?.map((l) => l.key === line.key ? { ...l, description } : l) ?? prev
                              )
                            }
                            placeholder="Enter description…"
                            placeholderTextColor={colors.textTertiary}
                            testID={`ai-reader-invoice-line-custom-description-${line.key}`}
                          />
                        )}
                        </React.Fragment>
                      );
                    })}
                    <Pressable
                      onPress={() =>
                        setEditedLines((prev) => [
                          ...(prev ?? []),
                           { key: `custom-${Date.now()}-${Math.random()}`, description: "", qty: "1", unitPrice: "0.00", isCustom: false, catalogItemKey: null },
                        ])
                      }
                      style={{
                        borderWidth: StyleSheet.hairlineWidth,
                        borderStyle: "dashed",
                        borderColor: colors.border,
                        borderRadius: 4,
                        paddingVertical: 6,
                        alignItems: "center",
                        marginTop: 4,
                      }}
                      testID="ai-reader-invoice-add-line"
                    >
                      <Text style={{ fontSize: 11, color: colors.textSecondary }}>+ Add line</Text>
                    </Pressable>
                    <View style={styles.invoiceTotalRow}>
                      <Text style={styles.invoiceTotalLabel}>Total</Text>
                      <Text style={styles.invoiceTotalValue}>
                        ${editedLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0).toFixed(2)}
                      </Text>
                    </View>
                    <BillableItemPicker
                      visible={pickerOpenForKey !== null}
                      items={billableItems}
                      isLoading={billableItemsQuery.isLoading}
                      isError={billableItemsQuery.isError}
                      onRetry={() => void billableItemsQuery.refetch()}
                      onClose={() => setPickerOpenForKey(null)}
                      onSelect={(result) => {
                        const key = pickerOpenForKey;
                        setPickerOpenForKey(null);
                        setEditedLines((prev) => prev?.map((line) => line.key !== key ? line : result.isCustom
                          ? { ...line, isCustom: true, catalogItemKey: null }
                          : {
                              ...line,
                              isCustom: false,
                              catalogItemKey: result.priceKey,
                              description: result.label,
                              unitPrice: result.unitPrice ?? "",
                            }) ?? prev);
                      }}
                    />
                  </>
                ) : (
                  /* Non-admin: price-only edit (unchanged) */
                  (() => {
                    let runningTotal = 0;
                    const rows = (invoicePreview?.lineItems ?? []).map((li, idx) => {
                      const qty = li.quantity ?? 1;
                      const indices = li.restorationIndices ?? [];
                      const key = indices.length > 0 ? indices.join("-") : `li-${idx}`;
                      const override = priceOverrides[key];
                      const isNoCharge = override?.noCharge === true;
                      const hasUserPrice =
                        !!override &&
                        !override.noCharge &&
                        override.unitPrice.trim() !== "" &&
                        Number.isFinite(Number(override.unitPrice));
                      const serverUnit = li.unitPrice ?? "0.00";
                      const inputValue = isNoCharge
                        ? ""
                        : override
                          ? override.unitPrice
                          : li.priced === false
                            ? ""
                            : serverUnit;
                      const effUnit = isNoCharge
                        ? 0
                        : hasUserPrice
                          ? Number(override!.unitPrice)
                          : Number(serverUnit) || 0;
                      const showNotPriced =
                        !isNoCharge && !hasUserPrice && li.priced === false;
                      const lineTotal = effUnit * qty;
                      if (!showNotPriced) runningTotal += lineTotal;
                      return (
                        <View key={key} style={styles.invoiceLineRow}>
                          <View style={styles.invoiceLineDescWrap}>
                            <Text style={styles.invoiceLineDesc} numberOfLines={2}>
                              {li.toothLabel ? (
                                <Text style={styles.invoiceMuted}>{li.toothLabel} </Text>
                              ) : null}
                              {li.description}
                            </Text>
                            <Text style={styles.invoiceQty}>{qty} ×</Text>
                          </View>
                          <View style={styles.invoiceLineControls}>
                            <View style={styles.invoicePriceInputWrap}>
                              <Text style={styles.invoicePriceDollar}>$</Text>
                              <TextInput
                                style={[
                                  styles.invoicePriceInput,
                                  isNoCharge && styles.invoicePriceInputDisabled,
                                ]}
                                editable={!isNoCharge}
                                value={inputValue}
                                placeholder="0.00"
                                placeholderTextColor={colors.textTertiary}
                                keyboardType="decimal-pad"
                                onChangeText={(t) =>
                                  setLineOverride(key, { unitPrice: t, noCharge: false })
                                }
                              />
                            </View>
                            <Pressable
                              onPress={() => setLineOverride(key, { noCharge: !isNoCharge })}
                              style={[
                                styles.noChargeBtn,
                                isNoCharge && styles.noChargeBtnActive,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.noChargeBtnText,
                                  isNoCharge && styles.noChargeBtnTextActive,
                                ]}
                              >
                                No charge
                              </Text>
                            </Pressable>
                            <Text
                              style={[
                                styles.invoiceLineTotal,
                                showNotPriced && styles.invoiceLineTotalUnpriced,
                              ]}
                            >
                              {showNotPriced ? "not priced" : `$${lineTotal.toFixed(2)}`}
                            </Text>
                          </View>
                        </View>
                      );
                    });
                    return (
                      <>
                        {rows}
                        <View style={styles.invoiceTotalRow}>
                          <Text style={styles.invoiceTotalLabel}>Total</Text>
                          <Text style={styles.invoiceTotalValue}>
                            ${runningTotal.toFixed(2)}
                          </Text>
                        </View>
                      </>
                    );
                  })()
                )}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Bottom bar */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.md }]}>
        {submitting && uploadProgress > 0 && uploadProgress < 1 && (
          <View style={styles.progressWrap}>
            <View style={[styles.progressBar, { width: `${Math.round(uploadProgress * 100)}%` }]} />
          </View>
        )}
        {/* Alloy pre-create warning: shown when PFM/FCM alloy sub-items will be
            created at $0 and need manual pricing after case creation. */}
        {hasUnpricedAlloy && (
          <View style={styles.alloyWarningBanner} testID="alloy-warning-banner">
            <Text style={styles.alloyWarningTitle}>Alloy lines will be added at $0</Text>
            <Text style={styles.alloyWarningBody}>
              Alloy sub-items for{" "}
              {alloyUnpricedSubItems
                .map((s) => (s.description ?? "").replace(/^Alloy\s*/, "#"))
                .join(", ")}{" "}
              will be created at $0 — you must set the price after creating the case.
            </Text>
            {!alloyAcknowledged ? (
              <Pressable
                style={styles.alloyAcknowledgeBtn}
                onPress={() => setAlloyAcknowledged(true)}
                testID="alloy-acknowledge-btn"
              >
                <Text style={styles.alloyAcknowledgeBtnText}>I understand</Text>
              </Pressable>
            ) : (
              <Text style={styles.alloyAcknowledgedText}>✓ Acknowledged</Text>
            )}
          </View>
        )}
        <Pressable
          style={[
            styles.createBtn,
            (submitting || (hasUnpricedAlloy && !alloyAcknowledged)) && styles.createBtnDisabled,
          ]}
          onPress={() => handleSubmit()}
          disabled={submitting || (hasUnpricedAlloy && !alloyAcknowledged)}
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

            {duplicateTruncated ? (
              <Text style={styles.truncationNotice}>
                Showing top {similarHits.length} of {duplicateTotalFound} possible matches
              </Text>
            ) : null}

            <ScrollView
              style={{ maxHeight: 280 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
            >
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

      {/* Remake questionnaire modal */}
      <Modal visible={remakeQuestionnaireVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView style={{ width: "100%" }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={[styles.modalSheet, { paddingBottom: insets.bottom + Spacing.lg }]}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Why is this a remake?</Text>
              {remakePendingHit && (
                <Text style={styles.modalBody}>
                  {`Remaking: #${remakePendingHit.caseNumber ?? ""} · ${remakePendingHit.patientFirstName ?? ""} ${remakePendingHit.patientLastName ?? ""}`}
                </Text>
              )}

              <ScrollView
                style={{ maxHeight: 380 }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
                showsVerticalScrollIndicator={false}
              >
                {/* Crown & Bridge reasons */}
                <Text style={styles.remakeQGroupHeader}>Crown &amp; Bridge</Text>
                {MOBILE_REMAKE_REASONS.filter((r) => r.category === "crown_bridge").map((r) => (
                  <Pressable
                    key={r.key}
                    style={[styles.hitRow, remakeReasonKey === r.key && { backgroundColor: colors.tint + "22" }]}
                    onPress={() => setRemakeReasonKey(r.key)}
                  >
                    <Text style={[Typography.body, { color: colors.text, flex: 1 }]}>{r.label}</Text>
                    {remakeReasonKey === r.key && (
                      <Ionicons name="checkmark-circle" size={18} color={colors.tint} />
                    )}
                  </Pressable>
                ))}

                {/* Removable reasons */}
                <Text style={[styles.remakeQGroupHeader, { marginTop: Spacing.md }]}>Removable</Text>
                {MOBILE_REMAKE_REASONS.filter((r) => r.category === "removable").map((r) => (
                  <Pressable
                    key={r.key}
                    style={[styles.hitRow, remakeReasonKey === r.key && { backgroundColor: colors.tint + "22" }]}
                    onPress={() => setRemakeReasonKey(r.key)}
                  >
                    <Text style={[Typography.body, { color: colors.text, flex: 1 }]}>{r.label}</Text>
                    {remakeReasonKey === r.key && (
                      <Ionicons name="checkmark-circle" size={18} color={colors.tint} />
                    )}
                  </Pressable>
                ))}

                {/* Shade follow-ups (conditional) */}
                {MOBILE_SHADE_KEYS.has(remakeReasonKey) && (
                  <View style={{ gap: Spacing.xs, marginTop: Spacing.md }}>
                    <Text style={styles.remakeQLabel}>Shade — too light or too dark?</Text>
                    <View style={styles.remakeQToggleRow}>
                      {(["light", "dark"] as const).map((v) => (
                        <Pressable
                          key={v}
                          style={[
                            styles.remakeQBtn,
                            remakeShadeLightness === v && styles.remakeQBtnActive,
                          ]}
                          onPress={() => setRemakeShadeLightness(remakeShadeLightness === v ? null : v)}
                        >
                          <Text
                            style={[
                              styles.remakeQBtnText,
                              remakeShadeLightness === v && styles.remakeQBtnTextActive,
                            ]}
                          >
                            {v === "light" ? "Too light" : "Too dark"}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <View style={styles.row2Col}>
                      <View style={styles.halfSection}>
                        <Text style={styles.remakeQLabel}>Shade prescribed</Text>
                        <TextInput
                          style={styles.input}
                          value={remakeShadePrescribed}
                          onChangeText={setRemakeShadePrescribed}
                          placeholder="e.g. A2"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                      <View style={styles.halfSection}>
                        <Text style={styles.remakeQLabel}>Shade provided</Text>
                        <TextInput
                          style={styles.input}
                          value={remakeShadeProvided}
                          onChangeText={setRemakeShadeProvided}
                          placeholder="e.g. B1"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                    </View>
                  </View>
                )}

                {/* Material follow-ups (conditional) */}
                {MOBILE_MATERIAL_KEYS.has(remakeReasonKey) && (
                  <View style={{ gap: Spacing.xs, marginTop: Spacing.md }}>
                    <View style={styles.row2Col}>
                      <View style={styles.halfSection}>
                        <Text style={styles.remakeQLabel}>Material prescribed</Text>
                        <TextInput
                          style={styles.input}
                          value={remakeMaterialPrescribed}
                          onChangeText={setRemakeMaterialPrescribed}
                          placeholder="e.g. PFZ"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                      <View style={styles.halfSection}>
                        <Text style={styles.remakeQLabel}>Material provided</Text>
                        <TextInput
                          style={styles.input}
                          value={remakeMaterialProvided}
                          onChangeText={setRemakeMaterialProvided}
                          placeholder="e.g. Zirconia"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                    </View>
                  </View>
                )}

                {/* Returned to lab */}
                <View style={{ gap: Spacing.xs, marginTop: Spacing.md }}>
                  <Text style={styles.remakeQLabel}>Items returned to lab?</Text>
                  <View style={styles.remakeQToggleRow}>
                    <Pressable
                      style={[styles.remakeQBtn, remakeReturnedToLab === true && styles.remakeQBtnActive]}
                      onPress={() => setRemakeReturnedToLab(remakeReturnedToLab === true ? null : true)}
                    >
                      <Text style={[styles.remakeQBtnText, remakeReturnedToLab === true && styles.remakeQBtnTextActive]}>Yes</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.remakeQBtn, remakeReturnedToLab === false && styles.remakeQBtnActive]}
                      onPress={() => setRemakeReturnedToLab(remakeReturnedToLab === false ? null : false)}
                    >
                      <Text style={[styles.remakeQBtnText, remakeReturnedToLab === false && styles.remakeQBtnTextActive]}>No</Text>
                    </Pressable>
                  </View>
                </View>

                {/* Charge */}
                <View style={{ gap: Spacing.xs, marginTop: Spacing.md, marginBottom: Spacing.sm }}>
                  <Text style={styles.remakeQLabel}>Charge for this remake? *</Text>
                  <View style={styles.remakeQToggleRow}>
                    <Pressable
                      style={[styles.remakeQBtn, remakeCharged === true && styles.remakeQBtnActive]}
                      onPress={() => setRemakeCharged(remakeCharged === true ? null : true)}
                    >
                      <Text style={[styles.remakeQBtnText, remakeCharged === true && styles.remakeQBtnTextActive]}>
                        Yes — invoice
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.remakeQBtn, remakeCharged === false && styles.remakeQBtnAmber]}
                      onPress={() => setRemakeCharged(remakeCharged === false ? null : false)}
                    >
                      <Text style={[styles.remakeQBtnText, remakeCharged === false && styles.remakeQBtnTextAmber]}>
                        No charge
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </ScrollView>

              <Pressable
                style={[styles.newCaseBtn, { marginTop: Spacing.md }]}
                onPress={handleRemakeQuestionnaireSubmit}
              >
                <Text style={styles.newCaseBtnText}>Submit Remake</Text>
              </Pressable>
              <Pressable
                style={styles.ghostBtn}
                onPress={() => {
                  setRemakeQuestionnaireVisible(false);
                  setRemakeOfCaseId(null);
                  setRemakePendingHit(null);
                  setDuplicateModalVisible(true);
                }}
              >
                <Text style={styles.ghostBtnText}>← Back to matches</Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Practice picker modal */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {/* The sheet wraps its own dismissal layer: a modal renders outside
              the screen's touch tree, so the header layer above cannot close
              the keyboard for the filter field in here. */}
          <DismissKeyboardView
            style={[styles.modalSheet, styles.pickerSheet, { paddingBottom: insets.bottom + Spacing.lg }]}
            testID="practice-picker-keyboard-dismiss"
          >
            <View style={styles.modalHandle} />
            <View style={styles.pickerHeaderRow}>
              <Text style={styles.modalTitle}>
                {createPracticeVisible ? "New practice" : "Select a practice"}
              </Text>
              <Pressable
                onPress={() =>
                  createPracticeVisible
                    ? setCreatePracticeVisible(false)
                    : setPickerVisible(false)
                }
                hitSlop={8}
              >
                <Ionicons name="close" size={22} color={colors.textTertiary} />
              </Pressable>
            </View>

            {!createPracticeVisible ? (
              <>
                <View style={styles.searchRow}>
                  <Ionicons name="search" size={16} color={colors.textTertiary} />
                  <TextInput
                    style={styles.searchInput}
                    value={pickerFilter}
                    onChangeText={setPickerFilter}
                    placeholder="Filter practices…"
                    placeholderTextColor={colors.textTertiary}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    testID="practice-picker-search"
                  />
                  {pickerFilter.length > 0 && (
                    <Pressable onPress={() => setPickerFilter("")} hitSlop={8}>
                      <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
                    </Pressable>
                  )}
                </View>

                {providersQuery.isLoading ? (
                  <View style={styles.pickerLoading}>
                    <ActivityIndicator color={colors.tint} />
                  </View>
                ) : (
                  <ScrollView
                    style={styles.pickerList}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode={scrollKeyboardDismissMode}
                    testID="practice-picker-list"
                  >
                    {filteredProviders.length === 0 ? (
                      <Text style={styles.pickerEmpty}>
                        {providers.length === 0
                          ? "No practices yet. Add a new one below."
                          : "No practices match your filter."}
                      </Text>
                    ) : (
                      filteredProviders.map((p) => {
                        const sel = p.id === providerOrgId;
                        const sub = [p.city, p.state].filter(Boolean).join(", ");
                        return (
                          <Pressable
                            key={p.id}
                            style={[styles.pickerRow, sel && styles.pickerRowSelected]}
                            onPress={() => selectProvider(p)}
                            testID={`practice-option-${p.id}`}
                          >
                            <View style={styles.pickerRowMain}>
                              <Text style={styles.pickerRowName} numberOfLines={1}>
                                {p.displayName || p.name}
                              </Text>
                              {sub ? (
                                <Text style={styles.pickerRowSub} numberOfLines={1}>{sub}</Text>
                              ) : null}
                            </View>
                            {sel && (
                              <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                            )}
                          </Pressable>
                        );
                      })
                    )}
                  </ScrollView>
                )}

                <Pressable
                  style={styles.addNewRow}
                  onPress={() => {
                    setNewPracticeName(pickerFilter.trim());
                    setNewDoctorName("");
                    setNewPracticePhone("");
                    setNewPracticeAddress("");
                    setCreatePracticeVisible(true);
                  }}
                >
                  <Ionicons name="add-circle-outline" size={18} color={colors.tint} />
                  <Text style={styles.addNewText}>Add new practice</Text>
                </Pressable>
              </>
            ) : (
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
                style={styles.createScroll}
              >
                <TextInput
                  style={styles.input}
                  value={newPracticeName}
                  onChangeText={setNewPracticeName}
                  placeholder="Practice / clinic name *"
                  placeholderTextColor={colors.textTertiary}
                  autoFocus
                />
                <TextInput
                  style={[styles.input, styles.createFieldGap]}
                  value={newDoctorName}
                  onChangeText={setNewDoctorName}
                  placeholder="Doctor name (optional)"
                  placeholderTextColor={colors.textTertiary}
                  autoCorrect={false}
                />
                <View style={[styles.row2Col, styles.createFieldGap]}>
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
                <Pressable
                  style={styles.createCancelBtn}
                  onPress={() => setCreatePracticeVisible(false)}
                  disabled={creatingPractice}
                >
                  <Text style={styles.createCancelText}>Back to list</Text>
                </Pressable>
              </ScrollView>
            )}
          </DismissKeyboardView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Doctor-confirmation sheet — shown when the server flags the typed
          doctor name as a close match to an existing doctor in this practice. */}
      <FormSheet
        visible={!!doctorConfirm}
        title="Is this the same doctor?"
        onClose={() => setDoctorConfirm(null)}
        onSubmit={handleKeepNewDoctor}
        submitting={submitting}
        submitLabel="Create as new doctor"
      >
        <Text style={styles.confirmIntro}>
          {`"${doctorConfirm?.typedName ?? ""}" looks similar to ${
            (doctorConfirm?.candidates.length ?? 0) === 1 ? "a doctor" : "doctors"
          } already on file in this practice. Tap one to use it, or create a new doctor.`}
        </Text>
        {(doctorConfirm?.candidates ?? []).map((c) => (
          <Pressable
            key={`${c.doctorName}::${c.providerOrganizationId ?? ""}`}
            style={styles.confirmRow}
            onPress={() => handleUseExistingDoctor(c)}
            disabled={submitting}
            testID="doctor-confirm-candidate"
          >
            <Ionicons name="person-circle-outline" size={22} color={colors.tint} />
            <View style={styles.confirmRowMain}>
              <Text style={styles.confirmRowName}>{c.doctorName}</Text>
              <Text style={styles.confirmRowMeta} numberOfLines={1}>
                {`${c.totalCases} ${c.totalCases === 1 ? "case" : "cases"}`}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Pressable>
        ))}
      </FormSheet>

      <FormSheet
        visible={!!doctorIdentify}
        title="Which doctor is this?"
        onClose={() => {
          if (!doctorIdentify) return;
          setConfirmedDoctorName(doctorIdentify.typedName);
          setDoctorIdentify(null);
          setDoctorMemoryError(null);
        }}
        onSubmit={() => {
          if (!doctorIdentify) return;
          setConfirmedDoctorName(doctorIdentify.typedName);
          setDoctorIdentify(null);
          setDoctorMemoryError(null);
        }}
        submitting={savingDoctorMemory}
        submitLabel={`None of these — add "${doctorIdentify?.typedName ?? ""}"`}
        testIDPrefix="doctor-identify"
      >
        <Text style={styles.confirmIntro}>
          The prescription says "{doctorIdentify?.typedName ?? ""}", which isn't
          an exact match for a doctor on file. Confirm who this is and their
          practice fills in automatically from now on.
        </Text>
        {(doctorIdentify?.candidates ?? []).map((candidate) => {
          const address = formatCandidatePracticeAddress(candidate);
          return (
            <Pressable
              key={`${candidate.doctorName}::${candidate.providerOrganizationId ?? ""}`}
              style={styles.confirmRow}
              onPress={() => void handleIdentifyDoctor(candidate)}
              disabled={savingDoctorMemory}
              testID="doctor-identify-candidate"
            >
              <Ionicons name="person-circle-outline" size={22} color={colors.tint} />
              <View style={styles.confirmRowMain}>
                <Text style={styles.confirmRowName}>
                  {candidate.doctorName}
                  {candidate.practiceName ? ` at ${candidate.practiceName}` : ""}
                </Text>
                <Text style={styles.confirmRowMeta} numberOfLines={2}>
                  {[address, `${candidate.totalCases} ${candidate.totalCases === 1 ? "case" : "cases"} on file`]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          );
        })}
        {doctorMemoryError ? (
          <Text style={styles.memoryError} testID="doctor-identify-error">
            {doctorMemoryError}
          </Text>
        ) : null}
      </FormSheet>

      {/* Required "doctor not on file" step — shown when the scanned doctor name
          does NOT strictly match an existing doctor in this practice. The user
          must pick a suggested existing doctor (adopting its stored spelling) or
          explicitly add the scanned name as a new doctor before the case is
          created. */}
      <FormSheet
        visible={!!doctorResolve}
        title="Doctor not on file"
        onClose={() => setDoctorResolve(null)}
        onSubmit={handleKeepNewDoctor}
        submitting={submitting}
        submitLabel={`Add "${doctorResolve?.typedName ?? ""}" as new doctor`}
        testIDPrefix="doctor-resolve"
      >
        <Text style={styles.confirmIntro}>
          {(doctorResolve?.candidates.length ?? 0) > 0
            ? `"${doctorResolve?.typedName ?? ""}" isn't on file for this practice. Tap an existing doctor to use their name, or add it as a new doctor.`
            : `"${doctorResolve?.typedName ?? ""}" isn't on file for this practice. Add it as a new doctor to continue.`}
        </Text>
        {(doctorResolve?.candidates ?? []).map((c) => (
          <Pressable
            key={`${c.doctorName}::${c.providerOrganizationId ?? ""}`}
            style={styles.confirmRow}
            onPress={() => handleUseExistingDoctor(c)}
            disabled={submitting}
            testID="doctor-resolve-candidate"
          >
            <Ionicons name="person-circle-outline" size={22} color={colors.tint} />
            <View style={styles.confirmRowMain}>
              <Text style={styles.confirmRowName}>{c.doctorName}</Text>
              <Text style={styles.confirmRowMeta} numberOfLines={1}>
                {`${c.totalCases} ${c.totalCases === 1 ? "case" : "cases"}`}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Pressable>
        ))}
      </FormSheet>
    </KeyboardAvoidingView>
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
    clinicalFieldLabel: {
      fontSize: 14,
      fontWeight: "700",
      color: c.text,
      marginBottom: Spacing.xs,
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
    resolvedName: { ...Typography.bodyMedium, color: c.text, flex: 1 },
    identifyPendingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.tint + "40",
      backgroundColor: c.tint + "10",
    },
    identifyPendingText: { ...Typography.caption, color: c.textSecondary, flex: 1 },
    memoryHint: {
      ...Typography.caption,
      color: c.textSecondary,
      marginTop: Spacing.xs,
    },
    memoryError: {
      ...Typography.caption,
      color: c.error,
      marginTop: Spacing.xs,
    },

    pickerTrigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Platform.OS === "ios" ? Spacing.sm : Spacing.xs,
      backgroundColor: c.surface,
    },
    pickerTriggerText: { ...Typography.body, color: c.textSecondary, flex: 1 },

    subLabel: { marginTop: Spacing.sm },

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

    // ── Practice picker modal ──
    pickerSheet: { maxHeight: "85%" },
    pickerHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Platform.OS === "ios" ? Spacing.sm : Spacing.xs,
      backgroundColor: c.surface,
    },
    searchInput: { ...Typography.body, color: c.text, flex: 1, padding: 0 },
    pickerList: { maxHeight: 320 },
    pickerLoading: { paddingVertical: Spacing.xl, alignItems: "center" },
    pickerEmpty: {
      ...Typography.caption,
      color: c.textTertiary,
      textAlign: "center",
      paddingVertical: Spacing.lg,
    },
    pickerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      marginBottom: Spacing.sm,
    },
    pickerRowSelected: { borderColor: c.success, backgroundColor: c.success + "10" },
    pickerRowMain: { flex: 1, gap: 2 },
    pickerRowName: { ...Typography.bodyMedium, color: c.text },
    pickerRowSub: { ...Typography.caption, color: c.textSecondary },
    addNewRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
    },
    addNewText: { ...Typography.bodySemibold, color: c.tint },
    createScroll: { gap: Spacing.sm },
    createFieldGap: { marginTop: Spacing.sm },
    createCancelBtn: { paddingVertical: Spacing.sm, alignItems: "center", marginTop: Spacing.xs },
    createCancelText: { ...Typography.body, color: c.textTertiary },

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

    // Alloy pre-create warning banner
    alloyWarningBanner: {
      borderWidth: 1,
      borderColor: "rgba(245,158,11,0.4)",
      backgroundColor: "rgba(245,158,11,0.1)",
      borderRadius: Radius.md,
      padding: Spacing.md,
      gap: Spacing.xs,
      marginBottom: Spacing.sm,
    },
    alloyWarningTitle: {
      ...Typography.captionSemibold,
      color: "#b45309",
    },
    alloyWarningBody: {
      ...Typography.caption,
      color: "#b45309",
    },
    alloyAcknowledgeBtn: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: "rgba(245,158,11,0.6)",
      backgroundColor: "rgba(245,158,11,0.2)",
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      marginTop: Spacing.xs,
    },
    alloyAcknowledgeBtnText: {
      ...Typography.captionSemibold,
      color: "#b45309",
    },
    alloyAcknowledgedText: {
      ...Typography.caption,
      color: "#b45309",
      marginTop: Spacing.xs,
    },

    invoiceCard: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    invoiceHeaderRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: Spacing.xs },
    invoiceHeaderText: { ...Typography.captionSemibold, color: c.text },
    invoiceHeaderHint: { ...Typography.caption, color: c.textSecondary },
    invoiceMuted: { ...Typography.caption, color: c.textSecondary },
    invoiceLineRow: {
      paddingVertical: Spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      gap: Spacing.xs,
    },
    invoiceLineDescWrap: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    invoiceLineDesc: { ...Typography.caption, color: c.text, flex: 1 },
    invoiceQty: { ...Typography.caption, color: c.textSecondary },
    invoiceLineControls: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    invoicePriceInputWrap: { flexDirection: "row", alignItems: "center", flex: 1 },
    invoicePriceDollar: { ...Typography.caption, color: c.textSecondary, marginRight: 2 },
    invoicePriceInput: {
      ...Typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Platform.OS === "ios" ? 6 : 2,
      backgroundColor: c.backgroundSolid,
      flex: 1,
      textAlign: "right",
    },
    invoicePriceInputDisabled: { opacity: 0.4 },
    noChargeBtn: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    noChargeBtnActive: {
      backgroundColor: c.warningStrong + "22",
      borderColor: c.warningStrong,
    },
    noChargeBtnText: { ...Typography.caption, color: c.textSecondary },
    noChargeBtnTextActive: { color: c.warningStrong },
    invoiceLineTotal: { ...Typography.caption, color: c.text, minWidth: 64, textAlign: "right" },
    invoiceLineTotalUnpriced: { color: c.warningStrong },
    invoiceTotalRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: Spacing.sm,
      marginTop: Spacing.xs,
    },
    invoiceTotalLabel: { ...Typography.captionSemibold, color: c.text },
    invoiceTotalValue: { ...Typography.bodySemibold, color: c.text },

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

    truncationNotice: {
      ...Typography.caption,
      color: c.textTertiary,
      textAlign: "center",
      paddingVertical: Spacing.xs,
      marginBottom: Spacing.xs,
    },

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

    // ── Doctor-confirmation sheet ─────────────────────────────────────────────
    confirmIntro: { ...Typography.body, color: c.textSecondary },
    confirmRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    confirmRowMain: { flex: 1 },
    confirmRowName: { ...Typography.bodySemibold, color: c.text },
    confirmRowMeta: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },

    // ── Remake questionnaire modal ────────────────────────────────────────────
    remakeQGroupHeader: {
      ...Typography.caption,
      color: c.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      fontWeight: "600",
      marginBottom: Spacing.xs,
    },
    remakeQLabel: {
      ...Typography.caption,
      color: c.textSecondary,
    },
    remakeQToggleRow: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    remakeQBtn: {
      flex: 1,
      height: 40,
      borderRadius: Radius.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    remakeQBtnActive: {
      backgroundColor: c.tint + "22",
      borderColor: c.tint,
    },
    remakeQBtnAmber: {
      backgroundColor: "#92400e22",
      borderColor: "#92400e",
    },
    remakeQBtnText: {
      ...Typography.caption,
      color: c.textSecondary,
      fontWeight: "600",
    },
    remakeQBtnTextActive: { color: c.tint },
    remakeQBtnTextAmber: { color: "#92400e" },
  });
}

function newestSimilarityHit(matches: SimilarityHit[]): SimilarityHit | null {
  let newest: SimilarityHit | null = null;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const match of matches) {
    if (!match.createdAt) continue;
    const timestamp = new Date(match.createdAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= newestTime) continue;
    newest = match;
    newestTime = timestamp;
  }
  return newest ?? matches[0] ?? null;
}
