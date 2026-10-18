import {
  describeCaseOrganizationRows,
  inspectCaseOrganizationConstraints,
  inspectCaseOrganizationRows,
  type IntegrityQuery,
} from "@workspace/db/case-organization-integrity";

/**
 * Missing catalog objects may be advisory before Publish applies its reviewed
 * schema diff. Actual missing parent rows can never be fixed by that diff and
 * must block even when schema drift is allowed. No repair is performed here.
 */
export async function checkCaseOrganizationDrift(
  query: IntegrityQuery,
  allowMissingConstraints: boolean,
): Promise<{ blocking: boolean; errors: string[]; warnings: string[]; summary: string }> {
  // Deliberately run both probes, even if the rows are broken.
  const rows = await inspectCaseOrganizationRows(query);
  const constraints = await inspectCaseOrganizationConstraints(query);
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary = describeCaseOrganizationRows(rows);
  if (rows.affectedTotal > 0) {
    errors.push(`${summary}. Preserve these records; resolve ownership with owner authorization before validating FKs.`);
  }
  for (const constraint of constraints) {
    if (constraint.status === "validated") continue;
    const message = `cases FK catalog: ${constraint.column} -> public.organizations.id ON DELETE RESTRICT: ${constraint.status}`;
    (allowMissingConstraints ? warnings : errors).push(message);
  }
  return { blocking: errors.length > 0, errors, warnings, summary };
}
