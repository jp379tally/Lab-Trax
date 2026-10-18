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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

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

// persistStatementPdf writes a real stub file so the PDF serve and email
// attachment routes can read it back from disk.
const mockPersistStatementPdf = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));

vi.mock("../lib/statements.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/statements.js")>()),
  startStatementScheduler: vi.fn(),
  generateStatementPdfBuffer: vi
    .fn()
    .mockResolvedValue(Buffer.from("%PDF-1.4 stub-content")),
  // Implementation set in beforeAll so it can write to the resolved cwd dir.
  persistStatementPdf: mockPersistStatementPdf,
  // periodMonthFor is a pure helper imported by invoices.ts; must be present
  // in the mock or it resolves to undefined and crashes buildAndPersistStatementPdf.
  periodMonthFor: (d: Date) => d.toISOString().slice(0, 7),
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

vi.mock("../lib/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mail.js")>()),
  sendMail: vi.fn().mockResolvedValue({ sent: true }),
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

    // persistStatementPdf writes a real stub PDF to the same directory the
    // GET-pdf and email-attachment routes read from (uploads/practice-statements).
    // Each call uses a unique filename so parallel tests don't collide.
    const stmtDir = path.resolve(process.cwd(), "uploads", "practice-statements");
    fs.mkdirSync(stmtDir, { recursive: true });
    mockPersistStatementPdf.mockImplementation(async () => {
      const fileName = `stub-stmt-${randomBytes(6).toString("hex")}.pdf`;
      const filePath = path.resolve(stmtDir, fileName);
      fs.writeFileSync(filePath, Buffer.from("%PDF-1.4 stub-content-test"));
      return { storageKey: filePath, fileName, size: 26 };
    });

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

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(labOwnerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      practiceStatements,
      practiceStatementSends,
      statementSchedules,
      systemSettings,
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
    await db
      .delete(statementSchedules)
      .where(eq(statementSchedules.labOrganizationId, labOrgId));
    await db
      .delete(systemSettings)
      .where(eq(systemSettings.key, `tmpl_statement_email:${labOrgId}`));

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
    const invoiceId = inv.body.data.id as string;
    const { db, invoices, practiceStatements } = dbMod as any;
    await db
      .update(invoices)
      .set({
        total: "137.42",
        balanceDue: "137.42",
        displayMetadataJson: {
          patientName: "Statement Patient",
          billTo: "Statement Billing Contact",
        },
      })
      .where(eq(invoices.id, invoiceId));

    const r = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });

    expect(r.status).toBe(201);
    const statements: any[] = r.body.data?.statements ?? [];
    expect(statements.length).toBeGreaterThan(0);
    const stmt = statements[0];
    expect(stmt.id).toBeTruthy();
    expect(stmt.pdfStorageKey).toBeTruthy();

    await db
      .update(invoices)
      .set({ total: "999.99", balanceDue: "999.99" })
      .where(eq(invoices.id, invoiceId));
    const [persisted] = await db
      .select()
      .from(practiceStatements)
      .where(eq(practiceStatements.id, stmt.id));
    expect(persisted.invoiceAmountsJson).toEqual({
      [invoiceId]: "137.42",
    });
    expect(persisted.invoiceDetailsJson?.[invoiceId]).toMatchObject({
      invoiceNumber: inv.body.data.invoiceNumber,
      patientName: "Statement Patient",
      billTo: "Statement Billing Contact",
    });
  });

  it("batch statement sending preserves statement-time invoice totals", async () => {
    const { db, invoices, practiceStatements } = dbMod as any;
    const invoiceId = rid("batch_amount_inv");
    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("INV"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      total: "246.80",
      balanceDue: "246.80",
      createdByUserId: labOwnerId,
    });

    const { runBatchSendStatements } = await import("../lib/statements.js");
    await runBatchSendStatements({
      labOrganizationId: labOrgId,
      triggeredByUserId: labOwnerId,
      practiceIds: [providerOrgId],
      invoiceScope: "all",
      channels: ["email"],
    });

    await db
      .update(invoices)
      .set({ total: "864.20", balanceDue: "864.20" })
      .where(eq(invoices.id, invoiceId));
    const rows = await db
      .select()
      .from(practiceStatements)
      .where(eq(practiceStatements.labOrganizationId, labOrgId));
    const persisted = rows.find(
      (row: any) => row.invoiceAmountsJson?.[invoiceId] !== undefined,
    );
    expect(persisted?.invoiceAmountsJson?.[invoiceId]).toBe("246.80");
    expect(persisted?.invoiceDetailsJson?.[invoiceId]).toMatchObject({
      invoiceNumber: expect.any(String),
      patientName: null,
      billTo: null,
    });
  });

  it("monthly scheduled statement sending preserves statement-time invoice totals", async () => {
    const { db, invoices, practiceStatements } = dbMod as any;
    const invoiceId = rid("monthly_amount_inv");
    await db.insert(invoices).values({
      id: invoiceId,
      invoiceNumber: rid("INV"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "open",
      total: "315.75",
      balanceDue: "315.75",
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      issuedAt: new Date("2026-08-15T12:00:00.000Z"),
      createdByUserId: labOwnerId,
    });

    const { runMonthlyStatementsForLab } = await import("../lib/statements.js");
    await runMonthlyStatementsForLab({
      labOrganizationId: labOrgId,
      triggeredBy: "schedule",
      triggeredByUserId: labOwnerId,
      asOf: new Date("2026-09-11T12:00:00.000Z"),
    });

    await db
      .update(invoices)
      .set({ total: "513.57", balanceDue: "513.57" })
      .where(eq(invoices.id, invoiceId));
    const rows = await db
      .select()
      .from(practiceStatements)
      .where(eq(practiceStatements.labOrganizationId, labOrgId));
    const persisted = rows.find(
      (row: any) => row.invoiceAmountsJson?.[invoiceId] !== undefined,
    );
    expect(persisted?.invoiceAmountsJson?.[invoiceId]).toBe("315.75");
    expect(persisted?.invoiceDetailsJson?.[invoiceId]).toMatchObject({
      invoiceNumber: expect.any(String),
      patientName: null,
      billTo: null,
    });
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
        includeStatuses: ["open", "partially_paid", "paid"],
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

  it("serves a selected bundle PDF by manifest index and rejects missing attachments", async () => {
    const { access } = await makeSession(labOwnerId);
    const generated = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 45 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });
    expect(generated.status).toBe(201);
    const statement = generated.body.data.statements[0];
    const { db, practiceStatements } = dbMod as any;
    const secondPdfName = `bundle-second-${randomBytes(6).toString("hex")}.pdf`;
    const secondPdfPath = path.resolve(
      process.cwd(),
      "uploads",
      "practice-statements",
      secondPdfName,
    );
    fs.writeFileSync(secondPdfPath, Buffer.from("%PDF-1.4 second-doctor"));
    await db
      .update(practiceStatements)
      .set({
        bundleManifestJson: {
          version: 1,
          recipients: ["practice@test.invalid"],
          attachments: [
            {
              documentKey: "doctor-one",
              doctorName: "Dr. One",
              label: "Doctor One",
              fileName: statement.pdfFileName,
              storageKey: statement.pdfStorageKey,
              fileSize: 20,
              invoiceCount: 1,
              totalBilled: "10.00",
              balanceDue: "10.00",
              invoiceIds: [],
            },
            {
              documentKey: "doctor-two",
              doctorName: "Dr. Two",
              label: "Doctor Two",
              fileName: secondPdfName,
              storageKey: secondPdfName,
              fileSize: 22,
              invoiceCount: 1,
              totalBilled: "20.00",
              balanceDue: "20.00",
              invoiceIds: [],
            },
          ],
        },
      })
      .where(eq(practiceStatements.id, statement.id));

    const history = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements?labOrganizationId=${labOrgId}&providerOrganizationId=${providerOrgId}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(history.status).toBe(200);
    const historyStatement = history.body.data.find(
      (row: { id: string }) => row.id === statement.id,
    );
    expect(historyStatement.bundleAttachments).toEqual([
      {
        index: 0,
        doctorName: "Dr. One",
        label: "Doctor One",
        fileName: statement.pdfFileName,
      },
      {
        index: 1,
        doctorName: "Dr. Two",
        label: "Doctor Two",
        fileName: secondPdfName,
      },
    ]);
    expect(historyStatement).not.toHaveProperty("bundleManifestJson");
    expect(historyStatement.bundleAttachments[1]).not.toHaveProperty(
      "storageKey",
    );

    const secondPdf = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements/${statement.id}/pdf?attachmentIndex=1`,
      )
      .set("Authorization", `Bearer ${access}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(secondPdf.status).toBe(200);
    expect(secondPdf.headers["content-disposition"]).toContain(secondPdfName);
    expect((secondPdf.body as Buffer).toString()).toContain("second-doctor");

    const missing = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements/${statement.id}/pdf?attachmentIndex=2`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(missing.status).toBe(404);

    mockSendMail.mockClear();
    const resent = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${statement.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "resend@test.invalid",
        subject: "Original practice bundle",
        message: "Resending the issued statement bundle.",
      });
    expect(resent.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const [mailArg] = mockSendMail.mock.calls[0] as [any];
    expect(mailArg.attachments.map((item: { filename: string }) => item.filename))
      .toEqual([statement.pdfFileName, secondPdfName]);
    expect(
      (mailArg.attachments[1].content as Buffer).toString(),
    ).toContain("second-doctor");

    mockSendMail.mockClear();
    const doctorResend = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${statement.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "doctor-resend@test.invalid",
        subject: "Dr. Two statement",
        message: "Resending Dr. Two's statement.",
        attachmentIndex: 1,
      });
    expect(doctorResend.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const [doctorMailArg] = mockSendMail.mock.calls[0] as [any];
    expect(
      doctorMailArg.attachments.map((item: { filename: string }) => item.filename),
    ).toEqual([secondPdfName]);
    expect(
      (doctorMailArg.attachments[0].content as Buffer).toString(),
    ).toContain("second-doctor");

    mockSendMail.mockClear();
    const missingAttachment = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${statement.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "doctor-resend@test.invalid",
        subject: "Missing statement",
        message: "This attachment does not exist.",
        attachmentIndex: 2,
      });
    expect(missingAttachment.status).toBe(404);
    expect(mockSendMail).not.toHaveBeenCalled();
    fs.rmSync(secondPdfPath, { force: true });

    const missingFile = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements/${statement.id}/pdf?attachmentIndex=1`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(missingFile.status).toBe(404);
    expect(missingFile.body.message).toContain("Dr. Two");
    expect(missingFile.body.message).toContain(secondPdfName);

    const firstPdf = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements/${statement.id}/pdf?attachmentIndex=0`,
      )
      .set("Authorization", `Bearer ${access}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(firstPdf.status).toBe(200);
    expect((firstPdf.body as Buffer).length).toBeGreaterThan(0);
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

  it("applies the saved schedule reply-to when emailing an ad-hoc statement", async () => {
    mockSendMail.mockClear();
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
    const invoice = inv.body.data;

    const { db, statementSchedules } = dbMod as any;
    await db
      .insert(statementSchedules)
      .values({
        labOrganizationId: labOrgId,
        enabled: false,
        dayOfMonth: 1,
        emailReplyTo: "statements-replies@test.invalid",
      })
      .onConflictDoUpdate({
        target: statementSchedules.labOrganizationId,
        set: { emailReplyTo: "statements-replies@test.invalid" },
      });

    const r = await request(appMod.default)
      .post("/api/invoices/statements/email")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        practiceOrganizationId: providerOrgId,
        invoiceIds: [invoice.id],
        subject: "Edited one-off subject",
        message: "Edited one-off message",
        filename: "statement.pdf",
      });

    expect(r.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalledOnce();
    expect(mockSendMail.mock.calls[0]?.[0]).toMatchObject({
      subject: "Edited one-off subject",
      text: "Edited one-off message",
      replyTo: "statements-replies@test.invalid",
    });
  });

  it("falls back to the saved Settings reply-to when the schedule reply-to is blank", async () => {
    mockSendMail.mockClear();
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
    const invoice = inv.body.data;

    const { db, statementSchedules, systemSettings } = dbMod as any;
    await db
      .delete(statementSchedules)
      .where(eq(statementSchedules.labOrganizationId, labOrgId));
    await db
      .insert(systemSettings)
      .values({
        key: `tmpl_statement_email:${labOrgId}`,
        value: JSON.stringify({
          emailReplyTo: "settings-replies@test.invalid",
        }),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: JSON.stringify({
            emailReplyTo: "settings-replies@test.invalid",
          }),
        },
      });

    const r = await request(appMod.default)
      .post("/api/invoices/statements/email")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        practiceOrganizationId: providerOrgId,
        invoiceIds: [invoice.id],
        subject: "One-off subject",
        message: "One-off message",
        filename: "statement.pdf",
      });

    expect(r.status).toBe(200);
    expect(mockSendMail.mock.calls[0]?.[0]).toMatchObject({
      replyTo: "settings-replies@test.invalid",
    });
  });

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
        includeStatuses: ["open", "partially_paid", "paid"],
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

  it("GET /api/invoices/practice-statements exposes last email send (lastEmailedAt/lastEmailedTo)", async () => {
    mockSendMail.mockClear();
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 45 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 5 * 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];
    expect(stmt?.id).toBeTruthy();

    // Never emailed → nulls.
    const before = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements?labOrganizationId=${labOrgId}&providerOrganizationId=${providerOrgId}`
      )
      .set("Authorization", `Bearer ${access}`);
    expect(before.status).toBe(200);
    const rowBefore = (before.body.data as any[]).find((r) => r.id === stmt.id);
    expect(rowBefore).toBeTruthy();
    expect(rowBefore.lastEmailedAt).toBeNull();
    expect(rowBefore.lastEmailedTo).toBeNull();

    // Send it, then the list reflects the send time + recipient.
    const send = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "lastsend@test.invalid",
        subject: "Statement",
        message: "Attached.",
      });
    expect(send.status).toBe(200);

    const after = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements?labOrganizationId=${labOrgId}&providerOrganizationId=${providerOrgId}`
      )
      .set("Authorization", `Bearer ${access}`);
    expect(after.status).toBe(200);
    const rowAfter = (after.body.data as any[]).find((r) => r.id === stmt.id);
    expect(rowAfter).toBeTruthy();
    expect(rowAfter.lastEmailedTo).toBe("lastsend@test.invalid");
    expect(rowAfter.lastEmailedAt).toBeTruthy();
    expect(new Date(rowAfter.lastEmailedAt).getTime()).not.toBeNaN();

    // A second send to a different recipient wins as the latest.
    const send2 = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "resend@test.invalid",
        subject: "Statement (resend)",
        message: "Attached again.",
      });
    expect(send2.status).toBe(200);

    const after2 = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements?labOrganizationId=${labOrgId}&providerOrganizationId=${providerOrgId}`
      )
      .set("Authorization", `Bearer ${access}`);
    expect(after2.status).toBe(200);
    const rowAfter2 = (after2.body.data as any[]).find((r) => r.id === stmt.id);
    expect(rowAfter2.lastEmailedTo).toBe("resend@test.invalid");
    expect(
      new Date(rowAfter2.lastEmailedAt).getTime()
    ).toBeGreaterThanOrEqual(new Date(rowAfter.lastEmailedAt).getTime());
  });

  it("failed email sends do not update lastEmailedAt/lastEmailedTo", async () => {
    mockSendMail.mockClear();
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 75 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 6 * 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];

    mockSendMail.mockRejectedValueOnce(new Error("SMTP down"));
    const send = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        to: "failed@test.invalid",
        subject: "Statement",
        message: "Attached.",
      });
    expect(send.status).toBe(502);

    const list = await request(appMod.default)
      .get(
        `/api/invoices/practice-statements?labOrganizationId=${labOrgId}&providerOrganizationId=${providerOrgId}`
      )
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const row = (list.body.data as any[]).find((r) => r.id === stmt.id);
    expect(row.lastEmailedAt).toBeNull();
    expect(row.lastEmailedTo).toBeNull();
  });

  it("classifies an SMTP auth failure with a login-specific message", async () => {
    mockSendMail.mockClear();
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 80 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 6 * 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];

    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error("535 auth failed"), {
        code: "EAUTH",
        responseCode: 535,
      }),
    );
    const r = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({ to: "auth@test.invalid", subject: "S", message: "m" });

    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/rejected the login/i);
    expect(r.body.message).not.toMatch(/535 auth failed/);
  });

  it("classifies an SMTP connection failure with a connection-specific message", async () => {
    mockSendMail.mockClear();
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 82 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 7 * 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];

    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" }),
    );
    const r = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({ to: "conn@test.invalid", subject: "S", message: "m" });

    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/connect to the email server/i);
  });

  it("classifies a rejected recipient with a recipient-specific message", async () => {
    mockSendMail.mockClear();
    const { access } = await makeSession(labOwnerId);

    const gen = await request(appMod.default)
      .post("/api/invoices/practice-statements/generate")
      .set("Authorization", `Bearer ${access}`)
      .send({
        labOrganizationId: labOrgId,
        providerOrganizationIds: [providerOrgId],
        periodStart: new Date(Date.now() - 84 * 86400000).toISOString(),
        periodEnd: new Date(Date.now() + 8 * 86400000).toISOString(),
        includeStatuses: ["open", "partially_paid", "paid"],
      });
    expect(gen.status).toBe(201);
    const stmt = gen.body.data.statements[0];

    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error("550 no such user"), {
        code: "EENVELOPE",
        responseCode: 550,
      }),
    );
    const r = await request(appMod.default)
      .post(`/api/invoices/practice-statements/${stmt.id}/email`)
      .set("Authorization", `Bearer ${access}`)
      .send({ to: "reject@test.invalid", subject: "S", message: "m" });

    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/rejected the recipient/i);
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
        includeStatuses: ["open", "partially_paid", "paid"],
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
