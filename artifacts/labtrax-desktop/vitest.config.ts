import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
  },
  test: {
    globals: true,
    include: [
      "electron/__tests__/**/*.test.{js,cjs,mjs,ts}",
      "src/**/__tests__/**/*.test.{ts,tsx}",
    ],
    // Default to node so the electron main-process tests (which mock OS APIs
    // themselves) keep working. Renderer/React tests opt into jsdom via a
    // `/** @vitest-environment jsdom */` docblock at the top of each file.
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    // Cap parallel forks to avoid OOM worker crashes when desktop-full-test
    // fires alongside api-server-tests and regression-tests at merge time.
    // Each jsdom fork (React renderer tests) is heavy (~150–200 MB).  Two
    // concurrent workers keep peak RSS well within the container limit while
    // still running most of the suite in parallel.  Worker startup failures
    // ("Timeout waiting for worker to respond") disappear once fork count is
    // bounded.
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
  },
});
