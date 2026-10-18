import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "expo-router";
import { rangeForPreset } from "@/lib/sales-range";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

// Exercise production paging and export helpers, not static setup doubles.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    useSalesInvoicePages: actual.useSalesInvoicePages,
    getSalesInvoices: actual.getSalesInvoices,
    fetchAllSalesInvoicePages: actual.fetchAllSalesInvoicePages,
    buildSalesInvoiceExportRows: actual.buildSalesInvoiceExportRows,
    salesInvoiceExportRowsToCsv: actual.salesInvoiceExportRowsToCsv,
  };
});

import { SalesInvoicesSection } from "../SalesInvoicesSection";

const fetchMock = vi.fn();
function page(ids: string[], offset = 0, hasMore = false, total = ids.length) {
  return { rows: ids.map((id) => ({
    id, invoiceNumber: `INV-${id}`, issuedAt: "2024-03-10T20:00:00Z",
    total: "10.00", status: "open", practiceName: "Practice", doctorName: "Doctor",
  })), offset, hasMore, total, billedTotal: (total * 10).toFixed(2) };
}
function response(data: ReturnType<typeof page>) {
  return new Response(JSON.stringify({ ok: true, data }), { headers: { "content-type": "application/json" } });
}
async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SalesInvoicesSection organizationId="lab" initialPreset="today" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(FileSystem.writeAsStringAsync).mockClear();
  vi.mocked(Sharing.shareAsync).mockClear();
  vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("mobile sales invoice list", () => {
  it("requests the local Today range and accumulates every page with matching totals", async () => {
    fetchMock.mockResolvedValueOnce(response(page(["1", "2"], 0, true, 3)))
      .mockResolvedValueOnce(response(page(["3"], 2, false, 3)));
    const view = await mount();
    await view.findByText("INV-2");
    const url = new URL(fetchMock.mock.calls[0][0], "http://localhost");
    const today = rangeForPreset("today");
    expect(url.searchParams.get("dateFrom")).toBe(today.dateFrom);
    expect(url.searchParams.get("dateTo")).toBe(today.dateTo);
    expect(view.getByText("Showing 2 of 3 invoices · Billed total $30.00")).toBeTruthy();
    await fireEvent.press(view.getByTestId("sales-invoices-load-more"));
    await view.findByText("INV-3");
    expect(view.getAllByTestId("sales-invoice-row")).toHaveLength(3);
    expect(view.getByText("Showing 3 of 3 invoices · Billed total $30.00")).toBeTruthy();
    expect(new URL(fetchMock.mock.calls[1][0], "http://localhost").searchParams.get("offset")).toBe("2");
  });

  it("opens the existing finance detail for an invoice without dropping loaded report pages", async () => {
    fetchMock.mockResolvedValueOnce(response(page(["1"], 0, true, 2)))
      .mockResolvedValueOnce(response(page(["2"], 1, false, 2)));
    const view = await mount();
    await view.findByText("INV-1");
    await fireEvent.press(view.getByTestId("sales-invoices-load-more"));
    await view.findByText("INV-2");
    await fireEvent.press(view.getAllByTestId("sales-invoice-row")[0]);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/finance/invoices",
      params: { invoiceId: "1", fromSalesReport: "1" },
    });
    expect(view.getAllByTestId("sales-invoice-row")).toHaveLength(2);
    expect(view.getByText("Showing 2 of 2 invoices · Billed total $20.00")).toBeTruthy();
  });

  it("keeps loaded rows on paging error and retries the same missing page", async () => {
    fetchMock.mockResolvedValueOnce(response(page(["1"], 0, true, 2)))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(page(["2"], 1, false, 2)));
    const view = await mount();
    await view.findByText("INV-1");
    await fireEvent.press(view.getByTestId("sales-invoices-load-more"));
    await view.findByTestId("sales-invoices-next-error");
    expect(view.getByText("INV-1")).toBeTruthy();
    await fireEvent.press(view.getByText("Retry"));
    await view.findByText("INV-2");
    expect(view.queryByTestId("sales-invoices-next-error")).toBeNull();
  });

  it("shows initial loading, error retry, and empty state", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response(page([])));
    const view = await mount();
    await view.findByTestId("sales-invoices-error");
    await fireEvent.press(view.getByText("Retry"));
    await view.findByTestId("sales-invoices-empty");
    expect(view.getByText("Showing 0 of 0 invoices · Billed total $0.00")).toBeTruthy();
  });

  it("validates custom dates and resets the old range before loading matching invoices", async () => {
    fetchMock.mockResolvedValueOnce(response(page(["today"], 0, true, 2)))
      .mockResolvedValueOnce(response(page(["custom"], 0, true, 2)))
      .mockResolvedValueOnce(response(page(["custom-more"], 1, false, 2)));
    const view = await mount();
    await view.findByText("INV-today");
    await fireEvent.press(view.getByTestId("sales-preset-custom"));
    await fireEvent.press(view.getByTestId("sales-custom-apply"));
    expect(view.getByTestId("sales-custom-error")).toBeTruthy();
    await fireEvent.changeText(view.getByPlaceholderText("2025-01-01"), "2024-03-10");
    await fireEvent.changeText(view.getByPlaceholderText("2025-01-31"), "2024-03-11");
    await fireEvent.press(view.getByTestId("sales-custom-apply"));
    await view.findByText("INV-custom");
    expect(view.queryByText("INV-today")).toBeNull();
    await fireEvent.press(view.getByTestId("sales-invoices-load-more"));
    await view.findByText("INV-custom-more");
    await fireEvent.press(view.getAllByTestId("sales-invoice-row")[0]);
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: "/finance/invoices",
      params: { invoiceId: "custom", fromSalesReport: "1" },
    });
    expect(view.getAllByTestId("sales-invoice-row")).toHaveLength(2);
    expect(view.getByText("Showing 2 of 2 invoices · Billed total $20.00")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const url = new URL(fetchMock.mock.calls[1][0], "http://localhost");
    expect(new Date(url.searchParams.get("dateFrom")!).getTime()).toBe(new Date(2024, 2, 10).getTime());
    expect(new Date(url.searchParams.get("dateTo")!).getTime()).toBe(new Date(2024, 2, 11, 23, 59, 59, 999).getTime());
  });

  it("shares every invoice and a reconciled total, not just the loaded page", async () => {
    fetchMock.mockResolvedValueOnce(response(page(["1"], 0, true, 2)))
      .mockResolvedValueOnce(response(page(["1"], 0, true, 2)))
      .mockResolvedValueOnce(response(page(["2"], 1, false, 2)));
    const view = await mount();
    await view.findByText("INV-1");
    await fireEvent.press(view.getByTestId("sales-invoices-export"));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledTimes(1));
    const csv = vi.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1];
    expect(csv).toContain("INV-1");
    expect(csv).toContain("INV-2");
    expect(csv).toContain("reconciliation");
    expect(csv).toContain("MATCH");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not share a partial export when totals change during paging", async () => {
    fetchMock.mockResolvedValueOnce(response(page(["1"], 0, true, 2)))
      .mockResolvedValueOnce(response(page(["1"], 0, true, 2)))
      .mockResolvedValueOnce(response({ ...page(["2"], 1, false, 2), billedTotal: "99.00" }));
    const view = await mount();
    await view.findByText("INV-1");
    await fireEvent.press(view.getByTestId("sales-invoices-export"));
    await view.findByTestId("sales-invoices-export-error");
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
});
