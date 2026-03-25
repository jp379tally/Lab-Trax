import React, { useState, useRef } from "react";
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
  Image,
  KeyboardAvoidingView,
  Share,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus, ToothType, MATERIAL_PRICES, CaseTypeValue, Invoice, SHADE_OPTIONS, cleanDoctorDisplay, formatInvNum } from "@/lib/data";
import { ChatButton } from "@/components/ChatButton";
import InvoicePDFViewer from "@/components/InvoicePDFViewer";
import { logAudit } from "@/lib/audit";
import { CameraPermissionModal } from "@/components/CameraPermissionPrompt";

export default function CaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { cases, updateCaseStatus, addCasePhoto, addCaseNote, addTrackingNumber, addCaseItem, role, adminUnlocked, users, invoices, updateInvoice, sendCourtesyText, respondToCourtesyText, proposeDeliveryDate, respondToProposedDate, assignBarcodeToCase, findCaseByBarcode, customStationLabels, addNotification } = useApp();
  const { currentUser, userType } = useAuth();
  const userInitials = currentUser ? currentUser.substring(0, 2).toUpperCase() : "??";
  const insets = useSafeAreaInsets();
  const [showRouting, setShowRouting] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
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
  type AddItemStep = "caseType" | "toothChart" | "material" | "removableSubtype" | "removableMaterial" | "gingivaShade" | "applianceSubtype" | "applianceNightGuard" | "applianceEssexTeeth" | "applianceEssexShade" | "complete";
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
  const [essexShade, setEssexShade] = useState("");

  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false);
  const [barcodeScanned, setBarcodeScanned] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [showCameraPrompt, setShowCameraPrompt] = useState(false);
  const cameraPromptCallbackRef = useRef<(() => void) | null>(null);

  async function requestCameraWithPrompt(onGranted: () => void) {
    const perm = await ImagePicker.getCameraPermissionsAsync();
    if (perm.granted) {
      onGranted();
      return;
    }
    cameraPromptCallbackRef.current = onGranted;
    setShowCameraPrompt(true);
  }

  async function handleCameraPromptContinue() {
    setShowCameraPrompt(false);
    const cb = cameraPromptCallbackRef.current;
    cameraPromptCallbackRef.current = null;
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status === "granted" && cb) {
      cb();
    }
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
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showLabSlipModal, setShowLabSlipModal] = useState(false);
  const [fullScreenPhoto, setFullScreenPhoto] = useState<string | null>(null);
  const [photoNotes, setPhotoNotes] = useState("");
  const [showPhotoNotes, setShowPhotoNotes] = useState(false);

  const caseItem = cases.find((c) => c.id === id);
  const isAdmin = role === "admin" && adminUnlocked;
  const showPrice = isAdmin;

  React.useEffect(() => {
    if (caseItem && currentUser) {
      logAudit("VIEW_CASE", currentUser, `Case ${caseItem.caseNumber} - Patient: ${caseItem.patientName}`);
    }
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
    const matchedInv = invoices.find(
      (inv) => inv.caseIds.includes(caseItem.id) ||
        (inv.patientName.toLowerCase() === (caseItem.patientName || "").toLowerCase() && inv.clientName.toLowerCase().includes(caseItem.doctorName.split(" ").pop()?.toLowerCase() || ""))
    );
    if (matchedInv) return matchedInv;
    const toothCount = caseItem.toothMap?.length || caseItem.toothIndices.split(",").filter(Boolean).length || 1;
    const rate = MATERIAL_PRICES[caseItem.material] || 250;
    const lineItems = [
      { qty: toothCount, item: `${caseItem.material} ${caseItem.caseType || "Restoration"}`, description: `${caseItem.material} restoration - teeth ${caseItem.toothIndices}`, rate, amount: toothCount * rate },
    ];
    if (caseItem.isRush) {
      lineItems.push({ qty: 1, item: "Rush Fee", description: "Expedited turnaround", rate: 500, amount: 500 });
    }
    const total = lineItems.reduce((s, li) => s + li.amount, 0);
    const invNum = `INV-${new Date(caseItem.createdAt).getFullYear()}-${caseItem.caseNumber.replace(/[^0-9]/g, "").padStart(3, "0")}`;
    return {
      id: caseItem.id + "-inv",
      invoiceNumber: invNum,
      clientId: "",
      clientName: caseItem.doctorName,
      caseIds: [caseItem.id],
      amount: total,
      credits: caseItem.isRemake && caseItem.price === 0 ? total : 0,
      status: caseItem.status === "COMPLETE" ? "paid" as const : "open" as const,
      issuedAt: caseItem.createdAt,
      dueAt: caseItem.dueDate ? new Date(caseItem.dueDate + "T00:00:00").getTime() : caseItem.createdAt + 30 * 86400000,
      billTo: caseItem.doctorName,
      patientName: caseItem.patientName || caseItem.patientInitials,
      caseType: caseItem.caseType || "Restoration",
      teeth: caseItem.toothIndices,
      shade: caseItem.shade,
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
    const unitPrice = MATERIAL_PRICES[itemMaterial] || 250;
    return unitPrice * Math.max(itemBillableCount, 1);
  }, [itemMaterial, itemBillableCount]);

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
    setEssexShade("");
    setShowAddItemModal(true);
  }

  function handleSaveItem() {
    if (!itemCaseType) {
      Alert.alert("Missing Info", "Please select a case type.");
      return;
    }
    const skipToothValidation =
      (itemCaseType === "Removable" && removableSubtype === "Denture") ||
      (itemCaseType === "Appliance" && ["Snore Guard", "Ortho Retainer", "Other"].includes(applianceSubtype)) ||
      (itemCaseType === "Appliance" && applianceSubtype === "Night Guard");

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
      const unitPrice = MATERIAL_PRICES[mat] || 250;
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
              result.assets.forEach((asset) => {
                addCasePhoto(caseItem!.id, asset.uri, userInitials);
              });
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
                result.assets.forEach((asset) => {
                  addCasePhoto(caseItem!.id, asset.uri, userInitials);
                });
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
    capturedPhotos.forEach((uri) => {
      addCasePhoto(caseItem!.id, uri, userInitials);
    });
    if (photoNotes.trim()) {
      addCaseNote(caseItem!.id, photoNotes.trim(), userInitials);
    }
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    const photoCount = capturedPhotos.length;
    const hasNotes = !!photoNotes.trim();

    if (userType === "provider") {
      const parts: string[] = [];
      parts.push(`${photoCount} file${photoCount > 1 ? "s" : ""}`);
      if (hasNotes) parts.push("notes");
      const notifTitle = "Provider Media Added";
      const notifMsg = `${currentUser || "Provider"} added ${parts.join(" and ")} to Case ${caseItem!.caseNumber}`;
      addNotification({
        title: notifTitle,
        message: notifMsg,
        type: "alert",
        caseId: caseItem!.id,
      });
    }

    const msg = hasNotes
      ? `${photoCount} file${photoCount > 1 ? "s" : ""} and notes added to case.`
      : `${photoCount} file${photoCount > 1 ? "s" : ""} added to case.`;
    Alert.alert("Saved", msg);
    setCapturedPhotos([]);
    setPhotoNotes("");
    setShowPhotoNotes(false);
    setShowPhotoPreview(false);
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

  function handleEntrySavePhotos() {
    entryPhotos.forEach((uri) => addCasePhoto(caseItem!.id, uri, userInitials));
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
                  addCasePhoto(caseItem!.id, uri, userInitials);
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
                  addCasePhoto(caseItem!.id, result.assets[0].uri, userInitials);
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
                  addCasePhoto(caseItem!.id, uri, userInitials);
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
                  addCasePhoto(caseItem!.id, result.assets[0].uri, userInitials);
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
              result.assets.forEach((asset) => {
                addCasePhoto(caseItem!.id, asset.uri, userInitials);
              });
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

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 34 + 40 : insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
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

        <View style={styles.infoGrid}>
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
        </View>


        {showPrice && (
        <Pressable
          onPress={() => {
            setShowInvoiceModal(true);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }}
          style={({ pressed }) => [
            {
              flexDirection: "row" as const,
              alignItems: "center" as const,
              justifyContent: "center" as const,
              gap: 8,
              marginHorizontal: 16,
              marginBottom: 16,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: "#2563EB",
            },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Ionicons name="document-text" size={18} color="#FFF" />
          <Text style={{ fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF" }}>View Invoice</Text>
        </Pressable>
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
                      <Text style={{ fontSize: 11, fontFamily: "Inter_700Bold", color: Colors.light.textSecondary }}>{entry.user}</Text>
                    </View>
                  ) : null}
                </View>
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

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Case History</Text>
        </View>
        <View style={styles.timeline}>
          {(caseItem.activityLog && caseItem.activityLog.length > 0
            ? [...caseItem.activityLog].sort((a, b) => b.timestamp - a.timestamp)
            : [...caseItem.routeHistory].sort((a, b) => b.timestamp - a.timestamp).map((rh) => ({
                id: String(rh.timestamp),
                type: "station_change" as const,
                timestamp: rh.timestamp,
                description: `Case moved to ${getStationInfo(rh.station, customStationLabels).label}`,
                station: rh.station,
              }))
          ).map((entry, idx, arr) => {
            const isLast = idx === arr.length - 1;
            const isFirst = idx === 0;
            const isStation = entry.type === "station_change" || entry.type === "created" || entry.type === "scan";
            const isNote = entry.type === "note";
            const isPhoto = entry.type === "photo";
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
            } else if (isPhoto) {
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

            const entryUserName = entry.user
              ? (users.find((u) => u.id === entry.user || u.name === entry.user)?.name || entry.user)
              : "";
            const userInitials = entryUserName
              ? entryUserName.split(" ").map((w: string) => w.charAt(0).toUpperCase()).join("").slice(0, 2)
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
                    {userInitials ? (
                      <Text style={{ fontSize: 8, fontFamily: "Inter_700Bold", color: "#FFF" }}>{userInitials}</Text>
                    ) : (
                      <Ionicons name="navigate" size={10} color="#FFF" />
                    )}
                  </View>
                  {!isLast && <View style={styles.timelineConnector} />}
                </View>
                <View style={[styles.timelineContent, isPhoto && entry.imageUri ? { paddingBottom: 20 } : {}]}>
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
                            <Text style={styles.initialsText}>{entry.user}</Text>
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
                    <View style={{
                      backgroundColor: isBarcode ? "#ECFDF5" : isInvoice ? "#EFF6FF" : isTracking ? "#EEF2FF" : "#FDF2F8",
                      borderRadius: 10,
                      padding: 10,
                      borderLeftWidth: 3,
                      borderLeftColor: isBarcode ? "#10B981" : isInvoice ? "#3B82F6" : isTracking ? "#6366F1" : "#EC4899",
                    }}>
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
                            <Text style={styles.initialsText}>{entry.user}</Text>
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
                    </View>
                  ) : (
                    <View style={{
                      backgroundColor: isNote ? "#FFF7ED" : "#F5F3FF",
                      borderRadius: 10,
                      padding: 10,
                      borderLeftWidth: 3,
                      borderLeftColor: isNote ? "#F59E0B" : "#8B5CF6",
                    }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <Ionicons
                          name={isNote ? "document-text" : "camera"}
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
                          {isNote ? "Note" : "Photo"}
                        </Text>
                        {entry.user && (
                          <View style={styles.initialsChip}>
                            <Text style={styles.initialsText}>{entry.user}</Text>
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
                      {isPhoto && (() => {
                        const nearbyNote = (caseItem.activityLog || []).find(
                          (e) => e.type === "note" && Math.abs(e.timestamp - entry.timestamp) < 5000
                        );
                        if (!nearbyNote) return null;
                        return (
                          <Text style={{
                            fontSize: 12,
                            fontFamily: "Inter_400Regular",
                            fontStyle: "italic",
                            color: Colors.light.textSecondary,
                            marginTop: 4,
                            lineHeight: 17,
                          }}>
                            {nearbyNote.description}
                          </Text>
                        );
                      })()}
                      {isPhoto && entry.imageUri && (
                        <Pressable onPress={() => setFullScreenPhoto(entry.imageUri!)}>
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
                        </Pressable>
                      )}
                    </View>
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

          <View style={styles.actionRow}>
            <Pressable
              onPress={handleTakePhoto}
              style={({ pressed }) => [
                styles.actionBtn,
                styles.actionBtnHalf,
                { backgroundColor: "#0EA5E9" },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="camera" size={20} color="#FFF" />
              <Text style={styles.actionBtnText}>Add Picture/Video</Text>
            </Pressable>

            <Pressable
              onPress={() => setShowNoteModal(true)}
              style={({ pressed }) => [
                styles.actionBtn,
                styles.actionBtnHalf,
                { backgroundColor: "#8B5CF6" },
                pressed && { opacity: 0.85 },
              ]}
            >
              <MaterialCommunityIcons name="note-plus" size={20} color="#FFF" />
              <Text style={styles.actionBtnText}>Add Note</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={handleAttachFile}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: Colors.light.surface, borderWidth: 1.5, borderColor: Colors.light.tint },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Ionicons name="attach" size={20} color={Colors.light.tint} />
            <Text style={[styles.actionBtnText, { color: Colors.light.tint }]}>Attach File</Text>
          </Pressable>

          <Pressable
            onPress={openAddItemModal}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: "#10B981" },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Ionicons name="add-circle" size={20} color="#FFF" />
            <Text style={styles.actionBtnText}>Add Item</Text>
          </Pressable>

          {userType !== "provider" && (
          <Pressable
            onPress={() => {
              const stationInfo = getStationInfo(caseItem.status, customStationLabels);
              const msg = `Hello Dr. ${caseItem.doctorName}, this is a courtesy text to inform you that patient ${caseItem.patientName} has a case that was delayed in production. The case is currently in ${stationInfo.label}. If the patient is scheduled and you would like a more specific updated estimated delivery date and time please let us know.`;
              setCourtesyMessage(msg);
              setShowCourtesyModal(true);
            }}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: "#F59E0B" },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Ionicons name="time" size={20} color="#FFF" />
            <Text style={styles.actionBtnText}>Courtesy Text</Text>
          </Pressable>
          )}

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
                          if (!perm.granted) {
                            Alert.alert("Camera access is required to scan barcodes.");
                            return;
                          }
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
                  if (!perm.granted) {
                    Alert.alert("Camera access is required to scan barcodes.");
                    return;
                  }
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
      </ScrollView>

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
                  <Text style={styles.completeSectionTitle}>Completion Photos</Text>
                </View>
                {(() => {
                  const completePhotos = (caseItem.activityLog || [])
                    .filter((a) => a.type === "photo" && a.imageUri)
                    .map((a) => a.imageUri!);
                  const allPhotos = [...(caseItem.photos || []), ...completePhotos];
                  const uniquePhotos = [...new Set(allPhotos)];
                  if (uniquePhotos.length === 0) {
                    return <Text style={styles.completeEmptyText}>No photos available</Text>;
                  }
                  return (
                    <View style={styles.completePhotoGrid}>
                      {uniquePhotos.map((uri, idx) => (
                        <Image
                          key={idx}
                          source={{ uri }}
                          style={styles.completePhoto}
                          resizeMode="cover"
                        />
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

                  <View style={styles.aiAdaChartContainer}>
                    <View style={styles.aiAdaQuadrantLabels}>
                      <Text style={styles.aiAdaQuadrantLabel}>Upper Right</Text>
                      <Text style={styles.aiAdaQuadrantLabel}>Upper Left</Text>
                    </View>
                    <View style={styles.aiAdaRow}>
                      {[1,2,3,4,5,6,7,8].map((num) => {
                        const isSelected = itemSelectedTeeth.includes(num);
                        const tType = itemToothTypes[num] || "normal";
                        return (
                          <Pressable
                            key={num}
                            onPress={() => handleItemToothTap(num)}
                            onLongPress={() => handleItemToothLongPress(num)}
                            delayLongPress={400}
                            style={[
                              styles.aiAdaToothBtn,
                              num === 8 && styles.aiAdaToothBtnMidline,
                              isSelected && tType === "normal" && styles.aiToothBtnSelected,
                              isSelected && tType === "bridge" && styles.aiToothBtnBridge,
                              isSelected && tType === "missing" && styles.aiToothBtnMissing,
                            ]}
                          >
                            {isSelected && tType === "missing" ? (
                              <View style={styles.aiToothMissingWrap}>
                                <Text style={[styles.aiAdaToothText, styles.aiToothBtnTextMissing]}>{num}</Text>
                                <View style={styles.aiToothXOverlay}>
                                  <Ionicons name="close" size={14} color={Colors.light.error} />
                                </View>
                              </View>
                            ) : (
                              <Text style={[
                                styles.aiAdaToothText,
                                isSelected && tType === "normal" && styles.aiToothBtnTextSelected,
                                isSelected && tType === "bridge" && styles.aiToothBtnTextBridge,
                              ]}>{num}</Text>
                            )}
                          </Pressable>
                        );
                      })}
                      <View style={styles.aiAdaMidline} />
                      {[9,10,11,12,13,14,15,16].map((num) => {
                        const isSelected = itemSelectedTeeth.includes(num);
                        const tType = itemToothTypes[num] || "normal";
                        return (
                          <Pressable
                            key={num}
                            onPress={() => handleItemToothTap(num)}
                            onLongPress={() => handleItemToothLongPress(num)}
                            delayLongPress={400}
                            style={[
                              styles.aiAdaToothBtn,
                              isSelected && tType === "normal" && styles.aiToothBtnSelected,
                              isSelected && tType === "bridge" && styles.aiToothBtnBridge,
                              isSelected && tType === "missing" && styles.aiToothBtnMissing,
                            ]}
                          >
                            {isSelected && tType === "missing" ? (
                              <View style={styles.aiToothMissingWrap}>
                                <Text style={[styles.aiAdaToothText, styles.aiToothBtnTextMissing]}>{num}</Text>
                                <View style={styles.aiToothXOverlay}>
                                  <Ionicons name="close" size={14} color={Colors.light.error} />
                                </View>
                              </View>
                            ) : (
                              <Text style={[
                                styles.aiAdaToothText,
                                isSelected && tType === "normal" && styles.aiToothBtnTextSelected,
                                isSelected && tType === "bridge" && styles.aiToothBtnTextBridge,
                              ]}>{num}</Text>
                            )}
                          </Pressable>
                        );
                      })}
                    </View>

                    <View style={styles.aiAdaDividerRow}>
                      <View style={styles.aiAdaDividerLine} />
                    </View>

                    <View style={styles.aiAdaRow}>
                      {[32,31,30,29,28,27,26,25].map((num) => {
                        const isSelected = itemSelectedTeeth.includes(num);
                        const tType = itemToothTypes[num] || "normal";
                        return (
                          <Pressable
                            key={num}
                            onPress={() => handleItemToothTap(num)}
                            onLongPress={() => handleItemToothLongPress(num)}
                            delayLongPress={400}
                            style={[
                              styles.aiAdaToothBtn,
                              num === 25 && styles.aiAdaToothBtnMidline,
                              isSelected && tType === "normal" && styles.aiToothBtnSelected,
                              isSelected && tType === "bridge" && styles.aiToothBtnBridge,
                              isSelected && tType === "missing" && styles.aiToothBtnMissing,
                            ]}
                          >
                            {isSelected && tType === "missing" ? (
                              <View style={styles.aiToothMissingWrap}>
                                <Text style={[styles.aiAdaToothText, styles.aiToothBtnTextMissing]}>{num}</Text>
                                <View style={styles.aiToothXOverlay}>
                                  <Ionicons name="close" size={14} color={Colors.light.error} />
                                </View>
                              </View>
                            ) : (
                              <Text style={[
                                styles.aiAdaToothText,
                                isSelected && tType === "normal" && styles.aiToothBtnTextSelected,
                                isSelected && tType === "bridge" && styles.aiToothBtnTextBridge,
                              ]}>{num}</Text>
                            )}
                          </Pressable>
                        );
                      })}
                      <View style={styles.aiAdaMidline} />
                      {[24,23,22,21,20,19,18,17].map((num) => {
                        const isSelected = itemSelectedTeeth.includes(num);
                        const tType = itemToothTypes[num] || "normal";
                        return (
                          <Pressable
                            key={num}
                            onPress={() => handleItemToothTap(num)}
                            onLongPress={() => handleItemToothLongPress(num)}
                            delayLongPress={400}
                            style={[
                              styles.aiAdaToothBtn,
                              isSelected && tType === "normal" && styles.aiToothBtnSelected,
                              isSelected && tType === "bridge" && styles.aiToothBtnBridge,
                              isSelected && tType === "missing" && styles.aiToothBtnMissing,
                            ]}
                          >
                            {isSelected && tType === "missing" ? (
                              <View style={styles.aiToothMissingWrap}>
                                <Text style={[styles.aiAdaToothText, styles.aiToothBtnTextMissing]}>{num}</Text>
                                <View style={styles.aiToothXOverlay}>
                                  <Ionicons name="close" size={14} color={Colors.light.error} />
                                </View>
                              </View>
                            ) : (
                              <Text style={[
                                styles.aiAdaToothText,
                                isSelected && tType === "normal" && styles.aiToothBtnTextSelected,
                                isSelected && tType === "bridge" && styles.aiToothBtnTextBridge,
                              ]}>{num}</Text>
                            )}
                          </Pressable>
                        );
                      })}
                    </View>

                    <View style={styles.aiAdaQuadrantLabels}>
                      <Text style={styles.aiAdaQuadrantLabel}>Lower Right</Text>
                      <Text style={styles.aiAdaQuadrantLabel}>Lower Left</Text>
                    </View>
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
                      {itemBillableCount} billable {itemBillableCount === 1 ? "tooth" : "teeth"} x ${MATERIAL_PRICES[itemMaterial] || 250}/{itemMaterial}
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
                    {["Zirconia", "E.max", "PFM", "Gold", "Other"].map((m) => (
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
                      {itemBillableCount} billable {itemBillableCount === 1 ? "tooth" : "teeth"} x ${MATERIAL_PRICES[itemMaterial] || 250}/{itemMaterial}
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
                {["Nesbit", "Partial", "Denture", "Flipper", "Other"].map((sub) => (
                  <Pressable
                    key={sub}
                    onPress={() => {
                      setRemovableSubtype(sub);
                      if (sub === "Denture") {
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
                        name={sub === "Nesbit" ? "git-branch" : sub === "Partial" ? "pie-chart" : sub === "Denture" ? "apps" : sub === "Flipper" ? "swap-vertical" : "ellipsis-horizontal"}
                        size={20}
                        color={removableSubtype === sub ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, removableSubtype === sub && styles.addItemCaseTypeTextSelected]}>
                      {sub}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                ))}
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
                {["Night Guard", "Snore Guard", "Essex", "Ortho Retainer", "Other"].map((sub) => (
                  <Pressable
                    key={sub}
                    onPress={() => {
                      setApplianceSubtype(sub);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      if (sub === "Night Guard") {
                        setAddItemStep("applianceNightGuard");
                      } else if (sub === "Essex") {
                        setAddItemStep("applianceEssexTeeth");
                      } else {
                        const mat = sub;
                        addCaseItem(caseItem!.id, itemCaseType, [], {}, mat, { applianceSubType: sub });
                        const linkedInv = caseItem!.invoiceId ? invoices.find((inv) => inv.id === caseItem!.invoiceId) : undefined;
                        if (linkedInv) {
                          const unitPrice = MATERIAL_PRICES[mat] || 250;
                          const newLi = { qty: 1, item: `${mat} Appliance`, description: `Appliance - ${sub}`, rate: unitPrice, amount: unitPrice };
                          const updLi = [...linkedInv.lineItems, newLi];
                          updateInvoice(linkedInv.id, { lineItems: updLi, amount: updLi.reduce((s, li) => s + li.amount, 0) });
                        }
                        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        setShowAddItemModal(false);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      applianceSubtype === sub && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={sub === "Night Guard" ? "moon" : sub === "Snore Guard" ? "bed" : sub === "Essex" ? "layers" : sub === "Ortho Retainer" ? "fitness" : "ellipsis-horizontal"}
                        size={20}
                        color={applianceSubtype === sub ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, applianceSubtype === sub && styles.addItemCaseTypeTextSelected]}>
                      {sub}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                  </Pressable>
                ))}
              </View>
            )}

            {addItemStep === "applianceNightGuard" && (
              <View style={styles.addItemCaseTypeList}>
                {["Hard Night Guard", "Hard/Soft Night Guard"].map((ng) => (
                  <Pressable
                    key={ng}
                    onPress={() => {
                      setNightGuardType(ng);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      addCaseItem(caseItem!.id, itemCaseType, [], {}, applianceSubtype, { applianceSubType: applianceSubtype, nightGuardType: ng });
                      const linkedInv = caseItem!.invoiceId ? invoices.find((inv) => inv.id === caseItem!.invoiceId) : undefined;
                      if (linkedInv) {
                        const unitPrice = MATERIAL_PRICES[applianceSubtype] || 250;
                        const newLi = { qty: 1, item: `${ng} Appliance`, description: `Appliance - ${ng}`, rate: unitPrice, amount: unitPrice };
                        const updLi = [...linkedInv.lineItems, newLi];
                        updateInvoice(linkedInv.id, { lineItems: updLi, amount: updLi.reduce((s, li) => s + li.amount, 0) });
                      }
                      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      setShowAddItemModal(false);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      nightGuardType === ng && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={ng === "Hard Night Guard" ? "shield" : "shield-half"}
                        size={20}
                        color={nightGuardType === ng ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, nightGuardType === ng && styles.addItemCaseTypeTextSelected]}>
                      {ng}
                    </Text>
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

      {showPrice && (
      <InvoicePDFViewer
        visible={showInvoiceModal}
        onClose={() => setShowInvoiceModal(false)}
        invoice={caseInvoice}
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
                        #{t.tooth} - {t.type}{t.material ? ` (${t.material})` : ""}
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

      <CameraPermissionModal
        visible={showCameraPrompt}
        onContinue={handleCameraPromptContinue}
        onCancel={() => { setShowCameraPrompt(false); cameraPromptCallbackRef.current = null; }}
      />

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
