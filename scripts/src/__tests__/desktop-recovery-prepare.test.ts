import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const roots: string[] = [];
const script = resolve(import.meta.dirname, "../../desktop-build-publish.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "desktop-prepare-tools-"));
  roots.push(root);
  const desktop = join(root, "artifacts/labtrax-desktop");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(desktop, "package.json"), '{"version":"1.2.3"}');
  writeFileSync(join(root, ".gitignore"), "calls\n**/electron-dist/\n");
  copyFileSync(script, join(root, "scripts/desktop-build-publish.sh"));
  writeFileSync(join(root, "scripts/verify-signing.sh"),
    '#!/usr/bin/env bash\necho "verify-signing" >> "$MOCK_CALL_LOG"\nexit "${MOCK_SIGNING_EXIT:-0}"\n');
  const mock = (name: string, body: string) => writeFileSync(join(root, "bin", name),
    `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  mock("pnpm", `echo "pnpm $*" >> "$MOCK_CALL_LOG"
if [[ "$*" == "run electron:build" ]]; then
  mkdir -p electron-dist/win-unpacked/resources
  echo "synthetic installer" > electron-dist/LabTrax-Setup.exe
  echo "synthetic exe" > electron-dist/win-unpacked/LabTrax.exe
  echo "fresh-stamp" > electron-dist/build-stamp.txt
  echo "\${MOCK_PACKAGED_STAMP:-fresh-stamp}" > electron-dist/win-unpacked/resources/app.asar
  printf 'version: 1.2.3\\npath: LabTrax-Setup.exe\\n' > electron-dist/latest.yml
elif [[ "$*" == *"prepare-desktop-release-identity"* ]]; then
  exit "\${MOCK_PREPARE_EXIT:-0}"
elif [[ "$*" != *"upload-desktop-installer"* ]]; then
  echo "Unexpected pnpm invocation" >&2
  exit 91
fi`);
  mock("curl", 'echo "curl" >> "$MOCK_CALL_LOG"\necho 200');
  mock("psql", 'echo "psql" >> "$MOCK_CALL_LOG"');
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const callsPath = join(root, "calls");
  const run = (args = ["--prepare-only"], extra: Record<string, string | undefined> = {}) =>
    spawnSync("bash", ["scripts/desktop-build-publish.sh", ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root,
        MOCK_CALL_LOG: callsPath, GIT_COMMIT_SHA: revision,
        VITE_API_BASE_URL: "https://release.example.invalid",
        PUBLISH_API_BASE_URL: "https://release.example.invalid",
        ELECTRON_UPDATE_CHANNEL: "installer",
        CSC_LINK: "synthetic-test-certificate", CSC_KEY_PASSWORD: "synthetic-test-password",
        DATABASE_URL: "postgresql://never-connect.example.invalid/test",
        ...extra,
      },
    });
  const calls = () => { try { return readFileSync(callsPath, "utf8"); } catch { return ""; } };
  return { root, desktop, revision, run, calls };
}

afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe("build-only release wrapper (synthetic tools; no build, signing or network)", () => {
  it("prepares only after verification and never uploads, probes HTTP or writes settings", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.calls()).toContain("run electron:build\nverify-signing\n");
    expect(f.calls()).toContain("prepare-desktop-release-identity");
    expect(f.calls()).not.toMatch(/upload-desktop-installer|curl|psql/);
    expect(result.stdout).toContain("Nothing was uploaded, published or written to production settings.");
  });

  it.each([
    { MOCK_SIGNING_EXIT: "9" },
    { MOCK_PACKAGED_STAMP: "old-stamp" },
    { MOCK_PREPARE_EXIT: "9" },
  ])("blocks failed verification/preparation without any publish calls: %j", extra => {
    const f = fixture();
    expect(f.run(["--prepare-only"], extra).status).not.toBe(0);
    expect(f.calls()).not.toMatch(/upload-desktop-installer|curl|psql/);
  });

  it("refuses a short revision or dirty source before building", () => {
    const f = fixture();
    expect(f.run(["--prepare-only"], { GIT_COMMIT_SHA: f.revision.slice(0, 7) }).status).toBe(1);
    expect(f.calls()).toBe("");
    writeFileSync(join(f.root, "untracked-source.ts"), "export const changed = true;");
    expect(f.run().stdout).toContain("untracked files are present");
    expect(f.calls()).toBe("");
    rmSync(join(f.root, "untracked-source.ts"));
    writeFileSync(join(f.desktop, "package.json"), '{"version":"9.9.9"}');
    expect(f.run().stdout).toContain("tracked source changes are present");
    expect(f.calls()).toBe("");
  });

  it("refuses unsigned, portable, missing-API and different-origin preparation before building", () => {
    const f = fixture();
    for (const extra of [
      { CSC_LINK: "" },
      { ELECTRON_UPDATE_CHANNEL: "portable" },
      { PUBLISH_API_BASE_URL: "" },
      { VITE_API_BASE_URL: "https://different.example.invalid" },
    ]) {
      expect(f.run(["--prepare-only"], extra).status).toBe(1);
    }
    expect(f.calls()).toBe("");
  });

  it("rejects unknown options and allows help without touching any tool", () => {
    const f = fixture();
    expect(f.run(["--unknown"]).status).toBe(1);
    expect(f.run(["--prepare-only", "extra"]).status).toBe(1);
    expect(f.run(["--help"]).status).toBe(0);
    expect(f.calls()).toBe("");
  });

  it("preserves the existing explicit publish path", () => {
    const f = fixture();
    const result = f.run([]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.calls()).toContain("upload-desktop-installer");
    expect(f.calls()).toContain("curl");
    expect(f.calls()).toContain("psql");
    expect(f.calls()).not.toContain("prepare-desktop-release-identity");
  });
});

describe("manual recovery preparation workflow", () => {
  it("refuses an old publishing script without executing it to discover flag support", () => {
    const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/prepare-desktop-recovery-release.yml"), "utf8"));
    const gate = workflow.jobs["prepare-windows"].steps.find((step: any) =>
      step.name === "Refuse revisions without the build-only preparation entry point");
    const f = fixture();
    mkdirSync(join(f.root, "scripts/src"), { recursive: true });
    writeFileSync(join(f.root, "scripts/src/desktop-recovery-release.ts"), "// fixture\n");
    writeFileSync(join(f.root, "scripts/desktop-build-publish.sh"),
      '#!/usr/bin/env bash\necho "old publishing script ran" >> "$MOCK_CALL_LOG"\n');
    const result = spawnSync("bash", ["-c", gate.run], {
      cwd: f.root, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, SOURCE_REVISION: f.revision, MOCK_CALL_LOG: join(f.root, "calls") },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("lacks build-only release preparation");
    expect(f.calls()).toBe("");
  });

  it("pins the checkout and cannot automatically publish a live release", () => {
    const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/prepare-desktop-recovery-release.yml"), "utf8"));
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.workflow_dispatch.inputs.checks_passed.default).toBe(false);
    const steps = workflow.jobs["prepare-windows"].steps;
    const checkout = steps.find((step: any) => step.uses === "actions/checkout@v4");
    expect(checkout.with.ref).toBe("${{ inputs.source_revision }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    const build = steps.find((step: any) => step.run === "bash scripts/desktop-build-publish.sh --prepare-only");
    expect(build.env.GIT_COMMIT_SHA).toBe("${{ inputs.source_revision }}");
    expect(build.env.ELECTRON_UPDATE_CHANNEL).toBe("installer");
    expect(JSON.stringify(workflow)).not.toMatch(/PLATFORM_ADMIN_SECRET|PRIVATE_OBJECT_DIR|upload-desktop-installer|publish-release/);
    const artifacts = steps.find((step: any) => step.uses === "actions/upload-artifact@v4");
    expect(artifacts.with.path).toContain("LabTrax-Setup.exe");
    expect(artifacts.with.path).toContain("release-identity.json");
    expect(artifacts.with["if-no-files-found"]).toBe("error");
  });
});
