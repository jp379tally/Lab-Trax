#!/usr/bin/env tsx
/**
 * Scheduled check that production is still the lab's own database.
 *
 * The publish preflight compares production against the fingerprint committed
 * in `scripts/database-fingerprint.json`, but only while a deployment is being
 * built. This job runs the *same* comparison on a cadence, so a production
 * database that is rebound or emptied between publishes is noticed within
 * hours instead of at the next publish.
 *
 * Intended to be wired up as a Replit Scheduled Deployment (the same pattern as
 * run-finance-cron) running every few hours:
 *
 *   pnpm --filter @workspace/scripts run monitor-production-data-fingerprint
 *
 * Required environment:
 *   PROD_DATABASE_URL               production connection string; the package
 *                                   script points DATABASE_URL at it
 *   PLATFORM_ADMIN_SECRET           shared secret for the admin alert endpoint
 *   DATA_FINGERPRINT_ALERT_BASE_URL base URL of the API server
 *                                   (falls back to PUBLISH_API_BASE_URL)
 *
 * What this job will not do:
 *   - write to any database. The probe runs inside a read-only transaction.
 *   - update the committed fingerprint. Expected values change only by running
 *     `record-production-data-fingerprint` and committing the diff, so a
 *     swapped database cannot quietly become the new baseline.
 *
 * Exit codes:
 *   0  production matches the committed fingerprint
 *   1  the check could not be run (configuration, connection, unreadable file)
 *   2  production does not match — lab admins were alerted
 *   3  production does not match — the alert could not be delivered
 *
 * A run that still finds a mismatch alerts again, on purpose: while production
 * is not the lab's database, silence is indistinguishable from the problem
 * being fixed. The schedule's own cadence is the rate limit.
 */

import {
  DATA_FINGERPRINT_RELATIVE_PATH,
  type DataIdentityVerdict,
  loadExpectedDataFingerprints,
  resolveDataIdentity,
} from "./data-fingerprint";
import {
  MONITOR_ALERT_PATH,
  MONITOR_LABEL,
  type MonitorAlertPayload,
  buildMonitorOutcome,
  withReadOnlySession,
} from "./data-fingerprint-monitor";

const TARGET = "production" as const;

const EXIT_CHECK_FAILED = 1;
const EXIT_MISMATCH_ALERTED = 2;
const EXIT_MISMATCH_NOT_ALERTED = 3;

function info(message: string): void {
  console.info(`${MONITOR_LABEL} (${TARGET}): ${message}`);
}

function warn(message: string): void {
  console.warn(`${MONITOR_LABEL} (${TARGET}): ${message}`);
}

function fail(message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`${MONITOR_LABEL} (${TARGET}): ${message}`);
  } else {
    console.error(`${MONITOR_LABEL} (${TARGET}): ${message}`, error);
  }
}

interface AlertConfig {
  url: string;
  secret: string;
}

/**
 * Resolve the alert destination before touching the database.
 *
 * A monitor that cannot tell anyone what it found is not a monitor, so a
 * missing destination is a startup failure rather than a surprise discovered
 * at the one moment the alert matters.
 */
function resolveAlertConfig(): AlertConfig {
  // Header values are trimmed in transit, so a secret stored with stray
  // whitespace would be sent as something the server never matches. Trim here
  // and compare against the untrimmed value to catch it immediately.
  const rawSecret = process.env.PLATFORM_ADMIN_SECRET ?? "";
  const secret = rawSecret.trim();
  if (!secret) {
    throw new Error(
      "PLATFORM_ADMIN_SECRET is required so the monitor can reach the admin alert endpoint.",
    );
  }
  if (secret !== rawSecret) {
    throw new Error(
      "PLATFORM_ADMIN_SECRET has leading or trailing whitespace. HTTP strips it in transit, so the server would reject every alert this job sends.",
    );
  }

  const baseRaw = (
    process.env.DATA_FINGERPRINT_ALERT_BASE_URL ??
    process.env.PUBLISH_API_BASE_URL ??
    ""
  ).trim();
  if (!baseRaw) {
    throw new Error(
      "DATA_FINGERPRINT_ALERT_BASE_URL (or PUBLISH_API_BASE_URL) is required so the monitor can reach the admin alert endpoint.",
    );
  }

  return {
    url: `${baseRaw.replace(/\/+$/, "")}${MONITOR_ALERT_PATH}`,
    secret,
  };
}

interface AlertResult {
  delivered: boolean;
  detail: string;
}

async function sendAlert(
  config: AlertConfig,
  payload: MonitorAlertPayload,
): Promise<AlertResult> {
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Platform-Admin-Secret": config.secret,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {
      delivered: false,
      detail: `POST ${config.url} failed: ${(error as Error)?.message ?? String(error)}`,
    };
  }

  const text = await response.text();
  if (!response.ok) {
    return {
      delivered: false,
      detail: `POST ${config.url} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
    };
  }

  let parsed: {
    success?: boolean;
    recipients?: number;
    attempted?: number;
    failureReasons?: string[];
  } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      delivered: false,
      detail: `POST ${config.url} returned HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 500)}`,
    };
  }

  if (!parsed?.success) {
    return {
      delivered: false,
      detail: `the alert endpoint did not confirm the alert: ${text.slice(0, 500)}`,
    };
  }

  // `recipients` is how many admins the mail server accepted. Zero means
  // nobody was told, which is part of the same incident rather than a
  // successful alert: an emptied or rebound production database can also be
  // one with no admin accounts in it, and a mail server that is unconfigured
  // or refusing mail silences the alert just as completely.
  if (!parsed.recipients || parsed.recipients < 1) {
    const attempted = parsed.attempted ?? 0;
    const reasons = parsed.failureReasons?.length
      ? ` (${parsed.failureReasons.join(", ")})`
      : "";
    return {
      delivered: false,
      detail:
        attempted > 0
          ? `the alert endpoint reached none of the ${attempted} lab admin recipient(s)${reasons}. Check the API server's mail configuration.`
          : "the alert endpoint found no lab admin recipients, so nobody was told. Check the admin accounts on the database the API server is bound to.",
    };
  }

  return {
    delivered: true,
    detail: `alert sent to ${parsed.recipients} lab admin recipient(s)`,
  };
}

async function main(): Promise<void> {
  const alertConfig = resolveAlertConfig();

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      "DATABASE_URL is empty. Monitoring production needs PROD_DATABASE_URL to be set so DATABASE_URL can be pointed at production.",
    );
  }

  // Read before connecting: an unreadable or malformed fingerprint file means
  // there is nothing to compare against, and that is a failure of the check
  // rather than a verdict about the database.
  const expected = loadExpectedDataFingerprints();

  // Imported lazily so the missing-connection-string message above wins over
  // the generic one the db package throws while loading.
  const { pool } = await import("@workspace/db");

  const checkedAt = new Date().toISOString();
  let verdict: DataIdentityVerdict;
  try {
    const client = await pool.connect();
    try {
      verdict = await withReadOnlySession(client, (query) =>
        resolveDataIdentity({ target: TARGET, expected, query }),
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  const outcome = buildMonitorOutcome({
    target: TARGET,
    observed: verdict.observed,
    expected,
    findings: verdict.findings,
    checkedAt,
  });

  for (const line of outcome.facts) info(line);
  for (const finding of outcome.findings) {
    (finding.level === "failure" ? fail : warn)(
      `${finding.level === "failure" ? "BLOCKED" : "WARNING"} — ${finding.message}`,
    );
  }

  if (!outcome.payload) {
    info(`matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}`);
    return;
  }

  fail(
    `production no longer matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}. Alerting lab admins.`,
  );

  const result = await sendAlert(alertConfig, outcome.payload);
  if (!result.delivered) {
    fail(`could not alert lab admins — ${result.detail}`);
    process.exitCode = EXIT_MISMATCH_NOT_ALERTED;
    return;
  }

  fail(result.detail);
  process.exitCode = EXIT_MISMATCH_ALERTED;
}

main().catch((error) => {
  fail("the scheduled identity check could not be completed", error);
  process.exitCode = EXIT_CHECK_FAILED;
});
