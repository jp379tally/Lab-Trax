// Customer detail tabs — shared by the slide-in customer window (PracticeEditor)
// opened from the Accounts page. Originally built for the (now retired)
// Customer Center page; the Invoices / Statements / Card on File tab content
// lives here so every customer's window gets the full 4-tab experience.
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  Trash2,
  X,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, Organization, PracticeStatement } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceEditor, StatementBuilderDialog } from "@/pages/invoices";
import { downloadStatementPdf } from "@/lib/export";
import { useTableColumns } from "@/hooks/useTableColumns";
import { ColumnSettingsPopover } from "@/components/ColumnSettingsPopover";

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

export type DetailTab = "basic" | "invoices" | "statements" | "card";

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "basic", label: "Basic Info" },
  { id: "invoices", label: "Invoices" },
  { id: "statements", label: "Statements" },
  { id: "card", label: "Card on File" },
];

// ── Authorization form modal ───────────────────────────────────────────────

const SIGNATURE_FIELDS = [
  { label: "Signature", placeholder: "[SIGNATURE]" },
  { label: "Date", placeholder: "[DATE]" },
  { label: "Initials", placeholder: "[INITIALS]" },
  { label: "Printed Name", placeholder: "[PRINTED_NAME]" },
];

const CARD_AUTH_DEFAULT = `CARD ON FILE AUTHORIZATION

Practice Name: ___________________________
Authorized Signatory: ___________________________

I, the undersigned, hereby authorize [LAB NAME] to charge the credit/debit card on file for:
- Outstanding invoices as they become due
- Amounts agreed upon in advance

This authorization will remain in effect until cancelled in writing.

Doctor(s) covered by this authorization:
[DOCTOR_LIST]


[SIGNATURE]                    [DATE]
Authorized Signature           Date

[PRINTED_NAME]
Print Name`;

const AUTOPAY_AUTH_DEFAULT = `AUTO-PAY AUTHORIZATION

Practice Name: ___________________________
Account Number: ___________________________

I authorize [LAB NAME] to automatically charge the credit/debit card on file on or after each invoice due date.

I understand that:
- Charges will appear on my statement as [LAB NAME]
- I will receive invoices by email prior to each charge
- I may cancel this authorization with 7 days written notice

Doctor(s) included:
[DOCTOR_LIST]


[SIGNATURE]                    [DATE]
Authorized Signature           Date

[INITIALS] ______    I confirm I have read and agree to the above terms.`;

function AuthFormModal({
  title,
  defaultContent,
  practiceName,
  practiceEmail,
  onClose,
}: {
  title: string;
  defaultContent: string;
  practiceName: string;
  practiceEmail?: string | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState(defaultContent);
  const [emailTo, setEmailTo] = useState(practiceEmail || "");
  const [sendStatus, setSendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) {
      setContent((c) => c + "\n" + text);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = content.slice(0, start) + text + content.slice(end);
    setContent(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + text.length;
      el.focus();
    });
  }

  async function handleSendEmail() {
    const to = emailTo.trim();
    if (!to) return;
    setSendStatus("sending");
    setSendError(null);
    try {
      await apiFetch("/admin/auth-form-email", {
        method: "POST",
        body: JSON.stringify({
          to,
          subject: `${title} — ${practiceName}`,
          body: content,
        }),
      });
      setSendStatus("sent");
    } catch (err) {
      setSendStatus("error");
      setSendError(err instanceof ApiError ? err.message : "Failed to send email.");
    }
    /* TODO: Replace with a true e-signature flow (DocuSign or similar) that
       captures a timestamped, IP-bound signature, handles field-placement in
       the PDF, and routes the completed signed document back to the lab record.
       The current implementation sends the form text as a plain email. */
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h3 className="text-base font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-secondary"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <strong>Foundation only:</strong> This form can be edited and sent by email. True drag-and-drop
            e-signature field placement and signed-document return routing are not yet implemented.{" "}
            {/* TODO: Integrate DocuSign or similar for production e-signature workflows. */}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Form content — {practiceName}
              </label>
              <div className="flex gap-1">
                {SIGNATURE_FIELDS.map((f) => (
                  <button
                    key={f.placeholder}
                    type="button"
                    onClick={() => insertAtCursor(f.placeholder)}
                    className="h-6 px-2 rounded text-[10px] font-medium bg-secondary hover:bg-secondary/70 text-muted-foreground hover:text-foreground border border-border transition-colors"
                    title={`Insert ${f.label} placeholder`}
                  >
                    + {f.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={18}
              className="w-full rounded-md bg-secondary border border-border text-xs font-mono p-3 focus:outline-none focus:ring-1 focus:ring-primary resize-y"
              spellCheck={false}
            />
          </div>

          <div className="border-t border-border pt-4">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Send by email
            </div>
            {sendStatus === "sent" ? (
              <div className="rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-sm text-green-600 dark:text-green-400">
                Form sent to {emailTo}. Note: this delivers the form text only — not a completed signed document.
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="recipient@example.com"
                    className="flex-1 h-8 px-2.5 rounded-md bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    type="button"
                    onClick={handleSendEmail}
                    disabled={!emailTo.trim() || sendStatus === "sending"}
                    className="h-8 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {sendStatus === "sending" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Send size={13} />
                    )}
                    Send
                  </button>
                </div>
                {sendStatus === "error" && sendError && (
                  <p className="mt-1.5 text-xs text-destructive flex items-center gap-1">
                    <AlertCircle size={11} /> {sendError}
                  </p>
                )}
              </>
            )}
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              {/* TODO: Replace with a proper e-signature workflow that tracks
                  signing status and routes completed documents back to the lab. */}
              Sends the form text as the email body. For a completed e-signature flow, connect a
              DocuSign-compatible integration.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([content], { type: "text/plain;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${title.replace(/\s+/g, "-")}-${practiceName.replace(/\s+/g, "-")}.txt`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
            className="h-8 px-3 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors inline-flex items-center gap-1.5"
          >
            <FileDown size={13} /> Download
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Statements tab ─────────────────────────────────────────────────────────

type StmtFilter = "all" | "open" | "paid";

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

  const statementsQuery = useQuery({
    queryKey: ["practice-statements", { practiceId: selected.id }],
    queryFn: () =>
      apiFetch<PracticeStatement[]>(
        `/invoices/practice-statements?providerOrganizationId=${encodeURIComponent(selected.id)}&labOrganizationId=${encodeURIComponent(labOrgId)}`
      ),
    enabled: !!selected.id && !!labOrgId,
  });

  const statements = useMemo(() => {
    const rows = statementsQuery.data ?? [];
    return rows.filter((s) => {
      if (filter === "open") return Number(s.balanceDue) > 0;
      if (filter === "paid") return Number(s.balanceDue) <= 0;
      return true;
    });
  }, [statementsQuery.data, filter]);

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
                <th className="text-left px-5 py-2.5 font-medium">Period</th>
                <th className="text-left px-3 py-2.5 font-medium">Invoices</th>
                <th className="text-right px-3 py-2.5 font-medium">Billed</th>
                <th className="text-right px-3 py-2.5 font-medium">Paid</th>
                <th className="text-right px-3 py-2.5 font-medium">Balance Due</th>
                <th className="text-left px-3 py-2.5 font-medium">Generated</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-border hover:bg-secondary/30 transition-colors"
                >
                  <td className="px-5 py-3 text-left font-medium text-foreground">
                    {s.periodStart
                      ? new Date(s.periodStart).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}{" "}
                    <span className="text-muted-foreground">–</span>{" "}
                    {s.periodEnd
                      ? new Date(s.periodEnd).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}
                  </td>
                  <td className="px-3 py-3 text-left text-muted-foreground">
                    {s.invoiceCount}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatMoney(Number(s.totalBilled ?? 0))}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                    {formatMoney(Number(s.totalPaid ?? 0))}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium">
                    {Number(s.balanceDue ?? 0) > 0 ? (
                      <span className="text-warning">{formatMoney(Number(s.balanceDue))}</span>
                    ) : (
                      <span className="text-muted-foreground">{formatMoney(0)}</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-left text-muted-foreground">
                    {s.createdAt
                      ? new Date(s.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
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

export function CardOnFileTab({ practice }: { practice: Organization; labOrgId?: string }) {
  const [cardAuthOpen, setCardAuthOpen] = useState(false);
  const [autoPayAuthOpen, setAutoPayAuthOpen] = useState(false);

  /* TODO: Replace this placeholder with a real Stripe card-vaulting integration.
     Steps:
     1. Create a Stripe Customer for the practice on first card add.
     2. Use Stripe Elements (SetupIntent) so raw card numbers never touch our servers.
     3. Store only the Stripe PaymentMethod ID + last4 + brand in the DB.
     4. Charge via Stripe PaymentIntent, not direct card data.
     Never store or render raw card numbers — PCI DSS prohibits it. */

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <strong>Safe scaffold:</strong> Card on File is a placeholder for a future PCI-compliant
          Stripe integration. No raw card numbers are stored or displayed.{" "}
          {/* TODO: Implement Stripe card vaulting via SetupIntent + PaymentMethod API. */}
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CreditCard size={16} className="text-muted-foreground" />
              <span className="text-sm font-medium">Saved Card</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  /* TODO: Open Stripe Elements SetupIntent flow for card collection. */
                  alert("Add Card: Connect a PCI-compliant Stripe SetupIntent flow here.");
                }}
                className="h-7 px-2.5 rounded text-xs font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1"
              >
                <Plus size={11} /> Add
              </button>
              <button
                type="button"
                onClick={() => {
                  /* TODO: Open Stripe Elements update flow to replace the saved PaymentMethod. */
                  alert("Edit Card: Connect a Stripe PaymentMethod update flow here.");
                }}
                className="h-7 px-2.5 rounded text-xs font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1"
              >
                <PenLine size={11} /> Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  /* TODO: Call Stripe API to detach PaymentMethod + soft-delete the local record. */
                  alert("Delete Card: Call Stripe PaymentMethods.detach() + remove local reference.");
                }}
                className="h-7 px-2.5 rounded text-xs font-medium text-destructive hover:bg-destructive/10 border border-border transition-colors inline-flex items-center gap-1"
              >
                <Trash2 size={11} /> Delete
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-white p-5 w-72 shadow-md select-none">
            <div className="flex items-center justify-between mb-6">
              <span className="text-xs text-white/60 uppercase tracking-widest font-medium">
                Card on File
              </span>
              <CreditCard size={18} className="text-white/40" />
            </div>
            <div className="font-mono text-base tracking-widest mb-4 text-white/80">
              •••• •••• •••• ——
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
                <div className="text-sm font-medium text-white/60">——/——</div>
              </div>
            </div>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            No card on file.{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                alert("Add Card: Connect a PCI-compliant Stripe SetupIntent flow here.");
              }}
            >
              Add a card
            </button>{" "}
            to enable auto-pay and quick checkout.
          </p>
        </div>

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
              className="h-8 px-3 rounded-md text-sm font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1.5"
            >
              <FileText size={13} />
              Card on File Authorization
            </button>
            <button
              type="button"
              onClick={() => setAutoPayAuthOpen(true)}
              className="h-8 px-3 rounded-md text-sm font-medium bg-secondary hover:bg-secondary/70 border border-border transition-colors inline-flex items-center gap-1.5"
            >
              <FileText size={13} />
              Auto-Pay Authorization
            </button>
          </div>
        </div>
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
      {autoPayAuthOpen && (
        <AuthFormModal
          title="Auto-Pay Authorization"
          defaultContent={AUTOPAY_AUTH_DEFAULT}
          practiceName={practice.displayName || practice.name}
          practiceEmail={practice.billingEmail}
          onClose={() => setAutoPayAuthOpen(false)}
        />
      )}
    </div>
  );
}

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

  const practiceInvoicesQuery = useQuery({
    queryKey: ["invoices", { practiceId: practice.id }],
    queryFn: () =>
      apiFetch<Invoice[]>(`/invoices?practiceId=${encodeURIComponent(practice.id)}`),
    enabled: !!practice.id,
  });

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

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [reassignSuccess, setReassignSuccess] = useState<string | null>(null);

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

  const selectedPracticeInvoices = practiceInvoicesQuery.data ?? [];

  const nonVoidedCount = useMemo(
    () => selectedPracticeInvoices.filter((inv) => inv.status !== "void").length,
    [selectedPracticeInvoices],
  );

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

  const practiceInvoices = useMemo(() => {
    return selectedPracticeInvoices
      .filter((inv) => {
        if (filterBy === "open") {
          if (inv.status !== "open" && inv.status !== "partially_paid")
            return false;
        } else if (filterBy === "overdue") {
          const ag = agingDays(inv);
          if (!ag) return false;
        } else if (filterBy === "paid") {
          if (inv.status !== "paid") return false;
        }

        if (rangeFrom || rangeTo) {
          const issued = inv.issuedAt ? new Date(inv.issuedAt) : null;
          if (issued) {
            if (rangeFrom && issued < rangeFrom) return false;
            if (rangeTo && issued > rangeTo) return false;
          }
        }

        return true;
      })
      .sort((a, b) =>
        (b.issuedAt || b.createdAt || "").localeCompare(
          a.issuedAt || a.createdAt || ""
        )
      );
  }, [selectedPracticeInvoices, filterBy, rangeFrom, rangeTo]);

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
        const caseCompletedAt = inv.caseCompletedAt
          ? new Date(inv.caseCompletedAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : null;
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

  const invColumnOptions = invCols.defs.map((d) => ({
    id: d.id,
    label: d.menuLabel,
    visible: !invCols.state.hidden.includes(d.id),
    index: invCols.state.order.indexOf(d.id),
  }));

  function handleExportStatementPdf() {
    const allInvoices = selectedPracticeInvoices;
    const billed = allInvoices.reduce((s, i) => s + Number(i.total ?? 0), 0);
    const paid = allInvoices.reduce(
      (s, i) => s + Math.max(0, Number(i.total ?? 0) - Number(i.balanceDue ?? i.total ?? 0)),
      0
    );
    const open = allInvoices.reduce(
      (s, i) =>
        i.status === "open" || i.status === "partially_paid"
          ? s + Number(i.balanceDue ?? i.total ?? 0)
          : s,
      0
    );
    const overdue = allInvoices.reduce((s, i) => {
      const ag = agingDays(i);
      return ag != null ? s + Number(i.balanceDue ?? i.total ?? 0) : s;
    }, 0);

    const filterParts: string[] = [];
    if (filterBy !== "all") {
      filterParts.push(
        filterBy === "open"
          ? "Open invoices"
          : filterBy === "overdue"
          ? "Overdue invoices"
          : "Paid invoices"
      );
    }
    if (dateRange !== "all") {
      const labels: Record<string, string> = {
        this_month: "This month",
        last_month: "Last month",
        this_quarter: "This quarter",
        last_quarter: "Last quarter",
        this_year: "This year",
        custom: customFrom || customTo
          ? `${customFrom || "…"} – ${customTo || "…"}`
          : "Custom range",
      };
      filterParts.push(labels[dateRange] ?? dateRange);
    }

    downloadStatementPdf({
      practiceName: practice.displayName || practice.name,
      generatedAt: new Date(),
      filtersDescription: filterParts.length > 0 ? filterParts.join(" · ") : undefined,
      totals: { billed, paid, open, overdue },
      invoices: practiceInvoices.map((inv) => ({
        invoiceNumber: inv.invoiceNumber ?? String(inv.id),
        issuedAt: inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString("en-US") : "—",
        dueAt: inv.dueAt ?? inv.dueDate
          ? new Date((inv.dueAt ?? inv.dueDate)!).toLocaleDateString("en-US")
          : "—",
        status: inv.status,
        total: String(inv.total ?? 0),
        balanceDue: String(inv.balanceDue ?? 0),
        patientName: inv.displayMetadata?.patientName ?? inv.displayMetadataJson?.patientName,
        billTo: inv.displayMetadata?.billTo ?? inv.displayMetadataJson?.billTo,
      })),
    });
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
          {practiceInvoices.length} row
          {practiceInvoices.length !== 1 ? "s" : ""}
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
              reassignMutation.reset();
              setReassignOpen(true);
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
