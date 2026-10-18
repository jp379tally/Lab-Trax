/**
 * Read side of the legacy-case list projection (Task #4371).
 *
 * The case lists show legacy (mobile) cases next to canonical ones. Both used
 * to derive every legacy value straight out of `lab_cases.case_data` — the
 * desktop worklist with regex passes in SQL, the shared array endpoint by
 * loading each blob into Node and `JSON.parse`-ing it. With embedded base64
 * photos those blobs run to megabytes, so both paid the cost of the whole
 * blob to produce a handful of short strings.
 *
 * They now read the columns the `lab_cases` projection trigger maintains
 * (see `lib/lab-case-projection.ts`). This module holds the shared pieces:
 * the candidate SQL for the worklist, the enrichment column set, and the row
 * builders — which are the previous inline code moved verbatim, so the rows
 * both endpoints emit are unchanged.
 *
 * A row whose `projection_version` is missing or older than the current rules
 * is read exactly the way it used to be, for that row only. The blob is the
 * source of truth; the projection is a cache of it.
 */

import { sql, type SQL } from "drizzle-orm";
import { labCases } from "@workspace/db";
import { legacyStatusToCanonical } from "./case-status";
import { LAB_CASE_PROJECTION_VERSION } from "./lab-case-projection";

/**
 * Columns the lists read for a legacy case. Deliberately excludes
 * `case_data`: selecting it is what made these queries slow, and it is now
 * fetched only for the rows whose projection is stale.
 */
export const legacyCaseListColumns = {
  id: labCases.id,
  ownerId: labCases.ownerId,
  organizationId: labCases.organizationId,
  updatedAt: sql<string | null>`${labCases.updatedAt}::text`,
  deletedAt: labCases.deletedAt,
  deletedBy: labCases.deletedBy,
  projectionVersion: labCases.projectionVersion,
  projectedSummary: labCases.projectedSummary,
};

/** Blob fetch for the rows that still have to be parsed the old way. */
export const legacyCaseBlobColumns = {
  id: labCases.id,
  caseData: labCases.caseData,
};

export type LegacyCaseListRow = {
  id: string;
  ownerId: string;
  organizationId: string | null;
  updatedAt: Date | string | null;
  projectionVersion: number | null;
  projectedSummary: unknown;
};

/**
 * lab_cases.updated_at is a timestamp without time zone whose historical
 * convention is UTC. Interpret its wall-clock fields as UTC instead of letting
 * the database session or Node process timezone supply an implicit offset.
 */
export function legacyUtcTimestampIso(
  value: Date | string | null | undefined,
): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(
      Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      ),
    ).toISOString();
  }
  const wallClock =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(
      value,
    );
  if (wallClock) {
    const milliseconds = Number(
      (wallClock[7] ?? "").padEnd(3, "0").slice(0, 3),
    );
    return new Date(
      Date.UTC(
        Number(wallClock[1]),
        Number(wallClock[2]) - 1,
        Number(wallClock[3]),
        Number(wallClock[4]),
        Number(wallClock[5]),
        Number(wallClock[6]),
        milliseconds,
      ),
    ).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
/**
 * What the projection says about a legacy row, in the terms the list code
 * used to get from `JSON.parse`.
 *
 * - `ready` — use `parsed` in place of the parsed blob. `objectLike` is false
 *   for a blob that parses to a bare scalar, which the array endpoint skips
 *   and the worklist renders as an empty row.
 * - `json-null` — the blob is the literal `null`; reading a property off it
 *   threw, which the worklist treated as a malformed row.
 * - `unprojected` — no usable projection; parse this row's `case_data`.
 */
export type ResolvedLegacyProjection =
  | { status: "ready"; parsed: Record<string, any>; objectLike: boolean }
  | { status: "json-null" }
  | { status: "unprojected" };

export function resolveLegacyProjection(
  row: Pick<LegacyCaseListRow, "projectionVersion" | "projectedSummary">,
): ResolvedLegacyProjection {
  if (row.projectionVersion !== LAB_CASE_PROJECTION_VERSION) {
    return { status: "unprojected" };
  }
  const summary = row.projectedSummary as
    | { t?: unknown; d?: unknown }
    | null
    | undefined;
  // Null summary = PostgreSQL could not parse the blob as JSON. Node's parser
  // is not identical, so hand the row back to it rather than guess.
  if (!summary || typeof summary !== "object") return { status: "unprojected" };
  const kind = typeof summary.t === "string" ? summary.t : null;
  if (!kind) return { status: "unprojected" };
  if (kind === "null") return { status: "json-null" };
  const parsed =
    summary.d && typeof summary.d === "object"
      ? (summary.d as Record<string, any>)
      : {};
  return { status: "ready", parsed, objectLike: kind === "object" || kind === "array" };
}

/**
 * Candidate rows for the desktop worklist's legacy branch.
 *
 * `projected` reads only projected columns — no reference to `case_data` at
 * all, which is the whole point of the change and is asserted by a
 * query-shape test. `unprojected` is the previous expression set, still
 * applied to rows the trigger has not reached yet; the caller only unions it
 * in when such a row actually exists in scope.
 *
 * Both branches emit the same columns in the same order and select disjoint
 * sets of rows, so together they cover the table exactly once.
 */
export function legacyWorklistCandidateSql(options: {
  organizationIds: string[];
  mode: "projected" | "unprojected";
  search?: string;
}): SQL {
  const orgIds = sql.join(
    options.organizationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const projectedSearch =
    options.mode === "projected" && options.search
      ? sql`and l.projected_search_document like ${`%${options.search.toLowerCase()}%`}`
      : sql``;
  const scope = sql`
      from lab_cases l
      where l.deleted_at is null and l.organization_id in (${orgIds})
        and l.projection_version ${
          options.mode === "projected" ? sql`=` : sql`is distinct from`
        } ${LAB_CASE_PROJECTION_VERSION}
        -- A canonical row owns an id even when it is rejected by a worklist
        -- predicate. Without this anti-join, a stale legacy copy could pass
        -- the predicate and reappear after canonical pushdown.
        and not exists (
          select 1 from cases canonical_owner
          where canonical_owner.id = l.id
            and canonical_owner.deleted_at is null
            and (canonical_owner.lab_organization_id in (${orgIds})
              or canonical_owner.provider_organization_id in (${orgIds}))
        )
        ${projectedSearch}`;

  if (options.mode === "projected") {
    // created_at/received_at keep their fallback to the live updated_at
    // column here rather than in the projection, so an updated_at touch can
    // never be served from a stale projected value.
    return sql`
      select l.id, 1 as source_rank, 'legacy'::text as source,
        l.organization_id as lab_organization_id, null::varchar as provider_organization_id,
        coalesce(l.projected_case_number, '') as case_number,
        coalesce(l.projected_patient_first_name, '') as patient_first_name,
        coalesce(l.projected_patient_last_name, '') as patient_last_name,
        coalesce(l.projected_doctor_name, '') as doctor_name,
        coalesce(l.projected_status, 'received') as status,
        coalesce(l.projected_priority, 'normal') as priority,
        l.projected_barcode as barcode,
        coalesce(l.projected_created_at, l.updated_at AT TIME ZONE 'UTC',
          timestamptz 'epoch') as created_at,
        (coalesce(l.updated_at AT TIME ZONE 'UTC', l.projected_created_at,
          timestamptz 'epoch')
          AT TIME ZONE 'UTC')::date as received_at,
        l.projected_due_date as due_date,
        coalesce(l.projected_total_price, 0) as total_price,
        coalesce(l.projected_category, 'uncategorized') as category,
        l.projected_taxonomy_type as taxonomy_type
      ${scope}`;
  }

  // case_data is intentionally never cast to json/jsonb.  Historical rows can
  // be malformed, so guarded regex extraction is used throughout.
  return sql`
      select l.id, 1 as source_rank, 'legacy'::text as source,
        l.organization_id as lab_organization_id, null::varchar as provider_organization_id,
        coalesce(substring(l.case_data from '"caseNumber"[[:space:]]*:[[:space:]]*"([^"]*)"'), '') as case_number,
        split_part(coalesce(substring(l.case_data from '"patientName"[[:space:]]*:[[:space:]]*"([^"]*)"'), ''), ' ', 1) as patient_first_name,
        regexp_replace(coalesce(substring(l.case_data from '"patientName"[[:space:]]*:[[:space:]]*"([^"]*)"'), ''), '^[^ ]+[ ]*', '') as patient_last_name,
        coalesce(substring(l.case_data from '"doctorName"[[:space:]]*:[[:space:]]*"([^"]*)"'), '') as doctor_name,
        case upper(coalesce(substring(l.case_data from '"status"[[:space:]]*:[[:space:]]*"([^"]*)"'), ''))
          when 'INTAKE' then 'received' when 'DESIGN' then 'in_design' when 'MILLING' then 'in_milling'
          when 'PORCELAIN' then 'in_porcelain' when 'QC_CHECK' then 'qc' when 'QC' then 'qc'
          when 'COMPLETE' then 'complete' when 'DELIVERY' then 'shipped' when 'SHIP' then 'shipped'
          when 'DELIVERED' then 'delivered'
          when 'ON_HOLD' then 'on_hold' when 'HOLD' then 'on_hold' when 'REMAKE' then 'remake'
          when 'CANCELLED' then 'cancelled' when 'SCAN' then 'scan' when 'POST_MILL' then 'post_mill'
          when 'SINTERING_FURNACE' then 'sintering_furnace' when 'MODEL_ROOM' then 'model_room'
          else 'received' end as status,
        case when lower(coalesce(substring(l.case_data from '"isRush"[[:space:]]*:[[:space:]]*(true|false)'), 'false')) = 'true'
          then 'rush' else 'normal' end as priority,
        substring(l.case_data from '"assignedBarcode"[[:space:]]*:[[:space:]]*"([^"]*)"') as barcode,
        coalesce(
          case when substring(l.case_data from '"createdAt"[[:space:]]*:[[:space:]]*([0-9]+)') ~ '^[0-9]{10,13}$'
            then to_timestamp((substring(l.case_data from '"createdAt"[[:space:]]*:[[:space:]]*([0-9]+)'))::double precision / 1000.0) end,
          l.updated_at AT TIME ZONE 'UTC', timestamptz 'epoch') as created_at,
        (coalesce(l.updated_at AT TIME ZONE 'UTC',
          case when substring(l.case_data from '"createdAt"[[:space:]]*:[[:space:]]*([0-9]+)') ~ '^[0-9]{10,13}$'
            then to_timestamp((substring(l.case_data from '"createdAt"[[:space:]]*:[[:space:]]*([0-9]+)'))::double precision / 1000.0) end,
          timestamptz 'epoch') AT TIME ZONE 'UTC')::date as received_at,
        case
          when pg_input_is_valid(
            substring(l.case_data from '"dueDate"[[:space:]]*:[[:space:]]*"([^"]*)"'),
            'timestamp with time zone'
          )
          then substring(l.case_data from '"dueDate"[[:space:]]*:[[:space:]]*"([^"]*)"')::timestamptz
        end as due_date,
        case
          when l.case_data ~ '"remakeOfCaseId"[[:space:]]*:[[:space:]]*"[^"]+"'
            and lower(coalesce(substring(l.case_data from '"remakeCharged"[[:space:]]*:[[:space:]]*(true|false)'), '')) = 'false'
          then 0
          else coalesce(nullif(substring(l.case_data from '"price"[[:space:]]*:[[:space:]]*"?([0-9]+(?:[.][0-9]+)?)"?'), '')::numeric, 0)
        end as total_price,
        case
          when lower(l.case_data) ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]*(implant|abutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x))' then 'implants'
          when lower(l.case_data) ~ '"material"[[:space:]]*:[[:space:]]*"[^"]*(zirconia|bruxzir|brux|zirc|pfz)' then 'zirconia'
          when lower(l.case_data) ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]*(crown|bridge|veneer|inlay|onlay|maryland|pontic|coping|lithium disilicate|pfm|gold|full cast|cast metal|semi precious)' then 'crown_bridge'
          when lower(l.case_data) ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]*(denture|partial|flipper|flexible|valplast|removable)' then 'removable'
          when lower(l.case_data) ~ '"(casetype|restorationtype|material)"[[:space:]]*:[[:space:]]*"[^"]+"' then 'other'
          else 'uncategorized' end as category,
        case
          when lower(coalesce(substring(l.case_data from '"caseType"[[:space:]]*:[[:space:]]*"([^"]*)"'), ''))
            in ('restorative', 'removable', 'ortho')
            then lower(substring(l.case_data from '"caseType"[[:space:]]*:[[:space:]]*"([^"]*)"'))
          when lower(l.case_data) ~ '(denture|partial|flipper|flexible|valplast|removable)' then 'removable'
          when lower(l.case_data) ~ '(night.?guard|retainer|splint|bleach.?tray|hawley|space.?maintainer|ortho|appliance)' then 'ortho'
          when lower(l.case_data) ~ '"(casetype|restorationtype|material|restorationsubtype)"[[:space:]]*:[[:space:]]*"[^"]+"' then 'restorative'
          else null
        end as taxonomy_type
      ${scope}`;
}

/**
 * Doctor names held by the legacy rows in scope (Task #4394).
 *
 * `/cases/doctor-names` used to select every legacy blob in the caller's labs
 * and pull `doctorName` out of each one in Node — on a large lab, tens of
 * megabytes of JSON read to produce a short list of names. The names now come
 * out of `projected_summary`, which the trigger built with a real JSON parse
 * of the blob, so each value is the one `JSON.parse` produced. That branch
 * never mentions `case_data`, which a query-shape test asserts.
 *
 * The second branch selects the blobs of exactly the rows the first could
 * not answer, and the caller parses those the old way:
 *
 *   • rows with no projection, or one from an older revision;
 *   • rows with no usable summary — PostgreSQL could not parse the blob (a
 *     malformed row, or one with escapes its parser rejects), and Node's
 *     parser is not identical, so the row goes back to it;
 *   • rows whose `doctorName` is not a JSON string. `->>` renders a number or
 *     object as JSON text, which is not always what `String(value)` produces
 *     in Node, so those rare rows are read the old way too. An absent or
 *     JSON-null `doctorName` needs no fallback: it contributes no name in
 *     either path.
 *
 * The two branches apply complementary predicates over the same scope, so
 * together they cover every row exactly once. They are one statement, and
 * deliberately so: as separate queries they would run under separate READ
 * COMMITTED snapshots, and a row that crossed between the branches in
 * between — the backfill reaching it, or an edit changing the `doctorName`'s
 * type — would be answered by neither, silently dropping its name from the
 * picker. Each row is tagged `name` or `blob` so the caller can tell the two
 * apart. The names are returned untrimmed and undeduplicated across
 * branches — the caller still applies the exact trim and set semantics it
 * always has.
 */
export function legacyDoctorNameSql(options: {
  organizationIds: string[];
}): SQL {
  const orgIds = sql.join(
    options.organizationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const scope = sql`
      from lab_cases l
      where l.deleted_at is null and l.organization_id in (${orgIds})`;

  // The SQL form of `resolveLegacyProjection` returning "ready", narrowed to
  // the `doctorName` values whose text rendering matches Node's.
  const answeredByProjection = sql`(
        l.projection_version is not distinct from ${LAB_CASE_PROJECTION_VERSION}
        and l.projected_summary is not null
        and jsonb_typeof(l.projected_summary) = 'object'
        and coalesce(l.projected_summary ->> 't', '') <> ''
        and coalesce(jsonb_typeof(l.projected_summary -> 'd' -> 'doctorName'), 'null')
          in ('string', 'null')
      )`;

  return sql`
      select 'name'::text as kind, p.doctor_name as value
      from (
        select distinct l.projected_summary -> 'd' ->> 'doctorName' as doctor_name
        ${scope}
          and ${answeredByProjection}
          and jsonb_typeof(l.projected_summary -> 'd' -> 'doctorName') = 'string'
      ) p
      union all
      select 'blob'::text as kind, l.case_data as value
      ${scope}
        and not ${answeredByProjection}`;
}

/** Does this tenant still hold legacy rows the trigger has not reached? */
export function unprojectedLegacyProbeSql(organizationIds: string[]): SQL {
  const orgIds = sql.join(
    organizationIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`
    select 1 from lab_cases l
    where l.deleted_at is null
      and l.organization_id in (${orgIds})
      and l.projection_version is distinct from ${LAB_CASE_PROJECTION_VERSION}
    limit 1`;
}

/**
 * Worklist row for a legacy case. Moved verbatim from the enrichment loop;
 * `parsed` is either the projected summary or a freshly parsed blob.
 */
export function buildWorklistLegacyRow(
  row: LegacyCaseListRow,
  parsed: Record<string, any>,
  projectedPrice: string | undefined,
): Record<string, any> {
  const legacyRestorations = Array.isArray(parsed.restorations) ? parsed.restorations : [];
  const billable = legacyRestorations.filter((item: any) => !/^missing$/i.test(String(item?.restorationType ?? "")));
  const patientName = String(parsed.patientName ?? "");
  const split = patientName.indexOf(" ");
  const legacyUpdatedAt = legacyUtcTimestampIso(row.updatedAt);
  const createdAt = parsed.createdAt && !Number.isNaN(new Date(Number(parsed.createdAt)).getTime())
    ? new Date(Number(parsed.createdAt)).toISOString()
    : legacyUpdatedAt ?? new Date(0).toISOString();
  return {
    id: row.id, caseNumber: String(parsed.caseNumber ?? ""), labOrganizationId: row.organizationId ?? null,
    providerOrganizationId: null, patientFirstName: split < 0 ? patientName : patientName.slice(0, split),
    patientLastName: split < 0 ? "" : patientName.slice(split + 1), doctorName: String(parsed.doctorName ?? ""),
    status: legacyStatusToCanonical(parsed.status), priority: parsed.isRush ? "rush" : "normal",
    dueDate: parsed.dueDate ?? null, createdByUserId: row.ownerId, createdAt,
    updatedAt: legacyUpdatedAt ?? createdAt,
    receivedAt: legacyUtcCalendarDate(row.updatedAt) ?? createdAt.slice(0, 10),
    restorationCount: billable.length,
    restorationTypes: Array.from(new Set(billable.map((item: any) => item.restorationType).filter(Boolean))).join(", ") || parsed.caseType || null,
    restorationMaterials: Array.from(new Set(billable.map((item: any) => item.material).filter(Boolean))).join(", ") || parsed.material || null,
    firstRestorationSubtype: billable[0]?.restorationSubtype ?? parsed.restorationSubtype ?? null,
    teeth: billable.map((item: any) => item.toothNumber).filter(Boolean).join(", ") || parsed.toothIndices || null,
    step: typeof parsed.step === "string" ? parsed.step : null,
    totalPrice: projectedPrice ?? (parsed.price != null ? String(parsed.price) : "0.00"),
    remakeOfCaseId: typeof parsed.remakeOfCaseId === "string" ? parsed.remakeOfCaseId : null,
    remakeCharged: typeof parsed.remakeCharged === "boolean" ? parsed.remakeCharged : null,
    casePanBarcode: parsed.assignedBarcode ?? null,
    labLocationId: typeof parsed.labLocationId === "string" ? parsed.labLocationId : null,
    _source: "mobile",
  };
}

/**
 * Worklist row for a blob that cannot be read at all.
 *
 * Keep malformed historical rows visible without attempting unsafe JSON
 * operators. Their filter/sort projection was already obtained safely by the
 * candidate CTE.
 */
export function buildWorklistUnreadableLegacyRow(
  row: LegacyCaseListRow,
): Record<string, any> {
  const updatedAt = legacyUtcTimestampIso(row.updatedAt) ?? new Date(0).toISOString();
  return {
    id: row.id,
    caseNumber: "",
    labOrganizationId: row.organizationId ?? null,
    providerOrganizationId: null,
    patientFirstName: "",
    patientLastName: "",
    doctorName: "",
    status: "received",
    priority: "normal",
    dueDate: null,
    createdByUserId: row.ownerId,
    createdAt: updatedAt,
    updatedAt,
    receivedAt: updatedAt.slice(0, 10),
    restorationCount: 0,
    restorationTypes: null,
    restorationMaterials: null,
    firstRestorationSubtype: null,
    teeth: null,
    totalPrice: "0.00",
    casePanBarcode: null,
    labLocationId: null,
    _source: "mobile",
  };
}

/**
 * Row emitted by the shared array endpoint for a legacy case. Moved verbatim
 * from the mobile bridge loop.
 */
export function buildArrayLegacyRow(
  row: LegacyCaseListRow,
  parsed: Record<string, any>,
  options: { paginationActive: boolean },
): Record<string, any> {
  // Legacy/mobile blobs can contain the same restoration details as a
  // canonical case. Project their first billable restoration so compact
  // clients can use one list contract regardless of where a case began.
  const legacyRestorations: Record<string, unknown>[] = Array.isArray(parsed.restorations)
    ? (parsed.restorations as unknown[]).filter(
        (restoration: unknown): restoration is Record<string, unknown> =>
          !!restoration && typeof restoration === "object",
      )
    : [];
  const legacyBillableRestorations = legacyRestorations.filter(
    (restoration) =>
      !/^missing$/i.test(String(restoration.restorationType ?? "")),
  );
  const firstLegacyRestoration = legacyBillableRestorations[0] ?? null;
  const legacyTypes = Array.from(
    new Set(
      legacyBillableRestorations
        .map((restoration) => String(restoration.restorationType ?? "").trim())
        .filter(Boolean),
    ),
  ).join(", ");
  const legacyMaterials = Array.from(
    new Set(
      legacyBillableRestorations
        .map((restoration) => String(restoration.material ?? "").trim())
        .filter(Boolean),
    ),
  ).join(", ");
  const legacyTeeth = legacyBillableRestorations
    .map((restoration) => String(restoration.toothNumber ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const patientName = String(parsed.patientName ?? "");
  const spaceIdx = patientName.indexOf(" ");
  const firstName = spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName;
  const lastName = spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "";
  const desktopStatus = legacyStatusToCanonical(parsed.status);
  const createdAt = parsed.createdAt
    ? new Date(Number(parsed.createdAt)).toISOString()
    : options.paginationActive
      ? legacyUtcTimestampIso(row.updatedAt) ?? new Date(0).toISOString()
      : new Date().toISOString();
  const updatedAt = parsed.updatedAt
    ? new Date(Number(parsed.updatedAt)).toISOString()
    : createdAt;
  // Synthesize a received calendar date for legacy/mobile cases (no real
  // received_at column). Mirror the desktop-promotion path, which uses
  // the row's updatedAt as the received date, and fall back to the
  // created date so the desktop date-range filter never silently drops
  // a case that lacks an explicit received timestamp.
  const receivedAt =
    legacyUtcCalendarDate(row.updatedAt) ?? (updatedAt ?? createdAt).slice(0, 10);
  return {
    id: row.id,
    caseNumber: String(parsed.caseNumber ?? ""),
    labOrganizationId: row.organizationId ?? null,
    providerOrganizationId: null,
    patientFirstName: firstName,
    patientLastName: lastName,
    doctorName: String(parsed.doctorName ?? ""),
    status: desktopStatus,
    priority: parsed.isRush ? "rush" : "normal",
    dueDate: parsed.dueDate ?? null,
    createdByUserId: row.ownerId,
    createdAt,
    updatedAt,
    receivedAt,
    restorationCount: legacyBillableRestorations.length,
    restorationTypes: (legacyTypes || parsed.caseType) ?? null,
    restorationMaterials: (legacyMaterials || parsed.material) ?? null,
    firstRestorationSubtype:
      typeof firstLegacyRestoration?.restorationSubtype === "string"
        ? firstLegacyRestoration.restorationSubtype
        : typeof parsed.restorationSubtype === "string"
          ? parsed.restorationSubtype
          : null,
    teeth: (legacyTeeth || parsed.toothIndices) ?? null,
    step: typeof parsed.step === "string" ? parsed.step : null,
    totalPrice: parsed.price != null ? String(parsed.price) : "0.00",
    casePanBarcode: parsed.assignedBarcode ?? null,
    labLocationId: typeof parsed.labLocationId === "string" && parsed.labLocationId ? parsed.labLocationId : null,
    labLocationName: null,
    _source: "mobile",
  };
}

export function legacyUtcCalendarDate(
  value: Date | string | null | undefined,
): string | null {
  return legacyUtcTimestampIso(value)?.slice(0, 10) ?? null;
}
