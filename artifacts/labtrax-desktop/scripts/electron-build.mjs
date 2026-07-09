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
 * Auto-update publishing (App Storage generic provider):
 *   The publish provider is set to "generic" in electron-builder.yml and
 *   reads UPDATE_FEED_URL (set by scripts/desktop-build-publish.sh) for the
 *   feed URL. electron-builder bakes that URL into resources/app-update.yml
 *   inside the packaged app. electron-updater then fetches
 *   GET /downloads/latest.yml from the same API server that serves the
 *   installer ZIPs to discover new versions automatically.
 *
 *   When UPDATE_FEED_URL is set here, this script writes a temp merged
 *   config (electron-builder.generated.yml) with the URL substituted and
 *   points electron-builder at it, so ad-hoc test builds can use a local
 *   http-server feed without modifying the yml. NEVER pass the override as
 *   a second `--config <json>` argument — electron-builder 26 treats it as
 *   a file path and dies with ENOENT before repacking app.asar.
 *   See docs/auto-update-runbook.md for the test flow.
 *
 * Usage (Windows):
 *   VITE_API_BASE_URL=https://your-app.replit.app pnpm run electron:build
 *   VITE_API_BASE_URL=… UPDATE_FEED_URL=https://your-app.replit.app/downloads pnpm run electron:build
 *
 * Usage (macOS — via GitHub Actions build-macos.yml or locally on a Mac):
 *   ELECTRON_PLATFORM=mac VITE_API_BASE_URL=https://your-app.replit.app pnpm run electron:build
 */

import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
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

const buildNumberFile = resolve(root, "build-number.json");
const buildNumberData = JSON.parse(readFileSync(buildNumberFile, "utf8"));
const prevBuildNumber = buildNumberData.buildNumber ?? 0;
const buildNumber = prevBuildNumber + 1;
buildNumberData.buildNumber = buildNumber;
writeFileSync(buildNumberFile, JSON.stringify(buildNumberData, null, 2) + "\n", "utf8");

process.env.VITE_APP_VERSION = pkgVersion;
process.env.VITE_COMMIT_SHA = shortSha;
process.env.VITE_BUILD_NUMBER = String(buildNumber);
console.log(`Build identity: v${pkgVersion} build ${buildNumber}${shortSha ? ` (${shortSha})` : ""}`);

// ─── Build stamp (staleness guard) ─────────────────────────────────────────
// During the v1.0.5 publish, a broken electron-builder invocation died BEFORE
// repacking app.asar, and the zip fallback silently re-zipped a stale
// win-unpacked from a previous build. Every downstream check passed, and old
// code shipped as a "successful" release.
//
// To make that impossible, each run generates a unique stamp token, writes it
// into the vite output (dist/electron-app/build-stamp.json → packed into
// app.asar), and records the expected token in electron-dist/build-stamp.txt.
// Before zipping, zipUnpacked() greps win-unpacked's packed app files for the
// token and refuses to produce a zip from stale bytes. desktop-build-publish.sh
// additionally greps the final zip before uploading.
const buildStamp =
  `labtrax-build-stamp:v${pkgVersion}:b${buildNumber}:` +
  `${shortSha || "nosha"}:${Date.now()}:${randomBytes(8).toString("hex")}`;
const stampRecordFile = resolve(root, "electron-dist", "build-stamp.txt");
// Remove any stale stamp record up front so an aborted run can never leave a
// token that a later verification step would wrongly trust.
rmSync(stampRecordFile, { force: true });

/**
 * Returns true when the packed application payload inside
 * electron-dist/win-unpacked contains this run's build stamp. Handles both
 * the normal asar layout (resources/app.asar) and the manually staged
 * unpacked layout (resources/app/dist/electron-app/build-stamp.json).
 */
function unpackedContainsStamp() {
  const resources = resolve(root, "electron-dist", "win-unpacked", "resources");
  const candidates = [
    resolve(resources, "app.asar"),
    resolve(resources, "app", "dist", "electron-app", "build-stamp.json"),
  ];
  const needle = Buffer.from(buildStamp, "utf8");
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    if (readFileSync(file).includes(needle)) return true;
  }
  return false;
}

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
// GH_TOKEN is kept as a secondary publish trigger for backward-compatibility
// with the GitHub Actions release.yml workflow (which still attaches build
// artifacts to GitHub Releases for the version history). Setting GH_TOKEN
// alone no longer configures the auto-update channel — UPDATE_FEED_URL is
// required to produce a correct app-update.yml for the generic provider.
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

  // Staleness guard: refuse to zip a win-unpacked that does not contain THIS
  // run's build stamp. Without this, an electron-builder failure that happens
  // before app.asar is repacked silently re-zips the previous build's bytes
  // (this is how the v1.0.5 publish shipped May-28 code as a "success").
  if (!unpackedContainsStamp()) {
    console.error(
      "\nERROR: electron-dist/win-unpacked does NOT contain this run's build stamp.\n" +
      `Expected stamp: ${buildStamp}\n` +
      "electron-builder did not repack the application payload — win-unpacked is\n" +
      "STALE (left over from a previous build). Refusing to create the portable\n" +
      "zip from old code. Check the electron-builder output above for the real\n" +
      "failure (it must at least repack app.asar before the wine/NSIS step).",
    );
    process.exit(1);
  }
  console.log("\n✓ win-unpacked contains this run's build stamp — payload is fresh.");

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

// Embed the build stamp into the freshly built renderer output so it gets
// packed into app.asar, and record the expected token for downstream
// verification (zipUnpacked() below + scripts/desktop-build-publish.sh).
const stampPayload = JSON.stringify(
  {
    stamp: buildStamp,
    version: pkgVersion,
    buildNumber,
    commitSha: shortSha || null,
    builtAt: new Date().toISOString(),
  },
  null,
  2,
) + "\n";
writeFileSync(resolve(root, "dist", "electron-app", "build-stamp.json"), stampPayload, "utf8");
mkdirSync(resolve(root, "electron-dist"), { recursive: true });
writeFileSync(stampRecordFile, buildStamp + "\n", "utf8");
console.log(`Build stamp: ${buildStamp}`);

const builderArgs = [
  "exec",
  "electron-builder",
  isMac ? "--mac" : "--win",
  "--config",
  "electron-builder.yml",
];

if (shouldPublish) {
  if (updateFeedUrl) {
    // IMPORTANT: never pass the publish override as a second
    // `--config {"publish":...}` JSON argument. electron-builder 26 treats
    // that JSON string as a config FILE PATH and dies with ENOENT *before*
    // repacking app.asar — which is exactly how the v1.0.5 publish shipped a
    // stale zip while reporting success. Instead, write a merged temp config
    // with the feed URL substituted and point --config at that file.
    const baseConfigFile = resolve(root, "electron-builder.yml");
    const baseConfig = readFileSync(baseConfigFile, "utf8");
    if (!baseConfig.includes("${UPDATE_FEED_URL}")) {
      console.error(
        "\nERROR: electron-builder.yml no longer contains the ${UPDATE_FEED_URL}\n" +
        "placeholder in its publish block — cannot generate the publish config.\n" +
        "Restore the placeholder or update scripts/electron-build.mjs.",
      );
      process.exit(1);
    }
    const generatedConfigFile = resolve(root, "electron-builder.generated.yml");
    writeFileSync(
      generatedConfigFile,
      "# AUTO-GENERATED by scripts/electron-build.mjs — do not edit or commit.\n" +
      "# electron-builder.yml with ${UPDATE_FEED_URL} substituted for this build.\n" +
      baseConfig.replaceAll("${UPDATE_FEED_URL}", updateFeedUrl),
      "utf8",
    );
    builderArgs[builderArgs.indexOf("electron-builder.yml")] = "electron-builder.generated.yml";
  }
  builderArgs.push("--publish", "always");
  console.log(
    updateFeedUrl
      ? `\nPublishing release artifacts to: ${updateFeedUrl}`
      : "\nPublishing release artifacts via GH_TOKEN (GitHub release assets only — auto-update feed requires UPDATE_FEED_URL)…",
  );
} else {
  console.log(
    "\nNote: set UPDATE_FEED_URL to bake the auto-update feed URL into the\n" +
    "packaged app (app-update.yml). Without it the build is not publishable\n" +
    "and users must download new versions manually.",
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
