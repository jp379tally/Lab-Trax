/**
 * Mobile provider-facing case detail screen.
 *
 * Fetches from GET /api/cases/provider/:caseId and renders the full provider
 * timeline — location, remake, photo, note, file, status, and payment entries —
 * with mobile-appropriate affordances for file attachments.
 *
 * Internal lab-only notes are excluded server-side and never reach this screen.
 * Matches the desktop ProviderCaseDetailModal reference implementation.
 */
import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { ZoomableAuthedImage } from "@/components/ui/ZoomableAuthedImage";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { VideoThumbnail } from "@/components/ui/VideoThumbnail";
import { acquireAuthedMediaUri } from "@/lib/authed-media-cache";
import {
  isInlinePlayableVideo,
  isVideoAsset,
} from "@/lib/video-asset";
import { getJson, sendJson, ApiError } from "@/lib/read-api";
import { getApiUrl, getAccessToken } from "@/lib/query-client";
import {
  createProviderCheckout,
  providerBillingReturnUrl,
  prepareProviderCheckoutAttempt,
  savePendingProviderCheckout,
} from "@/lib/provider-billing";
import {
  openAttachmentPreview,
  isImageAttachment,
} from "@/lib/attachment-preview";
import { confirmSaveAttachment } from "@/lib/save-attachment-prompt";
import { useLongPressGuard } from "@/lib/use-long-press-guard";

// ─── API types ────────────────────────────────────────────────────────────────

type TimelineEntryType =
  | "location"
  | "remake"
  | "photo"
  | "note"
  | "file"
  | "status"
  | "payment";

interface ProviderTimelineEntry {
  type: TimelineEntryType;
  id: string;
  label: string;
  timestamp: string;
  attachmentId?: string;
  fileName?: string;
  fileType?: string;
  author?: string | null;
  /** Status entries only — the status the case moved away from. */
  fromStatus?: string | null;
  /**
   * Status entries only — true when the case came back into the lab
   * (a completion-family status directly followed by an intake-family one).
   * Computed server-side so the lab and provider views flag the same moments.
   */
  isCaseReturn?: boolean;
}

interface ProviderInvoiceLine {
  description: string;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
}

/** Provider-safe prescription row — clinical fields only, never pricing. */
interface ProviderRxRestoration {
  id?: string;
  toothNumber?: string | null;
  restorationType?: string | null;
  restorationSubtype?: string | null;
  material?: string | null;
  shade?: string | null;
}

interface ProviderCaseDetail {
  id: string;
  caseNumber?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  caseType?: string | null;
  doctorName?: string | null;
  practiceName?: string | null;
  restorationTypes?: string | null;
  restorations?: ProviderRxRestoration[];
  step?: string | null;
  rxNotes?: string | null;
  notes?: Array<{
    id?: string;
    noteText: string;
    visibility?: string | null;
    createdAt?: string | null;
  }>;
  timeline?: ProviderTimelineEntry[];
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  invoiceLines?: ProviderInvoiceLine[];
  invoiceTotal?: string | null;
  invoiceBalanceDue?: string | null;
  invoiceStatus?: string | null;
  viewerCanPostNotes?: boolean;
  viewerQuickReferenceOrganizationId?: string | null;
}

interface QuickReferenceNote {
  id: string;
  body: string;
  label: string | null;
  isActive: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function patientName(c: Pick<ProviderCaseDetail, "patientFirstName" | "patientLastName">): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

const REMOVABLE_STEP_LABELS: Record<string, string> = {
  custom_tray: "Custom Tray",
  rims_and_plates: "Rims and Plates",
  wax_setup: "Wax Setup",
  process: "Process",
};

function stepLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return REMOVABLE_STEP_LABELS[value] ?? titleCase(value);
}

function isRemovableCase(detail: Pick<ProviderCaseDetail, "caseType" | "restorations">): boolean {
  const values = [
    detail.caseType,
    ...(detail.restorations ?? []).flatMap((row) => [
      row.restorationType,
      row.restorationSubtype,
    ]),
  ];
  return values.some((value) =>
    /(removable|denture|partial|flipper|valplast|flexible)/i.test(value ?? ""),
  );
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${mm}/${dd}/${d.getFullYear()} ${time}`;
}

function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toFixed(2)}`;
}

function invoiceVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("paid")) return "paid";
  if (s.includes("overdue")) return "overdue";
  if (s.includes("void") || s.includes("cancel")) return "void";
  return "open";
}

// Build the canonical attachment serving URL for a case attachment.
// Providers reach this URL through the standard case-attachment route — the
// server gates on visibility=shared_with_provider for provider callers.
function attachmentUrl(caseId: string, attachmentId: string): string {
  return `/api/cases/${caseId}/attachments/${attachmentId}/file`;
}

function AuthedProviderVideo({
  url,
  fileName,
  fileType,
  style,
  onPlaybackError,
}: {
  url: string;
  fileName?: string | null;
  fileType?: string | null;
  style: React.ComponentProps<typeof Video>["style"];
  onPlaybackError: () => void;
}) {
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let release = () => {};
    setLocalUri(null);
    acquireAuthedMediaUri(url, undefined, fileName, fileType)
      .then((acquired) => {
        if (cancelled) {
          acquired?.release();
          return;
        }
        if (!acquired) {
          onPlaybackError();
          return;
        }
        release = acquired.release;
        setLocalUri(acquired.uri);
      })
      .catch(onPlaybackError);
    return () => {
      cancelled = true;
      release();
    };
  }, [url, fileName, fileType, onPlaybackError]);

  if (!localUri) {
    return <ActivityIndicator color="#fff" testID="provider-video-loading" />;
  }
  return (
    <Video
      source={{ uri: localUri }}
      style={style}
      useNativeControls
      shouldPlay={false}
      resizeMode={ResizeMode.CONTAIN}
      onError={onPlaybackError}
      testID="provider-lightbox-video"
    />
  );
}

// Icon names per timeline entry type
function timelineIcon(
  type: TimelineEntryType,
): React.ComponentProps<typeof Ionicons>["name"] {
  switch (type) {
    case "location": return "pin-outline";
    case "remake":   return "refresh-outline";
    case "photo":    return "image-outline";
    case "note":     return "chatbox-outline";
    case "file":     return "attach-outline";
    case "status":   return "arrow-forward-circle-outline";
    case "payment":  return "cash-outline";
    default:         return "ellipse-outline";
  }
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function ProviderCaseDetailScreen() {
  // `invoice=1` means the caller (the portal's open-cases list) wants the
  // case's invoice, not the case body, so the modal opens with the screen.
  const { id, invoice } = useLocalSearchParams<{ id: string; invoice?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const queryClient = useQueryClient();

  // Lightbox: URL of the image being shown full-screen, null = closed
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [videoEntry, setVideoEntry] = useState<ProviderTimelineEntry | null>(null);
  const [videoPlaybackFailed, setVideoPlaybackFailed] = useState(false);
  const { markLongPress: markLightboxLongPress, consumeLongPress: consumeLightboxLongPress } =
    useLongPressGuard();
  const { markLongPress: markPhotoLongPress, consumeLongPress: consumePhotoLongPress } =
    useLongPressGuard<string>();
  const { markLongPress: markFileLongPress, consumeLongPress: consumeFileLongPress } =
    useLongPressGuard<string>();

  // Note composer
  const [noteText, setNoteText] = useState("");
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [quickReferenceOpen, setQuickReferenceOpen] = useState(false);

  // File attachment
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Per-entry busy state for file open/share spinner
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // Provider-safe prescription (Rx) modal, opened from a returned-case entry
  const [rxVisible, setRxVisible] = useState(false);
  const [invoiceVisible, setInvoiceVisible] = useState(invoice === "1");

  // ── Data fetch ──────────────────────────────────────────────────────────────
  const caseQuery = useQuery<ProviderCaseDetail | null>({
    queryKey: ["provider-case", id ?? ""],
    queryFn: async () => {
      if (!id) return null;
      return getJson<ProviderCaseDetail>(`/api/cases/provider/${encodeURIComponent(id)}`);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
  });

  const c = caseQuery.data ?? null;
  const quickReferenceQuery = useQuery<QuickReferenceNote[]>({
    queryKey: ["quick-reference-notes", c?.viewerQuickReferenceOrganizationId],
    enabled: Boolean(c?.viewerCanPostNotes && c.viewerQuickReferenceOrganizationId),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const organizationId = c?.viewerQuickReferenceOrganizationId;
      if (!organizationId) return [];
      const response = await getJson<{ notes: QuickReferenceNote[] }>(
        `/api/organizations/${encodeURIComponent(organizationId)}/quick-reference-notes`,
      );
      return (response.notes ?? []).filter((note) => note.isActive);
    },
  });
  const quickReferenceNotes = quickReferenceQuery.data ?? [];

  function insertQuickReferenceNote(body: string) {
    setNoteText((current) => (current.trim() ? `${current}\n${body}` : body));
    setQuickReferenceOpen(false);
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)" as never);
  }

  // ── Submit a note ───────────────────────────────────────────────────────────
  async function handleSendNote() {
    const text = noteText.trim();
    if (!text || noteSubmitting || !id) return;
    setNoteSubmitting(true);
    try {
      await sendJson("POST", `/api/cases/provider/${encodeURIComponent(id)}/notes`, {
        noteText: text,
      });
      setNoteText("");
      // Refresh timeline
      void queryClient.invalidateQueries({ queryKey: ["provider-case", id] });
    } catch (e) {
      Alert.alert(
        "Couldn't send note",
        e instanceof Error ? e.message : "Please try again.",
      );
    } finally {
      setNoteSubmitting(false);
    }
  }

  async function handlePayCaseInvoice() {
    if (!c?.invoiceId || paymentSubmitting) return;
    setPaymentSubmitting(true);
    setPaymentError(null);
    try {
      const attempt = await prepareProviderCheckoutAttempt({
        mode: "case-invoice",
        invoiceIds: [c.invoiceId],
      });
      const checkout = await createProviderCheckout({
        invoiceIds: [c.invoiceId],
        idempotencyKey: attempt.idempotencyKey,
        savePaymentMethod: false,
        successUrl: providerBillingReturnUrl(),
        cancelUrl: providerBillingReturnUrl(true),
      });
      if (!checkout.url) throw new Error("Secure checkout did not return a browser link.");
      await savePendingProviderCheckout({
        checkoutId: checkout.checkoutId,
        idempotencyKey: attempt.idempotencyKey,
        mode: "case-invoice",
        invoiceIds: [c.invoiceId],
      });
      const supported = await Linking.canOpenURL(checkout.url);
      if (!supported) throw new Error("Your device cannot open the secure checkout page.");
      await Linking.openURL(checkout.url);
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : "Could not start payment.");
    } finally {
      setPaymentSubmitting(false);
    }
  }

  // ── Attach a file ───────────────────────────────────────────────────────────
  async function handleAttachFile() {
    if (!id) return;
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        type: [
          "image/*",
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/plain",
          "text/csv",
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch {
      return;
    }

    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    if (!asset) return;

    setUploadState("uploading");
    setUploadError(null);

    // XHR with multipart/form-data — expo/fetch rejects native file FormData
    // parts, so XHR is required here (mirrors the desktop upload pattern).
    const token = getAccessToken();
    const uploadUrl = new URL(
      `/api/cases/provider/${encodeURIComponent(id)}/attachments`,
      getApiUrl(),
    ).href;

    const formData = new FormData();
    // React Native XHR accepts { uri, name, type } as a FormData file part
    formData.append("file", {
      uri: asset.uri,
      name: asset.name ?? "attachment",
      type: asset.mimeType ?? "application/octet-stream",
    } as unknown as Blob);

    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", uploadUrl);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadState("done");
          setTimeout(() => setUploadState("idle"), 3000);
          void queryClient.invalidateQueries({ queryKey: ["provider-case", id] });
        } else {
          let msg = "Upload failed.";
          try {
            const body = JSON.parse(xhr.responseText) as Record<string, unknown>;
            if (typeof body?.message === "string") msg = body.message;
          } catch { /* ignore */ }
          setUploadState("error");
          setUploadError(msg);
        }
        resolve();
      };
      xhr.onerror = () => {
        setUploadState("error");
        setUploadError("Network error during upload.");
        resolve();
      };
      xhr.send(formData);
    });
  }

  // ── Open a timeline attachment (photo/file) ─────────────────────────────────
  async function handleOpenEntry(entry: ProviderTimelineEntry) {
    if (!entry.attachmentId || !id || openingId) return;
    const url = attachmentUrl(id, entry.attachmentId);

    if (isImageAttachment(entry.fileType, entry.fileName)) {
      setLightboxUrl(url);
      return;
    }
    if (isVideoAsset({ mimeType: entry.fileType, fileName: entry.fileName })) {
      setVideoPlaybackFailed(false);
      setVideoEntry(entry);
      return;
    }

    setOpeningId(entry.id);
    try {
      await openAttachmentPreview(
        { url, fileName: entry.fileName, fileType: entry.fileType },
        {
          onOpenImage: (u) => setLightboxUrl(u),
          onError: (title, message) => Alert.alert(title, message),
          setBusy: (busy) => {
            if (!busy) setOpeningId(null);
          },
        },
      );
    } finally {
      setOpeningId(null);
    }
  }

  // ── Loading / error states ──────────────────────────────────────────────────
  if (caseQuery.isLoading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (caseQuery.isError || !c) {
    const isForbidden =
      caseQuery.error instanceof ApiError &&
      (caseQuery.error.status === 403 || caseQuery.error.status === 401);
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={goBack} hitSlop={8} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Case Detail</Text>
        </View>
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>
            {isForbidden ? "Not available" : "Unable to load case"}
          </Text>
          <Text style={styles.emptyBody}>
            {isForbidden
              ? "You don't have access to this case."
              : "Something went wrong. Please try again."}
          </Text>
          {!isForbidden && (
            <Pressable style={styles.retryBtn} onPress={() => caseQuery.refetch()}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  const hasInvoice = Boolean(c.invoiceId);
  const timeline = c.timeline ?? [];

  return (
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: insets.top }]}
      testID="provider-case-keyboard-dismiss"
    >
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={goBack} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {c.caseNumber ? `Case #${c.caseNumber}` : "Case Detail"}
          </Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {patientName(c)}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        refreshControl={
          <RefreshControl
            refreshing={caseQuery.isFetching}
            onRefresh={() => caseQuery.refetch()}
            tintColor={colors.tint}
          />
        }
      >
        {/* ── Case info ── */}
        <Card style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Patient</Text>
            <Text style={styles.infoValue}>{patientName(c)}</Text>
          </View>
          {!!c.caseType && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Case Type</Text>
              <Text style={styles.infoValue}>{c.caseType}</Text>
            </View>
          )}
          {!!c.restorationTypes && !(c.restorations?.length) && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Restorations</Text>
              <Text style={styles.infoValue}>{c.restorationTypes}</Text>
            </View>
          )}
          <View style={styles.restorationSummary}>
            <Text style={styles.infoLabel}>Restorations</Text>
            {(c.restorations?.length ?? 0) === 0 ? (
              <Text style={styles.infoValueMuted}>No restorations on this case.</Text>
            ) : (
              <View style={styles.restorationList}>
                {c.restorations!.map((restoration, index) => (
                  <View
                    key={restoration.id ?? index}
                    style={[
                      styles.restorationRow,
                      index < c.restorations!.length - 1 && styles.restorationRowBorder,
                    ]}
                    testID={`provider-restoration-${restoration.id ?? index}`}
                  >
                    <View style={styles.restorationPrimary}>
                      <Text style={styles.restorationTooth}>
                        {`Tooth ${restoration.toothNumber || "—"}`}
                      </Text>
                      <Text style={styles.restorationType}>
                        {[
                          restoration.restorationType,
                          restoration.restorationSubtype,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Type unavailable"}
                      </Text>
                    </View>
                    <Text style={styles.restorationMaterial}>
                      {restoration.material || "Material unavailable"}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
          {isRemovableCase(c) && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Current Step</Text>
              <Text style={styles.infoValue}>{stepLabel(c.step)}</Text>
            </View>
          )}
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Lab Notes</Text>
            {(c.notes?.filter(
              (note) =>
                note.visibility === "shared_with_provider" && note.noteText.trim(),
            ).length ?? 0) > 0 ? (
              c.notes!
                .filter(
                  (note) =>
                    note.visibility === "shared_with_provider" &&
                    note.noteText.trim(),
                )
                .map((note, index) => (
                  <Text
                    key={note.id ?? index}
                    style={[styles.infoValue, styles.labNotes]}
                  >
                    {note.noteText}
                  </Text>
                ))
            ) : (
              <Text style={styles.infoValueMuted}>No lab notes for this case.</Text>
            )}
          </View>
        </Card>

        {/* ── Invoice panel ── */}
        {hasInvoice && (
          <>
            <Pressable
              style={styles.invoiceToggle}
              onPress={() => setInvoiceVisible((visible) => !visible)}
              testID="provider-view-invoice"
              accessibilityRole="button"
              accessibilityState={{ expanded: invoiceVisible }}
            >
              <View>
                <Text style={styles.invoiceToggleTitle}>
                  {invoiceVisible ? "Hide Invoice" : "View Invoice"}
                </Text>
                {c.invoiceNumber ? (
                  <Text style={styles.invoiceToggleSubtitle}>{c.invoiceNumber}</Text>
                ) : null}
              </View>
              <Ionicons
                name={invoiceVisible ? "chevron-up" : "chevron-down"}
                size={18}
                color={colors.tint}
              />
            </Pressable>
            {invoiceVisible && (
              <Card style={styles.invoiceCard} testID="provider-invoice">
                <View style={styles.invoiceHeader}>
                  <Text style={styles.sectionTitle}>Invoice</Text>
                  {c.invoiceStatus && (
                    <StatusBadge
                      label={titleCase(c.invoiceStatus)}
                      variant={invoiceVariant(c.invoiceStatus)}
                      size="sm"
                    />
                  )}
                </View>
                {(c.invoiceLines?.length ?? 0) === 0 ? (
                  <Text style={styles.infoValueMuted}>No line items on this invoice.</Text>
                ) : (
                  c.invoiceLines!.map((line, i) => (
                    <View
                      key={i}
                      style={[
                        styles.invoiceLine,
                        i < c.invoiceLines!.length - 1 && styles.invoiceLineBorder,
                      ]}
                    >
                      <View style={styles.invoiceDescriptionBlock}>
                        <Text style={styles.invoiceDesc} numberOfLines={2}>
                          {line.description}
                        </Text>
                        <Text style={styles.invoiceQty}>{`Qty ${line.quantity}`}</Text>
                      </View>
                      <View style={styles.invoicePriceBlock}>
                        <Text style={styles.invoiceUnitPrice}>
                          {`Unit ${money(line.unitPrice)}`}
                        </Text>
                        <Text style={styles.invoiceAmount}>
                          {money(line.totalPrice)}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
                <View style={styles.invoiceTotal}>
                  <Text style={styles.invoiceTotalLabel}>Invoice total</Text>
                  <Text style={styles.invoiceTotalAmount}>{money(c.invoiceTotal)}</Text>
                </View>
                {c.invoiceId && c.invoiceBalanceDue && Number(c.invoiceBalanceDue) > 0 && (
                  <>
                    <Pressable
                      style={[styles.sendBtn, paymentSubmitting && styles.sendBtnDisabled]}
                      onPress={() => void handlePayCaseInvoice()}
                      disabled={paymentSubmitting}
                      testID="provider-case-pay-invoice"
                    >
                      {paymentSubmitting ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Ionicons name="lock-closed-outline" size={16} color="#fff" />
                      )}
                      <Text style={styles.sendBtnText}>
                        {paymentSubmitting ? "Opening secure checkout…" : `Pay ${money(c.invoiceBalanceDue)} securely`}
                      </Text>
                    </Pressable>
                    {paymentError && (
                      <Text style={styles.uploadError} testID="provider-case-payment-error">
                        {paymentError}
                      </Text>
                    )}
                  </>
                )}
              </Card>
            )}
          </>
        )}

        {/* ── Timeline ── */}
        <Text style={styles.sectionHeading}>Timeline</Text>
        {timeline.length === 0 ? (
          <Card style={styles.emptyTimelineCard}>
            <Ionicons name="time-outline" size={24} color={colors.textTertiary} />
            <Text style={styles.emptyTimelineText}>No timeline events yet.</Text>
          </Card>
        ) : (
          <Card padding="none">
            {timeline.map((entry, i) => {
              const isLast = i === timeline.length - 1;
              const isBusy = openingId === entry.id;
              const hasAttachment = !!entry.attachmentId;
              const isPhoto =
                entry.type === "photo" ||
                (entry.type === "file" && isImageAttachment(entry.fileType, entry.fileName));
              const isVideo =
                hasAttachment &&
                isVideoAsset({ mimeType: entry.fileType, fileName: entry.fileName });

              return (
                <View
                  key={entry.id}
                  style={[styles.timelineRow, !isLast && styles.timelineDivider]}
                >
                  {/* Icon dot */}
                  <View style={styles.timelineDot}>
                    <Ionicons
                      name={timelineIcon(entry.type)}
                      size={14}
                      color={colors.tint}
                    />
                  </View>

                  {/* Content */}
                  <View style={styles.timelineContent}>
                    {/* Photo thumbnail */}
                    {(entry.type === "photo" || isVideo) && hasAttachment && id && (
                      <Pressable
                        onPress={() => {
                          if (consumePhotoLongPress(entry.id)) return;
                          handleOpenEntry(entry);
                        }}
                        onLongPress={() => {
                          markPhotoLongPress(entry.id);
                          confirmSaveAttachment({
                            kind: isVideo ? "document" : "image",
                            url: attachmentUrl(id, entry.attachmentId!),
                            ...(isVideo
                              ? { fileName: entry.fileName, fileType: entry.fileType }
                              : {}),
                          });
                        }}
                        style={styles.photoThumb}
                        testID={`provider-timeline-${isVideo ? "video" : "photo"}-${entry.id}`}
                      >
                        {isVideo ? (
                          <VideoThumbnail
                            url={attachmentUrl(id, entry.attachmentId!)}
                            tintColor={colors.tint}
                            fallbackColor={colors.surfaceSecondary}
                          />
                        ) : (
                          <AuthedImage
                            url={attachmentUrl(id, entry.attachmentId!)}
                            style={styles.thumbImage}
                            contentFit="cover"
                          />
                        )}
                      </Pressable>
                    )}

                    {/* Note body */}
                    {entry.type === "note" && (
                      <View style={styles.noteBox}>
                        <Text style={styles.noteText}>{entry.label}</Text>
                      </View>
                    )}

                    {/* Status change */}
                    {entry.type === "status" && (
                      <>
                        <Text style={styles.timelineTitle}>
                          Status:{" "}
                          <Text style={styles.statusValue}>
                            {entry.label.replace(/_/g, " ")}
                          </Text>
                        </Text>
                        {entry.isCaseReturn && (
                          <View style={styles.returnRow}>
                            <Text style={styles.returnBadge}>Case returned</Text>
                            <Pressable
                              onPress={() => setRxVisible(true)}
                              style={styles.viewRxBtn}
                              testID={`provider-timeline-view-rx-${entry.id}`}
                            >
                              <Text style={styles.viewRxBtnText}>View Rx</Text>
                            </Pressable>
                          </View>
                        )}
                      </>
                    )}

                    {/* Payment */}
                    {entry.type === "payment" && (
                      <Text style={styles.timelineTitle}>
                        Payment received — {entry.label}
                      </Text>
                    )}

                    {/* Non-image file attachment */}
                    {entry.type === "file" && !isPhoto && !isVideo && hasAttachment && id && (
                      <Pressable
                        onPress={() => {
                          if (consumeFileLongPress(entry.id)) return;
                          handleOpenEntry(entry);
                        }}
                        onLongPress={() => {
                          markFileLongPress(entry.id);
                          confirmSaveAttachment({
                            kind: "document",
                            url: attachmentUrl(id, entry.attachmentId!),
                            fileName: entry.fileName,
                            fileType: entry.fileType,
                          });
                        }}
                        style={styles.fileRow}
                        testID={`provider-timeline-file-${entry.id}`}
                      >
                        {isBusy ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.tint}
                            testID={`provider-timeline-file-busy-${entry.id}`}
                          />
                        ) : (
                          <Ionicons name="attach-outline" size={16} color={colors.tint} />
                        )}
                        <Text style={styles.fileName} numberOfLines={1}>
                          {entry.fileName || "Open file"}
                        </Text>
                      </Pressable>
                    )}

                    {/* Location / remake / fallback label */}
                    {(entry.type === "location" ||
                      entry.type === "remake" ||
                      (entry.type === "file" && (isPhoto || isVideo) && hasAttachment && id) ||
                      (!["photo", "note", "status", "payment", "file"].includes(entry.type))) && (
                      <Text style={styles.timelineTitle}>{entry.label}</Text>
                    )}

                    {/* Metadata line: author · timestamp */}
                    <Text style={styles.timelineMeta}>
                      {entry.author ? `${entry.author} · ` : ""}
                      {formatDateTime(entry.timestamp)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>
        )}

        {/* ── Send a note ── */}
        <Text style={styles.sectionHeading}>Send a Note to the Lab</Text>
        <Card style={styles.noteComposer}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <TextInput
              style={styles.noteInput}
              value={noteText}
              onChangeText={setNoteText}
              autoCorrect={true}
              spellCheck={true}
              autoCapitalize="sentences"
              placeholder="Type your message here…"
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={3}
              editable={!noteSubmitting}
              testID="provider-note-input"
            />
            {quickReferenceQuery.isError ? (
              <Text style={styles.quickReferenceError}>
                Couldn't load quick reference notes.
              </Text>
            ) : quickReferenceNotes.length > 0 ? (
              <View>
                <Pressable
                  onPress={() => setQuickReferenceOpen((open) => !open)}
                  style={styles.quickReferenceButton}
                  testID="provider-quick-reference-toggle"
                >
                  <Ionicons name="bookmark-outline" size={15} color={colors.textSecondary} />
                  <Text style={styles.quickReferenceButtonText}>Add quick reference note</Text>
                </Pressable>
                {quickReferenceOpen ? (
                  <View style={styles.quickReferenceList}>
                    {quickReferenceNotes.map((template) => (
                      <Pressable
                        key={template.id}
                        onPress={() => insertQuickReferenceNote(template.body)}
                        style={styles.quickReferenceItem}
                        testID={`provider-quick-reference-${template.id}`}
                      >
                        {template.label ? (
                          <Text style={styles.quickReferenceLabel}>{template.label}</Text>
                        ) : null}
                        <Text style={styles.quickReferenceBody} numberOfLines={2}>
                          {template.body}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
            <Pressable
              style={[
                styles.sendBtn,
                (!noteText.trim() || noteSubmitting) && styles.sendBtnDisabled,
              ]}
              onPress={handleSendNote}
              disabled={!noteText.trim() || noteSubmitting}
              testID="provider-note-send"
            >
              {noteSubmitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.sendBtnText}>Send Note</Text>
              )}
            </Pressable>
          </KeyboardAvoidingView>
        </Card>

        {/* ── Attach a file ── */}
        <Text style={styles.sectionHeading}>Attach a File</Text>
        <Card style={styles.attachCard}>
          <Pressable
            style={[
              styles.attachBtn,
              uploadState === "uploading" && styles.attachBtnDisabled,
            ]}
            onPress={handleAttachFile}
            disabled={uploadState === "uploading"}
            testID="provider-attach-file"
          >
            {uploadState === "uploading" ? (
              <ActivityIndicator size="small" color={colors.tint} />
            ) : (
              <Ionicons name="cloud-upload-outline" size={18} color={colors.tint} />
            )}
            <Text style={[styles.attachBtnText, { color: colors.tint }]}>
              {uploadState === "uploading" ? "Uploading…" : "Choose file to attach"}
            </Text>
          </Pressable>

          {uploadState === "done" && (
            <Text style={styles.uploadSuccess}>File attached successfully.</Text>
          )}
          {uploadState === "error" && uploadError && (
            <Text style={styles.uploadError}>{uploadError}</Text>
          )}
        </Card>

        <View style={{ height: Spacing.xl }} />
      </ScrollView>

      {/* Provider-safe prescription view (opened from a returned-case entry).
          Mounted only while open so the sheet is genuinely absent from the
          tree when closed. */}
      {rxVisible && (
      <Modal
        visible={rxVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRxVisible(false)}
      >
        <View style={styles.rxBackdrop} testID="provider-rx-modal">
          <View style={styles.rxSheet}>
            <View style={styles.rxHeader}>
              <Text style={styles.rxTitle}>Prescription</Text>
              <Pressable
                onPress={() => setRxVisible(false)}
                hitSlop={12}
                testID="provider-rx-close"
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.rxBody}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
            >
              <View style={styles.rxRow}>
                <Text style={styles.rxLabel}>Case</Text>
                <Text style={styles.rxValue}>{c.caseNumber || "—"}</Text>
              </View>
              <View style={styles.rxRow}>
                <Text style={styles.rxLabel}>Patient</Text>
                <Text style={styles.rxValue}>{patientName(c)}</Text>
              </View>
              <View style={styles.rxRow}>
                <Text style={styles.rxLabel}>Doctor</Text>
                <Text style={styles.rxValue}>{c.doctorName || "—"}</Text>
              </View>
              <View style={styles.rxRow}>
                <Text style={styles.rxLabel}>Practice</Text>
                <Text style={styles.rxValue}>{c.practiceName || "—"}</Text>
              </View>

              <Text style={styles.rxSectionTitle}>Restorations</Text>
              {(c.restorations?.length ?? 0) === 0 ? (
                <Text style={styles.rxEmpty}>No restorations on this prescription.</Text>
              ) : (
                c.restorations!.map((r, i) => (
                  <View key={r.id ?? i} style={styles.rxRestoration}>
                    <Text style={styles.rxRestorationTitle}>
                      {`Tooth ${r.toothNumber || "—"} · ${r.restorationType || "—"}`}
                    </Text>
                    <Text style={styles.rxRestorationMeta}>
                      {`Material: ${r.material || "—"} · Shade: ${r.shade || "—"}`}
                    </Text>
                  </View>
                ))
              )}

              <Text style={styles.rxSectionTitle}>Prescription Notes</Text>
              {c.rxNotes ? (
                <Text style={styles.rxNotes}>{c.rxNotes}</Text>
              ) : (
                <Text style={styles.rxEmpty}>No prescription notes.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
      )}

      {/* Authenticated video player with native controls and OS fallback. */}
      <Modal
        visible={videoEntry !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setVideoEntry(null)}
      >
        <Pressable
          style={styles.lightboxBackdrop}
          onPress={() => {
            if (consumeLightboxLongPress(true)) return;
            setVideoEntry(null);
          }}
          onLongPress={() => {
            if (!videoEntry?.attachmentId || !id) return;
            markLightboxLongPress(true);
            confirmSaveAttachment({
              kind: "document",
              url: attachmentUrl(id, videoEntry.attachmentId),
              fileName: videoEntry.fileName,
              fileType: videoEntry.fileType,
            });
          }}
          testID="provider-video-backdrop"
        >
          {videoEntry?.attachmentId && id &&
          isInlinePlayableVideo({
            mimeType: videoEntry.fileType,
            fileName: videoEntry.fileName,
          }) &&
          !videoPlaybackFailed ? (
            <AuthedProviderVideo
              url={attachmentUrl(id, videoEntry.attachmentId)}
              fileName={videoEntry.fileName}
              fileType={videoEntry.fileType}
              style={styles.lightboxVideo}
              onPlaybackError={() => setVideoPlaybackFailed(true)}
            />
          ) : videoEntry ? (
            <View style={styles.videoFallback}>
              <Ionicons name="videocam-outline" size={42} color="#fff" />
              <Text style={styles.videoFallbackText}>
                This video can’t be played in the app.
              </Text>
              <Pressable
                style={styles.videoFallbackButton}
                onPress={(event) => {
                  event?.stopPropagation?.();
                  if (!videoEntry.attachmentId || !id) return;
                  void openAttachmentPreview(
                    {
                      url: attachmentUrl(id, videoEntry.attachmentId),
                      fileName: videoEntry.fileName,
                      fileType: videoEntry.fileType,
                    },
                    {
                      onOpenImage: () => undefined,
                      onError: (title, message) => Alert.alert(title, message),
                    },
                  );
                }}
                testID="provider-video-fallback"
              >
                <Text style={styles.videoFallbackButtonText}>Open / Download</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            style={styles.lightboxClose}
            onPress={() => setVideoEntry(null)}
            hitSlop={12}
          >
            <Ionicons name="close-circle" size={32} color="#fff" />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full-screen image lightbox */}
      <Modal
        visible={lightboxUrl !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxUrl(null)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable
          style={styles.lightboxBackdrop}
          onPress={() => {
            if (consumeLightboxLongPress(true)) return;
            setLightboxUrl(null);
          }}
          onLongPress={() => {
            if (!lightboxUrl) return;
            markLightboxLongPress(true);
            confirmSaveAttachment({ kind: "image", url: lightboxUrl });
          }}
          testID="provider-lightbox-backdrop"
        >
          {lightboxUrl && (
            <ZoomableAuthedImage
              key={lightboxUrl}
              url={lightboxUrl}
              style={styles.lightboxImage}
              testID="provider-lightbox-image"
              onLongPress={() => confirmSaveAttachment({ kind: "image", url: lightboxUrl })}
            />
          )}
          <Pressable
            style={styles.lightboxClose}
            onPress={(event) => {
              event.stopPropagation();
              setLightboxUrl(null);
            }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close photo viewer"
            testID="provider-lightbox-close"
          >
            <Ionicons name="close-circle" size={32} color="#fff" />
          </Pressable>
        </Pressable>
        </GestureHandlerRootView>
      </Modal>
    </DismissKeyboardView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
    },
    // Header
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.sm,
      gap: Spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { ...Typography.h3, color: c.text },
    headerSub: { ...Typography.caption, color: c.textSecondary, marginTop: 1 },
    // Body
    body: { padding: Spacing.lg, gap: Spacing.md },
    // Info card
    infoCard: { gap: Spacing.sm },
    infoRow: { flexDirection: "row", gap: Spacing.sm, flexWrap: "wrap" },
    infoLabel: {
      ...Typography.captionSemibold,
      color: c.textTertiary,
      textTransform: "uppercase" as const,
      minWidth: 90,
    },
    infoValue: { ...Typography.body, color: c.text, flex: 1 },
    infoValueMuted: { ...Typography.body, color: c.textTertiary, fontStyle: "italic", flex: 1 },
    labNotes: { color: c.textSecondary, lineHeight: 20 },
    restorationSummary: { gap: Spacing.xs },
    restorationList: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm ?? 4,
      overflow: "hidden",
    },
    restorationRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
    },
    restorationRowBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    restorationPrimary: { flex: 1, gap: 2 },
    restorationTooth: { ...Typography.captionSemibold, color: c.text },
    restorationType: { ...Typography.caption, color: c.textSecondary },
    restorationMaterial: {
      ...Typography.caption,
      color: c.text,
      maxWidth: "42%" as const,
      textAlign: "right" as const,
    },
    // Invoice card
    invoiceToggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md ?? 8,
      backgroundColor: c.surface,
    },
    invoiceToggleTitle: { ...Typography.bodySemibold, color: c.tint },
    invoiceToggleSubtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 1 },
    invoiceCard: { gap: Spacing.xs },
    invoiceHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.xs,
    },
    invoiceLine: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingVertical: Spacing.xs,
    },
    invoiceLineBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    invoiceDescriptionBlock: { flex: 1, gap: 2 },
    invoicePriceBlock: { alignItems: "flex-end", gap: 2 },
    invoiceDesc: { ...Typography.caption, color: c.text },
    invoiceQty: { ...Typography.caption, color: c.textSecondary },
    invoiceUnitPrice: { ...Typography.caption, color: c.textSecondary },
    invoiceAmount: { ...Typography.captionSemibold, color: c.text, width: 60, textAlign: "right" as const },
    invoiceTotal: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingTop: Spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      marginTop: Spacing.xs,
    },
    invoiceTotalLabel: { ...Typography.bodySemibold, color: c.text },
    invoiceTotalAmount: { ...Typography.bodySemibold, color: c.text },
    // Section headings
    sectionHeading: {
      ...Typography.label,
      color: c.textTertiary,
      textTransform: "uppercase" as const,
      marginTop: Spacing.xs,
    },
    sectionTitle: { ...Typography.bodySemibold, color: c.text },
    // Timeline
    emptyTimelineCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    emptyTimelineText: { ...Typography.body, color: c.textTertiary },
    timelineRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    timelineDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    timelineDot: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: c.tint + "18",
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    timelineContent: { flex: 1, gap: 3 },
    timelineTitle: { ...Typography.body, color: c.text },
    timelineMeta: { ...Typography.caption, color: c.textTertiary },
    statusValue: { textTransform: "capitalize" as const, fontWeight: "600" as const },
    // Returned-case row + View Rx affordance
    returnRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    returnBadge: {
      ...Typography.caption,
      color: c.textSecondary,
      textTransform: "uppercase" as const,
    },
    viewRxBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm ?? 4,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
    },
    viewRxBtnText: { ...Typography.captionSemibold, color: c.tint },
    // Prescription (Rx) modal
    rxBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      padding: Spacing.lg,
    },
    rxSheet: {
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.md ?? 8,
      maxHeight: "85%" as const,
      overflow: "hidden",
    },
    rxHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rxTitle: { ...Typography.h3, color: c.text },
    rxBody: { padding: Spacing.lg, gap: Spacing.md },
    rxRow: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.md },
    rxLabel: { ...Typography.caption, color: c.textSecondary },
    rxValue: { ...Typography.body, color: c.text, flexShrink: 1, textAlign: "right" as const },
    rxSectionTitle: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
      textTransform: "uppercase" as const,
    },
    rxRestoration: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.xs,
      gap: 2,
    },
    rxRestorationTitle: { ...Typography.bodySemibold, color: c.text },
    rxRestorationMeta: { ...Typography.caption, color: c.textSecondary },
    rxEmpty: { ...Typography.caption, color: c.textTertiary, fontStyle: "italic" as const },
    rxNotes: { ...Typography.body, color: c.textSecondary },
    // Note highlight
    noteBox: {
      backgroundColor: c.tint + "12",
      borderRadius: Radius.sm ?? 4,
      padding: Spacing.sm,
    },
    noteText: { ...Typography.body, color: c.text, lineHeight: 20 },
    // Photo thumbnail
    photoThumb: {
      width: 100,
      height: 72,
      borderRadius: Radius.sm ?? 4,
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    thumbImage: { width: "100%" as const, height: "100%" as const },
    // File row
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    fileName: { ...Typography.body, color: c.tint, flex: 1 },
    // Note composer
    noteComposer: { gap: Spacing.sm },
    noteInput: {
      ...Typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm ?? 4,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
      minHeight: 80,
      textAlignVertical: "top" as const,
    },
    quickReferenceButton: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: Spacing.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm ?? 4,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      marginTop: Spacing.xs,
    },
    quickReferenceButtonText: { ...Typography.caption, color: c.textSecondary },
    quickReferenceList: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.sm ?? 4,
      overflow: "hidden",
      marginTop: Spacing.xs,
    },
    quickReferenceItem: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    quickReferenceLabel: { ...Typography.captionSemibold, color: c.tint },
    quickReferenceBody: { ...Typography.caption, color: c.text, marginTop: 2 },
    quickReferenceError: { ...Typography.caption, color: c.error, marginTop: Spacing.xs },
    sendBtn: {
      backgroundColor: c.tint,
      borderRadius: Radius.sm ?? 4,
      paddingVertical: Spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 40,
    },
    sendBtnDisabled: { opacity: 0.4 },
    sendBtnText: { ...Typography.bodySemibold, color: "#fff" },
    // Attach file
    attachCard: { gap: Spacing.xs },
    attachBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      borderWidth: 1,
      borderColor: c.tint,
      borderRadius: Radius.sm ?? 4,
      paddingVertical: Spacing.sm,
      borderStyle: "dashed" as const,
    },
    attachBtnDisabled: { opacity: 0.5 },
    attachBtnText: { ...Typography.bodySemibold },
    uploadSuccess: { ...Typography.caption, color: "#22c55e", textAlign: "center" as const },
    uploadError: { ...Typography.caption, color: c.error, textAlign: "center" as const },
    // Lightbox
    lightboxBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.92)",
      alignItems: "center",
      justifyContent: "center",
    },
    lightboxImage: { width: "100%" as const, height: "80%" as const },
    lightboxVideo: { width: "100%" as const, height: "72%" as const },
    videoFallback: {
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.xl,
    },
    videoFallbackText: {
      color: "#fff",
      ...Typography.body,
      textAlign: "center",
    },
    videoFallbackButton: {
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
    },
    videoFallbackButtonText: {
      color: c.textInverse,
      fontWeight: "600",
    },
    lightboxClose: {
      position: "absolute",
      top: 52,
      right: 16,
    },
    // Error states
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" as const },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" as const },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full ?? 99,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: "#fff" },
  });
}
