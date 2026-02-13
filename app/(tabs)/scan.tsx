import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Platform,
  TextInput,
  ScrollView,
  Alert,
  Modal,
  Animated as RNAnimated,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { ActivityEntry, generateId, ToothEntry, ToothType, MATERIAL_PRICES } from "@/lib/data";
import { getApiUrl } from "@/lib/query-client";

type ScanPhase = "camera" | "scanning" | "detected" | "review" | "form";

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h = hours % 12 || 12;
  return `${month} ${day}, ${h}:${mins} ${ampm}`;
}

function getActivityIcon(type: string): { name: string; color: string } {
  switch (type) {
    case "photo":
      return { name: "camera", color: "#8B5CF6" };
    case "scan":
      return { name: "scan", color: Colors.light.tint };
    case "note":
      return { name: "document-text", color: "#F59E0B" };
    case "station_change":
      return { name: "swap-horizontal", color: "#06B6D4" };
    case "created":
      return { name: "add-circle", color: Colors.light.success };
    default:
      return { name: "ellipse", color: Colors.light.textTertiary };
  }
}

interface LabelData {
  caseNumber: string;
  doctorName: string;
  patientName: string;
  caseType: string;
  toothIndices: string;
  shade: string;
  material: string;
  isRush: boolean;
  dueDate: string;
  notes: string;
  price: number;
  createdAt: string;
}

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { addCase, cases, clients, role, adminUnlocked, invoices, updateCase, removeInvoice, attachCaseToInvoice, assignBarcodeToCase, findCaseByBarcode } = useApp();
  const { currentUser } = useAuth();
  const userInitials = currentUser ? currentUser.substring(0, 2).toUpperCase() : "??";
  const showPrice = role === "admin" && adminUnlocked;
  const [labelModalVisible, setLabelModalVisible] = useState(false);
  const [labelData, setLabelData] = useState<LabelData | null>(null);
  const [pendingRemakeCheck, setPendingRemakeCheck] = useState<{caseId: string, patientName: string} | null>(null);
  const [phase, setPhase] = useState<ScanPhase>("camera");
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const scanAnim = useRef(new RNAnimated.Value(0)).current;
  const cameraRef = useRef<CameraView>(null);
  const [cameraReady, setCameraReady] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();

  const [doctorName, setDoctorName] = useState("");
  const [patientName, setPatientName] = useState("");
  const [caseType, setCaseType] = useState("");
  const [caseTypeOpen, setCaseTypeOpen] = useState(false);
  const [toothIndices, setToothIndices] = useState("");
  const [selectedTeeth, setSelectedTeeth] = useState<number[]>([]);
  const [toothTypes, setToothTypes] = useState<Record<number, ToothType>>({});
  const [toothChartOpen, setToothChartOpen] = useState(false);
  const [shade, setShade] = useState("");
  const [material, setMaterial] = useState("Zirconia");
  const [isRush, setIsRush] = useState(false);
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueDateOpen, setDueDateOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());
  const [timeDue, setTimeDue] = useState("");
  const [timeDueOpen, setTimeDueOpen] = useState(false);
  const [timeDueHour, setTimeDueHour] = useState(9);
  const [timeDueMinute, setTimeDueMinute] = useState(0);
  const [timeDuePeriod, setTimeDuePeriod] = useState<"AM" | "PM">("AM");
  const [casePhotos, setCasePhotos] = useState<string[]>([]);
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const [doctorDropdownOpen, setDoctorDropdownOpen] = useState(false);
  const [doctorSearch, setDoctorSearch] = useState("");
  const [patientDropdownOpen, setPatientDropdownOpen] = useState(false);
  const [patientSearch, setPatientSearch] = useState("");
  const [addingNewPatient, setAddingNewPatient] = useState(false);
  const [newPatientInput, setNewPatientInput] = useState("");
  const [addingNewDoctor, setAddingNewDoctor] = useState(false);
  const [newDoctorInput, setNewDoctorInput] = useState("");
  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false);
  const [barcodeScanned, setBarcodeScanned] = useState(false);
  const [barcodeScanForCase, setBarcodeScanForCase] = useState<string | null>(null);
  const [barcodeAttachScanned, setBarcodeAttachScanned] = useState(false);
  const [shadeOpen, setShadeOpen] = useState(false);

  const SHADE_OPTIONS = ["A1", "A2", "A3", "A3.5", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D2", "D3", "D4", "0M1", "0M2", "0M3", "BL1", "BL2", "BL3", "Custom", "Other"];
  const [customShadePhotos, setCustomShadePhotos] = useState<string[]>([]);
  const [customShadeVideos, setCustomShadeVideos] = useState<string[]>([]);

  const filteredClients = clients.filter((c) => {
    const q = doctorSearch.toLowerCase();
    return c.leadDoctor.toLowerCase().includes(q) || c.practiceName.toLowerCase().includes(q);
  });

  const existingPatients = React.useMemo(() => {
    const names = new Set<string>();
    const filtered = cases.filter(c => !doctorName || c.doctorName === doctorName);
    filtered.forEach((c) => {
      if (c.patientName && c.patientName.trim()) names.add(c.patientName.trim());
    });
    return Array.from(names).sort();
  }, [cases, doctorName]);

  const filteredPatients = existingPatients.filter((name) =>
    name && name.toLowerCase().includes((patientSearch || "").toLowerCase())
  );

  function updateToothDisplay(teeth: number[], types: Record<number, ToothType>) {
    const sorted = [...teeth].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      const t = sorted[i];
      const tp = types[t] || "normal";
      if (tp === "missing") {
        parts.push(`X${t}`);
        i++;
      } else if (tp === "bridge") {
        let end = i;
        while (end + 1 < sorted.length && (types[sorted[end + 1]] || "normal") === "bridge") {
          end++;
        }
        if (end > i) {
          parts.push(`#${sorted[i]}-#${sorted[end]}`);
        } else {
          parts.push(`#${t}`);
        }
        i = end + 1;
      } else {
        parts.push(`#${t}`);
        i++;
      }
    }
    setToothIndices(parts.join(", "));
  }

  function handleToothTap(num: number) {
    setSelectedTeeth((prev) => {
      const next = prev.includes(num) ? prev.filter((t) => t !== num) : [...prev, num];
      const sorted = next.sort((a, b) => a - b);
      if (!prev.includes(num)) {
        updateToothDisplay(sorted, toothTypes);
      } else {
        setToothTypes((prevTypes) => {
          const updated = { ...prevTypes };
          delete updated[num];
          updateToothDisplay(sorted, updated);
          return updated;
        });
      }
      return sorted;
    });
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function handleToothLongPress(num: number) {
    if (!selectedTeeth.includes(num)) {
      setSelectedTeeth((prev) => [...prev, num].sort((a, b) => a - b));
    }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      `Tooth #${num}`,
      "Select a designation for this tooth:",
      [
        {
          text: "Pontic",
          onPress: () => {
            setToothTypes((prev) => {
              const updated = { ...prev, [num]: "bridge" as ToothType };
              const teeth = selectedTeeth.includes(num) ? selectedTeeth : [...selectedTeeth, num].sort((a, b) => a - b);
              updateToothDisplay(teeth, updated);
              return updated;
            });
          },
        },
        {
          text: "Missing",
          onPress: () => {
            setToothTypes((prev) => {
              const updated = { ...prev, [num]: "missing" as ToothType };
              const teeth = selectedTeeth.includes(num) ? selectedTeeth : [...selectedTeeth, num].sort((a, b) => a - b);
              updateToothDisplay(teeth, updated);
              return updated;
            });
          },
        },
        {
          text: "Normal",
          onPress: () => {
            setToothTypes((prev) => {
              const updated = { ...prev };
              delete updated[num];
              const teeth = selectedTeeth.includes(num) ? selectedTeeth : [...selectedTeeth, num].sort((a, b) => a - b);
              updateToothDisplay(teeth, updated);
              return updated;
            });
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  }

  const setDueDateOneWeek = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    setDueDate(`${yyyy}-${mm}-${dd}`);
    setCalendarMonth(d.getMonth());
    setCalendarYear(d.getFullYear());
  };

  const selectCalendarDay = (day: number) => {
    const yyyy = calendarYear;
    const mm = String(calendarMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    setDueDate(`${yyyy}-${mm}-${dd}`);
    setDueDateOpen(false);
  };

  const applyTimeDue = () => {
    const hh = String(timeDueHour).padStart(2, "0");
    const min = String(timeDueMinute).padStart(2, "0");
    setTimeDue(`${hh}:${min} ${timeDuePeriod}`);
    setTimeDueOpen(false);
  };

  const calendarDays = React.useMemo(() => {
    const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const blanks = Array.from({ length: firstDay }, (_, i) => ({ key: `b${i}`, day: 0 }));
    const days = Array.from({ length: daysInMonth }, (_, i) => ({ key: `d${i + 1}`, day: i + 1 }));
    return [...blanks, ...days];
  }, [calendarMonth, calendarYear]);

  const calendarMonthLabel = React.useMemo(() => {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${monthNames[calendarMonth]} ${calendarYear}`;
  }, [calendarMonth, calendarYear]);

  const selectedCalendarDay = React.useMemo(() => {
    if (!dueDate) return -1;
    const parts = dueDate.split("-");
    if (parseInt(parts[0]) === calendarYear && parseInt(parts[1]) - 1 === calendarMonth) {
      return parseInt(parts[2]);
    }
    return -1;
  }, [dueDate, calendarMonth, calendarYear]);

  const todayCalendarDay = React.useMemo(() => {
    const now = new Date();
    if (now.getMonth() === calendarMonth && now.getFullYear() === calendarYear) {
      return now.getDate();
    }
    return -1;
  }, [calendarMonth, calendarYear]);

  const dueDateDisplay = React.useMemo(() => {
    if (!dueDate) return "";
    const parts = dueDate.split("-");
    return `${parts[1]}/${parts[2]}/${parts[0]}`;
  }, [dueDate]);

  const billableTeethCount = React.useMemo(() => {
    const normalCount = selectedTeeth.filter((t) => (toothTypes[t] || "normal") === "normal").length;
    const hasPontic = selectedTeeth.some((t) => (toothTypes[t] || "normal") === "bridge");
    return normalCount + (hasPontic ? 1 : 0);
  }, [selectedTeeth, toothTypes]);

  const calculatedPrice = React.useMemo(() => {
    const unitPrice = MATERIAL_PRICES[material] || 250;
    return unitPrice * Math.max(billableTeethCount, 1);
  }, [material, billableTeethCount]);

  useFocusEffect(
    useCallback(() => {
      if (phase !== "form") {
        setPhase("camera");
        setCapturedUri(null);
      }
      return () => {};
    }, [])
  );

  useEffect(() => {
    if (phase === "scanning") {
      RNAnimated.loop(
        RNAnimated.sequence([
          RNAnimated.timing(scanAnim, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
          }),
          RNAnimated.timing(scanAnim, {
            toValue: 0,
            duration: 1500,
            useNativeDriver: true,
          }),
        ]),
      ).start();

      const timer = setTimeout(() => {
        if (capturedUri) {
          setCasePhotos((prev) => {
            if (prev.includes(capturedUri)) return prev;
            return [...prev, capturedUri];
          });
        }
        setPhase("review");
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  async function handleTakePhoto() {
    if (cameraRef.current) {
      try {
        if (!cameraReady) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
        if (photo?.uri) {
          setCapturedUri(photo.uri);
          setPhase("scanning");
          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          return;
        }
      } catch {}
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setCapturedUri(result.assets[0].uri);
      setPhase("scanning");
    }
  }

  async function handleTakeRegularPhoto() {
    let photoUri: string | null = null;

    if (cameraRef.current) {
      try {
        if (!cameraReady) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
        if (photo?.uri) {
          photoUri = photo.uri;
        }
      } catch {
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
          photoUri = result.assets[0].uri;
        }
      }
    } else {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        photoUri = result.assets[0].uri;
      }
    }

    if (photoUri) {
      setCasePhotos((prev) => [...prev, photoUri!]);
      const entry: ActivityEntry = {
        id: generateId(),
        type: "photo",
        timestamp: Date.now(),
        description: "Photo captured",
        imageUri: photoUri,
        user: userInitials,
      };
      setActivityEntries((prev) => [...prev, entry]);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert("Photo Added", `${casePhotos.length + 1} photo(s) attached to this case.`);
    }
  }

  async function handleCustomShadeCapture() {
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.8,
      videoMaxDuration: 30,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const isVideo = asset.type === "video";
      if (isVideo) {
        setCustomShadeVideos(prev => [...prev, asset.uri]);
      } else {
        setCustomShadePhotos(prev => [...prev, asset.uri]);
      }
      setCasePhotos(prev => [...prev, asset.uri]);
      const entry: ActivityEntry = {
        id: generateId(),
        type: "photo",
        timestamp: Date.now(),
        description: `Custom shading ${isVideo ? "video" : "photo"} captured`,
        imageUri: asset.uri,
        user: userInitials,
      };
      setActivityEntries(prev => [...prev, entry]);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Alert.alert(
        "Media Added",
        `Custom shade ${isVideo ? "video" : "photo"} added. Would you like to add more?`,
        [
          { text: "Done", style: "cancel" },
          { text: "Add More", onPress: () => handleCustomShadeCapture() },
        ]
      );
    }
  }

  async function handlePickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Gallery Permission",
        "Gallery access is needed to select prescription images.",
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      setCapturedUri(result.assets[0].uri);
      setPhase("scanning");
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    }
  }

  function handleAddMoreFromReview() {
    setCapturedUri(null);
    setPhase("camera");
    scanAnim.setValue(0);
  }

  async function handleFinishedReview() {
    const entries: ActivityEntry[] = [];
    casePhotos.forEach((uri) => {
      const photoEntry: ActivityEntry = {
        id: generateId(),
        type: "photo",
        timestamp: Date.now(),
        description: "Rx photo captured",
        imageUri: uri,
        user: userInitials,
      };
      entries.push(photoEntry);
    });

    const analyzeUri = casePhotos[0] || capturedUri;
    let aiSuccess = false;
    if (analyzeUri) {
      try {
        let base64Data: string;
        if (Platform.OS === "web") {
          const response = await fetch(analyzeUri);
          const blob = await response.blob();
          const reader = new FileReader();
          base64Data = await new Promise<string>((resolve) => {
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        } else {
          const FileSystem = require("expo-file-system");
          const fileBase64 = await FileSystem.readAsStringAsync(analyzeUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          base64Data = `data:image/jpeg;base64,${fileBase64}`;
        }

        const apiUrl = getApiUrl();
        const aiResponse = await fetch(new URL("/api/analyze-prescription", apiUrl).toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: base64Data }),
        });

        if (aiResponse.ok) {
          const result = await aiResponse.json();
          if (result.success && result.data) {
            const d = result.data;
            if (d.doctorName) setDoctorName(d.doctorName);
            if (d.patientName) setPatientName(d.patientName);
            else if (d.patientInitials) setPatientName(d.patientInitials);
            if (d.caseType) setCaseType(d.caseType);
            if (d.toothIndices) {
              setToothIndices(d.toothIndices);
              const nums = d.toothIndices.match(/\d+/g);
              if (nums) setSelectedTeeth(nums.map(Number).filter((n: number) => n >= 1 && n <= 32).sort((a: number, b: number) => a - b));
            }
            if (d.shade) setShade(d.shade);
            if (d.material) setMaterial(d.material);
            if (d.dueDate) setDueDate(d.dueDate);
            if (d.isRush !== undefined) setIsRush(d.isRush);
            if (d.notes) setNotes(d.notes);
            aiSuccess = true;
          }
        }
      } catch (err) {
        console.log("AI analysis failed, using manual entry:", err);
      }
    }

    const scanEntry: ActivityEntry = {
      id: generateId(),
      type: "scan",
      timestamp: Date.now(),
      description: aiSuccess
        ? "Prescription analyzed via AI - fields auto-populated"
        : "Prescription scanned - manual review needed",
      user: userInitials,
    };
    entries.push(scanEntry);
    setActivityEntries(entries);
    setPhase("form");
  }

  function handleManualEntry() {
    setCapturedUri(null);
    setPhase("scanning");
    setCasePhotos([]);
    setActivityEntries([{
      id: generateId(),
      type: "scan",
      timestamp: Date.now(),
      description: "Manual entry started",
      user: userInitials,
    }]);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }

  function promptAttachBarcode() {
    const latestCase = cases[0];
    if (!latestCase) {
      proceedAfterLabel();
      return;
    }
    Alert.alert("Attach Barcode", "Scan a barcode to attach to this case for tracking.", [
      { text: "Skip", onPress: proceedAfterLabel },
      { text: "Scan Barcode", onPress: () => {
        setLabelModalVisible(false);
        setTimeout(() => {
          setBarcodeAttachScanned(false);
          setBarcodeScanForCase(latestCase.id);
        }, 400);
      }},
    ]);
  }

  function proceedAfterLabel() {
    setLabelModalVisible(false);
    if (pendingRemakeCheck) {
      const { caseId, patientName: pName } = pendingRemakeCheck;
      setPendingRemakeCheck(null);
      startRemakeCheck(caseId, pName);
    } else {
      router.push("/(tabs)/cases");
    }
  }

  function handleBarcodeAttachScanned({ data }: { data: string }) {
    if (barcodeAttachScanned) return;
    setBarcodeAttachScanned(true);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    if (barcodeScanForCase) {
      assignBarcodeToCase(barcodeScanForCase, data);
      setBarcodeScanForCase(null);
      setLabelModalVisible(false);
      setPendingRemakeCheck(null);
      resetForm();
      Alert.alert("Barcode Attached", `Barcode "${data}" has been assigned to this case.`, [
        { text: "OK", onPress: () => router.push("/(tabs)") },
      ]);
    }
  }

  function handleBarcodeScanned({ data }: { data: string }) {
    if (barcodeScanned) return;
    setBarcodeScanned(true);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const foundCase = cases.find(c => c.id === data || c.caseNumber === data);
    if (foundCase) {
      setShowBarcodeScanner(false);
      setBarcodeScanned(false);
      router.push(`/case/${foundCase.id}`);
    } else {
      Alert.alert("Case Not Found", `No case found with ID: ${data}`, [
        { text: "Scan Again", onPress: () => setBarcodeScanned(false) },
        { text: "Close", onPress: () => { setShowBarcodeScanner(false); setBarcodeScanned(false); } },
      ]);
    }
  }

  async function openBarcodeScanner() {
    if (Platform.OS === "web") {
      setShowBarcodeScanner(true);
      return;
    }
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert("Camera Permission", "Camera access is needed to scan barcodes.");
        return;
      }
    }
    setShowBarcodeScanner(true);
    setBarcodeScanned(false);
  }

  async function handleAddMorePhotos() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets.length > 0) {
      const newUris = result.assets.map((a) => a.uri);
      setCasePhotos((prev) => [...prev, ...newUris]);
      const newEntries: ActivityEntry[] = newUris.map((uri) => ({
        id: generateId(),
        type: "photo" as const,
        timestamp: Date.now(),
        description: "Photo added",
        imageUri: uri,
        user: userInitials,
      }));
      setActivityEntries((prev) => [...newEntries, ...prev]);
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  }

  async function handleAddPhotoFromCamera() {
    if (cameraRef.current) {
      try {
        const photo = await cameraRef.current.takePictureAsync();
        if (photo?.uri) {
          setCasePhotos((prev) => [...prev, photo.uri]);
          const entry: ActivityEntry = {
            id: generateId(),
            type: "photo",
            timestamp: Date.now(),
            description: "Photo captured from camera",
            imageUri: photo.uri,
            user: userInitials,
          };
          setActivityEntries((prev) => [entry, ...prev]);
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
        }
      } catch {
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
          const uri = result.assets[0].uri;
          setCasePhotos((prev) => [...prev, uri]);
          const entry: ActivityEntry = {
            id: generateId(),
            type: "photo",
            timestamp: Date.now(),
            description: "Photo captured from camera",
            imageUri: uri,
            user: userInitials,
          };
          setActivityEntries((prev) => [entry, ...prev]);
        }
      }
    }
  }

  function createCase(isDuplicate?: boolean) {
    const currentYear = new Date().getFullYear();
    const yy = String(currentYear).slice(-2);
    const yearCases = cases.filter(c => c.caseNumber.startsWith(`${yy}-`));
    const maxN = yearCases.reduce((max, c) => {
      const parts = c.caseNumber.split("-");
      const n = parseInt(parts[1]) || 0;
      return n > max ? n : max;
    }, 0);
    const nextN = maxN + 1;
    const caseNumber = `${yy}-${nextN}`;

    const toothMapEntries: ToothEntry[] = selectedTeeth.map((num) => ({
      num,
      type: (toothTypes[num] || "normal") as ToothType,
    }));

    const savedPatientName = patientName.trim();

    const newCase = addCase({
      caseNumber,
      doctorName: doctorName.trim(),
      patientName: savedPatientName,
      patientInitials: savedPatientName.split(" ").map((w: string) => w.charAt(0).toUpperCase() + ".").join(""),
      toothIndices: toothIndices.trim(),
      shade: shade.trim(),
      material,
      status: "INTAKE",
      isRush,
      notes: notes.trim(),
      price: calculatedPrice,
      dueDate: timeDue ? `${dueDate} ${timeDue}` : dueDate,
      photos: casePhotos,
      activityLog: activityEntries,
      toothMap: toothMapEntries,
    });

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    const now = new Date();
    const createdStr = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()}`;

    const savedLabel: LabelData = {
      caseNumber,
      doctorName: doctorName.trim(),
      patientName: savedPatientName,
      caseType: caseType || "",
      toothIndices: toothIndices.trim(),
      shade: shade.trim(),
      material,
      isRush,
      dueDate: timeDue ? `${dueDate} ${timeDue}` : dueDate,
      notes: notes.trim(),
      price: calculatedPrice,
      createdAt: createdStr,
    };

    if (isDuplicate) {
      setPendingRemakeCheck({ caseId: newCase.id, patientName: savedPatientName });
    }

    resetForm();
    Alert.alert(
      "Case Added",
      `Case ${caseNumber} has been created and is now in Intake.`,
      [
        { text: "Print Label", onPress: () => { setLabelData(savedLabel); setLabelModalVisible(true); } },
        { text: "Done", onPress: () => {
          if (isDuplicate) {
            startRemakeCheck(newCase.id, savedPatientName);
          } else {
            router.push("/(tabs)");
          }
        }},
      ],
    );
  }

  function startRemakeCheck(caseId: string, pName: string) {
    setPendingRemakeCheck(null);
    Alert.alert("Is this a remake?", "Was this case created to replace a previous case?", [
      { text: "No", onPress: () => router.push("/(tabs)") },
      { text: "Yes", onPress: () => askRemakeReason(caseId, pName) },
    ]);
  }

  function askRemakeReason(caseId: string, pName: string) {
    Alert.alert("Remake Reason", "Select the reason for the remake:", [
      { text: "Doesn't Fit", onPress: () => askRecharge(caseId, pName, "Doesn't Fit") },
      { text: "Open Margins", onPress: () => askRecharge(caseId, pName, "Open Margins") },
      { text: "Open Contacts", onPress: () => askRecharge(caseId, pName, "Open Contacts") },
      { text: "Wrong Shade", onPress: () => askRecharge(caseId, pName, "Wrong Shade") },
      { text: "Other", onPress: () => askRecharge(caseId, pName, "Other") },
    ]);
  }

  function askRecharge(caseId: string, pName: string, reason: string) {
    Alert.alert("Recharge?", "Will this remake be recharged to the client?", [
      { text: "No", onPress: () => handleNoRecharge(caseId, pName, reason) },
      { text: "Yes", onPress: () => router.push(`/chart-history?patient=${encodeURIComponent(pName)}`) },
    ]);
  }

  function handleNoRecharge(caseId: string, pName: string, reason: string) {
    updateCase(caseId, {
      isRemake: true,
      price: 0,
      remakeReason: reason,
      notes: `Remake - ${reason}\n(REMAKE - No Charge)`,
    });
    const existingInvoice = invoices.find(inv =>
      inv.patientName?.toLowerCase() === pName.toLowerCase() &&
      inv.id !== cases.find(c => c.id === caseId)?.invoiceId
    );
    if (existingInvoice) {
      const autoInvoiceId = cases.find(c => c.id === caseId)?.invoiceId;
      if (autoInvoiceId) removeInvoice(autoInvoiceId);
      attachCaseToInvoice(caseId, existingInvoice.id);
    }
    router.push(`/chart-history?patient=${encodeURIComponent(pName)}`);
  }

  function handleSubmit() {
    if (!doctorName.trim()) {
      Alert.alert("Required", "Doctor name is required");
      return;
    }
    if (!patientName.trim()) {
      Alert.alert("Required", "Patient name is required");
      return;
    }

    const matchingCases = cases.filter(
      (c) => (c.patientName || "").toLowerCase() === patientName.trim().toLowerCase()
    );

    if (matchingCases.length > 0) {
      const caseNums = matchingCases.map((c) => c.caseNumber).join(", ");
      Alert.alert(
        "Patient Already on File",
        `"${patientName.trim()}" already has ${matchingCases.length} case${matchingCases.length > 1 ? "s" : ""} (${caseNums}). Add a new case to this patient's file?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "View Chart", onPress: () => router.push(`/chart-history?patient=${encodeURIComponent(patientName.trim())}`) },
          { text: "Add Case", onPress: () => createCase(true) },
        ]
      );
    } else {
      createCase(false);
    }
  }

  function resetForm() {
    setPhase("camera");
    setCapturedUri(null);
    setDoctorName("");
    setPatientName("");
    setPatientDropdownOpen(false);
    setPatientSearch("");
    setAddingNewPatient(false);
    setNewPatientInput("");
    setAddingNewDoctor(false);
    setNewDoctorInput("");
    setCaseType("");
    setCaseTypeOpen(false);
    setToothIndices("");
    setSelectedTeeth([]);
    setToothTypes({});
    setToothChartOpen(false);
    setShade("");
    setCustomShadePhotos([]);
    setCustomShadeVideos([]);
    setMaterial("Zirconia");
    setIsRush(false);
    setNotes("");
    setDueDate("");
    setDueDateOpen(false);
    setCalendarMonth(new Date().getMonth());
    setCalendarYear(new Date().getFullYear());
    setTimeDue("");
    setTimeDueOpen(false);
    setTimeDueHour(9);
    setTimeDueMinute(0);
    setTimeDuePeriod("AM");
    setCasePhotos([]);
    setActivityEntries([]);
    scanAnim.setValue(0);
  }

  const scanTranslateY = scanAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 280],
  });

  if (phase === "form") {
    return (
      <View style={[styles.container, { backgroundColor: Colors.light.background }]}>
        <View
          style={[
            styles.formHeader,
            { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 },
          ]}
        >
          <Pressable onPress={resetForm} style={styles.backBtn}>
            <Ionicons name="close" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={styles.formTitle}>New Case</Text>
          <Pressable
            onPress={handleSubmit}
            style={({ pressed }) => [
              styles.submitBtn,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Ionicons name="checkmark" size={22} color="#FFF" />
          </Pressable>
        </View>
        <ScrollView
          style={styles.formScroll}
          contentContainerStyle={{
            paddingBottom: Platform.OS === "web" ? 84 + 40 : 120,
          }}
          showsVerticalScrollIndicator={false}
        >
          {casePhotos.length > 0 ? (
            <View style={styles.photoStripSection}>
              <View style={styles.photoStripHeader}>
                <Text style={styles.formLabel}>Photos ({casePhotos.length})</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
                {casePhotos.map((uri, idx) => (
                  <View key={idx} style={styles.photoThumbWrap}>
                    <Image source={{ uri }} style={styles.photoThumb} contentFit="cover" />
                    <Pressable
                      onPress={() => {
                        setCasePhotos((prev) => prev.filter((_, i) => i !== idx));
                        setActivityEntries((prev) => prev.filter((e) => e.imageUri !== uri));
                      }}
                      style={styles.photoRemoveBtn}
                    >
                      <Ionicons name="close-circle" size={20} color="#EF4444" />
                    </Pressable>
                  </View>
                ))}
                <Pressable onPress={handleAddMorePhotos} style={styles.addPhotoThumb}>
                  <Ionicons name="add" size={28} color={Colors.light.tint} />
                </Pressable>
              </ScrollView>
            </View>
          ) : (
            <View style={styles.detectedBanner}>
              <Ionicons
                name="checkmark-circle"
                size={20}
                color={Colors.light.success}
              />
              <Text style={styles.detectedText}>Rx Document Detected</Text>
            </View>
          )}

          <View style={styles.addPhotoBtnRow}>
            <Pressable
              onPress={handleAddMorePhotos}
              style={({ pressed }) => [styles.addMorePhotosBtn, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="images-outline" size={18} color={Colors.light.tint} />
              <Text style={styles.addMorePhotosBtnText}>Add Pictures</Text>
            </Pressable>
            <Pressable
              onPress={handleAddPhotoFromCamera}
              style={({ pressed }) => [styles.addMorePhotosBtn, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="camera-outline" size={18} color={Colors.light.tint} />
              <Text style={styles.addMorePhotosBtnText}>Take Photo</Text>
            </Pressable>
          </View>

          <View style={[styles.formGroup, { zIndex: 10 }]}>
            <Text style={styles.formLabel}>Doctor Name</Text>
            <Pressable
              onPress={() => {
                setDoctorDropdownOpen(!doctorDropdownOpen);
                setDoctorSearch("");
              }}
              style={[styles.formInput, styles.dropdownTrigger]}
            >
              <Text style={[styles.dropdownTriggerText, !doctorName && { color: Colors.light.textTertiary }]}>
                {doctorName || "Select Doctor"}
              </Text>
              <Ionicons
                name={doctorDropdownOpen ? "chevron-up" : "chevron-down"}
                size={18}
                color={Colors.light.textSecondary}
              />
            </Pressable>
            {doctorDropdownOpen && (
              <View style={styles.dropdownPanel}>
                {!addingNewDoctor ? (
                  <>
                    <View style={styles.dropdownSearchWrap}>
                      <Ionicons name="search" size={16} color={Colors.light.textTertiary} />
                      <TextInput
                        style={styles.dropdownSearchInput}
                        value={doctorSearch}
                        onChangeText={setDoctorSearch}
                        placeholder="Search by name..."
                        placeholderTextColor={Colors.light.textTertiary}
                        autoFocus
                      />
                      {doctorSearch.length > 0 && (
                        <Pressable onPress={() => setDoctorSearch("")}>
                          <Ionicons name="close-circle" size={16} color={Colors.light.textTertiary} />
                        </Pressable>
                      )}
                    </View>
                    <Pressable
                      onPress={() => {
                        setAddingNewDoctor(true);
                        setNewDoctorInput("");
                        if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      style={({ pressed }) => [styles.addNewPatientBtn, pressed && { opacity: 0.7 }]}
                    >
                      <Ionicons name="person-add-outline" size={18} color={Colors.light.tint} />
                      <Text style={styles.addNewPatientBtnText}>Add New Doctor</Text>
                    </Pressable>
                    <ScrollView style={styles.dropdownList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {filteredClients.length === 0 ? (
                        <Text style={styles.dropdownEmpty}>No matching clients</Text>
                      ) : (
                        filteredClients.map((c) => (
                          <Pressable
                            key={c.id}
                            onPress={() => {
                              setDoctorName(c.leadDoctor);
                              setDoctorDropdownOpen(false);
                              setDoctorSearch("");
                              if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            }}
                            style={({ pressed }) => [
                              styles.dropdownItem,
                              doctorName === c.leadDoctor && styles.dropdownItemSelected,
                              pressed && { opacity: 0.7 },
                            ]}
                          >
                            <View style={styles.dropdownItemLeft}>
                              <View style={[styles.dropdownAvatar, doctorName === c.leadDoctor && { backgroundColor: Colors.light.tint }]}>
                                <Text style={[styles.dropdownAvatarText, doctorName === c.leadDoctor && { color: "#FFF" }]}>
                                  {c.leadDoctor.replace("Dr. ", "").charAt(0)}
                                </Text>
                              </View>
                              <View>
                                <Text style={[styles.dropdownItemName, doctorName === c.leadDoctor && { color: Colors.light.tint }]}>
                                  {c.leadDoctor}
                                </Text>
                                <Text style={styles.dropdownItemSub}>{c.practiceName}</Text>
                              </View>
                            </View>
                            {doctorName === c.leadDoctor && (
                              <Ionicons name="checkmark-circle" size={20} color={Colors.light.tint} />
                            )}
                          </Pressable>
                        ))
                      )}
                    </ScrollView>
                  </>
                ) : (
                  <View style={styles.addNewPatientPanel}>
                    <Text style={styles.addNewPatientTitle}>New Doctor</Text>
                    <View style={styles.dropdownSearchWrap}>
                      <Ionicons name="person-outline" size={16} color={Colors.light.textTertiary} />
                      <TextInput
                        style={styles.dropdownSearchInput}
                        value={newDoctorInput}
                        onChangeText={setNewDoctorInput}
                        placeholder="Enter doctor name..."
                        placeholderTextColor={Colors.light.textTertiary}
                        autoFocus
                      />
                    </View>
                    <View style={styles.addNewPatientActions}>
                      <Pressable
                        onPress={() => { setAddingNewDoctor(false); setNewDoctorInput(""); }}
                        style={({ pressed }) => [styles.addNewPatientCancelBtn, pressed && { opacity: 0.7 }]}
                      >
                        <Text style={styles.addNewPatientCancelText}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          if (!newDoctorInput.trim()) return;
                          setDoctorName(newDoctorInput.trim());
                          setDoctorDropdownOpen(false);
                          setAddingNewDoctor(false);
                          setNewDoctorInput("");
                          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        }}
                        style={({ pressed }) => [styles.addNewPatientConfirmBtn, pressed && { opacity: 0.8 }]}
                      >
                        <Text style={styles.addNewPatientConfirmText}>Add</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            )}
          </View>

          <View style={[styles.formGroup, { zIndex: 9 }]}>
            <Text style={styles.formLabel}>Patient Name</Text>
            <Pressable
              onPress={() => {
                setPatientDropdownOpen(!patientDropdownOpen);
                setPatientSearch("");
                setAddingNewPatient(false);
                setNewPatientInput("");
              }}
              style={[styles.formInput, styles.dropdownTrigger]}
            >
              <Text style={[styles.dropdownTriggerText, !patientName && { color: Colors.light.textTertiary }]}>
                {patientName || "Select Patient"}
              </Text>
              <Ionicons
                name={patientDropdownOpen ? "chevron-up" : "chevron-down"}
                size={18}
                color={Colors.light.textSecondary}
              />
            </Pressable>
            {patientDropdownOpen && (
              <View style={styles.dropdownPanel}>
                {!addingNewPatient ? (
                  <>
                    <View style={styles.dropdownSearchWrap}>
                      <Ionicons name="search" size={16} color={Colors.light.textTertiary} />
                      <TextInput
                        style={styles.dropdownSearchInput}
                        value={patientSearch}
                        onChangeText={setPatientSearch}
                        placeholder="Search patients..."
                        placeholderTextColor={Colors.light.textTertiary}
                        autoFocus
                      />
                      {patientSearch.length > 0 && (
                        <Pressable onPress={() => setPatientSearch("")}>
                          <Ionicons name="close-circle" size={16} color={Colors.light.textTertiary} />
                        </Pressable>
                      )}
                    </View>
                    <Pressable
                      onPress={() => {
                        setAddingNewPatient(true);
                        setNewPatientInput("");
                        if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      style={({ pressed }) => [styles.addNewPatientBtn, pressed && { opacity: 0.7 }]}
                    >
                      <Ionicons name="person-add-outline" size={18} color={Colors.light.tint} />
                      <Text style={styles.addNewPatientBtnText}>Add New Patient</Text>
                    </Pressable>
                    <ScrollView style={styles.dropdownList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {filteredPatients.length === 0 ? (
                        <Text style={styles.dropdownEmpty}>No matching patients</Text>
                      ) : (
                        filteredPatients.map((name) => {
                          const patientCases = cases.filter(
                            (c) => (c.patientName || "").toLowerCase() === (name || "").toLowerCase()
                          );
                          return (
                            <Pressable
                              key={name}
                              onPress={() => {
                                setPatientName(name);
                                setPatientDropdownOpen(false);
                                setPatientSearch("");
                                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                              }}
                              style={({ pressed }) => [
                                styles.dropdownItem,
                                patientName === name && styles.dropdownItemSelected,
                                pressed && { opacity: 0.7 },
                              ]}
                            >
                              <View style={styles.dropdownItemLeft}>
                                <View style={[styles.dropdownAvatar, patientName === name && { backgroundColor: Colors.light.tint }]}>
                                  <Text style={[styles.dropdownAvatarText, patientName === name && { color: "#FFF" }]}>
                                    {name.charAt(0).toUpperCase()}
                                  </Text>
                                </View>
                                <View>
                                  <Text style={[styles.dropdownItemName, patientName === name && { color: Colors.light.tint }]}>
                                    {name}
                                  </Text>
                                  <Text style={styles.dropdownItemSub}>
                                    {patientCases.length} case{patientCases.length !== 1 ? "s" : ""} on file
                                  </Text>
                                </View>
                              </View>
                              {patientName === name && (
                                <Ionicons name="checkmark-circle" size={20} color={Colors.light.tint} />
                              )}
                            </Pressable>
                          );
                        })
                      )}
                    </ScrollView>
                  </>
                ) : (
                  <View style={styles.addNewPatientPanel}>
                    <Text style={styles.addNewPatientTitle}>New Patient</Text>
                    <View style={styles.dropdownSearchWrap}>
                      <Ionicons name="person-outline" size={16} color={Colors.light.textTertiary} />
                      <TextInput
                        style={styles.dropdownSearchInput}
                        value={newPatientInput}
                        onChangeText={setNewPatientInput}
                        placeholder="Enter full name..."
                        placeholderTextColor={Colors.light.textTertiary}
                        autoFocus
                      />
                    </View>
                    <View style={styles.addNewPatientActions}>
                      <Pressable
                        onPress={() => { setAddingNewPatient(false); setNewPatientInput(""); }}
                        style={({ pressed }) => [styles.addNewPatientCancelBtn, pressed && { opacity: 0.7 }]}
                      >
                        <Text style={styles.addNewPatientCancelText}>Back</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          if (!newPatientInput.trim()) return;
                          setPatientName(newPatientInput.trim());
                          setPatientDropdownOpen(false);
                          setAddingNewPatient(false);
                          setNewPatientInput("");
                          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        }}
                        style={({ pressed }) => [styles.addNewPatientConfirmBtn, pressed && { opacity: 0.8 }]}
                      >
                        <Ionicons name="checkmark" size={18} color="#FFF" />
                        <Text style={styles.addNewPatientConfirmText}>Add</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            )}
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Case Type</Text>
            <Pressable
              onPress={() => setCaseTypeOpen(!caseTypeOpen)}
              style={[styles.formInput, styles.dropdownTrigger]}
            >
              <Text style={[styles.dropdownTriggerText, !caseType && { color: Colors.light.textTertiary }]}>
                {caseType || "Select case type"}
              </Text>
              <Ionicons
                name={caseTypeOpen ? "chevron-up" : "chevron-down"}
                size={18}
                color={Colors.light.textSecondary}
              />
            </Pressable>
            {caseTypeOpen && (
              <View style={styles.caseTypeDropdown}>
                {["Restorative", "Removable", "Appliance", "Temporary"].map((type) => (
                  <Pressable
                    key={type}
                    onPress={() => {
                      setCaseType(type);
                      setCaseTypeOpen(false);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={({ pressed }) => [
                      styles.caseTypeItem,
                      caseType === type && styles.caseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text style={[styles.caseTypeItemText, caseType === type && styles.caseTypeItemTextSelected]}>
                      {type}
                    </Text>
                    {caseType === type && (
                      <Ionicons name="checkmark-circle" size={18} color={Colors.light.tint} />
                    )}
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          <View style={styles.dueDateRow}>
            <View style={styles.dueDateCol}>
              <Text style={styles.formLabel}>Due Date</Text>
              <Pressable
                onPress={() => { setDueDateOpen(!dueDateOpen); setTimeDueOpen(false); }}
                style={[styles.formInput, styles.dropdownTrigger]}
              >
                <Text style={[styles.dropdownTriggerText, !dueDate && { color: Colors.light.textTertiary }]}>
                  {dueDateDisplay || "Select date"}
                </Text>
                <Ionicons
                  name={dueDateOpen ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={Colors.light.textSecondary}
                />
              </Pressable>
              {dueDateOpen && (
                <View style={styles.dueDateDropdown}>
                  <Pressable style={styles.quickDateBtn} onPress={() => { setDueDateOneWeek(); }}>
                    <Ionicons name="time-outline" size={16} color={Colors.light.tint} />
                    <Text style={styles.quickDateText}>1 Week</Text>
                    <Text style={styles.quickDateSub}>
                      {(() => {
                        const d = new Date(); d.setDate(d.getDate() + 7);
                        const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                        return `${mn[d.getMonth()]} ${d.getDate()}`;
                      })()}
                    </Text>
                  </Pressable>
                  <View style={styles.calendarContainer}>
                    <View style={styles.calendarHeader}>
                      <Pressable onPress={() => {
                        if (calendarMonth === 0) { setCalendarMonth(11); setCalendarYear(calendarYear - 1); }
                        else setCalendarMonth(calendarMonth - 1);
                      }}>
                        <Ionicons name="chevron-back" size={20} color={Colors.light.tint} />
                      </Pressable>
                      <Text style={styles.calendarMonthText}>{calendarMonthLabel}</Text>
                      <Pressable onPress={() => {
                        if (calendarMonth === 11) { setCalendarMonth(0); setCalendarYear(calendarYear + 1); }
                        else setCalendarMonth(calendarMonth + 1);
                      }}>
                        <Ionicons name="chevron-forward" size={20} color={Colors.light.tint} />
                      </Pressable>
                    </View>
                    <View style={styles.calendarWeekRow}>
                      {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => (
                        <Text key={d} style={styles.calendarWeekDay}>{d}</Text>
                      ))}
                    </View>
                    <View style={styles.calendarGrid}>
                      {calendarDays.map((item) => (
                        <Pressable
                          key={item.key}
                          style={[
                            styles.calendarDayBtn,
                            item.day === selectedCalendarDay && styles.calendarDaySelected,
                            item.day === todayCalendarDay && item.day !== selectedCalendarDay && styles.calendarDayToday,
                          ]}
                          onPress={() => item.day > 0 && selectCalendarDay(item.day)}
                          disabled={item.day === 0}
                        >
                          {item.day > 0 && (
                            <Text style={[
                              styles.calendarDayText,
                              item.day === selectedCalendarDay && styles.calendarDayTextSelected,
                              item.day === todayCalendarDay && item.day !== selectedCalendarDay && styles.calendarDayTextToday,
                            ]}>
                              {item.day}
                            </Text>
                          )}
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </View>
              )}
            </View>

            <View style={styles.timeDueCol}>
              <Text style={styles.formLabel}>Time Due <Text style={styles.optionalLabel}>(optional)</Text></Text>
              <Pressable
                onPress={() => { setTimeDueOpen(!timeDueOpen); setDueDateOpen(false); }}
                style={[styles.formInput, styles.dropdownTrigger]}
              >
                <Text style={[styles.dropdownTriggerText, !timeDue && { color: Colors.light.textTertiary }]}>
                  {timeDue || "Time"}
                </Text>
                <Ionicons
                  name={timeDueOpen ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={Colors.light.textSecondary}
                />
              </Pressable>
              {timeDueOpen && (
                <View style={styles.timeDueDropdown}>
                  <View style={styles.timePickerRow}>
                    <View style={styles.timePickerCol}>
                      <Text style={styles.timePickerLabel}>Hour</Text>
                      <View style={styles.timeSpinnerRow}>
                        <Pressable onPress={() => setTimeDueHour(timeDueHour <= 1 ? 12 : timeDueHour - 1)} style={styles.timeSpinBtn}>
                          <Ionicons name="chevron-up" size={18} color={Colors.light.tint} />
                        </Pressable>
                        <Text style={styles.timeSpinValue}>{String(timeDueHour).padStart(2, "0")}</Text>
                        <Pressable onPress={() => setTimeDueHour(timeDueHour >= 12 ? 1 : timeDueHour + 1)} style={styles.timeSpinBtn}>
                          <Ionicons name="chevron-down" size={18} color={Colors.light.tint} />
                        </Pressable>
                      </View>
                    </View>
                    <Text style={styles.timeColon}>:</Text>
                    <View style={styles.timePickerCol}>
                      <Text style={styles.timePickerLabel}>Min</Text>
                      <View style={styles.timeSpinnerRow}>
                        <Pressable onPress={() => setTimeDueMinute(timeDueMinute <= 0 ? 55 : timeDueMinute - 5)} style={styles.timeSpinBtn}>
                          <Ionicons name="chevron-up" size={18} color={Colors.light.tint} />
                        </Pressable>
                        <Text style={styles.timeSpinValue}>{String(timeDueMinute).padStart(2, "0")}</Text>
                        <Pressable onPress={() => setTimeDueMinute(timeDueMinute >= 55 ? 0 : timeDueMinute + 5)} style={styles.timeSpinBtn}>
                          <Ionicons name="chevron-down" size={18} color={Colors.light.tint} />
                        </Pressable>
                      </View>
                    </View>
                    <View style={styles.timePickerCol}>
                      <Text style={styles.timePickerLabel}>Period</Text>
                      <View style={styles.amPmToggle}>
                        <Pressable
                          style={[styles.amPmBtn, timeDuePeriod === "AM" && styles.amPmBtnActive]}
                          onPress={() => setTimeDuePeriod("AM")}
                        >
                          <Text style={[styles.amPmText, timeDuePeriod === "AM" && styles.amPmTextActive]}>AM</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.amPmBtn, timeDuePeriod === "PM" && styles.amPmBtnActive]}
                          onPress={() => setTimeDuePeriod("PM")}
                        >
                          <Text style={[styles.amPmText, timeDuePeriod === "PM" && styles.amPmTextActive]}>PM</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                  <Pressable style={styles.timeApplyBtn} onPress={applyTimeDue}>
                    <Text style={styles.timeApplyText}>Set Time</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Tooth Indicator</Text>
            <Pressable
              onPress={() => setToothChartOpen(!toothChartOpen)}
              style={[styles.formInput, styles.dropdownTrigger]}
            >
              <Text style={[styles.dropdownTriggerText, selectedTeeth.length === 0 && { color: Colors.light.textTertiary }]}>
                {selectedTeeth.length > 0 ? toothIndices || "Select teeth" : "Select teeth"}
              </Text>
              <Ionicons
                name={toothChartOpen ? "chevron-up" : "chevron-down"}
                size={18}
                color={Colors.light.textSecondary}
              />
            </Pressable>
            {toothChartOpen && (
              <View style={styles.toothChartPanel}>
                <View style={styles.toothChartHeader}>
                  <Text style={styles.toothChartTitle}>American Dental Numbering</Text>
                  {selectedTeeth.length > 0 && (
                    <Pressable
                      onPress={() => {
                        setSelectedTeeth([]);
                        setToothTypes({});
                        setToothIndices("");
                      }}
                      style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                      <Text style={styles.toothChartClear}>Clear</Text>
                    </Pressable>
                  )}
                </View>

                <View style={styles.toothChartLegend}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: Colors.light.tint }]} />
                    <Text style={styles.legendText}>Normal</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: Colors.light.accent }]} />
                    <Text style={styles.legendText}>Pontic</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: Colors.light.error }]} />
                    <Text style={styles.legendText}>Missing</Text>
                  </View>
                  <Text style={styles.legendHint}>Hold to set type</Text>
                </View>

                <View style={styles.adaChartContainer}>
                  <View style={styles.adaQuadrantLabels}>
                    <Text style={styles.adaQuadrantLabel}>Upper Right</Text>
                    <Text style={styles.adaQuadrantLabel}>Upper Left</Text>
                  </View>
                  <View style={styles.adaRow}>
                    {[1,2,3,4,5,6,7,8].map((num) => {
                      const isSelected = selectedTeeth.includes(num);
                      const tType = toothTypes[num] || "normal";
                      return (
                        <Pressable
                          key={num}
                          onPress={() => handleToothTap(num)}
                          onLongPress={() => handleToothLongPress(num)}
                          delayLongPress={400}
                          style={[
                            styles.adaToothBtn,
                            num === 8 && styles.adaToothBtnMidline,
                            isSelected && tType === "normal" && styles.toothBtnSelected,
                            isSelected && tType === "bridge" && styles.toothBtnBridge,
                            isSelected && tType === "missing" && styles.toothBtnMissing,
                          ]}
                        >
                          {isSelected && tType === "missing" ? (
                            <View style={styles.toothMissingWrap}>
                              <Text style={[styles.adaToothText, styles.toothBtnTextMissing]}>{num}</Text>
                              <View style={styles.toothXOverlay}>
                                <Ionicons name="close" size={14} color={Colors.light.error} />
                              </View>
                            </View>
                          ) : (
                            <Text style={[
                              styles.adaToothText,
                              isSelected && tType === "normal" && styles.toothBtnTextSelected,
                              isSelected && tType === "bridge" && styles.toothBtnTextBridge,
                            ]}>{num}</Text>
                          )}
                        </Pressable>
                      );
                    })}
                    <View style={styles.adaMidline} />
                    {[9,10,11,12,13,14,15,16].map((num) => {
                      const isSelected = selectedTeeth.includes(num);
                      const tType = toothTypes[num] || "normal";
                      return (
                        <Pressable
                          key={num}
                          onPress={() => handleToothTap(num)}
                          onLongPress={() => handleToothLongPress(num)}
                          delayLongPress={400}
                          style={[
                            styles.adaToothBtn,
                            isSelected && tType === "normal" && styles.toothBtnSelected,
                            isSelected && tType === "bridge" && styles.toothBtnBridge,
                            isSelected && tType === "missing" && styles.toothBtnMissing,
                          ]}
                        >
                          {isSelected && tType === "missing" ? (
                            <View style={styles.toothMissingWrap}>
                              <Text style={[styles.adaToothText, styles.toothBtnTextMissing]}>{num}</Text>
                              <View style={styles.toothXOverlay}>
                                <Ionicons name="close" size={14} color={Colors.light.error} />
                              </View>
                            </View>
                          ) : (
                            <Text style={[
                              styles.adaToothText,
                              isSelected && tType === "normal" && styles.toothBtnTextSelected,
                              isSelected && tType === "bridge" && styles.toothBtnTextBridge,
                            ]}>{num}</Text>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>

                  <View style={styles.adaDividerRow}>
                    <View style={styles.adaDividerLine} />
                  </View>

                  <View style={styles.adaRow}>
                    {[32,31,30,29,28,27,26,25].map((num) => {
                      const isSelected = selectedTeeth.includes(num);
                      const tType = toothTypes[num] || "normal";
                      return (
                        <Pressable
                          key={num}
                          onPress={() => handleToothTap(num)}
                          onLongPress={() => handleToothLongPress(num)}
                          delayLongPress={400}
                          style={[
                            styles.adaToothBtn,
                            num === 25 && styles.adaToothBtnMidline,
                            isSelected && tType === "normal" && styles.toothBtnSelected,
                            isSelected && tType === "bridge" && styles.toothBtnBridge,
                            isSelected && tType === "missing" && styles.toothBtnMissing,
                          ]}
                        >
                          {isSelected && tType === "missing" ? (
                            <View style={styles.toothMissingWrap}>
                              <Text style={[styles.adaToothText, styles.toothBtnTextMissing]}>{num}</Text>
                              <View style={styles.toothXOverlay}>
                                <Ionicons name="close" size={14} color={Colors.light.error} />
                              </View>
                            </View>
                          ) : (
                            <Text style={[
                              styles.adaToothText,
                              isSelected && tType === "normal" && styles.toothBtnTextSelected,
                              isSelected && tType === "bridge" && styles.toothBtnTextBridge,
                            ]}>{num}</Text>
                          )}
                        </Pressable>
                      );
                    })}
                    <View style={styles.adaMidline} />
                    {[24,23,22,21,20,19,18,17].map((num) => {
                      const isSelected = selectedTeeth.includes(num);
                      const tType = toothTypes[num] || "normal";
                      return (
                        <Pressable
                          key={num}
                          onPress={() => handleToothTap(num)}
                          onLongPress={() => handleToothLongPress(num)}
                          delayLongPress={400}
                          style={[
                            styles.adaToothBtn,
                            isSelected && tType === "normal" && styles.toothBtnSelected,
                            isSelected && tType === "bridge" && styles.toothBtnBridge,
                            isSelected && tType === "missing" && styles.toothBtnMissing,
                          ]}
                        >
                          {isSelected && tType === "missing" ? (
                            <View style={styles.toothMissingWrap}>
                              <Text style={[styles.adaToothText, styles.toothBtnTextMissing]}>{num}</Text>
                              <View style={styles.toothXOverlay}>
                                <Ionicons name="close" size={14} color={Colors.light.error} />
                              </View>
                            </View>
                          ) : (
                            <Text style={[
                              styles.adaToothText,
                              isSelected && tType === "normal" && styles.toothBtnTextSelected,
                              isSelected && tType === "bridge" && styles.toothBtnTextBridge,
                            ]}>{num}</Text>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>

                  <View style={styles.adaQuadrantLabels}>
                    <Text style={styles.adaQuadrantLabel}>Lower Right</Text>
                    <Text style={styles.adaQuadrantLabel}>Lower Left</Text>
                  </View>
                </View>

                {selectedTeeth.length > 0 && (
                  <View style={styles.toothChartSummary}>
                    <View style={styles.toothSummaryRow}>
                      <Ionicons name="checkmark-circle" size={16} color={Colors.light.tint} />
                      <Text style={styles.toothChartSummaryText}>
                        {toothIndices}
                      </Text>
                    </View>
                    {showPrice && (
                      <View style={styles.toothPricingRow}>
                        <Text style={styles.toothPricingLabel}>
                          {billableTeethCount} billable {billableTeethCount === 1 ? "tooth" : "teeth"} × ${MATERIAL_PRICES[material] || 250}/{material}
                        </Text>
                        <Text style={styles.toothPricingTotal}>${calculatedPrice.toLocaleString()}</Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )}
          </View>

          <View style={[styles.formRow, { zIndex: 5 }]}>
            <View style={[styles.formGroup, { flex: 1, zIndex: 5 }]}>
              <Text style={styles.formLabel}>Shade</Text>
              <Pressable
                onPress={() => setShadeOpen(!shadeOpen)}
                style={[styles.formInput, styles.dropdownTrigger]}
              >
                <Text style={[styles.dropdownTriggerText, !shade && { color: Colors.light.textTertiary }]}>
                  {shade || "Select Shade"}
                </Text>
                <Ionicons
                  name={shadeOpen ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={Colors.light.textSecondary}
                />
              </Pressable>
              {shadeOpen && (
                <View style={[styles.dropdownPanel, { maxHeight: 200 }]}>
                  <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {SHADE_OPTIONS.map((s) => (
                      <Pressable
                        key={s}
                        onPress={() => {
                          setShade(s);
                          setShadeOpen(false);
                          if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          if (s === "Custom") {
                            setTimeout(() => {
                              Alert.alert(
                                "Custom Shade",
                                "Would you like to take photos and videos now for custom shading?",
                                [
                                  { text: "No", style: "cancel" },
                                  { text: "Yes", onPress: () => handleCustomShadeCapture() },
                                ]
                              );
                            }, 300);
                          }
                        }}
                        style={({ pressed }) => [
                          styles.dropdownItem,
                          shade === s && styles.dropdownItemSelected,
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <Text style={[styles.dropdownItemName, shade === s && { color: Colors.light.tint }]}>
                          {s}
                        </Text>
                        {shade === s && (
                          <Ionicons name="checkmark-circle" size={20} color={Colors.light.tint} />
                        )}
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Material</Text>
              <View style={styles.materialSelector}>
                {["Zirconia", "E.max", "PFM", "Gold"].map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setMaterial(m)}
                    style={[
                      styles.materialChip,
                      material === m && styles.materialChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.materialText,
                        material === m && styles.materialTextActive,
                      ]}
                    >
                      {m}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>

          <Pressable
            onPress={() => setIsRush(!isRush)}
            style={[styles.rushToggle, isRush && styles.rushToggleActive]}
          >
            <Ionicons
              name="flash"
              size={18}
              color={isRush ? "#EF4444" : Colors.light.textTertiary}
            />
            <Text
              style={[styles.rushToggleText, isRush && { color: "#EF4444" }]}
            >
              Rush Order
            </Text>
            <View style={styles.rushToggleSwitch}>
              <View
                style={[
                  styles.rushToggleDot,
                  isRush && styles.rushToggleDotActive,
                ]}
              />
            </View>
          </Pressable>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Notes</Text>
            <TextInput
              style={[styles.formInput, styles.formTextArea]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Additional instructions..."
              placeholderTextColor={Colors.light.textTertiary}
              multiline
              numberOfLines={3}
            />
          </View>

          {activityEntries.length > 0 && (
            <View style={styles.activitySection}>
              <View style={styles.activityHeader}>
                <Ionicons name="time-outline" size={16} color={Colors.light.textSecondary} />
                <Text style={styles.activityHeaderText}>Activity Log</Text>
                <View style={styles.activityBadge}>
                  <Text style={styles.activityBadgeText}>{activityEntries.length}</Text>
                </View>
              </View>
              {[...activityEntries].sort((a, b) => b.timestamp - a.timestamp).map((entry) => {
                const icon = getActivityIcon(entry.type);
                return (
                  <View key={entry.id} style={styles.activityRow}>
                    <View style={[styles.activityIconWrap, { backgroundColor: icon.color + "18" }]}>
                      <Ionicons name={icon.name as any} size={16} color={icon.color} />
                    </View>
                    <View style={styles.activityContent}>
                      <Text style={styles.activityDesc}>{entry.description}</Text>
                      <Text style={styles.activityTime}>{formatTimestamp(entry.timestamp)}</Text>
                    </View>
                    {entry.imageUri && (
                      <Image source={{ uri: entry.imageUri }} style={styles.activityThumb} contentFit="cover" />
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  if (!permission) {
    return (
      <View style={[styles.container, styles.permissionContainer]}>
        <Text style={styles.permissionText}>Loading camera...</Text>
      </View>
    );
  }

  if (!permission.granted && phase === "camera") {
    return (
      <View style={[styles.container, styles.permissionContainer]}>
        <View style={styles.permissionContent}>
          <View style={styles.permissionIconWrap}>
            <Ionicons name="camera" size={48} color={Colors.light.tint} />
          </View>
          <Text style={styles.permissionTitle}>Camera Access Required</Text>
          <Text style={styles.permissionDesc}>
            To scan prescriptions, the app needs access to your camera.
          </Text>
          <Pressable
            onPress={requestPermission}
            style={({ pressed }) => [styles.permissionBtn, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="camera" size={20} color="#FFF" />
            <Text style={styles.permissionBtnText}>Enable Camera</Text>
          </Pressable>
          <Pressable
            onPress={openBarcodeScanner}
            style={({ pressed }) => [
              {
                flexDirection: "row" as const,
                alignItems: "center" as const,
                gap: 8,
                marginTop: 16,
                paddingVertical: 14,
                paddingHorizontal: 24,
                borderRadius: 14,
                backgroundColor: Colors.light.surfaceSecondary,
                borderWidth: 1,
                borderColor: Colors.light.border,
              },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="barcode-outline" size={20} color={Colors.light.tint} />
            <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.light.tint }}>Scan Barcode</Text>
          </Pressable>
          <Pressable
            onPress={handleManualEntry}
            style={({ pressed }) => [styles.permissionSkipBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.permissionSkipText}>Enter manually instead</Text>
          </Pressable>
        </View>

        <Modal visible={showBarcodeScanner} animationType="slide" onRequestClose={() => setShowBarcodeScanner(false)}>
          <View style={{ flex: 1, backgroundColor: "#000" }}>
            <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 10, paddingHorizontal: 20, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Scan Barcode</Text>
              <Pressable onPress={() => setShowBarcodeScanner(false)}>
                <Ionicons name="close" size={28} color="#FFF" />
              </Pressable>
            </View>
            {Platform.OS !== "web" ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a"] }}
                onBarcodeScanned={barcodeScanned ? undefined : handleBarcodeScanned}
              />
            ) : (
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
                <Ionicons name="barcode-outline" size={64} color="#666" />
                <Text style={{ color: "#999", marginTop: 16, fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center" }}>Barcode scanning requires a device camera</Text>
                <Text style={{ color: "#999", marginTop: 8, fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" }}>Enter a barcode manually:</Text>
                <TextInput
                  style={{ borderWidth: 1, borderColor: "#555", borderRadius: 10, color: "#FFF", padding: 12, width: "80%", marginTop: 12, fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center" }}
                  placeholder="Enter barcode..."
                  placeholderTextColor="#666"
                  onSubmitEditing={(e) => {
                    const val = e.nativeEvent.text.trim();
                    if (val) handleBarcodeScanned({ data: val });
                  }}
                  autoFocus
                />
              </View>
            )}
            <View style={{ padding: 20, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 10, alignItems: "center" }}>
              <Text style={{ color: "#999", fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" }}>Point the camera at a barcode or QR code on the case label</Text>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.cameraContainer}>
        {phase === "camera" && (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            onCameraReady={() => setCameraReady(true)}
          />
        )}

        {phase === "scanning" && capturedUri && (
          <>
            <Image
              source={{ uri: capturedUri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
            />
            <View style={styles.scanOverlay} />
            <RNAnimated.View
              style={[
                styles.scanLine,
                { transform: [{ translateY: scanTranslateY }] },
              ]}
            />
          </>
        )}

        {phase === "scanning" && !capturedUri && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(15,23,42,0.95)", justifyContent: "center", alignItems: "center" }]}>
            <RNAnimated.View
              style={[
                styles.scanLine,
                { transform: [{ translateY: scanTranslateY }] },
              ]}
            />
            <MaterialCommunityIcons
              name="file-document-outline"
              size={56}
              color={Colors.light.tint}
            />
            <View style={styles.detectingBadge}>
              <Text style={styles.detectingText}>DETECTING RX...</Text>
            </View>
          </View>
        )}

        {phase === "review" && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(15,23,42,0.95)" }]}>
            <View style={styles.reviewContent}>
              <Ionicons name="checkmark-circle" size={48} color={Colors.light.success} />
              <Text style={styles.detectedViewText}>
                {casePhotos.length} Photo{casePhotos.length !== 1 ? "s" : ""} Captured
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.reviewPhotoStrip}>
                {casePhotos.map((uri, idx) => (
                  <Image key={idx} source={{ uri }} style={styles.reviewThumb} contentFit="cover" />
                ))}
              </ScrollView>
            </View>
          </View>
        )}

        <View style={[styles.cameraHeaderOverlay, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 }]}>
          <Text style={styles.scanTitle}>AI Intake</Text>
          <Text style={styles.scanSubtitle}>
            {phase === "camera" ? "Point camera at prescription" : phase === "scanning" ? "Analyzing document..." : phase === "review" ? "Add more or continue" : "Document recognized"}
          </Text>
        </View>

        <View style={styles.viewfinderFrame}>
          <View style={styles.cornerTL} />
          <View style={styles.cornerTR} />
          <View style={styles.cornerBL} />
          <View style={styles.cornerBR} />
        </View>
      </View>

      <View
        style={[
          styles.scanControls,
          {
            paddingBottom:
              Platform.OS === "web" ? 84 + 20 : insets.bottom + 80,
          },
        ]}
      >
        {phase === "camera" && (
          <View style={styles.cameraControlsWrap}>
            <View style={styles.readyActions}>
              <Pressable
                onPress={handlePickImage}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Ionicons name="images-outline" size={24} color="#FFF" />
                <Text style={styles.secondaryBtnText}>Gallery</Text>
              </Pressable>

              <View style={styles.captureBtnWrap}>
                <Pressable
                  onPress={handleTakePhoto}
                  style={({ pressed }) => [
                    styles.captureBtn,
                    pressed && { transform: [{ scale: 0.95 }] },
                  ]}
                  testID="capture-photo-btn"
                >
                  <View style={styles.captureBtnInner}>
                    <View style={styles.captureBtnDot} />
                  </View>
                </Pressable>
                <Text style={styles.captureBtnLabel}>Document</Text>
              </View>

              <View style={styles.captureBtnWrap}>
                <Pressable
                  onPress={handleTakeRegularPhoto}
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Ionicons name="camera-outline" size={24} color="#FFF" />
                  <Text style={styles.secondaryBtnText}>Photo</Text>
                </Pressable>
                {casePhotos.length > 0 && (
                  <View style={styles.photoBadge}>
                    <Text style={styles.photoBadgeText}>{casePhotos.length}</Text>
                  </View>
                )}
              </View>
            </View>
            <Pressable
              onPress={handleManualEntry}
              style={({ pressed }) => [
                styles.manualEntryLink,
                pressed && { opacity: 0.7 },
              ]}
            >
              <MaterialCommunityIcons
                name="text-box-outline"
                size={16}
                color="rgba(255,255,255,0.6)"
              />
              <Text style={styles.manualEntryLinkText}>Manual Entry</Text>
            </Pressable>
            <Pressable
              onPress={openBarcodeScanner}
              style={({ pressed }) => [styles.barcodeBtn, pressed && { opacity: 0.85 }]}
            >
              <Ionicons name="barcode-outline" size={22} color="#FFF" />
              <Text style={styles.barcodeBtnText}>Scan Barcode</Text>
            </Pressable>
          </View>
        )}
        {phase === "scanning" && (
          <View style={styles.scanningIndicator}>
            <Text style={styles.scanningText}>Analyzing document...</Text>
          </View>
        )}
        {phase === "review" && (
          <View style={styles.detectedActions}>
            <Pressable
              onPress={handleAddMoreFromReview}
              style={({ pressed }) => [
                styles.reviewActionBtn,
                { backgroundColor: "rgba(255,255,255,0.15)", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons name="camera" size={22} color="#FFF" />
              <Text style={styles.actionBtnText}>Add Photo</Text>
            </Pressable>
            <Pressable
              onPress={handleFinishedReview}
              style={({ pressed }) => [
                styles.reviewActionBtn,
                styles.actionBtnPrimary,
                pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
              ]}
            >
              <Ionicons name="checkmark-circle" size={22} color="#FFF" />
              <Text style={styles.actionBtnText}>Finished</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Modal visible={showBarcodeScanner} animationType="slide" onRequestClose={() => setShowBarcodeScanner(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 10, paddingHorizontal: 20, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Scan Barcode</Text>
            <Pressable onPress={() => setShowBarcodeScanner(false)}>
              <Ionicons name="close" size={28} color="#FFF" />
            </Pressable>
          </View>
          {Platform.OS !== "web" ? (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a"] }}
              onBarcodeScanned={barcodeScanned ? undefined : handleBarcodeScanned}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
              <Ionicons name="barcode-outline" size={64} color="#666" />
              <Text style={{ color: "#999", marginTop: 16, fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center" }}>Barcode scanning requires a device camera</Text>
              <Text style={{ color: "#999", marginTop: 8, fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" }}>Enter a barcode manually:</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#555", borderRadius: 10, color: "#FFF", padding: 12, width: "80%", marginTop: 12, fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center" }}
                placeholder="Enter barcode..."
                placeholderTextColor="#666"
                onSubmitEditing={(e) => {
                  const val = e.nativeEvent.text.trim();
                  if (val) handleBarcodeScanned({ data: val });
                }}
                autoFocus
              />
            </View>
          )}
          <View style={{ padding: 20, paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 10, alignItems: "center" }}>
            <Text style={{ color: "#999", fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" }}>Point the camera at a barcode or QR code on the case label</Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={labelModalVisible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {
          setLabelModalVisible(false);
          if (pendingRemakeCheck) {
            const { caseId, patientName: pName } = pendingRemakeCheck;
            setPendingRemakeCheck(null);
            startRemakeCheck(caseId, pName);
          } else {
            router.push("/(tabs)/cases");
          }
        }}
      >
        <View style={labelStyles.overlay}>
          <View style={labelStyles.container}>
            <View style={labelStyles.header}>
              <Text style={labelStyles.headerTitle}>Case Label</Text>
              <Pressable onPress={() => {
                setLabelModalVisible(false);
                if (pendingRemakeCheck) {
                  const { caseId, patientName: pName } = pendingRemakeCheck;
                  setPendingRemakeCheck(null);
                  startRemakeCheck(caseId, pName);
                } else {
                  router.push("/(tabs)/cases");
                }
              }} hitSlop={12}>
                <Ionicons name="close" size={22} color={Colors.light.textSecondary} />
              </Pressable>
            </View>

            {labelData && (
              <ScrollView style={labelStyles.scroll} showsVerticalScrollIndicator={false}>
                <View style={labelStyles.labelCard}>
                  <View style={labelStyles.labelTopBar}>
                    <Text style={labelStyles.labName}>DRIVESYNC LAB</Text>
                    {labelData.isRush && (
                      <View style={labelStyles.rushTag}>
                        <Text style={labelStyles.rushTagText}>RUSH</Text>
                      </View>
                    )}
                  </View>

                  <View style={labelStyles.divider} />

                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Case #</Text>
                    <Text style={labelStyles.labelValue}>{labelData.caseNumber}</Text>
                  </View>

                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Patient</Text>
                    <Text style={labelStyles.labelValue}>{labelData.patientName}</Text>
                  </View>

                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Doctor</Text>
                    <Text style={labelStyles.labelValue}>{labelData.doctorName}</Text>
                  </View>

                  {labelData.caseType ? (
                    <View style={labelStyles.labelRow}>
                      <Text style={labelStyles.labelKey}>Case Type</Text>
                      <Text style={labelStyles.labelValue}>{labelData.caseType}</Text>
                    </View>
                  ) : null}

                  {labelData.toothIndices ? (
                    <View style={labelStyles.labelRow}>
                      <Text style={labelStyles.labelKey}>Tooth #</Text>
                      <Text style={labelStyles.labelValue}>{labelData.toothIndices}</Text>
                    </View>
                  ) : null}

                  {labelData.shade ? (
                    <View style={labelStyles.labelRow}>
                      <Text style={labelStyles.labelKey}>Shade</Text>
                      <Text style={labelStyles.labelValue}>{labelData.shade}</Text>
                    </View>
                  ) : null}

                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Material</Text>
                    <Text style={labelStyles.labelValue}>{labelData.material}</Text>
                  </View>

                  {labelData.dueDate ? (
                    <View style={labelStyles.labelRow}>
                      <Text style={labelStyles.labelKey}>Due Date</Text>
                      <Text style={labelStyles.labelValue}>{labelData.dueDate}</Text>
                    </View>
                  ) : null}

                  <View style={labelStyles.labelRow}>
                    <Text style={labelStyles.labelKey}>Created</Text>
                    <Text style={labelStyles.labelValue}>{labelData.createdAt}</Text>
                  </View>

                  {labelData.notes ? (
                    <>
                      <View style={labelStyles.divider} />
                      <View style={labelStyles.notesSection}>
                        <Text style={labelStyles.labelKey}>Notes</Text>
                        <Text style={labelStyles.notesText}>{labelData.notes}</Text>
                      </View>
                    </>
                  ) : null}

                  <View style={labelStyles.divider} />
                  <Text style={labelStyles.labelFooter}>Station: INTAKE</Text>
                </View>
              </ScrollView>
            )}

            <View style={labelStyles.actions}>
              <Pressable
                style={({ pressed }) => [labelStyles.printBtn, pressed && { opacity: 0.8 }]}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  Alert.alert("Print", "Label sent to printer.", [
                    { text: "OK", onPress: () => {
                      promptAttachBarcode();
                    }},
                  ]);
                }}
              >
                <Ionicons name="print-outline" size={20} color="#FFF" />
                <Text style={labelStyles.printBtnText}>Print Label</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [labelStyles.doneBtn, pressed && { opacity: 0.8 }]}
                onPress={() => {
                  setLabelModalVisible(false);
                  if (pendingRemakeCheck) {
                    const { caseId, patientName: pName } = pendingRemakeCheck;
                    setPendingRemakeCheck(null);
                    startRemakeCheck(caseId, pName);
                  } else {
                    router.push("/(tabs)/cases");
                  }
                }}
              >
                <Text style={labelStyles.doneBtnText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!barcodeScanForCase}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => { setBarcodeScanForCase(null); router.push("/(tabs)/cases"); }}
      >
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(0,0,0,0.8)" }}>
            <Text style={{ fontSize: 18, fontFamily: "Inter_700Bold", color: "#FFF" }}>Scan Barcode to Attach</Text>
            <Pressable onPress={() => { setBarcodeScanForCase(null); router.push("/(tabs)/cases"); }}>
              <Ionicons name="close" size={28} color="#FFF" />
            </Pressable>
          </View>
          {Platform.OS === "web" ? (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 40 }}>
              <Ionicons name="barcode-outline" size={60} color="#FFF" />
              <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 16 }}>Barcode scanning requires a device camera.</Text>
              <Text style={{ color: "#999", marginTop: 8, fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" }}>Enter a barcode manually:</Text>
              <TextInput
                style={{ backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12, color: "#FFF", fontSize: 16, fontFamily: "Inter_500Medium", width: 260, marginTop: 12, textAlign: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }}
                placeholder="Enter barcode..."
                placeholderTextColor="rgba(255,255,255,0.4)"
                autoCapitalize="none"
                onSubmitEditing={(e) => {
                  const val = e.nativeEvent.text.trim();
                  if (val) handleBarcodeAttachScanned({ data: val });
                }}
              />
              <Pressable onPress={() => { setBarcodeScanForCase(null); router.push("/(tabs)/cases"); }} style={{ marginTop: 20, backgroundColor: Colors.light.tint, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 }}>
                <Text style={{ color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" }}>Skip</Text>
              </Pressable>
            </View>
          ) : (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "upc_a"] }}
              onBarcodeScanned={barcodeAttachScanned ? undefined : handleBarcodeAttachScanned}
            >
              <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                <View style={{ width: 260, height: 160, borderWidth: 2, borderColor: "rgba(255,255,255,0.5)", borderRadius: 16, borderStyle: "dashed" }} />
                <Text style={{ color: "#FFF", fontSize: 14, fontFamily: "Inter_500Medium", marginTop: 16 }}>Point camera at barcode</Text>
              </View>
            </CameraView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const labelStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  container: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    width: "100%",
    maxWidth: 400,
    maxHeight: "85%",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  scroll: {
    paddingHorizontal: 20,
  },
  labelCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.light.borderLight,
    borderStyle: "dashed",
    padding: 18,
  },
  labelTopBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  labName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
    letterSpacing: 1.5,
  },
  rushTag: {
    backgroundColor: Colors.light.warningLight,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
  },
  rushTagText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.warning,
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.light.borderLight,
    marginVertical: 12,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 5,
  },
  labelKey: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    width: 80,
  },
  labelValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    flex: 1,
    textAlign: "right",
  },
  notesSection: {
    gap: 6,
  },
  notesText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    lineHeight: 18,
  },
  labelFooter: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    padding: 20,
    paddingTop: 16,
  },
  printBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 14,
    borderRadius: 12,
  },
  printBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  doneBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.light.surfaceSecondary,
    paddingVertical: 14,
    borderRadius: 12,
  },
  doneBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  cameraContainer: {
    flex: 1,
    position: "relative",
  },
  cameraHeaderOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingBottom: 16,
    zIndex: 10,
  },
  scanTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  scanSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.7)",
    marginTop: 4,
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  viewfinderFrame: {
    position: "absolute",
    top: "25%",
    left: 30,
    right: 30,
    aspectRatio: 3 / 4,
    maxHeight: 360,
    zIndex: 5,
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  scanLine: {
    position: "absolute",
    left: 30,
    right: 30,
    height: 3,
    backgroundColor: Colors.light.tint,
    shadowColor: Colors.light.tint,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    zIndex: 10,
  },
  detectingBadge: {
    backgroundColor: Colors.light.tint,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginTop: 16,
  },
  detectingText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    letterSpacing: 1,
  },
  detectedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  reviewContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 20,
  },
  reviewPhotoStrip: {
    flexGrow: 0,
    marginTop: 8,
  },
  reviewThumb: {
    width: 90,
    height: 90,
    borderRadius: 12,
    marginRight: 10,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
  },
  reviewActionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 16,
  },
  detectedViewText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.success,
  },
  detectedSubText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
  },
  cornerTL: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 24,
    height: 24,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderColor: "rgba(255,255,255,0.5)",
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 24,
    height: 24,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderColor: "rgba(255,255,255,0.5)",
    borderTopRightRadius: 6,
  },
  cornerBL: {
    position: "absolute",
    bottom: 0,
    left: 0,
    width: 24,
    height: 24,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderColor: "rgba(255,255,255,0.5)",
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderColor: "rgba(255,255,255,0.5)",
    borderBottomRightRadius: 6,
  },
  scanControls: {
    alignItems: "center",
    paddingVertical: 24,
    backgroundColor: "rgba(0,0,0,0.85)",
  },
  readyActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 32,
  },
  secondaryBtn: {
    alignItems: "center",
    gap: 6,
  },
  secondaryBtnText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.7)",
  },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "#FFF",
    justifyContent: "center",
    alignItems: "center",
    padding: 4,
  },
  captureBtnInner: {
    width: "100%",
    height: "100%",
    borderRadius: 30,
    backgroundColor: "#FFF",
    justifyContent: "center",
    alignItems: "center",
  },
  captureBtnDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.light.error,
  },
  scanningIndicator: {
    alignItems: "center",
    gap: 12,
  },
  scanningText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.6)",
  },
  detectedActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 20,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 16,
  },
  actionBtnSecondary: {
    width: 56,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  actionBtnPrimary: {
    flex: 1,
    backgroundColor: Colors.light.tint,
  },
  actionBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  permissionContainer: {
    justifyContent: "center",
    alignItems: "center",
  },
  permissionContent: {
    alignItems: "center",
    paddingHorizontal: 40,
    gap: 16,
  },
  permissionIconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  permissionTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  permissionDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.5)",
    textAlign: "center",
    lineHeight: 20,
  },
  permissionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 16,
    marginTop: 8,
    width: "100%",
  },
  permissionBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  permissionSkipBtn: {
    paddingVertical: 12,
  },
  permissionSkipText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.4)",
    textDecorationLine: "underline" as const,
  },
  permissionText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.5)",
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  backBtn: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  formTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  submitBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: Colors.light.tint,
    justifyContent: "center",
    alignItems: "center",
  },
  formScroll: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  capturedPreview: {
    height: 160,
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 20,
  },
  previewImage: {
    width: "100%",
    height: "100%",
  },
  previewOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  previewText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.success,
  },
  detectedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.light.successLight,
    padding: 14,
    borderRadius: 14,
    marginBottom: 20,
  },
  detectedText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.success,
  },
  formGroup: {
    marginBottom: 18,
  },
  caseTypeDropdown: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    marginTop: 6,
    overflow: "hidden" as const,
  },
  caseTypeItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  caseTypeItemSelected: {
    backgroundColor: Colors.light.tintLight,
  },
  caseTypeItemText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  caseTypeItemTextSelected: {
    color: Colors.light.tint,
    fontFamily: "Inter_600SemiBold",
  },
  dueDateRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 18,
  },
  dueDateCol: {
    flex: 1,
  },
  timeDueCol: {
    width: 130,
  },
  optionalLabel: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  dueDateDropdown: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    marginTop: 6,
    overflow: "hidden" as const,
  },
  quickDateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  quickDateText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
    flex: 1,
  },
  quickDateSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  calendarContainer: {
    padding: 10,
  },
  calendarHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 10,
  },
  calendarMonthText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  calendarWeekRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  calendarWeekDay: {
    width: `${100 / 7}%` as unknown as number,
    textAlign: "center" as const,
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textTertiary,
    paddingVertical: 4,
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
  },
  calendarDayBtn: {
    width: `${100 / 7}%` as unknown as number,
    aspectRatio: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 20,
  },
  calendarDaySelected: {
    backgroundColor: Colors.light.tint,
  },
  calendarDayToday: {
    borderWidth: 1,
    borderColor: Colors.light.tint,
  },
  calendarDayText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  calendarDayTextSelected: {
    color: "#FFF",
    fontFamily: "Inter_700Bold",
  },
  calendarDayTextToday: {
    color: Colors.light.tint,
    fontFamily: "Inter_600SemiBold",
  },
  timeDueDropdown: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    marginTop: 6,
    padding: 10,
  },
  timePickerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  timePickerCol: {
    alignItems: "center" as const,
  },
  timePickerLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textTertiary,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  timeSpinnerRow: {
    alignItems: "center" as const,
    gap: 2,
  },
  timeSpinBtn: {
    padding: 2,
  },
  timeSpinValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    minWidth: 32,
    textAlign: "center" as const,
  },
  timeColon: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    paddingTop: 16,
  },
  amPmToggle: {
    borderRadius: 8,
    overflow: "hidden" as const,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginTop: 2,
  },
  amPmBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  amPmBtnActive: {
    backgroundColor: Colors.light.tint,
  },
  amPmText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    textAlign: "center" as const,
  },
  amPmTextActive: {
    color: "#FFF",
  },
  timeApplyBtn: {
    backgroundColor: Colors.light.tint,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center" as const,
    marginTop: 8,
  },
  timeApplyText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  formLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 8,
  },
  formInput: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  dropdownTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dropdownTriggerText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  dropdownPanel: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    marginTop: 6,
    overflow: "hidden",
  },
  dropdownSearchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  dropdownSearchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
    paddingVertical: 0,
  },
  dropdownList: {
    maxHeight: 200,
  },
  dropdownEmpty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    textAlign: "center",
    paddingVertical: 20,
  },
  dropdownItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  dropdownItemSelected: {
    backgroundColor: Colors.light.tintLight,
  },
  dropdownItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dropdownAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.light.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  dropdownAvatarText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textSecondary,
  },
  dropdownItemName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  dropdownItemSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 1,
  },
  addNewPatientBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    backgroundColor: Colors.light.tintLight,
  },
  addNewPatientBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  addNewPatientPanel: {
    padding: 12,
    gap: 10,
  },
  addNewPatientTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  addNewPatientActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    justifyContent: "flex-end",
  },
  addNewPatientCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.light.surfaceSecondary,
  },
  addNewPatientCancelText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  addNewPatientConfirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.light.tint,
  },
  addNewPatientConfirmText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  toothChartPanel: {
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    marginTop: 6,
    padding: 12,
    gap: 8,
  },
  toothChartHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  toothChartTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  toothChartClear: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.error,
  },
  toothChartSectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  archContainer: {
    alignItems: "center" as const,
    paddingVertical: 10,
    backgroundColor: "#EFF4FB",
    borderRadius: 16,
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  archSectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
    letterSpacing: 2,
    marginBottom: 4,
    marginTop: 4,
  },
  archRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginVertical: 1,
  },
  archGap: {
    width: "60%",
    paddingVertical: 6,
    alignItems: "center" as const,
  },
  archGapLine: {
    width: "100%",
    height: 1,
    backgroundColor: Colors.light.border,
  },
  archToothBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.light.surface,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
  },
  archToothText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.light.textSecondary,
  },
  toothRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  toothBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: Colors.light.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
  },
  toothBtnSelected: {
    backgroundColor: Colors.light.tint,
    borderColor: Colors.light.tint,
  },
  toothBtnBridge: {
    backgroundColor: Colors.light.accent,
    borderColor: Colors.light.accent,
  },
  toothBtnMissing: {
    backgroundColor: Colors.light.errorLight,
    borderColor: Colors.light.error,
  },
  toothBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  toothBtnTextSelected: {
    color: "#FFF",
  },
  toothBtnTextBridge: {
    color: "#FFF",
  },
  toothBtnTextMissing: {
    color: Colors.light.error,
    fontSize: 11,
  },
  toothMissingWrap: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  toothXOverlay: {
    position: "absolute",
    top: -4,
    left: -2,
    right: -2,
    bottom: -4,
    alignItems: "center",
    justifyContent: "center",
  },
  toothChartLegend: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    marginBottom: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  legendHint: {
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    fontStyle: "italic" as const,
    marginLeft: "auto",
  },
  toothChartDivider: {
    height: 1,
    backgroundColor: Colors.light.borderLight,
    marginVertical: 4,
  },
  toothChartSummary: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
    marginTop: 4,
    gap: 6,
  },
  toothSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toothChartSummaryText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.tint,
    flex: 1,
  },
  toothPricingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.light.tintLight,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  toothPricingLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  toothPricingTotal: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
  },
  formTextArea: {
    minHeight: 80,
    textAlignVertical: "top" as const,
  },
  formRow: {
    flexDirection: "row",
    gap: 12,
  },
  materialSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  materialChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.light.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  materialChipActive: {
    backgroundColor: Colors.light.tintLight,
    borderColor: Colors.light.tint,
  },
  materialText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  materialTextActive: {
    color: Colors.light.tint,
  },
  rushToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 16,
    borderRadius: 14,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginBottom: 18,
  },
  rushToggleActive: {
    borderColor: "rgba(239,68,68,0.3)",
    backgroundColor: "rgba(239,68,68,0.05)",
  },
  rushToggleText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textSecondary,
  },
  rushToggleSwitch: {
    width: 46,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.light.surfaceSecondary,
    padding: 3,
    justifyContent: "center",
  },
  rushToggleDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.light.textTertiary,
  },
  rushToggleDotActive: {
    alignSelf: "flex-end" as const,
    backgroundColor: "#EF4444",
  },
  photoStripSection: {
    marginBottom: 16,
  },
  photoStripHeader: {
    marginBottom: 8,
  },
  photoStrip: {
    flexDirection: "row",
  },
  photoThumbWrap: {
    width: 80,
    height: 80,
    borderRadius: 12,
    overflow: "hidden",
    marginRight: 10,
    position: "relative",
  },
  photoThumb: {
    width: 80,
    height: 80,
  },
  photoRemoveBtn: {
    position: "absolute",
    top: 2,
    right: 2,
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 10,
  },
  addPhotoThumb: {
    width: 80,
    height: 80,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.light.tint + "40",
    borderStyle: "dashed" as const,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.light.tintLight,
  },
  addPhotoBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  addMorePhotosBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Colors.light.tintLight,
    borderWidth: 1,
    borderColor: Colors.light.tint + "30",
  },
  addMorePhotosBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  activitySection: {
    marginTop: 8,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  activityHeaderText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    flex: 1,
  },
  activityBadge: {
    backgroundColor: Colors.light.tintLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  activityBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
  },
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  activityIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  activityContent: {
    flex: 1,
    gap: 2,
  },
  activityDesc: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
  },
  activityTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  activityThumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
  },
  cameraControlsWrap: {
    alignItems: "center",
    gap: 12,
  },
  captureBtnWrap: {
    alignItems: "center",
    position: "relative",
  },
  captureBtnLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.7)",
    marginTop: 4,
  },
  photoBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.light.success,
    justifyContent: "center",
    alignItems: "center",
  },
  photoBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  manualEntryLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
  },
  manualEntryLinkText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.6)",
  },
  barcodeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#6366F1",
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 8,
  },
  barcodeBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  adaChartContainer: {
    paddingVertical: 8,
  },
  adaQuadrantLabels: {
    flexDirection: "row" as const,
    justifyContent: "space-around" as const,
    marginBottom: 4,
  },
  adaQuadrantLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.textTertiary,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
  },
  adaRow: {
    flexDirection: "row" as const,
    justifyContent: "center" as const,
    flexWrap: "wrap" as const,
    gap: 3,
    paddingHorizontal: 4,
  },
  adaToothBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: "center" as const,
    alignItems: "center" as const,
    backgroundColor: Colors.light.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  adaToothBtnMidline: {
    marginRight: 8,
  },
  adaToothText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  adaMidline: {
    width: 1,
    height: 32,
    backgroundColor: Colors.light.textTertiary,
    marginHorizontal: 2,
  },
  adaDividerRow: {
    paddingVertical: 6,
    alignItems: "center" as const,
  },
  adaDividerLine: {
    height: 1,
    width: "90%",
    backgroundColor: Colors.light.borderLight,
  },
});
