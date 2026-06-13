import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import {
  clearAiReaderSession,
  setAiReaderSession,
  getAiReaderSession,
  type CapturedPage,
} from "@/lib/ai-reader-store";

const MAX_PAGES = 6;

// Diagnostic checkpoint — fires when Metro loads this module.
// If the app crashes before this line appears in device logs,
// the crash is in a static import above (expo-camera was here previously).
console.log("[AiReader/capture] Module loaded — no static native-module imports");

export default function AiReaderCaptureScreen() {
  console.log("[AiReader/capture] Component function entered");
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  console.log("[AiReader/capture] useTheme OK");
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { new: isNew, retake } = useLocalSearchParams<{ new?: string; retake?: string }>();
  const retakeIndex = retake !== undefined ? parseInt(retake, 10) : null;
  const isRetakeMode = retakeIndex !== null && !isNaN(retakeIndex);

  const [pages, setPages] = useState<CapturedPage[]>(() => {
    if (isNew === "1") {
      clearAiReaderSession();
      return [];
    }
    return getAiReaderSession().pages;
  });
  const [scanning, setScanning] = useState(false);
  const hasLaunchedRef = useRef(false);

  // Re-sync pages from session store when returning from a URL-param retake
  // (e.g. coming back from /ai-reader/capture?retake=N launched by review screen).
  useFocusEffect(
    useCallback(() => {
      const stored = getAiReaderSession().pages;
      setPages(stored);
    }, []),
  );

  // Auto-launch the native scanner on first mount.
  useEffect(() => {
    if (hasLaunchedRef.current) return;
    hasLaunchedRef.current = true;
    void launchScanner({});
  }, []);

  /**
   * Opens the device's native document scanner.
   *
   * On iOS  — VisionKit (VNDocumentCameraViewController): live blue-border document
   *            detection, auto-capture when the document is held steady, perspective
   *            correction applied automatically.  Identical to OneDrive / Apple Notes.
   * On Android — Google ML Kit Document Scanner with the same detection behaviour.
   *
   * @param retakeAt  When set, replaces the page at that index rather than appending.
   */
  async function launchScanner({ retakeAt }: { retakeAt?: number } = {}) {
    if (scanning) return;
    setScanning(true);
    try {
      const [
        { default: DocumentScanner, ResponseType, ScanDocumentResponseStatus },
        FileSystem,
      ] = await Promise.all([
        import("react-native-document-scanner-plugin"),
        import("expo-file-system/legacy"),
      ]);

      const { scannedImages, status } = await DocumentScanner.scanDocument({
        croppedImageQuality: 85,
        responseType: ResponseType.ImageFilePath,
        ...(retakeAt !== undefined ? { maxNumDocuments: 1 } : {}),
      });

      if (status === ScanDocumentResponseStatus.Cancel || !scannedImages?.length) {
        // User cancelled the native scanner.
        if (pages.length === 0 && !isRetakeMode) {
          goBack();
        }
        return;
      }

      // Convert file paths → base64 so downstream AI analysis has what it needs.
      const newPages: CapturedPage[] = await Promise.all(
        scannedImages.map(async (filePath) => {
          const base64 = await FileSystem.readAsStringAsync(filePath, {
            encoding: "base64",
          });
          return { uri: filePath, base64 };
        }),
      );

      if (isRetakeMode && retakeIndex !== null) {
        // Launched via URL param (review screen → /ai-reader/capture?retake=N).
        setPages((prev) => {
          const next = [...prev];
          next[retakeIndex] = newPages[0];
          setAiReaderSession({ pages: next });
          return next;
        });
        if (router.canGoBack()) router.back();
        return;
      }

      if (retakeAt !== undefined) {
        // Inline retake from the thumbnail tray.
        setPages((prev) => {
          const next = [...prev];
          next[retakeAt] = newPages[0];
          setAiReaderSession({ pages: next });
          return next;
        });
        return;
      }

      // Normal append — clamp to MAX_PAGES.
      setPages((prev) => {
        const combined = [...prev, ...newPages].slice(0, MAX_PAGES);
        setAiReaderSession({ pages: combined });
        return combined;
      });
    } catch (e) {
      Alert.alert(
        "Scanner error",
        e instanceof Error ? e.message : "Could not open the document scanner. Please try again.",
      );
      if (pages.length === 0 && !isRetakeMode) goBack();
    } finally {
      setScanning(false);
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/dashboard" as never);
  }

  function proceed() {
    if (pages.length === 0) return;
    setAiReaderSession({ pages });
    router.push("/ai-reader/review" as never);
  }

  function removeLast() {
    setPages((prev) => {
      const next = prev.slice(0, -1);
      setAiReaderSession({ pages: next });
      return next;
    });
  }

  // ── Loading state: scanner is launching, no pages yet ─────────────────────
  if (scanning && pages.length === 0) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={[styles.footerHint, { marginTop: Spacing.lg }]}>Opening scanner…</Text>
      </View>
    );
  }

  // ── Main screen ────────────────────────────────────────────────────────────
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable onPress={goBack} style={styles.topBtn} hitSlop={8}>
          <Ionicons name={isRetakeMode ? "arrow-back" : "close"} size={26} color="#fff" />
        </Pressable>
        <Text style={styles.topTitle}>
          {isRetakeMode ? `Retake page ${(retakeIndex as number) + 1}` : "Scan Rx"}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Pages area */}
      <View style={styles.pagesArea}>
        {pages.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="scan-outline" size={64} color="rgba(255,255,255,0.25)" />
            <Text style={styles.emptyTitle}>Ready to scan</Text>
            <Text style={styles.emptyBody}>
              The scanner detects document edges automatically and highlights them in blue —
              just like OneDrive. Tap the button below to begin.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.thumbGrid}
            showsVerticalScrollIndicator={false}
          >
            {pages.map((p, i) => (
              <Pressable
                key={i}
                style={styles.thumbWrap}
                onPress={() => void launchScanner({ retakeAt: i })}
                disabled={scanning}
                accessibilityLabel={`Page ${i + 1} — tap to retake`}
              >
                <Image source={{ uri: p.uri }} style={styles.thumb} resizeMode="cover" />
                <View style={styles.thumbBadge}>
                  <Text style={styles.thumbBadgeText}>{i + 1}</Text>
                </View>
                <View style={styles.thumbRetakeHint}>
                  <Ionicons name="camera-outline" size={13} color="#fff" />
                  <Text style={styles.thumbRetakeText}>Retake</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.lg }]}>
        {/* Page count + remove last */}
        {pages.length > 0 && (
          <View style={styles.pageCountRow}>
            <Text style={styles.pageCountText}>
              {pages.length} of {MAX_PAGES} page{pages.length !== 1 ? "s" : ""} scanned
            </Text>
            {pages.length > 1 && (
              <Pressable style={styles.removeLast} onPress={removeLast} hitSlop={8} disabled={scanning}>
                <Ionicons name="trash-outline" size={13} color="rgba(255,255,255,0.55)" />
                <Text style={styles.removeLastText}>Remove last</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Action row: Scan + Next */}
        <View style={styles.actionRow}>
          {pages.length < MAX_PAGES && (
            <Pressable
              style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
              onPress={() => void launchScanner({})}
              disabled={scanning}
            >
              {scanning ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="scan" size={20} color="#fff" />
                  <Text style={styles.scanBtnText}>
                    {pages.length === 0 ? "Scan document" : "Scan more pages"}
                  </Text>
                </>
              )}
            </Pressable>
          )}

          {pages.length > 0 && (
            <Pressable
              style={[styles.nextBtn, scanning && styles.nextBtnDisabled]}
              onPress={proceed}
              disabled={scanning}
            >
              <Text style={styles.nextBtnText}>Next</Text>
              <Ionicons name="arrow-forward" size={16} color="#fff" />
            </Pressable>
          )}
        </View>

        <Text style={styles.footerHint}>
          {pages.length === 0
            ? "Point the camera at the Rx — borders are detected automatically"
            : pages.length >= MAX_PAGES
              ? "Max pages reached — tap Next to continue"
              : "Tap a page thumbnail to retake it, or scan more pages"}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: "#000" },
    center: { alignItems: "center", justifyContent: "center" },

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
    topTitle: { ...Typography.bodySemibold, color: "#fff" },

    pagesArea: { flex: 1 },

    emptyState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.xl,
      gap: Spacing.md,
    },
    emptyTitle: { ...Typography.h3, color: "rgba(255,255,255,0.7)", textAlign: "center" },
    emptyBody: {
      ...Typography.body,
      color: "rgba(255,255,255,0.4)",
      textAlign: "center",
      lineHeight: 22,
    },

    thumbGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    thumbWrap: { position: "relative" },
    thumb: {
      width: 100,
      height: 140,
      borderRadius: Radius.sm,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.3)",
    },
    thumbBadge: {
      position: "absolute",
      top: 4,
      right: 4,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.tint,
      alignItems: "center",
      justifyContent: "center",
    },
    thumbBadgeText: { ...Typography.tiny, color: "#fff", fontWeight: "700" },
    thumbRetakeHint: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      backgroundColor: "rgba(0,0,0,0.6)",
      borderBottomLeftRadius: Radius.sm,
      borderBottomRightRadius: Radius.sm,
      paddingVertical: 5,
    },
    thumbRetakeText: { ...Typography.tiny, color: "#fff" },

    bottomBar: {
      backgroundColor: "rgba(0,0,0,0.85)",
      paddingTop: Spacing.md,
      paddingHorizontal: Spacing.lg,
    },

    pageCountRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.sm,
    },
    pageCountText: { ...Typography.captionMedium, color: "rgba(255,255,255,0.6)" },
    removeLast: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    removeLastText: { ...Typography.caption, color: "rgba(255,255,255,0.5)" },

    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      marginBottom: Spacing.sm,
    },
    scanBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: c.tint,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
    },
    scanBtnDisabled: { opacity: 0.5 },
    scanBtnText: { ...Typography.bodySemibold, color: "#fff" },

    nextBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      backgroundColor: "rgba(255,255,255,0.15)",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.25)",
    },
    nextBtnDisabled: { opacity: 0.5 },
    nextBtnText: { ...Typography.bodySemibold, color: "#fff" },

    footerHint: {
      ...Typography.caption,
      color: "rgba(255,255,255,0.4)",
      textAlign: "center",
      marginBottom: Spacing.sm,
    },

    permTitle: { ...Typography.h2, color: c.text, textAlign: "center" },
    permBody: {
      ...Typography.body,
      color: c.textSecondary,
      textAlign: "center",
      marginTop: Spacing.sm,
    },
  });
}
