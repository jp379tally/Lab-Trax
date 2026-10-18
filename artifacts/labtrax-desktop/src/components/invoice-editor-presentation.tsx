import type { ReactNode } from "react";
import "./inline-invoice.css";
import { INVOICE_PANEL_MIN_WIDTH } from "@/hooks/useInvoicePanelSize";

/** Presentation only: both surfaces share the draft, controls and mutations. */
export function InvoiceEditorPresentation({
  inline, width, children,
}: { inline: boolean; width: number | string; children: ReactNode }) {
  return (
    <div className={inline ? "inline-invoice min-w-0 rounded-lg border border-border" : "fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30"}>
      <div
        className={inline ? "min-w-0 bg-card rounded-lg" : "relative bg-card border-l border-border h-full overflow-y-auto scrollbar-thin"}
        style={inline ? undefined : { width, maxWidth: "100vw", minWidth: INVOICE_PANEL_MIN_WIDTH }}
      >
        {children}
      </div>
    </div>
  );
}
