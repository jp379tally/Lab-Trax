import React, { useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { isForbiddenError } from "@/lib/read-api";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

// Minimal slice of a React Query result so callers can pass either a generated
// hook result (useInvoices) or a useQuery built on the read-api helper.
export interface ListScreenQuery<T> {
  data: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: unknown;
  refetch: () => unknown;
}

interface BlockedState {
  icon?: IconName;
  title: string;
  body: string;
}

interface ListScreenProps<T> {
  title: string;
  subtitle?: string;
  query: ListScreenQuery<T>;
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T) => React.ReactElement;
  ListHeader?: React.ReactElement | null;
  emptyIcon?: IconName;
  emptyTitle?: string;
  emptyBody?: string;
  errorTitle?: string;
  // When set, render this message instead of the list (e.g. permission gate).
  blocked?: BlockedState | null;
  // Optional element rendered on the right side of the header (e.g. an export
  // or add action).
  headerRight?: React.ReactElement | null;
}

/**
 * ListScreen — the canonical read-only list scaffold for the parity screens.
 * Provides a back header, loading / error / empty / blocked states, and a
 * pull-to-refresh FlatList, so each screen only supplies its row renderer.
 */
export function ListScreen<T>({
  title,
  subtitle,
  query,
  keyExtractor,
  renderItem,
  ListHeader = null,
  emptyIcon = "file-tray-outline",
  emptyTitle = "Nothing here yet",
  emptyBody = "Items will appear here.",
  errorTitle = "Couldn’t load",
  blocked = null,
  headerRight = null,
}: ListScreenProps<T>) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const items = query.data ?? [];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} testID="list-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {headerRight ? <View style={styles.headerRight}>{headerRight}</View> : null}
      </View>

      {blocked ? (
        <View style={styles.center}>
          <Ionicons name={blocked.icon ?? "lock-closed-outline"} size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>{blocked.title}</Text>
          <Text style={styles.emptyBody}>{blocked.body}</Text>
        </View>
      ) : query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : query.isError && isForbiddenError(query.error) ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Not available</Text>
          <Text style={styles.emptyBody}>You don’t have access to this for your current role.</Text>
        </View>
      ) : query.isError ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>{errorTitle}</Text>
          <Pressable style={styles.retryBtn} onPress={() => query.refetch()} testID="list-retry">
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={({ item }) => renderItem(item)}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={ListHeader}
          refreshControl={
            <RefreshControl
              refreshing={query.isFetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.tint}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name={emptyIcon} size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{emptyTitle}</Text>
              <Text style={styles.emptyBody}>{emptyBody}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
      gap: Spacing.xs,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    headerText: { flex: 1 },
    headerRight: { marginLeft: Spacing.xs },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    listContent: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
      minHeight: 280,
    },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: c.textInverse },
  });
}
