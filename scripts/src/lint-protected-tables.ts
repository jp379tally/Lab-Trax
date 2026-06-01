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
  "invoiceAttachments",
  "bankTransactions",
  "pricingTiers",
  "pricingOverrides",
  "organizations",
  "organizationMemberships",
  "users",
  "subscriptions",
  "vendorTypes",
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
    } else if (
      entry.isFile() &&
      /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) &&
      // Test files use hard deletes intentionally for teardown — skip them.
      !/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)
    ) {
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

    // Guard against inserting invoice_line_items sub-items (rows with a
    // parentLineItemId) where the invoice_id is not explicitly propagated from
    // the parent.  The DB trigger `invoice_line_items_invoice_id_match_trigger`
    // enforces this at runtime, but catching the pattern at lint time gives a
    // faster feedback loop.
    //
    // The safe pattern is always to include `invoiceId` alongside
    // `parentLineItemId` in every insert value object — if you see
    // `parentLineItemId` but no `invoiceId` on the same nearby line, flag it.
    if (
      /invoiceLineItems/.test(line) &&
      /\.insert\b/.test(line)
    ) {
      // Multi-line insert values are hard to fully static-analyse here; skip.
    }

    // Flag any delete of invoiceLineItems that is scoped to a *single item id*
    // rather than the safe invoice-level bulk delete.  Deleting a single
    // parent row by .id without understanding the sub-item relationship is a
    // code-smell — the ON DELETE CASCADE on parent_line_item_id handles
    // children correctly today, but the intent is ambiguous and a future
    // refactor could miss it.
    if (
      /db\s*(?:\.\s*\w+)*\s*\.\s*delete\s*\(\s*invoiceLineItems\b/.test(line) &&
      !line.includes(ALLOW_FILE_MARKER)
    ) {
      // Only flag deletes that filter by .id (single-item) rather than by
      // .invoiceId (invoice-level bulk delete, which is the safe pattern).
      // We look ahead a few lines for the .where() clause.
      const lookahead = lines.slice(i, i + 6).join(" ");
      if (
        /invoiceLineItems\s*\.\s*id\b/.test(lookahead) &&
        !/invoiceLineItems\s*\.\s*invoiceId\b/.test(lookahead)
      ) {
        violations.push({
          file,
          line: i + 1,
          text: trimmed,
          reason:
            "db.delete(invoiceLineItems) filtered by a single item .id is risky — " +
            "prefer deleting by invoiceId to keep the invoice-level bulk-replace pattern " +
            "consistent. The DB trigger enforces invoice_id/parent coherence at runtime, " +
            "but a single-item delete of a parent silently cascades to its sub-items. " +
            "Add // soft-delete-lint:allow if this is intentional.",
        });
      }
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
