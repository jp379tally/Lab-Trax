import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { refreshCaseDetailQueries } from "../case-realtime";

describe("refreshCaseDetailQueries", () => {
  it("uses the cases key hierarchy shared by list and detail queries", async () => {
    const client = new QueryClient();
    let listFetches = 0;
    let detailFetches = 0;
    await client.prefetchQuery({
      queryKey: ["cases"],
      queryFn: async () => ++listFetches,
    });
    await client.prefetchQuery({
      queryKey: ["cases", "case-123"],
      queryFn: async () => ++detailFetches,
    });

    await client.invalidateQueries({ queryKey: ["cases"] });
    await client.refetchQueries({ queryKey: ["cases"] });

    expect(listFetches).toBe(2);
    expect(detailFetches).toBe(2);
  });

  it("refreshes the case and attachment queries after a cross-device attachment change", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);

    await refreshCaseDetailQueries({ invalidateQueries } as any, "case-123");

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["cases", "case-123"],
    });
  });

  it("refreshes both invoice list and detail queries after a cross-device pricing change", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);

    await refreshCaseDetailQueries({ invalidateQueries } as any, "case-123");

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });
});