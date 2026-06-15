import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path, Circle, Text as SvgText, G } from "react-native-svg";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import type { ToothId } from "@/lib/rx-summary";

/**
 * Mobile mirror of the desktop ToothChart — anatomical arch layout.
 *
 * Renders adult permanent teeth in ADA Universal Numbering arch positions
 * using react-native-svg. Tooth-type colors match the desktop:
 *   crown      → blue  (#3B82F6)
 *   pontic     → purple (#A855F7)
 *   missing    → muted gray + ✕ glyph
 *   highlighted → brand tint (legacy fallback)
 *
 * When `readOnly` is false an `onToothClick` callback fires on tap, and any
 * tooth in the `selected` set is drawn in the brand tint so the technician can
 * see which tooth they are acting on.
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
// Larger transparent hit area so taps near a tooth register on touch screens.
const HIT_R = 19;

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
  /**
   * When false the chart is interactive: tapping a tooth fires `onToothClick`.
   * Defaults to true so existing read-only usages are unchanged.
   */
  readOnly?: boolean;
  /** Fires with the tapped tooth id when `readOnly` is false. */
  onToothClick?: (toothId: ToothId) => void;
  /** Teeth currently selected — drawn in the brand tint over their type color. */
  selected?: Set<ToothId>;
}

export function ToothChart({
  crownTeeth,
  ponticTeeth,
  missingTeeth,
  highlighted,
  readOnly = true,
  onToothClick,
  selected,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const interactive = !readOnly && !!onToothClick;

  const adultPositions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    for (let n = 1; n <= 32; n++) map.set(n, adultPos(n));
    return map;
  }, []);

  const upperPath = useMemo(() => archStrokePath(true), []);
  const lowerPath = useMemo(() => archStrokePath(false), []);

  const crownCount = crownTeeth?.size ?? 0;
  const ponticCount = ponticTeeth?.size ?? 0;
  const missingCount = missingTeeth?.size ?? 0;
  const hasCrown = crownCount > 0;
  const hasPontic = ponticCount > 0;
  const hasMissing = missingCount > 0;
  const hasHighlighted = (highlighted?.size ?? 0) > 0;
  const hasTyped = hasCrown || hasPontic || hasMissing;

  const counts: { key: string; label: string }[] = [];
  if (hasCrown) counts.push({ key: "crown", label: `${crownCount} ${crownCount === 1 ? "crown" : "crowns"}` });
  if (hasPontic) counts.push({ key: "pontic", label: `${ponticCount} ${ponticCount === 1 ? "pontic" : "pontics"}` });
  if (hasMissing) counts.push({ key: "missing", label: `${missingCount} missing` });

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>{interactive ? "Tap a tooth" : "Tooth chart"}</Text>
        <View style={styles.legend}>
          {hasCrown && (
            <>
              <View style={[styles.legendSwatch, { backgroundColor: COLOR_CROWN }]} />
              <Text style={styles.legendText}>Crown</Text>
            </>
          )}
          {hasPontic && (
            <>
              <View style={[styles.legendSwatch, { backgroundColor: COLOR_PONTIC, marginLeft: hasCrown ? 6 : 0 }]} />
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

      {counts.length > 0 && (
        <View style={styles.countRow}>
          {counts.map((c, i) => (
            <Text key={c.key} style={styles.countText}>
              {i > 0 ? "  ·  " : ""}
              {c.label}
            </Text>
          ))}
        </View>
      )}

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
          const id = String(n);
          const isSelected = selected?.has(id) ?? false;
          const toothType = resolveToothType(
            id,
            crownTeeth,
            ponticTeeth,
            missingTeeth,
            highlighted,
          );

          let circleFill: string;
          let circleStroke: string;
          let textColor: string;

          if (isSelected) {
            circleFill = colors.tint;
            circleStroke = colors.tint;
            textColor = colors.textInverse ?? "#ffffff";
          } else if (toothType === "crown") {
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

          const label = toothType === "missing" && !isSelected ? "✕" : id;
          const fontSize = n >= 10 ? 8 : 9.5;

          return (
            <G
              key={n}
              onPress={interactive ? () => onToothClick!(id) : undefined}
            >
              {/* Transparent, larger hit target for reliable touch */}
              {interactive && (
                <Circle cx={x} cy={y} r={HIT_R} fill="transparent" />
              )}
              <Circle
                cx={x}
                cy={y}
                r={BADGE_R}
                fill={circleFill}
                stroke={circleStroke}
                strokeWidth={isSelected ? 2.5 : 1.5}
              />
              <SvgText
                x={x}
                y={y + 0.5}
                textAnchor="middle"
                alignmentBaseline="central"
                fontSize={toothType === "missing" && !isSelected ? 10 : fontSize}
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
    countRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      marginBottom: 2,
    },
    countText: {
      fontSize: 11,
      fontFamily: "Inter_600SemiBold",
      color: colors.textSecondary,
    },
    svg: {
      aspectRatio: 520 / 390,
    },
  });
