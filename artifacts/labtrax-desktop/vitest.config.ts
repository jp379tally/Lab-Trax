import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "electron/__tests__/**/*.test.{js,cjs,mjs,ts}",
      "src/**/__tests__/**/*.test.{ts,tsx}",
    ],
  },
});
