import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const buildId = "11111111-2222-4333-8444-555555555555";
const projectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const artifactUrl = "https://expo.dev/artifacts/eas/test.ipa";
const source = resolve(import.meta.dirname, "../../eas-ios-build.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ios-release-test-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".local"));
  mkdirSync(join(root, "artifacts/labtrax/scripts"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(source, join(root, "scripts/eas-ios-build.sh"));
  copyFileSync(resolve(import.meta.dirname, "../../eas-ios-operation-state.mjs"), join(root, "scripts/eas-ios-operation-state.mjs"));
  copyFileSync(resolve(import.meta.dirname, "../../eas-ios-release-status.mjs"), join(root, "scripts/eas-ios-release-status.mjs"));
  copyFileSync(resolve(import.meta.dirname, "../../commit-ios-build-number.sh"), join(root, "scripts/commit-ios-build-number.sh"));
  copyFileSync(resolve(import.meta.dirname, "../../eas-ios-submit-only.sh"), join(root, "scripts/eas-ios-submit-only.sh"));
  const app = join(root, "artifacts/labtrax/app.json");
  writeFileSync(app, JSON.stringify({ expo: { version: "1.0.13", ios: { buildNumber: "333", bundleIdentifier: "invalid.synthetic.labtrax" }, name: "original", extra: { eas: { projectId } } } }) + "\n");
  // Runtime receipts and fake provider logs are not source inputs.
  writeFileSync(join(root, ".gitignore"), ".local/\ncalls\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const log = join(root, "calls");
  const mock = (name: string, body: string) => writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  const realPython = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  mock("python3", `if [[ "\${1:-}" == - ]]; then exec "${realPython}" "$@"; fi\nexit "\${MOCK_KEY_FAIL:-0}"`);
  // Cleanup must never touch the workspace's real fixed credential path.
  const realRm = execFileSync("which", ["rm"], { encoding: "utf8" }).trim();
  const realNode = process.execPath;
  mock("node", `if [[ "\${MOCK_RECORD_UPLOAD_FAIL:-0}" == 1 && "\${2:-}" == --record-uploaded ]]; then exit 17; fi\nexec "${realNode}" "$@"`);
  mock("rm", `if [[ "\${2:-}" == /tmp/AuthKey_RV23AJ8V62.p8 ]]; then exit 0; fi\nexec "${realRm}" "$@"`);
  mock("pnpm", `node -e 'const fs=require("fs");const p="artifacts/labtrax/app.json";const c=JSON.parse(fs.readFileSync(p));c.expo.ios.buildNumber=String(Number(c.expo.ios.buildNumber)+1);fs.writeFileSync(p,JSON.stringify(c)+"\\n")'`);
  mock("eas", `echo "$*" >> "$MOCK_CALL_LOG"
if [[ "$1" == build ]]; then
  if [[ "\${MOCK_INVALID_JSON:-0}" == 1 ]]; then echo '[]'; else
    node -e 'console.log(JSON.stringify([{id:"${buildId}",platform:"IOS",status:"FINISHED",project:{id:"${projectId}"},distribution:"STORE",buildProfile:"production",appVersion:"1.0.13",appBuildVersion:process.env.MOCK_BUILD_NUMBER || "334"}]))'
  fi
  exit "\${MOCK_BUILD_FAIL:-0}"
fi
if [[ "$1" == build:view ]]; then
  node -e 'console.log(JSON.stringify({
    id:process.env.MOCK_VIEW_ID || "${buildId}",
    project:{id:process.env.MOCK_VIEW_PROJECT || "${projectId}"},
    platform:"IOS",status:"FINISHED",distribution:"STORE",buildProfile:"production",
    appVersion:"1.0.13",appBuildVersion:"334",
    artifacts:{buildUrl:process.env.MOCK_VIEW_URL || "${artifactUrl}"}
  }))'
  exit "\${MOCK_VIEW_FAIL:-0}"
fi
exit "\${MOCK_SUBMIT_FAIL:-0}"`);
  mock("curl", `echo "curl" >> "$MOCK_CALL_LOG"
if [[ -n "\${MOCK_IPA:-}" ]]; then
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == -o ]]; then cp "$MOCK_IPA" "$2"; exit 0; fi
    shift
  done
  exit 1
fi
for arg in "$@"; do
  # Simulate an HTTP 404: curl without -f still exits zero and saves HTML.
  if [[ "$arg" == -*f* ]]; then exit 22; fi
done
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == -o ]]; then printf '<html>expired</html>' > "$2"; break; fi
  shift
done
exit 0`);
  const run = (extra: Record<string, string> = {}, script = "eas-ios-build.sh",
    args = script === "eas-ios-build.sh" ? ["--run-approved"] : []) => spawnSync("bash", [`scripts/${script}`, ...args], {
    cwd: root,
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, MOCK_CALL_LOG: log, ...extra },
    encoding: "utf8",
  });
  const recordStatus = (args: string[]) => spawnSync("node", ["scripts/eas-ios-release-status.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  const preparePassedChecks = () => {
    const checks = [
      "test-harness", "typecheck", "api-tests", "desktop-tests", "mobile-tests",
      "scripts-tests", "backup-restore", "legacy-path-fence", "protected-tables",
    ];
    for (const check of checks) {
      const result = recordStatus(["--record-check", check, "pass"]);
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    }
  };
  const approve = () => {
    preparePassedChecks();
    writeFileSync(join(root, ".local/.eas-build-approved"), "");
  };
  const calls = () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
  const prepareUpload = () => writeFileSync(join(root, ".local/.eas-upload-attempt.json"),
    JSON.stringify({ buildId, status: "ready", preparedAt: "2026-01-01T00:00:00Z" }));
  return { root, app, run, approve, preparePassedChecks, recordStatus, calls, prepareUpload };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// These execute real Git and multiple serialized Node helpers in owned fixtures.
describe("iOS release approval and failure paths (fake tools, no network)", { timeout: 20_000 }, () => {
  it("does nothing and does not bump without approval", () => {
    const f = fixture();
    const before = readFileSync(f.app, "utf8");
    const result = f.run({}, "eas-ios-build.sh", []);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BLOCKED Test harness collection");
    expect(result.stdout).toContain("NEXT BUILD: 1.0.13 (334)");
    expect(readFileSync(f.app, "utf8")).toBe(before);
    expect(f.calls()).toBe("");
  });

  it("preserves approval but refuses a paid build when required check results are missing", () => {
    const f = fixture();
    writeFileSync(join(f.root, ".local/.eas-build-approved"), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("PREFLIGHT: BLOCKED");
    expect(result.stderr).toContain("approval retained");
    expect(f.calls()).toBe("");
    expect(readFileSync(join(f.root, ".local/.eas-build-approved"), "utf8")).toBe("");
    expect(f.run({}, "eas-ios-build.sh", []).stdout).toContain("OUTCOME: IDLE");
    expect(f.calls()).toBe("");
  });

  it("does not treat skipped required gates as passing", () => {
    const f = fixture();
    f.preparePassedChecks();
    expect(f.recordStatus(["--record-check", "api-tests", "skip"]).status).toBe(0);
    writeFileSync(join(f.root, ".local/.eas-build-approved"), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("SKIP    API integration tests");
    expect(result.stdout).toContain("PREFLIGHT: BLOCKED");
    expect(f.calls()).toBe("");
  });

  it("blocks stale check results after the source commit changes", () => {
    const f = fixture();
    f.approve();
    execFileSync("git", ["-C", f.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "new source"]);
    writeFileSync(join(f.root, ".local/.eas-build-approved"), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("no gate record for this commit");
    expect(f.calls()).toBe("");
  });

  it("blocks recorded passes after tracked or untracked source files change", () => {
    const f = fixture();
    f.approve();
    writeFileSync(join(f.root, "new-source.ts"), "export const changed = true;\n");
    writeFileSync(join(f.root, ".local/.eas-build-approved"), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("source/worktree edits since checks were recorded");
    expect(f.calls()).toBe("");
  });

  it("preserves dirty app configuration after a pre-build credential failure", () => {
    const f = fixture();
    const before = readFileSync(f.app, "utf8").replace("original", "uncommitted change");
    writeFileSync(f.app, before);
    f.approve();
    expect(f.run({ MOCK_KEY_FAIL: "7" }).status).not.toBe(0);
    expect(readFileSync(f.app, "utf8")).toBe(before);
    expect(f.calls()).toBe("");
    expect(readFileSync(join(f.root, ".local/.eas-build-approved"), "utf8")).toBe("");
    expect(f.run({}, "eas-ios-build.sh", []).stdout).toContain("OUTCOME: IDLE");
  });

  it("retains a reserved number when a remote build command has an ambiguous failure", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_BUILD_FAIL: "9" }).status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("334");
    expect(f.calls()).not.toContain("submit");
    expect(f.run({}, "eas-ios-build.sh", []).status).toBe(0); // automatic restart is idle
    expect(f.calls().trim().split("\n")).toHaveLength(1);
  });

  it("submits exactly the completed build, preserving its number if upload fails", () => {
    const f = fixture();
    f.approve();
    const result = f.run({ MOCK_SUBMIT_FAIL: "8" });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("334");
    expect(f.calls()).toContain(`submit --platform ios --profile production --id ${buildId}`);
    expect(f.calls()).not.toContain("--latest");
  });

  it("does not upload an HTTP error and retains submit-only retry metadata", () => {
    const f = fixture();
    f.prepareUpload();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "https://expo.dev/artifacts/eas/test.ipa");
    expect(f.run({ EXPO_TOKEN: "synthetic-test-token" }).status).not.toBe(0);
    expect(f.calls()).toBe(`build:view ${buildId} --json\ncurl\n`);
    expect(readFileSync(join(f.root, ".local/.eas-submit-build-id"), "utf8")).toBe(buildId);
    expect(readFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "utf8")).toContain("https://expo.dev/");
  });

  it("refuses to send the bearer credential to another artifact host", () => {
    const f = fixture();
    f.prepareUpload();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "https://unrelated.example/test.ipa");
    expect(f.run().status).not.toBe(0);
    expect(f.calls()).toBe(`build:view ${buildId} --json\n`);
  });

  it.each<{ label: string; env: Record<string, string> }>([
    { label: "different build ID", env: { MOCK_VIEW_ID: "99999999-2222-4333-8444-555555555555" } },
    { label: "different project", env: { MOCK_VIEW_PROJECT: "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee" } },
    { label: "stale IPA URL", env: { MOCK_VIEW_URL: "https://expo.dev/artifacts/eas/another.ipa" } },
    { label: "failed metadata lookup", env: { MOCK_VIEW_FAIL: "8" } },
  ])("refuses a $label before downloading or uploading", ({ env }) => {
    const f = fixture();
    f.prepareUpload();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), artifactUrl);
    expect(f.run(env).status).not.toBe(0);
    expect(f.calls()).toBe(`build:view ${buildId} --json\n`);
    expect(readFileSync(join(f.root, ".local/.eas-submit-build-id"), "utf8")).toBe(buildId);
    expect(readFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "utf8")).toBe(artifactUrl);
  });

  it.each(["matching", "different"])("does not replace a %s pending identity during standalone retry", (kind) => {
    const f = fixture();
    f.prepareUpload();
    const pendingId = kind === "matching" ? buildId : "99999999-2222-4333-8444-555555555555";
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), pendingId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), artifactUrl);
    const result = f.run({ EAS_SUBMIT_APPROVED: "1", EAS_BUILD_ID: buildId }, "eas-ios-submit-only.sh");
    // A saved artifact URL still requires validation/download; our fixture
    // returns HTTP 404. A conflicting identity blocks before any remote call.
    expect(result.status).not.toBe(0);
    for (const name of [".eas-submit-only", ".eas-submit-build-id", ".eas-submit-ipa-url"]) {
      expect(() => readFileSync(join(f.root, ".local", name))).not.toThrow();
    }
  });

  it("preserves matching pending state when the standalone upload fails", () => {
    const f = fixture();
    f.prepareUpload();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), artifactUrl);
    expect(f.run({ EAS_SUBMIT_APPROVED: "1", EAS_BUILD_ID: buildId, MOCK_SUBMIT_FAIL: "8" }, "eas-ios-submit-only.sh").status).not.toBe(0);
    expect(readFileSync(join(f.root, ".local/.eas-submit-build-id"), "utf8")).toBe(buildId);
    expect(readFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "utf8")).toBe(artifactUrl);
    expect(() => readFileSync(join(f.root, ".local/.eas-submit-only"))).not.toThrow();
  });

  it("retains the number and refuses submission if build output cannot identify success", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_INVALID_JSON: "1" }).status).not.toBe(0);
    expect(f.calls()).not.toContain("submit");
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("334");
  });

  it("records exact upload identity separately from Apple processing and TestFlight availability", () => {
    const f = fixture();
    f.approve();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Uploaded to App Store Connect: LabTrax 1.0.13 (334), EAS build ${buildId}.`);
    expect(result.stdout).toContain("Apple processing: pending owner confirmation");
    expect(result.stdout).toContain("TestFlight availability: not confirmed");
    expect(f.calls()).toContain("--non-interactive --wait");
    const statePath = join(f.root, ".local/.eas-ios-release-state.json");
    let state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.latestBuild).toMatchObject({
      id: buildId,
      version: "1.0.13",
      buildNumber: "334",
      uploadStatus: "uploaded to App Store Connect",
      appleProcessing: "pending owner confirmation",
      testerAvailability: "not confirmed",
    });

    const processing = f.recordStatus(["--record-apple-processing", buildId, "processed"]);
    expect(processing.status).toBe(0);
    const available = f.recordStatus(["--record-testflight-availability", buildId, "available"]);
    expect(available.status).toBe(0);
    state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.latestBuild.appleProcessing).toBe("processed");
    expect(state.latestBuild.testerAvailability).toBe("available");
    expect(f.run({}, "eas-ios-build.sh", []).stdout).toContain("TESTFLIGHT AVAILABILITY: available");
    expect(f.recordStatus(["--confirm-device-checklist", "99999999-2222-4333-8444-555555555555"]).status).not.toBe(0);
    expect(f.recordStatus(["--confirm-device-checklist", buildId]).status).toBe(0);
  }, 20_000);

  it("submit-only requires explicit approval and an exact build id", () => {
    const f = fixture();
    expect(f.run({}, "eas-ios-submit-only.sh").status).not.toBe(0);
    expect(f.run({ EAS_SUBMIT_APPROVED: "1" }, "eas-ios-submit-only.sh").status).not.toBe(0);
    expect(f.calls()).toBe("");
    f.prepareUpload();
    expect(f.run({ EAS_SUBMIT_APPROVED: "1", EAS_BUILD_ID: buildId }, "eas-ios-submit-only.sh").status).toBe(0);
    expect(f.calls()).toContain(`submit --platform ios --profile production --id ${buildId}`);
  });

  it("refuses a second approved release operation while the shared lock is held", () => {
    const f = fixture();
    f.approve();
    // The parent shell holds fd 8 while the child tries its own nonblocking fd.
    const result = spawnSync("bash", ["-c", 'exec 8>.local/.eas-ios-release.lock; flock 8; bash scripts/eas-ios-build.sh --run-approved'], {
      cwd: f.root, env: { PATH: `${join(f.root, "bin")}:${process.env.PATH}`, HOME: f.root }, encoding: "utf8",
    });
    expect(result.status).toBe(75);
    expect(f.calls()).toBe("");
    expect(readFileSync(join(f.root, ".local/.eas-build-approved"), "utf8")).toBe("");
  });

  it("refuses conflicting build and submit-only approvals without consuming either", () => {
    const f = fixture();
    f.approve();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    expect(f.run().status).not.toBe(0);
    expect(f.calls()).toBe("");
    expect(readFileSync(join(f.root, ".local/.eas-build-approved"), "utf8")).toBe("");
    expect(readFileSync(join(f.root, ".local/.eas-submit-only"), "utf8")).toBe("");
  });

  it("does not overwrite a pending upload retry with a newly paid build", () => {
    const f = fixture();
    f.approve();
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`BLOCKED Upload retry state — pending retry for EAS build ${buildId}`);
    expect(f.calls()).toBe("");
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("333");
    expect(readFileSync(join(f.root, ".local/.eas-submit-build-id"), "utf8")).toBe(buildId);
  });

  it("keeps an armed build idle on automatic restart even after preflight becomes ready", () => {
    const f = fixture();
    f.approve();
    expect(f.run({}, "eas-ios-build.sh", []).stdout).toContain("OUTCOME: IDLE");
    expect(f.calls()).toBe("");
    expect(readFileSync(join(f.root, ".local/.eas-build-approved"), "utf8")).toBe("");
  });

  it("does not turn an explicitly requested unapproved operation into successful idle", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("OUTCOME: BLOCKED");
    expect(f.calls()).toBe("");
  });

  it("does not repeat an ambiguous upload after restart or a fresh retry approval", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_SUBMIT_FAIL: "8" }).status).not.toBe(0);
    const before = f.calls();
    expect(f.run({ EAS_SUBMIT_APPROVED: "1", EAS_BUILD_ID: buildId }, "eas-ios-submit-only.sh").status).not.toBe(0);
    expect(f.run({}, "eas-ios-build.sh", ["--recover-upload-record", buildId]).status).not.toBe(0);
    expect(f.calls()).toBe(before);
    expect(JSON.parse(readFileSync(join(f.root, ".local/.eas-upload-attempt.json"), "utf8")).status).toBe("started");
  }, 20_000);

  it("recovers accepted upload after status-record failure without uploading again", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_RECORD_UPLOAD_FAIL: "1" }).status).not.toBe(0);
    const before = f.calls();
    expect(JSON.parse(readFileSync(join(f.root, ".local/.eas-upload-attempt.json"), "utf8")).status).toBe("accepted");
    expect(f.run({}, "eas-ios-build.sh", ["--recover-upload-record", buildId]).status).toBe(0);
    expect(f.calls()).toBe(before);
    expect(JSON.parse(readFileSync(join(f.root, ".local/.eas-ios-release-state.json"), "utf8")).latestBuild.uploadStatus).toBe("uploaded to App Store Connect");
    expect(() => readFileSync(join(f.root, ".local/.eas-submit-build-id"))).toThrow();
  }, 20_000);

  it("blocks another paid build after an ambiguous build, even when new approval exists", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_BUILD_FAIL: "9" }).status).not.toBe(0);
    f.approve();
    const before = f.calls();
    expect(f.run().status).not.toBe(0);
    expect(f.calls()).toBe(before);
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("334");
  }, 20_000);

  it("does not confirm availability or device acceptance before the actual artifact is uploaded", () => {
    const f = fixture();
    expect(f.recordStatus(["--record-built", buildId, "1.0.13", "334"]).status).toBe(0);
    expect(f.recordStatus(["--record-apple-processing", buildId, "processed"]).status).not.toBe(0);
    expect(f.recordStatus(["--record-testflight-availability", buildId, "available"]).status).not.toBe(0);
    expect(f.recordStatus(["--confirm-device-checklist", buildId]).status).not.toBe(0);
  });

  it("refuses returned build-number mismatch and retains the remote reservation", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_BUILD_NUMBER: "333" }).status).not.toBe(0);
    expect(f.calls()).not.toContain("submit");
    expect(() => readFileSync(join(f.root, ".local/.eas-remote-build-started"))).not.toThrow();
  });

  it.each(["334", "999"])("validates actual synthetic IPA build number %s before submission", (number) => {
    const f = fixture();
    f.prepareUpload();
    const ipa = join(f.root, "synthetic.ipa");
    execFileSync("python3", ["-c", "import zipfile,plistlib,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('Payload/Synthetic.app/Info.plist',plistlib.dumps({'CFBundleIdentifier':'invalid.synthetic.labtrax','CFBundleVersion':sys.argv[2],'CFBundleShortVersionString':'1.0.13'})); z.close()", ipa, number]);
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), artifactUrl);
    const result = f.run({ MOCK_IPA: ipa, EXPO_TOKEN: "synthetic-fixture-not-a-credential" });
    expect(result.status === 0, result.stderr + result.stdout).toBe(number === "334");
    expect(f.calls().includes("submit --platform")).toBe(number === "334");
  }, 20_000);

  it("does not blindly retry legacy upload markers without pre-attempt evidence", () => {
    const f = fixture();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Legacy pending upload");
    expect(f.calls()).not.toContain("submit --platform");
  });

  it("preserves independent status updates from concurrent processes", async () => {
    const f = fixture();
    const record = (name: string) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/eas-ios-release-status.mjs", "--record-check", name, "pass"], {
        cwd: f.root, stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(await Promise.all([record("api-tests"), record("mobile-tests")])).toEqual([0, 0]);
    const state = JSON.parse(readFileSync(join(f.root, ".local/.eas-ios-release-state.json"), "utf8"));
    expect(state.checks["api-tests"].status).toBe("pass");
    expect(state.checks["mobile-tests"].status).toBe("pass");
  });
});
