import React, { useEffect, useMemo, useRef, useState } from "react";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import {
  useCase,
  useInvoices,
  useInvoice,
  useCaseAttachments,
  useUpdateCase,
  useAddCaseNote,
  useDeleteCaseAttachment,
  useGenerateInvoiceForCase,
  useEmailInvoice,
  type UpdateCaseInput,
  type UpdateCaseInputStatus,
  type UpdateCaseInputPriority,
  type AddCaseNoteInputVisibility,
} from "@workspace/api-client-react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { resilientFetch } from "@/lib/query-client";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import {
  peekSharedFiles,
  popSharedFiles,
  subscribeSharedFileInbox,
  type InboxEntry,
} from "@/lib/shared-file-inbox";
import { useMe, canEditOrg } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { ReadOnlyToothChart } from "@/components/ReadOnlyToothChart";
import { deriveRxSummary, buildHighlightedToothSet, formatRxTeethLabel } from "@/lib/rx-summary";
import { CASE_STATIONS as STATUS_OPTIONS } from "@/lib/case-stations";
import {
  attachmentFileUrl,
  isImageAttachment,
  openAttachmentPreview,
} from "@/lib/attachment-preview";
import { buildCaseCardHtml, buildInvoiceHtml, generatePdf, sharePdf } from "@/lib/case-pdf";
import { printCaseHistory } from "@/lib/printCaseHistory";
import { setAiReaderSession, clearAiReaderSession } from "@/lib/ai-reader-store";

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
  eventType?: string | null;
  actorInitials?: string | null;
  actorName?: string | null;
  metadataJson?: unknown;
  occurredAt?: string | null;
  createdAt?: string | null;
}
interface DetailRestoration {
  id?: string | null;
  toothNumber?: string | null;
  restorationType?: string | null;
  restorationSubtype?: string | null;
  material?: string | null;
  shade?: string | null;
  notes?: string | null;
  quantity?: number | null;
}
interface DetailRemakeRef {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  status?: string | null;
}
interface DetailedCase {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  expectedDeliveryDate?: string | null;
  bridgeConnectors?: string | null;
  casePanBarcode?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  shade?: string | null;
  caseNotes?: string | null;
  notes?: DetailNote[] | null;
  events?: DetailEvent[] | null;
  originalCaseEvents?: DetailEvent[] | null;
  remakeChildrenEvents?: DetailEvent[] | null;
  restorations?: DetailRestoration[] | null;
  remakeOriginal?: DetailRemakeRef | null;
  remakeChildren?: DetailRemakeRef[] | null;
  remakeReason?: string | null;
  organizationId?: string | null;
  labOrganizationId?: string | null;
}

type SectionKey = "overview" | "restorations" | "notes" | "files" | "invoice" | "history";

const SECTIONS: { key: SectionKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "overview", label: "Overview", icon: "information-circle-outline" },
  { key: "restorations", label: "Restorations", icon: "construct-outline" },
  { key: "notes", label: "Notes", icon: "chatbox-ellipses-outline" },
  { key: "files", label: "Files", icon: "images-outline" },
  { key: "invoice", label: "Invoice", icon: "receipt-outline" },
  { key: "history", label: "History", icon: "time-outline" },
];

// ─── Formatting helpers ───────────────────────────────────────────────────────
function patientName(c: { patientFirstName?: string | null; patientLastName?: string | null }): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending"))
    return "intake";
  return "progress";
}

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  if (s.includes("draft")) return "draft";
  return "open";
}

// Mirror desktop formatEventType: the "Locate Case" action PATCHes the canonical
// case status, which the server records as a "status_changed" event. Users think
// of that as "locating" the case at a station, so surface it as "Location Changed".
function formatEventType(eventType?: string | null): string {
  if (!eventType) return "Event";
  if (eventType === "status_changed") return "Location Changed";
  return titleCase(eventType);
}

// Best-effort one-line description from a history event's metadata blob.
function eventDescription(ev: DetailEvent): string | null {
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
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
  if (typeof meta.note === "string" && meta.note) return meta.note;
  if (typeof meta.message === "string" && meta.message) return meta.message;
  return null;
}

// Tappable attachment carried by a history event's metadata, mirroring desktop:
// prefer the legacy/mobile imageUri (works without auth headers, including data:
// URIs) and fall back to the canonical id-based /file route. Returns null for
// non-attachment events or when no openable source is present.
function eventAttachment(
  ev: DetailEvent,
  caseId: string,
): { url: string; fileName: string | null; fileType: string | null; isImage: boolean } | null {
  if (!ev.eventType || !ev.eventType.includes("attachment")) return null;
  let meta: Record<string, unknown> | null = null;
  if (ev.metadataJson && typeof ev.metadataJson === "object") {
    meta = ev.metadataJson as Record<string, unknown>;
  } else if (typeof ev.metadataJson === "string" && ev.metadataJson.trim()) {
    try {
      const parsed = JSON.parse(ev.metadataJson);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!meta) return null;
  const fileType = meta.fileType != null ? String(meta.fileType) : null;
  const mediaKind = meta.mediaKind != null ? String(meta.mediaKind) : "";
  const fileName = meta.fileName != null ? String(meta.fileName) : null;
  const directSrc = meta.imageUri != null ? String(meta.imageUri) : null;
  const attachmentId = meta.attachmentId != null ? String(meta.attachmentId) : null;
  const url = directSrc || (attachmentId ? attachmentFileUrl(caseId, attachmentId) : null);
  if (!url) return null;
  const isImage =
    fileType?.startsWith("image/") === true ||
    mediaKind === "photo" ||
    isImageAttachment(fileType, fileName);
  return { url, fileName, fileType, isImage };
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

const VISIBILITY_OPTIONS: { value: AddCaseNoteInputVisibility; label: string }[] = [
  { value: "internal_lab_only", label: "Internal" },
  { value: "shared_with_provider", label: "Shared" },
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// ─── Edit helpers ─────────────────────────────────────────────────────────────
function labelFor(options: { value: string; label: string }[], value: string | null | undefined): string {
  if (!value) return "—";
  return options.find((o) => o.value === value)?.label ?? titleCase(value);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Please try again.";
}

// Date-only string ("YYYY-MM-DD") helpers kept in plain calendar space to avoid
// timezone drift. The case payload stores dates as UTC-midnight timestamps, so
// we read their UTC components; the calendar then works purely on integers.
function toDateInput(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYMD(v: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map((n) => Number(n));
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function formatDateInput(value: string | null | undefined): string {
  const p = parseYMD(value);
  if (!p) return "—";
  // Build a local Date from explicit components so there is no tz shift.
  const d = new Date(p.y, p.m - 1, p.d);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function todayYMD(): { y: number; m: number; d: number } {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftMonth(view: { y: number; m: number }, delta: number): { y: number; m: number } {
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
  dueDate: string | null;
  expectedDeliveryDate: string | null;
}

function formFromCase(c: DetailedCase): OverviewForm {
  return {
    patientFirstName: c.patientFirstName ?? "",
    patientLastName: c.patientLastName ?? "",
    doctorName: c.doctorName ?? "",
    priority: (c.priority ?? "normal").toLowerCase(),
    dueDate: toDateInput(c.dueDate),
    expectedDeliveryDate: toDateInput(c.expectedDeliveryDate),
  };
}

// Build a minimal PATCH payload containing only changed editable fields. This
// mirrors the desktop drawer (no mobile-only writes) and avoids clobbering
// fields the user did not touch.
function buildOverviewPayload(c: DetailedCase, form: OverviewForm): UpdateCaseInput {
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
  if (form.priority && form.priority !== (c.priority ?? "normal").toLowerCase()) {
    payload.priority = form.priority as UpdateCaseInputPriority;
  }
  const origDue = toDateInput(c.dueDate);
  if (form.dueDate && form.dueDate !== origDue) {
    payload.dueDate = form.dueDate;
  }
  const origExp = toDateInput(c.expectedDeliveryDate);
  if (form.expectedDeliveryDate !== origExp) {
    payload.expectedDeliveryDate = form.expectedDeliveryDate;
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
  styles,
  colors,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.editRow}>
      <Text style={styles.editLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize={autoCapitalize ?? "words"}
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
}: {
  label: string;
  valueLabel: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
  testID?: string;
}) {
  return (
    <View style={styles.editRow}>
      <Text style={styles.editLabel}>{label}</Text>
      <Pressable style={styles.selectValue} onPress={onPress} testID={testID}>
        <Text style={styles.selectValueText}>{valueLabel}</Text>
        <Ionicons name={icon ?? "chevron-down"} size={16} color={colors.textSecondary} />
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
              <Text style={[styles.segmentText, on && styles.segmentTextActive]}>{o.label}</Text>
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
  options: { value: string; label: string }[];
  selected: string | null;
  onSelect: (v: string) => void;
  onClose: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView style={styles.optionScroll} keyboardShouldPersistTaps="handled">
            {options.map((o) => {
              const on = o.value === selected;
              return (
                <Pressable
                  key={o.value}
                  style={styles.optionRow}
                  onPress={() => onSelect(o.value)}
                  testID={`option-${o.value}`}
                >
                  <Text style={[styles.optionText, on && styles.optionTextActive]}>{o.label}</Text>
                  {on ? <Ionicons name="checkmark" size={18} color={colors.tint} /> : null}
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
  styles,
  colors,
}: {
  visible: boolean;
  title: string;
  value: string | null;
  onSelect: (v: string) => void;
  onClear?: () => void;
  onClose: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const p = parseYMD(value) ?? todayYMD();
    return { y: p.y, m: p.m };
  });

  useEffect(() => {
    if (visible) {
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{title}</Text>
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
                !!selected && selected.y === view.y && selected.m === view.m && selected.d === d;
              const isToday = today.y === view.y && today.m === view.m && today.d === d;
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
          <View style={styles.calFooter}>
            {onClear ? (
              <Pressable style={styles.sheetCancel} onPress={onClear} testID="cal-clear">
                <Text style={styles.sheetCancelText}>Clear</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <Pressable style={styles.sheetCancel} onPress={onClose}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function CaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [active, setActive] = useState<SectionKey>("overview");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const caseQuery = useCase(id);
  const c = (caseQuery.data ?? null) as unknown as DetailedCase | null;

  const attachmentsQuery = useCaseAttachments(id);
  const attachments = attachmentsQuery.data ?? [];

  const invoicesQuery = useInvoices({ caseId: id });
  const invoiceList = invoicesQuery.data ?? [];
  const primaryInvoiceId = invoiceList.length > 0 ? invoiceList[0].id : null;
  const invoiceQuery = useInvoice(primaryInvoiceId);
  const invoice = invoiceQuery.data ?? invoiceList[0] ?? null;

  const meQuery = useMe();
  const caseOrgId = c?.organizationId ?? c?.labOrganizationId ?? null;
  const canEdit = canEditOrg(meQuery.data, caseOrgId);

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
  // (root layout writes them to the inbox), offer to attach them to THIS case.
  // Confirming hands the entries to FilesSection's upload pipeline and clears
  // the inbox so the Cases-list "waiting to attach" banner resets.
  const [pendingShared, setPendingShared] = useState<InboxEntry[] | null>(null);
  const sharePromptOpenRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    async function checkInbox() {
      if (!canEdit || sharePromptOpenRef.current) return;
      const entries = await peekSharedFiles();
      if (cancelled || entries.length === 0 || sharePromptOpenRef.current) return;
      sharePromptOpenRef.current = true;
      Alert.alert(
        "Attach shared files?",
        `${entries.length} file${entries.length === 1 ? "" : "s"} shared with LabTrax. Attach ${
          entries.length === 1 ? "it" : "them"
        } to this case?`,
        [
          {
            text: "Not now",
            style: "cancel",
            onPress: () => {
              sharePromptOpenRef.current = false;
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
  }, [canEdit]);

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
  const highlightedTeeth = useMemo(() => buildHighlightedToothSet(rxSummary), [rxSummary]);

  const history = useMemo(() => {
    const merged: DetailEvent[] = [
      ...(c?.events ?? []),
      ...(c?.originalCaseEvents ?? []),
      ...(c?.remakeChildrenEvents ?? []),
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
  }, [c?.events, c?.originalCaseEvents, c?.remakeChildrenEvents]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as never);
  }

  // Open the native print dialog with a formatted case history document.
  async function handlePrintHistory() {
    if (!c) return;
    try {
      await printCaseHistory(c, history);
    } catch (e) {
      Alert.alert("Couldn't print history", errorMessage(e));
    }
  }

  // Render the case work-order card to a PDF and hand it to the OS share sheet.
  async function handlePrintCaseCard() {
    if (!c) return;
    try {
      const html = buildCaseCardHtml({
        caseNumber: c.caseNumber,
        patientName: patientName(c),
        doctorName: c.doctorName,
        dueDate: c.dueDate,
        expectedDeliveryDate: c.expectedDeliveryDate,
        priority: c.priority,
        status: c.status,
        rxNotes: c.caseNotes,
        restorations: c.restorations ?? [],
        labName,
      });
      const { uri } = await generatePdf(html);
      await sharePdf(uri, { dialogTitle: c.caseNumber ? `Case #${c.caseNumber}` : "Case" });
    } catch (e) {
      Alert.alert("Couldn't create PDF", errorMessage(e));
    }
  }

  function onRefresh() {
    caseQuery.refetch();
    attachmentsQuery.refetch();
    invoicesQuery.refetch();
    invoiceQuery.refetch();
  }

  const refreshing =
    caseQuery.isFetching || invoicesQuery.isFetching || attachmentsQuery.isFetching;

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
          <Ionicons name="alert-circle-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Unable to load this case</Text>
          <Text style={styles.emptyBody}>
            It may have been moved, or your session needs a refresh.
          </Text>
          <Pressable style={styles.retryBtn} onPress={() => caseQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Header
        title={c.caseNumber ? `#${c.caseNumber}` : "Case"}
        subtitle={patientName(c)}
        onBack={goBack}
        styles={styles}
        colors={colors}
        right={
          <View style={styles.headerRightGroup}>
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
            <StatusBadge label={titleCase(c.status ?? "—")} variant={statusVariant(c.status)} />
          </View>
        }
      />

      {/* Section switcher */}
      <View style={styles.tabsWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
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
              >
                <Ionicons
                  name={s.icon}
                  size={15}
                  color={on ? colors.textInverse : colors.textSecondary}
                />
                <Text style={[styles.tabLabel, on && styles.tabLabelActive]}>{s.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.tint} />
        }
      >
        {active === "overview" && (
          <OverviewSection
            c={c}
            caseId={c.id}
            canEdit={canEdit}
            labName={labName}
            onSaved={() => caseQuery.refetch()}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "restorations" && (
          <RestorationsSection
            restorations={c.restorations ?? []}
            highlighted={highlightedTeeth}
            teethLabel={formatRxTeethLabel(rxSummary)}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "notes" && (
          <NotesSection
            caseNotes={c.caseNotes}
            notes={c.notes ?? []}
            caseId={c.id}
            canEdit={canEdit}
            onSaved={() => caseQuery.refetch()}
            styles={styles}
            colors={colors}
          />
        )}

        {active === "files" && (
          <FilesSection
            caseId={c.id}
            attachments={attachments}
            loading={attachmentsQuery.isLoading}
            onOpenImage={setLightboxUrl}
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
            caseId={c.id}
            onOpenImage={setLightboxUrl}
            styles={styles}
            colors={colors}
          />
        )}
      </ScrollView>

      {/* Full-screen image viewer */}
      <Modal visible={!!lightboxUrl} transparent animationType="fade" onRequestClose={() => setLightboxUrl(null)}>
        <Pressable style={styles.lightbox} onPress={() => setLightboxUrl(null)}>
          {lightboxUrl ? (
            <AuthedImage
              url={lightboxUrl}
              style={styles.lightboxImage}
              contentFit="contain"
              testID="lightbox-image"
            />
          ) : null}
          <View style={[styles.lightboxClose, { top: insets.top + Spacing.md }]}>
            <Ionicons name="close" size={26} color="#FFFFFF" /* hex-allow: fixed-dark lightbox close icon */ />
          </View>
        </Pressable>
      </Modal>
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
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: React.ReactNode;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn} testID="case-back">
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <View style={styles.headerTitles}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────────
function FieldRow({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function OverviewSection({
  c,
  caseId,
  canEdit,
  labName,
  onSaved,
  styles,
  colors,
}: {
  c: DetailedCase;
  caseId: string;
  canEdit: boolean;
  labName: string | null;
  onSaved: () => void | Promise<unknown>;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<OverviewForm>(() => formFromCase(c));
  const [picker, setPicker] = useState<"dueDate" | "expectedDeliveryDate" | "locate" | null>(null);
  const update = useUpdateCase();

  // ── Locate Case ─────────────────────────────────────────────────────────────
  // Mirrors the desktop "Locate Case" control: pick a destination station, then
  // press "Locate" to move the case there. Location IS the canonical case status
  // (PATCH /cases/:id { status }) — the same field/endpoint the desktop writes.
  const [locateTarget, setLocateTarget] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);

  async function locate() {
    if (!locateTarget) return;
    setLocating(true);
    try {
      await update.mutateAsync({ caseId, data: { status: locateTarget as UpdateCaseInputStatus } });
      // Mirror desktop: locating to "complete" releases a held case-pan barcode.
      const released =
        locateTarget === "complete" && !!(c.casePanBarcode && c.casePanBarcode.trim());
      setLocateMsg(
        released ? "Case located successfully. Barcode released." : "Case located successfully.",
      );
      setLocateTarget(null);
      await onSaved();
      setTimeout(() => setLocateMsg(null), 3000);
    } catch (e) {
      Alert.alert("Couldn't locate case", errorMessage(e));
    } finally {
      setLocating(false);
    }
  }

  function startEdit() {
    setForm(formFromCase(c));
    setEditing(true);
  }

  function cancelEdit() {
    setPicker(null);
    setEditing(false);
  }

  async function save() {
    const payload = buildOverviewPayload(c, form);
    if (Object.keys(payload).length === 0) {
      cancelEdit();
      return;
    }
    try {
      await update.mutateAsync({ caseId, data: payload });
      await onSaved();
      setPicker(null);
      setEditing(false);
    } catch (e) {
      Alert.alert("Couldn't save changes", errorMessage(e));
    }
  }

  return (
    <View style={styles.sectionGap}>
      <Card>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardHeading, styles.cardHeadingFlush]}>Details</Text>
          {!editing ? (
            <Pressable style={styles.editBtn} onPress={startEdit} hitSlop={8} testID="overview-edit">
              <Ionicons name="create-outline" size={16} color={colors.tint} />
              <Text style={styles.editBtnText}>Edit</Text>
            </Pressable>
          ) : null}
        </View>

        {editing ? (
          <View>
            <EditTextRow
              label="Patient first name"
              value={form.patientFirstName}
              onChangeText={(t) => setForm((f) => ({ ...f, patientFirstName: t }))}
              styles={styles}
              colors={colors}
            />
            <EditTextRow
              label="Patient last name"
              value={form.patientLastName}
              onChangeText={(t) => setForm((f) => ({ ...f, patientLastName: t }))}
              styles={styles}
              colors={colors}
            />
            <EditTextRow
              label="Doctor"
              value={form.doctorName}
              onChangeText={(t) => setForm((f) => ({ ...f, doctorName: t }))}
              styles={styles}
              colors={colors}
            />
            <SegmentedRow
              label="Priority"
              options={PRIORITY_OPTIONS}
              value={form.priority}
              onChange={(v) => setForm((f) => ({ ...f, priority: v }))}
              styles={styles}
              testID="priority"
            />
            <SelectRow
              label="Due date"
              valueLabel={formatDateInput(form.dueDate)}
              icon="calendar-outline"
              onPress={() => setPicker("dueDate")}
              styles={styles}
              colors={colors}
              testID="select-due"
            />
            <SelectRow
              label="Expected delivery"
              valueLabel={formatDateInput(form.expectedDeliveryDate)}
              icon="calendar-outline"
              onPress={() => setPicker("expectedDeliveryDate")}
              styles={styles}
              colors={colors}
              testID="select-expected"
            />

            <View style={styles.editActions}>
              <Pressable
                style={styles.btnSecondary}
                onPress={cancelEdit}
                disabled={update.isPending}
                testID="overview-cancel"
              >
                <Text style={styles.btnSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.btnPrimary, update.isPending && styles.btnDisabled]}
                onPress={save}
                disabled={update.isPending}
                testID="overview-save"
              >
                {update.isPending ? (
                  <ActivityIndicator color={colors.textInverse} size="small" />
                ) : (
                  <Text style={styles.btnPrimaryText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <View>
            <FieldRow label="Patient" value={patientName(c)} styles={styles} />
            <FieldRow label="Doctor" value={c.doctorName || "—"} styles={styles} />
            <FieldRow label="Case #" value={c.caseNumber || "—"} styles={styles} />
            <FieldRow label="Status" value={titleCase(c.status ?? "—")} styles={styles} />
            <FieldRow label="Priority" value={c.priority ? titleCase(c.priority) : "Standard"} styles={styles} />
            <FieldRow label="Due" value={formatDate(c.dueDate)} styles={styles} />
            <FieldRow label="Expected delivery" value={formatDate(c.expectedDeliveryDate)} styles={styles} />
            {c.bridgeConnectors && c.bridgeConnectors.trim() ? (
              <FieldRow label="Bridge connectors" value={c.bridgeConnectors} styles={styles} />
            ) : null}
            <FieldRow label="Created" value={formatDate(c.createdAt)} styles={styles} />
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Pan Barcode</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: Spacing.xs, flexShrink: 1, justifyContent: "flex-end" }}>
                <Text style={[styles.fieldValue, { flexShrink: 1 }]} numberOfLines={1}>
                  {c.casePanBarcode && c.casePanBarcode.trim() ? c.casePanBarcode.trim() : "—"}
                </Text>
                {canEdit ? (
                  <Pressable
                    hitSlop={8}
                    testID="scan-barcode-btn"
                    onPress={() => {
                      clearAiReaderSession();
                      setAiReaderSession({
                        caseId,
                        caseNumber: c.caseNumber ?? null,
                        patientName: [c.patientFirstName, c.patientLastName]
                          .filter(Boolean)
                          .join(" ") || null,
                        doctorName: c.doctorName ?? null,
                        dueDate: c.dueDate ?? null,
                        labOrgId: c.labOrganizationId ?? c.organizationId ?? null,
                        labName: labName ?? null,
                      });
                      router.push("/ai-reader/barcode" as never);
                    }}
                  >
                    <Ionicons name="barcode-outline" size={20} color={colors.tint} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
        )}
      </Card>

      {canEdit && !editing ? (
        <Card>
          <Text style={styles.cardHeading}>Locate Case</Text>
          <Text style={styles.locateCurrent}>
            Currently at{" "}
            <Text style={styles.locateCurrentStrong}>{labelFor(STATUS_OPTIONS, c.status)}</Text>
          </Text>
          <SelectRow
            label="Move to station"
            valueLabel={locateTarget ? labelFor(STATUS_OPTIONS, locateTarget) : "Select station…"}
            onPress={() => setPicker("locate")}
            styles={styles}
            colors={colors}
            testID="locate-select"
          />
          <Pressable
            style={[
              styles.btnPrimary,
              styles.locateBtn,
              (!locateTarget || locating) && styles.btnDisabled,
            ]}
            onPress={locate}
            disabled={!locateTarget || locating}
            testID="locate-confirm"
          >
            {locating ? (
              <ActivityIndicator color={colors.textInverse} size="small" />
            ) : (
              <Text style={styles.btnPrimaryText}>Locate</Text>
            )}
          </Pressable>
          {locateMsg ? (
            <Text style={styles.locateSuccess} testID="locate-success">
              {locateMsg}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {c.remakeOriginal || (c.remakeChildren && c.remakeChildren.length > 0) ? (
        <Card>
          <Text style={styles.cardHeading}>Remake</Text>
          {c.remakeOriginal ? (
            <FieldRow label="Original" value={`#${c.remakeOriginal.caseNumber ?? "—"}`} styles={styles} />
          ) : null}
          {c.remakeChildren && c.remakeChildren.length > 0 ? (
            <FieldRow
              label="Remakes"
              value={c.remakeChildren.map((r) => `#${r.caseNumber ?? "—"}`).join(", ")}
              styles={styles}
            />
          ) : null}
          {c.remakeReason ? <FieldRow label="Reason" value={c.remakeReason} styles={styles} /> : null}
        </Card>
      ) : null}

      {c.caseNotes && c.caseNotes.trim() ? (
        <Card>
          <Text style={styles.cardHeading}>Rx instructions</Text>
          <Text style={styles.bodyText}>{c.caseNotes.trim()}</Text>
        </Card>
      ) : null}

      <OptionPickerModal
        visible={picker === "locate"}
        title="Locate Case"
        options={STATUS_OPTIONS.filter((s) => s.value !== (c.status ?? "").toLowerCase())}
        selected={locateTarget}
        onSelect={(v) => {
          setLocateTarget(v);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        styles={styles}
        colors={colors}
      />
      <DatePickerModal
        visible={picker === "dueDate"}
        title="Due date"
        value={form.dueDate}
        onSelect={(v) => {
          setForm((f) => ({ ...f, dueDate: v }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        styles={styles}
        colors={colors}
      />
      <DatePickerModal
        visible={picker === "expectedDeliveryDate"}
        title="Expected delivery"
        value={form.expectedDeliveryDate}
        onSelect={(v) => {
          setForm((f) => ({ ...f, expectedDeliveryDate: v }));
          setPicker(null);
        }}
        onClear={() => {
          setForm((f) => ({ ...f, expectedDeliveryDate: null }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

function RestorationsSection({
  restorations,
  highlighted,
  teethLabel,
  styles,
  colors,
}: {
  restorations: DetailRestoration[];
  highlighted: Set<string>;
  teethLabel: string;
  styles: Styles;
  colors: ThemeColors;
}) {
  if (restorations.length === 0) {
    return <EmptyState icon="construct-outline" text="No restorations on this case." styles={styles} colors={colors} />;
  }
  return (
    <View style={styles.sectionGap}>
      <Card>
        <Text style={styles.cardHeading}>Teeth</Text>
        <Text style={styles.teethLabel}>{teethLabel}</Text>
        <View style={styles.toothChartWrap}>
          <ReadOnlyToothChart highlighted={highlighted} />
        </View>
      </Card>

      {restorations.map((r, i) => (
        <Card key={r.id ?? `rest-${i}`}>
          <View style={styles.restHeaderRow}>
            <Text style={styles.cardHeading}>
              {r.restorationType ? titleCase(r.restorationType) : "Restoration"}
            </Text>
            {r.toothNumber ? (
              <View style={styles.toothPill}>
                <Text style={styles.toothPillText}>#{r.toothNumber}</Text>
              </View>
            ) : null}
          </View>
          {r.restorationSubtype ? (
            <FieldRow label="Subtype" value={titleCase(r.restorationSubtype)} styles={styles} />
          ) : null}
          {r.material ? <FieldRow label="Material" value={r.material} styles={styles} /> : null}
          {r.shade ? <FieldRow label="Shade" value={r.shade} styles={styles} /> : null}
          {typeof r.quantity === "number" ? (
            <FieldRow label="Quantity" value={String(r.quantity)} styles={styles} />
          ) : null}
          {r.notes && r.notes.trim() ? (
            <Text style={[styles.bodyText, { marginTop: Spacing.sm }]}>{r.notes.trim()}</Text>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function NotesSection({
  caseNotes,
  notes,
  caseId,
  canEdit,
  onSaved,
  styles,
  colors,
}: {
  caseNotes?: string | null;
  notes: DetailNote[];
  caseId: string;
  canEdit: boolean;
  onSaved: () => void | Promise<unknown>;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<AddCaseNoteInputVisibility>("internal_lab_only");
  const add = useAddCaseNote();
  const hasRx = !!(caseNotes && caseNotes.trim());
  const trimmed = text.trim();

  async function submit() {
    if (!trimmed) return;
    try {
      await add.mutateAsync({ caseId, data: { noteText: trimmed, visibility } });
      setText("");
      await onSaved();
    } catch (e) {
      Alert.alert("Couldn't add note", errorMessage(e));
    }
  }

  return (
    <View style={styles.sectionGap}>
      {canEdit ? (
        <Card>
          <Text style={styles.cardHeading}>Add a note</Text>
          <TextInput
            style={styles.noteInput}
            value={text}
            onChangeText={setText}
            placeholder="Write a note…"
            placeholderTextColor={colors.textTertiary}
            multiline
            textAlignVertical="top"
            testID="note-input"
          />
          <SegmentedRow
            label="Visibility"
            options={VISIBILITY_OPTIONS}
            value={visibility}
            onChange={(v) => setVisibility(v as AddCaseNoteInputVisibility)}
            styles={styles}
            testID="visibility"
          />
          <Pressable
            style={[styles.btnPrimary, styles.noteSubmit, (add.isPending || !trimmed) && styles.btnDisabled]}
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
            <Text style={styles.noteVisibility}>{titleCase(n.visibility)} only</Text>
          ) : null}
        </Card>
      ))}

      {!hasRx && notes.length === 0 ? (
        <Text style={styles.noteEmptyHint}>No notes yet. Add the first one above.</Text>
      ) : null}
    </View>
  );
}

const SHARED_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function deriveSharedFileMeta(url: string): { name: string; mimeType: string } {
  let path = url;
  try {
    path = decodeURIComponent(url.split("?")[0].split("#")[0]);
  } catch {
    path = url.split("?")[0];
  }
  const seg = path.split("/").filter(Boolean).pop() || `shared-${Date.now()}`;
  const ext = seg.includes(".") ? seg.split(".").pop()!.toLowerCase() : "";
  const mimeType = SHARED_MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { name: seg, mimeType };
}

function FilesSection({
  caseId,
  attachments,
  loading,
  onOpenImage,
  canEdit,
  onRefresh,
  pendingShared,
  onConsumedShared,
  styles,
  colors,
}: {
  caseId: string;
  attachments: { id: string; fileName?: string | null; fileType?: string | null; uploaderName?: string | null; createdAt?: string | null }[];
  loading: boolean;
  onOpenImage: (url: string) => void;
  canEdit: boolean;
  onRefresh: () => void;
  pendingShared: InboxEntry[] | null;
  onConsumedShared: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleteAttachment = useDeleteCaseAttachment();

  interface UploadJob {
    key: string;
    fileName: string;
    mimeType: string;
    fileUri: string;
    progress: number;
    status: "uploading" | "error" | "done";
    error?: string;
  }
  const [uploads, setUploads] = useState<UploadJob[]>([]);

  function updateJob(key: string, patch: Partial<UploadJob>) {
    setUploads((prev) => prev.map((j) => (j.key === key ? { ...j, ...patch } : j)));
  }

  async function runUpload(job: UploadJob) {
    updateJob(job.key, { status: "uploading", progress: 0, error: undefined });
    try {
      const result = await uploadCaseAttachment({
        caseId,
        fileUri: job.fileUri,
        fileName: job.fileName,
        mimeType: job.mimeType,
        onProgress: (f) => updateJob(job.key, { progress: f }),
      });
      if (result.ok) {
        updateJob(job.key, { status: "done", progress: 1 });
        onRefresh();
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

  function startJobs(files: { uri: string; name: string; mimeType: string }[]) {
    if (files.length === 0) return;
    const jobs: UploadJob[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      fileName: f.name,
      mimeType: f.mimeType,
      fileUri: f.uri,
      progress: 0,
      status: "uploading",
    }));
    setUploads((prev) => [...jobs, ...prev]);
    // Serial uploads: run one at a time to avoid mobile network/CPU contention
    // when several large photos are queued at once.
    void (async () => {
      for (const job of jobs) {
        await runUpload(job);
      }
    })();
  }

  async function pickFromCamera() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!(perm.granted || perm.status === "granted")) {
        Alert.alert("Camera permission needed", "Enable camera access in Settings to take photos.");
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 0.85, mediaTypes: ["images"] });
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

  async function pickFromLibrary() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!(perm.granted || perm.status === "granted")) {
        Alert.alert("Photo permission needed", "Enable photo library access in Settings to choose photos.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        quality: 0.85,
        allowsMultipleSelection: true,
        mediaTypes: ["images"],
      });
      if (res.canceled) return;
      startJobs(
        res.assets.map((a, i) => ({
          uri: a.uri,
          name: a.fileName || `photo-${Date.now()}-${i}.jpg`,
          mimeType: a.mimeType || "image/jpeg",
        })),
      );
    } catch (e) {
      Alert.alert("Couldn't open library", errorMessage(e));
    }
  }

  async function pickDocument() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (res.canceled) return;
      startJobs(
        res.assets.map((a, i) => ({
          uri: a.uri,
          name: a.name || `file-${Date.now()}-${i}`,
          mimeType: a.mimeType || "application/octet-stream",
        })),
      );
    } catch (e) {
      Alert.alert("Couldn't pick file", errorMessage(e));
    }
  }

  function openAddSheet() {
    Alert.alert("Add to case", undefined, [
      { text: "Take Photo", onPress: () => void pickFromCamera() },
      { text: "Choose from Library", onPress: () => void pickFromLibrary() },
      { text: "Attach File", onPress: () => void pickDocument() },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  // Consume files handed over by the share-intent prompt (parent peeks the inbox
  // and, on confirm, passes the popped entries here for upload via the same
  // pipeline as the manual Add button).
  useEffect(() => {
    if (!pendingShared || pendingShared.length === 0) return;
    startJobs(
      pendingShared.map((e) => {
        const meta = deriveSharedFileMeta(e.url);
        return { uri: e.url, name: meta.name, mimeType: meta.mimeType };
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
      },
      {
        onOpenImage,
        onError: (title, message) => Alert.alert(title, message),
        setBusy: (busy) => setOpeningId(busy ? a.id : null),
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
              await deleteAttachment.mutateAsync({ caseId, attachmentId: a.id });
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

  const images = attachments.filter((a) => isImageAttachment(a.fileType, a.fileName));
  const docs = attachments.filter((a) => !isImageAttachment(a.fileType, a.fileName));
  const isEmpty = attachments.length === 0 && uploads.length === 0;

  return (
    <View style={styles.sectionGap}>
      {canEdit ? (
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
          <Text style={{ ...Typography.bodySemibold, color: colors.tint }}>Add photo or file</Text>
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
              <Text style={{ ...Typography.caption, color: colors.text }} numberOfLines={1}>
                {job.fileName}
              </Text>
              {job.status === "error" ? (
                <Text style={{ ...Typography.caption, color: colors.error }} numberOfLines={2}>
                  {job.error || "Upload failed."}
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
                      backgroundColor: job.status === "done" ? colors.success : colors.tint,
                      width: `${pct}%`,
                    }}
                  />
                </View>
              )}
            </View>
            {job.status === "error" ? (
              <Pressable onPress={() => void runUpload(job)} hitSlop={8} testID={`upload-retry-${job.key}`}>
                <Ionicons name="refresh" size={18} color={colors.tint} />
              </Pressable>
            ) : job.status === "uploading" ? (
              <Text style={{ ...Typography.caption, color: colors.textTertiary }}>{pct}%</Text>
            ) : null}
          </View>
        );
      })}

      {isEmpty ? (
        <EmptyState icon="images-outline" text="No files on this case." styles={styles} colors={colors} />
      ) : null}

      {images.length > 0 ? (
        <View style={styles.imageGrid}>
          {images.map((a) => {
            const url = attachmentFileUrl(caseId, a.id);
            const isDeleting = deletingId === a.id;
            return (
              <Pressable
                key={a.id}
                style={styles.thumb}
                onPress={() => onOpenImage(url)}
                testID={`img-open-${a.id}`}
              >
                <AuthedImage url={url} style={styles.thumbImage} contentFit="cover" />
                {canEdit ? (
                  <Pressable
                    style={styles.thumbTrashBtn}
                    onPress={() => handleDeleteAttachment(a)}
                    hitSlop={4}
                    testID={`img-delete-${a.id}`}
                  >
                    {isDeleting ? (
                      <ActivityIndicator color="#fff" /* hex-allow: white spinner on photo thumbnail overlay */ size="small" />
                    ) : (
                      <Ionicons name="trash-outline" size={14} color="#fff" /* hex-allow: white icon on photo thumbnail overlay */ />
                    )}
                  </Pressable>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {docs.map((a) => {
        const opening = openingId === a.id;
        const isDeleting = deletingId === a.id;
        return (
          <Card key={a.id} onPress={() => handleOpenDoc(a)} testID={`doc-open-${a.id}`}>
            <View style={styles.docRow}>
              <Ionicons name="document-text-outline" size={22} color={colors.tint} />
              <View style={styles.docInfo}>
                <Text style={styles.docName} numberOfLines={1}>
                  {a.fileName || "File"}
                </Text>
                <Text style={styles.docMeta}>
                  {a.uploaderName ? `${a.uploaderName} · ` : ""}
                  {formatDate(a.createdAt)}
                </Text>
              </View>
              {isDeleting ? (
                <ActivityIndicator color={colors.warning} />
              ) : opening ? (
                <ActivityIndicator color={colors.tint} />
              ) : (
                <View style={styles.docActions}>
                  <Ionicons name="open-outline" size={18} color={colors.textTertiary} />
                  {canEdit ? (
                    <Pressable
                      onPress={() => handleDeleteAttachment(a)}
                      hitSlop={8}
                      testID={`doc-delete-${a.id}`}
                    >
                      <Ionicons name="trash-outline" size={18} color={colors.warning} />
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
  } | null;
  loading: boolean;
  canEdit: boolean;
  caseId: string;
  invoiceId: string | null;
  patientName?: string | null;
  caseNumber?: string | null;
  labName?: string | null;
  onRefresh: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  // ── State
  const [paySheet, setPaySheet] = useState(false);
  const [payForm, setPayForm] = useState<{ amount: string; method: string }>({
    amount: "",
    method: "check",
  });
  const [payMethodPicker, setPayMethodPicker] = useState(false);
  const [paymentPending, setPaymentPending] = useState(false);

  // ── Mutations
  const generateInvoice = useGenerateInvoiceForCase();
  const emailInvoice = useEmailInvoice();
  const anyPending = generateInvoice.isPending;
  const [sharing, setSharing] = useState(false);

  const lines: InvoiceLineItem[] = (invoice?.items ?? invoice?.lineItems ?? []) as InvoiceLineItem[];

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
        dialogTitle: invoice.invoiceNumber ? `Invoice #${invoice.invoiceNumber}` : "Invoice",
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
              const { base64 } = await generatePdf(buildInvoiceDoc(), { base64: true });
              if (!base64) throw new Error("Could not render the invoice PDF.");
              const label = invoice.invoiceNumber ?? caseNumber ?? "invoice";
              await emailInvoice.mutateAsync({
                invoiceId,
                data: {
                  subject: `Invoice ${invoice.invoiceNumber ?? ""}`.trim(),
                  message: `Please find attached invoice ${invoice.invoiceNumber ?? ""}.`.trim(),
                  filename: `Invoice-${label}.pdf`,
                  pdfBase64: base64,
                },
              });
              Alert.alert("Invoice sent", "The invoice was emailed to the practice's billing email.");
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
      onRefresh();
    } catch (e) {
      Alert.alert("Couldn't create invoice", errorMessage(e));
    }
  }

  async function savePayment() {
    if (!invoiceId) return;
    const amount = parseFloat(payForm.amount);
    if (!amount || amount <= 0) {
      Alert.alert("Invalid amount", "Enter a valid payment amount greater than zero.");
      return;
    }
    setPaymentPending(true);
    try {
      await resilientFetch(`/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, paymentMethod: payForm.method }),
      });
      setPaySheet(false);
      setPayForm({ amount: "", method: "check" });
      onRefresh();
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
            style={[styles.btnPrimary, generateInvoice.isPending && styles.btnDisabled]}
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

  const canPay = canEdit && invoice.status !== "paid" && invoice.status !== "void";

  return (
    <View style={styles.sectionGap}>
      {/* ── Invoice header card ── */}
      <Card>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardHeading, styles.cardHeadingFlush]}>
            {invoice.invoiceNumber ? `Invoice #${invoice.invoiceNumber}` : "Invoice"}
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
        <FieldRow label="Issued" value={formatDate(invoice.issuedAt)} styles={styles} />
        <FieldRow label="Due" value={formatDate(invoice.dueAt)} styles={styles} />
        <FieldRow label="Total" value={money(invoice.total)} styles={styles} />
        <FieldRow label="Balance" value={money(invoice.balanceDue)} styles={styles} />
        {canEdit && invoiceId ? (
          <View style={styles.invoiceActions}>
            <Pressable
              style={[styles.btnSecondary, styles.invoiceActionBtn]}
              onPress={() => router.push(`/invoice-editor/${invoiceId}` as never)}
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
            style={[styles.btnSecondary, styles.invoiceActionBtn, sharing && styles.btnDisabled]}
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
              style={[styles.btnSecondary, styles.invoiceActionBtn, emailInvoice.isPending && styles.btnDisabled]}
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
          <Text style={[styles.cardHeading, styles.cardHeadingFlush]}>Line items</Text>
        </View>
        {lines.length === 0 ? (
          <Text style={styles.noteEmptyHint}>No line items yet.</Text>
        ) : (
          lines.map((li) => (
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
            </View>
          ))
        )}
      </Card>

      {/* ── Record payment button ── */}
      {canPay ? (
        <Pressable
          style={[styles.btnPrimary, (anyPending || paymentPending) && styles.btnDisabled]}
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
        <Pressable style={styles.sheetBackdrop} onPress={() => setPaySheet(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>Record Payment</Text>
            <EditTextRow
              label="Amount ($)"
              value={payForm.amount}
              onChangeText={(t) => setPayForm((f) => ({ ...f, amount: t }))}
              styles={styles}
              colors={colors}
              autoCapitalize="none"
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
                style={[styles.btnPrimary, paymentPending && styles.btnDisabled]}
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
        onSelect={(v) => { setPayForm((f) => ({ ...f, method: v })); setPayMethodPicker(false); }}
        onClose={() => setPayMethodPicker(false)}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

function HistorySection({
  events,
  caseId,
  onOpenImage,
  styles,
  colors,
}: {
  events: DetailEvent[];
  caseId: string;
  onOpenImage: (url: string) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);

  if (events.length === 0) {
    return <EmptyState icon="time-outline" text="No history yet." styles={styles} colors={colors} />;
  }

  function openEventAttachment(
    ev: DetailEvent,
    att: NonNullable<ReturnType<typeof eventAttachment>>,
  ) {
    if (openingId) return;
    void openAttachmentPreview(
      { url: att.url, fileName: att.fileName, fileType: att.fileType },
      {
        onOpenImage,
        onError: (title, message) => Alert.alert(title, message),
        setBusy: (busy) => setOpeningId(busy ? ev.id : null),
      },
    );
  }

  return (
    <Card padding="none">
      {events.map((ev, i) => {
        const desc = eventDescription(ev);
        const actor = ev.actorName || ev.actorInitials;
        const att = eventAttachment(ev, caseId);
        const opening = openingId === ev.id;
        return (
          <View key={ev.id} style={[styles.eventRow, i > 0 && styles.eventDivider]}>
            <View style={styles.eventDot} />
            <View style={styles.eventBody}>
              <Text style={styles.eventTitle}>{formatEventType(ev.eventType)}</Text>
              {desc ? <Text style={styles.eventDesc}>{desc}</Text> : null}
              {att ? (
                att.isImage ? (
                  <Pressable
                    onPress={() => openEventAttachment(ev, att)}
                    style={styles.historyAttachThumb}
                    testID={`history-attachment-${ev.id}`}
                  >
                    <AuthedImage url={att.url} style={styles.thumbImage} contentFit="cover" />
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => openEventAttachment(ev, att)}
                    style={styles.historyAttachRow}
                    testID={`history-attachment-${ev.id}`}
                  >
                    {opening ? (
                      <ActivityIndicator color={colors.tint} size="small" />
                    ) : (
                      <Ionicons name="attach-outline" size={16} color={colors.tint} />
                    )}
                    <Text style={styles.historyAttachText} numberOfLines={1}>
                      {att.fileName || "Open file"}
                    </Text>
                  </Pressable>
                )
              ) : null}
              <Text style={styles.eventMeta}>
                {actor ? `${actor} · ` : ""}
                {formatDateTime(ev.occurredAt ?? ev.createdAt)}
              </Text>
            </View>
          </View>
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
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.md },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: { padding: Spacing.xs },
    headerTitles: { flex: 1 },
    headerTitle: { ...Typography.h2, color: c.text },
    headerSubtitle: { ...Typography.caption, color: c.textSecondary },
    headerRight: { marginLeft: Spacing.sm },
    tabsWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    tabsRow: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm, gap: Spacing.sm },
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
    cardHeading: { ...Typography.h3, color: c.text, marginBottom: Spacing.sm },
    bodyText: { ...Typography.body, color: c.text },
    fieldRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      paddingVertical: Spacing.xs + 2,
      gap: Spacing.md,
    },
    fieldLabel: { ...Typography.bodyMedium, color: c.textSecondary },
    fieldValue: { ...Typography.bodyMedium, color: c.text, flexShrink: 1, textAlign: "right" },
    teethLabel: { ...Typography.bodyMedium, color: c.tint, marginBottom: Spacing.md },
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
    noteMetaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: Spacing.xs },
    noteAuthor: { ...Typography.bodySemibold, color: c.text },
    noteDate: { ...Typography.caption, color: c.textTertiary },
    noteVisibility: { ...Typography.caption, color: c.warning, marginTop: Spacing.xs },
    imageGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    thumb: {
      width: "31%",
      aspectRatio: 1,
      borderRadius: Radius.md,
      overflow: "hidden",
      backgroundColor: c.surfaceAlt,
    },
    thumbImage: { width: "100%", height: "100%" },
    historyAttachThumb: {
      width: 72,
      height: 72,
      borderRadius: Radius.md,
      overflow: "hidden",
      marginTop: Spacing.xs,
      backgroundColor: c.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    historyAttachRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginTop: Spacing.xs,
    },
    historyAttachText: { ...Typography.caption, color: c.tint, flexShrink: 1 },
    docRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    docInfo: { flex: 1 },
    docName: { ...Typography.bodyMedium, color: c.text },
    docMeta: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
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
    eventDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    eventDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.tint, marginTop: 6 },
    eventBody: { flex: 1 },
    eventTitle: { ...Typography.bodySemibold, color: c.text },
    eventDesc: { ...Typography.body, color: c.textSecondary, marginTop: 2 },
    eventMeta: { ...Typography.caption, color: c.textTertiary, marginTop: 4 },
    emptyState: { alignItems: "center", justifyContent: "center", paddingVertical: Spacing.huge, gap: Spacing.md },
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
    cardHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.sm,
    },
    cardHeadingFlush: { marginBottom: 0 },
    editBtn: { flexDirection: "row", alignItems: "center", gap: 3, padding: Spacing.xs },
    editBtnText: { ...Typography.captionSemibold, color: c.tint },
    editRow: { paddingVertical: Spacing.xs + 2, gap: Spacing.xs },
    editLabel: { ...Typography.caption, color: c.textSecondary },
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
    segmentBtn: { flex: 1, alignItems: "center", paddingVertical: Spacing.sm, borderRadius: Radius.xs },
    segmentBtnActive: { backgroundColor: c.tint },
    segmentText: { ...Typography.captionMedium, color: c.textSecondary },
    segmentTextActive: { color: c.textInverse },
    editActions: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.md },
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
    headerRightGroup: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    headerIconBtn: { padding: Spacing.xs },
    locateCurrent: { ...Typography.body, color: c.textSecondary, marginBottom: Spacing.md },
    locateCurrentStrong: { ...Typography.bodySemibold, color: c.text },
    locateBtn: { flex: 0, alignSelf: "flex-start", paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
    locateSuccess: { ...Typography.captionSemibold, color: c.success, marginTop: Spacing.sm },
    invoiceActions: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.md },
    invoiceActionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.xs },
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
    sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
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
    calWeekday: { ...Typography.caption, color: c.textTertiary, width: `${100 / 7}%`, textAlign: "center" },
    calGrid: { flexDirection: "row", flexWrap: "wrap" },
    calCell: { width: `${100 / 7}%`, height: 42, alignItems: "center", justifyContent: "center" },
    calCellSelected: { backgroundColor: c.tint, borderRadius: Radius.full },
    calCellText: { ...Typography.body, color: c.text },
    calCellTextToday: { color: c.tint, fontFamily: "Inter_700Bold" },
    calCellTextSelected: { color: c.textInverse, fontFamily: "Inter_700Bold" },
    calFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: Spacing.sm },
    lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
    lightboxImage: { width: "100%", height: "80%" },
    lightboxClose: { position: "absolute", right: Spacing.lg },
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
    invHeaderRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    btnDanger: { borderColor: c.warning },
    btnDangerText: { color: c.warning },
  });
}
