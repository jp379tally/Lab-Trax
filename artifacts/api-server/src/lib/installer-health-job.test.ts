/**
 * Unit tests for checkAndAlertInstallerHealth() and the scheduling helpers
 * in lib/installer-health-job.ts.
 *
 * All external dependencies (DB, health check, alert dispatcher, logger) are
 * mocked so no real database connection or SMTP credentials are needed.
 *
 * Key behaviours under test:
 *   - checkAndAlertInstallerHealth: dispatches alert when report.ok === false
 *   - checkAndAlertInstallerHealth: skips alert when report.ok === true
 *   - checkAndAlertInstallerHealth: handles health-check errors gracefully
 *   - checkAndAlertInstallerHealth: handles alert-dispatch errors gracefully
 *   - checkAndAlertInstallerHealth: logs suppression when dedup window active
 *   - resolveHealthCheckHourUtc: parses and clamps the env var correctly
 *   - msUntilNextHourUtc: always returns a positive value
 *   - startInstallerHealthCheckJob: guards against double-registration
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (vi.hoisted runs before any import)
// ---------------------------------------------------------------------------

const { dispatchAlertMock, runHealthCheckMock } = vi.hoisted(() => ({
  dispatchAlertMock: vi.fn(),
  runHealthCheckMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared before imports so Vitest hoists them above the
// module graph.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => val,
}));

vi.mock("@workspace/db", () => {
  const systemSettings = { key: "key", value: "value" };
  const users = { email: "email", role: "role" };

  const db = {
    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown): Promise<{ email: string }[]> =>
          Promise.resolve([{ email: "admin@example.com" }]),
      }),
    }),
  };

  return { db, systemSettings, users };
});

vi.mock("./desktop-installer-health.js", () => ({
  runDesktopInstallerHealthCheck: runHealthCheckMock,
}));

vi.mock("./desktop-installer-alerts.js", () => ({
  dispatchInstallerAlert: dispatchAlertMock,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";
import {
  checkAndAlertInstallerHealth,
  resolveHealthCheckHourUtc,
  msUntilNextHourUtc,
  startInstallerHealthCheckJob,
  _resetInstallerHealthJobTimer,
  DEFAULT_HEALTH_CHECK_HOUR_UTC,
} from "./installer-health-job.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHealthyReport() {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    settings: { version: "1.2.3", downloadUrl: "/downloads/LabTrax-Windows-Portable.zip", activeKind: "zip", error: null },
    storage: { ok: true, size: 1000, uploadedAt: new Date().toISOString(), etag: "abc", error: null },
    storageSlots: { zip: { ok: true, size: 1000, uploadedAt: null, error: null }, exe: { ok: false, size: null, uploadedAt: null, error: "no exe" }, dmg: { ok: false, size: null, uploadedAt: null, error: "no dmg" } },
    download: { ok: true, checked: true, url: "https://example.com/downloads/LabTrax-Windows-Portable.zip", status: 200, contentLength: 1000, etag: "abc", etagMatchesStorage: true, error: null },
    downloadSpeed: { checked: false, bytesPerSecond: null, estimatedSeconds: null, slow: false, error: null },
    githubRelease: { ok: false, configured: false, tagName: null, publishedAt: null, manifestUrl: null, hasManifest: false, issue: null },
    downloadInterruptions: { count24h: 0, retryFailCount24h: 0, lastOccurredAt: null },
    issues: [],
  };
}

function makeUnhealthyReport(issues: string[] = ["storage: No zip installer is uploaded in App Storage."]) {
  const base = makeHealthyReport();
  return {
    ...base,
    ok: false,
    storage: { ok: false, size: null as number | null, uploadedAt: null as string | null, etag: null as string | null, error: issues[0] ?? "unknown" },
    download: { ok: false, checked: true, url: null as string | null, status: null as number | null, contentLength: null as number | null, etag: null as string | null, etagMatchesStorage: null as boolean | null, error: "HEAD returned 404" },
    issues,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _resetInstallerHealthJobTimer();
  delete process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC;
  delete process.env.INSTALLER_HEALTH_BASE_URL;
});

afterEach(() => {
  _resetInstallerHealthJobTimer();
  delete process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC;
  delete process.env.INSTALLER_HEALTH_BASE_URL;
});

// ---------------------------------------------------------------------------
// checkAndAlertInstallerHealth — core alert behaviour
// ---------------------------------------------------------------------------

describe("checkAndAlertInstallerHealth — alert dispatch", () => {
  it("does NOT dispatch an alert when the health check reports ok=true", async () => {
    runHealthCheckMock.mockResolvedValue(makeHealthyReport());

    await checkAndAlertInstallerHealth();

    expect(dispatchAlertMock).not.toHaveBeenCalled();
  });

  it("dispatches an alert when the health check reports ok=false", async () => {
    const report = makeUnhealthyReport(["storage: No zip installer uploaded.", "download: HEAD returned 404"]);
    runHealthCheckMock.mockResolvedValue(report);
    dispatchAlertMock.mockResolvedValue({ sent: true, suppressed: false, hash: "abc123" });

    await checkAndAlertInstallerHealth();

    expect(dispatchAlertMock).toHaveBeenCalledOnce();
    const args = dispatchAlertMock.mock.calls[0][0] as {
      stage: string;
      workflowName: string;
      version: string | null;
      errorMessage: string;
    };
    expect(args.stage).toBe("health-check");
    expect(args.workflowName).toBe("scheduled-health-check");
    expect(args.version).toBe("1.2.3");
    expect(args.errorMessage).toContain("storage:");
    expect(args.errorMessage).toContain("download:");
  });

  it("passes admin emails from the DB to dispatchInstallerAlert", async () => {
    runHealthCheckMock.mockResolvedValue(makeUnhealthyReport());
    dispatchAlertMock.mockResolvedValue({ sent: true, suppressed: false, hash: "xyz" });

    await checkAndAlertInstallerHealth();

    const args = dispatchAlertMock.mock.calls[0][0] as { adminEmails: string[] };
    expect(args.adminEmails).toContain("admin@example.com");
  });

  it("passes the download HTTP status to dispatchInstallerAlert", async () => {
    const report = makeUnhealthyReport();
    report.download.status = 404;
    runHealthCheckMock.mockResolvedValue(report);
    dispatchAlertMock.mockResolvedValue({ sent: true, suppressed: false, hash: "xyz" });

    await checkAndAlertInstallerHealth();

    const args = dispatchAlertMock.mock.calls[0][0] as { httpStatus: number | null };
    expect(args.httpStatus).toBe(404);
  });

  it("logs a warn when the alert is sent successfully", async () => {
    runHealthCheckMock.mockResolvedValue(makeUnhealthyReport());
    dispatchAlertMock.mockResolvedValue({ sent: true, suppressed: false, hash: "deadbeef" });

    await checkAndAlertInstallerHealth();

    const warnCalls = (logger.warn as Mock).mock.calls;
    const alertWarn = warnCalls.find((c) => String(c[1]).includes("Alert dispatched"));
    expect(alertWarn).toBeDefined();
  });

  it("logs an info when the alert is suppressed by the dedup window", async () => {
    runHealthCheckMock.mockResolvedValue(makeUnhealthyReport());
    dispatchAlertMock.mockResolvedValue({
      sent: false,
      suppressed: true,
      hash: "deadbeef",
      lastSentAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    await checkAndAlertInstallerHealth();

    const infoCalls = (logger.info as Mock).mock.calls;
    const suppressedInfo = infoCalls.find((c) => String(c[1]).includes("suppressed"));
    expect(suppressedInfo).toBeDefined();
    // Alert should NOT have been logged as "dispatched"
    const warnCalls = (logger.warn as Mock).mock.calls;
    const alertWarn = warnCalls.find((c) => String(c[1]).includes("Alert dispatched"));
    expect(alertWarn).toBeUndefined();
  });

  it("logs info when no admin recipients are configured (sent=false, suppressed=false)", async () => {
    runHealthCheckMock.mockResolvedValue(makeUnhealthyReport());
    dispatchAlertMock.mockResolvedValue({ sent: false, suppressed: false, hash: "noemail" });

    await checkAndAlertInstallerHealth();

    const infoCalls = (logger.info as Mock).mock.calls;
    const noRecipInfo = infoCalls.find((c) => String(c[1]).includes("no admin recipients"));
    expect(noRecipInfo).toBeDefined();
  });

  it("uses a fallback error message when issues array is empty but ok=false", async () => {
    const report = { ...makeUnhealthyReport([]), ok: false };
    runHealthCheckMock.mockResolvedValue(report);
    dispatchAlertMock.mockResolvedValue({ sent: true, suppressed: false, hash: "fb" });

    await checkAndAlertInstallerHealth();

    const args = dispatchAlertMock.mock.calls[0][0] as { errorMessage: string };
    expect(args.errorMessage).toBe("Health check reported unhealthy.");
  });
});

// ---------------------------------------------------------------------------
// checkAndAlertInstallerHealth — error resilience
// ---------------------------------------------------------------------------

describe("checkAndAlertInstallerHealth — error resilience", () => {
  it("does not throw when runDesktopInstallerHealthCheck rejects", async () => {
    runHealthCheckMock.mockRejectedValue(new Error("DB timeout"));

    await expect(checkAndAlertInstallerHealth()).resolves.toBeUndefined();

    const errorCalls = (logger.error as Mock).mock.calls;
    const errLog = errorCalls.find((c) => String(c[1]).includes("failed"));
    expect(errLog).toBeDefined();
  });

  it("does not throw when dispatchInstallerAlert rejects", async () => {
    runHealthCheckMock.mockResolvedValue(makeUnhealthyReport());
    dispatchAlertMock.mockRejectedValue(new Error("SMTP error"));

    await expect(checkAndAlertInstallerHealth()).resolves.toBeUndefined();
  });

  it("passes INSTALLER_HEALTH_BASE_URL to the health check", async () => {
    process.env.INSTALLER_HEALTH_BASE_URL = "https://mylab.example.com";
    runHealthCheckMock.mockResolvedValue(makeHealthyReport());

    await checkAndAlertInstallerHealth();

    expect(runHealthCheckMock).toHaveBeenCalledWith({ baseUrl: "https://mylab.example.com" });
  });

  it("passes null baseUrl when INSTALLER_HEALTH_BASE_URL is not set", async () => {
    runHealthCheckMock.mockResolvedValue(makeHealthyReport());

    await checkAndAlertInstallerHealth();

    expect(runHealthCheckMock).toHaveBeenCalledWith({ baseUrl: null });
  });
});

// ---------------------------------------------------------------------------
// resolveHealthCheckHourUtc
// ---------------------------------------------------------------------------

describe("resolveHealthCheckHourUtc", () => {
  it(`defaults to ${DEFAULT_HEALTH_CHECK_HOUR_UTC} when env var is not set`, () => {
    expect(resolveHealthCheckHourUtc()).toBe(DEFAULT_HEALTH_CHECK_HOUR_UTC);
  });

  it("parses a valid integer env var", () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "14";
    expect(resolveHealthCheckHourUtc()).toBe(14);
  });

  it("clamps to 0 for boundary value", () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "0";
    expect(resolveHealthCheckHourUtc()).toBe(0);
  });

  it("clamps to 23 for boundary value", () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "23";
    expect(resolveHealthCheckHourUtc()).toBe(23);
  });

  it(`falls back to default for out-of-range value 25`, () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "25";
    expect(resolveHealthCheckHourUtc()).toBe(DEFAULT_HEALTH_CHECK_HOUR_UTC);
  });

  it(`falls back to default for non-numeric value`, () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "noon";
    expect(resolveHealthCheckHourUtc()).toBe(DEFAULT_HEALTH_CHECK_HOUR_UTC);
  });

  it(`falls back to default for empty string`, () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "";
    expect(resolveHealthCheckHourUtc()).toBe(DEFAULT_HEALTH_CHECK_HOUR_UTC);
  });
});

// ---------------------------------------------------------------------------
// msUntilNextHourUtc
// ---------------------------------------------------------------------------

describe("msUntilNextHourUtc", () => {
  it("always returns a positive value (> 0)", () => {
    for (let h = 0; h <= 23; h++) {
      const ms = msUntilNextHourUtc(h);
      expect(ms).toBeGreaterThan(0);
    }
  });

  it("returns at most 24 hours from now", () => {
    const MS_24H = 24 * 60 * 60 * 1000;
    for (let h = 0; h <= 23; h++) {
      const ms = msUntilNextHourUtc(h);
      expect(ms).toBeLessThanOrEqual(MS_24H);
    }
  });

  it("targets a future occurrence when the hour has already passed today", () => {
    const pastHour = new Date().getUTCHours();
    // Use an hour that is definitely in the past — if it's 0 we pick 0 still
    // but msUntilNextHourUtc will point to tomorrow.
    const ms = msUntilNextHourUtc(pastHour);
    // Should be > 0 regardless.
    expect(ms).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// startInstallerHealthCheckJob — singleton guard
// ---------------------------------------------------------------------------

describe("startInstallerHealthCheckJob — singleton guard", () => {
  it("does not throw on first call", () => {
    expect(() => startInstallerHealthCheckJob()).not.toThrow();
  });

  it("is idempotent — calling twice does not register a second timer", () => {
    startInstallerHealthCheckJob();
    const logInfoFirst = (logger.info as Mock).mock.calls.filter((c) =>
      String(c[1]).includes("Health check job scheduled"),
    ).length;

    startInstallerHealthCheckJob();
    const logInfoSecond = (logger.info as Mock).mock.calls.filter((c) =>
      String(c[1]).includes("Health check job scheduled"),
    ).length;

    // The scheduling log should only appear once.
    expect(logInfoFirst).toBe(1);
    expect(logInfoSecond).toBe(1);
  });

  it("logs the scheduled hour from the env var", () => {
    process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC = "9";

    startInstallerHealthCheckJob();

    const logCalls = (logger.info as Mock).mock.calls;
    const schedLog = logCalls.find((c) => String(c[1]).includes("Health check job scheduled"));
    expect(schedLog).toBeDefined();
    // The first argument should include hourUtc: 9
    const logObj = schedLog?.[0] as { hourUtc?: number };
    expect(logObj?.hourUtc).toBe(9);
  });

  it("after _resetInstallerHealthJobTimer, can be started again", () => {
    startInstallerHealthCheckJob();
    _resetInstallerHealthJobTimer();

    const callsBefore = (logger.info as Mock).mock.calls.filter((c) =>
      String(c[1]).includes("Health check job scheduled"),
    ).length;

    startInstallerHealthCheckJob();

    const callsAfter = (logger.info as Mock).mock.calls.filter((c) =>
      String(c[1]).includes("Health check job scheduled"),
    ).length;

    expect(callsAfter).toBe(callsBefore + 1);
  });
});
