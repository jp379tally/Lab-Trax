import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Switch,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";

interface InvoiceTemplate {
  showLogo: boolean;
  showHeader: boolean;
  showDueDate: boolean;
  showCaseNumbers: boolean;
  showRestorationDetails: boolean;
  headerText: string | null;
  footerText: string | null;
  termsText: string | null;
  notesText: string | null;
}

interface TemplateResponse {
  ok?: boolean;
  template?: InvoiceTemplate;
  orgId?: string;
}

const DEFAULTS: InvoiceTemplate = {
  showLogo: true,
  showHeader: true,
  showDueDate: true,
  showCaseNumbers: true,
  showRestorationDetails: true,
  headerText: null,
  footerText: null,
  termsText: null,
  notesText: null,
};

const TOGGLES: Array<{ key: keyof InvoiceTemplate; label: string; desc: string }> = [
  { key: "showLogo",               label: "Show logo",                desc: "Display lab logo in the invoice header" },
  { key: "showHeader",             label: "Show header text",         desc: "Display custom header text above the invoice" },
  { key: "showDueDate",            label: "Show due date",            desc: "Display the payment due date on each invoice" },
  { key: "showCaseNumbers",        label: "Show case numbers",        desc: "Include case reference numbers on line items" },
  { key: "showRestorationDetails", label: "Show restoration details", desc: "Expand restoration type and description per item" },
];

const TEXT_FIELDS: Array<{ key: keyof InvoiceTemplate; label: string; placeholder: string; multiline?: boolean }> = [
  { key: "headerText", label: "Header text",  placeholder: "e.g. Thank you for your business",  multiline: false },
  { key: "footerText", label: "Footer text",  placeholder: "e.g. Questions? Call (555) 000-0000", multiline: false },
  { key: "termsText",  label: "Terms",        placeholder: "e.g. Net 30 · Late fees apply",       multiline: true },
  { key: "notesText",  label: "Default notes", placeholder: "e.g. Please remit to…",              multiline: true },
];

export default function InvoiceLayoutScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const query = useQuery<InvoiceTemplate>({
    queryKey: ["admin", "templates", "invoice"],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/templates/invoice");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as TemplateResponse;
      return { ...DEFAULTS, ...(body.template ?? {}) };
    },
    staleTime: 60_000,
  });

  const [draft, setDraft] = useState<InvoiceTemplate | null>(null);

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: async (patch: Partial<InvoiceTemplate>) => {
      const res = await resilientFetch("/api/admin/templates/invoice", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return (body.template ?? patch) as InvoiceTemplate;
    },
    onSuccess: (updated) => {
      setDraft({ ...DEFAULTS, ...updated });
      qc.setQueryData<InvoiceTemplate>(["admin", "templates", "invoice"], { ...DEFAULTS, ...updated });
    },
    onError: (err: Error) => Alert.alert("Save failed", err.message),
  });

  function toggleBool(key: keyof InvoiceTemplate) {
    if (!draft) return;
    const updated = { ...draft, [key]: !draft[key] };
    setDraft(updated);
    mutation.mutate({ [key]: !draft[key] });
  }

  function setTextField(key: keyof InvoiceTemplate, value: string) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value || null });
  }

  function saveTextFields() {
    if (!draft) return;
    const patch: Partial<InvoiceTemplate> = {};
    TEXT_FIELDS.forEach(({ key }) => { patch[key] = draft[key] as any; });
    mutation.mutate(patch);
  }

  return (
    <ScreenShell
      title="Invoice Layout"
      subtitle="PDF invoice appearance"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not load invoice template.
          </Text>
        )}

        {mutation.error && (
          <View style={[styles.warnCard, { backgroundColor: colors.error + "10", borderColor: colors.error + "30" }]}>
            <Ionicons name="warning-outline" size={14} color={colors.error} />
            <Text style={[styles.warnText, { color: colors.error }]}>
              Save failed — {(mutation.error as Error).message}
            </Text>
          </View>
        )}

        {draft && (
          <>
            <SettingsSection title="Display options">
              {TOGGLES.map((t, idx) => (
                <View
                  key={t.key as string}
                  style={[
                    styles.toggleRow,
                    idx > 0 && styles.sep,
                    idx > 0 && { borderTopColor: colors.border },
                  ]}
                >
                  <View style={styles.rowInfo}>
                    <Text style={[styles.rowTitle, { color: colors.text }]}>{t.label}</Text>
                    <Text style={[styles.rowDesc, { color: colors.textSecondary }]}>{t.desc}</Text>
                  </View>
                  <Switch
                    value={draft[t.key] as boolean}
                    onValueChange={() => toggleBool(t.key)}
                    trackColor={{ false: colors.border, true: colors.tint }}
                    thumbColor="#fff"
                    disabled={mutation.isPending}
                  />
                </View>
              ))}
            </SettingsSection>

            <SettingsSection title="Custom text">
              {TEXT_FIELDS.map((f) => (
                <View key={f.key as string} style={styles.textFieldBlock}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{f.label}</Text>
                  <TextInput
                    style={[
                      styles.textInput,
                      f.multiline && styles.textInputMulti,
                      { color: colors.text, backgroundColor: colors.surfaceAlt, borderColor: colors.border },
                    ]}
                    value={(draft[f.key] as string | null) ?? ""}
                    onChangeText={(v) => setTextField(f.key, v)}
                    placeholder={f.placeholder}
                    placeholderTextColor={colors.textSecondary}
                    multiline={f.multiline}
                    numberOfLines={f.multiline ? 3 : 1}
                    autoCapitalize="sentences"
                    onBlur={saveTextFields}
                  />
                </View>
              ))}
              <Pressable
                style={[styles.saveBtn, { backgroundColor: colors.tint, opacity: mutation.isPending ? 0.6 : 1 }]}
                onPress={saveTextFields}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="checkmark-outline" size={16} color="#fff" />
                    <Text style={styles.saveBtnText}>Save text</Text>
                  </>
                )}
              </Pressable>
            </SettingsSection>

            <SettingsSection title="Visual canvas editor">
              <View style={styles.infoRow}>
                <View style={[styles.infoIcon, { backgroundColor: colors.surfaceAlt }]}>
                  <Ionicons name="desktop-outline" size={18} color={colors.textSecondary} />
                </View>
                <View style={styles.infoText}>
                  <Text style={[styles.infoTitle, { color: colors.text }]}>
                    Full editor in LabTrax Desktop
                  </Text>
                  <Text style={[styles.infoDesc, { color: colors.textSecondary }]}>
                    For drag-and-drop logo placement, section box positioning, and additional branding images, open the full visual canvas editor in Desktop App settings.
                  </Text>
                </View>
              </View>
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    errorText: { ...Typography.body, textAlign: "center" },
    warnCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
    },
    warnText: { ...Typography.caption, flex: 1 },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    sep: { borderTopWidth: StyleSheet.hairlineWidth },
    rowInfo: { flex: 1, gap: 2 },
    rowTitle: { ...Typography.bodyMedium },
    rowDesc: { ...Typography.caption },
    textFieldBlock: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, gap: 6 },
    fieldLabel: { ...Typography.captionMedium },
    textInput: {
      ...Typography.body,
      borderWidth: 1,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    textInputMulti: { minHeight: 72, textAlignVertical: "top" },
    saveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      margin: Spacing.lg,
      marginTop: Spacing.md,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    saveBtnText: { ...Typography.bodyMedium, color: "#fff" },
    infoRow: {
      flexDirection: "row",
      gap: Spacing.md,
      padding: Spacing.lg,
      alignItems: "flex-start",
    },
    infoIcon: {
      width: 36,
      height: 36,
      borderRadius: Radius.sm,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    infoText: { flex: 1, gap: 4 },
    infoTitle: { ...Typography.bodyMedium },
    infoDesc: { ...Typography.caption },
  });
}
