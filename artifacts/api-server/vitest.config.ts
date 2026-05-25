import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
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
