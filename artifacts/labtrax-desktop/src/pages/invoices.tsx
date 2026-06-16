import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  Plus,
  Printer,
  ScrollText,
  Search,
  Send,
  Sparkles,
  Stethoscope,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import QRCodeLib from "qrcode";
import { apiFetch, ApiError, getApiOrigin, getAccessToken } from "@/lib/api";
import { setNavBlocker } from "@/lib/nav-guard";
import { DoctorNamePicker } from "@/components/DoctorNamePicker";
import {
  ItemCombobox,
  type ItemComboboxOption,
} from "@/components/ItemCombobox";
import type {
  CaseAttachment,
  CaseRestoration,
  Invoice,
  InvoiceDisplayMetadata,
  InvoiceLineItem,
  LabCase,
  Organization,
  PracticeStatement,
} from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import {
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
} from "@/lib/rx-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { PrescriptionPreview } from "@/components/PrescriptionPreview";
import {
  buildInvoicePdf,
  downloadInvoicePdf,
  previewInvoicePdf,
  printInvoicePdf,
  type InvoicePdfOptions,
} from "@/lib/export";
import { useInvoiceTemplate } from "@/lib/use-invoice-template";

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
  toothNumber?: number | null;
  toothLabel?: string | null;
  subItems?: DraftLine[];
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

type SortKey = "practice" | "issued" | "due";
type SortDir = "asc" | "desc";

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

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
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [statementBuilderOpen, setStatementBuilderOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSendOpen, setBulkSendOpen] = useState(false);

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

  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
    staleTime: 60_000,
  });
  const distinctDoctorNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of casesQuery.data ?? []) {
      if (c.doctorName?.trim()) names.add(c.doctorName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [casesQuery.data]);

  const practicesQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
    staleTime: 60_000,
  });
  const practiceOptions = useMemo(
    () =>
      (practicesQuery.data ?? []).filter(
        (o) =>
          (o.type === "provider" || o.type === "practice") && !o.deletedAt,
      ).sort((a, b) => a.name.localeCompare(b.name)),
    [practicesQuery.data],
  );

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

  useEffect(() => { setSelected(new Set()); }, [search, status, openOnly, aiOnly, practiceId, overdueBucket]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = search.trim().toLowerCase();
    const list = rows.filter((i) => {
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
    });

    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      list.sort((a, b) => {
        if (sortKey === "practice") {
          return dir * (a.providerOrganization?.name || "").localeCompare(b.providerOrganization?.name || "");
        }
        if (sortKey === "issued") {
          return dir * (a.issuedAt || "").localeCompare(b.issuedAt || "");
        }
        if (sortKey === "due") {
          return dir * ((a.dueAt ?? a.dueDate) || "").localeCompare((b.dueAt ?? b.dueDate) || "");
        }
        return 0;
      });
    } else {
      list.sort((a, b) =>
        (b.createdAt || b.issuedAt || "").localeCompare(a.createdAt || a.issuedAt || ""),
      );
    }

    return list;
  }, [data, search, status, openOnly, sortKey, sortDir]);

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
          <select
            value={practiceId}
            onChange={(e) => setPracticeId(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
            title="Filter by practice"
          >
            <option value="">All practices</option>
            {practiceOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
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

        {selected.size > 0 && (
          <div className="flex items-center gap-3 px-5 py-2 bg-primary/5 border border-primary/20 rounded-md mb-2 text-sm">
            <span className="font-medium text-primary">{selected.size} invoice{selected.size !== 1 ? "s" : ""} selected</span>
            <button
              type="button"
              onClick={() => setBulkSendOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
            >
              <Send size={12} /> Send {selected.size > 1 ? `${selected.size} invoices` : "invoice"}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={filtered.length > 0 && filtered.every((i) => selected.has(i.id))}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !filtered.every((i) => selected.has(i.id));
                    }}
                    onChange={(e) => {
                      setSelected(e.target.checked ? new Set(filtered.map((i) => i.id)) : new Set());
                    }}
                    title={selected.size > 0 && !filtered.every((i) => selected.has(i.id)) ? "Deselect all" : "Select all"}
                  />
                </th>
                <th className="text-left font-medium px-2 py-2.5">Invoice #</th>
                <th className="text-left font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("practice")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Practice
                    {sortKey === "practice" ? (
                      sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                    ) : (
                      <span className="opacity-30"><ArrowUp size={10} /></span>
                    )}
                  </button>
                </th>
                <th className="text-left font-medium py-2.5">Patient</th>
                <th className="text-left font-medium py-2.5">Bill to</th>
                <th className="text-left font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("issued")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Issued
                    {sortKey === "issued" ? (
                      sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                    ) : (
                      <span className="opacity-30"><ArrowUp size={10} /></span>
                    )}
                  </button>
                </th>
                <th className="text-left font-medium py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("due")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Due
                    {sortKey === "due" ? (
                      sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                    ) : (
                      <span className="opacity-30"><ArrowUp size={10} /></span>
                    )}
                  </button>
                </th>
                <th className="text-left font-medium py-2.5">Status</th>
                <th className="text-right font-medium py-2.5">Total</th>
                <th className="text-right font-medium px-5 py-2.5">Balance</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={10} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading invoices…
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={10} className="px-5 py-12 text-center text-destructive">
                    {(error as Error).message}
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-5 py-12 text-center text-muted-foreground">
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
                  className={`border-t border-border cursor-pointer hover:bg-secondary/40 ${selected.has(i.id) ? "bg-primary/5" : ""}`}
                >
                  <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={selected.has(i.id)}
                      onChange={(e) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(i.id); else next.delete(i.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td className="px-2 py-3 font-mono text-xs">
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
        <InvoiceEditor
          invoice={editing}
          doctorNames={distinctDoctorNames}
          onClose={() => setEditing(null)}
          onGoToCase={() => {
            const caseId = editing.caseId;
            if (caseId) {
              // Don't unmount the editor first — navigating while dirty must let
              // the navigation guard show the discard prompt. The route change
              // itself unmounts the editor once the user proceeds.
              setLocation(`/cases?caseId=${encodeURIComponent(caseId)}`);
            } else {
              setEditing(null);
            }
          }}
        />
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
      {bulkSendOpen && (
        <BulkSendDialog
          invoices={filtered.filter((i) => selected.has(i.id))}
          onClose={() => setBulkSendOpen(false)}
          onSent={() => { setSelected(new Set()); setBulkSendOpen(false); }}
        />
      )}
    </div>
  );
}

function BulkSendDialog({
  invoices,
  onClose,
  onSent,
}: {
  invoices: Invoice[];
  onClose: () => void;
  onSent: () => void;
}) {
  const { user } = useAuth();
  const [subject, setSubject] = useState("Your invoice from our lab");
  const [message, setMessage] = useState(
    "Hi,\n\nPlease find your invoice(s) attached.\n\nThank you,",
  );
  const [phase, setPhase] = useState<"compose" | "sending" | "done">("compose");
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<{ invoiceNumber: string; status: "sent" | "failed"; error?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { template: invoiceTemplate, extraImageDataUrls } = useInvoiceTemplate(
    user?.practiceOrganizationId ?? null,
  );
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const logoUrl = user?.practiceLogoUrl;
    if (!logoUrl) return;
    fetch(logoUrl)
      .then((r) => r.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onload = () => setLogoDataUrl(reader.result as string);
        reader.readAsDataURL(blob);
      })
      .catch(() => {});
  }, [user?.practiceLogoUrl]);

  function buildOptions(inv: Invoice): InvoicePdfOptions {
    const meta: InvoiceDisplayMetadata = inv.displayMetadata ?? inv.displayMetadataJson ?? {};
    return {
      invoiceNumber: inv.invoiceNumber,
      labName: inv.labOrganization?.name ?? "",
      practiceName: inv.providerOrganization?.name ?? "",
      patientName: meta.patientName ?? null,
      billTo: meta.billTo ?? null,
      teeth: meta.teeth ?? null,
      shade: meta.shade ?? null,
      caseNotes: meta.caseNotes ?? null,
      issuedAt: inv.issuedAt ?? null,
      dueAt: inv.dueAt ?? inv.dueDate ?? null,
      status: (inv.status ?? "").replace(/_/g, " "),
      items: (inv.items ?? []).map((it) => ({
        item: null,
        toothNumber: it.toothNumber ?? null,
        toothLabel: it.toothLabel ?? null,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0),
        subItems: (it.subItems ?? []).map((sub) => ({
          item: null,
          toothNumber: sub.toothNumber ?? null,
          description: sub.description,
          quantity: sub.quantity,
          unitPrice: sub.unitPrice,
          lineTotal: Number(sub.quantity ?? 0) * Number(sub.unitPrice ?? 0),
        })),
      })),
      subtotal: inv.subtotal ?? 0,
      tax: inv.tax ?? null,
      discount: inv.discount ?? null,
      credits: meta.credits ?? null,
      total: inv.total ?? 0,
      balanceDue: inv.balanceDue ?? inv.total ?? 0,
      notes: inv.notes ?? null,
      generatedAt: new Date(),
      logoUrl: logoDataUrl,
      template: invoiceTemplate,
      extraImageDataUrls,
    };
  }

  async function handleSend() {
    setError(null);
    setPhase("sending");
    setProgress(0);
    const items: Array<{ invoiceId: string; subject: string; message: string; filename: string; pdfBase64: string }> = [];
    const partial: typeof results = [];
    for (let idx = 0; idx < invoices.length; idx++) {
      const inv = invoices[idx];
      setProgress(idx + 1);
      try {
        const built = buildInvoicePdf(buildOptions(inv));
        items.push({
          invoiceId: inv.id,
          subject: subject.trim(),
          message,
          filename: built.filename,
          pdfBase64: built.base64,
        });
        partial.push({ invoiceNumber: inv.invoiceNumber, status: "sent" });
      } catch (e) {
        partial.push({ invoiceNumber: inv.invoiceNumber, status: "failed", error: (e as Error)?.message || "PDF generation failed" });
      }
    }
    if (items.length > 0) {
      try {
        await apiFetch("/invoices/batch-email", {
          method: "POST",
          body: JSON.stringify({ items }),
        });
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "Failed to send";
        setError(msg);
        setPhase("done");
        setResults(partial.map((r) => r.status === "sent" ? { ...r, status: "failed" as const, error: msg } : r));
        return;
      }
    }
    setResults(partial);
    setPhase("done");
  }

  const sentCount = results.filter((r) => r.status === "sent").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/40">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Bulk email</div>
            <div className="text-sm font-semibold">
              {invoices.length} invoice{invoices.length !== 1 ? "s" : ""}
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

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {phase === "compose" && (
            <>
              <div className="text-xs text-muted-foreground bg-secondary/50 rounded-md px-3 py-2 space-y-0.5">
                {invoices.slice(0, 5).map((inv) => (
                  <div key={inv.id} className="font-mono">{inv.invoiceNumber} — {inv.providerOrganization?.name ?? "—"}</div>
                ))}
                {invoices.length > 5 && <div className="text-muted-foreground">…and {invoices.length - 5} more</div>}
              </div>
              <p className="text-xs text-muted-foreground">
                Each invoice PDF will be generated and sent to the billing email on file for that practice. Invoices without a billing email will be skipped.
              </p>
              <div>
                <label className="block text-xs font-medium mb-1">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
              </div>
            </>
          )}

          {phase === "sending" && (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-sm text-muted-foreground">
              <Loader2 size={24} className="animate-spin text-primary" />
              <p>Building PDF {progress} of {invoices.length}…</p>
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-3">
              <div className={`flex items-center gap-2 text-sm font-medium ${failedCount === 0 ? "text-emerald-600" : "text-amber-600"}`}>
                {failedCount === 0
                  ? <><CheckCircle2 size={15} /> {sentCount} invoice{sentCount !== 1 ? "s" : ""} sent successfully</>
                  : <><AlertCircle size={15} /> {sentCount} sent, {failedCount} failed</>}
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <ul className="space-y-1 text-xs max-h-48 overflow-y-auto">
                {results.map((r) => (
                  <li key={r.invoiceNumber} className={`flex items-center gap-2 ${r.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {r.status === "sent" ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                    <span className="font-mono">{r.invoiceNumber}</span>
                    {r.error && <span className="truncate">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          {phase === "done" ? (
            <button
              type="button"
              onClick={sentCount > 0 ? onSent : onClose}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={phase === "sending"}
                className="px-4 py-2 rounded-md border border-border text-sm hover:bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={phase === "sending" || !subject.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                <Send size={14} /> Send {invoices.length} invoice{invoices.length !== 1 ? "s" : ""}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// Serialize the editable invoice form fields into a stable string so we can
// detect whether the user has made unsaved edits (dirty check). Only fields
// that the Save action actually persists are included; provider reassignment
// is saved independently and is intentionally excluded.
function serializeInvoiceForm(f: {
  invoiceNumber: string;
  statusValue: string;
  issuedAt: string;
  dueAt: string;
  tax: number;
  discount: number;
  credits: number;
  notes: string;
  patientName: string;
  billTo: string;
  teeth: string;
  shade: string;
  caseNotes: string;
  layoutPresetId: string | null;
  items: DraftLine[];
}): string {
  return JSON.stringify({
    invoiceNumber: f.invoiceNumber,
    statusValue: f.statusValue,
    issuedAt: f.issuedAt,
    dueAt: f.dueAt,
    tax: Number(f.tax || 0),
    discount: Number(f.discount || 0),
    credits: Number(f.credits || 0),
    notes: f.notes,
    patientName: f.patientName,
    billTo: f.billTo,
    teeth: f.teeth,
    shade: f.shade,
    caseNotes: f.caseNotes,
    layoutPresetId: f.layoutPresetId ?? null,
    items: f.items.map((it) => ({
      item: it.item,
      description: it.description,
      quantity: Number(it.quantity || 0),
      unitPrice: Number(it.unitPrice || 0),
      toothNumber: it.toothNumber ?? null,
      toothLabel: it.toothLabel ?? null,
      subItems: (it.subItems ?? []).map((sub) => ({
        item: sub.item,
        description: sub.description,
        quantity: Number(sub.quantity || 0),
        unitPrice: Number(sub.unitPrice || 0),
        toothNumber: sub.toothNumber ?? null,
      })),
    })),
  });
}

export function InvoiceEditor({
  invoice,
  doctorNames,
  onClose,
  onGoToCase,
}: {
  invoice: Invoice;
  doctorNames?: string[];
  onClose: () => void;
  onGoToCase?: () => void;
}) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isAdmin =
    user?.role === "owner" ||
    user?.role === "admin" ||
    user?.role === "billing";

  // Column widths for the line-items table (Item, Tooth #, Desc, Qty, Unit price, Total)
  const COL_DEFAULTS = [176, 112, 220, 64, 112, 96] as const;
  const ACTION_COL_WIDTH = 80;
  const {
    widths: colWidths,
    totalWidth: colTotalWidth,
    resizingCol,
    startResize,
    resetColumn,
    resetAll: resetAllColWidths,
  } =
    useColumnWidths([...COL_DEFAULTS], user?.id);

  // Resizable panel width — drag the left edge to expand/shrink.
  const PANEL_WIDTH_KEY = "labtrax_invoice_panel_width_v1";
  const PANEL_MIN = 480;
  const PANEL_MAX = Math.round(window.innerWidth * 0.95);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? "", 10);
    return isNaN(stored) ? 768 : Math.min(Math.max(stored, PANEL_MIN), PANEL_MAX);
  });
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      const next = Math.min(Math.max(dragRef.current.startWidth + delta, PANEL_MIN), Math.round(window.innerWidth * 0.95));
      setPanelWidth(next);
    }
    function onUp() {
      setPanelWidth((w) => { localStorage.setItem(PANEL_WIDTH_KEY, String(w)); return w; });
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panelWidth, PANEL_MIN]);

  // Layout preset selection (per-invoice override of the lab's default template).
  const [layoutPresetId, setLayoutPresetId] = useState<string | null>(
    invoice.layoutPresetId ?? null,
  );
  const presetsQuery = useQuery({
    queryKey: ["invoice-template-presets", invoice.labOrganizationId],
    queryFn: () =>
      apiFetch<{ presets: Array<{ id: string; name: string; template: unknown; savedAt: string }> }>(
        `/organizations/${invoice.labOrganizationId}/invoice-template/presets`,
      ),
    staleTime: 60_000,
  });
  const availablePresets = presetsQuery.data?.presets ?? [];

  // Use the selected preset's template if one is picked and still exists;
  // fall back to the lab-default template from the /me payload.
  const selectedPresetTemplate =
    layoutPresetId != null
      ? (availablePresets.find((p) => p.id === layoutPresetId)?.template ?? null)
      : null;

  // Per-lab visual invoice template + preloaded extra-image data URLs.
  // Passes the preset template when one is selected so extra images in the
  // preset are preloaded the same way as the lab-default template.
  const { template: invoiceTemplate, extraImageDataUrls } = useInvoiceTemplate(
    selectedPresetTemplate ?? user?.practiceInvoiceTemplate,
  );


  // Pre-fetch lab logo as a data-URL for invoice PDFs (only when placement is active)
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const invoicePlacementActive = !!(user?.practiceLogoplacements?.includes("invoices"));
  useEffect(() => {
    const logoUrl = user?.practiceLogoUrl;
    if (!invoicePlacementActive || !logoUrl) {
      setLogoDataUrl(null);
      return;
    }
    let cancelled = false;
    fetch(logoUrl)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => {
        if (!cancelled) setLogoDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setLogoDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [invoicePlacementActive, user?.practiceLogoUrl]);

  const detailQuery = useQuery({
    queryKey: ["invoice", invoice.id],
    queryFn: () => apiFetch<Invoice>(`/invoices/${invoice.id}`),
  });

  // Self-fetch doctors when the parent page doesn't provide them.
  const casesQuery = useQuery({
    queryKey: ["cases"],
    queryFn: () => apiFetch<LabCase[]>("/cases"),
    staleTime: 60_000,
    enabled: !doctorNames,
  });
  const editorDoctorNames = useMemo(() => {
    if (doctorNames) return doctorNames;
    const names = new Set<string>();
    for (const c of casesQuery.data ?? []) {
      if (c.doctorName?.trim()) names.add(c.doctorName.trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [doctorNames, casesQuery.data]);

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

  // Fetch the linked case to get its canonical caseNumber for the QR URL.
  // Declared after caseIdForPricing so the query key is known at render time.
  const linkedCaseQuery = useQuery({
    queryKey: ["case-number-for-invoice", caseIdForPricing],
    queryFn: () =>
      apiFetch<LabCase & { restorations?: CaseRestoration[]; caseNotes?: string | null }>(
        `/cases/${caseIdForPricing}`,
      ),
    enabled: !!caseIdForPricing,
    staleTime: 300_000,
  });
  const linkedCase = linkedCaseQuery.data ?? null;
  const linkedCaseNumber = linkedCase?.caseNumber ?? null;
  const linkedRxSummary = useMemo(
    () => deriveRxSummary(linkedCase?.restorations),
    [linkedCase?.restorations],
  );
  const linkedRxTeethLabel = useMemo(
    () =>
      formatRxTeethWithShades(
        linkedCase?.restorations,
        formatRxTeethLabel(linkedRxSummary),
      ),
    [linkedCase?.restorations, linkedRxSummary],
  );

  // Pre-generate a QR code data URL for the invoice PDF. The QR encodes the
  // case deep-link URL so recipients can scan to open the case in LabTrax.
  // Uses the linked case's caseNumber so the URL resolves correctly even when
  // the invoice number diverges from the case number.
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const caseNum = linkedCaseNumber ?? invoice.invoiceNumber;
    if (!caseNum) {
      setQrCodeDataUrl(null);
      return;
    }
    const qrUrl = `${window.location.origin}/cases/${encodeURIComponent(caseNum)}`;
    let cancelled = false;
    QRCodeLib.toDataURL(qrUrl, { margin: 1, width: 120 })
      .then((dataUrl) => {
        if (!cancelled) setQrCodeDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrCodeDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedCaseNumber, invoice.invoiceNumber]);

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

  const billableItemsQuery = useQuery({
    queryKey: ["finance", "vendors", invoice.labOrganizationId, "items"],
    queryFn: () =>
      apiFetch<Array<{ id: string; name: string; unitPrice: string | null }>>(
        `/finance/vendors?organizationId=${encodeURIComponent(invoice.labOrganizationId)}&vendorType=item`,
      ),
    enabled: !!invoice.labOrganizationId,
    staleTime: 60_000,
  });
  const billableItems = billableItemsQuery.data ?? [];

  // Unified options for the ITEM typeahead: priced catalog items first, then
  // the lab's custom billable items, de-duped by (case-insensitive) name.
  const itemOptions = useMemo<ItemComboboxOption[]>(() => {
    const seen = new Set<string>();
    const opts: ItemComboboxOption[] = [];
    for (const p of pricedItems) {
      const key = p.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({
        key: `p:${p.key}`,
        name: p.label,
        unitPrice: p.unitPrice,
        group: "catalog",
      });
    }
    for (const b of billableItems) {
      const key = b.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({
        key: `b:${b.id}`,
        name: b.name,
        unitPrice: b.unitPrice != null ? Number(b.unitPrice) : null,
        group: "custom",
      });
    }
    return opts;
  }, [pricedItems, billableItems]);

  const caseAttachmentsQuery = useQuery({
    queryKey: ["case-attachments-for-invoice", caseIdForPricing],
    queryFn: () =>
      apiFetch<{ attachments: CaseAttachment[] }>(
        `/cases/${caseIdForPricing}/attachments`,
      ).then((r) => r.attachments),
    enabled: !!caseIdForPricing,
  });
  const rxAttachments = caseAttachmentsQuery.data ?? [];
  const [prescriptionPreviewOpen, setPrescriptionPreviewOpen] = useState(false);

  async function openAttachmentFile(att: CaseAttachment) {
    const url = `${getApiOrigin()}/api/cases/${att.caseId}/attachments/${att.id}/file`;
    const token = getAccessToken();
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { window.alert("Could not open file."); return; }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl; a.target = "_blank"; a.rel = "noreferrer";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }

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
  // Baseline snapshot of the form (set when detail loads) for the dirty check.
  const baselineRef = useRef<string | null>(null);
  // When unsaved edits would be lost (close, route navigation, etc.) we stash
  // the action to run if the user confirms; a non-null value shows the
  // "Discard changes?" confirmation.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(
    null,
  );

  useEffect(() => {
    const d = detailQuery.data;
    if (!d) return;
    const nextStatus = EDITABLE_STATUSES.includes(
      d.status as (typeof EDITABLE_STATUSES)[number],
    )
      ? d.status
      : "open";
    const nextIssuedAt = toInputDate(d.issuedAt);
    const nextDueAt = toInputDate(d.dueAt ?? d.dueDate);
    const nextTax = Number(d.tax ?? 0);
    const nextDiscount = Number(d.discount ?? 0);
    const nextNotes = d.notes ?? "";
    const meta = readDisplayMetadata(d);
    const nextPatientName = meta.patientName ?? "";
    const nextBillTo = meta.billTo ?? "";
    const nextTeeth = meta.teeth ?? "";
    const nextShade = meta.shade ?? "";
    const nextCaseNotes = meta.caseNotes ?? "";
    const nextCredits = Number(meta.credits ?? 0) || 0;
    const nextLayoutPresetId = (d as any).layoutPresetId ?? null;
    const metaItems = Array.isArray(meta.lineItems) ? meta.lineItems : [];
    const nextItems: DraftLine[] = (d.items ?? []).map(
      (it: InvoiceLineItem, idx: number) => ({
        id: it.id,
        item: metaItems[idx]?.item ?? "",
        description: it.description,
        quantity: Number(it.quantity ?? 0),
        unitPrice: Number(it.unitPrice ?? 0),
        toothNumber: (it as any).toothNumber ?? null,
        toothLabel: (it as any).toothLabel ?? null,
        subItems: ((it as any).subItems ?? []).map((sub: any, sidx: number) => ({
          id: sub.id,
          item: (metaItems[idx]?.subItems as any[])?.[sidx]?.item ?? "",
          description: sub.description,
          quantity: Number(sub.quantity ?? 0),
          unitPrice: Number(sub.unitPrice ?? 0),
          toothNumber: sub.toothNumber ?? null,
        })),
      }),
    );
    setInvoiceNumber(d.invoiceNumber);
    setStatusValue(nextStatus);
    setProviderId(d.providerOrganizationId);
    setIssuedAt(nextIssuedAt);
    setDueAt(nextDueAt);
    setTax(nextTax);
    setDiscount(nextDiscount);
    setNotes(nextNotes);
    setPatientName(nextPatientName);
    setBillTo(nextBillTo);
    setTeeth(nextTeeth);
    setShade(nextShade);
    setCaseNotes(nextCaseNotes);
    setCredits(nextCredits);
    setLayoutPresetId(nextLayoutPresetId);
    setItems(nextItems);
    // Record the loaded state as the dirty-check baseline.
    baselineRef.current = serializeInvoiceForm({
      invoiceNumber: d.invoiceNumber,
      statusValue: nextStatus,
      issuedAt: nextIssuedAt,
      dueAt: nextDueAt,
      tax: nextTax,
      discount: nextDiscount,
      credits: nextCredits,
      notes: nextNotes,
      patientName: nextPatientName,
      billTo: nextBillTo,
      teeth: nextTeeth,
      shade: nextShade,
      caseNotes: nextCaseNotes,
      layoutPresetId: nextLayoutPresetId,
      items: nextItems,
    });
  }, [detailQuery.data]);

  const subtotal = useMemo(
    () =>
      items.reduce((sum, it) => {
        const lineAmt = Number(it.quantity || 0) * Number(it.unitPrice || 0);
        const subAmt = (it.subItems ?? []).reduce(
          (s, sub) => s + Number(sub.quantity || 0) * Number(sub.unitPrice || 0),
          0,
        );
        return sum + lineAmt + subAmt;
      }, 0),
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
        subItems: (it.subItems ?? []).map((sub) => ({
          ...sub,
          item: sub.item.trim(),
          description: sub.description.trim(),
        })),
      }));
      if (
        trimmedItems.some(
          (it) =>
            !it.description ||
            (it.subItems ?? []).some((sub) => !sub.description),
        )
      ) {
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
          subItems: (it.subItems ?? []).map((sub) => ({
            item: sub.item,
            description: sub.description,
          })),
        })),
      };
      const payload: Record<string, unknown> = {
        status: statusValue,
        invoiceNumber: invoiceNumber.trim(),
        tax,
        discount,
        notes: notes.trim() ? notes.trim() : null,
        displayMetadata,
        layoutPresetId: layoutPresetId ?? null,
        items: trimmedItems.map((it, idx) => ({
          toothNumber: it.toothNumber ?? null,
          toothLabel: it.toothLabel ?? null,
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          sortOrder: idx,
          subItems: (it.subItems ?? []).map((sub, sidx) => ({
            toothNumber: sub.toothNumber ?? null,
            description: sub.description,
            quantity: sub.quantity,
            unitPrice: sub.unitPrice,
            sortOrder: sidx,
          })),
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

  // Persist a brand-new billable item to the lab's Lists → Billable Items
  // (vendors, vendorType "item") so it shows up there and in future
  // typeaheads. Returns the created item (to select it) or null on failure.
  async function createBillableItem(
    name: string,
    price: number,
  ): Promise<{ name: string; unitPrice: number | null } | null> {
    const trimmed = name.trim();
    if (!trimmed || !invoice.labOrganizationId) return null;
    const unitPrice = price > 0 ? price : null;
    try {
      await apiFetch(`/finance/vendors`, {
        method: "POST",
        body: JSON.stringify({
          organizationId: invoice.labOrganizationId,
          name: trimmed,
          vendorType: "item",
          unitPrice: unitPrice != null ? unitPrice.toFixed(2) : null,
        }),
      });
      // Prefix-invalidate so both this editor's item list and the Lists page
      // (["finance","vendors",orgId,"items"|"all"]) refetch.
      await queryClient.invalidateQueries({
        queryKey: ["finance", "vendors", invoice.labOrganizationId],
      });
      return { name: trimmed, unitPrice };
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not add billable item.",
      );
      return null;
    }
  }

  function addSubItem(parentIdx: number) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === parentIdx
          ? {
              ...it,
              subItems: [
                ...(it.subItems ?? []),
                { item: "", description: "", quantity: 1, unitPrice: 0 },
              ],
            }
          : it,
      ),
    );
  }

  function removeSubItem(parentIdx: number, subIdx: number) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === parentIdx
          ? { ...it, subItems: (it.subItems ?? []).filter((_, si) => si !== subIdx) }
          : it,
      ),
    );
  }

  function updateSubItem(parentIdx: number, subIdx: number, patch: Partial<DraftLine>) {
    setItems((prev) =>
      prev.map((it, i) =>
        i === parentIdx
          ? {
              ...it,
              subItems: (it.subItems ?? []).map((sub, si) =>
                si === subIdx ? { ...sub, ...patch } : sub,
              ),
            }
          : it,
      ),
    );
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

  // Local optimistic flag so the banner + button disappear the instant the
  // user clicks "Mark reviewed" — without waiting for the server round-trip
  // or the invoice query to refetch. The server still records the ack; if it
  // fails we roll back so the banner reappears.
  const [aiReviewedLocal, setAiReviewedLocal] = useState(false);
  const ackAiMutation = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${invoice.id}/ai-review`, {
        method: "PATCH",
        body: JSON.stringify({ acknowledged: true }),
      }),
    onMutate: () => {
      setAiReviewedLocal(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (err: Error) => {
      setAiReviewedLocal(false);
      setError(err.message || "Could not mark reviewed.");
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

  // Whether the form has unsaved edits compared to the loaded invoice. Until
  // the baseline is captured (detail still loading) we treat it as clean.
  const isDirty = useMemo(() => {
    if (baselineRef.current == null) return false;
    return (
      serializeInvoiceForm({
        invoiceNumber,
        statusValue,
        issuedAt,
        dueAt,
        tax,
        discount,
        credits,
        notes,
        patientName,
        billTo,
        teeth,
        shade,
        caseNotes,
        layoutPresetId,
        items,
      }) !== baselineRef.current
    );
  }, [
    invoiceNumber,
    statusValue,
    issuedAt,
    dueAt,
    tax,
    discount,
    credits,
    notes,
    patientName,
    billTo,
    teeth,
    shade,
    caseNotes,
    layoutPresetId,
    items,
  ]);

  // Close the editor. If there are unsaved edits, ask for confirmation first
  // so the user can intentionally discard or keep editing.
  const requestClose = useCallback(() => {
    if (isDirty) {
      setPendingDiscard(() => onClose);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  // While the form has unsaved edits, intercept in-app route navigations (the
  // sidebar links, programmatic redirects, etc.) so the user can confirm before
  // losing work, and warn on a native window close/reload via beforeunload.
  useEffect(() => {
    if (!isDirty) {
      setNavBlocker(null);
      return;
    }
    setNavBlocker((proceed) => {
      setPendingDiscard(() => proceed);
    });
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      setNavBlocker(null);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isDirty]);

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
        // If the discard confirmation is open, Escape cancels that prompt
        // rather than the whole editor, so a stray keystroke can't lose work.
        if (pendingDiscard) {
          setPendingDiscard(null);
        } else {
          requestClose();
        }
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
        toothNumber: it.toothNumber ?? null,
        toothLabel: it.toothLabel ?? null,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: Number(it.quantity || 0) * Number(it.unitPrice || 0),
        subItems: (it.subItems ?? []).map((sub) => ({
          item: sub.item,
          toothNumber: sub.toothNumber ?? null,
          description: sub.description,
          quantity: sub.quantity,
          unitPrice: sub.unitPrice,
          lineTotal: Number(sub.quantity || 0) * Number(sub.unitPrice || 0),
        })),
      })),
      subtotal,
      tax,
      discount,
      credits,
      total,
      balanceDue: detailQuery.data?.balanceDue ?? total,
      notes,
      generatedAt: new Date(),
      logoUrl: logoDataUrl,
      logoPdfSize: (user?.practiceLogoSize as "small" | "medium" | "large" | null) ?? null,
      template: invoiceTemplate,
      extraImageDataUrls,
      caseNumber: linkedCaseNumber ?? undefined,
      qrCodeDataUrl,
    };
  }

  function handleDownloadPdf() {
    downloadInvoicePdf(buildPdfOptions());
  }

  function handlePreviewPdf() {
    const opened = previewInvoicePdf(buildPdfOptions());
    if (!opened) {
      setError(
        "Your browser blocked the preview popup. Allow popups for LabTrax in your browser's address bar, then click Preview again.",
      );
    }
  }

  function handlePrintPdf() {
    printInvoicePdf(buildPdfOptions());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div
        className="relative bg-card border-l border-border h-full overflow-y-auto scrollbar-thin"
        style={{ width: panelWidth, maxWidth: "95vw", minWidth: PANEL_MIN }}
      >
        {/* Drag handle on the left edge */}
        <div
          onMouseDown={onResizeMouseDown}
          className="group absolute left-0 top-0 h-full w-3 cursor-col-resize z-20"
          title="Drag to resize panel width"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-transparent group-hover:bg-primary/50 group-active:bg-primary transition-colors duration-100" />
        </div>
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-start gap-3">
          <div className="shrink-0">
            <div className="text-xs text-muted-foreground">Invoice</div>
            <div className="font-mono text-sm font-semibold">{invoice.invoiceNumber}</div>
          </div>
          <div className="flex flex-1 min-w-0 flex-wrap items-center justify-end gap-2">
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
              onClick={() => setRecordPaymentOpen(true)}
              disabled={detailQuery.isLoading || invoice.status === "paid" || invoice.status === "void"}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <CreditCard size={14} /> Record Payment
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
              onClick={() => {
                if (onGoToCase) {
                  onGoToCase();
                } else if (invoice.caseId) {
                  // Navigate without closing first — while dirty the navigation
                  // blocker surfaces the discard prompt (the editor must stay
                  // mounted to render it); the route change unmounts us anyway.
                  setLocation(`/cases?caseId=${encodeURIComponent(invoice.caseId)}`);
                }
              }}
              disabled={!invoice.caseId}
              title={invoice.caseId ? "Open the linked case" : "This invoice has no linked case"}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <ExternalLink size={14} /> Go to case
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
                  className="absolute right-0 mt-1 z-50 w-64 bg-card border border-border rounded-md shadow-lg py-1 text-sm"
                  onMouseLeave={() => setMoreOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      handlePreviewPdf();
                    }}
                    disabled={detailQuery.isLoading}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Eye size={14} /> Preview PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      handlePrintPdf();
                    }}
                    disabled={detailQuery.isLoading}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Printer size={14} /> Print
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      handleDownloadPdf();
                    }}
                    disabled={detailQuery.isLoading}
                    className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <Download size={14} /> Download PDF
                  </button>
                  {caseIdForPricing && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        setPrescriptionPreviewOpen(true);
                      }}
                      title="Preview the linked case's prescriptions, files & history"
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                    >
                      <Stethoscope size={14} /> Preview prescription
                    </button>
                  )}
                  {rxAttachments.length === 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        void openAttachmentFile(rxAttachments[0]!);
                      }}
                      title={`Preview Rx: ${rxAttachments[0]!.fileName}`}
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                    >
                      <ScrollText size={14} /> Rx
                    </button>
                  )}
                  {rxAttachments.length > 1 && rxAttachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        void openAttachmentFile(att);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-secondary inline-flex items-center gap-2"
                      title={att.fileName}
                    >
                      <ScrollText size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{att.fileName}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
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
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm font-medium hover:bg-secondary"
            aria-label="Close without saving"
            title="Close without saving (Esc)"
          >
            <X size={16} /> Close
          </button>
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

          {invoice.aiGenerated && !invoice.aiReviewedAt && !aiReviewedLocal && (
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
              {issuedAt && (
                <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                  Will be included on the{" "}
                  {new Date(issuedAt).toLocaleString("en-US", {
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  })}{" "}
                  statement, generated at end of month.
                </p>
              )}
            </div>
            {(availablePresets.length > 0 || layoutPresetId != null) && (
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Layout preset
                </label>
                {(() => {
                  const matchedPreset =
                    layoutPresetId != null
                      ? availablePresets.find((p) => p.id === layoutPresetId)
                      : undefined;
                  const presetsFetched =
                    !presetsQuery.isLoading && !presetsQuery.isError;
                  const isDeleted =
                    layoutPresetId != null &&
                    presetsFetched &&
                    matchedPreset == null;
                  const displayValue = isDeleted
                    ? "Deleted preset (using lab default)"
                    : (matchedPreset?.name ?? "Lab default");
                  return (
                    <input
                      type="text"
                      value={displayValue}
                      disabled
                      readOnly
                      className="w-full h-9 px-2.5 rounded-md bg-secondary/40 border border-input text-sm text-muted-foreground cursor-not-allowed"
                    />
                  );
                })()}
              </div>
            )}
          </section>

          {linkedCase && (
            <section>
              <h3 className="text-sm font-semibold mb-3">Rx Summary</h3>
              <div className="rounded-lg border border-border bg-secondary/20 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Patient</div>
                  <div>{`${linkedCase.patientFirstName ?? ""} ${linkedCase.patientLastName ?? ""}`.trim() || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Doctor</div>
                  <div>{linkedCase.doctorName || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Restorative Type</div>
                  <div>{linkedRxSummary.restorativeType ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {linkedRxSummary.materials.length > 1 ? "Materials" : "Material"}
                  </div>
                  <div>{linkedRxSummary.materials.length > 0 ? linkedRxSummary.materials.join(", ") : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {linkedRxSummary.shades.length > 1 ? "Shades" : "Shade"}
                  </div>
                  <div>{linkedRxSummary.shades.length > 0 ? linkedRxSummary.shades.join(", ") : "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {linkedRxSummary.isFullArch ? "Tooth Coverage" : "Tooth Number(s)"}
                  </div>
                  <div>{linkedRxTeethLabel || "—"}</div>
                </div>
                <div className="md:col-span-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Rx Notes</div>
                  <div className="whitespace-pre-wrap">{(linkedCase.caseNotes ?? "").trim() || "—"}</div>
                </div>
              </div>
            </section>
          )}

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
                <DoctorNamePicker
                  value={billTo}
                  onChange={(name) => setBillTo(name)}
                  doctorNames={editorDoctorNames}
                  placeholder="Select doctor…"
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
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={resetAllColWidths}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  title="Reset all column widths to defaults"
                >
                  Reset columns
                </button>
                <button
                  type="button"
                  onClick={addItem}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <Plus size={13} /> Add line
                </button>
              </div>
            </div>
            <div className="border border-border rounded-md overflow-x-auto relative">
              {resizingCol !== null && (
                <div
                  className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
                  style={{
                    left: colWidths.slice(0, resizingCol + 1).reduce((a, b) => a + b, 0) - 1,
                    width: 2,
                  }}
                />
              )}
              <table
                className="text-sm"
                style={{
                  tableLayout: "fixed",
                  width: colTotalWidth + ACTION_COL_WIDTH,
                  userSelect: "none",
                }}
              >
                <colgroup>
                  {colWidths.map((w, i) => (
                    <col key={i} style={{ width: w }} />
                  ))}
                  <col style={{ width: ACTION_COL_WIDTH }} />
                </colgroup>
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {(["Item", "Tooth #", "Description", "Qty", "Unit price", "Total"] as const).map(
                      (label, i) => (
                        <th
                          key={label}
                          className={`font-medium px-3 py-2 relative${
                            i === 0 || i === 2 ? " text-left" : " text-right"
                          }`}
                          style={{ overflow: "hidden" }}
                        >
                          {label}
                          <div
                            onMouseDown={(e) => startResize(i, e)}
                            onDoubleClick={() => resetColumn(i)}
                            className="group/resize"
                            style={{
                              position: "absolute",
                              top: 0,
                              right: 0,
                              width: 6,
                              height: "100%",
                              cursor: "col-resize",
                              userSelect: "none",
                              display: "flex",
                              alignItems: "stretch",
                              justifyContent: "flex-end",
                            }}
                          >
                            <span
                              className={`w-0.5 transition-colors duration-100 ${resizingCol === i ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                              style={{ display: "block", height: "100%" }}
                            />
                          </div>
                        </th>
                      ),
                    )}
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                        No line items. Click "Add line" to add one.
                      </td>
                    </tr>
                  )}
                  {items.map((it, idx) => (
                    <Fragment key={idx}>
                    <tr className="border-t border-border">
                      <td className="px-3 py-1.5 align-top">
                        <ItemCombobox
                          value={it.item}
                          options={itemOptions}
                          onPick={(o) =>
                            updateItem(idx, {
                              item: o.name,
                              description: o.name,
                              ...(o.unitPrice != null
                                ? { unitPrice: o.unitPrice }
                                : {}),
                            })
                          }
                          onText={(t) =>
                            updateItem(
                              idx,
                              t.trim() === ""
                                ? { item: "", description: "", unitPrice: 0 }
                                : { item: t },
                            )
                          }
                          onCreate={(name) =>
                            createBillableItem(name, Number(it.unitPrice) || 0)
                          }
                          placeholder="Item"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        {it.toothLabel ? (
                          <div className="w-full h-8 px-2 flex items-center justify-end rounded bg-secondary/30 border border-input/50 text-sm tabular-nums text-muted-foreground select-none">
                            {it.toothLabel}
                          </div>
                        ) : (
                          <input
                            type="number"
                            min={1}
                            max={32}
                            step={1}
                            value={it.toothNumber ?? ""}
                            onChange={(e) =>
                              updateItem(idx, {
                                toothNumber: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                            placeholder="—"
                            className="w-full h-8 px-2 rounded bg-background border border-input text-sm text-right tabular-nums"
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 align-top">
                        <textarea
                          value={it.description}
                          onChange={(e) =>
                            updateItem(idx, { description: e.target.value })
                          }
                          onInput={(e) => {
                            const el = e.currentTarget;
                            el.style.height = "auto";
                            el.style.height = `${el.scrollHeight}px`;
                          }}
                          ref={(el) => {
                            if (el) {
                              el.style.height = "auto";
                              el.style.height = `${el.scrollHeight}px`;
                            }
                          }}
                          placeholder="Description"
                          rows={2}
                          className="w-full min-h-[3.5rem] px-2 py-1.5 rounded bg-background border border-input text-sm resize-none overflow-hidden"
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
                      <td className="px-2 py-1.5 align-top">
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
                    {(it.subItems ?? []).map((sub, sidx) => (
                      <tr key={`sub-${sidx}`} className="border-t border-border/50 bg-muted/20">
                        <td className="py-1.5 pl-8 pr-3 align-top">
                          <ItemCombobox
                            size="sm"
                            value={sub.item}
                            options={itemOptions}
                            onPick={(o) =>
                              updateSubItem(idx, sidx, {
                                item: o.name,
                                description: o.name,
                                ...(o.unitPrice != null
                                  ? { unitPrice: o.unitPrice }
                                  : {}),
                              })
                            }
                            onText={(t) =>
                              updateSubItem(
                                idx,
                                sidx,
                                t.trim() === ""
                                  ? { item: "", description: "", unitPrice: 0 }
                                  : { item: t },
                              )
                            }
                            onCreate={(name) =>
                              createBillableItem(name, Number(sub.unitPrice) || 0)
                            }
                            placeholder="Sub-item"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            type="number"
                            min={1}
                            max={32}
                            step={1}
                            value={sub.toothNumber ?? ""}
                            onChange={(e) =>
                              updateSubItem(idx, sidx, {
                                toothNumber: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                            placeholder="—"
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs text-right tabular-nums"
                          />
                        </td>
                        <td className="px-3 py-1.5 align-top">
                          <input
                            type="text"
                            value={sub.description}
                            onChange={(e) => updateSubItem(idx, sidx, { description: e.target.value })}
                            placeholder="Description"
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={sub.quantity}
                            onChange={(e) => updateSubItem(idx, sidx, { quantity: Number(e.target.value) || 0 })}
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs text-right tabular-nums"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={sub.unitPrice}
                            onChange={(e) => updateSubItem(idx, sidx, { unitPrice: Number(e.target.value) || 0 })}
                            className="w-full h-7 px-2 rounded bg-background border border-input text-xs text-right tabular-nums"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-xs text-muted-foreground">
                          {formatMoney(Number(sub.quantity || 0) * Number(sub.unitPrice || 0))}
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <button
                            type="button"
                            onClick={() => removeSubItem(idx, sidx)}
                            className="h-6 w-6 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center"
                            aria-label="Remove sub-item"
                          >
                            <Trash2 size={11} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {(it.subItems ?? []).length > 0 && (
                      <tr className="border-t border-border/50 bg-muted/30">
                        <td colSpan={5} className="py-1.5 pr-3 text-right text-xs italic text-muted-foreground">
                          — Subtotal
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-xs font-semibold text-foreground">
                          {formatMoney(
                            Number(it.quantity || 0) * Number(it.unitPrice || 0) +
                            (it.subItems ?? []).reduce(
                              (s, sub) => s + Number(sub.quantity || 0) * Number(sub.unitPrice || 0),
                              0,
                            ),
                          )}
                        </td>
                        <td />
                      </tr>
                    )}
                    <tr className="border-t border-border/30">
                      <td colSpan={7} className="px-3 py-1">
                        <button
                          type="button"
                          onClick={() => addSubItem(idx)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Plus size={10} />
                          Sub-item
                        </button>
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Subtotal
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(subtotal)}
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
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
                    <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
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
                        colSpan={5}
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
                    <td colSpan={5} className="px-3 py-2.5 text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
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
      {prescriptionPreviewOpen && caseIdForPricing && (
        <PrescriptionPreview
          caseId={caseIdForPricing}
          invoiceCaseId={caseIdForPricing}
          onClose={() => setPrescriptionPreviewOpen(false)}
        />
      )}
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
      {pendingDiscard && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Discard changes?</h3>
            <p className="text-sm text-muted-foreground">
              You have unsaved edits to this invoice. If you leave now, your
              changes will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  const proceed = pendingDiscard;
                  setPendingDiscard(null);
                  proceed();
                }}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
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

export function StatementBuilderDialog({
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
  const [confirmClose, setConfirmClose] = useState(false);
  // Defaults captured at mount so the dirty check treats an edited-then-reverted
  // field as clean, mirroring the InvoiceEditor safe-exit behavior.
  const initialPeriodStartRef = useRef(periodStart);
  const initialPeriodEndRef = useRef(periodEnd);

  // Any user-entered selection or recipient counts as unsaved input. A
  // generated statement is already persisted server-side, so it doesn't count.
  const isDirty =
    providerOrgId !== "" ||
    periodStart !== initialPeriodStartRef.current ||
    periodEnd !== initialPeriodEndRef.current ||
    !openOnly ||
    emailTo.trim() !== "" ||
    smsTo.trim() !== "";

  // Close the dialog, prompting to discard first if there is unsaved input so a
  // stray Escape or Close can't silently throw away a half-filled form.
  const requestClose = useCallback(() => {
    if (isDirty) setConfirmClose(true);
    else onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose, requestClose]);

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
            onClick={requestClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded hover:bg-secondary"
            aria-label="Close without saving"
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

      {confirmClose && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Discard changes?</h3>
            <p className="text-sm text-muted-foreground">
              You have unsaved input on this statement. If you close now, your
              changes will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
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

export function CreateInvoiceDialog({
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
  const [confirmClose, setConfirmClose] = useState(false);
  // Issue date defaults to today; capture it so reverting back to the default
  // reads as clean, mirroring the InvoiceEditor safe-exit behavior.
  const initialIssuedAtRef = useRef(issuedAt);

  useEffect(() => {
    if (!labOrgId && labOrgs.length) setLabOrgId(labOrgs[0].id);
  }, [labOrgs, labOrgId]);

  // The lab is auto-selected, so it doesn't count as unsaved input. Any
  // practice, invoice number, changed issue date, or due date does.
  const isDirty =
    providerOrgId !== "" ||
    invoiceNumber.trim() !== "" ||
    issuedAt !== initialIssuedAtRef.current ||
    dueAt !== "";

  // Close the dialog, prompting to discard first if there is unsaved input so a
  // stray Escape or Close can't silently throw away a half-filled form.
  const requestClose = useCallback(() => {
    if (isDirty) setConfirmClose(true);
    else onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose, requestClose]);

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
            onClick={requestClose}
            aria-label="Close without saving"
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
            onClick={requestClose}
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

      {confirmClose && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-base font-semibold">Discard changes?</h3>
            <p className="text-sm text-muted-foreground">
              You have unsaved input on this invoice. If you close now, your
              changes will be lost.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="h-9 px-4 rounded-md bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
                className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
