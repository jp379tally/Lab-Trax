import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Alert,
  Platform,
  Modal,
  KeyboardAvoidingView,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as DocumentPicker from "expo-document-picker";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { FormSheet } from "@/components/ui/FormSheet";
import { useLabLocations } from "@/lib/lab-locations";
import { uploadCaseAttachment } from "@/lib/uploadCaseAttachment";
import { caseMediaSource } from "@/lib/case-media-source";
import { chunkedUploadCaseMedia, getApiUrl } from "@/lib/query-client";
import {
  attachmentFileUrl,
  isImageAttachment,
  openAttachmentPreview,
  type PreviewAttachment,
} from "@/lib/attachment-preview";
import { confirmSaveAttachment } from "@/lib/save-attachment-prompt";
import { ZoomableAuthedImage } from "@/components/ui/ZoomableAuthedImage";
import { uploadAudioForTranscript } from "@/lib/audio-transcription";
import {
  EXCEPTION_QUEUE_QUERY_KEY,
  addExceptionNote,
  createCaseException,
  exceptionDetailQueryKey,
  fetchExceptionDetail,
  resolveCaseException,
  type CaseExceptionDetail,
} from "@/lib/case-exceptions";

type PickedFile = { uri: string; name: string; mimeType: string };
type NoteDraftFile = PickedFile & { id: string; storageKey?: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

function useExceptionDictation({
  active,
  setText,
  fieldName,
}: {
  active: boolean;
  setText: React.Dispatch<React.SetStateAction<string>>;
  fieldName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "recording" | "transcribing">(
    "idle",
  );
  const recordingRef = useRef<Audio.Recording | null>(null);
  const sessionRef = useRef(0);
  const activeRef = useRef(active);

  const releaseRecording = useCallback(async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) {
      await recording.stopAndUnloadAsync().catch(() => undefined);
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(
      () => undefined,
    );
  }, []);

  const cancel = useCallback(async () => {
    sessionRef.current += 1;
    await releaseRecording();
    if (activeRef.current) setState("idle");
  }, [releaseRecording]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) void cancel();
  }, [active, cancel]);

  useEffect(
    () => () => {
      activeRef.current = false;
      void cancel();
    },
    [cancel],
  );

  const start = useCallback(async () => {
    if (Platform.OS === "web") {
      setError(
        `Recording isn't supported in this preview. You can still type the ${fieldName}.`,
      );
      return;
    }
    const session = ++sessionRef.current;
    setError(null);
    try {
      await releaseRecording();
      if (session !== sessionRef.current || !activeRef.current) return;
      const permission = await Audio.requestPermissionsAsync();
      if (session !== sessionRef.current || !activeRef.current) return;
      if (!(permission.granted || permission.status === "granted")) {
        setError(
          "Microphone permission is required. Enable it in Settings, then try again.",
        );
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      if (session !== sessionRef.current || !activeRef.current) {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(
          () => undefined,
        );
        return;
      }
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      if (session !== sessionRef.current || !activeRef.current) {
        await recording.stopAndUnloadAsync().catch(() => undefined);
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(
          () => undefined,
        );
        return;
      }
      recordingRef.current = recording;
      setState("recording");
    } catch {
      if (session !== sessionRef.current || !activeRef.current) return;
      setError(
        `Couldn't start the microphone. Please try again or type the ${fieldName}.`,
      );
      setState("idle");
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(
        () => undefined,
      );
    }
  }, [fieldName, releaseRecording]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setState("transcribing");
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (session !== sessionRef.current || !activeRef.current) return;
      if (!uri) {
        setError(
          `No audio was captured. Please try again or type the ${fieldName}.`,
        );
        return;
      }
      const transcript = (
        await uploadAudioForTranscript(uri, "audio/m4a")
      ).trim();
      if (session !== sessionRef.current || !activeRef.current) return;
      if (!transcript) {
        setError(
          `No speech was detected. Please try again or type the ${fieldName}.`,
        );
        return;
      }
      setText((current) =>
        current.trim() ? `${current.trimEnd()}\n${transcript}` : transcript,
      );
    } catch (e) {
      if (session !== sessionRef.current || !activeRef.current) return;
      setError(
        errorMessage(e) ||
          `Voice transcription is temporarily unavailable. You can still type the ${fieldName}.`,
      );
    } finally {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(
        () => undefined,
      );
      if (session === sessionRef.current && activeRef.current) setState("idle");
    }
  }, [fieldName, setText]);

  return { state, error, start, stop, cancel };
}

/**
 * Present the three ways to attach media, matching the case Files card.
 * Images are resized before upload — raw camera-roll picks are 4–8 MB and
 * stall the chunked uploader.
 */
async function pickMedia(
  kind: "camera" | "library" | "file",
): Promise<PickedFile[]> {
  if (kind === "file") {
    const res = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (res.canceled) return [];
    return res.assets.map((a, i) => ({
      uri: a.uri,
      name: a.name || `file-${Date.now()}-${i}`,
      mimeType: a.mimeType || "application/octet-stream",
    }));
  }

  if (kind === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!(perm.granted || perm.status === "granted")) {
      throw new Error("Enable camera access in Settings to take photos.");
    }
    const res = await ImagePicker.launchCameraAsync({
      quality: 1,
      mediaTypes: ["images"],
    });
    if (res.canceled) return [];
    return Promise.all(res.assets.map((a, i) => shrink(a.uri, a.fileName, i)));
  }

  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!(perm.granted || perm.status === "granted")) {
    throw new Error(
      "Enable photo library access in Settings to choose photos.",
    );
  }
  const res = await ImagePicker.launchImageLibraryAsync({
    quality: 1,
    allowsMultipleSelection: true,
    mediaTypes: ["images"],
  });
  if (res.canceled) return [];
  return Promise.all(res.assets.map((a, i) => shrink(a.uri, a.fileName, i)));
}

async function shrink(
  uri: string,
  fileName: string | null | undefined,
  index: number,
): Promise<PickedFile> {
  const out = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1200 } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
  );
  const raw = fileName || `exception-${Date.now()}-${index}.jpg`;
  return {
    uri: out.uri,
    name: raw.replace(/\.[^.]+$/, ".jpg"),
    mimeType: "image/jpeg",
  };
}

function MediaPickerRow({
  styles,
  colors,
  disabled,
  wrap = false,
  onPicked,
  testIDPrefix,
}: {
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  disabled?: boolean;
  wrap?: boolean;
  onPicked: (files: PickedFile[]) => void;
  testIDPrefix: string;
}) {
  async function run(kind: "camera" | "library" | "file") {
    try {
      const picked = await pickMedia(kind);
      if (picked.length > 0) onPicked(picked);
    } catch (e) {
      Alert.alert("Couldn't add media", errorMessage(e));
    }
  }
  const options: Array<{
    kind: "camera" | "library" | "file";
    icon: React.ComponentProps<typeof Ionicons>["name"];
    label: string;
  }> = [
    { kind: "camera", icon: "camera-outline", label: "Photo" },
    { kind: "library", icon: "images-outline", label: "Library" },
    { kind: "file", icon: "document-outline", label: "File" },
  ];
  return (
    <View
      style={[styles.pickerRow, wrap && { flexWrap: "wrap" }]}
      testID={`${testIDPrefix}-picker-row`}
    >
      {options.map((o) => (
        <Pressable
          key={o.kind}
          disabled={disabled}
          onPress={() => run(o.kind)}
          testID={`${testIDPrefix}-pick-${o.kind}`}
          style={[styles.pickerBtn, disabled && { opacity: 0.5 }]}
        >
          <Ionicons name={o.icon} size={16} color={colors.tint} />
          <Text style={[styles.pickerBtnText, { color: colors.tint }]}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Create sheet — any active lab member can create an exception case. The
 * selected location change and exception are committed atomically; the optional
 * note and media are attached after the exception row exists, so a failed
 * upload never loses the exception.
 */
export function CaseExceptionCreateSheet({
  visible,
  caseId,
  labOrganizationId,
  onClose,
}: {
  visible: boolean;
  caseId: string;
  labOrganizationId: string | null | undefined;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const [issueText, setIssueText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [putOnHold, setPutOnHold] = useState<boolean | null>(null);
  const [labLocationId, setLabLocationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dictation = useExceptionDictation({
    active: visible && !submitting,
    setText: setIssueText,
    fieldName: "issue",
  });
  const dictationError = dictation.error;
  const dictationState = dictation.state;

  function reset() {
    setIssueText("");
    setFiles([]);
    setPutOnHold(null);
    setLabLocationId(null);
    setError(null);
    // Dictation errors clear when a new recording starts.
  }

  const cancelDictation = dictation.cancel;

  const {
    locations,
    status: locationsStatus,
    retry: retryLocations,
  } = useLabLocations(labOrganizationId, visible && putOnHold === false);

  const startDictation = dictation.start;
  const stopDictation = dictation.stop;
  const createStyles = useMemo(() => makeCreateStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const twoCol = winW >= 360;
  const submitDisabled =
    putOnHold === null ||
    (!putOnHold &&
      (locationsStatus !== "loaded" ||
        locations.length === 0 ||
        !labLocationId));

  function closeSheet() {
    void cancelDictation();
    reset();
    onClose();
  }

  async function submit() {
    if (putOnHold === null) {
      setError("Choose whether to put this case on hold.");
      return;
    }
    if (!putOnHold && !labLocationId) {
      setError("Choose the case's current location.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await cancelDictation();
      const created = await createCaseException({
        caseId,
        issueText,
        putOnHold,
        ...(!putOnHold && labLocationId ? { labLocationId } : {}),
      });
      const failures: string[] = [];
      for (const f of files) {
        const res = await uploadCaseAttachment({
          caseId,
          fileUri: f.uri,
          fileName: f.name,
          mimeType: f.mimeType,
          caseExceptionId: created.id,
        });
        if (!res.ok) failures.push(`${f.name}: ${res.error}`);
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: EXCEPTION_QUEUE_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: ["case", caseId] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
      ]);
      if (failures.length > 0) {
        setError(
          `Exception case created, but some files failed — ${failures.join(" · ")}`,
        );
        setFiles([]);
        return;
      }
      reset();
      onClose();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(
        status === 409
          ? "This case already has an active exception."
          : status === 403
            ? "You don't have access to create an exception for this case."
            : errorMessage(e),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const statusCard = (
    testID: string,
    value: boolean,
    title: string,
    desc: string,
    icon?: boolean,
  ) => {
    const selected = putOnHold === value;
    return (
      <Pressable
        testID={testID}
        disabled={submitting}
        accessibilityRole="radio"
        accessibilityState={{ selected, disabled: submitting }}
        onPress={() => {
          setPutOnHold(value);
          setLabLocationId(null);
          setError(null);
        }}
        style={[createStyles.card, selected && createStyles.cardOn]}
      >
        <View
          style={createStyles.cardTop}
          testID={`${testID}-content`}
        >
          <View style={[createStyles.radio, selected && { borderColor: colors.tint }]}>
            {selected ? <View style={createStyles.radioDot} /> : null}
          </View>
          {icon ? (
            <Ionicons name="pause-circle" size={18} color={colors.warning} />
          ) : null}
          <Text style={createStyles.cardTitle}>{title}</Text>
        </View>
        <Text style={createStyles.cardDesc}>{desc}</Text>
      </Pressable>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={closeSheet}
    >
      <KeyboardAvoidingView
        style={createStyles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            createStyles.backdrop,
            {
              paddingTop: insets.top + Spacing.md,
              paddingBottom: insets.bottom + Spacing.md,
              paddingLeft: insets.left + Spacing.md,
              paddingRight: insets.right + Spacing.md,
            },
          ]}
          testID="case-exception-create-backdrop"
        >
          <View style={createStyles.modal} testID="case-exception-create-sheet">
            <View style={createStyles.header} testID="case-exception-create-header">
              <View style={createStyles.warnIcon}>
                <Ionicons name="warning-outline" size={22} color={colors.warning} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={createStyles.title} accessibilityRole="header">
                  Create Exception Case
                </Text>
                <View style={createStyles.privacyRow}>
                  <Ionicons name="lock-closed" size={11} color={colors.textSecondary} />
                  <Text style={[styles.help, { flex: 1 }]}>
                    Notes and files added here stay internal to your lab.
                  </Text>
                </View>
              </View>
              <Pressable
                testID="case-exception-create-close"
                accessibilityLabel="Close"
                hitSlop={10}
                disabled={submitting}
                onPress={closeSheet}
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              testID="case-exception-create-body-scroll"
              style={createStyles.body}
              contentContainerStyle={createStyles.bodyContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
            >
              <View
                style={[createStyles.cols, twoCol && { flexDirection: "row" }]}
                testID="case-exception-create-columns"
              >
                <View
                  style={[createStyles.colLeft, twoCol && { flex: 1.35 }]}
                  testID="case-exception-create-left-column"
                >
                  <View
                    style={[styles.issueHeading, createStyles.issueHeading]}
                  >
                    <Text style={createStyles.section}>
                      Issue Details <Text style={createStyles.optional}>Optional</Text>
                    </Text>
                    <Pressable
                      testID="case-exception-dictation"
                      disabled={submitting || dictationState === "transcribing"}
                      onPress={() => {
                        if (dictationState === "recording") {
                          void stopDictation();
                        } else {
                          void startDictation();
                        }
                      }}
                      accessibilityLabel={
                        dictationState === "recording"
                          ? "Stop recording issue description"
                          : dictationState === "transcribing"
                            ? "Transcribing issue description"
                            : "Dictate issue description"
                      }
                      style={[
                        styles.dictationBtn,
                        {
                          borderColor:
                            dictationState === "recording" ? colors.error : colors.tint,
                          backgroundColor:
                            dictationState === "recording"
                              ? colors.error + "12"
                              : colors.backgroundSolid,
                        },
                        (submitting || dictationState === "transcribing") && {
                          opacity: 0.5,
                        },
                      ]}
                    >
                      {dictationState === "transcribing" ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : (
                        <Ionicons
                          name={
                            dictationState === "recording"
                              ? "stop-circle-outline"
                              : dictationError
                                ? "mic-off-outline"
                                : "mic-outline"
                          }
                          size={16}
                          color={dictationState === "recording" ? colors.error : colors.tint}
                        />
                      )}
                      <Text
                        style={[
                          styles.dictationText,
                          { color: dictationState === "recording" ? colors.error : colors.tint },
                        ]}
                      >
                        {dictationState === "recording"
                          ? "Stop"
                          : dictationState === "transcribing"
                            ? "Transcribing…"
                            : "Dictate"}
                      </Text>
                    </Pressable>
                  </View>
                  <TextInput
                    testID="case-exception-issue-input"
                    value={issueText}
                    onChangeText={setIssueText}
                    multiline
                    autoCorrect={true}
                    spellCheck={true}
                    autoCapitalize="sentences"
                    placeholder="Describe what needs attention…"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.inputMultiline, { minHeight: 96 }]}
                  />
                  {dictationState === "recording" ? (
                    <Text
                      style={[styles.help, { color: colors.error }]}
                      testID="case-exception-dictation-status"
                      accessibilityLiveRegion="polite"
                    >
                      Recording issue description — tap Stop when you&apos;re finished.
                    </Text>
                  ) : dictationState === "transcribing" ? (
                    <Text
                      style={styles.help}
                      testID="case-exception-dictation-status"
                      accessibilityLiveRegion="polite"
                    >
                      Transcribing your recording…
                    </Text>
                  ) : null}
                  {dictationError ? (
                    <Text
                      style={styles.error}
                      testID="case-exception-dictation-error"
                      accessibilityLiveRegion="assertive"
                    >
                      {dictationError}
                    </Text>
                  ) : null}

                  <Text style={[createStyles.section, { marginTop: Spacing.sm }]}>
                    Photos &amp; Files <Text style={createStyles.optional}>Optional</Text>
                  </Text>
                  <View style={createStyles.filesBox}>
                    <Text style={createStyles.cardTitle}>Add Supporting Files</Text>
                    <Text style={styles.help} testID="case-exception-create-file-count">
                      {files.length > 0
                        ? `${files.length} file${files.length === 1 ? "" : "s"} ready to upload`
                        : "No files selected"}
                    </Text>
                    <MediaPickerRow
                      styles={styles}
                      colors={colors}
                      disabled={submitting}
                      wrap={twoCol}
                      testIDPrefix="case-exception-create"
                      onPicked={(picked) => setFiles((prev) => [...prev, ...picked])}
                    />
                  </View>
                </View>

                <View
                  style={[createStyles.colRight, twoCol && { flex: 1 }]}
                  testID="case-exception-create-right-column"
                >
                  <Text style={createStyles.section}>Production Status</Text>
                  <Text style={styles.help}>Should this case continue?</Text>
                  <View
                    style={{ gap: Spacing.sm }}
                    testID="case-exception-hold-decision"
                    accessibilityRole="radiogroup"
                    accessibilityLabel="Do you want to put this case on hold?"
                  >
                    {statusCard(
                      "case-exception-put-on-hold-no",
                      false,
                      "Keep Active",
                      "Continue through production.",
                    )}
                    {statusCard(
                      "case-exception-put-on-hold-yes",
                      true,
                      "Place on Hold",
                      "Pause production for this case.",
                      true,
                    )}
                  </View>
                  <Text style={[createStyles.section, { marginTop: Spacing.sm }]}>
                    Current Location
                  </Text>
                  {putOnHold === false ? (
                    <View testID="case-exception-create-location-form" style={{ gap: Spacing.sm }}>
                      {locationsStatus === "loading" ? (
                        <View style={styles.centerRow} testID="case-exception-create-locations-loading">
                          <ActivityIndicator size="small" color={colors.tint} />
                          <Text style={styles.help}>Loading locations…</Text>
                        </View>
                      ) : locationsStatus === "error" ? (
                        <Pressable
                          onPress={retryLocations}
                          testID="case-exception-create-locations-retry"
                          style={styles.smallBtn}
                        >
                          <Text style={[styles.smallBtnText, { color: colors.tint }]}>
                            Couldn&apos;t load locations — retry
                          </Text>
                        </Pressable>
                      ) : locations.length === 0 ? (
                        <Text style={styles.help} testID="case-exception-create-locations-empty">
                          This lab has no active locations yet.
                        </Text>
                      ) : (
                        <View style={styles.locationGrid}>
                          {locations.map((loc) => {
                            const selected = labLocationId === loc.id;
                            return (
                              <Pressable
                                key={loc.id}
                                testID={`case-exception-create-location-${loc.id}`}
                                disabled={submitting}
                                onPress={() => {
                                  setLabLocationId(loc.id);
                                  setError(null);
                                }}
                                style={[
                                  styles.locationChip,
                                  selected && {
                                    backgroundColor: colors.tintLight,
                                    borderColor: colors.tint,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.locationChipText,
                                    selected && { color: colors.tint },
                                  ]}
                                >
                                  {loc.name}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  ) : (
                    <Text style={styles.help}>
                      {putOnHold === true
                        ? "Held cases are placed at On Hold."
                        : "Choose Keep Active to set the case's location."}
                    </Text>
                  )}
                </View>
              </View>
              {error ? (
                <Text style={styles.error} testID="case-exception-create-error">
                  {error}
                </Text>
              ) : null}
            </ScrollView>

            <View style={createStyles.footer} testID="case-exception-create-footer">
              <Pressable
                style={createStyles.cancelBtn}
                onPress={closeSheet}
                disabled={submitting}
                testID="case-exception-create-cancel"
              >
                <Text style={createStyles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  createStyles.saveBtn,
                  (submitting || submitDisabled) && { opacity: 0.6 },
                ]}
                onPress={submit}
                disabled={submitting || submitDisabled}
                testID="case-exception-create-save"
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={createStyles.saveText}>Create Exception Case</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeCreateStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "center",
      alignItems: "center",
    },
    modal: {
      width: "100%",
      maxWidth: 720,
      maxHeight: "100%",
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.md,
      padding: Spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    warnIcon: {
      width: 40,
      height: 40,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.warning + "26",
    },
    title: { ...Typography.h2, color: c.text },
    privacyRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
    body: { flexShrink: 1, flexGrow: 0 },
    bodyContent: { padding: Spacing.lg, gap: Spacing.md },
    cols: { gap: Spacing.md },
    issueHeading: { flexWrap: "wrap", justifyContent: "flex-start" },
    colLeft: { gap: Spacing.sm },
    colRight: {
      gap: Spacing.sm,
      padding: Spacing.sm,
      borderRadius: Radius.lg,
      backgroundColor: c.surfaceSecondary,
    },
    section: { ...Typography.bodySemibold, color: c.text },
    optional: { ...Typography.caption, color: c.textSecondary, fontWeight: "400" },
    filesBox: {
      gap: 2,
      padding: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
    },
    card: {
      minHeight: 64,
      padding: Spacing.md,
      gap: 4,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.backgroundSolid,
    },
    cardOn: { borderColor: c.tint, backgroundColor: c.tintLight },
    cardTop: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: Spacing.sm,
    },
    cardTitle: { ...Typography.bodySemibold, color: c.text, flexShrink: 1 },
    cardDesc: { ...Typography.caption, color: c.textSecondary, paddingLeft: 26 },
    radio: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.tint },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: Spacing.md,
      padding: Spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    cancelBtn: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: Spacing.md,
    },
    cancelText: { ...Typography.bodySemibold, color: c.textSecondary },
    saveBtn: {
      flex: 1,
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: Radius.md,
      backgroundColor: c.tint,
      paddingHorizontal: Spacing.md,
    },
    saveText: { ...Typography.bodySemibold, color: c.textInverse },
  });
}
/**
 * Detail sheet — issue context, internal notes, media and history for any lab
 * member; the resolve form only renders when the server reports
 * `viewerCanResolve` (owner/admin). The server re-checks either way.
 */
export function CaseExceptionDetailSheet({
  visible,
  caseId,
  exceptionId,
  labOrganizationId,
  onClose,
}: {
  visible: boolean;
  caseId: string;
  exceptionId: string;
  labOrganizationId: string | null | undefined;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();

  const [busy, setBusy] = useState(false);
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string | null>(
    null,
  );
  const [openProgress, setOpenProgress] = useState<number | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewAttachment | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [submittingNote, setSubmittingNote] = useState(false);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [additionalNote, setAdditionalNote] = useState("");
  const [additionalNoteFiles, setAdditionalNoteFiles] = useState<
    NoteDraftFile[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const noteDictation = useExceptionDictation({
    active: visible && !busy,
    setText: setAdditionalNote,
    fieldName: "note",
  });

  const detailQuery = useQuery<CaseExceptionDetail>({
    queryKey: exceptionDetailQueryKey(exceptionId),
    queryFn: () => fetchExceptionDetail(exceptionId),
    enabled: visible && !!exceptionId,
  });
  const detail = detailQuery.data;

  useEffect(() => {
    if (!visible) setPreviewImage(null);
  }, [visible]);

  const {
    locations,
    status: locationsStatus,
    retry: retryLocations,
  } = useLabLocations(labOrganizationId, visible && !!detail?.viewerCanResolve);

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: exceptionDetailQueryKey(exceptionId) }),
      qc.invalidateQueries({ queryKey: EXCEPTION_QUEUE_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: ["case", caseId] }),
      qc.invalidateQueries({ queryKey: ["cases"] }),
    ]);
  }

  async function uploadPicked(picked: PickedFile[]) {
    setBusy(true);
    setError(null);
    try {
      for (const f of picked) {
        const res = await uploadCaseAttachment({
          caseId,
          fileUri: f.uri,
          fileName: f.name,
          mimeType: f.mimeType,
          caseExceptionId: exceptionId,
        });
        if (!res.ok) throw new Error(res.error);
      }
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function openNoteAttachment(attachment: {
    id: string;
    fileName: string;
    fileType: string | null;
  }) {
    if (openingAttachmentId) return;
    void openAttachmentPreview(
      {
        url: attachmentFileUrl(caseId, attachment.id),
        fileName: attachment.fileName,
        fileType: attachment.fileType,
      },
      {
        onOpenImage: (url) => setPreviewImage({ ...attachment, url }),
        onError: (title, message) => Alert.alert(title, message),
        setBusy: (isBusy) => {
          setOpeningAttachmentId(isBusy ? attachment.id : null);
          if (!isBusy) setOpenProgress(null);
        },
        onProgress: setOpenProgress,
      },
    );
  }

  async function submitAdditionalNote() {
    const noteText = additionalNote.trim();
    if (!noteText || busy) return;
    setBusy(true);
    setSubmittingNote(true);
    setError(null);
    try {
      await noteDictation.cancel();
      const attachments: Array<{
        storageKey: string;
        fileName: string;
        fileType: string;
      }> = [];
      for (const file of additionalNoteFiles) {
        let storageKey = file.storageKey;
        if (!storageKey) {
          const uploaded = await chunkedUploadCaseMedia(
            file.uri,
            file.name,
            file.mimeType,
          );
          if (!uploaded.ok) {
            throw new Error(uploaded.error || `Could not upload ${file.name}.`);
          }
          storageKey = uploaded.url;
          setAdditionalNoteFiles((current) =>
            current.map((draft) =>
              draft.id === file.id ? { ...draft, storageKey } : draft,
            ),
          );
        }
        attachments.push({
          storageKey,
          fileName: file.name,
          fileType: file.mimeType,
        });
      }
      await addExceptionNote(exceptionId, noteText, attachments);
      setAdditionalNote("");
      setAdditionalNoteFiles([]);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setSubmittingNote(false);
    }
  }

  async function submitResolve() {
    setBusy(true);
    setError(null);
    try {
      await resolveCaseException({
        exceptionId,
        ...(destinationId ? { labLocationId: destinationId } : {}),
        resolutionNote,
      });
      await refresh();
      setDestinationId(null);
      setResolutionNote("");
      await noteDictation.cancel();
      onClose();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(
        status === 403
          ? "Only a lab owner or admin can resolve an exception."
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  const canResolve = !!detail?.viewerCanResolve && detail?.status === "active";
  // The resolution note is mandatory; the destination stays optional.
  const resolveDisabled = canResolve && !resolutionNote.trim();

  return (
    <>
      <FormSheet
        visible={visible}
        title="Exception case"
        testIDPrefix="case-exception-detail"
        boundedBody
        submitLabel={canResolve ? "Resolve exception" : "Done"}
        submitting={busy}
        submitLoading={busy && !submittingNote}
        submitDisabled={resolveDisabled}
        onSubmit={
          canResolve
            ? submitResolve
            : () => {
                void noteDictation.cancel();
                onClose();
              }
        }
        onClose={() => {
          void noteDictation.cancel();
          onClose();
        }}
      >
        {detailQuery.isLoading ? (
          <View style={styles.centerRow} testID="case-exception-detail-loading">
            <ActivityIndicator size="small" color={colors.tint} />
            <Text style={styles.help}>Loading…</Text>
          </View>
        ) : detailQuery.isError || !detail ? (
          <Text style={styles.error} testID="case-exception-detail-error">
            Couldn&apos;t load this exception.
          </Text>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <View testID="case-exception-conversation">
              <Text style={styles.label}>Exception conversation</Text>
              <Text style={styles.body} testID="case-exception-issue-text">
                {detail.issueText || "No description provided."}
              </Text>
              <Text style={styles.meta}>
                {detail.createdByName ?? "A lab member"} ·{" "}
                {new Date(detail.createdAt).toLocaleString()}
              </Text>
              {[...detail.notes]
                .sort(
                  (a, b) =>
                    new Date(a.createdAt).getTime() -
                    new Date(b.createdAt).getTime(),
                )
                .map((note) => (
                  <View
                    key={note.id}
                    testID={`case-exception-conversation-note-${note.id}`}
                    style={{
                      borderLeftWidth: 2,
                      borderLeftColor: colors.border,
                      paddingLeft: Spacing.sm,
                      marginTop: Spacing.sm,
                    }}
                  >
                    <Text style={styles.body}>{note.noteText}</Text>
                    {note.attachments?.map((attachment) => {
                      const url = attachmentFileUrl(caseId, attachment.id);
                      return isImageAttachment(
                        attachment.fileType,
                        attachment.fileName,
                      ) ? (
                        <Pressable
                          key={attachment.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Open photo ${attachment.fileName}`}
                          testID={`case-exception-note-attachment-${attachment.id}`}
                          onPress={() => setPreviewImage({ ...attachment, url })}
                        >
                          <Image
                            testID={`case-exception-note-attachment-${attachment.id}-thumbnail`}
                            source={caseMediaSource(url)}
                            style={styles.noteAttachmentImage}
                            contentFit="cover"
                          />
                        </Pressable>
                      ) : (
                        <Pressable
                          key={attachment.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Open file ${attachment.fileName}`}
                          accessibilityState={{
                            disabled: openingAttachmentId !== null,
                            busy: openingAttachmentId === attachment.id,
                          }}
                          disabled={openingAttachmentId !== null}
                          onPress={() => openNoteAttachment(attachment)}
                          testID={`case-exception-note-attachment-${attachment.id}`}
                          style={[
                            styles.fileChip,
                            openingAttachmentId !== null && { opacity: 0.6 },
                          ]}
                        >
                          {openingAttachmentId === attachment.id ? (
                            <ActivityIndicator
                              size="small"
                              color={colors.tint}
                              testID={`case-exception-note-attachment-${attachment.id}-opening`}
                            />
                          ) : (
                            <Ionicons
                              name="document-outline"
                              size={14}
                              color={colors.textSecondary}
                            />
                          )}
                          <View style={styles.noteFileLabel}>
                            <Text style={styles.meta} numberOfLines={1}>
                              {attachment.fileName}
                            </Text>
                            {openingAttachmentId === attachment.id &&
                            openProgress !== null ? (
                              <Text
                                style={styles.meta}
                                testID={`case-exception-note-attachment-${attachment.id}-progress`}
                              >
                                {Math.round(openProgress * 100)}%
                              </Text>
                            ) : null}
                          </View>
                          <Ionicons
                            name="open-outline"
                            size={14}
                            color={colors.textSecondary}
                          />
                        </Pressable>
                      );
                    })}
                    <Text style={styles.meta}>
                      {note.authorName ?? "A lab member"} ·{" "}
                      {new Date(note.createdAt).toLocaleString()}
                    </Text>
                  </View>
                ))}
              {detail.status === "active" ? (
                <View style={{ marginTop: Spacing.sm }}>
                  <View style={styles.issueHeading}>
                    <Text style={[styles.label, { marginTop: 0 }]}>
                      Additional note
                    </Text>
                    <Pressable
                      testID="case-exception-note-dictation"
                      disabled={busy || noteDictation.state === "transcribing"}
                      onPress={() =>
                        void (noteDictation.state === "recording"
                          ? noteDictation.stop()
                          : noteDictation.start())
                      }
                      accessibilityLabel={
                        noteDictation.state === "recording"
                          ? "Stop recording additional exception note"
                          : noteDictation.state === "transcribing"
                            ? "Transcribing additional exception note"
                            : "Dictate additional exception note"
                      }
                      style={[styles.pickerBtn, busy && { opacity: 0.5 }]}
                    >
                      <Ionicons
                        name={
                          noteDictation.state === "recording"
                            ? "stop"
                            : "mic-outline"
                        }
                        size={16}
                        color={colors.tint}
                      />
                      <Text
                        style={[styles.pickerBtnText, { color: colors.tint }]}
                      >
                        {noteDictation.state === "recording"
                          ? "Stop recording"
                          : noteDictation.state === "transcribing"
                            ? "Transcribing…"
                            : "Dictate"}
                      </Text>
                    </Pressable>
                  </View>
                  <TextInput
                    testID="case-exception-note-input"
                    value={additionalNote}
                    onChangeText={setAdditionalNote}
                    multiline
                    autoCorrect={true}
                    spellCheck={true}
                    autoCapitalize="sentences"
                    placeholder="Add additional exception notes."
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.inputMultiline]}
                  />
                  {noteDictation.state !== "idle" ? (
                    <Text
                      style={styles.help}
                      testID="case-exception-note-dictation-status"
                    >
                      {noteDictation.state === "recording"
                        ? "Recording… Tap stop when finished."
                        : "Transcribing…"}
                    </Text>
                  ) : null}
                  {noteDictation.error ? (
                    <Text
                      style={styles.error}
                      testID="case-exception-note-dictation-error"
                    >
                      {noteDictation.error}
                    </Text>
                  ) : null}
                  <Text style={styles.help}>
                    Photos and files for this note
                  </Text>
                  <MediaPickerRow
                    styles={styles}
                    colors={colors}
                    disabled={busy}
                    testIDPrefix="case-exception-note"
                    onPicked={(files) =>
                      setAdditionalNoteFiles((current) => [
                        ...current,
                        ...files.map((file) => ({
                          ...file,
                          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        })),
                      ])
                    }
                  />
                  {additionalNoteFiles.map((file) => (
                    <View
                      key={file.id}
                      testID={`case-exception-note-draft-attachment-${file.id}`}
                      style={styles.noteDraftFile}
                    >
                      <Ionicons
                        name={
                          file.mimeType.startsWith("image/")
                            ? "image-outline"
                            : "document-outline"
                        }
                        size={16}
                        color={colors.textSecondary}
                      />
                      <Text
                        style={[styles.meta, { flex: 1 }]}
                        numberOfLines={1}
                      >
                        {file.name}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${file.name}`}
                        testID={`case-exception-note-remove-attachment-${file.id}`}
                        disabled={busy}
                        onPress={() =>
                          setAdditionalNoteFiles((current) =>
                            current.filter((draft) => draft.id !== file.id),
                          )
                        }
                        hitSlop={8}
                      >
                        <Ionicons
                          name="close-circle-outline"
                          size={20}
                          color={colors.textSecondary}
                        />
                      </Pressable>
                    </View>
                  ))}
                  <Pressable
                    testID="case-exception-note-submit"
                    accessibilityRole="button"
                    disabled={!additionalNote.trim() || busy}
                    accessibilityState={{
                      disabled: !additionalNote.trim() || busy,
                      busy: submittingNote,
                    }}
                    onPress={() => void submitAdditionalNote()}
                    style={[
                      styles.noteSubmitBtn,
                      (!additionalNote.trim() || busy) && { opacity: 0.5 },
                    ]}
                  >
                    {submittingNote ? (
                      <>
                        <ActivityIndicator size="small" color="#fff" />
                        <Text style={styles.noteSubmitText}>Submitting…</Text>
                      </>
                    ) : (
                      <Text style={styles.noteSubmitText}>
                        Submit additional notes
                      </Text>
                    )}
                  </Pressable>
                </View>
              ) : null}
            </View>

            <View
              style={styles.currentLocation}
              testID="case-exception-current-location"
            >
              <Text style={[styles.label, { marginTop: 0 }]}>
                Current location
              </Text>
              <Text style={styles.body}>
                {detail.currentLocationName ?? "Location unavailable"}
              </Text>
              {detail.currentLocationStatus ? (
                <Text style={styles.meta}>
                  Status: {detail.currentLocationStatus.replace(/_/g, " ")}
                </Text>
              ) : null}
            </View>

            <View>
              <Text style={styles.label}>Photos &amp; files</Text>
              {detail.attachments.length === 0 ? (
                <Text style={styles.help} testID="case-exception-media-empty">
                  No files attached.
                </Text>
              ) : (
                <ScrollView
                  horizontal
                  testID="case-exception-media-scroll"
                  showsHorizontalScrollIndicator={false}
                  directionalLockEnabled
                  nestedScrollEnabled
                  alwaysBounceVertical={false}
                >
                  <View style={styles.mediaRow}>
                    {detail.attachments.map((a) => {
                      const url = `${getApiUrl()}api/cases/${encodeURIComponent(caseId)}/attachments/${a.id}/file`;
                      const isImage = (a.fileType ?? "").startsWith("image/");
                      return isImage ? (
                        <Image
                          key={a.id}
                          testID={`case-exception-attachment-${a.id}`}
                          source={caseMediaSource(url)}
                          style={styles.thumb}
                          contentFit="cover"
                        />
                      ) : (
                        <View
                          key={a.id}
                          testID={`case-exception-attachment-${a.id}`}
                          style={styles.fileChip}
                        >
                          <Ionicons
                            name="document-outline"
                            size={14}
                            color={colors.textSecondary}
                          />
                          <Text style={styles.meta} numberOfLines={1}>
                            {a.fileName}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              )}
              {detail.status === "active" ? (
                <MediaPickerRow
                  styles={styles}
                  colors={colors}
                  disabled={busy}
                  testIDPrefix="case-exception-detail"
                  onPicked={uploadPicked}
                />
              ) : null}
            </View>

            <View>
              <Text style={styles.label}>History</Text>
              {detail.history.map((h, i) => (
                <Text key={`${h.type}-${i}`} style={styles.meta}>
                  {h.type.replace(/_/g, " ")}
                  {h.actorName ? ` · ${h.actorName}` : ""}
                  {h.detail ? ` — ${h.detail}` : ""}
                </Text>
              ))}
            </View>

            {detail.status === "active" && detail.viewerCanResolve ? (
              <View testID="case-exception-resolve-form">
                <Text style={styles.label}>Move case to (optional)</Text>
                <Text style={styles.help}>
                  Leave this unselected to resolve the exception without moving
                  the case.
                </Text>
                {locationsStatus === "loading" ? (
                  <View
                    style={styles.centerRow}
                    testID="case-exception-locations-loading"
                  >
                    <ActivityIndicator size="small" color={colors.tint} />
                    <Text style={styles.help}>Loading locations…</Text>
                  </View>
                ) : locationsStatus === "error" ? (
                  <Pressable
                    onPress={retryLocations}
                    testID="case-exception-locations-retry"
                    style={styles.smallBtn}
                  >
                    <Text style={[styles.smallBtnText, { color: colors.tint }]}>
                      Couldn&apos;t load locations — retry
                    </Text>
                  </Pressable>
                ) : locations.length === 0 ? (
                  <Text
                    style={styles.help}
                    testID="case-exception-locations-empty"
                  >
                    This lab has no active locations yet.
                  </Text>
                ) : (
                  <View style={styles.locationGrid}>
                    {locations.map((loc) => {
                      const selected = destinationId === loc.id;
                      return (
                        <Pressable
                          key={loc.id}
                          testID={`case-exception-location-${loc.id}`}
                          onPress={() => setDestinationId(loc.id)}
                          style={[
                            styles.locationChip,
                            selected && {
                              backgroundColor: colors.tintLight,
                              borderColor: colors.tint,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.locationChipText,
                              selected && { color: colors.tint },
                            ]}
                          >
                            {loc.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                <Text style={styles.label}>Resolution note (required)</Text>
                <TextInput
                  testID="case-exception-resolution-note"
                  value={resolutionNote}
                  onChangeText={setResolutionNote}
                  multiline
                  autoCorrect={true}
                  spellCheck={true}
                  autoCapitalize="sentences"
                  placeholder="How was this resolved?"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.input, styles.inputMultiline]}
                />
              </View>
            ) : detail.status === "active" ? (
              <Text style={styles.help} testID="case-exception-resolve-denied">
                Only a lab owner or admin can resolve an exception.
              </Text>
            ) : null}

            {error ? (
              <Text
                style={styles.error}
                testID="case-exception-detail-error-message"
              >
                {error}
              </Text>
            ) : null}
          </View>
        )}
      </FormSheet>

      <Modal
        visible={previewImage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewImage(null)}
      >
        <GestureHandlerRootView style={styles.imagePreviewRoot}>
          <Pressable
            style={styles.imagePreviewBackdrop}
            onPress={() => setPreviewImage(null)}
            testID="case-exception-note-image-preview-backdrop"
          >
            {previewImage ? (
              <ZoomableAuthedImage
                key={previewImage.url}
                url={previewImage.url}
                style={styles.imagePreview}
                testID="case-exception-note-image-preview-image"
              />
            ) : null}
            <Pressable
              style={[
                styles.imagePreviewSave,
                { bottom: insets.bottom + Spacing.lg },
                savingPhoto && { opacity: 0.5 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Save photo to your device"
              accessibilityState={{ disabled: savingPhoto, busy: savingPhoto }}
              disabled={savingPhoto}
              testID="case-exception-note-image-preview-save"
              onPress={(event) => {
                event.stopPropagation();
                if (!previewImage || savingPhoto) return;
                confirmSaveAttachment(
                  { kind: "image", ...previewImage },
                  { setBusy: setSavingPhoto },
                );
              }}
            >
              {savingPhoto ? (
                <ActivityIndicator size="small" color={colors.textInverse} />
              ) : (
                <Ionicons name="download-outline" size={22} color={colors.textInverse} />
              )}
              <Text style={styles.imagePreviewSaveText}>
                {savingPhoto ? "Saving…" : "Save photo"}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.imagePreviewClose,
                { top: insets.top + Spacing.md },
              ]}
              onPress={(event) => {
                event.stopPropagation();
                setPreviewImage(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Close photo preview"
              testID="case-exception-note-image-preview-close"
            >
              <Ionicons
                name="close-circle"
                size={32}
                color={colors.textInverse}
              />
            </Pressable>
          </Pressable>
        </GestureHandlerRootView>
      </Modal>
    </>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    help: { ...Typography.caption, color: c.textSecondary },
    label: {
      ...Typography.captionSemibold,
      color: c.textSecondary,
      textTransform: "uppercase",
      marginTop: Spacing.sm,
      marginBottom: 4,
    },
    body: { ...Typography.body, color: c.text },
    meta: { ...Typography.caption, color: c.textTertiary },
    error: { ...Typography.caption, color: c.error, marginTop: Spacing.sm },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
      color: c.text,
      backgroundColor: c.surface,
    },
    inputMultiline: { minHeight: 72, textAlignVertical: "top" },
    centerRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    currentLocation: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      backgroundColor: c.surfaceSecondary,
    },
    issueHeading: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
    },
    dictationBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 5,
    },
    dictationText: { ...Typography.captionSemibold },
    smallBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    smallBtnText: { ...Typography.captionSemibold },
    noteSubmitBtn: {
      minHeight: 48,
      alignSelf: "flex-end",
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: c.tint,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
    },
    noteSubmitText: { ...Typography.bodySemibold, color: "#fff" },
    noteDraftFile: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.xs,
    },
    noteAttachmentImage: {
      width: 112,
      height: 84,
      borderRadius: Radius.sm,
      marginTop: Spacing.xs,
    },
    noteFileLabel: { flex: 1, minWidth: 0 },
    imagePreviewRoot: { flex: 1 },
    imagePreviewBackdrop: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#000",
    },
    imagePreview: { width: "100%", height: "80%" },
    imagePreviewClose: { position: "absolute", right: Spacing.lg },
    imagePreviewSave: {
      position: "absolute",
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: c.tint,
    },
    imagePreviewSaveText: { ...Typography.bodySemibold, color: c.textInverse },
    pickerRow: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.xs },
    pickerBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      backgroundColor: c.tintLight,
    },
    pickerBtnText: { ...Typography.captionSemibold },
    mediaRow: { flexDirection: "row", gap: Spacing.sm },
    thumb: { width: 64, height: 64, borderRadius: Radius.sm },
    fileChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      maxWidth: 160,
    },
    locationGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
    locationChip: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    locationChipText: { ...Typography.caption, color: c.text },
  });
}
