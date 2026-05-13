import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImageManipulator from "expo-image-manipulator";

import { ManualCropOverlay } from "@/components/ManualCropOverlay";
import {
  makePageEdit,
  type PageEdit,
  reorderArray,
} from "@/lib/scan/page-edits";

const { height: SCREEN_H } = Dimensions.get("window");

export interface ReviewAndEditScreenProps {
  visible: boolean;
  initialPhotos: string[];
  isFinishing?: boolean;
  onCancel: () => void;
  onAddMore: () => void;
  /** called with the FINAL list of image URIs (one per page, in order) */
  onFinish: (finalUris: string[]) => void;
  /** called whenever the local pages array changes so the parent can keep a copy */
  onPagesChanged?: (uris: string[]) => void;
}

type Mode = "preview" | "edit";

async function rotateUri(uri: string): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ rotate: 90 }],
      { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  } catch (e: any) {
    console.log("rotateUri failed:", e?.message);
    return uri;
  }
}

export function ReviewAndEditScreen({
  visible,
  initialPhotos,
  isFinishing,
  onCancel,
  onAddMore,
  onFinish,
  onPagesChanged,
}: ReviewAndEditScreenProps) {
  const insets = useSafeAreaInsets();

  const [pages, setPages] = useState<PageEdit[]>([]);
  const [mode, setMode] = useState<Mode>("preview");
  const [activeIndex, setActiveIndex] = useState(0);
  const [showReorder, setShowReorder] = useState(false);
  const [showCrop, setShowCrop] = useState(false);

  // Track whether we've hydrated from initialPhotos for the current visible session,
  // so prop-driven re-syncs don't clobber edits or reset mode/activeIndex.
  const hydratedRef = useRef(false);
  const lastEmittedRef = useRef<string>("");

  useEffect(() => {
    if (!visible) {
      hydratedRef.current = false;
      lastEmittedRef.current = "";
      return;
    }
    if (hydratedRef.current) return;
    // First hydration after becoming visible: seed pages from props once.
    setPages(initialPhotos.map((u) => makePageEdit(u)));
    setActiveIndex(0);
    setMode("preview");
    hydratedRef.current = true;
    lastEmittedRef.current = initialPhotos.join("|");
  }, [visible, initialPhotos]);

  // Notify parent on changes — only after hydration, only while visible, and
  // only when the URI signature actually differs from what we last emitted.
  // This prevents the initial empty-state render from clearing parent photos.
  const onPagesChangedRef = useRef(onPagesChanged);
  useEffect(() => { onPagesChangedRef.current = onPagesChanged; }, [onPagesChanged]);
  useEffect(() => {
    if (!visible || !hydratedRef.current) return;
    const sig = pages.map((p) => p.uri).join("|");
    if (sig === lastEmittedRef.current) return;
    lastEmittedRef.current = sig;
    onPagesChangedRef.current?.(pages.map((p) => p.uri));
  }, [pages, visible]);

  const activePage = pages[activeIndex];

  const setActivePage = useCallback(
    (updater: (p: PageEdit) => PageEdit) => {
      setPages((prev) => {
        if (activeIndex < 0 || activeIndex >= prev.length) return prev;
        const next = prev.slice();
        next[activeIndex] = updater(prev[activeIndex]);
        return next;
      });
    },
    [activeIndex],
  );

  const handleRotate = useCallback(async () => {
    if (!activePage) return;
    const u = await rotateUri(activePage.uri);
    setActivePage((p) => ({ ...p, uri: u }));
  }, [activePage, setActivePage]);

  const handleDelete = useCallback(() => {
    if (!activePage) return;
    Alert.alert("Delete page?", "This page will be removed from the scan.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          const willBeEmpty = pages.length <= 1;
          setPages((prev) => prev.filter((_, i) => i !== activeIndex));
          setActiveIndex((i) => Math.max(0, Math.min(i, pages.length - 2)));
          if (willBeEmpty) onCancel();
        },
      },
    ]);
  }, [activeIndex, activePage, pages.length, onCancel]);

  const handleCropApplied = useCallback(
    (croppedUri: string) => {
      setShowCrop(false);
      setActivePage((p) => ({ ...p, uri: croppedUri }));
    },
    [setActivePage],
  );

  const handleReorder = useCallback((from: number, to: number) => {
    setPages((prev) => reorderArray(prev, from, to));
    if (activeIndex === from) setActiveIndex(to);
  }, [activeIndex]);

  const handleFinish = useCallback(() => {
    if (isFinishing || pages.length === 0) return;
    onFinish(pages.map((p) => p.uri));
  }, [isFinishing, pages, onFinish]);

  if (!visible) return null;

  // ----- PREVIEW MODE (after capture) -----
  if (mode === "preview") {
    return (
      <View style={[StyleSheet.absoluteFill, styles.root]}>
        <View style={[styles.headerRow, { paddingTop: insets.top + 12 }]}>
          <Pressable onPress={onCancel} hitSlop={12} style={styles.iconBtn} accessibilityLabel="Discard scan">
            <Ionicons name="chevron-back" size={26} color="#FFF" />
          </Pressable>
        </View>

        <View style={styles.previewMain}>
          {activePage ? (
            <View style={styles.previewImageWrap}>
              <Image
                source={{ uri: activePage.uri }}
                style={StyleSheet.absoluteFillObject}
                contentFit="contain"
              />
              <View style={styles.previewCornerDots} pointerEvents="none">
                <View style={[styles.cornerDot, { top: 8, left: 8 }]} />
                <View style={[styles.cornerDot, { top: 8, right: 8 }]} />
                <View style={[styles.cornerDot, { bottom: 8, left: 8 }]} />
                <View style={[styles.cornerDot, { bottom: 8, right: 8 }]} />
              </View>
            </View>
          ) : (
            <Text style={styles.emptyText}>No pages captured</Text>
          )}

          <View style={styles.previewSideTools}>
            <Pressable
              onPress={handleRotate}
              style={({ pressed }) => [styles.sideToolPill, pressed && { opacity: 0.7 }]}
              accessibilityLabel="Rotate page"
            >
              <Ionicons name="refresh" size={22} color="#FFF" />
            </Pressable>
            <Pressable
              onPress={onAddMore}
              style={({ pressed }) => [styles.sideToolPill, pressed && { opacity: 0.7 }]}
              accessibilityLabel="Take another photo"
            >
              <Ionicons name="image-outline" size={22} color="#FFF" />
            </Pressable>
          </View>
        </View>

        <ScrollView
          horizontal
          contentContainerStyle={styles.previewThumbStrip}
          showsHorizontalScrollIndicator={false}
        >
          {pages.map((p, idx) => {
            const isActive = idx === activeIndex;
            return (
              <Pressable
                key={`${p.uri}-${idx}`}
                onPress={() => setActiveIndex(idx)}
                style={[styles.previewThumb, isActive && styles.previewThumbActive]}
                accessibilityLabel={`Page ${idx + 1}`}
              >
                <Image source={{ uri: p.uri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />
              </Pressable>
            );
          })}
          <Pressable
            onPress={onAddMore}
            style={[styles.previewThumb, styles.previewAddMoreThumb]}
            accessibilityLabel="Add another page"
          >
            <Ionicons name="add" size={26} color="#FFF" />
            <View style={styles.cameraBadge}>
              <Ionicons name="camera" size={10} color="#FFF" />
            </View>
          </Pressable>
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
          <Pressable
            onPress={() => setMode("edit")}
            disabled={pages.length === 0}
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && { opacity: 0.85 },
              pages.length === 0 && { opacity: 0.5 },
            ]}
            accessibilityLabel="Open editor"
          >
            <Text style={styles.primaryBtnText}>Review and Edit</Text>
            <Ionicons name="chevron-forward" size={20} color="#FFF" />
          </Pressable>
        </View>
      </View>
    );
  }

  // ----- EDIT MODE -----
  return (
    <View style={[StyleSheet.absoluteFill, styles.root]}>
      <View style={[styles.headerRow, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => setMode("preview")} hitSlop={12} style={styles.iconBtn} accessibilityLabel="Back to preview">
          <Ionicons name="chevron-back" size={26} color="#FFF" />
        </Pressable>
        <Text style={styles.headerTitle}>Page {activeIndex + 1} of {pages.length}</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.editMain}>
        <View style={styles.canvasWrap}>
          {activePage && (
            <Image
              source={{ uri: activePage.uri }}
              style={StyleSheet.absoluteFillObject}
              contentFit="contain"
            />
          )}
        </View>

        <View style={styles.sideToolColumn}>
          {[
            { id: "crop", label: "Crop", icon: "crop" as const, onPress: () => setShowCrop(true) },
            { id: "rotate", label: "Rotate", icon: "refresh" as const, onPress: handleRotate },
            { id: "delete", label: "Delete", icon: "trash-outline" as const, onPress: handleDelete },
            { id: "close", label: "Close", icon: "chevron-down" as const, onPress: () => setMode("preview") },
          ].map((t) => (
            <Pressable
              key={t.id}
              onPress={t.onPress}
              style={({ pressed }) => [styles.editSideRow, pressed && { opacity: 0.7 }]}
              accessibilityLabel={t.label}
            >
              <Text style={styles.editSideLabel}>{t.label}</Text>
              <Ionicons name={t.icon} size={20} color="#FFF" />
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.editBottomBar, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.editBottomTools}>
          <Pressable onPress={() => setShowReorder(true)} style={styles.editBottomTool} accessibilityLabel="Reorder pages">
            <Ionicons name="grid-outline" size={22} color="#FFF" />
            <Text style={styles.editBottomToolLabel}>Reorder</Text>
          </Pressable>
          <Pressable onPress={onAddMore} style={styles.editBottomTool} accessibilityLabel="Add more pages">
            <Ionicons name="camera-outline" size={22} color="#FFF" />
            <Text style={styles.editBottomToolLabel}>Add more</Text>
          </Pressable>
        </View>

        <Pressable
          onPress={handleFinish}
          disabled={isFinishing || pages.length === 0}
          style={({ pressed }) => [
            styles.primaryBtn,
            pressed && { opacity: 0.85 },
            (isFinishing || pages.length === 0) && { opacity: 0.6 },
          ]}
          accessibilityLabel="Finish"
        >
          {isFinishing ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Ionicons name="checkmark" size={22} color="#FFF" />
          )}
          <Text style={styles.primaryBtnText}>{isFinishing ? "Analyzing…" : "Finish"}</Text>
        </Pressable>
      </View>

      <ManualCropOverlay
        visible={showCrop}
        imageUri={activePage?.uri || ""}
        onCancel={() => setShowCrop(false)}
        onCropped={handleCropApplied}
      />

      <ReorderModal
        visible={showReorder}
        pages={pages}
        onClose={() => setShowReorder(false)}
        onReorder={handleReorder}
      />
    </View>
  );
}

// ============================================================================
//                              ReorderModal
// ============================================================================
function ReorderModal({ visible, pages, onClose, onReorder }: {
  visible: boolean;
  pages: PageEdit[];
  onClose: () => void;
  onReorder: (from: number, to: number) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.modalRoot}>
        <View style={[styles.modalCard, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Reorder pages</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close reorder">
              <Ionicons name="close" size={26} color="#FFF" />
            </Pressable>
          </View>
          <Text style={styles.modalSub}>Use the arrows to change page order.</Text>
          <ScrollView contentContainerStyle={{ paddingVertical: 12 }}>
            {pages.map((p, idx) => (
              <View key={`${p.uri}-${idx}`} style={styles.reorderRow}>
                <Image source={{ uri: p.uri }} style={styles.reorderThumb} contentFit="cover" />
                <Text style={styles.reorderLabel}>Page {idx + 1}</Text>
                <View style={{ flex: 1 }} />
                <Pressable
                  disabled={idx === 0}
                  onPress={() => onReorder(idx, idx - 1)}
                  style={({ pressed }) => [styles.reorderBtn, (pressed || idx === 0) && { opacity: 0.4 }]}
                  accessibilityLabel={`Move page ${idx + 1} up`}
                >
                  <Ionicons name="arrow-up" size={20} color="#FFF" />
                </Pressable>
                <Pressable
                  disabled={idx === pages.length - 1}
                  onPress={() => onReorder(idx, idx + 1)}
                  style={({ pressed }) => [styles.reorderBtn, (pressed || idx === pages.length - 1) && { opacity: 0.4 }]}
                  accessibilityLabel={`Move page ${idx + 1} down`}
                >
                  <Ionicons name="arrow-down" size={20} color="#FFF" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            accessibilityLabel="Done reordering"
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// quick noop to keep Platform import meaningful (RN warns otherwise on web)
const _platformProbe: string = Platform.OS;
void _platformProbe;

// ============================================================================
//                                 Styles
// ============================================================================
const styles = StyleSheet.create({
  root: { backgroundColor: "#000", zIndex: 9000 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerTitle: { color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center", justifyContent: "center",
  },
  emptyText: { color: "rgba(255,255,255,0.5)", textAlign: "center", marginTop: 80 },
  // Preview mode
  previewMain: { flex: 1, paddingHorizontal: 16, paddingTop: 8, position: "relative" },
  previewImageWrap: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 8,
    overflow: "hidden",
  },
  previewCornerDots: { ...StyleSheet.absoluteFillObject },
  cornerDot: {
    position: "absolute",
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: "#FFF",
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  previewSideTools: {
    position: "absolute",
    right: 16,
    top: "40%",
    backgroundColor: "rgba(50,50,50,0.85)",
    borderRadius: 12,
    paddingVertical: 8, paddingHorizontal: 4,
    gap: 8,
  },
  sideToolPill: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  previewThumbStrip: { paddingHorizontal: 16, paddingVertical: 16, gap: 12, alignItems: "center" },
  previewThumb: {
    width: 56, height: 80, borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    borderWidth: 2, borderColor: "transparent",
    alignItems: "center", justifyContent: "center",
  },
  previewThumbActive: { borderColor: "#3B82F6" },
  previewAddMoreThumb: {
    borderStyle: "dashed",
    borderColor: "rgba(255,255,255,0.5)",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  cameraBadge: {
    position: "absolute", bottom: 6, right: 6,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: "#3B82F6",
    alignItems: "center", justifyContent: "center",
  },
  bottomBar: { paddingHorizontal: 24, paddingTop: 8, backgroundColor: "rgba(0,0,0,0.95)" },
  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, backgroundColor: "#3B82F6", borderRadius: 14, paddingVertical: 16,
  },
  primaryBtnText: { color: "#FFF", fontSize: 16, fontFamily: "Inter_700Bold" },
  // Edit mode
  editMain: { flex: 1, flexDirection: "row" },
  canvasWrap: { flex: 1, backgroundColor: "#1a1a1a", overflow: "hidden", position: "relative" },
  sideToolColumn: {
    width: 130,
    backgroundColor: "rgba(50,50,50,0.95)",
    paddingVertical: 8, paddingHorizontal: 8, gap: 4,
  },
  editSideRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 14, borderRadius: 10,
  },
  editSideLabel: { color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  editBottomBar: { paddingHorizontal: 24, paddingTop: 12, backgroundColor: "rgba(0,0,0,0.95)" },
  editBottomTools: { flexDirection: "row", justifyContent: "space-around", paddingBottom: 16 },
  editBottomTool: { alignItems: "center", gap: 4, minWidth: 64 },
  editBottomToolLabel: { color: "#FFF", fontSize: 11, fontFamily: "Inter_600SemiBold" },
  // Modal
  modalRoot: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: "#1f1f1f",
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20,
    maxHeight: SCREEN_H * 0.8,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  modalTitle: { color: "#FFF", fontSize: 18, fontFamily: "Inter_700Bold" },
  modalSub: { color: "rgba(255,255,255,0.6)", fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 8 },
  reorderRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)",
  },
  reorderThumb: {
    width: 44, height: 60, borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  reorderLabel: { color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  reorderBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
});
