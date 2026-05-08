/**
 * Smart electron build script.
 *
 * On Windows (or Linux with Wine): runs electron-builder to produce the full
 * NSIS installer exe → electron-dist/LabTrax Setup *.exe
 *
 * On Linux without Wine (e.g. Replit): electron-builder still creates
 * electron-dist/win-unpacked which contains LabTrax.exe. This script then
 * zips that directory into electron-dist/LabTrax-Windows-Portable.zip, which
 * is a fully functional Windows distribution users can download and run.
 *
 * Auto-update publishing (GitHub Releases):
 *   The publish provider is set to "github" in electron-builder.yml. When
 *   GH_TOKEN is present, electron-builder runs with --publish always and
 *   uploads the installer (.exe) and the auto-update manifest (latest.yml)
 *   directly to the GitHub Release. electron-updater in the packaged app
 *   queries the GitHub Releases API to discover new versions automatically.
 *
 *   The CI workflow (.github/workflows/build-windows.yml) supplies GH_TOKEN
 *   automatically on tag pushes so that every versioned release is published
 *   with both artifacts. No additional configuration is required.
 *
 * Usage:
 *   VITE_API_BASE_URL=https://your-app.replit.app pnpm run electron:build
 *   VITE_API_BASE_URL=… GH_TOKEN=ghp_… pnpm run electron:build
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

if (!process.env.VITE_API_BASE_URL) {
  console.error(
    "\nERROR: VITE_API_BASE_URL is required for production packaging.\n" +
    "The desktop app uses this URL to reach the API server.\n\n" +
    "Set it before building:\n" +
    "  VITE_API_BASE_URL=https://your-app.replit.app pnpm run electron:build\n",
  );
  process.exit(1);
}

const updateFeedUrl = process.env.UPDATE_FEED_URL;
const ghToken = process.env.GH_TOKEN;
const shouldPublish = Boolean(updateFeedUrl || ghToken);

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    shell: false,
    env: { ...process.env, ...env },
  });
  return result.status ?? 0;
}

async function zipUnpacked() {
  const unpackedDir = resolve(root, "electron-dist", "win-unpacked");
  const outFile = resolve(root, "electron-dist", "LabTrax-Windows-Portable.zip");

  if (!existsSync(unpackedDir)) {
    console.error("\nERROR: electron-dist/win-unpacked not found — cannot create zip.");
    process.exit(1);
  }

  console.log(`\nCreating portable zip from win-unpacked…`);
  console.log(`  ${unpackedDir} → ${outFile}\n`);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(output);
    archive.directory(unpackedDir, "LabTrax");

    output.on("close", () => {
      const mb = (archive.pointer() / 1024 / 1024).toFixed(1);
      console.log(`✓ LabTrax-Windows-Portable.zip  (${mb} MB)`);
      console.log(`\nInstall on Windows:`);
      console.log(`  1. Download LabTrax-Windows-Portable.zip`);
      console.log(`  2. Extract the zip`);
      console.log(`  3. Run LabTrax\\LabTrax.exe`);
      resolve();
    });

    archive.on("error", reject);
    archive.finalize();
  });
}

const viteCode = run("pnpm", ["exec", "vite", "build", "--config", "vite.electron.config.ts"]);
if (viteCode !== 0) {
  console.error("\nERROR: Vite build failed.");
  process.exit(viteCode);
}

const builderArgs = [
  "exec",
  "electron-builder",
  "--win",
  "--config",
  "electron-builder.yml",
];

if (shouldPublish) {
  if (updateFeedUrl) {
    const publishOverride = JSON.stringify({ publish: { provider: "generic", url: updateFeedUrl } });
    builderArgs.push("--config", publishOverride);
  }
  builderArgs.push("--publish", "always");
  console.log(
    updateFeedUrl
      ? `\nPublishing release artifacts to: ${updateFeedUrl}`
      : "\nPublishing release artifacts to GitHub Releases…",
  );
} else {
  console.log(
    "\nNote: set UPDATE_FEED_URL (or GH_TOKEN for GitHub Releases) to publish\n" +
    "release artifacts for auto-update. Without publishing, users must\n" +
    "download new versions manually.",
  );
}

const buildExitCode = run("pnpm", builderArgs);

if (buildExitCode === 0) {
  if (shouldPublish) {
    console.log("\n✓ Installer and latest.yml published. Auto-update is active for this release.");
  } else {
    console.log("\n✓ NSIS installer produced in electron-dist/");
  }
} else {
  console.warn(
    "\nelectron-builder did not complete (Wine is required on Linux for NSIS).",
  );
  console.warn("Creating portable zip from win-unpacked instead…");
  await zipUnpacked();
}
