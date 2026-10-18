#!/usr/bin/env tsx
/**
 * Maintenance-sweep scope guard.
 *
 * A maintenance job here chooses its own work set out of the whole table —
 * "every row that still matches X". That is exactly what production wants,
 * and it is dangerous in a test: the development database is shared between
 * sibling suites and holds real restored lab data, so a live sweep started by
 * a test reaches rows the test never created. It has already happened once —
 * a legacy-media migration run from a test rewrote real case blobs to point at
 * files that existed only in that test's in-memory writer, and the test still
 * passed.
 *
 * So every sweep in `GUARDED_SWEEPS` takes an id scope, and this guard fails
 * any TEST file that reaches one without passing it. Production callers are
 * never scanned: an unscoped sweep is the whole point of the job.
 *
 * A sweep is reached either as a function call
 * (`runLegacyCaseMediaMigration({ caseIds })`) or as an HTTP request to the
 * admin route that runs it (`.post("/api/admin/maintenance/legacy-case-media")`
 * … `.send({ caseIds })`); both forms are checked, and the scope has to appear
 * in the arguments of that same call.
 *
 * ADDING A SWEEP: append an entry to `GUARDED_SWEEPS` naming how a test
 * reaches it, the option that narrows it, and the file it lives in. The
 * registry is re-checked against those sources on every run — a renamed
 * option, a moved route, or a deleted sweep fails here instead of rotting.
 *
 * ESCAPE HATCH: a test that deliberately calls a sweep unscoped — asserting
 * the route rejects a missing scope, for instance — puts
 * `// sweep-scope-lint:allow <why it cannot touch a foreign row>` on the call.
 * The reason is required.
 *
 * Wire this into CI:
 *   pnpm --filter @workspace/scripts run lint-maintenance-sweep-scope
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The API router is mounted here, so a test requests `/api/x` for route `/x`. */
const API_MOUNT_PREFIX = "/api";

/** Per-call escape hatch. Must be followed by the reason it is safe. */
export const ALLOW_MARKER = "sweep-scope-lint:allow";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** How a test can set a sweep running. */
export type SweepReach =
  /** A direct call, under any local alias of the module (`lib.run…()`). */
  | { kind: "call"; call: string }
  /** An admin route that runs the sweep; `path` is the URL a test requests. */
  | { kind: "endpoint"; method: HttpMethod; path: string };

export interface GuardedSweep {
  /** Stable id used in messages and tests. */
  id: string;
  reach: SweepReach;
  /**
   * The option (function argument key, or request body field) that narrows the
   * run to rows the caller owns. Named per entry because it differs: the media
   * migration takes `caseIds`, the SDR1 cleanup takes `organizationId`.
   */
  scopeOption: string;
  /** Repo-relative file the sweep lives in. Re-checked on every run. */
  source: string;
  /** What an unscoped run reaches — quoted back in the failure message. */
  sweeps: string;
}

/**
 * The sweeps a test may not run unscoped.
 *
 * Every entry is verified against its own source before any file is scanned,
 * so this list cannot drift away from the code it describes.
 */
export const GUARDED_SWEEPS: ReadonlyArray<GuardedSweep> = [
  {
    id: "legacy-case-media-migration",
    reach: { kind: "call", call: "runLegacyCaseMediaMigration" },
    scopeOption: "caseIds",
    source: "artifacts/api-server/src/lib/legacy-case-media-externalize.ts",
    sweeps:
      "every lab_cases row whose blob still holds base64 media, rewriting each " +
      "one to reference files the writer produced",
  },
  {
    id: "legacy-case-media-migration-endpoint",
    reach: {
      kind: "endpoint",
      method: "post",
      path: "/api/admin/maintenance/legacy-case-media",
    },
    scopeOption: "caseIds",
    source: "artifacts/api-server/src/routes/labtrax-routes.ts",
    sweeps:
      "every lab_cases row whose blob still holds base64 media (the admin route " +
      "for the same migration)",
  },
  {
    id: "sdr1-legacy-open-invoice-cleanup",
    reach: {
      kind: "endpoint",
      method: "post",
      path: "/api/admin/cleanup/sdr1-legacy-open-invoices",
    },
    scopeOption: "organizationId",
    source: "artifacts/api-server/src/routes/labtrax-routes.ts",
    sweeps:
      "every active lab_cases row in the organization whose patient name matches " +
      "the target list, soft-deleting the matches and their linked canonical rows",
  },
];

/**
 * Where test files are looked for. A sweep is only reachable from a suite that
 * can talk to the database or the app, which is these packages.
 */
export const SCAN_ROOTS: ReadonlyArray<string> = [
  "artifacts/api-server/src",
  "artifacts/api-server/test-plans",
  "scripts/src",
];

const SKIPPED_DIRS: ReadonlyArray<string> = ["node_modules", "dist", "build", "uploads"];

/**
 * This guard's own suite writes the very call shapes it flags, as fixture
 * strings, so it has to be skipped — the same way the protected-table lint
 * skips the module that enumerates the protected names.
 */
const SELF_TEST_FILE = "lint-maintenance-sweep-scope.test.ts";

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;

export interface Violation {
  /** Repo-relative when the scan walked the repo; as given when scanning text. */
  file: string;
  line: number;
  text: string;
  /** Which guarded sweep this call reaches. */
  sweepId: string;
  reason: string;
}

// ── Source reading ─────────────────────────────────────────────────────────

/** Human name for a sweep, as it appears in a failure message. */
export function describeReach(sweep: GuardedSweep): string {
  return sweep.reach.kind === "call"
    ? `${sweep.reach.call}()`
    : `${sweep.reach.method.toUpperCase()} ${sweep.reach.path}`;
}

function lineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineNumberAt(starts: ReadonlyArray<number>, index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** A line that is only a comment cannot call anything. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Read forward from `start`, tracking strings and nesting, and return the text
 * the scope has to appear in.
 *
 * `call-arguments` starts at a call's `(` and ends at its matching `)` — the
 * scope is one of the arguments. `statement` starts at a request URL and ends
 * at the end of the statement, because the scope arrives further along the
 * chain (`.send({...})`) or in a later argument (`fetch(url, {...})`).
 */
function readExpression(
  content: string,
  start: number,
  mode: "call-arguments" | "statement",
): string {
  const LIMIT = 8000;
  const end = Math.min(content.length, start + LIMIT);
  let depth = 0;
  let quote: string | null = null;
  let i = start;

  for (; i < end; i++) {
    const ch = content[i]!;
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      // The call's own `(` opened at `start`, so its `)` brings depth to 0.
      if (mode === "call-arguments" && depth === 0) return content.slice(start + 1, i);
      continue;
    }
    if (ch === ";" && mode === "statement" && depth <= 0) return content.slice(start, i);
  }
  return content.slice(start, end);
}

// ── Scope detection ────────────────────────────────────────────────────────

const NOT_A_SCOPE_RE = /^(?:undefined|null)\b/;

export type ScopeCheck =
  | { present: true }
  | { present: false; kind: "missing" | "empty"; detail?: string };

/**
 * Is the scope option handed to this call? An object key (`caseIds: [id]`) or
 * the shorthand (`{ ...options, caseIds }`) both count; an explicitly absent
 * value (`caseIds: undefined`) does not, because it scopes nothing.
 */
export function findScopeOption(expression: string, option: string): ScopeCheck {
  const re = new RegExp(`(^|[^\\w$.])${option}\\s*(:|,|\\}|$)`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(expression)) !== null) {
    if (match[2] !== ":") return { present: true };
    const value = expression.slice(match.index + match[0].length).trimStart();
    if (!NOT_A_SCOPE_RE.test(value)) return { present: true };
    return {
      present: false,
      kind: "empty",
      detail: `${option} is passed as ${value.split(/[\s,}]/)[0]}, which scopes nothing`,
    };
  }
  return { present: false, kind: "missing" };
}

// ── Escape hatch ───────────────────────────────────────────────────────────

interface AllowDecision {
  allowed: boolean;
  /** Set when the marker is present but carries no reason. */
  problem?: string;
}

/**
 * Was this call deliberately exempted? The marker may sit anywhere in the
 * expression the guard read (the call line, or a line of the request chain).
 */
function allowMarkerFor(lines: ReadonlyArray<string>): AllowDecision | null {
  for (const line of lines) {
    const at = line.indexOf(ALLOW_MARKER);
    if (at === -1) continue;
    const reason = line
      .slice(at + ALLOW_MARKER.length)
      .replace(/^[\s:—-]+/, "")
      .trim();
    if (!reason) {
      return {
        allowed: false,
        problem:
          `\`${ALLOW_MARKER}\` with no reason. Say why this call cannot touch a ` +
          `row the test does not own (e.g. "the route rejects it before any query").`,
      };
    }
    return { allowed: true };
  }
  return null;
}

// ── Scanning ───────────────────────────────────────────────────────────────

function reasonFor(sweep: GuardedSweep, check: ScopeCheck): string {
  const what = describeReach(sweep);
  const detail =
    check.present === false && check.kind === "empty" && check.detail
      ? `${check.detail}. `
      : "";
  return (
    `${what} run from a test without \`${sweep.scopeOption}\`. ${detail}` +
    `Unscoped it sweeps ${sweep.sweeps} — and the development database is shared ` +
    `with sibling suites and holds real restored lab data, so the run reaches rows ` +
    `this test never created and the test still passes. Pass ` +
    `\`${sweep.scopeOption}\` with the ids this file created, ideally through one ` +
    `local helper that also asserts the report names no other row. If the call is ` +
    `deliberately unscoped, add \`// ${ALLOW_MARKER} <reason>\`.`
  );
}

/** Every call site of one guarded sweep in this content, scoped or not. */
function callSites(
  content: string,
  sweep: GuardedSweep,
): Array<{ index: number; expression: string }> {
  const sites: Array<{ index: number; expression: string }> = [];
  if (sweep.reach.kind === "call") {
    // Matches `run…(`, `lib.run…(`, and `await mod.run…(` alike.
    const re = new RegExp(`(^|[^\\w$])${sweep.reach.call}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const open = match.index + match[0].length - 1;
      sites.push({ index: match.index + match[1]!.length, expression: readExpression(content, open, "call-arguments") });
    }
    return sites;
  }
  // An endpoint is reached by its URL, whatever client asks for it: supertest's
  // `.post(url).send({...})`, a bare `fetch(url, {...})`, a helper — so the read
  // runs to the end of the statement and the scope may arrive anywhere in it.
  // The URL may also be the tail of a template (`` `${base}/api/...` ``).
  const quoted = sweep.reach.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:["'\`]|\\})${quoted}(?=["'\`?]|\\$\\{)`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    sites.push({ index: match.index, expression: readExpression(content, match.index, "statement") });
  }
  return sites;
}

/**
 * Scan one test file's content. Exported so the guard's own suite can drive it
 * with fixture text instead of files on disk.
 */
export function scanTestContent(
  content: string,
  file: string,
  sweeps: ReadonlyArray<GuardedSweep> = GUARDED_SWEEPS,
): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);
  const starts = lineStartOffsets(content);

  for (const sweep of sweeps) {
    for (const site of callSites(content, sweep)) {
      const line = lineNumberAt(starts, site.index);
      const text = lines[line - 1] ?? "";
      if (isCommentLine(text)) continue;

      const spannedLines = lines.slice(
        line - 1,
        lineNumberAt(starts, site.index + site.expression.length),
      );
      const allow = allowMarkerFor(spannedLines);
      if (allow?.allowed) continue;
      if (allow?.problem) {
        violations.push({
          file,
          line,
          text: text.trim(),
          sweepId: sweep.id,
          reason: allow.problem,
        });
        continue;
      }

      const check = findScopeOption(site.expression, sweep.scopeOption);
      if (check.present) continue;
      violations.push({
        file,
        line,
        text: text.trim(),
        sweepId: sweep.id,
        reason: reasonFor(sweep, check),
      });
    }
  }

  return violations.sort((a, b) => a.line - b.line);
}

// ── Registry integrity ─────────────────────────────────────────────────────

/**
 * Check every entry against the source it names, so the list cannot describe a
 * sweep that no longer exists or an option that was renamed. Returns the
 * problems found; an empty array means the registry is honest.
 */
export function checkRegistry(
  sweeps: ReadonlyArray<GuardedSweep> = GUARDED_SWEEPS,
  repoRoot: string = REPO_ROOT,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const sweep of sweeps) {
    if (seen.has(sweep.id)) problems.push(`${sweep.id}: duplicate entry id.`);
    seen.add(sweep.id);

    if (!sweep.sweeps.trim()) {
      problems.push(`${sweep.id}: no description of what an unscoped run reaches.`);
    }
    if (!sweep.scopeOption.trim()) {
      problems.push(`${sweep.id}: no scope option named.`);
      continue;
    }

    const full = path.resolve(repoRoot, sweep.source);
    if (!fs.existsSync(full)) {
      problems.push(
        `${sweep.id}: ${sweep.source} is gone — point the entry at the sweep's ` +
          `new home, or drop the entry if the sweep was removed.`,
      );
      continue;
    }
    const source = fs.readFileSync(full, "utf8");

    if (sweep.reach.kind === "call") {
      const declared = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${sweep.reach.call}\\b`,
      ).test(source);
      if (!declared) {
        problems.push(
          `${sweep.id}: ${sweep.source} no longer exports ${sweep.reach.call}() — ` +
            `update the entry to the sweep's current name.`,
        );
      }
      if (!new RegExp(`\\b${sweep.scopeOption}\\??\\s*:`).test(source)) {
        problems.push(
          `${sweep.id}: ${sweep.reach.call}() takes no \`${sweep.scopeOption}\` option ` +
            `any more. Name the option that scopes it now — a sweep with no scope at ` +
            `all cannot be called from a test and needs one added.`,
        );
      }
      continue;
    }

    const routePath = sweep.reach.path.startsWith(API_MOUNT_PREFIX)
      ? sweep.reach.path.slice(API_MOUNT_PREFIX.length)
      : sweep.reach.path;
    const quoted = routePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const registered = new RegExp(
      `\\.\\s*${sweep.reach.method}\\s*\\(\\s*["'\`]${quoted}["'\`]`,
    ).test(source);
    if (!registered) {
      problems.push(
        `${sweep.id}: ${sweep.source} registers no ${sweep.reach.method.toUpperCase()} ` +
          `${routePath} route — update the entry to the route's current path.`,
      );
    }
    if (!new RegExp(`body\\.${sweep.scopeOption}\\b`).test(source)) {
      problems.push(
        `${sweep.id}: the ${sweep.reach.method.toUpperCase()} ${routePath} handler no ` +
          `longer reads \`body.${sweep.scopeOption}\`. Name the body field that scopes ` +
          `the run now.`,
      );
    }
  }

  return problems;
}

// ── Walking ────────────────────────────────────────────────────────────────

function* walkTestFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTestFiles(full);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name) && entry.name !== SELF_TEST_FILE) {
      yield full;
    }
  }
}

function main() {
  const problems = checkRegistry();
  if (problems.length > 0) {
    console.error(
      `[lint-maintenance-sweep-scope] FAIL — ${problems.length} stale registry entry/entries:\n`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      `\nGUARDED_SWEEPS in scripts/src/lint-maintenance-sweep-scope.ts describes sweeps ` +
        `that have since changed. Fix the entries.`,
    );
    process.exit(1);
  }

  const violations: Violation[] = [];
  let scanned = 0;
  for (const root of SCAN_ROOTS) {
    const full = path.resolve(REPO_ROOT, root);
    if (!fs.existsSync(full)) {
      console.error(
        `[lint-maintenance-sweep-scope] FAIL — scan root ${root} does not exist. ` +
          `Update SCAN_ROOTS in scripts/src/lint-maintenance-sweep-scope.ts.`,
      );
      process.exit(2);
    }
    for (const file of walkTestFiles(full)) {
      scanned++;
      violations.push(
        ...scanTestContent(
          fs.readFileSync(file, "utf8"),
          path.relative(REPO_ROOT, file),
        ),
      );
    }
  }

  if (violations.length === 0) {
    console.log(
      `[lint-maintenance-sweep-scope] OK — ${scanned} test file(s) scanned, ` +
        `${GUARDED_SWEEPS.length} guarded sweep(s), every call scoped.`,
    );
    process.exit(0);
  }

  console.error(
    `[lint-maintenance-sweep-scope] FAIL — ${violations.length} unscoped sweep call(s):\n`,
  );
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  [${violation.sweepId}]`);
    console.error(`    Code:   ${violation.text}`);
    console.error(`    Reason: ${violation.reason}`);
    console.error();
  }
  process.exit(1);
}

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
