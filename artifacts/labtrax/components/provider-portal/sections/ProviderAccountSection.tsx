// Provider portal → My Account.
//
// The desktop ProviderMyAccount in one phone-shaped column, in the same order
// and with the same wording: a notice strip, the shared lab accounts (card on
// file + the practice contact fields), subscription auto-pay, the read-only
// account number, then the provider's own details.
//
// Two things behave slightly differently from desktop, deliberately:
//   * Desktop reads the Stripe return out of the URL on mount; a phone has no
//     URL to read, so the return arrives through the card-setup store that the
//     deep-link handler writes (see lib/provider-card-setup-return).
//   * A failed subscription save snaps the controls back to the server's
//     values instead of leaving the attempted ones on screen, so nothing can
//     read as saved when it was not.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProviderAutoPayAuthorization } from "@/components/autopay/ProviderAutoPayAuthorization";
import { Card } from "@/components/ui/Card";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { ME_QUERY_KEY, useMe } from "@/lib/auth-me";
import {
  PROVIDER_CONTACT_FIELDS,
  PROVIDER_PROFILE_FIELDS,
  contactDraftFrom,
  describeSharedCard,
  diffProviderContact,
  getProviderAccountBilling,
  profileFormFrom,
  providerAccountQueryKey,
  providerAccountUserFrom,
  saveProviderProfile,
  updateProviderPortalContact,
  type ProviderAccountLab,
  type ProviderContactDraft,
  type ProviderProfileForm,
} from "@/lib/provider-account";
import {
  PROVIDER_BILLING_QUERY_KEY,
  createProviderCardSetup,
  getProviderCardSetupStatus,
  updateSubscriptionAutoPay,
  validChargeDay,
} from "@/lib/provider-billing";
import {
  consumeProviderCardSetupReturn,
  subscribeProviderCardSetupReturn,
  type ProviderCardSetupReturn,
} from "@/lib/provider-card-setup-return";
import { useProviderPractice } from "@/lib/provider-practice";
import { decideSharedProviderAccountChange } from "@/lib/shared-provider-account";
import { useTheme, type ThemeColors } from "@/lib/theme-context";

type NoticeTone = "success" | "warning" | "danger";
interface Notice {
  tone: NoticeTone;
  message: string;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ProviderAccountSection() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const queryClient = useQueryClient();
  const practice = useProviderPractice();
  const providerOrganizationId = practice.selectedPracticeId;

  const me = useMe();
  const user = providerAccountUserFrom(me.data);
  const ownsSelectedPractice = me.data?.memberships.some(
    (m) => m.organizationId === providerOrganizationId && m.status === "active" && m.role === "owner",
  ) === true;

  const [notice, setNotice] = useState<Notice | null>(null);
  const [profileForm, setProfileForm] = useState<ProviderProfileForm | null>(null);
  const [contactDrafts, setContactDrafts] = useState<Record<string, ProviderContactDraft>>({});
  const [subscriptionDraft, setSubscriptionDraft] = useState<{
    enabled: boolean;
    chargeDay: string;
  } | null>(null);
  const [contactSaving, setContactSaving] = useState<string | null>(null);
  const [requestSaving, setRequestSaving] = useState<string | null>(null);
  const [cardSetupLoading, setCardSetupLoading] = useState<string | null>(null);
  const [subscriptionSaving, setSubscriptionSaving] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  const billingQuery = useQuery({
    queryKey: providerAccountQueryKey(providerOrganizationId),
    queryFn: () => getProviderAccountBilling(providerOrganizationId),
    staleTime: 30_000,
    enabled: !!providerOrganizationId,
  });
  const billing = billingQuery.data ?? null;

  // ── Hydration ────────────────────────────────────────────────────────────
  // Both forms hydrate once per identity. A background refetch must not wipe
  // out what the provider is part-way through typing.
  const hydratedProfileFor = useRef<string | null>(null);
  useEffect(() => {
    if (!user || hydratedProfileFor.current === user.id) return;
    hydratedProfileFor.current = user.id;
    setProfileForm(profileFormFrom(user));
  }, [user]);

  useEffect(() => {
    const labs = billing?.labs;
    if (!labs?.length) return;
    setContactDrafts((current) => {
      let next: Record<string, ProviderContactDraft> | null = null;
      for (const lab of labs) {
        if (current[lab.providerOrganizationId] || !lab.contact) continue;
        next ??= { ...current };
        next[lab.providerOrganizationId] = contactDraftFrom(lab.contact);
      }
      // Same object when nothing was seeded: a new record identity here would
      // re-run every consumer effect on each refetch.
      return next ?? current;
    });
  }, [billing]);

  // The agreement is signed for the practice the portal is scoped to; a
  // provider who somehow arrives before a practice is selected still signs for
  // the account the page is showing.
  const authorizationProviderId =
    providerOrganizationId ?? billing?.labs[0]?.providerOrganizationId ?? null;

  const subscription = billing?.subscription ?? null;
  const subscriptionEnabled = subscriptionDraft?.enabled ?? subscription?.enabled ?? false;
  const subscriptionChargeDay =
    subscriptionDraft?.chargeDay ?? String(subscription?.chargeDay ?? 10);
  const authorization = subscription?.authorization ?? null;

  const accountNumber =
    user?.practiceAccountNumber ?? practice.selectedPractice?.accountNumber ?? null;

  // ── Actions ──────────────────────────────────────────────────────────────
  async function startCardSetup(lab: ProviderAccountLab) {
    if (cardSetupLoading) return;
    setCardSetupLoading(lab.providerOrganizationId);
    setNotice(null);
    try {
      const result = await createProviderCardSetup(lab.providerOrganizationId);
      if (!result.url) throw new Error("Stripe did not return a card setup link.");
      const supported = await Linking.canOpenURL(result.url);
      if (!supported) throw new Error("Your device cannot open the secure card setup page.");
      await Linking.openURL(result.url);
    } catch (error) {
      setNotice({
        tone: "danger",
        message: errorText(error, "Could not open secure card setup."),
      });
    } finally {
      setCardSetupLoading(null);
    }
  }

  const handleCardSetupReturn = useCallback(
    async (value: ProviderCardSetupReturn) => {
      if (value.cancelled) {
        setNotice({
          tone: "warning",
          message: "Card setup was cancelled. No card was changed.",
        });
        return;
      }
      try {
        const result = await getProviderCardSetupStatus(value.sessionId);
        if (result.status === "succeeded") {
          await billingQuery.refetch();
          // The billing section shows the same card; keep it honest too.
          queryClient.invalidateQueries({ queryKey: PROVIDER_BILLING_QUERY_KEY });
          setNotice({
            tone: "success",
            message: "Your shared card was updated securely.",
          });
        } else if (result.status === "expired") {
          setNotice({
            tone: "danger",
            message: "That card setup session expired. Please start again.",
          });
        } else {
          setNotice({
            tone: "warning",
            message: "Stripe is still confirming the card. Pull to refresh in a moment.",
          });
        }
      } catch (error) {
        setNotice({
          tone: "danger",
          message: errorText(error, "Could not confirm that card setup."),
        });
      }
    },
    [billingQuery, queryClient],
  );

  // Handle a return that arrived while another section was showing, and any
  // that arrives while My Account is on screen. `consume` clears the pending
  // value, so a return is never handled twice.
  useEffect(() => {
    const drain = () => {
      const pending = consumeProviderCardSetupReturn();
      if (pending) void handleCardSetupReturn(pending);
    };
    drain();
    return subscribeProviderCardSetupReturn(drain);
  }, [handleCardSetupReturn]);

  async function saveContact(lab: ProviderAccountLab) {
    if (contactSaving) return;
    const diff = diffProviderContact(lab.contact, contactDrafts[lab.providerOrganizationId]);
    if (!diff.ok) {
      setNotice({ tone: "warning", message: diff.message });
      return;
    }
    setContactSaving(lab.providerOrganizationId);
    setNotice(null);
    try {
      await updateProviderPortalContact(diff.changes);
      const refreshed = await billingQuery.refetch();
      const saved = refreshed.data?.labs.find(
        (row) => row.providerOrganizationId === lab.providerOrganizationId,
      );
      if (saved?.contact) {
        setContactDrafts((current) => ({
          ...current,
          [lab.providerOrganizationId]: contactDraftFrom(saved.contact),
        }));
      }
      setNotice({
        tone: "success",
        message: "Practice contact details were updated.",
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: errorText(error, "Could not update the practice contact details."),
      });
    } finally {
      setContactSaving(null);
    }
  }

  async function decideRequest(requestId: string, decision: "approve" | "reject") {
    if (requestSaving) return;
    setRequestSaving(requestId);
    setNotice(null);
    try {
      await decideSharedProviderAccountChange(requestId, decision);
      await billingQuery.refetch();
      setNotice({
        tone: "success",
        message:
          decision === "approve"
            ? "The lab's contact update was approved."
            : "The lab's contact update was declined.",
      });
    } catch (error) {
      await billingQuery.refetch().catch(() => undefined);
      setNotice({
        tone: "danger",
        message: errorText(error, "Could not review that contact update."),
      });
    } finally {
      setRequestSaving(null);
    }
  }

  async function saveSubscription() {
    if (!subscription || subscriptionSaving) return;
    const chargeDay = Number(subscriptionChargeDay);
    if (!validChargeDay(chargeDay)) {
      setNotice({
        tone: "danger",
        message: "Subscription charge day must be from 1 through 10.",
      });
      return;
    }
    setSubscriptionSaving(true);
    setNotice(null);
    try {
      const saved = await updateSubscriptionAutoPay({
        enabled: subscriptionEnabled,
        chargeDay,
      });
      queryClient.setQueryData(
        providerAccountQueryKey(providerOrganizationId),
        (current: typeof billing) =>
          current ? { ...current, subscription: saved } : current,
      );
      queryClient.invalidateQueries({ queryKey: PROVIDER_BILLING_QUERY_KEY });
      setSubscriptionDraft(null);
      setNotice({ tone: "success", message: "Subscription auto-pay preference saved." });
    } catch (error) {
      // Nothing was saved, so the controls go back to what the server holds
      // rather than displaying the rejected preference as if it had stuck.
      setSubscriptionDraft(null);
      setNotice({
        tone: "danger",
        message: errorText(error, "Could not save subscription auto-pay."),
      });
    } finally {
      setSubscriptionSaving(false);
    }
  }

  const profileMutation = useMutation({
    mutationFn: async (form: ProviderProfileForm) => {
      if (!user) throw new Error("Your profile is still loading.");
      await saveProviderProfile(user.id, form);
    },
  });

  async function saveProfile() {
    if (!profileForm || profileSaving) return;
    setProfileSaving(true);
    setNotice(null);
    try {
      await profileMutation.mutateAsync(profileForm);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setNotice({ tone: "success", message: "Profile updated. Your changes have been saved." });
    } catch (error) {
      setNotice({ tone: "danger", message: errorText(error, "Could not save changes.") });
    } finally {
      setProfileSaving(false);
    }
  }

  async function refreshAll() {
    await Promise.all([providerOrganizationId ? billingQuery.refetch() : Promise.resolve(), me.refetch()]);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const noticeColor =
    notice?.tone === "success"
      ? colors.success
      : notice?.tone === "warning"
        ? colors.warning
        : colors.error;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="provider-portal-section-account"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={scrollKeyboardDismissMode}
      refreshControl={
        <RefreshControl
          refreshing={billingQuery.isFetching}
          onRefresh={() => void refreshAll()}
          tintColor={colors.tint}
        />
      }
    >
      <View style={styles.intro}>
        <Text style={styles.title}>My Account</Text>
        <Text style={styles.subtitle}>
          Update your contact information and practice details.
        </Text>
      </View>
      {!providerOrganizationId && (
        <Text style={styles.subtitle}>
          Your profile is available. Practice billing requires an active, approved practice.
          Return to Dashboard to select a practice or refresh access after approval.
        </Text>
      )}

      {ownsSelectedPractice && (
        <Pressable
          accessibilityRole="button"
          testID="provider-practice-ownership"
          style={styles.tinyButton}
          onPress={() => router.push("/settings/organizations")}
        >
          <Text style={styles.tinyButtonText}>Manage practice team & ownership</Text>
        </Pressable>
      )}

      {notice && (
        <View
          style={[
            styles.notice,
            { backgroundColor: noticeColor + "12", borderColor: noticeColor + "55" },
          ]}
          accessibilityRole="alert"
          testID="provider-account-notice"
        >
          <Ionicons
            name={
              notice.tone === "success"
                ? "checkmark-circle-outline"
                : notice.tone === "warning"
                  ? "alert-circle-outline"
                  : "close-circle-outline"
            }
            size={18}
            color={noticeColor}
          />
          <Text style={[styles.noticeText, { color: noticeColor }]}>{notice.message}</Text>
          <Pressable onPress={() => setNotice(null)} hitSlop={8} accessibilityLabel="Dismiss">
            <Ionicons name="close" size={16} color={noticeColor} />
          </Pressable>
        </View>
      )}

      {/* ── Shared lab accounts ─────────────────────────────────────────── */}
      <Card style={styles.panel}>
        <Text style={styles.panelTitle}>Shared lab accounts</Text>
        <Text style={styles.panelSubtitle}>
          Each lab relationship has its own approved contact profile and billing
          settings. Card details come directly from Stripe; LabTrax never stores
          or displays the full card number.
        </Text>

        {billingQuery.isLoading && (
          <ActivityIndicator
            color={colors.tint}
            style={styles.loader}
            testID="provider-account-loading"
          />
        )}

        {billingQuery.isError && !billing && (
          <Text style={styles.errorText} testID="provider-account-billing-error">
            Billing controls could not be loaded. Your profile is still available.
          </Text>
        )}

        {billing?.labs.length === 0 && (
          <Text style={styles.muted}>No linked labs yet.</Text>
        )}

        {billing?.labs.map((lab) => {
          const draft = contactDrafts[lab.providerOrganizationId];
          return (
            <View
              key={lab.providerOrganizationId}
              style={styles.labBlock}
              testID={`provider-account-lab-${lab.providerOrganizationId}`}
            >
              <View style={styles.labHeader}>
                <View style={styles.labCopy}>
                  <Text style={styles.labName}>{lab.labName ?? "Linked lab"}</Text>
                  <Text
                    style={styles.muted}
                    testID={`provider-account-card-state-${lab.providerOrganizationId}`}
                  >
                    {describeSharedCard(lab.card)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void startCardSetup(lab)}
                  disabled={Boolean(cardSetupLoading)}
                  accessibilityRole="button"
                  style={[styles.secondaryButton, Boolean(cardSetupLoading) && styles.disabled]}
                  testID={`provider-account-card-setup-${lab.providerOrganizationId}`}
                >
                  <Text style={styles.secondaryButtonText}>
                    {cardSetupLoading === lab.providerOrganizationId
                      ? "Opening…"
                      : lab.card
                        ? "Replace card"
                        : "Add card"}
                  </Text>
                </Pressable>
              </View>

              {draft ? (
                <View style={styles.fields}>
                  {PROVIDER_CONTACT_FIELDS.map((field) => (
                    <View key={field.key} style={styles.field}>
                      <Text style={styles.fieldLabel}>{field.label}</Text>
                      <TextInput
                        value={draft[field.key]}
                        onChangeText={(text) =>
                          setContactDrafts((current) => ({
                            ...current,
                            [lab.providerOrganizationId]: {
                              ...current[lab.providerOrganizationId],
                              [field.key]: text,
                            },
                          }))
                        }
                        style={styles.input}
                        placeholderTextColor={colors.textTertiary}
                        autoCapitalize={field.key === "billingEmail" ? "none" : "sentences"}
                        keyboardType={
                          "keyboardType" in field ? field.keyboardType : undefined
                        }
                        accessibilityLabel={`${field.label} for ${lab.labName ?? "linked lab"}`}
                        testID={`provider-account-contact-${field.key}-${lab.providerOrganizationId}`}
                      />
                    </View>
                  ))}
                  <Text style={styles.helpText}>
                    These are your practice's portal contact details. Saving them
                    updates the contact every linked lab sees.
                  </Text>
                  <Pressable
                    onPress={() => void saveContact(lab)}
                    disabled={contactSaving !== null}
                    accessibilityRole="button"
                    style={[styles.secondaryButton, contactSaving !== null && styles.disabled]}
                    testID={`provider-account-contact-save-${lab.providerOrganizationId}`}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {contactSaving === lab.providerOrganizationId
                        ? "Sending…"
                        : "Request contact update"}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.muted}>
                  Contact details for this lab are unavailable.
                </Text>
              )}

              {lab.profileChangeRequests.length > 0 && (
                <View style={styles.history}>
                  <Text style={styles.historyTitle}>Contact change history</Text>
                  {lab.profileChangeRequests.map((request) => {
                    const fromLab =
                      request.requestedByOrganizationId === request.labOrganizationId;
                    return (
                      <View
                        key={request.id}
                        style={styles.historyRow}
                        testID={`provider-account-request-${request.id}`}
                      >
                        <View style={styles.historyHeader}>
                          <Text style={styles.historyLabel}>
                            {fromLab ? "Lab proposed" : "You proposed"} · {request.status}
                          </Text>
                          {fromLab && request.status === "pending" && (
                            <View style={styles.historyActions}>
                              <Pressable
                                onPress={() => void decideRequest(request.id, "approve")}
                                disabled={requestSaving !== null}
                                accessibilityRole="button"
                                style={[
                                  styles.tinyButton,
                                  requestSaving !== null && styles.disabled,
                                ]}
                                testID={`provider-account-request-approve-${request.id}`}
                              >
                                <Text style={styles.tinyButtonText}>Approve</Text>
                              </Pressable>
                              <Pressable
                                onPress={() => void decideRequest(request.id, "reject")}
                                disabled={requestSaving !== null}
                                accessibilityRole="button"
                                style={[
                                  styles.tinyButton,
                                  requestSaving !== null && styles.disabled,
                                ]}
                                testID={`provider-account-request-reject-${request.id}`}
                              >
                                <Text style={styles.tinyButtonText}>Decline</Text>
                              </Pressable>
                            </View>
                          )}
                        </View>
                        <Text style={styles.muted}>
                          {Object.entries(request.changes)
                            .map(([field, value]) => `${field}: ${value || "blank"}`)
                            .join(" · ")}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
      </Card>

      {/* ── Subscription auto-pay ───────────────────────────────────────── */}
      <Card style={styles.panel}>
        <Text style={styles.panelTitle}>Subscription auto-pay</Text>
        <Text style={styles.panelSubtitle}>
          Choose whether LabTrax may charge your provider subscription
          automatically and select a charge day from 1 through 10.
        </Text>
        {subscription && (
          <>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Enable subscription auto-pay</Text>
              <Switch
                value={subscriptionEnabled}
                onValueChange={(value) =>
                  setSubscriptionDraft({
                    enabled: value,
                    chargeDay: subscriptionChargeDay,
                  })
                }
                disabled={subscriptionSaving}
                testID="provider-account-subscription-toggle"
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Charge day</Text>
              <TextInput
                value={subscriptionChargeDay}
                onChangeText={(text) =>
                  setSubscriptionDraft({ enabled: subscriptionEnabled, chargeDay: text })
                }
                keyboardType="number-pad"
                editable={!subscriptionSaving}
                style={[styles.input, styles.dayInput]}
                accessibilityLabel="Subscription charge day"
                testID="provider-account-subscription-day"
              />
            </View>
            <Text style={styles.helpText}>
              Payments are due by the 10th. When enabled, the subscription charge
              is attempted on your selected day.
            </Text>
            <Text
              style={styles.muted}
              testID="provider-account-subscription-authorization-state"
            >
              {authorization?.authorizationId
                ? "Signed authorization active"
                : "A signed authorization is required before charges can run."}
            </Text>
            {authorization?.updateCardRequired && (
              <Text style={styles.warningText} testID="provider-account-subscription-card-warning">
                Your saved card changed. Sign a new auto-pay authorization before
                the next charge can run.
              </Text>
            )}
            {authorization?.lastFailureReason && (
              <Text style={styles.warningText}>
                Last attempt failed: {authorization.lastFailureReason}
              </Text>
            )}
            {authorization?.nextRunAt && (
              <Text style={styles.muted} testID="provider-account-subscription-next-run">
                Next charge: {new Date(authorization.nextRunAt).toLocaleDateString()}
              </Text>
            )}
            {/* Signed here, where desktop signs it: the provider never leaves
                My Account for a screen built for the lab app. The card is the
                same component that screen renders, so there is one agreement
                UI, and signing re-reads the state line above. */}
            <View testID="provider-account-subscription-authorization">
              <ProviderAutoPayAuthorization
                providerOrganizationId={authorizationProviderId}
                labName={billing?.labs.length === 1 ? billing.labs[0].labName : null}
                onSubmitted={() => void billingQuery.refetch()}
              />
            </View>
            <Pressable
              onPress={() => void saveSubscription()}
              disabled={subscriptionSaving}
              accessibilityRole="button"
              style={[styles.primaryButton, subscriptionSaving && styles.disabled]}
              testID="provider-account-subscription-save"
            >
              <Text style={styles.primaryButtonText}>
                {subscriptionSaving ? "Saving…" : "Save subscription auto-pay"}
              </Text>
            </Pressable>
          </>
        )}
      </Card>

      {/* ── Account number (assigned by the lab) ────────────────────────── */}
      {accountNumber && (
        <Card style={styles.panel}>
          <Text style={styles.fieldLabel}>ACCOUNT NUMBER</Text>
          <Text style={styles.accountNumber} testID="provider-account-number">
            {accountNumber}
          </Text>
          <Text style={styles.helpText}>
            This number is assigned by your lab and cannot be changed.
          </Text>
        </Card>
      )}

      {/* ── The provider's own details ──────────────────────────────────── */}
      <Card style={styles.panel}>
        <Text style={styles.panelTitle}>Your details</Text>
        {!profileForm ? (
          me.isError ? (
            <Text style={styles.errorText} testID="provider-account-profile-error">
              Failed to load profile. Pull to refresh and try again.
            </Text>
          ) : (
            <Text style={styles.muted} testID="provider-account-profile-loading">
              Loading profile…
            </Text>
          )
        ) : (
          <View style={styles.fields}>
            {PROVIDER_PROFILE_FIELDS.map((field) => (
              <View key={field.key} style={styles.field}>
                <Text style={styles.fieldLabel}>{field.label}</Text>
                <TextInput
                  value={profileForm[field.key]}
                  onChangeText={(text) =>
                    setProfileForm((current) =>
                      current ? { ...current, [field.key]: text } : current,
                    )
                  }
                  placeholder={field.placeholder}
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize={field.key === "email" ? "none" : "sentences"}
                  keyboardType={field.keyboardType}
                  style={styles.input}
                  accessibilityLabel={field.label}
                  testID={`provider-account-profile-${field.key}`}
                />
              </View>
            ))}
            <Pressable
              onPress={() => void saveProfile()}
              disabled={profileSaving}
              accessibilityRole="button"
              style={[styles.primaryButton, profileSaving && styles.disabled]}
              testID="provider-account-profile-save"
            >
              <Text style={styles.primaryButtonText}>
                {profileSaving ? "Saving…" : "Save Changes"}
              </Text>
            </Pressable>
          </View>
        )}
      </Card>
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: colors.backgroundSolid },
    content: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.huge },
    intro: { gap: 2 },
    title: { ...Typography.h2, color: colors.text },
    subtitle: { ...Typography.caption, color: colors.textSecondary },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
    },
    noticeText: { ...Typography.caption, flex: 1 },
    panel: { gap: Spacing.md },
    panelTitle: { ...Typography.h3, color: colors.text },
    panelSubtitle: { ...Typography.caption, color: colors.textSecondary },
    loader: { marginVertical: Spacing.md },
    labBlock: {
      gap: Spacing.md,
      padding: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    labHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: Spacing.md,
    },
    labCopy: { flex: 1, gap: 2 },
    labName: { ...Typography.bodySemibold, color: colors.text },
    muted: { ...Typography.caption, color: colors.textSecondary },
    errorText: { ...Typography.caption, color: colors.error },
    warningText: { ...Typography.caption, color: colors.warning },
    helpText: { ...Typography.caption, color: colors.textSecondary },
    fields: { gap: Spacing.md },
    field: { gap: Spacing.xs },
    fieldLabel: { ...Typography.captionSemibold, color: colors.textSecondary },
    input: {
      ...Typography.body,
      color: colors.text,
      backgroundColor: colors.backgroundSolid,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    dayInput: { width: 96 },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
    },
    switchLabel: { ...Typography.body, color: colors.text, flex: 1 },
    accountNumber: {
      ...Typography.bodyLgMedium,
      color: colors.text,
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: colors.surfaceAlt ?? colors.backgroundSolid,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    primaryButton: {
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: colors.tint,
    },
    primaryButtonText: { ...Typography.captionSemibold, color: colors.textInverse },
    secondaryButton: {
      alignSelf: "flex-start",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    secondaryButtonText: { ...Typography.captionSemibold, color: colors.text },
    disabled: { opacity: 0.5 },
    history: {
      gap: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: Spacing.md,
    },
    historyTitle: { ...Typography.label, color: colors.textSecondary },
    historyRow: {
      gap: Spacing.xs,
      padding: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: colors.surfaceAlt ?? colors.backgroundSolid,
    },
    historyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
    },
    historyLabel: { ...Typography.captionSemibold, color: colors.text, flex: 1 },
    historyActions: { flexDirection: "row", gap: Spacing.xs },
    tinyButton: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    tinyButtonText: { ...Typography.caption, color: colors.text },
  });
}
