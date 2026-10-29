import {
  formatRxNoteScanDate,
  withPonticConnectorSuggestions,
  expandToothAssignmentIdentifiers,
  IMPLANT_FIELDS,
  isImplantRestoration,
  parseConnectorState,
  serializeConnectorState,
  suggestPonticConnectorPairs,
  toothAssignmentSummary,
  validateToothConnectors,
  type ImplantDetails,
} from "@workspace/case-taxonomy";
import { getCase as fetchToothAssignmentCase } from "@workspace/api-client-react";
import { ImplantDetailsControls, SavedImplantDetails } from "@/components/ImplantDetailsControls";
import { buildSharedCaseSlipHtml } from "@/lib/shared-case-slip";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Modal,
  RefreshControl,
  TextInput,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from "react-native";
import {
  KeyboardAvoidingView as ControllerKeyboardAvoidingView,
  KeyboardAwareScrollView,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCase,
  useCases,
  useInvoices,
  useInvoice,
  useCaseAttachments,
  useUpdateCase,
  useAddCaseNote,
  useAddCaseRestoration,
  useDeleteCaseRestoration,
  useUpdateCaseRestoration,
  useDeleteCaseAttachment,
  useGenerateInvoiceForCase,
  useEmailInvoice,
  getListLabInboxFilesQueryKey,
  getGetOrganizationQueryKey,
  useGetOrganization,
  type CanonicalCase,
  type UpdateCaseInput,
  type UpdateCaseInputStatus,
  type UpdateCaseInputPriority,
  type AddCaseNoteInputVisibility,
} from "@workspace/api-client-react";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resilientFetch, throwIfResNotOk } from "@/lib/query-client";
import {
  refreshCaseDetailQueries,
  useCaseRealtimeUpdates,
} from "@/lib/case-realtime";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import {
  peekSharedFiles,
  popSharedFiles,
  removeSharedFiles,
  subscribeSharedFileInbox,
  deriveSharedFileMeta,
  saveSharedFilesToUnassignedDocuments,
  type InboxEntry,
} from "@/lib/shared-file-inbox";
import {
  useMe,
  canEditOrg,
  isActiveMemberOfOrg,
  editableLabMemberships,
  activeMemberships,
  primaryProviderOrgId,
  primaryLabOrgId,
} from "@/lib/auth-me";
import { useLabLocations } from "@/lib/lab-locations";
import { printCaseLabel } from "@/lib/print-case-label";
import { ReturnedCaseWizard } from "@/components/ReturnedCaseWizard";
import {
  MOBILE_REMAKE_REASONS,
  RemakeReasonPicker,
} from "@/components/RemakeReasonPicker";
import { TypedCaseDateEntry } from "@/components/TypedCaseDateEntry";
import { CaseClinicalEditor } from "@/components/CaseClinicalEditor";
import { CaseHierarchyQuickPicker } from "@/components/CaseHierarchyQuickPicker";
import {
  clinicalDraftFromCase,
  buildClinicalPayload,
  saveClinicalDetails,
  clinicalSaveMessage,
} from "@/lib/case-clinical-edit";
import {
  RETURN_COMPLETE_STATUSES,
  RETURN_INTAKE_STATUSES,
  RETURN_STEP_OPTIONS,
  consumePendingReturnedWizard,
  firstReturnedWizardStage,
  isReturnedLocate,
  nextReturnedWizardStage,
  setPendingReturnedWizard,
  type ReturnedWizardStage,
} from "@/lib/returned-case-wizard";
import {
  CaseExceptionCreateSheet,
  CaseExceptionDetailSheet,
} from "@/components/CaseExceptionSheet";
import {
  EXCEPTION_QUEUE_QUERY_KEY,
  fetchActiveExceptions,
  type CaseExceptionQueueItem,
} from "@/lib/case-exceptions";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { BorderWidth, Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { ZoomableAuthedImage } from "@/components/ui/ZoomableAuthedImage";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { VideoThumbnail } from "@/components/ui/VideoThumbnail";
import {
  acquireAuthedMediaUri,
} from "@/lib/authed-media-cache";
import { DoctorReassignSheet } from "@/components/DoctorReassignSheet";
import { ReadOnlyToothChart } from "@/components/ReadOnlyToothChart";
import { ToothChart } from "@/components/ToothChart";
import {
  ToothActionSheet,
  type ToothActionPayload,
} from "@/components/ToothActionSheet";
import {
  deriveRxSummary,
  buildHighlightedToothSet,
  formatRxTeethLabel,
  parseToothField,
} from "@/lib/rx-summary";
import {
  formatDueDate,
  formatDueTime,
  parseDueTimeMinutes,
} from "@/lib/format";
import { isRemovableRestorationType } from "@/lib/restoration-category";
import { normalizeItemName } from "@workspace/item-name-match";
import {
  formatCalendarDate as formatSharedCalendarDate,
  isValidCalendarDate,
} from "@workspace/calendar-date";
import {
  getTaxonomyVocab,
  encodeRestorationSubtype,
  deriveCaseHierarchy,
  normalizeCaseHierarchy,
  getMaterialSubtypeLabel,
  getCaseTypeLabel,
  parseCustomToken,
  remakeReasonUsesField,
  type CaseType,
  type CaseSubtype,
  type MaterialSubtype,
  type CaseHierarchy,
  toothBridgeLabels,
} from "@workspace/case-taxonomy";
import {
  getGetCatalogTreeQueryKey,
  useGetCatalogTree,
} from "@workspace/api-client-react";
import { SuggestionInput } from "@/components/ui/SuggestionInput";
import {
  CASE_STATIONS as STATUS_OPTIONS,
  stationLabelFor,
} from "@/lib/case-stations";
import {
  attachmentFileUrl,
  isImageAttachment,
  openAttachmentPreview,
} from "@/lib/attachment-preview";
import {
  buildCaseCardHtml,
  buildInvoiceHtml,
  generatePdf,
  sharePdf,
  shouldIncludeProviderPreferencesOnLabSlip,
} from "@/lib/case-pdf";
import { printCaseHistory } from "@/lib/printCaseHistory";
import {
  setAiReaderSession,
  clearAiReaderSession,
} from "@/lib/ai-reader-store";
import { CaseQuickActionSheet } from "@/components/CaseQuickActionSheet";
import {
  isVideoAsset,
  isInlinePlayableVideo,
  resolveVideoMime,
  fileExtension,
} from "@/lib/video-asset";
import {
  prepareVideoForUpload,
  type VideoPreparationAsset,
} from "@/lib/prepare-video-upload";
import { confirmSaveAttachment } from "@/lib/save-attachment-prompt";
import { useLongPressGuard } from "@/lib/use-long-press-guard";
import { caseLocationLabel } from "@/lib/case-location-label";
import { isActiveCaseRecord } from "@/lib/case-quick-actions";
import { archSelectionFromRows, isArchRequired, type ArchSelection } from "@/lib/arch";
import { MobileToothShadeRows } from "@/components/case-detail/MobileToothShadeRows";
import { CaseDetailField, CaseDetailSelect, CaseDetailOptions, caseDetailFieldStyles } from "@/components/case-detail/CaseDetailField";
import { hasMixedCaseHierarchy, caseHierarchyLabels } from "@/lib/case-hierarchy-display";
import { CaseHierarchyDialogFields } from "@/components/case-detail/CaseHierarchyDialogFields";

// ─── Viewer-local detail shape ────────────────────────────────────────────────
// GET /api/cases/:id returns the full desktop DetailedCase payload. The
// generated `CanonicalCase` type loosely types `notes` as a string and uses
// `activityLog`, but the real payload carries structured `notes[]`, `events[]`,
// and the free-text Rx under `caseNotes`. We model exactly what we render here
// (read-only) and cast the hook result rather than editing generated code.
interface DetailNote {
  id: string;
  noteText?: string | null;
  visibility?: string | null;
  authorName?: string | null;
  createdAt?: string | null;
}
interface DetailEvent {
  id: string;
  /**
   * The case this event belongs to. The History tab merges entries from the
   * linked original case and from remake children, so this is NOT always the
   * case on screen — attachment URLs must be built from it (the /file route is
   * scoped to the case in its URL). Absent on legacy mobile events.
   */
  caseId?: string | null;
  eventType?: string | null;
  actorInitials?: string | null;
  actorName?: string | null;
  metadataJson?: unknown;
  occurredAt?: string | null;
  createdAt?: string | null;
}
interface DetailRestoration extends ImplantDetails {
  id?: string | null;
  toothNumber?: string | null;
  restorationType?: string | null;
  restorationSubtype?: string | null;
  material?: string | null;
  shade?: string | null;
  notes?: string | null;
  quantity?: number | null;
  arch?: "upper" | "lower" | null;
}
interface DetailRemakeRef {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  status?: string | null;
  labLocationId?: string | null;
  labLocationName?: string | null;
}
interface DetailedCase {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  doctorPreferences?: string | null;
  status?: string | null;
  labLocationId?: string | null;
  labLocationName?: string | null;
  priority?: string | null;
  receivedAt?: string | null;
  step?: "custom_tray" | "rims_and_plates" | "wax_setup" | "process" | null;
  stepShade?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  expectedDeliveryDate?: string | null;
  bridgeConnectors?: string | null;
  casePanBarcode?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  shade?: string | null;
  gingivialShade?: string | null;
  caseNotes?: string | null;
  rxNoteEntries?: Array<{
    id: string;
    caseId: string;
    noteText: string;
    scannedAt: string | null;
    provenance: "legacy" | "ai_reader" | "itero_import" | "case_intake";
  }>;
  teeth?: string | null;
  notes?: DetailNote[] | null;
  events?: DetailEvent[] | null;
  originalCaseEvents?: DetailEvent[] | null;
  /** One group per canonical remake child, each carrying that child's events. */
  remakeChildrenEvents?: Array<{
    caseId: string;
    caseNumber?: string | null;
    events?: DetailEvent[] | null;
  }> | null;
  restorations?: DetailRestoration[] | null;
  remakeOriginal?: DetailRemakeRef | null;
  remakeChildren?: DetailRemakeRef[] | null;
  remakeReason?: string | null;
  remakeNotes?: string | null;
  remakeCharged?: boolean | null;
  remakeReasonKey?: string | null;
  remakeShadeLightness?: "light" | "dark" | null;
  remakeShadePrescribed?: string | null;
  remakeShadeProvided?: string | null;
  remakeMaterialPrescribed?: string | null;
  remakeMaterialProvided?: string | null;
  remakeReturnedToLab?: boolean | null;
  remakeCategory?: "crown_bridge" | "removable" | null;
  organizationId?: string | null;
  labOrganizationId?: string | null;
  providerOrganizationId?: string | null;
  providerOrganizationContact?: {
    name?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
  } | null;
  needsAiReview?: boolean | null;
  aiImportSource?: string | null;
  /**
   * Distinct restoration material names that couldn't be mapped to a price
   * key (so they resolve to a $0 invoice line). Surfaced as a warning so an
   * admin can fix pricing before billing.
   */
  unrecognizedMaterials?: string[] | null;
  viewerCanUploadAttachments?: boolean | null;
  viewerCanPostNotes?: boolean | null;
  viewerQuickReferenceOrganizationId?: string | null;
  viewerCanManageAttachments?: boolean | null;
  providerAccountNumber?: string | null;
  // Custom-shade tracking fields (Task #3631)
  isCustomShade?: boolean | null;
  customShadeTechnician?: string | null;
  customShadePicturesAvailable?: boolean | null;
  customShadeVideoAvailable?: boolean | null;
  providerDoctorPreferences?: Record<string, unknown> | null;
  printProviderPreferencesOnLabSlips?: boolean | null;
}
type SectionKey =
  | "overview"
  | "restorations"
  | "notes"
  | "files"
  | "invoice"
  | "history";

type ScreenEditActions = {
  owner: string;
  onCancel: () => void;
  onSave: () => void;
  cancelLabel: string;
  saveLabel: string;
  cancelTestID: string;
  saveTestID: string;
  isSaving: boolean;
  disabled: boolean;
};

const SHADE_REASON_KEYS_MOBILE = new Set<string>(
  MOBILE_REMAKE_REASONS.filter((reason) =>
    remakeReasonUsesField(reason.key, "shade"),
  ).map((reason) => reason.key),
);
const MATERIAL_REASON_KEYS_MOBILE = new Set<string>(
  MOBILE_REMAKE_REASONS.filter((reason) =>
    remakeReasonUsesField(reason.key, "material"),
  ).map((reason) => reason.key),
);

const SECTIONS: {
  key: SectionKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "overview", label: "Overview", icon: "information-circle-outline" },
  { key: "restorations", label: "Restorations", icon: "construct-outline" },
  { key: "notes", label: "Notes", icon: "chatbox-ellipses-outline" },
  { key: "files", label: "Files", icon: "images-outline" },
  { key: "invoice", label: "Invoice", icon: "receipt-outline" },
  { key: "history", label: "History", icon: "time-outline" },
];

// ─── Formatting helpers ───────────────────────────────────────────────────────
function patientName(c: {
  patientFirstName?: string | null;
  patientLastName?: string | null;
}): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function uniqueJoin(items: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const v of items) {
    if (v && v.trim()) seen.add(titleCase(v.trim()));
  }
  return seen.size > 0 ? [...seen].join(", ") : "—";
}

/**
 * Friendly label for the removable workflow step. Driven by the same option
 * list the returned-case wizard uses, so mobile can never drift from desktop's
 * Custom Tray → Rims and Plates → Wax Setup → Process vocabulary.
 */
function stepLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return RETURN_STEP_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${mm}/${dd}/${d.getFullYear()} ${time}`;
}

function getHistoryDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHistoryDayLabel(iso: string | null | undefined): string {
  const d = getHistoryDate(iso);
  if (!d) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  return `${weekday}, ${mm}/${dd}/${d.getFullYear()}`;
}

function formatHistoryTime(iso: string | null | undefined): string {
  const d = getHistoryDate(iso);
  return d
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "—";
}

/**
 * The calendar day a Case History row displays.
 *
 * Keep this derived from the same local Date parts as the day header and time
 * shown in the row so grouping cannot disagree with the displayed timestamp.
 */
function historyEventDayKey(ev: {
  occurredAt?: string | null;
  createdAt?: string | null;
}): string {
  const d = getHistoryDate(ev.occurredAt ?? ev.createdAt);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toFixed(2)}`;
}

function statusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done"))
    return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery"))
    return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void"))
    return "draft";
  if (
    s.includes("intake") ||
    s.includes("new") ||
    s.includes("received") ||
    s.includes("pending")
  )
    return "intake";
  return "progress";
}

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  return "open";
}

// Mirror desktop formatEventType: the "Locate Case" action PATCHes the canonical
// case status, which the server records as a "status_changed" event. Users think
// of that as "locating" the case at a station, so surface it as "Location Changed".
function formatEventType(eventType?: string | null): string {
  if (!eventType) return "Event";
  if (eventType === "status_changed") return "Location Changed";
  if (eventType === "internal_exception_opened_note") {
    return "Internal Exception — Issue";
  }
  if (eventType === "internal_exception_note_added") {
    return "Internal Exception Note";
  }
  if (eventType === "internal_exception_resolution_note_added") {
    return "Internal Exception — Resolution Note";
  }
  return titleCase(eventType);
}

function isInternalExceptionNoteEvent(eventType?: string | null): boolean {
  return [
    "internal_exception_opened_note",
    "internal_exception_note_added",
    "internal_exception_resolution_note_added",
  ].includes(eventType ?? "");
}

// True when an attachment history event carries the "outgoing" category in its
// metadata — the photo of the completed case taken as it left the lab. Those
// events get a dedicated title instead of the generic "Attachment Added".
export function eventIsOutgoingPhoto(ev: {
  eventType?: string | null;
  metadataJson?: unknown;
}): boolean {
  if (!ev.eventType || !ev.eventType.includes("attachment")) return false;
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object")
        meta = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  return meta?.category === "outgoing";
}

// Resolve the stable note id an event references, checking the known key
// variants the server (and legacy paths) have used over time.
function eventNoteId(meta: Record<string, unknown>): string | null {
  return (
    (typeof meta.noteId === "string" && meta.noteId) ||
    (typeof meta.caseNoteId === "string" && meta.caseNoteId) ||
    (typeof meta.id === "string" && meta.id) ||
    null
  );
}

// Best-effort one-line description from a history event's metadata blob.
//
// For `note_added` events the note body is resolved by the event's stable note
// id against the viewer-authorized `notesById` map first, so internal lab-only
// notes the server withheld from this viewer are never surfaced. The server
// also strips note text from internal `note_added` event metadata for non-lab
// viewers, but resolving against the visible notes payload is the primary,
// defense-in-depth guard: if an event points at a note that is not in the
// viewer's visible notes, we never fall back to raw metadata text.
function eventDescription(
  ev: DetailEvent,
  notesById?: Map<string, DetailNote>,
): string | null {
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object")
        meta = parsed as Record<string, unknown>;
    } catch {
      return ev.metadataJson;
    }
  }
  if (!meta) return null;
  const from = meta.fromStatus ?? meta.from ?? meta.previousStatus;
  const to = meta.toStatus ?? meta.to ?? meta.newStatus ?? meta.status;
  if (typeof to === "string" && to) {
    return typeof from === "string" && from
      ? `${titleCase(from)} → ${titleCase(to)}`
      : titleCase(to);
  }
  if (ev.eventType === "note_added") {
    const noteId = eventNoteId(meta);
    if (noteId && notesById) {
      const matched = notesById.get(noteId);
      if (matched) return matched.noteText?.trim() || null;
      // Note id present but the note is not among the viewer's authorized
      // notes (an internal lab-only note hidden from a provider): never
      // reveal the body from raw metadata, even if a copy lingers there.
      return null;
    }
  }
  if (isInternalExceptionNoteEvent(ev.eventType)) {
    if (typeof meta.noteText === "string" && meta.noteText)
      return meta.noteText;
    if (typeof meta.note === "string" && meta.note) return meta.note;
    if (typeof meta.description === "string" && meta.description) {
      return meta.description;
    }
  }
  if (typeof meta.noteText === "string" && meta.noteText) return meta.noteText;
  if (typeof meta.note === "string" && meta.note) return meta.note;
  if (typeof meta.message === "string" && meta.message) return meta.message;
  if (typeof meta.description === "string" && meta.description)
    return meta.description;
  return null;
}

// Invoice lifecycle events (`invoice_updated` / `invoice_voided`, written by the
// server's bulk invoice-status handler) carry the affected invoice number in
// their metadata. Surface it on the timeline row so a mobile viewer can tell
// WHICH invoice changed, mirroring the desktop History tab.
function eventInvoiceNumber(ev: DetailEvent): string | null {
  if (ev.eventType !== "invoice_updated" && ev.eventType !== "invoice_voided") {
    return null;
  }
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object")
        meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!meta) return null;
  return typeof meta.invoiceNumber === "string" && meta.invoiceNumber
    ? meta.invoiceNumber
    : null;
}

// Plain-language one-line summary for invoice lifecycle events
// (`invoice_updated` / `invoice_voided`). Non-technical lab users read
// sentences, not a stacked title + invoice number + "Draft → Open" arrow, so
// collapse the affected invoice number and its resulting status into a single
// friendly line: "Invoice INV-9001 marked Open" or "Invoice INV-9002 voided".
// Returns null for any other event type so the default title/description
// rendering is used.
function eventInvoiceSummary(ev: DetailEvent): string | null {
  if (ev.eventType !== "invoice_updated" && ev.eventType !== "invoice_voided") {
    return null;
  }
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object")
        meta = parsed as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  const invoiceNumber =
    meta && typeof meta.invoiceNumber === "string" && meta.invoiceNumber
      ? meta.invoiceNumber
      : null;
  const newStatus =
    meta && typeof meta.newStatus === "string" && meta.newStatus
      ? meta.newStatus
      : null;
  const subject = invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice";
  if (ev.eventType === "invoice_voided" || newStatus === "void") {
    return `${subject} voided`;
  }
  if (newStatus) {
    return `${subject} marked ${titleCase(newStatus)}`;
  }
  return `${subject} updated`;
}

// Tappable attachment carried by a history event's metadata, mirroring desktop:
// prefer the legacy/mobile imageUri (works without auth headers, including data:
// URIs) and fall back to the canonical id-based /file route. Returns null for
// non-attachment events or when no openable source is present.
function eventAttachment(
  ev: DetailEvent,
  viewedCaseId: string,
): {
  url: string;
  attachmentId: string | null;
  fileName: string | null;
  fileType: string | null;
  isImage: boolean;
} | null {
  if (!ev.eventType || !ev.eventType.includes("attachment")) return null;
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object")
        meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!meta) return null;
  const fileType = meta.fileType != null ? String(meta.fileType) : null;
  const mediaKind = meta.mediaKind != null ? String(meta.mediaKind) : "";
  const fileName = meta.fileName != null ? String(meta.fileName) : null;
  const directSrc = meta.imageUri != null ? String(meta.imageUri) : null;
  const attachmentId =
    meta.attachmentId != null ? String(meta.attachmentId) : null;
  // The /file route is scoped to the case in its URL, so an event merged in
  // from the linked original case (or a remake child) must be fetched under
  // its OWN case — the viewed case is only the fallback for legacy events
  // that carry no case id.
  const owningCaseId = ev.caseId || viewedCaseId;
  const url =
    directSrc ||
    (attachmentId ? attachmentFileUrl(owningCaseId, attachmentId) : null);
  if (!url) return null;
  const isImage =
    fileType?.startsWith("image/") === true ||
    mediaKind === "photo" ||
    isImageAttachment(fileType, fileName);
  return { url, attachmentId, fileName, fileType, isImage };
}

interface CaseMediaItem {
  /** Stable attachment identity; history-only legacy media uses its event id. */
  id: string;
  url: string;
  fileName?: string | null;
  fileType?: string | null;
  kind: "image" | "video";
}

function isVideoAttachment(
  fileType?: string | null,
  fileName?: string | null,
): boolean {
  return isVideoAsset({ mimeType: fileType, fileName });
}

function isMediaAttachment(
  fileType?: string | null,
  fileName?: string | null,
): boolean {
  return (
    isImageAttachment(fileType, fileName) ||
    isVideoAttachment(fileType, fileName)
  );
}

/**
 * Build the gallery in the server's attachment order. History rows are only
 * allowed to contribute media owned by the case currently on screen; linked
 * original/remake events must never leak into this case's gallery.
 */
function buildCaseMediaSequence(
  caseId: string,
  attachments: Array<{
    id: string;
    fileName?: string | null;
    fileType?: string | null;
  }>,
  events: DetailEvent[],
): CaseMediaItem[] {
  const media: CaseMediaItem[] = [];
  const seen = new Set<string>();
  for (const a of attachments) {
    if (!a?.id || !isMediaAttachment(a.fileType, a.fileName)) continue;
    seen.add(a.id);
    media.push({
      id: a.id,
      url: attachmentFileUrl(caseId, a.id),
      fileName: a.fileName,
      fileType: a.fileType,
      kind: isVideoAttachment(a.fileType, a.fileName) ? "video" : "image",
    });
  }
  for (const ev of events) {
    if (ev.caseId && ev.caseId !== caseId) continue;
    const att = eventAttachment(ev, caseId);
    if (!att || !isMediaAttachment(att.fileType, att.fileName)) continue;
    const id = att.attachmentId || `history-${ev.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    media.push({
      id,
      url: att.url,
      fileName: att.fileName,
      fileType: att.fileType,
      kind: isVideoAttachment(att.fileType, att.fileName)
        ? "video"
        : "image",
    });
  }
  return media;
}

function isPlayableVideo(
  fileType?: string | null,
  fileName?: string | null,
): boolean {
  return isInlinePlayableVideo({ mimeType: fileType, fileName });
}

function AuthedVideo({
  url,
  fileName,
  fileType,
  style,
  testID,
  onPlaybackError,
}: {
  url: string;
  fileName?: string | null;
  fileType?: string | null;
  style?: React.ComponentProps<typeof Video>["style"];
  testID?: string;
  onPlaybackError?: () => void;
}) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nativeReady, setNativeReady] = useState(false);
  const playbackErrorReported = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let release = () => {};
    setLoadFailed(false);
    setNativeReady(false);
    playbackErrorReported.current = false;
    setLocalUri(null);
    const downloadTimeout = setTimeout(() => {
      if (!cancelled) setLoadFailed(true);
    }, 45_000);
    acquireAuthedMediaUri(url, undefined, fileName, fileType)
      .then((acquired) => {
        clearTimeout(downloadTimeout);
        if (cancelled) {
          acquired?.release();
          return;
        }
        if (acquired) {
          release = acquired.release;
          setLocalUri(acquired.uri);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        clearTimeout(downloadTimeout);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      clearTimeout(downloadTimeout);
      release();
    };
  }, [url, fileName, fileType]);
  useEffect(() => {
    if (!localUri || loadFailed || nativeReady) return;
    // Native decoders sometimes neither load nor report an error. Never leave
    // the viewer on a permanently blank player in that state.
    const timeout = setTimeout(() => setLoadFailed(true), 30_000);
    return () => clearTimeout(timeout);
  }, [localUri, loadFailed, nativeReady]);
  useEffect(() => {
    if (loadFailed && !playbackErrorReported.current) {
      playbackErrorReported.current = true;
      onPlaybackError?.();
    }
  }, [loadFailed, onPlaybackError]);
  if (loadFailed) return null;
  if (!localUri) {
    return (
      <ActivityIndicator
        color="#fff" /* hex-allow: fixed-dark video loading spinner */
        testID={`${testID}-loading`}
      />
    );
  }
  return (
    <Video
      source={{ uri: localUri }}
      style={style}
      useNativeControls
      shouldPlay
      resizeMode={ResizeMode.CONTAIN}
      onError={() => setLoadFailed(true)}
      onLoad={() => setNativeReady(true)}
      onPlaybackStatusUpdate={(status) => {
        if (status.isLoaded) {
          setNativeReady(true);
        } else if (status.error) {
          setLoadFailed(true);
        }
      }}
      testID={testID}
    />
  );
}

// Extracts the provider's note from a `file_assigned_from_inbox` event's
// metadata, mirroring the desktop timeline. Returns null for all other event
// types or when no note is present.
function eventInboxProviderNote(ev: DetailEvent): string | null {
  if (ev.eventType !== "file_assigned_from_inbox") return null;
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object")
        meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!meta) return null;
  return typeof meta.providerNote === "string" && meta.providerNote
    ? meta.providerNote
    : null;
}
function getMobileEventToStatus(ev: {
  eventType?: string | null;
  metadataJson?: unknown;
}): string | null {
  if (ev.eventType !== "status_changed") return null;
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (
    typeof ev.metadataJson === "string" &&
    (ev.metadataJson as string).trim()
  ) {
    try {
      meta = JSON.parse(ev.metadataJson as string);
    } catch {
      return null;
    }
  }
  if (!meta) return null;
  const to = meta.toStatus ?? meta.to ?? meta.newStatus ?? meta.status;
  return typeof to === "string" ? to.toLowerCase() : null;
}

/**
 * Returns the set of event IDs that should be preceded by a "Case returned"
 * divider. Detection always runs on the chronologically-sorted sequence so
 * the result is the same regardless of display order — callers match by event
 * ID, not array index.
 */
function detectMobileReturnDividerEventIds(
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
    const prevTo = getMobileEventToStatus(sorted[i - 1]);
    const currTo = getMobileEventToStatus(sorted[i]);
    if (
      prevTo &&
      currTo &&
      RETURN_COMPLETE_STATUSES.has(prevTo) &&
      RETURN_INTAKE_STATUSES.has(currTo)
    ) {
      const id = sorted[i].id;
      if (id) result.add(id);
    }
  }
  return result;
}

// ─── Edit constants (mirror desktop STATUS_FILTERS / priority exactly) ────────

const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "rush", label: "Rush" },
];

const PAYMENT_METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "ach", label: "ACH / Bank Transfer" },
  { value: "other", label: "Other" },
];

const VISIBILITY_OPTIONS: {
  value: AddCaseNoteInputVisibility;
  label: string;
}[] = [
  { value: "internal_lab_only", label: "Internal" },
  { value: "shared_with_provider", label: "Shared" },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// Taxonomy suggestions for the removable restoration type picker.
const _REMOVABLE_VOCAB = getTaxonomyVocab().filter(
  (e) => e.caseType === "removable",
);
const _REMOVABLE_SUGGESTIONS: string[] = [
  ...new Set(
    _REMOVABLE_VOCAB
      .map((e) => e.subtypeLabel)
      .filter((l): l is string => l !== null),
  ),
];
function _removableSubtypeKey(typeLabel: string): string | null {
  const entry = _REMOVABLE_VOCAB.find((e) => e.subtypeLabel === typeLabel);
  if (!entry) return null;
  return encodeRestorationSubtype({
    caseType: entry.caseType,
    subtype: entry.subtype,
    materialSubtype: null,
  });
}

// Taxonomy suggestions for the restoration type edit picker (all case types).
// Uses subtypeLabel as the display value so users see human-readable names.
const _ALL_VOCAB = getTaxonomyVocab();
const _ALL_TYPE_SUGGESTIONS: string[] = [
  ...new Set(
    _ALL_VOCAB
      .map((e) => e.subtypeLabel)
      .filter((l): l is string => l !== null),
  ),
];
/** Returns the encoded restorationSubtype key for a given subtype label, or null if not found. */
function _subtypeKeyForType(typeLabel: string): string | null {
  const entry = _ALL_VOCAB.find((e) => e.subtypeLabel === typeLabel);
  if (!entry) return null;
  return encodeRestorationSubtype({
    caseType: entry.caseType,
    subtype: entry.subtype,
    materialSubtype: null,
  });
}

// ─── Edit helpers ─────────────────────────────────────────────────────────────
function labelFor(
  options: { value: string; label: string }[],
  value: string | null | undefined,
): string {
  if (!value) return "—";
  return options.find((o) => o.value === value)?.label ?? titleCase(value);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Please try again.";
}

// Date-only strings stay in plain calendar space. Legacy timestamp payloads are
// still accepted by taking their UTC date prefix.
function toDateInput(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const datePrefix = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePrefix) ? datePrefix : null;
}

function toReceivedDateInput(value: string | null | undefined): string | null {
  return toDateInput(value);
}

function parseYMD(
  v: string | null | undefined,
): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map((n) => Number(n));
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function formatDateInput(value: string | null | undefined): string {
  const p = parseYMD(value);
  if (!p) return "—";
  return `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${p.y}`;
}

function todayYMD(): { y: number; m: number; d: number } {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftMonth(
  view: { y: number; m: number },
  delta: number,
): { y: number; m: number } {
  let m = view.m + delta;
  let y = view.y;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return { y, m };
}

interface OverviewForm {
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  priority: string;
  receivedAt: string | null;
  dueDate: string | null;
  /** Time-of-day string in 24-hour "HH:MM" form, or "" when unset. */
  dueTime: string;
  casePanBarcode: string;
  gingivialShade: string;
  rxNotes: string;
}

function formFromCase(c: DetailedCase): OverviewForm {
  return {
    patientFirstName: c.patientFirstName ?? "",
    patientLastName: c.patientLastName ?? "",
    doctorName: c.doctorName ?? "",
    priority: (c.priority ?? "normal").toLowerCase(),
    receivedAt: toReceivedDateInput(c.receivedAt),
    dueDate: toDateInput(c.dueDate),
    dueTime: c.dueTime ?? "",
    casePanBarcode: c.casePanBarcode ?? "",
    gingivialShade: (c.gingivialShade ?? "").trim(),
    rxNotes: c.caseNotes ?? "",
  };
}

// Build a minimal PATCH payload containing only changed editable fields. This
// mirrors the desktop drawer (no mobile-only writes) and avoids clobbering
// fields the user did not touch.
function buildOverviewPayload(
  c: DetailedCase,
  form: OverviewForm,
): UpdateCaseInput {
  const payload: UpdateCaseInput = {};
  if (form.patientFirstName !== (c.patientFirstName ?? "")) {
    payload.patientFirstName = form.patientFirstName;
  }
  if (form.patientLastName !== (c.patientLastName ?? "")) {
    payload.patientLastName = form.patientLastName;
  }
  if (form.doctorName !== (c.doctorName ?? "")) {
    payload.doctorName = form.doctorName;
  }
  if (
    form.priority &&
    form.priority !== (c.priority ?? "normal").toLowerCase()
  ) {
    payload.priority = form.priority as UpdateCaseInputPriority;
  }
  const originalReceivedAt = toReceivedDateInput(c.receivedAt);
  if (form.receivedAt && form.receivedAt !== originalReceivedAt) {
    payload.receivedAt = form.receivedAt;
  }
  const origDue = toDateInput(c.dueDate);
  if (form.dueDate && form.dueDate !== origDue) {
    payload.dueDate = form.dueDate;
  }
  // Only send dueTime when it actually changed. If dueDate is ALSO changing
  // in this payload the server uses this value directly; if dueDate is
  // omitted, the server keeps dueTime untouched, which is exactly what we
  // want when the user only edited the date and left the time alone.
  const origTime = c.dueTime ?? "";
  if (form.dueTime !== origTime) {
    payload.dueTime = form.dueTime ? form.dueTime : null;
  }
  const origBarcode = c.casePanBarcode ?? "";
  if (form.casePanBarcode !== origBarcode) {
    payload.casePanBarcode = form.casePanBarcode;
  }
  const origGingivalShade = (c.gingivialShade ?? "").trim();
  if (form.gingivialShade !== origGingivalShade) {
    payload.gingivialShade = form.gingivialShade.trim() || null;
  }
  if (form.rxNotes !== (c.caseNotes ?? "")) {
    payload.rxNotes = form.rxNotes.trim() ? form.rxNotes : null;
  }
  return payload;
}

// ─── Reusable edit controls (JS-only; no native picker/date deps) ────────────
function EditTextRow({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize,
  testID,
  multiline,
  stacked = false,
  styles,
  colors,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  testID?: string;
  multiline?: boolean;
  stacked?: boolean;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.editRow}>
      <Text style={stacked ? [caseDetailFieldStyles.heading, { color: colors.text }] : styles.editLabel}>{label}</Text>
      <TextInput
        style={[styles.input, stacked && caseDetailFieldStyles.input, multiline && { minHeight: 90, textAlignVertical: "top" }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize={autoCapitalize ?? "words"}
        testID={testID}
        accessibilityLabel={label}
        multiline={multiline}
      />
    </View>
  );
}

function SelectRow({
  label,
  valueLabel,
  icon,
  onPress,
  styles,
  colors,
  testID,
  valueTextStyle,
  disabled = false,
  stacked = false,
}: {
  label: string;
  valueLabel: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
  testID?: string;
  valueTextStyle?: React.ComponentProps<typeof Text>["style"];
  disabled?: boolean;
  stacked?: boolean;
}) {
  return (
    <View style={styles.editRow}>
      <Text style={stacked ? [caseDetailFieldStyles.heading, { color: colors.text }] : styles.editLabel}>{label}</Text>
      <Pressable
        style={[styles.selectValue, stacked && caseDetailFieldStyles.control]}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${valueLabel}`}
        accessibilityState={disabled ? { disabled: true } : undefined}
        testID={testID}
      >
        <Text style={[styles.selectValueText, stacked && caseDetailFieldStyles.value, valueTextStyle]}>{valueLabel}</Text>
        <Ionicons
          name={icon ?? "chevron-down"}
          size={16}
          color={colors.textSecondary}
        />
      </Pressable>
    </View>
  );
}

function SegmentedRow({
  label,
  options,
  value,
  onChange,
  styles,
  testID,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  styles: Styles;
  testID?: string;
}) {
  return (
    <View style={styles.editRow}>
      <Text style={styles.editLabel}>{label}</Text>
      <View style={styles.segment}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              style={[styles.segmentBtn, on && styles.segmentBtnActive]}
              onPress={() => onChange(o.value)}
              testID={`${testID ?? "segment"}-${o.value}`}
            >
              <Text
                style={[styles.segmentText, on && styles.segmentTextActive]}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function OptionPickerModal({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose,
  styles,
  colors,
}: {
  visible: boolean;
  title: string;
  // `id` is optional: options whose `value` is not unique (two lab locations
  // can map to the same workflow status) pass one so each row stays its own
  // selectable entry. When present it — not `value` — is the row's identity,
  // and it is what `selected` is compared against / `onSelect` receives.
  options: { value: string; label: string; id?: string }[];
  selected: string | null;
  onSelect: (v: string) => void;
  onClose: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView
            style={styles.optionScroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            {options.map((o) => {
              const key = o.id ?? o.value;
              const on = key === selected;
              return (
                <Pressable
                  key={key}
                  style={styles.optionRow}
                  onPress={() => onSelect(key)}
                  testID={`option-${key}`}
                >
                  <Text
                    style={[styles.optionText, on && styles.optionTextActive]}
                  >
                    {o.label}
                  </Text>
                  {on ? (
                    <Ionicons name="checkmark" size={18} color={colors.tint} />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable style={styles.sheetCancel} onPress={onClose}>
            <Text style={styles.sheetCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DatePickerModal({
  visible,
  title,
  value,
  onSelect,
  onClear,
  onClose,
  allowTyping = false,
  styles,
  colors,
}: {
  visible: boolean;
  title: string;
  value: string | null;
  onSelect: (v: string) => void;
  onClear?: () => void;
  onClose: () => void;
  allowTyping?: boolean;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [typing, setTyping] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const p = parseYMD(value) ?? todayYMD();
    return { y: p.y, m: p.m };
  });

  useEffect(() => {
    if (visible) {
      setTyping(false);
      const p = parseYMD(value) ?? todayYMD();
      setView({ y: p.y, m: p.m });
    }
  }, [visible, value]);

  const selected = parseYMD(value);
  const today = todayYMD();
  const daysInMonth = new Date(view.y, view.m, 0).getDate();
  const firstWeekday = new Date(view.y, view.m - 1, 1).getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <ControllerKeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <Pressable style={styles.sheetBackdrop} onPress={() => { Keyboard.dismiss(); onClose(); }}>
        <DismissKeyboardView style={styles.sheet}>
          <Text style={styles.sheetTitle}>{title}</Text>
          {typing ? (
            <TypedCaseDateEntry
              value={value}
              onConfirm={onSelect}
              onBack={() => setTyping(false)}
              onCancel={onClose}
            />
          ) : (
          <>
          <View style={styles.calHeader}>
            <Pressable
              style={styles.calNav}
              onPress={() => setView((v) => shiftMonth(v, -1))}
              hitSlop={8}
              testID="cal-prev"
            >
              <Ionicons name="chevron-back" size={20} color={colors.text} />
            </Pressable>
            <Text style={styles.calMonth}>
              {MONTH_NAMES[view.m - 1]} {view.y}
            </Text>
            <Pressable
              style={styles.calNav}
              onPress={() => setView((v) => shiftMonth(v, 1))}
              hitSlop={8}
              testID="cal-next"
            >
              <Ionicons name="chevron-forward" size={20} color={colors.text} />
            </Pressable>
          </View>
          <View style={styles.calWeekRow}>
            {WEEKDAYS.map((w) => (
              <Text key={w} style={styles.calWeekday}>
                {w}
              </Text>
            ))}
          </View>
          <View style={styles.calGrid}>
            {cells.map((d, i) => {
              if (d === null) {
                return <View key={`blank-${i}`} style={styles.calCell} />;
              }
              const isSel =
                !!selected &&
                selected.y === view.y &&
                selected.m === view.m &&
                selected.d === d;
              const isToday =
                today.y === view.y && today.m === view.m && today.d === d;
              return (
                <Pressable
                  key={`d-${d}`}
                  style={[styles.calCell, isSel && styles.calCellSelected]}
                  onPress={() => onSelect(ymd(view.y, view.m, d))}
                  testID={`cal-day-${d}`}
                >
                  <Text
                    style={[
                      styles.calCellText,
                      isToday && styles.calCellTextToday,
                      isSel && styles.calCellTextSelected,
                    ]}
                  >
                    {d}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {allowTyping && (
            <Pressable
              style={styles.calTypeButton}
              onPress={() => setTyping(true)}
              accessibilityRole="button"
              accessibilityLabel="Type date in MM/DD/YYYY format"
              testID="cal-type"
            >
              <Ionicons name="create-outline" size={18} color={colors.tint} />
              <Text style={styles.sheetCancelText}>Type date (MM/DD/YYYY)</Text>
            </Pressable>
          )}
          <View style={styles.calFooter}>
            {onClear ? (
              <Pressable
                style={styles.sheetCancel}
                onPress={onClear}
                testID="cal-clear"
              >
                <Text style={styles.sheetCancelText}>Clear</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <Pressable style={styles.sheetCancel} onPress={onClose}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </View>
          </>
          )}
        </DismissKeyboardView>
      </Pressable>
      </ControllerKeyboardAvoidingView>
    </Modal>
  );
}

const TIME_HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
function CaseDeleteMobileModal({
  caseId,
  visible,
  onClose,
  onSuccess,
  styles,
  colors,
}: {
  caseId: string;
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const [step, setStep] = useState<"pin" | "confirm" | "otp">("pin");
  const [pin, setPin] = useState("");
  const [otp, setOtp] = useState("");
  // The sheet body already swallows taps so they never close the modal; it
  // also carries keyboard dismissal for the PIN/code fields.
  const dismissKeyboard = useDismissKeyboardOnTap();
  const [deleteSessionToken, setDeleteSessionToken] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(600);

  useEffect(() => {
    if (visible) {
      setStep("pin");
      setPin("");
      setOtp("");
      setDeleteSessionToken(null);
      setError(null);
      setIsPending(false);
      setSecondsLeft(600);
    }
  }, [visible]);

  useEffect(() => {
    if (step !== "otp") return;
    const intervalId = setInterval(
      () => setSecondsLeft((s) => Math.max(0, s - 1)),
      1000,
    );
    return () => clearInterval(intervalId);
  }, [step]);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  async function submitPin() {
    if (!pin.trim() || isPending) return;
    setIsPending(true);
    setError(null);
    try {
      const res = await resilientFetch("/api/cases/delete-initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPin: pin.trim(), caseIds: [caseId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Incorrect PIN.");
      setDeleteSessionToken(data.data.deleteSessionToken);
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
      const res = await resilientFetch("/api/cases/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseIds: [caseId],
          deleteSessionToken,
          smsOtpCode: otp.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error ?? "Incorrect code or session expired.");
      }
      onSuccess();
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : "Incorrect code or session expired.",
      );
    } finally {
      setIsPending(false);
    }
  }

  async function resendCode() {
    if (!pin || isPending) return;
    setIsPending(true);
    setError(null);
    try {
      const res = await resilientFetch("/api/cases/delete-initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPin: pin.trim(), caseIds: [caseId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not resend code.");
      setDeleteSessionToken(data.data.deleteSessionToken);
      setOtp("");
      setSecondsLeft(600);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not resend code.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={isPending ? undefined : onClose}
        >
          <Pressable
            style={[styles.sheet, { gap: Spacing.sm }]}
            onPress={dismissKeyboard}
            testID="case-delete-keyboard-dismiss"
          >
            {step === "pin" && (
              <>
                <Text style={styles.sheetTitle}>Delete Case</Text>
                <Text
                  style={[
                    styles.editLabel,
                    { color: colors.textSecondary, textAlign: "center" },
                  ]}
                >
                  Enter the admin PIN. A verification code will be sent to the
                  lab owner's email.
                </Text>
                <TextInput
                  style={[styles.input, { textAlign: "center" }]}
                  value={pin}
                  onChangeText={setPin}
                  placeholder="Admin PIN"
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  autoFocus
                  onSubmitEditing={() => void submitPin()}
                  editable={!isPending}
                />
                {error ? (
                  <Text
                    style={[
                      styles.editLabel,
                      { color: colors.error, textAlign: "center" },
                    ]}
                  >
                    {error}
                  </Text>
                ) : null}
                <View
                  style={{
                    flexDirection: "row",
                    gap: Spacing.sm,
                    marginTop: Spacing.xs,
                  }}
                >
                  <Pressable
                    style={[styles.sheetCancel, { flex: 1 }]}
                    onPress={onClose}
                    disabled={isPending}
                  >
                    <Text style={styles.sheetCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.labelPrintBtn,
                      {
                        flex: 1,
                        backgroundColor: colors.error,
                        opacity: isPending || !pin.trim() ? 0.6 : 1,
                      },
                    ]}
                    onPress={() => void submitPin()}
                    disabled={isPending || !pin.trim()}
                  >
                    {isPending ? (
                      <ActivityIndicator
                        size="small"
                        color="#fff"
                        style={{ marginRight: 4 }}
                      />
                    ) : null}
                    <Text style={styles.labelPrintBtnText}>Next</Text>
                  </Pressable>
                </View>
              </>
            )}
            {step === "confirm" && (
              <>
                <Text style={styles.sheetTitle}>Confirm Deletion</Text>
                <Text
                  style={[
                    styles.editLabel,
                    { color: colors.textSecondary, textAlign: "center" },
                  ]}
                >
                  This will permanently delete this case. A code will be sent to
                  the lab owner's email. This cannot be undone.
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    gap: Spacing.sm,
                    marginTop: Spacing.xs,
                  }}
                >
                  <Pressable
                    style={[styles.sheetCancel, { flex: 1 }]}
                    onPress={onClose}
                  >
                    <Text style={styles.sheetCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.labelPrintBtn,
                      { flex: 1, backgroundColor: colors.error },
                    ]}
                    onPress={() => {
                      setStep("otp");
                      setSecondsLeft(600);
                    }}
                  >
                    <Text style={styles.labelPrintBtnText}>Yes, send code</Text>
                  </Pressable>
                </View>
              </>
            )}
            {step === "otp" && (
              <>
                <Text style={styles.sheetTitle}>Enter Email Code</Text>
                <Text
                  style={[
                    styles.editLabel,
                    { color: colors.textSecondary, textAlign: "center" },
                  ]}
                >
                  {
                    "A 6-digit code was sent to the lab owner's email.\nExpires in "
                  }
                  <Text
                    style={{
                      color:
                        secondsLeft === 0 ? colors.error : colors.textSecondary,
                    }}
                  >
                    {secondsLeft === 0 ? "expired" : `${mm}:${ss}`}
                  </Text>
                  .
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      textAlign: "center",
                      letterSpacing: 8,
                      fontVariant: ["tabular-nums"] as any,
                    },
                  ]}
                  value={otp}
                  onChangeText={(t) => setOtp(t.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoFocus
                  onSubmitEditing={() => void submitOtp()}
                  editable={!isPending}
                />
                {error ? (
                  <Text
                    style={[
                      styles.editLabel,
                      { color: colors.error, textAlign: "center" },
                    ]}
                  >
                    {error}
                  </Text>
                ) : null}
                <Pressable
                  onPress={() => void resendCode()}
                  disabled={isPending}
                >
                  <Text
                    style={[
                      styles.editLabel,
                      { color: colors.tint, textAlign: "center" },
                    ]}
                  >
                    Resend code
                  </Text>
                </Pressable>
                <View
                  style={{
                    flexDirection: "row",
                    gap: Spacing.sm,
                    marginTop: Spacing.xs,
                  }}
                >
                  <Pressable
                    style={[styles.sheetCancel, { flex: 1 }]}
                    onPress={onClose}
                    disabled={isPending}
                  >
                    <Text style={styles.sheetCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.labelPrintBtn,
                      {
                        flex: 1,
                        backgroundColor: colors.error,
                        opacity:
                          isPending || otp.length < 6 || secondsLeft === 0
                            ? 0.6
                            : 1,
                      },
                    ]}
                    onPress={() => void submitOtp()}
                    disabled={isPending || otp.length < 6 || secondsLeft === 0}
                  >
                    {isPending ? (
                      <ActivityIndicator
                        size="small"
                        color="#fff"
                        style={{ marginRight: 4 }}
                      />
                    ) : null}
                    <Text style={styles.labelPrintBtnText}>Delete</Text>
                  </Pressable>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function CaseDetailScreen() {
  const { id, recordPaymentInvoiceId } = useLocalSearchParams<{
    id: string;
    recordPaymentInvoiceId?: string | string[];
  }>();
  // Web-only deep link from the invoice register; ignored on native.
  const payDeepLinkInvoiceId =
    Platform.OS === "web"
      ? (Array.isArray(recordPaymentInvoiceId) ? recordPaymentInvoiceId[0] : recordPaymentInvoiceId) || null
      : null;
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [active, setActive] = useState<SectionKey>(payDeepLinkInvoiceId ? "invoice" : "overview");
  const [presentedCaseId, setPresentedCaseId] = useState(id);
  // Reused routes initialize before rendering the new case. Refetches, focus,
  // and clearing a consumed payment parameter must not reset a chosen section.
  if (presentedCaseId !== id) {
    setPresentedCaseId(id);
    setActive(payDeepLinkInvoiceId ? "invoice" : "overview");
  }
  const [screenEditActions, setScreenEditActions] = useState<
    ScreenEditActions[]
  >([]);
  const activeScreenEditActions =
    screenEditActions[screenEditActions.length - 1] ?? null;
  const registerScreenEditActions = useCallback(
    (actions: ScreenEditActions) => {
      setScreenEditActions((current) => {
        const existingIndex = current.findIndex(
          (entry) => entry.owner === actions.owner,
        );
        if (existingIndex >= 0) {
          return current.map((entry, index) =>
            index === existingIndex ? { ...entry, ...actions } : entry,
          );
        }
        return [...current, actions];
      });
    },
    [],
  );
  const updateScreenEditActions = useCallback(
    (owner: string, updates: Partial<ScreenEditActions>) => {
      setScreenEditActions((current) =>
        current.map((entry) =>
          entry.owner === owner ? { ...entry, ...updates, owner } : entry,
        ),
      );
    },
    [],
  );
  const unregisterScreenEditActions = useCallback((owner: string) => {
    setScreenEditActions((current) =>
      current.filter((entry) => entry.owner !== owner),
    );
  }, []);
  useEffect(() => {
    if (payDeepLinkInvoiceId) setActive("invoice");
  }, [payDeepLinkInvoiceId]);
  const [lightboxMediaId, setLightboxMediaId] = useState<string | null>(null);
  const [standaloneMedia, setStandaloneMedia] = useState<CaseMediaItem | null>(
    null,
  );
  const [videoErrorMediaId, setVideoErrorMediaId] = useState<string | null>(
    null,
  );
  // The Prescription Preview modal lives inside OverviewSection, but the
  // History tab's "View Rx" button on a returned-case entry opens it too, so
  // the open flag is owned here.
  const [rxPreviewOpen, setRxPreviewOpen] = useState(false);
  const {
    markLongPress: markLightboxLongPress,
    consumeLongPress: consumeLightboxLongPress,
  } = useLongPressGuard();

  // A WebSocket channel (useCaseRealtimeUpdates below) pushes an immediate
  // refetch whenever this case changes server-side (e.g. a desktop admin
  // editing the Case Type, which PATCHes the first restoration's
  // restorationType). The refetchInterval here is only a safety net for when
  // the socket is disconnected (backgrounded app, network handoff, server
  // restart) — it no longer needs to be short since the socket handles the
  // common case, but stays lengthy rather than zero because push delivery
  // isn't guaranteed.
  const caseQuery = useCase(id, { refetchInterval: 120_000 });
  const c = (caseQuery.data ?? null) as unknown as DetailedCase | null;

  useFocusEffect(
    useCallback(() => {
      if (id) caseQuery.refetch();
      // Only re-run when the case id changes; caseQuery identity changes on
      // every render (new object from useQuery) and would otherwise refetch
      // in a loop.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]),
  );

  const attachmentsQuery = useCaseAttachments(id);
  const attachments = attachmentsQuery.data ?? [];

  const invoicesQuery = useInvoices({ caseId: id });
  const invoiceList = invoicesQuery.data ?? [];
  const primaryInvoiceId = invoiceList.length > 0 ? invoiceList[0].id : null;
  const invoiceQuery = useInvoice(primaryInvoiceId);
  const invoice = invoiceQuery.data ?? invoiceList[0] ?? null;
  const qcForRemake = useQueryClient();

  // A single case-updated push can be the result of a case-field edit (e.g.
  // status/step), an attachment upload, or a restoration/pricing change that
  // resyncs the invoice — the mobile screen shows all three from independent
  // queries, so every push must refetch all of them, not just the case
  // itself, or attachments/invoice totals stay stale until the next manual
  // refresh or the 120s safety-net poll catches up.
  useCaseRealtimeUpdates(
    id,
    useCallback(() => {
      if (id) void refreshCaseDetailQueries(qcForRemake, id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]),
  );

  // Detect any alloy line that is unpriced.  The server's GET /api/invoices/:id
  // derives priced:false at serialization time for any invoice line whose
  // description starts with "Alloy" and whose unitPrice is $0 — so this signal
  // is reliable for both persisted canonical invoices and list-endpoint rows.
  // We check both the top-level items array and their nested subItems because
  // alloy lines are usually sub-items (one per PFM tooth) but can also appear
  // as top-level lines on single-restoration cases.
  const hasUnpricedAlloyLine = (() => {
    type AlloyItem = { description?: string | null; priced?: boolean };
    type LineItem = AlloyItem & { subItems?: AlloyItem[] };
    const alloyUnpriced = (item: AlloyItem) =>
      item.priced === false && (item.description ?? "").startsWith("Alloy");
    const lineItems = (invoice?.items ??
      invoice?.lineItems ??
      []) as LineItem[];
    return lineItems.some(
      (l) => alloyUnpriced(l) || (l.subItems ?? []).some(alloyUnpriced),
    );
  })();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRemakeModal, setShowRemakeModal] = useState(false);
  const [remakeReasonKey, setRemakeReasonKey] = useState("");
  const [remakeCustomReason, setRemakeCustomReason] = useState("");
  const [remakeCharge, setRemakeCharge] = useState<boolean | null>(null);
  const [remakeReturnedToLab, setRemakeReturnedToLab] = useState<
    boolean | null
  >(null);
  const [remakeShadeLightness, setRemakeShadeLightness] = useState<
    "light" | "dark" | ""
  >("");
  const [remakeShadePrescribed, setRemakeShadePrescribed] = useState("");
  const [remakeShadeProvided, setRemakeShadeProvided] = useState("");
  const [remakeMaterialPrescribed, setRemakeMaterialPrescribed] = useState("");
  const [remakeMaterialProvided, setRemakeMaterialProvided] = useState("");
  const [remakeNotes, setRemakeNotes] = useState("");
  const [remakeLoading, setRemakeLoading] = useState(false);
  const [remakeError, setRemakeError] = useState<string | null>(null);
  const remakeSubmitInFlightRef = useRef(false);
  const createRemakeCustomReasonRef = useRef<TextInput>(null);
  const editRemakeCustomReasonRef = useRef<TextInput>(null);

  const [showEditRemakeModal, setShowEditRemakeModal] = useState(false);
  const [editRemakeLoading, setEditRemakeLoading] = useState(false);
  const [editRemakeError, setEditRemakeError] = useState<string | null>(null);

  function selectRemakeReason(key: string) {
    if (key !== "other") {
      createRemakeCustomReasonRef.current?.blur?.();
      editRemakeCustomReasonRef.current?.blur?.();
    }
    setRemakeReasonKey(key);
    if (key !== "other") setRemakeCustomReason("");
    if (!SHADE_REASON_KEYS_MOBILE.has(key)) {
      setRemakeShadeLightness("");
      setRemakeShadePrescribed("");
      setRemakeShadeProvided("");
    }
    if (!MATERIAL_REASON_KEYS_MOBILE.has(key)) {
      setRemakeMaterialPrescribed("");
      setRemakeMaterialProvided("");
    }
  }

  useEffect(() => {
    if (remakeReasonKey === "other") {
      if (showEditRemakeModal) {
        editRemakeCustomReasonRef.current?.focus();
      } else if (showRemakeModal) {
        createRemakeCustomReasonRef.current?.focus();
      }
    } else {
      createRemakeCustomReasonRef.current?.blur?.();
      editRemakeCustomReasonRef.current?.blur?.();
    }
  }, [remakeReasonKey, showEditRemakeModal, showRemakeModal]);

  function openEditRemake() {
    setRemakeReasonKey(c?.remakeReasonKey ?? "");
    setRemakeCustomReason(c?.remakeReasonKey === "other" ? c.remakeReason ?? "" : "");
    setRemakeCharge(
      c?.remakeCharged === true
        ? true
        : c?.remakeCharged === false
          ? false
          : null,
    );
    setRemakeReturnedToLab(c?.remakeReturnedToLab ?? null);
    setRemakeShadeLightness(
      (c?.remakeShadeLightness ?? "") as "light" | "dark" | "",
    );
    setRemakeShadePrescribed(c?.remakeShadePrescribed ?? "");
    setRemakeShadeProvided(c?.remakeShadeProvided ?? "");
    setRemakeMaterialPrescribed(c?.remakeMaterialPrescribed ?? "");
    setRemakeMaterialProvided(c?.remakeMaterialProvided ?? "");
    setRemakeNotes(c?.remakeNotes ?? "");
    setEditRemakeError(null);
    setShowEditRemakeModal(true);
  }

  async function handleEditRemakeSubmit() {
    if (!remakeReasonKey || remakeCharge === null) return;
    if (remakeReasonKey === "other" && (!remakeCustomReason.trim() || remakeCustomReason.trim().length > 2000)) {
      setEditRemakeError(!remakeCustomReason.trim() ? "Enter a custom remake reason." : "Custom remake reason must be 2000 characters or fewer.");
      return;
    }
    const found = MOBILE_REMAKE_REASONS.find((r) => r.key === remakeReasonKey);
    const reasonLabel = remakeReasonKey === "other" ? remakeCustomReason.trim() : found?.label ?? remakeReasonKey;
    const category = found?.category ?? null;
    const isShadeReason = SHADE_REASON_KEYS_MOBILE.has(remakeReasonKey);
    const isMaterialReason = MATERIAL_REASON_KEYS_MOBILE.has(remakeReasonKey);
    setEditRemakeLoading(true);
    setEditRemakeError(null);
    try {
      await resilientFetch(`/api/cases/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remakeReasonKey,
          remakeReason: reasonLabel,
          remakeCharged: remakeCharge,
          remakeReturnedToLab: remakeReturnedToLab ?? undefined,
          remakeCategory: category,
          ...(isShadeReason && {
            remakeShadeLightness: remakeShadeLightness || undefined,
            remakeShadePrescribed: remakeShadePrescribed || undefined,
            remakeShadeProvided: remakeShadeProvided || undefined,
          }),
          ...(isMaterialReason && {
            remakeMaterialPrescribed: remakeMaterialPrescribed || undefined,
            remakeMaterialProvided: remakeMaterialProvided || undefined,
          }),
          remakeNotes: remakeNotes.trim() || null,
        }),
      });
      setShowEditRemakeModal(false);
      resetRemakeState();
      qcForRemake.invalidateQueries({ queryKey: ["cases"] });
      qcForRemake.invalidateQueries({ queryKey: ["cases", id] });
    } catch (e: unknown) {
      setEditRemakeError(
        e instanceof Error ? e.message : "Failed to update remake reason.",
      );
    } finally {
      setEditRemakeLoading(false);
    }
  }

  function resetRemakeState() {
    setRemakeReasonKey("");
    setRemakeCustomReason("");
    setRemakeCharge(null);
    setRemakeReturnedToLab(null);
    setRemakeShadeLightness("");
    setRemakeShadePrescribed("");
    setRemakeShadeProvided("");
    setRemakeMaterialPrescribed("");
    setRemakeMaterialProvided("");
    setRemakeNotes("");
    setRemakeError(null);
  }

  async function handleRemakeSubmit() {
    // State updates are asynchronous; use a ref as well as the disabled button
    // so two rapid taps cannot create two remakes before the next render.
    if (remakeSubmitInFlightRef.current || remakeLoading) return;
    if (!remakeReasonKey || remakeCharge === null) return;
    if (remakeReasonKey === "other" && (!remakeCustomReason.trim() || remakeCustomReason.trim().length > 2000)) {
      setRemakeError(!remakeCustomReason.trim() ? "Enter a custom remake reason." : "Custom remake reason must be 2000 characters or fewer.");
      return;
    }
    const found = MOBILE_REMAKE_REASONS.find((r) => r.key === remakeReasonKey);
    const reasonLabel = remakeReasonKey === "other" ? remakeCustomReason.trim() : found?.label ?? remakeReasonKey;
    const category = found?.category ?? undefined;
    const isShadeReason = SHADE_REASON_KEYS_MOBILE.has(remakeReasonKey);
    const isMaterialReason = MATERIAL_REASON_KEYS_MOBILE.has(remakeReasonKey);
    remakeSubmitInFlightRef.current = true;
    setRemakeLoading(true);
    setRemakeError(null);
    try {
      const response = await resilientFetch(`/api/cases/${id}/remake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remakeReasonKey,
          remakeReason: reasonLabel,
          remakeCharged: remakeCharge,
          remakeReturnedToLab: remakeReturnedToLab ?? undefined,
          remakeCategory: category,
          ...(isShadeReason && {
            remakeShadeLightness: remakeShadeLightness || undefined,
            remakeShadePrescribed: remakeShadePrescribed || undefined,
            remakeShadeProvided: remakeShadeProvided || undefined,
          }),
          ...(isMaterialReason && {
            remakeMaterialPrescribed: remakeMaterialPrescribed || undefined,
            remakeMaterialProvided: remakeMaterialProvided || undefined,
          }),
          ...(remakeNotes.trim() ? { remakeNotes: remakeNotes.trim() } : {}),
        }),
      });
      await throwIfResNotOk(response);
      const payload: unknown = await response.json();
      const envelope =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : null;
      const result =
        envelope?.data && typeof envelope.data === "object"
          ? (envelope.data as Record<string, unknown>)
          : envelope;
      const newId = typeof result?.id === "string" ? result.id : "";
      const newNumber =
        typeof result?.caseNumber === "string" ? result.caseNumber : "";
      if (!newId) {
        throw new Error(
          "The server did not confirm the new case ID. Check the case list before trying again.",
        );
      }
      setShowRemakeModal(false);
      resetRemakeState();
      qcForRemake.invalidateQueries({ queryKey: ["cases"] });
      qcForRemake.invalidateQueries({ queryKey: ["cases", id] });
      // A remake started from the returned-case wizard navigates to the newly
      // created case — park the closing questions there so the sequence
      // converges instead of ending at the remake branch.
      if (remakeFromWizardRef.current) {
        remakeFromWizardRef.current = false;
        const resume = nextReturnedWizardStage("remake", {
          canChangeStep: canChangeReturnedStep,
        });
        if (resume) setPendingReturnedWizard(newId, resume);
      }
      router.push(`/case/${newId}` as never);
      void Alert.alert(
        "Remake Created",
        newNumber
          ? `Case #${newNumber} was created as a remake.`
          : "The new remake case was created.",
      );
    } catch (e: unknown) {
      setRemakeError(
        e instanceof Error
          ? e.message
          : "The remake could not be confirmed. Check the case list before trying again.",
      );
    } finally {
      remakeSubmitInFlightRef.current = false;
      setRemakeLoading(false);
    }
  }

  const qc = useQueryClient();

  const meQuery = useMe();
  const caseOrgId = c?.organizationId ?? c?.labOrganizationId ?? null;
  const canEdit = canEditOrg(meQuery.data, caseOrgId);

  // Pure provider redirect: if the signed-in user has no active lab membership
  // but does have a provider org, this screen will 403. Redirect to the
  // provider-scoped view so they see shared notes, files, and status changes.
  // This handles deep-links, notification taps, and any navigation from a
  // case list that isn't provider-aware.
  useEffect(() => {
    const me = meQuery.data;
    if (!me || !id) return;
    const hasLabMembership = activeMemberships(me).some(
      (m) => (m.organization?.type ?? "").toLowerCase() === "lab",
    );
    if (!hasLabMembership && primaryProviderOrgId(me) !== null) {
      router.replace(`/case/provider/${id}` as never);
    }
  }, [meQuery.data, id]);

  // Any active lab member can upload files and add notes.
  // Prefer server-side flag when available; fall back to local membership check.
  const canUpload = useMemo(() => {
    if (typeof c?.viewerCanUploadAttachments === "boolean")
      return c.viewerCanUploadAttachments;
    const memberships = (meQuery.data as any)?.memberships ?? [];
    return memberships.some(
      (m: any) =>
        (m.labId === caseOrgId || m.organizationId === caseOrgId) &&
        m.status === "active",
    );
  }, [c?.viewerCanUploadAttachments, meQuery.data, caseOrgId]);

  const canPostNotes = useMemo(() => {
    if (typeof c?.viewerCanPostNotes === "boolean") return c.viewerCanPostNotes;
    return canUpload;
  }, [c?.viewerCanPostNotes, canUpload]);

  // Admin/owner-only: can initiate the 3-step case deletion flow.
  const isAdminOfCase = useMemo(() => {
    const memberships = (meQuery.data as any)?.memberships ?? [];
    return memberships.some(
      (m: any) =>
        (m.labId === caseOrgId || m.organizationId === caseOrgId) &&
        (m.role === "admin" || m.role === "owner") &&
        m.status === "active",
    );
  }, [meQuery.data, caseOrgId]);

  // Lab name for PDF headers: resolve the viewer's membership org that owns this case.
  const labName = useMemo(() => {
    const memberships =
      (
        meQuery.data as
          | {
              memberships?: {
                organizationId?: string | null;
                organization?: { name?: string | null } | null;
              }[];
            }
          | null
          | undefined
      )?.memberships ?? [];
    const match = memberships.find((m) => m.organizationId === caseOrgId);
    return match?.organization?.name ?? null;
  }, [meQuery.data, caseOrgId]);

  // Share-intent consumer: when files were shared into LabTrax from another app
  // (root layout writes them to the inbox), offer to attach them to THIS case
  // OR save them straight to the lab's Unassigned Documents inbox. Confirming
  // "Attach" hands the entries to FilesSection's upload pipeline; confirming
  // "Save to Unassigned Documents" runs the shared save pipeline directly.
  // Either choice clears the inbox so the Cases-list "waiting to attach"
  // banner resets.
  const [pendingShared, setPendingShared] = useState<InboxEntry[] | null>(null);
  const [savingSharedToInbox, setSavingSharedToInbox] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const sharePromptOpenRef = useRef(false);

  const handleSaveSharedToUnassigned = useCallback(
    async (entries: InboxEntry[]) => {
      if (entries.length === 0) return;
      let labOrganizationId = primaryLabOrgId(meQuery.data) ?? "";
      if (!labOrganizationId && (meQuery.isLoading || meQuery.isPending)) {
        try {
          const freshMe = await meQuery.refetch();
          labOrganizationId = primaryLabOrgId(freshMe.data) ?? "";
        } catch {
          // ignore — falls through to the "no lab" alert below
        }
      }
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
      // Only consume the entries that actually saved — anything that failed
      // stays in the shared-file inbox so the user doesn't lose it and can
      // retry (the next prompt/banner will pick it up again).
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
    },
    [meQuery, qc],
  );

  useEffect(() => {
    let cancelled = false;
    async function checkInbox() {
      if (!canUpload || sharePromptOpenRef.current) return;
      const entries = await peekSharedFiles();
      if (cancelled || entries.length === 0 || sharePromptOpenRef.current)
        return;
      sharePromptOpenRef.current = true;
      Alert.alert(
        "Attach shared files?",
        `${entries.length} file${entries.length === 1 ? "" : "s"} shared with LabTrax. Attach ${
          entries.length === 1 ? "it" : "them"
        } to this case, or save ${entries.length === 1 ? "it" : "them"} to Unassigned Documents?`,
        [
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              Alert.alert(
                "Discard shared files?",
                `This will remove the ${entries.length} file${
                  entries.length === 1 ? "" : "s"
                } shown in this prompt from this device.`,
                [
                  {
                    text: "Cancel",
                    style: "cancel",
                    onPress: () => {
                      sharePromptOpenRef.current = false;
                    },
                  },
                  {
                    text: "Discard",
                    style: "destructive",
                    onPress: () => {
                      void (async () => {
                        await removeSharedFiles(entries);
                        sharePromptOpenRef.current = false;
                      })();
                    },
                  },
                ],
              );
            },
          },
          {
            text: "Save to Unassigned Documents",
            onPress: () => {
              // Do NOT pop the inbox here — handleSaveSharedToUnassigned only
              // removes entries that actually finish saving, so a failed
              // upload doesn't silently vanish.
              sharePromptOpenRef.current = false;
              void handleSaveSharedToUnassigned(entries);
            },
          },
          {
            text: "Attach",
            onPress: () => {
              void (async () => {
                const popped = await popSharedFiles();
                setPendingShared(popped);
                setActive("files");
                sharePromptOpenRef.current = false;
              })();
            },
          },
        ],
      );
    }
    void checkInbox();
    const unsub = subscribeSharedFileInbox(() => void checkInbox());
    return () => {
      cancelled = true;
      unsub();
    };
  }, [canEdit, canUpload, handleSaveSharedToUnassigned]);

  const rxSummary = useMemo(
    () =>
      deriveRxSummary(
        (c?.restorations ?? []).map((r) => ({
          restorationType: r.restorationType ?? null,
          material: r.material ?? null,
          toothNumber: r.toothNumber ?? null,
        })),
      ),
    [c?.restorations],
  );
  const highlightedTeeth = useMemo(
    () => buildHighlightedToothSet(rxSummary),
    [rxSummary],
  );

  const history = useMemo(() => {
    // Each entry keeps the case it belongs to so attachment URLs resolve
    // against the owning case, not the case on screen.
    const merged: DetailEvent[] = [
      ...(c?.events ?? []),
      ...(c?.originalCaseEvents ?? []).map((ev) => ({
        ...ev,
        caseId: ev.caseId ?? c?.remakeOriginal?.id ?? null,
      })),
      ...(c?.remakeChildrenEvents ?? []).flatMap((rc) =>
        (rc?.events ?? []).map((ev) => ({
          ...ev,
          caseId: ev.caseId ?? rc?.caseId ?? null,
        })),
      ),
    ];
    const seen = new Set<string>();
    const deduped = merged.filter((ev) => {
      if (!ev?.id || seen.has(ev.id)) return false;
      seen.add(ev.id);
      return true;
    });
    deduped.sort((a, b) => {
      const ta = new Date(a.occurredAt ?? a.createdAt ?? 0).getTime();
      const tb = new Date(b.occurredAt ?? b.createdAt ?? 0).getTime();
      return tb - ta;
    });
    return deduped;
  }, [
    c?.events,
    c?.originalCaseEvents,
    c?.remakeChildrenEvents,
    c?.remakeOriginal?.id,
  ]);

  const mediaSequence = useMemo(
    () => buildCaseMediaSequence(id, attachments, history),
    [id, attachments, history],
  );
  const lightboxMedia = useMemo(
    () =>
      lightboxMediaId
        ? mediaSequence.find((item) => item.id === lightboxMediaId) ?? null
        : null,
    [lightboxMediaId, mediaSequence],
  );
  const viewerMedia = lightboxMedia ?? standaloneMedia;
  const videoPlaybackFailed =
    viewerMedia?.kind === "video" && videoErrorMediaId === viewerMedia.id;
  const lightboxIndex = lightboxMedia
    ? mediaSequence.findIndex((item) => item.id === lightboxMedia.id)
    : -1;

  // Keep an open gallery attached to the selected identity across attachment
  // refreshes. If the selected attachment was deleted, close rather than
  // silently showing whichever item moved into its old array index.
  useEffect(() => {
    if (lightboxMediaId && !lightboxMedia) setLightboxMediaId(null);
  }, [lightboxMediaId, lightboxMedia]);

  const openGalleryAt = useCallback((item: CaseMediaItem) => {
    setStandaloneMedia(null);
    setLightboxMediaId(item.id);
    setVideoErrorMediaId(null);
  }, []);
  const openStandaloneMedia = useCallback((item: CaseMediaItem) => {
    setLightboxMediaId(null);
    setStandaloneMedia(item);
    setVideoErrorMediaId(null);
  }, []);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as never);
  }

  // Open the native print dialog with a formatted case history document.
  async function handlePrintHistory() {
    if (!c) return;
    try {
      await printCaseHistory(c, history, c.notes ?? []);
    } catch (e) {
      Alert.alert("Couldn't print history", errorMessage(e));
    }
  }

  // Render the case work-order card to a PDF and hand it to the OS share sheet.
  async function handlePrintCaseCard() {
    if (!c) return;
    try {
      // Read the current canonical case immediately before generating a
      // shareable document, rather than printing stale React Query data.
      const caseRes = await resilientFetch(
        `/api/cases/${encodeURIComponent(c.id)}`,
      );
      if (!caseRes.ok)
        throw new Error(
          `Could not load the latest case details (${caseRes.status}).`,
        );
      const caseBody = (await caseRes.json()) as {
        data?: DetailedCase;
      } & DetailedCase;
      const currentCase = caseBody.data ?? caseBody;
      if (!currentCase || typeof currentCase !== "object") {
        throw new Error("Could not load the latest case details.");
      }

      let orgTemplate: {
        template?: unknown;
        isCustom?: boolean | null;
      } | null = null;
      const printOrgId =
        currentCase.labOrganizationId ?? currentCase.organizationId ?? null;
      if (printOrgId) {
        try {
          const templateRes = await resilientFetch(
            `/api/organizations/${encodeURIComponent(printOrgId)}/case-print-template?caseId=${encodeURIComponent(currentCase.id)}`,
          );
          if (!templateRes.ok) throw new Error(`Could not load the shared lab-slip template (${templateRes.status}).`);
          if (templateRes.ok) {
            const templateBody = (await templateRes.json()) as {
              data?: { template?: unknown; isCustom?: boolean | null };
            };
            orgTemplate = templateBody.data ?? null;
          }
        } catch (error) {
          throw new Error("Could not load the shared lab-slip template. Check your connection and try again.", { cause: error });
        }
      }
      const html = await buildSharedCaseSlipHtml({
        caseNumber: currentCase.caseNumber,
        patientName: patientName(currentCase),
        doctorName: currentCase.doctorName,
        dueDate: currentCase.dueDate,
        priority: currentCase.priority,
        status: currentCase.status,
        rxNotes: currentCase.caseNotes,
        rxNoteEntries: currentCase.rxNoteEntries,
        restorations: currentCase.restorations ?? [],
        bridgeConnectors: currentCase.bridgeConnectors,
        labName,
        remakeReason: currentCase.remakeReason ?? null,
        remakeNotes: currentCase.remakeNotes ?? null,
        gingivialShade: currentCase.gingivialShade ?? null,
        providerDoctorPreferences:
          currentCase.providerDoctorPreferences ?? null,
        printProviderPreferencesOnLabSlips:
          shouldIncludeProviderPreferencesOnLabSlip(
            currentCase.printProviderPreferencesOnLabSlips,
            orgTemplate,
          ),
      }, orgTemplate, { caseId: currentCase.id, labOrganizationId: printOrgId, step: currentCase.step, stepShade: currentCase.stepShade, dueTime: currentCase.dueTime, doctorPreferences: currentCase.doctorPreferences, providerOrganizationContact: currentCase.providerOrganizationContact });
      const { uri } = await generatePdf(html);
      await sharePdf(uri, {
        dialogTitle: currentCase.caseNumber
          ? `Case #${currentCase.caseNumber}`
          : "Case",
      });
    } catch (e) {
      Alert.alert("Couldn't create PDF", errorMessage(e));
    }
  }

  // ── Returned-case wizard ──────────────────────────────────────────────────
  // When a case is located from a complete status back to an intake status the
  // lab is starting work on it again, so we walk the user through the whole
  // set of "what changed?" questions rather than a single due-date prompt.
  // The wizard always lives here (the detail screen); other surfaces that can
  // perform the same locate hand off through the pending-stage store.
  const [wizardStage, setWizardStage] = useState<ReturnedWizardStage | null>(
    null,
  );
  // Distinguishes a remake started from inside the wizard (which must resume
  // the closing questions) from one started via the header button.
  const remakeFromWizardRef = useRef(false);
  const canChangeReturnedStep = canEdit && isAdminOfCase;

  // Resume a parked stage: set by the locate sheet on another screen, by the
  // AI reader on its way back, or by a wizard-initiated remake.
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      const pending = consumePendingReturnedWizard(id);
      if (pending) setWizardStage(pending);
    }, [id]),
  );

  const startReturnedWizard = useCallback(() => {
    setWizardStage(
      firstReturnedWizardStage({ canChangeStep: canChangeReturnedStep }),
    );
  }, [canChangeReturnedStep]);

  // Opens the AI reader in attach-to-this-case mode. The reader analyses the
  // pages and uploads them here as an attachment — it never creates a case.
  const handleWizardScanRx = useCallback(() => {
    if (!c) return;
    // Park the next question so the reader's router.back() lands on it.
    setPendingReturnedWizard(
      id,
      nextReturnedWizardStage("rxScan", {
        canChangeStep: canChangeReturnedStep,
      }) ?? "notes",
    );
    setWizardStage(null);
    clearAiReaderSession();
    setAiReaderSession({
      caseId: id,
      attachToCaseId: id,
      caseNumber: c.caseNumber ?? null,
      patientName: patientName(c) || null,
      doctorName: c.doctorName ?? null,
      dueDate: c.dueDate ?? null,
      labOrgId: c.labOrganizationId ?? c.organizationId ?? null,
      labName: labName ?? null,
      gingivialShade: c.gingivialShade ?? null,
    });
    // attach=1 tells the capture screen not to reset the session it was just
    // handed (see AiReaderCaptureScreen).
    router.push("/ai-reader/capture?new=1&attach=1" as never);
  }, [c, id, canChangeReturnedStep, labName]);

  const handleWizardStartRemake = useCallback(() => {
    remakeFromWizardRef.current = true;
    setWizardStage(null);
    resetRemakeState();
    setShowRemakeModal(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the remake protocol without submitting drops the user back into
  // the wizard at the question after the remake one.
  function closeRemakeModal() {
    if (remakeLoading) return;
    setShowRemakeModal(false);
    resetRemakeState();
    if (remakeFromWizardRef.current) {
      remakeFromWizardRef.current = false;
      setWizardStage(
        nextReturnedWizardStage("remake", {
          canChangeStep: canChangeReturnedStep,
        }),
      );
    }
  }

  function onRefresh() {
    caseQuery.refetch();
    attachmentsQuery.refetch();
    invoicesQuery.refetch();
    invoiceQuery.refetch();
  }

  const refreshing =
    caseQuery.isFetching ||
    invoicesQuery.isFetching ||
    attachmentsQuery.isFetching;

  // ── Loading / error / not-found states ──
  if (caseQuery.isLoading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (caseQuery.isError || !c) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header title="Case" onBack={goBack} styles={styles} colors={colors} />
        <View style={styles.center}>
          <Ionicons
            name="alert-circle-outline"
            size={40}
            color={colors.textTertiary}
          />
          <Text style={styles.emptyTitle}>Unable to load this case</Text>
          <Text style={styles.emptyBody}>
            It may have been moved, or your session needs a refresh.
          </Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => caseQuery.refetch()}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View testID="case-top-header">
      <Header
        title="Case"
        subtitle={patientName(c)}
        onBack={goBack}
        styles={styles}
        colors={colors}
        isRush={(c.priority ?? "normal").toLowerCase() === "rush"}
        right={
          <View style={styles.headerRightGroup}>
            <Pressable
              onPress={() => router.push(`/ai-assistant?caseId=${id}` as never)}
              hitSlop={8}
              style={styles.headerIconBtn}
              testID="case-ask-maynard-btn"
              accessibilityLabel="Ask LabTrax Assistant about this case"
            >
              <Ionicons name="sparkles-outline" size={20} color={colors.tint} />
            </Pressable>
            {isAdminOfCase && (
              <Pressable
                onPress={() => {
                  setRemakeReasonKey("");
                  setRemakeCharge(null);
                  setRemakeReturnedToLab(null);
                  setRemakeError(null);
                  setShowRemakeModal(true);
                }}
                hitSlop={8}
                style={styles.headerIconBtn}
                testID="case-remake-btn"
                accessibilityLabel="Create a remake of this case"
              >
                <Ionicons
                  name="git-branch-outline"
                  size={20}
                  color={colors.tint}
                />
              </Pressable>
            )}
            {isAdminOfCase && (
              <Pressable
                onPress={() => setShowDeleteModal(true)}
                hitSlop={8}
                style={styles.headerIconBtn}
                testID="case-delete-btn"
                accessibilityLabel="Delete case"
              >
                <Ionicons name="trash-outline" size={20} color={colors.error} />
              </Pressable>
            )}
            {active === "history" ? (
              <Pressable
                onPress={handlePrintHistory}
                hitSlop={8}
                style={styles.headerIconBtn}
                testID="case-print-history"
                accessibilityLabel="Print case history"
              >
                <Ionicons name="print-outline" size={20} color={colors.text} />
              </Pressable>
            ) : (
              <Pressable
                onPress={handlePrintCaseCard}
                hitSlop={8}
                style={styles.headerIconBtn}
                testID="case-print"
                accessibilityLabel="Print case card"
              >
                <Ionicons name="print-outline" size={20} color={colors.text} />
              </Pressable>
            )}
          </View>
        }
      />
      <CaseHeaderLocator
        key={c.id}
        c={c}
        canEdit={canEdit}
        editing={screenEditActions.some((actions) => actions.owner === "case-details")}
        onSaved={() => caseQuery.refetch()}
        onReturnedLocate={startReturnedWizard}
        styles={styles}
        colors={colors}
      />
      </View>

      {savingSharedToInbox ? (
        <View style={styles.sharedSaveBanner}>
          <ActivityIndicator size="small" color={colors.tint} />
          <Text style={styles.sharedSaveBannerText}>
            Saving to Unassigned Documents… ({savingSharedToInbox.completed}/
            {savingSharedToInbox.total})
          </Text>
        </View>
      ) : null}

      {/* Section switcher */}
      <View style={styles.tabsWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.tabsRow}
        >
          {SECTIONS.map((s) => {
            const on = s.key === active;
            return (
              <Pressable
                key={s.key}
                onPress={() => setActive(s.key)}
                style={[styles.tab, on && styles.tabActive]}
                testID={`section-tab-${s.key}`}
                accessibilityState={{ selected: on }}
              >
                <Ionicons
                  name={s.icon}
                  size={15}
                  color={on ? colors.textInverse : colors.textSecondary}
                />
                <Text style={[styles.tabLabel, on && styles.tabLabelActive]}>
                  {s.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ControllerKeyboardAvoidingView
        style={styles.caseBodyWithActionBar}
        behavior="padding"
      >
        <ScrollView
          style={styles.caseBodyScroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={scrollKeyboardDismissMode}
          testID="case-detail-body"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.tint}
            />
          }
        >
        {/* Keep the tap-to-dismiss responder below the scroll owner. A
            full-screen touchable around this ScrollView can win the initial
            center-origin drag before native scrolling starts. */}
        <DismissKeyboardView style={styles.body} testID="case-detail-keyboard-dismiss">
        {c.unrecognizedMaterials && c.unrecognizedMaterials.length > 0 && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: Spacing.sm,
              backgroundColor: colors.errorSurface,
              borderWidth: 1,
              borderColor: colors.errorLight,
              borderRadius: 10,
              padding: Spacing.md,
              marginBottom: Spacing.md,
            }}
            testID="unrecognized-material-warning"
          >
            <Ionicons
              name="alert-circle-outline"
              size={18}
              color={colors.error}
              style={{ marginTop: 1 }}
            />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "700",
                  color: colors.errorText,
                }}
              >
                Unrecognized{" "}
                {c.unrecognizedMaterials.length === 1
                  ? "material"
                  : "materials"}
                : {c.unrecognizedMaterials.join(", ")}
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: colors.errorText,
                  marginTop: 2,
                  opacity: 0.85,
                }}
              >
                {c.unrecognizedMaterials.length === 1
                  ? "This material"
                  : "These materials"}{" "}
                couldn't be matched to a price, so the affected{" "}
                {c.unrecognizedMaterials.length === 1
                  ? "restoration was"
                  : "restorations were"}{" "}
                added to the draft invoice at $0. Fix the material name or set
                the price manually before billing.
              </Text>
            </View>
          </View>
        )}

        {active === "overview" && (
          <OverviewSection
            c={c}
            caseId={c.id}
            canEdit={canEdit}
            isAdmin={isAdminOfCase}
            labName={labName}
            labOrganizationId={c.labOrganizationId ?? c.organizationId ?? null}
            onSaved={() => caseQuery.refetch()}
            onGoToInvoice={() => setActive("invoice")}
            onEditRemake={canEdit ? openEditRemake : undefined}
            styles={styles}
            colors={colors}
            isRush={(c.priority ?? "normal").toLowerCase() === "rush"}
            rxPreviewOpen={rxPreviewOpen}
            onRxPreviewOpenChange={setRxPreviewOpen}
            activeScreenActionOwner={activeScreenEditActions?.owner ?? null}
            registerScreenEditActions={registerScreenEditActions}
            updateScreenEditActions={updateScreenEditActions}
            unregisterScreenEditActions={unregisterScreenEditActions}
          />
        )}

        {active === "restorations" && (
          <RestorationsSection
            restorations={c.restorations ?? []}
            bridgeConnectors={c.bridgeConnectors ?? null}
            highlighted={highlightedTeeth}
            teethLabel={formatRxTeethLabel(rxSummary)}
            caseId={c.id}
            labOrganizationId={c.labOrganizationId ?? c.organizationId ?? null}
            canEdit={canEdit}
            isAdmin={isAdminOfCase}
            onSaved={() => caseQuery.refetch()}
            styles={styles}
            colors={colors}
          />
        )}

        {hasUnpricedAlloyLine && (
          <View
            testID="unpriced-alloy-badge"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: Spacing.sm,
              backgroundColor: colors.warningSurface,
              borderWidth: 1,
              borderColor: colors.warning,
              borderRadius: 10,
              padding: Spacing.md,
              marginBottom: Spacing.md,
            }}
          >
            <Ionicons
              name="warning-outline"
              size={16}
              color={colors.warningStrong}
            />
            <Text
              style={{
                fontSize: 13,
                fontWeight: "600",
                color: colors.warningStrong,
                flex: 1,
              }}
            >
              Alloy pricing needed — set the alloy price before sending the
              invoice.
            </Text>
          </View>
        )}

        {active === "notes" && (
          <NotesSection
            caseNotes={c.caseNotes}
            notes={c.notes ?? []}
            caseId={c.id}
            canPostNotes={canPostNotes}
            canEdit={canEdit}
            onSaved={() => caseQuery.refetch()}
            styles={styles}
            colors={colors}
            labOrganizationId={
              c.viewerQuickReferenceOrganizationId ??
              c.labOrganizationId ??
              c.organizationId ??
              null
            }
          />
        )}

        {active === "files" && (
          <FilesSection
            caseId={c.id}
            attachments={attachments}
            mediaSequence={mediaSequence}
            loading={attachmentsQuery.isLoading}
            onOpenMedia={openGalleryAt}
            canUpload={canUpload}
            canEdit={canEdit}
            onRefresh={onRefresh}
            pendingShared={pendingShared}
            onConsumedShared={() => setPendingShared(null)}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "invoice" && (
          <InvoiceSection
            invoice={invoice}
            loading={invoicesQuery.isLoading || invoiceQuery.isLoading}
            canEdit={canEdit}
            caseId={c.id}
            invoiceId={primaryInvoiceId}
            autoOpenPaymentForInvoiceId={payDeepLinkInvoiceId}
            patientName={patientName(c)}
            caseNumber={c.caseNumber ?? null}
            labName={labName}
            onRefresh={onRefresh}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "history" && (
          <HistorySection
            events={history}
            notes={c.notes ?? []}
            caseId={c.id}
            mediaSequence={mediaSequence}
            onOpenMedia={openGalleryAt}
            onOpenStandaloneMedia={openStandaloneMedia}
            onViewRx={() => {
              // The preview modal is rendered by OverviewSection and can only
              // ever show the case currently open, so surface it before
              // opening. Unlike the desktop drawer this does not preview a
              // linked entry's own case (documented fallback behavior).
              setActive("overview");
              setRxPreviewOpen(true);
            }}
            styles={styles}
            colors={colors}
          />
        )}
        </DismissKeyboardView>
        </ScrollView>
        {active === "overview" && activeScreenEditActions ? (
          <View
            style={[
              styles.caseEditActionBar,
              {
                backgroundColor: colors.surface,
                borderTopColor: colors.border,
                paddingBottom: insets.bottom + Spacing.md,
              },
            ]}
            testID="case-edit-action-bar"
          >
            <View style={styles.caseEditActionRow}>
              <Pressable
                style={styles.btnSecondary}
                onPress={activeScreenEditActions.onCancel}
                disabled={activeScreenEditActions.disabled}
                testID={activeScreenEditActions.cancelTestID}
              >
                <Text style={styles.btnSecondaryText}>
                  {activeScreenEditActions.cancelLabel}
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.btnPrimary,
                  (activeScreenEditActions.isSaving ||
                    activeScreenEditActions.disabled) &&
                    styles.btnDisabled,
                ]}
                onPress={activeScreenEditActions.onSave}
                disabled={activeScreenEditActions.disabled}
                testID={activeScreenEditActions.saveTestID}
              >
                {activeScreenEditActions.isSaving ? (
                  <ActivityIndicator color={colors.textInverse} size="small" />
                ) : (
                  <Text style={styles.btnPrimaryText}>
                    {activeScreenEditActions.saveLabel}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}
      </ControllerKeyboardAvoidingView>

      {/* Full-screen image/video viewer */}
      <Modal
        visible={!!viewerMedia}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setLightboxMediaId(null);
          setStandaloneMedia(null);
        }}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable
          style={styles.lightbox}
          onPress={(event) => {
            // Native video controls must not also activate the backdrop close.
            if (viewerMedia?.kind === "video" && event.target !== event.currentTarget) return;
            if (consumeLightboxLongPress(true)) return;
            setLightboxMediaId(null);
            setStandaloneMedia(null);
          }}
          onLongPress={() => {
            if (!viewerMedia) return;
            markLightboxLongPress(true);
            if (viewerMedia.kind === "image") {
              confirmSaveAttachment({ kind: "image", url: viewerMedia.url });
            } else {
              confirmSaveAttachment({
                kind: "document",
                url: viewerMedia.url,
                fileName: viewerMedia.fileName,
                fileType: viewerMedia.fileType,
              });
            }
          }}
          testID="lightbox-backdrop"
        >
          {viewerMedia?.kind === "image" ? (
            <ZoomableAuthedImage
              key={viewerMedia.id}
              url={viewerMedia.url}
              style={styles.lightboxImage}
              testID="lightbox-image"
              onLongPress={() => confirmSaveAttachment({ kind: "image", url: viewerMedia.url })}
            />
          ) : viewerMedia?.kind === "video" &&
            isPlayableVideo(viewerMedia.fileType, viewerMedia.fileName) &&
            !videoPlaybackFailed ? (
            <AuthedVideo
              url={viewerMedia.url}
              fileName={viewerMedia.fileName}
              fileType={viewerMedia.fileType}
              style={styles.lightboxVideo}
              testID="lightbox-video"
              onPlaybackError={() => setVideoErrorMediaId(viewerMedia.id)}
            />
          ) : viewerMedia?.kind === "video" ? (
            <View style={styles.videoFallback}>
              <Ionicons
                name="videocam-outline"
                size={42}
                color="#fff" /* hex-allow: fixed-dark video fallback icon */
              />
              <Text style={styles.videoFallbackText}>
                This video can’t be played in the app.
              </Text>
              <Pressable
                style={styles.videoFallbackButton}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  if (!viewerMedia) return;
                  void openAttachmentPreview(
                    {
                      url: viewerMedia.url,
                      fileName: viewerMedia.fileName,
                      fileType: viewerMedia.fileType,
                    },
                    {
                      onOpenImage: () => undefined,
                      onError: (title, message) => Alert.alert(title, message),
                    },
                  );
                }}
                accessibilityRole="button"
                accessibilityLabel="Open or download video"
                testID="lightbox-video-fallback"
              >
                <Text style={styles.videoFallbackButtonText}>Open / Download</Text>
              </Pressable>
            </View>
          ) : null}
          {lightboxMedia ? (
            <View style={styles.lightboxNavigation}>
              <Pressable
                style={[
                  styles.lightboxNavButton,
                  lightboxIndex === 0 && styles.lightboxNavDisabled,
                ]}
                disabled={lightboxIndex === 0}
                accessibilityState={{
                  disabled: lightboxIndex === 0,
                }}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  if (lightboxIndex > 0) {
                    setLightboxMediaId(mediaSequence[lightboxIndex - 1].id);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel="Previous media"
                testID="lightbox-previous"
              >
                <Ionicons
                  name="chevron-back"
                  size={38}
                  color="#fff" /* hex-allow: fixed-dark gallery control */
                />
              </Pressable>
              <Text style={styles.lightboxPosition} accessibilityRole="text">
                {`${lightboxIndex + 1} of ${mediaSequence.length}`}
              </Text>
              <Pressable
                style={[
                  styles.lightboxNavButton,
                  lightboxIndex === mediaSequence.length - 1 &&
                    styles.lightboxNavDisabled,
                ]}
                disabled={lightboxIndex === mediaSequence.length - 1}
                accessibilityState={{
                  disabled: lightboxIndex === mediaSequence.length - 1,
                }}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  if (lightboxIndex >= 0 && lightboxIndex < mediaSequence.length - 1) {
                    setLightboxMediaId(mediaSequence[lightboxIndex + 1].id);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel="Next media"
                testID="lightbox-next"
              >
                <Ionicons
                  name="chevron-forward"
                  size={38}
                  color="#fff" /* hex-allow: fixed-dark gallery control */
                />
              </Pressable>
            </View>
          ) : null}
          <Pressable
            style={[styles.lightboxClose, { top: insets.top + Spacing.md }]}
            onPress={(event) => {
              event.stopPropagation();
              setLightboxMediaId(null);
              setStandaloneMedia(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Close media viewer"
            testID="lightbox-close"
          >
            <Ionicons
              name="close"
              size={26}
              color="#FFFFFF" /* hex-allow: fixed-dark lightbox close icon */
            />
          </Pressable>
        </Pressable>
        </GestureHandlerRootView>
      </Modal>

      {/* Remake questionnaire modal — admin/owner only */}
      <Modal
        visible={showRemakeModal}
        animationType="slide"
        transparent
        onRequestClose={closeRemakeModal}
      >
        <ControllerKeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <View
            style={{
              flex: 1,
              backgroundColor: "rgba(0,0,0,0.5)",
              justifyContent: "flex-end",
            }}
          >
            <View
              style={{
                backgroundColor: colors.surface,
                borderTopLeftRadius: Radius.md,
                borderTopRightRadius: Radius.md,
                maxHeight: "85%",
                paddingBottom: insets.bottom + Spacing.md,
              }}
            >
              {/* Header */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: Spacing.lg,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                }}
              >
                <Text style={[Typography.h3, { color: colors.text }]}>
                  Create Remake
                </Text>
                <Pressable
                  onPress={closeRemakeModal}
                  hitSlop={8}
                  disabled={remakeLoading}
                >
                  <Ionicons name="close" size={24} color={colors.text} />
                </Pressable>
              </View>

              <KeyboardAwareScrollView
                testID="create-remake-keyboard-aware-scroll"
                contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
                bottomOffset={72}
              >
                <RemakeReasonPicker
                  colors={colors}
                  selectedReasonKey={remakeReasonKey}
                  onSelectReason={selectRemakeReason}
                />

                {remakeReasonKey === "other" && (
                  <View style={{ gap: Spacing.xs, marginTop: Spacing.sm }}>
                    <Text style={[Typography.label, { color: colors.textSecondary }]}>
                      Custom remake reason *
                    </Text>
                    <TextInput
                      testID="create-remake-custom-reason"
                      ref={createRemakeCustomReasonRef}
                      value={remakeCustomReason}
                      onChangeText={setRemakeCustomReason}
                      placeholder="Describe why this case is being remade"
                      placeholderTextColor={colors.textTertiary}
                      maxLength={2000}
                      multiline
                      autoFocus={showRemakeModal && remakeReasonKey === "other"}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: Radius.sm,
                        padding: Spacing.sm,
                        color: colors.text,
                        backgroundColor: colors.surfaceSecondary,
                        minHeight: 64,
                        textAlignVertical: "top",
                      }}
                    />
                  </View>
                )}

                {/* Shade fields — conditional on shade_wrong */}
                {SHADE_REASON_KEYS_MOBILE.has(remakeReasonKey) && (
                  <>
                    <Text
                      style={[
                        Typography.label,
                        {
                          color: colors.textSecondary,
                          marginTop: Spacing.md,
                          marginBottom: Spacing.xs,
                        },
                      ]}
                    >
                      Shade — too light or too dark?
                    </Text>
                    <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                      {(["light", "dark"] as const).map((val) => {
                        const selected = remakeShadeLightness === val;
                        return (
                          <Pressable
                            key={val}
                            onPress={() =>
                              setRemakeShadeLightness(
                                remakeShadeLightness === val ? "" : val,
                              )
                            }
                            style={{
                              flex: 1,
                              paddingVertical: Spacing.sm,
                              borderRadius: Radius.sm,
                              alignItems: "center",
                              backgroundColor: selected
                                ? colors.tint + "22"
                                : colors.surfaceSecondary,
                              borderWidth: 1,
                              borderColor: selected
                                ? colors.tint
                                : colors.border,
                            }}
                          >
                            <Text
                              style={[
                                Typography.body,
                                {
                                  color: selected ? colors.tint : colors.text,
                                  fontWeight: "500",
                                },
                              ]}
                            >
                              {val === "light" ? "Too light" : "Too dark"}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <View
                      style={{
                        flexDirection: "row",
                        gap: Spacing.sm,
                        marginTop: Spacing.sm,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            Typography.caption,
                            { color: colors.textSecondary, marginBottom: 4 },
                          ]}
                        >
                          Shade prescribed
                        </Text>
                        <TextInput
                          style={{
                            borderWidth: 1,
                            borderColor: colors.border,
                            borderRadius: Radius.sm,
                            paddingHorizontal: Spacing.sm,
                            paddingVertical: Spacing.xs,
                            color: colors.text,
                            backgroundColor: colors.surfaceSecondary,
                          }}
                          value={remakeShadePrescribed}
                          onChangeText={setRemakeShadePrescribed}
                          placeholder="e.g. A2"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            Typography.caption,
                            { color: colors.textSecondary, marginBottom: 4 },
                          ]}
                        >
                          Shade provided
                        </Text>
                        <TextInput
                          style={{
                            borderWidth: 1,
                            borderColor: colors.border,
                            borderRadius: Radius.sm,
                            paddingHorizontal: Spacing.sm,
                            paddingVertical: Spacing.xs,
                            color: colors.text,
                            backgroundColor: colors.surfaceSecondary,
                          }}
                          value={remakeShadeProvided}
                          onChangeText={setRemakeShadeProvided}
                          placeholder="e.g. B1"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                    </View>
                  </>
                )}

                {/* Material fields — conditional on material reason keys */}
                {MATERIAL_REASON_KEYS_MOBILE.has(remakeReasonKey) && (
                  <View
                    style={{
                      flexDirection: "row",
                      gap: Spacing.sm,
                      marginTop: Spacing.md,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          Typography.caption,
                          { color: colors.textSecondary, marginBottom: 4 },
                        ]}
                      >
                        Material prescribed
                      </Text>
                      <TextInput
                        style={{
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: Radius.sm,
                          paddingHorizontal: Spacing.sm,
                          paddingVertical: Spacing.xs,
                          color: colors.text,
                          backgroundColor: colors.surfaceSecondary,
                        }}
                        value={remakeMaterialPrescribed}
                        onChangeText={setRemakeMaterialPrescribed}
                        placeholder="e.g. Zirconia"
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          Typography.caption,
                          { color: colors.textSecondary, marginBottom: 4 },
                        ]}
                      >
                        Material provided
                      </Text>
                      <TextInput
                        style={{
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: Radius.sm,
                          paddingHorizontal: Spacing.sm,
                          paddingVertical: Spacing.xs,
                          color: colors.text,
                          backgroundColor: colors.surfaceSecondary,
                        }}
                        value={remakeMaterialProvided}
                        onChangeText={setRemakeMaterialProvided}
                        placeholder="e.g. PFM"
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                  </View>
                )}

                {/* Charge toggle */}
                <Text
                  style={[
                    Typography.label,
                    {
                      color: colors.textSecondary,
                      marginTop: Spacing.md,
                      marginBottom: Spacing.xs,
                    },
                  ]}
                >
                  Charge for remake? *
                </Text>
                <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                  {([true, false] as const).map((val) => {
                    const selected = remakeCharge === val;
                    return (
                      <Pressable
                        key={String(val)}
                        onPress={() => setRemakeCharge(val)}
                        style={{
                          flex: 1,
                          paddingVertical: Spacing.sm,
                          borderRadius: Radius.sm,
                          alignItems: "center",
                          backgroundColor: selected
                            ? colors.tint + "22"
                            : colors.surfaceSecondary,
                          borderWidth: 1,
                          borderColor: selected ? colors.tint : colors.border,
                        }}
                      >
                        <Text
                          style={[
                            Typography.body,
                            {
                              color: selected ? colors.tint : colors.text,
                              fontWeight: "500",
                            },
                          ]}
                        >
                          {val ? "Yes — charge" : "No charge"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Returned to lab */}
                <Text
                  style={[
                    Typography.label,
                    {
                      color: colors.textSecondary,
                      marginTop: Spacing.md,
                      marginBottom: Spacing.xs,
                    },
                  ]}
                >
                  Returned to lab?
                </Text>
                <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                  {([true, false] as const).map((val) => {
                    const selected = remakeReturnedToLab === val;
                    return (
                      <Pressable
                        key={String(val)}
                        onPress={() =>
                          setRemakeReturnedToLab(
                            remakeReturnedToLab === val ? null : val,
                          )
                        }
                        style={{
                          flex: 1,
                          paddingVertical: Spacing.sm,
                          borderRadius: Radius.sm,
                          alignItems: "center",
                          backgroundColor: selected
                            ? colors.tint + "22"
                            : colors.surfaceSecondary,
                          borderWidth: 1,
                          borderColor: selected ? colors.tint : colors.border,
                        }}
                      >
                        <Text
                          style={[
                            Typography.body,
                            {
                              color: selected ? colors.tint : colors.text,
                              fontWeight: "500",
                            },
                          ]}
                        >
                          {val ? "Yes" : "No"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Remake notes (admin/owner only) */}
                {isAdminOfCase && (
                  <>
                    <Text
                      style={[
                        Typography.label,
                        {
                          color: colors.textSecondary,
                          marginTop: Spacing.md,
                          marginBottom: Spacing.xs,
                        },
                      ]}
                    >
                      Remake notes (optional)
                    </Text>
                    <TextInput
                      value={remakeNotes}
                      onChangeText={setRemakeNotes}
                      multiline
                      numberOfLines={3}
                      autoCorrect={true}
                      spellCheck={true}
                      autoCapitalize="sentences"
                      placeholder="Technician instructions…"
                      placeholderTextColor={colors.textTertiary}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: Radius.sm,
                        padding: Spacing.sm,
                        color: colors.text,
                        backgroundColor: colors.surfaceSecondary,
                        minHeight: 72,
                        textAlignVertical: "top",
                        fontSize: 13,
                      }}
                    />
                  </>
                )}

                {/* Error message */}
                {remakeError && (
                  <Text
                    style={[
                      Typography.body,
                      { color: colors.error, marginTop: Spacing.sm },
                    ]}
                  >
                    {remakeError}
                  </Text>
                )}

                {/* Submit */}
                <Pressable
                  testID="case-remake-submit"
                  onPress={() => void handleRemakeSubmit()}
                  disabled={
                    remakeLoading || !remakeReasonKey || remakeCharge === null ||
                    (remakeReasonKey === "other" && !remakeCustomReason.trim())
                  }
                  style={({ pressed }) => ({
                    marginTop: Spacing.lg,
                    paddingVertical: Spacing.md,
                    borderRadius: Radius.sm,
                    backgroundColor:
                       remakeLoading || !remakeReasonKey || remakeCharge === null ||
                       (remakeReasonKey === "other" && !remakeCustomReason.trim())
                        ? colors.tint + "66"
                        : pressed
                          ? colors.tint + "cc"
                          : colors.tint,
                    alignItems: "center",
                    flexDirection: "row",
                    justifyContent: "center",
                    gap: Spacing.xs,
                  })}
                >
                  {remakeLoading && (
                    <ActivityIndicator
                      size="small"
                      color="#fff"
                      style={{ marginRight: 4 }}
                    />
                  )}
                  <Text
                    style={{ color: "#fff", fontWeight: "600", fontSize: 15 }}
                  >
                    {remakeLoading ? "Creating…" : "Create Remake"}
                  </Text>
                </Pressable>
              </KeyboardAwareScrollView>
            </View>
          </View>
        </ControllerKeyboardAvoidingView>
      </Modal>

      {/* Edit remake reason modal — shown when case IS a remake (has remakeOriginal) */}
      <Modal
        visible={showEditRemakeModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          if (!editRemakeLoading) {
            setShowEditRemakeModal(false);
            resetRemakeState();
          }
        }}
      >
        <ControllerKeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <View
            style={{
              flex: 1,
              backgroundColor: "rgba(0,0,0,0.5)",
              justifyContent: "flex-end",
            }}
          >
            <View
              style={{
                backgroundColor: colors.surface,
                borderTopLeftRadius: Radius.md,
                borderTopRightRadius: Radius.md,
                maxHeight: "85%",
                paddingBottom: insets.bottom + Spacing.md,
              }}
            >
              {/* Header */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: Spacing.lg,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                }}
              >
                <Text style={[Typography.h3, { color: colors.text }]}>
                  Edit Remake Reason
                </Text>
                <Pressable
                  onPress={() => {
                    if (!editRemakeLoading) {
                      setShowEditRemakeModal(false);
                      resetRemakeState();
                    }
                  }}
                  hitSlop={8}
                  disabled={editRemakeLoading}
                >
                  <Ionicons name="close" size={24} color={colors.text} />
                </Pressable>
              </View>

              <KeyboardAwareScrollView
                testID="edit-remake-keyboard-aware-scroll"
                contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
                bottomOffset={72}
              >
                <RemakeReasonPicker
                  colors={colors}
                  selectedReasonKey={remakeReasonKey}
                  onSelectReason={selectRemakeReason}
                  testIdSuffix="-edit"
                />

                {remakeReasonKey === "other" && (
                  <View style={{ gap: Spacing.xs, marginTop: Spacing.sm }}>
                    <Text style={[Typography.label, { color: colors.textSecondary }]}>
                      Custom remake reason *
                    </Text>
                    <TextInput
                      testID="edit-remake-custom-reason"
                      ref={editRemakeCustomReasonRef}
                      value={remakeCustomReason}
                      onChangeText={setRemakeCustomReason}
                      placeholder="Describe why this case is being remade"
                      placeholderTextColor={colors.textTertiary}
                      maxLength={2000}
                      multiline
                      autoFocus={showEditRemakeModal && remakeReasonKey === "other"}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: Radius.sm,
                        padding: Spacing.sm,
                        color: colors.text,
                        backgroundColor: colors.surfaceSecondary,
                        minHeight: 64,
                        textAlignVertical: "top",
                      }}
                    />
                  </View>
                )}

                {/* Shade fields — conditional on shade_wrong */}
                {SHADE_REASON_KEYS_MOBILE.has(remakeReasonKey) && (
                  <>
                    <Text
                      style={[
                        Typography.label,
                        {
                          color: colors.textSecondary,
                          marginTop: Spacing.md,
                          marginBottom: Spacing.xs,
                        },
                      ]}
                    >
                      Shade — too light or too dark?
                    </Text>
                    <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                      {(["light", "dark"] as const).map((val) => {
                        const selected = remakeShadeLightness === val;
                        return (
                          <Pressable
                            key={val}
                            onPress={() =>
                              setRemakeShadeLightness(
                                remakeShadeLightness === val ? "" : val,
                              )
                            }
                            style={{
                              flex: 1,
                              paddingVertical: Spacing.sm,
                              borderRadius: Radius.sm,
                              alignItems: "center",
                              backgroundColor: selected
                                ? colors.tint + "22"
                                : colors.surfaceSecondary,
                              borderWidth: 1,
                              borderColor: selected
                                ? colors.tint
                                : colors.border,
                            }}
                          >
                            <Text
                              style={[
                                Typography.body,
                                {
                                  color: selected ? colors.tint : colors.text,
                                  fontWeight: "500",
                                },
                              ]}
                            >
                              {val === "light" ? "Too light" : "Too dark"}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <View
                      style={{
                        flexDirection: "row",
                        gap: Spacing.sm,
                        marginTop: Spacing.sm,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            Typography.caption,
                            { color: colors.textSecondary, marginBottom: 4 },
                          ]}
                        >
                          Shade prescribed
                        </Text>
                        <TextInput
                          style={{
                            borderWidth: 1,
                            borderColor: colors.border,
                            borderRadius: Radius.sm,
                            paddingHorizontal: Spacing.sm,
                            paddingVertical: Spacing.xs,
                            color: colors.text,
                            backgroundColor: colors.surfaceSecondary,
                          }}
                          value={remakeShadePrescribed}
                          onChangeText={setRemakeShadePrescribed}
                          placeholder="e.g. A2"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            Typography.caption,
                            { color: colors.textSecondary, marginBottom: 4 },
                          ]}
                        >
                          Shade provided
                        </Text>
                        <TextInput
                          style={{
                            borderWidth: 1,
                            borderColor: colors.border,
                            borderRadius: Radius.sm,
                            paddingHorizontal: Spacing.sm,
                            paddingVertical: Spacing.xs,
                            color: colors.text,
                            backgroundColor: colors.surfaceSecondary,
                          }}
                          value={remakeShadeProvided}
                          onChangeText={setRemakeShadeProvided}
                          placeholder="e.g. B1"
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>
                    </View>
                  </>
                )}

                {/* Material fields — conditional on material reason keys */}
                {MATERIAL_REASON_KEYS_MOBILE.has(remakeReasonKey) && (
                  <View
                    style={{
                      flexDirection: "row",
                      gap: Spacing.sm,
                      marginTop: Spacing.md,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          Typography.caption,
                          { color: colors.textSecondary, marginBottom: 4 },
                        ]}
                      >
                        Material prescribed
                      </Text>
                      <TextInput
                        style={{
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: Radius.sm,
                          paddingHorizontal: Spacing.sm,
                          paddingVertical: Spacing.xs,
                          color: colors.text,
                          backgroundColor: colors.surfaceSecondary,
                        }}
                        value={remakeMaterialPrescribed}
                        onChangeText={setRemakeMaterialPrescribed}
                        placeholder="e.g. Zirconia"
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          Typography.caption,
                          { color: colors.textSecondary, marginBottom: 4 },
                        ]}
                      >
                        Material provided
                      </Text>
                      <TextInput
                        style={{
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: Radius.sm,
                          paddingHorizontal: Spacing.sm,
                          paddingVertical: Spacing.xs,
                          color: colors.text,
                          backgroundColor: colors.surfaceSecondary,
                        }}
                        value={remakeMaterialProvided}
                        onChangeText={setRemakeMaterialProvided}
                        placeholder="e.g. PFM"
                        placeholderTextColor={colors.textTertiary}
                      />
                    </View>
                  </View>
                )}

                {/* Charge toggle */}
                <Text
                  style={[
                    Typography.label,
                    {
                      color: colors.textSecondary,
                      marginTop: Spacing.md,
                      marginBottom: Spacing.xs,
                    },
                  ]}
                >
                  Charge for remake? *
                </Text>
                <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                  {([true, false] as const).map((val) => {
                    const selected = remakeCharge === val;
                    return (
                      <Pressable
                        key={String(val)}
                        onPress={() => setRemakeCharge(val)}
                        style={{
                          flex: 1,
                          paddingVertical: Spacing.sm,
                          borderRadius: Radius.sm,
                          alignItems: "center",
                          backgroundColor: selected
                            ? colors.tint + "22"
                            : colors.surfaceSecondary,
                          borderWidth: 1,
                          borderColor: selected ? colors.tint : colors.border,
                        }}
                      >
                        <Text
                          style={[
                            Typography.body,
                            {
                              color: selected ? colors.tint : colors.text,
                              fontWeight: "500",
                            },
                          ]}
                        >
                          {val ? "Yes — charge" : "No charge"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Returned to lab */}
                <Text
                  style={[
                    Typography.label,
                    {
                      color: colors.textSecondary,
                      marginTop: Spacing.md,
                      marginBottom: Spacing.xs,
                    },
                  ]}
                >
                  Returned to lab?
                </Text>
                <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                  {([true, false] as const).map((val) => {
                    const selected = remakeReturnedToLab === val;
                    return (
                      <Pressable
                        key={String(val)}
                        onPress={() =>
                          setRemakeReturnedToLab(
                            remakeReturnedToLab === val ? null : val,
                          )
                        }
                        style={{
                          flex: 1,
                          paddingVertical: Spacing.sm,
                          borderRadius: Radius.sm,
                          alignItems: "center",
                          backgroundColor: selected
                            ? colors.tint + "22"
                            : colors.surfaceSecondary,
                          borderWidth: 1,
                          borderColor: selected ? colors.tint : colors.border,
                        }}
                      >
                        <Text
                          style={[
                            Typography.body,
                            {
                              color: selected ? colors.tint : colors.text,
                              fontWeight: "500",
                            },
                          ]}
                        >
                          {val ? "Yes" : "No"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Remake notes (admin/owner only) */}
                {isAdminOfCase && (
                  <>
                    <Text
                      style={[
                        Typography.label,
                        {
                          color: colors.textSecondary,
                          marginTop: Spacing.md,
                          marginBottom: Spacing.xs,
                        },
                      ]}
                    >
                      Remake notes (optional)
                    </Text>
                    <TextInput
                      value={remakeNotes}
                      onChangeText={setRemakeNotes}
                      multiline
                      numberOfLines={3}
                      autoCorrect={true}
                      spellCheck={true}
                      autoCapitalize="sentences"
                      placeholder="Technician instructions…"
                      placeholderTextColor={colors.textTertiary}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: Radius.sm,
                        padding: Spacing.sm,
                        color: colors.text,
                        backgroundColor: colors.surfaceSecondary,
                        minHeight: 72,
                        textAlignVertical: "top",
                        fontSize: 13,
                      }}
                    />
                  </>
                )}

                {/* Error message */}
                {editRemakeError && (
                  <Text
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[
                      Typography.body,
                      { color: colors.error, marginTop: Spacing.sm },
                    ]}
                  >
                    {editRemakeError}
                  </Text>
                )}

                {/* Submit */}
                <Pressable
                  onPress={() => void handleEditRemakeSubmit()}
                  disabled={
                    editRemakeLoading ||
                    !remakeReasonKey ||
                    remakeCharge === null
                  }
                  style={({ pressed }) => ({
                    marginTop: Spacing.lg,
                    paddingVertical: Spacing.md,
                    borderRadius: Radius.sm,
                    backgroundColor:
                      editRemakeLoading ||
                      !remakeReasonKey ||
                      remakeCharge === null
                        ? colors.tint + "66"
                        : pressed
                          ? colors.tint + "cc"
                          : colors.tint,
                    alignItems: "center",
                    flexDirection: "row",
                    justifyContent: "center",
                    gap: Spacing.xs,
                  })}
                >
                  {editRemakeLoading && (
                    <ActivityIndicator
                      size="small"
                      color="#fff"
                      style={{ marginRight: 4 }}
                    />
                  )}
                  <Text
                    style={{ color: "#fff", fontWeight: "600", fontSize: 15 }}
                  >
                    {editRemakeLoading ? "Saving…" : "Save Changes"}
                  </Text>
                </Pressable>
              </KeyboardAwareScrollView>
            </View>
          </View>
        </ControllerKeyboardAvoidingView>
      </Modal>

      {/* 3-step deletion security flow — admin/owner only */}
      <CaseDeleteMobileModal
        caseId={id}
        visible={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onSuccess={() => {
          setShowDeleteModal(false);
          qc.invalidateQueries({ queryKey: ["cases"] });
          // The case's invoice is frozen (not deleted) — refresh invoice +
          // financial views so balances/counts don't linger stale.
          qc.invalidateQueries({ queryKey: ["invoices"] });
          qc.invalidateQueries({ queryKey: ["undeposited-funds-summary"] });
          router.back();
        }}
        styles={styles}
        colors={colors}
      />

      {/* Guided question chain shown after a complete → intake locate */}
      <ReturnedCaseWizard
        caseId={id}
        stage={wizardStage}
        canChangeStep={canChangeReturnedStep}
        currentStep={c.step ?? null}
        onStageChange={setWizardStage}
        onScanPrescription={handleWizardScanRx}
        onStartRemake={handleWizardStartRemake}
        onPrintLabSlip={handlePrintCaseCard}
        onPrintCaseLabel={() =>
          printCaseLabel(c, { labName }).catch((e: unknown) =>
            Alert.alert("Print error", errorMessage(e)),
          )
        }
        onSaved={() => caseQuery.refetch()}
      />
    </View>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header({
  title,
  subtitle,
  onBack,
  right,
  styles,
  colors,
  isRush,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: React.ReactNode;
  styles: Styles;
  colors: ThemeColors;
  isRush?: boolean;
}) {
  return (
    <View
      style={[
        styles.header,
        isRush && { backgroundColor: colors.error + "0D" },
      ]}
    >
      <View style={styles.headerMain} testID="case-header-main">
        <Pressable
          onPress={onBack}
          hitSlop={10}
          style={styles.backBtn}
          testID="case-back"
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.headerTitles}>
          <Text
            style={[styles.headerTitle, isRush && { color: colors.error }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[styles.headerSubtitle, isRush && { color: colors.error }]}
              testID="case-header-patient"
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────────
function FieldRow({
  label,
  value,
  styles,
  rushColor,
}: {
  label: string;
  value: string;
  styles: Styles;
  rushColor?: string;
}) {
  return (
    <View style={styles.fieldRow}>
      <Text
        style={[
          styles.fieldLabel,
          rushColor ? { color: rushColor } : undefined,
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          styles.fieldValue,
          rushColor ? { color: rushColor } : undefined,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function CaseHeaderLocator({
  c,
  canEdit,
  editing,
  onSaved,
  onReturnedLocate,
  styles,
  colors,
}: {
  c: DetailedCase;
  canEdit: boolean;
  editing: boolean;
  onSaved: () => void | Promise<unknown>;
  onReturnedLocate: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const qc = useQueryClient();
  const update = useUpdateCase();
  const meQuery = useMe();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [locateTargetId, setLocateTargetId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const locateInFlightRef = useRef(false);
  const committedLocateRef = useRef<{
    caseId: string;
    locationId: string;
    status: string;
  } | null>(null);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);
  useEffect(() => {
    const committed = committedLocateRef.current;
    if (!committed) return;
    if (
      committed.caseId !== c.id ||
      (c.labLocationId === committed.locationId &&
        (c.status ?? "").toLowerCase() === committed.status.toLowerCase())
    ) {
      committedLocateRef.current = null;
    }
  }, [c.id, c.labLocationId, c.status]);

  const locationsOrgId =
    c.labOrganizationId ??
    c.organizationId ??
    editableLabMemberships(meQuery.data)[0]?.organizationId ??
    null;
  const {
    locations: apiLocations,
    status: locationsStatus,
    retry: retryLocations,
  } = useLabLocations(locationsOrgId, canEdit && !editing);
  const stationOptions = useMemo(
    () => locationsStatus === "loaded"
      ? apiLocations.map((loc) => ({ id: loc.id, value: loc.status, label: loc.name }))
      : [],
    [apiLocations, locationsStatus],
  );
  // Keep exact identity: different custom stations can share a status.
  const selectableStations = useMemo(
    () => stationOptions.filter((s) => c.labLocationId
      ? s.id !== c.labLocationId
      : s.value !== (c.status ?? "").toLowerCase()),
    [stationOptions, c.labLocationId, c.status],
  );
  const locateTargetLabel =
    selectableStations.find((o) => o.id === locateTargetId)?.label ?? null;

  async function locate(targetId: string, targetStatus: string) {
    if (!canEdit || editing || locateInFlightRef.current || locating) return;
    locateInFlightRef.current = true;
    setLocating(true);
    setLocateMsg(null);
    try {
      await update.mutateAsync({
        caseId: c.id,
        data: {
          status: targetStatus as UpdateCaseInputStatus,
          labLocationId: targetId,
        } as UpdateCaseInput & { labLocationId: string },
      });
    } catch (e) {
      Alert.alert("Couldn't locate case", errorMessage(e));
      locateInFlightRef.current = false;
      setLocating(false);
      return;
    }
    // The write has committed; a refresh failure must not offer a duplicate retry.
    const returned = isReturnedLocate(c.status, targetStatus);
    const released = targetStatus === "complete" && !!c.casePanBarcode?.trim();
    committedLocateRef.current = {
      caseId: c.id,
      locationId: targetId,
      status: targetStatus,
    };
    setLocateTargetId(null);
    await Promise.allSettled([
      Promise.resolve().then(onSaved),
      Promise.resolve().then(() => qc.invalidateQueries({ queryKey: ["cases"] })),
      Promise.resolve().then(() => qc.invalidateQueries({ queryKey: ["invoices"] })),
      Promise.resolve().then(() => qc.invalidateQueries({ queryKey: ["invoice-for-case", c.id] })),
    ]);
    setLocateMsg(released
      ? "Case located successfully. Barcode released."
      : "Case located successfully.");
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setLocateMsg(null), 3000);
    locateInFlightRef.current = false;
    setLocating(false);
    if (returned) onReturnedLocate();
  }

  return (
    <View style={{ gap: Spacing.xs, paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm }} testID="case-header-location">
      <View style={[styles.fieldRow, { justifyContent: "flex-start", flexWrap: "wrap", gap: Spacing.md }]}>
        <Text style={styles.fieldLabel}>Location</Text>
        <Text style={styles.fieldValue} testID="overview-current-location">
          {c.labLocationName?.trim() ||
            stationOptions.find((station) => station.id === c.labLocationId)?.label ||
            stationLabelFor(c.status)}
        </Text>
      </View>
      {canEdit && !editing ? (
        <>
          {locationsStatus === "loading" ? (
            <View style={styles.locateStatusRow} testID="locate-locations-loading">
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={styles.locateStatusText}>Loading locations…</Text>
            </View>
          ) : locationsStatus === "error" ? (
            <View style={styles.locateStatusBlock} testID="locate-locations-error">
              <Text style={styles.locateStatusText}>
                Couldn&apos;t load this lab&apos;s locations.
              </Text>
              <Pressable style={styles.retryBtn} onPress={retryLocations} testID="locate-locations-retry">
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : selectableStations.length === 0 ? (
            <View style={styles.locateStatusBlock} testID="locate-locations-empty">
              <Text style={styles.locateStatusText}>
                {stationOptions.length === 0
                  ? "This lab has no active locations yet."
                  : "This case is already at the lab's only active location."}
              </Text>
            </View>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: Spacing.sm }}>
              <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 170, minWidth: 0 }}>
                <SelectRow
                  label="Move to station"
                  valueLabel={locateTargetLabel ?? "Select station…"}
                  valueTextStyle={{ flexShrink: 1, minWidth: 0 }}
                  onPress={() => {
                    if (!locating && !committedLocateRef.current) setPickerOpen(true);
                  }}
                  styles={styles}
                  colors={colors}
                  testID="locate-select"
                  disabled={locating || committedLocateRef.current !== null}
                />
              </View>
              {locating ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: Spacing.xs }} testID="locate-pending">
                  <ActivityIndicator color={colors.tint} size="small" />
                  <Text style={styles.locateStatusText}>Locating…</Text>
                </View>
              ) : null}
            </View>
          )}
          {locateMsg ? <Text style={styles.locateSuccess} testID="locate-success">{locateMsg}</Text> : null}
        </>
      ) : null}
      <OptionPickerModal
        visible={pickerOpen && canEdit && !editing && !locating}
        title="Locate Case"
        options={selectableStations}
        selected={locateTargetId}
        onSelect={(id) => {
          if (!canEdit || editing || locateInFlightRef.current) return;
          const picked = selectableStations.find((s) => s.id === id);
          if (!picked) return;
          setLocateTargetId(picked.id);
          setLocateMsg(null);
          setPickerOpen(false);
          void locate(picked.id, picked.value);
        }}
        onClose={() => setPickerOpen(false)}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

function OverviewSection({
  c,
  caseId,
  canEdit,
  isAdmin,
  labName,
  labOrganizationId,
  onSaved,
  onGoToInvoice,
  onEditRemake,
  styles,
  colors,
  isRush,
  rxPreviewOpen,
  onRxPreviewOpenChange,
  activeScreenActionOwner,
  registerScreenEditActions,
  updateScreenEditActions,
  unregisterScreenEditActions,
}: {
  c: DetailedCase;
  caseId: string;
  canEdit: boolean;
  isAdmin: boolean;
  labName: string | null;
  labOrganizationId?: string | null;
  onSaved: () => void | Promise<unknown>;
  onGoToInvoice: () => void;
  onEditRemake?: () => void;
  styles: Styles;
  colors: ThemeColors;
  isRush?: boolean;
  /** Controlled by the case screen so the History tab's "View Rx" button can
   *  open this same Prescription Preview modal. */
  rxPreviewOpen: boolean;
  onRxPreviewOpenChange: (open: boolean) => void;
  activeScreenActionOwner: string | null;
  registerScreenEditActions: (actions: ScreenEditActions) => void;
  updateScreenEditActions: (
    owner: string,
    updates: Partial<ScreenEditActions>,
  ) => void;
  unregisterScreenEditActions: (owner: string) => void;
}) {
  const { fontScale } = useWindowDimensions();
  const useLargeTextOverviewLayout = fontScale >= 1.3;
  const rushColor = isRush ? colors.error : undefined;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<OverviewForm>(() => formFromCase(c));
  const [clinicalDraft, setClinicalDraft] = useState(() => clinicalDraftFromCase(c));
  const [implantDrafts, setImplantDrafts] = useState<Record<string, ImplantDetails>>({});
  const confirmedImplants = useRef<Record<string, ImplantDetails>>({});
  const [overviewSaving, setOverviewSaving] = useState(false);
  const overviewSaveInFlight = useRef(false);
  const [rxNotesEditing, setRxNotesEditing] = useState(false);
  const [rxNotesValue, setRxNotesValue] = useState(c.caseNotes ?? "");
  const [rxNotesSaving, setRxNotesSaving] = useState(false);
  const [rxNotesError, setRxNotesError] = useState<string | null>(null);
  const [previousConfirmedRxNotes, setPreviousConfirmedRxNotes] = useState(
    c.caseNotes ?? "",
  );
  if ((c.caseNotes ?? "") !== previousConfirmedRxNotes) {
    setPreviousConfirmedRxNotes(c.caseNotes ?? "");
    if (!rxNotesEditing) setRxNotesValue(c.caseNotes ?? "");
  }
  const [dueTimeEnabled, setDueTimeEnabled] = useState(() => !!c.dueTime);
  const [picker, setPicker] = useState<
    "receivedAt" | "dueDate" | "dueTime" | null
  >(
    null,
  );
  const [togglingRush, setTogglingRush] = useState(false);
  const update = useUpdateCase();
  const qc = useQueryClient();
  const meQuery = useMe();
  const practiceOrganizationQuery = useGetOrganization(
    c.providerOrganizationId ?? "",
    {
      query: {
        queryKey: getGetOrganizationQueryKey(c.providerOrganizationId ?? ""),
        enabled: !!c.providerOrganizationId,
        staleTime: 60_000,
      },
    },
  );
  const casePractice = practiceOrganizationQuery.data?.data;
  const linkedPractice =
    c.providerOrganizationId &&
    casePractice?.id === c.providerOrganizationId
      ? casePractice
      : null;
  const casePracticeContact = c.providerOrganizationId
    ? c.providerOrganizationContact
    : null;
  const linkedContactValue = (field: string) => {
    const value = casePracticeContact
      ? casePracticeContact[field as keyof typeof casePracticeContact]
      : linkedPractice?.[field];
    return typeof value === "string" ? value : null;
  };
  const practiceContactName = linkedContactValue("name");
  const practiceAddress1 = linkedContactValue("addressLine1");
  const practiceAddress2 = linkedContactValue("addressLine2");
  const practiceCity = linkedContactValue("city");
  const practiceState = linkedContactValue("state");
  const practiceZip = linkedContactValue("zip");
  const practicePhoneValue = linkedContactValue("phone");
  const practiceName =
    practiceContactName?.trim() ||
    linkedPractice?.displayName?.trim() ||
    linkedPractice?.name?.trim() ||
    "—";
  const practiceAddressLines = [
    practiceAddress1,
    practiceAddress2,
    [
      [practiceCity, practiceState]
        .map((part) => (part ?? "").trim())
        .filter(Boolean)
        .join(", "),
      (practiceZip ?? "").trim(),
    ]
      .filter(Boolean)
      .join(" "),
  ]
    .map((line) => (line ?? "").trim())
    .filter(Boolean);
  const rawPracticePhone = (practicePhoneValue ?? "").trim();
  const practicePhoneDigits = rawPracticePhone.replace(/\D/g, "");
  const practicePhone =
    practicePhoneDigits.length === 10
      ? `(${practicePhoneDigits.slice(0, 3)}) ${practicePhoneDigits.slice(3, 6)}-${practicePhoneDigits.slice(6)}`
      : rawPracticePhone;

  const [caseNumberEditing, setCaseNumberEditing] = useState(false);
  const [caseNumberValue, setCaseNumberValue] = useState("");
  const [caseNumberSaving, setCaseNumberSaving] = useState(false);
  const [caseNumberError, setCaseNumberError] = useState<string | null>(null);

  // ── Custom Shade state (Task #3631) ──────────────────────────────────────
  const [customShadeSaving, setCustomShadeSaving] = useState(false);
  const customShadeInFlight = useRef(false);
  const [customShadeTechValue, setCustomShadeTechValue] = useState(
    c.customShadeTechnician ?? "",
  );
  const [customShadeTechSaving, setCustomShadeTechSaving] = useState(false);
  const customShadeTechInFlight = useRef(false);

  // Keep tech input in sync when case data refreshes.
  const latestCustomShadeTech = c.customShadeTechnician ?? "";
  const [prevCustomShadeTech, setPrevCustomShadeTech] = useState(
    latestCustomShadeTech,
  );
  if (latestCustomShadeTech !== prevCustomShadeTech) {
    setPrevCustomShadeTech(latestCustomShadeTech);
    setCustomShadeTechValue(latestCustomShadeTech);
  }

  async function saveCaseNumber() {
    const trimmed = caseNumberValue.trim();
    if (!trimmed) {
      setCaseNumberError("Case number cannot be blank.");
      return;
    }
    setCaseNumberSaving(true);
    setCaseNumberError(null);
    try {
      await resilientFetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseNumber: trimmed }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["cases", caseId] }),
        qc.invalidateQueries({ queryKey: ["invoices"] }),
      ]);
      await onSaved();
      setCaseNumberEditing(false);
    } catch (err: unknown) {
      setCaseNumberError(
        err instanceof Error ? err.message : "Could not save.",
      );
    } finally {
      setCaseNumberSaving(false);
    }
  }

  // ── Custom Shade save helpers (Task #3631) ───────────────────────────────
  async function patchCustomShade(body: Record<string, unknown>) {
    if (customShadeInFlight.current) return;
    customShadeInFlight.current = true;
    setCustomShadeSaving(true);
    try {
      await update.mutateAsync({
        caseId,
        data: body as unknown as UpdateCaseInput,
      });
    } catch (err) {
      Alert.alert("Couldn't save custom shade", errorMessage(err));
      customShadeInFlight.current = false;
      setCustomShadeSaving(false);
      return;
    }
    try {
      const refreshes = await Promise.allSettled([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["cases", caseId] }),
        Promise.resolve().then(() => onSaved()),
      ]);
      if (refreshes.some((result) => result.status === "rejected")) {
        Alert.alert("Custom shade saved", "The case could not be refreshed. Reload to see the latest details.");
      }
    } finally {
      customShadeInFlight.current = false;
      setCustomShadeSaving(false);
    }
  }

  async function commitCustomShadeTech() {
    const trimmed = customShadeTechValue.trim();
    if (trimmed === (c.customShadeTechnician ?? "").trim()) return;
    if (customShadeTechInFlight.current) return;
    customShadeTechInFlight.current = true;
    setCustomShadeTechSaving(true);
    try {
      await update.mutateAsync({
        caseId,
        data: {
          customShadeTechnician: trimmed || null,
        } as unknown as UpdateCaseInput,
      });
    } catch (err) {
      setCustomShadeTechValue(c.customShadeTechnician ?? "");
      Alert.alert("Couldn't save technician name", errorMessage(err));
      customShadeTechInFlight.current = false;
      setCustomShadeTechSaving(false);
      return;
    }
    try {
      const refreshes = await Promise.allSettled([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["cases", caseId] }),
        Promise.resolve().then(() => onSaved()),
      ]);
      if (refreshes.some((result) => result.status === "rejected")) {
        Alert.alert("Technician name saved", "The case could not be refreshed. Reload to see the latest details.");
      }
    } finally {
      customShadeTechInFlight.current = false;
      setCustomShadeTechSaving(false);
    }
  }

  async function saveRxNotes() {
    if (!canEdit || rxNotesSaving) return;
    setRxNotesSaving(true);
    setRxNotesError(null);
    try {
      await update.mutateAsync({
        caseId,
        data: {
          rxNotes: rxNotesValue.trim() ? rxNotesValue : null,
        } as unknown as UpdateCaseInput,
      });
      setRxNotesEditing(false);
      // The write is committed; cache refresh is best-effort and must not make
      // the user retry a successful notes save.
      void Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["cases", caseId] }),
        Promise.resolve().then(() => onSaved()),
      ]).catch(() => {
        setRxNotesError("Saved, but the case could not be refreshed. Reload to see the latest notes.");
      });
    } catch (err) {
      setRxNotesValue(c.caseNotes ?? "");
      setRxNotesError(errorMessage(err));
    } finally {
      setRxNotesSaving(false);
    }
  }

  function cancelRxNotes() {
    setRxNotesValue(c.caseNotes ?? "");
    setRxNotesError(null);
    setRxNotesEditing(false);
  }

  // ── Print-label prompt (shown after a barcode is assigned via the edit form) ─
  const [printModalVisible, setPrintModalVisible] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);
  const [pendingPrintBarcode, setPendingPrintBarcode] = useState<string | null>(
    null,
  );
  const setRxPreviewOpen = onRxPreviewOpenChange;
  const [reassignOpen, setReassignOpen] = useState(false);
  useEffect(() => { setReassignOpen(false); }, [caseId, c.providerOrganizationId]);

  // ── Exception case ────────────────────────────────────────────────────────
  // Whether this case is already in the exception queue comes from the shared
  // active-exception query, so flagging/resolving here and the dashboard queue
  // read the same cache entry and refresh together.
  const [exceptionCreateOpen, setExceptionCreateOpen] = useState(false);
  const [exceptionDetailOpen, setExceptionDetailOpen] = useState(false);
  // Open to every ACTIVE member of the case's lab, matching the server, which
  // lets any internal lab member flag and review an exception. Gating this on
  // an edit role would hide the workflow from `user`/`read_only` members the
  // API accepts.
  const isLabMember = isActiveMemberOfOrg(meQuery.data, labOrganizationId);
  const exceptionsQuery = useQuery<CaseExceptionQueueItem[]>({
    queryKey: EXCEPTION_QUEUE_QUERY_KEY,
    queryFn: fetchActiveExceptions,
    enabled: isLabMember,
  });
  const activeException =
    exceptionsQuery.data?.find((ex) => ex.caseId === caseId) ?? null;
  const insets = useSafeAreaInsets();

  // ── Case Hierarchy (Type / Sub Type / Material) edit ─────────────────
  const labOrgIdForCatalog = labOrganizationId ?? null;
  const hierarchyCatalogQuery = useGetCatalogTree(
    { labOrganizationId: labOrgIdForCatalog ?? "", includeInactive: "false" },
    {
      query: {
        queryKey: getGetCatalogTreeQueryKey({
          labOrganizationId: labOrgIdForCatalog ?? "",
          includeInactive: "false",
        }),
        // Preserve mobile's existing hierarchy-editor permission. Workflow
        // step changes have a separate, stricter admin/owner gate below.
        enabled: !!labOrgIdForCatalog && canEdit,
        staleTime: 120_000,
      },
    },
  );
  const [hierarchyEditOpen, setHierarchyEditOpen] = useState(false);
  const [hierarchySaving, setHierarchySaving] = useState(false);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);
  const [draftCt, setDraftCt] = useState<CaseType | null>(null);
  const [draftSt, setDraftSt] = useState<string | null>(null);
  const [draftMat, setDraftMat] = useState<string | null>(null);
  const [draftArch, setDraftArch] = useState<ArchSelection | null>(null);
  const restorations = c.restorations ?? [];
  const firstRestoration = restorations[0] ?? null;
  const restorationIds = restorations
    .map((restoration) => restoration.id)
    .filter((id): id is string => Boolean(id));
  const firstHierarchy: CaseHierarchy | null = firstRestoration
    ? deriveCaseHierarchy(
        firstRestoration.restorationType ?? null,
        (firstRestoration as any).restorationSubtype ?? null,
        firstRestoration.material ?? null,
      )
    : null;
  const hierarchyIsMixed = hasMixedCaseHierarchy(restorations);

  function openHierarchyEdit() {
    setDraftCt(firstHierarchy?.caseType ?? null);
    setDraftSt(
      firstHierarchy?.subtype ??
        (firstHierarchy?.customSubtypeId
          ? `custom:${firstHierarchy.customSubtypeId}`
          : null),
    );
    setDraftMat(
      firstHierarchy?.materialSubtype ??
        (firstHierarchy?.customMaterialSubtypeId
          ? `custom:${firstHierarchy.customMaterialSubtypeId}`
          : null),
    );
    setDraftArch(archSelectionFromRows(restorations));
    setHierarchyError(null);
    setHierarchyEditOpen(true);
  }

  async function saveHierarchy() {
    if (hierarchySaving || !draftCt) return;
    if (!hierarchyIsMixed &&
        draftCt === firstHierarchy?.caseType &&
        draftSt === (firstHierarchy?.subtype ?? (firstHierarchy?.customSubtypeId ? `custom:${firstHierarchy.customSubtypeId}` : null)) &&
        draftMat === (firstHierarchy?.materialSubtype ?? (firstHierarchy?.customMaterialSubtypeId ? `custom:${firstHierarchy.customMaterialSubtypeId}` : null)) &&
        draftArch === archSelectionFromRows(restorations)) {
      setHierarchyEditOpen(false);
      return;
    }
    setHierarchySaving(true);
    setHierarchyError(null);
    try {
      const catalogCaseTypes =
        hierarchyCatalogQuery.data?.data?.caseTypes ?? [];
      const ctNode = catalogCaseTypes.find((n) => n.key === draftCt);
      const stNode = ctNode?.subtypes.find((n) => n.key === draftSt);
      const matNode = stNode?.materials.find((n) => n.key === draftMat);
      const subtypeCustomId = draftSt ? parseCustomToken(draftSt) : null;
      const matCustomId = draftMat ? parseCustomToken(draftMat) : null;
      const encoded = encodeRestorationSubtype({
        caseType: draftCt,
        subtype: subtypeCustomId ? null : (draftSt as CaseSubtype | null),
        materialSubtype: matCustomId
          ? null
          : (draftMat as MaterialSubtype | null),
        ...(subtypeCustomId ? { customSubtypeId: subtypeCustomId } : {}),
        ...(matCustomId ? { customMaterialSubtypeId: matCustomId } : {}),
      });
      // Use the same canonical representative labels as the desktop so the
      // server always receives an inferrable restorationType, even when no
      // subtype has been chosen yet.
      const HIERARCHY_REPRESENTATIVE: Record<string, string> = {
        restorative: "Crown",
        removable: "Full Denture",
        ortho: "Night Guard",
      };
      const savedLabels = caseHierarchyLabels(firstHierarchy, firstRestoration ?? {}, hierarchyCatalogQuery.data?.data);
      const sameSubtype = draftCt === firstHierarchy?.caseType &&
        draftSt === (firstHierarchy?.subtype ?? (firstHierarchy?.customSubtypeId ? `custom:${firstHierarchy.customSubtypeId}` : null));
      const sameMaterial = sameSubtype &&
        draftMat === (firstHierarchy?.materialSubtype ?? (firstHierarchy?.customMaterialSubtypeId ? `custom:${firstHierarchy.customMaterialSubtypeId}` : null));
      const restorationTypeLabel =
        stNode?.label ??
        (sameSubtype && firstRestoration?.restorationType ? firstRestoration.restorationType : draftSt
          ? draftSt
          : (HIERARCHY_REPRESENTATIVE[draftCt] ?? getCaseTypeLabel(draftCt)));
      // Send explicit null for cleared fields; omission preserves row values.
      const outcome = await saveClinicalDetails(caseId, {
              restorationType: restorationTypeLabel,
              restorationSubtype: encoded ?? null,
              material: (draftMat
                 ? (matNode?.label ?? (sameMaterial && savedLabels.material !== "—" ? savedLabels.material : null))
                : null),
              ...(restorationIds.length === 0 ? { toothNumbers: [] } : {}),
              ...(isArchRequired(draftCt)
                ? {
                    arch:
                      draftArch === "both"
                        ? "upper_lower"
                        : draftArch,
                  }
                : {}),
      });
      setHierarchyEditOpen(false);
      Alert.alert(outcome.invoiceAction === "needs_review" ? "Invoice review required" : "Clinical details saved", clinicalSaveMessage(outcome));
      await refreshClinicalQueries();
    } catch (e) {
      setHierarchyError(errorMessage(e));
    } finally {
      setHierarchySaving(false);
    }
  }

  // ── Removable workflow Step (+ Wax Setup shade) ──────────────────────────
  // The server gates `step`/`stepShade` on admin/owner of the case's lab
  // (PATCH /cases/:id → ADMIN_ROLES check), which is stricter than the
  // hierarchy edit above. Mirror that exactly: everyone else sees plain text.
  const canEditStep = isAdmin;
  const [stepPickerOpen, setStepPickerOpen] = useState(false);
  const [priorityPickerOpen, setPriorityPickerOpen] = useState(false);
  const [stepSaving, setStepSaving] = useState(false);
  const [stepShadeValue, setStepShadeValue] = useState(c.stepShade ?? "");
  const [stepShadeSaving, setStepShadeSaving] = useState(false);
  const stepShadeInFlight = useRef(false);

  // Keep the shade input in sync when the case data refreshes (including the
  // server clearing it after a step change away from wax_setup).
  const latestStepShade = c.stepShade ?? "";
  const [prevStepShade, setPrevStepShade] = useState(latestStepShade);
  if (latestStepShade !== prevStepShade) {
    setPrevStepShade(latestStepShade);
    setStepShadeValue(latestStepShade);
  }

  async function saveStep(next: string | null) {
    setStepPickerOpen(false);
    if ((c.step ?? null) === next) return;
    setStepSaving(true);
    try {
      await update.mutateAsync({
        caseId,
        data: { step: next } as unknown as UpdateCaseInput,
      });
      // The server wipes stepShade whenever the step leaves wax_setup; mirror
      // that locally so the input can't show a stale value.
      if (next !== "wax_setup") setStepShadeValue("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["cases", caseId] }),
      ]);
      await onSaved();
    } catch (err) {
      // Nothing to roll back: the row renders the server's value, so it simply
      // stays as it was — but the failure is surfaced rather than swallowed.
      Alert.alert("Couldn't update step", errorMessage(err));
    } finally {
      setStepSaving(false);
    }
  }

  async function commitStepShade() {
    const trimmed = stepShadeValue.trim();
    if (trimmed === (c.stepShade ?? "").trim()) return;
    // A single-line TextInput fires onSubmitEditing AND onBlur for one submit,
    // both in the same tick — the `stepShadeSaving` state hasn't re-rendered
    // yet, so the in-flight guard has to be a ref or the shade is PATCHed
    // twice and the case history gets a duplicate event.
    if (stepShadeInFlight.current) return;
    stepShadeInFlight.current = true;
    setStepShadeSaving(true);
    try {
      await update.mutateAsync({
        caseId,
        data: { stepShade: trimmed || null } as unknown as UpdateCaseInput,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: ["cases", caseId] }),
      ]);
      await onSaved();
    } catch (err) {
      setStepShadeValue(c.stepShade ?? "");
      Alert.alert("Couldn't update shade", errorMessage(err));
    } finally {
      stepShadeInFlight.current = false;
      setStepShadeSaving(false);
    }
  }

  // ── PFM "don't forget to charge for alloy" reminder ──────────────────
  // Shows whenever any restoration on the case is PFM. Dismissible for just
  // this case, or permanently via "Don't show again" (persisted).
  const hasPfmRestoration = (c.restorations ?? []).some((r) =>
    /pfm/i.test(r.material ?? ""),
  );
  const alloyLine = (c.restorations ?? []).find(
    (r) =>
      ((r as { priceKey?: string | null }).priceKey ?? "") === "alloy" ||
      ((r as { restorationType?: string | null }).restorationType ?? "")
        .trim()
        .toLowerCase() === "alloy",
  );
  const hasAlloyCharge = !!alloyLine;
  const alloyUnpriced =
    !!alloyLine &&
    Number(
      (alloyLine as { unitPrice?: string | number | null }).unitPrice ?? 0,
    ) <= 0;
  const [pfmReminderDismissed, setPfmReminderDismissed] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dontShow = await AsyncStorage.getItem(
          "labtrax_pfm_alloy_reminder_dontshow_v1",
        );
        if (dontShow === "1") {
          if (!cancelled) setPfmReminderDismissed(true);
          return;
        }
        const raw = await AsyncStorage.getItem(
          "labtrax_pfm_alloy_reminder_dismissed_cases_v1",
        );
        const ids: string[] = raw ? JSON.parse(raw) : [];
        if (!cancelled)
          setPfmReminderDismissed(Array.isArray(ids) && ids.includes(caseId));
      } catch {
        if (!cancelled) setPfmReminderDismissed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId]);
  const dismissPfmReminderThisCase = useCallback(async () => {
    setPfmReminderDismissed(true);
    try {
      const raw = await AsyncStorage.getItem(
        "labtrax_pfm_alloy_reminder_dismissed_cases_v1",
      );
      const ids: string[] = raw ? JSON.parse(raw) : [];
      const next = Array.isArray(ids) ? ids : [];
      if (!next.includes(caseId)) next.push(caseId);
      await AsyncStorage.setItem(
        "labtrax_pfm_alloy_reminder_dismissed_cases_v1",
        JSON.stringify(next),
      );
    } catch {
      /* ignore persistence failures */
    }
  }, [caseId]);
  const dismissPfmReminderForever = useCallback(async () => {
    setPfmReminderDismissed(true);
    try {
      await AsyncStorage.setItem("labtrax_pfm_alloy_reminder_dontshow_v1", "1");
    } catch {
      /* ignore persistence failures */
    }
  }, []);
  // Resolved alloy price preview (Task #2075) so the reminder can show what
  // the charge will be before it's tapped. Fetched only while the reminder is
  // actually showing (PFM present, no alloy line yet, not dismissed).
  const showPfmReminder =
    hasPfmRestoration && !hasAlloyCharge && !pfmReminderDismissed;
  const [alloyPreview, setAlloyPreview] = useState<{
    amount: number;
    priced: boolean;
  } | null>(null);
  const [alloyPreviewLoaded, setAlloyPreviewLoaded] = useState(false);
  useEffect(() => {
    if (!showPfmReminder) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await resilientFetch(
          `/api/cases/${caseId}/alloy-charge/preview`,
        );
        if (!res.ok) return;
        const body = await res.json();
        const data = body?.data ?? body;
        if (!cancelled && data && typeof data.amount === "number") {
          setAlloyPreview({ amount: data.amount, priced: !!data.priced });
        }
      } catch {
        /* leave preview null — banner falls back to generic copy */
      } finally {
        if (!cancelled) setAlloyPreviewLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showPfmReminder, caseId]);

  // One-tap "Add alloy charge" from the PFM reminder (Task #2067). Adds a
  // priced Alloy line server-side (idempotent), then refetches so the
  // reminder gives way to the new line.
  const [addingAlloy, setAddingAlloy] = useState(false);
  const addAlloyCharge = useCallback(async () => {
    setAddingAlloy(true);
    try {
      const res = await resilientFetch(`/api/cases/${caseId}/alloy-charge`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Request failed");
      await Promise.all([
        onSaved(),
        qc.invalidateQueries({ queryKey: ["invoices"] }),
      ]);
    } catch (e) {
      Alert.alert("Couldn't add alloy charge", errorMessage(e));
    } finally {
      setAddingAlloy(false);
    }
  }, [caseId, onSaved, qc]);

  // Inline "set alloy price" from the PFM reminder (Task #2077). When the
  // alloy line was added at $0 (no tier/override has an alloy price), an admin
  // can set it right here; the server writes it to the tier/override the case
  // resolves to and re-prices the line + invoice.
  const [alloyPriceInput, setAlloyPriceInput] = useState("");
  const [settingAlloyPrice, setSettingAlloyPrice] = useState(false);
  const setAlloyPrice = useCallback(async () => {
    const parsed = Number(alloyPriceInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      Alert.alert("Enter a price", "Please enter an alloy price above $0.");
      return;
    }
    setSettingAlloyPrice(true);
    try {
      const res = await resilientFetch(`/api/cases/${caseId}/alloy-price`, {
        method: "POST",
        body: JSON.stringify({ price: parsed }),
      });
      if (!res.ok) throw new Error("Request failed");
      const body = (await res.json().catch(() => null)) as {
        data?: { target?: { kind?: string; name?: string } };
      } | null;
      const target = body?.data?.target;
      setAlloyPriceInput("");
      await Promise.all([
        onSaved(),
        qc.invalidateQueries({ queryKey: ["invoices"] }),
      ]);
      if (target?.name) {
        Alert.alert(
          "Alloy price set",
          `Saved to ${target.kind === "tier" ? "tier" : "override"} “${target.name}”.`,
        );
      }
    } catch (e) {
      Alert.alert("Couldn't set the alloy price", errorMessage(e));
    } finally {
      setSettingAlloyPrice(false);
    }
  }, [alloyPriceInput, caseId, onSaved]);

  // ── Barcode conflict check — debounced, fires 400 ms after last keystroke ──
  const [editBarcodeConflict, setEditBarcodeConflict] = useState<{
    caseNumber?: string | null;
  } | null>(null);
  const [editBarcodeChecking, setEditBarcodeChecking] = useState(false);
  useEffect(() => {
    const trimmed = form.casePanBarcode.trim();
    const labOrgId = c.labOrganizationId ?? c.organizationId ?? null;
    if (!trimmed || !labOrgId) {
      setEditBarcodeConflict(null);
      setEditBarcodeChecking(false);
      return;
    }
    setEditBarcodeChecking(true);
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          barcode: trimmed,
          labOrganizationId: labOrgId,
        });
        const res = await resilientFetch(`/api/cases?${qs.toString()}`);
        if (!res.ok) {
          setEditBarcodeConflict(null);
          return;
        }
        const body = (await res.json()) as {
          data?: Array<{ id?: string; caseNumber?: string | null }>;
        };
        const matches = body?.data ?? [];
        const conflict = matches.find((m) => m.id !== caseId) ?? null;
        setEditBarcodeConflict(conflict);
      } catch {
        setEditBarcodeConflict(null);
      } finally {
        setEditBarcodeChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [form.casePanBarcode, c.labOrganizationId, c.organizationId, caseId]);

  // ── Related cases (same patient only) with long-press locate ─────────────
  const relatedCasesQuery = useCases();
  const allCases = relatedCasesQuery.data ?? [];

  const relatedCases = useMemo(() => {
    const pFirst = (c.patientFirstName ?? "").trim().toLowerCase();
    const pLast = (c.patientLastName ?? "").trim().toLowerCase();
    const hasPatient = !!(pFirst || pLast);
    if (!hasPatient) return [];
    return allCases.filter((other) => {
      if (other.id === caseId) return false;
      const oFirst = (other.patientFirstName ?? "").trim().toLowerCase();
      const oLast = (other.patientLastName ?? "").trim().toLowerCase();
      return oFirst === pFirst && oLast === pLast;
    });
  }, [allCases, caseId, c.patientFirstName, c.patientLastName]);

  const {
    markLongPress: markRelatedLongPress,
    consumeLongPress: consumeRelatedLongPress,
  } = useLongPressGuard<string>();
  const [relatedQuickActionCase, setRelatedQuickActionCase] =
    useState<CanonicalCase | null>(null);


  function startEdit() {
    setPriorityPickerOpen(false);
    setImplantDrafts(Object.fromEntries((c.restorations ?? []).filter((row) => row.id).map((row) => [row.id!, row])));
    confirmedImplants.current = {};
    const nextForm = formFromCase(c);
    setForm(nextForm);
    setClinicalDraft(clinicalDraftFromCase(c));
    setDueTimeEnabled(!!nextForm.dueTime);
    setEditing(true);
  }

  function cancelEdit() {
    setPicker(null);
    setPriorityPickerOpen(false);
    setDueTimeEnabled(!!c.dueTime);
    setEditing(false);
  }

  async function save() {
    if (overviewSaveInFlight.current) return;
    const payload = buildOverviewPayload(c, form);
    const clinical = buildClinicalPayload(c, clinicalDraft, canEditStep);
    const clinicalHierarchy = deriveCaseHierarchy(clinicalDraft.restorationType, clinicalDraft.restorationSubtype, clinicalDraft.material);
    if (clinical && isArchRequired(clinicalHierarchy.caseType) && !clinicalDraft.arch) {
      Alert.alert("Arch required", "Choose an arch for Removable and Ortho cases.");
      return;
    }
    const implantRows = (c.restorations ?? []).filter((row) => row.id && implantDrafts[row.id] &&
      IMPLANT_FIELDS.some((key) => (implantDrafts[row.id!][key] || null) !== ((confirmedImplants.current[row.id!] ?? row)[key] || null)));
    if (Object.keys(payload).length === 0 && !clinical && !implantRows.length) {
      cancelEdit();
      return;
    }
    overviewSaveInFlight.current = true;
    setOverviewSaving(true);
    try {
      for (const row of implantRows) {
        const draft = implantDrafts[row.id!];
        const response = await resilientFetch(`/api/cases/${caseId}/restorations/${row.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, draft[key] || null])), syncLinkedArch: false }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          setImplantDrafts((current) => ({ ...current, [row.id!]: confirmedImplants.current[row.id!] ?? row }));
          throw new Error(body?.error || "Could not save implant details.");
        }
        confirmedImplants.current[row.id!] = { ...draft };
      }
      const result = Object.keys(payload).length > 0
        ? await update.mutateAsync({ caseId, data: payload })
        : undefined;
      const outcome = clinical ? await saveClinicalDetails(caseId, clinical) : null;
      setPicker(null);
      setEditing(false);
      if (outcome) {
        Alert.alert(outcome.invoiceAction === "needs_review" ? "Invoice review required" : "Clinical details saved", clinicalSaveMessage(outcome));
      }
      await refreshClinicalQueries().catch(() => undefined);
      // If a non-empty barcode was assigned (new or changed), prefer the value
      // returned by the server (inside the { data: { casePanBarcode } } envelope)
      // so the print prompt reflects any server-side normalisation; fall back to
      // the payload value if the response doesn't carry the field.
      const resultData = result?.data as Record<string, unknown> | undefined;
      const savedBarcode =
        (typeof resultData?.casePanBarcode === "string"
          ? resultData.casePanBarcode
          : undefined) ?? payload.casePanBarcode;
      if (savedBarcode && savedBarcode.trim()) {
        setPendingPrintBarcode(savedBarcode.trim());
        setPrintModalVisible(true);
      }
    } catch (e) {
      Alert.alert("Couldn't save changes", errorMessage(e));
    } finally {
      overviewSaveInFlight.current = false;
      setOverviewSaving(false);
    }
  }

  async function refreshClinicalQueries() {
    const results = await Promise.allSettled([
      Promise.resolve().then(onSaved),
      qc.invalidateQueries({ queryKey: ["cases"] }),
      qc.invalidateQueries({ queryKey: ["cases", caseId] }),
      qc.invalidateQueries({ queryKey: ["invoices"] }),
      qc.invalidateQueries({ queryKey: ["invoice-for-case", caseId] }),
      qc.invalidateQueries({ queryKey: ["invoice-detail"] }),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      console.warn("Case saved; some case or invoice views could not be refreshed.");
    }
  }

  const caseDetailsActionHandlers = useRef({
    onCancel: cancelEdit,
    onSave: save,
  });
  caseDetailsActionHandlers.current = {
    onCancel: cancelEdit,
    onSave: save,
  };
  const rxNotesActionHandlers = useRef({
    onCancel: cancelRxNotes,
    onSave: saveRxNotes,
  });
  rxNotesActionHandlers.current = {
    onCancel: cancelRxNotes,
    onSave: saveRxNotes,
  };

  useEffect(() => {
    if (!editing) return;
    registerScreenEditActions({
      owner: "case-details",
      onCancel: () => caseDetailsActionHandlers.current.onCancel(),
      onSave: () => {
        void caseDetailsActionHandlers.current.onSave();
      },
      cancelLabel: "Cancel",
      saveLabel: "Save",
      cancelTestID: "overview-cancel",
      saveTestID: "overview-save",
      isSaving: update.isPending || overviewSaving,
      disabled: update.isPending || overviewSaving,
    });
    return () => unregisterScreenEditActions("case-details");
  }, [
    editing,
    registerScreenEditActions,
    unregisterScreenEditActions,
  ]);

  useEffect(() => {
    if (editing) {
      updateScreenEditActions("case-details", {
        isSaving: update.isPending || overviewSaving,
        disabled: update.isPending || overviewSaving,
      });
    }
  }, [editing, update.isPending, overviewSaving, updateScreenEditActions]);

  useEffect(() => {
    if (!rxNotesEditing) return;
    registerScreenEditActions({
      owner: "rx-notes",
      onCancel: () => rxNotesActionHandlers.current.onCancel(),
      onSave: () => {
        void rxNotesActionHandlers.current.onSave();
      },
      cancelLabel: "Cancel",
      saveLabel: "Save",
      cancelTestID: "overview-rx-cancel",
      saveTestID: "overview-rx-save",
      isSaving: rxNotesSaving,
      disabled: rxNotesSaving,
    });
    return () => unregisterScreenEditActions("rx-notes");
  }, [
    rxNotesEditing,
    registerScreenEditActions,
    unregisterScreenEditActions,
  ]);

  useEffect(() => {
    if (rxNotesEditing) {
      updateScreenEditActions("rx-notes", {
        isSaving: rxNotesSaving,
        disabled: rxNotesSaving,
      });
    }
  }, [rxNotesEditing, rxNotesSaving, updateScreenEditActions]);

  // Quick rush toggle — always available outside Edit mode. Flips priority
  // between "rush" and "normal" via the same case PATCH the edit form uses,
  // then refreshes so the badge/detail/read-only display update immediately.
  async function toggleRush() {
    const isRushNow = (c.priority ?? "normal").toLowerCase() === "rush";
    const next: UpdateCaseInputPriority = isRushNow ? "normal" : "rush";
    setTogglingRush(true);
    try {
      await update.mutateAsync({ caseId, data: { priority: next } });
      await Promise.all([
        onSaved(),
        qc.invalidateQueries({ queryKey: ["cases"] }),
      ]);
    } catch (e) {
      Alert.alert("Couldn't update rush status", errorMessage(e));
    } finally {
      setTogglingRush(false);
    }
  }

  async function printLabel() {
    if (!pendingPrintBarcode) return;
    setPrintLoading(true);
    try {
      await printCaseLabel(c, { labName, barcode: pendingPrintBarcode });
    } catch (e) {
      Alert.alert(
        "Print error",
        e instanceof Error ? e.message : "Could not open the print dialog.",
      );
    } finally {
      setPrintLoading(false);
      setPrintModalVisible(false);
      setPendingPrintBarcode(null);
    }
  }

  const savedArch = archSelectionFromRows(restorations);
  const showArch = !hierarchyIsMixed && firstHierarchy?.caseType && isArchRequired(firstHierarchy.caseType);
  const stepIsRemovable = hierarchyEditOpen
    ? draftCt === "removable"
    : firstHierarchy?.caseType === "removable" ||
      restorations.some((row) => isRemovableRestorationType(row.restorationType ?? ""));
  const restorationFields = (
    <View style={styles.restorationDetailsPanel} testID="overview-restoration-details">
      {editing ? <>
        <CaseClinicalEditor
          value={clinicalDraft}
          onChange={setClinicalDraft}
          catalog={hierarchyCatalogQuery.data?.data}
          canEditHierarchy={canEdit}
          canEditStep={canEditStep}
          disabled={overviewSaving || update.isPending}
          empty={restorations.filter((row) => row.restorationType !== "missing").length === 0}
          mixed={hierarchyIsMixed}
        />
        {isImplantRestoration(clinicalDraft) && restorations.filter((row) => row.id).map((row, index) => <View key={row.id} style={{ gap: Spacing.sm }}>
          <Text style={[Typography.h3, { color: colors.text }]}>Line {index + 1} · Tooth {row.toothNumber || "—"} · Implant</Text>
          <ImplantDetailsControls fieldLayout="overview" value={implantDrafts[row.id!] ?? row}
            onChange={(details) => setImplantDrafts((current) => ({ ...current, [row.id!]: details }))}
            disabled={overviewSaving || update.isPending || !canEdit} />
        </View>)}
        <EditTextRow stacked label="Gingival shade" value={form.gingivialShade}
          onChangeText={(t) => setForm((f) => ({ ...f, gingivialShade: t }))}
          styles={styles} colors={colors} testID="clinical-gingival-shade" />
      </> : <>
        <CaseHierarchyQuickPicker
          key={caseId} caseId={caseId} hierarchy={firstHierarchy}
          savedValues={firstRestoration ?? {}} canEdit={canEdit}
          empty={restorations.length === 0} mixed={hierarchyIsMixed}
          catalog={hierarchyCatalogQuery.data?.data}
          arch={savedArch ?? ""} refresh={refreshClinicalQueries}
        />
        {showArch ? <CaseDetailSelect label="Arch"
          valueLabel={savedArch === "both" ? "Upper + Lower" : savedArch === "upper" ? "Upper" : savedArch === "lower" ? "Lower" : "Required"}
          valueTestID="hierarchy-arch-value" testID="hierarchy-edit-arch-btn"
          expanded={hierarchyEditOpen} disabled={hierarchySaving}
          onPress={canEdit ? openHierarchyEdit : undefined} /> : null}
        {stepIsRemovable ? <>
          <CaseDetailSelect label="Step" valueLabel={stepLabel(c.step)}
            testID="step-select" valueTestID={canEditStep ? undefined : "step-value"}
            expanded={stepPickerOpen} busy={stepSaving}
            onPress={canEditStep ? () => setStepPickerOpen(true) : undefined} />
          {c.step === "wax_setup" ? <CaseDetailField label="Wax Setup Shade">
            {canEditStep ? <>
              <TextInput
                style={[caseDetailFieldStyles.input, { color: colors.text, borderColor: colors.border }]}
                value={stepShadeValue} onChangeText={setStepShadeValue}
                onBlur={() => void commitStepShade()} onSubmitEditing={() => void commitStepShade()}
                placeholder="e.g. A2" placeholderTextColor={colors.textTertiary}
                editable={!stepShadeSaving} returnKeyType="done"
                accessibilityLabel="Wax Setup Shade" testID="step-shade-input" />
              {stepShadeSaving ? <ActivityIndicator size="small" color={colors.textTertiary} /> : null}
            </> : <Text testID="step-shade-value" style={styles.bodyText}>{c.stepShade || "—"}</Text>}
          </CaseDetailField> : null}
        </> : null}
      </>}
      <View style={styles.restorationFieldStack} testID="tooth-shade-custom-shade">
        <View style={styles.restorationFieldStack} testID="overview-tooth-custom-shade">
          <MobileToothShadeRows
            restorations={restorations} caseId={caseId} labOrganizationId={labOrganizationId}
            canEdit={canEdit && !editing} onSaved={onSaved}
            legacyTeeth={restorations.length ? "" : c.teeth ?? ""}
            legacyShade={c.shade ?? ""}
          />
          {editing && canEdit ? <Text style={[Typography.caption, { color: colors.textSecondary }]}>
            Individual tooth and arch shades can be changed in Overview after closing Edit. The Shade field above is a draft applied on Save.
          </Text> : null}
          {(!editing || !isImplantRestoration(clinicalDraft)) && restorations.filter(isImplantRestoration).map((row, index) =>
            <SavedImplantDetails key={row.id ?? index} fieldLayout="overview" row={row} caseId={caseId} canEdit={canEdit} />)}
          <CustomShadeMetadata c={c} canEdit={canEdit}
            saving={customShadeSaving || customShadeTechSaving}
            techValue={customShadeTechValue} onTechChange={setCustomShadeTechValue}
            onTechCommit={() => void commitCustomShadeTech()} onToggle={patchCustomShade}
            styles={styles} colors={colors} />
        </View>
      </View>
      {!editing && c.gingivialShade?.trim() ? <CaseDetailField label="Gingival shade">
        <Text style={styles.bodyText}>{c.gingivialShade}</Text>
      </CaseDetailField> : null}
      {c.bridgeConnectors?.trim() ? <CaseDetailField label="Bridge connectors">
        <Text style={styles.bodyText}>{c.bridgeConnectors}</Text>
      </CaseDetailField> : null}
      {!editing ? <CaseDetailField label="Received Date">
        <Text style={styles.bodyText}>{formatDate(c.receivedAt)}</Text>
      </CaseDetailField> : null}
    </View>
  );

  return (
    <View style={styles.sectionGap}>
      {!editing ? (
        <View style={styles.caseActionRow} testID="overview-case-actions">
          <Pressable
            hitSlop={4}
            testID="overview-preview-rx"
            accessibilityRole="button"
            accessibilityLabel="Preview prescription"
            onPress={() => setRxPreviewOpen(true)}
            style={[
              styles.caseActionButton,
              {
                backgroundColor: colors.tintLight,
                borderColor: colors.tint,
              },
            ]}
          >
            <Ionicons
              name="document-text-outline"
              size={14}
              color={colors.tint}
            />
            <Text style={[styles.caseActionButtonText, { color: colors.tint }]}>
              Preview Rx
            </Text>
          </Pressable>
          {canEdit ? (
            <Pressable
              hitSlop={6}
              onPress={toggleRush}
              disabled={togglingRush}
              accessibilityRole="button"
              accessibilityLabel={
                (c.priority ?? "normal").toLowerCase() === "rush"
                  ? "Clear rush"
                  : "Mark as rush"
              }
              testID="rush-toggle"
              style={[
                styles.caseActionButton,
                {
                  backgroundColor: colors.tintLight,
                  borderColor: colors.tint,
                  opacity: togglingRush ? 0.6 : 1,
                },
              ]}
            >
              {togglingRush ? (
                <ActivityIndicator size="small" color={colors.tint} />
              ) : (
                <Text style={[styles.caseActionButtonText, { color: rushColor ?? colors.tint }]}>
                  {(c.priority ?? "normal").toLowerCase() === "rush"
                    ? "Clear rush"
                    : "Mark rush"}
                </Text>
              )}
            </Pressable>
          ) : null}
          {/* Exception workflow is lab-internal and open to every active
              member of the lab. Resolution permissions are checked separately
              inside the detail sheet. */}
          {isLabMember ? (
            activeException ? (
              <Pressable
                hitSlop={4}
                testID="case-exception-open"
                accessibilityRole="button"
                accessibilityLabel="Open exception case"
                onPress={() => setExceptionDetailOpen(true)}
                style={[
                  styles.caseActionButton,
                  {
                    backgroundColor: colors.warningLight,
                    borderColor: colors.warningStrong,
                  },
                ]}
              >
                <Ionicons
                  name="alert-circle-outline"
                  size={14}
                  color={colors.warningStrong}
                />
                <Text
                  style={[
                    styles.caseActionButtonText,
                    { color: colors.warningStrong },
                  ]}
                >
                  Exception case
                </Text>
              </Pressable>
            ) : (
              <Pressable
                hitSlop={4}
                testID="case-exception-create"
                accessibilityRole="button"
                accessibilityLabel="Create exception case"
                onPress={() => setExceptionCreateOpen(true)}
                style={[
                  styles.caseActionButton,
                  {
                    backgroundColor: colors.tintLight,
                    borderColor: colors.tint,
                  },
                ]}
              >
                <Ionicons
                  name="alert-circle-outline"
                  size={14}
                  color={colors.tint}
                />
                <Text
                  style={[styles.caseActionButtonText, { color: colors.tint }]}
                >
                  Create Exception Case
                </Text>
              </Pressable>
            )
          ) : null}

          {isAdmin &&
          !!c.doctorName &&
          !!c.providerOrganizationId &&
          !!(c.labOrganizationId ?? c.organizationId) ? (
            <Pressable
              hitSlop={4}
              testID="doctor-reassign-action"
              accessibilityRole="button"
              accessibilityLabel="Reassign doctor"
              onPress={() => {
                if (editing) {
                  Alert.alert("Save or cancel edits first", "Save or cancel your doctor/practice edits before reassigning.");
                  return;
                }
                setReassignOpen(true);
              }}
              style={[
                styles.caseActionButton,
                {
                  backgroundColor: colors.tintLight,
                  borderColor: colors.tint,
                },
              ]}
            >
              <Ionicons
                name="swap-horizontal"
                size={14}
                color={colors.tint}
              />
              <Text style={[styles.caseActionButtonText, { color: colors.tint }]}>
                Reassign
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Card testID="overview-details-card">
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            columnGap: Spacing.md,
            rowGap: Spacing.xs,
            marginBottom: Spacing.sm,
          }}
        >
          <Text
            style={[
              styles.cardHeading,
              styles.cardHeadingFlush,
              {
                fontSize: 18,
                fontWeight: "700",
              },
            ]}
          >
            Case Details
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            minHeight: 30,
            marginBottom: Spacing.sm,
          }}
          testID="overview-header-actions"
        >
          {!editing && canEdit ? (
            <Pressable
              style={styles.editBtn}
              onPress={startEdit}
              hitSlop={8}
              testID="overview-edit"
            >
              <Ionicons name="create-outline" size={16} color={colors.tint} />
              <Text style={styles.editBtnText}>Edit</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={[styles.relatedDivider, { backgroundColor: colors.border }]} />
        <View style={{ marginTop: Spacing.sm, marginBottom: Spacing.md, gap: Spacing.sm }}>
          <View style={[styles.fieldRow, { justifyContent: "flex-start", gap: Spacing.md }]}>
            <Text style={styles.fieldLabel}>Case #</Text>
            <Text style={[styles.fieldValue, { fontVariant: ["tabular-nums"] }]}>
              {c.caseNumber || "—"}
            </Text>
          </View>
        </View>

        <View style={styles.scheduleSummary} testID="overview-schedule">
          <View style={styles.scheduleMetric}>
            <Text testID="overview-date-created" style={styles.scheduleValue}>
              Date Created: {formatDate(c.createdAt)}
            </Text>
          </View>
          <View style={styles.scheduleMetric}>
            <Text testID="overview-due-date" style={styles.scheduleValue}>
              Due Date: {formatDueDate(c.dueDate, c.dueTime)}
            </Text>
          </View>
          <View style={styles.scheduleMetric}>
            <Text testID="overview-priority" style={styles.scheduleValue}>
              Priority: {(c.priority ?? "normal").toLowerCase() === "rush" ? "Rush" : "Standard"}
            </Text>
          </View>
        </View>

        {!editing ? restorationFields : null}
        {editing ? (
          <View testID="overview-edit-fields">
            <Text style={styles.detailSectionTitle}>Schedule &amp; Priority</Text>
            <SelectRow
              stacked
              label="Received Date"
              valueLabel={
                form.receivedAt
                  ? formatSharedCalendarDate(form.receivedAt) ?? "—"
                  : "—"
              }
              icon="calendar-outline"
              onPress={() => setPicker("receivedAt")}
              styles={styles}
              colors={colors}
              testID="select-received"
            />
            <SelectRow
              stacked
              label="Due date"
              valueLabel={formatDateInput(form.dueDate)}
              icon="calendar-outline"
              onPress={() => setPicker("dueDate")}
              styles={styles}
              colors={colors}
              testID="select-due"
            />
            {form.dueDate ? (
              <View style={styles.dueTimeSection}>
                <Pressable
                  style={styles.checkboxRow}
                  onPress={() => {
                    const next = !dueTimeEnabled;
                    setDueTimeEnabled(next);
                    if (!next) setForm((f) => ({ ...f, dueTime: "" }));
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: dueTimeEnabled }}
                  testID="select-due-time-toggle"
                >
                  <View
                    style={[
                      styles.checkbox,
                      dueTimeEnabled && styles.checkboxChecked,
                    ]}
                  >
                    {dueTimeEnabled ? (
                      <Ionicons
                        name="checkmark"
                        size={15}
                        color={colors.textInverse}
                      />
                    ) : null}
                  </View>
                  <Text style={styles.checkboxLabel}>
                    Set a specific time the case is due
                  </Text>
                </Pressable>
                {dueTimeEnabled ? (
                  <SelectRow
                    stacked
                    label="Due time"
                    valueLabel={formatDueTime(form.dueTime) ?? "Select a time"}
                    icon="time-outline"
                    onPress={() => setPicker("dueTime")}
                    styles={styles}
                    colors={colors}
                    testID="select-due-time"
                  />
                ) : null}
              </View>
            ) : null}
            <View style={{ gap: Spacing.xs, marginVertical: Spacing.md }}>
              <CaseDetailSelect label="Priority"
                valueLabel={PRIORITY_OPTIONS.find((option) => option.value === form.priority)?.label ?? form.priority}
                testID="priority-select" valueTestID="priority-value"
                expanded={priorityPickerOpen} disabled={overviewSaving || update.isPending}
                onPress={() => setPriorityPickerOpen((open) => !open)} />
              {priorityPickerOpen ? <CaseDetailOptions label="Priority"
                options={PRIORITY_OPTIONS.map((option) => ({ key: option.value, label: option.label }))}
                selected={form.priority} disabled={overviewSaving || update.isPending}
                optionTestID={(key) => `priority-${key}`}
                onSelect={(priority) => {
                  setForm((f) => ({ ...f, priority }));
                  setPriorityPickerOpen(false);
                }} /> : null}
            </View>
            {restorationFields}
            <View testID="overview-edit-patient-provider">
              <Text style={styles.detailSectionTitle}>Patient &amp; Provider</Text>
              <EditTextRow stacked label="Patient first name" value={form.patientFirstName}
                onChangeText={(t) => setForm((f) => ({ ...f, patientFirstName: t }))} styles={styles} colors={colors} />
              <EditTextRow stacked label="Patient last name" value={form.patientLastName}
                onChangeText={(t) => setForm((f) => ({ ...f, patientLastName: t }))} styles={styles} colors={colors} />
              <EditTextRow stacked label="Doctor" value={form.doctorName}
                onChangeText={(t) => setForm((f) => ({ ...f, doctorName: t }))} styles={styles} colors={colors} />
            </View>
            <View style={styles.editRow}>
              <Text style={[caseDetailFieldStyles.heading, { color: colors.text }]}>Pan Barcode</Text>
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: Spacing.xs,
                  }}
                >
                  <TextInput
                    style={[
                      styles.input,
                      { flex: 1, fontVariant: ["tabular-nums"] },
                    ]}
                    value={form.casePanBarcode}
                    onChangeText={(t) =>
                      setForm((f) => ({ ...f, casePanBarcode: t }))
                    }
                    placeholder="Scan or type… (blank to clear)"
                    placeholderTextColor={colors.textTertiary}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    testID="barcode-input"
                  />
                  <Pressable
                    hitSlop={8}
                    testID="scan-barcode-edit-btn"
                    onPress={() => {
                      clearAiReaderSession();
                      setAiReaderSession({
                        caseId,
                        caseNumber: c.caseNumber ?? null,
                        patientName:
                          [c.patientFirstName, c.patientLastName]
                            .filter(Boolean)
                            .join(" ") || null,
                        doctorName: c.doctorName ?? null,
                        dueDate: c.dueDate ?? null,
                        labOrgId:
                          c.labOrganizationId ?? c.organizationId ?? null,
                        labName: labName ?? null,
                        gingivialShade: c.gingivialShade ?? null,
                      });
                      router.push("/ai-reader/barcode" as never);
                    }}
                  >
                    <Ionicons
                      name="barcode-outline"
                      size={22}
                      color={colors.tint}
                    />
                  </Pressable>
                </View>
                {editBarcodeChecking && (
                  <Text
                    style={{
                      fontSize: 11,
                      color: colors.textTertiary,
                      marginTop: 4,
                    }}
                  >
                    Checking barcode…
                  </Text>
                )}
                {!editBarcodeChecking && editBarcodeConflict && (
                  <Text
                    style={{ fontSize: 11, color: "#d97706", marginTop: 4 }}
                  >
                    {`⚠ This barcode is already used by an active case${editBarcodeConflict.caseNumber ? ` (Case #${editBarcodeConflict.caseNumber})` : ""}.`}
                  </Text>
                )}
              </View>
            </View>

              <Text style={styles.detailSectionTitle}>Rx Notes</Text>
              <EditTextRow
                stacked
                label="Prescription Notes"
                value={form.rxNotes}
                onChangeText={(text) => setForm((f) => ({ ...f, rxNotes: text }))}
                styles={styles}
                colors={colors}
                testID="clinical-rx-notes"
                multiline
              />

            {activeScreenActionOwner !== "case-details" ? (
              <View style={styles.editActions}>
                <Pressable
                  style={styles.btnSecondary}
                  onPress={cancelEdit}
                  disabled={update.isPending || overviewSaving}
                  testID="overview-cancel"
                >
                  <Text style={styles.btnSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.btnPrimary,
                    (update.isPending || overviewSaving) && styles.btnDisabled,
                  ]}
                  onPress={save}
                  disabled={update.isPending || overviewSaving}
                  testID="overview-save"
                >
                  {update.isPending || overviewSaving ? (
                    <ActivityIndicator color={colors.textInverse} size="small" />
                  ) : (
                    <Text style={styles.btnPrimaryText}>Save</Text>
                  )}
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
          <View>
            {!editing && hasPfmRestoration && !hasAlloyCharge && !pfmReminderDismissed && (
              <View style={styles.pfmReminder}>
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={colors.warningStrong}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pfmReminderText}>
                    {alloyPreviewLoaded && alloyPreview && !alloyPreview.priced
                      ? "PFM detected — no alloy price set in your fee schedule."
                      : "PFM detected — don't forget to charge for alloy."}
                  </Text>
                  <View style={styles.pfmReminderActions}>
                    {alloyPreviewLoaded &&
                    alloyPreview &&
                    !alloyPreview.priced ? (
                      <Pressable hitSlop={8} onPress={onGoToInvoice}>
                        <Text style={styles.pfmReminderAdd}>Go to invoice</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        hitSlop={8}
                        onPress={addAlloyCharge}
                        disabled={
                          addingAlloy || !alloyPreview || !alloyPreview.priced
                        }
                      >
                        <Text
                          style={[
                            styles.pfmReminderAdd,
                            (!alloyPreview || !alloyPreview.priced) && {
                              opacity: 0.5,
                            },
                          ]}
                        >
                          {addingAlloy
                            ? "Adding…"
                            : !alloyPreviewLoaded
                              ? "Checking alloy price…"
                              : alloyPreview && alloyPreview.priced
                                ? `Add alloy charge ($${alloyPreview.amount.toFixed(2)})`
                                : "Add alloy charge"}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable hitSlop={8} onPress={dismissPfmReminderThisCase}>
                      <Text style={styles.pfmReminderDismiss}>Dismiss</Text>
                    </Pressable>
                    <Pressable hitSlop={8} onPress={dismissPfmReminderForever}>
                      <Text style={styles.pfmReminderDontShow}>
                        Don't show again
                      </Text>
                    </Pressable>
                  </View>
                </View>
                <Pressable
                  hitSlop={8}
                  onPress={dismissPfmReminderThisCase}
                  accessibilityLabel="Dismiss reminder"
                >
                  <Ionicons
                    name="close"
                    size={16}
                    color={colors.warningStrong}
                  />
                </Pressable>
              </View>
            )}
            {!editing && alloyUnpriced && isAdmin && (
              <View style={styles.pfmReminder}>
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={colors.warningStrong}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pfmReminderText}>
                    Alloy charge added at $0 — no alloy price is set for this
                    case's pricing tier.
                  </Text>
                  <View style={styles.alloyPriceRow}>
                    <View style={styles.alloyPriceInputWrap}>
                      <Text style={styles.alloyPriceCurrency}>$</Text>
                      <TextInput
                        style={styles.alloyPriceInput}
                        value={alloyPriceInput}
                        onChangeText={setAlloyPriceInput}
                        placeholder="0.00"
                        placeholderTextColor={colors.textSecondary}
                        keyboardType="decimal-pad"
                        editable={!settingAlloyPrice}
                        accessibilityLabel="Alloy price"
                      />
                    </View>
                    <Pressable
                      hitSlop={8}
                      onPress={setAlloyPrice}
                      disabled={
                        settingAlloyPrice || !(Number(alloyPriceInput) > 0)
                      }
                      style={[
                        styles.alloyPriceButton,
                        (settingAlloyPrice ||
                          !(Number(alloyPriceInput) > 0)) && { opacity: 0.5 },
                      ]}
                    >
                      <Text style={styles.alloyPriceButtonText}>
                        {settingAlloyPrice ? "Saving…" : "Set alloy price"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            )}
            <View
              style={styles.patientProviderPanel}
              testID="overview-patient-doctor-practice"
            >
              {!editing ? <Text style={styles.detailSectionTitle}>Patient &amp; Provider</Text> : null}
              <View
                style={[
                  styles.patientProviderGrid,
                  useLargeTextOverviewLayout && styles.patientProviderGridLargeText,
                ]}
                testID="overview-patient-provider-grid"
              >
              {!editing ? (
              <>
              <View
                style={[
                  styles.patientProviderField,
                  useLargeTextOverviewLayout && styles.patientProviderFieldLargeText,
                ]}
                testID="overview-patient-details"
              >
                <Text style={[styles.infoFieldLabel, rushColor ? { color: rushColor } : undefined]}>
                  Patient
                </Text>
                <Text
                  testID="overview-patient-name"
                  style={styles.patientNameValue}
                >
                  {patientName(c)}
                </Text>
              </View>
              <View
                style={[
                  styles.patientProviderField,
                  useLargeTextOverviewLayout && styles.patientProviderFieldLargeText,
                ]}
                testID="overview-doctor-details"
              >
                <Text style={[styles.infoFieldLabel, rushColor ? { color: rushColor } : undefined]}>
                  Doctor
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: Spacing.xs, marginTop: Spacing.xs }}>
                  <View>
                    <Text style={styles.bodyText}>{c.doctorName || "—"}</Text>
                    {c.providerAccountNumber ? (
                      <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 1 }}>
                        #{c.providerAccountNumber}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
              </>
              ) : null}
              <View
                style={[
                  styles.patientProviderField,
                  styles.practiceProviderField,
                  useLargeTextOverviewLayout && styles.patientProviderFieldLargeText,
                ]}
                testID="overview-practice-contact"
              >
                <Text style={[styles.infoFieldLabel, rushColor ? { color: rushColor } : undefined]}>
                  Practice
                </Text>
                <View style={{ marginTop: 2 }}>
                  <Text style={styles.bodyText}>{practiceName}</Text>
                  {practiceAddressLines.map((line, index) => (
                    <Text key={`${line}-${index}`} style={{ fontSize: 13, color: colors.textSecondary }}>
                      {line}
                    </Text>
                  ))}
                  {practicePhone ? (
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>{practicePhone}</Text>
                  ) : null}
                  {practiceName !== "—" && practiceAddressLines.length === 0 && !practicePhone ? (
                    <Text style={{ fontSize: 12, color: colors.textTertiary }}>No address or phone on file.</Text>
                  ) : null}
                </View>
              </View>
              </View>
            </View>
            {!editing ? <CaseDetailField label="Pan Barcode">
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: Spacing.xs,
                  flexShrink: 1,
                    justifyContent: "space-between",
                }}
              >
                <Text
                  style={[
                    styles.bodyText,
                    { flexShrink: 1 },
                    rushColor ? { color: rushColor } : undefined,
                  ]}
                >
                  {c.casePanBarcode && c.casePanBarcode.trim()
                    ? c.casePanBarcode.trim()
                    : "—"}
                </Text>
                {canEdit ? (
                  <Pressable
                    hitSlop={8}
                    testID="scan-barcode-btn"
                    accessibilityRole="button"
                    accessibilityLabel="Scan pan barcode"
                    style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}
                    onPress={() => {
                      clearAiReaderSession();
                      setAiReaderSession({
                        caseId,
                        caseNumber: c.caseNumber ?? null,
                        patientName:
                          [c.patientFirstName, c.patientLastName]
                            .filter(Boolean)
                            .join(" ") || null,
                        doctorName: c.doctorName ?? null,
                        dueDate: c.dueDate ?? null,
                        labOrgId:
                          c.labOrganizationId ?? c.organizationId ?? null,
                        labName: labName ?? null,
                        gingivialShade: c.gingivialShade ?? null,
                      });
                      router.push("/ai-reader/barcode" as never);
                    }}
                  >
                    <Ionicons
                      name="barcode-outline"
                      size={20}
                      color={colors.tint}
                    />
                  </Pressable>
                ) : null}
              </View>
            </CaseDetailField> : null}
          </View>
      </Card>

      {!editing && <Card testID="overview-rx-notes">
        <View style={[styles.cardHeaderRow, { marginBottom: Spacing.xs }]}>
          <Text style={styles.cardHeading}>Rx Notes</Text>
          {!rxNotesEditing && canEdit ? (
            <Pressable
              style={styles.editBtn}
              onPress={() => {
                setRxNotesValue(c.caseNotes ?? "");
                setRxNotesError(null);
                setRxNotesEditing(true);
              }}
              hitSlop={8}
              testID="overview-rx-edit"
            >
              <Ionicons name="create-outline" size={16} color={colors.tint} />
              <Text style={styles.editBtnText}>Edit</Text>
            </Pressable>
          ) : null}
        </View>
        {(() => {
          const currentText = c.caseNotes ?? "";
          const savedEntries = c.rxNoteEntries ?? [];
          const currentEntries = savedEntries.filter((entry) => entry.caseId === c.id);
          const needsCurrentEntry =
            currentEntries.length === 0 && (currentText.trim() || rxNotesEditing);
          const currentEntryId =
            currentEntries.at(-1)?.id ??
            (needsCurrentEntry ? `legacy-${c.id}` : null);
          const entries = needsCurrentEntry
            ? [
                ...savedEntries,
                {
                  id: `legacy-${c.id}`,
                  caseId: c.id,
                  noteText: currentText,
                  scannedAt: null,
                  provenance: "legacy" as const,
                },
              ]
            : savedEntries;
          return (
            <>
              {entries.length ? (
                <View style={{ gap: Spacing.sm }}>
                  {entries.map((entry) => {
                    const active = entry.id === currentEntryId;
                    const noteText = rxNotesEditing && active
                      ? rxNotesValue
                      : entry.noteText;
                    return (
                      <View
                        key={entry.id}
                        style={{
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: Spacing.sm,
                        }}
                      >
                        <Text
                          style={{
                            width: 82,
                            flexShrink: 0,
                            color: colors.textTertiary,
                            fontSize: 11,
                            lineHeight: 19,
                          }}
                        >
                          {formatRxNoteScanDate(entry.scannedAt)}
                        </Text>
                        {rxNotesEditing && active ? (
                          <TextInput
                            style={[
                              styles.input,
                              {
                                flex: 1,
                                minWidth: 0,
                                minHeight: 90,
                                textAlignVertical: "top",
                              },
                            ]}
                            value={noteText}
                            onChangeText={setRxNotesValue}
                            placeholder="Prescription notes…"
                            placeholderTextColor={colors.textTertiary}
                            multiline
                            editable={!rxNotesSaving}
                            testID="overview-rx-input"
                          />
                        ) : (
                          <Text
                            style={[
                              styles.bodyText,
                              { flex: 1, minWidth: 0, flexWrap: "wrap" },
                            ]}
                          >
                            {noteText || "—"}
                          </Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.bodyText}>—</Text>
              )}
              {rxNotesEditing && rxNotesError ? (
                <Text style={{ color: colors.error, fontSize: 12, marginTop: Spacing.xs }} testID="overview-rx-error">
                  {rxNotesError}
                </Text>
              ) : null}
              {rxNotesEditing && activeScreenActionOwner !== "rx-notes" ? (
                <View style={[styles.editActions, { marginTop: Spacing.sm }]}>
                  <Pressable
                    style={styles.btnSecondary}
                    onPress={cancelRxNotes}
                    disabled={rxNotesSaving}
                    testID="overview-rx-cancel"
                  >
                    <Text style={styles.btnSecondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.btnPrimary,
                      rxNotesSaving && styles.btnDisabled,
                    ]}
                    onPress={() => void saveRxNotes()}
                    disabled={rxNotesSaving}
                    testID="overview-rx-save"
                  >
                    {rxNotesSaving ? (
                      <ActivityIndicator color={colors.textInverse} size="small" />
                    ) : (
                      <Text style={styles.btnPrimaryText}>Save</Text>
                    )}
                  </Pressable>
                </View>
              ) : null}
            </>
          );
        })()}
        {!rxNotesEditing && rxNotesError ? (
          <Text style={{ color: colors.warningStrong, fontSize: 12, marginTop: Spacing.xs }} testID="overview-rx-error">
            {rxNotesError}
          </Text>
        ) : null}
      </Card>}

      <StationHistoryCard
        events={c.events ?? []}
        styles={styles}
        colors={colors}
      />

      {c.remakeOriginal || (c.remakeChildren && c.remakeChildren.length > 0) ? (
        <Card>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: Spacing.xs,
            }}
          >
            <Text style={styles.cardHeading}>Remake</Text>
            {c.remakeOriginal && onEditRemake ? (
              <Pressable
                onPress={onEditRemake}
                hitSlop={8}
                accessibilityLabel="Edit remake reason"
                style={({ pressed }) => ({
                  opacity: pressed ? 0.6 : 1,
                  padding: 4,
                  borderRadius: Radius.sm,
                })}
              >
                <Ionicons
                  name="pencil-outline"
                  size={16}
                  color={colors.textSecondary}
                />
              </Pressable>
            ) : null}
          </View>
          {c.remakeOriginal ? (
            <>
              <FieldRow
                label="Original"
                value={`#${c.remakeOriginal.caseNumber ?? "—"}`}
                styles={styles}
              />
              <FieldRow
                label="Original location"
                value={caseLocationLabel(c.remakeOriginal)}
                styles={styles}
              />
            </>
          ) : null}
          {c.remakeChildren && c.remakeChildren.length > 0 ? (
            <>
              <FieldRow
                label="Remakes"
                value={c.remakeChildren
                  .map((r) => `#${r.caseNumber ?? "—"}`)
                  .join(", ")}
                styles={styles}
              />
              <FieldRow
                label="Remake locations"
                value={c.remakeChildren
                  .map((r) => caseLocationLabel(r))
                  .join(", ")}
                styles={styles}
              />
            </>
          ) : null}
          {c.remakeReason ? (
            <FieldRow label="Reason" value={c.remakeReason} styles={styles} />
          ) : null}
          {c.remakeCharged !== null && c.remakeCharged !== undefined ? (
            <FieldRow
              label="Charge"
              value={c.remakeCharged ? "Charged" : "No charge"}
              styles={styles}
            />
          ) : null}
          {c.remakeNotes && c.remakeNotes.trim() ? (
            <View style={{ marginTop: Spacing.xs }}>
              <Text style={[styles.fieldLabel, { marginBottom: 2 }]}>
                Remake notes
              </Text>
              <Text style={styles.bodyText}>{c.remakeNotes.trim()}</Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      {relatedCases.length > 0 ? (
        <Card padding="none">
          <View style={styles.relatedHeader}>
            <Text style={[styles.cardHeading, styles.cardHeadingFlush]}>
              Related Cases
            </Text>
            <Text style={styles.relatedHint}>Long-press to locate</Text>
          </View>
          {relatedCases.map((rc, idx) => {
            return (
              <React.Fragment key={rc.id}>
                {idx > 0 ? (
                  <View
                    style={[
                      styles.relatedDivider,
                      { backgroundColor: colors.border },
                    ]}
                  />
                ) : null}
                <Pressable
                  onPress={() => {
                    if (consumeRelatedLongPress(rc.id)) return;
                    router.push(`/case/${rc.id}` as never);
                  }}
                  onLongPress={() => {
                    if (!isActiveCaseRecord(rc)) return;
                    markRelatedLongPress(rc.id);
                    Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});
                    setRelatedQuickActionCase(rc);
                  }}
                  delayLongPress={400}
                  style={({ pressed }) =>
                    pressed
                      ? [
                          styles.relatedRow,
                          { backgroundColor: colors.surfaceAlt },
                        ]
                      : styles.relatedRow
                  }
                  testID={`related-case-row-${rc.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${patientName(rc)}${rc.caseNumber ? `, case ${rc.caseNumber}` : ""}`}
                  accessibilityHint={
                    isActiveCaseRecord(rc)
                      ? "Tap to open case details. Long press for quick actions."
                      : "Tap to open case details."
                  }
                >
                  <View style={styles.relatedRowMain}>
                    <Text style={styles.relatedRowName} numberOfLines={1}>
                      {`${rc.patientFirstName ?? ""} ${rc.patientLastName ?? ""}`.trim() ||
                        "Unnamed patient"}
                    </Text>
                    <Text style={styles.relatedRowMeta} numberOfLines={1}>
                      {rc.caseNumber ? `#${rc.caseNumber}` : "No case #"}
                      {rc.doctorName ? `  ·  ${rc.doctorName}` : ""}
                    </Text>
                  </View>
                  <View style={styles.relatedRowRight}>
                    <StatusBadge
                      label={titleCase(rc.status ?? "—")}
                      variant={statusVariant(rc.status)}
                      size="sm"
                    />
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color={colors.textTertiary}
                    />
                  </View>
                </Pressable>
              </React.Fragment>
            );
          })}
        </Card>
      ) : null}

      <CaseQuickActionSheet
        visible={relatedQuickActionCase !== null}
        caseItem={relatedQuickActionCase}
        onDismiss={() => setRelatedQuickActionCase(null)}
      />

      <DatePickerModal
        visible={picker === "receivedAt"}
        title="Date received"
        value={form.receivedAt}
        onSelect={(v) => {
          setForm((f) => ({ ...f, receivedAt: v }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        styles={styles}
        colors={colors}
      />
      <DatePickerModal
        visible={picker === "dueDate"}
        title="Due date"
        allowTyping
        value={form.dueDate}
        onSelect={(v) => {
          setForm((f) => ({ ...f, dueDate: v }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        styles={styles}
        colors={colors}
      />
      <TimePickerModal
        visible={picker === "dueTime"}
        title="Due time"
        value={form.dueTime || null}
        onSelect={(v) => {
          setForm((f) => ({ ...f, dueTime: v }));
          setPicker(null);
        }}
        onClear={() => {
          setForm((f) => ({ ...f, dueTime: "" }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        styles={styles}
      />
      {/* Print-label prompt — shown after assigning a barcode via the edit form */}
      <Modal
        visible={printModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setPrintModalVisible(false);
          setPendingPrintBarcode(null);
        }}
      >
        <View style={styles.labelPrintOverlay}>
          <View
            style={[
              styles.labelPrintSheet,
              { paddingBottom: insets.bottom + Spacing.lg },
            ]}
          >
            <View style={styles.labelPrintHandle} />
            <Ionicons
              name="checkmark-circle"
              size={40}
              color={colors.success}
              style={{ alignSelf: "center" }}
            />
            <Text style={styles.labelPrintTitle}>Barcode assigned!</Text>
            <Text style={styles.labelPrintBody}>
              Print a work-order label for case #{c.caseNumber}?{"\n"}
              This uses your lab's print template and shows the system print
              dialog.
            </Text>
            <Pressable
              style={[styles.labelPrintBtn, printLoading && { opacity: 0.6 }]}
              onPress={printLabel}
              disabled={printLoading}
            >
              {printLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="print-outline" size={18} color="#fff" />
                  <Text style={styles.labelPrintBtnText}>Print label</Text>
                </>
              )}
            </Pressable>
            <Pressable
              style={styles.labelPrintSkipBtn}
              onPress={() => {
                setPrintModalVisible(false);
                setPendingPrintBarcode(null);
              }}
            >
              <Text style={styles.labelPrintSkipText}>Skip</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Step picker — removable workflow step (admin/owner only) */}
      <Modal
        visible={stepPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setStepPickerOpen(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.4)",
            justifyContent: "flex-end",
          }}
          onPress={() => setStepPickerOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: colors.backgroundSolid,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              paddingBottom: insets.bottom + 16,
              maxHeight: "90%",
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : undefined}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
              >
                <View style={{ padding: Spacing.md }}>
                  <Text
                    style={{
                      fontSize: 16,
                      fontWeight: "600",
                      color: colors.text,
                      marginBottom: Spacing.md,
                    }}
                  >
                    Step
                  </Text>
                  <View style={{ gap: 6 }}>
                    {RETURN_STEP_OPTIONS.map((opt) => {
                      const activeOpt = (c.step ?? null) === opt.value;
                      return (
                        <Pressable
                          key={opt.value}
                          testID={`step-option-${opt.value}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Step: ${opt.label}`}
                          accessibilityState={{ selected: activeOpt, disabled: stepSaving }}
                          aria-pressed={activeOpt}
                          disabled={stepSaving}
                          onPress={() => void saveStep(opt.value)}
                          style={{
                            minHeight: 48,
                            justifyContent: "center",
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: activeOpt
                              ? colors.tint
                              : colors.border,
                            backgroundColor: colors.surfaceAlt,
                          }}
                        >
                          <Text
                            style={{
                              color: activeOpt ? colors.tint : colors.text,
                              fontWeight: activeOpt ? "600" : "400",
                            }}
                          >
                            {opt.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {/* Unset the step entirely (desktop's blank "—" option). */}
                    <Pressable
                      testID="step-option-none"
                      accessibilityRole="button"
                      accessibilityLabel="Step: No step"
                      accessibilityState={{ selected: !c.step, disabled: stepSaving }}
                      aria-pressed={!c.step}
                      disabled={stepSaving}
                      onPress={() => void saveStep(null)}
                      style={{
                        minHeight: 48,
                        justifyContent: "center",
                        padding: 12,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: c.step ? colors.border : colors.tint,
                        backgroundColor: colors.surfaceAlt,
                      }}
                    >
                      <Text
                        style={{
                          color: c.step ? colors.textSecondary : colors.tint,
                          fontStyle: "italic",
                        }}
                      >
                        No step
                      </Text>
                    </Pressable>
                  </View>
                  <Pressable
                    testID="step-picker-cancel"
                    accessibilityRole="button"
                    onPress={() => setStepPickerOpen(false)}
                    style={{
                      minHeight: 48,
                      justifyContent: "center",
                      marginTop: Spacing.md,
                      padding: 12,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: colors.border,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: colors.text }}>Cancel</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Case Hierarchy (Type / Sub Type / Material) edit modal */}
      <Modal
        visible={hierarchyEditOpen}
        transparent
        animationType="slide"
        onRequestClose={() => !hierarchySaving && setHierarchyEditOpen(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.4)",
            justifyContent: "flex-end",
          }}
          onPress={() => {
            if (!hierarchySaving) setHierarchyEditOpen(false);
          }}
        >
          <Pressable
            style={{
              backgroundColor: colors.backgroundSolid,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              paddingBottom: insets.bottom + 16,
              maxHeight: "90%",
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : undefined}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
              >
                <View style={{ padding: Spacing.md }}>
                  <Text
                    style={{
                      fontSize: 16,
                      fontWeight: "600",
                      color: colors.text,
                      marginBottom: Spacing.md,
                    }}
                  >
                    Edit Restoration Details
                  </Text>

                  {hierarchyEditOpen ? <CaseHierarchyDialogFields
                    type={draftCt} subtype={draftSt} material={draftMat} arch={draftArch}
                    catalog={hierarchyCatalogQuery.data?.data} disabled={hierarchySaving}
                    savedValues={{
                      restorationType: draftCt === firstHierarchy?.caseType &&
                        draftSt === (firstHierarchy?.subtype ?? (firstHierarchy?.customSubtypeId ? `custom:${firstHierarchy.customSubtypeId}` : null))
                        ? firstRestoration?.restorationType : null,
                      material: draftMat === (firstHierarchy?.materialSubtype ?? (firstHierarchy?.customMaterialSubtypeId ? `custom:${firstHierarchy.customMaterialSubtypeId}` : null))
                        ? firstRestoration?.material : null,
                    }}
                    onType={(ct) => { setDraftCt(ct); setDraftSt(null); setDraftMat(null); }}
                    onSubtype={(st) => { setDraftSt(st); setDraftMat(null); }}
                    onMaterial={setDraftMat}
                    onArch={setDraftArch}
                  /> : null}

                  {hierarchyError ? (
                    <Text
                      style={{
                        color: colors.error,
                        fontSize: 13,
                        marginBottom: Spacing.sm,
                      }}
                    >
                      {hierarchyError}
                    </Text>
                  ) : null}

                  <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
                    <Pressable
                      testID="hierarchy-cancel-btn"
                      accessibilityRole="button"
                      onPress={() => setHierarchyEditOpen(false)}
                      disabled={hierarchySaving}
                      style={{
                        minHeight: 48,
                        justifyContent: "center",
                        flex: 1,
                        padding: 12,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: colors.border,
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ color: colors.text }}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void saveHierarchy();
                      }}
                      disabled={hierarchySaving || !draftCt}
                      style={{
                        minHeight: 48,
                        justifyContent: "center",
                        flex: 1,
                        padding: 12,
                        borderRadius: 8,
                        backgroundColor: colors.tint,
                        alignItems: "center",
                        opacity: hierarchySaving || !draftCt ? 0.6 : 1,
                      }}
                      testID="hierarchy-save-btn"
                    >
                      {hierarchySaving ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={{ color: "#fff", fontWeight: "600" }}>
                          Save
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Exception case — create (any lab member) / review + resolve (owner-admin). */}
      <CaseExceptionCreateSheet
        visible={exceptionCreateOpen}
        caseId={caseId}
        labOrganizationId={
          c.labOrganizationId ?? c.organizationId ?? labOrganizationId
        }
        onClose={() => setExceptionCreateOpen(false)}
      />
      {activeException ? (
        <CaseExceptionDetailSheet
          visible={exceptionDetailOpen}
          caseId={caseId}
          exceptionId={activeException.id}
          labOrganizationId={
            c.labOrganizationId ?? c.organizationId ?? labOrganizationId
          }
          onClose={() => setExceptionDetailOpen(false)}
        />
      ) : null}

      {/* The persisted open case owns this action, never an unsaved form. */}
      {isAdmin && c.providerOrganizationId && (c.labOrganizationId ?? c.organizationId) &&
        !editing ? (
        <DoctorReassignSheet
          visible={reassignOpen}
          caseId={caseId}
          caseNumber={c.caseNumber ?? caseId}
          currentDoctorName={c.doctorName ?? ""}
          currentPracticeId={c.providerOrganizationId}
          onClose={() => setReassignOpen(false)}
        />
      ) : null}

      {/* Prescription preview */}
      <Modal
        visible={rxPreviewOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setRxPreviewOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: colors.backgroundSolid,
            paddingTop: insets.top,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: Spacing.md,
              paddingVertical: Spacing.sm,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.border,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: Spacing.xs,
              }}
            >
              <Ionicons
                name="document-text-outline"
                size={18}
                color={colors.tint}
              />
              <Text
                style={{ fontSize: 16, fontWeight: "600", color: colors.text }}
              >
                Prescription Preview
              </Text>
            </View>
            <Pressable hitSlop={8} onPress={() => setRxPreviewOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: Spacing.md, gap: Spacing.md }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            <View
              style={{
                backgroundColor: colors.surface,
                borderRadius: Radius.md,
                padding: Spacing.md,
                gap: Spacing.sm,
                marginBottom: Spacing.md,
              }}
            >
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Patient</Text>
                <Text style={styles.fieldValue}>{patientName(c)}</Text>
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Doctor</Text>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.fieldValue}>{c.doctorName || "—"}</Text>
                  {c.providerAccountNumber ? (
                    <Text
                      style={{
                        fontSize: 10,
                        color: colors.textSecondary,
                        marginTop: 1,
                      }}
                    >
                      #{c.providerAccountNumber}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Case #</Text>
                {isAdmin && caseNumberEditing ? (
                  <KeyboardAvoidingView
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <TextInput
                        style={[
                          styles.input,
                          { width: 100, textAlign: "right" },
                        ]}
                        value={caseNumberValue}
                        onChangeText={(t) => {
                          setCaseNumberValue(t);
                          setCaseNumberError(null);
                        }}
                        autoFocus
                        autoCapitalize="none"
                        returnKeyType="done"
                        onSubmitEditing={() => {
                          void saveCaseNumber();
                        }}
                        editable={!caseNumberSaving}
                        placeholderTextColor={colors.textTertiary}
                      />
                      <Pressable
                        onPress={() => {
                          void saveCaseNumber();
                        }}
                        disabled={caseNumberSaving}
                        style={{ padding: 4 }}
                        accessibilityLabel="Save case number"
                      >
                        {caseNumberSaving ? (
                          <ActivityIndicator size="small" color={colors.tint} />
                        ) : (
                          <Ionicons
                            name="checkmark"
                            size={18}
                            color={colors.tint}
                          />
                        )}
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setCaseNumberEditing(false);
                          setCaseNumberError(null);
                        }}
                        disabled={caseNumberSaving}
                        style={{ padding: 4 }}
                        accessibilityLabel="Cancel"
                      >
                        <Ionicons
                          name="close"
                          size={18}
                          color={colors.textSecondary}
                        />
                      </Pressable>
                    </View>
                    {caseNumberError ? (
                      <Text
                        style={{
                          fontSize: 11,
                          color: colors.error,
                          textAlign: "right",
                          marginTop: 2,
                        }}
                      >
                        {caseNumberError}
                      </Text>
                    ) : null}
                  </KeyboardAvoidingView>
                ) : (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <Text style={styles.fieldValue}>{c.caseNumber || "—"}</Text>
                    {isAdmin && (
                      <Pressable
                        onPress={() => {
                          setCaseNumberValue(c.caseNumber ?? "");
                          setCaseNumberError(null);
                          setCaseNumberEditing(true);
                        }}
                        style={{ padding: 2 }}
                        accessibilityLabel="Edit case number"
                      >
                        <Ionicons
                          name="pencil-outline"
                          size={14}
                          color={colors.textTertiary}
                        />
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
              {(c.restorations ?? []).length > 0 &&
                (() => {
                  const rests = c.restorations ?? [];
                  const types = [
                    ...new Set(
                      rests
                        .map((r) => r.restorationType)
                        .filter((v): v is string => !!v),
                    ),
                  ];
                  const materials = [
                    ...new Set(
                      rests
                        .map((r) => r.material)
                        .filter((v): v is string => !!v),
                    ),
                  ];
                  const shades = [
                    ...new Set(
                      rests.map((r) => r.shade).filter((v): v is string => !!v),
                    ),
                  ];
                  return (
                    <>
                      {types.length > 0 ? (
                        <View style={styles.fieldRow}>
                          <Text style={styles.fieldLabel}>Type</Text>
                          <Text style={styles.fieldValue}>
                            {types.join(", ")}
                          </Text>
                        </View>
                      ) : null}
                      {materials.length > 0 ? (
                        <View style={styles.fieldRow}>
                          <Text style={styles.fieldLabel}>Material</Text>
                          <Text style={styles.fieldValue}>
                            {materials.join(", ")}
                          </Text>
                        </View>
                      ) : null}
                      {shades.length > 0 ? (
                        <View style={styles.fieldRow}>
                          <Text style={styles.fieldLabel}>Shade</Text>
                          <Text style={styles.fieldValue}>
                            {shades.join(", ")}
                          </Text>
                        </View>
                      ) : null}
                    </>
                  );
                })()}
            </View>
            {(c.restorations ?? []).length > 0 && (
              <View
                style={{
                  backgroundColor: colors.surface,
                  borderRadius: Radius.md,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    backgroundColor: colors.surfaceAlt,
                    paddingHorizontal: Spacing.sm,
                    paddingVertical: Spacing.xs,
                  }}
                >
                  {["Tooth", "Type", "Material", "Shade"].map((h) => (
                    <Text
                      key={h}
                      style={{
                        flex: 1,
                        fontSize: 10,
                        fontWeight: "600",
                        color: colors.textSecondary,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      {h}
                    </Text>
                  ))}
                </View>
                {(c.restorations ?? []).map((r, idx) => (
                  <View
                    key={r.id ?? String(idx)}
                    style={{
                      flexDirection: "row",
                      paddingHorizontal: Spacing.sm,
                      paddingVertical: Spacing.xs,
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                    }}
                  >
                    <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
                      {r.toothNumber || "—"}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
                      {r.restorationType || "—"}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
                      {r.material || "—"}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
                      {r.shade || "—"}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function CustomShadeMetadata({
  c,
  canEdit,
  saving,
  techValue,
  onTechChange,
  onTechCommit,
  onToggle,
  styles,
  colors,
}: {
  c: DetailedCase;
  canEdit: boolean;
  saving: boolean;
  techValue: string;
  onTechChange: (value: string) => void;
  onTechCommit: () => void;
  onToggle: (body: Record<string, unknown>) => Promise<void>;
  styles: Styles;
  colors: ThemeColors;
}) {
  const checkbox = (checked: boolean) => (
    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
      {checked ? (
        <Ionicons name="checkmark" size={15} color={colors.textInverse} />
      ) : null}
    </View>
  );
  return (
    <View style={{ width: "100%", minWidth: 0, gap: Spacing.sm }}>
      <Pressable
        style={{ flexDirection: "row", alignItems: "center", gap: Spacing.sm, minHeight: 44 }}
        onPress={() => {
          if (!canEdit || saving) return;
          const next = !c.isCustomShade;
          void onToggle({
            isCustomShade: next,
            ...(next
              ? {}
              : {
                  customShadeTechnician: null,
                  customShadePicturesAvailable: false,
                  customShadeVideoAvailable: false,
                }),
          });
        }}
        disabled={!canEdit || saving}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: !!c.isCustomShade, disabled: !canEdit || saving }}
        aria-checked={!!c.isCustomShade}
        accessibilityLabel="Custom Shade"
        testID="custom-shade-toggle"
      >
        {checkbox(!!c.isCustomShade)}
        <Text style={[caseDetailFieldStyles.heading, { color: colors.text, flexShrink: 1 }]}>Custom Shade</Text>
        {saving ? <ActivityIndicator size="small" color={colors.textTertiary} /> : null}
      </Pressable>
      {c.isCustomShade ? (
        <View style={{ paddingLeft: Spacing.md, gap: Spacing.sm, borderLeftWidth: 2, borderLeftColor: colors.border }}>
          <View style={{ gap: 4 }}>
            <Text style={[caseDetailFieldStyles.heading, { color: colors.text }]}>
              Technician name
            </Text>
            {canEdit ? (
              <TextInput
                style={[styles.input, caseDetailFieldStyles.input]}
                value={techValue}
                onChangeText={onTechChange}
                onBlur={onTechCommit}
                onSubmitEditing={onTechCommit}
                placeholder="Enter technician name"
                placeholderTextColor={colors.textTertiary}
                editable={!saving}
                returnKeyType="done"
                testID="custom-shade-technician-input"
                accessibilityLabel="Custom shade technician name"
              />
            ) : (
              <Text style={styles.bodyText}>{c.customShadeTechnician?.trim() || "—"}</Text>
            )}
          </View>
          {(["pictures", "video"] as const).map((kind) => {
            const isPictures = kind === "pictures";
            const field = isPictures
              ? "customShadePicturesAvailable"
              : "customShadeVideoAvailable";
            const checked = !!c[field];
            return (
              <Pressable
                key={kind}
                style={{ flexDirection: "row", alignItems: "center", gap: Spacing.sm, minHeight: 44 }}
                onPress={() => {
                  if (canEdit && !saving) void onToggle({ [field]: !checked });
                }}
                disabled={!canEdit || saving}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: !canEdit || saving }}
                aria-checked={checked}
                accessibilityLabel={isPictures ? "Pictures available" : "Video available"}
                testID={`custom-shade-${kind}-toggle`}
              >
                {checkbox(checked)}
                <Text style={[styles.checkboxLabel, { flexShrink: 1 }]}>
                  {isPictures ? "Pictures available" : "Video available"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// ─── Station History Card ──────────────────────────────────────────────────────
// Collapsible card shown in the Overview section. Filters for status_changed
// events and renders them as a compact station trail (newest first).
function StationHistoryCard({
  events,
  styles,
  colors,
}: {
  events: DetailEvent[];
  styles: Styles;
  colors: ThemeColors;
}) {
  const [expanded, setExpanded] = useState(false);

  const stationEvents = useMemo(() => {
    return events
      .filter((ev) => ev.eventType === "status_changed")
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.occurredAt ?? a.createdAt ?? 0).getTime();
        const tb = new Date(b.occurredAt ?? b.createdAt ?? 0).getTime();
        return tb - ta;
      });
  }, [events]);

  if (stationEvents.length === 0) return null;

  return (
    <Card padding="none">
      <Pressable
        style={styles.stationHistHeader}
        onPress={() => setExpanded((v) => !v)}
        testID="station-history-toggle"
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? "Collapse station history" : "Expand station history"
        }
      >
        <Ionicons name="location-outline" size={16} color={colors.tint} />
        <Text style={styles.stationHistTitle}>Station history</Text>
        <View style={styles.stationHistBadge}>
          <Text style={styles.stationHistBadgeText}>
            {stationEvents.length}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={colors.textTertiary}
        />
      </Pressable>

      {expanded
        ? stationEvents.map((ev, i) => {
            const meta =
              ev.metadataJson && typeof ev.metadataJson === "object"
                ? (ev.metadataJson as Record<string, unknown>)
                : null;
            const toStatus =
              typeof meta?.toStatus === "string"
                ? meta.toStatus
                : typeof meta?.newStatus === "string"
                  ? meta.newStatus
                  : typeof meta?.status === "string"
                    ? meta.status
                    : null;
            const stationName = labelFor(STATUS_OPTIONS, toStatus);
            const actor = ev.actorName || ev.actorInitials;
            return (
              <View
                key={ev.id}
                style={[styles.stationHistRow, i > 0 && styles.eventDivider]}
                testID={`station-history-row-${i}`}
              >
                <View style={styles.stationHistDot} />
                <View style={styles.eventBody}>
                  <Text style={styles.eventTitle}>{stationName}</Text>
                  <Text style={styles.eventMeta}>
                    {actor ? `${actor} · ` : ""}
                    {formatDateTime(ev.occurredAt ?? ev.createdAt)}
                  </Text>
                </View>
              </View>
            );
          })
        : null}
    </Card>
  );
}

function RestorationsSection({
  restorations,
  bridgeConnectors,
  highlighted,
  teethLabel,
  caseId,
  labOrganizationId,
  canEdit,
  isAdmin,
  onSaved,
  styles,
  colors,
}: {
  restorations: DetailRestoration[];
  bridgeConnectors?: string | null;
  highlighted: Set<string>;
  teethLabel: string;
  caseId: string;
  labOrganizationId?: string | null;
  canEdit: boolean;
  isAdmin: boolean;
  onSaved: () => void | Promise<unknown>;
  styles: Styles;
  colors: ThemeColors;
}) {
  const addRestoration = useAddCaseRestoration();
  const deleteRestoration = useDeleteCaseRestoration();
  const updateRestoration = useUpdateCaseRestoration();
  const updateCase = useUpdateCase();
  const qc = useQueryClient();
  const [activeTooth, setActiveTooth] = useState<string | null>(null);
  const [connectedPairs, setConnectedPairs] = useState<Set<string>>(
    () => parseConnectorState(bridgeConnectors).active,
  );
  const [connectorError, setConnectorError] = useState<string | null>(null);
  useEffect(() => {
    setConnectedPairs(parseConnectorState(bridgeConnectors).active);
  }, [bridgeConnectors]);
  const connectorState = useMemo(
    () => parseConnectorState(bridgeConnectors),
    [bridgeConnectors],
  );
  const connectorUnits = useMemo(
    () => restorations
      .filter((restoration) => restoration.restorationType !== "missing")
      .filter((restoration) => !!restoration.toothNumber?.trim())
      .map((restoration) => ({
        toothNumber: restoration.toothNumber!,
        restorationType: restoration.restorationType ?? "",
        material: restoration.material,
        restorationSubtype: restoration.restorationSubtype,
        arch: restoration.arch,
        quantity: restoration.quantity,
      })),
    [restorations],
  );
  const connectorSuggestions = useMemo(
    () => suggestPonticConnectorPairs(connectorUnits),
    [connectorUnits],
  );
  const effectiveConnectedPairs = connectedPairs;
  const assignmentSummary = toothAssignmentSummary(connectorUnits, bridgeConnectors);
  const assignmentSummaryText = `${[...toothBridgeLabels(connectorUnits, bridgeConnectors), ""].join(" · ")}${assignmentSummary.units} units${assignmentSummary.veneers ? ` (${assignmentSummary.veneers} veneer${assignmentSummary.veneers === 1 ? "" : "s"})` : ""} · ${assignmentSummary.groups.length} connected groups · ${assignmentSummary.materials.map(({ material, count }) => `${material}: ${count}`).join(", ")} · ${updateCase.isPending || addRestoration.isPending || updateRestoration.isPending || deleteRestoration.isPending ? "Saving assignments…" : "Saved automatically"}`;
  const connectorValidation = useMemo(() => validateToothConnectors(bridgeConnectors, connectorUnits), [bridgeConnectors, connectorUnits]);
  const saveConnectorPairs = useCallback(async (nextPairs: Set<string>) => {
    if (updateCase.isPending) return;
    const nextState = {
      active: new Set(nextPairs),
      explicitOn: new Set(connectorState.explicitOn),
      explicitOff: new Set(connectorState.explicitOff),
      suggested: new Set(connectorState.suggested),
    };
    for (const pair of new Set([...effectiveConnectedPairs, ...nextPairs])) {
      if (effectiveConnectedPairs.has(pair) === nextPairs.has(pair)) continue;
      if (nextPairs.has(pair)) {
        nextState.explicitOn.add(pair);
        nextState.explicitOff.delete(pair);
        nextState.suggested.delete(pair);
      } else {
        nextState.explicitOn.delete(pair);
        nextState.suggested.delete(pair);
        nextState.explicitOff.add(pair);
      }
    }
    const encoded = serializeConnectorState(nextState);
    const validation = validateToothConnectors(encoded, connectorUnits);
    const previousErrors = new Set(connectorValidation.errors);
    const newErrors = validation.errors.filter((error) => !previousErrors.has(error));
    if (newErrors.length) {
      setConnectorError(newErrors.join(" "));
      return;
    }
    const previous = connectedPairs;
    setConnectedPairs(nextPairs);
    setConnectorError(null);
    try {
      await updateCase.mutateAsync({
        caseId,
        data: { bridgeConnectors: encoded },
      });
      await Promise.allSettled([
        Promise.resolve().then(onSaved),
        qc.invalidateQueries({ queryKey: ["invoices"] }),
        qc.invalidateQueries({ queryKey: ["invoice-for-case", caseId] }),
        qc.invalidateQueries({ queryKey: ["invoice-detail"] }),
      ]);
    } catch (e) {
      setConnectedPairs(previous);
      setConnectorError(errorMessage(e));
    }
  }, [
    caseId,
    connectorState,
    connectorSuggestions,
    connectedPairs,
    effectiveConnectedPairs,
    onSaved,
    qc,
    connectorUnits,
    updateCase,
  ]);
  const refreshAfterFinancialMutation = useCallback(async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(onSaved),
      qc.invalidateQueries({ queryKey: ["invoices"] }),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      Alert.alert("Saved", "Your change was saved, but some totals could not refresh. Refresh the case; do not repeat the save.");
    }
  }, [onSaved, qc]);

  // ── Inline restoration-type edit ──────────────────────────────────────────
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null);
  const [editTypeValue, setEditTypeValue] = useState("");
  const [editTypeSaving, setEditTypeSaving] = useState(false);
  const [editTypeError, setEditTypeError] = useState<string | null>(null);

  function beginEditType(r: DetailRestoration) {
    setEditingTypeId(r.id ?? null);
    setEditTypeValue(r.restorationType ?? "");
    setEditTypeError(null);
  }

  async function saveEditType(restorationId: string) {
    const trimmed = editTypeValue.trim();
    if (!trimmed) {
      setEditTypeError("Restoration type is required.");
      return;
    }
    setEditTypeSaving(true);
    setEditTypeError(null);
    try {
      const subtypeKey = subtypeKeyForTypeLabel(trimmed);
      await updateRestoration.mutateAsync({
        caseId,
        restorationId,
        data: {
          restorationType: trimmed,
          ...(subtypeKey !== null ? { restorationSubtype: subtypeKey } : {}),
        },
      });
      setEditingTypeId(null);
      // A restoration-type change implicitly changes the derived case type,
      // so invalidate the list cache too — not just the detail refetch below.
      await qc.invalidateQueries({ queryKey: ["cases"] });
      await refreshAfterFinancialMutation();
    } catch (e) {
      setEditTypeError(errorMessage(e));
    } finally {
      setEditTypeSaving(false);
    }
  }

  // ── Inline material edit ──────────────────────────────────────────────────
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(
    null,
  );
  const [editMaterialValue, setEditMaterialValue] = useState("");
  const [editMaterialSaving, setEditMaterialSaving] = useState(false);
  const [editMaterialError, setEditMaterialError] = useState<string | null>(
    null,
  );

  function beginEditMaterial(r: DetailRestoration) {
    setEditingMaterialId(r.id ?? null);
    setEditMaterialValue(r.material ?? "");
    setEditMaterialError(null);
  }

  async function saveEditMaterial(restorationId: string) {
    setEditMaterialSaving(true);
    setEditMaterialError(null);
    try {
      await updateRestoration.mutateAsync({
        caseId,
        restorationId,
        data: (() => {
          const typed = editMaterialValue.trim();
          // A punctuation-only difference from a catalog material names the
          // same thing ("emax" typed for "E.max"), so it keeps that material's
          // subtype instead of being treated as a brand-new free-text value.
          const catalogMatch = catalogMaterials.find(
            (entry) =>
              entry.isCustom &&
              normalizeItemName(entry.label) === normalizeItemName(typed),
          );
          return {
            material: typed,
            ...(catalogMatch?.restorationSubtype
              ? { restorationSubtype: catalogMatch.restorationSubtype }
              : {}),
          };
        })(),
      });
      setEditingMaterialId(null);
      await refreshAfterFinancialMutation();
    } catch (e) {
      setEditMaterialError(errorMessage(e));
    } finally {
      setEditMaterialSaving(false);
    }
  }

  // ── Inline shade edit ─────────────────────────────────────────────────────
  const [editingShadeId, setEditingShadeId] = useState<string | null>(null);
  const [editShadeValue, setEditShadeValue] = useState("");
  const [editShadeSaving, setEditShadeSaving] = useState(false);
  const [editShadeError, setEditShadeError] = useState<string | null>(null);

  function beginEditShade(r: DetailRestoration) {
    setEditingShadeId(r.id ?? null);
    setEditShadeValue(r.shade ?? "");
    setEditShadeError(null);
  }

  async function saveEditShade(restorationId: string) {
    setEditShadeSaving(true);
    setEditShadeError(null);
    try {
      await updateRestoration.mutateAsync({
        caseId,
        restorationId,
        data: { shade: editShadeValue.trim() },
      });
      setEditingShadeId(null);
      await refreshAfterFinancialMutation();
    } catch (e) {
      setEditShadeError(errorMessage(e));
    } finally {
      setEditShadeSaving(false);
    }
  }
  // ── Inline "set price in fee schedule" (Task #2084) ──────────────────────
  // Admin-only control on any unpriced ($0) restoration card. Writes the price
  // into the tier/override the case resolves to, then re-prices the line +
  // invoice. The alloy line is excluded — it has its own banner affordance.
  const [feeScheduleInputs, setFeeScheduleInputs] = useState<
    Record<string, string>
  >({});
  const [savingFeeScheduleId, setSavingFeeScheduleId] = useState<string | null>(
    null,
  );
  const setFeeSchedulePrice = useCallback(
    async (restorationId: string) => {
      const parsed = Number(feeScheduleInputs[restorationId] ?? "");
      if (!Number.isFinite(parsed) || parsed <= 0) {
        Alert.alert("Enter a price", "Please enter a price above $0.");
        return;
      }
      setSavingFeeScheduleId(restorationId);
      try {
        const res = await resilientFetch(
          `/api/cases/${caseId}/restorations/${restorationId}/fee-schedule-price`,
          { method: "POST", body: JSON.stringify({ price: parsed }) },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
            message?: string;
          } | null;
          throw new Error(
            body?.error?.message ?? body?.message ?? "Request failed",
          );
        }
        const body = (await res.json().catch(() => null)) as {
          data?: { target?: { kind?: string; name?: string } };
        } | null;
        const target = body?.data?.target;
        setFeeScheduleInputs((prev) => {
          const next = { ...prev };
          delete next[restorationId];
          return next;
        });
        await refreshAfterFinancialMutation();
        if (target?.name) {
          Alert.alert(
            "Price set",
            `Saved to ${target.kind === "tier" ? "tier" : "override"} “${target.name}”.`,
          );
        }
      } catch (e) {
        Alert.alert("Couldn't set the price", errorMessage(e));
      } finally {
        setSavingFeeScheduleId(null);
      }
    },
    [feeScheduleInputs, caseId, refreshAfterFinancialMutation],
  );
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [assignmentBatchBusy, setAssignmentBatchBusy] = useState(false);

  // ── Removable restoration form ────────────────────────────────────────────
  // Removable appliance types (denture, partial, flipper, flexible/Valplast)
  // have no specific tooth. The tooth chart + ToothActionSheet can't add them,
  // so we offer a separate inline form that submits with an empty toothNumber.
  const [showRemovableForm, setShowRemovableForm] = useState(false);
  const [removableForm, setRemovableForm] = useState({
    restorationType: "",
    restorationSubtype: undefined as string | undefined,
    material: "",
    shade: "",
    quantity: "1",
  });
  const [removableError, setRemovableError] = useState<string | null>(null);

  async function handleAddRemovable() {
    setRemovableError(null);
    const typeVal = removableForm.restorationType.trim();
    if (!typeVal) {
      setRemovableError("Restoration type is required.");
      return;
    }
    if (!isRemovableRestorationType(typeVal)) {
      setRemovableError(
        "Use this form only for removable types (denture, partial, flipper, flexible / Valplast). Use the tooth chart above for crown & bridge.",
      );
      return;
    }
    const qty = Math.max(1, parseInt(removableForm.quantity, 10) || 1);
    try {
      await addRestoration.mutateAsync({
        caseId,
        data: {
          toothNumber: "",
          restorationType: typeVal,
          ...(removableForm.restorationSubtype
            ? { restorationSubtype: removableForm.restorationSubtype }
            : {}),
          ...(removableForm.material.trim()
            ? { material: removableForm.material.trim() }
            : {}),
          ...(removableForm.shade.trim()
            ? { shade: removableForm.shade.trim() }
            : {}),
          quantity: qty,
        },
      });
      setShowRemovableForm(false);
      setRemovableForm({
        restorationType: "",
        restorationSubtype: undefined,
        material: "",
        shade: "",
        quantity: "1",
      });
      await refreshAfterFinancialMutation();
    } catch (e) {
      setRemovableError(errorMessage(e));
    }
  }

  // Vocabulary: fetch lab-specific materials and shades for the ToothActionSheet.
  const labOrgIdForVocab = labOrganizationId ?? null;

  // Lab's effective catalog tree (built-ins + custom subtypes, disabled
  // entries excluded) for the restoration-type pickers. Falls back to the
  // static taxonomy while loading — identical for an uncustomized lab.
  const catalogTreeQuery = useGetCatalogTree(
    { labOrganizationId: labOrgIdForVocab ?? "", includeInactive: "false" },
    {
      query: {
        queryKey: getGetCatalogTreeQueryKey({
          labOrganizationId: labOrgIdForVocab ?? "",
          includeInactive: "false",
        }),
        enabled: !!labOrgIdForVocab,
        staleTime: 120_000,
      },
    },
  );
  const catalogSubtypeOptions = useMemo(() => {
    const caseTypes = catalogTreeQuery.data?.data?.caseTypes;
    if (!caseTypes) return null;
    const opts: Array<{
      caseType: string;
      label: string;
      encoded: string | null;
    }> = [];
    for (const ctNode of caseTypes) {
      for (const s of ctNode.subtypes) {
        const customId = s.isCustom ? parseCustomToken(s.key) : null;
        opts.push({
          caseType: ctNode.key,
          label: s.label,
          encoded: encodeRestorationSubtype({
            caseType: ctNode.key as CaseType,
            subtype: s.isCustom ? null : (s.key as CaseSubtype),
            materialSubtype: null,
            ...(customId ? { customSubtypeId: customId } : {}),
          }),
        });
      }
    }
    return opts;
  }, [catalogTreeQuery.data]);
  const catalogMaterials = useMemo(
    () =>
      (catalogTreeQuery.data?.data?.caseTypes ?? [])
        .filter((ct) => ct.key === "restorative")
        .flatMap((ct) =>
          ct.subtypes.flatMap((s) =>
            s.materials.map((m) => ({
              label: m.label,
              isCustom: s.isCustom || m.isCustom,
              restorationSubtype:
                encodeRestorationSubtype({
                  caseType: ct.key as CaseType,
                  subtype: s.isCustom ? null : (s.key as CaseSubtype),
                  materialSubtype: m.isCustom
                    ? null
                    : (m.key as MaterialSubtype),
                  ...(s.isCustom
                    ? { customSubtypeId: parseCustomToken(s.key) ?? undefined }
                    : {}),
                  ...(m.isCustom
                    ? {
                        customMaterialSubtypeId:
                          parseCustomToken(m.key) ?? undefined,
                      }
                    : {}),
                }) ?? "",
            })),
          ),
        )
        .filter((entry) => entry.restorationSubtype.length > 0),
    [catalogTreeQuery.data],
  );
  const catalogToothTypes = useMemo(
    () =>
      (catalogTreeQuery.data?.data?.caseTypes ?? [])
        .filter((ct) => ct.key === "restorative")
        .flatMap((ct) =>
          ct.subtypes
            .filter((s) => s.isCustom)
            .map((s) => ({
              label: s.label,
              restorationSubtype:
                encodeRestorationSubtype({
                  caseType: ct.key as CaseType,
                  subtype: null,
                  materialSubtype: null,
                  ...(parseCustomToken(s.key)
                    ? { customSubtypeId: parseCustomToken(s.key)! }
                    : {}),
                }) ?? "",
              materials: s.materials.map((m) => ({
                label: m.label,
                restorationSubtype:
                  encodeRestorationSubtype({
                    caseType: ct.key as CaseType,
                    subtype: null,
                    materialSubtype: m.isCustom
                      ? null
                      : (m.key as MaterialSubtype),
                    ...(parseCustomToken(s.key)
                      ? { customSubtypeId: parseCustomToken(s.key)! }
                      : {}),
                    ...(m.isCustom && parseCustomToken(m.key)
                      ? { customMaterialSubtypeId: parseCustomToken(m.key)! }
                      : {}),
                  }) ?? "",
              })),
            })),
        )
        .filter((entry) => entry.restorationSubtype.length > 0),
    [catalogTreeQuery.data],
  );
  const removableTypeSuggestions = useMemo(
    () =>
      catalogSubtypeOptions
        ? [
            ...new Set(
              catalogSubtypeOptions
                .filter((o) => o.caseType === "removable")
                .map((o) => o.label),
            ),
          ]
        : _REMOVABLE_SUGGESTIONS,
    [catalogSubtypeOptions],
  );
  const allTypeSuggestions = useMemo(
    () =>
      catalogSubtypeOptions
        ? [...new Set(catalogSubtypeOptions.map((o) => o.label))]
        : _ALL_TYPE_SUGGESTIONS,
    [catalogSubtypeOptions],
  );
  /** Encoded restorationSubtype for a picked type label (catalog-aware, static fallback). */
  function subtypeKeyForTypeLabel(label: string): string | null {
    if (catalogSubtypeOptions) {
      return (
        catalogSubtypeOptions.find((o) => o.label === label)?.encoded ?? null
      );
    }
    return _subtypeKeyForType(label);
  }
  function removableSubtypeKeyForLabel(label: string): string | null {
    if (catalogSubtypeOptions) {
      return (
        catalogSubtypeOptions.find(
          (o) => o.caseType === "removable" && o.label === label,
        )?.encoded ?? null
      );
    }
    return _removableSubtypeKey(label);
  }
  type VocabItem = { id: string; value: string; isDefault: boolean };
  const materialVocabQuery = useQuery({
    queryKey: ["vocabulary", "material", labOrgIdForVocab],
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/vocabulary?kind=material&labOrganizationId=${encodeURIComponent(labOrgIdForVocab!)}`,
      );
      const body = (await res.json()) as { data: VocabItem[] };
      return body.data ?? [];
    },
    enabled: !!labOrgIdForVocab,
    staleTime: 120_000,
  });
  const shadeVocabQuery = useQuery({
    queryKey: ["vocabulary", "shade", labOrgIdForVocab],
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/vocabulary?kind=shade&labOrganizationId=${encodeURIComponent(labOrgIdForVocab!)}`,
      );
      const body = (await res.json()) as { data: VocabItem[] };
      return body.data ?? [];
    },
    enabled: !!labOrgIdForVocab,
    staleTime: 120_000,
  });
  const vocabMaterials = (materialVocabQuery.data ?? []).map((v) => v.value);
  const vocabShades = (shadeVocabQuery.data ?? []).map((v) => v.value);
  const crownTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of restorations) {
      if (!r.toothNumber) continue;
      if (!/^crown$/i.test(r.restorationType ?? "")) continue;
      const ids = parseToothField(r.toothNumber);
      if (ids.size === 1) set.add([...ids][0]);
    }
    return set;
  }, [restorations]);

  // Display only: explicit single-tooth Veneer rows.
  const veneerTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of restorations) {
      if (!r.toothNumber || !/^veneer$/i.test(r.restorationType ?? "")) continue;
      const ids = parseToothField(r.toothNumber);
      if (ids.size === 1) set.add([...ids][0]);
    }
    return set;
  }, [restorations]);

  const ponticTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of restorations) {
      if (!r.toothNumber) continue;
      if (!/pontic/i.test(r.restorationType ?? "")) continue;
      const ids = parseToothField(r.toothNumber);
      if (ids.size === 1) set.add([...ids][0]);
    }
    return set;
  }, [restorations]);

  const missingTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of restorations) {
      if (!r.toothNumber) continue;
      if (!/missing/i.test(r.restorationType ?? "")) continue;
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    return set;
  }, [restorations]);

  const billedTeeth = useMemo(() => {
    const set = new Set<string>();
    for (const r of restorations) {
      if (!r.toothNumber || /missing/i.test(r.restorationType ?? "")) continue;
      for (const id of parseToothField(r.toothNumber)) set.add(id);
    }
    return set;
  }, [restorations]);

  const hasTypedTeeth =
    crownTeeth.size > 0 || ponticTeeth.size > 0 || missingTeeth.size > 0;

  const existingLabelForTooth = useMemo(() => {
    if (!activeTooth) return null;
    const labels = restorations
      .filter(
        (r) => r.toothNumber && parseToothField(r.toothNumber).has(activeTooth),
      )
      .map((r) =>
        r.restorationType ? titleCase(r.restorationType) : "a restoration",
      );
    return labels.length > 0 ? labels.join(", ") : null;
  }, [activeTooth, restorations]);

  const existingRestorationIdForTooth = useMemo(() => {
    if (!activeTooth) return null;
    const match = restorations.find(
      (r) => /^(Crown(?:\s*(?:&|and)\s*Bridge)?|Pontic|Bridge|Implant|Veneer|Inlay|Onlay)$/i.test(r.restorationType ?? "") && r.toothNumber && parseToothField(r.toothNumber).has(activeTooth),
    );
    return match?.id ?? null;
  }, [activeTooth, restorations]);

  async function handleToothAction(payload: ToothActionPayload) {
    if (assignmentBatchBusy) return;
    setSheetError(null);

    if (payload.kind === "change_role") {
      const source = restorations.find((row) => row.id === payload.restorationId);
      if (!source || expandToothAssignmentIdentifiers(source.toothNumber ?? "").length !== 1 || !source.material) {
        setSheetError("Review this legacy row's individual teeth and material before assigning its role.");
        return;
      }
      try {
        await updateRestoration.mutateAsync({
          caseId, restorationId: payload.restorationId,
          data: { restorationType: payload.role, quantity: 1 },
        });
        setActiveTooth(null);
        await refreshAfterFinancialMutation();
      } catch (error) { setSheetError(errorMessage(error)); }
      return;
    }

    if (payload.kind === "copy_assignment") {
      const role = /^crown$/i.test(payload.role ?? "") ? "Crown" : /^pontic$/i.test(payload.role ?? "") ? "Pontic" : /^veneer$/i.test(payload.role ?? "") ? "Veneer" : null;
      const material = payload.material;
      if (!material || !role) { setSheetError("Confirm a role and catalog material before copying this assignment."); return; }
      setAssignmentBatchBusy(true);
      setActiveTooth(null);
      let saved = 0;
      try {
        for (const tooth of payload.toothNumbers) {
          const target = restorations.find((row) => /^(Crown|Pontic)$/i.test(row.restorationType ?? "") && row.toothNumber === tooth);
          const values = {
            toothNumber: tooth, restorationType: role, material, quantity: 1,
            restorationSubtype: payload.restorationSubtype ?? null, shade: payload.shade ?? "",
          };
          if (target && !target.id) throw new Error("Refresh the case before copying: the target record has no identity.");
          if (target?.id) await updateRestoration.mutateAsync({ caseId, restorationId: target.id, data: values });
          else await addRestoration.mutateAsync({ caseId, data: { ...values, restorationSubtype: payload.restorationSubtype ?? undefined } });
          saved++;
        }
        await persistNewToothSuggestions(new Set(payload.toothNumbers));
      } catch (error) {
        Alert.alert("Review copied assignments", `${saved} tooth assignments saved. ${errorMessage(error)} Refresh the chart before retrying remaining teeth.`);
      } finally {
        await refreshAfterFinancialMutation();
        setAssignmentBatchBusy(false);
      }
      return;
    }

    if (payload.kind === "remove_restoration") {
      const restorationId =
        payload.restorationId ?? existingRestorationIdForTooth;
      if (!restorationId) {
        setSheetError("Could not find restoration to remove.");
        return;
      }
      try {
        await deleteRestoration.mutateAsync({ caseId, restorationId });
        setActiveTooth(null);
        await refreshAfterFinancialMutation();
      } catch (e) {
        setSheetError(errorMessage(e));
      }
      return;
    }

    if (payload.kind === "change_restoration") {
      try {
        await updateRestoration.mutateAsync({
          caseId,
          restorationId: payload.restorationId,
          data: {
            material: payload.material,
            ...(payload.restorationSubtype
              ? { restorationSubtype: payload.restorationSubtype }
              : {}),
            ...(payload.shade ? { shade: payload.shade } : {}),
          },
        });
        setActiveTooth(null);
        await refreshAfterFinancialMutation();
      } catch (e) {
        setSheetError(errorMessage(e));
      }
      return;
    }

    const data =
      payload.kind === "add_crown"
        ? (() => {
            // Catalog-backed selections already carry their exact custom
            // subtype. For the built-in picker fallback, normalize the
            // free-text labels through the shared taxonomy so pricing keeps
            // receiving the canonical material label and subtype key.
            const normalized = payload.restorationSubtype
              ? null
              : normalizeCaseHierarchy({
                  caseType: payload.restorationType,
                  material: payload.material,
                });
            const normalizedMaterial =
              normalized?.hierarchy.caseType === "restorative" &&
              normalized.hierarchy.subtype &&
              normalized.hierarchy.materialSubtype
                ? getMaterialSubtypeLabel(
                    normalized.hierarchy.caseType,
                    normalized.hierarchy.subtype,
                    normalized.hierarchy.materialSubtype,
                  )
                : payload.material;
            return {
              toothNumber: payload.toothId,
              restorationType: payload.restorationType === "Veneer" ? "Veneer" : "Crown",
              material: normalizedMaterial,
              ...(payload.restorationSubtype
                ? { restorationSubtype: payload.restorationSubtype }
                : normalized?.restorationSubtype
                  ? { restorationSubtype: normalized.restorationSubtype }
                  : {}),
              ...(payload.shade ? { shade: payload.shade } : {}),
              quantity: 1,
            };
          })()
        : payload.kind === "add_pontic"
          ? {
              toothNumber: payload.toothId,
              restorationType: "Pontic",
              material: payload.material,
              ...(payload.restorationSubtype
                ? { restorationSubtype: payload.restorationSubtype }
                : {}),
              ...(payload.shade ? { shade: payload.shade } : {}),
              quantity: 1,
            }
          : {
              toothNumber: payload.toothId,
              restorationType: "Missing",
              quantity: 1,
              unitPrice: 0,
            };
    try {
      await addRestoration.mutateAsync({ caseId, data });
      setActiveTooth(null);
      if (payload.kind !== "mark_missing") {
        try { await persistNewToothSuggestions(new Set([payload.toothId])); }
        catch (error) { Alert.alert("Tooth saved", `Review its connections: ${errorMessage(error)}`); }
      }
      await refreshAfterFinancialMutation();
    } catch (e) {
      setSheetError(errorMessage(e));
    }
  }

  async function persistNewToothSuggestions(touched: Set<string>) {
    const latest = await fetchToothAssignmentCase(caseId);
    const latestCase = latest.data as { restorations?: DetailRestoration[]; bridgeConnectors?: string | null } | undefined;
    if (!latestCase) throw new Error("Could not reload the saved tooth assignments.");
    const units = (latestCase.restorations ?? []).map((row) => ({
      toothNumber: row.toothNumber ?? "", restorationType: row.restorationType ?? "",
      material: row.material, restorationSubtype: row.restorationSubtype,
    }));
    const state = withPonticConnectorSuggestions(latestCase.bridgeConnectors, units, touched);
    const text = serializeConnectorState(state);
    if (text === serializeConnectorState(parseConnectorState(latestCase.bridgeConnectors))) return;
    await updateCase.mutateAsync({ caseId, data: { bridgeConnectors: text } });
  }

  const chart = canEdit ? (
    <ToothChart
      crownTeeth={hasTypedTeeth ? crownTeeth : undefined}
      ponticTeeth={hasTypedTeeth ? ponticTeeth : undefined}
      veneerTeeth={veneerTeeth}
      missingTeeth={hasTypedTeeth ? missingTeeth : undefined}
      billedTeeth={billedTeeth}
      highlighted={highlighted}
      readOnly={false}
      onToothClick={(id) => {
        if (assignmentBatchBusy) return;
        setSheetError(null);
        setActiveTooth(id);
      }}
      selected={activeTooth ? new Set([activeTooth]) : undefined}
      connectedPairs={effectiveConnectedPairs}
      connectorSuggestions={connectorSuggestions}
      onConnectedPairsChange={saveConnectorPairs}
      connectorIssue={
        connectorError ??
        (connectorValidation.valid
          ? assignmentSummary.unresolvedPontics.length
            ? `Review unconnected pontics: ${assignmentSummary.unresolvedPontics.map((tooth) => `#${tooth}`).join(", ")}.`
            : null
          : connectorValidation.errors[0])
      }
      summaryText={assignmentSummaryText}
    />
  ) : (
    <ReadOnlyToothChart
      crownTeeth={hasTypedTeeth ? crownTeeth : undefined}
      ponticTeeth={hasTypedTeeth ? ponticTeeth : undefined}
      veneerTeeth={veneerTeeth}
      missingTeeth={hasTypedTeeth ? missingTeeth : undefined}
      billedTeeth={billedTeeth}
      highlighted={highlighted}
      connectedPairs={effectiveConnectedPairs}
      connectorSuggestions={connectorState.suggested}
      summaryText={assignmentSummaryText}
      connectorIssue={connectorValidation.valid ? null : connectorValidation.errors[0]}
    />
  );

  const actionSheet = canEdit ? (
    <ToothActionSheet
      toothId={activeTooth}
      existingLabel={existingLabelForTooth}
      existingRestorationId={existingRestorationIdForTooth}
      existingAssignment={restorations.find((row) => row.id === existingRestorationIdForTooth)}
      groupLabel={assignmentSummary.groups.find((group) => activeTooth && group.includes(activeTooth))?.map((tooth) => `#${tooth}`).join(", ")}
      submitting={
        addRestoration.isPending ||
        deleteRestoration.isPending ||
        updateRestoration.isPending
        || assignmentBatchBusy
      }
      error={sheetError}
      onClose={() => {
        setActiveTooth(null);
        setSheetError(null);
      }}
      onConfirm={handleToothAction}
      vocabularyMaterials={
        vocabMaterials.length > 0 ? vocabMaterials : undefined
      }
      catalogMaterials={catalogMaterials}
      catalogTypes={catalogToothTypes}
      vocabularyShades={vocabShades.length > 0 ? vocabShades : undefined}
      labOrganizationId={labOrgIdForVocab ?? undefined}
    />
  ) : null;

  // Card that lets lab members add a removable restoration without tapping a
  // tooth on the chart (removable types have no specific tooth position).
  const removableFormCard = canEdit ? (
    <Card>
      {showRemovableForm ? (
        <>
          <Text style={styles.cardHeading}>Add Removable Restoration</Text>
          <Text style={[styles.bodyText, { marginBottom: Spacing.sm }]}>
            For denture, partial, flipper, or flexible / Valplast — no tooth
            number needed.
          </Text>
          <Text style={styles.editLabel}>Type *</Text>
          <SuggestionInput
            value={removableForm.restorationType}
            onChangeText={(v) => {
              const subtypeKey = removableSubtypeKeyForLabel(v);
              setRemovableForm((f) => ({
                ...f,
                restorationType: v,
                restorationSubtype: subtypeKey ?? undefined,
              }));
            }}
            suggestions={removableTypeSuggestions}
            placeholder="e.g. Full Denture, Partial Denture, Flipper…"
            placeholderTextColor={colors.textTertiary}
            inputStyle={styles.input}
          />
          <Text style={styles.editLabel}>Material (optional)</Text>
          <TextInput
            style={styles.input}
            value={removableForm.material}
            onChangeText={(v) =>
              setRemovableForm((f) => ({ ...f, material: v }))
            }
            placeholder="e.g. Acrylic, Valplast…"
            placeholderTextColor={colors.textTertiary}
            autoCorrect={false}
          />
          <Text style={styles.editLabel}>Shade (optional)</Text>
          <TextInput
            style={styles.input}
            value={removableForm.shade}
            onChangeText={(v) => setRemovableForm((f) => ({ ...f, shade: v }))}
            placeholder="e.g. A2"
            placeholderTextColor={colors.textTertiary}
            autoCorrect={false}
          />
          <Text style={styles.editLabel}>Quantity</Text>
          <TextInput
            style={styles.input}
            value={removableForm.quantity}
            onChangeText={(v) =>
              setRemovableForm((f) => ({
                ...f,
                quantity: v.replace(/\D/g, ""),
              }))
            }
            keyboardType="number-pad"
            placeholder="1"
            placeholderTextColor={colors.textTertiary}
          />
          {removableError ? (
            <Text
              style={[
                styles.bodyText,
                { color: colors.error, marginTop: Spacing.xs },
              ]}
            >
              {removableError}
            </Text>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              gap: Spacing.sm,
              marginTop: Spacing.sm,
            }}
          >
            <Pressable
              style={[
                styles.btnPrimary,
                { flex: 1 },
                addRestoration.isPending && styles.btnDisabled,
              ]}
              onPress={handleAddRemovable}
              disabled={addRestoration.isPending}
            >
              {addRestoration.isPending ? (
                <ActivityIndicator color={colors.textInverse} size="small" />
              ) : (
                <Text style={styles.btnPrimaryText}>Add</Text>
              )}
            </Pressable>
            <Pressable
              style={[styles.btnSecondary, { flex: 1 }]}
              onPress={() => {
                setShowRemovableForm(false);
                setRemovableError(null);
              }}
            >
              <Text style={styles.btnSecondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Pressable
          style={styles.btnSecondary}
          onPress={() => setShowRemovableForm(true)}
          testID="add-removable-restoration-btn"
        >
          <Text style={styles.btnSecondaryText}>
            + Add Removable Restoration
          </Text>
        </Pressable>
      )}
    </Card>
  ) : null;

  if (restorations.length === 0) {
    if (!canEdit) {
      return (
        <EmptyState
          icon="construct-outline"
          text="No restorations on this case."
          styles={styles}
          colors={colors}
        />
      );
    }
    return (
      <View style={styles.sectionGap}>
        <Card>
          <Text style={styles.cardHeading}>Teeth</Text>
          <Text style={styles.teethLabel}>
            Tap a tooth to add a restoration.
          </Text>
          <View style={styles.toothChartWrap}>{chart}</View>
        </Card>
        {removableFormCard}
        {actionSheet}
      </View>
    );
  }
  return (
    <View style={styles.sectionGap}>
      <Card>
        <Text style={styles.cardHeading}>Teeth</Text>
        <>
          <Text style={styles.teethLabel}>{teethLabel}</Text>
          <View style={styles.toothChartWrap}>{chart}</View>
        </>
      </Card>

      {restorations.map((r, i) => {
        const isEditingType = canEdit && !!r.id && editingTypeId === r.id;
        return (
          <Card key={r.id ?? `rest-${i}`}>
            <View style={styles.restHeaderRow}>
              {isEditingType ? (
                <View style={{ flex: 1, marginRight: Spacing.sm }}>
                  <SuggestionInput
                    value={editTypeValue}
                    onChangeText={(v) => {
                      setEditTypeValue(v);
                      setEditTypeError(null);
                    }}
                    suggestions={allTypeSuggestions}
                    placeholder="e.g. Crown & Bridge, Full Denture…"
                    placeholderTextColor={colors.textTertiary}
                    inputStyle={styles.input}
                    testID={`edit-type-input-${r.id}`}
                  />
                  {editTypeError ? (
                    <Text
                      style={{
                        fontSize: 11,
                        color: colors.error,
                        marginTop: 2,
                      }}
                    >
                      {editTypeError}
                    </Text>
                  ) : null}
                  <View
                    style={{
                      flexDirection: "row",
                      gap: Spacing.xs,
                      marginTop: Spacing.xs,
                    }}
                  >
                    <Pressable
                      onPress={() => {
                        void saveEditType(r.id!);
                      }}
                      disabled={editTypeSaving}
                      style={{ padding: 4 }}
                      accessibilityLabel="Save restoration type"
                      testID={`save-restoration-type-${r.id}`}
                    >
                      {editTypeSaving ? (
                        <ActivityIndicator size="small" color={colors.tint} />
                      ) : (
                        <Ionicons
                          name="checkmark"
                          size={18}
                          color={colors.tint}
                        />
                      )}
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setEditingTypeId(null);
                        setEditTypeError(null);
                      }}
                      disabled={editTypeSaving}
                      style={{ padding: 4 }}
                      accessibilityLabel="Cancel"
                      testID={`cancel-restoration-type-${r.id}`}
                    >
                      <Ionicons
                        name="close"
                        size={18}
                        color={colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    flex: 1,
                  }}
                >
                  <Text style={styles.cardHeading}>
                    {r.restorationType
                      ? titleCase(r.restorationType)
                      : "Restoration"}
                  </Text>
                  {canEdit && !!r.id ? (
                    <Pressable
                      onPress={() => beginEditType(r)}
                      style={{ padding: 2 }}
                      accessibilityLabel="Edit restoration type"
                      testID={`edit-restoration-type-${r.id}`}
                    >
                      <Ionicons
                        name="pencil-outline"
                        size={14}
                        color={colors.textTertiary}
                      />
                    </Pressable>
                  ) : null}
                </View>
              )}
              {r.toothNumber && !isEditingType ? (
                <View style={styles.toothPill}>
                  <Text style={styles.toothPillText}>#{r.toothNumber}</Text>
                </View>
              ) : null}
            </View>
            {r.restorationSubtype ? (
              <FieldRow
                label="Subtype"
                value={titleCase(r.restorationSubtype)}
                styles={styles}
              />
            ) : null}
            {isImplantRestoration(r) && <SavedImplantDetails row={r} caseId={caseId} canEdit={canEdit} />}
            {(() => {
              const isEditingMaterial =
                canEdit && !!r.id && editingMaterialId === r.id;
              if (isEditingMaterial) {
                return (
                  <View
                    style={[
                      styles.fieldRow,
                      { flexDirection: "column", alignItems: "flex-start" },
                    ]}
                  >
                    <Text style={styles.fieldLabel}>Material</Text>
                    <View style={{ flex: 1, width: "100%", marginTop: 2 }}>
                      <SuggestionInput
                        value={editMaterialValue}
                        onChangeText={(v) => {
                          setEditMaterialValue(v);
                          setEditMaterialError(null);
                        }}
                        suggestions={[
                          ...vocabMaterials,
                          ...catalogMaterials
                            .filter(
                              (entry) =>
                                !vocabMaterials.some(
                                  (value) =>
                                    normalizeItemName(value) ===
                                    normalizeItemName(entry.label),
                                ),
                            )
                            .map((entry) => entry.label),
                        ]}
                        placeholder="e.g. Zirconia, PFM…"
                        placeholderTextColor={colors.textTertiary}
                        inputStyle={styles.input}
                        testID={`edit-material-input-${r.id}`}
                      />
                      {editMaterialError ? (
                        <Text
                          style={{
                            fontSize: 11,
                            color: colors.error,
                            marginTop: 2,
                          }}
                        >
                          {editMaterialError}
                        </Text>
                      ) : null}
                      <View
                        style={{
                          flexDirection: "row",
                          gap: Spacing.xs,
                          marginTop: Spacing.xs,
                        }}
                      >
                        <Pressable
                          onPress={() => {
                            void saveEditMaterial(r.id!);
                          }}
                          disabled={editMaterialSaving}
                          style={{ padding: 4 }}
                          accessibilityLabel="Save material"
                          testID={`save-restoration-material-${r.id}`}
                        >
                          {editMaterialSaving ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.tint}
                            />
                          ) : (
                            <Ionicons
                              name="checkmark"
                              size={18}
                              color={colors.tint}
                            />
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setEditingMaterialId(null);
                            setEditMaterialError(null);
                          }}
                          disabled={editMaterialSaving}
                          style={{ padding: 4 }}
                          accessibilityLabel="Cancel"
                        >
                          <Ionicons
                            name="close"
                            size={18}
                            color={colors.textSecondary}
                          />
                        </Pressable>
                      </View>
                    </View>
                  </View>
                );
              }
              return (
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>Material</Text>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      flex: 1,
                      justifyContent: "flex-end",
                    }}
                  >
                    <Text style={styles.fieldValue}>{r.material || "—"}</Text>
                    {canEdit && !!r.id ? (
                      <Pressable
                        onPress={() => beginEditMaterial(r)}
                        style={{ padding: 2 }}
                        accessibilityLabel="Edit material"
                        testID={`edit-restoration-material-${r.id}`}
                      >
                        <Ionicons
                          name="pencil-outline"
                          size={13}
                          color={colors.textTertiary}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })()}
            {(() => {
              const isEditingShade =
                canEdit && !!r.id && editingShadeId === r.id;
              if (isEditingShade) {
                return (
                  <View
                    style={[
                      styles.fieldRow,
                      { flexDirection: "column", alignItems: "flex-start" },
                    ]}
                  >
                    <Text style={styles.fieldLabel}>Shade</Text>
                    <View style={{ flex: 1, width: "100%", marginTop: 2 }}>
                      <SuggestionInput
                        value={editShadeValue}
                        onChangeText={(v) => {
                          setEditShadeValue(v);
                          setEditShadeError(null);
                        }}
                        suggestions={vocabShades}
                        placeholder="e.g. A2, BL1…"
                        placeholderTextColor={colors.textTertiary}
                        inputStyle={styles.input}
                      />
                      {editShadeError ? (
                        <Text
                          style={{
                            fontSize: 11,
                            color: colors.error,
                            marginTop: 2,
                          }}
                        >
                          {editShadeError}
                        </Text>
                      ) : null}
                      <View
                        style={{
                          flexDirection: "row",
                          gap: Spacing.xs,
                          marginTop: Spacing.xs,
                        }}
                      >
                        <Pressable
                          onPress={() => {
                            void saveEditShade(r.id!);
                          }}
                          disabled={editShadeSaving}
                          style={{ padding: 4 }}
                          accessibilityLabel="Save shade"
                        >
                          {editShadeSaving ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.tint}
                            />
                          ) : (
                            <Ionicons
                              name="checkmark"
                              size={18}
                              color={colors.tint}
                            />
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setEditingShadeId(null);
                            setEditShadeError(null);
                          }}
                          disabled={editShadeSaving}
                          style={{ padding: 4 }}
                          accessibilityLabel="Cancel"
                        >
                          <Ionicons
                            name="close"
                            size={18}
                            color={colors.textSecondary}
                          />
                        </Pressable>
                      </View>
                    </View>
                  </View>
                );
              }
              return (
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>Shade</Text>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      flex: 1,
                      justifyContent: "flex-end",
                    }}
                  >
                    <Text style={styles.fieldValue}>{r.shade || "—"}</Text>
                    {canEdit && !!r.id ? (
                      <Pressable
                        onPress={() => beginEditShade(r)}
                        style={{ padding: 2 }}
                        accessibilityLabel="Edit shade"
                        testID={`edit-restoration-shade-${r.id}`}
                      >
                        <Ionicons
                          name="pencil-outline"
                          size={13}
                          color={colors.textTertiary}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })()}
            {typeof r.quantity === "number" ? (
              <FieldRow
                label="Quantity"
                value={String(r.quantity)}
                styles={styles}
              />
            ) : null}
            {(() => {
              const unit = Number(
                (r as { unitPrice?: string | number | null }).unitPrice ?? 0,
              );
              const priceKey =
                (r as { priceKey?: string | null }).priceKey ?? "";
              const isAlloyLine =
                priceKey === "alloy" ||
                (r.restorationType ?? "").trim().toLowerCase() === "alloy";
              const unpriced = !(unit > 0);
              if (!unpriced) {
                return (
                  <FieldRow
                    label="Price"
                    value={`$${unit.toFixed(2)}`}
                    styles={styles}
                  />
                );
              }
              if (!isAdmin || isAlloyLine || !r.id) {
                return (
                  <FieldRow label="Price" value="Not set" styles={styles} />
                );
              }
              const restId = r.id;
              const saving = savingFeeScheduleId === restId;
              return (
                <View style={[styles.pfmReminder, { marginTop: Spacing.sm }]}>
                  <Ionicons
                    name="warning-outline"
                    size={18}
                    color={colors.warningStrong}
                    style={{ marginTop: 1 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pfmReminderText}>
                      No price is set for this item in this case's pricing tier.
                      Set it to price this line and future cases.
                    </Text>
                    <View style={styles.alloyPriceRow}>
                      <View style={styles.alloyPriceInputWrap}>
                        <Text style={styles.alloyPriceCurrency}>$</Text>
                        <TextInput
                          style={styles.alloyPriceInput}
                          value={feeScheduleInputs[restId] ?? ""}
                          onChangeText={(t) =>
                            setFeeScheduleInputs((prev) => ({
                              ...prev,
                              [restId]: t,
                            }))
                          }
                          placeholder="0.00"
                          placeholderTextColor={colors.textSecondary}
                          keyboardType="decimal-pad"
                          editable={!saving}
                          accessibilityLabel="Restoration price"
                        />
                      </View>
                      <Pressable
                        hitSlop={8}
                        onPress={() => setFeeSchedulePrice(restId)}
                        disabled={
                          saving ||
                          !(Number(feeScheduleInputs[restId] ?? "") > 0)
                        }
                        style={[
                          styles.alloyPriceButton,
                          (saving ||
                            !(Number(feeScheduleInputs[restId] ?? "") > 0)) && {
                            opacity: 0.5,
                          },
                        ]}
                      >
                        <Text style={styles.alloyPriceButtonText}>
                          {saving ? "Saving…" : "Set price"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })()}
            {r.notes && r.notes.trim() ? (
              <Text style={[styles.bodyText, { marginTop: Spacing.sm }]}>
                {r.notes.trim()}
              </Text>
            ) : null}
          </Card>
        );
      })}
      {removableFormCard}
      {actionSheet}
    </View>
  );
}

interface QRNoteMobile {
  id: string;
  body: string;
  label: string | null;
  isActive: boolean;
}

/**
 * Reads the server's actual error message off a failed Quick Reference
 * Notes response (the shared `{ ok: false, message }` envelope) instead of
 * silently swallowing the failure, so an outage is visible in the composer.
 */
async function qrnErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}
function NotesSection({
  caseNotes,
  notes,
  caseId,
  canPostNotes,
  canEdit,
  onSaved,
  styles,
  colors,
  labOrganizationId,
}: {
  caseNotes?: string | null;
  notes: DetailNote[];
  caseId: string;
  canPostNotes: boolean;
  canEdit: boolean;
  onSaved: () => void | Promise<unknown>;
  styles: Styles;
  colors: ThemeColors;
  labOrganizationId?: string | null;
}) {
  const [text, setText] = useState("");
  const [visibility, setVisibility] =
    useState<AddCaseNoteInputVisibility>("internal_lab_only");
  const [qrnOpen, setQrnOpen] = useState(false);
  const add = useAddCaseNote();
  const hasRx = !!(caseNotes && caseNotes.trim());
  const trimmed = text.trim();

  const qrnQuery = useQuery<QRNoteMobile[]>({
    queryKey: ["quick-reference-notes", labOrganizationId],
    enabled: !!labOrganizationId && canPostNotes,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const res = await resilientFetch(
        `/api/organizations/${labOrganizationId}/quick-reference-notes`,
      );
      if (!res.ok) {
        throw new Error(
          await qrnErrorMessage(
            res,
            `Failed to load templates (${res.status})`,
          ),
        );
      }
      const body = (await res.json()) as {
        ok: boolean;
        data: { notes: QRNoteMobile[] };
      };
      return (body.data?.notes ?? []).filter((n) => n.isActive);
    },
  });
  const activeTemplates = qrnQuery.data ?? [];

  function handleInsert(body: string) {
    setText(text.trim() ? `${text}\n${body}` : body);
    setQrnOpen(false);
  }

  async function submit() {
    if (!trimmed) return;
    try {
      await add.mutateAsync({
        caseId,
        data: { noteText: trimmed, visibility },
      });
      setText("");
      await onSaved();
    } catch (e) {
      Alert.alert("Couldn't add note", errorMessage(e));
    }
  }

  return (
    <View style={styles.sectionGap}>
      {canPostNotes ? (
        <Card>
          <Text style={styles.cardHeading}>Add a note</Text>
          <TextInput
            style={styles.noteInput}
            value={text}
            onChangeText={setText}
            placeholder="Write a note…"
            placeholderTextColor={colors.textTertiary}
            multiline
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            textAlignVertical="top"
            testID="note-input"
          />
          {qrnQuery.isError ? (
            <Text style={qrnErrorText(colors)}>
              Couldn't load quick reference notes:{" "}
              {errorMessage(qrnQuery.error)}
            </Text>
          ) : (
            activeTemplates.length > 0 && (
              <View>
                <Pressable
                  onPress={() => setQrnOpen((v) => !v)}
                  style={({ pressed }) => [
                    qrnPickerBtn(colors),
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Ionicons
                    name="bookmark-outline"
                    size={13}
                    color={colors.textSecondary}
                  />
                  <Text style={qrnPickerLabel(colors)}>
                    Add quick reference note
                  </Text>
                </Pressable>
                {qrnOpen && (
                  <View style={qrnList(colors)}>
                    {activeTemplates.map((t) => (
                      <Pressable
                        key={t.id}
                        onPress={() => handleInsert(t.body)}
                        style={({ pressed }) => [
                          qrnItem(colors),
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        {t.label ? (
                          <Text style={qrnItemLabel(colors)}>{t.label}</Text>
                        ) : null}
                        <Text style={qrnItemBody(colors)} numberOfLines={2}>
                          {t.body}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )
          )}
          <SegmentedRow
            label="Visibility"
            options={VISIBILITY_OPTIONS}
            value={visibility}
            onChange={(v) => setVisibility(v as AddCaseNoteInputVisibility)}
            styles={styles}
            testID="visibility"
          />
          <Pressable
            style={[
              styles.btnPrimary,
              styles.noteSubmit,
              (add.isPending || !trimmed) && styles.btnDisabled,
            ]}
            onPress={submit}
            disabled={add.isPending || !trimmed}
            testID="note-submit"
          >
            {add.isPending ? (
              <ActivityIndicator color={colors.textInverse} size="small" />
            ) : (
              <Text style={styles.btnPrimaryText}>Add note</Text>
            )}
          </Pressable>
        </Card>
      ) : null}

      {hasRx ? (
        <Card>
          <Text style={styles.cardHeading}>Rx instructions</Text>
          <Text style={styles.bodyText}>{caseNotes!.trim()}</Text>
        </Card>
      ) : null}
      {notes.map((n) => (
        <Card key={n.id}>
          <View style={styles.noteMetaRow}>
            <Text style={styles.noteAuthor}>{n.authorName || "Unknown"}</Text>
            <Text style={styles.noteDate}>{formatDateTime(n.createdAt)}</Text>
          </View>
          <Text style={styles.bodyText}>{n.noteText?.trim() || "—"}</Text>
          {n.visibility && n.visibility.toLowerCase() !== "all" ? (
            <Text style={styles.noteVisibility}>
              {titleCase(n.visibility)} only
            </Text>
          ) : null}
        </Card>
      ))}

      {!hasRx && notes.length === 0 ? (
        <Text style={styles.noteEmptyHint}>
          No notes yet. Add the first one above.
        </Text>
      ) : null}
    </View>
  );
}

function FilesSection({
  caseId,
  attachments,
  mediaSequence,
  loading,
  onOpenMedia,
  canUpload,
  canEdit,
  onRefresh,
  pendingShared,
  onConsumedShared,
  styles,
  colors,
}: {
  caseId: string;
  mediaSequence: CaseMediaItem[];
  attachments: {
    id: string;
    fileName?: string | null;
    fileType?: string | null;
    uploaderName?: string | null;
    createdAt?: string | null;
    note?: string | null;
    category?: string | null;
    caseExceptionId?: string | null;
  }[];
  loading: boolean;
  onOpenMedia: (item: CaseMediaItem) => void;
  canUpload: boolean;
  canEdit: boolean;
  onRefresh: () => void;
  pendingShared: InboxEntry[] | null;
  onConsumedShared: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openProgress, setOpenProgress] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleteAttachment = useDeleteCaseAttachment();
  const {
    markLongPress: markImageLongPress,
    consumeLongPress: consumeImageLongPress,
  } = useLongPressGuard<string>();
  const {
    markLongPress: markDocLongPress,
    consumeLongPress: consumeDocLongPress,
  } = useLongPressGuard<string>();

  interface UploadJob {
    key: string;
    fileName: string;
    mimeType: string;
    fileUri: string;
    fileSize?: number;
    videoSource?: VideoPreparationAsset;
    progress: number;
    status: "preparing" | "uploading" | "error" | "done";
    error?: string;
  }
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [noteQueue, setNoteQueue] = useState<
    { id: string; fileName: string; note: string }[]
  >([]);
  const [editingNote, setEditingNote] = useState<{
    id: string;
    fileName: string;
    note: string;
  } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const uploadQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedUploadKeysRef = useRef<Set<string>>(new Set());

  function updateJob(key: string, patch: Partial<UploadJob>) {
    setUploads((prev) =>
      prev.map((j) => (j.key === key ? { ...j, ...patch } : j)),
    );
  }

  async function runUpload(job: UploadJob) {
    let uploadJob = job;
    if (job.videoSource) {
      updateJob(job.key, { status: "preparing", progress: 0, error: undefined });
      try {
        const prepared = await prepareVideoForUpload(job.videoSource);
        uploadJob = {
          ...job,
          fileUri: prepared.uri,
          fileName: prepared.fileName,
          mimeType: prepared.mimeType,
          fileSize: prepared.fileSize,
          videoSource: undefined,
        };
        updateJob(job.key, uploadJob);
      } catch (e) {
        updateJob(job.key, { status: "error", error: errorMessage(e) });
        return;
      }
    }
    updateJob(job.key, { status: "uploading", progress: 0, error: undefined });
    try {
      const result = await uploadCaseAttachment({
        caseId,
        fileUri: uploadJob.fileUri,
        fileName: uploadJob.fileName,
        mimeType: uploadJob.mimeType,
        fileSize: uploadJob.fileSize,
        onProgress: (f) => updateJob(job.key, { progress: f }),
      });
      if (result.ok) {
        updateJob(job.key, { status: "done", progress: 1 });
        onRefresh();
        if (result.attachment?.id && !result.attachment.caseExceptionId) {
          setNoteQueue((prev) => [
            ...prev,
            {
              id: result.attachment!.id!,
              fileName: result.attachment!.fileName || job.fileName,
              note: result.attachment!.note || "",
            },
          ]);
        }
        setTimeout(() => {
          setUploads((prev) => prev.filter((j) => j.key !== job.key));
        }, 1200);
      } else {
        updateJob(job.key, { status: "error", error: result.error });
      }
    } catch (e) {
      // uploadCaseAttachment can throw (missing token, unreadable file URI,
      // network retries exhausted). Mark this job failed so its retry button
      // shows and the serial queue keeps draining the remaining jobs.
      updateJob(job.key, { status: "error", error: errorMessage(e) });
    }
  }

  function enqueueUpload(job: UploadJob) {
    if (queuedUploadKeysRef.current.has(job.key)) return;
    queuedUploadKeysRef.current.add(job.key);
    updateJob(job.key, {
      status: job.videoSource ? "preparing" : "uploading",
      progress: 0,
      error: undefined,
    });
    uploadQueueTailRef.current = uploadQueueTailRef.current
      .catch(() => undefined)
      .then(() => runUpload(job))
      .finally(() => {
        queuedUploadKeysRef.current.delete(job.key);
      });
  }

  function startJobs(
    files: {
      uri: string;
      name: string;
      mimeType: string;
      fileSize?: number;
      videoSource?: VideoPreparationAsset;
    }[],
  ) {
    if (files.length === 0) return;
    const jobs: UploadJob[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      fileName: f.name,
      mimeType: f.mimeType,
      fileUri: f.uri,
      fileSize: f.fileSize,
      videoSource: f.videoSource,
      progress: 0,
      status: f.videoSource ? "preparing" : "uploading",
    }));
    setUploads((prev) => [...jobs, ...prev]);
    for (const job of jobs) enqueueUpload(job);
  }

  function openNoteEditor(attachment: {
    id: string;
    fileName?: string | null;
    note?: string | null;
  }) {
    setEditingNote({
      id: attachment.id,
      fileName: attachment.fileName || "File",
      note: attachment.note || "",
    });
    setNoteText(attachment.note || "");
  }

  function closeNoteEditor() {
    if (savingNote) return;
    setEditingNote(null);
    setNoteText("");
  }

  function advanceNoteQueue() {
    setNoteQueue((prev) => prev.slice(1));
    setEditingNote(null);
    setNoteText("");
  }

  async function saveAttachmentNote() {
    if (!editingNote || savingNote) return;
    setSavingNote(true);
    try {
      const response = await resilientFetch(
        `/api/cases/${encodeURIComponent(caseId)}/attachments/${encodeURIComponent(editingNote.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: noteText }),
        },
      );
      if (!response.ok) throw new Error(`Could not save note (${response.status}).`);
      onRefresh();
      if (noteQueue[0]?.id === editingNote.id) advanceNoteQueue();
      else {
        setEditingNote(null);
        setNoteText("");
      }
    } catch (e) {
      Alert.alert("Couldn't save note", errorMessage(e));
    } finally {
      setSavingNote(false);
    }
  }

  useEffect(() => {
    if (!editingNote && noteQueue.length > 0) {
      openNoteEditor(noteQueue[0]);
    }
  }, [editingNote, noteQueue]);

  function queuedFile(input: {
    uri: string;
    name: string;
    mimeType: string;
    fileSize?: number;
    width?: number;
    height?: number;
    duration?: number;
  }) {
    if (!isVideoAsset({ mimeType: input.mimeType, fileName: input.name })) {
      return input;
    }
    const mimeType = resolveVideoMime({
      mimeType: input.mimeType,
      fileName: input.name,
    });
    return {
      ...input,
      mimeType,
      videoSource: {
        uri: input.uri,
        fileName: input.name,
        mimeType,
        fileSize: input.fileSize,
        width: input.width,
        height: input.height,
        duration: input.duration,
      },
    };
  }

  async function pickFromCamera() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!(perm.granted || perm.status === "granted")) {
        Alert.alert(
          "Camera permission needed",
          "Enable camera access in Settings to take photos.",
        );
        return;
      }
      const res = await ImagePicker.launchCameraAsync({
        quality: 0.85,
        mediaTypes: ["images"],
      });
      if (res.canceled) return;
      startJobs(
        res.assets.map((a) => ({
          uri: a.uri,
          name: a.fileName || `photo-${Date.now()}.jpg`,
          mimeType: a.mimeType || "image/jpeg",
        })),
      );
    } catch (e) {
      Alert.alert("Couldn't open camera", errorMessage(e));
    }
  }

  // Classify and normalize a library image before upload. Video preparation
  // runs later as part of the serial job so its state and failures are visible.
  // Videos are identified via a three-tier fallback so assets whose `type` and
  // `mimeType` are both null (some Android content providers) are still caught
  // by their file extension and never passed to ImageManipulator.
  async function normalizeLibraryImage(asset: {
    uri: string;
    mimeType?: string | null;
    type?: string | null; // "image" | "video" — expo-image-picker discriminator
    fileName?: string | null;
  }) {
    // Use the shared three-tier classifier: picker type → MIME prefix → extension.
    if (isVideoAsset(asset)) {
      return asset;
    }
    // Compress and resize all images (JPEG, PNG, HEIC, etc.) to keep uploads
    // well under 2 MB. Using quality: 1 on the picker prevents double-compression.
    const result = await ImageManipulator.manipulateAsync(
      asset.uri,
      [{ resize: { width: 1200 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { ...asset, uri: result.uri, mimeType: "image/jpeg" };
  }

  async function pickFromLibrary() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!(perm.granted || perm.status === "granted")) {
        Alert.alert(
          "Photo permission needed",
          "Enable photo library access in Settings to choose photos or videos.",
        );
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        // Use quality: 1 so the picker doesn't apply its own compression —
        // normalizeLibraryImage handles resize/compress for images, and
        // double-compression (picker + manipulator) degrades quality.
        quality: 1,
        allowsMultipleSelection: true,
        mediaTypes: ["images", "videos"],
      });
      if (res.canceled) return;
      const normalized = await Promise.all(
        res.assets.map((a) =>
          normalizeLibraryImage({
            uri: a.uri,
            mimeType: a.mimeType,
            type: a.type, // expo-image-picker discriminator ("image" | "video")
            fileName: a.fileName,
          }),
        ),
      );
      startJobs(
        res.assets.map((a, i) => {
          const norm = normalized[i];
          // Use the shared three-tier classifier for consistency with normalizeLibraryImage.
          if (
            isVideoAsset({
              type: a.type,
              mimeType: a.mimeType,
              fileName: a.fileName,
            })
          ) {
            // resolveVideoMime prefers the existing mimeType, then extension table,
            // then falls back to "video/mp4" — gives an accurate MIME for .mov, etc.
            const effectiveMime = resolveVideoMime({
              mimeType: a.mimeType,
              fileName: a.fileName,
            });
            const ext = fileExtension(a.fileName ?? "");
            const extSuffix = ext ? `.${ext}` : ".mov";
            const rawName =
              a.fileName || `video-${Date.now()}-${i}${extSuffix}`;
            return queuedFile({
              uri: norm.uri,
              name: rawName,
              mimeType: effectiveMime,
              fileSize: a.fileSize,
              width: a.width,
              height: a.height,
              duration: a.duration ?? undefined,
            });
          }
          // Image path: normalizeLibraryImage always outputs image/jpeg
          const wasConverted =
            norm.mimeType === "image/jpeg" &&
            (a.mimeType ?? "") !== "image/jpeg";
          const rawName = a.fileName || `photo-${Date.now()}-${i}.jpg`;
          const name = wasConverted
            ? rawName.replace(/\.[^.]+$/, ".jpg")
            : rawName;
          return {
            uri: norm.uri,
            name,
            mimeType: norm.mimeType || "image/jpeg",
          };
        }),
      );
    } catch (e) {
      Alert.alert("Couldn't open library", errorMessage(e));
    }
  }

  async function pickDocument() {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      startJobs(
        res.assets.map((a, i) => queuedFile({
          uri: a.uri,
          name: a.name || `file-${Date.now()}-${i}`,
          mimeType: a.mimeType || "application/octet-stream",
          fileSize: a.size,
        })),
      );
    } catch (e) {
      Alert.alert("Couldn't pick file", errorMessage(e));
    }
  }

  function openAddSheet() {
    setAddSheetVisible(true);
  }

  function handleAddSheetPick(picker: () => void) {
    setAddSheetVisible(false);
    picker();
  }

  // Consume files handed over by the share-intent prompt (parent peeks the inbox
  // and, on confirm, passes the popped entries here for upload via the same
  // pipeline as the manual Add button).
  useEffect(() => {
    if (!pendingShared || pendingShared.length === 0) return;
    startJobs(
      pendingShared.map((e) => {
        const meta = deriveSharedFileMeta(e.url);
        return queuedFile({ uri: e.url, name: meta.name, mimeType: meta.mimeType });
      }),
    );
    onConsumedShared();
    // startJobs is a stable local closure; only re-run when new shared files arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingShared]);

  async function handleOpenDoc(a: {
    id: string;
    fileName?: string | null;
    fileType?: string | null;
  }): Promise<void> {
    if (openingId) return;
    // Shared routing: iOS PDFs open in the in-app /pdf-viewer; everything else
    // (non-PDF docs, Android PDFs) falls back to the OS viewer / share sheet.
    // Images never reach here — they tap straight into the lightbox.
    await openAttachmentPreview(
      {
        url: attachmentFileUrl(caseId, a.id),
        fileName: a.fileName,
        fileType: a.fileType,
        caseId,
        textureAttachmentId:
          (a as { textureAttachmentId?: string | null }).textureAttachmentId ??
          (a as { scan?: { textureAttachmentId?: string | null } | null }).scan
            ?.textureAttachmentId,
      },
      {
        onOpenImage: () => undefined,
        onError: (title, message) => Alert.alert(title, message),
        setBusy: (busy) => {
          setOpeningId(busy ? a.id : null);
          if (!busy) setOpenProgress(null);
        },
        onProgress: (p) => setOpenProgress(p),
      },
    );
  }

  function handleDeleteAttachment(a: { id: string; fileName?: string | null }) {
    Alert.alert(
      "Delete attachment?",
      `"${a.fileName || "This file"}" will be permanently removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeletingId(a.id);
            try {
              await deleteAttachment.mutateAsync({
                caseId,
                attachmentId: a.id,
              });
              onRefresh();
            } catch (e) {
              Alert.alert("Couldn't delete file", errorMessage(e));
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.tint} />
      </View>
    );
  }

  const images = attachments.filter((a) =>
    isMediaAttachment(a.fileType, a.fileName),
  );
  const docs = attachments.filter(
    (a) => !isMediaAttachment(a.fileType, a.fileName),
  );
  const isEmpty = attachments.length === 0 && uploads.length === 0;

  return (
    <View style={styles.sectionGap}>
      <Modal
        visible={editingNote !== null}
        transparent
        animationType="slide"
        onRequestClose={() =>
          noteQueue[0]?.id === editingNote?.id ? advanceNoteQueue() : closeNoteEditor()
        }
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <Pressable
            style={{
              flex: 1,
              backgroundColor:
                "rgba(0,0,0,0.45)" /* hex-allow: semi-transparent overlay */,
            }}
            onPress={() =>
              noteQueue[0]?.id === editingNote?.id ? advanceNoteQueue() : closeNoteEditor()
            }
          >
            <View style={{ flex: 1 }} />
          </Pressable>
          {/*
            The sheet needs its own dismissal layer: a Modal renders in its own
            touch tree, so the screen's layer cannot reach in here. The backdrop
            above keeps closing the editor; tapping the sheet itself (which the
            autofocused note input opens the keyboard over) closes the keyboard.
          */}
          <DismissKeyboardView testID="attachment-note-keyboard-dismiss">
            <View
              style={{
                backgroundColor: colors.surface,
                borderTopLeftRadius: Radius.lg,
                borderTopRightRadius: Radius.lg,
                padding: Spacing.xl,
                gap: Spacing.md,
              }}
            >
              <Text style={{ ...Typography.h2, color: colors.text }}>
                {editingNote?.note ? "Edit note" : "Add a note"}
              </Text>
              <Text style={{ ...Typography.caption, color: colors.textTertiary }}>
                Optional note for {editingNote?.fileName || "this file"}. The file is already uploaded.
              </Text>
              <TextInput
                value={noteText}
                onChangeText={setNoteText}
                placeholder="e.g. before prep, shade reference, patient concern…"
                placeholderTextColor={colors.textTertiary}
                multiline
                autoCorrect={true}
                spellCheck={true}
                autoCapitalize="sentences"
                numberOfLines={3}
                maxLength={1000}
                autoFocus
                style={{
                  ...Typography.body,
                  color: colors.text,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: Radius.md,
                  padding: Spacing.md,
                  minHeight: 80,
                  textAlignVertical: "top",
                }}
                testID="attachment-note-input"
              />
              <View style={{ flexDirection: "row", gap: Spacing.sm }}>
                <Pressable
                  onPress={() =>
                    noteQueue[0]?.id === editingNote?.id ? advanceNoteQueue() : closeNoteEditor()
                  }
                  disabled={savingNote}
                  style={{
                    flex: 1,
                    paddingVertical: Spacing.md,
                    borderRadius: Radius.md,
                    borderWidth: 1,
                    borderColor: colors.border,
                    alignItems: "center",
                  }}
                  testID="attachment-note-skip"
                >
                  <Text
                    style={{
                      ...Typography.bodySemibold,
                      color: colors.textSecondary,
                    }}
                  >
                    {noteQueue[0]?.id === editingNote?.id ? "Skip" : "Cancel"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void saveAttachmentNote()}
                  disabled={savingNote}
                  style={{
                    flex: 2,
                    paddingVertical: Spacing.md,
                    borderRadius: Radius.md,
                    backgroundColor: colors.tint,
                    alignItems: "center",
                  }}
                  testID="attachment-note-upload"
                >
                  <Text
                    style={{
                      ...Typography.bodySemibold,
                      color: "#fff" /* hex-allow: white text on tint button */,
                    }}
                  >
                    {savingNote ? "Saving…" : "Save"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </DismissKeyboardView>
        </KeyboardAvoidingView>
      </Modal>

      {addSheetVisible ? (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setAddSheetVisible(false)}
        >
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setAddSheetVisible(false)}
          >
            <Pressable
              style={styles.sheet}
              onPress={() => undefined}
              testID="files-add-sheet"
            >
              <Text style={styles.sheetTitle}>Add to case</Text>
              <Pressable
                style={styles.optionRow}
                onPress={() => handleAddSheetPick(() => void pickFromCamera())}
                testID="files-add-camera"
              >
                <Text style={styles.optionText}>Take Photo</Text>
                <Ionicons
                  name="camera-outline"
                  size={20}
                  color={colors.textSecondary}
                />
              </Pressable>
              <Pressable
                style={styles.optionRow}
                onPress={() => handleAddSheetPick(() => void pickFromLibrary())}
                testID="files-add-library"
              >
                <Text style={styles.optionText}>Choose from Library</Text>
                <Ionicons
                  name="images-outline"
                  size={20}
                  color={colors.textSecondary}
                />
              </Pressable>
              <Pressable
                style={styles.optionRow}
                onPress={() => handleAddSheetPick(() => void pickDocument())}
                testID="files-add-document"
              >
                <Text style={styles.optionText}>Attach File</Text>
                <Ionicons
                  name="document-outline"
                  size={20}
                  color={colors.textSecondary}
                />
              </Pressable>
              <Pressable
                style={styles.sheetCancel}
                onPress={() => setAddSheetVisible(false)}
                testID="files-add-cancel"
              >
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {canUpload ? (
        <Pressable
          onPress={openAddSheet}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: Spacing.sm,
            paddingVertical: Spacing.md,
            borderRadius: Radius.md,
            borderWidth: 1,
            borderColor: colors.tint,
            borderStyle: "dashed",
          }}
          testID="files-add-button"
        >
          <Ionicons name="add-circle-outline" size={20} color={colors.tint} />
          <Text style={{ ...Typography.bodySemibold, color: colors.tint }}>
            Add photo or file
          </Text>
        </Pressable>
      ) : null}

      {uploads.map((job) => {
        const pct = Math.round(job.progress * 100);
        return (
          <View
            key={job.key}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: Spacing.md,
              padding: Spacing.md,
              borderRadius: Radius.md,
              backgroundColor: colors.surfaceAlt,
            }}
          >
            <Ionicons
              name={
                job.status === "error"
                  ? "alert-circle-outline"
                  : job.status === "done"
                    ? "checkmark-circle"
                    : job.status === "preparing"
                      ? "film-outline"
                      : "cloud-upload-outline"
              }
              size={20}
              color={
                job.status === "error"
                  ? colors.error
                  : job.status === "done"
                    ? colors.success
                    : colors.tint
              }
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text
                style={{ ...Typography.caption, color: colors.text }}
                numberOfLines={1}
              >
                {job.fileName}
              </Text>
              {job.status === "error" ? (
                <Text
                  style={{ ...Typography.caption, color: colors.error }}
                  numberOfLines={2}
                >
                  {job.error || "Upload failed."}
                </Text>
              ) : job.status === "preparing" ? (
                <Text
                  testID={`upload-preparing-${job.key}`}
                  style={{ ...Typography.caption, color: colors.textTertiary }}
                >
                  Preparing video…
                </Text>
              ) : (
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: colors.border,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      height: 4,
                      borderRadius: 2,
                      backgroundColor:
                        job.status === "done" ? colors.success : colors.tint,
                      width: `${pct}%`,
                    }}
                  />
                </View>
              )}
            </View>
            {job.status === "error" ? (
              <Pressable
                onPress={() => enqueueUpload(job)}
                hitSlop={8}
                testID={`upload-retry-${job.key}`}
              >
                <Ionicons name="refresh" size={18} color={colors.tint} />
              </Pressable>
            ) : job.status === "preparing" ? (
              <ActivityIndicator size="small" color={colors.tint} />
            ) : job.status === "uploading" ? (
              <Text
                style={{ ...Typography.caption, color: colors.textTertiary }}
              >
                {pct}%
              </Text>
            ) : null}
          </View>
        );
      })}

      {isEmpty ? (
        <EmptyState
          icon="images-outline"
          text="No files on this case."
          styles={styles}
          colors={colors}
        />
      ) : null}

      {images.length > 0 ? (
        <View style={styles.imageGrid}>
          {images.map((a) => {
            const url = attachmentFileUrl(caseId, a.id);
            const media = mediaSequence.find((item) => item.id === a.id) ?? {
              id: a.id,
              url,
              fileName: a.fileName,
              fileType: a.fileType,
              kind: isVideoAttachment(a.fileType, a.fileName)
                ? ("video" as const)
                : ("image" as const),
            };
            const isDeleting = deletingId === a.id;
            return (
              <View
                key={a.id}
                style={styles.thumb}
                testID={`media-open-${a.id}`}
              >
                <Pressable
                  style={{
                    aspectRatio: 1,
                    borderRadius: Radius.md,
                    overflow: "hidden",
                  }}
                  onPress={() => {
                    if (consumeImageLongPress(a.id)) return;
                    onOpenMedia(media);
                  }}
                  onLongPress={() => {
                    markImageLongPress(a.id);
                    if (media.kind === "image") {
                      confirmSaveAttachment({ kind: "image", url });
                    } else {
                      confirmSaveAttachment({
                        kind: "document",
                        url,
                        fileName: a.fileName,
                        fileType: a.fileType,
                      });
                    }
                  }}
                  testID={`img-open-${a.id}`}
                >
                  {media.kind === "image" ? (
                    <AuthedImage
                      url={url}
                      style={styles.thumbImage}
                      contentFit="cover"
                    />
                  ) : (
                    <VideoThumbnail
                      url={url}
                      tintColor={colors.textInverse}
                      fallbackColor={colors.textSecondary}
                    />
                  )}
                  {a.category === "outgoing" ? (
                    <View
                      style={{
                        position: "absolute",
                        bottom: 4,
                        left: 4,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4,
                        backgroundColor: "rgba(0,0,0,0.62)",
                      }}
                      testID={`img-outgoing-badge-${a.id}`}
                    >
                      <Text
                        style={{
                          ...Typography.caption,
                          fontSize: 10,
                          color:
                            "#fff" /* hex-allow: white label on photo thumbnail overlay */,
                        }}
                      >
                        Outgoing
                      </Text>
                    </View>
                  ) : null}
                  {canEdit ? (
                    <Pressable
                      style={styles.thumbTrashBtn}
                      onPress={(event) => {
                        event?.stopPropagation?.();
                        handleDeleteAttachment(a);
                      }}
                      hitSlop={4}
                      testID={`img-delete-${a.id}`}
                    >
                      {isDeleting ? (
                        <ActivityIndicator
                          color="#fff"
                          /* hex-allow: white spinner on photo thumbnail overlay */ size="small"
                        />
                      ) : (
                        <Ionicons
                          name="trash-outline"
                          size={14}
                          color="#fff" /* hex-allow: white icon on photo thumbnail overlay */
                        />
                      )}
                    </Pressable>
                  ) : null}
                </Pressable>
                {a.note ? (
                  <Text
                    style={{
                      ...Typography.caption,
                      color: colors.textSecondary,
                      marginTop: 4,
                      paddingHorizontal: 2,
                    }}
                    numberOfLines={2}
                  >
                    {a.note}
                  </Text>
                ) : null}
                {canUpload && !a.caseExceptionId ? (
                  <Pressable
                    onPress={() => openNoteEditor(a)}
                    hitSlop={6}
                    testID={`img-note-${a.id}`}
                  >
                    <Text style={{ ...Typography.captionSemibold, color: colors.tint }}>
                      {a.note ? "Edit note" : "Add note"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {docs.map((a) => {
        const opening = openingId === a.id;
        const isDeleting = deletingId === a.id;
        return (
          <Card
            key={a.id}
            onPress={() => {
              if (consumeDocLongPress(a.id)) return;
              handleOpenDoc(a);
            }}
            onLongPress={() => {
              markDocLongPress(a.id);
              confirmSaveAttachment({
                kind: "document",
                url: attachmentFileUrl(caseId, a.id),
                fileName: a.fileName,
                fileType: a.fileType,
              });
            }}
            testID={`doc-open-${a.id}`}
          >
            <View style={styles.docRow}>
              <Ionicons
                name="document-text-outline"
                size={22}
                color={colors.tint}
              />
              <View style={styles.docInfo}>
                <Text style={styles.docName} numberOfLines={1}>
                  {a.fileName || "File"}
                </Text>
                <Text style={styles.docMeta}>
                  {a.uploaderName ? `${a.uploaderName} · ` : ""}
                  {formatDate(a.createdAt)}
                </Text>
                {a.note ? (
                  <Text
                    style={{
                      ...Typography.caption,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                    numberOfLines={2}
                  >
                    {a.note}
                  </Text>
                ) : null}
                {canUpload && !a.caseExceptionId ? (
                  <Pressable
                    onPress={() => openNoteEditor(a)}
                    hitSlop={6}
                    testID={`doc-note-${a.id}`}
                  >
                    <Text style={{ ...Typography.captionSemibold, color: colors.tint }}>
                      {a.note ? "Edit note" : "Add note"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {isDeleting ? (
                <ActivityIndicator color={colors.warning} />
              ) : opening ? (
                openProgress !== null && openProgress > 0 ? (
                  <Text
                    style={[styles.docProgressText, { color: colors.tint }]}
                  >
                    {`${Math.round(openProgress * 100)}%`}
                  </Text>
                ) : (
                  <ActivityIndicator color={colors.tint} />
                )
              ) : (
                <View style={styles.docActions}>
                  <Ionicons
                    name="open-outline"
                    size={18}
                    color={colors.textTertiary}
                  />
                  {canEdit ? (
                    <Pressable
                       onPress={(event) => {
                         event?.stopPropagation?.();
                         handleDeleteAttachment(a);
                       }}
                      hitSlop={8}
                      testID={`doc-delete-${a.id}`}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={18}
                        color={colors.warning}
                      />
                    </Pressable>
                  ) : null}
                </View>
              )}
            </View>
          </Card>
        );
      })}
    </View>
  );
}

// ─── Invoice editing helpers ──────────────────────────────────────────────────
interface InvoiceLineItem {
  id: string;
  description?: string | null;
  quantity?: number | null;
  unitPrice?: string | number | null;
  lineTotal?: string | number | null;
  toothNumbers?: string | null;
  subItems?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────

function InvoiceSection({
  invoice,
  loading,
  canEdit,
  caseId,
  invoiceId,
  autoOpenPaymentForInvoiceId,
  patientName: patientNameProp,
  caseNumber,
  labName,
  onRefresh,
  styles,
  colors,
}: {
  invoice: {
    invoiceNumber?: string;
    status?: string;
    total?: string | number | null;
    balanceDue?: string | number | null;
    issuedAt?: string | null;
    dueAt?: string | null;
    items?: InvoiceLineItem[];
    lineItems?: InvoiceLineItem[];
    frozen?: boolean;
    caseDeletedAt?: string | null;
    caseDeletedNote?: string | null;
  } | null;
  loading: boolean;
  canEdit: boolean;
  caseId: string;
  invoiceId: string | null;
  /** Web-only deep link: open the payment sheet once this invoice is loaded. */
  autoOpenPaymentForInvoiceId?: string | null;
  patientName?: string | null;
  caseNumber?: string | null;
  labName?: string | null;
  onRefresh: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  // ── State
  const qc = useQueryClient();
  const [paySheet, setPaySheet] = useState(false);
  const [payForm, setPayForm] = useState<{ amount: string; method: string }>({
    amount: "",
    method: "check",
  });
  const [payMethodPicker, setPayMethodPicker] = useState(false);
  const [paymentPending, setPaymentPending] = useState(false);
  // The payment sheet body swallows taps so they never close the sheet; it
  // also carries keyboard dismissal for the amount/memo fields.
  const dismissPaymentKeyboard = useDismissKeyboardOnTap();
  const autoOpenedPaymentRef = useRef<string | null>(null);
  useEffect(() => {
    const target = autoOpenPaymentForInvoiceId;
    if (!target || autoOpenedPaymentRef.current === target) return;
    if (loading || !invoice || invoiceId !== target) return;
    // Web-only deep link; same guard as the Record payment button plus
    // frozen and zero-balance protection.
    if (Platform.OS !== "web") return;
    if (!canEdit || invoice.status === "paid" || invoice.status === "void") return;
    if (invoice.frozen) return;
    const balance = Number(invoice.balanceDue ?? invoice.total ?? 0);
    if (!(balance > 0)) return;
    autoOpenedPaymentRef.current = target;
    setPayForm({ amount: "", method: "check" });
    setPaySheet(true);
    // Consume the param so a remount or tab switch cannot reopen the sheet.
    try { router.setParams({ recordPaymentInvoiceId: undefined } as never); } catch { /* best effort */ }
  }, [autoOpenPaymentForInvoiceId, loading, invoice, invoiceId, canEdit]);

  // ── Mutations
  const generateInvoice = useGenerateInvoiceForCase();
  const emailInvoice = useEmailInvoice();
  const anyPending = generateInvoice.isPending;
  const [sharing, setSharing] = useState(false);
  const invalidateInvoiceFinanceViews = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["invoices"] }),
        qc.invalidateQueries({ queryKey: ["statement-account-summaries"] }),
      ]),
    [qc],
  );
  const invalidatePaymentFinanceViews = useCallback(
    () =>
      Promise.all([
        invalidateInvoiceFinanceViews(),
        qc.invalidateQueries({ queryKey: ["payment-history"] }),
        qc.invalidateQueries({ queryKey: ["undeposited-funds-summary"] }),
      ]),
    [invalidateInvoiceFinanceViews, qc],
  );

  const lines: InvoiceLineItem[] = (invoice?.items ??
    invoice?.lineItems ??
    []) as InvoiceLineItem[];

  // Build the print-ready invoice HTML from the current invoice + case context.
  function buildInvoiceDoc(): string {
    return buildInvoiceHtml({
      invoiceNumber: invoice?.invoiceNumber ?? null,
      status: invoice?.status ?? null,
      issuedAt: invoice?.issuedAt ?? null,
      dueAt: invoice?.dueAt ?? null,
      total: invoice?.total ?? null,
      balanceDue: invoice?.balanceDue ?? null,
      items: lines,
      patientName: patientNameProp ?? null,
      caseNumber: caseNumber ?? null,
      labName: labName ?? null,
    });
  }

  // ── Handlers
  // Export the invoice as a PDF and hand it to the OS share sheet (any viewer).
  async function handleExportInvoice() {
    if (!invoice) return;
    setSharing(true);
    try {
      const { uri } = await generatePdf(buildInvoiceDoc());
      await sharePdf(uri, {
        dialogTitle: invoice.invoiceNumber
          ? `Invoice #${invoice.invoiceNumber}`
          : "Invoice",
      });
    } catch (e) {
      Alert.alert("Couldn't export invoice", errorMessage(e));
    } finally {
      setSharing(false);
    }
  }

  // Email the invoice PDF to the practice's billing email (canonical endpoint).
  function handleEmailInvoice() {
    if (!invoiceId || !invoice) return;
    Alert.alert(
      "Email invoice?",
      "Send this invoice as a PDF to the practice's billing email on file.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send",
          onPress: async () => {
            try {
              const { base64 } = await generatePdf(buildInvoiceDoc(), {
                base64: true,
              });
              if (!base64) throw new Error("Could not render the invoice PDF.");
              const label = invoice.invoiceNumber ?? caseNumber ?? "invoice";
              await emailInvoice.mutateAsync({
                invoiceId,
                data: {
                  subject: `Invoice ${invoice.invoiceNumber ?? ""}`.trim(),
                  message:
                    `Please find attached invoice ${invoice.invoiceNumber ?? ""}.`.trim(),
                  filename: `Invoice-${label}.pdf`,
                  pdfBase64: base64,
                },
              });
              Alert.alert(
                "Invoice sent",
                "The invoice was emailed to the practice's billing email.",
              );
            } catch (e) {
              Alert.alert("Couldn't email invoice", errorMessage(e));
            }
          },
        },
      ],
    );
  }

  async function handleCreate() {
    try {
      await generateInvoice.mutateAsync({ caseId, data: {} });
      await Promise.all([
        Promise.resolve(onRefresh()),
        invalidateInvoiceFinanceViews(),
      ]);
    } catch (e) {
      Alert.alert("Couldn't create invoice", errorMessage(e));
    }
  }

  async function savePayment() {
    if (!invoiceId) return;
    const amount = parseFloat(payForm.amount);
    if (!amount || amount <= 0) {
      Alert.alert(
        "Invalid amount",
        "Enter a valid payment amount greater than zero.",
      );
      return;
    }
    setPaymentPending(true);
    try {
      const response = await resilientFetch(`/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, paymentMethod: payForm.method }),
      });
      await throwIfResNotOk(response);
      setPaySheet(false);
      setPayForm({ amount: "", method: "check" });
      await Promise.all([
        Promise.resolve(onRefresh()),
        invalidatePaymentFinanceViews(),
      ]);
    } catch (e) {
      Alert.alert("Couldn't record payment", errorMessage(e));
    } finally {
      setPaymentPending(false);
    }
  }

  // ── Render: loading
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.tint} />
      </View>
    );
  }

  // ── Render: no invoice
  if (!invoice) {
    return (
      <View style={styles.sectionGap}>
        <EmptyState
          icon="receipt-outline"
          text="No invoice for this case."
          styles={styles}
          colors={colors}
        />
        {canEdit ? (
          <Pressable
            style={[
              styles.btnPrimary,
              generateInvoice.isPending && styles.btnDisabled,
            ]}
            onPress={handleCreate}
            disabled={generateInvoice.isPending}
            testID="create-invoice"
          >
            {generateInvoice.isPending ? (
              <ActivityIndicator color={colors.textInverse} size="small" />
            ) : (
              <Text style={styles.btnPrimaryText}>Create Invoice</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    );
  }

  const canPay =
    canEdit && invoice.status !== "paid" && invoice.status !== "void";

  return (
    <View style={styles.sectionGap}>
      {/* ── Invoice header card ── */}
      <Card>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardHeading, styles.cardHeadingFlush]}>
            {invoice.invoiceNumber
              ? `Invoice #${invoice.invoiceNumber}`
              : "Invoice"}
          </Text>
          <View style={styles.invHeaderRight}>
            {invoice.status ? (
              <StatusBadge
                label={titleCase(invoice.status)}
                variant={invoiceVariant(invoice.status)}
              />
            ) : null}
          </View>
        </View>
        <FieldRow
          label="Issued"
          value={formatDate(invoice.issuedAt)}
          styles={styles}
        />
        <FieldRow
          label="Due"
          value={formatDate(invoice.dueAt)}
          styles={styles}
        />
        <FieldRow label="Total" value={money(invoice.total)} styles={styles} />
        <FieldRow
          label="Balance"
          value={money(invoice.balanceDue)}
          styles={styles}
        />
        {invoice.frozen ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              marginTop: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "#f59e0b",
              backgroundColor: "#fffbeb",
            }}
          >
            <Ionicons name="lock-closed-outline" size={14} color="#92400e" />
            <Text
              style={{
                fontSize: 13,
                color: "#92400e",
                fontWeight: "600",
                flexShrink: 1,
              }}
            >
              {invoice.caseDeletedNote ?? "Case Deleted"}
              {invoice.caseDeletedAt
                ? `  ·  ${formatDate(invoice.caseDeletedAt)}`
                : ""}
            </Text>
          </View>
        ) : null}
        {canEdit && !invoice.frozen && invoiceId ? (
          <View style={styles.invoiceActions}>
            <Pressable
              style={[styles.btnSecondary, styles.invoiceActionBtn]}
              onPress={() =>
                router.push(`/invoice-editor/${invoiceId}` as never)
              }
              disabled={anyPending}
              testID="invoice-open-editor"
            >
              <Ionicons name="create-outline" size={16} color={colors.text} />
              <Text style={styles.btnSecondaryText}>Open in editor</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.invoiceActions}>
          <Pressable
            style={[
              styles.btnSecondary,
              styles.invoiceActionBtn,
              sharing && styles.btnDisabled,
            ]}
            onPress={handleExportInvoice}
            disabled={sharing}
            testID="invoice-export"
          >
            {sharing ? (
              <ActivityIndicator color={colors.tint} size="small" />
            ) : (
              <>
                <Ionicons name="share-outline" size={16} color={colors.text} />
                <Text style={styles.btnSecondaryText}>Export PDF</Text>
              </>
            )}
          </Pressable>
          {canEdit ? (
            <Pressable
              style={[
                styles.btnSecondary,
                styles.invoiceActionBtn,
                emailInvoice.isPending && styles.btnDisabled,
              ]}
              onPress={handleEmailInvoice}
              disabled={emailInvoice.isPending}
              testID="invoice-email"
            >
              {emailInvoice.isPending ? (
                <ActivityIndicator color={colors.tint} size="small" />
              ) : (
                <>
                  <Ionicons name="mail-outline" size={16} color={colors.text} />
                  <Text style={styles.btnSecondaryText}>Email</Text>
                </>
              )}
            </Pressable>
          ) : null}
        </View>
      </Card>

      {/* ── Line items card (read-only; edit via the full-screen editor) ── */}
      <Card>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardHeading, styles.cardHeadingFlush]}>
            Line items
          </Text>
        </View>
        {lines.length === 0 ? (
          <Text style={styles.noteEmptyHint}>No line items yet.</Text>
        ) : (
          lines.flatMap((li) => [
            <View
              key={li.id}
              style={styles.lineItem}
              testID={`invoice-item-${li.id}`}
            >
              <View style={styles.lineItemMain}>
                <Text style={styles.lineDesc} numberOfLines={2}>
                  {li.description || "Item"}
                  {li.toothNumbers ? `  ·  #${li.toothNumbers}` : ""}
                </Text>
                <Text style={styles.lineSub}>
                  {li.quantity ?? 1} × {money(li.unitPrice)}
                </Text>
              </View>
              <Text style={styles.lineTotal}>{money(li.lineTotal)}</Text>
            </View>,
            ...((li.subItems as any[] | undefined) ?? []).map(
              (sub: any, sidx: number) => (
                <View
                  key={`${li.id}-sub-${sidx}`}
                  style={[styles.lineItem, { paddingLeft: 24 }]}
                >
                  <View style={styles.lineItemMain}>
                    <Text
                      style={[styles.lineDesc, { opacity: 0.65, fontSize: 13 }]}
                      numberOfLines={2}
                    >
                      {sub.description || "Item"}
                    </Text>
                  </View>
                  <Text style={[styles.lineTotal, { opacity: 0.65 }]}>
                    {money(sub.lineTotal)}
                  </Text>
                </View>
              ),
            ),
          ])
        )}
      </Card>

      {/* ── Record payment button ── */}
      {canPay ? (
        <Pressable
          style={[
            styles.btnPrimary,
            (anyPending || paymentPending) && styles.btnDisabled,
          ]}
          onPress={() => {
            setPayForm({ amount: "", method: "check" });
            setPaySheet(true);
          }}
          disabled={anyPending || paymentPending}
          testID="record-payment"
        >
          <Text style={styles.btnPrimaryText}>Record payment</Text>
        </Pressable>
      ) : null}

      {/* ════ Payment sheet ════ */}
      <Modal
        visible={paySheet}
        transparent
        animationType="fade"
        onRequestClose={() => setPaySheet(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setPaySheet(false)}
        >
          <Pressable
            style={styles.sheet}
            onPress={dismissPaymentKeyboard}
            testID="payment-sheet-keyboard-dismiss"
          >
            <Text style={styles.sheetTitle}>Record Payment</Text>
            <EditTextRow
              label="Amount ($)"
              value={payForm.amount}
              onChangeText={(t) => setPayForm((f) => ({ ...f, amount: t }))}
              styles={styles}
              colors={colors}
              autoCapitalize="none"
              testID="payment-amount"
            />
            <SelectRow
              label="Method"
              valueLabel={labelFor(PAYMENT_METHOD_OPTIONS, payForm.method)}
              onPress={() => setPayMethodPicker(true)}
              styles={styles}
              colors={colors}
              testID="payment-method-select"
            />
            <View style={styles.editActions}>
              <Pressable
                style={styles.btnSecondary}
                onPress={() => setPaySheet(false)}
                disabled={paymentPending}
              >
                <Text style={styles.btnSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.btnPrimary,
                  paymentPending && styles.btnDisabled,
                ]}
                onPress={savePayment}
                disabled={paymentPending}
                testID="save-payment"
              >
                {paymentPending ? (
                  <ActivityIndicator color={colors.textInverse} size="small" />
                ) : (
                  <Text style={styles.btnPrimaryText}>Save</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <OptionPickerModal
        visible={payMethodPicker}
        title="Payment method"
        options={PAYMENT_METHOD_OPTIONS}
        selected={payForm.method}
        onSelect={(v) => {
          setPayForm((f) => ({ ...f, method: v }));
          setPayMethodPicker(false);
        }}
        onClose={() => setPayMethodPicker(false)}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

function HistorySection({
  events,
  notes,
  caseId,
  mediaSequence,
  onOpenMedia,
  onOpenStandaloneMedia,
  onViewRx,
  styles,
  colors,
}: {
  events: DetailEvent[];
  notes: DetailNote[];
  caseId: string;
  mediaSequence: CaseMediaItem[];
  onOpenMedia: (item: CaseMediaItem) => void;
  onOpenStandaloneMedia: (item: CaseMediaItem) => void;
  /** Opens the case screen's Prescription Preview modal. */
  onViewRx?: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openProgress, setOpenProgress] = useState<number | null>(null);
  const {
    markLongPress: markImageLongPress,
    consumeLongPress: consumeImageLongPress,
  } = useLongPressGuard<string>();
  const {
    markLongPress: markDocLongPress,
    consumeLongPress: consumeDocLongPress,
  } = useLongPressGuard<string>();

  // Index the viewer-authorized notes by id so `note_added` history rows can
  // resolve their body from the visible notes payload (the server already
  // withholds internal lab-only notes from non-lab viewers).
  const notesById = useMemo(() => {
    const m = new Map<string, DetailNote>();
    for (const n of notes) if (n?.id) m.set(n.id, n);
    return m;
  }, [notes]);

  if (events.length === 0) {
    return (
      <EmptyState
        icon="time-outline"
        text="No history yet."
        styles={styles}
        colors={colors}
      />
    );
  }

  function openEventAttachment(
    ev: DetailEvent,
    att: NonNullable<ReturnType<typeof eventAttachment>>,
  ) {
    if (openingId) return;
    void openAttachmentPreview(
      { url: att.url, fileName: att.fileName, fileType: att.fileType },
      {
        onOpenImage: () => undefined,
        onError: (title, message) => Alert.alert(title, message),
        setBusy: (busy) => {
          setOpeningId(busy ? ev.id : null);
          if (!busy) setOpenProgress(null);
        },
        onProgress: (p) => setOpenProgress(p),
      },
    );
  }

  const returnDividerIds = detectMobileReturnDividerEventIds(events);

  return (
    <Card padding="none">
      {events.map((ev, i) => {
        const desc = eventDescription(ev, notesById);
        const invoiceNumber = eventInvoiceNumber(ev);
        const invoiceSummary = eventInvoiceSummary(ev);
        const inboxProviderNote = eventInboxProviderNote(ev);
        const metadata =
          ev.metadataJson && typeof ev.metadataJson === "object"
            ? (ev.metadataJson as Record<string, unknown>)
            : {};
        const metadataAuthor =
          typeof metadata.authorName === "string" && metadata.authorName
            ? metadata.authorName
            : null;
        const actor = metadataAuthor ?? ev.actorName ?? ev.actorInitials;
        const att = eventAttachment(ev, caseId);
        const historyMediaId = att?.attachmentId || `history-${ev.id}`;
        const isCurrentCaseEvent = !ev.caseId || ev.caseId === caseId;
        const media =
          att && isMediaAttachment(att.fileType, att.fileName)
            ? (isCurrentCaseEvent
                ? mediaSequence.find((item) => item.id === historyMediaId)
                : undefined) ?? {
                id: historyMediaId,
                url: att.url,
                fileName: att.fileName,
                fileType: att.fileType,
                kind: isVideoAttachment(att.fileType, att.fileName)
                  ? ("video" as const)
                  : ("image" as const),
              }
            : undefined;
        const isCurrentCaseMedia =
          !!media && isCurrentCaseEvent && mediaSequence.some((item) => item.id === media.id);
        const opening = openingId === ev.id;
        const isCaseReturn = !!ev.id && returnDividerIds.has(ev.id);
        const eventTimestamp = ev.occurredAt ?? ev.createdAt;
        const previousEvent = i > 0 ? events[i - 1] : undefined;
        const isDayGroupStart =
          i === 0 ||
          historyEventDayKey(previousEvent ?? {}) !== historyEventDayKey(ev);
        return (
          <React.Fragment key={ev.id}>
            {isDayGroupStart && (
              <>
                {i > 0 && (
                  <View
                    testID="history-date-separator"
                    style={styles.historyDateSeparator}
                  />
                )}
                <Text
                  testID="history-day-header"
                  style={styles.historyDayHeader}
                >
                  {formatHistoryDayLabel(eventTimestamp)}
                </Text>
              </>
            )}
            {isCaseReturn && (
              <View style={styles.caseReturnDivider}>
                <View style={styles.caseReturnDividerLine} />
                <Text style={styles.caseReturnDividerLabel}>Case returned</Text>
                <View style={styles.caseReturnDividerLine} />
              </View>
            )}
            <View style={styles.eventRow}>
              <View style={styles.eventDot} />
              <View style={styles.eventBody}>
                {isCaseReturn && onViewRx ? (
                  <Pressable
                    hitSlop={8}
                    onPress={onViewRx}
                    accessibilityRole="button"
                    accessibilityLabel="View Rx"
                    testID={`history-view-rx-${ev.id}`}
                    style={styles.historyViewRxButton}
                  >
                    <Ionicons
                      name="document-text-outline"
                      size={12}
                      color={colors.tint}
                    />
                    <Text style={styles.historyViewRxText}>View Rx</Text>
                  </Pressable>
                ) : null}
                {invoiceSummary ? (
                  <Text style={styles.eventTitle}>{invoiceSummary}</Text>
                ) : (
                  <>
                    <Text style={styles.eventTitle}>
                      {eventIsOutgoingPhoto(ev)
                        ? "Outgoing Case Photo"
                        : formatEventType(ev.eventType)}
                    </Text>
                    {invoiceNumber ? (
                      <Text style={styles.eventInvoiceNumber}>
                        {invoiceNumber}
                      </Text>
                    ) : null}
                    {desc ? (
                      ev.eventType === "note_added" ||
                      isInternalExceptionNoteEvent(ev.eventType) ? (
                        <View style={styles.noteHighlight}>
                          <Text style={styles.noteHighlightText}>{desc}</Text>
                        </View>
                      ) : (
                        <Text style={styles.eventDesc}>{desc}</Text>
                      )
                    ) : null}
                    {inboxProviderNote ? (
                      <Text
                        style={styles.inboxProviderNote}
                      >{`\u201c${inboxProviderNote}\u201d`}</Text>
                    ) : null}
                  </>
                )}
                {att ? (
                  media ? (
                    <Pressable
                      onPress={() => {
                        if (consumeImageLongPress(ev.id)) return;
                        if (isCurrentCaseMedia) onOpenMedia(media);
                        else onOpenStandaloneMedia(media);
                      }}
                      onLongPress={() => {
                        markImageLongPress(ev.id);
                        if (media.kind === "image") {
                          confirmSaveAttachment({ kind: "image", url: media.url });
                        } else {
                          confirmSaveAttachment({
                            kind: "document",
                            url: media.url,
                            fileName: media.fileName,
                            fileType: media.fileType,
                          });
                        }
                      }}
                      style={styles.historyAttachThumb}
                      testID={`history-attachment-${ev.id}`}
                    >
                      {media.kind === "image" ? (
                        <AuthedImage
                          url={media.url}
                          style={styles.thumbImage}
                          contentFit="cover"
                        />
                      ) : (
                        <VideoThumbnail
                          url={media.url}
                          tintColor={colors.textInverse}
                          fallbackColor={colors.textSecondary}
                        />
                      )}
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => {
                        if (consumeDocLongPress(ev.id)) return;
                        openEventAttachment(ev, att);
                      }}
                      onLongPress={() => {
                        markDocLongPress(ev.id);
                        confirmSaveAttachment({
                          kind: "document",
                          url: att.url,
                          fileName: att.fileName,
                          fileType: att.fileType,
                        });
                      }}
                      style={styles.historyAttachRow}
                      testID={`history-attachment-${ev.id}`}
                    >
                      {opening ? (
                        openProgress !== null && openProgress > 0 ? (
                          <Text
                            style={[
                              styles.docProgressText,
                              { color: colors.tint },
                            ]}
                          >
                            {`${Math.round(openProgress * 100)}%`}
                          </Text>
                        ) : (
                          <ActivityIndicator color={colors.tint} size="small" />
                        )
                      ) : (
                        <Ionicons
                          name="attach-outline"
                          size={16}
                          color={colors.tint}
                        />
                      )}
                      <Text style={styles.historyAttachText} numberOfLines={1}>
                        {att.fileName || "Open file"}
                      </Text>
                    </Pressable>
                  )
                ) : null}
                <Text
                  testID={`history-event-meta-${ev.id}`}
                  style={styles.eventMeta}
                >
                  {actor ? `${actor} · ` : ""}
                  {formatHistoryTime(eventTimestamp)}
                </Text>
              </View>
            </View>
          </React.Fragment>
        );
      })}
    </Card>
  );
}

function EmptyState({
  icon,
  text,
  styles,
  colors,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.emptyState}>
      <Ionicons name={icon} size={36} color={colors.textTertiary} />
      <Text style={styles.emptyBody}>{text}</Text>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    caseBodyWithActionBar: { flex: 1 },
    caseBodyScroll: { flex: 1 },
    caseEditActionBar: {
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
    },
    caseEditActionRow: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.md,
    },
    header: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "flex-end",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    headerMain: {
      flexDirection: "row",
      alignItems: "center",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      gap: Spacing.sm,
    },
    backBtn: { padding: Spacing.xs, flexShrink: 0 },
    headerTitles: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    headerTitle: { ...Typography.h2, color: c.text },
    headerSubtitle: { ...Typography.h2, color: c.textSecondary, flexShrink: 1 },
    headerRight: { marginLeft: Spacing.sm, flexShrink: 0 },
    sharedSaveBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    sharedSaveBannerText: { ...Typography.caption, color: c.textSecondary },
    tabsWrap: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    tabsRow: {
      paddingHorizontal: Spacing.md,
      paddingBottom: Spacing.sm,
      gap: Spacing.sm,
    },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
    },
    tabActive: { backgroundColor: c.tint },
    tabLabel: { ...Typography.captionMedium, color: c.textSecondary },
    tabLabelActive: { color: c.textInverse },
    body: { padding: Spacing.lg, paddingBottom: Spacing.huge, gap: Spacing.md },
    sectionGap: { gap: Spacing.md },
    caseActionRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-start",
      gap: Spacing.sm,
    },
    caseActionButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      minHeight: 44,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
    },
    caseActionButtonText: { ...Typography.captionSemibold },
    cardHeading: { ...Typography.h3, color: c.text, marginBottom: Spacing.sm },
    detailSectionTitle: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
      marginTop: Spacing.md,
      marginBottom: Spacing.xs,
    },
    scheduleSummary: {
      flexDirection: "column",
      alignItems: "stretch",
      gap: Spacing.xs,
      padding: Spacing.sm,
      marginBottom: Spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    scheduleMetric: {
      flexGrow: 0,
      flexBasis: "auto",
      minWidth: 0,
      paddingVertical: Spacing.xs,
      paddingHorizontal: Spacing.xs,
    },
    scheduleValue: {
      ...Typography.captionSemibold,
      color: c.text,
      flexShrink: 1,
    },
    patientProviderPanel: {
      gap: Spacing.xs,
      marginBottom: Spacing.md,
      padding: Spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    patientProviderGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-start",
      gap: Spacing.md,
    },
    patientProviderGridLargeText: {
      flexDirection: "column",
      alignItems: "stretch",
    },
    patientProviderField: {
      flexGrow: 1,
      flexBasis: 120,
      minWidth: 112,
    },
    patientProviderFieldLargeText: {
      alignSelf: "stretch",
      flexGrow: 0,
      flexBasis: "auto",
      minWidth: 0,
    },
    practiceProviderField: {
      flexGrow: 2,
      flexBasis: 150,
      minWidth: 130,
    },
    restorationDetailsPanel: {
      width: "100%",
      minWidth: 0,
      gap: Spacing.lg,
      padding: Spacing.md,
      marginBottom: Spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    restorationFieldStack: {
      width: "100%",
      minWidth: 0,
      flexDirection: "column",
      alignItems: "stretch",
      gap: Spacing.lg,
    },
    infoFieldLabel: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
    },
    patientNameValue: {
      ...Typography.h2,
      color: c.text,
      width: "100%",
      flexShrink: 1,
    },
    bodyText: { ...Typography.body, color: c.text },
    fieldRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      paddingVertical: Spacing.xs + 2,
      gap: Spacing.md,
    },
    fieldLabel: { ...Typography.bodyMedium, color: c.textSecondary },
    fieldValue: {
      ...Typography.bodyMedium,
      color: c.text,
      flexShrink: 1,
      textAlign: "right",
    },
    pfmReminder: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      backgroundColor: c.warningSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.warning,
      borderRadius: Radius.md,
      padding: Spacing.sm + 2,
      marginBottom: Spacing.md,
    },
    pfmReminderText: { ...Typography.bodyMedium, color: c.warningText },
    pfmReminderActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.lg,
      marginTop: Spacing.xs,
    },
    pfmReminderAdd: { ...Typography.captionSemibold, color: c.warningText },
    pfmReminderDismiss: {
      ...Typography.captionSemibold,
      color: c.warningStrong,
    },
    pfmReminderDontShow: { ...Typography.caption, color: c.warningStrong },
    alloyPriceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginTop: Spacing.sm,
    },
    alloyPriceInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.warning,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
    },
    alloyPriceCurrency: { ...Typography.bodyMedium, color: c.warningStrong },
    alloyPriceInput: {
      ...Typography.bodyMedium,
      color: c.text,
      minWidth: 70,
      paddingVertical: Spacing.xs,
      paddingLeft: 2,
    },
    alloyPriceButton: {
      backgroundColor: c.warningStrong,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs + 2,
    },
    alloyPriceButtonText: { ...Typography.captionSemibold, color: c.surface },
    teethLabel: {
      ...Typography.bodyMedium,
      color: c.tint,
      marginBottom: Spacing.md,
    },
    toothChartWrap: { alignItems: "center" },
    restHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: Spacing.xs,
    },
    toothPill: {
      backgroundColor: c.tintLight,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderRadius: Radius.xs,
    },
    toothPillText: { ...Typography.captionSemibold, color: c.tint },
    noteMetaRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: Spacing.xs,
    },
    noteAuthor: { ...Typography.bodySemibold, color: c.text },
    noteDate: { ...Typography.caption, color: c.textTertiary },
    noteVisibility: {
      ...Typography.caption,
      color: c.warning,
      marginTop: Spacing.xs,
    },
    imageGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    thumb: {
      width: "31%",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
      borderWidth: BorderWidth.section,
      borderColor: c.sectionBorder,
      paddingBottom: Spacing.xs,
    },
    thumbImage: { width: "100%", height: "100%" },
    historyAttachThumb: {
      width: 72,
      height: 72,
      borderRadius: Radius.md,
      overflow: "hidden",
      marginTop: Spacing.xs,
      backgroundColor: c.surfaceAlt,
      borderWidth: BorderWidth.section,
      borderColor: c.sectionBorder,
    },
    historyAttachRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginTop: Spacing.xs,
    },
    historyAttachText: { ...Typography.caption, color: c.tint, flexShrink: 1 },
    historyViewRxButton: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 5,
      borderRadius: Radius.xs,
      backgroundColor: c.tintLight,
      marginBottom: Spacing.xs,
    },
    historyViewRxText: { ...Typography.captionSemibold, color: c.tint },
    docRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    docInfo: { flex: 1 },
    docName: { ...Typography.bodyMedium, color: c.text },
    docMeta: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    docProgressText: {
      ...Typography.bodyMedium,
      minWidth: 36,
      textAlign: "right",
    },
    lineItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      gap: Spacing.md,
    },
    lineItemMain: { flex: 1 },
    lineDesc: { ...Typography.bodyMedium, color: c.text },
    lineSub: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    lineTotal: { ...Typography.bodySemibold, color: c.text },
    eventRow: { flexDirection: "row", gap: Spacing.md, padding: Spacing.lg },
    eventDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    historyDateSeparator: {
      borderTopWidth: 2,
      borderTopColor: c.border,
      marginHorizontal: Spacing.lg,
      marginTop: Spacing.md,
    },
    historyDayHeader: {
      ...Typography.h3,
      color: c.text,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
      paddingBottom: Spacing.xs,
    },
    caseReturnDivider: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    caseReturnDividerLine: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
    },
    caseReturnDividerLabel: {
      ...Typography.caption,
      color: c.textTertiary,
      marginHorizontal: Spacing.sm,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    eventDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.tint,
      marginTop: 6,
    },
    eventBody: { flex: 1 },
    eventTitle: { ...Typography.bodySemibold, color: c.text },
    eventInvoiceNumber: {
      ...Typography.bodySemibold,
      color: c.tint,
      marginTop: 2,
    },
    eventDesc: { ...Typography.body, color: c.textSecondary, marginTop: 2 },
    noteHighlight: {
      marginTop: 4,
      backgroundColor: "#FEF9C3",
      borderWidth: 1,
      borderColor: "#FDE68A",
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    noteHighlightText: { ...Typography.body, color: "#78350F" },
    inboxProviderNote: {
      ...Typography.body,
      color: c.textSecondary,
      fontStyle: "italic",
      marginTop: 4,
    },
    eventMeta: { ...Typography.caption, color: c.textTertiary, marginTop: 4 },
    emptyState: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.huge,
      gap: Spacing.md,
    },
    emptyTitle: { ...Typography.h3, color: c.text },
    emptyBody: {
      ...Typography.body,
      color: c.textSecondary,
      textAlign: "center",
    },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: c.textInverse },
    cardHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.sm,
    },
    cardHeadingFlush: { marginBottom: 0 },
    editBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      padding: Spacing.xs,
    },
    editBtnText: { ...Typography.captionSemibold, color: c.tint },
    editRow: { paddingVertical: Spacing.xs + 2, gap: Spacing.xs },
    editLabel: { ...Typography.caption, color: c.textSecondary },
    dueTimeSection: { paddingVertical: Spacing.xs + 2, gap: Spacing.sm },
    checkboxRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
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
    input: {
      ...Typography.body,
      color: c.text,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      backgroundColor: c.surfaceAlt,
    },
    selectValue: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      backgroundColor: c.surfaceAlt,
    },
    selectValueText: { ...Typography.body, color: c.text },
    segment: {
      flexDirection: "row",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.sm,
      padding: 3,
      gap: 3,
    },
    segmentBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: Spacing.sm,
      borderRadius: Radius.xs,
    },
    segmentBtnActive: { backgroundColor: c.tint },
    segmentText: { ...Typography.captionMedium, color: c.textSecondary },
    segmentTextActive: { color: c.textInverse },
    editActions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.md,
    },
    btnPrimary: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.sm + 2,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      minHeight: 44,
    },
    btnPrimaryText: { ...Typography.bodySemibold, color: c.textInverse },
    btnSecondary: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.sm + 2,
      borderRadius: Radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      minHeight: 44,
    },
    btnSecondaryText: { ...Typography.bodySemibold, color: c.text },
    btnDisabled: { opacity: 0.5 },
    headerRightGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    headerIconBtn: { padding: Spacing.xs },
    locateCurrent: {
      ...Typography.body,
      color: c.textSecondary,
      marginBottom: Spacing.md,
    },
    locateCurrentStrong: { ...Typography.bodySemibold, color: c.text },
    locateBtn: {
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: "auto",
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.xl,
      marginTop: Spacing.md,
    },
    locateStatusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    locateStatusBlock: { alignItems: "flex-start", gap: Spacing.xs },
    locateStatusText: { ...Typography.body, color: c.textSecondary },
    locateSuccess: {
      ...Typography.captionSemibold,
      color: c.success,
      marginTop: Spacing.sm,
    },
    stationHistHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    stationHistTitle: { ...Typography.bodySemibold, color: c.text },
    stationHistBadge: {
      backgroundColor: c.tintLight,
      borderRadius: Radius.full,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 1,
      minWidth: 20,
      alignItems: "center",
    },
    stationHistBadgeText: { ...Typography.captionSemibold, color: c.tint },
    stationHistRow: {
      flexDirection: "row",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    stationHistDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.tintLight,
      borderWidth: 2,
      borderColor: c.tint,
      marginTop: 5,
    },
    invoiceActions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.md,
    },
    invoiceActionBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
    },
    noteInput: {
      ...Typography.body,
      color: c.text,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      backgroundColor: c.surfaceAlt,
      minHeight: 88,
      marginBottom: Spacing.sm,
    },
    noteSubmit: { marginTop: Spacing.md },
    noteEmptyHint: {
      ...Typography.body,
      color: c.textTertiary,
      textAlign: "center",
      paddingVertical: Spacing.lg,
    },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: c.backgroundSolid,
      borderTopLeftRadius: Radius.lg,
      borderTopRightRadius: Radius.lg,
      padding: Spacing.lg,
      paddingBottom: Spacing.xl,
      gap: Spacing.sm,
    },
    sheetTitle: { ...Typography.h3, color: c.text, marginBottom: Spacing.xs },
    optionScroll: { maxHeight: 360 },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    optionText: { ...Typography.body, color: c.text },
    optionTextActive: { ...Typography.bodySemibold, color: c.tint },
    sheetCancel: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.xl,
      borderRadius: Radius.full,
      backgroundColor: c.surfaceAlt,
    },
    sheetCancelText: { ...Typography.bodySemibold, color: c.text },
    calHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.sm,
    },
    calNav: { padding: Spacing.xs },
    calMonth: { ...Typography.bodySemibold, color: c.text },
    calWeekRow: { flexDirection: "row" },
    calWeekday: {
      ...Typography.caption,
      color: c.textTertiary,
      width: `${100 / 7}%`,
      textAlign: "center",
    },
    calGrid: { flexDirection: "row", flexWrap: "wrap" },
    calCell: {
      width: `${100 / 7}%`,
      height: 42,
      alignItems: "center",
      justifyContent: "center",
    },
    calCellSelected: { backgroundColor: c.tint, borderRadius: Radius.full },
    calCellText: { ...Typography.body, color: c.text },
    calCellTextToday: { color: c.tint, fontFamily: "Inter_700Bold" },
    calCellTextSelected: { color: c.textInverse, fontFamily: "Inter_700Bold" },
    calFooter: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: Spacing.sm,
    },
    calTypeButton: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "center",
      gap: Spacing.sm,
      padding: Spacing.sm,
    },
    timeColumns: {
      flexDirection: "row",
      justifyContent: "center",
      gap: Spacing.sm,
      height: 180,
    },
    timeColumn: {
      width: 64,
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
    },
    timeCell: {
      paddingVertical: Spacing.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    timeCellSelected: { backgroundColor: c.tint, borderRadius: Radius.sm },
    timeCellText: { ...Typography.body, color: c.text },
    timeCellTextSelected: { color: c.textInverse, fontFamily: "Inter_700Bold" },
    periodColumn: { width: 56, justifyContent: "center", gap: Spacing.sm },
    periodCell: {
      paddingVertical: Spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
    },
    periodCellSelected: { backgroundColor: c.tint },
    periodCellText: { ...Typography.bodySemibold, color: c.text },
    periodCellTextSelected: { color: c.textInverse },
    lightbox: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.92)",
      alignItems: "center",
      justifyContent: "center",
    },
    lightboxImage: { width: "100%", height: "80%" },
    lightboxVideo: { width: "100%", height: "72%" },
    lightboxClose: { position: "absolute", right: Spacing.lg },
    lightboxNavigation: {
      position: "absolute",
      left: Spacing.md,
      right: Spacing.md,
      bottom: Spacing.xl,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    lightboxNavButton: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.58)",
    },
    lightboxNavDisabled: { opacity: 0.35 },
    lightboxPosition: {
      ...Typography.bodySemibold,
      color: "#fff" /* hex-allow: fixed-dark gallery position label */,
      backgroundColor: "rgba(0,0,0,0.58)",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
    },
    videoFallback: {
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
      padding: Spacing.xl,
    },
    videoFallbackText: {
      ...Typography.body,
      color: "#fff",
      textAlign: "center",
    },
    videoFallbackButton: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: c.tint,
    },
    videoFallbackButtonText: {
      ...Typography.bodySemibold,
      color: c.textInverse,
    },
    videoThumb: {
      flex: 1,
      backgroundColor: c.textSecondary,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      padding: Spacing.sm,
    },
    thumbTrashBtn: {
      position: "absolute",
      top: 4,
      right: 4,
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: "rgba(0,0,0,0.55)",
      alignItems: "center",
      justifyContent: "center",
    },
    docActions: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    invHeaderRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    btnDanger: { borderColor: c.warning },
    btnDangerText: { color: c.warning },
    labelPrintOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    labelPrintSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      padding: Spacing.xl,
      gap: Spacing.md,
    },
    labelPrintHandle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: "center",
      marginBottom: Spacing.sm,
    },
    labelPrintTitle: { ...Typography.h2, color: c.text, textAlign: "center" },
    labelPrintBody: {
      ...Typography.body,
      color: c.textSecondary,
      textAlign: "center",
    },
    labelPrintBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    labelPrintBtnText: { ...Typography.bodySemibold, color: "#fff" },
    labelPrintSkipBtn: { paddingVertical: Spacing.sm, alignItems: "center" },
    labelPrintSkipText: { ...Typography.body, color: c.textTertiary },
    relatedHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      paddingBottom: Spacing.sm,
    },
    relatedHint: { ...Typography.caption, color: c.textTertiary },
    relatedRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      gap: Spacing.sm,
    },
    relatedRowMain: { flex: 1 },
    relatedRowName: { ...Typography.bodyMedium, color: c.text },
    relatedRowMeta: {
      ...Typography.caption,
      color: c.textSecondary,
      marginTop: 2,
    },
    relatedRowRight: { alignItems: "flex-end", gap: 4 },
    relatedDivider: {
      height: StyleSheet.hairlineWidth,
      marginHorizontal: Spacing.lg,
    },
    relatedLocatedBadge: { flexDirection: "row", alignItems: "center", gap: 3 },
    relatedLocatedText: { ...Typography.captionSemibold },
  });
}

function qrnPickerBtn(c: ThemeColors) {
  return {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: Radius.sm,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginTop: 8,
    alignSelf: "flex-start" as const,
  };
}
function qrnPickerLabel(c: ThemeColors) {
  return { ...Typography.caption, color: c.textSecondary };
}
function qrnList(c: ThemeColors) {
  return {
    marginTop: 6,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: Radius.md,
    backgroundColor: c.surface,
    overflow: "hidden" as const,
    maxHeight: 220,
  };
}
function qrnItem(_c: ThemeColors) {
  return {
    paddingVertical: 10,
    paddingHorizontal: 14,
  };
}
function qrnItemLabel(c: ThemeColors) {
  return { ...Typography.captionSemibold, color: c.tint, marginBottom: 2 };
}
function qrnItemBody(c: ThemeColors) {
  return { ...Typography.caption, color: c.text };
}

function qrnErrorText(c: ThemeColors) {
  return { ...Typography.caption, color: c.errorText, marginTop: 8 };
}

function timeTo12Hour(h24: number): { h12: number; period: "AM" | "PM" } {
  const period: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { h12, period };
}

function roundToNearest5Min(m: number): number {
  return (Math.round(m / 5) * 5) % 60;
}

const TIME_MINUTES_5 = Array.from({ length: 12 }, (_, i) => i * 5); // 0, 5, ..., 55

function TimePickerModal({
  visible,
  title,
  value,
  onSelect,
  onClear,
  onClose,
  styles,
}: {
  visible: boolean;
  title: string;
  value: string | null;
  onSelect: (v: string) => void;
  onClear?: () => void;
  onClose: () => void;
  styles: Styles;
}) {
  const [draft, setDraft] = useState(() => timeDraftFromValue(value));

  useEffect(() => {
    if (visible) setDraft(timeDraftFromValue(value));
  }, [visible, value]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <View style={styles.timeColumns}>
            <ScrollView
              style={styles.timeColumn}
              showsVerticalScrollIndicator={false}
            >
              {TIME_HOURS_12.map((h) => {
                const isSel = draft.h12 === h;
                return (
                  <Pressable
                    key={`h-${h}`}
                    style={[styles.timeCell, isSel && styles.timeCellSelected]}
                    onPress={() => setDraft((d) => ({ ...d, h12: h }))}
                    testID={`time-hour-${h}`}
                  >
                    <Text
                      style={[
                        styles.timeCellText,
                        isSel && styles.timeCellTextSelected,
                      ]}
                    >
                      {h}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <ScrollView
              style={styles.timeColumn}
              showsVerticalScrollIndicator={false}
            >
              {TIME_MINUTES_5.map((m) => {
                const isSel = draft.m === m;
                return (
                  <Pressable
                    key={`m-${m}`}
                    style={[styles.timeCell, isSel && styles.timeCellSelected]}
                    onPress={() => setDraft((d) => ({ ...d, m }))}
                    testID={`time-minute-${m}`}
                  >
                    <Text
                      style={[
                        styles.timeCellText,
                        isSel && styles.timeCellTextSelected,
                      ]}
                    >
                      {String(m).padStart(2, "0")}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.periodColumn}>
              {(["AM", "PM"] as const).map((p) => {
                const isSel = draft.period === p;
                return (
                  <Pressable
                    key={p}
                    style={[
                      styles.periodCell,
                      isSel && styles.periodCellSelected,
                    ]}
                    onPress={() => setDraft((d) => ({ ...d, period: p }))}
                    testID={`time-period-${p.toLowerCase()}`}
                  >
                    <Text
                      style={[
                        styles.periodCellText,
                        isSel && styles.periodCellTextSelected,
                      ]}
                    >
                      {p}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={styles.calFooter}>
            {onClear ? (
              <Pressable
                style={styles.sheetCancel}
                onPress={onClear}
                testID="time-clear"
              >
                <Text style={styles.sheetCancelText}>Clear</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <View style={{ flexDirection: "row", gap: Spacing.sm }}>
              <Pressable
                style={styles.sheetCancel}
                onPress={onClose}
                testID="time-cancel"
              >
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.sheetCancel}
                onPress={() =>
                  onSelect(
                    timeHHMM(timeTo24Hour(draft.h12, draft.period), draft.m),
                  )
                }
                testID="time-set"
              >
                <Text style={styles.sheetCancelText}>Set</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function timeTo24Hour(h12: number, period: "AM" | "PM"): number {
  const base = h12 % 12;
  return period === "PM" ? base + 12 : base;
}

function timeDraftFromValue(value: string | null | undefined) {
  const mins = parseDueTimeMinutes(value);
  if (mins != null) {
    const { h12, period } = timeTo12Hour(Math.floor(mins / 60));
    return { h12, m: roundToNearest5Min(mins % 60), period };
  }
  const now = new Date();
  const { h12, period } = timeTo12Hour(now.getHours());
  return { h12, m: roundToNearest5Min(now.getMinutes()), period };
}

function timeHHMM(h24: number, m: number): string {
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
