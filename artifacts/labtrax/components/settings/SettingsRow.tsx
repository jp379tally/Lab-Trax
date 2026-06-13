import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export interface SettingsRowProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  value?: string;
  badge?: boolean;
  badgeColor?: string;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
  rightElement?: React.ReactNode;
}

export function SettingsRow({
  title,
  subtitle,
  icon,
  iconColor,
  iconBg,
  value,
  badge,
  badgeColor,
  onPress,
  showChevron = true,
  disabled = false,
  destructive = false,
  testID,
  rightElement,
}: SettingsRowProps) {
  const { colors } = useTheme();

  const titleColor = destructive ? colors.error : colors.text;
  const subtitleColor = colors.textSecondary;
  const resolvedIconColor = iconColor ?? colors.tint;
  const resolvedIconBg = iconBg ?? colors.tint + "1A";

  const inner = (
    <View style={styles.row}>
      {icon && (
        <View style={[styles.iconWrap, { backgroundColor: resolvedIconBg }]}>
          <Ionicons name={icon} size={19} color={resolvedIconColor} />
        </View>
      )}
      <View style={styles.main}>
        <Text style={[styles.title, { color: titleColor }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: subtitleColor }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {rightElement ?? null}
      {value ? (
        <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {badge ? (
        <View
          style={[
            styles.badge,
            { backgroundColor: badgeColor ?? colors.warning ?? "#F59E0B" },
          ]}
        />
      ) : null}
      {onPress && showChevron ? (
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      ) : null}
    </View>
  );

  if (!onPress) {
    return <View testID={testID}>{inner}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
    >
      {inner}
    </Pressable>
  );
}

export interface SettingsSectionProps {
  title?: string;
  children: React.ReactNode;
  footer?: string;
}

export function SettingsSection({ title, children, footer }: SettingsSectionProps) {
  const { colors } = useTheme();
  const items = React.Children.toArray(children).filter(Boolean);

  return (
    <View style={styles.section}>
      {title ? (
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          {title.toUpperCase()}
        </Text>
      ) : null}
      <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {items.map((child, idx) => (
          <View key={idx}>
            {idx > 0 && (
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
            )}
            {child}
          </View>
        ))}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: colors.textSecondary }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

export interface ScreenShellProps {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children: React.ReactNode;
  insetTop?: number;
}

export function ScreenShell({ title, subtitle, onBack, children, insetTop = 0 }: ScreenShellProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.backgroundSolid, paddingTop: insetTop }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={colors.tint} />
          <Text style={[styles.backLabel, { color: colors.tint }]}>Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.backBtn} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.md,
    minHeight: 50,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  main: { flex: 1, gap: 2 },
  title: { ...Typography.bodyMedium },
  subtitle: { ...Typography.caption },
  value: { ...Typography.caption, flexShrink: 0 },
  badge: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  section: { gap: 6 },
  sectionTitle: {
    ...Typography.label,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 4,
  },
  sectionCard: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: Spacing.lg + 34 + Spacing.md },
  footer: {
    ...Typography.caption,
    paddingHorizontal: Spacing.lg,
    paddingTop: 4,
  },
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minWidth: 70,
  },
  backLabel: { ...Typography.body },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { ...Typography.h3 },
  headerSubtitle: { ...Typography.caption },
});
