import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import {
  type CanonicalCase,
  type AddCaseNoteInputVisibility,
  useAddCaseNote,
} from "@workspace/api-client-react";
import { LocateCaseSheet } from "@/components/LocateCaseSheet";
import { CaseExceptionCreateSheet } from "@/components/CaseExceptionSheet";
import { FormSheet } from "@/components/ui/FormSheet";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import { queryClient } from "@/lib/query-client";

type Action = "menu" | "note" | "photo" | "locate" | "exception" | null;
type Photo = { uri: string; name: string; mimeType: string };
type CaseQuickActionBodyProps = Omit<CaseQuickActionSheetProps, "caseItem"> & {
  caseItem: CanonicalCase;
};

export interface CaseQuickActionSheetProps {
  visible: boolean;
  caseItem: CanonicalCase | null;
  onDismiss: () => void;
  labOrganizationId?: string | null;
  returnedWizardHandoff?: boolean;
  onActionSuccess?: (action: "note" | "photo" | "locate" | "exception") => void;
}

function patientName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Please try again.";
}

/**
 * The shared long-press destination for active case rows and cards.
 *
 * The controller deliberately owns the small note/photo workflows while handing
 * location and exceptions to their existing sheets. This keeps every mobile
 * surface on the same action vocabulary without changing either server schema.
 */
export function CaseQuickActionSheet(props: CaseQuickActionSheetProps) {
  if (!props.caseItem) return null;
  return <CaseQuickActionSheetBody {...props} caseItem={props.caseItem} />;
}

function CaseQuickActionSheetBody({
  visible,
  caseItem,
  onDismiss,
  labOrganizationId,
  returnedWizardHandoff,
  onActionSuccess,
}: CaseQuickActionBodyProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const addNote = useAddCaseNote();
  const submitLock = useRef(false);
  const [action, setAction] = useState<Action>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoNote, setPhotoNote] = useState("");
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionCanAskAgain, setPermissionCanAskAgain] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  useLayoutEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

  useEffect(() => {
    if (visible && caseItem) {
      setAction("menu");
      setNote("");
      setNoteError(null);
      setPhoto(null);
      setPhotoNote("");
      setPhotoError(null);
      setPermissionError(null);
      setPermissionCanAskAgain(true);
      setUploadProgress(0);
    } else if (!visible) {
      setAction(null);
    }
  }, [visible, caseItem?.id]);

  const refreshCase = useCallback(
    async (caseId: string) => {
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["cases"] }),
          queryClient.invalidateQueries({ queryKey: ["case", caseId] }),
          queryClient.invalidateQueries({ queryKey: ["cases", caseId] }),
        ]);
      } catch (error) {
        // The server write already committed. A refresh failure must never turn
        // success into a retryable form state, because retrying would duplicate
        // the note or attachment.
        console.warn("[Case quick actions] Refresh after save failed", error);
      }
    },
    [queryClient],
  );

  const closeController = useCallback(() => {
    if (submitLock.current) return;
    setAction(null);
    onDismiss();
  }, [onDismiss]);

  const chooseAction = useCallback((next: Exclude<Action, "menu" | null>) => {
    Promise.resolve(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)).catch(() => {});
    setNoteError(null);
    setPhotoError(null);
    setPermissionError(null);
    setAction(next);
  }, []);

  async function submitNote() {
    if (!caseItem || submitLock.current) return;
    const trimmed = note.trim();
    if (!trimmed) {
      setNoteError("Enter a note before saving.");
      return;
    }
    submitLock.current = true;
    setNoteError(null);
    try {
      await addNote.mutateAsync({
        caseId: caseItem.id,
        data: {
          noteText: trimmed,
          visibility: "internal_lab_only" as AddCaseNoteInputVisibility,
        },
      });
      await refreshCase(caseItem.id);
      onActionSuccess?.("note");
      Alert.alert("Note added", "The internal lab note was saved.");
      setNote("");
      setAction(null);
      onDismiss();
    } catch (error) {
      setNoteError(errorMessage(error));
    } finally {
      submitLock.current = false;
    }
  }

  async function resizePhoto(uri: string, fileName?: string | null): Promise<Photo> {
    const resized = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1200 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
    );
    const baseName = fileName?.trim() || `case-${caseItem?.id ?? "photo"}.jpg`;
    return {
      uri: resized.uri,
      name: baseName.replace(/\.[^.]+$/, ".jpg"),
      mimeType: "image/jpeg",
    };
  }

  async function pickPhoto(kind: "camera" | "library") {
    setPermissionError(null);
    setPhotoError(null);
    try {
      const permission =
        kind === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      const granted = permission.granted || permission.status === "granted";
      if (!granted) {
        setPermissionCanAskAgain(permission.canAskAgain !== false);
        setPermissionError(
          kind === "camera"
            ? "Camera access was denied. Enable camera access in Settings, then try again."
            : "Photo library access was denied. Enable photo access in Settings, then try again.",
        );
        return;
      }
      const result =
        kind === "camera"
          ? await ImagePicker.launchCameraAsync({ quality: 1, mediaTypes: ["images"] })
          : await ImagePicker.launchImageLibraryAsync({
              quality: 1,
              allowsMultipleSelection: false,
              mediaTypes: ["images"],
            });
      if (result.canceled || !result.assets?.[0]) return;
      const selected = result.assets[0];
      setPhoto(await resizePhoto(selected.uri, selected.fileName));
    } catch (error) {
      setPermissionError(errorMessage(error));
    }
  }

  async function openSettings() {
    try {
      await Linking.openSettings();
    } catch {
      setPermissionError(
        "Settings couldn't be opened. Open your device Settings and enable camera or photo library access for LabTrax.",
      );
    }
  }

  async function submitPhoto() {
    if (!caseItem || submitLock.current) return;
    if (!photo) {
      setPhotoError("Choose a picture before uploading.");
      return;
    }
    const trimmed = photoNote.trim();
    if (!trimmed) {
      setPhotoError("Enter a note before uploading the picture.");
      return;
    }
    submitLock.current = true;
    setUploading(true);
    setUploadProgress(0);
    setPhotoError(null);
    try {
      const result = await uploadCaseAttachment({
        caseId: caseItem.id,
        fileUri: photo.uri,
        fileName: photo.name,
        mimeType: photo.mimeType,
        visibility: "internal_lab_only",
        note: trimmed,
        onProgress: setUploadProgress,
      });
      if (!result.ok) throw new Error(result.error);
      await refreshCase(caseItem.id);
      onActionSuccess?.("photo");
      Alert.alert("Picture added", "The picture and internal note were saved.");
      setPhoto(null);
      setPhotoNote("");
      setAction(null);
      onDismiss();
    } catch (error) {
      // Keep both the note and the resized image so Retry never requires
      // another permission prompt or causes a duplicate successful upload.
      setPhotoError(errorMessage(error));
    } finally {
      setUploading(false);
      submitLock.current = false;
    }
  }

  const identity = `${patientName(caseItem)}${caseItem.caseNumber ? `  ·  #${caseItem.caseNumber}` : ""}`;

  return (
    <>
      {action === "menu" ? (
        <Modal
          visible={visible}
          transparent
          animationType="slide"
          onRequestClose={closeController}
        >
          <View
            style={styles.modalRoot}
            accessibilityViewIsModal
            accessibilityLabel={`Quick actions for ${identity}`}
          >
            <Pressable style={styles.backdrop} onPress={closeController} />
            <View style={styles.menu} testID="case-quick-actions">
              <View style={styles.handle} />
              <View style={styles.heading}>
                <View style={styles.headingText}>
                  <Text style={styles.title}>Quick actions</Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {identity}
                  </Text>
                </View>
                <Pressable
                  onPress={closeController}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close case quick actions"
                  testID="case-quick-actions-close"
                >
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              </View>
              <ActionButton
                styles={styles}
                icon="location-outline"
                label="Locate Case"
                testID="case-quick-action-locate"
                onPress={() => chooseAction("locate")}
              />
              <ActionButton
                styles={styles}
                icon="chatbox-ellipses-outline"
                label="Add Note"
                testID="case-quick-action-note"
                onPress={() => chooseAction("note")}
              />
              <ActionButton
                styles={styles}
                icon="camera-outline"
                label="Add Picture with Note"
                testID="case-quick-action-picture"
                onPress={() => chooseAction("photo")}
              />
              <ActionButton
                styles={styles}
                icon="warning-outline"
                label="Mark as Exception"
                testID="case-quick-action-exception"
                onPress={() => chooseAction("exception")}
              />
            </View>
          </View>
        </Modal>
      ) : null}

      {action === "note" ? (
        <FormSheet
          visible
          title="Add internal note"
          testIDPrefix="case-quick-note"
          submitLabel="Add note"
          submitting={addNote.isPending || submitLock.current}
          submitDisabled={false}
          onSubmit={submitNote}
          onClose={closeController}
        >
          <Text style={styles.help}>Only your lab team will see this note.</Text>
          <TextInput
            value={note}
            onChangeText={(value) => {
              setNote(value);
              setNoteError(null);
            }}
            multiline
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            autoFocus
            textAlignVertical="top"
            placeholder="Write an internal note…"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="case-quick-note-input"
          />
          {noteError ? (
            <Text style={styles.error} testID="case-quick-note-error">
              {noteError}
            </Text>
          ) : null}
        </FormSheet>
      ) : null}

      {action === "photo" ? (
        <FormSheet
          visible
          title="Add picture with note"
          testIDPrefix="case-quick-photo"
          submitLabel="Upload picture"
          submitting={uploading || submitLock.current}
          submitDisabled={false}
          onSubmit={submitPhoto}
          onClose={closeController}
        >
          <Text style={styles.help}>Pictures and notes stay internal to your lab.</Text>
          <View style={styles.pickerRow}>
            <Pressable
              style={styles.pickerButton}
              disabled={uploading}
              onPress={() => void pickPhoto("camera")}
              testID="case-quick-photo-camera"
              accessibilityRole="button"
              accessibilityLabel="Take a picture with the camera"
            >
              <Ionicons name="camera-outline" size={18} color={colors.tint} />
              <Text style={styles.pickerText}>Camera</Text>
            </Pressable>
            <Pressable
              style={styles.pickerButton}
              disabled={uploading}
              onPress={() => void pickPhoto("library")}
              testID="case-quick-photo-library"
              accessibilityRole="button"
              accessibilityLabel="Choose a picture from the photo library"
            >
              <Ionicons name="images-outline" size={18} color={colors.tint} />
              <Text style={styles.pickerText}>Photo library</Text>
            </Pressable>
          </View>
          {permissionError ? (
            <View style={styles.permissionBlock}>
              <Text style={styles.error} testID="case-quick-photo-permission-error">
                {permissionError}
              </Text>
              {!permissionCanAskAgain ? (
                <Pressable
                  style={styles.settingsButton}
                  onPress={() => void openSettings()}
                  testID="case-quick-photo-open-settings"
                  accessibilityRole="button"
                  accessibilityLabel="Open device settings"
                >
                  <Ionicons name="settings-outline" size={16} color={colors.tint} />
                  <Text style={styles.pickerText}>Open Settings</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {photo ? (
            <View style={styles.previewWrap}>
              <Image source={{ uri: photo.uri }} style={styles.preview} contentFit="cover" />
              <Text style={styles.previewLabel} numberOfLines={1}>
                One picture ready: {photo.name}
              </Text>
            </View>
          ) : (
            <Text style={styles.help} testID="case-quick-photo-empty">
              Choose one picture to preview it before uploading.
            </Text>
          )}
          <TextInput
            value={photoNote}
            onChangeText={(value) => {
              setPhotoNote(value);
              setPhotoError(null);
            }}
            multiline
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            textAlignVertical="top"
            placeholder="Required note for this picture…"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="case-quick-photo-note-input"
          />
          {uploading ? (
            <View style={styles.progressWrap} testID="case-quick-photo-progress">
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={styles.help}>Uploading {Math.round(uploadProgress * 100)}%…</Text>
            </View>
          ) : null}
          {photoError ? (
            <Text style={styles.error} testID="case-quick-photo-error">
              {photoError}
            </Text>
          ) : null}
        </FormSheet>
      ) : null}

      {action === "locate" ? (
        <LocateCaseSheet
          locatingCase={caseItem}
          onDismiss={closeController}
          returnedWizardHandoff={returnedWizardHandoff}
          onLocated={() => {
            onActionSuccess?.("locate");
            Alert.alert("Case located", "The case location was updated.");
          }}
        />
      ) : null}

      {action === "exception" ? (
        <CaseExceptionCreateSheet
          visible
          caseId={caseItem.id}
          labOrganizationId={labOrganizationId ?? caseItem.labOrganizationId}
          onClose={closeController}
        />
      ) : null}
    </>
  );
}

function ActionButton({
  styles,
  icon,
  label,
  testID,
  onPress,
}: {
  styles: ReturnType<typeof makeStyles>;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={21} color={styles.actionIcon.color} />
      <Text style={styles.actionLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={styles.chevron.color} />
    </Pressable>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    modalRoot: { flex: 1, justifyContent: "flex-end" },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
    menu: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xl,
      gap: Spacing.sm,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: Radius.full,
      backgroundColor: colors.border,
      marginBottom: Spacing.sm,
    },
    heading: { flexDirection: "row", alignItems: "flex-start", marginBottom: Spacing.sm },
    headingText: { flex: 1, gap: 3 },
    title: { ...Typography.h2, color: colors.text },
    subtitle: { ...Typography.caption, color: colors.textSecondary },
    actionButton: {
      minHeight: 52,
      borderRadius: Radius.md,
      backgroundColor: colors.surfaceAlt,
      paddingHorizontal: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
    },
    actionPressed: { opacity: 0.7 },
    actionIcon: { color: colors.tint },
    actionLabel: { ...Typography.bodySemibold, color: colors.text, flex: 1 },
    chevron: { color: colors.textTertiary },
    help: { ...Typography.caption, color: colors.textSecondary, lineHeight: 19 },
    input: {
      minHeight: 110,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.md,
      padding: Spacing.md,
      color: colors.text,
      backgroundColor: colors.surfaceAlt,
      ...Typography.body,
    },
    error: { ...Typography.caption, color: colors.error, lineHeight: 19 },
    permissionBlock: { gap: Spacing.sm },
    settingsButton: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    pickerRow: { flexDirection: "row", gap: Spacing.sm },
    pickerButton: {
      flex: 1,
      minHeight: 48,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: Spacing.xs,
    },
    pickerText: { ...Typography.caption, color: colors.tint },
    previewWrap: { gap: Spacing.xs },
    preview: {
      width: "100%",
      height: 180,
      borderRadius: Radius.md,
      backgroundColor: colors.surfaceAlt,
    },
    previewLabel: { ...Typography.caption, color: colors.textSecondary },
    progressWrap: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  });
}
