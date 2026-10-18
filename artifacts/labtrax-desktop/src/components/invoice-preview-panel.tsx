import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Pencil, X } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { formatInvoiceDate } from "@/lib/invoice-date";
import { StatusBadge } from "@/components/StatusBadge";
import type { Invoice, InvoiceDisplayMetadata } from "@/lib/types";

function isDraftStatus(status: unknown): boolean {
  return String(status) === "draft" || String(status) === "recovery_draft";
}

export const INVOICE_PREVIEW_QUERY_KEY = ["invoice-preview"] as const;

type Props = {
  invoiceId: string;
  /** Changes whenever the register list refetches; triggers a detail refresh. */
  refreshToken?: number;
  canRecordPayment: boolean;
  canEdit?: boolean;
  /** True while an editor/payment dialog sits above the preview. */
  suppressEscape?: boolean;
  onClose: () => void;
  onEdit: (invoice: Invoice) => void;
  onRecordPayment: (invoice: Invoice) => void;
};

function Dash() {
  return <span className="text-muted-foreground">{"\u2014"}</span>;
}

function Field({ label, value, testId }: { label: string; value?: string | null; testId: string }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]" data-testid={testId}>
        {value ? value : <Dash />}
      </dd>
    </div>
  );
}

export function InvoicePreviewPanel({
  invoiceId,
  refreshToken,
  canRecordPayment,
  canEdit = canRecordPayment,
  suppressEscape,
  onClose,
  onEdit,
  onRecordPayment,
}: Props) {
  const query = useQuery({
    queryKey: [...INVOICE_PREVIEW_QUERY_KEY, invoiceId],
    queryFn: ({ signal }) => apiFetch<Invoice>(`/invoices/${invoiceId}`, { signal }),
    retry: false,
  });
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  const firstToken = useRef(refreshToken);
  useEffect(() => {
    if (firstToken.current === refreshToken) return;
    firstToken.current = refreshToken;
    void refetchRef.current();
  }, [refreshToken]);

  const [overlay, setOverlay] = useState(
    () => typeof window !== "undefined" && !window.matchMedia?.("(min-width: 1280px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 1280px)");
    if (!mq) return;
    const sync = () => setOverlay(!mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const suppressRef = useRef(suppressEscape);
  suppressRef.current = suppressEscape;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !suppressRef.current && !e.defaultPrevented) onCloseRef.current();
      if (e.key === "Tab" && overlay && !suppressRef.current) {
        const controls = panelRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled), [href], input:not(:disabled), [tabindex='0']",
        );
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [overlay]);

  // Errored (including a refetch that now 404s) must never leave stale data actionable.
  const inv = query.isError ? undefined : query.data;
  const missing =
    query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 410);
  const meta = (inv?.displayMetadata ?? inv?.displayMetadataJson ?? {}) as InvoiceDisplayMetadata;
  const lines = (inv?.items ?? []).filter((l) => !l.parentLineItemId);
  const restoration =
    [meta.caseType, meta.caseSubtype, meta.material].filter(Boolean).join(" \u00b7 ") ||
    lines.map((l) => l.description).filter(Boolean).join("; ");
  const tooth =
    meta.teeth ||
    [...new Set(lines.map((l) => l.toothLabel || (l.toothNumber != null ? String(l.toothNumber) : "")).filter(Boolean))].join(", ");
  const paid = (inv?.payments ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const balance = Number(inv?.balanceDue ?? inv?.total ?? 0);
  const doctor = inv?.doctorDisplayName || inv?.doctorName || inv?.doctorIdentity || null;
  const issued = inv ? formatInvoiceDate(inv.issuedAt ?? inv.createdAt) : "";
  const due = inv ? formatInvoiceDate(inv.dueAt ?? inv.dueDate) : "";

  return (
    <aside
      data-testid="invoice-preview"
      ref={panelRef}
      role={overlay ? "dialog" : "complementary"}
      aria-modal={overlay ? true : undefined}
      aria-label="Invoice preview"
      className="fixed inset-y-0 right-0 z-40 flex w-[380px] max-w-full flex-col border-l border-border bg-card shadow-2xl xl:sticky xl:top-0 xl:z-10 xl:h-[calc(100dvh-3.5rem)] xl:shrink-0 xl:self-start xl:rounded-xl xl:border xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold" data-testid="invoice-preview-title">
            {inv ? `Invoice ${inv.invoiceNumber}` : "Invoice"}
          </h2>
          {inv && (
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge status={inv.status} />
              <span>Issued {issued || "\u2014"}</span>
              {inv.frozen && <span data-testid="invoice-preview-frozen">Frozen</span>}
            </div>
          )}
        </div>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close preview"
          data-testid="invoice-preview-close"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {query.isLoading && (
          <div data-testid="invoice-preview-loading" className="space-y-3 animate-pulse">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="h-4 rounded bg-secondary" />
            ))}
          </div>
        )}
        {missing && (
          <div data-testid="invoice-preview-missing" className="py-10 text-center text-sm text-muted-foreground">
            This invoice is no longer available. It may have been deleted.
          </div>
        )}
        {query.isError && !missing && (
          <div data-testid="invoice-preview-error" className="py-10 text-center text-sm">
            <p className="text-destructive">Could not load this invoice.</p>
            <button
              type="button"
              data-testid="invoice-preview-retry"
              onClick={() => void query.refetch()}
              className="mt-3 h-8 rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary"
            >
              Retry
            </button>
          </div>
        )}
        {inv && (
          <dl>
            <Field label="Practice" value={inv.providerOrganization?.name} testId="invoice-preview-practice" />
            <Field label="Patient" value={meta.patientName} testId="invoice-preview-patient" />
            <div className="my-2 border-t border-border" />
            <Field
              label="Restoration"
              value={restoration}
              testId="invoice-preview-restoration"
            />
            <Field label="Tooth #" value={tooth} testId="invoice-preview-tooth" />
            <Field label="Doctor" value={doctor} testId="invoice-preview-doctor" />
            <Field label="Bill to" value={meta.billTo} testId="invoice-preview-billto" />
            <div className="my-2 border-t border-border" />
            <Field label="Issued" value={issued} testId="invoice-preview-issued" />
            <Field label="Due" value={due} testId="invoice-preview-due" />
            <div className="my-2 border-t border-border" />
            <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-sm">
              <dt className="text-muted-foreground">Total</dt>
              <dd className="tabular-nums" data-testid="invoice-preview-total">{formatMoney(inv.total)}</dd>
            </div>
            <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-sm">
              <dt className="text-muted-foreground">Payments</dt>
              <dd className="tabular-nums" data-testid="invoice-preview-payments">{formatMoney(paid)}</dd>
            </div>
            <div className="my-2 flex items-center justify-between rounded-md bg-primary/10 px-3 py-2">
              <dt className="text-sm font-semibold">Balance Due</dt>
              <dd className="text-base font-semibold tabular-nums" data-testid="invoice-preview-balance">
                {formatMoney(balance)}
              </dd>
            </div>
            <div className="my-2 border-t border-border" />
            <Field label="Notes" value={inv.notes} testId="invoice-preview-notes" />
          </dl>
        )}
      </div>

      <div className="flex gap-2 border-t border-border px-5 py-3">
        {isDraftStatus(inv?.status) ? (
          <p className="text-xs text-muted-foreground">Draft invoices are read-only here; use their original creation or review workflow.</p>
        ) : canEdit ? <button
          type="button"
          disabled={!inv}
          data-testid="invoice-preview-edit"
          onClick={() => inv && onEdit(inv)}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-primary/40 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50"
        >
          <Pencil size={13} /> Edit Invoice
        </button> : null}
        {canRecordPayment && !isDraftStatus(inv?.status) && (
          <button
            type="button"
            disabled={!inv || !!inv.frozen}
            title={inv?.frozen ? "Invoice is frozen \u2014 the linked case was deleted" : undefined}
            data-testid="invoice-preview-record-payment"
            onClick={() => inv && onRecordPayment(inv)}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <CreditCard size={13} /> Record Payment
          </button>
        )}
      </div>
    </aside>
  );
}
