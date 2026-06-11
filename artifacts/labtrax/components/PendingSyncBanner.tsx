import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Modal,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import {
  type PendingUpload,
  usePendingUploads,
  requestRetryPendingUpload,
  requestDiscardPendingUpload,
} from "@/lib/pending-uploads";

// The persistent upload queue only ever holds case media (photos/videos), so a
// single label/icon pair covers every entry.
function typeLabel(item: PendingUpload): string {
  return item.isVid ? "Video" : "Photo";
}
function typeIcon(item: PendingUpload): keyof typeof Ionicons.glyphMap {
  return item.isVid ? "videocam-outline" : "image-outline";
}

// Parked uploads carry no per-item error detail — they are simply files whose
// chunked upload exhausted its in-session retries — so the reason is a single
// plain-language line shared across the queue.
const QUEUE_REASON = "Couldn't reach the server — will keep trying";

// Persistent indicator for case media that finished capture but is still
// parked in the upload retry queue (lib/pending-uploads.ts). It is purely a
// *visibility* layer over the existing queue — it reads the live queue snapshot
// directly from the pending-uploads helpers and drives the queue's own retry /
// discard handlers; it never uploads or mutates the queue itself. Mounted once
// at the authed root.
export function PendingSyncBanner() {
  const pendingUploads = usePendingUploads();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);

  // When the queue drains the banner disappears and the management sheet (which
  // is nested inside this component) unmounts with it — requirement: the
  // indicator must clear once everything has uploaded.
  if (pendingUploads.length <= 0) {
    return null;
  }

  const count = pendingUploads.length;
  const reason = QUEUE_REASON;
  const summary =
    count === 1
      ? "1 attachment still uploading"
      : `${count} attachments still uploading`;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${summary}. Tap to manage pending uploads.`}
        style={[
          styles.banner,
          { bottom: (insets.bottom > 0 ? insets.bottom : 12) + 64 },
        ]}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="cloud-upload-outline" size={20} color={colors.warningStrong ?? "#D97706"} />
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{count > 99 ? "99+" : count}</Text>
          </View>
        </View>
        <View style={styles.bannerTextWrap}>
          <Text style={styles.bannerTitle} numberOfLines={1}>
            {summary}
          </Text>
          <Text style={styles.bannerSubtitle} numberOfLines={1}>
            Not yet visible on web or desktop
          </Text>
        </View>
        <Ionicons name="chevron-up" size={18} color={colors.textSecondary} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        {open ? (
        <>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderText}>
              <Text style={styles.sheetTitle}>Waiting to upload</Text>
              <Text style={styles.sheetSubtitle}>
                These attachments are saved on this device and haven&apos;t
                reached the lab yet — they won&apos;t appear on web or desktop
                until they upload.
              </Text>
              {reason ? <Text style={styles.sheetReason}>{reason}</Text> : null}
            </View>
            <Pressable
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          <Pressable
            onPress={() => requestRetryPendingUpload()}
            accessibilityRole="button"
            accessibilityLabel="Retry all uploads"
            style={styles.retryAllBtn}
          >
            <Ionicons name="refresh" size={16} color={colors.tint ?? "#145DA0"} />
            <Text style={styles.retryAllText}>Retry all</Text>
          </Pressable>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {pendingUploads.map((item) => (
              <View key={item.id} style={styles.row}>
                <Ionicons
                  name={typeIcon(item)}
                  size={20}
                  color={colors.textSecondary}
                  style={styles.rowIcon}
                />
                <View style={styles.rowTextWrap}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {typeLabel(item)}
                    {item.attempts > 0
                      ? ` · ${item.attempts} ${item.attempts === 1 ? "try" : "tries"}`
                      : ""}
                  </Text>
                  <Text style={styles.rowReason} numberOfLines={2}>
                    {reason}
                  </Text>
                </View>
                <View style={styles.rowActions}>
                  <Pressable
                    onPress={() => requestRetryPendingUpload(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Retry now"
                    style={[styles.actionBtn, styles.retryBtn]}
                  >
                    <Text style={styles.retryBtnText}>Retry now</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => requestDiscardPendingUpload(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Discard"
                    style={[styles.actionBtn, styles.discardBtn]}
                  >
                    <Text style={styles.discardBtnText}>Discard</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
        </>
        ) : null}
      </Modal>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    banner: {
      position: "absolute",
      left: 16,
      right: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: colors.warningSurface ?? "#FFFBEB",
      borderWidth: 1,
      borderColor: colors.warningLight ?? "#FEF3C7",
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 14,
      zIndex: 9998,
      ...Platform.select({
        ios: {
          shadowColor: "#0F172A",
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.16,
          shadowRadius: 12,
        },
        android: { elevation: 5 },
        default: {},
      }),
    },
    iconWrap: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.warningLight ?? "#FEF3C7",
    },
    countBadge: {
      position: "absolute",
      top: -4,
      right: -4,
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      paddingHorizontal: 4,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.warningStrong ?? "#D97706",
    },
    countBadgeText: {
      color: "#FFFFFF",
      fontSize: 10,
      fontFamily: "Inter_700Bold",
      lineHeight: 14,
    },
    bannerTextWrap: {
      flex: 1,
    },
    bannerTitle: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.warningText ?? "#92400E",
    },
    bannerSubtitle: {
      fontSize: 12,
      fontFamily: "Inter_500Medium",
      color: colors.textSecondary,
      marginTop: 1,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(8,17,29,0.45)",
    },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: "80%",
      backgroundColor: colors.surface ?? "#FFFFFF",
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 10,
      paddingHorizontal: 16,
    },
    sheetHandle: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: 12,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
    },
    sheetHeaderText: {
      flex: 1,
    },
    sheetTitle: {
      fontSize: 18,
      fontFamily: "Inter_700Bold",
      color: colors.text,
    },
    sheetSubtitle: {
      fontSize: 13,
      lineHeight: 18,
      fontFamily: "Inter_500Medium",
      color: colors.textSecondary,
      marginTop: 4,
    },
    sheetReason: {
      fontSize: 13,
      lineHeight: 18,
      fontFamily: "Inter_600SemiBold",
      color: colors.warningText ?? "#92400E",
      marginTop: 8,
    },
    closeBtn: {
      padding: 4,
    },
    retryAllBtn: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      marginTop: 14,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: colors.tintLight ?? "#D9E9F7",
    },
    retryAllText: {
      fontSize: 13,
      fontFamily: "Inter_600SemiBold",
      color: colors.tintDark ?? colors.tint ?? "#0F4C81",
    },
    list: {
      marginTop: 12,
    },
    listContent: {
      gap: 10,
      paddingBottom: 8,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceSecondary ?? "#F7FAFC",
    },
    rowIcon: {
      flexShrink: 0,
    },
    rowTextWrap: {
      flex: 1,
    },
    rowTitle: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.text,
    },
    rowReason: {
      fontSize: 12,
      lineHeight: 16,
      fontFamily: "Inter_500Medium",
      color: colors.textSecondary,
      marginTop: 2,
    },
    rowActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 0,
    },
    actionBtn: {
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: 9,
    },
    retryBtn: {
      backgroundColor: colors.tint ?? "#145DA0",
    },
    retryBtnText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: "#FFFFFF",
    },
    discardBtn: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.errorLight ?? "#FEE2E2",
    },
    discardBtnText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.errorStrong ?? "#DC2626",
    },
  });
