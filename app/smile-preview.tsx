import React, { useRef, useState, useMemo } from "react";
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
  PanResponder,
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

const DEFAULT_ZONE = { cx: 0.5, cy: 0.63, w: 0.52, h: 0.1 };

export default function SmilePreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<any>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [whitenIntensity, setWhitenIntensity] = useState(0.3);
  const [selectedShade, setSelectedShade] = useState("#F5F5F0");
  const [effectOn, setEffectOn] = useState(true);
  const [symmetryOn, setSymmetryOn] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [facing, setFacing] = useState<"front" | "back">("front");
  const [teethZone, setTeethZone] = useState(DEFAULT_ZONE);
  const teethZoneRef = useRef(DEFAULT_ZONE);
  const [applied, setApplied] = useState(false);
  const [imgLayout, setImgLayout] = useState({ width: 0, height: 0 });
  const imgLayoutRef = useRef({ width: 0, height: 0 });
  const dragStartRef = useRef({ cx: 0, cy: 0 });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gs) =>
          Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3,
        onPanResponderGrant: () => {
          dragStartRef.current = {
            cx: teethZoneRef.current.cx,
            cy: teethZoneRef.current.cy,
          };
        },
        onPanResponderMove: (_, gs) => {
          const { width, height } = imgLayoutRef.current;
          if (width === 0 || height === 0) return;
          const newCx = Math.max(
            0.15,
            Math.min(0.85, dragStartRef.current.cx + gs.dx / width),
          );
          const newCy = Math.max(
            0.1,
            Math.min(0.9, dragStartRef.current.cy + gs.dy / height),
          );
          const next = { ...teethZoneRef.current, cx: newCx, cy: newCy };
          teethZoneRef.current = next;
          setTeethZone(next);
        },
      }),
    [],
  );

  const zonePixels = useMemo(() => {
    const imgW = imgLayout.width;
    const imgH = imgLayout.height;
    const zW = teethZone.w * imgW;
    const zH = teethZone.h * imgH;
    const zL = teethZone.cx * imgW - zW / 2;
    const zT = teethZone.cy * imgH - zH / 2;
    return { zW, zH, zL, zT, imgW, imgH };
  }, [teethZone, imgLayout]);

  function adjustZoneSize(delta: number) {
    setTeethZone((prev) => {
      const newW = Math.max(0.15, Math.min(0.9, prev.w + delta));
      const newH = Math.max(0.04, Math.min(0.35, prev.h + delta * 0.25));
      const next = { ...prev, w: newW, h: newH };
      teethZoneRef.current = next;
      return next;
    });
  }

  async function takePhoto() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      setCapturedPhoto(photo.uri);
      setApplied(false);
      teethZoneRef.current = DEFAULT_ZONE;
      setTeethZone(DEFAULT_ZONE);
    } catch {
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
        <View
          style={[
            styles.header,
            {
              paddingTop:
                Platform.OS === "web" ? 67 + 8 : insets.top + 8,
            },
          ]}
        >
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </Pressable>
          <Text style={styles.headerTitle}>Smile Preview</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.permissionContainer}>
          <Ionicons
            name="camera-outline"
            size={64}
            color="rgba(255,255,255,0.3)"
          />
          <Text style={styles.permissionTitle}>Camera Access Needed</Text>
          <Text style={styles.permissionText}>
            To use Smile Preview, please allow camera access. This lets you
            take a photo and preview teeth whitening effects.
          </Text>
          <Pressable
            onPress={requestPermission}
            style={({ pressed }) => [
              styles.permissionBtn,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={styles.permissionBtnText}>Allow Camera</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (capturedPhoto) {
    const { zW, zH, zL, zT, imgW, imgH } = zonePixels;
    const showZone = imgW > 0 && imgH > 0;

    return (
      <View style={styles.container}>
        <View
          style={[
            styles.header,
            {
              paddingTop:
                Platform.OS === "web" ? 67 + 8 : insets.top + 8,
            },
          ]}
        >
          <Pressable
            onPress={() => setCapturedPhoto(null)}
            style={styles.backBtn}
          >
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </Pressable>
          <Text style={styles.headerTitle}>Preview</Text>
          <View style={{ width: 40 }} />
        </View>

        <View
          style={styles.photoContainer}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            imgLayoutRef.current = { width, height };
            setImgLayout({ width, height });
          }}
        >
          <Image
            source={{ uri: capturedPhoto }}
            style={styles.capturedImage}
            resizeMode="cover"
          />

          {showZone && effectOn && (
            <View
              style={{
                position: "absolute",
                left: zL,
                top: zT,
                width: zW,
                height: zH,
                borderRadius: zH / 2,
                overflow: "hidden",
              }}
              pointerEvents="none"
            >
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: selectedShade,
                  opacity: whitenIntensity,
                }}
              />
            </View>
          )}

          {showZone && symmetryOn && (
            <View
              style={{
                position: "absolute",
                left: zL + zW / 2,
                top: zT,
                width: zW / 2,
                height: zH,
                borderTopRightRadius: zH / 2,
                borderBottomRightRadius: zH / 2,
                overflow: "hidden",
              }}
              pointerEvents="none"
            >
              <Image
                source={{ uri: capturedPhoto }}
                style={{
                  position: "absolute",
                  width: imgW,
                  height: imgH,
                  left: -(zL + zW / 2),
                  top: -zT,
                  transform: [{ scaleX: -1 }],
                  opacity: 0.5,
                }}
                resizeMode="cover"
              />
            </View>
          )}

          {showZone && !applied && (
            <View
              {...panResponder.panHandlers}
              style={{
                position: "absolute",
                left: zL - 12,
                top: zT - 12,
                width: zW + 24,
                height: zH + 24,
                borderRadius: (zH + 24) / 2,
                borderWidth: 1.5,
                borderColor:
                  effectOn || symmetryOn
                    ? "rgba(255,255,255,0.2)"
                    : "rgba(255,255,255,0.25)",
                borderStyle: "dashed",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {!effectOn && !symmetryOn && (
                <View
                  style={{
                    position: "absolute",
                    top: -22,
                    backgroundColor: "rgba(0,0,0,0.55)",
                    borderRadius: 8,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                  }}
                >
                  <Text
                    style={{
                      color: "rgba(255,255,255,0.7)",
                      fontSize: 10,
                      fontFamily: "Inter_500Medium",
                    }}
                  >
                    Drag to position over teeth
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>

        <View
          style={[
            styles.controls,
            {
              paddingBottom:
                Platform.OS === "web"
                  ? 34 + 12
                  : Math.max(insets.bottom, 16) + 12,
            },
          ]}
        >
          {!applied && (
            <>
              <View style={styles.controlRow}>
                <Text style={styles.controlLabel}>Zone</Text>
                <Pressable
                  onPress={() => adjustZoneSize(-0.06)}
                  style={({ pressed }) => [
                    styles.sizeBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Ionicons name="remove" size={16} color="#FFF" />
                </Pressable>
                <Pressable
                  onPress={() => adjustZoneSize(0.06)}
                  style={({ pressed }) => [
                    styles.sizeBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Ionicons name="add" size={16} color="#FFF" />
                </Pressable>
                <Pressable
                  onPress={() => {
                    teethZoneRef.current = DEFAULT_ZONE;
                    setTeethZone(DEFAULT_ZONE);
                  }}
                  style={({ pressed }) => [
                    styles.resetBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.resetBtnText}>Reset</Text>
                </Pressable>
              </View>

              <View style={styles.controlRow}>
                <Text style={styles.controlLabel}>Intensity</Text>
                <View style={styles.intensityRow}>
                  {INTENSITY_LEVELS.map((level) => (
                    <Pressable
                      key={level.label}
                      onPress={() => setWhitenIntensity(level.value)}
                      style={[
                        styles.intensityBtn,
                        whitenIntensity === level.value &&
                          styles.intensityBtnActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.intensityBtnText,
                          whitenIntensity === level.value &&
                            styles.intensityBtnTextActive,
                        ]}
                      >
                        {level.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.controlRow}>
                <Text style={styles.controlLabel}>Shade</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flex: 1 }}
                  contentContainerStyle={{ gap: 8, paddingRight: 8 }}
                >
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
            </>
          )}

          <View style={styles.btnRow}>
            {!applied ? (
              <>
                <Pressable
                  onPress={() => setEffectOn(!effectOn)}
                  style={({ pressed }) => [
                    styles.btn,
                    effectOn ? styles.btnActive : styles.btnInactive,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Text style={styles.btnText}>
                    {effectOn ? "Whiten" : "Whiten"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setSymmetryOn(!symmetryOn)}
                  style={({ pressed }) => [
                    styles.btn,
                    symmetryOn ? styles.btnSymmetryActive : styles.btnInactive,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Ionicons
                    name="git-compare-outline"
                    size={15}
                    color="#FFF"
                    style={{ marginRight: 4 }}
                  />
                  <Text style={styles.btnText}>Symmetry</Text>
                </Pressable>
                {(effectOn || symmetryOn) && (
                  <Pressable
                    onPress={() => setApplied(true)}
                    style={({ pressed }) => [
                      styles.btn,
                      { backgroundColor: "#10B981" },
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    <Ionicons name="checkmark-circle" size={16} color="#FFF" style={{ marginRight: 4 }} />
                    <Text style={styles.btnText}>Apply</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => setCapturedPhoto(null)}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnRetake,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Ionicons name="camera-reverse-outline" size={16} color="#FFF" />
                  <Text style={styles.btnText}>Retake</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  onPress={() => setApplied(false)}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnInactive,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Ionicons name="create-outline" size={16} color="#FFF" style={{ marginRight: 4 }} />
                  <Text style={styles.btnText}>Edit</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setApplied(false); setCapturedPhoto(null); }}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnRetake,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Ionicons name="camera-reverse-outline" size={16} color="#FFF" />
                  <Text style={styles.btnText}>Retake</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.header,
          {
            paddingTop:
              Platform.OS === "web" ? 67 + 8 : insets.top + 8,
          },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </Pressable>
        <Text style={styles.headerTitle}>Smile Preview</Text>
        <Pressable
          onPress={() =>
            setFacing((f) => (f === "front" ? "back" : "front"))
          }
          style={styles.backBtn}
        >
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
          <Text style={styles.guideText}>
            Position face within the guide
          </Text>
        </View>
      </View>

      <View
        style={[
          styles.captureBar,
          {
            paddingBottom:
              Platform.OS === "web"
                ? 34 + 16
                : Math.max(insets.bottom, 16) + 16,
          },
        ]}
      >
        <Text style={styles.captureHint}>
          Take a photo to preview teeth whitening
        </Text>
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
    overflow: "hidden",
  },
  capturedImage: {
    flex: 1,
    width: "100%",
  },
  controls: {
    backgroundColor: "rgba(0,0,0,0.92)",
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 12,
  },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  controlLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.8)",
    minWidth: 58,
  },
  intensityRow: {
    flexDirection: "row" as const,
    gap: 6,
    flex: 1,
  },
  intensityBtn: {
    flex: 1,
    paddingVertical: 7,
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
  sizeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  resetBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginLeft: 4,
  },
  resetBtnText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.6)",
  },
  btnRow: {
    flexDirection: "row" as const,
    gap: 8,
    justifyContent: "center" as const,
    marginTop: 2,
  },
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 22,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
  },
  btnActive: {
    backgroundColor: "#10B981",
  },
  btnSymmetryActive: {
    backgroundColor: "#7C3AED",
  },
  btnInactive: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  btnRetake: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  btnText: {
    color: "#FFF",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});
