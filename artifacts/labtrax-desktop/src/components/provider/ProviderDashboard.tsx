import { useState, useEffect } from "react";
// How a provider case row reads is shared with the mobile mirror of this
// screen (ProviderDashboardSection), so the same case cannot come out
// formatted one way on a phone and another way here. Note that these rules
// deliberately differ from @/lib/format — see the package for which, and why.
import {
  formatProviderBalance,
  formatProviderDueDate,
  providerPatientDisplayName,
  providerStatusLabel,
} from "@workspace/provider-case-format";
import type { LabCase } from "@/lib/types";
import { ProviderCaseDetailModal } from "./ProviderCaseDetailModal";

type ProviderCase = LabCase & {
  restorationTypes?: string | null;
  providerAccountNumber?: string | null;
  labName?: string | null;
  openInvoiceAmount?: number | null;
};

function toDateInputValue(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function CompletedCasesPanel({
  completedCases,
  multiLab,
  onClose,
  onSelectCase,
}: {
  completedCases: ProviderCase[];
  multiLab: boolean;
  onClose: () => void;
  onSelectCase: (caseId: string) => void;
}) {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const [fromDate, setFromDate] = useState(toDateInputValue(firstOfMonth));
  const [toDate, setToDate] = useState(toDateInputValue(today));

  const filtered = completedCases.filter((c) => {
    if (!c.dueDate) return true;
    const due = c.dueDate.slice(0, 10);
    return due >= fromDate && due <= toDate;
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Completed cases"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <div className="relative z-10 bg-background border border-border rounded-t-xl sm:rounded-xl shadow-xl w-full max-w-3xl mx-0 sm:mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-semibold">Your Completed Cases</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Completed cases assigned to your account
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Date filter controls */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-border bg-muted/30 shrink-0">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Date range
          </span>
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground" htmlFor="completed-from">
              From
            </label>
            <input
              id="completed-from"
              type="date"
              value={fromDate}
              max={toDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="text-sm border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground" htmlFor="completed-to">
              To
            </label>
            <input
              id="completed-to"
              type="date"
              value={toDate}
              min={fromDate}
              onChange={(e) => setToDate(e.target.value)}
              className="text-sm border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <span className="text-xs text-muted-foreground ml-auto">
            {filtered.length} {filtered.length === 1 ? "case" : "cases"}
          </span>
        </div>

        {/* Table / empty state */}
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6">
              <p className="text-sm font-medium text-muted-foreground">
                No completed cases in this date range
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Try expanding the date range to see earlier completed cases.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-4 py-2 font-medium">Case #</th>
                    <th className="px-4 py-2 font-medium">Patient</th>
                    <th className="px-4 py-2 font-medium">Restorations</th>
                    <th className="px-4 py-2 font-medium">Due</th>
                    {multiLab && (
                      <th className="px-4 py-2 font-medium">Lab</th>
                    )}
                    <th className="px-4 py-2 font-medium text-right">
                      Open Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      className="border-t border-border hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => onSelectCase(c.id)}
                    >
                      <td className="px-4 py-2 font-mono text-xs">
                        {c.caseNumber}
                      </td>
                      <td className="px-4 py-2">{providerPatientDisplayName(c)}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {c.restorationTypes ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatProviderDueDate(c.dueDate)}
                      </td>
                      {multiLab && (
                        <td className="px-4 py-2 text-muted-foreground">
                          {c.labName ?? "—"}
                        </td>
                      )}
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {formatProviderBalance(c.openInvoiceAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ProviderDashboard ────────────────────────────────────────────────────────

interface ProviderDashboardProps {
  cases: ProviderCase[] | null;
  error: string | null;
  onViewBill?: () => void;
  /** When set (e.g. via a notification deep-link), auto-opens the case detail modal. */
  initialCaseId?: string | null;
}

export function ProviderDashboard({
  cases,
  error,
  onViewBill,
  initialCaseId,
}: ProviderDashboardProps) {
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(initialCaseId ?? null);
  const [showCompleted, setShowCompleted] = useState(false);

  // Sync initialCaseId changes (e.g. subsequent notification clicks) into state.
  useEffect(() => {
    if (initialCaseId) setSelectedCaseId(initialCaseId);
  }, [initialCaseId]);

  const labNames = cases
    ? Array.from(new Set(cases.map((c) => c.labName).filter(Boolean)))
    : [];
  const multiLab = labNames.length > 1;

  // Separate completed from active cases
  const completedCases = cases ? cases.filter((c) => c.status === "complete") : [];
  const activeCases = cases ? cases.filter((c) => c.status !== "complete") : cases;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Your Active Cases</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            All active cases assigned to your account
          </p>
        </div>
        {cases !== null && completedCases.length > 0 && (
          <button
            type="button"
            onClick={() => setShowCompleted(true)}
            className="shrink-0 text-sm px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            View completed cases
          </button>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
        >
          {error}
        </div>
      ) : cases === null ? (
        <div className="text-sm text-muted-foreground">Loading cases…</div>
      ) : activeCases === null || activeCases.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center">
          {cases.length === 0
            ? "You have no assigned cases yet."
            : "No active cases. Check completed cases for your history."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Case #</th>
                <th className="px-4 py-2 font-medium">Patient</th>
                <th className="px-4 py-2 font-medium">Restorations</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Due</th>
                {multiLab && (
                  <th className="px-4 py-2 font-medium">Lab</th>
                )}
              </tr>
            </thead>
            <tbody>
              {activeCases.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => setSelectedCaseId(c.id)}
                >
                  <td className="px-4 py-2 font-mono text-xs">
                    {c.caseNumber}
                  </td>
                  <td className="px-4 py-2">{providerPatientDisplayName(c)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {c.restorationTypes ?? "—"}
                  </td>
                  <td className="px-4 py-2">{providerStatusLabel(c.status)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {formatProviderDueDate(c.dueDate)}
                  </td>
                  {multiLab && (
                    <td className="px-4 py-2 text-muted-foreground">
                      {c.labName ?? "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCompleted && (
        <CompletedCasesPanel
          completedCases={completedCases}
          multiLab={multiLab}
          onClose={() => setShowCompleted(false)}
          onSelectCase={(caseId) => setSelectedCaseId(caseId)}
        />
      )}

      {selectedCaseId && (
        <ProviderCaseDetailModal
          caseId={selectedCaseId}
          onClose={() => setSelectedCaseId(null)}
        />
      )}
    </div>
  );
}

