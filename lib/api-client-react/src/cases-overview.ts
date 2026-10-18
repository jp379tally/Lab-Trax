import type { CasesOverviewStats } from "./generated/api.schemas";

export type CasesOverview = CasesOverviewStats;

/** Reject broken responses rather than presenting partial or invented counts. */
export function parseCasesOverview(value: unknown): CasesOverview {
  if (!value || typeof value !== "object") throw new Error("Cases summary could not be loaded.");
  const counts = value as Record<string, unknown>;
  for (const key of [
    "totalCases",
    "dueToday",
    "conflicts",
    "rushCases",
    "processingCases",
    "inTransitCases",
    "completedCases",
    "overdueCases",
    "receivedCases",
    "inDesignCases",
    "modelRoomCases",
    "shippedCases",
    "scanCases",
    "millingCases",
    "postMillCases",
    "sinteringFurnaceCases",
    "porcelainCases",
    "qualityCheckCases",
    "onHoldCases",
    "remakeCases",
  ]) {
    if (typeof counts[key] !== "number" || !Number.isSafeInteger(counts[key]) || counts[key] < 0) {
      throw new Error("Cases summary returned invalid counts.");
    }
  }
  return value as CasesOverview;
}
