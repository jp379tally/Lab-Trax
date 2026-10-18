import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/format";
import { plural, type PayableCustomer } from "./model";

function customerDetail(customer: PayableCustomer): { balance: string; sent: string | null } {
  if (customer.statement) {
    return {
      balance: `${plural(customer.statement.statementCount, "unpaid sent statement")} · ${formatMoney(
        customer.account.currentBalanceDue,
      )}`,
      sent: customer.statement.sentDates.length
        ? `Sent ${customer.statement.sentDates.map((date) => formatDate(date)).join(", ")}`
        : null,
    };
  }
  return {
    balance: `${plural(customer.unpaidCount, "unpaid invoice")} · ${formatMoney(customer.totalBalance)}`,
    sent: null,
  };
}

/**
 * Adds or removes customers from the batch while it is being received.
 * Completed customers stay checked and cannot be reopened, and the whole
 * menu is locked while a payment is saving or its receipt is open.
 */
export function CustomerQueuePicker({
  customers,
  selectedIds,
  completedIds,
  label,
  locked,
  onToggle,
}: {
  customers: readonly PayableCustomer[];
  selectedIds: readonly string[];
  completedIds: readonly string[];
  label: string;
  /** A save is pending or a receipt is open. */
  locked: boolean;
  onToggle: (customer: PayableCustomer) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const closeAndFocus = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        data-testid="receive-practice-picker"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="receive-practice-options"
        aria-label="Received from practices"
        disabled={locked}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-sm disabled:opacity-60"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
      </button>
      {open && (
        <div
          id="receive-practice-options"
          role="menu"
          aria-label="Received from practice options"
          onKeyDown={(event) => {
            if (event.key === "Escape") closeAndFocus();
          }}
          className="absolute left-0 right-0 z-50 mt-2 min-w-[16rem] overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        >
          <div className="border-b border-border bg-card p-2">
            <button
              type="button"
              onClick={closeAndFocus}
              className="h-8 w-full rounded-md bg-secondary text-sm font-medium"
            >
              Complete
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {customers.map((customer) => {
              const checked = selectedIds.includes(customer.id);
              const detail = customerDetail(customer);
              return (
                <button
                  key={customer.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-label={customer.name}
                  aria-checked={checked}
                  disabled={completedIds.includes(customer.id) || locked}
                  onClick={() => onToggle(customer)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/40 disabled:opacity-60"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
                    }`}
                  >
                    {checked && <Check size={12} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{customer.name}</span>
                    <span className="block text-xs text-muted-foreground">{detail.balance}</span>
                    {detail.sent && <span className="block text-xs text-muted-foreground">{detail.sent}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
