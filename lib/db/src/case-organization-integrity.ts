/**
 * Read-only checks for the two ownership links declared on canonical cases.
 * Row integrity is independent of the catalog: missing/NOT VALID constraints
 * do not prove orphans, and validated flags do not prove intact customer data.
 * Deleted cases remain historical records and are deliberately included.
 */
export type IntegrityQuery = (
  sql: string,
) => Promise<{ rows: unknown[] }>;

export const CASE_ORGANIZATION_ROWS_SQL = `
WITH inspected AS (
  SELECT c.deleted_at,
    NOT EXISTS (
      SELECT 1 FROM public.organizations o WHERE o.id = c.lab_organization_id
    ) AS missing_lab,
    NOT EXISTS (
      SELECT 1 FROM public.organizations o WHERE o.id = c.provider_organization_id
    ) AS missing_practice
  FROM public.cases c
)
SELECT count(*)::text AS total_cases,
  count(*) FILTER (WHERE missing_lab)::text AS missing_lab,
  count(*) FILTER (WHERE missing_practice)::text AS missing_practice,
  count(*) FILTER (WHERE missing_lab OR missing_practice)::text AS affected_total,
  count(*) FILTER (
    WHERE deleted_at IS NULL AND (missing_lab OR missing_practice)
  )::text AS affected_active
FROM inspected
`.trim();

export interface CaseOrganizationRows {
  totalCases: number;
  missingLab: number;
  missingPractice: number;
  affectedTotal: number;
  affectedActive: number;
}

function count(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error(`Invalid case integrity count: ${key}`);
  }
  return Number(value);
}

export async function inspectCaseOrganizationRows(
  query: IntegrityQuery,
): Promise<CaseOrganizationRows> {
  const result = await query(CASE_ORGANIZATION_ROWS_SQL);
  if (result.rows.length !== 1 || !result.rows[0] || typeof result.rows[0] !== "object") {
    throw new Error("Case integrity query did not return exactly one aggregate row");
  }
  const row = result.rows[0] as Record<string, unknown>;
  return {
    totalCases: count(row, "total_cases"),
    missingLab: count(row, "missing_lab"),
    missingPractice: count(row, "missing_practice"),
    affectedTotal: count(row, "affected_total"),
    affectedActive: count(row, "affected_active"),
  };
}

export const CASE_ORGANIZATION_CONSTRAINTS_SQL = `
SELECT c.conname AS name, c.convalidated AS validated,
  ARRAY(
    SELECT a.attname::text
    FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    ORDER BY k.position
  ) AS columns,
  target_namespace.nspname AS target_schema,
  target_table.relname AS target_table,
  ARRAY(
    SELECT a.attname::text
    FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, position)
    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
    ORDER BY k.position
  ) AS target_columns,
  c.confdeltype::text AS delete_action,
  c.confupdtype::text AS update_action,
  c.condeferrable AS deferrable
FROM pg_constraint c
JOIN pg_class source_table ON source_table.oid = c.conrelid
JOIN pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
JOIN pg_class target_table ON target_table.oid = c.confrelid
JOIN pg_namespace target_namespace ON target_namespace.oid = target_table.relnamespace
WHERE c.contype = 'f'
  AND source_namespace.nspname = 'public'
  AND source_table.relname = 'cases'
ORDER BY c.conname
`.trim();

export interface CaseOrganizationConstraint {
  name: string;
  validated: boolean;
  columns: string[];
  target_schema: string;
  target_table: string;
  target_columns: string[];
  delete_action: string;
  update_action: string;
  deferrable: boolean;
}

export interface CaseOrganizationConstraintFinding {
  column: "lab_organization_id" | "provider_organization_id";
  status: "missing" | "wrong_definition" | "not_validated" | "validated";
  constraintNames: string[];
}

export function assessCaseOrganizationConstraints(
  constraints: CaseOrganizationConstraint[],
): CaseOrganizationConstraintFinding[] {
  return (["lab_organization_id", "provider_organization_id"] as const).map((column) => {
    const onColumn = constraints.filter((c) => c.columns.includes(column));
    const intended = onColumn.filter(
      (c) =>
        c.columns.length === 1 &&
        c.target_schema === "public" &&
        c.target_table === "organizations" &&
        c.target_columns.length === 1 &&
        c.target_columns[0] === "id" &&
        c.delete_action === "r" &&
        c.update_action === "a" &&
        !c.deferrable,
    );
    return {
      column,
      status: intended.some((c) => c.validated)
        ? "validated"
        : intended.length > 0
          ? "not_validated"
          : onColumn.length > 0
            ? "wrong_definition"
            : "missing",
      constraintNames: onColumn.map((c) => c.name),
    };
  });
}

export async function inspectCaseOrganizationConstraints(
  query: IntegrityQuery,
): Promise<CaseOrganizationConstraintFinding[]> {
  const result = await query(CASE_ORGANIZATION_CONSTRAINTS_SQL);
  for (const value of result.rows) {
    if (!value || typeof value !== "object") throw new Error("Invalid case FK catalog row");
    const row = value as Record<string, unknown>;
    if (
      typeof row.name !== "string" ||
      typeof row.validated !== "boolean" ||
      typeof row.deferrable !== "boolean" ||
      !Array.isArray(row.columns) || !row.columns.every((v) => typeof v === "string") ||
      !Array.isArray(row.target_columns) || !row.target_columns.every((v) => typeof v === "string") ||
      ["target_schema", "target_table", "delete_action", "update_action"].some(
        (key) => typeof row[key] !== "string",
      )
    ) {
      throw new Error("Invalid case FK catalog row");
    }
  }
  return assessCaseOrganizationConstraints(result.rows as CaseOrganizationConstraint[]);
}

export function describeCaseOrganizationRows(rows: CaseOrganizationRows): string {
  return `cases organization row integrity: ${rows.affectedTotal} affected of ${rows.totalCases} total (${rows.affectedActive} active, ${rows.affectedTotal - rows.affectedActive} deleted/historical); missing lab=${rows.missingLab}, missing practice=${rows.missingPractice}`;
}
