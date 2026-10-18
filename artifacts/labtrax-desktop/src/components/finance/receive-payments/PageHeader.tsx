import { ArrowRight, Clock3, HandCoins } from "lucide-react";

export function ReceivePaymentsHeader({ onViewAging }: { onViewAging: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <HandCoins size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">Receive Payments</h2>
          <p className="text-sm text-muted-foreground">
            Select one or more customers to receive payment for outstanding invoices.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onViewAging}
        className="h-9 shrink-0 px-3 rounded-lg border border-border bg-card text-sm font-medium text-primary inline-flex items-center gap-2 shadow-sm hover:bg-secondary/60"
      >
        <Clock3 size={15} aria-hidden="true" />
        View Receivables Aging
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
