import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const helper = resolve(import.meta.dirname, "../../cleanup-build-cache.sh");
const preparation = resolve(import.meta.dirname, "../../prepare-production-image.sh");
const realRm = execFileSync("which", ["rm"], { encoding: "utf8" }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "build-cache-test-"));
  roots.push(root);
  for (const dir of ["bin", "scripts", ".cache", ".production-api", "uploads"]) {
    mkdirSync(join(root, dir));
  }
  copyFileSync(helper, join(root, "scripts/cleanup-build-cache.sh"));
  for (const dir of [".cache", ".production-api", "uploads"]) {
    writeFileSync(join(root, dir, "keep"), "fixture");
  }
  const count = join(root, "attempts");
  const sleeps = join(root, "sleeps");
  writeFileSync(join(root, "bin/rm"), `#!/usr/bin/env bash
set -eu
if [[ "$#" == 3 && "$1" == -rf && "$2" == -- && "$3" == "$MOCK_CACHE" ]] ||
   [[ "$#" == 2 && "$1" == -rf && "$2" == "$MOCK_CACHE" ]]; then
  :
else
  exit 99
fi
n=0
if [[ -f "$MOCK_COUNT" ]]; then n=$(cat "$MOCK_COUNT"); fi
n=$((n + 1))
echo "$n" > "$MOCK_COUNT"
if [[ "$n" -le "\${MOCK_FAILURES:-0}" ]]; then
  echo "rm: cannot remove cache: Directory not empty" >&2
  exit 1
fi
if [[ "\${MOCK_RECREATE:-0}" == 1 ]]; then exit 0; fi
exec "$REAL_RM" "$@"
`, { mode: 0o755 });
  writeFileSync(join(root, "bin/sleep"), `#!/usr/bin/env bash
echo "$*" >> "$MOCK_SLEEPS"
`, { mode: 0o755 });
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: root,
    ROOT_DIR: root,
    MOCK_CACHE: join(root, ".cache"),
    MOCK_COUNT: count,
    MOCK_SLEEPS: sleeps,
    REAL_RM: realRm,
  };
  const run = (extra: Record<string, string> = {}, args: string[] = [root]) =>
    spawnSync("bash", [helper, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 5000 });
  const attempts = () => existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
  const sleepCount = () => existsSync(sleeps) ? readFileSync(sleeps, "utf8").trim().split("\n").length : 0;
  return { root, env, run, attempts, sleepCount };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disposable build cache cleanup (sandbox only, no builds or network)", () => {
  it("removes only the cache, preserving production dependencies and uploads", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    expect(f.attempts()).toBe(1);
    expect(existsSync(join(f.root, ".cache"))).toBe(false);
    expect(readFileSync(join(f.root, ".production-api/keep"), "utf8")).toBe("fixture");
    expect(readFileSync(join(f.root, "uploads/keep"), "utf8")).toBe("fixture");
  });

  it("accepts an absent cache without invoking removal", () => {
    const f = fixture();
    rmSync(join(f.root, ".cache"), { recursive: true });
    expect(f.run().status).toBe(0);
    expect(f.attempts()).toBe(0);
  });

  it("retries transient Directory not empty failures and succeeds", () => {
    const f = fixture();
    const result = f.run({ MOCK_FAILURES: "2" });
    expect(result.status).toBe(0);
    expect(f.attempts()).toBe(3);
    expect(f.sleepCount()).toBe(2);
    expect(result.stderr).not.toContain("WARNING:");
    expect(existsSync(join(f.root, ".cache"))).toBe(false);
  });

  it("warns and continues after exactly three persistent failures", () => {
    const f = fixture();
    const result = f.run({ MOCK_FAILURES: "99" });
    expect(result.status).toBe(0);
    expect(f.attempts()).toBe(3);
    expect(f.sleepCount()).toBe(2);
    expect(result.stderr).toContain("WARNING: Disposable build cache remains");
    expect(existsSync(join(f.root, ".cache/keep"))).toBe(true);
  });

  it("bounds retries when removal reports success but the cache still exists", () => {
    const f = fixture();
    const result = f.run({ MOCK_RECREATE: "1" });
    expect(result.status).toBe(0);
    expect(f.attempts()).toBe(3);
    expect(result.stderr).toContain("WARNING:");
  });

  it("removes a cache symlink without following it into other data", () => {
    const f = fixture();
    rmSync(join(f.root, ".cache"), { recursive: true });
    symlinkSync(join(f.root, "uploads"), join(f.root, ".cache"));
    expect(f.run().status).toBe(0);
    expect(existsSync(join(f.root, ".cache"))).toBe(false);
    expect(readFileSync(join(f.root, "uploads/keep"), "utf8")).toBe("fixture");
  });

  it("rejects missing, nonexistent and filesystem-root arguments without deleting anything", () => {
    const f = fixture();
    for (const args of [[], [""], ["/"], [join(f.root, "missing")], [f.root, "extra"]]) {
      expect(f.run({}, args).status).toBe(64);
    }
    expect(f.attempts()).toBe(0);
    expect(existsSync(join(f.root, ".cache/keep"))).toBe(true);
  });

  it("keeps the actual preparation cleanup nonfatal under set -e without weakening other checks", () => {
    const f = fixture();
    const legacy = spawnSync("bash", ["-c", 'set -euo pipefail\nrm -rf "$ROOT_DIR/.cache"\necho "must not continue"'], {
      env: { ...f.env, MOCK_FAILURES: "99" }, encoding: "utf8", timeout: 5000,
    });
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain("Directory not empty");
    expect(legacy.stdout).not.toContain("must not continue");
    const source = readFileSync(preparation, "utf8");
    expect(source).toContain("set -euo pipefail");
    expect(source).toContain('rm -rf "$PNPM_STORE"');
    const cleanup = source.split('rm -rf "$PNPM_STORE"\n')[1]?.split('echo "Production image prepared:"')[0];
    expect(cleanup).toContain('bash "$ROOT_DIR/scripts/cleanup-build-cache.sh" "$ROOT_DIR"');
    const run = (tail: string) => spawnSync("bash", ["-c", `set -euo pipefail\n${cleanup}\n${tail}`], {
      env: { ...f.env, MOCK_FAILURES: "99" }, encoding: "utf8", timeout: 5000,
    });
    const result = run('echo "preparation continued"');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("preparation continued");
    expect(result.stderr).toContain("WARNING:");
    const blocked = run('false\necho "must not continue"');
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout).not.toContain("must not continue");
  });
});
