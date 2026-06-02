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
} from "@/lib/offline-queue";

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
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { pendingSyncCount, stuckSyncItems, retrySync, discardSync, cases } =
    useApp();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [detailOpen, setDetailOpen] = useState(false);

  const stuckCount = stuckSyncItems.length;
  const paddingTop = insets.top > 0 ? insets.top : Platform.OS === "android" ? 8 : 8;

  // Resolve a human-readable case label (number + patient) from the loaded
  // cases, falling back gracefully when the case isn't in memory.
  const describeCase = (caseId: string): { title: string; subtitle?: string } => {
    const match = cases.find((c) => c.id === caseId);
    if (!match) {
      return { title: "Unknown case" };
    }
    const number = match.caseNumber ? `#${match.caseNumber}` : "Case";
    const patient = match.patientName?.trim();
    return {
      title: patient ? `${number} \u00b7 ${patient}` : number,
      subtitle: match.doctorName?.trim() || undefined,
    };
  };

  const confirmDiscardOne = (item: StuckQueueItem) => {
    const { title } = describeCase(item.caseId);
    Alert.alert(
      "Discard this change?",
      `The ${TYPE_LABELS[item.type].toLowerCase()} for ${title} will be permanently removed and won't be saved to the server.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => discardSync(item.id),
        },
      ]
    );
  };

  const confirmDiscardAll = () => {
    const single = stuckCount === 1;
    Alert.alert(
      single ? "Discard this change?" : "Discard all changes?",
      single
        ? "This offline change will be permanently removed and won't be saved to the server."
        : `All ${stuckCount} offline changes will be permanently removed and won't be saved to the server.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            for (const item of stuckSyncItems) {
              discardSync(item.id);
            }
          },
        },
      ]
    );
  };

  // Some offline changes have repeatedly failed to sync — warn the user and
  // offer a way to see, retry, or discard each one individually so a wedged
  // item stops blocking the rest of the queue.
  if (stuckCount > 0) {
    const label =
      stuckCount === 1
        ? "1 change couldn't sync"
        : `${stuckCount} changes couldn't sync`;
    const reason = stuckReason(stuckSyncItems);

    return (
      <>
        <Pressable
          onPress={() => setDetailOpen(true)}
          style={({ pressed }) => [
            styles.errorContainer,
            { paddingTop },
            pressed && styles.bannerPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${label}. ${reason} Tap to see details.`}
        >
          <Ionicons
            name="alert-circle-outline"
            size={16}
            color={colors.errorText}
            style={styles.icon}
          />
          <View style={styles.errorTextColumn}>
            <Text style={styles.errorText} numberOfLines={1}>
              {label}
            </Text>
            <Text style={styles.errorReason} numberOfLines={2}>
              {reason}
            </Text>
          </View>
          <Text style={styles.detailsHint}>Details</Text>
          <Ionicons
            name="chevron-forward"
            size={14}
            color={colors.errorText}
            style={styles.icon}
          />
        </Pressable>

        <Modal
          visible={detailOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setDetailOpen(false)}
        >
          <View style={styles.modalOverlay}>
            <Pressable
              style={styles.modalBackdrop}
              onPress={() => setDetailOpen(false)}
              accessibilityLabel="Close"
            />
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
              <View style={styles.sheetHeader}>
                <View style={styles.sheetHeaderText}>
                  <Text style={styles.sheetTitle}>Changes that couldn't sync</Text>
                  <Text style={styles.sheetSubtitle}>
                    {stuckCount === 1
                      ? "1 item is stuck. Retry or discard it below."
                      : `${stuckCount} items are stuck. Retry or discard them below.`}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setDetailOpen(false)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.closeButton,
                    pressed && styles.actionPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={20} color={colors.textSecondary} />
                </Pressable>
              </View>

              <ScrollView
                style={styles.itemList}
                contentContainerStyle={styles.itemListContent}
              >
                {stuckSyncItems.map((item) => {
                  const { title, subtitle } = describeCase(item.caseId);
                  return (
                    <View key={item.id} style={styles.itemCard}>
                      <View style={styles.itemTop}>
                        <Ionicons
                          name={TYPE_ICONS[item.type]}
                          size={18}
                          color={colors.errorText}
                          style={styles.itemIcon}
                        />
                        <View style={styles.itemInfo}>
                          <Text style={styles.itemTitle} numberOfLines={1}>
                            {title}
                          </Text>
                          {subtitle ? (
                            <Text style={styles.itemSubtitle} numberOfLines={1}>
                              {subtitle}
                            </Text>
                          ) : null}
                        </View>
                        <View style={styles.typeBadge}>
                          <Text style={styles.typeBadgeText}>
                            {TYPE_LABELS[item.type]}
                          </Text>
                        </View>
                      </View>

                      <Text style={styles.itemMeta}>
                        {item.attempts === 1
                          ? "Failed after 1 attempt"
                          : `Failed after ${item.attempts} attempts`}
                      </Text>
                      {item.lastError ? (
                        <Text style={styles.itemError} numberOfLines={3}>
                          {item.lastError}
                        </Text>
                      ) : null}

                      <View style={styles.itemActions}>
                        <Pressable
                          onPress={() => retrySync(item.id)}
                          hitSlop={6}
                          style={({ pressed }) => [
                            styles.itemAction,
                            pressed && styles.actionPressed,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={`Retry ${TYPE_LABELS[item.type].toLowerCase()} for ${title}`}
                        >
                          <Ionicons
                            name="refresh"
                            size={14}
                            color={colors.errorText}
                          />
                          <Text style={styles.itemActionText}>Retry</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => confirmDiscardOne(item)}
                          hitSlop={6}
                          style={({ pressed }) => [
                            styles.itemAction,
                            pressed && styles.actionPressed,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={`Discard ${TYPE_LABELS[item.type].toLowerCase()} for ${title}`}
                        >
                          <Ionicons
                            name="trash-outline"
                            size={14}
                            color={colors.textSecondary}
                          />
                          <Text style={styles.itemDiscardText}>Discard</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>

              <View style={styles.bulkActions}>
                <Pressable
                  onPress={() => retrySync()}
                  style={({ pressed }) => [
                    styles.bulkButton,
                    styles.bulkRetry,
                    pressed && styles.actionPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Retry all changes that couldn't sync"
                >
                  <Ionicons name="refresh" size={16} color={colors.textInverse} />
                  <Text style={styles.bulkRetryText}>Retry all</Text>
                </Pressable>
                <Pressable
                  onPress={confirmDiscardAll}
                  style={({ pressed }) => [
                    styles.bulkButton,
                    styles.bulkDiscard,
                    pressed && styles.actionPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Discard all changes that couldn't sync"
                >
                  <Text style={styles.bulkDiscardText}>Discard all</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </>
    );
  }

  if (pendingSyncCount <= 0) {
    return null;
  }

  const label =
    pendingSyncCount === 1
      ? "1 offline change waiting to sync\u2026"
      : `${pendingSyncCount} offline changes waiting to sync\u2026`;

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Ionicons
        name="cloud-upload-outline"
        size={15}
        color={colors.info}
        style={styles.icon}
      />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.infoLight,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.info,
      paddingHorizontal: 12,
      paddingBottom: 8,
      gap: 6,
    },
    errorContainer: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.errorLight,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.error,
      paddingHorizontal: 12,
      paddingBottom: 8,
      gap: 6,
    },
    bannerPressed: {
      opacity: 0.75,
    },
    icon: {
      flexShrink: 0,
    },
    text: {
      flex: 1,
      fontSize: 12,
      fontFamily: "Inter_500Medium",
      color: colors.info,
    },
    errorTextColumn: {
      flex: 1,
      gap: 1,
    },
    errorText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorText,
    },
    errorReason: {
      fontSize: 11,
      fontFamily: "Inter_500Medium",
      color: colors.errorText,
      opacity: 0.85,
    },
    detailsHint: {
      flexShrink: 0,
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorText,
    },
    // ─── Detail sheet ─────────────────────────────────────────────────────────
    modalOverlay: {
      flex: 1,
      justifyContent: "flex-end",
    },
    modalBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.4)",
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: 16,
      paddingTop: 16,
      maxHeight: "80%",
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      marginBottom: 12,
    },
    sheetHeaderText: {
      flex: 1,
    },
    sheetTitle: {
      fontSize: 16,
      fontFamily: "Inter_600SemiBold",
      color: colors.text,
    },
    sheetSubtitle: {
      marginTop: 2,
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.textSecondary,
    },
    closeButton: {
      flexShrink: 0,
      padding: 4,
      borderRadius: 8,
    },
    itemList: {
      flexGrow: 0,
    },
    itemListContent: {
      gap: 10,
      paddingBottom: 12,
    },
    itemCard: {
      backgroundColor: colors.surfaceSecondary,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 12,
      gap: 6,
    },
    itemTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    itemIcon: {
      flexShrink: 0,
    },
    itemInfo: {
      flex: 1,
    },
    itemTitle: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.text,
    },
    itemSubtitle: {
      marginTop: 1,
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.textSecondary,
    },
    typeBadge: {
      flexShrink: 0,
      backgroundColor: colors.errorLight,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    typeBadgeText: {
      fontSize: 11,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorText,
    },
    itemMeta: {
      fontSize: 12,
      fontFamily: "Inter_500Medium",
      color: colors.textSecondary,
    },
    itemError: {
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.errorText,
    },
    itemActions: {
      flexDirection: "row",
      gap: 8,
      marginTop: 4,
    },
    itemAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    itemActionText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorText,
    },
    itemDiscardText: {
      fontSize: 12,
      fontFamily: "Inter_500Medium",
      color: colors.textSecondary,
    },
    actionPressed: {
      opacity: 0.6,
    },
    action: {
      flexShrink: 0,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
    },
    bulkActions: {
      flexDirection: "row",
      gap: 10,
      marginTop: 4,
    },
    bulkButton: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 12,
      borderRadius: 10,
    },
    bulkRetry: {
      backgroundColor: colors.errorStrong,
    },
    bulkRetryText: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.textInverse,
    },
    bulkDiscard: {
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    bulkDiscardText: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.textSecondary,
    },
  });
