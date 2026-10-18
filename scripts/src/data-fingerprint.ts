/**
 * Database identity fingerprint.
 *
 * A deployment can come up perfectly while bound to the wrong production
 * database: the app starts, login works, and the lab's cases are simply
 * absent. A database identity mismatch can look exactly like that; lineage,
 * not service health, is the useful signal — separate databases are unlikely
 * to share an oldest-row `created_at` to the microsecond, which two
 * independently grown databases are unlikely to do.
 *
 * This module turns that signal into a read-only preflight. It reads the
 * facts out of the connected database's committed scope — how much of each
 * irreplaceable record set it still holds (cases, invoices, users,
 * organizations, doctor profiles, payments, case attachments and audit
 * history), the oldest case `created_at`, and whether that timestamp matches
 * the recorded development one — and compares them against a fingerprint
 * committed to the repository. A legitimate change to those facts is an
 * explicit commit of the fingerprint file; an unexplained one blocks the
 * publish.
 *
 * Everything here is read-only: one `select` of scalar counts, also checking
 * lab existence when a protected-lab scope is committed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Repo-relative location of the committed fingerprint. */
export const DATA_FINGERPRINT_RELATIVE_PATH = "scripts/database-fingerprint.json";

/** Absolute location of the committed fingerprint. */
export const DATA_FINGERPRINT_PATH = resolve(
  import.meta.dirname,
  "..",
  "database-fingerprint.json",
);

/** How an operator re-records a fingerprint after a legitimate change. */
export const RECORD_PRODUCTION_FINGERPRINT_COMMAND =
  "pnpm --filter @workspace/scripts run record-production-data-fingerprint";
export const RECORD_DEVELOPMENT_FINGERPRINT_COMMAND =
  "pnpm --filter @workspace/scripts run record-data-fingerprint";

/**
 * The fraction of the recorded counts production must still hold. Anything
 * below this is treated as "production no longer holds the lab's data"
 * rather than ordinary churn. Overridable per repository through the
 * fingerprint file so the tolerance is reviewed like any other commit.
 */
export const DEFAULT_MINIMUM_RETAINED_FRACTION = 0.9;

/**
 * Microsecond-precision UTC instant, e.g. `2026-05-12T15:44:59.587588Z`.
 * Microseconds are the whole point: second-precision timestamps collide by
 * chance, microsecond ones do not.
 */
export const MICROSECOND_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * The protected lab itself plus every practice it created. Used to scope the
 * record sets that belong to an organization rather than to a case.
 */
const PROTECTED_LAB_ORGANIZATIONS = `
  select id from public.organizations
   where id = $1 or parent_lab_organization_id = $1
`;

export type FingerprintCountField =
  | "activeCaseCount"
  | "invoiceCount"
  | "userCount"
  | "organizationCount"
  | "doctorProfileCount"
  | "paymentCount"
  | "caseAttachmentCount"
  | "auditHistoryCount";

export interface FingerprintCount {
  /** Field name in both the parsed fingerprint and the committed file. */
  field: FingerprintCountField;
  /** Column alias this count takes in the probe's single select. */
  column: string;
  /** Plural label for the preflight summary, e.g. `active cases`. */
  label: string;
  /** Singular noun for findings, rendered as `1338 active case(s)`. */
  noun: string;
  /** Finding reported when this record set collapses. */
  code: FindingCode;
  /** Count across the whole database. */
  databaseWide: string;
  /** The same count within the committed protected-lab scope (`$1`). */
  protectedLab: string;
}

/**
 * The irreplaceable record sets this probe counts.
 *
  * Cases and invoices are not enough to establish database identity. A
  * database can retain case rows while accounts, practices, profiles,
  * payments, media references, or audit history differ, so each record set
  * is counted and compared under the same collapse rule.
 *
 * Every entry contributes one scalar subquery to the single read-only
 * select, one recorded field in the committed fingerprint, one summary line
 * and one collapse finding, so the probe and the comparison cannot drift
 * apart.
 *
 * Counts are raw row counts — `cases.deleted_at is null` is the one
 * exception, because that is the app's own definition of an active case — so
 * an ordinary soft-delete sweep is never mistaken for data loss.
 *
 * Only long-established tables belong here. A table that exists in
 * development but not yet in production would make the whole probe
 * unreadable, and an unreadable production probe blocks the publish.
 */
export const FINGERPRINT_COUNTS: readonly FingerprintCount[] = [
  {
    field: "activeCaseCount",
    column: "active_case_count",
    label: "active cases",
    noun: "active case",
    code: "active-cases-collapsed",
    databaseWide: "select count(*) from public.cases where deleted_at is null",
    protectedLab: `
      select count(*) from public.cases
       where lab_organization_id = $1 and deleted_at is null`,
  },
  {
    field: "invoiceCount",
    column: "invoice_count",
    label: "invoices",
    noun: "invoice",
    code: "invoices-collapsed",
    databaseWide: "select count(*) from public.invoices",
    protectedLab: `
      select count(*) from public.invoices where lab_organization_id = $1`,
  },
  {
    field: "userCount",
    column: "user_count",
    label: "users",
    noun: "user",
    code: "users-collapsed",
    databaseWide: "select count(*) from public.users",
    protectedLab: `
      select count(*) from public.users u
       where exists (
         select 1 from public.lab_memberships m
          where m.user_id = u.id
            and m.lab_id in (${PROTECTED_LAB_ORGANIZATIONS}))`,
  },
  {
    field: "organizationCount",
    column: "organization_count",
    label: "organizations",
    noun: "organization",
    code: "organizations-collapsed",
    databaseWide: "select count(*) from public.organizations",
    protectedLab: `
      select count(*) from public.organizations
       where id = $1 or parent_lab_organization_id = $1`,
  },
  {
    field: "doctorProfileCount",
    column: "doctor_profile_count",
    label: "doctor profiles",
    noun: "doctor profile",
    code: "doctor-profiles-collapsed",
    databaseWide: "select count(*) from public.doctor_profiles",
    protectedLab: `
      select count(*) from public.doctor_profiles
       where lab_organization_id = $1`,
  },
  {
    field: "paymentCount",
    column: "payment_count",
    label: "payments",
    noun: "payment",
    code: "payments-collapsed",
    databaseWide: "select count(*) from public.payments",
    protectedLab: `
      select count(*) from public.payments p
       join public.invoices i on i.id = p.invoice_id
       where i.lab_organization_id = $1`,
  },
  {
    field: "caseAttachmentCount",
    column: "case_attachment_count",
    label: "case attachments",
    noun: "case attachment",
    code: "case-attachments-collapsed",
    databaseWide: "select count(*) from public.case_attachments",
    // An attachment hangs off a canonical case or off a legacy lab case
    // (exception-note media still arrives that way), and only one of the two
    // columns is set. Counting a single link column would leave the other
    // kind of media free to disappear without the gate noticing.
    protectedLab: `
      select count(*) from public.case_attachments a
       where a.case_id in (
               select id from public.cases where lab_organization_id = $1)
          or a.lab_case_id in (
               select id from public.lab_cases where organization_id = $1)`,
  },
  {
    field: "auditHistoryCount",
    column: "audit_history_count",
    label: "audit history rows",
    noun: "audit history row",
    code: "audit-history-collapsed",
    databaseWide: "select count(*) from public.audit_logs",
    protectedLab: `
      select count(*) from public.audit_logs
       where organization_id in (${PROTECTED_LAB_ORGANIZATIONS})`,
  },
];

/** The oldest case row establishes lineage, so it is read separately. */
const OLDEST_CASE_EXPRESSION =
  `select to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
     from public.cases`;

function singleLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Build the probe as one read-only select of scalar subqueries.
 *
 * The oldest `created_at` spans every case row, including soft-deleted ones,
 * because that row establishes lineage and must not move when the lab
 * soft-deletes its earliest case. A protected-lab probe uses the same rule
 * within its committed lab scope.
 */
function buildFingerprintSql(scope: "database-wide" | "protected-lab"): string {
  const protectedLab = scope === "protected-lab";
  const lines = ["select"];
  if (protectedLab) {
    lines.push(
      "  exists(select 1 from public.organizations where id = $1) as lab_exists,",
    );
  }
  for (const count of FINGERPRINT_COUNTS) {
    lines.push(
      `  (${singleLine(protectedLab ? count.protectedLab : count.databaseWide)}) as ${count.column},`,
    );
  }
  lines.push(
    `  (${singleLine(OLDEST_CASE_EXPRESSION)}${protectedLab ? " where lab_organization_id = $1" : ""}) as oldest_case_created_at`,
  );
  return lines.join("\n");
}

/** Read-only lineage and retention probe over the whole database. */
export const DATA_FINGERPRINT_SQL = buildFingerprintSql("database-wide");

/**
 * Production may contain explicitly merged fixture lineages. The protected
 * lab, not an unrelated older fixture, then defines its identity and counts.
 * The scope is committed configuration, never an environment-variable bypass.
 */
export const LAB_DATA_FINGERPRINT_SQL = buildFingerprintSql("protected-lab");

export type FingerprintTarget = "production" | "development";

export type DataFingerprintCounts = Record<FingerprintCountField, number>;

export interface DataFingerprint extends DataFingerprintCounts {
  /** Null only when the database holds no case rows at all. */
  oldestCaseCreatedAt: string | null;
}

export interface RecordedDataFingerprint extends DataFingerprint {
  /** When an operator last recorded this fingerprint, UTC ISO-8601. */
  recordedAt: string;
  /** Optional committed lab scope for a deliberately mixed-lineage database. */
  labOrganizationId?: string;
}

export interface ExpectedDataFingerprints {
  minimumRetainedFraction: number;
  production: RecordedDataFingerprint | null;
  development: RecordedDataFingerprint | null;
}

interface FingerprintQueryResult {
  rows: unknown[];
}

export type FingerprintQuery = (
  sql: string,
  values: unknown[],
) => Promise<FingerprintQueryResult>;

export type FindingLevel = "warning" | "failure";

export type FindingCode =
  | "missing-production-fingerprint"
  | "missing-development-fingerprint"
  | "development-copy"
  | "no-cases"
  | "tables-absent"
  | "fingerprint-unreadable"
  | "lineage-mismatch"
  | "active-cases-collapsed"
  | "invoices-collapsed"
  | "users-collapsed"
  | "organizations-collapsed"
  | "doctor-profiles-collapsed"
  | "payments-collapsed"
  | "case-attachments-collapsed"
  | "audit-history-collapsed"
  | "stale-development-fingerprint";

export interface FingerprintFinding {
  level: FindingLevel;
  code: FindingCode;
  message: string;
}

/** The tables holding the lab's records are themselves absent. */
const MISSING_TABLE_SQLSTATES = new Set(["42P01", "3F000"]);
/** The tables exist but this code expects a column they do not carry yet. */
const MISSING_COLUMN_SQLSTATES = new Set(["42703"]);

export type SchemaProbeFailure = "missing-tables" | "missing-columns";

/**
 * Why the probe could not read a fingerprint, when the reason is the
 * database's shape rather than a connection problem. The two cases are not
 * interchangeable:
 *
 * - Missing tables means the database holds none of the lab's records. For a
 *   production database with a recorded fingerprint that is a swap, not a
 *   pending migration, and it must block.
 * - Missing columns means the tables are there but older than this code.
 *   Replit Publish applies the reviewed schema diff after the build stage, so
 *   blocking here would deadlock the very publish that fixes it.
 *
 * Returns null for anything else, which the caller must treat as a failure.
 */
export function classifySchemaProbeFailure(
  error: unknown,
): SchemaProbeFailure | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  if (MISSING_TABLE_SQLSTATES.has(code)) return "missing-tables";
  if (MISSING_COLUMN_SQLSTATES.has(code)) return "missing-columns";
  return null;
}

export async function readDataFingerprint(
  query: FingerprintQuery,
  labOrganizationId?: string,
): Promise<DataFingerprint> {
  const result = await query(
    labOrganizationId ? LAB_DATA_FINGERPRINT_SQL : DATA_FINGERPRINT_SQL,
    labOrganizationId ? [labOrganizationId] : [],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `database identity probe returned ${result.rows.length} rows, expected exactly 1`,
    );
  }
  if (labOrganizationId) {
    const row = result.rows[0] as Record<string, unknown> | null;
    if (!row || row.lab_exists !== true) {
      throw new Error(`protected lab ${labOrganizationId} is missing or its existence could not be verified`);
    }
  }
  return parseDataFingerprintRow(result.rows[0]);
}

export function parseDataFingerprintRow(rawRow: unknown): DataFingerprint {
  if (typeof rawRow !== "object" || rawRow === null) {
    throw new Error("database identity probe returned a non-object row");
  }
  const row = rawRow as Record<string, unknown>;
  const counts = {} as DataFingerprintCounts;
  for (const count of FINGERPRINT_COUNTS) {
    counts[count.field] = parseCount(row[count.column], count.column);
  }
  return {
    ...counts,
    oldestCaseCreatedAt: parseOldestTimestamp(row.oldest_case_created_at),
  };
}

/**
 * `count(*)` arrives as a bigint string from node-postgres. A missing or
 * unparsable value must throw rather than default to zero: a silent zero
 * would either invent data loss or, worse, be compared as a real count.
 */
function parseCount(value: unknown, column: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `database identity probe returned an unusable ${column}: ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseOldestTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !MICROSECOND_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(
      `database identity probe returned an unusable oldest_case_created_at: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function loadExpectedDataFingerprints(
  path: string = DATA_FINGERPRINT_PATH,
): ExpectedDataFingerprints {
  return parseExpectedDataFingerprints(JSON.parse(readFileSync(path, "utf8")));
}

export function parseExpectedDataFingerprints(
  raw: unknown,
): ExpectedDataFingerprints {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${DATA_FINGERPRINT_RELATIVE_PATH} must contain an object`);
  }
  const file = raw as Record<string, unknown>;
  const fraction = file.minimumRetainedFraction;
  if (
    fraction !== undefined &&
    (typeof fraction !== "number" || !(fraction > 0) || fraction > 1)
  ) {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH}: minimumRetainedFraction must be a number greater than 0 and at most 1`,
    );
  }
  return {
    minimumRetainedFraction:
      typeof fraction === "number" ? fraction : DEFAULT_MINIMUM_RETAINED_FRACTION,
    production: parseRecordedFingerprint(file.production, "production"),
    development: parseRecordedFingerprint(file.development, "development"),
  };
}

function parseRecordedFingerprint(
  raw: unknown,
  section: FingerprintTarget,
): RecordedDataFingerprint | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH}: ${section} must be an object or null`,
    );
  }
  const entry = raw as Record<string, unknown>;
  const recordedAt = entry.recordedAt;
  if (typeof recordedAt !== "string" || recordedAt.trim() === "") {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH}: ${section}.recordedAt must be a non-empty string`,
    );
  }
  const labOrganizationId = entry.labOrganizationId;
  if (
    labOrganizationId !== undefined &&
    (typeof labOrganizationId !== "string" ||
      labOrganizationId.trim() === "" ||
      labOrganizationId !== labOrganizationId.trim())
  ) {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH}: ${section}.labOrganizationId must be a non-empty, unpadded string`,
    );
  }
  // Every counted record set is required. A fingerprint recorded before a
  // record set was added cannot say whether that set survived, and silently
  // skipping the comparison would be exactly the blind spot this gate
  // exists to close: re-record it instead.
  const counts = {} as DataFingerprintCounts;
  for (const count of FINGERPRINT_COUNTS) {
    counts[count.field] = parseRecordedCount(
      entry[count.field],
      `${section}.${count.field}`,
    );
  }

  return {
    recordedAt,
    ...(typeof labOrganizationId === "string" ? { labOrganizationId } : {}),
    ...counts,
    oldestCaseCreatedAt: parseRecordedTimestamp(
      entry.oldestCaseCreatedAt,
      `${section}.oldestCaseCreatedAt`,
    ),
  };
}

function parseRecordedCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH}: ${field} must be a non-negative integer`,
    );
  }
  return value;
}

function parseRecordedTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !MICROSECOND_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(
      `${DATA_FINGERPRINT_RELATIVE_PATH}: ${field} must be a microsecond UTC timestamp such as 2026-05-12T15:44:59.587588Z, or null`,
    );
  }
  return value;
}

export interface FingerprintComparison {
  target: FingerprintTarget;
  observed: DataFingerprint;
  expected: ExpectedDataFingerprints;
}

/**
 * The facts this preflight is required to report, whatever the verdict.
 * They are printed even on success so a publish log always carries the
 * evidence of which database it was pointed at, and how much of each
 * irreplaceable record set that database held.
 */
export function summarizeDataFingerprint({
  target,
  observed,
  expected,
}: FingerprintComparison): string[] {
  const recorded = expected[target];
  const development = expected.development;
  const lines = [
    `scope: ${recorded?.labOrganizationId ? `protected lab ${recorded.labOrganizationId}` : "entire database"}`,
    ...FINGERPRINT_COUNTS.map(
      (count) =>
        `${count.label}: ${observed[count.field]}${formatRecorded(recorded?.[count.field])}`,
    ),
    `oldest case created_at: ${observed.oldestCaseCreatedAt ?? "none (no case rows)"}${formatRecorded(recorded?.oldestCaseCreatedAt)}`,
  ];

  if (target === "development") {
    return lines;
  }

  if (!development) {
    lines.push(
      "matches the development database to the microsecond: unknown (no development fingerprint recorded)",
    );
  } else {
    const matches = matchesDevelopment(observed, development);
    lines.push(
      `matches the development database to the microsecond: ${matches ? "YES" : "no"} (development fingerprint ${development.oldestCaseCreatedAt ?? "none"}, recorded ${development.recordedAt})`,
    );
  }
  return lines;
}

function formatRecorded(value: string | number | null | undefined): string {
  if (value === undefined) return " (no fingerprint recorded)";
  return ` (fingerprint ${value ?? "none"})`;
}

function matchesDevelopment(
  observed: DataFingerprint,
  development: RecordedDataFingerprint,
): boolean {
  return (
    observed.oldestCaseCreatedAt !== null &&
    development.oldestCaseCreatedAt !== null &&
    observed.oldestCaseCreatedAt === development.oldestCaseCreatedAt
  );
}

/**
 * Compare the connected database against the committed fingerprint.
 *
 * Production findings are failures: a publish that would hand the lab a
 * different database is exactly what this gate exists to stop. Development
 * findings are warnings — the development fingerprint only has to stay fresh
 * enough for the production copy-detection above to recognise it.
 */
export function evaluateDataFingerprint({
  target,
  observed,
  expected,
}: FingerprintComparison): FingerprintFinding[] {
  return target === "production"
    ? evaluateProduction(observed, expected)
    : evaluateDevelopment(observed, expected);
}

/**
 * Verdict when the fingerprint could not be read at all because of the
 * database's shape. This must fail closed: a production database that cannot
 * even be asked how many cases it holds, while the repository records that it
 * held thousands, is the swap this gate exists to catch. Only a target with
 * no recorded fingerprint — a genuinely new deployment — is allowed through.
 */
export function evaluateUnreadableFingerprint({
  target,
  expected,
  failure,
}: {
  target: FingerprintTarget;
  expected: ExpectedDataFingerprints;
  failure: SchemaProbeFailure;
}): FingerprintFinding[] {
  const recorded = expected[target];

  if (failure === "missing-columns") {
    return [
      {
        level: "warning",
        code: "fingerprint-unreadable",
        message: `the ${target} tables holding the lab's records exist but do not carry every column this probe reads, so the data fingerprint could not be compared; Replit Publish applies the reviewed schema diff after this build stage, and the comparison resumes once it has`,
      },
    ];
  }

  if (target === "production" && recorded) {
    return [
      {
        level: "failure",
        code: "tables-absent",
        message: `production does not have the tables holding the lab's records, but the fingerprint recorded ${describeRecordedCounts(recorded)} on ${recorded.recordedAt} — this is not the database that fingerprint was taken from`,
      },
    ];
  }

  return [
    {
      level: "warning",
      code: "tables-absent",
      message: `the ${target} database does not have the tables holding the lab's records yet and no ${target} fingerprint is recorded, so there is no lab data to compare`,
    },
  ];
}

/** `1338 active case(s), 1345 invoice(s), 21 user(s), …` */
function describeRecordedCounts(recorded: RecordedDataFingerprint): string {
  return FINGERPRINT_COUNTS.map(
    (count) => `${recorded[count.field]} ${count.noun}(s)`,
  ).join(", ");
}

export interface DataIdentityVerdict {
  /** Null when the database's shape stopped the probe from reading it. */
  observed: DataFingerprint | null;
  findings: FingerprintFinding[];
}

/**
 * Probe the connected database and return its verdict.
 *
 * A probe that cannot run is still a verdict, never a skip: the decision of
 * what an unreadable database means lives here, next to the comparison, so a
 * caller cannot accidentally let a swapped database through by treating a
 * failed read as "nothing to check". Errors that are not about the database's
 * shape (connection loss, permissions) are rethrown for the caller to report.
 */
export async function resolveDataIdentity({
  target,
  expected,
  query,
}: {
  target: FingerprintTarget;
  expected: ExpectedDataFingerprints;
  query: FingerprintQuery;
}): Promise<DataIdentityVerdict> {
  let observed: DataFingerprint;
  try {
    observed = await readDataFingerprint(query, expected[target]?.labOrganizationId);
  } catch (error) {
    const failure = classifySchemaProbeFailure(error);
    if (!failure) throw error;
    if (failure === "missing-columns" && expected[target]?.labOrganizationId) {
      return {
        observed: null,
        findings: [{
          level: target === "production" ? "failure" : "warning",
          code: "fingerprint-unreadable",
          message: "the committed protected-lab scope could not be verified because a required probe column is absent",
        }],
      };
    }
    return {
      observed: null,
      findings: evaluateUnreadableFingerprint({ target, expected, failure }),
    };
  }
  return {
    observed,
    findings: evaluateDataFingerprint({ target, observed, expected }),
  };
}

function evaluateProduction(
  observed: DataFingerprint,
  expected: ExpectedDataFingerprints,
): FingerprintFinding[] {
  const findings: FingerprintFinding[] = [];
  const development = expected.development;
  const recorded = expected.production;

  if (development && matchesDevelopment(observed, development)) {
    findings.push({
      level: "failure",
      code: "development-copy",
      message: `the production oldest case created_at (${observed.oldestCaseCreatedAt}) matches the recorded development database to the microsecond — production looks like a copy of development, not the lab's own database`,
    });
  } else if (!development) {
    findings.push({
      level: "warning",
      code: "missing-development-fingerprint",
      message: `no development fingerprint is recorded, so this preflight cannot tell whether production is a copy of development; record one with \`${RECORD_DEVELOPMENT_FINGERPRINT_COMMAND}\` and commit it`,
    });
  }

  if (!recorded) {
    findings.push({
      level: "warning",
      code: "missing-production-fingerprint",
      message: `no production fingerprint is recorded in ${DATA_FINGERPRINT_RELATIVE_PATH}, so production data loss cannot be detected; record one with \`${RECORD_PRODUCTION_FINGERPRINT_COMMAND}\` and commit it`,
    });
    return findings;
  }

  if (observed.oldestCaseCreatedAt === null && recorded.oldestCaseCreatedAt !== null) {
    findings.push({
      level: "failure",
      code: "no-cases",
      message: `production holds no case rows at all, but the fingerprint recorded ${recorded.activeCaseCount} active case(s) on ${recorded.recordedAt}`,
    });
  } else if (
    observed.oldestCaseCreatedAt !== null &&
    recorded.oldestCaseCreatedAt !== null &&
    observed.oldestCaseCreatedAt !== recorded.oldestCaseCreatedAt
  ) {
    findings.push({
      level: "failure",
      code: "lineage-mismatch",
      message: `the production oldest case created_at is ${observed.oldestCaseCreatedAt} but the fingerprint recorded ${recorded.oldestCaseCreatedAt} — this is not the database the last fingerprint was taken from`,
    });
  }

  const floors = retainedFloors(recorded, expected.minimumRetainedFraction);

  // One rule per irreplaceable record set, and the finding names the one
  // that collapsed: a database that kept its cases but arrived without the
  // lab's accounts, practices or media ledger is still the wrong database.
  for (const count of FINGERPRINT_COUNTS) {
    if (
      hasCollapsed(
        observed[count.field],
        recorded[count.field],
        floors[count.field],
      )
    ) {
      findings.push({
        level: "failure",
        code: count.code,
        message: `production holds ${observed[count.field]} ${count.noun}(s), below the floor of ${floors[count.field]} implied by the recorded ${recorded[count.field]} (${formatPercent(expected.minimumRetainedFraction)} of the fingerprint taken on ${recorded.recordedAt})`,
      });
    }
  }

  return findings;
}

function evaluateDevelopment(
  observed: DataFingerprint,
  expected: ExpectedDataFingerprints,
): FingerprintFinding[] {
  const recorded = expected.development;
  if (!recorded) {
    return [
      {
        level: "warning",
        code: "missing-development-fingerprint",
        message: `no development fingerprint is recorded in ${DATA_FINGERPRINT_RELATIVE_PATH}, so the publish preflight cannot recognise a production database seeded from development; record one with \`${RECORD_DEVELOPMENT_FINGERPRINT_COMMAND}\` and commit it`,
      },
    ];
  }
  if (observed.oldestCaseCreatedAt === recorded.oldestCaseCreatedAt) {
    return [];
  }
  return [
    {
      level: "warning",
      code: "stale-development-fingerprint",
      message: `the development oldest case created_at is ${observed.oldestCaseCreatedAt ?? "none"} but the fingerprint recorded ${recorded.oldestCaseCreatedAt ?? "none"} on ${recorded.recordedAt}; re-record it with \`${RECORD_DEVELOPMENT_FINGERPRINT_COMMAND}\` and commit it so the publish preflight keeps recognising a development copy`,
    },
  ];
}

export function retainedFloors(
  recorded: RecordedDataFingerprint,
  minimumRetainedFraction: number,
): DataFingerprintCounts {
  const floors = {} as DataFingerprintCounts;
  for (const count of FINGERPRINT_COUNTS) {
    floors[count.field] = Math.floor(
      recorded[count.field] * minimumRetainedFraction,
    );
  }
  return floors;
}

/**
 * A count has collapsed when it fell under the retained floor, or when it
 * emptied out entirely while the fingerprint recorded rows. The second clause
 * matters for small recorded counts, where the floor rounds down to zero.
 */
function hasCollapsed(
  observed: number,
  recorded: number,
  floor: number,
): boolean {
  if (recorded === 0) return false;
  return observed < floor || observed === 0;
}

function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

export function formatFinding(
  finding: FingerprintFinding,
): string {
  return `${finding.level === "failure" ? "BLOCKED" : "WARNING"} — ${finding.message}`;
}
