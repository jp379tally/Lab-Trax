/**
 * Between-publish monitoring of the production database's identity.
 *
 * The publish preflight (`check-schema-columns` run against production)
 * already refuses to build when production stops matching the fingerprint
 * committed in `scripts/database-fingerprint.json`. That gate only runs while
 * somebody is publishing. If production is rebound to a different database, or
 * emptied, during a quiet stretch, nothing notices until the next publish —
 * which can be weeks later.
 *
 * This module holds the parts of the scheduled monitor that are testable
 * without a database: the read-only session the probe runs inside, and the
 * alert built from the verdict. The comparison itself is deliberately NOT
 * reimplemented here — the runner calls `resolveDataIdentity` from
 * ./data-fingerprint, the same function the publish gate calls, so the two can
 * never drift into disagreeing about what a swapped database looks like.
 *
 * Two properties this module exists to keep true:
 *
 *  - The monitor only reads. The probe runs inside a read-only transaction, so
 *    a later edit that introduces a write is refused by PostgreSQL instead of
 *    quietly mutating the lab's production data.
 *  - The monitor never records what it saw. Expected values change only by
 *    running `record-production-data-fingerprint` and committing the result, so
 *    a swapped database can never promote itself to "the new normal" simply by
 *    surviving until the next check.
 */

import {
  DATA_FINGERPRINT_RELATIVE_PATH,
  RECORD_PRODUCTION_FINGERPRINT_COMMAND,
  type DataFingerprint,
  type ExpectedDataFingerprints,
  type FingerprintFinding,
  type FingerprintQuery,
  type FingerprintTarget,
  formatFinding,
  summarizeDataFingerprint,
} from "./data-fingerprint";

/** Log prefix, and the `source` reported to the alert endpoint. */
export const MONITOR_LABEL = "data-fingerprint-monitor";

/** Where the alert is delivered — the admin alert path on the API server. */
export const MONITOR_ALERT_PATH = "/api/admin/database-identity/alert";

/**
 * Stand-in for the reported facts when the database's shape stopped the probe
 * from reading them. Worded exactly like the publish preflight's line so both
 * surfaces read the same way.
 */
export const UNREADABLE_FACTS_LINE =
  "the lab's record counts and oldest case created_at could not be read from this database";

/**
 * The probe's transaction. `begin transaction read only` is a session
 * statement, not a data change: it makes every statement that follows unable
 * to write, which is the guarantee this job has to offer.
 */
export const BEGIN_READ_ONLY_SQL = "begin transaction read only";

/**
 * Always rollback, never commit. There is nothing to commit, and `rollback` is
 * also valid on a transaction PostgreSQL has already aborted — which is the
 * state a probe against a database with no case tables leaves behind.
 */
export const END_READ_ONLY_SQL = "rollback";

export interface ReadOnlyClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Run `probe` against a single connection held inside a read-only transaction.
 *
 * The transaction is the enforcement, not a convention: a write issued from
 * inside it fails with "cannot execute ... in a read-only transaction" rather
 * than succeeding against production.
 */
export async function withReadOnlySession<T>(
  client: ReadOnlyClient,
  probe: (query: FingerprintQuery) => Promise<T>,
): Promise<T> {
  await client.query(BEGIN_READ_ONLY_SQL);
  try {
    return await probe((sql, values) => client.query(sql, values));
  } finally {
    try {
      await client.query(END_READ_ONLY_SQL);
    } catch {
      // The connection is discarded immediately after this, and a failed
      // rollback says nothing about the verdict. Swallowing it here keeps a
      // broken connection from masking the real finding.
    }
  }
}

export interface MonitorAlertFinding {
  level: FingerprintFinding["level"];
  code: FingerprintFinding["code"];
  message: string;
}

/** The body POSTed to the alert endpoint. */
export interface MonitorAlertPayload {
  source: string;
  target: FingerprintTarget;
  checkedAt: string;
  /** The reported facts, exactly as the publish preflight prints them. */
  facts: string[];
  findings: MonitorAlertFinding[];
  /** Where the expected values live, so the email can name the file. */
  fingerprintPath: string;
  /** The only sanctioned way to change those expected values. */
  recordCommand: string;
  /**
   * The lab the committed fingerprint protects, or null when the fingerprint
   * is database-wide.
   *
   * It travels with the report because it decides who may be told: this
   * database can hold other lineages' labs (the authorized recovery merge put
   * several in production), and an unrelated lab's admin is neither able to
   * act on this incident nor entitled to read it. Taken from the committed
   * file, never from the database being questioned.
   */
  protectedLabOrganizationId: string | null;
}

export interface MonitorOutcome {
  /** The reported facts, whatever the verdict. */
  facts: string[];
  findings: FingerprintFinding[];
  failures: FingerprintFinding[];
  /** True when production no longer matches what the repository expects. */
  shouldAlert: boolean;
  /** Null unless `shouldAlert` — there is nothing to tell anyone otherwise. */
  payload: MonitorAlertPayload | null;
  /** Everything the run should print, in order. */
  logLines: string[];
}

/**
 * Turn a verdict into what the monitor reports and (when production stops
 * matching) what it sends to lab admins.
 *
 * Warnings are reported but do not alert: on production the only warnings the
 * comparison can raise are about the repository's own bookkeeping — a target
 * with no recorded fingerprint, or a development fingerprint that has gone
 * stale — and waking admins for those would train them to ignore the alert
 * that matters.
 */
export function buildMonitorOutcome({
  target,
  observed,
  expected,
  findings,
  checkedAt,
}: {
  target: FingerprintTarget;
  observed: DataFingerprint | null;
  expected: ExpectedDataFingerprints;
  findings: FingerprintFinding[];
  checkedAt: string;
}): MonitorOutcome {
  const facts = observed
    ? summarizeDataFingerprint({ target, observed, expected })
    : [UNREADABLE_FACTS_LINE];

  const failures = findings.filter((finding) => finding.level === "failure");
  const shouldAlert = failures.length > 0;

  const logLines = [
    ...facts,
    ...findings.map((finding) => formatFinding(finding)),
  ];

  if (shouldAlert) {
    logLines.push(
      `the ${target} database no longer matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}. If this change is legitimate, re-record it with \`${RECORD_PRODUCTION_FINGERPRINT_COMMAND}\` and commit the result.`,
    );
  } else if (findings.length === 0) {
    logLines.push(
      `matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}`,
    );
  }

  return {
    facts,
    findings,
    failures,
    shouldAlert,
    payload: shouldAlert
      ? {
          source: MONITOR_LABEL,
          target,
          checkedAt,
          facts,
          findings: findings.map(({ level, code, message }) => ({
            level,
            code,
            message,
          })),
          fingerprintPath: DATA_FINGERPRINT_RELATIVE_PATH,
          recordCommand: RECORD_PRODUCTION_FINGERPRINT_COMMAND,
          protectedLabOrganizationId:
            expected[target]?.labOrganizationId ?? null,
        }
      : null,
    logLines,
  };
}
