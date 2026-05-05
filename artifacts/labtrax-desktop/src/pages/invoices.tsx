import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, InvoiceLineItem } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "partially_paid", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

const EDITABLE_STATUSES = [
  "draft",
  "open",
  "partially_paid",
  "paid",
  "void",
] as const;

type DraftLine = {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

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
        return (
          i.invoiceNumber.toLowerCase().includes(q) ||
          (i.providerOrganization?.name || "").toLowerCase().includes(q)
        );
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
              placeholder="Search invoice # or client…"
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
                <th className="text-left font-medium py-2.5">Client</th>
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
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading invoices…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
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
                  <td className="py-3">
                    {i.providerOrganization?.name || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-3 text-muted-foreground">{formatDate(i.issuedAt)}</td>
                  <td className="py-3 text-muted-foreground">
                    {formatDate(i.dueAt ?? i.dueDate)}
                  </td>
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
    queryFn: () => apiFetch<Invoice>(`/invoices/${invoice.id}`),
  });

  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber);
  const [statusValue, setStatusValue] = useState<string>(
    EDITABLE_STATUSES.includes(invoice.status as (typeof EDITABLE_STATUSES)[number])
      ? invoice.status
      : "open",
  );
  const [providerId, setProviderId] = useState(invoice.providerOrganizationId);
  const [issuedAt, setIssuedAt] = useState<string>(toInputDate(invoice.issuedAt));
  const [dueAt, setDueAt] = useState<string>(
    toInputDate(invoice.dueAt ?? invoice.dueDate),
  );
  const [tax, setTax] = useState<number>(0);
  const [discount, setDiscount] = useState<number>(0);
  const [items, setItems] = useState<DraftLine[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = detailQuery.data;
    if (!d) return;
    setInvoiceNumber(d.invoiceNumber);
    setStatusValue(
      EDITABLE_STATUSES.includes(d.status as (typeof EDITABLE_STATUSES)[number])
        ? d.status
        : "open",
    );
    setProviderId(d.providerOrganizationId);
    setIssuedAt(toInputDate(d.issuedAt));
    setDueAt(toInputDate(d.dueAt ?? d.dueDate));
    setTax(Number(d.tax ?? 0));
    setDiscount(Number(d.discount ?? 0));
    setNotes(d.notes ?? "");
    setItems(
      (d.items ?? []).map((it: InvoiceLineItem) => ({
        id: it.id,
        description: it.description,
        quantity: Number(it.quantity ?? 0),
        unitPrice: Number(it.unitPrice ?? 0),
      })),
    );
  }, [detailQuery.data]);

  const subtotal = useMemo(
    () =>
      items.reduce(
        (sum, it) => sum + Number(it.quantity || 0) * Number(it.unitPrice || 0),
        0,
      ),
    [items],
  );
  const total = subtotal + Number(tax || 0) - Number(discount || 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceNumber.trim()) {
        throw new Error("Invoice number is required.");
      }
      const trimmedItems = items.map((it) => ({
        ...it,
        description: it.description.trim(),
      }));
      if (trimmedItems.some((it) => !it.description)) {
        throw new Error("Each line item needs a description.");
      }
      const payload: Record<string, unknown> = {
        status: statusValue,
        invoiceNumber: invoiceNumber.trim(),
        tax,
        discount,
        notes: notes.trim() ? notes.trim() : null,
        items: trimmedItems.map((it, idx) => ({
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          sortOrder: idx,
        })),
      };
      payload.dueAt = dueAt ? new Date(dueAt).toISOString() : null;
      payload.issuedAt = issuedAt ? new Date(issuedAt).toISOString() : null;
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

  function updateItem(idx: number, patch: Partial<DraftLine>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveItem(idx: number, dir: -1 | 1) {
    setItems((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function addItem() {
    setItems((prev) => [...prev, { description: "", quantity: 1, unitPrice: 0 }]);
  }

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

          <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="md:col-span-1">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Invoice #
              </label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Status
              </label>
              <select
                value={statusValue}
                onChange={(e) => setStatusValue(e.target.value)}
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
                Client / Provider
              </label>
              <input
                type="text"
                value={
                  detailQuery.data?.providerOrganization?.name ||
                  invoice.providerOrganization?.name ||
                  providerId
                }
                disabled
                readOnly
                className="w-full h-9 px-2.5 rounded-md bg-secondary/40 border border-input text-sm text-muted-foreground cursor-not-allowed"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Provider is set on the originating case and cannot be changed here.
              </p>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Issued
              </label>
              <input
                type="date"
                value={issuedAt}
                onChange={(e) => setIssuedAt(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
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
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Line items</h3>
              <button
                type="button"
                onClick={addItem}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Plus size={13} /> Add line
              </button>
            </div>
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Description</th>
                    <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Unit price</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Total</th>
                    <th className="px-2 py-2 w-20" />
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        No line items. Click "Add line" to add one.
                      </td>
                    </tr>
                  )}
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        <input
                          type="text"
                          value={it.description}
                          onChange={(e) =>
                            updateItem(idx, { description: e.target.value })
                          }
                          placeholder="Description"
                          className="w-full h-8 px-2 rounded bg-background border border-input text-sm"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={it.quantity}
                          onChange={(e) =>
                            updateItem(idx, { quantity: Number(e.target.value) || 0 })
                          }
                          className="w-full h-8 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={it.unitPrice}
                          onChange={(e) =>
                            updateItem(idx, { unitPrice: Number(e.target.value) || 0 })
                          }
                          className="w-full h-8 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                        {formatMoney(Number(it.quantity || 0) * Number(it.unitPrice || 0))}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-0.5 justify-end">
                          <button
                            type="button"
                            onClick={() => moveItem(idx, -1)}
                            disabled={idx === 0}
                            className="h-7 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
                            aria-label="Move up"
                          >
                            <ArrowUp size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveItem(idx, 1)}
                            disabled={idx === items.length - 1}
                            className="h-7 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
                            aria-label="Move down"
                          >
                            <ArrowDown size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            className="h-7 w-7 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center"
                            aria-label="Remove line"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
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
                    <td />
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Tax
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={tax}
                        onChange={(e) => setTax(Number(e.target.value) || 0)}
                        className="w-24 h-7 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                      />
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Discount
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={discount}
                        onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                        className="w-24 h-7 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                      />
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t border-border bg-secondary/30">
                    <td colSpan={3} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Total
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                      {formatMoney(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section>
            <label className="block text-sm font-semibold mb-2">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Internal notes for this invoice (optional)"
              className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm resize-y"
            />
          </section>

          {detailQuery.data?.linkedTransactions && detailQuery.data.linkedTransactions.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Linked register entries</h3>
              <div className="border border-border rounded-md divide-y divide-border">
                {detailQuery.data.linkedTransactions.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="font-medium">
                        {formatMoney(
                          Number(t.creditAmount) - Number(t.debitAmount)
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t.accountName || "Bank"} · {formatDate(t.txnDate)}
                        {t.payee ? ` · ${t.payee}` : ""}
                      </div>
                    </div>
                    {t.source === "invoice" && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        auto
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {detailQuery.data?.payments && detailQuery.data.payments.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Payments</h3>
              <div className="border border-border rounded-md divide-y divide-border">
                {detailQuery.data.payments.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between px-3 py-2 text-sm"
                  >
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
