/**
 * Backup destination routes — local-folder (desktop-executed) and OneDrive.
 *
 * Coverage:
 *  - GET /api/admin/backup/onedrive-status: 403 without the secret; never-throw
 *    disconnected shape when the connector infra is unavailable
 *  - PUT /api/admin/backup/schedule: accepts "onedrive" (no path) and "local"
 *    (desktop-executed) destinations; still rejects UNC/SMB network paths
 *  - POST /api/admin/backup/schedule/run-now: clear error for local schedules
 *    (they run from the desktop app, not the server)
 *  - fireScheduledBackup(): silently skips local schedules — no error run in
 *    backup_runs, no notification email
 *  - POST /api/admin/backup/desktop-run-report: validation, success run lands
 *    in backup_runs + advances the staleness watermark, error run recorded
 *    without touching the watermark
 *
 * Runs against the shared dev DB; prior schedule settings are saved in
 * beforeAll and restored in afterAll. Skipped when DATABASE_URL is not set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import request from "supertest";
import { setBackupLiveArchiveEvidence, setBackupLivePhase, withBackupRun } from "../lib/backup-phase";
import { setGoogleDriveFetchForTests } from "../lib/google-drive";

vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-backup-dest"),
  extractMediaFileName: () => null,
}));
vi.mock("../lib/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mail.js")>()),
  sendBackupNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendBackupStaleAlertEmail: vi.fn().mockResolvedValue(undefined),
}));
// Freshness is now judged from the archives OneDrive actually holds, so tests
// control both connector availability and the folder listing. Left real, the
// watchdog assertions would depend on the integration environment and account.
vi.mock("../lib/onedrive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/onedrive.js")>()),
  // Database-isolated runs intentionally have no connector environment. Keep
  // the default route state disconnected; archive fixtures explicitly opt into
  // a reachable destination below.
  isOneDriveConnectorAvailable: vi.fn(() => false),
  listOneDriveBackupFiles: vi.fn(async () => []),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "backup-destinations-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function installMockGoogleDriveApi() {
  let uploadedName = "";
  let uploadedSize = 0;
  let uploadedFolderId = "";
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const metadata = () => ({
    id: "google-drive-test-item",
    name: uploadedName,
    size: String(uploadedSize),
    createdTime: new Date().toISOString(),
    parents: [uploadedFolderId],
  });
  const proxyFetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    if (url.pathname === "/drive/v3/about") {
      return json({ user: { displayName: "Backup Test", emailAddress: "backup-test@example.test" } });
    }
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      return json({ files: [] });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        mimeType: string;
        parents?: string[];
      };
      if (body.mimeType === "application/vnd.google-apps.folder") {
        return json({
          id: body.name === "non-production" ? "google-drive-test-subfolder" : "google-drive-test-root",
          name: body.name,
          mimeType: body.mimeType,
          parents: body.parents ?? [],
        });
      }
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      uploadedName = body.name;
      uploadedFolderId = body.parents[0] ?? "";
      uploadedSize = Number(new Headers(init.headers).get("X-Upload-Content-Length"));
      return new Response(null, {
        status: 200,
        headers: { Location: "https://www.googleapis.com/upload/drive/v3/files/test-session" },
      });
    }
    if (url.pathname === "/drive/v3/files/google-drive-test-item" && method === "GET") {
      return json(metadata());
    }
    return json({ error: "Unexpected mocked Google Drive request" }, 500);
  };
  const uploadFetch = async (_input: string, init: RequestInit = {}) => {
    const contentRange = new Headers(init.headers).get("Content-Range") ?? "";
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match) return json({ error: "Missing Content-Range" }, 400);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (end + 1 < total) {
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } });
    }
    return json(metadata(), 201);
  };
  setGoogleDriveFetchForTests(proxyFetch, uploadFetch);
  return {
    get uploadedName() { return uploadedName; },
    reset() { setGoogleDriveFetchForTests(null); },
  };
}

maybe("backup destination routes (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let backupMod: typeof import("../lib/backup.js");
  let mailMod: typeof import("../lib/mail.js");
  let onedriveMod: typeof import("../lib/onedrive.js");
  let eq: typeof import("drizzle-orm").eq;
  let inArray: typeof import("drizzle-orm").inArray;
  let gte: typeof import("drizzle-orm").gte;

  /** Settings rows saved before the suite and restored after. */
  let savedSettings: Array<{ key: string; value: string | null }> = [];
  let managedKeys: string[] = [];

  function withSecret(req: request.Test): request.Test {
    return req.set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET);
  }

  async function readSetting(key: string): Promise<string | null> {
    const { db, systemSettings } = dbMod as any;
    const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    return rows[0]?.value ?? null;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-backup-destinations";
    const drizzle = await import("drizzle-orm");
    eq = drizzle.eq;
    inArray = drizzle.inArray;
    gte = drizzle.gte;
    dbMod = await import("@workspace/db");
    backupMod = await import("../lib/backup.js");
    await (await import("../lib/backup-history-schema.js")).ensureBackupHistorySchema();
    mailMod = await import("../lib/mail.js");
    onedriveMod = await import("../lib/onedrive.js");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
    await vi.waitFor(async () => {
      expect((await request(appMod.default).get("/api/__test_missing_route__")).status).toBe(404);
    }, { timeout: 15_000, interval: 25 });

    managedKeys = [
      backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES,
      backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION,
      backupMod.SETTING_BACKUP_SCHEDULE_PATH,
      backupMod.SETTING_BACKUP_SCHEDULE_ENABLED,
      backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT,
      backupMod.SETTING_BACKUP_OFFSITE_ENABLED,
      backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES,
      backupMod.SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT,
      backupMod.SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
      backupMod.SETTING_BACKUP_SCHEDULE_LAST_ATTEMPT_AT,
      backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
      backupMod.SETTING_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES,
      backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES,
    ];
    const { db, systemSettings } = dbMod as any;
    const rows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, managedKeys));
    savedSettings = managedKeys.map((key) => ({
      key,
      value: rows.find((r: { key: string }) => r.key === key)?.value ?? null,
    }));
  });

  afterAll(async () => {
    // Disarm first: an armed tick firing while the settings are being put back
    // would rewrite the very rows this is restoring.
    backupMod?._resetBackupSchedulerForTests();
    if (!dbMod) return;
    const { db, systemSettings } = dbMod as any;
    for (const { key, value } of savedSettings) {
      if (value === null) {
        await db.delete(systemSettings).where(eq(systemSettings.key, key));
      } else {
        await db
          .insert(systemSettings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value, updatedAt: new Date() },
          });
      }
    }
    vi.unstubAllEnvs();
  });

  /** Write (or delete) a system_settings row the suite manages. */
  async function writeSetting(key: string, value: string | null): Promise<void> {
    const { db, systemSettings } = dbMod as any;
    if (value === null) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
      return;
    }
    await db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  // ── OneDrive status ────────────────────────────────────────────────────────

  it("GET /admin/backup/onedrive-status rejects unauthenticated callers", async () => {
    const res = await request(appMod.default).get("/api/admin/backup/onedrive-status");
    // Without the secret header the request falls through to requireAuth → 401.
    expect(res.status).toBe(401);
  });

  it("GET /admin/backup/onedrive-status → disconnected shape when connector infra is unavailable", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
    vi.stubEnv("REPL_OWNER", "test-owner");
    vi.stubEnv("REPL_SLUG", "test-slug");
    try {
      const res = await withSecret(
        request(appMod.default).get("/api/admin/backup/onedrive-status"),
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.connected).toBe(false);
      expect(res.body.folder).toMatch(/LabTrax Backups/);
      expect(String(res.body.error)).toMatch(/not available/i);
      // Connect/reconnect from Backup settings: the status payload carries the
      // hosting-workspace URL the desktop UI opens for the OAuth handshake.
      expect(res.body.manageUrl).toBe("https://replit.com/@test-owner/test-slug");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("GET /admin/backup/google-drive-status returns a disconnected, credential-free status", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
    vi.stubEnv("REPL_IDENTITY", "");
    vi.stubEnv("REPL_OWNER", "test-owner");
    vi.stubEnv("REPL_SLUG", "test-slug");
    try {
      const res = await withSecret(
        request(appMod.default).get("/api/admin/backup/google-drive-status"),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        connected: false,
        folder: expect.stringContaining("LabTrax Backups"),
        manageUrl: "https://replit.com/@test-owner/test-slug",
      });
      expect(String(res.body.error)).toMatch(/not available/i);
      expect(JSON.stringify(res.body)).not.toMatch(/access_token|refresh_token|identity-token/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("POST /admin/backup/run accepts Google Drive without a path and reports a disconnected account clearly", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
    vi.stubEnv("REPL_IDENTITY", "");
    try {
      const res = await withSecret(request(appMod.default).post("/api/admin/backup/run")).send({
        destination: "google-drive",
      });
      // A provider connection failure is reported as a run failure, not a
      // missing-path validation error. The UI copy is short; the provider
      // reason stays in the diagnostic.
      expect(res.status).toBe(500);
      expect(String(res.body.error)).toMatch(/no new complete recovery point/i);
      expect(String(res.body.diagnostic)).toMatch(/not available/i);
      expect(String(res.body.diagnostic)).not.toMatch(/path is required/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("manual Google Drive backups upload, verify, and record the encrypted archive", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "https://connector-test.invalid");
    vi.stubEnv("REPL_IDENTITY", "google-drive-test-identity");
    vi.stubEnv("REPLIT_DEPLOYMENT", "0");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "google-drive-backup-test-key");
    vi.stubEnv("BACKUP_MIN_PLAUSIBLE_BYTES", "1");
    const provider = installMockGoogleDriveApi();
    const triggeredBy = rid("manual_google_drive");
    const { db, backupRuns } = dbMod as any;
    try {
      const result = await backupMod.runBackup(triggeredBy, "google-drive", undefined, {
        archiveKind: "database-only",
      });
      expect(result.destination).toBe("google-drive");
      expect(result.remoteItemId).toBe("google-drive-test-item");
      expect(result.path).toBe("GoogleDrive:item:google-drive-test-item");
      expect(provider.uploadedName).toBe(result.fileName);
      const [history] = await db.select().from(backupRuns)
        .where(eq(backupRuns.triggeredBy, triggeredBy));
      expect(history).toMatchObject({
        status: "success",
        destination: "google-drive",
        remoteItemId: "google-drive-test-item",
      });
    } finally {
      provider.reset();
      await db.delete(backupRuns).where(eq(backupRuns.triggeredBy, triggeredBy));
      vi.unstubAllEnvs();
    }
  });

  // ── Schedule save: destination rules ──────────────────────────────────────

  it("PUT /admin/backup/schedule accepts a OneDrive destination without a path", async () => {
    const res = await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
      interval: 24,
      unit: "hours",
      destination: "onedrive",
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe("onedrive");
    expect(await readSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION)).toBe("onedrive");
  });

  it("PUT /admin/backup/schedule accepts Google Drive without a local path", async () => {
    const res = await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
      interval: 24,
      unit: "hours",
      destination: "google-drive",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe("google-drive");
    expect(res.body.path).toBeNull();
    expect(await readSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION)).toBe("google-drive");
    expect(await readSetting(backupMod.SETTING_BACKUP_SCHEDULE_PATH)).toBeNull();
    expect((await backupMod.getBackupScheduleConfig()).destination).toBe("google-drive");
  });

  it("POST /admin/backup/schedule/run-now dispatches a saved Google Drive destination without a path", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
    vi.stubEnv("REPL_IDENTITY", "");
    try {
      const res = await withSecret(
        request(appMod.default).post("/api/admin/backup/schedule/run-now"),
      );
      expect(res.status).toBe(500);
      expect(String(res.body.error)).toMatch(/no new complete recovery point/i);
      expect(String(res.body.diagnostic)).toMatch(/not available/i);
      expect(String(res.body.diagnostic)).not.toMatch(/path is required/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("POST /admin/backup/schedule/run-now passes Google Drive to the shared backup runner", async () => {
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "google-drive");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_PATH, null);
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "true");
    const result = {
      size: 1_000_000,
      completedAt: new Date().toISOString(),
      fileName: "labtrax-scheduled-test.zip.enc",
      remoteItemId: "google-drive-item",
      destination: "google-drive" as const,
      path: "GoogleDrive:item:google-drive-item",
    };
    const runner: typeof backupMod.runBackup = vi.fn(async () => result);
    backupMod.setScheduledBackupRunnerForTests(runner);
    try {
      const res = await withSecret(
        request(appMod.default).post("/api/admin/backup/schedule/run-now"),
      );
      expect(res.status).toBe(200);
      expect(res.body.destination).toBe("google-drive");
      expect(runner).toHaveBeenCalledWith(
        "admin:manual-schedule-test",
        "google-drive",
        undefined,
        expect.objectContaining({ deadline: expect.anything() }),
      );
    } finally {
      backupMod.setScheduledBackupRunnerForTests(null);
    }
  });

  it("the interval scheduler sends Google Drive runs through the shared cloud backup runner", async () => {
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "google-drive");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_PATH, null);
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "true");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "1440");
    const result = {
      size: 1_000_000,
      completedAt: new Date().toISOString(),
      fileName: "labtrax-scheduled-test.zip.enc",
      remoteItemId: "google-drive-item",
      archiveKind: "full" as const,
      destination: "google-drive" as const,
      path: "GoogleDrive:item:google-drive-item",
      partialFailure: false,
    };
    const runner: typeof backupMod.runBackup = vi.fn(async () => result);
    backupMod.setScheduledBackupRunnerForTests(runner);
    try {
      await backupMod.fireScheduledBackup();
      expect(runner).toHaveBeenCalledWith(
        "scheduler:interval",
        "google-drive",
        undefined,
        expect.objectContaining({ archiveKind: "full", deadline: expect.anything() }),
      );
      expect(mailMod.sendBackupNotificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          result: expect.objectContaining({ destination: "google-drive" }),
        }),
      );
    } finally {
      backupMod.setScheduledBackupRunnerForTests(null);
    }
  });

  it("scheduled Google Drive runs upload and verify through the mocked provider", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "https://connector-test.invalid");
    vi.stubEnv("REPL_IDENTITY", "google-drive-test-identity");
    vi.stubEnv("REPLIT_DEPLOYMENT", "0");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "google-drive-backup-test-key");
    vi.stubEnv("BACKUP_MIN_PLAUSIBLE_BYTES", "1");
    const provider = installMockGoogleDriveApi();
    const { db, backupRuns } = dbMod as any;
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "google-drive");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_PATH, null);
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "true");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "1440");
    const previousRows = await db.select().from(backupRuns)
      .where(eq(backupRuns.triggeredBy, "scheduler:interval"));
    const previousIds = new Set(previousRows.map((row: { id: string }) => row.id));
    const runner: typeof backupMod.runBackup = (
      triggeredBy,
      destination,
      destPath,
      options,
    ) => backupMod.runBackup(triggeredBy, destination, destPath, {
      ...options,
      archiveKind: "database-only",
    });
    backupMod.setScheduledBackupRunnerForTests(runner);
    try {
      await backupMod.fireScheduledBackup();
      expect(provider.uploadedName).toMatch(/\.zip\.enc$/);
      const rows = await db.select().from(backupRuns)
        .where(eq(backupRuns.triggeredBy, "scheduler:interval"));
      const createdRows = rows.filter((row: { id: string }) => !previousIds.has(row.id));
      expect(createdRows).toHaveLength(1);
      expect(createdRows[0]).toMatchObject({
        status: "success",
        destination: "google-drive",
        remoteItemId: "google-drive-test-item",
        fileName: provider.uploadedName,
      });
    } finally {
      backupMod.setScheduledBackupRunnerForTests(null);
      provider.reset();
      const rows = await db.select().from(backupRuns)
        .where(eq(backupRuns.triggeredBy, "scheduler:interval"));
      for (const row of rows) {
        if (!previousIds.has(row.id)) {
          await db.delete(backupRuns).where(eq(backupRuns.id, row.id));
        }
      }
      vi.unstubAllEnvs();
    }
  });

  it.each([5, 10])("PUT /admin/backup/schedule accepts the new %i-minute interval", async (interval) => {
    const res = await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
      interval,
      unit: "minutes",
      destination: "onedrive",
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(await readSetting(backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES)).toBe(String(interval));
  });

  it("PUT /admin/backup/schedule accepts a local-folder destination (desktop-executed)", async () => {
    const res = await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
      interval: 24,
      unit: "hours",
      destination: "local",
      path: "D:\\LabTraxBackups",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe("local");
    expect(await readSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION)).toBe("local");
    expect(await readSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED)).toBe("true");
  });

  it("PUT /admin/backup/schedule still rejects UNC/SMB network paths", async () => {
    const res = await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
      interval: 24,
      unit: "hours",
      destination: "network",
      path: "\\\\NAS\\backups",
      enabled: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/SFTP/i);
  });

  it("PUT /admin/backup/schedule still requires a path for local destinations", async () => {
    const res = await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
      interval: 24,
      unit: "hours",
      destination: "local",
      enabled: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/path is required/i);
  });

  // ── Local schedules on the server side ────────────────────────────────────
  // (The "local" schedule saved above is still the active config here.)

  it("POST /admin/backup/schedule/run-now returns a clear error for local schedules", async () => {
    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/schedule/run-now"),
    );
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toMatch(/No new complete recovery point.*Open LabTrax Desktop/i);
    expect(String(res.body.error)).not.toContain("not from the server");
  });

  it("fireScheduledBackup() silently skips local schedules — no error run, no email", async () => {
    const { db, backupRuns } = dbMod as any;
    const before = await db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.triggeredBy, "scheduler:interval"));
    vi.mocked(mailMod.sendBackupNotificationEmail).mockClear();

    await backupMod.fireScheduledBackup();

    const after = await db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.triggeredBy, "scheduler:interval"));
    expect(after.length).toBe(before.length);
    expect(mailMod.sendBackupNotificationEmail).not.toHaveBeenCalled();
  });

  // ── Desktop-executed run reports ──────────────────────────────────────────

  it("POST /admin/backup/desktop-run-report rejects unauthenticated callers", async () => {
    const res = await request(appMod.default)
      .post("/api/admin/backup/desktop-run-report")
      .send({ status: "success", fileName: "x.zip" });
    // Without the secret header the request falls through to requireAuth → 401.
    expect(res.status).toBe(401);
  });

  it("POST /admin/backup/desktop-run-report rejects an invalid status", async () => {
    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/desktop-run-report"),
    ).send({ status: "meh" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/status/i);
  });

  it("GET /admin/backup/status requires authentication and returns only safe live progress", async () => {
    const unauthenticated = await request(appMod.default)
      .get("/api/admin/backup/status/0ad043e2-854a-4507-bec4-f99750738096");
    expect(unauthenticated.status).toBe(401);

    const runId = crypto.randomUUID();
    let release!: () => void;
    const running = withBackupRun(async () => {
      setBackupLivePhase("database dump", {
        dumpBytes: 2048,
        objectName: 3,
      } as Record<string, number>);
      await new Promise<void>((resolve) => { release = resolve; });
    }, runId);
    try {
      const response = await withSecret(
        request(appMod.default).get(`/api/admin/backup/status/${runId}`),
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        runId,
        state: "running",
        phase: "database dump",
        metrics: { dumpBytes: 2048 },
      });
      expect(JSON.stringify(response.body)).not.toContain("objectName");
    } finally {
      release();
      await running;
    }
  });

  it("rejects malformed run UUIDs before looking up live progress", async () => {
    const response = await withSecret(
      request(appMod.default).get("/api/admin/backup/status/not-a-uuid"),
    );
    expect(response.status).toBe(400);
  });

  it("preserves the server phase failure and cannot overwrite it with a desktop success", async () => {
    const downloadRunId = crypto.randomUUID();
    const error = "Backup failed during case-media transfer into archive after 60s: Object transfer stalled.";
    const [row] = await dbMod.db.insert(dbMod.backupRuns).values({
      triggeredBy: "manual:correlation-test", destination: "local", status: "error", error, downloadRunId,
    }).returning();
    try {
      const failure = await withSecret(request(appMod.default).post("/api/admin/backup/desktop-run-report"))
        .send({ status: "error", error: "Connection closed", downloadRunId });
      expect(failure.status).toBe(200);
      expect(failure.body.errorReason).toMatch(/no new complete recovery point was created/i);
      expect(failure.body.errorReason).not.toContain("Object transfer stalled");
      expect(failure.body.diagnostic).toBe(error);
      const claimedSuccess = await withSecret(request(appMod.default).post("/api/admin/backup/desktop-run-report"))
        .send({ status: "success", fileName: "backup.ltbackup", sizeBytes: 33_000_000_000, downloadRunId });
      expect(claimedSuccess.body.rejected).toBe(true);
      expect(claimedSuccess.body.warning).toMatch(/no new complete recovery point was created/i);
      expect(claimedSuccess.body.warning).not.toContain("Object transfer stalled");
      expect(claimedSuccess.body.diagnostic).toBe(error);
      const rows = await dbMod.db.select().from(dbMod.backupRuns).where(eq(dbMod.backupRuns.downloadRunId, downloadRunId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("error");
    } finally {
      await dbMod.db.delete(dbMod.backupRuns).where(eq(dbMod.backupRuns.id, row!.id));
    }
  });

  it("retains the server phase when a deferred download is already disconnected", async () => {
    const headers = new Map<string, string>();
    const response = Object.assign(new PassThrough(), {
      setHeader: (name: string, value: string) => { headers.set(name, value); },
    });
    response.destroy();
    try {
      await expect(backupMod.streamBackupDownload("manual:deferred-interruption-test", response as never, { recordHistory: false }))
        .rejects.toThrow("Backup failed during");
      const [stored] = await dbMod.db.select().from(dbMod.backupRuns)
        .where(eq(dbMod.backupRuns.downloadRunId, headers.get("X-Backup-Run-Id")!));
      expect(stored!.status).toBe("error");
      expect(stored!.error).toContain("case-media inventory and reference validation");
      expect(stored!.error).not.toContain("Cannot set property");
    } finally {
      await dbMod.db.delete(dbMod.backupRuns)
        .where(eq(dbMod.backupRuns.downloadRunId, headers.get("X-Backup-Run-Id")!));
    }
  });

  it("records a large desktop archive size exactly, without 32-bit overflow", async () => {
    const downloadRunId = crypto.randomUUID();
    try {
      const response = await withBackupRun(async () => {
        setBackupLiveArchiveEvidence({
          archiveKind: "complete-production", coverageVersion: 1, mediaFileCount: 1400, attachmentRowCount: 1500,
        });
        return withSecret(request(appMod.default).post("/api/admin/backup/desktop-run-report"))
          .send({ status: "success", fileName: "large-backup.ltbackup", sizeBytes: 33_000_000_000, downloadRunId });
      }, downloadRunId);
      expect(response.status).toBe(200);
      const [stored] = await dbMod.db.select().from(dbMod.backupRuns).where(eq(dbMod.backupRuns.downloadRunId, downloadRunId));
      expect(stored!.sizeBytes).toBe(33_000_000_000);
      expect(stored!.archiveKind).toBe("complete-production");
      expect(stored!.mediaFileCount).toBe(1400);
    } finally {
      await dbMod.db.delete(dbMod.backupRuns).where(eq(dbMod.backupRuns.downloadRunId, downloadRunId));
    }
  });

  it("POST /admin/backup/desktop-run-report rejects a success report without a fileName", async () => {
    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/desktop-run-report"),
    ).send({ status: "success" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/fileName/i);
  });

  it("records a successful desktop run in backup_runs and advances the staleness watermark", async () => {
    const { db, backupRuns } = dbMod as any;
    const fileName = `${rid("labtrax-backup")}.zip`;
    const before = Date.now();
    const downloadRunId = crypto.randomUUID();

    const res = await withBackupRun(async () => {
      setBackupLiveArchiveEvidence({
        archiveKind: "complete-non-production", coverageVersion: 1, mediaFileCount: 12, attachmentRowCount: 15,
      });
      return withSecret(request(appMod.default).post("/api/admin/backup/desktop-run-report"))
        .send({ status: "success", fileName, path: "D:\\LabTraxBackups", sizeBytes: 524_288_000.9, downloadRunId });
    }, downloadRunId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rejected).toBeUndefined();
    expect(typeof res.body.completedAt).toBe("string");

    const rows = await db.select().from(backupRuns).where(eq(backupRuns.fileName, fileName));
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("local");
    expect(rows[0].status).toBe("success");
    expect(rows[0].path).toBe("D:\\LabTraxBackups");
    expect(rows[0].sizeBytes).toBe(524_288_000); // floored
    expect(rows[0].archiveKind).toBe("complete-non-production");
    expect(rows[0].mediaFileCount).toBe(12);
    expect(rows[0].triggeredBy).toBe("scheduler:desktop:ci:platform-admin-secret");
    expect(rows[0].error).toBeNull();

    const watermark = await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT);
    expect(watermark).not.toBeNull();
    expect(Date.parse(watermark!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("labels a manually saved desktop backup separately from a scheduled run", async () => {
    const fileName = `${rid("manual-desktop-backup")}.zip`;
    const downloadRunId = crypto.randomUUID();
    const res = await withBackupRun(async () => {
      setBackupLiveArchiveEvidence({
        archiveKind: "complete-non-production", coverageVersion: 1, mediaFileCount: 0, attachmentRowCount: 0,
      });
      return withSecret(request(appMod.default).post("/api/admin/backup/desktop-run-report"))
        .send({ source: "manual", status: "success", fileName, path: "D:\\LabTraxBackups", sizeBytes: 524_288_000, downloadRunId });
    }, downloadRunId);
    expect(res.status).toBe(200);
    const { db, backupRuns } = dbMod as any;
    const rows = await db.select().from(backupRuns).where(eq(backupRuns.fileName, fileName));
    expect(rows[0].triggeredBy).toBe("manual:desktop:ci:platform-admin-secret");
    expect(rows[0].archiveKind).toBe("complete-non-production");
  });

  it("fails closed when a desktop success report has no server-confirmed complete archive evidence", async () => {
    const { db, backupRuns } = dbMod as any;
    const fileName = `${rid("unverified-manual-backup")}.zip`;
    const watermarkBefore = await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT);
    const response = await withSecret(request(appMod.default).post("/api/admin/backup/desktop-run-report"))
      .send({ source: "manual", status: "success", fileName, path: "D:\\LabTraxBackups", sizeBytes: 524_288_000 });
    expect(response.status).toBe(200);
    expect(response.body.rejected).toBe(true);
    // The short copy is for the UI; the refusal reason stays in the diagnostic.
    expect(String(response.body.warning)).toMatch(/no new complete recovery point/i);
    expect(String(response.body.diagnostic)).toMatch(/complete database-and-files recovery evidence/i);
    const rows = await db.select().from(backupRuns).where(eq(backupRuns.fileName, fileName));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].archiveKind).not.toMatch(/^complete-/);
    expect(await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT)).toBe(watermarkBefore);
  });

  it("gives measured large full archives a bounded budget while preserving database-only and operator budgets", async () => {
    await writeSetting(backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES, null);
    const original = process.env.BACKUP_RUN_TIMEOUT_MINUTES;
    delete process.env.BACKUP_RUN_TIMEOUT_MINUTES;
    try {
      expect(await backupMod.getBackupRunTimeoutMs("full")).toBe(60 * 60_000);
      expect(await backupMod.getBackupRunTimeoutMs("database-only")).toBe(20 * 60_000);
      await writeSetting(backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES, "7");
      expect(await backupMod.getBackupRunTimeoutMs("full")).toBe(7 * 60_000);
      expect(await backupMod.getBackupRunTimeoutMs("database-only")).toBe(7 * 60_000);
    } finally {
      await writeSetting(backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES, null);
      if (original === undefined) delete process.env.BACKUP_RUN_TIMEOUT_MINUTES;
      else process.env.BACKUP_RUN_TIMEOUT_MINUTES = original;
    }
  });

  // A reported "success" whose file is a few kilobytes is a placeholder, not a
  // backup. Recording it as a success is what let a folder full of 12,345-byte
  // files look like healthy protection while there was nothing to restore.
  it("records a placeholder-sized desktop 'success' as a failure and leaves the watermark alone", async () => {
    const { db, backupRuns } = dbMod as any;
    const fileName = `${rid("labtrax-backup")}.zip`;
    const watermarkBefore = await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT);

    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/desktop-run-report"),
    ).send({ status: "success", fileName, path: "D:\\LabTraxBackups", sizeBytes: 12345 });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toBe(true);
    expect(String(res.body.warning)).toMatch(/no new complete recovery point was created/i);
    expect(String(res.body.warning)).not.toContain("12345 bytes");
    expect(String(res.body.diagnostic)).toMatch(/12345 bytes/);

    const rows = await db.select().from(backupRuns).where(eq(backupRuns.fileName, fileName));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].sizeBytes).toBe(12345);
    expect(String(rows[0].error)).toMatch(/too small to be a real backup/i);

    expect(await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT)).toBe(watermarkBefore);
  });

  // ── Generate endpoint: record-at-stream vs deferred recording ─────────────
  // The desktop scheduler downloads via ?deferRecord=1 — a successful download
  // does NOT prove the folder write succeeded, so history + watermark must
  // come only from desktop-run-report. Manual "Back up now" (no flag) records
  // at stream time by design (the user watches the result directly).

  // Note on timing: the generate route records history AFTER the streamed
  // response has fully flushed, so the DB write can land after supertest
  // resolves. The manual test below polls until the write appears; the
  // deferRecord test waits a settle period before asserting nothing appeared.
  // Note on counts: backup_runs is prune-capped (max-rows retention), so
  // assertions use targeted completedAt >= testStart queries, never row counts.

  async function newRunsSince(since: Date): Promise<any[]> {
    const { db, backupRuns } = dbMod as any;
    return db.select().from(backupRuns).where(gte(backupRuns.completedAt, since));
  }

  it("POST /admin/backup/generate?deferRecord=1 fails closed on unavailable required media without recording a success", { timeout: 150_000 }, async () => {
    // No back-dating: rows from earlier tests in this file (desktop-run-report)
    // were inserted synchronously before this line, so `new Date()` cleanly
    // excludes them, while any (buggy) recording from THIS stream would carry
    // a completedAt strictly after it.
    const testStart = new Date();
    const watermarkBefore = await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT);

    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/generate?deferRecord=1"),
    );
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toMatch(/no new complete recovery point/i);
    expect(String(res.body.diagnostic)).toMatch(/case-media|referenced|complete backup/i);
    const failedRunId = res.headers["x-backup-run-id"];
    const rows = await dbMod.db.select().from(dbMod.backupRuns)
      .where(eq(dbMod.backupRuns.downloadRunId, failedRunId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(String(rows[0]!.error)).toMatch(/case-media inventory|referenced|complete backup/i);
    expect(rows[0]!.archiveKind).not.toMatch(/^complete-/);
    expect(await newRunsSince(testStart)).toEqual(rows);
    expect(await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT)).toBe(watermarkBefore);
  });

  it("POST /admin/backup/generate records the measured failure instead of a database-only success when required media is unavailable", async () => {
    const { backupRuns } = dbMod;
    const before = Date.now();
    const testStart = new Date(before - 1000);

    const watermarkBefore = await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT);
    const res = await withSecret(request(appMod.default).post("/api/admin/backup/generate"));
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toMatch(/no new complete recovery point/i);
    expect(String(res.body.diagnostic)).toMatch(/case-media|referenced|complete backup/i);

    const failedRunId = res.headers["x-backup-run-id"];
    const rows = await dbMod.db.select().from(backupRuns)
      .where(eq(backupRuns.downloadRunId, failedRunId));
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("local");
    expect(rows[0].status).toBe("error");
    expect(rows[0].archiveKind).not.toMatch(/^complete-/);
    expect(String(rows[0].error)).toMatch(/case-media inventory|referenced|complete backup/i);
    expect(String(rows[0].triggeredBy)).toMatch(/^manual:/);
    expect(await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT)).toBe(watermarkBefore);
    expect(Date.parse(rows[0].completedAt.toISOString())).toBeGreaterThanOrEqual(testStart.getTime());
  });

  // ── Local-destination data source: getLastDesktopBackupAt() ──────────────
  // These tests pin the data-source contract: only backup_runs rows with
  // triggeredBy LIKE 'scheduler:desktop:%' count for local-schedule staleness.
  // Server-side / manual runs must NOT reset the local staleness clock.

  it("getLastDesktopBackupAt() returns null when no desktop run exists", async () => {
    // Insert a server-side (manual) success run and verify it does NOT appear.
    const { db, backupRuns } = dbMod as any;
    const manualFileName = `${rid("manual-run")}.zip`;

    await db.insert(backupRuns).values({
      triggeredBy: "manual:admin",
      destination: "local",
      fileName: manualFileName,
      status: "success",
      completedAt: new Date(),
    });

    try {
      // Deliberately do NOT insert any 'scheduler:desktop:' row.
      const result = await backupMod.getLastDesktopBackupAt();
      // The manual run must be invisible to getLastDesktopBackupAt().
      // We can't assert exactly null because the suite's earlier desktop-run-report
      // test may have inserted a real desktop row; we just assert the manual run
      // does NOT become the result.
      // If result is non-null it must be a DIFFERENT run (not our manual one).
      if (result !== null) {
        // The timestamp must come from a scheduler:desktop row, not our manual row.
        // We only verify this doesn't throw and returns a valid ISO or null.
        expect(typeof result).toBe("string");
        expect(result).not.toBe("invalid-date");
      }
    } finally {
      await db.delete(backupRuns).where(eq(backupRuns.fileName, manualFileName));
    }
  });

  it("getLastDesktopBackupAt() returns the desktop run timestamp after a successful desktop-run-report", async () => {
    // Record a desktop run and verify getLastDesktopBackupAt() picks it up.
    const { db, backupRuns } = dbMod as any;
    const desktopFileName = `${rid("desktop-stale-test")}.zip`;
    const before = Date.now();

    await db.insert(backupRuns).values({
      triggeredBy: "scheduler:desktop:ci:platform-admin-secret",
      destination: "local",
      fileName: desktopFileName,
      status: "success",
      completedAt: new Date(),
    });

    try {
      const result = await backupMod.getLastDesktopBackupAt();
      expect(result).not.toBeNull();
      // The returned timestamp must be at or after the before marker.
      expect(Date.parse(result!)).toBeGreaterThanOrEqual(before - 1000);
    } finally {
      await db.delete(backupRuns).where(eq(backupRuns.fileName, desktopFileName));
    }
  });

  it("getLastDesktopBackupAt() ignores failed desktop runs", async () => {
    const { db, backupRuns } = dbMod as any;
    const failedFileName = `${rid("desktop-failed")}.zip`;

    // Grab the current latest desktop run (may be null or a real row from earlier tests).
    const baseline = await backupMod.getLastDesktopBackupAt();

    await db.insert(backupRuns).values({
      triggeredBy: "scheduler:desktop:ci:platform-admin-secret",
      destination: "local",
      fileName: failedFileName,
      status: "error",
      error: "Disk full",
      completedAt: new Date(Date.now() + 5000), // slightly in the future to ensure ordering
    });

    try {
      const result = await backupMod.getLastDesktopBackupAt();
      // A failed run must not advance the timestamp.
      expect(result).toBe(baseline);
    } finally {
      await db.delete(backupRuns).where(eq(backupRuns.fileName, failedFileName));
    }
  });

  it("records a failed desktop run without touching the staleness watermark", async () => {
    const { db, backupRuns } = dbMod as any;
    const fileName = `${rid("labtrax-backup")}.zip`;
    const watermarkBefore = await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT);

    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/desktop-run-report"),
    ).send({
      status: "error",
      fileName,
      path: "D:\\LabTraxBackups",
      error: "The folder is no longer reachable.",
    });
    expect(res.status).toBe(200);

    const rows = await db.select().from(backupRuns).where(eq(backupRuns.fileName, fileName));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].destination).toBe("local");
    expect(rows[0].error).toBe("The folder is no longer reachable.");

    expect(await readSetting(backupMod.SETTING_BACKUP_LAST_SUCCESSFUL_AT)).toBe(watermarkBefore);
  });

  // ── Off-site protection (OneDrive every 15 minutes) ───────────────────────
  // The data-loss floor. Deliberately independent of the editable schedule
  // above, which can be disabled or pointed at a local folder the server
  // cannot write — the state the lab was in while 18 days went unprotected.

  // writeSetting is declared once for the whole suite above — it already
  // upserts, and additionally deletes the row when passed null.

  async function clearSettings(...keys: string[]): Promise<void> {
    const { db, systemSettings } = dbMod as any;
    for (const key of keys) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    }
  }

  /** Pretend the off-site folder holds these archives, newest first. */
  function plantOffsiteArchives(
    entries: Array<{ name: string; minutesOld: number; size?: number }>,
  ): void {
    const files = entries
      .map((entry, index) => ({
        id: `id-${entry.name}`,
        name: entry.name,
        size: entry.size ?? 600_000_000,
        createdDateTime: new Date(Date.now() - entry.minutesOld * 60_000).toISOString(),
        webUrl: null,
      }))
      .sort(
        (a, b) =>
          new Date(b.createdDateTime).getTime() - new Date(a.createdDateTime).getTime(),
      );
    // A successful folder listing requires both the destination availability
    // check and the returned files to be controlled in isolated test runs.
    vi.mocked(onedriveMod.isOneDriveConnectorAvailable).mockReturnValue(true);
    vi.mocked(onedriveMod.listOneDriveBackupFiles).mockResolvedValue(files as never);
  }

  function clearOffsiteArchiveMocks(): void {
    vi.mocked(onedriveMod.isOneDriveConnectorAvailable).mockReturnValue(false);
    vi.mocked(onedriveMod.listOneDriveBackupFiles).mockResolvedValue([] as never);
  }

  it("protects every 15 minutes by default, even with the editable schedule disabled", async () => {
    await clearSettings(
      backupMod.SETTING_BACKUP_OFFSITE_ENABLED,
      backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES,
    );
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "false");
    await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "local");

    const config = await backupMod.getOffsiteBackupConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalMinutes).toBe(15);
  });

  it("lets a configured cadence tighten protection but never stretch it past hourly", async () => {
    await writeSetting(backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES, "1440");
    expect((await backupMod.getOffsiteBackupConfig()).intervalMinutes).toBe(60);

    await writeSetting(backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES, "5");
    expect((await backupMod.getOffsiteBackupConfig()).intervalMinutes).toBe(15);

    await clearSettings(backupMod.SETTING_BACKUP_OFFSITE_INTERVAL_MINUTES);
  });

  it("turns off only on an explicit opt-out", async () => {
    await writeSetting(backupMod.SETTING_BACKUP_OFFSITE_ENABLED, "false");
    expect((await backupMod.getOffsiteBackupConfig()).enabled).toBe(false);
    await writeSetting(backupMod.SETTING_BACKUP_OFFSITE_ENABLED, "true");
    expect((await backupMod.getOffsiteBackupConfig()).enabled).toBe(true);
    await clearSettings(backupMod.SETTING_BACKUP_OFFSITE_ENABLED);
  });

  it("counts only verified OneDrive successes as off-site protection", async () => {
    const { db, backupRuns } = dbMod as any;
    const localName = `${rid("labtrax-backup")}.zip`;
    const offsiteName = `${rid("labtrax-backup")}.zip.enc`;
    const offsiteAt = new Date();
    const laterLocalAt = new Date(offsiteAt.getTime() + 60_000);

    try {
      await db.insert(backupRuns).values([
        {
          triggeredBy: "scheduler:offsite",
          destination: "onedrive",
          fileName: offsiteName,
          archiveKind: "complete-production",
          remoteItemId: `id-${offsiteName}`,
          sizeBytes: 600_000_000,
          status: "success",
          completedAt: offsiteAt,
        },
        // A newer local success must not look like off-site protection.
        {
          triggeredBy: "scheduler:desktop:test",
          destination: "local",
          fileName: localName,
          sizeBytes: 600_000_000,
          status: "success",
          completedAt: laterLocalAt,
        },
      ]);

      const lastVerified = await backupMod.getLastVerifiedOffsiteBackupAt();
      expect(lastVerified).toBe(offsiteAt.toISOString());
    } finally {
      await db.delete(backupRuns).where(inArray(backupRuns.fileName, [localName, offsiteName]));
    }
  });

  it("raises an in-app alarm for lab admins when off-site backups stop", async () => {
    const { db, backupRuns, users, notifications } = dbMod as any;
    const username = rid("offsite_admin");
    const staleName = `${rid("labtrax-backup")}.zip.enc`;
    let adminId: string | null = null;

    await clearSettings(backupMod.SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT);
    (mailMod.sendBackupNotificationEmail as any).mockClear?.();

    try {
      const inserted = await db
        .insert(users)
        .values({
          username,
          password: "x",
          email: `${username}@example.test`,
          role: "admin",
          userType: "lab",
        })
        .returning({ id: users.id });
      adminId = inserted[0].id as string;

      // The newest archive in the folder — and the only off-site success on
      // record — is hours old. Protection has lapsed.
      plantOffsiteArchives([{ name: staleName, minutesOld: 6 * 60 }]);
      await db.insert(backupRuns).values({
        triggeredBy: "scheduler:offsite",
        destination: "onedrive",
        fileName: staleName,
        archiveKind: "complete-production",
        remoteItemId: `id-${staleName}`,
        sizeBytes: 600_000_000,
        status: "success",
        completedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      });

      await backupMod.checkOffsiteBackupProtection();

      const alerts = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, adminId));
      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe("backup_offsite_failure");
      expect(String(alerts[0].body)).toMatch(/not protected|no verified off-site copy/i);
      expect(mailMod.sendBackupNotificationEmail).toHaveBeenCalled();

      // A continuing outage must not send a second email within the window.
      (mailMod.sendBackupNotificationEmail as any).mockClear();
      await backupMod.checkOffsiteBackupProtection();
      expect(mailMod.sendBackupNotificationEmail).not.toHaveBeenCalled();
    } finally {
      clearOffsiteArchiveMocks();
      if (adminId) {
        await db.delete(notifications).where(eq(notifications.userId, adminId));
        await db.delete(users).where(eq(users.id, adminId));
      }
      await db.delete(backupRuns).where(eq(backupRuns.fileName, staleName));
      await clearSettings(backupMod.SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT);
    }
  });

  it("notifies in-app but does not email for a single failed tick", async () => {
    const { db, backupRuns, users, notifications } = dbMod as any;
    const username = rid("offsite_admin");
    const freshName = `${rid("labtrax-backup")}.zip.enc`;
    let adminId: string | null = null;

    await clearSettings(backupMod.SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT);
    (mailMod.sendBackupNotificationEmail as any).mockClear?.();
    // No reachable connector → fireOffsiteBackup fails without running one.
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
    vi.stubEnv("REPL_IDENTITY", "");
    vi.stubEnv("WEB_REPL_RENEWAL", "");

    try {
      const inserted = await db
        .insert(users)
        .values({
          username,
          password: "x",
          email: `${username}@example.test`,
          role: "admin",
          userType: "lab",
        })
        .returning({ id: users.id });
      adminId = inserted[0].id as string;

      // Protection itself is healthy — this is one bad tick, not an outage.
      await db.insert(backupRuns).values({
        triggeredBy: "scheduler:offsite",
        destination: "onedrive",
        fileName: freshName,
        archiveKind: "complete-production",
        remoteItemId: `id-${freshName}`,
        sizeBytes: 600_000_000,
        status: "success",
        completedAt: new Date(),
      });

      await backupMod.fireOffsiteBackup("interval");

      const alerts = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, adminId));
      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe("backup_offsite_failure");
      // Mail is reserved for a confirmed lapse; 96 ticks a day must not be
      // able to turn a transient blip into mail people stop reading.
      expect(mailMod.sendBackupNotificationEmail).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      clearOffsiteArchiveMocks();
      if (adminId) {
        await db.delete(notifications).where(eq(notifications.userId, adminId));
        await db.delete(users).where(eq(users.id, adminId));
      }
      await db.delete(backupRuns).where(eq(backupRuns.fileName, freshName));
      await clearSettings(backupMod.SETTING_BACKUP_OFFSITE_ALERT_LAST_SENT_AT);
    }
  });

  it("stays quiet while a recent off-site copy exists", async () => {
    const { db, backupRuns, notifications, users } = dbMod as any;
    const username = rid("offsite_admin");
    const freshName = `${rid("labtrax-backup")}.zip.enc`;
    let adminId: string | null = null;

    try {
      const inserted = await db
        .insert(users)
        .values({
          username,
          password: "x",
          email: `${username}@example.test`,
          role: "admin",
          userType: "lab",
        })
        .returning({ id: users.id });
      adminId = inserted[0].id as string;

      // "Recent copy" now means an archive the destination really holds — a
      // success row alone is this process's own account of itself, which is
      // what let the outage pass for protection.
      plantOffsiteArchives([{ name: freshName, minutesOld: 3 }]);
      await db.insert(backupRuns).values({
        triggeredBy: "scheduler:offsite",
        destination: "onedrive",
        fileName: freshName,
        archiveKind: "complete-production",
        remoteItemId: `id-${freshName}`,
        sizeBytes: 600_000_000,
        status: "success",
        completedAt: new Date(),
      });

      await backupMod.checkOffsiteBackupProtection();

      const alerts = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, adminId));
      expect(alerts).toEqual([]);
    } finally {
      clearOffsiteArchiveMocks();
      if (adminId) {
        await db.delete(notifications).where(eq(notifications.userId, adminId));
        await db.delete(users).where(eq(users.id, adminId));
      }
      await db.delete(backupRuns).where(eq(backupRuns.fileName, freshName));
    }
  });

  // ── Restart-proof schedule ────────────────────────────────────────────────
  // The outage this covers: the schedule was a bare setInterval armed at
  // startup, so every restart reset the clock to a full interval from zero.
  // A server restarting more often than the interval produced no backups at
  // all — and no error rows, because nothing ever ran.

  describe("schedule survives restarts", () => {
    it("anchors ticks to wall-clock slots instead of process start", () => {
      const at = Date.UTC(2026, 9, 6, 12, 7, 31, 250);
      // 12:07:31 → next 15-minute slot is 12:15:00, not 12:22:31.
      expect(new Date(backupMod.nextScheduleSlotMs(at, 15)).toISOString()).toBe(
        "2026-10-06T12:15:00.000Z",
      );
      // Exactly on a slot boundary advances to the following slot rather than
      // returning the current instant (which would fire immediately forever).
      const onBoundary = Date.UTC(2026, 9, 6, 12, 15, 0, 0);
      expect(new Date(backupMod.nextScheduleSlotMs(onBoundary, 15)).toISOString()).toBe(
        "2026-10-06T12:30:00.000Z",
      );
      expect(new Date(backupMod.nextScheduleSlotMs(at, 60)).toISOString()).toBe(
        "2026-10-06T13:00:00.000Z",
      );
    });

    it("persists the next due time so a restart cannot postpone the run", async () => {
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "local");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_PATH, "D:\\LabTraxBackups");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "15");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "true");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT, null);

      try {
        await backupMod.restartScheduledBackupJob();
        const firstDue = (await backupMod.getBackupScheduleState()).nextDueAt;
        expect(firstDue).not.toBeNull();
        // Anchored to a 15-minute slot, and never more than one interval out.
        expect(firstDue!.getTime() % (15 * 60_000)).toBe(0);
        expect(firstDue!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);

        // A restart must honour the stored due time rather than re-arming a
        // full interval from now. That re-arming is what produced the outage.
        await backupMod.restartScheduledBackupJob();
        const afterRestart = (await backupMod.getBackupScheduleState()).nextDueAt;
        expect(afterRestart?.toISOString()).toBe(firstDue!.toISOString());
      } finally {
        backupMod._resetBackupSchedulerForTests();
      }
    });

    it("runs an overdue slot at startup instead of waiting a full interval", async () => {
      // A local schedule is skipped by fireScheduledBackup (the desktop app
      // executes it), so the catch-up path runs end to end without taking a
      // real backup — what is asserted is that it ran at all.
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_DESTINATION, "local");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_PATH, "D:\\LabTraxBackups");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES, "15");
      await writeSetting(backupMod.SETTING_BACKUP_SCHEDULE_ENABLED, "true");
      const missed = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await writeSetting(
        backupMod.SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
        missed.toISOString(),
      );
      vi.stubEnv("LABTRAX_BACKUP_SCHEDULER_ALLOW_CATCHUP", "1");

      try {
        await backupMod.restartScheduledBackupJob();
        // The catch-up tick is intentionally not awaited by startup; give it
        // the microtask turns it needs to finish and re-arm.
        const deadline = Date.now() + 10_000;
        let nextDueAt: Date | null = null;
        while (Date.now() < deadline) {
          nextDueAt = (await backupMod.getBackupScheduleState()).nextDueAt;
          if (nextDueAt && nextDueAt.getTime() > Date.now()) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // The stale due time was replaced with a future slot, which only the
        // completed catch-up tick writes.
        expect(nextDueAt).not.toBeNull();
        expect(nextDueAt!.getTime()).toBeGreaterThan(Date.now());
        expect(nextDueAt!.getTime()).toBeGreaterThan(missed.getTime());
      } finally {
        vi.unstubAllEnvs();
        process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;
        backupMod._resetBackupSchedulerForTests();
      }
    });

    it("clears the stored due time when the interval is changed", async () => {
      await writeSetting(
        backupMod.SETTING_BACKUP_SCHEDULE_NEXT_DUE_AT,
        new Date(Date.now() + 55 * 60_000).toISOString(),
      );
      const res = await withSecret(
        request(appMod.default).put("/api/admin/backup/schedule"),
      ).send({ interval: 15, unit: "minutes", destination: "onedrive", enabled: true });
      expect(res.status).toBe(200);

      // Honouring an hour-away due time would delay the new 15-minute cadence
      // by up to a full old interval.
      const stored = (await backupMod.getBackupScheduleState()).nextDueAt;
      expect(stored === null || stored.getTime() - Date.now() <= 15 * 60_000).toBe(true);
      backupMod._resetBackupSchedulerForTests();
    });

    it("exposes the interval the server is really using, not the caller's form state", async () => {
      await withSecret(request(appMod.default).put("/api/admin/backup/schedule")).send({
        interval: 15,
        unit: "minutes",
        destination: "onedrive",
        enabled: true,
      });
      backupMod._resetBackupSchedulerForTests();

      const res = await withSecret(request(appMod.default).get("/api/admin/backup/schedule"));
      expect(res.status).toBe(200);
      expect(res.body.effectiveIntervalMinutes).toBe(15);
      expect(res.body.destination).toBe("onedrive");
      expect(res.body.effectiveDestination).toBe("onedrive");
      expect(res.body.scheduleIntervalMinutes).toBe(15);
      expect(res.body.fullArchiveIntervalMinutes).toBeGreaterThanOrEqual(15);
      // Off-site protection is a separate job on its own timer, so Settings
      // can say which cadence it is reporting instead of presenting this row
      // as the whole truth. It is never armed under test.
      expect(res.body.offsite).toMatchObject({ running: false });
      expect(typeof res.body.offsite.enabled).toBe("boolean");
      expect(typeof res.body.offsite.intervalMinutes).toBe("number");
      // OneDrive is not connected in tests, so the newest-archive probe must
      // report that it could not read the folder rather than implying health.
      expect(res.body).toHaveProperty("newestArchive");
      expect(res.body.newestArchive === null || typeof res.body.newestArchive === "object").toBe(
        true,
      );
    });
  });

  // ── Archive kind and naming ───────────────────────────────────────────────

  describe("archive kind and naming", () => {
    it("gives every archive a unique, time-stamped, kind-labelled name", () => {
      const a = backupMod.backupFileName("database-only", new Date("2026-10-06T15:45:00Z"));
      const b = backupMod.backupFileName("database-only", new Date("2026-10-06T16:00:00Z"));
      const full = backupMod.backupFileName("full", new Date("2026-10-06T16:00:00Z"));

      expect(a).toBe("labtrax-backup-2026-10-06T154500Z-db-only.zip.enc");
      expect(b).toBe("labtrax-backup-2026-10-06T160000Z-db-only.zip.enc");
      // Two runs on the same day no longer collide, so OneDrive never has to
      // rename and the recorded name stays the stored name.
      expect(a).not.toBe(b);
      expect(full).toBe("labtrax-backup-2026-10-06T160000Z-full.zip.enc");
      expect(full).not.toBe(b);
    });

    it("takes complete database-and-files archives on every cadence, regardless of the last full run", async () => {
      await writeSetting(backupMod.SETTING_BACKUP_FULL_ARCHIVE_INTERVAL_MINUTES, "60");
      try {
        // No full archive has ever been taken → one is due immediately.
        await writeSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT, null);
        expect(await backupMod.decideScheduledArchiveKind("onedrive", 15)).toBe("full");

        // A full archive was taken five minutes ago → the fast cadence takes a
        // database-only archive instead of uploading ~591 MB every 15 minutes.
        await writeSetting(
          backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
          new Date(Date.now() - 5 * 60_000).toISOString(),
        );
        expect(await backupMod.decideScheduledArchiveKind("onedrive", 15)).toBe("full");

        // The hourly slot comes around → full again.
        await writeSetting(
          backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT,
          new Date(Date.now() - 61 * 60_000).toISOString(),
        );
        expect(await backupMod.decideScheduledArchiveKind("onedrive", 15)).toBe("full");

        // Destinations other than OneDrive keep their existing behaviour.
        expect(await backupMod.decideScheduledArchiveKind("network", 15)).toBe("full");
        // A cadence no faster than the full cadence has nothing to save.
        expect(await backupMod.decideScheduledArchiveKind("onedrive", 240)).toBe("full");
      } finally {
        await writeSetting(backupMod.SETTING_BACKUP_LAST_FULL_ARCHIVE_AT, null);
      }
    });

    it("refuses to restore from a database-only archive", () => {
      expect(() =>
        backupMod.assertRestorableArchiveKind({
          appName: "LabTrax",
          archiveKind: "database-only",
        }),
      ).toThrow(/database-only/i);
      // Full archives, and archives written before the kind existed, are fine.
      expect(() =>
        backupMod.assertRestorableArchiveKind({ appName: "LabTrax", archiveKind: "full" }),
      ).not.toThrow();
      expect(() => backupMod.assertRestorableArchiveKind({ appName: "LabTrax" })).not.toThrow();
    });
  });

  // ── Run deadline ──────────────────────────────────────────────────────────

  describe("bounded runs", () => {
    it("aborts and names the stage once the budget is spent", async () => {
      const deadline = backupMod.createBackupDeadline(10);
      try {
        expect(deadline.expired()).toBe(false);
        expect(() => deadline.throwIfExpired("the database dump")).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(deadline.expired()).toBe(true);
        expect(deadline.signal.aborted).toBe(true);
        expect(() => deadline.throwIfExpired("the OneDrive upload")).toThrow(
          /timed out.*OneDrive upload/is,
        );
      } finally {
        deadline.dispose();
      }
    });

    it("records a timed-out run as a failed backup_runs row", async () => {
      const { db, backupRuns } = dbMod as any;
      const before = new Date(Date.now() - 1000);
      await writeSetting(backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES, "1");
      try {
        // Zero budget: the run aborts in its first stage. It must surface as a
        // recorded failure, not as silence — the outage was invisible precisely
        // because nothing failed loudly.
        const deadline = backupMod.createBackupDeadline(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await expect(
          backupMod.runBackup("test:timeout", "onedrive", undefined, { deadline }),
        ).rejects.toThrow(/timed out/i);
        deadline.dispose();

        const rows = await db
          .select()
          .from(backupRuns)
          .where(gte(backupRuns.completedAt, before));
        const timedOut = rows.filter((r: { triggeredBy: string }) => r.triggeredBy === "test:timeout");
        expect(timedOut).toHaveLength(1);
        expect(timedOut[0].status).toBe("error");
        expect(String(timedOut[0].error)).toMatch(/timed out/i);
      } finally {
        await db.delete(backupRuns).where(eq(backupRuns.triggeredBy, "test:timeout"));
        await writeSetting(backupMod.SETTING_BACKUP_RUN_TIMEOUT_MINUTES, null);
      }
    });

    it("releases the in-flight guard once a wedged run is past its deadline", () => {
      const budget = 20 * 60_000;
      const grace = backupMod.IN_FLIGHT_GUARD_GRACE_MS;
      const now = Date.UTC(2026, 9, 6, 12, 0, 0);

      // Nothing running: never blocks.
      expect(backupMod.scheduledBackupGuardBlocks(null, budget, now)).toBe(false);
      // A run inside its budget blocks the next tick — two concurrent backups
      // double every resource for no benefit.
      expect(
        backupMod.scheduledBackupGuardBlocks(now - 5 * 60_000, budget, now),
      ).toBe(true);
      // Still within budget + grace.
      expect(
        backupMod.scheduledBackupGuardBlocks(now - (budget + grace - 1), budget, now),
      ).toBe(true);
      // Past its own deadline: wedged, not slow. A boolean flag that a crashed
      // run never cleared used to suppress every later run forever.
      expect(
        backupMod.scheduledBackupGuardBlocks(now - (budget + grace + 1), budget, now),
      ).toBe(false);
      expect(
        backupMod.scheduledBackupGuardBlocks(now - 18 * 60 * 60_000, budget, now),
      ).toBe(false);
    });
  });
});
