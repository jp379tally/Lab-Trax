/**
 * The publish gate, exercised the way the deployment build runs it.
 *
 * `scripts/src/check-schema-columns.ts` is the command `build:api-production`
 * invokes before the API server is built. The comparison it relies on is unit
 * tested in `data-fingerprint.test.ts`, but what actually stops a bad build is
 * this file's exit code: a refactor that reported the same findings and still
 * exited 0 would leave every unit test green while the build walked past a
 * swapped production database.
 *
 * So these tests spawn the real command as a child process, with the env the
 * committed package script sets, and assert the process-level outcome. The
 * only substitution is the database connection itself (see
 * `fixtures/stub-database.mjs`): a test cannot host a PostgreSQL server
 * holding the lab's data, so the `@workspace/db` pool is scripted while the
 * declared schema, the committed fingerprint, the comparison, the operator
 * report and the exit code all stay real.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CaseOrganizationConstraint } from "@workspace/db/case-organization-integrity";

import {
  DATA_FINGERPRINT_RELATIVE_PATH,
  FINGERPRINT_COUNTS,
  loadExpectedDataFingerprints,
  type RecordedDataFingerprint,
} from "../data-fingerprint";
import { createSyntheticPreservedCaseManifest } from "./fixtures/synthetic-preserved-case-manifest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(SCRIPTS_DIR, "..");
const TSX = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Relative path the packaged commands must still point at. */
const PACKAGED_GATE_PATH = "./src/check-schema-columns.ts";

/** The two committed entry points into this gate. */
const PRODUCTION_COMMAND = "check-production-schema-columns";
const DEVELOPMENT_COMMAND = "check-schema-columns";

function stubPreloadFor(gateScript: string): string {
  const stagedPreload = resolve(
    dirname(gateScript),
    "__tests__",
    "fixtures",
    "register-stub-database.mjs",
  );
  return `--import ${pathToFileURL(
    existsSync(stagedPreload)
      ? stagedPreload
      : resolve(HERE, "fixtures", "register-stub-database.mjs"),
  ).href}`;
}

// Spawning tsx transforms the gate and the whole Drizzle schema from scratch.
// That is a couple of seconds alone, but when every rel-* workflow fires at
// once CPU contention stretches it well past Vitest's default timeout, so both
// the child and the test get real headroom.
const GATE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 150_000;

/** What the scripted database answers the identity probe with. */
interface StubDatabase {
  /** One probe row, keyed by the probe's own column aliases. */
  fingerprintRow?: Record<string, string | null>;
  /** Whether the committed protected lab is found. Defaults to true. */
  labExists?: boolean;
  /** Raise a PostgreSQL error instead, e.g. SQLSTATE 42P01. */
  probeError?: { code: string; message?: string };
  caseRows?: Record<string, string>;
  preservedCaseRows?: Record<string, string>;
  caseConstraints?: CaseOrganizationConstraint[];
  caseProbeError?: { code: string; message?: string };
}

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

const committed = loadExpectedDataFingerprints(
  resolve(SCRIPTS_DIR, "src", "fixtures", "synthetic-database-fingerprint.json"),
);
const committedProduction = requireRecorded(committed.production, "production");
const committedDevelopment = requireRecorded(
  committed.development,
  "development",
);

function requireRecorded(
  recorded: RecordedDataFingerprint | null,
  section: string,
): RecordedDataFingerprint {
  if (!recorded) {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH} records no ${section} fingerprint, so the publish gate cannot be exercised against it`,
    );
  }
  return recorded;
}

/**
 * Read the env a committed package script puts in front of the gate, so these
 * runs stay the build's runs rather than an approximation of them.
 */
function packagedGateEnv(command: string): Record<string, string> {
  const packageJson = JSON.parse(
    readFileSync(join(SCRIPTS_DIR, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.[command];
  if (typeof script !== "string") {
    throw new Error(`scripts/package.json no longer defines ${command}`);
  }

  const parts = script.split(/\s+/);
  const env: Record<string, string> = {};
  let index = 0;
  for (; index < parts.length; index++) {
    const assignment = /^([A-Z0-9_]+)=(.*)$/.exec(parts[index]);
    if (!assignment) break;
    env[assignment[1]] = assignment[2];
  }

  // If the command stops running this file, these tests are measuring
  // something the build no longer does.
  expect(parts.slice(index)).toEqual(["tsx", PACKAGED_GATE_PATH]);
  return env;
}

function runGate({
  command,
  database,
  gateScript = defaultGateScript,
}: {
  command: string;
  database: StubDatabase;
  gateScript?: string;
}): GateRun {
  const result = spawnSync(TSX, [gateScript], {
    // The gate resolves everything from its own location, so the staged copy
    // below runs from its own directory just as the real one runs from
    // `scripts/`.
    cwd: resolve(gateScript, "..", ".."),
    env: {
      ...process.env,
      // Neither variable is part of the development command, so blank them
      // first: an inherited value would silently change the target.
      SCHEMA_COLUMN_CHECK_TARGET: "",
      SCHEMA_COLUMN_CHECK_ALLOW_MISSING: "",
      ...packagedGateEnv(command),
      PUBLISH_GATE_STUB_DATABASE: JSON.stringify(database),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, stubPreloadFor(gateScript)]
        .filter(Boolean)
        .join(" "),
    },
    encoding: "utf8",
    timeout: GATE_TIMEOUT_MS,
  });

  if (result.error) throw result.error;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}${stderr}`;

  // Without these guards a broken harness looks like a blocked publish: both
  // exit 1, and every "the gate blocks" assertion would pass for the wrong
  // reason.
  if (combined.includes("unexpected query")) {
    throw new Error(
      `the scripted database did not recognise a query the gate ran — the stub is out of date with the probe SQL:\n${combined}`,
    );
  }
  if (combined.includes("DATABASE_URL must be set")) {
    throw new Error(
      `the gate loaded the real database pool, so the scripted database was never used:\n${combined}`,
    );
  }

  return { status: result.status, stdout, stderr, combined };
}

/** One probe row answering exactly what a recorded fingerprint describes. */
function probeRow(
  recorded: RecordedDataFingerprint,
  overrides: Record<string, string | null> = {},
): Record<string, string | null> {
  const row: Record<string, string | null> = {};
  for (const count of FINGERPRINT_COUNTS) {
    // node-postgres hands back `count(*)` as a bigint string.
    row[count.column] = String(recorded[count.field]);
  }
  row.oldest_case_created_at = recorded.oldestCaseCreatedAt;
  return { ...row, ...overrides };
}

const stagedDirs: string[] = [];
let defaultGateScript: string;

beforeAll(async () => {
  defaultGateScript = await stageGateWithBaseline(committed);
});

afterAll(async () => {
  await Promise.all(
    stagedDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Stage the gate against a different committed baseline.
 *
 * The baseline is deliberately not overridable at runtime — an env var
 * pointing the gate at a different fingerprint file would be the bypass this
 * protection exists to forbid. So a scenario that needs another baseline gets
 * its own copy of the sources next to its own `database-fingerprint.json`,
 * which is the only way to reach the gate's first-deployment behaviour without
 * weakening the gate.
 */
async function stageGateWithBaseline(baseline: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "publish-gate-baseline-"));
  stagedDirs.push(dir);
  await cp(resolve(SCRIPTS_DIR, "src"), join(dir, "src"), {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  await cp(
    resolve(HERE, "fixtures"),
    join(dir, "src", "__tests__", "fixtures"),
    { recursive: true },
  );
  await symlink(join(SCRIPTS_DIR, "node_modules"), join(dir, "node_modules"));
  // `"type": "module"` is what makes the copy load as ESM, exactly as it does
  // inside the scripts package.
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "publish-gate-baseline-fixture",
      private: true,
      type: "module",
    }),
  );
  await writeFile(
    join(dir, "database-fingerprint.json"),
    JSON.stringify(baseline, null, 2),
  );
  await writeFile(
    join(dir, "preserved-legacy-case-fingerprints.json"),
    JSON.stringify(createSyntheticPreservedCaseManifest()),
  );
  return join(dir, "src", "check-schema-columns.ts");
}

/**
 * Run the production build chain in a disposable workspace copy. The checker
 * reads two fixed-path integrity manifests, so staging synthetic versions is
 * safer and more faithful than letting this test touch the private workspace
 * manifests. The API build is a marker command that must remain unreachable
 * when migration screening blocks.
 */
async function stageProductionBuildWorkspace(
  diffPath: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "publish-build-workspace-"));
  stagedDirs.push(dir);
  const scriptsDir = join(dir, "scripts");
  const apiDir = join(dir, "artifacts", "api-server");
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(apiDir, { recursive: true });
  await cp(resolve(SCRIPTS_DIR, "src"), join(scriptsDir, "src"), {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  await cp(
    resolve(HERE, "fixtures"),
    join(scriptsDir, "src", "__tests__", "fixtures"),
    { recursive: true },
  );
  await cp(
    resolve(SCRIPTS_DIR, "package.json"),
    join(scriptsDir, "package.json"),
  );
  await symlink(
    resolve(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  await symlink(
    resolve(SCRIPTS_DIR, "node_modules"),
    join(scriptsDir, "node_modules"),
    "dir",
  );
  await writeFile(
    join(scriptsDir, "database-fingerprint.json"),
    JSON.stringify({
      production: committedProduction,
      development: committedDevelopment,
    }),
  );
  await writeFile(
    join(scriptsDir, "preserved-legacy-case-fingerprints.json"),
    JSON.stringify(createSyntheticPreservedCaseManifest()),
  );
  const rootPackage = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as {
    packageManager?: string;
    scripts: Record<string, string>;
  };
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "synthetic-publish-build-workspace",
      private: true,
      packageManager: rootPackage.packageManager,
      scripts: {
        "build:api-production": rootPackage.scripts["build:api-production"],
        "check:generated-api": "node -e \"process.exit(0)\"",
      },
    }),
  );
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    "packages:\n  - scripts\n  - artifacts/api-server\n",
  );
  await writeFile(
    join(apiDir, "package.json"),
    JSON.stringify({
      name: "@workspace/api-server",
      version: "0.0.0",
      private: true,
      scripts: { build: "node -e \"console.log('API_BUILD_REACHED')\"" },
    }),
  );
  return dir;
}

describe("publish gate: check-schema-columns exit codes", () => {
  it("reports unresolved development ownership without stopping post-merge setup", () => {
    const run = runGate({
      command: DEVELOPMENT_COMMAND,
      database: {
        fingerprintRow: probeRow(committedDevelopment),
        caseRows: { total_cases: "298", missing_lab: "298", missing_practice: "298", affected_total: "298", affected_active: "297" },
        caseConstraints: [],
      },
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("298 affected");
    expect(run.stderr).toContain("records remain preserved pending owner-authorized repair");
    expect(run.stderr).toContain("lab_organization_id");
    expect(run.stderr).toContain("provider_organization_id");
  }, TEST_TIMEOUT_MS);

  it("blocks production orphan rows even when catalog drift is allowed and lineage matches", () => {
    const run = runGate({
      command: PRODUCTION_COMMAND,
      database: {
        fingerprintRow: probeRow(committedProduction),
        caseRows: { missing_lab: "1", missing_practice: "1", affected_total: "1", affected_active: "0" },
        preservedCaseRows: { unexpected_count: "1" },
        caseConstraints: [],
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("1 invalid-owner record(s) outside the committed legacy exception");
    expect(run.stdout).toContain("matches the fingerprint");
  }, TEST_TIMEOUT_MS);

  it.each([
    { label: "missing archived row", rows: { present_count: "296", matching_count: "296" }, message: "archived record(s) missing" },
    { label: "changed archived row", rows: { present_count: "297", matching_count: "296" }, message: "record(s) changed from the approved archive" },
  ])("blocks a $label even when ownership and lineage are intact", ({ rows, message }) => {
    const run = runGate({
      command: PRODUCTION_COMMAND,
      database: {
        fingerprintRow: probeRow(committedProduction),
        preservedCaseRows: rows,
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
    expect(run.stdout).toContain("matches the fingerprint");
  }, TEST_TIMEOUT_MS);

  it("keeps a missing FK advisory in production when actual rows are intact", () => {
    const run = runGate({
      command: PRODUCTION_COMMAND,
      database: { fingerprintRow: probeRow(committedProduction), caseConstraints: [] },
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("FK catalog");
    expect(run.stderr).toContain("missing");
    expect(run.stdout).toContain("0 affected");
  }, TEST_TIMEOUT_MS);

  it("blocks an unverifiable production ownership probe but keeps development setup advisory", () => {
    const error = { code: "08006", message: "synthetic case probe unavailable" };
    const production = runGate({
      command: PRODUCTION_COMMAND,
      database: { fingerprintRow: probeRow(committedProduction), caseProbeError: error },
    });
    expect(production.status).toBe(1);
    expect(production.stderr).toContain("integrity could not be verified");
    const development = runGate({
      command: DEVELOPMENT_COMMAND,
      database: { fingerprintRow: probeRow(committedDevelopment), caseProbeError: error },
    });
    expect(development.status).toBe(0);
    expect(development.stderr).toContain("integrity could not be verified");
  }, TEST_TIMEOUT_MS);
  it(
    "exits 0 and records the evidence when production still matches the committed fingerprint",
    () => {
      const run = runGate({
        command: PRODUCTION_COMMAND,
        database: { fingerprintRow: probeRow(committedProduction) },
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        `matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}`,
      );
      // The publish log must carry what the gate saw, not just its verdict.
      expect(run.stdout).toContain(
        `oldest case created_at: ${committedProduction.oldestCaseCreatedAt}`,
      );
      expect(run.stderr).not.toContain("BLOCKED");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 and refuses to continue when production's lineage is not the recorded one",
    () => {
      const run = runGate({
        command: PRODUCTION_COMMAND,
        database: {
          fingerprintRow: probeRow(committedProduction, {
            oldest_case_created_at: "2026-07-01T10:11:12.131415Z",
          }),
        },
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("BLOCKED");
      expect(run.stderr).toContain(
        "this is not the database the last fingerprint was taken from",
      );
      expect(run.stderr).toContain("refusing to continue");
      // The operator is told how a legitimate change is accepted.
      expect(run.stderr).toContain("record-production-data-fingerprint");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 when production arrives as a copy of the development database",
    () => {
      // The October 2026 signature: a healthy-looking production database
      // whose oldest row matches development to the microsecond.
      const run = runGate({
        command: PRODUCTION_COMMAND,
        database: {
          fingerprintRow: probeRow(committedProduction, {
            oldest_case_created_at: committedDevelopment.oldestCaseCreatedAt,
          }),
        },
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "production looks like a copy of development",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 when an irreplaceable record set has collapsed, even with the lineage intact",
    () => {
      const collapsed = FINGERPRINT_COUNTS[0];
      const run = runGate({
        command: PRODUCTION_COMMAND,
        database: {
          fingerprintRow: probeRow(committedProduction, {
            [collapsed.column]: "0",
          }),
        },
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`production holds 0 ${collapsed.noun}(s)`);
      expect(run.stderr).toContain("refusing to continue");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 when production no longer has the tables holding the lab's records",
    () => {
      // Fail closed: a production database that cannot even be asked how many
      // cases it holds, while the repository records thousands, is a swap.
      const run = runGate({
        command: PRODUCTION_COMMAND,
        database: {
          caseProbeError: {
            code: "42P01",
            message: 'relation "public.cases" does not exist',
          },
          probeError: {
            code: "42P01",
            message: 'relation "public.cases" does not exist',
          },
        },
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "production does not have the tables holding the lab's records",
      );
      expect(run.stderr).toContain("refusing to continue");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 0 with a warning when nothing is recorded yet and the tables are absent",
    async () => {
      // A first deployment must not be deadlocked: the same database that
      // blocks above is only a failure because a fingerprint was recorded.
      const gateScript = await stageGateWithBaseline({
        production: null,
        development: null,
      });

      const run = runGate({
        command: PRODUCTION_COMMAND,
        gateScript,
        database: {
          caseProbeError: {
            code: "42P01",
            message: 'relation "public.cases" does not exist',
          },
          probeError: {
            code: "42P01",
            message: 'relation "public.cases" does not exist',
          },
        },
      });

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("WARNING");
      expect(run.stderr).toContain(
        "does not have the tables holding the lab's records",
      );
      expect(run.stderr).not.toContain("BLOCKED");
      expect(run.stderr).not.toContain("refusing to continue");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a development run non-blocking when the recorded development fingerprint is stale",
    () => {
      // The same mismatch that blocks production is only a warning here: the
      // development fingerprint exists to recognise a production copy, and a
      // stale one must never stop post-merge work.
      const run = runGate({
        command: DEVELOPMENT_COMMAND,
        database: {
          fingerprintRow: probeRow(committedDevelopment, {
            oldest_case_created_at: "2026-09-30T08:07:06.054321Z",
          }),
        },
      });

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("WARNING");
      expect(run.stderr).toContain("the development oldest case created_at is");
      expect(run.stderr).toContain("record-data-fingerprint");
      expect(run.stderr).not.toContain("BLOCKED");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("production build orchestration", () => {
  it(
    "stops the production build chain before API compilation when migration screening blocks",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "publish-build-schema-diff-"));
      stagedDirs.push(dir);
      const diffPath = join(dir, "proposed.sql");
      await writeFile(diffPath, "DROP TABLE public.invoices;\n", "utf8");
      const buildWorkspace = await stageProductionBuildWorkspace(diffPath);

      // The disposable workspace uses the same checked-in build-chain command
      // and real preflight scripts, but only synthetic integrity manifests and
      // a scripted database. It cannot read private manifests or connect to a
      // production/shared database.
      const result = spawnSync("pnpm", ["run", "build:api-production"], {
        cwd: buildWorkspace,
        env: {
          ...process.env,
          DATABASE_URL: "postgres://publish-gate.invalid/production",
          SCHEMA_COLUMN_CHECK_TARGET: "",
          SCHEMA_COLUMN_CHECK_ALLOW_MISSING: "",
          PUBLISH_SCHEMA_DIFF_PATH: diffPath,
          PUBLISH_GATE_STUB_DATABASE: JSON.stringify({
            fingerprintRow: probeRow(committedProduction),
            labExists: true,
          }),
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import ${pathToFileURL(
              resolve(
                buildWorkspace,
                "scripts",
                "src",
                "__tests__",
                "fixtures",
                "register-stub-database.mjs",
              ),
            ).href}`,
          ]
            .filter(Boolean)
            .join(" "),
        },
        encoding: "utf8",
        timeout: TEST_TIMEOUT_MS,
      });
      if (result.error) throw result.error;

      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, combined).toBe(1);
      expect(combined).toContain("[publish-safety] BLOCKED");
      expect(combined).not.toContain("API_BUILD_REACHED");
    },
    TEST_TIMEOUT_MS + 10_000,
  );
});
