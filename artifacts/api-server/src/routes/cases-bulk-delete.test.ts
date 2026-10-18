/**
 * Integration tests for POST /api/cases/bulk-delete.
 *
 * Regression coverage for the desktop "Delete N cases?" → 404 "No matching
 * cases found." bug: the desktop case list (GET /cases) merges canonical
 * `cases` rows with legacy mobile `lab_cases` rows. The old handler resolved
 * the lab + existence from `uniqueCaseIds[0]` against the canonical table
 * only, so a lab whose cases were all created in the mobile app (legacy
 * `lab_cases`) 404'd on every bulk delete and deleted nothing.
 *
 * Skipped when DATABASE_URL is not configured (same convention used by
 * sibling test suites). Each test cleans up its own rows; afterAll sweeps the
 * rest so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - Happy path (canonical): cases soft-deleted, deletedCount correct
 *  - REGRESSION (legacy-only): legacy lab_cases soft-deleted, no 404
 *  - REGRESSION (mixed, legacy id first): both kinds soft-deleted, no 404
 *  - 403 when the caller is a member but not an admin/owner
 *  - 404 when no id matches either table
 *  - 401 when no auth token is provided
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

// Verification module is mocked so tests bypass the OTP DB table and real
// email delivery. verifyCode always returns verified:true, letting the
// happy-path tests complete the 3-step flow without seeding a real
// verification_codes row.
vi.mock("../lib/verification.js", () => ({
  createVerificationCode: vi.fn().mockResolvedValue(undefined),
  verifyCode: vi.fn().mockResolvedValue({ verified: true }),
  normalizePhoneTarget: (p: string) => p.replace(/\D/g, ""),
  normalizeEmailTarget: (e: string) => e.trim().toLowerCase(),
}));

// Mock only sendMail (keep the rest of the mail module intact) so
// delete-initiate's owner-email OTP send never attempts real SMTP.
vi.mock("../lib/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mail.js")>();
  return {
    ...actual,
    sendMail: vi.fn().mockResolvedValue({ sent: true }),
  };
});

vi.mock("../lib/sms.js", () => ({
  sendSms: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
  isConfigured: vi.fn().mockReturnValue(false),
  isDevOrTest: vi.fn().mockReturnValue(true),
  sendVerificationSms: vi.fn().mockResolvedValue(undefined),
  parseInboundSms: vi.fn().mockReturnValue(null),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/cases/bulk-delete (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let casesRoutes: typeof import("./cases.js");

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const practiceId = rid("prov");
  const adminUserId = rid("uadmin");
  const staffUserId = rid("ustaff");

  const tokens = { admin: "", staff: "" };

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return token;
  }

  async function insertCanonical(caseNumber: string): Promise<string> {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      doctorName: "Dr. Test",
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  async function insertLegacy(): Promise<string> {
    const { db, labCases } = dbMod as any;
    const id = rid("legacy");
    await db.insert(labCases).values({
      id,
      ownerId: adminUserId,
      organizationId: labOrgId,
      caseData: JSON.stringify({ patientName: "Legacy Pat", status: "RECEIVED" }),
    });
    return id;
  }

  async function insertInvoice(
    caseId: string,
    opts?: { total?: string; balanceDue?: string },
  ): Promise<string> {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: rid("INV"),
      caseId,
      labOrganizationId: labOrgId,
      providerOrganizationId: practiceId,
      status: "open",
      total: opts?.total ?? "119.00",
      balanceDue: opts?.balanceDue ?? "119.00",
      createdByUserId: adminUserId,
    });
    return id;
  }

  // Helper: completes the full 3-step security flow (delete-initiate → bulk-delete).
  // Uses the mocked verifyCode path, so any 6-digit OTP is accepted.
  async function deleteViaFlow(
    caseIds: string[],
    adminToken: string,
  ): Promise<request.Response> {
    const init = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "testpin123", caseIds });
    expect(init.status, `delete-initiate failed: ${JSON.stringify(init.body)}`).toBe(200);
    const { deleteSessionToken } = init.body.data;
    return request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ caseIds, deleteSessionToken, smsOtpCode: "123456" });
  }

  async function initiateDelete(
    caseIds: string[],
    adminToken: string,
  ): Promise<string> {
    const init = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ adminPin: "testpin123", caseIds });
    expect(init.status, `delete-initiate failed: ${JSON.stringify(init.body)}`).toBe(200);
    return init.body.data.deleteSessionToken;
  }

  async function waitForInvoiceLockWaiters(
    blockerPid: number,
    expectedCount: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await (dbMod as any).pool.query(
        `WITH RECURSIVE blocked(pid) AS (
           SELECT pid
             FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
           UNION
           SELECT activity.pid
             FROM pg_stat_activity activity
             JOIN blocked blocker
               ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
         )
         SELECT pid FROM blocked`,
        [blockerPid],
      );
      if (result.rows.length >= expectedCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${expectedCount} invoice lock waiters`,
    );
  }

  async function waitForOrderedInvoiceLockChain(
    blockerPid: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await (dbMod as any).pool.query(
        `WITH RECURSIVE blocked(pid) AS (
           SELECT pid
             FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
           UNION
           SELECT activity.pid
             FROM pg_stat_activity activity
             JOIN blocked blocker
               ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
         )
         SELECT
           (SELECT count(*)
              FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS direct_count,
           (SELECT count(*) FROM blocked)::int AS total_count`,
        [blockerPid],
      );
      const row = result.rows[0];
      if (Number(row.direct_count) === 1 && Number(row.total_count) >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      "Timed out waiting for bulk deletion behind the sorted invoice-lock chain",
    );
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-bulk-delete";
    process.env["PLATFORM_ADMIN_PIN"] = "testpin123";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    casesRoutes = await import("./cases.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      {
        id: adminUserId,
        username: `adm_${adminUserId}`,
        password: "x",
        email: `${adminUserId}@test.local`,
        phone: "5550001234",
        phoneVerifiedAt: new Date(),
      },
      { id: staffUserId, username: `stf_${staffUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Bulk Delete Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Bulk Delete Other Lab" },
      {
        id: practiceId,
        type: "provider",
        name: "Bulk Delete Test Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: labOrgId,
        userId: staffUserId,
        role: "staff",
        status: "active",
      },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.staff = await makeSession(staffUserId);
  }, 60_000);

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    tokens.admin = await makeSession(adminUserId);
    tokens.staff = await makeSession(staffUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      labCases,
      invoices,
      organizationMemberships,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
    // Invoices reference cases (set null), orgs + users (restrict) — delete
    // them before the rows they depend on.
    await db
      .delete(invoices)
      .where(inArray(invoices.labOrganizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(cases)
      .where(inArray(cases.labOrganizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(labCases)
      .where(inArray(labCases.organizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [adminUserId, staffUserId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [adminUserId, staffUserId]));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, otherLabOrgId, practiceId]));
    await db.delete(users).where(inArray(users.id, [adminUserId, staffUserId]));
  });

  it("happy path: soft-deletes canonical cases and returns deletedCount", async () => {
    const c1 = await insertCanonical(rid("BD1"));
    const c2 = await insertCanonical(rid("BD2"));

    const r = await deleteViaFlow([c1, c2], tokens.admin);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.deletedCount).toBe(2);

    // Soft-delete: rows still exist but deletedAt is set (NOT hard-deleted).
    const { db, cases } = dbMod as any;
    const rows = await db
      .select({ id: cases.id, deletedAt: cases.deletedAt })
      .from(cases)
      .where(inArray(cases.id, [c1, c2]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.deletedAt).not.toBeNull();
    }
  });

  it("freezes linked invoices (zero balance, NOT deleted) when a case is bulk-deleted", async () => {
    // Regression: bulk-delete previously soft-deleted the case but left its
    // invoices with live balances. Invoices must be kept and zeroed instead.
    const c1 = await insertCanonical(rid("INVCASE"));
    const inv = await insertInvoice(c1, {
      total: "119.00",
      balanceDue: "119.00",
    });

    const r = await deleteViaFlow([c1], tokens.admin);
    expect(r.status).toBe(200);
    expect(r.body.data.deletedCount).toBe(1);

    const { db, invoices } = dbMod as any;
    const [row] = await db
      .select({
        id: invoices.id,
        frozen: invoices.frozen,
        balanceDue: invoices.balanceDue,
        total: invoices.total,
        deletedAt: invoices.deletedAt,
        caseId: invoices.caseId,
        caseDeletedAt: invoices.caseDeletedAt,
      })
      .from(invoices)
      .where(eq(invoices.id, inv));

    // Invoice is KEPT (row still present, not soft-deleted)...
    expect(row).toBeTruthy();
    expect(row.deletedAt).toBeNull();
    // ...frozen with a zeroed balance...
    expect(row.frozen).toBe(true);
    expect(Number(row.balanceDue)).toBe(0);
    expect(row.caseDeletedAt).not.toBeNull();
    // ...while the original total is preserved for the historical record.
    expect(Number(row.total)).toBe(119);
    // FK still points at the (now soft-deleted) case — set null only fires on
    // a hard delete, which never happens for cases.
    expect(row.caseId).toBe(c1);
  });

  it("rolls back invoice freezing when its deletion audit cannot be written", async () => {
    const caseId = await insertCanonical(rid("AUDITFAIL"));
    const invoiceId = await insertInvoice(caseId, {
      total: "119.00",
      balanceDue: "119.00",
    });
      const { db, cases, invoices, auditLogs, pool } = dbMod as any;
    const triggerName = `fail_freeze_audit_${randomBytes(8).toString("hex")}`;
    const functionName = `${triggerName}_fn`;

    try {
      await pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'invoice_frozen_case_deleted'
             AND NEW.entity_id = '${invoiceId}' THEN
            RAISE EXCEPTION 'injected freeze audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);

      const response = await deleteViaFlow([caseId], tokens.admin);
      expect(response.status).toBe(500);

      const [invoice] = await db
        .select({
          frozen: invoices.frozen,
          balanceDue: invoices.balanceDue,
          caseDeletedAt: invoices.caseDeletedAt,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      expect(invoice.frozen).toBe(false);
      expect(Number(invoice.balanceDue)).toBe(119);
      expect(invoice.caseDeletedAt).toBeNull();

      const freezeAudits = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "invoice_frozen_case_deleted"),
            eq(auditLogs.entityId, invoiceId),
          ),
        );
      expect(freezeAudits).toHaveLength(0);

      const [caseAfterFailure] = await db
        .select({ deletedAt: cases.deletedAt })
        .from(cases)
        .where(eq(cases.id, caseId));
      expect(caseAfterFailure.deletedAt).toBeNull();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const retry = await deleteViaFlow([caseId], tokens.admin);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);

    const [finalCase] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(eq(cases.id, caseId));
    const [finalInvoice] = await db
      .select({ frozen: invoices.frozen, balanceDue: invoices.balanceDue })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(finalCase.deletedAt).not.toBeNull();
    expect(finalInvoice.frozen).toBe(true);
    expect(Number(finalInvoice.balanceDue)).toBe(0);
  });

  it("rolls back a single-case deletion when its invoice freeze audit fails", async () => {
    const caseId = await insertCanonical(rid("SINGLEAUDITFAIL"));
    const invoiceId = await insertInvoice(caseId, {
      total: "83.00",
      balanceDue: "83.00",
    });
    const { db, cases, invoices, pool } = dbMod as any;
    const triggerName = `fail_single_freeze_audit_${randomBytes(8).toString("hex")}`;
    const functionName = `${triggerName}_fn`;

    try {
      await pool.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'invoice_frozen_case_deleted'
             AND NEW.entity_id = '${invoiceId}' THEN
            RAISE EXCEPTION 'injected single freeze audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);

      const failed = await request(appMod.default)
        .delete(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${tokens.admin}`);
      expect(failed.status).toBe(500);

      const [caseAfterFailure] = await db
        .select({ deletedAt: cases.deletedAt })
        .from(cases)
        .where(eq(cases.id, caseId));
      const [invoiceAfterFailure] = await db
        .select({ frozen: invoices.frozen, balanceDue: invoices.balanceDue })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      expect(caseAfterFailure.deletedAt).toBeNull();
      expect(invoiceAfterFailure.frozen).toBe(false);
      expect(Number(invoiceAfterFailure.balanceDue)).toBe(83);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const retry = await request(appMod.default)
      .delete(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);

    const [finalCase] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(eq(cases.id, caseId));
    const [finalInvoice] = await db
      .select({ frozen: invoices.frozen, balanceDue: invoices.balanceDue })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(finalCase.deletedAt).not.toBeNull();
    expect(finalInvoice.frozen).toBe(true);
    expect(Number(finalInvoice.balanceDue)).toBe(0);
  });

  it("freezes once and writes one audit when two freeze requests overlap", async () => {
    const caseId = await insertCanonical(rid("OVERLAP"));
    const invoiceId = await insertInvoice(caseId, {
      total: "119.00",
      balanceDue: "119.00",
    });
    const { db, invoices, auditLogs, pool } = dbMod as any;
    const holder = await pool.connect();
    const started: Promise<number>[] = [];
    const req = {
      auth: { userId: adminUserId },
      ip: "127.0.0.1",
      get: () => "cases-bulk-delete-test",
    } as any;

    const freeze = () =>
      casesRoutes.freezeInvoicesForDeletedCases({
        req,
        caseIds: [caseId],
        labOrganizationId: labOrgId,
        deletingUserId: adminUserId,
        caseNumberById: new Map([[caseId, "OVERLAP"]]),
      });

    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [invoiceId],
      );
      const blockerPid = Number(
        (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      );

      const first = freeze();
      started.push(first);
      await waitForInvoiceLockWaiters(blockerPid, 1);

      const second = freeze();
      started.push(second);
      await waitForInvoiceLockWaiters(blockerPid, 2);

      await holder.query("COMMIT");
      const frozenCounts = await Promise.all([first, second]);
      expect(frozenCounts.sort()).toEqual([0, 1]);

      const [invoice] = await db
        .select({
          frozen: invoices.frozen,
          balanceDue: invoices.balanceDue,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      expect(invoice.frozen).toBe(true);
      expect(Number(invoice.balanceDue)).toBe(0);

      const freezeAudits = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "invoice_frozen_case_deleted"),
            eq(auditLogs.entityId, invoiceId),
          ),
        );
      expect(freezeAudits).toHaveLength(1);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await Promise.allSettled(started);
    }
  }, 30_000);

  it("serializes invoice date repair with case-deletion freezing in either order", async () => {
    const { db, cases, invoices, auditLogs, pool } = dbMod as any;

    async function runOrdering(firstOperation: "repair" | "freeze") {
      const caseId = await insertCanonical(rid(`DATELOCK_${firstOperation}`));
      const invoiceId = await insertInvoice(caseId);
      const originalIssuedAt = new Date("2026-01-15T05:00:00.000Z");
      const originalDueAt = new Date("2026-02-15T05:00:00.000Z");
      const repairedIssuedAt = "2026-01-15T00:00:00.000Z";
      const repairedDueAt = "2026-02-15T00:00:00.000Z";
      await db
        .update(invoices)
        .set({
          issuedAt: originalIssuedAt,
          dueAt: originalDueAt,
          createdAt: new Date("2026-09-10T12:00:00.000Z"),
        })
        .where(eq(invoices.id, invoiceId));
      const deleteSessionToken = await initiateDelete([caseId], tokens.admin);
      const holder = await pool.connect();
      const started: Promise<request.Response>[] = [];

      const repair = () =>
        Promise.resolve(
          request(appMod.default)
            .patch(`/api/invoices/${invoiceId}/repair-dates`)
            .set("Authorization", `Bearer ${tokens.admin}`)
            .send({ issuedAt: repairedIssuedAt, dueAt: repairedDueAt }),
        );
      const freeze = () =>
        Promise.resolve(
          request(appMod.default)
            .post("/api/cases/bulk-delete")
            .set("Authorization", `Bearer ${tokens.admin}`)
            .send({
              caseIds: [caseId],
              deleteSessionToken,
              smsOtpCode: "123456",
            }),
        );

      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [invoiceId],
        );
        const blockerPid = Number(
          (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );

        const first = firstOperation === "repair" ? repair() : freeze();
        started.push(first);
        await waitForInvoiceLockWaiters(blockerPid, 1);
        const second = firstOperation === "repair" ? freeze() : repair();
        started.push(second);
        await waitForInvoiceLockWaiters(blockerPid, 2);
        await holder.query("COMMIT");

        const [firstResponse, secondResponse] = await Promise.all([first, second]);
        const repairResponse =
          firstOperation === "repair" ? firstResponse : secondResponse;
        const freezeResponse =
          firstOperation === "freeze" ? firstResponse : secondResponse;
        expect(freezeResponse.status, JSON.stringify(freezeResponse.body)).toBe(200);

        const [invoice] = await db
          .select({
            frozen: invoices.frozen,
            issuedAt: invoices.issuedAt,
            dueAt: invoices.dueAt,
          })
          .from(invoices)
          .where(eq(invoices.id, invoiceId));
        expect(invoice.frozen).toBe(true);
        const repairAudits = await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.entityId, invoiceId));
        const dateRepairAudits = repairAudits.filter(
          (row: any) => row.action === "invoice_dates_repaired",
        );

        if (firstOperation === "repair") {
          expect(repairResponse.status, JSON.stringify(repairResponse.body)).toBe(200);
          expect(invoice.issuedAt.toISOString()).toBe(repairedIssuedAt);
          expect(invoice.dueAt.toISOString()).toBe(repairedDueAt);
          expect(dateRepairAudits).toHaveLength(1);
        } else {
          expect(repairResponse.status, JSON.stringify(repairResponse.body)).toBe(409);
          expect(invoice.issuedAt.toISOString()).toBe(originalIssuedAt.toISOString());
          expect(invoice.dueAt.toISOString()).toBe(originalDueAt.toISOString());
          expect(dateRepairAudits).toHaveLength(0);
        }

        const [caseRow] = await db
          .select({ deletedAt: cases.deletedAt })
          .from(cases)
          .where(eq(cases.id, caseId));
        expect(caseRow.deletedAt).not.toBeNull();
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
        await Promise.allSettled(started);
      }
    }

    await runOrdering("repair");
    await runOrdering("freeze");
  }, 30_000);

  it("locks multiple linked invoices in stable order without deadlocking an overlapping writer", async () => {
    const { db, invoices, pool } = dbMod as any;
    const firstCaseId = await insertCanonical(rid("MULTILOCK_A"));
    const secondCaseId = await insertCanonical(rid("MULTILOCK_B"));
    const firstInvoiceId = await insertInvoice(firstCaseId, {
      total: "131.00",
      balanceDue: "131.00",
    });
    const secondInvoiceId = await insertInvoice(secondCaseId, {
      total: "247.00",
      balanceDue: "247.00",
    });
    const [lowerInvoiceId, higherInvoiceId] = [
      firstInvoiceId,
      secondInvoiceId,
    ].sort();
    const deleteSessionToken = await initiateDelete(
      [secondCaseId, firstCaseId],
      tokens.admin,
    );
    const holder = await pool.connect();
    const writer = await pool.connect();
    let writerHighLock: Promise<unknown> | undefined;
    let deleteRequest: Promise<request.Response> | undefined;

    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [higherInvoiceId],
      );
      const holderPid = Number(
        (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      );

      await writer.query("BEGIN");
      await writer.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [lowerInvoiceId],
      );
      writerHighLock = writer.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [higherInvoiceId],
      );
      await waitForInvoiceLockWaiters(holderPid, 1);

      deleteRequest = Promise.resolve(
        request(appMod.default)
          .post("/api/cases/bulk-delete")
          .set("Authorization", `Bearer ${tokens.admin}`)
          .send({
            caseIds: [secondCaseId, firstCaseId],
            deleteSessionToken,
            smsOtpCode: "123456",
          }),
      );

      // The writer is the holder's only direct waiter. Bulk deletion must be
      // queued behind the writer's lower invoice lock, proving it requested
      // the two invoice locks in sorted order rather than query/input order.
      await waitForOrderedInvoiceLockChain(holderPid);
      await holder.query("COMMIT");
      await writerHighLock;
      await writer.query("COMMIT");

      const response = await deleteRequest;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.deletedCount).toBe(2);

      const rows = await db
        .select({
          id: invoices.id,
          frozen: invoices.frozen,
          balanceDue: invoices.balanceDue,
          total: invoices.total,
          deletedAt: invoices.deletedAt,
          caseDeletedAt: invoices.caseDeletedAt,
        })
        .from(invoices)
        .where(inArray(invoices.id, [firstInvoiceId, secondInvoiceId]));
      expect(rows).toHaveLength(2);
      expect(rows.map((row: any) => row.id).sort()).toEqual(
        [firstInvoiceId, secondInvoiceId].sort(),
      );
      for (const row of rows) {
        expect(row.frozen).toBe(true);
        expect(Number(row.balanceDue)).toBe(0);
        expect(row.deletedAt).toBeNull();
        expect(row.caseDeletedAt).not.toBeNull();
      }
      expect(
        rows
          .map((row: any) => Number(row.total))
          .sort((a: number, b: number) => a - b),
      ).toEqual([131, 247]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await writer.query("ROLLBACK").catch(() => undefined);
      holder.release();
      writer.release();
      await Promise.allSettled(
        [writerHighLock, deleteRequest].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
    }
  }, 30_000);

  it("does NOT freeze an invoice owned by a different lab even if it references the deleted case id", async () => {
    // Defense-in-depth tenant scoping: there is no composite FK tying an
    // invoice's labOrganizationId to its case's lab, so a cross-lab/imported
    // invoice row that happens to reference the deleted case id must be left
    // completely untouched (not frozen, balance preserved).
    const c1 = await insertCanonical(rid("XLABCASE"));
    const { db, invoices } = dbMod as any;
    const foreignInvId = rid("inv");
    await db.insert(invoices).values({
      id: foreignInvId,
      invoiceNumber: rid("INV"),
      caseId: c1,
      labOrganizationId: otherLabOrgId,
      status: "open",
      total: "200.00",
      balanceDue: "200.00",
      createdByUserId: adminUserId,
    });

    const r = await deleteViaFlow([c1], tokens.admin);
    expect(r.status).toBe(200);

    const [row] = await db
      .select({ frozen: invoices.frozen, balanceDue: invoices.balanceDue })
      .from(invoices)
      .where(eq(invoices.id, foreignInvId));
    expect(row.frozen).toBe(false);
    expect(Number(row.balanceDue)).toBe(200);
  });

  it("REGRESSION: deletes legacy-only selection (no 404)", async () => {
    const l1 = await insertLegacy();
    const l2 = await insertLegacy();

    const r = await deleteViaFlow([l1, l2], tokens.admin);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.deletedCount).toBe(2);

    // Legacy rows soft-deleted: deletedAt + deletedBy set, not hard-deleted.
    const { db, labCases } = dbMod as any;
    const rows = await db
      .select({
        id: labCases.id,
        deletedAt: labCases.deletedAt,
        deletedBy: labCases.deletedBy,
      })
      .from(labCases)
      .where(inArray(labCases.id, [l1, l2]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBeTruthy();
    }
  });

  it("writes a per-case audit entry when a legacy case is soft-deleted", async () => {
    // Regression for Task #2410: the legacy lab_cases delete previously used a
    // bare db.update with no audit entry. It must now write one audit row per
    // legacy case (action case_soft_deleted, legacy:true) like the canonical path.
    const { db, auditLogs } = dbMod as any;
    const l1 = await insertLegacy();

    const r = await deleteViaFlow([l1], tokens.admin);
    expect(r.status).toBe(200);
    expect(r.body.data.deletedCount).toBe(1);

    const rows = await db
      .select({
        action: auditLogs.action,
        entityId: auditLogs.entityId,
        metadataJson: auditLogs.metadataJson,
      })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, l1));
    const softDeleteEntry = rows.find(
      (x: any) => x.action === "case_soft_deleted",
    );
    expect(softDeleteEntry, "expected a case_soft_deleted audit entry").toBeTruthy();
    expect(softDeleteEntry.metadataJson?.legacy).toBe(true);
  });

  it("does not overstate deletedCount when a legacy case was already deleted", async () => {
    // The legacy soft-delete filters on deletedAt IS NULL and counts only the
    // rows it actually updated, so an already-deleted row in the batch is not
    // double-counted (no "successfully deleted N" when fewer than N changed).
    const { db, labCases } = dbMod as any;
    const fresh = await insertLegacy();
    const already = await insertLegacy();
    // Pre-delete one of them out of band.
    await db
      .update(labCases)
      .set({ deletedAt: new Date(), deletedBy: "pretest" })
      .where(eq(labCases.id, already));

    const r = await deleteViaFlow([fresh, already], tokens.admin);
    expect(r.status).toBe(200);
    // Only the still-active legacy case counts.
    expect(r.body.data.deletedCount).toBe(1);
  });

  it("rejects a token that does not cover all selected cases (403)", async () => {
    // Token id scoping: a delete-session token (OTP) issued for one case must
    // not be replayable to delete additional cases. We initiate for c1 only,
    // then attempt to bulk-delete c1 + c2 with that token.
    const c1 = await insertCanonical(rid("TOKA"));
    const c2 = await insertCanonical(rid("TOKB"));

    const init = await request(appMod.default)
      .post("/api/cases/delete-initiate")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ adminPin: "testpin123", caseIds: [c1] });
    expect(init.status).toBe(200);

    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({
        caseIds: [c1, c2],
        deleteSessionToken: init.body.data.deleteSessionToken,
        smsOtpCode: "123456",
      });
    expect(r.status).toBe(403);

    // Neither case may be deleted.
    const { db, cases } = dbMod as any;
    const rows = await db
      .select({ id: cases.id, deletedAt: cases.deletedAt })
      .from(cases)
      .where(inArray(cases.id, [c1, c2]));
    for (const row of rows) {
      expect(row.deletedAt).toBeNull();
    }
  });

  it("REGRESSION: deletes a mixed batch with a legacy id listed first", async () => {
    // The old handler resolved everything from caseIds[0]; a legacy id first
    // 404'd the whole batch. Ordering legacy-first guards that exact path.
    const legacy = await insertLegacy();
    const canonical = await insertCanonical(rid("MIX"));

    const r = await deleteViaFlow([legacy, canonical], tokens.admin);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.deletedCount).toBe(2);

    const { db, cases, labCases } = dbMod as any;
    const [canonRow] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(eq(cases.id, canonical));
    expect(canonRow.deletedAt).not.toBeNull();
    const [legacyRow] = await db
      .select({ deletedAt: labCases.deletedAt })
      .from(labCases)
      .where(eq(labCases.id, legacy));
    expect(legacyRow.deletedAt).not.toBeNull();
  });

  it("returns 403 when the caller is a member but not an admin/owner", async () => {
    const c1 = await insertCanonical(rid("NOADMIN"));

    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${tokens.staff}`)
      .send({ caseIds: [c1] });

    expect(r.status).toBe(403);

    // Case must remain undeleted.
    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(eq(cases.id, c1));
    expect(row.deletedAt).toBeNull();
  });

  it("returns 403 for a cross-lab batch and deletes nothing", async () => {
    // A canonical case in the admin's own lab resolves the target lab; a
    // legacy case in another lab must abort the whole batch (tenant boundary).
    const mine = await insertCanonical(rid("MINE"));
    const { db, cases, labCases } = dbMod as any;
    const foreign = rid("legacy");
    await db.insert(labCases).values({
      id: foreign,
      ownerId: adminUserId,
      organizationId: otherLabOrgId,
      caseData: JSON.stringify({ patientName: "Foreign", status: "RECEIVED" }),
    });

    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [mine, foreign] });

    expect(r.status).toBe(403);

    // Neither row may be deleted.
    const [mineRow] = await db
      .select({ deletedAt: cases.deletedAt })
      .from(cases)
      .where(eq(cases.id, mine));
    expect(mineRow.deletedAt).toBeNull();
    const [foreignRow] = await db
      .select({ deletedAt: labCases.deletedAt })
      .from(labCases)
      .where(eq(labCases.id, foreign));
    expect(foreignRow.deletedAt).toBeNull();
  });

  it("returns 404 when no id matches either table", async () => {
    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({ caseIds: [rid("ghost")] });

    expect(r.status).toBe(404);
  });

  it("returns 401 when no auth token is provided", async () => {
    const r = await request(appMod.default)
      .post("/api/cases/bulk-delete")
      .send({ caseIds: [rid("c")] });

    expect(r.status).toBe(401);
  });
});
