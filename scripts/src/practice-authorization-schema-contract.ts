import {
  findMissingRequiredSchemaObjects,
  formatRequiredSchemaObject,
  REQUIRED_MIGRATION_SCHEMA_OBJECTS,
  type SchemaObjectQuery,
} from "./schema-object-drift";
import {
  checkDeclaredSchemaColumns,
  formatSchemaColumn,
  type ColumnQuery,
} from "./schema-column-drift";

export const PRACTICE_AUTHORIZATION_SCHEMA_OBJECTS = {
  supersedesColumn:
    "public.practice_authorization_documents.supersedes_document_id",
  supersedesUniqueIndex:
    "public.practice_auth_docs_supersedes_unique (index)",
  immutabilityTrigger:
    "public.practice_authorization_documents.practice_authorization_documents_immutable (trigger)",
} as const;

export type SchemaContractQuery = ColumnQuery & SchemaObjectQuery;

export async function findMissingPracticeAuthorizationSchemaObjects(
  query: SchemaContractQuery,
): Promise<string[]> {
  const missingColumns = await checkDeclaredSchemaColumns(query, [
    {
      tableSchema: "public",
      tableName: "practice_authorization_documents",
      columnName: "supersedes_document_id",
    },
  ]);
  if (missingColumns.length > 0) {
    return missingColumns.map(formatSchemaColumn);
  }

  const requiredObjects = REQUIRED_MIGRATION_SCHEMA_OBJECTS.filter(
    (object) =>
      object.name === "practice_auth_docs_supersedes_unique" ||
      object.name === "practice_authorization_documents_immutable",
  );
  const missingObjects = await findMissingRequiredSchemaObjects(
    query,
    requiredObjects,
  );
  return missingObjects.map(formatRequiredSchemaObject);
}