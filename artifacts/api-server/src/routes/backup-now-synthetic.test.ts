import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation";
import { syntheticProviders } from "./backup-now-synthetic-providers";

// This suite must never run against a configured workspace database.
describe("Backup Now real synthetic HTTP/download/restore", () => {
  let app: import("express").Express;
  let backup: typeof import("../lib/backup");
  let pool: import("pg").Pool;
  const secret = randomBytes(32).toString("hex");
  const preservationUserId = `partial-restore-${randomBytes(12).toString("hex")}`;
  const key = "backup-now-synthetic-references";
  const value = JSON.stringify({ storageKey: "synthetic-missing-original.pdf", marker: "synthetic-record-preserved" });
  async function terminalStatus(runId: string) {
    let status: any;
    await vi.waitFor(async () => {
      const response = await request(app).get(`/api/admin/backup/status/${runId}`)
        .set("X-Platform-Admin-Secret", secret);
      expect(response.status).toBe(200);
      status = response.body;
      expect(["completed", "failed"]).toContain(status.state);
    }, { timeout: 90_000, interval: 50 });
    expect(Number((await pool.query("SELECT count(*) FROM backup_runs WHERE download_run_id=$1", [runId])).rows[0].count)).toBe(1);
    return status;
  }
  const binary = (response: any, callback: any) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
    response.on("error", callback);
  };
  const post = (url: string) => request(app).post(url)
    .set("X-Platform-Admin-Secret", secret)
    .set("X-LabTrax-Backup-Source", "development");
  beforeAll(async () => {
    requireIsolatedRestoreTest();
    process.env.PLATFORM_ADMIN_SECRET = secret;
    delete process.env.REPLIT_DEPLOYMENT;
    delete process.env.PRIVATE_OBJECT_DIR;
    ({ pool } = await import("@workspace/db"));
    app = (await import("../app")).default;
    await (await import("./index")).labtraxRoutesReady;
    backup = await import("../lib/backup");
    await pool.query("INSERT INTO system_settings(key,value) VALUES($1,$2)", [key, value]);
    // Exercise the real production plausibility threshold, rather than
    // lowering it for an otherwise almost-empty disposable database.
    await pool.query("INSERT INTO system_settings(key,value) VALUES($1,$2)",
      ["backup-now-synthetic-padding", randomBytes(2 * 1024 * 1024).toString("hex")]);
    await fs.mkdir("uploads/case-media", { recursive: true });
    await fs.writeFile("uploads/case-media/synthetic-present.pdf", Buffer.from("%PDF synthetic backup media only"));
  }, 300000);
  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query("DELETE FROM system_settings WHERE key = ANY($1::text[])",
        [[key, "backup-now-synthetic-padding"]]);
      await pool.query("DELETE FROM users WHERE id=$1", [preservationUserId]);
      for (const name of ["synthetic-present.pdf", "synthetic-missing-original.pdf"]) {
        await fs.rm(path.resolve("uploads/case-media", name), { force: true });
      }
      for (const name of [
        "case-media/partial-target-only.pdf", "case-media/partial-add-from-archive.pdf",
        "profile-photos/partial-existing.png", "profile-photos/partial-target-only.png",
      ]) await fs.rm(path.resolve("uploads", name), { force: true });
    } finally { await pool.end(); }
  });

  it("saves the database and readable media with an explicit missing inventory and no complete-recovery watermark", async () => {
    const response = await post("/api/admin/backup/generate").buffer(true).parse(binary);
    expect(response.status).toBe(200);
    expect(response.headers["x-backup-archive-kind"]).toBe("partial-non-production");
    expect(response.headers["x-backup-missing-file-count"]).toBe("1");
    const zip = new AdmZip(backup.decryptBuffer(response.body));
    const manifest = backup.parseAndValidateBackupManifest(response.body);
    expect(manifest).toMatchObject({ archiveKind: "partial-non-production", recoveryCoverage: "partial", missingFileCount: 1, includesMedia: true });
    expect(JSON.parse(zip.readAsText("missing-files.json"))).toMatchObject({
      missingFileCount: 1, missingReferences: ["case-media/synthetic-missing-original.pdf"],
    });
    expect(zip.readFile("media/synthetic-present.pdf")?.toString()).toBe("%PDF synthetic backup media only");
    expect((await pool.query("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0].value).toBe(value);
    expect(await backup.getLastSuccessfulBackupAt()).toBeNull();
    const { validateCompleteRecovery, restoreCompleteFiles } = await import("../lib/complete-backup");
    const recovery = validateCompleteRecovery(zip)!;
    const destination = await fs.mkdtemp(path.join(process.env.LABTRAX_ISOLATED_RESTORE_ROOT!, "partial-media-"));
    await fs.mkdir(path.join(destination, "case-media"));
    await fs.writeFile(path.join(destination, "case-media/synthetic-present.pdf"), "existing original must survive");
    await fs.writeFile(path.join(destination, "case-media/unrelated.pdf"), "unrelated original must survive");
    const restoredFiles = await restoreCompleteFiles(zip, recovery, destination);
    expect(restoredFiles.preservedExistingFiles).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(path.join(destination, "case-media/synthetic-present.pdf"), "utf8")).toBe("existing original must survive");
    expect(await fs.readFile(path.join(destination, "case-media/unrelated.pdf"), "utf8")).toBe("unrelated original must survive");
    const cleanDestination = await fs.mkdtemp(path.join(process.env.LABTRAX_ISOLATED_RESTORE_ROOT!, "partial-media-empty-"));
    await restoreCompleteFiles(zip, recovery, cleanDestination);
    expect(await fs.readFile(path.join(cleanDestination, "case-media/synthetic-present.pdf"), "utf8")).toBe("%PDF synthetic backup media only");
    await expect(fs.stat(path.join(cleanDestination, "case-media/synthetic-missing-original.pdf"))).rejects.toMatchObject({ code: "ENOENT" });

    const restoredName = `partial_rehearsal_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE DATABASE "${restoredName}"`);
    const targetUrl = new URL(process.env.DATABASE_URL!);
    targetUrl.pathname = "/" + restoredName;
    const dumpPath = path.join(destination, "database.pgdump");
    await fs.writeFile(dumpPath, zip.readFile("db/database.pgdump")!);
    const { resolvePostgresTool } = await import("../lib/pg-tools");
    execFileSync(resolvePostgresTool("pg_restore"), ["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", targetUrl.toString(), dumpPath], { stdio: "pipe", timeout: 180000 });
    const { Pool } = await import("pg");
    const restored = new Pool({ connectionString: targetUrl.toString() });
    try {
      expect((await restored.query("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0].value).toBe(value);
      for (const table of recovery.tables.filter(table => table.schema === "public")) {
        const count = await restored.query(`SELECT count(*)::int AS n FROM public."${table.name.replaceAll('"', '""')}"`);
        expect(count.rows[0].n).toBe(table.rows);
      }
    } finally { await restored.end(); }
    const corrupted = Buffer.from(response.body);
    corrupted[Math.floor(corrupted.length / 2)] ^= 1;
    expect(() => backup.parseAndValidateBackupManifest(corrupted)).toThrow();
    zip.deleteFile("missing-files.json");
    expect(() => validateCompleteRecovery(zip)).toThrow(/inventory/);
  });

  it("records desktop partial delivery as warnings without advancing complete protection", async () => {
    const response = await post("/api/admin/backup/generate?deferRecord=1&source=manual").buffer(true).parse(binary);
    expect(response.status).toBe(200);
    const runId = response.headers["x-backup-run-id"];
    const report = await post("/api/admin/backup/desktop-run-report").send({
      source: "manual", status: "success", fileName: "synthetic-partial.zip.enc",
      sizeBytes: response.body.length, downloadRunId: runId,
    });
    expect(report.status).toBe(200);
    expect(report.body.rejected).not.toBe(true);
    const row = (await pool.query("SELECT archive_kind,status,partial_failure,warnings FROM backup_runs WHERE download_run_id=$1", [runId])).rows[0];
    expect(row).toMatchObject({ archive_kind: "partial-non-production", status: "success", partial_failure: true });
    expect(row.warnings).toContain("1 original files");
    expect(await backup.getLastSuccessfulBackupAt()).toBeNull();
  });

  it("seeds record fingerprints while preserving a full standalone database dump, including when prior records exist", async () => {
    const { captureCompleteBackup } = await import("../lib/complete-backup");
    const { resolvePostgresTool } = await import("../lib/pg-tools");
    const { createHash } = await import("node:crypto");
    const coordinator = await pool.connect();
    try {
      await coordinator.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = (await coordinator.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
      let previous = null as any;
      for (let attempt = 0; attempt < 2; attempt++) {
        const captured = await captureCompleteBackup("uploads", token => execFileSync(resolvePostgresTool("pg_dump"),
          ["--format=custom", "--snapshot=" + token, "--dbname=" + process.env.DATABASE_URL], { maxBuffer: 32 * 1024 * 1024 }), undefined, {
          snapshot, productionDataOnly: true, recordsWithFullArchive: true, allowMissingReferences: true,
          records: { previous, schemaSql: async token => execFileSync(resolvePostgresTool("pg_dump"),
            ["--schema-only", "--format=plain", "--no-owner", "--no-privileges", "--quote-all-identifiers", "--snapshot=" + token,
              "--dbname=" + process.env.DATABASE_URL], { maxBuffer: 32 * 1024 * 1024 }).toString("utf8") },
        });
        expect(captured.pgDump.subarray(0, 5).toString()).toBe("PGDMP");
        expect(captured.manifest.databaseSha256).toBe(createHash("sha256").update(captured.pgDump).digest("hex"));
        expect(captured.manifest).not.toHaveProperty("databaseCapture");
        expect(captured.recordCapture).toBeDefined();
        if (attempt) expect(captured.recordCapture!.delta).toBeTruthy();
        const { captureProductionMedia } = await import("../lib/production-content-capture");
        const { recordInventoryHash } = await import("../lib/postgres-record-delta");
        const evidence = await captureProductionMedia(captured, async () => { throw new Error("No selected media expected"); }, () => new Set());
        expect(evidence.evidence.databaseSha256).toBe(recordInventoryHash(captured.recordCapture!.inventory));
        expect(captured.manifest.databaseSha256).toBe(createHash("sha256").update(captured.pgDump).digest("hex"));
        previous = captured.recordCapture!.inventory;
      }
    } finally { await coordinator.query("ROLLBACK"); coordinator.release(); }
  });

  it("rejects records-only generation and cloud requests before starting work", async () => {
    expect((await post("/api/admin/backup/generate?archiveKind=database-only")).status).toBe(400);
    expect((await post("/api/admin/backup/generate?deferRecord=1&source=manual&archiveKind=database-only")).status).toBe(400);
    for (const destination of ["onedrive", "google-drive", "browser"]) {
      const response = await post("/api/admin/backup/run").send({ destination, archiveKind: "database-only", runId: randomUUID(), respondAsync: true });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/always include production records and original files/);
    }
  });

  it("does not accept an invalid kind, a mismatched source, or downgrade a default complete request", async () => {
    expect((await post("/api/admin/backup/generate?archiveKind=partial")).status).toBe(400);
    expect((await post("/api/admin/backup/generate?archiveKind=database-only")
      .set("X-LabTrax-Backup-Source", "production")).status).toBe(409);
    const response = await post("/api/admin/backup/generate").buffer(true).parse(binary);
    expect(response.status).toBe(200);
    expect(response.headers["x-backup-archive-kind"]).toBe("partial-non-production");
  });

  it.each(["onedrive", "google-drive"] as const)("saves and reads back a warning archive only at the selected synthetic %s destination", async destination => {
    const runId = randomUUID();
    const started = Date.now();
    const response = await post("/api/admin/backup/run").send({ destination, runId, respondAsync: true });
    expect(response.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    const status = await terminalStatus(runId);
    expect(status.state).toBe("completed");
    expect(status.result).toMatchObject({ runId, partialFailure: true });
    const saved = [...syntheticProviders.archives.values()].filter(item => item.destination === destination).at(-1)!;
    expect(saved).toBeDefined();
    const manifest = backup.parseAndValidateBackupManifest(saved.bytes);
    expect(manifest).toMatchObject({ recoveryCoverage: "partial", missingFileCount: 1 });
    expect(await backup.getLastSuccessfulBackupAt()).toBeNull();
  });

  it("acknowledges SFTP ownership asynchronously and keeps invalid destinations failed", async () => {
    const runId = randomUUID();
    const started = Date.now();
    const response = await post("/api/admin/backup/run").send({
      destination: "network",
      path: "sftp://",
      runId,
      respondAsync: true,
    });
    expect(response.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    const status = await terminalStatus(runId);
    expect(status).toMatchObject({ state: "failed", runId });
    expect(status.overallProgress).toBeLessThan(100);
    expect(status.error).toBeTruthy();
    expect((await pool.query(
      "SELECT status,destination FROM backup_runs WHERE download_run_id=$1", [runId],
    )).rows[0]).toMatchObject({ status: "error", destination: "network" });
  });

  it("uses the saved scheduled destination independently from the manual destination and retains warnings", async () => {
    for (const [setting, settingValue] of [
      [backup.SETTING_BACKUP_SCHEDULE_DESTINATION, "google-drive"],
      [backup.SETTING_BACKUP_SCHEDULE_ENABLED, "true"],
      [backup.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "60"],
    ]) await pool.query("INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [setting, settingValue]);
    const response = await post("/api/admin/backup/schedule/run-now").send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ destination: "google-drive", partialFailure: true });
    expect(response.body.warnings).toContain("1 original lab files");
    expect(await backup.getLastSuccessfulBackupAt()).toBeNull();
  });

  it.each(["failUpload", "failReadBack", "failDump", "failEncryption"] as const)("keeps %s as a failed operation, never completed-with-warnings", async flag => {
    syntheticProviders[flag] = true;
    try {
      const runId = randomUUID();
      const response = await post("/api/admin/backup/run").send({ destination: "onedrive", runId, respondAsync: true });
      expect(response.status).toBe(202);
      const status = await terminalStatus(runId);
      expect(status.state).toBe("failed");
      expect(status.result).toBeUndefined();
      expect(status.error).toBeTruthy();
      expect(await backup.getLastSuccessfulBackupAt()).toBeNull();
    } finally { syntheticProviders[flag] = false; }
  });

  it("creates complete recovery evidence once the synthetic exact original is present", async () => {
    await fs.writeFile("uploads/case-media/synthetic-missing-original.pdf", Buffer.from("%PDF exact synthetic original"));
    const response = await post("/api/admin/backup/generate").buffer(true).parse(binary);
    expect(response.status).toBe(200);
    expect(response.headers["x-backup-coverage-version"]).toBe("2");
    const zip = new AdmZip(backup.decryptBuffer(response.body));
    const evidence = JSON.parse(zip.readAsText("complete-recovery.json"));
    expect(evidence.coverageVersion).toBe(2);
    expect(evidence.requiredReferences).toContain("case-media/synthetic-missing-original.pdf");
    expect(zip.readFile("media/synthetic-missing-original.pdf")?.toString()).toBe("%PDF exact synthetic original");
    expect(backup.parseAndValidateBackupManifest(response.body)).toBeDefined();
  });

  it("keeps existing case media and profile photos in place through a full partial-archive restore", async () => {
    // The real restore validator requires an actual user, even in an otherwise
    // schema-only disposable database. This identity cannot log in anywhere.
    await pool.query("INSERT INTO users(id,username,password) VALUES($1,$2,$3)",
      [preservationUserId, preservationUserId, "synthetic-not-a-login-hash"]);
    await fs.rm("uploads/case-media/synthetic-missing-original.pdf", { force: true });
    await fs.mkdir("uploads/profile-photos", { recursive: true });
    await fs.writeFile("uploads/profile-photos/partial-existing.png", "archived photo");
    await fs.writeFile("uploads/case-media/partial-add-from-archive.pdf", "archive-only media");
    const response = await post("/api/admin/backup/generate").buffer(true).parse(binary);
    expect(response.status).toBe(200);
    expect(response.headers["x-backup-archive-kind"]).toBe("partial-non-production");

    await fs.writeFile("uploads/case-media/synthetic-present.pdf", "current original case media");
    await fs.writeFile("uploads/profile-photos/partial-existing.png", "current original photo");
    await fs.writeFile("uploads/case-media/partial-target-only.pdf", "unarchived case media");
    await fs.writeFile("uploads/profile-photos/partial-target-only.png", "unarchived photo");
    await fs.rm("uploads/case-media/partial-add-from-archive.pdf");
    const result = await backup.executeRestore(response.body, "ci:partial-media-preservation");
    expect(result.manifest.preservedExistingFileCount).toBeGreaterThanOrEqual(2);
    for (const [name, contents] of [
      ["case-media/synthetic-present.pdf", "current original case media"],
      ["profile-photos/partial-existing.png", "current original photo"],
      ["case-media/partial-target-only.pdf", "unarchived case media"],
      ["profile-photos/partial-target-only.png", "unarchived photo"],
      ["case-media/partial-add-from-archive.pdf", "archive-only media"],
    ]) expect(await fs.readFile(path.resolve("uploads", name), "utf8")).toBe(contents);
    await expect(fs.stat("uploads/case-media/synthetic-missing-original.pdf"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await pool.query("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0].value).toBe(value);
  });

  if (process.env.LABTRAX_BACKUP_BROWSER_EVIDENCE) {
    it("serves the real settings UI for the owned browser workflow verification", async () => {
      const fixtureUrl = new URL("src/serve-backup-now-synthetic-browser.ts",
        "file://" + (await fs.realpath("../../scripts")) + "/");
      const { serveSyntheticBackupBrowser } = await import(fixtureUrl.href);
      const { validateCompleteRecovery } = await import("../lib/complete-backup");
      await serveSyntheticBackupBrowser(app, secret, backup.decryptBuffer, () =>
        [...syntheticProviders.archives.values()].map(item => {
          const zip = new AdmZip(backup.decryptBuffer(item.bytes));
          validateCompleteRecovery(zip);
          const manifest = JSON.parse(zip.readAsText("manifest.json"));
          return { destination: item.destination, size: item.bytes.length,
            archiveKind: manifest.archiveKind, missingFileCount: manifest.missingFileCount,
            recoveryCoverage: manifest.recoveryCoverage };
        }));
    }, 900000);
  }
});
