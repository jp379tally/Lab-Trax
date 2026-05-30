import React, { useRef, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Alert,
  ActivityIndicator,
  PanResponder,
  Animated,
  ScrollView,
} from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { resilientFetch } from "@/lib/query-client";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

type Step = "capture" | "options" | "result";

export default function SmilePreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<any>(null);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>("capture");
  const [facing, setFacing] = useState<"front" | "back">("front");
  const [capturing, setCapturing] = useState(false);

  const [originalUri, setOriginalUri] = useState<string | null>(null);
  const [enhancedUri, setEnhancedUri] = useState<string | null>(null);

  const [whitenOn, setWhitenOn] = useState(true);
  const [straightenOn, setStraightenOn] = useState(false);

  const [processing, setProcessing] = useState(false);

  const sliderXAnim = useRef(new Animated.Value(0.5)).current;
  const sliderXRaw = useRef(0.5);
  const containerWidthRef = useRef(300);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {},
      onPanResponderMove: (_, gs) => {
        const w = containerWidthRef.current;
        const rawX = sliderXRaw.current * w + gs.dx;
        const clamped = Math.min(Math.max(rawX / w, 0.05), 0.95);
        sliderXAnim.setValue(clamped);
      },
      onPanResponderRelease: (_, gs) => {
        const w = containerWidthRef.current;
        const rawX = sliderXRaw.current * w + gs.dx;
        const clamped = Math.min(Math.max(rawX / w, 0.05), 0.95);
        sliderXRaw.current = clamped;
        sliderXAnim.setValue(clamped);
      },
    })
  ).current;

  async function takePhoto() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      setOriginalUri(photo.uri);
      setEnhancedUri(null);
      sliderXRaw.current = 0.5;
      sliderXAnim.setValue(0.5);
      setStep("options");
    } catch {
      Alert.alert("Error", "Failed to take photo. Please try again.");
    } finally {
      setCapturing(false);
    }
  }

  async function pickFromGallery() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission Needed",
        "Allow access to your photo library to pick an image.",
        [{ text: "OK" }]
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      quality: 0.85,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets.length > 0) {
      setOriginalUri(result.assets[0].uri);
      setEnhancedUri(null);
      sliderXRaw.current = 0.5;
      sliderXAnim.setValue(0.5);
      setStep("options");
    }
  }

  async function generatePreview() {
    if (!originalUri || processing) return;
    if (!whitenOn && !straightenOn) {
      Alert.alert("Select Enhancement", "Please choose at least one enhancement option.");
      return;
    }
    setProcessing(true);
    try {
      let base64: string;
      if (Platform.OS === "web") {
        const resp = await fetch(originalUri);
        const blob = await resp.blob();
        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } else {
        const b64 = await FileSystem.readAsStringAsync(originalUri, {
          encoding: (FileSystem as any).EncodingType?.Base64 ?? "base64",
        });
        base64 = `data:image/jpeg;base64,${b64}`;
      }

      const resp = await resilientFetch("/api/smile-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64,
          whiten: whitenOn,
          straighten: straightenOn,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error((err as any).error || "Processing failed");
      }

      const data = await resp.json();
      setEnhancedUri(data.imageBase64);
      setStep("result");
    } catch (e: any) {
      Alert.alert(
        "Enhancement Failed",
        e?.message || "Unable to process image. Check your connection and try again.",
        [{ text: "Try Again", onPress: () => {} }, { text: "Cancel" }]
      );
    } finally {
      setProcessing(false);
    }
  }

  async function saveToPhotos() {
    if (!enhancedUri) return;
    try {
      // Dynamic require defers native module resolution to call time,
      // preventing a crash in Expo Go where the native module is unavailable.
      const MediaLibrary = require("expo-media-library");
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Needed", "Allow access to save photos to your library.");
        return;
      }
      let fileUri = enhancedUri;
      if (enhancedUri.startsWith("data:")) {
        const base64Data = enhancedUri.replace(/^data:image\/\w+;base64,/, "");
        fileUri = ((FileSystem as any).cacheDirectory ?? "") + `smile-enhanced-${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(fileUri, base64Data, {
          encoding: (FileSystem as any).EncodingType?.Base64 ?? "base64",
        });
      }
      await MediaLibrary.saveToLibraryAsync(fileUri);
      Alert.alert("Saved!", "Enhanced smile photo saved to your camera roll.");
    } catch (e: any) {
      Alert.alert("Save Failed", e?.message || "Could not save the photo.");
    }
  }

  async function sharePhoto() {
    if (!enhancedUri) return;
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert("Sharing Not Available", "Sharing is not supported on this device.");
        return;
      }
      let fileUri = enhancedUri;
      if (enhancedUri.startsWith("data:")) {
        const base64Data = enhancedUri.replace(/^data:image\/\w+;base64,/, "");
        fileUri = ((FileSystem as any).cacheDirectory ?? "") + `smile-enhanced-${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(fileUri, base64Data, {
          encoding: (FileSystem as any).EncodingType?.Base64 ?? "base64",
        });
      }
      await Sharing.shareAsync(fileUri, {
        mimeType: "image/png",
        dialogTitle: "Share Smile Preview",
      });
    } catch (e: any) {
      Alert.alert("Share Failed", e?.message || "Could not share the photo.");
    }
  }

  const topPad = Platform.OS === "web" ? 67 + 8 : insets.top + 8;
  const botPad = Platform.OS === "web" ? 34 + 12 : Math.max(insets.bottom, 16) + 12;

  if (!cameraPermission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.violet} />
      </View>
    );
  }

  if (step === "result" && originalUri && enhancedUri) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: topPad }]}>
          <Pressable onPress={() => { setStep("options"); setEnhancedUri(null); sliderXRaw.current = 0.5; sliderXAnim.setValue(0.5); }} style={styles.iconBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.textInverse} />
          </Pressable>
          <Text style={styles.headerTitle}>Before / After</Text>
          <View style={{ width: 40 }} />
        </View>

        <View
          style={styles.compareContainer}
          onLayout={(e) => { containerWidthRef.current = e.nativeEvent.layout.width; }}
        >
          <Image source={{ uri: enhancedUri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />

          <Animated.View
            style={[
              styles.originalOverlay,
              {
                width: sliderXAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0%", "100%"],
                }),
              },
            ]}
            pointerEvents="none"
          >
            <Image source={{ uri: originalUri }} style={styles.originalImage} contentFit="cover" />
          </Animated.View>

          <Animated.View
            style={[
              styles.dividerLine,
              {
                left: sliderXAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0%", "100%"],
                }),
              },
            ]}
            {...panResponder.panHandlers}
          >
            <View style={styles.dividerHandle}>
              <Ionicons name="chevron-back" size={14} color={colors.textInverse} />
              <Ionicons name="chevron-forward" size={14} color={colors.textInverse} />
            </View>
          </Animated.View>

          <View style={styles.compareLabels} pointerEvents="none">
            <View style={styles.compareLabel}>
              <Text style={styles.compareLabelText}>Before</Text>
            </View>
            <View style={[styles.compareLabel, styles.compareLabelRight]}>
              <Ionicons name="sparkles" size={11} color={colors.textInverse} style={{ marginRight: 3 }} />
              <Text style={styles.compareLabelText}>Enhanced</Text>
            </View>
          </View>
        </View>

        <View style={[styles.resultControls, { paddingBottom: botPad }]}>
          <Text style={styles.resultHint}>Drag the slider to compare</Text>
          <View style={styles.resultBtnRow}>
            <Pressable
              onPress={saveToPhotos}
              style={({ pressed }) => [styles.resultBtn, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="download-outline" size={20} color={colors.textInverse} />
              <Text style={styles.resultBtnText}>Save to Photos</Text>
            </Pressable>
            <Pressable
              onPress={sharePhoto}
              style={({ pressed }) => [styles.resultBtn, styles.resultBtnShare, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="share-outline" size={20} color={colors.textInverse} />
              <Text style={styles.resultBtnText}>Share</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => { setStep("capture"); setOriginalUri(null); setEnhancedUri(null); }}
            style={({ pressed }) => [styles.retakeBtn, pressed && { opacity: 0.75 }]}
          >
            <Ionicons name="camera-outline" size={16} color="rgba(255,255,255,0.6)" />
            <Text style={styles.retakeBtnText}>New Photo</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (step === "options" && originalUri) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: topPad }]}>
          <Pressable onPress={() => { setStep("capture"); setOriginalUri(null); }} style={styles.iconBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.textInverse} />
          </Pressable>
          <Text style={styles.headerTitle}>Choose Enhancements</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={{ flexGrow: 1 }} scrollEnabled={false}>
          <View style={styles.thumbContainer}>
            <Image source={{ uri: originalUri }} style={styles.thumbnail} contentFit="cover" />
            <View style={styles.thumbLabel}>
              <Ionicons name="image-outline" size={12} color={colors.textInverse} />
              <Text style={styles.thumbLabelText}>Original</Text>
            </View>
          </View>

          <View style={[styles.optionsPanel, { paddingBottom: botPad }]}>
            <Text style={styles.optionsSectionTitle}>Select Enhancements</Text>

            <Pressable
              onPress={() => setWhitenOn((v) => !v)}
              style={({ pressed }) => [
                styles.optionRow,
                whitenOn && styles.optionRowActive,
                pressed && { opacity: 0.85 },
              ]}
            >
              <View style={[styles.optionIcon, whitenOn && styles.optionIconActive]}>
                <Ionicons name="sunny" size={22} color={whitenOn ? colors.textInverse : "rgba(255,255,255,0.4)"} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle}>Whiten Smile</Text>
                <Text style={styles.optionSubtitle}>AI brightens and whitens teeth naturally</Text>
              </View>
              <View style={[styles.checkBox, whitenOn && styles.checkBoxActive]}>
                {whitenOn && <Ionicons name="checkmark" size={16} color={colors.textInverse} />}
              </View>
            </Pressable>

            <Pressable
              onPress={() => setStraightenOn((v) => !v)}
              style={({ pressed }) => [
                styles.optionRow,
                straightenOn && styles.optionRowActive,
                straightenOn && styles.optionRowActivePurple,
                pressed && { opacity: 0.85 },
              ]}
            >
              <View style={[styles.optionIcon, straightenOn && styles.optionIconActive, straightenOn && styles.optionIconActivePurple]}>
                <Ionicons name="git-compare-outline" size={22} color={straightenOn ? colors.textInverse : "rgba(255,255,255,0.4)"} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle}>Straighten Smile</Text>
                <Text style={styles.optionSubtitle}>Corrects minor alignment and symmetry</Text>
              </View>
              <View style={[styles.checkBox, straightenOn && styles.checkBoxActive, straightenOn && styles.checkBoxActivePurple]}>
                {straightenOn && <Ionicons name="checkmark" size={16} color={colors.textInverse} />}
              </View>
            </Pressable>

            {whitenOn && straightenOn && (
              <View style={styles.bothBadge}>
                <Ionicons name="sparkles" size={14} color={colors.warning} />
                <Text style={styles.bothBadgeText}>Both enhancements selected — full AI smile makeover</Text>
              </View>
            )}

            <Pressable
              onPress={generatePreview}
              disabled={processing || (!whitenOn && !straightenOn)}
              style={({ pressed }) => [
                styles.generateBtn,
                (processing || (!whitenOn && !straightenOn)) && styles.generateBtnDisabled,
                pressed && { opacity: 0.85 },
              ]}
            >
              {processing ? (
                <>
                  <ActivityIndicator size="small" color={colors.textInverse} />
                  <Text style={styles.generateBtnText}>
                    {whitenOn && straightenOn
                      ? "AI is enhancing the smile…"
                      : whitenOn
                      ? "Whitening smile…"
                      : "Straightening smile…"}
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name="sparkles" size={20} color={colors.textInverse} />
                  <Text style={styles.generateBtnText}>Generate Preview</Text>
                </>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (!cameraPermission.granted) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: topPad }]}>
          <Pressable onPress={() => router.back()} style={styles.iconBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.textInverse} />
          </Pressable>
          <Text style={styles.headerTitle}>Smile Preview</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.centeredBox}>
          <Ionicons name="camera-outline" size={56} color="rgba(255,255,255,0.3)" />
          <Text style={styles.permissionTitle}>Camera Access Needed</Text>
          <Text style={styles.permissionText}>
            Grant camera access to take a smile photo, or pick one from your gallery.
          </Text>
          <Pressable
            onPress={() => requestCameraPermission()}
            style={({ pressed }) => [styles.purpleBtn, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="camera" size={18} color={colors.textInverse} />
            <Text style={styles.purpleBtnText}>Allow Camera</Text>
          </Pressable>
          <Pressable
            onPress={pickFromGallery}
            style={({ pressed }) => [styles.outlineBtn, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="images-outline" size={18} color="rgba(255,255,255,0.8)" />
            <Text style={styles.outlineBtnText}>Pick from Gallery</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: topPad }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.textInverse} />
        </Pressable>
        <Text style={styles.headerTitle}>Smile Preview</Text>
        <Pressable onPress={() => setFacing((f) => (f === "front" ? "back" : "front"))} style={styles.iconBtn}>
          <Ionicons name="camera-reverse-outline" size={24} color={colors.textInverse} />
        </Pressable>
      </View>

      <View style={styles.cameraContainer}>
        <CameraView ref={cameraRef} style={styles.camera} facing={facing} mirror={facing === "front"} />
        <View style={styles.guideOverlay} pointerEvents="none">
          <View style={styles.guideOval} />
          <Text style={styles.guideText}>Position smile within the guide</Text>
        </View>
      </View>

      <View style={[styles.captureBar, { paddingBottom: botPad }]}>
        <View style={styles.captureRow}>
          <Pressable
            onPress={pickFromGallery}
            style={({ pressed }) => [styles.galleryBtn, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="images-outline" size={28} color={colors.textInverse} />
            <Text style={styles.galleryBtnLabel}>Gallery</Text>
          </Pressable>

          <Pressable
            onPress={takePhoto}
            disabled={capturing}
            style={({ pressed }) => [styles.captureBtn, pressed && { opacity: 0.8 }, capturing && { opacity: 0.5 }]}
          >
            {capturing ? (
              <ActivityIndicator size="small" color={colors.textInverse} />
            ) : (
              <View style={styles.captureBtnInner} />
            )}
          </Pressable>

          <View style={{ width: 64 }} />
        </View>
        <Text style={styles.captureHint}>Take a photo or pick from gallery</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" }, // hex-allow: fixed near-black smile-preview stage
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "rgba(0,0,0,0.9)",
    zIndex: 10,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: colors.textInverse },
  centeredBox: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 40, gap: 16 },
  permissionTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: colors.textInverse, textAlign: "center" },
  permissionText: { fontSize: 14, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.55)", textAlign: "center", lineHeight: 20 },
  purpleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.violet,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 4,
  },
  purpleBtnText: { color: colors.textInverse, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  outlineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.3)",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  outlineBtnText: { color: "rgba(255,255,255,0.8)", fontSize: 15, fontFamily: "Inter_500Medium" },
  cameraContainer: { flex: 1, position: "relative" },
  camera: { flex: 1 },
  guideOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  guideOval: {
    width: 260,
    height: 200,
    borderRadius: 130,
    borderWidth: 2,
    borderColor: "rgba(124,58,237,0.6)",
    borderStyle: "dashed",
  },
  guideText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 14,
  },
  captureBar: {
    backgroundColor: "rgba(0,0,0,0.9)",
    paddingTop: 16,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 10,
  },
  captureRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "100%" },
  galleryBtn: { width: 64, alignItems: "center", gap: 4 },
  galleryBtnLabel: { fontSize: 11, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.6)" },
  captureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: colors.violet,
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtnInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.surface },
  captureHint: { color: "rgba(255,255,255,0.4)", fontSize: 12, fontFamily: "Inter_400Regular" },

  thumbContainer: {
    flex: 1,
    minHeight: 220,
    position: "relative",
    overflow: "hidden",
    backgroundColor: "#111", // hex-allow: fixed dark image-compare frame
  },
  thumbnail: { flex: 1, width: "100%" },
  thumbLabel: {
    position: "absolute",
    top: 12,
    left: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  thumbLabelText: { fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textInverse },

  optionsPanel: {
    backgroundColor: "rgba(0,0,0,0.92)",
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 10,
  },
  optionsSectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.45)",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  optionRowActive: {
    backgroundColor: "rgba(37,99,235,0.15)",
    borderColor: colors.info,
  },
  optionRowActivePurple: {
    backgroundColor: "rgba(124,58,237,0.15)",
    borderColor: colors.violet,
  },
  optionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  optionIconActive: { backgroundColor: colors.info },
  optionIconActivePurple: { backgroundColor: colors.violet },
  optionTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.textInverse },
  optionSubtitle: { fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 },
  checkBox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxActive: { backgroundColor: colors.info, borderColor: colors.info },
  checkBoxActivePurple: { backgroundColor: colors.violet, borderColor: colors.violet },
  bothBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(245,158,11,0.12)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
  },
  bothBadgeText: { fontSize: 12, fontFamily: "Inter_500Medium", color: colors.warning, flex: 1 },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.violet,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 4,
  },
  generateBtnDisabled: { backgroundColor: "rgba(124,58,237,0.4)" },
  generateBtnText: { fontSize: 16, fontFamily: "Inter_700Bold", color: colors.textInverse },

  compareContainer: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: "#000",
    position: "relative",
  },
  originalOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
  },
  originalImage: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    width: 9999,
  },
  dividerLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 3,
    marginLeft: -1.5,
    backgroundColor: colors.surface,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dividerHandle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 5,
  },
  compareLabels: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    pointerEvents: "none",
  },
  compareLabel: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  compareLabelRight: { backgroundColor: "rgba(124,58,237,0.7)" },
  compareLabelText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: colors.textInverse },

  resultControls: {
    backgroundColor: "rgba(0,0,0,0.92)",
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 12,
    alignItems: "center",
  },
  resultHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.4)",
    textAlign: "center",
  },
  resultBtnRow: { flexDirection: "row", gap: 10, width: "100%" },
  resultBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.info,
    borderRadius: 14,
    paddingVertical: 14,
  },
  resultBtnShare: { backgroundColor: colors.violet },
  resultBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.textInverse },
  retakeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
  },
  retakeBtnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.45)",
  },
});
