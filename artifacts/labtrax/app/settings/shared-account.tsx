import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { useMe, roleIsAdmin } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import {
  createSharedProviderAccountChange,
  decideSharedProviderAccountChange,
  getLabCardContext,
  getSharedProviderAccount,
  sharedProviderAccountQueryKey,
  SharedProviderAccountError,
  type SharedProviderAccountChange,
  type SharedProviderContactChanges,
} from "@/lib/shared-provider-account";

const FIELDS: Array<{
  key: keyof SharedProviderContactChanges;
  label: string;
  keyboardType?: "email-address" | "phone-pad";
}> = [
  { key: "name", label: "Legal name" },
  { key: "displayName", label: "Display name" },
  { key: "billingEmail", label: "Billing email", keyboardType: "email-address" },
  { key: "phone", label: "Phone", keyboardType: "phone-pad" },
  { key: "addressLine1", label: "Address line 1" },
  { key: "addressLine2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP code" },
];

function statusVariant(status: SharedProviderAccountChange["status"]): BadgeVariant {
  if (status === "approved") return "paid";
  if (status === "rejected" || status === "stale") return "overdue";
  return "intake";
}

function readableError(error: unknown): string {
  if (error instanceof SharedProviderAccountError) return error.message;
  return "That account action could not be completed. Pull to refresh and try again.";
}

function displayValue(value: string | null | undefined): string {
  return value?.trim() || "Not provided";
}

export default function SharedAccountScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe();
  const params = useLocalSearchParams<{
    labOrganizationId?: string;
    providerOrganizationId?: string;
    relationshipName?: string;
    requestId?: string;
  }>();
  const labOrganizationId = params.labOrganizationId ?? "";
  const providerOrganizationId = params.providerOrganizationId ?? "";
  const key = sharedProviderAccountQueryKey(labOrganizationId, providerOrganizationId);
  const [draft, setDraft] = useState<SharedProviderContactChanges>({});
  const [notice, setNotice] = useState<string | null>(null);

  const accountQuery = useQuery({
    queryKey: key,
    enabled: !!labOrganizationId && !!providerOrganizationId,
    queryFn: () => getSharedProviderAccount(labOrganizationId, providerOrganizationId),
    staleTime: 15_000,
  });

  const memberships = (me.data?.memberships ?? []) as Array<{
    organizationId?: string | null;
    role?: string | null;
    status?: string | null;
  }>;
  const providerAdmin = memberships.some(
    (membership) =>
      membership.status === "active" &&
      membership.organizationId === providerOrganizationId &&
      roleIsAdmin(membership.role),
  );
  const labAdmin = memberships.some(
    (membership) =>
      membership.status === "active" &&
      membership.organizationId === labOrganizationId &&
      roleIsAdmin(membership.role),
  );
  const canPropose = providerAdmin || labAdmin;

  const labContextQuery = useQuery({
    queryKey: ["provider-lab-card", labOrganizationId, providerOrganizationId],
    enabled: labAdmin && !!labOrganizationId && !!providerOrganizationId,
    queryFn: () => getLabCardContext(labOrganizationId, providerOrganizationId),
    staleTime: 15_000,
  });

  useEffect(() => {
    const contact = accountQuery.data?.contact;
    if (!contact) return;
    setDraft(
      Object.fromEntries(
        FIELDS.map(({ key: field }) => [field, contact[field] ?? null]),
      ) as SharedProviderContactChanges,
    );
  }, [accountQuery.data?.contact.updatedAt]);

  const changedFields = useMemo(() => {
    const contact = accountQuery.data?.contact;
    if (!contact) return {};
    return Object.fromEntries(
      FIELDS.flatMap(({ key: field }) => {
        const next = draft[field]?.trim() || null;
        return next !== (contact[field] ?? null) ? [[field, next]] : [];
      }),
    ) as SharedProviderContactChanges;
  }, [accountQuery.data?.contact, draft]);

  const refresh = async () => {
    setNotice(null);
    await Promise.all([
      accountQuery.refetch(),
      labContextQuery.isEnabled ? labContextQuery.refetch() : Promise.resolve(),
    ]);
  };

  const proposeMutation = useMutation({
    mutationFn: () =>
      createSharedProviderAccountChange(
        labOrganizationId,
        providerOrganizationId,
        changedFields,
      ),
    onSuccess: async () => {
      setNotice("Changes sent to the connected account for approval.");
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: (error) => Alert.alert("Could not send changes", readableError(error)),
  });

  const decisionMutation = useMutation({
    mutationFn: (input: { requestId: string; decision: "approve" | "reject" }) =>
      decideSharedProviderAccountChange(input.requestId, input.decision),
    onSuccess: async (request) => {
      setNotice(
        request.status === "approved"
          ? "The shared profile was updated."
          : "The proposed changes were declined.",
      );
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: async (error) => {
      if (error instanceof SharedProviderAccountError && error.status === 409) {
        setNotice("This request is no longer current. The latest profile has been reloaded.");
        await qc.invalidateQueries({ queryKey: key });
      } else {
        Alert.alert("Could not review request", readableError(error));
      }
    },
  });

  const account = accountQuery.data;
  const pending = account?.profileChangeRequests.filter((request) => request.status === "pending") ?? [];
  const history = account?.profileChangeRequests.filter((request) => request.status !== "pending") ?? [];
  const card = account?.card;
  const autoPay = labContextQuery.data?.autoPay;
  const hasChanges = Object.keys(changedFields).length > 0;

  return (
    <ScreenShell
      title={params.relationshipName || "Shared account"}
      onBack={() => router.back()}
    >
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={accountQuery.isFetching || labContextQuery.isFetching}
            onRefresh={() => void refresh()}
            tintColor={colors.tint}
          />
        }
      >
        {!labOrganizationId || !providerOrganizationId ? (
          <Card><Text style={styles.error}>This relationship link is incomplete.</Text></Card>
        ) : accountQuery.isLoading ? (
          <ActivityIndicator color={colors.tint} />
        ) : accountQuery.isError || !account ? (
          <Card style={styles.panel}>
            <Text style={styles.panelTitle}>Account unavailable</Text>
            <Text style={styles.muted}>
              Your saved screen state is unchanged. Check your connection and pull to refresh.
            </Text>
          </Card>
        ) : (
          <>
            {notice ? (
              <View style={[styles.notice, { borderColor: colors.tint }]}>
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
            ) : null}

            <Card style={styles.panel}>
              <View style={styles.panelHeader}>
                <View style={[styles.icon, { backgroundColor: `${colors.tint}18` }]}>
                  <Ionicons name="card-outline" size={20} color={colors.tint} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.panelTitle}>Shared payment card</Text>
                  <Text style={styles.muted}>Processor-backed summary only. Full card data is never stored here.</Text>
                </View>
              </View>
              <Text style={styles.cardNumber}>
                {card ? `${card.brand.toUpperCase()} •••• ${card.last4}` : "No card on file"}
              </Text>
              {card ? (
                <Text style={styles.muted}>
                  Expires {String(card.expMonth).padStart(2, "0")}/{String(card.expYear).slice(-2)} · {card.status}
                </Text>
              ) : null}
              {labAdmin ? (
                <Text style={styles.context}>
                  Invoice auto-pay is {autoPay?.enabled ? `on for day ${autoPay.dayOfMonth}` : "off"}.
                  This setting is read-only for the lab.
                </Text>
              ) : (
                <Text style={styles.context}>Card replacement and auto-pay controls are in Provider Billing.</Text>
              )}
            </Card>

            <Text style={styles.sectionHeading}>Relationship profile</Text>
            <Card style={styles.panel}>
              {FIELDS.map((field) => (
                <View key={field.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{field.label}</Text>
                  {canPropose ? (
                    <TextInput
                      testID={`shared-account-${field.key}`}
                      style={styles.input}
                      value={(draft[field.key] as string | null | undefined) ?? ""}
                      onChangeText={(value) =>
                        setDraft((current) => ({ ...current, [field.key]: value }))
                      }
                      keyboardType={field.keyboardType}
                      autoCapitalize={field.keyboardType === "email-address" ? "none" : "sentences"}
                      placeholder="Not provided"
                      placeholderTextColor={colors.textTertiary}
                    />
                  ) : (
                    <Text style={styles.value}>{displayValue(account.contact[field.key])}</Text>
                  )}
                </View>
              ))}
              {canPropose ? (
                <>
                  <Text style={styles.context}>
                    Profile and contact edits require approval from the other side. Card changes remain immediate.
                  </Text>
                  <Pressable
                    testID="shared-account-propose"
                    style={[
                      styles.primaryButton,
                      { backgroundColor: colors.tint },
                      (!hasChanges || proposeMutation.isPending) && styles.disabled,
                    ]}
                    disabled={!hasChanges || proposeMutation.isPending}
                    onPress={() => proposeMutation.mutate()}
                  >
                    <Text style={styles.primaryButtonText}>
                      {proposeMutation.isPending ? "Sending…" : "Send for approval"}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </Card>

            <Text style={styles.sectionHeading}>Pending review</Text>
            {pending.length === 0 ? (
              <Card><Text style={styles.muted}>No profile changes are waiting for review.</Text></Card>
            ) : pending.map((request) => {
              const canReview =
                (request.requestedByOrganizationId === labOrganizationId && providerAdmin) ||
                (request.requestedByOrganizationId === providerOrganizationId && labAdmin);
              return (
                <ChangeCard
                  key={request.id}
                  request={request}
                  highlighted={params.requestId === request.id}
                  canReview={canReview}
                  busy={decisionMutation.isPending}
                  onDecision={(decision) =>
                    decisionMutation.mutate({ requestId: request.id, decision })
                  }
                  styles={styles}
                  colors={colors}
                />
              );
            })}

            {history.length > 0 ? (
              <>
                <Text style={styles.sectionHeading}>Recent decisions</Text>
                {history.slice(0, 5).map((request) => (
                  <ChangeCard
                    key={request.id}
                    request={request}
                    highlighted={params.requestId === request.id}
                    canReview={false}
                    busy={false}
                    onDecision={() => undefined}
                    styles={styles}
                    colors={colors}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function ChangeCard({
  request,
  highlighted,
  canReview,
  busy,
  onDecision,
  styles,
  colors,
}: {
  request: SharedProviderAccountChange;
  highlighted: boolean;
  canReview: boolean;
  busy: boolean;
  onDecision: (decision: "approve" | "reject") => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  return (
    <Card style={[styles.panel, highlighted && { borderColor: colors.tint }]}>
      <View style={styles.requestHeader}>
        <Text style={styles.panelTitle}>
          {request.source === "lab" ? "Lab proposal" : "Provider proposal"}
        </Text>
        <StatusBadge
          label={request.status === "stale" ? "Out of date" : request.status}
          variant={statusVariant(request.status)}
          size="sm"
        />
      </View>
      {Object.entries(request.changes).map(([field, value]) => (
        <View key={field} style={styles.changeRow}>
          <Text style={styles.fieldLabel}>{FIELDS.find((item) => item.key === field)?.label ?? field}</Text>
          <Text style={styles.value}>{displayValue(value)}</Text>
        </View>
      ))}
      {request.status === "stale" ? (
        <Text style={styles.context}>The profile changed after this proposal. Create a new request from current values.</Text>
      ) : null}
      {canReview ? (
        <View style={styles.actions}>
          <Pressable
            testID={`shared-account-reject-${request.id}`}
            style={styles.secondaryButton}
            disabled={busy}
            onPress={() => onDecision("reject")}
          >
            <Text style={styles.secondaryButtonText}>Decline</Text>
          </Pressable>
          <Pressable
            testID={`shared-account-approve-${request.id}`}
            style={[styles.primaryButton, styles.actionButton, { backgroundColor: colors.tint }]}
            disabled={busy}
            onPress={() => onDecision("approve")}
          >
            <Text style={styles.primaryButtonText}>Approve</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    panel: { gap: Spacing.md },
    panelHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    icon: { width: 38, height: 38, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
    flex: { flex: 1, gap: 2 },
    panelTitle: { ...Typography.bodySemibold, color: c.text },
    muted: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    error: { ...Typography.body, color: c.error },
    cardNumber: { ...Typography.h3, color: c.text, letterSpacing: 0.5 },
    context: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    sectionHeading: { ...Typography.label, color: c.textTertiary, textTransform: "uppercase" as const, marginTop: Spacing.sm },
    field: { gap: 5 },
    fieldLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, paddingHorizontal: Spacing.md, color: c.text, backgroundColor: c.backgroundSolid, ...Typography.body },
    value: { ...Typography.body, color: c.text },
    notice: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, backgroundColor: `${c.tint}0D` },
    noticeText: { ...Typography.bodyMedium, color: c.text },
    primaryButton: { minHeight: 44, borderRadius: Radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: Spacing.md },
    primaryButtonText: { ...Typography.bodySemibold, color: "#fff" },
    disabled: { opacity: 0.5 },
    requestHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    changeRow: { gap: 2 },
    actions: { flexDirection: "row", gap: Spacing.sm },
    actionButton: { flex: 1 },
    secondaryButton: { minHeight: 44, flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
    secondaryButtonText: { ...Typography.bodySemibold, color: c.textSecondary },
  });
}