// The signed auto-pay authorization, on mobile.
//
// One implementation behind both provider entry points, the way desktop has
// one `AutoPayAuthorization`:
//
//   • the lab app's Account → Provider Billing screen, the only way in for a
//     lab-app user who also holds a provider membership, and
//   • the provider portal's My Account, directly under subscription auto-pay —
//     where desktop signs it.
//
// The card owns the two reads it needs (the current authorization and the
// prepared agreement) so both surfaces show the same agreement text, the same
// card, and the same covered labs without either one wiring them up. Their
// query keys stay under the prefixes `lib/provider-practice` purges when the
// active practice changes, so a signed agreement never leaks across practices.
//
// `onSubmitted` is for whatever else the host surface shows about the
// authorization — My Account's subscription state line, for one; the card
// re-reads its own authorization either way.
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { SignaturePad, type SignaturePadHandle } from "@/components/settings/SignaturePad";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  getProviderAuthorizations,
  prepareProviderAuthorization,
  submitProviderAuthorization,
} from "@/lib/provider-autopay-authorization";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

export interface ProviderAutoPayAuthorizationProps {
  /** The provider organization the agreement is signed for. */
  providerOrganizationId?: string | null;
  /** Names the lab-bills option when the surface knows a single lab. */
  labName?: string | null;
  /** Called after a signature is accepted, for state the host surface shows. */
  onSubmitted?: () => void;
}

export function ProviderAutoPayAuthorization({
  providerOrganizationId,
  labName,
  onSubmitted,
}: ProviderAutoPayAuthorizationProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [subscriptionFees, setSubscriptionFees] = useState(false);
  const [labBills, setLabBills] = useState(false);
  const [day, setDay] = useState(10);
  const [legalName, setLegalName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pad = useRef<SignaturePadHandle>(null);

  const authorizationsQuery = useQuery({
    queryKey: ["provider-autopay-authorizations", providerOrganizationId],
    enabled: !!providerOrganizationId,
    queryFn: () => getProviderAuthorizations(providerOrganizationId!),
    staleTime: 30_000,
  });
  const prepareQuery = useQuery({
    queryKey: ["provider-autopay-authorization-prepare", providerOrganizationId],
    enabled: !!providerOrganizationId,
    queryFn: () => prepareProviderAuthorization(providerOrganizationId!),
  });

  const prepared = prepareQuery.data;
  const current = (authorizationsQuery.data ?? []).find((item) => item.status === "active");
  const coveredLabs = prepared?.labs ?? [];
  const incomplete = !legalName.trim() || !consent || (!subscriptionFees && !labBills);

  async function submit() {
    const signatureDataUrl = pad.current?.toDataUrl();
    if (!providerOrganizationId || incomplete || !signatureDataUrl) return;
    setBusy(true);
    setError(null);
    try {
      await submitProviderAuthorization({
        providerOrganizationId,
        agreementVersion: prepared?.agreementVersion ?? "2025-01",
        agreementSha256: prepared?.agreementSha256 ?? "",
        subscriptionFees,
        labBills,
        labOrganizationIds: labBills
          ? coveredLabs
              .map((lab) => lab.labOrganizationId)
              .filter((id): id is string => !!id)
          : [],
        labChargeDay: labBills ? day : null,
        typedLegalName: legalName.trim(),
        consent: true,
        signatureData: signatureDataUrl,
      });
      pad.current?.clear();
      setLegalName("");
      setConsent(false);
      setSubscriptionFees(false);
      setLabBills(false);
      // The card's own view of the authorization, then whatever else the host
      // surface shows about it.
      void authorizationsQuery.refetch();
      onSubmitted?.();
    } catch (cause) {
      // Without this the provider taps Sign and nothing at all happens.
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not submit the authorization. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.cardPanel} testID="provider-autopay-authorization">
      <Text style={styles.panelTitle}>Auto-pay authorization</Text>
      <Text style={styles.explanation}>
        Authorize subscription and lab bills independently. Lab bills are due by the 10th;
        choose a charge day from 1 through 10.
      </Text>
      <Pressable
        onPress={() => setSubscriptionFees(!subscriptionFees)}
        style={styles.invoicePickRow}
        testID="provider-authorization-subscription-fees"
      >
        <Ionicons name={subscriptionFees ? "checkbox" : "square-outline"} size={20} color={colors.tint} />
        <Text style={styles.explanation}>Subscription fees</Text>
      </Pressable>
      <Pressable
        onPress={() => setLabBills(!labBills)}
        style={styles.invoicePickRow}
        testID="provider-authorization-lab-bills"
      >
        <Ionicons name={labBills ? "checkbox" : "square-outline"} size={20} color={colors.tint} />
        <Text style={styles.explanation}>{labName || "Lab"} bills</Text>
      </Pressable>
      {current ? (
        <Text style={styles.explanation} testID="provider-authorization-active">
          Active authorization: {current.card?.brand || "Card"} •••• {current.card?.last4 || "••••"}
        </Text>
      ) : null}
      {prepared?.agreementText ? (
        <Text style={styles.explanation}>{prepared.agreementText}</Text>
      ) : null}
      {prepared?.card ? (
        <Text style={styles.explanation}>
          Card: {prepared.card.brand || "Card"} •••• {prepared.card.last4 || "••••"}
          {prepared.card.billingAddress
            ? ` · ${Object.values(prepared.card.billingAddress)
                .filter((value): value is string => typeof value === "string" && !!value)
                .join(", ")}`
            : ""}
        </Text>
      ) : null}
      {labBills && coveredLabs.length > 0 ? (
        <View style={styles.modeRow}>
          {coveredLabs.map((lab) => (
            <Text key={lab.labOrganizationId} style={styles.explanation}>
              {lab.labName || lab.labOrganizationId}
            </Text>
          ))}
        </View>
      ) : null}
      {labBills ? (
        <TextInput
          value={String(day)}
          onChangeText={(value) => setDay(Math.max(1, Math.min(10, Number(value) || 1)))}
          keyboardType="number-pad"
          placeholder="Charge day 1–10"
          style={styles.amountInput}
          testID="provider-authorization-charge-day"
        />
      ) : null}
      <TextInput
        value={legalName}
        onChangeText={setLegalName}
        placeholder="Type your legal name"
        placeholderTextColor={colors.textTertiary}
        style={styles.amountInput}
        testID="provider-authorization-legal-name"
      />
      <Pressable
        onPress={() => setConsent((value) => !value)}
        style={styles.invoicePickRow}
        testID="provider-authorization-consent"
      >
        <Ionicons
          name={consent ? "checkbox" : "square-outline"}
          size={20}
          color={consent ? colors.tint : colors.textTertiary}
        />
        <Text style={styles.explanation}>
          I agree to the authorization terms and electronic signature.
        </Text>
      </Pressable>
      <SignaturePad ref={pad} />
      {error ? (
        <Text style={[styles.explanation, { color: colors.error }]} testID="provider-authorization-error">
          {error}
        </Text>
      ) : null}
      <Pressable
        testID="submit-provider-authorization"
        onPress={() => void submit()}
        disabled={busy || incomplete}
        style={[
          styles.primaryButton,
          { backgroundColor: colors.tint },
          (busy || incomplete) && styles.buttonDisabled,
        ]}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>Sign and authorize</Text>
        )}
      </Pressable>
    </Card>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    cardPanel: { gap: Spacing.md },
    panelTitle: { ...Typography.bodySemibold, color: c.text },
    explanation: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    modeRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
    amountInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.md,
      color: c.text,
      ...Typography.body,
    },
    invoicePickRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
    },
    primaryButton: {
      minHeight: 44,
      borderRadius: Radius.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
    },
    primaryButtonText: { ...Typography.bodySemibold, color: "#fff" },
    buttonDisabled: { opacity: 0.6 },
  });
}
