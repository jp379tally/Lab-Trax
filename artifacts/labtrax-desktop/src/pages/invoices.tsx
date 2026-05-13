import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CreditCard,
  Download,
  Loader2,
  Mail,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import type { Invoice, InvoiceDisplayMetadata, InvoiceLineItem, Organization } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import {
  buildInvoicePdf,
  downloadInvoicePdf,
  type InvoicePdfOptions,
} from "@/lib/export";

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
  item: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

function readDisplayMetadata(inv: Invoice | undefined | null): InvoiceDisplayMetadata {
  if (!inv) return {};
  return (inv.displayMetadata ?? inv.displayMetadataJson ?? {}) as InvoiceDisplayMetadata;
}

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    return rows
      .filter((i) => {
        if (status !== "all" && i.status !== status) return false;
        if (!q) return true;
        const meta = readDisplayMetadata(i);
        return (
          i.invoiceNumber.toLowerCase().includes(q) ||
          (i.providerOrganization?.name || "").toLowerCase().includes(q) ||
          (meta.patientName || "").toLowerCase().includes(q) ||
          (meta.billTo || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) =>
        (b.createdAt || b.issuedAt || "").localeCompare(a.createdAt || a.issuedAt || ""),
      );
  }, [data, search, status]);

  const stats = useMemo(() => {
    const rows = data ?? [];
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    let openBalance = 0, openCount = 0;
    let overdueBalance = 0, overdueCount = 0;
    let paidThisMonth = 0, paidCount = 0;
    for (const inv of rows) {
      const isOpen = inv.status === "open" || inv.status === "partially_paid";
      if (isOpen) {
        const bal = Number(inv.balanceDue ?? inv.total ?? 0);
        openBalance += bal;
        openCount++;
        const due = inv.dueAt ?? inv.dueDate;
        if (due && new Date(due) < today) {
          overdueBalance += bal;
          overdueCount++;
        }
      }
      if (inv.status === "paid") {
        const ts = inv.updatedAt || inv.issuedAt || inv.createdAt;
        if (ts && new Date(ts) >= monthStart) {
          paidThisMonth += Number(inv.total ?? 0);
          paidCount++;
        }
      }
    }
    return { openBalance, openCount, overdueBalance, overdueCount, paidThisMonth, paidCount };
  }, [data]);

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Open balances, payments, and statements.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={14} /> New Invoice
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border border-border rounded-xl px-5 py-4">
          <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] uppercase tracking-wide font-medium mb-1.5">
            <TrendingUp size={12} /> Open Balance
          </div>
          <div className="text-2xl font-semibold tabular-nums">{formatMoney(stats.openBalance)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {stats.openCount} invoice{stats.openCount !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl px-5 py-4">
          <div className={`flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-medium mb-1.5 ${stats.overdueCount > 0 ? "text-destructive" : "text-muted-foreground"}`}>
            <AlertCircle size={12} /> Overdue
          </div>
          <div className={`text-2xl font-semibold tabular-nums ${stats.overdueCount > 0 ? "text-destructive" : ""}`}>
            {formatMoney(stats.overdueBalance)}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {stats.overdueCount} invoice{stats.overdueCount !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl px-5 py-4">
          <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] uppercase tracking-wide font-medium mb-1.5">
            <CheckCircle2 size={12} /> Paid This Month
          </div>
          <div className="text-2xl font-semibold tabular-nums">{formatMoney(stats.paidThisMonth)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {stats.paidCount} invoice{stats.paidCount !== 1 ? "s" : ""}
          </div>
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
                <th className="text-left font-medium py-2.5">Patient</th>
                <th className="text-left font-medium py-2.5">Bill to</th>
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
                  <td colSpan={9} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading invoices…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-muted-foreground">
                    No invoices match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((i) => {
                const meta = readDisplayMetadata(i);
                return (
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
                  <td className="py-3">
                    {meta.patientName || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-3 text-muted-foreground">
                    {meta.billTo || <span className="text-muted-foreground">—</span>}
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
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <InvoiceEditor invoice={editing} onClose={() => setEditing(null)} />
      )}
      {createOpen && (
        <CreateInvoiceDialog
          knownLabOrgId={data?.[0]?.labOrganizationId}
          onClose={() => setCreateOpen(false)}
          onCreated={(inv) => {
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
            setCreateOpen(false);
            setEditing(inv);
          }}
        />
      )}
    </div>
  );
}

export function InvoiceEditor({
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

  // Per-doctor priced item catalog used by the "Item" dropdown so
  // picking "Zirconia Crown" auto-fills its description and the
  // doctor-specific unit price. Only loaded for invoices linked to a
  // case (caseId is required by the server endpoint).
  const caseIdForPricing =
    detailQuery.data?.caseId ?? invoice.caseId ?? null;
  const pricedItemsQuery = useQuery({
    queryKey: ["pricing-resolve-items", caseIdForPricing],
    queryFn: () =>
      apiFetch<{
        items: Array<{
          key: string;
          label: string;
          unitPrice: number;
          source: string | null;
          sourceName: string | null;
        }>;
      }>(`/pricing/resolve-items?caseId=${encodeURIComponent(caseIdForPricing!)}`),
    enabled: !!caseIdForPricing,
  });
  const pricedItems = pricedItemsQuery.data?.items ?? [];

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
  const [patientName, setPatientName] = useState<string>("");
  const [billTo, setBillTo] = useState<string>("");
  const [teeth, setTeeth] = useState<string>("");
  const [shade, setShade] = useState<string>("");
  const [caseNotes, setCaseNotes] = useState<string>("");
  const [credits, setCredits] = useState<number>(0);
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
    const meta = readDisplayMetadata(d);
    setPatientName(meta.patientName ?? "");
    setBillTo(meta.billTo ?? "");
    setTeeth(meta.teeth ?? "");
    setShade(meta.shade ?? "");
    setCaseNotes(meta.caseNotes ?? "");
    setCredits(Number(meta.credits ?? 0) || 0);
    const metaItems = Array.isArray(meta.lineItems) ? meta.lineItems : [];
    setItems(
      (d.items ?? []).map((it: InvoiceLineItem, idx: number) => ({
        id: it.id,
        item: metaItems[idx]?.item ?? "",
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
        item: it.item.trim(),
        description: it.description.trim(),
      }));
      if (trimmedItems.some((it) => !it.description)) {
        throw new Error("Each line item needs a description.");
      }
      const existingMeta = readDisplayMetadata(detailQuery.data) as Record<
        string,
        unknown
      >;
      const displayMetadata: Record<string, unknown> = {
        ...existingMeta,
        patientName: patientName.trim(),
        billTo: billTo.trim(),
        teeth: teeth.trim(),
        shade: shade.trim(),
        caseNotes: caseNotes.trim(),
        credits: Number(credits) || 0,
        lineItems: trimmedItems.map((it) => ({
          item: it.item,
          description: it.description,
        })),
      };
      const payload: Record<string, unknown> = {
        status: statusValue,
        invoiceNumber: invoiceNumber.trim(),
        tax,
        discount,
        notes: notes.trim() ? notes.trim() : null,
        displayMetadata,
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
    setItems((prev) => [
      ...prev,
      { item: "", description: "", quantity: 1, unitPrice: 0 },
    ]);
  }

  const [emailOpen, setEmailOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  const practiceName =
    detailQuery.data?.providerOrganization?.name ||
    invoice.providerOrganization?.name ||
    providerId;
  const labName =
    detailQuery.data?.labOrganization?.name ||
    invoice.labOrganization?.name ||
    "";

  function buildPdfOptions(): InvoicePdfOptions {
    return {
      invoiceNumber,
      labName,
      practiceName,
      patientName,
      billTo,
      teeth,
      shade,
      caseNotes,
      issuedAt: issuedAt ? new Date(issuedAt).toISOString() : null,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      status: statusValue.replace(/_/g, " "),
      items: items.map((it) => ({
        item: it.item,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: Number(it.quantity || 0) * Number(it.unitPrice || 0),
      })),
      subtotal,
      tax,
      discount,
      credits,
      total,
      balanceDue: detailQuery.data?.balanceDue ?? total,
      notes,
      generatedAt: new Date(),
    };
  }

  function handleDownloadPdf() {
    downloadInvoicePdf(buildPdfOptions());
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
              onClick={handleDownloadPdf}
              disabled={detailQuery.isLoading}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Download size={14} /> PDF
            </button>
            <button
              type="button"
              onClick={() => setEmailOpen(true)}
              disabled={detailQuery.isLoading}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Mail size={14} /> Email
            </button>
            <button
              type="button"
              onClick={() => setRecordPaymentOpen(true)}
              disabled={detailQuery.isLoading || invoice.status === "paid" || invoice.status === "void"}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <CreditCard size={14} /> Record Payment
            </button>
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
            <h3 className="text-sm font-semibold mb-3">Patient & billing details</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Patient name
                </label>
                <input
                  type="text"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="Patient name"
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Bill to
                </label>
                <input
                  type="text"
                  value={billTo}
                  onChange={(e) => setBillTo(e.target.value)}
                  placeholder="Doctor or practice name"
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Teeth
                </label>
                <input
                  type="text"
                  value={teeth}
                  onChange={(e) => setTeeth(e.target.value)}
                  placeholder="e.g. 8, 9, 10"
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Shade
                </label>
                <input
                  type="text"
                  value={shade}
                  onChange={(e) => setShade(e.target.value)}
                  placeholder="e.g. A2"
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Case notes
                </label>
                <textarea
                  value={caseNotes}
                  onChange={(e) => setCaseNotes(e.target.value)}
                  rows={2}
                  placeholder="Case notes from the originating case"
                  className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm resize-y"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Credits
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={credits}
                  onChange={(e) => setCredits(Number(e.target.value) || 0)}
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
                />
              </div>
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
                    <th className="text-left font-medium px-3 py-2 w-44">Item</th>
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
                      <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                        No line items. Click "Add line" to add one.
                      </td>
                    </tr>
                  )}
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        {(() => {
                          // No priced catalog (case-less invoice or no
                          // tiers configured) → behave like the original
                          // free-text input.
                          if (pricedItems.length === 0) {
                            return (
                              <input
                                type="text"
                                value={it.item}
                                onChange={(e) =>
                                  updateItem(idx, { item: e.target.value })
                                }
                                placeholder="Item"
                                className="w-full h-8 px-2 rounded bg-background border border-input text-sm"
                              />
                            );
                          }
                          // A row is "in custom mode" when its item text
                          // exists but isn't one of the priced catalog
                          // labels — either because the user picked
                          // "Custom…" or because the item was typed in a
                          // prior session before the dropdown existed.
                          const isCustom =
                            !!it.item &&
                            !pricedItems.some((p) => p.label === it.item);
                          if (isCustom) {
                            return (
                              <div className="flex items-stretch gap-1">
                                <input
                                  type="text"
                                  value={it.item}
                                  onChange={(e) =>
                                    updateItem(idx, { item: e.target.value })
                                  }
                                  placeholder="Custom item name"
                                  className="flex-1 min-w-0 h-8 px-2 rounded bg-background border border-input text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateItem(idx, {
                                      item: "",
                                      description: "",
                                      unitPrice: 0,
                                    })
                                  }
                                  title="Pick from list"
                                  className="shrink-0 h-8 px-2 rounded border border-input bg-background text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
                                >
                                  List
                                </button>
                              </div>
                            );
                          }
                          // Standard catalog dropdown — picking an option
                          // auto-fills description + unit price from this
                          // doctor's effective tier / override.
                          return (
                            <select
                              value={it.item}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "") {
                                  updateItem(idx, {
                                    item: "",
                                    description: "",
                                    unitPrice: 0,
                                  });
                                  return;
                                }
                                if (v === "__custom__") {
                                  // Seed with a single space so the row
                                  // flips into custom mode (non-empty,
                                  // not a catalog label) and renders the
                                  // text input on the next paint.
                                  updateItem(idx, {
                                    item: " ",
                                    description: "",
                                    unitPrice: 0,
                                  });
                                  return;
                                }
                                const picked = pricedItems.find(
                                  (p) => p.label === v,
                                );
                                if (!picked) return;
                                updateItem(idx, {
                                  item: picked.label,
                                  description: picked.label,
                                  unitPrice: picked.unitPrice,
                                });
                              }}
                              className="w-full h-8 px-2 rounded bg-background border border-input text-sm"
                            >
                              <option value="">Select item…</option>
                              {pricedItems.map((p) => (
                                <option key={p.key} value={p.label}>
                                  {p.label}
                                  {p.unitPrice > 0
                                    ? ` — ${formatMoney(p.unitPrice)}`
                                    : " — no price set"}
                                </option>
                              ))}
                              <option value="__custom__">Custom…</option>
                            </select>
                          );
                        })()}
                      </td>
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
                    <td colSpan={4} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Subtotal
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(subtotal)}
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={4} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
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
                    <td colSpan={4} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
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
                    <td colSpan={4} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
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
      {emailOpen && (
        <EmailInvoiceDialog
          invoice={invoice}
          practiceName={practiceName}
          buildPdfOptions={buildPdfOptions}
          onClose={() => setEmailOpen(false)}
        />
      )}
      {recordPaymentOpen && (
        <RecordPaymentDialog
          invoice={detailQuery.data ?? invoice}
          onClose={() => setRecordPaymentOpen(false)}
          onRecorded={() => {
            queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
            setRecordPaymentOpen(false);
          }}
        />
      )}
    </div>
  );
}

function EmailInvoiceDialog({
  invoice,
  practiceName,
  buildPdfOptions,
  onClose,
}: {
  invoice: Invoice;
  practiceName: string;
  buildPdfOptions: () => InvoicePdfOptions;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(
    `Invoice ${invoice.invoiceNumber}`,
  );
  const [message, setMessage] = useState(
    `Hi ${practiceName},\n\nPlease find invoice ${invoice.invoiceNumber} attached.\n\nThank you,`,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function send() {
    setError(null);
    setSending(true);
    try {
      const built = buildInvoicePdf(buildPdfOptions());
      const trimmedTo = to.trim();
      const res = await apiFetch<{ sentAt: string; to: string }>(
        `/invoices/${invoice.id}/email`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(trimmedTo ? { to: trimmedTo } : {}),
            subject: subject.trim(),
            message,
            filename: built.filename,
            pdfBase64: built.base64,
          }),
        },
      );
      setSentAt(res.sentAt);
      setTo(res.to);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : (e as Error)?.message || "Failed to send.";
      setError(msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Email invoice</div>
            <div className="text-sm font-semibold font-mono">
              {invoice.invoiceNumber}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {sentAt ? (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-3 text-sm">
              <div className="font-medium text-success">Invoice sent.</div>
              <div className="text-xs text-muted-foreground mt-1">
                Delivered to {to} at {new Date(sentAt).toLocaleString("en-US")}.
              </div>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  To
                </span>
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="Leave blank to use the practice's billing email on file"
                  className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Subject
                </span>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Message
                </span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={8}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y"
                />
              </label>
              <div className="text-xs text-muted-foreground">
                The invoice PDF will be attached.
              </div>
              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            {sentAt ? "Close" : "Cancel"}
          </button>
          {!sentAt && (
            <button
              type="button"
              onClick={send}
              disabled={sending}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Mail size={14} />
              )}
              {sending ? "Sending…" : "Send email"}
            </button>
          )}
        </footer>
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

const PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH / Bank Transfer" },
  { value: "card", label: "Card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

function RecordPaymentDialog({
  invoice,
  onClose,
  onRecorded,
}: {
  invoice: Invoice;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const balanceDue = Number(invoice.balanceDue ?? invoice.total ?? 0);
  const [amount, setAmount] = useState<string>(
    balanceDue > 0 ? balanceDue.toFixed(2) : "",
  );
  const [method, setMethod] = useState<string>("check");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) {
      setError("Enter a valid payment amount.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch(`/invoices/${invoice.id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          amount: parsed,
          paymentMethod: method,
          ...(reference.trim() ? { referenceNumber: reference.trim() } : {}),
        }),
      });
      onRecorded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to record payment.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Record payment</div>
            <div className="text-sm font-semibold font-mono">{invoice.invoiceNumber}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-4 space-y-4">
          {balanceDue > 0 && (
            <div className="rounded-md bg-secondary/60 px-3 py-2 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="font-semibold tabular-nums">{formatMoney(balanceDue)}</span>
            </div>
          )}
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Amount</span>
            <div className="relative mt-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input
                type="number"
                min={0.01}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full h-9 pl-7 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary tabular-nums"
                placeholder="0.00"
                autoFocus
              />
            </div>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Method</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Reference # <span className="normal-case text-muted-foreground font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Check #, confirmation #…"
              className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </label>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
            {saving ? "Saving…" : "Record Payment"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CreateInvoiceDialog({
  knownLabOrgId,
  onClose,
  onCreated,
}: {
  knownLabOrgId?: string;
  onClose: () => void;
  onCreated: (inv: Invoice) => void;
}) {
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const labOrgs = (orgsQuery.data ?? []).filter((o) => o.type === "lab");
  const providerOrgs = (orgsQuery.data ?? []).filter((o) => o.type === "provider");

  const defaultLabId = knownLabOrgId ?? labOrgs[0]?.id ?? "";

  const [labOrgId, setLabOrgId] = useState(defaultLabId);
  const [providerOrgId, setProviderOrgId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(toInputDate(new Date().toISOString()));
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!labOrgId && labOrgs.length) setLabOrgId(labOrgs[0].id);
  }, [labOrgs, labOrgId]);

  async function submit() {
    if (!invoiceNumber.trim()) { setError("Invoice number is required."); return; }
    if (!providerOrgId) { setError("Select a client / practice."); return; }
    if (!labOrgId) { setError("No lab organization found."); return; }
    setError(null);
    setSaving(true);
    try {
      const inv = await apiFetch<Invoice>("/invoices", {
        method: "POST",
        body: JSON.stringify({
          invoiceNumber: invoiceNumber.trim(),
          labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          issuedAt: issuedAt ? new Date(issuedAt).toISOString() : undefined,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        }),
      });
      onCreated(inv);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create invoice.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-sm font-semibold">New Invoice</div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-4 space-y-4">
          {labOrgs.length > 1 && (
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Lab</span>
              <select
                value={labOrgId}
                onChange={(e) => setLabOrgId(e.target.value)}
                className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
              >
                {labOrgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.displayName || o.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Client / Practice</span>
            <select
              value={providerOrgId}
              onChange={(e) => setProviderOrgId(e.target.value)}
              className="mt-1 w-full h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            >
              <option value="">Select a practice…</option>
              {providerOrgs.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName || o.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Invoice Number</span>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2026-001"
              className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary font-mono"
              autoFocus
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Issue Date</span>
              <input
                type="date"
                value={issuedAt}
                onChange={(e) => setIssuedAt(e.target.value)}
                className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Due Date <span className="normal-case font-normal">(optional)</span>
              </span>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="mt-1 w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
              />
            </label>
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            The invoice opens as a draft. Add line items in the editor.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || orgsQuery.isLoading}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {saving ? "Creating…" : "Create Invoice"}
          </button>
        </footer>
      </div>
    </div>
  );
}
