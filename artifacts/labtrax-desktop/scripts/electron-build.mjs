/**
 * Smart electron build script.
 *
 * Platform selection:
 *   The target platform is chosen by the ELECTRON_PLATFORM environment variable:
 *     ELECTRON_PLATFORM=mac  → macOS DMG (signed + notarized when Apple creds present)
 *     ELECTRON_PLATFORM=win  → Windows NSIS installer (default)
 *   When not set, the script falls back to the host OS: darwin → mac, all others → win.
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
 * Usage (Windows):
 *   VITE_API_BASE_URL=https://your-app.replit.app pnpm run electron:build
 *   VITE_API_BASE_URL=… GH_TOKEN=ghp_… pnpm run electron:build
 *
 * Usage (macOS — via GitHub Actions build-macos.yml or locally on a Mac):
 *   ELECTRON_PLATFORM=mac VITE_API_BASE_URL=https://your-app.replit.app pnpm run electron:build
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Surface the build's identity in the renderer so the login screen can
// display it. Past "Failed to fetch" reports were impossible to attribute
// to a build because we couldn't tell which installer the user was on —
// thread package.json version + short git SHA through Vite as VITE_*
// env vars so they end up baked into the bundle and rendered on the
// login screen.
const pkgVersion = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version || "0.0.0";
let commitSha = process.env.GIT_COMMIT_SHA || process.env.GITHUB_SHA || "";
if (!commitSha) {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    if (r.status === 0) commitSha = (r.stdout || "").trim();
  } catch {
    /* git not available — fall through */
  }
}
const shortSha = commitSha ? commitSha.slice(0, 7) : "";
process.env.VITE_APP_VERSION = pkgVersion;
process.env.VITE_COMMIT_SHA = shortSha;
console.log(`Build identity: v${pkgVersion}${shortSha ? ` (${shortSha})` : ""}`);

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

  const readme =
    "LabTrax Desktop for Windows — Portable Edition\r\n" +
    "===============================================\r\n\r\n" +
    "Installation steps:\r\n\r\n" +
    "  1. Extract this ZIP file — right-click and choose \"Extract All...\"\r\n" +
    "     Make sure to extract the ENTIRE folder, not just LabTrax.exe on its own.\r\n\r\n" +
    "  2. Open the extracted LabTrax folder.\r\n\r\n" +
    "  3. Run LabTrax.exe from inside that folder.\r\n\r\n" +
    "IMPORTANT: LabTrax.exe will not work if moved out of the LabTrax folder.\r\n" +
    "The entire folder must remain together for the app to function correctly.\r\n";

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(output);
    archive.append(Buffer.from(readme, "utf8"), { name: "README.txt" });
    archive.directory(unpackedDir, "LabTrax");

    output.on("close", () => {
      const mb = (archive.pointer() / 1024 / 1024).toFixed(1);
      console.log(`✓ LabTrax-Windows-Portable.zip  (${mb} MB)`);
      console.log(`\nInstall on Windows:`);
      console.log(`  1. Extract the ZIP (the entire LabTrax folder, not just LabTrax.exe)`);
      console.log(`  2. Open the extracted LabTrax folder`);
      console.log(`  3. Run LabTrax\\LabTrax.exe from inside it`);
      resolve();
    });

    archive.on("error", reject);
    archive.finalize();
  });
}

// Determine target platform.
// Priority: ELECTRON_PLATFORM env var → host OS → default to win.
const platformEnv = process.env.ELECTRON_PLATFORM;
const isMac =
  platformEnv === "mac" ||
  (!platformEnv && process.platform === "darwin");

const viteCode = run("pnpm", ["exec", "vite", "build", "--config", "vite.electron.config.ts"]);
if (viteCode !== 0) {
  console.error("\nERROR: Vite build failed.");
  process.exit(viteCode);
}

const builderArgs = [
  "exec",
  "electron-builder",
  isMac ? "--mac" : "--win",
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
    "\nNote: set GH_TOKEN to publish release artifacts to GitHub Releases\n" +
    "for auto-update. Without publishing, users must download new versions manually.",
  );
}

const buildExitCode = run("pnpm", builderArgs);

if (buildExitCode === 0) {
  if (isMac) {
    if (shouldPublish) {
      console.log("\n✓ macOS DMG and latest-mac.yml published. Auto-update is active for this release.");
    } else {
      console.log("\n✓ macOS DMG produced in electron-dist/");
    }
  } else {
    if (shouldPublish) {
      console.log("\n✓ Installer and latest.yml published. Auto-update is active for this release.");
    } else {
      console.log("\n✓ NSIS installer produced in electron-dist/");
    }
    // Always produce the portable ZIP alongside the NSIS installer so that
    // the LabTrax-Windows-Portable workflow artifact is available from every
    // build run, regardless of whether the installer is signed or published.
    await zipUnpacked();
  }
} else if (!isMac) {
  console.warn(
    "\nelectron-builder did not complete (Wine is required on Linux for NSIS).",
  );
  console.warn("Creating portable zip from win-unpacked instead…");
  await zipUnpacked();
} else {
  console.error("\nERROR: macOS build failed. Check that Xcode command-line tools are installed.");
  process.exit(buildExitCode);
}
