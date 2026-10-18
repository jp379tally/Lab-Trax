/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvoicePreviewPanel, INVOICE_PREVIEW_QUERY_KEY } from "@/components/invoice-preview-panel";

describe("invoice preview freshness and keyboard access", () => {
  it("refreshes authoritative figures after register refresh and workflow invalidation", async () => {
    let balance = 100;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "preview-refresh", invoiceNumber: "INV-FRESH", status: "open",
      total: 100, balanceDue: balance, payments: [{ amount: 100 - balance }],
      items: [], displayMetadata: {},
    }), { headers: { "Content-Type": "application/json" } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const props = { invoiceId: "preview-refresh", canRecordPayment: true, onClose: vi.fn(), onEdit: vi.fn(), onRecordPayment: vi.fn() };
    const view = (token: number) => <QueryClientProvider client={client}><InvoicePreviewPanel {...props} refreshToken={token} /></QueryClientProvider>;
    const { rerender, unmount } = render(view(1));
    try {
      await waitFor(() => expect(screen.getByTestId("invoice-preview-balance")).toHaveTextContent("$100.00"));
      balance = 60;
      rerender(view(2));
      await waitFor(() => expect(screen.getByTestId("invoice-preview-balance")).toHaveTextContent("$60.00"));
      expect(screen.getByTestId("invoice-preview-payments")).toHaveTextContent("$40.00");
      balance = 20;
      await client.invalidateQueries({ queryKey: INVOICE_PREVIEW_QUERY_KEY });
      await waitFor(() => expect(screen.getByTestId("invoice-preview-balance")).toHaveTextContent("$20.00"));
    } finally {
      unmount();
      client.clear();
      vi.unstubAllGlobals();
    }
  });

  it("keeps narrow-panel keyboard focus inside and closes on Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const close = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<QueryClientProvider client={client}>
      <InvoicePreviewPanel invoiceId="gone" canRecordPayment onClose={close} onEdit={vi.fn()} onRecordPayment={vi.fn()} />
    </QueryClientProvider>);
    try {
      await screen.findByTestId("invoice-preview-missing");
      expect(screen.getByTestId("invoice-preview-close")).toHaveFocus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(screen.getByTestId("invoice-preview-close")).toHaveFocus();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      unmount();
      expect(opener).toHaveFocus();
      opener.remove();
      client.clear();
      vi.unstubAllGlobals();
    }
  });
});
