// Optional outgoing-photo capture flow, shown after a case (or a batch of
// cases) is scanned/located to the "Complete" station.
//
// Two phases:
//   1. "prompt"  — a single Yes/No question. No → onDone() immediately; the
//      completion itself already happened and is never blocked by photos.
//   2. "capture" — steps through the given cases in order. Each photo is
//      captured with the camera, resized (ImageManipulator, per existing
//      convention), and pushed through the existing upload → attach pipeline
//      with category "outgoing" so it lands in Files + History with the
//      outgoing label on both mobile and desktop.
//
// The component renders nothing when `cases` is empty, so hosts can keep it
// mounted unconditionally.
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";

export interface OutgoingPhotoCase {
  caseId: string;
  patientName: string;
  caseNumber: string | null;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function outgoingPromptTitle(caseCount: number): string {
  return caseCount > 1
    ? "Take photos of the outgoing cases?"
    : "Take a photo of the outgoing case?";
}

export function outgoingPhotoFileName(
  caseNumber: string | null,
  now: number = Date.now(),
): string {
  const base = caseNumber ? `case-${caseNumber}` : "case";
  // Strip anything that isn't filename-safe from the case number.
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `outgoing-${safe}-${now}.jpg`;
}

/**
 * Label for the secondary (advance) button in the capture phase.
 * - Not the last case: "Skip case" until a photo was taken, then "Next case".
 * - Last case: "Done" — returns the user to the normal flow.
 */
export function advanceButtonLabel(opts: {
  isLast: boolean;
  photoCount: number;
}): string {
  if (opts.isLast) return "Done";
  return opts.photoCount > 0 ? "Next case" : "Skip case";
}

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  /** Cases to photograph, in scan order. Empty array = modal hidden. */
  cases: OutgoingPhotoCase[];
  /** Called when the flow finishes — declined, skipped, or completed. */
  onDone: () => void;
};

export function OutgoingPhotosModal({ cases, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<"prompt" | "capture">("prompt");
  const [index, setIndex] = useState(0);
  const [photoCount, setPhotoCount] = useState(0);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const visible = cases.length > 0;

  // Reset all flow state whenever a new batch of cases arrives.
  const flowKey = cases.map((c) => c.caseId).join("|");
  useEffect(() => {
    setPhase("prompt");
    setIndex(0);
    setPhotoCount(0);
    setTotalPhotos(0);
    setUploading(false);
    setProgress(0);
  }, [flowKey]);

  if (!visible) return null;

  const current = cases[Math.min(index, cases.length - 1)]!;
  const isLast = index >= cases.length - 1;
  const isBatch = cases.length > 1;

  async function finish() {
    if (totalPhotos > 0) {
      // Refresh case detail + attachments so Files/History show the new
      // photos immediately when the user navigates there.
      await queryClient
        .invalidateQueries({ queryKey: ["cases"] })
        .catch(() => {});
    }
    onDone();
  }

  function advance() {
    if (uploading) return;
    if (isLast) {
      void finish();
      return;
    }
    setIndex((i) => i + 1);
    setPhotoCount(0);
  }

  async function takePhoto() {
    if (uploading) return;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!(perm.granted || perm.status === "granted")) {
        Alert.alert(
          "Camera permission needed",
          "Enable camera access in Settings to take photos.",
        );
        return;
      }
      const res = await ImagePicker.launchCameraAsync({
        quality: 0.85,
        mediaTypes: ["images"],
      });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return;

      setUploading(true);
      setProgress(0);
      try {
        // Resize before upload per existing convention — raw camera output is
        // 4–8 MB and stalls the chunked upload for no benefit.
        const resized = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1200 } }],
          { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
        );
        const result = await uploadCaseAttachment({
          caseId: current.caseId,
          fileUri: resized.uri,
          fileName: outgoingPhotoFileName(current.caseNumber),
          mimeType: "image/jpeg",
          category: "outgoing",
          onProgress: setProgress,
        });
        if (!result.ok) {
          Alert.alert("Upload failed", result.error);
          return;
        }
        setPhotoCount((n) => n + 1);
        setTotalPhotos((n) => n + 1);
      } finally {
        setUploading(false);
      }
    } catch (e) {
      setUploading(false);
      Alert.alert(
        "Couldn't take photo",
        e instanceof Error ? e.message : "Please try again.",
      );
    }
  }

  const styles = makeStyles(colors);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => void finish()}>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            { marginBottom: Math.max(insets.bottom, Spacing.lg) },
          ]}
          testID="outgoing-photos-modal"
        >
          {phase === "prompt" ? (
            <>
              <View style={styles.iconWrap}>
                <Ionicons name="camera-outline" size={28} color={colors.tint} />
              </View>
              <Text style={styles.title}>{outgoingPromptTitle(cases.length)}</Text>
              <Text style={styles.subtitle}>
                {isBatch
                  ? `Optional — document the condition of the ${cases.length} completed cases as they leave the lab.`
                  : "Optional — document the condition of the completed case as it leaves the lab."}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  style={[styles.secondaryBtn, { borderColor: colors.border }]}
                  onPress={() => void finish()}
                  testID="outgoing-photos-decline"
                >
                  <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>
                    No thanks
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryBtn, { backgroundColor: colors.tint }]}
                  onPress={() => setPhase("capture")}
                  testID="outgoing-photos-accept"
                >
                  <Text style={[styles.primaryBtnText, { color: colors.textInverse }]}>
                    Yes
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              {isBatch ? (
                <Text style={styles.stepCounter} testID="outgoing-photos-step">
                  Case {index + 1} of {cases.length}
                </Text>
              ) : null}
              <Text style={styles.title} numberOfLines={1} testID="outgoing-photos-patient">
                {current.patientName}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {current.caseNumber ? `Case #${current.caseNumber}` : "No case #"}
              </Text>

              {uploading ? (
                <View style={styles.uploadRow}>
                  <ActivityIndicator size="small" color={colors.tint} />
                  <Text style={[styles.uploadText, { color: colors.textSecondary }]}>
                    Uploading… {Math.round(progress * 100)}%
                  </Text>
                </View>
              ) : photoCount > 0 ? (
                <View style={styles.uploadRow}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                  <Text style={[styles.uploadText, { color: colors.textSecondary }]}>
                    {photoCount} photo{photoCount === 1 ? "" : "s"} saved to this case
                  </Text>
                </View>
              ) : null}

              <Pressable
                style={[
                  styles.primaryBtn,
                  styles.captureBtn,
                  { backgroundColor: uploading ? colors.border : colors.tint },
                ]}
                onPress={() => void takePhoto()}
                disabled={uploading}
                testID="outgoing-photos-take"
              >
                <Ionicons name="camera" size={18} color={colors.textInverse} />
                <Text style={[styles.primaryBtnText, { color: colors.textInverse }]}>
                  {photoCount > 0 ? "Add another photo" : "Take photo"}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.secondaryBtn, styles.advanceBtn, { borderColor: colors.border }]}
                onPress={advance}
                disabled={uploading}
                testID="outgoing-photos-advance"
              >
                <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>
                  {advanceButtonLabel({ isLast, photoCount })}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.lg,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      borderRadius: Radius.xl,
      backgroundColor: colors.surface,
      padding: Spacing.lg,
      gap: Spacing.sm,
      alignItems: "center",
    },
    iconWrap: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.tint + "18",
    },
    stepCounter: {
      ...Typography.caption,
      color: colors.textTertiary,
    },
    title: {
      ...Typography.h2,
      color: colors.text,
      textAlign: "center",
    },
    subtitle: {
      ...Typography.body,
      color: colors.textSecondary,
      textAlign: "center",
    },
    uploadRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginTop: Spacing.xs,
    },
    uploadText: {
      ...Typography.caption,
    },
    actions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.md,
      alignSelf: "stretch",
    },
    primaryBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
    },
    captureBtn: {
      alignSelf: "stretch",
      flexDirection: "row",
      gap: Spacing.xs,
      marginTop: Spacing.md,
    },
    primaryBtnText: {
      ...Typography.bodySemibold,
    },
    secondaryBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
    },
    advanceBtn: {
      alignSelf: "stretch",
      flex: 0,
    },
    secondaryBtnText: {
      ...Typography.bodySemibold,
    },
  });
}
