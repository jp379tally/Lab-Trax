import React, { useEffect, useMemo, useRef, useState } from "react";
import { invalidToothAssignmentTokens } from "@workspace/case-taxonomy";
import { IMPLANT_FIELDS, isImplantRestoration, type ImplantDetails } from "@workspace/case-taxonomy";
import { ImplantDetailsControls } from "@/components/ImplantDetailsControls";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Keyboard,
} from "react-native";
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCreateCase,
  useGetCatalogTree,
  getGetCatalogTreeQueryKey,
  usePreviewDraftInvoice,
  useSearchDoctors,
  getSearchDoctorsQueryKey,
  useGetPreCreateInvoiceItems,
  getGetPreCreateInvoiceItemsQueryKey,
  useCases,
  type CreateCaseInput,
  type CreateCaseInputRestorationsItem,
  type DoctorMatchCandidate,
  type DoctorSearchEntry,
  type PreviewDraftInvoiceResultData,
} from "@workspace/api-client-react";
import { resilientFetch } from "@/lib/query-client";
import { refreshCaseFinanceQueries } from "@/lib/refresh-case-finance";
import { isRemovableRestorationType } from "@/lib/restoration-category";
import {
  CASE_TAXONOMY,
  CASE_TYPES,
  getSubtypes,
  getMaterialSubtypes,
  encodeRestorationSubtype,
  parseCustomToken,
  type CaseType,
  type CaseSubtype,
  type MaterialSubtype,
  REMAKE_REASONS,
  remakeReasonUsesField,
  CUSTOM_REMAKE_REASON_MAX_LENGTH,
  withPonticConnectorSuggestions,
  serializeConnectorState,
  updateConnectorChoices,
  validateToothConnectors,
  toothAssignmentSummary,
} from "@workspace/case-taxonomy";
import { useMe, editableLabMemberships, adminLabMemberships, type MeMembership } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { DateField } from "@/components/DateField";
import { TimeField } from "@/components/TimeField";
import { SuggestionInput } from "@/components/ui/SuggestionInput";
import { FormSheet } from "@/components/ui/FormSheet";
import { BillableItemPicker, type BillableItem } from "@/components/BillableItemPicker";
import { ToothChart } from "@/components/ToothChart";
import { ToothActionSheet, type ToothActionPayload } from "@/components/ToothActionSheet";
import { deriveCaseHierarchy, expandToothAssignmentIdentifiers } from "@workspace/case-taxonomy";
import { ARCH_OPTIONS, type ArchSelection, isArchRequired } from "@/lib/arch";

const NEW_CASE_REMAKE_REASONS = REMAKE_REASONS;
const NEW_CASE_SHADE_KEYS = new Set<string>(
  REMAKE_REASONS.filter((reason) => remakeReasonUsesField(reason.key, "shade")).map((reason) => reason.key),
);
const NEW_CASE_MATERIAL_KEYS = new Set<string>(
  REMAKE_REASONS.filter((reason) => remakeReasonUsesField(reason.key, "material")).map((reason) => reason.key),
);

interface RestorationDraft extends ImplantDetails {
  key: string;
  toothNumber: string;
  restorationType: string;
  material: string;
  shade: string;
  restorationSubtype?: string;
  /** Level-1 cascade key (caseType). Clears subtypeKey + materialSubtypeKey when changed. */
  caseTypeKey?: CaseType;
  /** Level-2 cascade key (subtype) — a static taxonomy key or a `custom:<id>` token. Clears materialSubtypeKey when changed. */
  subtypeKey?: string;
  /** Level-3 cascade key (materialSubtype) — a static taxonomy key or a `custom:<id>` token. */
  materialSubtypeKey?: string;
  arch?: ArchSelection | null;
  assignmentRole?: "Crown" | "Pontic";
}

function parseChartTeeth(value: string): Set<string> {
  const teeth = new Set<string>();
  for (const token of value.split(/[,\s;]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start >= 1 && start <= 32 && end >= 1 && end <= 32 &&
          (start <= 16) === (end <= 16)) {
        for (let n = Math.min(start, end); n <= Math.max(start, end); n++) teeth.add(String(n));
      }
    } else {
      teeth.add(token.toUpperCase());
    }
  }
  return teeth;
}

function formatChartTeeth(teeth: Set<string>): string {
  return [...teeth].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return a.localeCompare(b);
  }).join(", ");
}

function blankRestoration(): RestorationDraft {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    toothNumber: "",
    restorationType: "",
    material: "",
    shade: "",
    restorationSubtype: undefined,
    caseTypeKey: undefined,
    subtypeKey: undefined,
    materialSubtypeKey: undefined,
    arch: null,
  };
}

// ── Cascade picker helpers ────────────────────────────────────────────────────
/** Labels for level-1 (caseType) picker. */
const _CASE_TYPE_LABELS = CASE_TYPES.map((ct) => CASE_TAXONOMY[ct].label);

function _caseTypeKeyByLabel(label: string): CaseType | undefined {
  return CASE_TYPES.find((ct) => CASE_TAXONOMY[ct].label === label);
}

/**
 * Normalised Case Type → Subtype → Material picker options. Built from the
 * lab's effective catalog tree (`GET /catalog/tree`) when available — so
 * lab-added custom subtypes/materials show up and disabled entries are
 * hidden — with the static taxonomy as a fallback while loading (identical
 * to the tree for a lab with no customizations).
 */
interface PickerMaterialOption {
  key: string; // static taxonomy key, or `custom:<id>` token
  label: string;
  isCustom: boolean;
}
interface PickerSubtypeOption {
  key: string; // static taxonomy key, or `custom:<id>` token
  label: string;
  isCustom: boolean;
  materials: PickerMaterialOption[];
}
type PickerTree = Record<CaseType, PickerSubtypeOption[]>;

function staticPickerTree(): PickerTree {
  const tree = {} as PickerTree;
  for (const ct of CASE_TYPES) {
    tree[ct] = getSubtypes(ct).map((st) => ({
      key: st,
      label: CASE_TAXONOMY[ct].subtypes[st]!.label,
      isCustom: false,
      materials: getMaterialSubtypes(ct, st).map((ms) => ({
        key: ms,
        label: CASE_TAXONOMY[ct].subtypes[st]!.materialSubtypes[ms]!.label,
        isCustom: false,
      })),
    }));
  }
  return tree;
}

/** Encode a picker selection as the `restorationSubtype` column value,
 * emitting `custom:<id>` segments for lab-added catalog entries. */
function encodePickerSelection(
  ct: CaseType,
  sub: PickerSubtypeOption,
  mat?: PickerMaterialOption | null,
): string | undefined {
  const subCustomId = sub.isCustom ? parseCustomToken(sub.key) : null;
  const matCustomId = mat?.isCustom ? parseCustomToken(mat.key) : null;
  return (
    encodeRestorationSubtype({
      caseType: ct,
      subtype: sub.isCustom ? null : (sub.key as CaseSubtype),
      materialSubtype: mat && !mat.isCustom ? (mat.key as MaterialSubtype) : null,
      ...(subCustomId ? { customSubtypeId: subCustomId } : {}),
      ...(matCustomId ? { customMaterialSubtypeId: matCustomId } : {}),
    }) ?? undefined
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong. Please try again.";
}

export default function NewCaseScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const meQuery = useMe();
  const labs = useMemo(() => editableLabMemberships(meQuery.data), [meQuery.data]);

  // ── Form state ──
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const [caseNumber, setCaseNumber] = useState("");
  const [caseNumberEdited, setCaseNumberEdited] = useState(false);
  const [patientFirst, setPatientFirst] = useState("");
  const [patientLast, setPatientLast] = useState("");

  const [doctorInput, setDoctorInput] = useState("");
  const [debouncedDoctor, setDebouncedDoctor] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [providerOrgId, setProviderOrgId] = useState<string | null>(null);
  const [doctorFocused, setDoctorFocused] = useState(false);
  // Tracks what the user has typed since the field was last focused.
  // Resets to "" on every focus so a pre-filled (e.g. AI-supplied) value
  // never narrows the past-doctor list before the user has had a chance to
  // browse all past doctors — mirrors the filterText pattern in SuggestionInput.
  const [doctorTypedSinceFocus, setDoctorTypedSinceFocus] = useState("");

  const [restorations, setRestorations] = useState<RestorationDraft[]>([blankRestoration()]);
  const [toothPickerKey, setToothPickerKey] = useState<string | null>(null);
  const [assignmentTooth, setAssignmentTooth] = useState<string | null>(null);
  const [draftConnectors, setDraftConnectors] = useState("");
  const [assignmentUndo, setAssignmentUndo] = useState<{ rows: RestorationDraft[]; connectors: string } | null>(null);
  function captureAssignmentUndo() {
    setAssignmentUndo({ rows: [...restorations], connectors: draftConnectors });
  }
  const [receivedAt, setReceivedAt] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  const [dueDate, setDueDate] = useState("");
  const [dueDateCapped, setDueDateCapped] = useState(false);
  const [dueTime, setDueTime] = useState("");
  const [dueTimeEnabled, setDueTimeEnabled] = useState(false);
  const [priority, setPriority] = useState<"normal" | "rush">("normal");
  const [notes, setNotes] = useState("");

  const [casePanBarcode, setCasePanBarcode] = useState("");
  const [barcodeConflict, setBarcodeConflict] = useState<{ caseNumber?: string | null } | null>(null);
  const [barcodeChecking, setBarcodeChecking] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [doctorConfirm, setDoctorConfirm] = useState<{
    candidates: DoctorMatchCandidate[];
    typedName: string;
  } | null>(null);

  const createCase = useCreateCase();
  const queryClient = useQueryClient();

  // Lab's effective Case Type → Subtype → Material tree (built-ins + that
  // lab's customizations, disabled entries excluded). Falls back to the
  // static taxonomy while loading — identical for an uncustomized lab.
  const catalogTreeQuery = useGetCatalogTree(
    { labOrganizationId: selectedLabId ?? "", includeInactive: "false" },
    {
      query: {
        queryKey: getGetCatalogTreeQueryKey({
          labOrganizationId: selectedLabId ?? "",
          includeInactive: "false",
        }),
        enabled: !!selectedLabId,
        staleTime: 120_000,
      },
    },
  );
  const pickerTree = useMemo<PickerTree>(() => {
    const caseTypes = catalogTreeQuery.data?.data?.caseTypes;
    const tree = staticPickerTree();
    if (!caseTypes) return tree;
    for (const ctNode of caseTypes) {
      const ct = ctNode.key as CaseType;
      if (!CASE_TYPES.includes(ct)) continue;
      tree[ct] = ctNode.subtypes.map((s) => ({
        key: s.key,
        label: s.label,
        isCustom: s.isCustom,
        materials: s.materials.map((m) => ({
          key: m.key,
          label: m.label,
          isCustom: m.isCustom,
        })),
      }));
    }
    return tree;
  }, [catalogTreeQuery.data]);

  // ── Draft-invoice preview (read-only, display-only) ──
  // Mirrors the desktop drop-zone preview: POSTs the same restorations the case
  // will be created with to the non-persisting /invoices/preview-draft endpoint
  // so the user sees line items + total before creating. No persistence here.
  const previewInvoice = usePreviewDraftInvoice();
  const previewMutateAsync = previewInvoice.mutateAsync;
  const [invoicePreview, setInvoicePreview] =
    useState<PreviewDraftInvoiceResultData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  // Full-line edit state: allows editing description, qty, and unit price, adding
  // custom lines, and removing lines before creating the case.
  // isCustom=true means the user picked "Custom / manual" (free-text description).
  // isCustom=false means a catalog item is selected (or the line came from the preview).
  type EditedLine = {
    key: string;
    description: string;
    qty: string;
    unitPrice: string;
    isCustom: boolean;
    catalogItemId: string | null;
    catalogItemKey: string | null;
  };
  const [editedLines, setEditedLines] = useState<EditedLine[] | null>(null);
  // Key of the line whose BillableItemPicker modal is currently open.
  const [pickerOpenForKey, setPickerOpenForKey] = useState<string | null>(null);

  // True when the signed-in user is admin/owner for the currently selected lab.
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
  const billableItems: BillableItem[] = useMemo(
    () =>
      (billableItemsQuery.data?.data?.items ?? []).map((item) => ({
        id: item.id,
        priceKey: item.priceKey,
        name: item.name,
        unitPrice: item.unitPrice,
      })),
    [billableItemsQuery.data],
  );

  // Whenever the invoice preview updates (new pricing data), reset editedLines so
  // the table reflects the freshest auto-pricing. Resets in-progress edits when
  // the dental/lab/doctor context changes — line structure may have changed.
  // Only admins/owners get the editable table; non-admins get the read-only view.
  useEffect(() => {
    if (!isAdminForSelectedLab) {
      setEditedLines(null);
      return;
    }
    setEditedLines(
      invoicePreview
        ? (invoicePreview.lineItems ?? []).map((li, idx) => ({
            key: `${idx}-${li.description ?? ""}`,
            description: [li.toothLabel, li.description].filter(Boolean).join(" "),
            qty: String(li.quantity ?? 1),
            unitPrice: li.priced === false ? "" : li.unitPrice ?? "0.00",
            isCustom: false,
            catalogItemId: null,
            catalogItemKey: null,
          }))
        : null,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoicePreview, isAdminForSelectedLab]);

  // Restorations the preview should price — the exact set that will be created
  // (rows missing a tooth number or type are skipped, matching handleSubmit).
  const previewRestorations = useMemo(
    () =>
      restorations
        .filter(
          (r) =>
            r.restorationType.trim() &&
            (r.caseTypeKey !== "restorative" || !r.toothNumber.trim() || !!r.assignmentRole) &&
            (r.toothNumber.trim() || isRemovableRestorationType(r.restorationType)),
        )
        .flatMap((r) => {
          const base = {
          toothNumber: r.toothNumber.trim(),
          restorationType: r.assignmentRole ?? r.restorationType.trim(),
          ...(r.material.trim() ? { material: r.material.trim() } : {}),
          ...(r.shade.trim() ? { shade: r.shade.trim() } : {}),
          quantity: 1,
          };
          const teeth = r.assignmentRole
            ? [...parseChartTeeth(r.toothNumber)]
            : [r.toothNumber.trim()];
          return teeth.flatMap((toothNumber) => {
            const unit = { ...base, toothNumber };
            if (r.arch === "both") {
              return [{ ...unit, arch: "upper" }, { ...unit, arch: "lower" }];
            }
            return [r.arch ? { ...unit, arch: r.arch } : unit];
          });
        }),
    [restorations],
  );

  // Default the lab selector to the first editable lab once /me resolves.
  useEffect(() => {
    if (!selectedLabId && labs.length > 0) setSelectedLabId(labs[0].organizationId);
  }, [labs, selectedLabId]);

  function applyDueDateCap(raw: string): string {
    if (!raw) { setDueDateCapped(false); return raw; }
    const lab = labs.find((m) => m.organizationId === selectedLabId)?.organization;
    const days = lab?.defaultCaseDueDays as number | null | undefined;
    const cap = (lab as any)?.capCaseDueToDefault as boolean | null | undefined;
    if (cap && days) {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + days);
      const maxStr = maxDate.toISOString().slice(0, 10);
      if (raw > maxStr) {
        setDueDateCapped(true);
        return maxStr;
      }
    }
    setDueDateCapped(false);
    return raw;
  }

  // Auto case number for the chosen lab (kept editable; user edits win).
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

  // Debounce doctor search input.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDoctor(doctorInput.trim()), 300);
    return () => clearTimeout(t);
  }, [doctorInput]);

  // Debounced draft-invoice preview — fires 400 ms after the last edit to the
  // lab, practice, doctor, or restorations. Cancels in-flight requests when
  // inputs change so the latest edit always wins.
  useEffect(() => {
    if (!selectedLabId || previewRestorations.length === 0) {
      setInvoicePreview(null);
      setPreviewError(false);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await previewMutateAsync({
          data: {
            labOrganizationId: selectedLabId,
            ...(providerOrgId ? { providerOrganizationId: providerOrgId } : {}),
            ...(doctorName.trim() ? { doctorName: doctorName.trim() } : {}),
            restorations: previewRestorations,
          },
        });
        if (!cancelled) {
          setInvoicePreview(res?.data ?? null);
          setPreviewError(false);
        }
      } catch {
        if (!cancelled) {
          setInvoicePreview(null);
          setPreviewError(true);
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [selectedLabId, providerOrgId, doctorName, previewRestorations, previewMutateAsync]);

  // ── Barcode conflict check — debounced, fires 400 ms after last keystroke ──
  useEffect(() => {
    const trimmed = casePanBarcode.trim();
    if (!trimmed || !selectedLabId) {
      setBarcodeConflict(null);
      setBarcodeChecking(false);
      return;
    }
    setBarcodeChecking(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ barcode: trimmed, labOrganizationId: selectedLabId });
        const res = await resilientFetch(`/api/cases?${qs.toString()}`);
        if (!res.ok) { setBarcodeConflict(null); return; }
        const body = await res.json() as { data?: Array<{ caseNumber?: string | null }> };
        const matches = body?.data ?? [];
        setBarcodeConflict(matches.length > 0 ? matches[0] : null);
      } catch {
        setBarcodeConflict(null);
      } finally {
        setBarcodeChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [casePanBarcode, selectedLabId]);

  const doctorSearchParams = { labOrganizationId: selectedLabId ?? "", q: debouncedDoctor };
  const doctorSearch = useSearchDoctors(doctorSearchParams, {
    query: {
      queryKey: getSearchDoctorsQueryKey(doctorSearchParams),
      enabled: !!selectedLabId && debouncedDoctor.length >= 2 && !providerOrgId,
    },
  });
  const doctorResults: DoctorSearchEntry[] = useMemo(
    () => (doctorSearch.data?.data?.entries ?? []).filter((e) => !!e.providerOrganizationId),
    [doctorSearch.data],
  );

  // ── Name suggestions from existing cases ──
  const existingCasesQuery = useCases(
    { organizationId: selectedLabId ?? "" },
    { enabled: !!selectedLabId, staleTime: 5 * 60 * 1000 },
  );

  const distinctPatientFirstNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of existingCasesQuery.data ?? []) {
      if (c.patientFirstName?.trim()) names.add(c.patientFirstName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [existingCasesQuery.data]);

  const distinctPatientLastNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of existingCasesQuery.data ?? []) {
      if (c.patientLastName?.trim()) names.add(c.patientLastName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [existingCasesQuery.data]);

  // Distinct doctor entries from existing cases, deduped by BOTH doctorName
  // and providerOrganizationId so colliding names from different practices each
  // get their own selectable row with unambiguous binding.
  const distinctDoctorEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: { doctorName: string; providerOrganizationId: string }[] = [];
    for (const c of existingCasesQuery.data ?? []) {
      const name = c.doctorName?.trim();
      const orgId = c.providerOrganizationId?.trim();
      if (!name || !orgId) continue;
      const key = `${name}\0${orgId}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ doctorName: name, providerOrganizationId: orgId });
      }
    }
    return entries.sort((a, b) => a.doctorName.localeCompare(b.doctorName));
  }, [existingCasesQuery.data]);

  // When the same doctor name exists under multiple provider orgs we show a
  // short disambiguator so the user can distinguish rows.
  const doctorNameCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of distinctDoctorEntries) {
      counts.set(e.doctorName, (counts.get(e.doctorName) ?? 0) + 1);
    }
    return counts;
  }, [distinctDoctorEntries]);

  const pastDoctorSuggestions = useMemo(() => {
    if (providerOrgId || !doctorFocused) return [];
    const trimmed = doctorTypedSinceFocus.trim().toLowerCase();
    return distinctDoctorEntries
      .filter((e) => trimmed.length === 0 || e.doctorName.toLowerCase().includes(trimmed))
      .slice(0, 6);
  }, [distinctDoctorEntries, doctorTypedSinceFocus, providerOrgId, doctorFocused]);

  const showPastDoctorDropdown =
    doctorFocused && !providerOrgId && doctorTypedSinceFocus.trim().length < 2 && pastDoctorSuggestions.length > 0;

  function selectPastDoctor(entry: { doctorName: string; providerOrganizationId: string }) {
    setDoctorName(entry.doctorName);
    setProviderOrgId(entry.providerOrganizationId);
    setDoctorInput(entry.doctorName);
    setDoctorFocused(false);
    Keyboard.dismiss();
  }

  function onChangeDoctor(text: string) {
    setDoctorInput(text);
    setDoctorTypedSinceFocus(text);
    // Editing the field after a selection clears the bound provider org so the
    // user must reselect a valid doctor (providerOrganizationId is required).
    if (providerOrgId) {
      setProviderOrgId(null);
      setDoctorName("");
    }
  }

  function selectDoctor(entry: DoctorSearchEntry) {
    setDoctorName(entry.doctorName ?? "");
    setProviderOrgId(entry.providerOrganizationId ?? null);
    setDoctorInput(entry.doctorName ?? "");
    setDoctorFocused(false);
    Keyboard.dismiss();
  }

  function updateRestoration(key: string, patch: Partial<RestorationDraft>) {
    captureAssignmentUndo();
    setRestorations((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if (
          patch.restorationType !== undefined &&
          isRemovableRestorationType(patch.restorationType)
        ) {
          next.toothNumber = "";
        }
        return next;
      }),
    );
  }
  function addRestoration() {
    captureAssignmentUndo();
    setRestorations((prev) => [...prev, blankRestoration()]);
  }
  function applyManualAssignment(payload: ToothActionPayload) {
    if (submitting) return;
    captureAssignmentUndo();
    let rows = restorations.flatMap((row) => {
      const teeth = row.caseTypeKey === "restorative" ? expandToothAssignmentIdentifiers(row.toothNumber) : [];
      return teeth.length > 1 ? teeth.map((tooth) => ({ ...row, key: blankRestoration().key, toothNumber: tooth })) : [row];
    }).filter((row) => row.restorationType || row.caseTypeKey || row.toothNumber || row.material);
    function assign(tooth: string, role: "Crown" | "Pontic", material: string, shade?: string, subtype?: string) {
      const previous = rows.find((row) => row.caseTypeKey === "restorative" && row.toothNumber === tooth);
      const hierarchy = deriveCaseHierarchy("Crown", subtype ?? previous?.restorationSubtype, material);
      const row: RestorationDraft = { ...(previous ?? blankRestoration()), toothNumber: tooth, assignmentRole: role,
        restorationType: "Crown", material, shade: shade ?? "", caseTypeKey: "restorative", arch: null,
        restorationSubtype: subtype ?? previous?.restorationSubtype,
        subtypeKey: hierarchy.customSubtypeId ? `custom:${hierarchy.customSubtypeId}` : hierarchy.subtype ?? "crown",
        materialSubtypeKey: hierarchy.customMaterialSubtypeId ? `custom:${hierarchy.customMaterialSubtypeId}` : hierarchy.materialSubtype ?? undefined };
      rows = previous ? rows.map((candidate) => candidate.key === previous.key ? row : candidate) : [...rows, row];
    }
    const current = rows.find((row) => row.caseTypeKey === "restorative" && row.toothNumber === assignmentTooth);
    if (payload.kind === "add_crown" || payload.kind === "add_pontic") {
      assign(payload.toothId, payload.kind === "add_pontic" ? "Pontic" : "Crown", payload.material, payload.shade, payload.restorationSubtype);
    } else if (payload.kind === "copy_assignment") {
      for (const tooth of payload.toothNumbers) assign(tooth, payload.role, payload.material, payload.shade, payload.restorationSubtype);
    } else if (payload.kind === "change_role" && current) {
      assign(current.toothNumber, payload.role, current.material, current.shade, current.restorationSubtype);
    } else if (payload.kind === "change_restoration" && current?.assignmentRole) {
      assign(payload.toothId, current.assignmentRole, payload.material, payload.shade, payload.restorationSubtype);
    } else if (payload.kind === "remove_restoration" || payload.kind === "mark_missing") {
      rows = rows.filter((row) => !(row.caseTypeKey === "restorative" && row.toothNumber === payload.toothId));
    }
    setRestorations(rows);
    setAssignmentTooth(null);
  }
  function removeRestoration(key: string) {
    captureAssignmentUndo();
    setRestorations((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  // ── Remake state ──────────────────────────────────────────────────────────
  const [isRemake, setIsRemake] = useState(false);
  const [remakeSearch, setRemakeSearch] = useState("");
  const [remakeSelected, setRemakeSelected] = useState<{
    id: string;
    caseNumber: string | null;
    patientFirstName: string | null;
    patientLastName: string | null;
  } | null>(null);
  const [remakeReasonKey, setRemakeReasonKey] = useState<string>("");
  const [remakeCustomReason, setRemakeCustomReason] = useState("");
  const [remakeShadeLightness, setRemakeShadeLightness] = useState<"light" | "dark" | null>(null);
  const [remakeShadePrescribed, setRemakeShadePrescribed] = useState("");
  const [remakeShadeProvided, setRemakeShadeProvided] = useState("");
  const [remakeMaterialPrescribed, setRemakeMaterialPrescribed] = useState("");
  const [remakeMaterialProvided, setRemakeMaterialProvided] = useState("");
  const [remakeReturnedToLab, setRemakeReturnedToLab] = useState<boolean | null>(null);
  const [remakeCharged, setRemakeCharged] = useState<boolean | null>(null);
  const [remakeNotes, setRemakeNotes] = useState("");
  const remakeCustomReasonRef = useRef<TextInput>(null);

  function selectRemakeReason(key: string) {
    if (key !== "other") {
      remakeCustomReasonRef.current?.blur?.();
    }
    setRemakeReasonKey(key);
    if (key !== "other") setRemakeCustomReason("");
    if (!NEW_CASE_SHADE_KEYS.has(key)) {
      setRemakeShadeLightness(null);
      setRemakeShadePrescribed("");
      setRemakeShadeProvided("");
    }
    if (!NEW_CASE_MATERIAL_KEYS.has(key)) {
      setRemakeMaterialPrescribed("");
      setRemakeMaterialProvided("");
    }
  }

  useEffect(() => {
    if (remakeReasonKey === "other") {
      remakeCustomReasonRef.current?.focus();
    } else {
      remakeCustomReasonRef.current?.blur?.();
    }
  }, [remakeReasonKey]);

  // Filter existing cases locally for remake search (no extra API call needed)
  const remakeHits = useMemo(() => {
    if (!isRemake || !remakeSearch.trim()) return [];
    const q = remakeSearch.trim().toLowerCase();
    return (existingCasesQuery.data ?? []).filter((c) => {
      const num = (c.caseNumber ?? "").toLowerCase();
      const first = (c.patientFirstName ?? "").toLowerCase();
      const last = (c.patientLastName ?? "").toLowerCase();
      return (
        num.includes(q) ||
        first.includes(q) ||
        last.includes(q) ||
        `${first} ${last}`.includes(q)
      );
    }).slice(0, 6);
  }, [isRemake, remakeSearch, existingCasesQuery.data]);

  // ── Validation ──
  const errors = {
    lab: !selectedLabId,
    caseNumber: caseNumber.trim().length === 0,
    patientFirst: patientFirst.trim().length === 0,
    patientLast: patientLast.trim().length === 0,
    doctor: !providerOrgId || doctorName.trim().length === 0,
    arch: restorations.some((r) =>
      isArchRequired(r.caseTypeKey) &&
      !r.arch &&
      !r.restorationSubtype?.startsWith("removable/custom:"),
    ),
    assignmentRole: restorations.some((r) =>
      r.caseTypeKey === "restorative" &&
      r.toothNumber.trim().length > 0 &&
      !r.assignmentRole,
    ),
    remake: isRemake && (!remakeSelected || !remakeReasonKey || (remakeReasonUsesField(remakeReasonKey, "customReason") && (!remakeCustomReason.trim() || remakeCustomReason.trim().length > CUSTOM_REMAKE_REASON_MAX_LENGTH)) || remakeCharged === null),
  };
  const hasErrors = Object.values(errors).some(Boolean);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as never);
  }

  const draftConnectorState = withPonticConnectorSuggestions(draftConnectors, previewRestorations);
  const draftConnectorText = serializeConnectorState(draftConnectorState);
  const draftAssignmentSummary = toothAssignmentSummary(previewRestorations, draftConnectorText);
  const draftConnectorValidation = validateToothConnectors(draftConnectorText, previewRestorations);
  function buildPayload(opts?: { confirmNewDoctor?: boolean }): (CreateCaseInput & { bridgeConnectors: string }) | null {
    if (restorations.some((row) => row.assignmentRole && invalidToothAssignmentTokens(row.toothNumber).length)) {
      Alert.alert("Review tooth numbers", "Enter valid tooth numbers or same-arch ranges for crown and pontic assignments.");
      return null;
    }
    if (!draftConnectorValidation.valid || draftAssignmentSummary.unresolvedPontics.length) {
      Alert.alert("Review tooth assignments", !draftConnectorValidation.valid
        ? draftConnectorValidation.errors.join(" ")
        : `Connect or review pontics ${draftAssignmentSummary.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")}.`);
      return null;
    }
    if (!selectedLabId || !providerOrgId) return null;

    const cleanRestorations: CreateCaseInputRestorationsItem[] = restorations
      .filter(
        (r) =>
          r.restorationType.trim() &&
          (r.caseTypeKey !== "restorative" || !r.toothNumber.trim() || !!r.assignmentRole) &&
          (r.toothNumber.trim() || isRemovableRestorationType(r.restorationType)),
      )
      .flatMap((r) => {
        const base = {
          restorationType: r.assignmentRole ?? r.restorationType.trim(),
          ...(r.restorationSubtype ? { restorationSubtype: r.restorationSubtype } : {}),
          ...Object.fromEntries(IMPLANT_FIELDS.filter((field) => r[field]?.trim()).map((field) => [field, r[field]!.trim()])),
          ...(r.material.trim() ? { material: r.material.trim() } : {}),
          ...(r.shade.trim() ? { shade: r.shade.trim() } : {}),
          quantity: 1,
        };
        const teeth = r.assignmentRole
          ? [...parseChartTeeth(r.toothNumber)]
          : [r.toothNumber.trim()];
        return teeth.flatMap((toothNumber) => {
          const unit = { ...base, toothNumber };
          if (r.arch === "both") {
            return [{ ...unit, arch: "upper" as const }, { ...unit, arch: "lower" as const }];
          }
          return [r.arch ? { ...unit, arch: r.arch } : unit];
        });
      });

    return {
      caseNumber: caseNumber.trim(),
      labOrganizationId: selectedLabId,
      providerOrganizationId: providerOrgId,
      patientFirstName: patientFirst.trim(),
      patientLastName: patientLast.trim(),
      doctorName: doctorName.trim(),
      priority,
      receivedAt,
      ...(dueDate.trim()
        ? { dueDate: dueDate.trim(), ...(dueTime.trim() ? { dueTime: dueTime.trim() } : {}) }
        : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(cleanRestorations.length ? { restorations: cleanRestorations } : {}),
      bridgeConnectors: draftConnectorText,
      ...(casePanBarcode.trim() ? { casePanBarcode: casePanBarcode.trim() } : {}),
      ...(opts?.confirmNewDoctor ? { confirmNewDoctor: true } : {}),
      ...(editedLines !== null
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
      ...(isRemake && remakeSelected
        ? {
            remakeOfCaseId: remakeSelected.id,
            remakeReason:
              remakeReasonKey === "other"
                ? remakeCustomReason.trim()
                : NEW_CASE_REMAKE_REASONS.find((r) => r.key === remakeReasonKey)?.label ?? remakeReasonKey,
            remakeCharged: remakeCharged ?? false,
            ...(remakeReasonKey ? { remakeReasonKey } : {}),
            ...(remakeShadeLightness ? { remakeShadeLightness } : {}),
            ...(remakeShadePrescribed.trim() ? { remakeShadePrescribed: remakeShadePrescribed.trim() } : {}),
            ...(remakeShadeProvided.trim() ? { remakeShadeProvided: remakeShadeProvided.trim() } : {}),
            ...(remakeMaterialPrescribed.trim() ? { remakeMaterialPrescribed: remakeMaterialPrescribed.trim() } : {}),
            ...(remakeMaterialProvided.trim() ? { remakeMaterialProvided: remakeMaterialProvided.trim() } : {}),
            ...(remakeReturnedToLab !== null ? { remakeReturnedToLab } : {}),
            ...(remakeReasonKey && remakeReasonKey !== "other"
              ? {
                  remakeCategory: NEW_CASE_REMAKE_REASONS.find((r) => r.key === remakeReasonKey)
                    ?.category,
                }
              : {}),
            ...(remakeNotes.trim() ? { remakeNotes: remakeNotes.trim() } : {}),
          }
        : {}),
    };
  }

  async function submitCase(payload: CreateCaseInput) {
    setSubmitting(true);
    try {
      const result = await createCase.mutateAsync({ data: payload });
      const newId = result?.data?.id;
      if (!newId) {
        throw new Error("The server did not return the new case. Refresh before trying again.");
      }
      await refreshCaseFinanceQueries(queryClient);
      setDoctorConfirm(null);
      router.replace(`/case/${newId}` as never);
    } catch (e) {
      const err = e as { status?: number; data?: { details?: unknown } };
      const details = err?.data?.details as
        | { code?: string; candidates?: DoctorMatchCandidate[] }
        | undefined;
      if (err?.status === 409 && details?.code === "DOCTOR_CONFIRMATION_REQUIRED") {
        setDoctorConfirm({
          candidates: Array.isArray(details.candidates) ? details.candidates : [],
          typedName: (payload.doctorName ?? "").trim(),
        });
        return;
      }
      Alert.alert("Couldn't create case", errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    setAttemptedSubmit(true);
    if (hasErrors || !selectedLabId || !providerOrgId) {
      if (errors.doctor) {
        Alert.alert("Select a doctor", "Choose a doctor from the search results so the case is linked to their practice.");
      } else if (errors.remake) {
        Alert.alert(
          "Remake details needed",
          !remakeSelected
            ? "Search for and select the original case being remade."
            : !remakeReasonKey
            ? "Select a remake reason."
            : "Choose whether to charge for this remake.",
        );
      }
      return;
    }

    const payload = buildPayload();
    if (!payload) return;
    await submitCase(payload);
  }

  function handleUseExistingDoctor(candidate: DoctorMatchCandidate) {
    setDoctorName(candidate.doctorName);
    setDoctorInput(candidate.doctorName);
    if (candidate.providerOrganizationId) {
      setProviderOrgId(candidate.providerOrganizationId);
    }
    const payload = buildPayload({ confirmNewDoctor: true });
    if (!payload) return;
    void submitCase({ ...payload, doctorName: candidate.doctorName });
  }

  function handleKeepNewDoctor() {
    const payload = buildPayload({ confirmNewDoctor: true });
    if (!payload) return;
    void submitCase(payload);
  }

  // ── Loading / no-lab states ──
  if (meQuery.isLoading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (labs.length === 0) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header title="New Case" onBack={goBack} styles={styles} colors={colors} />
        <View style={styles.center}>
          <Ionicons name="business-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No lab to create in</Text>
          <Text style={styles.emptyBody}>
            You need an active lab membership with edit access to create cases.
          </Text>
        </View>
      </View>
    );
  }

  const showError = (key: keyof typeof errors) => attemptedSubmit && errors[key];

  return (
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: insets.top }]}
      testID="new-case-keyboard-dismiss"
    >
      <Header title="New Case" onBack={goBack} styles={styles} colors={colors} />

      <KeyboardAwareScrollView
        testID="new-case-keyboard-aware-scroll"
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        bottomOffset={72}
      >
        <View style={styles.requiredNote}>
          <Text style={styles.required}>*</Text>
          <Text style={styles.requiredNoteText}>Required fields</Text>
        </View>

        <Card style={styles.formSection} testID="new-case-patient-section">
          <SectionHeading
            icon="people-outline"
            title="Patient & Doctor Information"
            styles={styles}
            colors={colors}
          />
          {/* Case number */}
          <Field label="Case Number" required styles={styles}>
            <View style={styles.inlineRow}>
              <TextInput
                style={[styles.input, styles.inlineInput, showError("caseNumber") && styles.inputError]}
                value={caseNumber}
                onChangeText={(t) => {
                  setCaseNumber(t);
                  setCaseNumberEdited(true);
                }}
                placeholder="26-1"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
                testID="new-case-number"
              />
              <Pressable
                onPress={() => {
                  setCaseNumberEdited(false);
                  nextNumberQuery.refetch();
                }}
                style={styles.iconBtn}
                hitSlop={8}
                testID="new-case-number-refresh"
              >
                {nextNumberQuery.isFetching ? (
                  <ActivityIndicator color={colors.tint} size="small" />
                ) : (
                  <Ionicons name="refresh" size={18} color={colors.tint} />
                )}
              </Pressable>
            </View>
          </Field>

          <View style={styles.nameFieldsRow}>
            <View style={styles.nameField}>
              <Field label="First Name" required styles={styles}>
                <SuggestionInput
                  value={patientFirst}
                  onChangeText={setPatientFirst}
                  suggestions={distinctPatientFirstNames}
                  placeholder="Jane"
                  placeholderTextColor={colors.textTertiary}
                  inputStyle={[styles.input, showError("patientFirst") && styles.inputError]}
                  testID="new-case-patient-first"
                  autoCapitalize="words"
                />
              </Field>
            </View>
            <View style={styles.nameField}>
              <Field label="Last Name" required styles={styles}>
                <SuggestionInput
                  value={patientLast}
                  onChangeText={setPatientLast}
                  suggestions={distinctPatientLastNames}
                  placeholder="Doe"
                  placeholderTextColor={colors.textTertiary}
                  inputStyle={[styles.input, showError("patientLast") && styles.inputError]}
                  testID="new-case-patient-last"
                  autoCapitalize="words"
                />
              </Field>
            </View>
          </View>

          {/* Doctor search */}
          <Field label="Doctor" required styles={styles}>
            <TextInput
              style={[styles.input, showError("doctor") && styles.inputError]}
              value={doctorInput}
              onChangeText={onChangeDoctor}
              onFocus={() => {
                setDoctorTypedSinceFocus("");
                setDoctorFocused(true);
              }}
              placeholder="Search doctor or practice"
              placeholderTextColor={colors.textTertiary}
              autoCorrect={false}
              testID="new-case-doctor"
            />
            {providerOrgId ? (
              <View style={styles.selectedDoctorRow}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={styles.selectedDoctorText} numberOfLines={1}>
                  Linked to {doctorName}
                </Text>
              </View>
            ) : null}
            {showPastDoctorDropdown ? (
              <View style={styles.dropdown}>
                {pastDoctorSuggestions.map((entry, idx) => (
                  <Pressable
                    key={`past-${entry.providerOrganizationId}-${idx}`}
                    onPress={() => selectPastDoctor(entry)}
                    style={styles.dropdownItem}
                    testID={`past-doctor-result-${idx}`}
                  >
                    <Text style={styles.dropdownItemName} numberOfLines={1}>
                      {entry.doctorName}
                    </Text>
                    {(doctorNameCount.get(entry.doctorName) ?? 1) > 1 ? (
                      <Text style={styles.dropdownItemSub} numberOfLines={1}>
                        {"…" + entry.providerOrganizationId.slice(-6)}
                      </Text>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            {doctorFocused && !providerOrgId && doctorTypedSinceFocus.trim().length >= 2 ? (
              <View style={styles.dropdown}>
                {doctorSearch.isFetching ? (
                  <View style={styles.dropdownLoading}>
                    <ActivityIndicator color={colors.tint} size="small" />
                  </View>
                ) : doctorResults.length === 0 ? (
                  <Text style={styles.dropdownEmpty}>No matching doctors.</Text>
                ) : (
                  doctorResults.slice(0, 8).map((entry, idx) => (
                    <Pressable
                      key={`${entry.providerOrganizationId}-${idx}`}
                      onPress={() => selectDoctor(entry)}
                      style={styles.dropdownItem}
                      testID={`doctor-result-${idx}`}
                    >
                      <Text style={styles.dropdownItemName} numberOfLines={1}>
                        {entry.doctorName || "Unnamed doctor"}
                      </Text>
                      {entry.practiceName ? (
                        <Text style={styles.dropdownItemSub} numberOfLines={1}>
                          {entry.practiceName}
                        </Text>
                      ) : null}
                    </Pressable>
                  ))
                )}
              </View>
            ) : null}
          </Field>

          {/* Lab selector (only when more than one editable lab) */}
          {labs.length > 1 ? (
            <Field label="Lab" styles={styles}>
              <View style={styles.chipRow}>
                {labs.map((m: MeMembership) => {
                  const selected = m.organizationId === selectedLabId;
                  return (
                    <Pressable
                      key={m.organizationId}
                      onPress={() => {
                        if (m.organizationId === selectedLabId) return;
                        setSelectedLabId(m.organizationId);
                        setDoctorInput("");
                        setDebouncedDoctor("");
                        setDoctorName("");
                        setProviderOrgId(null);
                        setDoctorFocused(false);
                        setDoctorTypedSinceFocus("");
                        setInvoicePreview(null);
                        setEditedLines(null);
                      }}
                      style={[styles.chip, selected && styles.chipSelected]}
                      testID={`lab-chip-${m.organizationId}`}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                        {m.organization?.name ?? "Lab"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>
          ) : (
            <Field label="Lab" styles={styles}>
              <Text style={styles.staticValue}>{labs[0]?.organization?.name ?? "Lab"}</Text>
            </Field>
          )}
        </Card>

        {/* Restorations */}
        <Card style={styles.formSection} testID="new-case-restorations-section">
          <View style={styles.sectionHeaderRow}>
            <SectionHeading
              icon="medical-outline"
              title="Restorations"
              styles={styles}
              colors={colors}
            />
            <Pressable onPress={addRestoration} hitSlop={8} style={styles.addLink} testID="add-restoration">
              <Ionicons name="add-circle-outline" size={18} color={colors.tint} />
              <Text style={styles.addLinkText}>Add</Text>
            </Pressable>
          </View>
          <ToothChart
            selected={new Set(expandToothAssignmentIdentifiers(previewRestorations.map((row) => row.toothNumber ?? "").join(", ")))}
            crownTeeth={new Set(previewRestorations.filter((row) => row.restorationType === "Crown").map((row) => row.toothNumber!))}
            ponticTeeth={new Set(previewRestorations.filter((row) => row.restorationType === "Pontic").map((row) => row.toothNumber!))}
            connectedPairs={draftConnectorState.active} connectorSuggestions={draftConnectorState.suggested}
            connectorIssue={!draftConnectorValidation.valid ? draftConnectorValidation.errors.join(" ") : draftAssignmentSummary.unresolvedPontics.length ? `Review pontics ${draftAssignmentSummary.unresolvedPontics.join(", ")}` : null}
            summaryText={`${draftAssignmentSummary.units} units · ${draftAssignmentSummary.groups.length} connected groups · Unsaved draft`}
            onToothClick={(tooth) => { if (!submitting) setAssignmentTooth(tooth); }}
            onConnectedPairsChange={(pairs) => { if (submitting) return; captureAssignmentUndo(); setDraftConnectors(updateConnectorChoices(draftConnectorState, pairs)); }}
          />
          <ToothActionSheet allowMarkMissing={false} toothId={assignmentTooth} labOrganizationId={selectedLabId ?? undefined} submitting={submitting}
            existingRestorationId={restorations.find((row) => row.assignmentRole && parseChartTeeth(row.toothNumber).has(assignmentTooth ?? ""))?.key}
            existingAssignment={(() => { const row = restorations.find((unit) => unit.assignmentRole && parseChartTeeth(unit.toothNumber).has(assignmentTooth ?? ""));
              return row ? { restorationType: row.assignmentRole!, material: row.material, shade: row.shade, restorationSubtype: row.restorationSubtype } : undefined; })()}
            groupLabel={draftAssignmentSummary.groups.find((group) => group.includes(assignmentTooth ?? ""))?.join(", ")}
            onClose={() => setAssignmentTooth(null)} onConfirm={applyManualAssignment} />
        {restorations.map((r, idx) => (
          <Card key={r.key} style={styles.restoCard}>
            <View style={styles.restoHeaderRow}>
              <Text style={styles.restoIndex}>#{idx + 1}</Text>
              {restorations.length > 1 ? (
                <Pressable onPress={() => removeRestoration(r.key)} hitSlop={8} testID={`remove-restoration-${idx}`}>
                  <Ionicons name="trash-outline" size={16} color={colors.warning} />
                </Pressable>
              ) : null}
            </View>
            {/* Row 1: Tooth # (non-removable) + Case Type (level-1 taxonomy) */}
            {(() => {
              const isRemovable =
                r.caseTypeKey === "removable" ||
                (!r.caseTypeKey && isRemovableRestorationType(r.restorationType));
              return (
            <View style={styles.restoGrid}>
              {!isRemovable && (
                <View style={styles.restoCol}>
                  <Text style={styles.miniLabel}>Tooth #</Text>
                  <TextInput
                    style={styles.input}
                    value={r.toothNumber}
                    onChangeText={(t) => updateRestoration(r.key, { toothNumber: t })}
                    placeholder="14"
                    placeholderTextColor={colors.textTertiary}
                    testID={`resto-tooth-${idx}`}
                  />
                  <Pressable
                    testID={`resto-tooth-chart-toggle-${idx}`}
                    onPress={() => setToothPickerKey(toothPickerKey === r.key ? null : r.key)}
                    style={{ paddingVertical: Spacing.xs }}
                  >
                    <Text style={[styles.addLinkText, { color: colors.tint }]}>
                      {toothPickerKey === r.key ? "Hide tooth chart" : "Select teeth on chart"}
                    </Text>
                  </Pressable>
                </View>
              )}
              <View style={isRemovable ? styles.restoColFull : styles.restoCol}>
                <Text style={styles.miniLabel}>Case Type</Text>
                <SuggestionInput
                  value={r.caseTypeKey ? CASE_TAXONOMY[r.caseTypeKey].label : ""}
                  onChangeText={(label) => {
                    const ct = _caseTypeKeyByLabel(label);
                    updateRestoration(r.key, {
                      caseTypeKey: ct,
                      subtypeKey: undefined,
                      materialSubtypeKey: undefined,
                      arch: ct && isArchRequired(ct) ? r.arch ?? null : null,
                      restorationType: "",
                      material: "",
                      restorationSubtype: undefined,
                      assignmentRole: undefined,
                    });
                  }}
                  suggestions={_CASE_TYPE_LABELS}
                  placeholder="Restorative"
                  placeholderTextColor={colors.textTertiary}
                  inputStyle={styles.input}
                  testID={`resto-category-${idx}`}
                />
              </View>
            </View>
              );
            })()}
            {r.caseTypeKey === "restorative" ? (
              <View style={{ gap: Spacing.xs }}>
                <Text style={styles.miniLabel}>Tooth role *</Text>
                <View style={styles.chipRow}>
                  {([
                    ["Crown", "Prepared crown"],
                    ["Pontic", "Pontic"],
                  ] as const).map(([role, label]) => (
                    <Pressable
                      key={role}
                      testID={`resto-role-${idx}-${role.toLowerCase()}`}
                      onPress={() => updateRestoration(r.key, { assignmentRole: role })}
                      style={[styles.chip, r.assignmentRole === role && styles.chipSelected]}
                    >
                      <Text style={[styles.chipText, r.assignmentRole === role && styles.chipTextSelected]}>
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {errors.assignmentRole && r.toothNumber.trim() && !r.assignmentRole ? (
                  <Text style={styles.fieldError}>Choose crown or pontic for each assigned tooth.</Text>
                ) : null}
              </View>
            ) : null}
            <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
              <Pressable accessibilityRole="button" onPress={() => {
                captureAssignmentUndo();
                setRestorations((previous) => [...previous, { ...r, key: blankRestoration().key, toothNumber: "" }]);
              }} style={{ minHeight: 44, justifyContent: "center" }}>
                <Text style={{ color: colors.tint, fontSize: 13 }}>Copy values to new row</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={!assignmentUndo || createCase.isPending}
                accessibilityState={{ disabled: !assignmentUndo || createCase.isPending }}
                onPress={() => {
                  if (!assignmentUndo) return;
                  setRestorations(assignmentUndo.rows);
                  setDraftConnectors(assignmentUndo.connectors);
                  setAssignmentUndo(null);
                }} style={{ minHeight: 44, justifyContent: "center", opacity: assignmentUndo && !createCase.isPending ? 1 : 0.4 }}>
                <Text style={{ color: colors.tint, fontSize: 13 }}>Undo draft edit</Text>
              </Pressable>
            </View>
            {toothPickerKey === r.key &&
            r.caseTypeKey !== "removable" &&
            !isRemovableRestorationType(r.restorationType) ? (
              <ToothChart
                readOnly={false}
                selected={parseChartTeeth(r.toothNumber)}
                crownTeeth={new Set(previewRestorations.filter((unit) => unit.restorationType === "Crown").map((unit) => unit.toothNumber))}
                ponticTeeth={new Set(previewRestorations.filter((unit) => unit.restorationType === "Pontic").map((unit) => unit.toothNumber))}
                connectedPairs={draftConnectorState.active}
                connectorSuggestions={draftConnectorState.suggested}
                onConnectedPairsChange={(pairs) => {
                  captureAssignmentUndo();
                  setDraftConnectors(updateConnectorChoices(draftConnectorState, pairs));
                }}
                connectorIssue={!draftConnectorValidation.valid ? draftConnectorValidation.errors[0] : draftAssignmentSummary.unresolvedPontics.length ? "Review unconnected pontics before saving." : null}
                summaryText={`${draftAssignmentSummary.units} units · ${draftAssignmentSummary.groups.length} connected groups · Unsaved draft`}
                onToothClick={(toothId) => {
                  const owner = restorations.find((row) => row.key !== r.key && parseChartTeeth(row.toothNumber).has(toothId));
                  if (owner) {
                    Alert.alert("Tooth already assigned", `Edit its existing row instead of adding a duplicate assignment for #${toothId}.`);
                    return;
                  }
                  const selected = parseChartTeeth(r.toothNumber);
                  if (selected.has(toothId)) selected.delete(toothId);
                  else selected.add(toothId);
                  updateRestoration(r.key, { toothNumber: formatChartTeeth(selected) });
                }}
              />
            ) : null}
            {r.caseTypeKey && isArchRequired(r.caseTypeKey) ? (
              <View style={styles.restoGrid}>
                <View style={styles.restoColFull}>
                  <Text style={styles.miniLabel}>Arch *</Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {ARCH_OPTIONS.map((option) => (
                      <Pressable
                        key={option.value}
                        testID={`resto-arch-${idx}-${option.value}`}
                        onPress={() => updateRestoration(r.key, { arch: option.value })}
                        style={[
                          styles.archOption,
                          r.arch === option.value && styles.archOptionSelected,
                        ]}
                      >
                        <Text
                          style={[
                            styles.archOptionText,
                            r.arch === option.value && styles.archOptionTextSelected,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  {!r.arch ? <Text style={styles.fieldError}>Select an arch.</Text> : null}
                </View>
              </View>
            ) : null}
            {/* Row 2: Type (level-2 subtype) + Material (level-3 materialSubtype) — shown once category is set */}
            {r.caseTypeKey ? (
              <View style={styles.restoGrid}>
                <View style={styles.restoCol}>
                  <Text style={styles.miniLabel}>Type</Text>
                  <SuggestionInput
                    value={
                      r.subtypeKey
                        ? (pickerTree[r.caseTypeKey].find((s) => s.key === r.subtypeKey)?.label ?? "")
                        : ""
                    }
                    onChangeText={(label) => {
                      const st = pickerTree[r.caseTypeKey!].find((s) => s.label === label);
                      updateRestoration(r.key, {
                        subtypeKey: st?.key,
                        materialSubtypeKey: undefined,
                        restorationType: label,
                        material: "",
                        restorationSubtype: st
                          ? encodePickerSelection(r.caseTypeKey!, st)
                          : undefined,
                      });
                    }}
                    suggestions={pickerTree[r.caseTypeKey].map((s) => s.label)}
                    placeholder="Crown & Bridge"
                    placeholderTextColor={colors.textTertiary}
                    inputStyle={styles.input}
                    testID={`resto-type-${idx}`}
                  />
                </View>
                {isImplantRestoration(r) && <ImplantDetailsControls value={r} onChange={(details) => updateRestoration(r.key, details)} />}
                {(() => {
                  const subNode = r.subtypeKey
                    ? pickerTree[r.caseTypeKey!].find((s) => s.key === r.subtypeKey)
                    : undefined;
                  if (!subNode || subNode.materials.length === 0) return null;
                  return (
                  <View style={styles.restoCol}>
                    <Text style={styles.miniLabel}>Material</Text>
                    <SuggestionInput
                      value={
                        r.materialSubtypeKey
                          ? (subNode.materials.find((m) => m.key === r.materialSubtypeKey)?.label ?? "")
                          : ""
                      }
                      onChangeText={(label) => {
                        const ms = subNode.materials.find((m) => m.label === label);
                        updateRestoration(r.key, {
                          materialSubtypeKey: ms?.key,
                          material: label,
                          restorationSubtype: encodePickerSelection(
                            r.caseTypeKey!,
                            subNode,
                            ms ?? null,
                          ),
                        });
                      }}
                      suggestions={subNode.materials.map((m) => m.label)}
                      placeholder="Zirconia"
                      placeholderTextColor={colors.textTertiary}
                      inputStyle={styles.input}
                      testID={`resto-material-${idx}`}
                    />
                  </View>
                  );
                })()}
              </View>
            ) : null}
            {/* Row 3: Shade — always shown */}
            <View style={styles.restoGrid}>
              <View style={styles.restoColFull}>
                <Text style={styles.miniLabel}>Shade</Text>
                <TextInput
                  style={styles.input}
                  value={r.shade}
                  onChangeText={(t) => updateRestoration(r.key, { shade: t })}
                  placeholder="A2"
                  placeholderTextColor={colors.textTertiary}
                  testID={`resto-shade-${idx}`}
                />
              </View>
            </View>
          </Card>
        ))}
        <Text style={styles.hint}>
          Crown/bridge restorations need a tooth number and type; removable
          types (denture, partial, flipper) only need a type. Blank rows are
          skipped.
        </Text>

        {/* Draft-invoice preview (read-only) */}
        {(previewLoading || previewError || (invoicePreview?.lineItems?.length ?? 0) > 0) ? (
          <Card style={styles.previewCard} testID="invoice-preview">
            <View style={styles.previewHeaderRow}>
              <Ionicons name="receipt-outline" size={15} color={colors.textSecondary} />
              <Text style={styles.previewTitle}>Invoice preview</Text>
              <Text style={styles.previewSub}>estimated — created with the case</Text>
            </View>
            {previewError ? (
              <Text style={styles.previewMuted}>
                Couldn't load the invoice preview. The draft invoice will still be
                generated when you create the case.
              </Text>
            ) : previewLoading && !invoicePreview ? (
              <Text style={styles.previewMuted} testID="invoice-preview-loading">
                Calculating…
              </Text>
            ) : (invoicePreview?.lineItems?.length ?? 0) === 0 ? (
              <Text style={styles.previewMuted}>No line items yet.</Text>
            ) : (
              <View style={[styles.previewBody, previewLoading && styles.previewBodyLoading]}>
                {editedLines !== null ? (
                  /* Editable invoice table with billable item picker */
                  <>
                    {editedLines.map((line) => {
                      const lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
                      const triggerLabel = line.isCustom
                        ? (line.description.trim() ? `Custom: ${line.description.trim()}` : "Custom / manual")
                        : (line.description.trim() || "Select item…");
                      const hasSelection = line.isCustom || line.description.trim().length > 0;
                      return (
                        <View key={line.key} style={styles.editLineBlock}>
                          {/* Row 1: picker trigger + qty + price + remove */}
                          <View style={styles.editLineRow}>
                            <Pressable
                              style={styles.editLinePickerTrigger}
                              onPress={() => setPickerOpenForKey(line.key)}
                              testID={`invoice-preview-line-picker-${line.key}`}
                            >
                              <Text
                                style={[
                                  styles.editLinePickerTriggerText,
                                  !hasSelection && styles.editLinePickerPlaceholder,
                                ]}
                                numberOfLines={1}
                              >
                                {triggerLabel}
                              </Text>
                              <Ionicons name="chevron-down" size={12} color={colors.textTertiary} />
                            </Pressable>
                            <TextInput
                              style={styles.editLineQtyInput}
                              value={line.qty}
                              onChangeText={(t) =>
                                setEditedLines((prev) =>
                                  prev?.map((l) => l.key === line.key ? { ...l, qty: t } : l) ?? prev
                                )
                              }
                              keyboardType="number-pad"
                              placeholder="1"
                              placeholderTextColor={colors.textTertiary}
                              testID={`invoice-preview-line-qty-${line.key}`}
                            />
                            <View style={styles.editLinePriceWrap}>
                              <Text style={styles.editLineDollar}>$</Text>
                              <TextInput
                                style={styles.editLinePriceInput}
                                value={line.unitPrice}
                                onChangeText={(t) =>
                                  setEditedLines((prev) =>
                                    prev?.map((l) => l.key === line.key ? { ...l, unitPrice: t } : l) ?? prev
                                  )
                                }
                                keyboardType="decimal-pad"
                                placeholder="0.00"
                                placeholderTextColor={colors.textTertiary}
                                testID={`invoice-preview-line-price-${line.key}`}
                              />
                            </View>
                            <Text style={styles.previewLineAmount}>${lineTotal.toFixed(2)}</Text>
                            <Pressable
                              onPress={() =>
                                setEditedLines((prev) => prev?.filter((l) => l.key !== line.key) ?? prev)
                              }
                              hitSlop={8}
                              testID={`invoice-preview-line-remove-${line.key}`}
                            >
                              <Text style={styles.editLineRemoveBtnText}>×</Text>
                            </Pressable>
                          </View>
                          {/* Row 2: custom description text input (shown for custom mode) */}
                          {line.isCustom && (
                            <TextInput
                              style={styles.editLineDescInput}
                              value={line.description}
                              onChangeText={(t) =>
                                setEditedLines((prev) =>
                                  prev?.map((l) => l.key === line.key ? { ...l, description: t } : l) ?? prev
                                )
                              }
                              placeholder="Enter description…"
                              placeholderTextColor={colors.textTertiary}
                              autoCorrect={true}
                              spellCheck={true}
                              autoCapitalize="sentences"
                              testID={`invoice-preview-line-custom-description-${line.key}`}
                            />
                          )}
                          {/* Billable item picker modal for this line */}
                          <BillableItemPicker
                            visible={pickerOpenForKey === line.key}
                            items={billableItems}
                            isLoading={billableItemsQuery.isLoading}
                            isError={billableItemsQuery.isError}
                            onRetry={() => void billableItemsQuery.refetch()}
                            onClose={() => setPickerOpenForKey(null)}
                            onSelect={(result) => {
                              setPickerOpenForKey(null);
                              setEditedLines((prev) =>
                                prev?.map((l) => {
                                  if (l.key !== line.key) return l;
                                  if (result.isCustom) {
                                    return {
                                      ...l,
                                      isCustom: true,
                                      catalogItemId: null,
                                      catalogItemKey: null,
                                    };
                                  }
                                  return {
                                    ...l,
                                    isCustom: false,
                                    catalogItemId: result.itemId,
                                    catalogItemKey: result.priceKey,
                                    description: result.label,
                                    unitPrice: result.unitPrice ?? l.unitPrice,
                                  };
                                }) ?? prev
                              );
                            }}
                          />
                        </View>
                      );
                    })}
                    <Pressable
                      onPress={() =>
                        setEditedLines((prev) => [
                          ...(prev ?? []),
                          {
                            key: `custom-${Date.now()}`,
                            description: "",
                            qty: "1",
                            unitPrice: "0.00",
                            isCustom: false,
                            catalogItemId: null,
                            catalogItemKey: null,
                          },
                        ])
                      }
                      style={styles.editAddLineBtn}
                      testID="invoice-preview-add-line"
                    >
                      <Text style={styles.editAddLineBtnText}>+ Add line</Text>
                    </Pressable>
                    <View style={styles.previewTotalRow}>
                      <Text style={styles.previewTotalLabel}>Total</Text>
                      <Text style={styles.previewTotalValue}>
                        ${editedLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0).toFixed(2)}
                      </Text>
                    </View>
                  </>
                ) : (
                  /* Non-admin: read-only preview */
                  <>
                    {invoicePreview!.lineItems!.map((li, idx) => {
                      const qty = li.quantity ?? 1;
                      const unitPrice = li.unitPrice ?? "0.00";
                      const notPriced = li.priced === false;
                      return (
                        <View key={idx} style={styles.previewLineRow} testID={`invoice-preview-line-${idx}`}>
                          <Text style={styles.previewLineDesc} numberOfLines={2}>
                            {li.toothLabel ? (
                              <Text style={styles.previewLineTooth}>{li.toothLabel} </Text>
                            ) : null}
                            {li.description}
                          </Text>
                          <Text style={styles.previewLineQty}>
                            {qty} × ${unitPrice}
                          </Text>
                          {notPriced ? (
                            <Text style={[styles.previewLineAmount, styles.previewNotPriced]} testID={`invoice-preview-notpriced-${idx}`}>
                              not priced
                            </Text>
                          ) : (
                            <Text style={styles.previewLineAmount}>
                              ${li.lineTotal ?? "0.00"}
                            </Text>
                          )}
                        </View>
                      );
                    })}
                    <View style={styles.previewTotalRow}>
                      <Text style={styles.previewTotalLabel}>Total</Text>
                      <Text style={styles.previewTotalValue} testID="invoice-preview-total">
                        ${invoicePreview!.total ?? "0.00"}
                      </Text>
                    </View>
                  </>
                )}
              </View>
            )}
          </Card>
        ) : null}

        </Card>

        <Card style={styles.formSection} testID="new-case-schedule-section">
          <SectionHeading
            icon="calendar-outline"
            title="Schedule & Priority"
            styles={styles}
            colors={colors}
          />
          <View style={styles.scheduleDateRow}>
        {/* Date received */}
        <View style={styles.scheduleField}>
          <Field label="Date Received" styles={styles}>
            <DateField
              value={receivedAt}
              onChange={setReceivedAt}
              placeholder="Select the received date"
              testID="new-case-received-date"
            />
          </Field>
        </View>

        {/* Due date */}
        <View style={styles.scheduleField}>
          <Field label="Due Date" styles={styles}>
            <DateField
              value={dueDate}
              allowTyping
              onChange={(v) => {
                const capped = applyDueDateCap(v);
                setDueDate(capped);
                // A due time only makes sense paired with a due date — the API
                // rejects a time with no date, so drop it here too.
                if (!capped) {
                  setDueTime("");
                  setDueTimeEnabled(false);
                }
              }}
              placeholder="Select a due date"
              testID="new-case-due-date"
            />
            {dueDateCapped && (
              <Text style={{ fontSize: 11, color: "#d97706", marginTop: 4 }}>
                Capped to lab's turnaround ({(labs.find((m) => m.organizationId === selectedLabId)?.organization?.defaultCaseDueDays as number | null | undefined) ?? "?"}d)
              </Text>
            )}
          </Field>
        </View>
          </View>

        {/* Due time — explicitly opt in after choosing a due date */}
        {dueDate ? (
          <View style={styles.dueTimeSection}>
            <Pressable
              style={styles.checkboxRow}
              onPress={() => {
                const next = !dueTimeEnabled;
                setDueTimeEnabled(next);
                if (!next) setDueTime("");
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: dueTimeEnabled }}
              testID="new-case-due-time-toggle"
            >
              <View style={[styles.checkbox, dueTimeEnabled && styles.checkboxChecked]}>
                {dueTimeEnabled ? <Ionicons name="checkmark" size={15} color={colors.textInverse} /> : null}
              </View>
              <Text style={styles.checkboxLabel}>Set a specific time the case is due</Text>
            </Pressable>
            {dueTimeEnabled ? (
              <Field label="Due Time" styles={styles}>
                <TimeField
                  value={dueTime}
                  onChange={setDueTime}
                  placeholder="Select a due time"
                  testID="new-case-due-time"
                />
              </Field>
            ) : null}
          </View>
        ) : null}

        {/* Priority */}
        <Field label="Priority" styles={styles}>
          <View style={styles.prioritySegment}>
            {(["normal", "rush"] as const).map((p) => {
              const selected = priority === p;
              return (
                <Pressable
                  key={p}
                  onPress={() => setPriority(p)}
                  style={[styles.priorityOption, selected && styles.priorityOptionSelected]}
                  testID={`priority-${p}`}
                >
                  {p === "rush" ? (
                    <Ionicons
                      name="flash"
                      size={16}
                      color={selected ? colors.tint : colors.warning}
                    />
                  ) : null}
                  <Text style={[styles.priorityOptionText, selected && styles.priorityOptionTextSelected]}>
                    {p === "rush" ? "Rush" : "Normal"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>
        </Card>

        <Card style={styles.formSection} testID="new-case-details-section">
          <SectionHeading
            icon="document-text-outline"
            title="Case Details"
            styles={styles}
            colors={colors}
          />
        {/* Notes */}
        <Field label="Notes" styles={styles}>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional notes shared with the provider"
            placeholderTextColor={colors.textTertiary}
            multiline
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            textAlignVertical="top"
            testID="new-case-notes"
          />
        </Field>

        {/* Pan Barcode */}
        <Field label="Pan Barcode" styles={styles}>
          <TextInput
            style={styles.input}
            value={casePanBarcode}
            onChangeText={setCasePanBarcode}
            placeholder="Scan or type barcode… (optional)"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
            testID="new-case-barcode"
          />
          {barcodeChecking && (
            <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>
              Checking barcode…
            </Text>
          )}
          {!barcodeChecking && barcodeConflict && (
            <Text style={{ fontSize: 11, color: "#d97706", marginTop: 4 }}>
              {`⚠ This barcode is already used by an active case${barcodeConflict.caseNumber ? ` (Case #${barcodeConflict.caseNumber})` : ""}.`}
            </Text>
          )}
        </Field>

        {/* ── Remake section ───────────────────────────────────────────── */}
        <View style={styles.remakePanel}>
          <Pressable
            style={styles.remakeToggleRow}
            testID="new-case-remake-toggle"
            onPress={() => {
              const next = !isRemake;
              setIsRemake(next);
              if (!next) {
                setRemakeSelected(null);
                setRemakeSearch("");
                setRemakeReasonKey("");
                setRemakeCustomReason("");
                setRemakeShadeLightness(null);
                setRemakeShadePrescribed("");
                setRemakeShadeProvided("");
                setRemakeMaterialPrescribed("");
                setRemakeMaterialProvided("");
                setRemakeReturnedToLab(null);
                setRemakeCharged(null);
                setRemakeNotes("");
              }
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: Spacing.sm }}>
              <Ionicons
                name={isRemake ? "return-up-back" : "return-up-back-outline"}
                size={16}
                color={isRemake ? colors.tint : colors.textTertiary}
              />
              <Text style={[Typography.body, { color: isRemake ? colors.tint : colors.textTertiary }]}>
                This is a remake
              </Text>
            </View>
            <View style={[styles.remakeSwitch, isRemake && styles.remakeSwitchOn]}>
              <View style={[styles.remakeThumb, isRemake && styles.remakeThumbOn]} />
            </View>
          </Pressable>

          {isRemake && (
            <View style={{ paddingTop: Spacing.md, gap: Spacing.sm }}>
              {remakeSelected ? (
                <View style={styles.remakeSelectedRow}>
                  <Text style={[Typography.bodySemibold, { color: colors.text, flex: 1 }]}>
                    {`#${remakeSelected.caseNumber ?? "—"} · ${remakeSelected.patientFirstName ?? ""} ${remakeSelected.patientLastName ?? ""}`}
                  </Text>
                  <Pressable
                    hitSlop={8}
                    onPress={() => {
                      setRemakeSelected(null);
                      setRemakeSearch("");
                    }}
                  >
                    <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                  </Pressable>
                </View>
              ) : (
                <View style={{ gap: Spacing.xs }}>
                  <Text style={styles.miniLabel}>Search for original case</Text>
                  <TextInput
                    style={styles.input}
                    value={remakeSearch}
                    onChangeText={setRemakeSearch}
                    placeholder="Case number or patient name…"
                    placeholderTextColor={colors.textTertiary}
                    autoCorrect={false}
                    returnKeyType="search"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    testID="remake-search"
                  />
                  {remakeHits.length > 0 && (
                    <View style={styles.remakeHitList}>
                      {remakeHits.map((h) => (
                        <Pressable
                          key={h.id}
                          style={styles.remakeHitRow}
                          onPress={() => {
                            setRemakeSelected({
                              id: h.id,
                              caseNumber: h.caseNumber ?? null,
                              patientFirstName: h.patientFirstName ?? null,
                              patientLastName: h.patientLastName ?? null,
                            });
                            setRemakeSearch("");
                          }}
                        >
                          <Text style={[Typography.body, { color: colors.text }]}>
                            {`#${h.caseNumber ?? "—"} · ${h.patientFirstName ?? ""} ${h.patientLastName ?? ""}`}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              )}

              {remakeSelected && (
                <View style={{ gap: Spacing.sm }}>
                  <Text style={styles.miniLabel}>Remake reason *</Text>

                  <Text style={styles.remakeQGroupLabel}>Crown &amp; Bridge</Text>
                  {NEW_CASE_REMAKE_REASONS.filter((r) => r.category === "crown_bridge").map((r) => (
                    <Pressable
                      key={r.key}
                      testID={`new-case-remake-reason-${r.key}`}
                      style={[
                        styles.remakeReasonRow,
                        remakeReasonKey === r.key && { backgroundColor: colors.tint + "22" },
                      ]}
                      onPress={() => selectRemakeReason(r.key)}
                    >
                      <Text style={[Typography.body, { color: colors.text, flex: 1 }]}>{r.label}</Text>
                      {remakeReasonKey === r.key && (
                        <Ionicons name="checkmark-circle" size={16} color={colors.tint} />
                      )}
                    </Pressable>
                  ))}

                  <Text style={[styles.remakeQGroupLabel, { marginTop: 4 }]}>Removable</Text>
                  {NEW_CASE_REMAKE_REASONS.filter((r) => r.category === "removable").map((r) => (
                    <Pressable
                      key={r.key}
                      testID={`new-case-remake-reason-${r.key}`}
                      style={[
                        styles.remakeReasonRow,
                        remakeReasonKey === r.key && { backgroundColor: colors.tint + "22" },
                      ]}
                      onPress={() => selectRemakeReason(r.key)}
                    >
                      <Text style={[Typography.body, { color: colors.text, flex: 1 }]}>{r.label}</Text>
                      {remakeReasonKey === r.key && (
                        <Ionicons name="checkmark-circle" size={16} color={colors.tint} />
                      )}
                    </Pressable>
                  ))}

                  <Pressable
                    testID="new-case-remake-reason-other"
                    style={[
                      styles.remakeReasonRow,
                      remakeReasonKey === "other" && { backgroundColor: colors.tint + "22" },
                    ]}
                    onPress={() => {
                      selectRemakeReason("other");
                    }}
                  >
                    <Text style={[Typography.body, { color: colors.text, flex: 1 }]}>Other</Text>
                    {remakeReasonKey === "other" && (
                      <Ionicons name="checkmark-circle" size={16} color={colors.tint} />
                    )}
                  </Pressable>

                  {remakeReasonKey === "other" && (
                    <View style={{ gap: Spacing.xs }}>
                      <Text style={styles.miniLabel}>Custom remake reason *</Text>
                      <TextInput
                        testID="new-case-custom-remake-reason"
                        ref={remakeCustomReasonRef}
                        style={styles.input}
                        value={remakeCustomReason}
                        onChangeText={setRemakeCustomReason}
                        placeholder="Describe why this case is being remade"
                        placeholderTextColor={colors.textTertiary}
                        maxLength={CUSTOM_REMAKE_REASON_MAX_LENGTH}
                        multiline
                        autoFocus={remakeReasonKey === "other"}
                      />
                      {attemptedSubmit && !remakeCustomReason.trim() && (
                        <Text
                          accessibilityRole="alert"
                          accessibilityLiveRegion="polite"
                          style={styles.errorText}
                        >
                          Enter a custom remake reason.
                        </Text>
                      )}
                    </View>
                  )}

                  {NEW_CASE_SHADE_KEYS.has(remakeReasonKey) && (
                    <View style={{ gap: Spacing.xs }}>
                      <Text style={styles.miniLabel}>Shade — light or dark?</Text>
                      <View style={styles.chipRow}>
                        {(["light", "dark"] as const).map((v) => (
                          <Pressable
                            key={v}
                            style={[styles.chip, remakeShadeLightness === v && styles.chipSelected]}
                            onPress={() =>
                              setRemakeShadeLightness(remakeShadeLightness === v ? null : v)
                            }
                          >
                            <Text
                              style={[styles.chipText, remakeShadeLightness === v && styles.chipTextSelected]}
                            >
                              {v === "light" ? "Too light" : "Too dark"}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <View style={styles.restoGrid}>
                        <View style={styles.restoCol}>
                          <Text style={styles.miniLabel}>Prescribed</Text>
                          <TextInput
                            style={styles.input}
                            value={remakeShadePrescribed}
                            onChangeText={setRemakeShadePrescribed}
                            placeholder="e.g. A2"
                            placeholderTextColor={colors.textTertiary}
                          />
                        </View>
                        <View style={styles.restoCol}>
                          <Text style={styles.miniLabel}>Provided</Text>
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

                  {NEW_CASE_MATERIAL_KEYS.has(remakeReasonKey) && (
                    <View style={styles.restoGrid}>
                      <View style={styles.restoCol}>
                        <Text style={styles.miniLabel}>Material prescribed</Text>
                        <TextInput
                          style={styles.input}
                          value={remakeMaterialPrescribed}
                          onChangeText={setRemakeMaterialPrescribed}
                          placeholder="e.g. PFZ"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                      <View style={styles.restoCol}>
                        <Text style={styles.miniLabel}>Material provided</Text>
                        <TextInput
                          style={styles.input}
                          value={remakeMaterialProvided}
                          onChangeText={setRemakeMaterialProvided}
                          placeholder="e.g. Zirconia"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                    </View>
                  )}

                  <Text style={styles.miniLabel}>Returned to lab?</Text>
                  <View style={styles.chipRow}>
                    <Pressable
                      style={[styles.chip, remakeReturnedToLab === true && styles.chipSelected]}
                      onPress={() =>
                        setRemakeReturnedToLab(remakeReturnedToLab === true ? null : true)
                      }
                    >
                      <Text style={[styles.chipText, remakeReturnedToLab === true && styles.chipTextSelected]}>
                        Yes
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.chip, remakeReturnedToLab === false && styles.chipSelected]}
                      onPress={() =>
                        setRemakeReturnedToLab(remakeReturnedToLab === false ? null : false)
                      }
                    >
                      <Text style={[styles.chipText, remakeReturnedToLab === false && styles.chipTextSelected]}>
                        No
                      </Text>
                    </Pressable>
                  </View>

                  <Text style={styles.miniLabel}>Charge for this remake? *</Text>
                  <View style={styles.chipRow}>
                    <Pressable
                      style={[styles.chip, remakeCharged === true && styles.chipSelected]}
                      onPress={() => setRemakeCharged(remakeCharged === true ? null : true)}
                    >
                      <Text style={[styles.chipText, remakeCharged === true && styles.chipTextSelected]}>
                        Yes — invoice
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.chip, remakeCharged === false && styles.remakeNoChargeChip]}
                      onPress={() => setRemakeCharged(remakeCharged === false ? null : false)}
                    >
                      <Text style={[styles.chipText, remakeCharged === false && styles.remakeNoChargeTxt]}>
                        No charge
                      </Text>
                    </Pressable>
                  </View>

                  {isAdminForSelectedLab && (
                    <>
                      <Text style={styles.miniLabel}>Remake notes (optional)</Text>
                      <TextInput
                        style={[styles.input, { minHeight: 64, textAlignVertical: "top" }]}
                        value={remakeNotes}
                        onChangeText={setRemakeNotes}
                        placeholder="Technician instructions…"
                        placeholderTextColor={colors.textTertiary}
                        multiline
                        autoCorrect={true}
                        spellCheck={true}
                        autoCapitalize="sentences"
                        numberOfLines={3}
                      />
                    </>
                  )}

                  {attemptedSubmit && errors.remake && (
                    <Text style={styles.errorText}>
                      {!remakeReasonKey
                        ? "Select a remake reason."
                        : remakeCharged === null
                        ? "Choose whether to charge for this remake."
                         : remakeReasonKey === "other" && !remakeCustomReason.trim()
                         ? "Enter a custom remake reason."
                         : "Select the original case being remade."}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}
          </View>
        </Card>
      </KeyboardAwareScrollView>

      <KeyboardStickyView
        testID="new-case-sticky-footer"
        offset={{ closed: 0, opened: 0 }}
        style={styles.stickyFooter}
      >
        <View style={[styles.footerSurface, { paddingBottom: Math.max(insets.bottom, Spacing.sm) }]}>
          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityState={{ disabled: submitting, busy: submitting }}
            style={[styles.submitBtn, submitting && styles.saveBtnDisabled]}
            testID="new-case-save"
          >
            {submitting ? (
              <View style={styles.submitProgress}>
                <ActivityIndicator color={colors.textInverse} size="small" />
                <Text style={styles.submitBtnText}>Creating case…</Text>
              </View>
            ) : (
              <Text style={styles.submitBtnText}>Create Case</Text>
            )}
          </Pressable>
        </View>
      </KeyboardStickyView>

      <FormSheet
        visible={!!doctorConfirm}
        title="Is this the same doctor?"
        onClose={() => setDoctorConfirm(null)}
        onSubmit={handleKeepNewDoctor}
        submitting={submitting}
        submitLabel={`Create as new doctor`}
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
    </DismissKeyboardView>
  );
}

function Header({
  title,
  onBack,
  right,
  styles,
  colors,
}: {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn} testID="new-case-back">
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

function SectionHeading({
  icon,
  title,
  styles,
  colors,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionIconBadge}>
        <Ionicons name={icon} size={20} color={colors.tint} />
      </View>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function Field({
  label,
  required,
  children,
  styles,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  styles: Styles;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {children}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.sm },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: { padding: Spacing.xs },
    headerTitle: { ...Typography.h2, color: c.text, flex: 1 },
    headerRight: { minWidth: 64, alignItems: "flex-end" },
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
    saveBtn: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      minWidth: 72,
      alignItems: "center",
    },
    saveBtnDisabled: { opacity: 0.6 },
    saveBtnText: { ...Typography.bodySemibold, color: c.textInverse },
    scrollView: { flex: 1 },
    content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.lg, gap: Spacing.md },
    requiredNote: { flexDirection: "row", alignItems: "center", gap: 3, paddingLeft: Spacing.xs },
    requiredNoteText: { ...Typography.caption, color: c.textSecondary },
    formSection: { gap: Spacing.md, backgroundColor: c.surface },
    sectionHeading: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, flex: 1 },
    sectionIconBadge: {
      width: 34,
      height: 34,
      borderRadius: Radius.md,
      backgroundColor: c.tintLight,
      alignItems: "center",
      justifyContent: "center",
    },
    sectionTitle: { ...Typography.h3, color: c.text, flex: 1 },
    nameFieldsRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    nameField: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
    field: { gap: Spacing.xs },
    scheduleDateRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.md },
    scheduleField: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
    dueTimeSection: { gap: Spacing.sm },
    checkboxRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: Radius.xs,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
    },
    checkboxChecked: { backgroundColor: c.tint, borderColor: c.tint },
    checkboxLabel: { ...Typography.body, color: c.text, flex: 1 },
    label: { ...Typography.captionSemibold, color: c.textSecondary },
    required: { color: c.error },
    staticValue: { ...Typography.body, color: c.text, paddingVertical: Spacing.sm },
    input: {
      ...Typography.body,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    inputError: { borderColor: c.error },
    textArea: { minHeight: 90 },
    inlineRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    inlineInput: { flex: 1 },
    iconBtn: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    chip: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipSelected: { backgroundColor: c.tint, borderColor: c.tint },
    chipText: { ...Typography.bodyMedium, color: c.textSecondary },
    chipTextSelected: { color: c.textInverse },
    selectedDoctorRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, marginTop: Spacing.xs },
    selectedDoctorText: { ...Typography.caption, color: c.success, flex: 1 },
    dropdown: {
      marginTop: Spacing.xs,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      overflow: "hidden",
    },
    dropdownLoading: { padding: Spacing.md, alignItems: "center" },
    dropdownEmpty: { ...Typography.caption, color: c.textTertiary, padding: Spacing.md },
    dropdownItem: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderLight },
    dropdownItemName: { ...Typography.bodyMedium, color: c.text },
    dropdownItemSub: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    sectionHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    sectionHeader: { ...Typography.h3, color: c.text },
    addLink: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    addLinkText: { ...Typography.bodySemibold, color: c.tint },
    restoCard: { gap: Spacing.sm, backgroundColor: c.surfaceAlt, borderColor: c.borderLight },
    restoHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    restoIndex: { ...Typography.captionSemibold, color: c.textSecondary },
    restoGrid: { flexDirection: "row", gap: Spacing.sm },
    restoCol: { flex: 1, gap: Spacing.xs },
    restoColFull: { flex: 2, gap: Spacing.xs },
    archOption: {
      flex: 1,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.xs,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
    },
    archOptionSelected: { backgroundColor: c.tint, borderColor: c.tint },
    archOptionText: { ...Typography.caption, color: c.textSecondary },
    archOptionTextSelected: { color: c.textInverse },
    fieldError: { ...Typography.caption, color: c.error },
    miniLabel: { ...Typography.caption, color: c.textTertiary },
    hint: { ...Typography.caption, color: c.textTertiary },
    previewCard: { gap: Spacing.sm, backgroundColor: c.surfaceAlt },
    previewHeaderRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, flexWrap: "wrap" },
    previewTitle: { ...Typography.captionSemibold, color: c.text },
    previewSub: { ...Typography.caption, color: c.textTertiary },
    previewMuted: { ...Typography.caption, color: c.textSecondary },
    previewBody: { gap: Spacing.xs },
    previewBodyLoading: { opacity: 0.6 },
    previewLineRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
    previewLineDesc: { ...Typography.caption, color: c.text, flex: 1 },
    previewLineTooth: { ...Typography.caption, color: c.textSecondary },
    previewLineQty: { ...Typography.caption, color: c.textSecondary, fontVariant: ["tabular-nums"] },
    previewLineAmount: { ...Typography.caption, color: c.text, minWidth: 64, textAlign: "right", fontVariant: ["tabular-nums"] },
    previewNotPriced: { color: c.warning },
    previewTotalRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.xs,
      marginTop: Spacing.xs,
    },
    previewTotalLabel: { ...Typography.captionSemibold, color: c.text },
    previewTotalValue: { ...Typography.captionSemibold, color: c.text, fontVariant: ["tabular-nums"] },
    editLineBlock: { gap: 4 },
    editLineRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    editLinePickerTrigger: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 4,
      minHeight: 28,
      gap: 2,
    },
    editLinePickerTriggerText: {
      ...Typography.caption,
      color: c.text,
      flex: 1,
    },
    editLinePickerPlaceholder: { color: c.textTertiary },
    editLineDescInput: {
      ...Typography.caption,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 4,
      minHeight: 28,
    },
    editLineQtyInput: {
      width: 36,
      ...Typography.caption,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: 4,
      paddingVertical: 4,
      textAlign: "center",
      minHeight: 28,
    },
    editLinePriceWrap: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      backgroundColor: c.surface,
      paddingLeft: 4,
    },
    editLineDollar: { ...Typography.caption, color: c.textSecondary },
    editLinePriceInput: {
      width: 52,
      ...Typography.caption,
      color: c.text,
      paddingHorizontal: 2,
      paddingVertical: 4,
      textAlign: "right",
      fontVariant: ["tabular-nums"],
      minHeight: 28,
    },
    editLineRemoveBtnText: { ...Typography.h3, color: c.textTertiary, paddingHorizontal: 2 },
    editAddLineBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderStyle: "dashed",
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingVertical: Spacing.xs,
      alignItems: "center",
    },
    editAddLineBtnText: { ...Typography.caption, color: c.textSecondary },
    errorText: { ...Typography.caption, color: c.error, marginTop: Spacing.xs },
    prioritySegment: {
      flexDirection: "row",
      gap: Spacing.xs,
      padding: 3,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    priorityOption: {
      flex: 1,
      minHeight: 44,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.sm,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
    },
    priorityOptionSelected: { backgroundColor: c.tintLight },
    priorityOptionText: { ...Typography.bodySemibold, color: c.textSecondary },
    priorityOptionTextSelected: { color: c.tint },
    stickyFooter: { zIndex: 2 },
    footerSurface: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    submitBtn: {
      minHeight: 52,
      paddingVertical: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      alignItems: "center",
      justifyContent: "center",
    },
    submitProgress: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    submitBtnText: { ...Typography.h3, color: c.textInverse },
    remakePanel: {
      gap: Spacing.md,
      padding: Spacing.md,
      borderRadius: Radius.lg,
      backgroundColor: c.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    emptyTitle: { ...Typography.h3, color: c.text },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },

    // ── Remake section ────────────────────────────────────────────────────────
    remakeToggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    remakeSwitch: {
      width: 36,
      height: 20,
      borderRadius: 10,
      backgroundColor: c.border,
      padding: 2,
      justifyContent: "center",
    },
    remakeSwitchOn: { backgroundColor: c.tint },
    remakeThumb: {
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: "#fff",
    },
    remakeThumbOn: { alignSelf: "flex-end" },
    remakeSelectedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      backgroundColor: c.surface,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    remakeHitList: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      overflow: "hidden",
    },
    remakeHitRow: {
      padding: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    remakeQGroupLabel: {
      ...Typography.caption,
      color: c.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      fontWeight: "600",
    },
    remakeReasonRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.sm,
      gap: Spacing.sm,
    },
    remakeNoChargeChip: {
      backgroundColor: "#92400e22",
      borderColor: "#92400e",
    },
    remakeNoChargeTxt: { color: "#92400e" },
  });
}
