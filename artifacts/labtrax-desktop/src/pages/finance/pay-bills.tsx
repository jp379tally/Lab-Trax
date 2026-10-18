import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { formatDate, formatMoney } from "@/lib/format";
import { isoDateFromToday, newIdempotencyKey, todayIsoDate } from "@/lib/ap";
import type { PayBillsVendor } from "@/lib/ap-types";
import type { BankAccount } from "@/lib/types";
import { Field } from "@/pages/finance/bills";

export default function PayBillsPage() {
  return (
    <FinanceShell>
      {({ organizationId, accounts }) => (
        <PayBillsContent organizationId={organizationId} accounts={accounts} />
      )}
    </FinanceShell>
  );
}

const DUE_FILTERS = [
  { key: "all", label: "All bills" },
  { key: "due_today", label: "Due today or earlier" },
  { key: "due_30", label: "Due in 30 days" },
] as const;

type DueFilter = (typeof DUE_FILTERS)[number]["key"];

/** Per-bill editable amounts, keyed by bill id. */
type Allocations = Record<string, { pay: string; credit: string }>;

function PayBillsContent({
  organizationId,
  accounts,
}: {
  organizationId: string;
  accounts: BankAccount[];
}) {
  const qc = useQueryClient();
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [allocations, setAllocations] = useState<Allocations>({});
  const [paymentDate, setPaymentDate] = useState(todayIsoDate());
  const [paymentMethod, setPaymentMethod] = useState("check");
  const [bankAccountId, setBankAccountId] = useState(accounts[0]?.id ?? "");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // Regenerated after every successful post so the next payment is a new one,
  // but stable across retries of the same submission.
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    newIdempotencyKey("pay-bills"),
  );

  const params = new URLSearchParams({ organizationId });
  if (dueFilter === "due_today") params.set("dueBefore", todayIsoDate());
  if (dueFilter === "due_30") params.set("dueBefore", isoDateFromToday(30));

  const payBills = useQuery({
    queryKey: ["finance", "pay-bills", params.toString()],
    queryFn: () =>
      apiFetch<{ vendors: PayBillsVendor[] }>(`/finance/pay-bills?${params.toString()}`),
  });

  const vendors = payBills.data?.vendors ?? [];

  const selection = useMemo(() => {
    let cash = 0;
    let credit = 0;
    let billCount = 0;
    const vendorIds = new Set<string>();
    for (const vendor of vendors) {
      for (const bill of vendor.bills) {
        const entry = allocations[bill.id];
        if (!entry) continue;
        const payAmount = Number(entry.pay) || 0;
        const creditAmount = Number(entry.credit) || 0;
        if (payAmount <= 0 && creditAmount <= 0) continue;
        cash += payAmount;
        credit += creditAmount;
        billCount += 1;
        vendorIds.add(vendor.vendorId);
      }
    }
    return { cash, credit, billCount, vendorCount: vendorIds.size };
  }, [vendors, allocations]);

  function setAllocation(billId: string, patch: Partial<{ pay: string; credit: string }>) {
    setAllocations((prev) => ({
      ...prev,
      [billId]: { pay: prev[billId]?.pay ?? "", credit: prev[billId]?.credit ?? "", ...patch },
    }));
  }

  function toggleBill(billId: string, balanceDue: string, checked: boolean) {
    if (checked) setAllocation(billId, { pay: Number(balanceDue).toFixed(2) });
    else
      setAllocations((prev) => {
        const next = { ...prev };
        delete next[billId];
        return next;
      });
  }

  const pay = useMutation({
    mutationFn: async () => {
      const perVendor = vendors
        .map((vendor) => {
          // One vendor credit can only be spent once across the whole run,
          // so what each bill draws is tracked against the remaining
          // capacity rather than restarting from the full credit list.
          const remainingCredit = new Map(
            vendor.credits.map((credit) => [
              credit.id,
              Math.round(Number(credit.remainingAmount) * 100),
            ]),
          );
          const lines = vendor.bills
            .map((bill) => {
              const entry = allocations[bill.id];
              if (!entry) return null;
              const payAmount = Number(entry.pay) || 0;
              const creditAmount = Number(entry.credit) || 0;
              if (payAmount <= 0 && creditAmount <= 0) return null;
              return {
                billId: bill.id,
                amount: payAmount,
                creditApplications: creditAmount > 0
                  ? allocateCredit(vendor, creditAmount, remainingCredit)
                  : [],
              };
            })
            .filter(Boolean) as Array<{
            billId: string;
            amount: number;
            creditApplications: Array<{ vendorCreditId: string; amount: number }>;
          }>;
          return lines.length ? { vendorId: vendor.vendorId, allocations: lines } : null;
        })
        .filter(Boolean) as Array<{ vendorId: string; allocations: unknown[] }>;

      return apiFetch<{ payments: Array<{ id: string; amount: string }>; replayed: boolean }>(
        "/finance/bill-payments",
        {
          method: "POST",
          body: JSON.stringify({
            organizationId,
            paymentDate,
            paymentMethod,
            bankAccountId: selection.cash > 0 ? bankAccountId : null,
            referenceNumber: referenceNumber.trim() || null,
            memo: memo.trim() || null,
            idempotencyKey,
            vendorPayments: perVendor,
          }),
        },
      );
    },
    onSuccess: (data) => {
      const count = data?.payments?.length ?? 0;
      setResult(
        `Recorded ${count} vendor payment${count === 1 ? "" : "s"}.` +
          (selection.cash > 0
            ? " The bank withdrawal is in the register."
            : " No cash moved — this was paid with vendor credit."),
      );
      setAllocations({});
      setReferenceNumber("");
      setMemo("");
      setIdempotencyKey(newIdempotencyKey("pay-bills"));
      qc.invalidateQueries({ queryKey: ["finance", "pay-bills"] });
      qc.invalidateQueries({ queryKey: ["finance", "bills"] });
      qc.invalidateQueries({ queryKey: ["finance", "ap-summary"] });
      qc.invalidateQueries({ queryKey: ["finance", "transactions"] });
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : "Could not record this payment."),
  });

  function validate(): string | null {
    if (!selection.billCount) return "Select at least one bill to pay.";
    if (!paymentDate) return "Choose a payment date.";
    if (selection.cash > 0 && !bankAccountId) {
      return "Choose the bank account the money comes from.";
    }
    for (const vendor of vendors) {
      let creditUsed = 0;
      for (const bill of vendor.bills) {
        const entry = allocations[bill.id];
        if (!entry) continue;
        const payAmount = Number(entry.pay) || 0;
        const creditAmount = Number(entry.credit) || 0;
        if (payAmount < 0 || creditAmount < 0) return "Amounts cannot be negative.";
        if (payAmount + creditAmount > Number(bill.balanceDue) + 0.004) {
          return `Bill ${bill.billNumber ?? ""} for ${vendor.vendorName} only owes ${formatMoney(
            bill.balanceDue,
          )}.`;
        }
        creditUsed += creditAmount;
      }
      if (creditUsed > Number(vendor.availableCredit) + 0.004) {
        return `${vendor.vendorName} only has ${formatMoney(
          vendor.availableCredit,
        )} of credit available.`;
      }
    }
    return null;
  }

  function submit() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setResult(null);
    pay.mutate();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={dueFilter}
          onChange={(event) => setDueFilter(event.target.value as DueFilter)}
          className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
        >
          {DUE_FILTERS.map((filter) => (
            <option key={filter.key} value={filter.key}>
              {filter.label}
            </option>
          ))}
        </select>
        <div className="ml-auto text-sm text-muted-foreground">
          {selection.billCount
            ? `${selection.billCount} bill${selection.billCount === 1 ? "" : "s"} across ${
                selection.vendorCount
              } vendor${selection.vendorCount === 1 ? "" : "s"}`
            : "Nothing selected"}
        </div>
      </div>

      {payBills.isLoading && (
        <p className="text-muted-foreground">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          Loading outstanding bills…
        </p>
      )}
      {payBills.isError && (
        <p className="text-destructive">
          Could not load outstanding bills.{" "}
          <button type="button" className="underline" onClick={() => payBills.refetch()}>
            Try again
          </button>
        </p>
      )}
      {!payBills.isLoading && !payBills.isError && !vendors.length && (
        <div className="bg-card border border-border rounded-xl px-4 py-12 text-center text-muted-foreground">
          No outstanding bills. Enter a bill first, or write an immediate check from the
          register when there is no bill to track.
        </div>
      )}

      {vendors.map((vendor) => (
        <div
          key={vendor.vendorId}
          className="bg-card border border-border rounded-xl overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <span className="text-sm font-semibold">{vendor.vendorName}</span>
            {!vendor.vendorIsActive && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                inactive
              </span>
            )}
            <span className="ml-auto text-sm text-muted-foreground">
              {formatMoney(vendor.totalDue)} due
              {Number(vendor.availableCredit) > 0 && (
                <>
                  {" · "}
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {formatMoney(vendor.availableCredit)} credit available
                  </span>
                </>
              )}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 px-4 py-2" />
                  <th className="text-left font-medium py-2">Bill #</th>
                  <th className="text-left font-medium py-2">Due</th>
                  <th className="text-right font-medium py-2">Balance</th>
                  <th className="text-right font-medium py-2 w-32">Credit applied</th>
                  <th className="text-right font-medium px-4 py-2 w-32">Payment</th>
                </tr>
              </thead>
              <tbody>
                {vendor.bills.map((bill) => {
                  const entry = allocations[bill.id];
                  const overdue = new Date(bill.dueDate).getTime() < Date.now();
                  return (
                    <tr key={bill.id} className="border-t border-border">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Pay bill ${bill.billNumber ?? bill.id}`}
                          checked={!!entry}
                          onChange={(event) =>
                            toggleBill(bill.id, bill.balanceDue, event.target.checked)
                          }
                        />
                      </td>
                      <td className="py-2">{bill.billNumber ?? "—"}</td>
                      <td className={`py-2 ${overdue ? "text-destructive font-medium" : ""}`}>
                        {formatDate(bill.dueDate)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(bill.balanceDue)}
                      </td>
                      <td className="py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          disabled={!entry || Number(vendor.availableCredit) <= 0}
                          value={entry?.credit ?? ""}
                          onChange={(event) =>
                            setAllocation(bill.id, { credit: event.target.value })
                          }
                          className="h-8 px-2 w-28 rounded bg-secondary text-sm text-right tabular-nums disabled:opacity-40"
                        />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          disabled={!entry}
                          value={entry?.pay ?? ""}
                          onChange={(event) =>
                            setAllocation(bill.id, { pay: event.target.value })
                          }
                          className="h-8 px-2 w-28 rounded bg-secondary text-sm text-right tabular-nums disabled:opacity-40"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {!!vendors.length && (
        <div className="bg-card border border-border rounded-xl px-4 py-4 space-y-3 sticky bottom-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Field label="Payment date">
              <input
                type="date"
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
                className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
              />
            </Field>
            <Field label="Method">
              <select
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value)}
                className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
              >
                <option value="check">Check</option>
                <option value="ach">ACH</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Pay from">
              <select
                value={bankAccountId}
                disabled={selection.cash <= 0}
                onChange={(event) => setBankAccountId(event.target.value)}
                className="h-9 px-2 rounded-md bg-secondary text-sm w-full disabled:opacity-50"
              >
                <option value="">Select…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference / check #">
              <input
                value={referenceNumber}
                onChange={(event) => setReferenceNumber(event.target.value)}
                className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
              />
            </Field>
            <Field label="Memo">
              <input
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                className="h-9 px-2 rounded-md bg-secondary text-sm w-full"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="text-sm">
              <span className="text-muted-foreground">Cash to withdraw </span>
              <span className="font-semibold tabular-nums">
                {formatMoney(selection.cash)}
              </span>
              {selection.credit > 0 && (
                <>
                  <span className="text-muted-foreground"> · credit applied </span>
                  <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatMoney(selection.credit)}
                  </span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground max-w-xl">
              {selection.vendorCount > 1
                ? `This records ${selection.vendorCount} separate vendor payments, one per vendor.`
                : "Recording a check or ACH here logs the payment you made. LabTrax does not send money to the vendor."}
            </p>
            <button
              type="button"
              onClick={submit}
              disabled={pay.isPending || !selection.billCount}
              className="ml-auto inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-60"
            >
              {pay.isPending && <Loader2 size={14} className="animate-spin" />}
              Record payment
            </button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={14} /> {result}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Spread one bill's credit amount across the vendor's open credits, oldest
 * first. The API re-verifies every credit against freshly locked rows, so this
 * is a proposal the server is free to reject rather than a trusted figure.
 */
/**
 * Spread one bill's credit across the vendor's credits, drawing down shared
 * capacity so a second bill in the same run cannot spend the same credit
 * again. `remainingCredit` is mutated as capacity is consumed.
 */
function allocateCredit(
  vendor: PayBillsVendor,
  amount: number,
  remainingCredit: Map<string, number>,
): Array<{ vendorCreditId: string; amount: number }> {
  const applications: Array<{ vendorCreditId: string; amount: number }> = [];
  let remaining = Math.round(amount * 100);
  for (const credit of vendor.credits) {
    if (remaining <= 0) break;
    const available = remainingCredit.get(credit.id) ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    applications.push({ vendorCreditId: credit.id, amount: take / 100 });
    remainingCredit.set(credit.id, available - take);
    remaining -= take;
  }
  return applications;
}
