/**
 * Single consolidated alert path for the desktop-installer publish pipeline.
 *
 * Before this module existed, three different callers (build-windows.yml,
 * build-macos.yml, release.yml — each with its own retry semantics) all
 * POSTed to /admin/desktop-installer/publish-failure independently, which
 * could fire 4-6 identical alert emails per failed release run. This helper
 * collapses identical alerts within a configurable window using a payload
 * hash stored in system_settings.installer_publish_alert_last.
 *
 * Distinct failures (different stage, different error, different version)
 * still emit immediately. Re-runs that fail in the same way as the previous
 * alert within the window are suppressed but still logged via req.log.
 *
 * See docs/desktop-publish-pipeline.md ("Single consolidated alert") for the
 * design rationale.
 */
import { createHash } from "node:crypto";
import { db, systemSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendInstallerPublishFailureAlertEmail } from "./mail.js";
import { logger as defaultLogger } from "./logger.js";
import { filterEmailsByPref } from "./email-prefs.js";

const SETTING_LAST_ALERT = "installer_publish_alert_last";

/**
 * Dedup window: identical alerts within this many milliseconds of the last
 * one are suppressed. Six hours is long enough to coalesce a flaky release
 * run into a single email but short enough that the next workday's failure
 * still alerts.
 */
const ALERT_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface InstallerAlertInput {
  /** Where in the pipeline the failure happened. */
  stage:
    | "upload"
    | "settings"
    | "publish"
    | "build-number-commit"
    | "health-check"
    | "unknown";
  /** Recipient list. Empty array = no-op. */
  adminEmails: string[];
  /** Build / health metadata. */
  workflowName?: string | null;
  runUrl?: string | null;
  runId?: string | null;
  commitSha?: string | null;
  ref?: string | null;
  version?: string | null;
  httpStatus?: number | null;
  errorMessage?: string | null;
}

interface LastAlertRow {
  hash: string;
  sentAt: string;
  stage: string;
  version: string | null;
}

interface DispatchLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface InstallerAlertOutcome {
  sent: boolean;
  suppressed: boolean;
  hash: string;
  /** When the last identical alert was dispatched, if suppressed. */
  lastSentAt?: string;
}

/**
 * Build a deterministic hash of the alert's identity fields. The first 200
 * chars of errorMessage are included so retries with the same exception
 * collapse, but a *different* error path still produces a different hash.
 */
function alertHash(input: InstallerAlertInput): string {
  const identity = {
    stage: input.stage,
    workflow: input.workflowName ?? "",
    version: input.version ?? "",
    httpStatus: input.httpStatus ?? "",
    error: (input.errorMessage ?? "").slice(0, 200),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

async function readLastAlert(): Promise<LastAlertRow | null> {
  try {
    const rows = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, SETTING_LAST_ALERT));
    if (!rows[0]?.value) return null;
    const parsed = JSON.parse(rows[0].value) as LastAlertRow;
    if (typeof parsed?.hash !== "string" || typeof parsed?.sentAt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeLastAlert(row: LastAlertRow): Promise<void> {
  const payload = JSON.stringify(row);
  await db
    .insert(systemSettings)
    .values({ key: SETTING_LAST_ALERT, value: payload })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: payload, updatedAt: new Date() },
    });
}

/**
 * Dispatch (or suppress) a single installer pipeline alert. Returns whether
 * the email was actually sent and the hash for downstream logging.
 *
 * `logger` is optional and defaults to the global pino logger; pass `req.log`
 * from a route handler so the alert decision is correlated with the request.
 */
export async function dispatchInstallerAlert(
  input: InstallerAlertInput,
  logger: DispatchLogger = defaultLogger,
): Promise<InstallerAlertOutcome> {
  const hash = alertHash(input);

  const adminEmails = await filterEmailsByPref(input.adminEmails, "installerAlerts");

  if (adminEmails.length === 0) {
    logger.warn(
      { hash, stage: input.stage, version: input.version },
      "Installer alert skipped — no admin recipients configured.",
    );
    return { sent: false, suppressed: false, hash };
  }

  const last = await readLastAlert();
  if (last && last.hash === hash) {
    const ageMs = Date.now() - Date.parse(last.sentAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ALERT_DEDUP_WINDOW_MS) {
      logger.info(
        {
          hash,
          stage: input.stage,
          version: input.version,
          lastSentAt: last.sentAt,
          ageMinutes: Math.round(ageMs / 60000),
        },
        "Installer alert suppressed — identical alert dispatched within dedup window.",
      );
      return { sent: false, suppressed: true, hash, lastSentAt: last.sentAt };
    }
  }

  // emit
  await sendInstallerPublishFailureAlertEmail({
    adminEmails,
    workflowName: input.workflowName ?? null,
    runUrl: input.runUrl ?? null,
    runId: input.runId ?? null,
    commitSha: input.commitSha ?? null,
    ref: input.ref ?? null,
    version: input.version ?? null,
    stage: input.stage,
    httpStatus: input.httpStatus ?? null,
    errorMessage: input.errorMessage ?? null,
  });

  // record
  try {
    await writeLastAlert({
      hash,
      sentAt: new Date().toISOString(),
      stage: input.stage,
      version: input.version ?? null,
    });
  } catch (err) {
    logger.warn(
      { err, hash },
      "Installer alert sent but failed to record dedup state — next identical alert may not be suppressed.",
    );
  }

  return { sent: true, suppressed: false, hash };
}

/**
 * Test-only escape hatch: clear the recorded "last alert" state so the next
 * dispatch always sends. Not exposed via HTTP.
 */
export async function resetInstallerAlertDedupState(): Promise<void> {
  try {
    await db.delete(systemSettings).where(eq(systemSettings.key, SETTING_LAST_ALERT));
  } catch {
    // best-effort
  }
}
