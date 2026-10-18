// Provider portal → Message My Lab.
//
// Mirrors the desktop ProviderMessageLab: the labs a provider can talk to are
// derived from their own cases, a picker appears only when there is more than
// one, a single lab is auto-selected, and the section then shows Chat (the
// live conversation) and Sent (the one-way note/file drop box) in that order.
//
// Both panels are keyed by the selected lab, so switching labs rebuilds them
// against the new lab instead of leaving the previous lab's thread on screen.
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useProviderLinkedLabs } from "@/lib/messenger";
import { ProviderLabChat } from "../messages/ProviderLabChat";
import { ProviderLabSentNotes } from "../messages/ProviderLabSentNotes";

type MessagesView = "chat" | "sent";

export function ProviderMessagesSection() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { labs, isLoading, isError } = useProviderLinkedLabs(true);
  const [selectedLabId, setSelectedLabId] = useState("");
  const [activeView, setActiveView] = useState<MessagesView>("chat");

  // Auto-select when only one lab is linked (desktop does the same).
  const effectiveLabId = selectedLabId || (labs.length === 1 ? labs[0]!.id : "");
  const effectiveLab = labs.find((l) => l.id === effectiveLabId);

  if (isError) {
    return (
      <View style={styles.rootCentered} testID="provider-portal-section-messages">
        <Text style={styles.errorText} testID="provider-messages-error">
          Could not load your labs.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="provider-portal-section-messages">
      {/* Lab picker — only when the provider is linked to more than one lab */}
      {labs.length > 1 && (
        <View style={styles.picker} testID="provider-messages-lab-picker">
          <Text style={styles.pickerLabel}>Chat with Lab</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pickerRow}
          >
            {labs.map((lab) => {
              const selected = lab.id === effectiveLabId;
              return (
                <Pressable
                  key={lab.id}
                  onPress={() => setSelectedLabId(lab.id)}
                  style={[styles.labChip, selected && styles.labChipSelected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  testID={`provider-messages-lab-option-${lab.id}`}
                >
                  <Text style={[styles.labChipLabel, selected && styles.labChipLabelSelected]}>
                    {lab.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Loading the provider's cases (which is where the labs come from) */}
      {isLoading && (
        <View style={styles.centered} testID="provider-messages-loading">
          <ActivityIndicator color={colors.tint} />
          <Text style={styles.mutedText}>Loading…</Text>
        </View>
      )}

      {/* No labs linked yet */}
      {!isLoading && labs.length === 0 && (
        <View style={styles.centered} testID="provider-messages-no-labs">
          <Ionicons name="link-outline" size={30} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No lab linked yet</Text>
          <Text style={styles.mutedText}>Contact your lab to get connected.</Text>
        </View>
      )}

      {/* Several labs, none picked */}
      {!isLoading && labs.length > 1 && !effectiveLabId && (
        <View style={styles.centered} testID="provider-messages-select-lab">
          <Text style={styles.mutedText}>Select a lab to start chatting.</Text>
        </View>
      )}

      {/* Chat / Sent */}
      {!!effectiveLabId && (
        <>
          <View style={styles.tabs}>
            {(["chat", "sent"] as const).map((view) => {
              const active = activeView === view;
              return (
                <Pressable
                  key={view}
                  onPress={() => setActiveView(view)}
                  style={[styles.tab, active && styles.tabActive]}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  testID={`provider-messages-tab-${view}`}
                >
                  <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                    {view === "chat" ? "Chat" : "Sent"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.panel}>
            {activeView === "chat" ? (
              <ProviderLabChat
                key={effectiveLabId}
                labOrganizationId={effectiveLabId}
                labName={effectiveLab?.name}
              />
            ) : (
              <ProviderLabSentNotes
                key={effectiveLabId}
                labOrganizationId={effectiveLabId}
                labName={effectiveLab?.name}
              />
            )}
          </View>
        </>
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.backgroundSolid },
    rootCentered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.backgroundSolid,
      padding: Spacing.xxl,
    },
    picker: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      gap: Spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    pickerLabel: { ...Typography.caption, color: c.textSecondary },
    pickerRow: { flexDirection: "row", gap: Spacing.sm, paddingRight: Spacing.lg },
    labChip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs + 2,
      borderRadius: Radius.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.backgroundSolid,
    },
    labChipSelected: { backgroundColor: c.tint, borderColor: c.tint },
    labChipLabel: { ...Typography.captionMedium, color: c.text },
    labChipLabelSelected: { color: c.textInverse },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      padding: Spacing.xxl,
    },
    emptyTitle: { ...Typography.bodyMedium, color: c.text, marginTop: Spacing.xs },
    mutedText: { ...Typography.caption, color: c.textSecondary, textAlign: "center" },
    errorText: { ...Typography.caption, color: c.error, textAlign: "center" },
    tabs: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    tab: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: { borderBottomColor: c.tint },
    tabLabel: { ...Typography.bodyMedium, color: c.textSecondary },
    tabLabelActive: { color: c.tint },
    panel: { flex: 1 },
  });
}
