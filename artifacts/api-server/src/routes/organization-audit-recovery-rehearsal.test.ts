/**
 * Production archive rehearsal ONLY in the disposable restore runner.
 * No production connection, write mode, retirement, or validation exception.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { requireIsolatedRestoreTest } from '../lib/restore-test-isolation.js';
import {
  AUDITED_ORGANIZATION_RECOVERY_SQL, buildAuditedOrganizationInsert,
  type AuditedOrganizationCandidate,
} from '../lib/organization-audit-recovery.js';

requireIsolatedRestoreTest();
const archivePath = process.env.LABTRAX_ORGANIZATION_RECOVERY_ARCHIVE_PATH;
const expectedDigest = process.env.LABTRAX_ORGANIZATION_RECOVERY_EVIDENCE_DIGEST;
const expectedArchiveHash = process.env.LABTRAX_ORGANIZATION_RECOVERY_ARCHIVE_SHA256;

afterAll(async () => {
  const { pool } = await import('@workspace/db');
  await pool.end();
});

describe('audit evidence selection guards', () => {
  it.each([
    { name: 'single original snapshot', actions: ['organization_created'], times: ['2026-10-01'], expected: 1 },
    { name: 'later retirement, without falling back to creation', actions: ['organization_created', 'organization_deleted'], times: ['2026-10-01', '2026-10-02'], expected: 0 },
    { name: 'ambiguous latest events, without choosing an arbitrary ID', actions: ['organization_created', 'organization_updated'], times: ['2026-10-01', '2026-10-01'], expected: 0 },
  ])('handles $name', async ({ actions, times, expected }) => {
    const { pool } = await import('@workspace/db');
    const syntheticQuery = AUDITED_ORGANIZATION_RECOVERY_SQL
      .replace(/^\s*WITH\s+/, '')
      .replaceAll('public.lab_memberships', 'fixture_memberships')
      .replaceAll('public.organizations', 'fixture_organizations')
      .replaceAll('public.audit_logs', 'fixture_audits');
    const { rows } = await pool.query(`
      WITH fixture_memberships AS (
        SELECT 'synthetic-org'::text AS lab_id, NULL::timestamptz AS deleted_at, 'active'::text AS status
      ), fixture_organizations AS (
        SELECT NULL::text AS id WHERE false
      ), fixture_audits AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS a(
          id text, entity_id text, entity_type text, action text,
          created_at timestamptz, after_json jsonb
        )
      ), ${syntheticQuery}
    `, [JSON.stringify(actions.map((action, i) => ({
      id: `synthetic-audit-${i}`, entity_id: 'synthetic-org',
      entity_type: 'organization', action, created_at: times[i],
      after_json: { id: 'synthetic-org', name: `synthetic-name-${i}` },
    })))]);
    expect(rows.length).toBe(expected);
  });
});

describe.skipIf(!archivePath)('isolated audited-parent recovery from a production archive', () => {
  it('recovers only proven parents, preserves all other rows, retains strict validation, and rolls back exactly', async () => {
    if (!archivePath || !/^[a-f0-9]{32}$/.test(expectedDigest ?? '') ||
        !/^[a-f0-9]{64}$/.test(expectedArchiveHash ?? '')) {
      throw new Error('Explicit archive and current production evidence fingerprints are required.');
    }
    const { pool, organizations } = await import('@workspace/db');
    const { getTableColumns } = await import('drizzle-orm');
    const { executeRestore, runPostRestoreValidation, parseAndValidateBackupManifest } = await import('../lib/backup.js');
    const encrypted = readFileSync(archivePath);
    expect(createHash('sha256').update(encrypted).digest('hex')).toBe(expectedArchiveHash);
    expect(parseAndValidateBackupManifest(encrypted).archiveKind).toBe('full');
    // Normal validation must reject the existing defects. It is never relaxed.
    await expect(executeRestore(encrypted, 'isolated-parent-recovery-rehearsal'))
      .rejects.toThrow('orphaned lab_membership');

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const tables = (await client.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name
      `)).rows.map((row) => row.table_name);
      async function fingerprints(excludeOrganizationIds: string[] = [], excludeAuditIds: string[] = []) {
        const result: Record<string, string> = {};
        for (const table of tables) {
          if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('Unsafe table name.');
          const excludedIds = table === 'organizations' ? excludeOrganizationIds : table === 'audit_logs' ? excludeAuditIds : [];
          const exclude = excludedIds.length > 0;
          const { rows } = await client.query<{ fingerprint: string }>(`
            SELECT count(*)::text || ':' ||
              md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), ''))
              AS fingerprint FROM public."${table}" t
              ${exclude ? 'WHERE NOT t.id=ANY($1::text[])' : ''}
          `, exclude ? [excludedIds] : []);
          result[table] = rows[0].fingerprint;
        }
        return result;
      }
      const before = await fingerprints();
      const candidates = (await client.query<AuditedOrganizationCandidate>(AUDITED_ORGANIZATION_RECOVERY_SQL)).rows;
      expect(candidates.length).toBe(24);
      const digest = createHash('md5').update(candidates.map((c) =>
        `${c.organization_id}:${c.audit_id}:${c.snapshot_hash}`).join('|')).digest('hex');
      expect(digest).toBe(expectedDigest);
      const ids = candidates.map((c) => c.organization_id);
      const mapping = Object.fromEntries(Object.entries(getTableColumns(organizations))
        .map(([key, column]) => [key, column.name]));
      const preflight = await client.query<{ unsafe: string }>(`
        WITH candidates AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(organization_id text, snapshot jsonb)
        ) SELECT count(*)::text AS unsafe FROM candidates c WHERE
          EXISTS(SELECT 1 FROM public.organizations o WHERE o.id=c.organization_id) OR
          (c.snapshot->>'createdByUserId' IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM public.users u WHERE u.id=c.snapshot->>'createdByUserId')) OR
          (c.snapshot->>'parentLabOrganizationId' IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM public.organizations o WHERE o.id=c.snapshot->>'parentLabOrganizationId')) OR
          (c.snapshot->>'defaultBankAccountId' IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM public.bank_accounts b WHERE b.id=c.snapshot->>'defaultBankAccountId')) OR
          EXISTS(SELECT 1 FROM public.organizations o
            WHERE o.platform_account_number=c.snapshot->>'platformAccountNumber')
      `, [JSON.stringify(candidates)]);
      expect(preflight.rows[0].unsafe).toBe('0');
      const memberIds = (await client.query<{ id: string }>(
        "SELECT id FROM public.lab_memberships WHERE deleted_at IS NULL AND status='active' AND lab_id=ANY($1::text[]) ORDER BY id", [ids],
      )).rows.map((m) => m.id);
      expect(memberIds.length).toBe(24);
      await client.query('BEGIN');
      transactionOpen = true;
      for (const candidate of candidates) {
        const statement = buildAuditedOrganizationInsert(candidate, mapping);
        await client.query(statement.sql, statement.values);
        const projection = statement.columnNames.map((column) => `"${column}"`).join(', ');
        const match = await client.query<{ exact: boolean }>(`
          SELECT (SELECT ROW(${projection}) FROM public.organizations WHERE id=$2)
            IS NOT DISTINCT FROM
            (SELECT ROW(${projection}) FROM jsonb_populate_record(NULL::public.organizations,$1::jsonb))
            AS exact
        `, [statement.values[0], candidate.organization_id]);
        expect(match.rows[0].exact).toBe(true);
      }
      // Excluding only the 24 inserts must reproduce every original table,
      // including every pre-existing organization and any trigger side effects.
      expect(await fingerprints(ids)).toEqual(before);
      const joinedMembers = await client.query<{ id: string }>(`
        SELECT m.id FROM public.lab_memberships m JOIN public.organizations o ON o.id=m.lab_id
        WHERE m.id=ANY($1::text[]) AND m.deleted_at IS NULL AND m.status='active' ORDER BY m.id
      `, [memberIds]);
      expect(joinedMembers.rows.map((m) => m.id)).toEqual(memberIds);

      // The same validator SQL must see this transaction, not a different pool
      // connection. Test-only call-through; no production validation hook.
      const querySpy = vi.spyOn(pool, 'query');
      querySpy.mockImplementation(client.query.bind(client) as typeof pool.query);
      try {
        const validation = await runPostRestoreValidation({
          expectedCaseCount: null, expectedInvoiceCount: null,
        });
        expect(validation.valid).toBe(false);
        expect(validation.errors.some((e) => e.includes('1190 orphaned lab_membership'))).toBe(true);
        expect(validation.errors.some((e) => e.includes('297'))).toBe(true);
      } finally {
        querySpy.mockRestore();
      }
      // No committed repair is needed to prove the candidate and its rollback.
      await client.query('ROLLBACK');
      transactionOpen = false;
      expect(await fingerprints()).toEqual(before);
      // Exercise the actual publishable operation, not a lookalike INSERT
      // loop. Its commit/replay happens only in this disposable environment.
      const { runAuditedOrganizationRecovery, ORGANIZATION_RECOVERY_APPROVAL } =
        await import('../lib/audited-organization-recovery-operation.js');
      expect((await runAuditedOrganizationRecovery(true, null)).state).toBe('ready');
      expect(await fingerprints()).toEqual(before);
      expect((await runAuditedOrganizationRecovery(false, null)).state).toBe('applied');
      const receiptIds = (await client.query<{ id: string }>(
        "SELECT id FROM public.audit_logs WHERE action='audited_organizations_recovered' AND entity_id=$1",
        [ORGANIZATION_RECOVERY_APPROVAL.operation],
      )).rows.map((r) => r.id);
      expect(receiptIds.length).toBe(1);
      expect(await fingerprints(ids, receiptIds)).toEqual(before);
      const applied = await fingerprints();
      expect((await runAuditedOrganizationRecovery(false, null)).state).toBe('already-applied');
      expect(await fingerprints()).toEqual(applied);
      const committedValidation = await runPostRestoreValidation({
        expectedCaseCount: null, expectedInvoiceCount: null,
      });
      expect(committedValidation.valid).toBe(false);
      expect(committedValidation.errors.some((e) => e.includes('1190 orphaned lab_membership'))).toBe(true);
      expect(committedValidation.errors.some((e) => e.includes('297'))).toBe(true);
      console.log(JSON.stringify({
        result: 'rollback-and-actual-apply-replay-verified-isolated', source: 'verified-production-full-archive',
        evidenceDigest: digest, organizationsRecovered: candidates.length,
        membershipsMadeEffective: memberIds.length, otherTablesUnchanged: tables.length - 1,
        remainingMembershipOrphans: 1190, remainingInvalidOwnerCases: 297,
        normalFullRestoreValid: false, productionWrites: 0,
      }));
    } finally {
      if (transactionOpen) await client.query('ROLLBACK');
      client.release();
    }
  }, 240_000);
});
