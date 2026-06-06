import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

// ─── helpers ────────────────────────────────────────────────────────────────

function formatFileSize(bytes?: number): string {
  if (bytes == null || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type DocIconKind = "pdf" | "doc" | "xls" | "img" | "file";

function getIconKind(mimeType?: string, name?: string): DocIconKind {
  const m = (mimeType || "").toLowerCase();
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (
    m.includes("wordprocessingml") ||
    m.includes("msword") ||
    ["doc", "docx", "odt", "rtf"].includes(ext)
  )
    return "doc";
  if (
    m.includes("spreadsheetml") ||
    m.includes("ms-excel") ||
    ["xls", "xlsx", "csv", "ods"].includes(ext)
  )
    return "xls";
  if (m.startsWith("image/")) return "img";
  return "file";
}

function getIconProps(
  kind: DocIconKind,
  colors: ThemeColors
): { name: React.ComponentProps<typeof Ionicons>["name"]; color: string; bg: string } {
  switch (kind) {
    case "pdf":
      return { name: "document-text", color: "#dc2626", bg: "#fee2e2" };
    case "doc":
      return { name: "document-text", color: "#2563eb", bg: "#dbeafe" };
    case "xls":
      return { name: "grid", color: "#16a34a", bg: "#dcfce7" };
    case "img":
      return { name: "image", color: "#7c3aed", bg: "#ede9fe" };
    default:
      return {
        name: "document-outline",
        color: colors.textSecondary,
        bg: colors.surfaceAlt,
      };
  }
}

// ─── sort types ─────────────────────────────────────────────────────────────

type SortField = "name" | "date" | "size";
type SortDir = "asc" | "desc";

// ─── DocumentPickerRow ───────────────────────────────────────────────────────

interface DocumentPickerRowProps {
  asset: DocumentPicker.DocumentPickerAsset;
  selected: boolean;
  onToggle: () => void;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}

function DocumentPickerRow({
  asset,
  selected,
  onToggle,
  colors,
  styles,
}: DocumentPickerRowProps) {
  const kind = getIconKind(asset.mimeType, asset.name);
  const icon = getIconProps(kind, colors);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
    >
      <View style={[styles.fileIcon, { backgroundColor: icon.bg }]}>
        <Ionicons name={icon.name} size={20} color={icon.color} />
      </View>

      <View style={styles.rowMeta}>
        <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
          {asset.name}
        </Text>
        <Text style={styles.fileSub}>
          {formatDate(asset.lastModified)}
          {"  ·  "}
          {formatFileSize(asset.size)}
        </Text>
      </View>

      <View
        style={[
          styles.checkbox,
          selected && { backgroundColor: colors.tint, borderColor: colors.tint },
        ]}
      >
        {selected ? (
          <Ionicons name="checkmark" size={13} color={colors.textInverse} />
        ) : null}
      </View>
    </Pressable>
  );
}

// ─── DocumentPickerSheet (main export) ──────────────────────────────────────

export interface DocumentPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (assets: DocumentPicker.DocumentPickerAsset[]) => void;
}

export function DocumentPickerSheet({
  visible,
  onClose,
  onConfirm,
}: DocumentPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [assets, setAssets] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickDone, setPickDone] = useState(false);

  // Reset and open picker whenever the sheet becomes visible
  useEffect(() => {
    if (!visible) return;
    setAssets([]);
    setSelectedIds(new Set());
    setSearch("");
    setSortField("name");
    setSortDir("asc");
    setPickDone(false);
    setPicking(true);

    let cancelled = false;
    DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: true,
      multiple: true,
    })
      .then((result) => {
        if (cancelled) return;
        if (result.canceled || !result.assets?.length) {
          onClose();
          return;
        }
        const picked = result.assets;
        setAssets(picked);
        setSelectedIds(new Set(picked.map((a) => a.uri)));
        setPickDone(true);
      })
      .catch(() => {
        if (!cancelled) onClose();
      })
      .finally(() => {
        if (!cancelled) setPicking(false);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Sort + filter
  const displayedAssets = useMemo(() => {
    let list = assets;
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((a) => a.name.toLowerCase().includes(q));
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === "name") cmp = a.name.localeCompare(b.name);
      else if (sortField === "date")
        cmp = (a.lastModified || 0) - (b.lastModified || 0);
      else if (sortField === "size") cmp = (a.size || 0) - (b.size || 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [assets, search, sortField, sortDir]);

  const toggleAsset = useCallback((uri: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }, []);

  const toggleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField]
  );

  const handleConfirm = useCallback(() => {
    const chosen = assets.filter((a) => selectedIds.has(a.uri));
    if (!chosen.length) return;
    onConfirm(chosen);
  }, [assets, selectedIds, onConfirm]);

  const selectedCount = selectedIds.size;

  const paddingBottom = Math.max(insets.bottom + 16, 28);

  function SortButton({ field, label }: { field: SortField; label: string }) {
    const active = sortField === field;
    return (
      <Pressable
        style={({ pressed }) => [
          styles.sortBtn,
          active && styles.sortBtnActive,
          pressed && { opacity: 0.7 },
        ]}
        onPress={() => toggleSort(field)}
        accessibilityLabel={`Sort by ${label}`}
      >
        <Text style={[styles.sortBtnText, active && styles.sortBtnTextActive]}>
          {label}
        </Text>
        {active ? (
          <Ionicons
            name={sortDir === "asc" ? "chevron-up" : "chevron-down"}
            size={12}
            color={colors.tint}
          />
        ) : null}
      </Pressable>
    );
  }

  // Don't render a blank sheet while the native picker is open
  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.container,
          { paddingTop: Platform.OS === "ios" ? Math.max(insets.top, 8) : 16 },
        ]}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
            onPress={onClose}
            hitSlop={10}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Add Documents</Text>
          <View style={{ width: 60 }} />
        </View>

        {/* Picking / empty state */}
        {picking ? (
          <View style={styles.emptyState}>
            <Ionicons name="folder-open-outline" size={48} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>Opening file browser…</Text>
          </View>
        ) : !pickDone || assets.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-outline" size={48} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>No files selected</Text>
            <Text style={styles.emptySub}>
              Return to the home screen and try "Add Documents" again.
            </Text>
          </View>
        ) : (
          <>
            {/* Search */}
            <View style={styles.searchRow}>
              <View style={styles.searchWrap}>
                <Ionicons name="search" size={16} color={colors.textTertiary} style={{ marginRight: 6 }} />
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Filter by name…"
                  placeholderTextColor={colors.textTertiary}
                  returnKeyType="search"
                  clearButtonMode="while-editing"
                  autoCorrect={false}
                  spellCheck={false}
                />
              </View>
            </View>

            {/* Sort controls */}
            <View style={styles.sortRow}>
              <Text style={styles.sortLabel}>Sort:</Text>
              <SortButton field="name" label="Name" />
              <SortButton field="date" label="Date" />
              <SortButton field="size" label="Size" />
            </View>

            {/* File list */}
            <ScrollView
              style={styles.list}
              contentContainerStyle={[styles.listContent, { paddingBottom }]}
              keyboardShouldPersistTaps="handled"
            >
              {displayedAssets.length === 0 ? (
                <View style={styles.noResults}>
                  <Text style={styles.noResultsText}>No files match "{search}"</Text>
                </View>
              ) : (
                displayedAssets.map((asset) => (
                  <DocumentPickerRow
                    key={asset.uri}
                    asset={asset}
                    selected={selectedIds.has(asset.uri)}
                    onToggle={() => toggleAsset(asset.uri)}
                    colors={colors}
                    styles={styles}
                  />
                ))
              )}
            </ScrollView>
          </>
        )}

        {/* Footer action */}
        {pickDone && assets.length > 0 && (
          <View style={[styles.footer, { paddingBottom }]}>
            <Pressable
              style={({ pressed }) => [
                styles.addBtn,
                selectedCount === 0 && styles.addBtnDisabled,
                pressed && selectedCount > 0 && { opacity: 0.85 },
              ]}
              onPress={handleConfirm}
              disabled={selectedCount === 0}
            >
              <Ionicons
                name="cloud-upload-outline"
                size={18}
                color={selectedCount === 0 ? colors.textTertiary : colors.textInverse}
              />
              <Text
                style={[
                  styles.addBtnText,
                  selectedCount === 0 && styles.addBtnTextDisabled,
                ]}
              >
                {selectedCount === 0
                  ? "Select files to add"
                  : `Add ${selectedCount} file${selectedCount !== 1 ? "s" : ""}`}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ─── styles ─────────────────────────────────────────────────────────────────

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.surface,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontFamily: "Inter_700Bold",
      fontSize: 17,
      color: colors.text,
    },
    cancelBtn: {
      width: 60,
    },
    cancelText: {
      fontFamily: "Inter_400Regular",
      fontSize: 16,
      color: colors.tint,
    },
    searchRow: {
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.canvas,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: Platform.OS === "ios" ? 9 : 7,
    },
    searchInput: {
      flex: 1,
      fontFamily: "Inter_400Regular",
      fontSize: 14,
      color: colors.text,
      padding: 0,
    },
    sortRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingBottom: 8,
      gap: 6,
    },
    sortLabel: {
      fontFamily: "Inter_400Regular",
      fontSize: 12,
      color: colors.textSecondary,
      marginRight: 4,
    },
    sortBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: colors.canvas,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sortBtnActive: {
      backgroundColor: colors.infoSurface,
      borderColor: colors.tint,
    },
    sortBtnText: {
      fontFamily: "Inter_500Medium",
      fontSize: 12,
      color: colors.textSecondary,
    },
    sortBtnTextActive: {
      color: colors.tint,
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: 12,
      paddingTop: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 12,
      marginBottom: 2,
    },
    rowSelected: {
      backgroundColor: colors.infoSurface,
    },
    rowPressed: {
      opacity: 0.75,
    },
    fileIcon: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    rowMeta: {
      flex: 1,
      gap: 3,
    },
    fileName: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 14,
      color: colors.text,
    },
    fileSub: {
      fontFamily: "Inter_400Regular",
      fontSize: 11,
      color: colors.textTertiary,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface,
    },
    footer: {
      paddingHorizontal: 16,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    addBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: colors.tint,
      paddingVertical: 14,
      borderRadius: 14,
    },
    addBtnDisabled: {
      backgroundColor: colors.border,
    },
    addBtnText: {
      fontFamily: "Inter_700Bold",
      fontSize: 15,
      color: colors.textInverse,
    },
    addBtnTextDisabled: {
      color: colors.textTertiary,
    },
    emptyState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
      gap: 10,
    },
    emptyTitle: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 16,
      color: colors.text,
    },
    emptySub: {
      fontFamily: "Inter_400Regular",
      fontSize: 13,
      color: colors.textTertiary,
      textAlign: "center",
      lineHeight: 19,
    },
    noResults: {
      paddingTop: 32,
      alignItems: "center",
    },
    noResultsText: {
      fontFamily: "Inter_400Regular",
      fontSize: 14,
      color: colors.textTertiary,
      fontStyle: "italic",
    },
  });
