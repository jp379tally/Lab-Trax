import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, compare, distribution, markdown, modes, mixes, profileFromEnv } from "./latency-report.mjs";

const profile = profileFromEnv({});
const environment = { runner: "test", nodeMajor: 24, postgresMajor: "16", platform: "linux", arch: "x64", cpuModel: "fixture", cpuCount: 4, memoryGiB: 16 };
function samples(value = 100) {
  return modes.flatMap((mode) => mixes.flatMap((mix) => Array.from({ length: profile.samples }, (_, i) => ({
    mode, mix, sample: i + 1, profile, overlapVerified: true,
    timings: { cold: Array(profile.concurrency).fill(value), warm: Array(profile.concurrency * profile.rounds).fill(value) },
    backgroundMs: value,
  }))));
}
function report(value = 100) { return aggregate(profile, samples(value), environment); }

test("nearest-rank percentiles are distributions without mutating raw observations", () => {
  const values = [4, 1, 3, 2];
  assert.deepEqual(distribution(values), { count: 4, min: 1, p50: 2, p95: 4, p99: 4, max: 4 });
  assert.deepEqual(values, [4, 1, 3, 2]);
  for (const invalid of [[], [NaN], [-1], [Infinity]]) assert.throws(() => distribution(invalid));
});
test("profile defaults are larger synthetic inventories and all parameters are bounded", () => {
  assert.equal(profile.mediaFiles * profile.mediaFileBytes, 1024 ** 3);
  assert.equal(profile.cases, 5000);
  for (const key of ["MEDIA_FILES", "MEDIA_MIB", "DUMP_ROWS", "CASES", "CONCURRENCY", "ROUNDS", "SAMPLES"]) {
    for (const value of ["0", "-1", "1.5", "abc", "1000000"]) {
      assert.throws(() => profileFromEnv({ [`LABTRAX_LATENCY_${key}`]: value }));
    }
  }
});
test("all mode/mix/process observations and actual background overlap are mandatory", () => {
  const data = samples();
  assert.equal(Object.keys(report().metrics).length, 24);
  assert.throws(() => aggregate(profile, data.slice(1), environment), /Incomplete/);
  assert.throws(() => aggregate(profile, [...data, data[0]], environment), /Duplicate/);
  assert.throws(() => aggregate(profile, data.map((s) => ({ ...s, overlapVerified: false })), environment), /overlap/);
  const short = samples(); short[0].timings.warm.pop();
  assert.throws(() => aggregate(profile, short, environment), /Incomplete/);
});
test("normal variation passes; sustained dual-threshold deterioration flags regressions", () => {
  const base = report();
  assert.equal(compare(report(120), base).status, "pass");
  assert.equal(compare(report(135), base).status, "regression");
  assert.equal(compare(report(24), report(1)).status, "pass"); // Relative alone insufficient.
  assert.equal(compare(report(1026), report(1000)).status, "pass"); // Absolute alone insufficient.
  assert.equal(compare(report(130), base).status, "pass"); // Strict threshold.
});
test("one or two bad runs cannot trigger a regression", () => {
  const current = report();
  for (const metric of Object.values(current.metrics)) {
    metric.sampleP50 = [500, 500, 100, 100, 100];
    metric.sampleP95 = [500, 500, 100, 100, 100];
  }
  assert.equal(compare(current, report()).status, "pass");
  for (const metric of Object.values(current.metrics)) metric.sampleP95 = [500, 500, 500, 100, 100];
  assert.equal(compare(current, report()).status, "pass"); // Majority alone insufficient.
  for (const metric of Object.values(current.metrics)) metric.sampleP95 = [500, 500, 500, 500, 100];
  assert.equal(compare(current, report()).status, "regression");
});
test("missing, changed or insufficient baselines never silently pass", () => {
  const current = report();
  assert.equal(compare(current, null).status, "missing-baseline");
  const base = report(); base.profile = { ...profile, cases: 100 };
  assert.equal(compare(current, base).status, "incompatible-baseline");
  const changed = report(); changed.environment = { ...environment, cpuCount: 2 };
  assert.equal(compare(current, changed).status, "incompatible-baseline");
  const small = report(); small.profile = { ...profile, samples: 2 };
  assert.equal(compare(small, structuredClone(small)).status, "insufficient-samples");
  const broken = report(); delete broken.metrics["idle/cold/worklist"];
  assert.throws(() => compare(current, broken), /Invalid baseline/);
});
test("readable reports identify policy, synthetic inventory and regressions", () => {
  const current = report(200); current.comparison = compare(current, report());
  assert.match(markdown(current), /regression/);
  assert.match(markdown(current), /not production recovery/);
  assert.match(markdown(current), /80%/);
});
test("real collector gates on comparison, retains diagnostics and never overwrites a baseline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "latency-report-test-"));
  try {
    await writeFile(path.join(dir, "profile.json"), JSON.stringify(profile));
    for (const sample of samples(200)) {
      await writeFile(path.join(dir, `sample-${sample.sample}-${sample.mode}-${sample.mix}.json`), JSON.stringify(sample));
    }
    const cli = fileURLToPath(new URL("./latency-report.mjs", import.meta.url));
    const env = { LABTRAX_LATENCY_REPORT_DIR: dir };
    const run = (extra = {}) => spawnSync(process.execPath, [cli, "collect"], { env: { ...env, ...extra }, encoding: "utf8" });
    assert.equal(run().status, 3);
    const current = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
    assert.equal(current.comparison.status, "missing-baseline");
    assert.equal(run({ LABTRAX_LATENCY_APPROVE_BASELINE: "1" }).status, 0);
    const base = structuredClone(current);
    for (const metric of Object.values(base.metrics)) {
      metric.sampleP50.fill(100); metric.sampleP95.fill(100);
    }
    const baselinePath = path.join(dir, "approved.json");
    const baselineBytes = JSON.stringify(base);
    await writeFile(baselinePath, baselineBytes);
    assert.equal(run({ LABTRAX_LATENCY_BASELINE: baselinePath }).status, 2);
    assert.equal(await readFile(baselinePath, "utf8"), baselineBytes);
    assert.match(await readFile(path.join(dir, "report.md"), "utf8"), /regression/);
    await writeFile(baselinePath, JSON.stringify(current));
    assert.equal(run({ LABTRAX_LATENCY_BASELINE: baselinePath }).status, 0);
    await rm(path.join(dir, "sample-1-idle-notifications.json"));
    assert.notEqual(run({ LABTRAX_LATENCY_APPROVE_BASELINE: "1" }).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("scheduled job has no shared database service or production credentials; runner never dumps a source schema", async () => {
  const runner = await readFile(new URL("./run-isolated-interactive-latency.sh", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/interactive-backup-performance.yml", import.meta.url), "utf8");
  const suite = await readFile(new URL("../artifacts/api-server/src/routes/interactive-latency.test.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /--schema-only|pg_restore/);
  assert.match(runner, /latency_probe\?sslmode=verify-full/);
  assert.match(runner, /trap cleanup EXIT/);
  assert.match(runner, /VACUUM ANALYZE/);
  assert.doesNotMatch(workflow, /secrets\.|DATABASE_URL:|services:/);
  assert.match(workflow, /cron:/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(suite, /"--dbname", process.env.DATABASE_URL!/);
  assert.match(suite, /"--no-sync", "--file=\/dev\/null"/);
  assert.doesNotMatch(suite, /PGDATABASE: process.env.DATABASE_URL/);
});
