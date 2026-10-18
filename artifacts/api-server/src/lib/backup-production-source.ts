import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { PoolClient } from "pg";

/** Verify lineage inside the very transaction supplying pg_dump's snapshot. */
export async function verifyProductionBackupSource(client: PoolClient): Promise<string> {
  let bytes: Buffer | undefined;
  for (const candidate of [path.resolve(process.cwd(), "scripts/database-fingerprint.json"),
    path.resolve(process.cwd(), "../../scripts/database-fingerprint.json")]) {
    try { bytes = await readFile(candidate); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!bytes) throw new Error("Complete production capture cannot verify the committed database lineage fingerprint.");
  const expected = JSON.parse(bytes.toString("utf8"));
  const recorded = expected.production;
  if (!recorded?.labOrganizationId || !recorded.oldestCaseCreatedAt ||
      !Number.isSafeInteger(recorded.activeCaseCount) || !(expected.minimumRetainedFraction > 0)) {
    throw new Error("Complete production capture has no valid protected-lab lineage fingerprint.");
  }
  const result = await client.query<{ exists: boolean; cases: string; oldest: string | null }>(`
    SELECT EXISTS(SELECT 1 FROM public.organizations WHERE id = $1) AS exists,
      (SELECT count(*)::text FROM public.cases WHERE lab_organization_id = $1 AND deleted_at IS NULL) AS cases,
      (SELECT to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        FROM public.cases WHERE lab_organization_id = $1) AS oldest
  `, [recorded.labOrganizationId]);
  const observed = result.rows[0];
  if (!observed?.exists || observed.oldest !== recorded.oldestCaseCreatedAt ||
      observed.oldest === expected.development?.oldestCaseCreatedAt ||
      Number(observed.cases) < Math.ceil(recorded.activeCaseCount * expected.minimumRetainedFraction)) {
    throw new Error("Complete production capture failed protected-lab database lineage verification. Confirm the production database identity before retrying.");
  }
  return createHash("sha256").update(bytes).digest("hex");
}
