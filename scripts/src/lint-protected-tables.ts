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
 *   3. (Test files only) `user_sessions` inserts whose tokenHash /
 *      token_hash derives from a hardcoded string literal. Aborted test
 *      runs leave those rows in the persistent dev database, and every
 *      later run then fails with a 23505 duplicate-key error on
 *      user_sessions_token_hash_unique. Token hashes in tests must derive
 *      from a per-run-random value (e.g. a `rid()` id or a freshly signed
 *      token), never from a fixed literal.
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
  "aiMemory",
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

export interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

const ALLOW_FILE_MARKER = "// soft-delete-lint:allow";

/**
 * Per-line escape hatch for the fixed-session-token check. Only use when a
 * test intentionally needs a deterministic token hash (e.g. asserting
 * cleanup of a known legacy value) AND the row can never persist past the
 * run (in-memory/mocked DB, or a DELETE — not an INSERT).
 */
export const SESSION_TOKEN_ALLOW_MARKER = "session-token-lint:allow";

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) &&
      // Test files use hard deletes intentionally for teardown — skip them
      // here; they get their own fixed-session-token scan instead.
      !TEST_FILE_RE.test(entry.name)
    ) {
      yield full;
    }
  }
}

function* walkTestFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTestFiles(full);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * A string literal argument: "..." or '...' or a template literal with NO
 * interpolation (`...` without ${). Interpolated templates are treated as
 * dynamic and allowed.
 */
const LITERAL_UPDATE_RE =
  /\.\s*update\s*\(\s*(?:"[^"]*"|'[^']*'|`(?:(?!\$\{)[^`])*`)\s*[,)]/;

const LITERAL_TOKEN_HASH_VALUE_RE =
  /\b(?:tokenHash|token_hash)\s*:\s*(?:"[^"]*"|'[^']*'|`(?:(?!\$\{)[^`])*`)/;

const FIXED_TOKEN_REASON =
  "Hardcoded session token in a test: user_sessions.token_hash has a UNIQUE " +
  "index, and rows left behind by an aborted run persist in the dev database " +
  "— every later run then 23505-collides on user_sessions_token_hash_unique. " +
  "Derive the token hash from a per-run-random value instead (e.g. hash a " +
  "rid() id or a freshly signed token), never a string literal. " +
  `If truly intentional, add // ${SESSION_TOKEN_ALLOW_MARKER}.`;

/**
 * Scan a test file's content for user_sessions inserts whose token hash is
 * derived from a fixed string literal. Exported for unit tests.
 */
export function scanTestContentForFixedSessionTokens(
  content: string,
  file: string
): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    )
      continue;
    if (line.includes(SESSION_TOKEN_ALLOW_MARKER)) continue;

    // Case 1: a tokenHash / token_hash object key whose value derives from a
    // literal — either directly (`tokenHash: "abc"`) or via a hash of a
    // literal (`tokenHash: createHash("sha256").update("tok-11-a")...`).
    // The value expression may wrap onto the next few lines.
    if (/\b(?:tokenHash|token_hash)\s*:/.test(line)) {
      const window = lines.slice(i, i + 4).join(" ");
      if (
        LITERAL_TOKEN_HASH_VALUE_RE.test(window) ||
        LITERAL_UPDATE_RE.test(window)
      ) {
        violations.push({
          file,
          line: i + 1,
          text: trimmed,
          reason: FIXED_TOKEN_REASON,
        });
        continue;
      }
    }

    // Case 2: raw SQL INSERT INTO user_sessions where a nearby parameter is
    // a hash of a string literal. Only INSERTs are dangerous — cleanup
    // DELETEs of known legacy hashes are fine.
    if (/insert\s+into\s+user_sessions/i.test(line)) {
      const window = lines.slice(i, i + 8);
      for (let j = 0; j < window.length; j++) {
        if (window[j].includes(SESSION_TOKEN_ALLOW_MARKER)) continue;
        if (LITERAL_UPDATE_RE.test(window[j])) {
          violations.push({
            file,
            line: i + 1 + j,
            text: window[j].trim(),
            reason: FIXED_TOKEN_REASON,
          });
        }
      }
    }
  }

  return violations;
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
  for (const file of walkTestFiles(API_SRC)) {
    violations.push(
      ...scanTestContentForFixedSessionTokens(
        fs.readFileSync(file, "utf8"),
        file
      )
    );
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

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
