import {
  ENFORCED_OWNING_ORGANIZATION_COLUMNS,
  OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER,
} from "@workspace/db/schema";

export type RequiredSchemaObject =
  | {
      kind: "index";
      schema: string;
      name: string;
    }
  | {
      kind: "trigger";
      schema: string;
      tableName: string;
      name: string;
    };

export const REQUIRED_MIGRATION_SCHEMA_OBJECTS: RequiredSchemaObject[] = [
  { kind: "index", schema: "public", name: "backup_runs_download_run_id_key" },
  { kind: "index", schema: "public", name: "case_attachments_submission_unique" },
  { kind: "index", schema: "public", name: "case_attachments_legacy_submission_unique" },
  {
    kind: "index",
    schema: "public",
    name: "practice_auth_docs_supersedes_unique",
  },
  {
    kind: "trigger",
    schema: "public",
    tableName: "practice_authorization_documents",
    name: "practice_authorization_documents_immutable",
  },
  // The owning-organization guard stands in for the foreign keys these
  // columns never got. Nothing in the Drizzle diff can notice it going
  // missing, so it is registered here instead.
  ...ENFORCED_OWNING_ORGANIZATION_COLUMNS.map(
    ({ table, triggerName }): RequiredSchemaObject => ({
      kind: "trigger",
      schema: "public",
      tableName: table,
      name: triggerName,
    }),
  ),
  // The parent half of that guard: without it the organization can simply be
  // deleted out from under the rows the triggers above protect.
  {
    kind: "trigger",
    schema: "public",
    tableName: "organizations",
    name: OWNING_ORGANIZATION_PARENT_GUARD_TRIGGER,
  },
];

export const SCHEMA_OBJECTS_SQL = `
select
  'index'::text as object_kind,
  index_namespace.nspname as object_schema,
  index_class.relname as object_name,
  null::text as table_name
from pg_class index_class
join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
where index_class.relkind = 'i'
  and index_namespace.nspname = any($1::text[])
union all
select
  'trigger'::text as object_kind,
  table_namespace.nspname as object_schema,
  trigger.tgname as object_name,
  table_class.relname as table_name
from pg_trigger trigger
join pg_class table_class on table_class.oid = trigger.tgrelid
join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
where table_namespace.nspname = any($1::text[])
  and not trigger.tgisinternal
`.trim();

interface SchemaObjectQueryResult {
  rows: unknown[];
}

export type SchemaObjectQuery = (
  sql: string,
  values: unknown[],
) => Promise<SchemaObjectQueryResult>;

export async function findMissingRequiredSchemaObjects(
  query: SchemaObjectQuery,
  required = REQUIRED_MIGRATION_SCHEMA_OBJECTS,
): Promise<RequiredSchemaObject[]> {
  if (required.length === 0) return [];

  const schemas = [...new Set(required.map((object) => object.schema))];
  const result = await query(SCHEMA_OBJECTS_SQL, [schemas]);
  const actualKeys = new Set(
    result.rows.map((rawRow) => {
      const row = rawRow as {
        object_kind: string;
        object_schema: string;
        object_name: string;
        table_name: string | null;
      };
      return row.object_kind === "trigger"
        ? `trigger:${row.object_schema}.${row.table_name}.${row.object_name}`
        : `index:${row.object_schema}.${row.object_name}`;
    }),
  );

  return required
    .filter((object) => !actualKeys.has(schemaObjectKey(object)))
    .sort((a, b) =>
      formatRequiredSchemaObject(a).localeCompare(
        formatRequiredSchemaObject(b),
      ),
    );
}

export function formatRequiredSchemaObject(
  object: RequiredSchemaObject,
): string {
  if (object.kind === "trigger") {
    return `${object.schema}.${object.tableName}.${object.name} (trigger)`;
  }
  return `${object.schema}.${object.name} (index)`;
}

function schemaObjectKey(object: RequiredSchemaObject): string {
  if (object.kind === "trigger") {
    return `trigger:${object.schema}.${object.tableName}.${object.name}`;
  }
  return `index:${object.schema}.${object.name}`;
}