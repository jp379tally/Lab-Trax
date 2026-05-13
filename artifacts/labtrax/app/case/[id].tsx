import React, { useState, useRef, useEffect } from "react";
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
import { resilientFetch } from "@/lib/query-client";
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
  const [fullCaseData, setFullCaseData] = useState<FullCaseData | null>(null);
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

  const caseInvoice: Invoice = (() => {
    if (caseItem.invoiceId) {
      const found = invoices.find((inv) => inv.id === caseItem.invoiceId);
      if (found) return found;
    }
    const safeDoctorName = caseItem.doctorName || "";
    const safeToothIndices = caseItem.toothIndices || "";
    const safeCaseNumber = caseItem.caseNumber || "";
    const safePatientName = caseItem.patientName || "";
    const safeMaterial = caseItem.material || "";
    const safeShade = caseItem.shade || "";
    const matchedInv = invoices.find(
      (inv) => inv.caseIds.includes(caseItem.id) ||
        ((inv.patientName || "").toLowerCase() === safePatientName.toLowerCase() && (inv.clientName || "").toLowerCase().includes(safeDoctorName.split(" ").pop()?.toLowerCase() || ""))
    );
    if (matchedInv) return matchedInv;
    const toothCount = caseItem.toothMap?.length || safeToothIndices.split(",").filter(Boolean).length || 1;
    const rate = resolvePriceForCase(safeMaterial, caseItem.caseType, safeDoctorName, clients, pricingTiers);
    const lineItems = [
      { qty: toothCount, item: `${safeMaterial} ${caseItem.caseType || "Restoration"}`, description: `${safeMaterial} restoration - teeth ${safeToothIndices}`, rate, amount: toothCount * rate },
    ];
    if (caseItem.isRush) {
      lineItems.push({ qty: 1, item: "Rush Fee", description: "Expedited turnaround", rate: 500, amount: 500 });
    }
    const total = lineItems.reduce((s, li) => s + li.amount, 0);
    const invNum = `INV-${new Date(caseItem.createdAt).getFullYear()}-${safeCaseNumber.replace(/[^0-9]/g, "").padStart(3, "0")}`;
    return {
      id: caseItem.id + "-inv",
      invoiceNumber: invNum,
      clientId: "",
      clientName: safeDoctorName,
      caseIds: [caseItem.id],
      amount: total,
      credits: caseItem.isRemake && caseItem.price === 0 ? total : 0,
      status: caseItem.status === "COMPLETE" ? "paid" as const : "open" as const,
      issuedAt: caseItem.createdAt,
      dueAt: caseItem.dueDate ? new Date(caseItem.dueDate + "T00:00:00").getTime() : caseItem.createdAt + 30 * 86400000,
      billTo: safeDoctorName,
      patientName: safePatientName || caseItem.patientInitials,
      caseType: caseItem.caseType || "Restoration",
      teeth: safeToothIndices,
      shade: safeShade,
      caseNotes: caseItem.notes || "",
      lineItems,
    };
  })();

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
    const oldDoctor = caseItem.doctorName;
    const newDoctor = editDoctor.trim();
    const providerChanged = newDoctor.toLowerCase() !== oldDoctor.toLowerCase() && newDoctor.length > 0;
    const changes: string[] = [];

    const updates: Partial<typeof caseItem> = {};

    if (newDoctor !== oldDoctor) {
      updates.doctorName = newDoctor;
      changes.push(`Provider: ${oldDoctor} → ${newDoctor}`);
    }
    if (editPatient.trim() !== (caseItem.patientName || caseItem.patientInitials)) {
      updates.patientName = editPatient.trim();
      updates.patientInitials = editPatient.trim().split(" ").map(w => w[0]).join("").toUpperCase().substring(0, 2);
      changes.push(`Patient: ${caseItem.patientName || caseItem.patientInitials} → ${editPatient.trim()}`);
    }
    if (editTeeth.trim() !== caseItem.toothIndices) {
      updates.toothIndices = editTeeth.trim();
      changes.push(`Teeth: ${caseItem.toothIndices} → ${editTeeth.trim()}`);
    }
    if (editShade.trim() !== caseItem.shade) {
      updates.shade = editShade.trim();
      changes.push(`Shade: ${caseItem.shade} → ${editShade.trim()}`);
    }
    if (editMaterial.trim() !== caseItem.material) {
      updates.material = editMaterial.trim();
      changes.push(`Material: ${caseItem.material} → ${editMaterial.trim()}`);
    }
    if (editDueDate.trim() !== (caseItem.dueDate || "")) {
      updates.dueDate = editDueDate.trim();
      changes.push(`Due Date: ${caseItem.dueDate || "none"} → ${editDueDate.trim()}`);
    }
    if (editNotes.trim() !== (caseItem.notes || "")) {
      updates.notes = editNotes.trim();
      changes.push("Notes updated");
    }

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
      const invUpdates: Partial<Invoice> = {};
      if (updates.doctorName) {
        invUpdates.clientName = updates.doctorName;
        invUpdates.billTo = updates.doctorName;
      }
      if (updates.patientName) invUpdates.patientName = updates.patientName;
      if (updates.toothIndices) invUpdates.teeth = updates.toothIndices;
      if (updates.shade) invUpdates.shade = updates.shade;
      if (updates.material || updates.toothIndices) {
        const mat = updates.material || caseItem.material;
        invUpdates.caseType = `${mat} Restoration`;
      }
      if (updates.dueDate) {
        invUpdates.dueAt = new Date(updates.dueDate + "T00:00:00").getTime();
      }
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

  function buildCaseHistoryHtml(): string {
    if (!caseItem) return "";
    const stationLabel = getStationInfo(caseItem.status, customStationLabels).label;
    const fmtDate = (ts: number | undefined | null) => {
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "—";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "—";
      return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}`;
    };
    const escapeHtml = (s: string) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const safeActivityLog = Array.isArray(caseItem.activityLog) ? caseItem.activityLog : [];
    const safeRouteHistory = Array.isArray(caseItem.routeHistory) ? caseItem.routeHistory : [];
    const entries = safeActivityLog.length > 0
      ? [...safeActivityLog].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      : [...safeRouteHistory].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).map((rh) => ({
          id: String(rh.timestamp),
          type: "station_change" as const,
          timestamp: rh.timestamp,
          description: `Case moved to ${getStationInfo(rh.station, customStationLabels).label}`,
          station: rh.station,
          user: undefined as string | undefined,
        }));

    const typeLabel: Record<string, string> = {
      created: "Created",
      scan: "Scanned",
      station_change: "Station Change",
      note: "Note",
      photo: "Photo",
      video: "Video",
      barcode_assigned: "Barcode Assigned",
      barcode_unassigned: "Barcode Removed",
      invoice_paid: "Invoice Paid",
      invoice_attached: "Invoice Attached",
      tracking_added: "Tracking Added",
      courtesy_text: "Courtesy Text",
      exocad_linked: "Exocad Linked",
      exocad_shared: "Exocad Shared",
    };

    const rows = entries
      .map((e) => {
        const matchingUser = e.user
          ? registeredUsers.find(
              (u) => u.id === e.user || u.username?.toLowerCase() === (e.user ?? "").toLowerCase()
            )
          : null;
        const userDisplay = matchingUser
          ? [matchingUser.firstName, matchingUser.lastName].filter(Boolean).join(" ") || matchingUser.username || (e.user ?? "")
          : (e.user ?? "");
        const eType: string = (e as any).type ?? "";
        const label = typeLabel[eType] || eType.replace(/_/g, " ");
        const stationStr = e.station ? getStationInfo(e.station, customStationLabels).label : "";
        return `<tr>
          <td class="ts">${escapeHtml(fmtDate(e.timestamp))}</td>
          <td class="ev">${escapeHtml(label)}${stationStr ? ` <span class="meta">(${escapeHtml(stationStr)})</span>` : ""}</td>
          <td class="desc">${escapeHtml((e as any).description || "")}</td>
          <td class="user">${escapeHtml(userDisplay)}</td>
        </tr>`;
      })
      .join("");

    const printedAt = new Date();
    const printedAtStr = `${printedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} ${printedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })}`;

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; padding: 24px; color: #111; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #666; margin-bottom: 18px; }
  .summary { background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 10px; padding: 12px 16px; margin-bottom: 18px; }
  .summary-row { display: flex; flex-wrap: wrap; gap: 18px 28px; font-size: 13px; }
  .summary-row div { min-width: 140px; }
  .summary-row strong { color: #111; }
  .summary-row span { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { text-align: left; background: #F1F5F9; padding: 8px 10px; border-bottom: 1px solid #CBD5E1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
  tbody td { padding: 8px 10px; border-bottom: 1px solid #F1F5F9; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #FAFAFA; }
  .ts { white-space: nowrap; color: #475569; width: 150px; }
  .ev { color: #111; font-weight: 600; width: 150px; }
  .meta { color: #94A3B8; font-weight: 400; font-size: 11px; }
  .desc { color: #1F2937; }
  .user { color: #475569; white-space: nowrap; width: 120px; text-align: right; }
  .empty { padding: 24px; text-align: center; color: #94A3B8; font-size: 13px; }
  .footer { margin-top: 24px; font-size: 10px; color: #94A3B8; text-align: center; }
</style></head>
<body>
  <h1>Case History — #${escapeHtml(String(caseItem.caseNumber || ""))}</h1>
  <div class="sub">Printed ${escapeHtml(printedAtStr)}</div>
  <div class="summary">
    <div class="summary-row">
      <div><strong>Patient:</strong> <span>${escapeHtml(caseItem.patientName || caseItem.patientInitials || "")}</span></div>
      <div><strong>Provider:</strong> <span>${escapeHtml(cleanDoctorDisplay(caseItem.doctorName || ""))}</span></div>
      <div><strong>Current Station:</strong> <span>${escapeHtml(stationLabel)}</span></div>
      <div><strong>Material:</strong> <span>${escapeHtml(caseItem.material || "")}</span></div>
      <div><strong>Teeth:</strong> <span>${escapeHtml(caseItem.toothIndices || "")}</span></div>
      <div><strong>Shade:</strong> <span>${escapeHtml(caseItem.shade || "")}</span></div>
      <div><strong>Due Date:</strong> <span>${escapeHtml(caseItem.dueDate || "")}</span></div>
      <div><strong>Created:</strong> <span>${escapeHtml(fmtDate(caseItem.createdAt || 0))}</span></div>
    </div>
  </div>
  ${entries.length > 0 ? `<table>
    <thead><tr><th>When</th><th>Event</th><th>Detail</th><th>By</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<div class="empty">No history entries yet.</div>`}
  <div class="footer">LabTrax · Case #${escapeHtml(String(caseItem.caseNumber || ""))} · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}</div>
</body></html>`;
  }

  async function handlePrintCaseHistory() {
    if (!caseItem) return;
    try {
      const html = buildCaseHistoryHtml();
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

  function buildCaseLabelHtml(caseRecord: typeof caseItem) {
    return `<html><head><style>
      body { font-family: Arial, sans-serif; padding: 20px; }
      .label { border: 2px solid #111; border-radius: 12px; padding: 20px; max-width: 400px; }
      .title { font-size: 26px; font-weight: bold; margin-bottom: 12px; }
      .row { font-size: 17px; margin: 6px 0; }
    </style></head><body>
      <div class="label">
        <div class="title">Case #${caseRecord?.caseNumber || ""}</div>
        <div class="row"><strong>Patient:</strong> ${caseRecord?.patientName || caseRecord?.patientInitials || ""}</div>
        <div class="row"><strong>Doctor:</strong> ${cleanDoctorDisplay(caseRecord?.doctorName || "")}</div>
        <div class="row"><strong>Teeth:</strong> ${caseRecord?.toothIndices || ""}</div>
        <div class="row"><strong>Shade:</strong> ${caseRecord?.shade || ""}</div>
        <div class="row"><strong>Material:</strong> ${caseRecord?.material || ""}</div>
        <div class="row"><strong>Due:</strong> ${caseRecord?.dueDate || ""}</div>
        ${caseRecord?.notes ? `<div class="row"><strong>Notes:</strong> ${caseRecord.notes}</div>` : ""}
      </div>
    </body></html>`;
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

  function itemUpdateToothDisplay(teeth: number[], types: Record<number, ToothType>) {
    const sorted = [...teeth].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      const t = sorted[i];
      const tp = types[t] || "normal";
      if (tp === "missing") { parts.push(`X${t}`); i++; }
      else if (tp === "bridge") {
        let end = i;
        while (end + 1 < sorted.length && (types[sorted[end + 1]] || "normal") === "bridge") end++;
        parts.push(end > i ? `#${sorted[i]}-#${sorted[end]}` : `#${t}`);
        i = end + 1;
      } else { parts.push(`#${t}`); i++; }
    }
    return parts.join(", ");
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

  const itemBillableCount = React.useMemo(() => {
    const normalCount = itemSelectedTeeth.filter((t) => (itemToothTypes[t] || "normal") === "normal").length;
    const hasPontic = itemSelectedTeeth.some((t) => (itemToothTypes[t] || "normal") === "bridge");
    return normalCount + (hasPontic ? 1 : 0);
  }, [itemSelectedTeeth, itemToothTypes]);

  const itemCalculatedPrice = React.useMemo(() => {
    const unitPrice = resolvePriceForCase(itemMaterial, itemCaseType, caseItem?.doctorName || "", clients, pricingTiers);
    return unitPrice * Math.max(itemBillableCount, 1);
  }, [itemMaterial, itemCaseType, itemBillableCount, caseItem?.doctorName, clients, pricingTiers]);

  const itemToothDisplay = React.useMemo(() => {
    return itemUpdateToothDisplay(itemSelectedTeeth, itemToothTypes);
  }, [itemSelectedTeeth, itemToothTypes]);

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

  function getAppliancePriceKey(subtype: string, variant: string): string {
    if (subtype === "Night Guard") {
      if (variant === "Hard") return "night_guard_hard";
      if (variant === "Soft") return "night_guard_soft";
      if (variant === "Hard/Soft") return "night_guard_hard_soft";
    } else if (subtype === "Retainer") {
      if (variant === "Hawley") return "retainer_hawley";
      if (variant === "Hard") return "retainer_hard";
      if (variant === "Lingual") return "retainer_lingual";
    } else if (subtype === "Snore Guard") {
      return "snore_guard";
    } else if (subtype === "Sports Guard") {
      return "sports_guard";
    }
    return "";
  }

  function getApplianceUnitPrice(priceKey: string): number {
    const client = clients.find(c => c.practiceName === (caseItem as any)?.clientName);
    if (client?.customPricing?.[priceKey] !== undefined && client.customPricing[priceKey] > 0) {
      return client.customPricing[priceKey];
    }
    const tier = pricingTiers.find(t => t.name === client?.tier);
    return tier?.prices?.[priceKey] || 0;
  }

  function addApplianceToInvoice(subtype: string, variant: string, arch: string) {
    const linkedInv = caseItem!.invoiceId ? invoices.find((inv) => inv.id === caseItem!.invoiceId) : undefined;
    if (!linkedInv) return;
    const priceKey = getAppliancePriceKey(subtype, variant);
    const unitPrice = getApplianceUnitPrice(priceKey);
    const itemLabel = variant ? `${subtype} - ${variant}` : subtype;
    let newItems;
    if (arch === "Both") {
      newItems = [
        { qty: 1, item: itemLabel, description: `${itemLabel} (Upper)`, rate: unitPrice, amount: unitPrice },
        { qty: 1, item: itemLabel, description: `${itemLabel} (Lower)`, rate: unitPrice, amount: unitPrice },
      ];
    } else {
      const archLabel = arch ? ` (${arch})` : "";
      newItems = [{ qty: 1, item: itemLabel, description: `${itemLabel}${archLabel}`, rate: unitPrice, amount: unitPrice }];
    }
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
          text: "Camera Photos",
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
              await Promise.all(result.assets.map((asset) => addCasePhoto(caseItem!.id, asset.uri, userInitials)));
              if (Platform.OS !== "web") {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            }
          },
        },
        {
          text: "Take Photo",
          onPress: () => handleTakePhoto(),
        },
        {
          text: "File Explorer",
          onPress: async () => {
            try {
              const result = await DocumentPicker.getDocumentAsync({
                type: ["image/*", "application/pdf"],
                multiple: true,
              });
              if (!result.canceled && result.assets && result.assets.length > 0) {
                await Promise.all(result.assets.map((asset) => addCasePhoto(caseItem!.id, asset.uri, userInitials)));
                if (Platform.OS !== "web") {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                }
              }
            } catch (e) {
              Alert.alert("Error", "Unable to open file explorer.");
            }
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
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
                ${caseItem.price.toFixed(2)}
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
          {(caseItem.activityLog && caseItem.activityLog.length > 0
            ? (() => {
                const sorted = [...caseItem.activityLog].sort((a, b) => b.timestamp - a.timestamp);
                const photoTimestamps = sorted.filter(e => e.type === "photo" || e.type === "video").map(e => e.timestamp);
                return sorted.filter(entry => {
                  if (entry.type !== "note") return true;
                  return !photoTimestamps.some(pt => Math.abs(pt - entry.timestamp) < 5000);
                });
              })()
            : [...caseItem.routeHistory].sort((a, b) => b.timestamp - a.timestamp).map((rh) => ({
                id: String(rh.timestamp),
                type: "station_change" as const,
                timestamp: rh.timestamp,
                description: `Case moved to ${getStationInfo(rh.station, customStationLabels).label}`,
                station: rh.station,
                user: undefined as string | undefined,
              }))
          ).map((entry, idx, arr) => {
            const isLast = idx === arr.length - 1;
            const isFirst = idx === 0;
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
              <View key={entry.id || idx} style={styles.timelineItem}>
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
                  <Text style={styles.timelineTime}>
                    {formatTimestamp(entry.timestamp)}
                  </Text>
                </View>
              </View>
            );
          })}
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
                    } catch {}
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

      <Modal
        visible={showAddItemModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowAddItemModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.addItemOverlay}
        >
          <View style={[styles.addItemSheet, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={styles.addItemHeader}>
              <Pressable onPress={() => {
                if (addItemStep === "caseType") {
                  setShowAddItemModal(false);
                } else if (addItemStep === "toothChart") {
                  if (itemCaseType === "Removable") setAddItemStep("removableSubtype");
                  else setAddItemStep("caseType");
                } else if (addItemStep === "material") {
                  setAddItemStep("toothChart");
                } else if (addItemStep === "removableSubtype") {
                  setAddItemStep("caseType");
                } else if (addItemStep === "removableMaterial") {
                  if (removableSubtype === "Denture") setAddItemStep("removableSubtype");
                  else setAddItemStep("toothChart");
                } else if (addItemStep === "gingivaShade") {
                  setAddItemStep("removableMaterial");
                } else if (addItemStep === "applianceSubtype") {
                  setAddItemStep("caseType");
                } else if (addItemStep === "applianceArch") {
                  setAddItemStep("applianceSubtype");
                } else if (addItemStep === "applianceNightGuardType") {
                  setAddItemStep("applianceArch");
                } else if (addItemStep === "applianceRetainerType") {
                  setAddItemStep("applianceArch");
                } else if (addItemStep === "applianceNightGuard") {
                  setAddItemStep("applianceSubtype");
                } else if (addItemStep === "applianceEssexTeeth") {
                  setAddItemStep("applianceSubtype");
                } else if (addItemStep === "applianceEssexShade") {
                  setAddItemStep("applianceEssexTeeth");
                } else {
                  setAddItemStep("caseType");
                }
              }}>
                <Ionicons name={addItemStep === "caseType" ? "close" : "arrow-back"} size={24} color={Colors.light.textSecondary} />
              </Pressable>
              <Text style={styles.addItemTitle}>
                {addItemStep === "caseType" ? "Select Case Type" :
                 addItemStep === "toothChart" ? "Select Teeth" :
                 addItemStep === "material" ? "Select Material" :
                 addItemStep === "removableSubtype" ? "Select Removable Type" :
                 addItemStep === "removableMaterial" ? "Select Material" :
                 addItemStep === "gingivaShade" ? "Select Gingiva Shade" :
                 addItemStep === "applianceSubtype" ? "Select Appliance Type" :
                 addItemStep === "applianceArch" ? "Select Arch" :
                 addItemStep === "applianceNightGuardType" ? "Night Guard Type" :
                 addItemStep === "applianceRetainerType" ? "Retainer Type" :
                 addItemStep === "applianceNightGuard" ? "Night Guard Type" :
                 addItemStep === "applianceEssexTeeth" ? "Select Teeth" :
                 addItemStep === "applianceEssexShade" ? "Select Shade" : "Add Item"}
              </Text>
              <View style={{ width: 24 }} />
            </View>

            {addItemStep === "caseType" && (
              <View style={styles.addItemCaseTypeList}>
                {(["Restorative", "Removable", "Appliance", "Temporary"] as CaseTypeValue[]).map((type) => (
                  <Pressable
                    key={type}
                    onPress={() => {
                      setItemCaseType(type);
                      if (type === "Restorative" || type === "Temporary") {
                        setAddItemStep("toothChart");
                      } else if (type === "Removable") {
                        setAddItemStep("removableSubtype");
                      } else if (type === "Appliance") {
                        setAddItemStep("applianceSubtype");
                      }
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      itemCaseType === type && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={type === "Restorative" ? "construct" : type === "Removable" ? "swap-horizontal" : type === "Appliance" ? "hardware-chip" : "timer"}
                        size={20}
                        color={itemCaseType === type ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, itemCaseType === type && styles.addItemCaseTypeTextSelected]}>
                      {type}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                ))}
              </View>
            )}

            {(addItemStep === "toothChart" || addItemStep === "applianceEssexTeeth") && (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
                <View style={styles.addItemSelectedType}>
                  <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                  <Text style={styles.addItemSelectedTypeText}>
                    {itemCaseType}{removableSubtype ? ` - ${removableSubtype}` : ""}{applianceSubtype ? ` - ${applianceSubtype}` : ""}
                  </Text>
                </View>

                <View style={styles.aiToothChartPanel}>
                  <View style={styles.aiToothChartHeader}>
                    <Text style={styles.aiToothChartTitle}>American Dental Numbering</Text>
                    {itemSelectedTeeth.length > 0 && (
                      <Pressable
                        onPress={() => { setItemSelectedTeeth([]); setItemToothTypes({}); }}
                        style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                      >
                        <Text style={styles.aiToothChartClear}>Clear</Text>
                      </Pressable>
                    )}
                  </View>

                  <View style={styles.aiToothChartLegend}>
                    <View style={styles.aiLegendItem}>
                      <View style={[styles.aiLegendDot, { backgroundColor: Colors.light.tint }]} />
                      <Text style={styles.aiLegendText}>Normal</Text>
                    </View>
                    <View style={styles.aiLegendItem}>
                      <View style={[styles.aiLegendDot, { backgroundColor: Colors.light.accent }]} />
                      <Text style={styles.aiLegendText}>Pontic</Text>
                    </View>
                    <View style={styles.aiLegendItem}>
                      <View style={[styles.aiLegendDot, { backgroundColor: Colors.light.error }]} />
                      <Text style={styles.aiLegendText}>Missing</Text>
                    </View>
                    <Text style={styles.aiLegendHint}>Hold to set type</Text>
                  </View>

                  <View style={{ alignItems: "center" as const, paddingVertical: 8, backgroundColor: "#FFFFFF", borderRadius: 12, overflow: "hidden" as const }}>
                    {(() => {
                      const IMG_W = 290;
                      const IMG_H = 345;
                      const TOOTH_SZ = 28;
                      const scale = IMG_W / 320;

                      const toothPositions: { num: number; x: number; y: number }[] = [
                        { num: 1, x: 26 * scale, y: 166 * scale },
                        { num: 2, x: 32 * scale, y: 132 * scale },
                        { num: 3, x: 42 * scale, y: 100 * scale },
                        { num: 4, x: 56 * scale, y: 72 * scale },
                        { num: 5, x: 74 * scale, y: 48 * scale },
                        { num: 6, x: 96 * scale, y: 28 * scale },
                        { num: 7, x: 122 * scale, y: 14 * scale },
                        { num: 8, x: 148 * scale, y: 8 * scale },
                        { num: 9, x: 174 * scale, y: 8 * scale },
                        { num: 10, x: 200 * scale, y: 14 * scale },
                        { num: 11, x: 226 * scale, y: 28 * scale },
                        { num: 12, x: 248 * scale, y: 48 * scale },
                        { num: 13, x: 266 * scale, y: 72 * scale },
                        { num: 14, x: 280 * scale, y: 100 * scale },
                        { num: 15, x: 290 * scale, y: 132 * scale },
                        { num: 16, x: 296 * scale, y: 166 * scale },
                        { num: 17, x: 296 * scale, y: 210 * scale },
                        { num: 18, x: 290 * scale, y: 244 * scale },
                        { num: 19, x: 280 * scale, y: 274 * scale },
                        { num: 20, x: 266 * scale, y: 300 * scale },
                        { num: 21, x: 248 * scale, y: 322 * scale },
                        { num: 22, x: 226 * scale, y: 340 * scale },
                        { num: 23, x: 200 * scale, y: 352 * scale },
                        { num: 24, x: 174 * scale, y: 360 * scale },
                        { num: 25, x: 148 * scale, y: 360 * scale },
                        { num: 26, x: 122 * scale, y: 352 * scale },
                        { num: 27, x: 96 * scale, y: 340 * scale },
                        { num: 28, x: 74 * scale, y: 322 * scale },
                        { num: 29, x: 56 * scale, y: 300 * scale },
                        { num: 30, x: 42 * scale, y: 274 * scale },
                        { num: 31, x: 32 * scale, y: 244 * scale },
                        { num: 32, x: 26 * scale, y: 210 * scale },
                      ];

                      const normalColor = Colors.light.tint;
                      const ponticColor = Colors.light.accent;
                      const missingColor = Colors.light.error;

                      return (
                        <View style={{ width: IMG_W, height: IMG_H, position: "relative" }}>
                          <Image
                            source={require("@/assets/images/tooth-chart.jpeg")}
                            style={{ width: IMG_W, height: IMG_H, position: "absolute", top: 0, left: 0 }}
                            contentFit="contain"
                          />
                          {toothPositions.map(({ num, x, y }) => {
                            const isSelected = itemSelectedTeeth.includes(num);
                            const tType = itemToothTypes[num] || "normal";
                            let bgColor = "transparent";
                            let borderCol = "transparent";
                            let textColor = "transparent";
                            if (isSelected) {
                              if (tType === "normal") { bgColor = normalColor + "CC"; borderCol = normalColor; textColor = "#FFF"; }
                              else if (tType === "bridge") { bgColor = ponticColor + "CC"; borderCol = ponticColor; textColor = "#FFF"; }
                              else if (tType === "missing") { bgColor = "#FEE2E2CC"; borderCol = missingColor; textColor = missingColor; }
                            }
                            return (
                              <Pressable
                                key={num}
                                onPress={() => handleItemToothTap(num)}
                                onLongPress={() => handleItemToothLongPress(num)}
                                delayLongPress={400}
                                style={{
                                  position: "absolute",
                                  left: x - TOOTH_SZ / 2,
                                  top: y - TOOTH_SZ / 2,
                                  width: TOOTH_SZ,
                                  height: TOOTH_SZ,
                                  borderRadius: TOOTH_SZ / 2,
                                  backgroundColor: bgColor,
                                  borderWidth: isSelected ? 2 : 0,
                                  borderColor: borderCol,
                                  alignItems: "center" as const,
                                  justifyContent: "center" as const,
                                  zIndex: 10,
                                }}
                              >
                                {isSelected && tType === "missing" ? (
                                  <View style={styles.aiToothMissingWrap}>
                                    <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: missingColor }}>{num}</Text>
                                    <View style={styles.aiToothXOverlay}>
                                      <Ionicons name="close" size={12} color={missingColor} />
                                    </View>
                                  </View>
                                ) : isSelected ? (
                                  <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: textColor }}>{num}</Text>
                                ) : null}
                              </Pressable>
                            );
                          })}
                        </View>
                      );
                    })()}
                  </View>

                  {itemSelectedTeeth.length > 0 && (
                    <View style={styles.aiToothChartSummary}>
                      <View style={styles.aiToothSummaryRow}>
                        <Ionicons name="checkmark-circle" size={16} color={Colors.light.tint} />
                        <Text style={styles.aiToothChartSummaryText}>{itemToothDisplay}</Text>
                      </View>
                    </View>
                  )}
                </View>

                {(itemCaseType === "Restorative" || itemCaseType === "Temporary") && itemSelectedTeeth.length > 0 && showPrice && (
                  <View style={styles.aiPricingRow}>
                    <Text style={styles.aiPricingLabel}>
                      {itemBillableCount} billable {itemBillableCount === 1 ? "tooth" : "teeth"} x ${resolvePriceForCase(itemMaterial, itemCaseType, caseItem?.doctorName || "", clients, pricingTiers)}/{itemMaterial}
                    </Text>
                    <Text style={styles.aiPricingTotal}>${itemCalculatedPrice.toLocaleString()}</Text>
                  </View>
                )}

                <Pressable
                  onPress={() => {
                    if (addItemStep === "applianceEssexTeeth") {
                      setAddItemStep("applianceEssexShade");
                    } else if (itemCaseType === "Restorative" || itemCaseType === "Temporary") {
                      setAddItemStep("material");
                    } else if (itemCaseType === "Removable") {
                      setAddItemStep("removableMaterial");
                    }
                  }}
                  style={({ pressed }) => [
                    styles.aiSaveItemBtn,
                    { backgroundColor: Colors.light.tint },
                    itemSelectedTeeth.length === 0 && { opacity: 0.5 },
                    pressed && { opacity: 0.85 },
                  ]}
                  disabled={itemSelectedTeeth.length === 0}
                >
                  <Ionicons name="arrow-forward" size={20} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Next</Text>
                </Pressable>
              </ScrollView>
            )}

            {addItemStep === "material" && (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
                <View style={styles.addItemSelectedType}>
                  <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                  <Text style={styles.addItemSelectedTypeText}>{itemCaseType} - {itemToothDisplay}</Text>
                </View>

                <View style={styles.aiMaterialSection}>
                  <Text style={styles.aiMaterialLabel}>Material</Text>
                  <View style={styles.aiMaterialSelector}>
                    {["Zirconia", "E.max", "PFM", "Gold", "Semi Precious", "Full Cast", "Diagnostic Wax Up", "Other"].map((m) => (
                      <Pressable
                        key={m}
                        onPress={() => setItemMaterial(m)}
                        style={[
                          styles.aiMaterialChip,
                          itemMaterial === m && styles.aiMaterialChipActive,
                        ]}
                      >
                        <Text style={[
                          styles.aiMaterialText,
                          itemMaterial === m && styles.aiMaterialTextActive,
                        ]}>{m}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                {itemSelectedTeeth.length > 0 && showPrice && (
                  <View style={styles.aiPricingRow}>
                    <Text style={styles.aiPricingLabel}>
                      {itemBillableCount} billable {itemBillableCount === 1 ? "tooth" : "teeth"} x ${resolvePriceForCase(itemMaterial, itemCaseType, caseItem?.doctorName || "", clients, pricingTiers)}/{itemMaterial}
                    </Text>
                    <Text style={styles.aiPricingTotal}>${itemCalculatedPrice.toLocaleString()}</Text>
                  </View>
                )}

                <Pressable
                  onPress={handleSaveItem}
                  style={({ pressed }) => [
                    styles.aiSaveItemBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Ionicons name="checkmark" size={20} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Complete</Text>
                </Pressable>
              </ScrollView>
            )}

            {addItemStep === "removableSubtype" && (
              <View style={styles.addItemCaseTypeList}>
                {["Full Denture", "Partial", "Nesbit", "Interim Partial", "Immediate Partial", "Immediate Denture"].map((sub) => {
                  const iconMap: Record<string, string> = { "Full Denture": "apps", "Partial": "pie-chart", "Nesbit": "git-branch", "Interim Partial": "time", "Immediate Partial": "flash", "Immediate Denture": "speedometer" };
                  const isDenture = sub === "Full Denture" || sub === "Immediate Denture";
                  return (
                  <Pressable
                    key={sub}
                    onPress={() => {
                      setRemovableSubtype(sub);
                      if (isDenture) {
                        setAddItemStep("removableMaterial");
                      } else {
                        setAddItemStep("toothChart");
                      }
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      removableSubtype === sub && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={(iconMap[sub] || "ellipsis-horizontal") as any}
                        size={20}
                        color={removableSubtype === sub ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, removableSubtype === sub && styles.addItemCaseTypeTextSelected]}>
                      {sub}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                  );
                })}
              </View>
            )}

            {addItemStep === "removableMaterial" && (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
                <View style={styles.addItemSelectedType}>
                  <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                  <Text style={styles.addItemSelectedTypeText}>Removable - {removableSubtype}</Text>
                </View>

                <View style={styles.addItemCaseTypeList}>
                  {["Acrylic", "Flexible", "Cast Metal", "Other"].map((mat) => (
                    <Pressable
                      key={mat}
                      onPress={() => {
                        setRemovableMaterial(mat);
                        if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      style={({ pressed }) => [
                        styles.addItemCaseTypeItem,
                        removableMaterial === mat && styles.addItemCaseTypeItemSelected,
                        pressed && { opacity: 0.7 },
                      ]}
                    >
                      <View style={styles.addItemCaseTypeIcon}>
                        <Ionicons
                          name={mat === "Acrylic" ? "color-palette" : mat === "Flexible" ? "water" : mat === "Cast Metal" ? "hammer" : "ellipsis-horizontal"}
                          size={20}
                          color={removableMaterial === mat ? Colors.light.tint : Colors.light.textSecondary}
                        />
                      </View>
                      <Text style={[styles.addItemCaseTypeText, removableMaterial === mat && styles.addItemCaseTypeTextSelected]}>
                        {mat}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {removableMaterial === "Other" && (
                  <TextInput
                    style={{ borderWidth: 1, borderColor: "#E0E0E0", borderRadius: 8, padding: 12, marginTop: 12, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text }}
                    placeholder="Describe custom material..."
                    placeholderTextColor={Colors.light.textTertiary}
                    value={removableCustomMaterial}
                    onChangeText={setRemovableCustomMaterial}
                  />
                )}

                <Pressable
                  onPress={() => setAddItemStep("gingivaShade")}
                  style={({ pressed }) => [
                    styles.aiSaveItemBtn,
                    { backgroundColor: Colors.light.tint, marginTop: 16 },
                    !removableMaterial && { opacity: 0.5 },
                    pressed && { opacity: 0.85 },
                  ]}
                  disabled={!removableMaterial}
                >
                  <Ionicons name="arrow-forward" size={20} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Next</Text>
                </Pressable>
              </ScrollView>
            )}

            {addItemStep === "gingivaShade" && (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
                <View style={styles.addItemSelectedType}>
                  <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                  <Text style={styles.addItemSelectedTypeText}>Removable - {removableSubtype} - {removableMaterial === "Other" && removableCustomMaterial ? removableCustomMaterial : removableMaterial}</Text>
                </View>

                <View style={styles.addItemCaseTypeList}>
                  {["Standard Pink Light", "Light Meharry", "Dark Meharry", "Other"].map((shade) => (
                    <Pressable
                      key={shade}
                      onPress={() => {
                        setGingivaShade(shade);
                        if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      style={({ pressed }) => [
                        styles.addItemCaseTypeItem,
                        gingivaShade === shade && styles.addItemCaseTypeItemSelected,
                        pressed && { opacity: 0.7 },
                      ]}
                    >
                      <View style={styles.addItemCaseTypeIcon}>
                        <Ionicons
                          name={shade === "Other" ? "ellipsis-horizontal" : "color-fill"}
                          size={20}
                          color={gingivaShade === shade ? Colors.light.tint : Colors.light.textSecondary}
                        />
                      </View>
                      <Text style={[styles.addItemCaseTypeText, gingivaShade === shade && styles.addItemCaseTypeTextSelected]}>
                        {shade}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {gingivaShade === "Other" && (
                  <TextInput
                    style={{ borderWidth: 1, borderColor: "#E0E0E0", borderRadius: 8, padding: 12, marginTop: 12, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text }}
                    placeholder="Describe custom gingiva shade..."
                    placeholderTextColor={Colors.light.textTertiary}
                    value={gingivaCustomNote}
                    onChangeText={setGingivaCustomNote}
                  />
                )}

                {gingivaShade === "Other" && gingivaCustomNote.trim().length > 0 && (
                  <Pressable
                    onPress={() => {
                      if (gingivaCustomNote.trim()) {
                        setGingivaShade(gingivaCustomNote.trim());
                      }
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={({ pressed }) => [
                      styles.aiSaveItemBtn,
                      { backgroundColor: "#F5A623", marginTop: 12 },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Ionicons name="document-text" size={18} color="#FFF" />
                    <Text style={styles.aiSaveItemBtnText}>Add to Case Notes</Text>
                  </Pressable>
                )}

                <Pressable
                  onPress={handleSaveItem}
                  style={({ pressed }) => [
                    styles.aiSaveItemBtn,
                    { marginTop: 16 },
                    !gingivaShade && { opacity: 0.5 },
                    pressed && { opacity: 0.85 },
                  ]}
                  disabled={!gingivaShade}
                >
                  <Ionicons name="checkmark" size={20} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Complete</Text>
                </Pressable>
              </ScrollView>
            )}

            {addItemStep === "applianceSubtype" && (
              <View style={styles.addItemCaseTypeList}>
                {[
                  { label: "Night Guard", icon: "moon" as const },
                  { label: "Retainer", icon: "fitness" as const },
                  { label: "Snore Guard", icon: "bed" as const },
                  { label: "Sports Guard", icon: "shield" as const },
                ].map(({ label, icon }) => (
                  <Pressable
                    key={label}
                    onPress={() => {
                      setApplianceSubtype(label);
                      setApplianceArch("");
                      setApplianceVariant("");
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      if (label === "Night Guard" || label === "Retainer") {
                        setAddItemStep("applianceArch");
                      } else {
                        addCaseItem(caseItem!.id, itemCaseType, [], {}, label, { applianceSubType: label });
                        addApplianceToInvoice(label, "", "");
                        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        setShowAddItemModal(false);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      applianceSubtype === label && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons name={icon} size={20} color={applianceSubtype === label ? Colors.light.tint : Colors.light.textSecondary} />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, applianceSubtype === label && styles.addItemCaseTypeTextSelected]}>
                      {label}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                ))}
              </View>
            )}

            {addItemStep === "applianceArch" && (
              <View style={styles.addItemCaseTypeList}>
                <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                    {applianceSubtype} · Select arch
                  </Text>
                </View>
                {(["Upper", "Lower", "Both"] as const).map((arch) => (
                  <Pressable
                    key={arch}
                    onPress={() => {
                      setApplianceArch(arch);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      if (applianceSubtype === "Night Guard") {
                        setAddItemStep("applianceNightGuardType");
                      } else {
                        setAddItemStep("applianceRetainerType");
                      }
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      applianceArch === arch && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={arch === "Upper" ? "arrow-up-circle" : arch === "Lower" ? "arrow-down-circle" : "swap-vertical"}
                        size={20}
                        color={applianceArch === arch ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.addItemCaseTypeText, applianceArch === arch && styles.addItemCaseTypeTextSelected]}>
                        {arch}
                      </Text>
                      {arch === "Both" && (
                        <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>
                          Bills as 2 line items
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                ))}
              </View>
            )}

            {addItemStep === "applianceNightGuardType" && (
              <View style={styles.addItemCaseTypeList}>
                <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                    Night Guard · {applianceArch} · Select type
                  </Text>
                </View>
                {[
                  { label: "Hard", icon: "shield" as const, desc: "Rigid acrylic" },
                  { label: "Soft", icon: "water" as const, desc: "Flexible EVA" },
                  { label: "Hard/Soft", icon: "shield-half" as const, desc: "Dual-laminate" },
                ].map(({ label, icon, desc }) => (
                  <Pressable
                    key={label}
                    onPress={() => {
                      setApplianceVariant(label);
                      setNightGuardType(label);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      addCaseItem(caseItem!.id, itemCaseType, [], {}, "Night Guard", { applianceSubType: "Night Guard", nightGuardType: label });
                      addApplianceToInvoice("Night Guard", label, applianceArch);
                      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setShowAddItemModal(false);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      applianceVariant === label && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons name={icon} size={20} color={applianceVariant === label ? Colors.light.tint : Colors.light.textSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.addItemCaseTypeText, applianceVariant === label && styles.addItemCaseTypeTextSelected]}>
                        {label}
                      </Text>
                      <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>{desc}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            )}

            {addItemStep === "applianceRetainerType" && (
              <View style={styles.addItemCaseTypeList}>
                <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                    Retainer · {applianceArch} · Select type
                  </Text>
                </View>
                {[
                  { label: "Hawley", icon: "construct" as const, desc: "Wire + acrylic" },
                  { label: "Hard", icon: "layers" as const, desc: "Clear rigid" },
                  { label: "Lingual", icon: "git-commit" as const, desc: "Fixed wire" },
                ].map(({ label, icon, desc }) => (
                  <Pressable
                    key={label}
                    onPress={() => {
                      setApplianceVariant(label);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      addCaseItem(caseItem!.id, itemCaseType, [], {}, "Retainer", { applianceSubType: "Retainer", nightGuardType: label });
                      addApplianceToInvoice("Retainer", label, applianceArch);
                      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setShowAddItemModal(false);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      applianceVariant === label && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons name={icon} size={20} color={applianceVariant === label ? Colors.light.tint : Colors.light.textSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.addItemCaseTypeText, applianceVariant === label && styles.addItemCaseTypeTextSelected]}>
                        {label}
                      </Text>
                      <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>{desc}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            )}

            {addItemStep === "applianceEssexShade" && (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
                <View style={styles.addItemSelectedType}>
                  <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                  <Text style={styles.addItemSelectedTypeText}>Appliance - Essex - {itemToothDisplay}</Text>
                </View>

                <View style={{ flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 }}>
                  {SHADE_OPTIONS.map((shade) => (
                    <Pressable
                      key={shade}
                      onPress={() => {
                        setEssexShade(shade);
                        if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      style={[
                        styles.aiMaterialChip,
                        { flex: undefined, paddingHorizontal: 14, minWidth: 60 },
                        essexShade === shade && styles.aiMaterialChipActive,
                      ]}
                    >
                      <Text style={[
                        styles.aiMaterialText,
                        essexShade === shade && styles.aiMaterialTextActive,
                      ]}>{shade}</Text>
                    </Pressable>
                  ))}
                </View>

                <Pressable
                  onPress={handleSaveItem}
                  style={({ pressed }) => [
                    styles.aiSaveItemBtn,
                    { marginTop: 16 },
                    !essexShade && { opacity: 0.5 },
                    pressed && { opacity: 0.85 },
                  ]}
                  disabled={!essexShade}
                >
                  <Ionicons name="checkmark" size={20} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Complete</Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showCourtesyModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowCourtesyModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={ctStyles.modalOverlay}
        >
          <View style={ctStyles.modalCard}>
            <View style={ctStyles.modalHeader}>
              <Text style={ctStyles.modalTitle}>Courtesy Text</Text>
              <Pressable onPress={() => setShowCourtesyModal(false)}>
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>
            <Text style={ctStyles.modalSubtitle}>
              Send a delay notification to the doctor. You can edit the message before sending.
            </Text>
            <TextInput
              style={ctStyles.messageInput}
              value={courtesyMessage}
              onChangeText={setCourtesyMessage}
              multiline
              textAlignVertical="top"
              placeholder="Courtesy message..."
              placeholderTextColor="#94A3B8"
            />
            <Pressable
              onPress={() => {
                if (courtesyMessage.trim()) {
                  sendCourtesyText(caseItem.id, courtesyMessage.trim(), currentUser || "lab");
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  setShowCourtesyModal(false);
                  setCourtesyMessage("");
                }
              }}
              style={({ pressed }) => [ctStyles.sendBtn, pressed && { opacity: 0.85 }]}
            >
              <Ionicons name="send" size={20} color="#FFF" />
              <Text style={ctStyles.sendBtnText}>Send Courtesy Text</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showExocadModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowExocadModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={ctStyles.modalOverlay}
        >
          <View style={ctStyles.modalCard}>
            <View style={ctStyles.modalHeader}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="cube-outline" size={22} color="#7C3AED" />
                <Text style={ctStyles.modalTitle}>Link ExoCAD Design</Text>
              </View>
              <Pressable onPress={() => setShowExocadModal(false)}>
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>
            <Text style={ctStyles.modalSubtitle}>
              Paste the ExoCAD WebView URL to share the 3D design with the provider.
            </Text>
            <TextInput
              style={[ctStyles.dateInput, { marginBottom: 12 }]}
              value={exocadUrlInput}
              onChangeText={setExocadUrlInput}
              placeholder="https://webview.exocad.com/..."
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Pressable
              onPress={() => {
                const url = exocadUrlInput.trim();
                if (!url) {
                  Alert.alert("Please enter an ExoCAD WebView URL");
                  return;
                }
                if (!url.startsWith("http")) {
                  Alert.alert("Invalid URL", "Please enter a valid URL starting with http:// or https://");
                  return;
                }
                const entry = {
                  id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                  type: "exocad_linked" as const,
                  timestamp: Date.now(),
                  description: `ExoCAD WebView design linked`,
                  user: userInitials,
                };
                updateCase(caseItem.id, {
                  exocadWebviewUrl: url,
                  activityLog: [...(caseItem.activityLog || []), entry],
                });
                if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setShowExocadModal(false);
                setExocadUrlInput("");
                Alert.alert(
                  "ExoCAD Design Linked",
                  "Would you like to share this design with the provider now?",
                  [
                    { text: "Later", style: "cancel" },
                    {
                      text: "Share Now",
                      onPress: async () => {
                        try {
                          await Share.share({
                            message: `View the 3D design for patient ${caseItem.patientName} (Case ${caseItem.caseNumber}):\n${url}`,
                            title: "ExoCAD WebView Design",
                          });
                          const shareEntry = {
                            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                            type: "exocad_shared" as const,
                            timestamp: Date.now(),
                            description: `ExoCAD design shared for ${caseItem.patientName}`,
                            user: userInitials,
                          };
                          updateCase(caseItem.id, {
                            activityLog: [...(caseItem.activityLog || []), entry, shareEntry],
                          });
                        } catch {}
                      },
                    },
                  ]
                );
              }}
              style={({ pressed }) => [ctStyles.sendBtn, { backgroundColor: "#7C3AED" }, pressed && { opacity: 0.85 }]}
            >
              <Ionicons name="link" size={20} color="#FFF" />
              <Text style={ctStyles.sendBtnText}>Link Design</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showDateProposalModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowDateProposalModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={ctStyles.modalOverlay}
        >
          <View style={ctStyles.modalCard}>
            <View style={ctStyles.modalHeader}>
              <Text style={ctStyles.modalTitle}>Propose Delivery Date</Text>
              <Pressable onPress={() => setShowDateProposalModal(false)}>
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>
            <Text style={ctStyles.modalSubtitle}>
              Provide an updated delivery date and time for the client to review.
            </Text>
            <Text style={ctStyles.inputLabel}>Date (MM/DD/YYYY)</Text>
            <TextInput
              style={ctStyles.dateInput}
              value={proposalDate}
              onChangeText={setProposalDate}
              placeholder="03/15/2026"
              placeholderTextColor="#94A3B8"
            />
            <Text style={ctStyles.inputLabel}>Time</Text>
            <TextInput
              style={ctStyles.dateInput}
              value={proposalTime}
              onChangeText={setProposalTime}
              placeholder="2:00 PM"
              placeholderTextColor="#94A3B8"
            />
            <Pressable
              onPress={() => {
                if (proposalDate.trim() && proposalTime.trim() && activeCourtesyId) {
                  proposeDeliveryDate(caseItem.id, activeCourtesyId, proposalDate.trim(), proposalTime.trim(), currentUser || "lab");
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  setShowDateProposalModal(false);
                  setProposalDate("");
                  setProposalTime("");
                  setActiveCourtesyId("");
                }
              }}
              style={({ pressed }) => [ctStyles.sendBtn, { backgroundColor: "#3B82F6" }, pressed && { opacity: 0.85 }]}
            >
              <Ionicons name="calendar" size={20} color="#FFF" />
              <Text style={ctStyles.sendBtnText}>Propose Date</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={showDeclineModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowDeclineModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={ctStyles.modalOverlay}
        >
          <View style={ctStyles.modalCard}>
            <View style={ctStyles.modalHeader}>
              <Text style={ctStyles.modalTitle}>Decline Proposed Date</Text>
              <Pressable onPress={() => setShowDeclineModal(false)}>
                <Ionicons name="close" size={24} color={Colors.light.textSecondary} />
              </Pressable>
            </View>
            <Text style={ctStyles.modalSubtitle}>
              Let the lab know why this date doesn't work so they can propose a better one.
            </Text>
            <TextInput
              style={ctStyles.messageInput}
              value={declineNote}
              onChangeText={setDeclineNote}
              multiline
              textAlignVertical="top"
              placeholder="Optional note..."
              placeholderTextColor="#94A3B8"
            />
            <Pressable
              onPress={() => {
                if (activeCourtesyId) {
                  respondToProposedDate(caseItem.id, activeCourtesyId, false, currentUser || "client", declineNote.trim() || undefined);
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                  setShowDeclineModal(false);
                  setDeclineNote("");
                  setActiveCourtesyId("");
                }
              }}
              style={({ pressed }) => [ctStyles.sendBtn, { backgroundColor: "#EF4444" }, pressed && { opacity: 0.85 }]}
            >
              <Ionicons name="close-circle" size={20} color="#FFF" />
              <Text style={ctStyles.sendBtnText}>Decline & Request New Date</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {isAdmin && (
      <Modal visible={showEditCase} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
            <View style={{ backgroundColor: "#FFF", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "90%", paddingBottom: Platform.OS === "web" ? 34 : insets.bottom }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#E2E8F0" }}>
                <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#1E293B" }}>Edit Case</Text>
                <Pressable onPress={() => setShowEditCase(false)}>
                  <Ionicons name="close" size={24} color="#64748B" />
                </Pressable>
              </View>
              <ScrollView style={{ paddingHorizontal: 20 }} contentContainerStyle={{ paddingVertical: 16, gap: 14 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <View>
                  <Text style={editFieldStyles.label}>Provider / Doctor</Text>
                  <TextInput style={editFieldStyles.input} value={editDoctor} onChangeText={setEditDoctor} placeholder="Doctor name" placeholderTextColor="#94A3B8" />
                  {editDoctor.trim().toLowerCase() !== (caseItem.doctorName || "").toLowerCase() && editDoctor.trim().length > 0 && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, backgroundColor: "#FEF3C7", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
                      <Ionicons name="swap-horizontal" size={14} color="#D97706" />
                      <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: "#92400E", flex: 1 }}>Invoice will transfer to new provider</Text>
                    </View>
                  )}
                </View>

                <View>
                  <Text style={editFieldStyles.label}>Patient Name</Text>
                  <TextInput style={editFieldStyles.input} value={editPatient} onChangeText={setEditPatient} placeholder="Patient name" placeholderTextColor="#94A3B8" />
                </View>

                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={editFieldStyles.label}>Teeth</Text>
                    <TextInput style={editFieldStyles.input} value={editTeeth} onChangeText={setEditTeeth} placeholder="e.g. 3,4,5" placeholderTextColor="#94A3B8" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={editFieldStyles.label}>Shade</Text>
                    <TextInput style={editFieldStyles.input} value={editShade} onChangeText={setEditShade} placeholder="e.g. A2" placeholderTextColor="#94A3B8" />
                  </View>
                </View>

                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={editFieldStyles.label}>Material</Text>
                    <TextInput style={editFieldStyles.input} value={editMaterial} onChangeText={setEditMaterial} placeholder="e.g. Zirconia" placeholderTextColor="#94A3B8" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={editFieldStyles.label}>Due Date (YYYY-MM-DD)</Text>
                    <TextInput style={editFieldStyles.input} value={editDueDate} onChangeText={setEditDueDate} placeholder="2025-12-31" placeholderTextColor="#94A3B8" />
                  </View>
                </View>

                <View>
                  <Text style={editFieldStyles.label}>Notes</Text>
                  <TextInput style={[editFieldStyles.input, { height: 80, textAlignVertical: "top" }]} value={editNotes} onChangeText={setEditNotes} placeholder="Case notes..." placeholderTextColor="#94A3B8" multiline />
                </View>

                <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                  <Pressable
                    onPress={() => setShowEditCase(false)}
                    style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: "#F1F5F9", alignItems: "center" as const }, pressed && { opacity: 0.85 }]}
                  >
                    <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#64748B" }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleSaveEditCase}
                    style={({ pressed }) => [{ flex: 1, flexDirection: "row" as const, gap: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: "#10B981", alignItems: "center" as const, justifyContent: "center" as const }, pressed && { opacity: 0.85 }]}
                  >
                    <Ionicons name="checkmark-circle" size={18} color="#FFF" />
                    <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Save Changes</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      )}

      <Modal visible={showQuickEdit} transparent animationType="fade">
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 20 }} onPress={() => setShowQuickEdit(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={{ backgroundColor: "#FFF", borderRadius: 16, padding: 20, maxHeight: "90%" }} onPress={(e) => e.stopPropagation()}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#1E293B" }}>Edit Case Info</Text>
              <Pressable onPress={() => setShowQuickEdit(false)} hitSlop={12}>
                <Ionicons name="close" size={22} color="#64748B" />
              </Pressable>
            </View>

            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Doctor</Text>
            <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B", marginBottom: 12 }} value={qeDoctor} onChangeText={setQeDoctor} placeholder="Doctor name" placeholderTextColor="#94A3B8" />

            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Patient</Text>
            <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B", marginBottom: 12 }} value={qePatient} onChangeText={setQePatient} placeholder="Patient name" placeholderTextColor="#94A3B8" />

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Teeth</Text>
                <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B" }} value={qeTeeth} onChangeText={setQeTeeth} placeholder="#30, #31" placeholderTextColor="#94A3B8" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Shade</Text>
                <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B" }} value={qeShade} onChangeText={setQeShade} placeholder="A2" placeholderTextColor="#94A3B8" />
              </View>
            </View>

            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Material</Text>
            <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B", marginBottom: 12 }} value={qeMaterial} onChangeText={setQeMaterial} placeholder="Zirconia" placeholderTextColor="#94A3B8" />

            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Due Date (YYYY-MM-DD)</Text>
            <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B", marginBottom: 12 }} value={qeDueDate} onChangeText={setQeDueDate} placeholder="2026-04-15" placeholderTextColor="#94A3B8" />

            <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Notes</Text>
            <TextInput style={{ borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 10, padding: 12, fontSize: 15, fontFamily: "Inter_500Medium", color: "#1E293B", marginBottom: 16, minHeight: 80, textAlignVertical: "top" }} value={qeNotes} onChangeText={setQeNotes} placeholder="Case notes..." placeholderTextColor="#94A3B8" multiline />

            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable onPress={() => setShowQuickEdit(false)} style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: "#F1F5F9", alignItems: "center" as const }, pressed && { opacity: 0.85 }]}>
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#64748B" }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const changes: string[] = [];
                  const caseUpdates: Record<string, any> = {};
                  if (qeDoctor.trim() && qeDoctor.trim() !== caseItem.doctorName) { caseUpdates.doctorName = qeDoctor.trim(); changes.push(`Doctor: ${qeDoctor.trim()}`); }
                  if (qePatient.trim() && qePatient.trim() !== ((caseItem as any).patientName || caseItem.patientInitials)) { caseUpdates.patientName = qePatient.trim(); changes.push(`Patient: ${qePatient.trim()}`); }
                  if (qeTeeth.trim() && qeTeeth.trim() !== caseItem.toothIndices) { caseUpdates.toothIndices = qeTeeth.trim(); changes.push(`Teeth: ${qeTeeth.trim()}`); }
                  if (qeShade.trim() && qeShade.trim() !== caseItem.shade) { caseUpdates.shade = qeShade.trim(); changes.push(`Shade: ${qeShade.trim()}`); }
                  if (qeMaterial.trim() && qeMaterial.trim() !== caseItem.material) { caseUpdates.material = qeMaterial.trim(); changes.push(`Material: ${qeMaterial.trim()}`); }
                  if (qeDueDate.trim() && qeDueDate.trim() !== caseItem.dueDate) { caseUpdates.dueDate = qeDueDate.trim(); changes.push(`Due: ${qeDueDate.trim()}`); }
                  if (qeNotes.trim() !== (caseItem.notes || "")) { caseUpdates.notes = qeNotes.trim(); changes.push("Notes updated"); }

                  if (changes.length === 0) {
                    setShowQuickEdit(false);
                    return;
                  }

                  updateCase(caseItem.id, caseUpdates);

                  if (caseUpdates.material || caseUpdates.toothIndices || caseUpdates.doctorName) {
                    const toothCount = (caseUpdates.toothIndices || caseItem.toothIndices).split(",").filter(Boolean).length || 1;
                    const mat = caseUpdates.material || caseItem.material;
                    const rate = resolvePriceForCase(mat, caseItem.caseType, caseUpdates.doctorName || caseItem.doctorName, clients, pricingTiers);
                    const newTotal = toothCount * rate + (caseItem.isRush ? 500 : 0);
                    updateCase(caseItem.id, { price: newTotal });
                    if (caseItem.invoiceId) {
                      const lineItems = [{ qty: toothCount, item: `${mat} ${caseItem.caseType || "Restoration"}`, description: `${mat} restoration - teeth ${caseUpdates.toothIndices || caseItem.toothIndices}`, rate, amount: toothCount * rate }];
                      if (caseItem.isRush) lineItems.push({ qty: 1, item: "Rush Fee", description: "Expedited turnaround", rate: 500, amount: 500 });
                      updateInvoice(caseItem.invoiceId, {
                        lineItems,
                        amount: newTotal,
                        billTo: caseUpdates.doctorName || caseItem.doctorName,
                        patientName: caseUpdates.patientName || (caseItem as any).patientName || caseItem.patientInitials,
                        teeth: caseUpdates.toothIndices || caseItem.toothIndices,
                        shade: caseUpdates.shade || caseItem.shade,
                        caseNotes: caseUpdates.notes !== undefined ? caseUpdates.notes : (caseItem.notes || ""),
                      });
                    }
                  } else if (caseItem.invoiceId) {
                    const invUpdates: Record<string, any> = {};
                    if (caseUpdates.doctorName) invUpdates.billTo = caseUpdates.doctorName;
                    if (caseUpdates.patientName) invUpdates.patientName = caseUpdates.patientName;
                    if (caseUpdates.shade) invUpdates.shade = caseUpdates.shade;
                    if (caseUpdates.toothIndices) invUpdates.teeth = caseUpdates.toothIndices;
                    if (caseUpdates.notes !== undefined) invUpdates.caseNotes = caseUpdates.notes;
                    if (Object.keys(invUpdates).length > 0) updateInvoice(caseItem.invoiceId, invUpdates);
                  }

                  const changeDesc = changes.join("; ");
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
                  const savedQe = { ...caseItem, ...caseUpdates };
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
                style={({ pressed }) => [{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: "#2563EB", alignItems: "center" as const }, pressed && { opacity: 0.85 }]}
              >
                <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>Save Changes</Text>
              </Pressable>
            </View>
            </ScrollView>
          </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

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

      <Modal visible={showLabSlipModal} animationType="slide" transparent>
        <View style={labSlipStyles.overlay}>
          <View style={labSlipStyles.container}>
            <View style={labSlipStyles.header}>
              <Text style={labSlipStyles.headerTitle}>Lab Slip</Text>
              <Pressable onPress={() => setShowLabSlipModal(false)}>
                <Ionicons name="close" size={24} color={Colors.light.text} />
              </Pressable>
            </View>

            <ScrollView style={labSlipStyles.body} showsVerticalScrollIndicator={false}>
              <View style={labSlipStyles.slipCard}>
                <View style={labSlipStyles.slipHeader}>
                  <Text style={labSlipStyles.slipTitle}>DENTAL LAB WORK ORDER</Text>
                  <Text style={labSlipStyles.slipCaseNum}>Case {caseItem.caseNumber}</Text>
                </View>

                <View style={labSlipStyles.divider} />

                <View style={labSlipStyles.slipRow}>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Doctor</Text>
                    <Text style={labSlipStyles.slipValue}>{cleanDoctorDisplay(caseItem.doctorName)}</Text>
                  </View>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Patient</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.patientName}</Text>
                  </View>
                </View>

                <View style={labSlipStyles.slipRow}>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Case Type</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.caseType || "N/A"}</Text>
                  </View>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Material</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.material}</Text>
                  </View>
                </View>

                <View style={labSlipStyles.slipRow}>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Tooth / Units</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.toothIndices}</Text>
                  </View>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Shade</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.shade}</Text>
                  </View>
                </View>

                <View style={labSlipStyles.slipRow}>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Due Date</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.dueDate || "N/A"}</Text>
                  </View>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Current Station</Text>
                    <Text style={labSlipStyles.slipValue}>{getStationInfo(caseItem.status, customStationLabels).label}</Text>
                  </View>
                </View>

                <View style={labSlipStyles.slipRow}>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Rush</Text>
                    <Text style={[labSlipStyles.slipValue, caseItem.isRush && { color: "#EF4444", fontFamily: "Inter_700Bold" }]}>
                      {caseItem.isRush ? "YES - RUSH" : "No"}
                    </Text>
                  </View>
                  <View style={labSlipStyles.slipCol}>
                    <Text style={labSlipStyles.slipLabel}>Remake</Text>
                    <Text style={[labSlipStyles.slipValue, caseItem.isRemake && { color: "#F59E0B", fontFamily: "Inter_700Bold" }]}>
                      {caseItem.isRemake ? "YES" : "No"}
                    </Text>
                  </View>
                </View>

                {caseItem.isRemake && caseItem.remakeReason && (
                  <View style={labSlipStyles.slipFullRow}>
                    <Text style={labSlipStyles.slipLabel}>Remake Reason</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.remakeReason}</Text>
                  </View>
                )}

                {(caseItem.toothMap || []).length > 0 && (
                  <View style={labSlipStyles.slipFullRow}>
                    <Text style={labSlipStyles.slipLabel}>Tooth Details</Text>
                    {caseItem.toothMap!.map((t, i) => (
                      <Text key={i} style={labSlipStyles.slipValue}>
                        #{t.num} - {t.type}
                      </Text>
                    ))}
                  </View>
                )}

                {caseItem.notes ? (
                  <View style={labSlipStyles.slipFullRow}>
                    <Text style={labSlipStyles.slipLabel}>Notes</Text>
                    <Text style={labSlipStyles.slipValue}>{caseItem.notes}</Text>
                  </View>
                ) : null}

                <View style={labSlipStyles.divider} />

                <View style={labSlipStyles.slipFooter}>
                  <Text style={labSlipStyles.footerText}>
                    Received: {new Date(caseItem.createdAt).toLocaleDateString()}
                  </Text>
                  {caseItem.assignedBarcode && (
                    <Text style={labSlipStyles.footerText}>
                      Barcode: {caseItem.assignedBarcode}
                    </Text>
                  )}
                </View>
              </View>
            </ScrollView>

            <Pressable
              onPress={() => {
                if (Platform.OS === "web") {
                  window.print();
                } else {
                  Alert.alert("Print", "The lab slip is displayed above. Use your device's print feature to print this document.");
                }
              }}
              style={({ pressed }) => [
                labSlipStyles.printBtn,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="print" size={20} color="#FFF" />
              <Text style={labSlipStyles.printBtnText}>Print Lab Slip</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={showBarcodeScanner} animationType="slide" onRequestClose={() => setShowBarcodeScanner(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 10, paddingHorizontal: 20, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Scan Barcode</Text>
            <Pressable onPress={() => setShowBarcodeScanner(false)} style={{ padding: 8 }}>
              <Ionicons name="close" size={24} color="#FFF" />
            </Pressable>
          </View>
          <View style={{ flex: 1, overflow: "hidden" }}>
            {cameraPermission?.granted ? (
              <>
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["code128", "code39", "ean13", "ean8", "upc_a", "upc_e", "qr", "pdf417", "itf14", "codabar"] }}
                  onBarcodeScanned={barcodeScanned ? undefined : (result) => {
                    setBarcodeScanned(true);
                    const scannedBarcode = result.data;
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
                <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: "center" }} pointerEvents="none">
                  <View style={{ width: 260, height: 100, borderWidth: 2, borderColor: "rgba(79,142,247,0.6)", borderRadius: 12, borderStyle: "dashed" }} />
                  <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 8 }}>
                    Align barcode in the box
                  </Text>
                </View>
              </>
            ) : (
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.4)" />
                <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, fontFamily: "Inter_500Medium", marginTop: 12, textAlign: "center", paddingHorizontal: 40 }}>Camera permission is required to scan barcodes.</Text>
                <Pressable
                  onPress={async () => {
                    const result = await requestCameraPermission();
                    if (!result.granted) {
                      Alert.alert("Permission Denied", "Please enable camera access in your device settings.");
                    }
                  }}
                  style={({ pressed }) => ({ marginTop: 16, backgroundColor: "#4F8EF7", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, opacity: pressed ? 0.8 : 1 })}
                >
                  <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Grant Camera Access</Text>
                </Pressable>
              </View>
            )}
          </View>
          <View style={{ paddingHorizontal: 20, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 10, paddingTop: 16, alignItems: "center" }}>
            <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" }}>
              Point camera at a barcode to assign it to case {caseItem?.caseNumber}
            </Text>
          </View>
        </View>
      </Modal>

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

const labSlipStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  container: {
    flex: 1,
    backgroundColor: "#FFF",
    marginTop: 60,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  body: {
    flex: 1,
    padding: 20,
  },
  slipCard: {
    backgroundColor: "#FAFAFA",
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },
  slipHeader: {
    alignItems: "center",
    marginBottom: 12,
  },
  slipTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    letterSpacing: 1.5,
  },
  slipCaseNum: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: "#CBD5E1",
    marginVertical: 14,
  },
  slipRow: {
    flexDirection: "row",
    marginBottom: 14,
    gap: 12,
  },
  slipCol: {
    flex: 1,
  },
  slipFullRow: {
    marginBottom: 14,
  },
  slipLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94A3B8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  slipValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  slipFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94A3B8",
  },
  printBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#6366F1",
    paddingVertical: 16,
    margin: 20,
    borderRadius: 14,
  },
  printBtnText: {
    fontSize: 16,
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

const editFieldStyles = StyleSheet.create({
  label: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#64748B",
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#1E293B",
    backgroundColor: "#F8FAFC",
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
