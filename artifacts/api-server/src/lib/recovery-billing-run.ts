import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, systemSettings } from "@workspace/db";
import { z } from "zod";
import { HttpError } from "./http";
import {
  assertRecoveryDataAvailable, RECOVERY_LAB_ID, RECOVERY_SAFEGUARD_VERSION,
  RECOVERY_TAG, RECOVERY_TIMEZONE,
} from "./recovery-billing-scope";

export { RECOVERY_SAFEGUARD_VERSION };
export const RECOVERY_RUN_KEY = `billing_recovery_run:${RECOVERY_LAB_ID}`;
export const recoveryRunSchema = z.object({
  version: z.literal(RECOVERY_SAFEGUARD_VERSION),
  labOrganizationId: z.literal(RECOVERY_LAB_ID),
  timezone: z.literal(RECOVERY_TIMEZONE),
  cutoff: z.string().datetime(),
  expiresAt: z.string().datetime(),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupTakenAt: z.string().datetime(),
  rehearsalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  databaseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRecoveryCheckedAt: z.string().datetime(),
  proposals: z.record(z.string(), z.string()),
  proposalFingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targetMode: z.enum(["production", "rehearsal"]),
  approvalNonce: z.string().uuid(),
}).strict();

type Executor = Pick<typeof db, "query" | "execute">;

export function recoveryApprovalDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function recoveryApprovedDigest() {
  assertRecoveryDataAvailable();
  const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, RECOVERY_RUN_KEY) });
  return row?.value ? recoveryApprovalDigest(row.value) : null;
}

/** No customer fields or connection credentials enter this identity digest. */
export async function recoveryDatabaseIdentity(executor: Pick<typeof db, "execute"> = db) {
  assertRecoveryDataAvailable();
  const result = await executor.execute(sql`
    SELECT o.id, to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS organization_created,
      c.id AS anchor_case, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS anchor_created
    FROM organizations o
    LEFT JOIN LATERAL (
      SELECT id, created_at FROM cases
      WHERE lab_organization_id = o.id AND ai_import_source IS DISTINCT FROM ${RECOVERY_TAG}
      ORDER BY created_at, id LIMIT 1
    ) c ON true WHERE o.id = ${RECOVERY_LAB_ID}
  `);
  if (result.rows.length !== 1) throw new HttpError(409, "Expected recovery lab identity is absent.");
  return createHash("sha256").update(JSON.stringify(result.rows[0])).digest("hex");
}

export function validateRecoveryApproval(value: unknown, caseId: string, proposalId: string, now = Date.now()) {
  const result = recoveryRunSchema.safeParse(value);
  if (!result.success) throw new HttpError(409, "Recovery run approval is invalid.");
  const run = result.data;
  const expires = Date.parse(run.expiresAt);
  const fresh = (date: string) => Date.parse(date) <= now && now - Date.parse(date) <= 2 * 60 * 60 * 1000;
  if (expires <= now || expires - now > 2 * 60 * 60 * 1000 ||
      !fresh(run.backupTakenAt) || !fresh(run.sourceRecoveryCheckedAt) || !fresh(run.cutoff) ||
      run.proposals[caseId] !== proposalId) {
    throw new HttpError(409, "This exact proposal lacks a fresh, unexpired recovery approval.");
  }
  return run;
}

export async function requireApprovedRecoveryRun(caseId: string, proposalId: string, proposalFingerprint: string, executor: Executor = db) {
  assertRecoveryDataAvailable();
  // The applying transaction holds this read lock until its writes commit.
  // Revocation cannot race an in-flight case halfway through application.
  await executor.execute(sql`SELECT key FROM system_settings WHERE key = ${RECOVERY_RUN_KEY} FOR SHARE`);
  const stored = await executor.query.systemSettings.findFirst({ where: eq(systemSettings.key, RECOVERY_RUN_KEY) });
  if (!stored?.value) throw new HttpError(409,
    "Application is disabled until a fresh verified backup, isolated rehearsal, published safeguards and source-recovery check authorize this exact proposal.");
  let parsed: unknown;
  try { parsed = JSON.parse(stored.value); } catch { throw new HttpError(409, "Recovery run approval is invalid."); }
  const run = validateRecoveryApproval(parsed, caseId, proposalId);
  if (run.proposalFingerprints[caseId] !== proposalFingerprint) {
    throw new HttpError(409, "Saved proposal no longer matches the rehearsed approval.");
  }
  if (run.databaseFingerprint !== await recoveryDatabaseIdentity(executor)) {
    throw new HttpError(409, "Recovery database identity changed; approval cannot be used here.");
  }
  const database = await executor.execute(sql`SELECT current_database() AS name`);
  const isClone = database.rows[0]?.name === "labtrax_recovery_billing_rehearsal";
  if (isClone !== (run.targetMode === "rehearsal")) {
    throw new HttpError(409, "Rehearsal approval cannot authorize production writes.");
  }
  return run;
}
