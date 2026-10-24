import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(desktopRoot, "electron-dist");
const generatedHelper = path.join(desktopRoot, "scripts", "backup-execution-smoke.generated.cjs");
const generatedBuilderConfig = path.join(desktopRoot, "electron-builder.backup-smoke.generated.yml");
const installerMode = process.argv.includes("--installer");
const MiB = 1024 * 1024;
const archiveSize = 256 * MiB;
const chunkSize = MiB;
const archiveChunk = Buffer.alloc(chunkSize, 0x5a);
Buffer.from("LTR2").copy(archiveChunk);
const fillChunk = Buffer.alloc(chunkSize, 0x5a);
// Streamed archives end with an LTF1 footer declaring the preceding byte count.
const finalChunk = Buffer.from(fillChunk);
finalChunk.write("LTF1", chunkSize - 12, "ascii");
finalChunk.writeBigUInt64BE(BigInt(archiveSize - 12), chunkSize - 8);
const completeEvidenceHeaders = {
  "x-backup-archive-kind": "complete-non-production",
  "x-backup-coverage-version": "1",
  "x-backup-media-file-count": "0",
  "x-backup-attachment-row-count": "0",
};

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function calculateExpectedHash() {
  const hash = createHash("sha256");
  hash.update(archiveChunk);
  for (let offset = chunkSize; offset < archiveSize; offset += chunkSize) {
    hash.update(offset + chunkSize >= archiveSize ? finalChunk : fillChunk);
  }
  return hash.digest("hex");
}

const archiveSha256 = calculateExpectedHash();

async function writeChunk(response, chunk) {
  if (response.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("error", onError);
      response.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Synthetic API response closed before draining."));
    };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function startSyntheticApi() {
  const generationRequests = [];
  const reports = [];
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/admin/backup/generate"
      ) {
        const scenario = requestUrl.searchParams.get("smokeScenario");
        generationRequests.push(scenario);
        if (!["success", "interrupted", "disk-full"].includes(scenario)) {
          response.writeHead(400).end("Unknown synthetic backup scenario.");
          return;
        }

        response.writeHead(200, {
          ...completeEvidenceHeaders,
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="synthetic-backup.zip"',
          "content-length": String(archiveSize),
          "x-backup-run-id": `packaged-smoke-${scenario}`,
        });
        response.on("error", () => {});
        if (scenario === "interrupted") {
          await writeChunk(response, archiveChunk);
          await writeChunk(response, fillChunk);
          response.destroy();
          return;
        }
        await writeChunk(response, archiveChunk);
        for (let offset = chunkSize; offset < archiveSize; offset += chunkSize) {
          await writeChunk(response, offset + chunkSize >= archiveSize ? finalChunk : fillChunk);
        }
        response.end();
        return;
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/admin/backup/desktop-run-report"
      ) {
        const scenario = request.headers["x-smoke-scenario"];
        let body;
        try {
          body = JSON.parse(await readRequestBody(request));
        } catch {
          response.writeHead(400).end("Invalid report JSON.");
          return;
        }
        reports.push({ scenario, body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ completedAt: "2026-10-13T12:00:00.000Z" }));
        return;
      }

      response.writeHead(404).end("Not found.");
    })().catch((error) => {
      if (!response.destroyed) response.destroy(error);
    });
  });

  return {
    generationRequests,
    reports,
    server,
  };
}

function runCommand(command, args, env) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? "unknown"}.`);
}

function runNativeCommand(command, args) {
  console.log(`\n$ "${command}" ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

function getInstallerProfileShortcutRoots() {
  const profile = process.env.USERPROFILE;
  const appData = process.env.APPDATA;
  const publicProfile = process.env.PUBLIC;
  const programData = process.env.ProgramData;
  assert(profile, "Windows USERPROFILE is required to verify installer shortcuts.");
  assert(appData, "Windows APPDATA is required to verify installer shortcuts.");
  assert(publicProfile, "Windows PUBLIC is required to verify shared installer shortcuts.");
  assert(programData, "Windows ProgramData is required to verify shared installer shortcuts.");
  return [
    path.join(profile, "Desktop"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(publicProfile, "Desktop"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
  ];
}

async function findLabTraxShortcuts(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not inspect Windows shortcut folder "${directory}": ${error.message}`);
  }

  const matches = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findLabTraxShortcuts(entryPath)));
    } else if (entry.isFile() && /^LabTrax.*\.lnk$/i.test(entry.name)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function queryLabTraxUninstallRegistrations(registryRoot) {
  const result = spawnSync("reg.exe", ["query", registryRoot, "/s", "/f", "LabTrax", "/d"], {
    encoding: "utf8",
    maxBuffer: 8 * MiB,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Could not inspect Windows uninstall registry "${registryRoot}": ${result.error.message}`);
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    if (
      result.status === 1 &&
      /unable to find|unable to locate|specified registry key or value/i.test(output)
    ) {
      return [];
    }
    throw new Error(
      `Could not inspect Windows uninstall registry "${registryRoot}" ` +
        `(exit ${result.status ?? "unknown"}): ${output.trim() || "no diagnostic output"}`,
    );
  }

  const registrations = [];
  let currentKey = "";
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const key = line.trim().match(/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\.+$/i);
    if (key) {
      currentKey = key[0];
      continue;
    }
    const displayName = line.match(/^\s*DisplayName\s+REG_\w+\s+(.+?)\s*$/i)?.[1];
    if (displayName && /^LabTrax(?:\s|$)/i.test(displayName)) {
      registrations.push(`${currentKey} (${displayName})`);
    }
  }
  return registrations;
}

async function assertInstallerProfileIsClean(phase) {
  const shortcutRoots = getInstallerProfileShortcutRoots();
  const registryRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const [shortcutsByRoot, registrationsByRoot] = await Promise.all([
    Promise.all(shortcutRoots.map((root) => findLabTraxShortcuts(root))),
    Promise.all(registryRoots.map((root) => queryLabTraxUninstallRegistrations(root))),
  ]);
  const shortcuts = shortcutsByRoot.flat();
  const registrations = registrationsByRoot.flat();
  assert(
    shortcuts.length === 0,
    `${phase}: LabTrax shortcut(s) remain in the Windows profile: ${shortcuts.join(", ")}`,
  );
  assert(
    registrations.length === 0,
    `${phase}: LabTrax uninstall registration(s) remain in Windows: ${registrations.join(", ")}`,
  );
}

async function assertPathWasRemoved(targetPath, description) {
  try {
    await stat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`Could not verify ${description} "${targetPath}": ${error.message}`);
  }
  fail(`${description} remains after silent uninstall: ${targetPath}`);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

async function launchPackagedApp(executable, env) {
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const timeout = setTimeout(() => child.kill(), 10 * 60_000);
  let code;
  let signal;
  try {
    [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
  } finally {
    clearTimeout(timeout);
  }
  if (code !== 0) {
    fail(
      `Packaged app exited with ${signal ?? `code ${code}`}.\n` +
        `${stdout}\n${stderr}`,
    );
  }
}

function expectedReports(reports) {
  assert(reports.length === 4, `Expected four history reports, received ${reports.length}.`);
  const successful = reports.filter((report) => report.body.status === "success");
  assert(successful.length === 1, `Expected one successful history report, received ${successful.length}.`);
  assert(successful[0].scenario === "success", "A failure scenario was incorrectly reported as successful.");
  for (const scenario of ["interrupted", "unavailable-folder", "disk-full"]) {
    assert(
      reports.some((report) => report.scenario === scenario && report.body.status === "error"),
      `Missing error history report for ${scenario}.`,
    );
  }
}

async function main() {
  if (process.platform !== "win32") {
    fail("The packaged backup smoke test must run on Windows; it exercises the installed Windows Electron runtime.");
  }
  if (process.argv.slice(2).some((argument) => argument !== "--installer")) {
    fail("Supported option: --installer.");
  }
  const platform = "win";

  const smokeRoot = await mkdtemp(path.join(tmpdir(), "labtrax-packaged-backup-smoke-"));
  const selectedBackupRoot = path.join(smokeRoot, "user-selected-backup-folders");
  const installationDirectory = path.join(smokeRoot, "selected-installation");
  let installationAttempted = false;
  const api = startSyntheticApi();
  let baseUrl;
  try {
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    const address = api.server.address();
    if (!address || typeof address === "string") fail("Synthetic API did not bind to a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const buildEnv = {
      ...process.env,
      VITE_API_BASE_URL: baseUrl,
      LABTRAX_SKIP_AUTOUPDATER: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    };
    await mkdir(path.dirname(generatedHelper), { recursive: true });
    await esbuild({
      entryPoints: [path.join(desktopRoot, "src", "lib", "local-backup-execution.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      outfile: generatedHelper,
    });
    try {
      // Windows Git checkouts use CRLF; normalize before matching YAML line anchors.
      const builderConfig = (await readFile(path.join(desktopRoot, "electron-builder.yml"), "utf8"))
        .replace(/\r\n/g, "\n");
      if (!builderConfig.includes("${UPDATE_FEED_URL}")) {
        fail("electron-builder.yml no longer contains the expected update-feed placeholder.");
      }
      const smokeFilesAnchor = "  - electron/**/*\n";
      if (!builderConfig.includes(smokeFilesAnchor)) {
        fail("electron-builder.yml no longer has the expected application file list.");
      }
      const nsisAnchor = "nsis:\n  oneClick: false\n";
      if (installerMode && !builderConfig.includes(nsisAnchor)) {
        fail("electron-builder.yml no longer has the expected NSIS configuration.");
      }
      await writeFile(
        generatedBuilderConfig,
        builderConfig
          .replace(
            smokeFilesAnchor,
            `${smokeFilesAnchor}  - scripts/backup-download-smoke.cjs\n  - scripts/backup-execution-smoke.generated.cjs\n`,
          )
          .replace(
            nsisAnchor,
            installerMode ? `${nsisAnchor}  runAfterFinish: false\n` : nsisAnchor,
          )
          .replaceAll("${UPDATE_FEED_URL}", "https://example.invalid/downloads"),
        "utf8",
      );
      runCommand("pnpm", ["exec", "vite", "build", "--config", "vite.electron.config.ts"], buildEnv);
      await rm(path.join(outputRoot, `${platform}-unpacked`), { recursive: true, force: true });
      runCommand(
        "pnpm",
        [
          "exec",
          "electron-builder",
          `--${platform}`,
          ...(installerMode ? [] : ["--dir"]),
          "--config",
          path.basename(generatedBuilderConfig),
          "--publish",
          "never",
        ],
        buildEnv,
      );
    } finally {
      await unlink(generatedHelper).catch(() => {});
      await unlink(generatedBuilderConfig).catch(() => {});
    }

    let executable = path.join(outputRoot, "win-unpacked", "LabTrax.exe");
    if (installerMode) {
      const installer = path.join(outputRoot, "LabTrax-Setup.exe");
      assert((await stat(installer)).size > 0, "The NSIS setup package is missing or empty.");
      await assertInstallerProfileIsClean("Before NSIS installation");
      installationAttempted = true;
      runNativeCommand(installer, ["/S", `/D=${installationDirectory}`]);
      executable = path.join(installationDirectory, "LabTrax.exe");
      assert((await stat(executable)).isFile(), "The NSIS installer did not install LabTrax.exe into the selected directory.");
    }
    const resultPath = path.join(smokeRoot, "result.json");
    const appEnv = {
      ...process.env,
      VITE_API_BASE_URL: baseUrl,
      LABTRAX_BACKUP_DOWNLOAD_SMOKE: "1",
      LABTRAX_BACKUP_SMOKE_DIR: selectedBackupRoot,
      LABTRAX_BACKUP_SMOKE_SIZE: String(archiveSize),
      LABTRAX_BACKUP_SMOKE_SHA256: archiveSha256,
      LABTRAX_BACKUP_SMOKE_RESULT: resultPath,
      LABTRAX_SKIP_AUTOUPDATER: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
    };
    await launchPackagedApp(executable, appEnv);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert(result.sizeBytes === archiveSize, "Packaged app did not report the expected archive size.");
    assert(result.sha256 === archiveSha256, "Packaged app did not report the expected SHA-256.");
    assert(
      path.dirname(result.archivePath) === path.join(selectedBackupRoot, "success"),
      "The backup was not saved to the selected user backup folder.",
    );
    assert(
      !result.archivePath.toLowerCase().startsWith(`${installationDirectory.toLowerCase()}${path.sep}`),
      "The backup was written inside the application installation directory instead of the selected folder.",
    );
    assert((await stat(result.archivePath)).size === archiveSize, "Packaged archive has the wrong file size.");
    assert((await hashFile(result.archivePath)) === archiveSha256, "Packaged archive bytes did not match.");
    expectedReports(api.reports);
    assert(
      api.generationRequests.filter((scenario) => scenario === "unavailable-folder").length === 0,
      "An unavailable folder still triggered server-side archive generation.",
    );
    for (const scenario of ["success", "interrupted", "disk-full"]) {
      assert(
        api.generationRequests.filter((value) => value === scenario).length === 1,
        `Expected one archive request for ${scenario}.`,
      );
    }

    for (const scenario of ["interrupted", "disk-full"]) {
      const names = await readdir(path.join(selectedBackupRoot, scenario));
      assert(names.length === 0, `${scenario} left files behind: ${names.join(", ")}`);
    }
    console.log(
      `${installerMode ? "Installed" : "Packaged"} backup smoke passed: 256 MiB hash verified; ` +
        "user-selected destination confirmed; all failure artifacts cleaned.",
    );
  } finally {
    await new Promise((resolve) => {
      api.server.close(resolve);
      api.server.closeAllConnections();
    });
    try {
      if (installerMode && installationAttempted) {
        let installedFiles = [];
        try {
          installedFiles = await readdir(installationDirectory);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const uninstallerName = installedFiles.find((name) => /^uninstall.*\.exe$/i.test(name));
        if (uninstallerName) {
          try {
            runNativeCommand(path.join(installationDirectory, uninstallerName), ["/S"]);
          } catch (error) {
            fail(`Silent NSIS uninstall failed; installer cleanup could not be verified: ${error.message}`);
          }
        } else if (installedFiles.length > 0) {
          fail(
            `NSIS installation left files behind without an uninstaller in "${installationDirectory}": ` +
              installedFiles.join(", "),
          );
        }
        await assertPathWasRemoved(installationDirectory, "Selected LabTrax installation folder");
        await assertInstallerProfileIsClean("After silent NSIS uninstall");
      }
    } finally {
      await rm(smokeRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
