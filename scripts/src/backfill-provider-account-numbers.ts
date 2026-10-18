/**
 * Maintenance entry point for the canonical API-server backfill.
 * Keep this thin: the API implementation owns parent-lab generators, locks,
 * dry-run reservations, and conditional updates.
 */
import path from "node:path";

const workspaceRoot = process.cwd().endsWith(`${path.sep}scripts`)
  ? path.resolve(process.cwd(), "..")
  : process.cwd();
const apiModule = path.resolve(
  workspaceRoot,
  "artifacts/api-server/src/lib/provider-account-number-backfill.ts",
);
const { backfillProviderAccountNumbers } = await import(apiModule);
const result = await backfillProviderAccountNumbers({
  dryRun: !process.argv.includes("--apply"),
});
console.log(JSON.stringify(result, null, 2));