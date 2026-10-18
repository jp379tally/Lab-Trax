import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface PreservedCaseManifest {
  version: 1;
  archiveSha256: string;
  columns: string[];
  cases: { id: string; rowHash: string }[];
}

type ReadOnlyQuery = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: unknown[] }>;

const MANIFEST_PATH = resolve(
  import.meta.dirname,
  "../preserved-legacy-case-fingerprints.json",
);

// Fixed, committed evidence, not an environment-variable bypass. It contains
// only identifiers, column names and hashes, never patient or doctor names.
export function loadPreservedCaseManifest(): PreservedCaseManifest {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (
    manifest.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256 ?? "") ||
    !Array.isArray(manifest.columns) ||
    manifest.columns.length === 0 ||
    !manifest.columns.every((column: unknown) =>
      typeof column === "string" && /^[a-z_][a-z0-9_]*$/.test(column),
    ) ||
    new Set(manifest.columns).size !== manifest.columns.length ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== 297 ||
    !manifest.cases.every((row: { id?: unknown; rowHash?: unknown } | null) =>
      row !== null &&
      typeof row.id === "string" && row.id.length > 0 &&
      typeof row.rowHash === "string" && /^[a-f0-9]{32}$/.test(row.rowHash),
    ) ||
    new Set(manifest.cases.map((row: { id: string }) => row.id)).size !== 297
  ) {
    throw new Error("Invalid committed preserved-case manifest; refusing the publishing exception");
  }
  return manifest;
}

export const PRESERVED_LEGACY_CASES_SQL = `
WITH expected AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(id text, row_hash text)
), preserved AS (
  SELECT e.id, c.id AS present_id,
    c.id IS NOT NULL AND md5((
      SELECT jsonb_object_agg(field.key, field.value)
      FROM jsonb_each(to_jsonb(c)) AS field
      WHERE field.key = ANY($2::text[])
    )::text) = e.row_hash AS unchanged
  FROM expected e
  LEFT JOIN public.cases c ON c.id = e.id
), unexpected AS (
  SELECT count(*) AS affected
  FROM public.cases c
  LEFT JOIN public.organizations l ON l.id = c.lab_organization_id
  LEFT JOIN public.organizations p ON p.id = c.provider_organization_id
  WHERE (l.id IS NULL OR p.id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.id = c.id)
)
SELECT
  (SELECT count(*) FROM expected) AS expected_count,
  (SELECT count(present_id) FROM preserved) AS present_count,
  (SELECT count(*) FROM preserved WHERE unchanged) AS matching_count,
  (SELECT affected FROM unexpected) AS unexpected_count
`.trim();

function readCount(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error(`Invalid preserved-case integrity count: ${key}`);
  }
  return Number(value);
}

export async function checkPreservedLegacyCases(query: ReadOnlyQuery) {
  const manifest = loadPreservedCaseManifest();
  const result = await query(PRESERVED_LEGACY_CASES_SQL, [
    JSON.stringify(manifest.cases.map((row) => ({
      id: row.id, row_hash: row.rowHash,
    }))),
    manifest.columns,
  ]);
  if (
    result.rows.length !== 1 ||
    !result.rows[0] ||
    typeof result.rows[0] !== "object"
  ) {
    throw new Error("Preserved-case check did not return one aggregate row");
  }
  const row = result.rows[0] as Record<string, unknown>;
  const expected = readCount(row, "expected_count");
  const present = readCount(row, "present_count");
  const matching = readCount(row, "matching_count");
  const unexpected = readCount(row, "unexpected_count");
  if (
    expected !== manifest.cases.length ||
    present > expected ||
    matching > present
  ) {
    throw new Error("Inconsistent preserved-case integrity counts");
  }
  const errors: string[] = [];
  if (present !== expected) {
    errors.push(`preserved legacy cases: ${expected - present} archived record(s) missing from live tables`);
  }
  if (matching !== present) {
    errors.push(`preserved legacy cases: ${present - matching} record(s) changed from the approved archive`);
  }
  if (unexpected > 0) {
    errors.push(`case ownership: ${unexpected} invalid-owner record(s) outside the committed legacy exception`);
  }
  return {
    blocking: errors.length > 0,
    errors,
    summary: `preserved legacy cases: ${matching}/${expected} unchanged; ${unexpected} unexpected ownership failures`,
  };
}
