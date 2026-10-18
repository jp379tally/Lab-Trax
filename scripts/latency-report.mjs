/**
 * Synthetic-only benchmark inventory and distribution reporting.
 * No database clients, credentials, network calls or baseline mutation.
 */
import { mkdir, readFile, writeFile, readdir, statfs } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { cpus, totalmem, platform, arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const mixes = ["notifications", "worklist", "mixed"];
export const modes = ["idle", "dump", "archive"];
export const phases = ["cold", "warm"];
export const policy = { relative: 0.30, absoluteMs: 25, affectedFraction: 0.8, minimumSamples: 5 };

function bounded(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function profileFromEnv(env = process.env) {
  return {
    version: 1,
    mediaFiles: bounded(env, "LABTRAX_LATENCY_MEDIA_FILES", 256, 1, 4096),
    mediaFileBytes: bounded(env, "LABTRAX_LATENCY_MEDIA_MIB", 4, 1, 16) * 1024 ** 2,
    dumpRows: bounded(env, "LABTRAX_LATENCY_DUMP_ROWS", 10000, 100, 100000),
    cases: bounded(env, "LABTRAX_LATENCY_CASES", 5000, 8, 50000),
    concurrency: bounded(env, "LABTRAX_LATENCY_CONCURRENCY", 12, 3, 64),
    rounds: bounded(env, "LABTRAX_LATENCY_ROUNDS", 10, 2, 100),
    samples: bounded(env, "LABTRAX_LATENCY_SAMPLES", 5, 2, 20),
    poolMax: 5,
    mixes, modes, phases,
    // Fixture setup opens DB connections. Cold refers to the first authenticated
    // endpoint burst in a fresh application, NOT the pool or OS page cache.
    coldDefinition: "fresh-app-process-first-authenticated-burst-per-mode-mix-sample",
    generator: "crypto-random-bytes-v1",
    dumpGenerator: "independent-md5-blocks-v1",
  };
}

export function distribution(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error("Missing or invalid latency observations");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, min: sorted[0], p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.at(-1) };
}

export function aggregate(profile, samples, environment) {
  const expected = new Set(modes.flatMap((mode) => mixes.flatMap((mix) =>
    Array.from({ length: profile.samples }, (_, i) => `${mode}:${mix}:${i + 1}`))));
  for (const sample of samples) {
    const key = `${sample.mode}:${sample.mix}:${sample.sample}`;
    if (!expected.delete(key)) throw new Error(`Duplicate or unexpected sample: ${key}`);
    if (JSON.stringify(sample.profile) !== JSON.stringify(profile)) throw new Error("Sample profile mismatch");
    if (sample.mode !== "idle" && sample.overlapVerified !== true) throw new Error("Background overlap not verified");
  }
  if (expected.size) throw new Error("Incomplete benchmark samples");
  const metrics = {};
  for (const mode of modes) {
    const group = samples.filter((s) => s.mode === mode);
    for (const phase of phases) {
      for (const mix of mixes) {
        const key = `${mode}/${phase}/${mix}`;
        const observations = group.filter((s) => s.mix === mix).map((s) => s.timings?.[phase]);
        const count = profile.concurrency * (phase === "cold" ? 1 : profile.rounds);
        if (observations.some((v) => !Array.isArray(v) || v.length !== count)) {
          throw new Error(`Incomplete observations: ${key}`);
        }
        const distributions = observations.map(distribution);
        metrics[key] = {
          pooled: distribution(observations.flat()),
          sampleP50: distributions.map((d) => d.p50),
          sampleP95: distributions.map((d) => d.p95),
        };
      }
    }
    if (mode !== "idle") {
      for (const mix of mixes) {
        const times = group.filter((s) => s.mix === mix).map((s) => s.backgroundMs);
        metrics[`${mode}/${mix}/duration`] = {
          pooled: distribution(times), sampleP50: times, sampleP95: times,
        };
      }
    }
  }
  return { version: 1, generatedAt: new Date().toISOString(), profile, environment, policy, metrics, samples };
}

function compatible(current, baseline) {
  if (baseline.version !== 1 || JSON.stringify(baseline.profile) !== JSON.stringify(current.profile)) return false;
  return ["runner", "nodeMajor", "postgresMajor", "platform", "arch", "cpuModel", "cpuCount", "memoryGiB"]
    .every((key) => current.environment[key] === baseline.environment?.[key]);
}

export function compare(current, baseline) {
  if (!baseline) return { status: "missing-baseline", regressions: [], reason: "An explicitly approved baseline is required." };
  if (!compatible(current, baseline)) return { status: "incompatible-baseline", regressions: [], reason: "Workload or runner changed; approve a new baseline." };
  if (current.profile.samples < policy.minimumSamples) return { status: "insufficient-samples", regressions: [] };
  const regressions = [];
  for (const [key, metric] of Object.entries(current.metrics)) {
    for (const percentile of ["sampleP50", "sampleP95"]) {
      const previous = baseline.metrics?.[key]?.[percentile];
      if (!Array.isArray(previous) || previous.length !== current.profile.samples) throw new Error(`Invalid baseline metric: ${key}`);
      const base = distribution(previous).p50;
      const next = distribution(metric[percentile]).p50;
      const delta = Math.max(policy.absoluteMs, base * policy.relative);
      const affected = metric[percentile].filter((v) => v > base + delta).length;
      if (next > base + delta && affected >= Math.ceil(current.profile.samples * policy.affectedFraction)) {
        regressions.push({ key, percentile, baselineMs: base, currentMs: next, affected, requiredDeltaMs: delta });
      }
    }
  }
  return { status: regressions.length ? "regression" : "pass", regressions };
}

export function markdown(report) {
  const lines = [
    "# Isolated synthetic backup performance",
    `Result: **${report.comparison.status}**`,
    "Synthetic data only. This is not production recovery or off-site backup evidence.",
    `Inventory: ${report.profile.mediaFiles} files × ${report.profile.mediaFileBytes / 1024 ** 2} MiB; ${report.profile.cases} cases; ${report.profile.dumpRows} dump padding rows.`,
    `Samples: ${report.profile.samples} fresh processes per background mode and request mix; concurrency ${report.profile.concurrency}; ${report.profile.rounds} warm rounds.`,
    "Cold means first authenticated endpoint burst in a fresh application, not pool/disk-cache cold. All request timings are caller wall time in milliseconds.",
    "Regression rule: median per-process p50 or p95 worsens by both >30% and >25 ms, with at least 80% of processes exceeding that threshold. Minimum five processes.",
    "",
    "| Mode / phase / mix | Requests | p50 | p95 | p99 | max |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(report.metrics).map(([key, { pooled: d }]) =>
      `| ${key} | ${d.count} | ${d.p50.toFixed(1)} | ${d.p95.toFixed(1)} | ${d.p99.toFixed(1)} | ${d.max.toFixed(1)} |`),
    "",
    ...report.comparison.regressions.map((r) => `- **${r.key} ${r.percentile}**: ${r.baselineMs.toFixed(1)} → ${r.currentMs.toFixed(1)} ms (${r.affected} affected samples).`),
  ];
  if (report.comparison.reason) lines.push(report.comparison.reason);
  return `${lines.join("\n")}\n`;
}

async function prepare() {
  const root = process.env.LABTRAX_LATENCY_ROOT;
  const out = process.env.LABTRAX_LATENCY_REPORT_DIR;
  if (!root || !out) throw new Error("Disposable root and report directory are required");
  const profile = profileFromEnv();
  await mkdir(out, { recursive: true });
  // Never combine fresh observations with partial or previous runs.
  if ((await readdir(out)).some((f) => /^sample-/.test(f))) throw new Error("Use an empty report directory for each run");
  const disk = await statfs(root);
  const required = (profile.mediaFiles * profile.mediaFileBytes + profile.dumpRows * 65536) * 4 + 1024 ** 3;
  if (disk.bavail * disk.bsize < required) throw new Error("Insufficient disposable disk capacity for inventory and archives");
  await writeFile(path.join(out, "profile.json"), JSON.stringify(profile, null, 2));
  const media = path.join(root, "uploads", "case-media");
  await mkdir(media, { recursive: true });
  for (let i = 0; i < profile.mediaFiles; i++) {
    await writeFile(path.join(media, `nonclinical-${String(i).padStart(5, "0")}.bin`), randomBytes(profile.mediaFileBytes));
  }
}

async function collect() {
  const out = process.env.LABTRAX_LATENCY_REPORT_DIR;
  if (!out) throw new Error("Report directory is required");
  const profile = JSON.parse(await readFile(path.join(out, "profile.json"), "utf8"));
  const files = (await readdir(out)).filter((f) => /^sample-.*\.json$/.test(f)).sort();
  const samples = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(out, f), "utf8"))));
  const environment = {
    runner: process.env.LABTRAX_LATENCY_RUNNER ?? "local",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    postgresMajor: process.env.LABTRAX_LATENCY_POSTGRES_MAJOR,
    platform: platform(), arch: arch(), cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3),
    commit: process.env.GITHUB_SHA ?? "local",
  };
  const report = aggregate(profile, samples, environment);
  const baselinePath = process.env.LABTRAX_LATENCY_BASELINE;
  const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, "utf8")) : null;
  report.comparison = compare(report, baseline);
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  const text = markdown(report);
  await writeFile(path.join(out, "report.md"), text);
  process.stdout.write(text);
  // Baseline promotion is explicit and performed by the workflow, never here.
  const approving = process.env.LABTRAX_LATENCY_APPROVE_BASELINE === "1";
  if (!approving && report.comparison.status !== "pass") process.exitCode = report.comparison.status === "regression" ? 2 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "prepare") await prepare();
  else if (command === "collect") await collect();
  else throw new Error("Expected prepare or collect");
}
