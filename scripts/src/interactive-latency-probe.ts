/**
 * Read-only latency/resource probe. Never prints connection strings, rows,
 * request credentials, query text or clinical data. Does not start backups.
 */
import pg from "pg";
import { performance } from "node:perf_hooks";

const production = process.argv.includes("--production");
const connectionString = production ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!connectionString) throw new Error("Requested database binding is unavailable.");
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 5_000 });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const timings = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      await client.query("SELECT 1");
      timings.push(Math.round(performance.now() - start));
    }
    console.info(JSON.stringify({ environment: production ? "production" : "development", roundTripMs: timings }));
    for (const [label, sql] of Object.entries({
      activity: `SELECT state, wait_event_type, wait_event, count(*)::int AS connections,
        max(extract(epoch from (clock_timestamp()-query_start)))::int AS longest_seconds
        FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2,3`,
      size: `SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size`,
      hotTableIndexes: `SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename IN ('notifications','user_sessions','lab_memberships')`,
    })) {
      console.info(JSON.stringify({ label, rows: (await client.query(sql)).rows }));
    }
    await client.query("ROLLBACK");
  } finally { client.release(); }
} catch {
  throw new Error("Read-only latency probe failed; check database connectivity and permissions.");
} finally { await pool.end(); }
