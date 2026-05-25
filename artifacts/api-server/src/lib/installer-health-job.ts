/**
 * Scheduled nightly health check for the desktop installer publish pipeline.
 *
 * Calls runDesktopInstallerHealthCheck() once per day at the configured UTC
 * hour and dispatches a deduped admin alert via dispatchInstallerAlert() when
 * any probe fails. Dedup uses the same 6 h suppression window as the
 * installer publish-failure alert (see lib/desktop-installer-alerts.ts).
 *
 * Schedule control:
 *   INSTALLER_HEALTH_CHECK_HOUR_UTC  — UTC hour (0–23) for the nightly run
 *                                      (default: 6, i.e. 06:00 UTC)
 *   INSTALLER_HEALTH_BASE_URL        — base URL passed to the health probe so
 *                                      the download HEAD check can resolve
 *                                      relative /downloads/... paths.
 */
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runDesktopInstallerHealthCheck } from "./desktop-installer-health.js";
import { dispatchInstallerAlert } from "./desktop-installer-alerts.js";
import { logger } from "./logger.js";
import { filterEmailsByPref } from "./email-prefs.js";

export const DEFAULT_HEALTH_CHECK_HOUR_UTC = 6;

/**
 * Parse and clamp the INSTALLER_HEALTH_CHECK_HOUR_UTC env var.
 * Returns an integer in [0, 23]; falls back to DEFAULT_HEALTH_CHECK_HOUR_UTC.
 */
export function resolveHealthCheckHourUtc(): number {
  const v = parseInt(process.env.INSTALLER_HEALTH_CHECK_HOUR_UTC ?? "", 10);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : DEFAULT_HEALTH_CHECK_HOUR_UTC;
}

/**
 * Milliseconds until the next occurrence of the given UTC hour.
 * Always returns a value > 0: if the hour has already passed today the result
 * targets tomorrow's occurrence.
 */
export function msUntilNextHourUtc(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function loadAdminEmails(): Promise<string[]> {
  try {
    const admins = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, "admin"));
    return admins.map((u) => u.email).filter((e): e is string => Boolean(e));
  } catch (err) {
    logger.warn({ err }, "[installer-health] Failed to load admin emails");
    return [];
  }
}

/**
 * Run the installer health check and dispatch a deduped admin alert if any
 * probe fails. Never throws — all errors are caught and logged so the
 * scheduler is never unwound by a transient failure.
 */
export async function checkAndAlertInstallerHealth(): Promise<void> {
  try {
    const report = await runDesktopInstallerHealthCheck({
      baseUrl: process.env.INSTALLER_HEALTH_BASE_URL ?? null,
    });

    logger.info(
      { ok: report.ok, issueCount: report.issues.length },
      "[installer-health] Scheduled health check completed",
    );

    if (!report.ok) {
      const rawAdminEmails = await loadAdminEmails();
      const adminEmails = await filterEmailsByPref(rawAdminEmails, "installerAlerts");
      const outcome = await dispatchInstallerAlert(
        {
          stage: "health-check",
          adminEmails,
          workflowName: "scheduled-health-check",
          version: report.settings.version ?? null,
          httpStatus: report.download.status ?? null,
          errorMessage:
            report.issues.join("\n") || "Health check reported unhealthy.",
        },
        logger,
      );

      if (outcome.sent) {
        logger.warn(
          { hash: outcome.hash, issueCount: report.issues.length },
          "[installer-health] Alert dispatched to admins",
        );
      } else if (outcome.suppressed) {
        logger.info(
          { hash: outcome.hash, lastSentAt: outcome.lastSentAt },
          "[installer-health] Alert suppressed — identical alert within dedup window",
        );
      } else {
        logger.info(
          { hash: outcome.hash },
          "[installer-health] Alert not sent — no admin recipients configured",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "[installer-health] Scheduled health check job failed");
  }
}

let _healthJobTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule the nightly installer health check.
 * Safe to call multiple times — only the first call registers the timer.
 *
 * The first run fires at the next UTC occurrence of
 * INSTALLER_HEALTH_CHECK_HOUR_UTC (default 06:00 UTC), then repeats every
 * 24 hours.
 */
export function startInstallerHealthCheckJob(): void {
  if (_healthJobTimer !== null) return;

  const hourUtc = resolveHealthCheckHourUtc();
  const msFirst = msUntilNextHourUtc(hourUtc);
  const MS_24H = 24 * 60 * 60 * 1000;

  _healthJobTimer = setTimeout(async () => {
    await checkAndAlertInstallerHealth();
    setInterval(checkAndAlertInstallerHealth, MS_24H);
  }, msFirst);

  const hoursUntilFirst = Math.round(msFirst / 1000 / 60 / 60);
  logger.info(
    { hourUtc, msUntilFirst: msFirst, hoursUntilFirst },
    `[installer-health] Health check job scheduled — first run at UTC ${String(hourUtc).padStart(2, "0")}:00 (~${hoursUntilFirst}h from now)`,
  );
}

/**
 * Test-only: reset the singleton timer guard so tests can call
 * startInstallerHealthCheckJob() multiple times in isolation.
 */
export function _resetInstallerHealthJobTimer(): void {
  if (_healthJobTimer !== null) {
    clearTimeout(_healthJobTimer);
    _healthJobTimer = null;
  }
}
