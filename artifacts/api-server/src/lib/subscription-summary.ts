export type DirectoryAccount = {
  id: string; subjectType: string; canonicalSubjectType: string; canonicalSubjectId: string;
  status: string; provider: string; waiverActive: boolean;
};

/** Prefer canonical organizations over their migrated legacy user identity. */
export function canonicalDirectory<T extends DirectoryAccount>(rows: T[]): T[] {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.canonicalSubjectType}:${row.canonicalSubjectId}`;
    const old = chosen.get(key);
    if (!old || (row.subjectType === row.canonicalSubjectType && old.subjectType !== old.canonicalSubjectType)) chosen.set(key, row);
  }
  return [...chosen.values()];
}
export function subscriptionSummary(rows: DirectoryAccount[], paidIds: Set<string>) {
  const summary = { totalAccounts: rows.length, paidSubscribers: 0, trial: 0, free: 0, waived: 0, other: 0, byStatus: {} as Record<string, number>, byProvider: {} as Record<string, number> };
  for (const row of rows) {
    summary.byStatus[row.status] = (summary.byStatus[row.status] ?? 0) + 1;
    summary.byProvider[row.provider] = (summary.byProvider[row.provider] ?? 0) + 1;
    if (row.waiverActive) summary.waived++;
    else if (row.status === "trialing") summary.trial++;
    else if (row.status === "legacy_free") summary.free++;
    else if (row.status !== "deactivated" && paidIds.has(row.id)) summary.paidSubscribers++;
    else summary.other++;
  }
  return summary;
}
