import { HttpError } from "./http";
import { sql } from "drizzle-orm";

export const LOCATABLE_CASE_STATUSES = [
  "received",
  "in_design",
  "scan",
  "in_milling",
  "post_mill",
  "sintering_furnace",
  "model_room",
  "in_porcelain",
  "qc",
  "complete",
  "shipped",
  "delivered",
  "on_hold",
  "remake",
  "cancelled",
] as const;

export type LocatableCaseStatus = (typeof LOCATABLE_CASE_STATUSES)[number];

const LOCATABLE_CASE_STATUS_SET = new Set<string>(LOCATABLE_CASE_STATUSES);

export async function acquireCaseLocationStatusLock(tx: any): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('labtrax-case-location-status'))`,
  );
}

type LocationRow = {
  id: string;
  labOrganizationId: string;
  status: string;
};

/**
 * Enforces the location/status invariant after the caller looks up the selected
 * station. A selected station is authoritative: its configured workflow stage
 * overrides any contradictory status supplied by a client.
 */
export function resolveLocatedCaseStatus(input: {
  labOrganizationId: string;
  labLocationId: string;
  location: LocationRow | null | undefined;
}): LocatableCaseStatus {
  const { labOrganizationId, labLocationId, location } = input;
  if (
    !location ||
    location.id !== labLocationId ||
    location.labOrganizationId !== labOrganizationId
  ) {
    throw new HttpError(400, "labLocationId does not belong to this lab.");
  }
  if (!LOCATABLE_CASE_STATUS_SET.has(location.status)) {
    throw new HttpError(
      422,
      "The selected lab location is not mapped to a valid case status.",
    );
  }
  return location.status as LocatableCaseStatus;
}