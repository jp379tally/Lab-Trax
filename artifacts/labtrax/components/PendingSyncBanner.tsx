import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Alert,
  Modal,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useApp } from "@/lib/app-context";
import {
  messageForCategory,
  type StuckQueueItem,
  type SyncFailureCategory,
} from "@/lib/sync-types";

const TYPE_LABELS: Record<StuckQueueItem["type"], string> = {
  photo: "Photo",
  note: "Note",
  status: "Station move",
};

const TYPE_ICONS: Record<StuckQueueItem["type"], keyof typeof Ionicons.glyphMap> = {
  photo: "image-outline",
  note: "chatbubble-ellipses-outline",
  status: "swap-horizontal-outline",
};

// Build a single plain-language reason for the stuck items. A permanent
// rejection (the lab said no) is more actionable than "lost connection", so it
// wins when the stuck items are a mix. Falls back to the per-item lastError
// message, then to a generic line.
function stuckReason(items: StuckQueueItem[]): string {
  if (items.length === 0) return "";
  const order: SyncFailureCategory[] = [
    "rejected",
    "validation",
    "server",
    "network",
  ];
  const present = new Set(
    items
      .map((i) => i.lastErrorCategory)
      .filter((c): c is SyncFailureCategory => !!c)
  );
  for (const category of order) {
    if (present.has(category)) return messageForCategory(category);
  }
  return items[0].lastError ?? "Couldn't reach the server";
}


export function PendingSyncBanner() {
  return null;
}
