import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const helper = resolve(import.meta.dirname, "../../commit-ios-build-number.sh");

function fixture(buildNumber = "333") {
  const root = mkdtempSync(join(tmpdir(), "ios-build-number-commit-test-"));
  roots.push(root);
  mkdirSync(join(root, "artifacts/labtrax"), { recursive: true });
  mkdirSync(join(root, "bin"));
  const appJson = join(root, "artifacts/labtrax/app.json");
  writeFileSync(appJson, JSON.stringify({ expo: { ios: { buildNumber } } }) + "\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);

  const run = (expectedBuildNumber: string, path = process.env.PATH ?? "") => spawnSync(
    "bash",
    [helper, appJson, expectedBuildNumber],
    { cwd: root, env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: join(root, "empty-global-config"), GIT_CONFIG_NOSYSTEM: "1", PATH: path }, encoding: "utf8" },
  );
  const head = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commitSubject = () => execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  return { root, appJson, run, head, commitSubject };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("iOS build-number commit helper (disposable Git repositories; no EAS)", () => {
  it("accepts a no-op only when HEAD already records the requested number", () => {
    const f = fixture("334");
    const before = f.head();

    const result = f.run("334");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already committed and verified");
    expect(f.head()).toBe(before);
  });

  it("commits a changed build number and verifies the saved commit", () => {
    const f = fixture();
    writeFileSync(f.appJson, JSON.stringify({ expo: { ios: { buildNumber: "334" } } }) + "\n");

    const result = f.run("334");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("commit verified");
    expect(f.commitSubject()).toBe("chore: bump iOS build number to 334 [skip ci]");
    expect(JSON.parse(readFileSync(f.appJson, "utf8")).expo.ios.buildNumber).toBe("334");
  });

  it("reports commit failure and leaves the completed build ID available for recovery", () => {
    const f = fixture();
    const initialHead = f.head();
    writeFileSync(f.appJson, JSON.stringify({ expo: { ios: { buildNumber: "334" } } }) + "\n");
    const buildId = "11111111-2222-4333-8444-555555555555";
    const retryBuildIdFile = join(f.root, ".local/.eas-submit-build-id");
    mkdirSync(join(f.root, ".local"));
    writeFileSync(retryBuildIdFile, buildId);

    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(f.root, "bin/git");
    writeFileSync(shim, `#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [[ "$arg" == commit ]]; then echo "simulated index lock failure" >&2; exit 73; fi\ndone\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const result = f.run("334", `${join(f.root, "bin")}:${process.env.PATH ?? ""}`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not commit build number 334");
    expect(result.stdout + result.stderr).not.toContain("commit verified");
    expect(f.head()).toBe(initialHead);
    expect(readFileSync(retryBuildIdFile, "utf8")).toBe(buildId);
  });
});
