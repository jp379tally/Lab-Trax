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
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";
import { getStationInfo, STATIONS, CaseStatus } from "@/lib/data";

export default function CaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { cases, updateCaseStatus, addCasePhoto, addCaseNote, addTrackingNumber, role, adminUnlocked } = useApp();
  const insets = useSafeAreaInsets();
  const [showRouting, setShowRouting] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [capturedPhotos, setCapturedPhotos] = useState<string[]>([]);
  const [showPhotoPreview, setShowPhotoPreview] = useState(false);
  const [showCompleteInfo, setShowCompleteInfo] = useState(false);

  const caseItem = cases.find((c) => c.id === id);
  const showPrice = role === "admin" && adminUnlocked;

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
    updateCaseStatus(caseItem!.id, newStatus);
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

  function handleFinishPhotos() {
    capturedPhotos.forEach((uri) => {
      addCasePhoto(caseItem!.id, uri);
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
    addCaseNote(caseItem!.id, noteText.trim());
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setNoteText("");
    setShowNoteModal(false);
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

        <View style={styles.infoGrid}>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Doctor</Text>
            <Text style={styles.infoValue}>{caseItem.doctorName}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Patient</Text>
            <Text style={styles.infoValue}>
              {(caseItem as any).patientFullName || caseItem.patientInitials}
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
            <Text style={styles.infoValue}>{caseItem.dueDate}</Text>
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
            let iconName: keyof typeof Ionicons.glyphMap = "ellipse";
            let iconSize = 12;
            let iconColor = "#fff";

            if (isStation && stationInfo) {
              dotColor = isLast ? stationInfo.color : Colors.light.textTertiary;
              iconName = "navigate";
              iconSize = 10;
            } else if (isNote) {
              dotColor = "#F59E0B";
              iconName = "document-text";
              iconSize = 10;
            } else if (isPhoto) {
              dotColor = "#8B5CF6";
              iconName = "camera";
              iconSize = 10;
            }

            return (
              <View key={entry.id || idx} style={styles.timelineItem}>
                <View style={styles.timelineLine}>
                  <View
                    style={[
                      styles.timelineDot,
                      { backgroundColor: dotColor, justifyContent: "center", alignItems: "center" },
                    ]}
                  >
                    <Ionicons name={iconName} size={iconSize} color={iconColor} />
                  </View>
                  {!isLast && <View style={styles.timelineConnector} />}
                </View>
                <View style={[styles.timelineContent, isPhoto && entry.imageUri ? { paddingBottom: 20 } : {}]}>
                  {isStation && stationInfo ? (
                    <Text
                      style={[
                        styles.timelineStation,
                        isLast && { color: stationInfo.color, fontFamily: "Inter_700Bold" },
                      ]}
                    >
                      {stationInfo.label}
                    </Text>
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

          {showRouting && (
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
    </View>
  );
}

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
});
