import { execFileSync, spawnSync } from "node:child_process";
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
  copyFileSync(resolve(import.meta.dirname, "../../eas-ios-submit-only.sh"), join(root, "scripts/eas-ios-submit-only.sh"));
  const app = join(root, "artifacts/labtrax/app.json");
  writeFileSync(app, JSON.stringify({ expo: { ios: { buildNumber: "333" }, name: "original", extra: { eas: { projectId } } } }) + "\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const log = join(root, "calls");
  const mock = (name: string, body: string) => writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  mock("python3", 'exit "${MOCK_KEY_FAIL:-0}"');
  // Cleanup must never touch the workspace's real fixed credential path.
  const realRm = execFileSync("which", ["rm"], { encoding: "utf8" }).trim();
  mock("rm", `if [[ "\${2:-}" == /tmp/AuthKey_RV23AJ8V62.p8 ]]; then exit 0; fi\nexec "${realRm}" "$@"`);
  mock("pnpm", `node -e 'const fs=require("fs");const p="artifacts/labtrax/app.json";const c=JSON.parse(fs.readFileSync(p));c.expo.ios.buildNumber=String(Number(c.expo.ios.buildNumber)+1);fs.writeFileSync(p,JSON.stringify(c)+"\\n")'`);
  mock("eas", `echo "$*" >> "$MOCK_CALL_LOG"
if [[ "$1" == build ]]; then
  if [[ "\${MOCK_INVALID_JSON:-0}" == 1 ]]; then echo '[]'; else
    echo '[{"id":"${buildId}","platform":"IOS","status":"FINISHED"}]'
  fi
  exit "\${MOCK_BUILD_FAIL:-0}"
fi
if [[ "$1" == build:view ]]; then
  node -e 'console.log(JSON.stringify({
    id:process.env.MOCK_VIEW_ID || "${buildId}",
    project:{id:process.env.MOCK_VIEW_PROJECT || "${projectId}"},
    platform:"IOS",status:"FINISHED",distribution:"STORE",buildProfile:"production",
    artifacts:{buildUrl:process.env.MOCK_VIEW_URL || "${artifactUrl}"}
  }))'
  exit "\${MOCK_VIEW_FAIL:-0}"
fi
exit "\${MOCK_SUBMIT_FAIL:-0}"`);
  mock("curl", `echo "curl" >> "$MOCK_CALL_LOG"
for arg in "$@"; do
  # Simulate an HTTP 404: curl without -f still exits zero and saves HTML.
  if [[ "$arg" == -*f* ]]; then exit 22; fi
done
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == -o ]]; then printf '<html>expired</html>' > "$2"; break; fi
  shift
done
exit 0`);
  const run = (extra: Record<string, string> = {}, script = "eas-ios-build.sh") => spawnSync("bash", [`scripts/${script}`], {
    cwd: root,
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, MOCK_CALL_LOG: log, ...extra },
    encoding: "utf8",
  });
  const approve = () => writeFileSync(join(root, ".local/.eas-build-approved"), "");
  const calls = () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
  return { root, app, run, approve, calls };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("iOS release approval and failure paths (fake tools, no network)", () => {
  it("does nothing and does not bump without approval", () => {
    const f = fixture();
    const before = readFileSync(f.app, "utf8");
    expect(f.run().status).toBe(0);
    expect(readFileSync(f.app, "utf8")).toBe(before);
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
  });

  it("retains a reserved number when a remote build command has an ambiguous failure", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_BUILD_FAIL: "9" }).status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("334");
    expect(f.calls()).not.toContain("submit");
    expect(f.run().status).toBe(0); // token already consumed; no second build
    expect(f.calls().trim().split("\n")).toHaveLength(1);
  });

  it("submits exactly the completed build, preserving its number if upload fails", () => {
    const f = fixture();
    f.approve();
    expect(f.run({ MOCK_SUBMIT_FAIL: "8" }).status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("334");
    expect(f.calls()).toContain(`submit --platform ios --profile production --id ${buildId}`);
    expect(f.calls()).not.toContain("--latest");
  });

  it("does not upload an HTTP error and retains submit-only retry metadata", () => {
    const f = fixture();
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
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "https://unrelated.example/test.ipa");
    expect(f.run().status).not.toBe(0);
    expect(f.calls()).toBe("");
  });

  it.each<{ label: string; env: Record<string, string> }>([
    { label: "different build ID", env: { MOCK_VIEW_ID: "99999999-2222-4333-8444-555555555555" } },
    { label: "different project", env: { MOCK_VIEW_PROJECT: "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee" } },
    { label: "stale IPA URL", env: { MOCK_VIEW_URL: "https://expo.dev/artifacts/eas/another.ipa" } },
    { label: "failed metadata lookup", env: { MOCK_VIEW_FAIL: "8" } },
  ])("refuses a $label before downloading or uploading", ({ env }) => {
    const f = fixture();
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), buildId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), artifactUrl);
    expect(f.run(env).status).not.toBe(0);
    expect(f.calls()).toBe(`build:view ${buildId} --json\n`);
    expect(readFileSync(join(f.root, ".local/.eas-submit-build-id"), "utf8")).toBe(buildId);
    expect(readFileSync(join(f.root, ".local/.eas-submit-ipa-url"), "utf8")).toBe(artifactUrl);
  });

  it.each(["matching", "different"])("clears only a %s pending build after a successful standalone retry", (kind) => {
    const f = fixture();
    const pendingId = kind === "matching" ? buildId : "99999999-2222-4333-8444-555555555555";
    writeFileSync(join(f.root, ".local/.eas-submit-only"), "");
    writeFileSync(join(f.root, ".local/.eas-submit-build-id"), pendingId);
    writeFileSync(join(f.root, ".local/.eas-submit-ipa-url"), artifactUrl);
    expect(f.run({ EAS_SUBMIT_APPROVED: "1", EAS_BUILD_ID: buildId }, "eas-ios-submit-only.sh").status).toBe(0);
    for (const name of [".eas-submit-only", ".eas-submit-build-id", ".eas-submit-ipa-url"]) {
      if (kind === "matching") expect(() => readFileSync(join(f.root, ".local", name))).toThrow();
      else expect(() => readFileSync(join(f.root, ".local", name))).not.toThrow();
    }
  });

  it("preserves matching pending state when the standalone upload fails", () => {
    const f = fixture();
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

  it("submit-only requires explicit approval and an exact build id", () => {
    const f = fixture();
    expect(f.run({}, "eas-ios-submit-only.sh").status).not.toBe(0);
    expect(f.run({ EAS_SUBMIT_APPROVED: "1" }, "eas-ios-submit-only.sh").status).not.toBe(0);
    expect(f.calls()).toBe("");
    expect(f.run({ EAS_SUBMIT_APPROVED: "1", EAS_BUILD_ID: buildId }, "eas-ios-submit-only.sh").status).toBe(0);
    expect(f.calls()).toContain(`submit --platform ios --profile production --id ${buildId}`);
  });

  it("refuses a second approved release operation while the shared lock is held", () => {
    const f = fixture();
    f.approve();
    // The parent shell holds fd 8 while the child tries its own nonblocking fd.
    const result = spawnSync("bash", ["-c", 'exec 8>.local/.eas-ios-release.lock; flock 8; bash scripts/eas-ios-build.sh'], {
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
    expect(f.run().status).not.toBe(0);
    expect(f.calls()).toBe("");
    expect(JSON.parse(readFileSync(f.app, "utf8")).expo.ios.buildNumber).toBe("333");
    expect(readFileSync(join(f.root, ".local/.eas-submit-build-id"), "utf8")).toBe(buildId);
  });
});
