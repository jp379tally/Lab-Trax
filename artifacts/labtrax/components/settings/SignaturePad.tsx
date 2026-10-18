import React, { useImperativeHandle, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "@/lib/theme-context";

export type SignaturePadHandle = { clear: () => void; toDataUrl: () => string | null };

type Point = { x: number; y: number };
export const SignaturePad = React.forwardRef<SignaturePadHandle, { height?: number }>(
  ({ height = 150 }, ref) => {
    const { colors } = useTheme();
    const [strokes, setStrokes] = useState<Point[][]>([]);
    const active = useRef<Point[]>([]);
    const padWidth = 320;
    const responder = useMemo(() => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => { active.current = [{ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }]; setStrokes((v) => [...v, active.current]); },
      onPanResponderMove: (event) => {
        active.current = [...active.current, { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }];
        setStrokes((v) => [...v.slice(0, -1), active.current]);
      },
      onPanResponderRelease: () => { active.current = []; },
    }), []);
    useImperativeHandle(ref, () => ({
      clear: () => setStrokes([]),
      toDataUrl: () => strokes.length
        ? signaturePngDataUrl(strokes, padWidth, height)
        : null,
    }), [height, strokes]);
    return (
      <View>
        <View {...responder.panHandlers} style={[styles.pad, { height, borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${padWidth} ${height}`}>
            {strokes.map((stroke, index) => <Path key={index} d={pathFor(stroke)} fill="none" stroke={colors.text} strokeWidth={2} strokeLinecap="round" />)}
          </Svg>
          {!strokes.length && <Text style={[styles.hint, { color: colors.textTertiary }]}>Sign here</Text>}
        </View>
        <Pressable testID="signature-clear" onPress={() => setStrokes([])}><Text style={[styles.clear, { color: colors.tint }]}>Clear signature</Text></Pressable>
      </View>
    );
  },
);
SignaturePad.displayName = "SignaturePad";

function pathFor(points: Point[]): string {
  if (!points.length) return "";
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

// Small dependency-free PNG encoder (stored DEFLATE blocks) so native and web
// share the exact data:image/png;base64 contract without a canvas/native module.
export function signaturePngDataUrl(strokes: Point[][], width: number, height: number): string {
  const pixels = new Uint8Array(width * height * 4);
  pixels.fill(255);
  for (const stroke of strokes) for (const point of stroke) {
    const x = Math.round(point.x), y = Math.round(point.y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const i = (py * width + px) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
    }
  }
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.slice(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const zlib = new Uint8Array([0x78, 0x01, ...deflateStored(raw), ...adler(raw)]);
  const bytes = new Uint8Array([...pngBytes([137,80,78,71,13,10,26,10]), ...chunk("IHDR", new Uint8Array([...uint32(width, height), 8, 6, 0, 0, 0]), false), ...chunk("IDAT", zlib, false), ...chunk("IEND", new Uint8Array(), false)]);
  let binary = ""; bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return `data:image/png;base64,${btoa(binary)}`;
}
function uint32(...values: number[]): Uint8Array { return new Uint8Array(values.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])); }
function pngBytes(values: number[]): Uint8Array { return new Uint8Array(values); }
function chunk(name: string, data: Uint8Array, _unused: boolean): Uint8Array {
  const type = new Uint8Array([...name].map((c) => c.charCodeAt(0))), body = new Uint8Array([...type, ...data]);
  return new Uint8Array([...uint32(data.length), ...body, ...uint32(crc(body))]);
}
function crc(data: Uint8Array): number { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function deflateStored(data: Uint8Array): Uint8Array {
  const out: number[] = []; let offset = 0;
  while (offset < data.length) { const n = Math.min(65535, data.length - offset); out.push(offset + n >= data.length ? 1 : 0, n & 255, n >>> 8, (~n) & 255, (~n >>> 8) & 255, ...data.slice(offset, offset + n)); offset += n; }
  return new Uint8Array(out);
}
function adler(data: Uint8Array): Uint8Array { let a = 1, b = 0; for (const x of data) { a = (a + x) % 65521; b = (b + a) % 65521; } return uint32((b << 16) | a); }
const styles = StyleSheet.create({
  pad: { width: "100%", minHeight: 120, borderWidth: 1, borderRadius: 8, overflow: "hidden" },
  hint: { position: "absolute", alignSelf: "center", top: "45%" },
  clear: { fontSize: 13, fontWeight: "600", paddingVertical: 8 },
});