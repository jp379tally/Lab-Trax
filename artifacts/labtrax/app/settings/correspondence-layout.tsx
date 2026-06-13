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

interface CorrespondenceTemplate {
  showLogo: boolean;
  showAddress: boolean;
  showContactInfo: boolean;
  salutation: string | null;
  closingText: string | null;
  signatureText: string | null;
  headerText: string | null;
  footerText: string | null;
}

interface TemplateResponse {
  ok?: boolean;
  template?: CorrespondenceTemplate;
}

const DEFAULTS: CorrespondenceTemplate = {
  showLogo: true,
  showAddress: true,
  showContactInfo: true,
  salutation: null,
  closingText: null,
  signatureText: null,
  headerText: null,
  footerText: null,
};

const TOGGLES: Array<{ key: keyof CorrespondenceTemplate; label: string; desc: string }> = [
  { key: "showLogo",        label: "Show logo",         desc: "Display lab logo on letters and email headers" },
  { key: "showAddress",     label: "Show address",      desc: "Include lab address on all correspondence" },
  { key: "showContactInfo", label: "Show contact info", desc: "Include phone, email, and web contact details" },
];

const TEXT_FIELDS: Array<{ key: keyof CorrespondenceTemplate; label: string; placeholder: string; multiline?: boolean }> = [
  { key: "salutation",    label: "Salutation",    placeholder: "e.g. Dear Doctor",             multiline: false },
  { key: "closingText",   label: "Closing",       placeholder: "e.g. Sincerely",               multiline: false },
  { key: "signatureText", label: "Signature",     placeholder: "e.g. LabTrax Dental Laboratory", multiline: false },
  { key: "headerText",    label: "Header text",   placeholder: "e.g. Lab Correspondence",       multiline: false },
  { key: "footerText",    label: "Footer text",   placeholder: "e.g. Confidential",             multiline: false },
];

export default function CorrespondenceLayoutScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const query = useQuery<CorrespondenceTemplate>({
    queryKey: ["admin", "templates", "correspondence"],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/templates/correspondence");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = (await res.json()) as TemplateResponse;
      return { ...DEFAULTS, ...(body.template ?? {}) };
    },
    staleTime: 60_000,
  });

  const [draft, setDraft] = useState<CorrespondenceTemplate | null>(null);

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: async (patch: Partial<CorrespondenceTemplate>) => {
      const res = await resilientFetch("/api/admin/templates/correspondence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      return (body.template ?? patch) as CorrespondenceTemplate;
    },
    onSuccess: (updated) => {
      const merged = { ...DEFAULTS, ...updated };
      setDraft(merged);
      qc.setQueryData<CorrespondenceTemplate>(["admin", "templates", "correspondence"], merged);
    },
    onError: (err: Error) => Alert.alert("Save failed", err.message),
  });

  function toggleBool(key: keyof CorrespondenceTemplate) {
    if (!draft) return;
    const updated = { ...draft, [key]: !draft[key] };
    setDraft(updated);
    mutation.mutate({ [key]: !draft[key] });
  }

  function setTextField(key: keyof CorrespondenceTemplate, value: string) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value || null });
  }

  function saveTextFields() {
    if (!draft) return;
    const patch: Partial<CorrespondenceTemplate> = {};
    TEXT_FIELDS.forEach(({ key }) => { patch[key] = draft[key] as any; });
    mutation.mutate(patch);
  }

  return (
    <ScreenShell
      title="Correspondence Layout"
      subtitle="Letter and email templates"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not load correspondence template.
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
            <SettingsSection title="Letterhead options">
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

            <SettingsSection title="Text defaults">
              {TEXT_FIELDS.map((f) => (
                <View key={f.key as string} style={styles.textFieldBlock}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{f.label}</Text>
                  <TextInput
                    style={[
                      styles.textInput,
                      { color: colors.text, backgroundColor: colors.surfaceAlt, borderColor: colors.border },
                    ]}
                    value={(draft[f.key] as string | null) ?? ""}
                    onChangeText={(v) => setTextField(f.key, v)}
                    placeholder={f.placeholder}
                    placeholderTextColor={colors.textSecondary}
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
  });
}
