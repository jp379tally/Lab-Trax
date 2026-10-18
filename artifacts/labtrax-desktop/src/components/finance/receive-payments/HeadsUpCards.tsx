import type { ReactNode } from "react";
import { CalendarClock, CircleDollarSign, FileText, Loader2, Users } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { daysLabel, plural, type SelectionTotals } from "./model";

export type HeadsUpState =
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; totals: SelectionTotals; payableCount: number };

type Tone = "primary" | "success" | "warning" | "violet";

const TONES: Record<Tone, { card: string; icon: string }> = {
  primary: {
    card: "bg-primary/[0.04] border-primary/15",
    icon: "bg-primary/10 text-primary",
  },
  success: {
    card: "bg-success/[0.06] border-success/20",
    icon: "bg-success/15 text-emerald-700 dark:text-success",
  },
  warning: {
    card: "bg-warning/[0.08] border-warning/25",
    icon: "bg-warning/20 text-amber-700 dark:text-warning",
  },
  violet: {
    card: "bg-violet-500/[0.05] border-violet-500/20",
    icon: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
};

function HeadsUpCard({
  testId,
  tone,
  icon,
  label,
  value,
  detail,
  state,
}: {
  testId: string;
  tone: Tone;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: ReactNode;
  state: HeadsUpState["status"];
}) {
  const colors = TONES[tone];
  return (
    <div
      data-testid={testId}
      className={`min-w-0 rounded-xl border p-3 @min-[60rem]:p-4 flex items-start gap-3 ${colors.card}`}
    >
      <span
        aria-hidden="true"
        className={`hidden @min-[56rem]:flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${colors.icon}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span aria-hidden="true" className={`@min-[56rem]:hidden flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${colors.icon} [&>svg]:h-3 [&>svg]:w-3`}>
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </div>
        <div
          data-testid={`${testId}-value`}
          className={`mt-1 text-lg @min-[56rem]:text-2xl font-semibold tabular-nums leading-tight ${state === "ready" ? "" : "text-muted-foreground"}`}
        >
          {state === "loading" ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-sm font-medium">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading…
            </span>
          ) : state === "unavailable" ? (
            <span className="text-base font-medium">Unavailable</span>
          ) : (
            value
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

/** The four heads-up cards: live figures for the current selection. */
export function HeadsUpCards({ state }: { state: HeadsUpState }) {
  const ready = state.status === "ready" ? state : null;
  const totals = ready?.totals;
  const unavailableDetail = state.status === "unavailable" ? state.reason : "";
  const oldest = totals?.oldest ?? null;
  const oldestDays = oldest?.invoice.daysPastDue ?? null;
  return (
    <div className="grid grid-cols-2 @min-[40rem]:grid-cols-4 gap-3">
      <HeadsUpCard
        testId="heads-up-customers"
        tone="primary"
        icon={<Users size={18} />}
        label="Customers Selected"
        state={state.status}
        value={totals?.customers ?? 0}
        detail={
          ready
            ? `of ${plural(ready.payableCount, "customer")} with a balance due`
            : unavailableDetail
        }
      />
      <HeadsUpCard
        testId="heads-up-invoices"
        tone="success"
        icon={<FileText size={18} />}
        label="Invoices Selected"
        state={state.status}
        value={totals?.invoices ?? 0}
        detail={ready ? "Total invoices" : unavailableDetail}
      />
      <HeadsUpCard
        testId="heads-up-amount"
        tone="warning"
        icon={<CircleDollarSign size={18} />}
        label="Payment Amount"
        state={state.status}
        value={totals && totals.amount !== null ? formatMoney(totals.amount) : "Unavailable"}
        detail={
          ready
            ? totals && totals.amount === null
              ? "A selected balance is not available"
              : "Will be applied to selected invoices"
            : unavailableDetail
        }
      />
      <HeadsUpCard
        testId="heads-up-oldest"
        tone="violet"
        icon={<CalendarClock size={18} />}
        label="Oldest Invoice"
        state={state.status}
        value={
          !oldest
            ? "—"
            : oldestDays === null
              ? "No date"
              : oldestDays > 0
                ? daysLabel(oldestDays)
                : "Not yet due"
        }
        detail={
          ready
            ? oldest
              ? oldest.customerName
              : "No invoices selected"
            : unavailableDetail
        }
      />
    </div>
  );
}
