/**
 * Regression suite: GET /api/cases must expose `receivedAt` on every row.
 *
 * The desktop Cases date-range filter (Today / 30 / 60 / 90 / Custom) matches
 * on the case's received date, falling back to the created date. If the list
 * endpoint ever stops returning `receivedAt`, the filter silently collapses
 * back to created-date behavior and the "Custom today→today shows no cases for
 * legacy/mobile cases" glitch returns. This suite pins that the field is
 * present on BOTH row shapes the endpoint emits:
 *   (1) canonical cases (the `cases` table, which has a real received_at column)
 *   (2) legacy/mobile-projected cases (bridged from `lab_cases`, where the
  *       received date is synthesized from the UTC day of the row's updatedAt).
 *
 * Response envelope: all API routes return { ok: true, data: T } via ok().
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 * Self-contained: all inserted rows are removed in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-received-at"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe("GET /api/cases — receivedAt presence on all row shapes", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const practiceId = rid("prov");
  const userId = rid("urcv");
  const canonicalCaseId = rid("canon");
  const legacyCaseId = rid("legacy");
  let token = "";
  const originalTimezone = process.env.TZ;

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

  async function fetchList(): Promise<any[]> {
    const res = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.data ?? []) as any[];
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-received-at"), {
      recursive: true,
    });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-received-at";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      labCases,
    } = dbMod as any;

    await db.insert(users).values([
      { id: userId, username: `rcv_${userId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Received-At Test Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Received-At Test Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId,
        role: "admin",
        status: "active",
      },
    ]);

    // (1) Canonical case: received today, created weeks earlier. The cases
    // table has a real received_at column (NOT NULL, defaults to now()), so we
    // set it explicitly to prove the value flows through unchanged.
    await db.insert(cases).values({
      id: canonicalCaseId,
      caseNumber: "26-RCV-CANON",
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Canon",
      patientFirstName: "Pat",
      patientLastName: "Canon",
      status: "received",
      createdByUserId: userId,
      receivedAt: "2026-06-29",
      createdAt: new Date("2026-06-01T09:00:00.000Z"),
    });

    // (2) Legacy/mobile case: bridged from lab_cases. No real received_at
    // column — the list endpoint synthesizes receivedAt from the row's
    // updatedAt, falling back to createdAt.
    const caseBlob = {
      id: legacyCaseId,
      caseNumber: "26-RCV-LEGACY",
      patientName: "Pat Legacy",
      doctorName: "Dr. Legacy",
      status: "INTAKE",
      affiliationKey: `org:${labOrgId}`,
      createdAt: Date.parse("2026-06-01T09:00:00.000Z"),
      updatedAt: Date.parse("2026-06-29T11:00:00.000Z"),
    };
    await db.insert(labCases).values({
      id: legacyCaseId,
      ownerId: userId,
      organizationId: labOrgId,
      caseData: JSON.stringify(caseBlob),
      updatedAt: new Date("2026-06-29T11:00:00.000Z"),
    });

    token = await makeSession(userId);
  }, 60_000);

  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    process.env.TZ = originalTimezone;
    if (!SHOULD_RUN) return;
    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases,
      labCases,
      invoices,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(labCases).where(eq(labCases.organizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, practiceId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns receivedAt on the canonical case row", async () => {
    const list = await fetchList();
    const found = list.find((c) => c.id === canonicalCaseId);
    expect(found, "canonical case must appear in GET /api/cases").toBeTruthy();
    expect(found.receivedAt, "canonical row must expose receivedAt").toBeTruthy();
    // The explicit received_at we set is preserved (not overwritten by createdAt).
    expect(found.receivedAt).toBe("2026-06-29");
    // Sanity: received date differs from the (earlier) created date — the exact
    // shape the date-range filter relies on.
    expect(new Date(`${found.receivedAt}T12:00:00.000Z`).getTime()).toBeGreaterThan(
      new Date(found.createdAt).getTime(),
    );
  });

  it("returns a synthesized receivedAt on the legacy/mobile-projected row", async () => {
    const list = await fetchList();
    const found = list.find((c) => c.id === legacyCaseId);
    expect(found, "legacy case must appear in GET /api/cases").toBeTruthy();
    expect(found._source).toBe("mobile");
    expect(found.receivedAt, "legacy row must expose receivedAt").toBeTruthy();
    // Synthesized from the lab_cases row's updatedAt.
    expect(found.receivedAt).toBe("2026-06-29");
  });

  it("exposes receivedAt on every row the endpoint returns", async () => {
    const list = await fetchList();
    const ours = list.filter(
      (c) => c.id === canonicalCaseId || c.id === legacyCaseId,
    );
    expect(ours.length).toBe(2);
    for (const c of ours) {
      expect(c.receivedAt, `row ${c.id} missing receivedAt`).toBeTruthy();
      expect(Number.isNaN(new Date(c.receivedAt).getTime())).toBe(false);
    }
  });

  it.each([
    ["Etc/GMT+12", "UTC-12"],
    ["Pacific/Kiritimati", "UTC+14"],
  ])(
    "keeps API writes and reads on the exact calendar day in %s (%s)",
    async (timezone) => {
      process.env.TZ = timezone;
      const receivedAt = "2026-12-31";

      const response = await request(appMod.default)
        .patch(`/api/cases/${canonicalCaseId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ receivedAt });

      expect(response.status).toBe(200);
      expect(response.body.data.receivedAt).toBe(receivedAt);

      const { db, cases } = dbMod as any;
      const stored = await db.query.cases.findFirst({
        where: eq(cases.id, canonicalCaseId),
        columns: { receivedAt: true },
      });
      expect(stored?.receivedAt).toBe(receivedAt);

      const listed = (await fetchList()).find((c) => c.id === canonicalCaseId);
      expect(listed?.receivedAt).toBe(receivedAt);
      const legacy = (await fetchList()).find((c) => c.id === legacyCaseId);
      expect(legacy?.receivedAt).toBe("2026-06-29");
    },
  );

  it.each([
    ["Etc/GMT+12", "UTC-12"],
    ["Pacific/Kiritimati", "UTC+14"],
  ])(
    "uses the UTC calendar day for database defaults in %s (%s)",
    async (timezone) => {
      const { db, cases } = dbMod as any;
      const id = rid("default_date");
      const expectedUtcDay = new Date().toISOString().slice(0, 10);

      const [stored] = await db.transaction(async (tx: any) => {
        await tx.execute(sql.raw(
          timezone === "Etc/GMT+12"
            ? "SET LOCAL TIME ZONE 'Etc/GMT+12'"
            : "SET LOCAL TIME ZONE 'Pacific/Kiritimati'",
        ));
        return tx
          .insert(cases)
          .values({
            id,
            caseNumber: rid("DEFAULT-DATE"),
            labOrganizationId: labOrgId,
            providerOrganizationId: practiceId,
            doctorName: "Dr. Default",
            patientFirstName: "Date",
            patientLastName: "Default",
            status: "received",
            createdByUserId: userId,
          })
          .returning({ receivedAt: cases.receivedAt });
      });

      expect(stored.receivedAt).toBe(expectedUtcDay);
    },
  );

  it("migrates historical timestamptz values using their UTC calendar day", async () => {
    const { db } = dbMod as any;
    const result = await db.transaction(async (tx: any) => {
      await tx.execute(sql`
        CREATE TEMP TABLE received_date_migration_boundary (
          label text NOT NULL,
          received_at timestamptz NOT NULL
        ) ON COMMIT DROP
      `);
      await tx.execute(sql`
        INSERT INTO received_date_migration_boundary (label, received_at)
        VALUES
          ('utc-minus-12', '2026-01-02T00:30:00-12:00'::timestamptz),
          ('utc-plus-14', '2026-01-02T23:30:00+14:00'::timestamptz)
      `);
      await tx.execute(sql`
        ALTER TABLE received_date_migration_boundary
          ALTER COLUMN received_at TYPE date
          USING ((received_at AT TIME ZONE 'UTC')::date)
      `);
      return tx.execute(sql`
        SELECT label, received_at::text AS received_at
        FROM received_date_migration_boundary
        ORDER BY label
      `);
    });

    expect(result.rows).toEqual([
      { label: "utc-minus-12", received_at: "2026-01-02" },
      { label: "utc-plus-14", received_at: "2026-01-02" },
    ]);
  });

  it.each(["Etc/GMT+12", "Pacific/Kiritimati"])(
    "projects legacy timezone-less timestamps as UTC dates in a %s DB session",
    async (timezone) => {
      const { db } = dbMod as any;
      const result = await db.transaction(async (tx: any) => {
        await tx.execute(
          sql.raw(`SET LOCAL TIME ZONE '${timezone}'`),
        );
        await tx.execute(sql`
          CREATE TEMP TABLE legacy_received_boundary (
            updated_at timestamp without time zone,
            projected_created_at timestamptz
          ) ON COMMIT DROP
        `);
        await tx.execute(sql`
          INSERT INTO legacy_received_boundary
            (updated_at, projected_created_at)
          VALUES
            ('2026-06-29 00:30:00', '2026-06-28T20:00:00Z'),
            (NULL, '2026-06-29T23:30:00Z')
        `);
        return tx.execute(sql`
          SELECT (
            coalesce(
              updated_at AT TIME ZONE 'UTC',
              projected_created_at,
              timestamptz 'epoch'
            ) AT TIME ZONE 'UTC'
          )::date::text AS received_at
          FROM legacy_received_boundary
          ORDER BY updated_at NULLS LAST
        `);
      });

      expect(result.rows).toEqual([
        { received_at: "2026-06-29" },
        { received_at: "2026-06-29" },
      ]);
    },
  );

  it.each(["Etc/GMT+12", "Pacific/Kiritimati"])(
    "promotes a legacy case without shifting its received day in %s",
    async (timezone) => {
      process.env.TZ = timezone;
      const { db, cases } = dbMod as any;
      const id = rid("promoted-date");
      const caseNumber = rid("PROMOTED-DATE");
      const caseData = JSON.stringify({
        caseNumber,
        patientName: "Legacy Boundary",
        status: "INTAKE",
      });

      await db.execute(sql`
        INSERT INTO lab_cases (
          id,
          owner_id,
          organization_id,
          case_data,
          updated_at
        )
        VALUES (
          ${id},
          ${userId},
          ${labOrgId},
          ${caseData},
          timestamp '2026-06-29 00:30:00'
        )
      `);

      const promotedResponse = await request(appMod.default)
        .post(`/api/cases/${id}/restorations`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          toothNumber: "9",
          restorationType: "crown",
          material: "Zirconia",
          quantity: 1,
          unitPrice: 0,
        });
      expect(promotedResponse.status).toBe(201);

      const promoted = await db.query.cases.findFirst({
        where: eq(cases.id, id),
        columns: { receivedAt: true },
      });
      expect(promoted?.receivedAt).toBe("2026-06-29");

      const detail = await request(appMod.default)
        .get(`/api/cases/${id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.receivedAt).toBe("2026-06-29");
    },
  );
});
