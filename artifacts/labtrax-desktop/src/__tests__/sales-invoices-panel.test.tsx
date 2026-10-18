// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesInvoicesPanel } from "@/components/reports/SalesInvoicesPanel";

const apiFetch = vi.hoisted(() => vi.fn());
const downloadCsv = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  apiFetch,
}));
vi.mock("@/lib/export", () => ({
  downloadCsv,
}));
const row = (id: string, status = "sent") => ({
  id, invoiceNumber: `INV-${id}`, issuedAt: "2025-01-02T10:00:00Z", total: "10.00",
  status, practiceName: null, doctorName: null,
});
const page = (ids: string[], offset: number, hasMore: boolean, total = 3, status = "sent") => ({
  data: { rows: ids.map((id) => row(id, status)), offset, total, billedTotal: (total * 10).toFixed(2), hasMore },
});

function renderPanel(from = "a", to = "b") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (f: string, t: string) => (
    <QueryClientProvider client={qc}>
      <SalesInvoicesPanel organizationId="org" dateFrom={f} dateTo={t} />
    </QueryClientProvider>
  );
  const r = render(ui(from, to));
  return { ...r, rerangeTo: (f: string, t: string) => r.rerender(ui(f, t)) };
}

beforeEach(() => {
  apiFetch.mockReset();
  downloadCsv.mockClear();
  window.history.replaceState({}, "", "/reports?tab=sales");
});

describe("SalesInvoicesPanel", () => {
  it("accumulates pages and shows loaded of total with billed total", async () => {
    apiFetch
      .mockResolvedValueOnce(page(["1", "2"], 0, true))
      .mockResolvedValueOnce(page(["3"], 2, false));
    renderPanel();
    await screen.findByText("INV-2");
    expect(screen.getByTestId("sales-invoices-caption").textContent).toContain("Showing 2 of 3");
    expect(screen.getByTestId("sales-invoices-caption").textContent).toContain("$30.00");
    fireEvent.click(screen.getByText("Load more"));
    await screen.findByText("INV-3");
    expect(screen.getAllByTestId("sales-invoice-row")).toHaveLength(3);
    expect(apiFetch.mock.calls[1][0]).toContain("offset=2");
  });

  it("opens an invoice preview and carries the exact report range back", async () => {
    window.history.replaceState({}, "", "/reports?tab=sales&groupBy=day&stats-groupBy=year");
    apiFetch.mockResolvedValueOnce(page(["1"], 0, false, 1));
    renderPanel("2025-01-01T00:00:00.000Z", "2025-01-31T23:59:59.999Z");
    await screen.findByText("INV-1");

    fireEvent.click(screen.getByTestId("sales-invoice-open-1"));

    await waitFor(() => expect(window.location.pathname).toBe("/invoices"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("previewId")).toBe("1");
    const returnTo = new URL(params.get("returnTo")!, "http://localhost");
    expect(returnTo.pathname).toBe("/reports");
    expect(returnTo.searchParams.get("tab")).toBe("sales");
    expect(returnTo.searchParams.get("from")).toBe("2025-01-01T00:00:00.000Z");
    expect(returnTo.searchParams.get("to")).toBe("2025-01-31T23:59:59.999Z");
    expect(returnTo.searchParams.get("org")).toBe("org");
    expect(returnTo.searchParams.get("groupBy")).toBe("day");
    expect(returnTo.searchParams.get("stats-groupBy")).toBe("year");
  });

  it("restores previously loaded pages when returning to the same report range", async () => {
    apiFetch
      .mockResolvedValueOnce(page(["1", "2"], 0, true))
      .mockResolvedValueOnce(page(["3"], 2, false));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (
      <QueryClientProvider client={client}>
        <SalesInvoicesPanel organizationId="org" dateFrom="from" dateTo="to" />
      </QueryClientProvider>
    );
    const report = render(ui);
    await screen.findByText("INV-2");
    fireEvent.click(screen.getByText("Load more"));
    await screen.findByText("INV-3");
    report.unmount();

    render(ui);

    expect(await screen.findByText("INV-3")).toBeTruthy();
    expect(screen.getAllByTestId("sales-invoice-row")).toHaveLength(3);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("resets rows when the range changes", async () => {
    apiFetch
      .mockResolvedValueOnce(page(["1"], 0, false, 1))
      .mockResolvedValueOnce(page(["9"], 0, false, 1));
    const { rerangeTo } = renderPanel();
    await screen.findByText("INV-1");
    rerangeTo("2025-02-01", "2025-02-28");
    await screen.findByText("INV-9");
    expect(screen.queryByText("INV-1")).toBeNull();
  });

  it("exports all invoices and reconciliation totals for the selected range", async () => {
    apiFetch
      .mockResolvedValueOnce(page(["1"], 0, true, 2))
      .mockResolvedValueOnce(page(["1"], 0, true, 2))
      .mockResolvedValueOnce(page(["2"], 1, false, 2));
    renderPanel("2025-01-01T00:00:00.000Z", "2025-01-31T23:59:59.999Z");
    await screen.findByText("INV-1");
    fireEvent.click(screen.getByTestId("sales-invoices-export"));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
    const [filename, rows] = downloadCsv.mock.calls[0];
    expect(filename).toContain("sales-invoices-2025-01-01-2025-01-31.csv");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      record_type: "invoice",
      invoice_number: "INV-2",
      selected_date_from: "2025-01-01T00:00:00.000Z",
      persisted_total: "10.00",
    });
    expect(rows[2]).toMatchObject({
      record_type: "reconciliation",
      expected_invoice_count: 2,
      expected_persisted_total: "20.00",
      exported_invoice_count: 2,
      exported_persisted_total: "20.00",
      reconciliation_result: "MATCH",
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it("does not download a partial export if the reported totals change during paging", async () => {
    apiFetch
      .mockResolvedValueOnce(page(["1"], 0, true, 2))
      .mockResolvedValueOnce(page(["1"], 0, true, 2))
      .mockResolvedValueOnce({
        data: { ...page(["2"], 1, false, 2).data, billedTotal: "99.00" },
      });
    renderPanel();
    await screen.findByText("INV-1");
    fireEvent.click(screen.getByTestId("sales-invoices-export"));
    await screen.findByTestId("sales-invoices-export-error");
    expect(downloadCsv).not.toHaveBeenCalled();
  });

  it("shows empty state", async () => {
    apiFetch.mockResolvedValueOnce(page([], 0, false, 0));
    renderPanel();
    await screen.findByTestId("sales-invoices-empty");
  });

  it("shows actual invoice status text and the compact export panel without excluded filters", async () => {
    apiFetch.mockResolvedValueOnce(page(["1"], 0, false, 1, "partially_paid"));
    renderPanel();

    await screen.findByText("INV-1");

    expect(screen.getByTestId("sales-invoice-status")).toHaveAttribute("data-status", "partially_paid");
    expect(screen.getByText("partially paid")).toBeTruthy();
    expect(screen.getByTestId("sales-invoice-status").className).toContain("text-amber");
    expect(screen.getByTestId("sales-invoice-open-1").className).toContain("text-primary");
    expect(screen.getByRole("button", { name: "Export invoices CSV" })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/search invoices/i)).toBeNull();
    expect(screen.queryByText(/all statuses/i)).toBeNull();
    expect(screen.queryByText(/previous period/i)).toBeNull();
  });

  it("shows error with retry, and keeps rows on next-page failure", async () => {
    apiFetch.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(page(["1"], 0, true));
    renderPanel();
    fireEvent.click(await screen.findByText("Retry"));
    await screen.findByText("INV-1");
    apiFetch.mockRejectedValueOnce(new Error("y"));
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => screen.getByTestId("sales-invoices-next-error"));
    expect(screen.getByText("INV-1")).toBeTruthy();
  });
});
