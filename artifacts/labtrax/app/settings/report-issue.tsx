import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { File } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import {
  useMe,
  canAdminAnyLab,
  canAdminAnyProvider,
  primaryAdminProviderOrgId,
} from "@/lib/auth-me";
import {
  SUPPORT_REPORT_IMAGE_TYPES,
  type SupportReportAttachment,
  submitSupportReport,
  validateSupportReportAttachment,
} from "@/lib/support-reports";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Could not submit your report.";
}

async function fileSize(uri: string, fallback?: number | null): Promise<number> {
  if (typeof fallback === "number") return fallback;
  if (Platform.OS === "web") {
    return globalThis.fetch(uri).then((response) => response.blob()).then((blob) => blob.size);
  }
  return new File(uri).size;
}

export default function ReportIssueScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe();
  const labAdmin = canAdminAnyLab(me.data);
  const providerOrganizationId = primaryAdminProviderOrgId(me.data);
  const providerAdmin = canAdminAnyProvider(me.data);
  const { kind: kindParam } = useLocalSearchParams<{ kind?: string }>();
  const feedback = kindParam === "feedback";
  const activeMemberships = (me.data?.memberships ?? []).filter((m) => m.status === "active");
  const labMember = activeMemberships.some((m) => m.organization?.type === "lab");
  const feedbackProviderOrgId = activeMemberships.find((m) => m.organization?.type !== "lab")?.organization?.id ?? null;
  const useLab = feedback ? labMember : labAdmin;
  const providerOrgId = feedback ? feedbackProviderOrgId : providerOrganizationId;
  const eligible = feedback ? labMember || !!feedbackProviderOrgId : labAdmin || providerAdmin;
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<SupportReportAttachment[]>([]);
  const [preview, setPreview] = useState<SupportReportAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function add(next: SupportReportAttachment[]) {
    let accepted = [...attachments];
    let nextError: string | null = null;
    for (const candidate of next) {
      const validation = validateSupportReportAttachment(accepted, candidate);
      if (validation) {
        nextError = validation;
        continue;
      }
      accepted.push(candidate);
    }
    setAttachments(accepted);
    setError(nextError);
  }

  async function chooseScreenshots() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!(permission.granted || permission.status === "granted")) {
        Alert.alert("Photo access needed", "Enable photo library access in Settings to choose screenshots.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        mediaTypes: ["images"],
        quality: 1,
      });
      if (result.canceled) return;
      const picked = await Promise.all(result.assets.map(async (asset, index) => {
        const resized = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1600 } }],
          { compress: 0.88, format: ImageManipulator.SaveFormat.JPEG },
        );
        const name = (asset.fileName || `screenshot-${Date.now()}-${index}.jpg`).replace(/\.[^.]+$/, ".jpg");
        return { uri: resized.uri, name, mimeType: "image/jpeg", size: await fileSize(resized.uri) };
      }));
      add(picked);
    } catch (pickerError) {
      setError(message(pickerError));
    }
  }

  async function chooseFiles() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain"],
      });
      if (result.canceled) return;
      const picked = await Promise.all(result.assets.map(async (asset, index) => ({
        uri: asset.uri,
        name: asset.name || `attachment-${Date.now()}-${index}`,
        mimeType: asset.mimeType || "application/octet-stream",
        size: await fileSize(asset.uri, asset.size),
      })));
      add(picked);
    } catch (pickerError) {
      setError(message(pickerError));
    }
  }

  async function submit() {
    if (!description.trim()) {
      setError("Please describe the issue.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await submitSupportReport(
        description,
        attachments,
        useLab
          ? { portal: "lab" }
          : { portal: "provider", providerOrganizationId: providerOrgId! },
        feedback ? "feedback" : "issue",
      );
      setSubmitted(true);
    } catch (submissionError) {
      setError(message(submissionError));
    } finally {
      setSubmitting(false);
    }
  }

  if (me.isLoading) {
    return <View style={styles.center}><ActivityIndicator color={colors.tint} /></View>;
  }

  if (!eligible) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Ionicons name="lock-closed-outline" size={32} color={colors.textSecondary} />
        <Text style={styles.deniedTitle}>Administrator access required</Text>
        <Text style={styles.deniedText}>Issue reports can only be submitted by active lab or provider owners and administrators.</Text>
        <Pressable onPress={() => router.back()} style={styles.primaryButton} testID="report-issue-denied-back">
          <Text style={styles.primaryButtonText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <DismissKeyboardView
      style={[styles.screen, { paddingTop: insets.top }]}
      testID="report-issue-keyboard-dismiss"
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} testID="report-issue-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{feedback ? "Send Feedback" : "Report an Issue"}</Text>
        <View style={styles.headerSpacer} />
      </View>
      {submitted ? (
        <View style={styles.success} testID="report-issue-success">
          <Ionicons name="checkmark-circle" size={46} color={colors.success} />
          <Text style={styles.successTitle}>Report submitted</Text>
          <Text style={styles.successText}>Thank you for helping improve LabTrax.</Text>
          <Pressable onPress={() => router.back()} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={scrollKeyboardDismissMode}
        >
          <Text style={styles.intro}>Tell us what went wrong. You can attach up to 5 files (10 MiB total).</Text>
          <Text style={styles.label}>Description</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            editable={!submitting}
            multiline
            textAlignVertical="top"
            placeholder="Describe the problem and what you expected to happen"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            testID="report-issue-description"
          />
          <View style={styles.pickerRow}>
            <Pressable disabled={submitting} onPress={() => void chooseScreenshots()} style={styles.secondaryButton} testID="report-issue-pick-screenshots">
              <Ionicons name="images-outline" size={18} color={colors.tint} />
              <Text style={styles.secondaryButtonText}>Screenshots</Text>
            </Pressable>
            <Pressable disabled={submitting} onPress={() => void chooseFiles()} style={styles.secondaryButton} testID="report-issue-pick-files">
              <Ionicons name="document-attach-outline" size={18} color={colors.tint} />
              <Text style={styles.secondaryButtonText}>Files</Text>
            </Pressable>
          </View>
          {attachments.map((attachment, index) => (
            <View key={`${attachment.uri}-${index}`} style={styles.attachment} testID={`report-issue-attachment-${index}`}>
              <Pressable
                disabled={!SUPPORT_REPORT_IMAGE_TYPES.has(attachment.mimeType)}
                onPress={() => setPreview(attachment)}
                style={styles.attachmentPreview}
                testID={`report-issue-preview-${index}`}
              >
                {SUPPORT_REPORT_IMAGE_TYPES.has(attachment.mimeType) ? (
                  <Image source={{ uri: attachment.uri }} style={styles.thumbnail} contentFit="cover" />
                ) : (
                  <View style={styles.fileIcon}><Ionicons name="document-text-outline" size={24} color={colors.textSecondary} /></View>
                )}
              </Pressable>
              <View style={styles.attachmentText}>
                <Text numberOfLines={1} style={styles.attachmentName}>{attachment.name}</Text>
                <Text style={styles.attachmentSize}>{(attachment.size / 1024 / 1024).toFixed(1)} MiB</Text>
              </View>
              <Pressable
                onPress={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                hitSlop={10}
                testID={`report-issue-remove-${index}`}
              >
                <Ionicons name="close-circle" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>
          ))}
          {error ? <Text style={styles.error} testID="report-issue-error">{error}</Text> : null}
          <Pressable
            disabled={submitting}
            onPress={() => void submit()}
            style={[styles.primaryButton, submitting && styles.disabled]}
            testID="report-issue-submit"
          >
            {submitting ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.primaryButtonText}>Submit report</Text>}
          </Pressable>
        </ScrollView>
      )}
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={styles.previewBackdrop}>
          <Pressable onPress={() => setPreview(null)} style={styles.previewClose} testID="report-issue-preview-close">
            <Ionicons name="close" size={30} color={colors.textInverse} />
          </Pressable>
          {preview ? <Image source={{ uri: preview.uri }} style={styles.fullImage} contentFit="contain" /> : null}
        </View>
      </Modal>
    </DismissKeyboardView>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    center: { alignItems: "center", justifyContent: "center", padding: Spacing.xxl, gap: Spacing.md },
    header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    headerTitle: { ...Typography.h2, color: c.text, flex: 1, textAlign: "center" },
    headerSpacer: { width: 26 },
    content: { padding: Spacing.lg, gap: Spacing.md },
    intro: { ...Typography.body, color: c.textSecondary },
    label: { ...Typography.bodySemibold, color: c.text },
    input: { ...Typography.body, color: c.text, minHeight: 130, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surface, padding: Spacing.md },
    pickerRow: { flexDirection: "row", gap: Spacing.sm },
    secondaryButton: { flex: 1, minHeight: 46, flexDirection: "row", gap: Spacing.sm, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surface },
    secondaryButtonText: { ...Typography.bodySemibold, color: c.tint },
    attachment: { flexDirection: "row", alignItems: "center", gap: Spacing.md, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, padding: Spacing.sm, backgroundColor: c.surface },
    attachmentPreview: { width: 52, height: 52 },
    thumbnail: { width: 52, height: 52, borderRadius: Radius.sm },
    fileIcon: { width: 52, height: 52, borderRadius: Radius.sm, backgroundColor: c.surfaceAlt, alignItems: "center", justifyContent: "center" },
    attachmentText: { flex: 1 },
    attachmentName: { ...Typography.bodyMedium, color: c.text },
    attachmentSize: { ...Typography.caption, color: c.textSecondary },
    error: { ...Typography.body, color: c.error },
    primaryButton: { minHeight: 48, borderRadius: Radius.full, backgroundColor: c.tint, alignItems: "center", justifyContent: "center", paddingHorizontal: Spacing.xl },
    primaryButtonText: { ...Typography.bodySemibold, color: c.textInverse },
    disabled: { opacity: 0.6 },
    deniedTitle: { ...Typography.h2, color: c.text, textAlign: "center" },
    deniedText: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    success: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xxl, gap: Spacing.md },
    successTitle: { ...Typography.h2, color: c.text },
    successText: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    previewBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", alignItems: "center", justifyContent: "center" },
    previewClose: { position: "absolute", top: 56, right: Spacing.lg, zIndex: 1, padding: Spacing.sm },
    fullImage: { width: "100%", height: "88%" },
  });
}