import { useEffect, useRef, useState } from "react";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { buildInvoicesPdf } from "@/lib/export";
import { printBatchInWindow, reserveBatchPrintWindow } from "@/lib/batch-print-window";
import { prepareSelectedInvoices, prepareSelectedLabSlips } from "@/lib/selected-case-documents";

export function SelectedCasePrintActions({ selectedIds, isAdmin, onBusyChange }: {
  selectedIds: ReadonlySet<string>;
  isAdmin: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const busy = useRef(false);
  const printWindow = useRef<Window | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => () => { printWindow.current?.close(); }, []);

  async function print(kind: "invoices" | "slips") {
    if (busy.current || !selectedIds.size) return;
    const capturedIds = [...selectedIds];
    busy.current = true;
    onBusyChange?.(true);
    setProgress(`Preparing 0 of ${capturedIds.length}…`);
    let win: Window | undefined;
    try {
      win = reserveBatchPrintWindow();
      printWindow.current = win;
      const update = (done: number, total: number) => setProgress(`Preparing ${done} of ${total}…`);
      if (kind === "invoices") {
        const { options, missing } = await prepareSelectedInvoices(capturedIds, update);
        if (!options.length) {
          toast.error(`No invoices exist for the ${missing.length} selected case${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. No print job opened.`);
          win.close();
          return;
        }
        if (missing.length && !window.confirm(
          `${missing.length} selected case${missing.length === 1 ? " has" : "s have"} no invoice: ${missing.join(", ")}.\n\nPrint the ${options.length} remaining invoice${options.length === 1 ? "" : "s"}?`,
        )) {
          win.close();
          return;
        }
        setProgress("Printing selected invoices…");
        await printBatchInWindow(win, buildInvoicesPdf(options));
      } else {
        const documents = await prepareSelectedLabSlips(capturedIds, isAdmin, update);
        setProgress("Printing selected lab slips…");
        await printBatchInWindow(win, documents);
      }
    } catch (error) {
      win?.close();
      toast.error(`${error instanceof Error ? error.message : "Could not prepare documents."} Check access, connection, and pop-up permissions, then try again.`);
    } finally {
      busy.current = false;
      onBusyChange?.(false);
      printWindow.current = null;
      setProgress(null);
    }
  }

  const cls = "inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 transition-colors border border-border disabled:opacity-50 disabled:cursor-not-allowed";
  return <>
    <button type="button" disabled={!!progress || !selectedIds.size} onClick={() => void print("invoices")} className={cls}>
      <Printer size={13} /> Print Invoices
    </button>
    <button type="button" disabled={!!progress || !selectedIds.size} onClick={() => void print("slips")} className={cls}>
      <Printer size={13} /> Print Lab Slips
    </button>
    {progress && <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />{progress}</span>}
  </>;
}
