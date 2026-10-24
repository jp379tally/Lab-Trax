/**
 * POST /api/admin/database-identity/alert — the scheduled production
 * database identity monitor's alert path.
 *
 * The monitor (scripts/src/monitor-production-data-fingerprint.ts) runs the
 * publish preflight's read-only comparison on a schedule and calls this route
 * when production stops matching the committed fingerprint.
 *
 * Coverage:
 *  - unauthenticated reports are refused
 *  - a report with no failure in it is refused (not a general-purpose mailer)
 *  - a real mismatch is accepted and answered with the delivery the monitor
 *    needs: how many admins were tried, how many actually received it, and
 *    why the rest did not — never an optimistic "alert sent"
 *  - only the protected lab's own active admins are tried: a reachable
 *    platform operator, a deactivated account, or another lab's owner must
 *    not count as having told this lab — and must not be sent its incident
 *  - the route never records the report, so nothing it does can move the
 *    expected values
 *
 * Skipped when DATABASE_URL is not set (shared convention).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(
    require("os").tmpdir(),
    "labtrax-test-media-database-identity",
  ),
  extractMediaFileName: () => null,
}));

// The alert mail function itself is deliberately NOT stubbed here: the route
// has to report what was really delivered, and the shared `sendMail` refuses
// every send under the test runner (`disabled_in_test`), which is the same
// shape as a production mail outage.

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const PLATFORM_ADMIN_SECRET = "database-identity-alert-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

const ENDPOINT = "/api/admin/database-identity/alert";

const FACTS = [
  "scope: protected lab 00000000-0000-4000-8000-000000000234",
  "active cases: 2 (fingerprint 1001)",
  "invoices: 1 (fingerprint 2002)",
  "oldest case created_at: 2026-01-02T09:00:00.000000Z (fingerprint 2026-01-02T09:00:00.000000Z)",
  "matches the development database to the microsecond: no (development fingerprint 2026-01-03T00:00:00.000000Z, recorded 2026-01-04T00:00:00.000Z)",
];

function mismatchReport(overrides: Record<string, unknown> = {}) {
  return {
    source: "data-fingerprint-monitor",
    target: "production",
    checkedAt: "2026-10-06T18:30:00.000Z",
    facts: FACTS,
    findings: [
      {
        level: "failure",
        code: "lineage-mismatch",
        message:
          "the production oldest case created_at (2026-10-01T09:00:00.000001Z) is not the recorded 2026-05-12T15:44:59.587588Z",
      },
    ],
    fingerprintPath: "scripts/database-fingerprint.json",
    recordCommand:
      "pnpm --filter @workspace/scripts run record-production-data-fingerprint",
    ...overrides,
  };
}

maybe("POST /api/admin/database-identity/alert", () => {
  let appMod: { default: import("express").Express };
  let dbMod: any;
  const fixtureUserIds: string[] = [];
  const fixtureLabIds: string[] = [];

  // The first import transforms the whole app; it can exceed the shared 90 s
  // hook budget on a loaded machine, so this one hook gets its own.
  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-database-identity";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    await vi.waitFor(async () => {
      expect((await request(appMod.default).get("/api/__test_missing_route__")).status).toBe(404);
    }, { timeout: 15_000, interval: 25 });
  }, 240_000);

  afterAll(async () => {
    if (!dbMod) return;
    const { db, users, organizations, organizationMemberships } = dbMod;
    // Scoped to the ids this file created, never to a role or a name pattern.
    if (fixtureUserIds.length > 0) {
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, fixtureUserIds));
      await db.delete(users).where(inArray(users.id, fixtureUserIds));
    }
    if (fixtureLabIds.length > 0) {
      await db.delete(organizations).where(inArray(organizations.id, fixtureLabIds));
    }
  });

  /** An admin-role account of the given shape, cleaned up after this file. */
  async function createAdminFixture(fields: {
    userType: string;
    isActive: boolean;
    /** Lab to join, when this account should belong to one. */
    labId?: string;
    /** Role inside that lab. */
    membershipRole?: string;
    membershipStatus?: string;
  }): Promise<void> {
    const { db, users, organizationMemberships } = dbMod;
    const tag = `task4847-${randomBytes(6).toString("hex")}`;
    const [row] = await db
      .insert(users)
      .values({
        username: tag,
        password: "x",
        email: `${tag}@identity-alert.test`,
        role: "admin",
        userType: fields.userType,
        isActive: fields.isActive,
      })
      .returning({ id: users.id });
    fixtureUserIds.push(row.id);

    if (fields.labId) {
      await db.insert(organizationMemberships).values({
        labId: fields.labId,
        userId: row.id,
        role: fields.membershipRole ?? "admin",
        status: fields.membershipStatus ?? "active",
      });
    }
  }

  /** A lab organization, cleaned up after this file. */
  async function createLabFixture(): Promise<string> {
    const { db, organizations } = dbMod;
    const [row] = await db
      .insert(organizations)
      .values({
        type: "lab",
        name: `task4847 lab ${randomBytes(4).toString("hex")}`,
      })
      .returning({ id: organizations.id });
    fixtureLabIds.push(row.id);
    return row.id;
  }

  function report(body: Record<string, unknown>) {
    return request(appMod.default)
      .post(ENDPOINT)
      .set("X-Platform-Admin-Secret", PLATFORM_ADMIN_SECRET)
      .send(body);
  }

  it("refuses a report that does not carry the monitor's secret", async () => {
    const res = await request(appMod.default)
      .post(ENDPOINT)
      .send(mismatchReport());
    expect(res.status).toBe(401);
  });

  it("refuses a report with no failure in it", async () => {
    const res = await report(
      mismatchReport({
        findings: [
          { level: "warning", message: "no development fingerprint recorded" },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one failure/);
  });

  it("refuses a report that cannot say what production looked like", async () => {
    const res = await report(mismatchReport({ facts: [] }));
    expect(res.status).toBe(400);
  });

  it("answers with what was delivered, not with what was attempted", async () => {
    const res = await report(mismatchReport());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.attempted).toBe("number");

    // Mail is refused for every address under the test runner, so this run
    // is a mismatch nobody was told about. The route must say so: a claimed
    // `alertSent: true` here is the failure mode the monitor cannot detect
    // on its own.
    expect(res.body.recipients).toBe(0);
    expect(res.body.alertSent).toBe(false);
    if (res.body.attempted > 0) {
      expect(res.body.failureReasons).toContain("disabled_in_test");
    }
  });

  it("tries the protected lab's own admins, and nobody else's", async () => {
    const protectedLab = await createLabFixture();
    const unrelatedLab = await createLabFixture();
    const attempted = async () =>
      (await report(mismatchReport({ protectedLabOrganizationId: protectedLab })))
        .body.attempted;

    // The committed fingerprint names one lab. Nothing else in this database
    // is its audience, so a brand-new protected lab starts with nobody to
    // tell — whatever other admins the database happens to hold.
    expect(await attempted()).toBe(0);

    // None of these is an admin of the protected lab: another lab's owner
    // (who would also be reading this lab's incident), a platform operator,
    // a deactivated account, a member who is not an admin, and an admin
    // whose membership was revoked.
    await createAdminFixture({
      userType: "lab",
      isActive: true,
      labId: unrelatedLab,
      membershipRole: "owner",
    });
    await createAdminFixture({ userType: "master_admin", isActive: true });
    await createAdminFixture({
      userType: "lab",
      isActive: false,
      labId: protectedLab,
      membershipRole: "admin",
    });
    await createAdminFixture({
      userType: "lab",
      isActive: true,
      labId: protectedLab,
      membershipRole: "user",
    });
    await createAdminFixture({
      userType: "lab",
      isActive: true,
      labId: protectedLab,
      membershipRole: "admin",
      membershipStatus: "removed",
    });
    expect(await attempted()).toBe(0);

    // The scope is narrow, not broken: the lab's own admins are tried, and
    // its owner counts as one of them.
    await createAdminFixture({
      userType: "lab",
      isActive: true,
      labId: protectedLab,
      membershipRole: "admin",
    });
    await createAdminFixture({
      userType: "lab",
      isActive: true,
      labId: protectedLab,
      membershipRole: "owner",
    });
    expect(await attempted()).toBe(2);
  }, 60_000);

  it("falls back to the database's lab admins when no lab is protected", async () => {
    // A fingerprint with no protected lab protects the whole database, so
    // every active lab admin in it is an intended recipient.
    const res = await report(mismatchReport());
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBeGreaterThan(0);
  }, 60_000);

  it("leaves the committed fingerprint untouched", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const fingerprintPath = path.resolve(
      __dirname,
      "../../../../scripts/database-fingerprint.json",
    );
    // The source-only public repository deliberately excludes the private
    // production fingerprint. Preserve either its bytes or its absence.
    const before = existsSync(fingerprintPath)
      ? readFileSync(fingerprintPath, "utf8")
      : null;

    await report(mismatchReport());

    expect(existsSync(fingerprintPath)).toBe(before !== null);
    if (before !== null) expect(readFileSync(fingerprintPath, "utf8")).toBe(before);
  });
});
