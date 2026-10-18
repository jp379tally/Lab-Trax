/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePagedInvoices } from "@workspace/api-client-react";

describe("authoritative paged invoice summary", () => {
  it("retains whole-set figures across paging and replaces them after a refresh", async () => {
    let revision = 0;
    const summary = () => ({
      openBalance: 1234 + revision, openCount: 30, overdueBalance: 50,
      overdueCount: 2, paidThisMonth: 999, paidCount: 4, sumTotal: 2000, sumBalance: 1234,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input), "http://localhost").searchParams.get("offset"));
      return new Response(JSON.stringify({
        rows: [{ id: `inv-${offset}`, invoiceNumber: `INV-${offset}`, status: "open", total: 1 }],
        total: 30, offset, limit: 10, hasMore: offset === 0, summary: summary(),
      }), { headers: { "Content-Type": "application/json" } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result, unmount } = renderHook(() => usePagedInvoices({ labOrganizationId: "lab-summary" }), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    try {
      await waitFor(() => expect(result.current.summary?.openBalance).toBe(1234));
      expect(result.current.total).toBe(30);
      await act(async () => { await result.current.fetchNextPage(); });
      await waitFor(() => expect(result.current.data).toHaveLength(2));
      expect(result.current.summary?.paidThisMonth).toBe(999);
      revision = 10;
      await act(async () => { await result.current.refresh(); });
      await waitFor(() => expect(result.current.summary?.openBalance).toBe(1244));
      expect(result.current.data).toHaveLength(1);
    } finally {
      unmount();
      client.clear();
      vi.unstubAllGlobals();
    }
  });
});
