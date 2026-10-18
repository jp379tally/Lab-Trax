import { pool } from "@workspace/db";
import { afterAll, describe, expect, it } from "vitest";
import { ensureDbConstraints } from "./db-constraints";

const dbSuite = process.env.DATABASE_URL ? describe : describe.skip;

dbSuite("concurrent startup constraint installation", () => {
  afterAll(async () => { await pool.end(); });

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
});
