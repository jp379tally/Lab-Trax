#!/usr/bin/env tsx
/**
 * Mobile legacy-path fence.
 *
 * Scans the mobile app source tree and fails the build when NEW code
 * introduces references to any of the following forbidden patterns:
 *
 *   1. `/api/legacy/cases`  — all new case mutations must go through
 *      /api/cases (canonical UUID endpoint).
 *   2. `lab_cases`           — mobile code must not reference the legacy
 *      blob table by name; data access goes through /api/cases.
 *   3. `pendingSyncCount`    — reading this field outside of app-context
 *      perpetuates the legacy sync model; new code reads queue state via
 *      the pending-uploads helpers directly.
 *   4. `stuckSyncItems`      — same rationale as pendingSyncCount.
 *   5. `unionActivityLog`    — the server-side legacy union helper must not
 *      be called from new mobile code paths.
 *
 * Grandfathered files (contain all existing legacy code and cannot be
 * changed in bulk without breaking existing cached cases on users' devices):
 *   - `artifacts/labtrax/lib/app-context.tsx`  (file-level disable marker)
 *
 * Per-line escape hatch: add `// legacy-fence:allow` at the end of any
 * line that must be individually exempted (e.g. a legacy call that serves
 * read-only backward compatibility for existing data).
 *
 * Wire this into CI:
 *   pnpm --filter @workspace/scripts run lint-mobile-legacy-paths
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const MOBILE_APP = path.resolve(REPO_ROOT, "artifacts", "labtrax");

export const FILE_DISABLE_MARKER = "legacy-mobile-fence:disable-file";
export const LINE_ALLOW_MARKER = "legacy-fence:allow";

export interface ForbiddenPattern {
  id: string;
  regex: RegExp;
  reason: string;
}

export const FORBIDDEN: ForbiddenPattern[] = [
  {
    id: "api-legacy-cases",
    regex: /\/api\/legacy\/cases/,
    reason:
      "Direct call to /api/legacy/cases is forbidden. New cases must go through POST /api/cases " +
      "and receive a canonical UUID. Add `// legacy-fence:allow` only for grandfathered read-only " +
      "backward-compatibility calls.",
  },
  {
    id: "lab-cases-table",
    regex: /\blab_cases\b/,
    reason:
      "Reference to `lab_cases` table is forbidden in mobile code. Access case data via " +
      "/api/cases (canonical API). The legacy table is read-only for existing data.",
  },
  {
    id: "pending-sync-count",
    regex: /\bpendingSyncCount\b/,
    reason:
      "`pendingSyncCount` is a legacy field from the pre-canonical sync model. " +
      "New code should read queue state via the pending-uploads helpers directly " +
      "or observe the canonical React Query cache.",
  },
  {
    id: "stuck-sync-items",
    regex: /\bstuckSyncItems\b/,
    reason:
      "`stuckSyncItems` is a legacy field from the pre-canonical sync model. " +
      "New code should read queue state via the pending-uploads helpers directly.",
  },
  {
    id: "union-activity-log",
    regex: /\bunionActivityLog\b/,
    reason:
      "`unionActivityLog` is a server-side legacy helper that merges lab_cases blobs. " +
      "New mobile code must source activity history exclusively from GET /api/cases/:id/events.",
  },
];

export interface Violation {
  file: string;
  line: number;
  text: string;
  patternId: string;
  reason: string;
}

function isCommentLine(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Scan raw file content for forbidden patterns.
 * `filePath` is used only for the `file` field of returned violations — no
 * filesystem reads are performed here. This makes the function easy to unit-test.
 */
export function scanContent(content: string, filePath: string): Violation[] {
  const violations: Violation[] = [];

  if (content.includes(FILE_DISABLE_MARKER)) return violations;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    if (line.includes(LINE_ALLOW_MARKER)) continue;

    for (const p of FORBIDDEN) {
      if (p.regex.test(line)) {
        violations.push({
          file: filePath,
          line: i + 1,
          text: line.trim(),
          patternId: p.id,
          reason: p.reason,
        });
      }
    }
  }
  return violations;
}

function scanFile(file: string): Violation[] {
  return scanContent(fs.readFileSync(file, "utf8"), file);
}

function* walkTs(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name.startsWith(".") ||
      entry.name === "__tests__" ||
      entry.name === "build" ||
      entry.name === "dist"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

function main() {
  const scanDirs = [
    path.join(MOBILE_APP, "app"),
    path.join(MOBILE_APP, "lib"),
    path.join(MOBILE_APP, "components"),
    path.join(MOBILE_APP, "hooks"),
    path.join(MOBILE_APP, "constants"),
  ].filter(fs.existsSync);

  if (scanDirs.length === 0) {
    console.error(
      `[lint-mobile-legacy-paths] FAIL — mobile app source not found at ${MOBILE_APP}`
    );
    process.exit(2);
  }

  const allViolations: Violation[] = [];
  for (const dir of scanDirs) {
    for (const file of walkTs(dir)) {
      allViolations.push(...scanFile(file));
    }
  }

  if (allViolations.length === 0) {
    console.log(
      `[lint-mobile-legacy-paths] OK — no forbidden legacy-path references found.`
    );
    process.exit(0);
  }

  console.error(
    `[lint-mobile-legacy-paths] FAIL — ${allViolations.length} violation(s):\n`
  );
  for (const v of allViolations) {
    const rel = path.relative(REPO_ROOT, v.file);
    console.error(`  ${rel}:${v.line}  [${v.patternId}]`);
    console.error(`    Code:   ${v.text}`);
    console.error(`    Reason: ${v.reason}`);
    console.error();
  }
  console.error(
    `To suppress a specific line: add \`// ${LINE_ALLOW_MARKER}\` at the end of that line.\n` +
    `To suppress an entire file: add a comment containing \`${FILE_DISABLE_MARKER}\` anywhere in the file ` +
    `(only for files that pre-date this fence and cannot be migrated in bulk).`
  );
  process.exit(1);
}

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
