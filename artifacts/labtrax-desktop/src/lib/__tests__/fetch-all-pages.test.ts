import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_BATCH_SIZE,
  fetchAllPages,
  type ExportProgress,
} from "@/lib/fetch-all-pages";

function page(rows: number[], offset: number, total: number, limit = EXPORT_BATCH_SIZE) {
  return {
    rows,
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}

describe("fetchAllPages", () => {
  it("walks bounded batches and returns every row in server order", async () => {
    const all = Array.from({ length: 250 }, (_, index) => index);
    const requests: Array<{ limit: number; offset: number }> = [];
    const progress: ExportProgress[] = [];

    const rows = await fetchAllPages<number>({
      fetchPage: async ({ limit, offset }) => {
        requests.push({ limit, offset });
        return page(all.slice(offset, offset + limit), offset, all.length, limit);
      },
      onProgress: (p) => progress.push(p),
    });

    expect(requests).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
      { limit: 100, offset: 200 },
    ]);
    // Same rows, same order a single unbounded request would have produced.
    expect(rows).toEqual(all);
    expect(progress).toEqual([
      { loaded: 100, total: 250 },
      { loaded: 200, total: 250 },
      { loaded: 250, total: 250 },
    ]);
  });

  it("honours a custom batch size", async () => {
    const all = Array.from({ length: 7 }, (_, index) => index);
    const offsets: number[] = [];

    const rows = await fetchAllPages<number>({
      batchSize: 3,
      fetchPage: async ({ limit, offset }) => {
        offsets.push(offset);
        return page(all.slice(offset, offset + limit), offset, all.length, limit);
      },
    });

    expect(offsets).toEqual([0, 3, 6]);
    expect(rows).toEqual(all);
  });

  it("accepts the legacy whole-array response as the complete set", async () => {
    const fetchPage = vi.fn(async () => [1, 2, 3]);

    const rows = await fetchAllPages<number>({ fetchPage });

    expect(rows).toEqual([1, 2, 3]);
    // The route ignored paging, so there is nothing more to ask for.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns an empty set without a second request", async () => {
    const fetchPage = vi.fn(async () => page([], 0, 0));

    await expect(fetchAllPages<number>({ fetchPage })).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("fails instead of looping when the server reports more rows but returns none", async () => {
    const fetchPage = vi.fn(async () => ({
      rows: [] as number[],
      total: 500,
      limit: EXPORT_BATCH_SIZE,
      offset: 0,
      hasMore: true,
    }));

    await expect(fetchAllPages<number>({ fetchPage })).rejects.toThrow(
      /stopped early/,
    );
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed batch rather than returning a truncated set", async () => {
    const all = Array.from({ length: 150 }, (_, index) => index);
    const fetchPage = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => {
      if (offset > 0) throw new Error("Request timed out.");
      return page(all.slice(offset, offset + limit), offset, all.length, limit);
    });

    await expect(fetchAllPages<number>({ fetchPage })).rejects.toThrow(
      "Request timed out.",
    );
  });
});
