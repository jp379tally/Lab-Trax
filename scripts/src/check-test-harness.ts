#!/usr/bin/env tsx
/**
 * Shared test-harness fence.
 *
 * Every artifact's Vitest suite is loaded through a small number of shared
 * harness files — the per-project `vitest*.config.ts` and the setup files they
 * name. Those files are edited by nearly every task branch, so a bad merge can
 * splice unrelated code into one of them. When that happens the damage is not
 * a failing test: every test file in the project fails to transform, the whole
 * suite goes dark, and the reason is buried thousands of lines into a run that
 * takes minutes.
 *
 * This fence answers the two cheap questions that catch that class of damage:
 *
 *   1. Does every harness file still exist and still parse?  (milliseconds)
 *   2. Can the mobile suite still collect its tests?          (~1 minute)
 *
 * Question 2 is the authoritative one: `vitest list` runs the real Vite/esbuild
 * transform over the setup file and every test file, so it fails on damage the
 * TypeScript parser tolerates. It is limited to the mobile project on purpose —
 * mobile is the suite whose harness keeps getting clobbered, its collection
 * costs about a minute, and the desktop/api-server collections cost several
 * minutes and (for api-server) touch the database. Those two projects are
 * still covered by the parse check, which is what catches a merge clobber.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-test-harness            # parse only
 *   pnpm --filter @workspace/scripts run check-test-harness:collect    # parse + collect
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where the per-project Vitest configs live. */
const ARTIFACTS_DIR = "artifacts";
const CONFIG_FILE_RE = /^vitest(\.[\w.-]+)?\.config\.(ts|mts|cts|js|mjs|cjs)$/;

/**
 * Harness files that must exist. Discovery alone is not enough: if a merge
 * deletes the mobile `setupFiles` entry, or renames the setup file, discovery
 * would quietly return a smaller set and the fence would pass while watching
 * nothing. These paths are the fence's own reason for existing, so their
 * absence is a failure rather than a smaller scan.
 */
export const REQUIRED_HARNESS_FILES = [
  "artifacts/labtrax/vitest.config.ts",
  "artifacts/labtrax/vitest.setup.ts",
] as const;

/** The project whose test collection is verified, and how it is invoked. */
export const COLLECT_PROJECT = {
  name: "mobile",
  dir: "artifacts/labtrax",
  command: "pnpm",
  args: ["exec", "vitest", "list"],
} as const;

const DEFAULT_COLLECT_TIMEOUT_MS = 420_000;

export type HarnessRole = "config" | "setup";

export interface HarnessFile {
  /** Repo-relative path, POSIX separators. */
  path: string;
  /** Artifact directory name, e.g. `labtrax`. */
  project: string;
  role: HarnessRole;
  /** For a setup file, the config that names it. */
  declaredBy?: string;
}

export type HarnessIssueKind = "missing" | "empty" | "parse";

export interface HarnessIssue {
  file: string;
  kind: HarnessIssueKind;
  message: string;
  line?: number;
  column?: number;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Syntax-check one harness file's source.
 *
 * Only the parser runs — no type checking, no module resolution — so this is
 * fast enough to gate a suite on, and it never fails because of an unrelated
 * type error somewhere else in the repo.
 */
export function parseHarnessSource(
  content: string,
  filePath: string,
): HarnessIssue[] {
  const transpiled = ts.transpileModule(content, {
    fileName: path.basename(filePath),
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
    },
  });

  const issues: HarnessIssue[] = [];
  for (const diagnostic of transpiled.diagnostics ?? []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    let line: number | undefined;
    let column: number | undefined;
    if (diagnostic.file && diagnostic.start != null) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      line = position.line + 1;
      column = position.character + 1;
    }
    issues.push({
      file: filePath,
      kind: "parse",
      message: `TS${diagnostic.code}: ${message}`,
      line,
      column,
    });
  }
  return issues;
}

/**
 * Check one harness file on disk: it must exist, hold something, and parse.
 *
 * An empty file is reported separately because it parses cleanly — a merge
 * that truncates the harness to nothing would otherwise pass the fence and
 * then fail every test at runtime on missing mocks.
 */
export function inspectHarnessFile(
  absolutePath: string,
  relativePath: string,
): HarnessIssue[] {
  if (!fs.existsSync(absolutePath)) {
    return [
      {
        file: relativePath,
        kind: "missing",
        message:
          "Harness file is missing. If it moved, update the Vitest config that " +
          "names it (and REQUIRED_HARNESS_FILES in this fence) so the fence " +
          "keeps watching it.",
      },
    ];
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  if (content.trim().length === 0) {
    return [
      {
        file: relativePath,
        kind: "empty",
        message:
          "Harness file is empty. An empty setup file parses cleanly but strips " +
          "every shared mock from the suite.",
      },
    ];
  }
  return parseHarnessSource(content, relativePath);
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/**
 * Pull the `setupFiles` entries out of a Vitest config's source.
 *
 * A regex rather than a module import: the config imports plugins and touches
 * the filesystem, and the fence must stay able to read a config whose
 * neighbours are broken.
 */
export function extractSetupFiles(configSource: string): string[] {
  const match = /setupFiles\s*:\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/s.exec(
    configSource,
  );
  if (!match) return [];
  const literal = match[1];
  const entries: string[] = [];
  const stringRe = /["'`]([^"'`]+)["'`]/g;
  let hit: RegExpExecArray | null;
  while ((hit = stringRe.exec(literal)) !== null) {
    entries.push(hit[1]);
  }
  return entries;
}

/**
 * Find every Vitest harness file under `artifacts/*`: each project's config,
 * plus every setup file those configs name.
 *
 * Discovery is used instead of a hand-written list so a project that adds a
 * setup file is covered the day it lands, rather than the day someone
 * remembers to register it here.
 */
export function discoverHarnessFiles(repoRoot: string): HarnessFile[] {
  const artifactsDir = path.join(repoRoot, ARTIFACTS_DIR);
  if (!fs.existsSync(artifactsDir)) return [];

  const found: HarnessFile[] = [];
  const seen = new Set<string>();

  const add = (file: HarnessFile) => {
    if (seen.has(file.path)) return;
    seen.add(file.path);
    found.push(file);
  };

  const projects = fs
    .readdirSync(artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const project of projects) {
    const projectDir = path.join(artifactsDir, project);
    const configs = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CONFIG_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    for (const configName of configs) {
      const configRel = `${ARTIFACTS_DIR}/${project}/${configName}`;
      add({ path: configRel, project, role: "config" });

      const configAbs = path.join(projectDir, configName);
      let source: string;
      try {
        source = fs.readFileSync(configAbs, "utf8");
      } catch {
        continue;
      }
      for (const entry of extractSetupFiles(source)) {
        // Bare module specifiers (e.g. "@testing-library/jest-dom/vitest")
        // are packages, not project files.
        if (!entry.startsWith(".") && !entry.startsWith("/")) continue;
        const setupAbs = path.resolve(projectDir, entry);
        const setupRel = path
          .relative(repoRoot, setupAbs)
          .split(path.sep)
          .join("/");
        add({
          path: setupRel,
          project,
          role: "setup",
          declaredBy: configRel,
        });
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

export interface CollectVerdict {
  ok: boolean;
  testCount: number;
  message: string;
}

/**
 * Decide whether a `vitest list` run proves the suite can still be collected.
 *
 * Split out from the spawn so the pass/fail rule is testable without paying a
 * minute for a real collection.
 *
 * A zero exit with no collected tests counts as a failure: a config whose
 * `include` globs were clobbered exits cleanly while running nothing, which is
 * the same blackout as a harness that cannot parse.
 */
export function summarizeCollectOutput(
  exitCode: number | null,
  output: string,
  timedOut = false,
): CollectVerdict {
  const testCount = output
    .split(/\r?\n/)
    .filter((line) => line.includes(" > ")).length;

  if (timedOut) {
    return {
      ok: false,
      testCount,
      message: "Test collection timed out before the suite finished loading.",
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      testCount,
      message: `Test collection failed (exit code ${exitCode ?? "null"}).`,
    };
  }
  if (testCount === 0) {
    return {
      ok: false,
      testCount,
      message:
        "Test collection reported no tests. The harness loaded but the suite is " +
        "empty — check the config's `include` globs.",
    };
  }
  return {
    ok: true,
    testCount,
    message: `Collected ${testCount} test(s).`,
  };
}

export interface CollectRun extends CollectVerdict {
  output: string;
}

/** Run the real collection for the mobile suite. */
export async function collectProjectTests(
  repoRoot: string,
  timeoutMs = DEFAULT_COLLECT_TIMEOUT_MS,
): Promise<CollectRun> {
  const cwd = path.join(repoRoot, COLLECT_PROJECT.dir);
  return new Promise<CollectRun>((resolve) => {
    const child = spawn(COLLECT_PROJECT.command, [...COLLECT_PROJECT.args], {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        testCount: 0,
        message: `Could not run test collection: ${error.message}`,
        output,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ...summarizeCollectOutput(code, output, timedOut), output });
    });
  });
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function lastLines(text: string, count: number): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-count).join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const withCollect = argv.includes("--collect");
  const timeoutMs = Number(
    process.env.HARNESS_COLLECT_TIMEOUT_MS ?? DEFAULT_COLLECT_TIMEOUT_MS,
  );

  const discovered = discoverHarnessFiles(REPO_ROOT);
  const scanned = new Set(discovered.map((file) => file.path));
  const issues: HarnessIssue[] = [];

  for (const required of REQUIRED_HARNESS_FILES) {
    if (scanned.has(required)) continue;
    issues.push({
      file: required,
      kind: "missing",
      message:
        "Required harness file was not found by discovery. Either the file is " +
        "gone or its Vitest config no longer names it in `setupFiles`; both " +
        "leave the suite without its shared mocks.",
    });
  }

  for (const file of discovered) {
    issues.push(...inspectHarnessFile(path.join(REPO_ROOT, file.path), file.path));
  }

  if (issues.length > 0) {
    console.error(
      `[check-test-harness] FAIL — ${issues.length} problem(s) in the shared test harness:\n`,
    );
    for (const issue of issues) {
      const where =
        issue.line != null ? `:${issue.line}:${issue.column ?? 1}` : "";
      console.error(`  ${issue.file}${where}  [${issue.kind}]`);
      console.error(`    ${issue.message}`);
      console.error();
    }
    console.error(
      "A broken harness file takes the entire suite down — every test file fails " +
        "to transform. This is usually a merge that spliced unrelated code into " +
        "the file; repair the clobbered region against the last intact revision " +
        "rather than rewriting the harness.",
    );
    return 1;
  }

  console.log(
    `[check-test-harness] OK — ${discovered.length} harness file(s) parse:`,
  );
  for (const file of discovered) {
    console.log(`  ${file.path} [${file.project}/${file.role}]`);
  }

  if (!withCollect) {
    console.log(
      "[check-test-harness] Parse check only. Pass --collect to also verify the " +
        "mobile suite still collects.",
    );
    return 0;
  }

  console.log(
    `[check-test-harness] Collecting ${COLLECT_PROJECT.name} tests (${COLLECT_PROJECT.dir})…`,
  );
  const collected = await collectProjectTests(REPO_ROOT, timeoutMs);
  if (!collected.ok) {
    console.error(`[check-test-harness] FAIL — ${collected.message}\n`);
    console.error(lastLines(collected.output, 40));
    console.error(
      `\nThe ${COLLECT_PROJECT.name} suite cannot be loaded, so no mobile test can ` +
        "run. Reproduce with: " +
        `\`cd ${COLLECT_PROJECT.dir} && ${COLLECT_PROJECT.command} ${COLLECT_PROJECT.args.join(" ")}\``,
    );
    return 1;
  }

  console.log(`[check-test-harness] OK — ${collected.message}`);
  return 0;
}

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      console.error("[check-test-harness] FAIL — fence crashed:", error);
      process.exit(2);
    },
  );
}
