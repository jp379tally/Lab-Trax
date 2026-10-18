/** Read-only selection: no fallback to an older snapshot or arbitrary tied event. */
export const AUDITED_ORGANIZATION_RECOVERY_SQL = `
WITH missing AS MATERIALIZED (
  SELECT DISTINCT m.lab_id AS id
  FROM public.lab_memberships m
  WHERE m.deleted_at IS NULL AND m.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = m.lab_id)
), history AS MATERIALIZED (
  SELECT a.entity_id, a.id, a.action, a.after_json, a.created_at,
    max(a.created_at) OVER (PARTITION BY a.entity_id) AS latest_at
  FROM public.audit_logs a JOIN missing m ON m.id = a.entity_id
  WHERE a.entity_type = 'organization'
), latest AS (
  SELECT *, count(*) OVER (PARTITION BY entity_id) AS latest_count
  FROM history WHERE created_at = latest_at
)
SELECT entity_id AS organization_id, id AS audit_id, action,
  after_json AS snapshot, md5(after_json::text) AS snapshot_hash
FROM latest
WHERE latest_count = 1 AND action IN ('organization_created', 'organization_updated')
  AND jsonb_typeof(after_json) = 'object' AND after_json->>'id' = entity_id
ORDER BY entity_id`;

export type AuditedOrganizationCandidate = {
  organization_id: string;
  audit_id: string;
  action: string;
  snapshot: Record<string, unknown>;
  snapshot_hash: string;
};

/**
 * Parameterized, insert-only reconstruction of recorded fields. Columns added
 * since the event receive their actual schema defaults, not fabricated history.
 * This is a statement builder, not a production repair entry point.
 */
export function buildAuditedOrganizationInsert(
  candidate: AuditedOrganizationCandidate,
  columns: Readonly<Record<string, string>>,
): { sql: string; values: [string]; columnNames: string[] } {
  const snapshot = candidate.snapshot;
  if (
    !candidate.organization_id || !candidate.audit_id ||
    !['organization_created', 'organization_updated'].includes(candidate.action) ||
    !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
    snapshot.id !== candidate.organization_id ||
    typeof snapshot.name !== 'string' || !snapshot.name.trim() ||
    !['lab', 'dental_lab', 'provider'].includes(String(snapshot.type)) ||
    snapshot.isActive !== true || snapshot.deletedAt !== null ||
    !/^[a-f0-9]{32}$/.test(candidate.snapshot_hash) ||
    !['createdAt', 'updatedAt'].every((key) =>
      typeof snapshot[key] === 'string' && Number.isFinite(Date.parse(snapshot[key] as string)))
  ) {
    throw new Error('Historical organization evidence is incomplete or not eligible for active recovery.');
  }
  const mapped: Record<string, unknown> = {};
  const columnNames: string[] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (!Object.hasOwn(columns, key) || !/^[a-z_][a-z0-9_]*$/.test(columns[key])) {
      throw new Error('Historical organization fields are incompatible with the current schema.');
    }
    const column = columns[key];
    if (Object.hasOwn(mapped, column)) {
      throw new Error('Organization column mapping is ambiguous.');
    }
    mapped[column] = value;
    columnNames.push(column);
  }
  const projection = columnNames.map((name) => `"${name}"`).join(', ');
  return {
    sql: `INSERT INTO public.organizations (${projection})
      SELECT ${projection} FROM jsonb_populate_record(NULL::public.organizations, $1::jsonb)`,
    values: [JSON.stringify(mapped)],
    columnNames,
  };
}
