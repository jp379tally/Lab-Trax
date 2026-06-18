#!/usr/bin/env tsx
/**
 * Session-refresh beforeEach guard.
 *
 * Scans every `.test.ts` file under `artifacts/api-server/src/routes/` and
 * flags any file that calls `makeSession()` inside a `beforeAll` block but
 * has no `beforeEach` block that also calls `makeSession()`.
 *
 * WHY THIS MATTERS
 * ─────────────────
 * When a backup-restore TRUNCATE fires on `user_sessions` between the
 * `beforeAll` that minted a token and the test that uses it, the token is
 * silently invalid.  The fix is a `beforeEach` block that re-mints the token
 * before every test, ensuring the session row always exists when the `it()`
 * body runs.
 *
 * DETECTION STRATEGY
 * ──────────────────
 * Rather than rely on indentation heuristics, the guard uses a lightweight
 * brace-counting pass to determine which function block a `makeSession` call
 * lives in:
 *
 *   1. Walk line-by-line, tracking `{` / `}` depth.
 *   2. When a `beforeAll(` opener is detected, record the current depth and
 *      set a flag.
 *   3. Any `makeSession(` assignment found while that flag is active is a
 *      "makeSession-in-beforeAll" hit.
 *   4. Repeat the same walk for `beforeEach(` to see if makeSession is
 *      *also* called there.
 *   5. If makeSession appears in beforeAll but NOT in beforeEach → violation.
 *
 * ESCAPE HATCH
 * ────────────
 * Add `// session-guard:allow` anywhere on the beforeAll line or the
 * makeSession line to suppress the violation for a known-good exception.
 *
 * WIRE INTO CI
 * ────────────
 *   pnpm --filter @workspace/scripts run guard-session-beforeeach
 *
 * Exits non-zero when violations are found.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ROUTES_DIR = path.resolve(
  REPO_ROOT,
  "artifacts",
  "api-server",
  "src",
  "routes"
);

const ESCAPE_HATCH = "// session-guard:allow";

interface Violation {
  file: string;
  reason: string;
}

/**
 * Count brace depth changes on a single source line.
 * Skips braces inside single-line strings and template literals
 * (best-effort — sufficient for the patterns found in these test files).
 */
function braceCount(line: string): number {
  let opens = 0;
  let closes = 0;
  let inString: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1] ?? "";

    if (inString) {
      if (ch === "\\" && inString !== "`") {
        i++; // skip escaped char
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") break; // line comment

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "{") opens++;
    else if (ch === "}") closes++;
  }

  return opens - closes;
}

type BlockKind = "beforeAll" | "beforeEach" | "afterAll" | "afterEach" | "it" | "other";

/**
 * Returns the name of a lifecycle/test block if this line opens one,
 * otherwise null.
 */
function openedBlock(line: string): BlockKind | null {
  if (/\bbeforeAll\s*\(/.test(line)) return "beforeAll";
  if (/\bbeforeEach\s*\(/.test(line)) return "beforeEach";
  if (/\bafterAll\s*\(/.test(line)) return "afterAll";
  if (/\bafterEach\s*\(/.test(line)) return "afterEach";
  if (/\bit\s*\(/.test(line) || /\bit\.(?:only|skip)\s*\(/.test(line)) return "it";
  return null;
}

interface BlockScan {
  /** Lines (1-indexed) where makeSession is called with an assignment. */
  makeSessionAssignLines: number[];
  /** Lines (1-indexed) where makeSession is called (any usage). */
  makeSessionCallLines: number[];
}

/**
 * Walk the file and collect the set of line numbers where makeSession is
 * called inside each block kind, using brace-depth tracking to identify
 * the enclosing block.
 */
function scanBlocks(lines: string[]): Record<BlockKind, BlockScan> {
  const result: Record<BlockKind, BlockScan> = {
    beforeAll: { makeSessionAssignLines: [], makeSessionCallLines: [] },
    beforeEach: { makeSessionAssignLines: [], makeSessionCallLines: [] },
    afterAll: { makeSessionAssignLines: [], makeSessionCallLines: [] },
    afterEach: { makeSessionAssignLines: [], makeSessionCallLines: [] },
    it: { makeSessionAssignLines: [], makeSessionCallLines: [] },
    other: { makeSessionAssignLines: [], makeSessionCallLines: [] },
  };

  // Stack of { kind, entryDepth } to handle nested blocks correctly.
  const stack: Array<{ kind: BlockKind; entryDepth: number }> = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.includes(ESCAPE_HATCH)) {
      depth += braceCount(line);
      continue;
    }

    // Detect block opener BEFORE counting braces so the depth recorded is
    // the depth OUTSIDE the opening `{`.
    const kind = openedBlock(line);
    if (kind !== null) {
      stack.push({ kind, entryDepth: depth });
    }

    depth += braceCount(line);

    // Pop completed blocks.
    while (stack.length > 0 && depth <= stack[stack.length - 1].entryDepth) {
      stack.pop();
    }

    // Record makeSession usage.
    if (/\bmakeSession\s*\(/.test(line)) {
      const currentKind: BlockKind = stack.length > 0
        ? stack[stack.length - 1].kind
        : "other";
      const scan = result[currentKind];
      scan.makeSessionCallLines.push(lineNo);
      if (/=\s*(?:await\s+)?makeSession/.test(line) || /=\s*\(await\s+makeSession/.test(line)) {
        scan.makeSessionAssignLines.push(lineNo);
      }
    }
  }

  return result;
}

function scan(file: string): Violation | null {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  const blocks = scanBlocks(lines);

  // A file is only vulnerable if makeSession is assigned inside beforeAll
  // (i.e., a shared token is minted once for all tests).
  const madeInBeforeAll = blocks.beforeAll.makeSessionAssignLines.length > 0;
  if (!madeInBeforeAll) return null;

  // Protected if beforeEach also calls makeSession (refreshes the token).
  const refreshedInBeforeEach = blocks.beforeEach.makeSessionCallLines.length > 0;
  if (refreshedInBeforeEach) return null;

  return {
    file,
    reason:
      `makeSession() is assigned inside beforeAll (line(s) ${blocks.beforeAll.makeSessionAssignLines.join(", ")}) ` +
      `but no beforeEach block refreshes it. ` +
      `Add a beforeEach that calls makeSession() for each shared token variable so every test ` +
      `starts with a valid session even after a backup-restore TRUNCATE on user_sessions. ` +
      `Use \`// session-guard:allow\` on the makeSession line to suppress a known-good exception.`,
  };
}

function main() {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`Routes dir not found: ${ROUTES_DIR}`);
    process.exit(2);
  }

  const testFiles = fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(ROUTES_DIR, f));

  const violations: Violation[] = [];
  for (const file of testFiles) {
    const v = scan(file);
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    console.log(
      `[guard-session-beforeeach] OK — all beforeAll session tokens are covered by beforeEach in ${testFiles.length} test file(s).`
    );
    process.exit(0);
  }

  console.error(
    `[guard-session-beforeeach] FAIL — ${violations.length} file(s) with unrefreshed beforeAll tokens:`
  );
  for (const v of violations) {
    const rel = path.relative(REPO_ROOT, v.file);
    console.error(`\n  ${rel}`);
    console.error(`    → ${v.reason}`);
  }
  console.error(
    "\nFix: add a beforeEach block that calls makeSession() for the primary user " +
    "and re-assigns each shared token variable."
  );
  process.exit(1);
}

main();
