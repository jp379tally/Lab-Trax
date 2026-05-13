/**
 * End-to-end storage integration test for the Windows EXE installer
 * upload → download round-trip.
 *
 * Unlike installer-download.test.ts (which mocks App Storage entirely), this
 * test exercises REAL App Storage so it catches mismatches between the upload
 * and download paths that mocks cannot reveal.
 *
 * Both paths use their real production code:
 *  - Upload: the actual POST /api/admin/desktop-installer/upload handler from
 *    labtrax-routes.ts (same middleware stack: platformAdminUserOrSecret →
 *    isPlatformAdmin → multer → uploadDesktopInstaller).
 *  - Download: the actual serveInstaller() function from app.ts, calling the
 *    real getDesktopInstallerHandle() + openDesktopInstallerStream().
 *
 * To load the real labtrax router without a live database, @workspace/db is
 * replaced with a stub whose db object returns empty results for all Drizzle-
 * style query chains.  The upload endpoint wraps those calls in try-catch so
 * DB failures are non-fatal to the storage path under test.  Every named
 * table export is listed explicitly so vitest's module-import validation pass.
 *
 * Skip behaviour:
 *  The suite is skipped automatically when PRIVATE_OBJECT_DIR is absent
 *  (App Storage not provisioned) or when PLATFORM_ADMIN_SECRET is absent
 *  (isPlatformAdmin() always returns false when the secret is unset, so the
 *  upload endpoint blocks all callers — by design).
 *
 * Storage cleanup:
 *  The test snapshots the existing "exe" installer (if any) in beforeAll, then
 *  restores it in afterAll.  If no installer existed before the test ran, the
 *  dummy file is deleted so the slot is left clean.
 *
 *  Cleanup is safe to repeat: uploadDesktopInstaller and deleteDesktopInstaller
 *  are idempotent.  If afterAll fails mid-way (e.g. network outage), re-run
 *  the suite — it will snapshot the dummy file and delete/replace it again —
 *  or manually re-upload the real installer via Settings → Desktop App or with:
 *    pnpm --filter @workspace/scripts run upload-desktop-installer
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import request from "supertest";
import {
  openDesktopInstallerStream,
  uploadDesktopInstaller,
  deleteDesktopInstaller,
} from "./lib/desktop-installer-storage.js";

// ---------------------------------------------------------------------------
// Guards — skip when credentials needed by the test are absent.
//
// PRIVATE_OBJECT_DIR: App Storage not provisioned → storage calls throw.
// PLATFORM_ADMIN_SECRET: isPlatformAdmin() returns false when unset (by
//   design), blocking the upload endpoint for all callers.
// ---------------------------------------------------------------------------

const SUITE_ENABLED =
  Boolean(process.env.PRIVATE_OBJECT_DIR) && Boolean(process.env.PLATFORM_ADMIN_SECRET);

// ---------------------------------------------------------------------------
// Dummy Windows PE file: 'M' (0x4D) 'Z' (0x5A) magic bytes at positions 0-1,
// followed by zero-padding to 64 bytes.  This passes the real PE magic-byte
// validation in the upload handler without requiring an actual executable.
// ---------------------------------------------------------------------------

const DUMMY_EXE = (() => {
  const buf = Buffer.alloc(64, 0);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  return buf;
})();

// ---------------------------------------------------------------------------
// @workspace/db mock — allows the real labtrax router and all sub-route files
// (auth.ts, cases.ts, organizations.ts, finance.ts, pricing.ts,
// statements.ts, invoices.ts) to be imported without a live PostgreSQL
// connection.
//
// Every named export that any file in the import chain uses is listed
// explicitly; vitest validates named exports at import time and will throw
// "No '<name>' export is defined on the mock" for anything missing.
//
// The db stub's query chains return empty results; all DB calls in the real
// upload handler are wrapped in try-catch so these failures are non-fatal.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  /** Chainable Drizzle-style query builder stub.  Resolves to `result`. */
  function makeChain(result: unknown[] = []): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject),
    };
    for (const m of [
      "from", "where", "orderBy", "limit", "returning", "values", "set",
      "innerJoin", "leftJoin", "groupBy", "having", "offset",
      "onConflictDoNothing", "onConflictDoUpdate",
    ]) {
      chain[m] = (..._: unknown[]) => makeChain(result);
    }
    return chain;
  }

  const db: Record<string, unknown> = {
    select: (..._: unknown[]) => makeChain(),
    insert: (..._: unknown[]) => makeChain(),
    update: (..._: unknown[]) => makeChain(),
    delete: (..._: unknown[]) => makeChain(),
    execute: (..._: unknown[]) => Promise.resolve({ rows: [] }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    query: new Proxy({} as Record<string, unknown>, {
      get: () => ({
        findFirst: (..._: unknown[]) => Promise.resolve(null),
        findMany: (..._: unknown[]) => Promise.resolve([]),
      }),
    }),
  };

  // Inert table stub — any object satisfies Drizzle's type expectations when
  // db itself is mocked.
  const T = {};

  return {
    // Core
    db,
    pool: {},
    // Users / sessions
    users: T,
    userSessions: T,
    notifications: T,
    // Organizations
    organizations: T,
    organizationMemberships: T,
    organizationJoinRequests: T,
    organizationInvites: T,
    organizationConnections: T,
    // Cases
    cases: T,
    caseAttachments: T,
    caseEvents: T,
    caseLocations: T,
    caseNotes: T,
    caseRestorations: T,
    caseSubmissionQueue: T,
    labCases: T,
    labPendingFiles: T,
    labPendingFileNoteEdits: T,
    // Finance / invoices
    invoices: T,
    invoiceLineItems: T,
    invoiceAttachments: T,
    invoiceCredits: T,
    practiceStatements: T,
    practiceStatementSends: T,
    payments: T,
    bankAccounts: T,
    bankTransactions: T,
    bankTransactionInvoices: T,
    recurringTransactions: T,
    reconciliationItems: T,
    reconciliations: T,
    transactionCategories: T,
    // Pricing
    pricingTiers: T,
    pricingOverrides: T,
    // Settings / installer
    systemSettings: T,
    installerChangelog: T,
    installerUploads: T,
    // Audit / misc
    auditLogs: T,
    mediaCleanupRuns: T,
    statementSchedules: T,
    statementSendRuns: T,
  };
});

// ---------------------------------------------------------------------------
// Side-effect-only mocks — identical pattern to installer-download.test.ts.
//
// routes/index.js is intentionally NOT mocked so the real labtrax router
// (including the actual upload handler from labtrax-routes.ts) is loaded.
//
// desktop-installer-storage.js is intentionally NOT mocked so the real GCS
// client is exercised on both the upload and download paths.
// ---------------------------------------------------------------------------

vi.mock("./lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));

vi.mock("./lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  // Extras consumed by cases.ts and labtrax-routes.ts route handlers:
  caseMediaDir: "/tmp/test-case-media",
  extractMediaFileName: vi.fn((name: string) => name),
  cleanupOrphanedCaseMedia: vi.fn(),
  runAndPersistCleanup: vi.fn(),
  getCleanupAlertThresholds: vi.fn(),
  getCleanupHistoryRetentionDays: vi.fn(),
  getCleanupHourUtc: vi.fn(),
  getCleanupProgress: vi.fn(),
  getCleanupStuckTimeoutMinutes: vi.fn(),
  cancelCleanup: vi.fn(),
  CleanupAlreadyRunningError: class CleanupAlreadyRunningError extends Error {},
  SETTING_CLEANUP_MIN_REMOVED: "cleanup_min_removed",
  SETTING_CLEANUP_MIN_FREED_MB: "cleanup_min_freed_mb",
  SETTING_CLEANUP_HISTORY_RETENTION_DAYS: "cleanup_history_retention_days",
  SETTING_CLEANUP_HOUR_UTC: "cleanup_hour_utc",
  SETTING_CLEANUP_STUCK_TIMEOUT_MINUTES: "cleanup_stuck_timeout_minutes",
}));

vi.mock("./lib/backup.js", () => ({
  startDailyOneDriveBackup: vi.fn(),
  runOneDriveBackup: vi.fn(),
  getBackupHourUtc: vi.fn(),
  SETTING_BACKUP_HOUR_UTC: "backup_hour_utc",
}));

vi.mock("./lib/onedrive.js", () => ({
  uploadToOneDrive: vi.fn(),
  deleteFromOneDrive: vi.fn(),
  getOneDriveSettings: vi.fn(),
}));

vi.mock("./lib/mail.js", () => ({
  sendInstallerPublishFailureAlertEmail: vi.fn(),
  sendInviteEmail: vi.fn(),
  sendStatementEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendSecurityAlertEmail: vi.fn(),
}));

vi.mock("./middlewares/csrf.js", () => ({
  requireCsrf: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("./lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ---------------------------------------------------------------------------
// Import the real app after all mocks are registered.
// The real routes/index.js → labtrax-routes.ts registers the actual
// POST /api/admin/desktop-installer/upload handler on /api.
// The download routes in app.ts use the real serveInstaller() function.
// ---------------------------------------------------------------------------

import app from "./app.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!SUITE_ENABLED)(
  "installer storage round-trip — real upload handler + real App Storage (requires PRIVATE_OBJECT_DIR + PLATFORM_ADMIN_SECRET)",
  () => {
    let server: Server;

    /**
     * Snapshot of the "exe" installer that existed in App Storage before the
     * test ran.  null means no installer was present (slot was empty).
     *
     * afterAll uses this to restore the bucket to its pre-test state:
     *  - snapshot !== null → re-upload the original bytes.
     *  - snapshot === null → delete the dummy file the test wrote.
     *
     * This makes the suite safe to run repeatedly against a shared or
     * production-backed bucket without permanently replacing the real installer.
     */
    let preTestExeSnapshot: Buffer | null = null;

    beforeAll(async () => {
      // --- Snapshot the existing EXE installer before the test overwrites it ---
      // openDesktopInstallerStream is the real (un-mocked) storage client, so
      // this reads whatever is currently in App Storage for the "exe" slot.
      const existing = await openDesktopInstallerStream("exe");
      if (existing) {
        preTestExeSnapshot = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          existing.stream.on("data", (d: Buffer) => chunks.push(d));
          existing.stream.on("end", () => resolve(Buffer.concat(chunks)));
          existing.stream.on("error", reject);
        });
      }

      server = app.listen(0);
      // Wait deterministically for the upload route to become available.
      // routes/index.ts calls registerRoutes() asynchronously; once the route
      // is registered, the upload endpoint returns anything other than 404.
      // seedDefaultUsers() returns immediately when LABTRAX_ENABLE_DEMO_SEEDS
      // is unset, so registration is fast — this loop typically exits on the
      // first or second iteration.
      const secret = process.env.PLATFORM_ADMIN_SECRET!;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const probe = await request(server)
          .post("/api/admin/desktop-installer/upload")
          .set("X-Platform-Admin-Secret", secret);
        // 400 = route found, file missing; 401/403 = route found, auth issue.
        // 404 = route not yet registered; keep waiting.
        if (probe.status !== 404) break;
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    });

    afterAll(async () => {
      server.close();

      // --- Restore App Storage to its pre-test state ---
      //
      // If a real installer was in the slot before the test, re-upload it so
      // the production download URL continues to serve the correct file.
      //
      // If the slot was empty before the test, delete the dummy file the test
      // wrote so no garbage is left behind.
      //
      // Both uploadDesktopInstaller and deleteDesktopInstaller are idempotent,
      // so re-running the suite after a partial failure is safe.  If cleanup
      // fails entirely (e.g. network outage during afterAll), re-upload the
      // real installer manually via Settings → Desktop App or:
      //   pnpm --filter @workspace/scripts run upload-desktop-installer
      try {
        if (preTestExeSnapshot !== null) {
          await uploadDesktopInstaller(preTestExeSnapshot, "exe");
        } else {
          await deleteDesktopInstaller("exe");
        }
      } catch (err) {
        process.stderr.write(
          `[storage-e2e] afterAll: failed to restore pre-test installer state: ${err}\n`,
        );
      }
    });

    it("uploads a dummy .exe via POST /api/admin/desktop-installer/upload and downloads it back via GET /downloads/LabTrax-Setup.exe with correct headers and body", async () => {
      const secret = process.env.PLATFORM_ADMIN_SECRET!;

      // --- Upload via the REAL handler in labtrax-routes.ts ---
      // Full middleware stack: platformAdminUserOrSecret → isPlatformAdmin →
      // multer → PE magic-byte check → uploadDesktopInstaller (real storage).
      const uploadRes = await request(server)
        .post("/api/admin/desktop-installer/upload")
        .set("X-Platform-Admin-Secret", secret)
        .attach("file", DUMMY_EXE, {
          filename: "LabTrax-Setup.exe",
          contentType: "application/octet-stream",
        });

      expect(
        uploadRes.status,
        `Upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`,
      ).toBe(200);
      // Real response shape from labtrax-routes.ts:
      //   { success: true, kind: "exe", installerObject: { size, uploadedAt } }
      expect(uploadRes.body.success).toBe(true);
      expect(uploadRes.body.kind).toBe("exe");
      expect(typeof uploadRes.body.installerObject?.size).toBe("number");
      expect(uploadRes.body.installerObject.size).toBe(DUMMY_EXE.length);

      // --- Download via the REAL serveInstaller() in app.ts ---
      // Calls getDesktopInstallerHandle() and openDesktopInstallerStream()
      // from desktop-installer-storage.ts — no mocks in the download path.
      const downloadRes = await request(server)
        .get("/downloads/LabTrax-Setup.exe")
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(
        downloadRes.status,
        `Download failed (${downloadRes.status}): ${JSON.stringify(downloadRes.body)}`,
      ).toBe(200);

      // Content-Type must identify a Windows PE executable.
      expect(downloadRes.headers["content-type"]).toMatch(
        /application\/vnd\.microsoft\.portable-executable|application\/octet-stream/,
      );

      // Content-Disposition must name the correct file.
      expect(downloadRes.headers["content-disposition"]).toContain("LabTrax-Setup.exe");

      // Content-Length must match the uploaded file size exactly.
      expect(downloadRes.headers["content-length"]).toBe(String(DUMMY_EXE.length));

      // Body bytes must be exactly what was uploaded.
      const body = downloadRes.body as Buffer;
      expect(body).toEqual(DUMMY_EXE);

      // ETag must be present (derived from size + uploadedAt by the real handler).
      expect(typeof downloadRes.headers["etag"]).toBe("string");
      expect((downloadRes.headers["etag"] as string).length).toBeGreaterThan(0);

      // Accept-Ranges must be advertised so download managers can resume.
      expect(downloadRes.headers["accept-ranges"]).toBe("bytes");
    });

    it("returns 401 when X-Platform-Admin-Secret header is wrong", async () => {
      const res = await request(server)
        .post("/api/admin/desktop-installer/upload")
        .set("X-Platform-Admin-Secret", "definitely-wrong-secret")
        .attach("file", DUMMY_EXE, {
          filename: "LabTrax-Setup.exe",
          contentType: "application/octet-stream",
        });

      // When the header doesn't match PLATFORM_ADMIN_SECRET,
      // platformAdminUserOrSecret() falls through to requireAuth().
      // requireAuth() returns 401 (no Bearer token / session cookie provided).
      expect(res.status).toBe(401);
    });

    it("returns 400 when the uploaded .exe lacks the MZ magic bytes", async () => {
      const secret = process.env.PLATFORM_ADMIN_SECRET!;
      const notAnExe = Buffer.from("I am definitely not a Windows PE binary.");

      const res = await request(server)
        .post("/api/admin/desktop-installer/upload")
        .set("X-Platform-Admin-Secret", secret)
        .attach("file", notAnExe, {
          filename: "LabTrax-Setup.exe",
          contentType: "application/octet-stream",
        });

      // The real upload handler validates PE magic bytes before touching storage.
      expect(res.status).toBe(400);
    });
  },
);
