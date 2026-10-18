// Provider portal → View and Pay My Bill.
//
// The mobile mirror of the desktop ProviderBilling screen: the same
// outstanding summary, the same open-cases field set, the same open/past
// statement split with its filters and search, the same payment history
// filters, the same per-lab invoice auto-pay controls, and the same
// post-checkout outcomes including the re-check. Desktop is the reference —
// the figures, thresholds and wording come from it, and the shared rules live
// in lib/provider-portal-billing.ts so both the screen and its tests read the
// same logic.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  cancelProviderCheckout,
  clearPendingProviderCheckout,
  createProviderCheckout,
  getProviderBilling,
  getProviderCheckoutStatus,
  getProviderPaymentHistory,
  getProviderStatements,
  prepareProviderCheckoutAttempt,
  providerBillingReturnUrl,
  readPendingProviderCheckout,
  savePendingProviderCheckout,
  updateLabAutoPay,
  PROVIDER_BILLING_QUERY_KEY,
  PROVIDER_PAYMENT_HISTORY_QUERY_KEY,
  PROVIDER_STATEMENTS_QUERY_KEY,
  type ProviderCheckoutOrigin,
  type ProviderLabBilling,
  type ProviderStatement,
} from "@/lib/provider-billing";
import {
  autoPayDraftOf,
  filterPastStatements,
  filterPaymentHistory,
  formatCurrency,
  formatCurrencyNum,
  formatStatementDate,
  getProviderAccountBalances,
  getProviderPortalCases,
  isMultiLab,
  loadStatementInvoices,
  openCasesOf,
  parseAutoPayChargeDay,
  partitionStatements,
  payableAccountsOf,
  pastStatementsSearchFieldGuess,
  statusLabel,
  summarizeOutstanding,
  PAYMENT_METHOD_DISPLAY,
  PROVIDER_ACCOUNT_BALANCES_QUERY_KEY,
  PROVIDER_PORTAL_CASES_QUERY_KEY,
  type AutoPayDraft,
  type HistoryFilter,
  type PastStatementsFilter,
  type PayableProviderAccount,
  type PaymentHistoryRow,
  type ProviderPortalCase,
  type StatementInvoice,
} from "@/lib/provider-portal-billing";
import {
  consumeProviderCheckoutReturn,
  type ProviderCheckoutReturnSignal,
} from "@/lib/provider-checkout-return";
import { IN_APP_NOTIFICATIONS_QUERY_KEY } from "@/lib/in-app-notifications";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { PayMyBillSheet } from "../billing/PayMyBillSheet";
import { StatementCard } from "../billing/StatementCard";

type NoticeTone = "success" | "warning" | "danger";
type Notice = { tone: NoticeTone; message: string; checkoutId?: string };

const PAST_FILTERS: Array<{ key: PastStatementsFilter; label: string }> = [
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom" },
];

const HISTORY_FILTERS: Array<{ key: HistoryFilter; label: string }> = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "custom", label: "Custom" },
];

export function ProviderBillingSection({
  checkoutReturn = null,
  origin = "portal",
  header = null,
}: {
  /** A return from Stripe handed down by the portal shell, if one is waiting. */
  checkoutReturn?: ProviderCheckoutReturnSignal | null;
  /**
   * Which entry point is showing this section. Recorded with a checkout so a
   * Stripe return comes back to the surface that launched it instead of one
   * that may not even be mounted.
   */
  origin?: ProviderCheckoutOrigin;
  /**
   * Content rendered above the billing surface. The settings route puts the
   * panels that exist nowhere else (shared card, authorization, subscription
   * auto-pay) here rather than keeping a second copy of billing itself.
   */
  header?: React.ReactNode;
} = {}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const queryClient = useQueryClient();

  // ── Data ────────────────────────────────────────────────────────────────
  const statementsQuery = useQuery<ProviderStatement[]>({
    queryKey: PROVIDER_STATEMENTS_QUERY_KEY,
    queryFn: getProviderStatements,
    staleTime: 30_000,
  });
  const statements = statementsQuery.data ?? null;

  // Balances are per lab ↔ provider relationship, so the set of relationships
  // is part of the key: a statement list that gains a lab refetches instead of
  // serving a summary that silently omits it.
  const relationshipKey = useMemo(
    () =>
      (statements ?? [])
        .map((s) => `${s.labOrganizationId}:${s.providerOrganizationId}`)
        .sort()
        .join(","),
    [statements],
  );
  const balancesQuery = useQuery({
    queryKey: [...PROVIDER_ACCOUNT_BALANCES_QUERY_KEY, relationshipKey],
    queryFn: () => getProviderAccountBalances(statements ?? []),
    enabled: relationshipKey.length > 0,
    staleTime: 30_000,
  });

  const casesQuery = useQuery<ProviderPortalCase[]>({
    queryKey: PROVIDER_PORTAL_CASES_QUERY_KEY,
    queryFn: getProviderPortalCases,
    staleTime: 30_000,
  });
  const cases = casesQuery.data ?? null;

  const billingQuery = useQuery({
    queryKey: PROVIDER_BILLING_QUERY_KEY,
    queryFn: getProviderBilling,
    staleTime: 30_000,
  });

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyQuery = useQuery({
    queryKey: PROVIDER_PAYMENT_HISTORY_QUERY_KEY,
    queryFn: getProviderPaymentHistory,
    enabled: historyOpen,
    staleTime: 30_000,
  });

  // ── Derived, all by desktop's rules ─────────────────────────────────────
  const { open: displayedStatements, past: pastStatements } = useMemo(
    () => partitionStatements(statements),
    [statements],
  );
  const accountBalances = balancesQuery.data ?? [];
  const { totalOpenBalance, openCaseCount } = useMemo(
    () => summarizeOutstanding(accountBalances, cases),
    [accountBalances, cases],
  );
  // A relationship's balance spans every open statement it has, so paying it
  // in one checkout is not the same as paying the newest statement.
  const payableAccounts = useMemo(
    () => payableAccountsOf(accountBalances, statements),
    [accountBalances, statements],
  );
  const openCases = useMemo(() => openCasesOf(cases), [cases]);
  const multiLab = useMemo(() => isMultiLab(cases), [cases]);
  const autoPayLabs = useMemo(
    () => billingQuery.data?.labs ?? [],
    [billingQuery.data],
  );
  // The server refuses auto-pay writes outright when scheduling is not
  // available, so the controls say so instead of offering a save that 503s.
  const autoPaySchedulingAvailable =
    !billingQuery.isError && billingQuery.data?.capabilities.autoPayScheduling !== false;

  // ── Local UI state ──────────────────────────────────────────────────────
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [pastOpen, setPastOpen] = useState(false);
  const [pastFilter, setPastFilter] = useState<PastStatementsFilter>("this_year");
  const [pastFrom, setPastFrom] = useState("");
  const [pastTo, setPastTo] = useState("");
  const [pastSearch, setPastSearch] = useState("");

  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("this_month");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");

  const [payLoading, setPayLoading] = useState(false);
  const [fullBalanceLoading, setFullBalanceLoading] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [payStatement, setPayStatement] = useState<ProviderStatement | null>(null);
  const [payInvoices, setPayInvoices] = useState<StatementInvoice[]>([]);

  const [autoPayDrafts, setAutoPayDrafts] = useState<Record<string, AutoPayDraft>>({});
  const [autoPaySaving, setAutoPaySaving] = useState<string | null>(null);
  // What the server last confirmed per lab, kept alongside the drafts because
  // a refused save has to restore it. The loaded preferences are not a safe
  // substitute: the refetch after a successful save can resolve with pre-save
  // values, and reverting to those would understate the live schedule.
  const confirmedAutoPay = useRef<Record<string, AutoPayDraft>>({});

  const filteredPastStatements = useMemo(
    () =>
      filterPastStatements(pastStatements, {
        filter: pastFilter,
        customFrom: pastFrom,
        customTo: pastTo,
        search: pastSearch,
      }),
    [pastStatements, pastFilter, pastFrom, pastTo, pastSearch],
  );
  const filteredHistory = useMemo(
    () =>
      filterPaymentHistory(historyQuery.data, {
        filter: historyFilter,
        customFrom: historyFrom,
        customTo: historyTo,
      }),
    [historyQuery.data, historyFilter, historyFrom, historyTo],
  );

  // Seed an editable draft per lab once, so typing a charge day is not undone
  // by the next background refetch of the preferences.
  useEffect(() => {
    if (autoPayLabs.length === 0) return;
    setAutoPayDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const lab of autoPayLabs) {
        if (next[lab.providerOrganizationId]) continue;
        const seeded = autoPayDraftOf(lab.invoiceAutoPay);
        next[lab.providerOrganizationId] = seeded;
        // Seeded once, for the same reason the draft is: later reads can be
        // behind a save this screen already made.
        confirmedAutoPay.current[lab.providerOrganizationId] = seeded;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [autoPayLabs]);

  // ── Refreshing ──────────────────────────────────────────────────────────
  const refreshBilling = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PROVIDER_STATEMENTS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: PROVIDER_ACCOUNT_BALANCES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: PROVIDER_BILLING_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: PROVIDER_PAYMENT_HISTORY_QUERY_KEY }),
      // Case balances and the case detail both move when an invoice is paid.
      queryClient.invalidateQueries({ queryKey: ["provider-cases"] }),
      queryClient.invalidateQueries({ queryKey: ["provider-case"] }),
      // A provider who also works in the lab app sees the same money in the
      // lab case list and in a payment-due notification, so both follow the
      // balances rather than staying stale until the next cold start.
      queryClient.invalidateQueries({ queryKey: ["cases"] }),
      queryClient.invalidateQueries({ queryKey: IN_APP_NOTIFICATIONS_QUERY_KEY }),
    ]);
  }, [queryClient]);

  const onPullToRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshBilling();
    } finally {
      setRefreshing(false);
    }
  }, [refreshBilling]);

  // ── Returning from hosted checkout ──────────────────────────────────────
  // The provider leaves the app for Stripe, so nothing here trusts the return
  // itself: the recorded checkout is re-read from the server, and invoices are
  // only treated as paid when the server says they settled.
  // A single return can reach this from more than one place at once: the link
  // the portal hands down, the pending record read on mount, and the app
  // coming back to the foreground. Reconciling the same checkout twice would
  // cancel it twice, so whichever arrives first owns it until it finishes.
  const reconciling = useRef<string | null>(null);

  const checkCheckoutStatus = useCallback(
    async (checkoutId: string, options?: { cancelFirst?: boolean }) => {
      if (reconciling.current === checkoutId) return;
      reconciling.current = checkoutId;
      setNotice({
        tone: "warning",
        message: "Confirming your payment with Stripe…",
        checkoutId,
      });
      try {
        // Backing out of Stripe leaves the server-side checkout pending, which
        // both reads as "still confirming" and keeps the invoices reserved
        // against the next attempt. Desktop releases it before reading the
        // status, and so does this.
        if (options?.cancelFirst) await cancelProviderCheckout(checkoutId);
        const result = await getProviderCheckoutStatus(checkoutId);
        if (result.status === "succeeded") {
          await clearPendingProviderCheckout();
          await refreshBilling();
          setNotice({
            tone: "success",
            message: "Stripe confirmed your payment. Your balances are refreshed.",
          });
          return;
        }
        if (result.status === "pending") {
          setNotice({
            tone: "warning",
            message:
              "Stripe is still confirming this payment. No invoice has been marked paid yet.",
            checkoutId,
          });
          return;
        }
        await clearPendingProviderCheckout();
        if (result.status === "cancelled") {
          setNotice({
            tone: "warning",
            message: "Checkout was cancelled. No invoice was marked paid.",
          });
          return;
        }
        if (result.status === "expired") {
          setNotice({
            tone: "danger",
            message:
              "That checkout session expired. Refresh your balances before trying again.",
          });
          return;
        }
        setNotice({
          tone: "danger",
          message:
            result.failureReason === "stale_invoice_balance"
              ? "Your invoice balance changed before settlement. Refresh and try again."
              : "Stripe could not complete this payment. No invoice was marked paid.",
        });
      } catch (error) {
        setNotice({
          tone: "danger",
          message:
            error instanceof Error
              ? error.message
              : "Could not confirm the checkout result.",
          checkoutId,
        });
      } finally {
        reconciling.current = null;
      }
    },
    [refreshBilling],
  );

  const resumePendingCheckout = useCallback(async () => {
    const pending = await readPendingProviderCheckout().catch(() => null);
    if (!pending?.checkoutId) return;
    // A cancelled return recorded before the app was relaunched is still
    // waiting to be released, so resuming has to honour it too.
    await checkCheckoutStatus(pending.checkoutId, {
      cancelFirst: pending.cancelRequested === true,
    });
  }, [checkCheckoutStatus]);

  useEffect(() => {
    void resumePendingCheckout();
  }, [resumePendingCheckout]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void resumePendingCheckout();
    });
    return () => subscription.remove();
  }, [resumePendingCheckout]);

  // The return link itself: the portal hands it down, and it carries whether
  // the provider came back through Stripe's cancel URL.
  useEffect(() => {
    if (!checkoutReturn) return;
    const { token, cancelled, checkoutId: returnedCheckoutId } = checkoutReturn;
    void (async () => {
      const pending = await readPendingProviderCheckout().catch(() => null);
      const checkoutId = returnedCheckoutId ?? pending?.checkoutId ?? null;
      consumeProviderCheckoutReturn(token);
      if (!checkoutId) return;
      await checkCheckoutStatus(checkoutId, {
        cancelFirst: cancelled || pending?.cancelRequested === true,
      });
    })();
  }, [checkoutReturn, checkCheckoutStatus]);

  // ── Pay My Bill ─────────────────────────────────────────────────────────
  const startPayment = useCallback(async (statement: ProviderStatement) => {
    setPayLoading(true);
    setPayError(null);
    // Closed while loading, so the sheet can never be interacted with before
    // it knows every invoice it is paying.
    setPayStatement(null);
    try {
      // All-or-nothing: one failed invoice means no payment flow at all,
      // because paying against a partial set silently underpays the statement.
      const invoices = await loadStatementInvoices(statement.id);
      setPayInvoices(invoices);
      // The statement is captured here rather than read back out of the list,
      // so a refresh that moves it into Past Statements cannot unmount the
      // open sheet.
      setPayStatement(statement);
    } catch (error) {
      setPayError(
        error instanceof Error
          ? `Could not load invoices: ${error.message}`
          : "Could not load invoices. Please try again.",
      );
    } finally {
      setPayLoading(false);
    }
  }, []);

  // ── Pay the whole account balance ───────────────────────────────────────
  // One checkout for everything a lab relationship owes, across every open
  // statement. The server resolves which invoices that is ("full" mode), so
  // nothing here can underpay by working from a stale statement list.
  const startAccountPayment = useCallback(
    async (account: PayableProviderAccount) => {
      if (fullBalanceLoading) return;
      setFullBalanceLoading(account.providerOrganizationId);
      setPayError(null);
      try {
        // Recorded before the request so a crash (or a second tap) resumes the
        // same checkout instead of starting a second charge.
        const attempt = await prepareProviderCheckoutAttempt({
          mode: "full",
          providerOrganizationId: account.providerOrganizationId,
          // Stripe's return link cannot say which billing surface it came
          // from, so the launching surface records itself here.
          origin,
        });
        const checkout = await createProviderCheckout({
          mode: "full",
          providerOrganizationId: account.providerOrganizationId,
          savePaymentMethod: false,
          idempotencyKey: attempt.idempotencyKey,
          successUrl: providerBillingReturnUrl(),
          cancelUrl: providerBillingReturnUrl(true),
        });
        if (checkout.status === "succeeded") {
          await refreshBilling();
          setNotice({
            tone: "success",
            message: "Stripe confirmed your payment. Your balances are refreshed.",
          });
          return;
        }
        if (!checkout.url) {
          throw new Error(
            checkout.status === "pending"
              ? "Checkout is still being prepared. Please try again."
              : "This checkout is no longer available. Refresh your balance before retrying.",
          );
        }
        await savePendingProviderCheckout({ ...attempt, checkoutId: checkout.checkoutId });
        const supported = await Linking.canOpenURL(checkout.url);
        if (!supported) throw new Error("Your device cannot open the secure checkout page.");
        await Linking.openURL(checkout.url);
        setNotice({
          tone: "warning",
          message:
            "Stripe is still confirming this payment. No invoice has been marked paid yet.",
          checkoutId: checkout.checkoutId,
        });
      } catch (error) {
        setPayError(
          error instanceof Error
            ? error.message
            : "Could not start secure card checkout. Please try again.",
        );
      } finally {
        setFullBalanceLoading(null);
      }
    },
    [fullBalanceLoading, origin, refreshBilling],
  );

  // ── Auto-pay ────────────────────────────────────────────────────────────
  async function saveLabAutoPay(lab: ProviderLabBilling) {
    if (autoPaySaving !== null) return;
    const draft = autoPayDrafts[lab.providerOrganizationId] ?? autoPayDraftOf(lab.invoiceAutoPay);
    const parsed = parseAutoPayChargeDay(draft.chargeDay);
    if (!parsed.ok) {
      setNotice({ tone: "danger", message: parsed.message });
      return;
    }
    setAutoPaySaving(lab.providerOrganizationId);
    try {
      const saved = await updateLabAutoPay(lab.providerOrganizationId, {
        enabled: draft.enabled,
        // Never substitute a default day when switching off: a day the
        // provider did not sign for would need a fresh authorization.
        chargeDay: draft.enabled ? parsed.chargeDay : null,
      });
      const confirmed = autoPayDraftOf(saved);
      confirmedAutoPay.current[lab.providerOrganizationId] = confirmed;
      setAutoPayDrafts((prev) => ({
        ...prev,
        [lab.providerOrganizationId]: confirmed,
      }));
      await queryClient.invalidateQueries({ queryKey: PROVIDER_BILLING_QUERY_KEY });
      setNotice({
        tone: "success",
        message: `${lab.labName ?? "Lab"} invoice auto-pay preference saved.`,
      });
    } catch (error) {
      // A rejected save changed nothing on the server, so the controls go back
      // to the preference it last confirmed. Leaving the requested toggle on
      // would read as an active schedule the lab will never charge against.
      setAutoPayDrafts((prev) => ({
        ...prev,
        [lab.providerOrganizationId]:
          confirmedAutoPay.current[lab.providerOrganizationId] ??
          autoPayDraftOf(lab.invoiceAutoPay),
      }));
      setNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Could not save invoice auto-pay. Please try again.",
      });
    } finally {
      setAutoPaySaving(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const noticeStyle = notice ? noticeColors(colors, notice.tone) : null;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="provider-portal-section-billing"
      keyboardDismissMode={scrollKeyboardDismissMode}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onPullToRefresh()} />
      }
    >
      {header}

      <View style={styles.headerBlock}>
        <Text style={styles.screenTitle}>View and Pay My Bill</Text>
        <Text style={styles.screenSubtitle}>
          Your recent billing statements from the lab
        </Text>
      </View>

      {notice && noticeStyle ? (
        <View
          accessibilityRole="alert"
          testID="provider-portal-billing-notice"
          style={[
            styles.notice,
            { backgroundColor: noticeStyle.background, borderColor: noticeStyle.border },
          ]}
        >
          <Text style={[styles.noticeText, { color: noticeStyle.text }]}>
            {notice.message}
          </Text>
          {notice.checkoutId && notice.tone !== "success" ? (
            <Pressable
              onPress={() => void checkCheckoutStatus(notice.checkoutId!)}
              accessibilityRole="button"
              testID="provider-portal-recheck-payment"
              style={[styles.noticeButton, { borderColor: noticeStyle.text }]}
            >
              <Text style={[styles.noticeButtonText, { color: noticeStyle.text }]}>
                Check payment status again
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* ── Invoice auto-pay by lab ── */}
      {autoPayLabs.length > 0 ? (
        <View style={styles.panel} testID="provider-portal-autopay">
          <Text style={styles.panelTitle}>Invoice auto-pay by lab</Text>
          <Text style={styles.panelSubtitle}>
            Each linked lab is controlled independently. When enabled, the full current
            balance for that lab is charged on your selected day. Payments are due by the
            10th.
          </Text>
          {!autoPaySchedulingAvailable ? (
            <Text style={styles.metaAlert} testID="provider-portal-autopay-unavailable">
              Automatic payment scheduling is not available yet. You can still pay
              securely below.
            </Text>
          ) : null}
          {autoPayLabs.map((lab) => {
            const draft =
              autoPayDrafts[lab.providerOrganizationId] ?? autoPayDraftOf(lab.invoiceAutoPay);
            const authorization = lab.invoiceAutoPay.authorization;
            const saving = autoPaySaving === lab.providerOrganizationId;
            const locked = autoPaySaving !== null || !autoPaySchedulingAvailable;
            return (
              <View
                key={lab.providerOrganizationId}
                style={styles.autoPayRow}
                testID={`provider-portal-autopay-${lab.providerOrganizationId}`}
              >
                <Text style={styles.autoPayLab}>{lab.labName ?? "Linked lab"}</Text>
                <Text style={styles.meta}>
                  Full current lab balance on day {draft.chargeDay || "—"}
                </Text>
                <Text style={styles.meta}>
                  {authorization?.authorizationId
                    ? `Signed authorization active${
                        authorization.nextRunAt
                          ? ` · Next run ${formatStatementDate(authorization.nextRunAt)}`
                          : ""
                      }`
                    : "Signed authorization required before charges can run"}
                </Text>
                {authorization?.lastResult ? (
                  <Text
                    style={authorization.updateCardRequired ? styles.metaAlert : styles.meta}
                  >
                    {`Last result: ${statusLabel(authorization.lastResult)}`}
                    {authorization.lastFailureReason
                      ? ` · ${authorization.lastFailureReason}`
                      : ""}
                    {authorization.updateCardRequired ? " · Update card required" : ""}
                  </Text>
                ) : null}
                {!lab.card.hasCard && !lab.invoiceAutoPay.enabled ? (
                  <Text
                    style={styles.metaAlert}
                    testID={`provider-portal-autopay-needs-card-${lab.providerOrganizationId}`}
                  >
                    Add a shared card before enabling auto-pay.
                  </Text>
                ) : null}
                <View style={styles.autoPayControls}>
                  <View style={styles.autoPayToggle}>
                    <Switch
                      value={draft.enabled}
                      disabled={locked}
                      onValueChange={(value) =>
                        setAutoPayDrafts((prev) => ({
                          ...prev,
                          [lab.providerOrganizationId]: { ...draft, enabled: value },
                        }))
                      }
                      accessibilityLabel={`Enable invoice auto-pay for ${lab.labName ?? "linked lab"}`}
                      testID={`provider-portal-autopay-enable-${lab.providerOrganizationId}`}
                    />
                    <Text style={styles.autoPayToggleLabel}>Enable</Text>
                  </View>
                  <View style={styles.autoPayDay}>
                    <Text style={styles.autoPayToggleLabel}>Day</Text>
                    <TextInput
                      value={draft.chargeDay}
                      onChangeText={(value) =>
                        setAutoPayDrafts((prev) => ({
                          ...prev,
                          [lab.providerOrganizationId]: { ...draft, chargeDay: value },
                        }))
                      }
                      editable={!locked}
                      keyboardType="number-pad"
                      maxLength={2}
                      accessibilityLabel={`Charge day for ${lab.labName ?? "linked lab"}`}
                      testID={`provider-portal-autopay-day-${lab.providerOrganizationId}`}
                      style={styles.dayInput}
                    />
                  </View>
                  <Pressable
                    onPress={() => void saveLabAutoPay(lab)}
                    disabled={locked}
                    accessibilityRole="button"
                    testID={`provider-portal-autopay-save-${lab.providerOrganizationId}`}
                    style={[
                      styles.smallButton,
                      {
                        backgroundColor: colors.tint,
                        opacity: locked ? 0.5 : 1,
                      },
                    ]}
                  >
                    <Text style={styles.smallButtonText}>
                      {saving ? "Saving…" : "Save"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* ── Outstanding balance summary ── */}
      {!casesQuery.isError && cases !== null ? (
        <View style={styles.panel} testID="provider-portal-billing-summary">
          <View style={styles.summaryRow}>
            <View style={styles.summaryFigure}>
              <Text style={styles.summaryLabel}>TOTAL OUTSTANDING</Text>
              <Text
                style={openCaseCount === 0 ? styles.summaryValueMuted : styles.summaryValue}
                testID="provider-portal-total-outstanding"
              >
                {openCaseCount === 0 ? "$0.00" : formatCurrency(totalOpenBalance)}
              </Text>
            </View>
            <View style={styles.summaryFigure}>
              <Text style={styles.summaryLabel}>OPEN CASES</Text>
              <Text style={styles.summaryValue} testID="provider-portal-open-case-count">
                {openCaseCount}
              </Text>
            </View>
          </View>
          {openCaseCount === 0 ? (
            <Text style={styles.caughtUp}>
              No outstanding balances. You&apos;re all caught up!
            </Text>
          ) : null}
          {displayedStatements.length > 0 || payableAccounts.length > 0 ? (
            <View style={styles.payBlock}>
              {displayedStatements.length > 0 ? (
                <Pressable
                  onPress={() => void startPayment(displayedStatements[0]!)}
                  disabled={payLoading || fullBalanceLoading !== null}
                  accessibilityRole="button"
                  testID="provider-portal-pay-my-bill-button"
                  style={[
                    styles.primaryButton,
                    {
                      backgroundColor: colors.tint,
                      opacity: payLoading || fullBalanceLoading !== null ? 0.6 : 1,
                    },
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {payLoading ? "Loading…" : "Pay My Bill"}
                  </Text>
                </Pressable>
              ) : null}
              {/* Everything a lab relationship owes, in one checkout — a
                  provider with several open statements does not have to pay
                  them one at a time. */}
              {payableAccounts.map((account) => {
                const busy = fullBalanceLoading === account.providerOrganizationId;
                const disabled = payLoading || fullBalanceLoading !== null;
                return (
                  <Pressable
                    key={account.providerOrganizationId}
                    onPress={() => void startAccountPayment(account)}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`Pay the full balance for ${account.labName ?? "your provider account"}`}
                    testID={`provider-portal-pay-full-balance-${account.providerOrganizationId}`}
                    style={[
                      styles.secondaryButton,
                      { borderColor: colors.tint, opacity: disabled ? 0.6 : 1 },
                    ]}
                  >
                    <Text style={[styles.secondaryButtonText, { color: colors.tint }]}>
                      {busy
                        ? "Starting…"
                        : payableAccounts.length > 1
                          ? `Pay Full Balance · ${account.labName ?? "Linked lab"} (${formatCurrencyNum(account.currentBalance)})`
                          : `Pay Full Balance (${formatCurrencyNum(account.currentBalance)})`}
                    </Text>
                  </Pressable>
                );
              })}
              {payError ? (
                <Text style={styles.error} testID="provider-portal-pay-my-bill-error">
                  {payError}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* ── Open cases ── */}
      <View style={styles.sectionHeaderBlock}>
        <Text style={styles.sectionTitle}>Open Cases</Text>
        <Text style={styles.screenSubtitle}>Cases with outstanding invoice balances</Text>
      </View>

      {casesQuery.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorBoxText}>
            {casesQuery.error instanceof Error
              ? casesQuery.error.message
              : "Could not load your cases."}
          </Text>
        </View>
      ) : cases === null ? (
        <Text style={styles.meta}>Loading cases…</Text>
      ) : openCases.length === 0 ? (
        <Text style={styles.emptyLine} testID="provider-portal-open-cases-empty">
          {cases.length === 0
            ? "You have no assigned cases yet."
            : "No cases with outstanding balances."}
        </Text>
      ) : (
        <View style={styles.list} testID="provider-portal-open-cases">
          {openCases.map((c) => {
            const patient =
              c.patientFirstName || c.patientLastName
                ? `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim()
                : (c.patientName ?? "—");
            return (
              <Pressable
                key={c.id}
                onPress={() =>
                  router.push({
                    pathname: "/case/provider/[id]",
                    params: { id: c.id, invoice: "1" },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`Open invoice for case ${c.caseNumber ?? c.id}`}
                testID={`provider-portal-open-case-${c.id}`}
                style={styles.caseRow}
              >
                <View style={styles.caseCopy}>
                  <Text style={styles.caseNumber}>{c.caseNumber ?? "—"}</Text>
                  <Text style={styles.casePatient}>{patient}</Text>
                  <Text style={styles.meta}>
                    {c.restorationTypes ?? "—"} · {statusLabel(c.status ?? "")}
                  </Text>
                  <Text style={styles.meta}>
                    Due {formatStatementDate(c.dueDate)}
                    {multiLab ? ` · ${c.labName ?? "—"}` : ""}
                  </Text>
                </View>
                <View style={styles.caseAmountBlock}>
                  <Text style={styles.caseAmount}>
                    {formatCurrencyNum(c.openInvoiceAmount)}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* ── Statements ── */}
      {statementsQuery.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorBoxText}>
            {statementsQuery.error instanceof Error
              ? statementsQuery.error.message
              : "Could not load your statements."}
          </Text>
        </View>
      ) : statements === null ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.tint} />
          <Text style={styles.meta}>Loading statements…</Text>
        </View>
      ) : statements.length === 0 ? (
        <View style={styles.emptyBox} testID="provider-portal-statements-empty">
          <Text style={styles.emptyTitle}>No statements yet</Text>
          <Text style={styles.meta}>
            Your billing statements will appear here once the lab has generated them.
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          <Text style={styles.meta}>
            Showing open and unpaid items — see Past Statements below for paid bills
          </Text>
          {displayedStatements.length === 0 ? (
            <View style={styles.emptyBox} testID="provider-portal-statements-all-paid">
              <Text style={styles.emptyTitle}>All paid up</Text>
              <Text style={styles.meta}>
                No outstanding statements — you have no balance due.
              </Text>
            </View>
          ) : (
            displayedStatements.map((s) => (
              <StatementCard
                key={s.id}
                statement={s}
                onPay={(statement) => void startPayment(statement)}
                payPending={payLoading}
                testID={`provider-portal-statement-${s.id}`}
              />
            ))
          )}

          {/* ── Past Statements ── */}
          {pastStatements.length > 0 ? (
            <View style={styles.collapsible}>
              <Pressable
                onPress={() => setPastOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: pastOpen }}
                testID="past-statements-toggle"
                style={styles.collapsibleHeader}
              >
                <View style={styles.collapsibleCopy}>
                  <Text style={styles.sectionTitle}>Past Statements</Text>
                  <Text style={styles.meta}>
                    {pastStatements.length} paid{" "}
                    {pastStatements.length === 1 ? "statement" : "statements"}
                  </Text>
                </View>
                <Ionicons
                  name={pastOpen ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={colors.textSecondary}
                />
              </Pressable>

              {pastOpen ? (
                <View style={styles.list}>
                  <View style={styles.chipRow} testID="past-statements-filter">
                    {PAST_FILTERS.map(({ key, label }) => (
                      <FilterChip
                        key={key}
                        label={label}
                        active={pastFilter === key}
                        onPress={() => setPastFilter(key)}
                        testID={`past-statements-filter-${key}`}
                        colors={colors}
                        styles={styles}
                      />
                    ))}
                  </View>
                  {pastFilter === "custom" ? (
                    <View style={styles.dateRow}>
                      <TextInput
                        value={pastFrom}
                        onChangeText={setPastFrom}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor={colors.textTertiary}
                        accessibilityLabel="Past statements from date"
                        testID="past-statements-from"
                        style={styles.dateInput}
                      />
                      <Text style={styles.meta}>to</Text>
                      <TextInput
                        value={pastTo}
                        onChangeText={setPastTo}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor={colors.textTertiary}
                        accessibilityLabel="Past statements to date"
                        testID="past-statements-to"
                        style={styles.dateInput}
                      />
                    </View>
                  ) : null}
                  <TextInput
                    value={pastSearch}
                    onChangeText={setPastSearch}
                    placeholder="Search by lab name, statement date, or invoice count…"
                    placeholderTextColor={colors.textTertiary}
                    accessibilityLabel="Search past statements by lab name, statement date, or invoice count"
                    testID="past-statements-lab-search"
                    style={styles.searchInput}
                  />
                  {filteredPastStatements.length === 0 ? (
                    <View style={styles.emptyBox} testID="past-statements-empty">
                      <Text style={styles.emptyTitle}>
                        {pastSearch.trim()
                          ? pastStatementsSearchFieldGuess(pastSearch) === "invoiceCount"
                            ? "No statements match that invoice count"
                            : pastStatementsSearchFieldGuess(pastSearch) === "date"
                              ? "No statements match that date"
                              : "No statements match that lab name"
                          : "No statements in this period"}
                      </Text>
                      <Text style={styles.meta}>
                        {pastSearch.trim()
                          ? "Try a different search term or clear the search box."
                          : "Try a different date range or select \u201cCustom\u201d to search a specific window."}
                      </Text>
                    </View>
                  ) : (
                    filteredPastStatements.map((s) => (
                      <StatementCard
                        key={s.id}
                        statement={s}
                        readOnly
                        testID={`provider-portal-past-statement-${s.id}`}
                      />
                    ))
                  )}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      )}

      {/* ── Payment history ── */}
      <View style={styles.collapsible}>
        <Pressable
          onPress={() => setHistoryOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: historyOpen }}
          testID="payment-history-toggle"
          style={styles.collapsibleHeader}
        >
          <Text style={styles.sectionTitle}>Payment History</Text>
          <Ionicons
            name={historyOpen ? "chevron-up" : "chevron-down"}
            size={18}
            color={colors.textSecondary}
          />
        </Pressable>

        {historyOpen ? (
          <View style={styles.list}>
            <View style={styles.chipRow} testID="payment-history-filter">
              {HISTORY_FILTERS.map(({ key, label }) => (
                <FilterChip
                  key={key}
                  label={label}
                  active={historyFilter === key}
                  onPress={() => setHistoryFilter(key)}
                  testID={`payment-history-filter-${key}`}
                  colors={colors}
                  styles={styles}
                />
              ))}
            </View>
            {historyFilter === "custom" ? (
              <View style={styles.dateRow}>
                <TextInput
                  value={historyFrom}
                  onChangeText={setHistoryFrom}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textTertiary}
                  accessibilityLabel="From date"
                  testID="payment-history-from"
                  style={styles.dateInput}
                />
                <Text style={styles.meta}>to</Text>
                <TextInput
                  value={historyTo}
                  onChangeText={setHistoryTo}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textTertiary}
                  accessibilityLabel="To date"
                  testID="payment-history-to"
                  style={styles.dateInput}
                />
              </View>
            ) : null}

            {historyQuery.isError ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorBoxText}>
                  {historyQuery.error instanceof Error
                    ? historyQuery.error.message
                    : "Could not load your payment history."}
                </Text>
              </View>
            ) : historyQuery.data === undefined ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={colors.tint} />
                <Text style={styles.meta}>Loading payments…</Text>
              </View>
            ) : filteredHistory.length === 0 ? (
              <Text style={styles.emptyLine} testID="payment-history-empty">
                No payments in this period
              </Text>
            ) : (
              <View testID="payment-history-rows">
                {filteredHistory.map((payment) => (
                  <View
                    key={payment.id}
                    style={styles.historyRow}
                    testID={`payment-history-row-${payment.id}`}
                  >
                    <View style={styles.historyCopy}>
                      <Text style={styles.historyInvoice}>
                        {payment.invoiceNumber ?? "—"}
                      </Text>
                      <Text style={styles.meta}>{payment.patientName ?? "—"}</Text>
                      <Text style={styles.meta}>
                        {formatStatementDate(payment.paidAt)} ·{" "}
                        {payment.paymentMethod
                          ? (PAYMENT_METHOD_DISPLAY[payment.paymentMethod] ??
                            payment.paymentMethod)
                          : "—"}
                        {payment.referenceNumber ? ` · ${payment.referenceNumber}` : ""}
                      </Text>
                    </View>
                    <Text style={styles.historyAmount}>
                      {formatCurrency(payment.amount)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        ) : null}
      </View>

      {payStatement ? (
        <PayMyBillSheet
          key={payStatement.id}
          statement={payStatement}
          invoices={payInvoices}
          card={billingQuery.data?.card ?? null}
          origin={origin}
          onClose={() => setPayStatement(null)}
          onSettled={() => {
            void refreshBilling();
            setNotice({
              tone: "success",
              message: "Stripe confirmed your payment. Your balances are refreshed.",
            });
          }}
          onLaunched={(checkoutId) => {
            setPayStatement(null);
            setNotice({
              tone: "warning",
              message:
                "Stripe is still confirming this payment. No invoice has been marked paid yet.",
              checkoutId,
            });
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function FilterChip({
  label,
  active,
  onPress,
  testID,
  colors,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      testID={testID}
      style={[
        styles.chip,
        {
          borderColor: active ? colors.tint : colors.border,
          backgroundColor: active ? colors.tint : "transparent",
        },
      ]}
    >
      <Text style={[styles.chipText, { color: active ? "#fff" : colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function noticeColors(c: ThemeColors, tone: NoticeTone) {
  if (tone === "success") {
    return { background: c.successLight, border: c.success, text: c.success };
  }
  if (tone === "warning") {
    return { background: c.warningLight, border: c.warning, text: c.warning };
  }
  return { background: c.errorLight, border: c.error, text: c.error };
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    content: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.huge },
    headerBlock: { gap: 2 },
    screenTitle: { ...Typography.h2, color: c.text },
    screenSubtitle: { ...Typography.caption, color: c.textSecondary },
    sectionHeaderBlock: { gap: 2 },
    sectionTitle: { ...Typography.bodySemibold, color: c.text },
    notice: {
      borderWidth: 1,
      borderRadius: Radius.md,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    noticeText: { ...Typography.caption, lineHeight: 18 },
    noticeButton: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      minHeight: 32,
      justifyContent: "center",
    },
    noticeButtonText: { ...Typography.captionSemibold },
    panel: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      padding: Spacing.lg,
      gap: Spacing.sm,
    },
    panelTitle: { ...Typography.bodySemibold, color: c.text },
    panelSubtitle: { ...Typography.caption, color: c.textSecondary, lineHeight: 18 },
    meta: { ...Typography.caption, color: c.textSecondary },
    metaAlert: { ...Typography.caption, color: c.error },
    autoPayRow: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      padding: Spacing.md,
      gap: Spacing.xs,
    },
    autoPayLab: { ...Typography.bodyMedium, color: c.text },
    autoPayControls: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: Spacing.md,
      marginTop: Spacing.sm,
    },
    autoPayToggle: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    autoPayToggleLabel: { ...Typography.caption, color: c.text },
    autoPayDay: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    dayInput: {
      width: 56,
      minHeight: 40,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      color: c.text,
      ...Typography.body,
      textAlign: "center",
    },
    smallButton: {
      minHeight: 40,
      paddingHorizontal: Spacing.lg,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    smallButtonText: { ...Typography.captionSemibold, color: "#fff" },
    summaryRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xxl },
    summaryFigure: { gap: Spacing.xs },
    summaryLabel: { ...Typography.label, color: c.textSecondary },
    summaryValue: { ...Typography.display, color: c.text },
    summaryValueMuted: { ...Typography.display, color: c.textSecondary },
    caughtUp: { ...Typography.body, color: c.textSecondary },
    payBlock: { gap: Spacing.xs, marginTop: Spacing.sm },
    primaryButton: {
      minHeight: 48,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.lg,
    },
    primaryButtonText: { ...Typography.bodySemibold, color: "#fff" },
    secondaryButton: {
      minHeight: 48,
      borderRadius: Radius.md,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.lg,
    },
    secondaryButtonText: { ...Typography.bodySemibold },
    error: { ...Typography.caption, color: c.error },
    errorBox: {
      borderWidth: 1,
      borderColor: c.error,
      backgroundColor: c.errorLight,
      borderRadius: Radius.md,
      padding: Spacing.md,
    },
    errorBoxText: { ...Typography.caption, color: c.error },
    list: { gap: Spacing.sm },
    emptyLine: {
      ...Typography.caption,
      color: c.textSecondary,
      textAlign: "center",
      paddingVertical: Spacing.lg,
    },
    emptyBox: {
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: c.border,
      borderRadius: Radius.md,
      padding: Spacing.lg,
      alignItems: "center",
      gap: Spacing.xs,
    },
    emptyTitle: { ...Typography.bodySemibold, color: c.text, textAlign: "center" },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    caseRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      minHeight: 64,
      padding: Spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
    },
    caseCopy: { flex: 1, gap: 2 },
    caseNumber: { ...Typography.captionSemibold, color: c.textSecondary },
    casePatient: { ...Typography.bodyMedium, color: c.text },
    caseAmountBlock: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    caseAmount: { ...Typography.bodySemibold, color: c.text },
    collapsible: { gap: Spacing.sm },
    collapsibleHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
      minHeight: 44,
    },
    collapsibleCopy: { flex: 1, gap: 2 },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
    chip: {
      borderWidth: 1,
      borderRadius: Radius.full,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      minHeight: 36,
      justifyContent: "center",
    },
    chipText: { ...Typography.captionSemibold },
    dateRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    dateInput: {
      flex: 1,
      minHeight: 40,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      color: c.text,
      ...Typography.caption,
    },
    searchInput: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      color: c.text,
      ...Typography.body,
    },
    historyRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    historyCopy: { flex: 1, gap: 2 },
    historyInvoice: { ...Typography.bodyMedium, color: c.text },
    historyAmount: { ...Typography.bodySemibold, color: c.text },
  });
}
