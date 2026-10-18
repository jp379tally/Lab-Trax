import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { adminLabMemberships, primaryAdminLabOrgId, useMe } from "@/lib/auth-me";
import { resilientFetch } from "@/lib/query-client";
import { Radius, Spacing, Typography } from "@/constants/tokens";

interface Template {
  emailSubject: string;
  emailBody: string;
  placeholders: string[];
}
const DEFAULTS: Template = {
  emailSubject: "Payment receipt from {{labName}} — {{receiptNumber}}",
  emailBody: "Thank you for your payment of {{amountReceived}}. Receipt {{receiptNumber}} is attached.",
  placeholders: ["{{receiptNumber}}", "{{labName}}", "{{customerName}}", "{{paymentDate}}", "{{amountReceived}}", "{{amountApplied}}", "{{customerCredit}}", "{{openBalance}}", "{{paymentMethod}}", "{{referenceNumber}}", "{{referenceLine}}"],
};

export default function PaymentReceiptScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const me = useMe().data;
  const labId = primaryAdminLabOrgId(me);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Template | null>(null);

  const query = useQuery<Template>({
    queryKey: ["admin", "templates", "payment-receipt", labId ?? ""],
    enabled: !!labId,
    queryFn: async () => {
      const response = await resilientFetch(`/api/billing/${encodeURIComponent(labId!)}/payment-receipt-template`);
      if (!response.ok) throw new Error(`Could not load template (${response.status})`);
      return { ...DEFAULTS, ...(await response.json()).data };
    },
    staleTime: 60_000,
  });
  useEffect(() => { if (query.data && !draft) setDraft(query.data); }, [query.data, draft]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft || !draft.emailSubject.trim() || !draft.emailBody.trim()) throw new Error("Subject and message are required.");
      if (draft.emailSubject.length > 998) throw new Error("Subject is too long.");
      if (draft.emailBody.length > 20_000) throw new Error("Message is too long.");
      const response = await resilientFetch(`/api/billing/${encodeURIComponent(labId!)}/payment-receipt-template`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emailSubject: draft.emailSubject, emailBody: draft.emailBody }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || body?.message || `Could not save template (${response.status})`);
      return { ...DEFAULTS, ...(body.data ?? body) };
    },
    onSuccess: (updated) => { setDraft(updated); void qc.invalidateQueries({ queryKey: ["admin", "templates", "payment-receipt", labId ?? ""] }); },
  });

  if (!labId || !adminLabMemberships(me).length) {
    return <ScreenShell title="Payment Receipt" subtitle="Email template" onBack={() => router.back()} insetTop={insets.top}><View style={styles.empty}><Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} /><Text style={styles.emptyTitle}>Not available</Text><Text style={styles.emptyBody}>Only lab owners and admins can edit the shared Payment Receipt template.</Text></View></ScreenShell>;
  }
  return <ScreenShell title="Payment Receipt" subtitle="Shared receipt email template" onBack={() => router.back()} insetTop={insets.top}><ScrollView contentContainerStyle={styles.body} keyboardDismissMode={scrollKeyboardDismissMode} keyboardShouldPersistTaps="handled">
    {query.isLoading && <ActivityIndicator color={colors.tint} />}
    {query.error && <View style={styles.error}><Text style={styles.errorText}>Could not load the Payment Receipt template.</Text><Pressable onPress={() => void query.refetch()}><Text style={styles.secondaryText}>Try again</Text></Pressable></View>}
    {draft && <><SettingsSection title="Email content" footer="These defaults are used when a receipt is emailed. Individual receipt emails can still be edited before sending.">
      <Text style={styles.label}>Subject</Text>
      <TextInput testID="payment-receipt-subject" value={draft.emailSubject} onChangeText={(value) => setDraft({ ...draft, emailSubject: value })} placeholder="Payment receipt from {{labName}}" placeholderTextColor={colors.textTertiary} style={styles.input} />
      <Text style={styles.label}>Message</Text>
       <TextInput testID="payment-receipt-body" value={draft.emailBody} onChangeText={(value) => setDraft({ ...draft, emailBody: value })} multiline numberOfLines={7} autoCorrect={true} spellCheck={true} autoCapitalize="sentences" placeholder="Your payment receipt is attached." placeholderTextColor={colors.textTertiary} style={[styles.input, styles.multiline]} />
      <Pressable testID="payment-receipt-save" style={[styles.primary, save.isPending && styles.disabled]} disabled={save.isPending} onPress={() => save.mutate()}>{save.isPending ? <ActivityIndicator color={colors.textInverse} /> : <Ionicons name="checkmark-outline" size={17} color={colors.textInverse} />}<Text style={styles.primaryText}>{save.isPending ? "Saving…" : "Save template"}</Text></Pressable>
      {save.error && <Text style={styles.errorText}>{(save.error as Error).message}</Text>}
    </SettingsSection>
    <SettingsSection title="Supported placeholders" footer="Placeholders are replaced with the actual payment details when the receipt is sent.">
      <View style={styles.placeholderWrap}>{(draft.placeholders.length ? draft.placeholders : DEFAULTS.placeholders).map((placeholder) => <Text key={placeholder} style={styles.placeholder}>{placeholder}</Text>)}</View>
    </SettingsSection></>}
  </ScrollView></ScreenShell>;
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl }, label: { ...Typography.captionSemibold, color: c.textSecondary }, input: { minHeight: 46, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, color: c.text, paddingHorizontal: Spacing.md, ...Typography.body, marginTop: Spacing.xs }, multiline: { minHeight: 140, paddingTop: Spacing.md, textAlignVertical: "top" }, primary: { minHeight: 48, borderRadius: Radius.full, backgroundColor: c.tint, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.md }, primaryText: { ...Typography.bodySemibold, color: c.textInverse }, disabled: { opacity: 0.55 }, placeholderWrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm }, placeholder: { ...Typography.captionSemibold, color: c.tint, backgroundColor: c.tintLight, borderRadius: Radius.sm, paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs }, error: { gap: Spacing.sm, backgroundColor: c.errorSurface, borderRadius: Radius.sm, padding: Spacing.md }, errorText: { ...Typography.caption, color: c.error }, secondaryText: { ...Typography.captionSemibold, color: c.tint }, empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.sm, padding: Spacing.xxxl }, emptyTitle: { ...Typography.h2, color: c.text }, emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center", maxWidth: 320 },
  });
}