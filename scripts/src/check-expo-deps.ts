/**
 * check-expo-deps
 * ----------------
 * Surfaces drift between the LabTrax mobile app's installed Expo packages and
 * the versions Expo expects, and — crucially — classifies that drift against
 * the workspace's supply-chain maturity policy (`minimumReleaseAge` in
 * pnpm-workspace.yaml) so it never pressures anyone to weaken that policy.
 *
 * It runs `expo install --check --json` for @workspace/labtrax, then for every
 * outdated package asks the npm registry when the target version was published.
 * Each drift is bucketed as:
 *
 *   • ACTIONABLE   — a newer in-range version exists AND it is older than the
 *                    maturity window, so it is safe to bump right now.
 *   • IN-WINDOW    — the only newer in-range version(s) are still younger than
 *                    the maturity window. Informational only: the bump is
 *                    genuinely blocked on time, not on anyone's action.
 *   • UNKNOWN      — registry/metadata could not be resolved (treated as a
 *                    non-fatal warning so transient network blips don't page).
 *
 * Exit codes:
 *   0  — up to date, or only IN-WINDOW / UNKNOWN drift.
 *   1  — at least one ACTIONABLE drift (mature, safe to bump).
 *
 * Pass `--soft` (or set CHECK_EXPO_DEPS_SOFT=1) to always exit 0 while still
 * reporting — useful if you want the workflow green but annotated.
 *
 * When run inside GitHub Actions it also writes a Markdown table to
 * $GITHUB_STEP_SUMMARY and emits ::notice/::warning/::error:: annotations.
 */

import { execFile } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import semver from "semver";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "..", "..");
const MOBILE_FILTER = "@workspace/labtrax";
const DEFAULT_MATURITY_MINUTES = 1440;

/** One outdated entry as emitted by `expo install --check --json`. */
export interface ExpoOutdatedDep {
  packageName: string;
  packageType?: string;
  expectedVersionOrRange: string;
  actualVersion: string;
}

export type DriftStatus = "actionable" | "in-window" | "unknown";

export interface DriftResult {
  packageName: string;
  installed: string;
  expected: string;
  status: DriftStatus;
  /** Concrete version we'd land on (mature target for actionable, newest in-range for in-window). */
  targetVersion?: string;
  /** Age in minutes of `targetVersion` at evaluation time (in-window only). */
  targetAgeMinutes?: number;
  /** When `targetVersion` becomes mature (in-window only). */
  matureAt?: Date;
  /** Human-readable explanation, esp. for unknown. */
  note?: string;
}

/** Minimal slice of npm registry packument we rely on. */
export interface RegistryPackument {
  versions: Record<string, unknown>;
  time: Record<string, string>;
}

/**
 * Parse `minimumReleaseAge` (minutes) from pnpm-workspace.yaml content.
 * Falls back to {@link DEFAULT_MATURITY_MINUTES} when the key is absent.
 */
export function parseMinimumReleaseAge(yamlContent: string): number {
  const match = yamlContent.match(/^\s*minimumReleaseAge:\s*(\d+)\s*$/m);
  if (!match) return DEFAULT_MATURITY_MINUTES;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MATURITY_MINUTES;
}

/**
 * Pure classifier: given one outdated dep and its registry packument, decide
 * whether bumping is actionable now, blocked by the maturity window, or
 * indeterminate. `now` and `maturityMinutes` are injected for testability.
 */
export function classifyDrift(
  dep: ExpoOutdatedDep,
  packument: RegistryPackument | null,
  maturityMinutes: number,
  now: Date,
): DriftResult {
  const base: DriftResult = {
    packageName: dep.packageName,
    installed: dep.actualVersion,
    expected: dep.expectedVersionOrRange,
    status: "unknown",
  };

  if (!packument || !packument.versions || !packument.time) {
    return { ...base, note: "could not fetch registry metadata" };
  }

  const range = dep.expectedVersionOrRange;
  const allVersions = Object.keys(packument.versions);

  // Versions that satisfy what Expo expects AND are newer than what's installed.
  const newerInRange = allVersions.filter((v) => {
    if (!semver.valid(v)) return false;
    const satisfies =
      semver.validRange(range) != null &&
      semver.satisfies(v, range, { includePrerelease: true });
    // Exact-version expectations (the common Expo case) aren't valid ranges to
    // `satisfies` in every edge, so also accept an exact string match.
    const exactMatch = v === range;
    if (!satisfies && !exactMatch) return false;
    return semver.gt(v, dep.actualVersion);
  });

  if (newerInRange.length === 0) {
    // Expo flagged it but we see nothing newer in range — e.g. installed
    // version is outside the expected range with no newer publish, or a
    // downgrade. Surface as actionable so a human looks.
    return {
      ...base,
      status: "actionable",
      note: "expo reports drift but no newer in-range publish was found; manual review",
    };
  }

  const cutoff = new Date(now.getTime() - maturityMinutes * 60_000);
  const isMature = (v: string): boolean => {
    const published = packument.time[v];
    if (!published) return false;
    return new Date(published).getTime() <= cutoff.getTime();
  };

  const matureNewer = newerInRange.filter(isMature);

  if (matureNewer.length > 0) {
    const target = matureNewer.sort(semver.rcompare)[0];
    return {
      ...base,
      status: "actionable",
      targetVersion: target,
    };
  }

  // Only immature newer versions exist → genuinely blocked on the window.
  const target = newerInRange.sort(semver.rcompare)[0];
  const publishedStr = packument.time[target];
  const publishedMs = publishedStr ? new Date(publishedStr).getTime() : now.getTime();
  const ageMinutes = Math.max(0, Math.round((now.getTime() - publishedMs) / 60_000));
  return {
    ...base,
    status: "in-window",
    targetVersion: target,
    targetAgeMinutes: ageMinutes,
    matureAt: new Date(publishedMs + maturityMinutes * 60_000),
  };
}

/** Run `expo install --check --json` for the mobile app; returns parsed deps. */
async function runExpoCheck(): Promise<ExpoOutdatedDep[]> {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "pnpm",
      ["--filter", MOBILE_FILTER, "exec", "expo", "install", "--check", "--json"],
      { cwd: WORKSPACE_ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    // expo exits 1 when outdated — that's expected and still prints JSON.
    const e = err as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
    if (!stdout.trim()) {
      throw new Error(
        `expo install --check produced no JSON output.\n${e.stderr ?? ""}`,
      );
    }
  }

  // The JSON object is the last brace-delimited block in stdout (pnpm may
  // prefix lines). Grab from the first "{" to the last "}".
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Could not locate JSON in expo output:\n${stdout}`);
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as {
    dependencies?: ExpoOutdatedDep[];
    upToDate?: boolean;
  };
  return parsed.dependencies ?? [];
}

/** Fetch the npm packument (versions + publish times) for a package. */
async function fetchPackument(name: string): Promise<RegistryPackument | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as RegistryPackument;
    if (!json || !json.versions || !json.time) return null;
    return json;
  } catch {
    return null;
  }
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function ghAnnotation(level: "notice" | "warning" | "error", message: string): void {
  if (!process.env.GITHUB_ACTIONS) return;
  // Collapse newlines so the annotation stays a single line.
  process.stdout.write(`::${level}::${message.replace(/\n/g, " ")}\n`);
}

function writeStepSummary(lines: string[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, lines.join("\n") + "\n");
  } catch {
    /* non-fatal */
  }
}

async function main(): Promise<void> {
  const soft =
    process.argv.includes("--soft") || process.env.CHECK_EXPO_DEPS_SOFT === "1";

  let maturityMinutes = DEFAULT_MATURITY_MINUTES;
  try {
    const yaml = readFileSync(resolve(WORKSPACE_ROOT, "pnpm-workspace.yaml"), "utf8");
    maturityMinutes = parseMinimumReleaseAge(yaml);
  } catch {
    console.warn(
      `Could not read pnpm-workspace.yaml; assuming maturity window of ${maturityMinutes}m`,
    );
  }

  console.log(
    `Checking ${MOBILE_FILTER} Expo deps (maturity window: ${fmtAge(maturityMinutes)} / ${maturityMinutes}m)…`,
  );

  const outdated = await runExpoCheck();

  if (outdated.length === 0) {
    console.log("✓ Expo dependencies are up to date.");
    ghAnnotation("notice", "Expo mobile dependencies are up to date.");
    writeStepSummary(["### Expo dependency check", "", "✓ All dependencies are up to date."]);
    return;
  }

  const now = new Date();
  const results: DriftResult[] = [];
  for (const dep of outdated) {
    const packument = await fetchPackument(dep.packageName);
    results.push(classifyDrift(dep, packument, maturityMinutes, now));
  }

  const actionable = results.filter((r) => r.status === "actionable");
  const inWindow = results.filter((r) => r.status === "in-window");
  const unknown = results.filter((r) => r.status === "unknown");

  // Console report
  console.log("");
  for (const r of results) {
    if (r.status === "actionable") {
      const to = r.targetVersion ? ` → ${r.targetVersion}` : "";
      console.log(
        `  [ACTIONABLE] ${r.packageName} ${r.installed}${to} (expected ${r.expected}) — mature, safe to bump`,
      );
    } else if (r.status === "in-window") {
      const age = r.targetAgeMinutes != null ? fmtAge(r.targetAgeMinutes) : "?";
      const matures = r.matureAt ? r.matureAt.toISOString() : "?";
      console.log(
        `  [IN-WINDOW]  ${r.packageName} ${r.installed} → ${r.targetVersion} (expected ${r.expected}) — published ${age} ago, matures ${matures}`,
      );
    } else {
      console.log(
        `  [UNKNOWN]    ${r.packageName} ${r.installed} (expected ${r.expected}) — ${r.note ?? "could not classify"}`,
      );
    }
  }
  console.log("");

  // GitHub annotations
  for (const r of actionable) {
    ghAnnotation(
      "error",
      `${r.packageName} is outdated and mature: bump ${r.installed} → ${r.targetVersion ?? r.expected} in artifacts/labtrax/package.json (safe — past the ${fmtAge(maturityMinutes)} maturity window).`,
    );
  }
  for (const r of inWindow) {
    ghAnnotation(
      "notice",
      `${r.packageName} ${r.installed} → ${r.targetVersion} is outdated but still inside the ${fmtAge(maturityMinutes)} maturity window (published ${r.targetAgeMinutes != null ? fmtAge(r.targetAgeMinutes) : "?"} ago). No action needed yet; re-run after ${r.matureAt ? r.matureAt.toISOString() : "the window passes"}.`,
    );
  }
  for (const r of unknown) {
    ghAnnotation("warning", `${r.packageName}: ${r.note ?? "could not classify drift"}.`);
  }

  // Step summary table
  const summary: string[] = ["### Expo dependency check", ""];
  summary.push(`Maturity window: \`${maturityMinutes}m\` (${fmtAge(maturityMinutes)}).`, "");
  summary.push("| Package | Installed | Target | Status | Notes |");
  summary.push("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    let status: string;
    let notes: string;
    if (r.status === "actionable") {
      status = "🔴 Actionable";
      notes = "Mature — safe to bump now";
    } else if (r.status === "in-window") {
      status = "🟡 In maturity window";
      notes = `Published ${r.targetAgeMinutes != null ? fmtAge(r.targetAgeMinutes) : "?"} ago; matures ${r.matureAt ? r.matureAt.toISOString() : "?"}`;
    } else {
      status = "⚪ Unknown";
      notes = r.note ?? "Could not classify";
    }
    summary.push(
      `| \`${r.packageName}\` | ${r.installed} | ${r.targetVersion ?? r.expected} | ${status} | ${notes} |`,
    );
  }
  writeStepSummary(summary);

  console.log(
    `Summary: ${actionable.length} actionable, ${inWindow.length} in-window, ${unknown.length} unknown.`,
  );

  if (actionable.length > 0) {
    console.log(
      "\nActionable updates are mature. Bump the specs in artifacts/labtrax/package.json " +
        "and run `pnpm install` + `pnpm --filter @workspace/labtrax exec expo install --check`. " +
        "Do NOT weaken minimumReleaseAge to clear in-window drift.",
    );
    if (!soft) process.exit(1);
  }
}

// Only run when invoked directly (e.g. `tsx check-expo-deps.ts`), not when the
// pure helpers above are imported by a test.
const invokedDirectly =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("check-expo-deps failed:", err);
    // A harness/registry failure shouldn't masquerade as a dependency problem;
    // exit 2 so callers can distinguish tooling failure from actionable drift.
    process.exit(2);
  });
}
