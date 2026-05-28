/**
 * End-to-end test for the atomic POST /admin/desktop-installer/publish
 * endpoint added in Task #749.
 *
 * This is the structural fix for RC1 (upload-succeeds-then-settings-fails
 * silent skew). The test asserts that:
 *   1. A successful /publish writes BOTH the App Storage object AND the
 *      system_settings rows (url + version + releaseNotes) AND an
 *      installer_changelog row in one call.
 *   2. On the happy path, /downloads/LabTrax-Setup.exe serves back the
 *      bytes that were uploaded.
 *   3. The alert dedup state (installer_publish_alert_last) is NOT touched
 *      on a successful publish (no admin email).
 *
 * Skip behaviour mirrors installer-storage-e2e.test.ts: the suite no-ops
 * unless PRIVATE_OBJECT_DIR and PLATFORM_ADMIN_SECRET are both set.
 *
 * Storage cleanup: the test snapshots the existing exe installer in
 * beforeAll and restores it in afterAll, even on test failure.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import request from "supertest";
import {
  openDesktopInstallerStream,
  uploadDesktopInstaller,
  deleteDesktopInstaller,
  getDesktopInstallerMetadata,
} from "./lib/desktop-installer-storage.js";
import {
  acquireInstallerE2ELock,
  releaseInstallerE2ELock,
} from "./installer-e2e-lock.js";

const SUITE_ENABLED =
  Boolean(process.env.PRIVATE_OBJECT_DIR) && Boolean(process.env.PLATFORM_ADMIN_SECRET);

// Minimal valid Windows PE: 'MZ' magic followed by zero padding. The
// /publish endpoint validates this magic before accepting the upload.
const DUMMY_EXE = (() => {
  const buf = Buffer.alloc(128, 0);
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  return buf;
})();

// Must be strict X.Y.Z — validateInstallerVersion() rejects pre-release
// suffixes. 999.0.0 is an obvious, collision-free test sentinel.
const TEST_VERSION = "999.0.0";

// In-memory stand-ins for the system_settings rows the endpoint writes, so we
// can assert atomicity without touching the real Postgres. The mocked db
// captures inserts/updates into this map.
const settingsRows = new Map<string, string>();
const changelogRows: Array<{ version: string | null; downloadUrl: string; releaseNotes: string | null }> = [];
const uploadsRows: Array<{ version: string | null; sizeBytes: number; checksumSha256: string | null }> = [];

vi.mock("@workspace/db", () => {
  const passthrough = () => ({
    from: () => ({
      where: () => Promise.resolve([]),
      orderBy: () => ({ limit: () => Promise.resolve([]) }),
      limit: () => Promise.resolve([]),
      innerJoin: () => ({ where: () => Promise.resolve([]) }),
    }),
  });

  const selectImpl = (cols: any) => {
    // Re-read settings rows when the route reloads them for any reason.
    return {
      from: (table: any) => ({
        where: (_w: any) => {
          if (table === systemSettings) {
            // Return all current settings rows (route filters client-side).
            return Promise.resolve(
              Array.from(settingsRows.entries()).map(([key, value]) => ({ key, value, updatedAt: new Date() })),
            );
          }
          return Promise.resolve([]);
        },
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
      }),
    };
  };

  const systemSettings = { key: "key", value: "value", updatedAt: "updatedAt" } as const;
  const installerChangelog = { id: "id" } as const;
  const installerUploads = { id: "id" } as const;
  const users = { id: "id", email: "email", role: "role" } as const;

  // Single insert mock that supports BOTH call shapes the route uses:
  //   - db.insert(systemSettings).values(...).onConflictDoUpdate(...)  (upsert)
  //   - db.insert(installerChangelog).values(...)                       (plain await)
  // `.values()` records the row immediately and returns a thenable that also
  // carries `.onConflictDoUpdate()` for the settings upsert path.
  const insertWrap = (table: any) => ({
    values: (vals: any) => {
      if (table === installerChangelog) changelogRows.push(vals);
      if (table === installerUploads) uploadsRows.push(vals);
      if (table === systemSettings) settingsRows.set(vals.key, vals.value);
      const result: any = Promise.resolve();
      result.onConflictDoUpdate = (_args: any) => {
        if (table === systemSettings) settingsRows.set(vals.key, vals.value);
        return Promise.resolve();
      };
      return result;
    },
  });

  return {
    db: {
      select: selectImpl,
      insert: insertWrap,
      delete: () => ({ where: () => Promise.resolve(), returning: () => Promise.resolve([]) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
    systemSettings,
    installerChangelog,
    installerUploads,
    users,
    // Tables referenced by other routes loaded by the labtrax router; all
    // returned as opaque markers since this test never queries them.
    labCases: {}, labPendingFiles: {}, labPendingFileNoteEdits: {}, organizations: {},
    organizationMemberships: {}, cases: {}, caseAttachments: {}, caseEvents: {},
    mediaCleanupRuns: {}, subscriptions: {}, backupRuns: {}, rxPracticeNameAliases: {},
    invoices: {}, invoiceAttachments: {}, bankTransactions: {}, pricingTiers: {},
    pricingOverrides: {}, vendorTypes: {},
  };
});

vi.mock("./lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("./lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  cleanupOrphanedCaseMedia: vi.fn(),
  runAndPersistCleanup: vi.fn(),
  getCleanupAlertThresholds: vi.fn(() => ({ minRemoved: 1, minFreedMb: 0 })),
  getCleanupHistoryRetentionDays: vi.fn(() => 365),
  getCleanupHourUtc: vi.fn(() => 8),
  getCleanupProgress: vi.fn(() => null),
  getCleanupStuckTimeoutMinutes: vi.fn(() => 60),
  cancelCleanup: vi.fn(),
  CleanupAlreadyRunningError: class extends Error {},
  SETTING_CLEANUP_MIN_REMOVED: "x", SETTING_CLEANUP_MIN_FREED_MB: "x",
  SETTING_CLEANUP_HISTORY_RETENTION_DAYS: "x", SETTING_CLEANUP_HOUR_UTC: "x",
  SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES: "x",
}));
vi.mock("./lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
  runBackup: vi.fn(),
  getBackupHourUtc: vi.fn(() => 7), getBackupScheduleConfig: vi.fn(() => ({})),
  getLastSuccessfulBackupAt: vi.fn(), getBackupStaleAlertSettings: vi.fn(() => ({})),
  getBackupHistoryRetentionDays: vi.fn(() => 90),
  executeRestore: vi.fn(), getRestoreState: vi.fn(),
  SETTING_BACKUP_HOUR_UTC: "x", SETTING_BACKUP_SCHEDULE_INTERVAL_MINUTES: "x",
  SETTING_BACKUP_SCHEDULE_DESTINATION: "x", SETTING_BACKUP_SCHEDULE_PATH: "x",
  SETTING_BACKUP_SCHEDULE_ENABLED: "x", SETTING_BACKUP_LAST_SUCCESSFUL_AT: "x",
  SETTING_BACKUP_HISTORY_RETENTION_DAYS: "x", SETTING_BACKUP_HISTORY_MAX_ROWS: "x",
  ALL_SCHEDULE_SETTINGS: [] as string[],
  SETTING_BACKUP_STALE_ALERT_THRESHOLD_DAYS: "x", SETTING_BACKUP_STALE_ALERT_RATE_LIMIT_DAYS: "x",
  SETTING_BACKUP_STALE_DAYS: "x", DEFAULT_BACKUP_STALE_DAYS: 7,
}));
vi.mock("./lib/mail.js", () => ({
  sendInstallerPublishFailureAlertEmail: vi.fn(),
}));
vi.mock("./lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("./middlewares/csrf.js", () => ({
  requireCsrf: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("./lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("pino-http", () => ({
  default: () => (req: any, _res: any, next: any) => {
    req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    next();
  },
}));

describe.skipIf(!SUITE_ENABLED)("POST /admin/desktop-installer/publish (atomic)", () => {
  let server: Server;
  let snapshot: Buffer | null = null;

  beforeAll(async () => {
    await acquireInstallerE2ELock();
    const existing = await getDesktopInstallerMetadata("exe");
    if (existing) {
      const stream = await openDesktopInstallerStream("exe");
      if (stream) {
        const chunks: Buffer[] = [];
        for await (const c of stream.stream as any) {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        }
        snapshot = Buffer.concat(chunks);
      }
    }
    const { default: app } = await import("./app.js");
    server = app.listen(0);
  });

  afterAll(async () => {
    if (snapshot) {
      await uploadDesktopInstaller(snapshot, "exe");
    } else {
      await deleteDesktopInstaller("exe");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await releaseInstallerE2ELock();
  });

  it("atomically uploads to App Storage AND writes system_settings + changelog", async () => {
    settingsRows.clear();
    changelogRows.length = 0;
    uploadsRows.length = 0;

    const res = await request(server)
      .post("/api/admin/desktop-installer/publish")
      .set("X-Platform-Admin-Secret", process.env.PLATFORM_ADMIN_SECRET!)
      .field("version", TEST_VERSION)
      .field("downloadUrl", "/downloads/LabTrax-Setup.exe")
      .field("releaseNotes", "publish-e2e test notes")
      .field("workflowName", "publish-e2e")
      .attach("file", DUMMY_EXE, { filename: "LabTrax-Setup.exe", contentType: "application/vnd.microsoft.portable-executable" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.kind).toBe("exe");
    expect(res.body.version).toBe(TEST_VERSION);
    expect(res.body.downloadUrl).toBe("/downloads/LabTrax-Setup.exe");
    expect(res.body.installerObject?.size).toBe(DUMMY_EXE.length);

    // Atomic write — all three writes happened.
    expect(settingsRows.get("desktop_installer_url")).toBe("/downloads/LabTrax-Setup.exe");
    expect(settingsRows.get("desktop_installer_version")).toBe(TEST_VERSION);
    expect(settingsRows.get("desktop_installer_release_notes")).toBe("publish-e2e test notes");
    expect(changelogRows).toHaveLength(1);
    expect(changelogRows[0]?.version).toBe(TEST_VERSION);
    expect(uploadsRows).toHaveLength(1);
    expect(uploadsRows[0]?.sizeBytes).toBe(DUMMY_EXE.length);

    // Storage object is actually present and the bytes round-trip.
    const meta = await getDesktopInstallerMetadata("exe");
    expect(meta).not.toBeNull();
    expect(meta?.size).toBe(DUMMY_EXE.length);

    const stream = await openDesktopInstallerStream("exe");
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!.stream as any) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    expect(Buffer.concat(chunks).equals(DUMMY_EXE)).toBe(true);

    // Success path must not trip the dedup state.
    expect(settingsRows.has("installer_publish_alert_last")).toBe(false);
  });

  it("rejects an upload missing the MZ magic bytes with stage=upload", async () => {
    const res = await request(server)
      .post("/api/admin/desktop-installer/publish")
      .set("X-Platform-Admin-Secret", process.env.PLATFORM_ADMIN_SECRET!)
      .field("version", TEST_VERSION)
      .attach("file", Buffer.alloc(64, 0), { filename: "LabTrax-Setup.exe", contentType: "application/octet-stream" });

    expect(res.status).toBe(400);
    expect(res.body.stage).toBe("upload");
    expect(res.body.httpStatus).toBe(400);
    expect(res.body.error).toMatch(/MZ magic/i);
  });

  it("rejects a missing version field with stage=publish", async () => {
    const res = await request(server)
      .post("/api/admin/desktop-installer/publish")
      .set("X-Platform-Admin-Secret", process.env.PLATFORM_ADMIN_SECRET!)
      .attach("file", DUMMY_EXE, { filename: "LabTrax-Setup.exe", contentType: "application/vnd.microsoft.portable-executable" });

    expect(res.status).toBe(400);
    expect(res.body.stage).toBe("publish");
  });
});
