import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  PanResponder,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Image as RNImage,
} from "react-native";
import { Image } from "expo-image";
import Svg, { Polygon } from "react-native-svg";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Point { x: number; y: number; }

interface Props {
  visible: boolean;
  imageUri: string;
  onCancel: () => void;
  onCropped: (croppedUri: string) => void;
}

const HANDLE_HIT = 52;
const HANDLE_SIZE = 36;
const SCREEN = Dimensions.get("window");

function computeImageRect(cw: number, ch: number, nw: number, nh: number) {
  if (!cw || !ch || !nw || !nh) return { x: 0, y: 0, w: cw || SCREEN.width, h: ch || SCREEN.height };
  const imgAspect = nw / nh;
  const conAspect = cw / ch;
  let w: number, h: number;
  if (imgAspect > conAspect) { w = cw; h = cw / imgAspect; }
  else { h = ch; w = ch * imgAspect; }
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

export function ManualCropOverlay({ visible, imageUri, onCancel, onCropped }: Props) {
  const insets = useSafeAreaInsets();
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [naturalSize, setNaturalSize] = useState({ w: 1, h: 1 });
  const [corners, setCorners] = useState<Point[]>([
    { x: 0.08, y: 0.08 },
    { x: 0.92, y: 0.08 },
    { x: 0.92, y: 0.92 },
    { x: 0.08, y: 0.92 },
  ]);
  const [isApplying, setIsApplying] = useState(false);

  const cornersRef = useRef(corners);
  const startCornersRef = useRef<Point[]>(corners);
  const imageRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => { cornersRef.current = corners; }, [corners]);

  useEffect(() => {
    if (!containerSize.w || !naturalSize.w) return;
    const rect = computeImageRect(containerSize.w, containerSize.h, naturalSize.w, naturalSize.h);
    imageRectRef.current = rect;
  }, [naturalSize, containerSize]);

  useEffect(() => {
    if (!visible || !imageUri) return;
    const fresh = [
      { x: 0.08, y: 0.08 },
      { x: 0.92, y: 0.08 },
      { x: 0.92, y: 0.92 },
      { x: 0.08, y: 0.92 },
    ];
    setCorners(fresh);
    cornersRef.current = fresh;
    setIsApplying(false);
    RNImage.getSize(
      imageUri,
      (w, h) => setNaturalSize({ w: w || 1, h: h || 1 }),
      () => setNaturalSize({ w: 1, h: 1 })
    );
  }, [visible, imageUri]);

  function cornerToScreen(c: Point, rect = imageRectRef.current): Point {
    return { x: rect.x + c.x * rect.w, y: rect.y + c.y * rect.h };
  }

  function screenToCorner(sx: number, sy: number, rect = imageRectRef.current): Point {
    if (!rect.w || !rect.h) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(0, Math.min(1, (sx - rect.x) / rect.w)),
      y: Math.max(0, Math.min(1, (sy - rect.y) / rect.h)),
    };
  }

  function makePR(idx: number) {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startCornersRef.current = cornersRef.current.map(c => ({ ...c }));
      },
      onPanResponderMove: (_, gs) => {
        const rect = imageRectRef.current;
        const start = startCornersRef.current[idx];
        const startSc = cornerToScreen(start, rect);
        const newCorner = screenToCorner(startSc.x + gs.dx, startSc.y + gs.dy, rect);
        setCorners(prev => {
          const updated = [...prev];
          updated[idx] = newCorner;
          return updated;
        });
      },
      onPanResponderRelease: () => {},
    });
  }

  const panResponders = useRef([
    makePR(0), makePR(1), makePR(2), makePR(3),
  ]);

  async function handleApply() {
    if (isApplying) return;
    setIsApplying(true);
    try {
      const cur = cornersRef.current;
      const xs = cur.map(c => c.x);
      const ys = cur.map(c => c.y);
      const minX = Math.max(0, Math.min(...xs));
      const maxX = Math.min(1, Math.max(...xs));
      const minY = Math.max(0, Math.min(...ys));
      const maxY = Math.min(1, Math.max(...ys));
      const nw = naturalSize.w;
      const nh = naturalSize.h;
      const originX = Math.round(minX * nw);
      const originY = Math.round(minY * nh);
      const cropW = Math.max(1, Math.round((maxX - minX) * nw));
      const cropH = Math.max(1, Math.round((maxY - minY) * nh));

      let uri = imageUri;
      if (uri.startsWith("data:")) {
        const base64 = uri.split(",")[1];
        const tmpPath = `${FileSystem.documentDirectory}tmp_crop_${Date.now()}.jpg`;
        await FileSystem.writeAsStringAsync(tmpPath, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        uri = tmpPath;
      }

      const result = await ImageManipulator.manipulateAsync(
        uri,
        [{ crop: { originX, originY, width: cropW, height: cropH } }],
        { compress: 0.93, format: ImageManipulator.SaveFormat.JPEG }
      );
      onCropped(result.uri);
    } catch (e: any) {
      console.log("ManualCropOverlay apply error:", e?.message);
      onCropped(imageUri);
    }
    setIsApplying(false);
  }

  if (!visible) return null;

  const cw = containerSize.w || SCREEN.width;
  const ch = containerSize.h || SCREEN.height * 0.78;
  const rect = computeImageRect(cw, ch, naturalSize.w, naturalSize.h);

  const screenCorners = corners.map(c => cornerToScreen(c, rect));
  const polyPoints = screenCorners.map(p => `${p.x},${p.y}`).join(" ");

  return (
    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: "#000", zIndex: 9999 }]}>
      <View style={{ paddingTop: insets.top + 10, alignItems: "center", paddingBottom: 8 }}>
        <Text style={styles.headerTitle}>Adjust Crop</Text>
        <Text style={styles.headerSub}>Drag the corner handles to align with the document edges</Text>
      </View>

      <View
        style={styles.imageContainer}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          setContainerSize({ w: width, h: height });
          const r = computeImageRect(width, height, naturalSize.w, naturalSize.h);
          imageRectRef.current = r;
        }}
      >
        {!!imageUri && (
          <Image
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFillObject}
            contentFit="contain"
            pointerEvents="none"
          />
        )}

        {cw > 0 && (
          <Svg
            width={cw}
            height={ch}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          >
            <Polygon
              points={polyPoints}
              fill="rgba(255,255,255,0.07)"
              stroke="rgba(255,255,255,0.9)"
              strokeWidth={2.5}
            />
          </Svg>
        )}

        {corners.map((_, idx) => {
          const sc = screenCorners[idx];
          return (
            <View
              key={idx}
              {...panResponders.current[idx].panHandlers}
              style={[styles.handleHit, { left: sc.x - HANDLE_HIT / 2, top: sc.y - HANDLE_HIT / 2 }]}
            >
              <View style={styles.handleOuter}>
                <View style={styles.handleDot} />
              </View>
            </View>
          );
        })}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [styles.footerBtn, styles.cancelBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="close" size={20} color="#fff" />
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={handleApply}
          disabled={isApplying}
          style={({ pressed }) => [styles.footerBtn, styles.applyBtn, (pressed || isApplying) && { opacity: 0.75 }]}
        >
          {isApplying
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="checkmark-circle" size={20} color="#fff" />}
          <Text style={styles.applyText}>{isApplying ? "Applying…" : "Apply Crop"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  headerSub: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  imageContainer: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  handleHit: {
    position: "absolute",
    width: HANDLE_HIT,
    height: HANDLE_HIT,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
  },
  handleOuter: {
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 8,
  },
  handleDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#fff",
  },
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  footerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 15,
    borderRadius: 14,
  },
  cancelBtn: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  cancelText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  applyBtn: {
    backgroundColor: "#14B8A6",
  },
  applyText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
});
