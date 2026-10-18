/**
 * GET /cases/doctor-names over the legacy-case projection (Task #4394).
 *
 * The picker's name list used to be produced by selecting every legacy
 * (mobile) blob in the caller's labs and pulling `doctorName` out of each one
 * in Node — on a large lab, tens of megabytes of JSON for a handful of short
 * strings, and about a second of the Cases page's load. The names now come
 * out of the projection the `lab_cases` trigger maintains, and only the rows
 * that projection cannot answer still have their blob read.
 *
 * Three things have to stay true, and all three are checked here:
 *
 *  1. Parity — the endpoint must return exactly the set of names it returned
 *     before, including for rows the trigger has not reached. The blobs that
 *     make this interesting are the malformed one (its name was never
 *     returned, because `JSON.parse` threw), a name carrying JSON escapes,
 *     and a `doctorName` that is not a string. The parity test captures the
 *     response with the projection present, strips the projection off the
 *     same rows, and requires the response to be unchanged.
 *
 *  2. Shape — the query must not read `case_data` again. Asserted against the
 *     generated SQL rather than a wall-clock threshold, so it fails
 *     deterministically if the blob creeps back into the hot path.
 *
 *  3. One snapshot — the projected names and the leftover blobs come back
 *     from a single statement. As two queries they would run under two READ
 *     COMMITTED snapshots, and a row crossing between the branches in
 *     between (the backfill reaching it, or an edit changing the name's
 *     type) would be answered by neither.
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
import { legacyDoctorNameSql } from "../lib/legacy-case-list";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-doctor-names"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

describe("legacy doctor-name SQL shape", () => {
  const serialized = () =>
    new PgDialect().sqlToQuery(
      legacyDoctorNameSql({ organizationIds: ["org_a", "org_b"] }),
    ).sql;

  /** [names branch, blobs branch] of the single statement. */
  const branches = () => {
    const parts = serialized().split(/\bunion all\b/i);
    // One `union all`: the two branches are one statement, hence one
    // snapshot. Two statements could drop a row that crossed between them.
    expect(parts).toHaveLength(2);
    return parts as [string, string];
  };

  it("never reads case_data when collecting projected names", () => {
    const [names] = branches();
    // The whole point of the change: the picker's list comes out of the
    // projected summary, not out of every blob in the caller's labs.
    expect(names).not.toContain("case_data");
    expect(names).toContain("projected_summary");
    expect(names).toContain("select distinct");
  });

  it("reads blobs only for the rows the projected branch could not answer", () => {
    // Sentinel: proves the assertion above is meaningful rather than matching
    // a string that no longer exists anywhere in the builder, and that the
    // blob branch stays restricted to the complement of the name branch.
    const [, blobs] = branches();
    expect(blobs).toContain("case_data");
    expect(blobs).toContain("projection_version");
    expect(blobs).toMatch(/and not \(/);
  });
});

maybe("GET /cases/doctor-names — projected names match blob-parsed names", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const userId = rid("udocnames");
  const plainCaseId = rid("ldplain");
  const duplicateCaseId = rid("lddup");
  const escapedCaseId = rid("ldesc");
  const unicodeCaseId = rid("lduni");
  const paddedCaseId = rid("ldpad");
  const numericCaseId = rid("ldnum");
  const objectCaseId = rid("ldobj");
  const emptyCaseId = rid("ldempty");
  const malformedCaseId = rid("ldbroken");
  const jsonNullCaseId = rid("ldnull");
  const arrayCaseId = rid("ldarray");
  const hugeCaseId = rid("ldhuge");
  const deletedCaseId = rid("lddel");
  let token = "";

  const PLAIN_NAME = "Dr. Ada Plain";
  const ESCAPED_NAME = 'Dr. "Ace" Quote';
  const UNICODE_NAME = "Dr. Jos\u00e9 Escaped";
  const PADDED_NAME = "Dr. Nbsp Padded";
  const HUGE_NAME = "Dr. Photo Heavy";
  const MALFORMED_NAME = "Dr. Never Parsed";
  const DELETED_NAME = "Dr. Soft Deleted";

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

  async function fetchDoctorNames(): Promise<string[]> {
    const res = await request(appMod.default)
      .get("/api/cases/doctor-names")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.data ?? []) as string[];
  }

  /** Projection state of the fixture rows, for the self-heal assertions. */
  async function readProjectionVersions(): Promise<(number | null)[]> {
    const { db } = dbMod as any;
    const result = await db.execute(sql`
      select projection_version from lab_cases
      where organization_id = ${labOrgId} order by id
    `);
    return ((result.rows ?? result) as any[]).map(
      (row) => row.projection_version as number | null,
    );
  }

  /**
   * Make the fixture rows look like rows written before the trigger existed.
   * An ordinary UPDATE cannot do this — the trigger would re-project them
   * immediately — so it is disabled for the duration of the statement.
   */
  async function stripProjection(): Promise<void> {
    const { db } = dbMod as any;
    await db.execute(sql`alter table lab_cases disable trigger lab_cases_project_list_fields_trg`);
    try {
      await db.execute(sql`
        update lab_cases set projection_version = null, projected_doctor_name = null,
          projected_summary = null
        where organization_id = ${labOrgId}
      `);
    } finally {
      await db.execute(sql`alter table lab_cases enable trigger lab_cases_project_list_fields_trg`);
    }
  }

  /** Re-run the trigger over the fixture rows the way the backfill does. */
  async function reprojectFixtures(): Promise<void> {
    const { db } = dbMod as any;
    await db.execute(sql`
      update lab_cases set updated_at = updated_at where organization_id = ${labOrgId}
    `);
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-doctor-names"), { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-doctor-names";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    // The suite exercises the trigger directly, so install it up front rather
    // than relying on the server's background startup task having run.
    await ensureLabCaseProjection();

    const { db, users, organizations, organizationMemberships, labCases } = dbMod as any;

    await db.insert(users).values([{ id: userId, username: `docnames_${userId}`, password: "x" }]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Doctor Names Test Lab" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId, role: "admin", status: "active" },
    ]);

    const affiliationKey = `org:${labOrgId}`;
    const legacyRow = (id: string, caseData: string) => ({
      id,
      ownerId: userId,
      organizationId: labOrgId,
      updatedAt: new Date("2026-06-02T09:00:00.000Z"),
      caseData,
    });

    await db.insert(labCases).values([
      legacyRow(
        plainCaseId,
        JSON.stringify({ affiliationKey, caseNumber: "26-DN-1", doctorName: PLAIN_NAME }),
      ),
      // Same name on a second row: the list is a set, so it appears once.
      legacyRow(
        duplicateCaseId,
        JSON.stringify({ affiliationKey, caseNumber: "26-DN-2", doctorName: PLAIN_NAME }),
      ),
      // JSON escapes: a regex over the raw text would return the escaped
      // form, so the value has to come from a real parse on both paths.
      legacyRow(
        escapedCaseId,
        JSON.stringify({ affiliationKey, caseNumber: "26-DN-3", doctorName: ESCAPED_NAME }),
      ),
      legacyRow(
        unicodeCaseId,
        `{"affiliationKey":"${affiliationKey}","caseNumber":"26-DN-4","doctorName":"Dr. Jos\\u00e9 Escaped"}`,
      ),
      // Surrounding whitespace (including a non-breaking space) is stripped
      // by the endpoint's own trim, which is JavaScript's, not btrim's.
      legacyRow(
        paddedCaseId,
        JSON.stringify({
          affiliationKey,
          caseNumber: "26-DN-5",
          doctorName: `  ${PADDED_NAME}\u00a0`,
        }),
      ),
      // A non-string name renders differently in SQL (42.50) than in Node
      // (42.5), so rows like this are read the old way.
      legacyRow(
        numericCaseId,
        `{"affiliationKey":"${affiliationKey}","caseNumber":"26-DN-6","doctorName":42.50}`,
      ),
      legacyRow(
        objectCaseId,
        JSON.stringify({
          affiliationKey,
          caseNumber: "26-DN-7",
          doctorName: { first: "Structured" },
        }),
      ),
      legacyRow(
        emptyCaseId,
        JSON.stringify({ affiliationKey, caseNumber: "26-DN-8", doctorName: "   " }),
      ),
      // Historical rows can be malformed. JSON.parse throws on this one, so
      // its name was never listed and still must not be.
      legacyRow(
        malformedCaseId,
        `{"affiliationKey":"${affiliationKey}","caseNumber":"26-DN-9","doctorName":"${MALFORMED_NAME}"`,
      ),
      legacyRow(jsonNullCaseId, "null"),
      legacyRow(arrayCaseId, JSON.stringify([{ doctorName: "Dr. Inside Array" }])),
      // The shape that made this slow: a multi-megabyte blob whose useful
      // content is a few short strings.
      legacyRow(
        hugeCaseId,
        JSON.stringify({
          affiliationKey,
          caseNumber: "26-DN-10",
          doctorName: HUGE_NAME,
          photos: [randomBytes(1_200_000).toString("base64")],
        }),
      ),
      legacyRow(
        deletedCaseId,
        JSON.stringify({ affiliationKey, caseNumber: "26-DN-11", doctorName: DELETED_NAME }),
      ),
    ]);

    await db
      .update(labCases)
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where(eq(labCases.id, deletedCaseId));

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
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("lists every legacy name exactly as the blob parse produced it", async () => {
    expect(await readProjectionVersions()).toEqual(
      new Array(13).fill(LAB_CASE_PROJECTION_VERSION),
    );

    const names = await fetchDoctorNames();
    expect(names).toContain(PLAIN_NAME);
    expect(names.filter((name) => name === PLAIN_NAME)).toHaveLength(1);
    expect(names).toContain(ESCAPED_NAME);
    expect(names).toContain(UNICODE_NAME);
    expect(names).toContain(PADDED_NAME);
    expect(names).toContain(HUGE_NAME);
    // A number is stringified by Node, so "42.50" in the blob lists as 42.5.
    expect(names).toContain("42.5");
    expect(names).not.toContain("42.50");
    // Unchanged oddity, kept deliberately: a structured name has always been
    // listed as whatever String() made of it.
    expect(names).toContain("[object Object]");
    // A blob JSON.parse cannot read contributes nothing, even though its
    // doctor name is plainly visible in the text.
    expect(names).not.toContain(MALFORMED_NAME);
    // Blank names, JSON null, arrays and soft-deleted rows contribute nothing.
    expect(names).not.toContain("");
    expect(names).not.toContain("Dr. Inside Array");
    expect(names).not.toContain(DELETED_NAME);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  }, 60_000);

  it("returns an identical list for rows whose projection has not been computed", async () => {
    const withProjection = await fetchDoctorNames();

    await stripProjection();
    try {
      expect((await readProjectionVersions()).every((v) => v === null)).toBe(true);
      expect(await fetchDoctorNames()).toEqual(withProjection);
    } finally {
      await reprojectFixtures();
    }
    expect(await fetchDoctorNames()).toEqual(withProjection);
  }, 120_000);

  it("reads the legacy rows in one statement, so nothing can cross between branches unseen", async () => {
    const { db } = dbMod as any;
    const dialect = new PgDialect();
    const original = db.execute.bind(db);
    const legacyStatements: string[] = [];
    const spy = vi.spyOn(db, "execute").mockImplementation(((query: unknown) => {
      let text = "";
      try {
        text =
          typeof query === "string" ? query : dialect.sqlToQuery(query as any).sql;
      } catch {
        text = "";
      }
      if (text.includes("lab_cases")) legacyStatements.push(text);
      return original(query);
    }) as any);

    try {
      await fetchDoctorNames();
    } finally {
      spy.mockRestore();
    }

    // One statement means one READ COMMITTED snapshot. Two would let a row
    // the backfill (or an edit) moves between the branches be answered by
    // neither, silently dropping its doctor from the picker.
    expect(legacyStatements).toHaveLength(1);
    expect(legacyStatements[0]).toContain("union all");
  }, 60_000);

  it("never loses a name while a row moves between the projected and blob branches", async () => {
    const { db, labCases } = dbMod as any;
    const churnCaseId = rid("ldchurn");
    const affiliationKey = `org:${labOrgId}`;
    const churnName = "Dr. Churn String";
    // A string name is answered by the projection; a numeric one is not, so
    // rewriting the blob back and forth walks the row across the branches
    // while requests are in flight.
    const asString = JSON.stringify({
      affiliationKey,
      caseNumber: "26-DN-12",
      doctorName: churnName,
    });
    const asNumber = `{"affiliationKey":"${affiliationKey}","caseNumber":"26-DN-12","doctorName":7315}`;

    await db.insert(labCases).values([
      {
        id: churnCaseId,
        ownerId: userId,
        organizationId: labOrgId,
        updatedAt: new Date("2026-06-02T09:00:00.000Z"),
        caseData: asString,
      },
    ]);

    try {
      for (let i = 0; i < 24; i += 1) {
        const flip = db
          .update(labCases)
          .set({ caseData: i % 2 === 0 ? asNumber : asString })
          .where(eq(labCases.id, churnCaseId));
        const [names] = await Promise.all([fetchDoctorNames(), flip]);
        const hasString = names.includes(churnName);
        const hasNumber = names.includes("7315");
        // Whichever side of the edit the request saw, it saw exactly one of
        // them: the row exists in every snapshot, and only once.
        expect(hasString || hasNumber).toBe(true);
        expect(hasString && hasNumber).toBe(false);
      }
    } finally {
      await db.delete(labCases).where(eq(labCases.id, churnCaseId));
    }
  }, 120_000);

  it("never serves a stale name after the blob is edited", async () => {
    const { db, labCases } = dbMod as any;
    const renamed = "Dr. Renamed Later";
    await db
      .update(labCases)
      .set({
        caseData: JSON.stringify({
          affiliationKey: `org:${labOrgId}`,
          caseNumber: "26-DN-1",
          doctorName: renamed,
        }),
      })
      .where(eq(labCases.id, plainCaseId));

    const names = await fetchDoctorNames();
    expect(names).toContain(renamed);
    // The duplicate row still carries the original name, so it stays listed.
    expect(names).toContain(PLAIN_NAME);

    await db.delete(labCases).where(eq(labCases.id, duplicateCaseId));
    expect(await fetchDoctorNames()).not.toContain(PLAIN_NAME);
  }, 60_000);
});
