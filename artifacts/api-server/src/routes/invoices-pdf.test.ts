/**
 * Integration tests for invoice statement PDF generation and email dispatch.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/invoices/practice-statements/generate — creates statement + PDF
 *  - GET  /api/invoices/practice-statements/:id/pdf  — returns 200 application/pdf
 *  - POST /api/invoices/practice-statements/:id/email — dispatches via nodemailer stub
 *  - Unauthenticated requests return 401
 *  - Missing mailer config returns 503
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before vi.mock factories run.
// ---------------------------------------------------------------------------

const mockSendMail = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "stub-msg-id" })
);

const mockGetMailerConfig = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    host: "localhost",
    port: 1025,
    secure: false,
    user: "test@lab.com",
    pass: "stub-pass",
    from: "lab@example.com",
  })
);

const mockCreateTransport = vi.hoisted(() =>
  vi.fn().mockReturnValue({ sendMail: mockSendMail })
);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));

vi.mock("../lib/statements.js", () => ({
  startStatementScheduler: vi.fn(),
  generateStatementPdfBuffer: vi
    .fn()
    .mockResolvedValue(Buffer.from("%PDF-1.4 stub-content")),
  runMonthlyStatementsForLab: vi.fn().mockResolvedValue({ results: [] }),
  runBatchSendStatements: vi.fn().mockResolvedValue({ results: [] }),
  generateStatementsZipBufferForLab: vi.fn().mockResolvedValue({
    zipBuffer: Buffer.from("PK stub"),
    filename: "statements.zip",
  }),
  retryStatementSendRun: vi.fn().mockResolvedValue({ status: "sent" }),
}));

vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-pdftest"),
  extractMediaFileName: () => null,
}));

vi.mock("../lib/mailer.js", () => ({
  getMailerConfig: mockGetMailerConfig,
  createTransport: mockCreateTransport,
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Invoice PDF and statement generation (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  async function makeSession(
    userId: string
  ): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-pdftest";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `pdfowner_${labOwnerId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("PdfTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("PdfTestPractice"),
        billingEmail: "practice@test.invalid",
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
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      practiceStatements,
      practiceStatementSends,
      invoiceLineItems,
      invoices,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    const stmtRows = await db
      .select({ id: practiceStatements.id })
      .from(practiceStatements)
      .where(eq(practiceStatements.labOrganizationId, labOrgId));
    const stmtIds: string[] = stmtRows.map((r: any) => r.id);
    if (stmtIds.length) {
      await db
        .delete(practiceStatementSends)
        .where(inArray(practiceStatementSends.statementId, stmtIds));
    }
    await db
      .delete(practiceStatements)
      .where(eq(practiceStatements.labOrganizationId, labOrgId));

    const invRows = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(inArray(invoices.labOrganizationId, [labOrgId]));
    const invIds: string[] = invRows.map((r: any) => r.id);
    if (invIds.length && invoiceLineItems) {
      await db
        .delete(invoiceLineItems)
        .where(inArray(invoiceLineItems.invoiceId, invIds));
    }
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [labOwnerId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId]));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── POST /api/invoices/practice-statements/generate ──────────────────────

  it("generates a statement with a persisted PDF (pdfStorageKey set)", async () => {
    const { access } = await makeSession(labOwnerId);

    const inv = await request(appMod.default)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${access}`)
      .send({
        invoiceNumber: rid("INV"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
      });
    expect(inv.status).toBe(201);

    const r = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 86400000).toISOString(),
        includeStatuses: ["draft", "open", "partially_paid", "paid"],
      });

    expect(r.status).toBe(201);
    const statements: any[] = r.body.data?.statements ?? [];
    expect(statements.length).toBeGreaterThan(0);
    const stmt = statements[0];
    expect(stmt.id).toBeTruthy();
    expect(stmt.pdfStorageKey).toBeTruthy();
  });

  it("POST /api/invoices/practice-statements/generate returns 401 without auth", async () => {
    const r = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(r.status).toBe(401);
  });

  // ── GET /api/invoices/practice-statements/:id/pdf ─────────────────────────

  it("GET /api/invoices/practice-statements/:id/pdf returns 200 application/pdf", async () => {
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 60 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 2 * 86400000).toISOString(),
        includeStatuses: ["draft", "open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmtId: string = gen.body.data.statements[0]?.id;
    expect(stmtId).toBeTruthy();

    const r = await request(appMod.default)
      .get(`/api/invoices/practice-statements/${stmtId}/pdf`)
      .set("Authorization", `Bearer ${access}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/pdf/);
    expect((r.body as Buffer).length).toBeGreaterThan(0);
  });

  it("GET /api/invoices/practice-statements/:id/pdf returns 401 without auth", async () => {
    const r = await request(appMod.default).get(
      "/api/invoices/practice-statements/nonexistent/pdf"
    );
    expect(r.status).toBe(401);
  });

  it("GET /api/invoices/practice-statements/:id/pdf returns 404 for unknown id", async () => {
    const { access } = await makeSession(labOwnerId);
    const r = await request(appMod.default)
      .get("/api/invoices/practice-statements/no-such-id/pdf")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(404);
  });

  // ── POST /api/invoices/practice-statements/:id/email ─────────────────────

  it("email endpoint dispatches via nodemailer and returns send record", async () => {
    mockSendMail.mockClear();
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 90 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 3 * 86400000).toISOString(),
        includeStatuses: ["draft", "open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];
    expect(stmt?.pdfStorageKey).toBeTruthy();

    const r = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "recipient@test.invalid",
        subject: "Your statement for this period",
        message: "Please find your account statement attached.",
      });

    expect(r.status).toBe(200);
    const body = r.body.data ?? r.body;
    expect(body.status).toBe("sent");

    expect(mockSendMail).toHaveBeenCalledOnce();
    const [mailArg] = mockSendMail.mock.calls[0] as [any];
    expect(mailArg.to).toBe("recipient@test.invalid");
    expect(mailArg.subject).toBe("Your statement for this period");
    expect(Array.isArray(mailArg.attachments)).toBe(true);
    expect(mailArg.attachments.length).toBeGreaterThan(0);
    expect(mailArg.attachments[0].contentType).toBe("application/pdf");
  });

  it("email endpoint returns 401 without auth", async () => {
    const r = await request(appMod.default)
      .post("/api/invoices/practice-statements/nonexistent/email")
      .send({ to: "x@x.invalid", subject: "s", message: "m" });
    expect(r.status).toBe(401);
  });

  it("email endpoint returns 503 when mailer config is absent", async () => {
    mockGetMailerConfig.mockReturnValueOnce(null);
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 120 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 4 * 86400000).toISOString(),
        includeStatuses: ["draft", "open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];
    expect(stmt?.pdfStorageKey).toBeTruthy();

    const r = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "recipient@test.invalid",
        subject: "Statement",
        message: "Attached.",
      });
    expect(r.status).toBe(503);
  });
});
