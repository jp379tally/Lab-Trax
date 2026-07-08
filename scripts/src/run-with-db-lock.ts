/**
 * run-with-db-lock.ts — serialize DB-touching test workflows.
 *
 * Usage: tsx ./src/run-with-db-lock.ts "<shell command>"
 *
 * Why: the backup-restore integrity suite performs a DB-WIDE pg_restore.
 * When the Run-button "Project" aggregate fires every rel-* release gate at
 * once, rel-backup-restore's restore truncates tables out from under
 * rel-api-tests' other DB integration suites (spurious 500s/timeouts), and
 * their concurrent writes skew the restore's post-restore count validation.
 * Both gates therefore wrap their test command with this script, which holds
 * a PostgreSQL session advisory lock for the duration of the command so the
 * two workflows run back-to-back instead of interleaved. The lock is
 * session-scoped: if the process dies, PG releases it automatically.
 */
import { spawn } from "node:child_process";

// Raise the PG connect timeout before importing the pool: under full
// aggregate load the TLS handshake can exceed the production 10 s fail-fast.
process.env.DB_CONNECT_TIMEOUT_MS ??= "120000";

const LOCK_NAMESPACE = 1742068800;
const LOCK_NAME = "labtrax-db-test-workflows";

const command = process.argv.slice(2).join(" ").trim();
if (!command) {
  console.error("usage: run-with-db-lock.ts \"<shell command>\"");
  process.exit(2);
}

const { pool } = await import("@workspace/db");

const client = await pool.connect();
// pg_advisory_lock's blocking wait counts as statement execution; the pool
// sets statement_timeout=30s which would kill a wait for a full suite run.
await client.query("SET statement_timeout = 0");
console.log(`[run-with-db-lock] waiting for advisory lock '${LOCK_NAME}'...`);
const waitStart = Date.now();
await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [
  LOCK_NAMESPACE,
  LOCK_NAME,
]);
console.log(
  `[run-with-db-lock] lock acquired after ${Math.round((Date.now() - waitStart) / 1000)}s; running: ${command}`,
);

const child = spawn(command, { shell: true, stdio: "inherit" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

child.on("exit", (code, signal) => {
  void (async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        LOCK_NAMESPACE,
        LOCK_NAME,
      ]);
    } catch {
      // Session teardown releases the lock regardless.
    }
    client.release();
    await pool.end().catch(() => {});
    process.exit(code ?? (signal ? 1 : 0));
  })();
});
