import React, { useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Image,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";

const SHADES = [
  { name: "A1", color: "#F5F0E6" },
  { name: "A2", color: "#EDE8D5" },
  { name: "BL1", color: "#F5F5F0" },
  { name: "BL2", color: "#F0F0EA" },
  { name: "BL3", color: "#EAEAE4" },
  { name: "B1", color: "#EEE8D8" },
  { name: "Hollywood", color: "#FFFFFF" },
];

const INTENSITY_LEVELS = [
  { label: "Light", value: 0.15 },
  { label: "Medium", value: 0.3 },
  { label: "Strong", value: 0.45 },
  { label: "Max", value: 0.6 },
];

export default function SmilePreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<any>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [whitenIntensity, setWhitenIntensity] = useState(0.3);
  const [selectedShade, setSelectedShade] = useState("#F5F5F0");
  const [effectOn, setEffectOn] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [facing, setFacing] = useState<"front" | "back">("front");

  async function takePhoto() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      setCapturedPhoto(photo.uri);
    } catch (err) {
      Alert.alert("Error", "Failed to take photo. Please try again.");
    } finally {
      setCapturing(false);
    }
  }

  if (!permission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 8 : insets.top + 8 }]}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </Pressable>
          <Text style={styles.headerTitle}>Smile Preview</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.permissionContainer}>
          <Ionicons name="camera-outline" size={64} color="rgba(255,255,255,0.3)" />
          <Text style={styles.permissionTitle}>Camera Access Needed</Text>
          <Text style={styles.permissionText}>
            To use Smile Preview, please allow camera access. This lets you take a photo and preview teeth whitening effects.
          </Text>
          <Pressable
            onPress={requestPermission}
            style={({ pressed }) => [styles.permissionBtn, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.permissionBtnText}>Allow Camera</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (capturedPhoto) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 8 : insets.top + 8 }]}>
          <Pressable onPress={() => setCapturedPhoto(null)} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </Pressable>
          <Text style={styles.headerTitle}>Preview</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.photoContainer}>
          <Image source={{ uri: capturedPhoto }} style={styles.capturedImage} resizeMode="contain" />
          {effectOn && (
            <View
              style={[
                styles.whiteningOverlay,
                {
                  backgroundColor: selectedShade,
                  opacity: whitenIntensity,
                },
              ]}
              pointerEvents="none"
            />
          )}
        </View>

        <View style={[styles.controls, { paddingBottom: Platform.OS === "web" ? 34 + 16 : Math.max(insets.bottom, 16) + 16 }]}>
          <View style={styles.controlRow}>
            <Text style={styles.controlLabel}>Intensity</Text>
            <View style={styles.intensityRow}>
              {INTENSITY_LEVELS.map((level) => (
                <Pressable
                  key={level.label}
                  onPress={() => setWhitenIntensity(level.value)}
                  style={[
                    styles.intensityBtn,
                    whitenIntensity === level.value && styles.intensityBtnActive,
                  ]}
                >
                  <Text style={[
                    styles.intensityBtnText,
                    whitenIntensity === level.value && styles.intensityBtnTextActive,
                  ]}>
                    {level.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.controlRow}>
            <Text style={styles.controlLabel}>Shade</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
              {SHADES.map((s) => (
                <Pressable
                  key={s.name}
                  onPress={() => setSelectedShade(s.color)}
                  style={[
                    styles.shadeBtn,
                    { backgroundColor: s.color },
                    selectedShade === s.color && styles.shadeBtnActive,
                  ]}
                >
                  {selectedShade === s.color && (
                    <Text style={styles.shadeLabel}>{s.name}</Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </View>

          <View style={styles.btnRow}>
            <Pressable
              onPress={() => setEffectOn(!effectOn)}
              style={({ pressed }) => [
                styles.btn,
                effectOn ? styles.btnActive : styles.btnInactive,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={styles.btnText}>{effectOn ? "✨ Effect ON" : "Effect OFF"}</Text>
            </Pressable>
            <Pressable
              onPress={() => setCapturedPhoto(null)}
              style={({ pressed }) => [styles.btn, styles.btnRetake, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="camera-reverse-outline" size={18} color="#FFF" />
              <Text style={styles.btnText}>Retake</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 8 : insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </Pressable>
        <Text style={styles.headerTitle}>Smile Preview</Text>
        <Pressable onPress={() => setFacing(f => f === "front" ? "back" : "front")} style={styles.backBtn}>
          <Ionicons name="camera-reverse-outline" size={24} color="#FFF" />
        </Pressable>
      </View>

      <View style={styles.cameraContainer}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={facing}
          mirror={facing === "front"}
        />

        <View style={styles.guideOverlay} pointerEvents="none">
          <View style={styles.guideOval} />
          <Text style={styles.guideText}>Position face within the guide</Text>
        </View>
      </View>

      <View style={[styles.captureBar, { paddingBottom: Platform.OS === "web" ? 34 + 16 : Math.max(insets.bottom, 16) + 16 }]}>
        <Text style={styles.captureHint}>Take a photo to preview teeth whitening</Text>
        <Pressable
          onPress={takePhoto}
          disabled={capturing}
          style={({ pressed }) => [
            styles.captureBtn,
            pressed && { opacity: 0.8 },
            capturing && { opacity: 0.5 },
          ]}
        >
          {capturing ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <View style={styles.captureBtnInner} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "rgba(0,0,0,0.85)",
    zIndex: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  permissionContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 16,
  },
  permissionTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  permissionText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.6)",
    textAlign: "center",
    lineHeight: 22,
  },
  permissionBtn: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
  },
  permissionBtnText: {
    color: "#FFF",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  cameraContainer: {
    flex: 1,
    position: "relative",
  },
  camera: {
    flex: 1,
  },
  guideOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  guideOval: {
    width: 240,
    height: 320,
    borderRadius: 120,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.35)",
    borderStyle: "dashed",
  },
  guideText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 16,
  },
  captureBar: {
    alignItems: "center",
    paddingTop: 16,
    backgroundColor: "rgba(0,0,0,0.85)",
    gap: 12,
  },
  captureHint: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "#FFF",
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtnInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#FFF",
  },
  photoContainer: {
    flex: 1,
    position: "relative",
  },
  capturedImage: {
    flex: 1,
    width: "100%",
  },
  whiteningOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  controls: {
    backgroundColor: "rgba(0,0,0,0.9)",
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 14,
  },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  controlLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.8)",
    minWidth: 64,
  },
  controlValue: {
    fontSize: 13,
    color: "rgba(255,255,255,0.6)",
    minWidth: 36,
    textAlign: "right" as const,
    fontFamily: "Inter_500Medium",
  },
  intensityRow: {
    flexDirection: "row" as const,
    gap: 6,
    flex: 1,
  },
  intensityBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center" as const,
  },
  intensityBtnActive: {
    backgroundColor: "#2563EB",
  },
  intensityBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.5)",
  },
  intensityBtnTextActive: {
    color: "#FFF",
  },
  shadeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  shadeBtnActive: {
    borderColor: "#FFF",
    transform: [{ scale: 1.15 }],
  },
  shadeLabel: {
    fontSize: 7,
    fontFamily: "Inter_700Bold",
    color: "#333",
  },
  btnRow: {
    flexDirection: "row" as const,
    gap: 10,
    justifyContent: "center" as const,
    marginTop: 2,
  },
  btn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 22,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
  },
  btnActive: {
    backgroundColor: "#10B981",
  },
  btnInactive: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  btnRetake: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  btnText: {
    color: "#FFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
