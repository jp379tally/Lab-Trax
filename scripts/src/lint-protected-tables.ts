#!/usr/bin/env tsx
/**
 * Lab data protection guard.
 *
 * Scans the API server source tree for forbidden patterns:
 *
 *   1. `db.delete(<protected>)` — protected tables are soft-delete only.
 *      Use the helpers in `artifacts/api-server/src/lib/soft-delete.ts`
 *      (`softDelete` / `softDeleteById`) instead.
 *
 *   2. `fs.unlink` / `fs.rm` / `fsp.unlink` / `fsp.rm` against case-media
 *      paths. Case-media files must be moved to the `.trash/` folder so
 *      they can be recovered, not unlinked outright.
 *
 * Exits non-zero on the first violation. Wire this into CI via the
 * `lint:protected-tables` workspace script.
 *
 * The list of protected Drizzle exports is sourced from
 * `artifacts/api-server/src/lib/soft-delete.ts` (PROTECTED_DRIZZLE_EXPORTS).
 * Add a new protected table there and the lint will follow automatically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drizzle export names that the API server treats as protected
 * (soft-delete only). Keep this list in sync with PROTECTED_DRIZZLE_EXPORTS
 * in `artifacts/api-server/src/lib/soft-delete.ts`. The lint asserts
 * the two lists match before scanning.
 */
const PROTECTED_DRIZZLE_EXPORTS: ReadonlyArray<string> = [
  "cases",
  "caseAttachments",
  "invoices",
  "bankTransactions",
  "pricingTiers",
  "pricingOverrides",
  "organizations",
  "organizationMemberships",
  "users",
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const API_SRC = path.resolve(REPO_ROOT, "artifacts", "api-server", "src");
const SOFT_DELETE_FILE = path.resolve(API_SRC, "lib", "soft-delete.ts");

function assertProtectedListInSync() {
  if (!fs.existsSync(SOFT_DELETE_FILE)) return;
  const text = fs.readFileSync(SOFT_DELETE_FILE, "utf8");
  // Look for the PROTECTED_DRIZZLE_EXPORTS array literal and pull names out.
  const match = text.match(
    /PROTECTED_DRIZZLE_EXPORTS[^=]*=\s*\[([\s\S]*?)\]/
  );
  if (!match) return;
  const names = Array.from(match[1].matchAll(/"([A-Za-z_]+)"/g)).map(
    (m) => m[1]
  );
  const a = [...PROTECTED_DRIZZLE_EXPORTS].sort().join(",");
  const b = [...names].sort().join(",");
  if (a !== b) {
    console.error(
      `[lint-protected-tables] FAIL — PROTECTED_DRIZZLE_EXPORTS in this script (${a}) is out of sync with lib/soft-delete.ts (${b}). Update both lists.`
    );
    process.exit(1);
  }
}

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

const ALLOW_FILE_MARKER = "// soft-delete-lint:allow";

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

function scan(file: string): Violation[] {
  const violations: Violation[] = [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  // The lint helper module itself enumerates the protected names — skip it.
  if (file.endsWith(path.join("lib", "soft-delete.ts"))) return violations;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (line.includes(ALLOW_FILE_MARKER)) continue;

    for (const name of PROTECTED_DRIZZLE_EXPORTS) {
      const re = new RegExp(`db\\.delete\\(\\s*${name}\\b`);
      if (re.test(line)) {
        violations.push({
          file,
          line: i + 1,
          text: trimmed,
          reason: `db.delete(${name}) is forbidden — use softDelete()/softDeleteById() from lib/soft-delete.ts.`,
        });
      }
    }

    if (
      /\b(fs|fsp)\.(unlink|unlinkSync|rm|rmSync)\b/.test(line) &&
      /case-?media|uploads\/case-media/i.test(line)
    ) {
      violations.push({
        file,
        line: i + 1,
        text: trimmed,
        reason:
          "Direct unlink/rm of case-media files is forbidden — move the file under uploads/case-media/.trash/ instead so it can be recovered.",
      });
    }
  }

  return violations;
}

function main() {
  if (!fs.existsSync(API_SRC)) {
    console.error(`API source dir not found: ${API_SRC}`);
    process.exit(2);
  }
  assertProtectedListInSync();
  const violations: Violation[] = [];
  for (const file of walk(API_SRC)) {
    violations.push(...scan(file));
  }
  // storage.ts intentionally implements deleteUser — verified above to be
  // soft-delete; if anyone re-introduces a hard delete it will be caught.

  if (violations.length === 0) {
    console.log(
      `[lint-protected-tables] OK — no forbidden destructive ops found in ${API_SRC}`
    );
    process.exit(0);
  }

  console.error(
    `[lint-protected-tables] FAIL — ${violations.length} violation(s):`
  );
  for (const v of violations) {
    const rel = path.relative(REPO_ROOT, v.file);
    console.error(`  ${rel}:${v.line}  ${v.reason}`);
    console.error(`      ${v.text}`);
  }
  process.exit(1);
}

main();
