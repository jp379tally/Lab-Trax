import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch } from "@/lib/query-client";
import {
  getAiReaderSession,
  setAiReaderSession,
  type CapturedPage,
  type ExtractedRx,
} from "@/lib/ai-reader-store";

export default function AiReaderReviewScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [pages, setPages] = useState<CapturedPage[]>(() => getAiReaderSession().pages);
  const [processing, setProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Drag-to-reorder state: long-press selects a page, tap another to swap.
  // This gives clear visual drag feedback without external dependencies.
  const [dragSource, setDragSource] = useState<number | null>(null);
  // Animated scale for the selected item
  const scaleAnims = useRef<Animated.Value[]>([]);
  while (scaleAnims.current.length < pages.length) {
    scaleAnims.current.push(new Animated.Value(1));
  }

  function getScale(i: number): Animated.Value {
    if (!scaleAnims.current[i]) scaleAnims.current[i] = new Animated.Value(1);
    return scaleAnims.current[i];
  }

  function animatePick(i: number) {
    Animated.spring(getScale(i), { toValue: 0.93, useNativeDriver: true, speed: 30 }).start();
  }

  function animateRelease(i: number) {
    Animated.spring(getScale(i), { toValue: 1, useNativeDriver: true, speed: 20 }).start();
  }

  function handleLongPress(index: number) {
    if (dragSource === index) {
      // Deselect
      animateRelease(index);
      setDragSource(null);
    } else {
      if (dragSource !== null) animateRelease(dragSource);
      setDragSource(index);
      animatePick(index);
    }
  }

  function handleThumbnailPress(index: number) {
    if (dragSource !== null && dragSource !== index) {
      // Swap the two pages
      swapPages(dragSource, index);
      animateRelease(dragSource);
      setDragSource(null);
    } else if (dragSource === index) {
      // Tap selected item again — deselect
      animateRelease(index);
      setDragSource(null);
    } else {
      // Normal tap when no drag in progress — navigate to retake
      retakePage(index);
    }
  }

  function swapPages(a: number, b: number) {
    setPages((prev) => {
      const next = [...prev];
      [next[a], next[b]] = [next[b], next[a]];
      setAiReaderSession({ pages: next });
      return next;
    });
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.push("/ai-reader/capture" as never);
  }

  function removePage(index: number) {
    if (dragSource === index) { setDragSource(null); }
    setPages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setAiReaderSession({ pages: next });
      scaleAnims.current.splice(index, 1);
      return next;
    });
  }

  function retakePage(index: number) {
    if (dragSource !== null) { animateRelease(dragSource); setDragSource(null); }
    router.push(`/ai-reader/capture?retake=${index}` as never);
  }

  function movePage(index: number, direction: "up" | "down") {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= pages.length) return;
    setPages((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      setAiReaderSession({ pages: next });
      return next;
    });
  }

  function addPage() {
    router.push("/ai-reader/capture" as never);
  }

  const processPages = useCallback(async () => {
    if (pages.length === 0 || processing) return;
    if (dragSource !== null) { animateRelease(dragSource); setDragSource(null); }
    setProcessing(true);
    setErrorMsg(null);
    try {
      const [primary, ...rest] = pages;
      const body: Record<string, unknown> = { imageBase64: primary.base64 };
      if (rest.length > 0) body.additionalImages = rest.map((p) => p.base64);

      const res = await resilientFetch("/api/analyze-prescription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 503) {
        setErrorMsg("AI is not configured on this server. Ask your administrator to enable it.");
        return;
      }

      const data = (await res.json()) as {
        success?: boolean;
        data?: Partial<ExtractedRx>;
        error?: string;
      };

      if (!data.success || !data.data) {
        const msg = data.error ?? "AI could not read the prescription. Please retake the photos.";
        setErrorMsg(
          msg === "IMAGE_TOO_SMALL"
            ? "The photos appear too small or out of focus. Please retake them with better lighting."
            : msg,
        );
        return;
      }

      const extracted: ExtractedRx = {
        doctorName: data.data.doctorName ?? null,
        patientName: data.data.patientName ?? null,
        patientInitials: data.data.patientInitials ?? null,
        caseType: data.data.caseType ?? null,
        toothIndices: data.data.toothIndices ?? null,
        shade: data.data.shade ?? null,
        material: data.data.material ?? null,
        dueDate: data.data.dueDate ?? null,
        isRush: data.data.isRush ?? null,
        notes: data.data.notes ?? null,
        practiceName: data.data.practiceName ?? null,
        practiceAddress: data.data.practiceAddress ?? null,
        practicePhone: data.data.practicePhone ?? null,
        confidence: data.data.confidence ?? null,
      };

      setAiReaderSession({ extracted });
      router.push("/ai-reader/extracted" as never);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Network error. Please check your connection.");
    } finally {
      setProcessing(false);
    }
  }, [pages, processing, dragSource]);

  if (pages.length === 0) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.title}>No pages captured</Text>
        <Pressable style={styles.processBtn} onPress={() => router.replace("/ai-reader/capture?new=1" as never)}>
          <Text style={styles.processBtnText}>Start over</Text>
        </Pressable>
      </View>
    );
  }

  const isDragging = dragSource !== null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={goBack} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.headerTitle}>
          <Text style={styles.title}>Review Pages</Text>
          <Text style={styles.subtitle}>
            {isDragging
              ? "Tap another page to swap order"
              : `${pages.length} page${pages.length !== 1 ? "s" : ""} — tap to retake, hold to reorder`}
          </Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      {/* Drag mode banner */}
      {isDragging && (
        <View style={styles.dragBanner}>
          <Ionicons name="swap-vertical-outline" size={16} color={colors.tint} />
          <Text style={styles.dragBannerText}>
            Page {(dragSource ?? 0) + 1} selected — tap another to swap, or tap again to cancel
          </Text>
        </View>
      )}

      {/* Error banner */}
      {errorMsg && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={18} color={colors.error} />
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}

      {/* Page list */}
      <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        {pages.map((page, i) => {
          const isSelected = dragSource === i;
          const isSwapTarget = isDragging && !isSelected;
          return (
            <Animated.View
              key={i}
              style={[
                styles.pageRow,
                isSelected && styles.pageRowSelected,
                isSwapTarget && styles.pageRowSwapTarget,
                { transform: [{ scale: getScale(i) }] },
              ]}
            >
              {/* Reorder arrows (always visible) */}
              <View style={styles.reorderBtns}>
                <Pressable
                  onPress={() => movePage(i, "up")}
                  disabled={i === 0}
                  style={[styles.reorderBtn, i === 0 && styles.reorderBtnDisabled]}
                  hitSlop={6}
                >
                  <Ionicons name="chevron-up" size={18} color={i === 0 ? colors.textTertiary : colors.text} />
                </Pressable>
                <Text style={styles.pageIndexBadge}>{i + 1}</Text>
                <Pressable
                  onPress={() => movePage(i, "down")}
                  disabled={i === pages.length - 1}
                  style={[styles.reorderBtn, i === pages.length - 1 && styles.reorderBtnDisabled]}
                  hitSlop={6}
                >
                  <Ionicons name="chevron-down" size={18} color={i === pages.length - 1 ? colors.textTertiary : colors.text} />
                </Pressable>
              </View>

              {/* Thumbnail — tap to retake (or swap if in drag mode); long-press to drag */}
              <Pressable
                style={styles.pageThumbBtn}
                onPress={() => handleThumbnailPress(i)}
                onLongPress={() => handleLongPress(i)}
                delayLongPress={350}
                accessibilityLabel={
                  isSelected
                    ? `Page ${i + 1} selected for reorder. Tap another to swap.`
                    : isDragging
                      ? `Tap to move selected page here`
                      : `Page ${i + 1}. Tap to retake, hold to reorder.`
                }
              >
                <Image source={{ uri: page.uri }} style={styles.pageThumb} resizeMode="contain" />
                {/* Visual overlay for drag affordance */}
                {isSelected && (
                  <View style={styles.selectedOverlay}>
                    <Ionicons name="swap-vertical" size={24} color="#fff" />
                  </View>
                )}
                {isSwapTarget && (
                  <View style={styles.swapTargetOverlay} />
                )}
                {!isDragging && (
                  <View style={styles.retakeHintOverlay}>
                    <Ionicons name="camera-outline" size={14} color="#fff" />
                    <Text style={styles.retakeHintText}>Retake</Text>
                  </View>
                )}
              </Pressable>

              {/* Actions column */}
              <View style={styles.pageActions}>
                <Pressable
                  style={[styles.retakeBtn, isDragging && { opacity: 0.4 }]}
                  onPress={() => !isDragging && retakePage(i)}
                  hitSlop={4}
                  disabled={isDragging}
                >
                  <Ionicons name="camera-outline" size={16} color={colors.tint} />
                  <Text style={styles.retakeBtnText}>Retake</Text>
                </Pressable>
                <Pressable
                  style={[styles.deletePageBtn, isDragging && { opacity: 0.4 }]}
                  onPress={() => !isDragging && removePage(i)}
                  hitSlop={4}
                  disabled={isDragging}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                </Pressable>
              </View>
            </Animated.View>
          );
        })}

        {pages.length < 6 && (
          <Pressable style={styles.addPageRow} onPress={addPage}>
            <Ionicons name="add-circle-outline" size={22} color={colors.tint} />
            <Text style={styles.addPageText}>Add another page</Text>
          </Pressable>
        )}
      </ScrollView>

      {/* Bottom action */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.md }]}>
        <View style={styles.confidenceHint}>
          <Ionicons name="sparkles-outline" size={14} color={colors.textTertiary} />
          <Text style={styles.confidenceHintText}>
            AI will extract patient, doctor, teeth, material, and due date from all pages.
          </Text>
        </View>
        <Pressable
          style={[styles.processBtn, (processing || pages.length === 0) && styles.processBtnDisabled]}
          onPress={processPages}
          disabled={processing || pages.length === 0}
          testID="ai-reader-process-btn"
        >
          {processing ? (
            <>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.processBtnText}>Extracting…</Text>
            </>
          ) : (
            <>
              <Ionicons name="sparkles" size={18} color="#fff" />
              <Text style={styles.processBtnText}>Extract with AI</Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.lg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    headerTitle: { flex: 1, alignItems: "center" },
    title: { ...Typography.h3, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary },

    dragBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      backgroundColor: c.tint + "12",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.tint + "30",
    },
    dragBannerText: { ...Typography.captionSemibold, color: c.tint, flex: 1 },

    errorBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      backgroundColor: c.error + "18",
      borderLeftWidth: 3,
      borderLeftColor: c.error,
      margin: Spacing.lg,
      marginBottom: 0,
      padding: Spacing.md,
      borderRadius: Radius.sm,
    },
    errorText: { ...Typography.caption, color: c.error, flex: 1 },

    listContent: { padding: Spacing.lg, gap: Spacing.sm },

    pageRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      overflow: "hidden",
      gap: Spacing.sm,
      paddingRight: Spacing.sm,
    },
    pageRowSelected: {
      borderColor: c.tint,
      borderWidth: 2,
      backgroundColor: c.tint + "08",
    },
    pageRowSwapTarget: {
      borderColor: c.tint + "60",
      borderWidth: 1.5,
      borderStyle: "dashed",
    },

    reorderBtns: {
      alignItems: "center",
      justifyContent: "center",
      paddingLeft: Spacing.xs,
      gap: 2,
    },
    reorderBtn: { padding: 4 },
    reorderBtnDisabled: { opacity: 0.3 },
    pageIndexBadge: {
      ...Typography.captionSemibold,
      color: c.textTertiary,
      width: 20,
      textAlign: "center",
    },

    pageThumbBtn: { position: "relative" },
    pageThumb: {
      width: 72,
      height: 96,
      backgroundColor: c.backgroundSolid,
    },
    selectedOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: c.tint + "60",
      alignItems: "center",
      justifyContent: "center",
    },
    swapTargetOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: c.tint + "15",
      borderWidth: 2,
      borderColor: c.tint + "80",
    },
    retakeHintOverlay: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: "rgba(0,0,0,0.5)",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      paddingVertical: 3,
    },
    retakeHintText: { ...Typography.tiny, color: "#fff" },

    pageActions: {
      flex: 1,
      alignItems: "flex-end",
      gap: Spacing.sm,
      padding: Spacing.sm,
    },
    retakeBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      borderWidth: 1,
      borderColor: c.tint,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 4,
    },
    retakeBtnText: { ...Typography.captionSemibold, color: c.tint },
    deletePageBtn: { padding: Spacing.xs },

    addPageRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.sm,
    },
    addPageText: { ...Typography.bodyMedium, color: c.tint },

    bottomBar: {
      padding: Spacing.lg,
      paddingTop: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      gap: Spacing.sm,
    },
    confidenceHint: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    confidenceHintText: { ...Typography.caption, color: c.textTertiary, flex: 1 },
    processBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    processBtnDisabled: { opacity: 0.45 },
    processBtnText: { ...Typography.bodySemibold, color: "#fff" },
  });
}
