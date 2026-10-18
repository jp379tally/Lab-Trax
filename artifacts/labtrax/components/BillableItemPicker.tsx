import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import {
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";

export interface BillableItem {
  id: string;
  priceKey?: string | null;
  name: string;
  unitPrice: string | number | null;
}

export interface BillableItemPickerResult {
  isCustom: boolean;
  itemId: string | null;
  priceKey: string | null;
  label: string;
  unitPrice: string | null;
}

interface Props {
  visible: boolean;
  items: BillableItem[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  onSelect: (result: BillableItemPickerResult) => void;
  onClose: () => void;
}

export function BillableItemPicker({
  visible,
  items,
  isLoading = false,
  isError = false,
  onRetry,
  onSelect,
  onClose,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [search, setSearch] = useState("");
  const dismissKeyboardOnSheetTap = useDismissKeyboardOnTap();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, search]);

  function handleClose() {
    setSearch("");
    onClose();
  }

  function handleSelect(result: BillableItemPickerResult) {
    setSearch("");
    onSelect(result);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={styles.backdrop}
          onPress={handleClose}
          testID="billable-item-picker-backdrop"
        >
          <Pressable
            style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.md }]}
            // The sheet swallows the tap so it never reaches the closing
            // backdrop; while the keyboard is up it also closes it.
            onPress={dismissKeyboardOnSheetTap}
            testID="billable-item-picker-sheet"
          >
            <View style={styles.grabber} />
            <View style={styles.header}>
              <Text style={styles.title}>Select Item</Text>
              <Pressable onPress={handleClose} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.searchWrap}>
              <Ionicons name="search-outline" size={15} color={colors.textTertiary} style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search items…"
                placeholderTextColor={colors.textTertiary}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                testID="billable-item-picker-search"
              />
            </View>

            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
              testID="billable-item-picker-list"
            >
              <Pressable
                style={styles.customRow}
                onPress={() =>
                  handleSelect({
                    isCustom: true,
                    itemId: null,
                    priceKey: null,
                    label: "",
                    unitPrice: null,
                  })
                }
                testID="billable-item-picker-custom"
              >
                <Ionicons name="create-outline" size={16} color={colors.tint} style={{ marginTop: 1 }} />
                <View style={styles.itemTextWrap}>
                  <Text style={[styles.itemName, { color: colors.tint }]}>Custom / manual</Text>
                  <Text style={styles.itemSub}>Type a custom description and price</Text>
                </View>
              </Pressable>

              {isLoading ? (
                <View style={styles.stateRow} testID="billable-item-picker-loading">
                  <ActivityIndicator size="small" color={colors.tint} />
                  <Text style={styles.stateText}>Loading billable items…</Text>
                </View>
              ) : isError ? (
                <View style={styles.stateColumn} testID="billable-item-picker-error">
                  <Text style={styles.stateText}>
                    Billable items couldn't be loaded. You can retry or use a custom line.
                  </Text>
                  {onRetry ? (
                    <Pressable onPress={onRetry} testID="billable-item-picker-retry">
                      <Text style={styles.retryText}>Try again</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : items.length === 0 ? (
                <Text style={styles.emptyText} testID="billable-item-picker-empty">
                  No active billable items are configured. Use Custom / manual to continue.
                </Text>
              ) : filtered.length === 0 && search.trim().length > 0 ? (
                <Text style={styles.emptyText}>No items match "{search.trim()}"</Text>
              ) : (
                filtered.map((item) => {
                  const priceNum = item.unitPrice != null ? Number(item.unitPrice) : null;
                  const priceStr =
                    priceNum != null && Number.isFinite(priceNum)
                      ? priceNum.toFixed(2)
                      : null;
                  return (
                    <Pressable
                      key={item.id}
                      style={({ pressed }) => [styles.itemRow, pressed && styles.itemRowPressed]}
                      onPress={() =>
                        handleSelect({
                          isCustom: false,
                          itemId: item.id,
                          priceKey: item.priceKey ?? null,
                          label: item.name,
                          unitPrice: priceStr,
                        })
                      }
                      testID={`billable-item-picker-item-${item.id}`}
                    >
                      <View style={styles.itemTextWrap}>
                        <Text style={styles.itemName}>{item.name}</Text>
                      </View>
                      {priceStr != null && (
                        <Text style={styles.itemPrice}>${priceStr}</Text>
                      )}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: c.backgroundSolid ?? c.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      maxHeight: "75%",
    },
    grabber: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: Radius.full,
      backgroundColor: c.border,
      marginBottom: Spacing.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.sm,
    },
    title: { ...Typography.h2, color: c.text },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surfaceAlt,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: Spacing.sm,
      marginBottom: Spacing.sm,
    },
    searchIcon: { marginRight: Spacing.xs },
    searchInput: {
      flex: 1,
      ...Typography.body,
      color: c.text,
      paddingVertical: Spacing.sm,
    },
    list: { flexGrow: 0 },
    listContent: { paddingBottom: Spacing.sm },
    customRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.md,
      marginBottom: Spacing.xs,
      backgroundColor: c.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    itemRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.sm,
      gap: Spacing.sm,
    },
    itemRowPressed: { backgroundColor: c.surfaceAlt },
    itemTextWrap: { flex: 1 },
    itemName: { ...Typography.bodyMedium, color: c.text },
    itemSub: { ...Typography.caption, color: c.textTertiary, marginTop: 1 },
    itemPrice: {
      ...Typography.caption,
      color: c.textSecondary,
      fontVariant: ["tabular-nums"],
      minWidth: 52,
      textAlign: "right",
    },
    emptyText: { ...Typography.caption, color: c.textTertiary, padding: Spacing.md, textAlign: "center" },
    stateRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      padding: Spacing.lg,
    },
    stateColumn: {
      alignItems: "center",
      gap: Spacing.sm,
      padding: Spacing.lg,
    },
    stateText: {
      ...Typography.caption,
      color: c.textSecondary,
      textAlign: "center",
    },
    retryText: { ...Typography.bodyMedium, color: c.tint },
  });
}
