import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  type OpenInvoice,
  type ReceivePaymentsInput,
  type ReceivePaymentsResultData,
  ReceivePaymentsInputPaymentMethod,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import type { BankAccount, Invoice, Organization } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";

export default function ReceivePaymentsPage() {
  return (
    <FinanceShell>
      {({ organizationId, accounts }) => (
        <ReceivePayments
          labOrganizationId={organizationId}
          accounts={accounts}
        />
      )}
    </FinanceShell>
  );
}

function ReceivePayments({
  labOrganizationId,
  accounts,
}: {
  labOrganizationId: string;
  accounts: BankAccount[];
}) {
  const qc = useQueryClient();

  const allInvoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const providers = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const inv of allInvoicesQuery.data || []) {
      if (inv.labOrganizationId !== labOrganizationId) continue;
      if (inv.status === "paid" || inv.status === "void") continue;
      if (Number(inv.balanceDue ?? 0) <= 0) continue;
      const id = inv.providerOrganizationId;
      const name =
        inv.providerOrganization?.name || `Practice ${id.slice(0, 6)}`;
      if (id && !seen.has(id)) seen.set(id, { id, name });
    }
    return Array.from(seen.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [allInvoicesQuery.data, labOrganizationId]);

  const [providerId, setProviderId] = useState<string>("");
  useEffect(() => {
    if (!providerId && providers.length) setProviderId(providers[0].id);
  }, [providers, providerId]);

  const openQuery = useQuery({
    queryKey: ["receive-payments", "open", labOrganizationId, providerId],
    enabled: !!providerId,
    queryFn: () =>
      apiFetch<OpenInvoice[]>(
        `/invoices/open?providerOrganizationId=${providerId}&labOrganizationId=${labOrganizationId}`
      ),
  });

  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  type PaymentMethod = ReceivePaymentsInputPaymentMethod;
  const PAYMENT_METHODS: PaymentMethod[] = [
    ReceivePaymentsInputPaymentMethod.check,
    ReceivePaymentsInputPaymentMethod.card,
    ReceivePaymentsInputPaymentMethod.ach,
    ReceivePaymentsInputPaymentMethod.cash,
    ReceivePaymentsInputPaymentMethod.other,
  ];
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    ReceivePaymentsInputPaymentMethod.check
  );
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [totalReceived, setTotalReceived] = useState<string>("");
  const [applications, setApplications] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  // Reset applied amounts when provider changes
  useEffect(() => {
    setApplications({});
    setTotalReceived("");
    setReferenceNumber("");
    setMemo("");
    setDoneMsg(null);
    setError(null);
  }, [providerId]);

  function applyOldestFirst(total: number) {
    const next: Record<string, string> = {};
    let remaining = total;
    for (const inv of openQuery.data || []) {
      if (remaining <= 0) break;
      const balance = Number(inv.balanceDue);
      const apply = Math.min(balance, remaining);
      next[inv.id] = apply.toFixed(2);
      remaining = +(remaining - apply).toFixed(2);
    }
    setApplications(next);
  }

  function handleTotalReceived(value: string) {
    setTotalReceived(value);
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) applyOldestFirst(n);
  }

  function setOne(invoiceId: string, value: string) {
    setApplications((prev) => ({ ...prev, [invoiceId]: value }));
  }

  const appliedSum = Object.values(applications).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  const totalReceivedNum = Number(totalReceived) || 0;
  const overApplied =
    totalReceivedNum > 0 && appliedSum - totalReceivedNum > 0.005;

  const save = useMutation({
    mutationFn: () => {
      const apps = Object.entries(applications)
        .map(([invoiceId, amt]) => ({
          invoiceId,
          amount: Number(amt) || 0,
        }))
        .filter((a) => a.amount > 0);
      if (!apps.length) throw new Error("Apply a payment to at least one invoice.");
      if (overApplied)
        throw new Error(
          "Applied total exceeds the payment amount received. Lower a row or raise the total received."
        );
      const body: ReceivePaymentsInput = {
        labOrganizationId,
        providerOrganizationId: providerId,
        paymentDate: new Date(paymentDate).toISOString(),
        paymentMethod,
        referenceNumber: referenceNumber.trim() || null,
        memo: memo.trim() || null,
        applications: apps,
      };
      return apiFetch<ReceivePaymentsResultData>("/invoices/receive-payments", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (r) => {
      const total = r.totalApplied ?? "0";
      const count = Object.values(applications).filter((v) => Number(v) > 0).length;
      setDoneMsg(
        `Recorded ${formatMoney(total)} across ${count} invoice(s). Funds are now in Undeposited Funds — go to Make Deposits to move them to a bank account.`
      );
      setApplications({});
      setTotalReceived("");
      setReferenceNumber("");
      setMemo("");
      qc.invalidateQueries({ queryKey: ["receive-payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError(null);
    save.mutate();
  }

  const open = openQuery.data || [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold">Payment</h3>
          <div>
            <Label>Received from</Label>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              {!providers.length && <option value="">No open invoices</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Total amount received</Label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={totalReceived}
                onChange={(e) => handleTotalReceived(e.target.value)}
                placeholder="0.00"
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </div>
            <div>
              <Label>Payment date</Label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Method</Label>
              <select
                value={paymentMethod}
                onChange={(e) => {
                  const v = e.target.value;
                  if (PAYMENT_METHODS.includes(v as PaymentMethod)) {
                    setPaymentMethod(v as PaymentMethod);
                  }
                }}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m === "ach" ? "ACH" : m[0].toUpperCase() + m.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Reference #</Label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder={paymentMethod === "check" ? "Check #" : "Optional"}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm font-mono"
              />
            </div>
          </div>
          <div>
            <Label>Memo</Label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Optional"
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3">Summary</h3>
          <dl className="text-sm space-y-2">
            <Row label="Open invoices" value={String(open.length)} />
            <Row
              label="Open balance"
              value={formatMoney(
                open.reduce((s, i) => s + Number(i.balanceDue), 0)
              )}
            />
            <Row
              label="Total received"
              value={formatMoney(Number(totalReceived) || 0)}
            />
            <Row label="Applied" value={formatMoney(appliedSum)} bold />
            <Row
              label="Unapplied"
              value={formatMoney(
                Math.max(0, (Number(totalReceived) || 0) - appliedSum)
              )}
            />
          </dl>
          {error && (
            <div className="mt-4 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          {overApplied && (
            <div className="mt-3 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 px-3 py-2 rounded-md">
              Applied total ({formatMoney(appliedSum)}) is greater than the
              payment received ({formatMoney(totalReceivedNum)}).
            </div>
          )}
          {doneMsg && (
            <div className="mt-4 text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md flex flex-wrap items-center gap-2">
              <span>{doneMsg}</span>
              <a
                href="/finance/make-deposits"
                className="font-semibold underline underline-offset-2 hover:opacity-80 whitespace-nowrap"
              >
                Go to Make Deposits →
              </a>
            </div>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending || appliedSum <= 0 || overApplied}
            title={
              overApplied
                ? "Applied total exceeds payment received"
                : undefined
            }
            className="mt-4 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {save.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            {save.isPending ? "Saving…" : "Save payment"}
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Outstanding invoices</h3>
          {!!open.length && (
            <button
              type="button"
              onClick={() => {
                const total =
                  Number(totalReceived) ||
                  open.reduce((s, i) => s + Number(i.balanceDue), 0);
                if (!Number(totalReceived)) setTotalReceived(total.toFixed(2));
                applyOldestFirst(total);
              }}
              className="h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/80"
            >
              Auto-apply oldest first
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 w-8"></th>
                <th className="text-left font-medium py-2">Invoice</th>
                <th className="text-left font-medium py-2">Issued</th>
                <th className="text-right font-medium py-2">Age</th>
                <th className="text-right font-medium py-2">Original</th>
                <th className="text-right font-medium py-2">Balance</th>
                <th className="text-right font-medium px-4 py-2 w-32">Payment</th>
              </tr>
            </thead>
            <tbody>
              {openQuery.isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    <Loader2 size={14} className="inline animate-spin mr-2" />
                    Loading open invoices…
                  </td>
                </tr>
              )}
              {!openQuery.isLoading && open.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    No open invoices for this practice.
                  </td>
                </tr>
              )}
              {open.map((inv) => {
                const balance = Number(inv.balanceDue);
                const applied = Number(applications[inv.id] || 0);
                const overshot = applied > balance + 0.005;
                const selected = applied > 0;
                return (
                  <tr key={inv.id} className="border-t border-border">
                    <td className="pl-4 pr-1 py-2.5 w-8">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) =>
                          setOne(
                            inv.id,
                            e.target.checked ? balance.toFixed(2) : ""
                          )
                        }
                        aria-label={`Select invoice ${inv.invoiceNumber}`}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </td>
                    <td className="py-2.5 font-mono text-xs">
                      {inv.invoiceNumber}
                    </td>
                    <td className="py-2.5 text-muted-foreground">
                      {inv.issuedAt ? formatDate(inv.issuedAt) : "—"}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                      {inv.ageDays != null ? `${inv.ageDays}d` : "—"}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatMoney(inv.total)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(balance)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max={balance}
                        value={applications[inv.id] || ""}
                        onChange={(e) => setOne(inv.id, e.target.value)}
                        placeholder="0.00"
                        className={`w-28 h-8 px-2 rounded bg-background border text-sm text-right tabular-nums ${
                          overshot ? "border-destructive" : "border-input"
                        }`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums ${
          bold ? "font-semibold text-foreground" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
