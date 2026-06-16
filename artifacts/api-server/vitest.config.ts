import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Keep the suite hermetic regardless of the host environment. Demo seeding
    // is a dev-only convenience; when LABTRAX_ENABLE_DEMO_SEEDS is "true" in the
    // workspace it makes seedDefaultUsers() run during app init, which throws in
    // mocked-db suites ("db.insert(...).values is not a function") and breaks
    // LabTrax route registration. Force it off so tests do not depend on it.
    env: {
      LABTRAX_ENABLE_DEMO_SEEDS: "false",
      // Silence the application logger during tests. Several suites deliberately
      // exercise 500/503 error paths, and the real pino-http logger dumps full
      // stack traces for each one, drowning the signal in the gate output. Tests
      // detect failures via assertions, not log output, so a silent logger keeps
      // the run clean and makes any genuinely new warning stand out. Suites that
      // assert on logging mock ../lib/logger.js directly and are unaffected.
      LOG_LEVEL: "silent",
      // Cap the pg connection pool per worker so two concurrent test workflows
      // (api-server-tests + regression-tests) stay within the DB's
      // max_connections.  2 workflows × 2 workers × 5 connections = 20 total.
      DB_POOL_MAX: "5",
    },
    // Cap parallel forks so the shared PG connection pool is not exhausted when
    // many integration test files run simultaneously.  Each fork imports app.js
    // and creates its own connection pool (pg default max = 10).  Two concurrent
    // test workflows each running 2 workers = 4 × 10 = 40 connections, well
    // within max_connections.  Four workers per workflow (the old cap) caused
    // 80 concurrent connections when two workflows fired at merge time, which
    // exhausted the pool and caused beforeAll hooks to time out at 30 s.
    //
    // NOTE: Vitest 4 removed `test.poolOptions` (the old
    // `poolOptions.forks.maxForks` is silently ignored). The cap is now the
    // top-level `maxWorkers`; without this the suite runs with uncapped
    // parallelism, which is what made this protected regression gate flaky.
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
    // Allow slow beforeAll/afterAll hooks (DB imports, heavy setup) more time.
    // 90 s gives the PG pool enough headroom to recover when two concurrent
    // workflows (api-server-tests + regression-tests) both hit the DB at
    // merge time.  At maxWorkers=2 per workflow the worst-case concurrent
    // connections are 2 × 2 × 5 = 20 (see DB_POOL_MAX below), well within
    // max_connections, but connection setup still takes longer under contention.
    hookTimeout: 90000,
  },
});
