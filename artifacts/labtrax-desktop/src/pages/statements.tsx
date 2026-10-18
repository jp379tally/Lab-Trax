import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
} from "@workspace/api-client-react";
import { AlertTriangle, CalendarClock, ChevronDown, ChevronUp, Download, Eye, History, Loader2, Mail, MessageSquare, Printer, Receipt, RefreshCw, RotateCcw, Search, Send, Trash2, X } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { refreshInvoiceSalesQueries } from "@/lib/refresh-case-finance";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "@/lib/shift-click-range";
import { useLabOrganizations, useSelectedOrg } from "@/lib/finance";
import type { Invoice, Organization } from "@/lib/types";
import { formatDate, formatDateTime, formatMoney, statusLabel } from "@/lib/format";
import { useBatchedListReset } from "@/hooks/useBatchedListReset";
import { fetchAllPages, type ExportProgress } from "@/lib/fetch-all-pages";
import { toast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/StatusBadge";
import { TriggeredByBadge } from "@/components/TriggeredByBadge";
import { buildInvoicePdf, downloadCsv, printInvoicePdf, safeFilename, type InvoicePdfOptions } from "@/lib/export";
import { useAuth } from "@/lib/auth-context";
import { useInvoiceTemplate } from "@/lib/use-invoice-template";
import { InvoiceEditor } from "@/pages/invoices";
import { ReceivePaymentModal } from "@/components/receive-payment-modal";
import { StatementCutoffCalendar } from "@/components/statement-cutoff-calendar";
import { useCallback, useMemo, useState, useEffect, useRef, Fragment } from "react";

interface StatementSchedule {
  id: string;
  labOrganizationId: string;
  enabled: boolean;
  dayOfMonth: number;
  statementFormat: "per_doctor" | "consolidated";
  emailSubject: string | null;
  emailBody: string | null;
  emailReplyTo: string | null;
  includedOrgIds: string[] | null;
  lastSentForMonth: string | null;
  lastRunAt: string | null;
}

const DEFAULT_STATEMENT_SUBJECT =
  "Statement for {{practiceName}} — {{periodLabel}}";
const DEFAULT_STATEMENT_BODY_PRACTICE =
  "Hello {{practiceName}},\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nThank you,\n{{labName}}";
const DEFAULT_STATEMENT_BODY_DOCTOR =
  "Hello {{doctorName}},\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nThank you,\n{{labName}}";
const DEFAULT_STATEMENT_BODY = DEFAULT_STATEMENT_BODY_PRACTICE;

function defaultStatementPeriodLabel(date = new Date()): string {
  const period = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(date);
  return `Statement for ${period}`;
}

function formatStatementCutoffDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function defaultStatementBody(recipientMode: RecipientMode): string {
  return recipientMode === "doctor"
    ? DEFAULT_STATEMENT_BODY_DOCTOR
    : DEFAULT_STATEMENT_BODY_PRACTICE;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v ?? `{{${key}}}`;
  });
}

interface StatementSendRun {
  id: string;
  labOrganizationId: string;
  practiceOrganizationId: string | null;
  practiceName: string;
  practiceEmail: string | null;
  periodMonth: string;
  status: string;
  errorMessage: string | null;
  invoiceCount: number;
  totalBilled: string;
  openBalance: string;
  triggeredBy: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

const STATEMENT_MAX_ATTEMPTS = 3;

interface PaymentSummaryRow {
  id: string;
  amount: string;
  paidAt: string;
  practiceId: string | null;
  practiceName: string;
  invoiceNumber: string | null;
  doctorIdentity: string | null;
}
interface StatementRow {
  practiceId: string;
  practiceName: string;
  billingEmail: string | null;
  phone: string | null;
  openInvoiceCount: number;
  openInvoiceTotal: number;
  unpaidStatements: Array<{
    id: string;
    date: string;
    periodStart: string;
    periodEnd: string;
    remainingBalance: number;
    overdue: boolean;
    detailProvenance?: "snapshot" | "live" | "mixed";
  }>;
  hasLegacyStatements?: boolean;
  totalOpenBalance: number;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  overdueBalance: number;
  oldestOpen: string | null;
}

type SortKey =
  | "practiceName"
  | "openInvoiceCount"
  | "openInvoiceTotal"
  | "totalOpenBalance"
  | "overdueBalance"
  // Used by the billed-card's bounded server-side drill-down.
  | "totalBilled";

const PAGE_SIZE = 10;
/** Stable identity for an unloaded batch. */
const EMPTY_STATEMENT_ROWS: StatementRow[] = [];
/** A stats-breakdown row: an account summary with its drill-only fields. */
type DrillRow = StatementRow;
const EMPTY_DRILL_ROWS: DrillRow[] = [];

interface StatementTotals {
  billed: number;
  paid: number;
  open: number;
  overdue: number;
}

interface StatementSummaryPage {
  rows: StatementRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor?: string | null;
  totals: StatementTotals;
}

function isInvoicePastDue(inv: Invoice): boolean {
  if (inv.status === "paid" || inv.status === "void") return false;
  const due = inv.dueAt ?? inv.dueDate;
  if (!due) return false;
  const date = new Date(due);
  return !Number.isNaN(date.getTime()) &&
    date.getTime() < Date.now() &&
    Number(inv.balanceDue ?? 0) > 0;
}

export default function StatementsPage() {
  const [, setLocation] = useLocation();
  const organizationsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const [search, setSearch] = useState("");
  const [agingFilter, setAgingFilter] = useState<"all" | "open" | "overdue">("all");
  const [sortKey, setSortKey] = useState<SortKey>("totalOpenBalance");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Batches are anchored on the last account already received (a keyset
  // cursor), so a practice whose balance changes mid-scroll cannot shift the
  // window and hide or repeat an account.
  const [cursor, setCursor] = useState<string | null>(null);
  // Rows accumulate against the identity of the server query (everything but
  // the offset), so a filter change restarts the list while a change that does
  // not alter the server query keeps the batch already loaded.
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: StatementRow[];
    totals: StatementTotals | null;
    total: number;
  }>({ key: "", rows: [], totals: null, total: 0 });
  const [summaryRefresh, setSummaryRefresh] = useState(0);
  const [selected, setSelected] = useState<StatementRow | null>(null);
  const [selectedPractices, setSelectedPractices] = useState<Set<string>>(new Set());
  const [activeCard, setActiveCard] = useState<"billed" | "collected" | "open" | "overdue" | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<{
    kind: "delete_practices" | "reset_practices" | "reset_all";
    practiceCount: number;
    invoiceCount: number;
  } | null>(null);
  const [bulkFeedback, setBulkFeedback] = useState<string | null>(null);
  // Non-null while the summary CSV export is walking its bounded batches.
  // Doubles as the "working" flag for the Export CSV button.
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const exportingSummary = exportProgress !== null;
  const [receivePaymentModal, setReceivePaymentModal] = useState<{
    practiceOrDoctorName: string;
    defaultAmount: number;
    invoiceIds: string[];
    providerOrganizationId: string;
  } | null>(null);
  const [orgId] = useSelectedOrg();
  const queryClient = useQueryClient();

  const { user } = useAuth();
  const isBillingUser =
    user?.role === "owner" ||
    user?.role === "admin" ||
    user?.role === "billing";

  const scheduleQuery = useQuery({
    queryKey: ["statement-schedule", orgId],
    queryFn: () => apiFetch<StatementSchedule>(`/lab-orgs/${orgId}/statement-schedule`),
    enabled: !!orgId,
  });

  const statementRunsQuery = useQuery({
    queryKey: ["statement-runs", orgId],
    queryFn: () => apiFetch<StatementSendRun[]>(`/lab-orgs/${orgId}/statement-runs?limit=200`),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  const accountSummariesQueryString = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("aging", agingFilter);
    params.set("sort", sortKey);
    params.set("sortDir", sortDir);
    params.set("limit", String(PAGE_SIZE));
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }, [search, agingFilter, sortKey, sortDir, cursor]);
  const accountSummariesQueryBase = useMemo(() => {
    const params = new URLSearchParams(accountSummariesQueryString);
    params.delete("cursor");
    return `${orgId}/${summaryRefresh}?${params.toString()}`;
  }, [accountSummariesQueryString, orgId, summaryRefresh]);
  // Restart at the newest matches during render (not in an effect) so the
  // first request after a filter change carries no stale cursor.
  const [pagedSummariesBase, setPagedSummariesBase] = useState(accountSummariesQueryBase);
  if (pagedSummariesBase !== accountSummariesQueryBase) {
    setPagedSummariesBase(accountSummariesQueryBase);
    setCursor(null);
  }
  const restartSummaries = useCallback(() => setCursor(null), []);
  useBatchedListReset("statement-account-summaries", restartSummaries);
  const accountSummariesQuery = useQuery({
    queryKey: [
      "statement-account-summaries",
      orgId,
      accountSummariesQueryString,
      summaryRefresh,
    ],
    queryFn: async ({ signal }) => {
      const query = accountSummariesQueryString;
      const requestCursor = cursor;
      const response = await apiFetch<StatementSummaryPage | StatementRow[]>(
        `/lab-orgs/${orgId}/statements/account-summaries?${query}`,
        { signal },
      );
      const result = Array.isArray(response)
        ? {
            rows: response,
            total: response.length,
            limit: response.length,
            offset: 0,
            hasMore: false,
            nextCursor: null,
            totals: response.reduce(
              (sum, row) => ({
                billed: sum.billed + Number(row.totalBilled ?? 0),
                paid: sum.paid + Number(row.totalPaid ?? 0),
                open: sum.open + Number(row.totalOpenBalance ?? 0),
                overdue: sum.overdue + Number(row.overdueBalance ?? 0),
              }),
              { billed: 0, paid: 0, open: 0, overdue: 0 },
            ),
          }
        : response;
      return { ...result, query, requestCursor };
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (
      !accountSummariesQuery.data ||
      accountSummariesQuery.data.query !== accountSummariesQueryString
    ) return;
    const nextRows = accountSummariesQuery.data.rows.map((summary) => ({
      ...summary,
      openBalance: summary.totalOpenBalance,
      oldestOpen:
        summary.unpaidStatements.find((statement) => statement.overdue)
          ?.periodEnd ?? null,
    }));
    const result = accountSummariesQuery.data;
    setLoaded((previous) => ({
      key: accountSummariesQueryBase,
      rows:
        previous.key === accountSummariesQueryBase && result.requestCursor
          ? [
              ...previous.rows.filter(
                (row) => !nextRows.some((next) => next.practiceId === row.practiceId),
              ),
              ...nextRows,
            ]
          : nextRows,
      totals: result.totals,
      total: result.total,
    }));
  }, [accountSummariesQuery.data, accountSummariesQueryString, accountSummariesQueryBase]);
  const atCurrentBase = loaded.key === accountSummariesQueryBase;
  const loadedRows = atCurrentBase ? loaded.rows : EMPTY_STATEMENT_ROWS;
  const summaryTotals = atCurrentBase ? loaded.totals : null;
  const serverTotal = atCurrentBase ? loaded.total : 0;
  const selectedPracticeId =
    selectedPractices.size === 1 ? [...selectedPractices][0] : null;
  const selectedPracticeInvoicesQuery = useQuery({
    queryKey: [...FINANCE_INVOICES_QUERY_KEY, "statement-practice", selectedPracticeId],
    queryFn: () =>
      apiFetch<Invoice[]>(
        `/invoices?practiceId=${encodeURIComponent(selectedPracticeId!)}`,
      ),
    enabled: !!selectedPracticeId,
    staleTime: 30_000,
  });

  const emailTemplateQuery = useQuery<{
    emailSubject: string | null;
    emailBody: string | null;
    emailHeader: string | null;
    emailReplyTo: string | null;
  }>({
    queryKey: ["admin", "templates", "statement-email"],
    queryFn: () => apiFetch("/admin/templates/statement-email"),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  const practiceCountForOrg = useMemo(() => {
    const orgs = organizationsQuery.data ?? [];
    return orgs.filter((o) => o.parentLabOrganizationId === orgId).length;
  }, [organizationsQuery.data, orgId]);

  const scheduleFilterCount =
    scheduleQuery.data?.includedOrgIds && scheduleQuery.data.includedOrgIds.length > 0
      ? scheduleQuery.data.includedOrgIds.length
      : null;

  const scheduleMissingEmailCount = useMemo(() => {
    const orgs = organizationsQuery.data ?? [];
    const practices = orgs.filter((o) => o.parentLabOrganizationId === orgId);
    const includedIds = scheduleQuery.data?.includedOrgIds;
    const targeted =
      includedIds && includedIds.length > 0
        ? practices.filter((p) => includedIds.includes(p.id))
        : practices;
    return targeted.filter((p) => !p.billingEmail).length;
  }, [organizationsQuery.data, scheduleQuery.data, orgId]);

  const rows = useMemo<StatementRow[]>(() => {
    return loadedRows;
  }, [loadedRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (agingFilter === "open" && r.openBalance <= 0) return false;
        if (agingFilter === "overdue" && r.overdueBalance <= 0) return false;
        if (!q) return true;
        return r.practiceName.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (typeof va === "number" && typeof vb === "number") {
          return sortDir === "asc" ? va - vb : vb - va;
        }
        return sortDir === "asc"
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
  }, [rows, search, agingFilter, sortKey, sortDir]);

  const fallbackTotals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.billed += r.totalBilled;
        acc.paid += r.totalPaid;
        acc.open += r.openBalance;
        acc.overdue += r.overdueBalance;
        return acc;
      },
      { billed: 0, paid: 0, open: 0, overdue: 0 },
    );
  }, [rows]);
  const currentSummaryPage =
    accountSummariesQuery.data?.query === accountSummariesQueryString
      ? accountSummariesQuery.data
      : null;
  // Keep the last full-set metadata while fetching another page. Falling back
  // to loaded-row sums here would briefly present partial totals as complete.
  const totals = summaryTotals ?? fallbackTotals;
  const total = summaryTotals ? serverTotal : rows.length;

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }
  function SortHeader({ k, children, align = "left" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={`inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground ${align === "right" ? "justify-end" : ""}`}
      >
        {children}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  async function exportSummaryCsv() {
    if (exportProgress) return;
    const filterDesc = describeFilters({ search, agingFilter });
    const filename = `statements-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    let exportRows = filtered;
    if (orgId) {
      // CSV remains a full-filter export even though the table is loaded in
      // batches: always walk the filtered set in bounded server pages. Falling
      // back to the rows this page happens to have loaded would quietly write
      // a truncated file whenever more matches exist than are on screen.
      setExportProgress({ loaded: 0, total: null });
      try {
        exportRows = await fetchAllPages<StatementRow>({
          fetchPage: ({ limit, offset }) => {
            const params = new URLSearchParams({
              aging: agingFilter,
              sort: sortKey,
              sortDir,
              limit: String(limit),
              offset: String(offset),
            });
            if (search.trim()) params.set("search", search.trim());
            return apiFetch<StatementSummaryPage | StatementRow[]>(
              `/lab-orgs/${orgId}/statements/account-summaries?${params}`,
            );
          },
          onProgress: setExportProgress,
        });
      } catch (err) {
        // A partial walk must never be written to a file — report it instead.
        setExportProgress(null);
        toast({
          title: "Export failed",
          description:
            err instanceof Error
              ? err.message
              : "The statement summary could not be exported. Please try again.",
          variant: "destructive",
        });
        return;
      }
    }
    const data = exportRows.map((r) => ({
      Practice: r.practiceName,
      Email: r.billingEmail ?? "No email on file.",
      "Open invoices": r.openInvoiceCount,
      "Open invoices total": r.openInvoiceTotal.toFixed(2),
      "Recent statement dates": r.unpaidStatements.map((s) => formatDate(s.date)).join("; "),
      "Recent statement amounts": r.unpaidStatements.map((s) => s.remainingBalance.toFixed(2)).join("; "),
      "Total open balance": r.totalOpenBalance.toFixed(2),
      Overdue: r.overdueBalance.toFixed(2),
      Filters: filterDesc,
    }));
    downloadCsv(filename, data);
    setExportProgress(null);
  }

  const selectedPracticeInvoiceCount = useMemo(() => {
    return rows
      .filter((row) => selectedPractices.has(row.practiceId))
      .reduce((count, row) => count + Number(row.invoiceCount ?? 0), 0);
  }, [rows, selectedPractices]);

  const bulkDeleteMutation = useMutation({
    mutationFn: (payload: { practiceIds?: string[]; all?: boolean }) =>
      apiFetch("/invoices/bulk", {
        method: "DELETE",
        body: JSON.stringify({ labOrganizationId: orgId, ...payload }),
      }),
    onSuccess: () => {
      void refreshInvoiceSalesQueries(queryClient);
      setSelectedPractices(new Set());
      setBulkConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
      });
    },
  });

  const bulkResetMutation = useMutation({
    mutationFn: (payload: { practiceIds?: string[]; all?: boolean }) =>
      apiFetch<{ resetCount: number; legacyResetCount?: number; skippedCount?: number }>("/invoices/bulk-reset", {
        method: "POST",
        body: JSON.stringify({ labOrganizationId: orgId, ...payload }),
      }),
    onSuccess: () => {
      void refreshInvoiceSalesQueries(queryClient);
      setSelectedPractices(new Set());
      setBulkConfirm(null);
      setBulkFeedback(null);
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
      });
    },
    onError: async (err, variables) => {
      // Network-level failure (status 0): the reset may have landed before
      // the connection dropped. Refetch and report the actual state instead
      // of a bare "Failed to fetch".
      if (!(err instanceof ApiError) || err.status !== 0) return;
      try {
        // This page no longer downloads invoices; it verifies against its own
        // account summaries, which are batched — so a practice outside the
        // loaded pages cannot be confirmed either way.
        await queryClient.refetchQueries({
          queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
        });
        const cached = queryClient.getQueriesData<
          (StatementSummaryPage & { query?: string }) | StatementRow[]
        >({ queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId] });
        const summaries = cached.flatMap(([, result]) =>
          Array.isArray(result) ? result : (result?.rows ?? []),
        );
        const wholeSetCached = cached.some(([, result]) =>
          Array.isArray(result) ? true : !!result && result.rows.length >= result.total,
        );
        const cachedPracticeIds = new Set(summaries.map((r) => r.practiceId));
        const unverifiable = variables.all
          ? !wholeSetCached
          : (variables.practiceIds ?? []).some((id) => !cachedPracticeIds.has(id));
        bulkResetMutation.reset();
        if (unverifiable) {
          setBulkFeedback(
            "The connection dropped before the server confirmed the reset. Refresh the page to see whether it went through before trying again.",
          );
          return;
        }
        const targets = variables.all
          ? summaries
          : summaries.filter((r) => variables.practiceIds?.includes(r.practiceId));
        const remaining = targets.filter(
          (r) => Number(r.totalBilled ?? 0) !== 0 || Number(r.totalOpenBalance ?? 0) !== 0,
        );
        if (remaining.length === 0) {
          // The reset landed even though the response was lost.
          setSelectedPractices(new Set());
          setBulkConfirm(null);
          setBulkFeedback(null);
          return;
        }
        setBulkFeedback(
          `The connection dropped before the server confirmed the reset. ${remaining.length} practice${remaining.length !== 1 ? "s" : ""} still show${remaining.length === 1 ? "s" : ""} a balance — please try again.`,
        );
      } catch {
        // Refetch also failed — keep the original network error visible.
      }
    },
  });

  // Shift-click range selection for the practice checkboxes. A normal click
  // toggles the single practice and moves the anchor; a shift-click with a
  // valid anchor adds every practice between the anchor and the clicked row
  // (in the current filtered/sorted order) to the selection. If the anchor
  // is no longer visible, fall back to a normal single toggle.
  const practiceAnchorIdRef = useRef<string | null>(null);
  function handlePracticeCheckboxChange(
    practiceId: string,
    checked: boolean,
    shiftKey: boolean,
  ) {
    if (shiftKey) {
      const rangeIds = computeShiftClickRange(
        filtered.map((r) => r.practiceId),
        practiceAnchorIdRef.current,
        practiceId,
      );
      if (rangeIds) {
        setSelectedPractices((prev) => {
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return next;
        });
        return;
      }
      // Anchor filtered out of the visible list: reset and treat as normal.
      practiceAnchorIdRef.current = null;
    }
    setSelectedPractices((prev) => {
      const next = new Set(prev);
      if (checked) next.add(practiceId);
      else next.delete(practiceId);
      return next;
    });
    practiceAnchorIdRef.current = practiceId;
  }

  function handleBulkConfirm() {
    if (!bulkConfirm) return;
    setBulkFeedback(null);
    if (bulkConfirm.kind === "delete_practices") {
      bulkDeleteMutation.mutate({ practiceIds: Array.from(selectedPractices) });
    } else if (bulkConfirm.kind === "reset_practices") {
      bulkResetMutation.mutate({ practiceIds: Array.from(selectedPractices) });
    } else if (bulkConfirm.kind === "reset_all") {
      bulkResetMutation.mutate({ all: true });
    }
  }

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Statements</h1>
          <p className="text-sm text-muted-foreground mt-1">
            One row per practice with billed, paid, and open balance rolled up.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowGenerate(true)}
            disabled={!orgId || rows.length === 0}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={14} /> Generate Statements
          </button>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            disabled={!orgId}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50 disabled:cursor-not-allowed border border-border"
          >
            <History size={14} /> Send history
          </button>
          <button
            type="button"
            onClick={() => setShowSchedule(true)}
            disabled={!orgId}
            className="inline-flex items-center gap-2 min-h-[44px] px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50 disabled:cursor-not-allowed border border-border"
          >
            <CalendarClock size={14} />
            <span className="flex flex-col items-start leading-tight">
              <span className="flex items-center gap-1">
                Auto-send
                {scheduleMissingEmailCount > 0 && (
                  <AlertTriangle size={12} className="text-warning shrink-0" />
                )}
              </span>
              <span className={`text-[10px] font-normal text-primary leading-none ${scheduleFilterCount !== null ? "" : "invisible"}`}>
                {scheduleFilterCount !== null
                  ? `${scheduleFilterCount} of ${practiceCountForOrg || scheduleFilterCount} practice${scheduleFilterCount === 1 ? "" : "s"}`
                  : "placeholder"}
              </span>
              {scheduleMissingEmailCount > 0 && (
                <span className="text-[10px] font-normal text-warning leading-none">
                  {scheduleMissingEmailCount} missing email
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={exportSummaryCsv}
            disabled={filtered.length === 0 || exportingSummary}
            aria-busy={exportingSummary}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50 disabled:cursor-not-allowed border border-border"
          >
            {exportingSummary ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {exportProgress.total !== null && exportProgress.total > 0
                  ? `Exporting ${exportProgress.loaded} of ${exportProgress.total}…`
                  : "Exporting…"}
              </>
            ) : (
              <>
                <Download size={14} /> Export CSV
              </>
            )}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat
          label="Total billed"
          value={formatMoney(totals.billed)}
          tone="neutral"
          active={activeCard === "billed"}
          onClick={() => setActiveCard(activeCard === "billed" ? null : "billed")}
        />
        <Stat
          label="Collected"
          value={formatMoney(totals.paid)}
          tone="success"
          active={activeCard === "collected"}
          onClick={() => setActiveCard(activeCard === "collected" ? null : "collected")}
        />
        <Stat
          label="Open balance"
          value={formatMoney(totals.open)}
          tone="primary"
          active={activeCard === "open"}
          onClick={() => setActiveCard(activeCard === "open" ? null : "open")}
        />
        <Stat
          label="Overdue"
          value={formatMoney(totals.overdue)}
          tone={totals.overdue > 0 ? "warning" : "neutral"}
          active={activeCard === "overdue"}
          onClick={() => setActiveCard(activeCard === "overdue" ? null : "overdue")}
        />
      </div>

      {activeCard && orgId && (
        <StatsDrillPanel
          activeCard={activeCard}
          orgId={orgId}
          statementRuns={statementRunsQuery.data ?? []}
          onClose={() => setActiveCard(null)}
        />
      )}

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search practice…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <select
            value={agingFilter}
            onChange={(e) => setAgingFilter(e.target.value as "all" | "open" | "overdue")}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All practices</option>
            <option value="open">With open balance</option>
            <option value="overdue">Overdue only</option>
          </select>
        </div>

        {isBillingUser && selectedPractices.size > 0 && orgId && (
          <div className="flex items-center gap-3 px-5 py-2 bg-primary/5 border border-primary/20 rounded-md mb-2 text-sm">
            <span className="font-medium text-primary">
              {selectedPractices.size} practice{selectedPractices.size !== 1 ? "s" : ""} selected
              {selectedPracticeInvoiceCount > 0 && ` (${selectedPracticeInvoiceCount} invoice${selectedPracticeInvoiceCount !== 1 ? "s" : ""})`}
            </span>
            <button
              type="button"
              onClick={async () => {
                if (selectedPractices.size !== 1) return;
                const practiceId = [...selectedPractices][0];
                const row = rows.find((r) => r.practiceId === practiceId);
                if (!row) return;
                // ReceivePaymentModal allocates against the invoices cache.
                // Populate only this selected practice on demand now that the
                // Statements page no longer downloads the global invoice list.
                // Keep an active query observer while the modal is open. Test
                // and production QueryClients may garbage-collect unobserved
                // fetchQuery results before payment allocation reads them.
                const practiceInvoices =
                  (await selectedPracticeInvoicesQuery.refetch()).data ?? [];
                setReceivePaymentModal({
                  practiceOrDoctorName: row.practiceName,
                  defaultAmount: row.openBalance,
                  invoiceIds: practiceInvoices
                    .filter((invoice) => invoice.providerOrganizationId === practiceId)
                    .map((invoice) => invoice.id),
                  providerOrganizationId: practiceId,
                });
              }}
              disabled={selectedPractices.size !== 1}
              title={selectedPractices.size !== 1 ? "Select one practice at a time" : undefined}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 text-xs font-medium hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Receipt size={12} /> Receive Payment
            </button>
            <button
              type="button"
              onClick={() => setBulkConfirm({ kind: "delete_practices", practiceCount: selectedPractices.size, invoiceCount: selectedPracticeInvoiceCount })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-destructive/10 text-destructive border border-destructive/20 text-xs font-medium hover:bg-destructive/20"
            >
              <Trash2 size={12} /> Delete invoices for selected
            </button>
            <button
              type="button"
              onClick={() => setBulkConfirm({ kind: "reset_practices", practiceCount: selectedPractices.size, invoiceCount: selectedPracticeInvoiceCount })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-warning/10 text-warning border border-warning/20 text-xs font-medium hover:bg-warning/20"
            >
              <RotateCcw size={12} /> Reset to $0
            </button>
            <button
              type="button"
              onClick={() => setBulkConfirm({ kind: "reset_all", practiceCount: total, invoiceCount: 0 })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-warning/10 text-warning border border-warning/20 text-xs font-medium hover:bg-warning/20"
            >
              <RotateCcw size={12} /> Reset all to $0
            </button>
            <button
              type="button"
              onClick={() => setSelectedPractices(new Set())}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                {isBillingUser && (
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={filtered.length > 0 && filtered.every((r) => selectedPractices.has(r.practiceId))}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedPractices.size > 0 && !filtered.every((r) => selectedPractices.has(r.practiceId));
                      }}
                      onChange={(e) => {
                        setSelectedPractices(e.target.checked ? new Set(filtered.map((r) => r.practiceId)) : new Set());
                      }}
                      title="Select all practices"
                    />
                  </th>
                )}
                <th className="text-left px-5 py-2.5"><SortHeader k="practiceName">Practice</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="openInvoiceCount" align="right">Open Invoices</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="openInvoiceTotal" align="right">Open Invoices Total</SortHeader></th>
                <th className="text-right py-2.5">Recent Statement Date</th>
                <th className="text-right py-2.5">Recent Statement Amount</th>
                <th className="text-right py-2.5"><SortHeader k="totalOpenBalance" align="right">Total Open Balance</SortHeader></th>
                <th className="text-right px-5 py-2.5"><SortHeader k="overdueBalance" align="right">Overdue</SortHeader></th>
              </tr>
            </thead>
            <tbody>
              {accountSummariesQuery.isLoading && (
                <tr>
                  <td colSpan={isBillingUser ? 8 : 7} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading statements…
                  </td>
                </tr>
              )}
              {accountSummariesQuery.error && (
                <tr>
                  <td colSpan={isBillingUser ? 8 : 7} className="px-5 py-12 text-center text-destructive">{(accountSummariesQuery.error as Error).message}</td>
                </tr>
              )}
              {!accountSummariesQuery.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={isBillingUser ? 8 : 7} className="px-5 py-12 text-center text-muted-foreground">
                    No statements match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.practiceId}
                  onClick={() => setSelected(r)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/40"
                >
                  {isBillingUser && (
                    <td
                      className="px-3 py-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={selectedPractices.has(r.practiceId)}
                        aria-label={`Select practice ${r.practiceName}`}
                        onMouseDown={suppressShiftClickTextSelection}
                        onChange={(e) => {
                          handlePracticeCheckboxChange(
                            r.practiceId,
                            e.target.checked,
                            shiftKeyFromChangeEvent(e),
                          );
                        }}
                      />
                    </td>
                  )}
                  <td className="px-5 py-3">
                     <div className="font-medium text-sm">{r.practiceName}</div>
                     {r.hasLegacyStatements && <div role="status" className="mt-1 text-[11px] text-amber-700">Some older statement details are reconstructed from current invoices and may differ from the original.</div>}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                      {r.billingEmail ? (
                        <span className="text-[11px] text-muted-foreground truncate max-w-[200px]">{r.billingEmail}</span>
                      ) : (
                        <span className="text-[11px] text-warning">No email on file.</span>
                      )}
                      {r.phone ? (
                        <span className="text-[11px] text-muted-foreground">{r.phone}</span>
                      ) : (
                        <span className="text-[10px] px-1 py-0 rounded bg-secondary text-muted-foreground border border-border font-medium leading-4">no phone</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 text-right tabular-nums">{r.openInvoiceCount}</td>
                  <td className="py-3 text-right tabular-nums">{formatMoney(r.openInvoiceTotal)}</td>
                  <td className="py-3 text-right align-top">
                    {r.unpaidStatements.length ? r.unpaidStatements.map((s) => (
                       <div key={s.id} className="h-5 whitespace-nowrap">{formatDate(s.date)} {(s.detailProvenance === "live" || s.detailProvenance === "mixed") && <span className="text-[10px] text-amber-700" title="Some invoice details are reconstructed from current invoice data">· {s.detailProvenance === "mixed" ? "mixed details" : "reconstructed"}</span>}</div>
                    )) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-3 text-right tabular-nums align-top">
                    {r.unpaidStatements.length ? r.unpaidStatements.map((s) => (
                      <div key={s.id} className="h-5 whitespace-nowrap">{formatMoney(s.remainingBalance)}</div>
                    )) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-3 text-right tabular-nums font-medium">{formatMoney(r.totalOpenBalance)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {r.overdueBalance > 0 ? (
                      <span className="text-destructive font-medium">{formatMoney(r.overdueBalance)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span
            className="text-xs text-muted-foreground"
            data-testid="statements-loaded-count"
          >
            Showing {filtered.length} of {total}
          </span>
          {currentSummaryPage?.hasMore && (
            <button
              type="button"
              data-testid="statements-load-more"
              onClick={() => setCursor(currentSummaryPage?.nextCursor ?? null)}
              disabled={accountSummariesQuery.isFetching}
              className="h-8 px-3 rounded-md bg-secondary text-xs font-medium hover:bg-secondary/70 disabled:opacity-50"
            >
              {accountSummariesQuery.isFetching
                ? "Loading…"
                : `Load more (${loadedRows.length} of ${total})`}
            </button>
          )}
        </div>
      </div>

      {selected && (
        <StatementDrawer
          row={selected}
          practice={organizationsQuery.data?.find((o) => o.id === selected.practiceId) ?? null}
          filtersDescription={describeFilters({ search, agingFilter })}
          onClose={() => setSelected(null)}
        />
      )}

      {receivePaymentModal && orgId && (
        <ReceivePaymentModal
          open={true}
          onClose={() => {
            setReceivePaymentModal(null);
            setSummaryRefresh((current) => current + 1);
          }}
          practiceOrDoctorName={receivePaymentModal.practiceOrDoctorName}
          defaultAmount={receivePaymentModal.defaultAmount}
          invoiceIds={receivePaymentModal.invoiceIds}
          providerOrganizationId={receivePaymentModal.providerOrganizationId}
          labOrganizationId={orgId}
          doctorName={null}
        />
      )}
      {showSchedule && orgId && (
        <ScheduleModal orgId={orgId} onClose={() => setShowSchedule(false)} />
      )}
      {showHistory && orgId && (
        <HistoryModal orgId={orgId} onClose={() => setShowHistory(false)} />
      )}
      {showGenerate && orgId && (
        <GenerateStatementsModal
          orgId={orgId}
          initialPracticeIds={Array.from(selectedPractices)}
          initialSelectedKeys={selectedPractices}
          messageDefaults={(() => {
            // Schedule template takes priority for subject/body; the saved lab
            // default supplies header/reply-to and fills any gaps.
            const tmpl = emailTemplateQuery.data;
            return {
              subject:
                scheduleQuery.data?.emailSubject ?? tmpl?.emailSubject ?? null,
              body: scheduleQuery.data?.emailBody ?? tmpl?.emailBody ?? null,
              header: tmpl?.emailHeader ?? null,
              replyTo:
                scheduleQuery.data?.emailReplyTo ?? tmpl?.emailReplyTo ?? null,
            };
          })()}
          onClose={() => setShowGenerate(false)}
        />
      )}
      {bulkConfirm && orgId && (
        <BulkStatementConfirmModal
          kind={bulkConfirm.kind}
          practiceCount={bulkConfirm.practiceCount}
          invoiceCount={bulkConfirm.invoiceCount}
          pending={bulkDeleteMutation.isPending || bulkResetMutation.isPending}
          error={
            bulkFeedback ??
            (bulkDeleteMutation.error instanceof Error ? bulkDeleteMutation.error.message : null) ??
            (bulkResetMutation.error instanceof Error ? bulkResetMutation.error.message : null)
          }
          onCancel={() => {
            setBulkConfirm(null);
            setBulkFeedback(null);
          }}
          onConfirm={handleBulkConfirm}
        />
      )}
    </div>
  );
}

function BulkStatementConfirmModal({
  kind,
  practiceCount,
  invoiceCount,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  kind: "delete_practices" | "reset_practices" | "reset_all";
  practiceCount: number;
  invoiceCount: number;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDelete = kind === "delete_practices";
  const isResetAll = kind === "reset_all";
  const invoiceLabel = invoiceCount > 0 ? ` (${invoiceCount} invoice${invoiceCount !== 1 ? "s" : ""})` : "";
  const title = isDelete
    ? `Delete invoices for ${practiceCount} practice${practiceCount !== 1 ? "s" : ""}?`
    : isResetAll
    ? "Reset all invoices to $0?"
    : `Reset invoices for ${practiceCount} practice${practiceCount !== 1 ? "s" : ""} to $0?`;
  const description = isDelete
    ? `This will permanently void and hide all invoices for the ${practiceCount} selected practice${practiceCount !== 1 ? "s" : ""}${invoiceLabel}. They will no longer appear in the invoices list or statement rollups. This cannot be undone.`
    : isResetAll
    ? `This will zero out all invoice totals and line items across every practice. Invoices will show $0.00 total and $0.00 balance due and their status will be reset to draft. This cannot be undone.`
    : `This will zero out the totals and line items for all invoices belonging to the ${practiceCount} selected practice${practiceCount !== 1 ? "s" : ""}${invoiceLabel}. Each will show $0.00 total and $0.00 balance due. This cannot be undone.`;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
        )}
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
            onClick={onConfirm}
            disabled={pending}
            className={`h-9 px-3 rounded-md text-sm font-medium text-white disabled:opacity-50 ${isDelete ? "bg-destructive hover:bg-destructive/90" : "bg-warning hover:bg-warning/90"}`}
          >
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isDelete ? (
              "Delete invoices"
            ) : (
              "Reset to $0"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScheduleModal({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const orgs = useLabOrganizations();
  const orgName = orgs.data?.find((o) => o.id === orgId)?.displayName
    || orgs.data?.find((o) => o.id === orgId)?.name
    || "this lab";

  const scheduleQuery = useQuery({
    queryKey: ["statement-schedule", orgId],
    queryFn: () => apiFetch<StatementSchedule>(`/lab-orgs/${orgId}/statement-schedule`),
  });

  const practicesQuery = useQuery({
    queryKey: ["organizations", orgId, "practices"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
    // Only show provider orgs that belong to this specific lab.
    select: (orgs) =>
      [...orgs]
        .filter((o) => o.parentLabOrganizationId === orgId)
        .sort((a, b) =>
          (a.displayName || a.name).localeCompare(b.displayName || b.name)
        ),
  });

  const [enabled, setEnabled] = useState(false);
  const [dayOfMonth, setDayOfMonth] = useState(0);
  const [statementFormat, setStatementFormat] = useState<
    "per_doctor" | "consolidated"
  >("per_doctor");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailReplyTo, setEmailReplyTo] = useState("");
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<string>>(new Set());
  const [allSelected, setAllSelected] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    if (scheduleQuery.data) {
      setEnabled(scheduleQuery.data.enabled);
      setDayOfMonth(scheduleQuery.data.dayOfMonth);
      setStatementFormat(
        scheduleQuery.data.statementFormat === "consolidated"
          ? "consolidated"
          : "per_doctor",
      );
      setEmailSubject(scheduleQuery.data.emailSubject ?? "");
      setEmailBody(scheduleQuery.data.emailBody ?? "");
      setEmailReplyTo(scheduleQuery.data.emailReplyTo ?? "");
      const ids = scheduleQuery.data.includedOrgIds;
      if (ids && ids.length > 0) {
        setSelectedOrgIds(new Set(ids));
        setAllSelected(false);
      } else {
        setSelectedOrgIds(new Set());
        setAllSelected(true);
      }
    }
  }, [scheduleQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: {
      enabled: boolean;
      dayOfMonth: number;
      statementFormat: "per_doctor" | "consolidated";
      emailSubject: string | null;
      emailBody: string | null;
      emailReplyTo: string | null;
      includedOrgIds: string[] | null;
    }) =>
      apiFetch<StatementSchedule>(`/lab-orgs/${orgId}/statement-schedule`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["statement-schedule", orgId] });
    },
  });

  const runNowMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ periodMonth: string; results: Array<{ status: string }> }>(
        `/lab-orgs/${orgId}/statement-schedule/run-now`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: (data) => {
      setRunError(null);
      const sent = data.results.filter((r) => r.status === "sent").length;
      const failed = data.results.filter((r) => r.status === "failed").length;
      const skipped = data.results.filter((r) => r.status === "skipped_no_email").length;
      setRunResult(
        `Sent ${sent} statement${sent === 1 ? "" : "s"} for ${data.periodMonth}` +
          (failed ? `, ${failed} failed` : "") +
          (skipped ? `, ${skipped} skipped (no email on file)` : "") +
          ".",
      );
      qc.invalidateQueries({ queryKey: ["statement-runs", orgId] });
      qc.invalidateQueries({ queryKey: ["statement-schedule", orgId] });
      qc.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
      });
    },
    onError: (err: unknown) => {
      setRunResult(null);
      setRunError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  function save() {
    const practices = practicesQuery.data ?? [];
    // Send null (= "all practices" mode) when either:
    // a) the "Select all" toggle is active, OR
    // b) the user has manually checked every practice in the list
    const allPracticesChecked =
      allSelected ||
      selectedOrgIds.size === 0 ||
      (practices.length > 0 && selectedOrgIds.size >= practices.length);
    const includedOrgIds = allPracticesChecked ? null : Array.from(selectedOrgIds);
    saveMutation.mutate({
      enabled,
      dayOfMonth,
      statementFormat,
      emailSubject: emailSubject.trim() || null,
      emailBody: emailBody.trim() ? emailBody : null,
      emailReplyTo: emailReplyTo.trim() || null,
      includedOrgIds,
    });
  }

  function togglePractice(id: string) {
    const allPractices = practicesQuery.data ?? [];
    setSelectedOrgIds((prev) => {
      // When transitioning from "all selected", initialize the full set first,
      // then toggle the clicked row — so unchecking one practice leaves all
      // others checked rather than making the clicked one the only selection.
      const base = allSelected
        ? new Set(allPractices.map((p) => p.id))
        : new Set(prev);
      if (base.has(id)) base.delete(id);
      else base.add(id);
      return base;
    });
    setAllSelected(false);
  }

  function selectAll() {
    setSelectedOrgIds(new Set());
    setAllSelected(true);
  }

  function deselectAll() {
    setSelectedOrgIds(new Set());
    setAllSelected(false);
  }

  const sched = scheduleQuery.data;
  const previewVars = useMemo<Record<string, string>>(
    () => ({
      practiceName: "Sample Family Dental",
      labName: orgName,
      periodLabel: (() => { const _d = new Date(Date.now() - 30 * 86400_000); return `${String(_d.getMonth() + 1).padStart(2, "0")}/${_d.getFullYear()}`; })(),
      totalBilled: formatMoney(2480),
      openBalance: formatMoney(640),
    }),
    [orgName],
  );
  const previewSubject = renderTemplate(
    emailSubject.trim() || DEFAULT_STATEMENT_SUBJECT,
    previewVars,
  );
  const previewBody = renderTemplate(
    emailBody.trim() || DEFAULT_STATEMENT_BODY,
    previewVars,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/40" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Auto-send statements</div>
            <div className="text-sm font-semibold">{orgName}</div>
            {(() => {
              const ids = sched?.includedOrgIds;
              if (!ids || ids.length === 0) return null;
              const total = practicesQuery.data?.length ?? 0;
              return (
                <div className="text-xs text-primary mt-0.5">
                  Sending to {ids.length} of {total || ids.length} practice{ids.length === 1 ? "" : "s"}
                </div>
              );
            })()}
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-5 space-y-4 overflow-y-auto">
          {scheduleQuery.isLoading && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <Loader2 size={16} className="inline animate-spin mr-2" /> Loading schedule…
            </div>
          )}
          {scheduleQuery.error && (
            <div className="text-sm text-destructive">{(scheduleQuery.error as Error).message}</div>
          )}
          {sched && (
            <>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span>
                  <span className="block text-sm font-medium">Email statements automatically each month</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    On the chosen day, selected practices with activity in the prior month will be emailed their statement PDF. Use the "Send to" list below to choose which practices receive statements.
                  </span>
                </span>
              </label>

              <div>
                <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Send on day of month
                </label>
                <select
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10))}
                  disabled={!enabled}
                  className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none disabled:opacity-50"
                >
                  <option value={0}>Last day of month</option>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                {dayOfMonth >= 29 && (
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    In months that don't have day {dayOfMonth}, statements are sent on the last day of that month instead.
                  </p>
                )}
              </div>

              <fieldset>
                <legend className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
                  Statement PDF format
                </legend>
                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="radio"
                      name="monthly-statement-format"
                      value="per_doctor"
                      checked={statementFormat === "per_doctor"}
                      onChange={() => setStatementFormat("per_doctor")}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        One PDF per doctor
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        Send one email per practice with a separate PDF for each doctor.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="radio"
                      name="monthly-statement-format"
                      value="consolidated"
                      checked={statementFormat === "consolidated"}
                      onChange={() => setStatementFormat("consolidated")}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        One consolidated PDF per practice
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        Keep all doctors together in a single statement PDF.
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>

              {enabled && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Send to
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={selectAll}
                        className="text-xs text-primary hover:underline disabled:opacity-50"
                      >
                        Select all
                      </button>
                      <span className="text-muted-foreground text-xs">/</span>
                      <button
                        type="button"
                        onClick={deselectAll}
                        className="text-xs text-primary hover:underline"
                        title="Clears explicit selections — reverts to sending to all practices with activity"
                      >
                        Clear selection (send to all)
                      </button>
                    </div>
                  </div>
                  {practicesQuery.isLoading && (
                    <div className="text-xs text-muted-foreground py-2">
                      <Loader2 size={12} className="inline animate-spin mr-1" /> Loading practices…
                    </div>
                  )}
                  {!practicesQuery.isLoading && (practicesQuery.data ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">No practices found. When auto-send runs, all practices with activity will receive a statement.</p>
                  )}
                  {(practicesQuery.data ?? []).length > 0 && (
                    <>
                      <div className="max-h-44 overflow-y-auto rounded-md border border-border bg-secondary/20 divide-y divide-border">
                        {(practicesQuery.data ?? []).map((p) => {
                          const checked = allSelected || selectedOrgIds.has(p.id);
                          return (
                            <label key={p.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-secondary/60 select-none">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => togglePractice(p.id)}
                                className="h-4 w-4 accent-primary shrink-0"
                              />
                              <span className="text-sm flex-1 min-w-0 truncate">
                                {p.displayName || p.name}
                              </span>
                              {!p.billingEmail && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/20 text-warning font-medium shrink-0">
                                  no email on file
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        {allSelected || selectedOrgIds.size === 0
                          ? "All practices with activity will receive a statement."
                          : `${selectedOrgIds.size} practice${selectedOrgIds.size === 1 ? "" : "s"} selected. Practices without activity are always skipped.`}
                      </p>
                    </>
                  )}
                </div>
              )}

              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-medium">Email template</div>
                    <div className="text-xs text-muted-foreground">
                      Used by auto-send and "Send last month now". Leave fields blank to use the defaults.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowPreview((v) => !v)}
                    className="text-xs text-primary hover:underline"
                  >
                    {showPreview ? "Hide preview" : "Show preview"}
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                      Subject
                    </label>
                    <input
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      placeholder={DEFAULT_STATEMENT_SUBJECT}
                      className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                      Message body
                    </label>
                    <textarea
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                      rows={7}
                      placeholder={DEFAULT_STATEMENT_BODY}
                      className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y font-mono"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1.5">
                      Available placeholders:{" "}
                      <code>{"{{practiceName}}"}</code>, <code>{"{{labName}}"}</code>,{" "}
                      <code>{"{{periodLabel}}"}</code>, <code>{"{{totalBilled}}"}</code>,{" "}
                      <code>{"{{openBalance}}"}</code>.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                      Reply-to address (optional)
                    </label>
                    <input
                      type="email"
                      value={emailReplyTo}
                      onChange={(e) => setEmailReplyTo(e.target.value)}
                      placeholder="billing@yourlab.com"
                      className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1.5">
                      When set, replies from practices go to this address instead of the default sender.
                    </p>
                  </div>

                  {showPreview && (
                    <div className="rounded-md border border-border bg-secondary/30 p-3">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
                        Preview (sample data)
                      </div>
                      <div className="text-xs">
                        <div className="mb-2">
                          <span className="text-muted-foreground">Subject: </span>
                          <span className="font-medium">{previewSubject}</span>
                        </div>
                        {emailReplyTo.trim() && (
                          <div className="mb-2">
                            <span className="text-muted-foreground">Reply-to: </span>
                            <span>{emailReplyTo.trim()}</span>
                          </div>
                        )}
                        <div className="whitespace-pre-wrap border-t border-border pt-2 text-foreground">
                          {previewBody}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {sched.lastSentForMonth && (
                <div className="text-xs text-muted-foreground border border-border rounded-md p-2.5 bg-secondary/30">
                  Last automatic run sent statements for <strong>{sched.lastSentForMonth}</strong>
                  {sched.lastRunAt ? ` on ${formatDateTime(sched.lastRunAt)}` : ""}.
                </div>
              )}

              {runResult && (
                <div className="text-xs text-success border border-success/30 bg-success/10 rounded-md p-2.5">{runResult}</div>
              )}
              {runError && (
                <div className="text-xs text-destructive border border-destructive/30 bg-destructive/10 rounded-md p-2.5">{runError}</div>
              )}
              {saveMutation.error && (
                <div className="text-xs text-destructive">{(saveMutation.error as Error).message}</div>
              )}
            </>
          )}
        </div>
        <footer className="flex items-center justify-between px-5 py-3 border-t border-border bg-secondary/30 rounded-b-xl shrink-0">
          <button
            type="button"
            onClick={() => {
              setRunResult(null);
              setRunError(null);
              runNowMutation.mutate();
            }}
            disabled={runNowMutation.isPending || !sched}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            {runNowMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Send last month now
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saveMutation.isPending || !sched}
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function HistoryModal({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const runsQuery = useQuery({
    queryKey: ["statement-runs", orgId],
    queryFn: () => apiFetch<StatementSendRun[]>(`/lab-orgs/${orgId}/statement-runs?limit=200`),
  });
  const rows = runsQuery.data ?? [];
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());

  // Queue of per-practice payment modals to show in sequence.
  const [paymentQueue, setPaymentQueue] = useState<
    Array<{ practiceName: string; providerOrganizationId: string; defaultAmount: number; doctorName?: string | null }>
  >([]);

  const retryMutation = useMutation({
    mutationFn: (runId: string) =>
      apiFetch<{ status: string; errorMessage?: string }>(
        `/lab-orgs/${orgId}/statement-runs/${runId}/retry`,
        { method: "POST" },
      ),
    onMutate: (runId: string) => {
      setRetryingId(runId);
      setRetryError(null);
    },
    onSettled: () => {
      setRetryingId(null);
      qc.invalidateQueries({ queryKey: ["statement-runs", orgId] });
      qc.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
      });
      qc.invalidateQueries({ queryKey: ["statement-schedule", orgId] });
    },
    onError: (err: unknown) => {
      setRetryError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  // Derived selection state for the header checkbox.
  const allChecked = rows.length > 0 && rows.every((r) => selectedRunIds.has(r.id));
  const someChecked = selectedRunIds.size > 0 && !allChecked;

  // Running total of open balances across selected rows.
  const selectedOpenTotal = useMemo(() => {
    return rows
      .filter((r) => selectedRunIds.has(r.id))
      .reduce((s, r) => s + Number(r.openBalance || 0), 0);
  }, [rows, selectedRunIds]);

  function handleSelectAll(checked: boolean) {
    setSelectedRunIds(checked ? new Set(rows.map((r) => r.id)) : new Set());
  }

  function handleReceivePayment() {
    const selectedRuns = rows.filter((r) => selectedRunIds.has(r.id));
    // Group by providerOrganizationId, preserving insertion order (first seen).
    const practiceMap = new Map<string, { practiceName: string; totalBilled: number }>();
    for (const run of selectedRuns) {
      const provId = run.practiceOrganizationId ?? "";
      if (!provId) continue;
      const existing = practiceMap.get(provId);
      if (existing) {
        existing.totalBilled += Number(run.totalBilled || 0);
      } else {
        practiceMap.set(provId, {
          practiceName: run.practiceName,
          totalBilled: Number(run.totalBilled || 0),
        });
      }
    }
    const queue = Array.from(practiceMap.entries()).map(([provId, { practiceName, totalBilled }]) => ({
      practiceName,
      providerOrganizationId: provId,
      defaultAmount: totalBilled,
    }));
    if (queue.length > 0) setPaymentQueue(queue);
  }

  function handlePaymentModalClose() {
    setPaymentQueue((prev) => {
      const next = prev.slice(1);
      // Clear selection once the whole queue is processed.
      if (next.length === 0) setSelectedRunIds(new Set());
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-foreground/30" />
      <aside className="w-full max-w-[720px] bg-card border-l border-border h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Statement send history</div>
            <div className="text-sm font-semibold">Most recent 200 entries</div>
          </div>
          <div className="flex items-center gap-2">
            {selectedRunIds.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Open {formatMoney(selectedOpenTotal)} selected
                </span>
                <button
                  type="button"
                  onClick={handleReceivePayment}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20"
                >
                  <Receipt size={12} /> Receive Payment ({selectedRunIds.size})
                </button>
              </>
            )}
            <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {runsQuery.isLoading && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
            </div>
          )}
          {runsQuery.error && (
            <div className="px-6 py-6 text-sm text-destructive">{(runsQuery.error as Error).message}</div>
          )}
          {!runsQuery.isLoading && rows.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No statement send attempts yet. Enable auto-send or use "Send last month now" to record a run.
            </div>
          )}
          {retryError && (
            <div className="px-6 py-2 text-xs text-destructive border-b border-border bg-destructive/5">
              {retryError}
            </div>
          )}
          <table className="w-full text-sm">
            {rows.length > 0 && (
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr>
                  <th className="pl-4 pr-2 py-2.5 w-8 text-left">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = someChecked;
                      }}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      aria-label="Select all rows"
                      className="h-3.5 w-3.5 cursor-pointer"
                    />
                  </th>
                  <th colSpan={3} />
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((r) => {
                const attempts = r.attemptCount ?? 1;
                const canRetry = r.status === "failed";
                const autoRetryPending =
                  r.status === "failed" &&
                  attempts < STATEMENT_MAX_ATTEMPTS &&
                  r.nextAttemptAt;
                return (
                  <tr key={r.id} className="border-b border-border">
                    <td className="pl-4 pr-2 py-3 align-top w-8">
                      <input
                        type="checkbox"
                        checked={selectedRunIds.has(r.id)}
                        onChange={(e) => {
                          setSelectedRunIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            return next;
                          });
                        }}
                        aria-label={`Select ${r.practiceName} ${r.periodMonth}`}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium">{r.practiceName}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
                        {r.periodMonth} · {r.invoiceCount} invoice{r.invoiceCount === 1 ? "" : "s"} · <TriggeredByBadge triggeredBy={r.triggeredBy} /> · <DeliveryStatusBadge status={r.status} />
                      </div>
                      {r.practiceEmail && (
                        <div className="text-xs text-muted-foreground">{r.practiceEmail}</div>
                      )}
                      {attempts > 1 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Attempt {attempts} of {STATEMENT_MAX_ATTEMPTS}
                        </div>
                      )}
                      {r.errorMessage && (
                        <div className="text-xs text-destructive mt-1">{r.errorMessage}</div>
                      )}
                      {autoRetryPending && (
                        <div className="text-[11px] text-muted-foreground mt-1">
                          Auto-retry scheduled for {formatDateTime(r.nextAttemptAt as string)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                      Billed {formatMoney(r.totalBilled)}<br />
                      Open {formatMoney(r.openBalance)}
                      <div>
                        <button
                          type="button"
                          disabled={Number(r.openBalance) <= 0}
                          onClick={() => setPaymentQueue([{
                            practiceName: r.practiceName,
                            defaultAmount: Number(r.openBalance),
                            providerOrganizationId: r.practiceOrganizationId ?? "",
                          }])}
                          className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-medium border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 mt-1 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Receipt size={10} /> Receive Payment
                        </button>
                      </div>
                    </td>
                    <td className="px-6 py-3 align-top text-right whitespace-nowrap">
                      <RunStatusBadge status={r.status} />
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {formatDateTime(r.createdAt)}
                      </div>
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => retryMutation.mutate(r.id)}
                          disabled={retryingId === r.id}
                          className="mt-2 inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium border border-border hover:bg-secondary disabled:opacity-50"
                        >
                          {retryingId === r.id ? (
                            <>
                              <Loader2 size={11} className="animate-spin" /> Retrying…
                            </>
                          ) : (
                            <>
                              <Send size={11} /> Retry now
                            </>
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </aside>
      {paymentQueue.length > 0 && (
        <ReceivePaymentModal
          open={true}
          onClose={handlePaymentModalClose}
          practiceOrDoctorName={paymentQueue[0].practiceName}
          defaultAmount={paymentQueue[0].defaultAmount}
          invoiceIds={[]}
          providerOrganizationId={paymentQueue[0].providerOrganizationId}
          labOrganizationId={orgId}
          doctorName={paymentQueue[0].doctorName ?? null}
        />
      )}
    </div>
  );
}

// ── Helpers for GenerateStatementsModal ─────────────────────────────────────

interface BatchDownloadBody {
  recipientType: RecipientMode;
  practiceIds: string[] | null;
  doctorKeys: string[] | null;
  invoiceScope: string;
  from: string | null;
  to: string | null;
  asOf: string | null;
  periodLabel: string | null;
}

async function downloadStatementsZip(
  orgId: string,
  body: BatchDownloadBody
): Promise<void> {
  const rawToken = localStorage.getItem("labtrax_desktop_tokens_v1");
  let accessToken = "";
  if (rawToken) {
    try { accessToken = JSON.parse(rawToken)?.accessToken ?? ""; } catch { /* ignore */ }
  }
  const res = await fetch(`/api/lab-orgs/${orgId}/statements/batch-download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text)?.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `statements-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

async function previewStatementPdf(
  orgId: string,
  body: {
    recipientType: "practice" | "doctor";
    recipientKey: string;
    invoiceScope: string;
    from: string | null;
    to: string | null;
    asOf: string | null;
    periodLabel: string | null;
    invoiceIds?: string[];
    documentKey?: string | null;
    doctorFilters?: Record<string, string[]>;
  }
  ,
  downloadName?: string,
): Promise<void> {
  const rawToken = localStorage.getItem("labtrax_desktop_tokens_v1");
  let accessToken = "";
  if (rawToken) {
    try { accessToken = JSON.parse(rawToken)?.accessToken ?? ""; } catch { /* ignore */ }
  }
  const res = await fetch(`/api/lab-orgs/${orgId}/statements/preview-pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text)?.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (downloadName) {
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const win = window.open(url, "_blank");
  // Revoke after a short delay to allow the new tab to load the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (!win) {
    // Fallback: trigger a download if popups are blocked.
    const a = document.createElement("a");
    a.href = url;
    a.download = "statement-preview.pdf";
    a.click();
  }
}
type RecipientMode = "practice" | "doctor";

type BatchScope =
  | "open"
  | "open_overdue_90"
  | "all"
  | "last_30_days"
  | "over_90_days"
  | "custom"
  | "open_as_of";

interface StatementRecipientDoctor {
  key: string;
  name: string;
  email: string | null;
  phone: string | null;
  invoiceCount?: number;
  totalBilled?: number;
  openBalance?: number;
}

interface StatementRecipient {
  key: string;
  name: string;
  email: string | null;
  phone: string | null;
  statementEmailOptOut: boolean;
  invoiceCount: number;
  openBalance: number;
  totalBilled: number;
  /**
   * Saved billing recipients (primary + billing-tagged additional addresses)
   * the server prefills for this practice. Correspondence-only contacts are
   * intentionally not included.
   */
  recipientEmails?: string[];
  doctors: StatementRecipientDoctor[];
}

/** Matches the server-side address check used to validate a per-send override. */
function isLikelyEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320 || /\s/.test(trimmed)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(trimmed);
}

/** Case-insensitive de-duplication that keeps the first spelling entered. */
function normalizeEmailList(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out;
}

interface BatchSendResult {
  practiceId: string;
  practiceName: string;
  emailStatus: "sent" | "failed" | "skipped" | null;
  emailError: string | null;
  smsStatus: "sent" | "failed" | "skipped" | null;
  smsError: string | null;
  downloadStatus?: "sent" | "failed" | null;
  downloadError?: string | null;
  /** Send-run recorded for this practice; retried through its issued PDFs. */
  runId?: string;
  statementId?: string | null;
  /**
   * True when the server can re-send the exact documents this practice was
   * issued. A retry then mails those PDFs instead of rebuilding a statement
   * from invoices that may have changed since the failed attempt.
   */
  replayable?: boolean;
}

function BatchStatusBadge({ status, error }: { status: "sent" | "failed" | "skipped" | null; error: string | null }) {
  if (status === null) return <span className="text-muted-foreground text-[11px]">—</span>;
  if (status === "sent") return <span className="text-[11px] font-medium text-success">Sent</span>;
  if (status === "skipped") return <span className="text-[11px] text-warning" title={error ?? "Skipped"}>Skipped</span>;
  return <span className="text-[11px] text-destructive" title={error ?? "Failed"}>Failed</span>;
}

function GenerateStatementsModal({
  orgId,
  initialPracticeIds,
  messageDefaults,
  initialSelectedKeys,
  onClose,
}: {
  orgId: string;
  /** Practice org IDs that were checked on the Statements table when the modal
   *  was opened. When non-empty and in doctor mode, the server pre-filters the
   *  recipients list to only doctors from those practices. */
  initialPracticeIds: string[];
  messageDefaults: {
    subject: string | null;
    body: string | null;
    header: string | null;
    replyTo: string | null;
  } | null;
  initialSelectedKeys?: Set<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  const [recipientMode, setRecipientMode] = useState<RecipientMode>("practice");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    initialSelectedKeys && initialSelectedKeys.size > 0
      ? new Set(initialSelectedKeys)
      : new Set()
  );
  const [allSelected, setAllSelected] = useState(
    !initialSelectedKeys || initialSelectedKeys.size === 0
  );
  const [recipientSearch, setRecipientSearch] = useState("");
  const [onlyWithBalance, setOnlyWithBalance] = useState(true);

  const [scope, setScope] = useState<BatchScope>("open");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customAsOf, setCustomAsOf] = useState("");
  const [cutoffCalendarOpen, setCutoffCalendarOpen] = useState(false);
  const cutoffScopeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (scope !== "open_as_of" || step !== 1) setCutoffCalendarOpen(false);
  }, [scope, step]);

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [downloadEnabled, setDownloadEnabled] = useState(false);
  const [emailSubject, setEmailSubject] = useState(messageDefaults?.subject ?? "");
  const [emailBody, setEmailBody] = useState(
    messageDefaults?.body?.trim() || DEFAULT_STATEMENT_BODY_PRACTICE,
  );
  const [emailBodyCustomized, setEmailBodyCustomized] = useState(
    Boolean(messageDefaults?.body?.trim()),
  );
  const [emailHeader, setEmailHeader] = useState(messageDefaults?.header ?? "");
  const [emailReplyTo, setEmailReplyTo] = useState(messageDefaults?.replyTo ?? "");
  const [stmtPeriodLabel, setStmtPeriodLabel] = useState(defaultStatementPeriodLabel);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [results, setResults] = useState<BatchSendResult[] | null>(null);
  const [resultPeriodLabel, setResultPeriodLabel] = useState("");

  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Doctor sub-row state: which practices are expanded, and which doctors are selected per practice.
  const [expandedPractices, setExpandedPractices] = useState<Set<string>>(new Set());
  const [doctorSelections, setDoctorSelections] = useState<Map<string, Set<string>>>(new Map());

  // Inline add email/phone in the recipient list.
  const [inlineEdit, setInlineEdit] = useState<{ key: string; field: "email" | "phone"; value: string } | null>(null);
  const [inlineEditSaving, setInlineEditSaving] = useState(false);
  const [inlineEditError, setInlineEditError] = useState<string | null>(null);
  // Track practices that just had an email added from the Results step (step 5) so we can offer "Send now".
  const [readyToResendIds, setReadyToResendIds] = useState<Set<string>>(new Set());

  // Per-send recipient overrides keyed by practice id. Present only for a
  // practice the user actually edited; an entry replaces the saved list for
  // this send only and is never written back to the practice's contacts.
  const [recipientOverrides, setRecipientOverrides] = useState<Map<string, string[]>>(new Map());
  const [recipientDraft, setRecipientDraft] = useState<{ key: string; value: string } | null>(null);
  const [recipientDraftError, setRecipientDraftError] = useState<string | null>(null);

  // A blank saved template starts as the practice default. Switching recipient
  // mode changes only that untouched default; saved or manually edited copy is
  // always authoritative.
  useEffect(() => {
    if (!emailBodyCustomized) {
      setEmailBody(defaultStatementBody(recipientMode));
    }
  }, [recipientMode, emailBodyCustomized]);

  const fromIso =
    scope === "custom" && customFrom
      ? new Date(`${customFrom}T00:00:00`).toISOString()
      : null;
  const toIso =
    scope === "custom" && customTo
      ? new Date(`${customTo}T23:59:59`).toISOString()
      : null;
  const asOfIso =
    scope === "open_as_of" && customAsOf
      ? new Date(`${customAsOf}T23:59:59`).toISOString()
      : null;
  const customReady =
    (scope !== "custom" || (!!fromIso && !!toIso)) &&
    (scope !== "open_as_of" || !!asOfIso);

  // Recipients are sourced from the server, which builds them from
  // invoice-backed rows for the chosen scope. This is the fix for the old
  // recipient-sourcing bug: practices with invoices but no parent-lab link
  // were dropped when the list was derived from the org tree instead.
  // When the user opened the modal with practices selected and is in doctor
  // mode, pre-filter recipients to only those practices' doctors.
  const practiceIdFilter =
    recipientMode === "doctor" && initialPracticeIds.length
      ? initialPracticeIds
      : [];

  const recipientsQuery = useQuery<{ recipients: StatementRecipient[] }>({
    queryKey: [
      "statement-recipients",
      orgId,
      recipientMode,
      scope,
      fromIso,
      toIso,
      asOfIso,
      practiceIdFilter,
    ],
    queryFn: () => {
      const params = new URLSearchParams({ mode: recipientMode, scope });
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      if (asOfIso) params.set("asOf", asOfIso);
      for (const id of practiceIdFilter) params.append("practiceIds", id);
      return apiFetch(
        `/lab-orgs/${orgId}/statements/recipients?${params.toString()}`
      );
    },
    enabled: !!orgId && customReady,
  });
  const recipients = recipientsQuery.data?.recipients ?? [];

  // Keep explicit recipient selection across invoice-scope/date changes. A
  // mode change is different: practice IDs and doctor keys are incompatible,
  // so switching modes intentionally starts with every recipient selected.
  const selectionAnchorIdRef = useRef<string | null>(null);
  const previousRecipientModeRef = useRef(recipientMode);
  useEffect(() => {
    if (previousRecipientModeRef.current === recipientMode) {
      return;
    }
    previousRecipientModeRef.current = recipientMode;
    setSelectedKeys(new Set());
    setAllSelected(true);
    setExpandedPractices(new Set());
    setDoctorSelections(new Map());
    setInlineEdit(null);
    // Overrides are keyed by practice id, so they cannot carry into doctor mode.
    setRecipientOverrides(new Map());
    setRecipientDraft(null);
    setRecipientDraftError(null);
    selectionAnchorIdRef.current = null;
  }, [recipientMode]);

  // A recipient can disappear when the selected scope or date inputs change.
  // Reconcile only after a successful response so a temporarily empty/loading
  // query cannot erase the selection before the refreshed data arrives.
  useEffect(() => {
    if (!recipientsQuery.data || allSelected) {
      return;
    }
    const availableKeys = new Set(recipients.map((recipient) => recipient.key));
    setSelectedKeys((prev) => {
      const next = new Set(
        Array.from(prev).filter((key) => availableKeys.has(key)),
      );
      return next.size === prev.size ? prev : next;
    });

    // Preserve per-practice doctor choices where possible, while dropping
    // doctor keys that are no longer in the refreshed recipient set.
    setDoctorSelections((prev) => {
      if (prev.size === 0) return prev;
      const recipientsByKey = new Map(recipients.map((r) => [r.key, r]));
      let changed = false;
      const next = new Map<string, Set<string>>();
      for (const [practiceKey, doctorKeys] of prev) {
        const recipient = recipientsByKey.get(practiceKey);
        if (!recipient) {
          changed = true;
          continue;
        }
        const availableDoctorKeys = new Set(
          recipient.doctors.map((doctor) => doctor.key),
        );
        if (availableDoctorKeys.size === 0) {
          changed = true;
          continue;
        }
        const validDoctorKeys = new Set(
          Array.from(doctorKeys).filter((key) => availableDoctorKeys.has(key)),
        );
        if (validDoctorKeys.size !== doctorKeys.size) changed = true;
        next.set(practiceKey, validDoctorKeys);
      }
      return changed ? next : prev;
    });
  }, [allSelected, recipients, recipientsQuery.data]);

  // A recipient refresh must not silently restore an address the user removed
  // for this send, so overrides survive every refresh. Only an override whose
  // practice is gone from the refreshed set is dropped.
  useEffect(() => {
    if (!recipientsQuery.data) return;
    const availableKeys = new Set(recipients.map((recipient) => recipient.key));
    setRecipientOverrides((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map<string, string[]>();
      for (const [practiceKey, emails] of prev) {
        if (!availableKeys.has(practiceKey)) {
          changed = true;
          continue;
        }
        next.set(practiceKey, emails);
      }
      return changed ? next : prev;
    });
  }, [recipients, recipientsQuery.data]);

  const filteredRecipients = useMemo(() => {
    const q = recipientSearch.trim().toLowerCase();
    return recipients.filter((r) => {
      if (onlyWithBalance && r.openBalance <= 0) return false;
      if (q) return r.name.toLowerCase().includes(q);
      return true;
    });
  }, [recipients, recipientSearch, onlyWithBalance]);

  function isChecked(key: string) { return allSelected || selectedKeys.has(key); }

  function toggleRecipient(key: string) {
    setSelectedKeys((prev) => {
      const base = allSelected ? new Set(filteredRecipients.map((r) => r.key)) : new Set(prev);
      if (base.has(key)) base.delete(key); else base.add(key);
      return base;
    });
    setAllSelected(false);
  }

  // Shift-click range selection for the recipient checkboxes. Normal click
  // toggles + moves the anchor; shift-click with a valid anchor adds every
  // recipient between the anchor and the clicked row (in current filtered
  // order); a stale anchor falls back to a single toggle and resets.
  function handleRecipientCheckboxChange(key: string, shiftKey: boolean) {
    if (shiftKey) {
      const rangeIds = computeShiftClickRange(
        filteredRecipients.map((r) => r.key),
        selectionAnchorIdRef.current,
        key,
      );
      if (rangeIds) {
        setSelectedKeys((prev) => {
          const base = allSelected ? new Set(filteredRecipients.map((r) => r.key)) : new Set(prev);
          for (const rid of rangeIds) base.add(rid);
          return base;
        });
        setAllSelected(false);
        return;
      }
      selectionAnchorIdRef.current = null;
    }
    toggleRecipient(key);
    selectionAnchorIdRef.current = key;
  }

  function selectAll() { setSelectedKeys(new Set()); setAllSelected(true); setDoctorSelections(new Map()); }
  function deselectAll() { setSelectedKeys(new Set()); setAllSelected(false); setDoctorSelections(new Map()); }

  const selectedRecipients = useMemo(() => {
    const base = allSelected ? filteredRecipients : filteredRecipients.filter((r) => selectedKeys.has(r.key));
    // Exclude practices where ALL doctors have been individually deselected.
    return base.filter((r) => {
      const ds = doctorSelections.get(r.key);
      return ds === undefined || ds.size > 0;
    });
  }, [allSelected, filteredRecipients, selectedKeys, doctorSelections]);
  const selectedCount = selectedRecipients.length;
  const recipientNoun = recipientMode === "doctor" ? "doctor" : "practice";
  const recipientNounPlural = recipientMode === "doctor" ? "doctors" : "practices";
  const recipientsWithPhone = selectedRecipients.filter((r) => r.phone).length;

  /** The doctor documents that will be attached to this practice's email. */
  const selectedDoctorsFor = useCallback(
    (r: StatementRecipient): StatementRecipientDoctor[] => {
      const all = r.doctors ?? [];
      const ds = doctorSelections.get(r.key);
      if (ds === undefined) return all;
      return all.filter((doctor) => ds.has(doctor.key));
    },
    [doctorSelections],
  );

  /**
   * The addresses this practice's message will actually go to. An explicit
   * override is authoritative — including an empty one, which blocks the send
   * for that practice rather than quietly falling back to saved contacts.
   */
  const recipientEmailsFor = useCallback(
    (r: StatementRecipient): string[] => {
      const override = recipientOverrides.get(r.key);
      if (override) return override;
      return normalizeEmailList(r.recipientEmails ?? [r.email]);
    },
    [recipientOverrides],
  );

  const recipientsWithEmail = selectedRecipients.filter((r) =>
    recipientMode === "practice" ? recipientEmailsFor(r).length > 0 : !!r.email,
  ).length;

  // Practice mode sends one email per practice but one PDF per selected
  // doctor, so review must not present these as the same number.
  const documentCount = useMemo(() => {
    if (recipientMode !== "practice") return selectedRecipients.length;
    return selectedRecipients.reduce(
      (sum, r) => sum + Math.max(selectedDoctorsFor(r).length, r.doctors?.length ? 0 : 1),
      0,
    );
  }, [recipientMode, selectedRecipients, selectedDoctorsFor]);

  // Sum the same documents generation uses, not practice + doctor totals or
  // total billed sales. Round each document to cents before aggregating.
  const selectedStatementAmount = useMemo(() => {
    const cents = selectedRecipients.reduce((sum, recipient) => {
      const documents =
        recipientMode === "practice" && recipient.doctors?.length
          ? selectedDoctorsFor(recipient)
          : [recipient];
      return sum + documents.reduce(
        (subtotal, document) =>
          subtotal + Math.round(((document.openBalance ?? 0) + Number.EPSILON) * 100),
        0,
      );
    }, 0);
    return cents / 100;
  }, [recipientMode, selectedRecipients, selectedDoctorsFor]);

  function addRecipientEmail(practiceKey: string, raw: string) {
    const value = raw.trim();
    if (!value) return;
    if (!isLikelyEmailAddress(value)) {
      setRecipientDraftError("Enter a valid email address.");
      return;
    }
    const current =
      recipientOverrides.get(practiceKey) ??
      normalizeEmailList(
        recipients.find((r) => r.key === practiceKey)?.recipientEmails ?? [],
      );
    setRecipientOverrides((prev) => {
      const next = new Map(prev);
      next.set(practiceKey, normalizeEmailList([...current, value]));
      return next;
    });
    setRecipientDraft({ key: practiceKey, value: "" });
    setRecipientDraftError(null);
  }

  function removeRecipientEmail(practiceKey: string, email: string) {
    const current =
      recipientOverrides.get(practiceKey) ??
      normalizeEmailList(
        recipients.find((r) => r.key === practiceKey)?.recipientEmails ?? [],
      );
    setRecipientOverrides((prev) => {
      const next = new Map(prev);
      next.set(
        practiceKey,
        current.filter((value) => value.toLowerCase() !== email.toLowerCase()),
      );
      return next;
    });
    setRecipientDraftError(null);
  }

  function buildKeysPayload(overrideKeys?: string[]) {
    // Always send explicit keys for the currently-visible selection. "Select
    // all" must never send null (whole scope) while a search/aging filter is
    // active, or hidden recipients would be included. selectedRecipients is
    // already scoped to the active filter (allSelected → filteredRecipients).
    const keys = overrideKeys ?? selectedRecipients.map((r) => r.key);
    // A retry or a single "Send now" must reproduce the original bundle, so
    // doctor selections and per-send recipients are carried on every payload
    // and narrowed to the keys actually being sent.
    const keySet = new Set(keys);
    const doctorFilters: Record<string, string[]> = {};
    let hasDoctorFilters = false;
    const recipientEmails: Record<string, string[]> = {};
    let hasRecipientEmails = false;
    if (recipientMode === "practice") {
      for (const r of selectedRecipients) {
        if (!keySet.has(r.key)) continue;
        const ds = doctorSelections.get(r.key);
        const totalDoctors = r.doctors?.length ?? 0;
        if (ds !== undefined && totalDoctors > 0 && ds.size < totalDoctors) {
          doctorFilters[r.key] = Array.from(ds);
          hasDoctorFilters = true;
        }
        const override = recipientOverrides.get(r.key);
        if (override) {
          recipientEmails[r.key] = override;
          hasRecipientEmails = true;
        }
      }
    }
    return {
      recipientType: recipientMode,
      practiceIds: recipientMode === "practice" ? keys : null,
      doctorKeys: recipientMode === "doctor" ? keys : null,
      ...(hasDoctorFilters ? { doctorFilters } : {}),
      ...(hasRecipientEmails ? { recipientEmails } : {}),
    };
  }

  /**
   * In practice mode the wizard's recipient list belongs to this send, so an
   * address typed into it is added to that list — including on a practice
   * that has no saved billing contact at all. Writing it to the practice
   * record instead would change a saved contact the user never asked to
   * change. SMS has no per-send list, so a phone edit still updates the
   * practice record as before.
   */
  function isPerSendRecipientEdit(_practiceKey: string, field: "email" | "phone") {
    return field === "email" && recipientMode === "practice";
  }

  async function handleInlineEditSave() {
    if (!inlineEdit) return;
    setInlineEditSaving(true);
    setInlineEditError(null);
    const savedKey = inlineEdit.key;
    const savedField = inlineEdit.field;
    const savedValue = inlineEdit.value.trim();
    const perSendOnly = isPerSendRecipientEdit(savedKey, savedField);
    try {
      if (perSendOnly) {
        if (!isLikelyEmailAddress(savedValue)) {
          setInlineEditError("Enter a valid email address.");
          return;
        }
        // Add to whatever this practice's list currently is — the edited
        // list when one exists, otherwise its saved billing addresses — so
        // typing an address never silently drops the others.
        const current =
          recipientOverrides.get(savedKey) ??
          normalizeEmailList(
            recipients.find((r) => r.key === savedKey)?.recipientEmails ?? [],
          );
        setRecipientOverrides((prev) => {
          const next = new Map(prev);
          next.set(savedKey, normalizeEmailList([...current, savedValue]));
          return next;
        });
      } else {
        const body = savedField === "email"
          ? { billingEmail: savedValue }
          : { phone: savedValue };
        await apiFetch(`/organizations/${savedKey}`, { method: "PATCH", body: JSON.stringify(body) });
        qc.invalidateQueries({ queryKey: ["statement-recipients"] });
        qc.invalidateQueries({ queryKey: ["organizations"] });
      }
      // If we're on the Results step and an email was just added, mark that practice as ready to re-send.
      if (step === 5 && savedField === "email") {
        setReadyToResendIds((prev) => new Set([...prev, savedKey]));
      }
      setInlineEdit(null);
    } catch (e) {
      setInlineEditError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setInlineEditSaving(false);
    }
  }

  /**
   * Previews one of the documents that would actually be sent. In practice
   * mode `documentKey` selects a single doctor's PDF out of the bundle, so a
   * preview can never show a consolidated statement the email will not send.
   */
  async function handlePreviewPdf(recipientKey: string, documentKey?: string) {
    const previewKey = documentKey ? `${recipientKey}::${documentKey}` : recipientKey;
    setPreviewingKey(previewKey);
    setPreviewError(null);
    const doctorKeys =
      recipientMode === "practice" ? doctorSelections.get(recipientKey) : undefined;
    try {
      await previewStatementPdf(orgId, {
        recipientType: recipientMode,
        recipientKey,
        invoiceScope: scope,
        from: fromIso,
        to: toIso,
        asOf: asOfIso,
        periodLabel: stmtPeriodLabel.trim() || null,
        ...(documentKey ? { documentKey } : {}),
        ...(doctorKeys ? { doctorFilters: { [recipientKey]: Array.from(doctorKeys) } } : {}),
      });
    } catch (err: unknown) {
      setPreviewError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewingKey(null);
    }
  }

  async function handleSend() {
    setSending(true);
    setSendError(null);
    const channels: Array<"email" | "sms"> = [
      ...(emailEnabled ? (["email"] as const) : []),
      ...(smsEnabled ? (["sms"] as const) : []),
    ];
    // Snapshot the recipients this run targets so per-recipient results stay
    // accurate even if the selection resets afterward.
    const targetRecipients = selectedRecipients.map((r) => ({ key: r.key, name: r.name }));
    try {
      let sendResults: BatchSendResult[] = [];
      let newLabel = stmtPeriodLabel;
      if (channels.length > 0) {
        const resp = await apiFetch<{ periodLabel: string; results: BatchSendResult[] }>(
          `/lab-orgs/${orgId}/statements/batch-send`,
          {
            method: "POST",
            body: JSON.stringify({
              ...buildKeysPayload(),
              invoiceScope: scope,
              from: fromIso,
              to: toIso,
              asOf: asOfIso,
              channels,
              emailSubject: emailSubject.trim() || null,
              emailBody: emailBody.trim() || null,
              emailHeader: emailHeader.trim() || null,
              emailReplyTo: emailReplyTo.trim() || null,
              periodLabel: stmtPeriodLabel.trim() || null,
            }),
          }
        );
        sendResults = resp.results;
        newLabel = resp.periodLabel;
      }
      let downloadOk = false;
      let downloadErr: string | null = null;
      if (downloadEnabled) {
        try {
          await downloadStatementsZip(orgId, {
            ...buildKeysPayload(),
            invoiceScope: scope,
            from: fromIso,
            to: toIso,
            asOf: asOfIso,
            periodLabel: stmtPeriodLabel.trim() || null,
          });
          downloadOk = true;
        } catch (err: unknown) {
          downloadErr = err instanceof ApiError ? err.message : (err as Error).message;
        }
      }
      // Merge into one per-recipient row set so the results table shows an
      // accurate email / SMS / download status for every targeted recipient.
      const sendByKey = new Map(sendResults.map((r) => [r.practiceId, r]));
      const merged: BatchSendResult[] = targetRecipients.map((rec) => {
        const sr = sendByKey.get(rec.key);
        return {
          practiceId: rec.key,
          practiceName: sr?.practiceName ?? rec.name,
          emailStatus: sr?.emailStatus ?? null,
          emailError: sr?.emailError ?? null,
          smsStatus: sr?.smsStatus ?? null,
          smsError: sr?.smsError ?? null,
          downloadStatus: downloadEnabled ? (downloadOk ? "sent" : "failed") : null,
          downloadError: downloadEnabled && !downloadOk ? downloadErr : null,
          // Kept so a retry can re-send the documents this practice was
          // issued instead of rebuilding them from current invoices.
          runId: sr?.runId,
          statementId: sr?.statementId ?? null,
          replayable: sr?.replayable ?? false,
        };
      });
      qc.invalidateQueries({ queryKey: ["statement-runs", orgId] });
      qc.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
      });
      setResults(merged);
      setResultPeriodLabel(newLabel);
      setStep(5);
    } catch (err: unknown) {
      setSendError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  /**
   * Send-run ids of practices whose documents were already issued, so the
   * server re-sends those PDFs instead of rebuilding the statement. Without
   * this an invoice paid or edited since the failed attempt would quietly
   * change what the practice receives on the retry.
   */
  function buildReplayRuns(practiceIds: string[]): Record<string, string> {
    const byId = new Map((results ?? []).map((r) => [r.practiceId, r]));
    const out: Record<string, string> = {};
    for (const id of practiceIds) {
      const prior = byId.get(id);
      if (prior?.replayable && prior.runId) out[id] = prior.runId;
    }
    return out;
  }

  async function handleRetryFailed() {
    if (!results) return;
    const failedIds = results
      .filter((r) => r.emailStatus === "failed" || r.smsStatus === "failed")
      .map((r) => r.practiceId);
    if (!failedIds.length) return;
    const replayRuns = buildReplayRuns(failedIds);
    setSending(true);
    setSendError(null);
    const channels: Array<"email" | "sms"> = [
      ...(emailEnabled ? (["email"] as const) : []),
      ...(smsEnabled ? (["sms"] as const) : []),
    ];
    try {
      const resp = await apiFetch<{ periodLabel: string; results: BatchSendResult[] }>(
        `/lab-orgs/${orgId}/statements/batch-send`,
        {
          method: "POST",
          body: JSON.stringify({
            ...buildKeysPayload(failedIds),
            invoiceScope: scope,
            from: fromIso,
            to: toIso,
            asOf: asOfIso,
            channels,
            emailSubject: emailSubject.trim() || null,
            emailBody: emailBody.trim() || null,
            emailHeader: emailHeader.trim() || null,
            emailReplyTo: emailReplyTo.trim() || null,
            periodLabel: stmtPeriodLabel.trim() || null,
            ...(Object.keys(replayRuns).length ? { replayRuns } : {}),
          }),
        }
      );
      const retryMap = new Map(resp.results.map((r) => [r.practiceId, r]));
      setResults((prev) =>
        prev
          ? prev.map((r) => {
              const rr = retryMap.get(r.practiceId);
              // Only email/SMS were retried; keep the original download status.
              return rr
                ? {
                    ...rr,
                    downloadStatus: r.downloadStatus,
                    downloadError: r.downloadError,
                  }
                : r;
            })
          : null,
      );
      setResultPeriodLabel(resp.periodLabel);
      qc.invalidateQueries({ queryKey: ["statement-runs", orgId] });
      qc.invalidateQueries({
        queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId],
      });
    } catch (err: unknown) {
      setSendError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function handleSendNow(practiceId: string) {
    setSending(true);
    setSendError(null);
    const channels: Array<"email" | "sms"> = [
      ...(emailEnabled ? (["email"] as const) : []),
      ...(smsEnabled ? (["sms"] as const) : []),
    ];
    const replayRuns = buildReplayRuns([practiceId]);
    try {
      const resp = await apiFetch<{ periodLabel: string; results: BatchSendResult[] }>(
        `/lab-orgs/${orgId}/statements/batch-send`,
        {
          method: "POST",
          body: JSON.stringify({
            ...buildKeysPayload([practiceId]),
            invoiceScope: scope,
            from: fromIso,
            to: toIso,
            asOf: asOfIso,
            channels,
            emailSubject: emailSubject.trim() || null,
            emailBody: emailBody.trim() || null,
            emailHeader: emailHeader.trim() || null,
            emailReplyTo: emailReplyTo.trim() || null,
            periodLabel: stmtPeriodLabel.trim() || null,
            ...(Object.keys(replayRuns).length ? { replayRuns } : {}),
          }),
        }
      );
      const retryMap = new Map(resp.results.map((r) => [r.practiceId, r]));
      setResults((prev) =>
        prev
          ? prev.map((r) => {
              const rr = retryMap.get(r.practiceId);
              return rr ? { ...rr, downloadStatus: r.downloadStatus, downloadError: r.downloadError } : r;
            })
          : null,
      );
      setResultPeriodLabel(resp.periodLabel);
      setReadyToResendIds((prev) => {
        const next = new Set(prev);
        next.delete(practiceId);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["statement-runs", orgId] });
    } catch (err: unknown) {
      setSendError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const canSend = emailEnabled || smsEnabled || downloadEnabled;

  const SCOPE_OPTIONS: Array<{ value: BatchScope; title: string; desc: string }> = [
    { value: "open", title: "Open invoices only", desc: "Non-paid, non-voided invoices with a remaining balance." },
    { value: "open_overdue_90", title: "Open invoices (aging highlighted)", desc: "Same as above — PDF highlights invoices 30, 60, and 90+ days past due." },
    { value: "over_90_days", title: "Over 90 days past due", desc: "Only open invoices more than 90 days past their due date." },
    { value: "open_as_of", title: "Open invoices through a cutoff date", desc: "All unpaid, non-voided invoices issued on or before the date you choose." },
    { value: "last_30_days", title: "Last 30 days", desc: "Invoices issued in the past 30 days, regardless of status." },
    { value: "all", title: "All invoices", desc: "Every invoice regardless of status — includes paid and voided." },
    { value: "custom", title: "Custom date range", desc: "Invoices issued between the two dates you choose below." },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/40" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <div className="text-xs text-muted-foreground">Generate statements</div>
            <div className="text-sm font-semibold">
              {step === 1 ? "Recipients & invoice scope" : step === 2 ? `Select ${recipientNounPlural}` : step === 3 ? "Delivery channels" : step === 4 ? "Review & send" : "Results"}
            </div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"><X size={16} /></button>
        </header>

        <div className="flex items-center px-5 py-2.5 border-b border-border gap-1 shrink-0">
          {(["Setup", "Recipients", "Delivery", "Review"] as const).map((label, idx) => {
            const n = (idx + 1) as 1 | 2 | 3 | 4;
            const active = step === n;
            const done = step > n && step < 5;
            const indicator = (
              <div className={`flex items-center gap-1.5 text-[11px] font-medium ${active ? "text-primary" : done ? "text-success" : "text-muted-foreground"}`}>
                <div className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${active ? "bg-primary text-primary-foreground" : done ? "bg-success/20 text-success" : "bg-secondary text-muted-foreground"}`}>
                  {done ? "✓" : n}
                </div>
                {label}
              </div>
            );
            return (
              <div key={n} className="flex items-center gap-1">
                {done ? (
                  <button
                    type="button"
                    onClick={() => setStep(n)}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-success hover:text-success/80 cursor-pointer"
                  >
                    <div className="h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-success/20 text-success">✓</div>
                    {label}
                  </button>
                ) : (
                  indicator
                )}
                {idx < 3 && <div className="w-5 h-px bg-border mx-0.5" />}
              </div>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label htmlFor="statement-label" className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Statement label</label>
                <input id="statement-label" type="text" value={stmtPeriodLabel} onChange={(e) => setStmtPeriodLabel(e.target.value)} className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                <p className="text-[11px] text-muted-foreground mt-1">This label appears on the PDF and in the email. It does not control which invoices are included.</p>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Send statements to</label>
                <div className="grid grid-cols-2 gap-2">
                  {(["practice", "doctor"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setRecipientMode(mode)}
                      className={`p-3 rounded-lg border text-left transition-colors ${recipientMode === mode ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                    >
                      <span className="block text-sm font-medium capitalize">{mode === "practice" ? "Practices" : "Doctors"}</span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {mode === "practice"
                          ? "One email per billing practice, with a separate statement PDF for each selected doctor."
                          : "One statement per doctor across all cases."}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Invoice scope</label>
                <div className="space-y-2">
                  {SCOPE_OPTIONS.map(({ value: sv, title, desc }) => (
                    <div key={sv} className={`rounded-lg border select-none transition-colors ${scope === sv ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                    <label className="flex items-start gap-3 p-3 cursor-pointer">
                      <input type="radio" name="scope" value={sv} checked={scope === sv}
                        ref={sv === "open_as_of" ? cutoffScopeRef : undefined}
                        aria-describedby={sv === "open_as_of" && scope === sv ? "cutoff-scope-status" : undefined}
                        onChange={() => { setScope(sv); setCutoffCalendarOpen(sv === "open_as_of"); }}
                        onClick={() => { if (sv === "open_as_of") { setScope(sv); setCutoffCalendarOpen(true); } }}
                        onKeyDown={(event) => {
                          if (sv === "open_as_of" && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            setScope(sv);
                            setCutoffCalendarOpen(true);
                          }
                        }}
                        className="mt-0.5 accent-primary" />
                      <span>
                        <span className="block text-sm font-medium">{title}</span>
                        <span className="block text-xs text-muted-foreground mt-0.5">{desc}</span>
                      </span>
                    </label>
                    {sv === "open_as_of" && scope === sv && (
                      <div id="cutoff-scope-status" className="px-3 pb-3 pl-9">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                          {customAsOf && <span className="font-medium">{formatStatementCutoffDate(customAsOf)}</span>}
                          <button type="button" onClick={() => setCutoffCalendarOpen(true)} className="text-primary underline underline-offset-2">
                            {customAsOf ? "Change date" : "Choose date"}
                          </button>
                        </div>
                        {customAsOf
                          ? <p className="text-[11px] text-muted-foreground mt-1">Include open invoices issued on or before {formatStatementCutoffDate(customAsOf)}.</p>
                          : <p className="text-[11px] text-destructive mt-1">Choose an invoice cutoff date.</p>}
                      </div>
                    )}
                    </div>
                  ))}
                </div>
                <StatementCutoffCalendar
                  open={cutoffCalendarOpen && scope === "open_as_of" && step === 1}
                  value={customAsOf}
                  onOpenChange={setCutoffCalendarOpen}
                  onSelect={setCustomAsOf}
                  returnFocus={() => cutoffScopeRef.current?.focus({ preventScroll: true })}
                />
                {scope === "custom" && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">From</label>
                      <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                    </div>
                    <div>
                      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">To</label>
                      <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                    </div>
                    {!customReady && <p className="col-span-2 text-[11px] text-destructive">Choose both a start and end date.</p>}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              {practiceIdFilter.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Showing doctors for {practiceIdFilter.length === 1 ? "the 1 selected practice" : `the ${practiceIdFilter.length} selected practices`}.
                </p>
              )}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input type="search" value={recipientSearch} onChange={(e) => setRecipientSearch(e.target.value)} placeholder={`Search ${recipientNoun}…`} className="w-full h-8 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none shrink-0">
                  <input type="checkbox" checked={onlyWithBalance} onChange={(e) => setOnlyWithBalance(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
                  Open balance only
                </label>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-muted-foreground">{selectedCount} of {filteredRecipients.length} {filteredRecipients.length === 1 ? recipientNoun : recipientNounPlural} selected</div>
                  <div className="text-xs text-primary font-medium mt-0.5">
                    {recipientMode === "practice"
                      ? `${selectedCount} practice email${selectedCount !== 1 ? "s" : ""} · ${documentCount} statement PDF${documentCount !== 1 ? "s" : ""}`
                      : `${selectedCount} statement${selectedCount !== 1 ? "s" : ""} will be generated`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAll} className="text-xs text-primary hover:underline">Select all</button>
                  <span className="text-muted-foreground text-xs">/</span>
                  <button type="button" onClick={deselectAll} className="text-xs text-primary hover:underline">None</button>
                </div>
              </div>
              <div
                role="status"
                aria-label="Total Generated Statement Amount"
                aria-busy={recipientsQuery.isFetching}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
              >
                <span className="text-xs font-normal text-muted-foreground">Total Generated Statement Amount</span>
                {recipientsQuery.isFetching || recipientsQuery.isPending ? (
                  <span className="text-sm text-muted-foreground">Calculating…</span>
                ) : recipientsQuery.isError ? (
                  <span className="text-sm text-destructive">Unavailable</span>
                ) : (
                  <span className="text-xl font-bold tabular-nums">{formatMoney(selectedStatementAmount)}</span>
                )}
              </div>
              {recipientsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground py-6 text-center"><Loader2 size={14} className="inline animate-spin mr-1.5" />Loading {recipientNounPlural}…</p>
              ) : recipientsQuery.isError ? (
                <p className="text-sm text-destructive py-6 text-center">Failed to load {recipientNounPlural}.</p>
              ) : filteredRecipients.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No {recipientNounPlural} match the current filter.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-secondary/10 divide-y divide-border">
                  {filteredRecipients.map((r) => {
                    const checked = isChecked(r.key);
                    const allDoctors = r.doctors ?? [];
                    const ds = doctorSelections.get(r.key);
                    const isExpanded = expandedPractices.has(r.key);
                    const someDeselected = ds !== undefined && ds.size < allDoctors.length;
                    const allDeselected = ds !== undefined && ds.size === 0;
                    const isIndeterminate = checked && someDeselected && !allDeselected;
                    return (
                      <div key={r.key}>
                        {/* Practice / recipient row */}
                        <div className="flex items-center gap-2 px-3 py-2 hover:bg-secondary/60 select-none">
                          <input
                            type="checkbox"
                            checked={checked}
                            ref={(el) => { if (el) el.indeterminate = isIndeterminate; }}
                            aria-label={`Select ${recipientNoun} ${r.name}`}
                            onMouseDown={suppressShiftClickTextSelection}
                            onChange={(ev) => {
                              // Reset doctor selections when toggling
                              setDoctorSelections((prev) => { const next = new Map(prev); next.delete(r.key); return next; });
                              handleRecipientCheckboxChange(r.key, shiftKeyFromChangeEvent(ev));
                            }}
                            className="h-4 w-4 accent-primary shrink-0 cursor-pointer"
                          />
                          {/* Expand chevron — practice mode only, when doctors are available */}
                          {recipientMode === "practice" && allDoctors.length > 0 && (
                            <button
                              type="button"
                              title={isExpanded ? "Collapse doctors" : "Expand doctors"}
                              onClick={() => setExpandedPractices((prev) => { const next = new Set(prev); if (next.has(r.key)) next.delete(r.key); else next.add(r.key); return next; })}
                              className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/80 shrink-0"
                            >
                              {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                          )}
                          <span
                            className="flex-1 min-w-0 truncate text-sm cursor-pointer"
                            onClick={() => { setDoctorSelections((prev) => { const next = new Map(prev); next.delete(r.key); return next; }); handleRecipientCheckboxChange(r.key, false); }}
                          >
                            {r.name}
                          </span>
                          <span className="tabular-nums text-xs text-muted-foreground shrink-0">
                            {r.openBalance > 0 ? formatMoney(r.openBalance) : ""}
                          </span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{r.invoiceCount} inv</span>
                          {!r.email && (
                            <button
                              type="button"
                              title="Add email"
                              onClick={(e) => { e.stopPropagation(); setInlineEdit({ key: r.key, field: "email", value: "" }); setInlineEditError(null); }}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-warning/20 text-warning font-medium shrink-0 hover:bg-warning/30 border border-warning/30"
                            >
                              no email
                            </button>
                          )}
                          {!r.phone && (
                            <button
                              type="button"
                              title="Add phone"
                              onClick={(e) => { e.stopPropagation(); setInlineEdit({ key: r.key, field: "phone", value: "" }); setInlineEditError(null); }}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-medium shrink-0 hover:bg-secondary/70 border border-border"
                            >
                              no phone
                            </button>
                          )}
                        </div>
                        {/* Inline add email/phone form */}
                        {inlineEdit?.key === r.key && (
                          <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-card border-t border-border">
                            <span className="text-xs text-muted-foreground shrink-0">
                              {inlineEdit.field === "email" ? "Email:" : "Phone:"}
                            </span>
                            <input
                              type={inlineEdit.field === "email" ? "email" : "tel"}
                              value={inlineEdit.value}
                              autoFocus
                              onChange={(ev) => setInlineEdit((prev) => prev ? { ...prev, value: ev.target.value } : null)}
                              onKeyDown={(ev) => { if (ev.key === "Enter") handleInlineEditSave(); if (ev.key === "Escape") setInlineEdit(null); }}
                              placeholder={inlineEdit.field === "email" ? "billing@practice.com" : "+1 555 000 0000"}
                              className="flex-1 min-w-[160px] h-7 px-2 rounded bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                            />
                            <button
                              type="button"
                              onClick={handleInlineEditSave}
                              disabled={inlineEditSaving || !inlineEdit.value.trim()}
                              className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                            >
                              {inlineEditSaving ? <Loader2 size={11} className="animate-spin" /> : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setInlineEdit(null)}
                              className="h-7 px-2 rounded text-xs text-muted-foreground hover:bg-secondary shrink-0"
                            >
                              Cancel
                            </button>
                            {inlineEditError && <span className="text-xs text-destructive w-full">{inlineEditError}</span>}
                          </div>
                        )}
                        {/* Doctor sub-rows */}
                        {isExpanded && allDoctors.length > 0 && (
                          <div className="bg-secondary/5 border-t border-border">
                            {allDoctors.map((doc) => {
                              const doctorChecked = ds === undefined || ds.has(doc.key);
                              return (
                                <label
                                  key={doc.key}
                                  className="flex items-center gap-2.5 pl-9 pr-3 py-1.5 cursor-pointer hover:bg-secondary/40 select-none"
                                >
                                  <input
                                    type="checkbox"
                                    checked={doctorChecked}
                                    onChange={() => {
                                      setDoctorSelections((prev) => {
                                        const next = new Map(prev);
                                        let cur = next.get(r.key);
                                        if (cur === undefined) {
                                          // Initialize with all doctors, then remove this one
                                          cur = new Set(allDoctors.map((d) => d.key));
                                        } else {
                                          cur = new Set(cur);
                                        }
                                        if (doctorChecked) cur.delete(doc.key);
                                        else cur.add(doc.key);
                                        next.set(r.key, cur);
                                        return next;
                                      });
                                    }}
                                    className="h-3.5 w-3.5 accent-primary shrink-0"
                                  />
                                  <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{doc.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Choose how to deliver statements. Select at least one option.</p>
              <div className="space-y-2">
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${emailEnabled ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                  <input type="checkbox" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium"><Mail size={13} className="inline mr-1" />Email (PDF attachment)</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {recipientMode === "practice"
                        ? `${recipientsWithEmail} of ${selectedCount} selected practices have at least one recipient address. One email per practice, with ${documentCount} statement PDF${documentCount !== 1 ? "s" : ""} in total.`
                        : `${recipientsWithEmail} of ${selectedCount} selected ${recipientNounPlural} have a billing email on file.`}
                    </span>
                  </span>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${smsEnabled ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                  <input type="checkbox" checked={smsEnabled} onChange={(e) => setSmsEnabled(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium"><MessageSquare size={13} className="inline mr-1" />SMS (secure statement link)</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">{recipientsWithPhone} of {selectedCount} selected {recipientNounPlural} have a phone number on file. Sends a time-limited secure link to the PDF.</span>
                  </span>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${downloadEnabled ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                  <input type="checkbox" checked={downloadEnabled} onChange={(e) => setDownloadEnabled(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium"><Download size={13} className="inline mr-1" />Download ZIP</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {recipientMode === "practice"
                        ? "Download a ZIP archive with the same per-doctor statement PDFs the emails would attach — no email or SMS is sent."
                        : "Download a ZIP archive with one PDF per doctor — no email or SMS is sent."}
                    </span>
                  </span>
                </label>
              </div>
              {!canSend && <p className="text-sm text-destructive">Please select at least one delivery option.</p>}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-primary/5 border border-primary/20 text-sm">
                {recipientMode === "practice" ? (
                  <>
                    <span className="font-semibold text-primary">{selectedCount}</span>
                    <span>practice email{selectedCount !== 1 ? "s" : ""}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="font-semibold text-primary">{documentCount}</span>
                    <span>statement PDF{documentCount !== 1 ? "s" : ""}</span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-primary">{selectedCount}</span>
                    <span>statement{selectedCount !== 1 ? "s" : ""} will be generated</span>
                    <span className="text-muted-foreground text-xs">({selectedCount} {selectedCount === 1 ? recipientNoun : recipientNounPlural})</span>
                  </>
                )}
              </div>
              <div className="grid gap-2 rounded-md border border-border px-3 py-2.5 sm:grid-cols-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Statement label</div>
                  <div className="mt-0.5 text-sm">{stmtPeriodLabel.trim() || "—"}</div>
                </div>
                {scope === "open_as_of" && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Invoice cutoff</div>
                    <div className="mt-0.5 text-sm">{formatStatementCutoffDate(customAsOf)}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      Includes open invoices issued on or before this date.
                    </div>
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {recipientMode === "practice"
                  ? <>Review each practice's recipients and the doctor statements attached to its email, then confirm to send. Use <Eye size={12} className="inline" /> to preview an individual PDF before sending.</>
                  : <>Review the {recipientNounPlural} to be contacted, then confirm to send. Use <Eye size={12} className="inline" /> to preview a PDF before sending.</>}
              </p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-secondary/40 border-b border-border">
                      <th className="text-left px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium capitalize">{recipientNoun}</th>
                      {emailEnabled && <th className="text-left px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{recipientMode === "practice" ? "Recipients" : "Email"}</th>}
                      {smsEnabled && <th className="text-left px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Phone</th>}
                      <th className="text-right px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Open balance</th>
                      <th className="w-8 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRecipients.map((r) => {
                      const attachments = recipientMode === "practice" ? selectedDoctorsFor(r) : [];
                      const sendRecipients = recipientMode === "practice" ? recipientEmailsFor(r) : [];
                      return (
                      <Fragment key={r.key}>
                        <tr className="border-t border-border">
                          <td className="px-4 py-2 font-medium text-sm">{r.name}</td>
                          {emailEnabled && recipientMode === "practice" && (
                            <td className="px-3 py-2 align-top">
                              <div className="flex flex-wrap items-center gap-1">
                                {sendRecipients.map((address) => (
                                  <span
                                    key={address}
                                    className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-foreground"
                                  >
                                    <span className="truncate max-w-[180px]">{address}</span>
                                    <button
                                      type="button"
                                      aria-label={`Remove ${address} from ${r.name}`}
                                      title="Remove for this send"
                                      onClick={() => removeRecipientEmail(r.key, address)}
                                      className="text-muted-foreground hover:text-destructive"
                                    >
                                      <X size={10} />
                                    </button>
                                  </span>
                                ))}
                                {sendRecipients.length === 0 && (
                                  <span className="text-[11px] text-warning">No recipients — this practice will be skipped.</span>
                                )}
                                {recipientDraft?.key === r.key ? (
                                  <span className="inline-flex items-center gap-1">
                                    <input
                                      type="email"
                                      autoFocus
                                      aria-label={`Add recipient for ${r.name}`}
                                      value={recipientDraft.value}
                                      onChange={(ev) => { setRecipientDraft({ key: r.key, value: ev.target.value }); setRecipientDraftError(null); }}
                                      onKeyDown={(ev) => {
                                        if (ev.key === "Enter") { ev.preventDefault(); addRecipientEmail(r.key, recipientDraft.value); }
                                        if (ev.key === "Escape") { setRecipientDraft(null); setRecipientDraftError(null); }
                                      }}
                                      placeholder="name@practice.com"
                                      className="h-6 w-44 px-2 rounded bg-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => addRecipientEmail(r.key, recipientDraft.value)}
                                      className="h-6 px-2 rounded bg-primary text-primary-foreground text-[11px] font-medium"
                                    >
                                      Add
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => { setRecipientDraft(null); setRecipientDraftError(null); }}
                                      className="h-6 px-1.5 rounded text-[11px] text-muted-foreground hover:bg-secondary"
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => { setRecipientDraft({ key: r.key, value: "" }); setRecipientDraftError(null); }}
                                    className="text-[11px] text-primary hover:underline"
                                  >
                                    + Add email
                                  </button>
                                )}
                              </div>
                              {recipientDraft?.key === r.key && recipientDraftError && (
                                <div className="mt-1 text-[11px] text-destructive">{recipientDraftError}</div>
                              )}
                              <div className="mt-1 text-[10px] text-muted-foreground">
                                Used for this send only — saved practice contacts are not changed.
                              </div>
                            </td>
                          )}
                          {emailEnabled && recipientMode !== "practice" && (
                            <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[160px]">
                              {r.email ? r.email : (
                                <button
                                  type="button"
                                  onClick={() => setInlineEdit({ key: r.key, field: "email", value: "" })}
                                  className="text-warning hover:underline underline-offset-2 cursor-pointer"
                                >
                                  No email
                                </button>
                              )}
                            </td>
                          )}
                          {smsEnabled && (
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {r.phone || <span className="text-warning">No phone</span>}
                            </td>
                          )}
                          <td className="px-4 py-2 text-right tabular-nums text-sm font-medium">
                            {formatMoney(r.openBalance)}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {recipientMode !== "practice" && (
                              <button
                                type="button"
                                title="Preview PDF"
                                disabled={previewingKey === r.key}
                                onClick={() => handlePreviewPdf(r.key)}
                                className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-40"
                              >
                                {previewingKey === r.key
                                  ? <Loader2 size={13} className="animate-spin" />
                                  : <Eye size={13} />}
                              </button>
                            )}
                          </td>
                        </tr>
                        {recipientMode === "practice" && (
                          <tr className="bg-secondary/10">
                            <td colSpan={1 + (emailEnabled ? 1 : 0) + (smsEnabled ? 1 : 0) + 2} className="px-4 pb-2.5 pt-0">
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                                {Math.max(attachments.length, 1)} statement PDF{Math.max(attachments.length, 1) !== 1 ? "s" : ""} attached
                              </div>
                              {attachments.length === 0 ? (
                                // No doctor breakdown available for this practice
                                // (e.g. every in-scope invoice is unassigned):
                                // the bundle still carries one statement PDF.
                                <ul className="mt-1 space-y-0.5">
                                  <li className="flex items-center gap-2 text-xs">
                                    <span className="flex-1 min-w-0 truncate">{r.name}</span>
                                    <span className="text-[10px] text-muted-foreground shrink-0">{r.invoiceCount} inv</span>
                                    <button
                                      type="button"
                                      title="Preview PDF"
                                      disabled={previewingKey === r.key}
                                      onClick={() => handlePreviewPdf(r.key)}
                                      className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-40 shrink-0"
                                    >
                                      {previewingKey === r.key
                                        ? <Loader2 size={12} className="animate-spin" />
                                        : <Eye size={12} />}
                                    </button>
                                  </li>
                                </ul>
                              ) : (
                                <ul className="mt-1 space-y-0.5">
                                  {attachments.map((doc) => {
                                    const docPreviewKey = `${r.key}::${doc.key}`;
                                    return (
                                      <li key={doc.key} className="flex items-center gap-2 text-xs">
                                        <span className="flex-1 min-w-0 truncate">{doc.name}</span>
                                        {typeof doc.invoiceCount === "number" && (
                                          <span className="text-[10px] text-muted-foreground shrink-0">{doc.invoiceCount} inv</span>
                                        )}
                                        {typeof doc.openBalance === "number" && (
                                          <span className="tabular-nums text-[11px] text-muted-foreground shrink-0">{formatMoney(doc.openBalance)}</span>
                                        )}
                                        <button
                                          type="button"
                                          title={`Preview ${doc.name} statement`}
                                          aria-label={`Preview ${doc.name} statement`}
                                          disabled={previewingKey === docPreviewKey}
                                          onClick={() => handlePreviewPdf(r.key, doc.key)}
                                          className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-40 shrink-0"
                                        >
                                          {previewingKey === docPreviewKey
                                            ? <Loader2 size={12} className="animate-spin" />
                                            : <Eye size={12} />}
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </td>
                          </tr>
                        )}
                        {inlineEdit?.key === r.key && (
                          <tr className="border-t border-border bg-card">
                            <td colSpan={2 + (smsEnabled ? 1 : 0) + 1}>
                              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                                <span className="text-xs text-muted-foreground shrink-0">Email:</span>
                                <input
                                  type="email"
                                  value={inlineEdit.value}
                                  autoFocus
                                  onChange={(ev) => setInlineEdit((prev) => prev ? { ...prev, value: ev.target.value } : null)}
                                  onKeyDown={(ev) => { if (ev.key === "Enter") handleInlineEditSave(); if (ev.key === "Escape") setInlineEdit(null); }}
                                  placeholder="billing@practice.com"
                                  className="flex-1 min-w-[160px] h-7 px-2 rounded bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                                />
                                <button
                                  type="button"
                                  onClick={handleInlineEditSave}
                                  disabled={inlineEditSaving || !inlineEdit.value.trim()}
                                  className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                                >
                                  {inlineEditSaving ? <Loader2 size={11} className="animate-spin" /> : "Save"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setInlineEdit(null)}
                                  className="h-7 px-2 rounded text-xs text-muted-foreground hover:bg-secondary shrink-0"
                                >
                                  Cancel
                                </button>
                                {inlineEditError && <span className="text-xs text-destructive w-full">{inlineEditError}</span>}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {previewError && (
                <div className="text-xs text-destructive border border-destructive/30 bg-destructive/10 rounded-md px-3 py-2">
                  Preview failed: {previewError}
                </div>
              )}
              {emailEnabled && (
                <div className="border-t border-border pt-4 space-y-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Email message (optional overrides)</div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Subject</label>
                    <input aria-label="Email subject" type="text" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder={DEFAULT_STATEMENT_SUBJECT} className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Header line</label>
                    <input type="text" value={emailHeader} onChange={(e) => setEmailHeader(e.target.value)} placeholder="Optional heading shown above the message" className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Message body</label>
                    <textarea aria-label="Message body" value={emailBody} onChange={(e) => { setEmailBody(e.target.value); setEmailBodyCustomized(true); }} rows={5} placeholder={defaultStatementBody(recipientMode)} className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y font-mono" />
                    <p className="text-[11px] text-muted-foreground mt-1">Pre-filled from your saved default (Settings → Templates → Statement email). Placeholders: <code>{"{{practiceName}}"}</code>, <code>{"{{doctorName}}"}</code>, <code>{"{{labName}}"}</code>, <code>{"{{periodLabel}}"}</code>, <code>{"{{openBalance}}"}</code>.</p>
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Reply-to address</label>
                    <input type="email" value={emailReplyTo} onChange={(e) => setEmailReplyTo(e.target.value)} placeholder="replies@yourlab.com" className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                  </div>
                </div>
              )}
              {sendError && <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded-md p-2.5">{sendError}</div>}
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              {results ? (
                <>
                  <div className="text-sm font-medium">Statements sent for <span className="text-primary">{resultPeriodLabel || stmtPeriodLabel}</span></div>
                  <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-secondary/40 border-b border-border">
                          <th className="text-left px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{recipientNoun === "doctor" ? "Doctor" : "Practice"}</th>
                          {emailEnabled && <th className="text-center px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Email</th>}
                          {smsEnabled && <th className="text-center px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">SMS</th>}
                          {downloadEnabled && <th className="text-center px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Download</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r) => (
                          <Fragment key={r.practiceId}>
                            <tr className="border-t border-border">
                              <td className="px-4 py-2.5 font-medium text-sm">{r.practiceName}</td>
                              {emailEnabled && (
                                <td className="px-3 py-2.5 text-center">
                                  {r.emailStatus === "skipped" ? (
                                    <div className="inline-flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => setInlineEdit({ key: r.practiceId, field: "email", value: "" })}
                                        className="text-[11px] text-warning cursor-pointer hover:underline underline-offset-2"
                                        title={r.emailError ?? "Skipped"}
                                      >
                                        Skipped
                                      </button>
                                      {readyToResendIds.has(r.practiceId) && (
                                        <button
                                          type="button"
                                          onClick={() => handleSendNow(r.practiceId)}
                                          disabled={sending}
                                          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium border border-border hover:bg-secondary disabled:opacity-50"
                                        >
                                          {sending ? <Loader2 size={10} className="animate-spin" /> : "Send now"}
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <BatchStatusBadge status={r.emailStatus} error={r.emailError} />
                                  )}
                                </td>
                              )}
                              {smsEnabled && <td className="px-3 py-2.5 text-center"><BatchStatusBadge status={r.smsStatus} error={r.smsError} /></td>}
                              {downloadEnabled && <td className="px-3 py-2.5 text-center"><BatchStatusBadge status={r.downloadStatus ?? null} error={r.downloadError ?? null} /></td>}
                            </tr>
                            {inlineEdit?.key === r.practiceId && (
                              <tr className="border-t border-border bg-card">
                                <td colSpan={1 + (emailEnabled ? 1 : 0) + (smsEnabled ? 1 : 0) + (downloadEnabled ? 1 : 0)}>
                                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                                    <span className="text-xs text-muted-foreground shrink-0">Email:</span>
                                    <input
                                      type="email"
                                      value={inlineEdit.value}
                                      aria-label={`Recipient email for ${r.practiceName}`}
                                      autoFocus
                                      onChange={(ev) => setInlineEdit((prev) => prev ? { ...prev, value: ev.target.value } : null)}
                                      onKeyDown={(ev) => { if (ev.key === "Enter") handleInlineEditSave(); if (ev.key === "Escape") setInlineEdit(null); }}
                                      placeholder="billing@practice.com"
                                      className="flex-1 min-w-[160px] h-7 px-2 rounded bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                                    />
                                    <button
                                      type="button"
                                      onClick={handleInlineEditSave}
                                      disabled={inlineEditSaving || !inlineEdit.value.trim()}
                                      className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                                    >
                                      {inlineEditSaving ? <Loader2 size={11} className="animate-spin" /> : "Save"}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setInlineEdit(null)}
                                      className="h-7 px-2 rounded text-xs text-muted-foreground hover:bg-secondary shrink-0"
                                    >
                                      Cancel
                                    </button>
                                    <span className="text-[11px] text-muted-foreground w-full">
                                      {isPerSendRecipientEdit(r.practiceId, "email")
                                        ? "Added to this send's recipients only — saved contacts are unchanged."
                                        : "Saved to this practice's billing contact."}
                                    </span>
                                    {inlineEditError && <span className="text-xs text-destructive w-full">{inlineEditError}</span>}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-muted-foreground flex gap-4">
                      <span className="text-success font-medium">{results.filter((r) => r.emailStatus === "sent" || r.smsStatus === "sent" || r.downloadStatus === "sent").length} delivered</span>
                      <span className="text-warning">{results.filter((r) => (r.emailStatus === "skipped" || r.smsStatus === "skipped") && r.emailStatus !== "sent" && r.smsStatus !== "sent" && r.downloadStatus !== "sent").length} skipped</span>
                      <span className="text-destructive">{results.filter((r) => r.emailStatus === "failed" || r.smsStatus === "failed" || r.downloadStatus === "failed").length} failed</span>
                    </div>
                    {results.some((r) => r.emailStatus === "failed" || r.smsStatus === "failed") && (
                      <button
                        type="button"
                        onClick={handleRetryFailed}
                        disabled={sending}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border border-border hover:bg-secondary disabled:opacity-50"
                      >
                        {sending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        Retry failed
                      </button>
                    )}
                  </div>
                  {sendError && <div className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded-md p-2.5">{sendError}</div>}
                </>
              ) : downloadEnabled ? (
                <div className="py-8 text-center">
                  <Download size={28} className="mx-auto mb-2 text-success" />
                  <p className="text-sm font-medium">ZIP downloaded.</p>
                  <p className="text-xs text-muted-foreground mt-1">Check your downloads folder.</p>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between px-5 py-3 border-t border-border bg-secondary/30 rounded-b-xl shrink-0">
          <button
            type="button"
            onClick={() => {
              if (step === 5 || step === 1) onClose();
              else setStep((s) => (s - 1) as 1 | 2 | 3 | 4);
            }}
            className="h-9 px-3 rounded-md text-sm font-medium hover:bg-secondary"
          >
            {step === 5 ? "Close" : step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 4 && (
            <button
              type="button"
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3 | 4 | 5)}
              disabled={(step === 1 && !customReady) || (step === 2 && selectedCount === 0)}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              Next
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !canSend || selectedCount === 0}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {sending ? <><Loader2 size={14} className="animate-spin" /> Generating…</> : <><Send size={14} /> Generate & Send</>}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function DeliveryStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    sent: { label: "Delivered", cls: "bg-success/15 text-success" },
    failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
    skipped_no_email: { label: "No email", cls: "bg-warning/20 text-warning" },
  };
  const m = map[status] || { label: "Pending", cls: "bg-secondary text-muted-foreground" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    sent: { label: "Sent", cls: "bg-success/15 text-success" },
    failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
    skipped_no_email: { label: "Skipped", cls: "bg-warning/20 text-warning" },
  };
  const m = map[status] || { label: status, cls: "bg-secondary text-foreground" };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

function describeFilters({ search, agingFilter }: { search: string; agingFilter: "all" | "open" | "overdue" }): string {
  const parts: string[] = [];
  if (search.trim()) parts.push(`search: "${search.trim()}"`);
  parts.push(
    agingFilter === "all" ? "all practices" : agingFilter === "open" ? "with open balance" : "overdue only",
  );
  return `Filters: ${parts.join(" · ")}`;
}

function StatsDrillPanel({
  activeCard,
  orgId,
  statementRuns,
  onClose,
}: {
  activeCard: "billed" | "collected" | "open" | "overdue";
  orgId: string;
  statementRuns: StatementSendRun[];
  onClose: () => void;
}) {
  const paymentsQuery = useQuery({
    queryKey: ["payments-summary", orgId],
    queryFn: () =>
      apiFetch<PaymentSummaryRow[]>(
        `/invoices/payments-summary?labOrganizationId=${orgId}`,
      ),
    enabled: activeCard === "collected",
    staleTime: 60_000,
  });
  const drillParams =
    activeCard === "billed"
      ? "aging=all&sort=totalBilled&sortDir=desc"
      : activeCard === "open"
        ? "aging=open&sort=totalOpenBalance&sortDir=desc"
        : "aging=overdue&sort=overdueBalance&sortDir=desc";
  // The breakdown is batched like the main table: the 10 biggest balances
  // first, then Load more walks down the list. Loading every practice up
  // front is what this task removed from the page.
  const [drillCursor, setDrillCursor] = useState<string | null>(null);
  const [loadedDrill, setLoadedDrill] = useState<{
    key: string;
    rows: DrillRow[];
    total: number;
  }>({ key: "", rows: [], total: 0 });
  const [pagedDrillParams, setPagedDrillParams] = useState(drillParams);
  if (pagedDrillParams !== drillParams) {
    setPagedDrillParams(drillParams);
    setDrillCursor(null);
  }
  const drillQueryString = `${drillParams}&limit=${PAGE_SIZE}${
    drillCursor ? `&cursor=${encodeURIComponent(drillCursor)}` : ""
  }`;
  const drillRowsQuery = useQuery({
    queryKey: [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY, orgId, "drill", drillQueryString],
    queryFn: async () => {
      const query = drillQueryString;
      const requestCursor = drillCursor;
      const response = await apiFetch<StatementSummaryPage | StatementRow[]>(
        `/lab-orgs/${orgId}/statements/account-summaries?${query}`,
      );
      const page = Array.isArray(response)
        ? {
            rows: response,
            total: response.length,
            limit: response.length,
            offset: 0,
            hasMore: false,
            nextCursor: null,
          }
        : response;
      return {
        ...page,
        query,
        requestCursor,
        rows: page.rows.map((row) => ({
          ...row,
          openBalance: row.totalOpenBalance,
          oldestOpen:
            row.unpaidStatements.find((statement) => statement.overdue)
              ?.periodEnd ?? null,
        })),
      };
    },
    enabled: activeCard !== "collected",
    staleTime: 30_000,
  });
  useEffect(() => {
    const result = drillRowsQuery.data;
    if (!result || result.query !== drillQueryString) return;
    setLoadedDrill((previous) => ({
      key: drillParams,
      rows:
        previous.key === drillParams && result.requestCursor
          ? [
              ...previous.rows.filter(
                (row) => !result.rows.some((next) => next.practiceId === row.practiceId),
              ),
              ...result.rows,
            ]
          : result.rows,
      total: result.total,
    }));
  }, [drillRowsQuery.data, drillQueryString, drillParams]);
  const atDrillParams = loadedDrill.key === drillParams;
  const rows = atDrillParams ? loadedDrill.rows : EMPTY_DRILL_ROWS;
  const drillTotal = atDrillParams ? loadedDrill.total : 0;
  const drillHasMore =
    drillRowsQuery.data?.query === drillQueryString && drillRowsQuery.data.hasMore;

  const title =
    activeCard === "billed"
      ? "Total Billed — by Practice"
      : activeCard === "collected"
        ? "Collected — Payment Detail"
        : activeCard === "open"
          ? "Open Balance — Practices with Outstanding Balance"
          : "Overdue — Unpaid Statement Balances";

  // Billed: sort by totalBilled desc
  const billedRows = useMemo(
    () => [...rows].sort((a, b) => b.totalBilled - a.totalBilled),
    [rows],
  );

  // Open balance uses the same server-owned total as the main table.
  const openRows = useMemo(
    () =>
      rows
        .filter((r) => r.totalOpenBalance > 0)
        .sort((a, b) => b.openBalance - a.openBalance),
    [rows],
  );

  // Overdue: practices with overdueBalance > 0, sorted desc
  const overdueRows = useMemo(
    () =>
      [...rows]
        .filter((r) => r.overdueBalance > 0)
        .sort((a, b) => b.overdueBalance - a.overdueBalance),
    [rows],
  );

  void statementRuns;

  return (
    <div className="bg-card border border-primary/30 rounded-xl mb-5 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
          aria-label="Close detail panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {activeCard === "billed" && (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground font-medium sticky top-0">
                <th className="text-left px-5 py-2.5">Practice</th>
                <th className="text-right py-2.5">Invoices</th>
                <th className="text-right px-5 py-2.5">Total Billed</th>
              </tr>
            </thead>
            <tbody>
              {billedRows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-muted-foreground text-sm">
                    No billing data available.
                  </td>
                </tr>
              ) : (
                billedRows.map((r) => (
                  <tr key={r.practiceId} className="border-t border-border hover:bg-secondary/30">
                    <td className="px-5 py-2.5 font-medium">{r.practiceName}</td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">{r.invoiceCount}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums font-medium">{formatMoney(r.totalBilled)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeCard === "collected" && (
          <>
            {paymentsQuery.isLoading && (
              <div className="px-5 py-8 text-center text-muted-foreground">
                <Loader2 size={16} className="inline animate-spin mr-2" />
                Loading payment records…
              </div>
            )}
            {paymentsQuery.error && (
              <div className="px-5 py-8 text-center text-destructive text-sm">
                {(paymentsQuery.error as Error).message}
              </div>
            )}
            {!paymentsQuery.isLoading && !paymentsQuery.error && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground font-medium sticky top-0">
                    <th className="text-left px-5 py-2.5">Practice</th>
                    <th className="text-left py-2.5">Invoice #</th>
                    <th className="text-right py-2.5">Amount</th>
                    <th className="text-right px-5 py-2.5">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {(paymentsQuery.data ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-8 text-center text-muted-foreground text-sm">
                        No payment records found for this lab.
                      </td>
                    </tr>
                  ) : (
                    (paymentsQuery.data ?? []).map((p) => (
                      <tr key={p.id} className="border-t border-border hover:bg-secondary/30">
                        <td className="px-5 py-2.5 font-medium">{p.practiceName}</td>
                        <td className="py-2.5 text-muted-foreground text-xs">{p.invoiceNumber ?? "—"}</td>
                        <td className="py-2.5 text-right tabular-nums text-success font-medium">
                          {formatMoney(Number(p.amount))}
                        </td>
                        <td className="px-5 py-2.5 text-right text-muted-foreground">
                          {p.paidAt ? formatDate(String(p.paidAt)) : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </>
        )}

        {activeCard === "open" && (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground font-medium sticky top-0">
                <th className="text-left px-5 py-2.5">Practice</th>
                <th className="text-right py-2.5">Open Balance</th>
                <th className="text-right px-5 py-2.5">Recent Unpaid Statement</th>
              </tr>
            </thead>
            <tbody>
              {openRows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-muted-foreground text-sm">
                    No practices with an open balance.
                  </td>
                </tr>
              ) : (
                openRows.map((r) => (
                  <tr key={r.practiceId} className="border-t border-border hover:bg-secondary/30">
                    <td className="px-5 py-2.5 font-medium">{r.practiceName}</td>
                    <td className="py-2.5 text-right tabular-nums font-medium">{formatMoney(r.openBalance)}</td>
                    <td className="px-5 py-2.5 text-right text-muted-foreground">
                      {r.unpaidStatements[0]
                        ? formatDate(r.unpaidStatements[0].date)
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeCard === "overdue" && (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground font-medium sticky top-0">
                <th className="text-left px-5 py-2.5">Practice</th>
                <th className="text-right py-2.5">Overdue Balance</th>
                <th className="text-right px-5 py-2.5">Statement Period End</th>
              </tr>
            </thead>
            <tbody>
              {overdueRows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-muted-foreground text-sm">
                    No overdue balances.
                  </td>
                </tr>
              ) : (
                overdueRows.map((r) => (
                  <tr key={r.practiceId} className="border-t border-border hover:bg-secondary/30">
                    <td className="px-5 py-2.5 font-medium">{r.practiceName}</td>
                    <td className="py-2.5 text-right tabular-nums text-destructive font-medium">
                      {formatMoney(r.overdueBalance)}
                    </td>
                    <td className="px-5 py-2.5 text-right text-muted-foreground">
                      {r.oldestOpen ? formatDate(r.oldestOpen) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        {activeCard !== "collected" && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-2.5">
            <span
              data-testid="stats-drill-loaded-count"
              className="text-xs text-muted-foreground"
            >
              Showing {rows.length} of {drillTotal}
            </span>
            {drillHasMore && (
              <button
                type="button"
                data-testid="stats-drill-load-more"
                onClick={() => setDrillCursor(drillRowsQuery.data?.nextCursor ?? null)}
                disabled={drillRowsQuery.isFetching}
                className="h-7 rounded-md bg-secondary px-3 text-xs font-medium disabled:opacity-50"
              >
                {drillRowsQuery.isFetching ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function Stat({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: string;
  tone: "primary" | "success" | "warning" | "neutral";
  active?: boolean;
  onClick?: () => void;
}) {
  const iconCls =
    tone === "success"
      ? "bg-success/15 text-success"
      : tone === "warning"
        ? "bg-warning/20 text-warning"
        : tone === "primary"
          ? "bg-primary/10 text-primary"
          : "bg-secondary text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`bg-card border rounded-xl p-4 text-left w-full transition-all ${
        active
          ? "border-primary ring-1 ring-primary/30"
          : "border-border hover:border-primary/40"
      } ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
          <div className="mt-1.5 text-xl font-semibold tabular-nums">{value}</div>
        </div>
        <div className={`h-8 w-8 rounded-md flex items-center justify-center ${iconCls}`}>
          <Receipt size={14} />
        </div>
      </div>
    </button>
  );
}

function StatementDrawer({
  row,
  practice,
  filtersDescription,
  onClose,
}: {
  row: StatementRow;
  practice: Organization | null;
  filtersDescription?: string;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const [orgId] = useSelectedOrg();
  const labOrgsQuery = useLabOrganizations();
  const labOrg = labOrgsQuery.data?.find((o) => o.id === orgId);
  const labName = (labOrg as any)?.displayName || (labOrg as any)?.name || "";
  const practicesQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });
  const effectivePractice =
    practice ??
    practicesQuery.data?.find((organization) => organization.id === row.practiceId) ??
    null;
  const invoicesQuery = useQuery({
    queryKey: [...FINANCE_INVOICES_QUERY_KEY, "statement-practice", row.practiceId],
    queryFn: () =>
      apiFetch<Invoice[]>(
        `/invoices?practiceId=${encodeURIComponent(row.practiceId)}`,
      ),
  });

  const sorted = (invoicesQuery.data ?? [])
    // Older servers and test fixtures may ignore practiceId, so retain the
    // same client-side scope guard the former full-list implementation used.
    .filter((invoice) => invoice.providerOrganizationId === row.practiceId)
    .sort((a, b) =>
      (b.issuedAt || b.createdAt || "").localeCompare(a.issuedAt || a.createdAt || ""),
    );

  const [emailOpen, setEmailOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<"all" | "open" | "paid" | "overdue">("all");
  const [expandedInvId, setExpandedInvId] = useState<string | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [emailingInvoice, setEmailingInvoice] = useState<Invoice | null>(null);
  const [printingInvId, setPrintingInvId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["statement-runs", orgId],
    queryFn: () => apiFetch<StatementSendRun[]>(`/lab-orgs/${orgId}/statement-runs`),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  const practiceRuns = (runsQuery.data ?? [])
    .filter((r) => r.practiceOrganizationId === row.practiceId)
    .slice(0, 10);

  const filteredInvoices = useMemo(() => {
    switch (activeFilter) {
      case "open":
        return sorted.filter((i) => ["open", "partially_paid"].includes(i.status));
      case "paid":
        return sorted.filter((i) => i.status === "paid");
      case "overdue":
        return sorted.filter((i) => isInvoicePastDue(i));
      default:
        return sorted;
    }
  }, [sorted, activeFilter]);

  function toggleFilter(f: typeof activeFilter) {
    setActiveFilter((prev) => (prev === f ? "all" : f));
    setExpandedInvId(null);
  }

  function buildPdfOptions() {
    return {
      practiceName: row.practiceName,
      generatedAt: new Date(),
      filtersDescription,
      totals: {
        billed: row.totalBilled,
        paid: row.totalPaid,
        open: row.openBalance,
        overdue: row.overdueBalance,
      },
      invoices: sorted.map((i) => {
        const meta = (i as any).displayMetadata ?? (i as any).displayMetadataJson ?? null;
        return {
          invoiceNumber: i.invoiceNumber,
          issuedAt: formatDate(i.issuedAt),
          dueAt: formatDate((i as any).dueAt ?? (i as any).dueDate),
          status: statusLabel(i.status),
          total: String(i.total ?? 0),
          balanceDue: String(i.balanceDue ?? 0),
          patientName: meta?.patientName ?? null,
          billTo: meta?.billTo ?? null,
        };
      }),
    };
  }

  async function handlePrintInvoice(inv: Invoice) {
    setPrintingInvId(inv.id);
    try {
      const detail = await apiFetch<any>(`/invoices/${inv.id}`);
      const meta = detail.displayMetadata ?? detail.displayMetadataJson ?? null;
      const lineItems: Array<any> = detail.lineItems ?? detail.items ?? [];
      const subtotal = lineItems.reduce(
        (s: number, it: any) =>
          s + Number(it.quantity || 0) * Number(it.unitPrice ?? it.unit_price ?? 0),
        0,
      );
      printInvoicePdf({
        invoiceNumber: detail.invoiceNumber,
        labName,
        practiceName: row.practiceName,
        patientName: meta?.patientName ?? null,
        billTo: meta?.billTo ?? null,
        teeth: meta?.teeth ?? null,
        shade: meta?.shade ?? null,
        caseNotes: meta?.caseNotes ?? null,
        issuedAt: detail.issuedAt ?? null,
        dueAt: detail.dueAt ?? detail.dueDate ?? null,
        status: statusLabel(detail.status),
        items: lineItems.map((it: any) => ({
          item: it.item ?? it.description ?? "",
          description: it.description ?? "",
          quantity: Number(it.quantity || 0),
          unitPrice: Number(it.unitPrice ?? it.unit_price ?? 0),
          lineTotal:
            Number(it.quantity || 0) * Number(it.unitPrice ?? it.unit_price ?? 0),
        })),
        subtotal,
        tax: detail.tax ?? null,
        discount: detail.discount ?? null,
        credits: detail.credits ?? null,
        total: detail.total ?? 0,
        balanceDue: detail.balanceDue ?? null,
        notes: detail.notes ?? null,
        generatedAt: new Date(),
      });
    } catch {
      // silently ignore — user will see no print dialog
    } finally {
      setPrintingInvId(null);
    }
  }

  async function exportPdf() {
    if (!orgId) return;
    await previewStatementPdf(
      orgId,
      {
        recipientType: "practice",
        recipientKey: row.practiceId,
        invoiceScope: "all",
        from: null,
        to: null,
        asOf: null,
        periodLabel: filtersDescription ?? null,
        invoiceIds: sorted.map((invoice) => invoice.id),
      },
      `statement-${safeFilename(row.practiceName)}-${new Date().toISOString().slice(0, 10)}.pdf`,
    );
  }

  function exportCsv() {
    const filename = `statement-${safeFilename(row.practiceName)}-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadCsv(
      filename,
      sorted.map((i) => ({
        Invoice: i.invoiceNumber,
        Issued: formatDate(i.issuedAt),
        Due: formatDate((i as any).dueAt ?? (i as any).dueDate),
        Status: statusLabel(i.status),
        Total: Number(i.total ?? 0).toFixed(2),
        "Balance due": Number(i.balanceDue ?? 0).toFixed(2),
        Practice: row.practiceName,
        Filters: filtersDescription ?? "",
      })),
    );
  }

  const filterLabel =
    activeFilter === "open"
      ? "Open"
      : activeFilter === "paid"
        ? "Paid"
        : activeFilter === "overdue"
          ? "Overdue"
          : null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[640px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Statement</div>
            <div className="text-sm font-semibold">{row.practiceName}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              type="button"
              onClick={exportCsv}
              disabled={sorted.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Download size={13} /> CSV
            </button>
            <button
              type="button"
              onClick={exportPdf}
              disabled={sorted.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Download size={13} /> PDF
            </button>
            <button
              type="button"
              onClick={() => setTextOpen(true)}
              disabled={sorted.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium hover:bg-secondary border border-border disabled:opacity-50"
            >
              <MessageSquare size={13} /> Text statement
            </button>
            <button
              type="button"
              onClick={async () => {
                // Resolve the practice display/contact record before opening so
                // templates retain their pre-batching display-name behavior.
                await practicesQuery.refetch();
                setEmailOpen(true);
              }}
              disabled={sorted.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Mail size={13} /> Email statement
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Summary cards — click to filter invoice list */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Billed"
              value={formatMoney(row.totalBilled)}
              tone="neutral"
              active={activeFilter === "all"}
              onClick={() => toggleFilter("all")}
            />
            <Stat
              label="Open"
              value={formatMoney(row.openBalance)}
              tone="primary"
              active={activeFilter === "open"}
              onClick={() => toggleFilter("open")}
            />
            <Stat
              label="Paid"
              value={formatMoney(row.totalPaid)}
              tone="success"
              active={activeFilter === "paid"}
              onClick={() => toggleFilter("paid")}
            />
            <Stat
              label="Overdue"
              value={formatMoney(row.overdueBalance)}
              tone={row.overdueBalance > 0 ? "warning" : "neutral"}
              active={activeFilter === "overdue"}
              onClick={() => toggleFilter("overdue")}
            />
          </div>

          {/* Invoice list */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Invoices
                {filterLabel && (
                  <span className="ml-1.5 normal-case font-normal text-foreground/60">
                    — {filterLabel} only
                  </span>
                )}
              </h3>
              {filterLabel && (
                <button
                  type="button"
                  onClick={() => toggleFilter("all")}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <X size={11} /> Clear filter
                </button>
              )}
            </div>
            <div className="border border-border rounded-md divide-y divide-border">
              {filteredInvoices.map((inv) => (
                <div key={inv.id}>
                  {/* Clickable invoice row */}
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedInvId((prev) => (prev === inv.id ? null : inv.id))
                    }
                    className="w-full px-3 py-2.5 flex items-center justify-between text-sm hover:bg-secondary/40 transition-colors text-left"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-medium">{inv.invoiceNumber}</div>
                      <div className="text-xs text-muted-foreground">
                        Issued {formatDate(inv.issuedAt)} · Due{" "}
                        {formatDate((inv as any).dueAt ?? (inv as any).dueDate)}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={inv.status} />
                      <div className="text-right">
                        <div className="font-medium tabular-nums">{formatMoney(inv.total)}</div>
                        {Number(inv.balanceDue ?? 0) > 0 && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {formatMoney(inv.balanceDue)} open
                          </div>
                        )}
                      </div>
                      <ChevronDown
                        size={14}
                        className={`text-muted-foreground shrink-0 transition-transform duration-150 ${
                          expandedInvId === inv.id ? "rotate-180" : ""
                        }`}
                      />
                    </div>
                  </button>

                  {/* Inline action bar */}
                  {expandedInvId === inv.id && (
                    <div className="px-3 py-2.5 bg-secondary/30 border-t border-border flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingInvoice(inv);
                          setExpandedInvId(null);
                        }}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium hover:bg-secondary border border-border bg-card"
                      >
                        <Eye size={12} /> View / Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePrintInvoice(inv)}
                        disabled={printingInvId === inv.id}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium hover:bg-secondary border border-border bg-card disabled:opacity-50"
                      >
                        {printingInvId === inv.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Printer size={12} />
                        )}
                        Print
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEmailingInvoice(inv);
                          setExpandedInvId(null);
                        }}
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium hover:bg-secondary border border-border bg-card"
                      >
                        <Mail size={12} /> Email
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {filteredInvoices.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {sorted.length === 0 ? "No invoices." : "No invoices match this filter."}
                </div>
              )}
            </div>
          </section>

          {/* Statements sent history */}
          <section>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
              <History size={12} /> Statements sent
            </h3>
            {runsQuery.isLoading ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : practiceRuns.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground border border-border rounded-md">
                No statements sent yet.
              </div>
            ) : (
              <div className="border border-border rounded-md divide-y divide-border">
                {practiceRuns.map((r) => {
                  const isOk = r.status === "sent";
                  const isFail = r.status === "failed";
                  const isSkipped = r.status.startsWith("skipped");
                  const channelIcon = r.practiceEmail ? "email" : "sms";
                  const date = r.lastAttemptAt ?? r.createdAt;
                  return (
                    <div key={r.id} className="px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={
                              isOk
                                ? "text-emerald-600 font-medium"
                                : isFail
                                  ? "text-destructive font-medium"
                                  : "text-muted-foreground font-medium"
                            }
                          >
                            {isOk ? "Sent" : isFail ? "Failed" : "Skipped"}
                          </span>
                          <span className="text-muted-foreground truncate">
                            {r.periodMonth || "—"}
                          </span>
                          {channelIcon === "email" ? (
                            <Mail size={11} className="text-muted-foreground shrink-0" />
                          ) : (
                            <MessageSquare size={11} className="text-muted-foreground shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0 text-muted-foreground">
                          <span className="tabular-nums">{formatMoney(Number(r.openBalance ?? 0))}</span>
                          <span className="flex items-center gap-1">
                            <CalendarClock size={11} />
                            {date ? formatDate(date) : "—"}
                          </span>
                        </div>
                      </div>
                      {isFail && r.errorMessage && (
                        <div className="mt-0.5 text-destructive/80 truncate">{r.errorMessage}</div>
                      )}
                      {isSkipped && (
                        <div className="mt-0.5 text-muted-foreground">No contact info on file</div>
                      )}
                      <div className="mt-0.5 text-muted-foreground/60">
                        {r.invoiceCount} invoice{r.invoiceCount !== 1 ? "s" : ""} · by {r.triggeredBy}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </aside>

      {emailOpen && effectivePractice && (
        <EmailStatementDialog
          row={row}
          invoices={sorted}
          practice={effectivePractice}
          labName={labName}
          onClose={() => setEmailOpen(false)}
        />
      )}
      {textOpen && (
        <TextStatementDialog
          row={row}
          invoices={sorted}
          practice={effectivePractice}
          onClose={() => setTextOpen(false)}
        />
      )}
      {editingInvoice && (
        <InvoiceEditor
          invoice={editingInvoice}
          onClose={() => setEditingInvoice(null)}
          onGoToCase={
            editingInvoice.caseId
              ? () => {
                  const caseId = editingInvoice.caseId!;
                  setEditingInvoice(null);
                  setLocation(`/cases?caseId=${encodeURIComponent(caseId)}`);
                }
              : () => setEditingInvoice(null)
          }
        />
      )}
      {emailingInvoice && (
        <SendInvoiceFromStatementDialog
          invoice={emailingInvoice}
          practiceName={row.practiceName}
          practice={practice}
          labName={labName}
          onClose={() => setEmailingInvoice(null)}
        />
      )}
    </div>
  );
}

function EmailStatementDialog({
  row,
  invoices,
  practice,
  labName,
  onClose,
}: {
  row: StatementRow;
  invoices: Invoice[];
  practice: Organization | null;
  labName: string;
  onClose: () => void;
}) {
  const labOrganizationId = invoices[0]?.labOrganizationId ?? "";
  const defaultEmail = (practice?.billingEmail ?? "").trim();
  const practiceName = practice?.displayName || practice?.name || row.practiceName;
  const periodLabel = (() => { const _d = new Date(); return `${String(_d.getMonth() + 1).padStart(2, "0")}/${_d.getFullYear()}`; })();
  const selectedTotals = useMemo(
    () =>
      invoices.reduce(
        (totals, invoice) => {
          totals.totalBilled += Number(invoice.total ?? 0);
          if (invoice.status !== "void") {
            totals.openBalance += Number(invoice.balanceDue ?? 0);
          }
          return totals;
        },
        { totalBilled: 0, openBalance: 0 },
      ),
    [invoices],
  );
  const templateVars = useMemo<Record<string, string>>(
    () => ({
      practiceName,
      labName,
      periodLabel,
      openBalance: formatMoney(selectedTotals.openBalance),
      totalBilled: formatMoney(selectedTotals.totalBilled),
    }),
    [
      labName,
      periodLabel,
      practiceName,
      selectedTotals.openBalance,
      selectedTotals.totalBilled,
    ],
  );
  const defaultSubject = renderTemplate(DEFAULT_STATEMENT_SUBJECT, templateVars);
  const defaultMessage = renderTemplate(DEFAULT_STATEMENT_BODY_PRACTICE, templateVars);

  const [to, setTo] = useState(defaultEmail);
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState(defaultMessage);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const templateApplied = useRef(false);

  const scheduleQuery = useQuery<StatementSchedule>({
    queryKey: ["statement-schedule", labOrganizationId],
    queryFn: () =>
      apiFetch(`/lab-orgs/${labOrganizationId}/statement-schedule`),
    enabled: !!labOrganizationId,
    staleTime: 5 * 60 * 1000,
  });
  const emailTemplateQuery = useQuery<{
    emailSubject: string | null;
    emailBody: string | null;
    emailReplyTo: string | null;
  }>({
    queryKey: ["admin", "templates", "statement-email"],
    queryFn: () => apiFetch("/admin/templates/statement-email"),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (
      templateApplied.current ||
      !scheduleQuery.data ||
      emailTemplateQuery.isLoading
    ) {
      return;
    }
    templateApplied.current = true;
    setSubject(
      renderTemplate(
        scheduleQuery.data.emailSubject?.trim() ||
          emailTemplateQuery.data?.emailSubject?.trim() ||
          DEFAULT_STATEMENT_SUBJECT,
        templateVars,
      ),
    );
    setMessage(
      renderTemplate(
        scheduleQuery.data.emailBody?.trim() ||
          emailTemplateQuery.data?.emailBody?.trim() ||
          DEFAULT_STATEMENT_BODY_PRACTICE,
        templateVars,
      ),
    );
  }, [
    emailTemplateQuery.data,
    emailTemplateQuery.isLoading,
    scheduleQuery.data,
    templateVars,
  ]);

  async function send() {
    setError(null);
    if (!labOrganizationId) {
      setError("Could not determine your lab organization.");
      return;
    }
    setSending(true);
    try {
      const filename = `statement-${safeFilename(row.practiceName)}-${new Date().toISOString().slice(0, 10)}.pdf`;
      const trimmedTo = to.trim();
      const res = await apiFetch<{ sentAt: string; to: string; invoiceCount: number }>(
        "/invoices/statements/email",
        {
          method: "POST",
          body: JSON.stringify({
            labOrganizationId,
            practiceOrganizationId: row.practiceId,
            invoiceIds: invoices.map((i) => i.id),
            ...(trimmedTo ? { to: trimmedTo } : {}),
            subject: subject.trim(),
            message,
            filename,
          }),
        },
      );
      setSentAt(res.sentAt);
      setTo(res.to);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error)?.message || "Failed to send.";
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
            <div className="text-xs text-muted-foreground">Email statement</div>
            <div className="text-sm font-semibold">{row.practiceName}</div>
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
              <div className="font-medium text-success">Statement sent.</div>
              <div className="text-xs text-muted-foreground mt-1">
                Delivered to {to} at {formatDateTime(sentAt)}.
              </div>
            </div>
          ) : (
            <>
              <Field label="To">
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={defaultEmail || "Leave blank to use the practice's billing email on file"}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {defaultEmail
                    ? "Pre-filled from this practice's billing contact. Edit to override for this send only."
                    : "Leave blank to use the practice's billing email on file. If none is on file, the server will let you know — enter an address here to override just for this send."}
                </p>
              </Field>
              <Field label="Subject">
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </Field>
              <Field label="Message">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={8}
                  className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y"
                />
              </Field>
              <div className="text-xs text-muted-foreground">
                The current statement PDF ({invoices.length} invoice{invoices.length === 1 ? "" : "s"}) will be attached.
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
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
              {sending ? "Sending…" : "Send email"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function TextStatementDialog({
  row,
  invoices,
  practice,
  onClose,
}: {
  row: StatementRow;
  invoices: Invoice[];
  practice: Organization | null;
  onClose: () => void;
}) {
  const labOrganizationId = invoices[0]?.labOrganizationId ?? "";
  const defaultPhone = ((practice as any)?.phone ?? "").trim();
  const [to, setTo] = useState(defaultPhone);
  const defaultMessage = [
    `Statement for ${row.practiceName}`,
    `Date: ${(() => { const _d = new Date(); return `${String(_d.getMonth() + 1).padStart(2, "0")}/${String(_d.getDate()).padStart(2, "0")}/${_d.getFullYear()}`; })()}`,
    `Billed: ${formatMoney(row.totalBilled)} | Open: ${formatMoney(row.openBalance)}${row.overdueBalance > 0 ? ` | Overdue: ${formatMoney(row.overdueBalance)}` : ""}`,
    `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} — please contact us with any questions.`,
  ].join("\n");
  const [message, setMessage] = useState(defaultMessage);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function send() {
    setError(null);
    if (!labOrganizationId) {
      setError("Could not determine your lab organization.");
      return;
    }
    setSending(true);
    try {
      const res = await apiFetch<{ sentAt: string; to: string; invoiceCount: number }>(
        "/invoices/statements/sms",
        {
          method: "POST",
          body: JSON.stringify({
            labOrganizationId,
            practiceOrganizationId: row.practiceId,
            invoiceIds: invoices.map((i) => i.id),
            ...(to.trim() ? { to: to.trim() } : {}),
            message,
          }),
        },
      );
      setSentAt(res.sentAt);
      setSentTo(res.to);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : (e as Error)?.message || "Failed to send.";
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
            <div className="text-xs text-muted-foreground">Text statement</div>
            <div className="text-sm font-semibold">{row.practiceName}</div>
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
              <div className="font-medium text-success">Text message sent.</div>
              <div className="text-xs text-muted-foreground mt-1">
                Delivered to {sentTo} at {formatDateTime(sentAt)}.
              </div>
            </div>
          ) : (
            <>
              <Field label="To (phone number)">
                <input
                  type="tel"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={defaultPhone || "Enter phone number (e.g. +15551234567)"}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
                {defaultPhone && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Pre-filled from this practice's phone number on file. Edit to override.
                  </p>
                )}
              </Field>
              <Field label="Message">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={7}
                  maxLength={1500}
                  className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {message.length} / 1500 characters
                </p>
              </Field>
              <div className="text-xs text-muted-foreground">
                The statement summary is sent as a text message. To send the full PDF, use Email statement instead.
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
                <MessageSquare size={14} />
              )}
              {sending ? "Sending…" : "Send text"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function SendInvoiceFromStatementDialog({
  invoice,
  practiceName,
  practice,
  labName,
  onClose,
}: {
  invoice: Invoice;
  practiceName: string;
  practice: Organization | null;
  labName: string;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: ["invoice", invoice.id],
    queryFn: () => apiFetch<any>(`/invoices/${invoice.id}`),
  });

  const { user } = useAuth();
  const { template: invoiceTemplate, extraImageDataUrls } = useInvoiceTemplate(
    user?.practiceInvoiceTemplate,
  );

  const defaultEmail = ((practice as any)?.billingEmail ?? "").trim();
  const [to, setTo] = useState(defaultEmail);
  const [subject, setSubject] = useState(`Invoice ${invoice.invoiceNumber}`);
  const [message, setMessage] = useState(
    `Hi ${practiceName},\n\nPlease find invoice ${invoice.invoiceNumber} attached.\n\nThank you,`,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  function buildOpts(detail: any): InvoicePdfOptions {
    const meta = detail.displayMetadata ?? detail.displayMetadataJson ?? null;
    const lineItems: Array<any> = detail.lineItems ?? detail.items ?? [];
    const subtotal = lineItems.reduce(
      (s: number, it: any) =>
        s + Number(it.quantity || 0) * Number(it.unitPrice ?? it.unit_price ?? 0),
      0,
    );
    return {
      invoiceNumber: detail.invoiceNumber,
      labName,
      practiceName,
      patientName: meta?.patientName ?? null,
      billTo: meta?.billTo ?? null,
      teeth: meta?.teeth ?? null,
      shade: meta?.shade ?? null,
      caseNotes: meta?.caseNotes ?? null,
      issuedAt: detail.issuedAt ?? null,
      dueAt: detail.dueAt ?? detail.dueDate ?? null,
      status: statusLabel(detail.status),
      items: lineItems.map((it: any) => ({
        item: it.item ?? it.description ?? "",
        description: it.description ?? "",
        quantity: Number(it.quantity || 0),
        unitPrice: Number(it.unitPrice ?? it.unit_price ?? 0),
        lineTotal:
          Number(it.quantity || 0) * Number(it.unitPrice ?? it.unit_price ?? 0),
      })),
      subtotal,
      tax: detail.tax ?? null,
      discount: detail.discount ?? null,
      credits: detail.credits ?? null,
      total: detail.total ?? 0,
      balanceDue: detail.balanceDue ?? null,
      notes: detail.notes ?? null,
      generatedAt: new Date(),
      template: invoiceTemplate,
      extraImageDataUrls,
    };
  }

  async function send() {
    setError(null);
    setSending(true);
    try {
      const detail = detailQuery.data ?? invoice;
      const built = buildInvoicePdf(buildOpts(detail));
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
        e instanceof ApiError ? e.message : (e as Error)?.message || "Failed to send.";
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
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {sentAt ? (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-3 text-sm">
              <div className="font-medium text-success">Invoice sent.</div>
              <div className="text-xs text-muted-foreground mt-1">
                Delivered to {to} at {formatDateTime(sentAt)}.
              </div>
            </div>
          ) : (
            <>
              <Field label="To">
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={defaultEmail || "Leave blank to use billing email on file"}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </Field>
              <Field label="Subject">
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
                />
              </Field>
              <Field label="Message">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y"
                />
              </Field>
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
              disabled={sending || detailQuery.isLoading}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
              {sending ? "Sending…" : "Send invoice"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}
