import { describe, expect, it } from "vitest";
import { fetchAllPages } from "../fetch-all-pages";

const page = (rows: { id: string }[], total: number, hasMore: boolean) => ({ rows, total, limit: 100, offset: 0, hasMore });

describe("fetchAllPages strictness", () => {
  it("fails when the terminal count differs from total", async () => {
    await expect(fetchAllPages({ fetchPage: async () => page([{ id: "a" }], 3, false) })).rejects.toThrow(/incomplete/);
  });
  it("fails when total changes between batches", async () => {
    let n = 0;
    await expect(fetchAllPages({ fetchPage: async () => (n++ === 0 ? page([{ id: "a" }], 2, true) : page([{ id: "b" }], 3, false)) })).rejects.toThrow(/changed/);
  });
  it("fails on duplicate ids and malformed bodies", async () => {
    let n = 0;
    await expect(fetchAllPages({ getId: (r: { id: string }) => r.id, fetchPage: async () => (n++ === 0 ? page([{ id: "a" }], 2, true) : page([{ id: "a" }], 2, false)) })).rejects.toThrow(/duplicate/);
    await expect(fetchAllPages({ fetchPage: async () => ({} as never) })).rejects.toThrow(/unexpected/);
  });
  it("honours abort after the awaited fetch", async () => {
    const c = new AbortController();
    await expect(fetchAllPages({ signal: c.signal, fetchPage: async () => { c.abort(); return page([], 0, false); } })).rejects.toThrow(/cancelled/);
  });
  it("accepts a complete page", async () => {
    expect(await fetchAllPages({ fetchPage: async () => page([{ id: "a" }], 1, false) })).toHaveLength(1);
  });
});
