// Builds the unified candidate list shown in the duplicate-prompt modal of
// `app/(tabs)/scan.tsx`. Server hits ("canonical") are the only ones we
// can hard-link via remakeOfCaseId; legacy local-only hits are still
// surfaced so the user sees their full history.

import type { LabCase } from "../data";

export interface DuplicateHit {
  id: string;
  caseNumber: string;
  matchKind: "exact" | "nickname" | "fuzzy" | string;
  source: "canonical" | "legacy";
  patientFirstName: string;
  patientLastName: string;
  status?: string;
  createdAt?: string | null;
  toothNumbers?: string;
  restorationTypes?: string;
}

export function localCaseToHit(c: LabCase): DuplicateHit {
  const parts = (c.patientName ?? "").split(" ");
  return {
    id: c.id,
    caseNumber: c.caseNumber,
    matchKind: "exact",
    source: "legacy",
    patientFirstName: parts[0] ?? "",
    patientLastName: parts.slice(1).join(" "),
    status: c.status,
    createdAt: typeof c.createdAt === "string" ? c.createdAt : null,
    toothNumbers: c.toothIndices,
    restorationTypes: c.caseType,
  };
}

export function mergeDuplicateMatches(
  serverMatches: DuplicateHit[],
  localMatches: LabCase[],
): DuplicateHit[] {
  if (serverMatches.length > 0) return serverMatches;
  return localMatches.map(localCaseToHit);
}

export function defaultSelectedDuplicateId(merged: DuplicateHit[]): string {
  return merged.find((m) => m.source === "canonical")?.id ?? "";
}
