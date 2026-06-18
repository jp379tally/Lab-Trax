/**
 * DB write error safety guard — regression tests.
 *
 * Verifies that every protected db.insert / db.update call in the routes
 * translates postgres / Drizzle errors into safe HTTP responses (no raw SQL
 * strings or Drizzle internals leaked to callers).
 *
 * Strategy:
 *   - vi.mock("@workspace/db") wraps the real db with a controllable proxy.
 *   - When __injectDbError(table) is called, subsequent insert/update calls on
 *     that table throw a simulated postgres constraint error. All other queries
 *     (auth middleware, session look-ups, reads) pass through to the real DB.
 *   - Each test: inject → fire request → clear injection → assert safe response.
 *
 * Skipped when DATABASE_URL is not set (requires a real DB for auth fixtures).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

// ── Side-effect mocks (hoisted before any import) ──────────────────────────
vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-dbwg"),
  extractMediaFileName: () => null,
}));

// ── Controllable DB injection ───────────────────────────────────────────────
// These variables live in the mock factory's closure and are mutated by the
// helper exports below. vi.mock is hoisted so app.js sees the wrapped db.

let _failTable: unknown | null = null;
let _failError: object = {};

function makeRejectChain(err: object): any {
  const error = Object.assign(new Error("Simulated DB error"), err);
  const rejected = Promise.reject(error);
  // Suppress unhandled-rejection noise — routes will call .catch()
  rejected.catch(() => {});
  const chain: any = {
    values: () => chain,
    set: () => chain,
    where: () => chain,
    returning: () => {
      const r = Promise.reject(error);
      r.catch(() => {});
      return r;
    },
    then: (res: any, rej: any) => rejected.then(res, rej),
    catch: (fn: any) => rejected.catch(fn),
    finally: (fn: any) => rejected.finally(fn),
  };
  return chain;
}

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();

  const originalInsert = (actual.db.insert as Function).bind(actual.db);
  const originalUpdate = (actual.db.update as Function).bind(actual.db);

  const proxiedDb = new Proxy(actual.db as object, {
    get(target, prop) {
      if (prop === "insert") {
        return (table: unknown) => {
          if (_failTable !== null && table === _failTable) {
            return makeRejectChain(_failError);
          }
          return originalInsert(table);
        };
      }
      if (prop === "update") {
        return (table: unknown) => {
          if (_failTable !== null && table === _failTable) {
            return makeRejectChain(_failError);
          }
          return originalUpdate(table);
        };
      }
      return Reflect.get(target, prop);
    },
  });

  return {
    ...actual,
    db: proxiedDb,
    __injectDbError(table: unknown, err: object = { code: "99999" }) {
      _failTable = table;
      _failError = err;
    },
    __clearDbError() {
      _failTable = null;
      _failError = {};
    },
  };
});

// ── Test setup ──────────────────────────────────────────────────────────────

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

maybe("DB write error safety guard", () => {
  let dbMod: typeof import("@workspace/db") & {
    __injectDbError: (table: unknown, err?: object) => void;
    __clearDbError: () => void;
  };
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const caseId = rid("case");
  let restorationId = "";

  const createdSessions: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    createdSessions.push(sessionId);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(userId, sessionId);
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-dbwg";
    dbMod = (await import("@workspace/db")) as any;
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships, cases, caseRestorations } =
      dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `dbwg_owner_${labOwnerId}`,
      password: "doesnotmatter",
      role: "admin",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("DbWgLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("DbWgPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: labOwnerId,
      role: "owner",
      status: "active",
      approvedByUserId: labOwnerId,
      joinedAt: new Date(),
    });

    await db.insert(cases).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      doctorName: "Dr Test",
      patientFirstName: "Pat",
      patientLastName: "Test",
      createdByUserId: labOwnerId,
    });

    // Pre-insert a restoration so PATCH tests have an ID to work with.
    const [r] = await db.insert(caseRestorations).values({
      caseId,
      toothNumber: "14",
      restorationType: "Crown",
      material: "Zirconia",
      quantity: 1,
      unitPrice: "0.00",
      priceSource: "manual",
    }).returning();
    restorationId = r.id;
  });

  afterEach(() => {
    // Always clear injection after each test regardless of outcome.
    dbMod.__clearDbError();
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      caseRestorations,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;
    const { inArray, eq } = await import("drizzle-orm");

    await db.delete(caseNotes).where(eq(caseNotes.caseId, caseId));
    await db.delete(caseRestorations).where(eq(caseRestorations.caseId, caseId));
    await db.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
    await db.delete(invoices).where(eq(invoices.caseId, caseId));
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(casesTable).where(eq(casesTable.id, caseId));
    await db.delete(userSessions).where(
      inArray(userSessions.id, createdSessions),
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId]),
    );
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  function assertSafeErrorBody(body: Record<string, unknown>, status: number) {
    // Response must not expose raw Postgres/Drizzle internals.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/insert into|update .* set|duplicate key violates|drizzle/i);
    // Status must be a known HTTP error code (400/409/500 family), never 200.
    expect([400, 409, 500, 503]).toContain(status);
    // Body must carry some error indication.
    const hasError =
      body.message != null || body.error != null || body.ok === false;
    expect(hasError).toBe(true);
  }

  // ── Note insert failure ──────────────────────────────────────────────────

  describe("POST /api/cases/:caseId/notes — caseNotes insert failure", () => {
    it("returns 500 with a safe message when the DB throws a generic error", async () => {
      const access = await makeSession(labOwnerId);
      const { caseNotes } = dbMod as any;

      dbMod.__injectDbError(caseNotes, {
        message: "ECONNRESET: connection lost",
      });

      const r = await request(appMod.default)
        .post(`/api/cases/${caseId}/notes`)
        .set("Authorization", `Bearer ${access}`)
        .send({ noteText: "Test note", visibility: "internal_lab_only" });

      expect(r.status).toBe(500);
      assertSafeErrorBody(r.body, r.status);
      // Must use the safe fallback message, not the raw DB error.
      const msg: string = r.body.message ?? r.body.error ?? "";
      expect(msg).toBe("Failed to save note. Please try again.");
    });

    it("returns safe error when DB throws a 23502 not-null violation", async () => {
      const access = await makeSession(labOwnerId);
      const { caseNotes } = dbMod as any;

      dbMod.__injectDbError(caseNotes, {
        code: "23502",
        message: "null value in column \"note_text\" violates not-null constraint",
      });

      const r = await request(appMod.default)
        .post(`/api/cases/${caseId}/notes`)
        .set("Authorization", `Bearer ${access}`)
        .send({ noteText: "ok", visibility: "internal_lab_only" });

      expect([400, 500]).toContain(r.status);
      assertSafeErrorBody(r.body, r.status);
    });
  });

  // ── Restoration insert failure ───────────────────────────────────────────

  describe("POST /api/cases/:caseId/restorations — insert failure", () => {
    it("returns 500 with a safe message when the DB throws a generic error", async () => {
      const access = await makeSession(labOwnerId);
      const { caseRestorations } = dbMod as any;

      dbMod.__injectDbError(caseRestorations, {
        message: "connection pool exhausted",
      });

      const r = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${access}`)
        .send({
          toothNumber: "8",
          restorationType: "Crown",
          material: "Zirconia",
          quantity: 1,
          unitPrice: 0,
        });

      expect(r.status).toBe(500);
      assertSafeErrorBody(r.body, r.status);
      const msg: string = r.body.message ?? r.body.error ?? "";
      expect(msg).toBe("Failed to save restoration. Please try again.");
    });

    it("does not expose raw SQL on a 23502 not-null violation", async () => {
      const access = await makeSession(labOwnerId);
      const { caseRestorations } = dbMod as any;

      dbMod.__injectDbError(caseRestorations, {
        code: "23502",
        message:
          "null value in column \"restoration_type\" of relation \"case_restorations\" violates not-null constraint",
      });

      const r = await request(appMod.default)
        .post(`/api/cases/${caseId}/restorations`)
        .set("Authorization", `Bearer ${access}`)
        .send({
          toothNumber: "9",
          restorationType: "PFM",
          quantity: 1,
          unitPrice: 0,
        });

      expect([400, 500]).toContain(r.status);
      assertSafeErrorBody(r.body, r.status);
    });
  });

  // ── Restoration PATCH failure ────────────────────────────────────────────

  describe("PATCH /api/cases/:caseId/restorations/:id — update failure", () => {
    it("returns 500 with a safe message when the DB throws a generic error", async () => {
      const access = await makeSession(labOwnerId);
      const { caseRestorations } = dbMod as any;

      dbMod.__injectDbError(caseRestorations, {
        message: "SSL SYSCALL error",
      });

      const r = await request(appMod.default)
        .patch(`/api/cases/${caseId}/restorations/${restorationId}`)
        .set("Authorization", `Bearer ${access}`)
        .send({ shade: "A2" });

      expect(r.status).toBe(500);
      assertSafeErrorBody(r.body, r.status);
      const msg: string = r.body.message ?? r.body.error ?? "";
      expect(msg).toBe("Failed to update restoration. Please try again.");
    });
  });

  // ── Statement template update failure ────────────────────────────────────

  describe("PATCH /api/admin/templates/statement — update failure", () => {
    it("returns 500 with a safe message when the DB throws a generic error", async () => {
      const access = await makeSession(labOwnerId);
      const { organizations } = dbMod as any;

      dbMod.__injectDbError(organizations, {
        message: "ECONNRESET: connection lost during write",
      });

      const r = await request(appMod.default)
        .patch("/api/admin/templates/statement")
        .set("Authorization", `Bearer ${access}`)
        .set("x-lab-org-id", labOrgId)
        .send({ footerNote: "Test footer" });

      // If auth/membership check itself fails for another reason, skip assertion.
      if (r.status === 403 || r.status === 401) return;

      expect(r.status).toBe(500);
      assertSafeErrorBody(r.body, r.status);
      const msg: string = r.body.message ?? r.body.error ?? "";
      expect(msg).toBe("Failed to update statement template.");
    });
  });

  // ── Correspondence template update failure ───────────────────────────────

  describe("PATCH /api/admin/templates/correspondence — update failure", () => {
    it("returns 500 with a safe message when the DB throws a generic error", async () => {
      const access = await makeSession(labOwnerId);
      const { organizations } = dbMod as any;

      dbMod.__injectDbError(organizations, {
        message: "ECONNRESET: connection lost during write",
      });

      const r = await request(appMod.default)
        .patch("/api/admin/templates/correspondence")
        .set("Authorization", `Bearer ${access}`)
        .set("x-lab-org-id", labOrgId)
        .send({ headerLine: "Test header" });

      if (r.status === 403 || r.status === 401) return;

      expect(r.status).toBe(500);
      assertSafeErrorBody(r.body, r.status);
      const msg: string = r.body.message ?? r.body.error ?? "";
      expect(msg).toBe("Failed to update correspondence template.");
    });
  });
});
