/** Operator job: production records/originals straight to the scheduled
 * OneDrive content namespace, independent of a browser session/download. */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const configured = process.env.PROD_DATABASE_URL;
if (!configured) throw new Error("PROD_DATABASE_URL is required for the operator backup.");
const production = new URL(configured); production.searchParams.set("sslmode", "verify-full");
// Bind this isolated operator process before importing any database module.
process.env.DATABASE_URL = production.toString();
process.env.PROD_DATABASE_URL = production.toString();
process.env.PGSSLROOTCERT ||= process.env.SSL_CERT_FILE || "/etc/ssl/certs/ca-certificates.crt";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const { pool } = await import("@workspace/db");
const { runDatabaseProtectionJob, getDatabaseProtectionStatus } = await import("../lib/database-protection-job");
const { captureCompleteBackup } = await import("../lib/complete-backup");
const { captureProductionMedia } = await import("../lib/production-content-capture");
const { buildPgDumpStream, createBackupDeadline, encryptBuffer, decryptBuffer } = await import("../lib/backup");
const { RECORD_DELTA_FORMAT } = await import("../lib/postgres-record-delta");
const stop = new AbortController();
const deadline = createBackupDeadline(12 * 60 * 60 * 1000, stop.signal);
process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
let captured: Awaited<ReturnType<typeof captureCompleteBackup<true>>> | undefined;
const slot = await pool.connect();
const lost = () => stop.abort(); slot.on("error", lost);
let held = false;
const heartbeat = setInterval(() => {
 void getDatabaseProtectionStatus(undefined, "onedrive").then(status => console.log(JSON.stringify({
  state: status.state, stage: status.stage, newBytes: status.newBytes, mediaFiles: status.mediaFiles,
  mediaBytes: status.mediaBytes, missingFiles: status.missingFiles, at: new Date().toISOString(),
 }))).catch(() => console.log("Backup heartbeat unavailable; no success claimed."));
}, 30000);
try {
 held = (await slot.query("SELECT pg_try_advisory_lock(5109, 15) AS held")).rows[0]?.held === true;
 if (!held) throw new Error("Another full backup is active; operator backup did not start.");
 const status = await runDatabaseProtectionJob({
  externalProductionSourceRevision: revision,
  trigger: "manual", destination: "onedrive", intervalMinutes: 15,
  codec: { encrypt: encryptBuffer, decrypt: decryptBuffer }, signal: deadline.signal,
  capture: async (snapshot, previousJournalPosition, onMediaPinned, previousRecords) => {
   captured = await captureCompleteBackup(path.resolve(process.cwd(), "uploads"),
    snapshotToken => buildPgDumpStream(deadline, snapshotToken, 64 * 1024 * 1024, "custom"), deadline.signal, {
     externalProductionSourceRevision: revision,
     archiveDestination: "direct", allowMissingReferences: true, productionDataOnly: true,
     productionJournalAfterPosition: previousJournalPosition, snapshot, onMediaPinned, streamDatabaseDump: true,
     records: { previous: previousRecords ?? null, schemaSql: async snapshotToken => {
      const parts: Buffer[] = [];
      for await (const bytes of buildPgDumpStream(deadline, snapshotToken, 64 * 1024 * 1024, "plain")) parts.push(bytes);
      return Buffer.concat(parts).toString("utf8");
     } },
    });
   if (!captured.recordCapture) throw new Error("Production record evidence is missing.");
   console.log(JSON.stringify({ state: "source-pinned", files: captured.manifest.files.length,
    missingOriginals: captured.manifest.missingReferences?.length ?? 0,
    productionLineageVerified: captured.manifest.provenance.productionLineageVerified }));
   return { kind: RECORD_DELTA_FORMAT, records: captured.recordCapture,
    schemaDump: captured.recordCapture.delta ? null : captured.pgDump };
  },
  captureMedia: async (write, selectPaths) => {
   if (!captured) throw new Error("Production source inventory is unavailable.");
   return captureProductionMedia(captured, write, selectPaths);
  },
 });
 await fs.writeFile("/tmp/labtrax-direct-production-initial-result.json", JSON.stringify(status, null, 2), { mode: 0o600 });
 console.log(JSON.stringify({ result: status }));
 if (status.state !== "verified") process.exitCode = status.state === "partial" ? 2 : 1;
} finally {
 clearInterval(heartbeat);
 await captured?.dispose?.(); deadline.dispose();
 if (held) await slot.query("SELECT pg_advisory_unlock(5109, 15)").catch(() => {});
 slot.removeListener("error", lost); slot.release(); await pool.end();
}
