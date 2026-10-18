/**
 * Alert path for the scheduled production database identity check.
 *
 * `scripts/src/monitor-production-data-fingerprint.ts` runs the same read-only
 * comparison the publish preflight runs, on a schedule, so a production
 * database that is rebound or emptied between publishes is noticed within
 * hours. The monitor holds no mail credentials and no recipient list, so when
 * production stops matching it POSTs what it found to
 * `/api/admin/database-identity/alert`, and this module turns that into the
 * same admin alert email the other ops paths use.
 *
 * Two deliberate differences from the installer alert path:
 *
 *  - No email-preference filter. The system-ops preferences
 *    (installerAlerts, backupAlerts, cleanupAlerts) default OFF because those
 *    alerts fire on routine pipeline noise. This one fires only when
 *    production may not be the lab's own database — an opt-out default would
 *    mean nobody is told at all.
 *  - No dedup state. Suppressing repeats would require writing to the very
 *    database whose identity is in question, and the monitoring job promises
 *    never to write to any database. The schedule's cadence is the rate limit,
 *    and a repeat alert is correct while production still does not match:
 *    silence would be indistinguishable from the problem being fixed.
 */
import { sendDatabaseIdentityAlertEmail } from "./mail.js";
import { logger as defaultLogger } from "./logger.js";

/** Where the expected values live, when the caller does not say. */
export const DEFAULT_FINGERPRINT_PATH = "scripts/database-fingerprint.json";

/** The only sanctioned way to change them, when the caller does not say. */
export const DEFAULT_RECORD_COMMAND =
  "pnpm --filter @workspace/scripts run record-production-data-fingerprint";

/** Bounds on an externally supplied payload — enough for the real report. */
export const MAX_FACTS = 12;
export const MAX_FINDINGS = 24;
export const MAX_TEXT_LENGTH = 600;

export type IdentityFindingLevel = "failure" | "warning";

export interface IdentityAlertFinding {
  level: IdentityFindingLevel;
  message: string;
}

export interface DatabaseIdentityAlertRequest {
  /** Which database was compared. */
  target: string;
  /** Who reported it (the monitor's label). */
  source: string;
  /** When the comparison ran (ISO). */
  checkedAt: string;
  /** The reported facts, as the identity check words them. */
  facts: string[];
  /** Why the comparison refused production. Always holds one failure. */
  findings: IdentityAlertFinding[];
  fingerprintPath: string;
  recordCommand: string;
  /**
   * The lab the committed fingerprint protects, or null when the fingerprint
   * covers the whole database. Decides who may be told — see
   * `selectLabAdminRecipients`.
   */
  protectedLabOrganizationId: string | null;
}

export type ParseResult =
  | { ok: true; value: DatabaseIdentityAlertRequest }
  | { ok: false; error: string };

interface DispatchLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Validate a reported identity mismatch.
 *
 * Strict on purpose: this endpoint exists to carry one specific report, and a
 * payload that cannot say what production looked like or why it was refused
 * would produce an alert nobody can act on. A report with no failure is
 * rejected rather than mailed — "production still matches" is not an alert,
 * and accepting it would turn this route into a general-purpose mailer.
 */
export function parseDatabaseIdentityAlertRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A JSON object body is required." };
  }
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.facts)) {
    return { ok: false, error: "facts must be an array of reported facts." };
  }
  const facts = raw.facts
    .map((fact) => text(fact))
    .filter((fact): fact is string => fact !== null)
    .slice(0, MAX_FACTS);
  if (facts.length === 0) {
    return { ok: false, error: "facts must contain at least one fact." };
  }

  if (!Array.isArray(raw.findings)) {
    return { ok: false, error: "findings must be an array of findings." };
  }
  const findings: IdentityAlertFinding[] = [];
  for (const entry of raw.findings.slice(0, MAX_FINDINGS)) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const level = candidate.level === "failure" ? "failure" : "warning";
    const message = text(candidate.message);
    if (!message) continue;
    findings.push({ level, message });
  }
  if (!findings.some((finding) => finding.level === "failure")) {
    return {
      ok: false,
      error:
        "findings must contain at least one failure — this endpoint reports a database that stopped matching its fingerprint, not a healthy check.",
    };
  }

  const checkedAtRaw = text(raw.checkedAt);
  const checkedAt =
    checkedAtRaw && Number.isFinite(Date.parse(checkedAtRaw))
      ? new Date(checkedAtRaw).toISOString()
      : new Date().toISOString();

  return {
    ok: true,
    value: {
      target: text(raw.target) ?? "production",
      source: text(raw.source) ?? "unknown",
      checkedAt,
      facts,
      // Failures first: the reason this is an alert should read before any
      // bookkeeping warning that happened to come along with it.
      findings: [
        ...findings.filter((f) => f.level === "failure"),
        ...findings.filter((f) => f.level !== "failure"),
      ],
      fingerprintPath: text(raw.fingerprintPath) ?? DEFAULT_FINGERPRINT_PATH,
      recordCommand: text(raw.recordCommand) ?? DEFAULT_RECORD_COMMAND,
      protectedLabOrganizationId: text(raw.protectedLabOrganizationId),
    },
  };
}

/** Lab membership roles that run the lab, and so may be told about it. */
export const LAB_ADMIN_MEMBERSHIP_ROLES = ["owner", "admin"] as const;

/** A candidate recipient: a user row, plus its protected-lab membership. */
export interface AdminRecipientCandidate {
  email: string | null;
  role: string | null;
  userType: string | null;
  isActive: boolean | null;
  /** Which lab the joined membership belongs to, when the alert is scoped. */
  membershipLabId?: string | null;
  /** That membership's role (`owner`, `admin`, `user`, ...). */
  membershipRole?: string | null;
  /** That membership's status; only an active one counts. */
  membershipStatus?: string | null;
}

/**
 * Narrow candidate accounts to the admins of the lab this alert is about.
 *
 * Two separate mistakes are excluded here, and each of them would let the
 * monitor report "lab admins were alerted" about an incident the lab never
 * heard of:
 *
 *  - `role = 'admin'` is not the lab. Platform operators
 *    (`userType = 'master_admin'`) and provider-side admins carry the same
 *    role, and a deactivated account's mailbox may still accept mail.
 *  - An admin is not *this* lab's admin. The committed fingerprint protects
 *    one lab, and this database holds others (the authorized recovery merge
 *    put several lineages in production). Mailing another lab's owner both
 *    leaves the protected lab uninformed and discloses its incident across a
 *    tenant boundary, so a scoped alert requires an active, undeleted
 *    membership of the protected lab in an admin-level role.
 *
 * With no protected lab the whole database is what the fingerprint protects,
 * so every active lab admin in it is an intended recipient. A null or empty
 * `userType` counts as a lab account: the column defaults to `lab` and
 * predates provider accounts, so legacy lab admins have it blank. Everything
 * else is excluded by name rather than by guess.
 */
export function selectLabAdminRecipients(
  candidates: AdminRecipientCandidate[],
  options: { protectedLabOrganizationId?: string | null } = {},
): string[] {
  const protectedLabId = (options.protectedLabOrganizationId ?? "").trim();
  const scoped = protectedLabId !== "";
  const seen = new Set<string>();
  const recipients: string[] = [];

  for (const candidate of candidates) {
    if (candidate.isActive === false) continue;
    const userType = (candidate.userType ?? "").trim().toLowerCase();
    if (userType !== "" && userType !== "lab") continue;

    if (scoped) {
      if ((candidate.membershipLabId ?? "").trim() !== protectedLabId) continue;
      if ((candidate.membershipStatus ?? "").trim().toLowerCase() !== "active")
        continue;
      const membershipRole = (candidate.membershipRole ?? "")
        .trim()
        .toLowerCase();
      if (
        !LAB_ADMIN_MEMBERSHIP_ROLES.some((role) => role === membershipRole)
      ) {
        continue;
      }
    } else if ((candidate.role ?? "").trim().toLowerCase() !== "admin") {
      continue;
    }

    const email = (candidate.email ?? "").trim();
    if (email === "") continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }

  return recipients;
}

export interface DatabaseIdentityAlertOutcome {
  /** True only when at least one admin actually received the email. */
  sent: boolean;
  /** How many admins received it. */
  recipients: number;
  /** How many admin addresses were tried. */
  attempted: number;
  /** Why the rest did not receive it. */
  failures: Array<{ email: string; reason: string }>;
}

/**
 * Email lab admins that production no longer matches its recorded identity.
 *
 * Reports what was actually delivered rather than what was attempted. Both
 * ways this can come up short are part of the same incident and have to reach
 * the caller as a failed alert:
 *
 *  - nobody to tell: a production database that was replaced or emptied can
 *    also be one with no admin accounts in it;
 *  - nobody reachable: mail is unconfigured, or SMTP refused every address.
 *
 * Counting either as a sent alert would leave the monitor reporting success
 * for an incident no human ever heard about.
 */
export async function dispatchDatabaseIdentityAlert(
  input: {
    adminEmails: string[];
    request: DatabaseIdentityAlertRequest;
  },
  logger: DispatchLogger = defaultLogger,
): Promise<DatabaseIdentityAlertOutcome> {
  const { adminEmails, request } = input;

  if (adminEmails.length === 0) {
    logger.error(
      { target: request.target, checkedAt: request.checkedAt },
      "[database-identity] Production identity mismatch reported but no admin recipients exist to tell.",
    );
    return { sent: false, recipients: 0, attempted: 0, failures: [] };
  }

  const delivery = await sendDatabaseIdentityAlertEmail({
    adminEmails,
    checkedAt: request.checkedAt,
    facts: request.facts,
    findings: request.findings,
    fingerprintPath: request.fingerprintPath,
    recordCommand: request.recordCommand,
  });

  const outcome: DatabaseIdentityAlertOutcome = {
    sent: delivery.delivered.length > 0,
    recipients: delivery.delivered.length,
    attempted: delivery.attempted,
    failures: delivery.failures,
  };

  logger.error(
    {
      target: request.target,
      source: request.source,
      checkedAt: request.checkedAt,
      recipients: outcome.recipients,
      attempted: outcome.attempted,
      undelivered: outcome.failures.map((f) => f.reason),
      identityFailures: request.findings.filter((f) => f.level === "failure")
        .length,
    },
    outcome.sent
      ? "[database-identity] Production no longer matches its recorded fingerprint — alert emailed to lab admins."
      : "[database-identity] Production no longer matches its recorded fingerprint and the alert email reached nobody.",
  );

  return outcome;
}
