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
  Animated as RNAnimated,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";
import { ActivityEntry, generateId } from "@/lib/data";

type ScanPhase = "camera" | "scanning" | "detected" | "form";

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

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const { addCase, cases } = useApp();
  const [phase, setPhase] = useState<ScanPhase>("camera");
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const scanAnim = useRef(new RNAnimated.Value(0)).current;
  const cameraRef = useRef<CameraView>(null);
  const [cameraReady, setCameraReady] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();

  const [doctorName, setDoctorName] = useState("");
  const [patientInitials, setPatientInitials] = useState("");
  const [toothIndices, setToothIndices] = useState("");
  const [shade, setShade] = useState("");
  const [material, setMaterial] = useState("Zirconia");
  const [isRush, setIsRush] = useState(false);
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("2026-02-20");
  const [casePhotos, setCasePhotos] = useState<string[]>([]);
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);

  useFocusEffect(
    useCallback(() => {
      if (phase !== "form") {
        setPhase("camera");
        setCapturedUri(null);
      }
      return () => {
        setCameraReady(false);
      };
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
        setPhase("detected");
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  async function handleTakePhoto() {
    if (Platform.OS === "web") {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setCapturedUri(result.assets[0].uri);
        setPhase("scanning");
        return;
      }
    }

    if (cameraRef.current && cameraReady) {
      try {
        const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
        if (photo?.uri) {
          setCapturedUri(photo.uri);
          setPhase("scanning");
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }
        }
      } catch {
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
          setCapturedUri(result.assets[0].uri);
          setPhase("scanning");
        }
      }
    } else {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setCapturedUri(result.assets[0].uri);
        setPhase("scanning");
      }
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

  function handleDetected() {
    setDoctorName("Dr. Williams");
    setPatientInitials("S.M.");
    setToothIndices("#14, #15");
    setShade("A2");
    setIsRush(false);
    const scanEntry: ActivityEntry = {
      id: generateId(),
      type: "scan",
      timestamp: Date.now(),
      description: "Prescription scanned via AI Intake",
    };
    const entries: ActivityEntry[] = [scanEntry];
    if (capturedUri) {
      const photoEntry: ActivityEntry = {
        id: generateId(),
        type: "photo",
        timestamp: Date.now(),
        description: "Rx photo captured",
        imageUri: capturedUri,
      };
      entries.push(photoEntry);
      setCasePhotos([capturedUri]);
    }
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
    }]);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
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
          };
          setActivityEntries((prev) => [entry, ...prev]);
        }
      }
    }
  }

  function handleSubmit() {
    if (!doctorName.trim()) {
      Alert.alert("Required", "Doctor name is required");
      return;
    }
    const nextNum =
      cases.length > 0
        ? parseInt(cases[0].caseNumber.replace("#", "")) + 1
        : 4530;

    addCase({
      caseNumber: `#${nextNum}`,
      doctorName: doctorName.trim(),
      patientInitials: patientInitials.trim(),
      toothIndices: toothIndices.trim(),
      shade: shade.trim(),
      material,
      status: "INTAKE",
      isRush,
      notes: notes.trim(),
      price: Math.round(500 + Math.random() * 3000),
      dueDate,
      photos: casePhotos,
      activityLog: activityEntries,
    });

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    resetForm();
    Alert.alert(
      "Case Added",
      `Case #${nextNum} has been created and is now in Intake.`,
    );
  }

  function resetForm() {
    setPhase("camera");
    setCapturedUri(null);
    setDoctorName("");
    setPatientInitials("");
    setToothIndices("");
    setShade("");
    setMaterial("Zirconia");
    setIsRush(false);
    setNotes("");
    setDueDate("2026-02-20");
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

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Doctor Name</Text>
            <TextInput
              style={styles.formInput}
              value={doctorName}
              onChangeText={setDoctorName}
              placeholder="Dr. Smith"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>

          <View style={styles.formRow}>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Patient Initials</Text>
              <TextInput
                style={styles.formInput}
                value={patientInitials}
                onChangeText={setPatientInitials}
                placeholder="J.S."
                placeholderTextColor={Colors.light.textTertiary}
              />
            </View>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Due Date</Text>
              <TextInput
                style={styles.formInput}
                value={dueDate}
                onChangeText={setDueDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={Colors.light.textTertiary}
              />
            </View>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Tooth Indices</Text>
            <TextInput
              style={styles.formInput}
              value={toothIndices}
              onChangeText={setToothIndices}
              placeholder="#8, #9, #10"
              placeholderTextColor={Colors.light.textTertiary}
            />
          </View>

          <View style={styles.formRow}>
            <View style={[styles.formGroup, { flex: 1 }]}>
              <Text style={styles.formLabel}>Shade</Text>
              <TextInput
                style={styles.formInput}
                value={shade}
                onChangeText={setShade}
                placeholder="A2"
                placeholderTextColor={Colors.light.textTertiary}
              />
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

  if (!permission.granted) {
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
            onPress={handleManualEntry}
            style={({ pressed }) => [styles.permissionSkipBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.permissionSkipText}>Enter manually instead</Text>
          </Pressable>
        </View>
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

        {phase === "detected" && capturedUri && (
          <>
            <Image
              source={{ uri: capturedUri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
            />
            <View style={styles.detectedOverlay}>
              <Ionicons
                name="checkmark-circle"
                size={56}
                color={Colors.light.success}
              />
              <Text style={styles.detectedViewText}>
                Prescription Detected
              </Text>
              <Text style={styles.detectedSubText}>
                Dr. Williams - Tooth #14, #15 - Shade A2
              </Text>
            </View>
          </>
        )}

        {phase === "detected" && !capturedUri && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(15,23,42,0.95)", justifyContent: "center", alignItems: "center", gap: 12 }]}>
            <Ionicons
              name="checkmark-circle"
              size={56}
              color={Colors.light.success}
            />
            <Text style={styles.detectedViewText}>
              Prescription Detected
            </Text>
            <Text style={styles.detectedSubText}>
              Dr. Williams - Tooth #14, #15 - Shade A2
            </Text>
          </View>
        )}

        <View style={[styles.cameraHeaderOverlay, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 }]}>
          <Text style={styles.scanTitle}>AI Intake</Text>
          <Text style={styles.scanSubtitle}>
            {phase === "camera" ? "Point camera at prescription" : phase === "scanning" ? "Analyzing document..." : "Document recognized"}
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

            <Pressable
              onPress={handleManualEntry}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <MaterialCommunityIcons
                name="text-box-outline"
                size={24}
                color="#FFF"
              />
              <Text style={styles.secondaryBtnText}>Manual</Text>
            </Pressable>
          </View>
        )}
        {phase === "scanning" && (
          <View style={styles.scanningIndicator}>
            <Text style={styles.scanningText}>Analyzing document...</Text>
          </View>
        )}
        {phase === "detected" && (
          <View style={styles.detectedActions}>
            <Pressable
              onPress={resetForm}
              style={({ pressed }) => [
                styles.actionBtn,
                styles.actionBtnSecondary,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons name="refresh" size={22} color="#FFF" />
            </Pressable>
            <Pressable
              onPress={handleDetected}
              style={({ pressed }) => [
                styles.actionBtn,
                styles.actionBtnPrimary,
                pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
              ]}
            >
              <Ionicons name="checkmark" size={24} color="#FFF" />
              <Text style={styles.actionBtnText}>Confirm & Edit</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

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
});
