/**
 * Reconcile cases whose saved status disagrees with their selected station.
 *
 * Default mode is a dry-run. Pass --apply explicitly to write. The selected
 * lab_locations row is authoritative, matching the live locate endpoints.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run reconcile-case-location-statuses
 *   pnpm --filter @workspace/scripts run reconcile-case-location-statuses -- --apply
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { cases, db, labCases, labLocations, pool } from "@workspace/db";

const apply = process.argv.includes("--apply");

const LEGACY_TO_CANONICAL_STATUS: Record<string, string> = {
  INTAKE: "received",
  DESIGN: "in_design",
  SCAN: "scan",
  MILLING: "in_milling",
  POST_MILL: "post_mill",
  SINTERING_FURNACE: "sintering_furnace",
  MODEL_ROOM: "model_room",
  PORCELAIN: "in_porcelain",
  QC_CHECK: "qc",
  QC: "qc",
  COMPLETE: "complete",
  DELIVERY: "shipped",
  SHIP: "shipped",
  DELIVERED: "delivered",
  ON_HOLD: "on_hold",
  HOLD: "on_hold",
  REMAKE: "remake",
  CANCELLED: "cancelled",
};

const CANONICAL_TO_LEGACY_STATUS: Record<string, string> = {
  received: "INTAKE",
  in_design: "DESIGN",
  scan: "SCAN",
  in_milling: "MILLING",
  post_mill: "POST_MILL",
  sintering_furnace: "SINTERING_FURNACE",
  model_room: "MODEL_ROOM",
  in_porcelain: "PORCELAIN",
  qc: "QC",
  complete: "COMPLETE",
  shipped: "SHIP",
  delivered: "DELIVERED",
  on_hold: "ON_HOLD",
  remake: "REMAKE",
  cancelled: "CANCELLED",
};

async function main(): Promise<void> {
  console.log(
    `[reconcile-case-location-statuses] starting — mode=${apply ? "APPLY" : "DRY-RUN"}`,
  );

  const canonicalMismatches = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      currentStatus: cases.status,
      expectedStatus: labLocations.status,
      labLocationId: cases.labLocationId,
      locationName: labLocations.name,
      labOrganizationId: cases.labOrganizationId,
    })
    .from(cases)
    .innerJoin(
      labLocations,
      and(
        eq(cases.labLocationId, labLocations.id),
        eq(cases.labOrganizationId, labLocations.labOrganizationId),
      ),
    )
    .where(and(isNull(cases.deletedAt), sql`${cases.status} <> ${labLocations.status}`));

  const legacyRows = await db
    .select({
      id: labCases.id,
      organizationId: labCases.organizationId,
      caseData: labCases.caseData,
    })
    .from(labCases)
    .where(and(isNull(labCases.deletedAt), sql`${labCases.organizationId} IS NOT NULL`));

  const locationRows = await db
    .select({
      id: labLocations.id,
      labOrganizationId: labLocations.labOrganizationId,
      name: labLocations.name,
      status: labLocations.status,
    })
    .from(labLocations);
  const locationByLabAndId = new Map(
    locationRows.map((row) => [`${row.labOrganizationId}:${row.id}`, row] as const),
  );

  const legacyMismatches: Array<{
    id: string;
    organizationId: string;
    originalCaseData: string;
    updatedCaseData: string;
    caseNumber: string;
    currentStatus: string;
    expectedStatus: string;
    locationName: string;
  }> = [];
  for (const row of legacyRows) {
    if (!row.organizationId) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.caseData);
    } catch {
      continue;
    }
    const labLocationId =
      typeof parsed.labLocationId === "string" ? parsed.labLocationId : "";
    const location = locationByLabAndId.get(`${row.organizationId}:${labLocationId}`);
    if (!location) continue;
    const expectedStatus =
      CANONICAL_TO_LEGACY_STATUS[location.status] ?? location.status.toUpperCase();
    const currentStatus = String(parsed.status ?? "").trim().toUpperCase();
    if (LEGACY_TO_CANONICAL_STATUS[currentStatus] === location.status) continue;
    parsed.status = expectedStatus;
    if (location.status === "complete") parsed.assignedBarcode = null;
    legacyMismatches.push({
      id: row.id,
      organizationId: row.organizationId,
      originalCaseData: row.caseData,
      updatedCaseData: JSON.stringify(parsed),
      caseNumber: String(parsed.caseNumber ?? row.id),
      currentStatus,
      expectedStatus,
      locationName: location.name,
    });
  }

  for (const row of canonicalMismatches) {
    console.log(
      `  canonical ${row.caseNumber} (${row.id}): ${row.currentStatus} -> ${row.expectedStatus} ` +
        `from station "${row.locationName}"`,
    );
  }
  for (const row of legacyMismatches) {
    console.log(
      `  legacy ${row.caseNumber} (${row.id}): ${row.currentStatus || "(blank)"} -> ` +
        `${row.expectedStatus} from station "${row.locationName}"`,
    );
  }

  const total = canonicalMismatches.length + legacyMismatches.length;
  console.log(
    `[reconcile-case-location-statuses] found ${total} mismatch(es): ` +
      `${canonicalMismatches.length} canonical, ${legacyMismatches.length} legacy`,
  );
  if (!apply || total === 0) {
    if (!apply && total > 0) {
      console.log("[reconcile-case-location-statuses] dry-run only; re-run with --apply to reconcile.");
    }
    return;
  }

  let repaired = 0;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('labtrax-case-location-status'))`,
    );
    for (const row of canonicalMismatches) {
      const updated = await tx
        .update(cases)
        .set({
          status: row.expectedStatus,
          casePanBarcode: row.expectedStatus === "complete" ? null : undefined,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(cases.id, row.id),
            eq(cases.labLocationId, row.labLocationId!),
            eq(cases.status, row.currentStatus),
            sql`exists (
              select 1 from lab_locations current_location
              where current_location.id = ${row.labLocationId}
                and current_location.lab_organization_id = ${row.labOrganizationId}
                and current_location.status = ${row.expectedStatus}
            )`,
          ),
        )
        .returning({ id: cases.id });
      repaired += updated.length;
    }
    for (const row of legacyMismatches) {
      const updated = await tx
        .update(labCases)
        .set({ caseData: row.updatedCaseData, updatedAt: new Date() })
        .where(
          and(
            eq(labCases.id, row.id),
            eq(labCases.caseData, row.originalCaseData),
            sql`exists (
              select 1 from lab_locations current_location
              where current_location.id = (${labCases.caseData}::jsonb ->> 'labLocationId')
                and current_location.lab_organization_id = ${row.organizationId}
                and current_location.status = ${
                  LEGACY_TO_CANONICAL_STATUS[row.expectedStatus]
                }
            )`,
          ),
        )
        .returning({ id: labCases.id });
      repaired += updated.length;
    }
  });
  console.log(
    `[reconcile-case-location-statuses] applied ${repaired} guarded repair(s)` +
      (repaired === total ? "." : `; skipped ${total - repaired} row(s) changed concurrently.`),
  );
}

main()
  .catch((error) => {
    console.error("[reconcile-case-location-statuses] fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });