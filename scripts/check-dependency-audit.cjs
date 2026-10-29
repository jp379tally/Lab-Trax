const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ACCEPTED_SOURCE_PATCH = {
  advisoryId: "GHSA-86w9-cpqp-85rv",
  packageName: "node-forge",
  packageVersion: "1.4.0",
  regressionName: "node-forge rejects extra DigestAlgorithm elements and invalid NULL parameters",
};

const ACCEPTED_DEEPMERGE_PATCH = {
  advisoryId: "GHSA-gcqx-w48m-w2h4", packageName: "deepmerge", packageVersion: "4.3.1",
  regressionName: "deepmerge preserves own data keys without poisoning result prototypes",
};

function evaluateAuditReport(report, evidence) {
  const advisories = Object.values(report?.advisories ?? {});
  if (advisories.length === 0) return { ok: true, accepted: [], rejected: [] };

  const accepted = [];
  const rejected = [];
  for (const advisory of advisories) {
    const findings = advisory.findings ?? [];
    const policy = advisory.github_advisory_id === ACCEPTED_DEEPMERGE_PATCH.advisoryId
      ? ACCEPTED_DEEPMERGE_PATCH : ACCEPTED_SOURCE_PATCH;
    const isForge = policy === ACCEPTED_SOURCE_PATCH;
    const patch = isForge ? evidence.patch : evidence.deepmergePatch;
    const isVerifiedSourcePatch =
      advisory.github_advisory_id === policy.advisoryId &&
      advisory.module_name === policy.packageName &&
      advisory.severity === (isForge ? "high" : "low") &&
      advisory.vulnerable_versions === (isForge ? "<=1.4.0" : ">=4.2.0 <=4.3.1") &&
      advisory.patched_versions === "<0.0.0" && findings.length > 0 &&
      findings.every(finding => finding.version === policy.packageVersion) &&
      evidence.workspace.includes(`${policy.packageName}@${policy.packageVersion}: patches/${policy.packageName}@${policy.packageVersion}.patch`) &&
      evidence.lockfile.includes(`${policy.packageName}@${policy.packageVersion}(patch_hash=`) &&
      typeof patch === "string" && patch.trim().length > 0 &&
      evidence.regressions.includes(policy.regressionName);

    if (isVerifiedSourcePatch) accepted.push(advisory);
    else rejected.push(advisory);
  }
  return { ok: rejected.length === 0, accepted, rejected };
}

function auditCommandCompleted(result, report) {
  if (result.error || result.signal || ![0, 1].includes(result.status) ||
    result.stderr?.trim() || report?.error || report?.errors) return false;
  if (!report?.advisories || typeof report.advisories !== "object" ||
    Array.isArray(report.advisories) || !Array.isArray(report.actions)) return false;
  const counts = report.metadata?.vulnerabilities;
  const severities = ["info", "low", "moderate", "high", "critical"];
  if (!counts || !severities.every(level =>
    Number.isInteger(counts[level]) && counts[level] >= 0)) return false;
  const advisories = Object.values(report.advisories);
  const total = severities.reduce((sum, level) => sum + counts[level], 0);
  return result.status === (total > 0 ? 1 : 0) &&
    (advisories.length > 0 ? total >= advisories.length : total === 0) &&
    advisories.every(advisory => counts[advisory.severity] > 0);
}

function main() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["audit", "--audit-level=low", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  let report;
  try {
    report = JSON.parse(result.stdout ?? "");
  } catch {
    process.stderr.write(result.stderr || "pnpm audit did not return valid JSON.\n");
    process.exit(result.status || 1);
  }
  if (!auditCommandCompleted(result, report)) {
    console.error("pnpm audit failed or returned an incomplete report; no advisory exception was applied.");
    if (result.error) console.error(result.error.message);
    if (result.stderr?.trim()) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }

  const evidence = {
    workspace: readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"),
    lockfile: readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8"),
    patch: readFileSync(
      path.join(ROOT, "patches/node-forge@1.4.0.patch"),
      "utf8",
    ),
    regressions: readFileSync(
      path.join(ROOT, "scripts/security-dependencies.test.cjs"),
      "utf8",
    ),
  };
  evidence.deepmergePatch = readFileSync(path.join(ROOT, "patches/deepmerge@4.3.1.patch"), "utf8");
  const decision = evaluateAuditReport(report, evidence);

  for (const advisory of decision.accepted) {
    console.warn(
      `SOURCE-PATCHED ADVISORY (not an upstream fixed release): ${advisory.github_advisory_id} ${advisory.module_name}@${advisory.findings[0].version}. ` +
      "The locked source patch and its dependency-security regression are required; the audit finding remains visible here.",
    );
  }
  if (!decision.ok || result.error || (result.status !== 0 && decision.accepted.length === 0)) {
    for (const advisory of decision.rejected) {
      console.error(
        `Unaccepted dependency advisory: ${advisory.github_advisory_id ?? advisory.id} ` +
        `${advisory.module_name ?? "unknown package"} (${advisory.severity ?? "unknown severity"}).`,
      );
    }
    if (result.error) console.error(result.error.message);
    if (result.stderr?.trim()) process.stderr.write(result.stderr);
    if (result.status !== 0 && decision.accepted.length === 0) {
      console.error("pnpm audit failed without a fully evidenced source-patched advisory.");
    }
    process.exit(result.status || 1);
  }
  console.log(
    decision.accepted.length === 0
      ? "Dependency audit passed with no advisories."
      : "Dependency audit passed with only the explicitly evidenced source-patched advisories above.",
  );
}

if (require.main === module) main();

module.exports = { evaluateAuditReport, auditCommandCompleted };
