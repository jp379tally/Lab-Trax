import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DayPicker } from "react-day-picker";
import { format } from "date-fns";
import { X } from "lucide-react";
import "react-day-picker/style.css";
import "./statement-cutoff-calendar.css";

/** Date-only state stays local; the wizard owns the existing end-of-day conversion. */
export function StatementCutoffCalendar({
  open,
  value,
  onOpenChange,
  onSelect,
  returnFocus,
}: {
  open: boolean;
  value: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  returnFocus: () => void;
}) {
  const selected = value ? new Date(`${value}T12:00:00`) : undefined;
  const today = useRef(new Date()).current;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Portal events bubble through React to the wizard's click-to-close backdrop. */}
        <Dialog.Overlay
          className="fixed inset-0 z-[60] bg-foreground/20"
          onClick={(event) => event.stopPropagation()}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="statement-cutoff-popup fixed left-1/2 top-1/2 z-[61] w-[380px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 text-foreground shadow-xl"
          onClick={(event) => event.stopPropagation()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">Invoice cutoff date</Dialog.Title>
            <Dialog.Close aria-label="Close cutoff calendar" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
              <X size={16} />
            </Dialog.Close>
          </div>
          {open && (
            <DayPicker
              mode="single"
              required
              autoFocus
              selected={selected}
              defaultMonth={selected ?? today}
              captionLayout="dropdown"
              startMonth={new Date(1900, 0)}
              endMonth={new Date(today.getFullYear() + 100, 11)}
              fixedWeeks
              onSelect={(date) => {
                if (!date) return;
                onSelect(format(date, "yyyy-MM-dd"));
                onOpenChange(false);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
