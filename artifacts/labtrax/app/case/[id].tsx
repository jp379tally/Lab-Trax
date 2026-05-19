import React, { useState, useRef, useEffect, type ComponentProps } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  Alert,
  Modal,
  TextInput,
  Image as RNImage,
  KeyboardAvoidingView,
  Share,
  Linking,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useApp } from "@/lib/app-context";
import { resilientFetch, getAccessToken, getApiUrl } from "@/lib/query-client";
import * as FileSystem from "expo-file-system";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus, ToothType, MATERIAL_PRICES, CaseTypeValue, Invoice, SHADE_OPTIONS, cleanDoctorDisplay, formatInvNum, ActivityEntry } from "@/lib/data";
import { resolvePriceForCase } from "@/lib/pricing";
import { ChatButton } from "@/components/ChatButton";
import InvoicePDFViewer from "@/components/InvoicePDFViewer";
import { logAudit } from "@/lib/audit";
import {
  caseToRxSummary,
  formatRxTeethLabel,
  buildHighlightedToothSet,
} from "@/lib/rx-summary";
import { ReadOnlyToothChart } from "@/components/ReadOnlyToothChart";
import { deriveDisplayInitials } from "@/lib/display-initials";
import { resolveCaseInvoice } from "@/lib/case-detail/draft-invoice";
import { LabSlipModal } from "@/components/case/LabSlipModal";
import { EditCaseModal } from "@/components/case/EditCaseModal";
import { QuickEditModal } from "@/components/case/QuickEditModal";
import { CaseBarcodeScannerModal } from "@/components/case/CaseBarcodeScannerModal";
import { AddItemModal } from "@/components/case/AddItemModal";
import {
  CourtesyTextModal,
  ExocadLinkModal,
  ProposeDateModal,
  DeclineDateModal,
} from "@/components/case/CourtesyModals";
import { computeQuickEditPlan } from "@/lib/case-detail/quick-edit";
import {
  computeCaseEditDiff,
  buildInvoicePatchForCaseEdit,
} from "@/lib/case-detail/edit-diff";
import {
  buildCaseLabelHtml,
  buildCaseHistoryHtml,
} from "@/lib/case-detail/case-html";
import {
  formatToothDisplay,
  computeBillableCount,
  getAppliancePriceKey,
  getApplianceUnitPrice,
  buildApplianceLineItems,
} from "@/lib/case-detail/add-item";

const SCAN_MIME_TYPES = new Set([
  "model/stl",
  "model/obj",
  "model/ply",
  "application/sla",
  "application/dicom",
]);
const SCAN_EXTENSIONS = new Set(["stl", "obj", "ply", "dcm", "3ds", "dae"]);

export default function CaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { cases, updateCaseStatus, addCasePhoto, addCaseNote, addCasePhotosWithNote, addTrackingNumber, addCaseItem, role, adminUnlocked, users, invoices, updateInvoice, addInvoice, updateCase, clients, pricingTiers, sendCourtesyText, respondToCourtesyText, proposeDeliveryDate, respondToProposedDate, assignBarcodeToCase, findCaseByBarcode, customStationLabels, addNotification, hardRefresh, hydrateInvoiceFromServer } = useApp();
  const { currentUser, userType, registeredUsers } = useAuth();
  const currentRegisteredUser = registeredUsers.find(
    (user) => user.username?.toLowerCase() === (currentUser || "").toLowerCase()
  );
  const userInitials = deriveDisplayInitials({
    firstName: currentRegisteredUser?.firstName,
    lastName: currentRegisteredUser?.lastName,
    label: currentRegisteredUser?.username || currentUser,
  });
  const insets = useSafeAreaInsets();
  const [companyLogo, setCompanyLogo] = useState<string | null>(null);
  useEffect(() => {
    AsyncStorage.getItem("@drivesync_company_logo").then((uri) => {
      if (uri) setCompanyLogo(uri);
    });
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  type RemakeRef = {
    id: string;
    caseNumber: string;
    patientFirstName?: string | null;
    patientLastName?: string | null;
    status?: string | null;
    createdAt?: string | null;
    remakeReason?: string | null;
    remakeCharged?: boolean | null;
  };
  type FullCaseData = {
    photos?: string[];
    videos?: string[];
    activityLog?: ActivityEntry[];
    needsAiReview?: boolean;
    aiImportSource?: string | null;
    remakeOriginal?: RemakeRef | null;
    remakeChildren?: RemakeRef[];
    [key: string]: unknown;
  };
  type CaseAttachment = {
    id: string;
    caseId: string;
    fileName: string;
    fileType: string | null;
    storageKey: string;
    visibility: string;
    createdAt: string | null;
    uploaderName?: string | null;
  };
  const [fullCaseData, setFullCaseData] = useState<FullCaseData | null>(null);
  const [originalActivityLog, setOriginalActivityLog] = useState<ActivityEntry[]>([]);
  const [originalCaseNumber, setOriginalCaseNumber] = useState<string | null>(null);
  const [serverAttachments, setServerAttachments] = useState<CaseAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [attachmentsFetchError, setAttachmentsFetchError] = useState(false);
  const [showRouting, setShowRouting] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showAddSomethingModal, setShowAddSomethingModal] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [capturedPhotos, setCapturedPhotos] = useState<string[]>([]);
  const [showPhotoPreview, setShowPhotoPreview] = useState(false);
  const [showCompleteInfo, setShowCompleteInfo] = useState(false);

  const [showEntryPrompt, setShowEntryPrompt] = useState(false);
  const [entryPhotoMode, setEntryPhotoMode] = useState(false);
  const [entryPhotos, setEntryPhotos] = useState<string[]>([]);
  const [entryNoteMode, setEntryNoteMode] = useState(false);
  const [entryNoteText, setEntryNoteText] = useState("");
  const [showAddItemModal, setShowAddItemModal] = useState(false);
  type AddItemStep = "caseType" | "toothChart" | "material" | "removableSubtype" | "removableMaterial" | "gingivaShade" | "applianceSubtype" | "applianceArch" | "applianceNightGuardType" | "applianceRetainerType" | "applianceNightGuard" | "applianceEssexTeeth" | "applianceEssexShade" | "complete";
  const [addItemStep, setAddItemStep] = useState<AddItemStep>("caseType");
  const [itemCaseType, setItemCaseType] = useState<CaseTypeValue>("");
  const [itemSelectedTeeth, setItemSelectedTeeth] = useState<number[]>([]);
  const [itemToothTypes, setItemToothTypes] = useState<Record<number, ToothType>>({});
  const [itemMaterial, setItemMaterial] = useState("Zirconia");
  const [removableSubtype, setRemovableSubtype] = useState("");
  const [removableMaterial, setRemovableMaterial] = useState("");
  const [gingivaShade, setGingivaShade] = useState("");
  const [gingivaCustomNote, setGingivaCustomNote] = useState("");
  const [removableCustomMaterial, setRemovableCustomMaterial] = useState("");
  const [applianceSubtype, setApplianceSubtype] = useState("");
  const [nightGuardType, setNightGuardType] = useState("");
  const [applianceArch, setApplianceArch] = useState<"" | "Upper" | "Lower" | "Both">("");
  const [applianceVariant, setApplianceVariant] = useState("");
  const [essexShade, setEssexShade] = useState("");

  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false);
  const [barcodeScanned, setBarcodeScanned] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [showEditCase, setShowEditCase] = useState(false);
  const [editDoctor, setEditDoctor] = useState("");
  const [editPatient, setEditPatient] = useState("");
  const [editTeeth, setEditTeeth] = useState("");
  const [editShade, setEditShade] = useState("");
  const [editMaterial, setEditMaterial] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editNotes, setEditNotes] = useState("");

  function requestCameraWithPrompt(onGranted: () => void) {
    ImagePicker.getCameraPermissionsAsync().then((perm) => {
      if (perm.granted) {
        onGranted();
        return;
      }
      Alert.alert(
        "Camera Access",
        "This feature uses your camera to capture dental case photos.",
        [{
          text: "Continue",
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status === "granted") {
              onGranted();
            }
          },
        }]
      );
    });
  }

  const [showCourtesyModal, setShowCourtesyModal] = useState(false);
  const [showExocadModal, setShowExocadModal] = useState(false);
  const [exocadUrlInput, setExocadUrlInput] = useState("");
  const [courtesyMessage, setCourtesyMessage] = useState("");
  const [showDateProposalModal, setShowDateProposalModal] = useState(false);
  const [proposalDate, setProposalDate] = useState("");
  const [proposalTime, setProposalTime] = useState("");
  const [activeCourtesyId, setActiveCourtesyId] = useState("");
  const [declineNote, setDeclineNote] = useState("");
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [showInvoiceModal, setShowInvoiceModalRaw] = useState(false);
  const setShowInvoiceModal = (v: boolean) => {
    setShowInvoiceModalRaw(v);
    if (v && caseItem?.invoiceId) {
      void hydrateInvoiceFromServer(caseItem.invoiceId);
    }
  };
  const [showLabSlipModal, setShowLabSlipModal] = useState(false);
  const [fullScreenPhoto, setFullScreenPhoto] = useState<string | null>(null);
  const [photoNotes, setPhotoNotes] = useState("");
  const [showPhotoNotes, setShowPhotoNotes] = useState(false);
  const finishPhotosRef = useRef(false);
  const [showQuickEdit, setShowQuickEdit] = useState(false);
  const [qeDoctor, setQeDoctor] = useState("");
  const [qePatient, setQePatient] = useState("");
  const [qeTeeth, setQeTeeth] = useState("");
  const [qeShade, setQeShade] = useState("");
  const [qeMaterial, setQeMaterial] = useState("");
  const [qeDueDate, setQeDueDate] = useState("");
  const [qeNotes, setQeNotes] = useState("");

  const caseItemBase = cases.find((c) => c.id === id);
  const caseItem = caseItemBase && fullCaseData
    ? {
        ...caseItemBase,
        photos: (fullCaseData.photos ?? caseItemBase.photos) as string[],
        videos: (fullCaseData.videos ?? caseItemBase.videos) as string[] | undefined,
        activityLog: (fullCaseData.activityLog ?? caseItemBase.activityLog) as ActivityEntry[],
      }
    : caseItemBase;
  const isAdmin = role === "admin";
  const showPrice = isAdmin;

  React.useEffect(() => {
    if (caseItem && currentUser) {
      logAudit("VIEW_CASE", currentUser, `Case ${caseItem.caseNumber} - Patient: ${caseItem.patientName}`);
    }
  }, [id]);

  async function fetchServerAttachments() {
    setAttachmentsFetchError(false);
    try {
      const res = await resilientFetch(`/api/cases/${encodeURIComponent(String(id))}/attachments`);
      if (res.ok) {
        const data = await res.json();
        setServerAttachments(Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []);
      } else if (res.status === 404 || res.status === 403) {
        // Expected for legacy lab_cases that are not in the `cases` table — ignore.
      } else {
        if (__DEV__) {
          console.warn(`[LabTrax] fetchServerAttachments: unexpected status ${res.status} for case ${id}`);
        }
        setAttachmentsFetchError(true);
      }
    } catch (err: unknown) {
      if (__DEV__) {
        console.warn("[LabTrax] fetchServerAttachments: network error", err);
      }
      setAttachmentsFetchError(true);
    }
  }

  type ApiErrorBody = { error?: string };

  /**
   * Models React Native's runtime extension of the FormData API, which
   * additionally accepts a native file descriptor `{ uri, name, type }`
   * instead of a standard `Blob`. TypeScript's built-in FormData type
   * does not include this overload, so we model it as a standalone
   * interface and narrow to it only on the native code path.
   */
  interface RNFormDataNativeAppend {
    append(name: string, value: { uri: string; name: string; type: string }): void;
  }

  async function uploadAttachment(uri: string, name: string, mimeType: string) {
    setUploadingAttachment(true);
    try {
      const formData = new FormData();
      if (Platform.OS === "web") {
        // On web, uri may be a data URL (from FileReader) — convert to Blob
        // so standard FormData.append(name, Blob, filename) is used.
        const blob = await globalThis.fetch(uri).then((r) => r.blob());
        formData.append("file", blob, name);
      } else {
        // React Native's FormData runtime accepts { uri, name, type } for
        // native file uploads. We narrow to the typed interface that models
        // this platform-specific overload.
        (formData as unknown as RNFormDataNativeAppend).append("file", { uri, name, type: mimeType });
      }
      const uploadRes = await resilientFetch("/api/media/upload", {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const err: ApiErrorBody = await uploadRes.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }
      const { url } = await uploadRes.json();

      const attachRes = await resilientFetch(`/api/cases/${encodeURIComponent(String(id))}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageKey: url,
          fileName: name,
          fileType: mimeType,
        }),
      });
      if (!attachRes.ok) {
        const err: ApiErrorBody = await attachRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to register attachment");
      }

      await fetchServerAttachments();
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unable to upload file.";
      Alert.alert("Upload Failed", msg);
    } finally {
      setUploadingAttachment(false);
    }
  }

  // Fetch full case data (photos + activityLog) for the detail view.
  // The list endpoint strips these large fields to keep it lean.
  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    resilientFetch(`/api/legacy/cases/${encodeURIComponent(id)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!cancelled && data?.case) setFullCaseData(data.case);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  // Fetch the original case's activity log so the history section can show
  // the full timeline (original case history → remake history).
  //
  // Strategy:
  // 1. Fetch GET /api/cases/:id (the current case). For canonical remake cases
  //    the server already returns `originalCaseEvents` (CaseEvent[]) in the
  //    response — convert them to ActivityEntry format and use them.
  // 2. If the canonical endpoint is unavailable or returns no originalCaseEvents
  //    (legacy mobile case), fall back to fetching the original case via
  //    GET /api/legacy/cases/:remakeOfCaseId and reading its activityLog.
  const remakeOfCaseId = caseItemBase?.remakeOfCaseId;

  function caseEventToActivityEntry(e: {
    id?: string;
    eventType?: string;
    occurredAt?: string;
    createdAt?: string;
    actorInitials?: string | null;
    metadataJson?: Record<string, unknown>;
  }, idx: number): ActivityEntry {
    const ts = e.occurredAt || e.createdAt
      ? new Date(e.occurredAt ?? e.createdAt ?? 0).getTime()
      : idx;
    const meta: Record<string, unknown> = e.metadataJson ?? {};
    const et = e.eventType ?? "";
    let type: ActivityEntry["type"] = "created";
    let description = et.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (et === "status_changed") {
      type = "station_change";
      const to = meta.toStatus ?? meta.newStatus;
      description = to ? `Case moved to ${String(to)}` : "Status changed";
    } else if (et === "note_added") {
      type = "note";
      description = String(meta.content ?? meta.text ?? "Note");
    } else if (et.includes("attachment")) {
      type = "photo";
      description = String(meta.fileName ?? "Attachment");
    } else if (et.includes("invoice")) {
      type = "invoice_attached";
      description = String(meta.invoiceNumber ?? "Invoice");
    } else if (et === "case_created" || et === "remake_of" || et === "case_created_from_itero") {
      type = "created";
    }
    return {
      id: e.id ?? `event-${idx}`,
      type,
      timestamp: ts,
      description,
      user: e.actorInitials ?? undefined,
    };
  }

  React.useEffect(() => {
    if (!id || !remakeOfCaseId) {
      setOriginalActivityLog([]);
      setOriginalCaseNumber(null);
      return;
    }
    setOriginalActivityLog([]);
    setOriginalCaseNumber(null);
    let cancelled = false;

    async function fetchOriginalHistory() {
      // Try canonical endpoint first — returns originalCaseEvents for remake cases.
      const canonicalRes = await resilientFetch(`/api/cases/${encodeURIComponent(id as string)}`).catch(() => null);
      if (!cancelled && canonicalRes && canonicalRes.ok) {
        const data = await canonicalRes.json().catch(() => null);
        const events: unknown[] = Array.isArray(data?.originalCaseEvents) ? data.originalCaseEvents : [];
        if (events.length > 0) {
          const entries = (events as Parameters<typeof caseEventToActivityEntry>[0][]).map(caseEventToActivityEntry);
          setOriginalActivityLog(entries);
          setOriginalCaseNumber(data?.remakeOriginal?.caseNumber ?? null);
          return;
        }
      }

      // Fallback: fetch the original (legacy) case directly.
      if (cancelled) return;
      const legacyRes = await resilientFetch(`/api/legacy/cases/${encodeURIComponent(remakeOfCaseId as string)}`).catch(() => null);
      if (cancelled || !legacyRes || !legacyRes.ok) return;
      const legacyData = await legacyRes.json().catch(() => null);
      if (cancelled) return;
      const originalCase = legacyData?.case;
      if (!originalCase) return;
      const log: ActivityEntry[] = Array.isArray(originalCase.activityLog) ? originalCase.activityLog : [];
      setOriginalActivityLog(log);
      setOriginalCaseNumber(originalCase.caseNumber ?? null);
    }

    void fetchOriginalHistory();
    return () => { cancelled = true; };
  }, [id, remakeOfCaseId]);

  React.useEffect(() => {
    if (!id) return;
    void fetchServerAttachments();
  }, [id]);

  if (!caseItem) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Case not found</Text>
        <Pressable onPress={() => router.back()} style={styles.backLink}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const stationInfo = getStationInfo(caseItem.status, customStationLabels);

  const caseInvoice: Invoice = resolveCaseInvoice({ caseItem, invoices, clients, pricingTiers });

  function handleRoute(newStatus: CaseStatus) {
    updateCaseStatus(caseItem!.id, newStatus, userInitials);
    setShowRouting(false);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    Alert.alert(
      "Routed",
      `Case ${caseItem!.caseNumber} moved to ${getStationInfo(newStatus, customStationLabels).label}`,
    );
  }

  function formatTimestamp(ts: number) {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function openEditCase() {
    if (!caseItem) return;
    setEditDoctor(caseItem.doctorName);
    setEditPatient(caseItem.patientName || caseItem.patientInitials);
    setEditTeeth(caseItem.toothIndices);
    setEditShade(caseItem.shade);
    setEditMaterial(caseItem.material);
    setEditDueDate(caseItem.dueDate || "");
    setEditNotes(caseItem.notes || "");
    setShowEditCase(true);
  }

  function handleSaveEditCase() {
    if (!caseItem) return;
    const { updates, changes, providerChanged } = computeCaseEditDiff(caseItem, {
      doctor: editDoctor,
      patient: editPatient,
      teeth: editTeeth,
      shade: editShade,
      material: editMaterial,
      dueDate: editDueDate,
      notes: editNotes,
    });
    const newDoctor = editDoctor.trim();

    if (changes.length === 0) {
      setShowEditCase(false);
      return;
    }

    updateCase(caseItem.id, updates);

    if (changes.length > 0) {
      addCaseNote(caseItem.id, `Case edited: ${changes.join("; ")}`, userInitials);
    }

    const targetInvId = caseItem.invoiceId || (caseInvoice && caseInvoice.id !== caseItem.id + "-inv" ? caseInvoice.id : null);
    if (targetInvId) {
      const invUpdates = buildInvoicePatchForCaseEdit({
        updates,
        currentMaterial: caseItem.material,
      });
      updateInvoice(targetInvId, invUpdates);
    }

    if (providerChanged) {
      const matchClient = clients.find(
        (cl) => cl.leadDoctor.toLowerCase().includes(newDoctor.toLowerCase()) ||
          newDoctor.toLowerCase().includes(cl.leadDoctor.toLowerCase()) ||
          (cl.additionalProviders || []).some(p => p.toLowerCase().includes(newDoctor.toLowerCase()))
      );
      const transferInvId = targetInvId || caseItem.invoiceId;
      if (matchClient && transferInvId) {
        updateInvoice(transferInvId, {
          clientId: matchClient.id,
          clientName: matchClient.leadDoctor,
          billTo: matchClient.practiceName || matchClient.leadDoctor,
        });
        addCaseNote(caseItem.id, `Invoice transferred to ${matchClient.practiceName || matchClient.leadDoctor}`, userInitials);
      }
    }

    const savedCase = { ...caseItem, ...updates };
    setShowEditCase(false);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    Alert.alert(
      "Changes Saved",
      "Do you want to reprint the case label?",
      [
        { text: "No", style: "cancel" },
        { text: "Yes", onPress: () => handlePrintCaseLabel(savedCase) },
      ]
    );
  }

  async function handlePrintCaseLabel(caseRecord: typeof caseItem) {
    try {
      const html = buildCaseLabelHtml(caseRecord);
      await Print.printAsync({ html });
    } catch {
      Alert.alert("Print Error", "Unable to print the updated case label.");
    }
  }

  async function handlePrintCaseHistory() {
    if (!caseItem) return;
    try {
      const html = buildCaseHistoryHtml({ caseItem, customStationLabels, registeredUsers });
      if (Platform.OS === "web") {
        await Print.printAsync({ html });
        return;
      }
      Alert.alert(
        "Print Case History",
        "Choose how you'd like to send this case history.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Print",
            onPress: async () => {
              try {
                await Print.printAsync({ html });
              } catch {
                Alert.alert("Print Error", "Unable to print the case history.");
              }
            },
          },
          {
            text: "Save / Share PDF",
            onPress: async () => {
              try {
                const { uri } = await Print.printToFileAsync({ html });
                if (await Sharing.isAvailableAsync()) {
                  await Sharing.shareAsync(uri, {
                    mimeType: "application/pdf",
                    UTI: "com.adobe.pdf",
                    dialogTitle: `Case ${caseItem.caseNumber || ""} History`,
                  });
                } else {
                  Alert.alert("Saved", `PDF saved to: ${uri}`);
                }
              } catch {
                Alert.alert("Export Error", "Unable to create the PDF.");
              }
            },
          },
        ]
      );
    } catch {
      Alert.alert("Print Error", "Unable to build the case history document.");
    }
  }

  function webFilePickerForCamera(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.capture = "user";
      input.onchange = (e: any) => {
        const file = e.target?.files?.[0];
        if (file) {
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve(typeof reader.result === "string" ? reader.result : null);
          };
          reader.readAsDataURL(file);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  }

  function handleTakePhoto() {
    Alert.alert(
      "Add Picture or Video",
      "Choose an option",
      [
        {
          text: "Take Photo",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) {
                  setCapturedPhotos((prev) => [...prev, uri]);
                  setShowPhotoPreview(true);
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(async () => {
              try {
                const result = await ImagePicker.launchCameraAsync({
                  mediaTypes: ["images"],
                  quality: 1.0,
                  allowsEditing: false,
                });
                if (!result.canceled && result.assets[0]) {
                  setCapturedPhotos((prev) => [...prev, result.assets[0].uri]);
                  setShowPhotoPreview(true);
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
            });
          },
        },
        {
          text: "Record Video",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) {
                  setCapturedPhotos((prev) => [...prev, uri]);
                  setShowPhotoPreview(true);
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(async () => {
              try {
                const result = await ImagePicker.launchCameraAsync({
                  mediaTypes: ["videos"],
                  quality: 1.0,
                  videoMaxDuration: 60,
                });
                if (!result.canceled && result.assets[0]) {
                  setCapturedPhotos((prev) => [...prev, result.assets[0].uri]);
                  setShowPhotoPreview(true);
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
            });
          },
        },
        {
          text: "Choose from Gallery",
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Permission needed", "Gallery access is required.");
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images", "videos"],
              quality: 1.0,
              allowsMultipleSelection: true,
            });
            if (!result.canceled && result.assets.length > 0) {
              setCapturedPhotos((prev) => [...prev, ...result.assets.map(a => a.uri)]);
              setShowPhotoPreview(true);
            }
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  function handleAddMoreMedia() {
    Alert.alert(
      "Add More",
      "Choose an option",
      [
        {
          text: "Take Photo",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) setCapturedPhotos((prev) => [...prev, uri]);
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(() => {
              setShowPhotoPreview(false);
              setTimeout(async () => {
                try {
                  const result = await ImagePicker.launchCameraAsync({
                    mediaTypes: ["images"],
                    quality: 1.0,
                    allowsEditing: false,
                  });
                  if (!result.canceled && result.assets[0]) {
                    setCapturedPhotos((prev) => [...prev, result.assets[0].uri]);
                  }
                  setShowPhotoPreview(true);
                } catch {
                  Alert.alert("Camera Error", "Unable to open camera.");
                  setShowPhotoPreview(true);
                }
              }, 500);
            });
          },
        },
        {
          text: "Record Video",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) setCapturedPhotos((prev) => [...prev, uri]);
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(() => {
              setShowPhotoPreview(false);
              setTimeout(async () => {
                try {
                  const result = await ImagePicker.launchCameraAsync({
                    mediaTypes: ["videos"],
                    quality: 1.0,
                    videoMaxDuration: 60,
                  });
                  if (!result.canceled && result.assets[0]) {
                    setCapturedPhotos((prev) => [...prev, result.assets[0].uri]);
                  }
                  setShowPhotoPreview(true);
                } catch {
                  Alert.alert("Camera Error", "Unable to open camera.");
                  setShowPhotoPreview(true);
                }
              }, 500);
            });
          },
        },
        {
          text: "Choose from Gallery",
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Permission needed", "Gallery access is required.");
              return;
            }
            setShowPhotoPreview(false);
            setTimeout(async () => {
              const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images", "videos"],
                quality: 1.0,
                allowsMultipleSelection: true,
              });
              if (!result.canceled && result.assets.length > 0) {
                setCapturedPhotos((prev) => [...prev, ...result.assets.map(a => a.uri)]);
              }
              setShowPhotoPreview(true);
            }, 500);
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  function handleItemToothTap(num: number) {
    const wasSelected = itemSelectedTeeth.includes(num);
    setItemSelectedTeeth((prev) => {
      const next = wasSelected ? prev.filter((t) => t !== num) : [...prev, num];
      return next.sort((a, b) => a - b);
    });
    if (wasSelected) {
      setItemToothTypes((prevTypes) => {
        const updated = { ...prevTypes };
        delete updated[num];
        return updated;
      });
    }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function handleItemToothLongPress(num: number) {
    if (!itemSelectedTeeth.includes(num)) {
      setItemSelectedTeeth((prev) => [...prev, num].sort((a, b) => a - b));
    }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      `Tooth #${num}`,
      "Select a designation for this tooth:",
      [
        {
          text: "Pontic",
          onPress: () => setItemToothTypes((prev) => ({ ...prev, [num]: "bridge" as ToothType })),
        },
        {
          text: "Missing",
          onPress: () => setItemToothTypes((prev) => ({ ...prev, [num]: "missing" as ToothType })),
        },
        {
          text: "Normal",
          onPress: () => setItemToothTypes((prev) => {
            const updated = { ...prev };
            delete updated[num];
            return updated;
          }),
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  const itemBillableCount = React.useMemo(
    () => computeBillableCount(itemSelectedTeeth, itemToothTypes),
    [itemSelectedTeeth, itemToothTypes],
  );

  const itemCalculatedPrice = React.useMemo(() => {
    const unitPrice = resolvePriceForCase(itemMaterial, itemCaseType, caseItem?.doctorName || "", clients, pricingTiers);
    return unitPrice * Math.max(itemBillableCount, 1);
  }, [itemMaterial, itemCaseType, itemBillableCount, caseItem?.doctorName, clients, pricingTiers]);

  const itemToothDisplay = React.useMemo(
    () => formatToothDisplay(itemSelectedTeeth, itemToothTypes),
    [itemSelectedTeeth, itemToothTypes],
  );

  function openAddItemModal() {
    setAddItemStep("caseType");
    setItemCaseType("");
    setItemSelectedTeeth([]);
    setItemToothTypes({});
    setItemMaterial("Zirconia");
    setRemovableSubtype("");
    setRemovableMaterial("");
    setGingivaShade("");
    setGingivaCustomNote("");
    setRemovableCustomMaterial("");
    setApplianceSubtype("");
    setNightGuardType("");
    setApplianceArch("");
    setApplianceVariant("");
    setEssexShade("");
    setShowAddItemModal(true);
  }

  function addApplianceToInvoice(subtype: string, variant: string, arch: string) {
    const linkedInv = caseItem!.invoiceId ? invoices.find((inv) => inv.id === caseItem!.invoiceId) : undefined;
    if (!linkedInv) return;
    const priceKey = getAppliancePriceKey(subtype, variant);
    const client = clients.find((c) => c.practiceName === (caseItem as { clientName?: string } | null)?.clientName);
    const unitPrice = getApplianceUnitPrice({ priceKey, client, pricingTiers });
    const newItems = buildApplianceLineItems({ subtype, variant, arch, unitPrice });
    const updLi = [...linkedInv.lineItems, ...newItems];
    updateInvoice(linkedInv.id, { lineItems: updLi, amount: updLi.reduce((s, li) => s + li.amount, 0) });
  }

  function handleSaveItem() {
    if (!itemCaseType) {
      Alert.alert("Missing Info", "Please select a case type.");
      return;
    }
    const skipToothValidation =
      (itemCaseType === "Removable" && (removableSubtype === "Full Denture" || removableSubtype === "Immediate Denture" || removableSubtype === "Denture")) ||
      (itemCaseType === "Appliance");

    if (!skipToothValidation && itemSelectedTeeth.length === 0) {
      Alert.alert("Missing Info", "Please select at least one tooth.");
      return;
    }

    let extras: { subType?: string; gingivaShade?: string; customNotes?: string; applianceSubType?: string; nightGuardType?: string } | undefined;
    let mat = itemMaterial;

    if (itemCaseType === "Removable") {
      const finalMat = removableMaterial === "Other" && removableCustomMaterial ? removableCustomMaterial : (removableMaterial || "Acrylic");
      mat = finalMat;
      extras = { subType: removableSubtype, gingivaShade: gingivaShade || undefined, customNotes: gingivaCustomNote || undefined };
    } else if (itemCaseType === "Appliance") {
      mat = applianceSubtype === "Essex" ? (essexShade || "Essex") : applianceSubtype;
      extras = { applianceSubType: applianceSubtype, nightGuardType: nightGuardType || undefined };
    }

    addCaseItem(caseItem!.id, itemCaseType, itemSelectedTeeth, itemToothTypes, mat, extras);

    const linkedInvoice = caseItem!.invoiceId ? invoices.find((inv) => inv.id === caseItem!.invoiceId) : undefined;
    if (linkedInvoice) {
      const unitPrice = resolvePriceForCase(mat, itemCaseType, caseItem?.doctorName || "", clients, pricingTiers);
      const toothCount = Math.max(itemSelectedTeeth.length, 1);
      const newLineItem = {
        qty: toothCount,
        item: `${mat} ${itemCaseType}`,
        description: `${itemCaseType}${extras?.subType ? ` - ${extras.subType}` : ""}${extras?.applianceSubType ? ` - ${extras.applianceSubType}` : ""} - ${itemToothDisplay || "N/A"}`,
        rate: unitPrice,
        amount: unitPrice * toothCount,
      };
      const updatedLineItems = [...linkedInvoice.lineItems, newLineItem];
      const updatedAmount = updatedLineItems.reduce((s, li) => s + li.amount, 0);
      updateInvoice(linkedInvoice.id, { lineItems: updatedLineItems, amount: updatedAmount });
    }

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setShowAddItemModal(false);
  }

  function handleAttachFile() {
    Alert.alert(
      "Attach File",
      "Choose a source",
      [
        {
          text: "Camera",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) {
                  const name = `photo_${Date.now()}.jpg`;
                  await uploadAttachment(uri, name, "image/jpeg");
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(async () => {
              try {
                const result = await ImagePicker.launchCameraAsync({
                  mediaTypes: ["images"],
                  quality: 1.0,
                  allowsEditing: false,
                });
                if (!result.canceled && result.assets[0]) {
                  const asset = result.assets[0];
                  const name = asset.uri.split("/").pop() || `photo_${Date.now()}.jpg`;
                  const mimeType = asset.mimeType || "image/jpeg";
                  await uploadAttachment(asset.uri, name, mimeType);
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
            });
          },
        },
        {
          text: "Photo Library",
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Permission needed", "Photo library access is required.");
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 1.0,
              allowsMultipleSelection: true,
            });
            if (!result.canceled && result.assets.length > 0) {
              for (const asset of result.assets) {
                const name = asset.uri.split("/").pop() || `photo_${Date.now()}.jpg`;
                const mimeType = asset.mimeType || "image/jpeg";
                await uploadAttachment(asset.uri, name, mimeType);
              }
            }
          },
        },
        {
          text: "Browse Files",
          onPress: async () => {
            try {
              const result = await DocumentPicker.getDocumentAsync({
                type: "*/*",
                multiple: true,
                copyToCacheDirectory: true,
              });
              if (!result.canceled && result.assets && result.assets.length > 0) {
                for (const asset of result.assets) {
                  const mimeType = asset.mimeType || inferMimeType(asset.name) || "application/octet-stream";
                  await uploadAttachment(asset.uri, asset.name, mimeType);
                }
              }
            } catch {
              Alert.alert("Error", "Unable to open file browser.");
            }
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  function inferMimeType(fileName: string): string | null {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      pdf: "application/pdf",
      stl: "model/stl",
      obj: "model/obj",
      ply: "model/ply",
      zip: "application/zip",
      dcm: "application/dicom",
    };
    return ext ? (map[ext] ?? null) : null;
  }

  function handleFinishPhotos() {
    if (finishPhotosRef.current) return;
    finishPhotosRef.current = true;

    const photosToSave = [...capturedPhotos];
    const noteToSave = photoNotes.trim();
    const caseId = caseItem!.id;
    const caseNumber = caseItem!.caseNumber;

    setCapturedPhotos([]);
    setPhotoNotes("");
    setShowPhotoNotes(false);
    setShowPhotoPreview(false);

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    (async () => {
      try {
        await addCasePhotosWithNote(caseId, photosToSave, noteToSave, userInitials);
        if (userType === "provider") {
          const photoCount = photosToSave.length;
          const hasNotes = !!noteToSave;
          const parts: string[] = [];
          parts.push(`${photoCount} file${photoCount > 1 ? "s" : ""}`);
          if (hasNotes) parts.push("notes");
          addNotification({
            title: "Provider Media Added",
            message: `${currentUser || "Provider"} added ${parts.join(" and ")} to Case ${caseNumber}`,
            type: "alert",
            caseId,
          });
        }
      } finally {
        finishPhotosRef.current = false;
      }
    })();
  }

  function handleSaveNote() {
    if (!noteText.trim()) return;
    addCaseNote(caseItem!.id, noteText.trim(), userInitials);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setNoteText("");
    setShowNoteModal(false);
  }

  async function handleEntryTakePhoto() {
    if (Platform.OS === "web") {
      try {
        const uri = await webFilePickerForCamera();
        if (uri) {
          setEntryPhotos((prev) => [...prev, uri]);
        }
      } catch (e) {
        Alert.alert("Camera Error", "Unable to open camera.");
      }
      return;
    }
    requestCameraWithPrompt(async () => {
      try {
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          quality: 1.0,
          allowsEditing: false,
        });
        if (!result.canceled && result.assets[0]) {
          setEntryPhotos((prev) => [...prev, result.assets[0].uri]);
        }
      } catch {
        Alert.alert("Camera Error", "Unable to open camera.");
      }
    });
  }

  async function handleEntrySavePhotos() {
    await Promise.all(entryPhotos.map((uri) => addCasePhoto(caseItem!.id, uri, userInitials)));
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setEntryPhotos([]);
    setEntryPhotoMode(false);
    Alert.alert("Photos Added", `${entryPhotos.length} photo(s) added to this case.`, [
      { text: "OK", onPress: () => promptForNotes() },
    ]);
  }

  function handleEntrySkipPhotos() {
    setEntryPhotoMode(false);
    promptForNotes();
  }

  function promptForNotes() {
    Alert.alert(
      "Add Notes",
      "Would you like to add any notes to this case?",
      [
        { text: "No", style: "cancel", onPress: () => setShowEntryPrompt(false) },
        { text: "Yes", onPress: () => setEntryNoteMode(true) },
      ]
    );
  }

  function handleEntrySaveNote() {
    if (entryNoteText.trim()) {
      addCaseNote(caseItem!.id, entryNoteText.trim(), userInitials);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setEntryNoteText("");
    setEntryNoteMode(false);
    setShowEntryPrompt(false);
  }

  async function handleProviderAddMedia() {
    Alert.alert(
      "Add Photo/Video",
      "Choose a source",
      [
        {
          text: "Take Photo",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) {
                  await addCasePhoto(caseItem!.id, uri, userInitials);
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  Alert.alert("Photo Added", "Photo has been attached to this case.");
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(async () => {
              try {
                const result = await ImagePicker.launchCameraAsync({
                  mediaTypes: ["images"],
                  quality: 1.0,
                });
                if (!result.canceled && result.assets[0]) {
                  await addCasePhoto(caseItem!.id, result.assets[0].uri, userInitials);
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  Alert.alert("Photo Added", "Photo has been attached to this case.");
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
            });
          },
        },
        {
          text: "Record Video",
          onPress: async () => {
            if (Platform.OS === "web") {
              try {
                const uri = await webFilePickerForCamera();
                if (uri) {
                  await addCasePhoto(caseItem!.id, uri, userInitials);
                  Alert.alert("Media Added", "Media has been attached to this case.");
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
              return;
            }
            requestCameraWithPrompt(async () => {
              try {
                const result = await ImagePicker.launchCameraAsync({
                  mediaTypes: ["videos"],
                  quality: 1.0,
                  videoMaxDuration: 60,
                });
                if (!result.canceled && result.assets[0]) {
                  await addCasePhoto(caseItem!.id, result.assets[0].uri, userInitials);
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  Alert.alert("Video Added", "Video has been attached to this case.");
                }
              } catch {
                Alert.alert("Camera Error", "Unable to open camera.");
              }
            });
          },
        },
        {
          text: "Choose from Gallery",
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Permission needed", "Gallery access is required.");
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images", "videos"],
              quality: 1.0,
              allowsMultipleSelection: true,
            });
            if (!result.canceled && result.assets.length > 0) {
              await Promise.all(result.assets.map((asset) => addCasePhoto(caseItem!.id, asset.uri, userInitials)));
              if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert("Media Added", `${result.assets.length} file(s) attached to this case.`);
            }
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.header,
          {
            paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12,
          },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.light.text} />
        </Pressable>
        <View>
          <Text style={styles.headerTitle}>{caseItem.caseNumber}</Text>
          <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary, textAlign: "center" }}>Case & Invoice #{caseItem.caseNumber}</Text>
        </View>
        <ChatButton />
      </View>

      <KeyboardAwareScrollViewCompat
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 34 + 40 : insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        bottomOffset={24}
        refreshControl={
          Platform.OS !== "web" ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await hardRefresh();
                setRefreshing(false);
              }}
            />
          ) : undefined
        }
      >
        {caseItem.isRemake && (
          <Pressable
            onPress={() => {
              if (caseItem.remakeOfCaseId) {
                router.push(`/case/${encodeURIComponent(caseItem.remakeOfCaseId)}`);
              } else {
                router.push(
                  `/chart-history?patient=${encodeURIComponent(caseItem.patientName || "")}`,
                );
              }
            }}
            style={{
              marginHorizontal: 16,
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              backgroundColor: "#DBEAFE",
              borderLeftWidth: 4,
              borderLeftColor: "#2563EB",
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            <MaterialCommunityIcons name="sync-alert" size={18} color="#1E40AF" style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#1E40AF" }}>
                Remake{caseItem.remakeCharged === false || caseItem.price === 0 ? " — no charge" : ""}
              </Text>
              {caseItem.remakeReason ? (
                <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#1E40AF", marginTop: 2 }}>
                  Reason: {caseItem.remakeReason}
                </Text>
              ) : null}
              <Text style={{ fontSize: 10, fontFamily: "Inter_500Medium", color: "#1E40AF", marginTop: 4, textDecorationLine: "underline" }}>
                {caseItem.remakeOfCaseId ? "Open original case →" : "View patient chart →"}
              </Text>
            </View>
          </Pressable>
        )}
        {(() => {
          const children = cases.filter((c) => c.remakeOfCaseId === caseItem.id);
          if (children.length === 0) return null;
          return (
            <View style={{
              marginHorizontal: 16,
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              backgroundColor: "#EEF2FF",
              borderLeftWidth: 4,
              borderLeftColor: "#4F46E5",
              gap: 6,
            }}>
              <Text style={{ fontSize: 12, fontFamily: "Inter_700Bold", color: "#3730A3" }}>
                Remade by {children.length} case{children.length === 1 ? "" : "s"}
              </Text>
              {children.map((c) => (
                <Pressable key={c.id} onPress={() => router.push(`/case/${encodeURIComponent(c.id)}`)}>
                  <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#3730A3", textDecorationLine: "underline" }}>
                    {c.caseNumber}{c.remakeCharged === false ? " (no charge)" : ""}
                    {c.remakeReason ? ` — ${c.remakeReason}` : ""}
                  </Text>
                </Pressable>
              ))}
            </View>
          );
        })()}
        {fullCaseData?.needsAiReview && (
          <View style={{
            marginHorizontal: 16,
            marginTop: 12,
            padding: 12,
            borderRadius: 10,
            backgroundColor: "#FEF3C7",
            borderLeftWidth: 4,
            borderLeftColor: "#D97706",
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 10,
          }}>
            <MaterialCommunityIcons name="auto-fix" size={18} color="#92400E" style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#92400E" }}>
                AI-imported — needs review
              </Text>
              <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#92400E", marginTop: 2 }}>
                This case was auto-created from {fullCaseData?.aiImportSource || "an external source"}. Verify patient, doctor, and Rx attachment before routing.
              </Text>
            </View>
            <Pressable
              onPress={async () => {
                try {
                  await resilientFetch(`/api/cases/${encodeURIComponent(String(id))}/ai-review`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ acknowledged: true }),
                  });
                  setFullCaseData((prev) => (prev ? { ...prev, needsAiReview: false } : prev));
                } catch (err: any) {
                  Alert.alert("Could not dismiss", err?.message || "Try again later.");
                }
              }}
              style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#92400E", borderRadius: 6 }}
            >
              <Text style={{ color: "white", fontSize: 11, fontFamily: "Inter_600SemiBold" }}>Dismiss</Text>
            </Pressable>
          </View>
        )}
        {isAdmin && (
        <Pressable
          style={[styles.statusCard, (caseItem.status === "COMPLETE" || caseItem.status === "SHIP") && styles.statusCardTappable]}
          onPress={() => {
            if (caseItem.status === "COMPLETE" || caseItem.status === "SHIP") {
              setShowCompleteInfo(true);
              if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
          }}
          disabled={caseItem.status !== "COMPLETE" && caseItem.status !== "SHIP"}
        >
          <View
            style={[
              styles.statusIndicator,
              { backgroundColor: stationInfo.color },
            ]}
          />
          <View style={styles.statusInfo}>
            <Text style={styles.statusLabel}>CURRENT STATION</Text>
            <Text style={styles.statusValue}>{stationInfo.label}</Text>
          </View>
          {caseItem.isRush && (
            <View style={styles.rushBadge}>
              <Ionicons name="flash" size={14} color="#EF4444" />
              <Text style={styles.rushText}>RUSH</Text>
            </View>
          )}
          {(caseItem.status === "COMPLETE" || caseItem.status === "SHIP") && (
            <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
          )}
        </Pressable>
        )}

        <Pressable
          style={styles.infoGrid}
          onPress={() => {
            if (!isAdmin) return;
            setQeDoctor(caseItem.doctorName || "");
            setQePatient((caseItem as any).patientName || caseItem.patientInitials || "");
            setQeTeeth(caseItem.toothIndices || "");
            setQeShade(caseItem.shade || "");
            setQeMaterial(caseItem.material || "");
            setQeDueDate(caseItem.dueDate || "");
            setQeNotes(caseItem.notes || "");
            setShowQuickEdit(true);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }}
        >
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Doctor</Text>
            <Text style={styles.infoValue}>{cleanDoctorDisplay(caseItem.doctorName)}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Patient</Text>
            <Text style={styles.infoValue}>
              {(caseItem as any).patientName || caseItem.patientInitials}
            </Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Teeth</Text>
            <Text style={styles.infoValue}>{caseItem.toothIndices}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Shade</Text>
            <Text style={styles.infoValue}>{caseItem.shade}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Material</Text>
            <Text style={styles.infoValue}>{caseItem.material}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Due</Text>
            <Text style={styles.infoValue}>{(() => {
              if (!caseItem.dueDate) return "—";
              const d = new Date(caseItem.dueDate + "T00:00:00");
              return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
            })()}</Text>
          </View>
          {showPrice && (
            <View style={styles.infoItem}>
              <Text style={styles.infoLabel}>Price</Text>
              <Text style={[styles.infoValue, { color: Colors.light.tint }]}>
                ${(caseItem.price ?? 0).toFixed(2)}
              </Text>
            </View>
          )}
          {isAdmin && (
            <View style={{ position: "absolute", top: 8, right: 8 }}>
              <Ionicons name="pencil" size={14} color={Colors.light.textTertiary} />
            </View>
          )}
        </Pressable>

        {(() => {
          const summary = caseToRxSummary(caseItem);
          const hasAny =
            summary.restorativeType !== null ||
            summary.materials.length > 0 ||
            summary.teeth.length > 0 ||
            summary.isFullArch !== null;
          const noteEntries = (caseItem.activityLog || [])
            .filter((e) => e.type === "note")
            .sort((a, b) => b.timestamp - a.timestamp);
          const hasNotes =
            noteEntries.length > 0 || (caseItem.notes || "").trim().length > 0;
          return (
            <View style={styles.rxSummaryCard}>
              <Text style={styles.rxSummaryHeading}>Rx Summary</Text>
              {!hasAny ? (
                <View style={styles.rxSummaryEmpty}>
                  <Text style={styles.rxSummaryEmptyText}>
                    No restorations on this case yet. Add one in the
                    Restorations tab to populate this summary.
                  </Text>
                </View>
              ) : (
                <View style={{ gap: 12 }}>
                  <View style={styles.rxSummaryGrid}>
                    <View style={styles.rxSummaryField}>
                      <Text style={styles.rxSummaryLabel}>Restorative type</Text>
                      <Text style={styles.rxSummaryValue}>
                        {summary.restorativeType ?? "Other"}
                      </Text>
                    </View>
                    <View style={styles.rxSummaryField}>
                      <Text style={styles.rxSummaryLabel}>
                        {summary.materials.length > 1 ? "Materials" : "Material"}
                      </Text>
                      <Text style={styles.rxSummaryValue}>
                        {summary.materials.length > 0
                          ? summary.materials.join(", ")
                          : "—"}
                      </Text>
                    </View>
                    <View style={[styles.rxSummaryField, { width: "100%" }]}>
                      <Text style={styles.rxSummaryLabel}>
                        {summary.isFullArch
                          ? "Tooth coverage"
                          : "Tooth number(s)"}
                      </Text>
                      <Text style={styles.rxSummaryValue}>
                        {formatRxTeethLabel(summary)}
                      </Text>
                    </View>
                  </View>
                  <ReadOnlyToothChart
                    highlighted={buildHighlightedToothSet(summary)}
                  />
                  <View>
                    <Text style={styles.rxSummaryLabel}>Notes</Text>
                    {!hasNotes ? (
                      <View style={styles.rxSummaryNotesEmpty}>
                        <Text style={styles.rxSummaryNotesEmptyText}>
                          No notes yet.
                        </Text>
                      </View>
                    ) : (
                      <View style={{ gap: 6 }}>
                        {noteEntries.length > 0 ? (
                          noteEntries.map((entry) => (
                            <View
                              key={entry.id}
                              style={styles.rxSummaryNoteRow}
                            >
                              <Text style={styles.rxSummaryNoteText}>
                                {entry.description || "—"}
                              </Text>
                              <Text style={styles.rxSummaryNoteMeta}>
                                {new Date(entry.timestamp).toLocaleDateString(
                                  undefined,
                                  { month: "short", day: "numeric" },
                                )}
                              </Text>
                            </View>
                          ))
                        ) : (
                          <View style={styles.rxSummaryNoteRow}>
                            <Text style={styles.rxSummaryNoteText}>
                              {caseItem.notes}
                            </Text>
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                </View>
              )}
            </View>
          );
        })()}

        {isAdmin && (
          <View style={{ flexDirection: "row", gap: 8, marginHorizontal: 16, marginBottom: 16 }}>
            <Pressable
              onPress={() => {
                setShowInvoiceModal(true);
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              style={({ pressed }) => [
                {
                  flex: 1,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  justifyContent: "center" as const,
                  gap: 8,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: "#2563EB",
                },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="document-text" size={18} color="#FFF" />
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>View/Edit Invoice</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                openEditCase();
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              style={({ pressed }) => [
                {
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  justifyContent: "center" as const,
                  gap: 6,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderRadius: 12,
                  backgroundColor: "#7C3AED",
                },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="create" size={18} color="#FFF" />
              <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Edit Case</Text>
            </Pressable>
          </View>
        )}

        {(() => {
          const patientCaseCount = cases.filter(
            (c) => (c.patientName || "").toLowerCase() === (caseItem.patientName || "").toLowerCase()
          ).length;
          if (patientCaseCount > 1 || caseItem.isRemake) {
            return (
              <Pressable
                onPress={() => router.push(`/chart-history?patient=${encodeURIComponent(caseItem.patientName)}`)}
                style={({ pressed }) => [
                  styles.chartHistoryBtn,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Ionicons name="play-circle" size={22} color="#3B82F6" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.chartHistoryBtnTitle}>Entire Chart History</Text>
                  <Text style={styles.chartHistoryBtnSub}>{patientCaseCount} case{patientCaseCount !== 1 ? "s" : ""} on file</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
              </Pressable>
            );
          }
          return null;
        })()}

        {(() => {
          const noteEntries = (caseItem.activityLog || [])
            .filter((e) => e.type === "note")
            .sort((a, b) => a.timestamp - b.timestamp);
          if (noteEntries.length === 0 && !caseItem.notes) return null;
          return (
            <View style={styles.notesCard}>
              <Text style={styles.notesLabel}>Notes</Text>
              {noteEntries.length > 0 ? noteEntries.map((entry) => (
                (() => {
                  const matchingRegisteredUser = entry.user
                    ? registeredUsers.find(
                        (user) =>
                          user.id === entry.user ||
                          user.username?.toLowerCase() === (entry.user ?? "").toLowerCase()
                      )
                    : null;
                  const entryInitials = entry.user
                    ? deriveDisplayInitials({
                        firstName: matchingRegisteredUser?.firstName,
                        lastName: matchingRegisteredUser?.lastName,
                        label: matchingRegisteredUser?.username || entry.user,
                      })
                    : "";
                  return (
                <View key={entry.id} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 8, gap: 10 }}>
                  <View style={{ minWidth: 70 }}>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.light.textTertiary }}>
                      {new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </Text>
                    <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>
                      {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}
                    </Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text, lineHeight: 20 }}>
                    {entry.description}
                  </Text>
                  {entry.user ? (
                    <View style={{ backgroundColor: "rgba(0,0,0,0.06)", borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 }}>
                      <Text style={{ fontSize: 11, fontFamily: "Inter_700Bold", color: Colors.light.textSecondary }}>{entryInitials}</Text>
                    </View>
                  ) : null}
                </View>
                  );
                })()
              )) : (
                <Text style={styles.notesText}>{caseItem.notes}</Text>
              )}
            </View>
          );
        })()}

        {(caseItem.photos?.length ?? 0) > 0 && (
          <View style={{ marginBottom: 16 }}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Photos ({caseItem.photos!.length})</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
              {caseItem.photos!.map((uri, idx) => (
                <Pressable key={idx} onPress={() => setFullScreenPhoto(uri)}>
                  <Image
                    source={{ uri }}
                    style={styles.photoThumb}
                  />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
            <View style={[styles.sectionHeader, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.sectionTitle}>
                  Attachments{serverAttachments.length > 0 ? ` (${serverAttachments.length})` : ""}
                </Text>
                {attachmentsFetchError && (
                  <Pressable
                    onPress={() => void fetchServerAttachments()}
                    hitSlop={8}
                  >
                    <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#EF4444" }}>
                      Failed · Retry
                    </Text>
                  </Pressable>
                )}
              </View>
              <Pressable
                onPress={handleAttachFile}
                disabled={uploadingAttachment}
                style={({ pressed }) => ({
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  gap: 4,
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  backgroundColor: pressed || uploadingAttachment ? "rgba(0,0,0,0.06)" : "transparent",
                  borderWidth: 1,
                  borderColor: Colors.light.border,
                })}
              >
                <Ionicons name="attach-outline" size={16} color={Colors.light.tint} />
                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>
                  {uploadingAttachment ? "Uploading…" : "Attach file"}
                </Text>
              </Pressable>
            </View>
            {serverAttachments.map((att) => {
              const isImage = (att.fileType || "").startsWith("image/");
              const ext = att.fileName.split(".").pop()?.toLowerCase() ?? "";
              const is3D = SCAN_MIME_TYPES.has(att.fileType || "") || SCAN_EXTENSIONS.has(ext);
              const fileTypeLabel = is3D ? "3D Scan" : isImage ? "Image" : att.fileType || "File";
              const iconName: ComponentProps<typeof Ionicons>["name"] = isImage
                ? "image-outline"
                : att.fileType === "application/pdf"
                ? "document-text-outline"
                : is3D
                ? "cube-outline"
                : "document-outline";
              const fileUrl = `${att.storageKey}`;
              return (
                <Pressable
                  key={att.id}
                  onPress={async () => {
                    if (!fileUrl) return;
                    if (is3D) {
                      if (downloadingAttachmentId === att.id) return;
                      const mimeType = att.fileType || "application/octet-stream";
                      const fullUrl = fileUrl.startsWith("http")
                        ? fileUrl
                        : new URL(fileUrl, getApiUrl()).toString();
                      const cacheDir = FileSystem.Paths.cache.uri;
                      const localUri = cacheDir.endsWith("/") ? cacheDir + att.fileName : cacheDir + "/" + att.fileName;
                      setDownloadingAttachmentId(att.id);
                      setDownloadProgress(0);
                      try {
                        const token = getAccessToken();
                        const downloadResumable = FileSystem.createDownloadResumable(
                          fullUrl,
                          localUri,
                          token ? { headers: { Authorization: `Bearer ${token}` } } : {},
                          (progressData) => {
                            const { totalBytesWritten, totalBytesExpectedToWrite } = progressData;
                            if (totalBytesExpectedToWrite > 0) {
                              setDownloadProgress(totalBytesWritten / totalBytesExpectedToWrite);
                            }
                          },
                        );
                        const downloadRes = await downloadResumable.downloadAsync();
                        if (!downloadRes || downloadRes.status !== 200) {
                          Alert.alert("Download failed", "Could not download the scan file.");
                          return;
                        }
                        const canShare = await Sharing.isAvailableAsync();
                        if (canShare) {
                          await Sharing.shareAsync(downloadRes.uri, {
                            mimeType,
                            dialogTitle: att.fileName,
                          });
                        } else {
                          Alert.alert(
                            "Sharing not available",
                            "Install a 3D viewer app (e.g. Formlabs, Meshmixer) to open .stl and other scan files.",
                          );
                        }
                      } catch {
                        Alert.alert("Unable to open", "Could not download or share this scan file.");
                      } finally {
                        setDownloadingAttachmentId(null);
                        setDownloadProgress(0);
                      }
                      return;
                    }
                    Linking.openURL(fileUrl).catch(() => {
                      Alert.alert("Unable to open", "Could not open this file.");
                    });
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row" as const,
                    alignItems: "center" as const,
                    gap: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    backgroundColor: pressed ? "rgba(0,0,0,0.04)" : "#F8FAFC",
                    borderRadius: 10,
                    marginTop: 6,
                    borderWidth: 1,
                    borderColor: Colors.light.border,
                  })}
                >
                  <Ionicons name={iconName} size={22} color={downloadingAttachmentId === att.id ? Colors.light.textSecondary : Colors.light.tint} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.text }} numberOfLines={1}>
                      {att.fileName}
                    </Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, marginTop: 1 }}>
                      {downloadingAttachmentId === att.id
                        ? (downloadProgress > 0
                            ? `Downloading… ${Math.round(downloadProgress * 100)}%`
                            : "Downloading…")
                        : [
                            fileTypeLabel,
                            att.uploaderName,
                            att.createdAt
                              ? new Date(att.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                    </Text>
                    {downloadingAttachmentId === att.id && downloadProgress > 0 && (
                      <View style={{ height: 3, backgroundColor: "rgba(0,0,0,0.08)", borderRadius: 2, marginTop: 5, overflow: "hidden" }}>
                        <View style={{ height: 3, backgroundColor: Colors.light.tint, borderRadius: 2, width: `${Math.round(downloadProgress * 100)}%` }} />
                      </View>
                    )}
                  </View>
                  {downloadingAttachmentId === att.id
                    ? <ActivityIndicator size="small" color={Colors.light.tint} />
                    : <Ionicons name={is3D ? "share-outline" : "open-outline"} size={16} color={Colors.light.textTertiary} />
                  }
                </Pressable>
              );
            })}
            {uploadingAttachment && (
              <View style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 12,
                backgroundColor: "#F0F9FF",
                borderRadius: 10,
                marginTop: 6,
                borderWidth: 1,
                borderColor: "#BAE6FD",
              }}>
                <Ionicons name="cloud-upload-outline" size={22} color="#0EA5E9" />
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#0369A1" }}>
                  Uploading…
                </Text>
              </View>
            )}
          </View>

        <View style={[styles.sectionHeader, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
          <Text style={styles.sectionTitle}>Case History</Text>
          <Pressable
            onPress={handlePrintCaseHistory}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 8,
              backgroundColor: pressed ? "rgba(0,0,0,0.06)" : "transparent",
              borderWidth: 1,
              borderColor: Colors.light.border,
            })}
            testID="print-case-history-btn"
            accessibilityLabel="Print case history"
          >
            <Ionicons name="print-outline" size={16} color={Colors.light.tint} />
            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>Print</Text>
          </Pressable>
        </View>
        <View style={styles.timeline}>
          {(() => {
            type TaggedEntry = ActivityEntry & { _source: "original" | "current" };

            const sortedOriginal: TaggedEntry[] = [...originalActivityLog]
              .sort((a, b) => a.timestamp - b.timestamp)
              .map(e => ({ ...e, _source: "original" as const }));
            const hasOriginal = sortedOriginal.length > 0;

            // When combined with original entries the whole timeline reads
            // chronologically (oldest → newest). For non-remake cases the
            // existing newest-first order is preserved.
            const sortCurrentAsc = hasOriginal;
            const currentRaw: ActivityEntry[] = caseItem.activityLog && caseItem.activityLog.length > 0
              ? (() => {
                  const sorted = [...caseItem.activityLog].sort((a, b) =>
                    sortCurrentAsc ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
                  );
                  const photoTimestamps = sorted.filter(e => e.type === "photo" || e.type === "video").map(e => e.timestamp);
                  return sorted.filter(entry => {
                    if (entry.type !== "note") return true;
                    return !photoTimestamps.some(pt => Math.abs(pt - entry.timestamp) < 5000);
                  });
                })()
              : [...(caseItem.routeHistory ?? [])].sort((a, b) =>
                  sortCurrentAsc ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
                ).map((rh) => ({
                  id: String(rh.timestamp),
                  type: "station_change" as const,
                  timestamp: rh.timestamp,
                  description: `Case moved to ${getStationInfo(rh.station, customStationLabels).label}`,
                  station: rh.station,
                  user: undefined as string | undefined,
                }));

            const currentEntries: TaggedEntry[] = currentRaw.map(e => ({ ...e, _source: "current" as const }));
            const allEntries: TaggedEntry[] = [...sortedOriginal, ...currentEntries];

            return allEntries.map((entry, idx, arr) => {
            const isLast = idx === arr.length - 1;
            const isFirstCurrentEntry = hasOriginal && entry._source === "current" && (idx === 0 || arr[idx - 1]?._source === "original");
            const isFirst = !hasOriginal ? idx === 0 : isFirstCurrentEntry;
            const isStation = entry.type === "station_change" || entry.type === "created" || entry.type === "scan";
            const isNote = entry.type === "note";
            const isPhoto = entry.type === "photo";
            const isVideo = entry.type === "video";
            const isBarcode = entry.type === "barcode_assigned" || entry.type === "barcode_unassigned";
            const isInvoice = entry.type === "invoice_paid" || entry.type === "invoice_attached";
            const isTracking = entry.type === "tracking_added";
            const isCourtesy = entry.type === "courtesy_text";
            const isExocad = entry.type === "exocad_linked" || entry.type === "exocad_shared";
            const isEvent = isBarcode || isInvoice || isTracking || isCourtesy || isExocad;
            const stationInfo = entry.station ? getStationInfo(entry.station, customStationLabels) : null;

            let dotColor = Colors.light.textTertiary;

            if (isStation && stationInfo) {
              dotColor = isFirst ? stationInfo.color : Colors.light.textTertiary;
            } else if (isNote) {
              dotColor = "#F59E0B";
            } else if (isPhoto || isVideo) {
              dotColor = "#8B5CF6";
            } else if (isBarcode) {
              dotColor = "#10B981";
            } else if (isInvoice) {
              dotColor = "#3B82F6";
            } else if (isTracking) {
              dotColor = "#6366F1";
            } else if (isCourtesy) {
              dotColor = "#EC4899";
            } else if (isExocad) {
              dotColor = "#7C3AED";
            }

            const matchingRegisteredUser = entry.user
              ? registeredUsers.find(
                  (user) =>
                    user.id === entry.user ||
                    user.username?.toLowerCase() === (entry.user ?? "").toLowerCase()
                )
              : null;
            const entryUserName = entry.user
              ? (
                  users.find((u) => u.id === entry.user || u.name === entry.user)?.name ||
                  matchingRegisteredUser?.username ||
                  entry.user
                )
              : "";
            const entryUserInitials = entryUserName
              ? deriveDisplayInitials({
                  firstName: matchingRegisteredUser?.firstName,
                  lastName: matchingRegisteredUser?.lastName,
                  label: entryUserName,
                })
              : (isStation ? "" : (role === "admin" ? "A" : "U"));

            return (
              <React.Fragment key={entry.id || String(idx)}>
                {isFirstCurrentEntry && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 10, paddingHorizontal: 4 }}>
                    <View style={{ flex: 1, height: 1, backgroundColor: Colors.light.border }} />
                    <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: Colors.light.textSecondary, textTransform: "uppercase", letterSpacing: 0.8 }}>
                      Case {caseItem.caseNumber}
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: Colors.light.border }} />
                  </View>
                )}
              <View style={[styles.timelineItem, entry._source === "original" && { opacity: 0.6 }]}>
                <View style={styles.timelineLine}>
                  <View
                    style={[
                      styles.timelineDot,
                      { backgroundColor: dotColor, justifyContent: "center", alignItems: "center" },
                    ]}
                  >
                    {entryUserInitials ? (
                      <Text style={{ fontSize: 8, fontFamily: "Inter_700Bold", color: "#FFF" }}>{entryUserInitials}</Text>
                    ) : (
                      <Ionicons name="navigate" size={10} color="#FFF" />
                    )}
                  </View>
                  {!isLast && <View style={styles.timelineConnector} />}
                </View>
                <View style={[styles.timelineContent, (isPhoto || isVideo) && entry.imageUri ? { paddingBottom: 20 } : {}]}>
                  {isStation && stationInfo ? (
                    <View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text
                          style={[
                            styles.timelineStation,
                            isFirst && { color: stationInfo.color, fontFamily: "Inter_700Bold" },
                          ]}
                        >
                          {stationInfo.label}
                        </Text>
                        {entry.user && (
                          <View style={styles.initialsChip}>
                            <Text style={styles.initialsText}>{entryUserInitials}</Text>
                          </View>
                        )}
                      </View>
                      {entry.station === "INTAKE" && caseItem.assignedBarcode && (
                        <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.light.tint, marginTop: 2 }}>
                          Case Pan: {caseItem.assignedBarcode}
                        </Text>
                      )}
                    </View>
                  ) : isEvent ? (
                    <Pressable
                      onPress={() => {
                        if (isInvoice && isAdmin) {
                          setShowInvoiceModal(true);
                          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        } else if (isTracking && entry.description) {
                          const trackMatch = entry.description.match(/tracking[:\s#]*([A-Za-z0-9]+)/i);
                          if (trackMatch) Alert.alert("Tracking Number", trackMatch[1]);
                          else Alert.alert("Tracking", entry.description);
                        } else if (isBarcode) {
                          Alert.alert("Barcode", entry.description);
                        } else if (isCourtesy) {
                          Alert.alert("Courtesy Text", entry.description);
                        }
                      }}
                      style={{
                        backgroundColor: isBarcode ? "#ECFDF5" : isInvoice ? "#EFF6FF" : isTracking ? "#EEF2FF" : "#FDF2F8",
                        borderRadius: 10,
                        padding: 10,
                        borderLeftWidth: 3,
                        borderLeftColor: isBarcode ? "#10B981" : isInvoice ? "#3B82F6" : isTracking ? "#6366F1" : "#EC4899",
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <Ionicons
                          name={isBarcode ? "barcode" : isInvoice ? (entry.type === "invoice_paid" ? "card" : "receipt") : isTracking ? "airplane" : "chatbubble-ellipses"}
                          size={13}
                          color={isBarcode ? "#059669" : isInvoice ? "#2563EB" : isTracking ? "#4F46E5" : "#DB2777"}
                        />
                        <Text style={{
                          fontSize: 11,
                          fontFamily: "Inter_600SemiBold",
                          color: isBarcode ? "#059669" : isInvoice ? "#2563EB" : isTracking ? "#4F46E5" : "#DB2777",
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                        }}>
                          {isBarcode ? (entry.type === "barcode_assigned" ? "Barcode Assigned" : "Barcode Removed")
                            : isInvoice ? (entry.type === "invoice_paid" ? "Payment" : "Invoice")
                            : isTracking ? "Tracking" : "Courtesy Text"}
                        </Text>
                        {entry.user && (
                          <View style={styles.initialsChip}>
                            <Text style={styles.initialsText}>{entryUserInitials}</Text>
                          </View>
                        )}
                        {(isInvoice && isAdmin) && (
                          <View style={{ marginLeft: "auto" }}>
                            <Ionicons name="open-outline" size={14} color="#2563EB" />
                          </View>
                        )}
                      </View>
                      <Text style={{
                        fontSize: 13,
                        fontFamily: "Inter_500Medium",
                        color: Colors.light.text,
                        lineHeight: 18,
                      }}>
                        {entry.description}
                      </Text>
                      {(isInvoice && isAdmin) && (
                        <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#2563EB", marginTop: 4 }}>Tap to view invoice</Text>
                      )}
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => {
                        if (isPhoto && entry.imageUri) {
                          setFullScreenPhoto(entry.imageUri);
                        } else if (isVideo && entry.imageUri) {
                          if (Platform.OS === "web") {
                            (window as any).open(entry.imageUri, "_blank");
                          } else {
                            Linking.openURL(entry.imageUri).catch(() =>
                              Alert.alert("Cannot play video", "Unable to open video on this device.")
                            );
                          }
                        } else if (isNote) {
                          Alert.alert("Note", entry.description);
                        }
                      }}
                      style={{
                        backgroundColor: isNote ? "#FFF7ED" : "#F5F3FF",
                        borderRadius: 10,
                        padding: 10,
                        borderLeftWidth: 3,
                        borderLeftColor: isNote ? "#F59E0B" : "#8B5CF6",
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <Ionicons
                          name={isNote ? "document-text" : isVideo ? "videocam" : "camera"}
                          size={13}
                          color={isNote ? "#D97706" : "#7C3AED"}
                        />
                        <Text style={{
                          fontSize: 11,
                          fontFamily: "Inter_600SemiBold",
                          color: isNote ? "#D97706" : "#7C3AED",
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                        }}>
                          {isNote ? "Note" : isVideo ? "Video" : "Photo"}
                        </Text>
                        {entry.user && (
                          <View style={styles.initialsChip}>
                            <Text style={styles.initialsText}>{entryUserInitials}</Text>
                          </View>
                        )}
                        {(isPhoto || isVideo) && entry.imageUri && (
                          <View style={{ marginLeft: "auto" }}>
                            <Ionicons name={isVideo ? "play-circle-outline" : "expand-outline"} size={14} color="#7C3AED" />
                          </View>
                        )}
                      </View>
                      <Text style={{
                        fontSize: 13,
                        fontFamily: "Inter_500Medium",
                        color: Colors.light.text,
                        lineHeight: 18,
                      }}>
                        {entry.description}
                      </Text>
                      {isPhoto && entry.imageUri && (
                        <Image
                          source={{ uri: entry.imageUri }}
                          style={{
                            width: "100%",
                            height: 120,
                            borderRadius: 8,
                            marginTop: 8,
                          }}
                          resizeMode="cover"
                        />
                      )}
                      {isVideo && entry.imageUri && (
                        <View style={{
                          width: "100%",
                          height: 80,
                          borderRadius: 8,
                          marginTop: 8,
                          backgroundColor: "#1E1B2E",
                          alignItems: "center",
                          justifyContent: "center",
                          flexDirection: "row",
                          gap: 8,
                        }}>
                          <Ionicons name="play-circle" size={32} color="#A78BFA" />
                          <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#C4B5FD" }}>Tap to play video</Text>
                        </View>
                      )}
                      {(isPhoto || isVideo) && (() => {
                        const nearbyNote = (caseItem.activityLog || []).find(
                          (e) => e.type === "note" && Math.abs(e.timestamp - entry.timestamp) < 5000
                        );
                        if (!nearbyNote) return null;
                        return (
                          <View style={{
                            marginTop: 8,
                            paddingTop: 8,
                            borderTopWidth: 1,
                            borderTopColor: "#E9D5FF",
                          }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 4 }}>
                              <Ionicons name="document-text" size={12} color="#7C3AED" />
                              <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#7C3AED", textTransform: "uppercase", letterSpacing: 0.5 }}>Note</Text>
                            </View>
                            <Text style={{
                              fontSize: 13,
                              fontFamily: "Inter_400Regular",
                              color: Colors.light.text,
                              lineHeight: 18,
                            }}>
                              {nearbyNote.description}
                            </Text>
                          </View>
                        );
                      })()}
                    </Pressable>
                  )}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={styles.timelineTime}>
                      {formatTimestamp(entry.timestamp)}
                    </Text>
                    {entry._source === "original" && (
                      <View style={{ backgroundColor: "#F1F5F9", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                        <Text style={{ fontSize: 9, fontFamily: "Inter_600SemiBold", color: "#64748B", textTransform: "uppercase", letterSpacing: 0.4 }}>
                          {originalCaseNumber ?? "Original"}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>
              </React.Fragment>
            );
          });
          })()}
        </View>

        <View style={styles.actionSection}>
          {userType !== "provider" && (
            <Pressable
              onPress={() => setShowRouting(!showRouting)}
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: Colors.light.tint },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="navigate" size={20} color="#FFF" />
              <Text style={styles.actionBtnText}>
                {showRouting ? "Hide Stations" : "Locate Case"}
              </Text>
            </Pressable>
          )}

          {showRouting && userType !== "provider" && (
            <View style={styles.stationGrid}>
              {STATIONS.map((station) => {
                const isCurrent = station.id === caseItem.status;
                return (
                  <Pressable
                    key={station.id}
                    onPress={() => !isCurrent && handleRoute(station.id)}
                    style={[
                      styles.stationChip,
                      isCurrent && {
                        borderColor: station.color,
                        backgroundColor: station.color + "15",
                      },
                    ]}
                    disabled={isCurrent}
                  >
                    <View
                      style={[
                        styles.stationDot,
                        { backgroundColor: station.color },
                      ]}
                    />
                    <Text
                      style={[
                        styles.stationText,
                        isCurrent && {
                          color: station.color,
                          fontFamily: "Inter_700Bold",
                        },
                      ]}
                    >
                      {station.label}
                    </Text>
                    {isCurrent && (
                      <Ionicons
                        name="checkmark"
                        size={14}
                        color={station.color}
                      />
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}

          {userType !== "provider" && caseItem.status !== "COMPLETE" && (
            <Pressable
              onPress={async () => {
                if (caseItem.assignedBarcode) {
                  Alert.alert(
                    "Barcode Assigned",
                    `This case already has barcode: ${caseItem.assignedBarcode}`,
                    [
                      { text: "Keep", style: "cancel" },
                      {
                        text: "Reassign",
                        onPress: async () => {
                          if (!cameraPermission?.granted) {
                            const perm = await requestCameraPermission();
                            if (!perm.granted) { Alert.alert("Camera access is required to scan barcodes."); return; }
                          }
                          setBarcodeScanned(false);
                          setShowBarcodeScanner(true);
                        },
                      },
                    ]
                  );
                } else {
                  if (!cameraPermission?.granted) {
                    const perm = await requestCameraPermission();
                    if (!perm.granted) { Alert.alert("Camera access is required to scan barcodes."); return; }
                  }
                  setBarcodeScanned(false);
                  setShowBarcodeScanner(true);
                }
              }}
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: caseItem.assignedBarcode ? "#22C55E" : "#8B5CF6" },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="barcode" size={20} color="#FFF" />
              <Text style={styles.actionBtnText}>
                {caseItem.assignedBarcode ? `Barcode: ${caseItem.assignedBarcode}` : "Assign Barcode"}
              </Text>
            </Pressable>
          )}

          <Pressable
            onPress={() => setShowAddSomethingModal(true)}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: "#4F46E5" },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Ionicons name="add-circle-outline" size={20} color="#FFF" />
            <Text style={styles.actionBtnText}>Add Something to This Case</Text>
          </Pressable>

          {userType !== "provider" && (
            <Pressable
              onPress={() => setShowLabSlipModal(true)}
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: "#6366F1" },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="document-text" size={20} color="#FFF" />
              <Text style={styles.actionBtnText}>Reprint Lab Slip</Text>
            </Pressable>
          )}

          {caseItem.exocadWebviewUrl ? (
            <View style={exoStyles.exocadCard}>
              <View style={exoStyles.exocadHeader}>
                <View style={exoStyles.exocadTitleRow}>
                  <Ionicons name="cube-outline" size={20} color="#7C3AED" />
                  <Text style={exoStyles.exocadTitle}>ExoCAD WebView</Text>
                </View>
                {userType !== "provider" && (
                  <Pressable
                    onPress={() => {
                      Alert.alert(
                        "Remove ExoCAD Link",
                        "Are you sure you want to remove this ExoCAD WebView link?",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Remove",
                            style: "destructive",
                            onPress: () => {
                              updateCase(caseItem.id, { exocadWebviewUrl: undefined });
                              addCaseNote(caseItem.id, "ExoCAD WebView link removed");
                            },
                          },
                        ]
                      );
                    }}
                  >
                    <Ionicons name="trash-outline" size={18} color={Colors.light.error} />
                  </Pressable>
                )}
              </View>
              <Text style={exoStyles.exocadUrl} numberOfLines={1}>{caseItem.exocadWebviewUrl}</Text>
              <View style={exoStyles.exocadActions}>
                <Pressable
                  onPress={() => Linking.openURL(caseItem.exocadWebviewUrl!)}
                  style={({ pressed }) => [exoStyles.exocadActionBtn, { backgroundColor: "#7C3AED" }, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="open-outline" size={16} color="#FFF" />
                  <Text style={exoStyles.exocadActionText}>Open 3D View</Text>
                </Pressable>
                <Pressable
                  onPress={async () => {
                    try {
                      await Share.share({
                        message: `View the 3D design for patient ${caseItem.patientName} (Case ${caseItem.caseNumber}):\n${caseItem.exocadWebviewUrl}`,
                        title: "ExoCAD WebView Design",
                      });
                    } catch {
                      return;
                    }
                    try {
                      const entry = {
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                        type: "exocad_shared" as const,
                        timestamp: Date.now(),
                        description: `ExoCAD design shared for ${caseItem.patientName}`,
                        user: userInitials,
                      };
                      updateCase(caseItem.id, {
                        activityLog: [...(caseItem.activityLog || []), entry],
                      });
                      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    } catch {
                      Alert.alert("Activity Log Error", "The design was shared but the activity log could not be updated.");
                    }
                  }}
                  style={({ pressed }) => [exoStyles.exocadActionBtn, { backgroundColor: "#0EA5E9" }, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="share-outline" size={16} color="#FFF" />
                  <Text style={exoStyles.exocadActionText}>Share with Provider</Text>
                </Pressable>
              </View>
            </View>
          ) : userType !== "provider" ? (
            <Pressable
              onPress={() => {
                setExocadUrlInput(caseItem.exocadWebviewUrl || "");
                setShowExocadModal(true);
              }}
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: "#7C3AED" },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="cube-outline" size={20} color="#FFF" />
              <Text style={styles.actionBtnText}>Link ExoCAD Design</Text>
            </Pressable>
          ) : null}

          {(caseItem.courtesyTexts || []).length > 0 && (
            <View style={ctStyles.courtesySection}>
              <Text style={ctStyles.sectionTitle}>Courtesy Text History</Text>
              {(caseItem.courtesyTexts || []).map((ct) => {
                const statusColors: Record<string, string> = {
                  sent: "#F59E0B",
                  date_requested: "#EF4444",
                  date_proposed: "#3B82F6",
                  accepted: "#22C55E",
                  declined: "#EF4444",
                };
                const statusLabels: Record<string, string> = {
                  sent: "Awaiting Response",
                  date_requested: "Date Requested",
                  date_proposed: "Date Proposed",
                  accepted: "Resolved",
                  declined: "Declined",
                };
                return (
                  <View key={ct.id} style={ctStyles.courtesyCard}>
                    <View style={ctStyles.courtesyHeader}>
                      <Ionicons name="chatbubble-ellipses" size={16} color={statusColors[ct.status] || "#94A3B8"} />
                      <Text style={[ctStyles.statusBadge, { backgroundColor: statusColors[ct.status] || "#94A3B8" }]}>
                        {statusLabels[ct.status] || ct.status}
                      </Text>
                    </View>
                    <Text style={ctStyles.courtesyMsg} numberOfLines={3}>{ct.message}</Text>
                    <Text style={ctStyles.courtesyMeta}>
                      Sent by {ct.sentBy} {"\u2022"} {new Date(ct.sentAt).toLocaleDateString()}
                    </Text>

                    {ct.proposedDate && ct.status === "date_proposed" && (
                      <View style={ctStyles.proposedDateBox}>
                        <Ionicons name="calendar" size={16} color="#3B82F6" />
                        <Text style={ctStyles.proposedDateText}>
                          Proposed: {ct.proposedDate} at {ct.proposedTime}
                        </Text>
                      </View>
                    )}

                    {ct.status === "sent" && (
                      <View style={ctStyles.responseRow}>
                        <Text style={ctStyles.responseLabel}>Would you like an updated delivery date?</Text>
                        <View style={ctStyles.responseBtns}>
                          <Pressable
                            onPress={() => {
                              respondToCourtesyText(caseItem.id, ct.id, true, currentUser || "client");
                              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                            }}
                            style={({ pressed }) => [ctStyles.responseBtn, ctStyles.yesBtn, pressed && { opacity: 0.85 }]}
                          >
                            <Text style={ctStyles.responseBtnText}>Yes</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => {
                              respondToCourtesyText(caseItem.id, ct.id, false, currentUser || "client");
                              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                            }}
                            style={({ pressed }) => [ctStyles.responseBtn, ctStyles.noBtn, pressed && { opacity: 0.85 }]}
                          >
                            <Text style={ctStyles.responseBtnText}>No</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}

                    {ct.status === "date_requested" && isAdmin && (
                      <Pressable
                        onPress={() => {
                          setActiveCourtesyId(ct.id);
                          setProposalDate("");
                          setProposalTime("");
                          setShowDateProposalModal(true);
                        }}
                        style={({ pressed }) => [ctStyles.proposeBtn, pressed && { opacity: 0.85 }]}
                      >
                        <Ionicons name="calendar" size={18} color="#FFF" />
                        <Text style={ctStyles.proposeBtnText}>Propose Delivery Date</Text>
                      </Pressable>
                    )}

                    {ct.status === "date_proposed" && (
                      <View style={ctStyles.responseBtns}>
                        <Pressable
                          onPress={() => {
                            respondToProposedDate(caseItem.id, ct.id, true, currentUser || "client");
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          }}
                          style={({ pressed }) => [ctStyles.responseBtn, ctStyles.yesBtn, { flex: 1 }, pressed && { opacity: 0.85 }]}
                        >
                          <Ionicons name="checkmark" size={18} color="#FFF" />
                          <Text style={ctStyles.responseBtnText}>Accept</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setActiveCourtesyId(ct.id);
                            setDeclineNote("");
                            setShowDeclineModal(true);
                          }}
                          style={({ pressed }) => [ctStyles.responseBtn, ctStyles.noBtn, { flex: 1 }, pressed && { opacity: 0.85 }]}
                        >
                          <Ionicons name="close" size={18} color="#FFF" />
                          <Text style={ctStyles.responseBtnText}>Decline</Text>
                        </Pressable>
                      </View>
                    )}

                    {ct.responseHistory.length > 0 && (
                      <View style={ctStyles.historySection}>
                        {ct.responseHistory.map((r) => (
                          <View key={r.id} style={ctStyles.historyItem}>
                            <View style={[ctStyles.historyDot, { backgroundColor: r.type === "accepted" ? "#22C55E" : r.type === "declined" ? "#EF4444" : "#3B82F6" }]} />
                            <View style={{ flex: 1 }}>
                              <Text style={ctStyles.historyText}>
                                {r.type === "date_requested" ? r.note :
                                 r.type === "date_proposed" ? `Proposed: ${r.proposedDate} at ${r.proposedTime}` :
                                 r.type === "accepted" ? "Delivery date accepted" :
                                 `Declined${r.note ? `: ${r.note}` : ""}`}
                              </Text>
                              <Text style={ctStyles.historyMeta}>{r.by} {"\u2022"} {new Date(r.timestamp).toLocaleString()}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </KeyboardAwareScrollViewCompat>

      <Modal
        visible={showPhotoPreview}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setCapturedPhotos([]);
          setPhotoNotes("");
          setShowPhotoNotes(false);
          setShowPhotoPreview(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalOverlay}
        >
          <View style={[styles.photoModal, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>
              {capturedPhotos.length} File{capturedPhotos.length !== 1 ? "s" : ""} Captured
            </Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
              {capturedPhotos.map((uri, idx) => (
                <Image key={idx} source={{ uri }} style={styles.previewPhoto} />
              ))}
            </ScrollView>

            {showPhotoNotes ? (
              <View style={{ paddingHorizontal: 4, gap: 10 }}>
                <TextInput
                  style={{
                    borderWidth: 1,
                    borderColor: Colors.light.border,
                    borderRadius: 12,
                    padding: 14,
                    fontSize: 15,
                    fontFamily: "Inter_400Regular",
                    color: Colors.light.text,
                    backgroundColor: Colors.light.surface,
                    minHeight: 90,
                    textAlignVertical: "top",
                  }}
                  placeholder="Dictate notes to the lab..."
                  placeholderTextColor={Colors.light.textTertiary}
                  value={photoNotes}
                  onChangeText={setPhotoNotes}
                  multiline
                  autoFocus
                />
                <View style={styles.photoActions}>
                  <Pressable
                    onPress={() => {
                      setPhotoNotes("");
                      setShowPhotoNotes(false);
                    }}
                    style={({ pressed }) => [
                      styles.photoActionBtn,
                      { backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.border },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Ionicons name="close" size={18} color={Colors.light.text} />
                    <Text style={[styles.photoActionText, { color: Colors.light.text }]}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      if (photoNotes.trim()) {
                        setShowPhotoNotes(false);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.photoActionBtn,
                      { backgroundColor: photoNotes.trim() ? "#10B981" : "#ccc" },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Ionicons name="checkmark" size={18} color="#FFF" />
                    <Text style={[styles.photoActionText, { color: "#FFF" }]}>Submit Notes</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <>
                {photoNotes.trim() ? (
                  <View style={{ backgroundColor: "#F0FDF4", borderRadius: 10, padding: 12, marginBottom: 4, borderWidth: 1, borderColor: "#BBF7D0" }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#16A34A" }}>Notes attached</Text>
                      <Pressable onPress={() => setShowPhotoNotes(true)} hitSlop={8}>
                        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>Edit</Text>
                      </Pressable>
                    </View>
                    <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.text }} numberOfLines={2}>{photoNotes}</Text>
                  </View>
                ) : null}

                <View style={styles.photoActions}>
                  <Pressable
                    onPress={handleAddMoreMedia}
                    style={({ pressed }) => [
                      styles.photoActionBtn,
                      { backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.border },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Ionicons name="camera" size={20} color={Colors.light.text} />
                    <Text style={[styles.photoActionText, { color: Colors.light.text }]}>Add More</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setShowPhotoNotes(true)}
                    style={({ pressed }) => [
                      styles.photoActionBtn,
                      { backgroundColor: "#F59E0B" },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Ionicons name="create-outline" size={20} color="#FFF" />
                    <Text style={[styles.photoActionText, { color: "#FFF" }]}>Add Notes</Text>
                  </Pressable>
                </View>

                <Pressable
                  onPress={handleFinishPhotos}
                  style={({ pressed }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      paddingVertical: 14,
                      borderRadius: 14,
                      backgroundColor: Colors.light.tint,
                      marginTop: 6,
                    },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Ionicons name="checkmark-circle" size={22} color="#FFF" />
                  <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#FFF" }}>Done</Text>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showNoteModal}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setNoteText("");
          setShowNoteModal(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalOverlay}
        >
          <View style={[styles.noteModal, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={styles.noteModalHeader}>
              <Text style={styles.modalTitle}>Add Note</Text>
              <Pressable
                onPress={() => {
                  setNoteText("");
                  setShowNoteModal(false);
                }}
              >
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>

            <TextInput
              style={styles.noteInput}
              placeholder="Type your note here..."
              placeholderTextColor={Colors.light.textTertiary}
              value={noteText}
              onChangeText={setNoteText}
              multiline
              autoFocus
              textAlignVertical="top"
            />

            <Pressable
              onPress={handleSaveNote}
              style={({ pressed }) => [
                styles.saveNoteBtn,
                !noteText.trim() && { opacity: 0.5 },
                pressed && { opacity: 0.85 },
              ]}
              disabled={!noteText.trim()}
            >
              <Ionicons name="checkmark" size={20} color="#FFF" />
              <Text style={styles.saveNoteBtnText}>Save Note</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showAddSomethingModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAddSomethingModal(false)}
      >
        <View style={addStyles.backdrop}>
          <View style={addStyles.card}>
            <Text style={addStyles.title}>What would you like to add?</Text>

            <Pressable
              style={({ pressed }) => [addStyles.option, pressed && { opacity: 0.75 }]}
              onPress={() => { setShowAddSomethingModal(false); setTimeout(handleTakePhoto, 200); }}
            >
              <Ionicons name="camera-outline" size={22} color="#0F172A" />
              <Text style={addStyles.optionText}>Picture or Video</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [addStyles.option, pressed && { opacity: 0.75 }]}
              onPress={() => { setShowAddSomethingModal(false); setTimeout(() => setShowNoteModal(true), 200); }}
            >
              <Ionicons name="document-text-outline" size={22} color="#0F172A" />
              <Text style={addStyles.optionText}>Note</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [addStyles.option, pressed && { opacity: 0.75 }]}
              onPress={() => { setShowAddSomethingModal(false); setTimeout(handleAttachFile, 200); }}
            >
              <Ionicons name="attach-outline" size={22} color="#0F172A" />
              <Text style={addStyles.optionText}>File</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [addStyles.option, pressed && { opacity: 0.75 }]}
              onPress={() => { setShowAddSomethingModal(false); setTimeout(openAddItemModal, 200); }}
            >
              <Ionicons name="layers-outline" size={22} color="#0F172A" />
              <Text style={addStyles.optionText}>Item</Text>
            </Pressable>

            {userType !== "provider" && (
              <Pressable
                style={({ pressed }) => [addStyles.option, pressed && { opacity: 0.75 }]}
                onPress={() => {
                  setShowAddSomethingModal(false);
                  setTimeout(() => {
                    const stationInfo = getStationInfo(caseItem.status, customStationLabels);
                    const msg = `Hello Dr. ${caseItem.doctorName}, this is a courtesy text to inform you that patient ${caseItem.patientName} has a case that was delayed in production. The case is currently in ${stationInfo.label}. If the patient is scheduled and you would like a more specific updated estimated delivery date and time please let us know.`;
                    setCourtesyMessage(msg);
                    setShowCourtesyModal(true);
                  }, 200);
                }}
              >
                <Ionicons name="chatbubble-outline" size={22} color="#0F172A" />
                <Text style={addStyles.optionText}>Courtesy Text</Text>
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [addStyles.cancelBtn, pressed && { opacity: 0.75 }]}
              onPress={() => setShowAddSomethingModal(false)}
            >
              <Text style={addStyles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {isAdmin && (
      <Modal
        visible={showCompleteInfo}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCompleteInfo(false)}
      >
        <View style={styles.completeOverlay}>
          <View style={styles.completeSheet}>
            <View style={styles.completeHeader}>
              <Text style={styles.completeTitle}>
                {caseItem.status === "COMPLETE" ? "Completed Case" : "Shipped Case"}
              </Text>
              <Pressable onPress={() => setShowCompleteInfo(false)}>
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={styles.completeScroll}>
              <View style={styles.completeSectionWrap}>
                <View style={styles.completeSectionHeader}>
                  <Ionicons name="navigate" size={16} color="#6366F1" />
                  <Text style={styles.completeSectionTitle}>Tracking Numbers</Text>
                </View>
                {(caseItem.trackingNumbers?.length ?? 0) > 0 ? (
                  caseItem.trackingNumbers!.map((tn, idx) => (
                    <View key={idx} style={styles.trackingItem}>
                      <View style={styles.trackingDot} />
                      <Text style={styles.trackingItemText}>{tn}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.completeEmptyText}>No tracking numbers recorded</Text>
                )}
              </View>

              <View style={styles.completeSectionWrap}>
                <View style={styles.completeSectionHeader}>
                  <Ionicons name="camera" size={16} color="#8B5CF6" />
                  <Text style={styles.completeSectionTitle}>Completion Media</Text>
                </View>
                {(() => {
                  const mediaEntries = (caseItem.activityLog || []).filter((a) => (a.type === "photo" || a.type === "video") && a.imageUri);
                  const completePhotos = mediaEntries.filter(a => a.type === "photo").map((a) => a.imageUri!);
                  const allPhotos = [...(caseItem.photos || []), ...completePhotos];
                  const uniquePhotos = [...new Set(allPhotos)];
                  const videoEntries = mediaEntries.filter(a => a.type === "video");
                  if (uniquePhotos.length === 0 && videoEntries.length === 0) {
                    return <Text style={styles.completeEmptyText}>No media available</Text>;
                  }
                  return (
                    <View>
                      {uniquePhotos.length > 0 && (
                        <View style={styles.completePhotoGrid}>
                          {uniquePhotos.map((uri, idx) => (
                            <Pressable key={idx} onPress={() => setFullScreenPhoto(uri)}>
                              <Image
                                source={{ uri }}
                                style={styles.completePhoto}
                                resizeMode="cover"
                              />
                            </Pressable>
                          ))}
                        </View>
                      )}
                      {videoEntries.map((v, idx) => (
                        <Pressable
                          key={`vid-${idx}`}
                          onPress={() => {
                            if (Platform.OS === "web") {
                              (window as any).open(v.imageUri, "_blank");
                            } else {
                              Linking.openURL(v.imageUri!).catch(() => Alert.alert("Cannot play video", "Unable to open video."));
                            }
                          }}
                          style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#1E1B2E", borderRadius: 10, padding: 12, marginTop: 8 }}
                        >
                          <Ionicons name="play-circle" size={28} color="#A78BFA" />
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#C4B5FD" }}>Video {idx + 1}</Text>
                            <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#7C6FA0" }}>Tap to play</Text>
                          </View>
                          <Ionicons name="open-outline" size={16} color="#7C6FA0" />
                        </Pressable>
                      ))}
                    </View>
                  );
                })()}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
      )}

      <AddItemModal
        visible={showAddItemModal}
        onClose={() => setShowAddItemModal(false)}
        insetsBottom={insets.bottom}
        showPrice={showPrice}
        doctorName={caseItem?.doctorName || ""}
        clients={clients}
        pricingTiers={pricingTiers}
        addItemStep={addItemStep}
        setAddItemStep={setAddItemStep}
        itemCaseType={itemCaseType}
        setItemCaseType={setItemCaseType}
        itemSelectedTeeth={itemSelectedTeeth}
        setItemSelectedTeeth={setItemSelectedTeeth}
        itemToothTypes={itemToothTypes}
        setItemToothTypes={setItemToothTypes}
        itemMaterial={itemMaterial}
        setItemMaterial={setItemMaterial}
        removableSubtype={removableSubtype}
        setRemovableSubtype={setRemovableSubtype}
        removableMaterial={removableMaterial}
        setRemovableMaterial={setRemovableMaterial}
        removableCustomMaterial={removableCustomMaterial}
        setRemovableCustomMaterial={setRemovableCustomMaterial}
        gingivaShade={gingivaShade}
        setGingivaShade={setGingivaShade}
        gingivaCustomNote={gingivaCustomNote}
        setGingivaCustomNote={setGingivaCustomNote}
        applianceSubtype={applianceSubtype}
        setApplianceSubtype={setApplianceSubtype}
        applianceArch={applianceArch}
        setApplianceArch={setApplianceArch}
        applianceVariant={applianceVariant}
        setApplianceVariant={setApplianceVariant}
        setNightGuardType={setNightGuardType}
        essexShade={essexShade}
        setEssexShade={setEssexShade}
        itemBillableCount={itemBillableCount}
        itemCalculatedPrice={itemCalculatedPrice}
        itemToothDisplay={itemToothDisplay}
        handleItemToothTap={handleItemToothTap}
        handleItemToothLongPress={handleItemToothLongPress}
        handleSaveItem={handleSaveItem}
        caseId={caseItem!.id}
        addCaseItem={addCaseItem}
        addApplianceToInvoice={addApplianceToInvoice}
        styles={styles}
      />

      <CourtesyTextModal
        visible={showCourtesyModal}
        onClose={() => setShowCourtesyModal(false)}
        message={courtesyMessage}
        onChangeMessage={setCourtesyMessage}
        onSend={(msg) => {
          sendCourtesyText(caseItem.id, msg, currentUser || "lab");
          setShowCourtesyModal(false);
          setCourtesyMessage("");
        }}
      />

      <ExocadLinkModal
        visible={showExocadModal}
        onClose={() => setShowExocadModal(false)}
        urlInput={exocadUrlInput}
        onChangeUrlInput={setExocadUrlInput}
        patientName={caseItem.patientName}
        caseNumber={caseItem.caseNumber}
        onLink={(url) => {
          const entry = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            type: "exocad_linked" as const,
            timestamp: Date.now(),
            description: `ExoCAD WebView design linked`,
            user: userInitials,
          };
          const baseLog = caseItem.activityLog || [];
          updateCase(caseItem.id, {
            exocadWebviewUrl: url,
            activityLog: [...baseLog, entry],
          });
          setShowExocadModal(false);
          setExocadUrlInput("");
          return { linkEntry: entry, baseLog };
        }}
        onShareAfterLink={({ linkEntry, baseLog }) => {
          const shareEntry = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            type: "exocad_shared" as const,
            timestamp: Date.now(),
            description: `ExoCAD design shared for ${caseItem.patientName}`,
            user: userInitials,
          };
          updateCase(caseItem.id, {
            activityLog: [...baseLog, linkEntry, shareEntry],
          });
        }}
      />

      <ProposeDateModal
        visible={showDateProposalModal}
        onClose={() => setShowDateProposalModal(false)}
        date={proposalDate}
        time={proposalTime}
        onChangeDate={setProposalDate}
        onChangeTime={setProposalTime}
        onPropose={(d, t) => {
          if (activeCourtesyId) {
            proposeDeliveryDate(caseItem.id, activeCourtesyId, d, t, currentUser || "lab");
            setShowDateProposalModal(false);
            setProposalDate("");
            setProposalTime("");
            setActiveCourtesyId("");
          }
        }}
      />

      <DeclineDateModal
        visible={showDeclineModal}
        onClose={() => setShowDeclineModal(false)}
        note={declineNote}
        onChangeNote={setDeclineNote}
        onDecline={(note) => {
          if (activeCourtesyId) {
            respondToProposedDate(caseItem.id, activeCourtesyId, false, currentUser || "client", note || undefined);
            setShowDeclineModal(false);
            setDeclineNote("");
            setActiveCourtesyId("");
          }
        }}
      />

      {isAdmin && (
      <EditCaseModal
        visible={showEditCase}
        onClose={() => setShowEditCase(false)}
        insetsBottom={insets.bottom}
        originalDoctorName={caseItem.doctorName || ""}
        doctor={editDoctor}
        patient={editPatient}
        teeth={editTeeth}
        shade={editShade}
        material={editMaterial}
        dueDate={editDueDate}
        notes={editNotes}
        onChangeDoctor={setEditDoctor}
        onChangePatient={setEditPatient}
        onChangeTeeth={setEditTeeth}
        onChangeShade={setEditShade}
        onChangeMaterial={setEditMaterial}
        onChangeDueDate={setEditDueDate}
        onChangeNotes={setEditNotes}
        onSave={handleSaveEditCase}
      />
      )}

      <QuickEditModal
        visible={showQuickEdit}
        onClose={() => setShowQuickEdit(false)}
        doctor={qeDoctor}
        patient={qePatient}
        teeth={qeTeeth}
        shade={qeShade}
        material={qeMaterial}
        dueDate={qeDueDate}
        notes={qeNotes}
        onChangeDoctor={setQeDoctor}
        onChangePatient={setQePatient}
        onChangeTeeth={setQeTeeth}
        onChangeShade={setQeShade}
        onChangeMaterial={setQeMaterial}
        onChangeDueDate={setQeDueDate}
        onChangeNotes={setQeNotes}
        onSave={() => {
          const plan = computeQuickEditPlan(
            {
              doctorName: caseItem.doctorName,
              patientName: (caseItem as any).patientName,
              patientInitials: caseItem.patientInitials,
              toothIndices: caseItem.toothIndices,
              shade: caseItem.shade,
              material: caseItem.material,
              dueDate: caseItem.dueDate,
              notes: caseItem.notes,
              caseType: caseItem.caseType,
              isRush: caseItem.isRush,
              invoiceId: caseItem.invoiceId,
            },
            { doctor: qeDoctor, patient: qePatient, teeth: qeTeeth, shade: qeShade, material: qeMaterial, dueDate: qeDueDate, notes: qeNotes },
            (mat, ct, dr) => resolvePriceForCase(mat, ct ?? undefined, dr, clients, pricingTiers),
          );

          if (plan.changes.length === 0) {
            setShowQuickEdit(false);
            return;
          }

          updateCase(caseItem.id, plan.caseUpdates);
          if (plan.newPrice !== undefined) {
            updateCase(caseItem.id, { price: plan.newPrice });
          }
          if (plan.invoicePatch && caseItem.invoiceId) {
            updateInvoice(caseItem.invoiceId, plan.invoicePatch);
          }

          const changeDesc = plan.changes.join("; ");
          addCaseNote(caseItem.id, `Case info edited: ${changeDesc}`, userInitials);

          if (!isAdmin) {
            addNotification({
              title: "Case Updated",
              message: `${currentUser || "A user"} edited case ${caseItem.caseNumber}: ${changeDesc}`,
              type: "update",
              caseId: caseItem.id,
            });
          }

          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          const savedQe = { ...caseItem, ...plan.caseUpdates };
          setShowQuickEdit(false);
          Alert.alert(
            "Changes Saved",
            "Do you want to reprint the case label?",
            [
              { text: "No", style: "cancel" },
              { text: "Yes", onPress: () => handlePrintCaseLabel(savedQe) },
            ]
          );
        }}
      />

      {showPrice && (
      <InvoicePDFViewer
        visible={showInvoiceModal}
        onClose={() => setShowInvoiceModal(false)}
        invoice={caseInvoice}
        editable={isAdmin}
        companyLogo={companyLogo}
        doctorPricing={(() => {
          const stripDr = (n: string) => n.trim().toLowerCase().replace(/^dr\.?\s*/i, "");
          const drName = stripDr(caseItem.doctorName || "");
          const matchedClient = clients.find(c =>
            stripDr(c.leadDoctor) === drName ||
            (c.additionalProviders || []).some(p => stripDr(p) === drName)
          );
          return matchedClient?.customPricing || undefined;
        })()}
        onSave={(updatedInv) => {
          if (caseItem.invoiceId) {
            updateInvoice(caseItem.invoiceId, {
              lineItems: updatedInv.lineItems,
              amount: updatedInv.amount,
              credits: updatedInv.credits,
              billTo: updatedInv.billTo,
              caseNotes: updatedInv.caseNotes,
              notes: updatedInv.notes,
            });
          } else {
            const { id: _id, ...invWithoutId } = updatedInv;
            const createdId = addInvoice(invWithoutId);
            updateCase(caseItem.id, { invoiceId: createdId });
          }
          const newTotal = updatedInv.lineItems.reduce((s, li) => s + li.amount, 0) - (updatedInv.credits || 0);
          const caseUpdates: Record<string, any> = { price: newTotal };
          if (updatedInv.caseNotes !== undefined) caseUpdates.notes = updatedInv.caseNotes;
          if (updatedInv.billTo && updatedInv.billTo !== caseItem.doctorName) caseUpdates.doctorName = updatedInv.billTo;
          updateCase(caseItem.id, caseUpdates);
          addCaseNote(caseItem.id, `Invoice updated — new total: $${newTotal.toFixed(2)}`, userInitials);
        }}
      />
      )}

      <LabSlipModal
        visible={showLabSlipModal}
        onClose={() => setShowLabSlipModal(false)}
        caseItem={caseItem}
        customStationLabels={customStationLabels}
      />

      <CaseBarcodeScannerModal
        visible={showBarcodeScanner}
        onClose={() => setShowBarcodeScanner(false)}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        caseNumber={caseItem?.caseNumber}
        cameraPermission={cameraPermission}
        requestCameraPermission={requestCameraPermission}
        scanned={barcodeScanned}
        onSetScanned={setBarcodeScanned}
        onScan={(scannedBarcode) => {
          const existingCase = findCaseByBarcode(scannedBarcode);
          if (existingCase && existingCase.id !== id) {
            Alert.alert(
              "Barcode In Use",
              `This barcode is already assigned to case ${existingCase.caseNumber}. Please scan a different barcode.`,
              [{ text: "OK", onPress: () => setBarcodeScanned(false) }]
            );
          } else {
            assignBarcodeToCase(id!, scannedBarcode);
            if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert(
              "Barcode Assigned",
              `Barcode ${scannedBarcode} has been assigned to this case.`,
              [{ text: "OK", onPress: () => setShowBarcodeScanner(false) }]
            );
          }
        }}
      />

      <Modal
        visible={!!fullScreenPhoto}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setFullScreenPhoto(null)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.95)" }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 8, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", justifyContent: "flex-end" }}>
            <Pressable onPress={() => setFullScreenPhoto(null)} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="close" size={24} color="#FFF" />
            </Pressable>
          </View>
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 8 }}>
            {fullScreenPhoto && (
              <Image
                source={{ uri: fullScreenPhoto }}
                style={{ width: "100%", height: "100%" }}
                resizeMode="contain"
              />
            )}
          </View>
        </View>
      </Modal>

    </View>
  );
}

const ep = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
  },
  iconWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 6,
  },
  desc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    marginBottom: 24,
  },
  btnRow: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  btn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  btnNo: {
    backgroundColor: Colors.light.surfaceSecondary,
  },
  btnNoText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  btnYes: {
    backgroundColor: Colors.light.tint,
  },
  btnYesText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  photoCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 400,
  },
  photoHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  photoTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  photoSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginBottom: 16,
  },
  photoScroll: {
    marginBottom: 16,
  },
  thumbWrap: {
    marginRight: 10,
    position: "relative" as const,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
  },
  thumbRemove: {
    position: "absolute" as const,
    top: -6,
    right: -6,
    backgroundColor: "#FFF",
    borderRadius: 10,
  },
  photoBtnRow: {
    marginBottom: 16,
  },
  addMoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tintLight,
    paddingVertical: 12,
    borderRadius: 12,
  },
  addMoreText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  noteInput: {
    backgroundColor: Colors.light.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    minHeight: 120,
    marginBottom: 16,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.light.background,
    gap: 16,
  },
  emptyText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  backLink: {
    padding: 12,
  },
  backLinkText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  headerBtn: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  scroll: {
    flex: 1,
    padding: 20,
  },
  statusCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    gap: 14,
    marginBottom: 16,
  },
  statusIndicator: {
    width: 8,
    height: 48,
    borderRadius: 4,
  },
  statusInfo: {
    flex: 1,
  },
  statusLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textTertiary,
    letterSpacing: 1,
  },
  statusValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginTop: 2,
  },
  rushBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.light.errorLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  rushText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.error,
    letterSpacing: 0.5,
  },
  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16,
  },
  infoItem: {
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.light.border,
    minWidth: "30%",
    flexGrow: 1,
  },
  infoLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textTertiary,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  chartHistoryBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    backgroundColor: "#EFF6FF",
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  chartHistoryBtnTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#3B82F6",
  },
  chartHistoryBtnSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#60A5FA",
    marginTop: 1,
  },
  notesCard: {
    backgroundColor: Colors.light.warningLight,
    borderRadius: 14,
    padding: 16,
    marginBottom: 24,
  },
  rxSummaryCard: {
    backgroundColor: Colors.light.background,
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  rxSummaryHeading: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textSecondary,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
    marginBottom: 12,
  },
  rxSummaryEmpty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.light.border,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  rxSummaryEmptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center" as const,
  },
  rxSummaryGrid: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 12,
  },
  rxSummaryField: {
    width: "48%",
  },
  rxSummaryLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
    marginBottom: 4,
  },
  rxSummaryValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  rxSummaryNotesEmpty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.light.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 4,
  },
  rxSummaryNotesEmptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  rxSummaryNoteRow: {
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 4,
  },
  rxSummaryNoteText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    lineHeight: 18,
  },
  rxSummaryNoteMeta: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
    marginTop: 4,
  },
  notesLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.warning,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
    marginBottom: 6,
  },
  notesText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    lineHeight: 20,
  },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    marginRight: 8,
    backgroundColor: Colors.light.border,
  },
  sectionHeader: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  timeline: {
    marginBottom: 24,
  },
  timelineItem: {
    flexDirection: "row",
    gap: 14,
  },
  timelineLine: {
    alignItems: "center",
    width: 24,
  },
  timelineDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  timelineConnector: {
    width: 2,
    flex: 1,
    minHeight: 20,
    backgroundColor: Colors.light.border,
    marginVertical: 4,
  },
  timelineContent: {
    flex: 1,
    paddingBottom: 16,
  },
  timelineStation: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  timelineTime: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    marginTop: 2,
  },
  actionSection: {
    gap: 12,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
  },
  actionBtnHalf: {
    flex: 1,
  },
  actionBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  stationGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  stationChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minWidth: "45%",
    flexGrow: 1,
  },
  stationDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stationText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.light.border,
    alignSelf: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 16,
  },
  photoModal: {
    backgroundColor: Colors.light.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 16,
  },
  photoStrip: {
    marginBottom: 20,
  },
  previewPhoto: {
    width: 120,
    height: 120,
    borderRadius: 14,
    marginRight: 10,
    backgroundColor: Colors.light.border,
  },
  photoActions: {
    flexDirection: "row",
    gap: 12,
  },
  photoActionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  photoActionText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  noteModal: {
    backgroundColor: Colors.light.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 16,
    maxHeight: "70%",
  },
  noteModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  noteInput: {
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.light.border,
    padding: 16,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    minHeight: 120,
    marginBottom: 16,
  },
  saveNoteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#8B5CF6",
    paddingVertical: 14,
    borderRadius: 14,
  },
  saveNoteBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  statusCardTappable: {
    borderColor: Colors.light.tint + "30",
    borderWidth: 1.5,
  },
  completeOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  completeSheet: {
    backgroundColor: Colors.light.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingTop: 16,
    maxHeight: "75%",
  },
  completeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  completeTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  completeScroll: {
    flex: 1,
  },
  completeSectionWrap: {
    marginBottom: 24,
  },
  completeSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  completeSectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  completeEmptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    paddingLeft: 24,
  },
  trackingItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: "#EEF2FF",
    borderRadius: 10,
    marginBottom: 8,
  },
  trackingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#6366F1",
  },
  trackingItemText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#4338CA",
  },
  completePhotoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  completePhoto: {
    width: 100,
    height: 100,
    borderRadius: 12,
    backgroundColor: Colors.light.border,
  },
  addItemOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  addItemSheet: {
    backgroundColor: Colors.light.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingTop: 12,
    maxHeight: "90%",
  },
  addItemHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    marginBottom: 20,
  },
  addItemTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  addItemCaseTypeList: {
    gap: 8,
  },
  addItemCaseTypeItem: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    gap: 14,
  },
  addItemCaseTypeItemSelected: {
    borderColor: Colors.light.tint,
    backgroundColor: Colors.light.tintLight,
  },
  addItemCaseTypeIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.light.surfaceSecondary,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  addItemCaseTypeText: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  addItemCaseTypeTextSelected: {
    color: Colors.light.tint,
  },
  addItemToothScroll: {
    flex: 1,
    minHeight: 420,
  },
  addItemSelectedType: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    backgroundColor: Colors.light.tintLight,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    alignSelf: "flex-start" as const,
    marginBottom: 12,
  },
  addItemSelectedTypeText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  aiToothChartPanel: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  aiToothChartHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    marginBottom: 2,
  },
  aiToothChartTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  aiToothChartClear: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.error,
  },
  aiToothChartLegend: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    marginBottom: 4,
  },
  aiLegendItem: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
  },
  aiLegendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  aiLegendText: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  aiLegendHint: {
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    fontStyle: "italic" as const,
    marginLeft: "auto",
  },
  aiArchContainer: {
    alignItems: "center" as const,
    paddingVertical: 10,
    backgroundColor: "#EFF4FB",
    borderRadius: 16,
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  aiArchSectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
    letterSpacing: 2,
    marginBottom: 4,
    marginTop: 4,
  },
  aiArchRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginVertical: 1,
  },
  aiArchGap: {
    width: "60%",
    paddingVertical: 6,
    alignItems: "center" as const,
  },
  aiArchGapLine: {
    width: "100%",
    height: 1,
    backgroundColor: Colors.light.border,
  },
  aiArchToothBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.light.surface,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
  },
  aiArchToothText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textSecondary,
  },
  aiToothBtnSelected: {
    backgroundColor: Colors.light.tint,
    borderColor: Colors.light.tint,
  },
  aiToothBtnBridge: {
    backgroundColor: Colors.light.accent,
    borderColor: Colors.light.accent,
  },
  aiToothBtnMissing: {
    backgroundColor: Colors.light.errorLight,
    borderColor: Colors.light.error,
  },
  aiToothBtnTextSelected: {
    color: "#FFF",
  },
  aiToothBtnTextBridge: {
    color: "#FFF",
  },
  aiToothBtnTextMissing: {
    color: Colors.light.error,
    fontSize: 11,
  },
  aiToothMissingWrap: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    position: "relative" as const,
  },
  aiToothXOverlay: {
    position: "absolute" as const,
    top: -4,
    left: -2,
    right: -2,
    bottom: -4,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  aiToothChartSummary: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
    marginTop: 4,
    gap: 6,
  },
  aiToothSummaryRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
  },
  aiToothChartSummaryText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.tint,
    flex: 1,
  },
  aiMaterialSection: {
    marginTop: 14,
    marginBottom: 10,
  },
  aiMaterialLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    marginBottom: 8,
  },
  aiMaterialSelector: {
    flexDirection: "row" as const,
    gap: 8,
  },
  aiMaterialChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.light.surfaceSecondary,
    alignItems: "center" as const,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
  },
  aiMaterialChipActive: {
    backgroundColor: Colors.light.tintLight,
    borderColor: Colors.light.tint,
  },
  aiMaterialText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  aiMaterialTextActive: {
    color: Colors.light.tint,
  },
  aiPricingRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    backgroundColor: Colors.light.tintLight,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
  },
  aiPricingLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  aiPricingTotal: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
  },
  aiSaveItemBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 8,
    backgroundColor: "#10B981",
    paddingVertical: 14,
    borderRadius: 14,
    marginBottom: 8,
  },
  aiSaveItemBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  aiAdaChartContainer: {
    paddingVertical: 8,
  },
  aiAdaQuadrantLabels: {
    flexDirection: "row" as const,
    justifyContent: "space-around" as const,
    marginBottom: 4,
  },
  aiAdaQuadrantLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textTertiary,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
  },
  aiAdaRow: {
    flexDirection: "row" as const,
    justifyContent: "center" as const,
    flexWrap: "wrap" as const,
    gap: 3,
    paddingHorizontal: 4,
  },
  aiAdaToothBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: "center" as const,
    alignItems: "center" as const,
    backgroundColor: Colors.light.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  aiAdaToothBtnMidline: {
    marginRight: 8,
  },
  aiAdaToothText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  aiAdaMidline: {
    width: 1,
    height: 32,
    backgroundColor: Colors.light.textTertiary,
    marginHorizontal: 2,
  },
  aiAdaDividerRow: {
    paddingVertical: 6,
    alignItems: "center" as const,
  },
  aiAdaDividerLine: {
    height: 1,
    width: "90%",
    backgroundColor: Colors.light.borderLight,
  },
  initialsChip: {
    backgroundColor: Colors.light.tintLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginRight: 6,
  },
  initialsText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
  },
});

const ctStyles = StyleSheet.create({
  courtesySection: {
    marginTop: 20,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    marginBottom: 4,
  },
  courtesyCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    gap: 10,
  },
  courtesyHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusBadge: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: "hidden",
  },
  courtesyMsg: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    lineHeight: 19,
  },
  courtesyMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  proposedDateBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#EFF6FF",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  proposedDateText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#1E40AF",
  },
  responseRow: {
    gap: 8,
  },
  responseLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  responseBtns: {
    flexDirection: "row",
    gap: 10,
  },
  responseBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  yesBtn: {
    backgroundColor: "#22C55E",
  },
  noBtn: {
    backgroundColor: "#EF4444",
  },
  responseBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  proposeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#3B82F6",
    paddingVertical: 12,
    borderRadius: 12,
  },
  proposeBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  historySection: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
    paddingTop: 10,
  },
  historyItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  historyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  historyText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  historyMeta: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 400,
    gap: 12,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  modalSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    lineHeight: 19,
  },
  messageInput: {
    backgroundColor: Colors.light.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    minHeight: 120,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
  },
  dateInput: {
    backgroundColor: Colors.light.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
  },
  inputLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#F59E0B",
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 4,
  },
  sendBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
});

const exoStyles = StyleSheet.create({
  exocadCard: {
    backgroundColor: "#F5F3FF",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "#DDD6FE",
    gap: 10,
  },
  exocadHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  exocadTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  exocadTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#7C3AED",
  },
  exocadUrl: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#6B7280",
  },
  exocadActions: {
    flexDirection: "row",
    gap: 8,
  },
  exocadActionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  exocadActionText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
});

const addStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 34,
    gap: 4,
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
    marginBottom: 8,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  optionText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: "#0F172A",
  },
  cancelBtn: {
    alignItems: "center",
    paddingVertical: 16,
    marginTop: 6,
  },
  cancelText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#EF4444",
  },
});
