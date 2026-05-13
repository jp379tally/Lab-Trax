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
  },
});
