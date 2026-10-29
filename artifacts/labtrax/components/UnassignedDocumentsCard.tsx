import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import {
  useListLabInboxFiles,
  useAssignLabInboxFile,
  useUpdateLabInboxFileNote,
  getListLabInboxFilesQueryKey,
} from "@workspace/api-client-react";
import type { LabInboxFile } from "@workspace/api-client-react";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { subscribeRxIntake } from "@/lib/rx-intake-events";
import { resilientFetch } from "@/lib/query-client";
import { saveFileToUnassignedDocuments } from "@/lib/shared-file-inbox";
import { openAttachment } from "@/lib/open-attachment";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { BorderWidth, Spacing, Radius, Typography } from "@/constants/tokens";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function mimeIcon(mimeType: string | null | undefined): string {
  if (!mimeType) return "attach-outline";
  if (mimeType.startsWith("image/")) return "image-outline";
  if (mimeType === "application/pdf") return "document-text-outline";
  if (mimeType.includes("word") || mimeType.includes("document"))
    return "document-text-outline";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel"))
    return "grid-outline";
  return "attach-outline";
}

function defaultPhotoFilename(sequence?: number): string {
  const now = new Date();
  const pad = (n: number, d = 2) => String(n).padStart(d, "0");
  const dateStr = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("-");
  const timeStr = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const suffix = sequence == null ? "" : `-${sequence + 1}`;
  return `photo-${dateStr}-${timeStr}${suffix}.jpg`;
}

function sanitizeFilename(input: string, fallback: string): string {
  const ext = fallback.match(/\.[^.]+$/)?.[0] ?? ".jpg";
  let name = input
    .replace(/[/\\:*?"<>|\x00]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return fallback;
  if (!name.toLowerCase().endsWith(ext.toLowerCase())) {
    name = name.replace(/\.[^.]*$/, "") + ext;
  }
  return name || fallback;
}

type StagedUpload = {
  uri: string;
  name: string;
  mimeType: string;
};

type QuickCase = {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
};

function InboxFileRow({
  file,
  labOrganizationId,
  colors,
  onAssigned,
}: {
  file: LabInboxFile;
  labOrganizationId: string;
  colors: ThemeColors;
  onAssigned: () => void;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<QuickCase[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isViewing, setIsViewing] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(file.note ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const qc = useQueryClient();
  const assignMutation = useAssignLabInboxFile({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({
          queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
        });
        onAssigned();
      },
      onError: (err: Error) => {
        Alert.alert("Assignment failed", err.message || "Please try again.");
        setIsAssigning(false);
      },
    },
  });
  const updateNoteMutation = useUpdateLabInboxFileNote({
    mutation: {
      onSuccess: () => {
        setIsEditingNote(false);
        void qc.invalidateQueries({
          queryKey: getListLabInboxFilesQueryKey({ labOrganizationId }),
        });
      },
      onError: (err: Error) => {
        Alert.alert("Could not save note", err.message || "Please try again.");
      },
    },
  });

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!assignOpen || query.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, labOrganizationId });
        const resp = await resilientFetch(
          `/api/cases/quick-search?${params.toString()}`,
        );
        const json = (await resp.json()) as {
          ok: boolean;
          data: { cases: QuickCase[] };
        };
        setSearchResults(json.data?.cases ?? []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, assignOpen, labOrganizationId]);

  const handleView = async () => {
    if (isViewing) return;
    setIsViewing(true);
    try {
      await openAttachment({
        url: `/api/lab-inbox/${file.id}/file`,
        fileName: file.originalFilename,
        fileType: file.mimeType,
      });
    } catch {
      Alert.alert("Could not open file", "Please try again.");
    } finally {
      setIsViewing(false);
    }
  };

  const handlePickCase = (caseId: string) => {
    setIsAssigning(true);
    setAssignOpen(false);
    setQuery("");
    assignMutation.mutate({ fileId: file.id, data: { caseId } });
  };

  const uploaderName =
    file.uploaderFirstName && file.uploaderLastName
      ? `${file.uploaderFirstName} ${file.uploaderLastName}`
      : (file.uploaderUsername ?? "Unknown");

  const isNoteOnly = !file.storagePath;
  const s = makeRowStyles(colors);

  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        <View style={s.iconWrap}>
          <Ionicons
            name={isNoteOnly ? "chatbubble-outline" : (mimeIcon(file.mimeType) as any)}
            size={18}
            color={colors.tint}
          />
        </View>

        {isNoteOnly ? (
          <View style={s.fileMeta}>
            <Text style={s.fileName} numberOfLines={1}>
              Note only
            </Text>
            <Text style={s.fileSub}>{uploaderName}</Text>
          </View>
        ) : (
          <Pressable style={s.fileMeta} onPress={handleView} disabled={isViewing}>
            <Text style={s.fileName} numberOfLines={1}>
              {file.originalFilename}
            </Text>
            <Text style={s.fileSub}>
              {file.sizeBytes != null ? `${formatBytes(file.sizeBytes)} · ` : ""}{uploaderName}
            </Text>
          </Pressable>
        )}

        {!isNoteOnly && (
          <View style={s.rowActions}>
            <Pressable
              style={s.viewBtn}
              onPress={handleView}
              disabled={isViewing}
              hitSlop={6}
            >
              {isViewing ? (
                <ActivityIndicator size={14} color={colors.tint} />
              ) : (
                <Ionicons name="eye-outline" size={16} color={colors.tint} />
              )}
            </Pressable>

            <Pressable
              style={[s.assignBtn, (isAssigning || assignMutation.isPending) && s.assignBtnDisabled]}
              onPress={() => {
                if (isAssigning || assignMutation.isPending) return;
                setAssignOpen((v) => !v);
                if (assignOpen) setQuery("");
              }}
              disabled={isAssigning || assignMutation.isPending}
            >
              {isAssigning || assignMutation.isPending ? (
                <ActivityIndicator size={12} color={colors.textInverse} />
              ) : assignOpen ? (
                <Ionicons name="close" size={12} color={colors.textInverse} />
              ) : (
                <Ionicons name="link-outline" size={12} color={colors.textInverse} />
              )}
              <Text style={s.assignBtnText}>
                {assignOpen ? "Cancel" : "Assign"}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Provider note — shown for all rows that carry one */}
      {isEditingNote ? (
        <View style={s.noteEditor}>
          <TextInput
            style={s.noteEditorInput}
            value={noteDraft}
            onChangeText={setNoteDraft}
            placeholder="Optional note"
            placeholderTextColor={colors.textTertiary}
            multiline
            maxLength={2000}
            autoFocus
            testID={`inbox-note-input-${file.id}`}
          />
          <View style={s.noteEditorActions}>
            <Pressable
              onPress={() => {
                setNoteDraft(file.note ?? "");
                setIsEditingNote(false);
              }}
              disabled={updateNoteMutation.isPending}
            >
              <Text style={s.noteCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={s.noteSaveBtn}
              onPress={() =>
                updateNoteMutation.mutate({
                  fileId: file.id,
                  data: { note: noteDraft.trim() || null },
                })
              }
              disabled={updateNoteMutation.isPending}
              testID={`inbox-note-save-${file.id}`}
            >
              {updateNoteMutation.isPending ? (
                <ActivityIndicator size={12} color={colors.textInverse} />
              ) : (
                <Text style={s.noteSaveText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          style={s.noteDisplay}
          onPress={() => {
            setNoteDraft(file.note ?? "");
            setIsEditingNote(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={file.note ? "Edit inbox note" : "Add inbox note"}
        >
          {file.note ? (
            <Text style={s.providerNote} numberOfLines={4}>
              &ldquo;{file.note}&rdquo;
            </Text>
          ) : (
            <Text style={s.addNoteText}>Add note</Text>
          )}
          <Ionicons name="pencil-outline" size={13} color={colors.textTertiary} />
        </Pressable>
      )}

      {assignOpen && (
        <View style={s.searchPanel}>
          <View style={s.searchInputWrap}>
            <Ionicons name="search" size={14} color={colors.textTertiary} />
            <TextInput
              style={s.searchInput}
              placeholder="Type to search cases…"
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {isSearching && (
              <ActivityIndicator size={12} color={colors.textTertiary} />
            )}
          </View>

          {query.length > 0 && query.length < 2 && (
            <Text style={s.searchHint}>Type at least 2 characters…</Text>
          )}

          {query.length >= 2 && !isSearching && searchResults.length === 0 && (
            <Text style={s.searchHint}>No cases found.</Text>
          )}

          {searchResults.length > 0 && (
            <ScrollView
              style={s.results}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
            >
              {searchResults.map((c) => (
                <Pressable
                  key={c.id}
                  style={s.resultRow}
                  onPress={() => handlePickCase(c.id)}
                >
                  <Text style={s.resultName} numberOfLines={1}>
                    {c.caseNumber ? `#${c.caseNumber} ` : ""}
                    {c.patientFirstName} {c.patientLastName}
                  </Text>
                  {c.doctorName ? (
                    <Text style={s.resultSub} numberOfLines={1}>
                      {c.doctorName}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

function makeRowStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      paddingVertical: Spacing.sm,
      borderBottomWidth: BorderWidth.section,
      borderBottomColor: colors.sectionBorder,
    },
    rowTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    iconWrap: {
      width: 30,
      height: 30,
      borderRadius: Radius.sm,
      backgroundColor: colors.tint + "18",
      alignItems: "center",
      justifyContent: "center",
    },
    fileMeta: {
      flex: 1,
      minWidth: 0,
    },
    fileName: {
      ...Typography.body,
      fontSize: 13,
      fontWeight: "500",
      color: colors.text,
    },
    fileSub: {
      ...Typography.caption,
      color: colors.textTertiary,
      marginTop: 1,
    },
    rowActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginLeft: Spacing.xs,
    },
    viewBtn: {
      width: 30,
      height: 30,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    assignBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      height: 30,
      borderRadius: Radius.sm,
      backgroundColor: colors.tint,
    },
    assignBtnDisabled: {
      opacity: 0.6,
    },
    assignBtnText: {
      ...Typography.caption,
      color: colors.textInverse,
      fontWeight: "600",
      fontSize: 12,
    },
    providerNote: {
      ...Typography.caption,
      color: colors.textSecondary,
      fontStyle: "italic",
      marginTop: 4,
      flex: 1,
    },
    noteDisplay: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 4,
      marginLeft: 38,
    },
    addNoteText: {
      ...Typography.caption,
      color: colors.textTertiary,
      flex: 1,
    },
    noteEditor: {
      marginTop: Spacing.xs,
      marginLeft: 38,
      gap: Spacing.xs,
    },
    noteEditorInput: {
      ...Typography.body,
      fontSize: 13,
      color: colors.text,
      minHeight: 64,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      backgroundColor: colors.background,
      textAlignVertical: "top",
    },
    noteEditorActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: Spacing.md,
    },
    noteCancelText: {
      ...Typography.caption,
      color: colors.textSecondary,
      fontWeight: "600",
    },
    noteSaveBtn: {
      minWidth: 54,
      height: 28,
      borderRadius: Radius.sm,
      backgroundColor: colors.tint,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.sm,
    },
    noteSaveText: {
      ...Typography.caption,
      color: colors.textInverse,
      fontWeight: "600",
    },
    searchPanel: {
      marginTop: Spacing.xs,
      marginLeft: 38,
    },
    searchInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
      backgroundColor: colors.surface,
    },
    searchInput: {
      flex: 1,
      ...Typography.body,
      fontSize: 13,
      color: colors.text,
      padding: 0,
    },
    searchHint: {
      ...Typography.caption,
      color: colors.textTertiary,
      marginTop: 6,
      paddingHorizontal: 2,
    },
    results: {
      marginTop: 4,
      maxHeight: 180,
      borderWidth: BorderWidth.section,
      borderColor: colors.sectionBorder,
      borderRadius: Radius.sm,
      backgroundColor: colors.surface,
    },
    resultRow: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      borderBottomWidth: BorderWidth.section,
      borderBottomColor: colors.sectionBorder,
    },
    resultName: {
      ...Typography.body,
      fontSize: 13,
      fontWeight: "500",
      color: colors.text,
    },
    resultSub: {
      ...Typography.caption,
      color: colors.textSecondary,
      marginTop: 1,
    },
  });
}

export function UnassignedDocumentsCard() {
  const { colors } = useTheme();
  const qc = useQueryClient();
  const meQuery = useMe();
  const labOrgId = primaryLabOrgId(meQuery.data) ?? "";

  const [collapsed, setCollapsed] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // ── Camera / rename modal state ──────────────────────────────────────────
  const [stagedUploads, setStagedUploads] = useState<StagedUpload[]>([]);
  const [activeUpload, setActiveUpload] = useState<StagedUpload | null>(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [noteValue, setNoteValue] = useState("");
  const defaultNameRef = useRef("");
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [photoUploadProgress, setPhotoUploadProgress] = useState<number | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const filesQuery = useListLabInboxFiles(
    { labOrganizationId: labOrgId },
    {
      query: {
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
        enabled: !!labOrgId,
        refetchInterval: 60_000,
      },
    },
  );

  const files = filesQuery.data?.data ?? [];
  const count = files.length;

  const beginConfirmation = useCallback((items: StagedUpload[]) => {
    const first = items[0];
    if (!first) return;
    setStagedUploads(items);
    setActiveUpload(first);
    defaultNameRef.current = first.name;
    setRenameValue(first.name);
    setNoteValue("");
    setPhotoError(null);
    setShowRenameModal(true);
  }, []);

  const handlePickAndUpload = useCallback(async () => {
    if (isUploading || !labOrgId) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;

      beginConfirmation(result.assets.filter(Boolean).map((asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
      })));
    } catch (err) {
      Alert.alert(
        "Upload failed",
        err instanceof Error ? err.message : "Please try again.",
      );
    }
  }, [isUploading, labOrgId, beginConfirmation]);

  const handlePickFromLibrary = useCallback(async () => {
    if (isUploadingPhoto || isUploading || !labOrgId) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted && permission.status !== "granted") {
        Alert.alert(
          "Photo Library Permission Required",
          "LabTrax needs photo access to add documents from your library. Please enable it in your device Settings.",
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        allowsMultipleSelection: true,
        quality: 0.85,
        selectionLimit: 20,
      });
      if (result.canceled || !result.assets?.length) return;

      const normalized: StagedUpload[] = [];
      for (const [index, asset] of result.assets.entries()) {
        if (!asset?.uri) continue;
        const resized = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1200 } }],
          { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
        );
        const sourceName = asset.fileName ?? defaultPhotoFilename(index);
        const base = sourceName.replace(/\.[^.]+$/, "") || "photo";
        normalized.push({
          uri: resized.uri,
          name: sanitizeFilename(`${base}.jpg`, defaultPhotoFilename()),
          mimeType: "image/jpeg",
        });
      }
      beginConfirmation(normalized);
    } catch (err) {
      Alert.alert(
        "Could not open photo library",
        err instanceof Error ? err.message : "Please try again.",
      );
    }
  }, [isUploadingPhoto, isUploading, labOrgId, beginConfirmation]);

  const handleTakePhoto = useCallback(async () => {
    if (isUploadingPhoto || !labOrgId) return;

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Camera Permission Required",
        "LabTrax needs camera access to capture documents. Please enable it in your device Settings.",
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: "images",
      quality: 0.85,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    if (!asset?.uri) return;

    const resized = await ImageManipulator.manipulateAsync(
      asset.uri,
      [{ resize: { width: 1200 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
    );

    beginConfirmation([{
      uri: resized.uri,
      name: defaultPhotoFilename(),
      mimeType: "image/jpeg",
    }]);
  }, [isUploadingPhoto, labOrgId, beginConfirmation]);

  const intakeRef = useRef({ browse: handlePickAndUpload, photo: handleTakePhoto });
  intakeRef.current = { browse: handlePickAndUpload, photo: handleTakePhoto };
  useEffect(
    () =>
      subscribeRxIntake((action) => {
        if (action === "reveal") setCollapsed(false);
        else if (action === "browse") void intakeRef.current.browse();
        else void intakeRef.current.photo();
      }),
    [],
  );

  const handleRenameConfirm = useCallback(async () => {
    if (!activeUpload || !labOrgId) return;

    const defaultName = defaultNameRef.current;
    const finalName = sanitizeFilename(renameValue.trim(), defaultName);

    setShowRenameModal(false);
    setIsUploadingPhoto(true);
    setIsUploading(true);
    setPhotoUploadProgress(0);
    setPhotoError(null);

    try {
      const saveResult = await saveFileToUnassignedDocuments({
        fileUri: activeUpload.uri,
        fileName: finalName,
        mimeType: activeUpload.mimeType,
        labOrganizationId: labOrgId,
        note: noteValue,
        onProgress: (fraction) => setPhotoUploadProgress(Math.round(fraction * 100)),
      });

      if (!saveResult.ok) {
        setPhotoError(saveResult.error || "Upload failed. Tap to retry.");
        return;
      }

      const remaining = stagedUploads.slice(1);
      if (remaining.length > 0) {
        setStagedUploads(remaining);
        setActiveUpload(remaining[0] ?? null);
        defaultNameRef.current = remaining[0]?.name ?? "";
        setRenameValue(remaining[0]?.name ?? "");
        setNoteValue("");
        setShowRenameModal(true);
      } else {
        setStagedUploads([]);
        setActiveUpload(null);
        setNoteValue("");
      }
      void qc.invalidateQueries({
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
      });
      if (collapsed) setCollapsed(false);
      setPhotoError(null);
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Upload failed. Tap to retry.",
      );
    } finally {
      setIsUploadingPhoto(false);
      setIsUploading(false);
      setPhotoUploadProgress(null);
    }
  }, [activeUpload, stagedUploads, renameValue, noteValue, labOrgId, qc, collapsed]);

  const handleRenameCancel = useCallback(() => {
    setShowRenameModal(false);
    setActiveUpload(null);
    setStagedUploads([]);
    setRenameValue("");
    setNoteValue("");
    setPhotoError(null);
  }, []);

  const handleRetryPhotoUpload = useCallback(async () => {
    if (!activeUpload || isUploadingPhoto || !labOrgId) return;
    const finalName = sanitizeFilename(renameValue.trim(), defaultNameRef.current);
    setIsUploadingPhoto(true);
    setIsUploading(true);
    setPhotoUploadProgress(0);
    setPhotoError(null);

    try {
      const saveResult = await saveFileToUnassignedDocuments({
        fileUri: activeUpload.uri,
        fileName: finalName,
        mimeType: activeUpload.mimeType,
        labOrganizationId: labOrgId,
        note: noteValue,
        onProgress: (fraction) => setPhotoUploadProgress(Math.round(fraction * 100)),
      });

      if (!saveResult.ok) {
        setPhotoError(saveResult.error || "Upload failed. Tap to retry.");
        return;
      }

      const remaining = stagedUploads.slice(1);
      if (remaining.length > 0) {
        setStagedUploads(remaining);
        setActiveUpload(remaining[0] ?? null);
        defaultNameRef.current = remaining[0]?.name ?? "";
        setRenameValue(remaining[0]?.name ?? "");
        setNoteValue("");
        setShowRenameModal(true);
      } else {
        setActiveUpload(null);
        setStagedUploads([]);
        setNoteValue("");
      }
      void qc.invalidateQueries({
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
      });
      if (collapsed) setCollapsed(false);
      setPhotoError(null);
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Upload failed. Tap to retry.",
      );
    } finally {
      setIsUploadingPhoto(false);
      setIsUploading(false);
      setPhotoUploadProgress(null);
    }
  }, [activeUpload, stagedUploads, renameValue, noteValue, isUploadingPhoto, labOrgId, qc, collapsed]);

  const handleAssigned = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
    });
  }, [qc, labOrgId]);

  const styles = makeStyles(colors);
  const dismissKeyboardOnModalTap = useDismissKeyboardOnTap();

  if (!labOrgId) return null;

  return (
    <DismissKeyboardView
      style={styles.card}
      testID="unassigned-documents-card-keyboard-dismiss"
    >
      {/* ── Rename modal ─────────────────────────────────────────────────── */}
      <Modal
        visible={showRenameModal}
        transparent
        animationType="fade"
        onRequestClose={handleRenameCancel}
      >
        <Pressable style={styles.modalOverlay} onPress={handleRenameCancel}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.modalKav}
          >
            <Pressable style={styles.modalBox} onPress={dismissKeyboardOnModalTap}>
              <Text style={styles.modalTitle}>
                Add document
              </Text>
              <Text style={styles.modalSubtitle}>
                {stagedUploads.length > 1
                  ? `${stagedUploads.length} documents queued. Confirm each one before uploading.`
                  : "Edit the filename and optionally add a note before uploading."}
              </Text>
              <TextInput
                style={styles.modalInput}
                value={renameValue}
                onChangeText={setRenameValue}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                selectTextOnFocus
                returnKeyType="done"
                onSubmitEditing={handleRenameConfirm}
                placeholderTextColor={colors.textTertiary}
              />
              <TextInput
                style={[styles.modalInput, styles.noteInput]}
                value={noteValue}
                onChangeText={setNoteValue}
                placeholder="Optional note"
                placeholderTextColor={colors.textTertiary}
                multiline
                maxLength={2000}
                testID="unassigned-document-note"
              />
              <View style={styles.modalButtons}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={handleRenameCancel}
                  testID="unassigned-document-cancel"
                >
                  <Text style={styles.modalBtnCancelText}>Discard</Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnConfirm]}
                  onPress={handleRenameConfirm}
                  testID="unassigned-document-upload"
                >
                  <Text style={styles.modalBtnConfirmText}>Upload</Text>
                </Pressable>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <Pressable
        style={styles.header}
        onPress={() => setCollapsed((v) => !v)}
      >
        <View style={styles.headerLeft}>
          <Ionicons name="mail-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.headerTitle}>Unassigned Documents</Text>
          {count > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{count}</Text>
            </View>
          )}
        </View>

        <View style={styles.headerRight}>
          {/* Camera button */}
          <Pressable
            onPress={handleTakePhoto}
            hitSlop={8}
            style={styles.addBtn}
            disabled={isUploadingPhoto || isUploading}
          >
            {isUploadingPhoto ? (
              <ActivityIndicator size={14} color={colors.tint} />
            ) : (
              <Ionicons name="camera-outline" size={16} color={colors.tint} />
            )}
          </Pressable>

          {/* Photo library button */}
          <Pressable
            onPress={handlePickFromLibrary}
            hitSlop={8}
            style={styles.addBtn}
            disabled={isUploadingPhoto || isUploading}
            accessibilityLabel="Choose photos from library"
          >
            <Ionicons name="images-outline" size={16} color={colors.tint} />
          </Pressable>

          {/* File picker button */}
          <Pressable
            onPress={handlePickAndUpload}
            hitSlop={8}
            style={styles.addBtn}
            disabled={isUploading || isUploadingPhoto}
          >
            {isUploading ? (
              <ActivityIndicator size={14} color={colors.tint} />
            ) : (
              <Ionicons name="add" size={16} color={colors.tint} />
            )}
          </Pressable>

          <Ionicons
            name={collapsed ? "chevron-down" : "chevron-up"}
            size={16}
            color={colors.textTertiary}
          />
        </View>
      </Pressable>

      {/* ── Upload progress banners ───────────────────────────────────────── */}
      {isUploading && uploadProgress !== null && (
        <View style={styles.progressBanner}>
          <ActivityIndicator size={12} color={colors.tint} />
          <Text style={styles.progressText}>
            Uploading… {uploadProgress}%
          </Text>
        </View>
      )}

      {isUploadingPhoto && photoUploadProgress !== null && (
        <View style={styles.progressBanner}>
          <ActivityIndicator size={12} color={colors.tint} />
          <Text style={styles.progressText}>
            Uploading photo… {photoUploadProgress}%
          </Text>
        </View>
      )}

      {photoError && activeUpload && (
        <Pressable style={styles.errorBanner} onPress={handleRetryPhotoUpload}>
          <Ionicons name="alert-circle-outline" size={14} color="#EF4444" />
          <Text style={styles.errorBannerText}>{photoError}</Text>
          <Text style={styles.errorBannerRetry}>Retry</Text>
        </Pressable>
      )}

      {!collapsed && (
        <View style={styles.body}>
          {filesQuery.isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator size="small" color={colors.tint} />
            </View>
          ) : count === 0 ? (
            <Text style={styles.emptyText}>
              No unassigned documents. Tap + or 📷 to add.
            </Text>
          ) : (
            files.map((file) => (
              <InboxFileRow
                key={file.id}
                file={file}
                labOrganizationId={labOrgId}
                colors={colors}
                onAssigned={handleAssigned}
              />
            ))
          )}
        </View>
      )}
    </DismissKeyboardView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      marginHorizontal: Spacing.md,
      marginBottom: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.md,
      paddingVertical: 10,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      flex: 1,
    },
    headerTitle: {
      ...Typography.bodySemibold,
      fontSize: 14,
      color: colors.text,
    },
    badge: {
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: "#f59e0b",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 4,
    },
    badgeText: {
      fontSize: 10,
      fontWeight: "700",
      color: "#ffffff",
    },
    headerRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    addBtn: {
      width: 28,
      height: 28,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    progressBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: Spacing.md,
      paddingVertical: 6,
      backgroundColor: colors.tint + "12",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    progressText: {
      ...Typography.caption,
      color: colors.tint,
      fontSize: 12,
    },
    errorBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: Spacing.md,
      paddingVertical: 7,
      backgroundColor: "rgba(239,68,68,0.08)",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: "rgba(239,68,68,0.3)",
    },
    errorBannerText: {
      flex: 1,
      ...Typography.caption,
      color: "#EF4444",
      fontSize: 12,
    },
    errorBannerRetry: {
      ...Typography.caption,
      color: "#EF4444",
      fontWeight: "700",
      fontSize: 12,
    },
    body: {
      paddingHorizontal: Spacing.md,
      paddingBottom: Spacing.sm,
    },
    center: {
      alignItems: "center",
      paddingVertical: Spacing.md,
    },
    emptyText: {
      ...Typography.caption,
      color: colors.textTertiary,
      textAlign: "center",
      paddingVertical: Spacing.sm,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center",
      alignItems: "center",
    },
    modalKav: {
      width: "100%",
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
    },
    modalBox: {
      width: "100%",
      backgroundColor: colors.surface,
      borderRadius: Radius.lg,
      padding: Spacing.lg,
      gap: Spacing.sm,
    },
    modalTitle: {
      ...Typography.bodySemibold,
      fontSize: 16,
      color: colors.text,
    },
    modalSubtitle: {
      ...Typography.caption,
      color: colors.textSecondary,
      fontSize: 13,
    },
    modalInput: {
      ...Typography.body,
      fontSize: 14,
      color: colors.text,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 10,
      backgroundColor: colors.background,
      marginTop: Spacing.xs,
    },
    noteInput: {
      minHeight: 56,
      textAlignVertical: "top",
    },
    modalButtons: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    modalBtn: {
      flex: 1,
      height: 42,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    modalBtnCancel: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    modalBtnConfirm: {
      backgroundColor: colors.tint,
    },
    modalBtnCancelText: {
      ...Typography.body,
      fontSize: 14,
      color: colors.textSecondary,
      fontWeight: "600",
    },
    modalBtnConfirmText: {
      ...Typography.body,
      fontSize: 14,
      color: colors.textInverse,
      fontWeight: "600",
    },
  });
}
