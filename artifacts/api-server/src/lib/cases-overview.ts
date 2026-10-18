import { db } from "@workspace/db";
import { CASE_STATUS_GROUPS } from "@workspace/case-taxonomy";
import { sql } from "drizzle-orm";
import { legacyWorklistCandidateSql, unprojectedLegacyProbeSql } from "./legacy-case-list";

const SQL_STATUSES = (statuses: readonly string[]) =>
  sql.join(statuses.map((status) => sql`${status}`), sql`, `);
const TERMINAL_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.terminal);
const PROCESSING_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.processing);
const IN_TRANSIT_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.inTransit);
const COMPLETED_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.completed);
const RECEIVED_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.received);
const IN_DESIGN_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.inDesign);
const MODEL_ROOM_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.modelRoom);
const SHIPPED_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.shipped);
const SCAN_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.scan);
const MILLING_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.milling);
const POST_MILL_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.postMill);
const SINTERING_FURNACE_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.sinteringFurnace);
const PORCELAIN_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.porcelain);
const QUALITY_CHECK_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.qualityCheck);
const ON_HOLD_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.onHold);
const REMAKE_STATUSES = SQL_STATUSES(CASE_STATUS_GROUPS.remake);

/**
 * Complete workbench counts, independent of list criteria and pagination.
 * Use the worklist's authorized organization set and legacy ownership rules.
 * Calendar dates use UTC date parts; "today" and the clock are viewer-local,
 * matching the lab-slip/worklist calendar-date convention.
 */
export async function getCasesOverview(
  organizationIds: string[],
  localDate: string,
  localTime: string,
) {
  if (!organizationIds.length) {
    return {
      totalCases: 0,
      dueToday: 0,
      conflicts: 0,
      rushCases: 0,
      processingCases: 0,
      inTransitCases: 0,
      completedCases: 0,
      overdueCases: 0,
      receivedCases: 0,
      inDesignCases: 0,
      modelRoomCases: 0,
      shippedCases: 0,
      scanCases: 0,
      millingCases: 0,
      postMillCases: 0,
      sinteringFurnaceCases: 0,
      porcelainCases: 0,
      qualityCheckCases: 0,
      onHoldCases: 0,
      remakeCases: 0,
    };
  }
  const ids = sql.join(organizationIds.map((id) => sql`${id}`), sql`, `);
  const probe = await db.execute(unprojectedLegacyProbeSql(organizationIds));
  const hasFallback = probe.rows.length > 0;
  const legacy = sql`${legacyWorklistCandidateSql({ organizationIds, mode: "projected" })}
    ${hasFallback ? sql`union all ${legacyWorklistCandidateSql({ organizationIds, mode: "unprojected" })}` : sql``}`;
  const result = await db.execute(sql`
    with candidates as (
      select c.id, c.lab_organization_id, lower(c.status) as status,
        lower(c.priority) as priority, c.case_pan_barcode as barcode,
        (coalesce(c.due_date, c.expected_delivery_date) at time zone 'UTC')::date as due_day,
        case when c.due_date is not null then c.due_time end as due_time
      from cases c
      where c.deleted_at is null
        and (c.lab_organization_id in (${ids}) or c.provider_organization_id in (${ids}))
      union all
      select l.id, l.lab_organization_id, lower(l.status), lower(l.priority), l.barcode,
        (l.due_date at time zone 'UTC')::date, null::text
      from (${legacy}) l
    ), conflicts as (
      select *, count(*) filter (
        where barcode is not null and trim(barcode) <> ''
          and status not in ('complete', 'delivered', 'cancelled')
      ) over (partition by lab_organization_id, barcode) as barcode_count
      from candidates
    )
    select count(*)::integer as "totalCases",
      count(*) filter (
        where status not in (${TERMINAL_STATUSES})
          and due_day = ${localDate}::date
          and case when due_time ~ '^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$'
            then due_time::time >= ${localTime}::time else true end
      )::integer as "dueToday",
      count(*) filter (
        where status not in (${TERMINAL_STATUSES}) and barcode_count > 1
      )::integer as conflicts,
      count(*) filter (where priority = 'rush')::integer as "rushCases",
      count(*) filter (where status in (${PROCESSING_STATUSES}))::integer as "processingCases",
      count(*) filter (where status in (${IN_TRANSIT_STATUSES}))::integer as "inTransitCases",
      count(*) filter (where status in (${COMPLETED_STATUSES}))::integer as "completedCases",
      count(*) filter (
        where status not in (${TERMINAL_STATUSES})
          and due_day < ${localDate}::date
      )::integer as "overdueCases",
      count(*) filter (where status in (${RECEIVED_STATUSES}))::integer as "receivedCases",
      count(*) filter (where status in (${IN_DESIGN_STATUSES}))::integer as "inDesignCases",
      count(*) filter (where status in (${MODEL_ROOM_STATUSES}))::integer as "modelRoomCases",
      count(*) filter (where status in (${SHIPPED_STATUSES}))::integer as "shippedCases",
      count(*) filter (where status in (${SCAN_STATUSES}))::integer as "scanCases",
      count(*) filter (where status in (${MILLING_STATUSES}))::integer as "millingCases",
      count(*) filter (where status in (${POST_MILL_STATUSES}))::integer as "postMillCases",
      count(*) filter (where status in (${SINTERING_FURNACE_STATUSES}))::integer as "sinteringFurnaceCases",
      count(*) filter (where status in (${PORCELAIN_STATUSES}))::integer as "porcelainCases",
      count(*) filter (where status in (${QUALITY_CHECK_STATUSES}))::integer as "qualityCheckCases",
      count(*) filter (where status in (${ON_HOLD_STATUSES}))::integer as "onHoldCases",
      count(*) filter (where status in (${REMAKE_STATUSES}))::integer as "remakeCases"
    from conflicts
  `);
  return result.rows[0] as {
    totalCases: number;
    dueToday: number;
    conflicts: number;
    rushCases: number;
    processingCases: number;
    inTransitCases: number;
    completedCases: number;
    overdueCases: number;
    receivedCases: number;
    inDesignCases: number;
    modelRoomCases: number;
    shippedCases: number;
    scanCases: number;
    millingCases: number;
    postMillCases: number;
    sinteringFurnaceCases: number;
    porcelainCases: number;
    qualityCheckCases: number;
    onHoldCases: number;
    remakeCases: number;
  };
}
