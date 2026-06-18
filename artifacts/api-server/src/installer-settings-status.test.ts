/**
 * Unit tests for the GET /admin/settings/desktop-installer → installerStatus field.
 *
 * Regression guard for the "Settings shows MISSING" failure mode:
 *   - When App Storage has no installer object for the active download-URL kind,
 *     the endpoint must return installerStatus: "missing" (not silently ok/unknown).
 *   - After a successful upload, the endpoint must return installerStatus: "ok".
 *
 * These tests run unconditionally (no INSTALLER_E2E_OBJECT_DIR gate) because
 * they mock desktop-installer-storage.js rather than touching real App Storage.
 *
 * Auth bypass: requireAuth is mocked to call next() so the test can focus on
 * the installerStatus logic. isPlatformAdmin() still runs its real check
 * (header === PLATFORM_ADMIN_SECRET) to ensure the 403 guard is also exercised.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import request from "supertest";

// ── Mocks must be declared before any dynamic import of app.js ────────────

const TEST_ADMIN_SECRET = "test-installer-status-secret";

// Bypass requireAuth so the test can probe the settings endpoint without a
// real JWT. Set req.user to an admin so the inline isPlatformAdmin() in
// labtrax-routes.ts passes the `!reqUser || reqUser.role !== "admin"` guard,
// then goes on to validate the X-Platform-Admin-Secret header normally.
vi.mock("./middlewares/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "test-admin-id", role: "admin", organizationId: null };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireVerifiedAccount: (_req: any, _res: any, next: any) => next(),
  isCanonicalAccount: () => true,
  isAccountVerified: () => true,
  platformAdminUserOrSecret: (req: any, _res: any, next: any) => {
    req.user = { id: "test-admin-id", role: "admin", organizationId: null };
    next();
  },
  verifyDeleteSessionToken: vi.fn(),
  requireAnyRole: vi.fn(),
  requireMembership: vi.fn(),
  signDeleteSessionToken: vi.fn(),
}));

// Controllable mock for App Storage metadata calls. Default: no installer present.
const getMetadataMock = vi.fn<(key: string) => Promise<{ size: number; uploadedAt: string; etag?: string } | null>>();

vi.mock("./lib/desktop-installer-storage.js", () => ({
  getDesktopInstallerMetadata: (key: string) => getMetadataMock(key),
  openDesktopInstallerStream: vi.fn().mockResolvedValue(null),
  deleteDesktopInstaller: vi.fn().mockResolvedValue(undefined),
  writeDesktopInstallerFromBuffer: vi.fn().mockResolvedValue({ size: 0, uploadedAt: new Date().toISOString() }),
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(undefined),
  installerKindFromUrl: (url: string) => {
    if (url.endsWith(".exe")) return "exe";
    if (url.endsWith(".dmg")) return "dmg";
    if (url.endsWith(".zip")) return "zip";
    return null;
  },
  validateInstallerUrl: (url: string) => {
    if (!url || typeof url !== "string") return "URL is required.";
    return null;
  },
  validateInstallerVersion: (v: string) => {
    return /^\d+\.\d+\.\d+$/.test(v) ? null : "Version must be X.Y.Z.";
  },
}));

// Minimal DB mock — settings queries return empty rows so the endpoint falls
// back to process.env.DESKTOP_INSTALLER_URL and DESKTOP_INSTALLER_VERSION.
vi.mock("@workspace/db", () => {
  const passthrough = () => ({
    from: () => ({
      where: () => Promise.resolve([]),
      orderBy: () => ({ limit: () => Promise.resolve([]) }),
      limit: () => Promise.resolve([]),
      innerJoin: () => ({ where: () => Promise.resolve([]) }),
    }),
  });

  const systemSettings = { key: "key", value: "value", updatedAt: "updatedAt" } as const;

  return {
    db: {
      select: passthrough,
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
      delete: () => ({ where: () => Promise.resolve(), returning: () => Promise.resolve([]) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
    systemSettings,
    // Tables referenced by other routes the labtrax router loads.
    labCases: {}, labPendingFiles: {}, labPendingFileNoteEdits: {}, organizations: {},
    organizationMemberships: {}, cases: {}, caseAttachments: {}, caseEvents: {},
    mediaCleanupRuns: {}, subscriptions: {}, backupRuns: {}, rxPracticeNameAliases: {},
    invoices: {}, invoiceAttachments: {}, bankTransactions: {}, pricingTiers: {},
    pricingOverrides: {}, vendorTypes: {}, installerChangelog: {}, installerUploads: {},
    users: { id: "id", email: "email", role: "role" },
  };
});

// Side-effect module mocks — identical pattern to installer-publish-e2e.test.ts
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
  sendMail: vi.fn().mockResolvedValue(undefined),
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe("GET /admin/settings/desktop-installer — installerStatus", () => {
  let server: Server;
  const origAdminSecret = process.env.PLATFORM_ADMIN_SECRET;
  const origInstallerUrl = process.env.DESKTOP_INSTALLER_URL;
  const origInstallerVersion = process.env.DESKTOP_INSTALLER_VERSION;

  beforeAll(async () => {
    // Use a fixed test secret — the mocked isPlatformAdmin validates it.
    process.env.PLATFORM_ADMIN_SECRET = TEST_ADMIN_SECRET;
    // Default env URL points to the exe slot, the most common misconfiguration.
    process.env.DESKTOP_INSTALLER_URL = "/downloads/LabTrax-Setup.exe";
    process.env.DESKTOP_INSTALLER_VERSION = "1.0.0";

    const { default: app } = await import("./app.js");
    server = app.listen(0);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Restore env vars so other suites in the same worker are not affected.
    if (origAdminSecret === undefined) delete process.env.PLATFORM_ADMIN_SECRET;
    else process.env.PLATFORM_ADMIN_SECRET = origAdminSecret;
    if (origInstallerUrl === undefined) delete process.env.DESKTOP_INSTALLER_URL;
    else process.env.DESKTOP_INSTALLER_URL = origInstallerUrl;
    if (origInstallerVersion === undefined) delete process.env.DESKTOP_INSTALLER_VERSION;
    else process.env.DESKTOP_INSTALLER_VERSION = origInstallerVersion;
  });

  it("returns installerStatus: \"missing\" when no installer is in App Storage", async () => {
    // Simulate the failure mode: the exe slot is absent from App Storage.
    getMetadataMock.mockResolvedValue(null);

    const res = await request(server)
      .get("/api/admin/settings/desktop-installer")
      .set("X-Platform-Admin-Secret", TEST_ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.installerStatus).toBe("missing");
    expect(typeof res.body.installerStatusMessage).toBe("string");
    // The message must name the 404 consequence so admins know what's broken.
    expect(res.body.installerStatusMessage).toMatch(/404/i);
  });

  it("returns installerStatus: \"ok\" when the active installer slot is populated", async () => {
    // Simulate a successful upload: metadata present for the exe slot.
    const uploadedAt = new Date().toISOString();
    getMetadataMock.mockResolvedValue({ size: 2048, uploadedAt, etag: "abc123" });

    const res = await request(server)
      .get("/api/admin/settings/desktop-installer")
      .set("X-Platform-Admin-Secret", TEST_ADMIN_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.installerStatus).toBe("ok");
    expect(res.body.installerStatusMessage).toBeFalsy();
  });

  it("returns 403 without the platform-admin header", async () => {
    getMetadataMock.mockResolvedValue(null);

    const res = await request(server)
      .get("/api/admin/settings/desktop-installer");

    expect(res.status).toBe(403);
  });
});
