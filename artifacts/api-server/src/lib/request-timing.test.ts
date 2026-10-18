import { describe, expect, it } from "vitest";
import type pg from "pg";
import { instrumentPoolCheckout, withDbRequestTiming } from "@workspace/db";
describe("pool checkout timing", () => {
  it("preserves callback/promise interfaces, receiver and failed checkout accounting", async () => {
    const client = { release() {} };
    const pool = {
      marker: true,
      connect(callback?: (error: Error | undefined, client?: unknown, release?: () => void) => void) {
        expect(this.marker).toBe(true);
        if (callback) { callback(undefined, client, () => {}); return; }
        return Promise.resolve(client);
      },
    };
    instrumentPoolCheckout(pool as unknown as pg.Pool);
    const timing = { checkouts: 0, checkoutMs: 0, maxCheckoutMs: 0 };
    await withDbRequestTiming(timing, async () => {
      expect(await pool.connect()).toBe(client);
      await new Promise<void>((resolve) => pool.connect((error, returned, release) => {
        expect(error).toBeUndefined();
        expect(returned).toBe(client);
        release?.();
        resolve();
      }));
    });
    expect(timing.checkouts).toBe(2);
    expect(timing.checkoutMs).toBeGreaterThanOrEqual(0);
    await pool.connect();
    expect(timing.checkouts).toBe(2);
    const failure = new Error("checkout failed");
    const bad = { connect: () => Promise.reject(failure) };
    instrumentPoolCheckout(bad as unknown as pg.Pool);
    await expect(withDbRequestTiming(timing, () => bad.connect())).rejects.toBe(failure);
    expect(timing.checkouts).toBe(3);
  });
});
