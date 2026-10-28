import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { requireIsolatedRestoreTest } from "./restore-test-isolation";
import {
  beginDatabaseProtectionAttempt,
  DATABASE_PROTECTION_CATCHUP_KEY,
  finishDatabaseProtectionAttempt,
  hasReadyDatabaseProtectionCatchup,
  readDatabaseProtectionCatchup,
  recordDatabaseProtectionMissedInterval,
} from "./database-protection-catchup";

requireIsolatedRestoreTest();

const source = "e".repeat(64);
const advisoryLock = "SELECT pg_try_advisory_lock(80451, 15001) AS held";
const advisoryUnlock = "SELECT pg_advisory_unlock(80451, 15001)";

describe("persisted production backup catch-up coordination (isolated PostgreSQL)", () => {
  beforeAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM system_settings WHERE key = $1", [DATABASE_PROTECTION_CATCHUP_KEY]);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM system_settings WHERE key = $1", [DATABASE_PROTECTION_CATCHUP_KEY]);
    } finally {
      client.release();
    }
  });

  it("coalesces concurrent missed ticks, grants one post-release claim across workers, and suppresses duplicates", async () => {
    const activeWorker = await pool.connect();
    const queuedWorker = await pool.connect();
    const missedWorkers = [await pool.connect(), await pool.connect(), await pool.connect()];
    try {
      expect((await activeWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(true);
      expect((await queuedWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(false);

      await Promise.all([
        recordDatabaseProtectionMissedInterval(missedWorkers[0]!, source, new Date("2026-10-26T09:00:00.000Z")),
        recordDatabaseProtectionMissedInterval(missedWorkers[1]!, source, new Date("2026-10-26T09:15:00.000Z")),
        recordDatabaseProtectionMissedInterval(missedWorkers[2]!, source, new Date("2026-10-26T09:30:00.000Z")),
      ]);
      const coalesced = await readDatabaseProtectionCatchup(queuedWorker, source);
      expect(coalesced.pending).toBe(true);
      expect(coalesced.missedIntervals).toBe(3);
      expect(coalesced.generation).toBe(3);
      expect(coalesced.firstMissedAt).toBe("2026-10-26T09:00:00.000Z");
      expect(coalesced.lastMissedAt).toBe("2026-10-26T09:30:00.000Z");
      expect(await hasReadyDatabaseProtectionCatchup(queuedWorker, source)).toBe(true);

      await activeWorker.query(advisoryUnlock);
      expect((await queuedWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(true);
      const claim = await beginDatabaseProtectionAttempt(queuedWorker, source, "catchup");
      expect(claim).toEqual({ shouldRun: true, isCatchup: true, deferred: false });
      expect((await readDatabaseProtectionCatchup(queuedWorker, source)).pending).toBe(true);

      // The second worker cannot enter the same capture while the shared lock
      // is owned, even though both processes can see the persisted request.
      expect((await activeWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(false);
      await finishDatabaseProtectionAttempt(queuedWorker, source, "verified");
      expect((await readDatabaseProtectionCatchup(queuedWorker, source)).pending).toBe(false);
      await queuedWorker.query(advisoryUnlock);

      expect((await activeWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(true);
      const duplicate = await beginDatabaseProtectionAttempt(activeWorker, source, "catchup");
      expect(duplicate.shouldRun).toBe(false);
      expect((await readDatabaseProtectionCatchup(activeWorker, source)).pending).toBe(false);
      await activeWorker.query(advisoryUnlock);
    } finally {
      try { await activeWorker.query(advisoryUnlock); } catch { /* lock may already be released */ }
      try { await queuedWorker.query(advisoryUnlock); } catch { /* lock may already be released */ }
      activeWorker.release();
      queuedWorker.release();
      missedWorkers.forEach(worker => worker.release());
    }
  }, 30_000);

  it("survives restart during a claim and defers a failed retry without a self-trigger loop", async () => {
    const firstWorker = await pool.connect();
    const restartedWorker = await pool.connect();
    try {
      await recordDatabaseProtectionMissedInterval(firstWorker, source, new Date("2026-10-26T10:00:00.000Z"));
      expect((await firstWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(true);
      const firstClaim = await beginDatabaseProtectionAttempt(firstWorker, source, "catchup");
      expect(firstClaim.isCatchup).toBe(true);
      // Simulate a process restart after claiming but before recording a
      // terminal outcome: the persisted request must remain recoverable.
      await firstWorker.query(advisoryUnlock);
      expect((await readDatabaseProtectionCatchup(restartedWorker, source)).pending).toBe(true);

      expect((await restartedWorker.query<{ held: boolean }>(advisoryLock)).rows[0]?.held).toBe(true);
      const restartedClaim = await beginDatabaseProtectionAttempt(restartedWorker, source, "catchup");
      expect(restartedClaim).toEqual({ shouldRun: true, isCatchup: true, deferred: false });
      await finishDatabaseProtectionAttempt(restartedWorker, source, "failed");
      const failed = await readDatabaseProtectionCatchup(restartedWorker, source);
      expect(failed.pending).toBe(true);
      expect(failed.deferred).toBe(true);
      expect(await hasReadyDatabaseProtectionCatchup(restartedWorker, source)).toBe(false);

      // Pollers do not recursively start another catch-up after failure. The
      // next ordinary cadence can retry the same durable request once.
      const poll = await beginDatabaseProtectionAttempt(restartedWorker, source, "catchup");
      expect(poll.shouldRun).toBe(false);
      const scheduledRetry = await beginDatabaseProtectionAttempt(restartedWorker, source, "interval");
      expect(scheduledRetry).toEqual({ shouldRun: true, isCatchup: true, deferred: false });
      await finishDatabaseProtectionAttempt(restartedWorker, source, "verified");
      const recovered = await readDatabaseProtectionCatchup(restartedWorker, source);
      expect(recovered.pending).toBe(false);
      expect(recovered.deferred).toBe(false);
      expect(recovered.lastOutcome).toBe("verified");
      await restartedWorker.query(advisoryUnlock);
    } finally {
      try { await firstWorker.query(advisoryUnlock); } catch { /* lock may already be released */ }
      try { await restartedWorker.query(advisoryUnlock); } catch { /* lock may already be released */ }
      firstWorker.release();
      restartedWorker.release();
    }
  }, 30_000);

  it("coalesces new misses during a catch-up into the next cadence instead of chaining jobs", async () => {
    const worker = await pool.connect();
    try {
      await recordDatabaseProtectionMissedInterval(worker, source);
      await worker.query(advisoryLock);
      const claim = await beginDatabaseProtectionAttempt(worker, source, "catchup");
      expect(claim.isCatchup).toBe(true);
      await recordDatabaseProtectionMissedInterval(worker, source);
      await finishDatabaseProtectionAttempt(worker, source, "partial");
      const state = await readDatabaseProtectionCatchup(worker, source);
      expect(state.pending).toBe(true);
      expect(state.deferred).toBe(true);
      expect(await hasReadyDatabaseProtectionCatchup(worker, source)).toBe(false);
      expect((await beginDatabaseProtectionAttempt(worker, source, "catchup")).shouldRun).toBe(false);
      await worker.query(advisoryUnlock);

      await worker.query(advisoryLock);
      const nextCadence = await beginDatabaseProtectionAttempt(worker, source, "interval");
      expect(nextCadence).toEqual({ shouldRun: true, isCatchup: true, deferred: false });
      await finishDatabaseProtectionAttempt(worker, source, "verified");
      expect((await readDatabaseProtectionCatchup(worker, source)).pending).toBe(false);
      await worker.query(advisoryUnlock);
    } finally {
      try { await worker.query(advisoryUnlock); } catch { /* lock may already be released */ }
      worker.release();
    }
  }, 30_000);
});
