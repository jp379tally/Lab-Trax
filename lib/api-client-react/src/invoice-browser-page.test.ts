import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", () => ({
  useQuery: queryMock,
  useInfiniteQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));
vi.mock("./custom-fetch", () => ({ customFetch: fetchMock }));
import { useInvoiceBrowserPage } from "./mobile-hooks";
import { FINANCE_INVOICES_QUERY_KEY } from "./finance-query-keys";

describe("browser invoice page contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReturnValue({ data: undefined, refetch: vi.fn() });
  });

  it("requests one bounded offset page with every filter and cancellation signal", async () => {
    const summary = { totalInvoices: 150, statusCounts: { all: 60 } };
    fetchMock.mockResolvedValue({ data: {
      rows: [{ id: "i" }], total: 60, limit: 25, offset: 25, hasMore: true, summary,
    } });
    const params = { practiceId: "p", search: "patient", status: "paid,void", sortBy: "due" as const, sortDirection: "asc" as const };
    useInvoiceBrowserPage(params, { page: 2, pageSize: 25 });
    const options = queryMock.mock.calls[0][0];
    expect(options.queryKey.slice(0, FINANCE_INVOICES_QUERY_KEY.length)).toEqual(FINANCE_INVOICES_QUERY_KEY);
    const signal = new AbortController().signal;
    const result = await options.queryFn({ signal });
    const [url, init] = fetchMock.mock.calls[0];
    const qs = new URL(url, "http://test").searchParams;
    expect(Object.fromEntries(qs)).toEqual({
      limit: "25", offset: "25", practiceId: "p", search: "patient",
      status: "paid,void", sortBy: "due", sortDirection: "asc",
    });
    expect(init.signal).toBe(signal);
    expect(result.summary).toBe(summary);
    expect(result.rows).toHaveLength(1);
  });

  it("can be disabled on native and keeps page/filter identities separate", () => {
    useInvoiceBrowserPage({ practiceId: "p" }, { page: 1, pageSize: 25, enabled: false });
    const first = queryMock.mock.calls[0][0];
    expect(first.enabled).toBe(false);
    useInvoiceBrowserPage({ practiceId: "other" }, { page: 2, pageSize: 50 });
    expect(queryMock.mock.calls[1][0].queryKey).not.toEqual(first.queryKey);
  });

  it("rejects malformed pages instead of silently presenting an empty list", async () => {
    fetchMock.mockResolvedValue({ data: { error: "missing page" } });
    useInvoiceBrowserPage({}, { page: 1, pageSize: 25 });
    await expect(queryMock.mock.calls[0][0].queryFn({ signal: undefined })).rejects.toThrow("invalid page");
  });

  it("slices legacy whole-array responses rather than displaying every row on each page", async () => {
    fetchMock.mockResolvedValue(Array.from({ length: 30 }, (_, id) => ({ id })));
    useInvoiceBrowserPage({}, { page: 2, pageSize: 25 });
    const result = await queryMock.mock.calls[0][0].queryFn({ signal: undefined });
    expect(result.rows.map((r: { id: number }) => r.id)).toEqual([25, 26, 27, 28, 29]);
    expect(result.total).toBe(30);
    expect(result.hasMore).toBe(false);
  });
});
