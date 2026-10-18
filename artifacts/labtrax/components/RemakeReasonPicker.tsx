import React from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { REMAKE_REASONS } from "@workspace/case-taxonomy";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import type { ThemeColors } from "@/lib/theme-context";

export const MOBILE_REMAKE_REASONS = REMAKE_REASONS.map((reason) => ({
  ...reason,
  group: reason.category === "crown_bridge" ? "Crown & Bridge" : "Removable",
}));

const REMAKE_REASON_GROUPS = ["Crown & Bridge", "Removable"] as const;

interface RemakeReasonPickerProps {
  colors: ThemeColors;
  selectedReasonKey: string;
  onSelectReason: (key: string) => void;
  testIdSuffix?: string;
}

export function RemakeReasonPicker({
  colors,
  selectedReasonKey,
  onSelectReason,
  testIdSuffix = "",
}: RemakeReasonPickerProps) {
  return (
    <>
      <Text
        style={[
          Typography.label,
          { color: colors.textSecondary, marginBottom: Spacing.xs },
        ]}
      >
        Remake reason *
      </Text>
      {REMAKE_REASON_GROUPS.map((group) => (
        <View key={group}>
          <Text
            style={[
              Typography.caption,
              {
                color: colors.textTertiary,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: Spacing.xs,
                marginTop: Spacing.xs,
              },
            ]}
          >
            {group}
          </Text>
          {MOBILE_REMAKE_REASONS.filter((reason) => reason.group === group).map(
            (reason) => {
              const selected = selectedReasonKey === reason.key;
              return (
                <Pressable
                  key={reason.key}
                  testID={`remake-reason-${reason.key}${testIdSuffix}`}
                  onPress={() => onSelectReason(reason.key)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: Spacing.sm,
                    paddingHorizontal: Spacing.md,
                    marginBottom: 2,
                    borderRadius: Radius.sm,
                    backgroundColor: selected
                      ? colors.tint + "22"
                      : colors.surfaceSecondary,
                    borderWidth: 1,
                    borderColor: selected ? colors.tint : colors.border,
                  }}
                >
                  <Ionicons
                    name={selected ? "radio-button-on" : "radio-button-off"}
                    size={16}
                    color={selected ? colors.tint : colors.textTertiary}
                    style={{ marginRight: Spacing.sm }}
                  />
                  <Text
                    style={[
                      Typography.body,
                      {
                        color: selected ? colors.tint : colors.text,
                        flex: 1,
                      },
                    ]}
                  >
                    {reason.label}
                  </Text>
                </Pressable>
              );
            },
          )}
        </View>
      ))}
    </>
  );
}