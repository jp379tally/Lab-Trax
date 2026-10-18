/**
 * Stub `@workspace/db` pool: a scripted PostgreSQL target for the publish
 * gate.
 *
 * The scenario arrives as JSON in `PUBLISH_GATE_STUB_DATABASE` and only
 * describes what a real database would answer:
 *
 *   {
 *     "fingerprintRow": { "active_case_count": "1599", ... },  // one probe row
 *     "labExists": false,                                      // optional
 *     "probeError": { "code": "42P01", "message": "..." }      // optional
 *   }
 *
 * Counts are returned as strings because `count(*)` arrives from
 * node-postgres as a bigint string, and the gate has to cope with that.
 *
 * The schema-drift half of the gate is always answered as healthy — it is a
 * separate concern with its own tests, and a stray missing column would set
 * the exit code the data-identity assertions are measuring.
 */

import {
  getDeclaredSchemaColumns,
  INFORMATION_SCHEMA_COLUMNS_SQL,
} from "../../schema-column-drift.ts";
import {
  REQUIRED_MIGRATION_SCHEMA_OBJECTS,
  SCHEMA_OBJECTS_SQL,
} from "../../schema-object-drift.ts";
import {
  DATA_FINGERPRINT_SQL,
  LAB_DATA_FINGERPRINT_SQL,
} from "../../data-fingerprint.ts";
import {
  CASE_ORGANIZATION_ROWS_SQL,
  CASE_ORGANIZATION_CONSTRAINTS_SQL,
} from "@workspace/db/case-organization-integrity";
import {
  PRESERVED_LEGACY_CASES_SQL,
  loadPreservedCaseManifest,
} from "../../preserved-legacy-case-check.ts";

const scenario = JSON.parse(process.env.PUBLISH_GATE_STUB_DATABASE ?? "{}");

/** A `pg` error carries the SQLSTATE the gate classifies on. */
class StubPostgresError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StubPostgresError";
    this.code = code;
  }
}

function declaredColumnRows() {
  return getDeclaredSchemaColumns().map((column) => ({
    table_schema: column.tableSchema,
    table_name: column.tableName,
    column_name: column.columnName,
  }));
}

function requiredSchemaObjectRows() {
  return REQUIRED_MIGRATION_SCHEMA_OBJECTS.map((object) =>
    object.kind === "trigger"
      ? {
          object_kind: "trigger",
          object_schema: object.schema,
          object_name: object.name,
          table_name: object.tableName,
        }
      : {
          object_kind: "index",
          object_schema: object.schema,
          object_name: object.name,
          table_name: null,
        },
  );
}

function fingerprintRows(labScoped) {
  if (scenario.probeError) {
    throw new StubPostgresError(
      scenario.probeError.code,
      scenario.probeError.message ?? "stub database probe failure",
    );
  }
  const row = { ...(scenario.fingerprintRow ?? {}) };
  if (labScoped) {
    row.lab_exists = scenario.labExists !== false;
  }
  return [row];
}

async function query(sql, values) {
  if (sql === PRESERVED_LEGACY_CASES_SQL) {
    const manifest = loadPreservedCaseManifest();
    if (!Array.isArray(values) || values.length !== 2 ||
        JSON.stringify(values[1]) !== JSON.stringify(manifest.columns) ||
        JSON.stringify(JSON.parse(values[0])) !== JSON.stringify(
          manifest.cases.map(({ id, rowHash }) => ({ id, row_hash: rowHash })),
        )) {
      throw new Error("stub database: preserved-case probe must receive the committed manifest");
    }
    return { rows: [{
      expected_count: String(manifest.cases.length),
      present_count: String(manifest.cases.length),
      matching_count: String(manifest.cases.length),
      unexpected_count: "0",
      ...(scenario.preservedCaseRows ?? {}),
    }] };
  }
  if (sql === CASE_ORGANIZATION_ROWS_SQL || sql === CASE_ORGANIZATION_CONSTRAINTS_SQL) {
    if (scenario.caseProbeError) {
      throw new StubPostgresError(
        scenario.caseProbeError.code,
        scenario.caseProbeError.message ?? "stub case integrity probe failure",
      );
    }
    if (sql === CASE_ORGANIZATION_ROWS_SQL) {
      return { rows: [{
        total_cases: "10", missing_lab: "0", missing_practice: "0",
        affected_total: "0", affected_active: "0",
        ...(scenario.caseRows ?? {}),
      }] };
    }
    return { rows: scenario.caseConstraints ?? [
      "lab_organization_id", "provider_organization_id",
    ].map((column) => ({
      name: `synthetic_${column}_fk`, validated: true, columns: [column],
      target_schema: "public", target_table: "organizations", target_columns: ["id"],
      delete_action: "r", update_action: "a", deferrable: false,
    })) };
  }
  if (sql === INFORMATION_SCHEMA_COLUMNS_SQL) {
    return { rows: declaredColumnRows() };
  }
  if (sql === SCHEMA_OBJECTS_SQL) {
    return { rows: requiredSchemaObjectRows() };
  }
  if (sql === DATA_FINGERPRINT_SQL) {
    return { rows: fingerprintRows(false) };
  }
  if (sql === LAB_DATA_FINGERPRINT_SQL) {
    if (!Array.isArray(values) || values.length !== 1) {
      throw new Error(
        "stub database: the protected-lab probe must be given exactly one lab id",
      );
    }
    return { rows: fingerprintRows(true) };
  }
  throw new Error(
    `stub database received an unexpected query:\n${sql}`,
  );
}

export const pool = {
  query,
  end: async () => {},
};
