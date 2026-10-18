import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseStoreVersion,
  renderStoreManifest,
  validateMsixBuffer,
  validateStoreIdentity,
} from "./lib/msix-validation.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(desktopRoot, "electron-dist");
const appRoot = resolve(outputRoot, "win-unpacked");
const stagingRoot = resolve(outputRoot, "store-staging");
const packagePath = resolve(outputRoot, "LabTrax-Store.msix");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Microsoft Store MSIX packaging must run on a Windows build runner.");
  }
  if (!existsSync(resolve(appRoot, "LabTrax.exe"))) {
    throw new Error(
      `Windows app output is missing at ${appRoot}. Run electron:build before requesting the Store package.`,
    );
  }
  if (!existsSync(resolve(appRoot, "resources", "app.asar"))) {
    throw new Error("Windows app output is missing resources/app.asar; refusing to package stale or incomplete files.");
  }

  const identity = validateStoreIdentity({
    identityName: process.env.STORE_PACKAGE_IDENTITY_NAME,
    publisher: process.env.STORE_PACKAGE_PUBLISHER,
    publisherDisplayName: process.env.STORE_PACKAGE_PUBLISHER_DISPLAY_NAME,
  });
  const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8"));
  const buildNumberJson = JSON.parse(
    readFileSync(resolve(desktopRoot, "build-number.json"), "utf8"),
  );
  const version = parseStoreVersion(packageJson.version, buildNumberJson.buildNumber);
  const buildStampPath = resolve(outputRoot, "build-stamp.txt");
  if (!existsSync(buildStampPath)) {
    throw new Error("The Windows build is missing its freshness stamp; refusing to package it.");
  }
  const buildStamp = readFileSync(buildStampPath, "utf8").trim();
  if (!buildStamp || !readFileSync(resolve(appRoot, "resources", "app.asar")).includes(buildStamp)) {
    throw new Error("The Windows app does not contain the current build stamp; refusing to package stale files.");
  }

  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(packagePath, { force: true });
  mkdirSync(stagingRoot, { recursive: true });
  cpSync(appRoot, stagingRoot, { recursive: true });
  const stagedUpdaterManifest = resolve(stagingRoot, "resources", "app-update.yml");
  if (existsSync(stagedUpdaterManifest)) rmSync(stagedUpdaterManifest);

  const manifestPath = resolve(stagingRoot, "Package.appxmanifest");
  writeFileSync(
    manifestPath,
    renderStoreManifest({
      ...identity,
      version,
    }),
    "utf8",
  );

  try {
    run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(desktopRoot, "scripts", "generate-windows-store-assets.ps1"),
      "-SourceIcon",
      resolve(desktopRoot, "electron", "icon.png"),
      "-OutputDirectory",
      resolve(stagingRoot, "Assets"),
    ]);

    run("pnpm", [
      "exec",
      "winapp",
      "pack",
      stagingRoot,
      "--output",
      packagePath,
      "--manifest",
      manifestPath,
      "--no-sign",
    ]);

    const report = await validateMsixBuffer(readFileSync(packagePath), {
      ...identity,
      version,
    });
    console.log(
      `Validated ${packagePath}: ${report.identityName} ${report.version} ${report.architecture}; ` +
        `${report.capabilities.join(", ")}; ${report.signature}.`,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\nMicrosoft Store package failed: ${error.message}`);
  process.exitCode = 1;
});
