#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
// This is distinct from the remote-operation lock: the release process invokes
// this helper while holding that lock. Serialize read/modify/write status calls
// too, so concurrent check records cannot erase a just-accepted upload receipt.
if (process.env.LABTRAX_IOS_RELEASE_STATE_LOCK_HELD !== "1") {
  mkdirSync(resolve(root, ".local"), { recursive: true, mode: 0o700 });
  const result = spawnSync("flock", ["-w", "30", resolve(root, ".local/.eas-ios-state.lock"),
    process.execPath, process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, LABTRAX_IOS_RELEASE_STATE_LOCK_HELD: "1" },
  });
  if (result.error) console.error("Could not acquire the iOS release-state lock.");
  process.exit(result.status ?? 1);
}
const statePath = resolve(root, ".local/.eas-ios-release-state.json");
const appPath = resolve(root, "artifacts/labtrax/app.json");
const requiredChecks = [
  ["test-harness", "Test harness collection"],
  ["typecheck", "Workspace typecheck"],
  ["api-tests", "API integration tests"],
  ["desktop-tests", "Desktop tests"],
  ["mobile-tests", "Mobile tests"],
  ["scripts-tests", "Scripts tests"],
  ["backup-restore", "Backup/restore integrity"],
  ["legacy-path-fence", "Mobile legacy-path fence"],
  ["protected-tables", "Protected-tables lint"],
];
const optionalChecks = [
  ["desktop-signing", "Desktop signing build (not needed for iOS)"],
  ["desktop-latest-yml", "Desktop auto-update feed (not needed for iOS)"],
];
const allowedStatuses = new Set(["pass", "skip", "fail", "blocked"]);
const validBuildId = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function identity() {
  const app = JSON.parse(readFileSync(appPath, "utf8"));
  const buildNumber = String(app.expo?.ios?.buildNumber ?? "");
  const version = String(app.expo?.version ?? "");
  if (!version || !/^\d+$/.test(buildNumber)) {
    throw new Error("app.json must contain expo.version and an integer expo.ios.buildNumber.");
  }
  const sourceHash = createHash("sha256");
  sourceHash.update(execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8").split("\0").filter(Boolean).sort();
  for (const file of untracked) {
    sourceHash.update(file);
    sourceHash.update("\0");
    sourceHash.update(readFileSync(resolve(root, file)));
  }
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    version,
    buildNumber,
    sourceHash: sourceHash.digest("hex"),
  };
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { checks: {}, deviceChecklist: null, latestBuild: null };
  }
}

function saveState(state) {
  mkdirSync(resolve(root, ".local"), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporaryPath, statePath);
  const directory = openSync(resolve(root, ".local"), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function currentState() {
  const actual = identity();
  const saved = readState();
  const snapshotMatches = saved.snapshot?.commit === actual.commit &&
    saved.snapshot?.version === actual.version &&
    saved.snapshot?.buildNumber === actual.buildNumber &&
    saved.snapshot?.sourceHash === actual.sourceHash;
  return {
    actual,
    state: saved,
    snapshotMatches,
    checks: snapshotMatches ? saved.checks ?? {} : {},
    deviceChecklist: snapshotMatches ? saved.deviceChecklist ?? null : null,
  };
}

function setCheck(name, status) {
  const check = [...requiredChecks, ...optionalChecks].find(([key]) => key === name);
  if (!check) throw new Error(`Unknown release check "${name}". Use one of: ${[...requiredChecks, ...optionalChecks].map(([key]) => key).join(", ")}.`);
  if (!allowedStatuses.has(status)) throw new Error("Status must be pass, skip, fail, or blocked.");
  const { actual, state, snapshotMatches } = currentState();
  if (!snapshotMatches) {
    state.checks = {};
    state.deviceChecklist = null;
  }
  state.snapshot = actual;
  state.checks ??= {};
  state.checks[name] = { status, recordedAt: new Date().toISOString() };
  saveState(state);
  console.log(`Recorded ${status.toUpperCase()} for ${check[1]} at ${actual.commit.slice(0, 12)}.`);
}

function confirmDeviceChecklist(buildId) {
  if (!validBuildId.test(buildId ?? "")) throw new Error("Provide the exact EAS build ID that passed the physical-device checklist.");
  const { actual, state, snapshotMatches } = currentState();
  if (state.latestBuild?.id !== buildId || state.latestBuild.uploadStatus !== "uploaded to App Store Connect") {
    throw new Error("Confirm the physical-device checklist after distribution of the exact latest uploaded build.");
  }
  if (!snapshotMatches) state.checks = {};
  state.snapshot = actual;
  state.deviceChecklist = {
    status: "pass",
    testedBuildId: buildId,
    recordedAt: new Date().toISOString(),
  };
  saveState(state);
  console.log(`Recorded device-checklist confirmation for build ${buildId} at ${actual.commit.slice(0, 12)}.`);
}

function updateLatestBuild(args) {
  const [buildId, version, buildNumber] = args;
  if (!validBuildId.test(buildId ?? "") || !version || !/^\d+$/.test(buildNumber ?? "")) {
    throw new Error("Build identity must include a valid EAS build ID, app version, and integer build number.");
  }
  const state = readState();
  if (state.latestBuild?.id === buildId) {
    if (state.latestBuild.version !== version || state.latestBuild.buildNumber !== buildNumber) {
      throw new Error("Previously recorded artifact identity changed.");
    }
    return;
  }
  state.latestBuild = {
    id: buildId,
    version,
    buildNumber,
    builtAt: new Date().toISOString(),
    uploadStatus: "not uploaded",
    appleProcessing: "not submitted",
    testerAvailability: "not confirmed",
  };
  saveState(state);
}

function markUploaded(buildId) {
  const state = readState();
  if (state.latestBuild?.id !== buildId) throw new Error("The uploaded build ID does not match the recorded latest build.");
  state.latestBuild.uploadStatus = "uploaded to App Store Connect";
  state.latestBuild.uploadedAt = new Date().toISOString();
  state.latestBuild.appleProcessing = "pending owner confirmation";
  state.latestBuild.testerAvailability = "not confirmed";
  saveState(state);
}

function recordAppleProcessing(buildId, status) {
  const state = readState();
  if (state.latestBuild?.id !== buildId) throw new Error("Build ID does not match the latest recorded release.");
  if (state.latestBuild.uploadStatus !== "uploaded to App Store Connect") throw new Error("Upload has not been confirmed.");
  if (!["processing", "processed", "failed"].includes(status)) {
    throw new Error("Apple processing status must be processing, processed, or failed.");
  }
  state.latestBuild.appleProcessing = status;
  state.latestBuild.appleProcessingConfirmedAt = new Date().toISOString();
  saveState(state);
}

function recordAvailability(buildId, status) {
  const state = readState();
  if (state.latestBuild?.id !== buildId) throw new Error("Build ID does not match the latest recorded release.");
  if (state.latestBuild.uploadStatus !== "uploaded to App Store Connect" ||
      state.latestBuild.appleProcessing !== "processed") throw new Error("Confirm upload and Apple processing first.");
  if (!["available", "unavailable"].includes(status)) {
    throw new Error("TestFlight availability must be available or unavailable.");
  }
  state.latestBuild.testerAvailability = status;
  state.latestBuild.testerAvailabilityConfirmedAt = new Date().toISOString();
  saveState(state);
}

function summary({ lock = "pass", approval = "blocked", retry = "pass" } = {}) {
  const { actual, state, snapshotMatches, checks, deviceChecklist } = currentState();
  const nextBuildNumber = String(Number(actual.buildNumber) + 1);
  let ready = true;
  console.log(`\nLabTrax iOS preflight — ${actual.version} (${nextBuildNumber})`);
  let sourceNote = "";
  if (!snapshotMatches) {
    if (state.snapshot?.commit !== actual.commit) sourceNote = " (no gate record for this commit)";
    else if (state.snapshot?.sourceHash !== actual.sourceHash) sourceNote = " (source/worktree edits since checks were recorded)";
    else sourceNote = " (app version/build identity changed since checks were recorded)";
  }
  console.log(`Source: ${actual.commit.slice(0, 12)}${sourceNote}`);
  const print = (status, label, note = "") => {
    console.log(`${status.toUpperCase().padEnd(7)} ${label}${note ? ` — ${note}` : ""}`);
    if (status !== "pass" && status !== "skip") ready = false;
  };
  for (const [key, label] of requiredChecks) {
    const saved = checks[key];
    print(saved?.status ?? "blocked", label, saved?.status ? `recorded for this source snapshot` : "run and record this required check");
    if (saved?.status !== "pass") ready = false;
  }
  for (const [key, label] of optionalChecks) {
    const saved = checks[key];
    print(saved?.status ?? "skip", label, saved?.status ? "recorded for this source snapshot" : "skipped for an iOS-only release");
  }
  console.log(deviceChecklist?.testedBuildId === state.latestBuild?.id && deviceChecklist?.status === "pass"
    ? `PASS    Physical-device checklist — exact distributed build ${deviceChecklist.testedBuildId}`
    : "DEFERRED Physical-device checklist — validate the exact artifact after distribution, not before building");
  print(lock, "Release lock", lock === "pass" ? "available" : "another release operation is active");
  let retryNote = "no unresolved upload retry";
  if (retry !== "pass") {
    let pendingBuildId = "";
    try { pendingBuildId = readFileSync(resolve(root, ".local/.eas-submit-build-id"), "utf8").trim(); } catch {}
    retryNote = pendingBuildId
      ? `pending retry for EAS build ${pendingBuildId}; reconcile before a new paid build`
      : "unresolved retry marker; reconcile before a new paid build";
  }
  print(retry, "Upload retry state", retryNote);
  print(approval, "One-shot build approval", approval === "pass" ? "present; explicit --run-approved is still required" : "not armed; explicit approval is still required");
  console.log(`NEXT BUILD: ${actual.version} (${nextBuildNumber})`);
  if (state.latestBuild) {
    const build = state.latestBuild;
    console.log(`LATEST BUILD: ${build.version} (${build.buildNumber}) — ${build.id}`);
    console.log(`UPLOAD: ${build.uploadStatus}`);
    console.log(`APPLE PROCESSING: ${build.appleProcessing}`);
    console.log(`TESTFLIGHT AVAILABILITY: ${build.testerAvailability}`);
  }
  console.log(ready ? "PREFLIGHT: READY" : "PREFLIGHT: BLOCKED");
  return ready;
}

function usage() {
  console.log(`Usage:
  bash scripts/eas-ios-build.sh --status
  bash scripts/eas-ios-build.sh --record-check <name> <pass|skip|fail|blocked>
  bash scripts/eas-ios-build.sh --confirm-device-checklist <tested-build-id>
  bash scripts/eas-ios-build.sh --record-apple-processing <build-id> <processing|processed|failed>
  bash scripts/eas-ios-build.sh --record-testflight-availability <build-id> <available|unavailable>`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "--record-check") setCheck(args[0], args[1]);
  else if (command === "--confirm-device-checklist") confirmDeviceChecklist(args[0]);
  else if (command === "--record-built") updateLatestBuild(args);
  else if (command === "--record-uploaded") markUploaded(args[0]);
  else if (command === "--record-apple-processing") recordAppleProcessing(args[0], args[1]);
  else if (command === "--record-testflight-availability") recordAvailability(args[0], args[1]);
  else if (command === "--summary") {
    const options = Object.fromEntries(args.map((arg) => {
      const [key, value] = arg.split("=", 2);
      return [key.replace(/^--/, ""), value];
    }));
    if (!summary(options)) process.exitCode = 2;
  } else {
    usage();
    process.exitCode = command ? 2 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
