#!/usr/bin/env tsx
/**
 * One-off report: which rows name an owning organization that does not exist?
 *
 * `cases`, `invoices`, `doctor_profiles` and `lab_memberships` are now guarded
 * by a row trigger (see lib/db/src/schema/owning-organizations.ts), so no *new*
 * row can be written against a lab that was never there. Rows that were
 * already orphaned when the guard went in are deliberately left alone — the
 * guard mirrors a NOT VALID foreign key and lets them be edited and repaired.
 * This report is how they get found.
 *
 * It also covers the two legacy columns (`lab_cases.organization_id` and
 * `legacy_case_media.organization_id`) that are reported but NOT enforced, so
 * their orphans are visible even though no trigger stops them.
 *
 * Read-only: every statement is a SELECT, which is what makes it safe to point
 * at production.
 *
 * By default it prints per-column counts and nothing else. The row-level CSV
 * is opt-in (`--csv`) and is written outside the repository, because against
 * production it is a list of the lab's live records and belongs in restricted
 * storage rather than in source history — the same rule .gitignore already
 * applies to database dumps. It carries record identifiers only: no patient
 * details and no personal names.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run report-orphaned-owning-organizations
 *   pnpm --filter @workspace/scripts run report-orphaned-owning-organizations:production
 *
 *   --csv          also write the row-level CSV (outside the repository)
 *   --out=<path>   write that CSV to a specific path instead
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ALL_OWNING_ORGANIZATION_COLUMNS,
  buildOwningOrganizationOrphanRowsSql,
  buildOwningOrganizationOrphanSummarySql,
  formatOwningOrganizationColumn,
  OWNING_ORGANIZATION_TABLE_EXISTS_SQL,
  pool,
} from "@workspace/db";
import {
  buildOrphanCsv,
  countOrphans,
  parseOrphanRow,
  parseOrphanSummaryRow,
  selectExistingColumns,
  summarizeOrphanReport,
  type OrphanRow,
  type OrphanSummary,
} from "./owning-organization-orphan-report";

/**
 * Outside the repository on purpose. Against production this CSV lists the
 * lab's live records, so it must not land anywhere that could be committed.
 */
const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "owning-organization-orphans");

function resolveTarget(): string {
  return process.env["OWNING_ORG_REPORT_TARGET"]?.trim() === "production"
    ? "production"
    : "development";
}

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const target = resolveTarget();
  const label = `owning-organization-orphans (${target})`;

  const tableNames = ALL_OWNING_ORGANIZATION_COLUMNS.map(
    (entry) => entry.table,
  );
  const existing = await pool.query(OWNING_ORGANIZATION_TABLE_EXISTS_SQL, [
    [...new Set(tableNames)],
  ]);
  const columns = selectExistingColumns(
    existing.rows.map((row) => (row as { table_name: string }).table_name),
  );

  const skipped = ALL_OWNING_ORGANIZATION_COLUMNS.filter(
    (entry) => !columns.includes(entry),
  );
  for (const entry of skipped) {
    console.warn(
      `${label}: skipping ${formatOwningOrganizationColumn(entry)} — table not present in this database`,
    );
  }
  if (columns.length === 0) {
    console.error(`${label}: none of the owning-organization tables exist`);
    process.exitCode = 1;
    return;
  }

  const summaryResult = await pool.query(
    buildOwningOrganizationOrphanSummarySql(columns),
  );
  const summaries: OrphanSummary[] = summaryResult.rows.map(
    parseOrphanSummaryRow,
  );

  for (const line of summarizeOrphanReport(summaries)) {
    console.info(`${label}: ${line}`);
  }

  const totals = countOrphans(summaries);
  console.info(
    `${label}: ${totals.enforced} row(s) on guarded columns and ${totals.reportedOnly} row(s) on reported-only legacy columns would violate the guard today`,
  );
  if (totals.enforced > 0) {
    console.info(
      `${label}: the guard allows these rows to be edited and repaired — it only blocks moving a row to an organization that does not exist`,
    );
  }

  const outFlag = readFlag("out");
  if (!outFlag && !process.argv.includes("--csv")) {
    console.info(
      `${label}: pass --csv to also list the offending rows (written outside the repository; keep it in restricted storage)`,
    );
    return;
  }

  const rows: OrphanRow[] = [];
  for (const entry of columns) {
    const summary = summaries.find(
      (candidate) =>
        candidate.table === entry.table && candidate.column === entry.column,
    );
    if (!summary || summary.orphanRows === 0) continue;
    const result = await pool.query(
      buildOwningOrganizationOrphanRowsSql(entry),
    );
    for (const raw of result.rows) rows.push(parseOrphanRow(entry, raw));
  }

  if (rows.length === 0) {
    console.info(`${label}: no offending rows — nothing to write`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.resolve(
    outFlag ?? path.join(DEFAULT_OUT_DIR, `${target}-${stamp}.csv`),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildOrphanCsv(rows), "utf8");
  fs.chmodSync(outPath, 0o600);
  console.info(`${label}: wrote ${rows.length} offending row(s) to ${outPath}`);
  console.info(
    `${label}: that file lists real records — move it to restricted storage and do not commit it`,
  );
}

main()
  .catch((error) => {
    console.error(
      `owning-organization-orphans (${resolveTarget()}): unable to inspect the database`,
      error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
