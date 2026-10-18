import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";

export interface SchemaColumn {
  tableSchema: string;
  tableName: string;
  columnName: string;
}

export const INFORMATION_SCHEMA_COLUMNS_SQL = `
select table_schema, table_name, column_name
  from information_schema.columns
 where table_schema = any($1::text[])
`.trim();

interface ColumnQueryResult {
  rows: unknown[];
}

export type ColumnQuery = (
  sql: string,
  values: unknown[],
) => Promise<ColumnQueryResult>;

export function getDeclaredSchemaColumns(): SchemaColumn[] {
  const declared = new Map<string, SchemaColumn>();

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const tableSchema = config.schema ?? "public";
    for (const column of config.columns) {
      const entry = {
        tableSchema,
        tableName: config.name,
        columnName: column.name,
      };
      declared.set(
        `${entry.tableSchema}.${entry.tableName}.${entry.columnName}`,
        entry,
      );
    }
  }

  return [...declared.values()].sort(compareSchemaColumns);
}

export function findMissingSchemaColumns(
  declared: SchemaColumn[],
  actual: SchemaColumn[],
): SchemaColumn[] {
  const actualKeys = new Set(
    actual.map(
      ({ tableSchema, tableName, columnName }) =>
        `${tableSchema}.${tableName}.${columnName}`,
    ),
  );
  return declared
    .filter(
      ({ tableSchema, tableName, columnName }) =>
        !actualKeys.has(`${tableSchema}.${tableName}.${columnName}`),
    )
    .sort(compareSchemaColumns);
}

export async function checkDeclaredSchemaColumns(
  query: ColumnQuery,
  declared = getDeclaredSchemaColumns(),
): Promise<SchemaColumn[]> {
  const schemas = [...new Set(declared.map((column) => column.tableSchema))];
  const result = await query(INFORMATION_SCHEMA_COLUMNS_SQL, [schemas]);
  const actual: SchemaColumn[] = result.rows.map((rawRow) => {
    const row = rawRow as {
      table_schema: string;
      table_name: string;
      column_name: string;
    };
    return {
      tableSchema: row.table_schema,
      tableName: row.table_name,
      columnName: row.column_name,
    };
  });
  return findMissingSchemaColumns(declared, actual);
}

export function formatSchemaColumn({
  tableSchema,
  tableName,
  columnName,
}: SchemaColumn): string {
  return `${tableSchema}.${tableName}.${columnName}`;
}

function compareSchemaColumns(a: SchemaColumn, b: SchemaColumn): number {
  return formatSchemaColumn(a).localeCompare(formatSchemaColumn(b));
}