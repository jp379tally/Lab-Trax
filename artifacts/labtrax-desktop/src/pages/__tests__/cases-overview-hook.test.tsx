/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseCasesOverview, useCasesOverview } from "@workspace/api-client-react";

const counts = {
  totalCases: 812, dueToday: 14, conflicts: 2, rushCases: 8,
  processingCases: 42, inTransitCases: 33, completedCases: 120, overdueCases: 6,
  receivedCases: 80, inDesignCases: 17, modelRoomCases: 4, shippedCases: 33,
  scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
  porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Shared native Cases overview query", () => {
  it("uses fresh local calendar/clock on every request and refreshes with existing case invalidations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 6, 23, 59));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ data: counts }), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(() => useCasesOverview(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.data).toEqual(counts));
    let params = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost").searchParams;
    expect(params.get("localDate")).toBe("2026-10-06");
    expect(params.get("localTime")).toBe("23:59");
    expect(params.has("search")).toBe(false);
    vi.setSystemTime(new Date(2026, 9, 7, 0, 1));
    await act(async () => { await qc.invalidateQueries({ queryKey: ["cases"] }); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    params = new URL(String(fetchMock.mock.calls[1][0]), "http://localhost").searchParams;
    expect(params.get("localDate")).toBe("2026-10-07");
    expect(params.get("localTime")).toBe("00:01");
    unmount();
    qc.clear();
  });

  it("rejects malformed or partial counts instead of reporting zeros", () => {
    for (const broken of [undefined, {}, { ...counts, conflicts: -1 }, { ...counts, totalCases: "812" }, { ...counts, dueToday: NaN }]) {
      expect(() => parseCasesOverview(broken)).toThrow(/summary/);
    }
    expect(parseCasesOverview({
      totalCases: 0, dueToday: 0, conflicts: 0, rushCases: 0,
      processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
      receivedCases: 0, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
      scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
      porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
    }).totalCases).toBe(0);
  });
});
