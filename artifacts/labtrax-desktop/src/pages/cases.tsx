import { formatRxNoteScanDate, IMPLANT_FIELDS, isImplantRestoration, sameClinicalHierarchy, type ImplantDetails } from "@workspace/case-taxonomy";
import { ImplantDetailsControls, SavedImplantDetails } from "@/components/ImplantDetailsControls";
import { invalidToothAssignmentTokens, expandToothAssignmentIdentifiers, toothBridgeLabels } from "@workspace/case-taxonomy";
import { archSelectionTeeth, catalogToothMaterialOptions, indicationCatalogContext, isToothIndication, selectedToothArch } from "@workspace/case-taxonomy";
import { useGetCatalogTree, getGetCatalogTreeQueryKey } from "@workspace/api-client-react";
import { isValidCalendarDate } from "@workspace/calendar-date";
import { CaseRangeWindow } from "@/components/CaseRangeWindow";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useAiPanel } from "@/lib/ai-panel-context";
import { useTableColumns, type ColumnDef } from "@/hooks/useTableColumns";
import { useDockedDrawerHeight } from "@/hooks/useDockedDrawerHeight";
import { ColumnSettingsPopover } from "@/components/ColumnSettingsPopover";
import { FilteredSalesTotal } from "@/components/ColumnTotal";
import { MultiSelectFilter } from "@/components/MultiSelectFilter";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toast as notifyDoctorChange } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Barcode,
  Bookmark,
  Box,
  CalendarDays,
  Check,
  Clock,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileUp,
  Filter,
  FilterX,
  GitBranch,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Lock,
  Mic,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Printer,
  RefreshCw,
  QrCode,
  ReceiptText,
  Search,
  ScrollText,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Video,
  X,
  Zap,
} from "lucide-react";
import QRCodeSVG from "react-qr-code";
import { apiFetch, ApiError, getAccessToken, getApiOrigin } from "@/lib/api";
import { refreshCaseFinanceQueries } from "@/lib/refresh-case-finance";
import { uploadMediaFile } from "@/lib/upload-media-file";
import { composeNoteDictation } from "@/lib/note-dictation";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "@/lib/shift-click-range";
import { DoctorNamePicker } from "@/components/DoctorNamePicker";
import { CaseEditActionBar } from "@/components/CaseEditActionBar";
import { FieldCombobox } from "@/components/FieldCombobox";
import {
  CatalogRestorationPicker,
  encodeCatalogSelection,
  getCatalogMaterialsForRestoration,
  useEffectiveCatalog,
} from "@/components/CatalogRestorationPicker";
import { CaseDoctorReassignDialog } from "@/components/CaseDoctorReassignDialog";
import {
  REMAKE_REASONS,
  type RemakeReasonKey,
  type RemakeQuestionnaireValue,
  blankQuestionnaire,
  buildRemakeLinkPayload,
  remakeQuestionnaireError,
  isRemakeQuestionnaireComplete,
  RemakeQuestionnaire,
  type RemakeDecision,
  type RemakeCaseHit,
  RemakeOriginalPicker,
} from "@/components/remake-questionnaire";
import { useCasesOverview } from "@workspace/api-client-react";
import type { CaseSavedView, CaseSavedViewFilters } from "@workspace/api-client-react";
import { CASE_STATUS_GROUPS } from "@workspace/case-taxonomy";
import {
  registerNavBlocker,
  guardNavigation,
  hasNavigationBlockers,
} from "@/lib/nav-guard";
import {
  buildRestorationUpdateBody,
} from "@/lib/restoration-update";
import { isRemovableRestorationType } from "@/lib/restoration-category";
import {
  computeCaseDateRange,
  caseWithinDateRange,
  type DateRangeFilter as CaseDateRangeFilter,
} from "@/lib/case-date-filter";
import {
  AuthedImage,
  AuthedVideo,
  MediaLightbox,
  isSameApiOrigin,
  type Lightbox,
  type LightboxItem,
} from "@/components/AuthedMedia";
import { classifyMediaKind } from "@/lib/media-kind";
import {
  CASE_ACTION_BUTTON_CLASS,
  CaseExceptionAction,
} from "@/components/CaseExceptionAction";
import type {
  CaseAttachment,
  CaseEvent,
  CaseExceptionSummary,
  CaseRestoration,
  CaseStatus,
  DoctorMatchCandidate,
  Invoice,
  LabCase,
  MeResponse,
  Organization,
  PatientSimilarityHit,
  PricingHistoryEntry,
  PricingOverride,
  PricingTier,
  RestorationPriceSource,
} from "@/lib/types";
import {
  attachmentSectionPreferenceKey,
  buildAttachmentSectionPreference,
  COLLAPSED_ATTACHMENT_SECTIONS,
  groupCaseAttachments,
  parseAttachmentSectionPreference,
  type AttachmentSectionId,
  type AttachmentSectionPreference,
} from "@/lib/attachment-sections";
import { compareDueDateTime, formatDate, formatDateTime, formatDueDate, formatHistoryDay, formatHistoryTime, formatShortDueDate, formatMoney, formatPhone, formatShortDate, relativeTime, statusLabel } from "@/lib/format";
import { historyEventCaseId } from "@/lib/history-event-case";
import {
  printCaseCard,
  printCaseCardAdvanced,
  printCaseHistory,
  printCaseLabel,
  printCaseOverview,
  printInvoice,
  printTabContent,
} from "@/lib/print";
import QRCodeLib from "qrcode";
import { useAuth } from "@/lib/auth-context";
import { printInvoicePdf, type InvoicePdfOptions } from "@/lib/export";
import {
  ToothChart,
  parseToothField,
} from "@/components/ToothChart";
import { CaseChartPanes, CaseDetailsList, RestorationSummaryPane } from "@/components/CaseChartPanes";
import {
  buildHighlightedToothValue,
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
  formatRxToothNumbers,
} from "@/lib/rx-summary";
import { resolvePracticeContact } from "@/lib/practice-contact";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceEditor, InlineInvoiceEditor } from "./invoices";
import { useInvoiceTemplate } from "@/lib/use-invoice-template";
import {
  ToothActionDialog,
  type ToothActionPayload,
} from "@/components/ToothActionDialog";
import ScanViewerModal from "@/components/ScanViewerModal";
import ScanThumbnail from "@/components/ScanThumbnail";
import type { ScanFormat } from "@workspace/scan-viewer";
import { PrintLayoutEditor } from "@/components/PrintLayoutEditor";
import { CasePrintLayoutEditor } from "@/components/CasePrintLayoutEditor";
import { PrescriptionPreview } from "@/components/PrescriptionPreview";
import {
  type PrintLayoutConfig,
  isDefaultLayout,
  loadPrintLayoutConfig,
} from "@/lib/print-layout";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  type CasePrintTemplate,
} from "@/lib/case-print-template";
import { TrialBanner } from "@/components/TrialBanner";
import { SelectedCasePrintActions } from "@/components/SelectedCasePrintActions";
import {
  deriveCaseHierarchy,
  hierarchyToCaseCategory,
  encodeRestorationSubtype,
  getSubtypeLabel,
  getMaterialSubtypeLabel,
  CASE_TAXONOMY,
  CASE_TYPES,
  type CaseType,
  type CaseSubtype,
  type MaterialSubtype,
  type CaseHierarchy,
  parseConnectorState,
  serializeConnectorState,
  suggestPonticConnectorPairs,
  toothAssignmentSummary,
  copyToothAssignment,
  type ToothAssignmentUnit,
  incompatibleToothConnectorPairs,
  withPonticConnectorSuggestions,
  updateConnectorChoices,
  validateToothConnectors,
} from "@workspace/case-taxonomy";

// Canonical representative restorationType for each top-level case type,
// used when an admin changes the Case Type via the inline dropdown.
const CASE_TYPE_REPRESENTATIVE: Record<CaseType, string> = {
  restorative: "Crown",
  removable: "Full Denture",
  ortho: "Night Guard",
};

/**
 * Cascading Case Type → Sub Type → Material inline dropdowns.
 * Admins/owners can change all three; patching any level updates every
 * restoration and re-syncs invoice pricing.
 */
export function CaseHierarchySelect({
  hierarchy,
  caseId,
  firstRestorationId,
  labOrganizationId,
  archValues,
  showFieldLabels = false,
}: {
  hierarchy: CaseHierarchy;
  caseId: string;
  firstRestorationId?: string;
  labOrganizationId: string | null | undefined;
  archValues?: Array<"upper" | "lower" | null | undefined>;
  showFieldLabels?: boolean;
}) {
  const qc = useQueryClient();
  const { data: catalog } = useEffectiveCatalog(labOrganizationId ?? undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCaseType, setPendingCaseType] = useState<CaseType | null>(null);
  const [pendingArch, setPendingArch] = useState<BillableArch | "">("");
  const applicableArch = hierarchy.caseType === "removable" || hierarchy.caseType === "ortho";
  const currentArch = archValues?.includes("upper") && archValues?.includes("lower")
    ? "both"
    : archValues?.includes("upper")
      ? "upper"
      : archValues?.includes("lower")
        ? "lower"
        : "";

  const caseTypes = catalog?.caseTypes ?? [];
  const selectedCtKey = hierarchy.caseType ?? "";
  const selectedCtNode = caseTypes.find((n) => n.key === selectedCtKey);
  const subtypeKey =
    hierarchy.subtype ??
    (hierarchy.customSubtypeId ? `custom:${hierarchy.customSubtypeId}` : "");
  const subtypes = selectedCtNode?.subtypes ?? [];
  const selectedStNode = subtypes.find((n) => n.key === subtypeKey);
  const materials = selectedStNode?.materials ?? [];
  const materialKey =
    hierarchy.materialSubtype ??
    (hierarchy.customMaterialSubtypeId
      ? `custom:${hierarchy.customMaterialSubtypeId}`
      : "");

  async function refreshCaseAndInvoiceViews() {
    await Promise.allSettled([
      qc.invalidateQueries({ queryKey: ["case", caseId] }),
      qc.invalidateQueries({ queryKey: ["cases"] }),
      qc.invalidateQueries({ queryKey: ["invoices"] }),
      qc.invalidateQueries({ queryKey: ["invoice-for-case", caseId] }),
      qc.invalidateQueries({ queryKey: ["invoice-detail", caseId] }),
    ]);
  }

  async function patchRestoration(body: Record<string, string | null>) {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/cases/${caseId}/restorations/hierarchy`, {
        method: "PATCH",
        body: JSON.stringify({
          ...body,
          ...(!firstRestorationId ? { toothNumbers: [] } : {}),
        }),
      });
      await refreshCaseAndInvoiceViews();
      return true;
    } catch (err: unknown) {
      // The server may have committed all restoration rows before a later
      // invoice synchronization step failed. Reconcile both views on every
      // error so the user sees the actual persisted state before retrying.
      await refreshCaseAndInvoiceViews();
      setError(err instanceof Error ? err.message : "Could not update case.");
      toast.error(err instanceof Error ? err.message : "Could not update case.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function onCaseTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newCt = e.target.value as CaseType;
    setError(null);
    if (!applicableArch && (newCt === "removable" || newCt === "ortho")) {
      setPendingCaseType(newCt);
      setPendingArch("");
      return;
    }

    setPendingCaseType(null);
    setPendingArch("");
    patchRestoration({
      restorationType: CASE_TYPE_REPRESENTATIVE[newCt] ?? newCt,
      restorationSubtype: null,
      material: null,
    });
  }

  function onSubtypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!selectedCtKey) return;
    const val = e.target.value;
    const node = subtypes.find((n) => n.key === val);
    const encoded = encodeCatalogSelection(selectedCtKey, val, undefined) ?? null;
    patchRestoration({
      restorationType: node?.label ?? val,
      restorationSubtype: encoded,
      material: null,
    });
  }

  function onMaterialChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!selectedCtKey || !selectedStNode) return;
    const val = e.target.value;
    const matNode = materials.find((n) => n.key === val);
    const encoded = val
      ? (encodeCatalogSelection(selectedCtKey, subtypeKey, val) ?? null)
      : (encodeCatalogSelection(selectedCtKey, subtypeKey, undefined) ?? null);
    patchRestoration({
      restorationType: selectedStNode.label,
      restorationSubtype: encoded,
      material: val ? (matNode?.label ?? val) : null,
    });
  }

  async function onArchChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as BillableArch | "";
    if (!value) return;
    const apiArch = value === "both" ? "upper_lower" : value;
    if (pendingCaseType) {
      setPendingArch(value);
      const succeeded = await patchRestoration({
        restorationType: CASE_TYPE_REPRESENTATIVE[pendingCaseType] ?? pendingCaseType,
        restorationSubtype: null,
        material: null,
        arch: apiArch,
      });
      if (succeeded) {
        setPendingCaseType(null);
        setPendingArch("");
      } else {
        // Restore the confirmed hierarchy and unlock the case type after refusal.
        setPendingCaseType(null);
        setPendingArch("");
      }
      return;
    }
    if (!applicableArch || !firstRestorationId) return;

    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/cases/${caseId}/restorations/${firstRestorationId}`, {
        method: "PATCH",
        body: JSON.stringify({ arch: apiArch }),
      });
      await refreshCaseAndInvoiceViews();
    } catch (err: unknown) {
      await refreshCaseAndInvoiceViews();
      setError(err instanceof Error ? err.message : "Could not update arch.");
      toast.error(err instanceof Error ? err.message : "Could not update arch.");
    } finally {
      setSaving(false);
    }
  }

  const cls =
    "h-7 px-1.5 rounded bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary disabled:opacity-60 max-w-[160px]";
  const labeledControl = (
    label: string,
    control: React.ReactNode,
  ): React.ReactNode =>
    showFieldLabels ? (
      <div className="flex flex-col items-start gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          {label}
        </span>
        {control}
      </div>
    ) : (
      control
    );

  return (
    <div className={showFieldLabels ? "grid gap-2" : "flex flex-wrap items-center gap-1.5"}>
      {labeledControl(
        "Case Type",
        <select
          aria-label="Case Type"
          value={selectedCtKey}
          onChange={onCaseTypeChange}
          disabled={saving || pendingCaseType !== null}
          className={cls}
        >
          {!selectedCtKey && <option value="">—</option>}
          {CASE_TYPES.map((ct) => (
            <option key={ct} value={ct}>
              {CASE_TAXONOMY[ct].label}
            </option>
          ))}
        </select>,
      )}
      {selectedCtKey && (
        labeledControl(
          "Case Subtype",
          <select
            aria-label="Case Subtype"
            value={subtypeKey}
            onChange={onSubtypeChange}
            disabled={saving || pendingCaseType !== null}
            className={cls}
          >
            {!subtypeKey && <option value="">— Sub Type —</option>}
            {subtypes.map((st) => (
              <option key={st.key} value={st.key}>
                {st.label}
              </option>
            ))}
          </select>,
        )
      )}
      {showFieldLabels && !selectedCtKey && labeledControl("Case Subtype", <span>—</span>)}
      {selectedStNode && materials.length > 0 && (
        labeledControl(
          "Case Material",
          <select
            aria-label="Case Material"
            value={materialKey}
            onChange={onMaterialChange}
            disabled={saving || pendingCaseType !== null}
            className={cls}
          >
            <option value="">— Material —</option>
            {materials.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>,
        )
      )}
      {showFieldLabels && (!selectedStNode || materials.length === 0) && labeledControl("Case Material", <span>—</span>)}
      {(applicableArch || pendingCaseType !== null) && (
        labeledControl(
          "Arch",
          <select
            aria-label="Arch"
            value={pendingCaseType !== null ? pendingArch : currentArch}
            onChange={onArchChange}
            disabled={saving}
            className={cls}
          >
            <option value="">— Arch —</option>
            {ARCH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>,
        )
      )}
      {pendingCaseType !== null && (
        <>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Choose an arch to switch to {CASE_TAXONOMY[pendingCaseType].label}.
          </span>
          <button
            type="button"
            onClick={() => {
              setPendingCaseType(null);
              setPendingArch("");
              setError(null);
            }}
            disabled={saving}
            className="h-7 px-1.5 rounded text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            Cancel
          </button>
        </>
      )}
      {saving && (
        <Loader2 size={13} className="animate-spin text-muted-foreground" />
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

// ── Step values ───────────────────────────────────────────────────────────────
export const STEP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "custom_tray", label: "Custom Tray" },
  { value: "rims_and_plates", label: "Rims and Plates" },
  { value: "wax_setup", label: "Wax Setup" },
  { value: "process", label: "Process" },
];

export function stepLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return STEP_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function StepSelect({
  value,
  shade,
  caseId,
}: {
  value: string | null | undefined;
  shade: string | null | undefined;
  caseId: string;
}) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [shadeValue, setShadeValue] = useState(shade ?? "");
  const [shadeSaving, setShadeSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep local shade in sync when server data refreshes
  const latestShade = shade ?? "";
  const [prevShade, setPrevShade] = useState(latestShade);
  if (latestShade !== prevShade) {
    setPrevShade(latestShade);
    setShadeValue(latestShade);
  }

  async function handleStepChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newStep = e.target.value || null;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/cases/${caseId}`, {
        method: "PATCH",
        body: JSON.stringify({ step: newStep }),
      });
      // Clear local shade when stepping away from wax_setup
      if (newStep !== "wax_setup") setShadeValue("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["case", caseId] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
      ]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not update step.");
      toast.error(err instanceof Error ? err.message : "Could not update step.");
    } finally {
      setSaving(false);
    }
  }

  async function commitShade() {
    const trimmed = shadeValue.trim();
    if (trimmed === (shade ?? "").trim()) return;
    setShadeSaving(true);
    try {
      await apiFetch(`/cases/${caseId}`, {
        method: "PATCH",
        body: JSON.stringify({ stepShade: trimmed || null }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["case", caseId] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
      ]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not update shade.");
    } finally {
      setShadeSaving(false);
    }
  }

  const effectiveStep = value ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2">
        <select
          value={effectiveStep}
          onChange={handleStepChange}
          disabled={saving}
          className="h-7 px-1.5 rounded bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary disabled:opacity-60"
        >
          <option value="">—</option>
          {STEP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
      </div>
      {effectiveStep === "wax_setup" && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Shade</span>
          <input
            type="text"
            value={shadeValue}
            onChange={(e) => setShadeValue(e.target.value)}
            onBlur={commitShade}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitShade(); }
            }}
            placeholder="e.g. A2"
            className="h-7 w-20 px-2 rounded bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
          />
          {shadeSaving && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
        </div>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function CustomShadeSection({
  caseId,
  isCustomShade,
  customShadeTechnician,
  customShadePicturesAvailable,
  customShadeVideoAvailable,
}: {
  caseId: string;
  isCustomShade: boolean;
  customShadeTechnician: string | null;
  customShadePicturesAvailable: boolean;
  customShadeVideoAvailable: boolean;
}) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [techValue, setTechValue] = useState(customShadeTechnician ?? "");
  const [techSaving, setTechSaving] = useState(false);

  // Keep tech input in sync when server data refreshes.
  const latestTech = customShadeTechnician ?? "";
  const [prevTech, setPrevTech] = useState(latestTech);
  if (latestTech !== prevTech) {
    setPrevTech(latestTech);
    setTechValue(latestTech);
  }

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      await apiFetch(`/cases/${caseId}`, { method: "PATCH", body: JSON.stringify(body) });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["case", caseId] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
      ]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not update custom shade.");
    } finally {
      setSaving(false);
    }
  }

  async function commitTech() {
    const trimmed = techValue.trim();
    if (trimmed === (customShadeTechnician ?? "").trim()) return;
    setTechSaving(true);
    try {
      await apiFetch(`/cases/${caseId}`, {
        method: "PATCH",
        body: JSON.stringify({ customShadeTechnician: trimmed || null }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["case", caseId] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
      ]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not save technician name.");
    } finally {
      setTechSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {/* Custom Shade checkbox */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isCustomShade}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.checked;
            void patch({
              isCustomShade: next,
              ...(next ? {} : { customShadeTechnician: null, customShadePicturesAvailable: false, customShadeVideoAvailable: false }),
            });
          }}
          className="accent-primary h-3.5 w-3.5"
        />
        <span className="text-sm font-medium">Custom Shade</span>
        {saving && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
      </label>

      {/* Sub-fields — shown only when Custom Shade is checked */}
      {isCustomShade && (
        <div className="ml-5 space-y-2 border-l-2 border-border pl-3">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Technician name
            </label>
            <div className="flex items-center gap-1.5 mt-0.5">
              <input
                type="text"
                value={techValue}
                onChange={(e) => setTechValue(e.target.value)}
                onBlur={commitTech}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitTech(); } }}
                placeholder="Enter technician name"
                className="h-7 flex-1 px-2 rounded bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              {techSaving && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={customShadePicturesAvailable}
                disabled={saving}
                onChange={(e) => void patch({ customShadePicturesAvailable: e.target.checked })}
                className="accent-primary h-3.5 w-3.5"
              />
              <span className="text-sm">Pictures available</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={customShadeVideoAvailable}
                disabled={saving}
                onChange={(e) => void patch({ customShadeVideoAvailable: e.target.checked })}
                className="accent-primary h-3.5 w-3.5"
              />
              <span className="text-sm">Video available</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function ToothNumbersDisplay({ value }: { value: string }) {
  return (
    <div className="space-y-1.5" data-testid="case-tooth-display">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        Tooth
      </div>
      <div className={`text-sm ${value === "—" ? "text-muted-foreground" : ""}`}>
        {value}
      </div>
    </div>
  );
}
const RETURN_COMPLETE_STATUSES = new Set(["complete", "completed", "delivered", "done"]);

type ReturnWizardStage =
  | "ask"
  | "date"
  | "rxAsk"
  | "rxUpload"
  | "remakeAsk"
  | "remake"
  | "stepAsk"
  | "step"
  | "notesAsk"
  | "notes"
  | "labSlipAsk"
  | "labelAsk";

/** Title shown in the returned-case popup header for each wizard stage. */
const RETURN_WIZARD_TITLES: Record<ReturnWizardStage, string> = {
  ask: "This case is complete — set a new due date?",
  date: "Set a new due date",
  rxAsk: "Scan a new prescription?",
  rxUpload: "Attach the new prescription",
  remakeAsk: "Is this case a remake?",
  remake: "Link this case to the case it remakes",
  stepAsk: "Is this a removable case?",
  step: "New removable workflow step",
  notesAsk: "Would you like to add any notes?",
  notes: "Add a note",
  labSlipAsk: "Print a new lab slip?",
  labelAsk: "Print a new case label?",
};
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
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

// Option lists for the cases-list multi-select toolbar filters. Status reuses
// STATUS_FILTERS minus its "all" sentinel — with a multi-select, "all" is the
// empty selection rather than a pickable option.
const STATUS_FILTER_OPTIONS = STATUS_FILTERS.filter((f) => f.value !== "all");
const STATUS_QUICK_FILTERS = [
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

function formatLocalCalendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const PRIORITY_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "rush", label: "Rush" },
];

const CASE_TYPE_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "crown_bridge", label: "Crown & Bridge" },
  { value: "implants", label: "Implants" },
  { value: "zirconia", label: "Zirconia" },
  { value: "removable", label: "Removable" },
  { value: "other", label: "Other" },
];

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: "Card",
  ach: "ACH",
  check: "Check",
  cash: "Cash",
  other: "Other",
};

type SortKey =
  | "caseNumber"
  | "doctorName"
  | "status"
  | "dueDate"
  | "createdAt"
  | "totalPrice";


interface RestorationDraft extends ImplantDetails {
  id: string;
  toothNumber: string;
  restorationType: string;
  material: string;
  restorationSubtype?: string | null;
  shade: string;
  quantity: string;
  arch?: "upper" | "lower" | "both" | "";
  assignmentRole?: string;
}

type BillableArch = "upper" | "lower" | "both";
const ARCH_OPTIONS: Array<{ value: BillableArch; label: string }> = [
  { value: "upper", label: "Upper" },
  { value: "lower", label: "Lower" },
  { value: "both", label: "Upper + Lower" },
];
function isArchBasedRestoration(r: { restorationType?: string | null; restorationSubtype?: string | null; assignmentRole?: string }) {
  const indication = r.assignmentRole || r.restorationType || "";
  if (isToothIndication(indication)) return indicationCatalogContext(indication).archBased;
  return /(removable|denture|partial|flipper|valplast|flexible|ortho|night guard|retainer|aligner)/i.test(
    `${r.restorationType ?? ""} ${r.restorationSubtype ?? ""}`,
  );
}
function archLabel(restorations: Array<{ arch?: string | null }> | undefined): string | null {
  const arches = new Set((restorations ?? []).map((r) => r.arch).filter((a): a is "upper" | "lower" => a === "upper" || a === "lower"));
  return arches.has("upper") && arches.has("lower")
    ? "Upper + Lower"
    : arches.has("upper")
      ? "Upper"
      : arches.has("lower")
        ? "Lower"
        : null;
}

interface NewCaseFormData {
  // Optional: server assigns the case number for remake cases.
  caseNumber?: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  dueDate: string;
  // Optional "HH:MM" (24-hour) wall-clock time paired with dueDate. Only
  // meaningful when dueDate is set; left undefined (never sent) when unset.
  dueTime?: string;
  priority: "normal" | "rush";
  casePanBarcode?: string;
  restorations?: RestorationDraft[];
}

interface ProviderPickerProps {
  value: string;
  onChange: (id: string, org: Organization | null) => void;
  providers: Organization[];
  disabled?: boolean;
  parentLabOrganizationId?: string;
}

function ProviderPicker({
  value,
  onChange,
  providers,
  disabled,
  parentLabOrganizationId,
}: ProviderPickerProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newCity, setNewCity] = useState("");
  const [newState, setNewState] = useState("");
  const [newZip, setNewZip] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = providers.find((o) => o.id === value) || null;

  function resetCreate() {
    setCreating(false);
    setNewName("");
    setNewPhone("");
    setNewCity("");
    setNewState("");
    setNewZip("");
    setCreateError(null);
  }

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        resetCreate();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const canCreate =
    !!newName.trim() && !!newCity.trim() && !!newState.trim() && !!newZip.trim();

  const createMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        type: "provider",
        name: newName.trim(),
        city: newCity.trim(),
        state: newState.trim(),
        zip: newZip.trim(),
      };
      if (newPhone.trim()) payload.phone = newPhone.trim();
      if (parentLabOrganizationId) {
        payload.parentLabOrganizationId = parentLabOrganizationId;
      }
      return apiFetch<Organization>("/organizations", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async (org) => {
      await qc.invalidateQueries({ queryKey: ["organizations"] });
      onChange(org.id, org);
      resetCreate();
      setOpen(false);
      setSearch("");
    },
    onError: (err: Error) =>
      setCreateError(err.message || "Could not create practice."),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((o) =>
      (o.displayName || o.name || "").toLowerCase().includes(q),
    );
  }, [providers, search]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-left flex items-center justify-between gap-2 ${
          disabled ? "opacity-60 cursor-not-allowed" : ""
        }`}
      >
        <span className={selected ? "" : "text-muted-foreground"}>
          {selected ? selected.displayName || selected.name : "Select practice…"}
        </span>
        <ChevronDown size={14} className="text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          {creating ? (
            <div className="p-3 space-y-2">
              <div className="text-xs font-semibold text-foreground">
                Add new practice
              </div>
              <input
                autoFocus
                type="text"
                placeholder="Practice name"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim() && !createMutation.isPending) {
                    e.preventDefault();
                    createMutation.mutate();
                  }
                }}
                className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="City"
                  value={newCity}
                  onChange={(e) => {
                    setNewCity(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canCreate && !createMutation.isPending) {
                      e.preventDefault();
                      createMutation.mutate();
                    }
                  }}
                  className="flex-1 min-w-0 h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
                <input
                  type="text"
                  placeholder="State"
                  value={newState}
                  onChange={(e) => {
                    setNewState(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canCreate && !createMutation.isPending) {
                      e.preventDefault();
                      createMutation.mutate();
                    }
                  }}
                  className="w-16 shrink-0 h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
                <input
                  type="text"
                  placeholder="ZIP"
                  value={newZip}
                  onChange={(e) => {
                    setNewZip(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canCreate && !createMutation.isPending) {
                      e.preventDefault();
                      createMutation.mutate();
                    }
                  }}
                  className="w-20 shrink-0 h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
              <input
                type="tel"
                placeholder="Phone (optional)"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate && !createMutation.isPending) {
                    e.preventDefault();
                    createMutation.mutate();
                  }
                }}
                className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              {createError && (
                <div className="text-xs text-destructive">{createError}</div>
              )}
              <div className="flex gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => createMutation.mutate()}
                  disabled={!canCreate || createMutation.isPending}
                  className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {createMutation.isPending && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  Create
                </button>
                <button
                  type="button"
                  onClick={resetCreate}
                  disabled={createMutation.isPending}
                  className="h-8 px-3 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setNewName(search.trim());
                  setCreateError(null);
                }}
                className="w-full text-left px-3 py-2 text-sm font-medium text-primary hover:bg-secondary/60 flex items-center gap-2 border-b border-border"
              >
                <Plus size={14} className="shrink-0" />
                Add new practice
              </button>
              <div className="p-2 border-b border-border">
                <input
                  autoFocus
                  type="search"
                  placeholder="Search practices…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
              <ul className="max-h-56 overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">
                    No practices found.
                  </li>
                )}
                {filtered.map((o) => {
                  const isSel = o.id === value;
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(o.id, o);
                          setOpen(false);
                          setSearch("");
                        }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/60 flex items-center gap-2 ${
                          isSel ? "bg-primary/10" : ""
                        }`}
                      >
                        {isSel && (
                          <Check size={13} className="text-primary shrink-0" />
                        )}
                        <span className="truncate">
                          {o.displayName || o.name}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
/**
 * Modal that lists existing doctors in the same practice whose name closely
 * matches the typed doctor name, and asks the user which doctor they mean
 * BEFORE the case is saved. Shown only when `/cases/doctor-similarity` (or the
 * POST /cases 409 fallback) returns at least one candidate.
 *
 * Three exits:
 *   - "Use this doctor": adopt the existing doctor's exact name and continue.
 *   - "Add as a new doctor": keep the typed name as a new, distinct doctor.
 *   - "Cancel": close; do not create.
 */
function DoctorConfirmationModal({
  matches,
  typedName,
  onCancel,
  onUseExisting,
  onAddNew,
}: {
  matches: DoctorMatchCandidate[];
  typedName: string;
  onCancel: () => void;
  onUseExisting: (candidate: DoctorMatchCandidate) => void;
  onAddNew: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Possible duplicate doctor"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500" />
            <h2 className="text-base font-semibold">Which doctor do you mean?</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          <p className="text-sm text-muted-foreground">
            "<span className="font-medium text-foreground">{typedName}</span>"
            closely matches{" "}
            {matches.length === 1
              ? "an existing doctor"
              : `${matches.length} existing doctors`}{" "}
            in this practice. Pick the existing doctor to avoid creating a
            duplicate, or confirm this is a new doctor.
          </p>

          <div className="space-y-2">
            {matches.map((m) => (
              <button
                key={`${m.providerOrganizationId ?? ""}:${m.doctorName}`}
                type="button"
                onClick={() => onUseExisting(m)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60 hover:border-primary/40 transition-colors text-left"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {m.doctorName}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {m.totalCases} case{m.totalCases === 1 ? "" : "s"} ·{" "}
                    {Math.round(m.similarity * 100)}% match
                  </div>
                </div>
                <span className="shrink-0 text-xs font-medium text-primary">
                  Use this doctor
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 px-6 py-3 border-t border-border bg-secondary/20">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onAddNew}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
          >
            Add "{typedName}" as a new doctor
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Modal that lists previously-seen cases for the same patient name and asks
 * the user whether the new case is a remake. Shown only when the server's
 * `/cases/patient-similarity` endpoint returns at least one match.
 *
 * Three exits:
 *   - "Not a remake": create the case as a normal new case.
 *   - "It's a remake of …": picks a candidate, captures reason + charge
 *     decision, creates the case linked to the original.
 *   - "Cancel": close both modals; do not create.
 */
function PossibleDuplicateModal({
  matches,
  patientFirstName,
  patientLastName,
  onCancel,
  onProceedAsNew,
  onProceedAsRemake,
  isSubmitting,
  isAdmin = false,
}: {
  matches: PatientSimilarityHit[];
  patientFirstName: string;
  patientLastName: string;
  onCancel: () => void;
  onProceedAsNew: () => void;
  onProceedAsRemake: (decision: RemakeDecision) => void;
  isSubmitting: boolean;
  isAdmin?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>(
    matches[0]?.id ?? "",
  );
  const [questionnaire, setQuestionnaire] = useState<RemakeQuestionnaireValue>(blankQuestionnaire());
  const [err, setErr] = useState<string | null>(null);

  function submitRemake() {
    if (!selectedId) return setErr("Select the prior case being remade.");
    const questionnaireError = remakeQuestionnaireError(questionnaire);
    if (questionnaireError) return setErr(questionnaireError);
    const reasonLabel = REMAKE_REASONS.find((r) => r.key === questionnaire.reasonKey)?.label ?? questionnaire.reasonKey;
    const customReason = questionnaire.reasonKey === "other" ? (questionnaire.customReason ?? "").trim() : "";
    onProceedAsRemake({
      remakeOfCaseId: selectedId,
      remakeReason: customReason || reasonLabel,
      remakeCharged: questionnaire.charge === "yes",
      remakeReasonKey: questionnaire.reasonKey as RemakeReasonKey,
      ...(questionnaire.shadeLightness ? { remakeShadeLightness: questionnaire.shadeLightness as "light" | "dark" } : {}),
      ...(questionnaire.shadePrescribed.trim() ? { remakeShadePrescribed: questionnaire.shadePrescribed.trim() } : {}),
      ...(questionnaire.shadeProvided.trim() ? { remakeShadeProvided: questionnaire.shadeProvided.trim() } : {}),
      ...(questionnaire.materialPrescribed.trim() ? { remakeMaterialPrescribed: questionnaire.materialPrescribed.trim() } : {}),
      ...(questionnaire.materialProvided.trim() ? { remakeMaterialProvided: questionnaire.materialProvided.trim() } : {}),
      ...(questionnaire.returnedToLab !== null ? { remakeReturnedToLab: questionnaire.returnedToLab } : {}),
      ...(questionnaire.category ? { remakeCategory: questionnaire.category as "crown_bridge" | "removable" } : {}),
      ...(questionnaire.notes.trim() ? { remakeNotes: questionnaire.notes.trim() } : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Possible duplicate"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500" />
            <h2 className="text-base font-semibold">
              Possible duplicate / remake?
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          <p className="text-sm text-muted-foreground">
            We found {matches.length} prior case{matches.length === 1 ? "" : "s"}{" "}
            for a patient that looks like{" "}
            <span className="font-medium text-foreground">
              {patientFirstName} {patientLastName}
            </span>
            . Is this a remake of one of them?
          </p>

          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50">
                <tr>
                  <th className="text-left px-3 py-2 w-8"></th>
                  <th className="text-left px-3 py-2">Case #</th>
                  <th className="text-left px-3 py-2">Patient</th>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Teeth</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr
                    key={`${m.source}:${m.id}`}
                    onClick={() => setSelectedId(m.id)}
                    className={`border-t border-border cursor-pointer hover:bg-secondary/40 ${
                      selectedId === m.id ? "bg-primary/10" : ""
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="radio"
                        name="dup"
                        checked={selectedId === m.id}
                        onChange={() => setSelectedId(m.id)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono">{m.caseNumber}</td>
                    <td className="px-3 py-2">
                      {m.patientFirstName} {m.patientLastName}
                      {m.matchKind !== "exact" && (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                          ({m.matchKind})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {m.createdAt ? formatDate(m.createdAt) : "—"}
                    </td>
                    <td className="px-3 py-2">{m.toothNumbers || "—"}</td>
                    <td className="px-3 py-2">{m.restorationTypes || "—"}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={m.status as any} />
                      {m.source === "legacy" && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          mobile
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedId && (
            <RemakeQuestionnaire value={questionnaire} onChange={setQuestionnaire} isAdmin={isAdmin} />
          )}

          {err && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {err}
            </p>
          )}
        </div>

        <div className="flex gap-2 px-6 py-3 border-t border-border bg-secondary/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="h-9 px-3 rounded-md bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onProceedAsNew}
            disabled={isSubmitting}
            className="h-9 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80 disabled:opacity-60"
          >
            Not a remake — create new
          </button>
          <button
            type="button"
            onClick={submitRemake}
            disabled={isSubmitting || !selectedId}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {isSubmitting && <Loader2 size={11} className="animate-spin" />}
            Yes, link as remake
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewCaseModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const isPageAdmin = user?.role === "admin" || user?.role === "owner";
  const qc = useQueryClient();
  const orgsQuery = useQuery({
    queryKey: ["organizations", { includeLabPractices: true }],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeLabPractices=true"),
  });

  const orgs = orgsQuery.data ?? [];
  const labOrgs = orgs.filter((o) => o.type === "lab");
  const providerOrgs = orgs.filter((o) => o.type !== "lab");

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
  });

  const distinctPatientFirstNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of casesQuery.data ?? []) {
      if (c.patientFirstName?.trim()) names.add(c.patientFirstName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [casesQuery.data]);

  const distinctPatientLastNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of casesQuery.data ?? []) {
      if (c.patientLastName?.trim()) names.add(c.patientLastName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [casesQuery.data]);

  const distinctDoctorNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of casesQuery.data ?? []) {
      if (c.doctorName?.trim()) names.add(c.doctorName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [casesQuery.data]);

  const [form, setForm] = useState<NewCaseFormData>({
    caseNumber: "",
    labOrganizationId: "",
    providerOrganizationId: "",
    patientFirstName: "",
    patientLastName: "",
    doctorName: "",
    dueDate: "",
    priority: "normal",
  });
  const [hasDueTime, setHasDueTime] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<
    PatientSimilarityHit[] | null
  >(null);
  const [checkingDupes, setCheckingDupes] = useState(false);
  // Pre-create duplicate-DOCTOR checkpoint. When the typed doctor name strongly
  // resembles an existing doctor in the same practice, we ask the user which
  // doctor they mean before saving. `confirmNewDoctorRef` carries the user's
  // "add as new doctor" decision through the subsequent patient-similarity
  // checkpoint and into the create payload (so the server check is bypassed).
  const [doctorMatches, setDoctorMatches] = useState<
    DoctorMatchCandidate[] | null
  >(null);
  const confirmNewDoctorRef = useRef(false);

  // ── New-case barcode conflict check ──────────────────────────────────────
  const [newBarcodeConflict, setNewBarcodeConflict] = useState<LabCase | null>(null);
  const [newBarcodeChecking, setNewBarcodeChecking] = useState(false);

  // ── Remake state ─────────────────────────────────────────────────────────
  // Search, results, and next-suffix preview are owned internally by
  // <RemakeOriginalPicker>; only the selection + questionnaire answers need
  // to live here since the submit handler reads them.
  const [isRemake, setIsRemake] = useState(false);
  const [remakeSelected, setRemakeSelected] = useState<RemakeCaseHit | null>(null);
  const [remake, setRemake] = useState<RemakeQuestionnaireValue>(blankQuestionnaire());

  // ── Restorations ─────────────────────────────────────────────────────────
  const [restorations, setRestorations] = useState<RestorationDraft[]>([]);
  const [assignmentCaseShade, setAssignmentCaseShade] = useState("");
  const [rowEditorOpen, setRowEditorOpen] = useState(false);
  const [restorationUndo, setRestorationUndo] = useState<RestorationDraft[] | null>(null);
  const [draftChartRow, setDraftChartRow] = useState<string | null>(null);
  const [assignmentTooth, setAssignmentTooth] = useState<string | null>(null);
  const [assignmentCopyTemplate, setAssignmentCopyTemplate] = useState<ToothAssignmentUnit | null>(null);
  const [assignmentCopyAnchor, setAssignmentCopyAnchor] = useState<string | null>(null);
  const [assignmentSelectionAnchor, setAssignmentSelectionAnchor] = useState<string | null>(null);
  const [pendingAssignmentCopy, setPendingAssignmentCopy] = useState<{
    targets: string[];
    template: ToothAssignmentUnit;
  } | null>(null);
  const [multiApplyMode, setMultiApplyMode] = useState(false);
  const [multiApplyTargets, setMultiApplyTargets] = useState<string[]>([]);
  const assignmentCatalog = useGetCatalogTree({ labOrganizationId: form.labOrganizationId }, {
    query: { queryKey: getGetCatalogTreeQueryKey({ labOrganizationId: form.labOrganizationId }), enabled: !!form.labOrganizationId },
  });
  const [draftConnectors, setDraftConnectors] = useState("");
  const [restorationConnectorUndo, setRestorationConnectorUndo] = useState("");

  function addRestoration() {
    setRowEditorOpen(true);
    setRestorationConnectorUndo(draftConnectors);
    setRestorationUndo(restorations);
    setRestorations((prev) => [
      ...prev,
      { id: crypto.randomUUID(), toothNumber: "", restorationType: "", material: "", restorationSubtype: null, shade: "", quantity: "1", arch: "" },
    ]);
  }

  function removeRestoration(id: string) {
    setRestorationConnectorUndo(draftConnectors);
    setRestorationUndo(restorations);
    setRestorations((prev) => prev.filter((r) => r.id !== id));
  }

  function applyQuickAssignmentCopy(targets: string[], template: ToothAssignmentUnit) {
    if (mutation.isPending || targets.length === 0) return;
    setRestorationConnectorUndo(draftConnectors);
    setRestorationUndo(restorations);
    const rows = restorations.flatMap((row) => {
      const teeth = !isArchBasedRestoration(row) ? expandToothAssignmentIdentifiers(row.toothNumber) : [];
      return teeth.length > 1
        ? teeth.map((tooth) => ({ ...row, id: crypto.randomUUID(), toothNumber: tooth, quantity: "1" }))
        : [row];
    }).filter((row) => row.restorationType || row.toothNumber || row.material);
    for (const tooth of targets) {
      const copied = copyToothAssignment(template, tooth);
      const replacement: RestorationDraft = {
        ...(rows.find((row) => row.toothNumber === tooth && !isArchBasedRestoration(row)) ?? {
          id: crypto.randomUUID(),
          arch: "",
        }),
        toothNumber: tooth,
        restorationType: "Crown",
        assignmentRole: copied.restorationType,
        material: copied.material ?? "",
        restorationSubtype: copied.restorationSubtype ?? null,
        shade: copied.shade || assignmentCaseShade,
        quantity: "1",
        arch: "",
      };
      const existing = rows.find((row) => row.toothNumber === tooth && !isArchBasedRestoration(row));
      if (existing) {
        const index = rows.indexOf(existing);
        rows[index] = replacement;
      } else {
        rows.push(replacement);
      }
    }
    const nextUnits = rows.filter((row) => row.assignmentRole).map((row) => ({
      toothNumber: row.toothNumber,
      restorationType: row.assignmentRole ?? row.restorationType,
      material: row.material,
      restorationSubtype: row.restorationSubtype ?? undefined,
      shade: row.shade,
      quantity: 1,
    }));
    const connectorState = withPonticConnectorSuggestions(draftConnectors, nextUnits, new Set(targets));
    const compatiblePairs = new Set(
      [...connectorState.active].filter((pair) => validateToothConnectors(pair, nextUnits).valid),
    );
    setDraftConnectors(updateConnectorChoices(connectorState, compatiblePairs));
    setRestorations(rows);
    setAssignmentCopyAnchor(template.toothNumber);
    setPendingAssignmentCopy(null);
    setAssignmentTooth(null);
    toast.success(`Applied assignment to ${targets.map((tooth) => `#${tooth}`).join(", ")}.`);
  }

  function requestQuickAssignmentCopy(targets: string[]) {
    if (!assignmentCopyTemplate || targets.length === 0) return;
    const uniqueTargets = [...new Set(targets)];
    const invalidTarget = uniqueTargets.some((tooth) => {
      const number = Number(tooth);
      return !Number.isInteger(number) || number < 1 || number > 32;
    });
    if (invalidTarget) {
      setError("Quick copy can only target adult teeth numbered 1 through 32.");
      return;
    }
    const validTargets = uniqueTargets.filter((tooth) => tooth !== assignmentCopyTemplate.toothNumber);
    if (!validTargets.length) return;
    const conflicts = validTargets.some((tooth) =>
      restorations.some((row) => !isArchBasedRestoration(row) && parseToothField(row.toothNumber).has(tooth)),
    );
    if (conflicts) {
      setPendingAssignmentCopy({ targets: validTargets, template: assignmentCopyTemplate });
      return;
    }
    applyQuickAssignmentCopy(validTargets, assignmentCopyTemplate);
  }

  function handleAssignmentToothClick(tooth: string, modifiers?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    if (multiApplyMode) {
      if (modifiers?.shiftKey && assignmentSelectionAnchor) {
        const range = expandToothAssignmentIdentifiers(`${assignmentSelectionAnchor}-${tooth}`);
        if (!range.length) { setError("Shift-selection ranges must stay within one arch."); return; }
        setMultiApplyTargets((current) => [...new Set([...current, ...range])]);
      } else {
        setAssignmentSelectionAnchor(tooth);
        setMultiApplyTargets((current) =>
          current.includes(tooth) ? current.filter((item) => item !== tooth) : [...current, tooth],
        );
      }
      return;
    }
    if (modifiers?.ctrlKey || modifiers?.metaKey) {
      if (assignmentCopyTemplate) requestQuickAssignmentCopy([tooth]);
      else toast.info("Assign a tooth first to create copy settings.");
      return;
    }
    if (modifiers?.shiftKey && (assignmentSelectionAnchor || assignmentCopyAnchor)) {
      const range = expandToothAssignmentIdentifiers(`${assignmentSelectionAnchor || assignmentCopyAnchor}-${tooth}`);
      if (!range.length) {
        setError("Shift-selection ranges must stay within one arch.");
        return;
      }
      setError(null);
      setMultiApplyMode(true);
      setMultiApplyTargets(range);
      return;
    }
    if (!mutation.isPending) {
      setAssignmentSelectionAnchor(tooth);
      const source = restorations.find((row) => row.assignmentRole && parseToothField(row.toothNumber).has(tooth));
      if (source?.assignmentRole) {
        setAssignmentCopyTemplate({
          toothNumber: tooth,
          restorationType: source.assignmentRole,
          material: source.material,
          shade: source.shade,
          restorationSubtype: source.restorationSubtype ?? undefined,
        });
        setAssignmentCopyAnchor(tooth);
      }
      setAssignmentTooth(tooth);
    }
  }

  function applyManualAssignment(payload: ToothActionPayload) {
    if (mutation.isPending) return;
    if ((payload.kind === "add_crown" || payload.kind === "replace_tooth") && payload.arch) {
      const current = payload.kind === "replace_tooth" ? restorations.find((row) => row.id === payload.restorationId) : undefined;
      const indication = payload.kind === "add_crown" ? payload.restorationType : payload.role ?? current?.restorationType ?? "";
      if (!isToothIndication(indication) || !indicationCatalogContext(indication).archBased) {
        setError("Choose a supported arch restoration."); return;
      }
      const previous = current ?? restorations.find((row) => row.restorationType === indication && row.arch === payload.arch);
      setRestorationConnectorUndo(draftConnectors); setRestorationUndo(restorations);
      const row: RestorationDraft = {
        ...(previous ?? { id: crypto.randomUUID() }), toothNumber: "", restorationType: indication,
        assignmentRole: undefined, material: payload.material ?? previous?.material ?? "",
        restorationSubtype: payload.restorationSubtype ?? previous?.restorationSubtype ?? null,
        shade: payload.shade ?? previous?.shade ?? assignmentCaseShade, quantity: "1", arch: payload.arch,
      };
      setRestorations((rows) => previous ? rows.map((candidate) => candidate.id === previous.id ? row : candidate) : [...rows, row]);
      setMultiApplyMode(false); setMultiApplyTargets([]); setAssignmentTooth(null);
      return;
    }
    if (payload.kind === "remove_restoration" && payload.restorationId &&
        restorations.some((row) => row.id === payload.restorationId && isArchBasedRestoration(row))) {
      setRestorationUndo(restorations); setRestorationConnectorUndo(draftConnectors);
      setRestorations((rows) => rows.filter((row) => row.id !== payload.restorationId));
      setAssignmentTooth(null); return;
    }
    if (payload.kind === "replace_tooth" && payload.role && isToothIndication(payload.role) &&
        restorations.some((row) => row.id === payload.restorationId && isArchBasedRestoration(row))) {
      setRestorationUndo(restorations); setRestorationConnectorUndo(draftConnectors);
      setRestorations((rows) => rows.map((row) => row.id !== payload.restorationId ? row : {
        ...row, toothNumber: payload.newToothNumber, restorationType: payload.role!,
        assignmentRole: payload.role, material: payload.material ?? row.material,
        restorationSubtype: payload.restorationSubtype ?? row.restorationSubtype,
        shade: payload.shade ?? row.shade, arch: "", quantity: "1",
      }));
      setAssignmentTooth(null); return;
    }
    if (multiApplyMode && multiApplyTargets.length &&
        (payload.kind === "add_crown" || payload.kind === "add_pontic")) {
      const template: ToothAssignmentUnit = {
        toothNumber: payload.toothId,
        restorationType: payload.kind === "add_pontic" ? "Pontic" : payload.restorationType,
        material: payload.material,
        shade: payload.shade ?? assignmentCaseShade,
        restorationSubtype: payload.restorationSubtype,
      };
      const targets = [...new Set(multiApplyTargets)];
      setAssignmentCopyTemplate(template);
      if (targets.some((tooth) => restorations.some((row) => !isArchBasedRestoration(row) && parseToothField(row.toothNumber).has(tooth)))) {
        setPendingAssignmentCopy({ targets, template });
        setAssignmentTooth(null);
      } else {
        applyQuickAssignmentCopy(targets, template);
      }
      setMultiApplyMode(false);
      setMultiApplyTargets([]);
      return;
    }
    setRestorationConnectorUndo(draftConnectors); setRestorationUndo(restorations);
    let rows = restorations.flatMap((row) => {
      const teeth = !isArchBasedRestoration(row) ? expandToothAssignmentIdentifiers(row.toothNumber) : [];
      return teeth.length > 1 ? teeth.map((tooth) => ({ ...row, id: crypto.randomUUID(), toothNumber: tooth, quantity: "1" })) : [row];
    }).filter((row) => row.restorationType || row.toothNumber || row.material);
    function assign(tooth: string, role: string, material: string, shade?: string, subtype?: string | null) {
      if (!isToothIndication(role) || indicationCatalogContext(role).archBased) { setError("Choose a supported tooth indication."); return; }
      const previous = rows.find((row) => !isArchBasedRestoration(row) && row.toothNumber === tooth);
      const row: RestorationDraft = { ...(previous ?? { id: crypto.randomUUID(), arch: "" }), toothNumber: tooth,
        restorationType: /^(Crown|Pontic|Veneer)$/.test(role) ? "Crown" : role, assignmentRole: role, material, shade: shade ?? assignmentCaseShade, quantity: "1", arch: "",
        restorationSubtype: subtype ?? previous?.restorationSubtype ?? null };
      rows = previous ? rows.map((candidate) => candidate.id === previous.id ? row : candidate) : [...rows, row];
    }
    const owner = restorations.find((row) => parseToothField(row.toothNumber).has(assignmentTooth ?? ""));
    if (payload.kind === "add_crown" || payload.kind === "add_pontic") {
      assign(payload.toothId, payload.kind === "add_pontic" ? "Pontic" : payload.restorationType, payload.material, payload.shade, payload.restorationSubtype);
      setAssignmentCopyTemplate({
        toothNumber: payload.toothId,
        restorationType: payload.kind === "add_pontic" ? "Pontic" : payload.restorationType,
        material: payload.material,
        shade: payload.shade ?? "",
        restorationSubtype: payload.restorationSubtype,
      });
      setAssignmentCopyAnchor(payload.toothId);
    } else if (payload.kind === "change_role" && owner) {
      assign(payload.toothId, payload.role, owner.material, owner.shade || assignmentCaseShade, owner.restorationSubtype);
      setAssignmentCopyTemplate({
        toothNumber: payload.toothId,
        restorationType: payload.role,
        material: owner.material,
        shade: owner.shade,
        restorationSubtype: owner.restorationSubtype ?? undefined,
      });
      setAssignmentCopyAnchor(payload.toothId);
    } else if (payload.kind === "copy_assignment" && owner?.assignmentRole) {
      for (const tooth of payload.toothNumbers) assign(tooth, owner.assignmentRole, owner.material, owner.shade || assignmentCaseShade, owner.restorationSubtype);
    } else if (payload.kind === "replace_tooth" && owner?.assignmentRole) {
      rows = rows.filter((row) => row.toothNumber !== payload.oldToothId || isArchBasedRestoration(row));
      assign(payload.newToothNumber, payload.role ?? owner.assignmentRole, payload.material ?? owner.material, payload.shade ?? (owner.shade || assignmentCaseShade), payload.restorationSubtype ?? owner.restorationSubtype);
    } else if (payload.kind === "remove_restoration" || payload.kind === "mark_missing") {
      const targets = payload.kind === "mark_missing" && multiApplyMode && multiApplyTargets.length
        ? multiApplyTargets : [payload.toothId];
      rows = rows.filter((row) => !targets.includes(row.toothNumber) || isArchBasedRestoration(row));
      if (payload.kind === "mark_missing") {
        rows.push(...targets.map((toothNumber) => ({
          id: crypto.randomUUID(), toothNumber, restorationType: "missing",
          material: "", shade: "", quantity: "1", arch: "" as const, restorationSubtype: null,
        })));
        setMultiApplyMode(false);
        setMultiApplyTargets([]);
      }
    }
    const nextUnits = rows.filter((row) => row.assignmentRole).map((row) => ({
      toothNumber: row.toothNumber,
      restorationType: row.assignmentRole ?? row.restorationType,
      material: row.material,
      restorationSubtype: row.restorationSubtype ?? undefined,
      shade: row.shade,
      quantity: 1,
    }));
    const nextConnectorState = withPonticConnectorSuggestions(draftConnectors, nextUnits);
    const safeConnectorPairs = new Set(
      [...nextConnectorState.active].filter((pair) => validateToothConnectors(pair, nextUnits).valid),
    );
    setDraftConnectors(updateConnectorChoices(nextConnectorState, safeConnectorPairs));
    setRestorations(rows); setAssignmentTooth(null);
  }

  function updateRestoration(id: string, field: keyof Omit<RestorationDraft, "id">, value: string) {
    setRestorationConnectorUndo(draftConnectors);
    setRestorationUndo(restorations);
    setRestorations((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function clearRemake() {
    setIsRemake(false);
    setRemakeSelected(null);
    setRemake(blankQuestionnaire());
  }

  const mutation = useMutation({
    onMutate: () => setRestorationUndo(null),
    mutationFn: (data: NewCaseFormData & Partial<RemakeDecision>) =>
      apiFetch<LabCase>("/cases", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          bridgeConnectors: serializeConnectorState(withPonticConnectorSuggestions(
            draftConnectors, (data.restorations ?? []).map((row) => ({ ...row,
              restorationType: row.assignmentRole ?? row.restorationType, quantity: Number(row.quantity) })),
          )),
        }),
      }),
    onSuccess: async (_data, variables) => {
      await refreshCaseFinanceQueries(qc);
      if (variables.remakeOfCaseId) {
        await qc.invalidateQueries({ queryKey: ["case-remake-chain", variables.remakeOfCaseId] });
      }
      setDuplicateMatches(null);
      onClose();
    },
    onError: (e: Error) => {
      // Server-side duplicate-DOCTOR fallback. Even if the pre-submit probe was
      // skipped or stale, the create endpoint returns 409
      // DOCTOR_CONFIRMATION_REQUIRED with candidate matches — open the same
      // confirmation modal so the checkpoint is unavoidable.
      if (e instanceof ApiError && e.status === 409) {
        const details = (e.body as { details?: { code?: string; candidates?: DoctorMatchCandidate[] } } | null)?.details;
        if (details?.code === "DOCTOR_CONFIRMATION_REQUIRED" && Array.isArray(details.candidates)) {
          setDuplicateMatches(null);
          setDoctorMatches(details.candidates);
          return;
        }
      }
      setError(e.message);
    },
  });

  function set<K extends keyof NewCaseFormData>(k: K, v: NewCaseFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  }

  // ── Barcode conflict check — debounced, fires 400 ms after last keystroke ──
  useEffect(() => {
    const trimmed = (form.casePanBarcode ?? "").trim();
    if (!trimmed || !form.labOrganizationId) {
      setNewBarcodeConflict(null);
      setNewBarcodeChecking(false);
      return;
    }
    setNewBarcodeChecking(true);
    const t = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          barcode: trimmed,
          organizationId: form.labOrganizationId,
        });
        const res = await apiFetch<LabCase[]>(`/cases?${params.toString()}`);
        const matches = Array.isArray(res) ? res : [];
        const active = matches.filter((c) => c.status !== "complete");
        setNewBarcodeConflict(active.length > 0 ? active[0] : null);
      } catch {
        setNewBarcodeConflict(null);
      } finally {
        setNewBarcodeChecking(false);
      }
    }, 400);
    return () => { window.clearTimeout(t); };
  }, [form.casePanBarcode, form.labOrganizationId]);

  // Pre-fill due date from the lab's defaultCaseDueDays setting when the
  // user picks a lab and hasn't typed a date yet.
  useEffect(() => {
    if (!form.labOrganizationId || form.dueDate) return;
    const lab = labOrgs.find((o) => o.id === form.labOrganizationId);
    if (!lab?.defaultCaseDueDays) return;
    const d = new Date();
    d.setDate(d.getDate() + lab.defaultCaseDueDays);
    setForm((f) => ({ ...f, dueDate: d.toISOString().slice(0, 10) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.labOrganizationId]);

  // Fetch the lab's real next available case number whenever the selected lab
  // changes. The number is lab-specific, so clear it until a lab is chosen and
  // re-fetch on every change. Failures degrade gracefully (field stays editable).
  useEffect(() => {
    // Clear immediately on any lab change so a number from a different lab is
    // never left visible while the next-number request is in flight.
    setForm((f) => ({ ...f, caseNumber: "" }));
    if (!form.labOrganizationId) {
      return;
    }
    let cancelled = false;
    apiFetch<{ caseNumber: string }>(
      `/cases/next-case-number?labOrganizationId=${encodeURIComponent(form.labOrganizationId)}`,
    )
      .then((res) => {
        if (!cancelled && res?.caseNumber) {
          setForm((f) => ({ ...f, caseNumber: res.caseNumber }));
        }
      })
      .catch(() => {
        // Non-fatal: leave the field editable so the user can type one manually.
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.labOrganizationId]);

  function regenerateCaseNumber() {
    if (!form.labOrganizationId) {
      setError("Select a lab organization first.");
      return;
    }
    apiFetch<{ caseNumber: string }>(
      `/cases/next-case-number?labOrganizationId=${encodeURIComponent(form.labOrganizationId)}`,
    )
      .then((res) => {
        if (res?.caseNumber) set("caseNumber", res.caseNumber);
      })
      .catch(() => {
        // Non-fatal: leave the existing value in place.
      });
  }

  const [dueDateCapped, setDueDateCapped] = useState(false);

  function handleDueDateChange(raw: string) {
    const lab = labOrgs.find((o) => o.id === form.labOrganizationId);
    // Mirror the server's resolveCaseDueDate semantics: cap is ON by default
    // (null/undefined → treat as true); only an explicit false disables it.
    if (raw && lab?.capCaseDueToDefault !== false && lab?.defaultCaseDueDays) {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + lab.defaultCaseDueDays);
      const maxStr = maxDate.toISOString().slice(0, 10);
      if (raw > maxStr) {
        set("dueDate", maxStr);
        setDueDateCapped(true);
        return;
      }
    }
    setDueDateCapped(false);
    set("dueDate", raw);
    if (!raw) {
      set("dueTime", undefined);
      setHasDueTime(false);
    }
  }

  function buildRestorationPayload() {
    if (restorations.length === 0) return undefined;
    return restorations.flatMap((r) => {
      const base = {
        toothNumber: r.toothNumber.trim(),
        restorationType: r.assignmentRole || r.restorationType,
        material: r.material || undefined,
        restorationSubtype: r.restorationSubtype || undefined,
        ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, r[key] || null])),
        shade: r.shade || undefined,
        quantity: r.assignmentRole ? 1 : parseInt(r.quantity, 10) || 1,
      };
      const teeth = r.assignmentRole ? expandToothAssignmentIdentifiers(r.toothNumber) : [r.toothNumber.trim()];
      return teeth.flatMap((toothNumber) => {
        const unit = { ...base, toothNumber };
        if (isArchBasedRestoration(r) && r.arch === "both") {
          return [{ ...unit, arch: "upper" as const }, { ...unit, arch: "lower" as const }];
        }
        return [{ ...unit, ...(isArchBasedRestoration(r) && r.arch ? { arch: r.arch } : {}) }];
      });
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.labOrganizationId)
      return setError("Please select a lab organization.");
    if (!form.providerOrganizationId)
      return setError("Please select a practice.");
    if (!form.patientFirstName.trim() || !form.patientLastName.trim())
      return setError("Patient first and last name are required.");
    if (!form.doctorName.trim()) return setError("Doctor name is required.");

    // Validate restoration rows — type is always required; tooth number is
    // only required for non-removable types (crown/bridge, etc.).
    for (const r of restorations) {
      if (r.assignmentRole && invalidToothAssignmentTokens(r.toothNumber).length) {
        return setError("Enter valid tooth numbers or same-arch ranges for each tooth assignment.");
      }
      if (!r.restorationType) {
        return setError("Each restoration must have a type selected.");
      }
      if (isArchBasedRestoration(r) && !r.arch) {
        return setError("Select an arch for each Removable or Ortho restoration.");
      }
      if (!r.toothNumber.trim() && !isRemovableRestorationType(r.restorationType)) {
        return setError("Each restoration must have a tooth number.");
      }
      if (!isArchBasedRestoration(r) &&
          /crown|pontic|bridge|veneer|inlay|onlay|restorative/i.test(`${r.restorationType} ${r.restorationSubtype ?? ""}`) &&
          !r.assignmentRole) {
        return setError("Choose prepared crown or pontic for each tooth assignment.");
      }
      if (r.assignmentRole && !r.material.trim()) {
        return setError("Choose a catalog material for each tooth assignment.");
      }
    }
    const assignmentRows = buildRestorationPayload() ?? [];
    const connectorState = withPonticConnectorSuggestions(draftConnectors, assignmentRows);
    const connectorText = serializeConnectorState(connectorState);
    const connectorCheck = validateToothConnectors(connectorText, assignmentRows);
    const assignmentCheck = toothAssignmentSummary(assignmentRows, connectorText);
    if (!connectorCheck.valid) return setError(connectorCheck.errors.join(" "));
    if (assignmentCheck.unresolvedPontics.length) {
      return setError(`Connect or review pontics ${assignmentCheck.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")}.`);
    }

    // If the user marked this as a remake, validate the remake fields and
    // submit directly — skip the auto-duplicate check to avoid double-linking.
    if (isRemake) {
      if (!remakeSelected) return setError("Select the original case being remade.");
      const questionnaireError = remakeQuestionnaireError(remake);
      if (questionnaireError) return setError(questionnaireError);
      const reasonLabel = REMAKE_REASONS.find((r) => r.key === remake.reasonKey)?.label ?? remake.reasonKey;
      const customReason = remake.reasonKey === "other" ? (remake.customReason ?? "").trim() : "";
      const { caseNumber: _ignored, ...formWithoutCaseNumber } = form;
      mutation.mutate({
        ...formWithoutCaseNumber,
        remakeOfCaseId: remakeSelected.id,
        remakeReason: customReason || reasonLabel,
        remakeCharged: remake.charge === "yes",
        remakeReasonKey: remake.reasonKey,
        ...(remake.shadeLightness ? { remakeShadeLightness: remake.shadeLightness } : {}),
        ...(remake.shadePrescribed.trim() ? { remakeShadePrescribed: remake.shadePrescribed.trim() } : {}),
        ...(remake.shadeProvided.trim() ? { remakeShadeProvided: remake.shadeProvided.trim() } : {}),
        ...(remake.materialPrescribed.trim() ? { remakeMaterialPrescribed: remake.materialPrescribed.trim() } : {}),
        ...(remake.materialProvided.trim() ? { remakeMaterialProvided: remake.materialProvided.trim() } : {}),
        ...(remake.returnedToLab !== null ? { remakeReturnedToLab: remake.returnedToLab } : {}),
        ...(remake.category ? { remakeCategory: remake.category } : {}),
        ...(remake.notes.trim() ? { remakeNotes: remake.notes.trim() } : {}),
        restorations: buildRestorationPayload(),
      } as Parameters<typeof mutation.mutate>[0]);
      return;
    }

    // Reset any prior "add new doctor" decision for this submission attempt.
    confirmNewDoctorRef.current = false;

    // Checkpoint 1 — duplicate DOCTOR. If the typed name strongly resembles an
    // existing doctor in this practice, ask the user which doctor they mean
    // before doing anything else.
    setCheckingDupes(true);
    try {
      const params = new URLSearchParams({
        labOrganizationId: form.labOrganizationId,
        providerOrganizationId: form.providerOrganizationId,
        doctorName: form.doctorName.trim(),
      });
      const res = await apiFetch<{ matches: DoctorMatchCandidate[] }>(
        `/cases/doctor-similarity?${params.toString()}`,
      );
      if (res.matches && res.matches.length > 0) {
        setDoctorMatches(res.matches);
        setCheckingDupes(false);
        return;
      }
    } catch (err) {
      // Non-fatal: a flaky lookup must not block creation. The server's 409
      // fallback still enforces the checkpoint on submit.
      console.warn("doctor-similarity check failed", err);
    }

    // Checkpoint 2 — duplicate PATIENT (existing behaviour).
    await runPatientCheckAndSubmit(form);
  }

  // Runs the patient-similarity checkpoint then submits. `confirmNewDoctorRef`
  // is threaded into the payload so a user who confirmed "add new doctor"
  // bypasses the server's duplicate-doctor 409 on the final submit.
  async function runPatientCheckAndSubmit(f: NewCaseFormData) {
    setCheckingDupes(true);
    try {
      const params = new URLSearchParams({
        patientFirstName: f.patientFirstName.trim(),
        patientLastName: f.patientLastName.trim(),
        providerOrganizationId: f.providerOrganizationId,
        labOrganizationId: f.labOrganizationId,
        doctorName: f.doctorName.trim(),
      });
      const res = await apiFetch<{ matches: PatientSimilarityHit[] }>(
        `/cases/patient-similarity?${params.toString()}`,
      );
      if (res.matches && res.matches.length > 0) {
        setDuplicateMatches(res.matches);
        setCheckingDupes(false);
        return;
      }
    } catch (err) {
      // Non-fatal: if the similarity check fails we still let the user
      // create the case rather than blocking on a flaky lookup.
      console.warn("patient-similarity check failed", err);
    }
    setCheckingDupes(false);
    mutation.mutate({
      ...f,
      confirmNewDoctor: confirmNewDoctorRef.current || undefined,
      restorations: buildRestorationPayload(),
    } as Parameters<typeof mutation.mutate>[0]);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-7xl mx-4 flex flex-col max-h-[94vh]"
        role="dialog"
        aria-modal="true"
        aria-label="Add case"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold">New case</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form id="new-case-assignment-form" onSubmit={handleSubmit} className="new-case-workspace px-4 py-3 overflow-y-auto">
          {orgsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">
              Loading organizations…
            </p>
          )}

          <aside className="new-case-project space-y-4" aria-label="Project information">
          <h3 className="text-sm font-semibold">Project information</h3>
          <div className="grid grid-cols-1 gap-3 [&>*]:col-span-full">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Case number
              </label>
              <div className="flex gap-2">
                <input
                  className="min-w-0 flex-1 h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono"
                  value={form.caseNumber}
                  onChange={(e) => set("caseNumber", e.target.value)}
                  placeholder={form.labOrganizationId ? "" : "Select a lab first…"}
                  required
                />
                <button
                  type="button"
                  onClick={regenerateCaseNumber}
                  disabled={!form.labOrganizationId}
                  className="shrink-0 h-9 px-3 text-xs rounded-md bg-secondary hover:bg-secondary/80 text-muted-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Regenerate
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Lab organization
              </label>
              <select
                className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                value={form.labOrganizationId}
                onChange={(e) => set("labOrganizationId", e.target.value)}
              >
                <option value="">Select lab…</option>
                {labOrgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName || o.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Practice
              </label>
              <ProviderPicker
                value={form.providerOrganizationId}
                providers={providerOrgs}
                onChange={(id) => set("providerOrganizationId", id)}
                disabled={orgsQuery.isLoading}
                parentLabOrganizationId={form.labOrganizationId || undefined}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Patient first name
              </label>
              <FieldCombobox
                value={form.patientFirstName}
                suggestions={distinctPatientFirstNames}
                onChange={(v) => set("patientFirstName", v)}
                placeholder="First"
                inputClassName="h-9 focus:ring-primary focus:border-primary"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Patient last name
              </label>
              <FieldCombobox
                value={form.patientLastName}
                suggestions={distinctPatientLastNames}
                onChange={(v) => set("patientLastName", v)}
                placeholder="Last"
                inputClassName="h-9 focus:ring-primary focus:border-primary"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Doctor name
              </label>
              <FieldCombobox
                value={form.doctorName}
                suggestions={distinctDoctorNames}
                onChange={(v) => set("doctorName", v)}
                placeholder="Dr. Smith"
                inputClassName="h-9 focus:ring-primary focus:border-primary"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Due date
              </label>
              <div className="flex gap-1.5">
                <input
                  type="date"
                  className="flex-1 min-w-0 h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={form.dueDate}
                  onChange={(e) => handleDueDateChange(e.target.value)}
                />
              </div>
              <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={hasDueTime}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setHasDueTime(checked);
                    if (!checked) set("dueTime", undefined);
                  }}
                  disabled={!form.dueDate}
                  className="h-3.5 w-3.5 rounded border-border accent-primary disabled:cursor-not-allowed"
                  aria-label="Set a specific time the case is due"
                />
                <Clock size={13} aria-hidden="true" />
                Set a specific time the case is due
              </label>
              {hasDueTime && form.dueDate && (
                <input
                  type="time"
                  className="mt-2 w-[7.5rem] h-9 px-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={form.dueTime ?? ""}
                  onChange={(e) => set("dueTime", e.target.value || undefined)}
                  aria-label="Due time (optional)"
                />
              )}
              {dueDateCapped && (
                <p className="text-[11px] text-amber-600 mt-1">
                  Capped to lab's turnaround ({labOrgs.find((o) => o.id === form.labOrganizationId)?.defaultCaseDueDays}d)
                </p>
              )}
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Priority
              </label>
              <div className="flex gap-2">
                {(["normal", "rush"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set("priority", p)}
                    className={`flex-1 h-9 rounded-md text-sm font-medium transition-colors ${
                      form.priority === p
                        ? p === "rush"
                          ? "bg-destructive/15 text-destructive border border-destructive/30"
                          : "bg-primary/10 text-primary border border-primary/30"
                        : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                    }`}
                  >
                    {p === "rush" ? "Rush" : "Normal"}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Case pan barcode{" "}
                <span className="font-normal text-muted-foreground/70">(optional)</span>
              </label>
              <input
                className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono"
                value={form.casePanBarcode ?? ""}
                onChange={(e) => set("casePanBarcode", e.target.value || undefined)}
                placeholder="Scan or type barcode…"
                autoComplete="off"
              />
              {newBarcodeChecking && (
                <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" /> Checking barcode…
                </p>
              )}
              {!newBarcodeChecking && newBarcodeConflict && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle size={11} />
                  {`This barcode is already used by an active case${newBarcodeConflict.caseNumber ? ` (Case #${newBarcodeConflict.caseNumber})` : ""}.`}
                </p>
              )}
            </div>
          </div>

          {/* ── Remake section ───────────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Remake of an existing case?
              </span>
              <button
                type="button"
                onClick={() => {
                  if (isRemake) {
                    clearRemake();
                  } else {
                    setIsRemake(true);
                    setError(null);
                  }
                }}
                className={`h-6 px-2.5 rounded-md text-xs font-medium transition-colors ${
                  isRemake
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80"
                }`}
              >
                {isRemake ? "Remake on" : "Mark as remake"}
              </button>
            </div>

            {isRemake && (
              <div className="mt-2">
                <RemakeOriginalPicker
                  labOrganizationId={form.labOrganizationId}
                  selected={remakeSelected}
                  onSelect={setRemakeSelected}
                  onClear={() => {
                    setRemakeSelected(null);
                    setRemake(blankQuestionnaire());
                  }}
                  questionnaire={remake}
                  onQuestionnaireChange={setRemake}
                  isAdmin={isPageAdmin}
                  size="sm"
                />
              </div>
            )}
          </div>

          </aside>

          {/* ── Restorations section ─────────────────────────────────────── */}
          <div className="new-case-assignment min-w-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">
                Restorations{" "}
                <span className="font-normal text-muted-foreground/70">(optional)</span>
              </span>
              <button
                type="button"
                onClick={addRestoration}
                className="h-6 px-2.5 rounded-md text-xs font-medium bg-secondary text-muted-foreground border border-transparent hover:bg-secondary/80 transition-colors inline-flex items-center gap-1"
              >
                <Plus size={11} />
                Add row
              </button>
              <button
                type="button"
                disabled={!restorationUndo || mutation.isPending}
                onClick={() => {
                  if (!restorationUndo) return;
                  setRestorations(restorationUndo);
                  setDraftConnectors(restorationConnectorUndo);
                  setRestorationUndo(null);
                  toast.success("Last draft assignment and bridge changes restored.");
                }}
                className="text-xs text-primary disabled:opacity-40"
              >
                Undo draft edit
              </button>
            </div>

            {(() => {
              const units = buildRestorationPayload() ?? [];
              const connectorState = withPonticConnectorSuggestions(draftConnectors, units);
              const encoded = serializeConnectorState(connectorState);
              const summary = toothAssignmentSummary(units, encoded);
              const validation = validateToothConnectors(encoded, units);
              return (
                <div className="@container/new-case-assignment"><div className="new-case-assignment-grid">
                  <aside className="hidden" aria-hidden="true">
                    <h3 className="text-sm font-semibold">Case details</h3>
                    <dl className="space-y-2 text-xs">
                      <div><dt className="text-muted-foreground">Case</dt><dd className="font-mono">{form.caseNumber || "Not set"}</dd></div>
                      <div><dt className="text-muted-foreground">Patient</dt><dd>{[form.patientFirstName, form.patientLastName].filter(Boolean).join(" ") || "Not set"}</dd></div>
                      <div><dt className="text-muted-foreground">Practice</dt><dd>{providerOrgs.find((org) => org.id === form.providerOrganizationId)?.displayName || providerOrgs.find((org) => org.id === form.providerOrganizationId)?.name || "Not set"}</dd></div>
                      <div><dt className="text-muted-foreground">Doctor</dt><dd>{form.doctorName || "Not set"}</dd></div>
                      <div><dt className="text-muted-foreground">Due</dt><dd>{form.dueDate || "Not set"}</dd></div>
                    </dl>
                    <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
                      Assignment edits stay in this unsaved draft until you save the case.
                    </p>
                  </aside>
                  <section className="min-w-0 bg-background p-1 sm:px-3" aria-label="Tooth and restoration assignment">
                    <h3 className="mb-2 text-sm font-semibold">Tooth &amp; Restoration Assignment</h3>
                    <ToothChart
                      assignments={units}
                      onArchSelect={(_arch, teeth) => {
                        setMultiApplyMode(true); setMultiApplyTargets(teeth);
                        setAssignmentSelectionAnchor(teeth[0]); setAssignmentTooth(null);
                      }}
                      value={[...new Set([...multiApplyTargets, ...(assignmentTooth ? [assignmentTooth] : [])])].join(", ")}
                      onChange={() => {}}
                      onToothClick={handleAssignmentToothClick}
                      crownTeeth={new Set(units.filter((unit) => unit.restorationType === "Crown").map((unit) => unit.toothNumber))}
                      ponticTeeth={new Set(units.filter((unit) => unit.restorationType === "Pontic").map((unit) => unit.toothNumber))}
                      veneerTeeth={new Set(units.filter((unit) => unit.restorationType === "Veneer").map((unit) => unit.toothNumber))}
                      missingTeeth={new Set(units.filter((unit) => unit.restorationType === "missing").map((unit) => unit.toothNumber))}
                      connectedPairs={connectorState.active}
                      connectorSuggestions={connectorState.suggested}
                      blockedConnectorPairs={incompatibleToothConnectorPairs(units)}
                      onConnectedPairsChange={(pairs) => {
                        setRestorationUndo(restorations);
                        setRestorationConnectorUndo(draftConnectors);
                        setDraftConnectors(updateConnectorChoices(connectorState, pairs));
                      }}
                      connectorIssue={!validation.valid ? validation.errors[0] : summary.unresolvedPontics.length ? "Review unconnected pontics before saving." : null}
                      summaryText={`${[...toothBridgeLabels(units, encoded), `${summary.units} units`, `${summary.groups.length} connected groups`, "Unsaved draft"].join(" · ")}`}
                    />
                    {pendingAssignmentCopy && (
                      <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="alert">
                        <p>These teeth already have assignments: {pendingAssignmentCopy.targets.map((tooth) => `#${tooth}`).join(", ")}. Replace them with the copied role, product, and shade?</p>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" className="min-h-9 rounded-md border border-amber-600/30 px-3" onClick={() => setPendingAssignmentCopy(null)}>Keep existing</button>
                          <button type="button" className="min-h-9 rounded-md bg-amber-800 px-3 font-medium text-white" onClick={() => applyQuickAssignmentCopy(pendingAssignmentCopy.targets, pendingAssignmentCopy.template)}>Replace selected assignments</button>
                        </div>
                      </div>
                    )}
                  </section>
                  <aside className="new-case-actions border-l border-border bg-background p-3 space-y-3" aria-label="Assignment summary">
                    <div>
                      <h3 className="text-sm font-semibold">Assignment summary</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {summary.units} units · {summary.crowns} prepared crowns · {summary.pontics} pontics{summary.veneers ? ` · ${summary.veneers} veneer${summary.veneers === 1 ? "" : "s"}` : ""}
                      </p>
                      {toothBridgeLabels(units, encoded).map((label) => (
                        <p key={label} className="mt-1.5 rounded-md bg-emerald-50 px-2 py-1.5 text-sm font-semibold text-emerald-900">{label}</p>
                      ))}
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold">Assigned restorations</h4>
                      {units.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">No tooth assignments yet.</p>
                      ) : (
                        <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto text-xs">
                          {units.map((unit) => (
                            <li key={`${unit.arch || unit.toothNumber}-${unit.restorationType}`} className="rounded-md bg-secondary/50 px-2 py-1.5">
                              <span className="font-semibold">{unit.arch ? `${unit.arch === "upper" ? "Upper" : "Lower"} arch` : `#${unit.toothNumber}`}</span> · {unit.restorationType}
                              <span className="block pl-5 text-muted-foreground">
                                {[unit.material, unit.shade].filter(Boolean).join(" · ") || "Product and shade need review"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold">Bridge groups</h4>
                      {summary.groups.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">No connected units.</p>
                      ) : (
                        <ul className="mt-1 space-y-1 text-xs">
                          {summary.groups.map((group) => <li key={group.join("-")} className="rounded-md bg-emerald-50 px-2 py-1.5 text-emerald-900">{group.map((tooth) => `#${tooth}`).join(" – ")}</li>)}
                        </ul>
                      )}
                    </div>
                    <div className="space-y-2 border-t border-border pt-2">
                      <h4 className="text-xs font-semibold">Case shade and copy settings</h4>
                      <button type="button" className="min-h-11 w-full rounded-md border border-primary/40 px-3 text-sm font-medium"
                        aria-pressed={multiApplyMode}
                        onClick={() => { setMultiApplyMode((active) => !active); setMultiApplyTargets([]); }}>
                        {multiApplyMode ? "Cancel tooth selection" : "Select teeth, then assign"}
                      </button>
                      {multiApplyMode && (
                        <button type="button" disabled={multiApplyTargets.length === 0}
                          className="min-h-11 w-full rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
                          onClick={() => setAssignmentTooth(multiApplyTargets[0])}>
                          Assign {multiApplyTargets.length} selected {multiApplyTargets.length === 1 ? "tooth" : "teeth"}
                        </button>
                      )}
                      <label className="block space-y-1 text-xs">
                        <span className="text-muted-foreground">Default shade for new assignments</span>
                        <input
                          aria-label="Case shade for new assignments"
                          value={assignmentCaseShade}
                          onChange={(event) => setAssignmentCaseShade(event.target.value)}
                          placeholder="e.g. A2"
                          className="min-h-9 w-full rounded-md border border-border bg-background px-2"
                        />
                      </label>
                      {assignmentCopyTemplate ? (
                        <>
                          <p className="rounded-md bg-primary/5 px-2 py-1.5 text-xs text-primary" role="status">
                            Copy: {assignmentCopyTemplate.restorationType} · {assignmentCopyTemplate.material || "Material needed"} · {assignmentCopyTemplate.shade || "Case shade"}
                          </p>
                          <p className="text-[11px] text-muted-foreground">Ctrl/Cmd-click a tooth to copy. Shift-click to select a same-arch range, then use Assign selected teeth.</p>
                          {multiApplyMode && (
                          <button type="button" disabled={multiApplyTargets.length === 0}
                              className="min-h-9 w-full rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
                              onClick={() => requestQuickAssignmentCopy(multiApplyTargets)}>
                              Apply to {multiApplyTargets.length} selected {multiApplyTargets.length === 1 ? "tooth" : "teeth"}
                            </button>
                          )}
                          <button type="button" className="text-xs text-muted-foreground underline"
                            onClick={() => { setAssignmentCopyTemplate(null); setAssignmentCopyAnchor(null); setMultiApplyTargets([]); }}>
                            Clear copy settings
                          </button>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">Edit or assign a crown, pontic or veneer to set up reusable copy settings.</p>
                      )}
                    </div>
                    {(!validation.valid || summary.unresolvedPontics.length > 0) && (
                      <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950" role="alert">
                        {!validation.valid && validation.errors.map((message) => <p key={message}>{message}</p>)}
                        {summary.unresolvedPontics.length > 0 && <p>Connect or review pontics {summary.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")} before saving.</p>}
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">Create case saves these assignments. Until then, all changes stay in this draft.</p>
                  </aside>
                </div></div>
              );
            })()}
            {assignmentTooth && <ToothActionDialog key={assignmentTooth} toothId={assignmentTooth}
              catalog={assignmentCatalog.data?.data}
              selectedTeeth={multiApplyMode ? multiApplyTargets : [assignmentTooth]}
              selectionArch={selectedToothArch(multiApplyMode ? multiApplyTargets : [assignmentTooth])}
              locallySelectedType={restorations.some((row) => row.restorationType === "missing" && row.toothNumber === assignmentTooth) ? "missing" : undefined}
              caseShade={assignmentCaseShade || null}
              isPending={mutation.isPending}
              restorations={restorations.filter((row) => isArchBasedRestoration(row) || (!multiApplyMode && row.assignmentRole && parseToothField(row.toothNumber).has(assignmentTooth)))
                .map((row) => ({ ...row, restorationType: row.assignmentRole || row.restorationType, caseId: "", unitPrice: 0, quantity: 1 })) as CaseRestoration[]}
              materialOptions={assignmentCatalog.data?.data
                ? catalogToothMaterialOptions(assignmentCatalog.data.data).map((option) => ({ key: option.restorationSubtype, label: option.label, parentLabel: option.parentLabel }))
                : getCatalogMaterialsForRestoration(undefined, { restorationType: "Crown" })}
              groupTeeth={toothAssignmentSummary(buildRestorationPayload() ?? [], serializeConnectorState(withPonticConnectorSuggestions(draftConnectors, buildRestorationPayload() ?? []))).groups.find((group) => group.includes(assignmentTooth))}
              onClose={() => setAssignmentTooth(null)} onConfirm={applyManualAssignment} />}

            {restorations.length > 0 && (
              <details className="mt-3 rounded-md border border-border p-2" open={rowEditorOpen} onToggle={(event) => setRowEditorOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer text-xs font-medium">Restoration row editor · {restorations.filter((row) => row.restorationType !== "missing").length} rows</summary>
              <div className="mt-2 space-y-2">
                {restorations.filter((row) => row.restorationType !== "missing").map((r, idx) => (
                  <div key={r.id} className="rounded-lg border border-border bg-secondary/40 p-2.5 space-y-2">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-medium text-muted-foreground">Row {idx + 1}</span>
                      <button
                        type="button"
                        className="text-[11px] text-primary ml-auto mr-2"
                        onClick={() => {
                          setRestorationUndo(restorations);
                          setRestorations((previous) => [
                            ...previous,
                            { ...r, id: crypto.randomUUID(), toothNumber: "" },
                          ]);
                        }}
                      >
                        Copy values to new row
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRestoration(r.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label="Remove restoration"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                          Case Type → Subtype → Material <span className="text-destructive">*</span>
                        </label>
                        <CatalogRestorationPicker
                          labOrganizationId={form.labOrganizationId}
                          restorationType={r.restorationType}
                          material={r.material}
                          restorationSubtype={r.restorationSubtype}
                          implantDetails={r}
                          onImplantChange={(details) => IMPLANT_FIELDS.forEach((key) => updateRestoration(r.id, key, details[key] ?? ""))}
                          compact
                          onChange={(next) => {
                            updateRestoration(r.id, "restorationType", next.restorationType);
                            updateRestoration(r.id, "material", next.material);
                            updateRestoration(r.id, "restorationSubtype", next.restorationSubtype ?? "");
                            if (isRemovableRestorationType(next.restorationType)) {
                              updateRestoration(r.id, "toothNumber", "");
                            }
                            if (!isArchBasedRestoration(next)) {
                              updateRestoration(r.id, "arch", "");
                            }
                          }}
                        />
                      </div>
                      {!isRemovableRestorationType(r.restorationType) && (
                      <div>
                        <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                          Tooth # <span className="text-destructive">*</span>
                        </label>
                        <input
                          type="text"
                          value={r.toothNumber}
                          onChange={(e) => updateRestoration(r.id, "toothNumber", e.target.value)}
                          placeholder="e.g. 3, 14"
                          className="w-full h-8 px-2 rounded-md bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono"
                        />
                      </div>
                      )}
                      {!isArchBasedRestoration(r) && (
                        <div className="col-span-2 space-y-2">
                          <label className="block text-[11px] font-medium text-muted-foreground">
                            Tooth role (not inferred from the selected teeth)
                            <select
                              aria-label={`Tooth role for row ${idx + 1}`}
                              value={r.assignmentRole ?? ""}
                              onChange={(e) => updateRestoration(r.id, "assignmentRole", e.target.value)}
                              className="ml-2 h-8 px-2 rounded-md bg-background text-xs border border-border"
                            >
                              <option value="">Needs review</option>
                              <option value="Crown">Prepared crown</option>
                              <option value="Pontic">Pontic</option>
                              <option value="Veneer">Veneer</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            className="text-xs text-primary"
                            onClick={() => setDraftChartRow(draftChartRow === r.id ? null : r.id)}
                          >
                            {draftChartRow === r.id ? "Hide chart" : "Select multiple teeth on chart"}
                          </button>
                          {draftChartRow === r.id && (
                            <ToothChart
                              value={r.toothNumber}
                              onChange={(value) => updateRestoration(r.id, "toothNumber", value)}
                              crownTeeth={r.assignmentRole === "Crown" ? parseToothField(r.toothNumber) : undefined}
                              ponticTeeth={r.assignmentRole === "Pontic" ? parseToothField(r.toothNumber) : undefined}
                              veneerTeeth={r.assignmentRole === "Veneer" ? parseToothField(r.toothNumber) : undefined}
                            />
                          )}
                        </div>
                      )}
                      {isArchBasedRestoration(r) && (
                        <div>
                          <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                            Arch <span className="text-destructive">*</span>
                          </label>
                          <select
                            aria-label={`Arch for restoration row ${idx + 1}`}
                            value={r.arch ?? ""}
                            onChange={(e) =>
                              updateRestoration(
                                r.id,
                                "arch",
                                e.target.value as string,
                              )
                            }
                            className="w-full h-8 px-2 rounded-md bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                          >
                            <option value="">Select arch…</option>
                            {ARCH_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div>
                        <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                          Shade
                        </label>
                        <select
                          value={r.shade}
                          onChange={(e) => updateRestoration(r.id, "shade", e.target.value)}
                          className="w-full h-8 px-2 rounded-md bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        >
                          <option value="">—</option>
                          {SHADES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                          Qty
                        </label>
                        <input
                          type="number"
                          min={1}
                            value={r.assignmentRole ? "1" : r.quantity}
                            disabled={!!r.assignmentRole}
                          onChange={(e) => updateRestoration(r.id, "quantity", e.target.value)}
                          className="w-full h-8 px-2 rounded-md bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              </details>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

        </form>
          <div className="flex shrink-0 justify-end gap-3 border-t border-border bg-card px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-6 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="new-case-assignment-form"
              disabled={mutation.isPending || checkingDupes}
              className="h-10 min-w-44 px-6 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
            >
              {(mutation.isPending || checkingDupes) && (
                <Loader2 size={12} className="animate-spin" />
              )}
              {checkingDupes
                ? "Checking…"
                : mutation.isPending
                ? "Creating…"
                : isRemake && remakeSelected
                ? "Create remake"
                : "Create case"}
            </button>
          </div>
      </div>

      {doctorMatches && (
        <DoctorConfirmationModal
          matches={doctorMatches}
          typedName={form.doctorName.trim()}
          onCancel={() => setDoctorMatches(null)}
          onUseExisting={(candidate) => {
            // The user picked an existing doctor — adopt that exact name and
            // continue. confirmNewDoctor bypasses the server's doctor 409 since
            // the decision is now made.
            confirmNewDoctorRef.current = true;
            setForm((f) => ({ ...f, doctorName: candidate.doctorName }));
            setDoctorMatches(null);
            void runPatientCheckAndSubmit({
              ...form,
              doctorName: candidate.doctorName,
            });
          }}
          onAddNew={() => {
            // The user confirmed this really is a new, distinct doctor.
            confirmNewDoctorRef.current = true;
            setDoctorMatches(null);
            void runPatientCheckAndSubmit(form);
          }}
        />
      )}
      {duplicateMatches && (
        <PossibleDuplicateModal
          matches={duplicateMatches}
          patientFirstName={form.patientFirstName}
          patientLastName={form.patientLastName}
          isSubmitting={mutation.isPending}
          isAdmin={isPageAdmin}
          onCancel={() => setDuplicateMatches(null)}
          onProceedAsNew={() => {
            setDuplicateMatches(null);
            mutation.mutate({ ...form, confirmNewDoctor: confirmNewDoctorRef.current || undefined, restorations: buildRestorationPayload() } as Parameters<typeof mutation.mutate>[0]);
          }}
          onProceedAsRemake={(decision) => {
            // Omit caseNumber so the server assigns the suffixed number
            // (e.g. "26-11B") automatically based on the original case.
            const { caseNumber: _ignored, ...formWithoutCaseNumber } = form;
            mutation.mutate({ ...formWithoutCaseNumber, ...decision, confirmNewDoctor: confirmNewDoctorRef.current || undefined, restorations: buildRestorationPayload() } as Parameters<typeof mutation.mutate>[0]);
          }}
        />
      )}
    </div>
  );
}

// Bumped to v3 when the type filter switched from caseType (restorative/removable/ortho)
// to category (crown_bridge/implants/zirconia/removable/other) so stale v2 values
// (which store caseType keys) don't silently hide all cases on first load after deploy.
// Bumped to v4 when Status/priority/type became multi-select: those keys now hold
// string arrays (empty = "all") instead of a single value, so a stale v3 blob must
// not be rehydrated into the new controls.
const CASES_FILTER_STORAGE_KEY = "cases_filters_v4";
const CASES_SCROLL_STORAGE_KEY = "cases_scroll_v1";
const CASES_ITERO_BATCH_KEY = "cases_itero_batch_v1";

type DateRangeFilter = CaseDateRangeFilter;

/**
 * Coerce a persisted multi-select filter value into a clean string array.
 * Tolerates a legacy single value ("received" / "all") so a hand-seeded or
 * half-migrated blob can't crash rehydration; "all" collapses to the empty
 * array, which is how every multi-select filter spells "no filtering".
 */
function readMultiFilter(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v !== "all");
  }
  if (typeof value === "string" && value !== "" && value !== "all") return [value];
  return [];
}

function readCasesFilters(): {
  search: string;
  statusFilters: string[];
  priorityFilters: string[];
  caseTypeFilters: string[];
  dateRangeFilter: DateRangeFilter;
  customStartDate: string;
  customEndDate: string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
} {
  try {
    const raw = sessionStorage.getItem(CASES_FILTER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const restored = { ...parsed };
      // The "Received" column was removed, so a persisted sortKey of
      // "receivedAt" no longer maps to any header. Fall back to Created
      // rather than leaving an invisible sort the user can't see or clear.
      if (restored.sortKey === "receivedAt") restored.sortKey = "createdAt";
      return {
        ...restored,
        statusFilters: readMultiFilter(restored.statusFilters),
        priorityFilters: readMultiFilter(restored.priorityFilters),
        caseTypeFilters: readMultiFilter(restored.caseTypeFilters),
      };
    }
  } catch {}
  return {
    search: "",
    statusFilters: [],
    priorityFilters: [],
    caseTypeFilters: [],
    dateRangeFilter: "all",
    customStartDate: "",
    customEndDate: "",
    sortKey: "createdAt",
    sortDir: "desc",
  };
}

function readIteroActiveBatch(): { batchId: string; caseIds: string[]; importedAt: string; label: string } | null {
  try {
    const raw = sessionStorage.getItem(CASES_ITERO_BATCH_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

// ─── 3-step case deletion modal ───────────────────────────────────────────────
// Step 1 ("pin")     — caller enters admin PIN; /cases/delete-initiate is hit,
//                       server validates PIN, emails OTP to lab owner, returns token.
// Step 2 ("confirm") — "Are you sure?" confirmation before consuming the OTP.
// Step 3 ("otp")     — caller enters emailed code; /cases/bulk-delete is hit with
//                       token + OTP, server verifies both and soft-deletes.
//                       (Wire field is still named `smsOtpCode` for backward
//                       compatibility with older deployed servers/clients.)
export function CaseDeleteModal({
  caseIds,
  onClose,
  onSuccess,
}: {
  caseIds: string[];
  onClose: () => void;
  onSuccess: (deletedCount: number) => void;
}) {
  const { user } = useAuth();
  const [step, setStep] = useState<"pin" | "confirm" | "otp">("pin");
  const [pin, setPin] = useState("");
  const [otp, setOtp] = useState("");
  const [deleteSessionToken, setDeleteSessionToken] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(600);

  const securityConfigQuery = useQuery({
    queryKey: ["admin-security-config"],
    queryFn: () =>
      apiFetch<{ ok: boolean; adminPinConfigured: boolean; adminPinIsDefault: boolean }>(
        "/admin/security/config",
      ),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (step !== "otp") return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [step]);

  const label = `${caseIds.length} case${caseIds.length !== 1 ? "s" : ""}`;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  async function submitPin() {
    if (!pin.trim() || isPending) return;
    if (caseIds.length === 0) {
      setError("No cases selected. Please select cases from the list first.");
      return;
    }
    setIsPending(true);
    setError(null);
    setDeleteSessionToken(null);
    setRecipientEmail(null);
    try {
      const r = await apiFetch<{
        deleteSessionToken: string;
        maskedRecipient: string;
      }>("/cases/delete-initiate", {
        method: "POST",
        body: JSON.stringify({ adminPin: pin.trim(), caseIds }),
      });
      setDeleteSessionToken(r.deleteSessionToken);
      setRecipientEmail(r.maskedRecipient);
      setStep("confirm");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Incorrect PIN.");
    } finally {
      setIsPending(false);
    }
  }

  async function submitOtp() {
    if (!otp.trim() || !deleteSessionToken || isPending) return;
    setIsPending(true);
    setError(null);
    try {
      const r = await apiFetch<{ deletedCount: number }>("/cases/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ caseIds, deleteSessionToken, smsOtpCode: otp.trim() }),
      });
      onSuccess(r.deletedCount);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Incorrect code or session expired.");
    } finally {
      setIsPending(false);
    }
  }

  async function resendCode() {
    if (!pin || isPending) return;
    setIsPending(true);
    setError(null);
    setDeliveryError(null);
    try {
      const r = await apiFetch<{
        deleteSessionToken: string;
        maskedRecipient: string;
      }>("/cases/delete-initiate", {
        method: "POST",
        body: JSON.stringify({ adminPin: pin.trim(), caseIds }),
      });
      setDeleteSessionToken(r.deleteSessionToken);
      setRecipientEmail(r.maskedRecipient);
      setOtp("");
      setSecondsLeft(600);
    } catch (e: unknown) {
      setDeleteSessionToken(null);
      setRecipientEmail(null);
      setOtp("");
      setDeliveryError(e instanceof Error ? e.message : "Could not send the email code. Fix the issue and retry.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
        role="dialog"
        aria-modal="true"
        aria-label="Delete cases"
      >
        {step === "pin" && (
          <>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-destructive">Delete {label}</h2>
              <button type="button" onClick={onClose} disabled={isPending} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {securityConfigQuery.data && !securityConfigQuery.data.adminPinConfigured && (
                <div className="flex items-start gap-2.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs leading-relaxed">
                    <p className="font-medium">Admin PIN not configured</p>
                    <p>
                      <code className="font-mono">PLATFORM_ADMIN_PIN</code> is not set on this server.
                      Case deletion requires a PIN.{" "}
                      <a
                        href="/settings?tab=platform-admin"
                        className="underline hover:no-underline"
                        onClick={onClose}
                      >
                        Go to Settings → Platform Admin
                      </a>{" "}
                      to configure it, or set the env var and redeploy.
                    </p>
                  </div>
                </div>
              )}
              {securityConfigQuery.data?.adminPinConfigured && securityConfigQuery.data.adminPinIsDefault && (
                <div className="flex items-start gap-2.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs leading-relaxed">
                    <p className="font-medium">Using default PIN (development only)</p>
                    <p>
                      The admin PIN is currently the insecure default. Set{" "}
                      <code className="font-mono">PLATFORM_ADMIN_PIN</code> before publishing to
                      production.
                    </p>
                  </div>
                </div>
              )}
              {user?.role === "owner" && !user?.email && (
                <div className="flex items-start gap-2.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-3 text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs leading-relaxed">
                    <p className="font-medium">No email address on file</p>
                    <p>
                      Case deletion sends a confirmation code to the lab owner's email. Your account has no email address.{" "}
                      <a
                        href="/settings?tab=profile"
                        className="underline hover:no-underline"
                        onClick={onClose}
                      >
                        Go to Settings → Profile to add one
                      </a>
                      {" "}before proceeding.
                    </p>
                  </div>
                </div>
              )}
              <p className="text-sm text-muted-foreground">Enter the admin PIN to begin. A verification code will be sent to the lab owner's email.</p>
              <div className="space-y-1.5">
                <label htmlFor="cdm-pin" className="text-xs font-medium text-muted-foreground">Admin PIN</label>
                <input
                  id="cdm-pin"
                  type="password"
                  autoFocus
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitPin(); }}
                  placeholder="••••••"
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  disabled={isPending}
                />
              </div>
              {error && (
                <div role="alert" data-testid="case-delete-pin-error" className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {error.toLowerCase().includes("email address") ? (
                    <>
                      {error}{" "}
                      <a
                        href="/settings?tab=profile"
                        className="underline hover:no-underline font-medium"
                        onClick={onClose}
                      >
                        Go to Settings → Profile
                      </a>
                    </>
                  ) : (
                    error
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button type="button" onClick={onClose} disabled={isPending} className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button type="button" onClick={() => void submitPin()} disabled={isPending || !pin.trim()} className="flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5">
                {isPending && <Loader2 size={13} className="animate-spin" />}
                Next
              </button>
            </div>
          </>
        )}
        {step === "confirm" && (
          <>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-destructive">Confirm deletion</h2>
              <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
                  <AlertTriangle size={17} className="text-destructive" />
                </div>
                <div>
                  <p className="text-sm font-medium">Delete {label}?</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    The verification email was sent to{" "}
                    <span data-testid="case-delete-recipient" className="font-medium text-foreground">
                      {recipientEmail ?? "the lab owner's email"}
                    </span>
                    . This will permanently remove {label} from the lab and cannot be undone.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button type="button" onClick={onClose} className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                type="button"
                onClick={() => { setStep("otp"); setSecondsLeft(600); }}
                className="flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 inline-flex items-center justify-center gap-1.5"
              >
                Continue to code
              </button>
            </div>
          </>
        )}
        {step === "otp" && (
          <>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-destructive">Enter email code</h2>
              <button type="button" onClick={onClose} disabled={isPending} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-muted-foreground">
                A 6-digit code was sent to{" "}
                <span data-testid="case-delete-recipient" className="font-medium text-foreground">
                  {recipientEmail ?? "the lab owner's email"}
                </span>
                . Enter it to confirm deletion of {label}.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="cdm-otp" className="text-xs font-medium text-muted-foreground">
                  Email code{" "}
                  <span className={secondsLeft === 0 ? "text-destructive" : "text-muted-foreground"}>
                    ({secondsLeft === 0 ? "expired" : `${mm}:${ss}`})
                  </span>
                </label>
                <input
                  id="cdm-otp"
                  type="text"
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitOtp(); }}
                  placeholder="123456"
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 tracking-widest text-center font-mono"
                  disabled={isPending}
                />
              </div>
              {error && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>}
              {deliveryError && (
                <p role="alert" data-testid="case-delete-delivery-error" className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {deliveryError} No new code was sent. Correct the issue above, then retry sending the code.
                </p>
              )}
              <button type="button" onClick={() => void resendCode()} disabled={isPending} className="text-xs text-primary hover:underline disabled:opacity-50">
                {deliveryError ? "Retry sending code" : "Resend code"}
              </button>
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button type="button" onClick={onClose} disabled={isPending} className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                type="button"
                onClick={() => void submitOtp()}
                disabled={isPending || !deleteSessionToken || otp.length < 6 || secondsLeft === 0}
                className="flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {isPending && <Loader2 size={13} className="animate-spin" />}
                Delete {label}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
export default function CasesPage() {
  const [, setLocation] = useLocation();
  const urlSearch = useSearch();
  const { user } = useAuth();
  const isPageAdmin = user?.role === "admin" || user?.role === "owner";
  const overviewQuery = useCasesOverview();

  const initialFilters = useRef(readCasesFilters());

  const [search, setSearch] = useState(initialFilters.current.search);
  const [barcodeFilter, setBarcodeFilter] = useState("");
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [localDate, setLocalDate] = useState(() => formatLocalCalendarDate(new Date()));
  useEffect(() => {
    if (!overdueOnly) return;
    const updateLocalDate = () => setLocalDate(formatLocalCalendarDate(new Date()));
    const timer = setInterval(updateLocalDate, 60_000);
    window.addEventListener("focus", updateLocalDate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", updateLocalDate);
    };
  }, [overdueOnly]);

  // Debounced version of the search string — used to key the server-search
  // query so we don't fire a request on every keystroke. While these differ,
  // the visible input is newer than the committed worklist query.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);
  const trimmedSearch = search.trim();
  const isSearchDebouncing = trimmedSearch !== debouncedSearch;

  const barcodeFilterTrimmed = barcodeFilter.trim();
  const barcodeFilterActive = barcodeFilterTrimmed.length > 0;

  // Multi-select toolbar filters. An empty array means "All" (no filtering);
  // a non-empty array shows the union of the checked values.
  const [statusFilters, setStatusFilters] = useState<string[]>(initialFilters.current.statusFilters);
  const [priorityFilters, setPriorityFilters] = useState<string[]>(initialFilters.current.priorityFilters);
  const [caseTypeFilters, setCaseTypeFilters] = useState<string[]>(initialFilters.current.caseTypeFilters);
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangeFilter>(initialFilters.current.dateRangeFilter);
  const [customStartDate, setCustomStartDate] = useState<string>(initialFilters.current.customStartDate);
  const [showRangeWindow, setShowRangeWindow] = useState(false);
  const [caseExpanded, setCaseExpanded] = useState(false);
  const [customEndDate, setCustomEndDate] = useState<string>(initialFilters.current.customEndDate);
  const [sortKey, setSortKey] = useState<SortKey>(initialFilters.current.sortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialFilters.current.sortDir);
  const [selected, setSelected] = useState<LabCase | null>(null);
  const [keyboardActiveCaseId, setKeyboardActiveCaseId] = useState<string | null>(null);
  const rowSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingSelection, setPrintingSelection] = useState(false);
  // Shift-click range selection anchor: the last normally clicked case's ID.
  // Stored by ID (not index) so it survives re-sorts; resolved to an index in
  // the current `filtered` array at click time.
  const selectionAnchorIdRef = useRef<string | null>(null);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [showBulkStatusModal, setShowBulkStatusModal] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState<string>("");
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [bulkDeleteCaseIds, setBulkDeleteCaseIds] = useState<string[]>([]);

  const [iteroActiveBatch, setIteroActiveBatch] = useState<{ batchId: string; caseIds: string[]; importedAt: string; label: string } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRestoredRef = useRef(false);
  const lastProcessedCaseIdRef = useRef<string | null>(null);
  const casesTableRef = useRef<HTMLTableElement>(null);

  const qc = useQueryClient();

  const handleRefresh = () => {
    void overviewQuery.refetch();
    if (page === 1) {
      void listQuery.refetch();
    } else {
      setLoadedRows([]);
      setPagination({ criteria: criteriaQuery, page: 1 });
    }
    qc.invalidateQueries({ queryKey: ["organizations"] });
    qc.invalidateQueries({ queryKey: ["invoice-for-case"] });
    qc.invalidateQueries({ queryKey: ["invoice-detail"] });
    if (selected?.id) {
      qc.invalidateQueries({ queryKey: ["case", selected.id] });
    }
  };

  // Whether any record-hiding filter is currently active. Sort order and column
  // settings are display preferences and intentionally excluded.
  const hasActiveFilters =
    trimmedSearch.length > 0 ||
    statusFilters.length > 0 ||
    priorityFilters.length > 0 ||
    caseTypeFilters.length > 0 ||
    overdueOnly ||
    (dateRangeFilter !== "all" &&
      (dateRangeFilter !== "custom" || (!!customStartDate && !!customEndDate))) ||
    barcodeFilter.trim().length > 0 ||
    conflictsOnly ||
    iteroActiveBatch !== null;

  type CaseListPage = { rows: LabCase[]; total: number; salesTotal: string; page: number; pageSize: number; hasMore: boolean };
  const [pagination, setPagination] = useState({ criteria: "", page: 1 });
  const [loadedRows, setLoadedRows] = useState<LabCase[]>([]);
  const criteriaQuery = useMemo(() => {
    // Stop observing the previous search as soon as the input changes. This
    // prevents its rows, count, empty state, and late response from being
    // presented as results for text the user can no longer see.
    if (isSearchDebouncing) return "";
    const params = new URLSearchParams();
    if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
    if (barcodeFilterTrimmed) params.set("barcode", barcodeFilterTrimmed);
    statusFilters.forEach((value) => params.append("status", value));
    priorityFilters.forEach((value) => params.append("priority", value));
    caseTypeFilters.forEach((value) => params.append("caseType", value));
    if (conflictsOnly) params.set("conflictsOnly", "true");
    if (overdueOnly) {
      params.set("overdueOnly", "true");
      params.set("localDate", localDate);
    }
    if (iteroActiveBatch) iteroActiveBatch.caseIds.forEach((id) => params.append("caseId", id));
    // A custom range is intentionally inert until both calendar bounds exist.
    // Other active filters may still run while the user is filling the dates,
    // but must not send a one-sided range that the bounded API rejects.
    const range = dateRangeFilter === "custom" && (!customStartDate || !customEndDate)
      ? { startDate: null, endDate: null }
      : computeCaseDateRange(dateRangeFilter, customStartDate, customEndDate);
    const calendar = (date: Date | null) => date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : "";
    if (range.startDate) params.set("receivedStart", calendar(range.startDate));
    // API takes an inclusive calendar end, while the UI helper returns exclusive.
    if (range.endDate) {
      const inclusiveEnd = new Date(range.endDate);
      inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
      params.set("receivedEnd", calendar(inclusiveEnd));
    }
    params.set("sortKey", sortKey);
    params.set("sortDir", sortDir);
    params.set("pageSize", "10");
    return params.toString();
  }, [hasActiveFilters, isSearchDebouncing, debouncedSearch, barcodeFilterTrimmed, statusFilters, priorityFilters, caseTypeFilters, conflictsOnly, overdueOnly, localDate, iteroActiveBatch, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir]);
  const page = pagination.criteria === criteriaQuery ? pagination.page : 1;
  useEffect(() => {
    if (pagination.criteria !== criteriaQuery) {
      setPagination({ criteria: criteriaQuery, page: 1 });
    }
  }, [criteriaQuery, pagination.criteria]);
  const activeQuery = useMemo(() => {
    const params = new URLSearchParams(criteriaQuery);
    params.set("page", String(page));
    return params.toString();
  }, [criteriaQuery, page]);
  const listQuery = useQuery({
    queryKey: !isSearchDebouncing ? ["cases", activeQuery] : ["cases", "inactive"],
    // Accepting the legacy array here keeps cached/test fixtures from crashing
    // during the response-contract rollout; production requests use metadata.
    queryFn: async ({ signal }) => {
      const query = activeQuery;
      const response = await apiFetch<CaseListPage | LabCase[]>(`/cases/worklist?${query}`, { signal });
      const result = Array.isArray(response)
        ? { rows: response, total: response.length, salesTotal: "0.00", page, pageSize: response.length, hasMore: false }
        : response;
      return { ...result, query };
    },
    enabled: !isSearchDebouncing,
    refetchInterval: !isSearchDebouncing ? 60_000 : false,
    refetchOnWindowFocus: !isSearchDebouncing,
  });
  const { isLoading, error, isFetching } = listQuery;
  const worklistPending = isSearchDebouncing || isLoading;
  const data = loadedRows;
  useEffect(() => {
    const nextRows = listQuery.data?.rows;
    if (isSearchDebouncing || !listQuery.data || !Array.isArray(nextRows) || listQuery.data.query !== activeQuery) return;
    setLoadedRows((previous) => listQuery.data!.page === 1
      ? nextRows
      : [...previous.filter((row) => !nextRows.some((next) => next.id === row.id)), ...nextRows]);
  }, [activeQuery, isSearchDebouncing, listQuery.data, listQuery.dataUpdatedAt]);
  useEffect(() => {
    setLoadedRows([]);
  }, [trimmedSearch, barcodeFilterTrimmed, statusFilters, priorityFilters, caseTypeFilters, conflictsOnly, overdueOnly, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir, iteroActiveBatch]);

  // Reset every in-scope Cases filter to its default and drop the persisted
  // entries so the list reloads unfiltered in place. Sort order is left as-is.
  const resetFilters = useCallback(() => {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilters([]);
    setPriorityFilters([]);
    setCaseTypeFilters([]);
    setDateRangeFilter("all");
    setCustomStartDate("");
    setCustomEndDate("");
    setBarcodeFilter("");
    setConflictsOnly(false);
    setOverdueOnly(false);
    setIteroActiveBatch(null);
    try {
      sessionStorage.removeItem(CASES_FILTER_STORAGE_KEY);
      sessionStorage.removeItem(CASES_ITERO_BATCH_KEY);
    } catch {}
  }, []);

  const applySavedCaseView = useCallback((view: CaseSavedView) => {
    setSearch(view.filters.search);
    setStatusFilters([...view.filters.statusFilters]);
    setPriorityFilters([]);
    setCaseTypeFilters([]);
    setBarcodeFilter("");
    setConflictsOnly(false);
    setOverdueOnly(false);
    setIteroActiveBatch(null);
    try { sessionStorage.removeItem(CASES_ITERO_BATCH_KEY); } catch {}
    setShowRangeWindow(false);
    setDateRangeFilter((view.filters.desktop?.dateRangeFilter ?? "all") as DateRangeFilter);
    setCustomStartDate(view.filters.desktop?.customStartDate ?? "");
    setCustomEndDate(view.filters.desktop?.customEndDate ?? "");
    setSelectedIds(new Set());
    setSelectedSavedViewId(view.id);
    if (!view.filters.desktop && view.filters.mobile) {
      toast.info("This view was saved on mobile. Search and status were applied; desktop dates were cleared because desktop uses a different date field.");
    }
  }, []);

  // Clear persisted Cases filters when leaving the /cases route entirely
  // (component unmount). Opening/closing the case-detail drawer stays on /cases
  // and keeps this component mounted, so filters survive that workflow per the
  // persist-filters behavior; only navigating to another section clears them.
  useEffect(() => {
    return () => {
      if (rowSelectionTimerRef.current) clearTimeout(rowSelectionTimerRef.current);
      try {
        sessionStorage.removeItem(CASES_FILTER_STORAGE_KEY);
        sessionStorage.removeItem(CASES_ITERO_BATCH_KEY);
      } catch {}
    };
  }, []);

  const orgsQuery = useQuery({
    queryKey: ["organizations", { includeLabPractices: true }],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeLabPractices=true"),
  });
  const providerOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((o) => o.type !== "lab"),
    [orgsQuery.data],
  );

  const pageLabOrgId = useMemo(
    () => (orgsQuery.data ?? []).find((o) => o.type === "lab")?.id ?? null,
    [orgsQuery.data],
  );
  const [selectedSavedViewId, setSelectedSavedViewId] = useState("");
  // Electron does not implement window.prompt, so naming uses an in-page dialog.
  const [savedViewNameDialog, setSavedViewNameDialog] = useState<
    { mode: "save" } | { mode: "rename"; viewId: string } | null
  >(null);
  const [savedViewNameDraft, setSavedViewNameDraft] = useState("");
  const savedViewsQuery = useQuery({
    queryKey: ["cases", "saved-views", pageLabOrgId],
    enabled: !!pageLabOrgId,
    queryFn: () => apiFetch<CaseSavedView[]>(
      `/cases/saved-views?labOrganizationId=${encodeURIComponent(pageLabOrgId!)}`,
    ),
  });
  const saveCaseViewMutation = useMutation({
    mutationFn: (name: string) => {
      if (!pageLabOrgId) throw new Error("Select a lab before saving a view.");
      const filters: CaseSavedViewFilters = {
        search: search.trim(),
        statusFilters: [...statusFilters],
        desktop: { dateRangeFilter, customStartDate, customEndDate },
      };
      return apiFetch<CaseSavedView>("/cases/saved-views", {
        method: "POST",
        body: JSON.stringify({ labOrganizationId: pageLabOrgId, name, filters }),
      });
    },
    onSuccess: (view) => {
      setSelectedSavedViewId(view.id);
      setSavedViewNameDialog(null);
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", pageLabOrgId] });
      toast.success(`Saved view “${view.name}”.`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save this view."),
  });
  const updateCaseViewFiltersMutation = useMutation({
    mutationFn: ({ id, filters }: { id: string; filters: CaseSavedViewFilters }) => {
      if (!pageLabOrgId) throw new Error("Select a lab before updating a view.");
      return apiFetch<CaseSavedView>(`/cases/saved-views/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ labOrganizationId: pageLabOrgId, filters }),
      });
    },
    onSuccess: (view) => {
      setSelectedSavedViewId(view.id);
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", pageLabOrgId] });
      toast.success(`Updated shared view “${view.name}” for everyone in your lab.`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update this view."),
  });
  const renameCaseViewMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => {
      if (!pageLabOrgId) throw new Error("Select a lab before renaming a view.");
      return apiFetch<CaseSavedView>(`/cases/saved-views/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ labOrganizationId: pageLabOrgId, name }),
      });
    },
    onSuccess: (view) => {
      setSavedViewNameDialog(null);
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", pageLabOrgId] });
      toast.success(`Renamed view to “${view.name}”.`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not rename this view."),
  });
  const deleteCaseViewMutation = useMutation({
    mutationFn: (id: string) => {
      if (!pageLabOrgId) throw new Error("Select a lab before removing a view.");
      return apiFetch<null>(
        `/cases/saved-views/${encodeURIComponent(id)}?labOrganizationId=${encodeURIComponent(pageLabOrgId)}`,
        { method: "DELETE" },
      );
    },
    onSuccess: (_result, id) => {
      if (selectedSavedViewId === id) setSelectedSavedViewId("");
      void qc.invalidateQueries({ queryKey: ["cases", "saved-views", pageLabOrgId] });
      toast.success("Saved view removed.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not remove this view."),
  });

  const bulkLocationsQuery = useQuery<Array<{ id: string; value: string; label: string }>>({
    queryKey: ["locations", pageLabOrgId, "active"],
    enabled: !!pageLabOrgId,
    queryFn: async () => {
      try {
        const rows = await apiFetch<Array<{ id: string; code: string; name: string; status: string }>>(
          `/locations?organizationId=${pageLabOrgId}&activeOnly=true`,
        );
        if (!Array.isArray(rows) || rows.length === 0) return [];
        // Carry the unique station `id` for the <select> option value + React
        // key so two custom stations mapped to the same workflow stage stay
        // distinct (mobile already does this). `value` is the mapped stage that
        // gets sent to the API. Sending the free-form code broke custom stations.
        return rows.map((r) => ({ id: r.id, value: r.status, label: r.name }));
      } catch {
        return [];
      }
    },
    staleTime: 60_000,
  });

  const bulkReassignMutation = useMutation({
    mutationFn: (body: { caseIds: string[]; providerOrganizationId: string }) =>
      apiFetch<{ updatedCount: number; skippedLegacyCount?: number }>("/cases/bulk-reassign", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      setSelectedIds(new Set());
      setShowReassignModal(false);
      setReassignTargetId("");
      const { updatedCount, skippedLegacyCount = 0 } = result;
      const base = `${updatedCount} case${updatedCount !== 1 ? "s" : ""} reassigned.`;
      setBulkToast(
        skippedLegacyCount > 0
          ? `${base} (${skippedLegacyCount} legacy case${skippedLegacyCount !== 1 ? "s" : ""} skipped)`
          : base
      );
    },
    onError: (e: Error) => {
      setBulkToastError(e.message);
    },
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (body: { caseIds: string[]; status: string; labLocationId?: string | null }) =>
      apiFetch<{ updatedCount: number; skippedLegacyCount?: number }>("/cases/bulk-status", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async (result, variables) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        ...variables.caseIds.map((caseId) =>
          qc.invalidateQueries({ queryKey: ["case", caseId] }),
        ),
      ]);
      setSelectedIds(new Set());
      setShowBulkStatusModal(false);
      setBulkStatusValue("");
      const { updatedCount, skippedLegacyCount = 0 } = result;
      const totalSent = variables.caseIds.length;
      const unexplainedMissed = totalSent - updatedCount - skippedLegacyCount;
      const locationOptions =
        bulkLocationsQuery.data && bulkLocationsQuery.data.length > 0
          ? bulkLocationsQuery.data
          : STATUS_FILTERS.filter((s) => s.value !== "all");
      const label =
        locationOptions.find(
          (s) => "id" in s && s.id === variables.labLocationId,
        )?.label ??
        locationOptions.find((s) => s.value === variables.status)?.label ??
        variables.status;
      const base = `${updatedCount} case${updatedCount !== 1 ? "s" : ""} marked as ${label}.`;
      const successMsg = skippedLegacyCount > 0
        ? `${base} (${skippedLegacyCount} legacy case${skippedLegacyCount !== 1 ? "s" : ""} skipped)`
        : base;
      setBulkToast(successMsg);
      if (unexplainedMissed > 0) {
        setBulkToastError(
          `Warning: ${unexplainedMissed} case${unexplainedMissed !== 1 ? "s" : ""} may not have moved. Please try again for those.`,
        );
      }
    },
    onError: (e: Error) => {
      setBulkToastError(e.message);
    },
  });

  const [bulkToast, setBulkToast] = useState<string | null>(null);
  const [bulkToastError, setBulkToastError] = useState<string | null>(null);

  const [barcodeInput, setBarcodeInput] = useState("");
  const [barcodeLookupError, setBarcodeLookupError] = useState<string | null>(null);
  const [barcodeLookupLoading, setBarcodeLookupLoading] = useState(false);
  const [scanMode, setScanMode] = useState(false);
  const [scanHistory, setScanHistory] = useState<LabCase[]>([]);
  const scanInputRef = useRef<HTMLInputElement>(null);

  function activateScanMode() {
    setScanMode(true);
    setBarcodeInput("");
    setBarcodeLookupError(null);
    setTimeout(() => scanInputRef.current?.focus(), 0);
  }

  function deactivateScanMode() {
    setScanMode(false);
    setBarcodeInput("");
    setBarcodeLookupError(null);
  }

  function addToScanHistory(c: LabCase) {
    setScanHistory((prev) => {
      const deduped = prev.filter((h) => h.id !== c.id);
      return [c, ...deduped].slice(0, 5);
    });
  }

  function selectCase(next: LabCase) {
    if (selected?.id === next.id) return;
    const proceed = () => { setSelected(next); setCaseExpanded(false); };
    // The docked table remains clickable; changing rows must honor the same
    // unsaved-edit confirmation as closing or navigating away from the drawer.
    if (!guardNavigation(proceed)) proceed();
  }

  function openCaseFromRow(next: LabCase) {
    if (selected?.id === next.id) {
      // Keep the mounted drawer so its active tab and any drafts survive.
      setCaseExpanded(true);
      return;
    }

    const proceed = () => { setSelected(next); setCaseExpanded(true); };
    if (!guardNavigation(proceed)) proceed();
  }

  async function handleBarcodeLookup(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBarcodeLookupError(null);

    // Search loaded data first — instant, no extra round-trip needed.
    const local = (data ?? []).find((c) => c.casePanBarcode === trimmed);
    if (local) {
      selectCase(local);
      setBarcodeInput("");
      addToScanHistory(local);
      setTimeout(() => scanInputRef.current?.focus(), 50);
      return;
    }

    // Fall back to API lookup across all lab orgs the user belongs to.
    const labOrgs = (orgsQuery.data ?? []).filter((o) => o.type === "lab");
    if (!labOrgs.length) {
      setBarcodeLookupError("No case found for that pan.");
      return;
    }
    setBarcodeLookupLoading(true);
    try {
      for (const lab of labOrgs) {
        try {
          const result = await apiFetch<{ case: LabCase }>(
            `/cases/barcode/${encodeURIComponent(trimmed)}?labOrganizationId=${encodeURIComponent(lab.id)}`,
          );
          if (result.case) {
            selectCase(result.case);
            setBarcodeInput("");
            addToScanHistory(result.case);
            qc.invalidateQueries({ queryKey: ["cases"] });
            setTimeout(() => scanInputRef.current?.focus(), 50);
            return;
          }
        } catch (e: any) {
          // 404 just means this lab doesn't have it — try the next one.
          if (e?.status !== 404 && e?.message !== "No case found with that barcode.") throw e;
        }
      }
      setBarcodeLookupError("No case found for that pan.");
    } catch {
      setBarcodeLookupError("Lookup failed. Please try again.");
    } finally {
      setBarcodeLookupLoading(false);
    }
  }

  // Deep-link: if the URL contains ?caseId=<id>, auto-open that case in the drawer.
  // Uses useSearch() so the effect re-fires whenever the query string changes, even
  // when the component stays mounted (e.g. notification "View" click while on /cases).
  // lastProcessedCaseIdRef prevents re-opening the same case on unrelated re-renders.
  useEffect(() => {
    const params = new URLSearchParams(urlSearch);
    const targetId = params.get("caseId");
    if (!targetId || isLoading) return;
    if (targetId === lastProcessedCaseIdRef.current) return;
    lastProcessedCaseIdRef.current = targetId;
    const found = data?.find((c) => c.id === targetId);
    if (found) {
      selectCase(found);
    } else {
      apiFetch<LabCase>(`/cases/${targetId}`)
        .then((fresh) => selectCase(fresh))
        .catch(() => {/* case not found or inaccessible */});
    }
  }, [urlSearch, data, isLoading]);

  useEffect(() => {
    const batch = readIteroActiveBatch();
    if (batch) {
      setIteroActiveBatch(batch);
      try { sessionStorage.removeItem(CASES_ITERO_BATCH_KEY); } catch {}
    }
  }, []);

  // Keyboard shortcut: Ctrl+B activates barcode scan mode.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "b" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        activateScanMode();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        CASES_FILTER_STORAGE_KEY,
        JSON.stringify({ search, statusFilters, priorityFilters, caseTypeFilters, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir }),
      );
    } catch {}
  }, [search, statusFilters, priorityFilters, caseTypeFilters, dateRangeFilter, customStartDate, customEndDate, sortKey, sortDir]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, barcodeFilter, conflictsOnly, statusFilters, priorityFilters, caseTypeFilters, dateRangeFilter, customStartDate, customEndDate, iteroActiveBatch]);

  useEffect(() => {
    const el = pageRef.current?.closest("main") as HTMLElement | null;
    if (!el) return;

    const raw = sessionStorage.getItem(CASES_SCROLL_STORAGE_KEY);
    const target = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(target) && target > 0) {
      el.scrollTop = target;
      scrollRestoredRef.current = el.scrollTop >= target - 1;
    } else {
      scrollRestoredRef.current = true;
    }

    function handleScroll() {
      try {
        sessionStorage.setItem(CASES_SCROLL_STORAGE_KEY, String(el!.scrollTop));
      } catch {}
    }

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (isLoading || scrollRestoredRef.current) return;
    const el = pageRef.current?.closest("main") as HTMLElement | null;
    if (!el) return;
    const raw = sessionStorage.getItem(CASES_SCROLL_STORAGE_KEY);
    const target = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(target) && target > 0) {
      el.scrollTop = target;
    }
    scrollRestoredRef.current = true;
  }, [isLoading]);

  // Cases that share a pan barcode with at least one other active (non-complete)
  // case in the same lab. Computed from whichever list is currently in view so
  // an admin can spot duplicates before scanning. Keyed by lab + barcode to
  // keep tenant boundaries intact.
  const conflictKeys = useMemo(() => {
    const src = data;
    const counts = new Map<string, number>();
    for (const c of src) {
      const bc = String(c.casePanBarcode ?? "").trim();
      if (!bc) continue;
      if (String(c.status ?? "").toLowerCase() === "complete") continue;
      const key = `${c.labOrganizationId ?? ""}::${bc}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const set = new Set<string>();
    for (const [key, n] of counts) if (n >= 2) set.add(key);
    return set;
  }, [data]);

  const isConflicting = useCallback(
    (c: LabCase) => {
      const bc = String(c.casePanBarcode ?? "").trim();
      if (!bc) return false;
      if (String(c.status ?? "").toLowerCase() === "complete") return false;
      return conflictKeys.has(`${c.labOrganizationId ?? ""}::${bc}`);
    },
    [conflictKeys],
  );

  const conflictCount = useMemo(() => {
    const src = data;
    return src.filter(isConflicting).length;
  }, [data, isConflicting]);

  const filtered = useMemo(() => {
    return data;
  }, [data]);
  const focusableCaseId = filtered.some((c) => c.id === keyboardActiveCaseId)
    ? keyboardActiveCaseId
    : selected && filtered.some((c) => c.id === selected.id)
      ? selected.id
      : filtered[0]?.id ?? null;

  // Row-checkbox selection with shift-click range support. A normal click
  // toggles the single case and moves the anchor; a shift-click with a valid
  // anchor adds every case between the anchor and the clicked case (in the
  // current filtered/sorted order) to the selection. If the anchor is no
  // longer visible (filter changed), fall back to a normal single toggle.
  const handleRowCheckboxChange = (caseId: string, checked: boolean, shiftKey: boolean) => {
    if (shiftKey) {
      const rangeIds = computeShiftClickRange(
        filtered.map((c) => c.id),
        selectionAnchorIdRef.current,
        caseId,
      );
      if (rangeIds) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return next;
        });
        return;
      }
      // Anchor filtered out of the visible list: reset and treat as normal.
      selectionAnchorIdRef.current = null;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
    selectionAnchorIdRef.current = caseId;
  };

  const distinctDoctorNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of data ?? []) {
      if (c.doctorName?.trim()) names.add(c.doctorName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const distinctPatientLastNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of data ?? []) {
      if (c.patientLastName?.trim()) names.add(c.patientLastName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const distinctPatientFirstNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of data ?? []) {
      if (c.patientFirstName?.trim()) names.add(c.patientFirstName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [data]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // Build a status → station-name map for the Location column.
  // Only include statuses that map to exactly one station so we never show
  // an ambiguous name when multiple custom stations share the same status.
  const unambiguousStationName = useMemo<Map<string, string>>(() => {
    const locations = bulkLocationsQuery.data ?? [];
    const counts = new Map<string, number>();
    const names = new Map<string, string>();
    for (const loc of locations) {
      counts.set(loc.value, (counts.get(loc.value) ?? 0) + 1);
      names.set(loc.value, loc.label);
    }
    const result = new Map<string, string>();
    for (const [status, count] of counts) {
      if (count === 1) result.set(status, names.get(status)!);
    }
    return result;
  }, [bulkLocationsQuery.data]);
  const stationNameById = useMemo(
    () => new Map((bulkLocationsQuery.data ?? []).map((location) => [location.id, location.label])),
    [bulkLocationsQuery.data],
  );

  const caseCols = useTableColumns<LabCase>(
    [
      { id: "createdAt", label: <SortHeader k="createdAt">Created</SortHeader>, menuLabel: "Created", align: "left", defaultWidth: 100, render: (c) => <span className={c.priority === "rush" ? "text-destructive" : "text-muted-foreground"}>{formatShortDate(c.createdAt)}</span> },
      { id: "caseNumber", label: <SortHeader k="caseNumber">Case #</SortHeader>, menuLabel: "Case #", align: "left", defaultWidth: 160, titleFor: (c) => c.caseNumber, render: (c) => (
        <span className="font-mono text-xs">{c.caseNumber}</span>
      ) },
      { id: "patient", label: "Patient", menuLabel: "Patient", align: "left", defaultWidth: 140, titleFor: (c) => `${c.patientFirstName} ${c.patientLastName}`, render: (c) => `${c.patientFirstName} ${c.patientLastName}` },
      { id: "doctor", label: <SortHeader k="doctorName">Doctor</SortHeader>, menuLabel: "Doctor", align: "left", defaultWidth: 160, titleFor: (c) => [c.doctorName, c.providerAccountNumber ? `#${c.providerAccountNumber}` : ""].filter(Boolean).join(" "), render: (c) => (
        <span className="text-muted-foreground">
          {c.doctorName}
          {c.providerAccountNumber && <span className="ml-1.5 text-[11px] font-mono opacity-60">#{c.providerAccountNumber}</span>}
        </span>
      ) },
      { id: "type", label: "Type", menuLabel: "Type", align: "left", defaultWidth: 120, render: (c) => <span className="text-muted-foreground truncate block w-full" title={c.restorationTypes ?? ""}>{c.restorationTypes || "—"}</span> },
      { id: "material", label: "Material", menuLabel: "Material", align: "left", defaultWidth: 100, render: (c) => <span className="text-muted-foreground truncate block w-full" title={c.restorationMaterials ?? ""}>{c.restorationMaterials || "—"}</span> },
      { id: "teeth", label: "Teeth", menuLabel: "Teeth", align: "left", defaultWidth: 90, render: (c) => <span className="text-muted-foreground truncate block w-full" title={c.teeth ?? ""}>{c.teeth || "—"}</span> },
      { id: "priority", label: "Priority", menuLabel: "Priority", align: "left", defaultWidth: 90, render: (c) =>
        c.priority === "rush" ? (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-destructive bg-destructive/10 px-2 py-0.5 rounded-full">Rush</span>
        ) : (
          <span className="text-xs text-muted-foreground">Normal</span>
        ) },
      { id: "status", label: <SortHeader k="status">Location</SortHeader>, menuLabel: "Location", align: "left", defaultWidth: 130, render: (c) => <StatusBadge status={c.status} label={c.labLocationName ?? (c.labLocationId ? stationNameById.get(c.labLocationId) : undefined) ?? unambiguousStationName.get(c.status ?? "") ?? undefined} /> },
      { id: "pan", label: "Pan", menuLabel: "Pan", align: "left", defaultWidth: 100, titleFor: (c) => c.casePanBarcode || "", render: (c) => (
        <div className="flex items-center gap-1.5 text-muted-foreground font-mono text-xs">
          <span className="truncate">{c.casePanBarcode || "—"}</span>
          {isConflicting(c) && (
            <span
              title="This pan barcode is shared with another active case — possible duplicate."
              aria-label="Barcode conflict"
              className="inline-flex items-center gap-0.5 px-1.5 h-5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold uppercase tracking-wide"
            >
              <AlertTriangle size={10} />
              Conflict
            </span>
          )}
        </div>
      ) },
      { id: "due", label: <SortHeader k="dueDate">Due</SortHeader>, menuLabel: "Due", align: "left", defaultWidth: 110, titleFor: (c) => c.status === "complete" ? `Completed ${c.updatedAt ? formatShortDate(c.updatedAt) : ""}` : formatShortDueDate(c.dueDate, c.dueTime) ?? "", render: (c) => c.status === "complete" ? <span className="text-muted-foreground">Completed {c.updatedAt ? formatShortDate(c.updatedAt) : ""}</span> : <span className={c.priority === "rush" ? "text-destructive" : "text-muted-foreground"}>{formatShortDueDate(c.dueDate, c.dueTime)}</span> },
      { id: "price", label: <SortHeader k="totalPrice">Price</SortHeader>, menuLabel: "Price", align: "right", defaultWidth: 130, render: (c) => <span className="tabular-nums">{(c.remakeCharged === false && c.remakeOfCaseId) ? "$0.00" : (Number(c.totalPrice ?? 0) > 0 ? formatMoney(c.totalPrice) : "—")}</span> },
      { id: "notes", label: "Notes", menuLabel: "Notes", align: "left", defaultWidth: 200, render: (c) => <span className="text-muted-foreground truncate text-xs block w-full" title={c.caseNotes ?? ""}>{c.caseNotes || "—"}</span> },
    ],
    "labtrax_cases_columns_v3",
  );

  const caseColumnOptions = caseCols.defs.map((d) => ({
    id: d.id,
    label: d.menuLabel,
    visible: !caseCols.state.hidden.includes(d.id),
    index: caseCols.state.order.indexOf(d.id),
  }));

  function SortHeader({ k, children }: { k: SortKey; children: React.ReactNode }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground"
      >
        {children}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  const selectedQuickFilter = overdueOnly
    ? "overdue"
    : STATUS_QUICK_FILTERS.find(({ id, statuses }) =>
        id !== "overdue" &&
        statuses.length === statusFilters.length &&
        statuses.every((status) => statusFilters.includes(status)),
      )?.id ?? "";
  const applyQuickFilter = (id: string, statuses: readonly string[]) => {
    if (id === "overdue") {
      setStatusFilters([]);
      setOverdueOnly((active) => !active);
      return;
    }
    const selected = statuses.length === statusFilters.length &&
      statuses.every((status) => statusFilters.includes(status));
    setStatusFilters(selected ? [] : [...statuses]);
    setOverdueOnly(false);
  };
  const overviewCounts = overviewQuery.isError || overviewQuery.isLoading
    ? undefined
    : overviewQuery.data;
  const summaryCards = [
    { label: "Total Cases", value: overviewCounts?.totalCases, id: "total" },
    { label: "Processing", value: overviewCounts?.processingCases, id: "processing" },
    { label: "In Transit", value: overviewCounts?.inTransitCases, id: "in-transit" },
    { label: "Completed", value: overviewCounts?.completedCases, id: "completed" },
    { label: "Overdue", value: overviewCounts?.overdueCases, id: "overdue" },
  ];

  return (
    <div ref={pageRef} className="px-8 py-7">
      <TrialBanner />
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All lab cases across your organizations.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {worklistPending
              ? "Loading…"
              : `${loadedRows.length} of ${listQuery.data?.query === activeQuery ? listQuery.data.total : 0} loaded`}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isFetching}
            title="Refresh cases"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-60"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowNewCase(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Plus size={14} />
            Add case
          </button>
        </div>
      </div>

      <section aria-label="Case totals" className="mb-4" data-testid="cases-summary">
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5">
          {summaryCards.map((card) => (
            <div
              key={card.id}
              data-testid={`cases-summary-${card.id}`}
              className="min-w-0 rounded-lg border border-border bg-card px-3 py-2.5"
            >
              <div className="text-xl leading-6 font-semibold tabular-nums">
                {card.value === undefined ? "—" : card.value.toLocaleString()}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{card.label}</div>
            </div>
          ))}
        </div>
        {overviewQuery.isError && (
          <div role="status" className="mt-2 flex items-center gap-2 text-xs text-destructive">
            <span>Case totals are unavailable.</span>
            <button type="button" onClick={() => void overviewQuery.refetch()} className="underline underline-offset-2">
              Retry
            </button>
          </div>
        )}
      </section>

      <nav aria-label="Quick case status filters" className="mb-4 flex flex-wrap items-center gap-1.5">
        {STATUS_QUICK_FILTERS.map(({ id, label, statuses }) => {
          const count = id === "processing" ? overviewCounts?.processingCases
            : id === "received" ? overviewCounts?.receivedCases
              : id === "inDesign" ? overviewCounts?.inDesignCases
                : id === "modelRoom" ? overviewCounts?.modelRoomCases
                : id === "scan" ? overviewCounts?.scanCases
                  : id === "milling" ? overviewCounts?.millingCases
                    : id === "postMill" ? overviewCounts?.postMillCases
                      : id === "sinteringFurnace" ? overviewCounts?.sinteringFurnaceCases
                        : id === "porcelain" ? overviewCounts?.porcelainCases
                          : id === "qualityCheck" ? overviewCounts?.qualityCheckCases
                            : id === "onHold" ? overviewCounts?.onHoldCases
                              : id === "remake" ? overviewCounts?.remakeCases
                  : id === "shipped" ? overviewCounts?.shippedCases
                    : id === "overdue" ? overviewCounts?.overdueCases
                      : overviewCounts?.totalCases;
          const active = selectedQuickFilter === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              data-testid={`cases-quick-filter-${id}`}
              onClick={() => applyQuickFilter(id, statuses)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              {label}
              {count !== undefined && <span className="tabular-nums opacity-75">{count.toLocaleString()}</span>}
            </button>
          );
        })}
      </nav>

      {iteroActiveBatch && (
        <div className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-200">
          <Sparkles size={14} className="shrink-0 text-blue-500" />
          <span className="flex-1">
            Filtered to iTero import session — {iteroActiveBatch.label} on{" "}
            {(() => { const _d = new Date(iteroActiveBatch.importedAt); const _mm = String(_d.getMonth()+1).padStart(2,"0"); const _dd = String(_d.getDate()).padStart(2,"0"); const _yyyy = _d.getFullYear(); const _t = _d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}); return `${_mm}/${_dd}/${_yyyy}, ${_t}`; })()}.{" "}
            Showing {filtered.length} case{filtered.length !== 1 ? "s" : ""}.
          </span>
          <button
            type="button"
            onClick={() => setIteroActiveBatch(null)}
            className="shrink-0 p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900"
            title="Clear filter"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1 bg-card border border-border rounded-xl overflow-clip">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search case #, doctor, patient…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <div className="flex items-center text-xs text-muted-foreground">
            <Filter size={13} aria-hidden="true" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="cases-saved-views-controls">
            <label className="sr-only" htmlFor="cases-saved-view-select">Saved Cases views</label>
            <select
              id="cases-saved-view-select"
              data-testid="cases-saved-view-select"
              value={selectedSavedViewId}
              onChange={(event) => setSelectedSavedViewId(event.target.value)}
              disabled={savedViewsQuery.isLoading || !savedViewsQuery.data?.length}
              className="h-9 max-w-40 rounded-md border border-border bg-secondary px-2 text-sm"
            >
              <option value="">Saved views…</option>
              {(savedViewsQuery.data ?? []).map((view) => (
                <option key={view.id} value={view.id}>{view.name}</option>
              ))}
            </select>
            <button
              type="button"
              data-testid="cases-saved-view-apply"
              disabled={!selectedSavedViewId || !savedViewsQuery.data?.some((view) => view.id === selectedSavedViewId)}
              onClick={() => {
                const view = savedViewsQuery.data?.find((item) => item.id === selectedSavedViewId);
                if (view) applySavedCaseView(view);
              }}
              className="h-9 rounded-md border border-border bg-card px-2.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              Apply view
            </button>
            <button
              type="button"
              data-testid="cases-saved-view-save"
              disabled={!pageLabOrgId || saveCaseViewMutation.isPending}
              onClick={() => {
                setSavedViewNameDraft("");
                setSavedViewNameDialog({ mode: "save" });
              }}
              className="h-9 rounded-md border border-border bg-card px-2.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              Save view
            </button>
            <button
              type="button"
              data-testid="cases-saved-view-update"
              disabled={!savedViewsQuery.data?.some((view) => view.id === selectedSavedViewId) || updateCaseViewFiltersMutation.isPending}
              onClick={() => {
                const view = savedViewsQuery.data?.find((item) => item.id === selectedSavedViewId);
                if (!view || !pageLabOrgId) return;
                if (!window.confirm(`Update the shared view “${view.name}” for everyone in your lab with the current search, status, and desktop date filters?`)) return;
                const filters: CaseSavedViewFilters = {
                  search: search.trim(),
                  statusFilters: [...statusFilters],
                  desktop: { dateRangeFilter, customStartDate, customEndDate },
                  ...(view.filters.mobile ? { mobile: view.filters.mobile } : {}),
                };
                updateCaseViewFiltersMutation.mutate({ id: view.id, filters });
              }}
              className="h-9 rounded-md border border-border bg-card px-2.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              Update filters
            </button>
            <button
              type="button"
              data-testid="cases-saved-view-rename"
              disabled={!savedViewsQuery.data?.some((view) => view.id === selectedSavedViewId) || renameCaseViewMutation.isPending}
              onClick={() => {
                const view = savedViewsQuery.data?.find((item) => item.id === selectedSavedViewId);
                if (!view) return;
                setSavedViewNameDraft(view.name);
                setSavedViewNameDialog({ mode: "rename", viewId: view.id });
              }}
              className="h-9 rounded-md border border-border bg-card px-2.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              Rename
            </button>
            <button
              type="button"
              data-testid="cases-saved-view-delete"
              disabled={!savedViewsQuery.data?.some((view) => view.id === selectedSavedViewId) || deleteCaseViewMutation.isPending}
              onClick={() => {
                const view = savedViewsQuery.data?.find((item) => item.id === selectedSavedViewId);
                if (view && window.confirm(`Remove the shared view “${view.name}”?`)) {
                  deleteCaseViewMutation.mutate(view.id);
                }
              }}
              className="h-9 rounded-md border border-border bg-card px-2.5 text-sm text-destructive hover:bg-muted disabled:opacity-50"
            >
              Remove
            </button>
            {savedViewsQuery.isError && (
              <span role="status" className="text-xs text-destructive">Saved views unavailable</span>
            )}
          </div>
          <MultiSelectFilter
            label="Location"
            options={STATUS_FILTER_OPTIONS}
            selected={statusFilters}
            onChange={(value) => {
              setStatusFilters(value);
              setOverdueOnly(false);
            }}
            data-testid="cases-status-filter"
          />
          <MultiSelectFilter
            label="Priority"
            options={PRIORITY_FILTER_OPTIONS}
            selected={priorityFilters}
            onChange={setPriorityFilters}
            data-testid="cases-priority-filter"
          />
          <MultiSelectFilter
            label="Type"
            options={CASE_TYPE_FILTER_OPTIONS}
            selected={caseTypeFilters}
            onChange={setCaseTypeFilters}
            data-testid="cases-type-filter"
          />
          <label className="flex items-center gap-2 text-sm">Date
          <select
            aria-label="Date"
            value={dateRangeFilter}
            onChange={(e) => {
              if (e.target.value === "custom") { setShowRangeWindow(true); return; }
              setDateRangeFilter(e.target.value as DateRangeFilter);
              if (e.target.value !== "custom") {
                setCustomStartDate("");
                setCustomEndDate("");
              }
            }}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
            <option value="custom">Custom…</option>
          </select>
          </label>
          {dateRangeFilter === "custom" && (
            <button type="button" className="text-sm underline" onClick={() => setShowRangeWindow(true)}>
              {customStartDate} – {customEndDate} · Edit range
            </button>
          )}
          {showRangeWindow && <CaseRangeWindow start={customStartDate} end={customEndDate}
            onCancel={() => setShowRangeWindow(false)} onApply={(start, end) => {
              setCustomStartDate(start); setCustomEndDate(end); setDateRangeFilter("custom"); setShowRangeWindow(false);
            }} />}

          <div className="relative w-44">
            <Barcode
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            {barcodeFilterActive && isFetching && (
              <Loader2
                size={12}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground pointer-events-none"
              />
            )}
            {barcodeFilterActive && !isFetching && (
              <button
                type="button"
                onClick={() => setBarcodeFilter("")}
                title="Clear barcode filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            )}
            <input
              type="search"
              value={barcodeFilter}
              onChange={(e) => setBarcodeFilter(e.target.value)}
              placeholder="Filter by exact barcode…"
              autoComplete="off"
              aria-label="Filter cases by exact barcode"
              className="w-full h-9 pl-8 pr-7 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary font-mono"
            />
          </div>

          <button
            type="button"
            onClick={() => setConflictsOnly((v) => !v)}
            title={
              conflictCount === 0
                ? "No barcode conflicts detected"
                : "Show only cases that share a pan barcode with another active case"
            }
            className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 ${
              conflictsOnly
                ? "bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-400"
                : "bg-secondary border-transparent text-foreground hover:bg-secondary/80"
            }`}
          >
            <AlertTriangle size={14} className={conflictCount > 0 ? "text-amber-500" : ""} />
            Conflicts
            {conflictCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-semibold">
                {conflictCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            title="Clear all Cases filters"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium border border-transparent bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FilterX size={14} />
            Reset filters
          </button>

          <ColumnSettingsPopover
            columns={caseColumnOptions}
            onToggle={caseCols.toggleColumn}
            onMove={caseCols.moveColumn}
            onReset={caseCols.resetAll}
          />

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {scanMode ? (
              <>
                <div className="relative flex items-center">
                  <Barcode
                    size={14}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-primary pointer-events-none"
                  />
                  {barcodeLookupLoading && (
                    <Loader2
                      size={12}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground pointer-events-none"
                    />
                  )}
                  <input
                    ref={scanInputRef}
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => {
                      setBarcodeInput(e.target.value);
                      setBarcodeLookupError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleBarcodeLookup(barcodeInput);
                      if (e.key === "Escape") deactivateScanMode();
                    }}
                    onBlur={() => {
                      if (!barcodeInput.trim() && !barcodeLookupLoading && scanHistory.length === 0) deactivateScanMode();
                    }}
                    placeholder="Scan or type barcode…"
                    autoComplete="off"
                    className="h-9 pl-8 pr-8 w-56 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-primary"
                    aria-label="Scan barcode"
                  />
                </div>
                <button
                  type="button"
                  onClick={deactivateScanMode}
                  title="Cancel scan (Esc)"
                  className="h-9 w-9 flex items-center justify-center rounded-md hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={14} />
                </button>
                {barcodeLookupError && (
                  <span className="text-xs text-destructive whitespace-nowrap">
                    {barcodeLookupError}
                  </span>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={activateScanMode}
                  title="Scan barcode (Ctrl+B)"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted/50 transition-colors"
                >
                  <Barcode size={14} />
                  Scan barcode
                </button>
                {barcodeLookupError && (
                  <span className="text-xs text-destructive whitespace-nowrap">
                    {barcodeLookupError}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {scanMode && scanHistory.length > 0 && (
          <div className="px-4 py-2 border-b border-border bg-primary/5 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground shrink-0 flex items-center gap-1">
              <Barcode size={12} />
              Recently scanned:
            </span>
            {scanHistory.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => selectCase(c)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-background hover:bg-muted/60 transition-colors text-xs"
              >
                <span className="font-mono font-medium text-foreground">{c.caseNumber}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground">
                  {c.patientFirstName || c.patientInitials
                    ? `${c.patientFirstName} ${c.patientLastName}`.trim() || c.patientInitials
                    : "—"}
                </span>
                <span className="text-muted-foreground">·</span>
                <StatusBadge status={c.status} size="sm" />
              </button>
            ))}
          </div>
        )}
        {(selectedIds.size > 0 || printingSelection) && (
          <div className="sticky top-0 z-10 px-4 py-2.5 border-b border-border bg-card/95 backdrop-blur-sm flex flex-wrap items-center gap-3 shadow-sm">
            <span className="text-sm font-medium">
              {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
            <button
              type="button"
              onClick={() => {
                setReassignTargetId("");
                setShowReassignModal(true);
              }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Reassign
            </button>
            <button
              type="button"
              onClick={() => {
                setBulkStatusValue("");
                setShowBulkStatusModal(true);
              }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 transition-colors border border-border"
            >
              Change Location
            </button>
            <SelectedCasePrintActions selectedIds={selectedIds} isAdmin={isPageAdmin} onBusyChange={setPrintingSelection} />
            {isPageAdmin && (
              <button
                type="button"
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  if (ids.length === 0) return;
                  setBulkDeleteCaseIds(ids);
                  setShowBulkDeleteModal(true);
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 transition-colors"
              >
                <Trash2 size={13} />
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Clear selection
            </button>
          </div>
        )}
        <div className="overflow-x-auto relative">
          <table ref={casesTableRef} className="text-sm" style={{ tableLayout: "fixed", width: 36 + caseCols.visible.reduce((sum, c) => sum + caseCols.getWidth(c.id), 0) }}>
            <caption className="sr-only">
              Cases. Use the Up and Down arrow keys to move between cases, Space to select a case, and Enter to open it.
            </caption>
            <colgroup>
              <col style={{ width: 36 }} />
              {caseCols.visible.map((col) => (
                <col key={col.id} style={{ width: caseCols.getWidth(col.id) }} />
              ))}
            </colgroup>
            <thead>
              <tr className="bg-secondary/40">
                <th className="py-2.5 pl-3 pr-1 w-9">
                  <input
                    type="checkbox"
                    aria-label="Select all cases"
                    checked={filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id))}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          selectedIds.size > 0 &&
                          !filtered.every((c) => selectedIds.has(c.id)) &&
                          filtered.some((c) => selectedIds.has(c.id));
                      }
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(new Set(filtered.map((c) => c.id)));
                      } else {
                        setSelectedIds(new Set());
                      }
                    }}
                    className="rounded border-border"
                  />
                </th>
                {caseCols.visible.map((col) => {
                  const isDragging = dragColId === col.id;
                  const isDropTarget = dragOverColId === col.id && dragColId !== null && dragColId !== col.id;
                  const dragIdx = dragColId ? caseCols.visible.findIndex((c) => c.id === dragColId) : -1;
                  const overIdx = caseCols.visible.findIndex((c) => c.id === col.id);
                  const indicatorSide = dragIdx !== -1 && dragIdx < overIdx ? "right" : "left";
                  return (
                  <th
                    key={col.id}
                    data-col-id={col.id}
                    className={`${col.align === "right" ? "text-right" : "text-left"} py-2.5 relative`}
                    style={{ overflow: "hidden" }}
                    onDragOver={(e) => {
                      if (!dragColId || dragColId === col.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverColId !== col.id) setDragOverColId(col.id);
                    }}
                    onDrop={(e) => {
                      if (!dragColId || dragColId === col.id) return;
                      e.preventDefault();
                      caseCols.reorderColumn(dragColId, col.id);
                      setDragColId(null);
                      setDragOverColId(null);
                    }}
                  >
                    {isDropTarget && (
                      <span
                        aria-hidden="true"
                        className="absolute top-0 bottom-0 w-0.5 bg-primary z-10 pointer-events-none"
                        style={{ [indicatorSide]: 0 }}
                      />
                    )}
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", col.id);
                        setDragColId(col.id);
                      }}
                      onDragEnd={() => {
                        setDragColId(null);
                        setDragOverColId(null);
                      }}
                      title="Drag to reorder column"
                      className={`inline-flex items-center align-middle ${isDragging ? "opacity-40" : ""}`}
                      style={{ cursor: isDragging ? "grabbing" : "grab" }}
                    >
                      {col.label}
                    </span>
                    <div
                      onMouseDown={(e) => caseCols.startResize(col.id, e)}
                      onDoubleClick={() => {
                        const table = casesTableRef.current;
                        if (!table) { caseCols.resetWidth(col.id); return; }
                        const cells = table.querySelectorAll<HTMLElement>(`[data-col-id="${col.id}"]`);
                        let max = 0;
                        cells.forEach((el) => { max = Math.max(max, el.scrollWidth); });
                        caseCols.fitColumn(col.id, max + 8);
                      }}
                      className="group/resize"
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        width: 6,
                        height: "100%",
                        cursor: "col-resize",
                        userSelect: "none",
                        display: "flex",
                        alignItems: "stretch",
                        justifyContent: "flex-end",
                      }}
                    >
                      <span
                        className={`w-0.5 transition-colors duration-100 ${caseCols.resizingId === col.id ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                        style={{ display: "block", height: "100%" }}
                      />
                    </div>
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {hasActiveFilters && worklistPending && (
                <tr>
                  <td colSpan={1 + caseCols.visible.length} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Searching cases…
                  </td>
                </tr>
              )}
              {hasActiveFilters && !worklistPending && error && (
                <tr>
                  <td colSpan={1 + caseCols.visible.length} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!worklistPending && !error && filtered.length === 0 && (
                <tr>
                  <td colSpan={1 + caseCols.visible.length} className="px-5 py-12 text-center text-muted-foreground">
                    {hasActiveFilters ? "No cases match the current filters." : "No cases yet."}
                  </td>
                </tr>
              )}
              {!worklistPending && filtered.map((c) => (
                <tr
                  key={c.id}
                  data-case-id={c.id}
                  tabIndex={focusableCaseId === c.id ? 0 : -1}
                  aria-keyshortcuts="ArrowUp ArrowDown Space Enter"
                  onFocus={() => setKeyboardActiveCaseId(c.id)}
                  onKeyDown={(event) => {
                    // Let nested controls keep their native keyboard behavior,
                    // especially the bulk-selection checkbox.
                    if (event.target !== event.currentTarget) return;

                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      const currentIndex = filtered.findIndex((row) => row.id === c.id);
                      const nextIndex = currentIndex + (event.key === "ArrowDown" ? 1 : -1);
                      const nextCase = filtered[nextIndex];
                      if (!nextCase) return;
                      event.preventDefault();
                      const rows = event.currentTarget.parentElement?.querySelectorAll<HTMLTableRowElement>(
                        "tr[data-case-id]",
                      );
                      Array.from(rows ?? [])
                        .find((row) => row.dataset.caseId === nextCase.id)
                        ?.focus();
                      return;
                    }

                    if (event.key === " ") {
                      event.preventDefault();
                      selectCase(c);
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      openCaseFromRow(c);
                    }
                  }}
                  onClick={(event) => {
                    // The second click of a double-click is followed by the
                    // guarded row-opening handler. While edits are dirty, wait
                    // for that event before prompting so the first click does
                    // not cover the row with a confirmation dialog.
                    if (event.detail > 1) return;
                    if (
                      selected?.id !== c.id &&
                      hasNavigationBlockers()
                    ) {
                      if (rowSelectionTimerRef.current) {
                        clearTimeout(rowSelectionTimerRef.current);
                      }
                      rowSelectionTimerRef.current = setTimeout(() => {
                        rowSelectionTimerRef.current = null;
                        selectCase(c);
                      }, 500);
                      return;
                    }
                    selectCase(c);
                  }}
                  onDoubleClick={(event) => {
                    const target = event.target;
                    if (
                      target instanceof Element &&
                      target.closest(
                        "input, button, select, textarea, a, [role='button'], [role='checkbox'], [contenteditable='true']",
                      )
                    ) {
                      return;
                    }
                    if (rowSelectionTimerRef.current) {
                      clearTimeout(rowSelectionTimerRef.current);
                      rowSelectionTimerRef.current = null;
                    }
                    openCaseFromRow(c);
                  }}
                  data-testid={`case-row-${c.id}`}
                  aria-selected={selected?.id === c.id}
                  className={`border-t border-border cursor-pointer hover:bg-secondary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px] ${selected?.id === c.id ? "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]" : ""} ${c.priority === "rush" ? "bg-destructive/5" : ""} ${selectedIds.has(c.id) ? "bg-primary/5" : ""}`}
                >
                  <td className="pl-3 pr-1 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select case ${c.caseNumber}`}
                      checked={selectedIds.has(c.id)}
                      onMouseDown={suppressShiftClickTextSelection}
                      onChange={(e) => {
                        handleRowCheckboxChange(c.id, e.target.checked, shiftKeyFromChangeEvent(e));
                      }}
                      className="rounded border-border"
                    />
                  </td>
                  {caseCols.visible.map((col) => (
                    <td key={col.id} data-col-id={col.id} className={`py-2 ${col.align === "right" ? "px-5 text-right" : "px-5 text-left"}${c.priority === "rush" ? " text-destructive [&_*]:text-destructive" : ""}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={col.titleFor?.(c)}>
                      {col.render(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {hasActiveFilters && !error && (worklistPending || filtered.length > 0) && (
              <tfoot>
                <tr className="border-t border-border bg-secondary/20">
                  <td colSpan={1 + caseCols.visible.length}>
                    <FilteredSalesTotal
                      loading={worklistPending}
                      amount={
                        !worklistPending &&
                        filtered.length > 0 &&
                        listQuery.data?.query === activeQuery
                          ? listQuery.data.salesTotal
                          : undefined
                      }
                    />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!worklistPending && listQuery.data?.query === activeQuery && listQuery.data.hasMore && (
          <div className="border-t border-border p-3 text-center">
            <button
              type="button"
              onClick={() => setPagination({ criteria: criteriaQuery, page: page + 1 })}
              disabled={isFetching}
              className="h-9 px-4 rounded-md border border-border text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              {isFetching ? "Loading…" : `Load more (${loadedRows.length} of ${listQuery.data.total})`}
            </button>
          </div>
        )}
      </div>

      {selected ? (
        <CaseDrawer
          key={selected.id}
          initialTab="history"
          docked={!caseExpanded}
          onExpand={() => setCaseExpanded(true)}
          labCase={selected}
          onClose={() => {
            setSelected(null);
            setCaseExpanded(false);
            const params = new URLSearchParams(window.location.search);
            if (params.has("caseId")) {
              params.delete("caseId");
              const newSearch = params.toString();
              setLocation(`/cases${newSearch ? `?${newSearch}` : ""}`);
            }
          }}
          onCaseLocated={(newStatus) =>
            setSelected((prev) => (prev ? { ...prev, status: newStatus } : null))
          }
          doctorNames={distinctDoctorNames}
          patientLastNames={distinctPatientLastNames}
          patientFirstNames={distinctPatientFirstNames}
          onOpenCaseId={async (id) => {
            const found = data?.find((c) => c.id === id);
            if (found) {
              selectCase(found);
              return;
            }
            try {
              const fresh = await apiFetch<LabCase>(`/cases/${id}`);
              selectCase(fresh);
            } catch {
              /* ignore — case may be soft-deleted or out of scope */
            }
          }}
        />
      ) : (
        <aside
          data-testid="case-detail-empty"
          className="hidden xl:flex sticky top-4 w-[420px] shrink-0 h-[min(520px,calc(100vh-2rem))] flex-col items-center justify-center text-center rounded-xl border border-dashed border-border text-muted-foreground px-8"
        >
          <div className="text-sm font-medium text-foreground">No case selected</div>
          <p className="text-xs mt-1">Select a row to review the lab slip, notes, files, invoice and history here.</p>
        </aside>
      )}
      </div>
      {showNewCase && <NewCaseModal onClose={() => setShowNewCase(false)} />}

      {savedViewNameDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <form
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
            role="dialog"
            aria-modal="true"
            aria-label={savedViewNameDialog.mode === "save" ? "Save Cases view" : "Rename Cases view"}
            data-testid="cases-saved-view-name-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") setSavedViewNameDialog(null);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const name = savedViewNameDraft.trim();
              if (!name) return;
              if (savedViewNameDialog.mode === "save") {
                saveCaseViewMutation.mutate(name);
              } else {
                renameCaseViewMutation.mutate({ id: savedViewNameDialog.viewId, name });
              }
            }}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold">
                {savedViewNameDialog.mode === "save" ? "Save Cases view" : "Rename Cases view"}
              </h2>
              <button
                type="button"
                onClick={() => setSavedViewNameDialog(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-2">
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="cases-saved-view-name">
                View name
              </label>
              <input
                id="cases-saved-view-name"
                data-testid="cases-saved-view-name-input"
                autoFocus
                maxLength={60}
                value={savedViewNameDraft}
                onChange={(event) => setSavedViewNameDraft(event.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
              />
              {savedViewNameDialog.mode === "save" && (
                <p className="text-xs text-muted-foreground">
                  Saves the current search, location, and date filters for everyone in your lab.
                </p>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => setSavedViewNameDialog(null)}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="cases-saved-view-name-submit"
                disabled={!savedViewNameDraft.trim() || saveCaseViewMutation.isPending || renameCaseViewMutation.isPending}
                className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {(saveCaseViewMutation.isPending || renameCaseViewMutation.isPending) && (
                  <Loader2 size={13} className="animate-spin" />
                )}
                {savedViewNameDialog.mode === "save" ? "Save view" : "Rename"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showReassignModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4"
            role="dialog"
            aria-modal="true"
            aria-label="Reassign cases"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold">Reassign {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}</h2>
              <button
                type="button"
                onClick={() => {
                  setShowReassignModal(false);
                  setReassignTargetId("");
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  New practice
                </label>
                <ProviderPicker
                  value={reassignTargetId}
                  onChange={(id) => setReassignTargetId(id)}
                  providers={providerOrgs}
                />
              </div>
              {bulkReassignMutation.isError && (
                <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {bulkReassignMutation.error instanceof Error
                    ? bulkReassignMutation.error.message
                    : "An error occurred."}
                </p>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => {
                  setShowReassignModal(false);
                  setReassignTargetId("");
                }}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!reassignTargetId || bulkReassignMutation.isPending}
                onClick={() => {
                  if (!reassignTargetId) return;
                  bulkReassignMutation.mutate({
                    caseIds: Array.from(selectedIds),
                    providerOrganizationId: reassignTargetId,
                  });
                }}
                className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {bulkReassignMutation.isPending && <Loader2 size={13} className="animate-spin" />}
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkStatusModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4"
            role="dialog"
            aria-modal="true"
            aria-label="Change case location"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-base font-semibold">Change Location — {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}</h2>
              <button
                type="button"
                onClick={() => {
                  setShowBulkStatusModal(false);
                  setBulkStatusValue("");
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5" htmlFor="bulk-status-select">
                  New location
                </label>
                <select
                  id="bulk-status-select"
                  value={bulkStatusValue}
                  onChange={(e) => setBulkStatusValue(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
                >
                  <option value="" disabled>Select a location…</option>
                  {(bulkLocationsQuery.data && bulkLocationsQuery.data.length > 0
                    ? bulkLocationsQuery.data
                    : STATUS_FILTERS.filter((s) => s.value !== "all").map((s) => ({ id: s.value, value: s.value, label: s.label }))
                  ).map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              {bulkStatusMutation.isError && (
                <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                  {bulkStatusMutation.error instanceof Error
                    ? bulkStatusMutation.error.message
                    : "An error occurred."}
                </p>
              )}
            </div>
            <div className="flex gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => {
                  setShowBulkStatusModal(false);
                  setBulkStatusValue("");
                }}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!bulkStatusValue || bulkStatusMutation.isPending}
                onClick={() => {
                  if (!bulkStatusValue) return;
                  // bulkStatusValue holds the station `id`; resolve to its mapped
                  // workflow stage before sending so custom stations sharing a
                  // stage stay distinct in the picker but send a valid status.
                  const bulkOptions =
                    bulkLocationsQuery.data && bulkLocationsQuery.data.length > 0
                      ? bulkLocationsQuery.data
                      : STATUS_FILTERS.filter((s) => s.value !== "all").map((s) => ({ id: s.value, value: s.value, label: s.label }));
                  const status = bulkOptions.find((s) => s.id === bulkStatusValue)?.value;
                  if (!status) return;
                  bulkStatusMutation.mutate({
                    caseIds: Array.from(selectedIds),
                    status,
                     ...(bulkLocationsQuery.data && bulkLocationsQuery.data.length > 0
                       ? { labLocationId: bulkStatusValue }
                       : {}),
                  });
                }}
                className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
              >
                {bulkStatusMutation.isPending && <Loader2 size={13} className="animate-spin" />}
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkDeleteModal && (
        <CaseDeleteModal
          caseIds={bulkDeleteCaseIds}
          onClose={() => setShowBulkDeleteModal(false)}
          onSuccess={(deletedCount) => {
            // Refresh every surface a deletion touches: the cases list +
            // dashboard counts (both keyed on ["cases"]) and any invoice views
            // (the linked invoices are frozen, not deleted).
            qc.invalidateQueries({ queryKey: ["cases"] });
            qc.invalidateQueries({ queryKey: ["invoices"] });
            qc.invalidateQueries({ queryKey: ["invoice-for-case"] });
            qc.invalidateQueries({ queryKey: ["invoice-detail"] });
            setSelectedIds(new Set());
            setShowBulkDeleteModal(false);
            setBulkDeleteCaseIds([]);
            setBulkToast(`${deletedCount} case${deletedCount !== 1 ? "s" : ""} deleted.`);
          }}
        />
      )}

      {bulkToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-foreground text-background text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
          <Check size={14} className="shrink-0 text-green-400" />
          {bulkToast}
          <button
            type="button"
            onClick={() => setBulkToast(null)}
            className="ml-1 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {bulkToastError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-destructive text-destructive-foreground text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
          <AlertTriangle size={14} className="shrink-0" />
          {bulkToastError}
          <button
            type="button"
            onClick={() => setBulkToastError(null)}
            className="ml-1 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function MobileCaseDrawer({ labCase, onClose }: { labCase: LabCase; onClose: () => void }) {
  const [rxPreviewOpen, setRxPreviewOpen] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[520px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Case · from mobile app</div>
            <div className="font-mono text-sm font-semibold">{labCase.caseNumber}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="text-xs text-muted-foreground bg-secondary/60 rounded-lg px-3 py-2">
            This case was created on the mobile app. Open LabTrax on your phone or tablet to edit it.
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Patient</div>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className="text-sm">{`${labCase.patientFirstName} ${labCase.patientLastName}`.trim() || "—"}</span>
                <button
                  type="button"
                  onClick={() => setRxPreviewOpen(true)}
                  className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors"
                  title="Preview prescription"
                >
                  <ScrollText size={10} />
                  Preview Rx
                </button>
              </div>
            </div>
            <Field label="Doctor" value={labCase.doctorName} />
            <Field label="Location" value={labCase.labLocationName ?? statusLabel(labCase.status)} />
            <Field label="Priority" value={labCase.priority === "rush" ? "Rush" : "Normal"} />
            {labCase.restorationTypes && (
              <Field label="Type" value={labCase.restorationTypes} />
            )}
            {((labCase as any).caseType ?? labCase.restorationTypes ?? "").match(
              /removable|denture|partial|ortho|night guard|retainer|aligner/i,
            ) && (
              <Field
                label="Arch"
                value={archLabel(labCase.restorations) ?? "Required"}
              />
            )}
            {labCase.restorationMaterials && (
              <Field label="Material" value={labCase.restorationMaterials} />
            )}
            {labCase.teeth && (
              <Field label="Teeth" value={labCase.teeth} />
            )}
            <Field label="Due date" value={formatDueDate(labCase.dueDate, labCase.dueTime)} />
            <Field label="Created" value={formatDate(labCase.createdAt)} />
            {Number(labCase.totalPrice ?? 0) > 0 && (
              <Field label="Price" value={formatMoney(labCase.totalPrice)} />
            )}
          </div>
        </div>
      </aside>
      {rxPreviewOpen && (
        <PrescriptionPreview
          caseId={labCase.id}
          invoiceCaseId={labCase.id}
          onClose={() => setRxPreviewOpen(false)}
        />
      )}
    </div>
  );
}

type CaseNote = {
  id: string;
  noteText?: string | null;
  visibility?: string | null;
  createdAt?: string | null;
  authorName?: string | null;
};

type DetailedCase = LabCase & {
  restorations: CaseRestoration[];
  notes: CaseNote[];
  events: CaseEvent[];
  /** Events from the original case when this case is a remake. */
  originalCaseEvents?: CaseEvent[];
  /** Events from each canonical remake child, so viewing the original case shows a unified timeline. */
  remakeChildrenEvents?: Array<{ caseId: string; caseNumber: string; events: CaseEvent[] }>;
  attachments: CaseAttachment[];
  viewerIsLabMember?: boolean;
  viewerCanUploadAttachments?: boolean;
  viewerCanPostNotes?: boolean;
  viewerQuickReferenceOrganizationId?: string | null;
  viewerCanManageAttachments?: boolean;
  /** Open exception for this case. Lab-internal — null for provider viewers. */
  activeException?: CaseExceptionSummary | null;
  remakeNotes?: string | null;
  /**
   * Distinct restoration material names that couldn't be mapped to a price
   * key (so they resolve to a $0 invoice line). Surfaced independently so an
   * admin can fix pricing before billing.
   */
  unrecognizedMaterials?: string[] | null;
  /** Serialized bridge connector pairs, e.g. "13-14,14-15". Null when none. */
  bridgeConnectors?: string | null;
  statusHistory?: Array<{ status: string; occurredAt: string }>;
  remakeOriginal?: {
    id: string;
    caseNumber: string;
    patientFirstName: string;
    patientLastName: string;
    status: string;
    createdAt: string | null;
  } | null;
  remakeChildren?: Array<{
    id: string;
    caseNumber: string;
    patientFirstName: string;
    patientLastName: string;
    status: string;
    createdAt: string | null;
    remakeReason: string | null;
    remakeCharged: boolean | null;
  }>;
  /** Structured remake questionnaire fields returned by GET /cases/:id */
  remakeReasonKey?: string | null;
  remakeShadeLightness?: "light" | "dark" | null;
  remakeShadePrescribed?: string | null;
  remakeShadeProvided?: string | null;
  remakeMaterialPrescribed?: string | null;
  remakeMaterialProvided?: string | null;
  remakeReturnedToLab?: boolean | null;
  remakeCategory?: "crown_bridge" | "removable" | null;
};

function formatEventType(eventType: string | undefined | null): string {
  if (!eventType) return "Event";
  // The "Locate Case" UI changes the case's workflow stage via
  // PATCH /cases/:id { status }, which the server records as a
  // "status_changed" event. To users that action is "locating" the
  // case at a station, so surface it as "Location Changed" in the
  // history feed (and in the printed history below).
  if (eventType === "status_changed") return "Location Changed";
  if (eventType === "case_restoration_price_updated") return "Price Override";
  if (eventType === "step_changed") return "Step Changed";
  if (eventType === "step_shade_changed") return "Wax Setup Shade Changed";
  if (eventType === "internal_exception_opened_note") {
    return "Internal Exception — Issue";
  }
  if (eventType === "internal_exception_note_added") {
    return "Internal Exception Note";
  }
  if (eventType === "internal_exception_resolution_note_added") {
    return "Internal Exception — Resolution Note";
  }
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Plain-language one-line summary for invoice lifecycle events
// (`invoice_updated` / `invoice_voided`), mirroring the mobile History row. Lab
// users read sentences, not a stacked title + invoice number + "draft → open"
// arrow, so collapse the affected invoice number and its resulting status into a
// single friendly line: "Invoice INV-9001 marked Open" or
// "Invoice INV-9002 voided". Returns null for any other event type so the
// default title + invoice-detail rendering is used.
function invoiceEventSummary(
  eventType: string | undefined | null,
  metadata: Record<string, unknown>,
): string | null {
  if (eventType === "invoice_emailed") {
    const invoiceNumber =
      typeof metadata.invoiceNumber === "string" && metadata.invoiceNumber
        ? metadata.invoiceNumber
        : null;
    const to =
      typeof metadata.to === "string" && metadata.to ? metadata.to : null;
    const subject = invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice";
    return to ? `${subject} emailed to ${to}` : `${subject} emailed`;
  }
  if (eventType === "statement_emailed") {
    const invoiceNumber =
      typeof metadata.invoiceNumber === "string" && metadata.invoiceNumber
        ? metadata.invoiceNumber
        : null;
    const to =
      typeof metadata.to === "string" && metadata.to ? metadata.to : null;
    const subject = invoiceNumber ? `Invoice ${invoiceNumber}` : "Statement";
    return to ? `${subject} emailed to ${to}` : `${subject} emailed`;
  }
  if (
    eventType !== "invoice_updated" &&
    eventType !== "invoice_voided" &&
    eventType !== "invoice_payments_deleted"
  ) {
    return null;
  }
  const invoiceNumber =
    typeof metadata.invoiceNumber === "string" && metadata.invoiceNumber
      ? metadata.invoiceNumber
      : null;
  const subject = invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice";
  if (eventType === "invoice_payments_deleted") {
    const count =
      typeof metadata.deletedCount === "number" ? metadata.deletedCount : null;
    const noun =
      count === 1 ? "1 payment" : count != null ? `${count} payments` : "payments";
    return `${subject} — ${noun} cleared`;
  }
  const newStatus =
    typeof metadata.newStatus === "string" && metadata.newStatus
      ? metadata.newStatus
      : null;
  if (eventType === "invoice_voided" || newStatus === "void") {
    return `${subject} voided`;
  }
  if (newStatus) {
    const friendlyStatus = newStatus
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `${subject} marked ${friendlyStatus}`;
  }
  return `${subject} updated`;
}
const SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
  "BL1", "BL2", "BL3", "BL4",
];

const TIMELINE_STATUS_LABELS: Record<string, string> = {
  received: "Received",
  in_design: "Design",
  scan: "Scan",
  in_milling: "Milling",
  post_mill: "Post Mill",
  sintering_furnace: "Sintering",
  model_room: "Model Room",
  in_porcelain: "Porcelain",
  qc: "QC",
  complete: "Complete",
  shipped: "Shipped",
  delivered: "Delivered",
  on_hold: "On Hold",
  remake: "Remake",
  cancelled: "Cancelled",
};

function CaseTimelineBar({
  statusHistory,
  currentStatus,
}: {
  statusHistory: Array<{ status: string; label?: string; occurredAt: string }>;
  currentStatus: string;
}) {
  function fmtDate(s: string) {
    try {
      const d = new Date(s);
      return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
    } catch {
      return "";
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto pb-1">
        <div className="flex items-center min-w-max">
          {statusHistory.map((entry, idx) => {
            const isLast = idx === statusHistory.length - 1;
            const isCurrent = entry.status === currentStatus && idx === statusHistory.length - 1;
            const label = entry.label ?? TIMELINE_STATUS_LABELS[entry.status] ?? entry.status;
            return (
              <div key={idx} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5 w-[70px]">
                  <span className="text-[9px] font-semibold text-muted-foreground text-center leading-tight line-clamp-2 h-[22px] flex items-end justify-center">
                    {label}
                  </span>
                  <div
                    className={[
                      "rounded-full border-2 border-background",
                      isCurrent
                        ? "w-3.5 h-3.5 bg-primary ring-2 ring-primary/30"
                        : "w-2.5 h-2.5 bg-primary/70",
                    ].join(" ")}
                  />
                  <span className="text-[9px] text-muted-foreground text-center">
                    {fmtDate(entry.occurredAt)}
                  </span>
                </div>
                {/* Connector */}
                {!isLast && (
                  <div className="relative h-0.5 w-7 bg-border shrink-0 overflow-hidden rounded-full">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-primary/60 w-full" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── NoteComposer ─────────────────────────────────────────────────────────────
// Add-Note composer with optional quick-reference note picker. The picker
// fetches active templates for the case's lab org and appends them on click.
interface QRNoteDesktop {
  id: string;
  body: string;
  label: string | null;
  isActive: boolean;
  displayOrder: number;
}

function NoteComposer({
  noteText,
  setNoteText,
  setNoteError,
  noteError,
  shareWithProvider,
  setShareWithProvider,
  isListeningNote,
  startNoteListening,
  stopNoteListening,
  isPending,
  onSubmit,
  orgId,
}: {
  noteText: string;
  setNoteText: (v: string) => void;
  setNoteError: (v: string | null) => void;
  noteError: string | null;
  shareWithProvider: boolean;
  setShareWithProvider: (v: boolean) => void;
  isListeningNote: boolean;
  startNoteListening: () => void;
  stopNoteListening: () => void;
  isPending: boolean;
  onSubmit: () => void;
  orgId: string | null;
}) {
  const [qrnOpen, setQrnOpen] = useState(false);
  const qrnQuery = useQuery<QRNoteDesktop[]>({
    queryKey: ["quick-reference-notes", orgId],
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const r = await apiFetch<{ notes: QRNoteDesktop[] }>(`/organizations/${orgId}/quick-reference-notes`);
      return (r?.notes ?? []).filter((n: QRNoteDesktop) => n.isActive);
    },
  });
  const activeTemplates = qrnQuery.data ?? [];

  const handleInsert = (body: string) => {
    setNoteText(noteText.trim() ? `${noteText}\n${body}` : body);
    setNoteError(null);
    setQrnOpen(false);
  };

  return (
    <div className="border border-border rounded-md p-3 space-y-2">
      <textarea
        value={noteText}
        onChange={(e) => { setNoteText(e.target.value); setNoteError(null); }}
        placeholder="Add a note…"
        aria-label="Case note"
        rows={3}
        className="w-full text-sm bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground"
      />
      <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
        <input
          type="checkbox"
          checked={shareWithProvider}
          onChange={(e) => setShareWithProvider(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border accent-primary"
        />
        <span className="text-xs text-muted-foreground">Share note with provider</span>
      </label>

      {/* Quick Reference Picker */}
      {qrnQuery.isError ? (
        <p className="text-xs text-destructive">
          Couldn't load quick reference notes{qrnQuery.error instanceof Error ? `: ${qrnQuery.error.message}` : "."}
        </p>
      ) : (
        activeTemplates.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setQrnOpen((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 transition-colors inline-flex items-center gap-1"
            >
              <Bookmark size={11} />
              Add quick reference note
            </button>
            {qrnOpen && (
              <div className="absolute z-30 left-0 bottom-full mb-1 w-72 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg py-1">
                {activeTemplates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-accent transition-colors"
                    onClick={() => handleInsert(t.body)}
                  >
                    {t.label && <div className="text-[11px] font-medium text-primary mb-0.5">{t.label}</div>}
                    <div className="text-xs text-foreground line-clamp-2">{t.body}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      )}

      <div className="flex items-center justify-between pt-1.5 border-t border-border">
        <button
          type="button"
          title={isListeningNote ? "Stop dictation" : "Dictate note"}
          aria-label={isListeningNote ? "Stop dictation" : "Dictate note"}
          onClick={isListeningNote ? stopNoteListening : startNoteListening}
          className={`h-7 w-7 rounded inline-flex items-center justify-center transition-colors ${isListeningNote ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"}`}
        >
          <Mic size={13} />
        </button>
        <button
          type="button"
          disabled={!noteText.trim() || isPending}
          onClick={onSubmit}
          className="h-7 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
        >
          {isPending ? <Loader2 size={12} className="animate-spin" /> : "Add note"}
        </button>
      </div>
      {noteError && <p className="text-xs text-destructive">{noteError}</p>}
    </div>
  );
}

type CaseTab = "lab-slip" | "restorations" | "notes" | "files" | "invoice" | "history";

function buildCaseMediaGallery(
  caseId: string,
  attachments: CaseAttachment[] | undefined,
): LightboxItem[] {
  return (attachments ?? []).flatMap((attachment) => {
    const kind = classifyMediaKind(attachment.fileType, attachment.fileName);
    if (!kind) return [];
    return [
      {
        attachmentId: attachment.id,
        url: `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`,
        kind,
        mimeType: attachment.fileType || undefined,
        fileName: attachment.fileName,
      },
    ];
  });
}

export function remakeChainLocationLabel(
  entry: { status: string | null; labLocationId?: string | null; labLocationName?: string | null },
  locations: Array<{ id: string; label: string }> = [],
): string {
  return (
    entry.labLocationName ||
    (entry.labLocationId
      ? locations.find((location) => location.id === entry.labLocationId)?.label
      : null) ||
    statusLabel(entry.status)
  );
}

export function CaseDrawer({
  labCase,
  onClose,
  doctorNames = [],
  patientLastNames = [],
  patientFirstNames = [],
  onOpenCaseId,
  onCaseLocated,
  docked = false,
  onExpand,
  initialTab = "lab-slip",
}: {
  initialTab?: CaseTab;
  docked?: boolean;
  onExpand?: () => void;
  labCase: LabCase;
  onClose: () => void;
  doctorNames?: string[];
  patientLastNames?: string[];
  patientFirstNames?: string[];
  onOpenCaseId?: (id: string) => void;
  onCaseLocated?: (newStatus: CaseStatus) => void;
}) {
  const drawerLayoutRef = useDockedDrawerHeight(docked);
  const qc = useQueryClient();
  const { user } = useAuth();
  const attachmentPreferenceKey = attachmentSectionPreferenceKey(user?.id);
  const initialAttachmentPreference = useMemo(() => {
    try {
      return parseAttachmentSectionPreference(localStorage.getItem(attachmentPreferenceKey));
    } catch {
      return null;
    }
  }, [attachmentPreferenceKey]);
  const [attachmentSectionsExpanded, setAttachmentSectionsExpanded] =
    useState(() => initialAttachmentPreference?.expanded ?? COLLAPSED_ATTACHMENT_SECTIONS);
  const [attachmentSectionSave, setAttachmentSectionSave] = useState(
    () =>
      initialAttachmentPreference?.save ?? {
        ...COLLAPSED_ATTACHMENT_SECTIONS,
        all: false,
      },
  );
  const { openPanel: openAiPanel } = useAiPanel();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDragCounterRef = useRef(0);

  const [activeTab, setActiveTab] = useState<CaseTab>(initialTab);
  const [historySortOrder, setHistorySortOrder] = useState<"asc" | "desc">("desc");
  const [remakeChainExpanded, setRemakeChainExpanded] = useState(true);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [lightbox, setLightbox] = useState<
    Lightbox
  >(null);
  const [activeLightboxIdentity, setActiveLightboxIdentity] = useState<string | null>(
    null,
  );
  const openLightbox = useCallback((next: Lightbox) => {
    setLightbox(next);
    setActiveLightboxIdentity(next?.attachmentId ?? next?.url ?? null);
  }, []);
  const [confirmDeleteCase, setConfirmDeleteCase] = useState(false);
  const [reassignDoctorOpen, setReassignDoctorOpen] = useState(false);
  const [remakeFromDetailOpen, setRemakeFromDetailOpen] = useState(false);
  const [remakeFromDetailQ, setRemakeFromDetailQ] = useState<RemakeQuestionnaireValue>(blankQuestionnaire);
  const [remakeFromDetailDueDate, setRemakeFromDetailDueDate] = useState<string>(
    () => labCase.dueDate ? new Date(labCase.dueDate).toISOString().split("T")[0] : ""
  );
  const [remakeFromDetailDueTime, setRemakeFromDetailDueTime] = useState<string>("");
  const [remakeFromDetailHasDueTime, setRemakeFromDetailHasDueTime] = useState(false);
  const [remakeFromDetailLoading, setRemakeFromDetailLoading] = useState(false);
  const [remakeFromDetailError, setRemakeFromDetailError] = useState<string | null>(null);

  const [editRemakeOpen, setEditRemakeOpen] = useState(false);
  const [editRemakeQ, setEditRemakeQ] = useState<RemakeQuestionnaireValue>(blankQuestionnaire);
  const [editRemakeLoading, setEditRemakeLoading] = useState(false);
  const [editRemakeError, setEditRemakeError] = useState<string | null>(null);

  async function handleRemakeFromDetail() {
    const q = remakeFromDetailQ;
    if (!isRemakeQuestionnaireComplete(q)) {
      setRemakeFromDetailError(remakeQuestionnaireError(q));
      return;
    }
    const found = REMAKE_REASONS.find((r) => r.key === q.reasonKey);
    const reasonLabel = found?.label ?? q.reasonKey;
    setRemakeFromDetailLoading(true);
    setRemakeFromDetailError(null);
    try {
      const result = await apiFetch<{ id: string; caseNumber: string }>(
        `/cases/${labCase.id}/remake`,
        {
          method: "POST",
          body: JSON.stringify({
            remakeReasonKey: q.reasonKey,
            remakeReason: q.reasonKey === "other" ? (q.customReason ?? "").trim() : reasonLabel,
            remakeCharged: q.charge === "yes" ? true : q.charge === "no" ? false : null,
            remakeShadeLightness: q.shadeLightness || undefined,
            remakeShadePrescribed: q.shadePrescribed || undefined,
            remakeShadeProvided: q.shadeProvided || undefined,
            remakeMaterialPrescribed: q.materialPrescribed || undefined,
            remakeMaterialProvided: q.materialProvided || undefined,
            remakeReturnedToLab: q.returnedToLab ?? undefined,
            remakeCategory: q.category || undefined,
            remakeNotes: q.notes.trim() || undefined,
            ...(remakeFromDetailDueDate ? { dueDate: remakeFromDetailDueDate } : {}),
            ...(remakeFromDetailDueDate && remakeFromDetailHasDueTime && remakeFromDetailDueTime
              ? { dueTime: remakeFromDetailDueTime }
              : {}),
          }),
        },
      );
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setRemakeFromDetailOpen(false);
      toast.success(`Remake case #${result.caseNumber} created.`);
      if (onOpenCaseId) onOpenCaseId(result.id);
    } catch (e: unknown) {
      setRemakeFromDetailError(e instanceof Error ? e.message : "Failed to create remake.");
    } finally {
      setRemakeFromDetailLoading(false);
    }
  }
  function openEditRemake() {
    const d = data;
    setEditRemakeQ({
      reasonKey: (d?.remakeReasonKey ?? "") as RemakeReasonKey | "",
      customReason: d?.remakeReasonKey === "other" ? (d?.remakeReason ?? "") : "",
      shadeLightness: (d?.remakeShadeLightness ?? "") as "light" | "dark" | "",
      shadePrescribed: d?.remakeShadePrescribed ?? "",
      shadeProvided: d?.remakeShadeProvided ?? "",
      materialPrescribed: d?.remakeMaterialPrescribed ?? "",
      materialProvided: d?.remakeMaterialProvided ?? "",
      returnedToLab: d?.remakeReturnedToLab ?? null,
      category: (d?.remakeCategory ?? "") as "crown_bridge" | "removable" | "",
      charge: d?.remakeCharged === true ? "yes" : d?.remakeCharged === false ? "no" : "",
      notes: d?.remakeNotes ?? "",
    });
    setEditRemakeError(null);
    setEditRemakeOpen(true);
  }

  async function handleEditRemakeSave() {
    const q = editRemakeQ;
    if (!isRemakeQuestionnaireComplete(q)) {
      setEditRemakeError(remakeQuestionnaireError(q));
      return;
    }
    const found = REMAKE_REASONS.find((r) => r.key === q.reasonKey);
    const reasonLabel = found?.label ?? q.reasonKey;
    setEditRemakeLoading(true);
    setEditRemakeError(null);
    try {
      await apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
            remakeReasonKey: q.reasonKey,
            remakeReason: q.reasonKey === "other" ? (q.customReason ?? "").trim() : reasonLabel,
          remakeCharged: q.charge === "yes" ? true : q.charge === "no" ? false : null,
          remakeShadeLightness: q.shadeLightness || undefined,
          remakeShadePrescribed: q.shadePrescribed || undefined,
          remakeShadeProvided: q.shadeProvided || undefined,
          remakeMaterialPrescribed: q.materialPrescribed || undefined,
          remakeMaterialProvided: q.materialProvided || undefined,
          remakeReturnedToLab: q.returnedToLab ?? undefined,
          remakeCategory: q.category || undefined,
          remakeNotes: q.notes.trim() || null,
        }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["case", labCase.id] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["case-remake-chain", labCase.id] }),
      ]);
      setEditRemakeOpen(false);
      toast.success("Remake reason updated.");
    } catch (e: unknown) {
      setEditRemakeError(e instanceof Error ? e.message : "Failed to update remake reason.");
    } finally {
      setEditRemakeLoading(false);
    }
  }

  const [showPrintLayoutEditor, setShowPrintLayoutEditor] = useState(false);
  const [showCaseAdvancedEditor, setShowCaseAdvancedEditor] = useState(false);
  const [rxPreviewOpen, setRxPreviewOpen] = useState(false);
  // Which case the prescription preview should show. Null = the case this
  // drawer is open on. The History tab's "View Rx" buttons set this so a
  // merged remake-chain entry previews the case that entry belongs to.
  const [rxPreviewCaseId, setRxPreviewCaseId] = useState<string | null>(null);
  const [printLayout, setPrintLayout] = useState<PrintLayoutConfig>(() => loadPrintLayoutConfig());

  // Per-lab advanced (drag/scale) print template. Null = no custom layout
  // yet — the Print button keeps the existing list-based lab slip.
  const advancedTemplateQuery = useQuery<{
    template: CasePrintTemplate;
    isCustom: boolean;
  }>({
    enabled: !!labCase.labOrganizationId,
    queryKey: ["casePrintTemplate", labCase.labOrganizationId],
    queryFn: async () => {
      const res = await apiFetch<
        { data: { template: unknown; isCustom: boolean } } | { template: unknown; isCustom: boolean }
      >(`/organizations/${labCase.labOrganizationId}/case-print-template?caseId=${encodeURIComponent(labCase.id)}`);
      const inner = (res as { data?: { template: unknown; isCustom: boolean } }).data ?? (res as { template: unknown; isCustom: boolean });
      return {
        template: coerceCasePrintTemplate(inner.template),
        isCustom: !!inner.isCustom,
      };
    },
  });
  const hasAdvancedTemplate = !!advancedTemplateQuery.data?.isCustom;

  interface LabLocation { id: string; value: string; label: string }
  const locationsQuery = useQuery<LabLocation[]>({
    enabled: !!labCase.labOrganizationId,
    queryKey: ["locations", labCase.labOrganizationId, "active"],
    queryFn: async () => {
      try {
        const rows = await apiFetch<Array<{ id: string; code: string; name: string; status: string }>>(
          `/locations?organizationId=${labCase.labOrganizationId}&activeOnly=true`
        );
        if (!Array.isArray(rows) || rows.length === 0) return [];
        // `id` is the unique station key (used for the option value + React key
        // so two custom stations mapped to the same stage stay distinct, like
        // mobile). `value` is the mapped workflow stage (a valid case-status)
        // sent to the API — sending the free-form code broke custom stations.
        return rows.map((r) => ({ id: r.id, value: r.status, label: r.name }));
      } catch {
        return [];
      }
    },
    staleTime: 60_000,
  });

  const [editMode, setEditMode] = useState(false);
  const barcodeScanInputRef = useRef<HTMLInputElement>(null);
  const [caseNumberEditMode, setCaseNumberEditMode] = useState(false);
  const [caseNumberEditValue, setCaseNumberEditValue] = useState("");
  const [caseNumberSaving, setCaseNumberSaving] = useState(false);
  const [caseNumberError, setCaseNumberError] = useState<string | null>(null);
  const caseNumberInputRef = useRef<HTMLInputElement>(null);
  const [barcodeEditMode, setBarcodeEditMode] = useState(false);
  const [barcodeEditValue, setBarcodeEditValue] = useState("");
  const [optimisticBarcode, setOptimisticBarcode] = useState<string | null>(null);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [barcodeConflictValue, setBarcodeConflictValue] = useState<string | null>(null);
  const barcodeInlineInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editMode) return;
    const id = setTimeout(() => barcodeScanInputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [editMode]);
  const [editForm, setEditForm] = useState({
    patientFirstName: labCase.patientFirstName || "",
    patientLastName: labCase.patientLastName || "",
    doctorName: labCase.doctorName || "",
    providerOrganizationId: labCase.providerOrganizationId || "",
    receivedAt:
      labCase.receivedAt && isValidCalendarDate(labCase.receivedAt)
        ? labCase.receivedAt
        : "",
    dueDate: labCase.dueDate
      ? new Date(labCase.dueDate).toISOString().split("T")[0]
      : "",
    dueTime: labCase.dueTime || "",
    priority: (labCase.priority || "normal") as "normal" | "rush",
    casePanBarcode: labCase.casePanBarcode || "",
    rxNotes: labCase.caseNotes ?? "",
    gingivialShade: (labCase.gingivialShade ?? "").trim(),
  });
  const [editHasDueTime, setEditHasDueTime] = useState(Boolean(labCase.dueTime));
  const [editError, setEditError] = useState<string | null>(null);

  // ── Edit-form barcode conflict check ─────────────────────────────────────
  const [editBarcodeConflict, setEditBarcodeConflict] = useState<LabCase | null>(null);
  const [editBarcodeChecking, setEditBarcodeChecking] = useState(false);
  useEffect(() => {
    const trimmed = editForm.casePanBarcode.trim();
    if (!trimmed || !labCase.labOrganizationId) {
      setEditBarcodeConflict(null);
      setEditBarcodeChecking(false);
      return;
    }
    setEditBarcodeChecking(true);
    const t = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          barcode: trimmed,
          organizationId: labCase.labOrganizationId ?? "",
        });
        const res = await apiFetch<LabCase[]>(`/cases?${params.toString()}`);
        const matches = Array.isArray(res) ? res : [];
        const conflict = matches.filter((c) => c.status !== "complete" && c.id !== labCase.id)[0] ?? null;
        setEditBarcodeConflict(conflict);
      } catch {
        setEditBarcodeConflict(null);
      } finally {
        setEditBarcodeChecking(false);
      }
    }, 400);
    return () => { window.clearTimeout(t); };
  }, [editForm.casePanBarcode, labCase.id, labCase.labOrganizationId]);

  // ── Inline barcode-edit conflict check (barcodeEditMode only) ────────────
  const [inlineBarcodeConflict, setInlineBarcodeConflict] = useState<LabCase | null>(null);
  const [inlineBarcodeChecking, setInlineBarcodeChecking] = useState(false);
  useEffect(() => {
    if (!barcodeEditMode) {
      setInlineBarcodeConflict(null);
      setInlineBarcodeChecking(false);
      return;
    }
    const trimmed = barcodeEditValue.trim();
    if (!trimmed || !labCase.labOrganizationId) {
      setInlineBarcodeConflict(null);
      setInlineBarcodeChecking(false);
      return;
    }
    setInlineBarcodeChecking(true);
    const t = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          barcode: trimmed,
          organizationId: labCase.labOrganizationId ?? "",
        });
        const res = await apiFetch<LabCase[]>(`/cases?${params.toString()}`);
        const matches = Array.isArray(res) ? res : [];
        const conflict = matches.filter((c) => c.status !== "complete" && c.id !== labCase.id)[0] ?? null;
        setInlineBarcodeConflict(conflict);
      } catch {
        setInlineBarcodeConflict(null);
      } finally {
        setInlineBarcodeChecking(false);
      }
    }, 400);
    return () => { window.clearTimeout(t); };
  }, [barcodeEditValue, barcodeEditMode, labCase.id, labCase.labOrganizationId]);

  const [routeStatus, setRouteStatus] = useState("");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeSuccessMsg, setRouteSuccessMsg] = useState<string | null>(null);
  const routeInFlightRef = useRef(false);
  const routeSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (routeSuccessTimerRef.current !== null) clearTimeout(routeSuccessTimerRef.current);
  }, []);
  // Re-receive wizard: shown when routing a complete case to an intake station.
  // Walks the user through the questions that matter when a case comes back —
  // due date, new prescription, remake linking, removable step, notes, and the
  // two reprints. Every answer applies immediately and closing the panel just
  // skips the remaining questions.
  const [returnPromptStep, setReturnPromptStep] = useState<ReturnWizardStage | null>(null);
  const [returnPromptStatus, setReturnPromptStatus] = useState<string | null>(null);
  const [returnPromptLabLocationId, setReturnPromptLabLocationId] = useState<string | null>(null);
  const [returnDueDate, setReturnDueDate] = useState("");
  const [returnDueTime, setReturnDueTime] = useState("");
  const [returnStep, setReturnStep] = useState("");
  const [returnDueDateDeclined, setReturnDueDateDeclined] = useState(false);
  const [returnRemakeSelected, setReturnRemakeSelected] = useState<RemakeCaseHit | null>(null);
  const [returnRemakeQ, setReturnRemakeQ] = useState<RemakeQuestionnaireValue>(blankQuestionnaire);
  const [returnRemakeError, setReturnRemakeError] = useState<string | null>(null);
  const [returnRxDragOver, setReturnRxDragOver] = useState(false);
  const returnRxInputRef = useRef<HTMLInputElement>(null);
  // Escape behaves exactly like the popup's Close button: skip the remaining
  // questions and leave the case routed to its new station.
  useEffect(() => {
    if (!returnPromptStep) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      resetReturnWizard();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnPromptStep]);
  const [qrLinkCopied, setQrLinkCopied] = useState(false);

  const [noteText, setNoteText] = useState("");
  const [shareWithProvider, setShareWithProvider] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [isListeningNote, setIsListeningNote] = useState(false);
  const noteRecognitionRef = useRef<any>(null);
  // Captures the textarea content at the moment dictation starts so that
  // every onresult event computes the new value against this fixed baseline
  // rather than the already-updated state (which caused the duplication bug).
  const noteDictationBaseRef = useRef<string>("");
  // Accumulates finalized transcript segments across events within one session.
  const noteFinalTranscriptRef = useRef<string>("");

  const startNoteListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;

    // Abort any in-progress session cleanly before starting a new one.
    noteRecognitionRef.current?.abort?.();
    noteRecognitionRef.current = null;

    // Snapshot pre-dictation text once — never read from state inside onresult.
    noteDictationBaseRef.current = noteText.trimEnd();
    noteFinalTranscriptRef.current = "";

    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e: any) => {
      const newResults = Array.from(
        { length: e.results.length - e.resultIndex },
        (_, i) => ({
          isFinal: e.results[e.resultIndex + i].isFinal as boolean,
          transcript: e.results[e.resultIndex + i][0].transcript as string,
        }),
      );
      const { noteText: next, newFinal } = composeNoteDictation(
        newResults,
        noteFinalTranscriptRef.current,
        noteDictationBaseRef.current,
      );
      noteFinalTranscriptRef.current = newFinal;
      setNoteText(next);
      setNoteError(null);
    };
    r.onerror = () => { setIsListeningNote(false); };
    r.onend = () => { setIsListeningNote(false); };
    noteRecognitionRef.current = r;
    r.start();
    setIsListeningNote(true);
  }, [noteText]);

  const stopNoteListening = useCallback(() => {
    noteRecognitionRef.current?.stop();
    noteRecognitionRef.current = null;
    setIsListeningNote(false);
  }, []);

  // Stop recognition when the drawer moves to a different case or unmounts so
  // no stale session bleeds into the next case's note field.
  useEffect(() => {
    return () => {
      noteRecognitionRef.current?.abort?.();
      noteRecognitionRef.current = null;
    };
  }, [labCase.id]);
  const [notifyModal, setNotifyModal] = useState<{
    open: boolean;
    noteId: string;
    method: "email" | "sms" | "labtrax_only" | null;
    step: "choose" | "confirm_save" | "success";
    sending: boolean;
    error: string | null;
  }>({ open: false, noteId: "", method: null, step: "choose", sending: false, error: null });

  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Files awaiting per-file notes before upload. Each entry pairs a picked/dropped
  // file with its own optional note draft so a note can never land on the wrong
  // file when several are added at once. `null` means the prompt is closed.
  const [pendingUploads, setPendingUploads] = useState<
    { file: File; note: string }[] | null
  >(null);

  const [generatingInvoice, setGeneratingInvoice] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);
  const [generatePresetId, setGeneratePresetId] = useState<string>("");
  const [invoicePrintLogoDataUrl, setInvoicePrintLogoDataUrl] = useState<string | null>(null);
  const [invoicePrintQrDataUrl, setInvoicePrintQrDataUrl] = useState<string | null>(null);

  const generatePresetsQuery = useQuery({
    queryKey: ["invoice-template-presets", labCase.labOrganizationId],
    queryFn: () =>
      apiFetch<{ presets: Array<{ id: string; name: string; template?: unknown }> }>(
        `/organizations/${labCase.labOrganizationId}/invoice-template/presets`,
      ),
    staleTime: 60_000,
  });
  const generatePresets = generatePresetsQuery.data?.presets ?? [];

  const billableItemsQuery = useQuery({
    queryKey: ["finance", "vendors", labCase.labOrganizationId, "items"],
    queryFn: () =>
      apiFetch<Array<{ id: string; name: string; unitPrice: string | null }>>(
        `/finance/vendors?organizationId=${encodeURIComponent(labCase.labOrganizationId)}&vendorType=item`,
      ),
    enabled: !!labCase.labOrganizationId,
    staleTime: 60_000,
  });
  const billableItems = billableItemsQuery.data ?? [];

  const materialVocabQuery = useQuery({
    queryKey: ["vocabulary", "material", labCase.labOrganizationId],
    queryFn: () =>
      apiFetch<Array<{ id: string; value: string; isDefault: boolean }>>(
        `/vocabulary?kind=material&labOrganizationId=${encodeURIComponent(labCase.labOrganizationId)}`,
      ),
    enabled: !!labCase.labOrganizationId,
    staleTime: 120_000,
  });
  const materialSuggestions = (materialVocabQuery.data ?? []).map((v) => v.value);

  const shadeVocabQuery = useQuery({
    queryKey: ["vocabulary", "shade", labCase.labOrganizationId],
    queryFn: () =>
      apiFetch<Array<{ id: string; value: string; isDefault: boolean }>>(
        `/vocabulary?kind=shade&labOrganizationId=${encodeURIComponent(labCase.labOrganizationId)}`,
      ),
    enabled: !!labCase.labOrganizationId,
    staleTime: 120_000,
  });
  const shadeSuggestions = (shadeVocabQuery.data ?? []).map((v) => v.value);

  const restorationTypeVocabQuery = useQuery({
    queryKey: ["vocabulary", "restoration_type", labCase.labOrganizationId],
    queryFn: () =>
      apiFetch<Array<{ id: string; value: string; isDefault: boolean }>>(
        `/vocabulary?kind=restoration_type&labOrganizationId=${encodeURIComponent(labCase.labOrganizationId)}`,
      ),
    enabled: !!labCase.labOrganizationId,
    staleTime: 120_000,
  });
  const restorationTypeSuggestions = (() => {
    const fromVocab = (restorationTypeVocabQuery.data ?? []).map((v) => v.value);
    const extra = billableItems
      .map((it) => it.name)
      .filter(
        (n) => !fromVocab.some((s) => s.toLowerCase() === n.toLowerCase()),
      );
    return [...fromVocab, ...extra];
  })();

  async function createVocabItem(
    kind: "material" | "shade" | "restoration_type",
    value: string,
  ): Promise<string | null> {
    if (!labCase.labOrganizationId) return null;
    try {
      const result = await apiFetch<{ id: string; value: string; isDefault: boolean }>(
        "/vocabulary",
        {
          method: "POST",
          body: JSON.stringify({ kind, value, labOrganizationId: labCase.labOrganizationId }),
        },
      );
      qc.invalidateQueries({ queryKey: ["vocabulary", kind, labCase.labOrganizationId] });
      return result.value;
    } catch {
      return null;
    }
  }

  function lookupBillablePrice(name: string): string {
    if (!name) return "";
    const match = billableItems.find(
      (it) => it.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    return match?.unitPrice ? String(match.unitPrice) : "";
  }

  const [showAddRest, setShowAddRest] = useState(false);
  const [restForm, setRestForm] = useState({
    implantRetention: null as string | null,
    implantManufacturer: null as string | null,
    implantPlatformNotes: null as string | null,
    toothNumber: "",
    restorationType: "",
    customType: "",
    material: "",
    restorationSubtype: null as string | null,
    shade: "",
    quantity: 1,
    unitPrice: "",
  });
  const [restError, setRestError] = useState<string | null>(null);

  // Interactive tooth chart dialog state
  const [toothDialogId, setToothDialogId] = useState<string | null>(null);
  const [toothDialogError, setToothDialogError] = useState<string | null>(null);
  const [toothCopySourceId, setToothCopySourceId] = useState<string | null>(null);
  const [toothCopyAnchor, setToothCopyAnchor] = useState<string | null>(null);
  const [toothCopyTargets, setToothCopyTargets] = useState("");
  const [toothCopyMessage, setToothCopyMessage] = useState("");
  const [toothMultiSelect, setToothMultiSelect] = useState(false);
  const [toothSelectedTargets, setToothSelectedTargets] = useState<string[]>([]);
  const [toothSelectionAnchor, setToothSelectionAnchor] = useState<string | null>(null);
  const [connectorSaveError, setConnectorSaveError] = useState<string | null>(null);
  const [connectorDraft, setConnectorDraft] = useState<string | null>(null);

  // --- Draft / pending changes state ---
  type PendingCreate = ImplantDetails & {
    localId: string;
    toothNumber: string;
    restorationType: string;
    material: string;
    restorationSubtype?: string | null;
    shade: string;
    quantity: number;
    unitPrice: string;
    arch?: "upper" | "lower";
  };
  type PendingUpdate = {
    restorationId: string;
    newToothNumber: string;
    material?: string;
    restorationSubtype?: string;
    shade?: string;
    restorationType?: string;
    arch?: "upper" | "lower" | null;
  };
  type PendingCaseEdit = {
    patientFirstName: string;
    patientLastName: string;
    doctorName: string;
    providerOrganizationId: string;
    receivedAt: string;
    dueDate: string;
    dueTime: string;
    priority: "normal" | "rush";
    casePanBarcode: string;
    rxNotes: string;
    gingivialShade: string;
  };

  const [pendingCreates, setPendingCreates] = useState<PendingCreate[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const [pendingUpdates, setPendingUpdates] = useState<PendingUpdate[]>([]);
  const [chartDraftChanged, setChartDraftChanged] = useState(false);
  const [toothUndo, setToothUndo] = useState<{
    creates: PendingCreate[]; deletes: Set<string>; updates: PendingUpdate[]; connectors: string | null;
  } | null>(null);
  function captureToothUndo() {
    setChartDraftChanged(true);
    setToothUndo({
      creates: [...pendingCreates], deletes: new Set(pendingDeletes),
      updates: [...pendingUpdates], connectors: connectorDraft,
    });
  }
  const [pendingCaseEdit, setPendingCaseEdit] = useState<PendingCaseEdit | null>(null);
  const [pendingRxSummaryEdit, setPendingRxSummaryEdit] = useState<{
    type: string;
    material: string;
    restorationSubtype?: string | null;
    shade: string;
    teeth: string;
    arch: "" | "upper" | "lower" | "both";
    step: string;
    stepShade: string;
    changed: {
      shade: boolean;
      arch: boolean;
      step: boolean;
      stepShade: boolean;
    };
  } | null>(null);
  const [editRxType, setEditRxType] = useState("Other");
  const [editRxMaterial, setEditRxMaterial] = useState("");
  const [editRxSubtype, setEditRxSubtype] = useState<string | null>(null);
  const [editImplants, setEditImplants] = useState<Record<string, ImplantDetails>>({});
  const savedImplantDrafts = useRef<Record<string, ImplantDetails>>({});
  const originalEditForm = useRef<PendingCaseEdit | null>(null);
  const [editRxShade, setEditRxShade] = useState("");
  const [editRxTeeth, setEditRxTeeth] = useState("");
  const [editRxArch, setEditRxArch] = useState<"" | "upper" | "lower" | "both">("");
  const [editRxStep, setEditRxStep] = useState("");
  const [editRxStepShade, setEditRxStepShade] = useState("");
  // Optimistic state for missing-tooth auto-saves (applied immediately, cleared
  // after the server round-trip + cache refetch complete so there's no flicker).
  const [optimisticMissingAdds, setOptimisticMissingAdds] = useState<Set<string>>(new Set());
  const [optimisticMissingDeletes, setOptimisticMissingDeletes] = useState<Set<string>>(new Set());
  const [quickDueDateOverride, setQuickDueDateOverride] = useState<string | null>(null);
  const quickDueDateInputRef = useRef<HTMLInputElement | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A partial save may commit the hierarchy before a later row write fails.
  // Retrying the unchanged editor must not reconcile it again and undo rows
  // already committed by that attempt.
  const savedRxDraft = useRef<string | null>(null);
  // When unsaved edits would be lost (close, in-app route navigation, etc.) we
  // stash the action to run if the user confirms; a non-null value shows the
  // "Unsaved changes" discard confirmation.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(
    null,
  );

  const catalogQuery = useEffectiveCatalog(labCase.labOrganizationId);

  const { data, isLoading, refetch: refetchCaseDetail } = useQuery({
    queryKey: ["case", labCase.id],
    queryFn: () => apiFetch<DetailedCase>(`/cases/${labCase.id}`),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const reassignMe = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    enabled: !!user,
  });
  const canReassignDoctor = !!data && (reassignMe.data?.memberships ?? []).some((membership) =>
    membership.organizationId === data.labOrganizationId && membership.status === "active" &&
    (membership.role === "admin" || membership.role === "owner"),
  );
  // An open/staged edit also contains its old doctor/practice values. Finish
  // it first so a later full-form save cannot accidentally reverse this action.
  const hasUnsavedDoctorAssignment = editMode || !!pendingCaseEdit;
  useEffect(() => { setReassignDoctorOpen(false); }, [labCase.id, data?.providerOrganizationId]);
  // Keep all gallery derivation below the detail query declaration. CaseDrawer
  // renders before the request resolves, so reading a `data` binding above
  // this point would trigger a temporal-dead-zone ReferenceError.
  const currentCaseAttachments = data?.attachments;
  const groupedCaseAttachments = useMemo(
    () => groupCaseAttachments(currentCaseAttachments ?? []),
    [currentCaseAttachments],
  );
  const caseMediaGallery = useMemo(
    () => buildCaseMediaGallery(labCase.id, currentCaseAttachments),
    [labCase.id, currentCaseAttachments],
  );
  const openCaseAttachment = useCallback(
    (attachment: CaseAttachment) => {
      const item = caseMediaGallery.find(
        (candidate) => candidate.attachmentId === attachment.id,
      );
      if (item) openLightbox({ ...item, gallery: caseMediaGallery });
    },
    [caseMediaGallery, openLightbox],
  );
  useEffect(() => {
    setLightbox((current) => {
      if (!current?.gallery) return current;
      const selectedIdentity =
        activeLightboxIdentity ?? current.attachmentId ?? current.url;
      const currentItem = caseMediaGallery.find(
        (item) =>
          (item.attachmentId ?? item.url) === selectedIdentity,
      );
      return currentItem
        ? { ...currentItem, gallery: caseMediaGallery }
        : null;
    });
    if (
      activeLightboxIdentity &&
      !caseMediaGallery.some(
        (item) =>
          (item.attachmentId ?? item.url) === activeLightboxIdentity,
      )
    ) {
      setActiveLightboxIdentity(null);
    }
  }, [activeLightboxIdentity, caseMediaGallery]);
  const canEditReturnStep = user?.role === "admin" || user?.role === "owner";
  // The returned-case wizard asks the notes question only when the viewer can
  // actually post one; the server flag is optional, so absence means "allowed".
  const canPostReturnNote = data?.viewerCanPostNotes !== false;
  // Mobile-created cases keep their files in the mobile app, so the desktop
  // attachment pipeline cannot accept a prescription for them.
  const returnRxBlockedReason =
    labCase._source === "mobile"
      ? "This case was created in the mobile app — new prescription files can only be attached there."
      : data?.viewerCanUploadAttachments === false
        ? "You don't have permission to attach files to this case."
        : null;
  // The drawer detail fetch may still be loading when the user prints. Keep
  // its Lab Slip and both print renderers on the same restoration source.
  const caseRestorations = data?.restorations ?? labCase.restorations ?? [];
  const toothDialogRestoration = toothDialogId
    ? (data?.restorations ?? []).find((restoration) =>
        parseToothField(restoration.toothNumber).has(toothDialogId),
      )
    : undefined;
  const toothDialogMaterialOptions = getCatalogMaterialsForRestoration(
    catalogQuery.data,
    toothDialogRestoration,
  );

  type RemakeChainEntry = {
    id: string;
    caseNumber: string;
    status: string | null;
    labLocationId?: string | null;
    labLocationName?: string | null;
    remakeReason: string | null;
    remakeCharged: boolean | null;
    remakeNotes?: string | null;
    remakeShadeLightness?: "light" | "dark" | null;
    remakeShadePrescribed?: string | null;
    remakeShadeProvided?: string | null;
    remakeMaterialPrescribed?: string | null;
    remakeMaterialProvided?: string | null;
    remakeReturnedToLab?: boolean | null;
    createdAt: string | null;
  };
  const inRemakeChain =
    !!(data?.remakeOriginal) || (data?.remakeChildren?.length ?? 0) > 0;
  const remakeChainQuery = useQuery({
    queryKey: ["case-remake-chain", labCase.id],
    queryFn: () =>
      apiFetch<{ chain: RemakeChainEntry[] }>(`/cases/${labCase.id}/remake-chain`),
    enabled: inRemakeChain,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const remakeChain = remakeChainQuery.data?.chain ?? [];

  // When the drawer is reused for a different case, remove the previous
  // case's chain from the cache so stale data never bleeds across.
  useEffect(() => {
    return () => {
      qc.removeQueries({ queryKey: ["case-remake-chain", labCase.id] });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labCase.id]);

  const drawerOrgsQuery = useQuery({
    queryKey: ["organizations", { includeLabPractices: true }],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeLabPractices=true"),
  });
  const drawerProviderOrgs = useMemo(
    () => (drawerOrgsQuery.data ?? []).filter((o) => o.type !== "lab"),
    [drawerOrgsQuery.data],
  );

  // Dedicated lightweight endpoint for doctor-name suggestions. Always runs so
  // the picker is populated even when opened from the dashboard (before the
  // full cases list has loaded). Merges with any names the parent pre-computed.
  const doctorNamesQuery = useQuery({
    queryKey: ["case-doctor-names"],
    queryFn: () => apiFetch<string[]>("/cases/doctor-names"),
    staleTime: 60_000,
  });
  const effectiveDoctorNames = useMemo(() => {
    const fromQuery = doctorNamesQuery.data ?? [];
    if (!doctorNames.length) return fromQuery;
    const merged = new Set([...doctorNames, ...fromQuery]);
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  }, [doctorNames, doctorNamesQuery.data]);

  const invoiceQuery = useQuery({
    queryKey: ["invoice-for-case", labCase.id],
    queryFn: () =>
      apiFetch<Invoice[]>(`/invoices?caseId=${encodeURIComponent(labCase.id)}`),
  });
  const caseInvoice = invoiceQuery.data?.[0] ?? null;
  const canEditCaseInvoice =
    ["owner", "admin", "billing"].includes(user?.role ?? "") &&
    user?.userType !== "provider" &&
    data?.viewerIsLabMember !== false;

  // Pull the full invoice payload (with line items) when one exists so the
  // Print Invoice button has data to render. Cheap query — only runs while
  // the drawer is open and an invoice is present.
  const invoiceDetailQuery = useQuery({
    queryKey: ["invoice-detail", caseInvoice?.id],
    enabled: !!caseInvoice?.id,
    queryFn: () =>
      apiFetch<Invoice>(`/invoices/${caseInvoice!.id}`),
  });
  const confirmedPresetId = invoiceDetailQuery.data?.layoutPresetId ?? caseInvoice?.layoutPresetId;
  const { template: confirmedInvoiceTemplate, extraImageDataUrls: confirmedInvoiceImages } = useInvoiceTemplate(
    generatePresets.find((preset) => preset.id === confirmedPresetId)?.template ?? user?.practiceInvoiceTemplate,
  );

  /** True when any invoice sub-item still carries priced===false (alloy not yet quoted). */
  const hasUnpricedAlloyLines = (invoiceDetailQuery.data?.items ?? []).some((it) =>
    (it.subItems ?? []).some(
      (sub) => sub.priced === false && sub.description.startsWith("Alloy"),
    ),
  );

  // Pre-fetch lab logo as a data URL for invoice PDF printing (mirrors
  // the same logic in InvoiceEditor so the output is identical).
  const invoicePlacementActive = !!(user?.practiceLogoplacements?.includes("invoices"));
  useEffect(() => {
    const logoUrl = user?.practiceLogoUrl;
    if (!invoicePlacementActive || !logoUrl) {
      setInvoicePrintLogoDataUrl(null);
      return;
    }
    let cancelled = false;
    fetch(logoUrl)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => { if (!cancelled) setInvoicePrintLogoDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setInvoicePrintLogoDataUrl(null); });
    return () => { cancelled = true; };
  }, [invoicePlacementActive, user?.practiceLogoUrl]);

  // Pre-generate a QR code data URL for the invoice PDF print.
  useEffect(() => {
    if (!caseInvoice || !labCase.caseNumber) {
      setInvoicePrintQrDataUrl(null);
      return;
    }
    const qrUrl = `${window.location.origin}/cases/${encodeURIComponent(labCase.caseNumber)}`;
    let cancelled = false;
    QRCodeLib.toDataURL(qrUrl, { margin: 1, width: 120 })
      .then((dataUrl) => { if (!cancelled) setInvoicePrintQrDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setInvoicePrintQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [caseInvoice?.id, labCase.caseNumber]);


  // Teeth that already have a restoration line on this case. The tooth
  // chart highlights these so the user can avoid double-billing.
  // Includes pending creates and excludes pending deletes.
  const billedTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      if (r.restorationType === "missing") continue;
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    for (const c of pendingCreates) {
      if (c.restorationType === "missing") continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates]);

  // Missing-tooth markers — derived from server data + optimistic add/delete
  // state so the chart updates instantly even before the server round-trip
  // completes.  Missing teeth are auto-saved (not part of pending changes).
  const missingTeethIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (r.restorationType !== "missing") continue;
      if (pendingDeletes.has(r.id)) continue;
      for (const id of parseToothField(r.toothNumber)) {
        if (!optimisticMissingDeletes.has(id)) set.add(id);
      }
    }
    for (const id of optimisticMissingAdds) set.add(id);
    for (const row of pendingCreates) {
      if (row.restorationType === "missing") for (const id of parseToothField(row.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates, optimisticMissingAdds, optimisticMissingDeletes]);

  // Per-tooth restoration descriptions surfaced in the tooth-chart
  // tooltip so users immediately see what's already on the case.
  const billedTeethTypes = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      if (r.restorationType === "missing") continue;
      const materialShade = [r.material, r.shade].filter(Boolean).join(" · ");
      const label = [r.restorationType, materialShade].filter(Boolean).join(" / ");
      for (const id of parseToothField(r.toothNumber)) {
        const list = map.get(id) ?? [];
        if (label) list.push(label);
        map.set(id, list);
      }
    }
    for (const c of pendingCreates) {
      if (c.restorationType === "missing") continue;
      const materialShade = [c.material, c.shade].filter(Boolean).join(" · ");
      const label = [c.restorationType, materialShade].filter(Boolean).join(" / ");
      for (const id of parseToothField(c.toothNumber)) {
        const list = map.get(id) ?? [];
        if (label) list.push(`${label} (unsaved)`);
        map.set(id, list);
      }
    }
    return map;
  }, [data?.restorations, pendingDeletes, pendingCreates]);

  const crownTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      const role = pendingUpdates.find((update) => update.restorationId === r.id)?.restorationType ?? r.restorationType;
      if (!/^crown$/i.test(role)) continue;
      const ids = parseToothField(pendingUpdates.find((update) => update.restorationId === r.id)?.newToothNumber ?? r.toothNumber);
      if (ids.size === 1) set.add([...ids][0]);
    }
    for (const c of pendingCreates) {
      if (!/^crown$/i.test(c.restorationType)) continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates, pendingUpdates]);

  const ponticTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      const role = pendingUpdates.find((update) => update.restorationId === r.id)?.restorationType ?? r.restorationType;
      if (!/^pontic$/i.test(role)) continue;
      const ids = parseToothField(pendingUpdates.find((update) => update.restorationId === r.id)?.newToothNumber ?? r.toothNumber);
      if (ids.size === 1) set.add([...ids][0]);
    }
    for (const c of pendingCreates) {
      if (!/pontic/i.test(c.restorationType)) continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates, pendingUpdates]);

  // Display only: explicit Veneer rows, one tooth each.
  const veneerTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.restorations ?? []) {
      if (pendingDeletes.has(r.id)) continue;
      const role = pendingUpdates.find((update) => update.restorationId === r.id)?.restorationType ?? r.restorationType;
      if (!/^veneer$/i.test(role)) continue;
      const ids = parseToothField(pendingUpdates.find((update) => update.restorationId === r.id)?.newToothNumber ?? r.toothNumber);
      if (ids.size === 1) set.add([...ids][0]);
    }
    for (const c of pendingCreates) {
      if (!/^veneer$/i.test(c.restorationType)) continue;
      for (const id of parseToothField(c.toothNumber)) set.add(id);
    }
    return set;
  }, [data?.restorations, pendingDeletes, pendingCreates, pendingUpdates]);


  const editMutation = useMutation({
    mutationFn: (updates: typeof editForm) => {
      const src = data ?? labCase;
      return apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          patientFirstName: updates.patientFirstName,
          patientLastName: updates.patientLastName,
          doctorName: updates.doctorName,
          priority: updates.priority,
          ...(updates.dueDate
            ? { dueDate: updates.dueDate, dueTime: updates.dueTime || null }
            : {}),
          casePanBarcode: updates.casePanBarcode || null,
          rxNotes: updates.rxNotes.trim() ? updates.rxNotes : null,
          gingivialShade: updates.gingivialShade.trim() || null,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setEditMode(false);
      setEditError(null);
    },
    onError: (e: Error) => setEditError(e.message),
  });

  // Quick rush toggle — flips priority immediately via the same case PATCH the
  // edit form uses, available outside Edit mode. Keeps the edit-form select and
  // any staged (pending) edit in sync so the new quick toggle and the in-edit
  // priority control never conflict.
  const rushMutation = useMutation({
    mutationFn: (next: "normal" | "rush") =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ priority: next }),
      }),
    onSuccess: (_res, next) => {
      setEditForm((f) => ({ ...f, priority: next }));
      setPendingCaseEdit((p) => (p ? { ...p, priority: next } : p));
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    },
    onError: (e: Error) => setEditError(e.message),
  });

  // Quick due-date edits use the same case PATCH endpoint as the full editor.
  // Keep the current wall-clock due time when only the calendar day changes.
  const quickDueDateMutation = useMutation({
    mutationFn: (dueDate: string) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          dueDate,
          dueTime: data?.dueTime ?? labCase.dueTime ?? null,
        }),
      }),
    onMutate: (dueDate) => setQuickDueDateOverride(dueDate),
    onSuccess: async (_result, dueDate) => {
      const dueTime = data?.dueTime ?? labCase.dueTime ?? null;
      qc.setQueryData<DetailedCase>(["case", labCase.id], (previous) =>
        previous ? { ...previous, dueDate, dueTime } : previous,
      );
      setQuickDueDateOverride(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["case", labCase.id] }),
      ]);
    },
    onError: (error: Error) => {
      setQuickDueDateOverride(null);
      toast.error(error.message || "Could not update the due date.");
    },
  });

  const barcodeMutation = useMutation({
    mutationFn: ({ value, allowDuplicate }: { value: string; allowDuplicate?: boolean }) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          casePanBarcode: value || null,
          ...(allowDuplicate ? { allowDuplicateBarcode: true } : {}),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setOptimisticBarcode(null);
      setBarcodeError(null);
      setBarcodeConflictValue(null);
    },
    onError: (e: Error) => {
      setOptimisticBarcode(null);
      const msg = e.message || "Failed to save barcode";
      setBarcodeError(msg);
      // Store the pending value so an admin can trigger the override.
      if (msg.includes("already assigned")) {
        const pending = barcodeEditValue.trim();
        setBarcodeConflictValue(pending || null);
      } else {
        setBarcodeConflictValue(null);
      }
    },
  });

  function commitBarcodeEdit(opts?: { allowDuplicate?: boolean }) {
    const trimmed = barcodeEditValue.trim();
    setBarcodeEditMode(false);
    setBarcodeError(null);
    setBarcodeConflictValue(null);
    setInlineBarcodeConflict(null);
    const effectiveCurrent =
      optimisticBarcode !== null
        ? optimisticBarcode
        : (data?.casePanBarcode ?? labCase.casePanBarcode ?? "");
    if (trimmed === effectiveCurrent) return;
    setOptimisticBarcode(trimmed);
    barcodeMutation.mutate({ value: trimmed, ...(opts?.allowDuplicate ? { allowDuplicate: true } : {}) });
  }

  const routeMutation = useMutation({
    mutationFn: ({ status, labLocationId, dueDate, dueTime }: {
      status: CaseStatus;
      labLocationId?: string | null;
      dueDate?: string;
      dueTime?: string;
    }) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          ...(labLocationId ? { labLocationId } : {}),
          ...(dueDate ? { dueDate, ...(dueTime ? { dueTime } : {}) } : {}),
        }),
      }),
    onSuccess: async (_result, { status }) => {
      try {
        const prevBarcode = data?.casePanBarcode ?? labCase.casePanBarcode;
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["cases"] }),
          qc.invalidateQueries({ queryKey: ["case", labCase.id] }),
          qc.invalidateQueries({ queryKey: ["case-remake-chain", labCase.id] }),
        ]);
        onCaseLocated?.(status);
        setRouteStatus("");
        setRouteError(null);
        const msg =
          status === "complete" && !!prevBarcode
            ? "Case located successfully. Barcode released."
            : "Case located successfully.";
        setRouteSuccessMsg(msg);
        if (routeSuccessTimerRef.current !== null) clearTimeout(routeSuccessTimerRef.current);
        routeSuccessTimerRef.current = setTimeout(() => {
          routeSuccessTimerRef.current = null;
          setRouteSuccessMsg(null);
        }, 3000);
      } finally {
        routeInFlightRef.current = false;
      }
    },
    onError: (e: Error) => {
      routeInFlightRef.current = false;
      setRouteStatus("");
      setRouteError(e.message);
    },
  });

  const returnStepMutation = useMutation({
    mutationFn: (step: string) =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ step }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setReturnStep("");
      goToNextReturnStage("step");
    },
    onError: (e: Error) => setRouteError(e.message || "Could not update step."),
  });

  // Links this case to the original it remakes, using the same questionnaire +
  // picker + endpoint as the Invoice Editor's "Mark as remake" action.
  const returnRemakeMutation = useMutation({
    mutationFn: () => {
      if (!returnRemakeSelected) {
        return Promise.reject(new Error("Select the original case being remade."));
      }
      return apiFetch<{ caseId: string; caseNumber: string }>(
        `/cases/${labCase.id}/mark-as-remake`,
        {
          method: "PATCH",
          body: JSON.stringify(buildRemakeLinkPayload(returnRemakeSelected, returnRemakeQ)),
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["case-remake-chain", labCase.id] });
      setReturnRemakeSelected(null);
      setReturnRemakeQ(blankQuestionnaire());
      setReturnRemakeError(null);
      goToNextReturnStage("remake");
    },
    onError: (e: Error) =>
      setReturnRemakeError(e.message || "Could not link this case as a remake."),
  });

  function resetReturnWizard() {
    setReturnPromptStep(null);
    setReturnPromptStatus(null);
    setReturnPromptLabLocationId(null);
    setReturnDueDateDeclined(false);
    setReturnStep("");
    setReturnRemakeSelected(null);
    setReturnRemakeQ(blankQuestionnaire());
    setReturnRemakeError(null);
    setReturnRxDragOver(false);
  }

  /** Advance past `from` to the next question, or close the wizard if none is left. */
  function goToNextReturnStage(from: ReturnWizardStage) {
    const next = nextReturnWizardStage(from, {
      canEditStep: canEditReturnStep,
      canPostNotes: canPostReturnNote,
    });
    if (!next) {
      resetReturnWizard();
      return;
    }
    if (next === "stepAsk") setReturnStep((data ?? labCase).step ?? "");
    setReturnPromptStep(next);
  }

  function finishReturnAfterDueDateDecision(dueDateDeclined: boolean) {
    setReturnDueDateDeclined(dueDateDeclined);
    goToNextReturnStage("ask");
  }

  /** Upload the prescription picked/dropped in the wizard through the drawer's
   *  existing attachment pipeline, then move on when it lands cleanly. */
  async function uploadReturnPrescription(files: File[]) {
    if (files.length === 0) return;
    const errors = await uploadFiles(
      files.map((file) => ({ file, category: "prescription" as const })),
    );
    if (errors.length === 0) goToNextReturnStage("rxUpload");
  }

  /** Print the lab slip, honouring this lab's customized advanced layout when
   *  it has one. Shared by the Case Details Print button and the wizard. */
  async function printLabSlip() {
    let currentCase: DetailedCase;
    try {
      const result = await refetchCaseDetail({ throwOnError: true });
      if (!result.data) throw new Error("Could not load current case details.");
      currentCase = result.data;
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Could not refresh case before printing.",
      );
      return;
    }

    const currentRestorations = currentCase.restorations ?? [];
    const advTemplate = advancedTemplateQuery.data;
    if (advTemplate?.isCustom) {
      await printCaseCardAdvanced(
        currentCase,
        {
          restorations: currentRestorations,
          bridgeConnectors: currentCase.bridgeConnectors,
          attachments: currentCase.attachments ?? [],
          invoice: invoiceDetailQuery.data ?? caseInvoice,
        },
        // coerceCasePrintTemplate calls ensureBuiltinElements, which backfills
        // any built-in kind (e.g. gingivialShade) that was added after this
        // lab's template was last saved.
        coerceCasePrintTemplate(advTemplate.template),
      );
    } else {
      printCaseOverview(
        currentCase,
        {
          restorations: currentRestorations,
          attachments: currentCase.attachments ?? [],
          notes: currentCase.notes ?? [],
          isAdmin,
        },
        printLayout,
      );
    }
  }

  async function printLabel() {
    let currentCase: DetailedCase;
    try {
      const result = await refetchCaseDetail({ throwOnError: true });
      if (!result.data) throw new Error("Could not load current case details.");
      currentCase = result.data;
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Could not refresh case before printing.",
      );
      return;
    }

    const summary = deriveRxSummary(currentCase.restorations ?? []);
    printCaseLabel(currentCase, {
      material: summary.materials.join(", ") || undefined,
      teeth: summary.teeth.join(", ") || undefined,
    });
  }

  function routeReturnedCase(
    payload: {
      status: CaseStatus;
      labLocationId?: string | null;
      dueDate?: string;
      dueTime?: string;
    },
    dueDateDeclined: boolean,
  ) {
    routeMutation.mutate(payload, {
      onSuccess: () => finishReturnAfterDueDateDecision(dueDateDeclined),
    });
  }

  function handleRouteStationChange(stationId: string) {
    if (routeInFlightRef.current || routeMutation.isPending) return;
    setRouteStatus(stationId);
    setRouteError(null);
    setRouteSuccessMsg(null);
    if (!stationId) return;

    const station = ROUTE_STATUSES.find((candidate) => candidate.id === stationId);
    if (!station) {
      setRouteStatus("");
      setRouteError("Please select a valid station.");
      return;
    }

    const status = station.value;
    const labLocationId =
      apiLocations && apiLocations.length > 0 ? station.id : null;
    const caseIsComplete = RETURN_COMPLETE_STATUSES.has(currentStatus.toLowerCase());
    const targetIsIntake = RETURN_INTAKE_STATUSES.has(status.toLowerCase());
    if (caseIsComplete && targetIsIntake) {
      setReturnPromptStatus(status);
      setReturnPromptLabLocationId(labLocationId);
      setReturnDueDate("");
      setReturnDueTime("");
      setReturnPromptStep("ask");
      return;
    }

    routeInFlightRef.current = true;
    routeMutation.mutate({ status: status as CaseStatus, labLocationId });
  }

  const acceptSuggestionMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          doctorName: data?.suggestedDoctorName,
          ...(data?.suggestedProviderOrgId
            ? {
                providerOrganizationId: data.suggestedProviderOrgId,
                providerLinkSource: "ai_suggestion",
              }
            : {}),
          clearSuggestion: true,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    },
  });

  const dismissSuggestionMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ clearSuggestion: true }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    },
  });

  const COMM_PREF_KEY = "labtrax_note_comm_pref_v1";

  // ── PFM "don't forget to charge for alloy" reminder ──────────────────
  // The reminder shows on the lab slip whenever any restoration on the case
  // is PFM. It can be dismissed for just this case, or permanently via
  // "don't show again" (persisted in localStorage).
  const PFM_REMINDER_DONTSHOW_KEY = "labtrax_pfm_alloy_reminder_dontshow_v1";
  const PFM_REMINDER_CASES_KEY = "labtrax_pfm_alloy_reminder_dismissed_cases_v1";
  const [pfmReminderDismissed, setPfmReminderDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(PFM_REMINDER_DONTSHOW_KEY) === "1") {
        setPfmReminderDismissed(true);
        return;
      }
      const raw = localStorage.getItem(PFM_REMINDER_CASES_KEY);
      const ids: string[] = raw ? JSON.parse(raw) : [];
      setPfmReminderDismissed(Array.isArray(ids) && ids.includes(labCase.id));
    } catch {
      setPfmReminderDismissed(false);
    }
  }, [labCase.id]);
  function dismissPfmReminderThisCase() {
    setPfmReminderDismissed(true);
    try {
      const raw = localStorage.getItem(PFM_REMINDER_CASES_KEY);
      const ids: string[] = raw ? JSON.parse(raw) : [];
      const next = Array.isArray(ids) ? ids : [];
      if (!next.includes(labCase.id)) next.push(labCase.id);
      localStorage.setItem(PFM_REMINDER_CASES_KEY, JSON.stringify(next));
    } catch {
      /* ignore persistence failures */
    }
  }
  function dismissPfmReminderForever() {
    setPfmReminderDismissed(true);
    try {
      localStorage.setItem(PFM_REMINDER_DONTSHOW_KEY, "1");
    } catch {
      /* ignore persistence failures */
    }
  }

  // One-click "add alloy charge" from the PFM reminder (Task #2067). Adds a
  // priced Alloy line to the case (idempotent server-side) and refreshes the
  // case so the reminder gives way to the new line.
  const addAlloyMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${labCase.id}/alloy-charge`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
  });

  // Resolved alloy price preview (Task #2075) so the reminder can show what
  // the charge will be before it's added. Only fetched when the reminder is
  // actually showing (PFM present, no alloy line yet, not dismissed).
  const showPfmReminder =
    (data?.restorations ?? []).some(
      (r) =>
        (r as { priceKey?: string | null }).priceKey === "pfm_crown" ||
        /pfm/i.test(r.material ?? ""),
    ) &&
    !(data?.restorations ?? []).some(
      (r) =>
        (r as { priceKey?: string | null }).priceKey === "alloy" ||
        (r.restorationType ?? "").trim().toLowerCase() === "alloy",
    ) &&
    !pfmReminderDismissed;
  const alloyPreviewQuery = useQuery({
    queryKey: ["case", labCase.id, "alloy-preview"],
    enabled: showPfmReminder,
    queryFn: () =>
      apiFetch<{ amount: number; priced: boolean; source: string | null }>(
        `/cases/${labCase.id}/alloy-charge/preview`,
      ),
  });

  // Resolve live per-item pricing for this case so discount-priced lines can
  // name the tier their base price came from when it's a fallback tier (the
  // doctor's effective tier or lab default) rather than the practice default.
  // Mirrors the Practices page DoctorPricingRow hint (Task #2510).
  const resolvedPricingQuery = useQuery({
    queryKey: ["case", labCase.id, "resolve-items"],
    queryFn: () =>
      apiFetch<{
        items: Array<{
          key: string;
          discountBaseTierName?: string | null;
        }>;
      }>(`/pricing/resolve-items?caseId=${encodeURIComponent(labCase.id)}`),
  });
  const discountBaseTierByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of resolvedPricingQuery.data?.items ?? []) {
      if (it.discountBaseTierName) map.set(it.key, it.discountBaseTierName);
    }
    return map;
  }, [resolvedPricingQuery.data]);

  // Inline "set alloy price" from the PFM reminder (Task #2077). When the
  // alloy line was added at $0 (no tier/override has an alloy price), an admin
  // can set it right here; the server writes it to the tier/override the case
  // resolves to and re-prices the line + invoice.
  const [alloyPriceInput, setAlloyPriceInput] = useState("");
  const setAlloyPriceMutation = useMutation({
    mutationFn: (price: number) =>
      apiFetch<{
        ok: boolean;
        target: { kind: "tier" | "override"; id: string; name: string };
        amount: number;
      }>(`/cases/${labCase.id}/alloy-price`, {
        method: "POST",
        body: JSON.stringify({ price }),
      }),
    onSuccess: () => {
      setAlloyPriceInput("");
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: ({ text, shared }: { text: string; shared: boolean }) =>
      apiFetch<{ id: string; visibility: string; noteText: string }>(`/cases/${labCase.id}/notes`, {
        method: "POST",
        body: JSON.stringify({
          noteText: text,
          visibility: shared ? "shared_with_provider" : "internal_lab_only",
        }),
      }),
    onSuccess: (result, variables) => {
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      setNoteText("");
      setShareWithProvider(false);
      setNoteError(null);
      // Auto-notification (email + in-app) is now fired server-side on creation
      // for shared notes, so we no longer auto-open the notify modal here.
      // The existing /notify endpoint remains available for SMS re-notification.
    },
    onError: (e: Error) => setNoteError(e.message),
  });

  async function sendNoteNotification(noteId: string, method: "email" | "sms" | "labtrax_only") {
    setNotifyModal((m) => ({ ...m, sending: true, error: null }));
    try {
      await apiFetch(`/cases/${labCase.id}/notes/${noteId}/notify`, {
        method: "POST",
        body: JSON.stringify({ method }),
      });
      const savedPref = localStorage.getItem(COMM_PREF_KEY) as "email" | "sms" | "labtrax_only" | null;
      if (!savedPref) {
        setNotifyModal((m) => ({ ...m, sending: false, method, step: "confirm_save" }));
      } else {
        localStorage.setItem(COMM_PREF_KEY, method);
        setNotifyModal((m) => ({ ...m, sending: false, method, step: "success" }));
      }
    } catch (e: any) {
      setNotifyModal((m) => ({ ...m, sending: false, error: e?.message ?? "Send failed." }));
    }
  }

  const addRestorationMutation = useMutation({
    mutationFn: () => {
      const typeValue =
        restForm.restorationType === "Other"
          ? restForm.customType.trim()
          : restForm.restorationType;
      return apiFetch(`/cases/${labCase.id}/restorations`, {
        method: "POST",
        body: JSON.stringify({
          toothNumber: restForm.toothNumber || "",
          restorationType: typeValue,
          ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, restForm[key] || null])),
          ...(restForm.material ? { material: restForm.material } : {}),
          ...(restForm.restorationSubtype
            ? { restorationSubtype: restForm.restorationSubtype }
            : {}),
          ...(restForm.shade ? { shade: restForm.shade } : {}),
          quantity: restForm.quantity,
          ...(restForm.unitPrice ? { unitPrice: Number(restForm.unitPrice) } : {}),
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      // Server now auto-syncs the invoice from restorations, so refresh
      // the Invoice tab queries too — otherwise the user has to close
      // and re-open the drawer to see the new line item / total.
      qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] });
      qc.invalidateQueries({ queryKey: ["invoice-detail"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setRestForm({
        implantRetention: null,
        implantManufacturer: null,
        implantPlatformNotes: null,
        toothNumber: "",
        restorationType: "",
        customType: "",
        material: "",
        restorationSubtype: null,
        shade: "",
        quantity: 1,
        unitPrice: "",
      });
      setShowAddRest(false);
      setRestError(null);
    },
    onError: (e: Error) => setRestError(e.message),
  });

  async function invalidateAfterRestorationChange() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["case", labCase.id] }),
      qc.invalidateQueries({ queryKey: ["cases"] }),
      qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] }),
      qc.invalidateQueries({ queryKey: ["invoice-detail"] }),
      qc.invalidateQueries({ queryKey: ["invoices"] }),
      qc.invalidateQueries({ queryKey: ["reports"] }),
      qc.invalidateQueries({ queryKey: ["sales"] }),
    ]);
  }

  // Auto-save mutation for marking/unmarking a tooth as missing.
  // Missing-tooth state is persisted immediately (not queued in pending changes)
  // so the chart reflects reality for every user who opens the case next.
  const saveMissingMutation = useMutation({
    mutationFn: async (payload:
      | { kind: "add"; toothId: string }
      | { kind: "remove"; toothId: string; restorationId: string }
    ) => {
      if (payload.kind === "add") {
        await apiFetch(`/cases/${labCase.id}/restorations`, {
          method: "POST",
          body: JSON.stringify({
            toothNumber: payload.toothId,
            restorationType: "missing",
            quantity: 1,
            unitPrice: 0,
          }),
        });
      } else {
        await apiFetch(
          `/cases/${labCase.id}/restorations/${payload.restorationId}`,
          { method: "DELETE" },
        );
      }
      return payload;
    },
    onSuccess: async (payload) => {
      // Await the refetch so data is current before we clear optimistic state,
      // preventing a momentary flicker where the tooth disappears and reappears.
      await invalidateAfterRestorationChange();
      if (payload.kind === "add") {
        setOptimisticMissingAdds((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      } else {
        setOptimisticMissingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      }
    },
    onError: (e: Error, payload) => {
      // Roll back optimistic state on error.
      if (payload.kind === "add") {
        setOptimisticMissingAdds((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      } else {
        setOptimisticMissingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(payload.toothId);
          return next;
        });
      }
      setToothDialogError(e.message);
    },
  });

  const connectorUnits = useMemo(() => [
    ...(data?.restorations ?? [])
      .filter((restoration) => !pendingDeletes.has(restoration.id))
      .filter((restoration) => restoration.restorationType !== "missing")
      .map((restoration) => ({
        toothNumber: pendingUpdates.find((update) => update.restorationId === restoration.id)?.newToothNumber ?? restoration.toothNumber,
        restorationType: pendingUpdates.find((update) => update.restorationId === restoration.id)?.restorationType ?? restoration.restorationType,
        material: pendingUpdates.find((update) => update.restorationId === restoration.id)?.material ?? restoration.material,
        restorationSubtype: pendingUpdates.find((update) => update.restorationId === restoration.id)?.restorationSubtype ?? restoration.restorationSubtype,
        shade: pendingUpdates.find((update) => update.restorationId === restoration.id)?.shade ?? restoration.shade,
        arch: pendingUpdates.find((update) => update.restorationId === restoration.id)?.arch !== undefined
          ? pendingUpdates.find((update) => update.restorationId === restoration.id)!.arch : restoration.arch,
        quantity: pendingUpdates.some((update) => update.restorationId === restoration.id && update.restorationType) ? 1 : restoration.quantity,
      })),
    ...pendingCreates.map((restoration) => ({
      toothNumber: restoration.toothNumber,
      restorationType: restoration.restorationType,
      material: restoration.material,
      restorationSubtype: restoration.restorationSubtype,
      shade: restoration.shade,
      arch: restoration.arch,
      quantity: restoration.quantity,
    })),
  ], [data?.restorations, pendingDeletes, pendingCreates, pendingUpdates]);
  const suggestedConnectorPairs = useMemo(
    () => suggestPonticConnectorPairs(connectorUnits),
    [connectorUnits],
  );
  const persistedConnectorState = useMemo(
    () => parseConnectorState(connectorDraft ?? data?.bridgeConnectors ?? (labCase as any).bridgeConnectors ?? null),
    [connectorDraft, data?.bridgeConnectors, labCase],
  );
  const stagedConnectorState = useMemo(() => {
    const state = parseConnectorState(serializeConnectorState(persistedConnectorState));
    const addedTeeth = new Set(pendingCreates.flatMap((row) => [...parseToothField(row.toothNumber)]));
    const removedTeeth = new Set((data?.restorations ?? [])
      .filter((row) => pendingDeletes.has(row.id))
      .flatMap((row) => [...parseToothField(row.toothNumber)]));
    for (const pair of state.active) {
      if (pair.split("-").some((tooth) => removedTeeth.has(tooth))) {
        state.active.delete(pair);
        state.explicitOn.delete(pair);
        state.suggested.delete(pair);
      }
    }
    for (const pair of suggestedConnectorPairs) {
      if (!pair.split("-").some((tooth) => addedTeeth.has(tooth)) ||
          state.explicitOff.has(pair) || state.explicitOn.has(pair)) continue;
      state.suggested.add(pair);
      state.active.add(pair);
    }
    return state;
  }, [persistedConnectorState, suggestedConnectorPairs, pendingCreates, pendingDeletes, data?.restorations]);
  const stagedConnectorString = serializeConnectorState(stagedConnectorState);
  const effectiveConnectedPairs = stagedConnectorState.active;
  const hasConnectorChanges = (connectorDraft !== null && stagedConnectorString !== (data?.bridgeConnectors ?? "")) || stagedConnectorString !== serializeConnectorState(
    parseConnectorState(data?.bridgeConnectors ?? (labCase as any).bridgeConnectors ?? null),
  );
  const connectorValidation = validateToothConnectors(connectorDraft === null && !pendingCreates.length && !pendingDeletes.size
    ? data?.bridgeConnectors : stagedConnectorString, connectorUnits);
  const assignmentSummary = toothAssignmentSummary(connectorUnits, stagedConnectorString);

  function handleConnectedPairsChange(pairs: Set<string>) {
    if (isSaving) return;
    const state = {
      active: new Set(pairs),
      explicitOn: new Set(stagedConnectorState.explicitOn),
      explicitOff: new Set(stagedConnectorState.explicitOff),
      suggested: new Set(stagedConnectorState.suggested),
    };
    const touched = new Set([...effectiveConnectedPairs, ...pairs]);
    for (const pair of touched) {
      if (effectiveConnectedPairs.has(pair) === pairs.has(pair)) continue;
      if (pairs.has(pair)) {
        state.explicitOn.add(pair);
        state.explicitOff.delete(pair);
        state.suggested.delete(pair);
      } else {
        state.explicitOn.delete(pair);
        state.suggested.delete(pair);
        state.explicitOff.add(pair);
      }
    }
    const serialized = serializeConnectorState(state);
    const validation = validateToothConnectors(serialized, connectorUnits);
    const previousErrors = new Set(connectorValidation.errors);
    const newErrors = validation.errors.filter((error) => !previousErrors.has(error));
    if (newErrors.length) {
      setConnectorSaveError(newErrors.join(" "));
      return;
    }
    setConnectorSaveError(null);
    captureToothUndo();
    setConnectorDraft(serialized);
  }

  // --- Pending changes computed value and handlers ---

  const hasPendingChanges =
    hasConnectorChanges ||
    pendingCreates.length > 0 ||
    pendingDeletes.size > 0 ||
    pendingUpdates.length > 0 ||
    pendingCaseEdit !== null ||
    pendingRxSummaryEdit !== null;

  function handleDiscardChanges() {
    setChartDraftChanged(false);
    setToothUndo(null);
    setConnectorDraft(null);
    setConnectorSaveError(null);
    setPendingCreates([]);
    setPendingDeletes(new Set());
    setPendingUpdates([]);
    setPendingCaseEdit(null);
    setPendingRxSummaryEdit(null);
    setSaveError(null);
    qc.invalidateQueries({ queryKey: ["case", labCase.id] });
  }

  function handleCloseWithGuard() {
    if (isSaving) return;
    if (!guardNavigation(onClose)) onClose();
  }

  // While the case has unsaved edits, intercept in-app route navigations (the
  // sidebar links, programmatic redirects, etc.) so the user can confirm before
  // losing work, and warn on a native window close/reload via beforeunload.
  useEffect(() => {
    if (!hasPendingChanges) return;
    const unregister = registerNavBlocker((proceed) => {
      setPendingDiscard(() => proceed);
    });
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [hasPendingChanges]);

  async function handleSaveChanges(
    editorDraft?: {
      caseEdit: PendingCaseEdit | null;
      rxEdit: typeof pendingRxSummaryEdit;
      implantEdits?: Record<string, ImplantDetails>;
    },
  ) {
    if (isSaving) return false;
    const saveChartAtomically = chartDraftChanged &&
      Boolean(pendingCreates.length || pendingUpdates.length || pendingDeletes.size || hasConnectorChanges);
    const assignmentChanged = pendingCreates.length || pendingUpdates.length || pendingDeletes.size || hasConnectorChanges;
    const previousErrors = new Set(validateToothConnectors(data?.bridgeConnectors, data?.restorations ?? []).errors);
    const newErrors = connectorValidation.errors.filter((error) => !previousErrors.has(error));
    if (assignmentChanged && newErrors.length) {
      setSaveError(newErrors.join(" "));
      return false;
    }
    if ((pendingCreates.length || pendingUpdates.length) &&
        assignmentSummary.unresolvedPontics.length) {
      setSaveError(`Review unconnected pontics: ${assignmentSummary.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")}.`);
      return false;
    }
    setToothUndo(null);
    const snapshotConnectorString = stagedConnectorString;
    let snapshotConnectorChanges = hasConnectorChanges;
    if (hasConnectorChanges) setConnectorDraft(snapshotConnectorString);
    setIsSaving(true);
    setSaveError(null);

    // Snapshot state at save time so the loop iterates a stable list even
    // as we remove successful items from pending state one-by-one.  This
    // makes retries safe: only items that haven't been saved yet remain in
    // pending state after a partial failure.
    const snapshotCaseEdit = editorDraft ? editorDraft.caseEdit : pendingCaseEdit;
    const snapshotRxSummaryEdit = editorDraft ? editorDraft.rxEdit : pendingRxSummaryEdit;
    const snapshotDeletes = Array.from(pendingDeletes);
    const snapshotUpdates = [...pendingUpdates];
    const snapshotCreates = [...pendingCreates];
    let hierarchyTeeth: Set<string> | null = null;

    // Awaitable: resolves once the affected queries have refetched. We block on
    // this before clearing the staged case edit so the displayed value never
    // flashes back to the stale cached/prop value between the save and the
    // refetch landing.
    const invalidateAll = () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["case", labCase.id] }, { throwOnError: true }),
        qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] }),
        qc.invalidateQueries({ queryKey: ["invoice-detail"] }),
        qc.invalidateQueries({ queryKey: ["invoices"] }),
        qc.invalidateQueries({ queryKey: ["reports"] }),
        qc.invalidateQueries({ queryKey: ["sales"] }),
      ]);

    try {
      // Non-chart editors retain their established row-save/retry behavior.
      // A chart save includes these edits in the transaction below instead.
      if (!saveChartAtomically) {
      // 1. Case detail patch (single atomic call)
      for (const row of data?.restorations ?? []) {
        const draft = editorDraft?.implantEdits?.[row.id];
        const confirmed = savedImplantDrafts.current[row.id] ?? row;
        if (!draft || IMPLANT_FIELDS.every((key) => (draft[key] || null) === (confirmed[key] || null))) continue;
        try {
          await apiFetch(`/cases/${labCase.id}/restorations/${row.id}`, {
            method: "PATCH",
            body: JSON.stringify({ ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, draft[key] || null])), syncLinkedArch: false }),
          });
          savedImplantDrafts.current[row.id] = { ...draft };
        } catch (error) {
          setEditImplants((current) => ({ ...current, [row.id]: confirmed }));
          throw error;
        }
      }
      if (snapshotCaseEdit) {
        const src = data ?? labCase;
        const patchBody: Record<string, unknown> = {
          patientFirstName: snapshotCaseEdit.patientFirstName,
          patientLastName: snapshotCaseEdit.patientLastName,
          doctorName: snapshotCaseEdit.doctorName,
          priority: snapshotCaseEdit.priority,
          ...(snapshotCaseEdit.receivedAt
            ? { receivedAt: snapshotCaseEdit.receivedAt }
            : {}),
          ...(snapshotCaseEdit.dueDate
            ? { dueDate: snapshotCaseEdit.dueDate, dueTime: snapshotCaseEdit.dueTime || null }
            : {}),
          casePanBarcode: snapshotCaseEdit.casePanBarcode || null,
          rxNotes: snapshotCaseEdit.rxNotes.trim() ? snapshotCaseEdit.rxNotes : null,
          gingivialShade: snapshotCaseEdit.gingivialShade.trim() || null,
        };
        if (snapshotCaseEdit.providerOrganizationId) {
          patchBody.providerOrganizationId = snapshotCaseEdit.providerOrganizationId;
        }
        await apiFetch(`/cases/${labCase.id}`, {
          method: "PATCH",
          body: JSON.stringify(patchBody),
        });
        // NB: do NOT clear pendingCaseEdit here. It stays authoritative on
        // screen until the refetched case data lands (see the awaited
        // invalidateAll() below), otherwise the field briefly reverts to the
        // stale cached value (data?.dueDate) or the original prop
        // (labCase.dueDate).
      }

      // 2. The Lab Slip's clinical details are saved with one atomic
      //    whole-case request. The server reconciles teeth and preserves all
      //    fields on surviving rows.
      if (snapshotRxSummaryEdit) {
        const teethTokens = snapshotRxSummaryEdit.teeth
          .split(/[\s,;]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        // Preserve the source rows of explicit chart replacements until their
        // row-level PATCH below moves them. Otherwise reconciliation could
        // delete their IDs before those already-staged edits are committed.
        const replacementIds = new Set(snapshotUpdates.map((update) => update.restorationId));
        for (const row of data?.restorations ?? []) {
          if (replacementIds.has(row.id)) {
            for (const tooth of parseToothField(row.toothNumber)) {
              if (!teethTokens.includes(tooth)) teethTokens.push(tooth);
            }
          }
        }
        const result = await apiFetch<{
          updatedCount: number;
          createdCount: number;
          deletedCount: number;
          repricedCount: number;
          manualPriceCount: number;
          unpricedCount: number;
          invoiceAction: "updated" | "created" | "skipped" | "needs_review";
        }>(`/cases/${labCase.id}/restorations/hierarchy`, {
          method: "PATCH",
          body: JSON.stringify({
            restorationType: snapshotRxSummaryEdit.type.trim() || "Other",
            restorationSubtype: snapshotRxSummaryEdit.restorationSubtype || null,
            material: snapshotRxSummaryEdit.material.trim() || null,
            toothNumbers: teethTokens,
            ...(snapshotRxSummaryEdit.changed.shade
              ? { shade: snapshotRxSummaryEdit.shade.trim() || null }
              : {}),
            ...(snapshotRxSummaryEdit.changed.arch && snapshotRxSummaryEdit.arch
              ? {
                  arch:
                    snapshotRxSummaryEdit.arch === "both"
                      ? "upper_lower"
                      : snapshotRxSummaryEdit.arch,
                }
              : {}),
            ...(snapshotRxSummaryEdit.changed.step
              ? { step: snapshotRxSummaryEdit.step || null }
              : {}),
            ...(snapshotRxSummaryEdit.changed.stepShade
              ? {
                  stepShade:
                    snapshotRxSummaryEdit.step === "wax_setup"
                      ? snapshotRxSummaryEdit.stepShade.trim() || null
                      : null,
                }
              : {}),
          }),
        });
        const invoiceMessage = {
          updated: "Invoice updated.",
          created: "Invoice created.",
          skipped: "Invoice left unchanged.",
          needs_review: "The reviewed invoice was flagged for review and left unchanged.",
        }[result.invoiceAction];
        const quoteMessage = [
          result.repricedCount > 0
            ? `${result.repricedCount} row${result.repricedCount === 1 ? "" : "s"} repriced`
            : null,
          result.manualPriceCount > 0
            ? `${result.manualPriceCount} manual price${result.manualPriceCount === 1 ? "" : "s"} kept`
            : null,
          result.unpricedCount > 0
            ? `${result.unpricedCount} row${result.unpricedCount === 1 ? "" : "s"} left unpriced`
            : null,
        ].filter(Boolean).join("; ");
        const saveMessage = [
          "Clinical details saved.",
          quoteMessage || null,
          invoiceMessage,
        ].filter(Boolean).join(" ");
        savedRxDraft.current = JSON.stringify({ ...snapshotRxSummaryEdit, changed: undefined });
        hierarchyTeeth = new Set(teethTokens.flatMap((token) => [...parseToothField(token)]));
        setPendingRxSummaryEdit(null);
        if (result.invoiceAction === "needs_review") {
          toast.warning(saveMessage);
        } else {
          toast.success(saveMessage);
        }
      }

      }
      // The interactive chart and its generated invoice commit together. A
      // refused/failed save leaves both records unchanged and keeps this draft.
      if (saveChartAtomically) {
        const clinicalTeeth = snapshotRxSummaryEdit?.teeth.split(/[\s,;]+/).map((tooth) => tooth.trim()).filter(Boolean);
        await apiFetch(`/cases/${labCase.id}/tooth-chart`, {
          method: "PATCH",
          body: JSON.stringify({
            creates: snapshotCreates.map((row) => ({
              localId: row.localId, toothNumber: row.toothNumber,
              restorationType: row.restorationType, material: row.material || null,
              restorationSubtype: row.restorationSubtype || null, shade: row.shade || null,
              quantity: Number(row.quantity) || 1,
              arch: row.arch ?? null,
              ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, row[key] || null])),
              ...(row.unitPrice ? { unitPrice: Number(row.unitPrice) } : {}),
            })),
            updates: snapshotUpdates.map((row) => ({
              restorationId: row.restorationId, ...buildRestorationUpdateBody(row),
            })),
            deletes: snapshotDeletes,
            bridgeConnectors: snapshotConnectorString || null,
            ...(snapshotCaseEdit ? { caseDetails: {
              patientFirstName: snapshotCaseEdit.patientFirstName,
              patientLastName: snapshotCaseEdit.patientLastName,
              doctorName: snapshotCaseEdit.doctorName,
              priority: snapshotCaseEdit.priority,
              ...(snapshotCaseEdit.receivedAt ? { receivedAt: snapshotCaseEdit.receivedAt } : {}),
              ...(snapshotCaseEdit.dueDate ? { dueDate: snapshotCaseEdit.dueDate, dueTime: snapshotCaseEdit.dueTime || null } : {}),
              ...(snapshotCaseEdit.providerOrganizationId ? { providerOrganizationId: snapshotCaseEdit.providerOrganizationId } : {}),
              casePanBarcode: snapshotCaseEdit.casePanBarcode || null,
              rxNotes: snapshotCaseEdit.rxNotes.trim() ? snapshotCaseEdit.rxNotes : null,
              gingivialShade: snapshotCaseEdit.gingivialShade.trim() || null,
            } } : {}),
            ...(snapshotRxSummaryEdit ? { hierarchy: {
              restorationType: snapshotRxSummaryEdit.type.trim() || "Other",
              restorationSubtype: snapshotRxSummaryEdit.restorationSubtype || null,
              material: snapshotRxSummaryEdit.material || null,
              toothNumbers: clinicalTeeth,
              ...(snapshotRxSummaryEdit.changed.shade ? { shade: snapshotRxSummaryEdit.shade.trim() || null } : {}),
              ...(snapshotRxSummaryEdit.changed.arch && snapshotRxSummaryEdit.arch
                ? { arch: snapshotRxSummaryEdit.arch === "both" ? "upper_lower" : snapshotRxSummaryEdit.arch } : {}),
              ...(snapshotRxSummaryEdit.changed.step ? { step: snapshotRxSummaryEdit.step || null } : {}),
              ...(snapshotRxSummaryEdit.changed.stepShade
                ? { stepShade: snapshotRxSummaryEdit.step === "wax_setup" ? snapshotRxSummaryEdit.stepShade.trim() || null : null } : {}),
            } } : {}),
            implants: (data?.restorations ?? []).flatMap((row) => {
              const draft = editorDraft?.implantEdits?.[row.id];
              const confirmed = savedImplantDrafts.current[row.id] ?? row;
              return draft && IMPLANT_FIELDS.some((key) => (draft[key] || null) !== (confirmed[key] || null))
                ? [{ restorationId: row.id, values: Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, draft[key] || null])) }]
                : [];
            }),
          }),
        });
        setPendingCreates([]);
        setPendingUpdates([]);
        setPendingDeletes(new Set());
        setConnectorDraft(null);
        setConnectorSaveError(null);
        setChartDraftChanged(false);
        setPendingCaseEdit(null);
        setPendingRxSummaryEdit(null);
        setPendingCaseEdit(null);
        await invalidateAll().catch(() => {
          toast.warning("The chart and invoice were saved. Their display could not refresh; reopen the case to see the confirmed values.");
        });
        return true;
      }

      // 3. Deletes — remove from pending state immediately after each success
      const touchedTeeth = new Set<string>();
      for (const row of data?.restorations ?? []) {
        if (snapshotDeletes.includes(row.id) || snapshotUpdates.some((update) => update.restorationId === row.id)) {
          for (const tooth of parseToothField(row.toothNumber)) touchedTeeth.add(tooth);
        }
      }
      const committedState = parseConnectorState(data?.bridgeConnectors);
      const safePairs = new Set([...committedState.active].filter((pair) => !pair.split("-").some((tooth) => touchedTeeth.has(tooth))));
      if (safePairs.size !== committedState.active.size) {
        snapshotConnectorChanges = true;
        setConnectorDraft(snapshotConnectorString);
        await apiFetch(`/cases/${labCase.id}`, { method: "PATCH",
          body: JSON.stringify({ bridgeConnectors: updateConnectorChoices(committedState, safePairs) }) });
      }
      for (const id of snapshotDeletes) {
        const row = data?.restorations?.find((restoration) => restoration.id === id);
        const rowTeeth = row ? [...parseToothField(row.toothNumber)] : [];
        const reconciledTeeth = hierarchyTeeth;
        const alreadyReconciled = reconciledTeeth && rowTeeth.length > 0 &&
          rowTeeth.every((tooth) => !reconciledTeeth.has(tooth));
        if (!alreadyReconciled) {
          await apiFetch(`/cases/${labCase.id}/restorations/${id}`, { method: "DELETE" });
        }
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }

      // 3. Updates (replace_tooth) — remove from pending state after each success
      for (const upd of snapshotUpdates) {
        await apiFetch(`/cases/${labCase.id}/restorations/${upd.restorationId}`, {
          method: "PATCH",
          body: JSON.stringify(buildRestorationUpdateBody(upd)),
        });
        setPendingUpdates((prev) =>
          prev.filter((u) => u.restorationId !== upd.restorationId),
        );
      }

      // 4. Creates — remove from pending state after each success so a retry
      //    cannot POST the same restoration twice.
      for (const c of snapshotCreates) {
        await apiFetch(`/cases/${labCase.id}/restorations`, {
          method: "POST",
          body: JSON.stringify({
            toothNumber: c.toothNumber,
            restorationType: c.restorationType,
            ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, c[key] || null])),
            ...(c.material ? { material: c.material } : {}),
            ...(c.restorationSubtype
              ? { restorationSubtype: c.restorationSubtype }
              : {}),
            ...(c.shade ? { shade: c.shade } : {}),
            quantity: c.quantity,
            ...(c.unitPrice ? { unitPrice: Number(c.unitPrice) } : {}),
          }),
        });
        setPendingCreates((prev) => prev.filter((p) => p.localId !== c.localId));
      }

      if (snapshotConnectorChanges) {
        await apiFetch(`/cases/${labCase.id}`, {
          method: "PATCH",
          body: JSON.stringify({ bridgeConnectors: snapshotConnectorString }),
        });
        setConnectorDraft(null);
        setConnectorSaveError(null);
      }

      // Wait for the refetched case + list data to land before clearing the
      // staged edit so the displayed value transitions straight from the
      // pending value to the fresh server value with no revert in between.
      await invalidateAll();
      setPendingCaseEdit(null);
      return true;
    } catch (e: any) {
      setSaveError(e?.message ?? "Failed to save changes. Please try again.");
      // Refetch server state so the list reflects what was already saved
      // before the failure.  Remaining pending items (incl. the staged case
      // edit) are intentionally left in place so they can be retried.
      await invalidateAll().catch(() => {
        // Preserve the write failure's reason and draft even if its best-effort
        // refresh also fails. A subsequent Save press can still retry.
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  function handleToothDialogStage(payload: ToothActionPayload) {
    if (isSaving) return;
    if ((payload.kind === "add_crown" || payload.kind === "replace_tooth") && payload.arch) {
      const indication = payload.kind === "add_crown" ? payload.restorationType : payload.role;
      if (!indication || !isToothIndication(indication) || !indicationCatalogContext(indication).archBased) {
        setToothDialogError("Choose a supported arch restoration."); return;
      }
      const staged = pendingCreates.find((row) => row.arch === payload.arch && row.restorationType === indication);
      const saved = (data?.restorations ?? []).find((row) =>
        !pendingDeletes.has(row.id) && (payload.kind === "replace_tooth"
          ? row.id === payload.restorationId
          : row.arch === payload.arch && row.restorationType === indication));
      captureToothUndo();
      const values = { toothNumber: "", restorationType: indication, arch: payload.arch,
        material: payload.material ?? saved?.material ?? staged?.material ?? "",
        restorationSubtype: payload.restorationSubtype ?? saved?.restorationSubtype ?? staged?.restorationSubtype ?? undefined,
        shade: payload.shade ?? saved?.shade ?? staged?.shade ?? "", quantity: 1 };
      if (saved) {
        setPendingUpdates((rows) => [...rows.filter((row) => row.restorationId !== saved.id),
          { restorationId: saved.id, newToothNumber: "", ...values }]);
      } else {
        const created = { ...values, localId: staged?.localId ?? crypto.randomUUID(), unitPrice: "" };
        setPendingCreates((rows) => staged ? rows.map((row) => row.localId === staged.localId ? created : row) : [...rows, created]);
      }
      setToothDialogId(null); setToothDialogError(null); setToothMultiSelect(false); setToothSelectedTargets([]);
      return;
    }
    const assignmentTargets = toothMultiSelect && toothSelectedTargets.length ? toothSelectedTargets : ("toothId" in payload ? [payload.toothId] : []);
    if (toothMultiSelect && (payload.kind === "add_crown" || payload.kind === "add_pontic") &&
      assignmentTargets.some((tooth) => stagedToothAssignment(tooth) || missingTeethIds.has(tooth))) {
      setToothDialogError("This selection contains assigned or missing teeth. Keep those records intact; use an existing tooth's Copy settings action to review replacements, or restore a missing tooth individually.");
      return;
    }
    if (payload.kind === "copy_assignment" && payload.toothNumbers.some((tooth) => {
      const target = stagedToothAssignment(tooth);
      return target && parseToothField(target.toothNumber).size > 1;
    })) {
      setToothDialogError("A target belongs to a shared multi-tooth restoration row. Review and edit that row directly rather than adding a duplicate charge.");
      return;
    }
    if (payload.kind === "replace_tooth" || payload.kind === "remove_restoration") {
      const draft = pendingCreates.find((row) => row.localId === payload.restorationId);
      const current = draft ?? data?.restorations?.find((row) => row.id === payload.restorationId);
      if (current && parseToothField(current.toothNumber).size > 1) {
        setToothDialogError("This is a shared multi-tooth restoration row. Edit it in the full restoration row editor so other teeth and charges remain intact.");
        return;
      }
      if (draft) {
        captureToothUndo();
        setPendingCreates((rows) => payload.kind === "remove_restoration"
          ? rows.filter((row) => row.localId !== draft.localId)
          : rows.map((row) => row.localId !== draft.localId ? row : {
            ...row, toothNumber: payload.newToothNumber,
            restorationType: payload.role ?? row.restorationType,
            arch: payload.arch ?? (payload.role ? undefined : row.arch),
            material: payload.material ?? row.material,
            restorationSubtype: payload.restorationSubtype ?? row.restorationSubtype,
            shade: payload.shade ?? row.shade,
          }));
        setToothDialogId(null);
        setToothDialogError(null);
        return;
      }
    }
    captureToothUndo();
    if (payload.kind === "add_crown" || payload.kind === "add_pontic") {
      const missingRows = (data?.restorations ?? []).filter((row) =>
        row.restorationType === "missing" && parseToothField(row.toothNumber).has(payload.toothId));
      setPendingDeletes((previous) => new Set([...previous, ...missingRows.map((row) => row.id)]));
      setPendingCreates((previous) => previous.filter((row) =>
        row.restorationType !== "missing" || !parseToothField(row.toothNumber).has(payload.toothId)));
    }
    const draftSource = "restorationId" in payload ? pendingCreates.find((row) => row.localId === payload.restorationId) : undefined;
    if (draftSource && payload.kind !== "copy_assignment") {
      if (payload.kind === "remove_restoration" || (payload.kind === "replace_tooth" && payload.newToothNumber !== draftSource.toothNumber)) {
        setConnectorDraft(updateConnectorChoices(stagedConnectorState, new Set([...stagedConnectorState.active].filter((pair) => !pair.split("-").includes(draftSource.toothNumber)))));
      }
      if (payload.kind === "remove_restoration") {
        setPendingCreates((rows) => rows.filter((row) => row.localId !== draftSource.localId));
      } else if (payload.kind === "change_role") {
        setPendingCreates((rows) => rows.map((row) => row.localId === draftSource.localId ? { ...row, restorationType: payload.role } : row));
      } else if (payload.kind === "replace_tooth") {
        if (payload.newToothNumber !== draftSource.toothNumber && billedTeeth.has(payload.newToothNumber)) {
          setToothDialogError("That tooth already has an assignment."); return;
        }
        setPendingCreates((rows) => rows.map((row) => row.localId === draftSource.localId ? { ...row, toothNumber: payload.newToothNumber,
          ...(payload.role !== undefined ? { restorationType: payload.role } : {}),
          ...(payload.material !== undefined ? { material: payload.material } : {}),
          ...(payload.shade !== undefined ? { shade: payload.shade } : {}),
          ...(payload.restorationSubtype !== undefined ? { restorationSubtype: payload.restorationSubtype } : {}) } : row));
      }
      setToothDialogId(null); setToothDialogError(null); return;
    }
    if (payload.kind === "change_role") {
      const source = data?.restorations?.find((row) => row.id === payload.restorationId);
      if (!source?.material?.trim() || parseToothField(source.toothNumber).size !== 1) {
        setToothDialogError("Review the material and individual teeth of this legacy record before assigning a role.");
        return;
      }
      setPendingUpdates((previous) => {
        const existing = previous.find((update) => update.restorationId === source.id);
        return [
          ...previous.filter((update) => update.restorationId !== source.id),
          { ...existing, restorationId: source.id, newToothNumber: existing?.newToothNumber ?? source.toothNumber, restorationType: payload.role },
        ];
      });
      setToothDialogId(null);
      setToothDialogError(null);
    } else if (payload.kind === "copy_assignment") {
      const stored = data?.restorations?.find((row) => row.id === payload.restorationId);
      const edit = pendingUpdates.find((row) => row.restorationId === payload.restorationId);
      const source = draftSource ?? (stored ? { ...stored,
        restorationType: edit?.restorationType ?? stored.restorationType,
        material: edit?.material ?? stored.material, shade: edit?.shade ?? stored.shade,
        restorationSubtype: edit?.restorationSubtype ?? stored.restorationSubtype } : undefined);
      if (!source || !/^(crown|pontic|veneer)$/i.test(source.restorationType) || !source.material?.trim()) {
        setToothDialogError("Confirm an explicit crown, pontic or veneer and a catalog material before copying.");
        return;
      }
      const existingTargets = payload.toothNumbers.flatMap((tooth) => {
        const row = stagedToothAssignment(tooth);
        return row && "id" in row ? [row] : [];
      });
      setPendingUpdates((previous) => [...previous.filter((row) => !existingTargets.some((target) => target.id === row.restorationId)),
        ...existingTargets.map((target) => ({ restorationId: target.id, newToothNumber: target.toothNumber,
          restorationType: source.restorationType as "Crown" | "Pontic" | "Veneer", material: source.material!, shade: source.shade ?? "",
          restorationSubtype: source.restorationSubtype ?? undefined }))]);
      const newTargets = payload.toothNumbers.filter((tooth) => !existingTargets.some((target) => target.toothNumber === tooth));
      setPendingCreates((previous) => [
        ...previous.filter((row) => !newTargets.includes(row.toothNumber)),
        ...newTargets.map((toothNumber) => {
          const copied = copyToothAssignment(source, toothNumber);
          return {
            localId: crypto.randomUUID(), toothNumber, restorationType: copied.restorationType,
            material: copied.material!, restorationSubtype: copied.restorationSubtype,
            shade: copied.shade ?? "", quantity: 1, unitPrice: "",
          };
        }),
      ]);
      setToothDialogId(null);
      setToothDialogError(null);
      setToothSelectedTargets([]);
      setToothMultiSelect(false);
    } else if (payload.kind === "add_crown") {
      const localId = crypto.randomUUID();
      setToothCopySourceId(localId);
      setToothCopyAnchor(payload.toothId);
      setToothCopyMessage(`Copy settings: #${payload.toothId} ${payload.restorationType} · ${payload.material} · ${payload.shade || "No shade"}. Ctrl/Cmd-click a target to copy.`);
      setPendingCreates((prev) => [
        ...prev,
        ...assignmentTargets.map((toothNumber, index) => ({
          localId: index === 0 ? localId : crypto.randomUUID(),
          toothNumber,
          restorationType: payload.restorationType,
          material: payload.material,
          restorationSubtype: payload.restorationSubtype,
          shade: payload.shade ?? "",
          quantity: 1,
          unitPrice: "",
        })),
      ]);
      setToothDialogId(null);
      setToothDialogError(null);
      setToothSelectedTargets([]);
      setToothMultiSelect(false);
    } else if (payload.kind === "add_pontic") {
      const localId = crypto.randomUUID();
      setToothCopySourceId(localId);
      setToothCopyAnchor(payload.toothId);
      setToothCopyMessage(`Copy settings: #${payload.toothId} Pontic · ${payload.material} · ${payload.shade || "No shade"}. Ctrl/Cmd-click a target to copy.`);
      setPendingCreates((prev) => [
        ...prev,
        ...assignmentTargets.map((toothNumber, index) => ({
          localId: index === 0 ? localId : crypto.randomUUID(),
          toothNumber,
          restorationType: "Pontic" as const,
          material: payload.material,
          restorationSubtype: payload.restorationSubtype ?? null,
          shade: payload.shade ?? "",
          quantity: 1,
          unitPrice: "",
        })),
      ]);
      setToothDialogId(null);
      setToothDialogError(null);
      setToothSelectedTargets([]);
      setToothMultiSelect(false);
    } else if (payload.kind === "mark_missing") {
      const targets = toothMultiSelect && assignmentTargets.length ? assignmentTargets : [payload.toothId];
      const owners = (data?.restorations ?? []).filter((row) => targets.some((tooth) => parseToothField(row.toothNumber).has(tooth)));
      if (owners.some((row) => parseToothField(row.toothNumber).size > 1)) {
        setToothDialogError("This tooth belongs to a shared multi-tooth row. Separate that row in the restoration editor first so other teeth and charges remain intact.");
        return;
      }
      setPendingDeletes((previous) => new Set([...previous, ...owners.map((row) => row.id)]));
      setPendingUpdates((previous) => previous.filter((row) => !owners.some((owner) => owner.id === row.restorationId)));
      setPendingCreates((previous) => [
        ...previous.filter((row) => !targets.some((tooth) => parseToothField(row.toothNumber).has(tooth))),
        ...targets.map((toothNumber) => ({ localId: crypto.randomUUID(), toothNumber, restorationType: "missing",
          material: "", shade: "", quantity: 1, unitPrice: "0" })),
      ]);
      setConnectorDraft(updateConnectorChoices(stagedConnectorState,
        new Set([...stagedConnectorState.active].filter((pair) => !pair.split("-").some((tooth) => targets.includes(tooth))))));
      setToothMultiSelect(false);
      setToothSelectedTargets([]);
      setToothDialogId(null);
      setToothDialogError(null);
    } else if (payload.kind === "remove_restoration") {
      if (payload.restorationId) {
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.add(payload.restorationId!);
          return next;
        });
      } else if (missingTeethIds.has(payload.toothId)) {
        // Find the server-saved missing restoration for this tooth and auto-delete it.
        const serverMissingRow = (data?.restorations ?? []).find(
          (r) =>
            r.restorationType === "missing" &&
            parseToothField(r.toothNumber).has(payload.toothId),
        );
        if (serverMissingRow) {
          setPendingDeletes((previous) => new Set([...previous, serverMissingRow.id]));
          setToothDialogId(null);
          setToothDialogError(null);
          return;
        } else if (optimisticMissingAdds.has(payload.toothId)) {
          // Still in-flight add — cancel the optimistic add.
          setOptimisticMissingAdds((prev) => {
            const next = new Set(prev);
            next.delete(payload.toothId);
            return next;
          });
          setToothDialogId(null);
          setToothDialogError(null);
          return;
        }
      } else {
        setPendingCreates((prev) =>
          prev.filter((c) => {
            const teeth = parseToothField(c.toothNumber);
            return !teeth.has(payload.toothId);
          }),
        );
      }
      setToothDialogId(null);
      setToothDialogError(null);
    } else if (payload.kind === "replace_tooth") {
      setPendingUpdates((prev) => {
        const previous = prev.find((row) => row.restorationId === payload.restorationId);
        return [
        ...prev.filter((row) => row.restorationId !== payload.restorationId),
        {
          ...previous,
          restorationId: payload.restorationId,
          newToothNumber: payload.newToothNumber,
          restorationType: payload.role && isToothIndication(payload.role) ? payload.role : previous?.restorationType,
          material: payload.material ?? previous?.material,
          restorationSubtype: payload.restorationSubtype ?? previous?.restorationSubtype,
          shade: payload.shade ?? previous?.shade,
          ...(payload.arch !== undefined ? { arch: payload.arch } : payload.role && isToothIndication(payload.role) ? { arch: null } : {}),
        },
      ]; });
      setToothDialogId(null);
      setToothDialogError(null);
    }
  }

  function stagedToothAssignment(tooth: string) {
    const draft = pendingCreates.find((row) => parseToothField(row.toothNumber).has(tooth));
    if (draft) return { ...draft, id: draft.localId };
    for (const row of data?.restorations ?? []) {
      if (pendingDeletes.has(row.id)) continue;
      const edit = pendingUpdates.find((entry) => entry.restorationId === row.id);
      const projected = {
        ...row, toothNumber: edit?.newToothNumber ?? row.toothNumber,
        restorationType: edit?.restorationType ?? row.restorationType,
        material: edit?.material ?? row.material, shade: edit?.shade ?? row.shade,
        restorationSubtype: edit?.restorationSubtype ?? row.restorationSubtype,
      };
      if (parseToothField(projected.toothNumber).has(tooth)) return projected;
    }
    return undefined;
  }

  function requestSavedToothCopy(targets: string[]) {
    if (isSaving) return;
    const source = toothCopyAnchor ? stagedToothAssignment(toothCopyAnchor) : undefined;
    if (!source || source.id !== toothCopySourceId || !/^(crown|pontic|veneer)$/i.test(source.restorationType) || !source.material?.trim()) {
      setToothCopyMessage("Click an assigned crown, pontic or veneer first to choose its copy settings.");
      return;
    }
    const unique = [...new Set(targets)].filter((tooth) => tooth !== toothCopyAnchor);
    if (!unique.length) return;
    if (unique.some((tooth) => !!stagedToothAssignment(tooth))) {
      setToothCopyTargets(unique.join(", "));
      setToothDialogId(toothCopyAnchor);
      setToothDialogError(null);
      setToothCopyMessage("Review the target assignments in the copy dialog before replacing them.");
      return;
    }
    handleToothDialogStage({ kind: "copy_assignment", restorationId: source.id, toothNumbers: unique });
    setToothSelectedTargets([]);
    setToothMultiSelect(false);
    setToothCopyMessage(`Copied ${source.restorationType}, ${source.material}, ${source.shade || "no shade"} to ${unique.map((tooth) => `#${tooth}`).join(", ")}. Save changes to commit.`);
  }

  function handleSavedChartTooth(tooth: string, modifiers?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    if (isSaving) return;
    if (toothMultiSelect) {
      if (modifiers?.shiftKey && toothSelectionAnchor) {
        const range = expandToothAssignmentIdentifiers(`${toothSelectionAnchor}-${tooth}`);
        if (!range.length) { setToothCopyMessage("Shift-selection must stay within one arch."); return; }
        setToothSelectedTargets((selected) => [...new Set([...selected, ...range])]);
      } else {
        setToothSelectionAnchor(tooth);
        setToothSelectedTargets((selected) => selected.includes(tooth) ? selected.filter((id) => id !== tooth) : [...selected, tooth]);
      }
      return;
    }
    if (modifiers?.shiftKey && toothCopyAnchor) {
      const range = expandToothAssignmentIdentifiers(`${toothCopyAnchor}-${tooth}`);
      if (!range.length) { setToothCopyMessage("Shift-selection must stay within one arch."); return; }
      setToothSelectedTargets(range);
      setToothSelectionAnchor(toothCopyAnchor);
      setToothMultiSelect(true);
      setToothCopyMessage(`Selected teeth #${range.join(", #")}. Selection has not changed any restoration. Choose Assign or Copy settings to apply an edit.`);
      return;
    }
    if (modifiers?.ctrlKey || modifiers?.metaKey) { requestSavedToothCopy([tooth]); return; }
    const source = stagedToothAssignment(tooth);
    if (source && /^(crown|pontic|veneer)$/i.test(source.restorationType)) {
      setToothCopySourceId(source.id);
      setToothCopyAnchor(tooth);
      setToothCopyMessage(`Copy settings: #${tooth} ${source.restorationType} · ${source.material || "Material needs review"} · ${source.shade || "No shade"}. Ctrl/Cmd-click to copy; Shift-click for a same-arch range.`);
    }
    setToothCopyTargets("");
    setToothDialogId(tooth);
    setToothDialogError(null);
  }

  // Each entry carries its own optional note (already trimmed) so a note is
  // always bound to the exact file the user typed it for.
  /** Uploads each file and attaches it to the case. Returns the per-file error
   *  messages (empty when everything landed) so callers such as the
   *  returned-case wizard can decide whether to advance. */
  async function uploadFiles(
    items: {
      file: File;
      note?: string;
      category?: "outgoing" | "prescription";
    }[],
  ): Promise<string[]> {
    if (items.length === 0) return [];
    setUploadingFile(true);
    setUploadError(null);
    const errors: string[] = [];
    for (const { file, note, category } of items) {
      try {
        // Files >~20 MB are routed through the resumable chunked pipeline so
        // the Replit reverse proxy never silently drops them.
        const { url } = await uploadMediaFile(file);
        const trimmedNote = note?.trim();
        await apiFetch(`/cases/${labCase.id}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            storageKey: url,
            fileName: file.name,
            fileType: file.type || "application/octet-stream",
            ...(trimmedNote ? { note: trimmedNote } : {}),
            ...(category ? { category } : {}),
          }),
        });
      } catch (err: any) {
        errors.push(`${file.name}: ${err?.message || "Upload failed."}`);
      }
    }
    qc.invalidateQueries({ queryKey: ["case", labCase.id] });
    if (errors.length > 0) setUploadError(errors.join(" · "));
    setUploadingFile(false);
    return errors;
  }

  // Open the optional per-file note prompt for the given files. The user can
  // add a note per file or skip; upload begins when they confirm the prompt.
  function promptFileNotes(files: File[]) {
    if (files.length === 0) return;
    setUploadError(null);
    setPendingUploads(files.map((file) => ({ file, note: "" })));
  }

  function confirmPendingUploads() {
    const items = pendingUploads;
    setPendingUploads(null);
    if (items && items.length > 0) void uploadFiles(items);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    promptFileNotes(files);
  }

  function saveAttachmentSectionPreference(
    expanded: typeof attachmentSectionsExpanded,
    save: typeof attachmentSectionSave,
  ) {
    const preference: AttachmentSectionPreference =
      buildAttachmentSectionPreference(expanded, save);
    try {
      localStorage.setItem(attachmentPreferenceKey, JSON.stringify(preference));
    } catch {
      // Browser privacy/storage failures must not prevent section toggling.
    }
  }

  function toggleAttachmentSection(section: AttachmentSectionId) {
    setAttachmentSectionsExpanded((current) => {
      const next = { ...current, [section]: !current[section] };
      if (attachmentSectionSave.all || attachmentSectionSave[section]) {
        saveAttachmentSectionPreference(next, attachmentSectionSave);
      }
      return next;
    });
  }

  function toggleAllAttachmentSections() {
    setAttachmentSectionsExpanded((current) => {
      const shouldExpand = !Object.values(current).every(Boolean);
      const next = {
        media: shouldExpand,
        documents: shouldExpand,
        files: shouldExpand,
      };
      if (
        attachmentSectionSave.all ||
        attachmentSectionSave.media ||
        attachmentSectionSave.documents ||
        attachmentSectionSave.files
      ) {
        saveAttachmentSectionPreference(next, attachmentSectionSave);
      }
      return next;
    });
  }

  function setAttachmentSavePreference(
    control: AttachmentSectionId | "all",
    checked: boolean,
  ) {
    setAttachmentSectionSave((current) => {
      const next = { ...current, [control]: checked };
      if (checked) saveAttachmentSectionPreference(attachmentSectionsExpanded, next);
      else {
        try {
          if (!next.all && !next.media && !next.documents && !next.files) {
            localStorage.removeItem(attachmentPreferenceKey);
          } else {
            saveAttachmentSectionPreference(attachmentSectionsExpanded, next);
          }
        } catch {
          // Keep the in-memory control usable if storage is unavailable.
        }
      }
      return next;
    });
  }

  function handleFileDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDragCounterRef.current += 1;
    if (fileDragCounterRef.current === 1) setFileDragOver(true);
  }

  function handleFileDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDragCounterRef.current -= 1;
    if (fileDragCounterRef.current === 0) setFileDragOver(false);
  }

  function handleFileDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDragCounterRef.current = 0;
    setFileDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) promptFileNotes(files);
  }

  async function handleGenerateInvoice() {
    setGeneratingInvoice(true);
    setInvError(null);
    try {
      const inv = await apiFetch<Invoice>(
        `/invoices/cases/${labCase.id}/generate-invoice`,
        {
          method: "POST",
          body: JSON.stringify(generatePresetId ? { layoutPresetId: generatePresetId } : {}),
        }
      );
      await invoiceQuery.refetch();
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setViewingInvoice(inv);
    } catch (err: any) {
      setInvError(err?.message || "Could not generate invoice.");
    } finally {
      setGeneratingInvoice(false);
    }
  }

  function startEdit() {
    savedRxDraft.current = null;
    savedImplantDrafts.current = {};
    setEditImplants(Object.fromEntries((data?.restorations ?? []).map((row) => [row.id, row])));
    setSaveError(null);
    const src = data ?? labCase;
    const nextForm: PendingCaseEdit = {
      patientFirstName: src.patientFirstName || "",
      patientLastName: src.patientLastName || "",
      doctorName: src.doctorName || "",
      providerOrganizationId: src.providerOrganizationId || "",
      receivedAt:
        src.receivedAt && isValidCalendarDate(src.receivedAt)
          ? src.receivedAt
          : "",
      dueDate: src.dueDate
        ? new Date(src.dueDate).toISOString().split("T")[0]
        : "",
      dueTime: src.dueTime || "",
      priority: (src.priority || "normal") as "normal" | "rush",
      casePanBarcode: src.casePanBarcode || "",
      rxNotes: (src as any).caseNotes ?? "",
      gingivialShade: (src.gingivialShade ?? "").trim(),
    };
    setEditForm(nextForm);
    originalEditForm.current = nextForm;
    setEditHasDueTime(Boolean(src.dueTime));
    const sourceDetail = (data ?? labCase) as NonNullable<typeof data>;
    const clinicalRestorations = (sourceDetail.restorations ?? []).filter(
      (restoration) => restoration.restorationType !== "missing",
    );
    const curSummary = deriveRxSummary(clinicalRestorations);
    const firstRestoration = clinicalRestorations[0];
    setEditRxType(firstRestoration?.restorationType ?? curSummary.restorativeType ?? "Other");
    setEditRxMaterial(curSummary.materials.join(", "));
    setEditRxSubtype(firstRestoration?.restorationSubtype ?? null);
    setEditRxShade(curSummary.shades.join(", "));
    setEditRxTeeth(curSummary.teeth.join(", "));
    const arches = new Set(
      (sourceDetail.restorations ?? [])
        .map((restoration) => restoration.arch)
        .filter((arch): arch is "upper" | "lower" => arch === "upper" || arch === "lower"),
    );
    setEditRxArch(
      arches.size > 1 ? "both" : arches.has("upper") ? "upper" : arches.has("lower") ? "lower" : "",
    );
    setEditRxStep(sourceDetail.step ?? "");
    setEditRxStepShade(sourceDetail.stepShade ?? "");
    setEditError(null);
    setEditMode(true);
  }

  function cancelCaseEdit() {
    setEditMode(false);
    setEditError(null);
  }

  async function saveCaseEdit() {
    const clinicalRestorations = (data?.restorations ?? []).filter(
      (restoration) => restoration.restorationType !== "missing",
    );
    const snappedSummary = deriveRxSummary(clinicalRestorations);
    const origType =
      clinicalRestorations[0]?.restorationType ?? snappedSummary.restorativeType ?? "Other";
    const origMaterial = snappedSummary.materials.join(", ");
    const origSubtype = clinicalRestorations[0]?.restorationSubtype ?? null;
    const origShade = snappedSummary.shades.join(", ");
    const origTeeth = snappedSummary.teeth.join(", ");
    const oldArches = new Set(
      clinicalRestorations
        .map((restoration) => restoration.arch)
        .filter((arch) => arch === "upper" || arch === "lower"),
    );
    const origArch =
      oldArches.size > 1
        ? "both"
        : oldArches.has("upper")
          ? "upper"
          : oldArches.has("lower")
            ? "lower"
            : "";
    const origStep = data?.step ?? labCase.step ?? "";
    const origStepShade = data?.stepShade ?? labCase.stepShade ?? "";
    const changed = {
      shade: editRxShade.trim() !== origShade.trim(),
      arch: editRxArch !== origArch,
      step: editRxStep !== origStep,
      stepShade: editRxStepShade.trim() !== origStepShade.trim(),
    };

    if (
      (editRxHierarchy.caseType === "removable" ||
        editRxHierarchy.caseType === "ortho") &&
      !editRxArch
    ) {
      setEditError("Choose an arch for Removable and Ortho cases.");
      return;
    }

    setEditError(null);
    const caseEdit = { ...editForm };
    let rxEdit: typeof pendingRxSummaryEdit = null;
    if (
      !sameClinicalHierarchy(
        { restorationType: origType, restorationSubtype: origSubtype, material: origMaterial },
        { restorationType: editRxType, restorationSubtype: editRxSubtype, material: editRxMaterial },
      ) ||
      changed.shade ||
      editRxTeeth.trim() !== origTeeth.trim() ||
      changed.arch ||
      changed.step ||
      changed.stepShade
    ) {
      rxEdit = {
        type: editRxType,
        material: editRxMaterial,
        restorationSubtype: editRxSubtype,
        shade: editRxShade,
        teeth: editRxTeeth,
        arch: editRxArch,
        step: editRxStep,
        stepShade: editRxStepShade,
        changed: {
          ...changed,
          step: canEditStep && changed.step,
          stepShade: canEditStep && changed.stepShade,
        },
      };
      if (JSON.stringify({ ...rxEdit, changed: undefined }) === savedRxDraft.current) rxEdit = null;
    }
    // Pass the new values directly; React state setters do not synchronously
    // update the snapshot used by the save path.
    const changedCaseEdit = JSON.stringify(originalEditForm.current) === JSON.stringify(caseEdit) ? null : caseEdit;
    setPendingCaseEdit(changedCaseEdit);
    setPendingRxSummaryEdit(rxEdit);
    if (await handleSaveChanges({ caseEdit: changedCaseEdit, rxEdit, implantEdits: editImplants })) cancelCaseEdit();
  }

  function addPendingRestoration() {
    const typeValue = restForm.restorationType === "Other"
      ? restForm.customType.trim()
      : restForm.restorationType;
    if (!typeValue) {
      setRestError("Restoration type is required.");
      return;
    }
    const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPendingCreates((prev) => [
      ...prev,
      {
        localId,
        toothNumber: restForm.toothNumber || "",
        ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, restForm[key] || null])),
        restorationType: typeValue,
        material: restForm.material,
        restorationSubtype: restForm.restorationSubtype,
        shade: restForm.shade,
        quantity: restForm.quantity,
        unitPrice: restForm.unitPrice,
      },
    ]);
    setRestForm({
      implantRetention: null,
      implantManufacturer: null,
      implantPlatformNotes: null,
      toothNumber: "",
      restorationType: "",
      customType: "",
      material: "",
      restorationSubtype: null,
      shade: "",
      quantity: 1,
      unitPrice: "",
    });
    setShowAddRest(false);
    setRestError(null);
  }

  const isAdmin = !!data?.viewerCanManageAttachments;
  const canEditClinicalHierarchy =
    user?.role === "admin" || user?.role === "owner";
  const canEditStep = canEditClinicalHierarchy;
  const editRxHierarchy = deriveCaseHierarchy(
    editRxType,
    editRxSubtype,
    editRxMaterial,
  );
  const implantEditors = editRxHierarchy.subtype === "implant" ? (data?.restorations ?? []).filter((row) => row.restorationType !== "missing").map((row, index) => (
    <div key={row.id} className="mt-3 space-y-1">
      <div className="text-xs font-medium">Line {index + 1} · Tooth {row.toothNumber || "—"} · Implant</div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-2">
        <ImplantDetailsControls value={editImplants[row.id] ?? row} onChange={(details) => setEditImplants((current) => ({ ...current, [row.id]: details }))} disabled={isSaving || data?.viewerIsLabMember === false} />
      </div>
    </div>
  )) : null;
  const showArchEditor =
    editRxHierarchy.caseType === "removable" ||
    editRxHierarchy.caseType === "ortho" ||
    editRxArch !== "";
  const showStepEditor =
    editRxHierarchy.caseType === "removable" ||
    editRxHierarchy.caseType === "ortho" ||
    !!(data?.step ?? labCase.step);
  const currentStatus = (data?.status ?? labCase.status) as string;
  const hasRestorations = (data?.restorations?.length ?? 0) > 0;
  const restorationCount = data?.restorations?.length ?? 0;
  const noteCount = data?.notes?.length ?? 0;
  const fileCount = data?.attachments?.length ?? 0;
  const apiLocations = locationsQuery.data;
  const ROUTE_STATUSES =
    apiLocations && apiLocations.length > 0
      ? apiLocations
      : STATUS_FILTERS.filter((s) => s.value !== "all").map((s) => ({ id: s.value, value: s.value, label: s.label }));

  // Resolve the station display name. When the case has an authoritative
  // labLocationId, use it directly — no heuristic needed. Fall back to the
  // single-station heuristic (only when exactly one station maps to the
  // current status) so labs without custom stations still see a name.
  const resolvedStationLabel = (() => {
    const savedLocationName =
      (data as any)?.labLocationName ?? (labCase as any)?.labLocationName;
    if (savedLocationName) return savedLocationName;
    if (!apiLocations || apiLocations.length === 0) return null;
    const caseLabLocationId = (data as any)?.labLocationId ?? (labCase as any)?.labLocationId;
    if (caseLabLocationId) {
      const byId = apiLocations.find((s) => s.id === caseLabLocationId);
      if (byId) return byId.label;
    }
    // Heuristic fallback: authoritative only when exactly one station maps
    // to the current status (ambiguous otherwise).
    const matching = apiLocations.filter((s) => s.value === currentStatus);
    return matching.length === 1 ? matching[0].label : null;
  })();

  const savedChartToolbar = (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded-md border px-3 text-sm disabled:opacity-40" disabled={!toothUndo || isSaving}
          onClick={() => {
            if (!toothUndo) return;
            setPendingCreates(toothUndo.creates);
            setPendingDeletes(toothUndo.deletes);
            setPendingUpdates(toothUndo.updates);
            setConnectorDraft(toothUndo.connectors);
            setToothUndo(null);
            setConnectorSaveError(null);
            setToothCopySourceId(null);
            setToothCopyAnchor(null);
            setToothSelectionAnchor(null);
            setToothSelectedTargets([]);
            setToothMultiSelect(false);
            setToothCopyMessage("Undo restored the unsaved tooth edits and connector choices. Click an assigned tooth to choose copy settings.");
          }}>Undo unsaved tooth edit</button>
        <button type="button" disabled={isSaving} aria-pressed={toothMultiSelect}
          className="min-h-11 rounded-md border px-3 text-sm disabled:opacity-40"
          onClick={() => { setToothMultiSelect((active) => !active); setToothSelectedTargets([]); setToothSelectionAnchor(null); }}>
          {toothMultiSelect ? "Cancel tooth selection" : "Select multiple teeth"}
        </button>
        {toothMultiSelect && <button type="button" disabled={isSaving || !toothSelectedTargets.length}
          className="min-h-11 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
          onClick={() => {
            const arch = selectedToothArch(toothSelectedTargets);
            const wholeArch = arch && archSelectionTeeth(arch).every((tooth) => toothSelectedTargets.includes(tooth));
            if (!wholeArch && toothSelectedTargets.some((tooth) => stagedToothAssignment(tooth) || missingTeethIds.has(tooth))) {
              setToothCopyMessage("Select unassigned teeth to add restorations. Use Copy settings with replacement review for existing assignments.");
              return;
            }
            setToothDialogError(null);
            setToothDialogId(toothSelectedTargets[0]);
          }}>Assign {toothSelectedTargets.length} selected teeth</button>}
        {toothMultiSelect && toothCopySourceId && <button type="button" disabled={isSaving || !toothSelectedTargets.length}
          className="min-h-11 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40"
          onClick={() => requestSavedToothCopy(toothSelectedTargets)}>Copy settings to {toothSelectedTargets.length} selected teeth</button>}
      </div>
      {toothCopyMessage && <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950" role="status">{
        toothCopyMessage.startsWith("Copy settings:") ? (() => {
          const source = toothCopyAnchor ? stagedToothAssignment(toothCopyAnchor) : undefined;
          return source?.id === toothCopySourceId
            ? `Copy settings: #${toothCopyAnchor} ${source.restorationType} · ${source.material || "Material needs review"} · ${source.shade || "No shade"}. Ctrl/Cmd-click to copy; Shift-click to select a same-arch range.`
            : "Choose an assigned tooth again to select its current copy settings.";
        })() : toothCopyMessage
      }</p>}
    </div>
  );
  const tabs: Array<{ id: CaseTab; label: string; count?: number }> = [
    { id: "lab-slip", label: "Lab Slip" },
    { id: "restorations", label: "Restorations", count: restorationCount },
    { id: "notes", label: "Notes", count: noteCount },
    { id: "files", label: "Files", count: fileCount },
    { id: "invoice", label: "Invoice" },
    { id: "history", label: "History", count: (data?.events?.length ?? 0) + (data?.originalCaseEvents?.length ?? 0) + (data?.remakeChildrenEvents?.reduce((s, rc) => s + rc.events.length, 0) ?? 0) || undefined },
  ];
  const activateTab = (tabId: CaseTab) => {
    if (tabId === activeTab) return;
    const proceed = () => {
      if (tabId !== "lab-slip") cancelCaseEdit();
      setActiveTab(tabId);
      queueMicrotask(() => document.getElementById(`case-tab-${tabId}`)?.focus());
    };
    if (activeTab !== "invoice" || !guardNavigation(proceed)) proceed();
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    activateTab(tabs[nextIndex].id);
  };

  return (
    <div ref={drawerLayoutRef} className={docked ? "fixed inset-0 z-50 flex lg:sticky lg:inset-auto lg:z-auto lg:top-4 lg:w-[460px] lg:max-w-[46vw] lg:shrink-0 lg:h-[var(--case-drawer-height,calc(100dvh-2rem))]" : "fixed inset-0 z-50 flex"}>
      <div className={`flex-1 bg-foreground/30 ${docked ? "lg:hidden" : ""}`} onClick={handleCloseWithGuard} />
      <aside data-testid="case-drawer" className={`@container/drawer w-full ${docked ? "max-w-[700px] lg:max-w-none border border-border lg:rounded-xl overflow-hidden" : "max-w-[1280px] border-l border-border shadow-2xl"} bg-card h-full flex flex-col${(data?.priority ?? labCase.priority) === "rush" ? " text-destructive [&_*]:text-destructive" : ""}`}>
        {/* Header */}
        <header className="relative flex flex-wrap items-start justify-between gap-3 px-5 py-3 border-b border-border shrink-0">
          {docked && onExpand && <div className="w-full flex justify-end"><button type="button" onClick={onExpand} className="inline-flex items-center gap-1.5 text-sm font-medium rounded border px-2 py-1"><ExternalLink size={14} />Open Case</button></div>}
          <div className="min-w-[min(100%,20rem)] flex-1">
            {(() => {
              const firstName = data?.patientFirstName ?? labCase.patientFirstName;
              const lastName = data?.patientLastName ?? labCase.patientLastName;
              const patientName =
                [firstName, lastName].filter(Boolean).join(" ") ||
                (data?.patientInitials ?? labCase.patientInitials ?? "");
              return (
                <div data-testid="case-header-patient" className="flex flex-wrap items-center gap-2">
                  {patientName && (
                    <span className="min-w-0 max-w-full text-xl font-bold leading-tight break-words">
                      {patientName}
                    </span>
                  )}
                  <div data-testid="case-header-actions" className="flex max-w-full items-center gap-2 shrink-0 @max-[360px]/drawer:[&>button]:min-w-0 @max-[360px]/drawer:[&>button]:shrink">
                  {isAdmin && (
                    <button
                      type="button"
                      data-testid="case-remake-create"
                      onClick={() => {
                        setRemakeFromDetailQ(blankQuestionnaire());
                        setRemakeFromDetailError(null);
                        setRemakeFromDetailOpen(true);
                      }}
                      className={CASE_ACTION_BUTTON_CLASS}
                      title="Create a remake of this case"
                    >
                      <GitBranch size={14} />
                      Remake
                    </button>
                  )}
                  {(data?.viewerIsLabMember ?? false) && (
                    <CaseExceptionAction
                      caseId={labCase.id}
                      labOrganizationId={
                        data?.labOrganizationId ?? labCase.labOrganizationId
                      }
                      activeException={data?.activeException ?? null}
                    />
                  )}
                  </div>
                </div>
              );
            })()}
            {/* The case number stays on the Lab Slip. */}
            {(data?.priority ?? labCase.priority) === "rush" && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-destructive bg-destructive/10 px-1.5 py-0.5 rounded-full">
                  Rush
                </span>
              </div>
            )}
          </div>
          <div data-testid="case-header-utilities" className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() =>
                openAiPanel({
                  caseId: labCase.id,
                  caseNumber: labCase.caseNumber ?? "",
                  patientName: [labCase.patientFirstName, labCase.patientLastName].filter(Boolean).join(" "),
                })
              }
              className="h-8 px-2.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
              title="Ask AI about this case"
            >
              <Sparkles size={14} />
              Ask AI
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setConfirmDeleteCase(true)}
                className="h-8 w-8 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center transition-colors"
                title="Delete case"
              >
                <Trash2 size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={handleCloseWithGuard}
              disabled={isSaving}
              aria-label="Close case drawer"
              className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            >
              <X size={16} />
            </button>
          </div>
          <div data-testid="case-header-location" className="w-full min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Location
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <StatusBadge status={currentStatus} label={resolvedStationLabel ?? undefined} />
              {user?.userType !== "provider" && data?.viewerIsLabMember !== false && <>
              <select
                value={routeStatus}
                onChange={(e) => handleRouteStationChange(e.target.value)}
                aria-label="Move case to station"
                disabled={routeMutation.isPending}
                className="flex-1 min-w-0 basis-36 h-8 px-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                data-testid="locate-case-select"
              >
                <option value="">Select station…</option>
                {(() => {
                  // Only the exact saved station is current; same-status
                  // custom stations must remain independently selectable.
                  const caseLabLocationId = data?.labLocationId ?? labCase.labLocationId ?? null;
                  const usingRealLocations = apiLocations && apiLocations.length > 0;
                  return ROUTE_STATUSES.map((s) => {
                    const current = caseLabLocationId && usingRealLocations
                      ? s.id === caseLabLocationId
                      : s.value === currentStatus;
                    return (
                      <option key={s.id} value={s.id} disabled={current}>
                        {s.label}{current ? " (current)" : ""}
                      </option>
                    );
                  });
                })()}
              </select>
              {routeMutation.isPending && (
                <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Locating…
                </span>
              )}
              </>}
            </div>
            {routeError && <p className="mt-1.5 text-xs text-destructive break-words">{routeError}</p>}
            {routeSuccessMsg && (
              <p className="mt-1.5 text-xs text-green-600 break-words">{routeSuccessMsg}</p>
            )}
          </div>
        </header>

        {/* Remake link banner: shown both ways — when this case IS a remake of
            an earlier one, and when this case HAS been remade later. */}
        {(data?.remakeOriginal || (data?.remakeChildren?.length ?? 0) > 0) && (
          <div className="px-5 py-3 border-b border-border bg-blue-500/10 flex items-start gap-3 shrink-0">
            <AlertTriangle size={16} className="text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 space-y-1">
              {data?.remakeOriginal && (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs text-blue-700 dark:text-blue-200 min-w-0">
                      <span className="font-semibold">Remake of </span>
                      <button
                        type="button"
                        onClick={() => onOpenCaseId?.(data.remakeOriginal!.id)}
                        className="font-mono underline hover:text-blue-900 dark:hover:text-white"
                      >
                        {data.remakeOriginal.caseNumber}
                      </button>
                      {data.remakeReason && (
                        <span className="text-blue-700/80 dark:text-blue-200/80">
                          {" "}— {data.remakeReason}
                        </span>
                      )}
                      <span className="ml-2 inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/20">
                        {data.remakeCharged === false
                          ? "no charge"
                          : data.remakeCharged === true
                          ? "charged"
                          : "charge unspecified"}
                      </span>
                    </div>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={openEditRemake}
                        title="Edit remake reason"
                        className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-blue-600/70 dark:text-blue-300/70 hover:text-blue-800 dark:hover:text-blue-100 hover:bg-blue-500/20 transition-colors"
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </div>
                  {data.remakeNotes && data.remakeNotes.trim() && (
                    <div className="mt-1.5">
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-blue-700/60 dark:text-blue-300/60">Remake notes</span>
                      <p className="text-xs text-blue-800/80 dark:text-blue-200/80 mt-0.5 whitespace-pre-wrap">{data.remakeNotes.trim()}</p>
                    </div>
                  )}
                </>
              )}
              {(data?.remakeChildren?.length ?? 0) > 0 && (
                <div className="text-xs text-blue-700 dark:text-blue-200">
                  <span className="font-semibold">Remade by </span>
                  {data!.remakeChildren!.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        onClick={() => onOpenCaseId?.(c.id)}
                        className="font-mono underline hover:text-blue-900 dark:hover:text-white"
                      >
                        {c.caseNumber}
                      </button>
                      {c.remakeCharged === false && (
                        <span className="text-[10px] uppercase ml-1 text-blue-700/70">
                          (no charge)
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Remake history — collapsible timeline showing every generation */}
        {remakeChain.length >= 2 && (
          <div className="border-b border-border shrink-0">
            <button
              type="button"
              onClick={() => setRemakeChainExpanded((v) => !v)}
              className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-muted/50 transition-colors"
            >
              <GitBranch size={14} className="text-muted-foreground shrink-0" />
              <span className="flex-1 text-left text-xs font-medium text-foreground">
                Remake history
              </span>
              <span className="text-[10px] text-muted-foreground mr-1">
                {remakeChain.length} generation{remakeChain.length !== 1 ? "s" : ""}
              </span>
              {remakeChainExpanded ? (
                <ChevronUp size={13} className="text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown size={13} className="text-muted-foreground shrink-0" />
              )}
            </button>
            {remakeChainExpanded && (
              <div className="px-5 pb-3 space-y-1.5">
                {remakeChain.map((entry, idx) => {
                  const isCurrent = entry.id === labCase.id;
                  const genLabel = String.fromCharCode(65 + idx);
                  return (
                    <div
                      key={entry.id}
                      className={[
                        "flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors",
                        isCurrent
                          ? "bg-primary/10"
                          : "hover:bg-muted/50 cursor-pointer",
                      ].join(" ")}
                      onClick={() => {
                        if (!isCurrent && onOpenCaseId) onOpenCaseId(entry.id);
                      }}
                      role={isCurrent ? undefined : "button"}
                      tabIndex={isCurrent ? undefined : 0}
                      onKeyDown={(e) => {
                        if (!isCurrent && onOpenCaseId && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          onOpenCaseId(entry.id);
                        }
                      }}
                    >
                      <span
                        className={[
                          "flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 mt-0.5",
                          isCurrent
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        ].join(" ")}
                      >
                        {genLabel}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-medium text-foreground">
                            {entry.caseNumber}
                          </span>
                          {entry.status && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                              {remakeChainLocationLabel(entry, apiLocations ?? [])}
                            </span>
                          )}
                          {isCurrent && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">
                              Current
                            </span>
                          )}
                        </div>
                        {(entry.remakeReason || idx > 0) && (
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {entry.remakeReason && (
                              <span className="text-[11px] text-muted-foreground truncate">
                                {entry.remakeReason}
                              </span>
                            )}
                            {idx > 0 && (
                              <span className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/20 shrink-0">
                                {entry.remakeCharged === false
                                  ? "no charge"
                                  : entry.remakeCharged === true
                                  ? "charged"
                                  : "charge unspecified"}
                              </span>
                            )}
                          </div>
                        )}
                        {/* Structured questionnaire detail lines */}
                        {idx > 0 && (entry.remakeShadePrescribed || entry.remakeShadeProvided || entry.remakeShadeLightness) && (
                          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                            <span className="text-[10px] text-muted-foreground font-medium">Shade:</span>
                            {entry.remakeShadePrescribed && (
                              <span className="text-[10px] text-muted-foreground">
                                prescribed <span className="font-mono">{entry.remakeShadePrescribed}</span>
                              </span>
                            )}
                            {entry.remakeShadeProvided && (
                              <span className="text-[10px] text-muted-foreground">
                                {entry.remakeShadePrescribed ? "→" : "provided"} <span className="font-mono">{entry.remakeShadeProvided}</span>
                              </span>
                            )}
                            {entry.remakeShadeLightness && (
                              <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                                {entry.remakeShadeLightness}
                              </span>
                            )}
                          </div>
                        )}
                        {idx > 0 && (entry.remakeMaterialPrescribed || entry.remakeMaterialProvided) && (
                          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                            <span className="text-[10px] text-muted-foreground font-medium">Material:</span>
                            {entry.remakeMaterialPrescribed && (
                              <span className="text-[10px] text-muted-foreground">
                                prescribed <span className="font-mono">{entry.remakeMaterialPrescribed}</span>
                              </span>
                            )}
                            {entry.remakeMaterialProvided && (
                              <span className="text-[10px] text-muted-foreground">
                                {entry.remakeMaterialPrescribed ? "→" : "provided"} <span className="font-mono">{entry.remakeMaterialProvided}</span>
                              </span>
                            )}
                          </div>
                        )}
                        {idx > 0 && entry.remakeReturnedToLab != null && (
                          <div className="mt-0.5">
                            <span className="text-[10px] text-muted-foreground">
                              {entry.remakeReturnedToLab ? "Returned to lab" : "Not returned to lab"}
                            </span>
                          </div>
                        )}
                        {entry.remakeNotes && entry.remakeNotes.trim() && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 whitespace-pre-wrap">
                            {entry.remakeNotes.trim()}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {((data?.unrecognizedMaterials?.length ?? 0) > 0 ||
          !!data?.suggestedDoctorName) && (
          <div className="px-5 py-3 border-b border-border shrink-0 space-y-3">
            {data?.unrecognizedMaterials && data.unrecognizedMaterials.length > 0 && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2.5 flex items-start gap-2.5">
                <AlertTriangle size={14} className="text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                    Unrecognized {data.unrecognizedMaterials.length === 1 ? "material" : "materials"}:{" "}
                    <span className="font-bold">{data.unrecognizedMaterials.join(", ")}</span>
                  </div>
                  <div className="text-[11px] text-red-700/70 dark:text-red-200/60 mt-0.5">
                    {data.unrecognizedMaterials.length === 1 ? "This material" : "These materials"}{" "}
                    couldn't be matched to a price, so the affected{" "}
                    {data.unrecognizedMaterials.length === 1 ? "restoration was" : "restorations were"}{" "}
                    added to the draft invoice at $0. Fix the material name or set the price manually before billing.
                  </div>
                </div>
              </div>
            )}

            {data?.suggestedDoctorName && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                    Did you mean{" "}
                    <span className="font-bold">{data.suggestedDoctorName}</span>
                    {data.suggestedPracticeName ? (
                      <span className="font-normal"> at {data.suggestedPracticeName}</span>
                    ) : null}
                    ?
                  </div>
                  <div className="text-[11px] text-amber-700/70 dark:text-amber-200/60 mt-0.5">
                    The AI extracted a name that closely matches an existing doctor. Select the correct one below.
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => acceptSuggestionMutation.mutate()}
                    disabled={acceptSuggestionMutation.isPending || dismissSuggestionMutation.isPending}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-60"
                  >
                    {acceptSuggestionMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : null}
                    Use this doctor
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissSuggestionMutation.mutate()}
                    disabled={acceptSuggestionMutation.isPending || dismissSuggestionMutation.isPending}
                    className="inline-flex items-center h-7 px-2.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-medium disabled:opacity-60"
                  >
                    Keep as-is
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab navigation */}
        <nav
          role="tablist"
          aria-label="Case details"
          className="flex items-center border-b border-border px-2 shrink-0 overflow-x-auto"
        >
          {tabs.map((tab, index) => (
            <div key={tab.id} className="flex items-center">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className="w-px h-4 bg-border shrink-0"
                />
              )}
              <button
                type="button"
                id={`case-tab-${tab.id}`}
                role="tab"
                aria-controls="case-detail-panel"
                aria-selected={activeTab === tab.id}
                tabIndex={activeTab === tab.id ? 0 : -1}
                disabled={isSaving}
                onClick={() => activateTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className={`px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${
                  activeTab === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${
                      activeTab === tab.id
                        ? "bg-primary/15 text-primary"
                        : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            </div>
          ))}
        </nav>

        {/* Tab content */}
        <div
          id="case-detail-panel"
          role="tabpanel"
          aria-labelledby={`case-tab-${activeTab}`}
          tabIndex={0}
          data-testid="case-detail-body"
          inert={isSaving}
          className="flex-1 min-h-0 min-w-0 overflow-y-auto"
        >

          {/* ── OVERVIEW ── */}
          {activeTab === "lab-slip" && (() => {
            const restorations = caseRestorations;
            const summary = deriveRxSummary(restorations);
            const hasPfmRestoration = restorations.some(
              (r) =>
                (r as { priceKey?: string | null }).priceKey === "pfm_crown" ||
                /pfm/i.test(r.material ?? ""),
            );
            const alloyLine = restorations.find(
              (r) =>
                (r as { priceKey?: string | null }).priceKey === "alloy" ||
                (r.restorationType ?? "").trim().toLowerCase() === "alloy",
            );
            const hasAlloyCharge = !!alloyLine;
            const alloyUnpriced =
              !!alloyLine &&
              Number(
                (alloyLine as { unitPrice?: string | number | null })
                  .unitPrice ?? 0,
              ) <= 0;
            // Practice the case currently points at — the staged edit wins so
            // the drawer never shows the previous practice's address while a
            // change is pending.
            const casePracticeId =
              data?.providerOrganizationId ?? labCase.providerOrganizationId ?? null;
            const selectedPracticeId =
              pendingCaseEdit?.providerOrganizationId ?? casePracticeId;
            const practice = resolvePracticeContact({
              selectedPracticeId,
              casePracticeId,
              caseContact: data?.providerOrganizationContact ?? null,
              listOrganization: selectedPracticeId
                ? drawerProviderOrgs.find((o) => o.id === selectedPracticeId) ?? null
                : null,
            });
            // Step belongs to removable work only; the effective hierarchy of
            // the case decides, with the per-restoration category as a
            // fallback for rows the taxonomy cannot place.
            const hierarchyForStep = restorations[0]
              ? deriveCaseHierarchy(
                  restorations[0].restorationType,
                  (restorations[0] as any).restorationSubtype ?? null,
                  restorations[0].material,
                )
              : null;
            const isRemovableCase =
              hierarchyForStep?.caseType === "removable" ||
              (restorations.length > 0 &&
                restorations.every((r) =>
                  isRemovableRestorationType(r.restorationType),
                ));
            const toothNumbers = formatRxToothNumbers(
              restorations,
              data?.teeth ?? labCase.teeth,
            );
            return (
            <div className="px-5 py-5 space-y-6">
              {hasPfmRestoration && !hasAlloyCharge && !pfmReminderDismissed && (() => {
                const preview = alloyPreviewQuery.data;
                const previewReady = !alloyPreviewQuery.isLoading;
                const noAlloyPrice = previewReady && preview != null && !preview.priced;
                const priceLabel =
                  preview != null && preview.priced
                    ? ` ($${preview.amount.toFixed(2)})`
                    : "";
                return (
                <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                  <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      {noAlloyPrice
                        ? "PFM detected — no alloy price set in your fee schedule."
                        : "PFM detected — don't forget to charge for alloy."}
                    </p>
                    <div className="mt-1.5 flex items-center gap-3">
                      {noAlloyPrice ? (
                        <a
                          href="/pricing"
                          onClick={onClose}
                          className="text-xs font-semibold text-amber-800 dark:text-amber-200 hover:underline"
                        >
                          Set up fee schedule
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addAlloyMutation.mutate()}
                          disabled={
                            addAlloyMutation.isPending ||
                            !preview ||
                            !preview.priced
                          }
                          className="text-xs font-semibold text-amber-800 dark:text-amber-200 hover:underline disabled:opacity-50"
                        >
                          {addAlloyMutation.isPending
                            ? "Adding…"
                            : !previewReady
                              ? "Checking alloy price…"
                              : `Add alloy charge${priceLabel}`}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={dismissPfmReminderThisCase}
                        className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:underline"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        onClick={dismissPfmReminderForever}
                        className="text-xs text-amber-700/80 dark:text-amber-300/80 hover:underline"
                      >
                        Don't show again
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={dismissPfmReminderThisCase}
                    className="text-amber-600/70 dark:text-amber-400/70 hover:text-amber-700 dark:hover:text-amber-300 shrink-0"
                    aria-label="Dismiss reminder"
                  >
                    <X size={14} />
                  </button>
                </div>
                );
              })()}
              {alloyUnpriced && isAdmin && (
                <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                  <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      Alloy charge added at $0 — no alloy price is set for this case's pricing tier.
                    </p>
                    <form
                      className="mt-2 flex flex-wrap items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const parsed = Number(alloyPriceInput);
                        if (!Number.isFinite(parsed) || parsed <= 0) return;
                        setAlloyPriceMutation.mutate(parsed);
                      }}
                    >
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-amber-700 dark:text-amber-300">
                          $
                        </span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          inputMode="decimal"
                          value={alloyPriceInput}
                          onChange={(e) => setAlloyPriceInput(e.target.value)}
                          placeholder="0.00"
                          aria-label="Alloy price"
                          className="w-24 rounded border border-amber-500/50 bg-white/70 dark:bg-black/20 pl-5 pr-2 py-1 text-sm tabular-nums text-amber-900 dark:text-amber-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={
                          setAlloyPriceMutation.isPending ||
                          !(Number(alloyPriceInput) > 0)
                        }
                        className="rounded bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                      >
                        {setAlloyPriceMutation.isPending ? "Saving…" : "Set alloy price"}
                      </button>
                    </form>
                    {setAlloyPriceMutation.isError && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                        Couldn't set the alloy price. Please try again.
                      </p>
                    )}
                    {setAlloyPriceMutation.isSuccess && setAlloyPriceMutation.data?.target && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        Saved to {setAlloyPriceMutation.data.target.kind === "tier" ? "tier" : "override"} “{setAlloyPriceMutation.data.target.name}”.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {!data?.viewerIsLabMember && data?.statusHistory && data.statusHistory.length > 0 && (
                <section>
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
                    Progress
                  </h3>
                  <CaseTimelineBar
                    statusHistory={data.statusHistory}
                    currentStatus={currentStatus}
                  />
                </section>
              )}
              <section data-testid="case-slip-details-panel" className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-2">
                  <h3 className="text-lg font-bold">
                    Case Details
                  </h3>
                  <div data-testid="case-details-actions" className="flex items-center gap-2 shrink-0">
                    {pendingCaseEdit !== null && !editMode && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                        Staged
                      </span>
                    )}
                    {!isDefaultLayout(printLayout) && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        Customized
                      </span>
                    )}
                    <button
                      type="button"
                      data-testid="case-details-layout"
                      onClick={() => setShowPrintLayoutEditor(true)}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Customize print layout"
                    >
                      <Settings2 size={11} />
                      Layout
                    </button>
                    <button
                      type="button"
                      data-testid="case-details-print"
                      onClick={() => void printLabSlip()}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title={hasAdvancedTemplate ? "Print using advanced layout" : "Print lab slip"}
                    >
                      <Printer size={11} />
                      Print
                    </button>
                    {!editMode && (
                      <button
                        type="button"
                        data-testid="case-details-edit"
                        onClick={startEdit}
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                </div>
                <div data-testid="case-details-metadata" className="@container text-xs mb-3 rounded-lg border border-border bg-secondary/30 p-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 @[640px]:flex-nowrap @[640px]:gap-x-2">
                  <div data-testid="case-details-dates" className="flex min-w-[9rem] flex-1 flex-col items-start gap-1">
                  <span data-testid="case-details-date-created" className="font-bold">
                    Date Created:{" "}
                    <span>{formatDate(data?.createdAt ?? labCase.createdAt)}</span>
                  </span>
                  <span data-testid="case-details-due-date" className="inline-flex flex-wrap items-center gap-2 text-2xl leading-tight font-bold">
                    <span>Due Date:</span>
                    <span>
                      {formatDueDate(
                        quickDueDateOverride ?? pendingCaseEdit?.dueDate ?? (data?.dueDate ?? labCase.dueDate),
                        pendingCaseEdit?.dueTime ?? (data?.dueTime ?? labCase.dueTime),
                      )}
                    </span>
                    {!editMode && pendingCaseEdit === null && (
                      <span className="inline-flex items-center">
                        <button
                          type="button"
                          data-testid="case-details-due-date-picker-button"
                          aria-label={quickDueDateMutation.isPending ? "Saving due date" : "Change due date"}
                          title="Change due date"
                          disabled={!data || quickDueDateMutation.isPending}
                          onClick={() => {
                            const input = quickDueDateInputRef.current;
                            if (!input) return;
                            const showPicker = (input as HTMLInputElement & { showPicker?: () => void }).showPicker;
                            try {
                              if (showPicker) {
                                showPicker.call(input);
                                return;
                              }
                            } catch {
                              // Fall back to the native input click where
                              // showPicker is unavailable or disallowed.
                            }
                            input.click();
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"
                        >
                          {quickDueDateMutation.isPending
                            ? <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                            : <CalendarDays size={17} aria-hidden="true" />}
                        </button>
                        <input
                          ref={quickDueDateInputRef}
                          type="date"
                          data-testid="case-details-due-date-picker-input"
                          aria-hidden="true"
                          tabIndex={-1}
                          className="sr-only"
                          value={(quickDueDateOverride ?? data?.dueDate ?? labCase.dueDate ?? "").slice(0, 10)}
                          onChange={(event) => {
                            const nextDueDate = event.currentTarget.value;
                            if (
                              !nextDueDate ||
                              !isValidCalendarDate(nextDueDate) ||
                              nextDueDate === (data?.dueDate ?? labCase.dueDate ?? "").slice(0, 10)
                            ) return;
                            quickDueDateMutation.mutate(nextDueDate);
                          }}
                        />
                      </span>
                    )}
                  </span>
                  </div>
                  <span data-testid="case-details-metadata-divider" aria-hidden="true" className="hidden @[640px]:block w-px h-4 bg-border shrink-0" />
                  {(() => {
                    const effRush =
                      (pendingCaseEdit?.priority ?? data?.priority ?? labCase.priority) === "rush";
                    return (
                      <span data-testid="case-details-priority" className="inline-flex min-w-[9rem] flex-1 flex-wrap items-center gap-1.5">
                        <span className="font-bold">
                          Priority: <span>{effRush ? "Rush" : "Standard"}</span>
                        </span>
                        <button
                          type="button"
                          data-testid="case-details-rush-toggle"
                          onClick={() => rushMutation.mutate(effRush ? "normal" : "rush")}
                          disabled={rushMutation.isPending}
                          title={effRush ? "Clear rush on this case" : "Mark this case as rush"}
                          className={`inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium transition-colors disabled:opacity-50 ${
                            effRush
                              ? "text-destructive hover:bg-destructive/10"
                              : "text-primary/80 hover:text-primary hover:bg-primary/10"
                          }`}
                        >
                          <Zap size={10} />
                          {rushMutation.isPending
                            ? "Saving…"
                            : effRush
                              ? "Clear rush"
                              : "Mark rush"}
                        </button>
                      </span>
                    );
                  })()}
                  </div>
                </div>
                <div className="border-t border-border" />
                <div className="mt-3 mb-4">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                      Case #
                    </div>
                    {isAdmin && caseNumberEditMode ? (
                      <form
                        className="flex items-center gap-1 mt-1"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const trimmed = caseNumberEditValue.trim();
                          if (!trimmed) { setCaseNumberError("Case number cannot be blank."); return; }
                          setCaseNumberSaving(true);
                          setCaseNumberError(null);
                          try {
                            await apiFetch(`/cases/${labCase.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ caseNumber: trimmed }),
                            });
                            await Promise.all([
                              qc.invalidateQueries({ queryKey: ["cases"] }),
                              qc.invalidateQueries({ queryKey: ["case", labCase.id] }),
                              qc.invalidateQueries({ queryKey: ["invoices"] }),
                              qc.invalidateQueries({ queryKey: ["invoice-for-case", labCase.id] }),
                            ]);
                            toast.success("Case number updated.");
                            setCaseNumberEditMode(false);
                          } catch (err: unknown) {
                            setCaseNumberError(err instanceof Error ? err.message : "Could not save case number.");
                          } finally {
                            setCaseNumberSaving(false);
                          }
                        }}
                      >
                        <input
                          ref={caseNumberInputRef}
                          type="text"
                          value={caseNumberEditValue}
                          onChange={(e) => { setCaseNumberEditValue(e.target.value); setCaseNumberError(null); }}
                          className="h-7 px-1.5 rounded bg-secondary text-xs font-mono font-semibold border border-input focus:outline-none focus:ring-1 focus:ring-primary w-24"
                          disabled={caseNumberSaving}
                          onKeyDown={(e) => { if (e.key === "Escape") { setCaseNumberEditMode(false); setCaseNumberError(null); } }}
                          aria-label="Case number"
                        />
                        <button
                          type="submit"
                          disabled={caseNumberSaving}
                          className="h-6 w-6 rounded flex items-center justify-center hover:bg-primary/10 text-primary disabled:opacity-50"
                          aria-label="Save case number"
                          title="Save case number"
                        >
                          {caseNumberSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setCaseNumberEditMode(false); setCaseNumberError(null); }}
                          disabled={caseNumberSaving}
                          className="h-6 w-6 rounded flex items-center justify-center hover:bg-secondary text-muted-foreground disabled:opacity-50"
                          aria-label="Cancel case number edit"
                          title="Cancel"
                        >
                          <X size={11} />
                        </button>
                        {caseNumberError && (
                          <span className="text-xs text-destructive">{caseNumberError}</span>
                        )}
                      </form>
                    ) : (
                      <div className="flex items-center gap-1 mt-1">
                        <span className="font-mono text-sm font-semibold">
                          {data?.caseNumber ?? labCase.caseNumber}
                        </span>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setCaseNumberEditValue(data?.caseNumber ?? labCase.caseNumber ?? "");
                              setCaseNumberError(null);
                              setCaseNumberEditMode(true);
                              setTimeout(() => caseNumberInputRef.current?.focus(), 50);
                            }}
                            className="h-5 w-5 rounded flex items-center justify-center hover:bg-secondary text-muted-foreground/50 hover:text-muted-foreground"
                            aria-label="Edit case number"
                            title="Edit case number"
                          >
                            <Pencil size={10} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {!editMode && (
                  <section
                    aria-label="Patient & Provider"
                    data-testid="case-slip-patient-provider"
                    className="mb-4 rounded-lg border border-border bg-secondary/20 p-3"
                  >
                    <h4 className="mb-3 text-sm font-semibold">Patient &amp; Provider</h4>
                    <div className="grid grid-cols-1 gap-3 @[420px]/drawer:grid-cols-2 @[620px]/drawer:grid-cols-3">
                      <div data-testid="case-details-patient" className="min-w-0">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Patient</div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2 mt-1">
                          <span className="min-w-0 max-w-full text-sm break-words">
                            {`${pendingCaseEdit?.patientFirstName ?? data?.patientFirstName ?? labCase.patientFirstName} ${pendingCaseEdit?.patientLastName ?? data?.patientLastName ?? labCase.patientLastName}`.trim() || "—"}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setRxPreviewCaseId(null);
                              setRxPreviewOpen(true);
                            }}
                            className="inline-flex items-center gap-1 min-h-6 px-1.5 rounded text-[10px] font-medium text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors"
                            title="Preview prescription"
                          >
                            <ScrollText size={10} />
                            Preview Rx
                          </button>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Doctor</div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2 mt-1">
                          <span className="min-w-0 text-sm break-words">
                            {(pendingCaseEdit?.doctorName ?? data?.doctorName ?? labCase.doctorName) || "—"}
                          </span>
                          {(() => {
                            const curDoctor = data?.doctorName;
                            const curPracticeId = data?.providerOrganizationId;
                            const labOrgId = data?.labOrganizationId ?? labCase.labOrganizationId;
                            const canReassign =
                              canReassignDoctor &&
                              !!curDoctor &&
                              !!curPracticeId &&
                              !!labOrgId;
                            if (!canReassign) return null;
                            return (
                              <button
                                type="button"
                                onClick={() => {
                                  if (hasUnsavedDoctorAssignment) {
                                    notifyDoctorChange({ variant: "destructive", title: "Save or cancel edits first", description: "Save or cancel your doctor/practice edits before reassigning." });
                                    return;
                                  }
                                  setReassignDoctorOpen(true);
                                }}
                                className="inline-flex items-center gap-1 min-h-6 px-1.5 rounded text-[10px] font-medium text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors"
                                title="Reassign this case to a different doctor in the same practice"
                              >
                                <GitBranch size={10} />
                                Reassign
                              </button>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Practice</div>
                        <div className="mt-1 min-w-0" data-testid="practice-details">
                          <div className="text-sm break-words">{practice.name ?? "—"}</div>
                          {practice.addressLines.map((line) => (
                            <div key={line} className="text-sm text-muted-foreground break-words">
                              {line}
                            </div>
                          ))}
                          {practice.phone && (
                            <div className="text-sm text-muted-foreground">
                              {formatPhone(practice.phone)}
                            </div>
                          )}
                          {practice.name &&
                            practice.addressLines.length === 0 &&
                            !practice.phone && (
                              <div className="text-xs text-muted-foreground">
                                No address or phone on file.
                              </div>
                            )}
                        </div>
                      </div>
                    </div>
                  </section>
                )}
                {!editMode ? (
                  <div className="space-y-4 text-sm">
                    <section
                      aria-label="Restoration Details"
                      data-testid="case-slip-restoration-details"
                      className="rounded-lg border border-border bg-secondary/20 p-3"
                    >
                    <h4 className="mb-3 text-sm font-semibold">Restoration Details</h4>
                    {/* Tooth numbers are read-only here; the Case Details editor
                        remains the single place to enter or correct them. */}
                    <div
                      className="flex flex-wrap items-start gap-x-8 gap-y-3"
                      data-testid="tooth-custom-shade"
                    >
                      <div className="min-w-[13rem]">
                        <ToothNumbersDisplay value={toothNumbers} />
                      </div>
                      <CustomShadeSection
                        caseId={labCase.id}
                        isCustomShade={!!((data as any)?.isCustomShade)}
                        customShadeTechnician={
                          (data as any)?.customShadeTechnician ?? null
                        }
                        customShadePicturesAvailable={
                          !!((data as any)?.customShadePicturesAvailable)
                        }
                        customShadeVideoAvailable={
                          !!((data as any)?.customShadeVideoAvailable)
                        }
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-4 @[440px]/drawer:grid-cols-2">
                      <div className="space-y-3">
                      {(() => {
                        const restorations = data?.restorations ?? [];
                        const firstRestoration = restorations[0];
                        const hierarchy = firstRestoration
                          ? deriveCaseHierarchy(
                              firstRestoration.restorationType,
                              (firstRestoration as any).restorationSubtype ?? null,
                              firstRestoration.material,
                            )
                          : ({ caseType: null, subtype: null, materialSubtype: null } as CaseHierarchy);
                        const hierarchyIsMixed =
                          restorations.length > 1 &&
                          restorations.slice(1).some((restoration) => {
                            const restorationHierarchy = deriveCaseHierarchy(
                              restoration.restorationType,
                              (restoration as any).restorationSubtype ?? null,
                              restoration.material,
                            );
                            return JSON.stringify(restorationHierarchy) !== JSON.stringify(hierarchy);
                          });
                        const canEdit = user?.role === "admin" || user?.role === "owner";
                        const labOrgId = (data as any)?.labOrganizationId ?? (labCase as any).labOrganizationId;
                        const ctLabel = hierarchy.caseType ? CASE_TAXONOMY[hierarchy.caseType].label : null;
                        const stLabel = hierarchy.caseType && hierarchy.subtype
                          ? getSubtypeLabel(hierarchy.caseType, hierarchy.subtype as CaseSubtype)
                          : null;
                        const matLabel = hierarchy.caseType && hierarchy.subtype && hierarchy.materialSubtype
                          ? getMaterialSubtypeLabel(
                              hierarchy.caseType,
                              hierarchy.subtype as CaseSubtype,
                              hierarchy.materialSubtype as MaterialSubtype,
                            )
                          : null;
                        const applicableArch =
                          hierarchy.caseType === "removable" ||
                          hierarchy.caseType === "ortho";
                        return canEdit ? (
                          <CaseHierarchySelect
                            hierarchy={hierarchy}
                            caseId={labCase.id}
                            firstRestorationId={firstRestoration?.id}
                            labOrganizationId={labOrgId}
                            archValues={restorations.map((restoration) => restoration.arch)}
                            showFieldLabels
                          />
                        ) : (
                          <>
                            <Field label="Case Type" value={hierarchyIsMixed ? "Multiple" : ctLabel ?? "—"} />
                            <Field label="Case Subtype" value={hierarchyIsMixed ? "Multiple" : stLabel ?? "—"} />
                            <Field
                              label="Case Material"
                              value={hierarchyIsMixed
                                ? "Multiple"
                                : matLabel ?? (summary.materials.length > 0 ? summary.materials.join(", ") : "—")}
                            />
                            {applicableArch && (
                              <Field
                                label="Arch"
                                value={archLabel(restorations) ?? "Required"}
                              />
                            )}
                          </>
                        );
                      })()}
                      </div>
                      {/* Step is a removable-only production stage, so it sits
                          beside Case Type for those cases and is absent
                          everywhere else. */}
                      {(data?.restorations ?? []).filter(isImplantRestoration).map((row) => <SavedImplantDetails key={row.id} row={row} caseId={labCase.id} canEdit={user?.userType !== "provider" && data?.viewerIsLabMember !== false} />)}
                      {isRemovableCase && (() => {
                        const canEditStep = user?.role === "admin" || user?.role === "owner";
                        const caseData = data ?? labCase as any;
                        return (
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                              Step
                            </div>
                            <div className="mt-0.5">
                              {canEditStep ? (
                                <StepSelect
                                  value={caseData.step ?? null}
                                  shade={caseData.stepShade ?? null}
                                  caseId={labCase.id}
                                />
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-sm">{stepLabel(caseData.step)}</span>
                                  {caseData.step === "wax_setup" && caseData.stepShade && (
                                    <span className="text-xs text-muted-foreground">
                                      Shade: {caseData.stepShade}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <div className="grid grid-cols-1 gap-4 @[440px]/drawer:grid-cols-2">
                      <Field
                        label="Received Date"
                        value={formatDate(
                          pendingCaseEdit?.receivedAt ??
                            data?.receivedAt ??
                            labCase.receivedAt,
                        )}
                      />
                      {(data?.gingivialShade ?? labCase.gingivialShade) ? (
                        <Field label="Gingival shade" value={data?.gingivialShade ?? labCase.gingivialShade} />
                      ) : null}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-0.5">
                        Case pan barcode
                      </div>
                      {barcodeEditMode ? (
                        <>
                          <div className="flex items-center gap-1 mt-0.5">
                            <div className="relative flex-1">
                              <Barcode
                                size={13}
                                className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                              />
                              <input
                                ref={barcodeInlineInputRef}
                                value={barcodeEditValue}
                                onChange={(e) => setBarcodeEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); commitBarcodeEdit(); }
                                  if (e.key === "Escape") { setBarcodeEditMode(false); }
                                }}
                                placeholder="Scan or type barcode… (blank to clear)"
                                aria-label="Case pan barcode"
                                className="w-full h-7 pl-7 pr-2.5 rounded-md bg-secondary text-sm font-mono border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                                autoComplete="off"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => commitBarcodeEdit()}
                              className="h-7 w-7 rounded flex items-center justify-center text-primary hover:bg-primary/10 transition-colors shrink-0"
                              aria-label="Save barcode"
                              title="Save barcode"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setBarcodeEditMode(false)}
                              className="h-7 w-7 rounded flex items-center justify-center text-muted-foreground hover:bg-secondary transition-colors shrink-0"
                              aria-label="Cancel barcode edit"
                              title="Cancel"
                            >
                              <X size={13} />
                            </button>
                          </div>
                          {inlineBarcodeChecking && (
                            <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                              <Loader2 size={11} className="animate-spin" /> Checking barcode…
                            </p>
                          )}
                          {!inlineBarcodeChecking && inlineBarcodeConflict && (
                            <div className="mt-1 space-y-1">
                              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
                                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                                {`This barcode is already used by an active case${inlineBarcodeConflict.caseNumber ? ` (Case #${inlineBarcodeConflict.caseNumber})` : ""}.`}
                              </p>
                              <button
                                type="button"
                                className="text-xs text-muted-foreground underline hover:text-foreground transition-colors"
                                onClick={() => commitBarcodeEdit({ allowDuplicate: true })}
                              >
                                Save anyway
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={barcodeMutation.isPending}
                          onClick={() => {
                            if (barcodeMutation.isPending) return;
                            const current =
                              optimisticBarcode !== null
                                ? optimisticBarcode
                                : (data?.casePanBarcode ?? labCase.casePanBarcode ?? "");
                            setBarcodeEditValue(current);
                            setBarcodeEditMode(true);
                            setBarcodeError(null);
                            setTimeout(() => barcodeInlineInputRef.current?.focus(), 30);
                          }}
                          className="group flex items-center gap-1.5 text-sm font-mono mt-0.5 text-left w-full transition-colors min-h-[1.5rem] disabled:opacity-60 disabled:cursor-wait"
                          aria-label={
                            barcodeMutation.isPending
                              ? "Saving barcode"
                              : `Edit barcode ${optimisticBarcode ?? data?.casePanBarcode ?? labCase.casePanBarcode ?? ""}`.trim()
                          }
                          title={barcodeMutation.isPending ? "Saving…" : "Click to edit barcode"}
                        >
                          <span className={
                            (optimisticBarcode !== null ? optimisticBarcode : (data?.casePanBarcode ?? labCase.casePanBarcode))
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }>
                            {optimisticBarcode !== null
                              ? (optimisticBarcode || "—")
                              : (data?.casePanBarcode ?? labCase.casePanBarcode ?? "—")}
                          </span>
                          {barcodeMutation.isPending ? (
                            <Loader2 size={11} className="text-muted-foreground animate-spin shrink-0" />
                          ) : (
                            <Pencil
                              size={11}
                              className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            />
                          )}
                        </button>
                      )}
                      {barcodeError && (
                        <div className="mt-1 space-y-1">
                          <p className="text-xs text-destructive">{barcodeError}</p>
                          {barcodeConflictValue && (
                            <button
                              type="button"
                              className="text-xs text-muted-foreground underline hover:text-foreground transition-colors"
                              disabled={barcodeMutation.isPending}
                              onClick={() => {
                                setBarcodeError(null);
                                setOptimisticBarcode(barcodeConflictValue);
                                barcodeMutation.mutate({ value: barcodeConflictValue, allowDuplicate: true });
                              }}
                            >
                              Force-assign anyway (admin only)
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    </section>
                  </div>
                ) : (
                  <div
                    className="space-y-3"
                    data-testid="case-details-edit-form"
                    onPointerDownCapture={(e) => {
                      const tag = (e.target as HTMLElement).tagName;
                      if (!["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(tag)) {
                        setTimeout(() => barcodeScanInputRef.current?.focus(), 0);
                      }
                    }}
                  >
                    <section
                      aria-label="Patient & Provider"
                      data-testid="case-edit-patient-provider"
                      className="rounded-lg border border-border bg-secondary/20 p-3 space-y-3"
                    >
                    <h4 className="text-sm font-semibold">Patient &amp; Provider</h4>
                    <div className="grid grid-cols-1 gap-3 @[420px]/drawer:grid-cols-2">
                      <div>
                        <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                          First Name
                        </label>
                        <div className="mt-1">
                          <FieldCombobox
                            value={editForm.patientFirstName}
                            suggestions={patientFirstNames}
                            onChange={(v) => {
                              setEditForm((f) => ({ ...f, patientFirstName: v }));
                              setEditError(null);
                            }}
                            placeholder="Patient first name"
                            inputClassName="h-9 focus:ring-primary focus:border-primary"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                          Last Name
                        </label>
                        <div className="mt-1">
                          <FieldCombobox
                            value={editForm.patientLastName}
                            suggestions={patientLastNames}
                            onChange={(v) => {
                              setEditForm((f) => ({ ...f, patientLastName: v }));
                              setEditError(null);
                            }}
                            placeholder="Patient last name"
                            inputClassName="h-9 focus:ring-primary focus:border-primary"
                          />
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Practice
                      </label>
                      <div className="mt-1">
                        <ProviderPicker
                          value={editForm.providerOrganizationId}
                          providers={drawerProviderOrgs}
                          onChange={(id, org) => {
                            setEditForm((f) => ({
                              ...f,
                              providerOrganizationId: id,
                              doctorName: org?.displayName || org?.name || f.doctorName,
                            }));
                            setEditError(null);
                          }}
                          parentLabOrganizationId={
                            data?.labOrganizationId ??
                            labCase.labOrganizationId ??
                            undefined
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Doctor name
                      </label>
                      <div className="mt-1 w-96 max-w-full">
                        <DoctorNamePicker
                          value={editForm.doctorName}
                          onChange={(name) => {
                            setEditForm((f) => ({ ...f, doctorName: name }));
                            setEditError(null);
                          }}
                          doctorNames={effectiveDoctorNames}
                          placeholder="Select doctor…"
                        />
                      </div>
                    </div>
                    </section>
                    <section
                      aria-label="Schedule & Priority"
                      data-testid="case-edit-schedule-priority"
                      className="rounded-lg border border-border bg-secondary/20 p-3 space-y-3"
                    >
                    <h4 className="text-sm font-semibold">Schedule &amp; Priority</h4>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Date Received
                      </label>
                      <div className="mt-1 flex gap-1.5">
                        <input
                          type="date"
                          value={editForm.receivedAt}
                          onChange={(e) => {
                            setEditForm((f) => ({
                              ...f,
                              receivedAt: e.target.value,
                            }));
                            setEditError(null);
                          }}
                          className="w-36 max-w-full min-w-0 h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Due Date
                      </label>
                      <div className="mt-1 flex gap-1.5">
                        <input
                          type="date"
                          value={editForm.dueDate}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setEditForm((f) => ({
                              ...f,
                              dueDate: raw,
                              ...(raw ? {} : { dueTime: "" }),
                            }));
                            if (!raw) setEditHasDueTime(false);
                            setEditError(null);
                          }}
                          className="w-36 max-w-full min-w-0 h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      </div>
                      <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={editHasDueTime}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setEditHasDueTime(checked);
                            if (!checked) {
                              setEditForm((f) => ({ ...f, dueTime: "" }));
                            }
                            setEditError(null);
                          }}
                          disabled={!editForm.dueDate}
                          className="h-3.5 w-3.5 rounded border-border accent-primary disabled:cursor-not-allowed"
                          aria-label="Set a specific time the case is due"
                        />
                        <Clock size={13} aria-hidden="true" />
                        Set a specific time the case is due
                      </label>
                      {editHasDueTime && editForm.dueDate && (
                        <input
                          type="time"
                          value={editForm.dueTime}
                          onChange={(e) => {
                            setEditForm((f) => ({ ...f, dueTime: e.target.value }));
                            setEditError(null);
                          }}
                          aria-label="Due time (optional)"
                          className="mt-2 w-[7.5rem] h-9 px-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      )}
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Priority
                      </label>
                      <select
                        value={editForm.priority}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            priority: e.target.value as "normal" | "rush",
                          }))
                        }
                        className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                      >
                        <option value="normal">Normal</option>
                        <option value="rush">Rush</option>
                      </select>
                    </div>
                    </section>
                    <section
                      aria-label="Restoration Details"
                      data-testid="case-edit-restoration-details"
                      className="rounded-lg border border-border bg-secondary/20 p-3 space-y-3"
                    >
                    <h4 className="text-sm font-semibold">Restoration Details</h4>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Case Pan Barcode
                      </label>
                      <div className="relative mt-1">
                        <Barcode
                          size={15}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                        />
                        <input
                          ref={barcodeScanInputRef}
                          value={editForm.casePanBarcode}
                          onChange={(e) => {
                            setEditForm((f) => ({ ...f, casePanBarcode: e.target.value }));
                            setEditError(null);
                          }}
                          placeholder="Scan or type a barcode… (leave blank to clear)"
                          className="w-full h-9 pl-8 pr-2.5 rounded-md bg-secondary text-sm font-mono border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                      </div>
                      {editBarcodeChecking && (
                        <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                          <Loader2 size={11} className="animate-spin" /> Checking barcode…
                        </p>
                      )}
                      {!editBarcodeChecking && editBarcodeConflict && (
                        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                          <AlertTriangle size={11} />
                          {`This barcode is already used by an active case${editBarcodeConflict.caseNumber ? ` (Case #${editBarcodeConflict.caseNumber})` : ""}.`}
                        </p>
                      )}
                    </div>
                    <div className="border-t border-border pt-3">
                      <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
                        Clinical Details
                      </h4>
                      <div className="grid grid-cols-1 gap-3 @[420px]/drawer:grid-cols-2">
                        <div className="@[420px]/drawer:col-span-2">
                          <div className="mt-1">
                            {canEditClinicalHierarchy ? (
                              <CatalogRestorationPicker
                                labOrganizationId={labCase.labOrganizationId}
                                restorationType={editRxType}
                                material={editRxMaterial}
                                restorationSubtype={editRxSubtype}
                                fallbackMaterialSuggestions={materialSuggestions}
                                showFieldLabels
                                subtypeDetails={implantEditors}
                                onChange={(next) => {
                                  const representative =
                                    next.caseTypeKey
                                      ? CASE_TYPE_REPRESENTATIVE[next.caseTypeKey as CaseType]
                                      : editRxType;
                                  setEditRxType(next.restorationType || representative || "Other");
                                  setEditRxMaterial(next.material);
                                  setEditRxSubtype(next.restorationSubtype ?? null);
                                }}
                                inputClassName="h-9 focus:ring-primary focus:border-primary"
                              />
                            ) : (
                              <div className="grid grid-cols-1 gap-2 text-sm @[560px]/drawer:grid-cols-3">
                                <Field
                                  label="Case Type"
                                  value={
                                    editRxHierarchy.caseType
                                      ? CASE_TAXONOMY[editRxHierarchy.caseType].label
                                      : "—"
                                  }
                                />
                                <Field
                                  label="Subtype"
                                  value={
                                    editRxHierarchy.caseType && editRxHierarchy.subtype
                                      ? getSubtypeLabel(
                                          editRxHierarchy.caseType,
                                          editRxHierarchy.subtype,
                                        )
                                      : "—"
                                  }
                                />
                                <Field label="Case Material" value={editRxMaterial || "—"} />
                              </div>
                            )}
                            {!canEditClinicalHierarchy && implantEditors}
                          </div>
                        </div>
                        {showArchEditor && (
                          <div>
                            <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                              Arch
                            </label>
                            {canEditClinicalHierarchy ? (
                              <select
                                aria-label="Arch"
                                value={editRxArch}
                                onChange={(e) =>
                                  setEditRxArch(
                                    e.target.value as "" | "upper" | "lower" | "both",
                                  )
                                }
                                className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                              >
                                <option value="">Select arch…</option>
                                <option value="upper">Upper</option>
                                <option value="lower">Lower</option>
                                <option value="both">Upper + Lower</option>
                              </select>
                            ) : (
                              <p className="mt-1 text-sm">
                                {editRxArch === "both"
                                  ? "Upper + Lower"
                                  : editRxArch
                                    ? editRxArch === "upper" ? "Upper" : "Lower"
                                    : "—"}
                              </p>
                            )}
                          </div>
                        )}
                        {showStepEditor && (
                          <div>
                            <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                              Step
                            </label>
                            {canEditStep ? (
                              <select
                                aria-label="Step"
                                value={editRxStep}
                                onChange={(e) => setEditRxStep(e.target.value)}
                                className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                              >
                                <option value="">No step</option>
                                {STEP_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <p className="mt-1 text-sm">
                                {STEP_OPTIONS.find((option) => option.value === editRxStep)?.label || "—"}
                              </p>
                            )}
                          </div>
                        )}
                        {editRxStep === "wax_setup" && (
                          <div>
                            <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                              Wax Setup Shade
                            </label>
                            {canEditStep ? (
                              <FieldCombobox
                                value={editRxStepShade}
                                suggestions={shadeSuggestions}
                                onChange={setEditRxStepShade}
                                onCreate={(value) => createVocabItem("shade", value)}
                                placeholder="e.g. A2"
                                inputClassName="mt-1 h-9 focus:ring-primary focus:border-primary"
                              />
                            ) : (
                              <p className="mt-1 text-sm">{editRxStepShade || "—"}</p>
                            )}
                          </div>
                        )}
                        <div>
                          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                            Shade
                          </label>
                          {data?.viewerIsLabMember !== false ? (
                            <FieldCombobox
                              value={editRxShade}
                              suggestions={shadeSuggestions}
                              onChange={setEditRxShade}
                              onCreate={(value) => createVocabItem("shade", value)}
                              placeholder="e.g. A2"
                              addNewLabel="Add shade"
                              inputClassName="mt-1 h-9 focus:ring-primary focus:border-primary"
                            />
                          ) : (
                            <p className="mt-1 text-sm">{editRxShade || "—"}</p>
                          )}
                        </div>
                        <div>
                          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                            Tooth Numbers
                          </label>
                          {data?.viewerIsLabMember !== false ? (
                            <input
                              aria-label="Tooth Numbers"
                              value={editRxTeeth}
                              onChange={(e) => setEditRxTeeth(e.target.value)}
                              placeholder="e.g. 2, 4, 12"
                              className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                            />
                          ) : (
                            <p className="mt-1 text-sm">{editRxTeeth || "—"}</p>
                          )}
                        </div>
                        <div>
                          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                            Gingival Shade
                          </label>
                          <input
                            aria-label="Gingival Shade"
                            value={editForm.gingivialShade}
                            onChange={(e) =>
                              setEditForm((f) => ({ ...f, gingivialShade: e.target.value }))
                            }
                            placeholder="e.g. Light Pink"
                            className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                          />
                        </div>
                      </div>
                    </div>
                    </section>
                  </div>
                )}
              </section>

              {/* The Lab Slip carries one prescription section. Authored case
                  notes keep their own tab, history and visibility rules. */}
              <section aria-label="Rx Notes" className="mt-4 rounded-lg border border-border bg-secondary/20 p-3">
                <h4 className="text-sm font-semibold mb-2">Rx Notes</h4>
                {(() => {
                  const currentText =
                    pendingCaseEdit?.rxNotes ??
                    data?.caseNotes ??
                    labCase.caseNotes ??
                    "";
                  const savedEntries = data?.rxNoteEntries ?? labCase.rxNoteEntries ?? [];
                  const currentEntries = savedEntries.filter(
                    (entry) => entry.caseId === labCase.id,
                  );
                  const needsCurrentEntry =
                    currentEntries.length === 0 && (currentText.trim() || editMode);
                  const currentEntryId =
                    currentEntries.at(-1)?.id ??
                    (needsCurrentEntry ? `legacy-${labCase.id}` : null);
                  const entries = needsCurrentEntry
                    ? [
                        ...savedEntries,
                        {
                          id: `legacy-${labCase.id}`,
                          caseId: labCase.id,
                          noteText: currentText,
                          scannedAt: null,
                          provenance: "legacy" as const,
                        },
                      ]
                    : savedEntries;
                  if (entries.length === 0) return <p className="text-sm">—</p>;
                  return (
                    <div className="space-y-2">
                      {entries.map((entry) => {
                        const active = entry.id === currentEntryId;
                        const text = editMode && active
                          ? editForm.rxNotes
                          : !editMode && active
                            ? (pendingCaseEdit?.rxNotes ?? entry.noteText)
                            : entry.noteText;
                        return (
                          <div
                            key={entry.id}
                            className="grid grid-cols-[76px_minmax(0,1fr)] gap-2 items-start text-sm"
                          >
                            <span className="text-[11px] leading-5 text-muted-foreground whitespace-nowrap">
                              {formatRxNoteScanDate(entry.scannedAt)}
                            </span>
                            {editMode && active ? (
                              <textarea
                                aria-label="Prescription notes"
                                value={text}
                                onChange={(e) =>
                                  setEditForm((f) => ({ ...f, rxNotes: e.target.value }))
                                }
                                rows={3}
                                placeholder="Prescription notes…"
                                className="w-full min-w-0 px-2.5 py-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y"
                              />
                            ) : (
                              <p className="min-w-0 whitespace-pre-wrap break-words">
                                {text || "—"}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </section>

              {/* Rx summary — at-a-glance view of what the lab is being asked
                  to make, derived from the case's restorations. */}
              {(() => {
                const highlightValue = buildHighlightedToothValue(summary);
                const caseIsRemovable =
                  (data?.restorations ?? []).length > 0 &&
                  (data?.restorations ?? []).every((r) =>
                    isRemovableRestorationType(r.restorationType),
                  );
                return (
                  <section>
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
                      Rx Summary
                    </h3>
                    {(
                      <div className="space-y-3">
                        {(
                          <CaseChartPanes
                            label="Rx summary: case details, chart and restorations"
                            details={<CaseDetailsList rows={[
                              ["Case", labCase.caseNumber],
                              ["Patient", `${pendingCaseEdit?.patientFirstName ?? data?.patientFirstName ?? labCase.patientFirstName} ${pendingCaseEdit?.patientLastName ?? data?.patientLastName ?? labCase.patientLastName}`.trim()],
                              ["Doctor", pendingCaseEdit?.doctorName ?? data?.doctorName ?? labCase.doctorName],
                              ["Due", formatDueDate(labCase.dueDate, labCase.dueTime)],
                            ]} />}
                            chart={<div>
                          {savedChartToolbar}
                          <ToothChart
                            assignments={connectorUnits}
                            onArchSelect={(arch, teeth) => {
                              setToothMultiSelect(true); setToothSelectedTargets(teeth);
                              setToothSelectionAnchor(teeth[0]); setToothDialogId(null);
                              setToothCopyMessage(`${arch === "upper" ? "Upper" : "Lower"} arch selected. Selection alone changes neither assignments nor billing.`);
                            }}
                            value={toothMultiSelect ? toothSelectedTargets.join(", ") : toothDialogId ?? ""}
                            onChange={() => {}}
                            onToothClick={handleSavedChartTooth}
                            onConnectedPairsChange={handleConnectedPairsChange}
                            showPrimary={false}
                            crownTeeth={crownTeeth}
                            ponticTeeth={ponticTeeth}
                            veneerTeeth={veneerTeeth}
                            missingTeeth={missingTeethIds}
                            connectedPairs={effectiveConnectedPairs}
                            connectorSuggestions={stagedConnectorState.suggested}
                            connectorIssue={connectorSaveError ?? (connectorValidation.valid ? null : connectorValidation.errors[0])}
                          />
                            </div>}
                            summary={<RestorationSummaryPane
                              headline={`${assignmentSummary.units} units · ${assignmentSummary.crowns} prepared crowns · ${assignmentSummary.pontics} pontics${assignmentSummary.veneers ? ` · ${assignmentSummary.veneers} veneer${assignmentSummary.veneers === 1 ? "" : "s"}` : ""}`}
                              bridgeLabels={toothBridgeLabels(connectorUnits, stagedConnectorString)}
                              rows={connectorUnits}
                            />}
                          />
                        )}
                      </div>
                    )}
                  </section>
                );
              })()}

              {/* ── QR code ── */}
              {(() => {
                const caseQrUrl = `${window.location.origin}/cases/${labCase.caseNumber}`;
                return (
                  <section className="border border-border rounded-lg p-4 flex items-start gap-4">
                    <div className="shrink-0 bg-white p-1.5 rounded border border-border">
                      <QRCodeSVG value={caseQrUrl} size={96} level="M" />
                    </div>
                    <div className="flex flex-col gap-2 min-w-0">
                      <div>
                        <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
                          <QrCode size={12} className="text-muted-foreground" />
                          Case QR Code
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                          Scan to open this case in LabTrax. Works with the mobile app or any camera.
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[220px]">
                          {caseQrUrl}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(caseQrUrl).catch(() => {});
                            setQrLinkCopied(true);
                            setTimeout(() => setQrLinkCopied(false), 2000);
                          }}
                          className="h-6 px-2 rounded text-[11px] font-medium inline-flex items-center gap-1 border border-border bg-card hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          title="Copy case link"
                        >
                          {qrLinkCopied ? <Check size={11} className="text-green-600" /> : <Copy size={11} />}
                          {qrLinkCopied ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  </section>
                );
              })()}
            </div>
            );
          })()}

          {/* ── RESTORATIONS ── */}
          {activeTab === "restorations" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Restorations
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      printTabContent({
                        labCase: data ?? labCase,
                        tab: "restorations",
                        restorations: data?.restorations ?? [],
                        attachments: data?.attachments ?? [],
                        notes: data?.notes ?? [],
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Print restorations"
                  >
                    <Printer size={12} />
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddRest((v) => !v); setRestError(null); }}
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus size={12} />
                    {showAddRest ? "Cancel" : "Add manually"}
                  </button>
                </div>
              </div>

              {/* Interactive chart — primary entry point for the click-driven workflow. */}
              {savedChartToolbar}
              <CaseChartPanes
                label="Restorations: case details, chart and summary"
                details={<CaseDetailsList rows={[
                  ["Case", labCase.caseNumber],
                  ["Patient", `${data?.patientFirstName ?? labCase.patientFirstName} ${data?.patientLastName ?? labCase.patientLastName}`.trim()],
                  ["Doctor", data?.doctorName ?? labCase.doctorName],
                  ["Due", formatDueDate(data?.dueDate ?? labCase.dueDate, labCase.dueTime)],
                ]} />}
                chart={
              <ToothChart
                assignments={connectorUnits}
                onArchSelect={(arch, teeth) => {
                  setToothMultiSelect(true); setToothSelectedTargets(teeth);
                  setToothSelectionAnchor(teeth[0]); setToothDialogId(null);
                  setToothCopyMessage(`${arch === "upper" ? "Upper" : "Lower"} arch selected. Selection alone changes neither assignments nor billing.`);
                }}
                value={toothMultiSelect ? toothSelectedTargets.join(", ") : toothDialogId ?? ""}
                onChange={() => {}}
                billedTeeth={billedTeeth}
                billedTeethTypes={billedTeethTypes}
                onToothClick={handleSavedChartTooth}
                connectedPairs={effectiveConnectedPairs}
                connectorSuggestions={stagedConnectorState.suggested}
                connectorIssue={
                  connectorSaveError ??
                  (connectorValidation.valid
                    ? assignmentSummary.unresolvedPontics.length
                      ? `Review unconnected pontics: ${assignmentSummary.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")}.`
                      : null
                    : connectorValidation.errors[0])
                }
                summaryText={`${assignmentSummary.units} units · ${assignmentSummary.groups.length} connected groups · ${assignmentSummary.materials.map(({ material, count }) => `${material}: ${count}`).join(", ")} · ${hasPendingChanges ? "Unsaved changes" : "Saved"}`}
                onConnectedPairsChange={handleConnectedPairsChange}
                crownTeeth={crownTeeth}
                ponticTeeth={ponticTeeth}
                veneerTeeth={veneerTeeth}
                missingTeeth={missingTeethIds}
              />
                }
                summary={<RestorationSummaryPane
                  headline={`${assignmentSummary.units} units · ${assignmentSummary.crowns} prepared crowns · ${assignmentSummary.pontics} pontics${assignmentSummary.veneers ? ` · ${assignmentSummary.veneers} veneer${assignmentSummary.veneers === 1 ? "" : "s"}` : ""} · ${hasPendingChanges ? "Unsaved changes" : "Saved"}`}
                  bridgeLabels={toothBridgeLabels(connectorUnits, stagedConnectorString)}
                  rows={connectorUnits}
                  warning={connectorSaveError ?? (connectorValidation.valid ? null : connectorValidation.errors[0])}
                />}
              />

              {showAddRest && (
                <div className="border border-border rounded-lg p-4 space-y-3 bg-secondary/20">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    New restoration (manual entry)
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {!isRemovableRestorationType(restForm.restorationType) && (
                      <div>
                        <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                          Tooth # / Range
                        </label>
                        <input
                          placeholder="e.g. 14 or 14-16"
                          value={restForm.toothNumber}
                          onChange={(e) => setRestForm((f) => ({ ...f, toothNumber: e.target.value }))}
                          className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="mt-2">
                          <ToothChart
                            value={restForm.toothNumber}
                            onChange={(next) =>
                              setRestForm((f) => ({ ...f, toothNumber: next }))
                            }
                            billedTeeth={billedTeeth}
                            billedTeethTypes={billedTeethTypes}
                          />
                        </div>
                      </div>
                    )}
                    <div className={isRemovableRestorationType(restForm.restorationType) ? "col-span-2" : ""}>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Quantity
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={restForm.quantity}
                        onChange={(e) =>
                          setRestForm((f) => ({
                            ...f,
                            quantity: Math.max(1, Number(e.target.value) || 1),
                          }))
                        }
                        className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                      Case Type → Subtype → Material *
                    </label>
                    <div className="mt-1">
                      <CatalogRestorationPicker
                        labOrganizationId={labCase.labOrganizationId}
                        restorationType={restForm.restorationType}
                        material={restForm.material}
                        restorationSubtype={restForm.restorationSubtype}
                        implantDetails={restForm}
                        onImplantChange={(details) => setRestForm((f) => ({ ...f, implantRetention: details.implantRetention ?? null, implantManufacturer: details.implantManufacturer ?? null, implantPlatformNotes: details.implantPlatformNotes ?? null }))}
                        onChange={(next) => {
                          const price = lookupBillablePrice(next.restorationType);
                          setRestForm((f) => ({
                            ...f,
                            restorationType: next.restorationType,
                            material: next.material,
                            restorationSubtype: next.restorationSubtype ?? null,
                            unitPrice: price || f.unitPrice,
                            ...(isRemovableRestorationType(next.restorationType)
                              ? { toothNumber: "" }
                              : {}),
                          }));
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Shade
                      </label>
                      <div className="mt-1">
                        <FieldCombobox
                          value={restForm.shade}
                          suggestions={shadeSuggestions}
                          onChange={(s) => setRestForm((f) => ({ ...f, shade: s }))}
                          onCreate={(v) => createVocabItem("shade", v)}
                          placeholder="None"
                          addNewLabel="Add shade"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                      Unit Price ($) — leave blank to auto-look up from pricing
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="Auto"
                      value={restForm.unitPrice}
                      onChange={(e) => setRestForm((f) => ({ ...f, unitPrice: e.target.value }))}
                      className="mt-1 w-full h-8 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
              )}

              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && restorationCount === 0 && pendingCreates.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  No restorations yet. Use "Add restoration" to add one.
                </div>
              )}
              <div className="space-y-2">
                {data?.restorations?.filter(isImplantRestoration).map((r) => <SavedImplantDetails key={`implant-${r.id}`} row={r} caseId={labCase.id} canEdit={user?.userType !== "provider" && data?.viewerIsLabMember !== false} />)}
                {data?.restorations?.map((r) => (
                  <RestorationRow
                    key={r.id}
                    restoration={r}
                    caseId={labCase.id}
                    labOrganizationId={labCase.labOrganizationId}
                    discountBaseTierName={
                      discountBaseTierByKey.get(r.priceKey ?? "") ?? null
                    }
                    isPendingDelete={pendingDeletes.has(r.id)}
                    canEditPrice={isAdmin}
                    onPendingDelete={() => {
                      setPendingDeletes((prev) => {
                        const next = new Set(prev);
                        next.add(r.id);
                        return next;
                      });
                    }}
                    onUndoPendingDelete={() => {
                      setPendingDeletes((prev) => {
                        const next = new Set(prev);
                        next.delete(r.id);
                        return next;
                      });
                    }}
                  />
                ))}
                {pendingCreates.map((c) => (
                  <PendingRestorationRow
                    key={c.localId}
                    pending={c}
                    onRemove={() =>
                      setPendingCreates((prev) => prev.filter((p) => p.localId !== c.localId))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── NOTES ── */}
          {activeTab === "notes" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Notes
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    printTabContent({
                      labCase: data ?? labCase,
                      tab: "notes",
                      restorations: data?.restorations ?? [],
                      attachments: data?.attachments ?? [],
                      notes: data?.notes ?? [],
                    })
                  }
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  title="Print notes"
                >
                  <Printer size={12} />
                  Print
                </button>
              </div>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              <div className="space-y-2">
                {!isLoading && noteCount === 0 && (
                  <div className="text-sm text-muted-foreground">No notes yet.</div>
                )}
                {data?.notes?.map((n) => (
                  <div key={n.id} className="border border-border rounded-md px-3 py-2.5 text-sm">
                    <p className="leading-relaxed whitespace-pre-wrap">{n.noteText || "—"}</p>
                    <div className="flex items-center flex-wrap gap-2 mt-1.5">
                      {n.visibility === "internal_lab_only" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                          <Lock size={9} /> Lab only
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                          Shared
                        </span>
                      )}
                      {n.authorName && (
                        <span className="text-[11px] font-medium text-foreground">
                          {n.authorName}
                        </span>
                      )}
                      {n.createdAt && (
                        <span className="text-[11px] text-muted-foreground">
                          · {relativeTime(n.createdAt)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {data?.viewerCanPostNotes && (
                <NoteComposer
                  noteText={noteText}
                  setNoteText={setNoteText}
                  setNoteError={setNoteError}
                  noteError={noteError ?? null}
                  shareWithProvider={shareWithProvider}
                  setShareWithProvider={setShareWithProvider}
                  isListeningNote={isListeningNote}
                  startNoteListening={startNoteListening}
                  stopNoteListening={stopNoteListening}
                  isPending={addNoteMutation.isPending}
                  onSubmit={() => addNoteMutation.mutate({ text: noteText, shared: shareWithProvider })}
                  orgId={
                    data?.viewerQuickReferenceOrganizationId ??
                    data?.labOrganizationId ??
                    null
                  }
                />
              )}

              {/* ── NOTIFY MODAL ── */}
              {notifyModal.open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!notifyModal.sending) setNotifyModal((m) => ({ ...m, open: false })); }}>
                  <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-sm mx-4 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold">Notify provider?</h3>
                      <button type="button" onClick={() => { if (!notifyModal.sending) setNotifyModal((m) => ({ ...m, open: false })); }} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                        <X size={16} />
                      </button>
                    </div>

                    {notifyModal.step === "choose" && notifyModal.method === null && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">The note was shared with the provider. How would you like to notify them?</p>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            disabled={notifyModal.sending}
                            onClick={() => void sendNoteNotification(notifyModal.noteId, "email")}
                            className="w-full h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {notifyModal.sending ? <Loader2 size={13} className="animate-spin mx-auto" /> : "Email"}
                          </button>
                          <button
                            type="button"
                            disabled={notifyModal.sending}
                            onClick={() => void sendNoteNotification(notifyModal.noteId, "sms")}
                            className="w-full h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {notifyModal.sending ? <Loader2 size={13} className="animate-spin mx-auto" /> : "Text message"}
                          </button>
                          <button
                            type="button"
                            disabled={notifyModal.sending}
                            onClick={() => void sendNoteNotification(notifyModal.noteId, "labtrax_only")}
                            className="w-full h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors disabled:opacity-50"
                          >
                            {notifyModal.sending ? <Loader2 size={13} className="animate-spin mx-auto" /> : "Share through LabTrax only"}
                          </button>
                        </div>
                        {notifyModal.error && <p className="text-xs text-destructive">{notifyModal.error}</p>}
                        <button type="button" onClick={() => setNotifyModal((m) => ({ ...m, open: false }))} className="text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center">Skip for now</button>
                      </div>
                    )}

                    {notifyModal.step === "choose" && notifyModal.method !== null && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">The note was shared with the provider. Send a notification?</p>
                        <button
                          type="button"
                          disabled={notifyModal.sending}
                          onClick={() => void sendNoteNotification(notifyModal.noteId, notifyModal.method!)}
                          className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
                        >
                          {notifyModal.sending ? <Loader2 size={13} className="animate-spin" /> : notifyModal.method === "email" ? "Send email" : notifyModal.method === "sms" ? "Send text message" : "Share through LabTrax"}
                        </button>
                        {notifyModal.error && <p className="text-xs text-destructive">{notifyModal.error}</p>}
                        <button
                          type="button"
                          onClick={() => setNotifyModal((m) => ({ ...m, method: null, error: null }))}
                          className="text-xs text-primary hover:underline w-full text-center"
                        >
                          Change notification method
                        </button>
                        <button type="button" onClick={() => setNotifyModal((m) => ({ ...m, open: false }))} className="text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center">Skip for now</button>
                      </div>
                    )}

                    {notifyModal.step === "confirm_save" && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          <Check size={12} className="inline text-green-600 mr-1" />
                          {notifyModal.method === "email" ? "Email sent." : notifyModal.method === "sms" ? "Text message sent." : "In-app notification sent."} Save this as your default notification method?
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              localStorage.setItem(COMM_PREF_KEY, notifyModal.method!);
                              setNotifyModal((m) => ({ ...m, open: false }));
                            }}
                            className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setNotifyModal((m) => ({ ...m, open: false }))}
                            className="flex-1 h-9 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium transition-colors"
                          >
                            No
                          </button>
                        </div>
                      </div>
                    )}

                    {notifyModal.step === "success" && (
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          <Check size={12} className="inline text-green-600 mr-1" />
                          {notifyModal.method === "email" ? "Email sent." : notifyModal.method === "sms" ? "Text message sent." : "In-app notification sent."}
                        </p>
                        <button
                          type="button"
                          onClick={() => setNotifyModal((m) => ({ ...m, method: null, step: "choose", error: null }))}
                          className="text-xs text-primary hover:underline w-full text-center"
                        >
                          Change notification method
                        </button>
                        <button type="button" onClick={() => setNotifyModal((m) => ({ ...m, open: false }))} className="w-full h-8 rounded-md border border-border bg-secondary hover:bg-secondary/80 text-sm transition-colors">Close</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── FILES ── */}
          {activeTab === "files" && (
            <div
              className="relative px-5 py-5 space-y-4"
              onDragEnter={labCase._source !== "mobile" ? handleFileDragEnter : undefined}
              onDragLeave={labCase._source !== "mobile" ? handleFileDragLeave : undefined}
              onDragOver={labCase._source !== "mobile" ? handleFileDragOver : undefined}
              onDrop={labCase._source !== "mobile" ? handleFileDrop : undefined}
            >
              {fileDragOver && labCase._source !== "mobile" && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-primary/8 pointer-events-none">
                  <FileUp size={24} className="text-primary" />
                  <p className="text-sm font-medium text-primary">Drop to attach files</p>
                </div>
              )}
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Attachments
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      printTabContent({
                        labCase: data ?? labCase,
                        tab: "files",
                        restorations: data?.restorations ?? [],
                        attachments: data?.attachments ?? [],
                        notes: data?.notes ?? [],
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Print file list"
                  >
                    <Printer size={12} />
                    Print
                  </button>
                  {labCase._source !== "mobile" && data?.viewerCanUploadAttachments && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingFile}
                      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
                    >
                      {uploadingFile ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />}
                      {uploadingFile ? "Uploading…" : "Attach file"}
                    </button>
                  )}
                </div>
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
              {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
              {labCase._source === "mobile" && (
                <p className="text-xs text-muted-foreground">
                  This case was created in the mobile app. File attachments can be added from the mobile app.
                </p>
              )}
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && fileCount === 0 && !uploadingFile && labCase._source !== "mobile" && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex flex-col items-center justify-center gap-2 py-10 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer text-center"
                >
                  <FileUp size={28} className="text-muted-foreground/50" />
                  <p className="text-sm font-medium text-muted-foreground">Drop files here or click to attach</p>
                  <p className="text-xs text-muted-foreground/60">Any file type supported</p>
                </button>
              )}
              {!isLoading && (
                <div className="space-y-2" data-testid="attachment-sections">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-section bg-secondary/20 px-3 py-2">
                    <button
                      type="button"
                      onClick={toggleAllAttachmentSections}
                      className="inline-flex items-center gap-1.5 text-xs font-medium hover:text-primary"
                    >
                      <ChevronDown
                        size={14}
                        className={`transition-transform ${
                          Object.values(attachmentSectionsExpanded).every(Boolean)
                            ? "rotate-180"
                            : ""
                        }`}
                      />
                      {Object.values(attachmentSectionsExpanded).every(Boolean)
                        ? "Collapse all"
                        : "Expand all"}
                    </button>
                    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        aria-label="Save all section preferences"
                        checked={attachmentSectionSave.all}
                        onChange={(event) =>
                          setAttachmentSavePreference("all", event.target.checked)
                        }
                      />
                      Save preference
                    </label>
                  </div>
                  {([
                    ["media", "Images/videos"],
                    ["documents", "Documents"],
                    ["files", "Files"],
                  ] as const).map(([section, label]) => {
                    const attachments = groupedCaseAttachments[section];
                    const expanded = attachmentSectionsExpanded[section];
                    const contentId = `case-${labCase.id}-attachments-${section}`;
                    return (
                      <section
                        key={section}
                        className="rounded-md border border-section"
                        data-testid={`attachment-section-${section}`}
                      >
                        <div className="flex items-center justify-between gap-3 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => toggleAttachmentSection(section)}
                            aria-expanded={expanded}
                            aria-controls={contentId}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium hover:text-primary"
                          >
                            <ChevronDown
                              size={14}
                              className={`shrink-0 transition-transform ${
                                expanded ? "rotate-180" : ""
                              }`}
                            />
                            <span>{label}</span>
                            <span className="text-xs font-normal text-muted-foreground">
                              ({attachments.length})
                            </span>
                          </button>
                          <label className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              aria-label={`Save ${label} preference`}
                              checked={attachmentSectionSave[section]}
                              onChange={(event) =>
                                setAttachmentSavePreference(section, event.target.checked)
                              }
                            />
                            Save preference
                          </label>
                        </div>
                        {expanded && (
                          <div id={contentId} className="space-y-2 border-t border-section p-2">
                            {attachments.map((attachment) => (
                              <AttachmentRow
                                key={attachment.id}
                                caseId={labCase.id}
                                attachment={attachment}
                                canManage={!!data?.viewerCanManageAttachments}
                                onAttachmentClick={(selected) =>
                                  openCaseAttachment(selected)
                                }
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
              {!isLoading && !!data?.viewerCanUploadAttachments && fileCount > 0 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={handleFileDragEnter}
                  onDragLeave={handleFileDragLeave}
                  onDragOver={handleFileDragOver}
                  onDrop={handleFileDrop}
                  className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed transition-colors cursor-pointer text-center ${
                    fileDragOver
                      ? "border-primary bg-primary/8 text-primary"
                      : "border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <FileUp size={14} className={fileDragOver ? "text-primary" : "text-muted-foreground/60"} />
                  <span className="text-xs font-medium">Drop files here or click to browse</span>
                </button>
              )}
            </div>
          )}

          {/* ── INVOICE ── */}
          {activeTab === "invoice" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Invoice
                </h3>
                {caseInvoice && !canEditCaseInvoice && (
                  <button
                    type="button"
                    disabled={invoiceDetailQuery.isLoading || invoiceDetailQuery.isError}
                    onClick={() => {
                      const lc = data ?? labCase;
                      const inv = invoiceDetailQuery.data ?? caseInvoice;
                      const dm = inv.displayMetadata ?? inv.displayMetadataJson;
                      const opts: InvoicePdfOptions = {
                        invoiceNumber: inv.invoiceNumber,
                        labName: inv.labOrganization?.name ?? caseInvoice.labOrganization?.name ?? "",
                        practiceName: inv.providerOrganization?.name ?? caseInvoice.providerOrganization?.name ?? "",
                        patientName: dm?.patientName ?? (`${lc.patientFirstName ?? ""} ${lc.patientLastName ?? ""}`.trim() || null),
                        billTo: dm?.billTo ?? inv.providerOrganization?.name ?? null,
                        teeth: dm?.teeth ?? lc.teeth ?? null,
                        shade: dm?.shade ?? null,
                        material: dm?.material ?? null,
                        caseNotes: dm?.caseNotes ?? lc.caseNotes ?? null,
                        issuedAt: inv.issuedAt ?? null,
                        dueAt: inv.dueAt ?? inv.dueDate ?? null,
                        status: inv.status,
                        items: (invoiceDetailQuery.data?.items ?? []).map((it, index) => ({
                          item: dm?.lineItems?.[index]?.item,
                          toothNumber: it.toothNumber,
                          toothLabel: it.toothLabel,
                          isDiscount: it.isDiscount,
                          description: it.description,
                          quantity: it.quantity,
                          unitPrice: it.unitPrice,
                          lineTotal: it.lineTotal,
                          subItems: (it.subItems ?? []).map((sub, subIndex) => ({
                            item: dm?.lineItems?.[index]?.subItems?.[subIndex]?.item,
                            toothNumber: sub.toothNumber,
                            toothLabel: sub.toothLabel,
                            isDiscount: sub.isDiscount,
                            description: sub.description,
                            quantity: sub.quantity,
                            unitPrice: sub.unitPrice,
                            lineTotal: sub.lineTotal,
                          })),
                        })),
                        subtotal: inv.subtotal ?? 0,
                        tax: inv.tax,
                        discount: inv.discount,
                        credits: dm?.credits,
                        total: inv.total ?? 0,
                        balanceDue: inv.balanceDue ?? null,
                        notes: inv.notes ?? null,
                        generatedAt: new Date(),
                        logoUrl: invoicePrintLogoDataUrl,
                        logoPdfSize: (user?.practiceLogoSize as "small" | "medium" | "large" | null) ?? null,
                        caseNumber: lc.caseNumber ?? null,
                        qrCodeDataUrl: invoicePrintQrDataUrl,
                        template: confirmedInvoiceTemplate,
                        extraImageDataUrls: confirmedInvoiceImages,
                      };
                      printInvoicePdf(opts);
                    }}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Print invoice"
                  >
                    <Printer size={12} />
                    Print
                  </button>
                )}
              </div>
              {invoiceQuery.isLoading ? (
                <div className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" />
                  Loading…
                </div>
              ) : invoiceQuery.isError ? (
                <div role="alert" className="text-sm text-destructive">Could not load the case invoice. <button type="button" onClick={() => void invoiceQuery.refetch()}>Retry</button></div>
              ) : caseInvoice && canEditCaseInvoice && !viewingInvoice ? (
                <InlineInvoiceEditor
                  key={caseInvoice.id}
                  invoice={caseInvoice}
                  doctorNames={doctorNames}
                  onClose={handleCloseWithGuard}
                  onOpenEditor={() => setViewingInvoice(caseInvoice)}
                />
              ) : caseInvoice ? (
                <div className="border border-border rounded-lg p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{caseInvoice.invoiceNumber}</span>
                      <StatusBadge status={caseInvoice.status} />
                    </div>
                    <button
                      type="button"
                      onClick={() => setViewingInvoice(caseInvoice)}
                      className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-1.5"
                    >
                      <ReceiptText size={13} />
                      Open in editor
                    </button>
                  </div>
                  {hasUnpricedAlloyLines && (
                    <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-300/60 dark:border-amber-700/40 text-amber-700 dark:text-amber-400 text-xs">
                      <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                      <span>
                        <span className="font-semibold">Alloy line unpriced</span>
                        {" — open in editor to set the alloy unit price before sending this invoice."}
                      </span>
                    </div>
                  )}
                  {invoiceDetailQuery.isLoading ? (
                    <div className="text-sm text-muted-foreground flex items-center gap-1.5">
                      <Loader2 size={13} className="animate-spin" />
                      Loading line items…
                    </div>
                  ) : invoiceDetailQuery.isError ? (
                    <div role="alert" className="text-sm text-destructive">Could not load invoice line items. <button type="button" onClick={() => void invoiceDetailQuery.refetch()}>Retry</button></div>
                  ) : (invoiceDetailQuery.data?.items?.length ?? 0) > 0 ? (
                    <div className="border border-border rounded-md overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th className="text-left font-medium px-3 py-1.5">Description</th>
                            <th className="text-right font-medium px-3 py-1.5 w-12">Qty</th>
                            <th className="text-right font-medium px-3 py-1.5 w-24">Unit price</th>
                            <th className="text-right font-medium px-3 py-1.5 w-24">Line total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(invoiceDetailQuery.data?.items ?? []).flatMap((it, idx) => [
                            <tr key={idx} className="border-t border-border">
                              <td className="px-3 py-1.5">{it.description || "—"}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{Number(it.quantity)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(it.unitPrice)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(it.lineTotal)}</td>
                            </tr>,
                            ...((it as any).subItems ?? []).map((sub: any, sidx: number) => (
                              <tr key={`${idx}-sub-${sidx}`} className="border-t border-border bg-muted/10">
                                <td className="pl-7 pr-3 py-1 text-sm text-muted-foreground">{sub.description || "—"}</td>
                                <td className="px-3 py-1 text-right tabular-nums text-sm text-muted-foreground">{Number(sub.quantity)}</td>
                                <td className="px-3 py-1 text-right tabular-nums text-sm text-muted-foreground">{formatMoney(sub.unitPrice)}</td>
                                <td className="px-3 py-1 text-right tabular-nums text-sm text-muted-foreground">{formatMoney(sub.lineTotal)}</td>
                              </tr>
                            )),
                          ])}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No line items on this invoice.</p>
                  )}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Field label="Total" value={formatMoney(caseInvoice.total)} />
                    <Field label="Balance due" value={formatMoney(caseInvoice.balanceDue)} />
                    {caseInvoice.issuedAt && (
                      <Field label="Issued" value={formatDate(caseInvoice.issuedAt)} />
                    )}
                    {caseInvoice.dueDate && (
                      <Field label="Due" value={formatDate(caseInvoice.dueDate)} />
                    )}
                  </div>
                  {(invoiceDetailQuery.data?.payments?.length ?? 0) > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                        Payments received
                      </h4>
                      <div className="border border-border rounded-md overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                              <th className="text-left font-medium px-3 py-1.5">Date</th>
                              <th className="text-left font-medium px-3 py-1.5">Method</th>
                              <th className="text-right font-medium px-3 py-1.5 w-24">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {invoiceDetailQuery.data!.payments!.map((p) => {
                              const rawMethod = p.paymentMethod ?? p.method ?? "";
                              const method = (PAYMENT_METHOD_LABELS[rawMethod] ?? rawMethod) || "—";
                              const ref = (p.referenceNumber ?? p.reference)?.trim();
                              return (
                                <tr key={p.id} className="border-t border-border">
                                  <td className="px-3 py-1.5">{formatDate(p.paidAt)}</td>
                                  <td className="px-3 py-1.5">
                                    {method}
                                    {ref && (
                                      <span className="text-muted-foreground"> · {ref}</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(p.amount)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    No invoice has been generated for this case yet.
                  </p>
                  {generatePresets.length > 0 && (
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">
                        Layout preset <span className="font-normal">(optional)</span>
                      </label>
                      <select
                        value={generatePresetId}
                        onChange={(e) => setGeneratePresetId(e.target.value)}
                        disabled={generatingInvoice}
                        className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
                      >
                        <option value="">Default layout</option>
                        {generatePresets.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={!hasRestorations || generatingInvoice || isLoading}
                    onClick={handleGenerateInvoice}
                    className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-secondary hover:bg-secondary/80 text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {generatingInvoice ? <Loader2 size={13} className="animate-spin" /> : <ReceiptText size={14} />}
                    {generatingInvoice ? "Generating…" : "Generate Invoice"}
                  </button>
                  {!isLoading && !hasRestorations && (
                    <p className="text-xs text-muted-foreground">
                      Add restorations in the Restorations tab first — invoices are generated from restoration line items.
                    </p>
                  )}
                  {invError && <p className="text-xs text-destructive">{invError}</p>}
                </div>
              )}
            </div>
          )}

          {/* ── HISTORY ── */}
          {activeTab === "history" && (
            <div className="px-5 py-5">
              {(() => {
                const histSummary = deriveRxSummary(data?.restorations);
                const histPatient = `${data?.patientFirstName ?? labCase.patientFirstName ?? ""} ${data?.patientLastName ?? labCase.patientLastName ?? ""}`.trim();
                const histDoctor = data?.doctorName ?? labCase.doctorName ?? "";
                const histMaterial = histSummary.materials.length > 0 ? histSummary.materials.join(", ") : "—";
                const histShade = histSummary.shades.length > 0 ? histSummary.shades.join(", ") : "—";
                const histTeeth = formatRxTeethWithShades(data?.restorations, formatRxTeethLabel(histSummary)) || "—";
                const histRxNotes = (data?.caseNotes ?? labCase.caseNotes ?? "") || "—";
                return (
                  <section className="mb-5 rounded-lg border border-border bg-secondary/20 px-4 py-3">
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
                      Rx Summary
                    </h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <Field label="Patient" value={histPatient || "—"} />
                      <Field label="Doctor" value={histDoctor || "—"} />
                      <Field label="Restorative type" value={histSummary.restorativeType ?? "—"} />
                      <Field label={histSummary.materials.length > 1 ? "Materials" : "Material"} value={histMaterial} />
                      <Field label={histSummary.shades.length > 1 ? "Shades" : "Shade"} value={histShade} />
                      <Field label={histSummary.isFullArch ? "Tooth coverage" : "Tooth number(s)"} value={histTeeth} />
                      <div className="col-span-2">
                        <Field label="Rx notes" value={histRxNotes} />
                      </div>
                    </div>
                  </section>
                );
              })()}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Case History
                </h3>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setHistorySortOrder((o) => (o === "asc" ? "desc" : "asc"))
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title={
                      historySortOrder === "asc"
                        ? "Showing oldest first — click for newest first"
                        : "Showing newest first — click for oldest first"
                    }
                  >
                    {historySortOrder === "asc" ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    )}
                    {historySortOrder === "asc" ? "Oldest first" : "Newest first"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      printCaseHistory(data ?? labCase, [
                        ...(data?.originalCaseEvents ?? []),
                        ...(data?.events ?? []),
                        ...(data?.remakeChildrenEvents?.flatMap((rc) => rc.events) ?? []),
                      ])
                    }
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Print case history"
                  >
                    <Printer size={12} />
                    Print history
                  </button>
                </div>
              </div>
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && (data?.events?.length ?? 0) === 0 && (data?.originalCaseEvents?.length ?? 0) === 0 && (data?.remakeChildrenEvents?.every((rc) => rc.events.length === 0) ?? true) && (
                <div className="text-sm text-muted-foreground">No activity logged yet.</div>
              )}
              {(() => {
                const hasOriginalEvents = (data?.originalCaseEvents?.length ?? 0) > 0;

                type TaggedEvent = CaseEvent & {
                  _source: "original" | "remake" | "child";
                  _sourceCaseNumber?: string;
                  /** The case this event belongs to, used by "View Rx". */
                  _sourceCaseId?: string;
                };

                const taggedOriginal: TaggedEvent[] = (data?.originalCaseEvents ?? []).map(
                  (e) => ({ ...e, _source: "original" as const, _sourceCaseId: data?.remakeOriginal?.id }),
                );
                const taggedRemake: TaggedEvent[] = (data?.events ?? []).map(
                  (e) => ({ ...e, _source: "remake" as const, _sourceCaseId: data?.id ?? labCase.id }),
                );
                const childEvents: TaggedEvent[] = (data?.remakeChildrenEvents ?? []).flatMap((rc) =>
                  rc.events.map((e) => ({ ...e, _source: "child" as const, _sourceCaseNumber: rc.caseNumber, _sourceCaseId: rc.caseId }))
                );

                const allEvents: TaggedEvent[] = [...taggedOriginal, ...taggedRemake, ...childEvents].sort(
                  (a, b) => {
                    const ta = new Date(a.occurredAt || a.createdAt || 0).getTime();
                    const tb = new Date(b.occurredAt || b.createdAt || 0).getTime();
                    return historySortOrder === "asc" ? ta - tb : tb - ta;
                  },
                );

                const returnDividerIds = detectCaseReturnDividerEventIds(allEvents);

                return (
                  <div>
                    {allEvents.map((e, idx) => {
                      const isLast = idx === allEvents.length - 1;
                      const eventType = e.eventType || "";
                      const isStatus = eventType === "status_changed";
                      const isNote = eventType === "note_added";
                      const isInternalExceptionNote = [
                        "internal_exception_opened_note",
                        "internal_exception_note_added",
                        "internal_exception_resolution_note_added",
                      ].includes(eventType);
                      const isAttachment = eventType.includes("attachment");
                      const isInboxAssign = eventType === "file_assigned_from_inbox";
                      const isInvoice = eventType.includes("invoice") || eventType === "statement_emailed";
                      const isRestoration = eventType.includes("restoration");
                      const metadata: Record<string, unknown> =
                        e.metadataJson && typeof e.metadataJson === "object"
                          ? (e.metadataJson as Record<string, unknown>)
                          : {};
                      const isBackfilledInvoice =
                        eventType === "invoice_generated" && metadata.source === "backfill";
                      const dotColor = isStatus
                        ? "#3B82F6"
                        : isNote
                        ? "#F59E0B"
                        : isAttachment || isInboxAssign
                        ? "#8B5CF6"
                        : isInvoice
                        ? "#10B981"
                        : isRestoration
                        ? "#6366F1"
                        : "#94A3B8";

                      const isFirstRemake =
                        hasOriginalEvents &&
                        (e._source === "remake" || e._source === "child") &&
                        (idx === 0 || allEvents[idx - 1]?._source === "original");

                      // Show a "Case returned" divider when a completion-family event
                      // is directly followed by an intake-family event (in chronological
                      // order), unless the isFirstRemake divider already renders here.
                      const isCaseReturn = !isFirstRemake && !!e.id && returnDividerIds.has(e.id);

                      const prevEvent = idx > 0 ? allEvents[idx - 1] : undefined;
                      const isDayGroupStart =
                        idx === 0 || historyEventDayKey(prevEvent ?? {}) !== historyEventDayKey(e);
                      const eventTimestamp = e.occurredAt || e.createdAt;
                      const actor =
                        (typeof metadata.authorName === "string" && metadata.authorName) ||
                        e.actorInitials ||
                        (typeof metadata.user === "string" && metadata.user) ||
                        null;

                      return (
                        <div key={e.id || idx}>
                          {isDayGroupStart && (
                            <>
                              {idx > 0 && (
                                <div
                                  data-testid="history-date-separator"
                                  className="border-t-2 border-foreground/35 mt-4"
                                />
                              )}
                              <div
                                data-testid="history-day-header"
                                className="text-base font-semibold text-foreground pt-4 pb-2"
                              >
                                {formatHistoryDay(eventTimestamp)}
                              </div>
                            </>
                          )}
                          {isFirstRemake && (
                            <div className="flex items-center gap-2 my-3">
                              <div className="flex-1 h-px bg-border" />
                              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1 whitespace-nowrap">
                                Case {data?.caseNumber}
                              </span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}
                          {isCaseReturn && (
                            <div className="flex items-center gap-2 my-3">
                              <div className="flex-1 h-px bg-border" />
                              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1 whitespace-nowrap">
                                Case returned
                              </span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}
                          <div className="flex gap-3 pb-5">
                            <div className="flex flex-col items-center shrink-0 mt-0.5">
                              <div
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{
                                  backgroundColor: dotColor,
                                  opacity: e._source === "original" ? 0.55 : 1,
                                }}
                              />
                              {!isLast && <div className="w-px flex-1 bg-border mt-1.5" />}
                            </div>
                            <div
                              className="flex-1 min-w-0 -mt-0.5"
                              style={{ opacity: e._source === "original" ? 0.7 : 1 }}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-sm font-medium flex items-center gap-1.5">
                                  <span>
                                    {invoiceEventSummary(e.eventType, metadata) ??
                                      (isAttachment && metadata.category === "outgoing"
                                        ? "Outgoing Case Photo"
                                        : formatEventType(e.eventType))}
                                  </span>
                                  {isBackfilledInvoice && (
                                    <span
                                      title="Generated by the missing-invoice backfill"
                                      className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200"
                                    >
                                      Backfilled
                                    </span>
                                  )}
                                  {e._source === "original" && (
                                    <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
                                      {data?.remakeOriginal?.caseNumber ?? "Original"}
                                    </span>
                                  )}
                                  {e._source === "child" && e._sourceCaseNumber && (
                                    <span className="inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 ring-1 ring-inset ring-blue-200">
                                      {e._sourceCaseNumber}
                                    </span>
                                  )}
                                </div>
                                 <span
                                   data-testid={`history-event-meta-${e.id}`}
                                   className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0"
                                 >
                                   {actor ? `${actor} · ` : ""}
                                   {formatHistoryTime(eventTimestamp)}
                                </span>
                              </div>
                              {isStatus && (e.metadataJson as any)?.fromStatus && (e.metadataJson as any)?.toStatus && (
                                <div className="flex items-center gap-1.5 mt-1">
                                  <StatusBadge status={String((e.metadataJson as any).fromStatus)} />
                                  <span className="text-xs text-muted-foreground">→</span>
                                  <StatusBadge status={String((e.metadataJson as any).toStatus)} />
                                </div>
                              )}
                              {/* A case that came back into the lab: offer the Rx
                                  right here so staff don't have to leave History. */}
                              {isCaseReturn && (
                                <div className="mt-1.5">
                                  <button
                                    type="button"
                                    data-testid={`history-view-rx-${e.id}`}
                                    aria-label="View Rx"
                                    title="View the prescription for this case"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setRxPreviewCaseId(historyEventCaseId(e, labCase.id));
                                      setRxPreviewOpen(true);
                                    }}
                                    className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors"
                                  >
                                    <ScrollText size={11} />
                                    View Rx
                                  </button>
                                </div>
                              )}
                              {eventType === "step_changed" && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {stepLabel(String((e.metadataJson as any)?.fromStep ?? ""))} → {stepLabel(String((e.metadataJson as any)?.toStep ?? ""))}
                                </div>
                              )}
                              {eventType === "step_shade_changed" && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {(e.metadataJson as any)?.toShade
                                    ? `Shade set to ${String((e.metadataJson as any).toShade)}`
                                    : "Shade cleared"}
                                </div>
                              )}
                              {isNote && (e.metadataJson as any)?.visibility && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {(e.metadataJson as any).visibility === "internal_lab_only"
                                    ? "Internal (lab only)"
                                    : "Shared with provider"}
                                </div>
                              )}
                              {(isNote || isInternalExceptionNote) &&
                                (metadata.noteText || metadata.description) && (
                                <div className="mt-1.5 text-sm bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800/50 rounded-md px-3 py-2 whitespace-pre-wrap break-words">
                                  {String(metadata.noteText ?? metadata.description)}
                                </div>
                              )}
                              {isInboxAssign && metadata.description && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {String(metadata.description)}
                                </div>
                              )}
                              {isInboxAssign && typeof metadata.providerNote === "string" && metadata.providerNote.trim() && (
                                <div className="mt-1.5 text-sm bg-violet-50 border border-violet-200 dark:bg-violet-950/30 dark:border-violet-800/50 rounded-md px-3 py-2">
                                  <div className="text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-0.5">
                                    Provider note
                                  </div>
                                  <div className="whitespace-pre-wrap break-words">
                                    {metadata.providerNote}
                                  </div>
                                </div>
                              )}
                              {isAttachment && (() => {
                                const fileType = String(metadata.fileType ?? "");
                                const mediaKind = String(metadata.mediaKind ?? "");
                                 const classifiedKind = classifyMediaKind(
                                   fileType,
                                   String(metadata.fileName ?? ""),
                                   mediaKind,
                                 );
                                 const isImg = classifiedKind === "image";
                                 const isVid = classifiedKind === "video";
                                // Prefer the legacy/mobile imageUri (works without auth headers,
                                // including data: URIs) when present. Fall back to the canonical
                                // /file route for desktop-created attachments.
                                const directSrc = metadata.imageUri ? String(metadata.imageUri) : null;
                                // Merged timelines carry entries from the linked original
                                // case and from remake children. The /file route is scoped
                                // to the case in its URL, so the attachment must be fetched
                                // under the case that OWNS the event — using the viewed
                                // case 404s and renders the "Unavailable" placeholder.
                                const eventCaseId = historyEventCaseId(e, labCase.id);
                                const apiSrc = metadata.attachmentId
                                  ? `${getApiOrigin()}/api/cases/${eventCaseId}/attachments/${String(metadata.attachmentId)}/file`
                                  : null;
                                const src = directSrc || apiSrc;
                                if (!src) {
                                  return metadata.fileName ? (
                                    <div className="mt-1.5">
                                      <span className="text-xs text-muted-foreground">{String(metadata.fileName)}</span>
                                    </div>
                                  ) : null;
                                }
                                const mime = fileType || (isVid ? "video/mp4" : isImg ? "image/jpeg" : undefined);
                                 // Only events owned by this case and pointing at
                                 // one of its current attachments may enter the
                                 // case gallery. Linked original/remake events
                                 // remain standalone previews and cannot leak
                                 // their media into this case's sequence.
                                 const galleryItem =
                                   e._sourceCaseId === labCase.id && metadata.attachmentId
                                     ? caseMediaGallery.find(
                                         (item) =>
                                           item.attachmentId ===
                                           String(metadata.attachmentId),
                                       )
                                     : undefined;
                                  const openImage = () =>
                                    openLightbox(
                                     galleryItem
                                       ? { ...galleryItem, gallery: caseMediaGallery }
                                       : {
                                           url: src,
                                           kind: "image",
                                           fileName: metadata.fileName
                                             ? String(metadata.fileName)
                                             : undefined,
                                         },
                                   );
                                  const openVideo = () =>
                                    openLightbox(
                                     galleryItem
                                       ? { ...galleryItem, gallery: caseMediaGallery }
                                       : {
                                           url: src,
                                           kind: "video",
                                           mimeType: mime,
                                           fileName: metadata.fileName
                                             ? String(metadata.fileName)
                                             : undefined,
                                         },
                                   );
                                return (
                                  <div className="mt-1.5">
                                    {isImg ? (
                                      <button
                                        type="button"
                                         onClick={openImage}
                                        className="block group"
                                        title={`View ${metadata.fileName ?? "image"}`}
                                      >
                                        <AuthedImage
                                          url={src}
                                          alt={String(metadata.fileName ?? "attachment")}
                                          className="w-20 h-20 object-cover rounded-md border border-border group-hover:border-primary/50 transition-colors"
                                          fallback={
                                            <div className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-secondary text-muted-foreground">
                                              <ImageOff size={16} />
                                              <span className="text-[9px] leading-tight">Unavailable</span>
                                            </div>
                                          }
                                        />
                                      </button>
                                    ) : isVid ? (
                                      <button
                                        type="button"
                                        aria-label={`Play ${metadata.fileName ?? "video"}`}
                                         onClick={openVideo}
                                        className="block group relative"
                                        title={`Play ${metadata.fileName ?? "video"}`}
                                      >
                                        <AuthedVideo
                                          url={src}
                                          className="w-20 h-20 object-cover rounded-md border border-border group-hover:border-primary/50 transition-colors bg-black"
                                          muted
                                          playsInline
                                          preload="metadata"
                                        />
                                        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                          <span className="h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center text-[10px] font-bold">▶</span>
                                        </span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          if (src.startsWith("data:") || src.startsWith("blob:")) {
                                            window.open(src, "_blank");
                                            return;
                                          }
                                          try {
                                            const token = getAccessToken();
                                            const sameOrigin = isSameApiOrigin(src);
                                            const resp = await fetch(
                                              src,
                                              sameOrigin && token
                                                ? { headers: { Authorization: `Bearer ${token}` } }
                                                : undefined,
                                            );
                                            if (!resp.ok) throw new Error(String(resp.status));
                                            const blob = await resp.blob();
                                            const objUrl = URL.createObjectURL(blob);
                                            window.open(objUrl, "_blank");
                                            setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
                                          } catch {
                                            window.open(src, "_blank");
                                          }
                                        }}
                                        className="inline-flex items-center gap-1.5 text-xs text-primary underline hover:text-primary/80"
                                        title={`Open ${metadata.fileName ?? "file"}`}
                                      >
                                        <Paperclip size={12} />
                                        {String(metadata.fileName ?? "Open file")}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                              {isAttachment && typeof metadata.note === "string" && metadata.note.trim() && (
                                <div className="mt-1.5 text-sm bg-secondary/50 border border-border rounded-md px-3 py-2 whitespace-pre-wrap break-words">
                                  {metadata.note.trim()}
                                </div>
                              )}
                              {isInvoice &&
                                invoiceEventSummary(e.eventType, metadata) == null &&
                                (metadata.invoiceNumber != null ||
                                  metadata.previousStatus != null ||
                                  metadata.newStatus != null) && (
                                <div className="mt-1 text-xs space-y-0.5">
                                  {metadata.invoiceNumber != null && (
                                    <div className="font-mono text-muted-foreground">
                                      {String(metadata.invoiceNumber)}
                                    </div>
                                  )}
                                  {metadata.previousStatus != null &&
                                    metadata.newStatus != null &&
                                    metadata.previousStatus !== metadata.newStatus && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="capitalize text-muted-foreground">
                                        {String(metadata.previousStatus).replace(/_/g, " ")}
                                      </span>
                                      <span className="text-muted-foreground">→</span>
                                      <span className="capitalize font-medium">
                                        {String(metadata.newStatus).replace(/_/g, " ")}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}
                              {eventType === "invoice_payments_deleted" && (
                                <div className="mt-1 text-xs space-y-0.5">
                                  {metadata.deletedCount != null && (
                                    <div className="text-muted-foreground">
                                      {Number(metadata.deletedCount) === 1
                                        ? "1 payment removed"
                                        : `${metadata.deletedCount} payments removed`}
                                    </div>
                                  )}
                                  {metadata.previousStatus != null && (
                                    <div className="text-muted-foreground">
                                      Previous status:{" "}
                                      <span className="capitalize">
                                        {String(metadata.previousStatus).replace(/_/g, " ")}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}
                              {eventType === "case_restoration_price_updated" && (
                                <div className="mt-1.5 text-xs space-y-0.5">
                                  {!!(metadata.restorationType || metadata.toothNumber) && (
                                    <div className="text-muted-foreground">
                                      {[
                                        metadata.restorationType != null ? String(metadata.restorationType) : null,
                                        metadata.toothNumber != null ? `Tooth ${String(metadata.toothNumber)}` : null,
                                      ].filter(Boolean).join(" · ")}
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1.5">
                                    {metadata.beforeUnitPrice != null && (
                                      <span className="tabular-nums line-through text-muted-foreground">
                                        {formatMoney(String(metadata.beforeUnitPrice))}
                                      </span>
                                    )}
                                    <span className="text-muted-foreground">→</span>
                                    {metadata.afterUnitPrice != null && (
                                      <span className="tabular-nums font-medium">
                                        {formatMoney(String(metadata.afterUnitPrice))}
                                      </span>
                                    )}
                                  </div>
                                  {metadata.reason != null && (
                                    <div className="text-muted-foreground italic">{String(metadata.reason)}</div>
                                  )}
                                </div>
                              )}
                              {(eventType === "invoice_emailed" ||
                                eventType === "statement_emailed") &&
                                typeof metadata.subject === "string" &&
                                metadata.subject.trim() && (
                                <div className="mt-1 text-xs text-muted-foreground truncate">
                                  Subject: {metadata.subject.trim()}
                                </div>
                              )}
                              {eventType === "remade_by" && metadata.remakeCaseId && (
                                <div className="mt-1">
                                  <button
                                    type="button"
                                    onClick={() => onOpenCaseId?.(String(metadata.remakeCaseId))}
                                    className="text-xs text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-200 font-mono"
                                  >
                                    {data?.remakeChildren?.find((c) => c.id === metadata.remakeCaseId)?.caseNumber ?? "Open remake →"}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
        <CaseEditActionBar
          editor={activeTab === "lab-slip" && editMode ? {
            onCancel: cancelCaseEdit,
            onSave: () => void saveCaseEdit(),
            disabled: isSaving,
            error: editError ?? saveError,
          } : undefined}
          restorationEditor={activeTab === "restorations" && showAddRest ? {
            onCancel: () => { setShowAddRest(false); setRestError(null); },
            onAdd: addPendingRestoration,
            error: restError,
            disabled: isSaving,
          } : undefined}
          pending={hasPendingChanges && !editMode ? {
            onDiscard: handleDiscardChanges,
            onSave: () => void handleSaveChanges(),
            isSaving,
            error: saveError,
          } : undefined}
        />
      </aside>

      {/* Image / Video lightbox */}
      <MediaLightbox
        lightbox={lightbox}
        onClose={() => {
          setLightbox(null);
          setActiveLightboxIdentity(null);
        }}
        activeItemIdentity={activeLightboxIdentity}
        onActiveItemChange={setActiveLightboxIdentity}
        overlayClassName="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
      />

      {/* Per-file note prompt — shown after files are picked or dropped, before
          the attachments are registered. Each file gets its own optional note;
          skipping simply uploads with no note. */}
      {pendingUploads && pendingUploads.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh]"
            role="dialog"
            aria-modal="true"
            aria-label="Add notes to files"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <h2 className="text-base font-semibold">
                Add a note{pendingUploads.length !== 1 ? " to each file" : ""} (optional)
              </h2>
              <button
                type="button"
                onClick={() => setPendingUploads(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4 overflow-y-auto">
              <p className="text-xs text-muted-foreground">
                Notes are optional. Leave any blank to upload without a note.
              </p>
              {pendingUploads.map((item, idx) => {
                const isImg = (item.file.type || "").startsWith("image/");
                const isVid = (item.file.type || "").startsWith("video/");
                return (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm min-w-0">
                      <span className="shrink-0 text-muted-foreground">
                        {isImg ? <ImageIcon size={14} /> : isVid ? <Video size={14} /> : <Paperclip size={14} />}
                      </span>
                      <span className="font-medium truncate" title={item.file.name}>
                        {item.file.name}
                      </span>
                    </div>
                    <textarea
                      value={item.note}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPendingUploads((prev) =>
                          prev
                            ? prev.map((p, i) => (i === idx ? { ...p, note: value } : p))
                            : prev,
                        );
                      }}
                      rows={2}
                      maxLength={1000}
                      placeholder="Add a note for this file…"
                      className="w-full px-2.5 py-2 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none resize-none"
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3 px-6 pb-5 pt-1 shrink-0">
              <button
                type="button"
                onClick={() => setPendingUploads(null)}
                className="flex-1 h-9 rounded-lg bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmPendingUploads}
                className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 inline-flex items-center justify-center gap-1.5"
              >
                <FileUp size={13} />
                Upload {pendingUploads.length} file{pendingUploads.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invoice editor overlay */}
      {viewingInvoice && (
        <InvoiceEditor key={viewingInvoice.id} invoice={viewingInvoice} onClose={() => setViewingInvoice(null)} />
      )}

      {/* Print Layout Editor */}
      {showPrintLayoutEditor && (
        <PrintLayoutEditor
          onClose={() => setShowPrintLayoutEditor(false)}
          config={printLayout}
          onChange={(next) => setPrintLayout(next)}
          hasCustomAdvancedTemplate={hasAdvancedTemplate}
          onOpenAdvanced={() => {
            setShowPrintLayoutEditor(false);
            setShowCaseAdvancedEditor(true);
          }}
        />
      )}

      {/* Advanced (drag & resize) per-lab Print Layout Editor */}
      {showCaseAdvancedEditor && (
        <CasePrintLayoutEditor
          onClose={() => setShowCaseAdvancedEditor(false)}
          onTemplateSaved={(saved) => {
            qc.setQueryData(
              ["casePrintTemplate", labCase.labOrganizationId],
              {
                template: coerceCasePrintTemplate(
                  saved.template ?? DEFAULT_CASE_PRINT_TEMPLATE,
                ),
                isCustom: saved.isCustom,
              },
            );
          }}
        />
      )}

      {/* Prescription preview */}
      {rxPreviewOpen && (
        <PrescriptionPreview
          caseId={rxPreviewCaseId ?? labCase.id}
          invoiceCaseId={labCase.id}
          onClose={() => {
            setRxPreviewOpen(false);
            setRxPreviewCaseId(null);
          }}
        />
      )}

      {reassignDoctorOpen && canReassignDoctor && data && !hasUnsavedDoctorAssignment && (
        <CaseDoctorReassignDialog
          caseId={data.id}
          caseNumber={data.caseNumber}
          currentDoctorName={data.doctorName}
          currentPracticeId={data.providerOrganizationId}
          onClose={() => setReassignDoctorOpen(false)}
        />
      )}

      {/* Remake from detail — admin/owner only */}
      {remakeFromDetailOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => !remakeFromDetailLoading && setRemakeFromDetailOpen(false)}
          />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-card border border-border shadow-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <GitBranch size={15} className="text-muted-foreground" />
                Create Remake — #{labCase.caseNumber}
              </h2>
              <button
                type="button"
                onClick={() => !remakeFromDetailLoading && setRemakeFromDetailOpen(false)}
                className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                disabled={remakeFromDetailLoading}
              >
                <X size={15} />
              </button>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Due date
              </label>
              <div className="flex gap-1.5">
                <input
                  type="date"
                  className="flex-1 min-w-0 h-8 px-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={remakeFromDetailDueDate}
                  onChange={(e) => {
                    setRemakeFromDetailDueDate(e.target.value);
                    if (!e.target.value) {
                      setRemakeFromDetailHasDueTime(false);
                      setRemakeFromDetailDueTime("");
                    }
                  }}
                />
              </div>
              <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={remakeFromDetailHasDueTime}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setRemakeFromDetailHasDueTime(checked);
                    if (!checked) setRemakeFromDetailDueTime("");
                  }}
                  disabled={!remakeFromDetailDueDate}
                  className="h-3.5 w-3.5 rounded border-border accent-primary disabled:cursor-not-allowed"
                  aria-label="Set a specific time the case is due"
                />
                <Clock size={13} aria-hidden="true" />
                Set a specific time the case is due
              </label>
              {remakeFromDetailHasDueTime && remakeFromDetailDueDate && (
                <input
                  type="time"
                  className="mt-2 w-[7.5rem] h-8 px-2 rounded-md bg-secondary text-sm border border-transparent focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={remakeFromDetailDueTime}
                  onChange={(e) => setRemakeFromDetailDueTime(e.target.value)}
                  aria-label="Due time (optional)"
                />
              )}
            </div>
            <RemakeQuestionnaire value={remakeFromDetailQ} onChange={setRemakeFromDetailQ} isAdmin={isAdmin} />
            {remakeFromDetailError && (
              <p className="mt-3 text-sm text-destructive">{remakeFromDetailError}</p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemakeFromDetailOpen(false)}
                disabled={remakeFromDetailLoading}
                className="h-8 px-4 rounded-md text-sm bg-secondary hover:bg-secondary/80 text-muted-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRemakeFromDetail()}
                disabled={
                  remakeFromDetailLoading ||
                  !isRemakeQuestionnaireComplete(remakeFromDetailQ)
                }
                className="h-8 px-4 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {remakeFromDetailLoading && (
                  <Loader2 size={12} className="animate-spin" />
                )}
                {remakeFromDetailLoading ? "Creating…" : "Create Remake"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit remake reason — available to anyone who can edit the case */}
      {editRemakeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => !editRemakeLoading && setEditRemakeOpen(false)}
          />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-card border border-border shadow-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Pencil size={14} className="text-muted-foreground" />
                Edit Remake Reason — #{labCase.caseNumber}
              </h2>
              <button
                type="button"
                onClick={() => !editRemakeLoading && setEditRemakeOpen(false)}
                className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                disabled={editRemakeLoading}
              >
                <X size={15} />
              </button>
            </div>
            <RemakeQuestionnaire value={editRemakeQ} onChange={setEditRemakeQ} isAdmin={isAdmin} />
            {editRemakeError && (
              <p className="mt-3 text-sm text-destructive">{editRemakeError}</p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditRemakeOpen(false)}
                disabled={editRemakeLoading}
                className="h-8 px-4 rounded-md text-sm bg-secondary hover:bg-secondary/80 text-muted-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleEditRemakeSave()}
                disabled={
                  editRemakeLoading ||
                  !isRemakeQuestionnaireComplete(editRemakeQ)
                }
                className="h-8 px-4 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {editRemakeLoading && (
                  <Loader2 size={12} className="animate-spin" />
                )}
                {editRemakeLoading ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete case — 3-step security flow */}
      {confirmDeleteCase && (
        <CaseDeleteModal
          caseIds={[labCase.id]}
          onClose={() => setConfirmDeleteCase(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["cases"] });
            qc.invalidateQueries({ queryKey: ["case", labCase.id] });
            // The case's invoice is frozen (not deleted) — refresh invoice views.
            qc.invalidateQueries({ queryKey: ["invoices"] });
            qc.invalidateQueries({ queryKey: ["invoice-for-case"] });
            qc.invalidateQueries({ queryKey: ["invoice-detail"] });
            setConfirmDeleteCase(false);
            onClose();
          }}
        />
      )}

      {/* Tooth chart action dialog */}
      {toothDialogId !== null && (
        <ToothActionDialog
          catalog={catalogQuery.data}
          selectedTeeth={toothMultiSelect ? toothSelectedTargets : [toothDialogId]}
          selectionArch={selectedToothArch(toothMultiSelect ? toothSelectedTargets : [toothDialogId])}
          initialCopyTargets={toothCopyTargets}
          toothId={toothDialogId}
          restorations={[
            ...(data?.restorations ?? []).filter((row) => row.restorationType !== "missing" && !pendingDeletes.has(row.id)).map((row) => {
              const edit = pendingUpdates.find((entry) => entry.restorationId === row.id);
              return { ...row, toothNumber: edit?.newToothNumber ?? row.toothNumber,
                restorationType: edit?.restorationType ?? row.restorationType,
                material: edit?.material ?? row.material, shade: edit?.shade ?? row.shade,
                restorationSubtype: edit?.restorationSubtype ?? row.restorationSubtype,
                arch: edit?.arch !== undefined ? edit.arch : row.arch };
            }),
            ...pendingCreates.map((row) => ({ ...row, id: row.localId, caseId: labCase.id,
              quantity: Number(row.quantity) || 1, unitPrice: Number(row.unitPrice) || 0 })),
          ]}
          isPending={false}
          error={toothDialogError}
          onClose={() => {
            setToothDialogId(null);
            setToothDialogError(null);
          }}
          onConfirm={(payload) => handleToothDialogStage(payload)}
          materialOptions={toothDialogMaterialOptions}
          groupTeeth={assignmentSummary.groups.find((group) => group.includes(toothDialogId))}
          locallySelectedType={
            missingTeethIds.has(toothDialogId)
              ? "missing"
              : pendingCreates.some(
                  (c) =>
                    parseToothField(c.toothNumber).has(toothDialogId) &&
                    /pontic/i.test(c.restorationType),
                )
              ? "pontic"
              : pendingCreates.some(
                  (c) =>
                    parseToothField(c.toothNumber).has(toothDialogId) &&
                    !/pontic/i.test(c.restorationType),
                )
              ? "crown"
              : undefined
          }
        />
      )}

      {/* Discard confirm overlay — shown when closing or navigating away with unsaved changes */}
      {pendingDiscard && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-foreground/40"
          onClick={() => setPendingDiscard(null)}
        >
          <div
            className="bg-card rounded-xl border border-border p-6 max-w-sm mx-4 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={17} className="text-amber-600" />
              </div>
              <div>
                <h3 className="font-semibold">Unsaved changes</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  You have unsaved changes to this case. Do you want to discard them?
                </p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="flex-1 h-9 rounded-md bg-secondary text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  const proceed = pendingDiscard;
                  handleDiscardChanges();
                  setPendingDiscard(null);
                  proceed?.();
                }}
                className="flex-1 h-9 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Returned-case wizard ──
          A fixed 4in × 4in (384 × 384 px) popup centred over the whole screen,
          above the case drawer, so the questions asked when a completed case
          comes back in are impossible to miss. The question title stays in the
          header and each stage's buttons stay pinned, so the taller stages
          (remake questionnaire, notes, prescription upload) scroll inside the
          box instead of resizing or clipping it. */}
      {returnPromptStep && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 backdrop-blur-sm"
          data-testid="return-wizard-overlay"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Returned case questions"
            data-testid="return-wizard-dialog"
            className="w-96 h-96 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          >
            <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
              <h2
                className="text-sm font-semibold text-foreground"
                data-testid="return-wizard-title"
              >
                {RETURN_WIZARD_TITLES[returnPromptStep]}
              </h2>
              <button
                type="button"
                onClick={resetReturnWizard}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close returned case questions"
              >
                <X size={16} />
              </button>
            </div>
            {returnPromptStep === "ask" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-due-ask"
              >
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setReturnPromptStep("date")}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    disabled={routeMutation.isPending}
                    onClick={() => {
                      routeReturnedCase(
                        {
                          status: returnPromptStatus as CaseStatus,
                          labLocationId: returnPromptLabLocationId,
                        },
                        true,
                      );
                    }}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm disabled:opacity-50 transition-colors"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "date" && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium block mb-1">
                        Due date
                      </label>
                      <input
                        type="date"
                        value={returnDueDate}
                        onChange={(e) => setReturnDueDate(e.target.value)}
                        className="h-8 px-2 rounded-md bg-background text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium block mb-1">
                        Due time <span className="font-normal normal-case">(optional)</span>
                      </label>
                      <input
                        type="time"
                        value={returnDueTime}
                        onChange={(e) => setReturnDueTime(e.target.value)}
                        className="h-8 px-2 rounded-md bg-background text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                </div>
                <div className="shrink-0 border-t border-border px-4 py-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!returnDueDate || routeMutation.isPending}
                    onClick={() => {
                      routeReturnedCase(
                        {
                          status: returnPromptStatus as CaseStatus,
                          labLocationId: returnPromptLabLocationId,
                          dueDate: returnDueDate,
                          ...(returnDueTime ? { dueTime: returnDueTime } : {}),
                        },
                        false,
                      );
                      setReturnDueDate("");
                      setReturnDueTime("");
                    }}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {routeMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
                    Locate &amp; Update Due Date
                  </button>
                  <button
                    type="button"
                    onClick={() => setReturnPromptStep("ask")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "rxAsk" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-rx-ask"
              >
                {returnRxBlockedReason ? (
                  <>
                    <p className="text-xs text-muted-foreground text-center">
                      {returnRxBlockedReason}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => goToNextReturnStage("rxAsk")}
                        className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                      >
                        Continue
                      </button>
                      <button
                        type="button"
                        onClick={resetReturnWizard}
                        className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                      >
                        Close
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setUploadError(null);
                        setReturnPromptStep("rxUpload");
                      }}
                      className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => goToNextReturnStage("rxAsk")}
                      className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                    >
                      No
                    </button>
                    <button
                      type="button"
                      onClick={resetReturnWizard}
                      className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            )}
            {returnPromptStep === "rxUpload" && (
              <div
                className="flex-1 min-h-0 flex flex-col"
                data-testid="return-wizard-rx-upload"
              >
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                  <div
                    data-testid="return-rx-dropzone"
                    onDragEnter={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setReturnRxDragOver(true);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setReturnRxDragOver(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setReturnRxDragOver(false);
                      const files = Array.from(e.dataTransfer?.files ?? []);
                      if (files.length > 0) void uploadReturnPrescription(files);
                    }}
                    className={`flex flex-col items-center justify-center gap-1.5 py-5 rounded-lg border-2 border-dashed text-center transition-colors ${
                      returnRxDragOver
                        ? "border-primary bg-primary/8 text-primary"
                        : "border-muted-foreground/30 text-muted-foreground"
                    }`}
                  >
                    <FileUp size={16} className={returnRxDragOver ? "text-primary" : "text-muted-foreground/60"} />
                    <span className="text-xs font-medium">
                      Drop the prescription here
                    </span>
                  </div>
                  <input
                    ref={returnRxInputRef}
                    type="file"
                    className="hidden"
                    data-testid="return-rx-file-input"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (files.length > 0) void uploadReturnPrescription(files);
                    }}
                  />
                  {uploadingFile && (
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" />
                      Uploading prescription…
                    </p>
                  )}
                  {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
                </div>
                <div className="shrink-0 border-t border-border px-4 py-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={uploadingFile}
                    onClick={() => returnRxInputRef.current?.click()}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                  >
                    Choose file from computer
                  </button>
                  <button
                    type="button"
                    disabled={uploadingFile}
                    onClick={() => goToNextReturnStage("rxUpload")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm disabled:opacity-50 transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    disabled={uploadingFile}
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm disabled:opacity-50 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "remakeAsk" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-remake-ask"
              >
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReturnRemakeError(null);
                      setReturnPromptStep("remake");
                    }}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => goToNextReturnStage("remakeAsk")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "remake" && (
              <div className="flex-1 min-h-0 flex flex-col" data-testid="return-wizard-remake">
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                  <RemakeOriginalPicker
                    labOrganizationId={
                      data?.labOrganizationId ?? labCase.labOrganizationId ?? ""
                    }
                    selected={returnRemakeSelected}
                    onSelect={(hit) => {
                      setReturnRemakeSelected(hit);
                      setReturnRemakeError(null);
                    }}
                    onClear={() => setReturnRemakeSelected(null)}
                    questionnaire={returnRemakeQ}
                    onQuestionnaireChange={setReturnRemakeQ}
                    isAdmin={isAdmin}
                    excludeCaseId={labCase.id}
                  />
                  {returnRemakeError && (
                    <p className="text-xs text-destructive">{returnRemakeError}</p>
                  )}
                </div>
                <div className="shrink-0 border-t border-border px-4 py-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={
                      !returnRemakeSelected ||
                      !isRemakeQuestionnaireComplete(returnRemakeQ) ||
                      returnRemakeMutation.isPending
                    }
                    onClick={() => returnRemakeMutation.mutate()}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {returnRemakeMutation.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : null}
                    Link Remake
                  </button>
                  <button
                    type="button"
                    disabled={returnRemakeMutation.isPending}
                    onClick={() => goToNextReturnStage("remake")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm disabled:opacity-50 transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    disabled={returnRemakeMutation.isPending}
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm disabled:opacity-50 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "stepAsk" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-step-ask"
              >
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setReturnPromptStep("step")}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => goToNextReturnStage("stepAsk")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "step" && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                  <select
                    value={returnStep}
                    onChange={(e) => setReturnStep(e.target.value)}
                    aria-label="New removable workflow step"
                    className="block w-full h-8 px-2 rounded-md bg-background text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                    data-testid="return-step-select"
                  >
                    <option value="" disabled>
                      Select a step…
                    </option>
                    {STEP_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="shrink-0 border-t border-border px-4 py-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!returnStep || returnStepMutation.isPending}
                    onClick={() => {
                      const currentStep = (data ?? labCase).step ?? "";
                      if (returnStep === currentStep) {
                        goToNextReturnStage("step");
                        return;
                      }
                      returnStepMutation.mutate(returnStep);
                    }}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {returnStepMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
                    Update Step
                  </button>
                  <button
                    type="button"
                    disabled={returnStepMutation.isPending}
                    onClick={() => goToNextReturnStage("step")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm disabled:opacity-50 transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    disabled={returnStepMutation.isPending}
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm disabled:opacity-50 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "notesAsk" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-notes-ask"
              >
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setNoteError(null);
                      setReturnPromptStep("notes");
                    }}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => goToNextReturnStage("notesAsk")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "notes" && (
              <div className="flex-1 min-h-0 flex flex-col" data-testid="return-wizard-notes">
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                  <NoteComposer
                    noteText={noteText}
                    setNoteText={setNoteText}
                    setNoteError={setNoteError}
                    noteError={noteError ?? null}
                    shareWithProvider={shareWithProvider}
                    setShareWithProvider={setShareWithProvider}
                    isListeningNote={isListeningNote}
                    startNoteListening={startNoteListening}
                    stopNoteListening={stopNoteListening}
                    isPending={addNoteMutation.isPending}
                    onSubmit={() =>
                      addNoteMutation.mutate(
                        { text: noteText, shared: shareWithProvider },
                        { onSuccess: () => goToNextReturnStage("notes") },
                      )
                    }
                    orgId={
                      data?.viewerQuickReferenceOrganizationId ??
                      data?.labOrganizationId ??
                      null
                    }
                  />
                </div>
                <div className="shrink-0 border-t border-border px-4 py-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={addNoteMutation.isPending}
                    onClick={() => goToNextReturnStage("notes")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm disabled:opacity-50 transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    disabled={addNoteMutation.isPending}
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm disabled:opacity-50 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "labSlipAsk" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-lab-slip-ask"
              >
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void printLabSlip();
                      goToNextReturnStage("labSlipAsk");
                    }}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Printer size={13} />
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => goToNextReturnStage("labSlipAsk")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={resetReturnWizard}
                    className="h-8 px-3 rounded-md text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {returnPromptStep === "labelAsk" && (
              <div
                className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center justify-center gap-3"
                data-testid="return-wizard-label-ask"
              >
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void printLabel();
                      goToNextReturnStage("labelAsk");
                    }}
                    className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Printer size={13} />
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => goToNextReturnStage("labelAsk")}
                    className="h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-sm transition-colors"
                  >
                    No
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const PRICE_SOURCE_STYLES: Record<
  RestorationPriceSource,
  { label: string; className: string; title: string }
> = {
  manual: {
    label: "Manual",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    title: "Price was entered manually on this case.",
  },
  override: {
    label: "Override",
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    title: "Came from a per-doctor pricing override.",
  },
  discount: {
    label: "Discount",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    title: "Percentage discount off the practice's default tier.",
  },
  tier: {
    label: "Tier",
    className: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    title: "Came from the practice's assigned pricing tier.",
  },
  default: {
    label: "Default tier",
    className: "bg-secondary text-muted-foreground",
    title: "Fell back to the lab's default tier.",
  },
};

function PendingRestorationRow({
  pending,
  onRemove,
}: {
  pending: {
    localId: string;
    toothNumber: string;
    restorationType: string;
    material: string;
    shade: string;
    quantity: number;
    unitPrice: string;
  };
  onRemove: () => void;
}) {
  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded-md px-3 py-2 text-sm flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {pending.restorationType}
          <span className="text-muted-foreground"> · Tooth {pending.toothNumber}</span>
        </div>
        {(pending.material || pending.shade) && (
          <div className="text-xs text-muted-foreground">
            {[pending.material, pending.shade].filter(Boolean).join(" · ")}
          </div>
        )}
        <div className="mt-1.5">
          <span className="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
            Unsaved
          </span>
        </div>
      </div>
      <div className="flex items-start gap-2 shrink-0">
        <div className="text-right whitespace-nowrap">
          <div className="text-xs text-muted-foreground tabular-nums">Qty {pending.quantity}</div>
          <div className="text-sm tabular-nums font-medium text-muted-foreground">
            {pending.unitPrice ? `$${Number(pending.unitPrice).toFixed(2)}` : "Auto"}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="h-7 w-7 rounded hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors mt-0.5"
          aria-label={`Remove unsaved ${pending.restorationType} for tooth ${pending.toothNumber}`}
          title="Remove (not saved yet)"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function RestorationRow({
  restoration: r,
  caseId,
  labOrganizationId,
  isPendingDelete,
  onPendingDelete,
  onUndoPendingDelete,
  canEditPrice,
  discountBaseTierName,
}: {
  restoration: CaseRestoration;
  caseId: string;
  labOrganizationId: string;
  isPendingDelete?: boolean;
  onPendingDelete?: () => void;
  onUndoPendingDelete?: () => void;
  canEditPrice?: boolean;
  discountBaseTierName?: string | null;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [savingPrice, setSavingPrice] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const source = (r.priceSource ?? null) as RestorationPriceSource | null;
  const style = source ? PRICE_SOURCE_STYLES[source] : null;
  const hasHistorySource =
    source === "tier" || source === "override" || source === "default";

  // ── Inline "set price in fee schedule" (Task #2084) ──────────────────────
  // Shown on any unpriced ($0) restoration whose material/type maps to a
  // fee-schedule key. Writes the price into the tier/override the case resolves
  // to (so it persists for future cases), then re-prices the line + invoice.
  // The alloy line is excluded — it has its own banner affordance.
  const isAlloyLine =
    (r.priceKey ?? "") === "alloy" ||
    (r.restorationType ?? "").trim().toLowerCase() === "alloy";
  const isUnpriced = Number(r.unitPrice ?? 0) <= 0;
  const showFeeScheduleSet =
    !!canEditPrice && isUnpriced && !isAlloyLine && !isPendingDelete;
  const [feeScheduleInput, setFeeScheduleInput] = useState("");
  const [savingFeeSchedule, setSavingFeeSchedule] = useState(false);
  const [feeScheduleError, setFeeScheduleError] = useState<string | null>(null);

  async function saveFeeSchedulePrice() {
    const parsed = parseFloat(feeScheduleInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setFeeScheduleError("Enter a price above $0.");
      return;
    }
    setSavingFeeSchedule(true);
    setFeeScheduleError(null);
    try {
      const res = await apiFetch<{
        target?: { kind?: string; name?: string };
      }>(`/cases/${caseId}/restorations/${r.id}/fee-schedule-price`, {
        method: "POST",
        body: JSON.stringify({ price: parsed }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["case", caseId] }),
        queryClient.invalidateQueries({ queryKey: ["invoice-for-case", caseId] }),
        queryClient.invalidateQueries({ queryKey: ["cases"] }),
      ]);
      setFeeScheduleInput("");
      const target = res?.target;
      if (target?.name) {
        toast.success(
          `Price saved to ${target.kind === "tier" ? "tier" : "override"} “${target.name}”.`,
        );
      }
    } catch (err: any) {
      setFeeScheduleError(err?.message ?? "Failed to set the price.");
    } finally {
      setSavingFeeSchedule(false);
    }
  }

  function openPriceEditor() {
    setPriceInput(r.unitPrice != null ? Number(r.unitPrice).toFixed(2) : "0.00");
    setReasonInput("");
    setPriceError(null);
    setEditingPrice(true);
  }

  function cancelPriceEditor() {
    setEditingPrice(false);
    setPriceError(null);
  }

  async function savePriceEdit() {
    const parsed = parseFloat(priceInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setPriceError("Enter a valid price (0 or greater).");
      return;
    }
    setSavingPrice(true);
    setPriceError(null);
    try {
      await apiFetch(`/cases/${caseId}/restorations/${r.id}/price`, {
        method: "PATCH",
        body: JSON.stringify({
          unitPrice: parsed,
          ...(reasonInput.trim() ? { reason: reasonInput.trim() } : {}),
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["case", caseId] }),
        queryClient.invalidateQueries({ queryKey: ["invoice-for-case", caseId] }),
      ]);
      setEditingPrice(false);
    } catch (err: any) {
      setPriceError(err?.message ?? "Failed to save price.");
    } finally {
      setSavingPrice(false);
    }
  }

  return (
    <div
      className={`border rounded-md px-3 py-2 text-sm transition-colors ${
        isPendingDelete
          ? "border-amber-500/40 bg-amber-500/5 opacity-70"
          : confirmDelete
          ? "border-destructive/40 bg-destructive/5"
          : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`font-medium ${isPendingDelete ? "line-through text-muted-foreground" : ""}`}>
            {r.restorationType}
            <span className="text-muted-foreground"> · Tooth {r.toothNumber}</span>
          </div>
          {(r.material || r.shade) && (
            <div className="text-xs text-muted-foreground">
              {[r.material, r.shade].filter(Boolean).join(" · ")}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {isPendingDelete && (
              <span className="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
                Pending delete
              </span>
            )}
            {!isPendingDelete && style && (
              <span
                title={
                  source === "discount" && discountBaseTierName
                    ? `Percentage discount off the ${discountBaseTierName} tier (no practice default tier price available for this item).`
                    : style.title
                }
                className={`text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded ${style.className}`}
              >
                {style.label}
                {source !== "manual" && r.priceSourceName
                  ? ` · ${r.priceSourceName}`
                  : ""}
                {source === "discount" && discountBaseTierName
                  ? ` · off ${discountBaseTierName}`
                  : ""}
              </span>
            )}
            {!isPendingDelete && !style && (
              <span className="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                Unknown source
              </span>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2 shrink-0">
          <div className="text-right whitespace-nowrap">
            <div className="text-xs text-muted-foreground tabular-nums">Qty {r.quantity}</div>
            <div className="text-sm tabular-nums font-medium">{formatMoney(r.unitPrice)}</div>
          </div>
          {isPendingDelete ? (
            <button
              type="button"
              onClick={() => { onUndoPendingDelete?.(); setConfirmDelete(false); }}
              className="h-7 px-2 rounded text-[11px] font-medium bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors mt-0.5"
              title="Undo — this deletion hasn't been saved yet"
            >
              Undo
            </button>
          ) : !confirmDelete ? (
            <div className="flex items-center gap-1 mt-0.5">
              {canEditPrice && !editingPrice && (
                <button
                  type="button"
                  onClick={openPriceEditor}
                  className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={`Edit price for ${r.restorationType}, tooth ${r.toothNumber}`}
                  title="Edit price"
                >
                  <Pencil size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="h-7 w-7 rounded hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                aria-label={`Delete ${r.restorationType} for tooth ${r.toothNumber}`}
                title="Delete restoration"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 mt-0.5">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-6 px-1.5 rounded text-[11px] text-muted-foreground hover:text-foreground bg-secondary"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => { onPendingDelete?.(); setConfirmDelete(false); }}
                className="h-6 px-1.5 rounded text-[11px] font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 inline-flex items-center gap-0.5"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {editingPrice && (
        <div className="mt-2.5 border border-border rounded-md bg-secondary/30 px-3 py-2.5 space-y-2">
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Override unit price</div>
          <div className="flex items-center gap-2">
            <div className="relative w-28 shrink-0">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                aria-label={`Override unit price for ${r.restorationType}, tooth ${r.toothNumber}`}
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") savePriceEdit(); if (e.key === "Escape") cancelPriceEditor(); }}
                className="w-full h-7 rounded border border-input bg-background pl-5 pr-2 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="0.00"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={savePriceEdit}
              disabled={savingPrice}
              className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {savingPrice && <Loader2 size={10} className="animate-spin" />}
              Save
            </button>
            <button
              type="button"
              onClick={cancelPriceEditor}
              disabled={savingPrice}
              className="h-7 px-2 rounded bg-secondary hover:bg-secondary/80 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
          <div>
            <input
              type="text"
              aria-label={`Reason for price override on ${r.restorationType}, tooth ${r.toothNumber}`}
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              placeholder="Reason (optional)"
              maxLength={500}
              className="w-full h-7 rounded border border-input bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {priceError && (
            <div className="text-xs text-destructive">{priceError}</div>
          )}
        </div>
      )}
      {showFeeScheduleSet && (
        <div className="mt-2.5 border border-amber-500/40 rounded-md bg-amber-500/5 px-3 py-2.5 space-y-2">
          <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              No price is set for this item in this case's pricing tier. Set it
              to price this line and future cases.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-28 shrink-0">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                aria-label={`Fee schedule price for ${r.restorationType}, tooth ${r.toothNumber}`}
                value={feeScheduleInput}
                onChange={(e) => setFeeScheduleInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveFeeSchedulePrice(); }}
                className="w-full h-7 rounded border border-input bg-background pl-5 pr-2 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="0.00"
              />
            </div>
            <button
              type="button"
              onClick={saveFeeSchedulePrice}
              disabled={savingFeeSchedule}
              className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {savingFeeSchedule && <Loader2 size={10} className="animate-spin" />}
              Set price
            </button>
          </div>
          {feeScheduleError && (
            <div className="text-xs text-destructive">{feeScheduleError}</div>
          )}
        </div>
      )}
      {hasHistorySource && r.priceSourceId && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            Price history
          </button>
          {expanded && (
            <PriceHistoryPanel
              labOrganizationId={labOrganizationId}
              source={source as "tier" | "override" | "default"}
              sourceId={r.priceSourceId}
              priceKey={r.priceKey ?? null}
              capturedUnitPrice={Number(r.unitPrice ?? 0)}
              capturedAt={r.createdAt ?? null}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PriceHistoryPanel({
  labOrganizationId,
  source,
  sourceId,
  priceKey,
  capturedUnitPrice,
  capturedAt,
}: {
  labOrganizationId: string;
  source: "tier" | "override" | "default";
  sourceId: string;
  priceKey: string | null;
  capturedUnitPrice: number;
  capturedAt: string | null;
}) {
  const endpointType = source === "override" ? "overrides" : "tiers";

  const history = useQuery({
    queryKey: ["pricing-history", endpointType, sourceId],
    queryFn: () =>
      apiFetch<{ entries: PricingHistoryEntry[] }>(
        `/pricing/${endpointType}/${sourceId}/history`
      ),
  });

  const currentList = useQuery({
    queryKey: ["pricing-current", endpointType, labOrganizationId],
    queryFn: async () => {
      if (endpointType === "tiers") {
        return apiFetch<{ tiers: PricingTier[] }>(
          `/pricing/tiers?labOrganizationId=${encodeURIComponent(labOrganizationId)}`
        );
      }
      return apiFetch<{ overrides: PricingOverride[] }>(
        `/pricing/overrides?labOrganizationId=${encodeURIComponent(labOrganizationId)}`
      );
    },
  });

  if (history.isLoading || currentList.isLoading) {
    return (
      <div className="mt-1.5 text-[11px] text-muted-foreground">Loading price history…</div>
    );
  }
  if (history.error) {
    return (
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        Couldn't load price history.
      </div>
    );
  }

  const capturedTs = capturedAt ? new Date(capturedAt).getTime() : 0;
  const entries = (history.data?.entries ?? []).filter((e) => {
    if (!priceKey) return true;
    const before = e.beforePrices?.[priceKey];
    const after = e.afterPrices?.[priceKey];
    return Number(before ?? 0) !== Number(after ?? 0);
  });
  const changesSinceCase = entries.filter((e) => {
    const t = e.createdAt ? new Date(e.createdAt).getTime() : 0;
    return t > capturedTs;
  });

  let currentPrice: number | null = null;
  if (priceKey) {
    if (endpointType === "tiers") {
      const tier = (currentList.data as { tiers?: PricingTier[] } | undefined)
        ?.tiers?.find((t) => t.id === sourceId);
      const v = Number(tier?.prices?.[priceKey]);
      if (Number.isFinite(v) && v > 0) currentPrice = v;
    } else {
      const ov = (
        currentList.data as { overrides?: PricingOverride[] } | undefined
      )?.overrides?.find((o) => o.id === sourceId);
      const v = Number(ov?.prices?.[priceKey]);
      if (Number.isFinite(v) && v > 0) currentPrice = v;
    }
  }

  const sourceLabel = source === "override" ? "Override" : "Tier";

  return (
    <div className="mt-2 border border-border rounded bg-secondary/30 p-2 space-y-1.5">
      {currentPrice !== null && Math.abs(currentPrice - capturedUnitPrice) > 0.005 && (
        <div className="text-[11px] text-foreground">
          {sourceLabel} price changed{" "}
          <span className="tabular-nums">
            {formatMoney(capturedUnitPrice)} → {formatMoney(currentPrice)}
          </span>{" "}
          since this case was billed.
        </div>
      )}
      {currentPrice !== null && Math.abs(currentPrice - capturedUnitPrice) <= 0.005 && (
        <div className="text-[11px] text-muted-foreground">
          {sourceLabel} price hasn't changed since this case was billed.
        </div>
      )}
      {changesSinceCase.length === 0 && entries.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          No edits since this case was created.
        </div>
      )}
      {changesSinceCase.length > 0 && (
        <ul className="space-y-1">
          {changesSinceCase.slice(0, 5).map((e) => {
            const before = priceKey ? e.beforePrices?.[priceKey] : undefined;
            const after = priceKey ? e.afterPrices?.[priceKey] : undefined;
            const beforeNum = Number(before ?? 0);
            const afterNum = Number(after ?? 0);
            return (
              <li key={e.id} className="text-[11px] text-muted-foreground">
                <span className="text-foreground tabular-nums">
                  {beforeNum > 0 ? formatMoney(beforeNum) : "—"} →{" "}
                  {afterNum > 0 ? formatMoney(afterNum) : "—"}
                </span>
                <span> · {relativeTime(e.createdAt)}</span>
                {e.userName && <span> · {e.userName}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {entries.length === 0 && currentPrice === null && (
        <div className="text-[11px] text-muted-foreground">
          No pricing changes recorded.
        </div>
      )}
    </div>
  );
}

async function openFileAuthenticated(url: string): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    window.alert("Could not open file. Please try again.");
    return;
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}

async function previewAttachmentInElectron(
  caseId: string,
  attachment: CaseAttachment,
): Promise<void> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.previewFile || !attachment.id) return;
  const href = `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`;
  const token = getAccessToken();
  const res = await fetch(href, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const mimeType =
    attachment.fileType || res.headers.get("content-type") || "application/octet-stream";
  await electronAPI.previewFile(buffer, mimeType, `attachment:${attachment.id}`);
}

// Exported for the regression guard in
// pages/__tests__/attachment-row-authed-media.test.tsx, which mounts this real
// Files-tab list row to prove image attachments render through AuthedImage
// (never a plain <img src> at the protected /file endpoint).
export function AttachmentRow({
  caseId,
  attachment,
  canManage,
  onImageClick,
  onVideoClick,
  onAttachmentClick,
}: {
  caseId: string;
  attachment: CaseAttachment;
  canManage: boolean;
  onImageClick?: (url: string) => void;
  onVideoClick?: (url: string, mimeType?: string, fileName?: string) => void;
  /** Opens the item in the current-case gallery while retaining attachment identity. */
  onAttachmentClick?: (attachment: CaseAttachment, url: string) => void;
}) {
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [scanViewerOpen, setScanViewerOpen] = useState(false);
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(attachment.note ?? "");
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${caseId}/attachments/${attachment.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (err: Error) => {
      window.alert(err.message || "Couldn't delete attachment.");
    },
  });

  const visibility = attachment.visibility || "internal_lab_only";
  const isInternal = visibility === "internal_lab_only";
  const nextVisibility = isInternal ? "shared_with_provider" : "internal_lab_only";

  const visibilityMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${caseId}/attachments/${attachment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: nextVisibility }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (err: Error) => {
      window.alert(err.message || "Couldn't update attachment visibility.");
    },
  });

  const noteMutation = useMutation({
    mutationFn: (nextNote: string | null) =>
      apiFetch(`/cases/${caseId}/attachments/${attachment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ note: nextNote }),
      }),
    onSuccess: () => {
      setIsEditingNote(false);
      queryClient.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (err: Error) => {
      window.alert(err.message || "Couldn't update the note.");
    },
  });

  function startEditingNote() {
    setNoteDraft(attachment.note ?? "");
    setIsEditingNote(true);
  }

  function cancelEditingNote() {
    setNoteDraft(attachment.note ?? "");
    setIsEditingNote(false);
  }

  function saveNote() {
    if (noteMutation.isPending) return;
    const trimmed = noteDraft.trim();
    noteMutation.mutate(trimmed ? trimmed : null);
  }

  function clearNote() {
    if (noteMutation.isPending) return;
    noteMutation.mutate(null);
  }

  const isImage = (attachment.fileType || "").startsWith("image/");
  const videoExtension = attachment.fileName?.match(/\.(mov|mp4|m4v|webm|ogv|ogg)$/i);
  const isVideo =
    (attachment.fileType || "").toLowerCase().startsWith("video/") ||
    !!videoExtension;

  const SCAN_MIME_TYPES = new Set(["model/stl", "model/obj", "model/ply", "application/sla"]);
  const SCAN_EXTENSIONS = new Set([".stl", ".obj", ".ply", ".dcm", ".3ds", ".dae"]);
  function is3dScan(mimeType: string, fileName?: string): boolean {
    if (SCAN_MIME_TYPES.has(mimeType)) return true;
    if (fileName) {
      const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
      if (SCAN_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }
  const isScan = is3dScan(attachment.fileType || "", attachment.fileName);
  const scanAccuracy = attachment.scanAccuracy;
  const conditionLabel = scanAccuracy?.objectCondition === "simple-matte"
    ? "Matte / non-reflective"
    : scanAccuracy?.objectCondition === "dental-complex"
      ? "Complex dental surface"
      : scanAccuracy?.objectCondition === "reflective-or-translucent"
        ? "Reflective / translucent"
        : "Not verified";
  // The desktop has an in-app three.js viewer for STL/OBJ/PLY; other 3D
  // formats (.dcm, .3ds, .dae) fall through to the existing preview/open
  // behaviour.
  function inAppScanFormat(fileName?: string): ScanFormat | null {
    if (!fileName) return null;
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "stl" || ext === "obj" || ext === "ply") return ext;
    return null;
  }
  const inAppFormat = inAppScanFormat(attachment.fileName);
  // Always use the canonical authenticated file endpoint rather than the raw
  // storageKey URL, which is a host-specific URL saved at upload time and may
  // be stale after a domain change or redeployment.
  const href = attachment.id
    ? `${getApiOrigin()}/api/cases/${caseId}/attachments/${attachment.id}/file`
    : attachment.storageKey;
  // Only the backend-declared attachment id is used for textures. Never
  // interpret PLY comments or storage metadata as a URL.
  const textureHref =
    inAppFormat === "ply" &&
    (attachment.textureAttachmentId || attachment.scan?.textureAttachmentId)
      ? `${getApiOrigin()}/api/cases/${caseId}/attachments/${
          attachment.textureAttachmentId || attachment.scan?.textureAttachmentId
        }/file`
      : undefined;

  function onDelete() {
    if (deleteMutation.isPending) return;
    if (!window.confirm(`Delete "${attachment.fileName}"?`)) return;
    deleteMutation.mutate();
  }

  function onToggleVisibility() {
    if (visibilityMutation.isPending) return;
    visibilityMutation.mutate();
  }

  const electronAPI = (window as any).electronAPI;
  const canElectronPreview = !!(electronAPI?.previewFile && attachment.id);

  async function handleElectronPreview() {
    if (inAppFormat) {
      setScanViewerOpen(true);
      return;
    }
    if (isImage && href && (onAttachmentClick || onImageClick)) {
      if (onAttachmentClick) onAttachmentClick(attachment, href);
      else onImageClick!(href);
      return;
    }
    if (isVideo && href && (onAttachmentClick || onVideoClick)) {
      if (onAttachmentClick) {
        onAttachmentClick(attachment, href);
      } else {
        onVideoClick!(href, attachment.fileType || undefined, attachment.fileName);
      }
      return;
    }
    if (isPreviewing) return;
    setIsPreviewing(true);
    try {
      await previewAttachmentInElectron(caseId, attachment);
    } catch {
      if (href) await openFileAuthenticated(href);
    } finally {
      setIsPreviewing(false);
    }
  }

  function handleScanFallback() {
    // If the in-app viewer can't render the scan, fall back to the existing
    // Electron preview window or external open.
    if (canElectronPreview) {
      void (async () => {
        try {
          await previewAttachmentInElectron(caseId, attachment);
        } catch {
          if (href) await openFileAuthenticated(href);
        }
      })();
    } else if (href) {
      void openFileAuthenticated(href);
    }
  }

  const rowBody = (
    <>
      {inAppFormat && href ? (
        <ScanThumbnail
          cacheKey={`att:${attachment.id}`}
          fileUrl={href}
          format={inAppFormat}
          textureUrl={textureHref}
          authToken={getAccessToken()}
          size={44}
        />
      ) : isImage && href ? (
        <div className="mt-0.5 h-11 w-11 shrink-0 overflow-hidden rounded bg-secondary">
          <AuthedImage
            url={href}
            alt={attachment.fileName}
            className="h-full w-full object-cover"
            fallback={
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <ImageOff size={14} />
              </div>
            }
          />
        </div>
      ) : isVideo && href ? (
        <div className="relative mt-0.5 h-11 w-11 shrink-0 overflow-hidden rounded bg-black">
          <AuthedVideo
            url={href}
            mimeType={attachment.fileType || undefined}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
            loadingFallback={
              <div
                className="h-full w-full animate-pulse bg-secondary"
                aria-label="Loading video thumbnail"
              />
            }
            errorFallback={
              <div className="flex h-full w-full items-center justify-center text-white/70">
                <Video size={16} />
              </div>
            }
          />
          <span
            aria-label="Play video"
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 text-white"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/65">
              <Play size={13} fill="currentColor" />
            </span>
          </span>
        </div>
      ) : (
        <div className="mt-0.5 text-muted-foreground">
          {isScan ? <Box size={14} /> : <Paperclip size={14} />}
        </div>
      )}
      <div className="min-w-0 flex-1 text-left">
        <div className="font-medium truncate flex items-center gap-2" title={attachment.fileName}>
          <span className="truncate">{attachment.fileName}</span>
          <span
            className={
              "shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
              (isInternal
                ? "bg-amber-100 text-amber-800 border border-amber-200"
                : "bg-secondary text-muted-foreground border border-border")
            }
            title={
              isInternal
                ? "Only visible to lab staff"
                : "Visible to the provider"
            }
          >
            {isInternal ? <Lock size={10} /> : <Eye size={10} />}
            {isInternal ? "Lab only" : "Shared"}
          </span>
          {attachment.category === "outgoing" && (
            <span
              className="shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-blue-50 text-blue-700 border border-blue-200"
              title="Photo of the completed case as it left the lab"
              data-testid={`attachment-outgoing-badge-${attachment.id}`}
            >
              Outgoing
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {isScan ? "3D Scan" : isImage ? "Image" : isVideo ? "Video" : attachment.fileType || "File"}
          {attachment.uploaderName ? ` · ${attachment.uploaderName}` : ""}
          {attachment.createdAt ? ` · ${formatDate(attachment.createdAt)}` : ""}
        </div>
        {isScan && scanAccuracy ? (
          <div className="mt-1 text-[11px] text-muted-foreground" data-testid={`scan-accuracy-${attachment.id}`}>
            Condition: {conditionLabel} · {scanAccuracy.estimatedErrorRangeMm
              ? `Measured range up to ${scanAccuracy.estimatedErrorRangeMm.max} mm`
              : "No measured range for this condition"}
          </div>
        ) : null}
      </div>
    </>
  );

  const noteSection = isEditingNote ? (
    <div className="mt-2 space-y-1.5">
      <textarea
        value={noteDraft}
        onChange={(e) => setNoteDraft(e.target.value)}
        maxLength={1000}
        rows={2}
        autoFocus
        aria-label={`Note for ${attachment.fileName}`}
        placeholder="Add a note about this file…"
        className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={saveNote}
          disabled={noteMutation.isPending}
          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {noteMutation.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Check size={12} />
          )}
          Save
        </button>
        <button
          type="button"
          onClick={cancelEditingNote}
          disabled={noteMutation.isPending}
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
        >
          Cancel
        </button>
        {attachment.note ? (
          <button
            type="button"
            onClick={clearNote}
            disabled={noteMutation.isPending}
            className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 size={12} />
            Clear
          </button>
        ) : null}
      </div>
    </div>
  ) : attachment.note ? (
    <div className="mt-2 flex items-start gap-2">
      <div className="flex-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
        {attachment.note}
      </div>
      {canManage && (
        <button
          type="button"
          onClick={startEditingNote}
          className="shrink-0 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          title="Edit note"
        >
          <Pencil size={11} />
          Edit
        </button>
      )}
    </div>
  ) : canManage ? (
    <button
      type="button"
      onClick={startEditingNote}
      className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
    >
      <Plus size={11} />
      Add note
    </button>
  ) : null;

  return (
    <div className="border border-border rounded-md px-3 py-2 text-sm">
      <div className="flex items-start gap-3">
      {href ? (
        inAppFormat ? (
          <button
            type="button"
            onClick={() => setScanViewerOpen(true)}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`View "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : canElectronPreview ? (
          <button
            type="button"
            onClick={handleElectronPreview}
            disabled={isPreviewing}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-60 text-left"
            title={`Preview "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : isImage && (onAttachmentClick || onImageClick) ? (
          <button
            type="button"
            onClick={() =>
              onAttachmentClick
                ? onAttachmentClick(attachment, href)
                : onImageClick!(href)
            }
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`View "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : isVideo && (onAttachmentClick || onVideoClick) ? (
          <button
            type="button"
            onClick={() =>
              onAttachmentClick
                ? onAttachmentClick(attachment, href)
                : onVideoClick!(href, attachment.fileType || undefined, attachment.fileName)
            }
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`Play "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void openFileAuthenticated(href)}
            className="flex items-start gap-3 flex-1 min-w-0 -mx-1 -my-0.5 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors cursor-pointer text-left"
            title={`Open "${attachment.fileName}"`}
          >
            {rowBody}
          </button>
        )
      ) : (
        <div className="flex items-start gap-3 flex-1 min-w-0">{rowBody}</div>
      )}
      <div className="flex items-center gap-1">
        {canManage && (
          <button
            type="button"
            onClick={onToggleVisibility}
            disabled={visibilityMutation.isPending}
            className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label={
              isInternal
                ? `Share ${attachment.fileName} with provider`
                : `Mark ${attachment.fileName} as lab-only`
            }
            title={
              isInternal
                ? "Share with the provider"
                : "Mark as lab-only"
            }
          >
            {visibilityMutation.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : isInternal ? (
              <Eye size={13} />
            ) : (
              <EyeOff size={13} />
            )}
          </button>
        )}
        {href && (
          inAppFormat ? (
            <button
              type="button"
              onClick={() => setScanViewerOpen(true)}
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label={`Open ${attachment.fileName} in 3D viewer`}
              title="Open in 3D viewer"
            >
              <ExternalLink size={13} />
            </button>
          ) : isVideo && (onAttachmentClick || onVideoClick) ? (
            <button
              type="button"
              onClick={() =>
                onAttachmentClick
                  ? onAttachmentClick(attachment, href)
                  : onVideoClick!(href, attachment.fileType || undefined, attachment.fileName)
              }
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
              aria-label={`Play ${attachment.fileName}`}
              title="Play video"
            >
              <Play size={13} />
            </button>
          ) : canElectronPreview ? (
            <button
              type="button"
              onClick={handleElectronPreview}
              disabled={isPreviewing}
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
              aria-label={`Preview ${attachment.fileName}`}
              title="Preview file"
            >
              {isPreviewing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <ExternalLink size={13} />
              )}
            </button>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="h-7 w-7 rounded hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Open file"
            >
              <ExternalLink size={13} />
            </a>
          )
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={deleteMutation.isPending}
          className="h-7 w-7 rounded hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-50"
          aria-label={`Delete attachment ${attachment.fileName}`}
          title="Delete attachment"
        >
          {deleteMutation.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
        </button>
      </div>
      </div>
      {noteSection}
      {inAppFormat && href && (
        <ScanViewerModal
          open={scanViewerOpen}
          fileUrl={href}
          fileName={attachment.fileName}
          format={inAppFormat}
          authToken={getAccessToken()}
          onClose={() => setScanViewerOpen(false)}
          onFallback={handleScanFallback}
          textureUrl={textureHref}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div className="text-sm mt-0.5">{value || "—"}</div>
    </div>
  );
}

const RETURN_INTAKE_STATUSES = new Set(["received", "intake", "new", "pending"]);

/** Extract the `toStatus` value from a `status_changed` event's metadata. */
function getEventToStatus(ev: { eventType?: string | null; metadataJson?: unknown }): string | null {
  if (ev.eventType !== "status_changed") return null;
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && (ev.metadataJson as string).trim()) {
    try { meta = JSON.parse(ev.metadataJson as string); } catch { return null; }
  }
  if (!meta) return null;
  const to = meta.toStatus ?? meta.to ?? meta.newStatus ?? meta.status;
  return typeof to === "string" ? to.toLowerCase() : null;
}

/**
 * The calendar day a Case History row displays.
 *
 * Derived from the exact same formatter the row's timestamp uses
 * ({@link formatDateTime}), so the date grouping can never disagree with the
 * date the user reads on the row — a row labelled `08/12/2026` always lands in
 * the `08/12/2026` group, whatever the viewer's timezone.
 */
export function historyEventDayKey(ev: {
  occurredAt?: string | null;
  createdAt?: string | null;
}): string {
  const value = ev.occurredAt || ev.createdAt;
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Returns the set of event IDs that should be preceded by a "Case returned"
 * divider. Detection always runs on the chronologically-sorted sequence
 * (oldest first) so the result is the same regardless of the current display
 * sort order — callers match by event ID, not array index.
 */
function detectCaseReturnDividerEventIds(
  events: Array<{
    id?: string | null;
    occurredAt?: string | null;
    createdAt?: string | null;
    eventType?: string | null;
    metadataJson?: unknown;
  }>,
): Set<string> {
  // Always sort oldest-first for detection.
  const sorted = [...events].sort((a, b) => {
    const ta = new Date((a.occurredAt || a.createdAt || 0) as string).getTime();
    const tb = new Date((b.occurredAt || b.createdAt || 0) as string).getTime();
    return ta - tb;
  });
  const result = new Set<string>();
  for (let i = 1; i < sorted.length; i++) {
    const prevTo = getEventToStatus(sorted[i - 1]);
    const currTo = getEventToStatus(sorted[i]);
    if (
      prevTo && currTo &&
      RETURN_COMPLETE_STATUSES.has(prevTo) &&
      RETURN_INTAKE_STATUSES.has(currTo)
    ) {
      const id = sorted[i].id;
      if (id) result.add(id);
    }
  }
  return result;
}

/** Maps a wizard stage back to the question it belongs to, so both the Yes
 *  panel and its question advance to the same next question. */
const RETURN_WIZARD_QUESTION_OF: Partial<Record<ReturnWizardStage, ReturnWizardStage>> = {
  rxUpload: "rxAsk",
  remake: "remakeAsk",
  step: "stepAsk",
  notes: "notesAsk",
};

const RETURN_WIZARD_QUESTIONS = [
  "rxAsk",
  "remakeAsk",
  "stepAsk",
  "notesAsk",
  "labSlipAsk",
  "labelAsk",
] as const satisfies ReadonlyArray<ReturnWizardStage>;

/**
 * Next question after `from`, skipping questions the viewer may not answer.
 * Returns null when the wizard is finished.
 */
export function nextReturnWizardStage(
  from: ReturnWizardStage,
  allowed: { canEditStep: boolean; canPostNotes: boolean },
): ReturnWizardStage | null {
  const question = RETURN_WIZARD_QUESTION_OF[from] ?? from;
  const startIndex =
    question === "ask" || question === "date"
      ? 0
      : RETURN_WIZARD_QUESTIONS.indexOf(question as (typeof RETURN_WIZARD_QUESTIONS)[number]) + 1;
  for (let i = Math.max(startIndex, 0); i < RETURN_WIZARD_QUESTIONS.length; i++) {
    const stage = RETURN_WIZARD_QUESTIONS[i]!;
    if (stage === "stepAsk" && !allowed.canEditStep) continue;
    if (stage === "notesAsk" && !allowed.canPostNotes) continue;
    return stage;
  }
  return null;
}
