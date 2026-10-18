import { pool } from "@workspace/db";
import {
  inspectCaseOrganizationConstraints,
  inspectCaseOrganizationRows,
} from "@workspace/db/case-organization-integrity";

/**
 * Read-only operator report, never an apply command.
 * --ids includes organization IDs only (no patient names or case payloads).
 * Keep that output restricted alongside the recovery evidence.
 */
async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg !== "--ids")) {
    throw new Error("Only --ids is supported. This report cannot apply repairs.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query = (sql: string) => client.query(sql);
    const rows = await inspectCaseOrganizationRows(query);
    const constraints = await inspectCaseOrganizationConstraints(query);
    const report: Record<string, unknown> = {
      observedAt: new Date().toISOString(),
      mode: "read-only; connected DATABASE_URL target",
      rows,
      constraints,
      repairAuthorized: false,
    };
    if (process.argv.includes("--ids")) {
      report.missingOriginalOrganizations = (await client.query(`
        SELECT link.kind, link.organization_id,
          count(*)::int AS affected_cases,
          count(*) FILTER (WHERE c.deleted_at IS NULL)::int AS affected_active
        FROM public.cases c
        CROSS JOIN LATERAL (
          VALUES ('lab', c.lab_organization_id), ('practice', c.provider_organization_id)
        ) AS link(kind, organization_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.organizations o WHERE o.id=link.organization_id
        )
        GROUP BY link.kind, link.organization_id
        ORDER BY link.kind, link.organization_id
      `)).rows;
    }
    await client.query("COMMIT");
    console.info(JSON.stringify(report, null, 2));
    if (rows.affectedTotal > 0 || constraints.some((c) => c.status !== "validated")) {
      process.exitCode = 1;
    }
  } finally {
    // ROLLBACK is harmless after COMMIT, and clears aborted read transactions.
    await client.query("ROLLBACK");
    client.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Case integrity report failed");
  process.exitCode = 1;
}).finally(async () => { await pool.end(); });
