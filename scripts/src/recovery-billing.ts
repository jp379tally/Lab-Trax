/**
 * Authorized recovery operator workflow. Default mode is read-only.
 * Never generates quotes, replays the archived case INSERT, or releases holds.
 * Quote/clinical review is performed through the authenticated review surface.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, rename, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, caseEvents, systemSettings } from "@workspace/db";
import type { RecoveryBillingRow } from "@workspace/api-client-react/schemas";

// The operator must use the actual server pipeline, not copy its billing rules.
// Resolve it at runtime because the scripts TS project may not compile files
// outside its own rootDir; server sources have their own typecheck.
const serverModule = (name: string) => new URL(`../../artifacts/api-server/src/lib/${name}.ts`, import.meta.url).href;
const { applyRecoveryProposal, listRecoveryBilling, recoveryFingerprint } =
  await import(serverModule("recovery-billing")) as {
    applyRecoveryProposal(caseId: string, proposalId: string, actor: string): Promise<{ invoiceId: string; total: string; outcome: string }>;
    listRecoveryBilling(): Promise<RecoveryBillingRow[]>;
    recoveryFingerprint(value: unknown): string;
  };
const { RECOVERY_LAB_ID, RECOVERY_TIMEZONE, RECOVERY_START, RECOVERY_END } =
  await import(serverModule("recovery-billing-scope")) as {
    RECOVERY_LAB_ID: string; RECOVERY_TIMEZONE: string; RECOVERY_START: string; RECOVERY_END: string;
  };
interface Approval {
  version: string; labOrganizationId: string; timezone: string; cutoff: string; expiresAt: string;
  backupSha256: string; backupTakenAt: string; rehearsalSha256: string; databaseFingerprint: string;
  sourceRecoveryCheckedAt: string; proposals: Record<string, string>; proposalFingerprints: Record<string, string>;
  planSha256: string; targetMode: "production" | "rehearsal"; approvalNonce: string;
}
const { RECOVERY_RUN_KEY, RECOVERY_SAFEGUARD_VERSION, recoveryRunSchema,
  recoveryDatabaseIdentity, recoveryApprovalDigest, validateRecoveryApproval } =
  await import(serverModule("recovery-billing-run")) as {
    RECOVERY_RUN_KEY: string; RECOVERY_SAFEGUARD_VERSION: string; recoveryRunSchema: z.ZodType<Approval>;
    recoveryDatabaseIdentity(): Promise<string>; recoveryApprovalDigest(value: string): string;
    validateRecoveryApproval(value: unknown, caseId: string, proposalId: string): Approval;
  };
const { ADMIN_ROLES, requireAnyRole } = await import(serverModule("rbac")) as {
  ADMIN_ROLES: string[]; requireAnyRole(actor: string, lab: string, roles: string[]): Promise<unknown>;
};

const planSchema = z.object({
  version: z.literal(RECOVERY_SAFEGUARD_VERSION),
  labOrganizationId: z.literal(RECOVERY_LAB_ID),
  timezone: z.literal(RECOVERY_TIMEZONE),
  cutoff: z.string().datetime(),
  databaseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  targets: z.array(z.object({
    caseId: z.string().uuid(), proposalId: z.string().uuid(),
    proposalFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    total: z.string().regex(/^\d+\.\d{2}$/),
  }).strict()).max(247),
}).strict();
type Plan = z.infer<typeof planSchema>;

async function save(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function readPlan(file: string) {
  return planSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
async function requirePlanIdentity(plan: Plan) {
  if (await recoveryDatabaseIdentity() !== plan.databaseFingerprint) throw new Error("Wrong database/lab lineage; no billing writes allowed.");
  if (new Set(plan.targets.map((target) => target.caseId)).size !== plan.targets.length) throw new Error("Duplicate plan case.");
}
async function readiness(origin: string, plan: Plan, approvalDigest?: string) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") throw new Error("Supply the verified HTTPS production origin, not a development path.");
  const response = await fetch(new URL("/api/billing-recovery/safeguards", url), { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error("Published recovery safeguards are unavailable; production application is disabled.");
  const data = await response.json() as { version?: string; databaseFingerprint?: string; approvalDigest?: string };
  if (data.version !== RECOVERY_SAFEGUARD_VERSION || data.databaseFingerprint !== plan.databaseFingerprint ||
      (approvalDigest && data.approvalDigest !== approvalDigest)) {
    throw new Error("Published safeguards/database/approval do not match this connection. No production billing writes.");
  }
}
async function registryApproval(plan: Plan, approval: z.infer<typeof recoveryRunSchema>) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_RUN_KEY}))`);
    const existing = await tx.query.systemSettings.findFirst({ where: eq(systemSettings.key, RECOVERY_RUN_KEY) });
    if (existing?.value) {
      const previous = recoveryRunSchema.safeParse(JSON.parse(existing.value));
      if (!previous.success || (Date.parse(previous.data.expiresAt) > Date.now() && previous.data.planSha256 !== recoveryFingerprint(plan))) {
        throw new Error("Another active or unrecognized approval exists; revoke it explicitly first.");
      }
    }
    await tx.insert(systemSettings).values({ key: RECOVERY_RUN_KEY, value: JSON.stringify(approval) })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: JSON.stringify(approval), updatedAt: new Date() } });
  });
}
async function unrelatedSnapshot(plan: Plan) {
  const ids = plan.targets.map((target) => target.caseId);
  const excluded = ids.length ? sql`${sql.join(ids.map((id) => sql`${id}`), sql`,`)}` : sql`NULL`;
  const queries = {
    cases: sql`SELECT row_to_json(t) AS row FROM cases t ORDER BY id`,
    attachments: sql`SELECT row_to_json(t) AS row FROM case_attachments t ORDER BY id`,
    payments: sql`SELECT row_to_json(t) AS row FROM payments t ORDER BY id`,
    invoices: sql`SELECT row_to_json(t) AS row FROM invoices t WHERE case_id IS NULL OR NOT (case_id = ANY(ARRAY[${excluded}]::varchar[])) ORDER BY id`,
    restorations: sql`SELECT row_to_json(t) AS row FROM case_restorations t WHERE NOT (case_id = ANY(ARRAY[${excluded}]::varchar[])) ORDER BY id`,
    lines: sql`SELECT row_to_json(t) AS row FROM invoice_line_items t WHERE invoice_id NOT IN (SELECT id FROM invoices WHERE case_id = ANY(ARRAY[${excluded}]::varchar[])) ORDER BY id`,
    events: sql`SELECT row_to_json(t) AS row FROM case_events t WHERE NOT (case_id = ANY(ARRAY[${excluded}]::varchar[])) ORDER BY id`,
  };
  const results: Record<string, { count: number; sha256: string }> = {};
  for (const [name, query] of Object.entries(queries)) {
    const rows = (await db.execute(query)).rows;
    results[name] = { count: rows.length, sha256: recoveryFingerprint(rows) };
  }
  return results;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      actor: { type: "string" }, output: { type: "string" }, plan: { type: "string" },
      backup: { type: "string" }, rehearsal: { type: "string" },
      "production-url": { type: "string" }, "source-recovery-confirmed-at": { type: "string" },
      "confirm-production": { type: "boolean", default: false },
    },
  });
  const mode = positionals[0] ?? "audit";
  if (!["audit", "plan", "rehearse", "authorize", "apply", "revoke"].includes(mode)) throw new Error("Modes: audit (default), plan, rehearse, authorize, apply, revoke.");
  if (!values.actor) throw new Error("--actor must name the authorized billing-lab admin performing this operation.");
  await requireAnyRole(values.actor, RECOVERY_LAB_ID, ADMIN_ROLES);
  if (mode === "audit" || mode === "plan") {
    const rows = await listRecoveryBilling();
    const plan: Plan = {
      version: RECOVERY_SAFEGUARD_VERSION, labOrganizationId: RECOVERY_LAB_ID,
      timezone: RECOVERY_TIMEZONE, cutoff: new Date().toISOString(),
      databaseFingerprint: await recoveryDatabaseIdentity(),
      targets: rows.filter((row) => row.state === "proposed" && row.proposal && !row.proposal.exceptions.length)
        .map((row) => ({ caseId: row.caseId, proposalId: row.proposalId!,
          proposalFingerprint: recoveryFingerprint(row.proposal), total: row.proposal!.total })),
    };
    const audit = {
      requestedWindow: { start: RECOVERY_START, end: RECOVERY_END, timezone: RECOVERY_TIMEZONE },
      cutoff: plan.cutoff, counts: Object.fromEntries([...new Set(rows.map((row) => row.state))]
        .map((state) => [state, rows.filter((row) => row.state === state).length])),
      proposedValue: (plan.targets.reduce((total, target) => total + Math.round(Number(target.total) * 100), 0) / 100).toFixed(2),
      historicalPayments: "unknown; zero balance on held drafts is not paid status",
      cases: rows.map(({ caseId, caseNumber, historicalDate, state, sourceFlagged, proposal, invoice }) =>
        ({ caseId, caseNumber, historicalDate, state, sourceFlagged,
          exceptions: proposal?.exceptions ?? [], savedInvoiceId: invoice?.id ?? null })),
    };
    if (!values.output) throw new Error("--output is required; operator reports contain case identities.");
    await save(values.output, mode === "plan" ? plan : audit);
    console.log(JSON.stringify({ mode, counts: audit.counts, proposedValue: audit.proposedValue, billingWrites: 0 }));
    return;
  }
  if (mode === "revoke") {
    await db.delete(systemSettings).where(eq(systemSettings.key, RECOVERY_RUN_KEY));
    console.log("Recovery run revoked; no invoice or case changed.");
    return;
  }
  if (!values.plan || !values.output) throw new Error("--plan and --output are required.");
  const plan = await readPlan(values.plan);
  await requirePlanIdentity(plan);
  if (!plan.targets.length) throw new Error("No reviewed, unambiguous proposals. Nothing to apply.");
  const currentDatabase = (await db.execute(sql`SELECT current_database() AS name`)).rows[0]?.name;
  const rehearsalMode = mode === "rehearse";
  if (rehearsalMode !== (currentDatabase === "labtrax_recovery_billing_rehearsal")) throw new Error("Rehearsal must run only on the isolated named clone; production commands must never use that clone.");
  if (!rehearsalMode && (!values["confirm-production"] || !process.env.PROD_DATABASE_URL ||
      process.env.DATABASE_URL !== process.env.PROD_DATABASE_URL)) {
    throw new Error("Production requires --confirm-production and DATABASE_URL explicitly bound to PROD_DATABASE_URL.");
  }
  if (mode === "authorize" || rehearsalMode) {
    if (!values.backup) throw new Error("--backup must be the verified private fresh PostgreSQL rollback dump.");
    const backupStat = await stat(values.backup);
    if (!backupStat.size || (backupStat.mode & 0o077) || Date.now() - backupStat.mtimeMs > 2 * 60 * 60 * 1000) {
      throw new Error("Backup must be nonempty, private (0600), and less than two hours old.");
    }
    const backupSha256 = await hashFile(values.backup);
    let rehearsalSha256 = "0".repeat(64);
    if (!rehearsalMode) {
      if (!values.rehearsal || !values["production-url"] || !values["source-recovery-confirmed-at"]) throw new Error("Require successful rehearsal, verified published origin and explicit source-recovery coordination.");
      const result = JSON.parse(await readFile(values.rehearsal, "utf8")) as Record<string, unknown>;
      if (result.outcome !== "rehearsed" || result.planSha256 !== recoveryFingerprint(plan) ||
          result.backupSha256 !== backupSha256 || result.unrelatedUnchanged !== true) throw new Error("Rehearsal did not verify this exact plan and backup.");
      rehearsalSha256 = await hashFile(values.rehearsal);
      await readiness(values["production-url"], plan);
    }
    const approval = recoveryRunSchema.parse({
      version: RECOVERY_SAFEGUARD_VERSION, labOrganizationId: RECOVERY_LAB_ID, timezone: RECOVERY_TIMEZONE,
      cutoff: plan.cutoff, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      databaseFingerprint: plan.databaseFingerprint, backupSha256, backupTakenAt: backupStat.mtime.toISOString(),
      rehearsalSha256, sourceRecoveryCheckedAt: values["source-recovery-confirmed-at"] ?? new Date().toISOString(),
      proposals: Object.fromEntries(plan.targets.map((target) => [target.caseId, target.proposalId])),
      proposalFingerprints: Object.fromEntries(plan.targets.map((target) => [target.caseId, target.proposalFingerprint])),
      planSha256: recoveryFingerprint(plan), targetMode: rehearsalMode ? "rehearsal" : "production", approvalNonce: randomUUID(),
    });
    validateRecoveryApproval(approval, plan.targets[0]!.caseId, plan.targets[0]!.proposalId);
    await registryApproval(plan, approval);
    if (!rehearsalMode) {
      try { await readiness(values["production-url"]!, plan, recoveryApprovalDigest(JSON.stringify(approval))); }
      catch (error) {
        await db.delete(systemSettings).where(and(eq(systemSettings.key, RECOVERY_RUN_KEY), eq(systemSettings.value, JSON.stringify(approval))));
        throw error;
      }
      await save(values.output, { outcome: "authorized", planSha256: approval.planSha256, expiresAt: approval.expiresAt });
      console.log("Exact rehearsed run authorized. No invoice created; use apply separately.");
      return;
    }
  }
  const stored = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, RECOVERY_RUN_KEY) });
  if (!stored?.value) throw new Error("No active recovery approval.");
  const approval = recoveryRunSchema.parse(JSON.parse(stored.value));
  if (approval.planSha256 !== recoveryFingerprint(plan)) throw new Error("Approval belongs to another plan.");
  if (!rehearsalMode && !values["production-url"]) throw new Error("--production-url is required.");
  const before = await unrelatedSnapshot(plan);
  const report = {
    outcome: "in_progress", planSha256: recoveryFingerprint(plan), backupSha256: approval.backupSha256,
    before, after: before, unrelatedUnchanged: true,
    results: [] as Array<{ caseId: string; invoiceId?: string; outcome: string; total?: string; error?: string }>,
  };
  for (const target of plan.targets) {
    try {
      if (!rehearsalMode) await readiness(values["production-url"]!, plan, recoveryApprovalDigest(stored.value));
      const event = await db.query.caseEvents.findFirst({ where: eq(caseEvents.id, target.proposalId) });
      const proposal = (event?.metadataJson as { proposal?: unknown } | null)?.proposal;
      if (!proposal || event?.caseId !== target.caseId || recoveryFingerprint(proposal) !== target.proposalFingerprint) throw new Error("Reviewed proposal changed.");
      const result = await applyRecoveryProposal(target.caseId, target.proposalId, values.actor);
      if (result.total !== target.total) throw new Error("Saved total differs from plan; stop and reconcile.");
      report.results.push({ caseId: target.caseId, ...result });
      if (rehearsalMode) {
        const replay = await applyRecoveryProposal(target.caseId, target.proposalId, values.actor);
        if (replay.invoiceId !== result.invoiceId || replay.outcome !== "already_applied") throw new Error("Idempotent replay failed.");
      }
    } catch (error) {
      report.results.push({ caseId: target.caseId, outcome: "failed", error: error instanceof Error ? error.message : "Application refused" });
      report.outcome = "stopped";
      await save(values.output, report);
      throw new Error("Repair stopped without retrying committed cases; inspect the private reconciliation report and resume only after review.");
    }
    await save(values.output, report);
  }
  report.after = await unrelatedSnapshot(plan);
  report.unrelatedUnchanged = recoveryFingerprint(before) === recoveryFingerprint(report.after);
  report.outcome = report.unrelatedUnchanged ? rehearsalMode ? "rehearsed" : "applied_held" : "requires_unrelated_change_review";
  await save(values.output, report);
  if (!report.unrelatedUnchanged) throw new Error("Unrelated rows changed during execution; review concurrent staff writes. Do not perform a broad rollback.");
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.results.length, allReplacementsHeld: true }));
}
main().catch((error: unknown) => {
  // DB errors may contain customer fields or connection details; keep them out
  // of shared workflow logs. The saved reconciliation identifies refused cases.
  const databaseError = error && typeof error === "object" && ("code" in error || "cause" in error);
  console.error(!databaseError && error instanceof Error ? error.message :
    "Database or storage step refused. Check the private reconciliation report and prerequisites; no automatic retry.");
  process.exitCode = 1;
}).finally(() => pool.end());
