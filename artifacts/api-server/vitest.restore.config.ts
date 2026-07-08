import { defineConfig } from "vitest/config";

// Dedicated config for the backup/restore integrity gate (rel-backup-restore).
//
// These two suites perform DB-WIDE destructive pg_restore runs, so they are
// excluded from the default full-suite config (vitest.config.ts) — running
// them alongside sibling DB-integration files corrupts both directions
// (restore truncates tables under siblings; sibling writes skew the restore's
// post-restore count validation). The gate runs them here, alone, wrapped in
// the with-db-lock advisory-lock wrapper.
// See REGRESSION_GUARDRAILS.md → "DB Serialization Rule (with-db-lock)".
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/routes/backup-restore.test.ts",
      "src/routes/restore-session.test.ts",
    ],
    env: {
      // Same hermeticity/pool settings as the main config (vitest.config.ts).
      LABTRAX_ENABLE_DEMO_SEEDS: "false",
      LOG_LEVEL: "silent",
      DB_POOL_MAX: "5",
      DB_CONNECT_TIMEOUT_MS: "60000",
    },
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
    hookTimeout: 90000,
    testTimeout: 90000,
  },
});
