import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "partially_paid", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "void", label: "Void" },
];

// Backend PATCH /invoices/:id only accepts these statuses (see api-server/src/routes/invoices.ts).
const EDITABLE_STATUSES = [
  "draft",
  "open",
  "partially_paid",
  "paid",
  "void",
] as const;

export default function InvoicesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<Invoice | null>(null);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    return rows
      .filter((i) => {
        if (status !== "all" && i.status !== status) return false;
        if (!q) return true;
        return i.invoiceNumber.toLowerCase().includes(q);
      })
      .sort((a, b) =>
        (b.createdAt || b.issuedAt || "").localeCompare(a.createdAt || a.issuedAt || ""),
      );
  }, [data, search, status]);

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Open balances, payments, and statements.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {filtered.length} of {data?.length ?? 0}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search invoice #…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left font-medium px-5 py-2.5">Invoice #</th>
                <th className="text-left font-medium py-2.5">Issued</th>
                <th className="text-left font-medium py-2.5">Due</th>
                <th className="text-left font-medium py-2.5">Status</th>
                <th className="text-right font-medium py-2.5">Total</th>
                <th className="text-right font-medium px-5 py-2.5">Balance</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading invoices…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                    No invoices match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setEditing(i)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/40"
                >
                  <td className="px-5 py-3 font-mono text-xs">{i.invoiceNumber}</td>
                  <td className="py-3 text-muted-foreground">{formatDate(i.issuedAt)}</td>
                  <td className="py-3 text-muted-foreground">{formatDate(i.dueDate)}</td>
                  <td className="py-3"><StatusBadge status={i.status} /></td>
                  <td className="py-3 text-right tabular-nums font-medium">
                    {formatMoney(i.total)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {formatMoney(i.balanceDue ?? i.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <InvoiceEditor invoice={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function InvoiceEditor({
  invoice,
  onClose,
}: {
  invoice: Invoice;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const detailQuery = useQuery({
    queryKey: ["invoice", invoice.id],
    queryFn: () =>
      apiFetch<Invoice & { tax?: string | number; discount?: string | number; dueAt?: string }>(
        `/invoices/${invoice.id}`,
      ),
  });

  const [status, setStatus] = useState<string>(
    EDITABLE_STATUSES.includes(invoice.status as (typeof EDITABLE_STATUSES)[number])
      ? invoice.status
      : "open",
  );
  const [dueAt, setDueAt] = useState<string>(toInputDate(invoice.dueDate));
  const [tax, setTax] = useState<number>(0);
  const [discount, setDiscount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = detailQuery.data;
    if (!d) return;
    const nextStatus = EDITABLE_STATUSES.includes(
      d.status as (typeof EDITABLE_STATUSES)[number],
    )
      ? d.status
      : "open";
    setStatus(nextStatus);
    setDueAt(toInputDate((d as { dueAt?: string }).dueAt ?? d.dueDate));
    setTax(Number((d as { tax?: string | number }).tax ?? 0));
    setDiscount(Number((d as { discount?: string | number }).discount ?? 0));
  }, [detailQuery.data]);

  const items = detailQuery.data?.items ?? [];
  const subtotal = useMemo(
    () =>
      items.reduce(
        (sum, it) => sum + Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0),
        0,
      ),
    [items],
  );
  const total = subtotal + Number(tax || 0) - Number(discount || 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { status };
      if (Number.isFinite(tax)) payload.tax = tax;
      if (Number.isFinite(discount)) payload.discount = discount;
      if (dueAt) payload.dueAt = new Date(dueAt).toISOString();
      return apiFetch<Invoice>(`/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      onClose();
    },
    onError: (err: Error) => setError(err.message || "Save failed."),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div className="w-full max-w-3xl bg-card border-l border-border h-full overflow-y-auto scrollbar-thin">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Invoice</div>
            <div className="font-mono text-sm font-semibold">{invoice.invoiceNumber}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setError(null);
                saveMutation.mutate();
              }}
              disabled={saveMutation.isPending || detailQuery.isLoading}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {saveMutation.isPending ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="px-6 py-6 space-y-6">
          {detailQuery.isLoading && (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading invoice…
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Due
              </label>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Tax
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={tax}
                onChange={(e) => setTax(Number(e.target.value) || 0)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Discount
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-3">Line items</h3>
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Description</th>
                    <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Unit price</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                        No line items on this invoice.
                      </td>
                    </tr>
                  )}
                  {items.map((it) => (
                    <tr key={it.id} className="border-t border-border">
                      <td className="px-3 py-2">{it.description}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(it.quantity)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(it.unitPrice)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        {formatMoney(Number(it.quantity) * Number(it.unitPrice))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Subtotal
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(subtotal)}
                    </td>
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Tax
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(tax)}
                    </td>
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Discount
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      −{formatMoney(discount)}
                    </td>
                  </tr>
                  <tr className="border-t border-border bg-secondary/30">
                    <td colSpan={3} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Total
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                      {formatMoney(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Line items are managed from the originating case. Adjust tax or discount above to change the total.
            </p>
          </section>

          {detailQuery.data?.notes && (
            <section>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Notes
              </h3>
              <div className="text-sm whitespace-pre-wrap bg-secondary/40 rounded-md px-3 py-2 border border-border">
                {detailQuery.data.notes}
              </div>
            </section>
          )}

          {detailQuery.data?.payments && detailQuery.data.payments.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Payments</h3>
              <div className="border border-border rounded-md divide-y divide-border">
                {detailQuery.data.payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium">{formatMoney(p.amount)}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.method || "Payment"} · {formatDate(p.paidAt)}
                      </div>
                    </div>
                    {p.reference && (
                      <div className="text-xs text-muted-foreground">{p.reference}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function toInputDate(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
