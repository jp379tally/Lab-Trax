import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation";

// Explicitly opt-in: never contact providers from the ordinary API suite.
// Only source-created disposable databases and synthetic media may be used.
describe.skipIf(process.env.LABTRAX_CONNECTED_BACKUP_TESTS !== "1")(
  "connected private destination delivery of a synthetic partial archive", () => {
    let pool: import("pg").Pool;
    let backup: typeof import("../lib/backup");
    let cipher: Buffer;
    let evidence: Array<Record<string, unknown>> = [];
    const marker = `synthetic-connected-${randomUUID()}`;
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    beforeAll(async () => {
      requireIsolatedRestoreTest();
      if (process.env.REPLIT_DEPLOYMENT === "1" || process.env.PRIVATE_OBJECT_DIR) {
        throw new Error("Connected synthetic delivery requires isolated local media, not a live storage namespace.");
      }
      ({ pool } = await import("@workspace/db"));
      const secret = randomBytes(32).toString("hex");
      process.env.PLATFORM_ADMIN_SECRET = secret;
      const app = (await import("../app")).default;
      await (await import("./index")).labtraxRoutesReady;
      backup = await import("../lib/backup");
      const value = JSON.stringify({
        storageKey: "connected-synthetic-missing.pdf",
        marker: "synthetic-record-preserved",
      });
      await pool.query("INSERT INTO system_settings(key,value) VALUES($1,$2),($3,$4)", [
        marker, value, `${marker}-padding`, randomBytes(2 * 1024 * 1024).toString("hex"),
      ]);
      // A restorable application database needs a user. This disposable identity
      // deliberately has no usable login hash and never exists outside the test.
      await pool.query("INSERT INTO users(id,username,password) VALUES($1,$2,$3)",
        [marker, marker, "synthetic-not-a-login-hash"]);
      await fs.mkdir("uploads/case-media", { recursive: true });
      await fs.writeFile("uploads/case-media/connected-synthetic-readable.pdf", "%PDF synthetic connected-delivery verification");
      const response = await request(app).post("/api/admin/backup/generate")
        .set("X-Platform-Admin-Secret", secret)
        .set("X-LabTrax-Backup-Source", "development")
        .buffer(true).parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => done(null, Buffer.concat(chunks)));
          res.on("error", done);
        }).send({});
      expect(response.status).toBe(200);
      cipher = response.body as Buffer;
      expect(backup.parseAndValidateBackupManifest(cipher)).toMatchObject({
        archiveKind: "partial-non-production", missingFileCount: 1,
      });
    }, 180_000);

    afterAll(async () => {
      if (process.env.LABTRAX_CONNECTED_BACKUP_EVIDENCE) {
        await fs.writeFile(process.env.LABTRAX_CONNECTED_BACKUP_EVIDENCE,
          JSON.stringify({ syntheticOnly: true, productionBackupVerified: false, evidence }, null, 2), { mode: 0o600 });
      }
      await pool?.end();
    });

    it.each(["OneDrive", "Google Drive"])(
      "%s saves, reads back, opens and restores the exact encrypted synthetic archive", async provider => {
        const fileName = `LabTrax-SYNTHETIC-verification-${randomUUID()}.zip.enc`;
        const source = { size: cipher.length,
          readChunk: async (offset: number, length: number) => cipher.subarray(offset, offset + length) };
        let stored: { id: string; name: string; size: number };
        let stream: NodeJS.ReadableStream;
        if (provider === "OneDrive") {
          const drive = await import("../lib/onedrive");
          expect((await drive.getOneDriveStatus()).connected).toBe(true);
          const folder = `${drive.ONEDRIVE_NON_PRODUCTION_FOLDER}/synthetic-verification/${randomUUID()}`;
          const uploaded = await drive.uploadBackupSourceToOneDrive(source, fileName, { folder });
          const item = await drive.getOneDriveFileByName(fileName, folder, uploaded.itemId);
          expect(item).not.toBeNull();
          stored = item!;
          stream = await drive.downloadFileFromOneDrive(fileName, cipher.length, folder, stored.id);
        } else {
          const drive = await import("../lib/google-drive");
          expect((await drive.getGoogleDriveStatus()).connected).toBe(true);
          const folder = `${drive.GOOGLE_DRIVE_NON_PRODUCTION_FOLDER}/synthetic-verification/${randomUUID()}`;
          const folderId = await drive.getGoogleDriveFolderIdForPath(folder);
          const uploaded = await drive.uploadGoogleDriveBackupSource(source, fileName,
            { folderOverride: { id: folderId, path: folder } });
          const item = await drive.getGoogleDriveFileById(uploaded.id);
          expect(item).not.toBeNull();
          stored = item!;
          stream = await drive.downloadGoogleDriveBackupFile(stored.id, cipher.length);
        }
        expect(stored.name).toBe(fileName);
        expect(stored.size).toBe(cipher.length);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const downloaded = Buffer.concat(chunks);
        expect(digest(downloaded)).toBe(digest(cipher));
        const zip = new AdmZip(backup.decryptBuffer(downloaded));
        expect(JSON.parse(zip.readAsText("missing-files.json")).missingReferences)
          .toEqual(["case-media/connected-synthetic-missing.pdf"]);
        expect(zip.readAsText("media/connected-synthetic-readable.pdf"))
          .toBe("%PDF synthetic connected-delivery verification");
        const delivered = { provider, fileName, itemId: stored.id, size: stored.size,
          sha256: digest(cipher), readBackSha256: digest(downloaded), isolatedRestorePassed: false,
          missingFileCount: 1, completeRecoveryPoint: false };
        evidence.push(delivered);
        const restored = await backup.executeRestore(downloaded, "ci:connected-synthetic-only");
        expect(restored.manifest.recoveryCoverage).toBe("partial");
        expect((await pool.query("SELECT count(*) FROM system_settings WHERE key=$1", [marker])).rows[0].count).toBe("1");
        expect(JSON.parse((await pool.query("SELECT value FROM system_settings WHERE key=$1", [marker])).rows[0].value).storageKey)
          .toBe("connected-synthetic-missing.pdf");
        expect((await pool.query("SELECT count(*) FROM users WHERE id=$1", [marker])).rows[0].count).toBe("1");
        expect(await fs.readFile(path.resolve("uploads/case-media/connected-synthetic-readable.pdf"), "utf8"))
          .toBe("%PDF synthetic connected-delivery verification");
        await expect(fs.stat("uploads/case-media/connected-synthetic-missing.pdf"))
          .rejects.toMatchObject({ code: "ENOENT" });
        delivered.isolatedRestorePassed = true;
        // Retain these explicitly named synthetic archives for owner inspection;
        // never list, prune or remove any prior user backup.
      }, 240_000,
    );
  },
);
