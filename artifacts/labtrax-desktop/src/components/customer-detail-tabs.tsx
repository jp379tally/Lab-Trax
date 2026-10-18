// hint: Logic changed on both sides. Requires understanding intent of each change.
import {
  AlertCircle,
  ArrowRightLeft,
  CalendarDays,
  CreditCard,
  FileDown,
  FileText,
  Loader2,
  PenLine,
  Plus,
  Send,
  Upload,
  X,
} from "lucide-react";
import { apiFetch, apiFetchArrayBuffer, apiUploadWithProgress, ApiError } from "@/lib/api";
import { trackSavedCardSetup } from "@/lib/analytics";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, Organization, PracticeStatement } from "@/lib/types";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { downloadCsv, safeFilename } from "@/lib/export";
import { StatusBadge } from "@/components/StatusBadge";
import { ColumnTotal } from "@/components/ColumnTotal";
import { InvoiceEditor, StatementBuilderDialog } from "@/pages/invoices";
import { useTableColumns } from "@/hooks/useTableColumns";
import { ColumnSettingsPopover } from "@/components/ColumnSettingsPopover";
import type { SharedProviderAccountData } from "@workspace/api-client-react";
import {
  AuthorizationHistory,
  type AuthorizationRecord,
} from "@/components/AuthorizationHistory";

// Customer detail tabs — shared by the slide-in customer window (PracticeEditor)
// opened from the Accounts page. Originally built for the (now retired)
// Customer Center page; the Invoices / Statements / Card on File tab content
// lives here so every customer's window gets the full 4-tab experience.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LabAutoPayAuthorization } from "@/components/autopay/AutoPayAuthorization";

const today = () => new Date();

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function startOfQuarter(d: Date) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}
function endOfQuarter(d: Date) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3 + 3, 0, 23, 59, 59, 999);
}

type DateRangeKey =
  | "all"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "custom";

function resolveDateRange(
  key: DateRangeKey,
  custom: { from: string; to: string }
): { from: Date | null; to: Date | null } {
  const now = today();
  switch (key) {
    case "this_month":
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case "last_month": {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: startOfMonth(prev), to: endOfMonth(prev) };
    }
    case "this_quarter":
      return { from: startOfQuarter(now), to: endOfQuarter(now) };
    case "last_quarter": {
      const prev = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      return { from: startOfQuarter(prev), to: endOfQuarter(prev) };
    }
    case "this_year":
      return {
        from: new Date(now.getFullYear(), 0, 1),
        to: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      };
    case "custom":
      return {
        from: custom.from ? new Date(custom.from) : null,
        to: custom.to ? new Date(custom.to) : null,
      };
    default:
      return { from: null, to: null };
  }
}

function agingDays(inv: Invoice): number | null {
  const isOpen = inv.status === "open" || inv.status === "partially_paid";
  if (!isOpen) return null;
  const due = inv.dueAt ?? inv.dueDate;
  if (!due) return null;
  const diff = Math.floor(
    (today().getTime() - new Date(due).getTime()) / 86_400_000
  );
  return diff > 0 ? diff : null;
}

type PagedRows<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type StatementChargeResponse = PagedRows<ChargeLedgerRow> & {
  providerOrganizationId?: string;
  openingBalance?: string | number;
  endingBalance?: string | number;
};

export type DetailTab = "basic" | "invoices" | "statements" | "charges" | "card";

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "basic", label: "Basic Info" },
  { id: "invoices", label: "Invoices" },
  { id: "statements", label: "Statements" },
  { id: "charges", label: "Customer statement charges" },
  { id: "card", label: "Card on File" },
];

type ChargeLedgerRow = {
  id?: string;
  type?: string;
  kind?: string;
  // Reader-facing row type: "Invoice", "Payment (3 invoices)", and so on.
  typeLabel?: string | null;
  invoiceNumber?: string | null;
  // Number of invoices a rolled-up payment settled.
  invoiceCount?: number | null;
  doctorIdentity?: string | null;
  doctorName?: string | null;
  patientName?: string | null;
  invoiceAmount?: string | number | null;
  paymentAmount?: string | number | null;
  paymentMethod?: string | null;
  referenceNumber?: string | null;
  statementId?: string | null;
  statementLabel?: string | null;
  openBalance?: string | number | null;
  occurredAt?: string | null;
  date?: string | null;
  balance?: string | number | null;
};

const CHARGE_PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: "Card",
  ach: "ACH",
  check: "Check",
  cash: "Cash",
  other: "Other",
};

function chargeRowType(row: ChargeLedgerRow): string {
  return row.typeLabel || row.kind || row.type || "Transaction";
}

function chargePaymentMethod(row: ChargeLedgerRow): string {
  if (!row.paymentMethod) return "";
  return CHARGE_PAYMENT_METHOD_LABELS[row.paymentMethod] ?? row.paymentMethod;
}

// ── Statements tab ─────────────────────────────────────────────────────────

type StmtFilter = "all" | "open" | "paid";

// A statement row stores the totals frozen when it was generated; nothing
// rewrites them when a payment is later recorded. The list endpoint derives
// the settled and outstanding figures from the statement's own invoices as
// they stand now and returns them under both the plain and the explicit
// `current*` names, keeping the issued snapshot under `snapshot*`. The
// fallbacks below keep an older cached response readable.
function statementPaid(s: PracticeStatement): number {
  return Number(s.currentTotalPaid ?? s.totalPaid ?? 0);
}

function statementBalanceDue(s: PracticeStatement): number {
  return Number(s.currentBalanceDue ?? s.balanceDue ?? 0);
}

export function StatementsTab({
  selected,
  labOrgId,
}: {
  selected: Organization;
  labOrgId: string;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StmtFilter>("all");
  const [sendOpen, setSendOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [resendFor, setResendFor] = useState<{
    statementId: string;
    attachmentIndex?: number;
  } | null>(null);
  const [resendEmail, setResendEmail] = useState("");
  const [resendError, setResendError] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<{
    id: string;
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const statementsQuery = useQuery({
    // The request varies by lab as well as practice, so the key has to as
    // well or one lab's statements can be served for another's.
    queryKey: ["practice-statements", { practiceId: selected.id, labOrgId }],
    queryFn: () =>
      apiFetch<PracticeStatement[]>(
        `/invoices/practice-statements?providerOrganizationId=${encodeURIComponent(selected.id)}&labOrganizationId=${encodeURIComponent(labOrgId)}`
      ),
    enabled: !!selected.id && !!labOrgId,
  });

  // Fetch the full org record so we can display billing-type additional emails
  // as read-only Auto-CC chips in the email compose forms.
  const selectedOrgQuery = useQuery({
    queryKey: ["organizations", selected.id],
    queryFn: () => apiFetch<Organization>(`/organizations/${selected.id}`),
    enabled: !!selected.id,
  });
  const billingCcEmails = useMemo(
    () =>
      (selectedOrgQuery.data?.additionalEmails ?? []).filter(
        (e) => e.type === "billing",
      ),
    [selectedOrgQuery.data],
  );

  const statements = useMemo(() => {
    const rows = statementsQuery.data ?? [];
    return rows.filter((s) => {
      if (filter === "open") return statementBalanceDue(s) > 0;
      if (filter === "paid") return statementBalanceDue(s) <= 0;
      return true;
    });
  }, [statementsQuery.data, filter]);

  const practiceName = selected.displayName || selected.name;

  function periodLabel(s: PracticeStatement): string {
    const fmt = (d?: string | null) => formatDate(d ?? null);
    return `${fmt(s.periodStart)} – ${fmt(s.periodEnd)}`;
  }

  async function handleStatementPdf(
    s: PracticeStatement,
    attachment?: NonNullable<PracticeStatement["bundleAttachments"]>[number],
    action: "open" | "download" = "download",
  ) {
    setRowNotice(null);
    setDownloadingId(s.id);
    const pdfWindow =
      action === "open" ? window.open("about:blank", "_blank") : null;
    try {
      if (action === "open" && !pdfWindow) {
        throw new Error("Allow pop-ups to open this PDF.");
      }
      if (pdfWindow) pdfWindow.opener = null;
      const pdfPath = `/invoices/practice-statements/${s.id}/pdf${
        attachment ? `?attachmentIndex=${attachment.index}` : ""
      }`;
      const { buffer } = await apiFetchArrayBuffer(
        pdfPath,
      );
      const blob = new Blob([buffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      if (pdfWindow) {
        pdfWindow.addEventListener(
          "load",
          () =>
            pdfWindow.addEventListener(
              "beforeunload",
              () => URL.revokeObjectURL(url),
              { once: true },
            ),
          { once: true },
        );
        pdfWindow.location.href = url;
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download =
          attachment?.fileName ||
          s.pdfFileName ||
          `statement-${s.id}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      pdfWindow?.close();
      setRowNotice({
        id: s.id,
        kind: "error",
        text: e instanceof Error ? e.message : "Download failed.",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  const resendEmailMutation = useMutation({
    mutationFn: ({
      s,
      to,
      attachmentIndex,
    }: {
      s: PracticeStatement;
      to?: string;
      attachmentIndex?: number;
    }) =>
      apiFetch(`/invoices/practice-statements/${s.id}/email`, {
        method: "POST",
        body: JSON.stringify({
          subject: `Statement for ${practiceName}`,
          message: `Please find your account statement for ${periodLabel(s)} attached.`,
          ...(to ? { to } : {}),
          ...(attachmentIndex === undefined ? {} : { attachmentIndex }),
        }),
      }),
    onMutate: () => setRowNotice(null),
    onSuccess: (_data, { s, to, attachmentIndex }) => {
      setResendFor(null);
      const attachment = s.bundleAttachments?.find(
        (item) => item.index === attachmentIndex,
      );
      const documentName = attachment
        ? attachment.doctorName || attachment.label || attachment.fileName
        : "statement";
      setRowNotice({
        id: s.id,
        kind: "success",
        text: `Emailed ${documentName} to ${to || selected.billingEmail || "billing email"}.`,
      });
      // Refresh the list so the "Emailed <date> to <address>" indicator updates.
      void queryClient.invalidateQueries({ queryKey: ["practice-statements"] });
    },
    onError: (e: Error, { s }) =>
      setRowNotice({
        id: s.id,
        kind: "error",
        text: e.message || "Email failed.",
      }),
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function openResendForm(
    s: PracticeStatement,
    attachment?: NonNullable<PracticeStatement["bundleAttachments"]>[number],
  ) {
    if (
      resendFor?.statementId === s.id &&
      resendFor.attachmentIndex === attachment?.index
    ) {
      setResendFor(null);
      return;
    }
    setRowNotice(null);
    setResendError(null);
    setResendEmail(selected.billingEmail || "");
    setResendFor({
      statementId: s.id,
      ...(attachment ? { attachmentIndex: attachment.index } : {}),
    });
  }

  function handleResendSend(s: PracticeStatement) {
    const trimmed = resendEmail.trim();
    if (!trimmed) {
      setResendError("Enter a recipient email address.");
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setResendError("Enter a valid email address.");
      return;
    }
    setResendError(null);
    const billing = (selected.billingEmail || "").trim().toLowerCase();
    const to = trimmed.toLowerCase() === billing ? undefined : trimmed;
    const attachmentIndex =
      resendFor?.statementId === s.id
        ? resendFor.attachmentIndex
        : undefined;
    resendEmailMutation.mutate({ s, to, attachmentIndex });
  }

  function handleFilterChange(val: string) {
    if (val === "send") {
      setSendOpen(true);
    } else {
      setFilter(val as StmtFilter);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-5 py-2.5 border-b border-border bg-card/50 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium">Filter:</span>
          <select
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value)}
            className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="send">Send Statements…</option>
          </select>
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {statements.length} statement{statements.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {statementsQuery.isLoading && (
          <div className="py-12 text-center text-muted-foreground text-xs">
            <Loader2 size={14} className="inline animate-spin mr-1.5" />
            Loading statements…
          </div>
        )}
        {statementsQuery.isError && (
          <div className="py-12 text-center text-xs">
            <AlertCircle size={14} className="inline mr-1.5 text-destructive" />
            <span className="text-destructive">
              {(statementsQuery.error as Error)?.message ?? "Failed to load statements."}
            </span>
          </div>
        )}
        {!statementsQuery.isLoading && !statementsQuery.isError && statements.length === 0 && (
          <div className="py-12 text-center text-muted-foreground text-xs">
            <FileText size={24} className="mx-auto mb-3 opacity-20" />
            <p>No statements found{filter !== "all" ? " for this filter" : ""}.</p>
            <p className="mt-1">
              Select{" "}
              <button
                type="button"
                onClick={() => setSendOpen(true)}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Send Statements
              </button>{" "}
              from the filter to generate one.
            </p>
          </div>
        )}
        {statements.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm">
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left px-5 py-2.5 font-medium">Statement #</th>
                <th className="text-left px-3 py-2.5 font-medium">Period</th>
                <th className="text-left px-3 py-2.5 font-medium">Invoices</th>
                <th className="text-right px-3 py-2.5 font-medium">
                  Billed
                  <ColumnTotal
                    values={statements.map((s) => s.totalBilled)}
                    loading={statementsQuery.isLoading}
                    testId="column-total-billed"
                  />
                </th>
                <th className="text-right px-3 py-2.5 font-medium">
                  Paid
                  <ColumnTotal
                    values={statements.map(statementPaid)}
                    loading={statementsQuery.isLoading}
                    testId="column-total-paid"
                  />
                </th>
                <th className="text-right px-3 py-2.5 font-medium">
                  Balance Due
                  <ColumnTotal
                    values={statements.map(statementBalanceDue)}
                    loading={statementsQuery.isLoading}
                    testId="column-total-balance-due"
                  />
                </th>
                <th className="text-left px-3 py-2.5 font-medium">Sent</th>
                <th className="text-left px-3 py-2.5 font-medium">Created</th>
                <th className="text-left px-3 py-2.5 font-medium">Paid On</th>
                <th className="text-left px-3 py-2.5 font-medium">Payment Method</th>
                <th className="text-right px-5 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => {
                const isDownloading = downloadingId === s.id;
                const isEmailing =
                  resendEmailMutation.isPending &&
                  resendEmailMutation.variables?.s.id === s.id;
                const bundleAttachments = s.bundleAttachments ?? [];
                const resendAttachment =
                  resendFor?.statementId === s.id &&
                  resendFor.attachmentIndex !== undefined
                    ? bundleAttachments.find(
                        (attachment) =>
                          attachment.index === resendFor.attachmentIndex,
                      )
                    : undefined;
                const resendFormSuffix =
                  resendFor?.statementId === s.id &&
                  resendFor.attachmentIndex !== undefined
                    ? `-attachment-${resendFor.attachmentIndex}`
                    : "";
                return (
                  <Fragment key={s.id}>
                    <tr className="border-t border-border hover:bg-secondary/30 transition-colors">
                      <td className="px-5 py-3 text-left font-medium text-foreground tabular-nums">
                        {/* Use UTC parts so the number matches the statement
                            period regardless of the user's local timezone. */}
                        {String(new Date(s.periodStart).getUTCMonth() + 1).padStart(2, "0")}
                        {"-"}
                        {new Date(s.periodStart).getUTCFullYear()}
                      </td>
                      <td className="px-3 py-3 text-left font-medium text-foreground">
                        {formatDate(s.periodStart)}{" "}
                        <span className="text-muted-foreground">–</span>{" "}
                        {formatDate(s.periodEnd)}
                      </td>
                      <td className="px-3 py-3 text-left text-muted-foreground">
                        {s.invoiceCount}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatMoney(Number(s.totalBilled ?? 0))}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatMoney(statementPaid(s))}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">
                        {statementBalanceDue(s) > 0 ? (
                          <span className="text-warning">{formatMoney(statementBalanceDue(s))}</span>
                        ) : (
                          <span className="text-muted-foreground">{formatMoney(0)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-left text-muted-foreground">
                        {s.lastEmailedAt ? (
                          <div
                            data-testid={`statement-last-emailed-${s.id}`}
                            className="text-emerald-600 dark:text-emerald-400"
                          >
                            Emailed {formatDate(s.lastEmailedAt)}
                            {s.lastEmailedTo ? ` to ${s.lastEmailedTo}` : ""}
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-left text-muted-foreground">
                        {formatDate(s.createdAt)}
                      </td>
                      <td className="px-3 py-3 text-left text-muted-foreground">
                        {s.paidAt ? formatDate(s.paidAt) : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-3 py-3 text-left text-muted-foreground">
                        {s.paymentMethod ? (
                          {
                            check: "Check",
                            card: "Card",
                            ach: "ACH",
                            cash: "Cash",
                            other: "Other",
                          }[s.paymentMethod] ?? s.paymentMethod
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {bundleAttachments.length === 0 && (
                            <button
                              type="button"
                              onClick={() => void handleStatementPdf(s)}
                              disabled={isDownloading || isEmailing}
                              title="Download PDF"
                              data-testid={`button-download-statement-${s.id}`}
                              className="h-7 px-2 rounded text-[11px] font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              {isDownloading ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <FileDown size={11} />
                              )}
                              PDF
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openResendForm(s)}
                            disabled={isDownloading || isEmailing}
                            title={
                              selected.billingEmail
                                ? `Resend the full statement bundle to ${selected.billingEmail} or another address`
                                : "Resend the full statement bundle by email"
                            }
                            data-testid={`button-resend-statement-${s.id}`}
                            className="h-7 px-2 rounded text-[11px] font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            {isEmailing ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <Send size={11} />
                            )}
                            Resend
                          </button>
                        </div>
                      </td>
                    </tr>
                    {bundleAttachments.length > 0 && (
                      <tr
                        key={`${s.id}-attachments`}
                        className="border-t-0 bg-secondary/15"
                        data-testid={`statement-attachments-${s.id}`}
                      >
                        <td colSpan={11} className="px-5 pb-3 pt-0">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <span className="text-[11px] text-muted-foreground">
                              Doctor PDFs:
                            </span>
                            {bundleAttachments.map((attachment) => (
                              <div
                                key={`${attachment.index}-${attachment.fileName}`}
                                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1"
                              >
                                <span className="mr-1 text-[11px] font-medium">
                                  {attachment.doctorName ||
                                    attachment.label ||
                                    attachment.fileName}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleStatementPdf(
                                      s,
                                      attachment,
                                      "open",
                                    )
                                  }
                                  disabled={isDownloading || isEmailing}
                                  data-testid={`button-open-statement-${s.id}-attachment-${attachment.index}`}
                                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-secondary disabled:opacity-50"
                                >
                                  {isDownloading ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    <FileText size={10} />
                                  )}
                                  Open
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleStatementPdf(
                                      s,
                                      attachment,
                                      "download",
                                    )
                                  }
                                  disabled={isDownloading || isEmailing}
                                  data-testid={`button-download-statement-${s.id}-attachment-${attachment.index}`}
                                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary disabled:opacity-50"
                                >
                                  <FileDown size={10} />
                                  Download
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openResendForm(s, attachment)}
                                  disabled={isDownloading || isEmailing}
                                  title={`Resend ${attachment.doctorName || attachment.label || attachment.fileName} by email`}
                                  data-testid={`button-resend-statement-${s.id}-attachment-${attachment.index}`}
                                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-secondary disabled:opacity-50"
                                >
                                  <Send size={10} />
                                  Resend
                                </button>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                    {resendFor?.statementId === s.id && (
                      <tr key={`${s.id}-resend`} className="border-t-0">
                        <td colSpan={11} className="px-5 pb-2.5 pt-0 text-right">
                          <div
                            data-testid={`resend-form-${s.id}${resendFormSuffix}`}
                            className="inline-flex flex-col items-end gap-1"
                          >
                            {resendAttachment && (
                              <span className="text-[11px] text-muted-foreground">
                                Resending{" "}
                                {resendAttachment.doctorName ||
                                  resendAttachment.label ||
                                  resendAttachment.fileName}
                              </span>
                            )}
                            <div className="inline-flex items-center gap-1.5">
                              <label
                                htmlFor={`resend-recipient-${s.id}${resendFormSuffix}`}
                                className="text-[11px] text-muted-foreground"
                              >
                                Send to:
                              </label>
                              <input
                                id={`resend-recipient-${s.id}${resendFormSuffix}`}
                                type="email"
                                value={resendEmail}
                                onChange={(e) => {
                                  setResendEmail(e.target.value);
                                  if (resendError) setResendError(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    handleResendSend(s);
                                  }
                                }}
                                placeholder="recipient@example.com"
                                autoFocus
                                data-testid={`input-resend-recipient-${s.id}${resendFormSuffix}`}
                                className="h-7 w-64 px-2 rounded text-[11px] bg-secondary border border-border focus:outline-none focus:ring-1 focus:ring-ring"
                              />
                              <button
                                type="button"
                                onClick={() => handleResendSend(s)}
                                disabled={isEmailing}
                                data-testid={`button-resend-send-${s.id}${resendFormSuffix}`}
                                className="h-7 px-2.5 rounded text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                              >
                                {isEmailing ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <Send size={11} />
                                )}
                                Send
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setResendFor(null);
                                  setResendError(null);
                                }}
                                disabled={isEmailing}
                                data-testid={`button-resend-cancel-${s.id}${resendFormSuffix}`}
                                className="h-7 px-2 rounded text-[11px] font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                            {resendError && (
                              <span
                                data-testid={`resend-recipient-error-${s.id}${resendFormSuffix}`}
                                className="text-[11px] text-destructive"
                              >
                                {resendError}
                              </span>
                            )}
                            {billingCcEmails.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1 mt-0.5">
                                <span className="text-[11px] text-muted-foreground">Auto-CC:</span>
                                {billingCcEmails.map((e) => (
                                  <span
                                    key={e.id}
                                    className="inline-flex items-center h-5 px-2 rounded-full bg-secondary border border-border text-[11px] text-muted-foreground"
                                  >
                                    {e.email}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {rowNotice?.id === s.id && (
                      <tr key={`${s.id}-notice`} className="border-t-0">
                        <td colSpan={11} className="px-5 pb-2.5 pt-0 text-right">
                          <span
                            data-testid={`statement-row-notice-${s.id}`}
                            className={
                              rowNotice.kind === "success"
                                ? "text-[11px] text-emerald-600 dark:text-emerald-400"
                                : "text-[11px] text-destructive"
                            }
                          >
                            {rowNotice.text}
                          </span>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {sendOpen && (
        <StatementBuilderDialog
          knownLabOrgId={labOrgId}
          knownPracticeId={selected.id}
          onClose={() => {
            setSendOpen(false);
            queryClient.invalidateQueries({ queryKey: ["practice-statements"] });
          }}
        />
      )}
    </div>
  );
}

// ── Card on File tab ───────────────────────────────────────────────────────

type LabCard = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

type LabCardResponse = {
  autoPay: { enabled: boolean; dayOfMonth: number | null };
};

type CardChargeResult = {
  checkoutId: string;
  status: string;
  totalAmount: string | number;
  failureReason?: string | null;
};

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lab-card-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// hint: Logic changed on both sides. Requires understanding intent of each change.
export function CardOnFileTab({
  practice,
  labOrgId,
}: {
  practice: Organization;
  labOrgId?: string;
}) {
  const [authorizationView, setAuthorizationView] = useState<AuthorizationRecord | null>(null);
  const [authorizationPreviewUrl, setAuthorizationPreviewUrl] = useState<string | null>(null);
  const [authorizationPreviewLoading, setAuthorizationPreviewLoading] = useState(false);
  const [authorizationPreviewError, setAuthorizationPreviewError] = useState<string | null>(null);
  const [uploadType, setUploadType] = useState<"card_on_file" | "autopay">("card_on_file");
  const [supersedesRecord, setSupersedesRecord] = useState<AuthorizationRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set());
  const [invoiceOffset, setInvoiceOffset] = useState(0);
  const [loadedInvoices, setLoadedInvoices] = useState<Invoice[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [chargeConfirmed, setChargeConfirmed] = useState(false);
  const [chargeResult, setChargeResult] = useState<CardChargeResult | null>(null);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [setupPolling, setSetupPolling] = useState(false);
  const [setupSessionId, setSetupSessionId] = useState<string | null>(null);
  const setupTerminalEventsRef = useRef<Set<string>>(new Set());
  const setupCardSignatureRef = useRef<string | null>(null);
  const chargeKeyStorage = `lab-card-charge:${labOrgId ?? "none"}:${practice.id}`;
  const chargeKeyRef = useRef<string | null>(
    typeof window !== "undefined" ? window.sessionStorage.getItem(chargeKeyStorage) : null,
  );
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canBill =
    user?.role === "owner" || user?.role === "admin" || user?.role === "billing";

  const sharedAccountQuery = useQuery({
    queryKey: ["shared-provider-account", labOrgId, practice.id],
    queryFn: () =>
      apiFetch<SharedProviderAccountData>(
        `/organizations/shared-accounts?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}&providerOrganizationId=${encodeURIComponent(practice.id)}`,
      ),
    enabled: !!labOrgId && !!practice.id && canBill,
  });
  const autoPayQuery = useQuery({
    queryKey: ["provider-lab-card", labOrgId, practice.id],
    queryFn: () =>
      apiFetch<LabCardResponse>(
        `/provider/lab-card?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}&providerOrganizationId=${encodeURIComponent(practice.id)}`,
      ),
    enabled: !!labOrgId && !!practice.id && canBill,
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices", { practiceId: practice.id, invoiceOffset }],
    queryFn: () =>
      apiFetch<PagedRows<Invoice> | Invoice[]>(
        `/invoices?practiceId=${encodeURIComponent(practice.id)}&limit=10&offset=${invoiceOffset}`,
      ),
    enabled: !!practice.id && canBill,
  });
  useEffect(() => {
    const response = invoicesQuery.data;
    if (!response) return;
    const page = Array.isArray(response)
      ? { rows: response, offset: 0, total: response.length, hasMore: false }
      : response;
    setLoadedInvoices((current) => {
      if (page.offset === 0) return page.rows;
      const existing = new Set(current.map((invoice) => invoice.id));
      return [...current, ...page.rows.filter((invoice) => !existing.has(invoice.id))];
    });
  }, [invoicesQuery.data]);
  useEffect(() => {
    setInvoiceOffset(0);
    setLoadedInvoices([]);
  }, [practice.id]);
  const authorizationsQuery = useQuery({
    queryKey: ["provider-authorizations", labOrgId, practice.id],
    queryFn: () =>
      apiFetch<AuthorizationRecord[]>(
        `/admin/practices/${encodeURIComponent(practice.id)}/authorization-documents?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}`,
      ),
    enabled: !!labOrgId && !!practice.id && canBill,
  });

  // Hosted setup returns to this application in a separate window/tab. A focus
  // refresh also covers a provider closing the hosted page without navigation.
  useEffect(() => {
    if (!canBill) return;
    const refresh = () => {
      void sharedAccountQuery.refetch();
      void autoPayQuery.refetch();
      void invoicesQuery.refetch();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [
    canBill,
    sharedAccountQuery.refetch,
    autoPayQuery.refetch,
    invoicesQuery.refetch,
  ]);

  useEffect(() => {
    let active = true;
    if (!authorizationView) {
      setAuthorizationPreviewUrl(null);
      return;
    }
    setAuthorizationPreviewLoading(true);
    setAuthorizationPreviewError(null);
    void apiFetchArrayBuffer(
      `/admin/authorization-documents/${encodeURIComponent(authorizationView.id)}/preview?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}`,
    ).then((result) => {
      if (active) setAuthorizationPreviewUrl(URL.createObjectURL(new Blob([result.buffer], { type: "application/pdf" })));
    }).catch((error) => {
      if (active) setAuthorizationPreviewError(error instanceof ApiError ? error.message : "Unable to load signed PDF preview.");
    }).finally(() => {
      if (active) setAuthorizationPreviewLoading(false);
    });
    return () => {
      active = false;
      setAuthorizationPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    };
  }, [authorizationView]);

  useEffect(() => {
    if (!setupPolling) return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      if (setupSessionId) {
        void apiFetch<{ status: "succeeded" | "pending" | "expired" }>(
          `/provider/lab-card/setup-status/${encodeURIComponent(setupSessionId)}?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}`,
        ).then((status) => {
          if (status.status !== "pending") {
            if (!setupTerminalEventsRef.current.has(setupSessionId)) {
              setupTerminalEventsRef.current.add(setupSessionId);
              trackSavedCardSetup(status.status);
            }
            setSetupPolling(false);
            setSetupSessionId(null);
            void sharedAccountQuery.refetch();
            void autoPayQuery.refetch();
          } else if (Date.now() - startedAt >= 120_000) {
            setSetupPolling(false);
            setSetupSessionId(null);
          }
        }).catch(() => {
          // Keep polling through transient status failures until timeout.
        });
      } else if (Date.now() - startedAt >= 120_000) {
          setSetupPolling(false);
          void autoPayQuery.refetch();
      }
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [setupPolling, setupSessionId, labOrgId, sharedAccountQuery.refetch, autoPayQuery.refetch]);

  const payableInvoices = useMemo(
    () =>
      loadedInvoices.filter(
        (invoice) =>
          !invoice.frozen &&
          (invoice.status === "open" ||
            invoice.status === "partially_paid" ||
            invoice.status === "overdue") &&
          Number(invoice.balanceDue ?? invoice.total ?? 0) > 0,
      ),
    [loadedInvoices],
  );
  const allocations = useMemo(
    () =>
      payableInvoices
        .filter((invoice) => selectedInvoiceIds.has(invoice.id))
        .map((invoice) => ({
          invoiceId: invoice.id,
          amount: Number(amounts[invoice.id] ?? invoice.balanceDue ?? invoice.total ?? 0),
          balance: Number(invoice.balanceDue ?? invoice.total ?? 0),
          invoiceNumber: invoice.invoiceNumber,
        }))
        .filter((allocation) => Number.isFinite(allocation.amount) && allocation.amount > 0),
    [amounts, payableInvoices, selectedInvoiceIds],
  );
  const allocationTotal = allocations.reduce((total, allocation) => total + allocation.amount, 0);
  const allocationsValid =
    allocations.length > 0 &&
    allocations.every((allocation) => allocation.amount <= allocation.balance) &&
    allocations.length === selectedInvoiceIds.size;
  const hasMorePayableInvoices =
    !Array.isArray(invoicesQuery.data) && (invoicesQuery.data?.hasMore ?? false);

  const setupMutation = useMutation({
    mutationFn: () => {
      trackSavedCardSetup("started");
      return apiFetch<{ url: string; sessionId: string }>("/provider/lab-card/setup", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: labOrgId,
          providerOrganizationId: practice.id,
          successUrl: window.location.href,
          cancelUrl: window.location.href,
        }),
      });
    },
    onSuccess: ({ url, sessionId }) => {
      const card = sharedAccountQuery.data?.card;
      setupCardSignatureRef.current = card
        ? `${card.brand}:${card.last4}:${card.expMonth}:${card.expYear}:${card.updatedAt ?? ""}`
        : null;
      setSetupPolling(true);
      setSetupSessionId(sessionId);
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
  const chargeMutation = useMutation({
    mutationFn: () => {
      const idempotencyKey = chargeKeyRef.current ?? newIdempotencyKey();
      chargeKeyRef.current = idempotencyKey;
      window.sessionStorage.setItem(chargeKeyStorage, idempotencyKey);
      return apiFetch<CardChargeResult>("/provider/lab-card/charge", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: labOrgId,
          providerOrganizationId: practice.id,
          allocations: allocations.map(({ invoiceId, amount }) => ({ invoiceId, amount })),
          idempotencyKey,
        }),
      });
    },
    onSuccess: (result) => {
      setChargeResult(result);
      setChargeError(null);
      if (result.status !== "pending") {
        chargeKeyRef.current = null;
        window.sessionStorage.removeItem(chargeKeyStorage);
      }
      setChargeConfirmed(false);
      if (result.status !== "pending") {
        setSelectedInvoiceIds(new Set());
        setAmounts({});
      }
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-lab-card"] });
      void queryClient.invalidateQueries({ queryKey: ["shared-provider-account"] });
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      void queryClient.invalidateQueries({ queryKey: ["payment-history"] });
      void queryClient.invalidateQueries({ queryKey: ["receive-payments"] });
    },
    onError: (error) => {
      setChargeResult(null);
      setChargeError(error instanceof Error ? error.message : "Card charge failed.");
    },
  });

  function toggleInvoice(invoice: Invoice, checked: boolean) {
    if (chargeResult?.status !== "pending") {
      chargeKeyRef.current = null;
      window.sessionStorage.removeItem(chargeKeyStorage);
    }
    setChargeResult(null);
    setChargeError(null);
    setChargeConfirmed(false);
    setSelectedInvoiceIds((current) => {
      const next = new Set(current);
      if (checked) next.add(invoice.id);
      else next.delete(invoice.id);
      return next;
    });
    if (checked && amounts[invoice.id] === undefined) {
      setAmounts((current) => ({
        ...current,
        [invoice.id]: String(Number(invoice.balanceDue ?? invoice.total ?? 0)),
      }));
    }
  }

  async function downloadAuthorization(record: AuthorizationRecord) {
    const blob = await apiFetchArrayBuffer(
      `/admin/authorization-documents/${encodeURIComponent(record.id)}/download?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}`,
    );
    const url = URL.createObjectURL(new Blob([blob.buffer], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = record.originalFilename || `${record.authorizationType}-authorization-${record.id}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function uploadAuthorization(file: File) {
    setUploadError(null);
    if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Choose a PDF file.");
      return;
    }
    if (!labOrgId) {
      setUploadError("The lab could not be identified.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("authorizationType", uploadType);
      form.append("practiceOrganizationId", practice.id);
      form.append("labOrganizationId", labOrgId);
      if (supersedesRecord) form.append("supersedesDocumentId", supersedesRecord.id);
      await apiUploadWithProgress(`/admin/practices/${encodeURIComponent(practice.id)}/authorization-documents`, form);
      await authorizationsQuery.refetch();
      setSupersedesRecord(null);
    } catch (error) {
      setUploadError(error instanceof ApiError ? error.message : "Unable to upload authorization PDF.");
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {!canBill && (
          <div data-testid="card-on-file-access-notice" className="bg-secondary border border-border rounded-md px-3 py-2 text-xs text-muted-foreground">
            Card billing is available to owners, admins, and billing users.
          </div>
        )}

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CreditCard size={16} className="text-muted-foreground" />
              <span className="text-sm font-medium">Saved Card</span>
            </div>
            {canBill && (
              <button
                type="button"
                onClick={() => setupMutation.mutate()}
                disabled={!labOrgId || setupMutation.isPending}
                data-testid="button-card-setup"
                className="h-7 px-2.5 rounded text-xs font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1"
              >
                {setupMutation.isPending || setupPolling ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                {setupMutation.isPending
                  ? "Opening…"
                  : setupPolling
                    ? "Waiting for card…"
                    : sharedAccountQuery.data?.card
                      ? "Replace card"
                      : "Set up card"}
              </button>
            )}
          </div>

          {sharedAccountQuery.isLoading ? (
            <div className="text-xs text-muted-foreground"><Loader2 size={13} className="inline animate-spin mr-1.5" />Loading saved card…</div>
          ) : sharedAccountQuery.data?.card ? (
          <div data-testid="card-on-file-display" className="rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-white p-5 w-72 shadow-md select-none">
            <div className="flex items-center justify-between mb-6">
              <span className="text-xs text-white/60 uppercase tracking-widest font-medium">
                {sharedAccountQuery.data.card.brand} · Card on File
              </span>
              <CreditCard size={18} className="text-white/40" />
            </div>
            <div className="font-mono text-base tracking-widest mb-4 text-white/80">
              •••• •••• •••• {sharedAccountQuery.data.card.last4}
            </div>
            <div className="flex items-end justify-between">
              <div>
                <div className="text-[9px] text-white/40 uppercase tracking-widest mb-0.5">
                  Cardholder
                </div>
                <div className="text-sm font-medium truncate max-w-[160px]">
                  {practice.displayName || practice.name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[9px] text-white/40 uppercase tracking-widest mb-0.5">
                  Expires
                </div>
                <div className="text-sm font-medium text-white/60">{String(sharedAccountQuery.data.card.expMonth).padStart(2, "0")}/{String(sharedAccountQuery.data.card.expYear).slice(-2)}</div>
              </div>
            </div>
          </div>
          ) : (
            <p data-testid="card-on-file-empty" className="text-[11px] text-muted-foreground">
              No card on file. Set up a card to enable secure card charges.
            </p>
          )}
          {setupMutation.isError && <p data-testid="card-setup-error" className="mt-2 text-xs text-destructive">{(setupMutation.error as Error).message || "Unable to start card setup."}</p>}
          {sharedAccountQuery.isError && (
            <p data-testid="card-load-error" className="mt-2 text-xs text-destructive">
              {(sharedAccountQuery.error as Error).message || "Unable to load the shared card."}
            </p>
          )}
        </div>

        <div data-testid="autopay-status" className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2"><CalendarDays size={15} className="text-muted-foreground" /><span className="text-sm font-medium">Auto-pay</span></div>
          <p className="mt-2 text-xs text-muted-foreground">
            {autoPayQuery.data?.autoPay.enabled ? `Enabled${autoPayQuery.data.autoPay.dayOfMonth ? ` on day ${autoPayQuery.data.autoPay.dayOfMonth}` : ""}.` : "Not enabled."} Auto-pay is managed by the provider and is read-only here. Invoices are due by the 10th.
          </p>
        </div>

        {canBill && (
          <div data-testid="card-charge-review" className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2"><CreditCard size={15} className="text-muted-foreground" /><span className="text-sm font-medium">Charge saved card</span></div>
            {!sharedAccountQuery.data?.card ? (
              <p className="mt-2 text-xs text-muted-foreground">Set up a card before charging payable invoices.</p>
            ) : payableInvoices.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">There are no payable invoices for this practice.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {payableInvoices.map((invoice) => {
                  const balance = Number(invoice.balanceDue ?? invoice.total ?? 0);
                  return <div key={invoice.id} className="flex items-center gap-2 text-xs">
                    <input data-testid={`checkbox-charge-invoice-${invoice.id}`} type="checkbox" checked={selectedInvoiceIds.has(invoice.id)} onChange={(e) => toggleInvoice(invoice, e.target.checked)} />
                    <span className="flex-1 font-medium">{invoice.invoiceNumber} <span className="text-muted-foreground">({formatMoney(balance)} due)</span></span>
                    <input data-testid={`input-charge-amount-${invoice.id}`} aria-label={`Amount for invoice ${invoice.invoiceNumber}`} type="number" min="0.01" max={balance} step="0.01" disabled={!selectedInvoiceIds.has(invoice.id)} value={amounts[invoice.id] ?? String(balance)} onChange={(e) => { setAmounts((current) => ({ ...current, [invoice.id]: e.target.value })); setChargeConfirmed(false); }} className="h-7 w-24 px-2 rounded border border-border bg-secondary text-right tabular-nums disabled:opacity-50" />
                  </div>;
                })}
                {hasMorePayableInvoices && (
                  <button
                    type="button"
                    onClick={() => setInvoiceOffset((offset) => offset + 10)}
                    disabled={invoicesQuery.isFetching}
                    className="h-8 px-3 rounded border border-border text-xs hover:bg-secondary disabled:opacity-50"
                  >
                    {invoicesQuery.isFetching ? "Loading…" : "Load more invoices"}
                  </button>
                )}
                <div data-testid="text-charge-total" className="pt-2 border-t border-border text-right text-sm font-medium">Charge total: {formatMoney(allocationTotal)}</div>
                {!allocationsValid && selectedInvoiceIds.size > 0 && <p data-testid="charge-validation-error" className="text-xs text-destructive">Enter a positive amount that does not exceed each invoice balance.</p>}
                <label className="flex items-center gap-2 text-xs text-muted-foreground"><input data-testid="checkbox-confirm-card-charge" type="checkbox" checked={chargeConfirmed} onChange={(e) => setChargeConfirmed(e.target.checked)} disabled={!allocationsValid} /> I reviewed these allocations and authorize this charge.</label>
                <button data-testid="button-confirm-card-charge" type="button" onClick={() => chargeMutation.mutate()} disabled={!chargeConfirmed || !allocationsValid || chargeMutation.isPending} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5">{chargeMutation.isPending && <Loader2 size={12} className="animate-spin" />}Charge {formatMoney(allocationTotal)}</button>
                {chargeError && <p data-testid="card-charge-error" className="text-xs text-destructive">{chargeError}</p>}
                {chargeResult && <p data-testid="card-charge-result" className={chargeResult.failureReason ? "text-xs text-destructive" : "text-xs text-emerald-600 dark:text-emerald-400"}>{chargeResult.failureReason ? chargeResult.failureReason : `Charge ${chargeResult.status}: ${formatMoney(Number(chargeResult.totalAmount))}.`}</p>}
              </div>
            )}
          </div>
        )}

        {canBill && (
         <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <PenLine size={14} className="text-muted-foreground" />
            <span className="text-sm font-medium">Authorization Forms</span>
          </div>
            <p className="text-xs text-muted-foreground">{supersedesRecord ? `Upload the signed PDF that replaces “${supersedesRecord.originalFilename ?? "Authorization PDF"}”. The prior PDF will remain in history.` : "Upload a completed, signed PDF. Blank forms and in-app signing are not stored as practice authorizations."}</p>
           <div className="flex gap-2 flex-wrap items-center">
             <select aria-label="Authorization type" value={uploadType} onChange={(e) => setUploadType(e.target.value as "card_on_file" | "autopay")} className="h-8 rounded-md border border-border bg-secondary px-2 text-xs">
               <option value="card_on_file">Card on File</option>
               <option value="autopay">Auto-Pay</option>
             </select>
             <input ref={uploadInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadAuthorization(file); }} />
             <button type="button" data-testid="button-upload-authorization" onClick={() => uploadInputRef.current?.click()} disabled={uploading} className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground inline-flex items-center gap-1.5 disabled:opacity-50">
               {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} {uploading ? "Uploading…" : supersedesRecord ? "Upload replacement PDF" : "Upload signed PDF"}
             </button>
              {supersedesRecord && <button type="button" onClick={() => setSupersedesRecord(null)} disabled={uploading} className="h-8 px-3 rounded-md text-xs border border-border hover:bg-secondary disabled:opacity-50">Cancel replacement</button>}
           </div>
           {uploadError && <p data-testid="authorization-upload-error" role="alert" className="text-xs text-destructive">{uploadError}</p>}
         </div>
         )}
         {canBill && (
           <AuthorizationHistory
             records={authorizationsQuery.data ?? []}
             onView={setAuthorizationView}
             onDownload={(record) => void downloadAuthorization(record)}
              onReplace={(record) => {
                setSupersedesRecord(record);
                setUploadType(record.authorizationType ?? "card_on_file");
                setUploadError(null);
              }}
           />
         )}
          {canBill && labOrgId && (
            <LabAutoPayAuthorization
              labOrganizationId={labOrgId}
              providerOrganizationId={practice.id}
            />
          )}
       </div>

      {authorizationView && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-card border border-border rounded-lg p-5 w-full max-w-lg">
            <h3 className="font-semibold">Signed authorization</h3>
            <p className="text-sm mt-2">{authorizationView.originalFilename ?? "Authorization PDF"} · {formatDateTime(authorizationView.createdAt ?? null)}</p>
            <p className="text-xs text-muted-foreground mt-2">Uploaded by {authorizationView.uploaderUserId ?? "authorized user"}. This record is immutable after upload.</p>
            <div className="mt-4 rounded border border-border overflow-hidden bg-secondary min-h-48">
              {authorizationPreviewLoading && <p data-testid="authorization-preview-loading" className="p-4 text-xs text-muted-foreground">Loading signed PDF preview…</p>}
              {authorizationPreviewError && <p data-testid="authorization-preview-error" role="alert" className="p-4 text-xs text-destructive">{authorizationPreviewError}</p>}
              {authorizationPreviewUrl && <iframe data-testid="authorization-preview-frame" title="Signed authorization PDF preview" src={authorizationPreviewUrl} className="w-full h-96 bg-white" />}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" data-testid="button-view-download-authorization" onClick={() => void downloadAuthorization(authorizationView)} className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs">Download PDF</button>
              <button type="button" data-testid="button-close-authorization-view" onClick={() => setAuthorizationView(null)} className="h-8 px-3 rounded border border-border text-xs">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
/*
export function CardOnFileTab({
  practice,
  labOrgId,
}: {
  practice: Organization;
  labOrgId?: string;
}) {
  const [cardAuthOpen, setCardAuthOpen] = useState(false);
  const [autoPayAuthOpen, setAutoPayAuthOpen] = useState(false);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [chargeConfirmed, setChargeConfirmed] = useState(false);
  const [chargeResult, setChargeResult] = useState<CardChargeResult | null>(null);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [setupPolling, setSetupPolling] = useState(false);
  const setupCardSignatureRef = useRef<string | null>(null);
  const chargeKeyStorage = `lab-card-charge:${labOrgId ?? "none"}:${practice.id}`;
  const chargeKeyRef = useRef<string | null>(
    typeof window !== "undefined" ? window.sessionStorage.getItem(chargeKeyStorage) : null,
  );
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canBill =
    user?.role === "owner" || user?.role === "admin" || user?.role === "billing";

  const sharedAccountQuery = useQuery({
    queryKey: ["shared-provider-account", labOrgId, practice.id],
    queryFn: () =>
      apiFetch<SharedProviderAccountData>(
        `/organizations/shared-accounts?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}&providerOrganizationId=${encodeURIComponent(practice.id)}`,
      ),
    enabled: !!labOrgId && !!practice.id && canBill,
  });
  const autoPayQuery = useQuery({
    queryKey: ["provider-lab-card", labOrgId, practice.id],
    queryFn: () =>
      apiFetch<LabCardResponse>(
        `/provider/lab-card?labOrganizationId=${encodeURIComponent(labOrgId ?? "")}&providerOrganizationId=${encodeURIComponent(practice.id)}`,
      ),
    enabled: !!labOrgId && !!practice.id && canBill,
  });
  const invoicesQuery = useQuery({
    queryKey: ["invoices", { practiceId: practice.id }],
    queryFn: () =>
      apiFetch<Invoice[]>(`/invoices?practiceId=${encodeURIComponent(practice.id)}`),
    enabled: !!practice.id && canBill,
  });

  // Hosted setup returns to this application in a separate window/tab. A focus
  // refresh also covers a provider closing the hosted page without navigation.
  useEffect(() => {
    if (!canBill) return;
    const refresh = () => {
      void sharedAccountQuery.refetch();
      void autoPayQuery.refetch();
      void invoicesQuery.refetch();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [
    canBill,
    sharedAccountQuery.refetch,
    autoPayQuery.refetch,
    invoicesQuery.refetch,
  ]);

  useEffect(() => {
    if (!setupPolling) return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      void sharedAccountQuery.refetch().then((result) => {
        const card = result.data?.card;
        const signature = card
          ? `${card.brand}:${card.last4}:${card.expMonth}:${card.expYear}:${card.updatedAt ?? ""}`
          : null;
        if (
          signature !== setupCardSignatureRef.current ||
          Date.now() - startedAt >= 120_000
        ) {
          if (signature !== setupCardSignatureRef.current) {
            trackSavedCardSetup("succeeded");
          }
          setSetupPolling(false);
          void autoPayQuery.refetch();
        }
      });
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [setupPolling, sharedAccountQuery.refetch, autoPayQuery.refetch]);

  const payableInvoices = useMemo(
    () =>
      (invoicesQuery.data ?? []).filter(
        (invoice) =>
          !invoice.frozen &&
          (invoice.status === "open" ||
            invoice.status === "partially_paid" ||
            invoice.status === "overdue") &&
          Number(invoice.balanceDue ?? invoice.total ?? 0) > 0,
      ),
    [invoicesQuery.data],
  );
  const allocations = useMemo(
    () =>
      payableInvoices
        .filter((invoice) => selectedInvoiceIds.has(invoice.id))
        .map((invoice) => ({
          invoiceId: invoice.id,
          amount: Number(amounts[invoice.id] ?? invoice.balanceDue ?? invoice.total ?? 0),
          balance: Number(invoice.balanceDue ?? invoice.total ?? 0),
          invoiceNumber: invoice.invoiceNumber,
        }))
        .filter((allocation) => Number.isFinite(allocation.amount) && allocation.amount > 0),
    [amounts, payableInvoices, selectedInvoiceIds],
  );
  const allocationTotal = allocations.reduce((total, allocation) => total + allocation.amount, 0);
  const allocationsValid =
    allocations.length > 0 &&
    allocations.every((allocation) => allocation.amount <= allocation.balance) &&
    allocations.length === selectedInvoiceIds.size;

  const setupMutation = useMutation({
    mutationFn: () => {
      trackSavedCardSetup("started");
      return apiFetch<{ url: string }>("/provider/lab-card/setup", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: labOrgId,
          providerOrganizationId: practice.id,
          successUrl: window.location.href,
          cancelUrl: window.location.href,
        }),
      });
    },
    onSuccess: ({ url }) => {
      const card = sharedAccountQuery.data?.card;
      setupCardSignatureRef.current = card
        ? `${card.brand}:${card.last4}:${card.expMonth}:${card.expYear}:${card.updatedAt ?? ""}`
        : null;
      setSetupPolling(true);
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
  const chargeMutation = useMutation({
    mutationFn: () => {
      const idempotencyKey = chargeKeyRef.current ?? newIdempotencyKey();
      chargeKeyRef.current = idempotencyKey;
      window.sessionStorage.setItem(chargeKeyStorage, idempotencyKey);
      return apiFetch<CardChargeResult>("/provider/lab-card/charge", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId: labOrgId,
          providerOrganizationId: practice.id,
          allocations: allocations.map(({ invoiceId, amount }) => ({ invoiceId, amount })),
          idempotencyKey,
        }),
      });
    },
    onSuccess: (result) => {
      setChargeResult(result);
      setChargeError(null);
      if (result.status !== "pending") {
        chargeKeyRef.current = null;
        window.sessionStorage.removeItem(chargeKeyStorage);
      }
      setChargeConfirmed(false);
      if (result.status !== "pending") {
        setSelectedInvoiceIds(new Set());
        setAmounts({});
      }
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-lab-card"] });
      void queryClient.invalidateQueries({ queryKey: ["shared-provider-account"] });
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      void queryClient.invalidateQueries({ queryKey: ["payment-history"] });
      void queryClient.invalidateQueries({ queryKey: ["receive-payments"] });
    },
    onError: (error) => {
      setChargeResult(null);
      setChargeError(error instanceof Error ? error.message : "Card charge failed.");
    },
  });

  function toggleInvoice(invoice: Invoice, checked: boolean) {
    if (chargeResult?.status !== "pending") {
      chargeKeyRef.current = null;
      window.sessionStorage.removeItem(chargeKeyStorage);
    }
    setChargeResult(null);
    setChargeError(null);
    setChargeConfirmed(false);
    setSelectedInvoiceIds((current) => {
      const next = new Set(current);
      if (checked) next.add(invoice.id);
      else next.delete(invoice.id);
      return next;
    });
    if (checked && amounts[invoice.id] === undefined) {
      setAmounts((current) => ({
        ...current,
        [invoice.id]: String(Number(invoice.balanceDue ?? invoice.total ?? 0)),
      }));
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {!canBill && (
          <div data-testid="card-on-file-access-notice" className="bg-secondary border border-border rounded-md px-3 py-2 text-xs text-muted-foreground">
            Card billing is available to owners, admins, and billing users.
          </div>
        )}

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CreditCard size={16} className="text-muted-foreground" />
              <span className="text-sm font-medium">Saved Card</span>
            </div>
            {canBill && (
              <button
                type="button"
                onClick={() => setupMutation.mutate()}
                disabled={!labOrgId || setupMutation.isPending}
                data-testid="button-card-setup"
                className="h-7 px-2.5 rounded text-xs font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1"
              >
                {setupMutation.isPending || setupPolling ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                {setupMutation.isPending
                  ? "Opening…"
                  : setupPolling
                    ? "Waiting for card…"
                    : sharedAccountQuery.data?.card
                      ? "Replace card"
                      : "Set up card"}
              </button>
            )}
          </div>

          {sharedAccountQuery.isLoading ? (
            <div className="text-xs text-muted-foreground"><Loader2 size={13} className="inline animate-spin mr-1.5" />Loading saved card…</div>
          ) : sharedAccountQuery.data?.card ? (
          <div data-testid="card-on-file-display" className="rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-white p-5 w-72 shadow-md select-none">
            <div className="flex items-center justify-between mb-6">
              <span className="text-xs text-white/60 uppercase tracking-widest font-medium">
                {sharedAccountQuery.data.card.brand} · Card on File
              </span>
              <CreditCard size={18} className="text-white/40" />
            </div>
            <div className="font-mono text-base tracking-widest mb-4 text-white/80">
              •••• •••• •••• {sharedAccountQuery.data.card.last4}
            </div>
            <div className="flex items-end justify-between">
              <div>
                <div className="text-[9px] text-white/40 uppercase tracking-widest mb-0.5">
                  Cardholder
                </div>
                <div className="text-sm font-medium truncate max-w-[160px]">
                  {practice.displayName || practice.name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[9px] text-white/40 uppercase tracking-widest mb-0.5">
                  Expires
                </div>
                <div className="text-sm font-medium text-white/60">{String(sharedAccountQuery.data.card.expMonth).padStart(2, "0")}/{String(sharedAccountQuery.data.card.expYear).slice(-2)}</div>
              </div>
            </div>
          </div>
          ) : (
            <p data-testid="card-on-file-empty" className="text-[11px] text-muted-foreground">
              No card on file. Set up a card to enable secure card charges.
            </p>
          )}
          {setupMutation.isError && <p data-testid="card-setup-error" className="mt-2 text-xs text-destructive">{(setupMutation.error as Error).message || "Unable to start card setup."}</p>}
          {sharedAccountQuery.isError && (
            <p data-testid="card-load-error" className="mt-2 text-xs text-destructive">
              {(sharedAccountQuery.error as Error).message || "Unable to load the shared card."}
            </p>
          )}
        </div>

        <div data-testid="autopay-status" className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2"><CalendarDays size={15} className="text-muted-foreground" /><span className="text-sm font-medium">Auto-pay</span></div>
          <p className="mt-2 text-xs text-muted-foreground">
            {autoPayQuery.data?.autoPay.enabled ? `Enabled${autoPayQuery.data.autoPay.dayOfMonth ? ` on day ${autoPayQuery.data.autoPay.dayOfMonth}` : ""}.` : "Not enabled."} Auto-pay is managed by the provider and is read-only here. Invoices are due by the 10th.
          </p>
        </div>

        {canBill && (
          <div data-testid="card-charge-review" className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2"><CreditCard size={15} className="text-muted-foreground" /><span className="text-sm font-medium">Charge saved card</span></div>
            {!sharedAccountQuery.data?.card ? (
              <p className="mt-2 text-xs text-muted-foreground">Set up a card before charging payable invoices.</p>
            ) : payableInvoices.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">There are no payable invoices for this practice.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {payableInvoices.map((invoice) => {
                  const balance = Number(invoice.balanceDue ?? invoice.total ?? 0);
                  return <div key={invoice.id} className="flex items-center gap-2 text-xs">
                    <input data-testid={`checkbox-charge-invoice-${invoice.id}`} type="checkbox" checked={selectedInvoiceIds.has(invoice.id)} onChange={(e) => toggleInvoice(invoice, e.target.checked)} />
                    <span className="flex-1 font-medium">{invoice.invoiceNumber} <span className="text-muted-foreground">({formatMoney(balance)} due)</span></span>
                    <input data-testid={`input-charge-amount-${invoice.id}`} aria-label={`Amount for invoice ${invoice.invoiceNumber}`} type="number" min="0.01" max={balance} step="0.01" disabled={!selectedInvoiceIds.has(invoice.id)} value={amounts[invoice.id] ?? String(balance)} onChange={(e) => { setAmounts((current) => ({ ...current, [invoice.id]: e.target.value })); setChargeConfirmed(false); }} className="h-7 w-24 px-2 rounded border border-border bg-secondary text-right tabular-nums disabled:opacity-50" />
                  </div>;
                })}
                <div data-testid="text-charge-total" className="pt-2 border-t border-border text-right text-sm font-medium">Charge total: {formatMoney(allocationTotal)}</div>
                {!allocationsValid && selectedInvoiceIds.size > 0 && <p data-testid="charge-validation-error" className="text-xs text-destructive">Enter a positive amount that does not exceed each invoice balance.</p>}
                <label className="flex items-center gap-2 text-xs text-muted-foreground"><input data-testid="checkbox-confirm-card-charge" type="checkbox" checked={chargeConfirmed} onChange={(e) => setChargeConfirmed(e.target.checked)} disabled={!allocationsValid} /> I reviewed these allocations and authorize this charge.</label>
                <button data-testid="button-confirm-card-charge" type="button" onClick={() => chargeMutation.mutate()} disabled={!chargeConfirmed || !allocationsValid || chargeMutation.isPending} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5">{chargeMutation.isPending && <Loader2 size={12} className="animate-spin" />}Charge {formatMoney(allocationTotal)}</button>
                {chargeError && <p data-testid="card-charge-error" className="text-xs text-destructive">{chargeError}</p>}
                {chargeResult && <p data-testid="card-charge-result" className={chargeResult.failureReason ? "text-xs text-destructive" : "text-xs text-emerald-600 dark:text-emerald-400"}>{chargeResult.failureReason ? chargeResult.failureReason : `Charge ${chargeResult.status}: ${formatMoney(Number(chargeResult.totalAmount))}.`}</p>}
              </div>
            )}
          </div>
        )}

        {canBill && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <PenLine size={14} className="text-muted-foreground" />
            <span className="text-sm font-medium">Authorization Forms</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Open, edit, and send authorization forms to collect written consent for card-on-file and
            auto-pay billing. Forms include editable body text and signature / date / initials field
            placeholders.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setCardAuthOpen(true)}
              data-testid="button-card-authorization-form"
              className="h-8 px-3 rounded-md text-sm font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1.5"
            >
              <FileText size={13} />
              Card on File Authorization
            </button>
            <button
              type="button"
              onClick={() => setAutoPayAuthOpen(true)}
              data-testid="button-autopay-authorization-form"
              className="h-8 px-3 rounded-md text-sm font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1.5"
            >
              <FileText size={13} /> Auto-Pay Authorization
            </button>
          </div>
        </div>
        )}
        {canBill && labOrgId && autoPayAuthOpen && (
          <LabAutoPayAuthorization
            labOrganizationId={labOrgId}
            providerOrganizationId={practice.id}
          />
        )}
      </div>

      {cardAuthOpen && (
        <AuthFormModal
          title="Card on File Authorization"
          defaultContent={CARD_AUTH_DEFAULT}
          practiceName={practice.displayName || practice.name}
          practiceEmail={practice.billingEmail}
          onClose={() => setCardAuthOpen(false)}
        />
      )}
    </div>
  );
}
*/

// ── Invoices tab ───────────────────────────────────────────────────────────

export function InvoicesTab({
  practice,
  labOrgId,
}: {
  practice: Organization;
  labOrgId: string;
}) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { user } = useAuth();

  const isAdmin = user?.role === "owner" || user?.role === "admin";

  // Only needed for the admin "Reassign all…" destination list.
  const orgsQuery = useQuery({
    queryKey: ["organizations", { includeLabPractices: true }],
    queryFn: () =>
      apiFetch<Organization[]>("/organizations?includeLabPractices=true"),
    enabled: isAdmin,
  });

  const [filterBy, setFilterBy] = useState<"all" | "open" | "overdue" | "paid">("all");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [invoiceOffset, setInvoiceOffset] = useState(0);
  const [loadedInvoices, setLoadedInvoices] = useState<Invoice[]>([]);

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [reassignSuccess, setReassignSuccess] = useState<string | null>(null);
  const [nonVoidedCount, setNonVoidedCount] = useState(0);

  const reassignMutation = useMutation({
    mutationFn: async ({
      labOrganizationId,
      fromProviderOrganizationId,
      toProviderOrganizationId,
    }: {
      labOrganizationId: string;
      fromProviderOrganizationId: string;
      toProviderOrganizationId: string;
    }) => {
      return apiFetch<{ movedCount: number }>("/invoices/bulk-reassign", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId,
          fromProviderOrganizationId,
          toProviderOrganizationId,
        }),
      });
    },
    onSuccess: (data) => {
      setReassignSuccess(
        data.movedCount === 0
          ? "No invoices to move."
          : `Moved ${data.movedCount} invoice${data.movedCount !== 1 ? "s" : ""} successfully.`,
      );
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (err) => {
      setReassignError(
        err instanceof ApiError ? err.message : "Reassignment failed.",
      );
    },
  });

  const otherPractices = useMemo(
    () =>
      (orgsQuery.data ?? [])
        .filter(
          (o) =>
            o.type === "provider" &&
            !o.deletedAt &&
            o.id !== practice.id,
        )
        .sort((a, b) =>
          (a.displayName || a.name).localeCompare(b.displayName || b.name),
        ),
    [orgsQuery.data, practice.id],
  );

  const { from: rangeFrom, to: rangeTo } = resolveDateRange(dateRange, {
    from: customFrom,
    to: customTo,
  });

  const invoiceQueryPath = useMemo(() => {
    const params = new URLSearchParams({
      practiceId: practice.id,
      limit: "10",
      offset: String(invoiceOffset),
    });
    if (filterBy !== "all") {
      params.set("status", filterBy === "open" ? "open" : filterBy);
    }
    if (rangeFrom) params.set("dateFrom", rangeFrom.toISOString());
    if (rangeTo) params.set("dateTo", rangeTo.toISOString());
    return `/invoices?${params.toString()}`;
  }, [filterBy, invoiceOffset, practice.id, rangeFrom, rangeTo]);

  const practiceInvoicesQuery = useQuery({
    queryKey: ["invoices", { practiceId: practice.id, filterBy, rangeFrom, rangeTo, invoiceOffset }],
    queryFn: () => apiFetch<PagedRows<Invoice> | Invoice[]>(invoiceQueryPath),
    enabled: !!practice.id,
  });

  useEffect(() => {
    setInvoiceOffset(0);
    setLoadedInvoices([]);
  }, [filterBy, rangeFrom?.getTime(), rangeTo?.getTime(), practice.id]);

  useEffect(() => {
    const response = practiceInvoicesQuery.data;
    if (!response) return;
    const page = Array.isArray(response)
      ? { rows: response, offset: 0, total: response.length, hasMore: false }
      : response;
    setLoadedInvoices((current) => {
      if (page.offset === 0) return page.rows;
      const existing = new Set(current.map((invoice) => invoice.id));
      return [...current, ...page.rows.filter((invoice) => !existing.has(invoice.id))];
    });
  }, [practiceInvoicesQuery.data]);

  const practiceInvoices = loadedInvoices;
  const matchingInvoiceTotal = Array.isArray(practiceInvoicesQuery.data)
    ? practiceInvoicesQuery.data.length
    : practiceInvoicesQuery.data?.total ?? loadedInvoices.length;
  const hasMoreInvoices =
    !Array.isArray(practiceInvoicesQuery.data) &&
    (practiceInvoicesQuery.data?.hasMore ?? false);
  const isLoadingMoreInvoices =
    practiceInvoicesQuery.isFetching && !practiceInvoicesQuery.isLoading;

  const invCols = useTableColumns<Invoice>(
    [
      { id: "invoiceNumber", label: "Num", menuLabel: "Num", align: "left", defaultWidth: 100, render: (inv) => <span className="font-mono text-xs">{inv.invoiceNumber}</span> },
      { id: "issuedAt", label: "Date", menuLabel: "Date", align: "left", defaultWidth: 100, render: (inv) => <span className="text-muted-foreground">{formatDate(inv.issuedAt)}</span> },
      { id: "patient", label: "Patient", menuLabel: "Patient", align: "left", defaultWidth: 130, render: (inv) => {
        const patientName = inv.displayMetadata?.patientName ?? inv.displayMetadataJson?.patientName ?? null;
        return patientName ?? <span className="text-muted-foreground/50">—</span>;
      } },
      { id: "lineItem", label: "Line Item", menuLabel: "Line Item", align: "left", defaultWidth: 160, render: (inv) => {
        const lineItem = inv.items?.[0]?.description ?? inv.displayMetadata?.lineItems?.[0]?.description ?? inv.displayMetadataJson?.lineItems?.[0]?.description ?? null;
        return lineItem ? (
          <span className="truncate block max-w-[160px]" title={lineItem}>{lineItem}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      } },
      { id: "dueDate", label: "Due Date", menuLabel: "Due Date", align: "left", defaultWidth: 100, render: (inv) => <span className="text-muted-foreground">{formatDate(inv.dueAt ?? inv.dueDate)}</span> },
      { id: "caseCompleted", label: "Case Completed", menuLabel: "Case Completed", align: "left", defaultWidth: 130, render: (inv) => {
        const caseCompletedAt = inv.caseCompletedAt ? formatDateTime(inv.caseCompletedAt) : null;
        return caseCompletedAt ?? <span className="text-muted-foreground/50">—</span>;
      } },
      { id: "status", label: "Status", menuLabel: "Status", align: "left", defaultWidth: 110, render: (inv) => <StatusBadge status={inv.status} /> },
      { id: "aging", label: "Aging", menuLabel: "Aging", align: "right", defaultWidth: 80, render: (inv) => {
        const aging = agingDays(inv);
        return aging != null ? (
          <span className="inline-flex items-center gap-1 text-destructive text-xs font-medium">
            <AlertCircle size={11} />
            {aging}d
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      } },
      { id: "amount", label: "Amount", menuLabel: "Amount", align: "right", defaultWidth: 100, render: (inv) => <span className="tabular-nums font-medium">{formatMoney(inv.total)}</span> },
      { id: "openBalance", label: "Open Balance", menuLabel: "Open Balance", align: "right", defaultWidth: 110, render: (inv) => {
        return Number(inv.balanceDue ?? inv.total ?? 0) > 0 ? (
          <span className="text-warning font-medium tabular-nums">
            {formatMoney(inv.balanceDue ?? inv.total)}
          </span>
        ) : (
          <span className="text-muted-foreground tabular-nums">{formatMoney(0)}</span>
        );
      } },
    ],
    "labtrax_customer_center_cols_v1",
  );

  const invColumnTotals: Record<
    string,
    Array<string | number | null | undefined>
  > = {
    amount: practiceInvoices.map((inv) => inv.total),
    openBalance: practiceInvoices.map((inv) => inv.balanceDue ?? inv.total),
  };

  const invColumnOptions = invCols.defs.map((d) => ({
    id: d.id,
    label: d.menuLabel,
    visible: !invCols.state.hidden.includes(d.id),
    index: invCols.state.order.indexOf(d.id),
  }));

  async function handleExportStatementPdf() {
    const exportParams = new URLSearchParams({ practiceId: practice.id });
    if (filterBy !== "all") {
      exportParams.set("status", filterBy === "open" ? "open" : filterBy);
    }
    if (rangeFrom) exportParams.set("dateFrom", rangeFrom.toISOString());
    if (rangeTo) exportParams.set("dateTo", rangeTo.toISOString());
    const allMatchingInvoices = await apiFetch<Invoice[]>(
      `/invoices?${exportParams.toString()}`,
    );
    const { buffer } = await apiFetchArrayBuffer(
      `/lab-orgs/${labOrgId}/statements/preview-pdf`,
      {
        method: "POST",
        body: JSON.stringify({
          recipientType: "practice",
          recipientKey: practice.id,
          invoiceScope: "all",
          from: null,
          to: null,
          asOf: null,
          periodLabel: null,
          invoiceIds: allMatchingInvoices.map((invoice) => invoice.id),
        }),
      },
    );
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `statement-${practice.displayName || practice.name}-${new Date().toISOString().slice(0, 10)}.pdf`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-5 py-2.5 border-b border-border bg-card/50 flex flex-wrap items-center gap-3 shrink-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium">Filter:</span>
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as any)}
            className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="overdue">Overdue</option>
            <option value="paid">Paid</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarDays size={12} />
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangeKey)}
            className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
          >
            <option value="all">All Dates</option>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_quarter">This Quarter</option>
            <option value="last_quarter">Last Quarter</option>
            <option value="this_year">This Year</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        {dateRange === "custom" && (
          <div className="flex items-center gap-1.5 text-xs">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
            />
            <span className="text-muted-foreground">–</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
            />
          </div>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
           Showing {practiceInvoices.length} of {matchingInvoiceTotal}
        </span>
        <ColumnSettingsPopover
          columns={invColumnOptions}
          onToggle={invCols.toggleColumn}
          onMove={invCols.moveColumn}
          onReset={invCols.resetAll}
        />
        <button
          type="button"
          onClick={handleExportStatementPdf}
           disabled={practiceInvoicesQuery.isLoading}
           title={practiceInvoicesQuery.isLoading ? "Loading invoices…" : "Export statement as PDF"}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
           {practiceInvoicesQuery.isLoading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <FileDown size={12} />
          )}
          Export PDF
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              setReassignTargetId("");
              setReassignError(null);
              setReassignSuccess(null);
              setNonVoidedCount(0);
              reassignMutation.reset();
              setReassignOpen(true);
              void apiFetch<Invoice[]>(
                `/invoices?practiceId=${encodeURIComponent(practice.id)}`,
              ).then((invoices) => {
                setNonVoidedCount(invoices.filter((invoice) => invoice.status !== "void").length);
              }).catch(() => {
                setReassignError("Unable to count invoices for reassignment.");
              });
            }}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded bg-secondary text-xs text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors border border-border"
          >
            <ArrowRightLeft size={11} />
            Reassign all…
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <table className="text-sm" style={{ tableLayout: "fixed", width: invCols.visible.reduce((sum, c) => sum + invCols.getWidth(c.id), 0) }}>
          <colgroup>
            {invCols.visible.map((col) => (
              <col key={col.id} style={{ width: invCols.getWidth(col.id) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm">
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {invCols.visible.map((col) => (
                <th
                  key={col.id}
                  className={`${col.align === "right" ? "text-right" : "text-left"} px-3 py-2.5 relative font-medium`}
                  style={{ overflow: "hidden" }}
                >
                  {col.label}
                  {invColumnTotals[col.id] && (
                    <ColumnTotal
                      values={invColumnTotals[col.id]}
                      loading={practiceInvoicesQuery.isLoading}
                      testId={`column-total-${col.id}`}
                    />
                  )}
                  <div
                    onMouseDown={(e) => invCols.startResize(col.id, e)}
                    onDoubleClick={() => invCols.resetWidth(col.id)}
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
                      className={`w-0.5 transition-colors duration-100 ${invCols.resizingId === col.id ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                      style={{ display: "block", height: "100%" }}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
             {practiceInvoicesQuery.isLoading && (
              <tr>
                <td colSpan={Math.max(1, invCols.visible.length)} className="px-5 py-12 text-center text-muted-foreground">
                  <Loader2 size={16} className="inline animate-spin mr-2" />
                  Loading invoices…
                </td>
              </tr>
            )}
             {!practiceInvoicesQuery.isLoading && practiceInvoices.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, invCols.visible.length)} className="px-5 py-12 text-center text-muted-foreground">
                  No invoices match the current filters.
                </td>
              </tr>
            )}
            {practiceInvoices.map((inv) => (
              <tr
                key={inv.id}
                onClick={() => setEditingInvoice(inv)}
                onDoubleClick={() => setEditingInvoice(inv)}
                className="border-t border-border cursor-pointer hover:bg-secondary/40"
              >
                {invCols.visible.map((col) => (
                  <td key={col.id} className={`px-3 py-2.5 ${col.align === "right" ? "text-right" : "text-left"}`}>
                    {col.render(inv)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {hasMoreInvoices && (
          <div className="flex justify-center border-t border-border p-3">
            <button
              type="button"
              onClick={() => setInvoiceOffset((offset) => offset + 10)}
              disabled={isLoadingMoreInvoices}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-border bg-background text-xs font-medium hover:bg-secondary disabled:opacity-50"
            >
              {isLoadingMoreInvoices && <Loader2 size={12} className="animate-spin" />}
              {isLoadingMoreInvoices ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {editingInvoice && (
        <InvoiceEditor
          invoice={editingInvoice}
          onClose={() => {
            setEditingInvoice(null);
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
          }}
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

      {/* Bulk reassign dialog */}
      {reassignOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <ArrowRightLeft size={15} />
              </div>
              <div>
                <h2 className="text-base font-semibold">Reassign all invoices</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Move invoices from{" "}
                  <span className="font-medium text-foreground">
                    {practice.displayName || practice.name}
                  </span>{" "}
                  to another practice
                </p>
              </div>
            </div>

            {!reassignSuccess ? (
              <>
                <div className="rounded-md bg-secondary/60 px-4 py-3 mb-4 text-sm">
                  <span className="font-medium tabular-nums text-foreground">
                    {nonVoidedCount}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    non-void invoice{nonVoidedCount !== 1 ? "s" : ""} will be moved.
                  </span>
                </div>

                <div className="mb-4">
                  <label className="block text-xs font-medium mb-1.5">
                    Destination practice
                  </label>
                  <select
                    value={reassignTargetId}
                    onChange={(e) => {
                      setReassignTargetId(e.target.value);
                      setReassignError(null);
                    }}
                    className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                    disabled={reassignMutation.isPending}
                  >
                    <option value="">Select a practice…</option>
                    {otherPractices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName || p.name}
                      </option>
                    ))}
                  </select>
                </div>

                {reassignError && (
                  <div className="mb-4 text-xs text-destructive flex items-center gap-1.5">
                    <AlertCircle size={12} />
                    {reassignError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setReassignOpen(false)}
                    disabled={reassignMutation.isPending}
                    className="h-8 px-3 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!reassignTargetId || reassignMutation.isPending || nonVoidedCount === 0}
                    onClick={() => {
                      if (!reassignTargetId || !labOrgId) return;
                      setReassignError(null);
                      reassignMutation.mutate({
                        labOrganizationId: labOrgId,
                        fromProviderOrganizationId: practice.id,
                        toProviderOrganizationId: reassignTargetId,
                      });
                    }}
                    className="h-8 px-4 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    {reassignMutation.isPending ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Moving…
                      </>
                    ) : (
                      <>
                        <ArrowRightLeft size={12} />
                        Move {nonVoidedCount} invoice{nonVoidedCount !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-md bg-green-500/10 border border-green-500/20 px-4 py-3 mb-4 text-sm text-green-600 dark:text-green-400">
                  {reassignSuccess}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setReassignOpen(false)}
                    className="h-8 px-4 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CustomerStatementChargesTab({ selected, labOrgId }: { selected: Organization; labOrgId: string }) {
  const currentMonth = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
    return {
      from: `${year}-${month}-01`,
      to: `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
    };
  }, []);
  const [rangeMode, setRangeMode] = useState<"all" | "range">("all");
  const [rangeFrom, setRangeFrom] = useState(currentMonth.from);
  const [rangeTo, setRangeTo] = useState(currentMonth.to);
  const [chargeOffset, setChargeOffset] = useState(0);
  const [loadedCharges, setLoadedCharges] = useState<ChargeLedgerRow[]>([]);
  const rangeIncomplete = rangeMode === "range" && (!rangeFrom || !rangeTo);
  const rangeInvalid = rangeMode === "range" && !rangeIncomplete && rangeFrom > rangeTo;
  const queryPath = useMemo(() => {
    const base = `/billing/${encodeURIComponent(labOrgId)}/accounts/${encodeURIComponent(selected.id)}/statement-charges`;
    if (rangeMode === "all") {
      return `${base}?limit=10&offset=${chargeOffset}`;
    }
    let timeZone = "UTC";
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      // UTC remains a safe fallback when browser timezone detection is unavailable.
    }
    const params = new URLSearchParams({
      from: rangeFrom,
      to: rangeTo,
      timeZone,
      limit: "10",
      offset: String(chargeOffset),
    });
    return `${base}?${params.toString()}`;
  }, [chargeOffset, labOrgId, rangeFrom, rangeMode, rangeTo, selected.id]);
  const ledger = useQuery({
    queryKey: ["customer-statement-charges", selected.id, labOrgId, rangeMode, rangeFrom, rangeTo, chargeOffset],
    queryFn: () => apiFetch<StatementChargeResponse>(
      queryPath,
    ),
    enabled: !!selected.id && !!labOrgId && !rangeIncomplete && !rangeInvalid,
  });
  useEffect(() => {
    setChargeOffset(0);
    setLoadedCharges([]);
  }, [labOrgId, rangeMode, rangeFrom, rangeTo, selected.id]);

  useEffect(() => {
    const page = ledger.data;
    if (!page) return;
    setLoadedCharges((current) => {
      if (page.offset === 0) return page.rows;
      const existing = new Set(current.map((row) => row.id));
      return [...current, ...page.rows.filter((row) => !existing.has(row.id))];
    });
  }, [ledger.data]);

  const rows = loadedCharges;
  const totalRows = ledger.data?.total ?? loadedCharges.length;
  const hasMoreRows = ledger.data?.hasMore ?? false;
  const isLoadingMore = ledger.isFetching && !ledger.isLoading;
  const exportCharges = async () => {
    const base = `/billing/${encodeURIComponent(labOrgId)}/accounts/${encodeURIComponent(selected.id)}/statement-charges`;
    const params = new URLSearchParams();
    if (rangeMode === "range") {
      let timeZone = "UTC";
      try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        // UTC remains a safe fallback when browser timezone detection is unavailable.
      }
      params.set("from", rangeFrom);
      params.set("to", rangeTo);
      params.set("timeZone", timeZone);
    }
    const full = await apiFetch<{ rows?: ChargeLedgerRow[] } | ChargeLedgerRow[] | undefined>(
      `${base}${params.size ? `?${params.toString()}` : ""}`,
    );
    const exportRows = full
      ? Array.isArray(full)
        ? full
        : full.rows ?? []
      : rows;
    if (exportRows.length === 0) return;
    downloadCsv(
      `statement-charge-history-${safeFilename(selected.displayName || selected.name)}-${new Date().toISOString().slice(0, 10)}.csv`,
      exportRows.map((row) => ({
        Date: row.date || row.occurredAt || "",
        "Row Type": chargeRowType(row),
        "Invoice Number": row.invoiceNumber ?? "",
        Doctor: row.doctorName ?? "",
        Patient: row.patientName ?? "",
        "Invoice Amount": row.invoiceAmount ?? "",
        "Payment Amount": row.paymentAmount ?? "",
        "Payment Method": chargePaymentMethod(row),
        Reference: row.referenceNumber ?? "",
        Statement: row.statementLabel ?? "",
        Balance: row.balance ?? row.openBalance ?? "",
      })),
    );
  };
  return <div className="h-full overflow-y-auto scrollbar-thin">
    <div className="px-5 py-4 border-b border-border flex flex-wrap items-start justify-between gap-4">
      <div><h3 className="text-sm font-semibold">Customer statement charges</h3><p className="text-xs text-muted-foreground mt-1">Chronological invoices, statements, payments, and applied credits.</p></div>
      <button
        type="button"
        data-testid="button-export-statement-charges"
         onClick={() => void exportCharges()}
        disabled={rangeIncomplete || rangeInvalid || ledger.isLoading || ledger.isError || rows.length === 0}
        title={rows.length === 0 && !ledger.isLoading ? "No statement charges to export" : undefined}
        className="h-8 shrink-0 px-3 rounded border border-border bg-background text-xs font-medium hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
      >
        <FileDown size={13} />
        Export CSV
      </button>
      <div className="basis-full flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="statement-charge-range" className="font-medium text-muted-foreground">Show</label>
        <select
          id="statement-charge-range"
          data-testid="select-statement-charge-range"
          value={rangeMode}
          onChange={(event) => setRangeMode(event.target.value as "all" | "range")}
          className="h-8 px-2 rounded border border-border bg-background text-xs"
        >
          <option value="all">All history</option>
          <option value="range">Date range</option>
        </select>
        {rangeMode === "range" && <>
          <label htmlFor="statement-charge-from" className="text-muted-foreground">From</label>
          <input id="statement-charge-from" aria-label="Statement charges from" type="date" value={rangeFrom} onChange={(event) => setRangeFrom(event.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs" />
          <label htmlFor="statement-charge-to" className="text-muted-foreground">To</label>
          <input id="statement-charge-to" aria-label="Statement charges to" type="date" value={rangeTo} onChange={(event) => setRangeTo(event.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs" />
        </>}
      </div>
    </div>
    {rangeIncomplete && <div role="alert" className="m-5 text-sm text-destructive">Choose both a From date and a To date.</div>}
    {rangeInvalid && <div role="alert" className="m-5 text-sm text-destructive">The From date must be on or before the To date.</div>}
    {ledger.isLoading && <div className="py-12 text-center text-xs text-muted-foreground"><Loader2 size={14} className="inline animate-spin mr-1.5" />Loading charges…</div>}
    {ledger.isError && <div role="alert" className="m-5 text-sm text-destructive">Statement charge history is unavailable. {(ledger.error as Error).message}</div>}
    {!rangeIncomplete && !rangeInvalid && !ledger.isLoading && !ledger.isError && rows.length === 0 && <div data-testid="status-statement-charges-empty" className="py-12 text-center text-xs text-muted-foreground">{rangeMode === "range" ? "No statement charges exist in the selected period." : "No statement charges are available to export."}</div>}
     {!rangeIncomplete && !rangeInvalid && !ledger.isLoading && !ledger.isError && rows.length > 0 && <>
       <div className="px-5 py-2 text-[11px] text-muted-foreground tabular-nums">Showing {rows.length} of {totalRows}</div>
       <table className="w-full text-xs"><thead className="sticky top-0 bg-secondary/90"><tr className="text-left uppercase tracking-wide text-[10px] text-muted-foreground"><th className="px-5 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Invoice Number</th><th className="px-3 py-2">Doctor</th><th className="px-3 py-2">Patient</th><th className="px-3 py-2 text-right">Invoice Amount</th><th className="px-3 py-2 text-right">Payment Amount</th><th className="px-5 py-2 text-right">Open Balance</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || `${row.date || row.occurredAt}-${index}`} className="border-t border-border"><td className="px-5 py-2.5">{formatDate(row.date || row.occurredAt || null)}</td><td className="px-3 py-2.5 font-medium">{chargeRowType(row)}{(() => {
         // A rolled-up payment covers several invoices, so it is identified by
         // the payment itself rather than by any one invoice it settled.
         const details = [chargePaymentMethod(row), row.referenceNumber || "", row.statementLabel ? `Statement ${row.statementLabel}` : ""].filter(Boolean);
         return details.length ? <div className="font-normal text-[10px] text-muted-foreground">{details.join(" · ")}</div> : null;
       })()}</td><td className="px-3 py-2.5">{row.invoiceNumber || "—"}</td><td className="px-3 py-2.5">{row.doctorName || "—"}</td><td className="px-3 py-2.5">{row.patientName || "—"}</td><td className="px-3 py-2.5 text-right tabular-nums">{row.invoiceAmount == null ? "—" : formatMoney(Number(row.invoiceAmount))}</td><td className="px-3 py-2.5 text-right tabular-nums">{row.paymentAmount == null ? "—" : formatMoney(Number(row.paymentAmount))}</td><td className="px-5 py-2.5 text-right tabular-nums font-medium">{row.openBalance == null ? "—" : formatMoney(Number(row.openBalance))}</td></tr>)}</tbody></table>
       {hasMoreRows && <div className="flex justify-center border-t border-border p-3"><button type="button" onClick={() => setChargeOffset((offset) => offset + 10)} disabled={isLoadingMore} className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-border bg-background text-xs font-medium hover:bg-secondary disabled:opacity-50">{isLoadingMore && <Loader2 size={12} className="animate-spin" />}{isLoadingMore ? "Loading…" : "Load more"}</button></div>}
     </>}
  </div>;
}
