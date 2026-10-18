import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type pg from "pg";

export type DbRequestTiming = { checkouts: number; checkoutMs: number; maxCheckoutMs: number };
const context = new AsyncLocalStorage<DbRequestTiming>();
export function withDbRequestTiming<T>(timing: DbRequestTiming, work: () => T): T {
  return context.run(timing, work);
}

/** Covers both Drizzle's callback pool.query and transaction promise checkout. */
export function instrumentPoolCheckout(pool: pg.Pool): void {
  const connect = pool.connect.bind(pool);
  pool.connect = ((callback?: (err: Error | undefined, client: pg.PoolClient | undefined, release: ((err?: Error | boolean) => void) | undefined) => void) => {
    const timing = context.getStore();
    const start = performance.now();
    const record = () => {
      if (!timing) return;
      const elapsed = performance.now() - start;
      timing.checkouts++;
      timing.checkoutMs += elapsed;
      timing.maxCheckoutMs = Math.max(timing.maxCheckoutMs, elapsed);
    };
    if (callback) {
      return connect((err, client, release) => {
        record();
        callback(err, client, release);
      });
    }
    return connect().then(
      (client) => { record(); return client; },
      (err) => { record(); throw err; },
    );
  }) as typeof pool.connect;
}
