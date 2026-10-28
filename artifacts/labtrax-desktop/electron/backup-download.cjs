const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/** Download directly to disk: never send a multi-GB backup through renderer IPC. */
async function downloadBackupToFolder(request, deps) {
  const { url, folderPath, headers = {} } = request ?? {};
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: "Invalid backup URL." }; }
  if (!deps.isAllowedUrl(url) || parsed.pathname !== "/api/admin/backup/generate" ||
      parsed.searchParams.get("deferRecord") !== "1" || parsed.username || parsed.password) {
    return { ok: false, error: "Refused: backup downloads must use the LabTrax API with deferred history." };
  }
  if (typeof folderPath !== "string" || !folderPath.trim()) {
    return { ok: false, error: "A local backup folder is required." };
  }
  const requestedArchiveKind = parsed.searchParams.get("archiveKind") ?? "full";
  if (requestedArchiveKind !== "full" && requestedArchiveKind !== "database-only") {
    return { ok: false, error: "The requested backup contents are invalid." };
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  const totalTimer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 70 * 60_000);
  const abort = () => controller.abort();
  deps.signal?.addEventListener("abort", abort, { once: true });
  if (deps.signal?.aborted) abort();
  let tempPath;
  let fileName;
  let downloadRunId;
  let bytes = 0;
  let phase = "generation and download";
  let idleTimer;
  let integrityFooter = Buffer.alloc(0);
  const log = deps.log ?? (() => {});
  try {
    // Check folder access before spending time generating the archive.
    phase = "local folder access";
    await fs.promises.mkdir(folderPath, { recursive: true });
    await fs.promises.access(folderPath, fs.constants.W_OK);
    phase = "generation and download";
    const safeHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (/^(authorization|x-platform-admin-secret|x-platform-admin-pin|x-labtrax-backup-source)$/i.test(key) &&
          typeof value === "string") safeHeaders[key] = value;
    }
    log({ phase, elapsedMs: Date.now() - startedAt, sizeBytes: bytes });
    // Never forward admin credentials through a redirect.
    const response = await deps.fetch(url, {
      method: "POST", headers: safeHeaders, redirect: "error", signal: controller.signal,
    });
    downloadRunId = response.headers.get("x-backup-run-id") ?? undefined;
    if (downloadRunId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(downloadRunId)) {
      deps.onRunId?.(downloadRunId);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return { ok: false, status: response.status, downloadRunId,
        error: `Backup failed during ${phase}: ${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`}` };
    }
    fileName = /filename="([^"]+)"/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
    if (!fileName || fileName === "." || fileName === ".." || /[/\\\x00-\x1f]/.test(fileName) ||
        !response.body || !response.headers.get("content-type")?.includes("application/octet-stream")) {
      throw new Error("The server did not return a valid encrypted backup download.");
    }
    const archiveKind = response.headers.get("x-backup-archive-kind");
    const coverageVersion = response.headers.get("x-backup-coverage-version");
    const mediaFileCount = Number(response.headers.get("x-backup-media-file-count"));
    const attachmentRowCount = Number(response.headers.get("x-backup-attachment-row-count"));
    const partial = requestedArchiveKind === "full" &&
      ["partial-production", "partial-non-production"].includes(archiveKind);
    const missingFileCount = Number(response.headers.get("x-backup-missing-file-count") ?? 0);
    const validDatabaseOnly = requestedArchiveKind === "database-only" &&
      archiveKind === "database-only" && coverageVersion === "0" && mediaFileCount === 0;
    const validFull = requestedArchiveKind === "full" &&
      (!partial || (Number.isSafeInteger(missingFileCount) && missingFileCount > 0)) &&
      (partial || missingFileCount === 0) &&
      ["complete-production", "complete-non-production", "partial-production", "partial-non-production"].includes(archiveKind) &&
      ["1", "2"].includes(coverageVersion) && Number.isSafeInteger(mediaFileCount) && mediaFileCount >= 0 &&
      Number.isSafeInteger(attachmentRowCount) && attachmentRowCount >= 0;
    if (!validDatabaseOnly && !validFull) {
      throw new Error("The server did not confirm complete database-and-files recovery evidence.");
    }
    const destination = path.join(folderPath, fileName);
    tempPath = path.join(folderPath, `.labtrax-backup-${randomUUID()}.partial`);
    let lastBytesAt = Date.now();
    let lastLogAt = lastBytesAt;
    let lastLoggedBytes = 0;
    const header = [];
    let headerBytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        if (headerBytes < 4) {
          const part = chunk.subarray(0, 4 - headerBytes);
          header.push(part);
          headerBytes += part.length;
        }
        bytes += chunk.length;
        if (chunk.length >= 12) {
          integrityFooter = Buffer.from(chunk.subarray(chunk.length - 12));
        } else {
          integrityFooter = Buffer.concat([integrityFooter, chunk]).subarray(-12);
        }
        lastBytesAt = Date.now();
        if (lastBytesAt - lastLogAt >= 30_000) {
          const elapsed = Math.max(1, lastBytesAt - lastLogAt);
          log({
            phase: "download and local write",
            elapsedMs: lastBytesAt - startedAt,
            sizeBytes: bytes,
            bytesPerSecond: Math.round(((bytes - lastLoggedBytes) * 1000) / elapsed),
          });
          lastLogAt = lastBytesAt;
          lastLoggedBytes = bytes;
        }
        callback(null, chunk);
      },
    });
    phase = "download and local write";
    idleTimer = setInterval(() => {
      if (Date.now() - lastBytesAt >= (deps.idleMs ?? 60_000)) controller.abort();
    }, 1000);
    const stages = [Readable.fromWeb(response.body), counter];
    // The packaged Windows smoke test injects an ENOSPC stream here after
    // writing real bytes to disk. Normal app calls always use the filesystem
    // stream below.
    if (typeof deps.writeGuard === "function") stages.push(deps.writeGuard());
    stages.push(fs.createWriteStream(tempPath, { flags: "wx" }));
    await pipeline(...stages, { signal: controller.signal });
    if (bytes < 44 || Buffer.concat(header).toString("ascii") !== "LTR2") {
      throw new Error("The downloaded archive was truncated or had an invalid encryption header.");
    }
    const footerOffset = bytes - 12;
    const declaredBytes = integrityFooter.length === 12
      ? integrityFooter.readBigUInt64BE(4)
      : -1n;
    if (integrityFooter.length !== 12 ||
        integrityFooter.subarray(0, 4).toString("ascii") !== "LTF1" ||
        declaredBytes !== BigInt(footerOffset)) {
      throw new Error("The downloaded archive is incomplete or missing a valid integrity footer.");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^\d+$/.test(contentLength) && bytes !== Number(contentLength)) {
      throw new Error(`The downloaded archive is incomplete (${bytes} of ${contentLength} bytes received).`);
    }
    phase = "local file verification";
    const handle = await fs.promises.open(tempPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    const stored = await fs.promises.stat(tempPath);
    if (stored.size !== bytes) throw new Error("The saved file size does not match the completed download.");
    await fs.promises.rename(tempPath, destination);
    tempPath = undefined;
    log({ phase: "local file verified", elapsedMs: Date.now() - startedAt, sizeBytes: bytes });
    return { ok: true, path: destination, fileName, sizeBytes: bytes, downloadRunId,
      archiveKind, missingFileCount, partialFailure: partial,
      warnings: partial ? `${missingFileCount} original files unavailable; see missing-files.json. Not a complete recovery point.` : null };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : null;
    const detail = controller.signal.aborted ? "The transfer stalled, was closed, or exceeded its time budget. No partial backup was kept."
      : code ? `Disk/network error ${code}. Check folder access, free disk space, and connectivity.`
      : error instanceof Error ? error.message : "The operation failed.";
    return { ok: false, downloadRunId, error: `Backup failed during ${phase} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${detail}` };
  } finally {
    controller.abort();
    clearTimeout(totalTimer);
    clearInterval(idleTimer);
    deps.signal?.removeEventListener("abort", abort);
    if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
}

module.exports = { downloadBackupToFolder };
