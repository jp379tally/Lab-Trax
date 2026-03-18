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
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system";
import { getApiUrl } from "@/lib/query-client";

export default function SmilePreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<any>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [processedPhoto, setProcessedPhoto] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processingMode, setProcessingMode] = useState<string | null>(null);
  const [facing, setFacing] = useState<"front" | "back">("front");
  const [activeEffect, setActiveEffect] = useState<string | null>(null);

  async function takePhoto() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      setCapturedPhoto(photo.uri);
      setProcessedPhoto(null);
      setActiveEffect(null);
    } catch {
      Alert.alert("Error", "Failed to take photo. Please try again.");
    } finally {
      setCapturing(false);
    }
  }

  async function processImage(mode: "whiten" | "symmetry" | "both") {
    if (!capturedPhoto || processing) return;
    setProcessing(true);
    setProcessingMode(mode);
    try {
      let base64: string;
      if (Platform.OS === "web") {
        const resp = await fetch(capturedPhoto);
        const blob = await resp.blob();
        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } else {
        const b64 = await FileSystem.readAsStringAsync(capturedPhoto, {
          encoding: "base64" as any,
        });
        base64 = `data:image/jpeg;base64,${b64}`;
      }

      const apiUrl = new URL("/api/smile-process", getApiUrl()).toString();
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mode }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Processing failed");
      }

      const data = await resp.json();
      setProcessedPhoto(data.imageBase64);
      setActiveEffect(mode);
    } catch (e: any) {
      Alert.alert("Processing Error", e?.message || "Failed to process image. Please try again.");
    } finally {
      setProcessing(false);
      setProcessingMode(null);
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
            To use Smile Preview, please allow camera access. This lets you take a photo and preview AI teeth enhancements.
          </Text>
          <Pressable onPress={requestPermission} style={({ pressed }) => [styles.permissionBtn, pressed && { opacity: 0.8 }]}>
            <Text style={styles.permissionBtnText}>Allow Camera</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (capturedPhoto) {
    const displayPhoto = processedPhoto || capturedPhoto;
    const isOriginal = !processedPhoto;

    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 8 : insets.top + 8 }]}>
          <Pressable onPress={() => { setCapturedPhoto(null); setProcessedPhoto(null); setActiveEffect(null); }} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </Pressable>
          <Text style={styles.headerTitle}>Preview</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.photoContainer}>
          <Image source={{ uri: displayPhoto }} style={styles.capturedImage} resizeMode="cover" />

          {processing && (
            <View style={styles.processingOverlay}>
              <View style={styles.processingCard}>
                <ActivityIndicator size="large" color="#2563EB" />
                <Text style={styles.processingTitle}>
                  {processingMode === "whiten" ? "Whitening Teeth..." : processingMode === "symmetry" ? "Restoring Symmetry..." : "Enhancing Smile..."}
                </Text>
                <Text style={styles.processingSubtitle}>AI is processing your photo</Text>
              </View>
            </View>
          )}

          {activeEffect && !processing && (
            <View style={styles.effectBadge}>
              <Ionicons name="sparkles" size={12} color="#FFF" />
              <Text style={styles.effectBadgeText}>
                {activeEffect === "whiten" ? "Whitened" : activeEffect === "symmetry" ? "Symmetry" : "Whitened + Symmetry"}
              </Text>
            </View>
          )}
        </View>

        <View style={[styles.controls, { paddingBottom: Platform.OS === "web" ? 34 + 12 : Math.max(insets.bottom, 16) + 12 }]}>
          {!processing && (
            <>
              <Text style={styles.sectionLabel}>AI Enhancements</Text>
              <View style={styles.enhancementRow}>
                <Pressable
                  onPress={() => processImage("whiten")}
                  disabled={processing}
                  style={({ pressed }) => [styles.enhanceBtn, activeEffect === "whiten" && styles.enhanceBtnDone, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="sunny-outline" size={20} color="#FFF" />
                  <Text style={styles.enhanceBtnText}>Whiten</Text>
                </Pressable>
                <Pressable
                  onPress={() => processImage("symmetry")}
                  disabled={processing}
                  style={({ pressed }) => [styles.enhanceBtn, styles.enhanceBtnSymmetry, activeEffect === "symmetry" && styles.enhanceBtnDone, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="git-compare-outline" size={20} color="#FFF" />
                  <Text style={styles.enhanceBtnText}>Symmetry</Text>
                </Pressable>
                <Pressable
                  onPress={() => processImage("both")}
                  disabled={processing}
                  style={({ pressed }) => [styles.enhanceBtn, styles.enhanceBtnBoth, activeEffect === "both" && styles.enhanceBtnDone, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="sparkles" size={20} color="#FFF" />
                  <Text style={styles.enhanceBtnText}>Both</Text>
                </Pressable>
              </View>

              <View style={styles.actionRow}>
                {processedPhoto && (
                  <Pressable
                    onPress={() => { setProcessedPhoto(null); setActiveEffect(null); }}
                    style={({ pressed }) => [styles.actionBtn, styles.actionBtnSecondary, pressed && { opacity: 0.8 }]}
                  >
                    <Ionicons name="eye-outline" size={16} color="#FFF" />
                    <Text style={styles.actionBtnText}>Original</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => { setCapturedPhoto(null); setProcessedPhoto(null); setActiveEffect(null); }}
                  style={({ pressed }) => [styles.actionBtn, styles.actionBtnSecondary, pressed && { opacity: 0.8 }]}
                >
                  <Ionicons name="camera-reverse-outline" size={16} color="#FFF" />
                  <Text style={styles.actionBtnText}>Retake</Text>
                </Pressable>
              </View>
            </>
          )}
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
        <Pressable onPress={() => setFacing(f => (f === "front" ? "back" : "front"))} style={styles.backBtn}>
          <Ionicons name="camera-reverse-outline" size={24} color="#FFF" />
        </Pressable>
      </View>

      <View style={styles.cameraContainer}>
        <CameraView ref={cameraRef} style={styles.camera} facing={facing} mirror={facing === "front"} />
        <View style={styles.guideOverlay} pointerEvents="none">
          <View style={styles.guideOval} />
          <Text style={styles.guideText}>Position face within the guide</Text>
        </View>
      </View>

      <View style={[styles.captureBar, { paddingBottom: Platform.OS === "web" ? 34 + 16 : Math.max(insets.bottom, 16) + 16 }]}>
        <Text style={styles.captureHint}>Take a photo to preview AI smile enhancements</Text>
        <Pressable
          onPress={takePhoto}
          disabled={capturing}
          style={({ pressed }) => [styles.captureBtn, pressed && { opacity: 0.8 }, capturing && { opacity: 0.5 }]}
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
  container: { flex: 1, backgroundColor: "#000" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "rgba(0,0,0,0.85)",
    zIndex: 10,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: "#FFF" },
  permissionContainer: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 40, gap: 16 },
  permissionTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: "#FFF" },
  permissionText: { fontSize: 15, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center", lineHeight: 22 },
  permissionBtn: { backgroundColor: "#2563EB", paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12, marginTop: 8 },
  permissionBtnText: { color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  cameraContainer: { flex: 1, position: "relative" },
  camera: { flex: 1 },
  guideOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  guideOval: { width: 240, height: 320, borderRadius: 120, borderWidth: 2, borderColor: "rgba(255,255,255,0.35)", borderStyle: "dashed" },
  guideText: { color: "rgba(255,255,255,0.5)", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 16 },
  captureBar: { alignItems: "center", paddingTop: 16, backgroundColor: "rgba(0,0,0,0.85)", gap: 12 },
  captureHint: { color: "rgba(255,255,255,0.5)", fontSize: 13, fontFamily: "Inter_400Regular" },
  captureBtn: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: "#FFF", alignItems: "center", justifyContent: "center" },
  captureBtnInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFF" },
  photoContainer: { flex: 1, position: "relative", overflow: "hidden" },
  capturedImage: { flex: 1, width: "100%" },
  processingOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  processingCard: {
    backgroundColor: "rgba(30,30,30,0.95)",
    borderRadius: 20,
    paddingHorizontal: 36,
    paddingVertical: 28,
    alignItems: "center",
    gap: 12,
  },
  processingTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: "#FFF" },
  processingSubtitle: { fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)" },
  effectBadge: {
    position: "absolute",
    top: 16,
    right: 16,
    backgroundColor: "rgba(16,185,129,0.9)",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  effectBadgeText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#FFF" },
  controls: {
    backgroundColor: "rgba(0,0,0,0.92)",
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.5)",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  enhancementRow: {
    flexDirection: "row" as const,
    gap: 10,
  },
  enhanceBtn: {
    flex: 1,
    backgroundColor: "#2563EB",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 4,
  },
  enhanceBtnSymmetry: {
    backgroundColor: "#7C3AED",
  },
  enhanceBtnBoth: {
    backgroundColor: "#D97706",
  },
  enhanceBtnDone: {
    borderWidth: 2,
    borderColor: "#10B981",
  },
  enhanceBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  actionRow: {
    flexDirection: "row" as const,
    gap: 10,
    justifyContent: "center" as const,
  },
  actionBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
  },
  actionBtnSecondary: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  actionBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
});
