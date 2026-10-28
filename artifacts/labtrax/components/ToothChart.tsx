import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
import Svg, { Path, Circle, Ellipse, Image as SvgImage, Text as SvgText, G } from "react-native-svg";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import type { ToothId } from "@/lib/rx-summary";
import {
  ATLAS,
  CHART,
  atlasCell,
  atlasDrawSize,
  CONNECTOR_HIT_RADIUS,
  CONNECTOR_RADIUS,
  ROLE_STYLE,
  SELECT_COLOR,
  adjacentPairs,
  adultToothGeometry,
  connectorGeometry,
  type ToothRole,
} from "@/lib/tooth-geometry";

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

// ── Arch Geometry ────────────────────────────────────────────────────────────
// Shared with desktop via lib/tooth-geometry (portrait oval, per-form widths).

export function getAdultToothRotation(n: number): number {
  return adultToothGeometry(n).rotation;
}
export function getAdultToothPosition(n: number) {
  const g = adultToothGeometry(n);
  return { x: g.x, y: g.y };
}

// Reference-derived atlas; see assets/images/tooth-atlas.provenance.md
const TOOTH_ATLAS: Record<string, number> = {
  unassigned: require("../assets/images/tooth-atlas-unassigned.png"),
  crown: require("../assets/images/tooth-atlas-crown.png"),
  pontic: require("../assets/images/tooth-atlas-pontic.png"),
  veneer: require("../assets/images/tooth-atlas-veneer.png"),
  missing: require("../assets/images/tooth-atlas-missing.png"),
};
const COLOR_CROWN = ROLE_STYLE.crown.fill;
const COLOR_PONTIC = ROLE_STYLE.pontic.fill;

type ToothType = "crown" | "pontic" | "veneer" | "missing" | "highlighted";

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
  /** Teeth with a veneer — teal with a V badge. */
  veneerTeeth?: Set<ToothId>;
  /** Teeth already billed on this case, shown with a small green status marker. */
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
  veneerTeeth,
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


  const crownCount = crownTeeth?.size ?? 0;
  const ponticCount = ponticTeeth?.size ?? 0;
  const veneerCount = veneerTeeth?.size ?? 0;
  const missingCount = missingTeeth?.size ?? 0;
  const hasCrown = crownCount > 0;
  const hasPontic = ponticCount > 0;
  const hasMissing = missingCount > 0;
  const hasHighlighted = (highlighted?.size ?? 0) > 0;
  const hasTyped = hasCrown || hasPontic || hasMissing || veneerCount > 0;
  const hasBridgeState = !!onConnectedPairsChange || (connectedPairs?.size ?? 0) > 0;

  const counts: { key: string; label: string }[] = [];
  if (hasCrown) counts.push({ key: "crown", label: `${crownCount} ${crownCount === 1 ? "crown" : "crowns"}` });
  if (hasPontic) counts.push({ key: "pontic", label: `${ponticCount} ${ponticCount === 1 ? "pontic" : "pontics"}` });
  if (veneerCount) counts.push({ key: "veneer", label: `${veneerCount} ${veneerCount === 1 ? "veneer" : "veneers"}` });
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
          <View style={[styles.legendSwatch, { backgroundColor: "#0F766E" }]} />
          <Text style={styles.legendText}>Veneer</Text>
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
        viewBox="0 -14 400 514"
        preserveAspectRatio="xMidYMid meet"
        width="100%"
        style={styles.svg}
      >

        <SvgText x={CHART.cx} y={150} textAnchor="middle" fontSize={11} fontWeight="700" fill="#6B6556">UPPER</SvgText>
        <SvgText x={CHART.cx} y={385} textAnchor="middle" fontSize={11} fontWeight="700" fill="#6B6556">LOWER</SvgText>
        {counts.map((c, i) => (
          <SvgText key={`hud-${c.key}`} x={CHART.cx} y={240 + i * 14} textAnchor="middle" fontSize={10.5} fontWeight="700" fill="#374151">{c.label}</SvgText>
        ))}
        <SvgText x={8} y={16} textAnchor="start" fontSize={10} fontWeight="700" fill="#6B6556">PATIENT RIGHT</SvgText>
        <SvgText x={392} y={16} textAnchor="end" fontSize={10} fontWeight="700" fill="#6B6556">PATIENT LEFT</SvgText>

        {/* Adult teeth */}
        {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => {
          const g = adultToothGeometry(n);
          const spriteSize = atlasDrawSize(n);
          const id = String(n);
          const isSelected = selected?.has(id) ?? false;
          const isBilled = billedTeeth?.has(id) ?? false;
          const resolved = resolveToothType(id, crownTeeth, ponticTeeth, missingTeeth, highlighted);
          const toothType: ToothType | undefined = !resolved && veneerTeeth?.has(id) ? "veneer" : resolved;
          const role: ToothRole = toothType === "highlighted" || !toothType ? "unassigned" : toothType;
          const style = ROLE_STYLE[role];
          const highlightedOnly = toothType === "highlighted";
                    const stroke = highlightedOnly ? colors.tint : style.stroke;
          const badge = style.badge;
          const half = CHART.toothHeight / 2;
          const bx = g.x + g.nx * (half + 1);
          const by = g.y + g.ny * (half + 1);
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
              {interactive && <Circle cx={g.x} cy={g.y} r={half} fill="transparent" />}
              <G testID={`tooth-body-${id}`} opacity={role === "missing" ? 0.7 : 1}>
                {isSelected && <Ellipse testID={`tooth-selection-${id}`} cx={g.x} cy={g.y} rx={half + 3} ry={half + 3} fill="none" stroke={SELECT_COLOR} strokeWidth={3} />}
                <Svg x={g.x - spriteSize / 2} y={g.y - spriteSize / 2} width={spriteSize} height={spriteSize}
                  viewBox={`${atlasCell(id).col * ATLAS.cell} ${atlasCell(id).row * ATLAS.cell} ${ATLAS.cell} ${ATLAS.cell}`}>
                  <SvgImage href={TOOTH_ATLAS[role] ?? TOOTH_ATLAS.unassigned} x={0} y={0} width={ATLAS.cols * ATLAS.cell} height={ATLAS.rows * ATLAS.cell} preserveAspectRatio="none" />
                </Svg>
                {isBilled && <Circle testID={`tooth-billed-${id}`} cx={g.x + 15} cy={g.y + 15} r={3} fill={colors.successStrong} stroke="#fff" strokeWidth={1} />}
                {highlightedOnly && <Ellipse cx={g.x} cy={g.y} rx={half} ry={half} fill="none" stroke={colors.tint} strokeWidth={2.5} />}
                {role === "pontic" && <Ellipse cx={g.x} cy={g.y} rx={half + 1} ry={half - 1} fill="none" stroke={stroke} strokeWidth={1.6} strokeDasharray="3 2" />}
              </G>
              {role === "missing" && (
                <Path d={`M${g.x - 7} ${g.y - 16} L${g.x + 7} ${g.y - 6} M${g.x + 7} ${g.y - 16} L${g.x - 7} ${g.y - 6}`} stroke="#6B7280" strokeWidth={2} strokeLinecap="round" />
              )}
              <SvgText x={g.x} y={g.y + (role === "missing" ? 6 : 1)} textAnchor="middle" alignmentBaseline="central" fontSize={15} fontWeight="800" stroke={role === "unassigned" || role === "missing" ? "rgba(255,255,255,.9)" : "rgba(20,10,40,.75)"} strokeWidth={2.6} fill={highlightedOnly || role === "unassigned" || role === "missing" ? "#1F1A12" : "#FFFFFF"}>
                {id}
              </SvgText>
              {!!badge && (
                <G>
                  <Circle cx={bx} cy={by} r={7.5} fill={style.stroke} stroke="#fff" strokeWidth={1.2} />
                  <SvgText x={bx} y={by + 0.5} textAnchor="middle" alignmentBaseline="central" fontSize={9.5} fontWeight="800" fill="#fff">{badge}</SvgText>
                </G>
              )}
            </G>
          );
        })}

        {/* Active bridge spans sit behind the tooth shapes. */}
        {Array.from(connectedPairs ?? []).map((pair) => {
          const [a, b] = pair.split("-").map(Number);
          if (!Number.isInteger(a) || b !== a + 1 || a === 16 || a < 1 || b > 32) return null;
          const c = connectorGeometry(a, b);
          if (b === 16 || b === 32 || !connectedPairs?.has(`${b}-${b + 1}`)) return null;
          const next = connectorGeometry(b, b + 1);
          return (
            <Path
              key={`bridge-span-${pair}`}
              testID={`bridge-span-${pair}`}
              d={`M ${c.x} ${c.y} L ${next.x} ${next.y}`}
              fill="none"
              stroke={connectorSuggestions?.has(pair) ? colors.warningStrong : colors.success}
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={0.95}
            />
          );
        })}

        {/* Connectors: outside the teeth, last, with 30-unit hit targets */}
        {adjacentPairs().map(([n, m]) => {
          const key = `${n}-${m}`;
          const active = connectedPairs?.has(key) ?? false;
          const assigned =
            (crownTeeth?.has(String(n)) || ponticTeeth?.has(String(n))) &&
            (crownTeeth?.has(String(m)) || ponticTeeth?.has(String(m)));
          if (!active && !assigned) return null;
          const c = connectorGeometry(n, m);
          const suggested = connectorSuggestions?.has(key);
          const color = active ? colors.success : "#64748B";
          return (
            <G
              key={`connector-${key}`}
              accessible={Platform.OS !== "web" && (showConnectors || active)}
              accessibilityRole={Platform.OS === "web" ? undefined : showConnectors ? "button" : "image"}
              accessibilityLabel={
                active
                  ? `${suggested ? "Suggested" : "Connected"} teeth ${n} and ${m}`
                  : `Connect assigned teeth ${n} and ${m}`
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
              {showConnectors && <Circle cx={c.x} cy={c.y} r={CONNECTOR_HIT_RADIUS} fill="transparent" />}
              <Circle cx={c.x} cy={c.y} r={CONNECTOR_RADIUS + 1.5} fill="#fff" />
              <Circle testID={`connector-marker-${key}`} cx={c.x} cy={c.y} r={CONNECTOR_RADIUS} fill={active ? color : "#fff"} stroke={color} strokeWidth={2} />
              <Path d={active ? `M${c.x - 3} ${c.y} L${c.x + 3} ${c.y}` : `M${c.x - 3} ${c.y} L${c.x + 3} ${c.y} M${c.x} ${c.y - 3} L${c.x} ${c.y + 3}`} stroke={active ? "#fff" : color} strokeWidth={1.8} strokeLinecap="round" />
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
