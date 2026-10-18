import { describe, expect, it } from "vitest";
import {
  checkDeclaredSchemaColumns,
  findMissingSchemaColumns,
  formatSchemaColumn,
  getDeclaredSchemaColumns,
  INFORMATION_SCHEMA_COLUMNS_SQL,
} from "./schema-column-drift";
import {
  findMissingRequiredSchemaObjects,
  formatRequiredSchemaObject,
  SCHEMA_OBJECTS_SQL,
} from "./schema-object-drift";

describe("schema column drift guard", () => {
  it("discovers Drizzle table and physical column names", () => {
    const declared = getDeclaredSchemaColumns();

    expect(declared).toContainEqual({
      tableSchema: "public",
      tableName: "users",
      columnName: "email_verified_at",
    });
    expect(declared).toContainEqual({
      tableSchema: "public",
      tableName: "cases",
      columnName: "lab_location_id",
    });
  });

  it("reports every exact missing table/column path in stable order", () => {
    const declared = [
      { tableSchema: "public", tableName: "users", columnName: "id" },
      { tableSchema: "public", tableName: "cases", columnName: "due_time" },
      { tableSchema: "public", tableName: "cases", columnName: "id" },
    ];
    const actual = [
      { tableSchema: "public", tableName: "users", columnName: "id" },
    ];

    expect(
      findMissingSchemaColumns(declared, actual).map(formatSchemaColumn),
    ).toEqual(["public.cases.due_time", "public.cases.id"]);
  });

  it("uses one read-only metadata query and returns complete drift output", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const declared = [
      { tableSchema: "public", tableName: "users", columnName: "id" },
      { tableSchema: "public", tableName: "users", columnName: "new_setting" },
      { tableSchema: "public", tableName: "cases", columnName: "new_flag" },
    ];

    const missing = await checkDeclaredSchemaColumns(async (sql, values) => {
      calls.push({ sql, values });
      return {
        rows: [
          {
            table_schema: "public",
            table_name: "users",
            column_name: "id",
          },
        ],
      };
    }, declared);

    expect(calls).toEqual([
      {
        sql: INFORMATION_SCHEMA_COLUMNS_SQL,
        values: [["public"]],
      },
    ]);
    expect(INFORMATION_SCHEMA_COLUMNS_SQL).toMatch(/^select\b/i);
    expect(INFORMATION_SCHEMA_COLUMNS_SQL).not.toMatch(
      /\b(insert|update|delete|alter|drop|create|truncate)\b/i,
    );
    expect(missing.map(formatSchemaColumn)).toEqual([
      "public.cases.new_flag",
      "public.users.new_setting",
    ]);
  });

  it("reports exact missing index and trigger names using a read-only query", async () => {
    const required = [
      { kind: "index" as const, schema: "public", name: "required_idx" },
      {
        kind: "trigger" as const,
        schema: "audit",
        tableName: "events",
        name: "events_immutable",
      },
    ];

    const missing = await findMissingRequiredSchemaObjects(
      async (sql, values) => {
        expect(sql).toBe(SCHEMA_OBJECTS_SQL);
        expect(values).toEqual([["public", "audit"]]);
        return { rows: [] };
      },
      required,
    );

    expect(SCHEMA_OBJECTS_SQL).toMatch(/^select\b/i);
    expect(SCHEMA_OBJECTS_SQL).not.toMatch(
      /\b(insert|update|delete|alter|drop|create|truncate)\b/i,
    );
    expect(missing.map(formatRequiredSchemaObject)).toEqual([
      "audit.events.events_immutable (trigger)",
      "public.required_idx (index)",
    ]);
  });
});