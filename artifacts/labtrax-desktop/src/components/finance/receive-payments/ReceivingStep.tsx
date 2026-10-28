import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CheckCircle2, Info, Loader2 } from "lucide-react";
import { FINANCE_INVOICES_QUERY_KEY, type ReceivePaymentsInputPaymentMethod } from "@workspace/api-client-react";
import { Elements, PaymentElement } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { apiFetch, apiFetchArrayBuffer } from "@/lib/api";
import { trackSavedCardSetup } from "@/lib/analytics";
import { formatDate, formatMoney } from "@/lib/format";
import { useBatchedListReset } from "@/hooks/useBatchedListReset";
import { refreshInvoiceSalesQueries } from "@/lib/refresh-case-finance";
import { computeShiftClickRange } from "@/lib/shift-click-range";
import {
  cardHelpReason,
  trackInlineCardPaymentCancelled,
  trackInlineCardPaymentNeedsHelp,
  trackInlineCardPaymentStarted,
  trackInlineCardPaymentSucceeded,
} from "@/lib/inline-card-payment-analytics";
import type { Invoice } from "@/lib/types";
import { InvoiceEditor } from "@/pages/invoices";
import { CustomerQueuePicker } from "./CustomerQueuePicker";
import { InvoiceAllocationTable } from "./InvoiceAllocationTable";
import { ReceiptDialog } from "./ReceiptDialog";
import { StripeCapture, type ElementsInstance, type StripeInstance } from "./StripeCapture";
import { defaultScope, deselectCustomers, scopeFor, selectCustomers, type PayableCustomer } from "./model";
import {
  AUTOMATIC_CARD_ATTEMPT_MESSAGE,
  DEFAULT_BODY,
  DEFAULT_SUBJECT,
  PAYMENT_METHODS,
  SUPPORT_CARD_ATTEMPT_MESSAGE,
  allocateOldestFirst,
  batchDraft,
  draftWithDefaults,
  normalizeDoctorName,
  paymentErrorMessage,
  paymentMethodLabel,
  sessionFromResponse,
  type Draft,
  type LegacySessionResponse,
  type Session,
  type Statement,
  type StatementPage,
} from "./payments";
import type { CustomerScope, PaymentDefaults, PaymentOptions, Selection, StatementInvoice } from "./types";
import { Label, Row, fieldClass } from "./ui";

type StatementDetail = Statement & { invoices: StatementInvoice[] };

const PAGE_SIZE = 10;
/** Stable identity for an unloaded batch. */
const EMPTY_STATEMENTS: Statement[] = [];

const OVERPAYMENT_BLOCKED_MESSAGE =
  "Overpayment is turned off for this batch. Apply the full amount received to invoices, or lower the amount received.";

function broadcastUndepositedChange() {
  try {
    const channel = new BroadcastChannel("labtrax:finance");
    channel.postMessage("undeposited-changed");
    channel.close();
  } catch {
    /* unsupported */
  }
}

/**
 * Receives the selected customers one at a time: progress and the queue, the
 * current customer's invoices, and that customer's payment prefilled from the
 * Payment Summary. Each customer's payment, check or reference number, card
 * charge and receipt stay separate.
 */
export function ReceivingStep({
  labOrganizationId,
  cardConfigurationError,
  stripePromise,
  customers,
  customersById,
  selection,
  onSelectionChange,
  completed,
  onCompletedChange,
  defaults,
  options,
  onBack,
  onFinished,
  refetchEligible,
}: {
  labOrganizationId: string;
  cardConfigurationError: string | null;
  stripePromise: Promise<Stripe | null> | null;
  /** Customers the queue can add or remove, sorted by name. */
  customers: readonly PayableCustomer[];
  /** Live customers over the batch-start snapshot, so received customers keep their names. */
  customersById: ReadonlyMap<string, PayableCustomer>;
  selection: Selection;
  onSelectionChange: (update: (current: Selection) => Selection) => void;
  /** Customers whose payment was recorded (or cancelled) in this batch. */
  completed: readonly string[];
  onCompletedChange: Dispatch<SetStateAction<string[]>>;
  defaults: PaymentDefaults;
  options: PaymentOptions;
  onBack: () => void;
  /** Called after the last customer; the page moves on to Make Deposits. */
  onFinished: () => void;
  refetchEligible: () => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const stripeRef = useRef<StripeInstance>(null);
  const elementsRef = useRef<ElementsInstance>(null);
  const selected = selection.ids;
  const [active, setActive] = useState(() => selection.ids.find((id) => !completed.includes(id)) ?? "");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [cardSetupSessionId, setCardSetupSessionId] = useState<string | null>(null);
  const cardSetupTerminalEventsRef = useRef<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [receipt, setReceipt] = useState<Session | null>(null);
  const [composing, setComposing] = useState(false);
  const [receiptTo, setReceiptTo] = useState("");
  const [receiptSubject, setReceiptSubject] = useState(DEFAULT_SUBJECT);
  const [receiptBody, setReceiptBody] = useState(DEFAULT_BODY);
  const [stripeReadyKey, setStripeReadyKey] = useState<string | null>(null);
  const trackedCancellationSessionId = useRef<string | null>(null);
  const [repairSelections, setRepairSelections] = useState<Record<string, string>>({});
  const [repairError, setRepairError] = useState<string | null>(null);
  // Batches are anchored on the last statement already received (a keyset
  // cursor), so a statement generated mid-scroll cannot shift the window.
  const [statementCursor, setStatementCursor] = useState<string | null>(null);
  // Statements accumulate against the account they belong to, so switching
  // accounts empties the list until that account's first batch lands.
  const [loaded, setLoaded] = useState<{ key: string; rows: Statement[]; total: number }>({
    key: "",
    rows: [],
    total: 0,
  });
  const invoiceAnchor = useRef<string | null>(null);
  useEffect(() => {
    invoiceAnchor.current = null;
    setError(null);
  }, [active]);

  const customer = active ? customersById.get(active) ?? null : null;
  const providerOrganizationId = customer?.account.providerOrganizationId ?? active;
  const statementsQuery = `limit=${PAGE_SIZE}${statementCursor ? `&cursor=${encodeURIComponent(statementCursor)}` : ""}`;
  const statements = useQuery({
    queryKey: ["billing", "statements", labOrganizationId, providerOrganizationId, statementsQuery],
    enabled: !!active,
    queryFn: async () => {
      const query = statementsQuery;
      const requestCursor = statementCursor;
      const response = await apiFetch<StatementPage | Statement[]>(
        `/billing/${labOrganizationId}/accounts/${providerOrganizationId}/statements?${query}`,
      );
      const result = Array.isArray(response)
        ? { rows: response, total: response.length, limit: response.length, offset: 0, hasMore: false, nextCursor: null }
        : response;
      return { ...result, query, requestCursor };
    },
  });
  const statementsBase = `${labOrganizationId}/${providerOrganizationId}`;
  const [pagedStatementsBase, setPagedStatementsBase] = useState(statementsBase);
  if (pagedStatementsBase !== statementsBase) {
    setPagedStatementsBase(statementsBase);
    setStatementCursor(null);
  }
  const restartStatements = useCallback(() => setStatementCursor(null), []);
  useBatchedListReset("billing", restartStatements);
  useEffect(() => {
    const result = statements.data;
    if (!result || result.query !== statementsQuery) return;
    setLoaded((previous) => ({
      key: statementsBase,
      rows:
        previous.key === statementsBase && result.requestCursor
          ? [...previous.rows.filter((row) => !result.rows.some((next) => next.id === row.id)), ...result.rows]
          : result.rows,
      total: result.total,
    }));
  }, [statements.data, statementsQuery, statementsBase]);
  const loadedStatements = loaded.key === statementsBase ? loaded.rows : EMPTY_STATEMENTS;

  const account = customer?.account;
  const providerName = customer?.practiceName || customer?.account.providerName || customer?.name || "Select customer…";
  const scope = customer ? scopeFor(selection, customer) : null;
  const eligibleActiveStatementId = account?.statementId ?? undefined;
  const availableStatements = loadedStatements.filter(
    (statement) => statement.id === eligibleActiveStatementId && Number(statement.savedBalanceDue) > 0,
  );
  // A customer starts from the Payment Summary defaults and the invoices
  // picked on the selection screen. Later selection edits must not replace
  // the draft (or its idempotency key), so this follows the customer only.
  const fallbackDraft = useMemo(
    () => (customer ? batchDraft(customer, scopeFor(selection, customer), defaults) : draftWithDefaults("", defaults)),
    [active],
  );
  const draft = drafts[active] ?? fallbackDraft;
  useEffect(() => {
    if (!active) return;
    setDrafts((current) => (current[active] ? current : { ...current, [active]: fallbackDraft }));
  }, [active, fallbackDraft]);

  const statementDetail = useQuery({
    queryKey: ["billing", "statement", draft.statementId],
    enabled: !!draft.statementId,
    queryFn: () => apiFetch<StatementDetail>(`/billing/statements/${draft.statementId}`),
  });
  // The payable statement may be older than the first history batch. Its
  // detail request is authoritative, so include it in the chooser rather than
  // making payment eligibility depend on which history pages were loaded.
  const selectableStatements =
    statementDetail.data &&
    statementDetail.data.id === eligibleActiveStatementId &&
    Number(statementDetail.data.savedBalanceDue) > 0 &&
    !availableStatements.some((statement) => statement.id === statementDetail.data!.id)
      ? [...availableStatements, statementDetail.data]
      : availableStatements;
  const statementTotal = loaded.key === statementsBase ? loaded.total : 0;
  const credits = useQuery({
    queryKey: ["billing", "customer-credits", labOrganizationId, providerOrganizationId],
    enabled: !!active,
    queryFn: () =>
      apiFetch<{ totalAvailable: string; credits: unknown[] }>(
        `/billing/${labOrganizationId}/accounts/${providerOrganizationId}/customer-credits`,
      ),
  });
  const savedCard = useQuery({
    queryKey: ["provider-lab-card", labOrganizationId, providerOrganizationId],
    enabled: !!active,
    queryFn: () =>
      apiFetch<{ card?: { brand: string; last4: string } | null }>(
        `/provider/lab-card?labOrganizationId=${encodeURIComponent(labOrganizationId)}&providerOrganizationId=${encodeURIComponent(providerOrganizationId)}`,
      ),
  });
  useEffect(() => {
    if (!savedCard.isLoading && !savedCard.data?.card && draft.cardChoice === "saved") update({ cardChoice: "new" });
  }, [savedCard.isLoading, savedCard.data?.card, active]);
  useEffect(() => {
    const refreshCard = async () => {
      if (cardSetupSessionId) {
        try {
          const result = await apiFetch<{ status: "succeeded" | "pending" | "expired" }>(
            `/provider/lab-card/setup-status/${encodeURIComponent(cardSetupSessionId)}?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
          );
          if (result.status !== "pending") {
            if (!cardSetupTerminalEventsRef.current.has(cardSetupSessionId)) {
              cardSetupTerminalEventsRef.current.add(cardSetupSessionId);
              trackSavedCardSetup(result.status);
            }
            setCardSetupSessionId(null);
          }
          if (result.status === "expired") setError("Secure card setup expired. Start again to add a card.");
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not verify secure card setup.");
        }
      }
      void savedCard.refetch();
    };
    window.addEventListener("focus", refreshCard);
    return () => window.removeEventListener("focus", refreshCard);
  }, [savedCard.refetch, cardSetupSessionId, labOrganizationId]);

  // A selected statement scopes the payment to its own invoices: the server
  // rejects monetary applications to invoices outside it. The account-wide
  // outstanding list belongs to the invoice-led choice ("No statement").
  const allInvoices: StatementInvoice[] = draft.statementId
    ? statementDetail.data?.invoices || []
    : (account?.outstandingInvoices ?? []).map((invoice) => ({
        ...invoice,
        total: invoice.total || invoice.invoiceAmount,
        currentBalanceDue: invoice.currentBalanceDue || invoice.currentDue,
        eligibleForPayment: true,
      }));
  // Invoices picked on the selection screen limit what this payment shows.
  const scopeInvoiceIds = draft.scopeInvoiceIds ?? null;
  const inScope = (invoice: StatementInvoice) => !scopeInvoiceIds || scopeInvoiceIds.includes(invoice.id);
  const forDoctor = (invoice: StatementInvoice) =>
    (!draft.doctorIdentity && !draft.doctorName) ||
    (draft.doctorIdentity
      ? invoice.doctorIdentity === draft.doctorIdentity ||
        (!invoice.doctorIdentity &&
          normalizeDoctorName(invoice.doctorDisplayName || invoice.doctorName || invoice.doctor) ===
            draft.doctorIdentity)
      : !invoice.doctorIdentity &&
        normalizeDoctorName(invoice.doctorDisplayName || invoice.doctorName || invoice.doctor) ===
          normalizeDoctorName(draft.doctorName));
  const statementInvoices = allInvoices.filter(inScope);
  const open: StatementInvoice[] = statementInvoices
    .filter((invoice) => invoice.eligibleForPayment !== false)
    .filter(forDoctor);
  const unavailableInvoices = statementInvoices.filter((invoice) => invoice.eligibleForPayment === false);
  const invoiceRows = [...open, ...unavailableInvoices];
  const scopeHiddenCount = scopeInvoiceIds
    ? allInvoices.filter((invoice) => invoice.eligibleForPayment !== false && forDoctor(invoice) && !inScope(invoice))
        .length
    : null;
  const doctorOptions = useMemo(() => {
    if (account?.doctors?.length) {
      return [...account.doctors].sort((a, b) => a.doctorDisplayName.localeCompare(b.doctorDisplayName));
    }
    const names = (account?.outstandingInvoices || statementDetail.data?.invoices || [])
      .filter((invoice) => invoice.eligibleForPayment !== false)
      .map((invoice) => (invoice.doctorDisplayName || invoice.doctorName || invoice.doctor || "").trim())
      .filter(Boolean);
    return [
      ...new Map(
        names.map((name) => [normalizeDoctorName(name), { doctorIdentity: null as string | null, doctorDisplayName: name }]),
      ).values(),
    ].sort((a, b) => a.doctorDisplayName.localeCompare(b.doctorDisplayName));
  }, [account?.doctors, account?.outstandingInvoices, statementDetail.data?.invoices]);

  const update = (change: Partial<Draft>) => {
    if (!active) return;
    setDrafts((current) => ({ ...current, [active]: { ...(current[active] ?? fallbackDraft), ...change } }));
  };
  const generatedReference = useMemo(() => {
    const period = statementDetail.data?.periodStart || account?.periodStart || statementDetail.data?.periodEnd;
    const date = period ? new Date(period) : new Date();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const year = String(date.getUTCFullYear());
    const names = (
      draft.doctorName
        ? (open.map((invoice) => invoice.doctorDisplayName || invoice.doctorName || invoice.doctor).filter(Boolean) as string[])
        : account?.doctorNames || (open.map((invoice) => invoice.doctorName || invoice.doctor).filter(Boolean) as string[])
    )
      .map((name) => String(name).trim().split(/\s+/).pop() || "")
      .filter(Boolean)
      .filter((name, index, all) => all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index)
      .join("")
      .toUpperCase();
    const suffix = draft.paymentMethod === "card" ? "CC" : draft.paymentMethod === "ach" ? "ACH" : "CK";
    return `${month}-${year}${names}PMT${suffix}`;
  }, [account, draft.doctorName, draft.paymentMethod, open, statementDetail.data?.periodEnd, statementDetail.data?.periodStart]);
  // A statement payment starts as the statement's full (scoped) balance once
  // its invoices load.
  useEffect(() => {
    if (!active || !draft.statementId || !open.length) return;
    const balance = open.reduce((sum, invoice) => sum + Number(invoice.currentBalanceDue || 0), 0);
    setDrafts((current) => {
      const existing = current[active] || draft;
      if (existing.totalReceived || balance <= 0) return current;
      return {
        ...current,
        [active]: {
          ...existing,
          totalReceived: balance.toFixed(2),
          referenceNumber: generatedReference,
          generatedReference,
          applications: allocateOldestFirst(open, balance),
        },
      };
    });
  }, [active, draft.statementId, open, generatedReference]);
  useEffect(() => {
    if (!active || !draft.statementId) return;
    const visible = new Set(open.map((invoice) => invoice.id));
    setDrafts((current) => {
      const existing = current[active] || draft;
      const applications = Object.fromEntries(Object.entries(existing.applications).filter(([id]) => visible.has(id)));
      const creditApplications = Object.fromEntries(
        Object.entries(existing.creditApplications).filter(([id]) => visible.has(id)),
      );
      if (
        Object.keys(applications).length === Object.keys(existing.applications).length &&
        Object.keys(creditApplications).length === Object.keys(existing.creditApplications).length
      ) {
        return current;
      }
      return { ...current, [active]: { ...existing, applications, creditApplications } };
    });
  }, [active, draft.statementId, draft.doctorName, open]);
  useEffect(() => {
    if (!active || !draft.statementId || !draft.generatedReference) return;
    if (draft.referenceNumber === draft.generatedReference && draft.referenceNumber !== generatedReference) {
      update({ referenceNumber: generatedReference, generatedReference });
    }
  }, [generatedReference, draft.generatedReference, draft.referenceNumber, active, draft.statementId]);

  /** Keeps the shared selection's scope for the current customer in step with its draft. */
  const setActiveScope = (next: CustomerScope) => {
    if (!active) return;
    const id = active;
    onSelectionChange((current) =>
      current.ids.includes(id) ? { ...current, scopes: { ...current.scopes, [id]: next } } : current,
    );
  };
  const selectStatement = (statementId: string) => {
    invoiceAnchor.current = null;
    if (!active) return;
    setDrafts((current) => ({ ...current, [active]: draftWithDefaults(statementId, defaults) }));
    setActiveScope({ mode: statementId ? "statement" : "invoices", invoiceIds: null });
  };
  const showAllInvoices = () => {
    update({ scopeInvoiceIds: null });
    if (scope) setActiveScope({ ...scope, invoiceIds: null });
  };

  const applied = Object.values(draft.applications).reduce((n, v) => n + (Number(v) || 0), 0);
  const received = Number(draft.totalReceived) || 0;
  // Only money actually taken by card is a card charge. The server keeps card
  // charges on their own routes and refuses them on the ordinary receipt
  // route, while its saved-card route refuses every other method. Check, cash,
  // ACH, other, and a credit-only application (nothing received) are ordinary
  // receipts whatever method is selected.
  const chargesCard = draft.paymentMethod === "card" && received > 0;
  // A credit-only application with Card selected charges nothing, so it is not
  // recorded as a card payment. The server cancels every card receipt as a
  // processor charge, which needs the charge's Undeposited Funds entry; a
  // credit-only "card" receipt has none, so it could never be cancelled and its
  // customer credit never restored. Record it under the neutral "Other".
  const recordedPaymentMethod: ReceivePaymentsInputPaymentMethod =
    draft.paymentMethod === "card" && !chargesCard ? "other" : draft.paymentMethod;
  const existingCredit = Number(draft.existingCreditAmount) || 0;
  const creditApplications = Object.values(draft.creditApplications).reduce((n, v) => n + (Number(v) || 0), 0);
  const overApplied = applied > received + 0.005;
  const overCreditApplied = creditApplications > Number(credits.data?.totalAvailable || 0) + 0.005;
  const overInvoiceBalance = open.some(
    (invoice) =>
      (Number(draft.applications[invoice.id]) || 0) + (Number(draft.creditApplications[invoice.id]) || 0) >
      Number(invoice.currentBalanceDue) + 0.005,
  );
  // Money received beyond what is applied becomes customer credit, unless the
  // Payment Summary turned overpayment off for this batch.
  const unapplied = received - applied;
  const overpaymentBlocked = !options.allowOverpayment && unapplied > 0.005;
  const applyOldestFirst = (amount: number) => update({ applications: allocateOldestFirst(open, amount) });
  const totalChange = (value: string) => {
    if (!options.applyOldestFirst) {
      update({ totalReceived: value });
      return;
    }
    const n = Number(value);
    update({ totalReceived: value, applications: n > 0 ? allocateOldestFirst(open, n) : {} });
  };
  const autoApply = () => {
    const n = received || open.reduce((sum, invoice) => sum + (Number(invoice.currentBalanceDue) || 0), 0);
    if (!received) update({ totalReceived: n.toFixed(2) });
    applyOldestFirst(n);
  };
  const setApplication = (id: string, value: string) => {
    if (!open.some((invoice) => invoice.id === id && invoice.eligibleForPayment !== false)) return;
    update({ applications: { ...draft.applications, [id]: value } });
  };
  const toggleInvoice = (invoice: StatementInvoice, checked: boolean, shifted: boolean) => {
    if (invoice.eligibleForPayment === false) return;
    if (shifted) {
      const ids = computeShiftClickRange(
        open.map((row) => row.id),
        invoiceAnchor.current,
        invoice.id,
      );
      if (ids) {
        const applications = { ...draft.applications };
        ids.forEach((id) => {
          const row = open.find((candidate) => candidate.id === id);
          if (row && !(Number(applications[id]) > 0)) applications[id] = Number(row.currentBalanceDue).toFixed(2);
        });
        update({ applications });
        return;
      }
    }
    setApplication(invoice.id, checked ? Number(invoice.currentBalanceDue).toFixed(2) : "");
    invoiceAnchor.current = invoice.id;
  };
  const refreshInvoices = () => {
    void refetchEligible();
    if (draft.statementId) void statementDetail.refetch();
  };
  const repairDoctor = useMutation({
    mutationFn: async ({ invoiceId, doctorProfileId }: { invoiceId: string; doctorProfileId: string }) =>
      apiFetch<Invoice>(`/invoices/${encodeURIComponent(invoiceId)}/repair-doctor`, {
        method: "PATCH",
        body: JSON.stringify({ doctorProfileId }),
      }),
    onSuccess: async () => {
      void refreshInvoiceSalesQueries(qc);
      setRepairError(null);
      setRepairSelections({});
      await Promise.all([refetchEligible(), draft.statementId ? statementDetail.refetch() : null]);
      qc.invalidateQueries({ queryKey: FINANCE_INVOICES_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["billing", "payments-recent"] });
    },
    onError: (e: Error) => setRepairError(e.message),
  });

  const template = useQuery({
    queryKey: ["billing", "payment-receipt-template", labOrganizationId],
    enabled: !!receipt,
    retry: false,
    queryFn: () =>
      apiFetch<{ emailSubject: string; emailBody: string }>(`/billing/${labOrganizationId}/payment-receipt-template`),
  });
  useEffect(() => {
    if (receipt) {
      setReceiptTo(receipt.customerEmail || "");
      setReceiptSubject(template.data?.emailSubject || DEFAULT_SUBJECT);
      setReceiptBody(template.data?.emailBody || DEFAULT_BODY);
    }
  }, [receipt, template.data]);
  const receiptSession = useQuery({
    queryKey: ["billing", "payment-session", receipt?.id],
    enabled: !!receipt?.id,
    queryFn: async () =>
      sessionFromResponse(
        await apiFetch<Session | LegacySessionResponse>(`/billing/payment-sessions/${encodeURIComponent(receipt!.id)}`),
      ),
    refetchInterval: (query) => (query.state.data?.reversal?.status === "pending" ? 2_000 : false),
  });
  const displayedReceipt = receiptSession.data || receipt;
  const reversalCompleted = displayedReceipt?.reversal?.status === "completed";
  const invalidatePaymentViews = () => {
    void refreshInvoiceSalesQueries(qc);
    qc.invalidateQueries({ queryKey: FINANCE_INVOICES_QUERY_KEY });
    qc.invalidateQueries({ queryKey: ["finance"] });
    qc.invalidateQueries({ queryKey: ["billing", "statement"] });
    qc.invalidateQueries({ queryKey: ["billing", "statements"] });
    qc.invalidateQueries({ queryKey: ["billing", "customer-credits"] });
    qc.invalidateQueries({ queryKey: ["provider-lab-card", labOrganizationId, providerOrganizationId] });
    qc.invalidateQueries({ queryKey: ["billing", "eligible-statement-accounts"] });
    qc.invalidateQueries({ queryKey: ["billing", "eligible-invoice-accounts"] });
  };
  useEffect(() => {
    if (!reversalCompleted) return;
    invalidatePaymentViews();
    if (receipt?.id && chargesCard && trackedCancellationSessionId.current !== receipt.id) {
      trackedCancellationSessionId.current = receipt.id;
      trackInlineCardPaymentCancelled(draft.cardChoice);
    }
  }, [reversalCompleted, receipt?.id, chargesCard, draft.cardChoice]);

  /** Marks the current customer done and opens the next one, or finishes the batch. */
  const advance = () => {
    const done = completed.includes(active) ? [...completed] : [...completed, active];
    onCompletedChange(done);
    const next = selected.find((id) => !done.includes(id));
    if (next) setActive(next);
    else onFinished();
  };
  /** Closes the receipt, drops the finished customer's draft and moves on. */
  const finishCustomer = () => {
    const id = active;
    setReceipt(null);
    setReceiptError(null);
    setComposing(false);
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    advance();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (received > 0 && draft.paymentMethod === "check" && !draft.referenceNumber.trim()) {
        throw new Error("Check number is required for check payments.");
      }
      if (received > 0 && draft.paymentMethod === "card" && draft.cardChoice === "saved" && !savedCard.data?.card?.last4) {
        throw new Error("Add a saved card before charging.");
      }
      if (received > 0 && draft.paymentMethod === "card" && draft.cardChoice === "new" && !draft.cardholderName.trim()) {
        throw new Error("Cardholder name is required.");
      }
      if ((draft.paymentMethod === "ach" || draft.paymentMethod === "other") && received > 0 && !draft.referenceNumber.trim()) {
        throw new Error("Reference number is required for ACH and other payments.");
      }
      if (overApplied) throw new Error("Applied total exceeds the payment amount received.");
      if (overpaymentBlocked) throw new Error(OVERPAYMENT_BLOCKED_MESSAGE);
      const applicationIds = new Set([...Object.keys(draft.applications), ...Object.keys(draft.creditApplications)]);
      const applications = [...applicationIds]
        .map((invoiceId) => ({
          invoiceId,
          amount: Number(draft.applications[invoiceId]) || 0,
          creditAmount: Number(draft.creditApplications[invoiceId]) || 0,
        }))
        .filter((application) => application.amount > 0 || application.creditAmount > 0);
      if (received <= 0 && existingCredit <= 0 && creditApplications <= 0) {
        throw new Error("Enter a monetary amount or apply available customer credit.");
      }
      const payload = {
        labOrganizationId,
        providerOrganizationId,
        doctorIdentity: draft.doctorIdentity,
        doctorName: draft.doctorName,
        statementId: draft.statementId || null,
        receivedAmount: received,
        existingCreditAmount: Math.max(existingCredit, creditApplications),
        paymentDate: new Date(draft.paymentDate).toISOString(),
        paymentMethod: recordedPaymentMethod,
        checkNumber: draft.paymentMethod === "check" && received > 0 ? draft.referenceNumber.trim() : null,
        referenceNumber:
          (draft.paymentMethod === "ach" || draft.paymentMethod === "other") && received > 0
            ? draft.referenceNumber.trim()
            : null,
        cardLast4: chargesCard && draft.cardChoice === "saved" ? savedCard.data?.card?.last4 : null,
        memo: draft.memo.trim() || null,
        idempotencyKey: draft.idempotencyKey,
        applications,
      };
      if (chargesCard && draft.cardChoice === "new") {
        if (creditApplications > 0) {
          throw new Error("Apply existing customer credit separately before charging a new card.");
        }
        const stripe = stripeRef.current;
        const elements = elementsRef.current;
        if (!stripe || !elements) throw new Error("Card payments are not configured. Please try again.");
        trackInlineCardPaymentStarted("new");
        const inlinePayload = {
          labOrganizationId,
          providerOrganizationId,
          doctorIdentity: draft.doctorIdentity,
          doctorName: draft.doctorName,
          statementId: draft.statementId || null,
          receivedAmount: received,
          existingCreditAmount: 0,
          paymentDate: new Date(draft.paymentDate).toISOString(),
          paymentMethod: "card" as const,
          memo: draft.memo.trim() || null,
          idempotencyKey: draft.idempotencyKey,
          savePaymentMethod: draft.saveCard,
          applications,
        };
        const storageKey = `labtrax:receive-card:${labOrganizationId}:${active}:${draft.idempotencyKey}`;
        // Always replay prepare before confirmation. The server binds this
        // idempotency key to the complete canonical draft and rejects edits
        // before Stripe can confirm an older amount or allocation.
        const prepared = await apiFetch<{ clientSecret: string; paymentIntentId: string; status?: string }>(
          "/billing/payment-sessions/card/prepare",
          { method: "POST", body: JSON.stringify(inlinePayload) },
        );
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(prepared));
        } catch {
          /* storage is best effort */
        }
        let result: { paymentIntent?: { id: string }; error?: { message?: string } } = {};
        let confirmationError: Error | null = null;
        const shouldConfirmWithStripe = prepared.status !== "succeeded" && prepared.status !== "processing";
        if (shouldConfirmWithStripe) {
          const submitted = await elements.submit();
          if (submitted.error) throw new Error(submitted.error.message || "Check your card details.");
          try {
            const stripeResult = await stripe.confirmPayment({
              elements,
              clientSecret: prepared.clientSecret,
              confirmParams: {
                return_url: window.location.href,
                payment_method_data: {
                  billing_details: { name: draft.cardholderName.trim() },
                },
              },
              redirect: "if_required",
            });
            result = stripeResult;
          } catch (e) {
            confirmationError = e instanceof Error ? e : new Error("Card confirmation status is ambiguous.");
          }
        }
        let confirmed: Session | LegacySessionResponse | { status?: string };
        try {
          confirmed = await apiFetch<Session | LegacySessionResponse | { status?: string }>(
            "/billing/payment-sessions/card/confirm",
            {
              method: "POST",
              body: JSON.stringify({
                ...inlinePayload,
                paymentIntentId: result.paymentIntent?.id || prepared.paymentIntentId,
              }),
            },
          );
        } catch (confirmError) {
          if (result.error) throw new Error(result.error.message || "Card payment was not completed.");
          if (confirmationError) throw new Error(SUPPORT_CARD_ATTEMPT_MESSAGE);
          throw confirmError;
        }
        const session = sessionFromResponse(confirmed as Session | LegacySessionResponse);
        // LabTrax's server receipt is authoritative. Stripe.js may report a
        // network/confirmation error after Stripe and the webhook have
        // already completed the processor and accounting work.
        if (session.id) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            /* storage is best effort */
          }
          return session;
        }
        if (result.error || confirmationError) {
          const authoritative = "status" in confirmed ? confirmed.status : undefined;
          throw new Error(
            authoritative === "processing"
              ? AUTOMATIC_CARD_ATTEMPT_MESSAGE
              : authoritative === "requires_action"
                ? "The card requires additional authentication. Complete the Stripe prompt, then retry."
                : result.error?.message ||
                  (confirmationError ? SUPPORT_CARD_ATTEMPT_MESSAGE : "Card payment could not be completed."),
          );
        }
        const status = "status" in confirmed ? confirmed.status : undefined;
        throw new Error(
          status === "processing"
            ? AUTOMATIC_CARD_ATTEMPT_MESSAGE
            : status === "requires_action"
              ? "The card requires additional authentication. Complete the Stripe prompt, then retry."
              : SUPPORT_CARD_ATTEMPT_MESSAGE,
        );
      }
      if (chargesCard) {
        trackInlineCardPaymentStarted("saved");
        return sessionFromResponse(
          await apiFetch<Session | LegacySessionResponse>("/billing/payment-sessions/card", {
            method: "POST",
            body: JSON.stringify(payload),
          }),
        );
      }
      return sessionFromResponse(
        await apiFetch<Session | LegacySessionResponse>("/billing/payment-sessions", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );
    },
    onSuccess: (result) => {
      if (chargesCard) {
        trackInlineCardPaymentSucceeded(draft.cardChoice);
      }
      qc.setQueryData(["billing", "payment-session", result.id], result);
      invalidatePaymentViews();
      broadcastUndepositedChange();
      setReceiptError(null);
      // "Email receipts to customers" opens the receipt on its prefilled
      // email; nothing is sent until the user presses Email receipt.
      setComposing(options.emailReceipts);
      setReceipt(result);
    },
    onError: (e: Error) => {
      if (chargesCard) {
        const reason = cardHelpReason(e);
        if (reason) trackInlineCardPaymentNeedsHelp(draft.cardChoice, reason);
      }
      setError(paymentErrorMessage(e));
    },
  });
  const send = useMutation({
    mutationFn: async () => {
      const result = await apiFetch<{ delivered: boolean; reason?: string | null }>(
        `/billing/payment-sessions/${receipt!.id}/send-receipt`,
        { method: "POST", body: JSON.stringify({ to: receiptTo, subject: receiptSubject, body: receiptBody }) },
      );
      if (!result.delivered) throw new Error(result.reason || "The receipt email could not be delivered.");
      return result;
    },
    onSuccess: () => finishCustomer(),
    onError: (e: Error) => setReceiptError(e.message),
  });
  const cancel = useMutation({
    mutationFn: async () =>
      sessionFromResponse(
        await apiFetch<Session | LegacySessionResponse>(`/billing/payment-sessions/${receipt!.id}`, { method: "DELETE" }),
      ),
    onSuccess: (result) => {
      if (chargesCard && (!result.reversal || result.reversal.status === "completed")) {
        trackedCancellationSessionId.current = receipt!.id;
        trackInlineCardPaymentCancelled(draft.cardChoice);
      }
      if (result.reversal) {
        qc.setQueryData(["billing", "payment-session", receipt!.id], result);
        setReceipt(result);
        if (result.reversal.status === "completed") invalidatePaymentViews();
        return;
      }
      invalidatePaymentViews();
      qc.invalidateQueries({ queryKey: ["billing"] });
      broadcastUndepositedChange();
      finishCustomer();
    },
    onError: (e: Error) => setReceiptError(e.message),
  });
  const download = async () => {
    if (!receipt) return;
    try {
      const { buffer } = await apiFetchArrayBuffer(`/billing/payment-sessions/${receipt.id}/receipt.pdf`);
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${receipt.receiptNumber || "payment-receipt"}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : "The receipt PDF could not be downloaded.");
    }
  };

  // Queue edits wait while a payment is saving or its receipt is open.
  const locked = save.isPending || !!receipt;
  const toggleQueued = (target: PayableCustomer) => {
    if (locked || completed.includes(target.id)) return;
    if (selected.includes(target.id)) {
      if (target.id === active) {
        setActive(selected.find((id) => id !== target.id && !completed.includes(id)) ?? "");
      }
      // The removed customer's draft is kept, so adding them back resumes it.
      onSelectionChange((current) => deselectCustomers(current, [target.id]));
      return;
    }
    const kept = drafts[target.id];
    const restored: CustomerScope = kept
      ? { mode: kept.statementId ? "statement" : "invoices", invoiceIds: kept.scopeInvoiceIds ?? null }
      : defaultScope(target);
    onSelectionChange((current) => {
      if (current.ids.includes(target.id)) return current;
      const next = selectCustomers(current, [target]);
      return { ...next, scopes: { ...next.scopes, [target.id]: restored } };
    });
    if (!active) setActive(target.id);
  };
  const back = () => {
    if (locked) return;
    // Received customers leave the selection so they cannot be paid twice;
    // the rest stay selected with their scopes.
    if (completed.length) {
      const done = [...completed];
      onSelectionChange((current) => deselectCustomers(current, done));
    }
    onCompletedChange([]);
    onBack();
  };

  const amountCents = Math.max(1, Math.round(received * 100));
  const cardElementsKey = `${active}:${draft.idempotencyKey}:${amountCents}`;
  const scopeSummary = draft.doctorName ? `${draft.doctorName} · ${providerName}` : `Entire practice · ${providerName}`;
  const pickerLabel = selected.length === 1 ? providerName : `${selected.length} customers selected`;
  const activeIndex = selected.indexOf(active);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 rounded-xl border border-border bg-card p-3 shadow-sm">
        <button
          type="button"
          onClick={back}
          disabled={locked}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-secondary disabled:opacity-60"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to customers
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <div className="w-full max-w-xs">
              <Label>Received from</Label>
              <CustomerQueuePicker
                customers={customers}
                selectedIds={selected}
                completedIds={completed}
                label={pickerLabel}
                locked={locked}
                onToggle={toggleQueued}
              />
            </div>
            {selected.length > 1 && active && (
              <p data-testid="receive-practice-progress" className="pb-2 text-xs font-medium text-muted-foreground">
                Customer {activeIndex + 1} of {selected.length}: {customer?.name || providerName}
              </p>
            )}
          </div>
          {selected.length > 0 && (
            <ol data-testid="receive-queue" aria-label="Customers in this batch" className="flex flex-wrap gap-1.5">
              {selected.map((id, index) => {
                const status = completed.includes(id) ? "done" : id === active ? "current" : "waiting";
                return (
                  <li
                    key={id}
                    aria-current={status === "current" ? "step" : undefined}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                      status === "done"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : status === "current"
                          ? "border-primary/40 bg-primary/10 font-medium text-primary"
                          : "border-border bg-background text-muted-foreground"
                    }`}
                  >
                    {status === "done" ? (
                      <Check size={12} aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true" className="tabular-nums">
                        {index + 1}
                      </span>
                    )}
                    <span>{customersById.get(id)?.name ?? id}</span>
                    <span className="sr-only">
                      {status === "done" ? " (received)" : status === "current" ? " (current)" : " (waiting)"}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-4 @min-[44rem]:grid-cols-[minmax(0,1fr)_16rem] @min-[54rem]:grid-cols-[minmax(0,1fr)_18rem]">
          <InvoiceAllocationTable
            rows={invoiceRows}
            open={open}
            loading={statementDetail.isLoading}
            provenance={statementDetail.data?.detailProvenance}
            draft={draft}
            creditAvailable={Number(credits.data?.totalAvailable) || 0}
            doctorProfiles={account?.doctorProfiles ?? []}
            repairSelections={repairSelections}
            onRepairSelect={(invoiceId, profileId) =>
              setRepairSelections((current) => ({ ...current, [invoiceId]: profileId }))
            }
            onRepair={(invoice, profile) => repairDoctor.mutate({ invoiceId: invoice.id, doctorProfileId: profile.id })}
            repairing={repairDoctor.isPending}
            repairError={repairError}
            locked={locked}
            scopeHiddenCount={scopeHiddenCount}
            onShowAllInvoices={showAllInvoices}
            onToggle={toggleInvoice}
            onApplication={setApplication}
            onCredit={(invoiceId, value) =>
              update({ creditApplications: { ...draft.creditApplications, [invoiceId]: value } })
            }
            onEdit={(invoice) => setEditing(invoice as unknown as Invoice)}
            onAutoApply={autoApply}
          />

          <aside
            aria-labelledby="receive-current-payment-title"
            className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <div>
              <h3 id="receive-current-payment-title" className="text-sm font-semibold">
                Current payment · {providerName}
              </h3>
              <p data-testid="payment-scope-summary" className="mt-0.5 text-xs text-muted-foreground">
                {scopeSummary}
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <Label>Payment for</Label>
                <select
                  aria-label="Payment for"
                  value={draft.doctorIdentity ?? draft.doctorName ?? ""}
                  onChange={(event) => {
                    const doctor = doctorOptions.find((option) => {
                      const key = option.doctorIdentity ?? option.doctorDisplayName;
                      return (
                        key === event.target.value ||
                        normalizeDoctorName(option.doctorDisplayName) === normalizeDoctorName(event.target.value)
                      );
                    });
                    update({
                      doctorIdentity: doctor?.doctorIdentity ?? null,
                      doctorName: doctor?.doctorDisplayName ?? null,
                      totalReceived: "",
                      referenceNumber: "",
                      generatedReference: undefined,
                      applications: {},
                      creditApplications: {},
                    });
                  }}
                  disabled={!active || locked || !!customer?.isDoctorAccount}
                  className={fieldClass}
                >
                  <option value="">Entire practice</option>
                  {doctorOptions.map((doctor) => (
                    <option
                      key={doctor.doctorIdentity ?? `legacy:${normalizeDoctorName(doctor.doctorDisplayName)}`}
                      value={doctor.doctorIdentity ?? doctor.doctorDisplayName}
                    >
                      {doctor.doctorDisplayName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>
                  Statement <span className="font-normal normal-case text-muted-foreground">(optional)</span>
                </Label>
                <select
                  aria-label="Statement"
                  value={draft.statementId}
                  onChange={(event) => selectStatement(event.target.value)}
                  disabled={!active || statements.isLoading || locked}
                  className={fieldClass}
                >
                  <option value="">
                    {statements.isLoading
                      ? "Loading statements…"
                      : statements.isError
                        ? "Statements unavailable"
                        : "No statement — pay outstanding invoices"}
                  </option>
                  {selectableStatements.map((statement) => (
                    <option key={statement.id} value={statement.id}>
                      {formatDate(statement.periodEnd)} · {formatMoney(statement.savedBalanceDue)} ·{" "}
                      {statement.invoiceCount} invoices
                    </option>
                  ))}
                </select>
                {scope?.switchedFromStatement && !draft.statementId && (
                  <p data-testid="receive-switched-note" className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    Paying invoices directly: {scope.switchedBy ?? "a picked invoice"} is not on the statement.
                  </p>
                )}
                {statements.isError && (
                  <p className="mt-1 text-xs text-destructive">
                    Could not load statements: {(statements.error as Error).message}
                  </p>
                )}
                {!statements.isLoading && !statements.isError && !selectableStatements.length && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No saved statement for this account. Its outstanding invoices are listed in the invoice table and can
                    be paid directly.
                  </p>
                )}
                <div data-testid="receive-statements-loaded-count" className="mt-1 text-xs text-muted-foreground">
                  Showing {loadedStatements.length} of {statementTotal}
                </div>
                {statements.data?.query === statementsQuery && statements.data.hasMore && (
                  <button
                    type="button"
                    data-testid="receive-statements-load-more"
                    onClick={() => setStatementCursor(statements.data?.nextCursor ?? null)}
                    disabled={statements.isFetching}
                    className="mt-2 h-8 rounded-md bg-secondary px-3 text-xs font-medium disabled:opacity-50"
                  >
                    {statements.isFetching ? "Loading…" : `Load more (${loadedStatements.length} of ${statementTotal})`}
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-md border border-border p-3">
              <Label>Available existing customer credit</Label>
              <p className="text-sm font-medium">
                {credits.isLoading ? "Loading…" : formatMoney(credits.data?.totalAvailable || 0)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Allocate available credit by invoice in the Credit column. Credit remains separate from the monetary
                payment and does not create an Undeposited Funds item.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <Label>Total monetary amount received</Label>
                <input
                  type="number"
                  aria-label="Total amount received"
                  step="0.01"
                  min="0"
                  value={draft.totalReceived}
                  onChange={(event) => totalChange(event.target.value)}
                  className={`${fieldClass} text-right tabular-nums`}
                />
              </div>
              <div>
                <Label>Payment date</Label>
                <input
                  type="date"
                  aria-label="Payment date"
                  value={draft.paymentDate}
                  onChange={(event) => update({ paymentDate: event.target.value })}
                  className={fieldClass}
                />
              </div>
              <div className={draft.paymentMethod === "card" ? "space-y-3" : "grid grid-cols-2 gap-2"}>
                <div className="min-w-0">
                  <Label>Method</Label>
                  <select
                    aria-label="Payment method"
                    value={draft.paymentMethod}
                    onChange={(event) =>
                      update({ paymentMethod: event.target.value as ReceivePaymentsInputPaymentMethod })
                    }
                    className={fieldClass}
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {paymentMethodLabel(method)}
                      </option>
                    ))}
                  </select>
                </div>
                {draft.paymentMethod === "card" ? (
                  <div>
                    <Label>Card</Label>
                    <div className="space-y-2 rounded-md border border-border p-2 text-xs">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`card-choice-${active}`}
                          checked={draft.cardChoice === "saved"}
                          disabled={!savedCard.data?.card || save.isPending}
                          onChange={() => update({ cardChoice: "saved" })}
                        />
                        {savedCard.data?.card
                          ? `Use saved ${savedCard.data.card.brand} ···· ${savedCard.data.card.last4}`
                          : "No saved card"}
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`card-choice-${active}`}
                          checked={draft.cardChoice === "new"}
                          disabled={save.isPending}
                          onChange={() => update({ cardChoice: "new" })}
                        />
                        Use a new card
                      </label>
                      {draft.cardChoice === "new" && (
                        <div className="space-y-2 pt-1">
                          <input
                            aria-label="Cardholder name"
                            autoComplete="cc-name"
                            placeholder="Cardholder name"
                            value={draft.cardholderName}
                            onChange={(event) => update({ cardholderName: event.target.value })}
                            disabled={save.isPending}
                            className="h-8 w-full rounded border border-input bg-background px-2"
                          />
                          {cardConfigurationError ? (
                            <p role="alert" className="text-destructive">
                              {cardConfigurationError}
                            </p>
                          ) : (
                            <Elements
                              key={cardElementsKey}
                              stripe={stripePromise}
                              options={{ mode: "payment", amount: amountCents, currency: "usd", paymentMethodTypes: ["card"] }}
                            >
                              <StripeCapture
                                scopeKey={cardElementsKey}
                                stripeRef={stripeRef}
                                elementsRef={elementsRef}
                                onReady={setStripeReadyKey}
                              />
                              <div className="rounded border border-input bg-background p-2">
                                <PaymentElement options={{ fields: { billingDetails: { address: { postalCode: "auto" } } } }} />
                              </div>
                            </Elements>
                          )}
                          <label className="flex items-start gap-2">
                            <input
                              aria-label="Save this card on file"
                              type="checkbox"
                              checked={draft.saveCard}
                              onChange={(event) => update({ saveCard: event.target.checked })}
                              disabled={save.isPending}
                            />
                            <span>
                              Save this card on file as the customer’s default for future payments and auto-pay. This is
                              off by default. Stripe stores the card details; LabTrax never receives the card number or
                              CVC.
                            </span>
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <Label>{draft.paymentMethod === "check" ? "Check #" : "Reference #"}</Label>
                    <input
                      disabled={received <= 0}
                      aria-label="Reference number"
                      value={draft.referenceNumber}
                      onChange={(event) => update({ referenceNumber: event.target.value })}
                      className={fieldClass}
                    />
                  </div>
                )}
              </div>
              <div>
                <Label>Memo</Label>
                <input
                  aria-label="Memo"
                  value={draft.memo}
                  onChange={(event) => update({ memo: event.target.value })}
                  className={fieldClass}
                />
              </div>
            </div>

            <dl className="space-y-2 border-t border-border pt-3 text-sm">
              <Row label="Monetary received" value={formatMoney(received)} />
              <Row label="Existing credit applied" value={formatMoney(creditApplications)} />
              <Row label="Monetary applied" value={formatMoney(applied)} bold />
            </dl>

            {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
            {overApplied && (
              <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Monetary applications exceed payment received.
              </div>
            )}
            {overpaymentBlocked && (
              <div data-testid="receive-overpayment-blocked" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {formatMoney(unapplied)} of the amount received is not applied to an invoice. {OVERPAYMENT_BLOCKED_MESSAGE}
              </div>
            )}
            {!overpaymentBlocked && unapplied > 0.005 && (
              <p data-testid="receive-overpayment-credit" className="text-xs text-muted-foreground">
                {formatMoney(unapplied)} not applied to an invoice will be kept as customer credit.
              </p>
            )}
            {overCreditApplied && (
              <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Credit applications exceed available customer credit.
              </div>
            )}
            {overInvoiceBalance && (
              <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Combined payment and credit exceed an invoice’s current due.
              </div>
            )}
            <button
              type="button"
              title={
                received <= 0 && creditApplications <= 0
                  ? "Enter a monetary amount or allocate existing customer credit."
                  : undefined
              }
              onClick={() => {
                setError(null);
                save.mutate();
              }}
              disabled={
                save.isPending ||
                !active ||
                !open.length ||
                statementDetail.isLoading ||
                statementDetail.isError ||
                (received <= 0 && creditApplications <= 0) ||
                overApplied ||
                overpaymentBlocked ||
                overCreditApplied ||
                overInvoiceBalance ||
                !!receipt ||
                (chargesCard && draft.cardChoice === "new" && stripeReadyKey !== cardElementsKey)
              }
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {save.isPending ? "Saving…" : "Save payment"}
            </button>
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
              <Info size={12} className="mt-px shrink-0" aria-hidden="true" />
              <span>Money received goes to Undeposited Funds until it is banked in Make Deposits.</span>
            </p>
          </aside>
        </div>
      </div>

      {editing && (
        <InvoiceEditor
          invoice={editing}
          onClose={() => {
            setEditing(null);
            refreshInvoices();
          }}
          onGoToCase={() => setEditing(null)}
        />
      )}
      {receipt && displayedReceipt && (
        <ReceiptDialog
          receipt={displayedReceipt}
          scopeLabel={scopeSummary}
          fallbackReceived={received}
          fallbackApplied={applied}
          composing={composing}
          onCompose={() => setComposing(true)}
          to={receiptTo}
          subject={receiptSubject}
          body={receiptBody}
          onToChange={setReceiptTo}
          onSubjectChange={setReceiptSubject}
          onBodyChange={setReceiptBody}
          error={receiptError}
          sending={send.isPending}
          cancelling={cancel.isPending}
          onDownload={() => void download()}
          onSend={() => {
            setReceiptError(null);
            send.mutate();
          }}
          onContinue={finishCustomer}
          onCancelPayment={() => {
            setReceiptError(null);
            cancel.mutate();
          }}
        />
      )}
    </div>
  );
}
