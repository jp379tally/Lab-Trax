/**
 * Packaged Electron sign-in recovery smoke test.
 *
 * Builds the current desktop app for the host OS, launches the packaged app
 * with a fresh temporary user profile, and exercises Electron's real
 * safeStorage implementation. Only scenario, status, and outcome are written
 * to the optional result file; synthetic token values are never reported.
 *
 * Run on Windows, macOS, or Linux:
 *   pnpm --filter @workspace/labtrax-desktop run electron:auth-restore-smoke
 * On Linux without a display:
 *   xvfb-run -a pnpm --filter @workspace/labtrax-desktop run electron:auth-restore-smoke
 */

import { _electron as electron } from "playwright-core";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const resultPath = process.env.LABTRAX_AUTH_SMOKE_RESULT;
const appDataRoot = await mkdtemp(path.join(tmpdir(), "labtrax-auth-smoke-"));
const distRoot = path.join(appDataRoot, "electron-dist");
const syntheticTokens = {
  accessToken: "synthetic-auth-restore-access",
  refreshToken: "synthetic-auth-restore-refresh",
};
const results = [];
let activeApp = null;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function assertIsolatedPath(candidate) {
  const relative = path.relative(
    await realpath(appDataRoot),
    await realpath(candidate),
  );
  assert(
    relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Packaged app userData did not resolve inside the disposable test profile.",
  );
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status ?? "unknown"}.`);
}

async function packagedExecutable() {
  if (process.platform === "win32") {
    return path.join(distRoot, "win-unpacked", "LabTrax.exe");
  }
  if (process.platform === "linux") {
    const directory = path.join(distRoot, "linux-unpacked");
    // electron-builder derives Linux names from the scoped package name.
    const candidates = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /labtrax/i.test(entry.name));
    assert(candidates.length === 1, "Expected exactly one packaged LabTrax executable.");
    return path.join(directory, candidates[0].name);
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return path.join(
      distRoot,
      `mac-${arch}`,
      "LabTrax.app",
      "Contents",
      "MacOS",
      "LabTrax",
    );
  }
  fail(`Unsupported host OS: ${process.platform}`);
}

function isolatedProfileEnvironment() {
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: "1",
    LABTRAX_SKIP_AUTOUPDATER: "1",
    NODE_ENV: "production",
    VITE_API_BASE_URL: "https://example.invalid",
  };
  // Keep the OS login/keychain environment intact. The app receives an explicit
  // disposable user-data directory before it reads any persisted credentials.
  return env;
}

async function launchPackagedApp(executable, env) {
  const args = [`--user-data-dir=${path.join(appDataRoot, "profile")}`];
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-gpu");
  if (
    process.platform === "linux" &&
    process.env.LABTRAX_AUTH_SMOKE_FORCE_LIBSECRET === "1"
  ) {
    // CI intentionally exercises the real libsecret path rather than
    // Electron's weaker basic_text fallback when no desktop keyring exists.
    args.push("--password-store=gnome-libsecret");
  }
  const app = await electron.launch({
    executablePath: executable,
    args,
    cwd: path.dirname(executable),
    env,
    timeout: 60_000,
  });
  activeApp = app;
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  await window.waitForFunction(
    () => {
      const api = globalThis.electronAPI;
      return Boolean(api?.auth?.getTokensStatus && api?.auth?.isAvailable);
    },
    null,
    { timeout: 30_000 },
  );
  return { app, window };
}

async function readKeychainState(window, expectedTokens) {
  return window.evaluate(async (expected) => {
    const status = await window.electronAPI.auth.getTokensStatus();
    return {
      available: await window.electronAPI.auth.isAvailable(),
      status: status.status,
      hasTokens: Boolean(
        status.tokens?.accessToken && status.tokens?.refreshToken,
      ),
      matchesExpected: expected
        ? status.tokens?.accessToken === expected.accessToken &&
          status.tokens?.refreshToken === expected.refreshToken
        : false,
    };
  }, expectedTokens);
}

async function recordUnavailableOutcome(window, status) {
  assert(
    status === "keychain-unavailable",
    "Unavailable safeStorage did not report keychain-unavailable.",
  );
  await window.getByText(/can't access this device's OS keychain/i).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  results.push({
    scenario: "keychain-unavailable",
    status,
    outcome: "pass",
  });
}

async function main() {
  if (!["win32", "darwin", "linux"].includes(process.platform)) {
    fail(
      `Supported OSes are Windows, macOS, and Linux; got ${process.platform}.`,
    );
  }

  const buildEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CSC_LINK: "",
    CSC_KEY_PASSWORD: "",
    VITE_API_BASE_URL: "https://example.invalid",
  };
  const builderConfigPath = path.join(
    desktopRoot,
    `electron-builder.auth-smoke-${process.pid}-${randomUUID()}.yml`,
  );

  try {
    const config = await readFile(
      path.join(desktopRoot, "electron-builder.yml"),
      "utf8",
    );
    assert(
      config.includes("${UPDATE_FEED_URL}"),
      "electron-builder.yml no longer contains the expected update-feed placeholder.",
    );
    const configWithPlaceholder = config.replaceAll(
      "${UPDATE_FEED_URL}",
      "https://example.invalid/downloads",
    );
    const configWithSmokeOutput = configWithPlaceholder.replace(
      "output: electron-dist",
      `output: ${distRoot.replaceAll("\\", "/")}`,
    );
    assert(
      configWithSmokeOutput !== configWithPlaceholder,
      "electron-builder.yml no longer contains the expected output directory setting.",
    );
    await writeFile(builderConfigPath, configWithSmokeOutput, "utf8", {
      flag: "wx",
    });

    run(
      "pnpm",
      ["exec", "vite", "build", "--config", "vite.electron.config.ts"],
      { env: buildEnv },
    );
    const platform =
      process.platform === "win32"
        ? "win"
        : process.platform === "darwin"
          ? "mac"
          : "linux";
    const platformOutput = path.join(
      distRoot,
      process.platform === "win32"
        ? "win-unpacked"
        : process.platform === "darwin"
          ? `mac-${process.arch === "arm64" ? "arm64" : "x64"}`
          : "linux-unpacked",
    );
    await rm(platformOutput, { recursive: true, force: true });
    run(
      "pnpm",
      [
        "exec",
        "electron-builder",
        `--${platform}`,
        "--dir",
        "--config",
        path.basename(builderConfigPath),
        "--publish",
        "never",
      ],
      { env: buildEnv },
    );

    const executable = await packagedExecutable();
    const appEnv = isolatedProfileEnvironment();
    let { app, window } = await launchPackagedApp(executable, appEnv);
    const userDataPath = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath("userData"),
    );
    await assertIsolatedPath(userDataPath);
    const initial = await readKeychainState(window);

    if (!initial.available) {
      await recordUnavailableOutcome(window, initial.status);
      await app.close();
      activeApp = null;
    } else {
      assert(
        initial.status === "empty",
        "A fresh isolated profile did not start empty.",
      );
      await window.evaluate(
        (tokens) => window.electronAPI.auth.setTokens(tokens),
        syntheticTokens,
      );
      await app.close();
      activeApp = null;

      ({ app, window } = await launchPackagedApp(executable, appEnv));
      const restored = await readKeychainState(window, syntheticTokens);
      assert(
        restored.status === "ok",
        "Saved sign-in did not restore after a packaged app restart.",
      );
      assert(
        restored.matchesExpected,
        "Saved sign-in values did not survive a packaged app restart.",
      );
      assert(
        (await window
          .getByText(
            /couldn't read the saved sign-in|can't access this device's OS keychain/i,
          )
          .count()) === 0,
        "The login screen showed a recovery warning for a valid restored sign-in.",
      );
      results.push({
        scenario: "saved-sign-in-restart",
        status: restored.status,
        outcome: "pass",
      });

      await app.close();
      activeApp = null;

      // This corrupts only the disposable profile created for this smoke test.
      // Neither the blob nor any decrypted values are printed or retained.
      await writeFile(
        path.join(userDataPath, "auth-tokens.bin"),
        Buffer.from("invalid-smoke-blob"),
      );
      ({ app, window } = await launchPackagedApp(executable, appEnv));
      await window.getByText(/couldn't read the saved sign-in/i).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      const invalidBlobRemoved = !existsSync(path.join(userDataPath, "auth-tokens.bin"));
      assert(
        invalidBlobRemoved,
        "Unreadable saved sign-in data was not cleared.",
      );
      results.push({
        scenario: "invalid-saved-data",
        status: "decrypt-failed",
        outcome: "pass",
      });
      await app.close();
      activeApp = null;

      results.push({
        scenario: "keychain-unavailable",
        status: "not-triggered",
        outcome: "manual-lock-check-required",
      });
    }
  } finally {
    if (activeApp) {
      await activeApp.close().catch(() => {});
      activeApp = null;
    }
    await rm(builderConfigPath, { force: true });
    await rm(appDataRoot, { recursive: true, force: true });
  }

  const report = {
    platform: process.platform,
    results,
  };
  if (resultPath) {
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  for (const result of results) {
    console.log(
      `${result.scenario}: status=${result.status}; outcome=${result.outcome}`,
    );
  }
  console.log("Packaged sign-in recovery smoke passed.");
}

main().catch(async (error) => {
  // The error text is intentionally not enriched with tokens or profile data.
  console.error(`Packaged sign-in recovery smoke failed: ${error.message}`);
  if (resultPath) {
    const report = {
      platform: process.platform,
      results: [
        ...results,
        { scenario: "smoke-run", status: "failed", outcome: "fail" },
      ],
    };
    await mkdir(path.dirname(resultPath), { recursive: true }).catch(() => {});
    await writeFile(
      resultPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    ).catch(() => {});
  }
  process.exitCode = 1;
});
