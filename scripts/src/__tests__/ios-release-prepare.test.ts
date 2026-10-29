import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ios-prepare-test-")); roots.push(root);
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "bin"));
  copyFileSync(resolve(import.meta.dirname, "../../eas-ios-prepare.sh"), join(root, "scripts/eas-ios-prepare.sh"));
  writeFileSync(join(root, ".gitignore"), ".local/\n");
  writeFileSync(join(root, "marker"), "original");
  writeFileSync(join(root, "bin/pnpm"), '#!/bin/bash\nif [[ -n "$MUTATE" ]]; then echo changed >> marker; fi\nif [[ -n "$FAIL_MATCH" && "$*" == *"$FAIL_MATCH"* ]]; then echo intentional-test-failure; exit 17; fi\n');
  execFileSync("chmod", ["+x", join(root, "bin/pnpm")]);
  writeFileSync(join(root, "scripts/run-isolated-backup-restore.sh"), '#!/bin/bash\necho "isolated $LABTRAX_ISOLATED_TEST_CONFIG" >> .local/calls\n');
  writeFileSync(join(root, "scripts/eas-ios-build.sh"), '#!/bin/bash\necho "$*" >> .local/calls\nif [[ "$1" == --run-approved ]]; then test -f .local/.eas-build-approved || exit 3; echo launched > .local/launched; fi\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
  const run = (mode = "--check", extra: Record<string,string> = {}) => spawnSync("bash", ["scripts/eas-ios-prepare.sh", mode], { cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, FAIL_MATCH: "", MUTATE: "", ...extra } });
  return { root, run, calls: () => readFileSync(join(root, ".local/calls"), "utf8"), launched: () => existsSync(join(root, ".local/launched")) };
}
describe("direct iOS release preparation", () => {
  it("records all required checks and never launches in check mode", () => {
    const f = fixture(); const r = f.run(); expect(r.status, r.stderr).toBe(0);
    expect(f.calls().match(/--record-check .* pass/g)).toHaveLength(9);
    expect(f.calls()).toContain("isolated vitest.config.ts");
    expect(f.calls()).toContain("isolated vitest.restore.config.ts");
    expect(f.launched()).toBe(false);
    expect(existsSync(join(f.root, ".local/.eas-build-approved"))).toBe(false);
  });
  it("launches only after all checks for an explicit release", () => {
    const f = fixture(); const r = f.run("--run-approved"); expect(r.status, r.stderr).toBe(0);
    expect(f.calls().trim().split("\n").at(-1)).toBe("--run-approved"); expect(f.launched()).toBe(true);
  });
  it("records a real failed check and refuses to launch", () => {
    const f = fixture(); const r = f.run("--run-approved", { FAIL_MATCH: "typecheck" });
    expect(r.status).toBe(17); expect(f.calls()).toContain("--record-check typecheck fail"); expect(f.launched()).toBe(false);
    expect(existsSync(join(f.root, ".local/.eas-build-approved"))).toBe(false);
  });
  it("refuses to record passes or launch after source changes", () => {
    const f = fixture(); const r = f.run("--run-approved", { MUTATE: "1" });
    expect(r.status).toBe(2); expect(r.stderr).toContain("Source changed"); expect(f.launched()).toBe(false);
    expect(existsSync(join(f.root, ".local/calls"))).toBe(false);
  });
  it("preserves a pending submission and refuses another build", () => {
    const f = fixture(); mkdirSync(join(f.root, ".local")); writeFileSync(join(f.root, ".local/.eas-submit-only"), "pending");
    const r = f.run("--run-approved"); expect(r.status).toBe(2); expect(f.launched()).toBe(false);
    expect(readFileSync(join(f.root, ".local/.eas-submit-only"), "utf8")).toBe("pending");
  });
});
