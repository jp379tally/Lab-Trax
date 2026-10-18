import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findMissingPracticeAuthorizationSchemaObjects,
  PRACTICE_AUTHORIZATION_SCHEMA_OBJECTS,
} from "./practice-authorization-schema-contract";
import { INFORMATION_SCHEMA_COLUMNS_SQL } from "./schema-column-drift";
import { SCHEMA_OBJECTS_SQL } from "./schema-object-drift";

describe("practice authorization schema contract", () => {
  it("runs the schema check before API tests in the checked-in CI workflow", () => {
    const ciWorkflow = readFileSync(
      resolve(import.meta.dirname, "../../.github/workflows/ci.yml"),
      "utf8",
    );
    const apiTestsJob =
      ciWorkflow.match(/test-api-server-no-db:[\s\S]*?(?=\n  [\w-]+:|$)/)?.[0] ??
      "";

    expect(apiTestsJob).toContain("check-practice-authorization-schema");
    expect(apiTestsJob).toContain("pnpm --filter @workspace/api-server exec vitest run");

    const schemaCheckPosition = apiTestsJob.indexOf(
      "check-practice-authorization-schema",
    );
    const testsPosition = apiTestsJob.indexOf(
      "@workspace/api-server exec vitest run",
    );
    expect(schemaCheckPosition).toBeGreaterThanOrEqual(0);
    expect(testsPosition).toBeGreaterThan(schemaCheckPosition);
  });

  it("runs before API tests", () => {
    const apiPackage = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../artifacts/api-server/package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };

    expect(apiPackage.scripts.pretest).toBe(
      "pnpm --filter @workspace/scripts run check-practice-authorization-schema",
    );
    expect(apiPackage.scripts.test).toBe("vitest run");
  });

  it("reports a missing supersession column before checking dependent objects", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const missing = await findMissingPracticeAuthorizationSchemaObjects(
      async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [] };
      },
    );

    expect(calls).toEqual([
      { sql: INFORMATION_SCHEMA_COLUMNS_SQL, values: [["public"]] },
    ]);
    expect(missing).toEqual([
      PRACTICE_AUTHORIZATION_SCHEMA_OBJECTS.supersedesColumn,
    ]);
  });

  it("uses a read-only catalog query and reports the complete contract", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];

    const missing = await findMissingPracticeAuthorizationSchemaObjects(
      async (sql, values) => {
        calls.push({ sql, values });
        if (sql === INFORMATION_SCHEMA_COLUMNS_SQL) {
          return {
            rows: [{
              table_schema: "public",
              table_name: "practice_authorization_documents",
              column_name: "supersedes_document_id",
            }],
          };
        }
        return { rows: [] };
      },
    );

    expect(calls).toEqual([
      { sql: INFORMATION_SCHEMA_COLUMNS_SQL, values: [["public"]] },
      { sql: SCHEMA_OBJECTS_SQL, values: [["public"]] },
    ]);
    expect(SCHEMA_OBJECTS_SQL).toMatch(/^select\b/i);
    expect(SCHEMA_OBJECTS_SQL).not.toMatch(
      /\b(insert|update|delete|alter|drop|create|truncate)\b/i,
    );
    expect(missing).toEqual([
      PRACTICE_AUTHORIZATION_SCHEMA_OBJECTS.supersedesUniqueIndex,
      PRACTICE_AUTHORIZATION_SCHEMA_OBJECTS.immutabilityTrigger,
    ]);
  });
});
