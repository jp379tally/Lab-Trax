import { and, eq, isNull, sql } from "drizzle-orm";
import { doctorProfiles } from "@workspace/db";

/**
 * Return the durable profile ID for a doctor, creating the lightweight
 * profile row when the invoice path is the first place that sees this doctor.
 * The profile ID remains stable when the display name is renamed.
 */
export async function ensureDoctorProfileIdentity(
  executor: any,
  input: {
    labOrganizationId: string;
    providerOrganizationId: string | null;
    doctorName: string | null | undefined;
  },
): Promise<string | null> {
  const doctorName = input.doctorName?.trim();
  if (!doctorName) return null;

  const providerClause =
    input.providerOrganizationId === null
      ? isNull(doctorProfiles.providerOrganizationId)
      : eq(doctorProfiles.providerOrganizationId, input.providerOrganizationId);
  const where = and(
    eq(doctorProfiles.labOrganizationId, input.labOrganizationId),
    sql`lower(${doctorProfiles.doctorName}) = lower(${doctorName})`,
    providerClause,
  );

  const existing = await executor.query.doctorProfiles.findFirst({ where });
  if (existing) return existing.id;

  const [created] = await executor
    .insert(doctorProfiles)
    .values({
      labOrganizationId: input.labOrganizationId,
      doctorName,
      providerOrganizationId: input.providerOrganizationId,
    })
    .onConflictDoNothing()
    .returning({ id: doctorProfiles.id });
  if (created) return created.id;

  // Another invoice request may have created the same profile concurrently.
  const concurrent = await executor.query.doctorProfiles.findFirst({ where });
  return concurrent?.id ?? null;
}