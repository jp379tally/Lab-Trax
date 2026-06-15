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
    },
    // Cap parallel forks so the shared PG connection pool is not exhausted when
    // many integration test files run simultaneously.  Each fork imports app.js
    // and creates its own connection(s); 4 concurrent forks keeps total
    // connections well within the default pool size.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    // Allow slow beforeAll/afterAll hooks (DB imports, heavy setup) more time.
    hookTimeout: 30000,
  },
});
