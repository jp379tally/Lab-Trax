// Account → Provider Billing.
//
// Billing itself is not implemented here. A provider can reach billing two
// ways — the provider portal's own Billing section and this settings route —
// and two implementations of the same balances, auto-pay and payment flow
// drifted apart. So this screen renders the shared
// `ProviderBillingSection` (statements, balances, open cases, per-lab invoice
// auto-pay, payment history, Pay My Bill, and the Stripe return) and keeps
// only the panels that exist nowhere else on mobile:
//
//   • the shared payment card and its hosted setup,
//   • the signed auto-pay authorization,
//   • subscription auto-pay.
//
// Those matter because a lab-app user who also holds a provider membership
// never sees the provider portal, and this is their only way in.
//
// The Stripe payment return is handed to the section rather than reconciled
// here, so one return is never confirmed (or cancelled) twice.
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { Card } from "@/components/ui/Card";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import {
  createProviderCardSetup,
  getProviderBilling,
  PROVIDER_BILLING_QUERY_KEY,
  ProviderBillingError,
  type AutoPayPreference,
} from "@/lib/provider-billing";
import { ProviderAutoPayAuthorization } from "@/components/autopay/ProviderAutoPayAuthorization";
import { ProviderBillingSection } from "@/components/provider-portal/sections/ProviderBillingSection";
import type { ProviderCheckoutReturnSignal } from "@/lib/provider-checkout-return";

const DAYS = Array.from({ length: 10 }, (_, index) => index + 1);

function normalizePreference(value: AutoPayPreference | null | undefined): AutoPayPreference {
  return {
    enabled: value?.enabled === true,
    chargeDay: value?.chargeDay ?? null,
    authorization: value?.authorization,
  };
}

function errorText(error: unknown): string {
  if (error instanceof ProviderBillingError) return error.message;
  return "Something went wrong. Please try again.";
}

export default function ProviderBillingScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const {
    checkoutId: checkoutParam,
    providerCardSetupSession,
  } = useLocalSearchParams<{
    checkoutId?: string;
    providerCardSetupSession?: string;
  }>();
  const [setupLoading, setSetupLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedProviderOrganizationId, setSelectedProviderOrganizationId] =
    useState<string | null>(null);

  // The same query key the billing section uses, so the card shown here and
  // the auto-pay rows below it are always the one server answer.
  const billingQuery = useQuery({
    queryKey: PROVIDER_BILLING_QUERY_KEY,
    queryFn: getProviderBilling,
    staleTime: 30_000,
  });
  const billing = billingQuery.data;
  const billingCapabilityAvailable =
    !!billing?.capabilities.autoPayScheduling && !billingQuery.isError;

  useEffect(() => {
    if (
      billing?.labs.length &&
      !billing.labs.some(
        (lab) => lab.providerOrganizationId === selectedProviderOrganizationId,
      )
    ) {
      setSelectedProviderOrganizationId(billing.labs[0].providerOrganizationId);
    }
  }, [billing, selectedProviderOrganizationId]);
  const selectedLab =
    billing?.labs.find(
      (lab) => lab.providerOrganizationId === selectedProviderOrganizationId,
    ) ?? billing?.labs[0];

  // A checkout returned to this route is handed to the section, which owns
  // reconciliation for both entry points. The link never carries the outcome:
  // whether the provider cancelled was recorded durably before routing here.
  const checkoutReturn = useMemo<ProviderCheckoutReturnSignal | null>(
    () =>
      checkoutParam
        ? {
            checkoutId: checkoutParam,
            cardSetupSession: null,
            cancelled: false,
            token: `settings:${checkoutParam}`,
          }
        : null,
    [checkoutParam],
  );

  useEffect(() => {
    if (!providerCardSetupSession) return;
    let active = true;
    setSetupLoading(true);
    import("@/lib/provider-billing")
      .then(({ getProviderCardSetupStatus }) =>
        getProviderCardSetupStatus(providerCardSetupSession),
      )
      .then(async (result) => {
        if (!active) return;
        if (result.status === "succeeded") {
          await qc.invalidateQueries({ queryKey: PROVIDER_BILLING_QUERY_KEY });
        } else if (result.status === "expired") {
          setActionError("Card setup expired. Start again when you’re ready.");
        } else {
          setActionError("Card setup is still processing. Pull to refresh shortly.");
        }
      })
      .catch((error) => {
        if (active) setActionError(errorText(error));
      })
      .finally(() => {
        if (active) setSetupLoading(false);
      });
    return () => {
      active = false;
    };
  }, [providerCardSetupSession, qc]);

  async function launchCardSetup() {
    if (setupLoading || !selectedLab) return;
    setSetupLoading(true);
    setActionError(null);
    try {
      const result = await createProviderCardSetup(
        selectedLab.providerOrganizationId,
      );
      if (!result.url) throw new Error("The hosted setup link was not returned.");
      const supported = await Linking.canOpenURL(result.url);
      if (!supported) throw new Error("Your device cannot open the secure billing page.");
      await Linking.openURL(result.url);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setSetupLoading(false);
    }
  }

  async function saveSubscriptionAutoPay(preference: AutoPayPreference) {
    if (preference.enabled && !Number.isInteger(preference.chargeDay)) {
      setActionError("Choose a charge day from 1 through 10.");
      return;
    }
    try {
      const { updateSubscriptionAutoPay } = await import("@/lib/provider-billing");
      await updateSubscriptionAutoPay(preference);
      await qc.invalidateQueries({ queryKey: PROVIDER_BILLING_QUERY_KEY });
    } catch (error) {
      setActionError(errorText(error));
      throw error;
    }
  }

  const card = selectedLab?.card;

  const accountPanels = (
    <View style={styles.header}>
      {billingQuery.isLoading && <ActivityIndicator color={colors.tint} style={styles.loader} />}
      {billingQuery.isError && (
        <View style={[styles.alert, { backgroundColor: colors.warning + "12", borderColor: colors.warning + "55" }]}>
          <Ionicons name="cloud-offline-outline" size={18} color={colors.warning} />
          <Text style={[styles.alertText, { color: colors.textSecondary }]}>
            Could not load shared-card and auto-pay settings. Pull to refresh or try again.
          </Text>
        </View>
      )}
      {actionError && (
        <View style={[styles.alert, { backgroundColor: colors.error + "12", borderColor: colors.error + "55" }]}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
          <Text style={[styles.alertText, { color: colors.error }]}>{actionError}</Text>
          <Pressable onPress={() => setActionError(null)} hitSlop={8}><Ionicons name="close" size={18} color={colors.error} /></Pressable>
        </View>
      )}

      {(billing?.labs.length ?? 0) > 1 && (
        <>
          <Text style={styles.sectionHeading}>Provider account</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.dayRow}>
              {billing!.labs.map((lab) => {
                const selected =
                  lab.providerOrganizationId === selectedLab?.providerOrganizationId;
                return (
                  <Pressable
                    key={lab.providerOrganizationId}
                    style={[
                      styles.accountChip,
                      selected && { backgroundColor: colors.tint, borderColor: colors.tint },
                    ]}
                    onPress={() => setSelectedProviderOrganizationId(lab.providerOrganizationId)}
                    testID={`provider-account-${lab.providerOrganizationId}`}
                  >
                    <Text style={[styles.dayText, selected && { color: "#fff" }]}>
                      {lab.providerName}{lab.labName ? ` · ${lab.labName}` : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </>
      )}

      <Card style={styles.cardPanel}>
        <View style={styles.panelHeader}>
          <View style={[styles.panelIcon, { backgroundColor: colors.tint + "18" }]}><Ionicons name="card-outline" size={20} color={colors.tint} /></View>
          <View style={styles.panelCopy}><Text style={styles.panelTitle}>Shared payment card</Text><Text style={styles.panelSubtitle}>Used only for your provider billing</Text></View>
        </View>
        {card?.hasCard ? (
          <View style={styles.cardDetails}>
            <Text style={styles.cardBrand}>{card.brand ? card.brand.toUpperCase() : "CARD"} •••• {card.last4 ?? "••••"}</Text>
            <Text style={styles.cardExpiry}>Expires {card.expMonth ? `${String(card.expMonth).padStart(2, "0")}/${card.expYear ?? "—"}` : "—"}</Text>
          </View>
        ) : (
          <Text style={styles.muted}>No payment card is on file. Add one to enable invoice auto-pay.</Text>
        )}
        <Pressable style={[styles.primaryButton, { backgroundColor: colors.tint }, (!billing || billingQuery.isError) && styles.buttonDisabled]} onPress={() => void launchCardSetup()} disabled={setupLoading || !billing || billingQuery.isError}>
          {setupLoading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="open-outline" size={16} color="#fff" />}
          <Text style={styles.primaryButtonText}>{card?.hasCard ? "Replace card securely" : "Add card securely"}</Text>
        </Pressable>
        <Text style={styles.securityNote}>Card details are handled by Stripe. LabTrax only receives a masked summary.</Text>
      </Card>

      <ProviderAutoPayAuthorization
        providerOrganizationId={selectedLab?.providerOrganizationId}
        labName={selectedLab?.labName || selectedLab?.providerName}
      />

      <AutoPayCard
        title="Subscription auto-pay"
        subtitle="Keep your LabTrax subscription current automatically."
        preference={normalizePreference(billing?.subscriptionAutoPay)}
        disabled={!billingCapabilityAvailable || (!billing?.card.hasCard && !normalizePreference(billing?.subscriptionAutoPay).enabled)}
        onSave={(preference) => void saveSubscriptionAutoPay(preference)}
        styles={styles}
        colors={colors}
      />
      {!billingCapabilityAvailable && (
        <Text style={styles.explanation}>
          Automatic payment scheduling is not available yet. You can still pay securely below.
        </Text>
      )}

      {selectedLab?.labOrganizationId ? (
        <Pressable
          testID="provider-shared-account"
          style={styles.relationshipLink}
          onPress={() =>
            router.push({
              pathname: "/settings/shared-account",
              params: {
                labOrganizationId: selectedLab.labOrganizationId!,
                providerOrganizationId: selectedLab.providerOrganizationId,
                relationshipName: selectedLab.labName || selectedLab.providerName,
              },
            } as never)
          }
        >
          <View style={styles.listCopy}>
            <Text style={styles.panelTitle}>Shared account profile</Text>
            <Text style={styles.listMeta}>Contact details, profile proposals, and approval history</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <ScreenShell title="Provider Billing" subtitle="Payments and auto-pay" onBack={() => router.back()} insetTop={insets.top}>
      <ProviderBillingSection
        origin="settings"
        checkoutReturn={checkoutReturn}
        header={accountPanels}
      />
    </ScreenShell>
  );
}

function AutoPayCard({
  title,
  subtitle,
  preference,
  disabled,
  onSave,
  styles,
  colors,
}: {
  title: string;
  subtitle: string;
  preference: AutoPayPreference;
  disabled: boolean;
  onSave: (preference: AutoPayPreference) => Promise<void> | void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const [enabled, setEnabled] = useState(preference.enabled);
  const [day, setDay] = useState(preference.chargeDay ?? 1);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEnabled(preference.enabled);
    setDay(preference.chargeDay ?? 1);
  }, [preference.chargeDay, preference.enabled]);
  async function save(
    nextEnabled = enabled,
    nextDay = day,
    previous = { enabled, day },
  ) {
    if (nextEnabled && (nextDay < 1 || nextDay > 10)) return;
    setSaving(true);
    try {
      await onSave({ enabled: nextEnabled, chargeDay: nextEnabled ? nextDay : null });
    } catch {
      setEnabled(previous.enabled);
      setDay(previous.day);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card style={styles.autoPayCard}>
      <View style={styles.autoPayHeader}><View style={styles.panelCopy}><Text style={styles.panelTitle}>{title}</Text><Text style={styles.panelSubtitle}>{subtitle}</Text></View><Switch value={enabled} onValueChange={(value) => { const previous = { enabled, day }; setEnabled(value); void save(value, day, previous); }} disabled={disabled || saving} trackColor={{ false: colors.border, true: colors.tint }} thumbColor="#fff" testID={`${title}-toggle`} /></View>
      {disabled && <Text style={[styles.disabledNote, { color: colors.warning }]}>Add a shared card before enabling auto-pay.</Text>}
      <Text style={styles.panelSubtitle}>
        {preference.authorization?.authorizationId
          ? `Signed authorization active${preference.authorization.nextRunAt ? ` · Next run ${new Date(preference.authorization.nextRunAt).toLocaleDateString()}` : ""}`
          : "A signed authorization is required before charges can run."}
      </Text>
      {preference.authorization?.lastResult && (
        <Text style={styles.panelSubtitle}>
          Last result: {preference.authorization.lastResult}
          {preference.authorization.lastFailureReason ? ` · ${preference.authorization.lastFailureReason}` : ""}
        </Text>
      )}
      {preference.authorization?.updateCardRequired && (
        <Text style={[styles.disabledNote, { color: colors.warning }]}>Update the shared card before the next charge.</Text>
      )}
      {enabled && !disabled && <View><Text style={styles.dayLabel}>Charge day (1–10)</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayList}>{DAYS.map((value) => <Pressable key={value} onPress={() => { const previous = { enabled, day }; setDay(value); void save(true, value, previous); }} style={[styles.dayChip, { borderColor: day === value ? colors.tint : colors.border, backgroundColor: day === value ? colors.tint + "18" : colors.surface }]}><Text style={[styles.dayText, { color: day === value ? colors.tint : colors.text }]}>{value}</Text></Pressable>)}</ScrollView></View>}
      {saving && <ActivityIndicator size="small" color={colors.tint} style={styles.inlineLoader} />}
    </Card>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    header: { gap: Spacing.md, paddingBottom: Spacing.md },
    loader: { marginVertical: Spacing.lg },
    alert: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, padding: Spacing.md, borderRadius: Radius.md, borderWidth: 1 },
    alertText: { flex: 1, ...Typography.caption },
    cardPanel: { gap: Spacing.md },
    panelHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    panelIcon: { width: 38, height: 38, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
    panelCopy: { flex: 1, gap: 2 },
    panelTitle: { ...Typography.bodySemibold, color: c.text },
    panelSubtitle: { ...Typography.caption, color: c.textSecondary },
    cardDetails: { padding: Spacing.md, borderRadius: Radius.md, backgroundColor: c.backgroundSolid, gap: 4 },
    cardBrand: { ...Typography.bodySemibold, color: c.text, letterSpacing: 0.5 },
    cardExpiry: { ...Typography.caption, color: c.textSecondary },
    muted: { ...Typography.body, color: c.textSecondary },
    primaryButton: { minHeight: 44, borderRadius: Radius.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm, paddingHorizontal: Spacing.md },
    primaryButtonText: { ...Typography.bodySemibold, color: "#fff" },
    securityNote: { ...Typography.caption, color: c.textTertiary, lineHeight: 17 },
    autoPayCard: { gap: Spacing.sm },
    autoPayHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    disabledNote: { ...Typography.caption },
    dayLabel: { ...Typography.captionSemibold, color: c.textSecondary, marginTop: Spacing.xs },
    dayList: { gap: Spacing.xs, paddingVertical: Spacing.xs },
    dayRow: { flexDirection: "row", gap: Spacing.xs, paddingVertical: Spacing.xs },
    dayChip: { minWidth: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: "center", justifyContent: "center" },
    accountChip: { minHeight: 34, borderRadius: 17, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: "center", justifyContent: "center", paddingHorizontal: Spacing.md },
    dayText: { ...Typography.captionSemibold, color: c.text },
    inlineLoader: { alignSelf: "flex-start" },
    sectionHeading: { ...Typography.label, color: c.textTertiary, textTransform: "uppercase" as const, marginTop: Spacing.xs },
    explanation: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    relationshipLink: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: Spacing.md, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, padding: Spacing.md, backgroundColor: c.surface },
    listCopy: { flex: 1, gap: 2 },
    listMeta: { ...Typography.caption, color: c.textSecondary },
    buttonDisabled: { opacity: 0.6 },
  });
}
