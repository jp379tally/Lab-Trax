import React from "react";
import { View, Text, StyleSheet } from "react-native";

/** Letters the shared case-type badge knows how to render. */
export type TypeBadgeLetter = "C" | "D" | "O";

const BADGE_STYLE_KEYS = {
  C: { badge: "badgeC", text: "textC" },
  D: { badge: "badgeD", text: "textD" },
  O: { badge: "badgeO", text: "textO" },
} as const;

/**
 * Small circular case-type indicator ("C" restorative / "D" removable /
 * "O" ortho & appliances). Shared by the Cases tab and Dashboard tab
 * case-preview cards so both render the same badge in the same position
 * (directly above the status badge) — do not fork this per screen.
 */
export function TypeBadge({ letter }: { letter: TypeBadgeLetter }) {
  const keys = BADGE_STYLE_KEYS[letter];
  return (
    <View style={[styles.badge, styles[keys.badge]]}>
      <Text style={[styles.text, styles[keys.text]]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 20,
    height: 20,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeC: { backgroundColor: "#DBEAFE" },
  badgeD: { backgroundColor: "#FEF3C7" },
  badgeO: { backgroundColor: "#EDE9FE" },
  text: { fontSize: 10, fontWeight: "700" as const },
  textC: { color: "#1D4ED8" },
  textD: { color: "#B45309" },
  textO: { color: "#6D28D9" },
});
