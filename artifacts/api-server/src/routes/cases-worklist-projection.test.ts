/**
 * Legacy-case list projection: parity and query-shape guard (Task #4371).
 *
 * Legacy (mobile) cases live in `lab_cases` as one JSON text blob per row,
 * routinely megabytes because photos are embedded as base64. Both case lists
 * used to derive every displayed legacy value straight out of that blob, for
 * every row in the caller's labs, before pagination — which is why opening
 * Cases took seconds. They now read projected columns maintained by the
 * `lab_cases` trigger, and fall back to the blob only for a row the trigger
 * has not reached yet.
 *
 * Two things have to stay true, and both are checked here:
 *
 *  1. Parity — a projected row and an unprojected one must produce exactly
 *     the same API output, including for the awkward blobs (malformed,
 *     multi-megabyte, JSON null, uncharged remake, restorations array). The
 *     tests below capture each endpoint's response, strip the projection off
 *     the same rows, and require the response to be unchanged.
 *
 *  2. Shape — candidate selection must not read `case_data` again. This is
 *     asserted against the generated SQL rather than a wall-clock threshold,
 *     so it fails deterministically the moment the blob creeps back into the
 *     hot path.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 * Self-contained: all inserted rows are removed in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";
import {
  legacyWorklistCandidateSql,
  unprojectedLegacyProbeSql,
} from "../lib/legacy-case-list";
import {
  ensureLabCaseProjection,
  LAB_CASE_PROJECTION_VERSION,
} from "../lib/lab-case-projection";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-projection"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

describe("legacy worklist candidate SQL shape", () => {
  const serialize = (chunk: ReturnType<typeof legacyWorklistCandidateSql>) =>
    new PgDialect().sqlToQuery(chunk).sql;

  it("never reads case_data when selecting projected candidates", () => {
    const projected = serialize(
      legacyWorklistCandidateSql({
        organizationIds: ["org_a", "org_b"],
        mode: "projected",
        search: "ada",
      }),
    );
    // The whole point of the change: candidate selection, filtering, sorting,
    // conflict detection and the sales total all run off indexed columns.
    expect(projected).not.toContain("case_data");
    expect(projected).toContain("projected_case_number");
    expect(projected).toContain("projected_search_document");
    expect(projected).toContain("projected_total_price");
  });

  it("keeps the blob-parsing branch available for rows the trigger has not reached", () => {
    // Sentinel: proves the assertion above is meaningful rather than matching
    // a string that no longer exists anywhere in the builder.
    const unprojected = serialize(
      legacyWorklistCandidateSql({ organizationIds: ["org_a"], mode: "unprojected" }),
    );
    expect(unprojected).toContain("case_data");
  });

  it("decides whether the fallback branch is needed without reading case_data", () => {
    const probe = new PgDialect().sqlToQuery(unprojectedLegacyProbeSql(["org_a"])).sql;
    expect(probe).not.toContain("case_data");
    expect(probe).toContain("projection_version");
  });
});

maybe("legacy case lists — projected rows match blob-parsed rows", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const planOtherOrgId = rid("lab_plan_other");
  const userId = rid("uproj");
  const normalCaseId = rid("lnormal");
  const remakeCaseId = rid("lremake");
  const dentureCaseId = rid("ldenture");
  const malformedCaseId = rid("lbroken");
  const jsonNullCaseId = rid("lnull");
  const hugeCaseId = rid("lhuge");
  let token = "";

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return t;
  }

  const ourIds = new Set([
    normalCaseId,
    remakeCaseId,
    dentureCaseId,
    malformedCaseId,
    jsonNullCaseId,
    hugeCaseId,
  ]);

  async function fetchWorklist(query = ""): Promise<any> {
    const res = await request(appMod.default)
      .get(`/api/cases/worklist?organizationId=${labOrgId}${query}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const data = res.body.data ?? {};
    return {
      rows: (data.rows ?? []).filter((row: any) => ourIds.has(row.id)),
      total: data.total,
      salesTotal: data.salesTotal,
    };
  }

  async function fetchArrayList(): Promise<any[]> {
    const res = await request(appMod.default)
      .get(`/api/cases?organizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return ((res.body.data ?? []) as any[])
      .filter((row) => ourIds.has(row.id))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /** The projected columns of our fixture rows, ordered for comparison. */
  async function readProjection(): Promise<any[]> {
    const { db } = dbMod as any;
    const result = await db.execute(sql`
      select id, projection_version, projected_case_number, projected_patient_first_name,
        projected_patient_last_name, projected_doctor_name, projected_search_document,
        projected_status, projected_priority,
        projected_barcode, projected_due_date, projected_created_at, projected_total_price,
        projected_category, projected_taxonomy_type, projected_summary
      from lab_cases where organization_id = ${labOrgId} order by id
    `);
    return (result.rows ?? result) as any[];
  }

  /**
   * Make our fixture rows look like rows written before the trigger existed.
   * An ordinary UPDATE cannot do this — the trigger would immediately
   * re-project them (which is the self-healing property the list relies on),
   * so the trigger is disabled for the duration of the statement.
   */
  async function stripProjection(): Promise<void> {
    const { db } = dbMod as any;
    await db.execute(sql`alter table lab_cases disable trigger lab_cases_project_list_fields_trg`);
    try {
      await db.execute(sql`
        update lab_cases set projection_version = null, projected_case_number = null,
          projected_patient_first_name = null, projected_patient_last_name = null,
          projected_doctor_name = null, projected_search_document = null,
          projected_status = null, projected_priority = null,
          projected_barcode = null, projected_due_date = null, projected_created_at = null,
          projected_total_price = null, projected_category = null, projected_taxonomy_type = null,
          projected_summary = null
        where organization_id = ${labOrgId}
      `);
    } finally {
      await db.execute(sql`alter table lab_cases enable trigger lab_cases_project_list_fields_trg`);
    }
  }

  /** Re-run the trigger over our fixture rows the way the backfill does. */
  async function reprojectFixtures(): Promise<void> {
    const { db } = dbMod as any;
    await db.execute(sql`
      update lab_cases set updated_at = updated_at where organization_id = ${labOrgId}
    `);
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-projection"), { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-projection";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    // The suite exercises the trigger directly, so install it up front rather
    // than relying on the server's background startup task having run.
    await ensureLabCaseProjection();

    const { db, users, organizations, organizationMemberships, labCases } = dbMod as any;

    await db.insert(users).values([{ id: userId, username: `proj_${userId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Projection Test Lab" },
      { id: planOtherOrgId, type: "lab", name: "Projection Plan Other Lab" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId, role: "admin", status: "active" },
    ]);

    const base = {
      patientName: "Ada Lovelace",
      doctorName: "Dr. Babbage",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
      createdAt: Date.parse("2026-06-01T09:00:00.000Z"),
      updatedAt: Date.parse("2026-06-02T09:00:00.000Z"),
    };

    await db.insert(labCases).values([
      {
        id: normalCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-02T09:00:00.000Z"),
        caseData: JSON.stringify({
          ...base,
          id: normalCaseId,
          caseNumber: "26-PROJ-1",
          isRush: true,
          dueDate: "2026-07-01T00:00:00.000Z",
          price: "450.50",
          assignedBarcode: "PROJ-BC-1",
          caseType: "Crown",
          material: "Zirconia",
          step: "Design",
          toothIndices: "3, 4",
          restorations: [
            { restorationType: "Crown", material: "Zirconia", restorationSubtype: "restorative/crown", toothNumber: "3" },
            { restorationType: "Missing", material: "", restorationSubtype: "", toothNumber: "4" },
          ],
        }),
      },
      {
        // An uncharged remake prices as no-charge, in both paths.
        id: remakeCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-03T09:00:00.000Z"),
        caseData: JSON.stringify({
          ...base,
          id: remakeCaseId,
          caseNumber: "26-PROJ-2",
          price: "900.00",
          remakeOfCaseId: normalCaseId,
          remakeCharged: false,
          caseType: "Bridge",
          material: "PFM",
          status: "QC_CHECK",
        }),
      },
      {
        id: dentureCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-04T09:00:00.000Z"),
        caseData: JSON.stringify({
          ...base,
          id: dentureCaseId,
          caseNumber: "26-PROJ-3",
          caseType: "Denture",
          material: "Valplast",
          price: 120,
          patientName: "Grace",
        }),
      },
      {
        // Historical rows can be malformed; neither path may throw on them.
        id: malformedCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-05T09:00:00.000Z"),
        caseData: '{"caseNumber": "26-PROJ-4", "patientName": "Broken Row", "status": "DESIGN"',
      },
      {
        // Parses, but to JSON null — property access on it used to throw.
        id: jsonNullCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-06T09:00:00.000Z"),
        caseData: "null",
      },
      {
        // The shape that made the list slow: a multi-megabyte blob whose
        // useful content is a few short strings.
        id: hugeCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-07T09:00:00.000Z"),
        caseData: JSON.stringify({
          ...base,
          id: hugeCaseId,
          caseNumber: "26-PROJ-5",
          caseType: "Crown",
          material: "Zirconia",
          price: "75.25",
          assignedBarcode: "PROJ-BC-1",
          photos: [randomBytes(1_500_000).toString("base64")],
        }),
      },
    ]);

    token = await makeSession(userId);
  }, 120_000);

  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users, organizations, organizationMemberships, labCases, userSessions } =
      dbMod as any;
    // Never leave the trigger disabled for other suites, whatever failed.
    await db
      .execute(sql`alter table lab_cases enable trigger lab_cases_project_list_fields_trg`)
      .catch(() => {});
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, planOtherOrgId]),
    );
    await db.delete(users).where(eq(users.id, userId));
  });

  it("projects every fixture row on insert, including the malformed one", async () => {
    const projected = await readProjection();
    expect(projected).toHaveLength(6);
    for (const row of projected) {
      expect(row.projection_version).toBe(LAB_CASE_PROJECTION_VERSION);
    }
    const byId = new Map(projected.map((row) => [row.id, row]));
    const normal = byId.get(normalCaseId)!;
    expect(normal.projected_case_number).toBe("26-PROJ-1");
    expect(normal.projected_patient_first_name).toBe("Ada");
    expect(normal.projected_patient_last_name).toBe("Lovelace");
    expect(normal.projected_doctor_name).toBe("Dr. Babbage");
    expect(normal.projected_search_document).toBe(
      "26-proj-1 ada lovelace dr. babbage proj-bc-1",
    );
    expect(normal.projected_status).toBe("received");
    expect(normal.projected_priority).toBe("rush");
    expect(normal.projected_barcode).toBe("PROJ-BC-1");
    expect(Number(normal.projected_total_price)).toBe(450.5);
    expect(normal.projected_category).toBe("zirconia");
    expect(normal.projected_taxonomy_type).toBe("restorative");
    // The summary keeps the display extras and drops everything else.
    expect(normal.projected_summary.d.caseNumber).toBe("26-PROJ-1");
    expect(normal.projected_summary.d.restorations).toHaveLength(2);

    // An uncharged remake is no-charge even though the blob names a price.
    expect(Number(byId.get(remakeCaseId)!.projected_total_price)).toBe(0);
    expect(byId.get(remakeCaseId)!.projected_status).toBe("qc");
    expect(byId.get(dentureCaseId)!.projected_taxonomy_type).toBe("removable");

    // A blob PostgreSQL cannot parse still gets its regex-derived scalars,
    // and a null summary tells the list to parse that row itself.
    const malformed = byId.get(malformedCaseId)!;
    expect(malformed.projected_case_number).toBe("26-PROJ-4");
    expect(malformed.projected_search_document).toContain("broken row");
    expect(malformed.projected_summary).toBeNull();

    // The huge blob is projected down to short values; the photos stay put.
    expect(byId.get(hugeCaseId)!.projected_case_number).toBe("26-PROJ-5");
    expect(JSON.stringify(byId.get(hugeCaseId)!.projected_summary).length).toBeLessThan(2_000);
  }, 60_000);

  it("does not recreate the unsupported projected trigram index", async () => {
    const { db } = dbMod as any;
    const readIndexOid = async () => {
      const result = await db.execute(sql`
        select oid::text as oid
        from pg_class
        where relkind = 'i'
          and relname = 'lab_cases_projected_search_trgm_idx'
      `);
      return String((result.rows ?? result)[0]?.oid ?? "");
    };

    const before = await readIndexOid();
    expect(before).toBe("");
    await ensureLabCaseProjection();
    await ensureLabCaseProjection();
    expect(await readIndexOid()).toBe("");
  }, 60_000);

  it("does not let an older server replace newer projection rules", async () => {
    const { pool } = dbMod as any;
    const newerVersion = LAB_CASE_PROJECTION_VERSION + 1_000;
    const marker = `newer-projection-${newerVersion}`;
    const newerSetupSql = `
      COMMENT ON FUNCTION lab_cases_project_list_fields() IS '${marker}';
    `;
    const olderSetupSql = `
      COMMENT ON FUNCTION lab_cases_project_list_fields() IS 'older-projection';
    `;

    try {
      expect(
        await ensureLabCaseProjection({
          version: newerVersion,
          setupSql: newerSetupSql,
        }),
      ).toBe(true);
      expect(
        await ensureLabCaseProjection({
          version: LAB_CASE_PROJECTION_VERSION,
          setupSql: olderSetupSql,
        }),
      ).toBe(false);

      const comment = await pool.query(
        `SELECT obj_description('lab_cases_project_list_fields()'::regprocedure, 'pg_proc') AS value`,
      );
      expect(comment.rows[0]?.value).toBe(marker);
    } finally {
      await pool.query(
        `UPDATE lab_case_projection_installation SET version = $1 WHERE singleton = true`,
        [LAB_CASE_PROJECTION_VERSION],
      );
      await pool.query(
        `COMMENT ON FUNCTION lab_cases_project_list_fields() IS NULL`,
      );
    }
  }, 60_000);

  it("returns identical worklist rows, totals and sales total without the projection", async () => {
    const withProjection = await fetchWorklist();
    expect(withProjection.rows.length).toBe(6);
    const overviewUrl = `/api/cases/overview?organizationId=${labOrgId}&localDate=2026-07-01&localTime=09:00`;
    const overviewProjected = await request(appMod.default).get(overviewUrl).set("Authorization", `Bearer ${token}`);
    expect(overviewProjected.status).toBe(200);
    expect(overviewProjected.body.data.totalCases).toBe(6);

    await stripProjection();
    try {
      const withoutProjection = await fetchWorklist();
      expect(withoutProjection).toEqual(withProjection);
      const overviewFallback = await request(appMod.default).get(overviewUrl).set("Authorization", `Bearer ${token}`);
      expect(overviewFallback.status).toBe(200);
      expect(overviewFallback.body.data).toEqual(overviewProjected.body.data);
    } finally {
      await reprojectFixtures();
    }
  }, 120_000);

  it("returns identical worklist results for search, filters and sorting", async () => {
    const queries = [
      "&search=lovelace",
      "&search=26-proj-1",
      "&search=babbage",
      "&search=PROJ-BC-1",
      "&status=qc",
      "&priority=rush",
      "&category=zirconia",
      "&taxonomyType=removable",
      "&sortKey=caseNumber&sortDir=asc",
      "&sortKey=totalPrice&sortDir=desc",
      "&sortKey=dueDate&sortDir=asc",
    ];
    const projected = [];
    for (const query of queries) projected.push(await fetchWorklist(query));

    await stripProjection();
    try {
      for (const [index, query] of queries.entries()) {
        expect(await fetchWorklist(query), `query ${query}`).toEqual(projected[index]);
      }
      // Search may return one member of a duplicate-barcode pair; the conflict
      // flag is still based on all active cases in the lab, not only the result.
      expect(projected[1].rows.some((row: any) => row.hasBarcodeConflict)).toBe(true);
    } finally {
      await reprojectFixtures();
    }
  }, 180_000);

  it("marks duplicate barcodes when matching cases land on separate pages", async () => {
    const [firstPage, secondPage] = await Promise.all([
      fetchWorklist("&barcode=PROJ-BC-1&page=1&pageSize=1"),
      fetchWorklist("&barcode=PROJ-BC-1&page=2&pageSize=1"),
    ]);

    expect(firstPage.total).toBe(2);
    expect(secondPage.total).toBe(2);
    expect(firstPage.rows).toHaveLength(1);
    expect(secondPage.rows).toHaveLength(1);
    expect(firstPage.rows[0].id).not.toBe(secondPage.rows[0].id);
    expect(firstPage.rows[0].hasBarcodeConflict).toBe(true);
    expect(secondPage.rows[0].hasBarcodeConflict).toBe(true);
  }, 120_000);

  it("returns identical rows from the shared array endpoint without the projection", async () => {
    const withProjection = await fetchArrayList();
    // The JSON-null and malformed rows are skipped by this endpoint, as before.
    expect(withProjection.map((row) => row.id).sort()).toEqual(
      [normalCaseId, remakeCaseId, dentureCaseId, hugeCaseId].sort(),
    );

    await stripProjection();
    try {
      expect(await fetchArrayList()).toEqual(withProjection);
    } finally {
      await reprojectFixtures();
    }
  }, 120_000);

  it("re-projects a row on its next write, so the table self-heals", async () => {
    const before = await readProjection();
    await stripProjection();
    const stripped = await readProjection();
    expect(stripped.every((row) => row.projection_version === null)).toBe(true);

    // An ordinary touch — what the backfill does, and what any of the ~fifteen
    // legacy write paths do incidentally.
    await reprojectFixtures();
    expect(await readProjection()).toEqual(before);
  }, 60_000);

  it("reflects an edited blob immediately, with no stale projected values", async () => {
    const { db, labCases } = dbMod as any;
    await db
      .update(labCases)
      .set({
        caseData: JSON.stringify({
          id: dentureCaseId,
          caseNumber: "26-PROJ-3-RENAMED",
          patientName: "Grace Hopper",
          doctorName: "Dr. Turing",
          status: "COMPLETE",
          price: "310.00",
          caseType: "Crown",
          material: "Zirconia",
          affiliationKey: `org:${labOrgId}`,
        }),
      })
      .where(eq(labCases.id, dentureCaseId));

    const row = (await readProjection()).find((r) => r.id === dentureCaseId)!;
    expect(row.projection_version).toBe(LAB_CASE_PROJECTION_VERSION);
    expect(row.projected_case_number).toBe("26-PROJ-3-RENAMED");
    expect(row.projected_doctor_name).toBe("Dr. Turing");
    expect(row.projected_search_document).toBe(
      "26-proj-3-renamed grace hopper dr. turing ",
    );
    expect(row.projected_status).toBe("complete");
    expect(Number(row.projected_total_price)).toBe(310);
    expect(row.projected_category).toBe("zirconia");

    const list = await fetchWorklist();
    const listed = list.rows.find((r: any) => r.id === dentureCaseId);
    expect(listed.caseNumber).toBe("26-PROJ-3-RENAMED");
    expect(listed.patientFirstName).toBe("Grace");
    expect(listed.patientLastName).toBe("Hopper");
    expect(listed.doctorName).toBe("Dr. Turing");
    expect(listed.status).toBe("complete");
    expect(listed.totalPrice).toBe("310.00");
  }, 60_000);

  it("uses the tenant index without scanning case blobs for representative-volume search", async () => {
    const { db } = dbMod as any;
    const volumePrefix = rid("plan");
    try {
      await db.execute(sql`
        insert into lab_cases (id, owner_id, organization_id, case_data, updated_at)
        select
          ${volumePrefix} || '_' || n::text,
          ${userId},
          ${labOrgId},
          json_build_object(
            'caseNumber', 'VOLUME-' || n::text,
            'patientName', case when n = 777 then 'Indexed Needle' else 'Volume Patient ' || n::text end,
            'doctorName', 'Dr. Plan',
            'assignedBarcode', 'PLAN-' || n::text
          )::text,
          now()
        from generate_series(1, 10000) n
      `);
      await db.execute(sql`
        insert into lab_cases (id, owner_id, organization_id, case_data, updated_at)
        select
          ${`${volumePrefix}_foreign_`} || n::text,
          ${userId},
          ${planOtherOrgId},
          json_build_object(
            'caseNumber', 'FOREIGN-' || n::text,
            'patientName', case when n = 777 then 'Indexed Needle' else 'Foreign Patient ' || n::text end,
            'doctorName', 'Dr. Foreign Plan',
            'assignedBarcode', 'FOREIGN-PLAN-' || n::text
          )::text,
          now()
        from generate_series(1, 10000) n
      `);
      await db.execute(sql`analyze lab_cases`);

      const explained = await db.execute(sql`
        explain (analyze, buffers, format json)
        select id
        from lab_cases
        where deleted_at is null
          and organization_id = ${labOrgId}
          and projection_version = ${LAB_CASE_PROJECTION_VERSION}
          and projected_search_document like '%indexed needle%'
      `);
      const rows = (explained.rows ?? explained) as Array<Record<string, unknown>>;
      const rawPlan = rows[0]?.["QUERY PLAN"];
      const plan = JSON.stringify(rawPlan);
      expect(plan).toContain("lab_cases_organization_updated_idx");
      expect(plan).not.toContain("case_data");
      const parsedPlan = (rawPlan as Array<{ Plan?: Record<string, unknown> }>)[0]?.Plan;
      expect(parsedPlan?.["Actual Rows"]).toBe(1);
      expect(Number(parsedPlan?.["Shared Hit Blocks"] ?? 0)).toBeLessThan(1_000);

      const result = await db.execute(sql`
        select id
        from lab_cases
        where deleted_at is null
          and organization_id = ${labOrgId}
          and projection_version = ${LAB_CASE_PROJECTION_VERSION}
          and projected_search_document like '%indexed needle%'
      `);
      expect((result.rows ?? result).map((row: any) => row.id)).toEqual([
        `${volumePrefix}_777`,
      ]);
    } finally {
      await db.execute(sql`
        delete from lab_cases where id like ${`${volumePrefix}_%`}
      `);
    }
  }, 120_000);

  it("keeps a soft-deleted legacy case out of both lists", async () => {
    const { db, labCases } = dbMod as any;
    await db
      .update(labCases)
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where(eq(labCases.id, normalCaseId));
    try {
      const worklist = await fetchWorklist();
      expect(worklist.rows.some((row: any) => row.id === normalCaseId)).toBe(false);
      const array = await fetchArrayList();
      expect(array.some((row) => row.id === normalCaseId)).toBe(false);
    } finally {
      await db
        .update(labCases)
        .set({ deletedAt: null, deletedBy: null })
        .where(eq(labCases.id, normalCaseId));
    }
  }, 60_000);
});
