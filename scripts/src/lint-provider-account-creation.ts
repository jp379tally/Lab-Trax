#!/usr/bin/env tsx
/**
 * Provider-account creation guard.
 *
 * Provider users must be inserted through the sanctioned gate in
 * `lib/provider-account.ts`, which allocates an account number and records
 * creation provenance. The demo seed is the only intentional exception.
 *
 * Exits non-zero when a production API source file inserts into `users`
 * without being one of those explicitly allowed paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const API_SRC = path.resolve(REPO_ROOT, "artifacts", "api-server", "src");

const CANONICAL_GATE = "artifacts/api-server/src/lib/provider-account.ts";
const DEMO_SEEDER = "artifacts/api-server/src/routes/labtrax-routes.ts";

/** Add only to the exact demo-seeder insert line when a deliberate exception is needed. */
export const PROVIDER_ACCOUNT_ALLOW_MARKER = "provider-account-lint:allow";

export interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

function normalizedPath(file: string): string {
  return file.replaceAll("\\", "/");
}

function isExplicitlyAllowed(file: string, line: string): boolean {
  const normalized = normalizedPath(file);
  if (normalized.endsWith(CANONICAL_GATE)) return true;
  return (
    normalized.endsWith(DEMO_SEEDER) &&
    line.includes(PROVIDER_ACCOUNT_ALLOW_MARKER)
  );
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

/**
 * Scan one source file. Exported so the allow-list and its failure behavior
 * stay covered without executing the whole repository scan in unit tests.
 */
export function scanContent(content: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    // Keep the check intentionally syntax-light, like the protected-table
    // lint. A multiline Drizzle call is joined only for matching; the
    // violation is still reported on the line where `.insert(` starts.
    const window = lines.slice(i, i + 5).join(" ");
    const insertsUsers =
      (/\.\s*insert\s*\(\s*users\b/.test(window) &&
        /\.\s*insert\b/.test(line)) ||
      /\binsert\s+into\s+["`]?users\b/i.test(line);
    if (!insertsUsers) continue;

    if (isExplicitlyAllowed(file, line)) continue;

    violations.push({
      file,
      line: i + 1,
      text: trimmed,
      reason:
        "Provider-account users inserts must go through " +
        "lib/provider-account.ts. The only other allowed insert is the " +
        "intentional demo seed, marked on its insert line.",
    });
  }

  return violations;
}

function main(): void {
  if (!fs.existsSync(API_SRC)) {
    console.error(`API source dir not found: ${API_SRC}`);
    process.exit(2);
  }

  const violations: Violation[] = [];
  for (const file of walk(API_SRC)) {
    violations.push(...scanContent(fs.readFileSync(file, "utf8"), file));
  }

  if (violations.length === 0) {
    console.log(
      `[lint-provider-account-creation] OK — no unsanctioned users inserts found in ${API_SRC}`
    );
    return;
  }

  console.error(
    `[lint-provider-account-creation] FAIL — ${violations.length} violation(s):`
  );
  for (const violation of violations) {
    const relative = path.relative(REPO_ROOT, violation.file);
    console.error(
      `  ${relative}:${violation.line}  ${violation.reason}\n      ${violation.text}`
    );
  }
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}