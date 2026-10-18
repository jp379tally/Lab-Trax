import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
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
 *
 * RN web maps accessibilityRole to an HTML tag, which cannot render inside
 * SVG. Semantic web controls live below the SVG instead.
 */

// ── Arch Geometry (matches desktop ToothChart.tsx) ────────────────────────────
// Both arches share a center and follow the perimeter of one upright oval.
// Universal numbering runs 1→16 across the upper arch and 17→32 along the
// lower arch; on screen, 1/32 are viewer-left and 16/17 viewer-right.

const DEG = Math.PI / 180;
const UPPER_CX = 260, UPPER_CY = 260;
const LOWER_CX = 260, LOWER_CY = 260;
const ADULT_RX = 188, ADULT_RY = 208;
const FILL_RX = 158, FILL_RY = 176;
// Larger transparent hit area so taps near a tooth register on touch screens.
const HIT_R = 19;

const COLOR_CROWN = "#3B82F6";
const COLOR_PONTIC = "#A855F7";

type ToothType = "crown" | "pontic" | "missing" | "highlighted";
type ToothForm = "incisor" | "canine" | "premolar" | "molar";

const toothPaths: Record<ToothForm, string> = {
  incisor: "M9 8 C12 4 18 3 24 4 C30 3 36 5 39 9 C41 12 40 20 38 27 L36 43 C35 49 31 52 24 53 C17 52 13 49 12 43 L10 27 C8 19 7 12 9 8 Z",
  canine: "M9 9 C12 5 18 4 24 5 C30 4 36 5 39 10 C42 15 38 25 35 34 C32 43 29 49 24 54 C19 49 16 43 13 34 C10 25 6 15 9 9 Z",
  premolar: "M8 10 C12 5 18 5 22 7 C26 5 33 5 38 10 C42 15 39 21 36 27 C34 34 34 45 29 50 C26 53 22 52 19 50 C14 47 14 37 11 29 C8 22 5 15 8 10 Z",
  molar: "M7 12 C10 6 16 5 21 7 C25 4 31 5 35 8 C41 8 43 14 41 20 C40 26 37 30 37 37 C37 47 33 52 28 51 C25 51 24 48 21 48 C18 48 16 52 12 50 C6 48 7 40 8 34 C8 28 5 22 6 17 C6 15 6 13 7 12 Z",
};

function toothForm(id: string): ToothForm {
  const n = Number(id);
  const position = ((n - 1) % 16) + 1;
  if (position === 6 || position === 11) return "canine";
  if ([4, 5, 12, 13].includes(position)) return "premolar";
  if (position >= 7 && position <= 10) return "incisor";
  return "molar";
}

export function getAdultToothRotation(n: number): number {
  const angle = n <= 16 ? upperAngleDeg(n) : lowerAngleDeg(n);
  return (angle + 270) % 360;
}

function upperAngleDeg(n: number): number {
  return 170 + (n - 1) * (200 / 15);
}
function lowerAngleDeg(n: number): number {
  return 350 + (n - 17) * (200 / 15);
}
function ptOnEllipse(cx: number, cy: number, rx: number, ry: number, angleDeg: number) {
  const a = angleDeg * DEG;
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
}
export function getAdultToothPosition(n: number) {
  const rx = ADULT_RX;
  const ry = ADULT_RY;
  if (n <= 16) return ptOnEllipse(UPPER_CX, UPPER_CY, rx, ry, upperAngleDeg(n));
  return ptOnEllipse(LOWER_CX, LOWER_CY, rx, ry, lowerAngleDeg(n));
}

function archStrokePath(isUpper: boolean): string {
  const cx = isUpper ? UPPER_CX : LOWER_CX;
  const cy = isUpper ? UPPER_CY : LOWER_CY;
  if (isUpper) {
    const p1 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, upperAngleDeg(1));
    const p2 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, upperAngleDeg(16));
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${FILL_RX} ${FILL_RY} 0 1 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  } else {
    const p1 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, lowerAngleDeg(17));
    const p2 = ptOnEllipse(cx, cy, FILL_RX, FILL_RY, lowerAngleDeg(32));
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${FILL_RX} ${FILL_RY} 0 1 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
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
  /** Teeth already billed on this case, shown with a green dashed halo. */
  billedTeeth?: Set<ToothId>;
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
  connectedPairs?: Set<string>;
  connectorSuggestions?: Set<string>;
  onConnectedPairsChange?: (pairs: Set<string>) => void;
  connectorIssue?: string | null;
  summaryText?: string;
}

export function ToothChart({
  crownTeeth,
  ponticTeeth,
  missingTeeth,
  billedTeeth,
  highlighted,
  readOnly = true,
  onToothClick,
  selected,
  connectedPairs,
  connectorSuggestions,
  onConnectedPairsChange,
  connectorIssue,
  summaryText,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expandedControls, setExpandedControls] = useState(true);

  const interactive = !readOnly && !!onToothClick;
  const showConnectors = interactive && !!onConnectedPairsChange;

  const adultPositions = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    for (let n = 1; n <= 32; n++) map.set(n, getAdultToothPosition(n));
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
  const hasBridgeState = !!onConnectedPairsChange || (connectedPairs?.size ?? 0) > 0;

  const counts: { key: string; label: string }[] = [];
  if (hasCrown) counts.push({ key: "crown", label: `${crownCount} ${crownCount === 1 ? "crown" : "crowns"}` });
  if (hasPontic) counts.push({ key: "pontic", label: `${ponticCount} ${ponticCount === 1 ? "pontic" : "pontics"}` });
  if (hasMissing) counts.push({ key: "missing", label: `${missingCount} missing` });

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>{interactive ? "Tap a tooth" : "Tooth chart"}</Text>
        <View style={styles.legend}>
          <View style={[styles.legendSwatchOutline, { borderColor: colors.tint }]} />
          <Text style={styles.legendText}>Selected</Text>
          <View style={[styles.legendSwatch, { backgroundColor: COLOR_CROWN }]} />
          <Text style={styles.legendText}>Crown</Text>
          <View style={[styles.legendSwatchPontic]} />
          <Text style={styles.legendText}>Pontic</Text>
          <View style={styles.legendSwatchMissing}><Text style={styles.legendMissingMark}>×</Text></View>
          <Text style={styles.legendText}>Missing</Text>
          <View style={styles.legendSwatchBilled} />
          <Text style={styles.legendText}>Billed</Text>
          {hasBridgeState && (
            <>
              <View style={styles.legendSwatchBridge} />
              <Text style={styles.legendText}>Bridge</Text>
            </>
          )}
          {!hasTyped && hasHighlighted && <Text style={styles.legendText}>Highlighted teeth use the blue tint</Text>}
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
        viewBox="0 0 520 520"
        preserveAspectRatio="xMidYMid meet"
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

        {/* Active bridge spans sit behind the tooth shapes on read-only charts. */}
        {connectedPairs && Array.from(connectedPairs).map((pair) => {
          const [a, b] = pair.split("-").map(Number);
          if (!Number.isInteger(a) || b !== a + 1 || !(a < 16 || (a >= 17 && a < 32))) return null;
          const start = adultPositions.get(a);
          const end = adultPositions.get(b);
          if (!start || !end) return null;
          return (
            <Path
              key={`bridge-span-${pair}`}
              testID={`bridge-span-${pair}`}
              d={`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`}
              fill="none"
              stroke={connectorSuggestions?.has(pair) ? colors.warningStrong : colors.success}
              strokeWidth={4}
              strokeLinecap="round"
              opacity={0.78}
            />
          );
        })}

        {/* Arch labels */}
        <SvgText
          x={UPPER_CX}
          y={UPPER_CY - 9}
          textAnchor="middle"
          fontSize={9}
          fill="rgba(0,0,0,0.3)"
          fontFamily="system-ui"
        >
          UPPER
        </SvgText>
        <SvgText
          x={LOWER_CX}
          y={LOWER_CY + 14}
          textAnchor="middle"
          fontSize={9}
          fill="rgba(0,0,0,0.3)"
          fontFamily="system-ui"
        >
          LOWER
        </SvgText>
        <SvgText x={12} y={264} textAnchor="start" fontSize={8} fill={colors.textTertiary} fontFamily="system-ui">
          PATIENT RIGHT
        </SvgText>
        <SvgText x={508} y={264} textAnchor="end" fontSize={8} fill={colors.textTertiary} fontFamily="system-ui">
          PATIENT LEFT
        </SvgText>

        {/* Connector links are only editable between adjacent assigned units. */}
        {Array.from({ length: 32 }, (_, i) => i + 1)
          .filter((n) => n < 16 || (n >= 17 && n < 32))
          .map((n) => {
            const key = `${n}-${n + 1}`;
            const leftId = String(n);
            const rightId = String(n + 1);
            const active = connectedPairs?.has(key) ?? false;
            const assigned =
              (crownTeeth?.has(leftId) || ponticTeeth?.has(leftId)) &&
              (crownTeeth?.has(rightId) || ponticTeeth?.has(rightId));
            if (!active && !assigned) return null;
            const a = adultPositions.get(n)!;
            const b = adultPositions.get(n + 1)!;
            const x = (a.x + b.x) / 2;
            const y = (a.y + b.y) / 2;
            return (
              <G
                key={`connector-${key}`}
                accessible={Platform.OS !== "web" && (showConnectors || active)}
                accessibilityRole={Platform.OS === "web" ? undefined : showConnectors ? "button" : "image"}
                accessibilityLabel={
                  active
                    ? `${connectorSuggestions?.has(key) ? "Suggested" : "Connected"} teeth ${n} and ${n + 1}`
                    : `Connect assigned teeth ${n} and ${n + 1}`
                }
                accessibilityState={Platform.OS !== "web" && showConnectors ? { checked: active, disabled: !assigned && !active } : undefined}
                onPress={
                  showConnectors && (assigned || active)
                    ? () => {
                        const next = new Set(connectedPairs ?? []);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        onConnectedPairsChange?.(next);
                      }
                    : undefined
                }
              >
                {showConnectors && (
                  <Circle cx={x} cy={y} r={10} fill="transparent" />
                )}
                <Circle
                  cx={x}
                  cy={y}
                  r={active ? 4 : 3}
                  fill={active ? (connectorSuggestions?.has(key) ? colors.warningStrong : colors.success) : "transparent"}
                  stroke={connectorSuggestions?.has(key) ? colors.warningStrong : active ? colors.success : "rgba(107,114,128,0.45)"}
                  strokeWidth={1.4}
                />
              </G>
            );
          })}

        {/* Adult teeth badges */}
        {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
          const { x, y } = adultPositions.get(n)!;
          const id = String(n);
          const isSelected = selected?.has(id) ?? false;
          const isBilled = billedTeeth?.has(id) ?? false;
          const toothType = resolveToothType(
            id,
            crownTeeth,
            ponticTeeth,
            missingTeeth,
            highlighted,
          );

          let fill: string;
          let stroke: string;
          if (toothType === "crown") {
            fill = "#DBEAFE";
            stroke = COLOR_CROWN;
          } else if (toothType === "pontic") {
            fill = "#F3E8FF";
            stroke = COLOR_PONTIC;
          } else if (toothType === "missing") {
            fill = "rgba(0,0,0,0.08)";
            stroke = "rgba(0,0,0,0.25)";
          } else if (toothType === "highlighted") {
            fill = "#DBEAFE";
            stroke = colors.tint;
          } else {
            fill = "rgba(255,255,255,0.88)";
            stroke = "rgba(0,0,0,0.25)";
          }

          const form = toothForm(id);
          const roleMarker = toothType === "crown" ? "C" : toothType === "pontic" ? "P" : "";

          return (
            <G
              key={n}
              testID={`tooth-${id}`}
              accessible={Platform.OS !== "web"}
              accessibilityRole={Platform.OS === "web" ? undefined : interactive ? "button" : "image"}
              accessibilityLabel={`Tooth ${id}${toothType ? `, ${toothType}` : ", unassigned"}${isBilled ? ", billed" : ""}${isSelected ? ", selected" : ""}`}
              accessibilityState={Platform.OS !== "web" && interactive ? { selected: isSelected } : undefined}
              onPress={interactive ? () => onToothClick!(id) : undefined}
            >
              {/* Transparent, larger hit target for reliable touch */}
              {interactive && (
                <Circle cx={x} cy={y} r={HIT_R} fill="transparent" />
              )}
              <G testID={`tooth-body-${id}`} transform={`translate(${x} ${y}) rotate(${getAdultToothRotation(n)}) scale(0.72) translate(-24 -29)`}>
                {isBilled && (
                  <Path
                    d={toothPaths[form]}
                    transform="translate(24 29) scale(1.18) translate(-24 -29)"
                    fill="none"
                    stroke={colors.successStrong}
                    strokeWidth={2}
                    strokeDasharray="3 2"
                  />
                )}
                {isSelected && (
                  <Path
                    d={toothPaths[form]}
                    transform="translate(24 29) scale(1.11) translate(-24 -29)"
                    fill="none"
                    stroke={colors.tint}
                    strokeWidth={2.5}
                  />
                )}
                {toothType === "pontic" && (
                  <Path
                    d={toothPaths[form]}
                    transform="translate(24 29) scale(1.07) translate(-24 -29)"
                    fill="none"
                    stroke={COLOR_PONTIC}
                    strokeWidth={1.7}
                    strokeDasharray="3 2"
                  />
                )}
                <Path
                  d={toothPaths[form]}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={1.7}
                  strokeLinejoin="round"
                  strokeDasharray={toothType === "missing" ? "3 2" : undefined}
                />
                {toothType !== "missing" && (
                  <Path
                    d="M12 12 C16 9 21 10 24 14 C27 10 32 9 36 12 M18 21 C20 25 21 29 24 33 C27 29 28 25 30 21"
                    fill="none"
                    stroke={stroke}
                    strokeWidth={1.4}
                  />
                )}
              </G>
              {toothType === "missing" && (
                <Path d={`M${x - 4} ${y - 7} L${x + 4} ${y + 1} M${x + 4} ${y - 7} L${x - 4} ${y + 1}`} stroke={colors.textTertiary} strokeWidth={1.5} />
              )}
              <SvgText x={x} y={y + (toothType === "missing" ? 9 : 3)} textAnchor="middle" alignmentBaseline="central" fontSize={14} fontWeight="700" fill="#0F172A" fontFamily="Courier New">
                {id}
              </SvgText>
              {!!roleMarker && (
                <G>
                  <Circle cx={x + 12} cy={y - 12} r={6} fill={toothType === "crown" ? COLOR_CROWN : COLOR_PONTIC} />
                  <SvgText x={x + 12} y={y - 12} textAnchor="middle" alignmentBaseline="central" fontSize={7} fontWeight="700" fill="#fff">{roleMarker}</SvgText>
                </G>
              )}
            </G>
          );
        })}
      </Svg>
      {summaryText ? <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 8 }}>{summaryText}</Text> : null}
      {interactive && <View>
        {connectorIssue && showConnectors && <Pressable accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }}
          onPress={() => onConnectedPairsChange?.(new Set())}><Text style={styles.label}>Clear connections for review</Text></Pressable>}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedControls }}
          style={{ minHeight: 44, justifyContent: "center" }} onPress={() => setExpandedControls((value) => !value)}>
          <Text style={styles.label}>{expandedControls ? "Hide large tooth controls" : "Open large tooth and connector controls"}</Text>
        </Pressable>
        {expandedControls && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[...Array.from({ length: 16 }, (_, index) => index + 1), ...Array.from({ length: 16 }, (_, index) => 32 - index)].map((tooth) => {
            const id = String(tooth);
            return <Pressable key={id} accessibilityRole="button" accessibilityLabel={`Edit tooth ${id}, ${tooth <= 16 ? "upper" : "lower"}, ${crownTeeth?.has(id) ? "prepared crown" : ponticTeeth?.has(id) ? "pontic" : "unassigned"}`}
              onPress={() => onToothClick?.(id)} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1,
                backgroundColor: crownTeeth?.has(id) ? "#DBEAFE" : ponticTeeth?.has(id) ? "#F3E8FF" : "transparent",
                borderColor: crownTeeth?.has(id) ? COLOR_CROWN : ponticTeeth?.has(id) ? COLOR_PONTIC : colors.textTertiary, borderRadius: 8 }}>
              <Text style={{ color: crownTeeth?.has(id) ? "#1E3A8A" : ponticTeeth?.has(id) ? "#581C87" : colors.text }}>#{id}{crownTeeth?.has(id) ? " C" : ponticTeeth?.has(id) ? " P" : ""}</Text>
            </Pressable>;
          })}
          {showConnectors && Array.from({ length: 31 }, (_, index) => index + 1).filter((tooth) => tooth !== 16).map((tooth) => {
            const pair = `${tooth}-${tooth + 1}`;
            if (!connectedPairs?.has(pair) && !((crownTeeth?.has(String(tooth)) || ponticTeeth?.has(String(tooth))) && (crownTeeth?.has(String(tooth + 1)) || ponticTeeth?.has(String(tooth + 1))))) return null;
            return <Pressable key={pair} accessibilityRole="button" accessibilityState={{ selected: !!connectedPairs?.has(pair) }}
              accessibilityLabel={`${connectedPairs?.has(pair) ? "Disconnect" : "Connect"} teeth ${tooth} and ${tooth + 1}`}
              style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center" }} onPress={() => {
                const next = new Set(connectedPairs ?? []); if (next.has(pair)) next.delete(pair); else next.add(pair);
                onConnectedPairsChange?.(next);
              }}><Text style={{ color: colors.text }}>{connectedPairs?.has(pair) ? "Disconnect" : "Connect"} #{tooth}–#{tooth + 1}</Text></Pressable>;
          })}
        </View>}
      </View>}
      {connectorIssue ? <Text accessibilityRole="alert" style={styles.connectorWarning}>{connectorIssue}</Text> : null}
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
      flex: 1,
      flexWrap: "wrap",
      justifyContent: "flex-end",
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
      alignItems: "center",
      justifyContent: "center",
    },
    legendSwatchOutline: {
      width: 12,
      height: 12,
      borderRadius: 4,
      borderWidth: 2,
    },
    legendSwatchPontic: {
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: "#F3E8FF",
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: COLOR_PONTIC,
    },
    legendSwatchBilled: {
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: "rgba(16,185,129,0.12)",
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.successStrong,
    },
    legendSwatchBridge: {
      width: 12,
      height: 4,
      borderRadius: 3,
      backgroundColor: colors.success,
    },
    legendMissingMark: {
      fontSize: 9,
      lineHeight: 10,
      color: "rgba(0,0,0,0.6)",
      fontWeight: "700",
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
      aspectRatio: 1,
    },
    connectorWarning: {
      color: colors.errorText,
      fontSize: 11,
      fontFamily: "Inter_500Medium",
      marginTop: 4,
    },
  });
