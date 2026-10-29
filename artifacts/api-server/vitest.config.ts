import { defineConfig } from "vitest/config";

if (
  process.env.API_TEST_REQUIRE_DATABASE === "1" &&
  !process.env.DATABASE_URL
) {
  throw new Error(
    "API_TEST_REQUIRE_DATABASE=1 requires DATABASE_URL; refusing to silently skip database integration suites.",
  );
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The backup/restore integrity suites perform DB-WIDE destructive
    // pg_restore runs. Inside the full suite (maxWorkers=2) they run
    // concurrently with sibling DB-integration files, so the restore truncates
    // tables out from under siblings (intermittent 500s, e.g. case-create FK
    // failures) and the siblings' writes skew the restore's post-restore count
    // validation — the cross-workflow with-db-lock wrapper cannot help inside
    // one vitest run. These two files therefore run ONLY via their dedicated
    // blocking gate (the rel-backup-restore workflow / Pre-Release Checklist
    // step 6), which invokes them explicitly and IS wrapped in with-db-lock.
    // See REGRESSION_GUARDRAILS.md → "DB Serialization Rule (with-db-lock)".
    exclude: [
      "src/lib/postgres-record-delta-postgres.test.ts",
      "src/lib/database-protection-postgres.test.ts",
      "src/lib/record-change-capture-feasibility-postgres.test.ts",
      // These guarded suites are mandatory in vitest.restore.config.ts and
      // must never be loaded against the ordinary API runner's shared DB.
      "src/lib/database-protection-catchup-postgres.test.ts",
      "src/lib/production-media-mutation-postgres.test.ts",
      "**/node_modules/**",
      "src/routes/organization-audit-recovery-rehearsal.test.ts",
      // Real DB-wide recovery is mandatory in the ordered isolated restore
      // gate, not the ordinary API fixture database populated by other files.
      "src/routes/offsite-job.test.ts",
      "src/routes/backup-restore.test.ts",
      "src/routes/backup-now-synthetic.test.ts",
      "src/routes/case-organization-repair.test.ts",
      "src/routes/restore-session.test.ts",
      // OneDrive and Google Drive restore suites restore real archives into the
      // configured DATABASE_URL, so run them only in the isolated restore gate.
      "src/routes/onedrive-restore-integrity.test.ts",
      "src/routes/onedrive-offsite-restore.test.ts",
      "src/routes/google-drive-offsite-restore.test.ts",
    ],
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
      // Cap the pg connection pool for the serialized DB integration gate.
      DB_POOL_MAX: "5",
      // Raise the PG connect timeout under test. When the Run-button aggregate
      // fires every rel-* workflow simultaneously, CPU contention can push the
      // TLS connect handshake past the production 10 s fail-fast, causing
      // false "Connection terminated due to connection timeout" failures in
      // suites that pass cleanly alone (see lib/db pool config).
      DB_CONNECT_TIMEOUT_MS: "60000",
    },
    // Integration files share one development database and perform destructive
    // fixture teardown. Running two files at once can remove rows while a sibling
    // file is asserting invoice rebuild behavior, even when every file passes in
    // isolation. Serialize files so a green release gate is reproducible.
    //
    // NOTE: Vitest 4 removed `test.poolOptions` (the old
    // `poolOptions.forks.maxForks` is silently ignored). The cap is now the
    // top-level `maxWorkers`; without this the suite runs with uncapped
    // parallelism, which is what made this protected regression gate flaky.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // Allow slow beforeAll/afterAll hooks (DB imports, heavy setup) more time.
    // Allow slow tests (orphan-cleanup scan, heavy DB queries) the same budget.
    // 90 s leaves headroom for heavy DB setup and teardown on the shared service.
    hookTimeout: 90000,
    testTimeout: 90000,
  },
});
