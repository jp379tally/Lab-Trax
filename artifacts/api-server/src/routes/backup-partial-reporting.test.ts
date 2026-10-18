/**
 * A partial backup must read as partial everywhere it is reported.
 *
 * The run that dropped profile photos answered the manual and run-now
 * endpoints as a plain success, so the desktop app said "Backup complete" for
 * an archive that was missing content. These tests pin both responses to the
 * partial flag and its reason.
 *
 * The backup module is mocked only for the two run entrypoints (the rest of it
 * is spread through from the real module so no other route loses its exports).
 * Runs against the shared dev DB; skipped when DATABASE_URL is not set.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import request from "supertest";

vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-backup-partial"),
  extractMediaFileName: () => null,
}));
vi.mock("../lib/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mail.js")>()),
  sendBackupNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendBackupStaleAlertEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backup.js")>()),
  runBackup: vi.fn(),
  runScheduledBackupNow: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "backup-partial-reporting-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

const WARNING =
  "Retried without profile photos and succeeded: 42 profile photo file(s) were NOT included in this backup.";

maybe("partial backups in the backup run responses", () => {
  let appMod: { default: import("express").Express };
  let backupMod: typeof import("../lib/backup.js");

  function withSecret(req: request.Test): request.Test {
    return req.set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET);
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-backup-partial";
    backupMod = await import("../lib/backup.js");
    appMod = await import("../app.js");
    await (await import("./index.js")).labtraxRoutesReady;
  });

  it("POST /admin/backup/run reports a dropped-content run as partial", async () => {
    vi.mocked(backupMod.runBackup).mockResolvedValue({
      size: 5_242_880,
      completedAt: "2026-10-06T09:30:00.000Z",
      fileName: "labtrax-backup-2026-10-06.zip.enc",
      destination: "onedrive",
      path: null,
      partialFailure: true,
      warnings: WARNING,
    } as never);

    const res = await withSecret(request(appMod.default).post("/api/admin/backup/run")).send({
      destination: "onedrive",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.partialFailure).toBe(true);
    expect(res.body.warnings).toBe(WARNING);
  });

  it("POST /admin/backup/run leaves a clean run clean", async () => {
    vi.mocked(backupMod.runBackup).mockResolvedValue({
      size: 5_242_880,
      completedAt: "2026-10-06T09:30:00.000Z",
      fileName: "labtrax-backup-2026-10-06.zip.enc",
      destination: "onedrive",
      path: null,
    } as never);

    const res = await withSecret(request(appMod.default).post("/api/admin/backup/run")).send({
      destination: "onedrive",
    });

    expect(res.status).toBe(200);
    expect(res.body.partialFailure).toBe(false);
    expect(res.body.warnings).toBeNull();
  });

  it("POST /admin/backup/schedule/run-now reports a dropped-content run as partial", async () => {
    vi.mocked(backupMod.runScheduledBackupNow).mockResolvedValue({
      size: 5_242_880,
      completedAt: "2026-10-06T09:30:00.000Z",
      fileName: "labtrax-backup-2026-10-06.zip.enc",
      destination: "onedrive",
      path: null,
      partialFailure: true,
      warnings: WARNING,
    } as never);

    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/schedule/run-now"),
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.partialFailure).toBe(true);
    expect(res.body.warnings).toBe(WARNING);
  });
});
