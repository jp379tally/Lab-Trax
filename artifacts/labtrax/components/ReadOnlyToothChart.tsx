import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path, Circle, Text as SvgText, G } from "react-native-svg";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import type { ToothId } from "@/lib/rx-summary";

/**
 * Read-only mobile mirror of the desktop ToothChart — anatomical arch layout.
 *
 * Renders adult permanent teeth in ADA Universal Numbering arch positions
 * using react-native-svg. Tooth-type colors match the desktop:
 *   crown      → blue  (#3B82F6)
 *   pontic     → purple (#A855F7)
 *   missing    → muted gray + ✕ glyph
 *   highlighted → brand tint (legacy fallback)
 *
 * Arch orientation (patient perspective):
 *   Upper:  1 (viewer-left, patient-right) .. 16 (viewer-right, patient-left)
 *   Lower: 32 (viewer-left, patient-right) .. 17 (viewer-right, patient-left)
 */

// ── Arch Geometry (matches desktop ToothChart.tsx) ────────────────────────────
// ViewBox: 0 0 520 390
// Upper badge ellipse: center (260,152), rx=200, ry=108
// Lower badge ellipse: center (260,240), rx=200, ry=108
// Upper angles: tooth 1 → 195°, tooth 16 → 345° (clockwise through 270° = top)
// Lower angles: tooth 17 → 15°, tooth 32 → 165° (counter-clockwise through 90° = bottom)

const DEG = Math.PI / 180;
const UPPER_CX = 260, UPPER_CY = 152;
const LOWER_CX = 260, LOWER_CY = 240;
const ADULT_RX = 200, ADULT_RY = 108;
const FILL_RX = 166, FILL_RY = 86;
const BADGE_R = 14;

const COLOR_CROWN = "#3B82F6";
const COLOR_PONTIC = "#A855F7";

type ToothType = "crown" | "pontic" | "missing" | "highlighted";

function upperAngleDeg(n: number): number {
  return 195 + (n - 1) * 10;
}
function lowerAngleDeg(n: number): number {
  return 15 + (n - 17) * 10;
}
function ptOnEllipse(cx: number, cy: number, rx: number, ry: number, angleDeg: number) {
  const a = angleDeg * DEG;
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
}
function adultPos(n: number, rx = ADULT_RX, ry = ADULT_RY) {
  if (n <= 16) return ptOnEllipse(UPPER_CX, UPPER_CY, rx, ry, upperAngleDeg(n));
  return ptOnEllipse(LOWER_CX, LOWER_CY, rx, ry, lowerAngleDeg(n));
}

function archStrokePath(isUpper: boolean): string {
  const cx = isUpper ? UPPER_CX : LOWER_CX;
  const cy = isUpper ? UPPER_CY : LOWER_CY;
  if (isUpper) {
    const p1 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, 195);
    const p2 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, 345);
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${FILL_RX} ${FILL_RY} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  } else {
    const p1 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, 165);
    const p2 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, 15);
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${FILL_RX} ${FILL_RY} 0 0 0 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
}

function resolveToothType(
  id: string,
  crownTeeth: Set<ToothId> | undefined,
  ponticTeeth: Set<ToothId> | undefined,
  missingTeeth: Set<ToothId> | undefined,
  highlighted: Set<ToothId> | undefined,
): ToothType | undefined {
  if (missingTeeth?.has(id)) return "missing";
  if (ponticTeeth?.has(id)) return "pontic";
  if (crownTeeth?.has(id)) return "crown";
  if (highlighted?.has(id)) return "highlighted";
  return undefined;
}

interface Props {
  /** Teeth with a crown/restoration — rendered blue. */
  crownTeeth?: Set<ToothId>;
  /** Teeth marked as pontic — rendered purple. */
  ponticTeeth?: Set<ToothId>;
  /** Teeth marked as missing — rendered with ✕ glyph. */
  missingTeeth?: Set<ToothId>;
  /** Legacy fallback: all highlighted teeth rendered in the brand tint. */
  highlighted?: Set<ToothId>;
}

export function ReadOnlyToothChart({ crownTeeth, ponticTeeth, missingTeeth, highlighted }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const adultPositions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    for (let n = 1; n <= 32; n++) map.set(n, adultPos(n));
    return map;
  }, []);

  const upperPath = useMemo(() => archStrokePath(true), []);
  const lowerPath = useMemo(() => archStrokePath(false), []);

  const hasCrown = (crownTeeth?.size ?? 0) > 0;
  const hasPontic = (ponticTeeth?.size ?? 0) > 0;
  const hasMissing = (missingTeeth?.size ?? 0) > 0;
  const hasHighlighted = (highlighted?.size ?? 0) > 0;
  const hasTyped = hasCrown || hasPontic || hasMissing;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Tooth chart</Text>
        <View style={styles.legend}>
          {hasCrown && (
            <>
              <View style={[styles.legendSwatch, { backgroundColor: COLOR_CROWN }]} />
              <Text style={styles.legendText}>Crown</Text>
            </>
          )}
          {hasPontic && (
            <>
              <View style={[styles.legendSwatchPontic, { marginLeft: hasCrown ? 6 : 0 }]} />
              <Text style={styles.legendText}>Pontic</Text>
            </>
          )}
          {hasMissing && (
            <>
              <View style={[styles.legendSwatchMissing, { marginLeft: hasCrown || hasPontic ? 6 : 0 }]} />
              <Text style={styles.legendText}>Missing</Text>
            </>
          )}
          {!hasTyped && hasHighlighted && (
            <>
              <View style={[styles.legendSwatch, { backgroundColor: colors.tint }]} />
              <Text style={styles.legendText}>Highlighted</Text>
            </>
          )}
        </View>
      </View>

      <Svg
        viewBox="0 0 520 390"
        width="100%"
        style={styles.svg}
      >
        {/* Arch background strokes */}
        <Path
          d={upperPath}
          fill="none"
          stroke="rgba(0,0,0,0.07)"
          strokeWidth={32}
          strokeLinecap="round"
        />
        <Path
          d={lowerPath}
          fill="none"
          stroke="rgba(0,0,0,0.07)"
          strokeWidth={32}
          strokeLinecap="round"
        />

        {/* Arch labels */}
        <SvgText
          x={UPPER_CX}
          y={UPPER_CY + 18}
          textAnchor="middle"
          fontSize={9}
          fill="rgba(0,0,0,0.3)"
          fontFamily="system-ui"
        >
          UPPER
        </SvgText>
        <SvgText
          x={LOWER_CX}
          y={LOWER_CY - 14}
          textAnchor="middle"
          fontSize={9}
          fill="rgba(0,0,0,0.3)"
          fontFamily="system-ui"
        >
          LOWER
        </SvgText>

        {/* Adult teeth badges */}
        {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
          const { x, y } = adultPositions.get(n)!;
          const toothType = resolveToothType(
            String(n),
            crownTeeth,
            ponticTeeth,
            missingTeeth,
            highlighted,
          );

          let circleFill: string;
          let circleStroke: string;
          let textColor: string;

          if (toothType === "crown") {
            circleFill = COLOR_CROWN;
            circleStroke = COLOR_CROWN;
            textColor = "#ffffff";
          } else if (toothType === "pontic") {
            circleFill = COLOR_PONTIC;
            circleStroke = COLOR_PONTIC;
            textColor = "#ffffff";
          } else if (toothType === "missing") {
            circleFill = "rgba(0,0,0,0.08)";
            circleStroke = "rgba(0,0,0,0.25)";
            textColor = "rgba(0,0,0,0.5)";
          } else if (toothType === "highlighted") {
            circleFill = colors.tint;
            circleStroke = colors.tint;
            textColor = colors.textInverse ?? "#ffffff";
          } else {
            circleFill = "rgba(0,0,0,0.06)";
            circleStroke = "rgba(0,0,0,0.12)";
            textColor = colors.text;
          }

          const label = toothType === "missing" ? "✕" : String(n);
          const fontSize = n >= 10 ? 8 : 9.5;

          return (
            <G key={n}>
              {/* Pontic: dashed "bridge-link" halo ring */}
              {toothType === "pontic" && (
                <Circle
                  cx={x}
                  cy={y}
                  r={BADGE_R + 3}
                  fill="none"
                  stroke={COLOR_PONTIC}
                  strokeWidth={1.25}
                  strokeDasharray="2.5,2"
                />
              )}
              <Circle
                cx={x}
                cy={y}
                r={BADGE_R}
                fill={circleFill}
                stroke={circleStroke}
                strokeWidth={1.5}
                strokeDasharray={toothType === "missing" ? "2.5,2" : undefined}
              />
              <SvgText
                x={x}
                y={y + 0.5}
                textAnchor="middle"
                alignmentBaseline="central"
                fontSize={toothType === "missing" ? 10 : fontSize}
                fontWeight="700"
                fill={textColor}
                fontFamily="Courier New"
              >
                {label}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      borderWidth: 1,
      borderColor: "rgba(0,0,0,0.08)",
      borderRadius: 10,
      padding: 10,
      backgroundColor: "rgba(0,0,0,0.02)",
      gap: 4,
    },
    headerRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 4,
    },
    label: {
      fontSize: 10,
      fontFamily: "Inter_600SemiBold",
      color: colors.textSecondary,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    legend: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    legendSwatch: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    legendSwatchPontic: {
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: COLOR_PONTIC,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: COLOR_PONTIC,
    },
    legendSwatchMissing: {
      width: 10,
      height: 10,
      borderRadius: 2,
      backgroundColor: "rgba(0,0,0,0.12)",
      borderWidth: 1,
      borderColor: "rgba(0,0,0,0.25)",
    },
    legendText: {
      fontSize: 10,
      fontFamily: "Inter_500Medium",
      color: colors.textTertiary,
    },
    svg: {
      aspectRatio: 520 / 390,
    },
  });
