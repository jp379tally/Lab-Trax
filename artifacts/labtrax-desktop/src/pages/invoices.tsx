import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Ban,
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  Eye,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  Plus,
  Printer,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  Invoice,
  InvoiceDisplayMetadata,
  InvoiceLineItem,
  Organization,
  PracticeStatement,
} from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import {
  buildInvoicePdf,
  downloadInvoicePdf,
  previewInvoicePdf,
  printInvoicePdf,
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

function getUrlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function setUrlParams(updates: Record<string, string | null>) {
  if (typeof window === "undefined") return;
  const sp = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, "", url);
}

export default function InvoicesPage() {
  const queryClient = useQueryClient();

  const [search, setSearch] = useState(() => getUrlParam("q"));
  const [status, setStatus] = useState(() => getUrlParam("status") || "all");
  const [openOnly, setOpenOnly] = useState(
    () => getUrlParam("view") === "open",
  );
  const [aiOnly, setAiOnly] = useState(() => getUrlParam("ai") === "1");
  const [practiceId, setPracticeId] = useState(() => getUrlParam("practice"));
  const [overdueBucket, setOverdueBucket] = useState(
    () => getUrlParam("overdue"),
  );
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [statementBuilderOpen, setStatementBuilderOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const queryString = useMemo(() => {
    const sp = new URLSearchParams();
    if (openOnly) sp.set("status", "open");
    else if (status && status !== "all") sp.set("status", status);
    if (practiceId) sp.set("practiceId", practiceId);
    if (aiOnly) sp.set("aiOnly", "true");
    if (overdueBucket) sp.set("overdueBucket", overdueBucket);
    return sp.toString();
  }, [openOnly, status, practiceId, aiOnly, overdueBucket]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["invoices", queryString],
    queryFn: () =>
      apiFetch<Invoice[]>(
        `/invoices${queryString ? `?${queryString}` : ""}`,
      ),
  });

  useEffect(() => {
    setUrlParams({
      q: search || null,
      status: openOnly ? null : status === "all" ? null : status,
      view: openOnly ? "open" : null,
      ai: aiOnly ? "1" : null,
      practice: practiceId || null,
      overdue: overdueBucket || null,
    });
  }, [search, status, openOnly, aiOnly, practiceId, overdueBucket]);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    return rows
      .filter((i) => {
        if (openOnly) {
          if (i.status !== "open" && i.status !== "partially_paid") return false;
        } else if (status !== "all" && i.status !== status) {
          return false;
        }
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
  }, [data, search, status, openOnly]);

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
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenOnly(true)}
              className={`h-9 px-3 text-xs font-medium ${openOnly ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-secondary/70"}`}
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => setOpenOnly(false)}
              className={`h-9 px-3 text-xs font-medium border-l border-border ${!openOnly ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-secondary/70"}`}
            >
              All
            </button>
          </div>
          {!openOnly && (
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
          )}
          <select
            value={overdueBucket}
            onChange={(e) => setOverdueBucket(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            title="Overdue bucket"
          >
            <option value="">Any age</option>
            <option value="0_30">0–30 days overdue</option>
            <option value="31_60">31–60 days overdue</option>
            <option value="61_90">61–90 days overdue</option>
            <option value="90_plus">90+ days overdue</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={aiOnly}
              onChange={(e) => setAiOnly(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <Sparkles size={12} className="text-amber-500" />
            AI-imported only
          </label>
          <button
            type="button"
            onClick={() => setStatementBuilderOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-medium hover:bg-secondary"
            title="Build a multi-practice statement"
          >
            <FileText size={14} /> Statements
          </button>
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
                  <td className="px-5 py-3 font-mono text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {i.invoiceNumber}
                      {i.aiGenerated && !i.aiReviewedAt && (
                        <span title="AI-imported — needs review">
                          <Sparkles size={11} className="text-amber-500" />
                        </span>
                      )}
                    </span>
                  </td>
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
      {statementBuilderOpen && (
        <StatementBuilderDialog
          knownLabOrgId={data?.[0]?.labOrganizationId}
          onClose={() => setStatementBuilderOpen(false)}
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
  const { user } = useAuth();
  const isAdmin =
    user?.role === "owner" ||
    user?.role === "admin" ||
    user?.role === "billing";

  const detailQuery = useQuery({
    queryKey: ["invoice", invoice.id],
    queryFn: () => apiFetch<Invoice>(`/invoices/${invoice.id}`),
  });

  const practicesQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  const practices = useMemo(
    () =>
      (practicesQuery.data ?? []).filter(
        (o) =>
          (o.type === "provider" || o.type === "practice") &&
          !o.deletedAt &&
          (o.parentLabOrganizationId === invoice.labOrganizationId ||
            o.id === invoice.providerOrganizationId),
      ),
    [practicesQuery.data, invoice.labOrganizationId, invoice.providerOrganizationId],
  );

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
  const [reassignConfirm, setReassignConfirm] = useState<{
    targetId: string;
    targetName: string;
  } | null>(null);
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
  // Credits behave like a discount applied to the invoice (e.g. a
  // patient/practice deposit or store credit). They reduce the final
  // total just like the Discount field, and are shown as their own
  // line in the totals footer so the user can see exactly how the
  // total was computed.
  const total =
    subtotal +
    Number(tax || 0) -
    Number(discount || 0) -
    Number(credits || 0);

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

  const reassignMutation = useMutation({
    mutationFn: (newProviderId: string) =>
      apiFetch<Invoice>(`/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ providerOrganizationId: newProviderId }),
      }),
    onSuccess: (updated) => {
      setProviderId(updated.providerOrganizationId);
      setReassignConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
    },
    onError: (err: Error) => {
      setReassignConfirm(null);
      setError(err.message || "Reassignment failed.");
    },
  });

  const [emailOpen, setEmailOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [voidDialog, setVoidDialog] = useState<null | "void" | "writeoff">(null);

  const ackAiMutation = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${invoice.id}/ai-review`, {
        method: "PATCH",
        body: JSON.stringify({ acknowledged: true }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${invoice.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      onClose();
      // Brief alert: the user can find the duplicate at the top of the list.
      window.alert(`Created duplicate ${created.invoiceNumber}`);
    },
    onError: (err: Error) => setError(err.message || "Duplicate failed."),
  });

  const voidMutation = useMutation({
    mutationFn: async (input: { kind: "void" | "writeoff"; reason: string }) => {
      const path =
        input.kind === "void"
          ? `/invoices/${invoice.id}/void`
          : `/invoices/${invoice.id}/write-off`;
      return apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ reason: input.reason, reverseDeposit: true }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      setVoidDialog(null);
      onClose();
    },
    onError: (err: Error) => setError(err.message || "Operation failed."),
  });

  // Keyboard shortcuts: Cmd/Ctrl+S = save, Cmd/Ctrl+P = print, Esc = close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saveMutation.isPending) saveMutation.mutate();
      } else if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        printInvoicePdf(buildPdfOptions());
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setEmailOpen(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

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

  function handlePreviewPdf() {
    previewInvoicePdf(buildPdfOptions());
  }

  function handlePrintPdf() {
    printInvoicePdf(buildPdfOptions());
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
              onClick={handlePreviewPdf}
              disabled={detailQuery.isLoading}
              title="Preview the invoice without saving"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Eye size={14} /> Preview
            </button>
            <button
              type="button"
              onClick={handlePrintPdf}
              disabled={detailQuery.isLoading}
              title="Print the invoice"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Printer size={14} /> Print
            </button>
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
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-secondary"
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {moreOpen && (
                <div
                  className="absolute right-0 mt-1 z-50 w-56 bg-card border border-border rounded-md shadow-lg py-1 text-sm"
                  onMouseLeave={() => setMoreOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      duplicateMutation.mutate();
                    }}
                    disabled={duplicateMutation.isPending}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Copy size={14} /> Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setVoidDialog("writeoff");
                    }}
                    disabled={
                      invoice.status === "paid" || invoice.status === "void"
                    }
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <CheckCircle2 size={14} /> Write off balance
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setVoidDialog("void");
                    }}
                    disabled={invoice.status === "void"}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 text-destructive disabled:opacity-50"
                  >
                    <Ban size={14} /> Void invoice
                  </button>
                </div>
              )}
            </div>
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

          {invoice.aiGenerated && !invoice.aiReviewedAt && (
            <div className="flex items-start gap-3 px-3 py-2.5 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30">
              <Sparkles size={16} className="text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 text-sm">
                <div className="font-medium text-amber-900 dark:text-amber-200">
                  AI-imported invoice — please review
                </div>
                {invoice.aiPricingWarning && (
                  <div className="text-xs text-amber-800 dark:text-amber-300/90 mt-0.5">
                    {invoice.aiPricingWarning}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => ackAiMutation.mutate()}
                disabled={ackAiMutation.isPending}
                className="text-xs font-medium px-2.5 py-1 rounded border border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
              >
                Mark reviewed
              </button>
            </div>
          )}

          {invoice.voidedAt && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-sm">
              <Ban size={14} className="text-destructive" />
              <span className="font-medium">
                {invoice.voidKind === "writeoff" ? "Written off" : "Voided"}
              </span>
              {invoice.voidReason && (
                <span className="text-muted-foreground">— {invoice.voidReason}</span>
              )}
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
              {isAdmin ? (
                <select
                  value={providerId}
                  onChange={(e) => {
                    const targetId = e.target.value;
                    if (targetId === providerId) return;
                    const targetOrg = practices.find((p) => p.id === targetId);
                    setReassignConfirm({
                      targetId,
                      targetName: targetOrg?.displayName || targetOrg?.name || targetId,
                    });
                  }}
                  className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  disabled={practicesQuery.isLoading || reassignMutation.isPending}
                >
                  {practices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName || p.name}
                    </option>
                  ))}
                  {practices.length === 0 && (
                    <option value={providerId}>
                      {detailQuery.data?.providerOrganization?.name ||
                        invoice.providerOrganization?.name ||
                        providerId}
                    </option>
                  )}
                </select>
              ) : (
                <>
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
                    Admins can reassign invoices to a different practice.
                  </p>
                </>
              )}
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
                  {Number(credits || 0) > 0 && (
                    <tr className="border-t border-border">
                      <td
                        colSpan={4}
                        className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium"
                      >
                        Credits applied
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        −{formatMoney(Number(credits || 0))}
                      </td>
                      <td />
                    </tr>
                  )}
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
      {voidDialog && (
        <VoidConfirmDialog
          kind={voidDialog}
          pending={voidMutation.isPending}
          onCancel={() => setVoidDialog(null)}
          onConfirm={(reason) =>
            voidMutation.mutate({ kind: voidDialog, reason })
          }
        />
      )}
      {reassignConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Reassign invoice?</h3>
            <p className="text-sm text-muted-foreground">
              This invoice will be moved to{" "}
              <span className="font-medium text-foreground">
                {reassignConfirm.targetName}
              </span>
              . The change is saved immediately and logged in the audit trail.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setReassignConfirm(null)}
                disabled={reassignMutation.isPending}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => reassignMutation.mutate(reassignConfirm.targetId)}
                disabled={reassignMutation.isPending}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {reassignMutation.isPending && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VoidConfirmDialog({
  kind,
  pending,
  onCancel,
  onConfirm,
}: {
  kind: "void" | "writeoff";
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const isWriteoff = kind === "writeoff";
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold">
          {isWriteoff ? "Write off remaining balance?" : "Void this invoice?"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isWriteoff
            ? "This issues a write-off credit equal to the remaining balance and marks the invoice as settled. Any deposit linked to this invoice will be reversed."
            : "Voiding marks this invoice as cancelled and reverses any linked deposit. This is reversible only by re-creating the invoice."}
        </p>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
            Reason {isWriteoff ? "(optional)" : "(required)"}
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm resize-y"
            placeholder={isWriteoff ? "e.g. small balance write-off" : "e.g. duplicate invoice"}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={pending || (!isWriteoff && reason.trim().length === 0)}
            className={`h-9 px-3 rounded-md text-sm font-medium text-white disabled:opacity-50 ${isWriteoff ? "bg-primary hover:bg-primary/90" : "bg-destructive hover:bg-destructive/90"}`}
          >
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isWriteoff ? (
              "Write off"
            ) : (
              "Void"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatementBuilderDialog({
  knownLabOrgId,
  onClose,
}: {
  knownLabOrgId?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [providerOrgId, setProviderOrgId] = useState("");
  const [periodStart, setPeriodStart] = useState(
    firstOfMonth.toISOString().slice(0, 10),
  );
  const [periodEnd, setPeriodEnd] = useState(today.toISOString().slice(0, 10));
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<PracticeStatement | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [smsTo, setSmsTo] = useState("");

  const labOrgId = useMemo(() => {
    if (knownLabOrgId) return knownLabOrgId;
    return orgsQuery.data?.find((o) => o.type === "lab")?.id ?? "";
  }, [knownLabOrgId, orgsQuery.data]);

  const practiceOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((o) => o.type === "provider"),
    [orgsQuery.data],
  );

  const practiceName = useMemo(() => {
    return practiceOrgs.find((o) => o.id === providerOrgId)?.name || "Practice";
  }, [practiceOrgs, providerOrgId]);

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ statements: PracticeStatement[] }>(
        "/invoices/practice-statements/generate",
        {
          method: "POST",
          body: JSON.stringify({
            labOrganizationId: labOrgId,
            providerOrganizationIds: [providerOrgId],
            periodStart: new Date(periodStart).toISOString(),
            periodEnd: new Date(periodEnd).toISOString(),
            includeStatuses: openOnly
              ? ["open", "partially_paid"]
              : ["open", "partially_paid", "paid"],
          }),
        },
      );
      return res.statements?.[0] ?? null;
    },
    onSuccess: (s) => {
      setGenerated(s);
      queryClient.invalidateQueries({ queryKey: ["statements"] });
    },
    onError: (e: Error) => setError(e.message || "Failed to generate"),
  });

  const sendEmailMutation = useMutation({
    mutationFn: () => {
      if (!generated) throw new Error("Generate a statement first.");
      return apiFetch(
        `/invoices/practice-statements/${generated.id}/email`,
        {
          method: "POST",
          body: JSON.stringify({
            to: emailTo.trim(),
            subject: `Statement for ${practiceName}`,
            message: `Please find your account statement for ${periodStart} – ${periodEnd} attached.`,
          }),
        },
      );
    },
    onError: (e: Error) => setError(e.message || "Email failed"),
  });

  const sendSmsMutation = useMutation({
    mutationFn: () => {
      if (!generated) throw new Error("Generate a statement first.");
      const balance = Number(generated.balanceDue || 0);
      return apiFetch(
        `/invoices/practice-statements/${generated.id}/sms`,
        {
          method: "POST",
          body: JSON.stringify({
            to: smsTo.trim(),
            message: `${practiceName}: account statement for ${periodStart} – ${periodEnd}. Balance due ${formatMoney(balance)}. Reply with any questions.`,
          }),
        },
      );
    },
    onError: (e: Error) => setError(e.message || "SMS failed"),
  });

  function submit() {
    setError(null);
    if (!labOrgId) {
      setError("No lab organization found.");
      return;
    }
    if (!providerOrgId) {
      setError("Pick a practice.");
      return;
    }
    generateMutation.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold">Build practice statement</h3>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-secondary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
              Practice
            </label>
            <select
              value={providerOrgId}
              onChange={(e) => setProviderOrgId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              <option value="">Select practice…</option>
              {practiceOrgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Period start
              </label>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Period end
              </label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
            />
            Include only open invoices
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={generateMutation.isPending}
            className="h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {generateMutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FileText size={14} />
            )}
            Generate statement
          </button>
        </div>

        {generated && (
          <div className="border-t border-border pt-4 space-y-3">
            <div className="text-sm">
              <div className="font-medium">Statement generated</div>
              <div className="text-xs text-muted-foreground">
                {generated.invoiceCount} invoice
                {generated.invoiceCount === 1 ? "" : "s"} · billed{" "}
                {formatMoney(Number(generated.totalBilled || 0))} · balance{" "}
                {formatMoney(Number(generated.balanceDue || 0))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Email recipient
                </label>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="practice@example.com"
                    className="flex-1 h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => sendEmailMutation.mutate()}
                    disabled={sendEmailMutation.isPending || !emailTo.trim()}
                    className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary border border-border disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Mail size={14} /> Email
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  SMS recipient
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={smsTo}
                    onChange={(e) => setSmsTo(e.target.value)}
                    placeholder="+15551234567"
                    className="flex-1 h-9 px-2.5 rounded-md bg-background border border-input text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => sendSmsMutation.mutate()}
                    disabled={sendSmsMutation.isPending || !smsTo.trim()}
                    className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary border border-border disabled:opacity-50"
                  >
                    SMS
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
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
