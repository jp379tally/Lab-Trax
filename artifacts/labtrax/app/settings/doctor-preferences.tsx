import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";

type Unit = "mm" | "microns";
type Anatomy = "primary_only" | "primary_and_secondary" | "other";
type ContactMethod = "text" | "phone_call" | "email";
type DoctorPreferences = {
  occlusionAmount: number | null;
  occlusionUnit: Unit | null;
  proximalContactAmount: number | null;
  proximalContactUnit: Unit | null;
  anatomyPreference: Anatomy | null;
  anatomyOther: string | null;
  caseQuestionContactMethod: ContactMethod | null;
  caseQuestionContactValue: string | null;
};
type Form = {
  occlusionAmount: string;
  occlusionUnit: Unit | "";
  proximalContactAmount: string;
  proximalContactUnit: Unit | "";
  anatomyPreference: Anatomy | "";
  anatomyOther: string;
  caseQuestionContactMethod: ContactMethod | "";
  caseQuestionContactValue: string;
};

const EMPTY_FORM: Form = {
  occlusionAmount: "",
  occlusionUnit: "",
  proximalContactAmount: "",
  proximalContactUnit: "",
  anatomyPreference: "",
  anatomyOther: "",
  caseQuestionContactMethod: "",
  caseQuestionContactValue: "",
};

function toForm(data: DoctorPreferences): Form {
  return {
    occlusionAmount: data.occlusionAmount == null ? "" : String(data.occlusionAmount),
    occlusionUnit: data.occlusionUnit ?? "",
    proximalContactAmount: data.proximalContactAmount == null ? "" : String(data.proximalContactAmount),
    proximalContactUnit: data.proximalContactUnit ?? "",
    anatomyPreference: data.anatomyPreference ?? "",
    anatomyOther: data.anatomyOther ?? "",
    caseQuestionContactMethod: data.caseQuestionContactMethod ?? "",
    caseQuestionContactValue: data.caseQuestionContactValue ?? "",
  };
}

async function responseError(res: Response, fallback: string) {
  const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message || body?.error || fallback;
}

export default function DoctorPreferencesScreen() {
  const insets = useSafeAreaInsets();
  const { currentUserId } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const hydratedUserId = React.useRef<string | null>(null);
  const currentUserIdRef = React.useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const query = useQuery<DoctorPreferences>({
    queryKey: ["auth", currentUserId, "doctor-preferences"],
    enabled: Boolean(currentUserId),
    queryFn: async () => {
      const res = await resilientFetch("/api/users/me/doctor-preferences");
      if (!res.ok) throw new Error(await responseError(res, `Failed to load preferences (${res.status})`));
      const body = await res.json() as { data?: DoctorPreferences };
      return body.data ?? body as unknown as DoctorPreferences;
    },
    staleTime: 60_000,
  });

  React.useEffect(() => {
    if (!currentUserId) {
      hydratedUserId.current = null;
      setForm(EMPTY_FORM);
      return;
    }
    if (query.data && hydratedUserId.current !== currentUserId) {
      hydratedUserId.current = currentUserId;
      setForm(toForm(query.data));
    }
  }, [currentUserId, query.data]);

  const mutation = useMutation({
    mutationFn: async ({ draft }: { draft: Form; userId: string }) => {
      const res = await resilientFetch("/api/users/me/doctor-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          occlusionAmount: draft.occlusionAmount.trim() === "" ? null : Number(draft.occlusionAmount),
          occlusionUnit: draft.occlusionUnit || null,
          proximalContactAmount: draft.proximalContactAmount.trim() === "" ? null : Number(draft.proximalContactAmount),
          proximalContactUnit: draft.proximalContactUnit || null,
          anatomyPreference: draft.anatomyPreference || null,
          anatomyOther: draft.anatomyPreference === "other" ? draft.anatomyOther.trim() : null,
          caseQuestionContactMethod: draft.caseQuestionContactMethod || null,
          caseQuestionContactValue: draft.caseQuestionContactMethod ? draft.caseQuestionContactValue.trim() : null,
        }),
      });
      if (!res.ok) throw new Error(await responseError(res, `Failed to save preferences (${res.status})`));
      const body = await res.json() as { data?: DoctorPreferences };
      return body.data ?? body as unknown as DoctorPreferences;
    },
    onSuccess: (data, variables) => {
      if (currentUserIdRef.current !== variables.userId) return;
      qc.setQueryData(["auth", variables.userId, "doctor-preferences"], data);
      setForm(toForm(data));
    },
  });

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  }

  function validate() {
    const next: Record<string, string> = {};
    for (const [key, value] of [["occlusionAmount", form.occlusionAmount], ["proximalContactAmount", form.proximalContactAmount]] as const) {
      if (value.trim() && (!Number.isFinite(Number(value)) || Number(value) < 0)) next[key] = "Enter a number of 0 or greater.";
    }
    if (form.anatomyPreference === "other") {
      if (!form.anatomyOther.trim()) next.anatomyOther = "Describe the other anatomy preference.";
      else if (form.anatomyOther.length > 100) next.anatomyOther = "Use 100 characters or fewer.";
    }
    if (form.caseQuestionContactMethod === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.caseQuestionContactValue.trim())) next.caseQuestionContactValue = "Enter a valid email address.";
    } else if (form.caseQuestionContactMethod === "text" || form.caseQuestionContactMethod === "phone_call") {
      const digits = form.caseQuestionContactValue.replace(/\D/g, "");
      if (!/^\+?[0-9\s().-]+$/.test(form.caseQuestionContactValue.trim()) || digits.length < 7 || digits.length > 15) next.caseQuestionContactValue = "Enter a valid phone number.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function save() {
    if (validate() && currentUserId) {
      mutation.mutate({ draft: form, userId: currentUserId });
    }
  }

  return (
    <ScreenShell title="Doctor Preferences" subtitle="Account-wide fabrication and case-question preferences" onBack={() => router.back()} insetTop={insets.top}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && <View style={[styles.banner, { backgroundColor: colors.error + "10", borderColor: colors.error + "30" }]}><Ionicons name="warning-outline" size={16} color={colors.error} /><Text style={[styles.bannerText, { color: colors.error }]}>Could not load doctor preferences.</Text></View>}
        {mutation.error && <View style={[styles.banner, { backgroundColor: colors.error + "10", borderColor: colors.error + "30" }]}><Ionicons name="warning-outline" size={16} color={colors.error} /><Text style={[styles.bannerText, { color: colors.error }]}>Could not save preferences. Your entries are still here.</Text></View>}
        {mutation.isSuccess && <View style={[styles.banner, { backgroundColor: colors.success + "12", borderColor: colors.success + "35" }]}><Ionicons name="checkmark-circle-outline" size={16} color={colors.success} /><Text style={[styles.bannerText, { color: colors.success }]}>Doctor preferences saved.</Text></View>}
        {query.data && (
          <>
            <SettingsSection title="Fabrication">
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Occlusion amount</Text>
                <View style={styles.inline}>
                  <TextInput accessibilityLabel="Occlusion amount" value={form.occlusionAmount} onChangeText={(value) => update("occlusionAmount", value)} keyboardType="decimal-pad" placeholder="Optional" placeholderTextColor={colors.textTertiary} style={[styles.input, { color: colors.text, borderColor: errors.occlusionAmount ? colors.error : colors.border }]} />
                  <Choice label="occlusion unit" value={form.occlusionUnit} onChange={(value) => update("occlusionUnit", value as Unit | "")} options={[["mm", "Millimeters"], ["microns", "Microns"]]} colors={colors} />
                </View>
                {errors.occlusionAmount && <Text style={[styles.errorText, { color: colors.error }]}>{errors.occlusionAmount}</Text>}
              </View>
              <View style={[styles.field, styles.topBorder, { borderTopColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Proximal-contact amount</Text>
                <View style={styles.inline}>
                  <TextInput accessibilityLabel="Proximal-contact amount" value={form.proximalContactAmount} onChangeText={(value) => update("proximalContactAmount", value)} keyboardType="decimal-pad" placeholder="Optional" placeholderTextColor={colors.textTertiary} style={[styles.input, { color: colors.text, borderColor: errors.proximalContactAmount ? colors.error : colors.border }]} />
                  <Choice label="proximal-contact unit" value={form.proximalContactUnit} onChange={(value) => update("proximalContactUnit", value as Unit | "")} options={[["mm", "Millimeters"], ["microns", "Microns"]]} colors={colors} />
                </View>
                {errors.proximalContactAmount && <Text style={[styles.errorText, { color: colors.error }]}>{errors.proximalContactAmount}</Text>}
              </View>
            </SettingsSection>
            <SettingsSection title="Anatomy">
              <Choice label="anatomy preference" value={form.anatomyPreference} onChange={(value) => update("anatomyPreference", value as Anatomy | "")} options={[["primary_only", "Primary anatomy only"], ["primary_and_secondary", "Primary and secondary anatomy"], ["other", "Other"]]} colors={colors} />
              {form.anatomyPreference === "other" && <View style={styles.field}><TextInput accessibilityLabel="Other anatomy preference" value={form.anatomyOther} maxLength={100} onChangeText={(value) => update("anatomyOther", value)} placeholder="Describe the anatomy preference" placeholderTextColor={colors.textTertiary} style={[styles.inputFull, { color: colors.text, borderColor: errors.anatomyOther ? colors.error : colors.border }]} /><Text style={[styles.counter, { color: colors.textTertiary }]}>{form.anatomyOther.length}/100</Text>{errors.anatomyOther && <Text style={[styles.errorText, { color: colors.error }]}>{errors.anatomyOther}</Text>}</View>}
            </SettingsSection>
            <SettingsSection title="Case questions">
              <Choice label="case-question contact method" value={form.caseQuestionContactMethod} onChange={(value) => update("caseQuestionContactMethod", value as ContactMethod | "")} options={[["text", "Text"], ["phone_call", "Phone call"], ["email", "Email"]]} colors={colors} />
              {form.caseQuestionContactMethod && <View style={styles.field}><TextInput accessibilityLabel="Case-question contact value" value={form.caseQuestionContactValue} onChangeText={(value) => update("caseQuestionContactValue", value)} keyboardType={form.caseQuestionContactMethod === "email" ? "email-address" : "phone-pad"} autoCapitalize="none" placeholder={form.caseQuestionContactMethod === "email" ? "you@example.com" : "(555) 555-5555"} placeholderTextColor={colors.textTertiary} style={[styles.inputFull, { color: colors.text, borderColor: errors.caseQuestionContactValue ? colors.error : colors.border }]} />{errors.caseQuestionContactValue && <Text style={[styles.errorText, { color: colors.error }]}>{errors.caseQuestionContactValue}</Text>}</View>}
            </SettingsSection>
            <Pressable accessibilityRole="button" onPress={save} disabled={mutation.isPending} style={[styles.saveButton, { backgroundColor: colors.tint }, mutation.isPending && { opacity: 0.5 }]}><Text style={styles.saveText}>{mutation.isPending ? "Saving…" : "Save Doctor Preferences"}</Text></Pressable>
          </>
        )}
      </KeyboardAwareScrollView>
    </ScreenShell>
  );
}

function Choice({ label, value, onChange, options, colors }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]>; colors: ThemeColors }) {
  return (
    <View style={choiceStyles.wrap}>
      <Pressable accessibilityRole="radio" accessibilityLabel={`Clear ${label}`} accessibilityState={{ selected: value === "" }} onPress={() => onChange("")} style={[choiceStyles.option, { borderColor: value === "" ? colors.tint : colors.border, backgroundColor: value === "" ? colors.tint + "12" : colors.surface }]}><Text style={{ color: value === "" ? colors.tint : colors.textSecondary, ...Typography.captionSemibold }}>Not set</Text></Pressable>
      {options.map(([optionValue, label]) => (
        <Pressable key={optionValue} accessibilityRole="radio" accessibilityState={{ selected: value === optionValue }} onPress={() => onChange(optionValue)} style={[choiceStyles.option, { borderColor: value === optionValue ? colors.tint : colors.border, backgroundColor: value === optionValue ? colors.tint + "12" : colors.surface }]}><Text style={{ color: value === optionValue ? colors.tint : colors.textSecondary, ...Typography.captionSemibold }}>{label}</Text></Pressable>
      ))}
    </View>
  );
}

const choiceStyles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  option: { borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
});

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    banner: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, padding: Spacing.md, borderRadius: Radius.md, borderWidth: 1 },
    bannerText: { ...Typography.caption, flex: 1 },
    field: { padding: Spacing.lg, gap: Spacing.xs },
    topBorder: { borderTopWidth: StyleSheet.hairlineWidth },
    label: { ...Typography.captionSemibold },
    inline: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    input: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, ...Typography.body },
    inputFull: { minHeight: 44, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, ...Typography.body },
    errorText: { ...Typography.caption },
    counter: { ...Typography.caption, textAlign: "right" },
    saveButton: { borderRadius: Radius.md, padding: Spacing.md, alignItems: "center" },
    saveText: { ...Typography.bodySemibold, color: "#fff" },
  });
}