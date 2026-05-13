import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image as RNImage,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system";

import { ManualCropOverlay } from "@/components/ManualCropOverlay";
import {
  FILTER_LABELS,
  type InkPath,
  makePageEdit,
  type PageEdit,
  type PageFilter,
  pageNeedsBake,
  reorderArray,
  rotateBy90,
  type TextOverlay,
} from "@/lib/scan/page-edits";

// ----- Lazy Skia (native only) -----------------------------------------------
type SkiaApi = {
  Canvas: any;
  Image: any;
  Path: any;
  Text: any;
  Group: any;
  ColorMatrix: any;
  Skia: any;
  useImage: any;
  Font: any;
  matchFont?: any;
  ImageFormat: any;
  PaintStyle: any;
  StrokeCap: any;
};
let SK: SkiaApi | null = null;
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SK = require("@shopify/react-native-skia") as SkiaApi;
  } catch {
    SK = null;
  }
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const HANDLE_HIT = 52;
const HANDLE_SIZE = 36;

// ----- Types -----------------------------------------------------------------
export interface ReviewAndEditScreenProps {
  visible: boolean;
  initialPhotos: string[];
  isFinishing?: boolean;
  onCancel: () => void;
  onAddMore: () => void;
  /** called with the FINAL list of baked image URIs (one per page, in order) */
  onFinish: (finalUris: string[]) => void;
  /** called whenever the local pages array changes so the parent can keep a copy */
  onPagesChanged?: (uris: string[]) => void;
}

type Tool = "none" | "crop" | "ink" | "text";
type Mode = "preview" | "edit";

// ----- Helpers ---------------------------------------------------------------
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

function getNaturalSize(uri: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    RNImage.getSize(
      uri,
      (w, h) => resolve({ w: w || 1, h: h || 1 }),
      () => resolve({ w: 1, h: 1 })
    );
  });
}

/**
 * Bake one page's filter + ink + text into a final JPEG URI.
 * Returns the original URI if the page has no overlays or if Skia is unavailable.
 */
async function bakePage(page: PageEdit): Promise<string> {
  if (!pageNeedsBake(page)) return page.uri;
  if (!SK) return page.uri;

  try {
    const { w: imgW, h: imgH } = await getNaturalSize(page.uri);

    // Load image bytes
    const data = await SK.Skia.Data.fromURI(page.uri);
    const skImg = SK.Skia.Image.MakeImageFromEncoded(data);
    if (!skImg) return page.uri;

    const surface = SK.Skia.Surface.MakeOffscreen(imgW, imgH);
    if (!surface) return page.uri;

    const canvas = surface.getCanvas();

    const paint = SK.Skia.Paint();
    if (page.filter !== "none") {
      const m =
        page.filter === "bw"
          ? [
              0.299, 0.587, 0.114, 0, 0,
              0.299, 0.587, 0.114, 0, 0,
              0.299, 0.587, 0.114, 0, 0,
              0, 0, 0, 1, 0,
            ]
          : page.filter === "enhance"
          ? [
              1.35, 0, 0, 0, -25,
              0, 1.35, 0, 0, -25,
              0, 0, 1.35, 0, -25,
              0, 0, 0, 1, 0,
            ]
          : [
              1.15, 0, 0, 0, 0,
              0, 1.15, 0, 0, 0,
              0, 0, 1.15, 0, 0,
              0, 0, 0, 1, 0,
            ];
      paint.setColorFilter(SK.Skia.ColorFilter.MakeMatrix(m));
    }
    canvas.drawImage(skImg, 0, 0, paint);

    // Ink paths: stored in normalized image-space (0-1)
    for (const p of page.inkPaths) {
      try {
        const path = SK.Skia.Path.MakeFromSVGString(scaleSvgPath(p.d, imgW, imgH));
        if (!path) continue;
        const inkPaint = SK.Skia.Paint();
        inkPaint.setColor(SK.Skia.Color(p.color));
        inkPaint.setStyle(1); // Stroke
        inkPaint.setStrokeWidth(p.width * Math.max(imgW, imgH) / 1000);
        inkPaint.setStrokeCap(1); // Round
        inkPaint.setAntiAlias(true);
        canvas.drawPath(path, inkPaint);
      } catch (e: any) {
        console.log("ink path bake error:", e?.message);
      }
    }

    // Text overlays: x/y are normalized
    for (const t of page.texts) {
      try {
        const fontSize = t.fontSize * (Math.max(imgW, imgH) / 800);
        const font = SK.Skia.Font(undefined, fontSize);
        const txtPaint = SK.Skia.Paint();
        txtPaint.setColor(SK.Skia.Color(t.color));
        txtPaint.setAntiAlias(true);
        canvas.drawText(t.text, t.x * imgW, t.y * imgH, txtPaint, font);
      } catch (e: any) {
        console.log("text bake error:", e?.message);
      }
    }

    const snap = surface.makeImageSnapshot();
    const b64 = snap.encodeToBase64(SK.ImageFormat?.JPEG ?? 3, 92);
    const path = `${(FileSystem as any).cacheDirectory}baked-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: ((FileSystem as any).EncodingType?.Base64) ?? "base64",
    });
    return path;
  } catch (e: any) {
    console.log("bakePage failed:", e?.message);
    return page.uri;
  }
}

/** SVG path scaling: paths are stored as "M x,y L x,y ..." with x,y in [0,1]. Scale to imgW,imgH. */
function scaleSvgPath(d: string, w: number, h: number): string {
  return d.replace(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/g, (_m, x, y) => {
    const xn = parseFloat(x) * w;
    const yn = parseFloat(y) * h;
    return `${xn.toFixed(2)},${yn.toFixed(2)}`;
  });
}

// ============================================================================
//                           ReviewAndEditScreen
// ============================================================================
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
  const [tool, setTool] = useState<Tool>("none");
  const [showReorder, setShowReorder] = useState(false);
  const [showCrop, setShowCrop] = useState(false);
  const [textEditing, setTextEditing] = useState<{ index: number | null }>({ index: null });
  const [textDraft, setTextDraft] = useState("");
  const [baking, setBaking] = useState(false);

  // Sync incoming photos -> pages when modal opens or initialPhotos changes
  useEffect(() => {
    if (!visible) return;
    setPages((prev) => {
      // Preserve existing edits if URIs match
      if (prev.length === initialPhotos.length && prev.every((p, i) => p.uri === initialPhotos[i])) {
        return prev;
      }
      return initialPhotos.map((u) => makePageEdit(u));
    });
    setActiveIndex(0);
    setMode("preview");
    setTool("none");
  }, [visible, initialPhotos]);

  // Notify parent on changes — only while visible so a hidden screen can't
  // overwrite parent state with stale URIs from a previous session.
  const onPagesChangedRef = useRef(onPagesChanged);
  useEffect(() => { onPagesChangedRef.current = onPagesChanged; }, [onPagesChanged]);
  useEffect(() => {
    if (!visible) return;
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
    if (activePage.inkPaths.length || activePage.texts.length) {
      Alert.alert(
        "Rotate page?",
        "Rotating will clear ink and text on this page since they would be misaligned.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Rotate",
            style: "destructive",
            onPress: async () => {
              const u = await rotateUri(activePage.uri);
              setActivePage((p) => ({ ...p, uri: u, inkPaths: [], texts: [] }));
            },
          },
        ],
      );
      return;
    }
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
          setPages((prev) => {
            const next = prev.filter((_, i) => i !== activeIndex);
            return next;
          });
          setActiveIndex((i) => Math.max(0, Math.min(i, pages.length - 2)));
          if (pages.length <= 1) {
            // last page -> bail back
            onCancel();
          }
        },
      },
    ]);
  }, [activeIndex, activePage, pages.length, onCancel]);

  const handleCropApplied = useCallback(
    (croppedUri: string) => {
      setShowCrop(false);
      setActivePage((p) => ({ ...p, uri: croppedUri, inkPaths: [], texts: [] }));
    },
    [setActivePage],
  );

  const handleSetFilter = useCallback(
    (f: PageFilter) => setActivePage((p) => ({ ...p, filter: f })),
    [setActivePage],
  );

  const handleAddInkPath = useCallback(
    (ink: InkPath) => setActivePage((p) => ({ ...p, inkPaths: [...p.inkPaths, ink] })),
    [setActivePage],
  );

  const handleClearInk = useCallback(
    () => setActivePage((p) => ({ ...p, inkPaths: [] })),
    [setActivePage],
  );

  const handleAddText = useCallback(
    (t: TextOverlay) => setActivePage((p) => ({ ...p, texts: [...p.texts, t] })),
    [setActivePage],
  );

  const handleUpdateText = useCallback(
    (id: string, patch: Partial<TextOverlay>) =>
      setActivePage((p) => ({
        ...p,
        texts: p.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      })),
    [setActivePage],
  );

  const handleRemoveText = useCallback(
    (id: string) =>
      setActivePage((p) => ({ ...p, texts: p.texts.filter((t) => t.id !== id) })),
    [setActivePage],
  );

  const handleReorder = useCallback((from: number, to: number) => {
    setPages((prev) => reorderArray(prev, from, to));
    if (activeIndex === from) setActiveIndex(to);
  }, [activeIndex]);

  const handleFinish = useCallback(async () => {
    if (baking || isFinishing) return;
    setBaking(true);
    try {
      const final: string[] = [];
      for (const p of pages) {
        const u = await bakePage(p);
        final.push(u);
      }
      onFinish(final);
    } catch (e: any) {
      console.log("Finish bake failed:", e?.message);
      onFinish(pages.map((p) => p.uri));
    } finally {
      setBaking(false);
    }
  }, [baking, isFinishing, pages, onFinish]);

  if (!visible) return null;

  // ----- PREVIEW MODE (after capture) -----
  if (mode === "preview") {
    return (
      <View style={[StyleSheet.absoluteFill, styles.root]}>
        <View style={[styles.headerRow, { paddingTop: insets.top + 12 }]}>
          <Pressable onPress={onCancel} hitSlop={12} style={styles.iconBtn}>
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
            >
              <Ionicons name="refresh" size={22} color="#FFF" />
            </Pressable>
            <Pressable
              onPress={onAddMore}
              style={({ pressed }) => [styles.sideToolPill, pressed && { opacity: 0.7 }]}
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
              >
                <Image source={{ uri: p.uri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />
              </Pressable>
            );
          })}
          <Pressable
            onPress={onAddMore}
            style={[styles.previewThumb, styles.previewAddMoreThumb]}
          >
            <Ionicons name="add" size={26} color="#FFF" />
            <View style={[styles.cameraBadge]}>
              <Ionicons name="camera" size={10} color="#FFF" />
            </View>
          </Pressable>
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
          <Pressable
            onPress={() => setMode("edit")}
            disabled={pages.length === 0}
            testID="review-edit-mode-btn"
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && { opacity: 0.85 },
              pages.length === 0 && { opacity: 0.5 },
            ]}
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
        <Pressable onPress={() => setMode("preview")} hitSlop={12} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={26} color="#FFF" />
        </Pressable>
        <Text style={styles.headerTitle}>Page {activeIndex + 1} of {pages.length}</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.editMain}>
        {activePage ? (
          <EditingCanvas
            page={activePage}
            tool={tool}
            onAddInkPath={handleAddInkPath}
            onAddText={(x, y) => {
              setTextDraft("");
              setTextEditing({ index: -1 });
              // store the pending coordinates
              pendingTextCoordsRef.current = { x, y };
            }}
            onUpdateText={handleUpdateText}
            onRemoveText={handleRemoveText}
          />
        ) : null}

        <View style={styles.sideToolColumn}>
          {[
            { id: "crop", label: "Crop", icon: "crop" as const, onPress: () => setShowCrop(true) },
            { id: "ink", label: "Ink", icon: "create-outline" as const, onPress: () => setTool(tool === "ink" ? "none" : "ink") },
            { id: "text", label: "Text", icon: "text" as const, onPress: () => setTool(tool === "text" ? "none" : "text") },
            { id: "rotate", label: "Rotate", icon: "refresh" as const, onPress: handleRotate },
            { id: "delete", label: "Delete", icon: "trash-outline" as const, onPress: handleDelete },
            { id: "close", label: "Close", icon: "chevron-down" as const, onPress: () => setMode("preview") },
          ].map((t) => {
            const active = (t.id === "ink" && tool === "ink") || (t.id === "text" && tool === "text");
            return (
              <Pressable
                key={t.id}
                onPress={t.onPress}
                style={({ pressed }) => [
                  styles.editSideRow,
                  pressed && { opacity: 0.7 },
                  active && { backgroundColor: "rgba(20,184,166,0.35)" },
                ]}
              >
                <Text style={styles.editSideLabel}>{t.label}</Text>
                <Ionicons name={t.icon} size={20} color="#FFF" />
              </Pressable>
            );
          })}
          {tool === "ink" && activePage && activePage.inkPaths.length > 0 && (
            <Pressable
              onPress={handleClearInk}
              style={({ pressed }) => [styles.editSideRow, pressed && { opacity: 0.7 }, { backgroundColor: "rgba(239,68,68,0.3)" }]}
            >
              <Text style={styles.editSideLabel}>Clear Ink</Text>
              <Ionicons name="trash" size={18} color="#FFF" />
            </Pressable>
          )}
        </View>
      </View>

      {/* Filter chips above bottom bar */}
      <View style={styles.filterRow}>
        {(["none", "bw", "enhance", "color"] as PageFilter[]).map((f) => {
          const active = activePage?.filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => handleSetFilter(f)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                {FILTER_LABELS[f]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.editBottomBar, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.editBottomTools}>
          <Pressable onPress={() => { /* filter row already visible */ }} style={styles.editBottomTool}>
            <MaterialCommunityIcons name="circle-half-full" size={22} color="#FFF" />
            <Text style={styles.editBottomToolLabel}>Filters</Text>
          </Pressable>
          <Pressable onPress={() => setShowReorder(true)} style={styles.editBottomTool}>
            <Ionicons name="grid-outline" size={22} color="#FFF" />
            <Text style={styles.editBottomToolLabel}>Reorder</Text>
          </Pressable>
          <Pressable onPress={onAddMore} style={styles.editBottomTool}>
            <Ionicons name="camera-outline" size={22} color="#FFF" />
            <Text style={styles.editBottomToolLabel}>Add more</Text>
          </Pressable>
        </View>

        <Pressable
          onPress={handleFinish}
          disabled={baking || isFinishing || pages.length === 0}
          testID="review-finish-btn"
          style={({ pressed }) => [
            styles.primaryBtn,
            pressed && { opacity: 0.85 },
            (baking || isFinishing || pages.length === 0) && { opacity: 0.6 },
          ]}
        >
          {(baking || isFinishing) ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Ionicons name="checkmark" size={22} color="#FFF" />
          )}
          <Text style={styles.primaryBtnText}>{baking ? "Preparing…" : isFinishing ? "Analyzing…" : "Finish"}</Text>
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

      <TextEditModal
        visible={textEditing.index !== null}
        initial={textDraft}
        onCancel={() => setTextEditing({ index: null })}
        onSave={(value) => {
          const t = value.trim();
          setTextEditing({ index: null });
          if (!t) return;
          const coords = pendingTextCoordsRef.current ?? { x: 0.5, y: 0.5 };
          handleAddText({
            id: `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            x: coords.x,
            y: coords.y,
            text: t,
            fontSize: 28,
            color: "#111",
          });
          pendingTextCoordsRef.current = null;
        }}
      />
    </View>
  );
}

const pendingTextCoordsRef: { current: { x: number; y: number } | null } = { current: null };

// ============================================================================
//                              EditingCanvas
// ============================================================================
interface EditingCanvasProps {
  page: PageEdit;
  tool: Tool;
  onAddInkPath: (path: InkPath) => void;
  onAddText: (xNorm: number, yNorm: number) => void;
  onUpdateText: (id: string, patch: Partial<TextOverlay>) => void;
  onRemoveText: (id: string) => void;
}

function EditingCanvas({ page, tool, onAddInkPath, onAddText, onUpdateText, onRemoveText }: EditingCanvasProps) {
  const [container, setContainer] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 1, h: 1 });
  const [currentInk, setCurrentInk] = useState<{ pts: { x: number; y: number }[] } | null>(null);
  const currentInkRef = useRef<{ pts: { x: number; y: number }[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNaturalSize(page.uri).then((s) => {
      if (!cancelled) setNatural(s);
    });
    return () => { cancelled = true; };
  }, [page.uri]);

  // Compute the rect of the contain-fitted image inside the container
  const imgRect = useMemo(() => {
    if (!container.w || !container.h || !natural.w || !natural.h) {
      return { x: 0, y: 0, w: container.w, h: container.h };
    }
    const ar = natural.w / natural.h;
    const car = container.w / container.h;
    let w: number, h: number;
    if (ar > car) { w = container.w; h = container.w / ar; }
    else { h = container.h; w = container.h * ar; }
    return { x: (container.w - w) / 2, y: (container.h - h) / 2, w, h };
  }, [container, natural]);

  function pointToImgNormalized(localX: number, localY: number) {
    const x = (localX - imgRect.x) / Math.max(1, imgRect.w);
    const y = (localY - imgRect.y) / Math.max(1, imgRect.h);
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  // Pan responder for ink + tap-to-place text
  const inkPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        if (toolRef.current === "ink") {
          const { locationX, locationY } = e.nativeEvent;
          const p = pointToImgNormalizedRef.current(locationX, locationY);
          currentInkRef.current = { pts: [p] };
          setCurrentInk({ pts: [p] });
        } else if (toolRef.current === "text") {
          const { locationX, locationY } = e.nativeEvent;
          const p = pointToImgNormalizedRef.current(locationX, locationY);
          onAddTextRef.current(p.x, p.y);
        }
      },
      onPanResponderMove: (e) => {
        if (toolRef.current !== "ink" || !currentInkRef.current) return;
        const { locationX, locationY } = e.nativeEvent;
        const p = pointToImgNormalizedRef.current(locationX, locationY);
        currentInkRef.current.pts.push(p);
        setCurrentInk({ pts: currentInkRef.current.pts.slice() });
      },
      onPanResponderRelease: () => {
        if (toolRef.current !== "ink" || !currentInkRef.current) return;
        const pts = currentInkRef.current.pts;
        if (pts.length >= 2) {
          const d = pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(4)},${pt.y.toFixed(4)}`).join(" ");
          onAddInkPathRef.current({ d, color: "#EF4444", width: 8 });
        }
        currentInkRef.current = null;
        setCurrentInk(null);
      },
    }),
  ).current;

  // Use refs so the PanResponder callbacks always see latest values
  const toolRef = useRef(tool);
  const pointToImgNormalizedRef = useRef(pointToImgNormalized);
  const onAddInkPathRef = useRef(onAddInkPath);
  const onAddTextRef = useRef(onAddText);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { pointToImgNormalizedRef.current = pointToImgNormalized; });
  useEffect(() => { onAddInkPathRef.current = onAddInkPath; }, [onAddInkPath]);
  useEffect(() => { onAddTextRef.current = onAddText; }, [onAddText]);

  // Filter as a CSS-equivalent display tint: native uses Skia, web uses opacity overlays
  const useSkiaFilter = !!SK && Platform.OS !== "web" && page.filter !== "none";

  return (
    <View
      style={styles.canvasWrap}
      onLayout={(e) => setContainer({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      {...inkPan.panHandlers}
    >
      {!useSkiaFilter ? (
        <Image source={{ uri: page.uri }} style={StyleSheet.absoluteFillObject} contentFit="contain" />
      ) : (
        <SkiaImageWithFilter uri={page.uri} filter={page.filter} rect={imgRect} container={container} />
      )}

      {/* Existing ink paths overlay (display layer) */}
      {SK && Platform.OS !== "web" && (page.inkPaths.length > 0 || currentInk) && (
        <SkiaInkOverlay
          paths={page.inkPaths}
          currentPts={currentInk?.pts ?? null}
          rect={imgRect}
          container={container}
        />
      )}

      {/* Text overlays (RN absolute-positioned, draggable) */}
      {page.texts.map((t) => (
        <DraggableText
          key={t.id}
          overlay={t}
          imgRect={imgRect}
          onChange={(patch) => onUpdateText(t.id, patch)}
          onLongPressDelete={() => {
            Alert.alert("Delete text", `Remove "${t.text}"?`, [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => onRemoveText(t.id) },
            ]);
          }}
        />
      ))}
    </View>
  );
}

// ----- Skia image with filter (native only) ---------------------------------
function SkiaImageWithFilter({ uri, filter, rect, container }:
  { uri: string; filter: PageFilter; rect: { x: number; y: number; w: number; h: number }; container: { w: number; h: number } }) {
  if (!SK || !container.w || !container.h) return null;
  const skImage = SK.useImage(uri);
  const matrix =
    filter === "bw" ? [
      0.299, 0.587, 0.114, 0, 0,
      0.299, 0.587, 0.114, 0, 0,
      0.299, 0.587, 0.114, 0, 0,
      0, 0, 0, 1, 0,
    ] :
    filter === "enhance" ? [
      1.35, 0, 0, 0, -25,
      0, 1.35, 0, 0, -25,
      0, 0, 1.35, 0, -25,
      0, 0, 0, 1, 0,
    ] :
    filter === "color" ? [
      1.15, 0, 0, 0, 0,
      0, 1.15, 0, 0, 0,
      0, 0, 1.15, 0, 0,
      0, 0, 0, 1, 0,
    ] : null;
  const Canvas = SK.Canvas;
  const SImg = SK.Image;
  const CMatrix = SK.ColorMatrix;
  return (
    <Canvas style={StyleSheet.absoluteFillObject}>
      {skImage && (
        <SImg image={skImage} x={rect.x} y={rect.y} width={rect.w} height={rect.h} fit="contain">
          {matrix && <CMatrix matrix={matrix as any} />}
        </SImg>
      )}
    </Canvas>
  );
}

// ----- Skia ink overlay (native only) ---------------------------------------
function SkiaInkOverlay({ paths, currentPts, rect, container }:
  { paths: InkPath[]; currentPts: { x: number; y: number }[] | null; rect: { x: number; y: number; w: number; h: number }; container: { w: number; h: number } }) {
  if (!SK || !container.w || !container.h) return null;
  const Canvas = SK.Canvas;
  const SPath = SK.Path;
  const display = (d: string) =>
    d.replace(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/g, (_m: string, x: string, y: string) =>
      `${(rect.x + parseFloat(x) * rect.w).toFixed(2)},${(rect.y + parseFloat(y) * rect.h).toFixed(2)}`,
    );
  const currentD = currentPts && currentPts.length >= 2
    ? currentPts.map((p, i) => `${i === 0 ? "M" : "L"}${(rect.x + p.x * rect.w).toFixed(2)},${(rect.y + p.y * rect.h).toFixed(2)}`).join(" ")
    : null;
  return (
    <Canvas style={StyleSheet.absoluteFillObject} pointerEvents="none">
      {paths.map((p, i) => (
        <SPath
          key={i}
          path={display(p.d)}
          color={p.color}
          style="stroke"
          strokeWidth={p.width}
          strokeCap="round"
          strokeJoin="round"
        />
      ))}
      {currentD && (
        <SPath path={currentD} color="#EF4444" style="stroke" strokeWidth={8} strokeCap="round" strokeJoin="round" />
      )}
    </Canvas>
  );
}

// ----- Draggable text overlay -----------------------------------------------
function DraggableText({ overlay, imgRect, onChange, onLongPressDelete }: {
  overlay: TextOverlay;
  imgRect: { x: number; y: number; w: number; h: number };
  onChange: (patch: Partial<TextOverlay>) => void;
  onLongPressDelete: () => void;
}) {
  const startRef = useRef<{ x: number; y: number }>({ x: overlay.x, y: overlay.y });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderGrant: () => {
        startRef.current = { x: overlay.x, y: overlay.y };
      },
      onPanResponderMove: (_, g) => {
        if (!imgRect.w || !imgRect.h) return;
        const nx = startRef.current.x + g.dx / imgRect.w;
        const ny = startRef.current.y + g.dy / imgRect.h;
        onChange({ x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) });
      },
    }),
  ).current;

  const left = imgRect.x + overlay.x * imgRect.w;
  const top = imgRect.y + overlay.y * imgRect.h;

  return (
    <Pressable
      onLongPress={onLongPressDelete}
      style={[styles.overlayText, { left, top }]}
      {...pan.panHandlers}
    >
      <Text style={{ fontSize: overlay.fontSize, color: overlay.color, fontFamily: "Inter_700Bold" }}>
        {overlay.text}
      </Text>
    </Pressable>
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
            <Pressable onPress={onClose} hitSlop={12}>
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
                >
                  <Ionicons name="arrow-up" size={20} color="#FFF" />
                </Pressable>
                <Pressable
                  disabled={idx === pages.length - 1}
                  onPress={() => onReorder(idx, idx + 1)}
                  style={({ pressed }) => [styles.reorderBtn, (pressed || idx === pages.length - 1) && { opacity: 0.4 }]}
                >
                  <Ionicons name="arrow-down" size={20} color="#FFF" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================================
//                              TextEditModal
// ============================================================================
function TextEditModal({ visible, initial, onCancel, onSave }: {
  visible: boolean;
  initial: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [val, setVal] = useState(initial);
  useEffect(() => { if (visible) setVal(initial); }, [visible, initial]);
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onCancel} transparent>
      <View style={styles.modalRoot}>
        <View style={[styles.modalCard, { paddingTop: 24, paddingBottom: 24, maxHeight: 320 }]}>
          <Text style={styles.modalTitle}>Add text</Text>
          <Text style={styles.modalSub}>Type a note to overlay on the page. Drag it to reposition. Long-press to remove.</Text>
          <TextInput
            value={val}
            onChangeText={setVal}
            placeholder="Type here…"
            placeholderTextColor="rgba(255,255,255,0.4)"
            style={styles.textInput}
            autoFocus
            multiline
            maxLength={120}
          />
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Pressable onPress={onCancel} style={({ pressed }) => [styles.modalBtnSecondary, pressed && { opacity: 0.7 }]}>
              <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => onSave(val)} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }, { flex: 1 }]}>
              <Text style={styles.primaryBtnText}>Add</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

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
  headerTitle: {
    color: "#FFF",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    color: "rgba(255,255,255,0.5)",
    textAlign: "center",
    marginTop: 80,
  },
  // Preview mode
  previewMain: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    position: "relative",
  },
  previewImageWrap: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 8,
    overflow: "hidden",
  },
  previewCornerDots: { ...StyleSheet.absoluteFillObject },
  cornerDot: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#FFF",
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  previewSideTools: {
    position: "absolute",
    right: 16,
    top: "40%",
    backgroundColor: "rgba(50,50,50,0.85)",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 8,
  },
  sideToolPill: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  previewThumbStrip: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 12,
    alignItems: "center",
  },
  previewThumb: {
    width: 56,
    height: 80,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  previewThumbActive: {
    borderColor: "#3B82F6",
  },
  previewAddMoreThumb: {
    borderStyle: "dashed",
    borderColor: "rgba(255,255,255,0.5)",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  cameraBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#3B82F6",
    alignItems: "center",
    justifyContent: "center",
  },
  // Bottom bar (preview)
  bottomBar: {
    paddingHorizontal: 24,
    paddingTop: 8,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#3B82F6",
    borderRadius: 14,
    paddingVertical: 16,
  },
  primaryBtnText: {
    color: "#FFF",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  // Edit mode
  editMain: {
    flex: 1,
    flexDirection: "row",
  },
  canvasWrap: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    overflow: "hidden",
    position: "relative",
  },
  sideToolColumn: {
    width: 130,
    backgroundColor: "rgba(50,50,50,0.95)",
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 4,
  },
  editSideRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 10,
  },
  editSideLabel: {
    color: "#FFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "rgba(15,15,15,0.95)",
    justifyContent: "center",
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  filterChipActive: {
    backgroundColor: "#14B8A6",
    borderColor: "#14B8A6",
  },
  filterChipText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  filterChipTextActive: {
    color: "#FFF",
  },
  editBottomBar: {
    paddingHorizontal: 24,
    paddingTop: 12,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  editBottomTools: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingBottom: 16,
  },
  editBottomTool: {
    alignItems: "center",
    gap: 4,
    minWidth: 64,
  },
  editBottomToolLabel: {
    color: "#FFF",
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  // Modal
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#1f1f1f",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    maxHeight: SCREEN_H * 0.8,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  modalTitle: {
    color: "#FFF",
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  modalSub: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginBottom: 8,
  },
  reorderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  reorderThumb: {
    width: 44,
    height: 60,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  reorderLabel: {
    color: "#FFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  reorderBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  textInput: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#FFF",
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    marginVertical: 12,
    minHeight: 80,
    textAlignVertical: "top",
  },
  modalBtnSecondary: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  modalBtnSecondaryText: {
    color: "#FFF",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  overlayText: {
    position: "absolute",
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderRadius: 4,
  },
});
