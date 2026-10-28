import { pool } from "@workspace/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ensureDbConstraints, ensureStartupDbConstraints } from "./db-constraints";

const dbSuite = process.env.DATABASE_URL ? describe : describe.skip;

dbSuite("concurrent startup constraint installation", () => {
  afterAll(async () => { await pool.end(); });

  it("shares one startup install and releases backup services only after it commits", async () => {
    const connect = vi.spyOn(pool, "connect");
    let backupsStarted = 0;
    try {
      const first = ensureStartupDbConstraints();
      expect(ensureStartupDbConstraints()).toBe(first);
      const backupServices = first.then(() => { backupsStarted++; });
      expect(backupsStarted).toBe(0);
      await backupServices;
      expect(backupsStarted).toBe(1);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      connect.mockRestore();
    }
  }, 20000);

  it("waits for an existing initializer, completes competing startups, and releases the lock", async () => {
    const blocker = await pool.connect();
    const startups: Promise<void>[] = [];
    let sawBothWaiting = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(1280596035, 1)");
      startups.push(ensureDbConstraints(), ensureDbConstraints());
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const result = await blocker.query<{ waiting: string }>(
          "SELECT count(*)::text AS waiting FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND NOT granted",
          [1280596035, 1],
        );
        if (Number(result.rows[0].waiting) >= 2) {
          sawBothWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(sawBothWaiting).toBe(true);
    } finally {
      try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
      await Promise.all(startups);
    }
    const available = await pool.query<{ available: boolean }>(
      "SELECT pg_try_advisory_xact_lock(1280596035, 1) AS available",
    );
    expect(available.rows[0].available).toBe(true);
  }, 20000);

  it("does not take an exclusive lock on healthy provider authorization triggers", async () => {
    const relation = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.provider_autopay_authorizations') IS NOT NULL AS present",
    );
    if (!relation.rows[0]?.present) return;

    // Install once before holding the ordinary reader lock. A healthy set of
    // triggers must then be verified without DROP/CREATE on this busy table.
    await ensureDbConstraints();

    const reader = await pool.connect();
    try {
      await reader.query("BEGIN");
      await reader.query(
        "LOCK TABLE public.provider_autopay_authorizations IN ACCESS SHARE MODE",
      );
      const startedAt = Date.now();
      await ensureDbConstraints();
      expect(Date.now() - startedAt).toBeLessThan(8000);
    } finally {
      try {
        await reader.query("ROLLBACK");
      } finally {
        reader.release();
      }
    }
  }, 20000);
});
