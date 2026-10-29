/** Operator-only, additive database safety copies. These DO NOT claim media
 * coverage or establish a production incremental media baseline. */
import pg from "pg";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { resolvePostgresTool } from "../lib/pg-tools";
import { verifyProductionBackupSource } from "../lib/backup-production-source";
import { getOneDriveStatus, uploadBackupFileToOneDrive, getOneDriveFileByName, downloadFileFromOneDrive } from "../lib/onedrive";

const target = process.argv[2];
if (!["production", "development"].includes(target)) throw new Error("Specify production or development explicitly.");
const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
if (!secret) throw new Error("Backup encryption key is not configured.");
const key = createHash("sha256").update(secret).digest();
const raw = target === "production" ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!raw) throw new Error("Requested database binding is not configured.");
if (target === "development" && raw === process.env.PROD_DATABASE_URL) throw new Error("Refusing to label the production binding as development.");
const url = new URL(raw);
// Production always validates TLS. Development retains its configured binding
// (Replit's local development database can explicitly use sslmode=disable).
if (target === "production") url.searchParams.set("sslmode", "verify-full");
const folder = "Apps/LabTrax Backups/direct-initial/database-exports/" + target;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const fileName = "LabTrax-" + target + "-DATABASE-ONLY-" + stamp + ".zip.enc";
const directory = await fs.mkdtemp(path.join(tmpdir(), "labtrax-direct-db-"));
await fs.chmod(directory, 0o700);
const dumpFile = path.join(directory, "database.dump");
const encryptedFile = path.join(directory, fileName);
const exportPool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
const client = await exportPool.connect();
let transaction = false;
async function command(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(resolvePostgresTool(executable as "pg_dump" | "pg_restore"), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let bytes = 0; child.stdout.on("data", (data: Buffer) => { bytes += data.length; });
  // Never print child stderr: connection diagnostics can contain credentials.
  const diagnostics: Buffer[] = []; let diagnosticBytes = 0;
  child.stderr.on("data", (data: Buffer) => { if (diagnosticBytes < 65536) { diagnostics.push(data); diagnosticBytes += data.length; } });
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error(executable + " could not start.")));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(executable + " failed: " + (() => {
      const text = Buffer.concat(diagnostics).toString("utf8");
      if (/server version.*pg_dump version/s.test(text)) return "PostgreSQL client/server version mismatch";
      if (/certificate|SSL error|root certificate/i.test(text)) return "TLS certificate verification failure";
      if (/snapshot/i.test(text)) return "snapshot import failure";
      if (/password authentication failed/i.test(text)) return "database authentication failure";
      if (/permission denied/i.test(text)) return "database permission denied";
      if (/read-only/i.test(text)) return "read-only transaction restriction";
      if (/could not translate|timeout|connection refused/i.test(text)) return "database connection unavailable";
      return "unclassified export failure (diagnostics withheld)";
    })())));
  });
  return bytes;
}
async function fileHash(file: string) {
  const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
try {
  const status = await getOneDriveStatus();
  if (!status.connected) throw new Error("OneDrive connection unavailable; export not started.");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
  await client.query("SET LOCAL statement_timeout = '60s'");
  const lineage = target === "production" ? await verifyProductionBackupSource(client) : null;
  const counts = (await client.query("SELECT (SELECT count(*)::int FROM cases) AS cases, (SELECT count(*)::int FROM invoices) AS invoices, (SELECT count(*)::int FROM users) AS users")).rows[0];
  const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLROOTCERT: process.env.PGSSLROOTCERT || process.env.SSL_CERT_FILE || "/etc/ssl/certs/ca-certificates.crt", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get("sslmode") || "verify-full", PGCONNECT_TIMEOUT: "15", PGOPTIONS: "-c default_transaction_read_only=on" };
  console.log(JSON.stringify({ target, state: "exporting", counts, productionLineageVerified: !!lineage }));
  await command("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--snapshot=" + snapshot, "--file=" + dumpFile], env);
  await client.query("ROLLBACK"); transaction = false;
  const dumpBytes = (await fs.stat(dumpFile)).size;
  if (dumpBytes < 1024 || dumpBytes > 128 * 1024 * 1024) throw new Error("Database safety export size is outside the bounded verification limit.");
  if (!await command("pg_restore", ["--list", dumpFile], env)) throw new Error("Empty database restore inventory.");
  const dumpSha256 = await fileHash(dumpFile);
  const manifest = { appName: "LabTrax", archiveKind: "database-only", sourceEnvironment: target, createdAt: new Date().toISOString(),
    productionLineageVerified: !!lineage, fingerprintSha256: lineage, ...counts, databaseFormat: "PostgreSQL custom", databaseSha256: dumpSha256,
    mediaIncluded: false, completeRecoveryPoint: false, incrementalMediaBaseline: false };
  const zip = archiver("zip", { zlib: { level: 6 } });
  zip.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  zip.append("DATABASE SAFETY EXPORT ONLY. Original photos, videos and attachments are NOT included. This does not establish the scheduled media baseline. Operator recovery: decrypt LTR2 using AES-256-GCM and SHA-256 of the configured BACKUP_ENCRYPTION_KEY (JWT_SECRET fallback); restore database.dump with pg_restore into an isolated new database. Never overwrite production for a verification test. A successful pg_restore --list check is NOT a complete restore rehearsal.", { name: "RESTORE-INSTRUCTIONS.txt" });
  zip.file(dumpFile, { name: "database.dump" });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const output = createWriteStream(encryptedFile, { mode: 0o600 });
  output.write(Buffer.concat([Buffer.from("LTR2"), iv]));
  const transfer = pipeline(zip, cipher, output, { end: false });
  await zip.finalize(); await transfer;
  output.end(cipher.getAuthTag()); await new Promise<void>((resolve, reject) => { output.once("finish", resolve); output.once("error", reject); });
  // Authenticate and inspect the actual encrypted output before any upload.
  const decrypt = (bytes: Buffer) => {
    if (bytes.subarray(0,4).toString() !== "LTR2") throw new Error("Encrypted header mismatch.");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4,16)); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(16,-16)), decipher.final()]);
  };
  const localZip = new AdmZip(decrypt(await fs.readFile(encryptedFile)));
  if (createHash("sha256").update(localZip.readFile("database.dump")!).digest("hex") !== dumpSha256) throw new Error("Encrypted database contents failed verification.");
  console.log(JSON.stringify({ target, state: "uploading", encryptedBytes: (await fs.stat(encryptedFile)).size }));
  const uploaded = await uploadBackupFileToOneDrive(encryptedFile, fileName, { folder });
  const item = await getOneDriveFileByName(fileName, folder, uploaded.itemId);
  if (!item || item.size !== (await fs.stat(encryptedFile)).size) throw new Error("OneDrive size verification failed.");
  const remote = await downloadFileFromOneDrive(fileName, item.size, folder, item.id);
  const remoteHash = createHash("sha256"); const parts: Buffer[] = []; let readBytes = 0;
  for await (const part of remote as AsyncIterable<Buffer>) { const data = Buffer.from(part); readBytes += data.length; if (readBytes > item.size) throw new Error("Remote content exceeds expected length."); remoteHash.update(data); parts.push(data); }
  if (readBytes !== item.size || remoteHash.digest("hex") !== await fileHash(encryptedFile)) throw new Error("OneDrive read-back checksum mismatch.");
  const recovered = new AdmZip(decrypt(Buffer.concat(parts)));
  if (createHash("sha256").update(recovered.readFile("database.dump")!).digest("hex") !== dumpSha256) throw new Error("OneDrive database payload failed authenticated read-back.");
  const receipt = { target, state: "verified-database-export-only", fileName, folder, bytes: item.size, counts, databaseSha256: dumpSha256,
    verifiedAt: new Date().toISOString(), mediaIncluded: false, completeRecoveryPoint: false, incrementalMediaBaseline: false };
  await fs.writeFile(path.join(tmpdir(), "labtrax-direct-" + target + "-receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  if (transaction) await client.query("ROLLBACK").catch(() => {});
  client.release();
  await exportPool.end();
  await fs.rm(directory, { recursive: true, force: true });
}
