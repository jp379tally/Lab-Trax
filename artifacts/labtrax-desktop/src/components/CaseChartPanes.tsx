import type { ReactNode } from "react";

/**
 * Three-pane case workspace: case details | portrait chart | restoration summary.
 * Display only. At >= 1000px of available panel width: three readable panes. Below that the panes
 * stack (chart first, then summary, then details) so nothing clips.
 */
export function CaseChartPanes({ details, chart, summary, label }: {
  details: ReactNode;
  chart: ReactNode;
  summary: ReactNode;
  label: string;
}) {
  return (
    <div className="@container/case-panes"
      role="group"
      aria-label={label}
    >
      <div data-testid="case-chart-grid" className="grid items-start gap-3 @[920px]/case-panes:grid-cols-[190px_minmax(340px,1fr)_240px]">
      <aside className="order-3 border-r border-border bg-background p-3 @[920px]/case-panes:order-1" aria-label="Case details">
        <h4 className="mb-2 text-sm font-semibold">Case details</h4>
        {details}
      </aside>
       <div data-testid="case-chart-main" className="order-1 min-w-0 space-y-3 @[920px]/case-panes:order-2">{chart}</div>
       <aside className="order-2 border-l border-border bg-background p-3 @[920px]/case-panes:order-3" aria-label="Restoration summary">
        <h4 className="mb-2 text-sm font-semibold">Restoration summary</h4>
        {summary}
      </aside>
      </div>
    </div>
  );
}

export function CaseDetailsList({ rows }: { rows: Array<[string, string | null | undefined]> }) {
  return (
    <dl className="space-y-2.5 text-sm">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt className="text-xs text-muted-foreground">{term}</dt>
          <dd className="break-words font-medium">{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface SummaryRow {
  toothNumber?: string | null;
  restorationType?: string | null;
  material?: string | null;
  shade?: string | null;
  arch?: string | null;
}

export function RestorationSummaryPane({
  headline,
  bridgeLabels,
  rows,
  warning,
}: {
  headline: string;
  bridgeLabels: string[];
  rows: SummaryRow[];
  warning?: string | null;
}) {
  const shown = rows.filter((row) => row.toothNumber || row.arch);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-sm text-muted-foreground">{headline}</p>
      {bridgeLabels.map((label) => (
        <p key={label} className="rounded-md bg-emerald-50 px-2.5 py-1.5 font-semibold text-emerald-900">{label}</p>
      ))}
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-muted-foreground">No teeth assigned yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((row, index) => (
            <li key={`${row.toothNumber}-${index}`} className="py-1.5">
              <span className="font-mono font-semibold">{row.arch ? `${row.arch === "upper" ? "Upper" : row.arch === "lower" ? "Lower" : row.arch} arch` : `#${row.toothNumber}`}</span>{" "}
              <span>{row.restorationType}</span>
              <span className="block text-xs text-muted-foreground">
                {[row.material, row.shade].filter(Boolean).join(" · ") || "Material and shade need review"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {warning && <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-950" role="alert">{warning}</p>}
    </div>
  );
}
