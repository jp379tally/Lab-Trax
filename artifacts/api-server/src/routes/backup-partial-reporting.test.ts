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
import { randomUUID } from "node:crypto";
import { db, backupRuns } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBackupRunId } from "../lib/backup-phase";

vi.mock("../lib/db-constraints", () => ({ ensureStartupDbConstraints: vi.fn().mockResolvedValue(undefined) }));

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
  "Missing file references: 526. Unavailable files are listed by opaque technical identifiers in complete-recovery.json. This archive is not a complete recovery point.";

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

  it("reports partial delivery from the synchronous manual backup endpoint", async () => {
    const runId = randomUUID();
    vi.mocked(backupMod.runBackup).mockResolvedValue({
      size: 5_242_880,
      completedAt: "2026-10-06T09:30:00.000Z",
      fileName: "labtrax-backup-2026-10-06.zip.enc",
      destination: "onedrive",
      path: null,
      partialFailure: true,
      warnings: WARNING,
      missingFileCount: 526,
    } as never);

    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/run"),
    ).send({ destination: "onedrive", runId });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.partialFailure).toBe(true);
    expect(res.body.warnings).toBe(WARNING);
  });

  it("reports a complete scheduled run as not partial", async () => {
    vi.mocked(backupMod.runScheduledBackupNow).mockResolvedValue({
      size: 5_242_880,
      completedAt: "2026-10-06T09:30:00.000Z",
      fileName: "labtrax-backup-2026-10-06.zip.enc",
      destination: "onedrive",
      path: null,
    } as never);

    const res = await withSecret(
      request(appMod.default).post("/api/admin/backup/schedule/run-now"),
    ).send({});
    expect(res.status).toBe(200);
    expect(res.body.partialFailure).toBe(false);
    expect(res.body.warnings).toBeNull();
  });

  it("reports a scheduled run with dropped content as partial", async () => {
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
    expect(res.body.warningMessage).toBeTruthy();
  });

  it("accepts a cloud job immediately, starts duplicate UUIDs once, and returns its exact verified history", async () => {
    const runId = randomUUID();
    let finish!: () => void;
    const delayed = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(backupMod.runBackup).mockClear();
    vi.mocked(backupMod.runBackup).mockImplementationOnce(async () => {
      await delayed;
      expect(getBackupRunId()).toBe(runId);
      const result = {
        size: 1234, completedAt: new Date().toISOString(), fileName: "synthetic-exact-run.enc",
        destination: "onedrive" as const, partialFailure: true, warnings: WARNING,
      };
      await db.insert(backupRuns).values({
        destination: result.destination, triggeredBy: "manual:synthetic",
        fileName: result.fileName, sizeBytes: result.size, completedAt: new Date(result.completedAt),
        status: "success", downloadRunId: runId, partialFailure: true, warnings: WARNING,
      });
      return result;
    });
    try {
      const started = Date.now();
      const accepted = await withSecret(request(appMod.default).post("/api/admin/backup/run"))
        .send({ destination: "onedrive", runId, respondAsync: true });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({ ok: true, runId, state: "running" });
      expect(Date.now() - started).toBeLessThan(2000);
      const duplicate = await withSecret(request(appMod.default).post("/api/admin/backup/run"))
        .send({ destination: "onedrive", runId, respondAsync: true });
      expect(duplicate.status).toBe(202);
      const running = await withSecret(request(appMod.default).get(`/api/admin/backup/status/${runId}`));
      expect(running.body.state).toBe("running");
      expect(running.body.result).toBeUndefined();
      finish();
      await vi.waitFor(async () => {
        const completed = await withSecret(request(appMod.default).get(`/api/admin/backup/status/${runId}`));
        expect(completed.body.state).toBe("completed");
        expect(completed.body.result).toMatchObject({
          runId, size: 1234, fileName: "synthetic-exact-run.enc",
          partialFailure: true, warnings: WARNING,
        });
      });
      expect(backupMod.runBackup).toHaveBeenCalledTimes(1);
      expect(await db.select().from(backupRuns).where(eq(backupRuns.downloadRunId, runId))).toHaveLength(1);
    } finally {
      finish();
      await db.delete(backupRuns).where(eq(backupRuns.downloadRunId, runId));
    }
  });
});
