/**
 * Real pg_dump → encrypted ZIP → OneDrive transport → real pg_restore.
 * Never run directly: the isolated runner clones schema only and fences cwd/DB.
 * Live cloud IO is opt-in and touches only this test's uniquely named archive.
 * No runBackup/prune calls: retained customer recovery archives are never deleted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { requireIsolatedRestoreTest } from "../lib/restore-test-isolation";

vi.mock("../lib/mail.js", () => ({
  sendBackupNotificationEmail: vi.fn(),
  sendBackupStaleAlertEmail: vi.fn(),
}));

describe("Isolated synthetic OneDrive recovery", () => {
  const prefix = `restore-probe-${randomUUID()}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const actor = `ci:isolated-restore:${prefix}`;
  const fileName = `${prefix}.zip.enc`;
  const live = process.env.LABTRAX_VERIFY_LIVE_ONEDRIVE === "1";
  let db: typeof import("@workspace/db");
  let backup: typeof import("../lib/backup");
  let cloud: typeof import("../lib/onedrive");
  let encrypted: Buffer;
  let downloaded: Buffer;
  const cloudIds: string[] = [];
  let manifest: Record<string, unknown>;
  let baselineCases: number;
  const mediaBytes = Buffer.from("Synthetic case evidence, not a customer file.\n");
  const mediaKey = `${prefix}.txt`;
  const mediaPath = path.resolve("uploads/case-media", mediaKey);
  const archivePath = path.resolve(`${prefix}.zip.enc`);

  beforeAll(async () => {
    requireIsolatedRestoreTest();
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "synthetic-disposable-restore-key");
    db = await import("@workspace/db");
    backup = await import("../lib/backup");
    cloud = await import("../lib/onedrive");
    const { rows } = await db.pool.query("SELECT current_database() AS name");
    expect(rows[0].name).toBe("labtrax_restore_test");
    baselineCases = Number((await db.pool.query(
      "SELECT count(*) FROM cases WHERE deleted_at IS NULL",
    )).rows[0].count);
    await db.db.insert(db.users).values({
      id: id("user"), username: id("user"), password: "synthetic-not-a-login",
    });
    await db.db.insert(db.organizations).values([
      { id: id("lab"), name: id("lab"), type: "lab" },
      { id: id("practice"), name: id("practice"), type: "provider" },
    ]);
    await db.db.insert(db.organizationMemberships).values([
      { id: id("lab-member"), userId: id("user"), labId: id("lab"), role: "owner" },
      { id: id("practice-member"), userId: id("user"), labId: id("practice"), role: "owner" },
    ]);
    await db.db.insert(db.cases).values([
      {
        id: id("case"), caseNumber: id("case"), labOrganizationId: id("lab"),
        providerOrganizationId: id("practice"), createdByUserId: id("user"),
        patientFirstName: "Synthetic", patientLastName: "Fixture", doctorName: "Synthetic Doctor",
      },
      {
        id: id("deleted-case"), caseNumber: id("deleted-case"), labOrganizationId: id("lab"),
        providerOrganizationId: id("practice"), createdByUserId: id("user"),
        patientFirstName: "Synthetic", patientLastName: "Deleted", doctorName: "Synthetic Doctor",
        deletedAt: new Date(),
      },
    ]);
    await db.db.insert(db.invoices).values({
      id: id("invoice"), invoiceNumber: id("invoice"), labOrganizationId: id("lab"),
      providerOrganizationId: id("practice"), createdByUserId: id("user"), caseId: id("case"),
      status: "open", subtotal: "125.00", total: "125.00", balanceDue: "125.00",
    });
    await db.db.insert(db.caseAttachments).values({
      id: id("attachment"), caseId: id("case"), uploadedByUserId: id("user"),
      uploadedByOrganizationId: id("lab"), fileName: mediaKey, storageKey: mediaKey,
      fileType: "text/plain",
    });
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.writeFileSync(mediaPath, mediaBytes);
    encrypted = (await backup.buildBackupZipBuffer(actor)).buffer;
    fs.writeFileSync(archivePath, encrypted);
    manifest = backup.parseAndValidateBackupManifest(encrypted);
  });

  afterAll(async () => {
    // Delete exactly the synthetic item ID resolved from our unique archive.
    // Never invoke the retention policy, including when a test fails.
    if (live) {
      for (const cloudId of cloudIds) await cloud.deleteOneDriveBackupFile(cloudId);
    }
    cloud?.setOneDriveFetchForTests(null);
    backup?._setUploadInspectionForTests(null);
    if (db) {
      await db.pool.query("DELETE FROM case_attachments WHERE id = $1", [id("attachment")]);
      await db.pool.query("DELETE FROM invoices WHERE id = $1", [id("invoice")]);
      await db.pool.query("DELETE FROM cases WHERE id = ANY($1::varchar[])", [[id("case"), id("deleted-case")]]);
      await db.pool.query("DELETE FROM lab_memberships WHERE user_id = $1", [id("user")]);
      await db.pool.query("DELETE FROM organizations WHERE id = ANY($1::varchar[])", [[id("lab"), id("practice")]]);
      await db.pool.query("DELETE FROM users WHERE id = $1", [id("user")]);
      await db.pool.end();
    }
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(mediaPath, { force: true });
    vi.unstubAllEnvs();
  });

  it("authenticates the generated archive and distinguishes active counts from all dumped rows", () => {
    expect(manifest.exportedBy).toBe(actor);
    expect(manifest.caseCount).toBe(baselineCases + 1);
    const zip = new AdmZip(backup.decryptBuffer(encrypted));
    expect(zip.getEntry("db/database.pgdump")!.getData().subarray(0, 5).toString()).toBe("PGDMP");
    expect(zip.getEntry(`media/${mediaKey}`)!.getData()).toEqual(mediaBytes);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => backup.decryptBuffer(tampered)).toThrow();
  });

  it("arms the enabled OneDrive schedule on the next 15-minute slot and clears it when disabled", async () => {
    const keys = [...backup.ALL_SCHEDULE_SETTINGS];
    const original = (await db.pool.query(
      "SELECT key, value FROM system_settings WHERE key = ANY($1::text[])", [keys],
    )).rows;
    // The schedule is a slot-anchored setTimeout chain rather than a fixed
    // setInterval: a bare interval re-armed a full period on every restart, so
    // a server restarting more often than the period took no backups at all.
    // Both spies call through, so the timers armed here are really cleared.
    const timer = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    // Only the schedule arms minute-scale timers here; the pool's connect
    // timeout is exactly 60s, so a strict lower bound excludes it.
    const scheduleDelays = () =>
      timer.mock.calls
        .map(([, delay]) => delay)
        .filter((delay): delay is number => typeof delay === "number" && delay > 60_000);
    // Pin the wall clock away from a slot boundary. The schedule arms the
    // remainder of the current slot, so a run that starts within a minute of
    // :00/:15/:30/:45 legitimately arms a sub-minute timer — which the filter
    // above (rightly, for the pool's 60s connect timeout) discards, failing a
    // correct schedule roughly one run in fifteen. Only Date is faked; the
    // timers themselves stay real so the clear assertions still mean something.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:03:07.000Z"));
    try {
      for (const [key, value] of [
        [backup.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "15"],
        [backup.SETTING_BACKUP_SCHEDULE_DESTINATION, "onedrive"],
        [backup.SETTING_BACKUP_SCHEDULE_ENABLED, "true"],
      ]) {
        await db.pool.query(
          "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [key, value],
        );
      }
      // A stale due time would be honoured on purpose; clear it so this test
      // measures a freshly computed slot.
      await db.pool.query("DELETE FROM system_settings WHERE key = $1", [
        backup.SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
      ]);
      expect(await backup.getBackupScheduleConfig()).toMatchObject({
        intervalMinutes: 15, destination: "onedrive", enabled: true,
      });
      await backup.restartScheduledBackupJob();

      // Exactly one schedule timer, never further out than one 15-minute
      // period, and anchored to a wall-clock slot that survives a restart.
      expect(scheduleDelays()).toHaveLength(1);
      expect(scheduleDelays()[0]).toBeLessThanOrEqual(900_000);
      const nextDueAt = (await backup.getBackupScheduleState()).nextDueAt;
      expect(nextDueAt).not.toBeNull();
      expect(nextDueAt!.getTime() % 900_000).toBe(0);
      expect(nextDueAt!.getTime()).toBeGreaterThan(Date.now());

      await db.pool.query("UPDATE system_settings SET value = 'false' WHERE key = $1", [
        backup.SETTING_BACKUP_SCHEDULE_ENABLED,
      ]);
      await backup.restartScheduledBackupJob();
      expect(clear).toHaveBeenCalled();
      // Disabling arms nothing further.
      expect(scheduleDelays()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      // Always disable/clear any test timer before restoring the saved settings.
      await db.pool.query("UPDATE system_settings SET value = 'false' WHERE key = $1", [
        backup.SETTING_BACKUP_SCHEDULE_ENABLED,
      ]);
      await backup.restartScheduledBackupJob();
      timer.mockRestore();
      clear.mockRestore();
      await db.pool.query("DELETE FROM system_settings WHERE key = ANY($1::text[])", [keys]);
      for (const row of original) {
        await db.pool.query("INSERT INTO system_settings (key, value) VALUES ($1, $2)", [row.key, row.value]);
      }
    }
  });

  it("restores the exact renamed archive after a collision and multi-page listing", async () => {
    if (!live) {
      vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "synthetic-connector.invalid");
      vi.stubEnv("REPL_IDENTITY", "synthetic-identity");
      const stored = new Map<string, { name: string; bytes: Buffer }>();
      let session = 0;
      cloud.setOneDriveFetchForTests(async (url, init) => {
        if (url.includes("/api/v2/connection")) {
          return { ok: true, status: 200, json: async () => ({
            items: [{ settings: { access_token: "synthetic-token" } }],
          }), text: async () => "" };
        }
        if (url.endsWith("/createUploadSession")) {
          session++;
          expect(init?.headers?.Authorization).toBe("Bearer synthetic-token");
          // The folder this server owns: production writes to the lab's backup
          // folder, every other environment to its non-production subfolder,
          // so a CI archive can never be mistaken for (or prune) a real one.
          const folder = cloud.getOneDriveBackupFolder().replace(/ /g, "%20");
          expect(url).toContain(`${folder}/${fileName}`);
          return { ok: true, status: 200, json: async () => ({
            uploadUrl: `https://synthetic-upload.invalid/session-${session}`,
          }), text: async () => "" };
        }
        if (init?.method === "PUT") {
          const itemId = `synthetic-item-${session}`;
          const name = session === 1 ? fileName : fileName.replace(".zip.enc", ".zip 1.enc");
          const bytes = Buffer.from(init.body as Uint8Array);
          stored.set(itemId, { name, bytes });
          return { ok: true, status: 201, json: async () => ({
            size: bytes.length, name, id: itemId,
          }), text: async () => "" };
        }
        expect(init?.headers?.Authorization).toBe("Bearer synthetic-token");
        if (url.includes("/children?") && !url.includes("page=2")) {
          return { ok: true, status: 200, json: async () => ({
            value: [
              { id: "synthetic-item-1", name: fileName, file: {}, size: stored.get("synthetic-item-1")!.bytes.length },
              { id: "customer-directory", name: "retained.zip.enc", folder: {} },
              { id: "customer-notes", name: "notes.txt", file: {} },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?page=2",
          }), text: async () => "" };
        }
        if (url.includes("/children?page=2")) {
          const item = stored.get("synthetic-item-2")!;
          return { ok: true, status: 200, json: async () => ({
            value: [{ id: "synthetic-item-2", name: item.name, file: {}, size: item.bytes.length }],
          }), text: async () => "" };
        }
        if (url.includes("/me/drive/items/")) {
          const itemId = decodeURIComponent(url.split("/me/drive/items/")[1]!.split(/[/?]/)[0]!);
          const item = stored.get(itemId)!;
          expect(item).toBeDefined();
          if (!url.endsWith("/content")) return {
            ok: true, status: 200, json: async () => ({ id: itemId, name: item.name, size: item.bytes.length }),
            text: async () => "",
          };
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => "",
            headers: new Headers({ "Content-Length": String(item.bytes.length) }),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(item.bytes);
                controller.close();
              },
            }),
          };
        }
        throw new Error("Unexpected synthetic Graph request");
      });
    }
    // The original-name item deliberately contains different bytes. Downloading
    // it instead of the second completed item must fail digest/authentication.
    const old = await cloud.uploadBackupToOneDrive(Buffer.from("older synthetic archive"), fileName);
    cloudIds.push(old.itemId);
    const uploaded = await cloud.uploadBackupFileToOneDrive(archivePath, fileName);
    cloudIds.push(uploaded.itemId);
    expect(uploaded.itemId).not.toBe(old.itemId);
    expect(uploaded.fileName).not.toBe(old.fileName);
    const retained = (await cloud.listOneDriveBackupFiles()).find(file => file.id === uploaded.itemId);
    expect(retained).toBeDefined();
    expect(uploaded.size).toBe(encrypted.length);
    expect(retained!.size).toBe(encrypted.length);
    expect(retained!.name).toBe(uploaded.fileName);
    const confirmed = await cloud.getOneDriveFileByName(uploaded.fileName, undefined, uploaded.itemId);
    expect(confirmed).toMatchObject({ id: uploaded.itemId, size: encrypted.length, name: uploaded.fileName });
    // Persist the same fields written by normal backup history, then use that
    // durable reference after losing the in-memory upload response.
    const [history] = await db.db.insert(db.backupRuns).values({
      destination: "onedrive", triggeredBy: actor, status: "success",
      path: cloud.oneDriveItemPath(uploaded.itemId), fileName: uploaded.fileName, sizeBytes: uploaded.size,
    }).returning();
    const downloadedStream = await cloud.downloadFileFromOneDrive(
      history.fileName!,
      history.sizeBytes!,
      undefined,
      cloud.oneDriveItemIdFromPath(history.path),
    );
    const downloadedChunks: Buffer[] = [];
    let downloadedSize = 0;
    for await (const chunk of downloadedStream) {
      const bytes = Buffer.from(chunk);
      downloadedChunks.push(bytes);
      downloadedSize += bytes.length;
    }
    downloaded = Buffer.concat(downloadedChunks, downloadedSize);
    expect(createHash("sha256").update(downloaded).digest("hex"))
      .toBe(createHash("sha256").update(encrypted).digest("hex"));
    expect(backup.parseAndValidateBackupManifest(downloaded).exportedBy).toBe(actor);
    console.info(`OneDrive restore probe: transport=${live ? "live authenticated Graph" : "synthetic Graph"}, source=isolated synthetic database, bytes=${downloaded.length}, sha256=${createHash("sha256").update(downloaded).digest("hex")}`);
  });

  it("restores lost case/invoice values and media, all relationships, soft-deleted rows, and enforced foreign keys", async () => {
    // Change only our disposable fixtures so surviving live rows cannot make
    // the test pass when pg_restore is skipped or only the manifest is read.
    await db.pool.query("UPDATE cases SET patient_last_name = 'Changed' WHERE id = $1", [id("case")]);
    await db.pool.query("DELETE FROM case_attachments WHERE id = $1", [id("attachment")]);
    await db.pool.query("DELETE FROM invoices WHERE id = $1", [id("invoice")]);
    fs.unlinkSync(mediaPath);
    await backup.executeRestore(downloaded, actor);
    expect(backup.getRestoreState().phase).toBe("done");
    const restored = await db.pool.query(`
      SELECT c.patient_last_name, i.total, a.storage_key, lm.user_id
      FROM cases c
      JOIN invoices i ON i.case_id = c.id
      JOIN case_attachments a ON a.case_id = c.id
      JOIN organizations l ON l.id = c.lab_organization_id
      JOIN organizations p ON p.id = c.provider_organization_id
      JOIN users u ON u.id = c.created_by_user_id AND u.id = i.created_by_user_id
        AND u.id = a.uploaded_by_user_id
      JOIN lab_memberships lm ON lm.lab_id = l.id AND lm.user_id = u.id
      JOIN lab_memberships pm ON pm.lab_id = p.id AND pm.user_id = u.id
      WHERE c.id = $1 AND a.uploaded_by_organization_id = l.id
        AND i.lab_organization_id = l.id AND i.provider_organization_id = p.id
    `, [id("case")]);
    expect(restored.rows).toEqual([{
      patient_last_name: "Fixture", total: "125.00", storage_key: mediaKey, user_id: id("user"),
    }]);
    expect(fs.readFileSync(mediaPath)).toEqual(mediaBytes);
    expect((await db.pool.query("SELECT deleted_at FROM cases WHERE id = $1", [id("deleted-case")]))
      .rows[0].deleted_at).not.toBeNull();
    expect((await backup.runPostRestoreValidation({
      expectedCaseCount: manifest.caseCount as number, expectedInvoiceCount: manifest.invoiceCount as number,
    })).valid).toBe(true);
    // Recheck every FK's actual rows, including already-validated constraints.
    const constraints = await db.pool.query<{ check_sql: string }>(`
      SELECT format('SELECT count(*)::int AS n FROM %s s WHERE %s AND NOT EXISTS (SELECT 1 FROM %s t WHERE %s)',
        conrelid::regclass,
        string_agg(format('s.%I IS NOT NULL', sa.attname), ' AND ' ORDER BY k.n),
        confrelid::regclass,
        string_agg(format('s.%I = t.%I', sa.attname, ta.attname), ' AND ' ORDER BY k.n)) AS check_sql
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY k(s, t, n)
      JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = k.s
      JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.t
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      GROUP BY c.oid, conrelid, confrelid
    `);
    expect(constraints.rows.length).toBeGreaterThan(20);
    for (const fk of constraints.rows) {
      expect((await db.pool.query(fk.check_sql)).rows[0].n, fk.check_sql).toBe(0);
    }
    await expect(db.pool.query(
      "UPDATE cases SET created_by_user_id = $1 WHERE id = $2",
      [id("nonexistent"), id("case")],
    )).rejects.toMatchObject({ code: "23503" });
  });
});
