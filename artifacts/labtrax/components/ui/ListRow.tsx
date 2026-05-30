import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface ListRowProps {
  title: string;
  subtitle?: string;
  meta?: string;
  leadingIcon?: keyof typeof Ionicons.glyphMap;
  leadingIconColor?: string;
  leadingIconBg?: string;
  leadingInitials?: string;
  trailingBadge?: React.ReactNode;
  showChevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
  style?: object;
}

export function ListRow({
  title,
  subtitle,
  meta,
  leadingIcon,
  leadingIconColor,
  leadingIconBg,
  leadingInitials,
  trailingBadge,
  showChevron = true,
  onPress,
  onLongPress,
  testID,
  style,
}: ListRowProps) {
  const { colors, isDark } = useTheme();

  const iconBg = leadingIconBg ?? (isDark ? colors.surfaceSecondary : colors.surfaceAlt);
  const iconColor = leadingIconColor ?? colors.tint;

  const content = (
    <View style={[styles.row, { borderBottomColor: colors.border }, style]}>
      {(leadingIcon || leadingInitials) && (
        <View style={[styles.leading, { backgroundColor: iconBg }]}>
          {leadingIcon ? (
            <Ionicons name={leadingIcon} size={18} color={iconColor} />
          ) : (
            <Text style={[styles.initials, { color: iconColor }]}>{leadingInitials}</Text>
          )}
        </View>
      )}

      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text style={[styles.meta, { color: colors.textTertiary }]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>

      <View style={styles.trailing}>
        {trailingBadge}
        {showChevron && (
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        )}
      </View>
    </View>
  );

  if (!onPress && !onLongPress) {
    return content;
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      style={({ pressed }) => [pressed && { opacity: 0.7 }]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  leading: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  initials: {
    ...Typography.bodySemibold,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...Typography.bodyMedium,
  },
  subtitle: {
    ...Typography.caption,
    marginTop: 2,
  },
  meta: {
    ...Typography.caption,
    fontSize: 11,
    marginTop: 2,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    flexShrink: 0,
  },
});
