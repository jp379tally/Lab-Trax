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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus, ToothType, MATERIAL_PRICES, CaseTypeValue } from "@/lib/data";

export default function CaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { cases, updateCaseStatus, addCasePhoto, addCaseNote, addTrackingNumber, addCaseItem, role, adminUnlocked, users } = useApp();
  const { currentUser } = useAuth();
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
  const [addItemStep, setAddItemStep] = useState<"caseType" | "toothChart">("caseType");
  const [itemCaseType, setItemCaseType] = useState<CaseTypeValue>("");
  const [itemSelectedTeeth, setItemSelectedTeeth] = useState<number[]>([]);
  const [itemToothTypes, setItemToothTypes] = useState<Record<number, ToothType>>({});
  const [itemMaterial, setItemMaterial] = useState("Zirconia");

  const caseItem = cases.find((c) => c.id === id);
  const isAdmin = role === "admin" && adminUnlocked;
  const showPrice = isAdmin;

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

  const stationInfo = getStationInfo(caseItem.status);

  function handleRoute(newStatus: CaseStatus) {
    updateCaseStatus(caseItem!.id, newStatus, userInitials);
    setShowRouting(false);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    Alert.alert(
      "Routed",
      `Case ${caseItem!.caseNumber} moved to ${getStationInfo(newStatus).label}`,
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

  async function handleTakePhoto() {
    if (Platform.OS === "web") {
      try {
        const uri = await webFilePickerForCamera();
        if (uri) {
          setCapturedPhotos((prev) => [...prev, uri]);
          setShowPhotoPreview(true);
        }
      } catch (e) {
        Alert.alert("Camera Error", "Unable to open camera. Please try again.");
      }
      return;
    }
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to take photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      const uri = result.assets[0].uri;
      setCapturedPhotos((prev) => [...prev, uri]);
      setShowPhotoPreview(true);
    }
  }

  async function handleAddMorePhoto() {
    if (Platform.OS === "web") {
      try {
        const uri = await webFilePickerForCamera();
        if (uri) {
          setCapturedPhotos((prev) => [...prev, uri]);
        }
      } catch (e) {
        Alert.alert("Camera Error", "Unable to open camera. Please try again.");
      }
      return;
    }
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to take photos.");
      return;
    }
    setShowPhotoPreview(false);
    setTimeout(async () => {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets[0]) {
        const uri = result.assets[0].uri;
        setCapturedPhotos((prev) => [...prev, uri]);
      }
      setShowPhotoPreview(true);
    }, 500);
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
    setShowAddItemModal(true);
  }

  function handleSaveItem() {
    if (!itemCaseType) {
      Alert.alert("Missing Info", "Please select a case type.");
      return;
    }
    if (itemSelectedTeeth.length === 0) {
      Alert.alert("Missing Info", "Please select at least one tooth.");
      return;
    }
    addCaseItem(caseItem!.id, itemCaseType, itemSelectedTeeth, itemToothTypes, itemMaterial);
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
              quality: 0.8,
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
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    Alert.alert("Photos Saved", `${capturedPhotos.length} photo${capturedPhotos.length > 1 ? "s" : ""} added to case.`);
    setCapturedPhotos([]);
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
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to take photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      setEntryPhotos((prev) => [...prev, result.assets[0].uri]);
    }
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
        <Text style={styles.headerTitle}>{caseItem.caseNumber}</Text>
        <View style={{ width: 44 }} />
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
            <Text style={styles.infoValue}>{caseItem.doctorName}</Text>
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

        {caseItem.notes ? (
          <View style={styles.notesCard}>
            <Text style={styles.notesLabel}>Notes</Text>
            <Text style={styles.notesText}>{caseItem.notes}</Text>
          </View>
        ) : null}

        {(caseItem.photos?.length ?? 0) > 0 && (
          <View style={{ marginBottom: 16 }}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Photos ({caseItem.photos!.length})</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
              {caseItem.photos!.map((uri, idx) => (
                <Image
                  key={idx}
                  source={{ uri }}
                  style={styles.photoThumb}
                />
              ))}
            </ScrollView>
          </View>
        )}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Case History</Text>
        </View>
        <View style={styles.timeline}>
          {(caseItem.activityLog && caseItem.activityLog.length > 0
            ? [...caseItem.activityLog].sort((a, b) => a.timestamp - b.timestamp)
            : caseItem.routeHistory.map((rh) => ({
                id: String(rh.timestamp),
                type: "station_change" as const,
                timestamp: rh.timestamp,
                description: `Case moved to ${getStationInfo(rh.station).label}`,
                station: rh.station,
              }))
          ).map((entry, idx, arr) => {
            const isLast = idx === arr.length - 1;
            const isStation = entry.type === "station_change" || entry.type === "created" || entry.type === "scan";
            const isNote = entry.type === "note";
            const isPhoto = entry.type === "photo";
            const stationInfo = entry.station ? getStationInfo(entry.station) : null;

            let dotColor = Colors.light.textTertiary;

            if (isStation && stationInfo) {
              dotColor = isLast ? stationInfo.color : Colors.light.textTertiary;
            } else if (isNote) {
              dotColor = "#F59E0B";
            } else if (isPhoto) {
              dotColor = "#8B5CF6";
            }

            const entryUserName = entry.user
              ? (users.find((u) => u.id === entry.user || u.name === entry.user)?.name || entry.user)
              : "";
            const userInitials = entryUserName
              ? entryUserName.split(" ").map((w: string) => w.charAt(0).toUpperCase()).join("").slice(0, 2)
              : (isStation ? "" : (role === "admin" ? "A" : "T"));

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
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text
                        style={[
                          styles.timelineStation,
                          isLast && { color: stationInfo.color, fontFamily: "Inter_700Bold" },
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
          {isAdmin && (
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
              {showRouting ? "Hide Stations" : "Locate"}
            </Text>
          </Pressable>
          )}

          {isAdmin && showRouting && (
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
              <Text style={styles.actionBtnText}>Add Picture</Text>
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
        </View>
      </ScrollView>

      <Modal
        visible={showPhotoPreview}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setCapturedPhotos([]);
          setShowPhotoPreview(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.photoModal, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>
              {capturedPhotos.length} Photo{capturedPhotos.length !== 1 ? "s" : ""} Captured
            </Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
              {capturedPhotos.map((uri, idx) => (
                <Image key={idx} source={{ uri }} style={styles.previewPhoto} />
              ))}
            </ScrollView>

            <View style={styles.photoActions}>
              <Pressable
                onPress={handleAddMorePhoto}
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
                onPress={handleFinishPhotos}
                style={({ pressed }) => [
                  styles.photoActionBtn,
                  { backgroundColor: Colors.light.tint },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Ionicons name="checkmark" size={20} color="#FFF" />
                <Text style={[styles.photoActionText, { color: "#FFF" }]}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
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
        <View style={styles.addItemOverlay}>
          <View style={[styles.addItemSheet, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={styles.addItemHeader}>
              <Pressable onPress={() => {
                if (addItemStep === "toothChart") {
                  setAddItemStep("caseType");
                } else {
                  setShowAddItemModal(false);
                }
              }}>
                <Ionicons name={addItemStep === "toothChart" ? "arrow-back" : "close"} size={24} color={Colors.light.textSecondary} />
              </Pressable>
              <Text style={styles.addItemTitle}>
                {addItemStep === "caseType" ? "Select Case Type" : "Select Teeth"}
              </Text>
              <View style={{ width: 24 }} />
            </View>

            {addItemStep === "caseType" ? (
              <View style={styles.addItemCaseTypeList}>
                {(["Restorative", "Removable", "Appliance", "Temporary"] as CaseTypeValue[]).map((type) => (
                  <Pressable
                    key={type}
                    onPress={() => {
                      setItemCaseType(type);
                      setAddItemStep("toothChart");
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
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
                <View style={styles.addItemSelectedType}>
                  <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                  <Text style={styles.addItemSelectedTypeText}>{itemCaseType}</Text>
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

                <View style={styles.aiMaterialSection}>
                  <Text style={styles.aiMaterialLabel}>Material</Text>
                  <View style={styles.aiMaterialSelector}>
                    {["Zirconia", "E.max", "PFM", "Gold"].map((m) => (
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
                    (!itemCaseType || itemSelectedTeeth.length === 0) && { opacity: 0.5 },
                    pressed && { opacity: 0.85 },
                  ]}
                  disabled={!itemCaseType || itemSelectedTeeth.length === 0}
                >
                  <Ionicons name="checkmark" size={20} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Save Item</Text>
                </Pressable>
              </ScrollView>
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
