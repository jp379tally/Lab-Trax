import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Card } from "@/components/ui/Card";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { FormSheet } from "@/components/ui/FormSheet";
import { ApiError, getJson, isForbiddenError, sendJson } from "@/lib/read-api";
import { trackSavedCardSetup } from "@/lib/saved-card-analytics";
import { canAdminAnyLab, primaryAdminLabOrgId, useMe } from "@/lib/auth-me";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { formatDate, formatMoney } from "@/lib/format";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { downloadAttachmentToLocalFile, shareLocalFile } from "@/lib/open-attachment";
import type { ReceivePaymentsInputPaymentMethod } from "@workspace/api-client-react";
import { IN_APP_NOTIFICATIONS_QUERY_KEY } from "@/lib/in-app-notifications";
import { refreshCaseFinanceQueries } from "@/lib/refresh-case-finance";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_PAYMENT_HISTORY_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
  providerBillingReturnUrl,
} from "@/lib/provider-billing";
import {
  AddressCollectionMode,
  CollectionMode,
  initStripe,
  useStripe,
} from "@/lib/stripe-payment-sheet";

const AUTOMATIC_CARD_ATTEMPT_MESSAGE =
  "Stripe is still confirming a prior card attempt. The invoice remains reserved while automatic reconciliation runs. Do not submit another charge.";
const SUPPORT_CARD_ATTEMPT_MESSAGE =
  "A prior card attempt has an uncertain processor outcome. Support review is required before this invoice can be charged. Do not submit another charge.";

type PaymentMethod = ReceivePaymentsInputPaymentMethod;
type MaybeNumber = string | number | null | undefined;

interface Invoice {
  id: string;
  invoiceNumber: string;
  doctorProfileId?: string | null;
  doctorName?: string | null;
  patientName?: string | null;
  /** Historical issued-statement value in statement detail responses. */
  status?: string | null;
  /** Historical issued-statement value in statement detail responses. */
  issuedAt?: string | null;
  /** Historical issued-statement value in statement detail responses. */
  dueAt?: string | null;
  total?: MaybeNumber;
  /** Live settlement value, even when other fields are historical. */
  currentBalanceDue?: MaybeNumber;
  /** Live payment rule, even when other fields are historical. */
  eligibleForPayment?: boolean;
  detailProvenance?: "snapshot" | "live" | "unavailable";
}

interface DoctorProfile {
  id: string;
  doctorName: string;
  doctorDisplayName: string;
}

interface EligibleAccount {
  providerOrganizationId: string;
  doctorProfiles: DoctorProfile[];
  outstandingInvoices: Invoice[];
  currentBalanceDue?: MaybeNumber;
}

interface DoctorIdentityRepairLog {
  id: string;
  createdAt: string;
  userId?: string | null;
  actorUsername?: string | null;
  actorFirstName?: string | null;
  actorLastName?: string | null;
  actorInitials?: string | null;
  beforeJson?: { doctorDisplayName?: string | null } | null;
  afterJson?: { doctorDisplayName?: string | null } | null;
}

interface InvoiceDetail extends Invoice {
  doctorIdentityRepairLogs?: DoctorIdentityRepairLog[];
}

interface Statement {
  id: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  invoiceCount?: number | null;
  savedBalanceDue?: MaybeNumber;
  totalBilled?: MaybeNumber;
  hasInvoiceDetailSnapshots?: boolean;
  detailProvenance?: "snapshot" | "live" | "mixed";
}

interface StatementContext extends Statement {
  labOrganizationId: string;
  providerOrganizationId: string;
  invoices: Invoice[];
}

interface Provider {
  id: string;
  name: string;
  billingEmail?: string | null;
}

interface PaymentDraft {
  idempotencyKey: string;
  statementId: string;
  receivedAmount: string;
  existingCreditAmount: string;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  checkNumber: string;
  cardLast4: string;
  cardChoice: "saved" | "new";
  saveCard: boolean;
  memo: string;
  customerEmail: string;
  applications: Record<string, string>;
}

interface ReceiptSession {
  id: string;
  receiptNumber?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  receivedAmount?: MaybeNumber;
  appliedAmount?: MaybeNumber;
  customerCreditAmount?: MaybeNumber;
  status?: string | null;
  reversal?: {
    status: "pending" | "completed" | "failed";
    reason?: string | null;
  } | null;
}
type LegacyReceiptSessionResponse = { paymentSession?: ReceiptSession & { reversal?: { status: "pending" | "completed" | "failed"; failureReason?: string | null } | null } };

function receiptSessionFromResponse(response: ReceiptSession | LegacyReceiptSessionResponse): ReceiptSession {
  const session = "paymentSession" in response && response.paymentSession ? response.paymentSession : response as ReceiptSession;
  const reversal = session.reversal;
  return reversal && "failureReason" in reversal
    ? { ...session, reversal: { status: reversal.status, reason: typeof reversal.failureReason === "string" ? reversal.failureReason : null } }
    : session;
}
export function paymentErrorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.body &&
    typeof error.body === "object" &&
    "details" in error.body &&
    error.body.details &&
    typeof error.body.details === "object" &&
    (error.body.details as { code?: unknown }).code === "CARD_PAYMENT_ATTEMPT_BLOCKED"
  ) {
    const nextStep = (error.body.details as {
      nextStep?: "automatic_reconciliation" | "support_review";
    }).nextStep;
    return nextStep === "automatic_reconciliation"
      ? AUTOMATIC_CARD_ATTEMPT_MESSAGE
      : SUPPORT_CARD_ATTEMPT_MESSAGE;
  }
  return error instanceof Error ? error.message : "Payment could not be completed.";
}

const METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "check", label: "Check" },
  { value: "card", label: "Card" },
  { value: "ach", label: "ACH" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];
const RECEIVE_CARD_SETUP_KEY = "labtrax_receive_payment_card_setup";
const RECEIVE_PENDING_REVERSAL_KEY = "labtrax_receive_payment_pending_reversal";

function n(value: MaybeNumber): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

const NO_STATEMENT = "__none__";
function newDraft(statementId = ""): PaymentDraft {
  return {
    idempotencyKey: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    statementId,
    receivedAmount: "",
    existingCreditAmount: "",
    paymentDate: new Date().toISOString().slice(0, 10),
    paymentMethod: "check",
    checkNumber: "",
    cardLast4: "",
    cardChoice: "saved",
    saveCard: false,
    memo: "",
    customerEmail: "",
    applications: {},
  };
}

function ReceivePaymentsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const me = useMe();
  const labId = primaryAdminLabOrgId(me.data);
  const allowed = canAdminAnyLab(me.data);
  const qc = useQueryClient();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState("");
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [statementSelections, setStatementSelections] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, PaymentDraft>>({});
  const [completed, setCompleted] = useState<string[]>([]);
  const [stage, setStage] = useState<"summary" | "processing">("summary");
  const [cardSetupSessionId, setCardSetupSessionId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptSession | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [receiptSubject, setReceiptSubject] = useState("Payment receipt from {{labName}}");
  const [receiptBody, setReceiptBody] = useState(
    "Thank you for your payment of {{amountReceived}}. Receipt {{receiptNumber}} is attached.",
  );
  const [error, setError] = useState<string | null>(null);
  const [repairInvoice, setRepairInvoice] = useState<Invoice | null>(null);
  const [repairProfileId, setRepairProfileId] = useState("");
  const [lastRepair, setLastRepair] = useState<{
    invoiceId: string;
    invoiceNumber: string;
    providerOrganizationId: string;
    logs: DoctorIdentityRepairLog[];
    historyError: boolean;
  } | null>(null);
  const receiptRef = useRef<ReceiptSession | null>(null);
  const focusInitializedRef = useRef(false);

  const persistPendingReversal = useCallback(async (session: ReceiptSession) => {
    if (session.reversal?.status === "pending") {
      await AsyncStorage.setItem(RECEIVE_PENDING_REVERSAL_KEY, JSON.stringify(session));
    } else {
      await AsyncStorage.removeItem(RECEIVE_PENDING_REVERSAL_KEY);
    }
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(RECEIVE_PENDING_REVERSAL_KEY).then((value) => {
      if (!active || !value) return;
      try {
        const saved = receiptSessionFromResponse(JSON.parse(value) as ReceiptSession);
        if (saved.id && saved.reversal?.status === "pending") {
          setReceipt(saved);
          setReceiptEmail(saved.customerEmail ?? "");
          setReceiptOpen(true);
        } else {
          void AsyncStorage.removeItem(RECEIVE_PENDING_REVERSAL_KEY);
        }
      } catch {
        void AsyncStorage.removeItem(RECEIVE_PENDING_REVERSAL_KEY);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    receiptRef.current = receipt;
  }, [receipt]);

  const invoicesQuery = useQuery<Array<Record<string, unknown>>>({
    queryKey: ["receive-payments", "accounts", labId ?? ""],
    enabled: allowed && !!labId,
    staleTime: 30_000,
    queryFn: () => getJson(`/api/invoices?labOrganizationId=${encodeURIComponent(labId!)}`),
  });
  const eligibleAccountsQuery = useQuery<EligibleAccount[]>({
    queryKey: ["receive-payments", "eligible-accounts", labId ?? ""],
    enabled: allowed && !!labId,
    staleTime: 30_000,
    queryFn: () => getJson(`/api/billing/${encodeURIComponent(labId!)}/eligible-statement-accounts`),
  });
  // Invoice-led Receive Payments: outstanding invoices are payable whether or
  // not a statement was ever generated or sent.
  const invoiceAccountsQuery = useQuery<EligibleAccount[]>({
    queryKey: ["receive-payments", "invoice-accounts", labId ?? ""],
    enabled: allowed && !!labId,
    staleTime: 30_000,
    queryFn: () => getJson(`/api/billing/${encodeURIComponent(labId!)}/eligible-invoice-accounts`),
  });
  const invoiceLedAccounts = useMemo(() => {
    const map = new Map<string, EligibleAccount>();
    for (const account of invoiceAccountsQuery.data ?? []) map.set(account.providerOrganizationId, account);
    return map;
  }, [invoiceAccountsQuery.data]);
  const payableWithoutStatement = (providerId: string) =>
    (invoiceLedAccounts.get(providerId)?.outstandingInvoices ?? [])
      .some((invoice) => invoice.eligibleForPayment !== false && n(invoice.currentBalanceDue) > 0);

  const providers = useMemo<Provider[]>(() => {
    const map = new Map<string, Provider>();
    for (const invoice of invoicesQuery.data ?? []) {
      const id = typeof invoice.providerOrganizationId === "string"
        ? invoice.providerOrganizationId : "";
      if (!id || n(invoice.balanceDue as MaybeNumber) <= 0 || invoice.status === "void") continue;
      const organization = invoice.providerOrganization as { name?: string; billingEmail?: string } | null;
      map.set(id, {
        id,
        name: organization?.name?.trim() || `Customer account ${id.slice(0, 8)}`,
        billingEmail: organization?.billingEmail ?? null,
      });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [invoicesQuery.data]);

  useEffect(() => {
    if (!providers.length) return;
    setSelectedIds((old) => old.length ? old.filter((id) => providers.some((p) => p.id === id)) : [providers[0].id]);
    setActiveId((old) => old && providers.some((p) => p.id === old) ? old : providers[0].id);
  }, [providers]);

  const statementsQuery = useQuery<Record<string, Statement[]>>({
    queryKey: ["receive-payments", "statements", labId ?? "", providers.map((p) => p.id).join(",")],
    enabled: allowed && !!labId && providers.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const entries = await Promise.all(providers.map(async (provider) => {
        const rows = await getJson<Statement[]>(
          `/api/billing/${encodeURIComponent(labId!)}/accounts/${encodeURIComponent(provider.id)}/statements`,
        );
        return [provider.id, rows.filter((statement) => n(statement.savedBalanceDue) > 0)] as const;
      }));
      return Object.fromEntries(entries);
    },
  });

  const activeStatementSelection = statementSelections[activeId] ?? "";
  const activeStatementId =
    activeStatementSelection === NO_STATEMENT
      ? ""
      : activeStatementSelection || statementsQuery.data?.[activeId]?.[0]?.id || "";
  const activeStatementQuery = useQuery<StatementContext>({
    queryKey: ["receive-payments", "statement-context", activeStatementId],
    enabled: !!activeStatementId,
    staleTime: 30_000,
    queryFn: () => getJson(`/api/billing/statements/${encodeURIComponent(activeStatementId)}`),
  });
  const creditsQuery = useQuery<{ totalAvailable: MaybeNumber; credits: unknown[] }>({
    queryKey: ["receive-payments", "customer-credits", labId ?? "", activeId],
    enabled: allowed && !!labId && !!activeId,
    queryFn: () => getJson(`/api/billing/${encodeURIComponent(labId!)}/accounts/${encodeURIComponent(activeId)}/customer-credits`),
  });
  const cardQuery = useQuery<{ card?: { brand: string; last4: string } | null }>({
    queryKey: ["provider-lab-card", labId ?? "", activeId],
    enabled: allowed && !!labId && !!activeId,
    queryFn: () => getJson(`/api/provider/lab-card?${new URLSearchParams({ labOrganizationId: labId!, providerOrganizationId: activeId }).toString()}`),
  });
  const cardConfigQuery = useQuery<{ publishableKey: string }>({
    queryKey: ["billing", "card-config", labId ?? ""],
    enabled: allowed && !!labId,
    retry: false,
    queryFn: () => getJson(`/api/billing/payment-sessions/card/config?labOrganizationId=${encodeURIComponent(labId!)}`),
  });
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(RECEIVE_CARD_SETUP_KEY).then((value) => {
      if (active && value) setCardSetupSessionId(value);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const verify = async () => {
      if (!cardSetupSessionId || !labId) return;
      try {
        const result = await getJson<{ status: "succeeded" | "pending" | "expired" }>(`/api/provider/lab-card/setup-status/${encodeURIComponent(cardSetupSessionId)}?labOrganizationId=${encodeURIComponent(labId)}`);
        if (result.status !== "pending") {
          setCardSetupSessionId(null);
          await AsyncStorage.removeItem(RECEIVE_CARD_SETUP_KEY);
        }
        if (result.status === "succeeded") trackSavedCardSetup("succeeded");
        if (result.status === "expired") {
          trackSavedCardSetup("expired");
          setError("Secure card setup expired. Start again to add a card.");
        }
        await cardQuery.refetch();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not verify secure card setup."); }
    };
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void verify(); });
    return () => subscription.remove();
  }, [cardSetupSessionId, labId, cardQuery.refetch]);
  const receiptTemplateQuery = useQuery<{ emailSubject: string; emailBody: string }>({
    queryKey: ["receive-payments", "receipt-template", labId ?? ""],
    enabled: !!labId,
    retry: false,
    queryFn: () => getJson(`/api/billing/${encodeURIComponent(labId!)}/payment-receipt-template`),
  });
  const receiptSessionQuery = useQuery<ReceiptSession>({
    queryKey: ["receive-payments", "payment-session", receipt?.id ?? ""],
    enabled: !!receipt?.id,
    queryFn: async () => receiptSessionFromResponse(await getJson<ReceiptSession | LegacyReceiptSessionResponse>(`/api/billing/payment-sessions/${encodeURIComponent(receipt!.id)}`)),
    refetchInterval: (query) => query.state.data?.reversal?.status === "pending" && !query.state.error ? 2_000 : false,
  });
  const receiptRefetchRef = useRef(receiptSessionQuery.refetch);
  useEffect(() => {
    receiptRefetchRef.current = receiptSessionQuery.refetch;
  }, [receiptSessionQuery.refetch]);
  useFocusEffect(useCallback(() => {
    if (!focusInitializedRef.current) {
      focusInitializedRef.current = true;
      return;
    }
    const sessionId = receiptRef.current?.id;
    if (sessionId) {
      void receiptRefetchRef.current();
    }
  }, []));
  const displayedReceipt = receiptSessionQuery.data ?? receipt;
  const reversal = displayedReceipt?.reversal;
  const reversalPending = reversal?.status === "pending";
  const reversalCompleted = reversal?.status === "completed";
  const reversalFailed = reversal?.status === "failed";
  const invalidatePaymentViews = () => {
    void refreshCaseFinanceQueries(qc).catch(() => {
      Alert.alert("Payment updated", "Some sales views could not refresh. Reopen them to retry.");
    });
    void qc.invalidateQueries({ queryKey: ["receive-payments"] });
    void qc.invalidateQueries({ queryKey: ["finance"] });
    void qc.invalidateQueries({ queryKey: FINANCE_INVOICES_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["statements"] });
    void qc.invalidateQueries({ queryKey: FINANCE_STATEMENT_SUMMARIES_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: FINANCE_PAYMENT_HISTORY_QUERY_KEY });
  };
  useEffect(() => {
    if (reversalCompleted) invalidatePaymentViews();
  }, [reversalCompleted]);
  useEffect(() => {
    const refreshed = receiptSessionQuery.data;
    if (!receiptSessionQuery.isSuccess || !refreshed?.id) return;
    void persistPendingReversal(refreshed);
  }, [persistPendingReversal, receiptSessionQuery.data, receiptSessionQuery.isSuccess]);

  const activeProvider = providers.find((p) => p.id === activeId);
  const activeStatements = statementsQuery.data?.[activeId] ?? [];
  const activeInvoiceLedAccount = invoiceLedAccounts.get(activeId);
  // Without a statement the outstanding invoices themselves are the payment
  // context, so the same review UI works for both workflows.
  const invoiceLedContext = useMemo<StatementContext | undefined>(() => {
    if (!labId || !activeId || !activeInvoiceLedAccount) return undefined;
    const invoices = activeInvoiceLedAccount.outstandingInvoices
      .filter((invoice) => invoice.eligibleForPayment !== false && n(invoice.currentBalanceDue) > 0);
    if (!invoices.length) return undefined;
    return {
      id: "",
      labOrganizationId: labId,
      providerOrganizationId: activeId,
      periodStart: null,
      periodEnd: null,
      invoiceCount: invoices.length,
      savedBalanceDue: activeInvoiceLedAccount.currentBalanceDue
        ?? invoices.reduce((sum, invoice) => sum + n(invoice.currentBalanceDue), 0),
      invoices,
    };
  }, [labId, activeId, activeInvoiceLedAccount]);
  const context = activeStatementId ? activeStatementQuery.data : invoiceLedContext;
  const activeEligibleAccount = eligibleAccountsQuery.data?.find(
    (account) => account.providerOrganizationId === activeId,
  );
  const draft = drafts[activeId] ?? newDraft(activeStatementId);
  const payableInvoiceIds = new Set(
    (context?.invoices ?? [])
      .filter((invoice) => invoice.eligibleForPayment !== false)
      .map((invoice) => invoice.id),
  );
  const sanitizedApplications = Object.fromEntries(
    Object.entries(draft.applications).filter(([id]) => payableInvoiceIds.has(id)),
  );
  const applied = Object.values(sanitizedApplications).reduce((sum, value) => sum + n(value), 0);
  const received = n(draft.receivedAmount);
  const existingCredit = n(draft.existingCreditAmount);
  const credit = Math.max(0, received - applied);
  const statementBalance = n(context?.savedBalanceDue);
  const applicationInvalid = applied > received + 0.005 || (context?.invoices ?? []).some(
    (invoice) => n(sanitizedApplications[invoice.id]) > n(invoice.currentBalanceDue) + 0.005,
  );

  useEffect(() => {
    if (!activeId || drafts[activeId]?.statementId === activeStatementId) return;
    setDrafts((old) => ({
      ...old,
      [activeId]: newDraft(activeStatementId),
    }));
  }, [activeId, activeStatementId, drafts]);

  useEffect(() => {
    if (!activeId || !context || drafts[activeId]?.applications && Object.keys(drafts[activeId].applications).length) return;
    const initial = context.invoices
      .filter((invoice) => invoice.eligibleForPayment !== false && n(invoice.currentBalanceDue) > 0)
      .sort((a, b) => {
        const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        return aDue - bDue;
      });
    const amount = statementBalance;
    let left = amount;
    const applications: Record<string, string> = {};
    for (const invoice of initial) {
      const value = Math.min(left, n(invoice.currentBalanceDue));
      if (value > 0) applications[invoice.id] = value.toFixed(2);
      left = Math.max(0, left - value);
    }
    setDrafts((old) => ({
      ...old,
      [activeId]: {
        ...(old[activeId] ?? newDraft(activeStatementId)),
        statementId: activeStatementId,
        receivedAmount: old[activeId]?.receivedAmount || (amount ? amount.toFixed(2) : ""),
        applications,
        customerEmail: old[activeId]?.customerEmail || activeProvider?.billingEmail || "",
      },
    }));
  }, [activeId, activeStatementId, context, statementBalance, activeProvider?.billingEmail, drafts]);

  const updateDraft = (patch: Partial<PaymentDraft>) => {
    setDrafts((old) => ({ ...old, [activeId]: { ...draft, ...patch, statementId: activeStatementId } }));
    setError(null);
  };

  const applyOldest = () => {
    if (!context) return;
    const rows = [...context.invoices]
      .filter((invoice) => invoice.eligibleForPayment !== false && n(invoice.currentBalanceDue) > 0)
      .sort((a, b) => new Date(a.dueAt ?? "9999-12-31").getTime() - new Date(b.dueAt ?? "9999-12-31").getTime());
    let left = received;
    const applications: Record<string, string> = {};
    for (const invoice of rows) {
      const value = Math.min(left, n(invoice.currentBalanceDue));
      if (value > 0) applications[invoice.id] = value.toFixed(2);
      left = Math.max(0, left - value);
    }
    updateDraft({ applications });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!labId || !activeId) throw new Error("Choose a customer account.");
      if (!activeStatementId && !context?.invoices.length) throw new Error("This account has no outstanding invoices to pay.");
      if (!received && !existingCredit) throw new Error("Enter a monetary amount or apply available customer credit.");
      if (!validDate(draft.paymentDate)) throw new Error("Enter a valid payment date in YYYY-MM-DD format.");
      if (received > 0 && draft.paymentMethod === "check" && !draft.checkNumber.trim()) throw new Error("Enter a check number.");
      if (received > 0 && draft.paymentMethod === "card" && draft.cardChoice === "saved" && !cardQuery.data?.card?.last4) throw new Error("Choose a saved card or enter a new card.");
      if ((draft.paymentMethod === "ach" || draft.paymentMethod === "other") && received && !draft.checkNumber.trim()) throw new Error("Enter a reference number.");
       const applications = Object.entries(sanitizedApplications)
        .map(([invoiceId, amount]) => ({ invoiceId, amount: n(amount), creditAmount: 0 }))
        .filter((application) => application.amount > 0);
      const payload = {
        labOrganizationId: labId,
        providerOrganizationId: activeId,
        statementId: activeStatementId || null,
        receivedAmount: received,
        existingCreditAmount: existingCredit,
        paymentDate: `${draft.paymentDate}T12:00:00.000Z`,
        paymentMethod: draft.paymentMethod,
        checkNumber: draft.paymentMethod === "check" && received ? draft.checkNumber.trim() : null,
        referenceNumber: (draft.paymentMethod === "ach" || draft.paymentMethod === "other") && received ? draft.checkNumber.trim() : null,
        cardLast4: draft.paymentMethod === "card" && draft.cardChoice === "saved" ? cardQuery.data?.card?.last4 : null,
        memo: draft.memo.trim() || null,
        customerEmail: draft.customerEmail.trim() || null,
        idempotencyKey: draft.idempotencyKey,
        applications,
      };
      if (draft.paymentMethod !== "card" || draft.cardChoice === "saved") {
        return receiptSessionFromResponse(await sendJson<ReceiptSession | LegacyReceiptSessionResponse>(
          "POST",
          draft.paymentMethod === "card" ? "/api/billing/payment-sessions/card" : "/api/billing/payment-sessions",
          payload,
        ));
      }
      if (existingCredit > 0) throw new Error("Apply existing customer credit separately before charging a new card.");
      if (!cardConfigQuery.data?.publishableKey) {
        throw new Error(cardConfigQuery.isError ? "Card payments are not configured. Try again later." : "Card payments are still loading. Try again.");
      }
      const inlinePayload = {
        labOrganizationId: labId,
        providerOrganizationId: activeId,
        statementId: activeStatementId || null,
        receivedAmount: received,
        existingCreditAmount: 0,
        paymentDate: `${draft.paymentDate}T12:00:00.000Z`,
        paymentMethod: "card" as const,
        memo: draft.memo.trim() || null,
        customerEmail: draft.customerEmail.trim() || null,
        idempotencyKey: draft.idempotencyKey,
        savePaymentMethod: draft.saveCard,
        applications,
      };
      const prepared = await sendJson<{ clientSecret: string; paymentIntentId: string; status: string }>(
        "POST", "/api/billing/payment-sessions/card/prepare", inlinePayload,
      );
      const shouldPresentPaymentSheet = prepared.status !== "succeeded" && prepared.status !== "processing";
      let presented: Awaited<ReturnType<typeof presentPaymentSheet>> = {};
      let presentationFailure: Error | null = null;
      if (shouldPresentPaymentSheet) {
        await initStripe({ publishableKey: cardConfigQuery.data.publishableKey });
        const initialized = await initPaymentSheet({
          merchantDisplayName: "LabTrax",
          paymentIntentClientSecret: prepared.clientSecret,
          returnURL: "labtrax://stripe-redirect",
          paymentMethodOrder: ["card"],
          billingDetailsCollectionConfiguration: {
            name: CollectionMode.ALWAYS,
            address: AddressCollectionMode.AUTOMATIC,
          },
        });
        if (initialized.error) throw new Error(initialized.error.message || "Could not open secure card entry.");
        try {
          presented = await presentPaymentSheet();
        } catch (cause) {
          presentationFailure = cause instanceof Error ? cause : new Error("Stripe card entry closed unexpectedly.");
        }
      }
      let confirmed: ReceiptSession | LegacyReceiptSessionResponse | { status?: string };
      try {
        confirmed = await sendJson(
          "POST", "/api/billing/payment-sessions/card/confirm",
          { ...inlinePayload, paymentIntentId: prepared.paymentIntentId },
        );
      } catch (confirmError) {
        if (presented.error || presentationFailure) {
          if (presented.error) throw new Error(presented.error.message || "Card payment was not completed.");
          if (presentationFailure) throw new Error(SUPPORT_CARD_ATTEMPT_MESSAGE);
        }
        throw confirmError;
      }
      const session = receiptSessionFromResponse(confirmed as ReceiptSession | LegacyReceiptSessionResponse);
      if (session.id) return session;
      if (presented.error || presentationFailure) {
        const status = "status" in confirmed ? confirmed.status : undefined;
        throw new Error(status === "processing"
          ? AUTOMATIC_CARD_ATTEMPT_MESSAGE
          : status === "requires_action"
            ? "The card requires additional authentication. Complete the Stripe prompt, then retry."
            : presented.error?.message || (presentationFailure ? SUPPORT_CARD_ATTEMPT_MESSAGE : "Card payment was cancelled."));
      }
      const status = "status" in confirmed ? confirmed.status : undefined;
      throw new Error(status === "processing"
        ? AUTOMATIC_CARD_ATTEMPT_MESSAGE
        : SUPPORT_CARD_ATTEMPT_MESSAGE);
    },
    onSuccess: (saved) => {
      qc.setQueryData(["receive-payments", "payment-session", saved.id], saved);
      const nextCompleted = [...completed, activeId];
      setCompleted(nextCompleted);
      setReceipt(saved);
      setReceiptEmail(saved.customerEmail || draft.customerEmail || activeProvider?.billingEmail || "");
      setReceiptSubject(receiptTemplateQuery.data?.emailSubject || "Payment receipt from {{labName}} — {{receiptNumber}}");
      setReceiptBody(receiptTemplateQuery.data?.emailBody || "Thank you for your payment of {{amountReceived}}. Receipt {{receiptNumber}} is attached.");
      setReceiptOpen(true);
      setDrafts((old) => {
        const next = { ...old };
        delete next[activeId];
        return next;
      });
      setError(null);
      invalidatePaymentViews();
      void qc.invalidateQueries({ queryKey: IN_APP_NOTIFICATIONS_QUERY_KEY });
      if (draft.paymentMethod === "card" && draft.cardChoice === "new" && draft.saveCard) {
        void qc.invalidateQueries({ queryKey: ["provider-lab-card", labId ?? "", activeId] });
      }
    },
    onError: (err: Error) => setError(paymentErrorMessage(err)),
  });

  const repairMutation = useMutation({
    mutationFn: async ({ invoiceId, doctorProfileId }: { invoiceId: string; doctorProfileId: string }) => {
      return sendJson<Invoice>("PATCH", `/api/invoices/${encodeURIComponent(invoiceId)}/repair-doctor`, {
        doctorProfileId,
      });
    },
    onSuccess: (updated) => {
      setLastRepair({
        invoiceId: updated.id,
        invoiceNumber: updated.invoiceNumber,
        providerOrganizationId: activeId,
        logs: [],
        historyError: false,
      });
      setRepairInvoice(null);
      setRepairProfileId("");
      setError(null);
      void eligibleAccountsQuery.refetch();
      void activeStatementQuery.refetch();
      void qc.invalidateQueries({ queryKey: FINANCE_INVOICES_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: FINANCE_PAYMENT_HISTORY_QUERY_KEY });
      void getJson<InvoiceDetail>(`/api/invoices/${encodeURIComponent(updated.id)}`)
        .then((detail) => setLastRepair((current) => current?.invoiceId === updated.id ? {
          ...current,
          logs: detail.doctorIdentityRepairLogs ?? [],
          historyError: false,
        } : current))
        .catch(() => setLastRepair((current) => current?.invoiceId === updated.id ? {
          ...current,
          historyError: true,
        } : current));
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmRepair = () => {
    if (!repairInvoice || !repairProfileId) return;
    const profile = activeEligibleAccount?.doctorProfiles.find((item) => item.id === repairProfileId);
    if (!profile) {
      setError("Choose a doctor profile from this practice.");
      return;
    }
    Alert.alert(
      "Repair doctor identity?",
      `Assign ${profile.doctorDisplayName} to legacy invoice ${repairInvoice.invoiceNumber}? This records an admin audit entry and changes its payment scope.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Repair identity",
          onPress: () => repairMutation.mutate({
            invoiceId: repairInvoice.id,
            doctorProfileId: profile.id,
          }),
        },
      ],
    );
  };

  const finishAccount = () => {
    setReceiptOpen(false);
    setReceipt(null);
    void AsyncStorage.removeItem(RECEIVE_PENDING_REVERSAL_KEY);
    const next = selectedIds.find((id) => !completed.includes(id) && id !== activeId);
    if (next) setActiveId(next);
    else {
      setSelectedIds([]);
      setCompleted([]);
      setActiveId("");
      setStage("summary");
    }
  };

  const sendReceiptMutation = useMutation({
    mutationFn: () => {
      if (!receipt?.id || !receiptEmail.trim()) throw new Error("Enter a billing email.");
      return sendJson("POST", `/api/billing/payment-sessions/${receipt.id}/send-receipt`, {
        to: receiptEmail.trim(),
        subject: receiptSubject.trim(),
        body: receiptBody.trim(),
      });
    },
    onSuccess: () => {
      Alert.alert("Receipt sent", `The receipt was sent to ${receiptEmail.trim()}.`, [{ text: "Continue", onPress: finishAccount }]);
    },
    onError: (err: Error) => Alert.alert("Could not send receipt", err.message),
  });

  const cancelPayment = async () => {
    if (!receipt?.id) return;
    try {
      const cancelled = receiptSessionFromResponse(await sendJson<ReceiptSession | LegacyReceiptSessionResponse>("DELETE", `/api/billing/payment-sessions/${receipt.id}`));
      if (cancelled.reversal) {
        qc.setQueryData(["receive-payments", "payment-session", receipt.id], cancelled);
        setReceipt(cancelled);
        setReceiptOpen(true);
        await persistPendingReversal(cancelled);
        if (cancelled.reversal.status === "completed") invalidatePaymentViews();
        Alert.alert(
          cancelled.reversal.status === "pending" ? "Reversal pending" : cancelled.reversal.status === "failed" ? "Reversal failed" : "Payment reversed",
          cancelled.reversal.status === "pending" ? "The processor is confirming the reversal. This receipt will refresh automatically." : cancelled.reversal.reason || "The processor-backed reversal has been recorded.",
        );
        return;
      }
      setReceiptOpen(false);
      setReceipt(null);
      await AsyncStorage.removeItem(RECEIVE_PENDING_REVERSAL_KEY);
      setCompleted((old) => old.filter((id) => id !== activeId));
      setDrafts((old) => ({ ...old, [activeId]: newDraft(activeStatementId) }));
      invalidatePaymentViews();
      Alert.alert("Payment cancelled", "The payment, invoice applications, credit, and Undeposited Funds entry were reversed.");
    } catch (err) {
      Alert.alert("Could not cancel payment", err instanceof Error ? err.message : "This payment may already be deposited.");
    }
  };

  const dismissReceipt = () => {
    if (reversalPending) {
      Alert.alert("Reversal pending", "The processor is confirming this reversal. Keep this receipt open until its status is complete or failed.");
      return;
    }
    if (reversalFailed) {
      Alert.alert("Reversal needs review", `The payment remains recorded${reversal?.reason ? ` (${reversal.reason})` : ""}. Ask an administrator to review the payment and contact the payment processor if needed.`);
      return;
    }
    Alert.alert("Payment saved", "Keep this payment in Undeposited Funds or cancel it?", [
      { text: "Keep payment", onPress: finishAccount },
      { text: "Cancel payment", style: "destructive", onPress: () => void cancelPayment() },
    ]);
  };

  const shareReceipt = async (preview: boolean) => {
    if (!receipt?.id) return;
    const url = `/api/billing/payment-sessions/${receipt.id}/receipt.pdf`;
    const fileName = `${receipt.receiptNumber || "payment-receipt"}.pdf`;
    if (preview) {
      router.push({
        pathname: "/pdf-viewer",
        params: { url, fileName, fileType: "application/pdf" },
      } as never);
      return;
    }
    const acquired = await downloadAttachmentToLocalFile({
      url,
      fileName,
      fileType: "application/pdf",
    });
    if (!acquired) {
      Alert.alert("Receipt unavailable", "The PDF could not be downloaded. Try again.");
      return;
    }
    try {
      await shareLocalFile(acquired.uri, {
        fileName,
        fileType: "application/pdf",
      });
    } finally {
      acquired.release();
    }
  };
  const setupCard = async () => {
    if (!labId || !activeId) return;
    try {
      trackSavedCardSetup("started");
      const successReturn = `${providerBillingReturnUrl()}&providerCardSetupSession={CHECKOUT_SESSION_ID}`;
      const cancelReturn = `${providerBillingReturnUrl(true)}&providerCardSetupSession={CHECKOUT_SESSION_ID}`;
      const result = await sendJson<{ url: string; sessionId: string }>("POST", "/api/provider/lab-card/setup", {
        labOrganizationId: labId, providerOrganizationId: activeId,
        successUrl: successReturn, cancelUrl: cancelReturn,
      });
      setCardSetupSessionId(result.sessionId);
      await AsyncStorage.setItem(RECEIVE_CARD_SETUP_KEY, result.sessionId);
      await Linking.openURL(result.url);
      void cardQuery.refetch();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not start secure card setup."); }
  };

  if (!labId || !allowed) {
    return <ScreenState styles={styles} colors={colors} insets={insets} title="Not available" body="Receive Payments is available only to lab owners and administrators." icon="lock-closed-outline" />;
  }
  if (invoicesQuery.isError || statementsQuery.isError) {
    const forbidden = isForbiddenError(invoicesQuery.error) || isForbiddenError(statementsQuery.error);
    return <ScreenState styles={styles} colors={colors} insets={insets} title={forbidden ? "Not available" : "Couldn't load customer accounts"} body={forbidden ? "You don't have permission to receive payments for this lab." : "Check your connection and try again."} icon={forbidden ? "lock-closed-outline" : "cloud-offline-outline"} onRetry={() => { void invoicesQuery.refetch(); void statementsQuery.refetch(); }} />;
  }

  return (
    <DismissKeyboardView style={[styles.screen, { paddingTop: insets.top }]} testID="receive-payments-keyboard-dismiss">
      <Header colors={colors} styles={styles} />
      <KeyboardAwareScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        bottomOffset={72}
      >
        <View style={styles.intro}>
          <Text style={styles.eyebrow}>Accounts receivable</Text>
          <Text style={styles.heading}>Receive Payments</Text>
          <Text style={styles.subtitle}>Choose a statement for each customer account, then review payments one at a time.</Text>
        </View>

        <Card style={styles.card}>
          <Text style={styles.sectionTitle}>Customer accounts</Text>
          <Pressable testID="receive-account-picker" style={styles.picker} onPress={() => setSelectionOpen(true)}>
            <View style={styles.flex}><Text style={styles.pickerText}>{selectedIds.length ? `${selectedIds.length} account${selectedIds.length === 1 ? "" : "s"} selected` : "Choose customer accounts"}</Text><Text style={styles.muted}>{activeProvider?.name || "Select an account to begin"}</Text></View>
            <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
          </Pressable>
          {stage === "processing" && selectedIds.length > 0 && <Text style={styles.progress}>Processing account {Math.max(1, selectedIds.indexOf(activeId) + 1)} of {selectedIds.length}</Text>}
        </Card>

        {stage === "summary" && <Card style={styles.card}>
          <Text style={styles.sectionTitle}>Review selected accounts</Text>
          <Text style={styles.sectionHint}>Each account is processed separately using its live open statement balance, or its outstanding invoices when no statement exists.</Text>
          {selectedIds.map((id) => {
            const provider = providers.find((item) => item.id === id);
            const statement = (statementsQuery.data?.[id] ?? [])[0];
            return <View key={id} style={styles.statementRow}>
              <View style={styles.flex}><Text style={styles.pickerText}>{provider?.name || id}</Text>{statementsQuery.isLoading ? <Text style={styles.muted}>Loading current open statement balance…</Text> : statement ? <Text style={styles.muted}>{formatMoney(statement.savedBalanceDue)} · Statement date {statement.periodEnd ? formatDate(statement.periodEnd) : "unavailable"}</Text> : <Text style={styles.muted}>{payableWithoutStatement(id) ? "No open statement — outstanding invoices can be paid directly." : "No open statement available."}</Text>}</View>
            </View>;
          })}
          {statementsQuery.isError && <Text style={styles.error}>Statements are unavailable. Retry before continuing.</Text>}
          <Pressable testID="receive-continue" style={[styles.primary, (!selectedIds.length || statementsQuery.isLoading || statementsQuery.isError || selectedIds.some((id) => !(statementsQuery.data?.[id] ?? []).length && !payableWithoutStatement(id))) && styles.disabled]} disabled={!selectedIds.length || statementsQuery.isLoading || statementsQuery.isError || invoiceAccountsQuery.isLoading || selectedIds.some((id) => !(statementsQuery.data?.[id] ?? []).length && !payableWithoutStatement(id))} onPress={() => { setError(null); setActiveId(selectedIds.find((id) => !completed.includes(id)) || ""); setStage("processing"); }}>
            <Text style={styles.primaryText}>Continue</Text>
          </Pressable>
          {(!selectedIds.length || selectedIds.some((id) => !(statementsQuery.data?.[id] ?? []).length && !payableWithoutStatement(id))) && <Text style={styles.muted}>Select accounts with an open statement or an outstanding invoice to continue.</Text>}
        </Card>}

        {stage === "processing" && activeId && (
          <>
            <Card style={styles.card}>
              <Text style={styles.sectionTitle}>{activeProvider?.name || "Customer account"}</Text>
              <Text style={styles.sectionHint}>Statement selection (optional)</Text>
              {activeStatements.length === 0 ? <Text style={styles.muted}>No generated statements with an open balance. Outstanding invoices for this account are listed below and can be paid directly.</Text> : activeStatements.map((statement) => {
                const selected = statement.id === activeStatementId;
                return <Pressable key={statement.id} testID={`receive-statement-${statement.id}`} style={[styles.statementRow, selected && styles.selectedRow]} onPress={() => {
                  setStatementSelections((old) => ({ ...old, [activeId]: statement.id }));
                  setDrafts((old) => ({ ...old, [activeId]: newDraft(statement.id) }));
                }}>
                  <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioDot} />}</View>
                  <View style={styles.flex}><Text style={styles.pickerText}>{statement.periodEnd ? `Statement through ${formatDate(statement.periodEnd)}` : "Generated statement"}</Text><Text style={styles.muted}>{statement.invoiceCount ?? 0} invoice{statement.invoiceCount === 1 ? "" : "s"} · {formatMoney(statement.savedBalanceDue)}</Text></View>
                </Pressable>;
              })}
              {payableWithoutStatement(activeId) && activeStatements.length > 0 && (() => {
                const selected = !activeStatementId;
                return <Pressable testID="receive-statement-none" style={[styles.statementRow, selected && styles.selectedRow]} onPress={() => {
                  setStatementSelections((old) => ({ ...old, [activeId]: NO_STATEMENT }));
                  setDrafts((old) => ({ ...old, [activeId]: newDraft("") }));
                }}>
                  <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioDot} />}</View>
                  <View style={styles.flex}><Text style={styles.pickerText}>No statement — pay outstanding invoices</Text><Text style={styles.muted}>Every outstanding invoice for this account, including any not on a statement.</Text></View>
                </Pressable>;
              })()}
            </Card>

            {eligibleAccountsQuery.isLoading && <Card style={styles.loading}><ActivityIndicator color={colors.tint} /><Text style={styles.muted}>Checking legacy doctor identities…</Text></Card>}
            {eligibleAccountsQuery.isError && <Card style={styles.card}>
              <Text style={styles.warning}>Legacy doctor identities could not be checked. Payment details remain available, but repair controls may be incomplete.</Text>
              <Pressable testID="doctor-repair-retry-eligibility" style={styles.secondary} onPress={() => void eligibleAccountsQuery.refetch()}><Text style={styles.secondaryText}>Retry identity check</Text></Pressable>
            </Card>}
            {(activeStatementId ? activeStatementQuery.isLoading : invoiceAccountsQuery.isLoading) ? <Card style={styles.loading}><ActivityIndicator color={colors.tint} /><Text style={styles.muted}>{activeStatementId ? "Loading statement details…" : "Loading outstanding invoices…"}</Text></Card> : context ? <PaymentReview
              context={context}
              draft={draft}
              applied={applied}
              credit={credit}
              existingCredit={existingCredit}
              availableCredit={n(creditsQuery.data?.totalAvailable)}
              savedCard={cardQuery.data?.card ?? null}
              cardConfigurationError={cardConfigQuery.isError ? "Inline card entry is unavailable because Stripe is not configured." : null}
              onSetupCard={() => void setupCard()}
              received={received}
              styles={styles}
              colors={colors}
              onChange={updateDraft}
              onApplyOldest={applyOldest}
              eligibleAccount={activeEligibleAccount}
              onRepair={(invoice) => {
                setRepairInvoice(invoice);
                setRepairProfileId("");
                setError(null);
              }}
            /> : null}

            {lastRepair?.providerOrganizationId === activeId && <Card style={styles.card} testID="doctor-repair-history">
              <View style={styles.rowBetween}>
                <View style={styles.flex}>
                  <Text style={styles.sectionTitle}>Doctor identity repair history</Text>
                  <Text style={styles.sectionHint}>Invoice {lastRepair.invoiceNumber}</Text>
                </View>
                <Ionicons name="checkmark-circle" size={22} color={colors.successStrong} />
              </View>
              {lastRepair.historyError ? <>
                <Text style={styles.warning}>The identity was repaired, but its audit history could not be loaded.</Text>
                <Pressable testID="doctor-repair-retry-history" style={styles.secondary} onPress={() => {
                  setLastRepair((current) => current ? { ...current, historyError: false } : current);
                  void getJson<InvoiceDetail>(`/api/invoices/${encodeURIComponent(lastRepair.invoiceId)}`)
                    .then((detail) => setLastRepair((current) => current?.invoiceId === lastRepair.invoiceId ? { ...current, logs: detail.doctorIdentityRepairLogs ?? [], historyError: false } : current))
                    .catch(() => setLastRepair((current) => current?.invoiceId === lastRepair.invoiceId ? { ...current, historyError: true } : current));
                }}><Text style={styles.secondaryText}>Retry history</Text></Pressable>
              </> : lastRepair.logs.length === 0 ? <Text style={styles.muted}>The identity was repaired. Audit history is loading.</Text> : lastRepair.logs.map((log) => {
                const actor = [log.actorFirstName, log.actorLastName].filter(Boolean).join(" ") || log.actorInitials || log.actorUsername || log.userId || "Unknown user";
                return <View key={log.id} style={styles.historyRow}>
                  <Text style={styles.pickerText}>Doctor identity assigned</Text>
                  <Text style={styles.invoiceMeta}>{log.beforeJson?.doctorDisplayName || "Unclassified legacy invoice"} → {log.afterJson?.doctorDisplayName || "Doctor profile"}</Text>
                  <Text style={styles.invoiceMeta}>{formatDate(log.createdAt)} · {actor}</Text>
                </View>;
              })}
            </Card>}

            <Card style={styles.card}>
              <Text style={styles.sectionTitle}>Payment summary</Text>
              <Summary label={activeStatementId ? "Statement balance" : "Outstanding balance"} value={formatMoney(statementBalance)} styles={styles} />
              <Summary label="Received" value={formatMoney(received)} styles={styles} />
              <Summary label="Applied to invoices" value={formatMoney(applied)} styles={styles} />
              <Summary label="Customer credit" value={formatMoney(credit)} styles={styles} strong={credit > 0} />
              {credit > 0 && <Text style={styles.credit}>The unapplied {formatMoney(credit)} will remain as customer account credit.</Text>}
              {applicationInvalid && <Text style={styles.error}>Invoice applications cannot exceed the received amount or an invoice's current due amount.</Text>}
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable testID="receive-save" style={[styles.primary, (saveMutation.isPending || !context?.invoices.length || (!received && !existingCredit) || applicationInvalid) && styles.disabled]} disabled={saveMutation.isPending || !context?.invoices.length || (!received && !existingCredit) || applicationInvalid} onPress={() => saveMutation.mutate()}>
                {saveMutation.isPending ? <ActivityIndicator color={colors.textInverse} /> : <Ionicons name="checkmark-circle-outline" size={18} color={colors.textInverse} />}
                <Text style={styles.primaryText}>{saveMutation.isPending ? "Saving…" : selectedIds.length > 1 ? "Save and continue" : "Save payment"}</Text>
              </Pressable>
              {!context?.invoices.length && <Text style={styles.muted}>Choose an open statement, or an outstanding invoice, before saving.</Text>}
              {!!context?.invoices.length && !received && !existingCredit && <Text style={styles.muted}>Enter a monetary amount or apply existing customer credit before saving.</Text>}
            </Card>
          </>
        )}
      </KeyboardAwareScrollView>

      <FormSheet visible={selectionOpen} title="Customer accounts" onClose={() => setSelectionOpen(false)} onSubmit={() => { setSelectionOpen(false); if (!selectedIds.includes(activeId)) setActiveId(selectedIds[0] || ""); }} submitLabel="Done" testIDPrefix="receive-account">
        <Text style={styles.muted}>Select multiple accounts. Each keeps its own statement and payment draft. Continue from the review step to begin processing.</Text>
        {providers.map((provider) => {
          const selected = selectedIds.includes(provider.id);
          const done = completed.includes(provider.id);
          return <Pressable key={provider.id} testID={`receive-account-option-${provider.id}`} style={[styles.accountOption, done && styles.disabled]} disabled={done} onPress={() => setSelectedIds((old) => selected ? old.filter((id) => id !== provider.id) : [...old, provider.id])}>
            <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected && <Ionicons name="checkmark" size={14} color={colors.textInverse} />}</View>
            <View style={styles.flex}><Text style={styles.pickerText}>{provider.name}</Text><Text style={styles.muted}>{(statementsQuery.data?.[provider.id] ?? []).length} open statement{(statementsQuery.data?.[provider.id] ?? []).length === 1 ? "" : "s"}</Text></View>
            {done && <Text style={styles.done}>Saved</Text>}
          </Pressable>;
        })}
      </FormSheet>

      <FormSheet
        visible={!!repairInvoice}
        title="Repair doctor identity"
        onClose={() => {
          if (repairMutation.isPending) return;
          setRepairInvoice(null);
          setRepairProfileId("");
        }}
        onSubmit={confirmRepair}
        submitting={repairMutation.isPending}
        submitDisabled={!repairProfileId}
        submitLabel="Review repair"
        testIDPrefix="doctor-repair"
      >
        <Text style={styles.muted}>Choose the doctor profile that belongs to invoice {repairInvoice?.invoiceNumber}. Only profiles from this customer practice are available.</Text>
        {(activeEligibleAccount?.doctorProfiles ?? []).map((profile) => {
          const selected = repairProfileId === profile.id;
          return <Pressable key={profile.id} testID={`doctor-repair-profile-${profile.id}`} style={[styles.statementRow, selected && styles.selectedRow]} onPress={() => setRepairProfileId(profile.id)}>
            <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioDot} />}</View>
            <View style={styles.flex}><Text style={styles.pickerText}>{profile.doctorDisplayName}</Text>{profile.doctorName !== profile.doctorDisplayName && <Text style={styles.muted}>{profile.doctorName}</Text>}</View>
          </Pressable>;
        })}
        {(activeEligibleAccount?.doctorProfiles ?? []).length === 0 && <Text style={styles.warning}>No doctor profiles are available for this practice.</Text>}
      </FormSheet>

      <FormSheet visible={receiptOpen} title="Email payment receipt" onClose={reversalFailed ? finishAccount : dismissReceipt} onSubmit={reversalFailed ? finishAccount : () => sendReceiptMutation.mutate()} submitting={sendReceiptMutation.isPending} submitDisabled={!reversalFailed && (receiptTemplateQuery.isLoading || receiptTemplateQuery.isError || receiptSessionQuery.isFetching || reversalPending)} submitLabel={reversalFailed ? "Done" : "Send receipt"} testIDPrefix="receipt-composer">
        <Text style={styles.muted}>{reversalFailed ? `Payment ${receipt?.receiptNumber || ""} remains recorded.` : `Payment ${receipt?.receiptNumber || ""} is saved in Undeposited Funds. Email a PDF receipt now, or dismiss and choose whether to keep or cancel the payment.`}</Text>
        {reversalPending && <Text testID="receipt-reversal-pending" style={styles.warning}>Card reversal pending. The processor status refreshes automatically; do not submit another reversal.</Text>}
        {reversalPending && receiptSessionQuery.isError && <View testID="receipt-reversal-refresh-error" style={styles.error}>
          <Text style={styles.error}>Status refresh failed. The reversal is still pending and has not been marked completed.</Text>
          <Pressable testID="receipt-reversal-refresh-retry" disabled={receiptSessionQuery.isFetching} style={[styles.secondary, receiptSessionQuery.isFetching && styles.disabled]} onPress={() => void receiptSessionQuery.refetch()}>
            <Text style={styles.secondaryText}>{receiptSessionQuery.isFetching ? "Refreshing…" : "Retry status refresh"}</Text>
          </Pressable>
        </View>}
        {reversalCompleted && <Text testID="receipt-reversal-completed" style={styles.credit}>Card reversal completed. Invoice balances and customer credit have been refreshed.</Text>}
        {reversalFailed && <Text testID="receipt-reversal-failed" style={styles.error}>Reversal needs review. The payment remains recorded{reversal?.reason ? ` (${reversal.reason})` : ""}. Ask an administrator to review the payment and contact the payment processor if needed.</Text>}
        {receiptTemplateQuery.isError && <View style={styles.error}><Text style={styles.error}>The saved receipt template could not be loaded. Your payment is safe.</Text><Pressable style={styles.secondary} onPress={() => void receiptTemplateQuery.refetch()}><Text style={styles.secondaryText}>Retry template</Text></Pressable></View>}
        <Field label="Billing email" value={receiptEmail} onChangeText={setReceiptEmail} styles={styles} colors={colors} testID="receipt-email" keyboardType="email-address" />
        <Field label="Subject" value={receiptSubject} onChangeText={setReceiptSubject} styles={styles} colors={colors} testID="receipt-subject" />
        <Field label="Message" value={receiptBody} onChangeText={setReceiptBody} styles={styles} colors={colors} testID="receipt-body" multiline prose />
        <View style={styles.receiptActions}>
          <Pressable disabled={reversalPending} style={[styles.secondary, reversalPending && styles.disabled]} onPress={() => void shareReceipt(true)}><Ionicons name="eye-outline" size={16} color={colors.tint} /><Text style={styles.secondaryText}>Preview PDF</Text></Pressable>
          <Pressable disabled={reversalPending} style={[styles.secondary, reversalPending && styles.disabled]} onPress={() => void shareReceipt(false)}><Ionicons name="share-outline" size={16} color={colors.tint} /><Text style={styles.secondaryText}>Share PDF</Text></Pressable>
        </View>
        {receipt && n(receipt.customerCreditAmount) > 0 && <Text style={styles.credit}>This receipt includes {formatMoney(receipt.customerCreditAmount)} customer credit.</Text>}
      </FormSheet>
    </DismissKeyboardView>
  );
}

function PaymentReview({ context, draft, applied, credit, received, existingCredit, availableCredit, savedCard, cardConfigurationError, onSetupCard, styles, colors, onChange, onApplyOldest, eligibleAccount, onRepair }: {
  context: StatementContext; draft: PaymentDraft; applied: number; credit: number; received: number; existingCredit: number; availableCredit: number; savedCard: { brand: string; last4: string } | null; cardConfigurationError: string | null; onSetupCard: () => void;
  styles: ReturnType<typeof makeStyles>; colors: ThemeColors; onChange: (patch: Partial<PaymentDraft>) => void; onApplyOldest: () => void; eligibleAccount?: EligibleAccount; onRepair: (invoice: Invoice) => void;
}) {
  return <Card style={styles.card}>
    <View style={styles.rowBetween}><View><Text style={styles.sectionTitle}>Payment review</Text><Text style={styles.sectionHint}>{context.periodEnd ? `Statement through ${formatDate(context.periodEnd)}` : context.id ? "Selected generated statement" : "Outstanding invoices"}</Text></View><Pressable testID="receive-apply-oldest" style={styles.secondary} onPress={onApplyOldest}><Text style={styles.secondaryText}>Oldest first</Text></Pressable></View>
    <Text style={styles.fieldLabel}>Available existing credit: {formatMoney(availableCredit)}</Text>
    <View style={styles.twoCol}><Field label="Apply existing credit" value={draft.existingCreditAmount} onChangeText={(value) => onChange({ existingCreditAmount: value })} styles={styles} colors={colors} testID="receive-existing-credit" keyboardType="decimal-pad" /><Field label="Amount received" value={draft.receivedAmount} onChangeText={(value) => onChange({ receivedAmount: value, ...(n(value) <= 0 ? { applications: {} } : {}) })} styles={styles} colors={colors} testID="receive-total" keyboardType="decimal-pad" /></View>
    <Text style={styles.muted}>Existing credit is applied first and does not create an Undeposited Funds payment.</Text>
    <Field label="Payment date" value={draft.paymentDate} onChangeText={(value) => onChange({ paymentDate: value })} styles={styles} colors={colors} testID="receive-payment-date" />
    <Text style={styles.fieldLabel}>Payment method</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.methods}>{METHODS.map((method) => <Pressable key={method.value} testID={`payment-method-${method.value}`} style={[styles.method, draft.paymentMethod === method.value && styles.methodSelected]} onPress={() => onChange({ paymentMethod: method.value })}><Text style={[styles.methodText, draft.paymentMethod === method.value && styles.methodTextSelected]}>{method.label}</Text></Pressable>)}</ScrollView>
    {draft.paymentMethod === "check" && <Field label="Check number" value={draft.checkNumber} onChangeText={(value) => onChange({ checkNumber: value })} styles={styles} colors={colors} testID="receive-check-number" />}
    {draft.paymentMethod === "card" && <View style={styles.cardChoices}>
      <Pressable testID="receive-card-saved" disabled={!savedCard} style={[styles.statementRow, draft.cardChoice === "saved" && styles.selectedRow, !savedCard && styles.disabled]} onPress={() => onChange({ cardChoice: "saved", saveCard: false })}>
        <View style={[styles.radio, draft.cardChoice === "saved" && styles.radioSelected]}>{draft.cardChoice === "saved" && <View style={styles.radioDot} />}</View>
        <Text style={styles.pickerText}>{savedCard ? `Use saved ${savedCard.brand} ···· ${savedCard.last4}` : "No saved card available"}</Text>
      </Pressable>
      <Pressable testID="receive-card-new" style={[styles.statementRow, draft.cardChoice === "new" && styles.selectedRow]} onPress={() => onChange({ cardChoice: "new" })}>
        <View style={[styles.radio, draft.cardChoice === "new" && styles.radioSelected]}>{draft.cardChoice === "new" && <View style={styles.radioDot} />}</View>
        <View style={styles.flex}><Text style={styles.pickerText}>Enter a new card</Text><Text style={styles.muted}>Stripe securely collects the card number, expiration, CVC, billing ZIP, and cardholder name after you tap Save.</Text></View>
      </Pressable>
      {draft.cardChoice === "new" && <>
        <Pressable testID="receive-card-save-on-file" style={styles.saveCardRow} onPress={() => onChange({ saveCard: !draft.saveCard })}>
          <View style={[styles.checkbox, draft.saveCard && styles.checkboxSelected]}>{draft.saveCard && <Ionicons name="checkmark" size={14} color={colors.textInverse} />}</View>
          <Text style={[styles.muted, styles.flex]}>Save this card on file as the customer's default for future payments and auto-pay. This is off by default.</Text>
        </Pressable>
        {cardConfigurationError && <Text style={styles.error}>{cardConfigurationError}</Text>}
      </>}
      <Pressable testID="receive-card-setup" style={styles.secondary} onPress={onSetupCard}><Text style={styles.secondaryText}>Manage saved card</Text></Pressable>
    </View>}
    <Field label="Memo" value={draft.memo} onChangeText={(value) => onChange({ memo: value })} styles={styles} colors={colors} testID="receive-memo" prose />
    <Text style={styles.sectionTitle}>Invoice applications</Text>
    {(context.detailProvenance === "live" || context.detailProvenance === "mixed") && <Text testID="legacy-statement-warning" style={styles.warning}>{context.detailProvenance === "mixed" ? "Some invoice details on this statement are reconstructed from current invoice data; others are guaranteed snapshots." : "This older statement has no invoice-detail snapshot. Invoice numbers and names are reconstructed from current invoice data and may differ from the original statement."}</Text>}
    {context.invoices.length === 0 ? <Text style={styles.muted}>This statement has no invoice details.</Text> : context.invoices.map((invoice) => {
      const amount = n(draft.applications[invoice.id]);
       const unavailable = invoice.detailProvenance === "unavailable";
      const repairCandidate = eligibleAccount?.outstandingInvoices.find((item) => item.id === invoice.id);
      const legacyIdentity = repairCandidate?.doctorProfileId === null;
      return <View key={invoice.id} testID={`receive-invoice-${invoice.id}`} style={styles.invoiceRow}>
        <View style={[styles.checkbox, amount > 0 && styles.checkboxSelected]}><Text style={amount > 0 ? styles.checkmark : styles.hidden}>✓</Text></View>
        <View style={styles.flex}>
           <Text style={[styles.pickerText, unavailable && styles.muted]}>{invoice.invoiceNumber}</Text>
           {unavailable && <Text style={styles.warning}>Original invoice unavailable (deleted); this row cannot receive payment.</Text>}
          <Text style={styles.invoiceMeta}>{invoice.patientName || "Patient not listed"} · Current due {formatMoney(invoice.currentBalanceDue)}{invoice.dueAt ? ` · Due ${formatDate(invoice.dueAt)}` : ""}</Text>
          <Text style={styles.invoiceMeta}>Original {formatMoney(invoice.total)} · Applied {formatMoney(amount)}</Text>
          {legacyIdentity && <View style={styles.legacyRepair}>
            <Text testID={`doctor-repair-legacy-${invoice.id}`} style={styles.legacyBadge}>Legacy identity</Text>
            {eligibleAccount?.doctorProfiles.length ? <Pressable testID={`doctor-repair-open-${invoice.id}`} style={styles.repairButton} onPress={() => onRepair(repairCandidate)}>
              <Text style={styles.secondaryText}>Assign doctor</Text>
            </Pressable> : <Text style={styles.muted}>No doctor profile available for this practice.</Text>}
          </View>}
        </View>
        <TextInput testID={`receive-invoice-amount-${invoice.id}`} editable={!unavailable && invoice.eligibleForPayment !== false} value={draft.applications[invoice.id] ?? ""} onChangeText={(value) => onChange({ applications: { ...draft.applications, [invoice.id]: value } })} placeholder="0.00" placeholderTextColor={colors.textTertiary} keyboardType="decimal-pad" style={[styles.amount, unavailable && styles.disabled]} />
      </View>;
    })}
    <View style={styles.applicationTotals}><Text style={styles.muted}>Monetary applied {formatMoney(applied)}</Text><Text style={styles.muted}>Existing credit {formatMoney(existingCredit)}</Text><Text style={styles.muted}>New credit {formatMoney(credit)}</Text></View>
  </Card>;
}

function Field({ label, value, onChangeText, styles, colors, testID, keyboardType, multiline, prose }: { label: string; value: string; onChangeText: (value: string) => void; styles: ReturnType<typeof makeStyles>; colors: ThemeColors; testID: string; keyboardType?: "decimal-pad" | "number-pad" | "email-address"; multiline?: boolean; prose?: boolean }) {
  // Single-line fields close the keyboard from the return key; multi-line ones
  // keep the return key as a newline.
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput testID={testID} value={value} onChangeText={onChangeText} placeholder={label} placeholderTextColor={colors.textTertiary} keyboardType={keyboardType} multiline={multiline} numberOfLines={multiline ? 4 : 1} returnKeyType={multiline ? undefined : "done"} onSubmitEditing={multiline ? undefined : () => Keyboard.dismiss()} style={[styles.input, multiline && styles.multiline]} autoCorrect={prose ? true : undefined} spellCheck={prose ? true : undefined} autoCapitalize={label.includes("email") ? "none" : "sentences"} /></View>;
}

function Summary({ label, value, styles, strong }: { label: string; value: string; styles: ReturnType<typeof makeStyles>; strong?: boolean }) {
  return <View style={styles.summary}><Text style={styles.muted}>{label}</Text><Text style={[styles.summaryValue, strong && styles.creditText]}>{value}</Text></View>;
}

function Header({ colors, styles }: { colors: ThemeColors; styles: ReturnType<typeof makeStyles> }) {
  return <View style={styles.header}><Pressable testID="receive-back" onPress={() => router.back()} hitSlop={8}><Ionicons name="chevron-back" size={26} color={colors.text} /></Pressable><Text style={styles.headerTitle}>Receive Payments</Text></View>;
}

function ScreenState({ styles, colors, insets, title, body, icon, onRetry }: { styles: ReturnType<typeof makeStyles>; colors: ThemeColors; insets: { top: number }; title: string; body: string; icon: React.ComponentProps<typeof Ionicons>["name"]; onRetry?: () => void }) {
  return <View style={[styles.screen, { paddingTop: insets.top }]}><Header colors={colors} styles={styles} /><View style={styles.empty}><Ionicons name={icon} size={42} color={colors.textTertiary} /><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyBody}>{body}</Text>{onRetry && <Pressable style={styles.secondary} onPress={onRetry}><Text style={styles.secondaryText}>Try again</Text></Pressable>}</View></View>;
}

function ReceivePaymentsWebScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  return (
    <ScreenState
      styles={styles}
      colors={colors}
      insets={{ top: Math.max(insets.top, 67) }}
      title="Open Receive Payments on mobile or desktop"
      body="Secure payment entry is available in the LabTrax iOS and Android apps. In a browser, use Receive Payments in the desktop Financial workspace."
      icon="phone-portrait-outline"
    />
  );
}

export default Platform.OS === "web" ? ReceivePaymentsWebScreen : ReceivePaymentsScreen;

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid }, header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: Spacing.xs }, headerTitle: { ...Typography.h1, color: c.text }, content: { padding: Spacing.lg, gap: Spacing.md }, intro: { gap: 3 }, eyebrow: { ...Typography.label, color: c.tint }, heading: { ...Typography.h1, color: c.text }, subtitle: { ...Typography.caption, color: c.textSecondary }, card: { gap: Spacing.md }, sectionTitle: { ...Typography.bodyLgMedium, color: c.text }, sectionHint: { ...Typography.caption, color: c.textSecondary, marginTop: 2 }, picker: { minHeight: 54, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, padding: Spacing.md, flexDirection: "row", alignItems: "center", gap: Spacing.md }, pickerText: { ...Typography.bodySemibold, color: c.text }, flex: { flex: 1 }, muted: { ...Typography.caption, color: c.textSecondary }, progress: { ...Typography.captionSemibold, color: c.tint }, statementRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md, padding: Spacing.sm, borderRadius: Radius.md }, selectedRow: { backgroundColor: c.tintLight }, radio: { width: 22, height: 22, borderWidth: 1, borderColor: c.border, borderRadius: 11, alignItems: "center", justifyContent: "center" }, radioSelected: { borderColor: c.tint }, radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.tint }, combined: { ...Typography.bodySemibold, color: c.tint, borderTopWidth: 1, borderTopColor: c.border, paddingTop: Spacing.sm }, loading: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: Spacing.sm, padding: Spacing.lg }, twoCol: { flexDirection: "row", gap: Spacing.sm }, field: { flex: 1, gap: Spacing.xs }, fieldLabel: { ...Typography.captionSemibold, color: c.textSecondary }, input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: Radius.md, backgroundColor: c.surfaceAlt, color: c.text, paddingHorizontal: Spacing.md, ...Typography.body }, multiline: { minHeight: 88, paddingTop: Spacing.sm, textAlignVertical: "top" }, methods: { gap: Spacing.sm }, method: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, backgroundColor: c.surfaceAlt }, methodSelected: { borderColor: c.tint, backgroundColor: c.tintLight }, methodText: { ...Typography.captionSemibold, color: c.textSecondary }, methodTextSelected: { color: c.tint }, rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm }, secondary: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, alignSelf: "flex-start", backgroundColor: c.surfaceAlt }, secondaryText: { ...Typography.captionSemibold, color: c.tint }, cardChoices: { gap: Spacing.sm }, saveCardRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm }, invoiceRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.md }, invoiceMeta: { ...Typography.caption, color: c.textSecondary, marginTop: 2 }, checkbox: { width: 22, height: 22, borderRadius: Radius.xs, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center", backgroundColor: c.surface }, checkboxSelected: { backgroundColor: c.tint, borderColor: c.tint }, checkmark: { color: c.textInverse, fontWeight: "700" }, hidden: { color: "transparent" }, amount: { width: 88, minHeight: 40, textAlign: "right", borderWidth: 1, borderColor: c.border, borderRadius: Radius.sm, backgroundColor: c.surfaceAlt, color: c.text, paddingHorizontal: Spacing.sm }, applicationTotals: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.xs, borderTopWidth: 1, borderTopColor: c.border, paddingTop: Spacing.sm }, summary: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, summaryValue: { ...Typography.body, color: c.text }, creditText: { color: c.successStrong }, credit: { ...Typography.caption, color: c.successStrong, backgroundColor: c.successLight, borderRadius: Radius.sm, padding: Spacing.sm }, error: { ...Typography.caption, color: c.error, backgroundColor: c.errorSurface, borderRadius: Radius.sm, padding: Spacing.sm }, warning: { ...Typography.caption, color: c.warningStrong, backgroundColor: c.warningLight, borderRadius: Radius.sm, padding: Spacing.sm }, primary: { minHeight: 48, borderRadius: Radius.full, backgroundColor: c.tint, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.sm }, primaryText: { ...Typography.bodySemibold, color: c.textInverse }, disabled: { opacity: 0.55 }, accountOption: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: Spacing.md }, done: { ...Typography.captionSemibold, color: c.successStrong }, receiptActions: { flexDirection: "row", gap: Spacing.sm }, empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.sm, padding: Spacing.xxxl }, emptyTitle: { ...Typography.h2, color: c.text, textAlign: "center" }, emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center", maxWidth: 320 }, legacyRepair: { marginTop: Spacing.sm, alignItems: "flex-start", gap: Spacing.xs }, legacyBadge: { ...Typography.captionSemibold, color: c.warningStrong, backgroundColor: c.warningLight, borderRadius: Radius.full, paddingHorizontal: Spacing.sm, paddingVertical: 3 }, repairButton: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.full, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, backgroundColor: c.surfaceAlt }, historyRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: Spacing.sm, gap: 2 },
  });
}
