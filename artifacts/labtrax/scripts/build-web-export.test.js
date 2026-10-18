const { strict: assert } = require("node:assert");
const { EventEmitter } = require("node:events");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const TEST_CHILD_ENV = "LABTRAX_BUILD_WEB_EXPORT_TEST_CHILD";
const RESULT_PREFIX = "BUILD_WEB_EXPORT_RESULT:";

function createTestChild(scenario, outputDir) {
  const child = new EventEmitter();

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "index.html"), `<main>${scenario}</main>`);

  if (scenario === "nonzero-exit") {
    setImmediate(() => child.emit("close", 7, null));
  } else if (scenario === "spawn-error") {
    setImmediate(() => child.emit("error", new Error("simulated spawn error")));
  } else if (scenario === "timeout") {
    child.kill = (signal) => {
      child.killSignal = signal;
      setImmediate(() => child.emit("close", null, signal));
    };
  } else {
    setImmediate(() => child.emit("close", 0, null));
  }

  return child;
}

async function runChildProcessScenario() {
  const { buildWebExport } = require("./build.js");
  const scenario = process.env[TEST_CHILD_ENV];
  const root = process.env.LABTRAX_BUILD_WEB_EXPORT_ROOT;
  const webTmpDir = join(root, "static-build-web-tmp");

  const result = { scenario };
  try {
    await buildWebExport({
      domain: "lab-trax.replit.app",
      buildRoot: root,
      timeoutMs: scenario === "timeout" ? 20 : 1_000,
      spawnImpl: (_command, args) => {
        return createTestChild(scenario, args.at(-1));
      },
    });
    result.ok = true;
    result.merged = readFileSync(join(root, "static-build", "index.html"), "utf8");
  } catch (error) {
    result.ok = false;
    result.error = error.message;
  }
  result.tmpExists = existsSync(webTmpDir);

  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
  process.exitCode = result.ok ? 0 : 1;
}

function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), `labtrax-build-web-${scenario}-`));
  const child = spawnSync(process.execPath, [__filename], {
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      [TEST_CHILD_ENV]: scenario,
      LABTRAX_BUILD_WEB_EXPORT_ROOT: root,
    },
    encoding: "utf8",
    timeout: 5_000,
  });

  const resultLine = child.stdout
    .split("\n")
    .find((line) => line.startsWith(RESULT_PREFIX));
  assert.ok(resultLine, `child process did not report a result:\n${child.stdout}\n${child.stderr}`);
  const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  rmSync(root, { recursive: true, force: true });
  return { child, result };
}

if (process.env[TEST_CHILD_ENV]) {
  runChildProcessScenario().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  for (const scenario of ["nonzero-exit", "spawn-error", "timeout"]) {
    test(`fails the build when Expo web export ${scenario}`, () => {
      const { child, result } = runScenario(scenario);
      assert.equal(child.status, 1);
      assert.equal(result.ok, false);
      assert.match(result.error, /LabTrax browser app was not produced/);
      assert.equal(result.tmpExists, false);
    });
  }

  test("merges a successful Expo web export into static-build", () => {
    const { child, result } = runScenario("success");
    assert.equal(child.status, 0);
    assert.equal(result.ok, true);
    assert.equal(result.merged, "<main>success</main>");
    assert.equal(result.tmpExists, false);
  });
}