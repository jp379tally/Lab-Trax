/**
 * Shaping and formatting for the owning-organization orphan report.
 *
 * Kept separate from the CLI so the row/CSV/summary handling can be tested
 * without a database.
 */
import {
  ALL_OWNING_ORGANIZATION_COLUMNS,
  ENFORCED_OWNING_ORGANIZATION_COLUMNS,
  formatOwningOrganizationColumn,
  REPORTED_OWNING_ORGANIZATION_COLUMNS,
  type OwningOrganizationColumn,
} from "@workspace/db/schema";

export interface OrphanSummary {
  table: string;
  column: string;
  totalRows: number;
  orphanRows: number;
  phantomOrganizations: number;
  /** Whether the guard trigger blocks new rows like these. */
  enforced: boolean;
}

export interface OrphanRow {
  table: string;
  column: string;
  rowId: string;
  organizationId: string;
  identity: Record<string, string | null>;
}

export function isEnforcedOwningOrganizationColumn(
  table: string,
  column: string,
): boolean {
  return ENFORCED_OWNING_ORGANIZATION_COLUMNS.some(
    (entry) => entry.table === table && entry.column === column,
  );
}

export function describeUnenforcedReason(
  table: string,
  column: string,
): string | undefined {
  return REPORTED_OWNING_ORGANIZATION_COLUMNS.find(
    (entry) => entry.table === table && entry.column === column,
  )?.unenforcedReason;
}

function toCount(value: unknown): number {
  // pg returns bigint aggregates as strings.
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseOrphanSummaryRow(raw: unknown): OrphanSummary {
  const row = raw as {
    table_name: string;
    column_name: string;
    total_rows: unknown;
    orphan_rows: unknown;
    phantom_organizations: unknown;
  };
  return {
    table: row.table_name,
    column: row.column_name,
    totalRows: toCount(row.total_rows),
    orphanRows: toCount(row.orphan_rows),
    phantomOrganizations: toCount(row.phantom_organizations),
    enforced: isEnforcedOwningOrganizationColumn(
      row.table_name,
      row.column_name,
    ),
  };
}

export function parseOrphanRow(
  entry: OwningOrganizationColumn,
  raw: unknown,
): OrphanRow {
  const row = raw as {
    row_id: string | null;
    organization_id: string;
    identity: Record<string, string | null> | null;
  };
  return {
    table: entry.table,
    column: entry.column,
    rowId: row.row_id ?? "",
    organizationId: row.organization_id,
    identity: row.identity ?? {},
  };
}

/** Operator-facing summary lines, enforced columns first. */
export function summarizeOrphanReport(
  summaries: readonly OrphanSummary[],
): string[] {
  const ordered = [...summaries].sort((a, b) => {
    if (a.enforced !== b.enforced) return a.enforced ? -1 : 1;
    return formatOwningOrganizationColumn(a).localeCompare(
      formatOwningOrganizationColumn(b),
    );
  });

  const lines: string[] = [];
  for (const summary of ordered) {
    const name = formatOwningOrganizationColumn(summary);
    const status = summary.enforced ? "enforced" : "reported only";
    lines.push(
      `${name} (${status}): ${summary.orphanRows} of ${summary.totalRows} row(s) name ${summary.phantomOrganizations} organization(s) that do not exist`,
    );
    if (!summary.enforced && summary.orphanRows > 0) {
      const reason = describeUnenforcedReason(summary.table, summary.column);
      if (reason) lines.push(`    left unenforced because ${reason}`);
    }
  }
  return lines;
}

export function countOrphans(summaries: readonly OrphanSummary[]): {
  enforced: number;
  reportedOnly: number;
} {
  return summaries.reduce(
    (totals, summary) => {
      if (summary.enforced) totals.enforced += summary.orphanRows;
      else totals.reportedOnly += summary.orphanRows;
      return totals;
    },
    { enforced: 0, reportedOnly: 0 },
  );
}

const CSV_HEADER = [
  "table",
  "column",
  "row_id",
  "missing_organization_id",
  "enforced",
  "identity",
] as const;

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A CSV of every offending row, for whoever has to repair them. */
export function buildOrphanCsv(rows: readonly OrphanRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.table,
        row.column,
        row.rowId,
        row.organizationId,
        isEnforcedOwningOrganizationColumn(row.table, row.column)
          ? "yes"
          : "no",
        JSON.stringify(row.identity),
      ]
        .map((value) => escapeCsv(value))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Registry entries whose table exists in the connected database. */
export function selectExistingColumns(
  existingTables: readonly string[],
  columns: readonly OwningOrganizationColumn[] = ALL_OWNING_ORGANIZATION_COLUMNS,
): OwningOrganizationColumn[] {
  const present = new Set(existingTables);
  return columns.filter((entry) => present.has(entry.table));
}
