import { describe, expect, it } from 'vitest';
import { buildAuditedOrganizationInsert, type AuditedOrganizationCandidate } from './organization-audit-recovery.js';

const columns = {
  id: 'id', name: 'name', type: 'type', isActive: 'is_active',
  deletedAt: 'deleted_at', createdAt: 'created_at', updatedAt: 'updated_at',
};
const candidate = (): AuditedOrganizationCandidate => ({
  organization_id: 'original-organization', audit_id: 'original-audit',
  action: 'organization_created', snapshot_hash: 'a'.repeat(32),
  snapshot: {
    id: 'original-organization', name: "Recorded name'); DELETE FROM users; --",
    type: 'lab', isActive: true, deletedAt: null,
    createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z',
  },
});

describe('audited organization recovery statement', () => {
  it('parameterizes private fields, retains recorded identity, and never upserts', () => {
    const source = candidate();
    const before = JSON.stringify(source);
    const statement = buildAuditedOrganizationInsert(source, columns);
    expect(statement.sql).toContain('INSERT INTO public.organizations');
    expect(statement.sql).toContain('$1::jsonb');
    expect(statement.sql).not.toContain(source.snapshot.name);
    expect(statement.sql).not.toMatch(/ON CONFLICT|DO UPDATE|UPDATE public/i);
    expect(JSON.parse(statement.values[0]).id).toBe(source.organization_id);
    expect(JSON.stringify(source)).toBe(before);
  });
  it.each([
    { field: 'id', value: 'different-owner' },
    { field: 'isActive', value: false },
    { field: 'deletedAt', value: '2026-10-02T00:00:00Z' },
    { field: 'type', value: 'unknown' },
    { field: 'createdAt', value: 'invalid' },
    { field: 'name', value: '' },
  ])('refuses incomplete or conflicting evidence: $field', ({ field, value }) => {
    const source = candidate();
    source.snapshot[field] = value;
    expect(() => buildAuditedOrganizationInsert(source, columns)).toThrow();
  });
  it('refuses later retirement events instead of restoring an older active state', () => {
    const source = candidate();
    source.action = 'organization_deleted';
    expect(() => buildAuditedOrganizationInsert(source, columns)).toThrow();
  });
  it('refuses unknown historical fields rather than silently dropping them', () => {
    const source = candidate();
    source.snapshot.unrecognizedField = 'value';
    expect(() => buildAuditedOrganizationInsert(source, columns)).toThrow();
  });
  it('refuses unsafe or ambiguous column mappings', () => {
    expect(() => buildAuditedOrganizationInsert(candidate(), { ...columns, name: 'name; DROP TABLE users' })).toThrow();
    expect(() => buildAuditedOrganizationInsert(candidate(), { ...columns, name: 'id' })).toThrow();
  });
});
