const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { executeLocalBackup } = require("./backup-execution-smoke.generated.cjs");

const MiB = 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createDiskFullGuard(limitBytes) {
  let acceptedBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (acceptedBytes >= limitBytes) {
        const error = new Error("Simulated disk full during backup write.");
        error.code = "ENOSPC";
        callback(error);
        return;
      }
      acceptedBytes += chunk.length;
      callback(null, chunk);
    },
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

async function assertNoPartialFiles(folderPath) {
  let names = [];
  try {
    names = await fs.promises.readdir(folderPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert(
    !names.some((name) => name.endsWith(".partial")),
    `Unexpected partial backup remained in ${folderPath}: ${names.join(", ")}`,
  );
}

function makeExecutionDeps({
  scenario,
  apiOrigin,
  fetch,
  downloadBackupToFolder,
  isAllowedUrl,
}) {
  return {
    apiFetch: async (endpoint, options) => {
      const response = await fetch(`${apiOrigin}/api${endpoint}`, {
        method: options.method,
        headers: {
          "content-type": "application/json",
          "x-smoke-scenario": scenario,
        },
        body: options.body,
      });
      if (!response.ok) {
        throw new Error(`Synthetic history API returned HTTP ${response.status}.`);
      }
      return response.json();
    },
    apiFetchArrayBuffer: async () => {
      throw new Error("Packaged smoke test must not buffer the archive in the renderer.");
    },
    downloadBackupToFolder: async (folder) => {
      const url = new URL("/api/admin/backup/generate", apiOrigin);
      url.searchParams.set("deferRecord", "1");
      url.searchParams.set("smokeScenario", scenario);
      const result = await downloadBackupToFolder(
        { url: url.toString(), folderPath: folder, headers: {} },
        {
          fetch,
          isAllowedUrl,
          ...(scenario === "disk-full"
            ? { writeGuard: () => createDiskFullGuard(2 * MiB) }
            : {}),
        },
      );
      if (!result.ok) {
        const error = new Error(result.error ?? "Packaged backup download failed.");
        error.downloadRunId = result.downloadRunId;
        throw error;
      }
      return {
        fileName: result.fileName,
        path: result.path,
        sizeBytes: result.sizeBytes,
        downloadRunId: result.downloadRunId,
      };
    },
  };
}

async function expectExecutionFailure(deps, folderPath, messagePart) {
  const failureReports = [];
  const observedDeps = {
    ...deps,
    apiFetch: async (endpoint, options) => {
      if (endpoint === "/admin/backup/desktop-run-report") {
        const report = JSON.parse(options.body);
        if (report.status === "error") failureReports.push(report);
      }
      return deps.apiFetch(endpoint, options);
    },
  };
  let failure;
  try {
    await executeLocalBackup(observedDeps, folderPath, "manual");
  } catch (error) {
    failure = error;
  }
  assert(failure, `Expected backup execution to fail${messagePart ? ` during ${messagePart}` : ""}.`);
  assert(
    String(failure.message).includes("The backup did not complete"),
    `Expected the safe incomplete-backup message, received "${failure.message}".`,
  );
  assert(failureReports.length === 1, "Each failed backup must submit exactly one error history report.");
  if (messagePart) {
    // Specific filesystem diagnostics belong in history, not the user-facing summary.
    assert(
      String(failureReports[0].error).toLowerCase().includes(messagePart.toLowerCase()),
      `Expected history failure containing "${messagePart}", received "${failureReports[0].error}".`,
    );
  }
}

async function runPackagedBackupDownloadSmoke({
  fetch,
  downloadBackupToFolder,
  isAllowedUrl,
}) {
  const apiOrigin = process.env.VITE_API_BASE_URL;
  const root = process.env.LABTRAX_BACKUP_SMOKE_DIR;
  const expectedSize = Number(process.env.LABTRAX_BACKUP_SMOKE_SIZE);
  const expectedHash = process.env.LABTRAX_BACKUP_SMOKE_SHA256;
  if (!apiOrigin || !root || !Number.isSafeInteger(expectedSize) || !expectedHash) {
    throw new Error("Packaged backup smoke test configuration is incomplete.");
  }

  const makeDeps = (scenario) =>
    makeExecutionDeps({
      scenario,
      apiOrigin,
      fetch,
      downloadBackupToFolder,
      isAllowedUrl,
    });

  const successFolder = path.join(root, "success");
  const success = await executeLocalBackup(makeDeps("success"), successFolder, "manual");
  assert(success.sizeBytes === expectedSize, "Successful archive size did not match the synthetic source.");
  assert((await fs.promises.stat(success.path)).size === expectedSize, "Saved archive size did not match.");
  assert((await sha256File(success.path)) === expectedHash, "Saved archive SHA-256 did not match the source.");
  await assertNoPartialFiles(successFolder);

  const interruptedFolder = path.join(root, "interrupted");
  await expectExecutionFailure(makeDeps("interrupted"), interruptedFolder, null);
  assert((await fs.promises.readdir(interruptedFolder)).length === 0, "Interrupted transfer left a file behind.");

  const blocker = path.join(root, "unavailable-folder");
  await fs.promises.writeFile(blocker, "not a folder");
  const unavailableFolder = path.join(blocker, "nested");
  await expectExecutionFailure(
    makeDeps("unavailable-folder"),
    unavailableFolder,
    "local folder access",
  );

  const diskFullFolder = path.join(root, "disk-full");
  await expectExecutionFailure(makeDeps("disk-full"), diskFullFolder, "ENOSPC");
  assert((await fs.promises.readdir(diskFullFolder)).length === 0, "Disk-full simulation left a file behind.");

  await assertNoPartialFiles(root);
  const outputPath = process.env.LABTRAX_BACKUP_SMOKE_RESULT;
  if (!outputPath) throw new Error("Packaged backup smoke test result path is missing.");
  await fs.promises.writeFile(
    outputPath,
    JSON.stringify({
      archivePath: success.path,
      sizeBytes: success.sizeBytes,
      sha256: expectedHash,
      scenarios: ["success", "interrupted", "unavailable-folder", "disk-full"],
    }),
  );
}

module.exports = { runPackagedBackupDownloadSmoke };
