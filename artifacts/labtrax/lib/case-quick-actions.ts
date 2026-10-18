/**
 * Quick actions are deliberately limited to live case records. Deleted cases
 * can still appear in search/history payloads, and closed cases must keep their
 * existing read-only tap behaviour.
 */
export function isActiveCaseRecord(caseRecord: {
  status?: string | null;
  deleted?: boolean | null;
  deletedAt?: string | null;
}): boolean {
  if (caseRecord.deleted === true || !!caseRecord.deletedAt) return false;
  const status = (caseRecord.status ?? "").trim().toLowerCase();
  if (!status || status.includes("deleted")) return false;
  return ![
    "complete",
    "delivered",
    "done",
    "cancelled",
    "canceled",
    "void",
  ].some((closed) => status.includes(closed));
}