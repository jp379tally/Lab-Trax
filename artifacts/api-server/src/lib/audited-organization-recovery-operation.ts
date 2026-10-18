import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { organizations, pool } from "@workspace/db";
import type { RecoverAuditedOrganizations200Response } from "@workspace/api-zod";
import type { z } from "zod";
import { HttpError } from "./http";
import {
  AUDITED_ORGANIZATION_RECOVERY_SQL, buildAuditedOrganizationInsert,
  type AuditedOrganizationCandidate,
} from "./organization-audit-recovery";

// Owner-approved, rehearsed cohort. This operation cannot accept substitute
// IDs, snapshots, counts, or an expanded scope from a request.
export const ORGANIZATION_RECOVERY_APPROVAL = {
  digest: "428da4afe2bbe6ad8f648cd424ce2dae",
  count: 24,
  operation: "audited-organization-recovery-2026-10-12",
  confirmation: "RECOVER_THE_24_AUDITED_ORGANIZATIONS",
} as const;

export type OrganizationRecoveryResult = z.infer<typeof RecoverAuditedOrganizations200Response>;

function evidenceDigest(candidates: AuditedOrganizationCandidate[]): string {
  return createHash("md5").update([...candidates].sort((a, b) =>
    a.organization_id < b.organization_id ? -1 : a.organization_id > b.organization_id ? 1 : 0,
  ).map((c) => `${c.organization_id}:${c.audit_id}:${c.snapshot_hash}`).join("|")).digest("hex");
}

export async function runAuditedOrganizationRecovery(
  dryRun: boolean,
  actorId: string | null,
): Promise<OrganizationRecoveryResult> {
  const client = await pool.connect().catch(() => {
    throw new HttpError(503, "Recovery database connection unavailable. No changes attempted.");
  });
  let open = false;
  let discard = false;
  let phase = "transaction setup";
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Avoid JIT compilation in this bounded maintenance lookup. This does not
    // replace verifying its execution budget against a restored archive.
    await client.query("SET LOCAL jit = off");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 0)", [ORGANIZATION_RECOVERY_APPROVAL.operation]);
    // Prevent conflicting organization inserts/edits and parent disappearance.
    // No triggers or constraints are disabled; there are no schema changes.
    await client.query("LOCK TABLE public.organizations IN SHARE ROW EXCLUSIVE MODE");
    // Owner-approved read budget; reset before locking dependencies or writing.
    await client.query("SET LOCAL statement_timeout = '60s'");
    phase = "receipt lookup";
    const receipt = (await client.query<{ metadata_json: { sourceAuditIds?: string[] } }>(
      `SELECT metadata_json FROM public.audit_logs WHERE action='audited_organizations_recovered'
       AND entity_type='maintenance_operation' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [ORGANIZATION_RECOVERY_APPROVAL.operation],
    )).rows[0];
    if (receipt) {
      const auditIds = receipt.metadata_json?.sourceAuditIds;
      if (!Array.isArray(auditIds) || auditIds.length !== 24 || new Set(auditIds).size !== 24) {
        throw new HttpError(409, "Recovery receipt is incomplete; no changes were made.");
      }
      const original = (await client.query<AuditedOrganizationCandidate>(
        `SELECT entity_id AS organization_id, id AS audit_id, action,
          after_json AS snapshot, md5(after_json::text) AS snapshot_hash
         FROM public.audit_logs WHERE id=ANY($1::text[]) AND entity_type='organization'
           AND action IN ('organization_created','organization_updated')
           AND after_json->>'id'=entity_id ORDER BY entity_id`, [auditIds],
      )).rows;
      const present = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.organizations WHERE id=ANY($1::text[])",
        [original.map((c) => c.organization_id)],
      );
      if (original.length !== 24 || evidenceDigest(original) !== ORGANIZATION_RECOVERY_APPROVAL.digest ||
          present.rows[0].count !== "24") {
        throw new HttpError(409, "Previously recovered records or their evidence changed; no changes were made.");
      }
      await client.query("ROLLBACK");
      open = false;
      return result("already-applied");
    }
    phase = "evidence selection";
    const candidates = (await client.query<AuditedOrganizationCandidate>(AUDITED_ORGANIZATION_RECOVERY_SQL)).rows;
    if (candidates.length !== 24 || evidenceDigest(candidates) !== ORGANIZATION_RECOVERY_APPROVAL.digest) {
      throw new HttpError(409, "The approved organization evidence changed; a new review is required.");
    }
    await client.query("SET LOCAL statement_timeout = '15s'");
    const ids = candidates.map((c) => c.organization_id);
    phase = "membership locking";
    const members = (await client.query<{ id: string }>(
      `SELECT id FROM public.lab_memberships WHERE deleted_at IS NULL AND status='active'
       AND lab_id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids],
    )).rows;
    if (members.length !== 24) throw new HttpError(409, "The approved membership scope changed.");
    // Refuse unreviewed side effects. Internal FK triggers enforce references;
    // an added application INSERT trigger needs a separate rehearsal.
    phase = "trigger inspection";
    const triggerCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_trigger
       WHERE tgrelid='public.organizations'::regclass AND NOT tgisinternal AND tgenabled<>'D'
         AND (tgtype::int & 4)=4`,
    );
    if (triggerCount.rows[0].count !== "0") {
      throw new HttpError(409, "Organization insert triggers changed; a new rehearsal is required.");
    }
    // Keep proven dependencies present until commit. FK enforcement is retained
    // even for columns whose legacy schema did not install a declarative FK.
    phase = "dependency locking";
    const creatorIds = candidates.map((c) => c.snapshot.createdByUserId).filter((id): id is string => typeof id === "string");
    const bankIds = candidates.map((c) => c.snapshot.defaultBankAccountId).filter((id): id is string => typeof id === "string");
    await client.query("SELECT id FROM public.users WHERE id=ANY($1::text[]) FOR KEY SHARE", [creatorIds]);
    await client.query("SELECT id FROM public.bank_accounts WHERE id=ANY($1::text[]) FOR KEY SHARE", [bankIds]);
    phase = "dependency preflight";
    const unsafe = await client.query<{ count: string }>(
      `WITH c AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(snapshot jsonb))
       SELECT count(*)::text AS count FROM c WHERE
        (snapshot->>'createdByUserId' IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.users WHERE id=snapshot->>'createdByUserId')) OR
        (snapshot->>'parentLabOrganizationId' IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.organizations WHERE id=snapshot->>'parentLabOrganizationId')) OR
        (snapshot->>'defaultBankAccountId' IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.bank_accounts WHERE id=snapshot->>'defaultBankAccountId')) OR
        EXISTS(SELECT 1 FROM public.organizations
          WHERE platform_account_number=snapshot->>'platformAccountNumber')`, [JSON.stringify(candidates)],
    );
    if (unsafe.rows[0].count !== "0") throw new HttpError(409, "An original parent dependency or account number changed.");
    phase = "clinical scope preflight";
    const linked = await client.query<{ count: string }>(
      `SELECT (
        (SELECT count(*) FROM public.cases WHERE lab_organization_id=ANY($1::text[]) OR provider_organization_id=ANY($1::text[])) +
        (SELECT count(*) FROM public.invoices WHERE lab_organization_id=ANY($1::text[]) OR provider_organization_id=ANY($1::text[])) +
        (SELECT count(*) FROM public.doctor_profiles WHERE lab_organization_id=ANY($1::text[]) OR provider_organization_id=ANY($1::text[])) +
        (SELECT count(*) FROM public.lab_cases WHERE organization_id=ANY($1::text[])) +
        (SELECT count(*) FROM public.legacy_case_media WHERE organization_id=ANY($1::text[]))
       )::text AS count`, [ids],
    );
    if (linked.rows[0].count !== "0") throw new HttpError(409, "The approved clinical-data scope changed.");
    const mapping = Object.fromEntries(Object.entries(getTableColumns(organizations)).map(([key, col]) => [key, col.name]));
    const statements = candidates.map((c) => buildAuditedOrganizationInsert(c, mapping));
    if (dryRun) {
      await client.query("ROLLBACK");
      open = false;
      return result("ready");
    }
    phase = "parent insertion";
    for (const statement of statements) await client.query(statement.sql, statement.values);
    // A required immutable receipt is committed with the parents. Failure to
    // record it rolls back the entire correction, never a partial successful run.
    phase = "audit receipt";
    await client.query(
      `INSERT INTO public.audit_logs(action,entity_type,entity_id,user_id,after_json,metadata_json)
       VALUES('audited_organizations_recovered','maintenance_operation',$1,$2,$3::jsonb,$4::jsonb)`,
      [ORGANIZATION_RECOVERY_APPROVAL.operation, actorId, JSON.stringify(result("applied")), JSON.stringify({
        executor: "platform-admin-automation", evidenceDigest: ORGANIZATION_RECOVERY_APPROVAL.digest,
        sourceAuditIds: candidates.map((c) => c.audit_id), membershipIds: members.map((m) => m.id),
        organizationIds: ids, approvalScope: "recover-proven-parents-preserve-all-other-live-records",
      })],
    );
    phase = "commit";
    await client.query("COMMIT");
    open = false;
    return result("applied");
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
    }
    if (error instanceof HttpError) throw error;
    // Never send/log PG details: failed-row diagnostics can contain private
    // names, billing contacts, or other historical organization fields.
    const code = (error as { code?: unknown })?.code;
    const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : "";
    throw new HttpError(409, `Recovery did not complete during ${phase}${sqlState}. Recheck its receipt before retrying; no alternative record scope is permitted.`);
  } finally {
    client.release(discard ? new Error("Recovery connection discarded") : undefined);
  }
}

function result(state: OrganizationRecoveryResult["state"]): OrganizationRecoveryResult {
  return {
    state, evidenceDigest: ORGANIZATION_RECOVERY_APPROVAL.digest,
    organizationsRecovered: 24, membershipsMadeEffective: 24, fullRestoreVerified: false,
  };
}
