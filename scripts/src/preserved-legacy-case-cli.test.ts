import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSyntheticPreservedCaseManifest } from "./__tests__/fixtures/synthetic-preserved-case-manifest";

const sourceDir = import.meta.dirname;
const workspace = resolve(sourceDir, "../..");
const staging = mkdtempSync(resolve(tmpdir(), "preserved-case-cli-"));
symlinkSync(resolve(sourceDir, "../node_modules"), resolve(staging, "node_modules"));
const entry = resolve(staging, "preflight.mjs");
const syntheticScriptsRoot = resolve(staging, "scripts");
const syntheticSourceDir = resolve(syntheticScriptsRoot, "src");

// Use the same existing bundler as the production API build. Only the
// external database is replaced; the checker and every comparison stay real.
const { build } = createRequire(
  resolve(workspace, "artifacts/api-server/package.json"),
)("esbuild");

beforeAll(async () => {
  mkdirSync(syntheticSourceDir, { recursive: true });
  writeFileSync(
    resolve(syntheticScriptsRoot, "database-fingerprint.json"),
    readFileSync(
      resolve(sourceDir, "fixtures/synthetic-database-fingerprint.json"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(syntheticScriptsRoot, "preserved-legacy-case-fingerprints.json"),
    JSON.stringify(createSyntheticPreservedCaseManifest()),
  );

  const stub = `
import { INFORMATION_SCHEMA_COLUMNS_SQL, getDeclaredSchemaColumns } from ${JSON.stringify(resolve(sourceDir, "schema-column-drift.ts"))};
import { CASE_ORGANIZATION_ROWS_SQL, CASE_ORGANIZATION_CONSTRAINTS_SQL } from "@workspace/db/case-organization-integrity";
import { LAB_DATA_FINGERPRINT_SQL, DATA_FINGERPRINT_SQL, FINGERPRINT_COUNTS, loadExpectedDataFingerprints } from ${JSON.stringify(resolve(sourceDir, "data-fingerprint.ts"))};
import { PRESERVED_LEGACY_CASES_SQL } from ${JSON.stringify(resolve(sourceDir, "preserved-legacy-case-check.ts"))};
const mode = process.env.PREFLIGHT_TEST_CASE;
export const pool = {
  async query(sql, values) {
    if (sql === INFORMATION_SCHEMA_COLUMNS_SQL) {
      return { rows: getDeclaredSchemaColumns()
        .filter(c => !(c.tableName === "backup_runs" && c.columnName === "archive_kind"))
        .map(c => ({ table_schema:c.tableSchema, table_name:c.tableName, column_name:c.columnName })) };
    }
    if (sql === CASE_ORGANIZATION_ROWS_SQL) {
      const repaired = mode === "changed-repaired";
      return { rows:[{total_cases:"1943", missing_lab:repaired?"0":"297",
        missing_practice:repaired?"0":"297", affected_total:repaired?"0":"297",
        affected_active:repaired?"0":"296"}] };
    }
    if (sql === CASE_ORGANIZATION_CONSTRAINTS_SQL) return { rows:[] };
    if (sql === PRESERVED_LEGACY_CASES_SQL) {
      if (process.env.SCHEMA_COLUMN_CHECK_TARGET !== "production") {
        throw new Error("HARNESS_ERROR: production exception used outside production");
      }
      const syntheticCases = JSON.parse(values[0]);
      if (syntheticCases.length !== 297 ||
          !syntheticCases.every(row => row.id.startsWith("synthetic-case-")) ||
          !values[1].includes("lab_organization_id")) {
        throw new Error("HARNESS_ERROR: missing committed exception parameters");
      }
      return { rows:[{expected_count:"297",
        present_count:mode==="missing"?"296":"297",
        matching_count:["missing","changed","changed-repaired"].includes(mode)?"296":"297",
        unexpected_count:mode==="unexpected"?"1":"0"}] };
    }
    if (sql === LAB_DATA_FINGERPRINT_SQL || sql === DATA_FINGERPRINT_SQL) {
      const expected = loadExpectedDataFingerprints()[process.env.SCHEMA_COLUMN_CHECK_TARGET];
      const row = { lab_exists:true, oldest_case_created_at:mode==="identity"
        ?"2000-01-01T00:00:00.000001Z":expected.oldestCaseCreatedAt };
      for (const count of FINGERPRINT_COUNTS) row[count.column] = String(expected[count.field]);
      return {rows:[row]};
    }
    throw new Error("HARNESS_ERROR: unrecognized database query");
  },
  async end() {},
};
`;
  await build({
    entryPoints: [resolve(sourceDir, "check-schema-columns.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
    define: { "import.meta.dirname": JSON.stringify(syntheticSourceDir) },
    plugins: [{
      name: "test-database-only",
      setup(builder: {
        onResolve: (options: object, callback: () => object) => void;
        onLoad: (options: object, callback: () => object) => void;
      }) {
        builder.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: "database-stub", namespace: "test-database",
        }));
        builder.onLoad({ filter: /.*/, namespace: "test-database" }, () => ({
          contents: stub, loader: "ts", resolveDir: sourceDir,
        }));
      },
    }],
  });
});

afterAll(() => rmSync(staging, { recursive: true, force: true }));

function run(mode: string, target = "production") {
  const child = spawnSync(process.execPath, ["--import", "tsx", entry], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://unused.invalid/no-real-connection",
      SCHEMA_COLUMN_CHECK_TARGET: target,
      SCHEMA_COLUMN_CHECK_ALLOW_MISSING: "1",
      PREFLIGHT_TEST_CASE: mode,
    },
  });
  const output = `${child.stdout}${child.stderr}`;
  expect(child.error, output).toBeUndefined();
  expect(output).not.toContain("HARNESS_ERROR");
  expect(output).not.toContain("ECONNREFUSED");
  expect(output).not.toContain("ENOTFOUND");
  return { status: child.status, output };
}

describe("real production preflight process", () => {
  it("exits zero only with the unchanged cohort and correct production identity", () => {
    const result = run("unchanged");
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("297/297 unchanged");
    expect(result.output).toContain("publishing-only legacy exception");
    expect(result.output).toContain("matches the fingerprint committed");
  }, 20_000);

  it.each([
    ["unexpected", "outside the committed legacy exception"],
    ["changed", "changed from the approved archive"],
    ["changed-repaired", "changed from the approved archive"],
    ["missing", "missing from live tables"],
    ["identity", "refusing to continue"],
  ])("exits nonzero for %s", (mode, message) => {
    const result = run(mode);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(message);
  }, 20_000);

  it("does not apply the publishing exception to development checks", () => {
    const result = run("unchanged", "development");
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("publishing-only legacy exception");
    expect(result.output).toContain("case ownership findings are advisory during setup");
  }, 20_000);
});
