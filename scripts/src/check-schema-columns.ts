import { pool } from "@workspace/db";
import { checkCaseOrganizationDrift } from "./case-organization-drift";
import { checkPreservedLegacyCases } from "./preserved-legacy-case-check";
import {
  checkDeclaredSchemaColumns,
  formatSchemaColumn,
  getDeclaredSchemaColumns,
} from "./schema-column-drift";
import {
  findMissingRequiredSchemaObjects,
  formatRequiredSchemaObject,
  REQUIRED_MIGRATION_SCHEMA_OBJECTS,
} from "./schema-object-drift";
import {
  DATA_FINGERPRINT_RELATIVE_PATH,
  type DataIdentityVerdict,
  type FingerprintTarget,
  formatFinding,
  loadExpectedDataFingerprints,
  RECORD_DEVELOPMENT_FINGERPRINT_COMMAND,
  RECORD_PRODUCTION_FINGERPRINT_COMMAND,
  resolveDataIdentity,
  summarizeDataFingerprint,
} from "./data-fingerprint";

// The connection target is selected by DATABASE_URL. Replit binds that URL
// to development in post-merge and to production in deployment builds.
// This value only makes the environment explicit in operator-facing output,
// and selects how strictly the data fingerprint is enforced.
function resolveTarget(): FingerprintTarget {
  return process.env.SCHEMA_COLUMN_CHECK_TARGET?.trim() === "production"
    ? "production"
    : "development";
}

/**
 * Schema drift: does the connected database carry every column and
 * migration-owned object the code expects? Advisory during a deployment
 * build, because Publish applies the reviewed schema diff after this stage.
 */
async function checkSchemaDrift(
  target: FingerprintTarget,
  allowMissing: boolean,
): Promise<void> {
  const declared = getDeclaredSchemaColumns();
  const missing = await checkDeclaredSchemaColumns(
    (sql, values) => pool.query(sql, values),
    declared,
  );

  if (missing.length > 0) {
    const log = allowMissing ? console.warn : console.error;
    log(
      `schema-column-check (${target}): database is missing ${missing.length} column(s) declared by Drizzle:`,
    );
    for (const column of missing) {
      log(`  - ${formatSchemaColumn(column)}`);
    }
    if (allowMissing) {
      console.warn(
        "schema-column-check: continuing because Replit Publish owns applying the reviewed development-to-production schema diff before promotion",
      );
      return;
    }
    process.exitCode = 1;
    return;
  }

  const missingObjects = await findMissingRequiredSchemaObjects(
    (sql, values) => pool.query(sql, values),
  );
  if (missingObjects.length > 0) {
    const log = allowMissing ? console.warn : console.error;
    log(
      `schema-column-check (${target}): database is missing ${missingObjects.length} required migration-owned schema object(s):`,
    );
    for (const object of missingObjects) {
      log(`  - ${formatRequiredSchemaObject(object)}`);
    }
    if (allowMissing) {
      console.warn(
        "schema-column-check: continuing because Replit Publish owns applying the reviewed development-to-production schema diff before promotion",
      );
      return;
    }
    process.exitCode = 1;
    return;
  }

  console.info(
    `schema-column-check (${target}): verified ${declared.length} declared columns and ${REQUIRED_MIGRATION_SCHEMA_OBJECTS.length} required migration-owned schema objects`,
  );
}

/**
 * Data identity: is this still the database the lab's data lives in?
 *
 * A deployment bound to a different production database comes up healthy —
 * the app starts and login works — so only lineage catches it. Unlike schema
 * drift, a production mismatch here is blocking: Publish cannot repair a
 * database that is not the lab's, and continuing would promote the swap.
 */
async function checkDataIdentity(target: FingerprintTarget): Promise<void> {
  const label = `data-fingerprint (${target})`;

  let expected;
  try {
    expected = loadExpectedDataFingerprints();
  } catch (error) {
    const blocking = target === "production";
    (blocking ? console.error : console.warn)(
      `${label}: unable to read ${DATA_FINGERPRINT_RELATIVE_PATH}`,
      error,
    );
    if (blocking) process.exitCode = 1;
    return;
  }

  // A database whose shape stops the probe still gets a verdict: for
  // production with a recorded fingerprint, a database without the lab's
  // tables is not the database that fingerprint was taken from, and blocks.
  let verdict: DataIdentityVerdict;
  try {
    verdict = await resolveDataIdentity({
      target,
      expected,
      query: (sql, values) => pool.query(sql, values),
    });
  } catch (error) {
    console.error(
      `${label}: unable to read the database identity fingerprint`,
      error,
    );
    process.exitCode = 1;
    return;
  }
  const { observed, findings } = verdict;

  if (observed) {
    for (const line of summarizeDataFingerprint({
      target,
      observed,
      expected,
    })) {
      console.info(`${label}: ${line}`);
    }
  } else {
    console.info(
      `${label}: the lab's record counts and oldest case created_at could not be read from this database`,
    );
  }

  const failures = findings.filter((finding) => finding.level === "failure");

  for (const finding of findings) {
    (finding.level === "failure" ? console.error : console.warn)(
      `${label}: ${formatFinding(finding)}`,
    );
  }

  if (failures.length > 0) {
    console.error(
      `${label}: refusing to continue — the ${target} database no longer matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}. If this change is legitimate, re-record it with \`${
        target === "production"
          ? RECORD_PRODUCTION_FINGERPRINT_COMMAND
          : RECORD_DEVELOPMENT_FINGERPRINT_COMMAND
      }\` and commit the result.`,
    );
    process.exitCode = 1;
    return;
  }

  if (findings.length === 0) {
    console.info(
      `${label}: matches the fingerprint committed in ${DATA_FINGERPRINT_RELATIVE_PATH}`,
    );
  }
}

async function main(): Promise<void> {
  const target = resolveTarget();
  const allowMissing =
    process.env.SCHEMA_COLUMN_CHECK_ALLOW_MISSING?.trim() === "1";

  await checkSchemaDrift(target, allowMissing);
  // Run independently of column/catalog drift: convalidated is not a row
  // integrity assertion, and Publish cannot recover missing organizations.
  // Production may preserve only the exact committed archival cohort.
  // Development is an advisory preservation report: post-merge setup must
  // still reconcile workflows while existing damaged rows await authorization.
  const blockCaseIntegrity = target === "production";
  try {
    const caseDrift = await checkCaseOrganizationDrift(
      (sql) => pool.query(sql),
      allowMissing,
    );
    if (blockCaseIntegrity && allowMissing) {
      // Verify the cohort even when ownership is now intact: disappearance or
      // an unapproved change must not evade the preservation check.
      const preserved = await checkPreservedLegacyCases(
        (sql, values) => pool.query(sql, values),
      );
      console.info(`schema-column-check (${target}): ${preserved.summary}`);
      if (preserved.blocking) {
        caseDrift.errors.push(...preserved.errors);
        caseDrift.blocking = true;
      } else if (caseDrift.blocking) {
        caseDrift.warnings.push(
          "publishing-only legacy exception: unchanged archived ownership findings remain preserved; normal ownership checks and the production identity guard are unchanged",
        );
        // Waive only the existing row-ownership finding. Any other present
        // or future integrity error must remain blocking.
        caseDrift.errors = caseDrift.errors.filter(
          (error) => !error.startsWith(`${caseDrift.summary}. Preserve these records;`),
        );
        caseDrift.blocking = caseDrift.errors.length > 0;
      }
    }
    console.info(`schema-column-check (${target}): ${caseDrift.summary}`);
    for (const warning of caseDrift.warnings) console.warn(warning);
    for (const error of caseDrift.errors) {
      (blockCaseIntegrity ? console.error : console.warn)(
        `schema-column-check (${target}): ${error}`,
      );
    }
    if (caseDrift.blocking && blockCaseIntegrity) process.exitCode = 1;
    if (caseDrift.blocking && !blockCaseIntegrity) {
      console.warn("schema-column-check (development): case ownership findings are advisory during setup; records remain preserved pending owner-authorized repair");
    }
  } catch (error) {
    // A truly empty first deployment needs Publish to create its tables.
    // Never confuse that bootstrap with an established lab's missing data.
    const missingTable = error !== null && typeof error === "object" &&
      "code" in error && (error.code === "42P01" || error.code === "3F000");
    const bootstrap = blockCaseIntegrity && allowMissing && missingTable &&
      loadExpectedDataFingerprints().production === null;
    (blockCaseIntegrity && !bootstrap ? console.error : console.warn)(
      `schema-column-check (${target}): case ownership integrity could not be verified${bootstrap ? " before first-deployment schema creation" : ""}`,
      error,
    );
    if (blockCaseIntegrity && !bootstrap) process.exitCode = 1;
  }
  // Always runs, including after reported schema drift: a swapped database is
  // the more serious finding and must never be hidden behind a missing column.
  await checkDataIdentity(target);
}

main()
  .catch((error) => {
    const target = resolveTarget();
    console.error(
      `schema-column-check (${target}): unable to inspect the database`,
      error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
