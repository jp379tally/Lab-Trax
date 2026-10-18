import React, { useMemo, useState } from "react";
import { ActivityIndicator, Keyboard, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { getLabProviderAuthorizationHistory, downloadAndShareProviderAuthorization, prepareLabAuthorizationRequest, cancelLabAuthorizationRequest, listProviderAuthorizationRequests, providerAutopayDesktopHandoffUrl, type AutopayAuthorization } from "@/lib/provider-autopay-authorization";

export default function ProviderAuthorizationsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const fallbackLabId = primaryLabOrgId(useMe().data);
  const { providerOrganizationId, labOrganizationId: routeLabId } = useLocalSearchParams<{ providerOrganizationId?: string; labOrganizationId?: string }>();
  const labOrganizationId = routeLabId || fallbackLabId;
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["lab-provider-authorizations-history", labOrganizationId, providerOrganizationId], enabled: !!labOrganizationId && !!providerOrganizationId, queryFn: () => getLabProviderAuthorizationHistory(labOrganizationId!, providerOrganizationId!) });
  const [busy, setBusy] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [requests, setRequests] = useState<Array<{ id: string; status: string }>>([]);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestsQuery = useQuery({ queryKey: ["provider-authorization-requests", labOrganizationId, providerOrganizationId], enabled: !!labOrganizationId && !!providerOrganizationId, queryFn: () => listProviderAuthorizationRequests(labOrganizationId!, providerOrganizationId!) });
  React.useEffect(() => { if (requestsQuery.data) setRequests(requestsQuery.data); }, [requestsQuery.data]);
  async function request(providerOrganizationId: string) {
    if (!labOrganizationId || !providerOrganizationId) return;
    setBusy(providerOrganizationId);
    try {
      if (recipientEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail.trim())) throw new Error("Enter a valid recipient email.");
      const created = await prepareLabAuthorizationRequest({ labOrganizationId, providerOrganizationId, subscriptionFees: true, labBills: true, labOrganizationIds: [labOrganizationId], labChargeDay: 10, ...(recipientEmail.trim() ? { recipientEmail: recipientEmail.trim(), deliveryMode: "email" as const } : { presentInPerson: true, deliveryMode: "in_person" as const }) });
      if (!recipientEmail.trim()) {
        if (!created.id || !created.requestToken) throw new Error("The in-person request did not return a secure provider handoff token.");
        setHandoffUrl(providerAutopayDesktopHandoffUrl(created.id, created.requestToken));
      }
      setRequests((items) => [...items, created]);
      await qc.invalidateQueries({ queryKey: ["lab-provider-authorizations-history", labOrganizationId, providerOrganizationId] });
      await qc.invalidateQueries({ queryKey: ["provider-authorization-requests", labOrganizationId, providerOrganizationId] });
    } catch (error) { setActionError(error instanceof Error ? error.message : "Could not create request."); } finally { setBusy(null); }
  }
  async function download(id: string) {
    await downloadAndShareProviderAuthorization(id, labOrganizationId!);
  }
  return (
    <ScreenShell title="Provider authorizations" subtitle="Manage provider auto-pay requests" onBack={() => router.back()} insetTop={useSafeAreaInsets().top}>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
      >
        <DismissKeyboardView testID="provider-authorizations-keyboard-dismiss" style={styles.dismissLayer}>
        {!labOrganizationId || !providerOrganizationId ? <Card><Text style={styles.error}>Missing lab or provider context. Open this screen from a customer entry.</Text></Card> : null}
        {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
        <Text style={styles.explanation}>Review provider-level authorization status and send requests. Lab members cannot sign or capture a provider signature.</Text>
        {providerOrganizationId ? <TextInput value={recipientEmail} onChangeText={setRecipientEmail} placeholder="Recipient email (optional for in-person)" placeholderTextColor={colors.textTertiary} style={styles.input} keyboardType="email-address" autoCapitalize="none" returnKeyType="done" onSubmitEditing={() => Keyboard.dismiss()} /> : null}
        {providerOrganizationId ? <View style={styles.actions}><Pressable onPress={() => void request(providerOrganizationId)} style={styles.button}><Text style={styles.buttonText}>{recipientEmail.trim() ? "Send email request" : "Prepare in-person request"}</Text></Pressable></View> : null}
        {handoffUrl ? <Card><Text style={styles.explanation}>Provider handoff link (provider must sign):</Text><Text selectable style={styles.explanation}>{handoffUrl}</Text><View style={styles.actions}><Pressable onPress={() => void Linking.openURL(handoffUrl)} style={styles.button}><Text style={styles.buttonText}>Open</Text></Pressable><Pressable onPress={() => void Clipboard.setStringAsync(handoffUrl)} style={styles.button}><Text style={styles.buttonText}>Copy</Text></Pressable><Pressable onPress={() => void Share.share({ message: handoffUrl })} style={styles.button}><Text style={styles.buttonText}>Share</Text></Pressable></View></Card> : null}
        {requests.map((item) => <View key={item.id} style={styles.requestRow}><Text style={styles.explanation}>Request: {requestStatus(item.status)}</Text>{["prepared", "sent"].includes(item.status) ? <Pressable onPress={() => void cancelLabAuthorizationRequest(item.id).then((updated) => { setRequests((items) => items.map((current) => current.id === item.id ? updated : current)); void requestsQuery.refetch(); })}><Text style={styles.buttonText}>Cancel</Text></Pressable> : null}</View>)}
        {(history.data ?? []).length === 0 ? <Card><Text style={styles.muted}>No provider authorization history yet.</Text>{providerOrganizationId ? <Pressable onPress={() => void request(providerOrganizationId)} style={styles.button}><Text style={styles.buttonText}>Prepare and send request</Text></Pressable> : null}</Card> : (history.data ?? []).map((entry) => (
          <AuthorizationRow key={entry.id} entry={entry} colors={colors} styles={styles} busy={busy === entry.providerOrganizationId} onRequest={() => void request(entry.providerOrganizationId!)} onDownload={() => void download(entry.id)} />
        ))}
        <Text style={styles.heading}>History</Text>
        </DismissKeyboardView>
      </ScrollView>
    </ScreenShell>
  );
}

function AuthorizationRow({ entry, colors, styles, busy, onRequest, onDownload }: { entry: AutopayAuthorization; colors: ThemeColors; styles: ReturnType<typeof makeStyles>; busy?: boolean; onRequest?: () => void; onDownload: () => void }) {
  return <Card style={styles.card}><View style={styles.row}><View style={styles.copy}><Text style={styles.title}>{entry.card?.brand || "Provider"} •••• {entry.card?.last4 || "••••"}</Text><Text style={styles.explanation}>{entry.subscriptionFees ? "Subscription" : ""}{entry.labBills ? "Lab bills" : ""} · {safeStatus(entry.status)}</Text></View><Text style={styles.status}>{safeStatus(entry.status)}</Text></View><View style={styles.actions}>{onRequest ? <Pressable onPress={onRequest} disabled={busy} style={[styles.button, { borderColor: colors.tint }]}>{busy ? <ActivityIndicator size="small" color={colors.tint} /> : <Text style={[styles.buttonText, { color: colors.tint }]}>Prepare & send request</Text>}</Pressable> : null}<Pressable onPress={onDownload} style={[styles.button, { borderColor: colors.border }]}><Ionicons name="download-outline" size={15} color={colors.tint} /><Text style={[styles.buttonText, { color: colors.tint }]}>Download PDF</Text></Pressable></View></Card>;
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, paddingBottom: Spacing.xxxl },
    dismissLayer: { gap: Spacing.md },
    explanation: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    muted: { ...Typography.body, color: c.textSecondary },
    heading: { ...Typography.label, color: c.textTertiary, textTransform: "uppercase" as const, marginTop: Spacing.md },
    card: { gap: Spacing.md },
    row: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
    copy: { flex: 1, gap: 3 },
    title: { ...Typography.bodySemibold, color: c.text },
    status: { ...Typography.captionSemibold, color: c.tint },
    actions: { flexDirection: "row", gap: Spacing.sm, flexWrap: "wrap" },
    button: { minHeight: 38, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Spacing.sm, flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    buttonText: { ...Typography.captionSemibold },
    error: { ...Typography.body, color: c.error },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, padding: Spacing.md, color: c.text },
    requestRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: Spacing.sm },
  });
}
function safeStatus(status: string): string {
  return ["active", "superseded", "revoked"].includes(status) ? status : "unknown";
}
function requestStatus(status: string): string {
  return ["prepared", "sent", "completed", "expired", "cancelled"].includes(status) ? status : "unknown";
}