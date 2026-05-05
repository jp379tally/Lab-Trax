import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Download, Loader2, Mail, Receipt, Search, X } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import type { Invoice, Organization } from "@/lib/types";
import { formatDate, formatMoney, statusLabel } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { buildStatementPdf, downloadCsv, downloadStatementPdf, safeFilename } from "@/lib/export";

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
        <button
          type="button"
          onClick={exportSummaryCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/70 disabled:opacity-50 disabled:cursor-not-allowed border border-border"
        >
          <Download size={14} /> Export CSV
        </button>
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
    </div>
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

function Stat({ label, value, tone }: { label: string; value: string; tone: "primary" | "success" | "warning" | "neutral" }) {
  const cls =
    tone === "success"
      ? "bg-success/15 text-success"
      : tone === "warning"
        ? "bg-warning/20 text-warning"
        : tone === "primary"
          ? "bg-primary/10 text-primary"
          : "bg-secondary text-foreground";
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
          <div className="mt-1.5 text-xl font-semibold tabular-nums">{value}</div>
        </div>
        <div className={`h-8 w-8 rounded-md flex items-center justify-center ${cls}`}>
          <Receipt size={14} />
        </div>
      </div>
    </div>
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
  const sorted = [...invoices].sort((a, b) => (b.issuedAt || b.createdAt || "").localeCompare(a.issuedAt || a.createdAt || ""));
  const [emailOpen, setEmailOpen] = useState(false);

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
      invoices: sorted.map((i) => ({
        invoiceNumber: i.invoiceNumber,
        issuedAt: formatDate(i.issuedAt),
        dueAt: formatDate(i.dueAt ?? i.dueDate),
        status: statusLabel(i.status),
        total: String(i.total ?? 0),
        balanceDue: String(i.balanceDue ?? 0),
      })),
    };
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
        Due: formatDate(i.dueAt ?? i.dueDate),
        Status: statusLabel(i.status),
        Total: Number(i.total ?? 0).toFixed(2),
        "Balance due": Number(i.balanceDue ?? 0).toFixed(2),
        Practice: row.practiceName,
        Filters: filtersDescription ?? "",
      })),
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[640px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Statement</div>
            <div className="text-sm font-semibold">{row.practiceName}</div>
          </div>
          <div className="flex items-center gap-2">
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
              onClick={() => setEmailOpen(true)}
              disabled={sorted.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Mail size={13} /> Email statement
            </button>
            <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Billed" value={formatMoney(row.totalBilled)} tone="neutral" />
            <Stat label="Open" value={formatMoney(row.openBalance)} tone="primary" />
            <Stat label="Paid" value={formatMoney(row.totalPaid)} tone="success" />
            <Stat label="Overdue" value={formatMoney(row.overdueBalance)} tone={row.overdueBalance > 0 ? "warning" : "neutral"} />
          </div>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">Invoices</h3>
            <div className="border border-border rounded-md divide-y divide-border">
              {sorted.map((i) => (
                <div key={i.id} className="px-3 py-2 flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <div className="font-mono text-xs">{i.invoiceNumber}</div>
                    <div className="text-xs text-muted-foreground">
                      Issued {formatDate(i.issuedAt)} · Due {formatDate(i.dueAt ?? i.dueDate)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={i.status} />
                    <div className="text-right">
                      <div className="font-medium tabular-nums">{formatMoney(i.total)}</div>
                      {Number(i.balanceDue ?? 0) > 0 && (
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {formatMoney(i.balanceDue)} open
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {sorted.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">No invoices.</div>
              )}
            </div>
          </section>
        </div>
      </aside>
      {emailOpen && (
        <EmailStatementDialog
          row={row}
          invoices={sorted}
          practice={practice}
          buildPdfOptions={buildPdfOptions}
          onClose={() => setEmailOpen(false)}
        />
      )}
    </div>
  );
}

function EmailStatementDialog({
  row,
  invoices,
  practice,
  buildPdfOptions,
  onClose,
}: {
  row: StatementRow;
  invoices: Invoice[];
  practice: Organization | null;
  buildPdfOptions: () => Parameters<typeof buildStatementPdf>[0];
  onClose: () => void;
}) {
  const labOrganizationId = invoices[0]?.labOrganizationId ?? "";
  const defaultEmail = (practice?.billingEmail ?? "").trim();
  const [to, setTo] = useState(defaultEmail);
  const [subject, setSubject] = useState(
    `Statement for ${practice?.displayName || practice?.name || row.practiceName} — ${new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" })}`,
  );
  const [message, setMessage] = useState(
    `Hi ${row.practiceName},\n\nPlease find your latest statement attached. Open balance: ${formatMoney(row.openBalance)}${row.overdueBalance > 0 ? ` (overdue: ${formatMoney(row.overdueBalance)})` : ""}.\n\nLet us know if you have any questions.\n\nThank you,`,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}
