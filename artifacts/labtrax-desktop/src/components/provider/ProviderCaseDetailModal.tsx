/**
 * Shared provider-facing case detail modal.
 *
 * Used by both ProviderDashboard (Dashboard tab) and ProviderBilling (Billing
 * tab) so providers see the same enhanced view — invoice panel, note composer,
 * file attachment, and chronological timeline — regardless of which tab they
 * open a case from.
 */
import { useState, useEffect, useRef } from "react";
import { apiFetch, apiUrl, getAccessToken } from "@/lib/api";
import { AuthedImage, MediaLightbox, type Lightbox } from "@/components/AuthedMedia";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface TimelineEntry {
  type: "location" | "remake" | "photo" | "note" | "file" | "status" | "payment";
  id: string;
  label: string;
  timestamp: string;
  attachmentId?: string;
  fileName?: string;
  fileType?: string;
  author?: string | null;
  /** Status entries only — the status the case moved away from. */
  fromStatus?: string | null;
  /**
   * Status entries only — true when the case came back into the lab
   * (a completion-family status directly followed by an intake-family one).
   * Computed server-side so the lab and provider views flag the same moments.
   */
  isCaseReturn?: boolean;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
}

/** Provider-safe prescription row — clinical fields only, never pricing. */
export interface RxRestoration {
  id?: string;
  toothNumber?: string | null;
  restorationType?: string | null;
  restorationSubtype?: string | null;
  material?: string | null;
  shade?: string | null;
  arch?: "upper" | "lower" | null;
}

export interface CaseDetail {
  id: string;
  caseNumber: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  caseType?: string | null;
  doctorName?: string | null;
  practiceName?: string | null;
  restorationTypes?: string | null;
  restorations?: RxRestoration[];
  rxNotes?: string | null;
  notes?: Array<{
    id?: string;
    noteText: string;
    visibility?: string | null;
    createdAt?: string | null;
  }>;
  timeline?: TimelineEntry[];
  step?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  invoiceLines?: InvoiceLine[];
  invoiceTotal?: string | null;
  invoiceStatus?: string | null;
  viewerCanPostNotes?: boolean;
  viewerQuickReferenceOrganizationId?: string | null;
}

interface QuickReferenceNote {
  id: string;
  body: string;
  label: string | null;
  isActive: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

const REMOVABLE_STEP_LABELS: Record<string, string> = {
  custom_tray: "Custom Tray",
  rims_and_plates: "Rims and Plates",
  wax_setup: "Wax Setup",
  process: "Process",
};

function stepLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return REMOVABLE_STEP_LABELS[value] ?? statusLabel(value);
}

function isRemovableCase(detail: Pick<CaseDetail, "caseType" | "restorations">): boolean {
  const values = [
    detail.caseType,
    ...(detail.restorations ?? []).flatMap((row) => [
      row.restorationType,
      row.restorationSubtype,
    ]),
  ];
  return values.some((value) =>
    /(removable|denture|partial|flipper|valplast|flexible)/i.test(value ?? ""),
  );
}

function savedArch(restorations: RxRestoration[] | undefined): string | null {
  const arches = new Set(
    (restorations ?? []).map((row) => row.arch).filter(
      (arch): arch is "upper" | "lower" => arch === "upper" || arch === "lower",
    ),
  );
  return arches.has("upper") && arches.has("lower")
    ? "Upper + Lower"
    : arches.has("upper")
      ? "Upper"
      : arches.has("lower")
        ? "Lower"
        : null;
}

function formatCurrency(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (!amount || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

// ─── ProviderCaseDetailModal ──────────────────────────────────────────────────

export function ProviderCaseDetailModal({
  caseId,
  onClose,
}: {
  caseId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invoice panel
  const [showInvoice, setShowInvoice] = useState(false);

  // Provider-safe prescription (Rx) dialog, opened from a returned-case
  // timeline entry.
  const [showRx, setShowRx] = useState(false);

  // Note form
  const [noteText, setNoteText] = useState("");
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [noteSuccess, setNoteSuccess] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [quickReferenceNotes, setQuickReferenceNotes] = useState<QuickReferenceNote[]>([]);
  const [quickReferenceOpen, setQuickReferenceOpen] = useState(false);

  // File attachment
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<
    "idle" | "uploading" | "success" | "error"
  >("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Lightbox for photos
  const [lightbox, setLightbox] = useState<Lightbox>(null);

  // Fetch case detail on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<CaseDetail>(`/cases/provider/${caseId}`);
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load case.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // Re-fetch the case detail in place (no loading spinner) so newly-attached
  // files show up in the timeline immediately after upload, without the
  // provider having to reload the page.
  async function refreshCaseDetail() {
    try {
      const data = await apiFetch<CaseDetail>(`/cases/provider/${caseId}`);
      setDetail(data);
    } catch {
      // Best-effort refresh — the upload itself already succeeded, so a
      // transient refetch failure shouldn't surface as an error to the user.
    }
  }

  useEffect(() => {
    const organizationId = detail?.viewerQuickReferenceOrganizationId;
    if (!detail?.viewerCanPostNotes || !organizationId) {
      setQuickReferenceNotes([]);
      return;
    }
    let cancelled = false;
    void apiFetch<{ notes: QuickReferenceNote[] }>(
      `/organizations/${organizationId}/quick-reference-notes`,
    )
      .then((result) => {
        if (!cancelled) {
          setQuickReferenceNotes((result.notes ?? []).filter((note) => note.isActive));
        }
      })
      .catch(() => {
        if (!cancelled) setQuickReferenceNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.viewerCanPostNotes, detail?.viewerQuickReferenceOrganizationId]);

  const patientName =
    detail &&
    (detail.patientFirstName || detail.patientLastName
      ? `${detail.patientFirstName ?? ""} ${detail.patientLastName ?? ""}`.trim()
      : "—");

  const hasInvoice = Boolean(detail?.invoiceId);
  const sharedLabNotes =
    detail?.notes?.filter(
      (note) => note.visibility === "shared_with_provider" && note.noteText.trim(),
    ) ?? [];

  async function handleSubmitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim() || noteSubmitting) return;
    setNoteSubmitting(true);
    setNoteError(null);
    try {
      await apiFetch(`/cases/provider/${caseId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteText: noteText.trim() }),
      });
      setNoteText("");
      setNoteSuccess(true);
      setTimeout(() => setNoteSuccess(false), 4000);
    } catch (e) {
      setNoteError(
        e instanceof Error ? e.message : "Failed to send note. Please try again."
      );
    } finally {
      setNoteSubmitting(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadProgress("uploading");
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    // Use XHR so we can show upload state (fetch has no upload-progress API)
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(`/cases/provider/${caseId}/attachments`));

    // Attach the bearer token via the module-level token store (always hydrated at login)
    const token = getAccessToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploadProgress("success");
        setTimeout(() => setUploadProgress("idle"), 4000);
        // Pull the freshly-attached file into the timeline right away so the
        // provider sees confirmation without reloading the page.
        void refreshCaseDetail();
      } else {
        setUploadProgress("error");
        try {
          const body = JSON.parse(xhr.responseText);
          setUploadError(body?.message ?? "Upload failed.");
        } catch {
          setUploadError("Upload failed.");
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };

    xhr.onerror = () => {
      setUploadProgress("error");
      setUploadError("Network error during upload.");
      if (fileInputRef.current) fileInputRef.current.value = "";
    };

    xhr.send(formData);
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        role="dialog"
        aria-modal="true"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/40"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* Panel */}
        <div className="relative z-10 bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
            <h2 className="text-base font-semibold">
              {detail ? `Case #${detail.caseNumber}` : "Case Detail"}
            </h2>
            <div className="flex items-center gap-2">
              {hasInvoice && (
                <button
                  type="button"
                  onClick={() => setShowInvoice((v) => !v)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors font-medium"
                >
                  {showInvoice ? "Hide Invoice" : "View Invoice"}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground text-xl leading-none ml-2"
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
            {loading ? (
              <div className="text-sm text-muted-foreground py-4">Loading…</div>
            ) : error ? (
              <div className="text-sm text-destructive py-4">{error}</div>
            ) : detail ? (
              <>
                {/* ── Case details ── */}
                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Patient
                    </dt>
                    <dd className="mt-0.5 font-medium">{patientName}</dd>
                  </div>

                  {detail.caseType && (
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Case Type
                      </dt>
                      <dd className="mt-0.5">{detail.caseType}</dd>
                    </div>
                  )}

                  {(detail.caseType ?? "").match(/removable|ortho/i) ||
                    detail.restorations?.some((row) =>
                      /removable|denture|partial|ortho|night guard|retainer|aligner/i.test(
                        `${row.restorationType ?? ""} ${row.restorationSubtype ?? ""}`,
                      ),
                    ) ? (
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Arch
                      </dt>
                      <dd className="mt-0.5">{savedArch(detail.restorations) ?? "Required"}</dd>
                    </div>
                  ) : null}

                  {detail.restorationTypes && !(detail.restorations?.length) && (
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Restoration Types
                      </dt>
                      <dd className="mt-0.5">{detail.restorationTypes}</dd>
                    </div>
                  )}

                  <div>
                    <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Restorations
                    </dt>
                    {detail.restorations && detail.restorations.length > 0 ? (
                      <div className="mt-1 rounded-md border border-border overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/40 text-muted-foreground">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">Tooth</th>
                              <th className="px-3 py-2 text-left font-medium">Type</th>
                              <th className="px-3 py-2 text-left font-medium">Material</th>
                              <th className="px-3 py-2 text-left font-medium">Arch</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.restorations.map((restoration, index) => (
                              <tr
                                key={restoration.id ?? index}
                                className="border-t border-border"
                                data-testid={`provider-restoration-${restoration.id ?? index}`}
                              >
                                <td className="px-3 py-2">{restoration.toothNumber || "—"}</td>
                                <td className="px-3 py-2">
                                  {[
                                    restoration.restorationType,
                                    restoration.restorationSubtype,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ") || "—"}
                                </td>
                                <td className="px-3 py-2">{restoration.material || "—"}</td>
                                <td className="px-3 py-2">
                                  {restoration.arch === "upper"
                                    ? "Upper"
                                    : restoration.arch === "lower"
                                      ? "Lower"
                                      : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <dd className="mt-0.5 text-muted-foreground italic">
                        No restorations on this case.
                      </dd>
                    )}
                  </div>

                  {isRemovableCase(detail) && (
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Current Step
                      </dt>
                      <dd className="mt-0.5">{stepLabel(detail.step)}</dd>
                    </div>
                  )}

                  {sharedLabNotes.length > 0 ? (
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Lab Notes
                      </dt>
                      <dd className="mt-0.5 text-muted-foreground space-y-2">
                        {sharedLabNotes.map((note, index) => (
                          <p
                            key={note.id ?? index}
                            className="whitespace-pre-wrap"
                          >
                            {note.noteText}
                          </p>
                        ))}
                      </dd>
                    </div>
                  ) : (
                    <div className="text-muted-foreground italic text-sm">
                      No lab notes shared for this case.
                    </div>
                  )}
                </dl>

                {/* ── Invoice panel ── */}
                {showInvoice && hasInvoice && (
                  <div className="rounded-md border border-border bg-muted/30 p-4 text-sm">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-medium text-sm">Invoice</h3>
                      {detail.invoiceStatus && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted border border-border font-medium">
                          {statusLabel(detail.invoiceStatus)}
                        </span>
                      )}
                    </div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border">
                          <th className="text-left pb-1.5 font-medium">Description</th>
                          <th className="text-center pb-1.5 font-medium w-12">Qty</th>
                          <th className="text-right pb-1.5 font-medium w-20">Unit</th>
                          <th className="text-right pb-1.5 font-medium w-20">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.invoiceLines!.map((line, idx) => (
                          <tr key={idx} className="border-b border-border/50 last:border-0">
                            <td className="py-1.5 pr-2">{line.description}</td>
                            <td className="py-1.5 text-center">{line.quantity}</td>
                            <td className="py-1.5 text-right tabular-nums">
                              {formatCurrency(line.unitPrice)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums font-medium">
                              {formatCurrency(line.totalPrice)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3} className="pt-2 text-right font-semibold">
                            Total
                          </td>
                          <td className="pt-2 text-right tabular-nums font-semibold">
                            {formatCurrency(detail.invoiceTotal)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* ── Send a note ── */}
                <div className="border border-border rounded-md p-4">
                  <h3 className="text-sm font-medium mb-2">Send a Note to the Lab</h3>
                  <form onSubmit={handleSubmitNote} className="space-y-2">
                    <textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Type your message here…"
                      rows={3}
                      className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      disabled={noteSubmitting}
                    />
                    {quickReferenceNotes.length > 0 && (
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setQuickReferenceOpen((open) => !open)}
                          className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 transition-colors inline-flex items-center gap-1"
                          data-testid="provider-quick-reference-toggle"
                        >
                          Add quick reference note
                        </button>
                        {quickReferenceOpen && (
                          <div className="absolute z-30 left-0 bottom-full mb-1 w-72 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg py-1">
                            {quickReferenceNotes.map((template) => (
                              <button
                                key={template.id}
                                type="button"
                                className="w-full text-left px-3 py-2 hover:bg-accent transition-colors"
                                onClick={() => {
                                  setNoteText((current) =>
                                    current.trim() ? `${current}\n${template.body}` : template.body,
                                  );
                                  setQuickReferenceOpen(false);
                                }}
                              >
                                {template.label && (
                                  <div className="text-[11px] font-medium text-primary mb-0.5">
                                    {template.label}
                                  </div>
                                )}
                                <div className="text-xs text-foreground line-clamp-2">{template.body}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {noteError && (
                      <p className="text-xs text-destructive">{noteError}</p>
                    )}
                    {noteSuccess && (
                      <p className="text-xs text-green-600">Note sent to the lab.</p>
                    )}
                    <div className="flex items-center gap-3">
                      <button
                        type="submit"
                        disabled={!noteText.trim() || noteSubmitting}
                        className="text-xs px-4 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                      >
                        {noteSubmitting ? "Sending…" : "Send Note"}
                      </button>

                      {/* Attach file */}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadProgress === "uploading"}
                        className="text-xs px-4 py-1.5 rounded-md border border-border hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                      >
                        {uploadProgress === "uploading" ? "Uploading…" : "Attach a File"}
                      </button>
                    </div>
                    {uploadProgress === "success" && (
                      <p className="text-xs text-green-600">File attached successfully.</p>
                    )}
                    {uploadProgress === "error" && uploadError && (
                      <p className="text-xs text-destructive">{uploadError}</p>
                    )}
                  </form>
                </div>

                {/* ── Timeline ── */}
                {detail.timeline && detail.timeline.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-3">Case Timeline</h3>
                    <div className="relative space-y-0">
                      {detail.timeline.map((entry, idx) => (
                        <div key={entry.id} className="flex gap-3 relative">
                          {/* Connector line */}
                          {idx < detail.timeline!.length - 1 && (
                            <div className="absolute left-[13px] top-7 bottom-0 w-px bg-border" />
                          )}

                          {/* Icon */}
                          <div className="shrink-0 w-7 h-7 rounded-full border border-border bg-background flex items-center justify-center mt-0.5 z-10">
                            {entry.type === "location" && (
                              <PinIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                            {entry.type === "remake" && (
                              <RefreshIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                            {entry.type === "photo" && (
                              <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                            {entry.type === "note" && (
                              <MessageIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                            {entry.type === "file" && (
                              <PaperclipIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                            {entry.type === "status" && (
                              <ArrowRightIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                            {entry.type === "payment" && (
                              <DollarIcon className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                          </div>

                          {/* Content */}
                          <div className="pb-4 flex-1 min-w-0">
                            {entry.type === "photo" && entry.attachmentId ? (
                              <div className="space-y-1">
                                <p className="text-xs text-muted-foreground">
                                  {formatTimestamp(entry.timestamp)}
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setLightbox({
                                      url: apiUrl(
                                        `/cases/${caseId}/attachments/${entry.attachmentId}/file`
                                      ),
                                      kind: "image",
                                    })
                                  }
                                  className="block rounded overflow-hidden border border-border hover:opacity-90 transition-opacity"
                                  title={entry.fileName ?? "Photo"}
                                >
                                  <AuthedImage
                                    url={apiUrl(
                                      `/cases/${caseId}/attachments/${entry.attachmentId}/file`
                                    )}
                                    alt={entry.fileName ?? "Photo"}
                                    className="h-20 w-28 object-cover"
                                  />
                                </button>
                                {entry.fileName && (
                                  <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                    {entry.fileName}
                                  </p>
                                )}
                              </div>
                            ) : entry.type === "note" ? (
                              <div>
                                <p className="text-xs text-muted-foreground mb-0.5">
                                  {entry.author
                                    ? `${entry.author} · ${formatTimestamp(entry.timestamp)}`
                                    : formatTimestamp(entry.timestamp)}
                                </p>
                                <p className="text-sm leading-snug whitespace-pre-wrap">
                                  {entry.label}
                                </p>
                              </div>
                            ) : entry.type === "file" && entry.attachmentId ? (
                              <div>
                                <p className="text-xs text-muted-foreground mb-0.5">
                                  {formatTimestamp(entry.timestamp)}
                                </p>
                                <button
                                  type="button"
                                  className="text-sm font-medium text-primary hover:underline truncate block max-w-[280px] text-left"
                                  title={entry.fileName ?? "Download file"}
                                  onClick={async () => {
                                    const token = getAccessToken();
                                    const url = apiUrl(
                                      `/cases/${caseId}/attachments/${entry.attachmentId}/file`
                                    );
                                    const resp = await fetch(url, {
                                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                                    });
                                    if (!resp.ok) return;
                                    const blob = await resp.blob();
                                    const blobUrl = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = blobUrl;
                                    a.download = entry.fileName ?? "attachment";
                                    a.click();
                                    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                                  }}
                                >
                                  {entry.fileName ?? "Download file"}
                                </button>
                              </div>
                            ) : entry.type === "status" ? (
                              <div>
                                <p className="text-sm font-medium leading-snug">
                                  Status changed to{" "}
                                  <span className="capitalize">
                                    {entry.label.replace(/_/g, " ")}
                                  </span>
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {formatTimestamp(entry.timestamp)}
                                </p>
                                {entry.isCaseReturn && (
                                  <div className="mt-1.5 flex items-center gap-2">
                                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                      Case returned
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setShowRx(true)}
                                      data-testid={`provider-timeline-view-rx-${entry.id}`}
                                      className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted/50 transition-colors font-medium"
                                    >
                                      View Rx
                                    </button>
                                  </div>
                                )}
                              </div>
                            ) : entry.type === "payment" ? (
                              <div>
                                <p className="text-sm font-medium leading-snug">
                                  Payment received — {entry.label}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {formatTimestamp(entry.timestamp)}
                                </p>
                              </div>
                            ) : (
                              <div>
                                <p className="text-sm font-medium leading-snug">
                                  {entry.label}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {formatTimestamp(entry.timestamp)}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.timeline?.length === 0 && (
                  <p className="text-sm text-muted-foreground italic">
                    No timeline activity yet.
                  </p>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Provider-safe prescription view (opened from a returned-case entry) */}
      {showRx && detail && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Prescription"
          data-testid="provider-rx-dialog"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowRx(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 bg-background border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
              <h2 className="text-base font-semibold">Prescription</h2>
              <button
                type="button"
                onClick={() => setShowRx(false)}
                className="text-muted-foreground hover:text-foreground text-xl leading-none"
                aria-label="Close prescription"
              >
                ×
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-sm">
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Case
                  </dt>
                  <dd className="mt-0.5 font-medium">{detail.caseNumber}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Patient
                  </dt>
                  <dd className="mt-0.5 font-medium">{patientName}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Doctor
                  </dt>
                  <dd className="mt-0.5">{detail.doctorName || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Practice
                  </dt>
                  <dd className="mt-0.5">{detail.practiceName || "—"}</dd>
                </div>
              </dl>

              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  Restorations
                </h3>
                {detail.restorations && detail.restorations.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left pb-1.5 font-medium">Tooth</th>
                        <th className="text-left pb-1.5 font-medium">Type</th>
                        <th className="text-left pb-1.5 font-medium">Material</th>
                        <th className="text-left pb-1.5 font-medium">Shade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.restorations.map((r, idx) => (
                        <tr
                          key={r.id ?? idx}
                          className="border-b border-border/50 last:border-0"
                        >
                          <td className="py-1.5 pr-2">{r.toothNumber || "—"}</td>
                          <td className="py-1.5 pr-2">{r.restorationType || "—"}</td>
                          <td className="py-1.5 pr-2">{r.material || "—"}</td>
                          <td className="py-1.5">{r.shade || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-muted-foreground italic text-xs">
                    No restorations on this prescription.
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  Prescription Notes
                </h3>
                {detail.rxNotes ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {detail.rxNotes}
                  </p>
                ) : (
                  <p className="text-muted-foreground italic text-xs">
                    No prescription notes.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox for photos */}
      <MediaLightbox
        lightbox={lightbox}
        onClose={() => setLightbox(null)}
        overlayClassName="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
      />
    </>
  );
}
