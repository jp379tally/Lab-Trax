import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
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
      const uploadResult = await chunkedUploadCaseMedia(
        asset.uri,
        asset.name,
        asset.mimeType ?? "application/octet-stream",
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
    }
  }, [isUploading, labOrgId, qc, collapsed]);

  const handleAssigned = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: getListLabInboxFilesQueryKey({ labOrganizationId: labOrgId }),
    });
  }, [qc, labOrgId]);

  const styles = makeStyles(colors);

  if (!labOrgId) return null;

  return (
    <View style={styles.card}>
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
          <Pressable
            onPress={handlePickAndUpload}
            hitSlop={8}
            style={styles.addBtn}
            disabled={isUploading}
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

      {!collapsed && (
        <View style={styles.body}>
          {filesQuery.isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator size="small" color={colors.tint} />
            </View>
          ) : count === 0 ? (
            <Text style={styles.emptyText}>
              No unassigned documents. Tap + to add a file.
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
  });
}
