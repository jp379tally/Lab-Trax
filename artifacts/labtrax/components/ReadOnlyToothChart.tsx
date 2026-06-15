import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import type { ToothId } from "@/lib/rx-summary";

/**
 * Read-only mobile mirror of the desktop ToothChart
 * (`artifacts/labtrax-desktop/src/components/ToothChart.tsx`). Renders
 * adult permanent teeth in the standard ADA layout.
 *
 * Tooth type colors (matching the desktop):
 *   crown      → blue  (#3B82F6)
 *   pontic     → purple (#A855F7)
 *   missing    → muted gray + ✕ glyph
 *   highlighted → brand tint (legacy fallback)
 *
 * Layout (looking at the patient):
 *   Upper:  1 .. 8  |  9 ..16
 *   Lower: 32 ..25  | 24 ..17   (mirrored so each adult sits under its
 *                                 same-side counterpart)
 */

const ADULT_UPPER_RIGHT = ["1", "2", "3", "4", "5", "6", "7", "8"];
const ADULT_UPPER_LEFT = ["9", "10", "11", "12", "13", "14", "15", "16"];
const ADULT_LOWER_LEFT = ["17", "18", "19", "20", "21", "22", "23", "24"];
const ADULT_LOWER_RIGHT = ["25", "26", "27", "28", "29", "30", "31", "32"];

const COLOR_CROWN = "#3B82F6";
const COLOR_PONTIC = "#A855F7";

type ToothType = "crown" | "pontic" | "missing" | "highlighted";

type Styles = ReturnType<typeof makeStyles>;

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

function Tooth({
  id,
  toothType,
  styles,
  colors,
}: {
  id: string;
  toothType: ToothType | undefined;
  styles: Styles;
  colors: ThemeColors;
}) {
  const label = toothType === "missing" ? "✕" : id;

  const boxStyle =
    toothType === "crown"
      ? styles.toothCrown
      : toothType === "pontic"
        ? styles.toothPontic
        : toothType === "missing"
          ? styles.toothMissing
          : toothType === "highlighted"
            ? [styles.toothHighlighted, { backgroundColor: colors.tint, borderColor: colors.tint }]
            : styles.toothOff;

  const textStyle =
    toothType === "crown" || toothType === "pontic"
      ? styles.toothTextWhite
      : toothType === "missing"
        ? styles.toothTextMissing
        : toothType === "highlighted"
          ? styles.toothTextWhite
          : styles.toothText;

  return (
    <View style={[styles.tooth, boxStyle]}>
      <Text style={[styles.toothText, textStyle]}>{label}</Text>
    </View>
  );
}

function Row({
  left,
  right,
  crownTeeth,
  ponticTeeth,
  missingTeeth,
  highlighted,
  styles,
  colors,
}: {
  left: string[];
  right: string[];
  crownTeeth: Set<ToothId> | undefined;
  ponticTeeth: Set<ToothId> | undefined;
  missingTeeth: Set<ToothId> | undefined;
  highlighted: Set<ToothId> | undefined;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.half}>
        {left.map((id) => (
          <Tooth
            key={id}
            id={id}
            toothType={resolveToothType(id, crownTeeth, ponticTeeth, missingTeeth, highlighted)}
            styles={styles}
            colors={colors}
          />
        ))}
      </View>
      <View style={styles.divider} />
      <View style={styles.half}>
        {right.map((id) => (
          <Tooth
            key={id}
            id={id}
            toothType={resolveToothType(id, crownTeeth, ponticTeeth, missingTeeth, highlighted)}
            styles={styles}
            colors={colors}
          />
        ))}
      </View>
    </View>
  );
}

export function ReadOnlyToothChart({
  crownTeeth,
  ponticTeeth,
  missingTeeth,
  highlighted,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const hasCrown = (crownTeeth?.size ?? 0) > 0;
  const hasPontic = (ponticTeeth?.size ?? 0) > 0;
  const hasMissing = (missingTeeth?.size ?? 0) > 0;
  const hasHighlighted = (highlighted?.size ?? 0) > 0;
  const hasTyped = hasCrown || hasPontic || hasMissing;

  const rowProps = { crownTeeth, ponticTeeth, missingTeeth, highlighted, styles, colors };

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
              <View style={[styles.legendSwatch, { backgroundColor: COLOR_PONTIC, marginLeft: hasCrown ? 6 : 0 }]} />
              <Text style={styles.legendText}>Pontic</Text>
            </>
          )}
          {hasMissing && (
            <>
              <View style={[styles.legendSwatchMissing, { marginLeft: hasTyped && !hasMissing ? 6 : hasCrown || hasPontic ? 6 : 0 }]} />
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
      <Row left={ADULT_UPPER_RIGHT} right={ADULT_UPPER_LEFT} {...rowProps} />
      <View style={styles.midline} />
      <Row
        left={ADULT_LOWER_RIGHT.slice().reverse()}
        right={ADULT_LOWER_LEFT.slice().reverse()}
        {...rowProps}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "rgba(0,0,0,0.02)",
    gap: 6,
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
    borderRadius: 2,
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  half: {
    flexDirection: "row",
    gap: 2,
  },
  divider: {
    width: 1,
    height: 22,
    backgroundColor: "rgba(0,0,0,0.15)",
    marginHorizontal: 4,
  },
  midline: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.08)",
    marginVertical: 2,
  },
  tooth: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  toothCrown: {
    backgroundColor: COLOR_CROWN,
    borderColor: COLOR_CROWN,
  },
  toothPontic: {
    backgroundColor: COLOR_PONTIC,
    borderColor: COLOR_PONTIC,
  },
  toothMissing: {
    backgroundColor: "rgba(0,0,0,0.08)",
    borderColor: "rgba(0,0,0,0.25)",
  },
  toothHighlighted: {
    backgroundColor: colors.tint,
    borderColor: colors.tint,
  },
  toothOff: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderColor: "transparent",
  },
  toothText: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: colors.text,
  },
  toothTextWhite: {
    color: "#FFFFFF",
  },
  toothTextMissing: {
    color: "rgba(0,0,0,0.5)",
    fontSize: 10,
  },
});
