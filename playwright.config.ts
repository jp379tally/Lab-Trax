import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const chromiumExecutablePath =
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] ??
  (process.env["REPL_ID"]
    ? execFileSync("which", ["chromium"], { encoding: "utf8" }).trim()
    : undefined);

const stripeReleaseValidation =
  process.env["PLAYWRIGHT_STRIPE_RELEASE_VALIDATION"] === "1";

export default defineConfig({
  testDir: "e2e",
  // The Stripe authentication check can create real test-mode payment
  // intents, so it must never be collected by the ordinary browser suite.
  // The release workflow opts in only after its secret/configuration
  // preflight succeeds.
  testIgnore: stripeReleaseValidation
    ? []
    : ["**/stripe-receive-payments-live.spec.ts"],
  timeout: 30_000,
  outputDir: "test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80",
    launchOptions: chromiumExecutablePath
      ? { executablePath: chromiumExecutablePath }
      : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
