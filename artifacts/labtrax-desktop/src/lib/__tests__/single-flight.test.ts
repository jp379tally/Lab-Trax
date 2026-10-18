import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "../single-flight";
describe("in-flight reads", () => {
  it("deduplicates poll/open overlap but never extends freshness or crosses users", async () => {
    const read = createSingleFlight<number>();
    let resolve!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const a = read("user-a", load);
    expect(read("user-a", load)).toBe(a);
    const b = read("user-b", () => Promise.resolve(2));
    expect(b).not.toBe(a);
    resolve(1);
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe(2);
    await expect(read("user-a", () => Promise.resolve(3))).resolves.toBe(3);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("releases failed requests for the next scheduled poll", async () => {
    const read = createSingleFlight<number>();
    await expect(read("a", () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    await expect(read("a", () => Promise.resolve(1))).resolves.toBe(1);
  });
});
