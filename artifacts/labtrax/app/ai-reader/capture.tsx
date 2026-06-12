import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions, type FlashMode } from "expo-camera";
import { Accelerometer } from "expo-sensors";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import {
  clearAiReaderSession,
  setAiReaderSession,
  getAiReaderSession,
  type CapturedPage,
} from "@/lib/ai-reader-store";

const MAX_PAGES = 6;

// Accelerometer steadiness thresholds for the auto-shutter heuristic.
// When device acceleration magnitude stays below STEADY_THRESHOLD for
// STEADY_SAMPLES consecutive readings, the document is considered stable
// and the shutter fires automatically.
const STEADY_THRESHOLD = 0.08; // g-force delta from 1g (gravity)
const STEADY_SAMPLES = 6;      // ~600 ms at 10 Hz
const ACCEL_INTERVAL_MS = 100; // sample every 100 ms

export default function AiReaderCaptureScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // `new=1` is passed by the dashboard "Scan Rx" button to signal a brand-new
  // session. Without it (e.g. navigating back from review to add more pages)
  // we keep the existing session untouched.
  const { new: isNew, retake } = useLocalSearchParams<{ new?: string; retake?: string }>();
  const retakeIndex = retake !== undefined ? parseInt(retake, 10) : null;
  const isRetakeMode = retakeIndex !== null && !isNaN(retakeIndex);

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [pages, setPages] = useState<CapturedPage[]>(() => {
    if (isNew === "1") {
      clearAiReaderSession();
      return [];
    }
    return getAiReaderSession().pages;
  });
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState<FlashMode>("off");

  // Auto-shutter: OFF by default. When ON, the Accelerometer is sampled to
  // detect when the device is steady (document in frame). Fire once the
  // device has been still for STEADY_SAMPLES consecutive readings.
  // Default OFF is required — must be explicitly enabled by the user.
  const [autoShutter, setAutoShutter] = useState(false);
  // steadyCount tracks consecutive steady readings
  const steadyCountRef = useRef(0);
  const accelSubRef = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);
  // Prevent double-fire while one capture is in flight
  const autoFiringRef = useRef(false);

  const retakeLabel = isRetakeMode ? `Retake page ${(retakeIndex as number) + 1}` : null;

  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, []);

  // Accelerometer-based steadiness heuristic for auto-shutter
  useEffect(() => {
    if (!autoShutter || isRetakeMode || capturing) {
      stopAccelerometer();
      return;
    }
    if (pages.length >= MAX_PAGES) {
      setAutoShutter(false);
      return;
    }
    startAccelerometer();
    return stopAccelerometer;
  }, [autoShutter, isRetakeMode, pages.length, capturing]);

  function startAccelerometer() {
    steadyCountRef.current = 0;
    autoFiringRef.current = false;
    Accelerometer.setUpdateInterval(ACCEL_INTERVAL_MS);
    accelSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
      if (autoFiringRef.current) return;
      // Magnitude of total acceleration; subtract 1g (gravity) to get net motion
      const mag = Math.abs(Math.sqrt(x * x + y * y + z * z) - 1);
      if (mag < STEADY_THRESHOLD) {
        steadyCountRef.current += 1;
        if (steadyCountRef.current >= STEADY_SAMPLES) {
          // Device has been steady long enough — fire the shutter
          autoFiringRef.current = true;
          capture();
        }
      } else {
        // Motion detected — reset steady counter
        steadyCountRef.current = 0;
      }
    });
  }

  function stopAccelerometer() {
    accelSubRef.current?.remove();
    accelSubRef.current = null;
    steadyCountRef.current = 0;
    autoFiringRef.current = false;
  }

  function toggleAutoShutter() {
    setAutoShutter((prev) => {
      if (prev) stopAccelerometer();
      return !prev;
    });
  }

  function goBack() {
    stopAccelerometer();
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/dashboard" as never);
  }

  const capture = useCallback(async () => {
    if (!cameraRef.current || capturing) return;
    if (!isRetakeMode && pages.length >= MAX_PAGES) return;
    stopAccelerometer();
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.85,
        exif: false,
        skipProcessing: Platform.OS === "android",
      });
      if (!photo?.base64) {
        Alert.alert("Capture failed", "Could not read photo data. Please try again.");
        return;
      }
      const page: CapturedPage = {
        uri: photo.uri,
        base64: photo.base64.startsWith("data:") ? photo.base64 : `data:image/jpeg;base64,${photo.base64}`,
      };

      if (isRetakeMode && retakeIndex !== null && !isNaN(retakeIndex)) {
        const updated = [...pages];
        updated[retakeIndex] = page;
        setAiReaderSession({ pages: updated });
        router.back();
      } else {
        const updated = [...pages, page];
        setPages(updated);
        setAiReaderSession({ pages: updated });
        // Restart accelerometer subscription if auto-shutter remains on
        if (autoShutter && updated.length < MAX_PAGES) {
          setTimeout(() => {
            autoFiringRef.current = false;
            startAccelerometer();
          }, 800); // brief pause after capture before re-arming
        } else {
          setAutoShutter(false);
        }
      }
    } catch (e) {
      Alert.alert("Capture failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setCapturing(false);
    }
  }, [capturing, pages, isRetakeMode, retakeIndex, autoShutter]);

  function retakeThumbnail(index: number) {
    stopAccelerometer();
    router.push(`/ai-reader/capture?retake=${index}` as never);
  }

  function removeLast() {
    setPages((prev) => {
      const next = prev.slice(0, -1);
      setAiReaderSession({ pages: next });
      return next;
    });
  }

  function proceed() {
    if (pages.length === 0) return;
    stopAccelerometer();
    setAiReaderSession({ pages });
    router.push("/ai-reader/review" as never);
  }

  function toggleFlash() {
    setFlash((f) => (f === "off" ? "on" : "off"));
  }

  if (!permission) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top + Spacing.xl }]}>
        <Ionicons name="camera-outline" size={48} color={colors.textTertiary} />
        <Text style={[styles.permTitle, { marginTop: Spacing.lg }]}>Camera access needed</Text>
        <Text style={styles.permBody}>LabTrax needs camera access to scan prescriptions.</Text>
        <Pressable style={[styles.btn, { marginTop: Spacing.xl }]} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant access</Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} onPress={goBack}>
          <Text style={styles.ghostBtnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const autoReady = autoShutter && !isRetakeMode;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable onPress={goBack} style={styles.topBtn} hitSlop={8}>
          <Ionicons name={isRetakeMode ? "arrow-back" : "close"} size={26} color="#fff" />
        </Pressable>
        <Text style={styles.topTitle}>{retakeLabel ?? "Scan Rx"}</Text>
        <View style={styles.topRightGroup}>
          {/* Auto-shutter toggle — default OFF.
              Uses device accelerometer steadiness as a document-detection heuristic. */}
          {!isRetakeMode && (
            <Pressable
              onPress={toggleAutoShutter}
              style={[styles.topBtn, autoShutter && styles.topBtnActive]}
              hitSlop={8}
              accessibilityLabel={
                autoShutter
                  ? "Auto-shutter on — fires when camera is steady"
                  : "Auto-shutter off — tap to enable"
              }
            >
              <Ionicons
                name={autoShutter ? "timer" : "timer-outline"}
                size={22}
                color={autoShutter ? colors.tint : "#fff"}
              />
            </Pressable>
          )}
          <Pressable onPress={toggleFlash} style={styles.topBtn} hitSlop={8}>
            <Ionicons name={flash === "on" ? "flash" : "flash-off"} size={22} color="#fff" />
          </Pressable>
        </View>
      </View>

      {/* Camera viewfinder */}
      <View style={styles.viewfinder}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          flash={flash}
        />
        {/* Corner guides */}
        <View style={styles.cornerTL} />
        <View style={styles.cornerTR} />
        <View style={styles.cornerBL} />
        <View style={styles.cornerBR} />
        {/* Auto-shutter armed indicator */}
        {autoReady && !capturing && (
          <View style={styles.autoArmedBadge} pointerEvents="none">
            <Ionicons name="radio-button-on" size={10} color={colors.tint} />
            <Text style={styles.autoArmedText}>Auto — hold steady</Text>
          </View>
        )}
        {/* Capturing overlay */}
        {capturing && autoReady && (
          <View style={styles.capturingOverlay} pointerEvents="none">
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.capturingText}>Capturing…</Text>
          </View>
        )}
      </View>

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.lg }]}>
        {/* Thumbnail tray — tap any thumb to retake that page */}
        {!isRetakeMode && pages.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbStrip}
            style={{ marginBottom: Spacing.md }}
          >
            {pages.map((p, i) => (
              <Pressable
                key={i}
                style={styles.thumbWrap}
                onPress={() => retakeThumbnail(i)}
                accessibilityLabel={`Tap to retake page ${i + 1}`}
              >
                <Image source={{ uri: p.uri }} style={styles.thumb} resizeMode="cover" />
                <View style={styles.thumbBadge}>
                  <Text style={styles.thumbBadgeText}>{i + 1}</Text>
                </View>
                <View style={styles.thumbRetakeHint}>
                  <Ionicons name="camera-outline" size={12} color="#fff" />
                </View>
              </Pressable>
            ))}
            <Pressable style={styles.removeBtn} onPress={removeLast} hitSlop={4}>
              <Ionicons name="trash-outline" size={18} color="#fff" />
              <Text style={styles.removeBtnText}>Remove last</Text>
            </Pressable>
          </ScrollView>
        )}

        <View style={styles.shutterRow}>
          {/* Page count / hint */}
          <View style={styles.sideHint}>
            {isRetakeMode ? (
              <Text style={styles.pageCount}>Retake</Text>
            ) : pages.length > 0 ? (
              <Text style={styles.pageCount}>{pages.length}/{MAX_PAGES}</Text>
            ) : (
              <Text style={styles.hintText}>Tap to{"\n"}capture</Text>
            )}
          </View>

          {/* Shutter */}
          <Pressable
            style={[
              styles.shutter,
              (capturing || (!isRetakeMode && pages.length >= MAX_PAGES)) && styles.shutterDisabled,
            ]}
            onPress={capture}
            disabled={capturing || (!isRetakeMode && pages.length >= MAX_PAGES)}
          >
            {capturing ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <View style={[styles.shutterInner, autoReady && styles.shutterInnerAuto]} />
            )}
          </Pressable>

          {/* Done / next */}
          <View style={styles.sideAction}>
            {!isRetakeMode && pages.length > 0 ? (
              <Pressable style={styles.doneBtn} onPress={proceed}>
                <Text style={styles.doneBtnText}>Next</Text>
                <Ionicons name="arrow-forward" size={16} color="#fff" />
              </Pressable>
            ) : null}
          </View>
        </View>

        <Text style={styles.footerHint}>
          {isRetakeMode
            ? "Photograph this page again"
            : pages.length === 0
              ? autoReady
                ? "Hold steady — auto-captures when stable"
                : "Photograph each page of the Rx"
              : pages.length >= MAX_PAGES
                ? "Max pages reached — tap Next"
                : autoReady
                  ? "Hold steady — auto-captures when stable"
                  : "Tap thumb to retake · Add pages or tap Next"}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: "#000" },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl },

    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      zIndex: 10,
    },
    topBtn: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 20,
    },
    topBtnActive: { backgroundColor: "rgba(255,255,255,0.15)" },
    topTitle: { ...Typography.bodySemibold, color: "#fff" },
    topRightGroup: { flexDirection: "row", alignItems: "center" },

    viewfinder: { flex: 1, position: "relative" },

    cornerTL: { position: "absolute", top: 24, left: 24, width: 28, height: 28, borderTopWidth: 3, borderLeftWidth: 3, borderColor: "#fff", borderRadius: 4 },
    cornerTR: { position: "absolute", top: 24, right: 24, width: 28, height: 28, borderTopWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderRadius: 4 },
    cornerBL: { position: "absolute", bottom: 24, left: 24, width: 28, height: 28, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: "#fff", borderRadius: 4 },
    cornerBR: { position: "absolute", bottom: 24, right: 24, width: 28, height: 28, borderBottomWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderRadius: 4 },

    autoArmedBadge: {
      position: "absolute",
      top: Spacing.md,
      right: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: "rgba(0,0,0,0.55)",
      paddingHorizontal: Spacing.sm,
      paddingVertical: 4,
      borderRadius: Radius.full,
    },
    autoArmedText: { ...Typography.captionMedium, color: "#fff" },

    capturingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    capturingText: { ...Typography.bodySemibold, color: "#fff" },

    bottomBar: {
      backgroundColor: "rgba(0,0,0,0.85)",
      paddingTop: Spacing.md,
      paddingHorizontal: Spacing.lg,
    },

    thumbStrip: { paddingHorizontal: 4, gap: Spacing.sm, alignItems: "center" },
    thumbWrap: { position: "relative" },
    thumb: { width: 52, height: 72, borderRadius: Radius.sm, borderWidth: 2, borderColor: "#fff" },
    thumbBadge: {
      position: "absolute",
      top: 2,
      right: 2,
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: c.tint,
      alignItems: "center",
      justifyContent: "center",
    },
    thumbBadgeText: { ...Typography.tiny, color: "#fff" },
    thumbRetakeHint: {
      position: "absolute",
      bottom: 2,
      left: 0,
      right: 0,
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.5)",
      borderBottomLeftRadius: Radius.sm,
      borderBottomRightRadius: Radius.sm,
      paddingVertical: 2,
    },
    removeBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      backgroundColor: "rgba(255,59,48,0.8)",
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      marginLeft: Spacing.xs,
    },
    removeBtnText: { ...Typography.captionMedium, color: "#fff" },

    shutterRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.sm,
    },
    sideHint: { width: 72, alignItems: "flex-start" },
    pageCount: { ...Typography.bodySemibold, color: "#fff" },
    hintText: { ...Typography.captionMedium, color: "rgba(255,255,255,0.6)", textAlign: "center" },

    shutter: {
      width: 70,
      height: 70,
      borderRadius: 35,
      backgroundColor: "#fff",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 4,
      borderColor: "rgba(255,255,255,0.4)",
    },
    shutterDisabled: { opacity: 0.4 },
    shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff" },
    shutterInnerAuto: { backgroundColor: c.tint },

    sideAction: { width: 72, alignItems: "flex-end" },
    doneBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      backgroundColor: c.tint,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
    },
    doneBtnText: { ...Typography.bodySemibold, color: "#fff" },

    footerHint: {
      ...Typography.caption,
      color: "rgba(255,255,255,0.5)",
      textAlign: "center",
      marginBottom: Spacing.sm,
    },

    permTitle: { ...Typography.h2, color: c.text, textAlign: "center" },
    permBody: { ...Typography.body, color: c.textSecondary, textAlign: "center", marginTop: Spacing.sm },
    btn: { backgroundColor: c.tint, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, borderRadius: Radius.md },
    btnText: { ...Typography.bodySemibold, color: "#fff" },
    ghostBtn: { marginTop: Spacing.md, paddingVertical: Spacing.sm },
    ghostBtnText: { ...Typography.body, color: c.tint },
  });
}
