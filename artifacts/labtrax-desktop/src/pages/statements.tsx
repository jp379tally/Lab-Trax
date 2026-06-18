import { useMemo, useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, ChevronDown, ChevronUp, Download, Eye, History, Loader2, Mail, MessageSquare, Printer, Receipt, RefreshCw, Search, Send, X } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useLabOrganizations, useSelectedOrg } from "@/lib/finance";
import type { Invoice, Organization } from "@/lib/types";
import { formatDate, formatMoney, statusLabel } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { TriggeredByBadge } from "@/components/TriggeredByBadge";
import { buildInvoicePdf, buildStatementPdf, downloadCsv, downloadStatementPdf, printInvoicePdf, safeFilename, type InvoicePdfOptions } from "@/lib/export";
import { useAuth } from "@/lib/auth-context";
import { useInvoiceTemplate } from "@/lib/use-invoice-template";
import { InvoiceEditor } from "@/pages/invoices";

interface StatementSchedule {
  id: string;
  labOrganizationId: string;
  enabled: boolean;
  dayOfMonth: number;
  emailSubject: string | null;
  emailBody: string | null;
  emailReplyTo: string | null;
  includedOrgIds: string[] | null;
  lastSentForMonth: string | null;
  lastRunAt: string | null;
}

const DEFAULT_STATEMENT_SUBJECT =
  "Statement for {{practiceName}} — {{periodLabel}}";
const DEFAULT_STATEMENT_BODY =
  "Hello,\n\nPlease find attached the statement for {{practiceName}} covering {{periodLabel}}.\n\nTotal billed: {{totalBilled}}\nOpen balance: {{openBalance}}\n\nThank you,\n{{labName}}";

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

interface StatementRow {
  practiceId: string;
  practiceName: string;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  overdueBalance: number;
  oldestOpen: string | null;
}

type SortKey = "practiceName" | "invoiceCount" | "totalBilled" | "totalPaid" | "openBalance" | "overdueBalance";

function isOverdue(inv: Invoice): boolean {
  if (inv.status === "paid" || inv.status === "void") return false;
  const due = inv.dueAt ?? inv.dueDate;
  if (!due) return false;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now() && Number(inv.balanceDue ?? 0) > 0;
}

export default function StatementsPage() {
  const [, setLocation] = useLocation();
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });
  const organizationsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const [search, setSearch] = useState("");
  const [agingFilter, setAgingFilter] = useState<"all" | "open" | "overdue">("all");
  const [sortKey, setSortKey] = useState<SortKey>("openBalance");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<StatementRow | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [orgId] = useSelectedOrg();

  const scheduleQuery = useQuery({
    queryKey: ["statement-schedule", orgId],
    queryFn: () => apiFetch<StatementSchedule>(`/lab-orgs/${orgId}/statement-schedule`),
    enabled: !!orgId,
  });

  const emailTemplateQuery = useQuery<{ emailSubject: string | null; emailBody: string | null }>({
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

  const invoices = invoicesQuery.data ?? [];

  const rows = useMemo<StatementRow[]>(() => {
    const map = new Map<string, StatementRow>();
    for (const inv of invoices) {
      const id = inv.providerOrganizationId;
      const name = inv.providerOrganization?.name || "Unknown practice";
      const cur = map.get(id) ?? {
        practiceId: id,
        practiceName: name,
        invoiceCount: 0,
        totalBilled: 0,
        totalPaid: 0,
        openBalance: 0,
        overdueBalance: 0,
        oldestOpen: null,
      };
      cur.practiceName = name;
      cur.invoiceCount += 1;
      const total = Number(inv.total ?? 0);
      const balance = Number(inv.balanceDue ?? 0);
      cur.totalBilled += total;
      cur.totalPaid += Math.max(0, total - balance);
      if (inv.status !== "void") cur.openBalance += balance;
      if (isOverdue(inv)) {
        cur.overdueBalance += balance;
        const issued = inv.issuedAt || inv.createdAt || null;
        if (issued && (!cur.oldestOpen || issued < cur.oldestOpen)) {
          cur.oldestOpen = issued;
        }
      }
      map.set(id, cur);
    }
    return Array.from(map.values());
  }, [invoices]);

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

  const totals = useMemo(() => {
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

  function exportSummaryCsv() {
    const filterDesc = describeFilters({ search, agingFilter });
    const filename = `statements-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    const data = filtered.map((r) => ({
      Practice: r.practiceName,
      Invoices: r.invoiceCount,
      Billed: r.totalBilled.toFixed(2),
      Paid: r.totalPaid.toFixed(2),
      "Open balance": r.openBalance.toFixed(2),
      Overdue: r.overdueBalance.toFixed(2),
      "Oldest open": r.oldestOpen ? formatDate(r.oldestOpen) : "",
      Filters: filterDesc,
    }));
    downloadCsv(filename, data);
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
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50 disabled:cursor-not-allowed border border-border"
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat label="Total billed" value={formatMoney(totals.billed)} tone="neutral" />
        <Stat label="Collected" value={formatMoney(totals.paid)} tone="success" />
        <Stat label="Open balance" value={formatMoney(totals.open)} tone="primary" />
        <Stat label="Overdue" value={formatMoney(totals.overdue)} tone={totals.overdue > 0 ? "warning" : "neutral"} />
      </div>

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

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="text-left px-5 py-2.5"><SortHeader k="practiceName">Practice</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="invoiceCount" align="right">Invoices</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalBilled" align="right">Billed</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalPaid" align="right">Paid</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="openBalance" align="right">Open balance</SortHeader></th>
                <th className="text-right px-5 py-2.5"><SortHeader k="overdueBalance" align="right">Overdue</SortHeader></th>
              </tr>
            </thead>
            <tbody>
              {invoicesQuery.isLoading && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading statements…
                  </td>
                </tr>
              )}
              {invoicesQuery.error && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-destructive">{(invoicesQuery.error as Error).message}</td>
                </tr>
              )}
              {!invoicesQuery.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
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
                  <td className="px-5 py-3 font-medium">{r.practiceName}</td>
                  <td className="py-3 text-right tabular-nums">{r.invoiceCount}</td>
                  <td className="py-3 text-right tabular-nums">{formatMoney(r.totalBilled)}</td>
                  <td className="py-3 text-right tabular-nums text-success">{formatMoney(r.totalPaid)}</td>
                  <td className="py-3 text-right tabular-nums font-medium">{formatMoney(r.openBalance)}</td>
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
      </div>

      {selected && (
        <StatementDrawer
          row={selected}
          invoices={invoices.filter((i) => i.providerOrganizationId === selected.practiceId)}
          practice={organizationsQuery.data?.find((o) => o.id === selected.practiceId) ?? null}
          filtersDescription={describeFilters({ search, agingFilter })}
          onClose={() => setSelected(null)}
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
          rows={rows}
          practices={organizationsQuery.data?.filter((o) => o.parentLabOrganizationId === orgId) ?? []}
          scheduleTemplate={(() => {
            // Schedule template takes priority; fall back to the saved lab default
            if (scheduleQuery.data?.emailSubject || scheduleQuery.data?.emailBody) {
              return { subject: scheduleQuery.data.emailSubject, body: scheduleQuery.data.emailBody };
            }
            if (emailTemplateQuery.data?.emailSubject || emailTemplateQuery.data?.emailBody) {
              return { subject: emailTemplateQuery.data.emailSubject, body: emailTemplateQuery.data.emailBody };
            }
            return null;
          })()}
          onClose={() => setShowGenerate(false)}
        />
      )}
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
      periodLabel: new Date(Date.now() - 30 * 86400_000).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      }),
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
                  {sched.lastRunAt ? ` on ${new Date(sched.lastRunAt).toLocaleString("en-US")}` : ""}.
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
      qc.invalidateQueries({ queryKey: ["statement-schedule", orgId] });
    },
    onError: (err: unknown) => {
      setRetryError(err instanceof ApiError ? err.message : (err as Error).message);
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-foreground/30" />
      <aside className="w-full max-w-[720px] bg-card border-l border-border h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Statement send history</div>
            <div className="text-sm font-semibold">Most recent 200 entries</div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
            <X size={16} />
          </button>
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
              No statement send attempts yet. Enable auto-send or use “Send last month now” to record a run.
            </div>
          )}
          {retryError && (
            <div className="px-6 py-2 text-xs text-destructive border-b border-border bg-destructive/5">
              {retryError}
            </div>
          )}
          <table className="w-full text-sm">
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
                    <td className="px-6 py-3 align-top">
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
                          Auto-retry scheduled for {new Date(r.nextAttemptAt as string).toLocaleString("en-US")}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                      Billed {formatMoney(r.totalBilled)}<br />
                      Open {formatMoney(r.openBalance)}
                    </td>
                    <td className="px-6 py-3 align-top text-right whitespace-nowrap">
                      <RunStatusBadge status={r.status} />
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {new Date(r.createdAt).toLocaleString("en-US")}
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
    </div>
  );
}

// ── Helpers for GenerateStatementsModal ─────────────────────────────────────

async function downloadStatementsZip(
  orgId: string,
  body: { practiceIds: string[] | null; invoiceScope: string; periodLabel: string | null }
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

type BatchScope = "open" | "open_overdue_90" | "all";

interface BatchSendResult {
  practiceId: string;
  practiceName: string;
  emailStatus: "sent" | "failed" | "skipped" | null;
  emailError: string | null;
  smsStatus: "sent" | "failed" | "skipped" | null;
  smsError: string | null;
}

function BatchStatusBadge({ status, error }: { status: "sent" | "failed" | "skipped" | null; error: string | null }) {
  if (status === null) return <span className="text-muted-foreground text-[11px]">—</span>;
  if (status === "sent") return <span className="text-[11px] font-medium text-success">Sent</span>;
  if (status === "skipped") return <span className="text-[11px] text-warning" title={error ?? "Skipped"}>Skipped</span>;
  return <span className="text-[11px] text-destructive" title={error ?? "Failed"}>Failed</span>;
}

function GenerateStatementsModal({
  orgId,
  rows,
  practices,
  scheduleTemplate,
  onClose,
}: {
  orgId: string;
  rows: StatementRow[];
  practices: Organization[];
  scheduleTemplate: { subject: string | null; body: string | null } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allSelected, setAllSelected] = useState(true);
  const [practiceSearch, setPracticeSearch] = useState("");
  const [onlyWithBalance, setOnlyWithBalance] = useState(true);

  const [scope, setScope] = useState<BatchScope>("open");

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [downloadEnabled, setDownloadEnabled] = useState(false);
  const [emailSubject, setEmailSubject] = useState(scheduleTemplate?.subject ?? "");
  const [emailBody, setEmailBody] = useState(scheduleTemplate?.body ?? "");
  const [stmtPeriodLabel, setStmtPeriodLabel] = useState(
    `Statement as of ${new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}`
  );

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [results, setResults] = useState<BatchSendResult[] | null>(null);
  const [resultPeriodLabel, setResultPeriodLabel] = useState("");

  const balanceByPracticeId = useMemo(() => {
    const map = new Map<string, { open: number; overdue: number }>();
    for (const r of rows) map.set(r.practiceId, { open: r.openBalance, overdue: r.overdueBalance });
    return map;
  }, [rows]);

  const filteredPractices = useMemo(() => {
    const q = practiceSearch.trim().toLowerCase();
    return practices.filter((p) => {
      if (onlyWithBalance) {
        const bal = balanceByPracticeId.get(p.id);
        if (!bal || bal.open <= 0) return false;
      }
      if (q) return (p.displayName || p.name).toLowerCase().includes(q);
      return true;
    });
  }, [practices, practiceSearch, onlyWithBalance, balanceByPracticeId]);

  function isChecked(id: string) { return allSelected || selectedIds.has(id); }

  function togglePractice(id: string) {
    setSelectedIds((prev) => {
      const base = allSelected ? new Set(filteredPractices.map((p) => p.id)) : new Set(prev);
      if (base.has(id)) base.delete(id); else base.add(id);
      return base;
    });
    setAllSelected(false);
  }

  function selectAll() { setSelectedIds(new Set()); setAllSelected(true); }
  function deselectAll() { setSelectedIds(new Set()); setAllSelected(false); }

  const selectedCount = allSelected ? filteredPractices.length : selectedIds.size;
  const practicesWithEmail = filteredPractices.filter((p) => p.billingEmail && isChecked(p.id)).length;
  const practicesWithPhone = filteredPractices.filter((p) => (p as any).phone && isChecked(p.id)).length;

  async function handleSend() {
    setSending(true);
    setSendError(null);
    const practiceIds = allSelected ? null : Array.from(selectedIds);
    const channels: Array<"email" | "sms"> = [
      ...(emailEnabled ? (["email"] as const) : []),
      ...(smsEnabled ? (["sms"] as const) : []),
    ];
    try {
      let newResults: BatchSendResult[] | null = null;
      let newLabel = stmtPeriodLabel;
      if (channels.length > 0) {
        const resp = await apiFetch<{ periodLabel: string; results: BatchSendResult[] }>(
          `/lab-orgs/${orgId}/statements/batch-send`,
          {
            method: "POST",
            body: JSON.stringify({
              practiceIds,
              invoiceScope: scope,
              channels,
              emailSubject: emailSubject.trim() || null,
              emailBody: emailBody.trim() || null,
              periodLabel: stmtPeriodLabel.trim() || null,
            }),
          }
        );
        newResults = resp.results;
        newLabel = resp.periodLabel;
      }
      if (downloadEnabled) {
        await downloadStatementsZip(orgId, {
          practiceIds,
          invoiceScope: scope,
          periodLabel: stmtPeriodLabel.trim() || null,
        });
      }
      qc.invalidateQueries({ queryKey: ["statement-runs", orgId] });
      setResults(newResults);
      setResultPeriodLabel(newLabel);
      setStep(5);
    } catch (err: unknown) {
      setSendError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function handleRetryFailed() {
    if (!results) return;
    const failedIds = results
      .filter((r) => r.emailStatus === "failed" || r.smsStatus === "failed")
      .map((r) => r.practiceId);
    if (!failedIds.length) return;
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
            practiceIds: failedIds,
            invoiceScope: scope,
            channels,
            emailSubject: emailSubject.trim() || null,
            emailBody: emailBody.trim() || null,
            periodLabel: stmtPeriodLabel.trim() || null,
          }),
        }
      );
      const retryMap = new Map(resp.results.map((r) => [r.practiceId, r]));
      setResults((prev) => (prev ? prev.map((r) => retryMap.get(r.practiceId) ?? r) : null));
      setResultPeriodLabel(resp.periodLabel);
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
    { value: "all", title: "All invoices", desc: "Every invoice regardless of status — includes paid and voided." },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/40" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <div className="text-xs text-muted-foreground">Generate statements</div>
            <div className="text-sm font-semibold">
              {step === 1 ? "Select practices" : step === 2 ? "Invoice scope & label" : step === 3 ? "Delivery channels" : step === 4 ? "Review & send" : "Results"}
            </div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"><X size={16} /></button>
        </header>

        <div className="flex items-center px-5 py-2.5 border-b border-border gap-1 shrink-0">
          {(["Practices", "Scope", "Delivery", "Review"] as const).map((label, idx) => {
            const n = (idx + 1) as 1 | 2 | 3 | 4;
            const active = step === n;
            const done = step > n && step < 5;
            return (
              <div key={n} className="flex items-center gap-1">
                <div className={`flex items-center gap-1.5 text-[11px] font-medium ${active ? "text-primary" : done ? "text-success" : "text-muted-foreground"}`}>
                  <div className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${active ? "bg-primary text-primary-foreground" : done ? "bg-success/20 text-success" : "bg-secondary text-muted-foreground"}`}>
                    {done ? "✓" : n}
                  </div>
                  {label}
                </div>
                {idx < 3 && <div className="w-5 h-px bg-border mx-0.5" />}
              </div>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 1 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input type="search" value={practiceSearch} onChange={(e) => setPracticeSearch(e.target.value)} placeholder="Search practice…" className="w-full h-8 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none shrink-0">
                  <input type="checkbox" checked={onlyWithBalance} onChange={(e) => setOnlyWithBalance(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
                  Open balance only
                </label>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{selectedCount} of {filteredPractices.length} practice{filteredPractices.length === 1 ? "" : "s"} selected</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAll} className="text-xs text-primary hover:underline">Select all</button>
                  <span className="text-muted-foreground text-xs">/</span>
                  <button type="button" onClick={deselectAll} className="text-xs text-primary hover:underline">None</button>
                </div>
              </div>
              {filteredPractices.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No practices match the current filter.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-secondary/10 divide-y divide-border">
                  {filteredPractices.map((p) => {
                    const bal = balanceByPracticeId.get(p.id);
                    const checked = isChecked(p.id);
                    return (
                      <label key={p.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-secondary/60 select-none">
                        <input type="checkbox" checked={checked} onChange={() => togglePractice(p.id)} className="h-4 w-4 accent-primary shrink-0" />
                        <span className="flex-1 min-w-0 truncate text-sm">{p.displayName || p.name}</span>
                        <span className="tabular-nums text-xs text-muted-foreground shrink-0">
                          {bal && bal.open > 0 ? formatMoney(bal.open) : ""}
                          {bal && bal.overdue > 0 && <span className="ml-1 text-destructive">({formatMoney(bal.overdue)} od)</span>}
                        </span>
                        {!p.billingEmail && <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/20 text-warning font-medium shrink-0">no email</span>}
                        {!(p as any).phone && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-medium shrink-0">no phone</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Choose which invoices to include in each statement.</p>
              {SCOPE_OPTIONS.map(({ value: sv, title, desc }) => (
                <label key={sv} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${scope === sv ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                  <input type="radio" name="scope" value={sv} checked={scope === sv} onChange={() => setScope(sv)} className="mt-0.5 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium">{title}</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">{desc}</span>
                  </span>
                </label>
              ))}
              <div className="pt-1">
                <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Statement period label</label>
                <input type="text" value={stmtPeriodLabel} onChange={(e) => setStmtPeriodLabel(e.target.value)} className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                <p className="text-[11px] text-muted-foreground mt-1">Appears on the PDF header and in email text as the statement period.</p>
              </div>
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
                    <span className="block text-xs text-muted-foreground mt-0.5">{practicesWithEmail} of {selectedCount} selected practices have a billing email on file.</span>
                  </span>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${smsEnabled ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                  <input type="checkbox" checked={smsEnabled} onChange={(e) => setSmsEnabled(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium"><MessageSquare size={13} className="inline mr-1" />SMS notification</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">{practicesWithPhone} of {selectedCount} selected practices have a phone number on file.</span>
                  </span>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer select-none transition-colors ${downloadEnabled ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                  <input type="checkbox" checked={downloadEnabled} onChange={(e) => setDownloadEnabled(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium"><Download size={13} className="inline mr-1" />Download ZIP</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">Download a ZIP archive with one PDF per practice — no email or SMS is sent.</span>
                  </span>
                </label>
              </div>
              {!canSend && <p className="text-sm text-destructive">Please select at least one delivery option.</p>}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Review the practices to be contacted, then confirm to send.</p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-secondary/40 border-b border-border">
                      <th className="text-left px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Practice</th>
                      {emailEnabled && <th className="text-left px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Email</th>}
                      {smsEnabled && <th className="text-left px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Phone</th>}
                      <th className="text-right px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Open balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(allSelected ? practices : practices.filter((p) => selectedIds.has(p.id))).map((p) => {
                      const bal = balanceByPracticeId.get(p.id);
                      return (
                        <tr key={p.id} className="border-t border-border">
                          <td className="px-4 py-2 font-medium text-sm">{p.displayName || p.name}</td>
                          {emailEnabled && (
                            <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[160px]">
                              {p.billingEmail || <span className="text-warning">No email</span>}
                            </td>
                          )}
                          {smsEnabled && (
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {(p as any).phone || <span className="text-warning">No phone</span>}
                            </td>
                          )}
                          <td className="px-4 py-2 text-right tabular-nums text-sm font-medium">
                            {formatMoney(bal?.open ?? 0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {emailEnabled && (
                <div className="border-t border-border pt-4 space-y-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Email template (optional overrides)</div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Subject</label>
                    <input type="text" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder={DEFAULT_STATEMENT_SUBJECT} className="w-full h-9 px-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary" />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-muted-foreground font-medium mb-1.5">Message body</label>
                    <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={5} placeholder={DEFAULT_STATEMENT_BODY} className="w-full px-3 py-2 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary resize-y font-mono" />
                    <p className="text-[11px] text-muted-foreground mt-1">Pre-filled from your saved default (Settings → Templates → Statement email). Placeholders: <code>{"{{practiceName}}"}</code>, <code>{"{{labName}}"}</code>, <code>{"{{periodLabel}}"}</code>, <code>{"{{openBalance}}"}</code>.</p>
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
                          <th className="text-left px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Practice</th>
                          {emailEnabled && <th className="text-center px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Email</th>}
                          {smsEnabled && <th className="text-center px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">SMS</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r) => (
                          <tr key={r.practiceId} className="border-t border-border">
                            <td className="px-4 py-2.5 font-medium text-sm">{r.practiceName}</td>
                            {emailEnabled && <td className="px-3 py-2.5 text-center"><BatchStatusBadge status={r.emailStatus} error={r.emailError} /></td>}
                            {smsEnabled && <td className="px-3 py-2.5 text-center"><BatchStatusBadge status={r.smsStatus} error={r.smsError} /></td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-muted-foreground flex gap-4">
                      <span className="text-success font-medium">{results.filter((r) => r.emailStatus === "sent" || r.smsStatus === "sent").length} delivered</span>
                      <span className="text-warning">{results.filter((r) => r.emailStatus === "skipped" && r.smsStatus !== "sent").length} skipped</span>
                      <span className="text-destructive">{results.filter((r) => r.emailStatus === "failed" || r.smsStatus === "failed").length} failed</span>
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
              disabled={step === 1 && selectedCount === 0}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              Next
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !canSend}
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
  invoices,
  practice,
  filtersDescription,
  onClose,
}: {
  row: StatementRow;
  invoices: Invoice[];
  practice: Organization | null;
  filtersDescription?: string;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const [orgId] = useSelectedOrg();
  const labOrgsQuery = useLabOrganizations();
  const labOrg = labOrgsQuery.data?.find((o) => o.id === orgId);
  const labName = (labOrg as any)?.displayName || (labOrg as any)?.name || "";

  const sorted = [...invoices].sort((a, b) =>
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
        return sorted.filter((i) => ["open", "partially_paid", "draft"].includes(i.status));
      case "paid":
        return sorted.filter((i) => i.status === "paid");
      case "overdue":
        return sorted.filter((i) => isOverdue(i));
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

  function exportPdf() {
    downloadStatementPdf(buildPdfOptions());
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
              onClick={() => setEmailOpen(true)}
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
                            {date
                              ? new Date(date).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })
                              : "—"}
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

      {emailOpen && (
        <EmailStatementDialog
          row={row}
          invoices={sorted}
          practice={practice}
          labName={labName}
          buildPdfOptions={buildPdfOptions}
          onClose={() => setEmailOpen(false)}
        />
      )}
      {textOpen && (
        <TextStatementDialog
          row={row}
          invoices={sorted}
          practice={practice}
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
  buildPdfOptions,
  onClose,
}: {
  row: StatementRow;
  invoices: Invoice[];
  practice: Organization | null;
  labName: string;
  buildPdfOptions: () => Parameters<typeof buildStatementPdf>[0];
  onClose: () => void;
}) {
  const labOrganizationId = invoices[0]?.labOrganizationId ?? "";
  const defaultEmail = (practice?.billingEmail ?? "").trim();
  const practiceName = practice?.displayName || practice?.name || row.practiceName;
  const periodLabel = new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" });

  const hardcodedSubject = `Statement for ${practiceName} — ${periodLabel}`;
  const hardcodedMessage = `Hi ${row.practiceName},\n\nPlease find your latest statement attached. Open balance: ${formatMoney(row.openBalance)}${row.overdueBalance > 0 ? ` (overdue: ${formatMoney(row.overdueBalance)})` : ""}.\n\nLet us know if you have any questions.\n\nThank you,`;

  const [to, setTo] = useState(defaultEmail);
  const [subject, setSubject] = useState(hardcodedSubject);
  const [message, setMessage] = useState(hardcodedMessage);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const templateApplied = useRef(false);

  const emailTemplateQuery = useQuery<{ emailSubject: string | null; emailBody: string | null }>({
    queryKey: ["admin", "templates", "statement-email"],
    queryFn: () => apiFetch("/admin/templates/statement-email"),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (templateApplied.current || !emailTemplateQuery.data) return;
    templateApplied.current = true;
    const vars: Record<string, string> = {
      practiceName,
      labName,
      periodLabel,
      openBalance: formatMoney(row.openBalance),
      totalBilled: formatMoney(row.totalBilled),
    };
    if (emailTemplateQuery.data.emailSubject) {
      setSubject(renderTemplate(emailTemplateQuery.data.emailSubject, vars));
    }
    if (emailTemplateQuery.data.emailBody) {
      setMessage(renderTemplate(emailTemplateQuery.data.emailBody, vars));
    }
  }, [emailTemplateQuery.data, practiceName, labName, periodLabel, row.openBalance, row.totalBilled]);

  async function send() {
    setError(null);
    if (!labOrganizationId) {
      setError("Could not determine your lab organization.");
      return;
    }
    setSending(true);
    try {
      const built = buildStatementPdf(buildPdfOptions());
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
            filename: built.filename,
            pdfBase64: built.base64,
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
                Delivered to {to} at {new Date(sentAt).toLocaleString("en-US")}.
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
    `Date: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
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
                Delivered to {sentTo} at {new Date(sentAt).toLocaleString("en-US")}.
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
                Delivered to {to} at {new Date(sentAt).toLocaleString("en-US")}.
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
