import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // CLI suites spawn additional Node/tsx processes. Unbounded Vitest forks
    // starve the concurrent mobile/browser/API release gates and make healthy
    // subprocess checks time out. Serialize without reducing test coverage.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
