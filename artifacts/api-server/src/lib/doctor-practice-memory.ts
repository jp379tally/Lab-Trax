import { and, eq } from "drizzle-orm";
import { rxDoctorPracticeMemory } from "@workspace/db";
import { normalizeRxDoctorName } from "./rx-practice-normalize.js";

export type DoctorPracticeMemoryChange = {
  sourceDoctorKey: string;
  sourceProviderOrganizationId: string;
  sourceCreatedByUserId: string | null;
  targetDoctorKey: string;
  targetProviderOrganizationId: string | null;
  targetMemoryId: string;
  targetUpdatedAt: string;
  action: "moved" | "dropped";
};

/**
 * Move a source doctor's remembered practice to the surviving doctor's
 * normalized key. The target row wins on conflict: the source row is removed
 * instead of randomly replacing the practice the survivor already remembers.
 *
 * Returning the exact before-state lets the merge audit/undo path restore the
 * memory without making a later edit look like part of the original merge.
 *
 * Shared by the doctor-name merge tooling (`routes/doctors.ts`) and the
 * provider-account consolidation path (`lib/doctor-account-consolidation.ts`)
 * so both collapse remembered practices identically.
 */
export async function migrateDoctorPracticeMemory(
  tx: any,
  labId: string,
  sourceDoctorName: string,
  targetDoctorName: string
): Promise<DoctorPracticeMemoryChange | null> {
  const sourceDoctorKey = normalizeRxDoctorName(sourceDoctorName);
  const targetDoctorKey = normalizeRxDoctorName(targetDoctorName);
  if (!sourceDoctorKey || !targetDoctorKey || sourceDoctorKey === targetDoctorKey) {
    return null;
  }

  const [sourceMemory] = await tx
    .select({
      id: rxDoctorPracticeMemory.id,
      providerOrganizationId: rxDoctorPracticeMemory.providerOrganizationId,
      createdByUserId: rxDoctorPracticeMemory.createdByUserId,
    })
    .from(rxDoctorPracticeMemory)
    .where(
      and(
        eq(rxDoctorPracticeMemory.labOrganizationId, labId),
        eq(rxDoctorPracticeMemory.doctorName, sourceDoctorKey)
      )
    )
    .limit(1);
  if (!sourceMemory) return null;

  const [targetMemory] = await tx
    .select({
      id: rxDoctorPracticeMemory.id,
      providerOrganizationId: rxDoctorPracticeMemory.providerOrganizationId,
      updatedAt: rxDoctorPracticeMemory.updatedAt,
    })
    .from(rxDoctorPracticeMemory)
    .where(
      and(
        eq(rxDoctorPracticeMemory.labOrganizationId, labId),
        eq(rxDoctorPracticeMemory.doctorName, targetDoctorKey)
      )
    )
    .limit(1);

  if (targetMemory) {
    await tx
      .delete(rxDoctorPracticeMemory)
      .where(eq(rxDoctorPracticeMemory.id, sourceMemory.id));
    return {
      sourceDoctorKey,
      sourceProviderOrganizationId: sourceMemory.providerOrganizationId,
      sourceCreatedByUserId: sourceMemory.createdByUserId,
      targetDoctorKey,
      targetProviderOrganizationId: targetMemory.providerOrganizationId,
      targetMemoryId: targetMemory.id,
      targetUpdatedAt: new Date(targetMemory.updatedAt).toISOString(),
      action: "dropped",
    };
  }

  const movedAt = new Date();
  await tx
    .update(rxDoctorPracticeMemory)
    .set({
      doctorName: targetDoctorKey,
      updatedAt: movedAt,
    })
    .where(eq(rxDoctorPracticeMemory.id, sourceMemory.id));

  return {
    sourceDoctorKey,
    sourceProviderOrganizationId: sourceMemory.providerOrganizationId,
    sourceCreatedByUserId: sourceMemory.createdByUserId,
    targetDoctorKey,
    targetProviderOrganizationId: null,
    targetMemoryId: sourceMemory.id,
    targetUpdatedAt: movedAt.toISOString(),
    action: "moved",
  };
}
