import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { loadStripe } from "@stripe/stripe-js";
import { ReceivePaymentsInputPaymentMethod } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice } from "@/lib/types";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { HeadsUpCards, type HeadsUpState } from "@/components/finance/receive-payments/HeadsUpCards";
import { ReceivePaymentsHeader } from "@/components/finance/receive-payments/PageHeader";
import { PaymentSummaryPanel } from "@/components/finance/receive-payments/PaymentSummaryPanel";
import { ReceivingStep } from "@/components/finance/receive-payments/ReceivingStep";
import {
  DEFAULT_SELECTION_VIEW,
  SelectionPanel,
  type SelectionPanelStatus,
  type SelectionView,
} from "@/components/finance/receive-payments/SelectionPanel";
import {
  EMPTY_SELECTION,
  agingAsOf,
  buildPayableCustomers,
  buildSelectablePayableCustomers,
  pruneSelection,
  savedSelectionsKey,
  selectedFigures,
  selectionTotals,
  type PayableCustomer,
  type PayableInvoice,
} from "@/components/finance/receive-payments/model";
import { localCalendarDate } from "@/components/finance/receive-payments/payments";
import {
  DEFAULT_PAYMENT_OPTIONS,
  type EligibleAccount,
  type PaymentDefaults,
  type PaymentOptions,
  type Selection,
} from "@/components/finance/receive-payments/types";
import { InvoiceEditor } from "@/pages/invoices";

export { localCalendarDate, paymentErrorMessage } from "@/components/finance/receive-payments/payments";

const AR_AGING_PATH = "/finance/aging?side=ar";
const EMPTY_CUSTOMERS: ReadonlyMap<string, PayableCustomer> = new Map();

export default function ReceivePaymentsPage() {
  return (
    <FinanceShell>
      {({ organizationId }) => (
        // A batch belongs to one lab: switching labs starts a fresh selection.
        <ReceivePayments key={organizationId} labOrganizationId={organizationId} />
      )}
    </FinanceShell>
  );
}

function ReceivePayments({ labOrganizationId }: { labOrganizationId: string }) {
  const config = useQuery({
    queryKey: ["billing", "card-config", labOrganizationId],
    queryFn: () =>
      apiFetch<{ publishableKey: string }>(
        `/billing/payment-sessions/card/config?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
      ),
    retry: false,
  });
  const stripePromise = useMemo(
    () => (config.data?.publishableKey ? loadStripe(config.data.publishableKey) : null),
    [config.data?.publishableKey],
  );
  return (
    <ReceivePaymentsScreen
      labOrganizationId={labOrganizationId}
      stripePromise={stripePromise}
      cardConfigurationError={config.isError ? (config.error as Error).message : null}
    />
  );
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Receive Payments: choose customers on the selection surface (heads-up
 * cards, tabbed customer list and Payment Summary), then receive each
 * customer's payment in turn. The selection, defaults and options live here
 * so the selection surface and the receiving step share them.
 */
function ReceivePaymentsScreen({
  labOrganizationId,
  cardConfigurationError,
  stripePromise,
}: {
  labOrganizationId: string;
  cardConfigurationError: string | null;
  stripePromise: ReturnType<typeof loadStripe> | null;
}) {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  // Statement-led: customers with an unpaid sent statement.
  const statementAccounts = useQuery({
    queryKey: ["billing", "eligible-statement-accounts", labOrganizationId],
    queryFn: () => apiFetch<EligibleAccount[]>(`/billing/${labOrganizationId}/eligible-statement-accounts`),
  });
  // Invoice-led: any customer with a finalized open invoice, whether or not a
  // statement was ever sent.
  const invoiceAccounts = useQuery({
    queryKey: ["billing", "eligible-invoice-accounts", labOrganizationId],
    queryFn: () => apiFetch<EligibleAccount[]>(`/billing/${labOrganizationId}/eligible-invoice-accounts`),
  });

  const status: SelectionPanelStatus =
    statementAccounts.isError || invoiceAccounts.isError
      ? "error"
      : statementAccounts.isSuccess && invoiceAccounts.isSuccess
        ? "ready"
        : "loading";
  const loadError = errorText(statementAccounts.error) ?? errorText(invoiceAccounts.error);

  const customers = useMemo(
    () => buildSelectablePayableCustomers(buildPayableCustomers(statementAccounts.data, invoiceAccounts.data, agingAsOf())),
    [statementAccounts.data, invoiceAccounts.data],
  );
  const liveById = useMemo(
    () => new Map(customers.map((customer) => [customer.id, customer] as const)),
    [customers],
  );

  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [view, setView] = useState<SelectionView>(DEFAULT_SELECTION_VIEW);
  const [defaults, setDefaults] = useState<PaymentDefaults>(() => ({
    paymentMethod: ReceivePaymentsInputPaymentMethod.check,
    paymentDate: localCalendarDate(),
    memo: "",
  }));
  const [options, setOptions] = useState<PaymentOptions>(DEFAULT_PAYMENT_OPTIONS);
  const [stage, setStage] = useState<"select" | "receive">("select");
  const [completed, setCompleted] = useState<string[]>([]);
  // The selected customers as they were when receiving started, so customers
  // who drop off the payable lists after paying keep their names in the queue.
  const [batchSnapshot, setBatchSnapshot] = useState<ReadonlyMap<string, PayableCustomer>>(EMPTY_CUSTOMERS);
  const [editing, setEditing] = useState<Invoice | null>(null);

  // Drop customers and picks that are no longer payable, but only once both
  // lists have loaded, and never while a batch is being received.
  useEffect(() => {
    if (stage !== "select" || status !== "ready") return;
    setSelection((current) => pruneSelection(current, liveById));
  }, [stage, status, liveById]);

  const refetchEligible = useCallback(
    () => Promise.all([statementAccounts.refetch(), invoiceAccounts.refetch()]),
    [statementAccounts.refetch, invoiceAccounts.refetch],
  );

  const totals = useMemo(() => selectionTotals(selectedFigures(selection, liveById)), [selection, liveById]);
  const headsUp: HeadsUpState =
    status === "loading"
      ? { status: "loading" }
      : status === "error"
        ? { status: "unavailable", reason: "Balances could not be loaded" }
        : { status: "ready", totals, payableCount: customers.length };

  const blockedReason =
    status === "loading"
      ? "Loading customers with a balance due…"
      : status === "error"
        ? "Customer balances could not be loaded. Retry the list before receiving payments."
        : !selection.ids.length
          ? "Select at least one customer to receive payment from."
          : totals.amount === null
            ? "A selected customer's balance is not available yet."
            : "";

  const startReceiving = () => {
    if (blockedReason) return;
    const snapshot = new Map<string, PayableCustomer>();
    for (const id of selection.ids) {
      const customer = liveById.get(id);
      if (customer) snapshot.set(id, customer);
    }
    setBatchSnapshot(snapshot);
    setCompleted([]);
    setStage("receive");
  };

  const batchCustomersById = useMemo(() => {
    if (stage !== "receive") return liveById;
    const merged = new Map(batchSnapshot);
    for (const [id, customer] of liveById) merged.set(id, customer);
    return merged;
  }, [stage, batchSnapshot, liveById]);
  const queueCustomers = useMemo(
    () => [...batchCustomersById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [batchCustomersById],
  );

  const backToSelection = () => {
    setStage("select");
    setBatchSnapshot(EMPTY_CUSTOMERS);
  };
  const finishBatch = () => {
    setSelection(EMPTY_SELECTION);
    setCompleted([]);
    setBatchSnapshot(EMPTY_CUSTOMERS);
    setStage("select");
    navigate("/finance/make-deposits");
  };

  const editInvoice = (invoice: PayableInvoice) => setEditing(invoice.source as unknown as Invoice);

  return (
    <div className="@container min-w-0 space-y-4">
      <ReceivePaymentsHeader onViewAging={() => navigate(AR_AGING_PATH)} />
      {stage === "select" ? (
        <>
          <HeadsUpCards state={headsUp} />
          {/* A narrower summary around 1024 px windows leaves the customer table room for every column. */}
          <div className="grid grid-cols-1 items-start gap-4 @min-[44rem]:grid-cols-[minmax(0,1fr)_15rem] @min-[54rem]:grid-cols-[minmax(0,1fr)_18rem] @min-[72rem]:grid-cols-[minmax(0,1fr)_20rem]">
            <SelectionPanel
              status={status}
              errorMessage={loadError}
              onRetry={() => void refetchEligible()}
              customers={customers}
              customersById={liveById}
              selection={selection}
              onSelectionChange={setSelection}
              view={view}
              onViewChange={setView}
              onEditInvoice={editInvoice}
              savedSelectionsKey={user?.id ? savedSelectionsKey(user.id, labOrganizationId) : null}
            />
            <PaymentSummaryPanel
              status={status}
              totals={status === "ready" ? totals : null}
              defaults={defaults}
              onDefaultsChange={setDefaults}
              options={options}
              onOptionsChange={setOptions}
              blockedReason={blockedReason}
              onReceive={startReceiving}
            />
          </div>
        </>
      ) : (
        <ReceivingStep
          labOrganizationId={labOrganizationId}
          cardConfigurationError={cardConfigurationError}
          stripePromise={stripePromise}
          customers={queueCustomers}
          customersById={batchCustomersById}
          selection={selection}
          onSelectionChange={setSelection}
          completed={completed}
          onCompletedChange={setCompleted}
          defaults={defaults}
          options={options}
          onBack={backToSelection}
          onFinished={finishBatch}
          refetchEligible={refetchEligible}
        />
      )}
      {editing && (
        <InvoiceEditor
          invoice={editing}
          onClose={() => {
            setEditing(null);
            void refetchEligible();
          }}
          onGoToCase={() => setEditing(null)}
        />
      )}
    </div>
  );
}
