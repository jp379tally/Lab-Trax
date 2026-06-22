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
import * as FileSystem from "expo-file-system";
import {
  useListLabInboxFiles,
  useAssignLabInboxFile,
  getListLabInboxFilesQueryKey,
} from "@workspace/api-client-react";
import type { LabInboxFile } from "@workspace/api-client-react";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import {
  resilientFetch,
  chunkedUploadCaseMedia,
} from "@/lib/query-client";
import { openAttachment } from "@/lib/open-attachment";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function mimeIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image-outline";
  if (mimeType === "application/pdf") return "document-text-outline";
  if (mimeType.includes("word") || mimeType.includes("document"))
    return "document-text-outline";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel"))
    return "grid-outline";
  return "attach-outline";
}

function defaultPhotoFilename(): string {
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
  return `photo-${dateStr}-${timeStr}.jpg`;
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

  const s = makeRowStyles(colors);

  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        <View style={s.iconWrap}>
          <Ionicons
            name={mimeIcon(file.mimeType) as any}
            size={18}
            color={colors.tint}
          />
        </View>

        <Pressable style={s.fileMeta} onPress={handleView} disabled={isViewing}>
          <Text style={s.fileName} numberOfLines={1}>
            {file.originalFilename}
          </Text>
          <Text style={s.fileSub}>
            {formatBytes(file.sizeBytes)} · {uploaderName}
          </Text>
        </Pressable>

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
      </View>

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
            <ScrollView style={s.results} nestedScrollEnabled keyboardShouldPersistTaps="handled">
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
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
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
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      backgroundColor: colors.surface,
    },
    resultRow: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
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
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
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

  const handlePickAndUpload = useCallback(async () => {
    if (isUploading || !labOrgId) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!asset) return;

      setIsUploading(true);
      setUploadProgress(0);
      const uploadResult = await chunkedUploadCaseMedia(
        asset.uri,
        asset.name,
        asset.mimeType ?? "application/octet-stream",
        (fraction) => setUploadProgress(Math.round(fraction * 100)),
      );

      if (!uploadResult.ok) {
        Alert.alert("Upload failed", "Could not upload the file. Please try again.");
        return;
      }

      await resilientFetch("/api/lab-inbox/finalize-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: uploadResult.url,
          originalFilename: asset.name,
          mimeType: asset.mimeType ?? "application/octet-stream",
          sizeBytes: asset.size ?? 0,
          labOrganizationId: labOrgId,
        }),
      });

      void qc.invalidateQueries({
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
      });
      if (collapsed) setCollapsed(false);
    } catch (err) {
      Alert.alert(
        "Upload failed",
        err instanceof Error ? err.message : "Please try again.",
      );
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  }, [isUploading, labOrgId, qc, collapsed]);

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

    const defaultName = defaultPhotoFilename();
    defaultNameRef.current = defaultName;
    setCapturedUri(resized.uri);
    setRenameValue(defaultName);
    setPhotoError(null);
    setShowRenameModal(true);
  }, [isUploadingPhoto, labOrgId]);

  const handleRenameConfirm = useCallback(async () => {
    if (!capturedUri || !labOrgId) return;

    const defaultName = defaultNameRef.current;
    const finalName = sanitizeFilename(renameValue.trim(), defaultName);

    setShowRenameModal(false);
    setIsUploadingPhoto(true);
    setPhotoUploadProgress(0);
    setPhotoError(null);

    try {
      const uploadResult = await chunkedUploadCaseMedia(
        capturedUri,
        finalName,
        "image/jpeg",
        (fraction) => setPhotoUploadProgress(Math.round(fraction * 100)),
      );

      if (!uploadResult.ok) {
        setPhotoError("Upload failed. Tap to retry.");
        return;
      }

      let sizeBytes = 0;
      try {
        const info = await FileSystem.getInfoAsync(capturedUri);
        if (info.exists && "size" in info) sizeBytes = info.size ?? 0;
      } catch {
        // size metadata is best-effort; upload still succeeds without it
      }

      await resilientFetch("/api/lab-inbox/finalize-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: uploadResult.url,
          originalFilename: finalName,
          mimeType: "image/jpeg",
          sizeBytes,
          labOrganizationId: labOrgId,
        }),
      });

      void qc.invalidateQueries({
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
      });
      if (collapsed) setCollapsed(false);
      setCapturedUri(null);
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Upload failed. Tap to retry.",
      );
    } finally {
      setIsUploadingPhoto(false);
      setPhotoUploadProgress(null);
    }
  }, [capturedUri, renameValue, labOrgId, qc, collapsed]);

  const handleRenameCancel = useCallback(() => {
    setShowRenameModal(false);
    setCapturedUri(null);
    setRenameValue("");
    setPhotoError(null);
  }, []);

  const handleRetryPhotoUpload = useCallback(async () => {
    if (!capturedUri || isUploadingPhoto || !labOrgId) return;
    const finalName = sanitizeFilename(renameValue.trim(), defaultNameRef.current);
    setIsUploadingPhoto(true);
    setPhotoUploadProgress(0);
    setPhotoError(null);

    try {
      const uploadResult = await chunkedUploadCaseMedia(
        capturedUri,
        finalName,
        "image/jpeg",
        (fraction) => setPhotoUploadProgress(Math.round(fraction * 100)),
      );

      if (!uploadResult.ok) {
        setPhotoError("Upload failed. Tap to retry.");
        return;
      }

      let sizeBytes = 0;
      try {
        const info = await FileSystem.getInfoAsync(capturedUri);
        if (info.exists && "size" in info) sizeBytes = info.size ?? 0;
      } catch {
        // size metadata is best-effort
      }

      await resilientFetch("/api/lab-inbox/finalize-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: uploadResult.url,
          originalFilename: finalName,
          mimeType: "image/jpeg",
          sizeBytes,
          labOrganizationId: labOrgId,
        }),
      });

      void qc.invalidateQueries({
        queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
      });
      if (collapsed) setCollapsed(false);
      setCapturedUri(null);
      setPhotoError(null);
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Upload failed. Tap to retry.",
      );
    } finally {
      setIsUploadingPhoto(false);
      setPhotoUploadProgress(null);
    }
  }, [capturedUri, renameValue, isUploadingPhoto, labOrgId, qc, collapsed]);

  const handleAssigned = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
    });
  }, [qc, labOrgId]);

  const styles = makeStyles(colors);

  if (!labOrgId) return null;

  return (
    <View style={styles.card}>
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
            <Pressable style={styles.modalBox} onPress={() => {}}>
              <Text style={styles.modalTitle}>Name your photo</Text>
              <Text style={styles.modalSubtitle}>
                You can rename this photo before uploading it.
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
              <View style={styles.modalButtons}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={handleRenameCancel}
                >
                  <Text style={styles.modalBtnCancelText}>Discard</Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnConfirm]}
                  onPress={handleRenameConfirm}
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

      {photoError && capturedUri && (
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
    </View>
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
