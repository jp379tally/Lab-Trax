import { afterEach, describe, expect, it, vi } from "vitest";
import { prescriptionReviewContext } from "../prescription-review-context";

afterEach(() => vi.useRealTimers());

describe("prescription-to-editable-review matching", () => {
  it.each([
    ["single crown", [300, 200, 400]],
    ["bridge prescription", [500, 400, 600]],
    ["multi-page removable prescription", [800, 700, 900]],
  ] as const)("measures parallel matching versus the old sequential wait: %s", async (_name, delays) => {
    vi.useFakeTimers();
    const delay = (ms: number, value: string) => new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));
    const start = Date.now();
    const old = (async () => {
      await delay(delays[0], "memory");
      await delay(delays[1], "alias");
      await delay(delays[2], "doctor");
    })();
    await vi.runAllTimersAsync();
    await old;
    const beforeMs = Date.now() - start;
    const afterStart = Date.now();
    const result = prescriptionReviewContext(
      () => delay(delays[0], "memory"),
      () => delay(delays[1], "alias"),
      () => delay(delays[2], "doctor"),
    );
    await vi.runAllTimersAsync();
    const context = await result;
    const afterMs = Date.now() - afterStart;
    expect(beforeMs).toBe(delays.reduce((a, b) => a + b, 0));
    expect(afterMs).toBe(Math.max(...delays));
    expect(context.remembered.value).toBe("memory");
    expect(context.aliased.value).toBe("alias");
    expect(context.resolvedDoctor.value).toBe("doctor");
    console.info(JSON.stringify({ fixture: _name, simulatedMatchingBeforeMs: beforeMs, simulatedMatchingAfterMs: afterMs }));
  });

  it("caps ALL matching waits at one deadline even if adapters ignore cancellation", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const hung = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    };
    const pending = prescriptionReviewContext(hung, hung, hung);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(Object.values(result).every((lookup) => lookup.unavailable)).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves successful memory when alias fails and doctor times out", async () => {
    vi.useFakeTimers();
    const pending = prescriptionReviewContext(
      async () => ({ found: true, providerOrganizationId: "synthetic-practice" }),
      async () => { throw new Error("synthetic lookup outage"); },
      () => new Promise<never>(() => {}),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.remembered).toEqual({
      value: { found: true, providerOrganizationId: "synthetic-practice" }, unavailable: false,
    });
    expect(result.aliased.unavailable).toBe(true);
    expect(result.resolvedDoctor.unavailable).toBe(true);
  });
});
