import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
} from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { refreshInvoiceSalesQueries } from "@/lib/refresh-case-finance";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import type { Invoice } from "@/lib/types";

interface RecentPayment {
  id: string;
  totalAmount: string;
  paidAt: string;
  paymentMethod: string | null;
  referenceNumber: string | null;
}

type PaymentMethod = "check" | "card" | "ach" | "cash" | "other";

const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "check", label: "Check" },
  { value: "card", label: "Card" },
  { value: "ach", label: "ACH" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

export interface ReceivePaymentModalProps {
  open: boolean;
  onClose: () => void;
  practiceOrDoctorName: string;
  defaultAmount: number;
  /**
   * Which invoice IDs to apply the payment to.
   * - If non-empty, only these IDs are considered (filtered to open/partially_paid ones in cache).
   * - If empty, all open invoices for `providerOrganizationId` from the cache are used.
   */
  invoiceIds: string[];
  providerOrganizationId: string;
  labOrganizationId: string;
  /** Exact durable doctor identity for doctor-scoped payments. */
  doctorName?: string | null;
}

export function ReceivePaymentModal({
  open,
  onClose,
  practiceOrDoctorName,
  defaultAmount,
  invoiceIds,
  providerOrganizationId,
  labOrganizationId,
  doctorName = null,
}: ReceivePaymentModalProps) {
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("check");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the modal opens or the defaultAmount changes.
  useEffect(() => {
    if (open) {
      setAmount(defaultAmount > 0 ? defaultAmount.toFixed(2) : "");
      setPaymentDate(new Date().toISOString().slice(0, 10));
      setPaymentMethod("check");
      setReferenceNumber("");
      setMemo("");
      setError(null);
    }
  }, [open, defaultAmount]);

  const amountNum = Number(amount) || 0;

  // Fetch recent payment sessions for this provider so we can warn about
  // potential duplicates. Fire-and-forget: failures or loading states show
  // nothing extra (the warning is informational only).
  const recentPaymentsQuery = useQuery<RecentPayment[]>({
    queryKey: ["receive-payments", "recent", providerOrganizationId, labOrganizationId, doctorName],
    queryFn: () =>
      apiFetch<RecentPayment[]>(
        `/invoices/payments/recent?providerOrganizationId=${encodeURIComponent(providerOrganizationId)}&labOrganizationId=${encodeURIComponent(labOrganizationId)}&doctorName=${encodeURIComponent(doctorName || "")}`,
      ),
    enabled: open && !!providerOrganizationId && !!labOrganizationId,
    staleTime: 60 * 1000,
  });

  // Find a prior payment whose total is within ±$0.01 of the current amount.
  const duplicateMatch = (() => {
    if (amountNum <= 0) return null;
    const list = recentPaymentsQuery.data ?? [];
    return (
      list.find((p) => Math.abs(Number(p.totalAmount) - amountNum) <= 0.01) ??
      null
    );
  })();

  /** Build the applications array (oldest-first) from cached invoice data. */
  function buildApplications(totalAmount: number) {
    // Pull the flat list of Invoice objects out of every ["invoices", *] cache
    // entry so we pick up filtered/paginated variants too.
    // Deduplicate by invoice ID — multiple query cache entries (e.g. filtered
    // and unfiltered variants) can hold the same invoice, and the API rejects
    // duplicate invoiceId entries in the applications array.
    const seenIds = new Set<string>();
    const allCached: Invoice[] = queryClient
      .getQueriesData<Invoice[]>({ queryKey: FINANCE_INVOICES_QUERY_KEY })
      .flatMap(([, d]) => d ?? [])
      .filter((inv) => {
        if (seenIds.has(inv.id)) return false;
        seenIds.add(inv.id);
        return true;
      });

    const OPEN_STATUSES = new Set(["open", "partially_paid", "overdue"]);

    // Candidate invoices: must belong to the right provider, be open, and
    // have a positive balance.
    let candidates = allCached.filter(
      (inv) =>
        inv.providerOrganizationId === providerOrganizationId &&
        OPEN_STATUSES.has(inv.status) &&
        Number(inv.balanceDue ?? 0) > 0 &&
        (!doctorName || (
          (inv.doctorIdentity || inv.doctorDisplayName || inv.doctorName ||
            ((inv.displayMetadata ?? inv.displayMetadataJson ?? {}) as { billTo?: string; doctorName?: string }).billTo ||
            ((inv.displayMetadata ?? inv.displayMetadataJson ?? {}) as { doctorName?: string }).doctorName || "")
            .trim().replace(/\s+/g, " ").toLowerCase() === doctorName.trim().replace(/\s+/g, " ").toLowerCase()
        )),
    );

    // When the caller passed explicit IDs, restrict to just those.
    if (invoiceIds.length > 0) {
      const idSet = new Set(invoiceIds);
      candidates = candidates.filter((inv) => idSet.has(inv.id));
    }

    // Sort oldest-first (issuedAt, then createdAt as fallback).
    candidates.sort((a, b) =>
      (a.issuedAt || a.createdAt || "").localeCompare(
        b.issuedAt || b.createdAt || "",
      ),
    );

    const apps: Array<{ invoiceId: string; amount: number }> = [];
    let remaining = totalAmount;
    for (const inv of candidates) {
      if (remaining <= 0.005) break;
      const balance = Number(inv.balanceDue ?? 0);
      const apply = Math.min(balance, remaining);
      apps.push({ invoiceId: inv.id, amount: +apply.toFixed(2) });
      remaining = +(remaining - apply).toFixed(2);
    }
    return apps;
  }

  const mutation = useMutation({
    mutationFn: () => {
      const applications = buildApplications(amountNum);
      if (applications.length === 0) {
        throw new Error(
          "No open invoices found to apply this payment to. Refresh the page and try again.",
        );
      }
      return apiFetch<{ totalApplied: string }>("/invoices/receive-payments", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId,
          providerOrganizationId,
          doctorName,
          paymentDate: new Date(paymentDate).toISOString(),
          paymentMethod,
          referenceNumber: referenceNumber.trim() || null,
          memo: memo.trim() || null,
          applications,
        }),
      });
    },
    onSuccess: (r) => {
      void refreshInvoiceSalesQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: FINANCE_INVOICES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["statements"] });
      queryClient.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, labOrganizationId],
      });
      queryClient.invalidateQueries({ queryKey: ["receive-payments"] });
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      toast({
        title: "Payment recorded",
        description: `${formatMoney(r.totalApplied)} applied to ${practiceOrDoctorName}.`,
      });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Receive payment</div>
            <div className="text-sm font-semibold">{practiceOrDoctorName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Amount */}
          <label className="block">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              Amount
            </div>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
              }}
              placeholder="0.00"
              className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
          </label>

          {/* Payment date */}
          <label className="block">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              Payment date
            </div>
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          {/* Method + Reference side-by-side */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Method
              </div>
              <select
                value={paymentMethod}
                onChange={(e) =>
                  setPaymentMethod(e.target.value as PaymentMethod)
                }
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Reference #
              </div>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder={
                  paymentMethod === "check" ? "Check #" : "Optional"
                }
                className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
          </div>

          {/* Memo */}
          <label className="block">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              Memo
            </div>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Optional"
              className="w-full h-9 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>

          {/* Applied-to note */}
          <p className="text-[11px] text-muted-foreground">
            Payment is applied oldest-first across open invoices
            {invoiceIds.length > 0
              ? ` (${invoiceIds.length} selected)`
              : " for this practice"}
            .
          </p>

          {/* Duplicate-payment warning */}
          {duplicateMatch && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-warning/10 border border-warning/30 text-sm text-warning">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>
                A payment of {formatMoney(duplicateMatch.totalAmount)} was already
                received on {formatDateTime(duplicateMatch.paidAt)}.
                {duplicateMatch.referenceNumber && (
                  <> (Ref: {duplicateMatch.referenceNumber})</>
                )}
              </span>
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
            disabled={mutation.isPending || amountNum <= 0}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {mutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            {mutation.isPending ? "Saving…" : "Save payment"}
          </button>
        </footer>
      </div>
    </div>
  );
}
