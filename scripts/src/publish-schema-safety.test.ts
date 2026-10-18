import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectSchemaDiff } from "./publish-schema-safety";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPTS_DIR = resolve(REPO_ROOT, "scripts");
const TSX = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const CHECKER = resolve(SCRIPTS_DIR, "src", "publish-schema-safety.ts");
const tempDirs: string[] = [];

async function makeDiff(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "publish-schema-diff-"));
  tempDirs.push(dir);
  const file = join(dir, "proposed.sql");
  await writeFile(file, contents, "utf8");
  return file;
}

function runChecker(diffPath?: string) {
  const env = { ...process.env, PUBLISH_SCHEMA_DIFF_PATH: diffPath ?? "" };
  return spawnSync(TSX, [CHECKER], {
    cwd: SCRIPTS_DIR,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("publish schema safety gate", () => {
  it("reports unverified instead of claiming safety when Replit supplies no pending diff", () => {
    const result = runChecker();
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("MIGRATION SAFETY UNVERIFIED");
    expect(result.stderr).toContain("recent, verified off-site production backup");
    expect(result.stderr).not.toContain("publish is safe");
  });

  it("permits a safe additive SQL fixture while preserving the manual-review warning", async () => {
    const diff = await makeDiff(`
      -- Adding storage is additive.
      ALTER TABLE public.cases ADD COLUMN review_note text;
      CREATE INDEX cases_review_note_idx ON public.cases (review_note);
    `);
    expect(inspectSchemaDiff("ALTER TABLE cases ADD COLUMN review_note text")).toEqual([]);
    const result = runChecker(diff);
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Static scan found no known destructive SQL patterns");
    expect(result.stdout).toContain("Migration safety is still not certified");
  });

  it.each([
    ["drop", "DROP TABLE public.cases;"],
    ["column drop", "ALTER TABLE public.cases DROP COLUMN case_number;"],
    ["truncate", "TRUNCATE TABLE public.invoices;"],
    ["lossy conversion", "ALTER TABLE public.cases ALTER COLUMN case_number TYPE integer USING case_number::integer;"],
    ["data rewrite", "UPDATE public.cases SET due_date = NULL;"],
    ["delete", "DELETE FROM public.case_attachments;"],
    ["development copy", "COPY public.cases FROM STDIN;"],
  ])("blocks %s operations in a proposed migration diff", async (_label, sql) => {
    const diff = await makeDiff(sql);
    const result = runChecker(diff);
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[publish-safety] BLOCKED");
  }, 40_000);

  it("blocks when an explicitly supplied diff cannot be read", () => {
    const result = runChecker(join(tmpdir(), "missing-publish-diff.sql"));
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("proposed migration diff is unreadable");
  });

  it("places the screening gate in the failure-propagating production build chain", async () => {
    const rootPackage = await import("../../package.json", {
      with: { type: "json" },
    }) as { default: { scripts: Record<string, string> } };
    const build = rootPackage.default.scripts["build:api-production"];
    const steps = build.split(" && ");
    expect(steps).toContain(
      "pnpm --filter @workspace/scripts run check-publish-schema-safety",
    );
    expect(steps.indexOf("pnpm --filter @workspace/scripts run check-publish-schema-safety"))
      .toBeLessThan(steps.indexOf("pnpm --filter @workspace/api-server run build"));

    const diff = await makeDiff("DROP TABLE public.invoices;");
    const result = spawnSync(
      "bash",
      [
        "-c",
        "pnpm --filter @workspace/scripts run check-publish-schema-safety && printf BUILD_STEP_REACHED",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PUBLISH_SCHEMA_DIFF_PATH: diff },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[publish-safety] BLOCKED");
    expect(result.stdout).not.toContain("BUILD_STEP_REACHED");
  }, 70_000);
});
