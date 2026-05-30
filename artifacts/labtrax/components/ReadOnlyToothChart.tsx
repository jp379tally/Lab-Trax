import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import type { ToothId } from "@/lib/rx-summary";

/**
 * Read-only mobile mirror of the desktop ToothChart
 * (`artifacts/labtrax-desktop/src/components/ToothChart.tsx`). Renders
 * adult permanent teeth in the standard ADA layout, with any tooth in
 * `highlighted` shown in the primary brand color.
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

type Styles = ReturnType<typeof makeStyles>;

interface Props {
  highlighted: Set<ToothId>;
}

function Tooth({ id, on, styles }: { id: string; on: boolean; styles: Styles }) {
  return (
    <View style={[styles.tooth, on ? styles.toothOn : styles.toothOff]}>
      <Text style={[styles.toothText, on && styles.toothTextOn]}>{id}</Text>
    </View>
  );
}

function Row({ left, right, highlighted, styles }: { left: string[]; right: string[]; highlighted: Set<string>; styles: Styles }) {
  return (
    <View style={styles.row}>
      <View style={styles.half}>
        {left.map((id) => (
          <Tooth key={id} id={id} on={highlighted.has(id)} styles={styles} />
        ))}
      </View>
      <View style={styles.divider} />
      <View style={styles.half}>
        {right.map((id) => (
          <Tooth key={id} id={id} on={highlighted.has(id)} styles={styles} />
        ))}
      </View>
    </View>
  );
}

export function ReadOnlyToothChart({ highlighted }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Tooth chart</Text>
        <View style={styles.legend}>
          <View style={[styles.legendSwatch, { backgroundColor: colors.tint }]} />
          <Text style={styles.legendText}>Highlighted</Text>
        </View>
      </View>
      <Row left={ADULT_UPPER_RIGHT} right={ADULT_UPPER_LEFT} highlighted={highlighted} styles={styles} />
      <View style={styles.midline} />
      <Row
        left={ADULT_LOWER_RIGHT.slice().reverse()}
        right={ADULT_LOWER_LEFT.slice().reverse()}
        highlighted={highlighted}
        styles={styles}
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
  toothOn: {
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
  toothTextOn: {
    color: colors.textInverse,
  },
});
