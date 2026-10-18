import type { QueryClient } from "@tanstack/react-query";
import type { CaseDoctorAssignment } from "./generated/api.schemas";
import { getGetCaseDoctorCandidatesQueryKey } from "./generated/api";

/**
 * A committed assignment is not a retryable write failure if a refresh fails.
 * Patch only confirmed detail fields; invalidate all established case/roster
 * prefixes (including paged lists and history embedded in the case detail).
 */
export async function refreshCaseDoctorQueries(
  client: QueryClient,
  assignment: CaseDoctorAssignment,
): Promise<boolean> {
  const detailKeys = [["case", assignment.caseId], ["cases", assignment.caseId]];
  const keys = [
    ...detailKeys, ["cases"], ["/api/cases"], ["/api/cases/overview"],
    [`/api/cases/${assignment.caseId}`], ["case-doctor-names"],
    ["case-doctor-directory"], ["legacy-cases-for-dropzone"], ["doctors"],
    ["practice-doctors"], ["organization", assignment.providerOrganizationId, "eligible-doctors"],
    getGetCaseDoctorCandidatesQueryKey(assignment.caseId),
  ];
  const patches = await Promise.allSettled(detailKeys.map((queryKey) => Promise.resolve().then(() => {
    client.setQueryData(queryKey, (previous: unknown) => {
      if (!previous || typeof previous !== "object" || !("id" in previous) || previous.id !== assignment.caseId) return previous;
      return { ...previous, doctorName: assignment.doctorName, updatedAt: assignment.updatedAt };
    });
  })));
  const refreshes = await Promise.allSettled(keys.map((queryKey) =>
    Promise.resolve().then(() => client.invalidateQueries({ queryKey }, { throwOnError: true })),
  ));
  return [...patches, ...refreshes].every((result) => result.status === "fulfilled");
}
